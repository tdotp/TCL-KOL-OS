/**
 * QA ADVERSARIAL F7 (subagente F) — vector G: el bypass de pruebas (`tclkolos.permitir_borrado_historico`) NO existe
 * en bases cuyo nombre no termina en `_test`, para TODAS las tablas nuevas de las migraciones 023 y 024.
 *
 * La prueba crea un clon de la base de pruebas con un nombre que NO termina en `_test` (`…_prod`), activa el GUC de
 * bypass en la sesión e intenta borrar y reescribir la historia. Todo debe rechazarse. Al terminar borra el clon.
 * Control positivo: en la base `_test` el mismo GUC sí habilita la limpieza (por eso existe).
 */

import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePool, getPool } from './client.ts';
import {
  type EscenarioDeAprobacion,
  aprobarDirecto,
  crearEscenarioDeAprobacion,
  revisarConIA,
  valor,
  versionRevisada,
} from './script-approval-test-support.ts';
import { crearComentarioDeRevision } from './script-review.ts';
import { limpiarEscenarioDeContenido } from './test-utils.ts';

const URL_DE_PRUEBAS = process.env['TEST_DATABASE_URL']!;
const NOMBRE_ORIGEN = new URL(URL_DE_PRUEBAS).pathname.replace(/^\//, '');
const NOMBRE_CLON = `${NOMBRE_ORIGEN.replace(/_test$/, '')}_clon_prod`;
const urlDe = (base: string, origen: string = URL_DE_PRUEBAS): string => {
  const u = new URL(origen);
  u.pathname = `/${base}`;
  return u.toString();
};
// Crear/borrar la base clon exige el administrador de pruebas (el rol de ejecución no tiene CREATEDB); las consultas
// sobre el clon siguen yendo con el rol de ejecución, que es lo que se prueba.
const URL_ADMIN = process.env['TEST_ADMIN_DATABASE_URL'] ?? URL_DE_PRUEBAS;

let a: EscenarioDeAprobacion;
let ids: { aprobada: string; entregable: string; comentario: string; revision: string; hallazgo: string };
let clon: Client | undefined;

async function conAdmin<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  const c = new Client({ connectionString: urlDe('postgres', URL_ADMIN) });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

beforeAll(async () => {
  expect(NOMBRE_ORIGEN.endsWith('_test')).toBe(true);
  expect(NOMBRE_CLON.endsWith('_test')).toBe(false);
  a = await crearEscenarioDeAprobacion('QA-F7 bypass');
  const { versionId, deliverableId } = await versionRevisada(a.e);
  await revisarConIA(a.e, versionId, [
    { category: 'cta_missing', refs: ['accion_kpis.accion_esperada'] },
    { category: 'restriction_violated', refs: ['practico.restricciones'], quotes: [{ fragment: 'F1' }] },
  ]);
  const c = valor(
    await crearComentarioDeRevision(a.e.consultor, versionId, {
      kind: 'editorial',
      body: 'nota previa a la aprobación',
    }),
  );
  valor(await aprobarDirecto(a.e.director, versionId));
  const pool = getPool();
  const { rows: rev } = await pool.query<{ id: string }>(
    `SELECT id FROM content_analysis_runs WHERE script_version_id = $1 ORDER BY created_at LIMIT 1`,
    [versionId],
  );
  const { rows: hal } = await pool.query<{ id: string }>(
    `SELECT f.id FROM content_findings f
        WHERE f.script_version_id = $1
          AND EXISTS (SELECT 1 FROM content_finding_script_refs r WHERE r.finding_id = f.id) LIMIT 1`,
    [versionId],
  );
  ids = {
    aprobada: versionId,
    entregable: deliverableId,
    comentario: c.comment.id,
    revision: rev[0]!.id,
    hallazgo: hal[0]?.id ?? '00000000-0000-0000-0000-000000000000',
  };
  // Clon SIN conexiones abiertas a la base de origen (CREATE DATABASE … TEMPLATE lo exige).
  await closePool();
  await conAdmin(async (admin) => {
    await admin.query(`DROP DATABASE IF EXISTS ${NOMBRE_CLON} WITH (FORCE)`);
    for (let intento = 0; ; intento += 1) {
      try {
        await admin.query(`CREATE DATABASE ${NOMBRE_CLON} TEMPLATE ${NOMBRE_ORIGEN}`);
        break;
      } catch (error) {
        if (intento >= 20) throw error;
        await new Promise((r) => setTimeout(r, 500));
      }
    }
  });
  clon = new Client({ connectionString: urlDe(NOMBRE_CLON) });
  await clon.connect();
});

afterAll(async () => {
  if (clon !== undefined) await clon.end().catch(() => undefined);
  await conAdmin((admin) => admin.query(`DROP DATABASE IF EXISTS ${NOMBRE_CLON} WITH (FORCE)`));
  await limpiarEscenarioDeContenido(a.e);
  await closePool();
});

async function rechazo(sql: string, params: unknown[] = []): Promise<string | undefined> {
  try {
    await clon!.query(sql, params);
    return undefined;
  } catch (error) {
    return (error as Error).message;
  }
}

describe('QA-F7-G · el bypass de borrado histórico solo existe en bases `_test`', () => {
  it('RESISTE: en un clon que no termina en `_test`, el GUC activado NO habilita el bypass', async () => {
    await clon!.query(`SET tclkolos.permitir_borrado_historico = 'on'`);
    const { rows } = await clon!.query<{ activo: boolean; nombre: string }>(
      `SELECT inmutabilidad_bypass_activo() AS activo, current_database() AS nombre`,
    );
    expect(rows[0]!.nombre).toBe(NOMBRE_CLON);
    expect(rows[0]!.activo).toBe(false);
  });

  it('RESISTE: con el GUC activo siguen rechazados el DELETE y el UPDATE de la historia (023 y 024)', async () => {
    await clon!.query(`SET tclkolos.permitir_borrado_historico = 'on'`);
    const intentos: Array<[string, string, unknown[]]> = [
      ['DELETE script_versions', `DELETE FROM script_versions WHERE id = $1`, [ids.aprobada]],
      ['DELETE deliverables', `DELETE FROM deliverables WHERE id = $1`, [ids.entregable]],
      ['DELETE comentario', `DELETE FROM script_review_comments WHERE id = $1`, [ids.comentario]],
      [
        'UPDATE comentario',
        `UPDATE script_review_comments SET body = 'reescrito' WHERE id = $1`,
        [ids.comentario],
      ],
      ['DELETE revisión', `DELETE FROM content_analysis_runs WHERE id = $1`, [ids.revision]],
      [
        'UPDATE revisión terminada',
        `UPDATE content_analysis_runs SET finding_count = 99 WHERE id = $1`,
        [ids.revision],
      ],
      ['DELETE hallazgo', `DELETE FROM content_findings WHERE id = $1`, [ids.hallazgo]],
      [
        'UPDATE hallazgo',
        `UPDATE content_findings SET severity = 'baja', description = 'reescrito' WHERE id = $1`,
        [ids.hallazgo],
      ],
      [
        'DELETE refs al Brief',
        `DELETE FROM content_finding_brief_refs WHERE finding_id = $1`,
        [ids.hallazgo],
      ],
      [
        'DELETE refs al guion',
        `DELETE FROM content_finding_script_refs WHERE finding_id = $1`,
        [ids.hallazgo],
      ],
      [
        'UPDATE aprobada: estado',
        `UPDATE script_versions SET status = 'in_review' WHERE id = $1`,
        [ids.aprobada],
      ],
      [
        'UPDATE aprobada: hash',
        `UPDATE script_versions SET source_hash = repeat('f', 64) WHERE id = $1`,
        [ids.aprobada],
      ],
      [
        'UPDATE aprobada: snapshot',
        `UPDATE script_versions SET approval_snapshot = '{}'::jsonb WHERE id = $1`,
        [ids.aprobada],
      ],
      ['TRUNCATE sin CASCADE (lo frena la FK)', `TRUNCATE script_versions`, []],
    ];
    for (const [nombre, sql, params] of intentos) {
      expect(await rechazo(sql, params), nombre).toBeDefined();
    }
    const { rows } = await clon!.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM script_versions WHERE id = $1`,
      [ids.aprobada],
    );
    expect(rows[0]!.n).toBe('1');
  });

  // QA-F7-G1 (hallazgo menor): `TRUNCATE` ni siquiera pasa por los triggers de fila (no hay trigger BEFORE TRUNCATE):
  // lo frena solo la FK (sin CASCADE explícito). Con CASCADE y el permiso del propietario, la historia se vacía.
  it('QA-F7-G1 (P3, corregido): ni siquiera el propietario puede vaciar la historia con TRUNCATE … CASCADE', async () => {
    const m = await rechazo(
      `TRUNCATE script_review_comments, content_finding_script_refs, content_finding_brief_refs, content_findings, content_analysis_runs, script_versions, deliverables CASCADE`,
    );
    expect(m).toBeDefined();
  });

  it('CONTROL: en la base `_test` el mismo GUC sí habilita la limpieza (por eso existe y por eso solo se permite allí)', async () => {
    const c = new Client({ connectionString: URL_DE_PRUEBAS });
    await c.connect();
    try {
      await c.query('BEGIN');
      await c.query(`SET LOCAL tclkolos.permitir_borrado_historico = 'on'`);
      const { rows } = await c.query<{ activo: boolean }>(`SELECT inmutabilidad_bypass_activo() AS activo`);
      expect(rows[0]!.activo).toBe(true);
      await c.query('ROLLBACK');
    } finally {
      await c.end();
    }
  });
});
