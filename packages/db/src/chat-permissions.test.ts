/**
 * V2 · Fase 6 — permisos y aislamiento del chat.
 *
 *  · `chat:read` / `chat:write` solo para admin, director y consultor (D4).
 *  · Owner-scoped (D3): una conversación la ve su creador; ni siquiera un admin de
 *    la misma organización la ve.
 *  · Otra organización, un cliente, un usuario inactivo, un id inexistente o mal
 *    formado → `RESOURCE_NOT_FOUND` (misma respuesta: no se revela la existencia).
 *  · `system` nunca opera el chat.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Result, Role, User } from '@tcl-kol-os/domain';
import { closePool, query } from './client.ts';
import {
  archivarConversacion,
  crearConversacion,
  listarConversaciones,
  obtenerConversacion,
} from './chat-conversations.ts';
import { listarMensajes, obtenerMensaje, publicarMensaje } from './chat-messages.ts';
import {
  cancelarRun,
  completarRun,
  confirmarCancelacionDeRun,
  costoDeRun,
  fallarRun,
  iniciarRun,
  latidoRun,
  listarRunsDeConversacion,
  obtenerRun,
  registrarLlamadaDeModelo,
  reintentarRun,
} from './agent-runs.ts';
import {
  cerrarInvocacion,
  listarInvocacionesDeRun,
  obtenerInvocacion,
  reclamarInvocacion,
} from './agent-tool-invocations.ts';
import { trazaDeAccionPropuesta, trazaDeConversacion, trazaDeInvocacion, trazaDeRun } from './chat-trace.ts';
import {
  CONFIG_DE_RUN_DE_PRUEBA,
  type EscenarioDeChat,
  crearEscenarioDeChat,
  eliminarCampanaDePrueba,
} from './test-utils.ts';

let e: EscenarioDeChat;
let contador = 0;
const HASH = 'd'.repeat(64);
const INEXISTENTE = '00000000-0000-4000-8000-000000000000';

function valor<T>(r: Result<T>): T {
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
  return r.value;
}
type Resultado = { readonly ok: true } | { readonly ok: false; readonly error: { readonly code: string } };
const codigo = (r: Resultado) => (r.ok ? undefined : r.error.code);
const clave = () => `cm-perm-${Date.now().toString(36)}-${++contador}-xxxxxxxx`;

const CON_CHAT: readonly Role[] = ['admin', 'director', 'consultor'];
const SIN_CHAT: readonly Role[] = ['operativo', 'analista', 'legal', 'cliente'];

function usuario(rol: Role): User {
  return {
    admin: e.admin,
    director: e.director,
    consultor: e.consultor,
    operativo: e.operativo,
    analista: e.analista,
    legal: e.legal,
    cliente: e.cliente,
  }[rol];
}

/** Escenario completo de un dueño: conversación, mensaje, run en ejecución y una invocación. */
async function turnoDe(dueno: User) {
  const conv = valor(await crearConversacion(dueno, { campaignId: e.campanaId }));
  const p = valor(
    await publicarMensaje(dueno, {
      conversationId: conv.id,
      clientMessageId: clave(),
      content: 'Mensaje del dueño',
      runConfig: CONFIG_DE_RUN_DE_PRUEBA,
    }),
  );
  const run = valor(await iniciarRun(dueno, p.run.id, { contextHash: HASH, contextManifest: {} }));
  const { invocation } = valor(
    await reclamarInvocacion(dueno, run.id, {
      stepIndex: 0,
      toolName: 'campaign_get',
      riskClass: 'read',
      args: {},
    }),
  );
  return { conv, mensaje: p.message, run, invocation };
}

beforeAll(async () => {
  e = await crearEscenarioDeChat('Permisos del chat');
});

afterAll(async () => {
  await eliminarCampanaDePrueba(e.campanas);
  await closePool();
});

