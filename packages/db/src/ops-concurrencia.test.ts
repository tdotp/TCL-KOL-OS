/**
 * V2 · Fase 8 (W1b) — concurrencia REAL (Promise.all contra PostgreSQL): el mutex del sujeto (`FOR UPDATE`), el
 * control optimista por `row_seq` y la idempotencia por clave dejan UN solo ganador y una historia sin huecos.
 */

import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Result } from '@tcl-kol-os/domain';
import {
  cancelarObligacionDePago,
  registrarDocumentoDeCobro,
  reportarPago,
  validarDocumento,
} from './billing-payment.ts';
import { closePool } from './client.ts';
import {
  type EscenarioDeOperacion,
  archivoDePrueba,
  crearAcuerdoPorSql,
  crearEscenarioDeOperacion,
  dia,
  fila,
  limpiarEscenarioDeOperacion,
  nuevaParticipacion,
  unico,
} from './ops-test-support.ts';
import { crearEnvio, transicionarEnvio } from './shipments.ts';

let op: EscenarioDeOperacion;
let e: EscenarioDeOperacion['e'];

beforeAll(async () => {
  op = await crearEscenarioDeOperacion('F8 concurrencia');
  e = op.e;
});

afterAll(async () => {
  await limpiarEscenarioDeOperacion(op);
  await closePool();
});

const codigo = <T>(r: Result<T>): string => (r.ok ? 'OK' : r.error.code);
const razon = <T>(r: Result<T>): unknown =>
  r.ok ? undefined : (r.error.details as { reason?: unknown } | undefined)?.reason;
