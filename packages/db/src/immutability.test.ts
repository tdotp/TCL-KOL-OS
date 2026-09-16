/**
 * Migración 009 · Inmutabilidad histórica, verificada en la base — no solo en TypeScript.
 *
 * Defecto de cierre real, encontrado en auditoría independiente del ZIP de
 * Sprint 5: `campos_de_version_aprobada_inmutables()` (migración 004) y
 * `comentarios_de_version_aprobada_inmutables()` (migración 007) solo
 * bloqueaban mientras la versión dueña estaba `approved`. Al crear una
 * versión hija (Fase E), la versión padre pasa a `superseded` — y en ese
 * momento la protección desaparecía por completo: nada en la base impedía
 * un `UPDATE`/`INSERT`/`DELETE` directo. `evidence`, `local_questions` y
 * `brief_field_revisions` nunca tuvieron ninguna protección propia, ni
 * siquiera para `approved`.
 *
 * Esta suite ataca la base directamente con SQL crudo — nunca pasa por
 * `packages/db` para las mutaciones bajo prueba — exactamente el caso que
 * ADR-003 exige cubrir: "una migración, un script de carga o un `psql` a
 * mano no pasan por el dominio". Cada bloque de pruebas se repite dos
 * veces sobre la MISMA fila: una vez con la versión en `approved`, otra
 * después de convertirla en `superseded` (el estado que antes de la
 * migración 009 quedaba sin protección).
 *
 * Requiere la base levantada: docker compose up -d db
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePool, query, transaction } from './client.ts';
import { eliminarCampanaDePrueba } from './test-utils.ts';

let orgId: string;
let userId: string;
let campanaId: string;
let briefId: string;
let sourceId: string;
let versionId: string;
let campoId: string;
let evidenciaId: string;
let comentarioId: string;
let preguntaId: string;
let revisionId: string;

/** El mismo campo/evidencia/comentario/pregunta/revisión se usa en las dos rondas (approved y superseded). */
beforeAll(async () => {
  const [admin] = await query<{ org_id: string; user_id: string }>(
    `SELECT organization_id AS org_id, id AS user_id FROM users WHERE email = 'gerardo@smartpr.co'`,
  );
  if (!admin) throw new Error('Falta el seed: corra npm run seed antes de estas pruebas.');
  orgId = admin.org_id;
  userId = admin.user_id;

  const [campana] = await query<{ id: string }>(
    `INSERT INTO campaigns (organization_id, name, owner_id, created_by)
     VALUES ($1, $2, $3, $3) RETURNING id`,
    [orgId, `Inmutabilidad histórica · corrida ${Date.now()}`, userId],
  );
  campanaId = campana!.id;

  const [brief] = await query<{ id: string }>(`INSERT INTO briefs (campaign_id) VALUES ($1) RETURNING id`, [
    campanaId,
  ]);
  briefId = brief!.id;

  const [fuente] = await query<{ id: string }>(
    `INSERT INTO source_documents
       (campaign_id, organization_id, type, filename, file_id, mime_type, size_bytes, hash, status, created_by)
     VALUES ($1, $2, 'ficha_tecnica', 'fuente-inmutabilidad.md', 'prueba/fuente-inmutabilidad.md',
             'text/markdown', 100, $3, 'procesado', $4)
     RETURNING id`,
    [campanaId, orgId, `hash-inmutabilidad-${campanaId}`, userId],
  );
  sourceId = fuente!.id;

  const [version] = await query<{ id: string }>(
    `INSERT INTO brief_versions (brief_id, organization_id, version, status, created_by)
     VALUES ($1, $2, 1, 'draft', $3) RETURNING id`,
    [briefId, orgId, userId],
  );
  versionId = version!.id;

  const [campo] = await query<{ id: string }>(
    `INSERT INTO brief_fields (brief_version_id, key, value, status, provenance_type, criticidad)
     VALUES ($1, 'contexto.situacion', '"Valor original, nunca debe cambiar."'::jsonb,
             'found', 'extracted', 'critico')
     RETURNING id`,
    [versionId],
  );
  campoId = campo!.id;

  const [evidencia] = await query<{ id: string }>(
    `INSERT INTO evidence (brief_field_id, source_id, quote, section)
     VALUES ($1, $2, 'Cita literal original.', 'Sección de prueba')
     RETURNING id`,
    [campoId, sourceId],
  );
  evidenciaId = evidencia!.id;

  const [comentario] = await query<{ id: string }>(
    `INSERT INTO field_comments (organization_id, brief_version_id, field_key, author_id, content)
     VALUES ($1, $2, 'contexto.situacion', $3, 'Comentario original, nunca debe cambiar.')
     RETURNING id`,
    [orgId, versionId, userId],
  );
  comentarioId = comentario!.id;

  const [pregunta] = await query<{ id: string }>(
    `INSERT INTO local_questions
       (campaign_id, brief_version_id, key, question, reason, status)
     VALUES ($1, $2, 'practico.fecha_inicio', '¿Cuál es la fecha?', 'No se encontró en las fuentes', 'pendiente')
     RETURNING id`,
    [campanaId, versionId],
  );
  preguntaId = pregunta!.id;

  const [revision] = await query<{ id: string }>(
    `INSERT INTO brief_field_revisions
            (brief_field_id, brief_version_id, accion, valor_anterior, valor_nuevo, actor_id)
     VALUES ($1, $2, 'confirm', '"x"'::jsonb, '"x"'::jsonb, $3)
     RETURNING id`,
    [campoId, versionId, userId],
  );
  revisionId = revision!.id;
});

