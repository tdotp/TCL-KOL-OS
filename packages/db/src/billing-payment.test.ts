/**
 * V2 · Fase 8 (W1b) — cobro y seguimiento de pago: registrar ≠ validar ≠ pagar, el pago solo lo reporta una
 * persona (nunca la IA, el chat ni el sistema), canje puro sin pago, sellos, dinero solo con finance:read y
 * auditoría sin montos, números de documento, referencias, notas ni nombres de archivo.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Result } from '@tcl-kol-os/domain';
import {
  anularDocumento,
  cancelarObligacionDePago,
  listarDocumentosDeCobro,
  obtenerSeguimientoDePago,
  rechazarDocumento,
  registrarDocumentoDeCobro,
  registrarNotaDeCorreccionDePago,
  reportarPago,
  validarDocumento,
} from './billing-payment.ts';
import { closePool } from './client.ts';
import {
  type EscenarioDeOperacion,
  archivoDePrueba,
  auditoriaDeSujeto,
  crearAcuerdoPorSql,
  crearEscenarioDeOperacion,
  dia,
  fila,
  limpiarEscenarioDeOperacion,
  nuevaParticipacion,
  unico,
} from './ops-test-support.ts';
import { listarEvidenciaDeSujeto } from './ops-evidence.ts';
import { listarEventosOperativos } from './operational-events.ts';

let op: EscenarioDeOperacion;
let e: EscenarioDeOperacion['e'];

beforeAll(async () => {
  op = await crearEscenarioDeOperacion('F8 cobro');
  e = op.e;
});

afterAll(async () => {
  await limpiarEscenarioDeOperacion(op);
  await closePool();
});

const REF = 'SENTINELA-REF-pago-3344';
const NOTA = 'SENTINELA-NOTA-cobro-8812';
const NUMERO = 'SENTINELA-DOC-0042';
const MONTO = 987654.32;

function exito<T>(r: Result<T>): T {
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message} ${JSON.stringify(r.error.details)}`);
  return r.value;
}
function codigo<T>(r: Result<T>): string {
  return r.ok ? 'OK' : r.error.code;
}
function razon<T>(r: Result<T>): unknown {
  return r.ok ? undefined : (r.error.details as { reason?: unknown } | undefined)?.reason;
}

/** Participación con acuerdo de tarifa y su obligación `pending`. */
async function conTarifa(mode: 'fee' | 'mixed' = 'fee') {
  const { ci } = await nuevaParticipacion(op, 'Cobro', mode === 'mixed' ? [e.productos.p80] : []);
  const ac = await crearAcuerdoPorSql(op, {
    ci,
    mode,
    productos: mode === 'mixed' ? [[e.productos.p80, 1]] : [],
  });
  return { ci, ...ac };
}

async function registrar(
  obligationId: string,
  extra: Partial<Parameters<typeof registrarDocumentoDeCobro>[1]> = {},
) {
  return exito(
    await registrarDocumentoDeCobro(e.operativo, {
      paymentObligationId: obligationId,
      documentNumber: unico('CC'),
      issuedOn: dia(3),
      claimedAmount: 1_000_000,
      claimedCurrency: 'COP',
      archivo: archivoDePrueba(),
      idempotencyKey: unico('reg'),
      ...extra,
    }),
  );
}

async function rowSeqObligacion(id: string): Promise<number> {
  return (await fila<{ row_seq: number }>(`SELECT row_seq FROM payment_obligations WHERE id = $1`, [id]))
    .row_seq;
}

