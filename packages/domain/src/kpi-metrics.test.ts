import { describe, expect, it } from 'vitest';
import {
  KPI_COUNT_METRICS,
  KPI_METRICS,
  esMetricaComparable,
  isKpiMetric,
  normalizarEtiquetaDeMetrica,
  unidadDeMetrica,
  validarMetricaDeKpi,
  validarValorDeKpi,
} from './kpi-metrics';

describe('catálogo cerrado de métricas', () => {
  it('lista exacta: ocho conteos, la tasa de interacción y other', () => {
    expect([...KPI_METRICS]).toEqual([
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
    ]);
    expect(isKpiMetric('cpm')).toBe(false);
    expect(isKpiMetric('cost')).toBe(false);
  });

  it('unidad por métrica: conteos → count, engagement_rate → percent, other → other', () => {
    for (const m of KPI_COUNT_METRICS) expect(unidadDeMetrica(m)).toBe('count');
    expect(unidadDeMetrica('engagement_rate')).toBe('percent');
    expect(unidadDeMetrica('other')).toBe('other');
  });

  it('solo other es no comparable', () => {
    for (const m of KPI_METRICS) expect(esMetricaComparable(m), m).toBe(m !== 'other');
  });
});

describe('validarMetricaDeKpi', () => {
  it('deriva la unidad y rechaza una unidad que no es la de la métrica', () => {
    const r = validarMetricaDeKpi({ metric: 'views' });
    expect(r.ok && r.value).toEqual({ metric: 'views', unit: 'count', otherLabel: null });
    const mala = validarMetricaDeKpi({ metric: 'views', unit: 'percent' });
    expect(!mala.ok && mala.error.details).toMatchObject({ field: 'unit', reason: 'unit_mismatch' });
  });

  it('other exige etiqueta; el resto la prohíbe', () => {
    const sin = validarMetricaDeKpi({ metric: 'other' });
    expect(!sin.ok && sin.error.details).toMatchObject({ field: 'otherLabel' });
    const con = validarMetricaDeKpi({ metric: 'other', otherLabel: '  Menciones   de marca ' });
    expect(con.ok && con.value).toEqual({ metric: 'other', unit: 'other', otherLabel: 'Menciones de marca' });
    const sobra = validarMetricaDeKpi({ metric: 'likes', otherLabel: 'x' });
    expect(!sobra.ok && sobra.error.details).toMatchObject({ reason: 'other_label_not_allowed' });
  });

  it('métrica fuera del catálogo', () => {
    const r = validarMetricaDeKpi({ metric: 'cpv' });
    expect(!r.ok && r.error.details).toMatchObject({ field: 'metric', reason: 'metric_not_in_catalog' });
  });

  it('etiqueta: sin vacío, sin control, con tope', () => {
    expect(normalizarEtiquetaDeMetrica('   ').ok).toBe(false);
    expect(normalizarEtiquetaDeMetrica('a\u0000b').ok).toBe(false);
    expect(normalizarEtiquetaDeMetrica('x'.repeat(81)).ok).toBe(false);
    const ok = normalizarEtiquetaDeMetrica('Menciones');
    expect(ok.ok && ok.value.key).toBe('menciones');
  });
});

describe('validarValorDeKpi', () => {
  it('value ≥ 0, finito, y los conteos enteros', () => {
    expect(validarValorDeKpi('views', 0).ok).toBe(true);
    expect(validarValorDeKpi('views', 12000).ok).toBe(true);
    expect(validarValorDeKpi('views', -1).ok).toBe(false);
    expect(validarValorDeKpi('views', 10.5).ok).toBe(false);
    expect(validarValorDeKpi('views', Number.NaN).ok).toBe(false);
    expect(validarValorDeKpi('views', Number.POSITIVE_INFINITY).ok).toBe(false);
    expect(validarValorDeKpi('views', '100' as unknown as number).ok).toBe(false);
  });

  it('engagement_rate: 0–100 puntos, hasta 4 decimales', () => {
    expect(validarValorDeKpi('engagement_rate', 4.7).ok).toBe(true);
    expect(validarValorDeKpi('engagement_rate', 0).ok).toBe(true);
    expect(validarValorDeKpi('engagement_rate', 100).ok).toBe(true);
    expect(validarValorDeKpi('engagement_rate', 100.01).ok).toBe(false);
    expect(validarValorDeKpi('engagement_rate', 4.12345).ok).toBe(false);
  });
});
