/**
 * Cliente HTTP del gateway de modelo del worker: `POST /modelo/turno` (F6 · D1, D17).
 *
 * UNA llamada de modelo sin estado. Este cliente:
 *  · traduce camelCase ↔ snake_case y NADA más: no interpreta ni decide;
 *  · valida DEFENSIVAMENTE la respuesta (un worker que devuelve basura es
 *    `MODEL_BAD_RESPONSE`, nunca una tool call a medio validar para el runtime);
 *  · mapea errores a `ModelError` con mensajes FIJOS: nunca refleja texto del
 *    proveedor, del worker ni del contenido de los mensajes;
 *  · reintenta SOLO errores retryable (ver `retry.ts`); jamás un 4xx salvo 429;
 *  · ignora por construcción cualquier campo de razonamiento: solo copia los
 *    campos conocidos del contrato.
 *
 * URL: `AI_WORKER_URL ?? WORKER_URL ?? http://localhost:8000` (D17: el compose y el
 * `.env.example` usan `WORKER_URL`; la extracción usa `AI_WORKER_URL`).
 *
 * Smoke real (con proveedor): con el worker arriba y `AI_ENABLED=true`,
 * `AI_PROVIDER=openrouter`, `AI_API_KEY` y `AI_MODEL_EQUILIBRADO` en SU entorno,
 *   `new WorkerModelClient().turn({ messages: [{role:'system',content:'Responde OK'},
 *   {role:'user',content:'ping'}], tools: [] })`
 * debe devolver `kind: 'final'`. Con `AI_PROVIDER=fake` el worker responde de forma
 * determinística (útil para humo sin clave). Este cliente nunca recibe la clave.
 */
import {
  type ModelClient,
  type ModelErrorCode,
  type ModelMessage,
  type ModelToolCall,
  type ModelTurnRequest,
  type ModelTurnResponse,
  ModelError,
} from '../contracts.ts';
import { type EnvReader, envDelProceso } from './env.ts';
import { type PoliticaDeReintentos, POLITICA_DE_REINTENTOS_POR_DEFECTO, conReintentos } from './retry.ts';

export const URL_DEL_WORKER_POR_DEFECTO = 'http://localhost:8000';
export const RUTA_DEL_TURNO = '/modelo/turno';

/** Tope de tool calls por paso: el worker lo valida (`max_tool_calls`, por defecto 4). */
export const MAX_TOOL_CALLS_POR_PASO = 4;

/** Plazo del proveedor que se pide al worker (D: worker→proveedor 45 s). */
export const TIMEOUT_DE_MODELO_POR_DEFECTO_MS = 45_000;
/** Holgura Node→worker sobre el plazo pedido (D: Node→worker 55 s = 45 + 10). */
export const HOLGURA_HTTP_MS = 10_000;
/** Cuerpo de respuesta máximo que se acepta leer. */
const MAX_BYTES_DE_RESPUESTA = 4_000_000;

const FINISH_REASONS = new Set<ModelTurnResponse['finishReason']>([
  'stop',
  'tool_calls',
  'length',
  'content_filter',
  'other',
]);

/** Códigos que el worker documenta (`ERRORES` en `modelo_turno.py`). */
const CODIGOS_DEL_WORKER = new Set<string>([
  'AI_DISABLED',
  'MODEL_TIMEOUT',
  'MODEL_RATE_LIMITED',
  'MODEL_UPSTREAM_ERROR',
  'MODEL_BAD_RESPONSE',
  'MODEL_CONTEXT_TOO_LARGE',
  'MODEL_NOT_CONFIGURED',
  'REQUEST_INVALID',
  'INTERNAL_ERROR',
]);

/** Los únicos códigos que alguna vez se reintentan, aunque el cuerpo diga otra cosa. */
const CODIGOS_REINTENTABLES = new Set<string>([
  'MODEL_TIMEOUT',
  'MODEL_RATE_LIMITED',
  'MODEL_UPSTREAM_ERROR',
  'MODEL_BAD_RESPONSE',
]);

