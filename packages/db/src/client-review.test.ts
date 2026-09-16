/**
 * Sprint 5, Fases C y D — ciclo de aprobación interna y del cliente.
 *
 * `solicitarCambiosInternos` / `aprobarInternamente` / `solicitarCambiosCliente`
 * / `aprobarComoCliente`, todos envoltorios de `transicionarBrief`
 * (`packages/db/src/transitions.ts`). Cubre también el hallazgo real de
 * auditoría (Sprint 5): `campaigns.visibility` sube sola a `tcl` al entrar en
 * `client_review` — sin eso el cliente nunca podría ver la campaña.
 *
 * Campaña propia y desechable (INC-001A) — nunca P80 ni el seed compartido.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { User } from '@tcl-kol-os/domain';
import { closePool, query } from './client.ts';
import { eliminarCampanaDePrueba } from './test-utils.ts';
import { crearBriefManual } from './manual.ts';
import {
  descartarPregunta,
  generarPreguntas,
  listarPreguntas,
  responderPregunta,
} from './local-questions.ts';
import { transicionarBrief } from './transitions.ts';
import {
  aprobarComoCliente,
  aprobarInternamente,
  solicitarCambiosCliente,
  solicitarCambiosInternos,
} from './client-review.ts';
import { motivoDeUltimaDevolucion } from './transitions.ts';
import { listCampaigns } from './campaigns.ts';

let orgId: string;
let userId: string;
let admin: User;
let director: User;
let consultor: User;
let cliente: User;
const campanasCreadas: string[] = [];

async function nuevaCampanaPropia(etiqueta: string): Promise<string> {
  const campana = await query<{ id: string }>(
    `INSERT INTO campaigns (organization_id, name, owner_id, created_by)
     VALUES ($1, $2, $3, $3) RETURNING id`,
    [orgId, `Aprobación · ${etiqueta} · ${Date.now()}`, userId],
  );
  const id = campana[0]!.id;
  campanasCreadas.push(id);
  return id;
}

/** Responde/descarta lo necesario para llegar a `internal_review` (mismo patrón que transitions.test.ts). */
async function completarHastaInternalReview(versionId: string, campaignId: string): Promise<void> {
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
      const resultado = await responderPregunta(admin, p.id, { answerValue: valor });
      if (!resultado.ok) await descartarPregunta(admin, p.id, 'No se pudo responder automáticamente.');
    } else {
      await descartarPregunta(admin, p.id, 'No aplica: sin evidencia real disponible en esta prueba.');
    }
  }
  const resultado = await transicionarBrief(admin, versionId, 'internal_review');
  if (!resultado.ok) throw new Error(`No se pudo llegar a internal_review: ${resultado.error.message}`);
}

async function nuevoBriefEnInternalReview(
  etiqueta: string,
): Promise<{ campaignId: string; versionId: string }> {
  const campaignId = await nuevaCampanaPropia(etiqueta);
  const creado = await crearBriefManual(admin, campaignId);
  if (!creado.ok) throw new Error(`No se pudo crear el brief: ${creado.error.message}`);
  await completarHastaInternalReview(creado.value.versionId, campaignId);
  return { campaignId, versionId: creado.value.versionId };
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

  const [filaConsultor] = await query<{ id: string; organization_id: string }>(
    `SELECT id, organization_id FROM users WHERE email = 'consultor@smartpr.co'`,
  );
  consultor = {
    id: filaConsultor!.id,
    email: 'consultor@smartpr.co',
    name: 'Consultora',
    organizationId: filaConsultor!.organization_id,
    role: 'consultor',
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
  await eliminarCampanaDePrueba(campanasCreadas);
  await closePool();
});

