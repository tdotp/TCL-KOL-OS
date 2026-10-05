/**
 * V2 · Fase 6 — contratos puros del chat y del agente: estados, límites,
 * validaciones y sanitización profunda de JSON (sin razonamiento del modelo).
 */

import { describe, expect, it } from 'vitest';
import {
  AGENT_RUN_ACTIVE_STATUSES,
  AGENT_RUN_STATUSES,
  AGENT_RUN_TERMINAL_STATUSES,
  CHAT_LIMITS,
  CHAT_MESSAGE_ROLES,
  TOOL_INVOCATION_STATUSES,
  TOOL_RISK_CLASSES,
  bytesComoJsonb,
  claveDeInvocacion,
  redactarSecretosEnTexto,
  COSTO_USD_MAX,
  INT4_MAX,
  esCodigoDeErrorValido,
  isRunActive,
  isRunTerminal,
  normalizarCifrasDeLlamada,
  puedeTransicionarInvocacion,
  puedeTransicionarRun,
  sanitizarArgsDeTool,
  sanitizarJsonAcotado,
  sanitizarManifiestoDeContexto,
  sanitizarMensajeDeError,
  sanitizarResultadoDeTool,
  validarAdjuntos,
  validarClientMessageId,
  validarConfiguracionDeRun,
  validarContenidoMensaje,
  validarTituloConversacion,
} from './chat';
import { allTasks, specFor, tareasGenerativas, tierFor } from './ai-tasks';

describe('roles de mensaje y estados', () => {
  it('solo user y assistant: system y tool no son mensajes', () => {
    expect([...CHAT_MESSAGE_ROLES]).toEqual(['user', 'assistant']);
  });

  it('el run activo es queued o running; el resto son terminales', () => {
    expect([...AGENT_RUN_ACTIVE_STATUSES]).toEqual(['queued', 'running']);
    expect([...AGENT_RUN_TERMINAL_STATUSES].sort()).toEqual(['cancelled', 'completed', 'failed']);
    for (const s of AGENT_RUN_STATUSES) expect(isRunActive(s) !== isRunTerminal(s), s).toBe(true);
  });

  it('transiciones de run: queued → running|failed|cancelled; running → completed|failed|cancelled; los terminales no avanzan', () => {
    expect(puedeTransicionarRun('queued', 'running')).toBe(true);
    expect(puedeTransicionarRun('queued', 'failed')).toBe(true);
    expect(puedeTransicionarRun('queued', 'cancelled')).toBe(true);
    expect(puedeTransicionarRun('queued', 'completed')).toBe(false);
    expect(puedeTransicionarRun('running', 'completed')).toBe(true);
    expect(puedeTransicionarRun('running', 'queued')).toBe(false);
    for (const terminal of AGENT_RUN_TERMINAL_STATUSES) {
      for (const destino of AGENT_RUN_STATUSES) {
        expect(puedeTransicionarRun(terminal, destino), `${terminal} → ${destino}`).toBe(false);
      }
    }
  });

  it('invocaciones: solo running se cierra; las cerradas no cambian', () => {
    for (const destino of TOOL_INVOCATION_STATUSES) {
      expect(puedeTransicionarInvocacion('running', destino)).toBe(destino !== 'running');
      expect(puedeTransicionarInvocacion('succeeded', destino)).toBe(false);
      expect(puedeTransicionarInvocacion('failed', destino)).toBe(false);
    }
  });

  it('el riesgo de una tool es uno de cuatro; confirmation_required solo propone', () => {
    expect([...TOOL_RISK_CLASSES]).toEqual(['read', 'write', 'confirmation_required', 'unregistered']);
  });
});

