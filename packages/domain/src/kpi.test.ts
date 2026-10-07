import { describe, expect, it } from 'vitest';
import { type ComparacionDeKpi } from './kpi-compare';
import {
  RESUMEN_KPI_VACIO,
  resumirKpi,
  validarClaveDeKpi,
  validarFechaDeKpi,
  validarMedicionDeKpi,
  validarMotivoDeCorreccionDeKpi,
  validarObjetivoDeKpi,
} from './kpi';

function comp(estado: ComparacionDeKpi['estado'], conMedicion = estado !== 'sin_medicion'): ComparacionDeKpi {
  return {
    targetId: Math.random().toString(36),
    metric: 'views',
    otherLabel: null,
    unit: 'count',
    comparator: 'gte',
    deliverableId: null,
    platform: null,
    target: 10,
    actual: estado === 'cumplido' || estado === 'por_debajo' ? 10 : null,
    delta: null,
    achievement: null,
    estado,
    observedAt: null,
    measurementId: conMedicion ? 'm' : null,
  };
}

describe('resumirKpi', () => {
  it('sin objetivos', () => {
    expect(resumirKpi([])).toEqual(RESUMEN_KPI_VACIO);
    expect(resumirKpi([]).estado).toBe('sin_objetivos');
  });

  it('sin mediciones', () => {
    expect(resumirKpi([comp('sin_medicion'), comp('sin_medicion')])).toMatchObject({
      objetivos: 2,
      conMedicion: 0,
      estado: 'sin_mediciones',
    });
  });

  it('parcial y completo', () => {
    expect(resumirKpi([comp('cumplido'), comp('sin_medicion')])).toMatchObject({
      objetivos: 2,
      conMedicion: 1,
      cumplidos: 1,
      estado: 'parcial',
    });
    expect(resumirKpi([comp('cumplido'), comp('por_debajo'), comp('no_comparable', false)])).toEqual({
      objetivos: 3,
      conMedicion: 2,
      cumplidos: 1,
      porDebajo: 1,
      noComparables: 1,
      estado: 'parcial',
    });
    expect(resumirKpi([comp('cumplido'), comp('por_debajo'), comp('no_comparable', true)])).toMatchObject({
      conMedicion: 3,
      estado: 'completo',
    });
  });
});

describe('validadores', () => {
  it('objetivo: comparador por omisión gte, unidad derivada, periodo ordenado', () => {
    const r = validarObjetivoDeKpi({ metric: 'engagement_rate', targetValue: 4.7 });
    expect(r.ok && r.value).toMatchObject({
      metric: 'engagement_rate',
      unit: 'percent',
      comparator: 'gte',
      platform: null,
      periodStart: null,
    });
    expect(validarObjetivoDeKpi({ metric: 'views', targetValue: 1, comparator: 'eq' }).ok).toBe(false);
    expect(validarObjetivoDeKpi({ metric: 'views', targetValue: 1, platform: 'myspace' }).ok).toBe(false);
    expect(
      validarObjetivoDeKpi({
        metric: 'views',
        targetValue: 1,
        periodStart: '2026-10-10',
        periodEnd: '2026-10-01',
      }).ok,
    ).toBe(false);
    expect(validarObjetivoDeKpi({ metric: 'views', targetValue: -5 }).ok).toBe(false);
    expect(validarObjetivoDeKpi({ metric: 'engagement_rate', targetValue: 101 }).ok).toBe(false);
  });

  it('medición: no en el futuro, valor y unidad del catálogo', () => {
    const ahora = new Date('2026-10-07T12:00:00.000Z');
    const r = validarMedicionDeKpi(
      { metric: 'views', value: 100, observedAt: '2026-10-06T10:00:00Z' },
      ahora,
    );
    expect(r.ok && r.value.observedAt).toBe('2026-10-06T10:00:00.000Z');
    expect(
      validarMedicionDeKpi({ metric: 'views', value: 100, observedAt: '2027-01-01T00:00:00Z' }, ahora).ok,
    ).toBe(false);
    expect(validarMedicionDeKpi({ metric: 'views', value: 100, observedAt: 'ayer' }, ahora).ok).toBe(false);
    expect(
      validarMedicionDeKpi({ metric: 'views', value: 100.5, observedAt: new Date(ahora) }, ahora).ok,
    ).toBe(false);
  });

  it('fecha, clave y motivo', () => {
    expect(validarFechaDeKpi('2026-02-30', 'periodStart').ok).toBe(false);
    expect(validarFechaDeKpi(null, 'periodStart')).toMatchObject({ ok: true, value: null });
    expect(validarClaveDeKpi(' x').ok).toBe(false);
    expect(validarClaveDeKpi('').ok).toBe(false);
    expect(validarClaveDeKpi('abc').ok).toBe(true);
    expect(validarMotivoDeCorreccionDeKpi('   ').ok).toBe(false);
    expect(validarMotivoDeCorreccionDeKpi('x'.repeat(501)).ok).toBe(false);
    const m = validarMotivoDeCorreccionDeKpi('  Error   de digitación ');
    expect(m.ok && m.value).toBe('Error de digitación');
  });
});

describe('endurecimiento (FIX-B): claves, fechas y observación fuera de rango', () => {
  it('la clave de idempotencia rechaza bidi e invisibles', () => {
    expect(validarClaveDeKpi('kpi-1').ok).toBe(true);
    for (const mala of ['k\u202E', 'k\u200B', 'k\u0000', ' k', '']) {
      expect(validarClaveDeKpi(mala).ok, JSON.stringify(mala)).toBe(false);
    }
  });

  it('el periodo y la observación en el año 0000 son validación, no un 500', () => {
    expect(validarFechaDeKpi('0000-01-01', 'periodStart').ok).toBe(false);
    expect(validarFechaDeKpi('1899-12-31', 'periodStart').ok).toBe(false);
    expect(validarFechaDeKpi('2026-03-01', 'periodStart').ok).toBe(true);
    const m = validarMedicionDeKpi({ metric: 'views', value: 1, observedAt: '0000-01-01T00:00:00Z' });
    expect(m.ok).toBe(false);
    if (!m.ok) expect(m.error.details).toMatchObject({ field: 'observedAt', reason: 'out_of_range' });
    expect(validarMedicionDeKpi({ metric: 'views', value: 1, observedAt: '2026-03-01T00:00:00Z' }).ok).toBe(
      true,
    );
  });
});
