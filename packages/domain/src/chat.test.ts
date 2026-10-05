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
  esCodigoDeErrorValido,
  isRunActive,
  isRunTerminal,
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
