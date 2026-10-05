/**
 * Traza del chat (V2 · Fase 6): reconstruye
 *
 *   usuario → conversación → mensaje → run → invocación de tool → efecto
 *
 * a partir de las tablas del chat y de `audit_events.correlation` (índices de
 * expresión de la migración 021). La correlación es jsonb sin FK (D5): se une por
 * TEXTO (`t.id::text = a.correlation->>'toolInvocationId'`) porque las pruebas y los
 * casos de uso históricos escriben ids que no son UUID.
 *
 * Lectura owner-scoped (`chat:read` + ser el dueño de la conversación): otra
 * persona, organización o un cliente recibe `RESOURCE_NOT_FOUND`. Los eventos se
 * filtran siempre por la organización de la conversación. La metadata de auditoría
 * de las tools no lleva contenido de mensajes ni de documentos (ids, conteos).
 */

import type {
  AgentRun,
  AuditCorrelation,
  AuditOrigin,
  ChatConversation,
  ChatMessage,
  Result,
  ToolInvocation,
  User,
} from '@tcl-kol-os/domain';
import { err, ok } from '@tcl-kol-os/domain';
import {
  CHAT_NO_ENCONTRADO,
  type ChatConsultor,
  chatCargarConversacionAutorizada,
  chatCargarMensajePorId,
  chatCargarMensajes,
} from './chat-conversations.ts';
import { chatCargarRun } from './agent-runs.ts';
import {
  CHAT_COLUMNAS_INVOCACION,
  type ChatInvocacionRow,
  chatComoInvocacion,
} from './agent-tool-invocations.ts';
import { getPool } from './client.ts';

/** Un evento de auditoría que cuelga de la cadena (efecto de una tool o evento del run). */
export interface EfectoDeAuditoria {
  readonly id: string;
  readonly action: string;
  readonly entityType: string;
  readonly entityId: string | undefined;
  readonly origin: AuditOrigin | undefined;
  readonly actorId: string | undefined;
  readonly correlation: AuditCorrelation | undefined;
  readonly metadata: Record<string, unknown>;
  readonly createdAt: string;
}

export interface TrazaDeInvocacion {
  readonly invocation: ToolInvocation;
  /** Eventos cuya correlación nombra esta invocación (lo que la tool realmente hizo). */
  readonly effects: readonly EfectoDeAuditoria[];
}

export interface TrazaDeRun {
  readonly run: AgentRun;
  /** Persona en cuyo nombre actuó el agente. */
  readonly user: { readonly id: string; readonly name: string };
  readonly invocations: readonly TrazaDeInvocacion[];
  /** Eventos del run sin invocación (cancelación, reintento, abandono). */
  readonly events: readonly EfectoDeAuditoria[];
  /** Mensaje del asistente que produjo el run, si completó. */
  readonly assistantMessageId: string | undefined;
}

export interface TrazaDeTurno {
  readonly userMessage: ChatMessage;
  readonly runs: readonly TrazaDeRun[];
}

export interface TrazaDeConversacion {
  readonly conversation: ChatConversation;
  readonly user: { readonly id: string; readonly name: string };
  /** Eventos de la conversación sin run (creación, archivo). */
  readonly events: readonly EfectoDeAuditoria[];
  readonly turns: readonly TrazaDeTurno[];
}

interface EventoFila {
  readonly id: string;
  readonly action: string;
  readonly entity_type: string;
  readonly entity_id: string | null;
  readonly origin: AuditOrigin | null;
  readonly actor_id: string | null;
  readonly correlation: AuditCorrelation | null;
  readonly metadata: Record<string, unknown>;
  readonly created_at: Date;
}

const COLUMNAS_EVENTO = `a.id, a.action, a.entity_type, a.entity_id, a.origin, a.actor_id, a.correlation, a.metadata,
  a.created_at`;

function comoEfecto(e: EventoFila): EfectoDeAuditoria {
  return {
    id: e.id,
    action: e.action,
    entityType: e.entity_type,
    entityId: e.entity_id ?? undefined,
    origin: e.origin ?? undefined,
    actorId: e.actor_id ?? undefined,
    correlation: e.correlation ?? undefined,
    metadata: e.metadata,
    createdAt: e.created_at.toISOString(),
  };
}