const RE_ID_LLAMADA = /^[A-Za-z0-9_.:-]{1,128}$/;
const RE_NOMBRE_TOOL = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface OpcionesDeWorkerModelClient {
  /** URL base del worker. Por defecto, del entorno (`AI_WORKER_URL ?? WORKER_URL`). */
  readonly baseUrl?: string | undefined;
  readonly env?: EnvReader | undefined;
  readonly fetch?: FetchLike | undefined;
  /** Plazo del proveedor (`timeout_s` al worker) si la petición no trae `timeoutMs`. */
  readonly timeoutMsPorDefecto?: number | undefined;
  /** Holgura HTTP sobre el plazo del proveedor. */
  readonly holguraHttpMs?: number | undefined;
  readonly maxToolCalls?: number | undefined;
  readonly reintentos?: Partial<PoliticaDeReintentos> | undefined;
}

/** URL base del worker según el entorno (D17). Sin barra final. */
export function resolverUrlDelWorker(env: EnvReader = envDelProceso): string {
  const candidata =
    (env('AI_WORKER_URL') ?? '').trim() || (env('WORKER_URL') ?? '').trim() || URL_DEL_WORKER_POR_DEFECTO;
  return candidata.replace(/\/+$/, '');
}

// ─────────────────────────── Petición ──────────────────────────────────────────

function mensajeAWire(m: ModelMessage): Record<string, unknown> {
  switch (m.role) {
    case 'system':
    case 'user':
      return { role: m.role, content: m.content };
    case 'assistant': {
      const salida: Record<string, unknown> = { role: 'assistant' };
      if (typeof m.content === 'string' && m.content !== '') salida['content'] = m.content;
      if (m.toolCalls !== undefined && m.toolCalls.length > 0) {
        salida['tool_calls'] = m.toolCalls.map((c) => ({
          id: c.id,
          name: c.name,
          arguments: c.arguments,
        }));
      }
      return salida;
    }
    case 'tool':
      return { role: 'tool', tool_call_id: m.toolCallId, content: m.content };
  }
}

/** Cuerpo JSON del contrato `TurnoEntrada` del worker. Exportado para las pruebas. */
export function construirCuerpoDeTurno(
  req: ModelTurnRequest,
  extra: { readonly timeoutS: number; readonly maxToolCalls: number },
): Record<string, unknown> {
  const cuerpo: Record<string, unknown> = {
    task: 'conversar',
    messages: req.messages.map(mensajeAWire),
    tools: req.tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters })),
    tool_choice: req.toolChoice ?? 'auto',
    timeout_s: extra.timeoutS,
    max_tool_calls: extra.maxToolCalls,
  };
  if (req.maxTokens !== undefined) cuerpo['max_tokens'] = req.maxTokens;
  if (req.correlation !== undefined) {
    const c: Record<string, unknown> = {};
    if (req.correlation.conversationId !== undefined) c['conversation_id'] = req.correlation.conversationId;
    if (req.correlation.agentRunId !== undefined) c['agent_run_id'] = req.correlation.agentRunId;
    if (req.correlation.stepIndex !== undefined) c['step_index'] = req.correlation.stepIndex;
    if (Object.keys(c).length > 0) cuerpo['correlation'] = c;
  }
  return cuerpo;
}

// ─────────────────────────── Respuesta ─────────────────────────────────────────

const malaRespuesta = (): ModelError => new ModelError('MODEL_BAD_RESPONSE', false);

function esObjeto(valor: unknown): valor is Record<string, unknown> {
  return typeof valor === 'object' && valor !== null && !Array.isArray(valor);
}

function enteroNoNegativo(valor: unknown): number {
  if (typeof valor !== 'number' || !Number.isSafeInteger(valor) || valor < 0) throw malaRespuesta();
  return valor;
}

function textoNoVacio(valor: unknown): string {
  if (typeof valor !== 'string' || valor.trim() === '') throw malaRespuesta();
  return valor;
}

function llamadaDeRespuesta(crudo: unknown): ModelToolCall {
  if (!esObjeto(crudo)) throw malaRespuesta();
  const id = crudo['id'];
  const name = crudo['name'];
  const args = crudo['arguments'];
  if (typeof id !== 'string' || !RE_ID_LLAMADA.test(id)) throw malaRespuesta();
  if (typeof name !== 'string' || !RE_NOMBRE_TOOL.test(name)) throw malaRespuesta();
  if (!esObjeto(args)) throw malaRespuesta();
  return { id, name, arguments: args };
}

