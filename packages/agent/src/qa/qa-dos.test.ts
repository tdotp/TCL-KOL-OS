/**
 * QA adversarial · vector 11 (DoS / coste): bucles de tool calls, pasos máximos, plazo, tamaño de
 * resultados, reintentos del cliente de modelo y costos. Runtime real + registro real + BD real.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { closePool, costoDeRun, derivarNonce, query } from '@tcl-kol-os/db';
import {
  type EscenarioDeChat,
  crearEscenarioDeChat,
  crearFragmentoDePrueba,
  crearFuenteDePrueba,
  eliminarCampanaDePrueba,
} from '@tcl-kol-os/db/test-utils';
import { cerrarServidores, responder, servidor } from '../model/testing/servidor-falso.ts';
import { ScriptedModel, respuestaConTools, respuestaFinal } from '../model/scripted-model.ts';
import { WorkerModelClient } from '../model/worker-model-client.ts';
import { ejecutarRun } from '../runtime/ejecutar-run.ts';
import {
  SECRETO_DE_PRUEBA,
  admitir,
  dependencias,
  entornoDePrueba,
  filaDelRun,
  mensajesDeLaConversacion,
  nuevaConversacion,
  valor,
} from '../runtime/testing/harness.ts';
import { MAX_OUTPUT_BYTES } from '../tools/projection.ts';
import { createToolRegistry } from '../tools/registry.ts';
import { abrirTurno, llamar, nuevaCampana, registro } from './testing/harness.ts';

let e: EscenarioDeChat;
const registry = createToolRegistry({
  nonceForRun: (runId) => derivarNonce(SECRETO_DE_PRUEBA, runId),
  onUnexpectedError: () => undefined,
});
const r = registro();

beforeAll(async () => {
  e = await crearEscenarioDeChat('QA DoS');
});
afterEach(cerrarServidores);
afterAll(async () => {
  await eliminarCampanaDePrueba(e.campanas);
  await closePool();
});

describe('V11 · bucles y paso máximo', () => {
  it('un modelo que SIEMPRE pide tools se detiene en el tope de pasos (8) con un mensaje determinístico y sin otra llamada de modelo', async () => {
    const campana = await nuevaCampana(e.admin.organizationId, e.admin.id, 'Bucle', e.campanas);
    const ent = entornoDePrueba();
    const conv = await nuevaConversacion(e.consultor, campana);
    const t = await admitir(e.consultor, conv, 'Hola', ent);
    let vueltas = 0;
    const modelo = new ScriptedModel(
      Array.from({ length: 50 }, () => () => {
        vueltas += 1;
        return respuestaConTools([
          { id: `l${vueltas}a`, name: 'campaign_get' },
          { id: `l${vueltas}b`, name: 'source_list' },
          { id: `l${vueltas}c`, name: 'brief_get_workspace' },
          { id: `l${vueltas}d`, name: 'influencer_list_participants' },
        ]);
      }),
    );
    const res = valor(await ejecutarRun(e.consultor, t.run.id, dependencias(modelo, registry, ent)));
    expect(res.salida).toBe('step_limit');
    expect(res.status).toBe('completed');
    expect(modelo.llamadas).toBe(8);
    expect(res.toolCalls).toBeLessThanOrEqual(8 * 4);
    const asistente = (await mensajesDeLaConversacion(conv)).find((m) => m.role === 'assistant')!;
    expect(asistente.content).toContain('Alcancé el límite de 8 pasos');
    // el tope duro no se supera ni por entorno ni por parámetro
    const ent2 = entornoDePrueba({ AGENT_MAX_TOOL_STEPS: '9999' });
    const conv2 = await nuevaConversacion(e.consultor, campana);
    const t2 = await admitir(e.consultor, conv2, 'Hola de nuevo', ent2);
    const m2 = new ScriptedModel(
      Array.from({ length: 60 }, () => respuestaConTools([{ name: 'campaign_get' }])),
    );
    const res2 = valor(
      await ejecutarRun(
        e.consultor,
        t2.run.id,
        dependencias(m2, registry, ent2, { limites: { maxSteps: 10_000 } }),
      ),
    );
    expect(res2.salida).toBe('step_limit');
    expect(m2.llamadas).toBeLessThanOrEqual(15);
  });

  it('un paso con 200 tool calls ejecuta como mucho 4; las demás reciben su rechazo y NO se ejecutan', async () => {
    const campana = await nuevaCampana(e.admin.organizationId, e.admin.id, 'Ráfaga', e.campanas);
    const ent = entornoDePrueba();
    const conv = await nuevaConversacion(e.consultor, campana);
    const t = await admitir(e.consultor, conv, 'Hola', ent);
    const modelo = new ScriptedModel([
      respuestaConTools(Array.from({ length: 200 }, (_, i) => ({ id: `r${i}`, name: 'campaign_get' }))),
      respuestaFinal('Listo.'),
    ]);
    const res = valor(await ejecutarRun(e.consultor, t.run.id, dependencias(modelo, registry, ent)));
    expect(res.salida).toBe('completed');
    const n = await query<{ n: string }>(
      `SELECT count(*)::text AS n FROM agent_tool_invocations WHERE agent_run_id = $1`,
      [t.run.id],
    );
    expect(Number(n[0]!.n)).toBe(4);
    const respuestasAlModelo = modelo.requests[1]!.messages.filter((m) => m.role === 'tool');
    expect(respuestasAlModelo).toHaveLength(200); // cada llamada tiene su respuesta (contrato del proveedor)
  });

  it('el plazo del run se respeta: reloj que salta más allá del deadline → AGENT_RUN_TIMEOUT sin llamar al modelo otra vez', async () => {
    const campana = await nuevaCampana(e.admin.organizationId, e.admin.id, 'Plazo', e.campanas);
    const ent = entornoDePrueba({ AGENT_RUN_DEADLINE_S: '5' });
    const conv = await nuevaConversacion(e.consultor, campana);
    const t = await admitir(e.consultor, conv, 'Hola', ent);
    let ahora = Date.now();
    const modelo = new ScriptedModel([
      () => {
        ahora += 60_000; // el modelo «tarda» un minuto
        return respuestaConTools([{ name: 'campaign_get' }]);
      },
      respuestaFinal('no debería llegar'),
    ]);
    const res = valor(
      await ejecutarRun(
        e.consultor,
        t.run.id,
        dependencias(modelo, registry, ent, { now: () => new Date(ahora) }),
      ),
    );
    expect(res).toMatchObject({ salida: 'failed', errorCode: 'AGENT_RUN_TIMEOUT' });
    expect(modelo.llamadas).toBe(1);
    expect((await filaDelRun(e.consultor, t.run.id)).status).toBe('failed');
  });

  it('una respuesta con ids de llamada repetidos o vacía se descarta como respuesta inválida (no ejecuta nada)', async () => {
    const campana = await nuevaCampana(e.admin.organizationId, e.admin.id, 'Inválida', e.campanas);
    const ent = entornoDePrueba();
    for (const guion of [
      respuestaConTools([
        { id: 'dup', name: 'campaign_get' },
        { id: 'dup', name: 'campaign_get' },
      ]),
      respuestaConTools([]),
    ]) {
      const conv = await nuevaConversacion(e.consultor, campana);
      const t = await admitir(e.consultor, conv, 'Hola', ent);
      const res = valor(
        await ejecutarRun(e.consultor, t.run.id, dependencias(new ScriptedModel([guion]), registry, ent)),
      );
      expect(res).toMatchObject({ salida: 'failed', errorCode: 'AGENT_MODEL_UNAVAILABLE' });
      expect(res.toolCalls).toBe(0);
    }
  });
});

describe('V11 · tamaño de los resultados de las tools (≤ 16 KB) con datos hostiles', () => {
  it('source_read_content con 25 fragmentos de 5 000 caracteres, source_search_text, source_list con 60 fuentes y brief_get_workspace no pasan de 16 KB', async () => {
    const campana = await nuevaCampana(e.admin.organizationId, e.admin.id, 'Tamaño', e.campanas);
    const grande = await crearFuenteDePrueba(campana, e.admin, 'documento-grande');
    for (let i = 0; i < 25; i++)
      await crearFragmentoDePrueba(grande, i, `LLAVE-GRANDE ${'palabra '.repeat(700)}`);
    for (let i = 0; i < 60; i++)
      await crearFuenteDePrueba(campana, e.admin, `fuente-${i}-${'n'.repeat(180)}`);
    const t = await abrirTurno(e.consultor, campana, 'lee todo');
    const lista = await llamar(r, t, 'source_list', { limit: 50 });
    const alias = t.referencias.listar().find((x) => x.sourceId === grande)?.alias;
    // el alias del documento grande puede no estar en la primera página: se registra por UUID
    const lectura = await llamar(r, t, 'source_read_content', { sourceId: alias ?? grande, limit: 20 });
    const busqueda = await llamar(r, t, 'source_search_text', { text: 'LLAVE-GRANDE', limit: 10 });
    const ws = await llamar(r, t, 'brief_get_workspace', {});
    for (const [nombre, x] of [
      ['source_list', lista],
      ['source_read_content', lectura],
      ['source_search_text', busqueda],
      ['brief_get_workspace', ws],
    ] as const) {
      expect(Buffer.byteLength(x.content, 'utf8'), nombre).toBeLessThanOrEqual(MAX_OUTPUT_BYTES);
    }
    expect(lectura.status).toBe('succeeded');
  });

  it('el runtime acota además lo que vuelve al modelo (un ToolRegistry que devuelve 1 MB no infla el prompt)', async () => {
    const campana = await nuevaCampana(e.admin.organizationId, e.admin.id, 'Registro grande', e.campanas);
    const ent = entornoDePrueba();
    const conv = await nuevaConversacion(e.consultor, campana);
    const t = await admitir(e.consultor, conv, 'Hola', ent);
    const gigante = {
      catalogHash: 'c'.repeat(64),
      definitionsFor: () => [],
      execute: async () => ({
        content: 'X'.repeat(1_000_000),
        status: 'succeeded' as const,
        riskClass: 'read' as const,
      }),
    };
    const modelo = new ScriptedModel([
      respuestaConTools([{ id: 'g1', name: 'campaign_get' }]),
      respuestaFinal('Listo.'),
    ]);
    valor(await ejecutarRun(e.consultor, t.run.id, dependencias(modelo, gigante, ent)));
    const tool = modelo.requests[1]!.messages.find((m) => m.role === 'tool') as { content: string };
    expect(tool.content.length).toBeLessThanOrEqual(16_384);
  });
});

describe('V11 · reintentos del cliente de modelo y costos', () => {
  it('error transitorio persistente: exactamente 3 intentos HTTP (1 + 2 reintentos), un solo ledger de error y el run falla una vez', async () => {
    const s = await servidor((_q, res) =>
      responder(res, 503, {
        error: { code: 'MODEL_UPSTREAM_ERROR', message: 'x', retryable: true, retry_after_s: null },
      }),
    );
    const campana = await nuevaCampana(e.admin.organizationId, e.admin.id, 'Reintentos', e.campanas);
    const ent = entornoDePrueba();
    const conv = await nuevaConversacion(e.consultor, campana);
    const t = await admitir(e.consultor, conv, 'Hola', ent);
    const esperas: number[] = [];
    const cliente = new WorkerModelClient({
      baseUrl: s.url,
      reintentos: { random: () => 0, sleep: async (ms) => void esperas.push(ms) },
    });
    const res = valor(await ejecutarRun(e.consultor, t.run.id, dependencias(cliente, registry, ent)));
    expect(res).toMatchObject({ salida: 'failed', errorCode: 'AGENT_MODEL_UNAVAILABLE' });
    expect(s.peticiones).toHaveLength(3);
    expect(esperas).toEqual([1_000, 3_000]);
    const ledger = await query<{ n: string }>(
      `SELECT count(*)::text AS n FROM ai_runs WHERE agent_run_id = $1`,
      [t.run.id],
    );
    expect(Number(ledger[0]!.n)).toBe(1);
  });

  it('no se reintenta: 4xx, código desconocido, retry_after > 15 s, `retryable:false` declarado, AI_DISABLED, contexto demasiado grande', async () => {
    const casos: [number, unknown][] = [
      [422, { error: { code: 'REQUEST_INVALID', message: 'x', retryable: true } }],
      [400, 'basura'],
      [503, { error: { code: 'CODIGO_INVENTADO', message: 'x', retryable: true } }],
      [429, { error: { code: 'MODEL_RATE_LIMITED', message: 'x', retryable: true, retry_after_s: 600 } }],
      [502, { error: { code: 'MODEL_UPSTREAM_ERROR', message: 'x', retryable: false } }],
      [503, { error: { code: 'AI_DISABLED', message: 'x', retryable: true } }],
      [413, { error: { code: 'MODEL_CONTEXT_TOO_LARGE', message: 'x', retryable: true } }],
    ];
    for (const [status, cuerpo] of casos) {
      const s = await servidor((_q, res) => responder(res, status, cuerpo));
      const cliente = new WorkerModelClient({
        baseUrl: s.url,
        reintentos: { random: () => 0, sleep: async () => undefined },
      });
      await expect(
        cliente.turn({
          messages: [
            { role: 'system', content: 's' },
            { role: 'user', content: 'u' },
          ],
          tools: [],
        }),
      ).rejects.toMatchObject({ name: 'ModelError' });
      expect(s.peticiones, `${status} ${JSON.stringify(cuerpo)}`).toHaveLength(1);
    }
  });

  it('el costo del run es la suma del ledger; 8 vueltas de un bucle quedan acotadas', async () => {
    const campana = await nuevaCampana(e.admin.organizationId, e.admin.id, 'Costo', e.campanas);
    const ent = entornoDePrueba();
    const conv = await nuevaConversacion(e.consultor, campana);
    const t = await admitir(e.consultor, conv, 'Hola', ent);
    const modelo = new ScriptedModel(
      Array.from({ length: 20 }, () =>
        respuestaConTools([{ name: 'campaign_get' }], {
          usage: { promptTokens: 1000, completionTokens: 100, totalTokens: 1100, costUsd: 0.01 },
        }),
      ),
    );
    valor(await ejecutarRun(e.consultor, t.run.id, dependencias(modelo, registry, ent)));
    const c = valor(await costoDeRun(e.consultor, t.run.id));
    expect(c.llamadas).toBe(8);
    expect(c.costUsd).toBeCloseTo(0.08, 6);
  });
});
