/**
 * Reintentos de UNA llamada de modelo (D-runtime §3: la llamada de modelo es pura,
 * por eso es lo único que se reintenta).
 *
 *  · Solo ante `ModelError.retryable` (timeout, 429, 5xx del proveedor, conexión).
 *    Nunca ante 4xx, configuración, contexto demasiado grande ni códigos desconocidos.
 *  · 2 reintentos con espera 1 s / 3 s + jitter; si el worker dice `retry_after_s`
 *    se espera como mínimo eso, salvo que supere `maxRetryAfterS`: entonces no se
 *    reintenta (esperar un minuto dentro de un turno no sirve a nadie).
 *  · `sleep` y `random` son inyectables para probar sin esperar.
 *  · Una señal abortada corta la espera y el bucle.
 */
import { ModelError } from '../contracts.ts';

export type Dormir = (ms: number, signal?: AbortSignal) => Promise<void>;

/** Espera real con soporte de cancelación. */
export const dormir: Dormir = (ms, signal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(new ModelError('ABORTED', false));
      return;
    }
    const alAbortar = (): void => {
      clearTimeout(temporizador);
      reject(new ModelError('ABORTED', false));
    };
    const temporizador = setTimeout(() => {
      signal?.removeEventListener('abort', alAbortar);
      resolve();
    }, ms);
    signal?.addEventListener('abort', alAbortar, { once: true });
  });

export interface PoliticaDeReintentos {
  /** Reintentos adicionales al primer intento. */
  readonly maxRetries: number;
  /** Espera base antes del reintento 1, 2…; el último valor se repite. */
  readonly backoffMs: readonly number[];
  /** Fracción de la espera base que se suma como jitter (0 = sin jitter). */
  readonly jitterRatio: number;
  /** Tope de `retry_after_s` que se respeta; por encima no se reintenta. */
  readonly maxRetryAfterS: number;
  readonly sleep: Dormir;
  /** [0, 1). Inyectable. */
  readonly random: () => number;
}

export const POLITICA_DE_REINTENTOS_POR_DEFECTO: PoliticaDeReintentos = {
  maxRetries: 2,
  backoffMs: [1_000, 3_000],
  jitterRatio: 0.25,
  maxRetryAfterS: 15,
  sleep: dormir,
  random: Math.random,
};

/** Espera (ms) antes del reintento número `reintento` (1 = el primero). */
export function esperaDeReintento(
  politica: PoliticaDeReintentos,
  reintento: number,
  retryAfterS: number | null,
): number {
  const indice = Math.min(reintento - 1, politica.backoffMs.length - 1);
  const base = politica.backoffMs[Math.max(indice, 0)] ?? 1_000;
  const conJitter = base + Math.floor(politica.random() * politica.jitterRatio * base);
  return retryAfterS === null ? conJitter : Math.max(conJitter, Math.ceil(retryAfterS * 1_000));
}

/**
 * Ejecuta `operacion` y la reintenta según la política. Lanza el último
 * `ModelError`; cualquier otro error (un bug) se propaga sin reintentar.
 */
export async function conReintentos<T>(
  operacion: (intento: number) => Promise<T>,
  politica: PoliticaDeReintentos = POLITICA_DE_REINTENTOS_POR_DEFECTO,
  signal?: AbortSignal,
): Promise<T> {
  for (let intento = 0; ; intento += 1) {
    try {
      return await operacion(intento);
    } catch (error) {
      if (!(error instanceof ModelError)) throw error;
      const agotado = intento >= politica.maxRetries;
      const demasiadoLargo = error.retryAfterS !== null && error.retryAfterS > politica.maxRetryAfterS;
      if (!error.retryable || agotado || demasiadoLargo || signal?.aborted === true) throw error;
      await politica.sleep(esperaDeReintento(politica, intento + 1, error.retryAfterS), signal);
    }
  }
}
