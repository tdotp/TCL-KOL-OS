/**
 * `WorkerModelClient` contra un servidor HTTP falso local (sin red, sin proveedor).
 * Cubre: contrato de petición (snake_case), normalización de la respuesta, cada código
 * de error del worker, reintentos, retry_after_s, respuestas basura, plazo, aborto y URL.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cerrarServidores, responder, servidor } from './testing/servidor-falso.ts';
import { ModelError, type ModelTurnRequest } from '../contracts.ts';
import { envDesdeObjeto } from './env.ts';
import {
  URL_DEL_WORKER_POR_DEFECTO,
  WorkerModelClient,
  construirCuerpoDeTurno,
  resolverUrlDelWorker,
} from './worker-model-client.ts';

afterEach(cerrarServidores);

const exitoFinal = (extra: Record<string, unknown> = {}) => ({
  kind: 'final',
  task: 'conversar',
  tier: 'equilibrado',
  provider: 'openrouter',
  model: 'anthropic/claude-haiku-4.5',
  finish_reason: 'stop',
  message: { role: 'assistant', content: 'Hola, ¿en qué te ayudo?', tool_calls: [] },
  usage: { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150, cost_usd: 0.0012 },
  latency_ms: 840,
  generation_id: 'gen-1',
  correlation: null,
  ...extra,
});

const exitoTools = () => ({
  ...exitoFinal(),
  kind: 'tool_calls',
  finish_reason: 'tool_calls',
  message: {
    role: 'assistant',
    content: 'Voy a consultar…',
    tool_calls: [{ id: 'call_1', name: 'campaign_get', arguments: { detalle: true } }],
  },
});

const peticion: ModelTurnRequest = {
  messages: [
    { role: 'system', content: 'Sistema' },
    { role: 'user', content: 'Hola' },
  ],
  tools: [
    { name: 'campaign_get', description: 'Lee la campaña', parameters: { type: 'object', properties: {} } },
  ],
  maxTokens: 512,
  timeoutMs: 20_000,
  correlation: { conversationId: 'conv-1', agentRunId: 'run-1', stepIndex: 2 },
};

function cliente(url: string, extra: ConstructorParameters<typeof WorkerModelClient>[0] = {}) {
  const esperas: number[] = [];
  const c = new WorkerModelClient({
    baseUrl: url,
    reintentos: {
      random: () => 0,
      sleep: async (ms) => {
        esperas.push(ms);
      },
    },
    ...extra,
  });
  return { c, esperas };
}

describe('WorkerModelClient · éxito', () => {
  it('envía el contrato snake_case del worker y normaliza la respuesta final', async () => {
    const s = await servidor((_q, res) => responder(res, 200, exitoFinal()));
    const { c } = cliente(s.url);
    const r = await c.turn(peticion);

    expect(r).toEqual({
      kind: 'final',
      content: 'Hola, ¿en qué te ayudo?',
      toolCalls: [],
      finishReason: 'stop',
      provider: 'openrouter',
      model: 'anthropic/claude-haiku-4.5',
      tier: 'equilibrado',
      usage: { promptTokens: 120, completionTokens: 30, totalTokens: 150, costUsd: 0.0012 },
      latencyMs: 840,
      generationId: 'gen-1',
    });
    expect(s.peticiones).toHaveLength(1);
    expect(s.peticiones[0]).toMatchObject({ metodo: 'POST', ruta: '/modelo/turno' });
    expect(s.peticiones[0]!.cuerpo).toEqual({
      task: 'conversar',
      messages: [
        { role: 'system', content: 'Sistema' },
        { role: 'user', content: 'Hola' },
      ],
      tools: [
        {
          name: 'campaign_get',
          description: 'Lee la campaña',
          parameters: { type: 'object', properties: {} },
        },
      ],
      tool_choice: 'auto',
      timeout_s: 20,
      max_tool_calls: 4,
      max_tokens: 512,
      correlation: { conversation_id: 'conv-1', agent_run_id: 'run-1', step_index: 2 },
    });
  });

  it('con tool calls descarta el preámbulo y devuelve los argumentos como objeto', async () => {
    const s = await servidor((_q, res) => responder(res, 200, exitoTools()));
    const r = await cliente(s.url).c.turn(peticion);
    expect(r.kind).toBe('tool_calls');
    expect(r.content).toBeNull();
    expect(r.finishReason).toBe('tool_calls');
    expect(r.toolCalls).toEqual([{ id: 'call_1', name: 'campaign_get', arguments: { detalle: true } }]);
  });

  it('mapea mensajes assistant con tool calls y mensajes tool al formato del worker', () => {
    const cuerpo = construirCuerpoDeTurno(
      {
        messages: [
          { role: 'system', content: 's' },
          { role: 'user', content: 'u' },
          { role: 'assistant', content: null, toolCalls: [{ id: 'c1', name: 't', arguments: { a: 1 } }] },
          { role: 'tool', toolCallId: 'c1', content: '{"ok":true}' },
        ],
        tools: [],
        toolChoice: 'none',
      },
      { timeoutS: 45, maxToolCalls: 4 },
    ) as { messages: unknown[]; tool_choice: string };
    expect(cuerpo.messages[2]).toEqual({
      role: 'assistant',
      tool_calls: [{ id: 'c1', name: 't', arguments: { a: 1 } }],
    });
    expect(cuerpo.messages[3]).toEqual({ role: 'tool', tool_call_id: 'c1', content: '{"ok":true}' });
    expect(cuerpo.tool_choice).toBe('none');
  });

  it('ignora cualquier campo de razonamiento: solo copia los campos del contrato', async () => {
    const s = await servidor((_q, res) =>
      responder(
        res,
        200,
        exitoFinal({
          reasoning: 'PENSAMIENTO-SECRETO',
          message: {
            role: 'assistant',
            content: 'Respuesta',
            reasoning_content: 'PENSAMIENTO-SECRETO-2',
            tool_calls: [],
          },
        }),
      ),
    );
    const r = await cliente(s.url).c.turn(peticion);
    expect(JSON.stringify(r)).not.toContain('PENSAMIENTO');
    expect(Object.keys(r).sort()).toEqual(
      [
        'content',
        'finishReason',
        'generationId',
        'kind',
        'latencyMs',
        'model',
        'provider',
        'tier',
        'toolCalls',
        'usage',
      ].sort(),
    );
  });

  it('un cost_usd nulo o un finish_reason desconocido se normalizan', async () => {
    const s = await servidor((_q, res) =>
      responder(
        res,
        200,
        exitoFinal({
          finish_reason: 'rarisimo',
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, cost_usd: null },
          generation_id: null,
        }),
      ),
    );
    const r = await cliente(s.url).c.turn(peticion);
    expect(r.finishReason).toBe('other');
    expect(r.usage.costUsd).toBeNull();
    expect(r.generationId).toBeNull();
  });
});

describe('WorkerModelClient · errores del worker (taxonomía estable)', () => {
  const casos: { code: string; status: number; retryable: boolean; reintenta: boolean }[] = [
    { code: 'AI_DISABLED', status: 503, retryable: false, reintenta: false },
    { code: 'MODEL_TIMEOUT', status: 504, retryable: true, reintenta: true },
    { code: 'MODEL_RATE_LIMITED', status: 429, retryable: true, reintenta: true },
    { code: 'MODEL_UPSTREAM_ERROR', status: 502, retryable: true, reintenta: true },
    { code: 'MODEL_BAD_RESPONSE', status: 502, retryable: true, reintenta: true },
    { code: 'MODEL_CONTEXT_TOO_LARGE', status: 413, retryable: false, reintenta: false },
    { code: 'MODEL_NOT_CONFIGURED', status: 503, retryable: false, reintenta: false },
    { code: 'REQUEST_INVALID', status: 422, retryable: false, reintenta: false },
    { code: 'INTERNAL_ERROR', status: 500, retryable: false, reintenta: false },
  ];

  it.each(casos)('$code ($status): retryable=$retryable', async ({ code, status, retryable, reintenta }) => {
    const s = await servidor((_q, res) =>
      responder(res, status, {
        error: {
          code,
          message: 'TEXTO-DEL-PROVEEDOR-NO-REFLEJAR',
          retryable,
          retry_after_s: null,
          details: null,
        },
      }),
    );
    const { c, esperas } = cliente(s.url);
    const error = (await c.turn(peticion).catch((e: unknown) => e)) as ModelError;
    expect(error).toBeInstanceOf(ModelError);
    expect(error.code).toBe(code);
    expect(error.retryable).toBe(retryable);
    // Mensaje fijo: nada del proveedor ni del worker.
    expect(error.message).toBe(`Error del modelo: ${code}`);
    expect(JSON.stringify(error)).not.toContain('TEXTO-DEL-PROVEEDOR');
    // Reintentos: solo los retryable (2 reintentos = 3 peticiones); el resto, una sola.
    expect(s.peticiones).toHaveLength(reintenta ? 3 : 1);
    expect(esperas).toEqual(reintenta ? [1_000, 3_000] : []);
  });

  it('un código desconocido es no reintentable aunque el cuerpo diga lo contrario', async () => {
    const s = await servidor((_q, res) =>
      responder(res, 502, { error: { code: 'CODIGO_NUEVO', message: 'x', retryable: true } }),
    );
    const error = (await cliente(s.url)
      .c.turn(peticion)
      .catch((e: unknown) => e)) as ModelError;
    expect(error).toMatchObject({ code: 'INTERNAL_ERROR', retryable: false });
    expect(s.peticiones).toHaveLength(1);
  });

  it('un código que nunca se reintenta no se reintenta aunque el cuerpo diga retryable=true', async () => {
    const s = await servidor((_q, res) =>
      responder(res, 503, { error: { code: 'AI_DISABLED', message: 'x', retryable: true } }),
    );
    const error = (await cliente(s.url)
      .c.turn(peticion)
      .catch((e: unknown) => e)) as ModelError;
    expect(error).toMatchObject({ code: 'AI_DISABLED', retryable: false });
    expect(s.peticiones).toHaveLength(1);
  });

  it('un MODEL_UPSTREAM_ERROR declarado no reintentable (4xx del proveedor) no se reintenta', async () => {
    const s = await servidor((_q, res) =>
      responder(res, 502, { error: { code: 'MODEL_UPSTREAM_ERROR', message: 'x', retryable: false } }),
    );
    const error = (await cliente(s.url)
      .c.turn(peticion)
      .catch((e: unknown) => e)) as ModelError;
    expect(error).toMatchObject({ code: 'MODEL_UPSTREAM_ERROR', retryable: false });
    expect(s.peticiones).toHaveLength(1);
  });

  it('transitorio ×2 → éxito: 3 peticiones y esperas 1 s / 3 s', async () => {
    const s = await servidor((_q, res, _c, n) =>
      n <= 2
        ? responder(res, 503, { error: { code: 'MODEL_UPSTREAM_ERROR', message: 'x', retryable: true } })
        : responder(res, 200, exitoFinal()),
    );
    const { c, esperas } = cliente(s.url);
    const r = await c.turn(peticion);
    expect(r.kind).toBe('final');
    expect(s.peticiones).toHaveLength(3);
    expect(esperas).toEqual([1_000, 3_000]);
  });

  it('respeta retry_after_s del cuerpo y no reintenta si supera el tope', async () => {
    const corto = await servidor((_q, res, _c, n) =>
      n === 1
        ? responder(res, 429, {
            error: { code: 'MODEL_RATE_LIMITED', message: 'x', retryable: true, retry_after_s: 7 },
          })
        : responder(res, 200, exitoFinal()),
    );
    const a = cliente(corto.url);
    await a.c.turn(peticion);
    expect(a.esperas).toEqual([7_000]);

    const largo = await servidor((_q, res) =>
      responder(res, 429, {
        error: { code: 'MODEL_RATE_LIMITED', message: 'x', retryable: true, retry_after_s: 90 },
      }),
    );
    const b = cliente(largo.url);
    const error = (await b.c.turn(peticion).catch((e: unknown) => e)) as ModelError;
    expect(error).toMatchObject({ code: 'MODEL_RATE_LIMITED', retryAfterS: 90 });
    expect(largo.peticiones).toHaveLength(1);
  });

  it('sin cuerpo utilizable manda el estado HTTP: 429 con Retry-After, 502/503/504 reintentables, 4xx no', async () => {
    const limitado = await servidor((_q, res, _c, n) =>
      n === 1
        ? responder(res, 429, 'Too Many Requests', { 'retry-after': '4' })
        : responder(res, 200, exitoFinal()),
    );
    const a = cliente(limitado.url);
    await a.c.turn(peticion);
    expect(a.esperas).toEqual([4_000]);

    for (const [status, code, intentos] of [
      [502, 'MODEL_UPSTREAM_ERROR', 3],
      [503, 'MODEL_UPSTREAM_ERROR', 3],
      [504, 'MODEL_TIMEOUT', 3],
      [400, 'REQUEST_INVALID', 1],
      [401, 'REQUEST_INVALID', 1],
      [500, 'INTERNAL_ERROR', 1],
    ] as const) {
      const s = await servidor((_q, res) => responder(res, status, '<html>nginx</html>'));
      const error = (await cliente(s.url)
        .c.turn(peticion)
        .catch((e: unknown) => e)) as ModelError;
      expect(error.code, `HTTP ${status}`).toBe(code);
      expect(s.peticiones, `HTTP ${status}`).toHaveLength(intentos);
    }
  });
});

describe('WorkerModelClient · respuesta basura = MODEL_BAD_RESPONSE (sin reintentos)', () => {
  const basura: [string, unknown][] = [
    ['texto que no es JSON', 'esto no es json'],
    ['JSON que no es objeto', '[1,2,3]'],
    ['objeto vacío', {}],
    ['kind desconocido', exitoFinal({ kind: 'otra_cosa' })],
    ['final sin contenido', exitoFinal({ message: { role: 'assistant', content: '   ', tool_calls: [] } })],
    [
      'final con tool calls',
      exitoFinal({
        message: { role: 'assistant', content: 'x', tool_calls: [{ id: 'a', name: 't', arguments: {} }] },
      }),
    ],
    [
      'tool_calls sin llamadas',
      { ...exitoTools(), message: { role: 'assistant', content: null, tool_calls: [] } },
    ],
    [
      'argumentos que no son objeto',
      {
        ...exitoTools(),
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: 'a', name: 't', arguments: '{"x":1}' }],
        },
      },
    ],
    [
      'id de llamada inválido',
      {
        ...exitoTools(),
        message: { role: 'assistant', content: null, tool_calls: [{ id: 'a b!', name: 't', arguments: {} }] },
      },
    ],
    [
      'ids de llamada repetidos',
      {
        ...exitoTools(),
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [
            { id: 'a', name: 't', arguments: {} },
            { id: 'a', name: 't', arguments: {} },
          ],
        },
      },
    ],
    [
      'nombre de tool inválido',
      {
        ...exitoTools(),
        message: { role: 'assistant', content: null, tool_calls: [{ id: 'a', name: '1x', arguments: {} }] },
      },
    ],
    [
      'uso de tokens negativo',
      exitoFinal({ usage: { prompt_tokens: -1, completion_tokens: 0, total_tokens: 0, cost_usd: 0 } }),
    ],
    ['uso sin objeto', exitoFinal({ usage: null })],
    ['modelo ausente', exitoFinal({ model: '' })],
    ['latencia no entera', exitoFinal({ latency_ms: 1.5 })],
    ['200 con cuerpo de error', { error: { code: 'MODEL_TIMEOUT', message: 'x' } }],
  ];

  it.each(basura)('%s', async (_nombre, cuerpo) => {
    const s = await servidor((_q, res) => responder(res, 200, cuerpo as object | string));
    const { c, esperas } = cliente(s.url);
    const error = (await c.turn(peticion).catch((e: unknown) => e)) as ModelError;
    expect(error).toBeInstanceOf(ModelError);
    expect(error).toMatchObject({ code: 'MODEL_BAD_RESPONSE', retryable: false });
    expect(s.peticiones).toHaveLength(1);
    expect(esperas).toEqual([]);
  });

  it('un cuerpo enorme se rechaza sin procesarlo', async () => {
    const s = await servidor((_q, res) => responder(res, 200, 'x'.repeat(4_100_000)));
    const error = (await cliente(s.url)
      .c.turn(peticion)
      .catch((e: unknown) => e)) as ModelError;
    expect(error.code).toBe('MODEL_BAD_RESPONSE');
  });
});

describe('WorkerModelClient · red, plazo y aborto', () => {
  it('sin worker escuchando: WORKER_UNREACHABLE reintentable (2 reintentos)', async () => {
    const s = await servidor(() => undefined);
    const url = s.url;
    await s.cerrar();
    const { c, esperas } = cliente(url);
    const error = (await c.turn(peticion).catch((e: unknown) => e)) as ModelError;
    expect(error).toMatchObject({ code: 'WORKER_UNREACHABLE', retryable: true });
    expect(esperas).toEqual([1_000, 3_000]);
  });

  it('si el worker no responde dentro del plazo: MODEL_TIMEOUT reintentable', async () => {
    const s = await servidor(() => undefined); // nunca responde
    const { c } = cliente(s.url, { holguraHttpMs: 50, reintentos: { maxRetries: 0 } });
    const error = (await c.turn({ ...peticion, timeoutMs: 1_000 }).catch((e: unknown) => e)) as ModelError;
    expect(error).toMatchObject({ code: 'MODEL_TIMEOUT', retryable: true });
    expect(s.peticiones).toHaveLength(1);
  }, 10_000);

  it('abortar la señal en vuelo → ABORTED, no reintentable, una sola petición', async () => {
    const s = await servidor(() => undefined);
    const control = new AbortController();
    const { c } = cliente(s.url);
    const promesa = c.turn(peticion, control.signal).catch((e: unknown) => e);
    setTimeout(() => control.abort(), 50);
    const error = (await promesa) as ModelError;
    expect(error).toMatchObject({ code: 'ABORTED', retryable: false });
    expect(s.peticiones).toHaveLength(1);
  });

  it('una señal ya abortada no llega a hacer la petición', async () => {
    const s = await servidor((_q, res) => responder(res, 200, exitoFinal()));
    const control = new AbortController();
    control.abort();
    const error = (await cliente(s.url)
      .c.turn(peticion, control.signal)
      .catch((e: unknown) => e)) as ModelError;
    expect(error).toMatchObject({ code: 'ABORTED', retryable: false });
    expect(s.peticiones).toHaveLength(0);
  });

  it('una URL inválida es MODEL_NOT_CONFIGURED, sin red', async () => {
    const error = (await new WorkerModelClient({ baseUrl: 'esto no es una url' })
      .turn(peticion)
      .catch((e: unknown) => e)) as ModelError;
    expect(error).toMatchObject({ code: 'MODEL_NOT_CONFIGURED', retryable: false });
  });
});

describe('URL del worker (D17)', () => {
  it('AI_WORKER_URL gana; si no, WORKER_URL; si no, localhost:8000; sin barra final', () => {
    expect(
      resolverUrlDelWorker(envDesdeObjeto({ AI_WORKER_URL: 'http://a:1/', WORKER_URL: 'http://b:2' })),
    ).toBe('http://a:1');
    expect(resolverUrlDelWorker(envDesdeObjeto({ WORKER_URL: 'http://b:2//' }))).toBe('http://b:2');
    expect(resolverUrlDelWorker(envDesdeObjeto({ AI_WORKER_URL: '  ', WORKER_URL: 'http://b:2' }))).toBe(
      'http://b:2',
    );
    expect(resolverUrlDelWorker(envDesdeObjeto({}))).toBe(URL_DEL_WORKER_POR_DEFECTO);
    expect(URL_DEL_WORKER_POR_DEFECTO).toBe('http://localhost:8000');
  });

  it('el cliente usa WORKER_URL cuando AI_WORKER_URL no está definida', async () => {
    const s = await servidor((_q, res) => responder(res, 200, exitoFinal()));
    const c = new WorkerModelClient({ env: envDesdeObjeto({ WORKER_URL: s.url }) });
    expect((await c.turn(peticion)).kind).toBe('final');
    expect(s.peticiones).toHaveLength(1);
  });

  it('AI_WORKER_URL tiene prioridad sobre WORKER_URL', async () => {
    const bueno = await servidor((_q, res) => responder(res, 200, exitoFinal()));
    const malo = await servidor((_q, res) => responder(res, 500, 'no debería llamarse'));
    const c = new WorkerModelClient({
      env: envDesdeObjeto({ AI_WORKER_URL: bueno.url, WORKER_URL: malo.url }),
    });
    await c.turn(peticion);
    expect(bueno.peticiones).toHaveLength(1);
    expect(malo.peticiones).toHaveLength(0);
  });
});
