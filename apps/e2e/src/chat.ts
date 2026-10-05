/**
 * Helpers de los E2E del chat (V2 · Fase 6, Wave 3).
 *
 * Igual que `fixtures.ts`: nunca SQL de dominio propio para CREAR cosas (se usan las funciones de
 * `packages/db`); las consultas de este archivo son SOLO LECTURAS de verificación sobre la base
 * `_test` aislada (candado de `candadoDeBaseDePrueba`).
 */
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, type Page } from '@playwright/test';
import { findUserByEmail, proponerAccion, query } from '@tcl-kol-os/db';
import type { User } from '@tcl-kol-os/domain';
import { candadoDeBaseDePrueba } from './fixtures';
import { gotoConReintento } from './nav';

export async function usuarioPorEmail(email: string): Promise<User> {
  candadoDeBaseDePrueba();
  const u = await findUserByEmail(email);
  if (!u) throw new Error(`Chat E2E: falta el usuario sembrado ${email}`);
  return u;
}

export const EMAILS = {
  admin: 'gerardo@smartpr.co',
  director: 'director@smartpr.co',
  consultor: 'consultor@smartpr.co',
  operativo: 'operativo@smartpr.co',
  cliente: 'marena@tcl.com',
  ajeno: 'ajeno@otraagencia.co',
} as const;

/** Texto fijo que devuelve el modelo falso cuando no hay marcador de tool (`fake_provider.py`). */
export const RESPUESTA_FAKE = 'Respuesta determinista del proveedor falso.';

/** Marcador que le pide una tool call al modelo falso: `[[fake:tool nombre {json}]]`. */
export function marcador(tool: string, args: Record<string, unknown> = {}): string {
  return `[[fake:tool ${tool} ${JSON.stringify(args)}]]`;
}

// ─────────────────────────── UI ────────────────────────────────────────────────

export async function abrirChat(page: Page, campaignId: string): Promise<void> {
  await gotoConReintento(page, `/campanas/${campaignId}/chat`);
  await expect(page.getByTestId('chat-page')).toBeVisible();
}

/** Escribe y envía; espera a que el composer se vacíe (señal de envío aceptado). */
export async function enviarMensaje(page: Page, texto: string): Promise<void> {
  const entrada = page.getByTestId('chat-input');
  await entrada.fill(texto);
  await expect(page.getByTestId('chat-send')).toBeEnabled();
  await page.getByTestId('chat-send').click();
  await expect(entrada).toHaveValue('', { timeout: 20_000 });
}

/** Espera a que haya al menos `n` mensajes del asistente visibles (el poller refresca solo). */
export async function esperarRespuestas(page: Page, n: number, timeout = 45_000): Promise<void> {
  try {
    await expect(page.locator('[data-testid="chat-message"][data-role="assistant"]')).toHaveCount(n, {
      timeout,
    });
  } catch (error) {
    // Diagnóstico: qué dejó el runtime en la base (código y mensaje saneados del run) si no hubo respuesta.
    const campaignId = /\/campanas\/([0-9a-f-]{36})\//.exec(page.url())?.[1];
    if (campaignId !== undefined) {
      const runs = await runsDe(campaignId);
      const detalle = runs
        .map((r) => `${r.status}/${r.error_code ?? '-'}/${r.error_message ?? '-'}`)
        .join(' | ');
      throw new Error(`${(error as Error).message}\n[diagnóstico] runs: ${detalle}`);
    }
    throw error;
  }
}

/** Espera a que el run termine: sin estado de cola/ejecución visible. */
export async function esperarSinRunActivo(page: Page, timeout = 45_000): Promise<void> {
  await expect(
    page.locator(
      '[data-testid="chat-run-status"][data-status="queued"], [data-testid="chat-run-status"][data-status="running"]',
    ),
  ).toHaveCount(0, { timeout });
}

// ─────────────────────────── Lecturas de verificación en BD ────────────────────

