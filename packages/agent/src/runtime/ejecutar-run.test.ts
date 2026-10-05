/**
 * Bucle del agente con BASE REAL, `ScriptedModel` y un registro de tools FALSO.
 * Cada prueba comprueba además que el run queda en un estado TERMINAL.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { closePool, query, cancelarRun, abandonarRunsCaducados, iniciarRun } from '@tcl-kol-os/db';
import {
  type EscenarioDeChat,
  crearEscenarioDeChat,
  eliminarCampanaDePrueba,
} from '@tcl-kol-os/db/test-utils';
import type { User } from '@tcl-kol-os/domain';
import { ScriptedModel, fallo, respuestaConTools, respuestaFinal } from '../model/scripted-model.ts';
import { PROMPT_VERSION } from '../prompts/agente-cuenta.ts';
import { ejecutarRun } from './ejecutar-run.ts';
import { FakeToolRegistry, escrituraSoloAdmin, lectura } from './testing/fake-tool-registry.ts';
import {
  admitir,
  dependencias,
  entornoDePrueba,
  filaDelRun,
  ledgerDelRun,
  mensajesDeLaConversacion,
  nuevaConversacion,
  valor,
} from './testing/harness.ts';

let e: EscenarioDeChat;

beforeAll(async () => {
  e = await crearEscenarioDeChat('Agente · bucle');
});

afterEach(async () => {
  await query(`UPDATE users SET status = 'activo' WHERE id IN ($1, $2)`, [e.consultor.id, e.admin.id]);
  await query(`UPDATE users SET role = 'consultor' WHERE id = $1`, [e.consultor.id]);
  await query(`UPDATE users SET role = 'admin' WHERE id = $1`, [e.admin.id]);
});

afterAll(async () => {
  await eliminarCampanaDePrueba(e.campanas);
  await closePool();
});

const TERMINALES = ['completed', 'failed', 'cancelled'];

async function terminal(actor: User, runId: string) {
  const run = await filaDelRun(actor, runId);
  expect(TERMINALES, `el run quedó ${run.status}`).toContain(run.status);
  return run;
}

async function turno(
  actor: User = e.consultor,
  texto = 'Dame un resumen de la campaña',
  entorno = entornoDePrueba(),
) {
  const conv = await nuevaConversacion(actor, e.campanaId);
  const t = await admitir(actor, conv, texto, entorno);
  return { ...t, entorno, actor };
}

describe('respuesta directa', () => {
  it('sin tools: completa el run, publica el mensaje y registra el ledger', async () => {
    const t = await turno();
    const modelo = new ScriptedModel([
      respuestaFinal('La campaña está en preparación.', {
        provider: 'proveedor-real',
        model: 'modelo-real',
        usage: { promptTokens: 321, completionTokens: 45, totalTokens: 366, costUsd: 0.0042 },
        latencyMs: 777,
        generationId: 'gen-xyz',
      }),
    ]);
    const registro = new FakeToolRegistry([lectura('campaign_get')]);

    const r = valor(await ejecutarRun(t.actor, t.run.id, dependencias(modelo, registro, t.entorno)));
    expect(r).toMatchObject({ salida: 'completed', status: 'completed', pasos: 1, toolCalls: 0 });

    const run = await terminal(t.actor, t.run.id);
    expect(run).toMatchObject({ status: 'completed' });
    expect(run.contextHash).toMatch(/^[0-9a-f]{64}$/);
    expect(run.contextManifest).toMatchObject({
      promptVersion: PROMPT_VERSION,
      toolCatalogHash: registro.catalogHash,
    });

    const mensajes = await mensajesDeLaConversacion(t.conversationId);
    expect(mensajes.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(mensajes[1]).toMatchObject({ content: 'La campaña está en preparación.', agent_run_id: t.run.id });

    // Ledger: provider/model REALES de la respuesta, no los de la admisión.
    const ledger = await ledgerDelRun(t.run.id);
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({
      step_index: 0,
      task: 'conversar',
      provider: 'proveedor-real',
      model: 'modelo-real',
      tier: 'equilibrado',
      prompt_version: PROMPT_VERSION,
      output_status: 'ok',
      latency_ms: 777,
      prompt_tokens: 321,
      completion_tokens: 45,
      generation_id: 'gen-xyz',
      error: null,
    });
    expect(Number(ledger[0]!.cost_usd)).toBeCloseTo(0.0042);
    expect(ledger[0]!.input_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('la petición al modelo: system fijo → contexto → mensaje actual; tools del rol; sin ids', async () => {
    const t = await turno(e.consultor, 'Mensaje ACTUAL de la persona');
    const modelo = new ScriptedModel([respuestaFinal('Hecho.')]);
    const registro = new FakeToolRegistry([lectura('campaign_get'), escrituraSoloAdmin('solo_admin')]);
    valor(await ejecutarRun(t.actor, t.run.id, dependencias(modelo, registro, t.entorno)));

    const p = modelo.requests[0]!;
    expect(p.messages.map((m) => m.role)).toEqual(['system', 'user', 'user']);
    expect(p.messages[2]).toEqual({ role: 'user', content: 'Mensaje ACTUAL de la persona' });
    expect(p.toolChoice).toBe('auto');
    // El consultor no ve la tool que exige una capacidad solo de admin.
    expect(p.tools.map((x) => x.name)).toEqual(['campaign_get']);
    expect(p.correlation).toEqual({ conversationId: t.conversationId, agentRunId: t.run.id, stepIndex: 0 });
    expect(p.maxTokens).toBe(2_048);
    expect(p.timeoutMs).toBeLessThanOrEqual(45_000);
  });
});

describe('tool calls', () => {
  it('una tool call: se ejecuta con el contexto del runtime y su resultado vuelve como mensaje tool', async () => {
    const t = await turno(e.consultor, 'Consulta la campaña');
    const modelo = new ScriptedModel([
      respuestaConTools([{ id: 'call_a', name: 'campaign_get', arguments: { incluir: 'todo' } }]),
      respuestaFinal('Ya la consulté.'),
    ]);
    const registro = new FakeToolRegistry([lectura('campaign_get', '{"nombre":"RESULTADO-DE-LA-TOOL"}')]);

    const r = valor(await ejecutarRun(t.actor, t.run.id, dependencias(modelo, registro, t.entorno)));
    expect(r).toMatchObject({ salida: 'completed', pasos: 2, toolCalls: 1 });

    expect(registro.ejecuciones).toHaveLength(1);
    const { context, call } = registro.ejecuciones[0]!;
    expect(call).toEqual({ id: 'call_a', name: 'campaign_get', arguments: { incluir: 'todo' } });
    // Todo lo decide el runtime, nunca el modelo.
    expect(context).toMatchObject({
      campaignId: e.campanaId,
      conversationId: t.conversationId,
      messageId: t.mensaje.id,
      agentRunId: t.run.id,
      stepIndex: 0,
    });
    expect(context.actor.id).toBe(e.consultor.id);
    expect(context.textosDelActor).toEqual(['Consulta la campaña']);
    expect(context.referencias.tamano).toBeGreaterThanOrEqual(0);

    // La segunda petición lleva la llamada del asistente y el resultado de la tool.
    const p2 = modelo.requests[1]!;
    const asistente = p2.messages.find((m) => m.role === 'assistant');
    expect(asistente).toMatchObject({ content: null, toolCalls: [{ id: 'call_a', name: 'campaign_get' }] });
    const herramienta = p2.messages.find((m) => m.role === 'tool');
    expect(herramienta).toEqual({
      role: 'tool',
      toolCallId: 'call_a',
      content: '{"nombre":"RESULTADO-DE-LA-TOOL"}',
    });

    const ledger = await ledgerDelRun(t.run.id);
    expect(ledger.map((l) => l.step_index)).toEqual([0, 1]);
    await terminal(t.actor, t.run.id);
  });

  it('varias tool calls en un paso: se ejecutan en orden y NUNCA en paralelo', async () => {
    const t = await turno();
    const modelo = new ScriptedModel([
      respuestaConTools([
        { id: 'c1', name: 'campaign_get' },
        { id: 'c2', name: 'source_list' },
        { id: 'c3', name: 'campaign_get' },
      ]),
      respuestaFinal('Listo.'),
    ]);
    const lenta = async () => {
      await new Promise((r) => setTimeout(r, 15));
      return '{"ok":true}';
    };
    const registro = new FakeToolRegistry([lectura('campaign_get', lenta), lectura('source_list', lenta)]);
    valor(await ejecutarRun(t.actor, t.run.id, dependencias(modelo, registro, t.entorno)));
    expect(registro.nombresEjecutados()).toEqual(['campaign_get', 'source_list', 'campaign_get']);
    expect(registro.maxSimultaneas).toBe(1);
    const tools = modelo.requests[1]!.messages.filter((m) => m.role === 'tool');
    expect(tools.map((m) => (m as { toolCallId: string }).toolCallId)).toEqual(['c1', 'c2', 'c3']);
  });

  it('más de 4 tool calls en un paso: solo se ejecutan 4 y las demás reciben un rechazo', async () => {
    const t = await turno();
    const llamadas = Array.from({ length: 6 }, (_, i) => ({ id: `c${i + 1}`, name: 'campaign_get' }));
    const modelo = new ScriptedModel([respuestaConTools(llamadas), respuestaFinal('Listo.')]);
    const registro = new FakeToolRegistry([lectura('campaign_get')]);
    // Intentar subir el tope por parámetro tampoco funciona (tope duro 4).
    const r = valor(
      await ejecutarRun(
        t.actor,
        t.run.id,
        dependencias(modelo, registro, t.entorno, { limites: { maxToolCallsPorPaso: 50 } }),
      ),
    );
    expect(registro.ejecuciones).toHaveLength(4);
    expect(r.toolCalls).toBe(4);
    const mensajesTool = modelo.requests[1]!.messages.filter((m) => m.role === 'tool') as {
      toolCallId: string;
      content: string;
    }[];
    expect(mensajesTool).toHaveLength(6);
    expect(JSON.parse(mensajesTool[4]!.content)).toMatchObject({
      error: { code: 'AGENT_INVALID_TOOL_CALL' },
    });
    expect(JSON.parse(mensajesTool[5]!.content)).toMatchObject({
      error: { code: 'AGENT_INVALID_TOOL_CALL' },
    });
    await terminal(t.actor, t.run.id);
  });

  it('un resultado de tool mayor a 16 KB se acota antes de llegar al modelo', async () => {
    const t = await turno();
    const modelo = new ScriptedModel([
      respuestaConTools([{ id: 'c1', name: 'campaign_get' }]),
      respuestaFinal('Ok.'),
    ]);
    const registro = new FakeToolRegistry([lectura('campaign_get', 'x'.repeat(60_000))]);
    valor(await ejecutarRun(t.actor, t.run.id, dependencias(modelo, registro, t.entorno)));
    const tool = modelo.requests[1]!.messages.find((m) => m.role === 'tool') as { content: string };
    expect(tool.content.length).toBeLessThanOrEqual(16_384);
  });

  it('una tool inexistente la rechaza el registro y el modelo ve el error: el turno sigue', async () => {
    const t = await turno();
    const modelo = new ScriptedModel([
      respuestaConTools([{ id: 'c1', name: 'aprobar_brief' }]),
      respuestaFinal('No puedo aprobar; solo proponer.'),
    ]);
    const registro = new FakeToolRegistry([lectura('campaign_get')]);
    const r = valor(await ejecutarRun(t.actor, t.run.id, dependencias(modelo, registro, t.entorno)));
    expect(r.salida).toBe('completed');
    const tool = modelo.requests[1]!.messages.find((m) => m.role === 'tool') as { content: string };
    expect(JSON.parse(tool.content).error.code).toBe('AGENT_INVALID_TOOL_CALL');
  });
});

describe('límite de pasos', () => {
  it('step_limit: mensaje determinístico SIN otra llamada de modelo; el run queda completed', async () => {
    const t = await turno(e.consultor, 'Haz muchas cosas', entornoDePrueba({ AGENT_MAX_TOOL_STEPS: '3' }));
    const guion = Array.from({ length: 10 }, () => respuestaConTools([{ name: 'campaign_get' }]));
    const modelo = new ScriptedModel(guion);
    const registro = new FakeToolRegistry([lectura('campaign_get')]);
    const r = valor(await ejecutarRun(t.actor, t.run.id, dependencias(modelo, registro, t.entorno)));

    expect(r).toMatchObject({ salida: 'step_limit', status: 'completed', pasos: 3, toolCalls: 3 });
    expect(modelo.llamadas).toBe(3);
    const mensajes = await mensajesDeLaConversacion(t.conversationId);
    const respuesta = mensajes[1]!.content;
    expect(respuesta).toContain('Alcancé el límite de 3 pasos');
    expect(respuesta).toContain('Hecho: 3 consulta(s) (campaign_get)');
    expect(respuesta).toContain('Pendiente:');
    expect((await terminal(t.actor, t.run.id)).status).toBe('completed');
    expect(await ledgerDelRun(t.run.id)).toHaveLength(3);
  });

  it('por defecto son 8 pasos y el tope duro es 15 aunque el entorno pida más', async () => {
    const porDefecto = await turno();
    const m1 = new ScriptedModel(
      Array.from({ length: 30 }, () => respuestaConTools([{ name: 'campaign_get' }])),
    );
    valor(
      await ejecutarRun(
        porDefecto.actor,
        porDefecto.run.id,
        dependencias(m1, new FakeToolRegistry([lectura('campaign_get')]), porDefecto.entorno),
      ),
    );
    expect(m1.llamadas).toBe(8);

    const tope = await turno(e.consultor, 'otro', entornoDePrueba({ AGENT_MAX_TOOL_STEPS: '500' }));
    const m2 = new ScriptedModel(
      Array.from({ length: 40 }, () => respuestaConTools([{ name: 'campaign_get' }])),
    );
    valor(
      await ejecutarRun(
        tope.actor,
        tope.run.id,
        dependencias(m2, new FakeToolRegistry([lectura('campaign_get')]), tope.entorno),
      ),
    );
    expect(m2.llamadas).toBe(15);
  });
});

describe('plazo, cancelación y kill-switch', () => {
  it('timeout: pasado el plazo del run falla AGENT_RUN_TIMEOUT y no vuelve a llamar al modelo', async () => {
    const t = await turno();
    let reloj = Date.now();
    const modelo = new ScriptedModel([
      () => {
        reloj += 200_000; // el primer paso «tarda» más que el plazo (180 s)
        return respuestaConTools([{ name: 'campaign_get' }]);
      },
      respuestaFinal('no debería llegar'),
    ]);
    const registro = new FakeToolRegistry([lectura('campaign_get')]);
    const r = valor(
      await ejecutarRun(
        t.actor,
        t.run.id,
        dependencias(modelo, registro, t.entorno, { now: () => new Date(reloj) }),
      ),
    );
    expect(r).toMatchObject({ salida: 'failed', status: 'failed', errorCode: 'AGENT_RUN_TIMEOUT' });
    expect(modelo.llamadas).toBe(1);
    expect(registro.ejecuciones).toHaveLength(0); // el control previo a la tool corta antes de ejecutar
    const run = await terminal(t.actor, t.run.id);
    expect(run).toMatchObject({ status: 'failed', errorCode: 'AGENT_RUN_TIMEOUT' });
    expect(run.errorMessage).toBeTruthy();
    // Sin mensaje del asistente.
    expect((await mensajesDeLaConversacion(t.conversationId)).map((m) => m.role)).toEqual(['user']);
  });

  it('cancelación a mitad: se confirma entre pasos, no hay respuesta y el run queda cancelled', async () => {
    const t = await turno();
    const modelo = new ScriptedModel([
      async () => {
        valor(await cancelarRun(t.actor, t.run.id)); // la persona cancela mientras el modelo piensa
        return respuestaConTools([{ name: 'campaign_get' }]);
      },
      respuestaFinal('no debería publicarse'),
    ]);
    const registro = new FakeToolRegistry([lectura('campaign_get')]);
    const r = valor(await ejecutarRun(t.actor, t.run.id, dependencias(modelo, registro, t.entorno)));
    expect(r).toMatchObject({ salida: 'cancelled', status: 'cancelled' });
    expect(modelo.llamadas).toBe(1);
    expect(registro.ejecuciones).toHaveLength(0);
    expect((await terminal(t.actor, t.run.id)).status).toBe('cancelled');
    expect((await mensajesDeLaConversacion(t.conversationId)).map((m) => m.role)).toEqual(['user']);
  });

  it('cancelación pedida durante la última vuelta: la respuesta no se publica', async () => {
    const t = await turno();
    const modelo = new ScriptedModel([
      async () => {
        valor(await cancelarRun(t.actor, t.run.id));
        return respuestaFinal('respuesta que no debe publicarse');
      },
    ]);
    const r = valor(
      await ejecutarRun(t.actor, t.run.id, dependencias(modelo, new FakeToolRegistry([]), t.entorno)),
    );
    expect(r).toMatchObject({ salida: 'cancelled', status: 'cancelled' });
    expect((await mensajesDeLaConversacion(t.conversationId)).map((m) => m.role)).toEqual(['user']);
  });

  it('IA apagada ANTES de empezar: falla AI_DISABLED sin llamar al modelo', async () => {
    const t = await turno();
    t.entorno.valores['AI_ENABLED'] = 'false';
    const modelo = new ScriptedModel([respuestaFinal('no')]);
    const r = valor(
      await ejecutarRun(t.actor, t.run.id, dependencias(modelo, new FakeToolRegistry([]), t.entorno)),
    );
    expect(r).toMatchObject({ salida: 'failed', errorCode: 'AI_DISABLED' });
    expect(modelo.llamadas).toBe(0);
    expect(await terminal(t.actor, t.run.id)).toMatchObject({ status: 'failed', errorCode: 'AI_DISABLED' });
  });

  it('IA apagada A MITAD: el siguiente paso falla AI_DISABLED y no se llama más al modelo ni a tools', async () => {
    const t = await turno();
    const modelo = new ScriptedModel([
      () => {
        t.entorno.valores['AI_ENABLED'] = 'false';
        return respuestaConTools([{ name: 'campaign_get' }]);
      },
      respuestaFinal('no'),
    ]);
    const registro = new FakeToolRegistry([lectura('campaign_get')]);
    const r = valor(await ejecutarRun(t.actor, t.run.id, dependencias(modelo, registro, t.entorno)));
    expect(r).toMatchObject({ salida: 'failed', errorCode: 'AI_DISABLED' });
    expect(modelo.llamadas).toBe(1);
    expect(registro.ejecuciones).toHaveLength(0);
    expect((await terminal(t.actor, t.run.id)).errorCode).toBe('AI_DISABLED');
  });
});

describe('errores del modelo', () => {
  it('error permanente → AGENT_MODEL_UNAVAILABLE con mensaje fijo y ledger de error', async () => {
    const t = await turno();
    const modelo = new ScriptedModel([fallo('MODEL_UPSTREAM_ERROR', { retryable: false })]);
    const r = valor(
      await ejecutarRun(t.actor, t.run.id, dependencias(modelo, new FakeToolRegistry([]), t.entorno)),
    );
    expect(r).toMatchObject({ salida: 'failed', errorCode: 'AGENT_MODEL_UNAVAILABLE' });
    const run = await terminal(t.actor, t.run.id);
    expect(run.errorMessage).toBe(
      'El modelo no está disponible en este momento (MODEL_UPSTREAM_ERROR). Reintente en unos minutos.',
    );
    const ledger = await ledgerDelRun(t.run.id);
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({ output_status: 'error', error: 'MODEL_UPSTREAM_ERROR', step_index: 0 });
  });

  it.each([
    ['AI_DISABLED', 'AI_DISABLED'],
    ['MODEL_CONTEXT_TOO_LARGE', 'AGENT_CONTEXT_FAILED'],
    ['MODEL_NOT_CONFIGURED', 'AGENT_MODEL_UNAVAILABLE'],
    ['MODEL_TIMEOUT', 'AGENT_MODEL_UNAVAILABLE'],
    ['MODEL_RATE_LIMITED', 'AGENT_MODEL_UNAVAILABLE'],
    ['MODEL_BAD_RESPONSE', 'AGENT_MODEL_UNAVAILABLE'],
    ['WORKER_UNREACHABLE', 'AGENT_MODEL_UNAVAILABLE'],
    ['REQUEST_INVALID', 'AGENT_MODEL_UNAVAILABLE'],
    ['INTERNAL_ERROR', 'AGENT_MODEL_UNAVAILABLE'],
  ] as const)('ModelError %s → run failed %s', async (modelCode, esperado) => {
    const t = await turno();
    const modelo = new ScriptedModel([fallo(modelCode)]);
    const r = valor(
      await ejecutarRun(t.actor, t.run.id, dependencias(modelo, new FakeToolRegistry([]), t.entorno)),
    );
    expect(r).toMatchObject({ salida: 'failed', errorCode: esperado });
    expect((await terminal(t.actor, t.run.id)).errorCode).toBe(esperado);
  });

  it('una respuesta estructuralmente inválida del modelo (aunque el cliente la dejara pasar) falla limpio', async () => {
    const t = await turno();
    const modelo = new ScriptedModel([respuestaFinal('   ')]);
    const r = valor(
      await ejecutarRun(t.actor, t.run.id, dependencias(modelo, new FakeToolRegistry([]), t.entorno)),
    );
    expect(r).toMatchObject({ salida: 'failed', errorCode: 'AGENT_MODEL_UNAVAILABLE' });
    expect((await terminal(t.actor, t.run.id)).errorMessage).toContain('MODEL_BAD_RESPONSE');
    expect((await ledgerDelRun(t.run.id))[0]).toMatchObject({
      output_status: 'error',
      error: 'MODEL_BAD_RESPONSE',
    });

    const t2 = await turno();
    const m2 = new ScriptedModel([
      respuestaConTools([
        { id: 'dup', name: 'campaign_get' },
        { id: 'dup', name: 'campaign_get' },
      ]),
    ]);
    const reg2 = new FakeToolRegistry([lectura('campaign_get')]);
    const r2 = valor(await ejecutarRun(t2.actor, t2.run.id, dependencias(m2, reg2, t2.entorno)));
    expect(r2).toMatchObject({ salida: 'failed', errorCode: 'AGENT_MODEL_UNAVAILABLE' });
    expect(reg2.ejecuciones).toHaveLength(0);
  });

  it('una excepción inesperada cierra el run con AGENT_RUNTIME_ERROR sin filtrar el detalle', async () => {
    const t = await turno();
    const eventos: string[] = [];
    const modelo = new ScriptedModel([respuestaConTools([{ name: 'campaign_get' }])]);
    const registro = new FakeToolRegistry([
      lectura('campaign_get', () => {
        throw new Error('DETALLE-SECRETO-DE-LA-EXCEPCION');
      }),
    ]);
    const r = valor(
      await ejecutarRun(
        t.actor,
        t.run.id,
        dependencias(modelo, registro, t.entorno, { registrar: (ev) => eventos.push(JSON.stringify(ev)) }),
      ),
    );
    expect(r).toMatchObject({ salida: 'failed', errorCode: 'AGENT_RUNTIME_ERROR' });
    const run = await terminal(t.actor, t.run.id);
    expect(run.errorMessage).toBe('Error interno del agente. El turno se detuvo.');
    expect(JSON.stringify(run)).not.toContain('DETALLE-SECRETO');
    expect(eventos.join('\n')).not.toContain('DETALLE-SECRETO');
  });

  it('un cliente de modelo que lanza algo que no es ModelError también cierra el run', async () => {
    const t = await turno();
    const modelo = { turn: async () => Promise.reject(new TypeError('boom')) };
    const r = valor(
      await ejecutarRun(t.actor, t.run.id, dependencias(modelo, new FakeToolRegistry([]), t.entorno)),
    );
    expect(r).toMatchObject({ salida: 'failed', errorCode: 'AGENT_RUNTIME_ERROR' });
    await terminal(t.actor, t.run.id);
  });
});

describe('persona vigente (permisos releídos en cada paso)', () => {
  it('permiso revocado ENTRE pasos: el run falla FORBIDDEN_ROLE y la tool no se ejecuta', async () => {
    const t = await turno();
    const modelo = new ScriptedModel([
      async () => {
        // El administrador le quita el chat a la persona mientras el modelo piensa.
        await query(`UPDATE users SET role = 'operativo' WHERE id = $1`, [e.consultor.id]);
        return respuestaConTools([{ name: 'campaign_get' }]);
      },
      respuestaFinal('no'),
    ]);
    const registro = new FakeToolRegistry([lectura('campaign_get')]);
    const r = valor(await ejecutarRun(t.actor, t.run.id, dependencias(modelo, registro, t.entorno)));
    expect(r).toMatchObject({ salida: 'failed', errorCode: 'FORBIDDEN_ROLE' });
    expect(registro.ejecuciones).toHaveLength(0);
    expect(modelo.llamadas).toBe(1);
    expect((await terminal(t.actor, t.run.id)).errorCode).toBe('FORBIDDEN_ROLE');
  });

  it('rol con menos permisos entre pasos: las tools de escritura dejan de ofrecerse', async () => {
    const t = await turno(e.admin);
    const modelo = new ScriptedModel([
      async () => {
        await query(`UPDATE users SET role = 'consultor' WHERE id = $1`, [e.admin.id]);
        return respuestaConTools([{ name: 'campaign_get' }]);
      },
      respuestaFinal('Listo.'),
    ]);
    const registro = new FakeToolRegistry([lectura('campaign_get'), escrituraSoloAdmin('solo_admin')]);
    const r = valor(await ejecutarRun(t.actor, t.run.id, dependencias(modelo, registro, t.entorno)));
    expect(r.salida).toBe('completed');
    expect(registro.ofrecidas[0]).toEqual(['campaign_get', 'solo_admin']);
    expect(registro.ofrecidas[1]).toEqual(['campaign_get']);
    expect(modelo.requests[1]!.tools.map((x) => x.name)).toEqual(['campaign_get']);
    // La ejecución usó el rol vigente, no el de la admisión.
    expect(registro.ejecuciones[0]!.context.actor.role).toBe('consultor');
  });

  it('persona inactiva ANTES de empezar: falla FORBIDDEN_ROLE sin llamar al modelo', async () => {
    const t = await turno();
    await query(`UPDATE users SET status = 'inactivo' WHERE id = $1`, [e.consultor.id]);
    const modelo = new ScriptedModel([respuestaFinal('no')]);
    const r = valor(
      await ejecutarRun(
        t.actor /* sesión vieja */,
        t.run.id,
        dependencias(modelo, new FakeToolRegistry([]), t.entorno),
      ),
    );
    expect(r).toMatchObject({ salida: 'failed', errorCode: 'FORBIDDEN_ROLE' });
    expect(modelo.llamadas).toBe(0);
    expect(await terminal(e.consultor, t.run.id)).toMatchObject({
      status: 'failed',
      errorCode: 'FORBIDDEN_ROLE',
    });
  });

  it('persona desactivada A MITAD: el run se cierra FORBIDDEN_ROLE y no se ejecuta la tool', async () => {
    const t = await turno();
    const modelo = new ScriptedModel([
      async () => {
        await query(`UPDATE users SET status = 'inactivo' WHERE id = $1`, [e.consultor.id]);
        return respuestaConTools([{ name: 'campaign_get' }]);
      },
    ]);
    const registro = new FakeToolRegistry([lectura('campaign_get')]);
    const r = valor(await ejecutarRun(t.actor, t.run.id, dependencias(modelo, registro, t.entorno)));
    expect(r).toMatchObject({ salida: 'failed', errorCode: 'FORBIDDEN_ROLE' });
    expect(registro.ejecuciones).toHaveLength(0);
    expect((await terminal(e.consultor, t.run.id)).status).toBe('failed');
  });

  it('el run de otra persona (o de otra organización) no se ejecuta ni se entera de que existe', async () => {
    const t = await turno();
    const modelo = new ScriptedModel([respuestaFinal('no')]);
    for (const intruso of [e.admin, e.director, e.ajeno]) {
      const r = await ejecutarRun(
        intruso,
        t.run.id,
        dependencias(modelo, new FakeToolRegistry([]), t.entorno),
      );
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('RESOURCE_NOT_FOUND');
    }
    expect(modelo.llamadas).toBe(0);
    expect((await filaDelRun(e.consultor, t.run.id)).status).toBe('queued');
  });
});