describe('registrarDocumentoDeCobro', () => {
  it('registra el documento con su archivo como evidencia soporte_operativo y el evento billing.registered', async () => {
    const { obligationId } = await conTarifa();
    const archivo = archivoDePrueba();
    const r = await registrar(obligationId, {
      documentNumber: NUMERO,
      claimedAmount: MONTO,
      archivo,
      note: NOTA,
    });
    expect(r.repetido).toBe(false);
    expect(r.documento).toMatchObject({
      status: 'registered',
      rowSeq: 1,
      documentNumber: NUMERO,
      claimedAmount: '987654.32',
      claimedCurrency: 'COP',
      validatedBy: null,
      sourceFilename: archivo.filename,
    });
    expect(r.evento).toMatchObject({
      eventType: 'billing.registered',
      toStatus: 'registered',
      evidenceCount: 1,
    });

    // la fuente: sensible, interna, procesada, tipo soporte_operativo, SIN jobs ni fragmentos
    const fuente = await fila<Record<string, unknown>>(
      `SELECT type::text AS type, confidentiality_level::text AS conf, visibility::text AS vis, status::text AS status,
              origin::text AS origin,
              (SELECT count(*) FROM processing_jobs WHERE source_id = s.id)::int AS jobs,
              (SELECT count(*) FROM source_fragments WHERE source_id = s.id)::int AS fragmentos
         FROM source_documents s WHERE id = $1`,
      [r.documento.sourceDocumentId],
    );
    expect(fuente).toEqual({
      type: 'soporte_operativo',
      conf: 'sensible',
      vis: 'interna',
      status: 'procesado',
      origin: 'file',
      jobs: 0,
      fragmentos: 0,
    });
    const ev = exito(
      await listarEvidenciaDeSujeto(e.operativo, {
        subjectType: 'billing_document',
        subjectId: r.documento.id,
      }),
    );
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ kind: 'cuenta_cobro', filename: archivo.filename, retractedAt: null });
  });

  it('exige archivo, datos válidos y una obligación que admita documentos; el canje puro no tiene pago', async () => {
    const { obligationId } = await conTarifa();
    const base = {
      paymentObligationId: obligationId,
      documentNumber: unico('CC'),
      issuedOn: dia(1),
      claimedAmount: 100,
      claimedCurrency: 'COP',
      archivo: archivoDePrueba(),
      idempotencyKey: unico('v'),
    };
    expect(
      codigo(await registrarDocumentoDeCobro(e.operativo, { ...base, archivo: undefined as never })),
    ).toBe('VALIDATION_FAILED');
    expect(
      codigo(
        await registrarDocumentoDeCobro(e.operativo, {
          ...base,
          idempotencyKey: unico('v'),
          archivo: { filename: 'vacio.pdf', contenido: new Uint8Array() },
        }),
      ),
    ).not.toBe('OK');
    expect(
      codigo(
        await registrarDocumentoDeCobro(e.operativo, {
          ...base,
          idempotencyKey: unico('v'),
          claimedAmount: -5,
        }),
      ),
    ).toBe('VALIDATION_FAILED');
    expect(
      codigo(
        await registrarDocumentoDeCobro(e.operativo, {
          ...base,
          idempotencyKey: unico('v'),
          claimedCurrency: 'cop',
        }),
      ),
    ).toBe('VALIDATION_FAILED');
    // canje puro: obligación not_applicable
    const { ci } = await nuevaParticipacion(op, 'Canje puro', [e.productos.p80]);
    const barter = await crearAcuerdoPorSql(op, { ci, mode: 'barter', productos: [[e.productos.p80, 1]] });
    const r = await registrarDocumentoDeCobro(e.operativo, {
      ...base,
      paymentObligationId: barter.obligationId,
      idempotencyKey: unico('v'),
    });
    expect(codigo(r)).toBe('RESOURCE_CONFLICT');
    expect(razon(r)).toBe('payment_not_applicable');
  });

  it('idempotente por clave; mismo número o mismo archivo vivos ⇒ conflicto', async () => {
    const { obligationId } = await conTarifa();
    const archivo = archivoDePrueba();
    const entrada = {
      paymentObligationId: obligationId,
      documentNumber: unico('CC'),
      issuedOn: dia(2),
      claimedAmount: 500,
      claimedCurrency: 'COP',
      archivo,
      idempotencyKey: unico('idem'),
    };
    const a = exito(await registrarDocumentoDeCobro(e.operativo, entrada));
    const b = exito(await registrarDocumentoDeCobro(e.operativo, entrada));
    expect(b.repetido).toBe(true);
    expect(b.documento.id).toBe(a.documento.id);
    expect(razon(await registrarDocumentoDeCobro(e.operativo, { ...entrada, claimedAmount: 501 }))).toBe(
      'idempotency_key_reused',
    );
    // mismo número, otra clave y otro archivo ⇒ conflicto
    expect(
      razon(
        await registrarDocumentoDeCobro(e.operativo, {
          ...entrada,
          idempotencyKey: unico('n'),
          archivo: archivoDePrueba(),
        }),
      ),
    ).toBe('document_number_in_use');
    // mismo archivo, otro número ⇒ conflicto (la fuente se reutiliza, pero ya respalda un documento vivo)
    expect(
      razon(
        await registrarDocumentoDeCobro(e.operativo, {
          ...entrada,
          documentNumber: unico('CC'),
          idempotencyKey: unico('f'),
        }),
      ),
    ).toBe('document_source_in_use');
    const n = await fila<{ n: string }>(
      `SELECT count(*) AS n FROM billing_documents WHERE payment_obligation_id = $1`,
      [obligationId],
    );
    expect(Number(n.n)).toBe(1);
    // al anularlo, el número y el archivo quedan libres
    const anulado = exito(
      await anularDocumento(e.operativo, {
        billingDocumentId: a.documento.id,
        expectedSeq: a.documento.rowSeq,
        idempotencyKey: unico('an'),
      }),
    );
    expect(anulado.documento.status).toBe('voided');
    const otro = await registrarDocumentoDeCobro(e.operativo, { ...entrada, idempotencyKey: unico('r2') });
    expect(codigo(otro)).toBe('OK');
  });

  it('permisos: solo billing:manage; consultor ⇒ FORBIDDEN; ajeno y cliente ⇒ NOT_FOUND; chat/sistema rechazados', async () => {
    const { obligationId } = await conTarifa();
    const base = {
      paymentObligationId: obligationId,
      documentNumber: unico('CC'),
      issuedOn: dia(1),
      claimedAmount: 100,
      claimedCurrency: 'COP',
      archivo: archivoDePrueba(),
    };
    expect(
      codigo(await registrarDocumentoDeCobro(e.consultor, { ...base, idempotencyKey: unico('p') })),
    ).toBe('FORBIDDEN_ROLE');
    for (const actor of [e.ajeno, e.cliente]) {
      expect(
        codigo(await registrarDocumentoDeCobro(actor, { ...base, idempotencyKey: unico('p') })),
        actor.role,
      ).toBe('RESOURCE_NOT_FOUND');
    }
    expect(
      codigo(
        await registrarDocumentoDeCobro(
          e.operativo,
          { ...base, idempotencyKey: unico('p') },
          { origin: 'chat' },
        ),
      ),
    ).toBe('HUMAN_CONFIRMATION_REQUIRED');
    expect(
      codigo(
        await registrarDocumentoDeCobro(
          e.operativo,
          { ...base, idempotencyKey: unico('p') },
          { origin: 'system' },
        ),
      ),
    ).toBe('FORBIDDEN_ROLE');
    // director puede registrar (billing:manage + finance:read)
    expect(codigo(await registrarDocumentoDeCobro(e.director, { ...base, idempotencyKey: unico('p') }))).toBe(
      'OK',
    );
  });
});