/**
 * Valida y normaliza el JSON de éxito del worker. Solo se copian los campos
 * conocidos: cualquier otro (p. ej. un `reasoning` colado) se descarta.
 */
export function normalizarRespuestaDelWorker(json: unknown): ModelTurnResponse {
  if (!esObjeto(json)) throw malaRespuesta();
  const kind = json['kind'];
  if (kind !== 'final' && kind !== 'tool_calls') throw malaRespuesta();
  const mensaje = json['message'];
  if (!esObjeto(mensaje)) throw malaRespuesta();

  const crudasLlamadas = mensaje['tool_calls'] ?? [];
  if (!Array.isArray(crudasLlamadas)) throw malaRespuesta();
  const toolCalls = crudasLlamadas.map(llamadaDeRespuesta);
  if (new Set(toolCalls.map((c) => c.id)).size !== toolCalls.length) throw malaRespuesta();

  let content: string | null;
  if (kind === 'final') {
    if (toolCalls.length > 0) throw malaRespuesta();
    content = textoNoVacio(mensaje['content']);
  } else {
    if (toolCalls.length === 0) throw malaRespuesta();
    // Con tool calls el texto previo (preámbulo) se descarta siempre.
    content = null;
  }

  const finishCrudo = json['finish_reason'];
  const finishReason = FINISH_REASONS.has(finishCrudo as ModelTurnResponse['finishReason'])
    ? (finishCrudo as ModelTurnResponse['finishReason'])
    : 'other';

  const uso = json['usage'];
  if (!esObjeto(uso)) throw malaRespuesta();
  const costo = uso['cost_usd'];
  if (costo !== null && costo !== undefined && (typeof costo !== 'number' || !Number.isFinite(costo))) {
    throw malaRespuesta();
  }
  const generationId = json['generation_id'];

  return {
    kind,
    content,
    toolCalls,
    finishReason: kind === 'tool_calls' ? 'tool_calls' : finishReason,
    provider: textoNoVacio(json['provider']),
    model: textoNoVacio(json['model']),
    tier: textoNoVacio(json['tier']),
    usage: {
      promptTokens: enteroNoNegativo(uso['prompt_tokens']),
      completionTokens: enteroNoNegativo(uso['completion_tokens']),
      totalTokens: enteroNoNegativo(uso['total_tokens']),
      costUsd: typeof costo === 'number' && costo >= 0 ? costo : null,
    },
    latencyMs: enteroNoNegativo(json['latency_ms']),
    generationId: typeof generationId === 'string' && generationId !== '' ? generationId : null,
  };
}

function segundosDeEspera(valor: unknown): number | null {
  return typeof valor === 'number' && Number.isFinite(valor) && valor >= 0 ? Math.ceil(valor) : null;
}

function esperaDeCabecera(res: Response): number | null {
  const crudo = res.headers.get('retry-after')?.trim();
  return crudo !== undefined && /^\d{1,6}$/.test(crudo) ? Number(crudo) : null;
}

/**
 * Error de una respuesta HTTP no exitosa. Con cuerpo `{error:{code,...}}` manda el
 * código del worker; sin cuerpo utilizable, el estado HTTP. Los códigos
 * desconocidos nunca se reintentan.
 */
export function errorDeRespuestaHttp(
  status: number,
  cuerpo: unknown,
  cabeceraRetryAfter: number | null,
): ModelError {
  const error = esObjeto(cuerpo) && esObjeto(cuerpo['error']) ? cuerpo['error'] : undefined;
  if (error !== undefined) {
    const codigo = typeof error['code'] === 'string' ? error['code'] : '';
    const retryAfter = segundosDeEspera(error['retry_after_s']) ?? cabeceraRetryAfter;
    if (CODIGOS_DEL_WORKER.has(codigo)) {
      const declarado = error['retryable'];
      const reintentable = CODIGOS_REINTENTABLES.has(codigo) && declarado !== false;
      return new ModelError(codigo as ModelErrorCode, reintentable, retryAfter);
    }
    // Código desconocido: no se refleja ni se reintenta.
    return new ModelError('INTERNAL_ERROR', false, null);
  }
  if (status === 429) return new ModelError('MODEL_RATE_LIMITED', true, cabeceraRetryAfter);
  if (status === 408 || status === 504) return new ModelError('MODEL_TIMEOUT', true, null);
  if (status === 502 || status === 503)
    return new ModelError('MODEL_UPSTREAM_ERROR', true, cabeceraRetryAfter);
  if (status >= 400 && status < 500) return new ModelError('REQUEST_INVALID', false, null);
  return new ModelError('INTERNAL_ERROR', false, null);
}

