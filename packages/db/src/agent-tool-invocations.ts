/**
 * Invocaciones de tools del agente (V2 · Fase 6).
 *
 * Una fila por cada llamada de tool dentro de un run. Es el CLAIM de idempotencia
 * (`UNIQUE (agent_run_id, idempotency_key)`): el caso de uso que ejecuta la tool
 * abre su propia transacción, así que el efecto y el cierre de la invocación NO son
 * atómicos. Si el proceso cae en medio, la fila queda `running` (la cierra el
 * barrido de abandonados) y `audit_events.correlation->>'toolInvocationId'` dice si
 * hubo efecto; la clave impide ejecutar dos veces la misma llamada.
 *
 *   reclamarInvocacion → (la tool ejecuta su caso de uso con origin 'chat' y
 *   correlation.toolInvocationId = invocation.id) → cerrarInvocacion
 *
 * Este módulo NO ejecuta tools ni conoce el catálogo: solo registra el rastro.
 * `args` y `result` se sanitizan (secretos redactados, razonamiento descartado,
 * profundidad y tamaño acotados): ids, conteos y referencias a efectos; nunca texto
 * de documentos.
 */

import type { PoolClient } from 'pg';
import {
  type Result,
  type ToolInvocation,
  type ToolInvocationStatus,
  type ToolRiskClass,
  type User,
  CHAT_CONFLICT_REASONS,
  TOOL_RISK_CLASSES,
  claveDeInvocacion,
  err,
  esCodigoDeErrorValido,
  ok,
  sanitizarArgsDeTool,
  sanitizarResultadoDeTool,
} from '@tcl-kol-os/domain';
import {
  chatCanonico,
  chatIso,
  chatSha256,
  CHAT_NO_ENCONTRADO,
  chatCargarConversacionAutorizada,
} from './chat-conversations.ts';
import { chatCargarRun } from './agent-runs.ts';
import { getPool } from './client.ts';
import { Abortar, transaccionConResultado } from './tx-result.ts';

export interface ChatInvocacionRow {
  readonly id: string;
  readonly organization_id: string;
  readonly campaign_id: string;
  readonly agent_run_id: string;
  readonly sequence: number;
  readonly step_index: number;
  readonly tool_call_id: string | null;
  readonly tool_name: string;
  readonly risk_class: ToolRiskClass;
  readonly args: Record<string, unknown>;
  readonly args_sha256: string;
  readonly status: ToolInvocationStatus;
  readonly result: Record<string, unknown> | null;
  readonly error_code: string | null;
  readonly idempotency_key: string;
  readonly proposed_action_id: string | null;
  readonly started_at: Date;
  readonly finished_at: Date | null;
}

export const CHAT_COLUMNAS_INVOCACION = `id, organization_id, campaign_id, agent_run_id, sequence, step_index, tool_call_id, tool_name,
  risk_class, args, args_sha256, status, result, error_code, idempotency_key, proposed_action_id, started_at,
  finished_at`;

export function chatComoInvocacion(r: ChatInvocacionRow): ToolInvocation {
  return {
    id: r.id,
    organizationId: r.organization_id,
    campaignId: r.campaign_id,
    agentRunId: r.agent_run_id,
    sequence: r.sequence,
    stepIndex: r.step_index,
    toolCallId: r.tool_call_id ?? undefined,
    toolName: r.tool_name,
    riskClass: r.risk_class,
    args: r.args,
    argsSha256: r.args_sha256,
    status: r.status,
    result: r.result ?? undefined,
    errorCode: r.error_code ?? undefined,
    idempotencyKey: r.idempotency_key,
    proposedActionId: r.proposed_action_id ?? undefined,
    startedAt: r.started_at.toISOString(),
    finishedAt: chatIso(r.finished_at),
  };
}

const CONFLICTO_INVOCACION = {
  code: 'RESOURCE_CONFLICT',
  message: 'La invocación cambió mientras se procesaba la operación. Reintente.',
} as const;

export interface ReclamarInvocacionInput {
  /** Vuelta del modelo que pidió la tool (0, 1, 2…). */
  readonly stepIndex: number;
  /** Id de la llamada que devolvió el proveedor, si lo hay. */
  readonly toolCallId?: string | undefined;
  readonly toolName: string;
  /** La fija el registro de tools, nunca el modelo. */
  readonly riskClass: ToolRiskClass;
  /** Argumentos tal como los pidió el modelo (se sanitizan antes de persistir). */
  readonly args: unknown;
  /** Por defecto se deriva de `stepIndex` + `toolCallId` (o tool + huella de args). */
  readonly idempotencyKey?: string | undefined;
}

export interface InvocacionReclamada {
  readonly invocation: ToolInvocation;
  /**
   * `true` = esta llamada obtuvo el claim y debe ejecutar la tool. `false` = ya existía
   * (replay): si está `succeeded` se reutiliza su resultado; si está `running`, otro
   * ejecutor la tiene — no se ejecuta de nuevo.
   */
  readonly claimed: boolean;
}

