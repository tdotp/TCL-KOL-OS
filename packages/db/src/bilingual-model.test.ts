/**
 * V2 · Fase 2 — modelo bilingüe: una versión lógica, dos representaciones.
 *
 * Verifica a nivel de base de datos (migración 014): la identidad lógica, la
 * integridad de las representaciones y de las traducciones, la congelación al
 * aprobar, la definición única de «stale» y el tratamiento de datos legacy
 * (ES-solo, ES+EN, estados en conflicto) sin reconciliar en silencio.
 *
 * Los datos legacy EN se simulan con la bandera de bypass de la migración 010
 * (solo existe en bases `_test`): nada en la aplicación puede crear hoy una
 * versión EN independiente.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { User } from '@tcl-kol-os/domain';
import { closePool, query, transaction } from './client.ts';
import { eliminarCampanaDePrueba } from './test-utils.ts';
import { findUserByEmail } from './users.ts';
import { crearBriefManual } from './manual.ts';

let admin: User;
const campanas: string[] = [];

async function nuevaCampana(etiqueta: string): Promise<string> {
  const [c] = await query<{ id: string }>(
    `INSERT INTO campaigns (organization_id, name, owner_id, created_by)
     VALUES ($1, $2, $3, $3) RETURNING id`,
    [admin.organizationId, `Bilingüe · ${etiqueta} · ${Date.now()}`, admin.id],
  );
  campanas.push(c!.id);
  return c!.id;
}

/** Brief manual con un campo informativo con valor (para poder traducirlo). */
async function nuevaVersion(etiqueta: string) {
  const campaignId = await nuevaCampana(etiqueta);
  const creado = await crearBriefManual(admin, campaignId);
  if (!creado.ok) throw new Error(creado.error.message);
  const [campo] = await query<{ id: string }>(
    `UPDATE brief_fields SET value = '"Texto original"'::jsonb, status = 'manual', provenance_type = 'manual_local',
            confidence = NULL
      WHERE id = (SELECT id FROM brief_fields WHERE brief_version_id = $1 AND criticidad = 'informativo'
                  AND campaign_product_id IS NULL ORDER BY key LIMIT 1)
      RETURNING id`,
    [creado.value.versionId],
  );
  return { campaignId, briefId: creado.value.briefId, versionId: creado.value.versionId, fieldId: campo!.id };
}

async function repEs(versionId: string): Promise<string> {
  const [r] = await query<{ id: string }>(
    `SELECT id FROM brief_version_representations WHERE brief_version_id = $1 AND language = 'es'`,
    [versionId],
  );
  return r!.id;
}

async function crearRepEn(versionId: string): Promise<string> {
  const [r] = await query<{ id: string }>(
    `INSERT INTO brief_version_representations (brief_version_id, language, kind, source_representation_id, created_by)
     VALUES ($1, 'en', 'translation', $2, $3) RETURNING id`,
    [versionId, await repEs(versionId), admin.id],
  );
  return r!.id;
}

async function traducir(fieldId: string, repId: string, valor = 'Original text') {
  await query(
    `INSERT INTO brief_field_translations
       (brief_field_id, representation_id, value, translator, source_value_hash, source_revision)
     SELECT f.id, $2, $3::jsonb, 'ai', brief_value_hash(f.value), f.revision FROM brief_fields f WHERE f.id = $1`,
    [fieldId, repId, JSON.stringify(valor)],
  );
}

async function estadoSync(repId: string, fieldId: string): Promise<string | undefined> {
  const [r] = await query<{ state: string }>(
    `SELECT state FROM brief_translation_sync WHERE representation_id = $1 AND brief_field_id = $2`,
    [repId, fieldId],
  );
  return r?.state;
}

async function conBypass<T>(fn: (q: typeof query) => Promise<T>): Promise<T> {
  return transaction(async (client) => {
    await client.query(`SET LOCAL tclkolos.permitir_borrado_historico = 'on'`);
    const q = (async (sql: string, params?: unknown[]) =>
      (await client.query(sql, params as never[])).rows) as typeof query;
    return fn(q);
  });
}

beforeAll(async () => {
  admin = (await findUserByEmail('gerardo@smartpr.co'))!;
});

afterAll(async () => {
  await eliminarCampanaDePrueba(campanas);
  await closePool();
});

