/**
 * Ejecuciones del agente (V2 · Fase 6): un run = UN turno del agente para UN
 * mensaje de usuario (attempt N).
 *
 *   queued → running → completed | failed | cancelled
 *   queued → failed | cancelled
 *
 * El run es una FILA durable de Postgres (D9): el proceso que lo ejecuta puede
 * caer; la fila queda y un barrido lo cierra como `failed` con `RUN_ABANDONED`
 * (patrón `SYNC_ABANDONED` de `source-sync.ts`). No hay auto-reencolado: la persona
 * reintenta con `reintentarRun` (attempt + 1).
 *
 *  · Una conversación tiene a lo sumo UN run activo (índice único parcial). El
 *    mensaje del asistente se escribe UNA vez, al completar el run.
 *  · El runtime (Node) actúa COMO la persona dueña de la conversación: todas estas
 *    funciones reciben su `User` ya releído de la base (activo, misma organización)
 *    y exigen `chat:write` y ser el dueño. El runtime nunca llama como `system`;
 *    solo el barrido de abandonados (`abandonarRunsCaducados`) es del sistema.
 *  · Orden de bloqueo uniforme: conversación → run (evita interbloqueos con
 *    `publicarMensaje` y `reintentarRun`).
 *  · Los errores de un run guardan un código y un mensaje corto sanitizado: nunca
 *    contenido de documentos ni razonamiento del modelo.
 */

import type pg from 'pg';
import {
  type AgentRun,
  type AgentRunConfig,
  type AgentRunStatus,
  type ChatMessage,
  type DomainError,
  type ModelTier,
  type Result,
  type User,
  AGENT_RUN_HEARTBEAT_TIMEOUT_MINUTES,
  AGENT_RUN_QUEUED_TIMEOUT_MINUTES,
  CHAT_CONFLICT_REASONS,
  CHAT_LIMITS,
  RUN_ABANDONED,
  TOOL_ABANDONED,
  err,
  esCodigoDeErrorValido,
  ok,
  sanitizarManifiestoDeContexto,
  sanitizarMensajeDeError,
  validarConfiguracionDeRun,
  validarContenidoMensaje,
} from '@tcl-kol-os/domain';
import { assertCapability } from './authz.ts';
import { recordAudit } from './audit.ts';
import { getPool, transaction } from './client.ts';
import {
  CHAT_COLUMNAS_MENSAJE,
  CHAT_NO_ENCONTRADO,
  type ChatConsultor,
  chatCargarConversacionAutorizada,
  chatEnriquecerMensajes,
  chatEstadoDeCampana,
  chatIso,
} from './chat-conversations.ts';
import { Abortar, transaccionConResultado } from './tx-result.ts';

// ─────────────────────────── Filas y mapeo ─────────────────────────────────────

interface RunRow {
  readonly id: string;
  readonly organization_id: string;
  readonly campaign_id: string;
  readonly conversation_id: string;
  readonly user_message_id: string;
  readonly user_id: string;
  readonly attempt: number;
  readonly status: AgentRunStatus;
  readonly provider: string;
  readonly model: string;
  readonly tier: ModelTier;
  readonly prompt_version: string;
  readonly context_version: string;
  readonly context_hash: string | null;
  readonly context_manifest: Record<string, unknown> | null;
  readonly request_id: string | null;
  readonly cancel_requested_at: Date | null;
  readonly heartbeat_at: Date | null;
  readonly queued_at: Date;
  readonly started_at: Date | null;
  readonly finished_at: Date | null;
  readonly error_code: string | null;
  readonly error_message: string | null;
}

export const CHAT_COLUMNAS_RUN = `id, organization_id, campaign_id, conversation_id, user_message_id, user_id, attempt,
  status, provider, model, tier, prompt_version, context_version, context_hash, context_manifest, request_id,
  cancel_requested_at, heartbeat_at, queued_at, started_at, finished_at, error_code, error_message`;

export function chatComoRun(r: RunRow): AgentRun {
  return {
    id: r.id,
    organizationId: r.organization_id,
    campaignId: r.campaign_id,
    conversationId: r.conversation_id,
    userMessageId: r.user_message_id,
    userId: r.user_id,
    attempt: r.attempt,
    status: r.status,
    provider: r.provider,
    model: r.model,
    tier: r.tier,
    promptVersion: r.prompt_version,
    contextVersion: r.context_version,
    contextHash: r.context_hash ?? undefined,
    contextManifest: r.context_manifest ?? undefined,
    requestId: r.request_id ?? undefined,
    cancelRequestedAt: chatIso(r.cancel_requested_at),
    heartbeatAt: chatIso(r.heartbeat_at),
    queuedAt: r.queued_at.toISOString(),
    startedAt: chatIso(r.started_at),
    finishedAt: chatIso(r.finished_at),
    errorCode: r.error_code ?? undefined,
    errorMessage: r.error_message ?? undefined,
  };
}