/** Sin estrechamiento de tipos: el estado de una señal cambia mientras se espera. */
function estaAbortada(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function jsonODescartar(texto: string): unknown {
  try {
    return JSON.parse(texto) as unknown;
  } catch {
    return undefined;
  }
}

// ─────────────────────────── Cliente ───────────────────────────────────────────

export class WorkerModelClient implements ModelClient {
  private readonly env: EnvReader;
  private readonly fetchImpl: FetchLike;
  private readonly baseUrlExplicita: string | undefined;
  private readonly timeoutPorDefectoMs: number;
  private readonly holguraMs: number;
  private readonly maxToolCalls: number;
  private readonly politica: PoliticaDeReintentos;

  constructor(opciones: OpcionesDeWorkerModelClient = {}) {
    this.env = opciones.env ?? envDelProceso;
    this.fetchImpl = opciones.fetch ?? ((url, init) => fetch(url, init));
    this.baseUrlExplicita = opciones.baseUrl?.replace(/\/+$/, '');
    this.timeoutPorDefectoMs = opciones.timeoutMsPorDefecto ?? TIMEOUT_DE_MODELO_POR_DEFECTO_MS;
    this.holguraMs = opciones.holguraHttpMs ?? HOLGURA_HTTP_MS;
    this.maxToolCalls = opciones.maxToolCalls ?? MAX_TOOL_CALLS_POR_PASO;
    this.politica = { ...POLITICA_DE_REINTENTOS_POR_DEFECTO, ...(opciones.reintentos ?? {}) };
  }

  async turn(request: ModelTurnRequest, signal?: AbortSignal): Promise<ModelTurnResponse> {
    const url = `${this.baseUrlExplicita ?? resolverUrlDelWorker(this.env)}${RUTA_DEL_TURNO}`;
    try {
      new URL(url);
    } catch {
      throw new ModelError('MODEL_NOT_CONFIGURED', false);
    }
    const timeoutS = Math.min(
      Math.max(Math.ceil((request.timeoutMs ?? this.timeoutPorDefectoMs) / 1_000), 1),
      120,
    );
    const cuerpo = JSON.stringify(
      construirCuerpoDeTurno(request, { timeoutS, maxToolCalls: this.maxToolCalls }),
    );
    const plazoHttpMs = timeoutS * 1_000 + this.holguraMs;
    return conReintentos(() => this.unIntento(url, cuerpo, plazoHttpMs, signal), this.politica, signal);
  }

  private async unIntento(
    url: string,
    cuerpo: string,
    plazoHttpMs: number,
    signalDelLlamador: AbortSignal | undefined,
  ): Promise<ModelTurnResponse> {
    if (estaAbortada(signalDelLlamador)) throw new ModelError('ABORTED', false);
    const plazo = AbortSignal.timeout(plazoHttpMs);
    const combinada = signalDelLlamador === undefined ? plazo : AbortSignal.any([signalDelLlamador, plazo]);

    let res: Response;
    let texto: string;
    try {
      res = await this.fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: cuerpo,
        signal: combinada,
      });
      texto = await res.text();
    } catch {
      // El detalle del fallo de red no se refleja: solo el código.
      if (estaAbortada(signalDelLlamador)) throw new ModelError('ABORTED', false);
      if (plazo.aborted) throw new ModelError('MODEL_TIMEOUT', true);
      throw new ModelError('WORKER_UNREACHABLE', true);
    }
    if (texto.length > MAX_BYTES_DE_RESPUESTA) throw malaRespuesta();

    const json = jsonODescartar(texto);
    if (!res.ok) throw errorDeRespuestaHttp(res.status, json, esperaDeCabecera(res));
    if (json === undefined) throw malaRespuesta();
    // Un 2xx con cuerpo de error es una respuesta inválida del worker.
    if (esObjeto(json) && 'error' in json) throw malaRespuesta();
    return normalizarRespuestaDelWorker(json);
  }
}
