import { describe, expect, it } from 'vitest';
import {
  type MedicionDeKpi,
  type ObjetivoDeKpi,
  compararKpi,
  compararKpis,
  medicionVigenteDe,
  medicionesNoCorregidas,
} from './kpi-compare';

const CI = 'ci-1';
const base = { campaignInfluencerId: CI, deliverableId: null, platform: null, otherLabel: null } as const;

function objetivo(extra: Partial<ObjetivoDeKpi> = {}): ObjetivoDeKpi {
  return {
    id: 't1',
    metric: 'views',
    unit: 'count',
    targetValue: 10_000,
    comparator: 'gte',
    ...base,
    ...extra,
  };
}
let seq = 0;
function medicion(extra: Partial<MedicionDeKpi> = {}): MedicionDeKpi {
  seq++;
  return {
    id: `m${seq}`,
    metric: 'views',
    unit: 'count',
    value: 12_000,
    observedAt: '2026-10-01T00:00:00.000Z',
    seq,
    supersedesId: null,
    ...base,
    ...extra,
  };
}

describe('compararKpi', () => {
  it('sin medición', () => {
    const c = compararKpi(objetivo(), undefined);
    expect(c.estado).toBe('sin_medicion');
    expect(c.actual).toBeNull();
    expect(c.target).toBe(10_000);
  });

  it('gte: cumplido, por debajo y el borde', () => {
    const cumplido = compararKpi(objetivo(), medicion({ value: 12_000 }));
    expect(cumplido).toMatchObject({ estado: 'cumplido', actual: 12_000, delta: 2000, achievement: 120 });
    expect(compararKpi(objetivo(), medicion({ value: 10_000 })).estado).toBe('cumplido');
    const bajo = compararKpi(objetivo(), medicion({ value: 7_500 }));
    expect(bajo).toMatchObject({ estado: 'por_debajo', delta: -2500, achievement: 75 });
  });

  it('lte: cumple cuando actual ≤ objetivo', () => {
    const o = objetivo({ comparator: 'lte', targetValue: 100 });
    expect(compararKpi(o, medicion({ value: 80 })).estado).toBe('cumplido');
    expect(compararKpi(o, medicion({ value: 100 })).estado).toBe('cumplido');
    expect(compararKpi(o, medicion({ value: 101 })).estado).toBe('por_debajo');
  });

  it('objetivo 0: achievement null, el estado lo decide el comparador', () => {
    const c = compararKpi(objetivo({ targetValue: 0, comparator: 'lte' }), medicion({ value: 0 }));
    expect(c).toMatchObject({ estado: 'cumplido', achievement: null });
  });

  it('unidades incompatibles ⇒ no_comparable, sin cifras', () => {
    const c = compararKpi(objetivo(), medicion({ unit: 'percent' }));
    expect(c).toMatchObject({ estado: 'no_comparable', actual: null, delta: null, achievement: null });
  });

  it('métrica distinta ⇒ no_comparable', () => {
    expect(compararKpi(objetivo(), medicion({ metric: 'reach' })).estado).toBe('no_comparable');
  });

  it('una unidad que no es la del catálogo ⇒ no_comparable aunque coincidan', () => {
    const c = compararKpi(objetivo({ unit: 'percent' }), medicion({ unit: 'percent' }));
    expect(c.estado).toBe('no_comparable');
  });

  it('ámbito distinto ⇒ no_comparable (entregable, plataforma, participación)', () => {
    expect(compararKpi(objetivo(), medicion({ deliverableId: 'd1' })).estado).toBe('no_comparable');
    expect(compararKpi(objetivo({ deliverableId: 'd1' }), medicion()).estado).toBe('no_comparable');
    expect(compararKpi(objetivo({ platform: 'instagram' }), medicion({ platform: 'tiktok' })).estado).toBe(
      'no_comparable',
    );
    expect(compararKpi(objetivo(), medicion({ campaignInfluencerId: 'otra' })).estado).toBe('no_comparable');
    expect(compararKpi(objetivo({ platform: 'instagram' }), medicion({ platform: 'instagram' })).estado).toBe(
      'cumplido',
    );
  });

  it('other NUNCA se compara, ni con medición idéntica ni sin medición', () => {
    const o = objetivo({ metric: 'other', unit: 'other', otherLabel: 'Menciones', targetValue: 5 });
    const m = medicion({ metric: 'other', unit: 'other', otherLabel: 'Menciones', value: 5 });
    expect(compararKpi(o, m)).toMatchObject({ estado: 'no_comparable', actual: null });
    expect(compararKpi(o, undefined).estado).toBe('no_comparable');
  });
});

