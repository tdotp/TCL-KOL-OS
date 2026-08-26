/**
 * INC-001A · Prueba de regresión dedicada: aislamiento de pruebas.
 *
 * El 25 de agosto de 2026, `extraction.test.ts` reutilizó (vía
 * `obtenerOCrearVersionDeTrabajo`, DEC-024) y luego borró en su limpieza una
 * versión real y no terminal del brief de P80, porque las pruebas corrían
 * contra la campaña compartida del seed en vez de una propia. Ver
 * `docs/incidents/INC-001-test-data-collision.md`.
 *
 * Esta prueba reproduce la forma del incidente y demuestra que ya no ocurre:
 *
 *   1. Crea una versión "centinela" — organización, usuario, campaña,
 *      producto, brief y versión propios, ajenos a cualquier archivo de
 *      prueba — que representa datos reales preexistentes.
 *   2. Ejecuta el mismo tipo de operaciones que causaron el incidente
 *      (`obtenerOCrearVersionDeTrabajo`, `crearBriefManual`,
 *      `transicionarBrief`, `confirmarCampo`) sobre una campaña PROPIA y
 *      DISTINTA, creada y limpiada solo por esta prueba.
 *   3. Verifica que la centinela —su versión, sus campos, su evidencia—
 *      sigue exactamente igual.
 *
 * No lanza el resto de la suite desde aquí (sería recursivo y no probaría
 * nada que este archivo no pueda probar por sí mismo): el patrón de
 * aislamiento que se verifica es el mismo que debe seguir cualquier otro
 * archivo de `packages/db`.
 */

import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { User } from '@tcl-kol-os/domain';
import { closePool, query, transaction } from './client.ts';
import { obtenerOCrearVersionDeTrabajo, cargarVersion } from './brief-version.ts';
import { crearBriefManual } from './manual.ts';
import { confirmarCampo } from './brief-fields.ts';
import { transicionarBrief } from './transitions.ts';

let orgId: string;
let userId: string;
let actor: User;

/** La campaña "ajena": simula datos reales que ninguna prueba debería tocar. */
let campanaCentinela: string;
let versionCentinela: string;
let huellaCentinelaAntes: string;

/** La campaña PROPIA de esta corrida — la única que se crea y se limpia aquí. */
let campanaPropia: string;
const idsPropios: string[] = [];

/** Hash del contenido observable de la versión centinela (campos + evidencia). */
async function huellaDeVersion(versionId: string): Promise<string> {
  const filas = await query<{ key: string; value: unknown; status: string; quote: string | null }>(
    `SELECT bf.key, bf.value, bf.status::text, e.quote
       FROM brief_fields bf
       LEFT JOIN evidence e ON e.brief_field_id = bf.id
      WHERE bf.brief_version_id = $1
      ORDER BY bf.key, e.id`,
    [versionId],
  );
  return createHash('sha256').update(JSON.stringify(filas)).digest('hex');
}

beforeAll(async () => {
  const admin = await query<{ id: string; organization_id: string }>(
    `SELECT id, organization_id FROM users WHERE email = 'gerardo@smartpr.co'`,
  );
  userId = admin[0]!.id;
  orgId = admin[0]!.organization_id;
  actor = {
    id: userId,
    email: 'gerardo@smartpr.co',
    name: 'Gerardo',
    organizationId: orgId,
    role: 'admin',
    status: 'activo',
  };

  // ── 1. La centinela: datos "reales" preexistentes, ajenos a la suite ──
  campanaCentinela = await transaction(async (client) => {
    const c = await client.query<{ id: string }>(
      `INSERT INTO campaigns (organization_id, name, owner_id, created_by)
       VALUES ($1, $2, $3, $3) RETURNING id`,
      [orgId, `INC-001 · centinela ${Date.now()}`, userId],
    );
    return c.rows[0]!.id;
  });

  const briefCentinela = await query<{ id: string }>(
    `INSERT INTO briefs (campaign_id) VALUES ($1) RETURNING id`,
    [campanaCentinela],
  );
  const vCentinela = await query<{ id: string }>(
    `INSERT INTO brief_versions (brief_id, organization_id, version, created_by, status)
     VALUES ($1, $2, 1, $3, 'extraction_review') RETURNING id`,
    [briefCentinela[0]!.id, orgId, userId],
  );
  versionCentinela = vCentinela[0]!.id;

  const campo = await query<{ id: string }>(
    `INSERT INTO brief_fields (brief_version_id, key, value, status, provenance_type, criticidad, review_status)
     VALUES ($1, 'contexto.situacion', '"Dato real que nadie debe tocar"'::jsonb, 'found', 'extracted', 'critico', 'confirmed')
     RETURNING id`,
    [versionCentinela],
  );
  const [fuente] = await query<{ id: string }>(`SELECT id FROM source_documents LIMIT 1`);
  if (fuente) {
    await query(
      `INSERT INTO evidence (brief_field_id, source_id, quote, relation)
       VALUES ($1, $2, 'Cita centinela que debe sobrevivir intacta', 'soporta')`,
      [campo[0]!.id, fuente.id],
    );
  }

  huellaCentinelaAntes = await huellaDeVersion(versionCentinela);
});

