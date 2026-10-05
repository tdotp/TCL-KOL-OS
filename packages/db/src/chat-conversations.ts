/**
 * Conversaciones del chat de Cuenta (V2 · Fase 6) y base común del módulo de chat.
 *
 *   crearConversacion → publicarMensaje (chat-messages) → run (agent-runs)
 *
 * Principios (los mismos que el resto de los casos de uso):
 *  · Solo mutan PERSONAS (`User`) con la capacidad `chat:read` / `chat:write`
 *    (admin, director, consultor). El chat nunca es de un usuario `cliente`.
 *  · Owner-scoped (D3): una conversación la ve y usa quien la creó. Otra
 *    organización, un cliente, un usuario inactivo u otra persona de la misma
 *    organización reciben `RESOURCE_NOT_FOUND` (no se revela que existe); solo el
 *    dueño sin la capacidad (p. ej. degradado de rol) recibe `FORBIDDEN_ROLE`.
 *  · Toda mutación va en una transacción con su auditoría (`entity_type` =
 *    `conversation`, nunca `campaign`: los eventos del chat no aparecen en la
 *    actividad del brief que ve el cliente).
 *
 * Este archivo también aloja los lectores y mapeos compartidos por los demás
 * archivos del chat (mensajes, runs, invocaciones, traza); sus nombres llevan el
 * prefijo `chat` porque `index.ts` reexporta todo.
 */

import { createHash } from 'node:crypto';
import type pg from 'pg';
import {
  type ChatConversation,
  type ChatConversationStatus,
  type ChatMessage,
  type ChatMessageAttachment,
  type ChatMessageReference,
  type ChatMessageRole,
  CHAT_CONFLICT_REASONS,
  type Result,
  type User,
  err,
  ok,
  roleCan,
  validarTituloConversacion,
} from '@tcl-kol-os/domain';
import { assertCapability } from './authz.ts';
import { recordAudit } from './audit.ts';
import { getPool } from './client.ts';
import { Abortar, transaccionConResultado } from './tx-result.ts';

export type ChatConsultor = pg.Pool | pg.PoolClient;

export const CHAT_NO_ENCONTRADO = {
  code: 'RESOURCE_NOT_FOUND',
  message: 'El recurso no existe o no está disponible.',
} as const;

export function chatSha256(texto: string): string {
  return createHash('sha256').update(texto, 'utf8').digest('hex');
}