describe('validar · rechazar · anular', () => {
  it('registered → validated sella quién y cuándo; a lo sumo UN validado por obligación', async () => {
    const { obligationId } = await conTarifa();
    const a = await registrar(obligationId);
    const b = await registrar(obligationId);
    const v = exito(
      await validarDocumento(e.director, {
        billingDocumentId: a.documento.id,
        expectedSeq: a.documento.rowSeq,
        idempotencyKey: unico('val'),
      }),
    );
    expect(v.documento).toMatchObject({ status: 'validated', rowSeq: 2, validatedBy: e.director.id });
    expect(v.documento.validatedAt).not.toBeNull();
    const segundo = await validarDocumento(e.operativo, {
      billingDocumentId: b.documento.id,
      expectedSeq: b.documento.rowSeq,
      idempotencyKey: unico('val'),
    });
    expect(codigo(segundo)).toBe('RESOURCE_CONFLICT');
    expect(razon(segundo)).toBe('document_already_validated');
    // anular el validado libera la validación
    exito(
      await anularDocumento(e.operativo, {
        billingDocumentId: a.documento.id,
        expectedSeq: v.documento.rowSeq,
        idempotencyKey: unico('an'),
      }),
    );
    const ahora = exito(
      await validarDocumento(e.operativo, {
        billingDocumentId: b.documento.id,
        expectedSeq: b.documento.rowSeq,
        idempotencyKey: unico('val'),
      }),
    );
    expect(ahora.documento.status).toBe('validated');
  });

  it('rejected y voided son terminales; validar exige estado registered; el consultor no puede', async () => {
    const { obligationId } = await conTarifa();
    const d = await registrar(obligationId);
    const rej = exito(
      await rechazarDocumento(e.operativo, {
        billingDocumentId: d.documento.id,
        expectedSeq: d.documento.rowSeq,
        idempotencyKey: unico('rej'),
        note: 'monto no coincide',
      }),
    );
    expect(rej.documento.status).toBe('rejected');
    const tras = await validarDocumento(e.operativo, {
      billingDocumentId: d.documento.id,
      expectedSeq: rej.documento.rowSeq,
      idempotencyKey: unico('v'),
    });
    expect(codigo(tras)).toBe('RESOURCE_CONFLICT');
    const nuevo = await registrar(obligationId);
    expect(
      codigo(
        await validarDocumento(e.consultor, {
          billingDocumentId: nuevo.documento.id,
          expectedSeq: nuevo.documento.rowSeq,
          idempotencyKey: unico('v'),
        }),
      ),
    ).toBe('FORBIDDEN_ROLE');
    expect(
      codigo(
        await validarDocumento(e.ajeno, {
          billingDocumentId: nuevo.documento.id,
          expectedSeq: nuevo.documento.rowSeq,
          idempotencyKey: unico('v'),
        }),
      ),
    ).toBe('RESOURCE_NOT_FOUND');
    expect(
      codigo(
        await validarDocumento(
          e.operativo,
          {
            billingDocumentId: nuevo.documento.id,
            expectedSeq: nuevo.documento.rowSeq,
            idempotencyKey: unico('v'),
          },
          { origin: 'chat' },
        ),
      ),
    ).toBe('HUMAN_CONFIRMATION_REQUIRED');
    const viejo = await validarDocumento(e.operativo, {
      billingDocumentId: nuevo.documento.id,
      expectedSeq: nuevo.documento.rowSeq + 5,
      idempotencyKey: unico('v'),
    });
    expect(razon(viejo)).toBe('stale_transition');
  });
});

