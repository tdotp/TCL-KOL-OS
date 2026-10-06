/**
 * Contratos compartidos del agente de Cuenta (V2 · Fase 6).
 *
 * Este archivo es la frontera entre las dos superficies del paquete:
 *   - `tools/**`   → registro y ejecución de tools (adaptadores sobre casos de uso).
 *   - `runtime/**` → bucle del agente, cliente de modelo, prompts.
 * El runtime solo conoce `ToolRegistry`; las tools no conocen el bucle.
 *
 * Invariantes (ARQUITECTURA-F6-CONGELADA §7):
 *   - El modelo jamás aporta `campaignId`, `organizationId`, actor, origen ni canal.
 *   - El agente actúa como la persona (`origin = 'chat'`), nunca como `system`.
 *   - Aprobar, confirmar y ejecutar acciones propuestas no existen para el agente.
 *   - Nada de chain-of-thought en ningún contrato.
 */
import type { RegistroDeReferencias, ToolRiskClass, User } from '@tcl-kol-os/domain';

// ---------------------------------------------------------------------------
// Modelo
// ---------------------------------------------------------------------------

/** Definición de tool tal como se envía al modelo (JSON Schema cerrado). */
export interface ModelToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly parameters: Readonly<Record<string, unknown>>;
}

export interface ModelToolCall {
  readonly id: string;
  readonly name: string;
  /** Ya parseado como objeto JSON por el worker; sin validar contra el schema. */
  readonly arguments: Readonly<Record<string, unknown>>;
}

export type ModelMessage =
  | { readonly role: 'system'; readonly content: string }
  | { readonly role: 'user'; readonly content: string }
  | {
      readonly role: 'assistant';
      readonly content?: string | null;
      readonly toolCalls?: readonly ModelToolCall[];
    }
  | { readonly role: 'tool'; readonly toolCallId: string; readonly content: string };

export interface ModelTurnRequest {
  readonly messages: readonly ModelMessage[];
  readonly tools: readonly ModelToolDefinition[];
  readonly toolChoice?: 'auto' | 'none' | 'required';
  readonly maxTokens?: number;
  readonly timeoutMs?: number;
  /** Ids opacos solo para logs del worker; no viajan al proveedor. */
  readonly correlation?: {
    readonly conversationId?: string;
    readonly agentRunId?: string;
    readonly stepIndex?: number;
  };
}

export interface ModelTurnResponse {
  readonly kind: 'final' | 'tool_calls';
  /** Texto final (`kind = 'final'`); `null` con tool calls (el preámbulo se descarta). */
  readonly content: string | null;
  readonly toolCalls: readonly ModelToolCall[];
  readonly finishReason: 'stop' | 'tool_calls' | 'length' | 'content_filter' | 'other';
  readonly provider: string;
  readonly model: string;
  readonly tier: string;
  readonly usage: {
    readonly promptTokens: number;
    readonly completionTokens: number;
    readonly totalTokens: number;
    readonly costUsd: number | null;
  };
  readonly latencyMs: number;
  readonly generationId: string | null;
}

/** Taxonomía estable del endpoint `POST /modelo/turno` del worker (+ errores locales). */
export type ModelErrorCode =
  | 'AI_DISABLED'
  | 'MODEL_TIMEOUT'
  | 'MODEL_RATE_LIMITED'
  | 'MODEL_UPSTREAM_ERROR'
  | 'MODEL_BAD_RESPONSE'
  | 'MODEL_CONTEXT_TOO_LARGE'
  | 'MODEL_NOT_CONFIGURED'
  | 'REQUEST_INVALID'
  | 'INTERNAL_ERROR'
  | 'WORKER_UNREACHABLE'
  | 'ABORTED';

export class ModelError extends Error {
  readonly code: ModelErrorCode;
  readonly retryable: boolean;
  readonly retryAfterS: number | null;
  constructor(code: ModelErrorCode, retryable: boolean, retryAfterS: number | null = null) {
    // El mensaje es fijo: nunca incluye contenido del proveedor ni de mensajes.
    super(`Error del modelo: ${code}`);
    this.name = 'ModelError';
    this.code = code;
    this.retryable = retryable;
    this.retryAfterS = retryAfterS;
  }
}

