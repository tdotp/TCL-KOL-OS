/**
 * Utilidades de las pruebas del runtime con BASE REAL (nunca se exportan desde el índice).
 */
import { randomUUID } from 'node:crypto';
import type { AgentRun, ChatMessage, User } from '@tcl-kol-os/domain';
import { crearConversacion, obtenerRun, query } from '@tcl-kol-os/db';
import type { ModelClient, ToolRegistry } from '../../contracts.ts';
import { type EnvReader, envDesdeObjeto } from '../../model/env.ts';
import { admitirTurno } from '../admitir-turno.ts';
import type { DependenciasDelRuntime } from '../ejecutar-run.ts';

export const SECRETO_DE_PRUEBA = 'secreto-de-pruebas-del-agente-0123456789';

export interface EntornoMutable {
  readonly valores: Record<string, string | undefined>;
  readonly env: EnvReader;
}

/** Entorno de pruebas con la IA ENCENDIDA; se puede mutar en mitad de un turno. */
export function entornoDePrueba(sobre: Record<string, string | undefined> = {}): EntornoMutable {
  const valores: Record<string, string | undefined> = {
    AI_ENABLED: 'true',
    AI_PROVIDER: 'fake',
    AI_MODEL_EQUILIBRADO: 'modelo-de-prueba/equilibrado',
    AGENT_NONCE_SECRET: SECRETO_DE_PRUEBA,
    ...sobre,
  };
  return { valores, env: envDesdeObjeto(valores) };
}

export function valor<T>(
  r: { ok: true; value: T } | { ok: false; error: { code: string; message: string } },
): T {
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
  return r.value;
}

export interface TurnoAdmitido {
  readonly conversationId: string;
  readonly mensaje: ChatMessage;
  readonly run: AgentRun;
}

let contador = 0;
export const claveDeMensaje = (): string =>
  `cm-${Date.now().toString(36)}-${(contador += 1)}-${randomUUID().slice(0, 8)}`;

export async function nuevaConversacion(actor: User, campaignId: string): Promise<string> {
  return valor(await crearConversacion(actor, { campaignId })).id;
}

/** Admite un turno (kill-switch encendido) y devuelve mensaje + run `queued`. */
export async function admitir(
  actor: User,
  conversationId: string,
  content: string,
  entorno: EntornoMutable,
  sourceIds?: string[],
): Promise<TurnoAdmitido> {
  const r = valor(
    await admitirTurno(
      actor,
      { conversationId, content, clientMessageId: claveDeMensaje(), sourceIds },
      { env: entorno.env },
    ),
  );
  return { conversationId, mensaje: r.message, run: r.run };
}

export function dependencias(
  model: ModelClient,
  registry: ToolRegistry,
  entorno: EntornoMutable,
  extra: Partial<DependenciasDelRuntime> = {},
): DependenciasDelRuntime {
  return { model, registry, env: entorno.env, registrar: () => undefined, ...extra };
}

export async function filaDelRun(actor: User, runId: string): Promise<AgentRun> {
  return valor(await obtenerRun(actor, runId));
}

export async function ledgerDelRun(runId: string) {
  return query<{
    step_index: number;
    task: string;
    tier: string;
    provider: string;
    model: string;
    prompt_version: string;
    input_hash: string;
    output_status: string;
    latency_ms: number | null;
    prompt_tokens: number | null;
    completion_tokens: number | null;
    cost_usd: string | null;
    generation_id: string | null;
    error: string | null;
  }>(
    `SELECT step_index, task, tier, provider, model, prompt_version, input_hash, output_status, latency_ms,
            prompt_tokens, completion_tokens, cost_usd, generation_id, error
       FROM ai_runs WHERE agent_run_id = $1 ORDER BY step_index, created_at`,
    [runId],
  );
}

export async function mensajesDeLaConversacion(conversationId: string) {
  return query<{ role: string; content: string; agent_run_id: string | null; seq: string }>(
    `SELECT role, content, agent_run_id, seq FROM chat_messages WHERE conversation_id = $1 ORDER BY seq`,
    [conversationId],
  );
}

export async function referenciasDeMensaje(messageId: string) {
  return query<{ source_id: string; fragment_id: string | null; ordinal: number }>(
    `SELECT source_id, fragment_id, ordinal FROM chat_message_references WHERE message_id = $1 ORDER BY ordinal`,
    [messageId],
  );
}

/** Serializa lo que el modelo recibió en una petición (mensajes + tools). */
export function loQueVioElModelo(peticion: { messages: unknown; tools: unknown }): string {
  return JSON.stringify({ messages: peticion.messages, tools: peticion.tools });
}
