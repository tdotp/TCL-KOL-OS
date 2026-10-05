/**
 * QA adversarial sobre las lecturas de presentación del chat (`chat-views.ts`, W3-A): aislamiento por
 * dueño/organización/campaña/rol y NO fuga de argumentos/resultados de tools, payload de propuestas,
 * manifiesto, URL, rutas de almacenamiento ni nombres internos de herramientas. Solo lectura; no edita
 * código de producto. Base propia desechable (INC-001A).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Result, User } from '@tcl-kol-os/domain';
import { closePool, query } from './client.ts';
import { crearConversacion } from './chat-conversations.ts';
import { publicarMensaje } from './chat-messages.ts';
import { completarRun, iniciarRun } from './agent-runs.ts';
import { cerrarInvocacion, reclamarInvocacion } from './agent-tool-invocations.ts';
import {
  cargarVistaDeChat,
  estadoDeAdjuntos,
  listarAccionesDeConversacion,
  listarAccionesPendientesDeCampana,
  listarActividadDeHerramientas,
  obtenerAccionDeChat,
  obtenerConversacionDeCampana,
  obtenerMensajesDeChat,
  obtenerRunsRecientes,
} from './chat-views.ts';
import { crearBriefManual } from './manual.ts';
import { proponerAccion } from './proposed-actions.ts';
import {
  CONFIG_DE_RUN_DE_PRUEBA,
  type EscenarioDeChat,
  crearEscenarioDeChat,
  crearFragmentoDePrueba,
  crearFuenteDePrueba,
  eliminarCampanaDePrueba,
} from './test-utils.ts';

let e: EscenarioDeChat;
let n = 0;
const clave = () => `qa-vw-${Date.now().toString(36)}-${++n}-xxxxxxxx`;
const valor = <T>(r: Result<T>): T => {
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
  return r.value;
};

interface Montaje {
  convId: string;
  accionId: string;
  fuenteSensible: string;
}
let m: Montaje;

beforeAll(async () => {
  e = await crearEscenarioDeChat('QA chat-views');
  const manual = valor(await crearBriefManual(e.admin, e.campanaId));
  await query(`UPDATE brief_versions SET status = 'internal_review' WHERE id = $1`, [manual.versionId]);
  const sensible = await crearFuenteDePrueba(e.campanaId, e.admin, 'NOMBRE-SENSIBLE-VW');
  await crearFragmentoDePrueba(sensible, 1, 'TEXTO-SENSIBLE-VW');
  await query(
    `UPDATE source_documents SET confidentiality_level = 'sensible', file_id = 'RUTA-ALMACEN-VW/x.bin' WHERE id = $1`,
    [sensible],
  );
  const conv = valor(await crearConversacion(e.consultor, { campaignId: e.campanaId }));
  const pub = valor(
    await publicarMensaje(e.consultor, {
      conversationId: conv.id,
      clientMessageId: clave(),
      content: 'Propón la aprobación',
      sourceIds: [sensible],
      runConfig: CONFIG_DE_RUN_DE_PRUEBA,
    }),
  );
  valor(
    await iniciarRun(e.consultor, pub.run.id, {
      contextHash: 'a'.repeat(64),
      contextManifest: { secreto: 'MANIFIESTO-VW' },
    }),
  );
  const lectura = valor(
    await reclamarInvocacion(e.consultor, pub.run.id, {
      stepIndex: 0,
      toolCallId: clave(),
      toolName: 'source_read_content',
      riskClass: 'read',
      args: { sourceId: 'S1', nota: 'ARGS-SECRETOS-VW' },
    }),
  );
  valor(
    await cerrarInvocacion(e.consultor, lectura.invocation.id, {
      status: 'succeeded',
      result: { texto: 'RESULTADO-SECRETO-VW' },
    }),
  );
  const propuesta = valor(
    await proponerAccion(e.consultor, {
      type: 'brief.approve',
      resourceId: manual.versionId,
      origin: 'chat',
      correlation: { conversationId: conv.id, messageId: pub.message.id, agentRunId: pub.run.id },
      campaignId: e.campanaId,
    }),
  );
  const prop = valor(
    await reclamarInvocacion(e.consultor, pub.run.id, {
      stepIndex: 1,
      toolCallId: clave(),
      toolName: 'brief_propose_approval',
      riskClass: 'confirmation_required',
      args: { evidenceQuote: 'Propón la aprobación' },
    }),
  );
  valor(
    await cerrarInvocacion(e.consultor, prop.invocation.id, {
      status: 'succeeded',
      result: {},
      proposedActionId: propuesta.id,
    }),
  );
  valor(await completarRun(e.consultor, pub.run.id, { content: 'Dejé una propuesta pendiente.' }));
  m = { convId: conv.id, accionId: propuesta.id, fuenteSensible: sensible };
});
afterAll(async () => {
  await eliminarCampanaDePrueba(e.campanas);
  await closePool();
});

const PROHIBIDO = [
  'ARGS-SECRETOS-VW',
  'RESULTADO-SECRETO-VW',
  'MANIFIESTO-VW',
  'RUTA-ALMACEN-VW',
  'TEXTO-SENSIBLE-VW',
  'contentFingerprint',
  'stateFingerprint',
  'planFingerprint',
  'source_read_content',
  'brief_propose_approval',
  'external_url',
  'canonical_url',
  'contextHash',
  'prompt_version',
  'modelo-de-prueba',
  'idempotency',
];

describe('chat-views · no fuga hacia la interfaz', () => {
  it('la vista completa del dueño no contiene argumentos, resultados, payload, manifiesto, rutas, proveedor/modelo ni nombres internos de tools', async () => {
    const v = valor(
      await cargarVistaDeChat(e.consultor, m.convId, { etiquetar: (t) => `Etiqueta de ${t.length}` }),
    );
    const texto = JSON.stringify(v);
    for (const p of PROHIBIDO) expect(texto, p).not.toContain(p);
    expect(v.activity.length).toBeGreaterThan(0);
    expect(v.proposals).toHaveLength(1);
    // el estado del adjunto sensible es «restringido» y nunca se dice su contenido
    const adj = v.messages.flatMap((x) => x.attachments);
    expect(adj.map((a) => a.estado)).toEqual(['restringido']);
  });

  it('el director ve la propuesta pendiente de otra persona pero NO el hilo, y sin detalles crudos', async () => {
    const pend = valor(await listarAccionesPendientesDeCampana(e.director, e.campanaId));
    expect(pend.map((p) => p.id)).toContain(m.accionId);
    expect(JSON.stringify(pend)).not.toMatch(/contentFingerprint|ARGS-SECRETOS|RESULTADO-SECRETO/);
    expect((await cargarVistaDeChat(e.director, m.convId)).ok).toBe(false);
    expect((await obtenerMensajesDeChat(e.director, m.convId)).ok).toBe(false);
    expect((await obtenerRunsRecientes(e.director, m.convId)).ok).toBe(false);
    expect((await listarActividadDeHerramientas(e.director, m.convId)).ok).toBe(false);
    expect((await listarAccionesDeConversacion(e.director, m.convId)).ok).toBe(false);
    const accion = valor(await obtenerAccionDeChat(e.director, e.campanaId, m.accionId));
    expect(accion.esDeMiConversacion).toBe(false);
    expect(accion.runId).toBeUndefined();
    expect(accion.canConfirm).toBe(true);
  });
});

describe('chat-views · aislamiento por rol, organización y campaña', () => {
  it('operativo, analista, legal y cliente no leen NADA (ni la conversación, ni las pendientes, ni la acción)', async () => {
    for (const actor of [e.operativo, e.analista, e.legal, e.cliente]) {
      const et = actor.role;
      expect((await cargarVistaDeChat(actor, m.convId)).ok, et).toBe(false);
      expect((await obtenerConversacionDeCampana(actor, e.campanaId)).ok, et).toBe(false);
      expect((await listarAccionesPendientesDeCampana(actor, e.campanaId)).ok, et).toBe(false);
      expect((await obtenerAccionDeChat(actor, e.campanaId, m.accionId)).ok, et).toBe(false);
      expect((await estadoDeAdjuntos(actor, e.campanaId, [m.fuenteSensible])).ok, et).toBe(false);
    }
  });

  it('otra organización: nada; el consultor NO dueño ni confirmador no ve la acción de otro; campaña distinta no resuelve la acción', async () => {
    expect((await cargarVistaDeChat(e.ajeno, m.convId)).ok).toBe(false);
    const ajena = await listarAccionesPendientesDeCampana(e.ajeno, e.campanaId);
    expect(!ajena.ok || ajena.value.length === 0).toBe(true);
    expect((await obtenerAccionDeChat(e.ajeno, e.campanaId, m.accionId)).ok).toBe(false);
    // otro consultor de la misma org (sin permiso de confirmar brief.approve): no la ve
    expect((await obtenerAccionDeChat(e.consultor, e.otraCampanaId, m.accionId)).ok).toBe(false);
    const otroUsuario: User = { ...e.consultor, id: e.operativo.id };
    expect((await obtenerAccionDeChat(otroUsuario, e.campanaId, m.accionId)).ok).toBe(false);
    // ids mal formados
    for (const id of ["'; DROP TABLE users;--", '0', '../x']) {
      expect((await obtenerAccionDeChat(e.director, e.campanaId, id)).ok).toBe(false);
      expect((await cargarVistaDeChat(e.consultor, id)).ok).toBe(false);
    }
  });

  it('un usuario desactivado no lee la vista aunque conserve el objeto de sesión', async () => {
    const inactivo: User = { ...e.consultor, status: 'inactivo' };
    expect((await cargarVistaDeChat(inactivo, m.convId)).ok).toBe(false);
    expect(
      (await listarAccionesPendientesDeCampana({ ...e.director, status: 'inactivo' }, e.campanaId)).ok,
    ).toBe(false);
  });

  it('un GET no crea nada: obtenerConversacionDeCampana con ids de campaña ajena no inserta conversaciones', async () => {
    const antes = await query<{ n: string }>(`SELECT count(*)::text AS n FROM chat_conversations`);
    await obtenerConversacionDeCampana(e.consultor, e.campanaAjenaId);
    await obtenerConversacionDeCampana(e.ajeno, e.campanaId);
    const despues = await query<{ n: string }>(`SELECT count(*)::text AS n FROM chat_conversations`);
    expect(despues[0]!.n).toBe(antes[0]!.n);
  });
});
