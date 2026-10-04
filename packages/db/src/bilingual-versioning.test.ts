/**
 * V2 · Fase 2 — la versión lógica bilingüe en la aplicación.
 *
 * Una sola identidad, un solo estado, una sola aprobación; ES y EN como
 * representaciones. Aquí se prueba el comportamiento de la capa de aplicación
 * (traducir, aprobar, versionar, leer, legacy) sobre el modelo de la
 * migración 014. HITL (Fase 1) y DEC-042 se comprueban de nuevo sobre versiones
 * con traducciones.
 *
 * Campañas propias y desechables (INC-001A).
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { User } from '@tcl-kol-os/domain';
import { closePool, query, transaction } from './client.ts';
import { asegurarUsuarioDePrueba, eliminarCampanaDePrueba } from './test-utils.ts';
import { findUserByEmail } from './users.ts';
import { crearBriefManual } from './manual.ts';
import { corregirCampo } from './brief-fields.ts';
import { aprobarBrief } from './client-review.ts';
import { transicionarBrief } from './transitions.ts';
import { crearVersionHija } from './versioning.ts';
import { versionesDelBrief } from './extraction.ts';
import { obtenerBriefWorkspace } from './brief-workspace.ts';
import { obtenerRepresentacion, obtenerVersionLogica, registrarTraduccion } from './brief-representations.ts';
import { confirmarAccion, ejecutarAccion, proponerAccion } from './proposed-actions.ts';

let admin: User;
let director: User;
let consultor: User;
let cliente: User;
let operativo: User;
const campanas: string[] = [];

interface Caso {
  campaignId: string;
  briefId: string;
  versionId: string;
  /** Dos campos informativos con valor (para poder traducirlos). */
  campos: Array<{ id: string; key: string; revision: number }>;
}

/** Brief manual en revisión interna, con dos campos informativos con valor. */
async function nuevoCaso(etiqueta: string): Promise<Caso> {
  const [c] = await query<{ id: string }>(
    `INSERT INTO campaigns (organization_id, name, owner_id, created_by)
     VALUES ($1, $2, $3, $3) RETURNING id`,
    [admin.organizationId, `BilingüeApp · ${etiqueta} · ${Date.now()}`, admin.id],
  );
  campanas.push(c!.id);
  const creado = await crearBriefManual(admin, c!.id);
  if (!creado.ok) throw new Error(creado.error.message);
  const campos = await query<{ id: string; key: string; revision: number }>(
    `UPDATE brief_fields SET value = to_jsonb('Texto de ' || key), status = 'manual',
            provenance_type = 'manual_local', confidence = NULL
      WHERE id IN (SELECT id FROM brief_fields WHERE brief_version_id = $1 AND criticidad = 'informativo'
                   AND campaign_product_id IS NULL ORDER BY key LIMIT 2)
      RETURNING id, key, revision`,
    [creado.value.versionId],
  );
  await query(`UPDATE brief_versions SET status = 'internal_review' WHERE id = $1`, [creado.value.versionId]);
  return { campaignId: c!.id, briefId: creado.value.briefId, versionId: creado.value.versionId, campos };
}

async function traducirTodo(caso: Caso, actor: User | 'system' = consultor) {
  for (const campo of caso.campos) {
    const r = await registrarTraduccion(actor, caso.versionId, {
      language: 'en',
      fieldKey: campo.key,
      value: `Text of ${campo.key}`,
      translator: actor === 'system' ? 'ai' : 'human',
    });
    if (!r.ok) throw new Error(`traducción falló: ${r.error.message}`);
  }
}

async function estado(versionId: string) {
  const [v] = await query<{ status: string; approved_at: Date | null }>(
    `SELECT status::text, approved_at FROM brief_versions WHERE id = $1`,
    [versionId],
  );
  return v!;
}

async function conBypass<T>(
  fn: (q: (sql: string, p?: unknown[]) => Promise<any[]>) => Promise<T>,
): Promise<T> {
  return transaction(async (client) => {
    await client.query(`SET LOCAL tclkolos.permitir_borrado_historico = 'on'`);
    return fn(async (sql, p) => (await client.query(sql, p as never[])).rows);
  });
}

beforeAll(async () => {
  admin = (await findUserByEmail('gerardo@smartpr.co'))!;
  director = (await findUserByEmail('director@smartpr.co'))!;
  consultor = (await findUserByEmail('consultor@smartpr.co'))!;
  cliente = (await findUserByEmail('marena@tcl.com'))!;
  operativo = await asegurarUsuarioDePrueba(
    'operativo@smartpr.co',
    'Usuario Operativo',
    'operativo',
    admin.organizationId,
  );
});

