/**
 * V2 · Fase 6, Wave 3 — lecturas de presentación del chat (`chat-views.ts`).
 *
 *  · Owner-scoped y por organización: otra persona, otra organización, un cliente y un
 *    operativo no ven nada (la misma respuesta que un id inexistente).
 *  · Un GET no crea conversaciones.
 *  · Los DTO no filtran `external_url`, rutas de almacenamiento, argumentos/resultados
 *    de tools ni nombres internos de herramientas: solo etiquetas en español.
 *  · Propuestas: texto humano, huella, estado efectivo, quién puede confirmar/cancelar y
 *    obsolescencia; el director ve (y confirma) lo que propuso el consultor.
 *
 * Campañas propias y desechables (INC-001A).
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Result, User } from '@tcl-kol-os/domain';
import { closePool, query } from './client.ts';
import { adminTransaction } from './test-admin.ts';
import { crearConversacion } from './chat-conversations.ts';
import { publicarMensaje } from './chat-messages.ts';
import { cancelarRun, completarRun, fallarRun, iniciarRun, listarRunsDeConversacion } from './agent-runs.ts';
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
import { corregirCampo } from './brief-fields.ts';
import { crearBriefManual } from './manual.ts';
import { proponerAccion } from './proposed-actions.ts';
import { registerLinkedSource } from './sources.ts';
import {
  CONFIG_DE_RUN_DE_PRUEBA,
  type EscenarioDeChat,
  crearEscenarioDeChat,
  crearFragmentoDePrueba,
  crearFuenteDePrueba,
  eliminarCampanaDePrueba,
} from './test-utils.ts';

let e: EscenarioDeChat;
let contador = 0;
const HASH = 'f'.repeat(64);
const INEXISTENTE = '00000000-0000-4000-8000-000000000000';

function valor<T>(r: Result<T>): T {
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
  return r.value;
}
type Resultado = { readonly ok: true } | { readonly ok: false; readonly error: { readonly code: string } };
const codigo = (r: Resultado) => (r.ok ? undefined : r.error.code);
const clave = () => `cm-vista-${Date.now().toString(36)}-${++contador}-xxxxxxxx`;

const etiquetar = (nombre: string) =>
  ({ campaign_get: 'Consultando la campaña', brief_propose_approval: 'Proponiendo la aprobación del brief' })[
    nombre
  ];

async function nuevaCampana(etiqueta: string): Promise<string> {
  const [c] = await query<{ id: string }>(
    `INSERT INTO campaigns (organization_id, name, owner_id, created_by)
     VALUES ($1, $2, $3, $3) RETURNING id`,
    [e.admin.organizationId, `Vistas · ${etiqueta} · ${e.sufijo}`, e.admin.id],
  );
  e.campanas.push(c!.id);
  return c!.id;
}

async function conversacion(dueno: User, campaignId: string = e.campanaId): Promise<string> {
  return valor(await crearConversacion(dueno, { campaignId })).id;
}

async function publicar(conv: string, dueno: User, content = 'Hola', sourceIds: string[] = []) {
  return valor(
    await publicarMensaje(dueno, {
      conversationId: conv,
      clientMessageId: clave(),
      content,
      sourceIds,
      runConfig: CONFIG_DE_RUN_DE_PRUEBA,
    }),
  );
}

beforeAll(async () => {
  e = await crearEscenarioDeChat('Vistas del chat');
});

afterAll(async () => {
  await eliminarCampanaDePrueba(e.campanas);
  await closePool();
});

describe('conversación de la campaña', () => {
  it('no crea nada al leer: sin conversación devuelve null (y sigue sin haberla)', async () => {
    const campana = await nuevaCampana('sin-conversacion');
    expect(valor(await obtenerConversacionDeCampana(e.consultor, campana))).toBeNull();
    expect(valor(await obtenerConversacionDeCampana(e.consultor, campana))).toBeNull();
    const [conteo] = await query<{ n: string }>(
      `SELECT count(*)::text AS n FROM chat_conversations WHERE campaign_id = $1`,
      [campana],
    );
    expect(conteo?.n).toBe('0');
  });

  it('devuelve la conversación activa propia (la más antigua si hubiera dos) y solo la propia', async () => {
    const campana = await nuevaCampana('propia');
    const primera = await conversacion(e.consultor, campana);
    await conversacion(e.consultor, campana);
    const vista = valor(await obtenerConversacionDeCampana(e.consultor, campana));
    expect(vista?.id).toBe(primera);
    expect(vista).not.toHaveProperty('createdBy');
    expect(vista).not.toHaveProperty('organizationId');
    // Otras personas, aunque sean de la misma organización y admin, no la ven.
    expect(valor(await obtenerConversacionDeCampana(e.director, campana))).toBeNull();
    expect(valor(await obtenerConversacionDeCampana(e.admin, campana))).toBeNull();
  });

  it('roles sin chat, cliente y otra organización: denegados', async () => {
    expect(codigo(await obtenerConversacionDeCampana(e.operativo, e.campanaId))).toBe('FORBIDDEN_ROLE');
    expect(codigo(await obtenerConversacionDeCampana(e.analista, e.campanaId))).toBe('FORBIDDEN_ROLE');
    expect(codigo(await obtenerConversacionDeCampana(e.legal, e.campanaId))).toBe('FORBIDDEN_ROLE');
    expect(codigo(await obtenerConversacionDeCampana(e.cliente, e.campanaId))).toBe('FORBIDDEN_ROLE');
    // Campaña de otra agencia / inexistente / mal formada: misma respuesta.
    expect(codigo(await obtenerConversacionDeCampana(e.consultor, e.campanaAjenaId))).toBe(
      'RESOURCE_NOT_FOUND',
    );
    expect(codigo(await obtenerConversacionDeCampana(e.ajeno, e.campanaId))).toBe('RESOURCE_NOT_FOUND');
    expect(codigo(await obtenerConversacionDeCampana(e.consultor, INEXISTENTE))).toBe('RESOURCE_NOT_FOUND');
    expect(codigo(await obtenerConversacionDeCampana(e.consultor, 'no-es-uuid'))).toBe('RESOURCE_NOT_FOUND');
  });
});

describe('mensajes, adjuntos y citas', () => {
  it('muestra adjuntos con su estado y citas legibles, sin URL ni rutas de almacenamiento', async () => {
    const campana = await nuevaCampana('mensajes');
    const archivo = await crearFuenteDePrueba(campana, e.admin, 'informe-q4');
    const fragmento = await crearFragmentoDePrueba(archivo, 1, 'Texto del informe', 3);
    const enlace = valor(
      await registerLinkedSource(e.admin, {
        campaignId: campana,
        url: 'https://docs.google.com/spreadsheets/d/ID-SECRETO-DEL-SHEET/edit',
        title: 'Hoja de influencers',
      }),
    );
    const conv = await conversacion(e.consultor, campana);
    const p = await publicar(conv, e.consultor, 'Mira esto', [archivo, enlace.id]);
    await iniciarRun(e.consultor, p.run.id, { contextHash: HASH, contextManifest: {} });
    valor(
      await completarRun(e.consultor, p.run.id, {
        content: 'El informe dice algo [S1].',
        references: [{ sourceId: archivo, fragmentId: fragmento }],
      }),
    );

    const mensajes = valor(await obtenerMensajesDeChat(e.consultor, conv));
    expect(mensajes.map((m) => m.role)).toEqual(['user', 'assistant']);
    const usuario = mensajes[0]!;
    expect(usuario.attachments).toHaveLength(2);
    const porNombre = Object.fromEntries(usuario.attachments.map((a) => [a.nombre, a]));
    expect(porNombre['informe-q4.md']).toMatchObject({ tipo: 'archivo', estado: 'listo', terminal: true });
    expect(porNombre['Hoja de influencers']).toMatchObject({ tipo: 'enlace', estado: 'enlace_sin_leer' });

    const asistente = mensajes[1]!;
    expect(asistente.citations).toEqual([
      expect.objectContaining({
        ordinal: 1,
        fuente: 'informe-q4.md',
        ubicacion: 'página 3',
        conFragmento: true,
      }),
    ]);

    // Nada de rutas, URLs ni hashes de archivo en el DTO.
    const json = JSON.stringify(mensajes);
    for (const prohibido of [
      'ID-SECRETO-DEL-SHEET',
      'docs.google.com',
      'external_url',
      'canonical_url',
      'file_id',
      'storage',
      'test/informe-q4.md',
      'hash-informe-q4',
    ]) {
      expect(json).not.toContain(prohibido);
    }
  });

  it('otra persona, otra organización o un cliente no leen los mensajes (misma respuesta que un id inexistente)', async () => {
    const conv = await conversacion(e.consultor);
    await publicar(conv, e.consultor, 'Privado');
    for (const intruso of [e.director, e.admin, e.ajeno, e.cliente, e.operativo]) {
      const r = await obtenerMensajesDeChat(intruso, conv);
      expect(r.ok, `${intruso.role} leyó`).toBe(false);
    }
    expect(codigo(await obtenerMensajesDeChat(e.director, conv))).toBe('RESOURCE_NOT_FOUND');
    expect(codigo(await obtenerMensajesDeChat(e.consultor, INEXISTENTE))).toBe('RESOURCE_NOT_FOUND');
    expect(codigo(await obtenerMensajesDeChat(e.consultor, 'no-es-uuid'))).toBe('RESOURCE_NOT_FOUND');
  });

  it('estadoDeAdjuntos: solo fuentes de la campaña; las ajenas o de otra campaña se omiten', async () => {
    const propia = await crearFuenteDePrueba(e.campanaId, e.admin, 'chip-propia');
    const otraCampana = await crearFuenteDePrueba(e.otraCampanaId, e.admin, 'chip-otra-campana');
    const ajena = await crearFuenteDePrueba(e.campanaAjenaId, e.ajeno, 'chip-ajena');
    await query(`UPDATE source_documents SET status = 'procesando' WHERE id = $1`, [propia]);
    const r = valor(
      await estadoDeAdjuntos(e.consultor, e.campanaId, [propia, otraCampana, ajena, INEXISTENTE, 'xx']),
    );
    expect(r.map((a) => a.sourceId)).toEqual([propia]);
    expect(r[0]).toMatchObject({ estado: 'procesando', terminal: false });
    expect(codigo(await estadoDeAdjuntos(e.cliente, e.campanaId, [propia]))).toBe('FORBIDDEN_ROLE');
    expect(codigo(await estadoDeAdjuntos(e.operativo, e.campanaId, [propia]))).toBe('FORBIDDEN_ROLE');
    expect(codigo(await estadoDeAdjuntos(e.ajeno, e.campanaId, [propia]))).toBe('RESOURCE_NOT_FOUND');
  });
});

describe('runs', () => {
  it('marca stale un run activo sin latido, y canCancel/canRetry según el estado', async () => {
    const conv = await conversacion(e.consultor);
    const p = await publicar(conv, e.consultor, 'Turno');
    let vista = valor(await cargarVistaDeChat(e.consultor, conv, { etiquetar }));
    expect(vista.runs).toHaveLength(1);
    expect(vista.runs[0]).toMatchObject({
      status: 'queued',
      stale: false,
      canCancel: true,
      canRetry: false,
      cancelRequested: false,
    });

    // Envejece el run (la identidad del run es inmutable: se desactiva el trigger solo en esta transacción).
    await adminTransaction(async (client) => {
      await client.query(`ALTER TABLE agent_runs DISABLE TRIGGER agent_runs_integridad`);
      await client.query(`UPDATE agent_runs SET queued_at = now() - interval '30 minutes' WHERE id = $1`, [
        p.run.id,
      ]);
      await client.query(`ALTER TABLE agent_runs ENABLE TRIGGER agent_runs_integridad`);
    });
    vista = valor(await cargarVistaDeChat(e.consultor, conv, { etiquetar }));
    expect(vista.runs[0]!.stale).toBe(true);

    // Un run fallido del último mensaje se puede reintentar.
    valor(await cancelarRun(e.consultor, p.run.id));
    vista = valor(await cargarVistaDeChat(e.consultor, conv, { etiquetar }));
    expect(vista.runs[0]).toMatchObject({ status: 'cancelled', canRetry: true, canCancel: false });
  });

  it('un run fallido expone un código y un mensaje cortos, y se reintenta solo si es el último mensaje', async () => {
    const conv = await conversacion(e.consultor);
    const p = await publicar(conv, e.consultor, 'Falla');
    valor(await iniciarRun(e.consultor, p.run.id, { contextHash: HASH, contextManifest: {} }));
    valor(
      await fallarRun(e.consultor, p.run.id, {
        errorCode: 'AGENT_MODEL_UNAVAILABLE',
        errorMessage: 'El modelo no está disponible en este momento.',
      }),
    );
    const runs = valor(await obtenerRunsRecientes(e.consultor, conv));
    expect(runs[0]).toMatchObject({
      status: 'failed',
      errorCode: 'AGENT_MODEL_UNAVAILABLE',
      errorMessage: 'El modelo no está disponible en este momento.',
    });
    expect(valor(await cargarVistaDeChat(e.consultor, conv)).runs[0]!.canRetry).toBe(true);
    expect(codigo(await obtenerRunsRecientes(e.director, conv))).toBe('RESOURCE_NOT_FOUND');
    // (cordura) el lector del caso de uso devuelve lo mismo que la vista
    expect(valor(await listarRunsDeConversacion(e.consultor, conv))).toHaveLength(1);
  });
});

describe('actividad de herramientas', () => {
  it('muestra la etiqueta en español y el estado; jamás el nombre interno, argumentos ni resultados', async () => {
    const conv = await conversacion(e.consultor);
    const p = await publicar(conv, e.consultor, 'Consulta');
    valor(await iniciarRun(e.consultor, p.run.id, { contextHash: HASH, contextManifest: {} }));
    const { invocation } = valor(
      await reclamarInvocacion(e.consultor, p.run.id, {
        stepIndex: 0,
        toolName: 'campaign_get',
        riskClass: 'read',
        args: { nota: 'ARGUMENTO-SECRETO-123' },
      }),
    );
    valor(
      await cerrarInvocacion(e.consultor, invocation.id, {
        status: 'succeeded',
        result: { campos: 7, texto: 'RESULTADO-SECRETO-456' },
      }),
    );
    const { invocation: desconocida } = valor(
      await reclamarInvocacion(e.consultor, p.run.id, {
        stepIndex: 1,
        toolName: 'herramienta_interna_sin_etiqueta',
        riskClass: 'write',
        args: {},
      }),
    );
    valor(await cerrarInvocacion(e.consultor, desconocida.id, { status: 'failed', errorCode: 'TOOL_FALLO' }));

    const actividad = valor(await listarActividadDeHerramientas(e.consultor, conv, { etiquetar }));
    expect(actividad.map((a) => [a.etiqueta, a.estado, a.tipo])).toEqual([
      ['Consultando la campaña', 'completada', 'consulta'],
      ['Usando una herramienta del asistente', 'fallida', 'cambio'],
    ]);
    const json = JSON.stringify(actividad);
    for (const prohibido of [
      'campaign_get',
      'herramienta_interna_sin_etiqueta',
      'ARGUMENTO-SECRETO-123',
      'RESULTADO-SECRETO-456',
      'TOOL_FALLO',
      'args',
      'idempotency',
    ]) {
      expect(json).not.toContain(prohibido);
    }
    expect(codigo(await listarActividadDeHerramientas(e.director, conv, { etiquetar }))).toBe(
      'RESOURCE_NOT_FOUND',
    );
  });
});

describe('acciones propuestas', () => {
  async function propuestaDeAprobacion(campana: string, conv: string, ttlSegundos?: number) {
    const creado = valor(await crearBriefManual(e.admin, campana));
    await query(`UPDATE brief_versions SET status = 'internal_review' WHERE id = $1`, [creado.versionId]);
    const propuesta = valor(
      await proponerAccion(e.consultor, {
        type: 'brief.approve',
        resourceId: creado.versionId,
        origin: 'chat',
        correlation: { conversationId: conv },
        campaignId: campana,
        ttlSegundos,
      }),
    );
    return { propuesta, versionId: creado.versionId };
  }

  it('el consultor ve su propuesta (no puede confirmar, sí cancelar); el director ve el pendiente y lo puede confirmar', async () => {
    const campana = await nuevaCampana('propuestas');
    const conv = await conversacion(e.consultor, campana);
    const { propuesta } = await propuestaDeAprobacion(campana, conv);

    const delConsultor = valor(await listarAccionesDeConversacion(e.consultor, conv));
    expect(delConsultor).toHaveLength(1);
    expect(delConsultor[0]).toMatchObject({
      id: propuesta.id,
      tipo: 'brief.approve',
      estado: 'pending',
      payloadHash: propuesta.payloadHash,
      obsoleta: false,
      propuestaPorMi: true,
      propuestaPorElAsistente: true,
      canConfirm: false,
      canRetryExecute: false,
      canCancel: true,
      esDeMiConversacion: true,
      quienConfirma: 'Administración o dirección',
    });
    expect(delConsultor[0]!.textoHumano).toBe('Aprobará la versión 1 del brief de esta campaña.');
    // El DTO no vuelca el payload crudo.
    expect(JSON.stringify(delConsultor)).not.toContain('contentFingerprint');

    // El director no ve la conversación del consultor, pero sí el pendiente de la campaña.
    expect(codigo(await listarAccionesDeConversacion(e.director, conv))).toBe('RESOURCE_NOT_FOUND');
    const pendientes = valor(await listarAccionesPendientesDeCampana(e.director, campana));
    expect(pendientes).toHaveLength(1);
    expect(pendientes[0]).toMatchObject({
      id: propuesta.id,
      propuestaPorMi: false,
      propuestaPor: e.consultor.name,
      canConfirm: true,
      esDeMiConversacion: false,
    });
    // El consultor no tiene nada propio que mostrar como «pendiente de otros» que pueda confirmar,
    // pero sí puede cancelar la suya: aparece porque es accionable.
    expect(valor(await listarAccionesPendientesDeCampana(e.consultor, campana)).map((a) => a.id)).toEqual([
      propuesta.id,
    ]);

    const paraConfirmar = valor(await obtenerAccionDeChat(e.director, campana, propuesta.id));
    expect(paraConfirmar.payloadHash).toBe(propuesta.payloadHash);
    expect(paraConfirmar.canConfirm).toBe(true);
  });

  it('alcance: otra campaña, otra organización, cliente y operativo reciben lo mismo que un id inexistente', async () => {
    const campana = await nuevaCampana('alcance-propuesta');
    const conv = await conversacion(e.consultor, campana);
    const { propuesta } = await propuestaDeAprobacion(campana, conv);

    expect(codigo(await obtenerAccionDeChat(e.director, e.otraCampanaId, propuesta.id))).toBe(
      'RESOURCE_NOT_FOUND',
    );
    expect(codigo(await obtenerAccionDeChat(e.ajeno, campana, propuesta.id))).toBe('RESOURCE_NOT_FOUND');
    expect(codigo(await obtenerAccionDeChat(e.director, campana, INEXISTENTE))).toBe('RESOURCE_NOT_FOUND');
    expect(codigo(await obtenerAccionDeChat(e.director, campana, 'no-es-uuid'))).toBe('RESOURCE_NOT_FOUND');
    for (const intruso of [e.cliente, e.operativo, e.analista, e.legal]) {
      expect((await obtenerAccionDeChat(intruso, campana, propuesta.id)).ok, intruso.role).toBe(false);
      expect((await listarAccionesPendientesDeCampana(intruso, campana)).ok, intruso.role).toBe(false);
    }
  });

  it('una propuesta que no nació en un chat de la campaña no se puede actuar desde el chat', async () => {
    const campana = await nuevaCampana('sin-chat');
    const creado = valor(await crearBriefManual(e.admin, campana));
    await query(`UPDATE brief_versions SET status = 'internal_review' WHERE id = $1`, [creado.versionId]);
    const propuesta = valor(
      await proponerAccion(e.consultor, {
        type: 'brief.approve',
        resourceId: creado.versionId,
        origin: 'ui',
      }),
    );
    expect(codigo(await obtenerAccionDeChat(e.director, campana, propuesta.id))).toBe('RESOURCE_NOT_FOUND');
    expect(valor(await listarAccionesPendientesDeCampana(e.director, campana))).toHaveLength(0);
  });

  it('obsoleta (lo propuesto cambió): no se confirma y lo dice', async () => {
    const campana = await nuevaCampana('obsoleta');
    const conv = await conversacion(e.consultor, campana);
    const { propuesta, versionId } = await propuestaDeAprobacion(campana, conv);

    // El brief cambia después de proponerse la aprobación: la huella de contenido ya no coincide.
    const [campo] = await query<{ id: string; revision: number }>(
      `SELECT id, revision FROM brief_fields WHERE brief_version_id = $1 LIMIT 1`,
      [versionId],
    );
    valor(
      await corregirCampo(e.admin, versionId, campo!.id, {
        value: 'cambio posterior',
        revisionEsperada: campo!.revision,
      }),
    );
    const vista = valor(await obtenerAccionDeChat(e.director, campana, propuesta.id));
    expect(vista).toMatchObject({ estado: 'pending', obsoleta: true, canConfirm: false });
  });

  it('vencida: el estado efectivo es expired aunque la fila siga pending', async () => {
    const campana = await nuevaCampana('vencida');
    const conv = await conversacion(e.consultor, campana);
    const { propuesta } = await propuestaDeAprobacion(campana, conv, 1);
    await new Promise((resolve) => setTimeout(resolve, 1200));
    const vista = valor(await obtenerAccionDeChat(e.director, campana, propuesta.id));
    expect(vista).toMatchObject({
      estado: 'expired',
      obsoleta: false,
      canConfirm: false,
      canRetryExecute: false,
      canCancel: false,
    });
  });

  it('cargarVistaDeChat reúne todo y no duplica las propias entre propuestas y pendientes', async () => {
    const campana = await nuevaCampana('vista-completa');
    const conv = await conversacion(e.consultor, campana);
    const p = await publicar(conv, e.consultor, 'Propón aprobar el brief');
    valor(await iniciarRun(e.consultor, p.run.id, { contextHash: HASH, contextManifest: {} }));
    const { propuesta } = await propuestaDeAprobacion(campana, conv);
    const { invocation } = valor(
      await reclamarInvocacion(e.consultor, p.run.id, {
        stepIndex: 0,
        toolName: 'brief_propose_approval',
        riskClass: 'confirmation_required',
        args: {},
      }),
    );
    valor(
      await cerrarInvocacion(e.consultor, invocation.id, {
        status: 'succeeded',
        proposedActionId: propuesta.id,
        result: { propuesta: propuesta.id },
      }),
    );
    valor(await completarRun(e.consultor, p.run.id, { content: 'Dejé la propuesta lista.' }));

    const vista = valor(await cargarVistaDeChat(e.consultor, conv, { etiquetar }));
    expect(vista.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(vista.runs[0]).toMatchObject({ status: 'completed', canRetry: false });
    expect(vista.activity.map((a) => [a.etiqueta, a.tipo])).toEqual([
      ['Proponiendo la aprobación del brief', 'propuesta'],
    ]);
    expect(vista.proposals.map((a) => a.id)).toEqual([propuesta.id]);
    expect(vista.proposals[0]!.runId).toBe(p.run.id);
    expect(vista.pending).toEqual([]);

    // El director no ve la conversación, pero su vista de pendientes la trae.
    expect(codigo(await cargarVistaDeChat(e.director, conv))).toBe('RESOURCE_NOT_FOUND');
  });
});
