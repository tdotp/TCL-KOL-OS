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
let productoId: string;
let campaignProductId: string;
let productoDeOtraCampanaId: string;

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
  // Usuario y organización del seed (determinístico, no acumulado — igual
  // que `isolation.test.ts`). La evidencia necesita un `source_id` real,
  // pero ya no depende de que alguna campaña tenga una fuente cargada: se
  // siembra la propia dentro de `campanaDePrueba` más abajo.
  const [admin] = await query<{ org_id: string; user_id: string }>(
    `SELECT organization_id AS org_id, id AS user_id FROM users WHERE email = 'gerardo@smartpr.co'`,
  );
  if (!admin) {
    throw new Error('Falta el seed: corra npm run seed antes de estas pruebas.');
  }

  orgId = admin.org_id;
  userId = admin.user_id;

  const campana = await query<{ id: string }>(
    `INSERT INTO campaigns (organization_id, name, owner_id, created_by)
     VALUES ($1, $2, $3, $3) RETURNING id`,
    [orgId, `Reglas del brief · corrida ${Date.now()}`, userId],
  );
  campanaDePrueba = campana[0]!.id;

  // Fuente sintética propia — esta suite prueba reglas de base sobre
  // `evidence`/`brief_fields`, no el parseo de documentos reales.
  const [fuente] = await query<{ id: string }>(
    `INSERT INTO source_documents
       (campaign_id, organization_id, type, filename, file_id, mime_type, size_bytes, hash, status, created_by)
     VALUES ($1, $2, 'ficha_tecnica', 'fuente-de-prueba.md', 'prueba/fuente-de-prueba.md', 'text/markdown', 100,
             $3, 'procesado', $4)
     RETURNING id`,
    [campanaDePrueba, orgId, `hash-brief-rules-${campanaDePrueba}`, userId],
  );
  sourceId = fuente!.id;

  const brief = await query<{ id: string }>(`INSERT INTO briefs (campaign_id) VALUES ($1) RETURNING id`, [
    campanaDePrueba,
  ]);
  briefDePrueba = brief[0]!.id;

  // Producto real de campaña propia (migración 005: anclaje verificable).
  const [producto] = await query<{ id: string }>(`SELECT id FROM products LIMIT 1`);
  productoId = producto!.id;
  await query(
    `INSERT INTO campaign_products (campaign_id, product_id, rol, prioridad)
     VALUES ($1, $2, 'unico', 1)`,
    [campanaDePrueba, productoId],
  );
  const [asociacion] = await query<{ id: string }>(
    `SELECT id FROM campaign_products WHERE campaign_id = $1`,
    [campanaDePrueba],
  );
  campaignProductId = asociacion!.id;

  // Un `campaign_products.id` de OTRA campaña, para probar el rechazo cruzado.
  const [otra] = await query<{ id: string }>(
    `SELECT id FROM campaign_products WHERE campaign_id <> $1 LIMIT 1`,
    [campanaDePrueba],
  );
  productoDeOtraCampanaId = otra!.id;
});

afterAll(async () => {
  if (campanaDePrueba) {
    // `evidence.source_id` es `ON DELETE RESTRICT` — borrar `campaigns`
    // directamente puede intentar borrar `source_documents` antes de que la
    // cascada por el otro camino (brief_versions → brief_fields → evidence)
    // termine de vaciar `evidence`, y el RESTRICT lo rechaza. Se borran
    // primero las versiones (arrastran campos y evidencias en cascada), y
    // solo entonces la campaña — mismo ajuste que ya usa `end-to-end.test.ts`.
    await query(
      `DELETE FROM brief_versions WHERE brief_id = (SELECT id FROM briefs WHERE campaign_id = $1)`,
      [campanaDePrueba],
    );
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

      await client.query(`UPDATE brief_versions SET status = 'approved', approved_at = now() WHERE id = $1`, [
        versionId,
      ]);
      return versionId;
    });

    const [fila] = await query<{ status: string }>(`SELECT status FROM brief_versions WHERE id = $1`, [
      versionId,
    ]);
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
      await client.query(`UPDATE brief_versions SET status = 'approved', approved_at = now() WHERE id = $1`, [
        versionId,
      ]);
      return versionId;
    });

    const [fila] = await query<{ status: string }>(`SELECT status FROM brief_versions WHERE id = $1`, [
      versionId,
    ]);
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
      await client.query(`UPDATE brief_versions SET status = 'approved', approved_at = now() WHERE id = $1`, [
        versionId,
      ]);
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

// ──────────── Migración 005 · Anclaje de producto verificable (DEC-023) ───────