/**
 * Abre (claim) la invocación de una tool dentro de un run `running`. Idempotente por
 * clave. Bloquea el run mientras asigna la secuencia.
 */
export async function reclamarInvocacion(
  actor: User,
  runId: string,
  input: ReclamarInvocacionInput,
): Promise<Result<InvocacionReclamada>> {
  if (
    !Number.isInteger(input.stepIndex) ||
    input.stepIndex < 0 ||
    typeof input.toolName !== 'string' ||
    input.toolName.trim() === '' ||
    input.toolName.length > 100 ||
    !(TOOL_RISK_CLASSES as readonly string[]).includes(input.riskClass)
  ) {
    return err({
      code: 'VALIDATION_FAILED',
      message: 'La invocación de tool no es válida.',
      details: { field: 'tool' },
    });
  }
  const args = sanitizarArgsDeTool(input.args);
  const argsSha256 = chatSha256(chatCanonico(args.valor));
  const idempotencyKey =
    input.idempotencyKey ??
    claveDeInvocacion({
      stepIndex: input.stepIndex,
      toolName: input.toolName,
      toolCallId: input.toolCallId,
      argsSha256,
    });
  if (idempotencyKey.trim() === '' || idempotencyKey.length > 200) {
    return err({
      code: 'VALIDATION_FAILED',
      message: 'La clave de idempotencia no es válida.',
      details: { field: 'idempotencyKey' },
    });
  }

  return transaccionConResultado(async (client) => {
    const previo = await chatCargarRun(client, runId);
    if (previo === undefined) throw new Abortar(CHAT_NO_ENCONTRADO);
    const conv = await chatCargarConversacionAutorizada(client, actor, 'chat:write', previo.conversationId);
    if (!conv.ok)
      throw new Abortar({ code: conv.error.code, message: conv.error.message, details: conv.error.details });

    // El run se bloquea para serializar la asignación de `sequence`.
    const { rows: runs } = await client.query<{
      status: string;
      organization_id: string;
      campaign_id: string;
    }>(`SELECT status, organization_id, campaign_id FROM agent_runs WHERE id = $1 FOR UPDATE`, [runId]);
    const run = runs[0]!;

    const { rows: existentes } = await client.query<ChatInvocacionRow>(
      `SELECT ${CHAT_COLUMNAS_INVOCACION} FROM agent_tool_invocations
        WHERE agent_run_id = $1 AND (idempotency_key = $2 OR ($3::text IS NOT NULL AND tool_call_id = $3))`,
      [runId, idempotencyKey, input.toolCallId ?? null],
    );
    if (existentes[0] !== undefined) return { invocation: chatComoInvocacion(existentes[0]), claimed: false };

    if (run.status !== 'running') {
      throw new Abortar({
        code: 'RESOURCE_CONFLICT',
        message: 'Solo un run en ejecución abre invocaciones de tools.',
        details: { reason: CHAT_CONFLICT_REASONS.runNotRunning, status: run.status },
      });
    }
    const { rows: siguiente } = await client.query<{ n: number }>(
      `SELECT COALESCE(max(sequence), 0) + 1 AS n FROM agent_tool_invocations WHERE agent_run_id = $1`,
      [runId],
    );
    const { rows } = await client.query<ChatInvocacionRow>(
      `INSERT INTO agent_tool_invocations
         (organization_id, campaign_id, agent_run_id, sequence, step_index, tool_call_id, tool_name,
          risk_class, args, args_sha256, idempotency_key)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11)
       RETURNING ${CHAT_COLUMNAS_INVOCACION}`,
      [
        run.organization_id,
        run.campaign_id,
        runId,
        siguiente[0]!.n,
        input.stepIndex,
        input.toolCallId ?? null,
        input.toolName,
        input.riskClass,
        JSON.stringify(args.valor),
        argsSha256,
        idempotencyKey,
      ],
    );
    return { invocation: chatComoInvocacion(rows[0]!), claimed: true };
  }, CONFLICTO_INVOCACION);
}

export interface CerrarInvocacionInput {
  readonly status: Exclude<ToolInvocationStatus, 'running'>;
  /** Solo con `succeeded`: ids, conteos y referencias a efectos (se sanitiza y acota). */
  readonly result?: unknown;
  /** Obligatorio con `failed` (identificador en MAYÚSCULAS). */
  readonly errorCode?: string | undefined;
  /** Solo en tools de confirmación requerida: la propuesta HITL que dejó. */
  readonly proposedActionId?: string | undefined;
}

