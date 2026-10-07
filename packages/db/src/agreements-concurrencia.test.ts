/**
 * V2 · Fase 8 (W1d) — concurrencia de acuerdos: dos cambios materiales simultáneos con la misma
 * `expectedVersion` ⇒ exactamente uno gana; el alta del acuerdo se serializa por participación; el cambio de
 * modo y el reporte de pago no pueden ganar los dos (barter ⇒ jamás un pago reportado).
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Result } from '@tcl-kol-os/domain';
import {
  cancelarAcuerdo,
  crearAcuerdo,
  listarVersionesDeAcuerdo,
  obtenerAcuerdo,
  registrarVersionDeAcuerdo,
} from './agreements.ts';
import { reportarPago } from './billing-payment.ts';
import { asociarInfluencerACampana, asociarProductoAInfluencer } from './campaign-influencers.ts';
import { closePool, query } from './client.ts';
import { crearInfluencer } from './influencers.ts';
import { dia, fila } from './ops-test-support.ts';
import {
  type EscenarioDeOperacion,
  claveDePrueba as clave,
  crearEscenarioDeOperacion,
  limpiarEscenarioDeOperacion,
} from './test-utils.ts';

let op: EscenarioDeOperacion;
let n = 0;

beforeAll(async () => {
  op = await crearEscenarioDeOperacion('F8 acuerdos concurrencia', { conAcuerdoAjeno: false });
});

afterAll(async () => {
  await limpiarEscenarioDeOperacion(op);
  await closePool();
});

function exito<T>(r: Result<T>): T {
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message} ${JSON.stringify(r.error.details)}`);
  return r.value;
}
const razon = <T>(r: Result<T>): unknown =>
  r.ok ? undefined : (r.error.details as { reason?: unknown } | undefined)?.reason;

async function participacion(conProducto: boolean): Promise<string> {
  const creado = exito(
    await crearInfluencer(op.admin, {
      displayName: `Concurrencia ${++n}`,
      cuentas: [{ platform: 'instagram', handle: `conc.${n}.${op.sufijo}.${Date.now().toString(36)}` }],
    }),
  );
  op.influencerIds.push(creado.influencer.id);
  const ci = exito(
    await asociarInfluencerACampana(op.admin, {
      campaignId: op.campanaId,
      influencerId: creado.influencer.id,
    }),
  ).id;
  if (conProducto) {
    exito(
      await asociarProductoAInfluencer(op.admin, {
        campaignInfluencerId: ci,
        campaignProductId: op.productos.p80,
      }),
    );
  }
  return ci;
}

async function acuerdoDe(mode: 'fee' | 'barter' | 'mixed') {
  const ci = await participacion(mode !== 'fee');
  const r = exito(
    await crearAcuerdo(op.operativo, {
      campaignInfluencerId: ci,
      compensationType: mode,
      ...(mode === 'barter' ? {} : { feeAmount: 1000, feeCurrency: 'COP' }),
      commitments: mode === 'fee' ? [] : [{ campaignProductId: op.productos.p80, quantity: 1 }],
      idempotencyKey: clave('c'),
    }),
  );
  return { ci, acuerdo: r.acuerdo, obligationId: r.acuerdo.paymentObligation!.id };
}

const p80 = (cantidad: number) => [{ campaignProductId: op.productos.p80, quantity: cantidad }];

describe('versiones concurrentes', () => {
  it('dos cambios de monto con la misma expectedVersion: exactamente uno gana', async () => {
    for (let ronda = 0; ronda < 3; ronda++) {
      const { acuerdo } = await acuerdoDe('fee');
      const intento = (monto: number) =>
        registrarVersionDeAcuerdo(op.operativo, acuerdo.id, {
          compensationType: 'fee',
          feeAmount: monto,
          feeCurrency: 'COP',
          commitments: [],
          changeReason: `Cambio a ${monto}`,
          expectedVersion: 1,
          idempotencyKey: clave('v'),
        });
      const resultados = await Promise.all([intento(2000), intento(3000), intento(4000)]);
      expect(resultados.filter((r) => r.ok)).toHaveLength(1);
      for (const r of resultados.filter((x) => !x.ok)) expect(razon(r)).toBe('stale_version');

      const versiones = exito(await listarVersionesDeAcuerdo(op.operativo, acuerdo.id));
      expect(versiones.map((v) => v.version)).toEqual([1, 2]);
      const ganadora = resultados.find((r) => r.ok)!;
      expect(versiones[1]!.feeAmount).toBe(exito(ganadora).acuerdo.terms.feeAmount);
      const [cabecera] = await query<{ current_version: number }>(
        `SELECT current_version FROM agreements WHERE id = $1`,
        [acuerdo.id],
      );
      expect(cabecera!.current_version).toBe(2);
    }
  });

  it('dos cambios de modo barter → mixed a la vez: una versión y UN solo ajuste de la obligación', async () => {
    const { acuerdo, obligationId } = await acuerdoDe('barter');
    const intento = (monto: number) =>
      registrarVersionDeAcuerdo(op.operativo, acuerdo.id, {
        compensationType: 'mixed',
        feeAmount: monto,
        feeCurrency: 'COP',
        commitments: p80(2),
        changeReason: 'Ahora con tarifa',
        expectedVersion: 1,
        idempotencyKey: clave('m'),
      });
    const resultados = await Promise.all([intento(500), intento(600)]);
    expect(resultados.filter((r) => r.ok)).toHaveLength(1);
    expect(razon(resultados.find((r) => !r.ok)!)).toBe('stale_version');
    const o = await fila<{ status: string; row_seq: number }>(
      `SELECT status, row_seq FROM payment_obligations WHERE id = $1`,
      [obligationId],
    );
    expect(o).toMatchObject({ status: 'pending', row_seq: 2 });
  });

  it('cambio fee → barter y reporte de pago a la vez: solo uno prospera y nunca queda barter con pago reportado', async () => {
    for (let ronda = 0; ronda < 4; ronda++) {
      const { ci, acuerdo, obligationId } = await acuerdoDe('fee');
      exito(
        await asociarProductoAInfluencer(op.admin, {
          campaignInfluencerId: ci,
          campaignProductId: op.productos.p80,
        }),
      );
      const aBarter = registrarVersionDeAcuerdo(op.operativo, acuerdo.id, {
        compensationType: 'barter',
        commitments: p80(1),
        changeReason: 'Pasa a canje',
        expectedVersion: 1,
        idempotencyKey: clave('b'),
      });
      const pago = reportarPago(op.operativo, {
        paymentObligationId: obligationId,
        expectedSeq: 1,
        idempotencyKey: clave('p'),
        paidOn: dia(1),
        externalReference: `REF-${ronda}`,
      });
      const [rv, rp] = await Promise.all([aBarter, pago]);
      expect([rv.ok, rp.ok].filter(Boolean)).toHaveLength(1);
      const vista = exito(await obtenerAcuerdo(op.operativo, ci))!;
      if (rv.ok) {
        expect(vista.terms.compensationType).toBe('barter');
        expect(vista.paymentObligation?.status).toBe('not_applicable');
      } else {
        expect(razon(rv)).toBe('payment_reported');
        expect(vista.terms.compensationType).toBe('fee');
        expect(vista.paymentObligation?.status).toBe('reported_paid');
      }
    }
  });

  it('cancelar y versionar a la vez: o se cancela (y la versión falla) o se versiona primero; nunca una versión sobre un acuerdo cancelado', async () => {
    const { acuerdo } = await acuerdoDe('fee');
    const [rc, rv] = await Promise.all([
      cancelarAcuerdo(op.operativo, acuerdo.id, { reason: 'Se cancela', idempotencyKey: clave('x') }),
      registrarVersionDeAcuerdo(op.operativo, acuerdo.id, {
        compensationType: 'fee',
        feeAmount: 7000,
        feeCurrency: 'COP',
        commitments: [],
        changeReason: 'Sube',
        expectedVersion: 1,
        idempotencyKey: clave('y'),
      }),
    ]);
    expect(rc.ok).toBe(true);
    const [fila1] = await query<{ status: string; current_version: number }>(
      `SELECT status, current_version FROM agreements WHERE id = $1`,
      [acuerdo.id],
    );
    expect(fila1!.status).toBe('cancelled');
    expect(fila1!.current_version).toBe(rv.ok ? 2 : 1);
    if (!rv.ok) expect(razon(rv)).toBe('agreement_cancelled');
  });
});

describe('alta concurrente', () => {
  it('misma participación y la MISMA clave: un acuerdo y el segundo es el reintento idéntico', async () => {
    const ci = await participacion(false);
    const entrada = {
      campaignInfluencerId: ci,
      compensationType: 'fee' as const,
      feeAmount: 1234,
      feeCurrency: 'COP',
      commitments: [],
      idempotencyKey: clave('mismo'),
    };
    const rs = await Promise.all([crearAcuerdo(op.operativo, entrada), crearAcuerdo(op.director, entrada)]);
    // Mismo contenido pero personas distintas: el reintento lo reconoce por clave y huella (no por persona).
    expect(rs.filter((r) => r.ok).length).toBeGreaterThanOrEqual(1);
    const [cuenta] = await query<{ n: number }>(
      `SELECT count(*)::int AS n FROM agreements WHERE campaign_influencer_id = $1`,
      [ci],
    );
    expect(cuenta!.n).toBe(1);
    const ok = rs.filter((r) => r.ok).map((r) => exito(r));
    expect(new Set(ok.map((r) => r.acuerdo.id)).size).toBe(1);
    expect(ok.filter((r) => !r.repetido)).toHaveLength(1);
  });

  it('misma participación y claves DISTINTAS: gana uno y el otro recibe agreement_exists', async () => {
    const ci = await participacion(false);
    const intento = (actor: typeof op.operativo) =>
      crearAcuerdo(actor, {
        campaignInfluencerId: ci,
        compensationType: 'fee',
        feeAmount: 900,
        feeCurrency: 'COP',
        commitments: [],
        idempotencyKey: clave('d'),
      });
    const rs = await Promise.all([intento(op.operativo), intento(op.director), intento(op.admin)]);
    expect(rs.filter((r) => r.ok)).toHaveLength(1);
    for (const r of rs.filter((x) => !x.ok)) expect(razon(r)).toBe('agreement_exists');
    const [cuenta] = await query<{ n: number }>(
      `SELECT (SELECT count(*) FROM agreements WHERE campaign_influencer_id = $1)::int AS n`,
      [ci],
    );
    expect(cuenta!.n).toBe(1);
  });
});
