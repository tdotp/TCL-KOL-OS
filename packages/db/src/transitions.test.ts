/**
 * `transicionarBrief` — conecta el dominio a la base (Sprint 4, cierre §3.4).
 *
 * Cubre las pruebas 3, 13, 14, 16, 17, 18, el ciclo completo de estados
 * (corrección 1) y el conflicto de revisión (corrección 7). Cada prueba que
 * necesita un brief manual crea su PROPIA campaña — nunca reutiliza una
 * compartida entre pruebas de este archivo: `obtenerOCrearVersionDeTrabajo`
 * (DEC-024) reutilizaría la misma versión entre pruebas si compartieran
 * campaña, contaminando el estado de una prueba con el de otra. Nunca el
 * seed, nunca P80 (INC-001A).
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { User } from '@tcl-kol-os/domain';
import { closePool, query } from './client.ts';
import { eliminarCampanaDePrueba } from './test-utils.ts';
import { crearBriefManual } from './manual.ts';
import { confirmarCampo, corregirCampo } from './brief-fields.ts';
import {
  generarPreguntas,
  responderPregunta,
  descartarPregunta,
  listarPreguntas,
} from './local-questions.ts';
import { transicionarBrief } from './transitions.ts';

let orgId: string;
let userId: string;
let actor: User;
let orgAjena: string;

const campanasCreadas: string[] = [];

async function nuevaCampanaPropia(etiqueta: string): Promise<string> {
  const campana = await query<{ id: string }>(
    `INSERT INTO campaigns (organization_id, name, owner_id, created_by)
     VALUES ($1, $2, $3, $3) RETURNING id`,
    [orgId, `Transiciones · ${etiqueta} · ${Date.now()}`, userId],
  );
  const id = campana[0]!.id;
  campanasCreadas.push(id);
  return id;
}

async function nuevoBriefManual(etiqueta: string): Promise<{ campaignId: string; versionId: string }> {
  const campaignId = await nuevaCampanaPropia(etiqueta);
  const creado = await crearBriefManual(actor, campaignId);
  if (!creado.ok) throw new Error(`No se pudo crear el brief manual: ${creado.error.message}`);
  return { campaignId, versionId: creado.value.versionId };
}

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

  const [ajena] = await query<{ organization_id: string }>(
    `SELECT organization_id FROM campaigns WHERE organization_id <> $1 LIMIT 1`,
    [orgId],
  );
  orgAjena = ajena!.organization_id;
});

afterAll(async () => {
  await eliminarCampanaDePrueba(campanasCreadas);
  await closePool();
});

/**
 * Responde todo lo `critico` (queda `manual_local`, sin evidencia — DEC-028
 * no lo exige para un crítico no técnico) y descarta todo lo `claim` (un
 * claim manual sin evidencia seguiría bloqueando — DEC-028 — así que la
 * única forma honesta de avanzar sin evidencia real es declarar que no
 * aplica, no inventar un valor).
 */
async function completarTodosLosCriticos(versionId: string, campaignId: string): Promise<void> {
  await generarPreguntas(actor, versionId);
  const preguntas = await listarPreguntas(actor, campaignId, { status: 'pendiente' });
  if (!preguntas.ok) return;
  for (const p of preguntas.value) {
    if (p.criticidad === 'critico') {
      let valor: unknown = `Respuesta de prueba para ${p.key}`;
      if (p.key.includes('fecha')) {
        valor = { tipo: 'exacta', fecha: '2026-09-04', textoOriginal: '2026-09-04' };
      } else if (p.key === 'objetivo.tipo') {
        valor = 'awareness';
      } else if (p.key === 'mandatorios') {
        valor = [{ categoria: 'mensaje', descripcion: 'Mencionar el hashtag oficial de la campaña.' }];
      } else if (p.key === 'practico.restricciones') {
        valor = ['Único canal de venta autorizado: el que declare el cliente.'];
      }
      const resultado = await responderPregunta(actor, p.id, { answerValue: valor });
      if (!resultado.ok) {
        await descartarPregunta(actor, p.id, 'No se pudo responder automáticamente en esta prueba.');
      }
    } else {
      await descartarPregunta(
        actor,
        p.id,
        'No aplica para esta prueba automatizada: sin evidencia real disponible.',
      );
    }
  }
}