describe('validaciones de entrada', () => {
  it('el contenido se conserva tal cual y se acota', () => {
    const r = validarContenidoMensaje('  Hola  \n  agente  ');
    expect(r.ok && r.value).toBe('  Hola  \n  agente  ');
    expect(validarContenidoMensaje('   ').ok).toBe(false);
    expect(validarContenidoMensaje(42).ok).toBe(false);
    expect(validarContenidoMensaje('x'.repeat(CHAT_LIMITS.mensajeMax)).ok).toBe(true);
    expect(validarContenidoMensaje('x'.repeat(CHAT_LIMITS.mensajeMax + 1)).ok).toBe(false);
    expect(validarContenidoMensaje('con\u0000nulo').ok).toBe(false);
  });

  it('la clave de idempotencia: 8 a 128 caracteres de [A-Za-z0-9_-]', () => {
    expect(validarClientMessageId('3f2b8c1e-aaaa-4bbb-8ccc-123456789abc').ok).toBe(true);
    expect(validarClientMessageId('corta').ok).toBe(false);
    expect(validarClientMessageId('con espacios 123').ok).toBe(false);
    expect(validarClientMessageId('a'.repeat(129)).ok).toBe(false);
    expect(validarClientMessageId(undefined).ok).toBe(false);
  });

  it('el título es opcional y se recorta; vacío = sin título', () => {
    const r = validarTituloConversacion('  Lanzamiento P80  ');
    expect(r.ok && r.value).toBe('Lanzamiento P80');
    const vacio = validarTituloConversacion('   ');
    expect(vacio.ok && vacio.value).toBeUndefined();
    const nulo = validarTituloConversacion(undefined);
    expect(nulo.ok && nulo.value).toBeUndefined();
    expect(validarTituloConversacion('x'.repeat(201)).ok).toBe(false);
  });

  it('los adjuntos: sin repetidos, hasta el máximo, solo textos', () => {
    expect(validarAdjuntos(undefined).ok).toBe(true);
    expect(validarAdjuntos(['a', 'b']).ok).toBe(true);
    expect(validarAdjuntos(['a', 'a']).ok).toBe(false);
    expect(validarAdjuntos(['']).ok).toBe(false);
    expect(validarAdjuntos([1] as never).ok).toBe(false);
    expect(validarAdjuntos('a' as never).ok).toBe(false);
    const diez = Array.from({ length: CHAT_LIMITS.adjuntosPorMensaje }, (_, i) => `s${i}`);
    expect(validarAdjuntos(diez).ok).toBe(true);
    expect(validarAdjuntos([...diez, 'extra']).ok).toBe(false);
  });

  it('la configuración del run exige proveedor, modelo, nivel válido y versiones', () => {
    const buena = {
      provider: 'openrouter',
      model: 'anthropic/claude-sonnet',
      tier: 'equilibrado',
      promptVersion: 'p1',
      contextVersion: 'c1',
    };
    expect(validarConfiguracionDeRun(buena).ok).toBe(true);
    expect(validarConfiguracionDeRun({ ...buena, tier: 'gigante' }).ok).toBe(false);
    expect(validarConfiguracionDeRun({ ...buena, model: '' }).ok).toBe(false);
    expect(validarConfiguracionDeRun({ ...buena, promptVersion: undefined }).ok).toBe(false);
    expect(validarConfiguracionDeRun(null).ok).toBe(false);
  });

  it('los códigos de error son identificadores en mayúsculas y el mensaje se aplana y acota', () => {
    expect(esCodigoDeErrorValido('RUN_ABANDONED')).toBe(true);
    expect(esCodigoDeErrorValido('run_abandoned')).toBe(false);
    expect(esCodigoDeErrorValido('X')).toBe(false);
    expect(esCodigoDeErrorValido('CON ESPACIO')).toBe(false);
    expect(sanitizarMensajeDeError('línea 1\nlínea 2\t fin')).toBe('línea 1 línea 2 fin');
    expect(sanitizarMensajeDeError('   ')).toBeUndefined();
    expect(sanitizarMensajeDeError(5)).toBeUndefined();
    const largo = sanitizarMensajeDeError('x'.repeat(2_000));
    expect(largo!.length).toBe(CHAT_LIMITS.errorMensajeMax);
  });

  it('la clave de idempotencia de una invocación prefiere el id de llamada y es estable', () => {
    const base = { stepIndex: 2, toolName: 'source_list', argsSha256: 'a'.repeat(64) };
    expect(claveDeInvocacion({ ...base, toolCallId: 'call_9' })).toBe('s2:call:call_9');
    expect(claveDeInvocacion(base)).toBe(`s2:args:source_list:${'a'.repeat(32)}`);
    expect(claveDeInvocacion(base)).toBe(claveDeInvocacion({ ...base }));
    expect(claveDeInvocacion({ ...base, toolCallId: 'x'.repeat(500) }).length).toBeLessThanOrEqual(200);
  });
});