export interface FilaConversacion {
  readonly id: string;
  readonly created_by: string;
}

export async function conversacionesDe(campaignId: string): Promise<FilaConversacion[]> {
  candadoDeBaseDePrueba();
  return query<FilaConversacion>(`SELECT id, created_by FROM chat_conversations WHERE campaign_id = $1`, [
    campaignId,
  ]);
}

export async function contarConversaciones(campaignId: string): Promise<number> {
  return (await conversacionesDe(campaignId)).length;
}

export interface FilaMensaje {
  readonly id: string;
  readonly seq: string;
  readonly role: 'user' | 'assistant';
  readonly user_id: string;
  readonly content: string;
  readonly client_message_id: string | null;
}

export async function mensajesDe(campaignId: string): Promise<FilaMensaje[]> {
  candadoDeBaseDePrueba();
  return query<FilaMensaje>(
    `SELECT id, seq::text, role, user_id, content, client_message_id
       FROM chat_messages WHERE campaign_id = $1 ORDER BY conversation_id, seq`,
    [campaignId],
  );
}

export interface FilaRun {
  readonly id: string;
  readonly status: string;
  readonly attempt: number;
  readonly error_code: string | null;
  readonly error_message: string | null;
  readonly user_id: string;
}

export async function runsDe(campaignId: string): Promise<FilaRun[]> {
  candadoDeBaseDePrueba();
  return query<FilaRun>(
    `SELECT id, status, attempt, error_code, error_message, user_id FROM agent_runs WHERE campaign_id = $1 ORDER BY queued_at`,
    [campaignId],
  );
}

export interface FilaInvocacion {
  readonly id: string;
  readonly tool_name: string;
  readonly risk_class: string;
  readonly status: string;
  readonly error_code: string | null;
  readonly proposed_action_id: string | null;
}

export async function invocacionesDe(campaignId: string): Promise<FilaInvocacion[]> {
  candadoDeBaseDePrueba();
  return query<FilaInvocacion>(
    `SELECT id, tool_name, risk_class, status, error_code, proposed_action_id
       FROM agent_tool_invocations WHERE campaign_id = $1 ORDER BY created_at, sequence`,
    [campaignId],
  );
}

export interface FilaPropuesta {
  readonly id: string;
  readonly action_type: string;
  readonly status: string;
  readonly proposed_origin: string;
  readonly proposed_by: string | null;
  readonly confirmed_by: string | null;
  readonly resource_id: string;
  readonly correlation: Record<string, string> | null;
  readonly payload_hash: string;
}

export async function propuestasDe(campaignId: string): Promise<FilaPropuesta[]> {
  candadoDeBaseDePrueba();
  return query<FilaPropuesta>(
    `SELECT id, action_type, status, proposed_origin, proposed_by, confirmed_by, resource_id, correlation, payload_hash
       FROM proposed_actions WHERE campaign_id = $1 ORDER BY created_at`,
    [campaignId],
  );
}

export interface FilaAuditoria {
  readonly action: string;
  readonly origin: string | null;
  readonly actor_id: string | null;
  readonly entity_type: string;
  readonly entity_id: string | null;
  readonly correlation: Record<string, string> | null;
  readonly metadata: Record<string, unknown>;
  readonly created_at: string;
}

/** Eventos de auditoría de una propuesta y de la versión del brief que afecta, en orden cronológico. */
export async function auditoriaDe(actionId: string, versionId: string): Promise<FilaAuditoria[]> {
  candadoDeBaseDePrueba();
  return query<FilaAuditoria>(
    `SELECT action, origin, actor_id, entity_type, entity_id, correlation, metadata, created_at::text
       FROM audit_events
      WHERE entity_id IN ($1::uuid, $2::uuid)
         OR correlation->>'proposedActionId' = $3::text
      ORDER BY created_at, id`,
    [actionId, versionId, actionId],
  );
}

