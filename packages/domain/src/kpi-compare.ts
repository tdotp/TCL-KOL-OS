/**
 * Comparación PURA objetivo ↔ medición de KPI (V2 · Fase 8, DEC-049).
 *
 * Reglas (las vigila `kpi-compare.test.ts`):
 *  · Solo se compara si métrica, unidad, etiqueta y ÁMBITO (participación, entregable, plataforma) coinciden
 *    EXACTAMENTE (NULL = «sin entregable» / «sin plataforma» es un valor, no un comodín). Si no, `no_comparable`.
 *  · `other` jamás se compara.
 *  · La medición VIGENTE es la última observación NO corregida: una fila corregida (otra fila la lista en
 *    `supersedesId`) deja de contar; entre las restantes manda `observedAt` y, a igualdad, el orden de registro.
 *  · Nunca se suma ni se promedia entre métricas, entregables ni plataformas.
 *  · `comparator`: `gte` cumple con actual ≥ objetivo; `lte` cumple con actual ≤ objetivo.
 *  · `achievement` = actual / objetivo · 100 (2 decimales; `null` con objetivo 0). Es informativo: el estado
 *    lo decide el comparador, no el porcentaje.
 */

import {
  type KpiComparator,
  type KpiMetric,
  type KpiUnit,
  esMetricaComparable,
  unidadDeMetrica,
} from './kpi-metrics';

/** Ámbito de un objetivo o una medición. `null` es un valor (sin entregable / sin plataforma). */
export interface AmbitoDeKpi {
  readonly campaignInfluencerId: string;
  readonly deliverableId: string | null;
  readonly platform: string | null;
}

export interface ObjetivoDeKpi extends AmbitoDeKpi {
  readonly id: string;
  readonly metric: KpiMetric;
  readonly otherLabel: string | null;
  readonly unit: KpiUnit;
  readonly targetValue: number;
  readonly comparator: KpiComparator;
}

export interface MedicionDeKpi extends AmbitoDeKpi {
  readonly id: string;
  readonly metric: KpiMetric;
  readonly otherLabel: string | null;
  readonly unit: KpiUnit;
  readonly value: number;
  /** ISO 8601. */
  readonly observedAt: string;
  /** Orden de registro (desempate estable cuando dos observaciones coinciden). */
  readonly seq: number;
  /** La medición que esta corrige (si es una corrección). */
  readonly supersedesId: string | null;
}

export type EstadoDeKpi = 'sin_medicion' | 'no_comparable' | 'por_debajo' | 'cumplido';

export interface ComparacionDeKpi {
  readonly targetId: string;
  readonly metric: KpiMetric;
  readonly otherLabel: string | null;
  readonly unit: KpiUnit;
  readonly comparator: KpiComparator;
  readonly deliverableId: string | null;
  readonly platform: string | null;
  readonly target: number;
  /** Solo si hay una medición COMPARABLE. */
  readonly actual: number | null;
  /** actual − objetivo. */
  readonly delta: number | null;
  /** actual / objetivo · 100. */
  readonly achievement: number | null;
  readonly estado: EstadoDeKpi;
  /** Cuándo se observó la medición comparada (ISO). */
  readonly observedAt: string | null;
  readonly measurementId: string | null;
}

function redondear(valor: number, decimales: number): number {
  const f = 10 ** decimales;
  return Math.round((valor + Number.EPSILON) * f) / f;
}

function mismaEtiqueta(a: string | null, b: string | null): boolean {
  return (
    (a === null ? null : a.normalize('NFKC').toLowerCase()) ===
    (b === null ? null : b.normalize('NFKC').toLowerCase())
  );
}

/** ¿Mismo ámbito exacto? */
export function mismoAmbitoDeKpi(a: AmbitoDeKpi, b: AmbitoDeKpi): boolean {
  return (
    a.campaignInfluencerId === b.campaignInfluencerId &&
    a.deliverableId === b.deliverableId &&
    a.platform === b.platform
  );
}

/**
 * ¿Se pueden comparar? Métrica, unidad, etiqueta y ámbito iguales; la unidad es la del catálogo; `other` nunca.
 */
export function sonComparablesLosKpi(
  objetivo: Pick<ObjetivoDeKpi, 'metric' | 'unit' | 'otherLabel'> & AmbitoDeKpi,
  medicion: Pick<MedicionDeKpi, 'metric' | 'unit' | 'otherLabel'> & AmbitoDeKpi,
): boolean {
  if (!esMetricaComparable(objetivo.metric) || !esMetricaComparable(medicion.metric)) return false;
  if (objetivo.metric !== medicion.metric) return false;
  if (objetivo.unit !== medicion.unit) return false;
  if (objetivo.unit !== unidadDeMetrica(objetivo.metric)) return false;
  if (!mismaEtiqueta(objetivo.otherLabel, medicion.otherLabel)) return false;
  return mismoAmbitoDeKpi(objetivo, medicion);
}

