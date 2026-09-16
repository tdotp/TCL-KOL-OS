/**
 * Sprint 5, Fase E — versionado posterior a aprobación (DEC-027, DEC-033).
 *
 * `crearVersionHija` es la única función que crea una versión a partir de
 * una `approved` — nunca un `INSERT` directo en otro archivo (mismo
 * principio que `transicionarBrief`, único punto que cambia `status`).
 *
 * Campaña propia y desechable (INC-001A) — nunca P80 ni el seed compartido.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { User } from '@tcl-kol-os/domain';
import { closePool, query } from './client.ts';
import { crearBriefManual } from './manual.ts';
import { corregirCampo } from './brief-fields.ts';
import {
  descartarPregunta,
  generarPreguntas,
  listarPreguntas,
  responderPregunta,
} from './local-questions.ts';
import { transicionarBrief } from './transitions.ts';
import { aprobarComoCliente, aprobarInternamente } from './client-review.ts';
import { crearComentario } from './comments.ts';
import { crearVersionHija } from './versioning.ts';

let orgId: string;
let userId: string;
let admin: User;
let director: User;
let cliente: User;
const campanasCreadas: string[] = [];

async function nuevaCampanaPropia(etiqueta: string): Promise<string> {
  const campana = await query<{ id: string }>(
    `INSERT INTO campaigns (organization_id, name, owner_id, created_by)
     VALUES ($1, $2, $3, $3) RETURNING id`,
    [orgId, `Versionado · ${etiqueta} · ${Date.now()}`, userId],
  );
  const id = campana[0]!.id;
  campanasCreadas.push(id);
  return id;
}

async function llegarAInternalReview(versionId: string, campaignId: string): Promise<void> {
  await generarPreguntas(admin, versionId);
  const preguntas = await listarPreguntas(admin, campaignId, { status: 'pendiente' });
  if (!preguntas.ok) return;
  for (const p of preguntas.value) {
    if (p.criticidad === 'critico') {
      let valor: unknown = `Respuesta de prueba para ${p.key}`;
      if (p.key.includes('fecha'))
        valor = { tipo: 'exacta', fecha: '2026-09-04', textoOriginal: '2026-09-04' };
      else if (p.key === 'objetivo.tipo') valor = 'awareness';
      else if (p.key === 'mandatorios')
        valor = [{ categoria: 'mensaje', descripcion: 'Mencionar el hashtag oficial de la campaña.' }];
      else if (p.key === 'practico.restricciones')
        valor = ['Único canal de venta autorizado: el que declare el cliente.'];
      const r = await responderPregunta(admin, p.id, { answerValue: valor });
      if (!r.ok) await descartarPregunta(admin, p.id, 'No se pudo responder automáticamente.');
    } else {
      await descartarPregunta(admin, p.id, 'No aplica: sin evidencia real disponible en esta prueba.');
    }
  }
  const t = await transicionarBrief(admin, versionId, 'internal_review');
  if (!t.ok) throw new Error(`No se pudo llegar a internal_review: ${t.error.message}`);
}

/** Recorre todo el ciclo hasta `approved` — punto de partida de cada prueba de esta suite. */
async function nuevoBriefAprobado(etiqueta: string): Promise<{ campaignId: string; versionId: string }> {
  const campaignId = await nuevaCampanaPropia(etiqueta);
  const creado = await crearBriefManual(admin, campaignId);
  if (!creado.ok) throw new Error(`No se pudo crear el brief: ${creado.error.message}`);
  const versionId = creado.value.versionId;

  await llegarAInternalReview(versionId, campaignId);
  const interna = await aprobarInternamente(director, versionId);
  if (!interna.ok) throw new Error(`No se pudo aprobar internamente: ${interna.error.message}`);
  const final = await aprobarComoCliente(cliente, versionId);
  if (!final.ok) throw new Error(`No se pudo aprobar como cliente: ${final.error.message}`);

  return { campaignId, versionId };
}

beforeAll(async () => {
  const [filaAdmin] = await query<{ id: string; organization_id: string }>(
    `SELECT id, organization_id FROM users WHERE email = 'gerardo@smartpr.co'`,
  );
  userId = filaAdmin!.id;
  orgId = filaAdmin!.organization_id;
  admin = {
    id: userId,
    email: 'gerardo@smartpr.co',
    name: 'Gerardo',
    organizationId: orgId,
    role: 'admin',
    status: 'activo',
  };

  const [filaDirector] = await query<{ id: string; organization_id: string }>(
    `SELECT id, organization_id FROM users WHERE email = 'director@smartpr.co'`,
  );
  director = {
    id: filaDirector!.id,
    email: 'director@smartpr.co',
    name: 'Director',
    organizationId: filaDirector!.organization_id,
    role: 'director',
    status: 'activo',
  };

  const [filaCliente] = await query<{ id: string; organization_id: string }>(
    `SELECT id, organization_id FROM users WHERE email = 'marena@tcl.com'`,
  );
  cliente = {
    id: filaCliente!.id,
    email: 'marena@tcl.com',
    name: 'Marena',
    organizationId: filaCliente!.organization_id,
    role: 'cliente',
    status: 'activo',
  };
});