/** Auditoría de TODO lo que cuelga de la campaña (campaña, versiones del brief, fuentes, propuestas, conversaciones). */
export async function auditoriaDeCampana(campaignId: string): Promise<FilaAuditoria[]> {
  candadoDeBaseDePrueba();
  return query<FilaAuditoria>(
    `SELECT action, origin, actor_id, entity_type, entity_id, correlation, metadata, created_at::text
       FROM audit_events
      WHERE entity_id = $1::uuid
         OR entity_id IN (SELECT v.id FROM brief_versions v JOIN briefs b ON b.id = v.brief_id WHERE b.campaign_id = $1::uuid)
         OR entity_id IN (SELECT id FROM proposed_actions WHERE campaign_id = $1::uuid)
         OR entity_id IN (SELECT id FROM source_documents WHERE campaign_id = $1::uuid)
         OR correlation->>'conversationId' IN (SELECT id::text FROM chat_conversations WHERE campaign_id = $1::uuid)
      ORDER BY created_at, id`,
    [campaignId],
  );
}

export async function estadoDelBrief(versionId: string): Promise<string> {
  candadoDeBaseDePrueba();
  const [fila] = await query<{ status: string }>(
    `SELECT status::text AS status FROM brief_versions WHERE id = $1`,
    [versionId],
  );
  return fila!.status;
}

export async function contarTransicionesDeBrief(versionId: string, destino: string): Promise<number> {
  candadoDeBaseDePrueba();
  const [fila] = await query<{ n: number }>(
    `SELECT count(*)::int AS n FROM audit_events
      WHERE action = 'brief.transition' AND entity_id = $1 AND metadata->>'to' = $2`,
    [versionId, destino],
  );
  return fila!.n;
}

export async function fuentesDe(
  campaignId: string,
): Promise<{ id: string; filename: string; visibility: string; status: string }[]> {
  candadoDeBaseDePrueba();
  return query(
    `SELECT id, filename, visibility::text AS visibility, status::text AS status
       FROM source_documents WHERE campaign_id = $1 ORDER BY created_at`,
    [campaignId],
  );
}

// ─────────────────────────── Procesos auxiliares ───────────────────────────────

const RAIZ_WORKER = resolve(dirname(fileURLToPath(import.meta.url)), '../../../services/ai-worker');
const PYTHON = resolve(RAIZ_WORKER, '.venv/bin/python');

function envDelWorker(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    REDIS_URL: 'redis://127.0.0.1:6399',
    AI_ENABLED: 'true',
    AI_PROVIDER: 'fake',
    AI_MODEL_EFICIENTE: 'fake/eficiente',
    AI_MODEL_EQUILIBRADO: 'fake/equilibrado',
    AI_MODEL_AVANZADO: 'fake/avanzado',
    AI_MODEL_EMBEDDINGS: 'fake/embeddings',
    ENVIRONMENT: 'development',
    ...extra,
  };
}

/**
 * Procesa lo que haya en la cola documental (`worker.py --once`): el mismo consumidor real que
 * corre en producción, de forma determinista (sin depender de un proceso de fondo).
 */
export async function procesarColaDeDocumentos(): Promise<void> {
  candadoDeBaseDePrueba();
  await new Promise<void>((ok, fallo) => {
    execFile(
      PYTHON,
      ['worker.py', '--once'],
      { cwd: RAIZ_WORKER, env: envDelWorker(), timeout: 60_000 },
      (error, _stdout, stderr) => {
        if (error) fallo(new Error(`worker.py --once falló: ${error.message}\n${stderr.slice(-800)}`));
        else ok();
      },
    );
  });
}