/** `running → succeeded | failed | cancelled`. Una invocación terminada no se reescribe. */
export async function cerrarInvocacion(
  actor: User,
  invocationId: string,
  input: CerrarInvocacionInput,
): Promise<Result<ToolInvocation>> {
  if (input.status === 'failed' && !esCodigoDeErrorValido(input.errorCode)) {
    return err({
      code: 'VALIDATION_FAILED',
      message: 'Una invocación fallida declara su código de error.',
      details: { field: 'errorCode' },
    });
  }
  if (input.status !== 'failed' && input.errorCode !== undefined) {
    return err({
      code: 'VALIDATION_FAILED',
      message: 'Solo una invocación fallida lleva código de error.',
      details: { field: 'errorCode' },
    });
  }
  if (input.status !== 'succeeded' && (input.result !== undefined || input.proposedActionId !== undefined)) {
    return err({
      code: 'VALIDATION_FAILED',
      message: 'Solo una invocación exitosa lleva resultado.',
      details: { field: 'result' },
    });
  }
  const resultado = input.result === undefined ? undefined : sanitizarResultadoDeTool(input.result);

  return transaccionConResultado(async (client: PoolClient) => {
    const { rows: previas } = await client
      .query<ChatInvocacionRow>(
        `SELECT ${CHAT_COLUMNAS_INVOCACION} FROM agent_tool_invocations WHERE id = $1`,
        [invocationId],
      )
      .catch((error: unknown) => {
        if ((error as { code?: string }).code === '22P02') return { rows: [] as ChatInvocacionRow[] };
        throw error;
      });
    if (previas[0] === undefined) throw new Abortar(CHAT_NO_ENCONTRADO);
    const run = await chatCargarRun(client, previas[0].agent_run_id);
    if (run === undefined) throw new Abortar(CHAT_NO_ENCONTRADO);
    const conv = await chatCargarConversacionAutorizada(client, actor, 'chat:write', run.conversationId);
    if (!conv.ok)
      throw new Abortar({ code: conv.error.code, message: conv.error.message, details: conv.error.details });

    const { rows: bloqueadas } = await client.query<ChatInvocacionRow>(
      `SELECT ${CHAT_COLUMNAS_INVOCACION} FROM agent_tool_invocations WHERE id = $1 FOR UPDATE`,
      [invocationId],
    );
    const actual = bloqueadas[0]!;
    if (actual.status !== 'running') {
      throw new Abortar({
        code: 'RESOURCE_CONFLICT',
        message: 'La invocación ya terminó.',
        details: { reason: CHAT_CONFLICT_REASONS.toolAlreadyClaimed, status: actual.status },
      });
    }
    if (input.proposedActionId !== undefined && actual.risk_class !== 'confirmation_required') {
      throw new Abortar({
        code: 'VALIDATION_FAILED',
        message: 'Solo una tool de confirmación requerida enlaza una acción propuesta.',
        details: { field: 'proposedActionId' },
      });
    }
    try {
      const { rows } = await client.query<ChatInvocacionRow>(
        `UPDATE agent_tool_invocations
            SET status = $2, result = $3::jsonb, error_code = $4, proposed_action_id = $5, finished_at = now()
          WHERE id = $1
          RETURNING ${CHAT_COLUMNAS_INVOCACION}`,
        [
          invocationId,
          input.status,
          resultado === undefined ? null : JSON.stringify(resultado.valor),
          input.errorCode ?? null,
          input.proposedActionId ?? null,
        ],
      );
      return chatComoInvocacion(rows[0]!);
    } catch (error) {
      const codigo = (error as { code?: string }).code;
      if (codigo === '23503' || codigo === '22P02') {
        throw new Abortar({
          code: 'VALIDATION_FAILED',
          message: 'La acción propuesta no existe en esta campaña.',
          details: { field: 'proposedActionId' },
        });
      }
      throw error;
    }
  }, CONFLICTO_INVOCACION);
}

/** Las invocaciones de un run propio, en orden. */
export async function listarInvocacionesDeRun(actor: User, runId: string): Promise<Result<ToolInvocation[]>> {
  const run = await chatCargarRun(getPool(), runId);
  if (run === undefined) return err(CHAT_NO_ENCONTRADO);
  const conv = await chatCargarConversacionAutorizada(getPool(), actor, 'chat:read', run.conversationId);
  if (!conv.ok) return conv;
  const { rows } = await getPool().query<ChatInvocacionRow>(
    `SELECT ${CHAT_COLUMNAS_INVOCACION} FROM agent_tool_invocations WHERE agent_run_id = $1 ORDER BY sequence`,
    [runId],
  );
  return ok(rows.map(chatComoInvocacion));
}

/** Una invocación por id (de un run propio). */
export async function obtenerInvocacion(actor: User, invocationId: string): Promise<Result<ToolInvocation>> {
  const { rows } = await getPool()
    .query<ChatInvocacionRow>(
      `SELECT ${CHAT_COLUMNAS_INVOCACION} FROM agent_tool_invocations WHERE id = $1`,
      [invocationId],
    )
    .catch((error: unknown) => {
      if ((error as { code?: string }).code === '22P02') return { rows: [] as ChatInvocacionRow[] };
      throw error;
    });
  if (rows[0] === undefined) return err(CHAT_NO_ENCONTRADO);
  const run = await chatCargarRun(getPool(), rows[0].agent_run_id);
  if (run === undefined) return err(CHAT_NO_ENCONTRADO);
  const conv = await chatCargarConversacionAutorizada(getPool(), actor, 'chat:read', run.conversationId);
  if (!conv.ok) return conv;
  return ok(chatComoInvocacion(rows[0]));
}