describe('reportarPago', () => {
  it('SIN documento validado se permite: sella reportedBy, fecha y referencia y marca billingValidatedAtReport = false', async () => {
    const { obligationId } = await conTarifa();
    const seq = await rowSeqObligacion(obligationId);
    const r = exito(
      await reportarPago(e.operativo, {
        paymentObligationId: obligationId,
        expectedSeq: seq,
        idempotencyKey: unico('pago'),
        paidOn: dia(1),
        externalReference: REF,
        note: NOTA,
      }),
    );
    expect(r.obligacion).toMatchObject({
      status: 'reported_paid',
      reportedBy: e.operativo.id,
      paidOn: dia(1),
      externalReference: REF,
      billingValidatedAtReport: false,
      rowSeq: seq + 1,
    });
    expect(r.obligacion.reportedAt).not.toBeNull();
    expect(r.evento).toMatchObject({
      eventType: 'payment.reported',
      fromStatus: 'pending',
      toStatus: 'reported_paid',
    });
  });

  it('CON documento validado marca billingValidatedAtReport = true; el evento lleva el comprobante', async () => {
    const { obligationId } = await conTarifa('mixed');
    const d = await registrar(obligationId);
    exito(
      await validarDocumento(e.operativo, {
        billingDocumentId: d.documento.id,
        expectedSeq: d.documento.rowSeq,
        idempotencyKey: unico('val'),
      }),
    );
    const r = exito(
      await reportarPago(e.admin, {
        paymentObligationId: obligationId,
        expectedSeq: await rowSeqObligacion(obligationId),
        idempotencyKey: unico('pago'),
        paidOn: dia(0),
        externalReference: unico('TRX'),
        evidencia: { archivo: archivoDePrueba(), kind: 'comprobante' },
      }),
    );
    expect(r.obligacion).toMatchObject({
      status: 'reported_paid',
      billingValidatedAtReport: true,
      reportedBy: e.admin.id,
    });
    expect(r.evento.evidenceCount).toBe(1);
    // reportada ⇒ terminal, el documento validado ya no se cambia de obligación y sigue anulable
    const otra = await reportarPago(e.admin, {
      paymentObligationId: obligationId,
      expectedSeq: await rowSeqObligacion(obligationId),
      idempotencyKey: unico('pago'),
      paidOn: dia(0),
      externalReference: unico('TRX'),
    });
    expect(codigo(otra)).toBe('RESOURCE_CONFLICT');
    expect(razon(otra)).toBe('payment_already_reported');
  });

  it('el canje puro (obligación not_applicable) NO admite pago', async () => {
    const { ci } = await nuevaParticipacion(op, 'Barter pago', [e.productos.p80]);
    const barter = await crearAcuerdoPorSql(op, { ci, mode: 'barter', productos: [[e.productos.p80, 1]] });
    const r = await reportarPago(e.operativo, {
      paymentObligationId: barter.obligationId,
      expectedSeq: await rowSeqObligacion(barter.obligationId),
      idempotencyKey: unico('pago'),
      paidOn: dia(1),
      externalReference: REF,
    });
    expect(codigo(r)).toBe('RESOURCE_CONFLICT');
    expect(razon(r)).toBe('payment_not_applicable');
    const bd = await fila<{ status: string }>(`SELECT status FROM payment_obligations WHERE id = $1`, [
      barter.obligationId,
    ]);
    expect(bd.status).toBe('not_applicable');
  });

  it('SOLO personas con payment:report por la UI: director, consultor, analista, legal, chat, sistema y ajenos se rechazan', async () => {
    const { obligationId } = await conTarifa();
    const entrada = (clave: string) => ({
      paymentObligationId: obligationId,
      expectedSeq: 1,
      idempotencyKey: clave,
      paidOn: dia(1),
      externalReference: REF,
    });
    for (const actor of [e.director, e.consultor, e.analista, e.legal]) {
      expect(codigo(await reportarPago(actor, entrada(unico('p')))), actor.role).toBe('FORBIDDEN_ROLE');
    }
    for (const actor of [e.ajeno, e.cliente]) {
      expect(codigo(await reportarPago(actor, entrada(unico('p')))), actor.role).toBe('RESOURCE_NOT_FOUND');
    }
    expect(codigo(await reportarPago(e.operativo, entrada(unico('p')), { origin: 'chat' }))).toBe(
      'HUMAN_CONFIRMATION_REQUIRED',
    );
    expect(codigo(await reportarPago(e.operativo, entrada(unico('p')), { origin: 'system' }))).toBe(
      'FORBIDDEN_ROLE',
    );
    expect(codigo(await reportarPago('system' as never, entrada(unico('p'))))).toBe('FORBIDDEN_ROLE');
    const bd = await fila<{ status: string }>(`SELECT status FROM payment_obligations WHERE id = $1`, [
      obligationId,
    ]);
    expect(bd.status).toBe('pending');
  });

  it('exige fecha y referencia; idempotente; el desfase de secuencia es stale_transition', async () => {
    const { obligationId } = await conTarifa();
    const base = { paymentObligationId: obligationId, expectedSeq: 1, idempotencyKey: unico('v') };
    expect(codigo(await reportarPago(e.operativo, { ...base, paidOn: '', externalReference: REF }))).toBe(
      'VALIDATION_FAILED',
    );
    expect(
      codigo(await reportarPago(e.operativo, { ...base, paidOn: dia(1), externalReference: '  ' })),
    ).toBe('VALIDATION_FAILED');
    expect(
      codigo(await reportarPago(e.operativo, { ...base, paidOn: '2999-01-01', externalReference: REF })),
    ).toBe('VALIDATION_FAILED');
    expect(
      razon(
        await reportarPago(e.operativo, { ...base, expectedSeq: 7, paidOn: dia(1), externalReference: REF }),
      ),
    ).toBe('stale_transition');
    const clave = unico('idem');
    const entrada = { ...base, idempotencyKey: clave, paidOn: dia(1), externalReference: REF };
    const a = exito(await reportarPago(e.operativo, entrada));
    const b = exito(await reportarPago(e.operativo, entrada));
    expect(b.repetido).toBe(true);
    expect(b.evento.id).toBe(a.evento.id);
    expect(razon(await reportarPago(e.operativo, { ...entrada, externalReference: 'otra' }))).toBe(
      'idempotency_key_reused',
    );
  });
});