afterAll(async () => {
  await eliminarCampanaDePrueba(campanaId);
  await closePool();
});

/** Cada `it` de este bloque corre dos veces: mientras `approved` y mientras `superseded`. */
function pruebasDeInmutabilidad(rotulo: string) {
  describe(`bloqueo directo por SQL — versión ${rotulo}`, () => {
    it('rechaza UPDATE sobre brief_fields', async () => {
      await expect(
        query(`UPDATE brief_fields SET value = '"hackeado"'::jsonb WHERE id = $1`, [campoId]),
      ).rejects.toThrow(/no admiten UPDATE/);
    });

    it('rechaza DELETE sobre brief_fields', async () => {
      await expect(query(`DELETE FROM brief_fields WHERE id = $1`, [campoId])).rejects.toThrow(
        /no admiten DELETE/,
      );
    });

    it('rechaza INSERT de un campo nuevo en la misma versión', async () => {
      await expect(
        query(
          `INSERT INTO brief_fields (brief_version_id, key, status, provenance_type, criticidad)
           VALUES ($1, 'hackeado.campo', 'not_found', 'manual_local', 'informativo')`,
          [versionId],
        ),
      ).rejects.toThrow(/no admiten INSERT/);
    });

    it('rechaza UPDATE sobre evidence', async () => {
      await expect(
        query(`UPDATE evidence SET quote = 'cita hackeada' WHERE id = $1`, [evidenciaId]),
      ).rejects.toThrow(/no admite UPDATE/);
    });

    it('rechaza DELETE sobre evidence', async () => {
      await expect(query(`DELETE FROM evidence WHERE id = $1`, [evidenciaId])).rejects.toThrow(
        /no admite DELETE/,
      );
    });

    it('rechaza INSERT de evidencia nueva sobre el mismo campo', async () => {
      await expect(
        query(
          `INSERT INTO evidence (brief_field_id, source_id, quote) VALUES ($1, $2, 'cita nueva hackeada')`,
          [campoId, sourceId],
        ),
      ).rejects.toThrow(/no admite INSERT/);
    });

    it('rechaza UPDATE sobre field_comments', async () => {
      await expect(
        query(`UPDATE field_comments SET content = 'hackeado' WHERE id = $1`, [comentarioId]),
      ).rejects.toThrow(/no admiten UPDATE/);
    });

    it('rechaza DELETE sobre field_comments', async () => {
      await expect(query(`DELETE FROM field_comments WHERE id = $1`, [comentarioId])).rejects.toThrow(
        /no admiten DELETE/,
      );
    });

    it('rechaza INSERT de un comentario nuevo', async () => {
      await expect(
        query(
          `INSERT INTO field_comments (organization_id, brief_version_id, field_key, author_id, content)
           VALUES ($1, $2, 'contexto.situacion', $3, 'Comentario hackeado')`,
          [orgId, versionId, userId],
        ),
      ).rejects.toThrow(/no admiten INSERT/);
    });

    it('rechaza UPDATE sobre local_questions', async () => {
      await expect(
        query(`UPDATE local_questions SET question = 'hackeada' WHERE id = $1`, [preguntaId]),
      ).rejects.toThrow(/no admiten UPDATE/);
    });

    it('rechaza DELETE sobre local_questions', async () => {
      await expect(query(`DELETE FROM local_questions WHERE id = $1`, [preguntaId])).rejects.toThrow(
        /no admiten DELETE/,
      );
    });

    it('rechaza INSERT de una pregunta nueva', async () => {
      await expect(
        query(
          `INSERT INTO local_questions (campaign_id, brief_version_id, key, question, reason)
           VALUES ($1, $2, 'objetivo.tipo', 'hackeada', 'motivo')`,
          [campanaId, versionId],
        ),
      ).rejects.toThrow(/no admiten INSERT/);
    });

    it('rechaza DELETE sobre brief_field_revisions', async () => {
      await expect(query(`DELETE FROM brief_field_revisions WHERE id = $1`, [revisionId])).rejects.toThrow(
        /no admite DELETE/,
      );
    });

    it('rechaza INSERT de una revisión nueva', async () => {
      await expect(
        query(
          `INSERT INTO brief_field_revisions (brief_field_id, brief_version_id, accion, actor_id)
           VALUES ($1, $2, 'confirm', $3)`,
          [campoId, versionId, userId],
        ),
      ).rejects.toThrow(/no admite INSERT/);
    });

    it('el valor original sigue exactamente igual (ninguna de las escrituras anteriores se coló)', async () => {
      const [fila] = await query<{ value: unknown }>(`SELECT value FROM brief_fields WHERE id = $1`, [
        campoId,
      ]);
      expect(fila!.value).toBe('Valor original, nunca debe cambiar.');
    });
  });
}