describe('capacidad por rol (chat:read / chat:write)', () => {
  it('admin, director y consultor crean, listan y archivan sus conversaciones', async () => {
    for (const rol of CON_CHAT) {
      const actor = usuario(rol);
      const conv = valor(
        await crearConversacion(actor, { campaignId: e.campanaId, title: `Conversación de ${rol}` }),
      );
      expect(conv).toMatchObject({
        createdBy: actor.id,
        status: 'active',
        lastSeq: 0,
        title: `Conversación de ${rol}`,
      });
      expect(valor(await obtenerConversacion(actor, conv.id)).id).toBe(conv.id);
      expect(valor(await listarConversaciones(actor, e.campanaId)).map((c) => c.id)).toContain(conv.id);
      expect(valor(await archivarConversacion(actor, conv.id)).status).toBe('archived');
    }
  });

  it('operativo, analista, legal y cliente reciben FORBIDDEN_ROLE al crear y al listar', async () => {
    for (const rol of SIN_CHAT) {
      const actor = usuario(rol);
      expect(codigo(await crearConversacion(actor, { campaignId: e.campanaId })), rol).toBe('FORBIDDEN_ROLE');
      expect(codigo(await listarConversaciones(actor, e.campanaId)), rol).toBe('FORBIDDEN_ROLE');
    }
    expect(
      await query(
        `SELECT 1 FROM chat_conversations WHERE campaign_id = $1 AND created_by = ANY($2::uuid[])`,
        [e.campanaId, SIN_CHAT.map((r) => usuario(r).id)],
      ),
    ).toHaveLength(0);
  });

  it('un usuario inactivo no opera el chat', async () => {
    const inactivo: User = { ...e.consultor, status: 'inactivo' };
    expect(codigo(await crearConversacion(inactivo, { campaignId: e.campanaId }))).toBe('FORBIDDEN_ROLE');
    const { conv } = await turnoDe(e.consultor);
    expect(codigo(await obtenerConversacion(inactivo, conv.id))).toBe('RESOURCE_NOT_FOUND');
  });

  it("'system' nunca opera el chat", async () => {
    const sistema = 'system' as unknown as User;
    expect(codigo(await crearConversacion(sistema, { campaignId: e.campanaId }))).toBe('FORBIDDEN_ROLE');
    const { conv } = await turnoDe(e.consultor);
    expect(codigo(await obtenerConversacion(sistema, conv.id))).toBe('RESOURCE_NOT_FOUND');
  });

  it('crear en una campaña de otra organización o inexistente responde RESOURCE_NOT_FOUND', async () => {
    expect(codigo(await crearConversacion(e.consultor, { campaignId: e.campanaAjenaId }))).toBe(
      'RESOURCE_NOT_FOUND',
    );
    expect(codigo(await crearConversacion(e.consultor, { campaignId: INEXISTENTE }))).toBe(
      'RESOURCE_NOT_FOUND',
    );
    expect(codigo(await crearConversacion(e.consultor, { campaignId: 'no-es-uuid' }))).toBe(
      'RESOURCE_NOT_FOUND',
    );
    expect(codigo(await crearConversacion(e.ajeno, { campaignId: e.campanaId }))).toBe('RESOURCE_NOT_FOUND');
  });
});

