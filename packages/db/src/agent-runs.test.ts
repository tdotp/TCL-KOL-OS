/**
 * V2 · Fase 6 — casos de uso de mensajes, runs del agente e invocaciones de tools.
 *
 * Idempotencia por `clientMessageId`, un solo run activo (también bajo
 * concurrencia), ciclo de vida del run, cancelación, reintento (attempt + 1),
 * barrido de abandonados, claim de invocaciones de tools y costo por run.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AgentRun, ChatMessage, Result, User } from '@tcl-kol-os/domain';
import { closePool, query, transaction } from './client.ts';
import { archivarConversacion, crearConversacion } from './chat-conversations.ts';
import { listarMensajes, publicarMensaje } from './chat-messages.ts';
import {
  abandonarRunsCaducados,
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
import { cerrarInvocacion, listarInvocacionesDeRun, reclamarInvocacion } from './agent-tool-invocations.ts';
import {
  CONFIG_DE_RUN_DE_PRUEBA,
  type EscenarioDeChat,
  crearEscenarioDeChat,
  eliminarCampanaDePrueba,
} from './test-utils.ts';

let e: EscenarioDeChat;
let contador = 0;

const HASH = 'f'.repeat(64);

function valor<T>(r: Result<T>): T {
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
  return r.value;
}
type Resultado = { readonly ok: true } | { readonly ok: false; readonly error: { readonly code: string } };
const codigo = (r: Resultado) => (r.ok ? undefined : r.error.code);
const razon = (r: Result<unknown>) => (r.ok ? undefined : r.error.details?.['reason']);

const clave = () => `cm-${Date.now().toString(36)}-${++contador}-xxxxxxxx`;

async function conversacion(dueno: User = e.consultor, campana = e.campanaId): Promise<string> {
  return valor(await crearConversacion(dueno, { campaignId: campana })).id;
}

async function publicar(conv: string, dueno: User = e.consultor, contenido = 'Hola agente', id = clave()) {
  return publicarMensaje(dueno, {
    conversationId: conv,
    clientMessageId: id,
    content: contenido,
    runConfig: CONFIG_DE_RUN_DE_PRUEBA,
  });
}

/** Mensaje publicado + run iniciado, listo para usar tools o completar. */
async function turnoEnEjecucion(dueno: User = e.consultor) {
  const conv = await conversacion(dueno);
  const publicado = valor(await publicar(conv, dueno));
  const run = valor(
    await iniciarRun(dueno, publicado.run.id, { contextHash: HASH, contextManifest: { fuentes: 0 } }),
  );
  return { conv, mensaje: publicado.message, run };
}

async function auditoriaDe(entityId: string) {
  return query<{
    action: string;
    origin: string | null;
    actor_id: string | null;
    metadata: Record<string, unknown>;
  }>(
    `SELECT action, origin, actor_id, metadata FROM audit_events WHERE entity_id = $1 ORDER BY created_at, id`,
    [entityId],
  );
}

beforeAll(async () => {
  e = await crearEscenarioDeChat('Runs del agente');
});

afterAll(async () => {
  await eliminarCampanaDePrueba(e.campanas);
  await closePool();
});