export async function chatCargarRun(db: ChatConsultor, runId: string): Promise<AgentRun | undefined> {
  const { rows } = await db
    .query<RunRow>(`SELECT ${CHAT_COLUMNAS_RUN} FROM agent_runs WHERE id = $1`, [runId])
    .catch((error: unknown) => {
      if ((error as { code?: string }).code === '22P02') return { rows: [] as RunRow[] };
      throw error;
    });
  return rows[0] === undefined ? undefined : chatComoRun(rows[0]);
}

/** El último intento (mayor `attempt`) de un mensaje de usuario. */
export async function chatUltimoRunDeMensaje(
  db: ChatConsultor,
  userMessageId: string,
): Promise<AgentRun | undefined> {
  const { rows } = await db.query<RunRow>(
    `SELECT ${CHAT_COLUMNAS_RUN} FROM agent_runs WHERE user_message_id = $1 ORDER BY attempt DESC LIMIT 1`,
    [userMessageId],
  );
  return rows[0] === undefined ? undefined : chatComoRun(rows[0]);
}

const CONFLICTO_RUN = {
  code: 'RESOURCE_CONFLICT',
  message: 'El run cambió mientras se procesaba la operación. Reintente.',
} as const;

function conflicto(reason: string, message: string, extra: Record<string, unknown> = {}): Abortar {
  return new Abortar({ code: 'RESOURCE_CONFLICT', message, details: { reason, ...extra } });
}

function relanzar(error: DomainError): never {
  throw new Abortar({ code: error.code, message: error.message, details: error.details });
}

// ─────────────────────────── Carga autorizada de un run ────────────────────────

/** Lee el run y su conversación sin bloquear (lecturas y latido). */
async function cargarRunAutorizado(
  db: ChatConsultor,
  actor: User,
  action: 'chat:read' | 'chat:write',
  runId: string,
): Promise<Result<AgentRun>> {
  const run = await chatCargarRun(db, runId);
  if (run === undefined) return err(CHAT_NO_ENCONTRADO);
  const conv = await chatCargarConversacionAutorizada(db, actor, action, run.conversationId);
  if (!conv.ok) return conv;
  return ok(run);
}

/**
 * Bloquea conversación y luego run (orden uniforme) y autoriza al actor. Solo
 * dentro de una transacción.
 */
async function cargarRunBloqueado(
  client: pg.PoolClient,
  actor: User,
  runId: string,
): Promise<{ run: AgentRun; conversacion: { organizationId: string; campaignId: string; id: string } }> {
  const previo = await chatCargarRun(client, runId);
  if (previo === undefined) throw new Abortar(CHAT_NO_ENCONTRADO);
  const conv = await chatCargarConversacionAutorizada(
    client,
    actor,
    'chat:write',
    previo.conversationId,
    true,
  );
  if (!conv.ok) relanzar(conv.error);
  const { rows } = await client.query<RunRow>(
    `SELECT ${CHAT_COLUMNAS_RUN} FROM agent_runs WHERE id = $1 FOR UPDATE`,
    [runId],
  );
  const run = chatComoRun(rows[0]!);
  return {
    run,
    conversacion: {
      id: conv.value.id,
      organizationId: conv.value.organizationId,
      campaignId: conv.value.campaignId,
    },
  };
}

// ─────────────────────────── Lecturas ──────────────────────────────────────────

export async function obtenerRun(actor: User, runId: string): Promise<Result<AgentRun>> {
  return cargarRunAutorizado(getPool(), actor, 'chat:read', runId);
}

/** Los runs de una conversación propia, el más reciente primero. */
export async function listarRunsDeConversacion(
  actor: User,
  conversationId: string,
  limite = 20,
): Promise<Result<AgentRun[]>> {
  const conv = await chatCargarConversacionAutorizada(getPool(), actor, 'chat:read', conversationId);
  if (!conv.ok) return conv;
  const { rows } = await getPool().query<RunRow>(
    `SELECT ${CHAT_COLUMNAS_RUN} FROM agent_runs WHERE conversation_id = $1
      ORDER BY queued_at DESC, attempt DESC LIMIT $2`,
    [conversationId, Math.min(Math.max(Math.trunc(limite), 1), 100)],
  );
  return ok(rows.map(chatComoRun));
}

