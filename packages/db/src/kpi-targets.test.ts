/**
 * V2 · Fase 8 (W2a) — objetivos de KPI: registro, reemplazo, retiro, idempotencia, permisos y aislamiento.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePool, query } from './client.ts';
import { registrarKpiObjetivo, retirarKpiObjetivo } from './kpi-targets.ts';
import {
  campanaConParticipacionDePrueba,
  codigo,
  contar,
  exito,
  nuevaParticipacionDePrueba,
  razon,
} from './kpi-test-support.ts';
import { retirarInfluencerDeCampana } from './campaign-influencers.ts';
import {
  type EscenarioDeOperacion,
  claveDePrueba as clave,
  crearEscenarioDeOperacion,
  limpiarEscenarioDeOperacion,
} from './test-utils.ts';

let op: EscenarioDeOperacion;
let ci: string; // participación principal (Valentina Ríos)

beforeAll(async () => {
  op = await crearEscenarioDeOperacion('F8 kpi targets', { conAcuerdoAjeno: false });
  ci = op.participaciones.valentinaRios;
});

afterAll(async () => {
  await limpiarEscenarioDeOperacion(op);
  await closePool();
});

const base = (extra: Record<string, unknown> = {}) => ({
  campaignInfluencerId: ci,
  metric: 'views' as const,
  targetValue: 10_000,
  idempotencyKey: clave('t'),
  ...extra,
});

async function auditoriaDe(entityId: string) {
  return query<{ action: string; origin: string; metadata: Record<string, unknown>; correlation: unknown }>(
    `SELECT action, origin, metadata, correlation FROM audit_events WHERE entity_id = $1 ORDER BY created_at, id`,
    [entityId],
  );
}

describe('registrar un objetivo', () => {
  it('el consultor fija un objetivo vigente (unidad del catálogo, gte por omisión) y queda auditado', async () => {
    const p = await nuevaParticipacionDePrueba(op);
    const r = exito(
      await registrarKpiObjetivo(op.consultor, {
        campaignInfluencerId: p,
        metric: 'engagement_rate',
        targetValue: 4.7,
        periodStart: '2026-10-01',
        periodEnd: '2026-10-31',
        idempotencyKey: clave(),
      }),
    );
    expect(r.repetido).toBe(false);
    expect(r.objetivo).toMatchObject({
      metric: 'engagement_rate',
      unit: 'percent',
      targetValue: 4.7,
      comparator: 'gte',
      status: 'active',
      origin: 'manual',
      originChannel: 'ui',
      deliverableId: null,
      platform: null,
      periodStart: '2026-10-01',
      periodEnd: '2026-10-31',
      createdBy: op.consultor.id,
    });
    const audit = await auditoriaDe(r.objetivo.id);
    expect(audit.map((a) => [a.action, a.origin])).toEqual([['kpi_target.registered', 'ui']]);
    expect(Object.keys(audit[0]!.metadata).sort()).toEqual(
      ['campaignId', 'campaignInfluencerId', 'metric', 'targetId', 'unit'].sort(),
    );
  });

  it('idempotencia: el doble envío devuelve el mismo objetivo y no duplica', async () => {
    const p = await nuevaParticipacionDePrueba(op);
    const entrada = {
      campaignInfluencerId: p,
      metric: 'reach' as const,
      targetValue: 5000,
      idempotencyKey: clave(),
    };
    const a = exito(await registrarKpiObjetivo(op.consultor, entrada));
    const b = exito(await registrarKpiObjetivo(op.consultor, entrada));
    expect(b.repetido).toBe(true);
    expect(b.objetivo.id).toBe(a.objetivo.id);
    const n = await contar(`SELECT count(*)::int AS n FROM kpi_targets WHERE campaign_influencer_id = $1`, [
      p,
    ]);
    expect(n).toBe(1);
    expect((await auditoriaDe(a.objetivo.id)).length).toBe(1);
  });

  it('idempotencia concurrente: dos envíos simultáneos con la misma clave dan un solo objetivo', async () => {
    const p = await nuevaParticipacionDePrueba(op);
    const entrada = {
      campaignInfluencerId: p,
      metric: 'likes' as const,
      targetValue: 700,
      idempotencyKey: clave(),
    };
    const [a, b] = await Promise.all([
      registrarKpiObjetivo(op.consultor, entrada),
      registrarKpiObjetivo(op.consultor, entrada),
    ]);
    expect(codigo(a)).toBe('OK');
    expect(codigo(b)).toBe('OK');
    expect(exito(a).objetivo.id).toBe(exito(b).objetivo.id);
    const n = await contar(`SELECT count(*)::int AS n FROM kpi_targets WHERE campaign_influencer_id = $1`, [
      p,
    ]);
    expect(n).toBe(1);
  });

  it('la misma clave con otro contenido ⇒ RESOURCE_CONFLICT idempotency_key_reused', async () => {
    const p = await nuevaParticipacionDePrueba(op);
    const k = clave();
    exito(
      await registrarKpiObjetivo(op.consultor, {
        campaignInfluencerId: p,
        metric: 'views',
        targetValue: 1,
        idempotencyKey: k,
      }),
    );
    const r = await registrarKpiObjetivo(op.consultor, {
      campaignInfluencerId: p,
      metric: 'views',
      targetValue: 2,
      idempotencyKey: k,
    });
    expect(codigo(r)).toBe('RESOURCE_CONFLICT');
    expect(razon(r)).toBe('idempotency_key_reused');
  });

  it('validaciones: other exige etiqueta, unidad del catálogo, valores, entregable ajeno', async () => {
    const p = await nuevaParticipacionDePrueba(op);
    const reg = (extra: Record<string, unknown>) =>
      registrarKpiObjetivo(op.consultor, {
        campaignInfluencerId: p,
        metric: 'views',
        targetValue: 10,
        idempotencyKey: clave(),
        ...extra,
      } as never);
    expect(codigo(await reg({ metric: 'other' }))).toBe('VALIDATION_FAILED');
    expect(codigo(await reg({ unit: 'percent' }))).toBe('VALIDATION_FAILED');
    expect(codigo(await reg({ targetValue: -1 }))).toBe('VALIDATION_FAILED');
    expect(codigo(await reg({ targetValue: 10.5 }))).toBe('VALIDATION_FAILED');
    expect(codigo(await reg({ metric: 'engagement_rate', targetValue: 101 }))).toBe('VALIDATION_FAILED');
    expect(codigo(await reg({ metric: 'cpm' }))).toBe('VALIDATION_FAILED');
    expect(codigo(await reg({ comparator: 'eq' }))).toBe('VALIDATION_FAILED');
    expect(codigo(await reg({ platform: 'myspace' }))).toBe('VALIDATION_FAILED');
    expect(codigo(await reg({ idempotencyKey: '' }))).toBe('VALIDATION_FAILED');
    // El entregable es de OTRA participación.
    const r = await reg({ deliverableId: op.entregables.reelGomez });
    expect(codigo(r)).toBe('VALIDATION_FAILED');
    expect(razon(r)).toBe('deliverable_not_in_participation');
    exito(await reg({ metric: 'other', otherLabel: 'Menciones de marca', targetValue: 12.5 }));
  });

  it('un entregable de la participación y una plataforma acotan el ámbito', async () => {
    const r = exito(
      await registrarKpiObjetivo(
        op.consultor,
        base({ deliverableId: op.entregables.reelRios, platform: 'instagram', comparator: 'gte' }),
      ),
    );
    expect(r.objetivo).toMatchObject({ deliverableId: op.entregables.reelRios, platform: 'instagram' });
  });
});

describe('un único vigente por ámbito', () => {
  it('un segundo vigente igual se rechaza; otro entregable, plataforma, métrica o etiqueta sí', async () => {
    const p = await nuevaParticipacionDePrueba(op);
    const reg = (extra: Record<string, unknown>) =>
      registrarKpiObjetivo(op.consultor, {
        campaignInfluencerId: p,
        metric: 'views',
        targetValue: 100,
        idempotencyKey: clave(),
        ...extra,
      } as never);
    const primero = exito(await reg({}));
    const dup = await reg({ targetValue: 200 });
    expect(codigo(dup)).toBe('RESOURCE_CONFLICT');
    expect(razon(dup)).toBe('active_target_exists');
    expect(!dup.ok && dup.error.details).toMatchObject({ targetId: primero.objetivo.id });
    exito(await reg({ platform: 'tiktok' }));
    exito(await reg({ platform: 'instagram' }));
    exito(await reg({ metric: 'reach' }));
    exito(await reg({ metric: 'other', otherLabel: 'Menciones' }));
    exito(await reg({ metric: 'other', otherLabel: 'Sorteos' }));
    const mismaEtiqueta = await reg({ metric: 'other', otherLabel: 'MENCIONES' });
    expect(razon(mismaEtiqueta)).toBe('active_target_exists');
  });

  it('dos registros simultáneos del mismo ámbito: uno gana, el otro es conflicto', async () => {
    const p = await nuevaParticipacionDePrueba(op);
    const entrada = (k: string) => ({
      campaignInfluencerId: p,
      metric: 'shares' as const,
      targetValue: 50,
      idempotencyKey: k,
    });
    const [a, b] = await Promise.all([
      registrarKpiObjetivo(op.consultor, entrada(clave())),
      registrarKpiObjetivo(op.director, entrada(clave())),
    ]);
    expect([codigo(a), codigo(b)].sort()).toEqual(['OK', 'RESOURCE_CONFLICT']);
    const n = await contar(
      `SELECT count(*)::int AS n FROM kpi_targets WHERE campaign_influencer_id = $1 AND status = 'active'`,
      [p],
    );
    expect(n).toBe(1);
  });
});

describe('reemplazo (supersedes)', () => {
  it('reemplazar cierra el anterior, deja uno vigente y audita kpi_target.superseded', async () => {
    const p = await nuevaParticipacionDePrueba(op);
    const v1 = exito(
      await registrarKpiObjetivo(op.consultor, {
        campaignInfluencerId: p,
        metric: 'views',
        targetValue: 100,
        idempotencyKey: clave(),
      }),
    );
    const v2 = exito(
      await registrarKpiObjetivo(op.consultor, {
        campaignInfluencerId: p,
        metric: 'views',
        targetValue: 150,
        comparator: 'lte',
        supersedesId: v1.objetivo.id,
        idempotencyKey: clave(),
      }),
    );
    expect(v2.objetivo).toMatchObject({
      status: 'active',
      supersedesId: v1.objetivo.id,
      targetValue: 150,
      comparator: 'lte',
    });
    const filas = await query<{ id: string; status: string }>(
      `SELECT id, status FROM kpi_targets WHERE campaign_influencer_id = $1 ORDER BY seq`,
      [p],
    );
    expect(filas.map((f) => f.status)).toEqual(['superseded', 'active']);
    expect((await auditoriaDe(v2.objetivo.id)).map((a) => a.action)).toEqual(['kpi_target.superseded']);
    // El superseded ya no se reemplaza de nuevo.
    const otra = await registrarKpiObjetivo(op.consultor, {
      campaignInfluencerId: p,
      metric: 'views',
      targetValue: 99,
      supersedesId: v1.objetivo.id,
      idempotencyKey: clave(),
    });
    expect(codigo(otra)).toBe('RESOURCE_CONFLICT');
    expect(razon(otra)).toBe('already_superseded');
  });

  it('reemplazo concurrente: un solo sucesor; el otro recibe RESOURCE_CONFLICT already_superseded', async () => {
    const p = await nuevaParticipacionDePrueba(op);
    const v1 = exito(
      await registrarKpiObjetivo(op.consultor, {
        campaignInfluencerId: p,
        metric: 'saves',
        targetValue: 10,
        idempotencyKey: clave(),
      }),
    );
    const reemplazo = (valor: number, actor = op.consultor) =>
      registrarKpiObjetivo(actor, {
        campaignInfluencerId: p,
        metric: 'saves',
        targetValue: valor,
        supersedesId: v1.objetivo.id,
        idempotencyKey: clave(),
      });
    const [a, b, c] = await Promise.all([reemplazo(20), reemplazo(30, op.director), reemplazo(40, op.admin)]);
    const codigos = [a, b, c].map(codigo).sort();
    expect(codigos).toEqual(['OK', 'RESOURCE_CONFLICT', 'RESOURCE_CONFLICT']);
    for (const r of [a, b, c]) if (!r.ok) expect(razon(r)).toBe('already_superseded');
    const filas = await query<{ status: string; supersedes_id: string | null }>(
      `SELECT status, supersedes_id FROM kpi_targets WHERE campaign_influencer_id = $1`,
      [p],
    );
    expect(filas.filter((f) => f.status === 'active')).toHaveLength(1);
    expect(filas.filter((f) => f.supersedes_id === v1.objetivo.id)).toHaveLength(1);
  });

  it('el reemplazo conserva ámbito, métrica y unidad; otro participante no lo ve', async () => {
    const p = await nuevaParticipacionDePrueba(op);
    const otro = await nuevaParticipacionDePrueba(op);
    const v1 = exito(
      await registrarKpiObjetivo(op.consultor, {
        campaignInfluencerId: p,
        metric: 'views',
        targetValue: 100,
        idempotencyKey: clave(),
      }),
    );
    const cambiaMetrica = await registrarKpiObjetivo(op.consultor, {
      campaignInfluencerId: p,
      metric: 'reach',
      targetValue: 100,
      supersedesId: v1.objetivo.id,
      idempotencyKey: clave(),
    });
    expect(razon(cambiaMetrica)).toBe('supersedes_scope_mismatch');
    const cambiaPlataforma = await registrarKpiObjetivo(op.consultor, {
      campaignInfluencerId: p,
      metric: 'views',
      targetValue: 100,
      platform: 'tiktok',
      supersedesId: v1.objetivo.id,
      idempotencyKey: clave(),
    });
    expect(razon(cambiaPlataforma)).toBe('supersedes_scope_mismatch');
    // Un objetivo de OTRA participación no es reemplazable desde esta.
    const deOtro = await registrarKpiObjetivo(op.consultor, {
      campaignInfluencerId: otro,
      metric: 'views',
      targetValue: 100,
      supersedesId: v1.objetivo.id,
      idempotencyKey: clave(),
    });
    expect(codigo(deOtro)).toBe('RESOURCE_NOT_FOUND');
  });
});

describe('retirar un objetivo', () => {
  it('marca retired_at (sin DELETE), es idempotente y libera el ámbito', async () => {
    const p = await nuevaParticipacionDePrueba(op);
    const t = exito(
      await registrarKpiObjetivo(op.consultor, {
        campaignInfluencerId: p,
        metric: 'views',
        targetValue: 100,
        idempotencyKey: clave(),
      }),
    );
    const r = exito(await retirarKpiObjetivo(op.consultor, t.objetivo.id));
    expect(r.repetido).toBe(false);
    expect(r.objetivo.status).toBe('retired');
    expect(r.objetivo.retiredAt).not.toBeNull();
    expect(exito(await retirarKpiObjetivo(op.consultor, t.objetivo.id)).repetido).toBe(true);
    expect((await auditoriaDe(t.objetivo.id)).map((a) => a.action)).toEqual([
      'kpi_target.registered',
      'kpi_target.retired',
    ]);
    // Ya no hay vigente: se puede fijar otro sin reemplazo.
    exito(
      await registrarKpiObjetivo(op.consultor, {
        campaignInfluencerId: p,
        metric: 'views',
        targetValue: 200,
        idempotencyKey: clave(),
      }),
    );
    // El retirado sigue en la base (historia).
    const n = await contar(`SELECT count(*)::int AS n FROM kpi_targets WHERE id = $1`, [t.objetivo.id]);
    expect(n).toBe(1);
  });

  it('un reemplazado es histórico; el chat y el operativo no retiran; ajeno/cliente no lo ven', async () => {
    const p = await nuevaParticipacionDePrueba(op);
    const v1 = exito(
      await registrarKpiObjetivo(op.consultor, {
        campaignInfluencerId: p,
        metric: 'views',
        targetValue: 100,
        idempotencyKey: clave(),
      }),
    );
    exito(
      await registrarKpiObjetivo(op.consultor, {
        campaignInfluencerId: p,
        metric: 'views',
        targetValue: 120,
        supersedesId: v1.objetivo.id,
        idempotencyKey: clave(),
      }),
    );
    expect(razon(await retirarKpiObjetivo(op.consultor, v1.objetivo.id))).toBe('already_superseded');

    const v = exito(
      await registrarKpiObjetivo(op.consultor, {
        campaignInfluencerId: p,
        metric: 'reach',
        targetValue: 1,
        idempotencyKey: clave(),
      }),
    );
    expect(
      codigo(
        await retirarKpiObjetivo(op.consultor, v.objetivo.id, {
          origin: 'chat',
          correlation: { toolInvocationId: 't1' },
        }),
      ),
    ).toBe('HUMAN_CONFIRMATION_REQUIRED');
    expect(codigo(await retirarKpiObjetivo(op.operativo, v.objetivo.id))).toBe('FORBIDDEN_ROLE');
    expect(codigo(await retirarKpiObjetivo(op.cliente, v.objetivo.id))).toBe('RESOURCE_NOT_FOUND');
    expect(codigo(await retirarKpiObjetivo(op.ajeno, v.objetivo.id))).toBe('RESOURCE_NOT_FOUND');
    expect(codigo(await retirarKpiObjetivo(op.consultor, 'no-es-uuid'))).toBe('RESOURCE_NOT_FOUND');
  });
});

describe('permisos y aislamiento', () => {
  it('consultor, director y admin fijan objetivos; el operativo NO; analista, legal sin acceso', async () => {
    const p = await nuevaParticipacionDePrueba(op);
    const reg = (actor: typeof op.admin, metric: 'views' | 'reach' | 'likes' | 'saves') =>
      registrarKpiObjetivo(actor, {
        campaignInfluencerId: p,
        metric,
        targetValue: 10,
        idempotencyKey: clave(),
      });
    expect(codigo(await reg(op.consultor, 'views'))).toBe('OK');
    expect(codigo(await reg(op.director, 'reach'))).toBe('OK');
    expect(codigo(await reg(op.admin, 'likes'))).toBe('OK');
    expect(codigo(await reg(op.operativo, 'saves'))).toBe('FORBIDDEN_ROLE');
    expect(codigo(await reg(op.analista, 'saves'))).toBe('FORBIDDEN_ROLE');
    expect(codigo(await reg(op.legal, 'saves'))).toBe('FORBIDDEN_ROLE');
    const n = await contar(`SELECT count(*)::int AS n FROM kpi_targets WHERE campaign_influencer_id = $1`, [
      p,
    ]);
    expect(n).toBe(3);
  });

  it('cliente y otra agencia reciben RESOURCE_NOT_FOUND (no se revela la existencia)', async () => {
    const entrada = base({ idempotencyKey: clave() });
    expect(codigo(await registrarKpiObjetivo(op.cliente, entrada))).toBe('RESOURCE_NOT_FOUND');
    expect(codigo(await registrarKpiObjetivo(op.ajeno, entrada))).toBe('RESOURCE_NOT_FOUND');
    expect(codigo(await registrarKpiObjetivo(op.consultor, { ...entrada, campaignInfluencerId: 'x' }))).toBe(
      'RESOURCE_NOT_FOUND',
    );
    expect(
      codigo(
        await registrarKpiObjetivo(op.consultor, {
          ...entrada,
          campaignInfluencerId: op.ajena.participacion,
        }),
      ),
    ).toBe('RESOURCE_NOT_FOUND');
    // La agencia ajena sí opera en lo suyo.
    const propio = await registrarKpiObjetivo(op.ajeno, {
      campaignInfluencerId: op.ajena.participacion,
      metric: 'views',
      targetValue: 1,
      idempotencyKey: clave(),
    });
    expect(codigo(propio)).toBe('OK');
  });
});

describe('estado de la campaña y de la participación', () => {
  it('solo en campaña activa: archivada y cancelada ⇒ conflicto campaign_not_active', async () => {
    for (const estado of ['archivada', 'cancelada'] as const) {
      const { participacion } = await campanaConParticipacionDePrueba(op, estado);
      const r = await registrarKpiObjetivo(op.consultor, {
        campaignInfluencerId: participacion,
        metric: 'views',
        targetValue: 1,
        idempotencyKey: clave(),
      });
      expect(codigo(r), estado).toBe('RESOURCE_CONFLICT');
      expect(razon(r)).toBe('campaign_not_active');
    }
  });

  it('una participación retirada no admite objetivos nuevos pero conserva los que tenía', async () => {
    const p = await nuevaParticipacionDePrueba(op);
    const t = exito(
      await registrarKpiObjetivo(op.consultor, {
        campaignInfluencerId: p,
        metric: 'views',
        targetValue: 1,
        idempotencyKey: clave(),
      }),
    );
    exito(await retirarInfluencerDeCampana(op.admin, p, { motivo: 'prueba' }));
    const r = await registrarKpiObjetivo(op.consultor, {
      campaignInfluencerId: p,
      metric: 'reach',
      targetValue: 1,
      idempotencyKey: clave(),
    });
    expect(razon(r)).toBe('participation_not_active');
    const [fila] = await query<{ status: string }>(`SELECT status FROM kpi_targets WHERE id = $1`, [
      t.objetivo.id,
    ]);
    const status = fila!.status;
    expect(status).toBe('active');
  });

  it('el reintento idéntico sigue devolviendo lo ya hecho aunque la campaña ya no esté activa', async () => {
    const { campaignId, participacion } = await campanaConParticipacionDePrueba(op, 'activa');
    const entrada = {
      campaignInfluencerId: participacion,
      metric: 'views' as const,
      targetValue: 9,
      idempotencyKey: clave(),
    };
    const a = exito(await registrarKpiObjetivo(op.consultor, entrada));
    await query(`UPDATE campaigns SET status = 'archivada' WHERE id = $1`, [campaignId]);
    const b = exito(await registrarKpiObjetivo(op.consultor, entrada));
    expect(b.repetido).toBe(true);
    expect(b.objetivo.id).toBe(a.objetivo.id);
  });
});

describe('canal: ui o chat (solo por la herramienta)', () => {
  it('chat con toolInvocationId: audita origen chat y la correlación', async () => {
    const p = await nuevaParticipacionDePrueba(op);
    const r = exito(
      await registrarKpiObjetivo(
        op.consultor,
        { campaignInfluencerId: p, metric: 'views', targetValue: 100, idempotencyKey: clave() },
        { origin: 'chat', correlation: { toolInvocationId: 'tool-inv-1', conversationId: 'conv-1' } },
      ),
    );
    expect(r.objetivo.originChannel).toBe('chat');
    const [a] = await auditoriaDe(r.objetivo.id);
    expect(a).toMatchObject({ action: 'kpi_target.registered', origin: 'chat' });
    expect(a!.correlation).toMatchObject({ toolInvocationId: 'tool-inv-1', conversationId: 'conv-1' });
  });

  it('chat sin herramienta o sistema ⇒ FORBIDDEN_ROLE; el rol sigue mandando (operativo vía chat, no)', async () => {
    const p = await nuevaParticipacionDePrueba(op);
    const entrada = {
      campaignInfluencerId: p,
      metric: 'views' as const,
      targetValue: 100,
      idempotencyKey: clave(),
    };
    expect(codigo(await registrarKpiObjetivo(op.consultor, entrada, { origin: 'chat' }))).toBe(
      'FORBIDDEN_ROLE',
    );
    expect(
      codigo(
        await registrarKpiObjetivo(op.consultor, entrada, {
          origin: 'chat',
          correlation: { conversationId: 'c' },
        }),
      ),
    ).toBe('FORBIDDEN_ROLE');
    expect(codigo(await registrarKpiObjetivo(op.consultor, entrada, { origin: 'system' }))).toBe(
      'FORBIDDEN_ROLE',
    );
    expect(codigo(await registrarKpiObjetivo('system' as never, entrada))).toBe('FORBIDDEN_ROLE');
    expect(
      codigo(
        await registrarKpiObjetivo(op.operativo, entrada, {
          origin: 'chat',
          correlation: { toolInvocationId: 't' },
        }),
      ),
    ).toBe('FORBIDDEN_ROLE');
    const n = await contar(`SELECT count(*)::int AS n FROM kpi_targets WHERE campaign_influencer_id = $1`, [
      p,
    ]);
    expect(n).toBe(0);
  });
});