describe('anclaje de producto en brief_fields (prueba 11, 12, 20)', () => {
  it('permite una fila por producto para la misma clave (campo de nivel producto)', async () => {
    const filas = await desechable(async (client, { versionId }) => {
      await client.query(
        `INSERT INTO brief_fields (brief_version_id, key, value, status, provenance_type, campaign_product_id)
         VALUES ($1, 'marca_producto[].rtbs', '["144Hz"]'::jsonb, 'found', 'extracted', $2)`,
        [versionId, campaignProductId],
      );
      const r = await client.query(`SELECT count(*) AS n FROM brief_fields WHERE brief_version_id = $1`, [
        versionId,
      ]);
      return Number(r.rows[0].n);
    });
    expect(filas).toBe(1);
  });

  it('rechaza dos filas de campaña (campaign_product_id NULL) con la misma clave', async () => {
    await expect(
      desechable(async (client, { versionId }) => {
        await client.query(
          `INSERT INTO brief_fields (brief_version_id, key, status, provenance_type)
           VALUES ($1, 'objetivo.tipo', 'not_found', 'extracted')`,
          [versionId],
        );
        await client.query(
          `INSERT INTO brief_fields (brief_version_id, key, status, provenance_type)
           VALUES ($1, 'objetivo.tipo', 'not_found', 'extracted')`,
          [versionId],
        );
      }),
    ).rejects.toThrow(/brief_fields_unica_campana/);
  });

  it('un producto de OTRA campaña se rechaza al persistir el campo (prueba 12)', async () => {
    await expect(
      desechable(async (client, { versionId }) => {
        await client.query(
          `INSERT INTO brief_fields (brief_version_id, key, value, status, provenance_type, campaign_product_id)
           VALUES ($1, 'marca_producto[].rtbs', '["x"]'::jsonb, 'found', 'extracted', $2)`,
          [versionId, productoDeOtraCampanaId],
        );
      }),
    ).rejects.toThrow(/no pertenece a la campaña/);
  });

  it('un producto de la propia campaña se acepta (prueba 11, caso positivo)', async () => {
    const filas = await desechable(async (client, { versionId }) => {
      const r = await client.query(
        `INSERT INTO brief_fields (brief_version_id, key, value, status, provenance_type, campaign_product_id)
         VALUES ($1, 'marca_producto[].rtbs', '["x"]'::jsonb, 'found', 'extracted', $2) RETURNING id`,
        [versionId, campaignProductId],
      );
      return r.rowCount;
    });
    expect(filas).toBe(1);
  });
});

describe('preguntas locales por producto (migración 005, pruebas 4, 5, 12)', () => {
  it('un producto de otra campaña se rechaza al crear una pregunta local', async () => {
    await expect(
      desechable(async (client, { versionId }) => {
        await client.query(
          `INSERT INTO local_questions (campaign_id, brief_version_id, key, question, reason, campaign_product_id)
           VALUES ($1, $2, 'marca_producto[].rtbs', '¿RTBs?', 'Campo de producto vacío', $3)`,
          [campanaDePrueba, versionId, productoDeOtraCampanaId],
        );
      }),
    ).rejects.toThrow(/no pertenece a la campaña/);
  });

  it('una pregunta compartida (campaign_product_id NULL) no se puede duplicar para la misma versión', async () => {
    await expect(
      desechable(async (client, { versionId }) => {
        await client.query(
          `INSERT INTO local_questions (campaign_id, brief_version_id, key, question, reason)
           VALUES ($1, $2, 'target_audiencia.descripcion', '¿Audiencia?', 'Campo vacío')`,
          [campanaDePrueba, versionId],
        );
        await client.query(
          `INSERT INTO local_questions (campaign_id, brief_version_id, key, question, reason)
           VALUES ($1, $2, 'target_audiencia.descripcion', '¿Audiencia?', 'Campo vacío')`,
          [campanaDePrueba, versionId],
        );
      }),
    ).rejects.toThrow(/local_questions_unica_campana/);
  });

  it('una pregunta específica sí puede repetirse por producto distinto', async () => {
    const filas = await desechable(async (client, { versionId }) => {
      await client.query(
        `INSERT INTO local_questions (campaign_id, brief_version_id, key, question, reason, campaign_product_id)
         VALUES ($1, $2, 'marca_producto[].rtbs', '¿RTBs?', 'Campo vacío', $3)`,
        [campanaDePrueba, versionId, campaignProductId],
      );
      const r = await client.query(`SELECT count(*) AS n FROM local_questions WHERE brief_version_id = $1`, [
        versionId,
      ]);
      return Number(r.rows[0].n);
    });
    expect(filas).toBe(1);
  });
});

// ──────────── Migración 005 · Revisión persistida y control optimista ────────