describe('sanitización profunda de JSON (args, result, manifiesto)', () => {
  const OPC = { maxBytes: 4_000 };

  it('descarta razonamiento del modelo (chain-of-thought) a cualquier profundidad', () => {
    const r = sanitizarJsonAcotado(
      {
        ok: 1,
        reasoning: 'primero pienso',
        Reasoning_Content: 'otro',
        anidado: {
          thinking: 'hmm',
          thought: 'x',
          chain_of_thought: 'paso',
          cot: 'c',
          scratchpad: 's',
          ids: [1, 2],
        },
        lista: [{ internalMonologue: 'x', valor: 3 }],
      },
      OPC,
    );
    expect(r.valor).toEqual({ ok: 1, anidado: { ids: [1, 2] }, lista: [{ valor: 3 }] });
    expect(r.alterado).toBe(true);
    expect(JSON.stringify(r.valor)).not.toMatch(/pienso|hmm|paso/);
  });

  it('redacta secretos y datos personales sensibles por clave, a cualquier profundidad', () => {
    const r = sanitizarJsonAcotado(
      {
        token: 'abc',
        a: { Password: 'x', apiKey: 'k', 'access-token': 't', authorization: 'Bearer z', cedula: '123' },
        ok: true,
      },
      OPC,
    );
    expect(r.valor).toEqual({
      token: '[redactado]',
      a: {
        Password: '[redactado]',
        apiKey: '[redactado]',
        'access-token': '[redactado]',
        authorization: '[redactado]',
        cedula: '[redactado]',
      },
      ok: true,
    });
  });

  it('solo JSON: omite undefined/funciones, pasa bigint y fechas a texto, números no finitos a null', () => {
    const r = sanitizarJsonAcotado(
      {
        a: undefined,
        f: () => 1,
        s: Symbol('x'),
        big: 10n,
        fecha: new Date('2026-10-04T00:00:00Z'),
        nan: Number.NaN,
        inf: Infinity,
        n: 1.5,
      },
      OPC,
    );
    expect(r.valor).toEqual({ big: '10', fecha: '2026-10-04T00:00:00.000Z', nan: null, inf: null, n: 1.5 });
  });

  it('acota textos, listas, claves, profundidad y ciclos; quita el carácter NUL', () => {
    const ciclo: Record<string, unknown> = { nombre: 'ciclo' };
    ciclo['yo'] = ciclo;
    const r = sanitizarJsonAcotado(
      {
        largo: 'y'.repeat(5_000),
        nul: 'a\u0000b',
        lista: Array.from({ length: 500 }, (_, i) => i),
        profundo: { a: { b: { c: { d: { e: { f: { g: 1 } } } } } } },
        ciclo,
      },
      { maxBytes: 100_000, maxTexto: 100, maxElementosPorLista: 10, maxProfundidad: 4 },
    );
    const v = r.valor as Record<string, unknown>;
    expect((v['largo'] as string).length).toBe(100);
    expect(v['nul']).toBe('ab');
    expect(v['lista']).toHaveLength(10);
    expect(JSON.stringify(v['profundo'])).toContain('[omitido]');
    expect((v['ciclo'] as Record<string, unknown>)['yo']).toBe('[omitido]');
    expect(r.alterado).toBe(true);
  });

  it('la raíz siempre es un objeto: listas y escalares se descartan', () => {
    expect(sanitizarJsonAcotado([1, 2, 3], OPC)).toMatchObject({ valor: {}, alterado: true });
    expect(sanitizarJsonAcotado('texto', OPC).valor).toEqual({});
    expect(sanitizarJsonAcotado(null, OPC).valor).toEqual({});
    expect(sanitizarJsonAcotado(undefined, OPC).valor).toEqual({});
  });

  it('si aun recortado excede el tope, queda un marcador mínimo (no el contenido)', () => {
    const muchas = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`clave_${i}`, 'z'.repeat(200)]));
    const r = sanitizarJsonAcotado(muchas, { maxBytes: 1_000 });
    expect(r.valor).toMatchObject({ _truncado: true });
    expect(r.bytes).toBeLessThanOrEqual(1_000);
    expect(r.alterado).toBe(true);
  });

  it('mide como Postgres (jsonb::text lleva espacio tras : y ,), de modo que el CHECK de la base nunca falla', () => {
    // {"a": 1, "b": [1, 2]} = 21 caracteres con el formato de jsonb.
    expect(bytesComoJsonb({ a: 1, b: [1, 2] })).toBe(21);
    expect(bytesComoJsonb({ texto: 'ñandú' })).toBe(Buffer.byteLength('{"texto": "ñandú"}', 'utf8'));
    const args = sanitizarArgsDeTool({ x: 'a'.repeat(100_000) });
    expect(args.bytes).toBeLessThanOrEqual(CHAT_LIMITS.toolArgsMaxBytes);
    const resultado = sanitizarResultadoDeTool({ ids: Array.from({ length: 100 }, (_, i) => `id-${i}`) });
    expect(resultado.bytes).toBeLessThanOrEqual(CHAT_LIMITS.toolResultMaxBytes);
    const manifiesto = sanitizarManifiestoDeContexto({ fuentes: 3, reasoning: 'no' });
    expect(manifiesto.valor).toEqual({ fuentes: 3 });
  });
});

