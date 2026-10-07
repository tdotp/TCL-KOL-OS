/**
 * Catálogo CERRADO de métricas de KPI (V2 · Fase 8, DEC-049).
 *
 * Una métrica pertenece a una unidad (la fija el catálogo, no quien registra):
 *
 *   views · reach · impressions · likes · comments · shares · saves · link_clicks   →  `count` (entero ≥ 0)
 *   engagement_rate                                                                 →  `percent` (puntos 0–100, p. ej. 4.7)
 *   other                                                                           →  `other` (con ETIQUETA; nunca se compara)
 *
 * No hay métricas de costo (CPM, CPV, CPC…): el dinero no entra aquí (DEC-014). La base repite este catálogo
 * (CHECK de la migración 032): una prueba vigila que no diverjan.
 */

import { type Result, err, ok } from './errors';

export const KPI_METRICS = [
  'views',
  'reach',
  'impressions',
  'likes',
  'comments',
  'shares',
  'saves',
  'link_clicks',
  'engagement_rate',
  'other',
] as const;

export type KpiMetric = (typeof KPI_METRICS)[number];

export const KPI_UNITS = ['count', 'percent', 'other'] as const;

export type KpiUnit = (typeof KPI_UNITS)[number];

/** `gte` = «al menos» (más es mejor) · `lte` = «como máximo». */
export const KPI_COMPARATORS = ['gte', 'lte'] as const;

export type KpiComparator = (typeof KPI_COMPARATORS)[number];

export const KPI_COUNT_METRICS: readonly KpiMetric[] = [
  'views',
  'reach',
  'impressions',
  'likes',
  'comments',
  'shares',
  'saves',
  'link_clicks',
] as const;

export function isKpiMetric(value: unknown): value is KpiMetric {
  return typeof value === 'string' && (KPI_METRICS as readonly string[]).includes(value);
}

export function isKpiUnit(value: unknown): value is KpiUnit {
  return typeof value === 'string' && (KPI_UNITS as readonly string[]).includes(value);
}

export function isKpiComparator(value: unknown): value is KpiComparator {
  return typeof value === 'string' && (KPI_COMPARATORS as readonly string[]).includes(value);
}

/** La unidad que el catálogo asigna a la métrica. */
export function unidadDeMetrica(metric: KpiMetric): KpiUnit {
  if (metric === 'engagement_rate') return 'percent';
  if (metric === 'other') return 'other';
  return 'count';
}

/** `other` jamás se compara (no hay forma de saber qué mide ni en qué escala). */
export function esMetricaComparable(metric: KpiMetric): boolean {
  return metric !== 'other';
}

export const ETIQUETA_DE_METRICA: Readonly<Record<KpiMetric, string>> = {
  views: 'Vistas',
  reach: 'Alcance',
  impressions: 'Impresiones',
  likes: 'Me gusta',
  comments: 'Comentarios',
  shares: 'Compartidos',
  saves: 'Guardados',
  link_clicks: 'Clics en el enlace',
  engagement_rate: 'Tasa de interacción',
  other: 'Otra métrica',
};

/** Valor máximo de un conteo (numeric(18,4) admite más; esto es un tope razonable, no una regla de negocio). */
export const KPI_MAX_COUNT = 1_000_000_000_000;
const MAX_ETIQUETA = 80;
const CARACTERES_DE_CONTROL = /[\p{Cc}]/u;

function invalido<T>(field: string, message: string, reason?: string): Result<T> {
  return err({
    code: 'VALIDATION_FAILED',
    message,
    details: reason === undefined ? { field } : { field, reason },
  });
}

export interface EtiquetaDeMetrica {
  readonly label: string;
  /** Clave de comparación (la etiqueta ya es NFKC; aquí además en minúsculas). */
  readonly key: string;
}

