/**
 * V2 · Fase 7 — esquema del análisis de contenido (migración 024): forma, aditividad y paridades.
 *
 * Qué comprueba: que la migración es aditiva (no reescribe nada existente), que las funciones del Brief
 * rector y del gobernante válido se comportan, que el INSERT histórico de `ai_runs` (el del worker de Python)
 * sigue funcionando, que la limpieza de pruebas con la FK de aprobación funciona y que el rol del autor de
 * una revisión espeja `roleCan` del dominio. Las invariantes por SQL directo están en
 * `qa-content-analysis-triggers.test.ts`.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ROLES, roleCan } from '@tcl-kol-os/domain';
import { closePool, query, transaction } from './client.ts';
import {
  type EscenarioDeAnalisis,
  crearEscenarioDeAnalisis,
  registrarGuionDePrueba,
} from './content-analysis-test-support.ts';
import { registrarRevisionHumana } from './content-analysis.ts';
import {
  asegurarUsuarioDePrueba,
  crearBriefAprobadoDePrueba,
  crearBriefHijoDePrueba,
  crearEscenarioDeContenido,
  limpiarEscenarioDeContenido,
} from './test-utils.ts';

let a: EscenarioDeAnalisis;

const SQL_024 = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '../../../infra/db/migrations/024_analisis_de_contenido.sql'),
  'utf8',
);

beforeAll(async () => {
  a = await crearEscenarioDeAnalisis('analisis-esquema');
});

afterAll(async () => {
  await limpiarEscenarioDeContenido(a.e);
  await closePool();
});

describe('la migración 024 es forward-only y aditiva', () => {
  const sinComentarios = SQL_024.split('\n')
    .filter((l) => !l.trim().startsWith('--'))
    .join('\n');

  it('no borra ni reescribe nada existente: sin DROP TABLE/COLUMN, sin UPDATE/DELETE de datos, solo ADD en ALTER', () => {
    expect(sinComentarios).not.toMatch(/\bDROP\s+(TABLE|COLUMN|CONSTRAINT|TRIGGER)\b/iu);
    expect(sinComentarios).not.toMatch(/^\s*(UPDATE|DELETE\s+FROM|TRUNCATE)\b/imu);
    const alters = [...sinComentarios.matchAll(/ALTER TABLE\s+(\w+)([^;]*);/giu)];
    expect(alters.map((m) => m[1])).toEqual(['brief_fields', 'ai_runs', 'ai_runs', 'script_versions']);
    for (const m of alters) expect(m[2]).toMatch(/\bADD\b/iu);
    expect(sinComentarios).not.toMatch(/ALTER TABLE[^;]*\b(DROP|ALTER COLUMN|RENAME)\b/iu);
  });

  it('las tablas y columnas de la 023 siguen intactas y approved_analysis_id sigue siendo uuid', async () => {
    const [col] = await query<{ data_type: string; is_nullable: string }>(
      `SELECT data_type, is_nullable FROM information_schema.columns
        WHERE table_name = 'script_versions' AND column_name = 'approved_analysis_id'`,
    );
    expect(col).toEqual({ data_type: 'uuid', is_nullable: 'YES' });
    const [ai] = await query<{ n: string }>(
      `SELECT count(*) AS n FROM information_schema.columns WHERE table_name = 'ai_runs'`,
    );
    expect(Number(ai!.n)).toBe(21); // 20 de antes + content_analysis_run_id
  });
});

describe('funciones del Brief rector y del gobernante válido', () => {
  it('brief_gobernante_valido acepta approved/superseded de la campaña y rechaza borrador, cancelada y otra campaña', async () => {
    const valido = async (v: string, campana: string, org: string): Promise<boolean> =>
      (
        await query<{ ok: boolean }>(`SELECT brief_gobernante_valido($1, $2, $3) AS ok`, [v, campana, org])
      )[0]!.ok;
    const org = a.e.admin.organizationId;
    expect(await valido(a.brief.versionId, a.e.campanaId, org)).toBe(true);
    const hija = await crearBriefHijoDePrueba(a.e.admin, a.brief.versionId, { aprobar: false });
    expect(await valido(a.brief.versionId, a.e.campanaId, org)).toBe(true); // superseded
    expect(await valido(hija.versionId, a.e.campanaId, org)).toBe(false); // borrador
    await query(`UPDATE brief_versions SET status = 'cancelled' WHERE id = $1`, [hija.versionId]);
    expect(await valido(hija.versionId, a.e.campanaId, org)).toBe(false); // cancelada
    expect(await valido(a.brief.versionId, a.e.otraCampanaId, org)).toBe(false); // otra campaña
    expect(await valido(a.brief.versionId, a.e.campanaId, a.e.ajeno.organizationId)).toBe(false); // otra organización
    expect(await valido('00000000-0000-4000-8000-000000000000', a.e.campanaId, org)).toBe(false);
  });

  it('brief_rector_de_campana es NULL sin Brief aprobado y desempata por approved_at y luego por versión', async () => {
    const rector = async (c: string): Promise<string | null> =>
      (await query<{ id: string | null }>(`SELECT brief_rector_de_campana($1) AS id`, [c]))[0]!.id;
    expect(await rector(a.e.otraCampanaId)).toBeNull();
    const borrador = await crearBriefAprobadoDePrueba(a.e.otraCampanaId, a.e.admin, { estado: 'draft' });
    expect(await rector(a.e.otraCampanaId)).toBeNull();
    await query(
      `UPDATE brief_versions SET status = 'approved', approved_at = '2026-01-01T00:00:00Z' WHERE id = $1`,
      [borrador.versionId],
    );
    expect(await rector(a.e.otraCampanaId)).toBe(borrador.versionId);
    // Dos aprobadas con el MISMO approved_at: manda la versión mayor.
    const segunda = await crearBriefAprobadoDePrueba(a.e.otraCampanaId, a.e.admin, { estado: 'draft' });
    await query(`UPDATE brief_versions SET status = 'superseded' WHERE id = $1`, [borrador.versionId]);
    await query(
      `UPDATE brief_versions SET status = 'approved', approved_at = '2026-01-01T00:00:00Z' WHERE id = $1`,
      [segunda.versionId],
    );
    expect(await rector(a.e.otraCampanaId)).toBe(segunda.versionId);
  });
});

describe('compatibilidad con el INSERT histórico de ai_runs (el del worker de Python)', () => {
  it('un INSERT sin la columna nueva sigue funcionando y deja content_analysis_run_id nulo', async () => {
    const [fila] = await query<{ id: string; content_analysis_run_id: string | null }>(
      `INSERT INTO ai_runs (organization_id, campaign_id, task, tier, model, prompt_version, input_hash, output_status)
       VALUES ($1, $2, 'extraer', 'equilibrado', 'm', 'extraccion-1', repeat('a', 64), 'ok')
       RETURNING id, content_analysis_run_id`,
      [a.e.admin.organizationId, a.e.campanaId],
    );
    expect(fila!.content_analysis_run_id).toBeNull();
    await query(`DELETE FROM ai_runs WHERE id = $1`, [fila!.id]);
  });

  it('al borrar una revisión (solo posible con el bypass de pruebas) la llamada del ledger se conserva con la columna a NULL', async () => {
    const e2 = await crearEscenarioDeContenido('analisis-esquema-set-null');
    try {
      const { versionId } = await registrarGuionDePrueba(
        e2,
        e2.entregables.reelRios,
        e2.participaciones.valentinaRios,
        e2.consultor,
      );
      const b = await crearBriefAprobadoDePrueba(e2.campanaId, e2.admin);
      const r = await registrarRevisionHumana(e2.consultor, versionId);
      expect(r.ok).toBe(true);
      const runId = r.ok ? r.value.run.id : '';
      const [llamada] = await query<{ id: string }>(
        `INSERT INTO ai_runs (organization_id, campaign_id, task, tier, model, prompt_version, input_hash, output_status, content_analysis_run_id)
         VALUES ($1, $2, 'analizar_guion', 'equilibrado', 'm', 'analisis-guion-1', repeat('a', 64), 'ok', $3) RETURNING id`,
        [e2.admin.organizationId, e2.campanaId, runId],
      );
      await transaction(async (c) => {
        await c.query(`SET LOCAL tclkolos.permitir_borrado_historico = 'on'`);
        await c.query(`DELETE FROM content_analysis_runs WHERE id = $1`, [runId]);
      });
      const [despues] = await query<{ content_analysis_run_id: string | null }>(
        `SELECT content_analysis_run_id FROM ai_runs WHERE id = $1`,
        [llamada!.id],
      );
      expect(despues!.content_analysis_run_id).toBeNull();
      expect(b.versionId).toBeTruthy();
    } finally {
      await query(`DELETE FROM ai_runs WHERE campaign_id = $1 AND task = 'analizar_guion'`, [e2.campanaId]);
      await limpiarEscenarioDeContenido(e2);
    }
  });
});

describe('la limpieza de pruebas con la FK de aprobación', () => {
  it('eliminarCampanaDePrueba borra campañas con versiones aprobadas por una revisión y con hallazgos', async () => {
    const e3 = await crearEscenarioDeContenido('analisis-esquema-limpieza');
    const { versionId } = await registrarGuionDePrueba(
      e3,
      e3.entregables.reelRios,
      e3.participaciones.valentinaRios,
      e3.consultor,
    );
    const brief = await crearBriefAprobadoDePrueba(e3.campanaId, e3.admin, { productos: [e3.productos.p80] });
    const humana = await registrarRevisionHumana(e3.consultor, versionId);
    expect(humana.ok).toBe(true);
    const runId = humana.ok ? humana.value.run.id : '';
    await query(
      `UPDATE script_versions SET status = 'approved', approved_by = $2, approved_analysis_id = $3, approved_brief_version_id = $4 WHERE id = $1`,
      [versionId, e3.director.id, runId, brief.versionId],
    );
    await expect(limpiarEscenarioDeContenido(e3)).resolves.toBeUndefined();
    const [resto] = await query<{ n: string }>(
      `SELECT count(*) AS n FROM content_analysis_runs WHERE campaign_id = $1`,
      [e3.campanaId],
    );
    expect(Number(resto!.n)).toBe(0);
  });
});

describe('paridad de roles: el autor de una revisión espeja roleCan(script:manage)', () => {
  it('cada rol de la agencia puede registrar una revisión si y solo si roleCan(rol, script:manage)', async () => {
    const { versionId } = await registrarGuionDePrueba(
      a.e,
      a.e.entregables.reelRios,
      a.e.participaciones.valentinaRios,
      a.e.consultor,
    );
    let n = 0;
    for (const rol of ROLES.filter((r) => r !== 'cliente')) {
      n += 1;
      const usuario = await asegurarUsuarioDePrueba(
        `paridad-${rol}-${a.e.sufijo}-${n}@smartpr.co`,
        `Paridad ${rol}`,
        rol,
        a.e.admin.organizationId,
      );
      const intento = await query<{ id: string }>(
        `INSERT INTO content_analysis_runs
           (organization_id, campaign_id, kind, script_version_id, deliverable_id, campaign_influencer_id,
            governing_brief_version_id, brief_fingerprint, script_source_id, script_source_hash, status, finding_count, created_by)
         SELECT sv.organization_id, sv.campaign_id, 'human', sv.id, sv.deliverable_id, d.campaign_influencer_id, $2,
                repeat('a', 64), sv.source_document_id, sv.source_hash, 'succeeded', 0, $3
           FROM script_versions sv JOIN deliverables d ON d.id = sv.deliverable_id WHERE sv.id = $1
         RETURNING id`,
        [versionId, a.brief.versionId, usuario.id],
      ).then(
        () => true,
        () => false,
      );
      expect(intento, `rol ${rol}`).toBe(roleCan(rol, 'script:manage'));
    }
  });
});