describe('tarea de IA «conversar» (D16)', () => {
  it('existe, es de nivel equilibrado y generativa; no cambia el resto del catálogo', () => {
    expect(tierFor('conversar')).toBe('equilibrado');
    const spec = specFor('conversar');
    expect(spec.generativa).toBe(true);
    expect(spec.salidaEstructurada).toBe(false);
    expect(spec.control).toMatch(/propone; nunca aprueba/);
    expect(tareasGenerativas()).toContain('conversar');
    expect(allTasks().map((s) => s.task)).toEqual([
      'extraer_campos',
      'detectar_vacios',
      'traducir',
      'redactar_brief',
      'buscar_evidencia',
      'resolver_ambiguedad',
      'generar_embedding',
      'conversar',
    ]);
    // Los niveles previos no se tocan.
    expect(tierFor('extraer_campos')).toBe('eficiente');
    expect(tierFor('resolver_ambiguedad')).toBe('equilibrado');
  });
});

// ─────────────────────────── QA-08 / QA-23: saneamiento adversarial ───────────

describe('sanitizarJsonAcotado: claves disfrazadas y secretos en valores (QA-08)', () => {
  const cirilica = (palabra: string): string =>
    palabra.replace(/e/g, '\u0435').replace(/o/g, '\u043e').replace(/a/g, '\u0430');

  it('descarta claves de razonamiento con homoglifos, ancho completo, acentos, mayúsculas y separadores', () => {
    const entrada: Record<string, unknown> = {
      ok: 1,
      [cirilica('reasoning')]: 'COT-1',
      [cirilica('razonamiento')]: 'COT-2',
      ｒｅａｓｏｎｉｎｇ: 'COT-3',
      Razonamiento_Interno: 'COT-4',
      pensamiento: 'COT-5',
      'Cadena de pensamiento': 'COT-6',
      'chain-of-thought': 'COT-7',
      'th\u200binking': 'COT-8',
      'razonamiént\u00f3': 'COT-9',
      reasoning_summary: 'COT-10',
      'monólogo interno': 'COT-11',
      scratchpad: 'COT-12',
      Thought: 'COT-13',
    };
    const r = sanitizarArgsDeTool(entrada);
    expect(r.valor).toEqual({ ok: 1 });
    expect(r.alterado).toBe(true);
    expect(JSON.stringify(r.valor)).not.toContain('COT-');
  });

  it('también descarta razonamiento anidado con grafías disfrazadas', () => {
    const r = sanitizarResultadoDeTool({ a: [{ b: { [cirilica('thinking')]: 'COT-X', nota: 'visible' } }] });
    expect(r.valor).toEqual({ a: [{ b: { nota: 'visible' } }] });
  });

  it('redacta el valor de claves de secreto con grafías disfrazadas', () => {
    const r = sanitizarArgsDeTool({
      [cirilica('password')]: 'S1',
      'API-KEY': 'S2',
      Contraseña: 'S3',
      openai_api_key: 'S4',
      dbPassword: 'S5',
      Authorization: 'S6',
      clientSecret: 'S7',
    });
    for (const v of Object.values(r.valor)) expect(v).toBe('[redactado]');
    expect(Object.keys(r.valor)).toHaveLength(7);
  });

  it('no sobre-redacta: claves y textos corrientes se conservan', () => {
    const entrada = {
      reason: 'cambio de plan',
      razon: 'presupuesto',
      promptTokens: 120,
      tokens: 3,
      nota: 'Quiero un resumen básico (basic information) del plan.',
      texto: 'El token de acceso se renueva cada hora; la contraseña se cambia desde ajustes.',
      campos: ['mercado', 'categoría'],
    };
    const r = sanitizarArgsDeTool(entrada);
    expect(r.valor).toEqual(entrada);
    expect(r.alterado).toBe(false);
  });

  it('redacta secretos DENTRO de un valor (cabeceras, claves de API, JWT, claves privadas, pares clave=valor)', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r';
    const casos: Array<[string, string]> = [
      ['Authorization: Bearer sk-SECRETO-EN-VALOR-SENTINELA', 'sk-SECRETO'],
      ['usa la clave sk-proj-abcdefghijklmnopqrstuvwx para entrar', 'sk-proj-abcdef'],
      [`token ${jwt}`, 'eyJhbGci'],
      ['api_key=ABCDEF123456 y sigue', 'ABCDEF123456'],
      ['PASSWORD: hunter2hunter2', 'hunter2'],
      ['OPENAI_API_KEY=sk-live_abcdefghijklmnop', 'abcdefghijklmnop'],
      [
        '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\n-----END RSA PRIVATE KEY-----',
        'MIIEowIBAAKCAQEA',
      ],
      ['AKIAIOSFODNN7EXAMPLE', 'AKIAIOSFODNN7EXAMPLE'],
      ['ghp_abcdefghijklmnopqrstuvwxyz0123456789', 'ghp_abcdefgh'],
    ];
    for (const [texto, secreto] of casos) {
      const r = sanitizarArgsDeTool({ nota: texto, lista: [texto], anidado: { x: texto } });
      const salida = JSON.stringify(r.valor);
      expect(salida, texto).not.toContain(secreto);
      expect(salida, texto).toContain('[redactado]');
      expect(r.alterado).toBe(true);
    }
    expect(redactarSecretosEnTexto('sin secretos: hola')).toBe('sin secretos: hola');
  });

  it('redacta ANTES de recortar: un recorte no deja medio secreto', () => {
    const r = sanitizarJsonAcotado(
      { nota: `${'a'.repeat(10)} sk-${'Z'.repeat(40)}` },
      { maxBytes: 4_096, maxTexto: 20 },
    );
    expect(JSON.stringify(r.valor)).not.toContain('ZZZZ');
  });
});

