/**
 * Cliente del worker para el análisis de guiones (`POST /modelo/analisis`, V2 · Fase 7).
 *
 * `packages/db` NO puede importar el cliente del agente (`packages/agent` depende de db), así que el caso
 * de uso de análisis tiene su propia interfaz inyectable `ClienteDeAnalisis`:
 *
 *  · `crearClienteDeAnalisisHttp` — producción: HTTP al worker (`AI_WORKER_URL ?? WORKER_URL`), plazo
 *    `timeout_s + 10 s`. NUNCA lanza: todo fallo vuelve como `{ok:false, fallo}` con un código fijo
 *    (los del worker, o `WORKER_UNREACHABLE` / `MODEL_TIMEOUT` del lado de Node). No refleja mensajes del
 *    proveedor ni del worker (pueden llevar texto no confiable).
 *  · `ClienteDeAnalisisGuionado` — pruebas SIN Python: respuestas pre-escritas o calculadas a partir de la
 *    petición, y registro de cada petición recibida.
 *
 * El reintento de transporte (una vez, solo `esFalloReintentablePorNode`) lo decide el CASO DE USO, no este
 * cliente: así el ledger recibe las llamadas de AMBOS intentos.
 */

import {
  type LlamadaDelWorker,
  type PeticionDeAnalisis,
  PARAMETROS_DE_LLAMADA_DE_ANALISIS,
} from '@tcl-kol-os/domain';

export const URL_DEL_WORKER_POR_DEFECTO = 'http://localhost:8000';
export const RUTA_DEL_ANALISIS = '/modelo/analisis';
/** Holgura Node→worker sobre el plazo pedido al proveedor. */
export const HOLGURA_HTTP_DE_ANALISIS_MS = 10_000;
const MAX_BYTES_DE_RESPUESTA = 4_000_000;

export type LectorDeEntornoDeCliente = (nombre: string) => string | undefined;

export interface RespuestaDelModelo {
  readonly provider: string;
  readonly model: string;
  readonly tier: string;
  readonly finishReason: string;
  /** Salida cruda del modelo (JSON ya parseado): la valida el dominio, no este cliente. */
  readonly output: unknown;
  readonly usage: {
    readonly promptTokens: number;
    readonly completionTokens: number;
    readonly totalTokens: number;
    readonly costUsd: number | null;
  };
  readonly attempts: number;
  readonly calls: readonly LlamadaDelWorker[];
  readonly latencyMs: number;
  readonly generationId: string | null;
}

export interface FalloDelModelo {
  /** Código del worker (`MODEL_TIMEOUT`, `MODEL_OUTPUT_INVALID`…) o `WORKER_UNREACHABLE` de Node. */
  readonly code: string;
  readonly retryable: boolean;
  readonly retryAfterS: number | null;
  readonly httpStatus?: number | undefined;
  /** Llamadas al proveedor que SÍ ocurrieron (para el ledger). Vacío si no llegó a haber ninguna. */
  readonly calls: readonly LlamadaDelWorker[];
  /** Solo un motivo corto fijado por el worker (`vacio`, `forma_invalida`…). Nunca contenido. */
  readonly reason?: string | undefined;
}

export type ResultadoDeLlamada =
  | { readonly ok: true; readonly respuesta: RespuestaDelModelo }
  | { readonly ok: false; readonly fallo: FalloDelModelo };

export interface ClienteDeAnalisis {
  analizar(peticion: PeticionDeAnalisis): Promise<ResultadoDeLlamada>;
}

// ─────────────────────────── Normalización de la respuesta ─────────────────────