// ─────────────────────────── Barrido de abandonados ────────────────────────────

export interface OpcionesDeBarrido {
  /** Momento de referencia (por defecto, ahora). Útil para probar el vencimiento. */
  readonly ahora?: Date | undefined;
  /** Limita el barrido a una conversación (lo usa `publicarMensaje`). */
  readonly conversationId?: string | undefined;
}

/**
 * Cierra como `failed`/`RUN_ABANDONED` los runs activos sin latido (o `queued` que
 * nunca arrancaron), cerrando antes sus invocaciones de tool abiertas con
 * `TOOL_ABANDONED`. Se llama dentro de la transacción de quien lo necesita.
 */
export async function chatCerrarRunsCaducados(
  client: pg.PoolClient,
  opciones: OpcionesDeBarrido = {},
): Promise<string[]> {
  const ahora = opciones.ahora ?? new Date();
  const { rows } = await client.query<{
    id: string;
    organization_id: string;
    campaign_id: string;
    conversation_id: string;
    user_message_id: string;
    status: AgentRunStatus;
  }>(
    `SELECT id, organization_id, campaign_id, conversation_id, user_message_id, status
       FROM agent_runs
      WHERE status IN ('queued', 'running')
        AND ($1::uuid IS NULL OR conversation_id = $1)
        AND (
          (status = 'queued'  AND queued_at < $2::timestamptz - make_interval(mins => $3))
          OR (status = 'running' AND COALESCE(heartbeat_at, started_at) < $2::timestamptz - make_interval(mins => $4))
        )
      ORDER BY queued_at
      FOR UPDATE SKIP LOCKED`,
    [
      opciones.conversationId ?? null,
      ahora,
      AGENT_RUN_QUEUED_TIMEOUT_MINUTES,
      AGENT_RUN_HEARTBEAT_TIMEOUT_MINUTES,
    ],
  );
  const cerrados: string[] = [];
  for (const run of rows) {
    // Primero las tools abiertas: el trigger del run exige que no queden.
    await client.query(
      `UPDATE agent_tool_invocations SET status = 'failed', error_code = $2, finished_at = now()
        WHERE agent_run_id = $1 AND status = 'running'`,
      [run.id, TOOL_ABANDONED],
    );
    await client.query(
      `UPDATE agent_runs SET status = 'failed', error_code = $2, finished_at = now(),
              error_message = 'El run quedó sin completarse y se dio por abandonado.'
        WHERE id = $1`,
      [run.id, RUN_ABANDONED],
    );
    await recordAudit(client, {
      actor: 'system',
      organizationId: run.organization_id,
      action: 'agent_run.abandon',
      entityType: 'agent_run',
      entityId: run.id,
      metadata: { campaignId: run.campaign_id, estadoAnterior: run.status },
      correlation: {
        conversationId: run.conversation_id,
        messageId: run.user_message_id,
        agentRunId: run.id,
      },
    });
    cerrados.push(run.id);
  }
  return cerrados;
}

/**
 * Barrido global de runs abandonados (mantenimiento del sistema; análogo a
 * `vencerAccionesCaducadas`). Devuelve cuántos cerró.
 */
export async function abandonarRunsCaducados(
  opciones: { readonly ahora?: Date | undefined } = {},
): Promise<number> {
  return transaction(async (client) => (await chatCerrarRunsCaducados(client, opciones)).length);
}

// ─────────────────────────── Admisión del run ──────────────────────────────────

/**
 * Inserta un run `queued` para un mensaje de usuario. Lo usan `publicarMensaje`
 * (attempt 1) y `reintentarRun` (attempt + 1); quien llama ya bloqueó la
 * conversación y comprobó que no hay run activo.
 */
export async function chatInsertarRun(
  client: pg.PoolClient,
  datos: {
    readonly organizationId: string;
    readonly campaignId: string;
    readonly conversationId: string;
    readonly userMessageId: string;
    readonly userId: string;
    readonly attempt: number;
    readonly config: AgentRunConfig;
  },
): Promise<AgentRun> {
  const { rows } = await client.query<RunRow>(
    `INSERT INTO agent_runs
       (organization_id, campaign_id, conversation_id, user_message_id, user_id, attempt,
        provider, model, tier, prompt_version, context_version)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     RETURNING ${CHAT_COLUMNAS_RUN}`,
    [
      datos.organizationId,
      datos.campaignId,
      datos.conversationId,
      datos.userMessageId,
      datos.userId,
      datos.attempt,
      datos.config.provider,
      datos.config.model,
      datos.config.tier,
      datos.config.promptVersion,
      datos.config.contextVersion,
    ],
  );
  return chatComoRun(rows[0]!);
}