describe('Fase C · solicitar cambios internos', () => {
  it('rechaza un motivo vacío', async () => {
    const { versionId } = await nuevoBriefEnInternalReview('motivo-vacio');
    const resultado = await solicitarCambiosInternos(director, versionId, '   ');
    expect(resultado.ok).toBe(false);
    if (resultado.ok) return;
    expect(resultado.error.message).toMatch(/motivo/);
  });

  it('el consultor no puede solicitar cambios internos (solo admin/director aprueban internamente)', async () => {
    const { versionId } = await nuevoBriefEnInternalReview('consultor-no-aprueba');
    const resultado = await solicitarCambiosInternos(consultor, versionId, 'Falta revisar el tono');
    expect(resultado.ok).toBe(false);
    if (resultado.ok) return;
    expect(resultado.error.code).toBe('FORBIDDEN_ROLE');
  });

  it('con motivo, devuelve el brief y el motivo queda visible', async () => {
    const { versionId } = await nuevoBriefEnInternalReview('con-motivo');
    const resultado = await solicitarCambiosInternos(
      director,
      versionId,
      'Falta ajustar el tono del mensaje principal.',
    );
    expect(resultado.ok, !resultado.ok ? resultado.error.message : '').toBe(true);

    const [fila] = await query<{ status: string }>(`SELECT status::text FROM brief_versions WHERE id = $1`, [
      versionId,
    ]);
    expect(fila!.status).toBe('internal_changes_requested');

    const devolucion = await motivoDeUltimaDevolucion(versionId);
    expect(devolucion?.motivo).toBe('Falta ajustar el tono del mensaje principal.');
    expect(devolucion?.to).toBe('internal_changes_requested');
  });

  it('permite reenviar a revisión interna tras corregir', async () => {
    const { versionId } = await nuevoBriefEnInternalReview('reenvio');
    await solicitarCambiosInternos(director, versionId, 'Corregir un dato.');
    const resultado = await transicionarBrief(admin, versionId, 'internal_review');
    expect(resultado.ok, !resultado.ok ? resultado.error.message : '').toBe(true);
  });
});

describe('Fase C · aprobación interna', () => {
  it('el cliente no puede aprobar antes de la aprobación interna', async () => {
    const { versionId } = await nuevoBriefEnInternalReview('cliente-antes-de-tiempo');
    // La campaña sigue "interna" (DEC-032 solo la sube al aprobar internamente)
    // — el cliente ni siquiera puede ver que la versión existe todavía.
    const resultado = await aprobarComoCliente(cliente, versionId);
    expect(resultado.ok).toBe(false);
    if (resultado.ok) return;
    expect(resultado.error.code).toBe('RESOURCE_NOT_FOUND');
  });

  it('admin/director aprueban internamente y el brief pasa a client_review', async () => {
    const { versionId } = await nuevoBriefEnInternalReview('aprobacion-interna');
    const resultado = await aprobarInternamente(director, versionId);
    expect(resultado.ok, !resultado.ok ? resultado.error.message : '').toBe(true);

    const [fila] = await query<{ status: string }>(`SELECT status::text FROM brief_versions WHERE id = $1`, [
      versionId,
    ]);
    expect(fila!.status).toBe('client_review');
  });

  it('sube la visibilidad de la campaña a "tcl" al aprobar internamente (DEC-032)', async () => {
    const { campaignId, versionId } = await nuevoBriefEnInternalReview('visibilidad');
    const [antes] = await query<{ visibility: string }>(
      `SELECT visibility::text FROM campaigns WHERE id = $1`,
      [campaignId],
    );
    expect(antes!.visibility).toBe('interna');

    await aprobarInternamente(director, versionId);

    const [despues] = await query<{ visibility: string }>(
      `SELECT visibility::text FROM campaigns WHERE id = $1`,
      [campaignId],
    );
    expect(despues!.visibility).toBe('tcl');
  });
});

