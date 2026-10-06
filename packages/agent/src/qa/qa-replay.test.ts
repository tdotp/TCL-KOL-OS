/**
 * QA adversarial · vector 5 (idempotencia/replay) y parte del 11 (coste): BD real.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  closePool,
  crearBriefManual,
  fallarRun,
  publicarMensaje,
  query,
  reintentarRun,
  reclamarInvocacion,
} from '@tcl-kol-os/db';
import {
  CONFIG_DE_RUN_DE_PRUEBA,
  type EscenarioDeChat,
  crearEscenarioDeChat,
  eliminarCampanaDePrueba,
} from '@tcl-kol-os/db/test-utils';
import { MAX_EFECTOS_POR_RUN } from '../tools/executor.ts';
import {
  abrirTurno,
  clave,
  codigo,
  contar,
  json,
  llamar,
  nuevaCampana,
  registro,
} from './testing/harness.ts';

let e: EscenarioDeChat;
const r = registro();
const URL_BASE = 'https://docs.google.com/spreadsheets/d/1QaReplayQaReplayQaReplayQaReplayQa12/edit#gid=1';

beforeAll(async () => {
  e = await crearEscenarioDeChat('QA replay');
  const a = await crearBriefManual(e.admin, e.campanaId);
  if (!a.ok) throw new Error('brief manual');
});
afterAll(async () => {
  await eliminarCampanaDePrueba(e.campanas);
  await closePool();
});

describe('V5 · misma tool_call_id', () => {
  it('dos llamadas SIMULTÁNEAS con el mismo id de una tool de escritura: un solo efecto, la otra es `tool_in_progress` o replay', async () => {
    const campana = await nuevaCampana(e.admin.organizationId, e.admin.id, 'Carrera', e.campanas);
    const t = await abrirTurno(e.consultor, campana, 'ponle de nombre "Carrera Uno"');
    const id = clave();
    const args = { name: 'Carrera Uno', evidenceQuote: 'ponle de nombre' };
    t.step += 1;
    const ctx = {
      actor: t.actor,
      campaignId: t.campaignId,
      conversationId: t.conversationId,
      messageId: t.messageId,
      agentRunId: t.runId,
      stepIndex: t.step,
      referencias: t.referencias,
      textosDelActor: t.textos,
      messageText: t.textos[0] ?? '',
      adjuntosDelActor: [],
      adjuntosPorMensaje: [],
    };
    const resultados = await Promise.all(
      Array.from({ length: 8 }, () =>
        r.execute({ context: ctx, call: { id, name: 'campaign_update_metadata', arguments: args } }),
      ),
    );
    const exitosas = resultados.filter((x) => x.status === 'succeeded' && json(x)['replayed'] !== true);
    expect(exitosas).toHaveLength(1);
    for (const x of resultados) {
      if (x === exitosas[0]) continue;
      const reason = (json(x)['error'] as { details?: { reason?: string } } | undefined)?.details?.reason;
      expect(reason === 'tool_in_progress' || json(x)['replayed'] === true).toBe(true);
    }
    expect(await contar(`agent_tool_invocations WHERE agent_run_id = $1`, [t.runId])).toBe(1);
    expect(await contar(`audit_events WHERE entity_id = $1 AND action = 'campaign.update'`, [campana])).toBe(
      1,
    );
  });

  it('el mismo id con OTRO nombre de tool y los mismos argumentos NO ejecuta un efecto distinto (read→write con claim de lectura)', async () => {
    const t = await abrirTurno(e.consultor, e.campanaId, 'hola');
    const id = clave();
    // una lectura sin argumentos queda `succeeded` con riskClass=read
    expect((await llamar(r, t, 'campaign_get', {}, id)).status).toBe('succeeded');
    // todas las tools de ESCRITURA exigen `evidenceQuote`: con {} no pueden ejecutarse reutilizando el claim de lectura
    t.step -= 1;
    for (const tool of [
      'campaign_update_metadata',
      'brief_extract',
      'brief_request_internal_review',
      'sheet_sync',
    ]) {
      const x = await llamar(r, t, tool, {}, id);
      t.step -= 1;
      expect(x.status, tool).toBe('failed');
    }
    expect(await contar(`audit_events WHERE correlation->>'agentRunId' = $1`, [t.runId])).toBe(0);
  });

  it('una invocación que quedó `running` (proceso caído a medias) NO se vuelve a ejecutar con la misma llamada', async () => {
    const campana = await nuevaCampana(e.admin.organizationId, e.admin.id, 'Caída', e.campanas);
    const t = await abrirTurno(e.consultor, campana, 'ponle de nombre "Tras la caída"');
    const id = clave();
    const abierta = await reclamarInvocacion(e.consultor, t.runId, {
      stepIndex: 1,
      toolCallId: id,
      toolName: 'campaign_update_metadata',
      riskClass: 'write',
      args: { name: 'Tras la caída', evidenceQuote: 'ponle de nombre' },
    });
    expect(abierta.ok && abierta.value.claimed).toBe(true);
    t.step = 1;
    const x = await llamar(
      r,
      t,
      'campaign_update_metadata',
      { name: 'Tras la caída', evidenceQuote: 'ponle de nombre' },
      id,
    );
    t.step = 1;
    expect(x.status).toBe('failed');
    expect(json(x)['error']).toMatchObject({ details: { reason: 'tool_in_progress' } });
    const [c] = await query<{ name: string }>(`SELECT name FROM campaigns WHERE id = $1`, [campana]);
    expect(c!.name).not.toBe('Tras la caída');
  });
});

describe('V5 · reintento de run tras un fallo con efectos previos', () => {
  it('reintentarRun (attempt 2) re-ejecutando las mismas tools no duplica enlaces, propuestas ni nombres', async () => {
    const campana = await nuevaCampana(e.admin.organizationId, e.admin.id, 'Reintento', e.campanas);
    const texto = `Registra ${URL_BASE} y ponle de nombre "Reintento Final"`;
    const t1 = await abrirTurno(e.consultor, campana, texto);
    const reg1 = await llamar(r, t1, 'source_register_link', { url: URL_BASE });
    expect(reg1.status).toBe('succeeded');
    const nom1 = await llamar(r, t1, 'campaign_update_metadata', {
      name: 'Reintento Final',
      evidenceQuote: 'ponle de nombre',
    });
    expect(nom1.status).toBe('succeeded');
    // el run falla a mitad (p. ej. caída del proveedor)
    expect((await fallarRun(e.consultor, t1.runId, { errorCode: 'AGENT_MODEL_UNAVAILABLE' })).ok).toBe(true);
    const intento = await reintentarRun(e.consultor, t1.messageId, CONFIG_DE_RUN_DE_PRUEBA);
    expect(intento.ok).toBe(true);
    if (!intento.ok) return;
    // ejecutar el run 2 «a mano»: iniciarlo y repetir las mismas llamadas
    const { iniciarRun } = await import('@tcl-kol-os/db');
    expect(
      (await iniciarRun(e.consultor, intento.value.id, { contextHash: 'a'.repeat(64), contextManifest: {} }))
        .ok,
    ).toBe(true);
    const t2 = { ...t1, runId: intento.value.id, step: 0 };
    const reg2 = await llamar(r, t2, 'source_register_link', { url: URL_BASE });
    expect(json(reg2)['alreadyRegistered']).toBe(true);
    const nom2 = await llamar(r, t2, 'campaign_update_metadata', {
      name: 'Reintento Final',
      evidenceQuote: 'ponle de nombre',
    });
    expect(nom2.status).toBe('succeeded');
    expect(json(nom2)['changed']).toBe(false);
    expect(await contar(`source_documents WHERE campaign_id = $1 AND origin = 'link'`, [campana])).toBe(1);
    expect(await contar(`audit_events WHERE entity_id = $1 AND action = 'campaign.update'`, [campana])).toBe(
      1,
    );
  });
});

describe('V5 · runs concurrentes por conversación', () => {
  it('N publicarMensaje simultáneos con claves distintas: exactamente un run activo y un mensaje de usuario', async () => {
    const t = await abrirTurno(e.consultor, e.campanaId, 'primer mensaje');
    // abrirTurno dejó un run `running`: ningún mensaje nuevo entra hasta que termine
    const resultados = await Promise.all(
      Array.from({ length: 6 }, () =>
        publicarMensaje(e.consultor, {
          conversationId: t.conversationId,
          clientMessageId: clave(),
          content: 'otro mensaje',
          runConfig: CONFIG_DE_RUN_DE_PRUEBA,
        }),
      ),
    );
    expect(resultados.every((x) => !x.ok)).toBe(true);
    expect(await contar(`chat_messages WHERE conversation_id = $1`, [t.conversationId])).toBe(1);
    expect(
      await contar(`agent_runs WHERE conversation_id = $1 AND status IN ('queued','running')`, [
        t.conversationId,
      ]),
    ).toBe(1);
  });

  it('con la conversación libre, 8 envíos simultáneos con claves distintas dejan UN mensaje y UN run (los demás: run_in_progress)', async () => {
    const t = await abrirTurno(e.consultor, e.campanaId, 'abre');
    await fallarRun(e.consultor, t.runId, { errorCode: 'RUN_CANCELADO_POR_QA' });
    const resultados = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        publicarMensaje(e.consultor, {
          conversationId: t.conversationId,
          clientMessageId: clave(),
          content: `mensaje ${i}`,
          runConfig: CONFIG_DE_RUN_DE_PRUEBA,
        }),
      ),
    );
    expect(resultados.filter((x) => x.ok)).toHaveLength(1);
    expect(
      await contar(`chat_messages WHERE conversation_id = $1 AND role = 'user'`, [t.conversationId]),
    ).toBe(2);
    expect(
      await contar(`agent_runs WHERE conversation_id = $1 AND status IN ('queued','running')`, [
        t.conversationId,
      ]),
    ).toBe(1);
  });

  it('mismo clientMessageId con contenido distinto: client_message_id_reused; con el mismo contenido: replay sin duplicar', async () => {
    const t = await abrirTurno(e.consultor, e.campanaId, 'cierra');
    await fallarRun(e.consultor, t.runId, { errorCode: 'RUN_CANCELADO_POR_QA' });
    const id = clave();
    const a = await publicarMensaje(e.consultor, {
      conversationId: t.conversationId,
      clientMessageId: id,
      content: 'contenido A',
      runConfig: CONFIG_DE_RUN_DE_PRUEBA,
    });
    expect(a.ok).toBe(true);
    const b = await publicarMensaje(e.consultor, {
      conversationId: t.conversationId,
      clientMessageId: id,
      content: 'contenido B',
      runConfig: CONFIG_DE_RUN_DE_PRUEBA,
    });
    expect(!b.ok && b.error.details?.['reason']).toBe('client_message_id_reused');
    const c = await publicarMensaje(e.consultor, {
      conversationId: t.conversationId,
      clientMessageId: id,
      content: 'contenido A',
      runConfig: CONFIG_DE_RUN_DE_PRUEBA,
    });
    expect(c.ok && c.value.replayed).toBe(true);
    expect(
      await contar(`chat_messages WHERE conversation_id = $1 AND client_message_id = $2`, [
        t.conversationId,
        id,
      ]),
    ).toBe(1);
  });
});

describe('V5/V11 · cuota y presupuesto', () => {
  it('brief_extract: la cuota 1/run no se salta variando la cita ni con ids de llamada distintos', async () => {
    const campana = await nuevaCampana(e.admin.organizationId, e.admin.id, 'Cuota', e.campanas);
    const t = await abrirTurno(e.consultor, campana, 'Extrae el brief ahora mismo, por favor, extrae');
    const primera = await llamar(r, t, 'brief_extract', { evidenceQuote: 'Extrae el brief ahora mismo' });
    expect(primera.riskClass).toBe('write');
    for (const q of ['por favor, extrae', 'Extrae el brief', 'extrae']) {
      const x = await llamar(r, t, 'brief_extract', { evidenceQuote: q });
      expect(codigo(x), q).toBe('TOOL_BUDGET_EXCEEDED');
    }
  });

  it('el tope de efectos (10) se aplica por run aunque las llamadas sean distintas tools', async () => {
    const campana = await nuevaCampana(e.admin.organizationId, e.admin.id, 'Efectos', e.campanas);
    const t = await abrirTurno(
      e.consultor,
      campana,
      'Genera las preguntas, envía a revisión y cambia el nombre a "Tope"',
    );
    const llamadas: Promise<unknown>[] = [];
    const tools: [string, Record<string, unknown>][] = [
      ['brief_generate_questions', { evidenceQuote: 'Genera las preguntas' }],
      ['brief_request_internal_review', { evidenceQuote: 'envía a revisión' }],
      ['campaign_update_metadata', { name: 'Tope', evidenceQuote: 'cambia el nombre a' }],
    ];
    const salidas: (string | undefined)[] = [];
    for (let i = 0; i < MAX_EFECTOS_POR_RUN + 3; i++) {
      const [n, a] = tools[i % tools.length]!;
      const x = await llamar(r, t, n, a);
      salidas.push(x.errorCode);
    }
    void llamadas;
    expect(salidas.slice(MAX_EFECTOS_POR_RUN).every((c) => c === 'TOOL_BUDGET_EXCEEDED')).toBe(true);
  });

  it('las lecturas se limitan a 25 por run con ids de llamada distintos', async () => {
    const t = await abrirTurno(e.consultor, e.campanaId, 'hola');
    const salidas: (string | undefined)[] = [];
    for (let i = 0; i < 28; i++) salidas.push((await llamar(r, t, 'campaign_get', {})).errorCode);
    expect(salidas.slice(0, 25).every((c) => c === undefined)).toBe(true);
    expect(salidas.slice(25).every((c) => c === 'TOOL_BUDGET_EXCEEDED')).toBe(true);
  });
});