function esObjeto(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function enteroNoNegativo(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : undefined;
}

function textoNoVacio(v: unknown, max = 300): string | undefined {
  return typeof v === 'string' && v.trim() !== '' ? v.slice(0, max) : undefined;
}

const OUTCOMES: readonly LlamadaDelWorker['outcome'][] = ['ok', 'json_invalido', 'forma_invalida', 'error'];

function normalizarLlamada(crudo: unknown): LlamadaDelWorker | undefined {
  if (!esObjeto(crudo)) return undefined;
  const outcome = OUTCOMES.find((o) => o === crudo['outcome']);
  const latencia = enteroNoNegativo(crudo['latency_ms']);
  if (outcome === undefined || latencia === undefined) return undefined;
  let usage: LlamadaDelWorker['usage'] = null;
  const u = crudo['usage'];
  if (esObjeto(u)) {
    const p = enteroNoNegativo(u['prompt_tokens']);
    const c = enteroNoNegativo(u['completion_tokens']);
    const t = enteroNoNegativo(u['total_tokens']);
    if (p === undefined || c === undefined || t === undefined) return undefined;
    const costo = u['cost_usd'];
    usage = {
      prompt_tokens: p,
      completion_tokens: c,
      total_tokens: t,
      cost_usd: typeof costo === 'number' && Number.isFinite(costo) && costo >= 0 ? costo : null,
    };
  }
  const gen = crudo['generation_id'];
  return {
    usage,
    latency_ms: latencia,
    generation_id: typeof gen === 'string' && gen !== '' ? gen.slice(0, 200) : null,
    outcome,
  };
}

function normalizarLlamadas(crudo: unknown): LlamadaDelWorker[] {
  if (!Array.isArray(crudo)) return [];
  const salida: LlamadaDelWorker[] = [];
  for (const c of crudo) {
    const n = normalizarLlamada(c);
    if (n !== undefined) salida.push(n);
  }
  return salida;
}

const CODIGOS_DEL_WORKER = new Set<string>([
  'AI_DISABLED',
  'MODEL_TIMEOUT',
  'MODEL_RATE_LIMITED',
  'MODEL_UPSTREAM_ERROR',
  'MODEL_BAD_RESPONSE',
  'MODEL_CONTEXT_TOO_LARGE',
  'MODEL_NOT_CONFIGURED',
  'MODEL_OUTPUT_INVALID',
  'REQUEST_INVALID',
  'INTERNAL_ERROR',
]);

/** Valida DEFENSIVAMENTE el JSON de éxito: un worker que devuelve basura es `MODEL_BAD_RESPONSE`. */
export function normalizarRespuestaDeAnalisis(json: unknown): ResultadoDeLlamada {
  const mala: ResultadoDeLlamada = {
    ok: false,
    fallo: { code: 'MODEL_BAD_RESPONSE', retryable: false, retryAfterS: null, calls: [] },
  };
  if (!esObjeto(json) || !('output' in json)) return mala;
  const provider = textoNoVacio(json['provider'], 100);
  const model = textoNoVacio(json['model'], 200);
  const tier = textoNoVacio(json['tier'], 50);
  const uso = json['usage'];
  if (provider === undefined || model === undefined || tier === undefined || !esObjeto(uso)) return mala;
  const p = enteroNoNegativo(uso['prompt_tokens']);
  const c = enteroNoNegativo(uso['completion_tokens']);
  const t = enteroNoNegativo(uso['total_tokens']);
  const latencia = enteroNoNegativo(json['latency_ms']);
  if (p === undefined || c === undefined || t === undefined || latencia === undefined) return mala;
  const costo = uso['cost_usd'];
  const calls = normalizarLlamadas(json['calls']);
  const gen = json['generation_id'];
  return {
    ok: true,
    respuesta: {
      provider,
      model,
      tier,
      finishReason: textoNoVacio(json['finish_reason'], 30) ?? 'other',
      output: json['output'],
      usage: {
        promptTokens: p,
        completionTokens: c,
        totalTokens: t,
        costUsd: typeof costo === 'number' && Number.isFinite(costo) && costo >= 0 ? costo : null,
      },
      attempts: enteroNoNegativo(json['attempts']) ?? Math.max(calls.length, 1),
      calls,
      latencyMs: latencia,
      generationId: typeof gen === 'string' && gen !== '' ? gen.slice(0, 200) : null,
    },
  };
}

/** Error HTTP del worker: `{error:{code,retryable,retry_after_s,details?,calls?}}`. Nunca refleja el mensaje. */
export function normalizarErrorDeAnalisis(status: number, json: unknown): FalloDelModelo {
  const e = esObjeto(json) && esObjeto(json['error']) ? json['error'] : undefined;
  const codigoCrudo = e === undefined ? undefined : e['code'];
  const code =
    typeof codigoCrudo === 'string' && CODIGOS_DEL_WORKER.has(codigoCrudo)
      ? codigoCrudo
      : status === 429
        ? 'MODEL_RATE_LIMITED'
        : status === 504 || status === 408
          ? 'MODEL_TIMEOUT'
          : status >= 500
            ? 'MODEL_UPSTREAM_ERROR'
            : 'INTERNAL_ERROR';
  const espera = e === undefined ? undefined : e['retry_after_s'];
  const detalles = e !== undefined && esObjeto(e['details']) ? e['details'] : undefined;
  const motivo = detalles === undefined ? undefined : textoNoVacio(detalles['reason'], 40);
  return {
    code,
    retryable: e !== undefined && e['retryable'] === true,
    retryAfterS:
      typeof espera === 'number' && Number.isFinite(espera) && espera >= 0 ? Math.ceil(espera) : null,
    httpStatus: status,
    calls: e === undefined ? [] : normalizarLlamadas(e['calls']),
    ...(motivo === undefined ? {} : { reason: motivo }),
  };
}

// ─────────────────────────── HTTP ──────────────────────────────────────────────

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface OpcionesDeClienteHttp {
  readonly baseUrl?: string | undefined;
  readonly env?: LectorDeEntornoDeCliente | undefined;
  readonly fetch?: FetchLike | undefined;
  readonly holguraHttpMs?: number | undefined;
}

/** URL base del worker (`AI_WORKER_URL ?? WORKER_URL ?? http://localhost:8000`), sin barra final. */
export function resolverUrlDelWorkerDeAnalisis(
  env: LectorDeEntornoDeCliente = (n) => process.env[n],
): string {
  const candidata =
    (env('AI_WORKER_URL') ?? '').trim() || (env('WORKER_URL') ?? '').trim() || URL_DEL_WORKER_POR_DEFECTO;
  return candidata.replace(/\/+$/, '');
}

export function crearClienteDeAnalisisHttp(opciones: OpcionesDeClienteHttp = {}): ClienteDeAnalisis {
  const base = (opciones.baseUrl ?? resolverUrlDelWorkerDeAnalisis(opciones.env)).replace(/\/+$/, '');
  const hacerFetch: FetchLike = opciones.fetch ?? ((url, init) => fetch(url, init));
  const holgura = opciones.holguraHttpMs ?? HOLGURA_HTTP_DE_ANALISIS_MS;
  return {
    async analizar(peticion: PeticionDeAnalisis): Promise<ResultadoDeLlamada> {
      const plazoMs = (peticion.timeout_s ?? PARAMETROS_DE_LLAMADA_DE_ANALISIS.timeoutS) * 1_000 + holgura;
      const controlador = new AbortController();
      const reloj = setTimeout(() => controlador.abort(), plazoMs);
      try {
        const res = await hacerFetch(`${base}${RUTA_DEL_ANALISIS}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(peticion),
          signal: controlador.signal,
        });
        const texto = await res.text();
        if (texto.length > MAX_BYTES_DE_RESPUESTA) {
          return {
            ok: false,
            fallo: { code: 'MODEL_BAD_RESPONSE', retryable: false, retryAfterS: null, calls: [] },
          };
        }
        let json: unknown;
        try {
          json = JSON.parse(texto);
        } catch {
          json = undefined;
        }
        if (!res.ok) return { ok: false, fallo: normalizarErrorDeAnalisis(res.status, json) };
        return normalizarRespuestaDeAnalisis(json);
      } catch (error) {
        const abortado =
          controlador.signal.aborted || (error as { name?: unknown } | null)?.name === 'AbortError';
        return {
          ok: false,
          fallo: {
            code: abortado ? 'MODEL_TIMEOUT' : 'WORKER_UNREACHABLE',
            retryable: true,
            retryAfterS: null,
            calls: [],
          },
        };
      } finally {
        clearTimeout(reloj);
      }
    },
  };
}

// ─────────────────────────── Guionado (pruebas) ────────────────────────────────

export type GuionDeLlamada =
  | ResultadoDeLlamada
  | ((peticion: PeticionDeAnalisis, numero: number) => ResultadoDeLlamada | Promise<ResultadoDeLlamada>);

/**
 * Cliente de pruebas SIN Python. Cada llamada consume la siguiente entrada del guion (la última se repite);
 * una entrada puede ser una función que calcule la respuesta a partir de la petición (p. ej. para citar
 * alias reales). Registra cada petición en `peticiones`.
 */
export class ClienteDeAnalisisGuionado implements ClienteDeAnalisis {
  readonly peticiones: PeticionDeAnalisis[] = [];
  private readonly guion: readonly GuionDeLlamada[];
  private demora: (() => Promise<void>) | undefined;

  constructor(guion: GuionDeLlamada | readonly GuionDeLlamada[], demora?: () => Promise<void>) {
    this.guion = Array.isArray(guion) ? (guion as readonly GuionDeLlamada[]) : [guion as GuionDeLlamada];
    this.demora = demora;
  }

  get llamadas(): number {
    return this.peticiones.length;
  }

  async analizar(peticion: PeticionDeAnalisis): Promise<ResultadoDeLlamada> {
    const numero = this.peticiones.length;
    this.peticiones.push(peticion);
    if (this.demora !== undefined) await this.demora();
    if (this.guion.length === 0) {
      return { ok: false, fallo: { code: 'INTERNAL_ERROR', retryable: false, retryAfterS: null, calls: [] } };
    }
    const entrada = this.guion[Math.min(numero, this.guion.length - 1)]!;
    return typeof entrada === 'function' ? await entrada(peticion, numero) : entrada;
  }
}

/** Una llamada ok del worker (para armar respuestas guionadas). */
export function llamadaOk(extra: Partial<LlamadaDelWorker> = {}): LlamadaDelWorker {
  return {
    usage: { prompt_tokens: 1200, completion_tokens: 300, total_tokens: 1500, cost_usd: 0.0021 },
    latency_ms: 850,
    generation_id: 'gen-prueba',
    outcome: 'ok',
    ...extra,
  };
}

/** Respuesta exitosa del worker con una salida dada (cruda, sin validar). */
export function respuestaGuionada(
  output: unknown,
  extra: Partial<Omit<RespuestaDelModelo, 'output'>> = {},
): ResultadoDeLlamada {
  const calls = extra.calls ?? [llamadaOk()];
  const sumar = (f: (c: LlamadaDelWorker) => number): number =>
    calls.reduce((s, c) => s + (c.usage === null ? 0 : f(c)), 0);
  return {
    ok: true,
    respuesta: {
      provider: 'fake',
      model: 'modelo-falso-analisis',
      tier: 'equilibrado',
      finishReason: 'stop',
      output,
      usage: {
        promptTokens: sumar((c) => c.usage!.prompt_tokens),
        completionTokens: sumar((c) => c.usage!.completion_tokens),
        totalTokens: sumar((c) => c.usage!.total_tokens),
        costUsd: calls.some((c) => c.usage?.cost_usd === null || c.usage === null)
          ? null
          : sumar((c) => c.usage!.cost_usd ?? 0),
      },
      attempts: calls.length,
      calls,
      latencyMs: calls.reduce((s, c) => s + c.latency_ms, 0),
      generationId: 'gen-prueba',
      ...extra,
    },
  };
}

/** Fallo guionado del worker (o de Node). */
export function falloGuionado(code: string, extra: Partial<FalloDelModelo> = {}): ResultadoDeLlamada {
  return {
    ok: false,
    fallo: {
      code,
      retryable: [
        'MODEL_TIMEOUT',
        'MODEL_RATE_LIMITED',
        'MODEL_UPSTREAM_ERROR',
        'WORKER_UNREACHABLE',
      ].includes(code),
      retryAfterS: null,
      calls: [],
      ...extra,
    },
  };
}