// ─────────────────────────── Ciclo de vida ─────────────────────────────────────

export interface IniciarRunInput {
  /** SHA-256 (hex) del contexto que verá el modelo. */
  readonly contextHash: string;
  /** Solo ids y conteos de lo que el modelo pudo ver; se sanitiza y acota. */
  readonly contextManifest: Readonly<Record<string, unknown>>;
  readonly requestId?: string | undefined;
}

/** `queued → running`: fija el contexto una sola vez y arranca el latido. */
export async function iniciarRun(
  actor: User,
  runId: string,
  input: IniciarRunInput,
): Promise<Result<AgentRun>> {
  if (typeof input.contextHash !== 'string' || !/^[0-9a-f]{64}$/.test(input.contextHash)) {
    return err({
      code: 'VALIDATION_FAILED',
      message: 'La huella del contexto no es válida.',
      details: { field: 'contextHash' },
    });
  }
  const manifiesto = sanitizarManifiestoDeContexto(input.contextManifest);
  const requestId =
    input.requestId === undefined
      ? null
      : input.requestId.length > 200
        ? input.requestId.slice(0, 200)
        : input.requestId;

  return transaccionConResultado(async (client) => {
    const { run } = await cargarRunBloqueado(client, actor, runId);
    if (run.status !== 'queued') {
      throw conflicto(CHAT_CONFLICT_REASONS.runNotQueued, 'El run no está en cola.', { status: run.status });
    }
    const { rows } = await client.query<RunRow>(
      `UPDATE agent_runs
          SET status = 'running', started_at = now(), heartbeat_at = now(),
              context_hash = $2, context_manifest = $3::jsonb, request_id = $4
        WHERE id = $1 RETURNING ${CHAT_COLUMNAS_RUN}`,
      [runId, input.contextHash, JSON.stringify(manifiesto.valor), requestId],
    );
    return chatComoRun(rows[0]!);
  }, CONFLICTO_RUN);
}

export interface LatidoDeRun {
  /** La persona pidió cancelar: el runtime debe cortar y llamar a `confirmarCancelacionDeRun`. */
  readonly cancelRequested: boolean;
}

/**
 * Latido del run en ejecución. Si el run ya no está `running` (lo abandonó el
 * barrido o lo cancelaron), devuelve `RESOURCE_CONFLICT` `run_not_running`: el
 * runtime debe detenerse.
 */
export async function latidoRun(actor: User, runId: string): Promise<Result<LatidoDeRun>> {
  const cargado = await cargarRunAutorizado(getPool(), actor, 'chat:write', runId);
  if (!cargado.ok) return cargado;
  const { rows } = await getPool().query<{ cancel_requested_at: Date | null }>(
    `UPDATE agent_runs SET heartbeat_at = now() WHERE id = $1 AND status = 'running'
     RETURNING cancel_requested_at`,
    [runId],
  );
  if (rows[0] === undefined) {
    return err({
      code: 'RESOURCE_CONFLICT',
      message: 'El run ya no está en ejecución.',
      details: { reason: CHAT_CONFLICT_REASONS.runNotRunning, status: cargado.value.status },
    });
  }
  return ok({ cancelRequested: rows[0].cancel_requested_at !== null });
}

async function cerrarInvocacionesAbiertas(
  client: pg.PoolClient,
  runId: string,
  estado: 'failed' | 'cancelled',
  codigo: string,
) {
  await client.query(
    `UPDATE agent_tool_invocations
        SET status = $2, finished_at = now(), error_code = CASE WHEN $2 = 'failed' THEN $3 ELSE NULL END
      WHERE agent_run_id = $1 AND status = 'running'`,
    [runId, estado, codigo],
  );
}

export interface CancelacionDeRun {
  readonly run: AgentRun;
  /** `true` si el run quedó cancelado ya; `false` si solo se pidió (sigue `running`). */
  readonly cancelled: boolean;
}

/**
 * La persona cancela un run. Si está en cola se cancela de inmediato; si está en
 * ejecución se registra la solicitud y el runtime la ve en su próximo latido
 * (`confirmarCancelacionDeRun` lo cierra). Idempotente.
 */
