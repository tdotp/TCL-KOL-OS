/**
 * Migración 004 · Las reglas anti-alucinación, verificadas en la base.
 *
 * El dominio (`packages/domain/src/brief-states.ts`) ya impide aprobar un brief
 * con claims sin respaldo. Estas pruebas verifican que **la base lo impide
 * también**, por la razón que da ADR-003: una migración, un script de carga o
 * un `psql` a mano no pasan por el dominio, y las reglas de §9.4 no pueden
 * depender de que todo el mundo entre por la puerta principal.
 *
 * Cubre los invariantes que la migración 004 declara:
 *   §9.4  `not_found` nunca lleva valor        → nunca inventar
 *   §15   un claim exige evidencia para aprobar → umbral del 100%
 *   ADR-003 una versión aprobada es inmutable
 *
 * Requiere la base levantada:  docker compose up -d db
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { closePool, getPool, query, transaction } from './client.ts';

let orgId: string;
let userId: string;
let sourceId: string;

/**
 * Campaña y brief propios de esta corrida.
 *
 * Se crean aquí en vez de reutilizar los del seed por dos razones: una campaña
 * tiene un único brief (`Campaign ||--|| Brief`, D0-08), así que no se puede ir
 * creando uno por prueba; y varias de estas pruebas confirman versiones
 * aprobadas, que por ADR-003 ya no se pueden borrar ni editar. Trabajar sobre
 * una campaña desechable deja el seed intacto.
 */
let campanaDePrueba: string;
let briefDePrueba: string;
let siguienteVersion = 1;

beforeAll(async () => {
  const filas = await query<{
    org_id: string;
    user_id: string;
    source_id: string;
  }>(
    // Sirve cualquier campaña de SmartPR que tenga una fuente cargada: la
    // evidencia necesita un `source_id` real y no importa de cuál venga.
    `SELECT c.organization_id AS org_id,
            u.id             AS user_id,
            s.id             AS source_id
       FROM campaigns c
       JOIN users u ON u.organization_id = c.organization_id AND u.email = 'gerardo@smartpr.co'
       JOIN source_documents s ON s.campaign_id = c.id
      ORDER BY c.created_at
      LIMIT 1`,
  );

  const fila = filas[0];
  if (!fila) {
    throw new Error(
      'Falta material de partida: se esperaba al menos una campaña de SmartPR con una fuente cargada. ' +
        'Corra el seed y la carga de fuentes antes de estas pruebas.',
    );
  }

  orgId = fila.org_id;
  userId = fila.user_id;
  sourceId = fila.source_id;

  const campana = await query<{ id: string }>(
    `INSERT INTO campaigns (organization_id, name, owner_id, created_by)
     VALUES ($1, $2, $3, $3) RETURNING id`,
    [orgId, `Reglas del brief · corrida ${Date.now()}`, userId],
  );
  campanaDePrueba = campana[0]!.id;

  const brief = await query<{ id: string }>(
    `INSERT INTO briefs (campaign_id) VALUES ($1) RETURNING id`,
    [campanaDePrueba],
  );
  briefDePrueba = brief[0]!.id;
});

afterAll(async () => {
  // Borrar la campaña arrastra brief, versiones, campos y evidencias en cascada.
  if (campanaDePrueba) {
    await query(`DELETE FROM campaigns WHERE id = $1`, [campanaDePrueba]);
  }
  await closePool();
});

/**
 * Crea una versión en `draft` sobre el brief de prueba y la devuelve.
 *
 * No confirma nada: quien llama decide si la transacción termina en COMMIT o en
 * ROLLBACK, y esa diferencia importa — el trigger de claims es `DEFERRABLE
 * INITIALLY DEFERRED` y solo dispara al confirmar.
 */