describe('medición vigente', () => {
  it('la última observación no corregida', () => {
    const a = medicion({ observedAt: '2026-10-01T00:00:00.000Z', value: 1000 });
    const b = medicion({ observedAt: '2026-10-05T00:00:00.000Z', value: 2000 });
    const c = medicion({ observedAt: '2026-10-03T00:00:00.000Z', value: 1500 });
    expect(medicionVigenteDe(objetivo(), [a, b, c])?.id).toBe(b.id);
  });

  it('una corrección reemplaza a la corregida; la corregida ya no cuenta', () => {
    const original = medicion({ observedAt: '2026-10-05T00:00:00.000Z', value: 9000 });
    const corregida = medicion({
      observedAt: '2026-10-05T00:00:00.000Z',
      value: 11_000,
      supersedesId: original.id,
    });
    expect(medicionesNoCorregidas([original, corregida]).map((m) => m.id)).toEqual([corregida.id]);
    expect(medicionVigenteDe(objetivo(), [original, corregida])?.value).toBe(11_000);
    expect(compararKpi(objetivo(), medicionVigenteDe(objetivo(), [original, corregida])).estado).toBe(
      'cumplido',
    );
  });

  it('cadena de correcciones: solo cuenta la última', () => {
    const m1 = medicion({ value: 1 });
    const m2 = medicion({ value: 2, supersedesId: m1.id });
    const m3 = medicion({ value: 3, supersedesId: m2.id });
    expect(medicionVigenteDe(objetivo(), [m3, m1, m2])?.id).toBe(m3.id);
  });

  it('empate de observación: manda el orden de registro', () => {
    const a = medicion({ value: 1 });
    const b = medicion({ value: 2 });
    expect(medicionVigenteDe(objetivo(), [a, b])?.id).toBe(b.id);
  });

  it('no mezcla métricas, entregables ni plataformas', () => {
    const otraMetrica = medicion({ metric: 'reach', value: 99_999 });
    const otroEntregable = medicion({ deliverableId: 'd1', value: 99_999 });
    const otraPlataforma = medicion({ platform: 'tiktok', value: 99_999 });
    expect(medicionVigenteDe(objetivo(), [otraMetrica, otroEntregable, otraPlataforma])).toBeUndefined();
  });
});

describe('compararKpis: nunca suma entre métricas ni entregables', () => {
  it('cada objetivo toma su propia medición', () => {
    const oViews = objetivo({ id: 'v', metric: 'views', targetValue: 10_000 });
    const oReach = objetivo({ id: 'r', metric: 'reach', targetValue: 8_000 });
    const oViewsD1 = objetivo({ id: 'vd', deliverableId: 'd1', targetValue: 5_000 });
    const mediciones = [
      medicion({ metric: 'views', value: 6_000 }),
      medicion({ metric: 'reach', value: 9_000 }),
      medicion({ deliverableId: 'd1', value: 4_000 }),
    ];
    const r = compararKpis([oViews, oReach, oViewsD1], mediciones);
    expect(r.map((c) => [c.targetId, c.actual, c.estado])).toEqual([
      ['v', 6_000, 'por_debajo'],
      ['r', 9_000, 'cumplido'],
      ['vd', 4_000, 'por_debajo'],
    ]);
  });
});