describe('Fase D · revisión del cliente', () => {
  async function nuevoBriefEnClientReview(etiqueta: string) {
    const datos = await nuevoBriefEnInternalReview(etiqueta);
    const aprobado = await aprobarInternamente(director, datos.versionId);
    if (!aprobado.ok) throw new Error(`No se pudo llegar a client_review: ${aprobado.error.message}`);
    return datos;
  }

  it('el cliente puede solicitar cambios, con motivo obligatorio', async () => {
    const { versionId } = await nuevoBriefEnClientReview('cliente-solicita');

    const sinMotivo = await solicitarCambiosCliente(cliente, versionId, { motivo: '' });
    expect(sinMotivo.ok).toBe(false);

    const conMotivo = await solicitarCambiosCliente(cliente, versionId, {
      motivo: 'El presupuesto declarado no coincide con lo acordado.',
      camposSenalados: ['practico.presupuesto'],
    });
    expect(conMotivo.ok, !conMotivo.ok ? conMotivo.error.message : '').toBe(true);

    const [fila] = await query<{ status: string }>(`SELECT status::text FROM brief_versions WHERE id = $1`, [
      versionId,
    ]);
    expect(fila!.status).toBe('client_changes_requested');

    const devolucion = await motivoDeUltimaDevolucion(versionId);
    expect(devolucion?.camposSenalados).toEqual(['practico.presupuesto']);
  });

  it('el cliente ve la campaña en su listado tras la aprobación interna (regresión: listCampaigns filtraba por organización del actor)', async () => {
    const { campaignId } = await nuevoBriefEnClientReview('listado-cliente');
    const resultado = await listCampaigns(cliente);
    expect(resultado.ok).toBe(true);
    if (!resultado.ok) return;
    expect(resultado.value.some((c) => c.id === campaignId)).toBe(true);
  });

  it('reingresa correctamente al ciclo interno tras la solicitud del cliente', async () => {
    const { versionId } = await nuevoBriefEnClientReview('reingreso');
    await solicitarCambiosCliente(cliente, versionId, { motivo: 'Ajustar fechas.' });

    const resultado = await transicionarBrief(admin, versionId, 'internal_review');
    expect(resultado.ok, !resultado.ok ? resultado.error.message : '').toBe(true);
  });

  it('el cliente puede aprobar, y approved_at queda persistido', async () => {
    const { versionId } = await nuevoBriefEnClientReview('cliente-aprueba');

    const resultado = await aprobarComoCliente(cliente, versionId);
    expect(resultado.ok, !resultado.ok ? resultado.error.message : '').toBe(true);

    const [fila] = await query<{ status: string; approved_at: Date | null }>(
      `SELECT status::text, approved_at FROM brief_versions WHERE id = $1`,
      [versionId],
    );
    expect(fila!.status).toBe('approved');
    expect(fila!.approved_at).not.toBeNull();
  });

  it('una versión aprobada por el cliente es inmutable', async () => {
    const { versionId } = await nuevoBriefEnClientReview('inmutable');
    await aprobarComoCliente(cliente, versionId);

    const [campo] = await query<{ id: string }>(
      `SELECT id FROM brief_fields WHERE brief_version_id = $1 LIMIT 1`,
      [versionId],
    );
    await expect(
      query(`UPDATE brief_fields SET value = '"hackeado"'::jsonb WHERE id = $1`, [campo!.id]),
    ).rejects.toThrow();
  });

  it('el cliente no puede ejecutar una transición distinta a las suyas (defensa en profundidad)', async () => {
    const { versionId } = await nuevoBriefEnClientReview('transicion-ajena');
    const resultado = await transicionarBrief(cliente, versionId, 'internal_review');
    expect(resultado.ok).toBe(false);
  });

  it('el cliente no accede a una versión cuya campaña sigue "interna" (antes de la aprobación interna)', async () => {
    // La visibilidad de la campaña (DEC-032) es el límite real de acceso del
    // cliente — `canAccessResource` para `cliente` mira `visibility`, no
    // `organizationId` (el cliente es, por definición, de otra organización,
    // DEC-012). Antes de `aprobarInternamente`, la campaña sigue `interna`.
    const { versionId } = await nuevoBriefEnInternalReview('sin-aprobar-aun');
    const resultado = await aprobarComoCliente(cliente, versionId);
    expect(resultado.ok).toBe(false);
    if (resultado.ok) return;
    // El estado tampoco lo permite (BRIEF_INVALID_TRANSITION) — pero antes
    // de eso, la visibilidad ya lo bloquearía por sí sola si el estado sí
    // fuera client_review; ambas capas actúan, ninguna reemplaza a la otra.
    expect(['RESOURCE_NOT_FOUND', 'BRIEF_INVALID_TRANSITION']).toContain(resultado.error.code);
  });
});
