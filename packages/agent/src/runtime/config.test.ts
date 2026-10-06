import { describe, expect, it } from 'vitest';
import { tierFor } from '@tcl-kol-os/domain';
import { envDesdeObjeto } from '../model/env.ts';
import { PROMPT_VERSION } from '../prompts/agente-cuenta.ts';
import {
  MAX_TOOL_STEPS_POR_DEFECTO,
  MAX_TOOL_STEPS_TOPE_DURO,
  acotarLimites,
  configuracionDeRun,
  iaActiva,
  limitesDesdeEnv,
  secretoDelNonce,
} from './config.ts';

describe('kill-switch AI_ENABLED (D8)', () => {
  it('solo 1/true/yes lo encienden; sin definir = apagado (igual que el worker)', () => {
    for (const v of ['1', 'true', 'TRUE', ' yes ', 'Yes'])
      expect(iaActiva(envDesdeObjeto({ AI_ENABLED: v }))).toBe(true);
    for (const v of [undefined, '', '0', 'false', 'no', 'si', 'on']) {
      expect(iaActiva(envDesdeObjeto({ AI_ENABLED: v }))).toBe(false);
    }
  });
});

describe('límites', () => {
  it('valores por defecto: 8 pasos, 180 s, 45 s por modelo, 4 tools por paso', () => {
    expect(limitesDesdeEnv(envDesdeObjeto({}))).toEqual({
      maxSteps: 8,
      deadlineMs: 180_000,
      maxToolCallsPorPaso: 4,
      modelTimeoutMs: 45_000,
      maxTokens: 2_048,
    });
    expect(MAX_TOOL_STEPS_POR_DEFECTO).toBe(8);
  });

  it('AGENT_MAX_TOOL_STEPS respeta el tope duro de 15 y descarta basura', () => {
    expect(limitesDesdeEnv(envDesdeObjeto({ AGENT_MAX_TOOL_STEPS: '3' })).maxSteps).toBe(3);
    expect(limitesDesdeEnv(envDesdeObjeto({ AGENT_MAX_TOOL_STEPS: '99' })).maxSteps).toBe(
      MAX_TOOL_STEPS_TOPE_DURO,
    );
    expect(limitesDesdeEnv(envDesdeObjeto({ AGENT_MAX_TOOL_STEPS: '0' })).maxSteps).toBe(1);
    for (const basura of ['-4', 'abc', '2.5', '']) {
      expect(limitesDesdeEnv(envDesdeObjeto({ AGENT_MAX_TOOL_STEPS: basura })).maxSteps).toBe(8);
    }
  });

  it('las sobreescrituras por parámetro tampoco superan los topes duros', () => {
    const base = limitesDesdeEnv(envDesdeObjeto({}));
    expect(acotarLimites(base, { maxSteps: 500, maxToolCallsPorPaso: 50 })).toMatchObject({
      maxSteps: 15,
      maxToolCallsPorPaso: 4,
    });
    expect(acotarLimites(base, { maxSteps: 2 }).maxSteps).toBe(2);
  });
});

describe('configuracionDeRun: procedencia verificable', () => {
  it('tier del catálogo (conversar), modelo y proveedor del entorno, versiones del código', () => {
    const c = configuracionDeRun(
      envDesdeObjeto({ AI_PROVIDER: 'openrouter', AI_MODEL_EQUILIBRADO: 'anthropic/claude-haiku-4.5' }),
    );
    expect(c).toEqual({
      provider: 'openrouter',
      model: 'anthropic/claude-haiku-4.5',
      tier: tierFor('conversar'),
      promptVersion: PROMPT_VERSION,
      contextVersion: 'ctx-2.budget-2.policy-1',
    });
  });

  it('AI_PROVIDER=fake se refleja; sin modelo configurado se declara explícitamente', () => {
    expect(configuracionDeRun(envDesdeObjeto({ AI_PROVIDER: 'FAKE' })).provider).toBe('fake');
    expect(configuracionDeRun(envDesdeObjeto({})).model).toBe('no-configurado-en-web');
    expect(configuracionDeRun(envDesdeObjeto({})).provider).toBe('openrouter');
  });
});

describe('secreto del nonce', () => {
  it('AGENT_NONCE_SECRET, luego SESSION_SECRET; en desarrollo hay un valor; en producción, no', () => {
    expect(
      secretoDelNonce(envDesdeObjeto({ AGENT_NONCE_SECRET: 'a'.repeat(20), SESSION_SECRET: 'b'.repeat(20) })),
    ).toBe('a'.repeat(20));
    expect(secretoDelNonce(envDesdeObjeto({ SESSION_SECRET: 'b'.repeat(20) }))).toBe('b'.repeat(20));
    expect(secretoDelNonce(envDesdeObjeto({}))).toBeDefined();
    expect(secretoDelNonce(envDesdeObjeto({ NODE_ENV: 'production' }))).toBeUndefined();
    // Un secreto demasiado corto no se acepta ni siquiera en desarrollo.
    expect(secretoDelNonce(envDesdeObjeto({ SESSION_SECRET: 'corto' }))).toBeUndefined();
  });
});