describe('cancelar y corregir', () => {
  it('no se cancela una obligación con documentos vivos; sin ellos, sí (terminal)', async () => {
    const { obligationId } = await conTarifa();
    const d = await registrar(obligationId);
    const bloqueada = await cancelarObligacionDePago(e.operativo, {
      paymentObligationId: obligationId,
      expectedSeq: await rowSeqObligacion(obligationId),
      idempotencyKey: unico('c'),
    });
    expect(codigo(bloqueada)).toBe('RESOURCE_CONFLICT');
    expect(razon(bloqueada)).toBe('live_documents');
    exito(
      await anularDocumento(e.operativo, {
        billingDocumentId: d.documento.id,
        expectedSeq: d.documento.rowSeq,
        idempotencyKey: unico('an'),
      }),
    );
    const c = exito(
      await cancelarObligacionDePago(e.director, {
        paymentObligationId: obligationId,
        expectedSeq: await rowSeqObligacion(obligationId),
        idempotencyKey: unico('c'),
        note: 'acuerdo cancelado',
      }),
    );
    expect(c.obligacion.status).toBe('cancelled');
    // cancelada ⇒ no admite documentos ni pago
    expect(
      codigo(
        await registrarDocumentoDeCobro(e.operativo, {
          paymentObligationId: obligationId,
          documentNumber: unico('CC'),
          issuedOn: dia(1),
          claimedAmount: 1,
          claimedCurrency: 'COP',
          archivo: archivoDePrueba(),
          idempotencyKey: unico('r'),
        }),
      ),
    ).toBe('RESOURCE_CONFLICT');
  });

  it('una corrección solo sobre un pago YA reportado: nota obligatoria, el sello no cambia, sin cambio de estado', async () => {
    const { obligationId } = await conTarifa();
    const nota = await registrarNotaDeCorreccionDePago(e.operativo, {
      paymentObligationId: obligationId,
      expectedSeq: 1,
      idempotencyKey: unico('n'),
      note: 'x',
    });
    expect(codigo(nota)).toBe('RESOURCE_CONFLICT'); // aún no reportado
    const reportado = exito(
      await reportarPago(e.operativo, {
        paymentObligationId: obligationId,
        expectedSeq: 1,
        idempotencyKey: unico('p'),
        paidOn: dia(2),
        externalReference: REF,
      }),
    );
    expect(
      codigo(
        await registrarNotaDeCorreccionDePago(e.operativo, {
          paymentObligationId: obligationId,
          expectedSeq: reportado.obligacion.rowSeq,
          idempotencyKey: unico('n'),
          note: '   ',
        }),
      ),
    ).toBe('VALIDATION_FAILED');
    const c = exito(
      await registrarNotaDeCorreccionDePago(e.operativo, {
        paymentObligationId: obligationId,
        expectedSeq: reportado.obligacion.rowSeq,
        idempotencyKey: unico('n'),
        note: NOTA,
        externalReference: 'TRX-CORREGIDA',
        evidencia: { archivo: archivoDePrueba(), kind: 'soporte' },
      }),
    );
    expect(c.evento).toMatchObject({
      eventType: 'payment.correction_noted',
      fromStatus: null,
      toStatus: null,
    });
    expect(c.obligacion).toMatchObject({
      status: 'reported_paid',
      externalReference: REF, // el sello original no cambia
      rowSeq: reportado.obligacion.rowSeq + 1,
    });
    // el director no tiene payment:report
    expect(
      codigo(
        await registrarNotaDeCorreccionDePago(e.director, {
          paymentObligationId: obligationId,
          expectedSeq: c.obligacion.rowSeq,
          idempotencyKey: unico('n'),
          note: 'otra',
        }),
      ),
    ).toBe('FORBIDDEN_ROLE');
    const hist = exito(
      await listarEventosOperativos(e.operativo, {
        subjectType: 'payment_obligation',
        subjectId: obligationId,
      }),
    );
    expect(hist.map((x) => x.eventType)).toEqual([
      'payment.applicability_set',
      'payment.reported',
      'payment.correction_noted',
    ]);
  });
});

