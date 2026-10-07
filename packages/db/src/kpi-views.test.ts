/**
 * V2 · Fase 8 (W2a) — lecturas de KPI: marcador (público/interno), historial y resumen por campaña.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { closePool, getPool } from './client.ts';
import { retirarInfluencerDeCampana } from './campaign-influencers.ts';
import { corregirMedicionKpi, registrarMedicionKpi } from './kpi-measurements.ts';
import { registrarKpiObjetivo, retirarKpiObjetivo } from './kpi-targets.ts';
import {
  campanaConParticipacionDePrueba,
  codigo,
  exito,
  nuevaParticipacionDePrueba,
} from './kpi-test-support.ts';
import { obtenerHistorialDeKpi, obtenerKpiDeParticipacion, obtenerResumenKpiDeCampana } from './kpi-views.ts';
import {
  type EscenarioDeOperacion,
  claveDePrueba as clave,
  crearEscenarioDeOperacion,
  limpiarEscenarioDeOperacion,
} from './test-utils.ts';

let op: EscenarioDeOperacion;

beforeAll(async () => {
  op = await crearEscenarioDeOperacion('F8 kpi vistas', { conAcuerdoAjeno: false });
});

afterAll(async () => {
  await limpiarEscenarioDeOperacion(op);
  await closePool();
});

const dia = (n: number) => new Date(Date.now() - n * 24 * 3600 * 1000).toISOString();
const MOTIVO = 'SENTINELA-MOTIVO-correccion-5521';

async function objetivo(ci: string, extra: Record<string, unknown> = {}) {
  return exito(
    await registrarKpiObjetivo(op.consultor, {
      campaignInfluencerId: ci,
      metric: 'views',
      targetValue: 10_000,
      idempotencyKey: clave('t'),
      ...extra,
    } as never),
  ).objetivo;
}
async function medir(ci: string, extra: Record<string, unknown> = {}) {
  return exito(
    await registrarMedicionKpi(op.operativo, {
      campaignInfluencerId: ci,
      metric: 'views',
      value: 12_000,
      observedAt: dia(1),
      idempotencyKey: clave('m'),
      ...extra,
    } as never),
  ).medicion;
}

describe('marcador de la participación', () => {
  it('objetivo · actual · logro · estado por métrica, sin sumar entre métricas', async () => {
    const p = await nuevaParticipacionDePrueba(op);
    await objetivo(p, { metric: 'views', targetValue: 10_000 });
    await objetivo(p, { metric: 'reach', targetValue: 5000 });
    await objetivo(p, { metric: 'engagement_rate', targetValue: 4 });
    await objetivo(p, { metric: 'likes', targetValue: 800, comparator: 'lte' });
    await objetivo(p, { metric: 'other', otherLabel: 'Menciones', targetValue: 3 });
    await medir(p, { metric: 'views', value: 12_000 });
    await medir(p, { metric: 'reach', value: 3000 });
    await medir(p, { metric: 'likes', value: 700 });
    await medir(p, { metric: 'other', otherLabel: 'Menciones', value: 3 });

    const r = exito(await obtenerKpiDeParticipacion(op.consultor, p));
    const por = (m: string) => r.public.find((x) => x.metric === m)!;
    expect(por('views')).toMatchObject({
      target: 10_000,
      actual: 12_000,
      achievement: 120,
      estado: 'cumplido',
      unit: 'count',
    });
    expect(por('reach')).toMatchObject({ target: 5000, actual: 3000, achievement: 60, estado: 'por_debajo' });
    expect(por('engagement_rate')).toMatchObject({ actual: null, estado: 'sin_medicion', unit: 'percent' });
    expect(por('likes')).toMatchObject({ comparator: 'lte', actual: 700, estado: 'cumplido' });
    expect(por('other')).toMatchObject({ otherLabel: 'Menciones', actual: null, estado: 'no_comparable' });
    expect(r.resumen).toMatchObject({
      objetivos: 5,
      cumplidos: 2,
      porDebajo: 1,
      noComparables: 1,
      estado: 'parcial',
    });
    // Orden estable del catálogo.
    expect(r.public.map((x) => x.metric)).toEqual(['views', 'reach', 'likes', 'engagement_rate', 'other']);
  });

  it('la medición vigente es la última observación no corregida', async () => {
    const p = await nuevaParticipacionDePrueba(op);
    await objetivo(p, { targetValue: 10_000 });
    const vieja = await medir(p, { value: 3000, observedAt: dia(10) });
    const reciente = await medir(p, { value: 9000, observedAt: dia(2) });
    let r = exito(await obtenerKpiDeParticipacion(op.consultor, p));
    expect(r.public[0]).toMatchObject({ actual: 9000, estado: 'por_debajo' });
    // Una observación MÁS NUEVA manda aunque se registrara antes.
    await medir(p, { value: 4000, observedAt: dia(5) });
    r = exito(await obtenerKpiDeParticipacion(op.consultor, p));
    expect(r.public[0]!.actual).toBe(9000);
    // Corregir la vigente cambia el estado; la corregida deja de contar.
    exito(
      await corregirMedicionKpi(op.operativo, reciente.id, {
        value: 15_000,
        correctionReason: MOTIVO,
        idempotencyKey: clave(),
      }),
    );
    r = exito(await obtenerKpiDeParticipacion(op.consultor, p));
    expect(r.public[0]).toMatchObject({ actual: 15_000, estado: 'cumplido', achievement: 150 });
    expect(r.internal[0]).toMatchObject({ measurementIsCorrection: true, correctionReason: MOTIVO });
    expect(vieja.id).not.toBe(reciente.id);
  });

  it('no mezcla entregables ni plataformas: cada medición solo cuenta en su ámbito', async () => {
    const p = op.participaciones.valentinaRios;
    const q = await nuevaParticipacionDePrueba(op);
    // Objetivo de la participación entera; la medición del entregable NO lo cumple (no se suma).
    await objetivo(p, { metric: 'saves', targetValue: 100 });
    await medir(p, { metric: 'saves', value: 500, deliverableId: op.entregables.reelRios });
    await objetivo(p, { metric: 'saves', targetValue: 80, deliverableId: op.entregables.reelRios });
    await objetivo(p, { metric: 'saves', targetValue: 80, deliverableId: op.entregables.storyRios });
    await medir(p, { metric: 'saves', value: 60, deliverableId: op.entregables.storyRios });
    const r = exito(await obtenerKpiDeParticipacion(op.consultor, p));
    const saves = r.public.filter((x) => x.metric === 'saves');
    expect(saves).toHaveLength(3);
    const de = (d: string | null) => saves.find((x) => x.deliverableId === d)!;
    expect(de(null)).toMatchObject({ actual: null, estado: 'sin_medicion' });
    expect(de(op.entregables.reelRios)).toMatchObject({ actual: 500, estado: 'cumplido' });
    expect(de(op.entregables.storyRios)).toMatchObject({ actual: 60, estado: 'por_debajo' });
    // Otra participación no se contamina.
    expect(exito(await obtenerKpiDeParticipacion(op.consultor, q)).public).toEqual([]);
    expect(exito(await obtenerKpiDeParticipacion(op.consultor, q)).resumen.estado).toBe('sin_objetivos');
    // Plataforma: objetivo de instagram con medición de tiktok ⇒ sin medición.
    await objetivo(q, { metric: 'views', platform: 'instagram' });
    await medir(q, { metric: 'views', platform: 'tiktok', value: 99_999 });
    expect(exito(await obtenerKpiDeParticipacion(op.consultor, q)).public[0]).toMatchObject({
      actual: null,
      estado: 'sin_medicion',
    });
  });

  it('el bloque público no lleva actor, motivo, origen ni procedencia; el interno sí', async () => {
    const p = await nuevaParticipacionDePrueba(op);
    await objetivo(p);
    const m = await medir(p, { value: 1000 });
    exito(
      await corregirMedicionKpi(op.operativo, m.id, {
        value: 2000,
        correctionReason: MOTIVO,
        idempotencyKey: clave(),
      }),
    );
    const r = exito(await obtenerKpiDeParticipacion(op.operativo, p));
    expect(Object.keys(r.public[0]!).sort()).toEqual(
      [
        'metric',
        'otherLabel',
        'unit',
        'comparator',
        'target',
        'actual',
        'delta',
        'achievement',
        'estado',
        'observedAt',
        'deliverableId',
        'platform',
      ].sort(),
    );
    const textoPublico = JSON.stringify(r.public);
    for (const prohibido of [
      MOTIVO,
      op.consultor.id,
      op.operativo.id,
      op.consultor.name,
      op.operativo.name,
      'sheet',
      'chat',
      'manual',
    ]) {
      expect(textoPublico, prohibido).not.toContain(prohibido);
    }
    const interno = r.internal[0]!;
    expect(interno).toMatchObject({
      targetCreatedBy: op.consultor.id,
      targetCreatedByName: op.consultor.name,
      targetOrigin: 'manual',
      targetOriginChannel: 'ui',
      measurementRecordedBy: op.operativo.id,
      measurementRecordedByName: op.operativo.name,
      measurementOriginChannel: 'ui',
      correctionReason: MOTIVO,
      sheetProvenance: null,
    });
  });

  it('un objetivo retirado sale del marcador; una participación retirada sigue siendo legible', async () => {
    const p = await nuevaParticipacionDePrueba(op);
    const t = await objetivo(p);
    await objetivo(p, { metric: 'reach', targetValue: 1 });
    await medir(p);
    exito(await retirarKpiObjetivo(op.consultor, t.id));
    exito(await retirarInfluencerDeCampana(op.admin, p, { motivo: 'prueba' }));
    const r = exito(await obtenerKpiDeParticipacion(op.consultor, p));
    expect(r.public.map((x) => x.metric)).toEqual(['reach']);
  });

  it('permisos: admin, director, consultor y operativo leen; analista/legal FORBIDDEN_ROLE; cliente/ajeno NOT_FOUND', async () => {
    const p = await nuevaParticipacionDePrueba(op);
    for (const a of [op.admin, op.director, op.consultor, op.operativo]) {
      expect(codigo(await obtenerKpiDeParticipacion(a, p)), a.role).toBe('OK');
    }
    expect(codigo(await obtenerKpiDeParticipacion(op.analista, p))).toBe('FORBIDDEN_ROLE');
    expect(codigo(await obtenerKpiDeParticipacion(op.legal, p))).toBe('FORBIDDEN_ROLE');
    expect(codigo(await obtenerKpiDeParticipacion(op.cliente, p))).toBe('RESOURCE_NOT_FOUND');
    expect(codigo(await obtenerKpiDeParticipacion(op.ajeno, p))).toBe('RESOURCE_NOT_FOUND');
    expect(codigo(await obtenerKpiDeParticipacion(op.consultor, op.ajena.participacion))).toBe(
      'RESOURCE_NOT_FOUND',
    );
    expect(codigo(await obtenerKpiDeParticipacion(op.consultor, 'no-es-uuid'))).toBe('RESOURCE_NOT_FOUND');
  });
});

describe('historial', () => {
  it('cadena completa: objetivos reemplazados y retirados, mediciones y correcciones, con current/corrected', async () => {
    const p = await nuevaParticipacionDePrueba(op);
    const t1 = await objetivo(p, { targetValue: 100 });
    const t2 = await objetivo(p, { targetValue: 200, supersedesId: t1.id });
    exito(await retirarKpiObjetivo(op.consultor, t2.id));
    const m1 = await medir(p, { value: 10, observedAt: dia(3) });
    const m2 = exito(
      await corregirMedicionKpi(op.operativo, m1.id, {
        value: 20,
        correctionReason: MOTIVO,
        idempotencyKey: clave(),
      }),
    ).medicion;
    const m3 = await medir(p, { metric: 'reach', value: 7 });

    const h = exito(await obtenerHistorialDeKpi(op.consultor, { campaignInfluencerId: p }));
    expect(h.public.targets.map((t) => [t.id, t.status, t.supersedesId])).toEqual([
      [t1.id, 'superseded', null],
      [t2.id, 'retired', t1.id],
    ]);
    expect(h.public.measurements.map((m) => [m.id, m.corrected, m.current, m.supersedesId])).toEqual([
      [m1.id, true, false, null],
      [m2.id, false, true, m1.id],
      [m3.id, false, true, null],
    ]);
    const filtrado = exito(
      await obtenerHistorialDeKpi(op.consultor, { campaignInfluencerId: p, metric: 'reach' }),
    );
    expect(filtrado.public.measurements.map((m) => m.id)).toEqual([m3.id]);
    expect(filtrado.public.targets).toEqual([]);
    expect(
      codigo(await obtenerHistorialDeKpi(op.consultor, { campaignInfluencerId: p, metric: 'cpm' as never })),
    ).toBe('VALIDATION_FAILED');

    // Lo público no lleva actor ni motivo; lo interno sí.
    expect(JSON.stringify(h.public)).not.toContain(MOTIVO);
    expect(JSON.stringify(h.public)).not.toContain(op.operativo.id);
    expect(JSON.stringify(h.public)).not.toContain(op.consultor.id);
    expect(h.internal.measurements.find((m) => m.id === m2.id)).toMatchObject({
      correctionReason: MOTIVO,
      recordedBy: op.operativo.id,
      originChannel: 'ui',
    });
    expect(h.internal.targets.find((t) => t.id === t2.id)).toMatchObject({
      createdBy: op.consultor.id,
      origin: 'manual',
    });
  });

  it('permisos y aislamiento', async () => {
    const p = await nuevaParticipacionDePrueba(op);
    expect(codigo(await obtenerHistorialDeKpi(op.operativo, { campaignInfluencerId: p }))).toBe('OK');
    expect(codigo(await obtenerHistorialDeKpi(op.analista, { campaignInfluencerId: p }))).toBe(
      'FORBIDDEN_ROLE',
    );
    expect(codigo(await obtenerHistorialDeKpi(op.cliente, { campaignInfluencerId: p }))).toBe(
      'RESOURCE_NOT_FOUND',
    );
    expect(codigo(await obtenerHistorialDeKpi(op.ajeno, { campaignInfluencerId: p }))).toBe(
      'RESOURCE_NOT_FOUND',
    );
  });
});

describe('resumen por campaña (por lotes)', () => {
  it('mapa por participación con el estado de cada una, en pocas consultas', async () => {
    const c = await campanaConParticipacionDePrueba(op, 'activa');
    const campaignId = c.campaignId;
    const sin = c.participacion;
    const sinMediciones = await nuevaParticipacionDePrueba(op, campaignId);
    const parcial = await nuevaParticipacionDePrueba(op, campaignId);
    const completa = await nuevaParticipacionDePrueba(op, campaignId);
    await objetivo(sinMediciones, { metric: 'views' });
    await objetivo(parcial, { metric: 'views' });
    await objetivo(parcial, { metric: 'reach' });
    await medir(parcial, { metric: 'views', value: 20_000 });
    await objetivo(completa, { metric: 'views' });
    await objetivo(completa, { metric: 'reach', targetValue: 100 });
    await medir(completa, { metric: 'views', value: 20_000 });
    await medir(completa, { metric: 'reach', value: 10 });

    const consultas = vi.spyOn(getPool(), 'query');
    const r = exito(await obtenerResumenKpiDeCampana(op.operativo, campaignId));
    // campaña + participaciones + objetivos + mediciones: sin N+1.
    expect(consultas.mock.calls.length).toBeLessThanOrEqual(4);
    consultas.mockRestore();

    expect(r.size).toBe(4);
    expect(r.get(sin)).toMatchObject({ objetivos: 0, estado: 'sin_objetivos' });
    expect(r.get(sinMediciones)).toMatchObject({ objetivos: 1, conMedicion: 0, estado: 'sin_mediciones' });
    expect(r.get(parcial)).toMatchObject({ objetivos: 2, conMedicion: 1, cumplidos: 1, estado: 'parcial' });
    expect(r.get(completa)).toEqual({
      objetivos: 2,
      conMedicion: 2,
      cumplidos: 1,
      porDebajo: 1,
      noComparables: 0,
      estado: 'completo',
    });
    // Coherente con el marcador individual.
    expect(exito(await obtenerKpiDeParticipacion(op.operativo, completa)).resumen).toEqual(r.get(completa));
  });

  it('permisos y aislamiento', async () => {
    expect(codigo(await obtenerResumenKpiDeCampana(op.consultor, op.campanaId))).toBe('OK');
    expect(codigo(await obtenerResumenKpiDeCampana(op.analista, op.campanaId))).toBe('FORBIDDEN_ROLE');
    expect(codigo(await obtenerResumenKpiDeCampana(op.cliente, op.campanaId))).toBe('RESOURCE_NOT_FOUND');
    expect(codigo(await obtenerResumenKpiDeCampana(op.ajeno, op.campanaId))).toBe('RESOURCE_NOT_FOUND');
    expect(codigo(await obtenerResumenKpiDeCampana(op.consultor, op.campanaAjenaId))).toBe(
      'RESOURCE_NOT_FOUND',
    );
    expect(codigo(await obtenerResumenKpiDeCampana(op.consultor, 'no-es-uuid'))).toBe('RESOURCE_NOT_FOUND');
  });
});