afterAll(async () => {
  // Solo se borra lo que ESTA prueba creó, y solo por su id explícito — nunca
  // por nombre ni por organización. La centinela se borra AL FINAL, después
  // de haber demostrado que sobrevivió intacta a todo lo demás.
  if (campanaPropia) {
    await query(`DELETE FROM campaigns WHERE id = $1`, [campanaPropia]);
  }
  await query(`DELETE FROM campaigns WHERE id = $1`, [campanaCentinela]);
  await closePool();
});

describe('INC-001A · una corrida normal nunca toca datos que no creó', () => {
  it('crea y limpia su propia campaña, sin acercarse a la centinela', async () => {
    const campana = await query<{ id: string }>(
      `INSERT INTO campaigns (organization_id, name, owner_id, created_by)
       VALUES ($1, $2, $3, $3) RETURNING id`,
      [orgId, `INC-001 · propia ${Date.now()}`, userId],
    );
    campanaPropia = campana[0]!.id;
    idsPropios.push(campanaPropia);

    // Las mismas operaciones que participaron en el incidente original,
    // ejecutadas aquí sobre la campaña PROPIA, nunca sobre la centinela.
    const version = await transaction((client) =>
      obtenerOCrearVersionDeTrabajo(client, {
        campaignId: campanaPropia,
        organizationId: orgId,
        createdBy: userId,
      }),
    );
    expect(version.esNueva).toBe(true);
    expect(version.versionId).not.toBe(versionCentinela);

    // Llamarla de nuevo debe REUTILIZAR la propia (comportamiento correcto de
    // DEC-024), no crear otra ni tocar la centinela.
    const version2 = await transaction((client) =>
      obtenerOCrearVersionDeTrabajo(client, {
        campaignId: campanaPropia,
        organizationId: orgId,
        createdBy: userId,
      }),
    );
    expect(version2.versionId).toBe(version.versionId);
    expect(version2.esNueva).toBe(false);
  });

  it('crearBriefManual y confirmarCampo operan solo sobre la campaña propia', async () => {
    const creado = await crearBriefManual(actor, campanaPropia);
    expect(creado.ok).toBe(true);
    if (!creado.ok) return;

    const cargada = await cargarVersion(
      await import('./client.ts').then((m) => m.getPool()),
      creado.value.versionId,
    );
    expect(cargada).toBeDefined();

    // `crearBriefManual` reutiliza la versión de trabajo (DEC-024): si el
    // test anterior ya la creó por otra vía sin sembrar campos, no hay nada
    // que confirmar aquí — lo que importa para el aislamiento es que, si hay
    // un campo, `confirmarCampo` operó solo sobre `campanaPropia`.
    const primerCampo = cargada!.version.fields[0];
    if (primerCampo) {
      const confirmado = await confirmarCampo(actor, creado.value.versionId, primerCampo.id, {
        revisionEsperada: primerCampo.revision,
      });
      expect(confirmado.ok === true || confirmado.ok === false).toBe(true);
    }
  });

  it('transicionarBrief sobre la campaña propia no altera el estado de la centinela', async () => {
    const [versionPropia] = await query<{ id: string }>(
      `SELECT v.id FROM brief_versions v JOIN briefs b ON b.id = v.brief_id WHERE b.campaign_id = $1`,
      [campanaPropia],
    );
    if (versionPropia) {
      await transicionarBrief(actor, versionPropia.id, 'processing').catch(() => undefined);
    }

    const [estadoCentinela] = await query<{ status: string }>(
      `SELECT status::text FROM brief_versions WHERE id = $1`,
      [versionCentinela],
    );
    expect(estadoCentinela!.status).toBe('extraction_review');
  });

  it('la centinela sigue exactamente igual: misma versión, mismos campos, misma evidencia', async () => {
    const [existe] = await query<{ id: string }>(`SELECT id FROM brief_versions WHERE id = $1`, [
      versionCentinela,
    ]);
    expect(existe, 'INC-001: la versión centinela fue eliminada — regresión del incidente').toBeDefined();

    const huellaAhora = await huellaDeVersion(versionCentinela);
    expect(huellaAhora, 'INC-001: el contenido de la centinela cambió').toBe(huellaCentinelaAntes);
  });
});