describe('seguimiento y lecturas (finance:read)', () => {
  it('estado derivado: pending_document → document_received → pending_payment → reported_paid', async () => {
    const { ci, obligationId } = await conTarifa();
    const t = async () => exito(await obtenerSeguimientoDePago(e.operativo, ci))!;
    expect((await t()).tracking).toBe('pending_document');
    const d = await registrar(obligationId);
    expect((await t()).tracking).toBe('document_received');
    exito(
      await validarDocumento(e.operativo, {
        billingDocumentId: d.documento.id,
        expectedSeq: d.documento.rowSeq,
        idempotencyKey: unico('v'),
      }),
    );
    const validado = await t();
    expect(validado.tracking).toBe('pending_payment');
    expect(validado.documents).toHaveLength(1);
    expect(validado.agreement).toMatchObject({
      compensationType: 'fee',
      status: 'active',
      currentVersion: 1,
    });
    exito(
      await reportarPago(e.operativo, {
        paymentObligationId: obligationId,
        expectedSeq: validado.obligation.rowSeq,
        idempotencyKey: unico('p'),
        paidOn: dia(0),
        externalReference: REF,
      }),
    );
    const final = await t();
    expect(final.tracking).toBe('reported_paid');
    expect(final.obligation.billingValidatedAtReport).toBe(true);
  });

  it('canje puro ⇒ not_applicable; sin acuerdo ⇒ null', async () => {
    const { ci } = await nuevaParticipacion(op, 'Sin acuerdo', [e.productos.p80]);
    expect(exito(await obtenerSeguimientoDePago(e.operativo, ci))).toBeNull();
    await crearAcuerdoPorSql(op, { ci, mode: 'barter', productos: [[e.productos.p80, 1]] });
    expect(exito(await obtenerSeguimientoDePago(e.operativo, ci))!.tracking).toBe('not_applicable');
  });

  it('dinero solo con finance:read: consultor, analista y legal ⇒ FORBIDDEN_ROLE; ajeno y cliente ⇒ NOT_FOUND', async () => {
    const { ci, obligationId } = await conTarifa();
    await registrar(obligationId);
    for (const actor of [e.consultor, e.analista, e.legal]) {
      expect(codigo(await obtenerSeguimientoDePago(actor, ci)), actor.role).toBe('FORBIDDEN_ROLE');
      expect(codigo(await listarDocumentosDeCobro(actor, obligationId)), actor.role).toBe('FORBIDDEN_ROLE');
    }
    for (const actor of [e.ajeno, e.cliente]) {
      expect(codigo(await obtenerSeguimientoDePago(actor, ci)), actor.role).toBe('RESOURCE_NOT_FOUND');
      expect(codigo(await listarDocumentosDeCobro(actor, obligationId)), actor.role).toBe(
        'RESOURCE_NOT_FOUND',
      );
    }
    for (const actor of [e.operativo, e.director, e.admin]) {
      const docs = exito(await listarDocumentosDeCobro(actor, obligationId));
      expect(docs).toHaveLength(1);
      expect(docs[0]).toMatchObject({
        status: 'registered',
        claimedAmount: '1000000.00',
        claimedCurrency: 'COP',
      });
    }
    expect(codigo(await obtenerSeguimientoDePago(e.operativo, 'no-uuid'))).toBe('RESOURCE_NOT_FOUND');
  });

  it('la evidencia financiera exige finance:read: el consultor no la ve', async () => {
    const { obligationId } = await conTarifa();
    const d = await registrar(obligationId);
    const sujeto = { subjectType: 'billing_document' as const, subjectId: d.documento.id };
    expect(codigo(await listarEvidenciaDeSujeto(e.consultor, sujeto))).toBe('FORBIDDEN_ROLE');
    expect(codigo(await listarEvidenciaDeSujeto(e.ajeno, sujeto))).toBe('RESOURCE_NOT_FOUND');
    expect(exito(await listarEvidenciaDeSujeto(e.director, sujeto))).toHaveLength(1);
  });
});

