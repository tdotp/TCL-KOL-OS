/**
 * V2 · Fase 6 — `actualizarCampana`: el único caso de uso nuevo de campaña
 * (nombre y fechas), con el canal y la correlación de quien lo invoca.
 *
 * Campañas propias y desechables (INC-001A).
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { User } from '@tcl-kol-os/domain';
import { closePool, query } from './client.ts';
import { asegurarUsuarioDePrueba, eliminarCampanaDePrueba } from './test-utils.ts';
import { findUserByEmail } from './users.ts';
import { actualizarCampana, archiveCampaign, getCampaign } from './campaigns.ts';

let admin: User;
let director: User;
let consultor: User;
let operativo: User;
let cliente: User;
let ajeno: User;
const campanas: string[] = [];

async function nuevaCampana(
  etiqueta: string,
  fechas: { inicio?: string; fin?: string } = {},
  owner: User = admin,
): Promise<string> {
  const [c] = await query<{ id: string }>(
    `INSERT INTO campaigns (organization_id, name, owner_id, created_by, start_date, end_date)
     VALUES ($1, $2, $3, $3, $4, $5) RETURNING id`,
    [
      owner.organizationId,
      `Actualizar · ${etiqueta} · ${Date.now()}`,
      owner.id,
      fechas.inicio ?? null,
      fechas.fin ?? null,
    ],
  );
  campanas.push(c!.id);
  return c!.id;
}

async function fila(id: string) {
  const [f] = await query<{
    name: string;
    start_date: string | null;
    end_date: string | null;
    status: string;
    visibility: string;
    owner_id: string;
    market: string;
  }>(
    `SELECT name, to_char(start_date, 'YYYY-MM-DD') AS start_date, to_char(end_date, 'YYYY-MM-DD') AS end_date,
            status::text, visibility::text, owner_id, market
       FROM campaigns WHERE id = $1`,
    [id],
  );
  return f!;
}

async function eventos(id: string) {
  return query<{
    action: string;
    origin: string;
    actor_id: string | null;
    correlation: Record<string, string> | null;
    metadata: { cambios: string[]; antes: Record<string, unknown>; despues: Record<string, unknown> };
  }>(
    `SELECT action, origin, actor_id, correlation, metadata FROM audit_events
      WHERE entity_type = 'campaign' AND entity_id = $1 AND action = 'campaign.update' ORDER BY created_at, id`,
    [id],
  );
}

beforeAll(async () => {
  admin = (await findUserByEmail('gerardo@smartpr.co'))!;
  director = (await findUserByEmail('director@smartpr.co'))!;
  consultor = (await findUserByEmail('consultor@smartpr.co'))!;
  cliente = (await findUserByEmail('marena@tcl.com'))!;
  ajeno = (await findUserByEmail('ajeno@otraagencia.co'))!;
  operativo = await asegurarUsuarioDePrueba(
    'operativo@smartpr.co',
    'Usuario Operativo',
    'operativo',
    admin.organizationId,
  );
});

afterAll(async () => {
  await eliminarCampanaDePrueba(campanas);
  await closePool();
});

describe('actualizarCampana', () => {
  it('cambia nombre y fechas, y audita UNA vez con el antes y el después (origen ui por defecto)', async () => {
    const id = await nuevaCampana('feliz', { inicio: '2026-11-01', fin: '2026-11-30' });
    const r = await actualizarCampana(consultor, id, {
      name: '  Nombre nuevo  ',
      startDate: '2026-11-05',
      endDate: '2026-12-15',
    });
    expect(r.ok, !r.ok ? r.error.message : '').toBe(true);
    if (!r.ok) return;
    expect(r.value.cambios).toEqual(['name', 'startDate', 'endDate']);
    expect(await fila(id)).toMatchObject({
      name: 'Nombre nuevo',
      start_date: '2026-11-05',
      end_date: '2026-12-15',
    });
    const ev = await eventos(id);
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ origin: 'ui', actor_id: consultor.id, correlation: null });
    expect(ev[0]!.metadata.antes).toMatchObject({ startDate: '2026-11-01', endDate: '2026-11-30' });
    expect(ev[0]!.metadata.despues).toMatchObject({ name: 'Nombre nuevo', startDate: '2026-11-05' });
  });

  it('desde el chat: el evento queda con origen chat y la correlación completa', async () => {
    const id = await nuevaCampana('chat');
    const r = await actualizarCampana(
      consultor,
      id,
      { startDate: '2026-12-01' },
      { origin: 'chat', correlation: { conversationId: 'conv-9', messageId: 'msg-9', agentRunId: 'run-9' } },
    );
    expect(r.ok).toBe(true);
    const [ev] = await eventos(id);
    expect(ev).toMatchObject({ origin: 'chat', actor_id: consultor.id });
    expect(ev!.correlation).toMatchObject({
      conversationId: 'conv-9',
      messageId: 'msg-9',
      agentRunId: 'run-9',
    });
  });

  it('un origen system para una persona se rechaza antes de tocar nada', async () => {
    const id = await nuevaCampana('system');
    const r = await actualizarCampana(consultor, id, { name: 'X' }, { origin: 'system' });
    expect(r.ok).toBe(false);
    expect((await fila(id)).name).not.toBe('X');
    expect(await eventos(id)).toHaveLength(0);
  });

  it('sin cambios reales no escribe ni audita (idempotente)', async () => {
    const id = await nuevaCampana('idempotente', { inicio: '2026-11-01', fin: '2026-11-30' });
    const nombre = (await fila(id)).name;
    const r = await actualizarCampana(admin, id, { name: nombre, startDate: '2026-11-01' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.cambios).toEqual([]);
    expect(await eventos(id)).toHaveLength(0);
  });

  it('las fechas se validan mezclando lo enviado con lo vigente (error accionable, no un 23514 crudo)', async () => {
    const id = await nuevaCampana('fechas', { inicio: '2026-11-10', fin: '2026-11-20' });
    for (const input of [
      { endDate: '2026-11-01' }, // fin antes del inicio vigente
      { startDate: '2026-12-01' }, // inicio después del fin vigente
      { startDate: '2026-12-01', endDate: '2026-11-30' },
    ]) {
      const r = await actualizarCampana(admin, id, input);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('VALIDATION_FAILED');
    }
    expect(await fila(id)).toMatchObject({ start_date: '2026-11-10', end_date: '2026-11-20' });
    // Mover el rango completo a la vez sí es coherente.
    expect((await actualizarCampana(admin, id, { startDate: '2027-01-01', endDate: '2027-01-31' })).ok).toBe(
      true,
    );
  });

  it('formato de fecha y nombre inválidos; nada que actualizar; null borra una fecha', async () => {
    const id = await nuevaCampana('formato', { inicio: '2026-11-10', fin: '2026-11-20' });
    for (const input of [
      { startDate: '10/11/2026' },
      { startDate: '2026-02-30' },
      { endDate: '2026-13-01' },
      { name: '   ' },
      { name: 'x'.repeat(201) },
      {},
    ]) {
      const r = await actualizarCampana(admin, id, input);
      expect(r.ok, JSON.stringify(input)).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('VALIDATION_FAILED');
    }
    expect((await actualizarCampana(admin, id, { endDate: null })).ok).toBe(true);
    expect(await fila(id)).toMatchObject({ start_date: '2026-11-10', end_date: null });
  });

  it('no toca estado, visibilidad, responsable ni mercado', async () => {
    const id = await nuevaCampana('intocable');
    const antes = await fila(id);
    await actualizarCampana(admin, id, { name: 'Solo el nombre' });
    const despues = await fila(id);
    expect({ ...despues, name: antes.name }).toEqual(antes);
  });

  it('una campaña archivada no se edita', async () => {
    const id = await nuevaCampana('archivada');
    expect((await archiveCampaign(admin, id)).ok).toBe(true);
    const r = await actualizarCampana(admin, id, { name: 'Tarde' });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('RESOURCE_CONFLICT');
      expect(r.error.details).toMatchObject({ reason: 'campaign_not_active' });
    }
    expect((await fila(id)).name).not.toBe('Tarde');
  });

  it('permisos: admin, director y consultor sí; operativo y cliente no; otra organización no la ve', async () => {
    const id = await nuevaCampana('permisos');
    for (const actor of [admin, director, consultor]) {
      const r = await actualizarCampana(actor, id, { name: `Por ${actor.role}` });
      expect(r.ok, actor.role).toBe(true);
    }
    const operativoR = await actualizarCampana(operativo, id, { name: 'Operativo' });
    expect(operativoR.ok).toBe(false);
    if (!operativoR.ok) expect(operativoR.error.code).toBe('FORBIDDEN_ROLE');
    // El cliente es de otra organización (DEC-012): ni la ve ni la edita.
    expect((await actualizarCampana(cliente, id, { name: 'Cliente' })).ok).toBe(false);
    // Otra agencia: el recurso no existe para ella.
    const ajenaR = await actualizarCampana(ajeno, id, { name: 'Ajeno' });
    expect(ajenaR.ok).toBe(false);
    if (!ajenaR.ok) expect(ajenaR.error.code).toBe('RESOURCE_NOT_FOUND');
    expect((await fila(id)).name).toBe('Por consultor');
    // Una campaña inexistente se responde igual.
    const inexistente = await actualizarCampana(admin, '00000000-0000-4000-8000-000000000000', { name: 'x' });
    expect(inexistente.ok).toBe(false);
    if (!inexistente.ok) expect(inexistente.error.code).toBe('RESOURCE_NOT_FOUND');
  });

  it('el resultado se refleja en getCampaign', async () => {
    const id = await nuevaCampana('lectura');
    await actualizarCampana(admin, id, { name: 'Leída', endDate: '2027-02-01' });
    const g = await getCampaign(admin, id);
    expect(g.ok).toBe(true);
    if (g.ok) expect(g.value.campaign.name).toBe('Leída');
  });
});