describe('publicarMensaje', () => {
  it('crea el mensaje (seq 1) y el run en cola en una sola operación', async () => {
    const conv = await conversacion();
    const r = valor(await publicar(conv, e.consultor, 'Resume el brief'));
    expect(r.replayed).toBe(false);
    expect(r.message).toMatchObject({
      role: 'user',
      seq: 1,
      content: 'Resume el brief',
      userId: e.consultor.id,
      conversationId: conv,
    });
    expect(r.message.contentSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(r.run).toMatchObject({
      status: 'queued',
      attempt: 1,
      userMessageId: r.message.id,
      userId: e.consultor.id,
      tier: 'equilibrado',
      provider: 'prueba',
    });
  });

  it('es idempotente: reenviar con la misma clave devuelve el mismo mensaje y run', async () => {
    const conv = await conversacion();
    const id = clave();
    const a = valor(await publicar(conv, e.consultor, 'Mensaje único', id));
    const b = valor(await publicar(conv, e.consultor, 'Mensaje único', id));
    expect(b.replayed).toBe(true);
    expect(b.message.id).toBe(a.message.id);
    expect(b.run.id).toBe(a.run.id);
    const [{ n } = { n: '0' }] = await query<{ n: string }>(
      `SELECT count(*) AS n FROM chat_messages WHERE conversation_id = $1`,
      [conv],
    );
    expect(Number(n)).toBe(1);
    // El replay también funciona con el run ya en marcha (no es un «run en curso»).
    valor(await iniciarRun(e.consultor, a.run.id, { contextHash: HASH, contextManifest: {} }));
    expect(valor(await publicar(conv, e.consultor, 'Mensaje único', id)).replayed).toBe(true);
  });

  it('la misma clave con otro contenido es un conflicto, no un reemplazo', async () => {
    const conv = await conversacion();
    const id = clave();
    valor(await publicar(conv, e.consultor, 'Contenido original', id));
    const r = await publicar(conv, e.consultor, 'Contenido distinto', id);
    expect(codigo(r)).toBe('RESOURCE_CONFLICT');
    expect(razon(r)).toBe('client_message_id_reused');
  });

  it('valida el contenido, la clave y la configuración del run', async () => {
    const conv = await conversacion();
    expect(codigo(await publicar(conv, e.consultor, '   '))).toBe('VALIDATION_FAILED');
    expect(codigo(await publicar(conv, e.consultor, 'x'.repeat(20_001)))).toBe('VALIDATION_FAILED');
    expect(codigo(await publicar(conv, e.consultor, 'ok', 'corta'))).toBe('VALIDATION_FAILED');
    expect(
      codigo(
        await publicarMensaje(e.consultor, {
          conversationId: conv,
          clientMessageId: clave(),
          content: 'ok',
          runConfig: { ...CONFIG_DE_RUN_DE_PRUEBA, tier: 'gigante' as never },
        }),
      ),
    ).toBe('VALIDATION_FAILED');
    expect(valor(await listarMensajes(e.consultor, conv))).toHaveLength(0);
  });

  it('con un run activo no se admite otro mensaje', async () => {
    const conv = await conversacion();
    const primero = valor(await publicar(conv));
    const r = await publicar(conv);
    expect(codigo(r)).toBe('RESOURCE_CONFLICT');
    expect(razon(r)).toBe('run_in_progress');
    if (!r.ok) expect(r.error.details).toMatchObject({ runId: primero.run.id });
  });

  it('bajo concurrencia pasa exactamente UN mensaje: un run activo por conversación', async () => {
    const conv = await conversacion();
    const resultados = await Promise.all(
      Array.from({ length: 6 }, (_, i) => publicar(conv, e.consultor, `Mensaje concurrente ${i}`)),
    );
    expect(resultados.filter((r) => r.ok)).toHaveLength(1);
    expect(resultados.filter((r) => !r.ok).every((r) => razon(r) === 'run_in_progress')).toBe(true);
    const [{ n } = { n: '0' }] = await query<{ n: string }>(
      `SELECT count(*) AS n FROM agent_runs WHERE conversation_id = $1 AND status IN ('queued', 'running')`,
      [conv],
    );
    expect(Number(n)).toBe(1);
    expect(valor(await listarMensajes(e.consultor, conv))).toHaveLength(1);
  });

  it('el mismo mensaje reenviado en paralelo se deduplica', async () => {
    const conv = await conversacion();
    const id = clave();
    const resultados = await Promise.all(
      Array.from({ length: 5 }, () => publicar(conv, e.consultor, 'Doble clic', id)),
    );
    expect(resultados.every((r) => r.ok)).toBe(true);
    expect(new Set(resultados.map((r) => valor(r).message.id)).size).toBe(1);
    expect(resultados.filter((r) => valor(r).replayed)).toHaveLength(4);
  });

  it('una conversación archivada o una campaña archivada no reciben mensajes', async () => {
    const conv = await conversacion();
    valor(await archivarConversacion(e.consultor, conv));
    const r = await publicar(conv);
    expect(razon(r)).toBe('conversation_archived');

    const [c] = await query<{ id: string }>(
      `INSERT INTO campaigns (organization_id, name, owner_id, created_by) VALUES ($1, $2, $3, $3) RETURNING id`,
      [e.admin.organizationId, `Campaña a archivar · ${e.sufijo}`, e.admin.id],
    );
    e.campanas.push(c!.id);
    const conv2 = await conversacion(e.consultor, c!.id);
    await query(`UPDATE campaigns SET status = 'archivada' WHERE id = $1`, [c!.id]);
    expect(razon(await publicar(conv2))).toBe('campaign_not_active');
    expect(razon(await crearConversacion(e.consultor, { campaignId: c!.id }))).toBe('campaign_not_active');
  });
});

describe('ciclo de vida del run', () => {
  it('queued → running → completed con el mensaje del asistente; luego entra otro mensaje', async () => {
    const conv = await conversacion();
    const publicado = valor(await publicar(conv, e.consultor, 'Hola'));
    const inicio = valor(
      await iniciarRun(e.consultor, publicado.run.id, {
        contextHash: HASH,
        contextManifest: { fuentes: 2, fragmentos: 14 },
        requestId: 'req-1',
      }),
    );
    expect(inicio).toMatchObject({ status: 'running', contextHash: HASH, requestId: 'req-1' });
    expect(inicio.contextManifest).toEqual({ fuentes: 2, fragmentos: 14 });
    expect(inicio.startedAt).toBeDefined();
    // Solo se inicia una vez.
    expect(
      razon(await iniciarRun(e.consultor, publicado.run.id, { contextHash: HASH, contextManifest: {} })),
    ).toBe('run_not_queued');

    expect(valor(await latidoRun(e.consultor, publicado.run.id))).toEqual({ cancelRequested: false });

    const completado = valor(
      await completarRun(e.consultor, publicado.run.id, { content: 'Hola, ¿en qué te ayudo?' }),
    );
    expect(completado.run).toMatchObject({ status: 'completed' });
    expect(completado.run.finishedAt).toBeDefined();
    expect(completado.message).toMatchObject({
      role: 'assistant',
      seq: 2,
      userId: e.consultor.id,
      agentRunId: publicado.run.id,
      content: 'Hola, ¿en qué te ayudo?',
    });
    // Completar dos veces no duplica la respuesta.
    expect(razon(await completarRun(e.consultor, publicado.run.id, { content: 'otra' }))).toBe(
      'run_not_running',
    );

    valor(await publicar(conv, e.consultor, 'Otra pregunta'));
    const mensajes = valor(await listarMensajes(e.consultor, conv));
    expect(mensajes.map((m: ChatMessage) => [m.seq, m.role])).toEqual([
      [1, 'user'],
      [2, 'assistant'],
      [3, 'user'],
    ]);
  });

  it('el contexto del run se sanea: nada de razonamiento ni de secretos en el manifiesto', async () => {
    const conv = await conversacion();
    const p = valor(await publicar(conv));
    const run = valor(
      await iniciarRun(e.consultor, p.run.id, {
        contextHash: HASH,
        contextManifest: {
          fuentes: 1,
          razonamiento: 'ok',
          reasoning: 'el modelo pensó...',
          apiKey: 'sk-secreto',
        },
      }),
    );
    expect(run.contextManifest).toEqual({ fuentes: 1, razonamiento: 'ok', apiKey: '[redactado]' });
  });

  it('rechaza una huella de contexto inválida', async () => {
    const p = valor(await publicar(await conversacion()));
    expect(
      codigo(await iniciarRun(e.consultor, p.run.id, { contextHash: 'no-es-hash', contextManifest: {} })),
    ).toBe('VALIDATION_FAILED');
  });

  it('no se completa un run que no está en ejecución', async () => {
    const p = valor(await publicar(await conversacion()));
    expect(razon(await completarRun(e.consultor, p.run.id, { content: 'respuesta' }))).toBe(
      'run_not_running',
    );
    expect(codigo(await completarRun(e.consultor, p.run.id, { content: '  ' }))).toBe('VALIDATION_FAILED');
  });

  it('el latido de un run que ya no corre avisa al runtime', async () => {
    const p = valor(await publicar(await conversacion()));
    expect(razon(await latidoRun(e.consultor, p.run.id))).toBe('run_not_running');
  });

  it('fallarRun cierra el run y sus invocaciones abiertas; el código debe ser un identificador', async () => {
    const { run } = await turnoEnEjecucion();
    const abierta = valor(
      await reclamarInvocacion(e.consultor, run.id, {
        stepIndex: 0,
        toolName: 'campaign_get',
        riskClass: 'read',
        args: {},
      }),
    );
    expect(codigo(await fallarRun(e.consultor, run.id, { errorCode: 'texto libre' }))).toBe(
      'VALIDATION_FAILED',
    );
    const fallado = valor(
      await fallarRun(e.consultor, run.id, {
        errorCode: 'MODEL_UNAVAILABLE',
        errorMessage: 'El proveedor no respondió.\nReintente.',
      }),
    );
    expect(fallado).toMatchObject({
      status: 'failed',
      errorCode: 'MODEL_UNAVAILABLE',
      errorMessage: 'El proveedor no respondió. Reintente.',
    });
    const invocaciones = valor(await listarInvocacionesDeRun(e.consultor, run.id));
    expect(invocaciones.find((i) => i.id === abierta.invocation.id)).toMatchObject({
      status: 'failed',
      errorCode: 'RUN_FAILED',
    });
    // Idempotente con el mismo código; con otro, conflicto.
    expect(valor(await fallarRun(e.consultor, run.id, { errorCode: 'MODEL_UNAVAILABLE' })).status).toBe(
      'failed',
    );
    expect(razon(await fallarRun(e.consultor, run.id, { errorCode: 'OTRO_ERROR' }))).toBe('run_not_active');
  });

  it('no se escribe respuesta sin cerrar las invocaciones abiertas', async () => {
    const { run } = await turnoEnEjecucion();
    valor(
      await reclamarInvocacion(e.consultor, run.id, {
        stepIndex: 0,
        toolName: 'source_list',
        riskClass: 'read',
        args: {},
      }),
    );
    expect(razon(await completarRun(e.consultor, run.id, { content: 'listo' }))).toBe('tools_open');
  });
});

describe('cancelación', () => {
  it('un run en cola se cancela de inmediato y deja auditoría', async () => {
    const p = valor(await publicar(await conversacion()));
    const r = valor(await cancelarRun(e.consultor, p.run.id));
    expect(r.cancelled).toBe(true);
    expect(r.run.status).toBe('cancelled');
    expect(valor(await cancelarRun(e.consultor, p.run.id)).cancelled).toBe(true); // idempotente
    const eventos = await auditoriaDe(p.run.id);
    expect(eventos.filter((ev) => ev.action === 'agent_run.cancel')).toHaveLength(1);
    expect(eventos[0]).toMatchObject({ origin: 'ui', actor_id: e.consultor.id });
  });

  it('un run en ejecución: la solicitud llega al runtime por el latido y él confirma', async () => {
    const { run } = await turnoEnEjecucion();
    const abierta = valor(
      await reclamarInvocacion(e.consultor, run.id, {
        stepIndex: 0,
        toolName: 'source_list',
        riskClass: 'read',
        args: {},
      }),
    );
    const pedido = valor(await cancelarRun(e.consultor, run.id));
    expect(pedido.cancelled).toBe(false);
    expect(pedido.run.status).toBe('running');
    expect(pedido.run.cancelRequestedAt).toBeDefined();
    expect(valor(await latidoRun(e.consultor, run.id))).toEqual({ cancelRequested: true });
    // No se publica la respuesta de un turno cancelado.
    expect(razon(await completarRun(e.consultor, run.id, { content: 'respuesta tardía' }))).toBe(
      'cancel_requested',
    );
    const confirmado = valor(await confirmarCancelacionDeRun(e.consultor, run.id));
    expect(confirmado.status).toBe('cancelled');
    const invocaciones = valor(await listarInvocacionesDeRun(e.consultor, run.id));
    expect(invocaciones.find((i) => i.id === abierta.invocation.id)?.status).toBe('cancelled');
    // Solo se confirma lo que se pidió.
    const otro = await turnoEnEjecucion();
    expect(razon(await confirmarCancelacionDeRun(e.consultor, otro.run.id))).toBe('run_not_running');
  });

  it('un run terminado no se cancela', async () => {
    const { run } = await turnoEnEjecucion();
    valor(await completarRun(e.consultor, run.id, { content: 'hecho' }));
    expect(razon(await cancelarRun(e.consultor, run.id))).toBe('run_not_active');
  });
});

describe('reintento (D9: attempt + 1, sin auto-reencolado)', () => {
  it('un turno fallido se reintenta con attempt 2 y luego completa', async () => {
    const { conv, mensaje, run } = await turnoEnEjecucion();
    valor(await fallarRun(e.consultor, run.id, { errorCode: 'MODEL_UNAVAILABLE' }));
    const nuevo = valor(await reintentarRun(e.consultor, mensaje.id, CONFIG_DE_RUN_DE_PRUEBA));
    expect(nuevo).toMatchObject({ attempt: 2, status: 'queued', userMessageId: mensaje.id });
    expect(nuevo.id).not.toBe(run.id);
    // Mientras hay un intento activo no hay otro.
    expect(razon(await reintentarRun(e.consultor, mensaje.id, CONFIG_DE_RUN_DE_PRUEBA))).toBe(
      'run_in_progress',
    );
    valor(await iniciarRun(e.consultor, nuevo.id, { contextHash: HASH, contextManifest: {} }));
    valor(await completarRun(e.consultor, nuevo.id, { content: 'ahora sí' }));
    // Completado: ya no se reintenta.
    expect(razon(await reintentarRun(e.consultor, mensaje.id, CONFIG_DE_RUN_DE_PRUEBA))).toBe(
      'message_not_latest',
    );
    const runs = valor(await listarRunsDeConversacion(e.consultor, conv));
    expect(runs.map((r: AgentRun) => [r.attempt, r.status]).sort()).toEqual([
      [1, 'failed'],
      [2, 'completed'],
    ]);
    const eventos = await auditoriaDe(nuevo.id);
    expect(eventos.map((ev) => ev.action)).toContain('agent_run.retry');
  });

  it('no se reintenta un mensaje que ya no es el último ni uno de otra persona', async () => {
    const { conv, mensaje, run } = await turnoEnEjecucion();
    valor(await cancelarRun(e.consultor, run.id));
    valor(await confirmarCancelacionDeRun(e.consultor, run.id));
    valor(await publicar(conv, e.consultor, 'Mensaje posterior'));
    expect(razon(await reintentarRun(e.consultor, mensaje.id, CONFIG_DE_RUN_DE_PRUEBA))).toBe(
      'run_in_progress',
    );
    expect(codigo(await reintentarRun(e.admin, mensaje.id, CONFIG_DE_RUN_DE_PRUEBA))).toBe(
      'RESOURCE_NOT_FOUND',
    );
    expect(
      codigo(
        await reintentarRun(e.consultor, '00000000-0000-4000-8000-000000000000', CONFIG_DE_RUN_DE_PRUEBA),
      ),
    ).toBe('RESOURCE_NOT_FOUND');
  });
});

describe('barrido de runs abandonados (patrón SYNC_ABANDONED)', () => {
  it('un run en cola que nunca arrancó y un run sin latido se cierran como RUN_ABANDONED', async () => {
    const enCola = valor(await publicar(await conversacion()));
    const { run } = await turnoEnEjecucion();
    const abierta = valor(
      await reclamarInvocacion(e.consultor, run.id, {
        stepIndex: 0,
        toolName: 'source_list',
        riskClass: 'read',
        args: {},
      }),
    );
    // Aún no vencen.
    await abandonarRunsCaducados();
    expect(
      (await query<{ status: string }>(`SELECT status FROM agent_runs WHERE id = $1`, [run.id]))[0]!.status,
    ).toBe('running');
    // Dentro de 6 min vence el que sigue en cola (umbral 5), no el que corre (umbral 10).
    await abandonarRunsCaducados({ ahora: new Date(Date.now() + 6 * 60_000) });
    expect(valor(await obtenerRun(e.consultor, enCola.run.id))).toMatchObject({
      status: 'failed',
      errorCode: 'RUN_ABANDONED',
    });
    expect(valor(await obtenerRun(e.consultor, run.id)).status).toBe('running');
    // Dentro de 11 min vence el que corría y su invocación abierta.
    await abandonarRunsCaducados({ ahora: new Date(Date.now() + 11 * 60_000) });
    expect(valor(await obtenerRun(e.consultor, run.id))).toMatchObject({
      status: 'failed',
      errorCode: 'RUN_ABANDONED',
    });
    const invocaciones = valor(await listarInvocacionesDeRun(e.consultor, run.id));
    expect(invocaciones.find((i) => i.id === abierta.invocation.id)).toMatchObject({
      status: 'failed',
      errorCode: 'TOOL_ABANDONED',
    });
    // Deja auditoría del sistema y la conversación vuelve a admitir mensajes / reintento.
    const eventos = await auditoriaDe(run.id);
    expect(eventos.find((ev) => ev.action === 'agent_run.abandon')).toMatchObject({
      origin: 'system',
      actor_id: null,
    });
    const reintento = valor(await reintentarRun(e.consultor, enCola.message.id, CONFIG_DE_RUN_DE_PRUEBA));
    expect(reintento.attempt).toBe(2);
  });

  it('publicarMensaje recupera una conversación bloqueada por un run abandonado', async () => {
    const conv = await conversacion();
    const viejo = valor(await publicar(conv, e.consultor, 'Se quedó colgado'));
    // Envejece el run (la identidad del run es inmutable: se desactiva el trigger solo en esta transacción).
    await transaction(async (client) => {
      await client.query(`ALTER TABLE agent_runs DISABLE TRIGGER agent_runs_integridad`);
      await client.query(`UPDATE agent_runs SET queued_at = now() - interval '2 hours' WHERE id = $1`, [
        viejo.run.id,
      ]);
      await client.query(`ALTER TABLE agent_runs ENABLE TRIGGER agent_runs_integridad`);
    });
    const nuevo = valor(await publicar(conv, e.consultor, 'Segundo intento del usuario'));
    expect(nuevo.message.seq).toBe(2);
    expect(valor(await obtenerRun(e.consultor, viejo.run.id))).toMatchObject({
      status: 'failed',
      errorCode: 'RUN_ABANDONED',
    });
  });
});

describe('invocaciones de tools (claim de idempotencia)', () => {
  it('reclama, numera, es idempotente por clave y por tool_call_id, y se cierra una sola vez', async () => {
    const { run } = await turnoEnEjecucion();
    const a = valor(
      await reclamarInvocacion(e.consultor, run.id, {
        stepIndex: 0,
        toolCallId: 'call_1',
        toolName: 'campaign_get',
        riskClass: 'read',
        args: { campaignId: 'no-debería-importar' },
      }),
    );
    expect(a.claimed).toBe(true);
    expect(a.invocation).toMatchObject({
      sequence: 1,
      status: 'running',
      toolName: 'campaign_get',
      stepIndex: 0,
    });
    // Misma llamada: no se vuelve a reclamar.
    const repetida = valor(
      await reclamarInvocacion(e.consultor, run.id, {
        stepIndex: 0,
        toolCallId: 'call_1',
        toolName: 'campaign_get',
        riskClass: 'read',
        args: {},
      }),
    );
    expect(repetida.claimed).toBe(false);
    expect(repetida.invocation.id).toBe(a.invocation.id);
    // Otra llamada: secuencia 2.
    const b = valor(
      await reclamarInvocacion(e.consultor, run.id, {
        stepIndex: 1,
        toolCallId: 'call_2',
        toolName: 'source_list',
        riskClass: 'read',
        args: {},
      }),
    );
    expect(b.invocation.sequence).toBe(2);

    const cerrada = valor(
      await cerrarInvocacion(e.consultor, a.invocation.id, { status: 'succeeded', result: { fuentes: 3 } }),
    );
    expect(cerrada).toMatchObject({ status: 'succeeded', result: { fuentes: 3 } });
    expect(cerrada.finishedAt).toBeDefined();
    expect(razon(await cerrarInvocacion(e.consultor, a.invocation.id, { status: 'cancelled' }))).toBe(
      'tool_already_claimed',
    );
    // La repetición de una invocación ya exitosa devuelve su resultado (replay): no se re-ejecuta.
    const replay = valor(
      await reclamarInvocacion(e.consultor, run.id, {
        stepIndex: 0,
        toolCallId: 'call_1',
        toolName: 'campaign_get',
        riskClass: 'read',
        args: {},
      }),
    );
    expect(replay).toMatchObject({ claimed: false });
    expect(replay.invocation.result).toEqual({ fuentes: 3 });
  });

  it('concurrente: la misma clave obtiene el claim una sola vez', async () => {
    const { run } = await turnoEnEjecucion();
    const resultados = await Promise.all(
      Array.from({ length: 5 }, () =>
        reclamarInvocacion(e.consultor, run.id, {
          stepIndex: 0,
          toolCallId: 'call_concurrente',
          toolName: 'source_list',
          riskClass: 'read',
          args: {},
        }),
      ),
    );
    expect(resultados.every((r) => r.ok)).toBe(true);
    expect(resultados.filter((r) => valor(r).claimed)).toHaveLength(1);
    expect(new Set(resultados.map((r) => valor(r).invocation.id)).size).toBe(1);
  });

  it('sanea args y resultado: secretos redactados, razonamiento descartado, nada de texto enorme', async () => {
    const { run } = await turnoEnEjecucion();
    const { invocation } = valor(
      await reclamarInvocacion(e.consultor, run.id, {
        stepIndex: 0,
        toolName: 'brief_answer_question',
        riskClass: 'write',
        args: {
          questionId: 'q-1',
          token: 'abc',
          reasoning: 'primero pienso que...',
          anidado: { chain_of_thought: 'paso a paso', ok: 1, password: 'x' },
          largo: 'y'.repeat(5_000),
        },
      }),
    );
    expect(invocation.args).toMatchObject({
      questionId: 'q-1',
      token: '[redactado]',
      anidado: { ok: 1, password: '[redactado]' },
    });
    expect(JSON.stringify(invocation.args)).not.toMatch(/pienso|paso a paso|chain_of_thought|reasoning/);
    expect(String((invocation.args as { largo: string }).largo).length).toBeLessThanOrEqual(2_000);
    const cerrada = valor(
      await cerrarInvocacion(e.consultor, invocation.id, {
        status: 'succeeded',
        result: { thinking: 'hmm', ids: ['a', 'b'] },
      }),
    );
    expect(cerrada.result).toEqual({ ids: ['a', 'b'] });
  });

  it('una invocación fallida declara su código; una exitosa no lleva error', async () => {
    const { run } = await turnoEnEjecucion();
    const { invocation } = valor(
      await reclamarInvocacion(e.consultor, run.id, {
        stepIndex: 0,
        toolName: 'source_get',
        riskClass: 'read',
        args: {},
      }),
    );
    expect(codigo(await cerrarInvocacion(e.consultor, invocation.id, { status: 'failed' }))).toBe(
      'VALIDATION_FAILED',
    );
    expect(
      codigo(await cerrarInvocacion(e.consultor, invocation.id, { status: 'succeeded', errorCode: 'X1' })),
    ).toBe('VALIDATION_FAILED');
    expect(
      codigo(await cerrarInvocacion(e.consultor, invocation.id, { status: 'cancelled', result: {} })),
    ).toBe('VALIDATION_FAILED');
    const cerrada = valor(
      await cerrarInvocacion(e.consultor, invocation.id, {
        status: 'failed',
        errorCode: 'RESOURCE_NOT_FOUND',
      }),
    );
    expect(cerrada).toMatchObject({ status: 'failed', errorCode: 'RESOURCE_NOT_FOUND' });
  });

  it('solo un run en ejecución abre invocaciones y la tool desconocida deja traza (unregistered)', async () => {
    const enCola = valor(await publicar(await conversacion()));
    expect(
      razon(
        await reclamarInvocacion(e.consultor, enCola.run.id, {
          stepIndex: 0,
          toolName: 'x',
          riskClass: 'read',
          args: {},
        }),
      ),
    ).toBe('run_not_running');
    const { run } = await turnoEnEjecucion();
    const { invocation } = valor(
      await reclamarInvocacion(e.consultor, run.id, {
        stepIndex: 0,
        toolName: 'aprobarBrief',
        riskClass: 'unregistered',
        args: { versionId: 'v' },
      }),
    );
    valor(
      await cerrarInvocacion(e.consultor, invocation.id, {
        status: 'failed',
        errorCode: 'TOOL_NOT_REGISTERED',
      }),
    );
    expect(
      codigo(
        await reclamarInvocacion(e.consultor, run.id, {
          stepIndex: 0,
          toolName: 'x',
          riskClass: 'peligrosa' as never,
          args: {},
        }),
      ),
    ).toBe('VALIDATION_FAILED');
  });

  it('solo una tool de confirmación requerida enlaza una acción propuesta (misma campaña)', async () => {
    const { run } = await turnoEnEjecucion();
    const lectura = valor(
      await reclamarInvocacion(e.consultor, run.id, {
        stepIndex: 0,
        toolName: 'source_list',
        riskClass: 'read',
        args: {},
      }),
    );
    expect(
      codigo(
        await cerrarInvocacion(e.consultor, lectura.invocation.id, {
          status: 'succeeded',
          proposedActionId: '00000000-0000-4000-8000-000000000001',
        }),
      ),
    ).toBe('VALIDATION_FAILED');
    const propuesta = valor(
      await reclamarInvocacion(e.consultor, run.id, {
        stepIndex: 1,
        toolName: 'brief_propose_approval',
        riskClass: 'confirmation_required',
        args: {},
      }),
    );
    // Una propuesta que no existe en la campaña se rechaza.
    expect(
      codigo(
        await cerrarInvocacion(e.consultor, propuesta.invocation.id, {
          status: 'succeeded',
          proposedActionId: '00000000-0000-4000-8000-000000000001',
        }),
      ),
    ).toBe('VALIDATION_FAILED');
    // Una propuesta de OTRA campaña tampoco (FK compuesta con la campaña del run).
    const [ajena] = await query<{ id: string }>(
      `INSERT INTO proposed_actions (organization_id, campaign_id, action_type, resource_type, resource_id, payload,
                                     payload_hash, proposed_origin, expires_at)
       VALUES ($1, $2, 'brief.approve', 'brief_version', uuid_generate_v4(), '{}'::jsonb, 'h', 'chat', now() + interval '1 day')
       RETURNING id`,
      [e.admin.organizationId, e.otraCampanaId],
    );
    expect(
      codigo(
        await cerrarInvocacion(e.consultor, propuesta.invocation.id, {
          status: 'succeeded',
          proposedActionId: ajena!.id,
        }),
      ),
    ).toBe('VALIDATION_FAILED');
    const [propia] = await query<{ id: string }>(
      `INSERT INTO proposed_actions (organization_id, campaign_id, action_type, resource_type, resource_id, payload,
                                     payload_hash, proposed_origin, expires_at)
       VALUES ($1, $2, 'brief.approve', 'brief_version', uuid_generate_v4(), '{}'::jsonb, 'h', 'chat', now() + interval '1 day')
       RETURNING id`,
      [e.admin.organizationId, e.campanaId],
    );
    const cerrada = valor(
      await cerrarInvocacion(e.consultor, propuesta.invocation.id, {
        status: 'succeeded',
        proposedActionId: propia!.id,
        result: { proposedActionId: propia!.id },
      }),
    );
    expect(cerrada.proposedActionId).toBe(propia!.id);
  });
});

describe('costo por run (ai_runs)', () => {
  it('registra cada llamada del turno enlazada al run y suma costo y tokens', async () => {
    const { run } = await turnoEnEjecucion();
    for (const paso of [0, 1]) {
      valor(
        await registrarLlamadaDeModelo(e.consultor, run.id, {
          stepIndex: paso,
          tier: 'equilibrado',
          provider: 'prueba',
          model: 'modelo-de-prueba',
          promptVersion: 'prompt-prueba-1',
          inputHash: HASH,
          outputStatus: 'ok',
          latencyMs: 120,
          promptTokens: 1000,
          completionTokens: 200,
          costUsd: 0.0125,
          generationId: `gen-${paso}`,
        }),
      );
    }
    const costo = valor(await costoDeRun(e.consultor, run.id));
    expect(costo).toEqual({ llamadas: 2, promptTokens: 2000, completionTokens: 400, costUsd: 0.025 });
    const filas = await query<{
      task: string;
      agent_run_id: string;
      step_index: number;
      campaign_id: string;
    }>(
      `SELECT task, agent_run_id, step_index, campaign_id FROM ai_runs WHERE agent_run_id = $1 ORDER BY step_index`,
      [run.id],
    );
    expect(filas).toEqual([
      { task: 'conversar', agent_run_id: run.id, step_index: 0, campaign_id: e.campanaId },
      { task: 'conversar', agent_run_id: run.id, step_index: 1, campaign_id: e.campanaId },
    ]);
  });

  it('otra persona no registra costo en un run ajeno', async () => {
    const { run } = await turnoEnEjecucion();
    const r = await registrarLlamadaDeModelo(e.admin, run.id, {
      stepIndex: 0,
      tier: 'equilibrado',
      provider: 'p',
      model: 'm',
      promptVersion: 'v',
      inputHash: HASH,
      outputStatus: 'ok',
    });
    expect(codigo(r)).toBe('RESOURCE_NOT_FOUND');
  });
});
