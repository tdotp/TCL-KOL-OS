/**
 * KPIs de la participación (V2 · Fase 8, DEC-049): resumen derivado y validadores puros de las entradas.
 *
 * Un objetivo es lo PACTADO; una medición es lo OBSERVADO. Este módulo no persiste ni autoriza (eso es de
 * `packages/db`): normaliza y valida lo que entra, y calcula el `ResumenKpi` desde las comparaciones de
 * `kpi-compare.ts`. Nunca suma entre métricas ni entregables: el resumen CUENTA objetivos, no agrega valores.
 */

import { type DomainError, type Result, err, ok } from './errors';
import { type ComparacionDeKpi } from './kpi-compare';
import {
  type KpiComparator,
  type MetricaValidada,
  isKpiComparator,
  validarMetricaDeKpi,
  validarValorDeKpi,
} from './kpi-metrics';
import { isSocialPlatform } from './influencers';
import { FECHA_ISO_MINIMA, esClaveDeIdempotenciaValida, isIsoDate } from './operational-events';

// ─────────────────────────── Resumen ───────────────────────────────────────────

/**
 *  sin_objetivos   no hay objetivos vigentes.
 *  sin_mediciones  hay objetivos y ninguno tiene medición.
 *  parcial         algunos objetivos tienen medición y otros no.
 *  completo        todos los objetivos tienen medición (cumplan o no, o no sean comparables).
 */
export type EstadoDeResumenKpi = 'sin_objetivos' | 'sin_mediciones' | 'parcial' | 'completo';

export interface ResumenKpi {
  /** Objetivos vigentes. */
  readonly objetivos: number;
  /** Objetivos que tienen una medición vigente (comparable o no). */
  readonly conMedicion: number;
  readonly cumplidos: number;
  readonly porDebajo: number;
  /** Objetivos que no se pueden comparar (`other`, unidad o ámbito distinto). */
  readonly noComparables: number;
  readonly estado: EstadoDeResumenKpi;
}

export const RESUMEN_KPI_VACIO: ResumenKpi = {
  objetivos: 0,
  conMedicion: 0,
  cumplidos: 0,
  porDebajo: 0,
  noComparables: 0,
  estado: 'sin_objetivos',
};

/**
 * Resumen derivado de las comparaciones de UNA participación. `conMedicion` cuenta los objetivos con una
 * medición vigente: los comparables (`cumplido`/`por_debajo`) siempre la tienen; un `no_comparable` la tiene
 * solo si hay una medición que no se pudo comparar (la comparación lo marca con `measurementId`).
 */
export function resumirKpi(comparaciones: readonly ComparacionDeKpi[]): ResumenKpi {
  const objetivos = comparaciones.length;
  if (objetivos === 0) return RESUMEN_KPI_VACIO;
  let cumplidos = 0;
  let porDebajo = 0;
  let noComparables = 0;
  let conMedicion = 0;
  for (const c of comparaciones) {
    if (c.estado === 'cumplido') {
      cumplidos++;
      conMedicion++;
    } else if (c.estado === 'por_debajo') {
      porDebajo++;
      conMedicion++;
    } else if (c.estado === 'no_comparable') {
      noComparables++;
      if (c.measurementId !== null) conMedicion++;
    }
  }
  const estado: EstadoDeResumenKpi =
    conMedicion === 0 ? 'sin_mediciones' : conMedicion === objetivos ? 'completo' : 'parcial';
  return { objetivos, conMedicion, cumplidos, porDebajo, noComparables, estado };
}

// ─────────────────────────── Validadores de entrada ────────────────────────────

function falla<T>(r: { readonly ok: false; readonly error: DomainError }): Result<T> {
  return { ok: false, error: r.error };
}

function invalido<T>(field: string, message: string, reason?: string): Result<T> {
  return err({
    code: 'VALIDATION_FAILED',
    message,
    details: reason === undefined ? { field } : { field, reason },
  });
}

const PATRON_DE_FECHA = /^\d{4}-\d{2}-\d{2}$/;
const CARACTERES_DE_CONTROL = /[\p{Cc}]/u;
export const KPI_MAX_MOTIVO = 500;
const TOLERANCIA_DE_FUTURO_MS = 24 * 60 * 60 * 1000;

/** Clave de idempotencia: obligatoria, sin espacios en los extremos, hasta 200 caracteres, sin control ni bidi. */
export function validarClaveDeKpi(clave: unknown): Result<string> {
  if (!esClaveDeIdempotenciaValida(clave)) {
    return invalido(
      'idempotencyKey',
      'La clave de idempotencia es obligatoria (hasta 200 caracteres, sin espacios en los extremos).',
    );
  }
  return ok(clave);
}

/** `YYYY-MM-DD` válido (calendario real) o `null`. */
export function validarFechaDeKpi(valor: unknown, field: string): Result<string | null> {
  if (valor === undefined || valor === null) return ok(null);
  if (typeof valor !== 'string' || !PATRON_DE_FECHA.test(valor)) {
    return invalido(field, 'La fecha debe tener el formato AAAA-MM-DD.');
  }
  // Calendario real Y dentro del rango que la base guarda (el año 0000 no existe en `date`).
  if (!isIsoDate(valor)) {
    return invalido(field, 'La fecha no existe en el calendario o está fuera de rango.');
  }
  return ok(valor);
}

function validarPeriodo(
  inicio: unknown,
  fin: unknown,
): Result<{ periodStart: string | null; periodEnd: string | null }> {
  const a = validarFechaDeKpi(inicio, 'periodStart');
  if (!a.ok) return falla(a);
  const b = validarFechaDeKpi(fin, 'periodEnd');
  if (!b.ok) return falla(b);
  if (a.value !== null && b.value !== null && b.value < a.value) {
    return invalido('periodEnd', 'El fin del periodo no puede ser anterior a su inicio.');
  }
  return ok({ periodStart: a.value, periodEnd: b.value });
}

