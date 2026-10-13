/**
 * V2 · Fase 8 (W2a) — migración 032 por SQL DIRECTO: las invariantes viven en la base, no solo en la aplicación.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { KPI_METRICS, roleCan, unidadDeMetrica } from '@tcl-kol-os/domain';
import { closePool, query, transaction } from './client.ts';
import { adminPool } from './test-admin.ts';
import { retirarInfluencerDeCampana } from './campaign-influencers.ts';
import { campanaConParticipacionDePrueba, exito, nuevaParticipacionDePrueba } from './kpi-test-support.ts';
import {
  type EscenarioDeOperacion,
  claveDePrueba as clave,
  crearEscenarioDeOperacion,
  limpiarEscenarioDeOperacion,
} from './test-utils.ts';

let op: EscenarioDeOperacion;

beforeAll(async () => {
  op = await crearEscenarioDeOperacion('F8 kpi esquema', { conAcuerdoAjeno: false });
});

afterAll(async () => {
  await limpiarEscenarioDeOperacion(op);
  await closePool();
});

const HASH = 'c'.repeat(64);

type Fila = Record<string, unknown>;

async function insertar(tabla: string, fila: Fila): Promise<string> {
  const cols = Object.keys(fila);
  const r = await query<{ id: string }>(
    `INSERT INTO ${tabla} (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`,
    cols.map((c) => fila[c]),
  );
  return r[0]!.id;
}

function objetivo(ci: string, extra: Fila = {}): Fila {
  return {
    organization_id: op.admin.organizationId,
    campaign_id: op.campanaId,
    campaign_influencer_id: ci,
    metric: 'views',
    unit: 'count',
    target_value: 100,
    idempotency_key: clave('sql'),
    request_hash: HASH,
    created_by: op.consultor.id,
    ...extra,
  };
}

function medicion(ci: string, extra: Fila = {}): Fila {
  return {
    organization_id: op.admin.organizationId,
    campaign_id: op.campanaId,
    campaign_influencer_id: ci,
    metric: 'views',
    unit: 'count',
    value: 100,
    observed_at: new Date(Date.now() - 3600_000),
    recorded_by: op.operativo.id,
    idempotency_key: clave('sql'),
    request_hash: HASH,
    ...extra,
  };
}

describe('roles en la base (paridad con roleCan)', () => {
  it('kpi_target y kpi_measure admiten exactamente los roles de kpi:target_manage y kpi:measure', async () => {
    const usuarios = [
      op.admin,
      op.director,
      op.consultor,
      op.operativo,
      op.analista,
      op.legal,
      op.cliente,
      op.ajeno,
    ];
    for (const u of usuarios) {
      for (const [capacidad, accion] of [
        ['kpi_target', 'kpi:target_manage'],
        ['kpi_measure', 'kpi:measure'],
      ] as const) {
        const [r] = await query<{ ok: boolean }>(
          `SELECT (operaciones_exigir_rol($1, $2)::text IS NOT NULL) AS ok`,
          [u.id, capacidad],
        ).catch(() => [{ ok: false }]);
        // El cliente (organización TCL) nunca pasa; el resto sigue a roleCan del dominio.
        const esperado = u.role !== 'cliente' && roleCan(u.role, accion);
        expect(r!.ok, `${u.role}/${capacidad}`).toBe(esperado);
      }
    }
  });

  it('un objetivo solo lo fija quien tiene kpi_target; una medición, quien tiene kpi_measure', async () => {
    const p = await nuevaParticipacionDePrueba(op);
    await expect(insertar('kpi_targets', objetivo(p, { created_by: op.operativo.id }))).rejects.toThrow(
      /no puede ejecutar/,
    );
    await expect(insertar('kpi_targets', objetivo(p, { created_by: op.analista.id }))).rejects.toThrow(
      /no puede ejecutar/,
    );
    await expect(insertar('kpi_measurements', medicion(p, { recorded_by: op.consultor.id }))).rejects.toThrow(
      /no puede ejecutar/,
    );
    await expect(insertar('kpi_measurements', medicion(p, { recorded_by: op.legal.id }))).rejects.toThrow(
      /no puede ejecutar/,
    );
    await insertar('kpi_targets', objetivo(p, { created_by: op.director.id }));
    await insertar('kpi_measurements', medicion(p, { recorded_by: op.director.id }));
  });
});

describe('catálogo y valores', () => {
  it('cada métrica del dominio entra con su unidad; la unidad equivocada y lo ajeno al catálogo no', async () => {
    const p = await nuevaParticipacionDePrueba(op);
    for (const metric of KPI_METRICS) {
      const unit = unidadDeMetrica(metric);
      await insertar(
        'kpi_targets',
        objetivo(p, { metric, unit, other_label: metric === 'other' ? 'Etiqueta' : null }),
      );
      await insertar(
        'kpi_measurements',
        medicion(p, { metric, unit, other_label: metric === 'other' ? 'Etiqueta' : null }),
      );
    }
    await expect(insertar('kpi_targets', objetivo(p, { metric: 'cpm', unit: 'count' }))).rejects.toThrow(
      /kpi_targets_metrica_valida/,
    );
    await expect(insertar('kpi_targets', objetivo(p, { metric: 'reach', unit: 'percent' }))).rejects.toThrow(
      /unidad_por_metrica/,
    );
    await expect(
      insertar('kpi_measurements', medicion(p, { metric: 'engagement_rate', unit: 'count' })),
    ).rejects.toThrow(/unidad_por_metrica/);
  });

  it('other exige etiqueta y solo other la lleva', async () => {
    const p = await nuevaParticipacionDePrueba(op);
    await expect(insertar('kpi_targets', objetivo(p, { metric: 'other', unit: 'other' }))).rejects.toThrow(
      /etiqueta_por_metrica/,
    );
    await expect(insertar('kpi_targets', objetivo(p, { other_label: 'x' }))).rejects.toThrow(
      /etiqueta_por_metrica/,
    );
    await expect(
      insertar('kpi_measurements', medicion(p, { metric: 'other', unit: 'other', other_label: '  ' })),
    ).rejects.toThrow(/etiqueta_valida/);
  });

  it('value ≥ 0, engagement_rate 0–100 y los conteos enteros', async () => {
    const p = await nuevaParticipacionDePrueba(op);
    await expect(insertar('kpi_measurements', medicion(p, { value: -1 }))).rejects.toThrow(/valor_valido/);
    await expect(insertar('kpi_measurements', medicion(p, { value: 1.5 }))).rejects.toThrow(/valor_valido/);
    await expect(
      insertar('kpi_measurements', medicion(p, { metric: 'engagement_rate', unit: 'percent', value: 100.1 })),
    ).rejects.toThrow(/valor_valido/);
    await expect(insertar('kpi_targets', objetivo(p, { target_value: -5 }))).rejects.toThrow(/valor_valido/);
    await expect(
      insertar('kpi_targets', objetivo(p, { metric: 'engagement_rate', unit: 'percent', target_value: 101 })),
    ).rejects.toThrow(/valor_valido/);
    await insertar(
      'kpi_measurements',
      medicion(p, { metric: 'engagement_rate', unit: 'percent', value: 100 }),
    );
    await insertar('kpi_measurements', medicion(p, { value: 0 }));
  });

  it('comparador, periodo, plataforma y canal', async () => {
    const p = await nuevaParticipacionDePrueba(op);
    await expect(insertar('kpi_targets', objetivo(p, { comparator: 'eq' }))).rejects.toThrow(
      /comparador_valido/,
    );
    await expect(
      insertar('kpi_targets', objetivo(p, { period_start: '2026-10-10', period_end: '2026-10-01' })),
    ).rejects.toThrow(/periodo_valido/);
    await expect(insertar('kpi_targets', objetivo(p, { platform: 'myspace' }))).rejects.toThrow(
      /plataforma_valida/,
    );
    await expect(insertar('kpi_targets', objetivo(p, { origin_channel: 'system' }))).rejects.toThrow(
      /canal_valido/,
    );
    await insertar('kpi_targets', objetivo(p, { origin_channel: 'chat', metric: 'reach' }));
    // Las mediciones SOLO por la interfaz.
    await expect(insertar('kpi_measurements', medicion(p, { origin_channel: 'chat' }))).rejects.toThrow(
      /canal_valido/,
    );
  });

  it('procedencia reservada: nula; fuera de manual no se admite; el Sheet va completo o no va', async () => {
    const p = await nuevaParticipacionDePrueba(op);
    await expect(insertar('kpi_measurements', medicion(p, { source_kind: 'csv_import' }))).rejects.toThrow(
      /solo_manual/,
    );
    await expect(insertar('kpi_measurements', medicion(p, { evidence_ref: 'x' }))).rejects.toThrow(
      /solo_manual/,
    );
    await expect(
      insertar('kpi_measurements', medicion(p, { import_batch_id: '00000000-0000-4000-8000-000000000001' })),
    ).rejects.toThrow(/solo_manual/);
    await expect(insertar('kpi_targets', objetivo(p, { origin: 'sheet_suggestion' }))).rejects.toThrow(
      /procedencia_coherente/,
    );
    await expect(insertar('kpi_targets', objetivo(p, { source_text_hash: HASH }))).rejects.toThrow(
      /procedencia_coherente/,
    );
  });
});

describe('objetivos: vigente único, reemplazo, sin DELETE', () => {
  it('un único vigente por ámbito: NULL cuenta como valor', async () => {
    const p = op.participaciones.valentinaGomez;
    await insertar('kpi_targets', objetivo(p, { metric: 'comments' }));
    await expect(insertar('kpi_targets', objetivo(p, { metric: 'comments' }))).rejects.toThrow(
      /kpi_targets_vigente_key/,
    );
    // Otro entregable, otra plataforma, otra etiqueta: distintos.
    await insertar(
      'kpi_targets',
      objetivo(p, { metric: 'comments', deliverable_id: op.entregables.reelGomez }),
    );
    await expect(
      insertar('kpi_targets', objetivo(p, { metric: 'comments', deliverable_id: op.entregables.reelGomez })),
    ).rejects.toThrow(/kpi_targets_vigente_key/);
    await insertar('kpi_targets', objetivo(p, { metric: 'comments', platform: 'tiktok' }));
    await expect(
      insertar('kpi_targets', objetivo(p, { metric: 'comments', platform: 'tiktok' })),
    ).rejects.toThrow(/kpi_targets_vigente_key/);
    await insertar('kpi_targets', objetivo(p, { metric: 'other', unit: 'other', other_label: 'Menciones' }));
    await expect(
      insertar('kpi_targets', objetivo(p, { metric: 'other', unit: 'other', other_label: 'MENCIONES' })),
    ).rejects.toThrow(/kpi_targets_vigente_key/);
  });

  it('reemplazar cierra el anterior; un solo sucesor; sin DELETE ni UPDATE de valores', async () => {
    const p = await nuevaParticipacionDePrueba(op);
    const a = await insertar('kpi_targets', objetivo(p));
    const b = await insertar('kpi_targets', objetivo(p, { supersedes_id: a, target_value: 200 }));
    const filas = await query<{ id: string; status: string }>(
      `SELECT id, status FROM kpi_targets WHERE campaign_influencer_id = $1`,
      [p],
    );
    expect(Object.fromEntries(filas.map((f) => [f.id, f.status]))).toEqual({
      [a]: 'superseded',
      [b]: 'active',
    });
    // Un segundo sucesor del mismo objetivo no cabe (ya está reemplazado).
    await expect(
      insertar('kpi_targets', objetivo(p, { supersedes_id: a, target_value: 300 })),
    ).rejects.toThrow(/ya no está vigente/);
    // El reemplazo debe conservar métrica y unidad.
    await expect(
      insertar('kpi_targets', objetivo(p, { supersedes_id: b, metric: 'reach', target_value: 1 })),
    ).rejects.toThrow(/conserva el ámbito/);
    // Nada se edita ni se borra.
    await expect(query(`UPDATE kpi_targets SET target_value = 1 WHERE id = $1`, [b])).rejects.toThrow(
      /no se edita/,
    );
    await expect(query(`UPDATE kpi_targets SET status = 'active' WHERE id = $1`, [a])).rejects.toThrow(
      /histórico/,
    );
    await expect(query(`DELETE FROM kpi_targets WHERE id = $1`, [b])).rejects.toThrow(/no admite DELETE/);
    // La capa de triggers se prueba con el rol privilegiado: el rol de ejecución ni siquiera tiene el privilegio.
    await expect(adminPool().query(`TRUNCATE kpi_targets`)).rejects.toThrow(/TRUNCATE/);
  });

  it('marcar «reemplazado» sin sucesor, o retirar sin rol, se rechaza (invariante diferida)', async () => {
    const p = await nuevaParticipacionDePrueba(op);
    const a = await insertar('kpi_targets', objetivo(p));
    await expect(query(`UPDATE kpi_targets SET status = 'superseded' WHERE id = $1`, [a])).rejects.toThrow(
      /sucesor/,
    );
    await expect(
      query(`UPDATE kpi_targets SET status = 'retired', retired_by = $2 WHERE id = $1`, [a, op.operativo.id]),
    ).rejects.toThrow(/no puede ejecutar/);
    await query(
      `UPDATE kpi_targets SET status = 'retired', retired_by = $2, retired_at = now() WHERE id = $1`,
      [a, op.consultor.id],
    );
    const [f] = await query<{ status: string }>(`SELECT status FROM kpi_targets WHERE id = $1`, [a]);
    expect(f!.status).toBe('retired');
  });

  it('solo en campaña activa y con la participación activa', async () => {
    const archivada = await campanaConParticipacionDePrueba(op, 'archivada');
    await expect(
      insertar('kpi_targets', objetivo(archivada.participacion, { campaign_id: archivada.campaignId })),
    ).rejects.toThrow(/campaña debe estar activa/);
    const p = await nuevaParticipacionDePrueba(op);
    exito(await retirarInfluencerDeCampana(op.admin, p, { motivo: 'prueba' }));
    await expect(insertar('kpi_targets', objetivo(p))).rejects.toThrow(/influencer debe estar activo/);
    // La medición de una participación retirada y de una campaña archivada sí se conserva/admite.
    await insertar('kpi_measurements', medicion(p));
    await insertar(
      'kpi_measurements',
      medicion(archivada.participacion, { campaign_id: archivada.campaignId }),
    );
  });
});

describe('mediciones: inmutables y correcciones', () => {
  it('sin UPDATE, DELETE ni TRUNCATE', async () => {
    const p = await nuevaParticipacionDePrueba(op);
    const m = await insertar('kpi_measurements', medicion(p));
    await expect(query(`UPDATE kpi_measurements SET value = 5 WHERE id = $1`, [m])).rejects.toThrow(
      /append-only/,
    );
    await expect(query(`DELETE FROM kpi_measurements WHERE id = $1`, [m])).rejects.toThrow(
      /no admite DELETE/,
    );
    await expect(adminPool().query(`TRUNCATE kpi_measurements`)).rejects.toThrow(/TRUNCATE/);
    // El bypass de bases _test (solo limpieza de pruebas) sí borra.
    await transaction(async (c) => {
      await c.query(`SET LOCAL tclkolos.permitir_borrado_historico = 'on'`);
      await c.query(`DELETE FROM kpi_measurements WHERE id = $1`, [m]);
    });
  });

  it('corrección: motivo obligatorio, mismo ámbito y métrica, una sola por fila', async () => {
    const p = await nuevaParticipacionDePrueba(op);
    const m = await insertar('kpi_measurements', medicion(p));
    await expect(insertar('kpi_measurements', medicion(p, { supersedes_id: m }))).rejects.toThrow(
      /motivo_coherente/,
    );
    await expect(insertar('kpi_measurements', medicion(p, { correction_reason: 'x' }))).rejects.toThrow(
      /motivo_coherente/,
    );
    await expect(
      insertar(
        'kpi_measurements',
        medicion(p, { supersedes_id: m, correction_reason: 'x', metric: 'reach' }),
      ),
    ).rejects.toThrow(/conserva el ámbito/);
    await expect(
      insertar(
        'kpi_measurements',
        medicion(p, { supersedes_id: m, correction_reason: 'x', platform: 'tiktok' }),
      ),
    ).rejects.toThrow(/conserva el ámbito/);
    const otra = await nuevaParticipacionDePrueba(op);
    await expect(
      insertar('kpi_measurements', medicion(otra, { supersedes_id: m, correction_reason: 'x' })),
    ).rejects.toThrow();
    const c = await insertar(
      'kpi_measurements',
      medicion(p, { supersedes_id: m, correction_reason: 'corrige', value: 7 }),
    );
    await expect(
      insertar('kpi_measurements', medicion(p, { supersedes_id: m, correction_reason: 'otra', value: 8 })),
    ).rejects.toThrow(/ya fue corregida/);
    await insertar(
      'kpi_measurements',
      medicion(p, { supersedes_id: c, correction_reason: 'cadena', value: 9 }),
    );
  });

  it('idempotencia por (participación, clave) y aislamiento por claves compuestas', async () => {
    const p = await nuevaParticipacionDePrueba(op);
    const k = clave('dup');
    await insertar('kpi_measurements', medicion(p, { idempotency_key: k }));
    await expect(insertar('kpi_measurements', medicion(p, { idempotency_key: k }))).rejects.toThrow(
      /kpi_measurements_clave_key/,
    );
    await insertar('kpi_targets', objetivo(p, { idempotency_key: k }));
    await expect(
      insertar('kpi_targets', objetivo(p, { idempotency_key: k, metric: 'reach' })),
    ).rejects.toThrow(/kpi_targets_clave_key/);
    // La misma clave en OTRA participación no choca.
    await insertar('kpi_measurements', medicion(op.participaciones.diego, { idempotency_key: k }));
    // Organización equivocada para la campaña/participación: no existe.
    await expect(
      insertar(
        'kpi_measurements',
        medicion(p, { organization_id: op.ajeno.organizationId, recorded_by: op.operativo.id }),
      ),
    ).rejects.toThrow(/fkey/);
    await expect(insertar('kpi_targets', objetivo(op.ajena.participacion))).rejects.toThrow(/fkey/);
    // El entregable debe ser de la MISMA participación.
    await expect(
      insertar('kpi_measurements', medicion(p, { deliverable_id: op.entregables.reelRios })),
    ).rejects.toThrow(/no pertenece a esta participación/);
    await expect(
      insertar('kpi_targets', objetivo(p, { deliverable_id: op.entregables.reelRios })),
    ).rejects.toThrow(/no pertenece a esta participación/);
  });
});