describe('revisión de campos (corrección 2 y 7 del cierre de Sprint 4)', () => {
  it('un campo nuevo nace con review_status pending y revision 1', async () => {
    const fila = await desechable(async (client, { versionId }) => {
      const r = await client.query<{ review_status: string; revision: number }>(
        `INSERT INTO brief_fields (brief_version_id, key, value, status, provenance_type)
         VALUES ($1, 'objetivo.tipo', '"awareness"'::jsonb, 'found', 'extracted')
         RETURNING review_status, revision`,
        [versionId],
      );
      return r.rows[0]!;
    });
    expect(fila.review_status).toBe('pending');
    expect(fila.revision).toBe(1);
  });

  it('un UPDATE real incrementa revision y actualiza updated_at', async () => {
    const { antes, despues } = await desechable(async (client, { versionId }) => {
      const ins = await client.query<{ id: string; revision: number; updated_at: string }>(
        `INSERT INTO brief_fields (brief_version_id, key, value, status, provenance_type)
         VALUES ($1, 'objetivo.tipo', '"awareness"'::jsonb, 'found', 'extracted')
         RETURNING id, revision, updated_at`,
        [versionId],
      );
      const antes = ins.rows[0]!;
      const upd = await client.query<{ revision: number; updated_at: string }>(
        `UPDATE brief_fields SET review_status = 'confirmed' WHERE id = $1 RETURNING revision, updated_at`,
        [antes.id],
      );
      return { antes, despues: upd.rows[0]! };
    });
    expect(despues.revision).toBe(antes.revision + 1);
    expect(new Date(despues.updated_at).getTime()).toBeGreaterThanOrEqual(
      new Date(antes.updated_at).getTime(),
    );
  });

  it('review_status solo admite los tres valores del ciclo de revisión', async () => {
    await expect(
      desechable(async (client, { versionId }) => {
        await client.query(
          `INSERT INTO brief_fields (brief_version_id, key, status, provenance_type, review_status)
           VALUES ($1, 'objetivo.tipo', 'not_found', 'extracted', 'inventado')`,
          [versionId],
        );
      }),
    ).rejects.toThrow(/brief_fields_review_status_valido/);
  });
});

describe('brief_field_revisions es de solo inserción (corrección 5 del cierre de Sprint 4)', () => {
  it('registra el historial de un cambio de campo', async () => {
    const filas = await desechable(async (client, { versionId }) => {
      const campo = await client.query<{ id: string }>(
        `INSERT INTO brief_fields (brief_version_id, key, value, status, provenance_type)
         VALUES ($1, 'objetivo.tipo', '"awareness"'::jsonb, 'found', 'extracted') RETURNING id`,
        [versionId],
      );
      const r = await client.query(
        `INSERT INTO brief_field_revisions
           (brief_field_id, brief_version_id, accion, valor_anterior, valor_nuevo, actor_id)
         VALUES ($1, $2, 'correct', '"awareness"'::jsonb, '"conversion"'::jsonb, $3) RETURNING id`,
        [campo.rows[0]!.id, versionId, userId],
      );
      return r.rowCount;
    });
    expect(filas).toBe(1);
  });

  it('no admite UPDATE sobre una revisión ya escrita (DELETE sí, solo en cascada al borrar la campaña dueña)', async () => {
    const revisionId = await desechable(async (client, { versionId }) => {
      const campo = await client.query<{ id: string }>(
        `INSERT INTO brief_fields (brief_version_id, key, value, status, provenance_type)
         VALUES ($1, 'objetivo.tipo', '"awareness"'::jsonb, 'found', 'extracted') RETURNING id`,
        [versionId],
      );
      const r = await client.query<{ id: string }>(
        `INSERT INTO brief_field_revisions (brief_field_id, brief_version_id, accion, actor_id)
         VALUES ($1, $2, 'confirm', $3) RETURNING id`,
        [campo.rows[0]!.id, versionId, userId],
      );
      return r.rows[0]!.id;
    });
    // La fila ya no existe fuera de la transacción desechada — se prueba la regla
    // sobre una fila real e íntegra, dentro de su propia transacción de prueba.
    await expect(
      desechable(async (client, { versionId }) => {
        const campo = await client.query<{ id: string }>(
          `INSERT INTO brief_fields (brief_version_id, key, value, status, provenance_type)
           VALUES ($1, 'objetivo.tipo', '"awareness"'::jsonb, 'found', 'extracted') RETURNING id`,
          [versionId],
        );
        const r = await client.query<{ id: string }>(
          `INSERT INTO brief_field_revisions (brief_field_id, brief_version_id, accion, actor_id)
           VALUES ($1, $2, 'confirm', $3) RETURNING id`,
          [campo.rows[0]!.id, versionId, userId],
        );
        await client.query(`UPDATE brief_field_revisions SET motivo = 'x' WHERE id = $1`, [r.rows[0]!.id]);
      }),
    ).rejects.toThrow(/brief_field_revisions no admite UPDATE/);
    expect(revisionId).toBeDefined();
  });
});
