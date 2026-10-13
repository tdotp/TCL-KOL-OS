/**
 * Proyección acotada de la salida de las tools (V2 · Fase 6).
 *
 * Lo que vuelve al modelo:
 *   · nunca pasa de 16 KB (UTF-8) ni de 50 filas por lista;
 *   · nunca incluye `external_url` (puede traer una clave de acceso), `job_error` ni
 *     nada que no venga de una proyección explícita;
 *   · el contenido que viene de documentos, enlaces, hojas o texto libre de personas
 *     va en un SOBRE no confiable (`envolverNoConfiable`: nonce del run, prefijo `│`
 *     por línea, delimitadores neutralizados). Los campos fuera de un sobre son
 *     identificadores, estados y conteos que fija el código.
 */

import { envolverNoConfiable, recortarCampo } from '@tcl-kol-os/domain';

export const MAX_OUTPUT_BYTES = 16_384;
/** Margen bajo el tope duro: el executor añade `ok` y el envoltorio de errores. */
export const PRESUPUESTO_DE_SALIDA_BYTES = 15_000;

export function bytesUtf8(texto: string): number {
  return Buffer.byteLength(texto, 'utf8');
}

/**
 * Mayor `n` en `[0, total]` tal que `construir(n)` serializado no excede `maxBytes`.
 * Supone que el tamaño crece con `n` (se busca por bisección).
 */
export function maxQueCabe(
  total: number,
  construir: (n: number) => unknown,
  maxBytes: number = PRESUPUESTO_DE_SALIDA_BYTES,
): number {
  const cabe = (n: number): boolean => bytesUtf8(JSON.stringify(construir(n))) <= maxBytes;
  if (total <= 0) return 0;
  if (cabe(total)) return total;
  let lo = 0;
  let hi = total - 1;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (cabe(mid)) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** Limita un valor numérico opcional del modelo a `[min, max]` con valor por defecto. */
export function acotar(valor: unknown, porDefecto: number, min: number, max: number): number {
  if (typeof valor !== 'number' || !Number.isFinite(valor)) return porDefecto;
  return Math.min(Math.max(Math.trunc(valor), min), max);
}

/** Envuelve contenido NO confiable en un sobre del run. Cada línea queda con el prefijo `│`. */
export function sobre(
  nonce: string,
  kind: string,
  lineas: readonly string[],
  opciones: { readonly ref?: string; readonly meta?: Readonly<Record<string, unknown>> } = {},
): string {
  return envolverNoConfiable({
    nonce,
    kind,
    ref: opciones.ref,
    meta: opciones.meta,
    texto: lineas.join('\n'),
  });
}

/** Texto libre de una sola línea, neutralizado y recortado (para campos de salida). */
export function linea(texto: string | null | undefined, max: number): string {
  return recortarCampo(texto ?? '', max);
}

/** `YYYY-MM-DD` de una columna `date` leída por `pg` (medianoche local), sin desplazamientos de zona. */
export function fechaIso(fecha: Date | string | null | undefined): string | null {
  if (fecha === null || fecha === undefined) return null;
  if (typeof fecha === 'string') return fecha.slice(0, 10);
  if (Number.isNaN(fecha.getTime())) return null;
  const mes = String(fecha.getMonth() + 1).padStart(2, '0');
  const dia = String(fecha.getDate()).padStart(2, '0');
  return `${fecha.getFullYear()}-${mes}-${dia}`;
}

export function isoODeNulo(fecha: Date | string | null | undefined): string | null {
  if (fecha === null || fecha === undefined) return null;
  return typeof fecha === 'string' ? fecha : fecha.toISOString();
}

/** Serializa la salida de una tool que tuvo éxito. */
export function serializarExito(data: Readonly<Record<string, unknown>>): string {
  return JSON.stringify({ ok: true, ...data });
}

/** Cuerpo de error para el modelo: código, mensaje breve, ¿reintentable?, y detalles seguros. */
export function serializarError(error: {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
  readonly details?: Readonly<Record<string, unknown>> | undefined;
}): string {
  return JSON.stringify({
    ok: false,
    error: {
      code: error.code,
      message: linea(error.message, 300),
      retryable: error.retryable,
      ...(error.details !== undefined && Object.keys(error.details).length > 0
        ? { details: error.details }
        : {}),
    },
  });
}

/** Claves de `details` de un error de dominio que pueden verse (valores primitivos y cortos). */
const DETALLES_SEGUROS: ReadonlySet<string> = new Set([
  'reason',
  'field',
  'campaignStatus',
  'status',
  'to',
  // `runId` y `sourceId` NO: son UUID internos y el modelo solo ve alias (QA-F7-C1).
  'planId',
  'recordId',
  'kind',
  'motivo',
  'issues',
  'tool',
  'limit',
  // V2 · Fase 7: escalares cortos (enums y códigos que fija el servidor; nunca un id, un nombre ni texto de documentos).
  'from',
  'latestStatus',
  'briefStatus',
  'failureCode',
  'analysisStatus',
  'outcome',
  'sourceState',
  'part',
  'chars',
]);

export function detallesSeguros(
  details: Readonly<Record<string, unknown>> | undefined,
): Record<string, unknown> | undefined {
  if (details === undefined) return undefined;
  const salida: Record<string, unknown> = {};
  for (const [clave, valor] of Object.entries(details)) {
    if (!DETALLES_SEGUROS.has(clave)) continue;
    if (typeof valor === 'string') salida[clave] = linea(valor, 120);
    else if (typeof valor === 'number' || typeof valor === 'boolean') salida[clave] = valor;
  }
  return Object.keys(salida).length === 0 ? undefined : salida;
}
