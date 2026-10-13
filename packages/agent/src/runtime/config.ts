/**
 * Configuración del runtime a partir del entorno (inyectable) y del catálogo.
 *
 * Variables:
 *  · `AI_ENABLED`            kill-switch (D8). Mismo criterio que el worker
 *                            (`modelo_turno.ia_activa`): solo 1/true/yes (sin distinguir
 *                            mayúsculas) lo enciende; sin definir = APAGADO.
 *  · `AGENT_MAX_TOOL_STEPS`  vueltas del modelo por turno (8; tope duro 15).
 *  · `AGENT_RUN_DEADLINE_S`  plazo del run completo (180).
 *  · `AGENT_MODEL_TIMEOUT_S` plazo de UNA llamada de modelo, que se pide al worker (45).
 *  · `AGENT_MAX_TOKENS`      tokens máximos de salida por llamada (2048).
 *  · `AGENT_NONCE_SECRET`    secreto del nonce de los sobres (cae a `SESSION_SECRET`;
 *                            solo en desarrollo hay un valor por defecto, como la sesión).
 *  · `AI_PROVIDER` / `AI_MODEL_EQUILIBRADO`  SOLO para registrar en `agent_runs` con qué
 *                            configuración se admitió el turno. La verdad por llamada es la
 *                            que devuelve el worker (ledger en `ai_runs`).
 */
import {
  type AgentRunConfig,
  type ModelTier,
  CONTEXT_ASSEMBLER_VERSION,
  CONTEXT_BUDGET_VERSION,
  CONTEXT_POLICY_VERSION,
  iaActiva,
  secretoDelNonce,
  tierFor,
} from '@tcl-kol-os/domain';
import { type EnvReader, enteroDeEnv } from '../model/env.ts';
import { MAX_TOOL_CALLS_POR_PASO } from '../model/worker-model-client.ts';
import { PROMPT_VERSION } from '../prompts/agente-cuenta.ts';

export const MAX_TOOL_STEPS_POR_DEFECTO = 8;
export const MAX_TOOL_STEPS_TOPE_DURO = 15;
export const DEADLINE_DEL_RUN_POR_DEFECTO_S = 180;
export const TIMEOUT_DE_MODELO_POR_DEFECTO_S = 45;
export const MAX_TOKENS_POR_DEFECTO = 2_048;
/** Contrato de la tool: el resultado que vuelve al modelo no pasa de 16 KB. */
export const MAX_CARACTERES_DE_RESULTADO = 16_384;

export interface LimitesDelRun {
  readonly maxSteps: number;
  readonly deadlineMs: number;
  readonly maxToolCallsPorPaso: number;
  readonly modelTimeoutMs: number;
  readonly maxTokens: number;
}

/** Límites efectivos. Los topes duros no se pueden superar ni por entorno ni por parámetro. */
export function limitesDesdeEnv(env: EnvReader): LimitesDelRun {
  return {
    maxSteps: enteroDeEnv(env, 'AGENT_MAX_TOOL_STEPS', MAX_TOOL_STEPS_POR_DEFECTO, {
      min: 1,
      max: MAX_TOOL_STEPS_TOPE_DURO,
    }),
    deadlineMs:
      enteroDeEnv(env, 'AGENT_RUN_DEADLINE_S', DEADLINE_DEL_RUN_POR_DEFECTO_S, { min: 5, max: 900 }) * 1_000,
    maxToolCallsPorPaso: MAX_TOOL_CALLS_POR_PASO,
    modelTimeoutMs:
      enteroDeEnv(env, 'AGENT_MODEL_TIMEOUT_S', TIMEOUT_DE_MODELO_POR_DEFECTO_S, { min: 1, max: 120 }) *
      1_000,
    maxTokens: enteroDeEnv(env, 'AGENT_MAX_TOKENS', MAX_TOKENS_POR_DEFECTO, { min: 16, max: 16_000 }),
  };
}

/** Aplica sobreescrituras respetando los topes duros. */
export function acotarLimites(
  base: LimitesDelRun,
  parcial: Partial<LimitesDelRun> | undefined,
): LimitesDelRun {
  const l = { ...base, ...(parcial ?? {}) };
  return {
    ...l,
    maxSteps: Math.min(Math.max(Math.trunc(l.maxSteps), 1), MAX_TOOL_STEPS_TOPE_DURO),
    maxToolCallsPorPaso: Math.min(Math.max(Math.trunc(l.maxToolCallsPorPaso), 1), MAX_TOOL_CALLS_POR_PASO),
  };
}

/** Kill-switch (D8) y secreto del nonce: una sola implementación, en el dominio (paridad con el worker). */
export { iaActiva, secretoDelNonce };

/**
 * Configuración con la que se admite un run. Procedencia (verificable):
 *  · `tier`: catálogo del dominio (`tierFor('conversar')`), nunca el entorno.
 *  · `model`: `AI_MODEL_<TIER>` del entorno del servidor web; si no está definido se
 *    registra `no-configurado-en-web` (el modelo real lo decide el worker y queda en
 *    cada fila del ledger `ai_runs`).
 *  · `provider`: `fake` si `AI_PROVIDER=fake` (mismo selector que el worker); en otro
 *    caso `openrouter`.
 *  · `promptVersion`/`contextVersion`: constantes versionadas del código.
 */
export function configuracionDeRun(env: EnvReader): AgentRunConfig {
  const tier: ModelTier = tierFor('conversar');
  const modelo = (env(`AI_MODEL_${tier.toUpperCase()}`) ?? '').trim();
  return {
    provider: (env('AI_PROVIDER') ?? '').trim().toLowerCase() === 'fake' ? 'fake' : 'openrouter',
    model: modelo === '' ? 'no-configurado-en-web' : modelo.slice(0, 200),
    tier,
    promptVersion: PROMPT_VERSION,
    contextVersion: `${CONTEXT_ASSEMBLER_VERSION}.${CONTEXT_BUDGET_VERSION}.${CONTEXT_POLICY_VERSION}`,
  };
}