async function nombreDeUsuario(db: ChatConsultor, userId: string): Promise<{ id: string; name: string }> {
  const { rows } = await db.query<{ name: string }>(`SELECT name FROM users WHERE id = $1`, [userId]);
  return { id: userId, name: rows[0]?.name ?? '' };
}

/** Eventos de auditoría por clave de correlación (usa los índices de expresión). */
async function eventosPorCorrelacion(
  db: ChatConsultor,
  organizationId: string,
  clave: 'conversationId' | 'agentRunId' | 'toolInvocationId',
  valores: readonly string[],
  soloSinClave?: 'agentRunId' | 'toolInvocationId',
): Promise<EventoFila[]> {
  if (valores.length === 0) return [];
  const { rows } = await db.query<EventoFila>(
    `SELECT ${COLUMNAS_EVENTO}
       FROM audit_events a
      WHERE a.organization_id = $1
        AND a.correlation->>'${clave}' = ANY($2::text[])
        ${soloSinClave === undefined ? '' : `AND a.correlation->>'${soloSinClave}' IS NULL`}
      ORDER BY a.created_at, a.id`,
    [organizationId, valores],
  );
  return rows;
}

async function trazaDeRunEnDb(db: ChatConsultor, run: AgentRun): Promise<TrazaDeRun> {
  const { rows: invocaciones } = await db.query<ChatInvocacionRow>(
    `SELECT ${CHAT_COLUMNAS_INVOCACION} FROM agent_tool_invocations WHERE agent_run_id = $1 ORDER BY sequence`,
    [run.id],
  );
  const efectos = await eventosPorCorrelacion(
    db,
    run.organizationId,
    'toolInvocationId',
    invocaciones.map((i) => i.id),
  );
  const eventosDelRun = await eventosPorCorrelacion(
    db,
    run.organizationId,
    'agentRunId',
    [run.id],
    'toolInvocationId',
  );
  const { rows: respuesta } = await db.query<{ id: string }>(
    `SELECT id FROM chat_messages WHERE agent_run_id = $1`,
    [run.id],
  );
  return {
    run,
    user: await nombreDeUsuario(db, run.userId),
    invocations: invocaciones.map((i) => ({
      invocation: chatComoInvocacion(i),
      effects: efectos.filter((e) => e.correlation?.toolInvocationId === i.id).map(comoEfecto),
    })),
    events: eventosDelRun.map(comoEfecto),
    assistantMessageId: respuesta[0]?.id,
  };
}

/** Traza de un run propio: sus invocaciones y, de cada una, los efectos auditados. */
export async function trazaDeRun(actor: User, runId: string): Promise<Result<TrazaDeRun>> {
  const db = getPool();
  const run = await chatCargarRun(db, runId);
  if (run === undefined) return err(CHAT_NO_ENCONTRADO);
  const conv = await chatCargarConversacionAutorizada(db, actor, 'chat:read', run.conversationId);
  if (!conv.ok) return conv;
  return ok(await trazaDeRunEnDb(db, run));
}

export interface TrazaCompletaDeInvocacion {
  readonly user: { readonly id: string; readonly name: string };
  readonly conversation: ChatConversation;
  readonly userMessage: ChatMessage;
  readonly run: AgentRun;
  readonly trace: TrazaDeInvocacion;
}