describe('mientras la versión está approved', () => {
  beforeAll(async () => {
    await query(`UPDATE brief_versions SET status = 'approved', approved_at = now() WHERE id = $1`, [
      versionId,
    ]);
  });

  pruebasDeInmutabilidad('approved');
});

describe('después de convertirla en superseded', () => {
  beforeAll(async () => {
    // Mismo `UPDATE` atómico que usa `crearVersionHija` — approved → superseded
    // sigue permitido, es la única transición que un estado terminal admite.
    const resultado = await query<{ id: string }>(
      `UPDATE brief_versions SET status = 'superseded' WHERE id = $1 AND status = 'approved' RETURNING id`,
      [versionId],
    );
    expect(resultado).toHaveLength(1);
  });

  pruebasDeInmutabilidad('superseded');

  it('un estado terminal no puede volver a ningún otro estado por SQL directo', async () => {
    await expect(
      query(`UPDATE brief_versions SET status = 'draft' WHERE id = $1`, [versionId]),
    ).rejects.toThrow(/estado terminal/);
  });

  it('cancelled tampoco puede volver a otro estado por SQL directo', async () => {
    // Verificado sobre una versión propia y desechable, no la que ya usan
    // las pruebas de arriba — cancelled es un destino distinto de superseded.
    const [otraVersion] = await query<{ id: string }>(
      `INSERT INTO brief_versions (brief_id, organization_id, version, status, created_by)
       VALUES ($1, $2, 2, 'cancelled', $3) RETURNING id`,
      [briefId, orgId, userId],
    );
    await expect(
      query(`UPDATE brief_versions SET status = 'internal_review' WHERE id = $1`, [otraVersion!.id]),
    ).rejects.toThrow(/estado terminal/);
  });
});