describe('sanitizarJsonAcotado: claves de prototipo (QA-23)', () => {
  it('una clave propia __proto__ se descarta y no cambia el prototipo del resultado', () => {
    const r = sanitizarArgsDeTool(JSON.parse('{"__proto__":{"polucion":true},"ok":1}') as unknown);
    expect(Object.getPrototypeOf(r.valor)).toBe(Object.prototype);
    expect((r.valor as Record<string, unknown>)['polucion']).toBeUndefined();
    expect(Object.keys(r.valor)).toEqual(['ok']);
    expect(r.alterado).toBe(true);
    expect(({} as Record<string, unknown>)['polucion']).toBeUndefined();
  });

  it('__proto__ anidado y con NUL también se descarta; constructor/prototype son datos inertes', () => {
    const r = sanitizarArgsDeTool(
      JSON.parse('{"a":{"__pro\\u0000to__":{"x":1},"constructor":{"y":2},"prototype":3}}') as unknown,
    );
    const a = r.valor['a'] as Record<string, unknown>;
    expect(Object.getPrototypeOf(a)).toBe(Object.prototype);
    expect(Object.keys(a).sort()).toEqual(['constructor', 'prototype']);
    expect(a['x']).toBeUndefined();
  });
});

describe('normalizarCifrasDeLlamada (QA-06)', () => {
  it('cifras normales pasan intactas', () => {
    expect(
      normalizarCifrasDeLlamada({
        latencyMs: 120,
        promptTokens: 1_000,
        completionTokens: 50,
        costUsd: 0.012345,
      }),
    ).toEqual({
      latencyMs: 120,
      promptTokens: 1_000,
      completionTokens: 50,
      costUsd: 0.012345,
      anomalias: [],
    });
    expect(normalizarCifrasDeLlamada({})).toMatchObject({ promptTokens: null, costUsd: null, anomalias: [] });
  });

  it('acota lo desmedido, descarta lo inválido y lo nombra en las anomalías', () => {
    const r = normalizarCifrasDeLlamada({
      promptTokens: 3_000_000_000,
      completionTokens: -5,
      latencyMs: Number.NaN,
      costUsd: 123_456.5,
    });
    expect(r).toEqual({
      latencyMs: null,
      promptTokens: INT4_MAX,
      completionTokens: null,
      costUsd: COSTO_USD_MAX,
      anomalias: ['latency_ms', 'prompt_tokens', 'completion_tokens', 'cost_usd'],
    });
    expect(normalizarCifrasDeLlamada({ costUsd: Number.POSITIVE_INFINITY })).toMatchObject({
      costUsd: null,
      anomalias: ['cost_usd'],
    });
    expect(normalizarCifrasDeLlamada({ costUsd: -1 })).toMatchObject({ costUsd: null });
    expect(normalizarCifrasDeLlamada({ promptTokens: 10.4 })).toMatchObject({
      promptTokens: 10,
      anomalias: ['prompt_tokens'],
    });
  });

  it('el costo se redondea a 6 decimales (numeric(10,6))', () => {
    expect(normalizarCifrasDeLlamada({ costUsd: 0.1234567891 }).costUsd).toBe(0.123457);
    expect(normalizarCifrasDeLlamada({ costUsd: COSTO_USD_MAX }).anomalias).toEqual([]);
  });
});
