/**
 * `ScriptedModel`: cliente de modelo con guion para pruebas (y para el humo sin
 * proveedor). Cada llamada consume la siguiente entrada del guion:
 *   · una respuesta (`respuestaFinal` / `respuestaConTools`),
 *   · un fallo (`fallo(...)`), que se lanza como `ModelError`,
 *   · o una función `(request, indice) => entrada`, para efectos laterales
 *     (cancelar el run, revocar un permiso, apagar la IA, avanzar el reloj…).
 *
 * Graba una COPIA de cada petición recibida (`requests`) para aserciones: lo que
 * el modelo vio queda congelado aunque quien llama mute el arreglo después.
 */
import {
  type ModelClient,
  type ModelErrorCode,
  type ModelToolCall,
  type ModelTurnRequest,
  type ModelTurnResponse,
  ModelError,
} from '../contracts.ts';

export type EntradaDeGuion =
  | { readonly tipo: 'respuesta'; readonly respuesta: ModelTurnResponse }
  | { readonly tipo: 'fallo'; readonly error: ModelError };

type EntradaOFuncion =
  EntradaDeGuion | ((request: ModelTurnRequest, indice: number) => EntradaDeGuion | Promise<EntradaDeGuion>);

const BASE_DE_RESPUESTA = {
  provider: 'fake',
  model: 'modelo-guionado',
  tier: 'equilibrado',
  usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15, costUsd: 0.0001 },
  latencyMs: 12,
  generationId: null,
} as const;

export type SobreescrituraDeRespuesta = Partial<
  Pick<
    ModelTurnResponse,
    'provider' | 'model' | 'tier' | 'usage' | 'latencyMs' | 'generationId' | 'finishReason'
  >
>;

/** Respuesta final de texto. */
export function respuestaFinal(
  content: string,
  sobreescribir: SobreescrituraDeRespuesta = {},
): EntradaDeGuion {
  return {
    tipo: 'respuesta',
    respuesta: {
      ...BASE_DE_RESPUESTA,
      finishReason: 'stop',
      ...sobreescribir,
      kind: 'final',
      content,
      toolCalls: [],
    },
  };
}

export interface LlamadaDeGuion {
  readonly id?: string;
  readonly name: string;
  readonly arguments?: Readonly<Record<string, unknown>>;
}

let contadorDeIds = 0;

/** Respuesta con tool calls (ids autogenerados si no se dan). */
export function respuestaConTools(
  llamadas: readonly LlamadaDeGuion[],
  sobreescribir: SobreescrituraDeRespuesta = {},
): EntradaDeGuion {
  const toolCalls: ModelToolCall[] = llamadas.map((l) => ({
    id: l.id ?? `call_${(contadorDeIds += 1)}`,
    name: l.name,
    arguments: l.arguments ?? {},
  }));
  return {
    tipo: 'respuesta',
    respuesta: {
      ...BASE_DE_RESPUESTA,
      ...sobreescribir,
      finishReason: 'tool_calls',
      kind: 'tool_calls',
      content: null,
      toolCalls,
    },
  };
}

/** Fallo del modelo (`ModelError`). */
export function fallo(
  code: ModelErrorCode,
  opciones: { readonly retryable?: boolean; readonly retryAfterS?: number | null } = {},
): EntradaDeGuion {
  return {
    tipo: 'fallo',
    error: new ModelError(code, opciones.retryable ?? false, opciones.retryAfterS ?? null),
  };
}

export class GuionAgotadoError extends Error {
  constructor(llamadas: number) {
    super(`ScriptedModel: el guion se agotó (llamada ${llamadas}).`);
    this.name = 'GuionAgotadoError';
  }
}

export class ScriptedModel implements ModelClient {
  /** Copias de las peticiones recibidas, en orden. */
  readonly requests: ModelTurnRequest[] = [];
  /** Señales recibidas, en el mismo orden. */
  readonly signals: (AbortSignal | undefined)[] = [];
  private cursor = 0;

  constructor(private readonly guion: readonly EntradaOFuncion[]) {}

  /** Cuántas entradas del guion se consumieron. */
  get llamadas(): number {
    return this.cursor;
  }

  async turn(request: ModelTurnRequest, signal?: AbortSignal): Promise<ModelTurnResponse> {
    const indice = this.cursor;
    this.requests.push(structuredClone(request));
    this.signals.push(signal);
    const entrada = this.guion[indice];
    this.cursor += 1;
    if (entrada === undefined) throw new GuionAgotadoError(indice + 1);
    const resuelta = typeof entrada === 'function' ? await entrada(request, indice) : entrada;
    if (resuelta.tipo === 'fallo') throw resuelta.error;
    return resuelta.respuesta;
  }
}
