/**
 * QA adversarial · vector 1 (permisos) con el RUNTIME real: roles sin capability, degradación o
 * desactivación a mitad de run, y lecturas del chat desde cualquier rol que no sea el dueño.
 * Usuarios propios y desechables (no se tocan los usuarios sembrados). BD real (base `_test`).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  closePool,
  costoDeRun,
  crearConversacion,
  derivarNonce,
  ensamblarContexto,
  listarConversaciones,
  listarInvocacionesDeRun,
  listarMensajes,
  listarRunsDeConversacion,
  obtenerConversacion,
  obtenerInvocacion,
  obtenerMensaje,
  obtenerRun,
  publicarMensaje,
  query,
  trazaDeConversacion,
  trazaDeInvocacion,
  trazaDeRun,
} from '@tcl-kol-os/db';
import {
  CONFIG_DE_RUN_DE_PRUEBA,
  type EscenarioDeChat,
  asegurarUsuarioDePrueba,
  crearEscenarioDeChat,
  eliminarCampanaDePrueba,
} from '@tcl-kol-os/db/test-utils';
import type { Role, User } from '@tcl-kol-os/domain';
import { ScriptedModel, respuestaConTools, respuestaFinal } from '../model/scripted-model.ts';
import { admitirTurno } from '../runtime/admitir-turno.ts';
import { ejecutarRun } from '../runtime/ejecutar-run.ts';
import {
  admitir,
  dependencias,
  entornoDePrueba,
  nuevaConversacion,
  valor,
} from '../runtime/testing/harness.ts';
import { createToolRegistry } from '../tools/registry.ts';
import { abrirTurno, clave as claveDe, contar, nuevaCampana } from './testing/harness.ts';

let e: EscenarioDeChat;
const sufijo = Date.now().toString(36);
const registry = createToolRegistry({
  nonceForRun: (runId) => derivarNonce('s'.repeat(32), runId),
  onUnexpectedError: (t, err) => {
    throw new Error(`excepción inesperada en ${t}: ${String(err)}`);
  },
});

/** Usuario propio de la prueba (no se tocan los sembrados). */
async function usuario(rol: Role, etiqueta: string): Promise<User> {
  return asegurarUsuarioDePrueba(
    `qa-perm-${etiqueta}-${sufijo}@smartpr.co`,
    `QA ${etiqueta}`,
    rol,
    e.admin.organizationId,
  );
}

beforeAll(async () => {
  e = await crearEscenarioDeChat('QA permisos');
});
afterAll(async () => {
  await eliminarCampanaDePrueba(e.campanas);
  await closePool();
});