/** De una invocación de tool hacia arriba: usuario, conversación, mensaje y run; y hacia abajo, sus efectos. */
export async function trazaDeInvocacion(
  actor: User,
  toolInvocationId: string,
): Promise<Result<TrazaCompletaDeInvocacion>> {
  const db = getPool();
  const { rows } = await db
    .query<ChatInvocacionRow>(
      `SELECT ${CHAT_COLUMNAS_INVOCACION} FROM agent_tool_invocations WHERE id = $1`,
      [toolInvocationId],
    )
    .catch((error: unknown) => {
      if ((error as { code?: string }).code === '22P02') return { rows: [] as ChatInvocacionRow[] };
      throw error;
    });
  if (rows[0] === undefined) return err(CHAT_NO_ENCONTRADO);
  const run = await chatCargarRun(db, rows[0].agent_run_id);
  if (run === undefined) return err(CHAT_NO_ENCONTRADO);
  const conv = await chatCargarConversacionAutorizada(db, actor, 'chat:read', run.conversationId);
  if (!conv.ok) return conv;
  const userMessage = await chatCargarMensajePorId(db, run.userMessageId);
  if (userMessage === undefined) return err(CHAT_NO_ENCONTRADO);
  const efectos = await eventosPorCorrelacion(db, run.organizationId, 'toolInvocationId', [toolInvocationId]);
  return ok({
    user: await nombreDeUsuario(db, run.userId),
    conversation: conv.value,
    userMessage,
    run,
    trace: { invocation: chatComoInvocacion(rows[0]), effects: efectos.map(comoEfecto) },
  });
}

/**
 * De una acción propuesta hacia atrás: qué invocaciones del agente la dejaron
 * (puede haber varias: la propuesta idempotente se reutiliza). Solo del dueño.
 */
export async function trazaDeAccionPropuesta(
  actor: User,
  proposedActionId: string,
): Promise<Result<TrazaCompletaDeInvocacion[]>> {
  const db = getPool();
  const { rows } = await db
    .query<{ id: string }>(
      `SELECT t.id FROM agent_tool_invocations t WHERE t.proposed_action_id = $1 AND t.organization_id = $2
        ORDER BY t.started_at`,
      [proposedActionId, actor.organizationId],
    )
    .catch((error: unknown) => {
      if ((error as { code?: string }).code === '22P02') return { rows: [] as { id: string }[] };
      throw error;
    });
  const trazas: TrazaCompletaDeInvocacion[] = [];
  for (const fila of rows) {
    const traza = await trazaDeInvocacion(actor, fila.id);
    if (traza.ok) trazas.push(traza.value);
  }
  if (trazas.length === 0) return err(CHAT_NO_ENCONTRADO);
  return ok(trazas);
}

export interface OpcionesDeTraza {
  /** Máximo de mensajes de usuario (turnos) a reconstruir, los más recientes (por defecto 50). */
  readonly limiteDeTurnos?: number | undefined;
}

/** Traza completa de una conversación propia, turno por turno. */
export async function trazaDeConversacion(
  actor: User,
  conversationId: string,
  opciones: OpcionesDeTraza = {},
): Promise<Result<TrazaDeConversacion>> {
  const db = getPool();
  const conv = await chatCargarConversacionAutorizada(db, actor, 'chat:read', conversationId);
  if (!conv.ok) return conv;
  const conversacion = conv.value;
  const limite = Math.min(Math.max(Math.trunc(opciones.limiteDeTurnos ?? 50), 1), 100);

  const mensajes = await chatCargarMensajes(db, conversationId, {
    ultimos: true,
    limite: Math.min(limite * 2, 200),
  });
  const mensajesDeUsuario = mensajes.filter((m) => m.role === 'user').slice(-limite);
  const turnos: TrazaDeTurno[] = [];
  for (const userMessage of mensajesDeUsuario) {
    const { rows } = await db.query<{ id: string }>(
      `SELECT id FROM agent_runs WHERE user_message_id = $1 ORDER BY attempt`,
      [userMessage.id],
    );
    const runs: TrazaDeRun[] = [];
    for (const fila of rows) {
      const run = await chatCargarRun(db, fila.id);
      if (run !== undefined) runs.push(await trazaDeRunEnDb(db, run));
    }
    turnos.push({ userMessage, runs });
  }
  const eventos = await eventosPorCorrelacion(
    db,
    conversacion.organizationId,
    'conversationId',
    [conversationId],
    'agentRunId',
  );
  return ok({
    conversation: conversacion,
    user: await nombreDeUsuario(db, conversacion.createdBy),
    events: eventos.map(comoEfecto),
    turns: turnos,
  });
}