function exito<T>(r: Result<T>): T {
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message} ${JSON.stringify(r.error.details)}`);
  return r.value;
}

const RONDAS = 4;

async function envioPendiente() {
  const { ci } = await nuevaParticipacion(op, 'Concurrencia', [e.productos.p80]);
  const r = exito(
    await crearEnvio(e.operativo, {
      campaignInfluencerId: ci,
      items: [{ campaignProductId: e.productos.p80, quantity: 1 }],
      idempotencyKey: unico('c'),
    }),
  );
  return { ci, ...r.envio };
}

async function obligacionPendiente() {
  const { ci } = await nuevaParticipacion(op, 'Pago concurrente');
  const ac = await crearAcuerdoPorSql(op, { ci, mode: 'fee' });
  return { ci, ...ac };
}

async function historiaSinHuecos(columna: string, id: string): Promise<number[]> {
  const rows = await fila<{ seqs: number[] }>(
    `SELECT array_agg(subject_seq ORDER BY subject_seq) AS seqs FROM operational_events WHERE ${columna} = $1`,
    [id],
  );
  return rows.seqs;
}

describe('dos transiciones de envío simultáneas', () => {
  it('prepared vs cancelled con el mismo expectedSeq: gana UNA, la otra es stale_transition', async () => {
    for (let ronda = 0; ronda < RONDAS; ronda++) {
      const s = await envioPendiente();
      const [a, b] = await Promise.all([
        transicionarEnvio(e.operativo, {
          shipmentId: s.id,
          to: 'prepared',
          expectedSeq: s.rowSeq,
          idempotencyKey: unico('a'),
        }),
        transicionarEnvio(e.director, {
          shipmentId: s.id,
          to: 'cancelled',
          expectedSeq: s.rowSeq,
          idempotencyKey: unico('b'),
          cancelReason: 'carrera',
        }),
      ]);
      const resultados = [a, b];
      expect(
        resultados.filter((r) => r.ok),
        `ronda ${ronda}`,
      ).toHaveLength(1);
      const perdedora = resultados.find((r) => !r.ok)!;
      expect(codigo(perdedora)).toBe('RESOURCE_CONFLICT');
      expect(razon(perdedora)).toBe('stale_transition');
      const bd = await fila<{ status: string; row_seq: number }>(
        `SELECT status, row_seq FROM shipments WHERE id = $1`,
        [s.id],
      );
      expect(bd.row_seq).toBe(2);
      expect(['prepared', 'cancelled']).toContain(bd.status);
      expect(await historiaSinHuecos('shipment_id', s.id)).toEqual([1, 2]);
    }
  });

  it('la misma transición con DOS claves distintas: una gana, la otra es stale (no se aplica dos veces)', async () => {
    const s = await envioPendiente();
    const resultados = await Promise.all([
      transicionarEnvio(e.operativo, {
        shipmentId: s.id,
        to: 'prepared',
        expectedSeq: s.rowSeq,
        idempotencyKey: unico('x'),
      }),
      transicionarEnvio(e.operativo, {
        shipmentId: s.id,
        to: 'prepared',
        expectedSeq: s.rowSeq,
        idempotencyKey: unico('y'),
      }),
    ]);
    expect(resultados.filter((r) => r.ok)).toHaveLength(1);
    expect(await historiaSinHuecos('shipment_id', s.id)).toEqual([1, 2]);
  });
});

describe('dos reportes de pago simultáneos', () => {
  it('con claves distintas: UN solo pago reportado y UN evento payment.reported', async () => {
    for (let ronda = 0; ronda < RONDAS; ronda++) {
      const o = await obligacionPendiente();
      const intento = (ref: string, actor = e.operativo) =>
        reportarPago(actor, {
          paymentObligationId: o.obligationId,
          expectedSeq: 1,
          idempotencyKey: unico('pago'),
          paidOn: dia(1),
          externalReference: ref,
        });
      const resultados = await Promise.all([intento('REF-A'), intento('REF-B', e.admin)]);
      expect(
        resultados.filter((r) => r.ok),
        `ronda ${ronda}`,
      ).toHaveLength(1);
      const perdedora = resultados.find((r) => !r.ok)!;
      expect(codigo(perdedora)).toBe('RESOURCE_CONFLICT');
      expect(razon(perdedora)).toBe('stale_transition');
      const n = await fila<{ n: string }>(
        `SELECT count(*) AS n FROM operational_events WHERE payment_obligation_id = $1 AND event_type = 'payment.reported'`,
        [o.obligationId],
      );
      expect(Number(n.n)).toBe(1);
      const bd = await fila<{ status: string; external_reference: string }>(
        `SELECT status, external_reference FROM payment_obligations WHERE id = $1`,
        [o.obligationId],
      );
      expect(bd.status).toBe('reported_paid');
      expect(['REF-A', 'REF-B']).toContain(bd.external_reference);
      expect(await historiaSinHuecos('payment_obligation_id', o.obligationId)).toEqual([1, 2]);
    }
  });

  it('reportar el pago vs cancelar la obligación: gana UNA y el estado es coherente', async () => {
    const o = await obligacionPendiente();
    const [rep, can] = await Promise.all([
      reportarPago(e.operativo, {
        paymentObligationId: o.obligationId,
        expectedSeq: 1,
        idempotencyKey: unico('p'),
        paidOn: dia(1),
        externalReference: 'REF',
      }),
      cancelarObligacionDePago(e.director, {
        paymentObligationId: o.obligationId,
        expectedSeq: 1,
        idempotencyKey: unico('c'),
      }),
    ]);
    expect([rep, can].filter((r) => r.ok)).toHaveLength(1);
    const bd = await fila<{ status: string }>(`SELECT status FROM payment_obligations WHERE id = $1`, [
      o.obligationId,
    ]);
    expect(rep.ok ? 'reported_paid' : 'cancelled').toBe(bd.status);
  });
});

describe('doble submit con la misma idempotency_key', () => {
  it('transición: todas las respuestas son OK, UN solo evento, el resto son repetidas', async () => {
    const s = await envioPendiente();
    const clave = unico('doble');
    const entrada = {
      shipmentId: s.id,
      to: 'prepared' as const,
      expectedSeq: s.rowSeq,
      idempotencyKey: clave,
    };
    const resultados = await Promise.all([1, 2, 3, 4].map(() => transicionarEnvio(e.operativo, entrada)));
    expect(resultados.every((r) => r.ok)).toBe(true);
    const valores = resultados.map((r) => exito(r));
    expect(new Set(valores.map((v) => v.evento.id)).size).toBe(1);
    expect(valores.filter((v) => !v.repetido)).toHaveLength(1);
    expect(await historiaSinHuecos('shipment_id', s.id)).toEqual([1, 2]);
  });

  it('reporte de pago: un solo evento y un solo sello', async () => {
    const o = await obligacionPendiente();
    const entrada = {
      paymentObligationId: o.obligationId,
      expectedSeq: 1,
      idempotencyKey: unico('doble'),
      paidOn: dia(1),
      externalReference: 'REF-DOBLE',
    };
    const resultados = await Promise.all([1, 2, 3].map(() => reportarPago(e.operativo, entrada)));
    expect(resultados.every((r) => r.ok)).toBe(true);
    expect(new Set(resultados.map((r) => exito(r).evento.id)).size).toBe(1);
    expect(resultados.filter((r) => !exito(r).repetido)).toHaveLength(1);
    expect(await historiaSinHuecos('payment_obligation_id', o.obligationId)).toEqual([1, 2]);
  });

  it('CREAR el envío con la misma clave simultánea: un solo envío (la perdedora reintenta y repite)', async () => {
    const { ci } = await nuevaParticipacion(op, 'Doble creación', [e.productos.p80]);
    const entrada = {
      campaignInfluencerId: ci,
      items: [{ campaignProductId: e.productos.p80, quantity: 1 }],
      idempotencyKey: unico('doble-crear'),
    };
    const resultados = await Promise.all([1, 2, 3].map(() => crearEnvio(e.operativo, entrada)));
    expect(
      resultados.every((r) => r.ok),
      resultados.map((r) => (r.ok ? 'ok' : `${r.error.code} ${r.error.message}`)).join(' | '),
    ).toBe(true);
    const valores = resultados.map((r) => exito(r));
    expect(new Set(valores.map((v) => v.envio.id)).size).toBe(1);
    expect(valores.filter((v) => !v.repetido)).toHaveLength(1);
    const n = await fila<{ n: string }>(
      `SELECT count(*) AS n FROM shipments WHERE campaign_influencer_id = $1`,
      [ci],
    );
    expect(Number(n.n)).toBe(1);
  });

  it('REGISTRAR el documento de cobro con la misma clave simultánea: un solo documento', async () => {
    const o = await obligacionPendiente();
    const archivo = archivoDePrueba();
    const entrada = {
      paymentObligationId: o.obligationId,
      documentNumber: unico('CC'),
      issuedOn: dia(2),
      claimedAmount: 250000,
      claimedCurrency: 'COP',
      archivo,
      idempotencyKey: unico('doble-doc'),
    };
    const resultados = await Promise.all(
      [1, 2, 3].map(() => registrarDocumentoDeCobro(e.operativo, entrada)),
    );
    expect(
      resultados.every((r) => r.ok),
      resultados.map((r) => (r.ok ? 'ok' : `${r.error.code} ${r.error.message}`)).join(' | '),
    ).toBe(true);
    expect(new Set(resultados.map((r) => exito(r).documento.id)).size).toBe(1);
    const n = await fila<{ n: string }>(
      `SELECT count(*) AS n FROM billing_documents WHERE payment_obligation_id = $1`,
      [o.obligationId],
    );
    expect(Number(n.n)).toBe(1);
    const fuentes = await fila<{ n: string }>(
      `SELECT count(*) AS n FROM source_documents WHERE campaign_id = $1 AND hash = $2`,
      [e.campanaId, createHash('sha256').update(archivo.contenido).digest('hex')],
    );
    expect(Number(fuentes.n)).toBe(1);
  });
});

describe('documentos de cobro simultáneos', () => {
  it('validar DOS documentos a la vez: a lo sumo UNO queda validado', async () => {
    const o = await obligacionPendiente();
    const registrar = async () =>
      exito(
        await registrarDocumentoDeCobro(e.operativo, {
          paymentObligationId: o.obligationId,
          documentNumber: unico('CC'),
          issuedOn: dia(1),
          claimedAmount: 100,
          claimedCurrency: 'COP',
          archivo: archivoDePrueba(),
          idempotencyKey: unico('r'),
        }),
      ).documento;
    const [d1, d2] = [await registrar(), await registrar()];
    const resultados = await Promise.all(
      [d1, d2].map((d) =>
        validarDocumento(e.operativo, {
          billingDocumentId: d.id,
          expectedSeq: d.rowSeq,
          idempotencyKey: unico('v'),
        }),
      ),
    );
    expect(resultados.filter((r) => r.ok)).toHaveLength(1);
    const perdedora = resultados.find((r) => !r.ok)!;
    expect(codigo(perdedora)).toBe('RESOURCE_CONFLICT');
    const n = await fila<{ n: string }>(
      `SELECT count(*) AS n FROM billing_documents WHERE payment_obligation_id = $1 AND status = 'validated'`,
      [o.obligationId],
    );
    expect(Number(n.n)).toBe(1);
  });
});