describe('la bandera de bypass (SET LOCAL) no se escapa de su transacción', () => {
  it('dentro de una transacción con la bandera, el UPDATE directo sí procede', async () => {
    await transaction(async (client) => {
      await client.query(`SET LOCAL tclkolos.permitir_borrado_historico = 'on'`);
      const resultado = await client.query(
        `UPDATE brief_fields SET value = '"tocado con bypass, revertido abajo"'::jsonb WHERE id = $1`,
        [campoId],
      );
      expect(resultado.rowCount).toBe(1);
      // Se revierte en la misma transacción — este bloque no debe dejar
      // rastro permanente, solo demostrar que la bandera sí surte efecto.
      await client.query(`UPDATE brief_fields SET value = $1 WHERE id = $2`, [
        JSON.stringify('Valor original, nunca debe cambiar.'),
        campoId,
      ]);
    });
  });

  it('fuera de esa transacción, ya cerrada, el bloqueo sigue activo de inmediato', async () => {
    await expect(
      query(`UPDATE brief_fields SET value = '"hackeado"'::jsonb WHERE id = $1`, [campoId]),
    ).rejects.toThrow(/no admiten UPDATE/);
  });

  it('al terminar la transacción, la bandera queda desactivada para la siguiente conexión', async () => {
    const [fila] = await query<{ activo: boolean }>(`SELECT inmutabilidad_bypass_activo() AS activo`);
    expect(fila!.activo).toBe(false);
  });
});

// ─────────────────── Sprint 5 correctivo, hallazgo 1 — bypass restringido a `_test` ──

describe('hallazgo 1 · el bypass solo puede activarse en una base "_test"', () => {
  it('la base de pruebas actual termina en "_test" (precondición de esta suite)', async () => {
    const [fila] = await query<{ base: string }>(`SELECT current_database() AS base`);
    expect(fila!.base.endsWith('_test')).toBe(true);
  });

  it('activar la bandera en la base "_test" actual sí habilita el bypass', async () => {
    await transaction(async (client) => {
      await client.query(`SET LOCAL tclkolos.permitir_borrado_historico = 'on'`);
      const resultado = await client.query<{ activo: boolean }>(
        `SELECT inmutabilidad_bypass_activo() AS activo`,
      );
      expect(resultado.rows[0]!.activo).toBe(true);
    });
  });

  it('la comprobación de nombre de base es literal: exige terminar en "_test", no solo contenerlo', async () => {
    // No hay forma de crear una base efímera no-test desde esta suite sin
    // permisos de superusuario sobre el clúster completo — se verifica
    // aquí el mismo criterio (`right(current_database(), 5) = '_test'`) que
    // usa la función, contra nombres que a propósito NO terminan en
    // "_test" aunque lo contengan.
    const [fila] = await query<{ resultado: boolean }>(`SELECT right($1::text, 5) = '_test' AS resultado`, [
      'tclkolos_test_pero_no',
    ]);
    expect(fila!.resultado).toBe(false);
  });
});

// ─────────────────── Sprint 5 correctivo, hallazgo 2 — DELETE directo de brief_versions ──

describe('hallazgo 2 · brief_versions no admite DELETE directo en un estado terminal', () => {
  let versionParaBorrar: string;

  beforeAll(async () => {
    const [version] = await query<{ id: string }>(
      `INSERT INTO brief_versions (brief_id, organization_id, version, language, status, created_by)
       VALUES ($1, $2, 3, 'es', 'draft', $3) RETURNING id`,
      [briefId, orgId, userId],
    );
    versionParaBorrar = version!.id;
  });

  it('rechaza DELETE sobre una versión approved', async () => {
    await query(`UPDATE brief_versions SET status = 'approved', approved_at = now() WHERE id = $1`, [
      versionParaBorrar,
    ]);
    await expect(query(`DELETE FROM brief_versions WHERE id = $1`, [versionParaBorrar])).rejects.toThrow(
      /no admite DELETE directo/,
    );
  });

  it('rechaza DELETE sobre esa misma versión ya superseded', async () => {
    await query(`UPDATE brief_versions SET status = 'superseded' WHERE id = $1 AND status = 'approved'`, [
      versionParaBorrar,
    ]);
    await expect(query(`DELETE FROM brief_versions WHERE id = $1`, [versionParaBorrar])).rejects.toThrow(
      /no admite DELETE directo/,
    );
  });

  it('rechaza DELETE sobre una versión cancelled', async () => {
    const [otraVersion] = await query<{ id: string }>(
      `INSERT INTO brief_versions (brief_id, organization_id, version, language, status, created_by)
       VALUES ($1, $2, 4, 'es', 'cancelled', $3) RETURNING id`,
      [briefId, orgId, userId],
    );
    await expect(query(`DELETE FROM brief_versions WHERE id = $1`, [otraVersion!.id])).rejects.toThrow(
      /no admite DELETE directo/,
    );
  });
});