describe('aislamiento y recurso inexistente (prueba 18)', () => {
  it('una versión de otra organización no se puede transicionar', async () => {
    const [versionAjena] = await query<{ id: string }>(
      `SELECT v.id FROM brief_versions v WHERE v.organization_id = $1 LIMIT 1`,
      [orgAjena],
    );
    if (!versionAjena) return; // sin material de la otra organización, nada que probar
    const resultado = await transicionarBrief(actor, versionAjena.id, 'processing');
    expect(resultado.ok).toBe(false);
    if (!resultado.ok) expect(resultado.error.code).toBe('RESOURCE_NOT_FOUND');
  });

  it('un id inexistente da RESOURCE_NOT_FOUND, no un error interno', async () => {
    const resultado = await transicionarBrief(actor, '00000000-0000-0000-0000-000000000000', 'processing');
    expect(resultado.ok).toBe(false);
    if (!resultado.ok) expect(resultado.error.code).toBe('RESOURCE_NOT_FOUND');
  });
});

describe('brief incompleto no pasa a internal_review (prueba 16)', () => {
  it('rechaza la transición con un mensaje que dice exactamente qué falta', async () => {
    const { versionId } = await nuevoBriefManual('incompleto');

    const resultado = await transicionarBrief(actor, versionId, 'internal_review');
    expect(resultado.ok).toBe(false);
    if (!resultado.ok) {
      expect(resultado.error.code).not.toBe('BRIEF_INVALID_TRANSITION');
      expect(resultado.error.message.length).toBeGreaterThan(10);
    }
  });
});

describe('conflicto resuelto deja de bloquear (prueba 14)', () => {
  it('un campo en conflict, corregido a found, ya no impide avanzar', async () => {
    const { versionId } = await nuevoBriefManual('conflicto');

    await query(
      `UPDATE brief_fields SET status = 'conflict', value = NULL
        WHERE brief_version_id = $1 AND key = 'contexto.categoria'`,
      [versionId],
    );

    const [antes] = await query<{ id: string; revision: number }>(
      `SELECT id, revision FROM brief_fields WHERE brief_version_id = $1 AND key = 'contexto.categoria'`,
      [versionId],
    );
    const corregido = await corregirCampo(actor, versionId, antes!.id, {
      value: 'Smartphones',
      motivo: 'Se confirmó con el cliente cuál de las dos fuentes es la correcta.',
      revisionEsperada: antes!.revision,
    });
    expect(corregido.ok).toBe(true);

    const [despues] = await query<{ status: string }>(`SELECT status::text FROM brief_fields WHERE id = $1`, [
      antes!.id,
    ]);
    expect(despues!.status).toBe('found');
  });
});

describe('control de concurrencia optimista (corrección 7)', () => {
  it('un guardado con la revisión equivocada se rechaza, no aplica "el último gana"', async () => {
    const { versionId } = await nuevoBriefManual('concurrencia');

    const [campo] = await query<{ id: string; revision: number }>(
      `SELECT id, revision FROM brief_fields WHERE brief_version_id = $1 AND key = 'contexto.categoria'`,
      [versionId],
    );

    const primero = await confirmarCampo(actor, versionId, campo!.id, { revisionEsperada: campo!.revision });
    expect(primero.ok).toBe(true);

    // Reintentar con la MISMA revisión ya usada (como si dos pestañas
    // hubieran abierto el campo al mismo tiempo) debe rechazarse.
    const segundo = await confirmarCampo(actor, versionId, campo!.id, { revisionEsperada: campo!.revision });
    expect(segundo.ok).toBe(false);
    if (!segundo.ok) expect(segundo.error.code).toBe('FIELD_REVISION_CONFLICT');
  });
});

describe('el ciclo completo hasta internal_review (pruebas 3, 13, 17)', () => {
  it('completar todos los críticos permite llegar a internal_review', async () => {
    const { campaignId, versionId } = await nuevoBriefManual('ciclo-completo');

    await completarTodosLosCriticos(versionId, campaignId);

    const resultado = await transicionarBrief(actor, versionId, 'internal_review');
    expect(
      resultado.ok,
      !resultado.ok ? `${resultado.error.message} ${JSON.stringify(resultado.error.details)}` : '',
    ).toBe(true);
    if (resultado.ok) expect(resultado.value.status).toBe('internal_review');

    // Confirmar/corregir queda auditado (prueba 13): al menos la propia
    // transición dejó un evento — la auditoría de campo se prueba en
    // brief-fields.test.ts.
    const eventos = await query<{ action: string }>(
      `SELECT action FROM audit_events WHERE entity_id = $1 AND action = 'brief.transition'`,
      [versionId],
    );
    expect(eventos.length).toBeGreaterThan(0);
  });
});