function esPosterior(a: MedicionDeKpi, b: MedicionDeKpi): boolean {
  const ta = Date.parse(a.observedAt);
  const tb = Date.parse(b.observedAt);
  if (ta !== tb) return ta > tb;
  if (a.seq !== b.seq) return a.seq > b.seq;
  return a.id > b.id;
}

/**
 * Mediciones NO corregidas de una lista (cadena de supersession): una fila que otra corrige se descarta.
 * No agrupa: quien llama filtra antes por ámbito y métrica.
 */
export function medicionesNoCorregidas(mediciones: readonly MedicionDeKpi[]): MedicionDeKpi[] {
  const corregidas = new Set<string>();
  for (const m of mediciones) if (m.supersedesId !== null) corregidas.add(m.supersedesId);
  return mediciones.filter((m) => !corregidas.has(m.id));
}

/**
 * La medición vigente de un objetivo: entre las mediciones del MISMO ámbito, métrica, unidad y etiqueta, la
 * última observación no corregida. `undefined` si no hay ninguna. NO exige comparabilidad de unidades: devuelve
 * la vigente del grupo y deja que `compararKpi` decida (así una incompatibilidad se ve, no se oculta).
 */
export function medicionVigenteDe(
  objetivo: Pick<ObjetivoDeKpi, 'metric' | 'otherLabel'> & AmbitoDeKpi,
  mediciones: readonly MedicionDeKpi[],
): MedicionDeKpi | undefined {
  const delGrupo = mediciones.filter(
    (m) =>
      m.metric === objetivo.metric &&
      mismaEtiqueta(m.otherLabel, objetivo.otherLabel) &&
      mismoAmbitoDeKpi(m, objetivo),
  );
  let vigente: MedicionDeKpi | undefined;
  for (const m of medicionesNoCorregidas(delGrupo)) {
    if (vigente === undefined || esPosterior(m, vigente)) vigente = m;
  }
  return vigente;
}

/**
 * Compara un objetivo con SU medición vigente (ya elegida por quien llama). Función pura.
 *  · sin medición → `sin_medicion` (salvo `other`, que es siempre `no_comparable`);
 *  · incompatible (unidad, métrica, ámbito, etiqueta, `other`) → `no_comparable` (sin cifras);
 *  · si no → `cumplido` o `por_debajo` según el comparador.
 */
export function compararKpi(
  objetivo: ObjetivoDeKpi,
  medicionVigente: MedicionDeKpi | undefined | null,
): ComparacionDeKpi {
  const base = {
    targetId: objetivo.id,
    metric: objetivo.metric,
    otherLabel: objetivo.otherLabel,
    unit: objetivo.unit,
    comparator: objetivo.comparator,
    deliverableId: objetivo.deliverableId,
    platform: objetivo.platform,
    target: objetivo.targetValue,
  } as const;
  const sinCifras = {
    actual: null,
    delta: null,
    achievement: null,
    observedAt: null,
    measurementId: null,
  } as const;

  if (!esMetricaComparable(objetivo.metric)) {
    return { ...base, ...sinCifras, estado: 'no_comparable' };
  }
  if (medicionVigente === undefined || medicionVigente === null) {
    return { ...base, ...sinCifras, estado: 'sin_medicion' };
  }
  if (!sonComparablesLosKpi(objetivo, medicionVigente)) {
    return { ...base, ...sinCifras, estado: 'no_comparable' };
  }
  const actual = medicionVigente.value;
  const cumple =
    objetivo.comparator === 'gte' ? actual >= objetivo.targetValue : actual <= objetivo.targetValue;
  return {
    ...base,
    actual,
    delta: redondear(actual - objetivo.targetValue, 4),
    achievement: objetivo.targetValue === 0 ? null : redondear((actual / objetivo.targetValue) * 100, 2),
    estado: cumple ? 'cumplido' : 'por_debajo',
    observedAt: medicionVigente.observedAt,
    measurementId: medicionVigente.id,
  };
}

/**
 * Compara CADA objetivo con la vigente de su propio grupo. Un objetivo nunca toma la medición de otra métrica,
 * de otro entregable ni de otra plataforma, y nada se suma.
 */
export function compararKpis(
  objetivos: readonly ObjetivoDeKpi[],
  mediciones: readonly MedicionDeKpi[],
): ComparacionDeKpi[] {
  return objetivos.map((o) => compararKpi(o, medicionVigenteDe(o, mediciones)));
}