/** JSON canónico (claves ordenadas) para huellas estables. */
export function chatCanonico(valor: unknown): string {
  if (Array.isArray(valor)) return `[${valor.map(chatCanonico).join(',')}]`;
  if (valor !== null && typeof valor === 'object') {
    const claves = Object.keys(valor as Record<string, unknown>).sort();
    return `{${claves
      .map((k) => `${JSON.stringify(k)}:${chatCanonico((valor as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(valor);
}

export function chatIso(d: Date | null): string | undefined {
  return d === null ? undefined : d.toISOString();
}

// ─────────────────────────── Autorización ──────────────────────────────────────

/**
 * Autoriza el acceso a una conversación concreta (owner-scoped). Orden: cliente,
 * inactivo, otra organización o no dueño → `RESOURCE_NOT_FOUND`; dueño sin la
 * capacidad → `FORBIDDEN_ROLE`.
 */
export function chatAutorizarConversacion(
  actor: User,
  action: 'chat:read' | 'chat:write',
  conversacion: { readonly organizationId: string; readonly createdBy: string },
): Result<true> {
  if (
    actor.status !== 'activo' ||
    actor.role === 'cliente' ||
    actor.organizationId !== conversacion.organizationId ||
    actor.id !== conversacion.createdBy
  ) {
    return err(CHAT_NO_ENCONTRADO);
  }
  if (!roleCan(actor.role, action)) {
    return err({
      code: 'FORBIDDEN_ROLE',
      message: `El rol ${actor.role} no puede ejecutar la acción ${action}.`,
      details: { action, role: actor.role },
    });
  }
  return ok(true);
}

// ─────────────────────────── Conversaciones: filas y mapeo ─────────────────────

interface ConversacionRow {
  readonly id: string;
  readonly organization_id: string;
  readonly campaign_id: string;
  readonly created_by: string;
  readonly title: string | null;
  readonly status: ChatConversationStatus;
  readonly last_seq: string | number;
  readonly last_message_at: Date | null;
  readonly created_at: Date;
  readonly updated_at: Date;
  readonly archived_at: Date | null;
}

const COLUMNAS_CONVERSACION = `id, organization_id, campaign_id, created_by, title, status, last_seq,
  last_message_at, created_at, updated_at, archived_at`;

function comoConversacion(r: ConversacionRow): ChatConversation {
  return {
    id: r.id,
    organizationId: r.organization_id,
    campaignId: r.campaign_id,
    createdBy: r.created_by,
    title: r.title ?? undefined,
    status: r.status,
    lastSeq: Number(r.last_seq),
    lastMessageAt: chatIso(r.last_message_at),
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
    archivedAt: chatIso(r.archived_at),
  };
}

/**
 * Carga una conversación y autoriza el acceso. Con `bloquear` toma el candado de
 * fila (serializa mensajes y runs de esa conversación); solo dentro de una
 * transacción.
 */
export async function chatCargarConversacionAutorizada(
  db: ChatConsultor,
  actor: User,
  action: 'chat:read' | 'chat:write',
  conversationId: string,
  bloquear = false,
): Promise<Result<ChatConversation>> {
  const { rows } = await db
    .query<ConversacionRow>(
      `SELECT ${COLUMNAS_CONVERSACION} FROM chat_conversations WHERE id = $1${bloquear ? ' FOR UPDATE' : ''}`,
      [conversationId],
    )
    .catch((error: unknown) => {
      // Un id que no es UUID no existe: misma respuesta que uno inexistente.
      if ((error as { code?: string }).code === '22P02') return { rows: [] as ConversacionRow[] };
      throw error;
    });
  const fila = rows[0];
  if (fila === undefined) return err(CHAT_NO_ENCONTRADO);
  const conversacion = comoConversacion(fila);
  const permitido = chatAutorizarConversacion(actor, action, conversacion);
  if (!permitido.ok) return permitido;
  return ok(conversacion);
}

// ─────────────────────────── Mensajes: filas y mapeo compartido ────────────────

interface MensajeRow {
  readonly id: string;
  readonly organization_id: string;
  readonly campaign_id: string;
  readonly conversation_id: string;
  readonly seq: string | number;
  readonly role: ChatMessageRole;
  readonly user_id: string;
  readonly content: string;
  readonly content_sha256: string;
  readonly client_message_id: string | null;
  readonly agent_run_id: string | null;
  readonly created_at: Date;
}

interface AdjuntoRow {
  readonly id: string;
  readonly message_id: string;
  readonly source_id: string;
  readonly position: number;
}

interface ReferenciaRow {
  readonly id: string;
  readonly message_id: string;
  readonly ordinal: number;
  readonly source_id: string;
  readonly fragment_id: string | null;
  readonly snapshot_id: string | null;
  readonly evidence_id: string | null;
  readonly locator: Record<string, unknown> | null;
  readonly fragment_text_sha256: string | null;
}

export const CHAT_COLUMNAS_MENSAJE = `id, organization_id, campaign_id, conversation_id, seq, role, user_id, content,
  content_sha256, client_message_id, agent_run_id, created_at`;

export interface ChatCargaDeMensajes {
  /** Mensajes con `seq` mayor que este valor. */
  readonly desdeSeq?: number | undefined;
  /** Máximo de mensajes (por defecto 100, tope 200). */
  readonly limite?: number | undefined;
  /** Los ÚLTIMOS `limite` mensajes (en orden ascendente) en vez de los primeros. */
  readonly ultimos?: boolean | undefined;
}

/** Lee mensajes de una conversación (ya autorizada) con sus adjuntos y citas. */
export async function chatCargarMensajes(
  db: ChatConsultor,
  conversationId: string,
  opciones: ChatCargaDeMensajes = {},
): Promise<ChatMessage[]> {
  const limite = Math.min(Math.max(Math.trunc(opciones.limite ?? 100), 1), 200);
  const desde = Math.max(Math.trunc(opciones.desdeSeq ?? 0), 0);
  const { rows } = await db.query<MensajeRow>(
    opciones.ultimos === true
      ? `SELECT * FROM (
           SELECT ${CHAT_COLUMNAS_MENSAJE} FROM chat_messages
            WHERE conversation_id = $1 AND seq > $2 ORDER BY seq DESC LIMIT $3
         ) ultimos ORDER BY seq ASC`
      : `SELECT ${CHAT_COLUMNAS_MENSAJE} FROM chat_messages
          WHERE conversation_id = $1 AND seq > $2 ORDER BY seq ASC LIMIT $3`,
    [conversationId, desde, limite],
  );
  return chatEnriquecerMensajes(db, rows);
}

/** Un mensaje por id con adjuntos y citas (sin autorizar: lo hace quien llama). */
export async function chatCargarMensajePorId(
  db: ChatConsultor,
  messageId: string,
): Promise<ChatMessage | undefined> {
  const { rows } = await db.query<MensajeRow>(
    `SELECT ${CHAT_COLUMNAS_MENSAJE} FROM chat_messages WHERE id = $1`,
    [messageId],
  );
  return (await chatEnriquecerMensajes(db, rows))[0];
}

export async function chatEnriquecerMensajes(
  db: ChatConsultor,
  filas: readonly MensajeRow[],
): Promise<ChatMessage[]> {
  if (filas.length === 0) return [];
  const ids = filas.map((f) => f.id);
  const { rows: adjuntos } = await db.query<AdjuntoRow>(
    `SELECT id, message_id, source_id, position FROM chat_message_attachments
      WHERE message_id = ANY($1::uuid[]) ORDER BY position`,
    [ids],
  );
  const { rows: referencias } = await db.query<ReferenciaRow>(
    `SELECT id, message_id, ordinal, source_id, fragment_id, snapshot_id, evidence_id, locator,
            fragment_text_sha256
       FROM chat_message_references WHERE message_id = ANY($1::uuid[]) ORDER BY ordinal`,
    [ids],
  );
  const adjuntosPorMensaje = new Map<string, ChatMessageAttachment[]>();
  for (const a of adjuntos) {
    const lista = adjuntosPorMensaje.get(a.message_id) ?? [];
    lista.push({ id: a.id, sourceId: a.source_id, position: a.position });
    adjuntosPorMensaje.set(a.message_id, lista);
  }
  const referenciasPorMensaje = new Map<string, ChatMessageReference[]>();
  for (const r of referencias) {
    const lista = referenciasPorMensaje.get(r.message_id) ?? [];
    lista.push({
      id: r.id,
      ordinal: r.ordinal,
      sourceId: r.source_id,
      fragmentId: r.fragment_id ?? undefined,
      snapshotId: r.snapshot_id ?? undefined,
      evidenceId: r.evidence_id ?? undefined,
      locator: r.locator ?? undefined,
      fragmentTextSha256: r.fragment_text_sha256 ?? undefined,
    });
    referenciasPorMensaje.set(r.message_id, lista);
  }
  return filas.map((f) => ({
    id: f.id,
    organizationId: f.organization_id,
    campaignId: f.campaign_id,
    conversationId: f.conversation_id,
    seq: Number(f.seq),
    role: f.role,
    userId: f.user_id,
    content: f.content,
    contentSha256: f.content_sha256,
    clientMessageId: f.client_message_id ?? undefined,
    agentRunId: f.agent_run_id ?? undefined,
    createdAt: f.created_at.toISOString(),
    attachments: adjuntosPorMensaje.get(f.id) ?? [],
    references: referenciasPorMensaje.get(f.id) ?? [],
  }));
}

// ─────────────────────────── Casos de uso ──────────────────────────────────────

const CONFLICTO_CONVERSACION = {
  code: 'RESOURCE_CONFLICT',
  message: 'La conversación cambió mientras se procesaba la operación. Reintente.',
} as const;

/** Estado de la campaña dentro de la organización del actor (undefined = no existe para él). */
export async function chatEstadoDeCampana(
  db: ChatConsultor,
  organizationId: string,
  campaignId: string,
): Promise<string | undefined> {
  const { rows } = await db
    .query<{ status: string }>(
      `SELECT status::text AS status FROM campaigns WHERE id = $1 AND organization_id = $2`,
      [campaignId, organizationId],
    )
    .catch((error: unknown) => {
      if ((error as { code?: string }).code === '22P02') return { rows: [] as { status: string }[] };
      throw error;
    });
  return rows[0]?.status;
}

export interface CrearConversacionInput {
  readonly campaignId: string;
  readonly title?: string | undefined;
}

/**
 * Crea una conversación en una campaña de la organización del actor. Una campaña
 * archivada o cancelada es de solo lectura: no admite conversaciones nuevas.
 */
export async function crearConversacion(
  actor: User,
  input: CrearConversacionInput,
): Promise<Result<ChatConversation>> {
  const capacidad = assertCapability(actor, 'chat:write');
  if (!capacidad.ok) return capacidad;
  const titulo = validarTituloConversacion(input.title);
  if (!titulo.ok) return titulo;

  return transaccionConResultado(async (client) => {
    if (actor.role === 'cliente') throw new Abortar(CHAT_NO_ENCONTRADO);
    const estado = await chatEstadoDeCampana(client, actor.organizationId, input.campaignId);
    if (estado === undefined) throw new Abortar(CHAT_NO_ENCONTRADO);
    if (estado !== 'activa') {
      throw new Abortar({
        code: 'RESOURCE_CONFLICT',
        message: 'La campaña no está activa: no admite conversaciones nuevas.',
        details: { reason: CHAT_CONFLICT_REASONS.campaignNotActive, status: estado },
      });
    }
    const { rows } = await client.query<ConversacionRow>(
      `INSERT INTO chat_conversations (organization_id, campaign_id, created_by, title)
       VALUES ($1, $2, $3, $4) RETURNING ${COLUMNAS_CONVERSACION}`,
      [actor.organizationId, input.campaignId, actor.id, titulo.value ?? null],
    );
    const creada = comoConversacion(rows[0]!);
    await recordAudit(client, {
      actor,
      action: 'conversation.create',
      entityType: 'conversation',
      entityId: creada.id,
      metadata: { campaignId: creada.campaignId },
      correlation: { conversationId: creada.id },
    });
    return creada;
  }, CONFLICTO_CONVERSACION);
}

export async function obtenerConversacion(
  actor: User,
  conversationId: string,
): Promise<Result<ChatConversation>> {
  return chatCargarConversacionAutorizada(getPool(), actor, 'chat:read', conversationId);
}

export interface ListarConversacionesOpciones {
  /** Por defecto solo las activas. */
  readonly status?: ChatConversationStatus | 'all' | undefined;
  readonly limite?: number | undefined;
}

/** Las conversaciones PROPIAS del actor en una campaña, la más reciente primero. */
export async function listarConversaciones(
  actor: User,
  campaignId: string,
  opciones: ListarConversacionesOpciones = {},
): Promise<Result<ChatConversation[]>> {
  const capacidad = assertCapability(actor, 'chat:read');
  if (!capacidad.ok) return capacidad;
  const estado = opciones.status ?? 'active';
  const limite = Math.min(Math.max(Math.trunc(opciones.limite ?? 50), 1), 100);
  const { rows } = await getPool()
    .query<ConversacionRow>(
      `SELECT ${COLUMNAS_CONVERSACION} FROM chat_conversations
        WHERE organization_id = $1 AND campaign_id = $2 AND created_by = $3
          AND ($4::text = 'all' OR status = $4)
        ORDER BY updated_at DESC, id LIMIT $5`,
      [actor.organizationId, campaignId, actor.id, estado, limite],
    )
    .catch((error: unknown) => {
      if ((error as { code?: string }).code === '22P02') return { rows: [] as ConversacionRow[] };
      throw error;
    });
  return ok(rows.map(comoConversacion));
}

/**
 * Archiva una conversación (terminal en v1). No se archiva con un run activo:
 * antes hay que cancelarlo o esperar a que termine.
 */
export async function archivarConversacion(
  actor: User,
  conversationId: string,
): Promise<Result<ChatConversation>> {
  return transaccionConResultado(async (client) => {
    const cargada = await chatCargarConversacionAutorizada(client, actor, 'chat:write', conversationId, true);
    if (!cargada.ok) {
      throw new Abortar({
        code: cargada.error.code,
        message: cargada.error.message,
        details: cargada.error.details,
      });
    }
    const conversacion = cargada.value;
    if (conversacion.status === 'archived') return conversacion; // idempotente

    const { rows: activos } = await client.query<{ id: string }>(
      `SELECT id FROM agent_runs WHERE conversation_id = $1 AND status IN ('queued', 'running')`,
      [conversationId],
    );
    if (activos[0] !== undefined) {
      throw new Abortar({
        code: 'RESOURCE_CONFLICT',
        message: 'La conversación tiene un run del agente activo: cancélelo o espere a que termine.',
        details: { reason: CHAT_CONFLICT_REASONS.runInProgress, runId: activos[0].id },
      });
    }
    const { rows } = await client.query<ConversacionRow>(
      `UPDATE chat_conversations SET status = 'archived', archived_at = now()
        WHERE id = $1 RETURNING ${COLUMNAS_CONVERSACION}`,
      [conversationId],
    );
    const archivada = comoConversacion(rows[0]!);
    await recordAudit(client, {
      actor,
      action: 'conversation.archive',
      entityType: 'conversation',
      entityId: archivada.id,
      metadata: { campaignId: archivada.campaignId },
      correlation: { conversationId: archivada.id },
    });
    return archivada;
  }, CONFLICTO_CONVERSACION);
}