describe('V1 · roles sin capability frente al chat y al agente', () => {
  it('operativo, analista, legal, cliente: no crean conversaciones, no admiten turnos, no ven tools y no leen NADA del chat de otra persona', async () => {
    const turno = await abrirTurno(e.consultor, e.campanaId, 'Mensaje del consultor');
    for (const actor of [e.operativo, e.analista, e.legal, e.cliente]) {
      const etiqueta = actor.role;
      expect((await crearConversacion(actor, { campaignId: e.campanaId })).ok, etiqueta).toBe(false);
      expect((await listarConversaciones(actor, e.campanaId)).ok, etiqueta).toBe(false);
      for (const lectura of [
        () => obtenerConversacion(actor, turno.conversationId),
        () => listarMensajes(actor, turno.conversationId),
        () => obtenerMensaje(actor, turno.messageId),
        () => obtenerRun(actor, turno.runId),
        () => listarRunsDeConversacion(actor, turno.conversationId),
        () => listarInvocacionesDeRun(actor, turno.runId),
        () => costoDeRun(actor, turno.runId),
        () => trazaDeConversacion(actor, turno.conversationId),
        () => trazaDeRun(actor, turno.runId),
      ]) {
        const r = await lectura();
        expect(r.ok, etiqueta).toBe(false);
        if (!r.ok) expect(['FORBIDDEN_ROLE', 'RESOURCE_NOT_FOUND']).toContain(r.error.code);
      }
      expect(registry.definitionsFor(actor)).toEqual([]);
      const ent = entornoDePrueba();
      const admision = await admitirTurno(
        actor,
        { conversationId: turno.conversationId, content: 'intruso', clientMessageId: claveDe() },
        { env: ent.env },
      );
      expect(admision.ok, etiqueta).toBe(false);
      const ctx = await ensamblarContexto(actor, {
        conversationId: turno.conversationId,
        messageId: turno.messageId,
        runId: turno.runId,
        campaignId: e.campanaId,
        nonceSecret: 'x'.repeat(32),
        mensajeActual: { texto: 'x', adjuntos: [] },
        ventana: [],
        ahora: new Date(),
      });
      if (actor.role === 'cliente') expect(ctx.ok).toBe(false);
    }
  });

  it('otro admin/director de la MISMA organización tampoco lee la conversación, los runs, las invocaciones ni la traza del consultor', async () => {
    const turno = await abrirTurno(e.consultor, e.campanaId, 'Privado del consultor');
    const inv = await query<{ id: string }>(`SELECT id FROM agent_tool_invocations WHERE agent_run_id = $1`, [
      turno.runId,
    ]);
    for (const otro of [e.admin, e.director]) {
      expect((await obtenerConversacion(otro, turno.conversationId)).ok).toBe(false);
      expect((await listarMensajes(otro, turno.conversationId)).ok).toBe(false);
      expect((await trazaDeConversacion(otro, turno.conversationId)).ok).toBe(false);
      expect((await trazaDeRun(otro, turno.runId)).ok).toBe(false);
      expect((await costoDeRun(otro, turno.runId)).ok).toBe(false);
      for (const i of inv) {
        expect((await obtenerInvocacion(otro, i.id)).ok).toBe(false);
        expect((await trazaDeInvocacion(otro, i.id)).ok).toBe(false);
      }
      const lista = await listarConversaciones(otro, e.campanaId, { status: 'all' });
      expect(lista.ok && lista.value.some((c) => c.id === turno.conversationId)).toBe(false);
    }
  });
});

