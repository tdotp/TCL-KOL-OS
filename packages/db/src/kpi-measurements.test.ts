/**
 * V2 · Fase 8 (W2a) — mediciones de KPI: registro idempotente, correcciones (historia intacta, una sola por
 * fila, concurrencia), permisos, aislamiento y estado de la campaña.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePool, query } from './client.ts';
import { retirarInfluencerDeCampana } from './campaign-influencers.ts';
import { corregirMedicionKpi, registrarMedicionKpi } from './kpi-measurements.ts';
import {
  campanaConParticipacionDePrueba,
  codigo,
  contar,
  exito,
  nuevaParticipacionDePrueba,
  razon,
} from './kpi-test-support.ts';
import {
  type EscenarioDeOperacion,
  claveDePrueba as clave,
  crearEscenarioDeOperacion,
  limpiarEscenarioDeOperacion,
} from './test-utils.ts';

let op: EscenarioDeOperacion;

beforeAll(async () => {
  op = await crearEscenarioDeOperacion('F8 kpi mediciones', { conAcuerdoAjeno: false });
});

afterAll(async () => {
  await limpiarEscenarioDeOperacion(op);
  await closePool();
});

const AYER = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
const HACE_DOS_DIAS = new Date(Date.now() - 48 * 3600 * 1000).toISOString();

function medicion(ci: string, extra: Record<string, unknown> = {}) {
  return {
    campaignInfluencerId: ci,
    metric: 'views' as const,
    value: 12_000,
    observedAt: AYER,
    idempotencyKey: clave('m'),
    ...extra,
  } as Parameters<typeof registrarMedicionKpi>[1];
}

async function auditoriaDe(entityId: string) {
  return query<{ action: string; origin: string; metadata: Record<string, unknown> }>(
    `SELECT action, origin, metadata FROM audit_events WHERE entity_id = $1 ORDER BY created_at, id`,
    [entityId],
  );
}

describe('registrar una medición', () => {
  it('el operativo mide (unidad del catálogo) y queda auditado sin el valor', async () => {
    const p = await nuevaParticipacionDePrueba(op);
    const r = exito(
      await registrarMedicionKpi(op.operativo, medicion(p, { value: 4.7, metric: 'engagement_rate' })),
    );
    expect(r.repetido).toBe(false);
    expect(r.medicion).toMatchObject({
      metric: 'engagement_rate',
      unit: 'percent',
      value: 4.7,
      supersedesId: null,
      recordedBy: op.operativo.id,
      deliverableId: null,
      platform: null,
    });
    const audit = await auditoriaDe(r.medicion.id);
    expect(audit.map((a) => [a.action, a.origin])).toEqual([['kpi_measurement.recorded', 'ui']]);
    expect(Object.keys(audit[0]!.metadata).sort()).toEqual(
      ['campaignId', 'campaignInfluencerId', 'measurementId', 'metric', 'unit'].sort(),
    );
    expect(JSON.stringify(audit[0]!.metadata)).not.toContain('4.7');
  });

  it('idempotencia: el doble envío devuelve la misma medición', async () => {
    const p = await nuevaParticipacionDePrueba(op);
    const entrada = medicion(p);
    const a = exito(await registrarMedicionKpi(op.operativo, entrada));
    const b = exito(await registrarMedicionKpi(op.operativo, entrada));
    expect(b.repetido).toBe(true);
    expect(b.medicion.id).toBe(a.medicion.id);
    const n = await contar(
      `SELECT count(*)::int AS n FROM kpi_measurements WHERE campaign_influencer_id = $1`,
      [p],
    );
    expect(n).toBe(1);
    expect((await auditoriaDe(a.medicion.id)).length).toBe(1);
  });

  it('idempotencia concurrente: dos envíos simultáneos dejan una sola fila', async () => {
    const p = await nuevaParticipacionDePrueba(op);
    const entrada = medicion(p);
    const [a, b] = await Promise.all([
      registrarMedicionKpi(op.operativo, entrada),
      registrarMedicionKpi(op.operativo, entrada),
    ]);
    expect(exito(a).medicion.id).toBe(exito(b).medicion.id);
    const n = await contar(
      `SELECT count(*)::int AS n FROM kpi_measurements WHERE campaign_influencer_id = $1`,
      [p],
    );
    expect(n).toBe(1);
  });

  it('la misma clave con otro contenido ⇒ RESOURCE_CONFLICT idempotency_key_reused', async () => {
    const p = await nuevaParticipacionDePrueba(op);
    const k = clave();
    exito(await registrarMedicionKpi(op.operativo, medicion(p, { idempotencyKey: k })));
    const r = await registrarMedicionKpi(op.operativo, medicion(p, { idempotencyKey: k, value: 99 }));
    expect(codigo(r)).toBe('RESOURCE_CONFLICT');
    expect(razon(r)).toBe('idempotency_key_reused');
  });

  it('validaciones: valor, unidad, etiqueta other, fecha futura, entregable ajeno', async () => {
    const p = await nuevaParticipacionDePrueba(op);
    const reg = (extra: Record<string, unknown>) =>
      registrarMedicionKpi(op.operativo, medicion(p, { idempotencyKey: clave(), ...extra }));
    expect(codigo(await reg({ value: -1 }))).toBe('VALIDATION_FAILED');
    expect(codigo(await reg({ value: 3.5 }))).toBe('VALIDATION_FAILED');
    expect(codigo(await reg({ metric: 'engagement_rate', value: 100.5 }))).toBe('VALIDATION_FAILED');
    expect(codigo(await reg({ unit: 'percent' }))).toBe('VALIDATION_FAILED');
    expect(codigo(await reg({ metric: 'other' }))).toBe('VALIDATION_FAILED');
    expect(
      codigo(await reg({ observedAt: new Date(Date.now() + 10 * 24 * 3600 * 1000).toISOString() })),
    ).toBe('VALIDATION_FAILED');
    expect(codigo(await reg({ observedAt: 'ayer' }))).toBe('VALIDATION_FAILED');
    expect(razon(await reg({ deliverableId: op.entregables.reelGomez }))).toBe(
      'deliverable_not_in_participation',
    );
    exito(await reg({ metric: 'other', otherLabel: 'Menciones', value: 7.25 }));
    exito(
      await registrarMedicionKpi(
        op.operativo,
        medicion(op.participaciones.valentinaRios, {
          deliverableId: op.entregables.reelRios,
          metric: 'reach',
          value: 100,
          platform: 'instagram',
        }),
      ),
    );
  });
});

describe('permisos y aislamiento', () => {
  it('operativo, director y admin miden; el consultor NO; analista y legal no; cliente/ajeno no ven nada', async () => {
    const p = await nuevaParticipacionDePrueba(op);
    expect(codigo(await registrarMedicionKpi(op.operativo, medicion(p, { metric: 'views' })))).toBe('OK');
    expect(codigo(await registrarMedicionKpi(op.director, medicion(p, { metric: 'reach' })))).toBe('OK');
    expect(codigo(await registrarMedicionKpi(op.admin, medicion(p, { metric: 'likes' })))).toBe('OK');
    expect(codigo(await registrarMedicionKpi(op.consultor, medicion(p)))).toBe('FORBIDDEN_ROLE');
    expect(codigo(await registrarMedicionKpi(op.analista, medicion(p)))).toBe('FORBIDDEN_ROLE');
    expect(codigo(await registrarMedicionKpi(op.legal, medicion(p)))).toBe('FORBIDDEN_ROLE');
    expect(codigo(await registrarMedicionKpi(op.cliente, medicion(p)))).toBe('RESOURCE_NOT_FOUND');
    expect(codigo(await registrarMedicionKpi(op.ajeno, medicion(p)))).toBe('RESOURCE_NOT_FOUND');
    expect(codigo(await registrarMedicionKpi(op.operativo, medicion(op.ajena.participacion)))).toBe(
      'RESOURCE_NOT_FOUND',
    );
    expect(codigo(await registrarMedicionKpi(op.operativo, medicion('no-es-uuid')))).toBe(
      'RESOURCE_NOT_FOUND',
    );
    const n = await contar(
      `SELECT count(*)::int AS n FROM kpi_measurements WHERE campaign_influencer_id = $1`,
      [p],
    );
    expect(n).toBe(3);
  });

  it('solo por la interfaz: el chat y el sistema no registran ni corrigen', async () => {
    const p = await nuevaParticipacionDePrueba(op);
    const m = exito(await registrarMedicionKpi(op.operativo, medicion(p))).medicion;
    const chat = { origin: 'chat' as const, correlation: { toolInvocationId: 'tool-1' } };
    expect(codigo(await registrarMedicionKpi(op.operativo, medicion(p), chat))).toBe(
      'HUMAN_CONFIRMATION_REQUIRED',
    );
    expect(codigo(await registrarMedicionKpi(op.operativo, medicion(p), { origin: 'system' }))).toBe(
      'FORBIDDEN_ROLE',
    );
    expect(codigo(await registrarMedicionKpi('system' as never, medicion(p)))).toBe('FORBIDDEN_ROLE');
    expect(
      codigo(
        await corregirMedicionKpi(
          op.operativo,
          m.id,
          { value: 1, correctionReason: 'x', idempotencyKey: clave() },
          chat,
        ),
      ),
    ).toBe('HUMAN_CONFIRMATION_REQUIRED');
    const n = await contar(
      `SELECT count(*)::int AS n FROM kpi_measurements WHERE campaign_influencer_id = $1`,
      [p],
    );
    expect(n).toBe(1);
  });
});

describe('estado de la campaña y de la participación', () => {
  it('activa y archivada admiten mediciones; cancelada no', async () => {
    const activa = await campanaConParticipacionDePrueba(op, 'activa');
    const archivada = await campanaConParticipacionDePrueba(op, 'archivada');
    const cancelada = await campanaConParticipacionDePrueba(op, 'cancelada');
    expect(codigo(await registrarMedicionKpi(op.operativo, medicion(activa.participacion)))).toBe('OK');
    expect(codigo(await registrarMedicionKpi(op.operativo, medicion(archivada.participacion)))).toBe('OK');
    const r = await registrarMedicionKpi(op.operativo, medicion(cancelada.participacion));
    expect(codigo(r)).toBe('RESOURCE_CONFLICT');
    expect(razon(r)).toBe('campaign_cancelled');
  });

  it('una participación retirada conserva su historia y admite que se complete', async () => {
    const p = await nuevaParticipacionDePrueba(op);
    exito(await registrarMedicionKpi(op.operativo, medicion(p)));
    exito(await retirarInfluencerDeCampana(op.admin, p, { motivo: 'prueba' }));
    expect(codigo(await registrarMedicionKpi(op.operativo, medicion(p, { value: 13_000 })))).toBe('OK');
  });

  it('también por la base: una medición en campaña cancelada se rechaza por SQL directo', async () => {
    const cancelada = await campanaConParticipacionDePrueba(op, 'cancelada');
    await expect(
      query(
        `INSERT INTO kpi_measurements (organization_id, campaign_id, campaign_influencer_id, metric, unit, value, observed_at,
                                       recorded_by, idempotency_key, request_hash)
         VALUES ($1, $2, $3, 'views', 'count', 1, now(), $4, $5, $6)`,
        [
          op.admin.organizationId,
          cancelada.campaignId,
          cancelada.participacion,
          op.operativo.id,
          clave(),
          'a'.repeat(64),
        ],
      ),
    ).rejects.toThrow(/activa o archivada/);
  });
});

describe('correcciones', () => {
  it('corregir inserta una fila nueva; la original queda intacta; el motivo es obligatorio', async () => {
    const p = await nuevaParticipacionDePrueba(op);
    const original = exito(
      await registrarMedicionKpi(op.operativo, medicion(p, { value: 9000, observedAt: HACE_DOS_DIAS })),
    ).medicion;
    const sinMotivo = await corregirMedicionKpi(op.operativo, original.id, {
      value: 10_000,
      correctionReason: '   ',
      idempotencyKey: clave(),
    });
    expect(codigo(sinMotivo)).toBe('VALIDATION_FAILED');

    const c = exito(
      await corregirMedicionKpi(op.operativo, original.id, {
        value: 10_000,
        correctionReason: 'Error de digitación SENTINELA-MOTIVO-77',
        idempotencyKey: clave(),
      }),
    );
    expect(c.repetido).toBe(false);
    expect(c.medicion).toMatchObject({
      supersedesId: original.id,
      value: 10_000,
      metric: 'views',
      unit: 'count',
      observedAt: original.observedAt,
    });
    // La original NO cambió.
    const [fila] = await query<{
      value: string;
      supersedes_id: string | null;
      correction_reason: string | null;
    }>(`SELECT value::text AS value, supersedes_id, correction_reason FROM kpi_measurements WHERE id = $1`, [
      original.id,
    ]);
    expect(Number(fila!.value)).toBe(9000);
    expect(fila!.supersedes_id).toBeNull();
    expect(fila!.correction_reason).toBeNull();
    const n = await contar(
      `SELECT count(*)::int AS n FROM kpi_measurements WHERE campaign_influencer_id = $1`,
      [p],
    );
    expect(n).toBe(2);
    // Auditoría: ids, métrica y unidad; jamás el motivo ni el valor.
    const audit = await auditoriaDe(c.medicion.id);
    expect(audit.map((a) => a.action)).toEqual(['kpi_measurement.corrected']);
    expect(JSON.stringify(audit)).not.toContain('SENTINELA-MOTIVO');
    expect(audit[0]!.metadata).toMatchObject({ supersedesId: original.id, metric: 'views', unit: 'count' });
  });

  it('una sola corrección por fila (la segunda ⇒ already_corrected); se puede corregir la corrección', async () => {
    const p = await nuevaParticipacionDePrueba(op);
    const o = exito(await registrarMedicionKpi(op.operativo, medicion(p))).medicion;
    const c1 = exito(
      await corregirMedicionKpi(op.operativo, o.id, {
        value: 1,
        correctionReason: 'primera',
        idempotencyKey: clave(),
      }),
    ).medicion;
    const dup = await corregirMedicionKpi(op.operativo, o.id, {
      value: 2,
      correctionReason: 'segunda',
      idempotencyKey: clave(),
    });
    expect(codigo(dup)).toBe('RESOURCE_CONFLICT');
    expect(razon(dup)).toBe('already_corrected');
    const c2 = exito(
      await corregirMedicionKpi(op.operativo, c1.id, {
        value: 3,
        correctionReason: 'cadena',
        idempotencyKey: clave(),
      }),
    ).medicion;
    expect(c2.supersedesId).toBe(c1.id);
  });

  it('dos correcciones simultáneas: una gana y la otra recibe RESOURCE_CONFLICT already_corrected', async () => {
    const p = await nuevaParticipacionDePrueba(op);
    const o = exito(await registrarMedicionKpi(op.operativo, medicion(p))).medicion;
    const corregir = (valor: number, actor = op.operativo) =>
      corregirMedicionKpi(actor, o.id, {
        value: valor,
        correctionReason: `valor ${valor}`,
        idempotencyKey: clave(),
      });
    const [a, b, c] = await Promise.all([corregir(1), corregir(2, op.director), corregir(3, op.admin)]);
    expect([a, b, c].map(codigo).sort()).toEqual(['OK', 'RESOURCE_CONFLICT', 'RESOURCE_CONFLICT']);
    for (const r of [a, b, c]) if (!r.ok) expect(razon(r)).toBe('already_corrected');
    const n = await contar(`SELECT count(*)::int AS n FROM kpi_measurements WHERE supersedes_id = $1`, [
      o.id,
    ]);
    expect(n).toBe(1);
  });

  it('idempotencia de la corrección: reintento idéntico ⇒ la misma fila; misma clave con otro valor ⇒ conflicto', async () => {
    const p = await nuevaParticipacionDePrueba(op);
    const o = exito(await registrarMedicionKpi(op.operativo, medicion(p))).medicion;
    const entrada = { value: 5, correctionReason: 'ajuste', idempotencyKey: clave() };
    const a = exito(await corregirMedicionKpi(op.operativo, o.id, entrada));
    const b = exito(await corregirMedicionKpi(op.operativo, o.id, entrada));
    expect(b.repetido).toBe(true);
    expect(b.medicion.id).toBe(a.medicion.id);
    const otra = await corregirMedicionKpi(op.operativo, o.id, { ...entrada, value: 6 });
    expect(razon(otra)).toBe('idempotency_key_reused');
    // Una clave de otra medición tampoco se reutiliza para corregir.
    const k = clave();
    exito(await registrarMedicionKpi(op.operativo, medicion(p, { idempotencyKey: k, metric: 'reach' })));
    const o2 = exito(await registrarMedicionKpi(op.operativo, medicion(p, { metric: 'likes' }))).medicion;
    expect(
      razon(
        await corregirMedicionKpi(op.operativo, o2.id, {
          value: 1,
          correctionReason: 'x',
          idempotencyKey: k,
        }),
      ),
    ).toBe('idempotency_key_reused');
  });

  it('observedAt opcional (por omisión la original) y valor validado con las reglas de la métrica', async () => {
    const p = await nuevaParticipacionDePrueba(op);
    const o = exito(
      await registrarMedicionKpi(op.operativo, medicion(p, { metric: 'engagement_rate', value: 3 })),
    ).medicion;
    expect(
      codigo(
        await corregirMedicionKpi(op.operativo, o.id, {
          value: 101,
          correctionReason: 'x',
          idempotencyKey: clave(),
        }),
      ),
    ).toBe('VALIDATION_FAILED');
    const c = exito(
      await corregirMedicionKpi(op.operativo, o.id, {
        value: 3.5,
        correctionReason: 'x',
        observedAt: HACE_DOS_DIAS,
        idempotencyKey: clave(),
      }),
    ).medicion;
    expect(c.observedAt).toBe(HACE_DOS_DIAS);
  });

  it('permisos y estado: consultor/cliente/ajeno/inexistente; campaña cancelada no corrige', async () => {
    const p = await nuevaParticipacionDePrueba(op);
    const o = exito(await registrarMedicionKpi(op.operativo, medicion(p))).medicion;
    const corr = { value: 1, correctionReason: 'x', idempotencyKey: clave() };
    expect(codigo(await corregirMedicionKpi(op.consultor, o.id, { ...corr, idempotencyKey: clave() }))).toBe(
      'FORBIDDEN_ROLE',
    );
    expect(codigo(await corregirMedicionKpi(op.cliente, o.id, { ...corr, idempotencyKey: clave() }))).toBe(
      'RESOURCE_NOT_FOUND',
    );
    expect(codigo(await corregirMedicionKpi(op.ajeno, o.id, { ...corr, idempotencyKey: clave() }))).toBe(
      'RESOURCE_NOT_FOUND',
    );
    expect(codigo(await corregirMedicionKpi(op.operativo, 'no-es-uuid', corr))).toBe('RESOURCE_NOT_FOUND');
    expect(
      codigo(await corregirMedicionKpi(op.operativo, '00000000-0000-4000-8000-000000000000', corr)),
    ).toBe('RESOURCE_NOT_FOUND');

    const c = await campanaConParticipacionDePrueba(op, 'activa');
    const m = exito(await registrarMedicionKpi(op.operativo, medicion(c.participacion))).medicion;
    await query(`UPDATE campaigns SET status = 'cancelada' WHERE id = $1`, [c.campaignId]);
    expect(razon(await corregirMedicionKpi(op.operativo, m.id, { ...corr, idempotencyKey: clave() }))).toBe(
      'campaign_cancelled',
    );
    // Archivada sí admite correcciones.
    const a = await campanaConParticipacionDePrueba(op, 'activa');
    const ma = exito(await registrarMedicionKpi(op.operativo, medicion(a.participacion))).medicion;
    await query(`UPDATE campaigns SET status = 'archivada' WHERE id = $1`, [a.campaignId]);
    expect(codigo(await corregirMedicionKpi(op.operativo, ma.id, { ...corr, idempotencyKey: clave() }))).toBe(
      'OK',
    );
  });
});