describe('concurrencia y huérfanos', () => {
  it('dos ejecuciones simultáneas del mismo run: una trabaja y la otra queda skipped', async () => {
    const t = await turno();
    const modelo = new ScriptedModel([
      async () => {
        await new Promise((r) => setTimeout(r, 100));
        return respuestaFinal('Una sola vez.');
      },
      respuestaFinal('segunda (no debería usarse)'),
    ]);
    const registro = new FakeToolRegistry([]);
    const [a, b] = await Promise.all([
      ejecutarRun(t.actor, t.run.id, dependencias(modelo, registro, t.entorno)),
      ejecutarRun(t.actor, t.run.id, dependencias(modelo, registro, t.entorno)),
    ]);
    const salidas = [valor(a).salida, valor(b).salida].sort();
    expect(salidas).toEqual(['completed', 'skipped']);
    expect(modelo.llamadas).toBe(1);
    expect(
      (await mensajesDeLaConversacion(t.conversationId)).filter((m) => m.role === 'assistant'),
    ).toHaveLength(1);
  });

  it('ejecutar un run que ya terminó no hace nada', async () => {
    const t = await turno();
    valor(
      await ejecutarRun(
        t.actor,
        t.run.id,
        dependencias(new ScriptedModel([respuestaFinal('Hecho.')]), new FakeToolRegistry([]), t.entorno),
      ),
    );
    const modelo = new ScriptedModel([respuestaFinal('otra vez')]);
    const r = valor(
      await ejecutarRun(t.actor, t.run.id, dependencias(modelo, new FakeToolRegistry([]), t.entorno)),
    );
    expect(r).toMatchObject({ salida: 'skipped', status: 'completed' });
    expect(modelo.llamadas).toBe(0);
  });

  it('si el barrido abandona el run mientras corre, el ejecutor lo detecta (lost) y no publica nada', async () => {
    const t = await turno();
    const modelo = new ScriptedModel([
      async () => {
        await query(`UPDATE agent_runs SET heartbeat_at = now() - interval '30 minutes' WHERE id = $1`, [
          t.run.id,
        ]);
        expect(await abandonarRunsCaducados()).toBeGreaterThanOrEqual(1);
        return respuestaConTools([{ name: 'campaign_get' }]);
      },
      respuestaFinal('no'),
    ]);
    const registro = new FakeToolRegistry([lectura('campaign_get')]);
    const r = valor(await ejecutarRun(t.actor, t.run.id, dependencias(modelo, registro, t.entorno)));
    expect(r).toMatchObject({ salida: 'lost', status: 'failed' });
    expect(registro.ejecuciones).toHaveLength(0);
    expect(await terminal(t.actor, t.run.id)).toMatchObject({ status: 'failed', errorCode: 'RUN_ABANDONED' });
    expect((await mensajesDeLaConversacion(t.conversationId)).map((m) => m.role)).toEqual(['user']);
  });

  it('un run `running` huérfano: ejecutarlo no lo toma (solo se ejecuta `queued`)', async () => {
    const t = await turno();
    valor(await iniciarRun(e.consultor, t.run.id, { contextHash: 'f'.repeat(64), contextManifest: {} }));
    const modelo = new ScriptedModel([respuestaFinal('no')]);
    const r = valor(
      await ejecutarRun(t.actor, t.run.id, dependencias(modelo, new FakeToolRegistry([]), t.entorno)),
    );
    expect(r).toMatchObject({ salida: 'skipped', status: 'running' });
    expect(modelo.llamadas).toBe(0);
  });
});