export async function cancelarRun(actor: User, runId: string): Promise<Result<CancelacionDeRun>> {
  return transaccionConResultado(async (client) => {
    const { run } = await cargarRunBloqueado(client, actor, runId);
    if (run.status === 'cancelled') return { run, cancelled: true };
    if (run.status !== 'queued' && run.status !== 'running') {
      throw conflicto(CHAT_CONFLICT_REASONS.runNotActive, 'El run ya terminó.', { status: run.status });
    }
    if (run.status === 'running' && run.cancelRequestedAt !== undefined) return { run, cancelled: false };

    let resultado: AgentRun;
    if (run.status === 'queued') {
      const { rows } = await client.query<RunRow>(
        `UPDATE agent_runs SET status = 'cancelled', cancel_requested_at = now(), finished_at = now()
          WHERE id = $1 RETURNING ${CHAT_COLUMNAS_RUN}`,
        [runId],
      );
      resultado = chatComoRun(rows[0]!);
    } else {
      const { rows } = await client.query<RunRow>(
        `UPDATE agent_runs SET cancel_requested_at = now() WHERE id = $1 RETURNING ${CHAT_COLUMNAS_RUN}`,
        [runId],
      );
      resultado = chatComoRun(rows[0]!);
    }
    await recordAudit(client, {
      actor,
      action: 'agent_run.cancel',
      entityType: 'agent_run',
      entityId: runId,
      metadata: { campaignId: run.campaignId, estadoAnterior: run.status, directa: run.status === 'queued' },
      correlation: { conversationId: run.conversationId, messageId: run.userMessageId, agentRunId: runId },
    });
    return { run: resultado, cancelled: resultado.status === 'cancelled' };
  }, CONFLICTO_RUN);
}

/** El runtime confirma que cortó: `running → cancelled` (con la solicitud previa). */
export async function confirmarCancelacionDeRun(actor: User, runId: string): Promise<Result<AgentRun>> {
  return transaccionConResultado(async (client) => {
    const { run } = await cargarRunBloqueado(client, actor, runId);
    if (run.status === 'cancelled') return run;
    if (run.status !== 'running' || run.cancelRequestedAt === undefined) {
      throw conflicto(
        CHAT_CONFLICT_REASONS.runNotRunning,
        'No hay una cancelación pendiente para este run.',
        {
          status: run.status,
        },
      );
    }
    await cerrarInvocacionesAbiertas(client, runId, 'cancelled', '');
    const { rows } = await client.query<RunRow>(
      `UPDATE agent_runs SET status = 'cancelled', finished_at = now() WHERE id = $1 RETURNING ${CHAT_COLUMNAS_RUN}`,
      [runId],
    );
    return chatComoRun(rows[0]!);
  }, CONFLICTO_RUN);
}

export interface FallarRunInput {
  /** Identificador en MAYÚSCULAS (p. ej. `MODEL_UNAVAILABLE`), no texto libre. */
  readonly errorCode: string;
  /** Texto corto sanitizado; nunca contenido de documentos ni razonamiento del modelo. */
  readonly errorMessage?: string | undefined;
}

/** `queued|running → failed`. Cierra las invocaciones abiertas. Idempotente con el mismo código. */
export async function fallarRun(
  actor: User,
  runId: string,
  input: FallarRunInput,
): Promise<Result<AgentRun>> {
  if (!esCodigoDeErrorValido(input.errorCode)) {
    return err({
      code: 'VALIDATION_FAILED',
      message: `El código de error del run no es válido (máx. ${CHAT_LIMITS.errorCodigoMax}, MAYÚSCULAS y guion bajo).`,
      details: { field: 'errorCode' },
    });
  }
  const mensaje = sanitizarMensajeDeError(input.errorMessage) ?? null;

  return transaccionConResultado(async (client) => {
    const { run } = await cargarRunBloqueado(client, actor, runId);
    if (run.status === 'failed' && run.errorCode === input.errorCode) return run;
    if (run.status !== 'queued' && run.status !== 'running') {
      throw conflicto(CHAT_CONFLICT_REASONS.runNotActive, 'El run ya terminó.', { status: run.status });
    }
    await cerrarInvocacionesAbiertas(client, runId, 'failed', 'RUN_FAILED');
    const { rows } = await client.query<RunRow>(
      `UPDATE agent_runs SET status = 'failed', error_code = $2, error_message = $3, finished_at = now()
        WHERE id = $1 RETURNING ${CHAT_COLUMNAS_RUN}`,
      [runId, input.errorCode, mensaje],
    );
    return chatComoRun(rows[0]!);
  }, CONFLICTO_RUN);
}

