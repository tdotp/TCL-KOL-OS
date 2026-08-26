/**
 * `crearBriefManual` — el camino 100% manual (§3.3/§6.2, prueba 15).
 *
 * Nunca llama al worker: no hay `AI_ENABLED` que respetar aquí, porque no hay
 * ninguna llamada a IA en absoluto — es justamente el punto. Campaña propia
 * y desechable (INC-001A).
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { User } from '@tcl-kol-os/domain';
import { closePool, query } from './client.ts';
import { crearBriefManual } from './manual.ts';
import { descartarPregunta, generarPreguntas, listarPreguntas } from './local-questions.ts';

let orgId: string;
let userId: string;
let actor: User;
let campanaPropia: string;

beforeAll(async () => {
  const [admin] = await query<{ id: string; organization_id: string }>(
    `SELECT id, organization_id FROM users WHERE email = 'gerardo@smartpr.co'`,
  );
  userId = admin!.id;
  orgId = admin!.organization_id;
  actor = {
    id: userId,
    email: 'gerardo@smartpr.co',
    name: 'Gerardo',
    organizationId: orgId,
    role: 'admin',
    status: 'activo',
  };

  const campana = await query<{ id: string }>(
    `INSERT INTO campaigns (organization_id, name, owner_id, created_by)
     VALUES ($1, $2, $3, $3) RETURNING id`,
    [orgId, `Brief manual · corrida ${Date.now()}`, userId],
  );
  campanaPropia = campana[0]!.id;

  const productos = await query<{ id: string }>(`SELECT id FROM products LIMIT 2`);
  for (const [i, p] of productos.entries()) {
    await query(
      `INSERT INTO campaign_products (campaign_id, product_id, rol, prioridad) VALUES ($1, $2, $3, $4)`,
      [campanaPropia, p.id, i === 0 ? 'flagship' : 'secundario', i + 1],
    );
  }
});

afterAll(async () => {
  await query(`DELETE FROM campaigns WHERE id = $1`, [campanaPropia]);
  await closePool();
});

describe('crear y completar un brief sin IA (prueba 15)', () => {
  it('siembra las 41 claves del catálogo, sin llamar al worker', async () => {
    const resultado = await crearBriefManual(actor, campanaPropia);
    expect(resultado.ok).toBe(true);
    if (!resultado.ok) return;

    const campos = await query<{
      key: string;
      campaign_product_id: string | null;
      status: string;
      provenance_type: string;
    }>(
      `SELECT key, campaign_product_id, status::text, provenance_type::text
         FROM brief_fields WHERE brief_version_id = $1`,
      [resultado.value.versionId],
    );

    const clavesUnicas = new Set(campos.map((c) => c.key));
    expect(clavesUnicas.size).toBe(41);
    expect(campos.every((c) => c.status === 'not_found')).toBe(true);
    expect(campos.every((c) => c.provenance_type === 'pending')).toBe(true);

    // Los campos de nivel `producto` se repiten una vez por cada producto de
    // la campaña (DEC-016) — dos productos sembrados en el `beforeAll`.
    const filasDeProducto = campos.filter((c) => c.key === 'marca_producto[].nombre_producto');
    expect(filasDeProducto).toHaveLength(2);
    expect(filasDeProducto.every((c) => c.campaign_product_id !== null)).toBe(true);
  });

  it('es idempotente: llamarla de nuevo reutiliza la versión, no duplica campos', async () => {
    const primera = await crearBriefManual(actor, campanaPropia);
    expect(primera.ok).toBe(true);
    if (!primera.ok) return;

    const filasPrimera = await query<{ n: string }>(
      `SELECT count(*)::text AS n FROM brief_fields WHERE brief_version_id = $1`,
      [primera.value.versionId],
    );

    const segunda = await crearBriefManual(actor, campanaPropia);
    expect(segunda.ok).toBe(true);
    if (!segunda.ok) return;

    expect(segunda.value.versionId).toBe(primera.value.versionId);
    expect(segunda.value.esNueva).toBe(false);

    const filasSegunda = await query<{ n: string }>(
      `SELECT count(*)::text AS n FROM brief_fields WHERE brief_version_id = $1`,
      [primera.value.versionId],
    );
    expect(filasSegunda[0]!.n).toBe(filasPrimera[0]!.n);
  });

  it('un claim vacío no bloquea nada por sí solo; se descarta con justificación si no aplica (DEC-028)', async () => {
    const creado = await crearBriefManual(actor, campanaPropia);
    expect(creado.ok).toBe(true);
    if (!creado.ok) return;

    // Genera preguntas: los claims not_found SÍ producen pregunta (para que
    // alguien decida), pero no bloquean la creación ni la carga del brief.
    const generadas = await generarPreguntas(actor, creado.value.versionId);
    expect(generadas.ok).toBe(true);

    const preguntas = await listarPreguntas(actor, campanaPropia, { status: 'pendiente' });
    expect(preguntas.ok).toBe(true);
    if (!preguntas.ok) return;
    const deClaim = preguntas.value.find((p) => p.criticidad === 'claim');
    expect(deClaim, 'se esperaba al menos una pregunta de tipo claim').toBeDefined();

    const descartada = await descartarPregunta(
      actor,
      deClaim!.id,
      'No aplica para este producto en esta campaña.',
    );
    expect(descartada.ok).toBe(true);

    // El campo sigue not_found — un descarte nunca inventa un valor.
    const [campo] = await query<{ status: string; value: unknown }>(
      `SELECT status::text, value FROM brief_fields
        WHERE brief_version_id = $1 AND key = $2
          AND campaign_product_id IS NOT DISTINCT FROM (SELECT campaign_product_id FROM local_questions WHERE id = $3)`,
      [creado.value.versionId, deClaim!.key, deClaim!.id],
    );
    expect(campo!.status).toBe('not_found');
    expect(campo!.value).toBeNull();
  });
});
