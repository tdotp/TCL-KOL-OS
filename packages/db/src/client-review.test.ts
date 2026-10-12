/**
 * Ciclo de revisión y cierre del brief — decisiones exclusivas de SmartPR.
 *
 * `solicitarCambiosInternos` / `aprobarBrief`, envoltorios de
 * `transicionarBrief` (`packages/db/src/transitions.ts`). Corrección del
 * workflow cliente: el cliente es de solo lectura (no aprueba, no pide
 * cambios) y `client_review` / `client_changes_requested` son estados
 * heredados — nada nuevo entra a ellos, pero una versión persistida allí
 * puede cerrarse o retomarse. `campaigns.visibility` sube a `tcl` al
 * aprobar, para que el cliente pueda leer la campaña.
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
import { aprobarBrief, solicitarCambiosInternos } from './client-review.ts';
import { motivoDeUltimaDevolucion } from './transitions.ts';
import { listCampaigns } from './campaigns.ts';
import { listarCampanasParaTcl } from './tcl-projection.ts';

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

describe('aprobación del brief por SmartPR', () => {
  it('admin y director aprueban; el brief queda approved con approved_at', async () => {
    const { versionId } = await nuevoBriefEnInternalReview('aprobacion-director');
    const resultado = await aprobarBrief(director, versionId);
    expect(resultado.ok, !resultado.ok ? resultado.error.message : '').toBe(true);

    const [fila] = await query<{ status: string; approved_at: Date | null }>(
      `SELECT status::text, approved_at FROM brief_versions WHERE id = $1`,
      [versionId],
    );
    expect(fila!.status).toBe('approved');
    expect(fila!.approved_at).not.toBeNull();

    const { versionId: otra } = await nuevoBriefEnInternalReview('aprobacion-admin');
    expect((await aprobarBrief(admin, otra)).ok).toBe(true);
  });

  it('el consultor no puede aprobar', async () => {
    const { versionId } = await nuevoBriefEnInternalReview('consultor-no-aprueba-brief');
    const resultado = await aprobarBrief(consultor, versionId);
    expect(resultado.ok).toBe(false);
    if (resultado.ok) return;
    expect(resultado.error.code).toBe('FORBIDDEN_ROLE');
  });

  it('no se puede aprobar desde draft: hace falta pasar por revisión interna', async () => {
    const campaignId = await nuevaCampanaPropia('aprobar-desde-draft');
    const creado = await crearBriefManual(admin, campaignId);
    if (!creado.ok) throw new Error(creado.error.message);
    const resultado = await aprobarBrief(admin, creado.value.versionId);
    expect(resultado.ok).toBe(false);
    if (resultado.ok) return;
    expect(resultado.error.code).toBe('BRIEF_INVALID_TRANSITION');
  });

  it('sube la visibilidad de la campaña a "tcl" al aprobar (el cliente puede leerla)', async () => {
    const { campaignId, versionId } = await nuevoBriefEnInternalReview('visibilidad');
    const [antes] = await query<{ visibility: string }>(
      `SELECT visibility::text FROM campaigns WHERE id = $1`,
      [campaignId],
    );
    expect(antes!.visibility).toBe('interna');

    await aprobarBrief(director, versionId);

    const [despues] = await query<{ visibility: string }>(
      `SELECT visibility::text FROM campaigns WHERE id = $1`,
      [campaignId],
    );
    expect(despues!.visibility).toBe('tcl');

    // V2 · Fase 9: el cliente ve la campaña por la proyección TCL (ya no por `listCampaigns`: sin `campaign:read`).
    const listado = await listarCampanasParaTcl(cliente);
    expect(listado.ok).toBe(true);
    if (!listado.ok) return;
    expect(listado.value.some((c) => c.id === campaignId)).toBe(true);
    expect((await listCampaigns(cliente)).ok).toBe(false);
  });

  it('antes de la aprobación el cliente no ve la campaña', async () => {
    const { campaignId } = await nuevoBriefEnInternalReview('cliente-no-ve-antes');
    const listado = await listarCampanasParaTcl(cliente);
    expect(listado.ok).toBe(true);
    if (!listado.ok) return;
    expect(listado.value.some((c) => c.id === campaignId)).toBe(false);
  });

  it('una versión aprobada es inmutable', async () => {
    const { versionId } = await nuevoBriefEnInternalReview('inmutable');
    await aprobarBrief(director, versionId);
    const [campo] = await query<{ id: string }>(
      `SELECT id FROM brief_fields WHERE brief_version_id = $1 LIMIT 1`,
      [versionId],
    );
    await expect(
      query(`UPDATE brief_fields SET value = '"hackeado"'::jsonb WHERE id = $1`, [campo!.id]),
    ).rejects.toThrow();
  });
});

describe('cliente read-only: ninguna mutación de brief ni workflow', () => {
  it('el cliente no puede ejecutar ninguna transición, aunque la campaña ya sea visible para él', async () => {
    const { versionId } = await nuevoBriefEnInternalReview('cliente-sin-transiciones');
    // Estado heredado con la campaña ya visible para el cliente (peor caso).
    await query(`UPDATE brief_versions SET status = 'client_review' WHERE id = $1`, [versionId]);
    await query(
      `UPDATE campaigns SET visibility = 'tcl' WHERE id = (SELECT campaign_id FROM briefs WHERE id = (SELECT brief_id FROM brief_versions WHERE id = $1))`,
      [versionId],
    );

    const destinos = [
      'internal_review',
      'internal_changes_requested',
      'client_changes_requested',
      'approved',
      'cancelled',
    ] as const;
    for (const to of destinos) {
      const resultado = await transicionarBrief(cliente, versionId, to, { motivo: 'intento del cliente' });
      expect(resultado.ok, `el cliente logró → ${to}`).toBe(false);
    }
    const [fila] = await query<{ status: string }>(`SELECT status::text FROM brief_versions WHERE id = $1`, [
      versionId,
    ]);
    expect(fila!.status).toBe('client_review');
  });

  it('aprobarBrief y solicitarCambiosInternos fallan con FORBIDDEN_ROLE para el cliente', async () => {
    const { versionId } = await nuevoBriefEnInternalReview('cliente-forbidden');
    for (const r of [
      await aprobarBrief(cliente, versionId),
      await solicitarCambiosInternos(cliente, versionId, 'intento'),
    ]) {
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('FORBIDDEN_ROLE');
    }
  });

  it('nada nuevo entra a client_review ni a client_changes_requested', async () => {
    const { versionId } = await nuevoBriefEnInternalReview('sin-nuevos-legacy');
    for (const to of ['client_review', 'client_changes_requested'] as const) {
      const resultado = await transicionarBrief(admin, versionId, to, { motivo: 'intento' });
      expect(resultado.ok, `entró a ${to}`).toBe(false);
      if (!resultado.ok) expect(resultado.error.code).toBe('BRIEF_INVALID_TRANSITION');
    }
  });
});

describe('estados legacy persistidos antes de la corrección', () => {
  async function versionLegacy(etiqueta: string, estado: 'client_review' | 'client_changes_requested') {
    const datos = await nuevoBriefEnInternalReview(etiqueta);
    await query(`UPDATE brief_versions SET status = $1::brief_status WHERE id = $2`, [
      estado,
      datos.versionId,
    ]);
    await query(`UPDATE campaigns SET visibility = 'tcl' WHERE id = $1`, [datos.campaignId]);
    return datos;
  }

  it('client_review legacy: Dirección la aprueba y queda congelada', async () => {
    const { versionId } = await versionLegacy('legacy-review-aprueba', 'client_review');
    const resultado = await aprobarBrief(director, versionId);
    expect(resultado.ok, !resultado.ok ? resultado.error.message : '').toBe(true);
    const [fila] = await query<{ status: string; approved_at: Date | null }>(
      `SELECT status::text, approved_at FROM brief_versions WHERE id = $1`,
      [versionId],
    );
    expect(fila!.status).toBe('approved');
    expect(fila!.approved_at).not.toBeNull();
  });

  it('client_review legacy: el consultor no la cierra, pero Dirección puede devolverla a internal_review', async () => {
    const { versionId } = await versionLegacy('legacy-review-devuelve', 'client_review');
    expect((await aprobarBrief(consultor, versionId)).ok).toBe(false);
    expect((await transicionarBrief(consultor, versionId, 'internal_review')).ok).toBe(false);
    const resultado = await transicionarBrief(director, versionId, 'internal_review');
    expect(resultado.ok, !resultado.ok ? resultado.error.message : '').toBe(true);
  });

  it('client_changes_requested legacy: SmartPR la retoma hacia internal_review', async () => {
    const { versionId } = await versionLegacy('legacy-cambios-retoma', 'client_changes_requested');
    const resultado = await transicionarBrief(consultor, versionId, 'internal_review');
    expect(resultado.ok, !resultado.ok ? resultado.error.message : '').toBe(true);
  });

  it('el motivo histórico de una devolución del cliente sigue siendo legible', async () => {
    const { versionId } = await versionLegacy('legacy-motivo-historico', 'client_changes_requested');
    await query(
      `INSERT INTO audit_events (actor_id, organization_id, action, entity_type, entity_id, metadata)
       SELECT $1, organization_id, 'brief.transition', 'brief_version', id,
              '{"from":"client_review","to":"client_changes_requested","motivo":"Ajustar fechas.","camposSenalados":["practico.presupuesto"]}'::jsonb
         FROM brief_versions WHERE id = $2`,
      [userId, versionId],
    );
    const devolucion = await motivoDeUltimaDevolucion(versionId);
    expect(devolucion?.motivo).toBe('Ajustar fechas.');
    expect(devolucion?.to).toBe('client_changes_requested');
  });
});
