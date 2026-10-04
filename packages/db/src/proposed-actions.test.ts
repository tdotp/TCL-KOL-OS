/**
 * V2 · Fase 1D — human-in-the-loop verificable en servidor.
 *
 *   intención → acción propuesta → control visible → confirmación humana → ejecución
 *
 * El primer caso real es la aprobación del brief. La aprobación directa de una
 * persona en la interfaz (aprobarBrief) sigue funcionando; lo que no puede
 * hacerse es aprobar desde el chat o el sistema sin pasar por una acción
 * propuesta que un humano autorizado confirme.
 *
 * Campañas propias y desechables (INC-001A).
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { User } from '@tcl-kol-os/domain';
import { closePool, getPool, query } from './client.ts';
import { asegurarUsuarioDePrueba, eliminarCampanaDePrueba } from './test-utils.ts';
import { findUserByEmail } from './users.ts';
import { crearBriefManual } from './manual.ts';
import { aprobarBrief } from './client-review.ts';
import { transicionarBrief, transicionarBriefEnTransaccion } from './transitions.ts';
import { corregirCampo } from './brief-fields.ts';
import {
  cancelarAccion,
  confirmarAccion,
  ejecutarAccion,
  huellaDeAccion,
  obtenerAccionPropuesta,
  proponerAccion,
  vencerAccionesCaducadas,
} from './proposed-actions.ts';

let admin: User;
let director: User;
let consultor: User;
let cliente: User;
let operativo: User;
let ajeno: User;
const campanas: string[] = [];

async function nuevaVersionEnRevision(etiqueta: string): Promise<{ campaignId: string; versionId: string }> {
  const [c] = await query<{ id: string }>(
    `INSERT INTO campaigns (organization_id, name, owner_id, created_by)
     VALUES ($1, $2, $3, $3) RETURNING id`,
    [admin.organizationId, `HITL · ${etiqueta} · ${Date.now()}`, admin.id],
  );
  campanas.push(c!.id);
  const creado = await crearBriefManual(admin, c!.id);
  if (!creado.ok) throw new Error(creado.error.message);
  await query(`UPDATE brief_versions SET status = 'internal_review' WHERE id = $1`, [creado.value.versionId]);
  return { campaignId: c!.id, versionId: creado.value.versionId };
}

async function estadoDe(versionId: string): Promise<string> {
  const [f] = await query<{ status: string }>(`SELECT status::text FROM brief_versions WHERE id = $1`, [
    versionId,
  ]);
  return f!.status;
}

async function estadoDeAccion(id: string): Promise<string> {
  const [f] = await query<{ status: string }>(`SELECT status FROM proposed_actions WHERE id = $1`, [id]);
  return f!.status;
}

/** Propuesta de aprobación hecha por el agente (chat) en nombre de un consultor. */
async function proponer(versionId: string, extra: Partial<Parameters<typeof proponerAccion>[1]> = {}) {
  const r = await proponerAccion(consultor, {
    type: 'brief.approve',
    resourceId: versionId,
    origin: 'chat',
    correlation: { conversationId: 'conv-1', messageId: 'msg-1' },
    ...extra,
  });
  if (!r.ok) throw new Error(`No se pudo proponer: ${r.error.message}`);
  return r.value;
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

// ─────────────────────────── La frontera del canal ─────────────────────────────

describe('quién NO puede aprobar', () => {
  it('system no puede aprobar', async () => {
    const { versionId } = await nuevaVersionEnRevision('system');
    const r = await transicionarBrief('system', versionId, 'approved');
    expect(r.ok).toBe(false);
    expect(await estadoDe(versionId)).toBe('internal_review');
  });

  it('el canal chat no aprueba aunque la persona tenga permiso («actuar como el usuario»)', async () => {
    const { versionId } = await nuevaVersionEnRevision('chat-directo');
    for (const r of [
      await aprobarBrief(director, versionId, { origen: 'chat' }),
      await transicionarBrief(director, versionId, 'approved', { origen: 'chat' }),
      await transicionarBrief(director, versionId, 'approved', { origen: 'system' }),
    ]) {
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('HUMAN_CONFIRMATION_REQUIRED');
    }
    expect(await estadoDe(versionId)).toBe('internal_review');
  });

  it('cliente, operativo y consultor no aprueban (ni directo ni confirmando)', async () => {
    const { versionId } = await nuevaVersionEnRevision('sin-permiso');
    const propuesta = await proponer(versionId);
    for (const actor of [cliente, operativo, consultor]) {
      expect((await aprobarBrief(actor, versionId)).ok, `${actor.role} aprobó`).toBe(false);
      const c = await confirmarAccion(actor, propuesta.id, {
        canal: 'ui',
        payloadHash: propuesta.payloadHash,
      });
      expect(c.ok, `${actor.role} confirmó`).toBe(false);
    }
    expect(await estadoDe(versionId)).toBe('internal_review');
    expect(await estadoDeAccion(propuesta.id)).toBe('pending');
  });

  it('cliente y operativo ni siquiera proponen', async () => {
    const { versionId } = await nuevaVersionEnRevision('no-proponen');
    for (const actor of [cliente, operativo]) {
      const r = await proponerAccion(actor, { type: 'brief.approve', resourceId: versionId });
      expect(r.ok, actor.role).toBe(false);
    }
  });

  it('la aprobación directa de una persona en la interfaz sigue funcionando', async () => {
    const { versionId } = await nuevaVersionEnRevision('directa');
    const r = await aprobarBrief(director, versionId);
    expect(r.ok, !r.ok ? r.error.message : '').toBe(true);
    expect(await estadoDe(versionId)).toBe('approved');
  });
});

// ─────────────────────────── Flujo propuesta → confirmación → ejecución ───────

describe('flujo completo', () => {
  it('una propuesta pendiente NO ejecuta nada', async () => {
    const { versionId } = await nuevaVersionEnRevision('pendiente');
    const propuesta = await proponer(versionId);
    expect(propuesta.status).toBe('pending');
    expect(propuesta.proposedOrigin).toBe('chat');

    const r = await ejecutarAccion(director, propuesta.id, { canal: 'ui' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('PROPOSAL_INVALID_STATE');
    expect(await estadoDe(versionId)).toBe('internal_review');
  });

  it('system y el canal chat no confirman su propia acción', async () => {
    const { versionId } = await nuevaVersionEnRevision('autoconfirmacion');
    const propuesta = await proponer(versionId);
    for (const r of [
      await confirmarAccion('system', propuesta.id, { canal: 'ui', payloadHash: propuesta.payloadHash }),
      await confirmarAccion(director, propuesta.id, { canal: 'chat', payloadHash: propuesta.payloadHash }),
      await confirmarAccion(director, propuesta.id, { canal: 'system', payloadHash: propuesta.payloadHash }),
    ]) {
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('HUMAN_CONFIRMATION_REQUIRED');
    }
    expect(await estadoDeAccion(propuesta.id)).toBe('pending');
  });

  it('propuesta del agente, confirmada y ejecutada por un humano autorizado: aprueba y queda inmutable', async () => {
    const { versionId } = await nuevaVersionEnRevision('feliz');
    const propuesta = await proponer(versionId);

    const confirmada = await confirmarAccion(director, propuesta.id, {
      canal: 'ui',
      payloadHash: propuesta.payloadHash,
    });
    expect(confirmada.ok, !confirmada.ok ? confirmada.error.message : '').toBe(true);
    if (!confirmada.ok) return;
    expect(confirmada.value.status).toBe('confirmed');
    expect(confirmada.value.confirmedBy).toBe(director.id);
    // Confirmar no aprueba todavía.
    expect(await estadoDe(versionId)).toBe('internal_review');

    const ejecutada = await ejecutarAccion(director, propuesta.id, { canal: 'ui' });
    expect(ejecutada.ok, !ejecutada.ok ? ejecutada.error.message : '').toBe(true);
    if (!ejecutada.ok) return;
    expect(ejecutada.value.status).toBe('executed');
    expect(await estadoDe(versionId)).toBe('approved');

    // Inmutabilidad actual del brief aprobado, intacta.
    const [campo] = await query<{ id: string }>(
      `SELECT id FROM brief_fields WHERE brief_version_id = $1 LIMIT 1`,
      [versionId],
    );
    await expect(
      query(`UPDATE brief_fields SET value = '"hackeado"'::jsonb WHERE id = $1`, [campo!.id]),
    ).rejects.toThrow();
    const edicion = await corregirCampo(admin, versionId, campo!.id, { value: 'x', revisionEsperada: 0 });
    expect(edicion.ok).toBe(false);
  });

  it('una acción ejecutada no puede repetirse (replay)', async () => {
    const { versionId } = await nuevaVersionEnRevision('replay');
    const propuesta = await proponer(versionId);
    await confirmarAccion(director, propuesta.id, { canal: 'ui', payloadHash: propuesta.payloadHash });
    expect((await ejecutarAccion(director, propuesta.id, { canal: 'ui' })).ok).toBe(true);

    for (const r of [
      await ejecutarAccion(director, propuesta.id, { canal: 'ui' }),
      await confirmarAccion(director, propuesta.id, { canal: 'ui', payloadHash: propuesta.payloadHash }),
    ]) {
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('PROPOSAL_INVALID_STATE');
    }
  });

  it('dos ejecuciones simultáneas: solo una procede', async () => {
    const { versionId } = await nuevaVersionEnRevision('concurrencia');
    const propuesta = await proponer(versionId);
    await confirmarAccion(director, propuesta.id, { canal: 'ui', payloadHash: propuesta.payloadHash });
    const [a, b] = await Promise.all([
      ejecutarAccion(director, propuesta.id, { canal: 'ui' }),
      ejecutarAccion(director, propuesta.id, { canal: 'ui' }),
    ]);
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
    const [conteo] = await query<{ n: string }>(
      `SELECT count(*)::text AS n FROM audit_events WHERE entity_id = $1 AND action = 'proposed_action.execute'`,
      [propuesta.id],
    );
    expect(conteo!.n).toBe('1');
  });

  it('solo la persona que confirmó puede ejecutar', async () => {
    const { versionId } = await nuevaVersionEnRevision('otro-ejecutor');
    const propuesta = await proponer(versionId);
    await confirmarAccion(director, propuesta.id, { canal: 'ui', payloadHash: propuesta.payloadHash });
    const r = await ejecutarAccion(admin, propuesta.id, { canal: 'ui' });
    expect(r.ok).toBe(false);
    expect(await estadoDe(versionId)).toBe('internal_review');
  });

  it('una acción asignada solo la confirma la persona asignada', async () => {
    const { versionId } = await nuevaVersionEnRevision('asignada');
    const propuesta = await proponer(versionId, { assignedTo: director.id });
    const r = await confirmarAccion(admin, propuesta.id, { canal: 'ui', payloadHash: propuesta.payloadHash });
    expect(r.ok).toBe(false);
    expect(
      (await confirmarAccion(director, propuesta.id, { canal: 'ui', payloadHash: propuesta.payloadHash })).ok,
    ).toBe(true);
  });

  it('si una guarda del dominio impide aprobar, la acción NO queda ejecutada', async () => {
    const { versionId } = await nuevaVersionEnRevision('guarda');
    const propuesta = await proponer(versionId);
    await confirmarAccion(director, propuesta.id, { canal: 'ui', payloadHash: propuesta.payloadHash });
    // Pregunta crítica pendiente: la guarda de aprobación debe bloquear.
    const [campo] = await query<{ key: string }>(
      `SELECT key FROM brief_fields WHERE brief_version_id = $1 LIMIT 1`,
      [versionId],
    );
    await query(
      `INSERT INTO local_questions (campaign_id, brief_version_id, key, question, reason, criticidad, status)
       SELECT b.campaign_id, v.id, $2, '¿?', 'prueba', 'critico', 'pendiente'
         FROM brief_versions v JOIN briefs b ON b.id = v.brief_id WHERE v.id = $1`,
      [versionId, campo!.key],
    );
    const r = await ejecutarAccion(director, propuesta.id, { canal: 'ui' });
    expect(r.ok).toBe(false);
    expect(await estadoDe(versionId)).toBe('internal_review');
    expect(await estadoDeAccion(propuesta.id)).toBe('confirmed');
  });
});

// ─────────────────────────── Cancelada, vencida, alterada ─────────────────────

describe('estados que no ejecutan', () => {
  it('una acción cancelada no confirma ni ejecuta', async () => {
    const { versionId } = await nuevaVersionEnRevision('cancelada');
    const propuesta = await proponer(versionId);
    expect((await cancelarAccion(consultor, propuesta.id)).ok).toBe(true);
    expect(await estadoDeAccion(propuesta.id)).toBe('cancelled');
    for (const r of [
      await confirmarAccion(director, propuesta.id, { canal: 'ui', payloadHash: propuesta.payloadHash }),
      await ejecutarAccion(director, propuesta.id, { canal: 'ui' }),
    ]) {
      expect(r.ok).toBe(false);
    }
    expect(await estadoDe(versionId)).toBe('internal_review');
  });

  it('una acción confirmada también puede cancelarse antes de ejecutarse', async () => {
    const { versionId } = await nuevaVersionEnRevision('cancelada-confirmada');
    const propuesta = await proponer(versionId);
    await confirmarAccion(director, propuesta.id, { canal: 'ui', payloadHash: propuesta.payloadHash });
    expect((await cancelarAccion(director, propuesta.id)).ok).toBe(true);
    expect((await ejecutarAccion(director, propuesta.id, { canal: 'ui' })).ok).toBe(false);
    expect(await estadoDe(versionId)).toBe('internal_review');
  });

  it('una acción vencida no confirma ni ejecuta, y queda registrada como expirada', async () => {
    const { versionId } = await nuevaVersionEnRevision('vencida');
    const propuesta = await proponer(versionId, { ttlSegundos: 1 });
    await new Promise((resolve) => setTimeout(resolve, 1200));

    const r = await confirmarAccion(director, propuesta.id, {
      canal: 'ui',
      payloadHash: propuesta.payloadHash,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('PROPOSAL_EXPIRED');
    expect(await estadoDeAccion(propuesta.id)).toBe('expired');
    expect((await ejecutarAccion(director, propuesta.id, { canal: 'ui' })).ok).toBe(false);
    expect(await estadoDe(versionId)).toBe('internal_review');
  });

  it('el barrido marca como vencidas las caducadas', async () => {
    const { versionId } = await nuevaVersionEnRevision('barrido');
    const propuesta = await proponer(versionId, { ttlSegundos: 1 });
    await new Promise((resolve) => setTimeout(resolve, 1200));
    expect(await vencerAccionesCaducadas()).toBeGreaterThanOrEqual(1);
    expect(await estadoDeAccion(propuesta.id)).toBe('expired');
  });

  it('una confirmación con otra huella (payload modificado) falla', async () => {
    const { versionId } = await nuevaVersionEnRevision('huella');
    const propuesta = await proponer(versionId);
    const otraHuella = huellaDeAccion('brief.approve', 'brief_version', versionId, { versionId, otro: true });
    const r = await confirmarAccion(director, propuesta.id, { canal: 'ui', payloadHash: otraHuella });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('PROPOSAL_STALE');
    expect(await estadoDeAccion(propuesta.id)).toBe('pending');
  });

  it('el contenido de una propuesta es inmutable en la base (payload, recurso, huella)', async () => {
    const { versionId } = await nuevaVersionEnRevision('inmutable');
    const propuesta = await proponer(versionId);
    for (const sql of [
      `UPDATE proposed_actions SET payload = '{"versionId":"x"}'::jsonb WHERE id = $1`,
      `UPDATE proposed_actions SET payload_hash = 'otra' WHERE id = $1`,
      `UPDATE proposed_actions SET resource_id = uuid_generate_v4() WHERE id = $1`,
      `UPDATE proposed_actions SET expires_at = now() + interval '9 days' WHERE id = $1`,
      `DELETE FROM proposed_actions WHERE id = $1`,
    ]) {
      await expect(query(sql, [propuesta.id])).rejects.toThrow();
    }
  });

  it('un estado terminal no se reabre ni se salta un paso en la base', async () => {
    const { versionId } = await nuevaVersionEnRevision('saltos');
    const propuesta = await proponer(versionId);
    // pending → executed sin confirmar: prohibido.
    await expect(
      query(`UPDATE proposed_actions SET status = 'executed', executed_at = now() WHERE id = $1`, [
        propuesta.id,
      ]),
    ).rejects.toThrow();
    await cancelarAccion(consultor, propuesta.id);
    await expect(
      query(`UPDATE proposed_actions SET status = 'pending' WHERE id = $1`, [propuesta.id]),
    ).rejects.toThrow();
  });

  it('si el brief cambia después de proponer, la confirmación falla (estaría aprobando otra cosa)', async () => {
    const { versionId } = await nuevaVersionEnRevision('contenido-cambia');
    const propuesta = await proponer(versionId);
    const [campo] = await query<{ id: string; revision: number }>(
      `SELECT id, revision FROM brief_fields WHERE brief_version_id = $1 LIMIT 1`,
      [versionId],
    );
    const edicion = await corregirCampo(admin, versionId, campo!.id, {
      value: 'Un valor nuevo',
      revisionEsperada: campo!.revision,
    });
    expect(edicion.ok, !edicion.ok ? edicion.error.message : '').toBe(true);

    const r = await confirmarAccion(director, propuesta.id, {
      canal: 'ui',
      payloadHash: propuesta.payloadHash,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('PROPOSAL_STALE');
    expect(await estadoDe(versionId)).toBe('internal_review');
  });

  it('si el contenido cambia entre confirmar y ejecutar, la ejecución falla', async () => {
    const { versionId } = await nuevaVersionEnRevision('cambia-tras-confirmar');
    const propuesta = await proponer(versionId);
    await confirmarAccion(director, propuesta.id, { canal: 'ui', payloadHash: propuesta.payloadHash });
    const [campo] = await query<{ id: string; revision: number }>(
      `SELECT id, revision FROM brief_fields WHERE brief_version_id = $1 LIMIT 1`,
      [versionId],
    );
    await corregirCampo(admin, versionId, campo!.id, {
      value: 'Cambio tardío',
      revisionEsperada: campo!.revision,
    });
    const r = await ejecutarAccion(director, propuesta.id, { canal: 'ui' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('PROPOSAL_STALE');
    expect(await estadoDe(versionId)).toBe('internal_review');
  });
});

// ─────────────────────────── Propuestas, idempotencia y aislamiento ───────────

describe('propuestas', () => {
  it('proponer es idempotente: la misma propuesta abierta se reutiliza', async () => {
    const { versionId } = await nuevaVersionEnRevision('idempotente');
    const a = await proponer(versionId);
    const b = await proponer(versionId);
    expect(b.id).toBe(a.id);
  });

  it('no se propone aprobar una versión que no admite la transición', async () => {
    const [c] = await query<{ id: string }>(
      `INSERT INTO campaigns (organization_id, name, owner_id, created_by)
       VALUES ($1, $2, $3, $3) RETURNING id`,
      [admin.organizationId, `HITL · borrador · ${Date.now()}`, admin.id],
    );
    campanas.push(c!.id);
    const creado = await crearBriefManual(admin, c!.id);
    if (!creado.ok) throw new Error(creado.error.message);
    const r = await proponerAccion(consultor, { type: 'brief.approve', resourceId: creado.value.versionId });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('BRIEF_INVALID_TRANSITION');
  });

  it('el sistema puede proponer (el agente prepara) pero no confirmar', async () => {
    const { versionId } = await nuevaVersionEnRevision('propone-sistema');
    const r = await proponerAccion('system', { type: 'brief.approve', resourceId: versionId });
    expect(r.ok, !r.ok ? r.error.message : '').toBe(true);
    if (!r.ok) return;
    expect(r.value.proposedOrigin).toBe('system');
    expect(r.value.proposedBy).toBeNull();
    expect(
      (await confirmarAccion('system', r.value.id, { canal: 'ui', payloadHash: r.value.payloadHash })).ok,
    ).toBe(false);
  });

  it('aislamiento: otra organización no ve, no propone, no confirma ni cancela', async () => {
    const { versionId } = await nuevaVersionEnRevision('aislamiento');
    const propuesta = await proponer(versionId);
    expect((await obtenerAccionPropuesta(ajeno, propuesta.id)).ok).toBe(false);
    expect((await proponerAccion(ajeno, { type: 'brief.approve', resourceId: versionId })).ok).toBe(false);
    expect(
      (await confirmarAccion(ajeno, propuesta.id, { canal: 'ui', payloadHash: propuesta.payloadHash })).ok,
    ).toBe(false);
    expect((await cancelarAccion(ajeno, propuesta.id)).ok).toBe(false);
  });
});

// ─────────────────────────── Auditoría ─────────────────────────────────────────

describe('auditoría de propuesta → confirmación → ejecución', () => {
  it('registra cada paso con actor humano, origen y correlación', async () => {
    const { versionId } = await nuevaVersionEnRevision('auditoria');
    const propuesta = await proponer(versionId);
    await confirmarAccion(director, propuesta.id, { canal: 'ui', payloadHash: propuesta.payloadHash });
    await ejecutarAccion(director, propuesta.id, { canal: 'ui' });

    const eventos = await query<{
      action: string;
      actor_id: string | null;
      origin: string;
      correlation: Record<string, string> | null;
    }>(
      `SELECT action, actor_id, origin, correlation FROM audit_events
        WHERE entity_type = 'proposed_action' AND entity_id = $1 ORDER BY created_at, id`,
      [propuesta.id],
    );
    expect(eventos.map((e) => e.action)).toEqual([
      'proposed_action.propose',
      'proposed_action.confirm',
      'proposed_action.execute',
    ]);
    // Propuesta: la hizo el consultor a través del chat, con su conversación.
    expect(eventos[0]).toMatchObject({ actor_id: consultor.id, origin: 'chat' });
    expect(eventos[0]!.correlation).toMatchObject({ conversationId: 'conv-1', messageId: 'msg-1' });
    // Confirmación y ejecución: el director, en la interfaz.
    expect(eventos[1]).toMatchObject({ actor_id: director.id, origin: 'ui' });
    expect(eventos[2]).toMatchObject({ actor_id: director.id, origin: 'ui' });
    for (const e of eventos) expect(e.correlation).toMatchObject({ proposedActionId: propuesta.id });

    // La transición del brief queda correlacionada con la propuesta.
    const [transicion] = await query<{
      origin: string;
      actor_id: string;
      correlation: Record<string, string>;
    }>(
      `SELECT origin, actor_id, correlation FROM audit_events
        WHERE entity_type = 'brief_version' AND entity_id = $1 AND action = 'brief.transition'
        ORDER BY created_at DESC LIMIT 1`,
      [versionId],
    );
    expect(transicion).toMatchObject({ origin: 'ui', actor_id: director.id });
    expect(transicion!.correlation).toMatchObject({ proposedActionId: propuesta.id });
  });
});

// ─────────────────────────── Atomicidad de la ejecución ────────────────────────

describe('atomicidad: o se aplica todo o no se aplica nada', () => {
  const FUNCION = 'test_fallo_inyectado_hitl';

  /**
   * Inyecta un fallo real de base de datos en un punto concreto de la
   * ejecución, SOLO para el recurso indicado (el resto de pruebas, que corren
   * en paralelo contra la misma base, no se ven afectadas).
   */
  async function conFalloEn(
    punto: 'marcar_executed' | 'auditoria_execute' | 'auditoria_transicion',
    id: string,
    fn: () => Promise<void>,
  ): Promise<void> {
    const pool = getPool();
    await pool.query(`
      CREATE OR REPLACE FUNCTION ${FUNCION}() RETURNS trigger AS $$
      BEGIN
        IF TG_ARGV[0] = 'marcar_executed' THEN
          IF NEW.status = 'executed' AND NEW.id::text = TG_ARGV[1] THEN
            RAISE EXCEPTION 'fallo inyectado: marcar executed';
          END IF;
        ELSIF TG_ARGV[0] = 'auditoria_execute' THEN
          IF NEW.action = 'proposed_action.execute' AND NEW.entity_id::text = TG_ARGV[1] THEN
            RAISE EXCEPTION 'fallo inyectado: auditoría de ejecución';
          END IF;
        ELSIF TG_ARGV[0] = 'auditoria_transicion' THEN
          IF NEW.action = 'brief.transition' AND NEW.entity_id::text = TG_ARGV[1] THEN
            RAISE EXCEPTION 'fallo inyectado: auditoría de la transición';
          END IF;
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql`);
    const tabla = punto === 'marcar_executed' ? 'proposed_actions' : 'audit_events';
    const evento = punto === 'marcar_executed' ? 'UPDATE' : 'INSERT';
    const trigger = `${FUNCION}_${id.replace(/-/g, '').slice(0, 12)}`;
    await pool.query(
      `CREATE TRIGGER ${trigger} BEFORE ${evento} ON ${tabla}
         FOR EACH ROW EXECUTE FUNCTION ${FUNCION}('${punto}', '${id}')`,
    );
    try {
      await fn();
    } finally {
      await pool.query(`DROP TRIGGER IF EXISTS ${trigger} ON ${tabla}`);
    }
  }

  async function estadoDeCoherencia(versionId: string, campaignId: string, accionId: string) {
    const [v] = await query<{ status: string; approved_at: Date | null }>(
      `SELECT status::text, approved_at FROM brief_versions WHERE id = $1`,
      [versionId],
    );
    const [c] = await query<{ visibility: string }>(`SELECT visibility::text FROM campaigns WHERE id = $1`, [
      campaignId,
    ]);
    const [t] = await query<{ n: string }>(
      `SELECT count(*)::text AS n FROM audit_events
        WHERE entity_type = 'brief_version' AND entity_id = $1 AND action = 'brief.transition'
          AND metadata->>'to' = 'approved'`,
      [versionId],
    );
    const [e] = await query<{ n: string }>(
      `SELECT count(*)::text AS n FROM audit_events
        WHERE entity_type = 'proposed_action' AND entity_id = $1 AND action = 'proposed_action.execute'`,
      [accionId],
    );
    return {
      version: v!.status,
      aprobadaEn: v!.approved_at,
      visibilidad: c!.visibility,
      accion: await estadoDeAccion(accionId),
      transicionesAprobadas: Number(t!.n),
      auditoriasDeEjecucion: Number(e!.n),
    };
  }

  const PUNTOS = ['marcar_executed', 'auditoria_execute', 'auditoria_transicion'] as const;

  for (const punto of PUNTOS) {
    it(`si falla «${punto}», no queda dominio aplicado con la acción confirmed; y el reintento reconcilia`, async () => {
      const { campaignId, versionId } = await nuevaVersionEnRevision(`atomica-${punto}`);
      const propuesta = await proponer(versionId);
      await confirmarAccion(director, propuesta.id, { canal: 'ui', payloadHash: propuesta.payloadHash });

      // Antes del fallo: coherente y sin aprobar.
      expect(await estadoDeCoherencia(versionId, campaignId, propuesta.id)).toMatchObject({
        version: 'internal_review',
        visibilidad: 'interna',
        accion: 'confirmed',
        transicionesAprobadas: 0,
      });

      const objetivo = punto === 'auditoria_transicion' ? versionId : propuesta.id;
      await conFalloEn(punto, objetivo, async () => {
        await expect(ejecutarAccion(director, propuesta.id, { canal: 'ui' })).rejects.toThrow(
          /fallo inyectado/,
        );
      });

      // Después del fallo: NADA se aplicó. Ni brief aprobado, ni campaña expuesta
      // a TCL, ni transición auditada, ni acción marcada ejecutada.
      expect(await estadoDeCoherencia(versionId, campaignId, propuesta.id)).toEqual({
        version: 'internal_review',
        aprobadaEn: null,
        visibilidad: 'interna',
        accion: 'confirmed',
        transicionesAprobadas: 0,
        auditoriasDeEjecucion: 0,
      });

      // Reconciliación: sin el fallo, el reintento completa UNA sola vez.
      const reintento = await ejecutarAccion(director, propuesta.id, { canal: 'ui' });
      expect(reintento.ok, !reintento.ok ? reintento.error.message : '').toBe(true);
      const final = await estadoDeCoherencia(versionId, campaignId, propuesta.id);
      expect(final).toMatchObject({
        version: 'approved',
        visibilidad: 'tcl',
        accion: 'executed',
        transicionesAprobadas: 1,
        auditoriasDeEjecucion: 1,
      });
      expect(final.aprobadaEn).not.toBeNull();

      // Y el replay sigue bloqueado.
      expect((await ejecutarAccion(director, propuesta.id, { canal: 'ui' })).ok).toBe(false);
    });
  }

  it('un rechazo del dominio (guarda) no deja nada a medias: acción confirmed, brief sin tocar', async () => {
    const { campaignId, versionId } = await nuevaVersionEnRevision('atomica-guarda');
    const propuesta = await proponer(versionId);
    await confirmarAccion(director, propuesta.id, { canal: 'ui', payloadHash: propuesta.payloadHash });
    const [campo] = await query<{ key: string }>(
      `SELECT key FROM brief_fields WHERE brief_version_id = $1 LIMIT 1`,
      [versionId],
    );
    await query(
      `INSERT INTO local_questions (campaign_id, brief_version_id, key, question, reason, criticidad, status)
       VALUES ($1, $2, $3, '¿?', 'prueba', 'critico', 'pendiente')`,
      [campaignId, versionId, campo!.key],
    );
    const r = await ejecutarAccion(director, propuesta.id, { canal: 'ui' });
    expect(r.ok).toBe(false);
    expect(await estadoDeCoherencia(versionId, campaignId, propuesta.id)).toMatchObject({
      version: 'internal_review',
      visibilidad: 'interna',
      accion: 'confirmed',
      transicionesAprobadas: 0,
      auditoriasDeEjecucion: 0,
    });
  });

  it('la transición dentro de una transacción ajena se revierte con ella', async () => {
    const { campaignId, versionId } = await nuevaVersionEnRevision('atomica-rollback-manual');
    const client = await getPool().connect();
    try {
      await client.query('BEGIN');
      const r = await transicionarBriefEnTransaccion(client, director, versionId, 'approved');
      expect(r.ok).toBe(true);
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
    expect(await estadoDe(versionId)).toBe('internal_review');
    const [c] = await query<{ visibility: string }>(`SELECT visibility::text FROM campaigns WHERE id = $1`, [
      campaignId,
    ]);
    expect(c!.visibility).toBe('interna');
  });

  it('la transición en transacción ajena respeta las mismas reglas de canal y permiso', async () => {
    const { versionId } = await nuevaVersionEnRevision('atomica-reglas');
    const client = await getPool().connect();
    try {
      await client.query('BEGIN');
      const chat = await transicionarBriefEnTransaccion(client, director, versionId, 'approved', {
        origen: 'chat',
      });
      expect(chat.ok).toBe(false);
      if (!chat.ok) expect(chat.error.code).toBe('HUMAN_CONFIRMATION_REQUIRED');
      const sinPermiso = await transicionarBriefEnTransaccion(client, operativo, versionId, 'approved');
      expect(sinPermiso.ok).toBe(false);
      const sistema = await transicionarBriefEnTransaccion(client, 'system', versionId, 'approved');
      expect(sistema.ok).toBe(false);
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
    expect(await estadoDe(versionId)).toBe('internal_review');
  });
});
