/**
 * Regresión QA-26: `ejecutarAccion` de los tipos `idempotent_external` retiene la conexión de la transacción
 * que bloquea la fila de la acción y el caso de uso de la Fase 5 pide OTRAS conexiones del MISMO pool
 * (`applyInfluencerImport`: bloqueo del plan + transacción por registro). Con 10 ejecuciones simultáneas y el
 * pool en `max: 10` todas retenían una conexión esperando otra: interbloqueo del pool.
 *
 * Aquí se reproduce SIN el worker ni Google: las acciones se siembran ya confirmadas y el `ejecutar` del handler
 * se sustituye por un doble que pide las mismas conexiones adicionales que el real. Cubre:
 *  · el cupo de ejecuciones externas (límite, FIFO, liberación aunque falle);
 *  · N > pool de ejecuciones simultáneas terminan todas (antes: se colgaban);
 *  · un pool agotado falla limpio (`connectionTimeoutMillis`) en vez de colgarse;
 *  · el resto del servicio sigue respondiendo mientras hay ejecuciones en curso;
 *  · la garantía de ejecución única se conserva.
 */

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { type User, err, ok } from '@tcl-kol-os/domain';
import { closePool, getPool, query, transaction } from './client.ts';
import { eliminarCampanaDePrueba } from './test-utils.ts';
import { findUserByEmail } from './users.ts';
import { ejecutarAccion, huellaDeAccion } from './proposed-actions.ts';
import {
  HANDLERS,
  MAX_EJECUCIONES_EXTERNAS_SIMULTANEAS,
  conCupoDeEjecucionExterna,
} from './proposed-action-handlers.ts';

let director: User;
let campaignId: string;
const accionesDe = (n: number) => Array.from({ length: n }, () => randomUUID());

const espera = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

beforeAll(async () => {
  director = (await findUserByEmail('director@smartpr.co'))!;
  const [c] = await query<{ id: string }>(
    `INSERT INTO campaigns (organization_id, name, owner_id, created_by)
     VALUES ($1, $2, $3, $3) RETURNING id`,
    [director.organizationId, `Pool QA-26 · ${Date.now()}`, director.id],
  );
  campaignId = c!.id;
});

afterAll(async () => {
  await eliminarCampanaDePrueba([campaignId]);
  await closePool();
});

/** Siembra una acción de importación ya CONFIRMADA por el director (sin pasar por el worker). */
async function sembrarConfirmada(): Promise<string> {
  const recurso = randomUUID();
  const huella = huellaDeAccion('influencer_import.apply', 'influencer_import_plan', recurso, {});
  const [fila] = await query<{ id: string }>(
    `INSERT INTO proposed_actions
       (organization_id, campaign_id, action_type, resource_type, resource_id, payload, payload_hash,
        status, proposed_by, proposed_origin, confirmed_by, confirmed_at, expires_at)
     VALUES ($1, $2, 'influencer_import.apply', 'influencer_import_plan', $3, '{}'::jsonb, $4,
             'confirmed', $5, 'chat', $5, now(), now() + interval '1 hour')
     RETURNING id`,
    [director.organizationId, campaignId, recurso, huella, director.id],
  );
  return fila!.id;
}