describe('owner-scoped: la conversación es de su creador', () => {
  it('otra persona de la misma organización (incluido un admin) no la ve ni la usa', async () => {
    const d = await turnoDe(e.consultor);
    for (const otro of [e.admin, e.director]) {
      expect(codigo(await obtenerConversacion(otro, d.conv.id)), otro.role).toBe('RESOURCE_NOT_FOUND');
      expect(codigo(await listarMensajes(otro, d.conv.id)), otro.role).toBe('RESOURCE_NOT_FOUND');
      expect(codigo(await obtenerMensaje(otro, d.mensaje.id)), otro.role).toBe('RESOURCE_NOT_FOUND');
      expect(
        codigo(
          await publicarMensaje(otro, {
            conversationId: d.conv.id,
            clientMessageId: clave(),
            content: 'intruso',
            runConfig: CONFIG_DE_RUN_DE_PRUEBA,
          }),
        ),
      ).toBe('RESOURCE_NOT_FOUND');
      expect(codigo(await archivarConversacion(otro, d.conv.id))).toBe('RESOURCE_NOT_FOUND');
      expect(codigo(await obtenerRun(otro, d.run.id))).toBe('RESOURCE_NOT_FOUND');
      expect(codigo(await listarRunsDeConversacion(otro, d.conv.id))).toBe('RESOURCE_NOT_FOUND');
      expect(codigo(await cancelarRun(otro, d.run.id))).toBe('RESOURCE_NOT_FOUND');
      expect(codigo(await latidoRun(otro, d.run.id))).toBe('RESOURCE_NOT_FOUND');
      expect(codigo(await confirmarCancelacionDeRun(otro, d.run.id))).toBe('RESOURCE_NOT_FOUND');
      expect(codigo(await completarRun(otro, d.run.id, { content: 'suplantación' }))).toBe(
        'RESOURCE_NOT_FOUND',
      );
      expect(codigo(await fallarRun(otro, d.run.id, { errorCode: 'X1' }))).toBe('RESOURCE_NOT_FOUND');
      expect(codigo(await reintentarRun(otro, d.mensaje.id, CONFIG_DE_RUN_DE_PRUEBA))).toBe(
        'RESOURCE_NOT_FOUND',
      );
      expect(codigo(await iniciarRun(otro, d.run.id, { contextHash: HASH, contextManifest: {} }))).toBe(
        'RESOURCE_NOT_FOUND',
      );
      expect(
        codigo(
          await registrarLlamadaDeModelo(otro, d.run.id, {
            stepIndex: 0,
            tier: 'equilibrado',
            provider: 'p',
            model: 'm',
            promptVersion: 'v',
            inputHash: HASH,
            outputStatus: 'ok',
          }),
        ),
      ).toBe('RESOURCE_NOT_FOUND');
      expect(codigo(await costoDeRun(otro, d.run.id))).toBe('RESOURCE_NOT_FOUND');
      expect(
        codigo(
          await reclamarInvocacion(otro, d.run.id, {
            stepIndex: 5,
            toolName: 'x',
            riskClass: 'read',
            args: {},
          }),
        ),
      ).toBe('RESOURCE_NOT_FOUND');
      expect(codigo(await cerrarInvocacion(otro, d.invocation.id, { status: 'cancelled' }))).toBe(
        'RESOURCE_NOT_FOUND',
      );
      expect(codigo(await listarInvocacionesDeRun(otro, d.run.id))).toBe('RESOURCE_NOT_FOUND');
      expect(codigo(await obtenerInvocacion(otro, d.invocation.id))).toBe('RESOURCE_NOT_FOUND');
      expect(codigo(await trazaDeConversacion(otro, d.conv.id))).toBe('RESOURCE_NOT_FOUND');
      expect(codigo(await trazaDeRun(otro, d.run.id))).toBe('RESOURCE_NOT_FOUND');
      expect(codigo(await trazaDeInvocacion(otro, d.invocation.id))).toBe('RESOURCE_NOT_FOUND');
    }
    // Nada cambió: el run sigue en ejecución, sin cancelación pedida y con su invocación abierta.
    const run = valor(await obtenerRun(e.consultor, d.run.id));
    expect(run.status).toBe('running');
    expect(run.cancelRequestedAt).toBeUndefined();
    expect(valor(await obtenerInvocacion(e.consultor, d.invocation.id)).status).toBe('running');
  });

  it('el listado solo trae las conversaciones propias de la campaña', async () => {
    const mia = valor(await crearConversacion(e.director, { campaignId: e.campanaId }));
    const deOtro = valor(await crearConversacion(e.admin, { campaignId: e.campanaId }));
    const otraCampana = valor(await crearConversacion(e.director, { campaignId: e.otraCampanaId }));
    const ids = valor(await listarConversaciones(e.director, e.campanaId)).map((c) => c.id);
    expect(ids).toContain(mia.id);
    expect(ids).not.toContain(deOtro.id);
    expect(ids).not.toContain(otraCampana.id);
    expect(valor(await listarConversaciones(e.director, e.campanaAjenaId))).toEqual([]);
    expect(valor(await listarConversaciones(e.ajeno, e.campanaId))).toEqual([]);
  });

  it('un admin de OTRA organización recibe lo mismo que ante un id inexistente', async () => {
    const d = await turnoDe(e.consultor);
    const reales = [
      codigo(await obtenerConversacion(e.ajeno, d.conv.id)),
      codigo(await listarMensajes(e.ajeno, d.conv.id)),
      codigo(await obtenerRun(e.ajeno, d.run.id)),
    ];
    const inexistentes = [
      codigo(await obtenerConversacion(e.ajeno, INEXISTENTE)),
      codigo(await listarMensajes(e.ajeno, INEXISTENTE)),
      codigo(await obtenerRun(e.ajeno, INEXISTENTE)),
    ];
    expect(reales).toEqual(inexistentes);
    expect(new Set([...reales, ...inexistentes])).toEqual(new Set(['RESOURCE_NOT_FOUND']));
    const respuestaReal = await obtenerConversacion(e.ajeno, d.conv.id);
    const respuestaFalsa = await obtenerConversacion(e.ajeno, INEXISTENTE);
    expect(respuestaReal.ok ? '' : respuestaReal.error.message).toBe(
      respuestaFalsa.ok ? '' : respuestaFalsa.error.message,
    );
  });

  it('un cliente (TCL) recibe RESOURCE_NOT_FOUND ante cualquier conversación o run', async () => {
    const d = await turnoDe(e.consultor);
    expect(codigo(await obtenerConversacion(e.cliente, d.conv.id))).toBe('RESOURCE_NOT_FOUND');
    expect(codigo(await listarMensajes(e.cliente, d.conv.id))).toBe('RESOURCE_NOT_FOUND');
    expect(codigo(await obtenerRun(e.cliente, d.run.id))).toBe('RESOURCE_NOT_FOUND');
    expect(codigo(await trazaDeConversacion(e.cliente, d.conv.id))).toBe('RESOURCE_NOT_FOUND');
    expect(codigo(await trazaDeAccionPropuesta(e.cliente, INEXISTENTE))).toBe('RESOURCE_NOT_FOUND');
  });

  it('ids mal formados no revientan: RESOURCE_NOT_FOUND', async () => {
    for (const id of ['no-es-uuid', '', "' OR 1=1 --"]) {
      expect(codigo(await obtenerConversacion(e.consultor, id)), id).toBe('RESOURCE_NOT_FOUND');
      expect(codigo(await listarMensajes(e.consultor, id)), id).toBe('RESOURCE_NOT_FOUND');
      expect(codigo(await obtenerMensaje(e.consultor, id)), id).toBe('RESOURCE_NOT_FOUND');
      expect(codigo(await obtenerRun(e.consultor, id)), id).toBe('RESOURCE_NOT_FOUND');
      expect(codigo(await obtenerInvocacion(e.consultor, id)), id).toBe('RESOURCE_NOT_FOUND');
      expect(codigo(await reintentarRun(e.consultor, id, CONFIG_DE_RUN_DE_PRUEBA)), id).toBe(
        'RESOURCE_NOT_FOUND',
      );
      expect(codigo(await trazaDeInvocacion(e.consultor, id)), id).toBe('RESOURCE_NOT_FOUND');
    }
  });
});