afterAll(async () => {
  for (const id of campanasCreadas) await query(`DELETE FROM campaigns WHERE id = $1`, [id]);
  await closePool();
});

describe('crear una versión hija', () => {
  it('solo se puede crear a partir de una versión approved', async () => {
    const campaignId = await nuevaCampanaPropia('no-aprobada');
    const creado = await crearBriefManual(admin, campaignId);
    if (!creado.ok) throw new Error('setup');
    const resultado = await crearVersionHija(admin, creado.value.versionId);
    expect(resultado.ok).toBe(false);
    if (resultado.ok) return;
    expect(resultado.error.code).toBe('BRIEF_VERSION_IMMUTABLE');
  });

  it('crea la hija con version+1, estado draft, y la relación padre-hija', async () => {
    const { versionId } = await nuevoBriefAprobado('hija-basica');
    const resultado = await crearVersionHija(admin, versionId);
    expect(resultado.ok, !resultado.ok ? resultado.error.message : '').toBe(true);
    if (!resultado.ok) return;

    expect(resultado.value.version).toBe(2);
    expect(resultado.value.parentVersionId).toBe(versionId);

    const [fila] = await query<{ status: string; parent_version_id: string | null; version: number }>(
      `SELECT status::text, parent_version_id, version FROM brief_versions WHERE id = $1`,
      [resultado.value.versionId],
    );
    expect(fila!.status).toBe('draft');
    expect(fila!.parent_version_id).toBe(versionId);
    expect(fila!.version).toBe(2);
  });

  it('marca la versión anterior como superseded', async () => {
    const { versionId } = await nuevoBriefAprobado('supersede');
    await crearVersionHija(admin, versionId);

    const [fila] = await query<{ status: string }>(`SELECT status::text FROM brief_versions WHERE id = $1`, [
      versionId,
    ]);
    expect(fila!.status).toBe('superseded');
  });

  it('la versión anterior conserva exactamente sus valores y evidencia — no se toca', async () => {
    const { versionId } = await nuevoBriefAprobado('valores-intactos');
    const antes = await query<{ key: string; value: unknown }>(
      `SELECT key, value FROM brief_fields WHERE brief_version_id = $1 ORDER BY key`,
      [versionId],
    );

    await crearVersionHija(admin, versionId);

    const despues = await query<{ key: string; value: unknown }>(
      `SELECT key, value FROM brief_fields WHERE brief_version_id = $1 ORDER BY key`,
      [versionId],
    );
    expect(despues).toEqual(antes);
  });

  it('la fecha de aprobación de la versión anterior no cambia', async () => {
    const { versionId } = await nuevoBriefAprobado('approved-at-intacto');
    const [antes] = await query<{ approved_at: Date }>(
      `SELECT approved_at FROM brief_versions WHERE id = $1`,
      [versionId],
    );

    await crearVersionHija(admin, versionId);

    const [despues] = await query<{ approved_at: Date }>(
      `SELECT approved_at FROM brief_versions WHERE id = $1`,
      [versionId],
    );
    expect(despues!.approved_at.toISOString()).toBe(antes!.approved_at.toISOString());
  });

  it('copia los campos como punto de partida, con review_status vuelto a pending', async () => {
    const { versionId } = await nuevoBriefAprobado('copia-de-campos');
    const resultado = await crearVersionHija(admin, versionId);
    if (!resultado.ok) throw new Error('setup');

    const original = await query<{ n: string }>(
      `SELECT count(*)::text AS n FROM brief_fields WHERE brief_version_id = $1`,
      [versionId],
    );
    const copia = await query<{ n: string }>(
      `SELECT count(*)::text AS n FROM brief_fields WHERE brief_version_id = $1`,
      [resultado.value.versionId],
    );
    expect(copia[0]!.n).toBe(original[0]!.n);

    const [campoCopiado] = await query<{ review_status: string }>(
      `SELECT review_status FROM brief_fields WHERE brief_version_id = $1 LIMIT 1`,
      [resultado.value.versionId],
    );
    expect(campoCopiado!.review_status).toBe('pending');
  });

  it('no copia las preguntas locales de la versión anterior', async () => {
    const { versionId } = await nuevoBriefAprobado('sin-preguntas-heredadas');
    const resultado = await crearVersionHija(admin, versionId);
    if (!resultado.ok) throw new Error('setup');

    const preguntas = await query<{ n: string }>(
      `SELECT count(*)::text AS n FROM local_questions WHERE brief_version_id = $1`,
      [resultado.value.versionId],
    );
    expect(preguntas[0]!.n).toBe('0');
  });

  it('no copia comentarios internos como conversación activa; quedan en la versión histórica', async () => {
    const campaignId = await nuevaCampanaPropia('comentarios-historicos');
    const creado = await crearBriefManual(admin, campaignId);
    if (!creado.ok) throw new Error('setup');
    const versionId = creado.value.versionId;

    const [campo] = await query<{ key: string }>(
      `SELECT key FROM brief_fields WHERE brief_version_id = $1 LIMIT 1`,
      [versionId],
    );
    // El comentario se crea ANTES de aprobar, sobre una versión todavía editable.
    const comentado = await crearComentario(admin, versionId, {
      fieldKey: campo!.key,
      content: 'Revisar este dato con el cliente.',
    });
    expect(comentado.ok).toBe(true);

    await llegarAInternalReview(versionId, campaignId);
    await aprobarInternamente(director, versionId);
    await aprobarComoCliente(cliente, versionId);

    const resultado = await crearVersionHija(admin, versionId);
    if (!resultado.ok) throw new Error('setup');

    const comentariosHija = await query<{ n: string }>(
      `SELECT count(*)::text AS n FROM field_comments WHERE brief_version_id = $1 AND field_key = $2`,
      [resultado.value.versionId, campo!.key],
    );
    expect(comentariosHija[0]!.n).toBe('0');

    // Sigue en la versión histórica (ya `superseded`), consultable.
    const comentariosPadre = await query<{ n: string }>(
      `SELECT count(*)::text AS n FROM field_comments WHERE brief_version_id = $1 AND field_key = $2`,
      [versionId, campo!.key],
    );
    expect(comentariosPadre[0]!.n).toBe('1');
  });

  it('auditar la creación y la relación padre-hija', async () => {
    const { versionId } = await nuevoBriefAprobado('auditoria');
    const resultado = await crearVersionHija(admin, versionId);
    if (!resultado.ok) throw new Error('setup');

    const [evento] = await query<{ metadata: { parentVersionId: string; version: number } }>(
      `SELECT metadata FROM audit_events
        WHERE action = 'brief.create_child_version' AND entity_id = $1`,
      [resultado.value.versionId],
    );
    expect(evento!.metadata.parentVersionId).toBe(versionId);
    expect(evento!.metadata.version).toBe(2);

    const [eventoSuperseded] = await query<{ n: string }>(
      `SELECT count(*)::text AS n FROM audit_events WHERE action = 'brief.superseded' AND entity_id = $1`,
      [versionId],
    );
    expect(Number(eventoSuperseded!.n)).toBeGreaterThan(0);
  });

  it('dos solicitudes simultáneas no crean dos versiones hijas', async () => {
    const { versionId } = await nuevoBriefAprobado('concurrencia');

    const [a, b] = await Promise.all([
      crearVersionHija(admin, versionId),
      crearVersionHija(admin, versionId),
    ]);
    const exitosos = [a, b].filter((r) => r.ok);
    expect(exitosos).toHaveLength(1);

    const [fila] = await query<{ n: string }>(
      `SELECT count(*)::text AS n FROM brief_versions WHERE parent_version_id = $1`,
      [versionId],
    );
    expect(fila!.n).toBe('1');
  });

  it('la versión hija sí admite edición — es la nueva versión de trabajo', async () => {
    const { versionId } = await nuevoBriefAprobado('hija-editable');
    const resultado = await crearVersionHija(admin, versionId);
    if (!resultado.ok) throw new Error('setup');

    const [campo] = await query<{ id: string; revision: number }>(
      `SELECT id, revision FROM brief_fields WHERE brief_version_id = $1 LIMIT 1`,
      [resultado.value.versionId],
    );
    const correccion = await corregirCampo(admin, resultado.value.versionId, campo!.id, {
      value: 'Valor corregido en la versión hija',
      revisionEsperada: campo!.revision,
    });
    expect(correccion.ok, !correccion.ok ? correccion.error.message : '').toBe(true);
  });
});