/**
 * Etiqueta de una métrica `other`: texto corto, sin caracteres de control. Se guarda normalizada NFKC (y con
 * los espacios colapsados): «Conversión» y «ｃonversión» (ancho completo) son la MISMA etiqueta, así que no
 * pueden convivir como dos objetivos vigentes del mismo ámbito. La base exige NFKC en `kpi_targets` (033).
 */
export function normalizarEtiquetaDeMetrica(raw: unknown): Result<EtiquetaDeMetrica> {
  if (typeof raw !== 'string') {
    return invalido('otherLabel', 'La métrica «otra» exige una etiqueta.', 'other_label_required');
  }
  const label = raw.normalize('NFKC').replace(/\s+/gu, ' ').trim();
  if (label === '') {
    return invalido('otherLabel', 'La etiqueta de la métrica no puede quedar vacía.', 'other_label_required');
  }
  if (label.length > MAX_ETIQUETA) {
    return invalido('otherLabel', `La etiqueta no puede superar ${MAX_ETIQUETA} caracteres.`);
  }
  if (CARACTERES_DE_CONTROL.test(label)) {
    return invalido('otherLabel', 'La etiqueta contiene caracteres no válidos.');
  }
  return ok({ label, key: label.toLowerCase() });
}

export interface MetricaValidada {
  readonly metric: KpiMetric;
  readonly unit: KpiUnit;
  /** Solo `other` lleva etiqueta. */
  readonly otherLabel: string | null;
}

/**
 * Valida la terna métrica · unidad · etiqueta. La unidad es opcional en la entrada (se deriva del catálogo);
 * si viene, DEBE ser la de la métrica. Solo `other` admite (y exige) etiqueta.
 */
export function validarMetricaDeKpi(input: {
  readonly metric: unknown;
  readonly unit?: unknown;
  readonly otherLabel?: unknown;
}): Result<MetricaValidada> {
  if (!isKpiMetric(input.metric)) {
    return invalido('metric', 'La métrica no está en el catálogo de KPI.', 'metric_not_in_catalog');
  }
  const metric = input.metric;
  const unit = unidadDeMetrica(metric);
  if (input.unit !== undefined && input.unit !== null && input.unit !== unit) {
    return invalido('unit', `La unidad de «${metric}» es «${unit}».`, 'unit_mismatch');
  }
  if (metric === 'other') {
    const etiqueta = normalizarEtiquetaDeMetrica(input.otherLabel);
    if (!etiqueta.ok) return etiqueta;
    return ok({ metric, unit, otherLabel: etiqueta.value.label });
  }
  if (input.otherLabel !== undefined && input.otherLabel !== null) {
    return invalido('otherLabel', 'Solo la métrica «otra» lleva etiqueta.', 'other_label_not_allowed');
  }
  return ok({ metric, unit, otherLabel: null });
}

/**
 * Valida un valor (objetivo o medición): número finito ≥ 0 con a lo sumo 4 decimales; los `count` son enteros
 * y la tasa de interacción (puntos) está entre 0 y 100.
 */
export function validarValorDeKpi(metric: KpiMetric, value: unknown): Result<number> {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return invalido('value', 'El valor debe ser un número.');
  }
  if (value < 0) return invalido('value', 'El valor no puede ser negativo.', 'negative');
  const unit = unidadDeMetrica(metric);
  if (unit === 'count') {
    if (!Number.isInteger(value)) {
      return invalido('value', 'Este conteo debe ser un número entero.', 'not_integer');
    }
    if (value > KPI_MAX_COUNT) return invalido('value', 'El valor es demasiado grande.', 'too_large');
    return ok(value);
  }
  if (metric === 'engagement_rate' && value > 100) {
    return invalido('value', 'La tasa de interacción va de 0 a 100 (puntos).', 'out_of_range');
  }
  if (value > KPI_MAX_COUNT) return invalido('value', 'El valor es demasiado grande.', 'too_large');
  if (Math.abs(value * 1e4 - Math.round(value * 1e4)) > 1e-6) {
    return invalido('value', 'El valor admite hasta 4 decimales.', 'too_many_decimals');
  }
  return ok(value);
}