/** Una sola llamada de modelo, sin estado. Implementaciones: `WorkerModelClient`, `ScriptedModel`. */
export interface ModelClient {
  turn(request: ModelTurnRequest, signal?: AbortSignal): Promise<ModelTurnResponse>;
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

/** Identidad de ejecución de un turno. Todo lo decide el runtime, nunca el modelo. */
export interface ToolRunContext {
  /** Actor releído de la BD por el runtime en cada paso (activo, misma organización). */
  readonly actor: User;
  readonly campaignId: string;
  readonly conversationId: string;
  /** Mensaje del usuario que originó el run. */
  readonly messageId: string;
  readonly agentRunId: string;
  readonly stepIndex: number;
  /** Registro de alias (S1, F3…) del run; el modelo cita alias, nunca ids crudos. */
  readonly referencias: RegistroDeReferencias;
  /** Textos de mensajes del ACTOR en esta conversación (base del grounding literal, D11). */
  readonly textosDelActor: readonly string[];
  /**
   * Texto EXACTO del mensaje en curso (el que originó el run), tal como está guardado. Base del
   * grounding reforzado `currentMessageQuote` (F7): un comentario o un cambio solicitado debe ser
   * subcadena exacta de ESTE mensaje, no de uno anterior ni del asistente.
   */
  readonly messageText: string;
  /**
   * `source_id` de los adjuntos de mensajes del ACTOR en la ventana de la conversación (F7). Sin
   * esto, un documento podría hacer que el modelo registrara como guion cualquier fuente legible.
   */
  readonly adjuntosDelActor: readonly string[];
  /**
   * Mensajes del ACTOR que traen adjuntos (texto + fuentes), en orden cronológico (F7). Permite saber
   * cuántos archivos acompañaban a la frase en la que la persona nombró al influencer.
   */
  readonly adjuntosPorMensaje: readonly { readonly texto: string; readonly sourceIds: readonly string[] }[];
  readonly signal?: AbortSignal;
}

export interface ToolCallRequest {
  /** Id de la llamada que devolvió el modelo. */
  readonly id: string;
  readonly name: string;
  /** Argumentos tal como los pidió el modelo (sin confiar en ellos). */
  readonly arguments: unknown;
}

export type ToolExecutionStatus = 'succeeded' | 'failed' | 'cancelled';

export interface ToolExecution {
  /** Texto (JSON acotado) que vuelve al modelo como mensaje `tool`. Nunca > 16 KB. */
  readonly content: string;
  readonly status: ToolExecutionStatus;
  /** Identificador estable en MAYÚSCULAS o código de dominio cuando `status = 'failed'`. */
  readonly errorCode?: string;
  readonly riskClass: ToolRiskClass;
  /** Propuesta HITL que dejó la tool (solo tools de confirmación requerida). */
  readonly proposedActionId?: string;
  /** Id de la fila `agent_tool_invocations` (para la traza y la UI). */
  readonly invocationId?: string;
}

/**
 * Registro de tools del agente. El runtime solo necesita esto:
 *   - qué tools ofrecer al modelo con el rol ACTUAL del actor;
 *   - ejecutar una llamada con todo el pipeline de seguridad (existe → schema →
 *     actor/campaña → capability → riesgo/cuota/grounding → claim de idempotencia →
 *     caso de uso → proyección acotada → cierre de la invocación).
 * `execute` nunca lanza por errores esperables: devuelve `ToolExecution` fallida.
 */
export interface ToolRegistry {
  /** Huella del catálogo completo (versión de prompts/tools para `agent_runs`). */
  readonly catalogHash: string;
  definitionsFor(actor: User): readonly ModelToolDefinition[];
  execute(call: ToolRunCall): Promise<ToolExecution>;
}

export interface ToolRunCall {
  readonly context: ToolRunContext;
  readonly call: ToolCallRequest;
}
