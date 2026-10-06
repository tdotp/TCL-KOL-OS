/**
 * V2 · Fase 7 — idempotencia y concurrencia del análisis asistido (cliente guionado, PostgreSQL real).
 *
 * Misma clave ⇒ mismo run (una sola llamada al modelo); misma clave con otro pedido ⇒ conflicto; cinco
 * solicitudes simultáneas ⇒ un solo run y una sola llamada; el tope por versión; la repetición de un fallo.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Result } from '@tcl-kol-os/domain';
import { closePool, query } from './client.ts';
import { ClienteDeAnalisisGuionado, falloGuionado } from './content-analysis-client.ts';
import {
  ENV_CON_IA,
  type EscenarioDeAnalisis,
  claveNueva,
  clienteQueResponde,
  crearEscenarioDeAnalisis,
  registrarGuionDePrueba,
} from './content-analysis-test-support.ts';
import { LIMITE_DE_ANALISIS_POR_VERSION, solicitarAnalisisDeGuion } from './content-analysis.ts';
import { limpiarEscenarioDeContenido } from './test-utils.ts';

let a: EscenarioDeAnalisis;

const codigo = <T>(r: Result<T>): string | undefined => (r.ok ? undefined : r.error.code);
const detalle = <T>(r: Result<T>, campo: string): unknown =>
  r.ok ? undefined : (r.error.details as Record<string, unknown> | undefined)?.[campo];
const valor = <T>(r: Result<T>): T => {
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
  return r.value;
};

const versionNueva = async (): Promise<string> =>
  (await registrarGuionDePrueba(a.e, a.deliverableId, a.e.participaciones.valentinaRios, a.e.consultor))
    .versionId;

const deps = (cliente: ClienteDeAnalisisGuionado) => ({ cliente, env: ENV_CON_IA, esperar: async () => {} });
const demora = (ms: number) => () => new Promise<void>((r) => setTimeout(r, ms));

const runsDe = async (versionId: string): Promise<number> =>
  Number(
    (
      await query<{ n: string }>(
        `SELECT count(*) AS n FROM content_analysis_runs WHERE script_version_id = $1`,
        [versionId],
      )
    )[0]!.n,
  );

const pedir = (
  versionId: string,
  idempotencyKey: string,
  cliente: ClienteDeAnalisisGuionado,
  mode: 'ensure' | 'reanalyze' = 'ensure',
) => solicitarAnalisisDeGuion(a.e.consultor, versionId, { mode, idempotencyKey }, undefined, deps(cliente));

beforeAll(async () => {
  a = await crearEscenarioDeAnalisis('analisis-idem');
});

afterAll(async () => {
  await limpiarEscenarioDeContenido(a.e);
  await closePool();
});

describe('misma clave ⇒ mismo run', () => {
  it('repetir la misma clave devuelve el mismo run sin otra llamada al modelo', async () => {
    const versionId = await versionNueva();
    const cliente = clienteQueResponde([{ category: 'cta_missing', refs: ['accion_kpis.accion_esperada'] }]);
    const clave = claveNueva('idem');
    const primero = valor(await pedir(versionId, clave, cliente));
    const segundo = valor(await pedir(versionId, clave, cliente));
    expect(primero.outcome).toBe('created');
    expect(segundo.outcome).toBe('replayed');
    expect(segundo.run.id).toBe(primero.run.id);
    expect(cliente.llamadas).toBe(1);
    expect(await runsDe(versionId)).toBe(1);
  });

  it('la misma clave con OTRO pedido (modo distinto) ⇒ RESOURCE_CONFLICT idempotency_key_reuse, sin run nuevo', async () => {
    const versionId = await versionNueva();
    const cliente = clienteQueResponde([]);
    const clave = claveNueva('reuso');
    valor(await pedir(versionId, clave, cliente, 'ensure'));
    const r = await pedir(versionId, clave, cliente, 'reanalyze');
    expect(codigo(r)).toBe('RESOURCE_CONFLICT');
    expect(detalle(r, 'reason')).toBe('idempotency_key_reuse');
    expect(cliente.llamadas).toBe(1);
    expect(await runsDe(versionId)).toBe(1);
  });

  it('la misma clave en OTRA versión es otro pedido (no colisiona)', async () => {
    const v1 = await versionNueva();
    const v2 = await versionNueva();
    const cliente = clienteQueResponde([]);
    const clave = claveNueva('dos-versiones');
    const r1 = valor(await pedir(v1, clave, cliente));
    const r2 = valor(await pedir(v2, clave, cliente));
    expect(r1.run.id).not.toBe(r2.run.id);
    expect(cliente.llamadas).toBe(2);
  });

  it('repetir la clave de un análisis FALLIDO devuelve el mismo fallo sin llamar de nuevo; reintentar = clave nueva', async () => {
    const versionId = await versionNueva();
    const roto = new ClienteDeAnalisisGuionado(falloGuionado('MODEL_BAD_RESPONSE'));
    const clave = claveNueva('fallo');
    const primero = await pedir(versionId, clave, roto);
    expect(codigo(primero)).toBe('AI_ANALYSIS_FAILED');
    const repetido = await pedir(versionId, clave, roto);
    expect(codigo(repetido)).toBe('AI_ANALYSIS_FAILED');
    expect(detalle(repetido, 'runId')).toBe(detalle(primero, 'runId'));
    expect(detalle(repetido, 'failureCode')).toBe('MODEL_BAD_RESPONSE');
    expect(roto.llamadas).toBe(1);
    // Con una clave nueva es un run nuevo (y esta vez funciona).
    const sano = clienteQueResponde([]);
    const nuevo = valor(await pedir(versionId, claveNueva('fallo-2'), sano));
    expect(nuevo.run.status).toBe('succeeded');
    expect(await runsDe(versionId)).toBe(2);
  });

  it('validación de la clave y del modo', async () => {
    const versionId = await versionNueva();
    const cliente = clienteQueResponde([]);
    expect(codigo(await pedir(versionId, 'corta', cliente))).toBe('VALIDATION_FAILED');
    expect(codigo(await pedir(versionId, 'con espacios y símbolos <>', cliente))).toBe('VALIDATION_FAILED');
    expect(
      codigo(
        await solicitarAnalisisDeGuion(
          a.e.consultor,
          versionId,
          { mode: 'borrar' as unknown as 'ensure', idempotencyKey: claveNueva() },
          undefined,
          deps(cliente),
        ),
      ),
    ).toBe('VALIDATION_FAILED');
    expect(cliente.llamadas).toBe(0);
    expect(await runsDe(versionId)).toBe(0);
  });
});

describe('concurrencia', () => {
  it('5 solicitudes simultáneas con la MISMA clave ⇒ 1 run y 1 llamada', async () => {
    const versionId = await versionNueva();
    const cliente = clienteQueResponde(
      [{ category: 'cta_missing', refs: ['accion_kpis.accion_esperada'] }],
      demora(250),
    );
    const clave = claveNueva('conc');
    const rs = await Promise.all(Array.from({ length: 5 }, () => pedir(versionId, clave, cliente)));
    expect(cliente.llamadas).toBe(1);
    expect(await runsDe(versionId)).toBe(1);
    const buenos = rs.filter((r) => r.ok);
    expect(buenos.filter((r) => r.ok && r.value.outcome === 'created')).toHaveLength(1);
    for (const r of rs.filter((x) => !x.ok)) {
      expect(codigo(r)).toBe('RESOURCE_CONFLICT');
      expect(detalle(r, 'reason')).toBe('analysis_in_progress');
    }
    const ids = new Set(buenos.map((r) => (r.ok ? r.value.run.id : '')));
    expect(ids.size).toBe(1);
    const hallazgos = Number(
      (
        await query<{ n: string }>(
          `SELECT count(*) AS n FROM content_findings WHERE script_version_id = $1`,
          [versionId],
        )
      )[0]!.n,
    );
    expect(hallazgos).toBe(1);
  });

  it('5 solicitudes simultáneas con claves DISTINTAS ⇒ un solo análisis activo (y una sola llamada)', async () => {
    const versionId = await versionNueva();
    const cliente = clienteQueResponde([], demora(250));
    const rs = await Promise.all(
      Array.from({ length: 5 }, (_, i) => pedir(versionId, claveNueva(`dist${i}`), cliente, 'reanalyze')),
    );
    expect(cliente.llamadas).toBe(1);
    expect(await runsDe(versionId)).toBe(1);
    expect(rs.filter((r) => r.ok)).toHaveLength(1);
    for (const r of rs.filter((x) => !x.ok)) expect(detalle(r, 'reason')).toBe('analysis_in_progress');
  });

  it('5 ensure simultáneos con claves distintas ⇒ nunca más de un run ni de una llamada', async () => {
    const versionId = await versionNueva();
    const cliente = clienteQueResponde([], demora(100));
    await Promise.all(Array.from({ length: 5 }, (_, i) => pedir(versionId, claveNueva(`ens${i}`), cliente)));
    expect(cliente.llamadas).toBe(1);
    expect(await runsDe(versionId)).toBe(1);
  });

  it('versiones DISTINTAS del mismo entregable no se bloquean entre sí más de lo necesario', async () => {
    const v1 = await versionNueva();
    const v2 = await versionNueva();
    const cliente = clienteQueResponde([], demora(150));
    const [r1, r2] = await Promise.all([
      pedir(v1, claveNueva('p1'), cliente),
      pedir(v2, claveNueva('p2'), cliente),
    ]);
    expect(r1.ok && r2.ok).toBe(true);
    expect(cliente.llamadas).toBe(2);
  });
});

describe('tope por versión', () => {
  it(`el análisis nº ${LIMITE_DE_ANALISIS_POR_VERSION + 1} se rechaza con reanalysis_limit y no llama al modelo`, async () => {
    const versionId = await versionNueva();
    const cliente = clienteQueResponde([]);
    for (let i = 0; i < LIMITE_DE_ANALISIS_POR_VERSION; i += 1) {
      valor(await pedir(versionId, claveNueva(`tope${i}`), cliente, 'reanalyze'));
    }
    expect(cliente.llamadas).toBe(LIMITE_DE_ANALISIS_POR_VERSION);
    const r = await pedir(versionId, claveNueva('tope-extra'), cliente, 'reanalyze');
    expect(codigo(r)).toBe('RESOURCE_CONFLICT');
    expect(detalle(r, 'reason')).toBe('reanalysis_limit');
    expect(cliente.llamadas).toBe(LIMITE_DE_ANALISIS_POR_VERSION);
    expect(await runsDe(versionId)).toBe(LIMITE_DE_ANALISIS_POR_VERSION);
    // `ensure` con los mismos insumos sigue devolviendo el vigente (no gasta): el tope solo frena gasto nuevo.
    const vigente = valor(await pedir(versionId, claveNueva('tope-ensure'), cliente, 'ensure'));
    expect(vigente.outcome).toBe('reused_current');
  });
});
