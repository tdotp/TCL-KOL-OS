/**
 * QA adversarial · vector 12: `sanitizarJsonAcotado` / `sanitizarArgsDeTool` frente a razonamiento anidado,
 * secretos, ciclos, tamaños y claves peligrosas (puro: no usa BD). Las evasiones por grafía están en
 * `qa-defectos.qa-red.test.ts` (QA-08).
 */
import { describe, expect, it } from 'vitest';
import {
  CHAT_LIMITS,
  sanitizarArgsDeTool,
  sanitizarJsonAcotado,
  sanitizarManifiestoDeContexto,
  sanitizarResultadoDeTool,
} from '@tcl-kol-os/domain';

const texto = (v: unknown): string => JSON.stringify(v);

describe('V12 · razonamiento y secretos', () => {
  it('claves de razonamiento (cualquier mayúscula/separador/profundidad, dentro de arrays) se descartan', () => {
    const entrada = {
      a: {
        b: {
          c: [{ reasoning: 'COT-1', ok: 1 }, { Reasoning_Content: 'COT-2' }, { 'chain-of-thought': 'COT-3' }],
        },
      },
      THINKING: 'COT-4',
      'thought s': 'COT-5',
      Scratchpad: 'COT-6',
      internal_monologue: 'COT-7',
      reasoningDetails: [{ x: 'COT-8' }],
      cot: 'COT-9',
    };
    const s = sanitizarArgsDeTool(entrada);
    for (let i = 1; i <= 9; i++) expect(texto(s.valor)).not.toContain(`COT-${i}`);
    expect(s.alterado).toBe(true);
    expect(texto(s.valor)).toContain('"ok":1');
  });

  it('claves de secreto (cualquier grafía ASCII) se redactan a cualquier profundidad', () => {
    const s = sanitizarResultadoDeTool({
      x: {
        Authorization: 'Bearer SECRETO-1',
        'API-Key': 'SECRETO-2',
        access_token: 'SECRETO-3',
        REFRESHTOKEN: 'SECRETO-4',
        Password: 'SECRETO-5',
        cookie: 'SECRETO-6',
      },
      lista: [{ secret: 'SECRETO-7' }],
    });
    for (let i = 1; i <= 7; i++) expect(texto(s.valor)).not.toContain(`SECRETO-${i}`);
    expect(texto(s.valor)).toContain('[redactado]');
  });
});

describe('V12 · estructura hostil', () => {
  it('ciclos, profundidad, bigint, fechas, undefined, funciones, NUL, NaN: nunca lanza y devuelve JSON válido', () => {
    const ciclo: Record<string, unknown> = { a: 1 };
    ciclo['yo'] = ciclo;
    let hondo: unknown = 'fin';
    for (let i = 0; i < 50; i++) hondo = { n: hondo };
    const s = sanitizarJsonAcotado(
      {
        ciclo,
        hondo,
        big: 10n ** 30n,
        fecha: new Date(0),
        nada: undefined,
        f: () => 1,
        nul: 'a\u0000b',
        nan: Number.NaN,
        inf: Number.POSITIVE_INFINITY,
        [Symbol('s') as never]: 1,
      },
      { maxBytes: 16_384 },
    );
    expect(() => JSON.stringify(s.valor)).not.toThrow();
    expect(texto(s.valor)).not.toContain('\\u0000');
    expect(JSON.parse(texto(s.valor))).toBeTypeOf('object');
    expect(s.alterado).toBe(true);
  });

  it('`__proto__` / `constructor` como claves propias no contaminan Object.prototype GLOBAL (el prototipo del objeto saneado: QA-23, prueba roja)', () => {
    const entrada = JSON.parse(
      '{"__proto__":{"polucion":true},"constructor":{"prototype":{"x":1}},"ok":1}',
    ) as unknown;
    const s = sanitizarArgsDeTool(entrada);
    expect(({} as Record<string, unknown>)['polucion']).toBeUndefined();
    expect(({} as Record<string, unknown>)['x']).toBeUndefined();
    expect((s.valor as Record<string, unknown>)['ok']).toBe(1);
  });

  it('el tope de bytes se respeta SIEMPRE (medido como jsonb::text): 16 KB para args, 32 KB para resultado y manifiesto', () => {
    const enorme = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`k${i}`, 'x'.repeat(2_000)]));
    for (const [fn, tope] of [
      [sanitizarArgsDeTool, CHAT_LIMITS.toolArgsMaxBytes],
      [sanitizarResultadoDeTool, CHAT_LIMITS.toolResultMaxBytes],
      [sanitizarManifiestoDeContexto, CHAT_LIMITS.contextManifestMaxBytes],
    ] as const) {
      const s = fn(enorme);
      expect(s.bytes).toBeLessThanOrEqual(tope);
    }
    // multibyte: 2 000 emojis (4 bytes) en 100 claves
    const emojis = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`e${i}`, '😀'.repeat(1_500)]));
    expect(sanitizarArgsDeTool(emojis).bytes).toBeLessThanOrEqual(CHAT_LIMITS.toolArgsMaxBytes);
  });

  it('una entrada que no es objeto (array, texto, null) se convierte en {} marcando `alterado`', () => {
    for (const x of [[1, 2], 'texto', null, 7, undefined]) {
      const s = sanitizarArgsDeTool(x);
      expect(s.valor).toEqual({});
      expect(s.alterado).toBe(true);
    }
  });
});