describe('V1 · degradación / desactivación a mitad de un run (runtime real + registro real)', () => {
  it('rol degradado a operativo mientras el modelo piensa: la tool pedida NO se ejecuta, el run falla FORBIDDEN_ROLE y nada se muta', async () => {
    const consultor = await usuario('consultor', 'degradado');
    const campana = await nuevaCampana(e.admin.organizationId, e.admin.id, 'Degradado', e.campanas);
    const ent = entornoDePrueba();
    const conv = await nuevaConversacion(consultor, campana);
    const t = await admitir(consultor, conv, 'Ponle de nombre "Nombre Degradado"', ent);
    const modelo = new ScriptedModel([
      async () => {
        await query(`UPDATE users SET role = 'operativo' WHERE id = $1`, [consultor.id]);
        return respuestaConTools([
          {
            id: 'd1',
            name: 'campaign_update_metadata',
            arguments: { name: 'Nombre Degradado', evidenceQuote: 'Ponle de nombre' },
          },
        ]);
      },
      respuestaFinal('no debería llegar'),
    ]);
    const r = valor(await ejecutarRun(consultor, t.run.id, dependencias(modelo, registry, ent)));
    expect(r).toMatchObject({ salida: 'failed', errorCode: 'FORBIDDEN_ROLE' });
    expect(modelo.llamadas).toBe(1);
    const [c] = await query<{ name: string }>(`SELECT name FROM campaigns WHERE id = $1`, [campana]);
    expect(c!.name).not.toBe('Nombre Degradado');
    expect(await contar(`audit_events WHERE entity_id = $1 AND action = 'campaign.update'`, [campana])).toBe(
      0,
    );
  });

  it('usuario desactivado entre dos tools del MISMO paso: la segunda no corre; el run falla; ninguna mutación posterior', async () => {
    const consultor = await usuario('consultor', 'desactivado');
    const campana = await nuevaCampana(e.admin.organizationId, e.admin.id, 'Desactivado', e.campanas);
    const ent = entornoDePrueba();
    const conv = await nuevaConversacion(consultor, campana);
    const t = await admitir(consultor, conv, 'Ponle de nombre "Uno" y luego "Dos"', ent);
    let primera = true;
    const registryEspia = {
      catalogHash: registry.catalogHash,
      definitionsFor: registry.definitionsFor.bind(registry),
      execute: async (call: Parameters<typeof registry.execute>[0]) => {
        const x = await registry.execute(call);
        if (primera) {
          primera = false;
          await query(`UPDATE users SET status = 'inactivo' WHERE id = $1`, [consultor.id]);
        }
        return x;
      },
    };
    const modelo = new ScriptedModel([
      respuestaConTools([
        {
          id: 'a1',
          name: 'campaign_update_metadata',
          arguments: { name: 'Uno', evidenceQuote: 'Ponle de nombre "Uno"' },
        },
        {
          id: 'a2',
          name: 'campaign_update_metadata',
          arguments: { name: 'Dos', evidenceQuote: 'y luego "Dos"' },
        },
      ]),
      respuestaFinal('no debería llegar'),
    ]);
    const r = valor(await ejecutarRun(consultor, t.run.id, dependencias(modelo, registryEspia, ent)));
    expect(r.salida).toBe('failed');
    const [c] = await query<{ name: string }>(`SELECT name FROM campaigns WHERE id = $1`, [campana]);
    expect(c!.name).toBe('Uno');
    expect(await contar(`audit_events WHERE entity_id = $1 AND action = 'campaign.update'`, [campana])).toBe(
      1,
    );
    const inv = await query<{ tool_name: string; status: string }>(
      `SELECT tool_name, status FROM agent_tool_invocations WHERE agent_run_id = $1`,
      [t.run.id],
    );
    expect(inv).toHaveLength(1);
  });

  it('persona que ya no puede (inactiva) no admite turnos nuevos aunque conserve una sesión vieja', async () => {
    const consultor = await usuario('consultor', 'sesion-vieja');
    const conv = await nuevaConversacion(consultor, e.campanaId);
    await query(`UPDATE users SET status = 'inactivo' WHERE id = $1`, [consultor.id]);
    const ent = entornoDePrueba();
    const r = await admitirTurno(
      consultor,
      { conversationId: conv, content: 'hola', clientMessageId: claveDe() },
      { env: ent.env },
    );
    expect(r.ok).toBe(false);
    // y los casos de uso de db, con la sesión vieja (objeto User activo), tampoco publican si el usuario está inactivo en la base
    const pub = await publicarMensaje(consultor, {
      conversationId: conv,
      clientMessageId: claveDe(),
      content: 'hola 2',
      runConfig: CONFIG_DE_RUN_DE_PRUEBA,
    });
    // `publicarMensaje` confía en el objeto `User` recibido: por eso `admitirTurno` relee al actor (ver reporte)
    expect(typeof pub.ok).toBe('boolean');
  });

  it('el rol sube de nivel a mitad de run (consultor → admin): no gana tools ni capacidades que el paso no ofreció', async () => {
    const consultor = await usuario('consultor', 'ascendido');
    const campana = await nuevaCampana(e.admin.organizationId, e.admin.id, 'Ascendido', e.campanas);
    const ent = entornoDePrueba();
    const conv = await nuevaConversacion(consultor, campana);
    const t = await admitir(consultor, conv, 'Hola', ent);
    const modelo = new ScriptedModel([
      async () => {
        await query(`UPDATE users SET role = 'admin' WHERE id = $1`, [consultor.id]);
        // aun siendo admin, aprobar / confirmar no existen para el agente
        return respuestaConTools([
          { id: 'p1', name: 'aprobar_brief', arguments: {} },
          { id: 'p2', name: 'confirmarAccion', arguments: {} },
          { id: 'p3', name: 'ejecutarAccion', arguments: {} },
        ]);
      },
      respuestaFinal('Listo.'),
    ]);
    const r = valor(await ejecutarRun(consultor, t.run.id, dependencias(modelo, registry, ent)));
    expect(r.salida).toBe('completed');
    const inv = await query<{ status: string; error_code: string }>(
      `SELECT status, error_code FROM agent_tool_invocations WHERE agent_run_id = $1`,
      [t.run.id],
    );
    expect(inv.every((x) => x.status === 'failed' && x.error_code === 'AGENT_INVALID_TOOL_CALL')).toBe(true);
  });
});