async function nuevaVersion(client: pg.PoolClient): Promise<string> {
  const version = await client.query<{ id: string }>(
    `INSERT INTO brief_versions (brief_id, organization_id, version, created_by)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [briefDePrueba, orgId, siguienteVersion++, userId],
  );
  return version.rows[0]!.id;
}

/** Ejecuta contra la base y deshace siempre. Para reglas que disparan al instante. */
async function desechable<T>(fn: (client: pg.PoolClient, ctx: { versionId: string }) => Promise<T>) {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const versionId = await nuevaVersion(client);
    return await fn(client, { versionId });
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
}

// ─────────────────────── §9.4 · Nunca inventar ────────────────────────────────

describe('§9.4 · un campo no encontrado no puede llevar valor', () => {
  it('rechaza status not_found con un valor', async () => {
    await expect(
      desechable(async (client, { versionId }) => {
        await client.query(
          `INSERT INTO brief_fields (brief_version_id, key, value, status, provenance_type)
           VALUES ($1, 'objetivo.principal', '"inventado"'::jsonb, 'not_found', 'extracted')`,
          [versionId],
        );
      }),
    ).rejects.toThrow(/brief_fields_not_found_sin_valor/);
  });

  it('acepta status not_found sin valor', async () => {
    const filas = await desechable(async (client, { versionId }) => {
      const r = await client.query(
        `INSERT INTO brief_fields (brief_version_id, key, status, provenance_type)
         VALUES ($1, 'objetivo.principal', 'not_found', 'extracted') RETURNING id`,
        [versionId],
      );
      return r.rowCount;
    });
    expect(filas).toBe(1);
  });

  it('un campo capturado a mano no puede declarar confianza', async () => {
    await expect(
      desechable(async (client, { versionId }) => {
        await client.query(
          `INSERT INTO brief_fields (brief_version_id, key, value, status, provenance_type, confidence)
           VALUES ($1, 'objetivo.principal', '"x"'::jsonb, 'manual', 'manual_local', 0.9)`,
          [versionId],
        );
      }),
    ).rejects.toThrow(/brief_fields_manual_sin_confianza/);
  });
});

// ──────────────────── §15 · Todo claim con evidencia ──────────────────────────

describe('§15 · un claim sin evidencia no puede aprobarse', () => {
  it('bloquea la aprobación al confirmar la transacción', async () => {
    await expect(
      transaction(async (client) => {
        const versionId = await nuevaVersion(client);
        await client.query(
          `INSERT INTO brief_fields (brief_version_id, key, value, status, provenance_type, criticidad)
           VALUES ($1, 'mensaje_principal.claim', '"el mejor del mercado"'::jsonb,
                   'found', 'extracted', 'claim')`,
          [versionId],
        );
        await client.query(
          `UPDATE brief_versions SET status = 'approved', approved_at = now() WHERE id = $1`,
          [versionId],
        );
      }),
    ).rejects.toThrow(/claims sin evidencia/);
  });

  it('permite aprobar el mismo claim cuando sí tiene evidencia', async () => {
    const versionId = await transaction(async (client) => {
      const versionId = await nuevaVersion(client);

      const campo = await client.query<{ id: string }>(
        `INSERT INTO brief_fields (brief_version_id, key, value, status, provenance_type, criticidad)
         VALUES ($1, 'mensaje_principal.claim', '"el mejor del mercado"'::jsonb,
                 'found', 'extracted', 'claim') RETURNING id`,
        [versionId],
      );

      await client.query(
        `INSERT INTO evidence (brief_field_id, source_id, quote, section)
         VALUES ($1, $2, 'Mejor televisor del mercado según la ficha técnica', 'Especificaciones')`,
        [campo.rows[0]!.id, sourceId],
      );

      await client.query(
        `UPDATE brief_versions SET status = 'approved', approved_at = now() WHERE id = $1`,
        [versionId],
      );
      return versionId;
    });

    const [fila] = await query<{ status: string }>(
      `SELECT status FROM brief_versions WHERE id = $1`,
      [versionId],
    );
    expect(fila!.status).toBe('approved');
  });

  it('un campo informativo sin evidencia no estorba la aprobación', async () => {
    const versionId = await transaction(async (client) => {
      const versionId = await nuevaVersion(client);
      await client.query(
        `INSERT INTO brief_fields (brief_version_id, key, value, status, provenance_type, criticidad)
         VALUES ($1, 'practico.notas', '"llamar el martes"'::jsonb,
                 'found', 'manual_local', 'informativo')`,
        [versionId],
      );
      await client.query(
        `UPDATE brief_versions SET status = 'approved', approved_at = now() WHERE id = $1`,
        [versionId],
      );
      return versionId;
    });

    const [fila] = await query<{ status: string }>(
      `SELECT status FROM brief_versions WHERE id = $1`,
      [versionId],
    );
    expect(fila!.status).toBe('approved');
  });
});

// ─────────────────── ADR-003 · La versión aprobada es inmutable ───────────────

describe('ADR-003 · una versión aprobada no se modifica', () => {
  let versionAprobada: string;
  let campoAprobado: string;

  beforeAll(async () => {
    const r = await transaction(async (client) => {
      const versionId = await nuevaVersion(client);
      const campo = await client.query<{ id: string }>(
        `INSERT INTO brief_fields (brief_version_id, key, value, status, provenance_type)
         VALUES ($1, 'objetivo.principal', '"vender"'::jsonb, 'found', 'manual_local')
         RETURNING id`,
        [versionId],
      );
      await client.query(
        `UPDATE brief_versions SET status = 'approved', approved_at = now() WHERE id = $1`,
        [versionId],
      );
      return { versionId, campoId: campo.rows[0]!.id };
    });
    versionAprobada = r.versionId;
    campoAprobado = r.campoId;
  });

  it('no admite volver la versión a borrador', async () => {
    await expect(
      query(`UPDATE brief_versions SET status = 'draft' WHERE id = $1`, [versionAprobada]),
    ).rejects.toThrow();
  });

  it('no admite editar un campo de la versión aprobada', async () => {
    await expect(
      query(`UPDATE brief_fields SET value = '"otra cosa"'::jsonb WHERE id = $1`, [campoAprobado]),
    ).rejects.toThrow();
  });

  it('no admite borrar un campo de la versión aprobada', async () => {
    await expect(query(`DELETE FROM brief_fields WHERE id = $1`, [campoAprobado])).rejects.toThrow();
  });
});

// ────────────── §9.4 · Las preguntas locales no se cierran solas ──────────────

describe('preguntas locales · descartar exige justificación', () => {
  it('rechaza una pregunta descartada sin respuesta', async () => {
    await expect(
      desechable(async (client, { versionId }) => {
        await client.query(
          `INSERT INTO local_questions
             (campaign_id, brief_version_id, key, question, reason, status, answered_by)
           VALUES ($1, $2, 'practico.presupuesto', '¿Cuál es el presupuesto?',
                   'Campo obligatorio vacío', 'descartada', $3)`,
          [campanaDePrueba, versionId, userId],
        );
      }),
    ).rejects.toThrow(/local_questions_descarte_justificado/);
  });

  it('acepta el descarte cuando queda dicho por qué', async () => {
    const filas = await desechable(async (client, { versionId }) => {
      const r = await client.query(
        `INSERT INTO local_questions
           (campaign_id, brief_version_id, key, question, reason, status, answer, answered_by)
         VALUES ($1, $2, 'practico.presupuesto', '¿Cuál es el presupuesto?',
                 'Campo obligatorio vacío', 'descartada',
                 'La marca lo maneja fuera de este brief.', $3) RETURNING id`,
        [campanaDePrueba, versionId, userId],
      );
      return r.rowCount;
    });
    expect(filas).toBe(1);
  });

  it('una pregunta resuelta siempre tiene autor', async () => {
    await expect(
      desechable(async (client, { versionId }) => {
        await client.query(
          `INSERT INTO local_questions
             (campaign_id, brief_version_id, key, question, reason, status, answer)
           VALUES ($1, $2, 'practico.presupuesto', '¿Cuál es el presupuesto?',
                   'Campo obligatorio vacío', 'respondida', '30 millones')`,
          [campanaDePrueba, versionId],
        );
      }),
    ).rejects.toThrow(/local_questions_respuesta_con_autor/);
  });
});