// ─────────────────────────── Completar con la respuesta ────────────────────────

/** Una cita del mensaje del asistente (el runtime ya la validó contra su registro de referencias). */
export interface CitaDeRespuesta {
  readonly sourceId: string;
  readonly fragmentId?: string | undefined;
  readonly snapshotId?: string | undefined;
  readonly evidenceId?: string | undefined;
  readonly locator?: Readonly<Record<string, unknown>> | undefined;
}

export interface CompletarRunInput {
  readonly content: string;
  readonly references?: readonly CitaDeRespuesta[] | undefined;
}

export interface RunCompletado {
  readonly run: AgentRun;
  readonly message: ChatMessage;
}

function errorDeInsercion(error: unknown): boolean {
  const codigo = (error as { code?: string }).code;
  // FK (23503), CHECK (23514), UNIQUE (23505), uuid inválido (22P02) o trigger (P0001).
  return (
    codigo === '23503' || codigo === '23514' || codigo === '23505' || codigo === '22P02' || codigo === 'P0001'
  );
}

/**
 * `running → completed` con el mensaje del asistente y sus citas, en UNA
 * transacción. Falla si el run no está en ejecución, si se pidió cancelarlo (hay
 * que llamar a `confirmarCancelacionDeRun`), si quedan invocaciones abiertas o si
 * una cita apunta a una fuente fuera de la campaña de la conversación.
 */
export async function completarRun(
  actor: User,
  runId: string,
  input: CompletarRunInput,
): Promise<Result<RunCompletado>> {
  const contenido = validarContenidoMensaje(input.content);
  if (!contenido.ok) return contenido;
  const citas: CitaDeRespuesta[] = [];
  const vistas = new Set<string>();
  for (const cita of input.references ?? []) {
    if (typeof cita?.sourceId !== 'string' || cita.sourceId === '') {
      return err({
        code: 'VALIDATION_FAILED',
        message: 'Una cita no declara su fuente.',
        details: { field: 'references' },
      });
    }
    const clave = `${cita.sourceId}|${cita.fragmentId ?? ''}|${cita.evidenceId ?? ''}`;
    if (vistas.has(clave)) continue;
    vistas.add(clave);
    citas.push(cita);
  }
  if (citas.length > CHAT_LIMITS.referenciasPorMensaje) {
    return err({
      code: 'VALIDATION_FAILED',
      message: `Una respuesta admite hasta ${CHAT_LIMITS.referenciasPorMensaje} citas.`,
      details: { field: 'references', max: CHAT_LIMITS.referenciasPorMensaje },
    });
  }

  return transaccionConResultado(async (client) => {
    const { run, conversacion } = await cargarRunBloqueado(client, actor, runId);
    if (run.status !== 'running') {
      throw conflicto(CHAT_CONFLICT_REASONS.runNotRunning, 'El run no está en ejecución.', {
        status: run.status,
      });
    }
    if (run.cancelRequestedAt !== undefined) {
      throw conflicto(
        CHAT_CONFLICT_REASONS.cancelRequested,
        'Se pidió cancelar el run: no se publica la respuesta.',
      );
    }
    const { rows: abiertas } = await client.query<{ id: string }>(
      `SELECT id FROM agent_tool_invocations WHERE agent_run_id = $1 AND status = 'running' LIMIT 1`,
      [runId],
    );
    if (abiertas[0] !== undefined) {
      throw conflicto(CHAT_CONFLICT_REASONS.toolsOpen, 'Quedan invocaciones de tools abiertas en el run.');
    }

    const { rows: mensajes } = await client.query<{ id: string; seq: string }>(
      `INSERT INTO chat_messages (organization_id, campaign_id, conversation_id, role, user_id, content, agent_run_id)
       VALUES ($1, $2, $3, 'assistant', $4, $5, $6) RETURNING id, seq`,
      [
        conversacion.organizationId,
        conversacion.campaignId,
        conversacion.id,
        run.userId,
        contenido.value,
        runId,
      ],
    );
    const mensajeId = mensajes[0]!.id;

    let ordinal = 0;
    for (const cita of citas) {
      ordinal += 1;
      try {
        await client.query(
          `INSERT INTO chat_message_references
             (organization_id, campaign_id, conversation_id, message_id, ordinal, source_id,
              fragment_id, snapshot_id, evidence_id, locator)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)`,
          [
            conversacion.organizationId,
            conversacion.campaignId,
            conversacion.id,
            mensajeId,
            ordinal,
            cita.sourceId,
            cita.fragmentId ?? null,
            cita.snapshotId ?? null,
            cita.evidenceId ?? null,
            cita.locator === undefined ? null : JSON.stringify(cita.locator),
          ],
        );
      } catch (error) {
        if (errorDeInsercion(error)) {
          throw new Abortar({
            code: 'VALIDATION_FAILED',
            message: 'Una cita apunta a una fuente, fragmento o evidencia que no pertenece a esta campaña.',
            details: { reason: CHAT_CONFLICT_REASONS.referenceScope, ordinal },
          });
        }
        throw error;
      }
    }

    const { rows } = await client.query<RunRow>(
      `UPDATE agent_runs SET status = 'completed', finished_at = now() WHERE id = $1 RETURNING ${CHAT_COLUMNAS_RUN}`,
      [runId],
    );
    const { rows: filas } = await client.query(
      `SELECT ${CHAT_COLUMNAS_MENSAJE} FROM chat_messages WHERE id = $1`,
      [mensajeId],
    );
    const [mensaje] = await chatEnriquecerMensajes(client, filas as never);
    return { run: chatComoRun(rows[0]!), message: mensaje! };
  }, CONFLICTO_RUN);
}