describe('el dueño que pierde la capacidad ya no opera (se relee su rol)', () => {
  it('un dueño degradado a operativo recibe FORBIDDEN_ROLE en cada operación del chat', async () => {
    const d = await turnoDe(e.consultor);
    // El mismo usuario, releído de la base con otro rol (el runtime siempre recarga al actor).
    const degradado: User = { ...e.consultor, role: 'operativo' };
    expect(codigo(await obtenerConversacion(degradado, d.conv.id))).toBe('FORBIDDEN_ROLE');
    expect(codigo(await listarMensajes(degradado, d.conv.id))).toBe('FORBIDDEN_ROLE');
    expect(
      codigo(
        await publicarMensaje(degradado, {
          conversationId: d.conv.id,
          clientMessageId: clave(),
          content: 'sigo aquí',
          runConfig: CONFIG_DE_RUN_DE_PRUEBA,
        }),
      ),
    ).toBe('FORBIDDEN_ROLE');
    expect(codigo(await completarRun(degradado, d.run.id, { content: 'hecho' }))).toBe('FORBIDDEN_ROLE');
    expect(codigo(await cancelarRun(degradado, d.run.id))).toBe('FORBIDDEN_ROLE');
    expect(
      codigo(
        await reclamarInvocacion(degradado, d.run.id, {
          stepIndex: 9,
          toolName: 'x',
          riskClass: 'read',
          args: {},
        }),
      ),
    ).toBe('FORBIDDEN_ROLE');
    expect(codigo(await trazaDeConversacion(degradado, d.conv.id))).toBe('FORBIDDEN_ROLE');
    // Y un dueño que pasa a `cliente` ya ni «existe» para el chat.
    const cliente: User = { ...e.consultor, role: 'cliente' };
    expect(codigo(await obtenerConversacion(cliente, d.conv.id))).toBe('RESOURCE_NOT_FOUND');
  });
});

describe('la base es la última línea de defensa', () => {
  it('ni por SQL directo un usuario de TCL o una persona sin cuenta escribe en el chat', async () => {
    const d = await turnoDe(e.consultor);
    await expect(
      query(
        `INSERT INTO chat_messages (organization_id, campaign_id, conversation_id, role, user_id, content, client_message_id)
         VALUES ($1, $2, $3, 'user', $4, 'hola', 'clave-sql-perm-01')`,
        [e.admin.organizationId, e.campanaId, d.conv.id, e.cliente.id],
      ),
    ).rejects.toThrow();
    await expect(
      query(`INSERT INTO chat_conversations (organization_id, campaign_id, created_by) VALUES ($1, $2, $3)`, [
        e.admin.organizationId,
        e.campanaId,
        INEXISTENTE,
      ]),
    ).rejects.toThrow();
  });
});