function validarPlataforma(valor: unknown): Result<string | null> {
  if (valor === undefined || valor === null) return ok(null);
  if (!isSocialPlatform(valor)) return invalido('platform', 'La plataforma no es válida.');
  return ok(valor);
}

export interface ObjetivoDeKpiNormalizado extends MetricaValidada {
  readonly targetValue: number;
  readonly comparator: KpiComparator;
  readonly platform: string | null;
  readonly periodStart: string | null;
  readonly periodEnd: string | null;
}

/** Normaliza un objetivo: métrica del catálogo (unidad derivada), valor, comparador (por omisión `gte`), periodo. */
export function validarObjetivoDeKpi(input: {
  readonly metric: unknown;
  readonly otherLabel?: unknown;
  readonly unit?: unknown;
  readonly targetValue: unknown;
  readonly comparator?: unknown;
  readonly platform?: unknown;
  readonly periodStart?: unknown;
  readonly periodEnd?: unknown;
}): Result<ObjetivoDeKpiNormalizado> {
  const metrica = validarMetricaDeKpi(input);
  if (!metrica.ok) return falla(metrica);
  const valor = validarValorDeKpi(metrica.value.metric, input.targetValue);
  if (!valor.ok) {
    return invalido(
      'targetValue',
      valor.error.message,
      valor.error.details?.['reason'] as string | undefined,
    );
  }
  const comparador = input.comparator ?? 'gte';
  if (!isKpiComparator(comparador)) {
    return invalido('comparator', 'El comparador es «gte» (al menos) o «lte» (como máximo).');
  }
  const plataforma = validarPlataforma(input.platform);
  if (!plataforma.ok) return falla(plataforma);
  const periodo = validarPeriodo(input.periodStart, input.periodEnd);
  if (!periodo.ok) return falla(periodo);
  return ok({
    ...metrica.value,
    targetValue: valor.value,
    comparator: comparador,
    platform: plataforma.value,
    ...periodo.value,
  });
}

export interface MedicionDeKpiNormalizada extends MetricaValidada {
  readonly value: number;
  /** ISO 8601 UTC. */
  readonly observedAt: string;
  readonly platform: string | null;
  readonly periodStart: string | null;
  readonly periodEnd: string | null;
}

/** `observedAt` válido y no en el futuro (con 24 h de holgura por husos horarios). */
export function validarObservacionDeKpi(valor: unknown, ahora: Date): Result<string> {
  const fecha =
    valor instanceof Date
      ? valor
      : typeof valor === 'string' && valor.trim() !== ''
        ? new Date(valor)
        : undefined;
  if (fecha === undefined || Number.isNaN(fecha.getTime())) {
    return invalido('observedAt', 'La fecha de observación no es válida.');
  }
  // Fuera del rango que `timestamptz` guarda sin error (p. ej. el año 0000): validación, nunca un 500.
  if (fecha.toISOString().slice(0, 10) < FECHA_ISO_MINIMA) {
    return invalido('observedAt', 'La fecha de observación está fuera de rango.', 'out_of_range');
  }
  if (fecha.getTime() > ahora.getTime() + TOLERANCIA_DE_FUTURO_MS) {
    return invalido('observedAt', 'La fecha de observación no puede estar en el futuro.', 'in_the_future');
  }
  return ok(fecha.toISOString());
}

/** Normaliza una medición: métrica y unidad del catálogo, valor, observación y periodo. */
export function validarMedicionDeKpi(
  input: {
    readonly metric: unknown;
    readonly otherLabel?: unknown;
    readonly unit?: unknown;
    readonly value: unknown;
    readonly observedAt: unknown;
    readonly platform?: unknown;
    readonly periodStart?: unknown;
    readonly periodEnd?: unknown;
  },
  ahora: Date = new Date(),
): Result<MedicionDeKpiNormalizada> {
  const metrica = validarMetricaDeKpi(input);
  if (!metrica.ok) return falla(metrica);
  const valor = validarValorDeKpi(metrica.value.metric, input.value);
  if (!valor.ok) return falla(valor);
  const observada = validarObservacionDeKpi(input.observedAt, ahora);
  if (!observada.ok) return falla(observada);
  const plataforma = validarPlataforma(input.platform);
  if (!plataforma.ok) return falla(plataforma);
  const periodo = validarPeriodo(input.periodStart, input.periodEnd);
  if (!periodo.ok) return falla(periodo);
  return ok({
    ...metrica.value,
    value: valor.value,
    observedAt: observada.value,
    platform: plataforma.value,
    ...periodo.value,
  });
}

/** Motivo de una corrección (obligatorio): texto recortado de 1 a 500 caracteres, sin control. */
export function validarMotivoDeCorreccionDeKpi(motivo: unknown): Result<string> {
  if (typeof motivo !== 'string')
    return invalido('correctionReason', 'El motivo de la corrección es obligatorio.');
  const t = motivo.replace(/\s+/gu, ' ').trim();
  if (t === '') return invalido('correctionReason', 'El motivo de la corrección es obligatorio.');
  if (t.length > KPI_MAX_MOTIVO) {
    return invalido('correctionReason', `El motivo no puede superar ${KPI_MAX_MOTIVO} caracteres.`);
  }
  if (CARACTERES_DE_CONTROL.test(t))
    return invalido('correctionReason', 'El motivo contiene caracteres no válidos.');
  return ok(t);
}