// ─────────────────────────── Reintentar ────────────────────────────────────────

/**
 * Reintenta el turno de un mensaje de usuario: nuevo run con attempt + 1. Solo si
 * no hay run activo, el intento anterior falló o se canceló (nunca si hubo uno
 * completado) y el mensaje sigue siendo el último de la conversación.
 */
export async function reintentarRun(
  actor: User,
  userMessageId: string,
  runConfig: AgentRunConfig,
): Promise<Result<AgentRun>> {
  const config = validarConfiguracionDeRun(runConfig);
  if (!config.ok) return config;
  const capacidad = assertCapability(actor, 'chat:write');
  if (!capacidad.ok) return capacidad;

  return transaccionConResultado(async (client) => {
    const { rows: mensajes } = await client
      .query<{
        id: string;
        conversation_id: string;
        role: string;
        seq: string;
      }>(`SELECT id, conversation_id, role, seq FROM chat_messages WHERE id = $1`, [userMessageId])
      .catch((error: unknown) => {
        if ((error as { code?: string }).code === '22P02') return { rows: [] as never[] };
        throw error;
      });
    const mensaje = mensajes[0];
    if (mensaje === undefined || mensaje.role !== 'user') throw new Abortar(CHAT_NO_ENCONTRADO);

    const cargada = await chatCargarConversacionAutorizada(
      client,
      actor,
      'chat:write',
      mensaje.conversation_id,
      true,
    );
    if (!cargada.ok) relanzar(cargada.error);
    const conversacion = cargada.value;
    if (conversacion.status === 'archived') {
      throw conflicto(CHAT_CONFLICT_REASONS.conversationArchived, 'La conversación está archivada.');
    }
    const estadoCampana = await chatEstadoDeCampana(
      client,
      conversacion.organizationId,
      conversacion.campaignId,
    );
    if (estadoCampana !== 'activa') {
      throw conflicto(CHAT_CONFLICT_REASONS.campaignNotActive, 'La campaña no está activa.', {
        status: estadoCampana,
      });
    }

    await chatCerrarRunsCaducados(client, { conversationId: conversacion.id });
    const { rows: activos } = await client.query<{ id: string }>(
      `SELECT id FROM agent_runs WHERE conversation_id = $1 AND status IN ('queued', 'running')`,
      [conversacion.id],
    );
    if (activos[0] !== undefined) {
      throw conflicto(CHAT_CONFLICT_REASONS.runInProgress, 'La conversación ya tiene un run activo.', {
        runId: activos[0].id,
      });
    }
    if (Number(mensaje.seq) !== conversacion.lastSeq) {
      throw conflicto(
        CHAT_CONFLICT_REASONS.messageNotLatest,
        'Solo se reintenta el último mensaje de la conversación.',
      );
    }
    const ultimo = await chatUltimoRunDeMensaje(client, userMessageId);
    if (ultimo === undefined || (ultimo.status !== 'failed' && ultimo.status !== 'cancelled')) {
      throw conflicto(
        CHAT_CONFLICT_REASONS.runNotRetryable,
        'Solo se reintenta un turno fallido o cancelado.',
        {
          status: ultimo?.status,
        },
      );
    }

    const nuevo = await chatInsertarRun(client, {
      organizationId: conversacion.organizationId,
      campaignId: conversacion.campaignId,
      conversationId: conversacion.id,
      userMessageId,
      userId: actor.id,
      attempt: ultimo.attempt + 1,
      config: config.value,
    });
    await recordAudit(client, {
      actor,
      action: 'agent_run.retry',
      entityType: 'agent_run',
      entityId: nuevo.id,
      metadata: { campaignId: nuevo.campaignId, attempt: nuevo.attempt, intentoAnterior: ultimo.id },
      correlation: { conversationId: conversacion.id, messageId: userMessageId, agentRunId: nuevo.id },
    });
    return nuevo;
  }, CONFLICTO_RUN);
}

