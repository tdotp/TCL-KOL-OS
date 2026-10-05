import { describe, expect, it } from 'vitest';
import { ModelError } from '../contracts.ts';
import {
  POLITICA_DE_REINTENTOS_POR_DEFECTO,
  conReintentos,
  dormir,
  esperaDeReintento,
  type PoliticaDeReintentos,
} from './retry.ts';

function politica(sobre: Partial<PoliticaDeReintentos> = {}) {
  const esperas: number[] = [];
  const p: PoliticaDeReintentos = {
    ...POLITICA_DE_REINTENTOS_POR_DEFECTO,
    random: () => 0,
    sleep: async (ms) => {
      esperas.push(ms);
    },
    ...sobre,
  };
  return { p, esperas };
}

const transitorio = (retryAfterS: number | null = null) =>
  new ModelError('MODEL_UPSTREAM_ERROR', true, retryAfterS);

describe('conReintentos', () => {
  it('no espera ni reintenta si el primer intento sale bien', async () => {
    const { p, esperas } = politica();
    let llamadas = 0;
    const r = await conReintentos(async () => (llamadas += 1), p);
    expect(r).toBe(1);
    expect(esperas).toEqual([]);
  });

  it('error transitorio ×2 → éxito: 3 intentos, esperas 1 s y 3 s', async () => {
    const { p, esperas } = politica();
    let llamadas = 0;
    const r = await conReintentos(async () => {
      llamadas += 1;
      if (llamadas <= 2) throw transitorio();
      return 'ok';
    }, p);
    expect(r).toBe('ok');
    expect(llamadas).toBe(3);
    expect(esperas).toEqual([1_000, 3_000]);
  });

  it('agota los reintentos (2) y lanza el último error', async () => {
    const { p } = politica();
    let llamadas = 0;
    await expect(
      conReintentos(async () => {
        llamadas += 1;
        throw transitorio();
      }, p),
    ).rejects.toMatchObject({ code: 'MODEL_UPSTREAM_ERROR', retryable: true });
    expect(llamadas).toBe(3);
  });

  it('nunca reintenta un error no retryable', async () => {
    const { p, esperas } = politica();
    let llamadas = 0;
    await expect(
      conReintentos(async () => {
        llamadas += 1;
        throw new ModelError('MODEL_CONTEXT_TOO_LARGE', false);
      }, p),
    ).rejects.toMatchObject({ code: 'MODEL_CONTEXT_TOO_LARGE' });
    expect(llamadas).toBe(1);
    expect(esperas).toEqual([]);
  });

  it('un error que no es ModelError (un bug) se propaga sin reintentar', async () => {
    const { p } = politica();
    let llamadas = 0;
    await expect(
      conReintentos(async () => {
        llamadas += 1;
        throw new TypeError('boom');
      }, p),
    ).rejects.toThrow('boom');
    expect(llamadas).toBe(1);
  });

  it('respeta retry_after_s (como mínimo) y no reintenta si supera el tope', async () => {
    const corto = politica();
    let n = 0;
    await conReintentos(async () => {
      n += 1;
      if (n === 1) throw transitorio(7);
      return 'ok';
    }, corto.p);
    expect(corto.esperas).toEqual([7_000]);

    const largo = politica();
    let m = 0;
    await expect(
      conReintentos(async () => {
        m += 1;
        throw transitorio(60);
      }, largo.p),
    ).rejects.toMatchObject({ retryAfterS: 60 });
    expect(m).toBe(1);
    expect(largo.esperas).toEqual([]);
  });

  it('el jitter se suma a la espera base sin superar el 25 %', () => {
    const base = { ...POLITICA_DE_REINTENTOS_POR_DEFECTO };
    expect(esperaDeReintento({ ...base, random: () => 0 }, 1, null)).toBe(1_000);
    expect(esperaDeReintento({ ...base, random: () => 0.999 }, 1, null)).toBeLessThan(1_250);
    expect(esperaDeReintento({ ...base, random: () => 0.999 }, 2, null)).toBeLessThan(3_750);
    // El último valor del backoff se repite.
    expect(esperaDeReintento({ ...base, random: () => 0 }, 5, null)).toBe(3_000);
  });

  it('una señal abortada corta la espera y el bucle', async () => {
    const control = new AbortController();
    let llamadas = 0;
    const p: PoliticaDeReintentos = {
      ...POLITICA_DE_REINTENTOS_POR_DEFECTO,
      backoffMs: [60_000],
      sleep: dormir,
    };
    const promesa = conReintentos(
      async () => {
        llamadas += 1;
        throw transitorio();
      },
      p,
      control.signal,
    );
    setTimeout(() => control.abort(), 20);
    await expect(promesa).rejects.toMatchObject({ code: 'ABORTED', retryable: false });
    expect(llamadas).toBe(1);
  });

  it('con la señal ya abortada no reintenta', async () => {
    const control = new AbortController();
    control.abort();
    const { p } = politica();
    let llamadas = 0;
    await expect(
      conReintentos(
        async () => {
          llamadas += 1;
          throw transitorio();
        },
        p,
        control.signal,
      ),
    ).rejects.toMatchObject({ code: 'MODEL_UPSTREAM_ERROR' });
    expect(llamadas).toBe(1);
  });
});