describe('cupo de ejecuciones externas', () => {
  it('nunca hay más de MAX simultáneas, atiende en orden y devuelve los resultados', async () => {
    let activas = 0;
    let maxima = 0;
    const orden: number[] = [];
    const resultados = await Promise.all(
      accionesDe(8).map((_, i) =>
        conCupoDeEjecucionExterna(async () => {
          orden.push(i);
          activas += 1;
          maxima = Math.max(maxima, activas);
          await espera(15);
          activas -= 1;
          return i * 2;
        }),
      ),
    );
    expect(resultados).toEqual([0, 2, 4, 6, 8, 10, 12, 14]);
    expect(maxima).toBe(MAX_EJECUCIONES_EXTERNAS_SIMULTANEAS);
    expect(orden).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  it('el cupo se libera aunque la ejecución falle o lance', async () => {
    const fallos = await Promise.allSettled(
      accionesDe(MAX_EJECUCIONES_EXTERNAS_SIMULTANEAS * 3).map(() =>
        conCupoDeEjecucionExterna(async () => {
          throw new Error('falla');
        }),
      ),
    );
    expect(fallos.every((f) => f.status === 'rejected')).toBe(true);
    // Si el cupo se hubiera perdido, esto se colgaría.
    await expect(conCupoDeEjecucionExterna(async () => 'libre')).resolves.toBe('libre');
  });
});

describe('ejecutarAccion con handlers idempotent_external (QA-26)', () => {
  it('el pool está configurado para fallar limpio, no para colgarse', () => {
    expect(getPool().options.max).toBe(10);
    expect(getPool().options.connectionTimeoutMillis).toBeGreaterThan(0);
  });

  it('12 ejecuciones simultáneas (más que el pool) terminan todas, una sola vez cada una, sin interbloqueo', async () => {
    const ids = await Promise.all(Array.from({ length: 12 }, sembrarConfirmada));
    let activas = 0;
    let maxima = 0;
    const ejecuciones = new Map<string, number>();
    const original = HANDLERS['influencer_import.apply'];
    const dobleEjecutar = vi
      .spyOn(original, 'ejecutar')
      .mockImplementation(async (_client, _humano, accion) => {
        activas += 1;
        maxima = Math.max(maxima, activas);
        ejecuciones.set(accion.id, (ejecuciones.get(accion.id) ?? 0) + 1);
        // Mismo patrón que `applyInfluencerImport`: una transacción propia (bloqueo del plan) que, mientras
        // la retiene, pide otra transacción (por registro) y una lectura suelta del pool.
        await transaction(async (bloqueo) => {
          await bloqueo.query(`SELECT 1`);
          await getPool().query(`SELECT pg_sleep(0.05)`);
          await transaction(async (registro) => {
            await registro.query(`SELECT pg_sleep(0.05)`);
            await getPool().query(`SELECT 1`);
          });
        });
        activas -= 1;
        return ok({ simulado: true });
      });
    const dobleVigente = vi.spyOn(original, 'verificarVigente').mockResolvedValue(ok(true));
    try {
      const todas = Promise.all(ids.map((id) => ejecutarAccion(director, id, { canal: 'ui' })));
      // Mientras tanto el resto del servicio sigue pudiendo usar el pool.
      const [otra] = await Promise.all([query<{ ok: number }>(`SELECT 1 AS ok`), espera(10)]);
      expect(otra[0]!.ok).toBe(1);
      const res = await Promise.race([
        todas,
        new Promise<'colgado'>((resolve) => setTimeout(() => resolve('colgado'), 25_000)),
      ]);
      expect(res).not.toBe('colgado');
      if (res === 'colgado') return;
      expect(res.map((r) => (r.ok ? r.value.status : r.error.code))).toEqual(Array(12).fill('executed'));
      expect(maxima).toBeLessThanOrEqual(MAX_EJECUCIONES_EXTERNAS_SIMULTANEAS);
      // Ejecución única: cada acción corrió su handler exactamente una vez.
      expect([...ejecuciones.values()]).toEqual(Array(12).fill(1));
      const estados = await query<{ status: string }>(
        `SELECT status FROM proposed_actions WHERE id = ANY($1::uuid[])`,
        [ids],
      );
      expect(estados.every((e) => e.status === 'executed')).toBe(true);
    } finally {
      dobleEjecutar.mockRestore();
      dobleVigente.mockRestore();
    }
  }, 60_000);

  it('dos ejecuciones simultáneas de LA MISMA acción: una ejecuta y la otra ve el estado terminal', async () => {
    const id = await sembrarConfirmada();
    const original = HANDLERS['influencer_import.apply'];
    let corridas = 0;
    const doble = vi.spyOn(original, 'ejecutar').mockImplementation(async () => {
      corridas += 1;
      await espera(40);
      return ok(undefined);
    });
    const vigente = vi.spyOn(original, 'verificarVigente').mockResolvedValue(ok(true));
    try {
      const [a, b] = await Promise.all([
        ejecutarAccion(director, id, { canal: 'ui' }),
        ejecutarAccion(director, id, { canal: 'ui' }),
      ]);
      expect(corridas).toBe(1);
      expect([a.ok, b.ok].sort()).toEqual([false, true]);
      const rechazada = a.ok ? b : a;
      expect(rechazada.ok ? undefined : rechazada.error.code).toBe('PROPOSAL_INVALID_STATE');
    } finally {
      doble.mockRestore();
      vigente.mockRestore();
    }
  });

  it('un fallo del handler no consume el cupo: la acción sigue confirmada y la siguiente ejecuta', async () => {
    const original = HANDLERS['influencer_import.apply'];
    const vigente = vi.spyOn(original, 'verificarVigente').mockResolvedValue(ok(true));
    const doble = vi
      .spyOn(original, 'ejecutar')
      .mockResolvedValueOnce(err({ code: 'VALIDATION_FAILED', message: 'rechazado por el caso de uso' }))
      .mockResolvedValue(ok(undefined));
    try {
      const ids = await Promise.all(
        Array.from({ length: MAX_EJECUCIONES_EXTERNAS_SIMULTANEAS + 2 }, sembrarConfirmada),
      );
      const res = await Promise.all(ids.map((id) => ejecutarAccion(director, id, { canal: 'ui' })));
      expect(res.filter((r) => !r.ok)).toHaveLength(1);
      expect(res.filter((r) => r.ok)).toHaveLength(ids.length - 1);
    } finally {
      doble.mockRestore();
      vigente.mockRestore();
    }
  });
});