// ─────────────────────────── ai_runs: costo por llamada ────────────────────────

export interface LlamadaDeModelo {
  /** Vuelta del modelo dentro del run (0, 1, 2…). */
  readonly stepIndex: number;
  readonly tier: ModelTier;
  readonly provider: string;
  readonly model: string;
  readonly promptVersion: string;
  /** SHA-256 de la entrada (no la entrada). */
  readonly inputHash: string;
  /** `ok` | `error` | …; mismo vocabulario que el worker. */
  readonly outputStatus: string;
  readonly latencyMs?: number | undefined;
  readonly promptTokens?: number | undefined;
  readonly completionTokens?: number | undefined;
  readonly costUsd?: number | undefined;
  readonly generationId?: string | undefined;
  readonly error?: string | undefined;
}

/**
 * Registra UNA llamada al proveedor del turno en `ai_runs` (tarea `conversar`),
 * enlazada al run. Nunca guarda el prompt ni la respuesta: solo hashes y metadatos.
 */
export async function registrarLlamadaDeModelo(
  actor: User,
  runId: string,
  llamada: LlamadaDeModelo,
): Promise<Result<{ aiRunId: string }>> {
  if (!Number.isInteger(llamada.stepIndex) || llamada.stepIndex < 0) {
    return err({
      code: 'VALIDATION_FAILED',
      message: 'La vuelta del modelo no es válida.',
      details: { field: 'stepIndex' },
    });
  }
  const cargado = await cargarRunAutorizado(getPool(), actor, 'chat:write', runId);
  if (!cargado.ok) return cargado;
  const run = cargado.value;
  const { rows } = await getPool().query<{ id: string }>(
    `INSERT INTO ai_runs
       (organization_id, campaign_id, task, tier, provider, model, prompt_version, input_hash,
        output_status, latency_ms, prompt_tokens, completion_tokens, cost_usd, generation_id, error,
        agent_run_id, step_index)
     VALUES ($1, $2, 'conversar', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
     RETURNING id`,
    [
      run.organizationId,
      run.campaignId,
      llamada.tier,
      llamada.provider,
      llamada.model,
      llamada.promptVersion,
      llamada.inputHash,
      llamada.outputStatus,
      llamada.latencyMs ?? null,
      llamada.promptTokens ?? null,
      llamada.completionTokens ?? null,
      llamada.costUsd ?? null,
      llamada.generationId ?? null,
      sanitizarMensajeDeError(llamada.error) ?? null,
      runId,
      llamada.stepIndex,
    ],
  );
  return ok({ aiRunId: rows[0]!.id });
}

export interface CostoDeRun {
  readonly llamadas: number;
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly costUsd: number;
}

/** Costo y tokens del turno: SUM por `agent_run_id` sobre `ai_runs`. */
export async function costoDeRun(actor: User, runId: string): Promise<Result<CostoDeRun>> {
  const cargado = await cargarRunAutorizado(getPool(), actor, 'chat:read', runId);
  if (!cargado.ok) return cargado;
  const { rows } = await getPool().query<{ n: string; p: string; c: string; u: string }>(
    `SELECT count(*) AS n, COALESCE(sum(prompt_tokens), 0) AS p, COALESCE(sum(completion_tokens), 0) AS c,
            COALESCE(sum(cost_usd), 0) AS u
       FROM ai_runs WHERE agent_run_id = $1 AND organization_id = $2`,
    [runId, cargado.value.organizationId],
  );
  const f = rows[0]!;
  return ok({
    llamadas: Number(f.n),
    promptTokens: Number(f.p),
    completionTokens: Number(f.c),
    costUsd: Number(f.u),
  });
}

export { cargarRunAutorizado as chatCargarRunAutorizado };
