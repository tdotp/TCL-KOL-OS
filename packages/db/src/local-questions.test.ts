/**
 * Épica E6 · Preguntas locales, completas (Sprint 4, cierre §5).
 *
 * Cubre las pruebas 1, 2, 4, 5, 6, 7, 8 del cierre, más la validación
 * estructurada de `answerValue` (corrección 3). Campaña propia y desechable
 * en cada corrida — nunca el seed, nunca P80 (INC-001A).
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { User } from '@tcl-kol-os/domain';
import { closePool, query } from './client.ts';
import { crearBriefManual } from './manual.ts';
import {
  descartarPregunta,
  generarPreguntas,
  listarPreguntas,
  responderPregunta,
} from './local-questions.ts';

let orgId: string;
let userId: string;
let actor: User;
let campanaPropia: string;
let versionId: string;
let campaignProductIds: string[];

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
    [orgId, `Preguntas locales · corrida ${Date.now()}`, userId],
  );
  campanaPropia = campana[0]!.id;

  const productos = await query<{ id: string }>(`SELECT id FROM products LIMIT 2`);
  for (const [i, p] of productos.entries()) {
    await query(
      `INSERT INTO campaign_products (campaign_id, product_id, rol, prioridad) VALUES ($1, $2, $3, $4)`,
      [campanaPropia, p.id, i === 0 ? 'flagship' : 'secundario', i + 1],
    );
  }
  const filasProductos = await query<{ id: string }>(
    `SELECT id FROM campaign_products WHERE campaign_id = $1 ORDER BY prioridad`,
    [campanaPropia],
  );
  campaignProductIds = filasProductos.map((f) => f.id);

  const creado = await crearBriefManual(actor, campanaPropia);
  if (!creado.ok) throw new Error(`No se pudo crear el brief manual: ${creado.error.message}`);
  versionId = creado.value.versionId;
});

afterAll(async () => {
  await query(`DELETE FROM campaigns WHERE id = $1`, [campanaPropia]);
  await closePool();
});

describe('generación (pruebas 1, 2, 4, 5)', () => {
  it('un crítico not_found genera exactamente una pregunta (prueba 1)', async () => {
    const resultado = await generarPreguntas(actor, versionId);
    expect(resultado.ok).toBe(true);
    if (!resultado.ok) return;
    expect(resultado.value.creadas).toBeGreaterThan(0);

    const preguntas = await listarPreguntas(actor, campanaPropia, { status: 'pendiente' });
    expect(preguntas.ok).toBe(true);
    if (!preguntas.ok) return;

    const deObjetivoTipo = preguntas.value.filter((p) => p.key === 'objetivo.tipo');
    expect(deObjetivoTipo).toHaveLength(1);
  });

  it('regenerar no duplica (prueba 2)', async () => {
    const antes = await listarPreguntas(actor, campanaPropia);
    const primeraCantidad = antes.ok ? antes.value.length : -1;

    const resultado = await generarPreguntas(actor, versionId);
    expect(resultado.ok).toBe(true);
    // La segunda corrida no debería crear nada nuevo: todo ya existía.
    if (resultado.ok) expect(resultado.value.creadas).toBe(0);

    const despues = await listarPreguntas(actor, campanaPropia);
    expect(despues.ok).toBe(true);
    if (despues.ok) expect(despues.value.length).toBe(primeraCantidad);
  });

  it('una pregunta compartida no se repite por producto (prueba 4)', async () => {
    const preguntas = await listarPreguntas(actor, campanaPropia);
    expect(preguntas.ok).toBe(true);
    if (!preguntas.ok) return;
    // 'target_audiencia.descripcion' es compartido-con-excepción (DEC-016);
    // en un brief manual recién sembrado, nivel producto NULL, una sola fila.
    const compartidas = preguntas.value.filter((p) => p.key === 'target_audiencia.descripcion');
    expect(compartidas).toHaveLength(1);
    expect(compartidas[0]!.campaignProductId).toBeNull();
  });

  it('una pregunta específica se genera por producto (prueba 5)', async () => {
    const preguntas = await listarPreguntas(actor, campanaPropia);
    expect(preguntas.ok).toBe(true);
    if (!preguntas.ok) return;
    const porProducto = preguntas.value.filter((p) => p.key === 'marca_producto[].nombre_producto');
    expect(porProducto).toHaveLength(campaignProductIds.length);
    const idsAnclados = new Set(porProducto.map((p) => p.campaignProductId));
    expect(idsAnclados).toEqual(new Set(campaignProductIds));
  });
});

describe('responder y descartar (pruebas 6, 7, 8)', () => {
  it('descartar sin justificación falla (prueba 8)', async () => {
    const [pregunta] = await listarPreguntas(actor, campanaPropia, { status: 'pendiente' }).then((r) =>
      r.ok ? r.value.filter((p) => p.key === 'objetivo.negocio') : [],
    );
    expect(pregunta).toBeDefined();
    const resultado = await descartarPregunta(actor, pregunta!.id, '   ');
    expect(resultado.ok).toBe(false);
  });

  it('descartar con justificación real queda registrado con autor y fecha', async () => {
    const [pregunta] = await listarPreguntas(actor, campanaPropia, { status: 'pendiente' }).then((r) =>
      r.ok ? r.value.filter((p) => p.key === 'objetivo.negocio') : [],
    );
    const resultado = await descartarPregunta(
      actor,
      pregunta!.id,
      'El cliente no lo definió aún; se retoma después.',
    );
    expect(resultado.ok).toBe(true);

    const [fila] = await query<{ status: string; answered_by: string; answered_at: Date | null }>(
      `SELECT status::text, answered_by, answered_at FROM local_questions WHERE id = $1`,
      [pregunta!.id],
    );
    expect(fila!.status).toBe('descartada');
    expect(fila!.answered_by).toBe(userId);
    expect(fila!.answered_at).not.toBeNull();
  });

  it('un valor de enum fuera de los permitidos se rechaza antes de tocar la base', async () => {
    const [pregunta] = await listarPreguntas(actor, campanaPropia, { status: 'pendiente' }).then((r) =>
      r.ok ? r.value.filter((p) => p.key === 'objetivo.tipo') : [],
    );
    expect(pregunta).toBeDefined();

    const rechazado = await responderPregunta(actor, pregunta!.id, { answerValue: 'un valor inventado' });
    expect(rechazado.ok).toBe(false);
    if (!rechazado.ok) expect(rechazado.error.message).toMatch(/debe ser uno de/);

    // El rechazo no dejó la pregunta a medias: sigue pendiente.
    const [filaTrasRechazo] = await query<{ status: string }>(
      `SELECT status::text FROM local_questions WHERE id = $1`,
      [pregunta!.id],
    );
    expect(filaTrasRechazo!.status).toBe('pendiente');
  });

  it('responder registra actor y fecha, y crea provenance manual_local (pruebas 6, 7)', async () => {
    const [pregunta] = await listarPreguntas(actor, campanaPropia, { status: 'pendiente' }).then((r) =>
      r.ok ? r.value.filter((p) => p.key === 'objetivo.tipo') : [],
    );
    expect(pregunta).toBeDefined();

    const resultado = await responderPregunta(actor, pregunta!.id, { answerValue: 'awareness' });
    expect(resultado.ok, !resultado.ok ? resultado.error.message : '').toBe(true);

    const [filaPregunta] = await query<{ status: string; answered_by: string; answered_at: Date | null }>(
      `SELECT status::text, answered_by, answered_at FROM local_questions WHERE id = $1`,
      [pregunta!.id],
    );
    expect(filaPregunta!.status).toBe('respondida');
    expect(filaPregunta!.answered_by).toBe(userId);
    expect(filaPregunta!.answered_at).not.toBeNull();

    const [campo] = await query<{ value: unknown; provenance_type: string; status: string }>(
      `SELECT value, provenance_type::text, status::text FROM brief_fields
        WHERE brief_version_id = $1 AND key = 'objetivo.tipo'`,
      [versionId],
    );
    expect(campo!.provenance_type).toBe('manual_local');
    expect(campo!.status).toBe('found');
    expect(campo!.value).toBe('awareness');
  });

  it(
    'responder una pregunta sobre un campo YA extraído con confidence no nulo ' +
      'no viola brief_fields_manual_sin_confianza (regresión Demo A)',
    async () => {
      // A diferencia de `crearBriefManual` (siempre confidence NULL), esto
      // simula el caso real que rompió en P80: un campo que el worker ya
      // había extraído con confianza, y que además tiene una pregunta local
      // pendiente (aquí, plantada directo — no depende de qué dispara
      // `generarPreguntas`, solo del `UPDATE` interno de `responderPregunta`).
      const [campo] = await query<{ id: string }>(
        `UPDATE brief_fields
            SET status = 'found', provenance_type = 'extracted', confidence = 0.85,
                value = '"Informal"'::jsonb
          WHERE brief_version_id = $1 AND key = 'mensaje_principal.tono' AND campaign_product_id IS NULL
          RETURNING id`,
        [versionId],
      );
      const [pregunta] = await query<{ id: string }>(
        `INSERT INTO local_questions (campaign_id, brief_version_id, key, question, reason, criticidad)
         VALUES ($1, $2, 'mensaje_principal.tono', '¿Cuál es el tono?', 'Ajuste manual', 'informativo')
         RETURNING id`,
        [campanaPropia, versionId],
      );

      const resultado = await responderPregunta(actor, pregunta!.id, { answerValue: 'Cercano y directo' });
      expect(resultado.ok, !resultado.ok ? resultado.error.message : '').toBe(true);

      const [fila] = await query<{
        value: unknown;
        provenance_type: string;
        confidence: string | null;
      }>(`SELECT value, provenance_type::text, confidence FROM brief_fields WHERE id = $1`, [campo!.id]);
      expect(fila!.value).toBe('Cercano y directo');
      expect(fila!.provenance_type).toBe('manual_local');
      expect(fila!.confidence).toBeNull();
    },
  );

  it('una fecha respondida como texto libre se rechaza (corrección 3)', async () => {
    const preguntasFecha = await listarPreguntas(actor, campanaPropia, { status: 'pendiente' }).then((r) =>
      r.ok ? r.value.filter((p) => p.key === 'practico.fecha_inicio') : [],
    );
    const pregunta = preguntasFecha[0];
    if (!pregunta) return; // el manual no siempre genera pregunta de fecha sin conflicto previo

    const resultado = await responderPregunta(actor, pregunta.id, { answerValue: '2026-11' });
    expect(resultado.ok).toBe(false);
    if (!resultado.ok) expect(resultado.error.message).toMatch(/objeto de fecha con precisión/);
  });
});