afterAll(async () => {
  await eliminarCampanaDePrueba(campanas);
  await closePool();
});

// ─────────────────────────── Identidad, estado y aprobación únicos ─────────────

describe('una versión lógica, ES y EN como representaciones', () => {
  it('ES y EN pertenecen a la MISMA versión y comparten estado, aprobación y linaje', async () => {
    const caso = await nuevoCaso('identidad');
    await traducirTodo(caso);

    const logica = await obtenerVersionLogica(consultor, caso.versionId);
    if (!logica.ok) throw new Error(logica.error.message);
    const v = logica.value;
    expect(Object.keys(v.representations).sort()).toEqual(['en', 'es']);
    expect(v.representations.es).toMatchObject({ kind: 'original', sync: 'original' });
    expect(v.representations.en).toMatchObject({
      kind: 'translation',
      sourceLanguage: 'es',
      sync: 'current',
    });
    // Un único estado y una única aprobación en la versión lógica.
    expect(v.status).toBe('internal_review');
    expect(v.approvedAt).toBeUndefined();

    const reps = await query<{ brief_version_id: string }>(
      `SELECT brief_version_id FROM brief_version_representations WHERE brief_version_id = $1`,
      [caso.versionId],
    );
    expect(new Set(reps.map((r) => r.brief_version_id))).toEqual(new Set([caso.versionId]));
    // No hay versiones por idioma: una sola fila en brief_versions.
    const filas = await query(`SELECT 1 FROM brief_versions WHERE brief_id = $1`, [caso.briefId]);
    expect(filas).toHaveLength(1);
  });

  it('una aprobación cubre la versión lógica: ES y EN quedan aprobadas juntas, con una sola fecha', async () => {
    const caso = await nuevoCaso('aprobacion-unica');
    await traducirTodo(caso);
    const r = await aprobarBrief(director, caso.versionId);
    expect(r.ok, !r.ok ? r.error.message : '').toBe(true);

    const v = await estado(caso.versionId);
    expect(v.status).toBe('approved');
    expect(v.approved_at).not.toBeNull();

    const logica = await obtenerVersionLogica(director, caso.versionId);
    if (!logica.ok) throw new Error('lectura falló');
    expect(logica.value.status).toBe('approved');
    expect(logica.value.representations.es).toBeDefined();
    expect(logica.value.representations.en).toBeDefined();
  });

  it('no existe forma de aprobar solo una representación: cada idioma no tiene estado propio', async () => {
    const caso = await nuevoCaso('sin-aprobacion-por-idioma');
    await traducirTodo(caso);
    const columnas = await query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name IN ('brief_version_representations', 'brief_field_translations')`,
    );
    for (const c of columnas) {
      expect(['status', 'approved_at', 'approved_by', 'review_status']).not.toContain(c.column_name);
    }
    // Y la versión sigue sin aprobar mientras nadie la apruebe.
    expect((await estado(caso.versionId)).status).toBe('internal_review');
  });

  it('una fila EN histórica no se puede aprobar ni mover por separado', async () => {
    const caso = await nuevoCaso('en-historica-no-opera');
    let enId = '';
    await conBypass(async (q) => {
      const [e] = await q(
        `INSERT INTO brief_versions (brief_id, organization_id, version, language, translation_of_id, status, created_by)
         VALUES ($1, $2, 1, 'en', $3, 'internal_review', $4) RETURNING id`,
        [caso.briefId, admin.organizationId, caso.versionId, admin.id],
      );
      enId = e.id;
    });
    for (const to of ['approved', 'internal_changes_requested', 'cancelled'] as const) {
      const r = await transicionarBrief(director, enId, to, { motivo: 'intento' });
      expect(r.ok, `logró → ${to}`).toBe(false);
    }
    expect((await crearVersionHija(admin, enId)).ok).toBe(false);
    expect((await estado(enId)).status).toBe('internal_review');
    expect((await estado(caso.versionId)).status).toBe('internal_review');
  });
});

// ─────────────────────────── Traducir ──────────────────────────────────────────

describe('registrar una traducción', () => {
  it('queda con origen, procedencia, traductor y auditoría (origin y correlación de Fase 1)', async () => {
    const caso = await nuevoCaso('traduccion-origen');
    const campo = caso.campos[0]!;
    const r = await registrarTraduccion(consultor, caso.versionId, {
      language: 'en',
      fieldKey: campo.key,
      value: 'Translated text',
      translator: 'human',
      origin: 'chat',
      correlation: { conversationId: 'conv-1', messageId: 'msg-7' },
    });
    expect(r.ok, !r.ok ? r.error.message : '').toBe(true);

    const [rep] = await query<{ kind: string; source_language: string }>(
      `SELECT r.kind, s.language AS source_language
         FROM brief_version_representations r
         JOIN brief_version_representations s ON s.id = r.source_representation_id
        WHERE r.brief_version_id = $1 AND r.language = 'en'`,
      [caso.versionId],
    );
    expect(rep).toEqual({ kind: 'translation', source_language: 'es' });

    const [t] = await query<{ provenance_type: string; translator: string; source_revision: number }>(
      `SELECT provenance_type::text, translator, source_revision FROM brief_field_translations WHERE brief_field_id = $1`,
      [campo.id],
    );
    expect(t).toMatchObject({ provenance_type: 'manual_local', translator: 'human' });

    const eventos = await query<{ action: string; origin: string; actor_id: string; correlation: unknown }>(
      `SELECT action, origin, actor_id, correlation FROM audit_events
        WHERE entity_id = $1 AND action IN ('brief.representation.create', 'brief.translation.set')
        ORDER BY action`,
      [caso.versionId],
    );
    expect(eventos.map((e) => e.action)).toEqual(['brief.representation.create', 'brief.translation.set']);
    for (const e of eventos) {
      expect(e).toMatchObject({ origin: 'chat', actor_id: consultor.id });
      expect(e.correlation).toMatchObject({ conversationId: 'conv-1', messageId: 'msg-7' });
    }

    // Historial de contenido rastreable (brief_field_revisions, acción translate, idioma en).
    const [rev] = await query<{ accion: string; language: string; valor_nuevo: unknown }>(
      `SELECT accion, language, valor_nuevo FROM brief_field_revisions WHERE brief_field_id = $1 AND accion = 'translate'`,
      [campo.id],
    );
    expect(rev).toMatchObject({ accion: 'translate', language: 'en', valor_nuevo: 'Translated text' });
  });

  it('una traducción de proceso (ai) queda como translated; el sistema puede registrarla pero no la humana', async () => {
    const caso = await nuevoCaso('traduccion-ai');
    const campo = caso.campos[0]!;
    const ia = await registrarTraduccion('system', caso.versionId, {
      language: 'en',
      fieldKey: campo.key,
      value: 'Machine text',
      translator: 'ai',
    });
    expect(ia.ok, !ia.ok ? ia.error.message : '').toBe(true);
    const [t] = await query<{ provenance_type: string; translator: string }>(
      `SELECT provenance_type::text, translator FROM brief_field_translations WHERE brief_field_id = $1`,
      [campo.id],
    );
    expect(t).toEqual({ provenance_type: 'translated', translator: 'ai' });
    const [ev] = await query<{ origin: string; actor_id: string | null }>(
      `SELECT origin, actor_id FROM audit_events WHERE entity_id = $1 AND action = 'brief.translation.set'`,
      [caso.versionId],
    );
    expect(ev).toEqual({ origin: 'system', actor_id: null });

    const humanaPorSistema = await registrarTraduccion('system', caso.versionId, {
      language: 'en',
      fieldKey: campo.key,
      value: 'x',
      translator: 'human',
    });
    expect(humanaPorSistema.ok).toBe(false);
  });

  it('permisos: consultor sí; cliente y operativo no; el idioma original no se traduce', async () => {
    const caso = await nuevoCaso('traduccion-permisos');
    const campo = caso.campos[0]!;
    const base = { language: 'en' as const, fieldKey: campo.key, value: 'x', translator: 'human' as const };
    expect((await registrarTraduccion(cliente, caso.versionId, base)).ok).toBe(false);
    expect((await registrarTraduccion(operativo, caso.versionId, base)).ok).toBe(false);
    expect((await registrarTraduccion(consultor, caso.versionId, { ...base, language: 'es' })).ok).toBe(
      false,
    );
    expect((await registrarTraduccion(consultor, caso.versionId, base)).ok).toBe(true);
  });

  it('una versión aprobada no admite traducciones nuevas', async () => {
    const caso = await nuevoCaso('traduccion-aprobada');
    expect((await aprobarBrief(director, caso.versionId)).ok).toBe(true);
    const r = await registrarTraduccion(consultor, caso.versionId, {
      language: 'en',
      fieldKey: caso.campos[0]!.key,
      value: 'x',
      translator: 'human',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('BRIEF_VERSION_IMMUTABLE');
  });
});

// ─────────────────────────── Staleness y aprobación ────────────────────────────

describe('staleness: modificar el origen invalida la traducción derivada', () => {
  it('cambiar el valor ES deja la traducción stale y la versión NO se aprueba', async () => {
    const caso = await nuevoCaso('stale');
    await traducirTodo(caso);
    const campo = caso.campos[0]!;

    // Estado inicial: al día y aprobable.
    const antes = await obtenerRepresentacion(consultor, caso.versionId, 'en');
    if (!antes.ok) throw new Error(antes.error.message);
    expect(antes.value.sync).toBe('current');

    // Se modifica ES (el campo está en revisión interna; la edición es de la versión de trabajo).
    await query(`UPDATE brief_versions SET status = 'draft' WHERE id = $1`, [caso.versionId]);
    const edicion = await corregirCampo(admin, caso.versionId, campo.id, {
      value: 'Texto ES modificado',
      revisionEsperada: campo.revision,
    });
    expect(edicion.ok, !edicion.ok ? edicion.error.message : '').toBe(true);
    await query(`UPDATE brief_versions SET status = 'internal_review' WHERE id = $1`, [caso.versionId]);

    const despues = await obtenerRepresentacion(consultor, caso.versionId, 'en');
    if (!despues.ok) throw new Error(despues.error.message);
    expect(despues.value.sync).toBe('stale');
    expect(despues.value.fields.find((f) => f.key === campo.key)?.sync).toBe('stale');
    expect(despues.value.fields.find((f) => f.key !== campo.key)?.sync).toBe('current');

    const logica = await obtenerVersionLogica(consultor, caso.versionId);
    if (!logica.ok) throw new Error('lectura falló');
    expect(logica.value.representations.en?.sync).toBe('stale');
    expect(logica.value.representations.en?.staleFieldKeys).toEqual([campo.key]);

    const aprobar = await aprobarBrief(director, caso.versionId);
    expect(aprobar.ok).toBe(false);
    if (!aprobar.ok) expect(aprobar.error.code).toBe('TRANSLATION_STALE');
    expect((await estado(caso.versionId)).status).toBe('internal_review');

    // Retraducir sobre el valor vigente la deja al día y entonces sí se aprueba.
    const nueva = await registrarTraduccion(consultor, caso.versionId, {
      language: 'en',
      fieldKey: campo.key,
      value: 'Modified ES text, translated',
      translator: 'human',
    });
    expect(nueva.ok).toBe(true);
    expect((await aprobarBrief(director, caso.versionId)).ok).toBe(true);
  });

  it('una traducción incompleta (campos con valor sin traducir) tampoco se aprueba', async () => {
    const caso = await nuevoCaso('incompleta');
    await registrarTraduccion(consultor, caso.versionId, {
      language: 'en',
      fieldKey: caso.campos[0]!.key,
      value: 'Only one field translated',
      translator: 'human',
    });
    const r = await aprobarBrief(director, caso.versionId);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('TRANSLATION_STALE');
  });

  it('sin EN todavía (no se ha generado), la versión se aprueba solo con el original requerido', async () => {
    const caso = await nuevoCaso('sin-en');
    expect((await aprobarBrief(director, caso.versionId)).ok).toBe(true);
  });

  it('confirmar el campo ES (sin cambiar su valor) NO invalida la traducción', async () => {
    const caso = await nuevoCaso('confirmar-no-invalida');
    await traducirTodo(caso);
    await query(`UPDATE brief_fields SET review_status = 'confirmed' WHERE id = $1`, [caso.campos[0]!.id]);
    const logica = await obtenerVersionLogica(consultor, caso.versionId);
    if (!logica.ok) throw new Error('lectura falló');
    expect(logica.value.representations.en?.sync).toBe('current');
  });
});

// ─────────────────────────── HITL y DEC-042 sobre versiones bilingües ──────────

describe('la aprobación sigue siendo humana, atómica y protegida (Fase 1 intacta)', () => {
  it('system, chat, cliente, consultor y operativo no aprueban una versión con EN al día', async () => {
    const caso = await nuevoCaso('actores');
    await traducirTodo(caso);
    expect((await transicionarBrief('system', caso.versionId, 'approved')).ok).toBe(false);
    expect((await aprobarBrief(director, caso.versionId, { origen: 'chat' })).ok).toBe(false);
    for (const actor of [cliente, consultor, operativo]) {
      expect((await aprobarBrief(actor, caso.versionId)).ok, actor.role).toBe(false);
    }
    expect((await estado(caso.versionId)).status).toBe('internal_review');
  });

  it('propuesta → confirmación → ejecución aprueba ES y EN a la vez; el replay falla', async () => {
    const caso = await nuevoCaso('hitl');
    await traducirTodo(caso);
    const p = await proponerAccion(consultor, {
      type: 'brief.approve',
      resourceId: caso.versionId,
      origin: 'chat',
    });
    if (!p.ok) throw new Error(p.error.message);
    expect(
      (await confirmarAccion(director, p.value.id, { canal: 'ui', payloadHash: p.value.payloadHash })).ok,
    ).toBe(true);
    const e = await ejecutarAccion(director, p.value.id, { canal: 'ui' });
    expect(e.ok, !e.ok ? e.error.message : '').toBe(true);
    expect((await estado(caso.versionId)).status).toBe('approved');
    expect((await ejecutarAccion(director, p.value.id, { canal: 'ui' })).ok).toBe(false);
  });

  it('si una traducción cambia entre la propuesta y la confirmación, la confirmación falla', async () => {
    const caso = await nuevoCaso('hitl-traduccion-cambia');
    await traducirTodo(caso);
    const p = await proponerAccion(consultor, {
      type: 'brief.approve',
      resourceId: caso.versionId,
      origin: 'chat',
    });
    if (!p.ok) throw new Error(p.error.message);
    await registrarTraduccion(consultor, caso.versionId, {
      language: 'en',
      fieldKey: caso.campos[0]!.key,
      value: 'Changed after the proposal',
      translator: 'human',
    });
    const c = await confirmarAccion(director, p.value.id, { canal: 'ui', payloadHash: p.value.payloadHash });
    expect(c.ok).toBe(false);
    if (!c.ok) expect(c.error.code).toBe('PROPOSAL_STALE');
  });

  it('una propuesta con traducción stale se confirma pero NO se ejecuta (guarda dentro de la ejecución atómica)', async () => {
    const caso = await nuevoCaso('hitl-stale');
    await traducirTodo(caso);
    // ES cambia antes de proponer → EN stale desde el principio.
    await query(`UPDATE brief_versions SET status = 'draft' WHERE id = $1`, [caso.versionId]);
    await corregirCampo(admin, caso.versionId, caso.campos[0]!.id, {
      value: 'Cambio previo',
      revisionEsperada: caso.campos[0]!.revision,
    });
    await query(`UPDATE brief_versions SET status = 'internal_review' WHERE id = $1`, [caso.versionId]);

    const p = await proponerAccion(consultor, {
      type: 'brief.approve',
      resourceId: caso.versionId,
      origin: 'chat',
    });
    if (!p.ok) throw new Error(p.error.message);
    expect(
      (await confirmarAccion(director, p.value.id, { canal: 'ui', payloadHash: p.value.payloadHash })).ok,
    ).toBe(true);
    const e = await ejecutarAccion(director, p.value.id, { canal: 'ui' });
    expect(e.ok).toBe(false);
    if (!e.ok) expect(e.error.code).toBe('TRANSLATION_STALE');
    expect((await estado(caso.versionId)).status).toBe('internal_review');
    const [a] = await query<{ status: string }>(`SELECT status FROM proposed_actions WHERE id = $1`, [
      p.value.id,
    ]);
    expect(a!.status).toBe('confirmed');
  });
});

// ─────────────────────────── Inmutabilidad tras aprobar ────────────────────────

describe('approved congela ES, EN, provenance y linaje', () => {
  it('ninguna de las dos representaciones ni su provenance cambian', async () => {
    const caso = await nuevoCaso('congelada');
    await traducirTodo(caso);
    await aprobarBrief(director, caso.versionId);

    const campo = caso.campos[0]!;
    const sentencias = [
      `UPDATE brief_fields SET value = '"x"'::jsonb WHERE id = '${campo.id}'`,
      `UPDATE brief_fields SET provenance_type = 'extracted' WHERE id = '${campo.id}'`,
      `UPDATE brief_field_translations SET value = '"x"'::jsonb WHERE brief_field_id = '${campo.id}'`,
      `UPDATE brief_field_translations SET provenance_type = 'manual_local', translator = 'human'
         WHERE brief_field_id = '${campo.id}'`,
      `UPDATE brief_field_translations SET source_value_hash = NULL WHERE brief_field_id = '${campo.id}'`,
      `DELETE FROM brief_field_translations WHERE brief_field_id = '${campo.id}'`,
      `UPDATE brief_version_representations SET copied_from_representation_id = id
         WHERE brief_version_id = '${caso.versionId}'`,
      `DELETE FROM brief_version_representations WHERE brief_version_id = '${caso.versionId}' AND language = 'en'`,
      `UPDATE brief_versions SET parent_version_id = id WHERE id = '${caso.versionId}'`,
      `UPDATE brief_versions SET approved_at = now() - interval '1 day' WHERE id = '${caso.versionId}'`,
    ];
    for (const sql of sentencias) await expect(query(sql), sql).rejects.toThrow();
    // Y sigue legible, intacta.
    const en = await obtenerRepresentacion(director, caso.versionId, 'en');
    if (!en.ok) throw new Error('lectura falló');
    expect(en.value.fields.map((f) => f.value).sort()).toEqual(
      caso.campos.map((c) => `Text of ${c.key}`).sort(),
    );
    expect(en.value.sync).toBe('current');
  });
});

// ─────────────────────────── Versionado ────────────────────────────────────────

describe('crear una versión hija', () => {
  it('produce Versión N+1 con sus representaciones, linaje y traducciones; el padre no se toca', async () => {
    const caso = await nuevoCaso('hija');
    await traducirTodo(caso);
    await aprobarBrief(director, caso.versionId);

    const antesReps = await query(
      `SELECT r.id, r.language, r.kind, r.copied_from_representation_id FROM brief_version_representations r
        WHERE r.brief_version_id = $1 ORDER BY r.language`,
      [caso.versionId],
    );
    const antesTrad = await query(
      `SELECT t.brief_field_id, t.value, t.source_value_hash FROM brief_field_translations t
        JOIN brief_version_representations r ON r.id = t.representation_id
       WHERE r.brief_version_id = $1 ORDER BY t.brief_field_id`,
      [caso.versionId],
    );

    const hija = await crearVersionHija(admin, caso.versionId);
    if (!hija.ok) throw new Error(hija.error.message);

    // El padre: solo pasa a superseded; sus representaciones y traducciones, idénticas.
    expect((await estado(caso.versionId)).status).toBe('superseded');
    expect(
      await query(
        `SELECT r.id, r.language, r.kind, r.copied_from_representation_id FROM brief_version_representations r
          WHERE r.brief_version_id = $1 ORDER BY r.language`,
        [caso.versionId],
      ),
    ).toEqual(antesReps);
    expect(
      await query(
        `SELECT t.brief_field_id, t.value, t.source_value_hash FROM brief_field_translations t
          JOIN brief_version_representations r ON r.id = t.representation_id
         WHERE r.brief_version_id = $1 ORDER BY t.brief_field_id`,
        [caso.versionId],
      ),
    ).toEqual(antesTrad);

    // La hija: versión lógica propia, editable, con ES y EN y linaje por representación.
    const logica = await obtenerVersionLogica(admin, hija.value.versionId);
    if (!logica.ok) throw new Error('lectura falló');
    expect(logica.value).toMatchObject({ version: 2, status: 'draft', parentVersionId: caso.versionId });
    expect(Object.keys(logica.value.representations).sort()).toEqual(['en', 'es']);
    expect(logica.value.representations.en?.sync).toBe('current');
    const linaje = await query<{ language: string; padre: string | null; esperado: string }>(
      `SELECT r.language, r.copied_from_representation_id AS padre, p.id AS esperado
         FROM brief_version_representations r
         JOIN brief_version_representations p ON p.brief_version_id = $2 AND p.language = r.language
        WHERE r.brief_version_id = $1`,
      [hija.value.versionId, caso.versionId],
    );
    expect(linaje).toHaveLength(2);
    for (const l of linaje) expect(l.padre).toBe(l.esperado);

    // El historial anterior sigue legible.
    const padre = await obtenerVersionLogica(admin, caso.versionId);
    expect(padre.ok && padre.value.status).toBe('superseded');
    const lista = await versionesDelBrief(admin, caso.campaignId);
    if (!lista.ok) throw new Error('lectura falló');
    expect(lista.value.map((v) => v.version)).toEqual([2, 1]);
  });

  it('la hija es independiente: editar su ES deja SU EN stale sin tocar la del padre', async () => {
    const caso = await nuevoCaso('hija-independiente');
    await traducirTodo(caso);
    await aprobarBrief(director, caso.versionId);
    const hija = await crearVersionHija(admin, caso.versionId);
    if (!hija.ok) throw new Error(hija.error.message);

    const [campoHija] = await query<{ id: string; revision: number }>(
      `SELECT id, revision FROM brief_fields WHERE brief_version_id = $1 AND key = $2`,
      [hija.value.versionId, caso.campos[0]!.key],
    );
    const edicion = await corregirCampo(admin, hija.value.versionId, campoHija!.id, {
      value: 'Nuevo texto de la versión 2',
      revisionEsperada: campoHija!.revision,
    });
    expect(edicion.ok, !edicion.ok ? edicion.error.message : '').toBe(true);

    const hijaLogica = await obtenerVersionLogica(admin, hija.value.versionId);
    const padreLogico = await obtenerVersionLogica(admin, caso.versionId);
    expect(hijaLogica.ok && hijaLogica.value.representations.en?.sync).toBe('stale');
    expect(padreLogico.ok && padreLogico.value.representations.en?.sync).toBe('current');
  });

  it('una traducción sin verificar no se «blanquea» al copiarla a la hija', async () => {
    const caso = await nuevoCaso('hija-sin-verificar');
    // EN con traducciones sin huella (como las históricas) en una versión ya aprobada.
    await conBypass(async (q) => {
      const [es] = await q(
        `SELECT id FROM brief_version_representations WHERE brief_version_id = $1 AND language = 'es'`,
        [caso.versionId],
      );
      const [en] = await q(
        `INSERT INTO brief_version_representations (brief_version_id, language, kind, source_representation_id, created_by)
         VALUES ($1, 'en', 'translation', $2, $3) RETURNING id`,
        [caso.versionId, es.id, admin.id],
      );
      for (const c of caso.campos) {
        await q(
          `INSERT INTO brief_field_translations (brief_field_id, representation_id, value, translator)
           VALUES ($1, $2, '"hist"'::jsonb, 'legacy')`,
          [c.id, en.id],
        );
      }
      await q(`UPDATE brief_versions SET status = 'approved', approved_at = now() WHERE id = $1`, [
        caso.versionId,
      ]);
    });
    const hija = await crearVersionHija(admin, caso.versionId);
    if (!hija.ok) throw new Error(hija.error.message);
    const l = await obtenerVersionLogica(admin, hija.value.versionId);
    expect(l.ok && l.value.representations.en?.sync).toBe('unverified');
  });
});

// ─────────────────────────── Provenance y evidencia ────────────────────────────

describe('provenance', () => {
  it('la representación traducida conserva la evidencia ORIGINAL del campo y su origen', async () => {
    const caso = await nuevoCaso('provenance');
    const campo = caso.campos[0]!;
    const [fuente] = await query<{ id: string }>(
      `INSERT INTO source_documents (campaign_id, organization_id, type, filename, file_id, mime_type, size_bytes, hash, status, created_by, visibility)
       VALUES ($1, $2, 'otro', 'fuente.md', 'test/fuente.md', 'text/markdown', 10, $3, 'procesado', $4, 'tcl') RETURNING id`,
      [caso.campaignId, admin.organizationId, `hash-prov-${Date.now()}`, admin.id],
    );
    await query(
      `INSERT INTO evidence (brief_field_id, source_id, quote, relation, page) VALUES ($1, $2, 'Cita original', 'soporta', 1)`,
      [campo.id, fuente!.id],
    );
    await traducirTodo(caso);

    const en = await obtenerRepresentacion(consultor, caso.versionId, 'en');
    if (!en.ok) throw new Error(en.error.message);
    const f = en.value.fields.find((x) => x.key === campo.key)!;
    expect(f).toMatchObject({
      provenanceType: 'manual_local',
      sourceLanguage: 'es',
      translator: 'human',
      sync: 'current',
    });
    expect(f.evidencias).toEqual([
      { quote: 'Cita original', filename: 'fuente.md', page: 1, slide: null, section: null },
    ]);
    // El valor original conserva su propia procedencia.
    const es = await obtenerRepresentacion(consultor, caso.versionId, 'es');
    if (!es.ok) throw new Error(es.error.message);
    expect(es.value.fields.find((x) => x.key === campo.key)).toMatchObject({
      provenanceType: 'manual_local',
      sync: 'original',
    });
  });
});

// ─────────────────────────── Legacy a nivel de lectura ─────────────────────────

describe('lectura de datos legacy', () => {
  it('una versión histórica solo ES sigue leyéndose con su representación original', async () => {
    const caso = await nuevoCaso('legacy-es');
    const l = await obtenerVersionLogica(consultor, caso.versionId);
    if (!l.ok) throw new Error('lectura falló');
    expect(Object.keys(l.value.representations)).toEqual(['es']);
    expect(l.value.legacyLanguageLinks).toEqual([]);
  });

  it('un EN histórico con el mismo estado se lee como representación importada, sin verificar y NO aprobable hasta retraducir', async () => {
    const caso = await nuevoCaso('legacy-folded');
    await conBypass(async (q) => {
      const [e] = await q(
        `INSERT INTO brief_versions (brief_id, organization_id, version, language, translation_of_id, status, created_by)
         VALUES ($1, $2, 1, 'en', $3, 'internal_review', $4) RETURNING id`,
        [caso.briefId, admin.organizationId, caso.versionId, admin.id],
      );
      await q(
        `INSERT INTO brief_fields (brief_version_id, key, value, status, provenance_type, criticidad, review_status)
         VALUES ($1, $2, '"Legacy text"'::jsonb, 'found', 'translated', 'informativo', 'pending')`,
        [e.id, caso.campos[0]!.key],
      );
      await q(`SELECT * FROM brief_legacy_en_fold()`);
    });

    const l = await obtenerVersionLogica(consultor, caso.versionId);
    if (!l.ok) throw new Error('lectura falló');
    expect(l.value.representations.en).toMatchObject({ kind: 'legacy_import', sync: 'unverified' });
    expect(l.value.legacyLanguageLinks.map((x) => x.classification)).toEqual(['folded']);
    // El cliente no ve el detalle de sincronización ni las inconsistencias históricas.
    const comoCliente = await obtenerVersionLogica(cliente, caso.versionId).catch(() => undefined);
    expect(
      comoCliente === undefined || !comoCliente.ok || comoCliente.value.legacyLanguageLinks.length === 0,
    ).toBe(true);

    const r = await aprobarBrief(director, caso.versionId);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('TRANSLATION_STALE');

    // La historia (la fila EN) no aparece como versión lógica separada.
    const lista = await versionesDelBrief(consultor, caso.campaignId);
    if (!lista.ok) throw new Error('lectura falló');
    expect(lista.value).toHaveLength(1);
  });

  it('estados históricos en conflicto quedan marcados y NO se reconcilian: ES sigue su curso, EN intacto', async () => {
    const caso = await nuevoCaso('legacy-conflicto');
    let enId = '';
    await conBypass(async (q) => {
      const [e] = await q(
        `INSERT INTO brief_versions (brief_id, organization_id, version, language, translation_of_id, status, created_by)
         VALUES ($1, $2, 1, 'en', $3, 'draft', $4) RETURNING id`,
        [caso.briefId, admin.organizationId, caso.versionId, admin.id],
      );
      enId = e.id;
      await q(`SELECT * FROM brief_legacy_en_fold()`);
    });
    const l = await obtenerVersionLogica(consultor, caso.versionId);
    if (!l.ok) throw new Error('lectura falló');
    expect(l.value.legacyLanguageLinks).toHaveLength(1);
    expect(l.value.legacyLanguageLinks[0]).toMatchObject({ classification: 'conflict', enVersionId: enId });
    expect(l.value.representations.en).toBeUndefined();
    expect((await estado(enId)).status).toBe('draft');
    expect((await estado(caso.versionId)).status).toBe('internal_review');
  });
});

// ─────────────────────────── Workspace ─────────────────────────────────────────

describe('workspace (adaptador de lectura)', () => {
  it('expone las representaciones de la versión sin cambiar sus rutas ni su estado', async () => {
    const caso = await nuevoCaso('workspace');
    await traducirTodo(caso);
    const w = await obtenerBriefWorkspace(consultor, caso.campaignId);
    if (!w.ok) throw new Error(w.error.message);
    expect(w.value.version?.status).toBe('internal_review');
    expect(w.value.version?.language).toBe('es');
    expect(w.value.version?.representations.map((r) => [r.language, r.sync]).sort()).toEqual([
      ['en', 'current'],
      ['es', 'original'],
    ]);
  });
});