// ─────────────────── Sprint 5 correctivo, hallazgo 3 — congelamiento total de la fila ──

describe('hallazgo 3 · una versión approved o superseded congela la fila completa', () => {
  let versionCongelada: string;

  beforeAll(async () => {
    const [version] = await query<{ id: string }>(
      `INSERT INTO brief_versions (brief_id, organization_id, version, language, status, created_by, approved_at)
       VALUES ($1, $2, 5, 'es', 'approved', $3, now()) RETURNING id`,
      [briefId, orgId, userId],
    );
    versionCongelada = version!.id;
  });

  describe('mientras está approved: se permite transicionar, no reescribir', () => {
    it('rechaza modificar organization_id', async () => {
      await expect(
        query(`UPDATE brief_versions SET organization_id = $1 WHERE id = $2`, [orgId, versionCongelada]),
      ).rejects.toThrow(/ningún valor puede cambiar/);
    });

    it('rechaza modificar created_by', async () => {
      await expect(
        query(`UPDATE brief_versions SET created_by = $1 WHERE id = $2`, [userId, versionCongelada]),
      ).rejects.toThrow(/ningún valor puede cambiar/);
    });

    it('rechaza modificar translation_of_id', async () => {
      await expect(
        query(`UPDATE brief_versions SET translation_of_id = $1 WHERE id = $2`, [
          versionCongelada,
          versionCongelada,
        ]),
      ).rejects.toThrow(/ningún valor puede cambiar/);
    });

    it('rechaza modificar created_at', async () => {
      await expect(
        query(`UPDATE brief_versions SET created_at = now() WHERE id = $1`, [versionCongelada]),
      ).rejects.toThrow(/ningún valor puede cambiar/);
    });

    it('rechaza modificar approved_at', async () => {
      await expect(
        query(`UPDATE brief_versions SET approved_at = now() WHERE id = $1`, [versionCongelada]),
      ).rejects.toThrow(/ningún valor puede cambiar/);
    });

    it('rechaza un UPDATE que "no cambia nada" (mismo status, sin otros valores)', async () => {
      await expect(
        query(`UPDATE brief_versions SET status = 'approved' WHERE id = $1`, [versionCongelada]),
      ).rejects.toThrow(/ningún valor puede cambiar/);
    });

    it('permite la transición approved → superseded cambiando solo status', async () => {
      const resultado = await query<{ id: string }>(
        `UPDATE brief_versions SET status = 'superseded' WHERE id = $1 AND status = 'approved' RETURNING id`,
        [versionCongelada],
      );
      expect(resultado).toHaveLength(1);
    });
  });

  describe('una vez superseded: absolutamente ningún UPDATE procede, ni siquiera sin cambios', () => {
    it('rechaza modificar organization_id', async () => {
      await expect(
        query(`UPDATE brief_versions SET organization_id = $1 WHERE id = $2`, [orgId, versionCongelada]),
      ).rejects.toThrow(/estado terminal/);
    });

    it('rechaza modificar created_by', async () => {
      await expect(
        query(`UPDATE brief_versions SET created_by = $1 WHERE id = $2`, [userId, versionCongelada]),
      ).rejects.toThrow(/estado terminal/);
    });

    it('rechaza modificar translation_of_id', async () => {
      await expect(
        query(`UPDATE brief_versions SET translation_of_id = $1 WHERE id = $2`, [
          versionCongelada,
          versionCongelada,
        ]),
      ).rejects.toThrow(/estado terminal/);
    });

    it('rechaza modificar created_at', async () => {
      await expect(
        query(`UPDATE brief_versions SET created_at = now() WHERE id = $1`, [versionCongelada]),
      ).rejects.toThrow(/estado terminal/);
    });

    it('rechaza modificar approved_at', async () => {
      await expect(
        query(`UPDATE brief_versions SET approved_at = now() WHERE id = $1`, [versionCongelada]),
      ).rejects.toThrow(/estado terminal/);
    });

    it('rechaza un UPDATE sin cambiar el estado, incluso si no cambia ningún otro valor', async () => {
      await expect(
        query(`UPDATE brief_versions SET status = 'superseded' WHERE id = $1`, [versionCongelada]),
      ).rejects.toThrow(/estado terminal/);
    });
  });
});