/** Arranca un worker de modelo (uvicorn) en `puerto` y espera su `/health`. Devuelve el proceso. */
export async function arrancarWorkerDeModelo(puerto: number): Promise<ChildProcess> {
  candadoDeBaseDePrueba();
  const proceso = spawn(
    PYTHON,
    ['-m', 'uvicorn', 'app.main:app', '--host', '127.0.0.1', '--port', String(puerto)],
    { cwd: RAIZ_WORKER, env: envDelWorker(), stdio: 'ignore' },
  );
  const limite = Date.now() + 30_000;
  for (;;) {
    try {
      const r = await fetch(`http://127.0.0.1:${puerto}/health`);
      if (r.ok) return proceso;
    } catch {
      // todavía arrancando
    }
    if (Date.now() > limite) {
      proceso.kill('SIGKILL');
      throw new Error('Chat E2E: el worker de modelo no arrancó en 30 s.');
    }
    await new Promise((r) => setTimeout(r, 250));
  }
}

export function detenerProceso(proceso: ChildProcess | undefined): void {
  if (proceso !== undefined && proceso.exitCode === null) proceso.kill('SIGKILL');
}

// ─────────────────────────── Propuestas (HITL) ─────────────────────────────────

/**
 * Propuesta de aprobar el brief con una VIGENCIA corta, por el caso de uso real `proponerAccion` (origen
 * `chat`, correlacionada con la conversación). La herramienta del agente no permite elegir la vigencia, y
 * `expires_at` es inmutable en la base: esta es la forma honesta de probar «propuesta vencida».
 */
export async function proponerAprobacionConVigencia(
  actor: User,
  campaignId: string,
  versionId: string,
  conversationId: string,
  ttlSegundos: number,
): Promise<string> {
  candadoDeBaseDePrueba();
  const r = await proponerAccion(actor, {
    type: 'brief.approve',
    resourceId: versionId,
    origin: 'chat',
    campaignId,
    correlation: { conversationId },
    ttlSegundos,
  });
  if (!r.ok) throw new Error(`Chat E2E: no se pudo proponer — ${r.error.message}`);
  return r.value.id;
}

/** Espera (por observación de la base, no por un sleep fijo) a que la propuesta haya vencido. */
export async function esperarVencimiento(actionId: string, timeoutMs = 20_000): Promise<void> {
  candadoDeBaseDePrueba();
  const limite = Date.now() + timeoutMs;
  for (;;) {
    const [fila] = await query<{ vencida: boolean }>(
      `SELECT expires_at <= now() AS vencida FROM proposed_actions WHERE id = $1`,
      [actionId],
    );
    if (fila?.vencida === true) return;
    if (Date.now() > limite) throw new Error('Chat E2E: la propuesta no venció a tiempo.');
    await new Promise((r) => setTimeout(r, 250));
  }
}

/**
 * Cambia el contenido del brief DESPUÉS de proponer, como lo haría una edición concurrente: la huella de
 * contenido guardada en la propuesta deja de corresponder (la propuesta queda obsoleta).
 */
export async function alterarContenidoDelBrief(versionId: string): Promise<void> {
  candadoDeBaseDePrueba();
  const filas = await query<{ id: string }>(
    `UPDATE brief_fields SET value = to_jsonb('Contenido alterado tras proponer (E2E)'::text), revision = revision + 1
      WHERE id = (SELECT id FROM brief_fields WHERE brief_version_id = $1 AND campaign_product_id IS NULL
                   ORDER BY key LIMIT 1)
      RETURNING id`,
    [versionId],
  );
  if (filas.length !== 1) throw new Error('Chat E2E: no se pudo alterar el contenido del brief.');
}

/** Campaña desechable con su brief ya en `internal_review` (lista para proponer su aprobación). */
export async function campanaEnRevision(
  etiqueta: string,
): Promise<{ campaignId: string; versionId: string }> {
  const { nuevaCampanaConBrief, completarHastaInternalReview, cargarActores } = await import('./fixtures');
  const { admin } = await cargarActores();
  const { campaignId, versionId } = await nuevaCampanaConBrief(admin, etiqueta);
  await completarHastaInternalReview(admin, campaignId, versionId);
  return { campaignId, versionId };
}