describe('auditoría del cobro y el pago', () => {
  it('no contiene montos, números de documento, referencias, notas ni nombres de archivo', async () => {
    const { obligationId } = await conTarifa();
    const archivo = {
      filename: 'SENTINELA-ARCHIVO-cuenta.pdf',
      contenido: archivoDePrueba(unico('aud')).contenido,
    };
    const d = await registrar(obligationId, {
      documentNumber: NUMERO,
      claimedAmount: MONTO,
      archivo,
      note: NOTA,
    });
    exito(
      await validarDocumento(e.operativo, {
        billingDocumentId: d.documento.id,
        expectedSeq: d.documento.rowSeq,
        idempotencyKey: unico('v'),
        note: NOTA,
      }),
    );
    exito(
      await reportarPago(e.operativo, {
        paymentObligationId: obligationId,
        expectedSeq: await rowSeqObligacion(obligationId),
        idempotencyKey: unico('p'),
        paidOn: dia(0),
        externalReference: REF,
        note: NOTA,
        evidencia: {
          archivo: {
            filename: 'SENTINELA-COMPROBANTE.pdf',
            contenido: archivoDePrueba(unico('c')).contenido,
          },
          kind: 'comprobante',
        },
      }),
    );
    const registros = [
      ...(await auditoriaDeSujeto(d.documento.id)),
      ...(await auditoriaDeSujeto(obligationId)),
    ];
    expect(registros.map((x) => x.action)).toEqual(
      expect.arrayContaining(['billing.registered', 'billing.validated', 'payment.reported']),
    );
    const texto = JSON.stringify(registros);
    for (const prohibido of [NOTA, REF, NUMERO, 'SENTINELA', '987654', 'COP', '.pdf']) {
      expect(texto, prohibido).not.toContain(prohibido);
    }
    expect(texto).not.toContain('[redactado]');
    // la evidencia subida también se audita sin nombre de archivo
    const subidas = await fila<{ n: string; texto: string }>(
      `SELECT count(*) AS n, coalesce(string_agg(metadata::text, ' '), '') AS texto
         FROM audit_events WHERE action = 'ops_evidence.uploaded' AND entity_id = $1`,
      [d.documento.sourceDocumentId],
    );
    expect(Number(subidas.n)).toBe(1);
    expect(subidas.texto).not.toContain('SENTINELA');
  });
});