describe('identidad lógica', () => {
  it('toda versión nueva nace con su representación ES original (misma versión, un solo estado)', async () => {
    const { versionId } = await nuevaVersion('identidad');
    const reps = await query<{ language: string; kind: string }>(
      `SELECT language, kind FROM brief_version_representations WHERE brief_version_id = $1`,
      [versionId],
    );
    expect(reps).toEqual([{ language: 'es', kind: 'original' }]);
  });

  it('las representaciones no tienen estado, aprobación ni linaje propios (solo la versión lógica)', async () => {
    const columnas = await query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'brief_version_representations'`,
    );
    const nombres = columnas.map((c) => c.column_name);
    for (const prohibida of ['status', 'approved_at', 'version', 'parent_version_id']) {
      expect(nombres, `la representación tiene ${prohibida}`).not.toContain(prohibida);
    }
  });

  it('no se pueden crear versiones independientes por idioma', async () => {
    const { briefId } = await nuevaVersion('sin-en-independiente');
    await expect(
      query(
        `INSERT INTO brief_versions (brief_id, organization_id, version, language, translation_of_id, created_by)
         SELECT $1, $2, 99, 'en', id, $3 FROM brief_versions WHERE brief_id = $1 LIMIT 1`,
        [briefId, admin.organizationId, admin.id],
      ),
    ).rejects.toThrow(/versiones independientes por idioma/);
  });

  it('hay exactamente una representación original por versión y un idioma una sola vez', async () => {
    const { versionId } = await nuevaVersion('unicidad');
    await expect(
      query(
        `INSERT INTO brief_version_representations (brief_version_id, language, kind, created_by)
         VALUES ($1, 'en', 'original', $2)`,
        [versionId, admin.id],
      ),
    ).rejects.toThrow();
    const rep = await crearRepEn(versionId);
    expect(rep).toBeTruthy();
    await expect(crearRepEn(versionId)).rejects.toThrow();
  });
});

describe('integridad del origen (traducción siempre con origen verificable)', () => {
  it('una traducción sin origen se rechaza', async () => {
    const { versionId } = await nuevaVersion('sin-origen');
    await expect(
      query(
        `INSERT INTO brief_version_representations (brief_version_id, language, kind, created_by)
         VALUES ($1, 'en', 'translation', $2)`,
        [versionId, admin.id],
      ),
    ).rejects.toThrow();
  });

  it('un origen de OTRA versión o del mismo idioma se rechaza', async () => {
    const a = await nuevaVersion('origen-a');
    const b = await nuevaVersion('origen-b');
    await expect(
      query(
        `INSERT INTO brief_version_representations (brief_version_id, language, kind, source_representation_id, created_by)
         VALUES ($1, 'en', 'translation', $2, $3)`,
        [a.versionId, await repEs(b.versionId), admin.id],
      ),
    ).rejects.toThrow(/MISMA versión/);
    await expect(
      query(
        `INSERT INTO brief_version_representations (brief_version_id, language, kind, source_representation_id, created_by)
         VALUES ($1, 'es', 'translation', $2, $3)`,
        [a.versionId, await repEs(a.versionId), admin.id],
      ),
    ).rejects.toThrow();
  });

  it('una traducción de un campo de OTRA versión se rechaza (origen incorrecto)', async () => {
    const a = await nuevaVersion('campo-a');
    const b = await nuevaVersion('campo-b');
    const repA = await crearRepEn(a.versionId);
    await expect(traducir(b.fieldId, repA)).rejects.toThrow(/MISMA versión/);
  });

  it('la representación original no admite valores localizados', async () => {
    const { versionId, fieldId } = await nuevaVersion('original-sin-traduccion');
    await expect(traducir(fieldId, await repEs(versionId))).rejects.toThrow(/original/);
  });

  it('el origen y el tipo de una representación son inmutables', async () => {
    const { versionId } = await nuevaVersion('inmutable-origen');
    const rep = await crearRepEn(versionId);
    await expect(
      query(`UPDATE brief_version_representations SET source_representation_id = NULL WHERE id = $1`, [rep]),
    ).rejects.toThrow();
    await expect(
      query(`UPDATE brief_version_representations SET kind = 'legacy_import' WHERE id = $1`, [rep]),
    ).rejects.toThrow();
  });
});

describe('staleness: una sola definición verificable', () => {
  it('missing → current → stale → current según el valor original', async () => {
    const { versionId, fieldId } = await nuevaVersion('staleness');
    const rep = await crearRepEn(versionId);

    expect(await estadoSync(rep, fieldId)).toBe('missing');
    await traducir(fieldId, rep);
    expect(await estadoSync(rep, fieldId)).toBe('current');

    // Solo confirmar el campo original (cambia revision, NO el valor) no la invalida.
    await query(`UPDATE brief_fields SET review_status = 'confirmed' WHERE id = $1`, [fieldId]);
    expect(await estadoSync(rep, fieldId)).toBe('current');

    // Cambiar el VALOR original la deja stale.
    await query(`UPDATE brief_fields SET value = '"Texto original modificado"'::jsonb WHERE id = $1`, [
      fieldId,
    ]);
    expect(await estadoSync(rep, fieldId)).toBe('stale');

    // Retraducir sobre el valor vigente la vuelve a dejar al día.
    await query(
      `UPDATE brief_field_translations t SET value = '"Updated"'::jsonb,
              source_value_hash = brief_value_hash(f.value), source_revision = f.revision
         FROM brief_fields f WHERE f.id = t.brief_field_id AND t.brief_field_id = $1`,
      [fieldId],
    );
    expect(await estadoSync(rep, fieldId)).toBe('current');
  });

  it('una traducción sin huella (histórica) es «unverified», nunca «current»', async () => {
    const { versionId, fieldId } = await nuevaVersion('sin-huella');
    const rep = await crearRepEn(versionId);
    await query(
      `INSERT INTO brief_field_translations (brief_field_id, representation_id, value, translator)
       VALUES ($1, $2, '"x"'::jsonb, 'legacy')`,
      [fieldId, rep],
    );
    expect(await estadoSync(rep, fieldId)).toBe('unverified');
  });

  it('un campo sin valor no requiere traducción', async () => {
    const { versionId } = await nuevaVersion('sin-valor');
    const rep = await crearRepEn(versionId);
    const sinValor = await query<{ n: string }>(
      `SELECT count(*)::text AS n FROM brief_translation_sync s
        JOIN brief_fields f ON f.id = s.brief_field_id
       WHERE s.representation_id = $1 AND (f.value IS NULL OR f.value = 'null'::jsonb)`,
      [rep],
    );
    expect(sinValor[0]!.n).toBe('0');
  });
});

describe('aprobada: ambas representaciones congeladas', () => {
  it('no admite traducciones nuevas, cambios ni borrados; ni cambios del linaje', async () => {
    const { versionId, fieldId } = await nuevaVersion('congelada');
    const rep = await crearRepEn(versionId);
    await traducir(fieldId, rep);

    await query(`UPDATE brief_versions SET status = 'approved', approved_at = now() WHERE id = $1`, [
      versionId,
    ]);

    await expect(
      query(`UPDATE brief_field_translations SET value = '"hackeado"'::jsonb WHERE representation_id = $1`, [
        rep,
      ]),
    ).rejects.toThrow(/inmutables/);
    await expect(
      query(`UPDATE brief_field_translations SET source_value_hash = 'x' WHERE representation_id = $1`, [
        rep,
      ]),
    ).rejects.toThrow();
    await expect(
      query(`DELETE FROM brief_field_translations WHERE representation_id = $1`, [rep]),
    ).rejects.toThrow();
    await expect(
      query(`UPDATE brief_version_representations SET copied_from_representation_id = $1 WHERE id = $1`, [
        rep,
      ]),
    ).rejects.toThrow();
    await expect(query(`DELETE FROM brief_version_representations WHERE id = $1`, [rep])).rejects.toThrow();
    await expect(
      query(`UPDATE brief_fields SET value = '"hackeado"'::jsonb WHERE id = $1`, [fieldId]),
    ).rejects.toThrow();
    await expect(
      query(`UPDATE brief_versions SET parent_version_id = id WHERE id = $1`, [versionId]),
    ).rejects.toThrow();
  });

  it('no se añade una traducción nueva a una versión aprobada', async () => {
    const { versionId } = await nuevaVersion('sin-traduccion-nueva');
    await query(`UPDATE brief_versions SET status = 'approved', approved_at = now() WHERE id = $1`, [
      versionId,
    ]);
    await expect(crearRepEn(versionId)).rejects.toThrow(/versión aprobada/);
  });
});

describe('datos legacy: se clasifican, nunca se reconcilian en silencio', () => {
  /** ES (+ EN histórico opcional) con un campo con valor en cada fila, creados con el bypass de pruebas. */
  async function escenario(
    etiqueta: string,
    opciones: { estadoEs: string; estadoEn?: string; segundoEn?: boolean; ensamblar?: boolean },
  ) {
    const base = await nuevaVersion(etiqueta);
    const [campoEs] = await query<{ key: string }>(`SELECT key FROM brief_fields WHERE id = $1`, [
      base.fieldId,
    ]);
    let enId: string | undefined;
    let en2Id: string | undefined;
    await conBypass(async (q) => {
      const crearEn = async (version: number, estado: string) => {
        const [e] = await q<{ id: string }>(
          `INSERT INTO brief_versions (brief_id, organization_id, version, language, translation_of_id, status, created_by)
           VALUES ($1, $2, $3, 'en', $4, $5::brief_status, $6) RETURNING id`,
          [base.briefId, admin.organizationId, version, base.versionId, estado, admin.id],
        );
        await q(
          `INSERT INTO brief_fields (brief_version_id, key, value, status, provenance_type, criticidad, review_status)
           VALUES ($1, $2, '"Legacy English text"'::jsonb, 'found', 'translated', 'informativo', 'pending')`,
          [e!.id, campoEs!.key],
        );
        return e!.id;
      };
      if (opciones.estadoEn !== undefined) enId = await crearEn(1, opciones.estadoEn);
      if (opciones.segundoEn === true) en2Id = await crearEn(2, opciones.estadoEn ?? 'draft');
      if (opciones.estadoEs !== 'draft') {
        await q(
          `UPDATE brief_versions SET status = $1::brief_status, approved_at = CASE WHEN $1 = 'approved' THEN now() END WHERE id = $2`,
          [opciones.estadoEs, base.versionId],
        );
      }
    });
    return { ...base, enId, en2Id };
  }

  async function plegar(): Promise<Array<{ en_version_id: string; classification: string }>> {
    return conBypass((q) => q(`SELECT * FROM brief_legacy_en_fold()`) as never);
  }

  async function enlace(enId: string) {
    const [l] = await query<{ classification: string; reason: string; es_version_id: string | null }>(
      `SELECT classification, reason, es_version_id FROM brief_legacy_language_links WHERE en_version_id = $1`,
      [enId],
    );
    return l;
  }

  async function estados(esId: string, enId: string) {
    const [es] = await query<{ status: string }>(`SELECT status::text FROM brief_versions WHERE id = $1`, [
      esId,
    ]);
    const [en] = await query<{ status: string }>(`SELECT status::text FROM brief_versions WHERE id = $1`, [
      enId,
    ]);
    return { es: es!.status, en: en!.status };
  }

  it('Caso A: una versión histórica solo ES sigue leyéndose, sin enlaces ni representaciones extra', async () => {
    const { versionId } = await nuevaVersion('legacy-a');
    await plegar();
    const reps = await query(`SELECT 1 FROM brief_version_representations WHERE brief_version_id = $1`, [
      versionId,
    ]);
    expect(reps).toHaveLength(1);
  });

  it('Caso B: ES + EN con el mismo estado → una sola versión lógica con EN importada y sin verificar', async () => {
    const e = await escenario('legacy-b', { estadoEs: 'draft', estadoEn: 'draft' });
    const resultado = await plegar();
    expect(resultado.find((r) => r.en_version_id === e.enId)?.classification).toBe('folded');
    expect((await enlace(e.enId!))?.es_version_id).toBe(e.versionId);

    const [rep] = await query<{
      id: string;
      kind: string;
      legacy_version_id: string;
      source_representation_id: string;
    }>(
      `SELECT id, kind, legacy_version_id, source_representation_id FROM brief_version_representations
        WHERE brief_version_id = $1 AND language = 'en'`,
      [e.versionId],
    );
    expect(rep).toMatchObject({ kind: 'legacy_import', legacy_version_id: e.enId });
    expect(rep!.source_representation_id).toBe(await repEs(e.versionId));

    // Contenido conservado y marcado «sin verificar» (no se puede probar que estaba al día).
    const [t] = await query<{ value: unknown; translator: string; legacy_field_id: string | null }>(
      `SELECT value, translator, legacy_field_id FROM brief_field_translations WHERE representation_id = $1`,
      [rep!.id],
    );
    expect(t).toMatchObject({ value: 'Legacy English text', translator: 'legacy' });
    expect(t!.legacy_field_id).not.toBeNull();
    expect(await estadoSync(rep!.id, e.fieldId)).toBe('unverified');

    // La fila EN histórica y su contenido siguen intactos.
    const [campoEn] = await query<{ value: unknown }>(
      `SELECT value FROM brief_fields WHERE brief_version_id = $1`,
      [e.enId],
    );
    expect(campoEn!.value).toBe('Legacy English text');
    expect(await estados(e.versionId, e.enId!)).toEqual({ es: 'draft', en: 'draft' });
  });

  it('Caso B (aprobadas): ambas aprobadas con el mismo estado se importan sin tocar nada', async () => {
    const e = await escenario('legacy-b-aprobadas', { estadoEs: 'approved', estadoEn: 'approved' });
    const resultado = await plegar();
    expect(resultado.find((r) => r.en_version_id === e.enId)?.classification).toBe('folded');
    expect(await estados(e.versionId, e.enId!)).toEqual({ es: 'approved', en: 'approved' });
  });

  it('Caso C: estados históricos distintos → conflicto marcado; NO se elige ganador ni se toca ningún dato', async () => {
    const e = await escenario('legacy-c', { estadoEs: 'approved', estadoEn: 'draft' });
    const resultado = await plegar();
    expect(resultado.find((r) => r.en_version_id === e.enId)?.classification).toBe('conflict');
    const link = await enlace(e.enId!);
    expect(link?.reason).toMatch(/estados históricos distintos: ES=approved, EN=draft/);

    // Sin representación EN importada, estados sin cambios.
    const en = await query(
      `SELECT 1 FROM brief_version_representations WHERE brief_version_id = $1 AND language = 'en'`,
      [e.versionId],
    );
    expect(en).toHaveLength(0);
    expect(await estados(e.versionId, e.enId!)).toEqual({ es: 'approved', en: 'draft' });
    const [campoEn] = await query<{ value: unknown }>(
      `SELECT value FROM brief_fields WHERE brief_version_id = $1`,
      [e.enId],
    );
    expect(campoEn!.value).toBe('Legacy English text');
  });

  it('varias versiones EN para la misma ES → todas en conflicto (no se elige una)', async () => {
    const e = await escenario('legacy-duplicado', { estadoEs: 'draft', estadoEn: 'draft', segundoEn: true });
    await plegar();
    expect((await enlace(e.enId!))?.classification).toBe('conflict');
    expect((await enlace(e.en2Id!))?.classification).toBe('conflict');
  });

  it('EN sin versión ES de origen válida → huérfana', async () => {
    const base = await nuevaVersion('legacy-huerfano');
    let huerfano = '';
    await conBypass(async (q) => {
      const [en1] = await q<{ id: string }>(
        `INSERT INTO brief_versions (brief_id, organization_id, version, language, translation_of_id, created_by)
         VALUES ($1, $2, 1, 'en', $3, $4) RETURNING id`,
        [base.briefId, admin.organizationId, base.versionId, admin.id],
      );
      const [en2] = await q<{ id: string }>(
        `INSERT INTO brief_versions (brief_id, organization_id, version, language, translation_of_id, created_by)
         VALUES ($1, $2, 2, 'en', $3, $4) RETURNING id`,
        [base.briefId, admin.organizationId, en1!.id, admin.id],
      );
      huerfano = en2!.id;
    });
    await plegar();
    const l = await enlace(huerfano);
    expect(l?.classification).toBe('orphan');
    expect(l?.es_version_id).toBeNull();
  });

  it('el proceso es idempotente: una segunda pasada no vuelve a importar ni cambia nada', async () => {
    const e = await escenario('legacy-idempotente', { estadoEs: 'draft', estadoEn: 'draft' });
    await plegar();
    const segunda = await plegar();
    expect(segunda.find((r) => r.en_version_id === e.enId)).toBeUndefined();
    const reps = await query(
      `SELECT 1 FROM brief_version_representations WHERE brief_version_id = $1 AND language = 'en'`,
      [e.versionId],
    );
    expect(reps).toHaveLength(1);
  });
});
