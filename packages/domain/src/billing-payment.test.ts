import { describe, expect, it } from 'vitest';
import {
  BILLING_DOCUMENT_STATUSES,
  MAX_EMISION_ADELANTADA_DIAS,
  BILLING_DOCUMENT_TRANSITIONS,
  EVENTO_DE_DOCUMENTO_POR_DESTINO,
  EVENTO_DE_OBLIGACION_POR_DESTINO,
  PAYMENT_OBLIGATION_STATUSES,
  PAYMENT_OBLIGATION_TRANSITIONS,
  billingValidadoAlReportar,
  derivarSeguimientoDePago,
  esDocumentoVivo,
  puedeCambiarObligacion,
  puedeTransicionarDocumento,
  puedeTransicionarObligacion,
  validarDocumentoDeCobro,
  validarReporteDePago,
} from './billing-payment';
import { canTransitionOperationalSubject, eventTypesForTransition } from './operational-events';

describe('grafo del documento de cobro', () => {
  it('registrar ≠ validar ≠ anular', () => {
    expect(puedeTransicionarDocumento('registered', 'validated')).toBe(true);
    expect(puedeTransicionarDocumento('registered', 'rejected')).toBe(true);
    expect(puedeTransicionarDocumento('registered', 'voided')).toBe(true);
    expect(puedeTransicionarDocumento('validated', 'voided')).toBe(true);
    expect(puedeTransicionarDocumento('validated', 'rejected')).toBe(false);
    expect(puedeTransicionarDocumento('rejected', 'registered')).toBe(false);
    expect(puedeTransicionarDocumento('voided', 'registered')).toBe(false);
    expect(esDocumentoVivo('registered')).toBe(true);
    expect(esDocumentoVivo('validated')).toBe(true);
    expect(esDocumentoVivo('rejected')).toBe(false);
  });

  it('PARIDAD con las aristas de eventos', () => {
    for (const desde of BILLING_DOCUMENT_STATUSES) {
      for (const hacia of BILLING_DOCUMENT_STATUSES) {
        expect(canTransitionOperationalSubject('billing_document', desde, hacia), `${desde}→${hacia}`).toBe(
          puedeTransicionarDocumento(desde, hacia),
        );
        if (puedeTransicionarDocumento(desde, hacia)) {
          expect(eventTypesForTransition('billing_document', desde, hacia)).toEqual([
            EVENTO_DE_DOCUMENTO_POR_DESTINO[hacia],
          ]);
        }
      }
    }
    expect(Object.keys(BILLING_DOCUMENT_TRANSITIONS).length).toBe(BILLING_DOCUMENT_STATUSES.length);
  });
});

describe('grafo de la obligación', () => {
  it('not_applicable ↔ pending; reported_paid y cancelled terminales', () => {
    expect(puedeTransicionarObligacion('not_applicable', 'pending')).toBe(true);
    expect(puedeTransicionarObligacion('pending', 'not_applicable')).toBe(true);
    expect(puedeTransicionarObligacion('pending', 'reported_paid')).toBe(true);
    expect(puedeTransicionarObligacion('pending', 'cancelled')).toBe(true);
    expect(puedeTransicionarObligacion('not_applicable', 'cancelled')).toBe(true);
    expect(puedeTransicionarObligacion('not_applicable', 'reported_paid')).toBe(false);
    for (const a of PAYMENT_OBLIGATION_STATUSES) {
      expect(puedeTransicionarObligacion('reported_paid', a)).toBe(false);
      expect(puedeTransicionarObligacion('cancelled', a)).toBe(false);
    }
  });

  it('PARIDAD con las aristas de eventos', () => {
    for (const desde of PAYMENT_OBLIGATION_STATUSES) {
      for (const hacia of PAYMENT_OBLIGATION_STATUSES) {
        expect(canTransitionOperationalSubject('payment_obligation', desde, hacia), `${desde}→${hacia}`).toBe(
          puedeTransicionarObligacion(desde, hacia),
        );
        if (puedeTransicionarObligacion(desde, hacia)) {
          expect(eventTypesForTransition('payment_obligation', desde, hacia)).toEqual([
            EVENTO_DE_OBLIGACION_POR_DESTINO[hacia],
          ]);
        }
      }
    }
    expect(Object.keys(PAYMENT_OBLIGATION_TRANSITIONS).length).toBe(PAYMENT_OBLIGATION_STATUSES.length);
  });

  it('cambios coherentes con el acuerdo y los documentos vivos', () => {
    const ctx = { agreementActive: true, liveDocuments: 0 } as const;
    expect(
      puedeCambiarObligacion({ ...ctx, from: 'not_applicable', to: 'pending', agreementMode: 'fee' }).ok,
    ).toBe(true);
    expect(
      puedeCambiarObligacion({ ...ctx, from: 'not_applicable', to: 'pending', agreementMode: 'barter' }).ok,
    ).toBe(false);
    expect(
      puedeCambiarObligacion({ ...ctx, from: 'pending', to: 'not_applicable', agreementMode: 'barter' }).ok,
    ).toBe(true);
    expect(
      puedeCambiarObligacion({ ...ctx, from: 'pending', to: 'not_applicable', agreementMode: 'mixed' }).ok,
    ).toBe(false);
    expect(
      puedeCambiarObligacion({
        ...ctx,
        liveDocuments: 1,
        from: 'pending',
        to: 'not_applicable',
        agreementMode: 'barter',
      }).ok,
    ).toBe(false);
    expect(
      puedeCambiarObligacion({
        ...ctx,
        liveDocuments: 1,
        from: 'pending',
        to: 'cancelled',
        agreementMode: 'fee',
      }).ok,
    ).toBe(false);
    expect(
      puedeCambiarObligacion({ ...ctx, from: 'pending', to: 'reported_paid', agreementMode: 'fee' }).ok,
    ).toBe(true);
    expect(
      puedeCambiarObligacion({
        ...ctx,
        agreementActive: false,
        from: 'pending',
        to: 'reported_paid',
        agreementMode: 'fee',
      }).ok,
    ).toBe(false);
    expect(
      puedeCambiarObligacion({ ...ctx, from: 'reported_paid', to: 'cancelled', agreementMode: 'fee' }).ok,
    ).toBe(false);
  });
});

describe('documento de cobro y reporte de pago', () => {
  const doc = {
    documentNumber: ' CC-001 ',
    issuedOn: '2026-10-01',
    claimedAmount: '1500000',
    claimedCurrency: 'COP',
    sourceDocumentId: 'src-1',
  };

  it('valida y normaliza; el soporte es OBLIGATORIO', () => {
    const r = validarDocumentoDeCobro(doc);
    expect(r.ok && r.value).toMatchObject({ documentNumber: 'CC-001', claimedAmount: '1500000.00' });
    expect(validarDocumentoDeCobro({ ...doc, sourceDocumentId: null }).ok).toBe(false);
    expect(validarDocumentoDeCobro({ ...doc, sourceDocumentId: '' }).ok).toBe(false);
    expect(validarDocumentoDeCobro({ ...doc, documentNumber: '  ' }).ok).toBe(false);
    expect(validarDocumentoDeCobro({ ...doc, issuedOn: '2026-1-1' }).ok).toBe(false);
    expect(validarDocumentoDeCobro({ ...doc, claimedAmount: 0 }).ok).toBe(false);
    expect(validarDocumentoDeCobro({ ...doc, claimedCurrency: 'cop' }).ok).toBe(false);
  });

  it('el reporte exige fecha de pago y referencia externa', () => {
    expect(validarReporteDePago({ paidOn: '2026-10-05', externalReference: ' TRX-9 ' })).toEqual(
      expect.objectContaining({ ok: true, value: { paidOn: '2026-10-05', externalReference: 'TRX-9' } }),
    );
    expect(validarReporteDePago({ paidOn: undefined, externalReference: 'x' }).ok).toBe(false);
    expect(validarReporteDePago({ paidOn: '2026-10-05', externalReference: '  ' }).ok).toBe(false);
    expect(validarReporteDePago({ paidOn: '2026-10-05', externalReference: undefined }).ok).toBe(false);
  });
});

describe('seguimiento de pago derivado', () => {
  it('not_applicable | pending_document | document_received | pending_payment | reported_paid', () => {
    expect(derivarSeguimientoDePago('not_applicable', [])).toBe('not_applicable');
    expect(derivarSeguimientoDePago('cancelled', ['validated'])).toBe('not_applicable');
    expect(derivarSeguimientoDePago('pending', [])).toBe('pending_document');
    expect(derivarSeguimientoDePago('pending', ['rejected', 'voided'])).toBe('pending_document');
    expect(derivarSeguimientoDePago('pending', ['registered'])).toBe('document_received');
    expect(derivarSeguimientoDePago('pending', ['registered', 'validated'])).toBe('pending_payment');
    expect(derivarSeguimientoDePago('reported_paid', [])).toBe('reported_paid');
  });

  it('reportar sin documento validado no se bloquea: solo se sella el hecho', () => {
    expect(billingValidadoAlReportar([])).toBe(false);
    expect(billingValidadoAlReportar(['registered'])).toBe(false);
    expect(billingValidadoAlReportar(['validated'])).toBe(true);
  });
});

describe('documento de cobro: fecha de emisión (FIX-B)', () => {
  const base = {
    documentNumber: 'F-1',
    issuedOn: '2026-05-01',
    claimedAmount: 100,
    claimedCurrency: 'COP',
    sourceDocumentId: '3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f',
  };
  const hoy = new Date('2026-05-10T12:00:00Z');

  it('0000-01-01 y fechas inexistentes son validación; el futuro lejano (> 1 año) se rechaza, el cercano no', () => {
    expect(validarDocumentoDeCobro({ ...base, issuedOn: '0000-01-01' }, hoy).ok).toBe(false);
    expect(validarDocumentoDeCobro({ ...base, issuedOn: '2999-01-01' }, hoy).ok).toBe(false);
    const lejano = validarDocumentoDeCobro({ ...base, issuedOn: '2027-05-12' }, hoy);
    expect(lejano.ok).toBe(false);
    if (!lejano.ok)
      expect(lejano.error.details).toMatchObject({ field: 'issuedOn', reason: 'in_the_far_future' });
    expect(MAX_EMISION_ADELANTADA_DIAS).toBe(365);
    expect(validarDocumentoDeCobro({ ...base, issuedOn: '2027-05-10' }, hoy).ok).toBe(true);
    expect(validarDocumentoDeCobro({ ...base, issuedOn: '2026-06-01' }, hoy).ok).toBe(true);
    expect(validarDocumentoDeCobro({ ...base, issuedOn: '2020-01-01' }, hoy).ok).toBe(true);
  });

  it('la moneda reclamada es de la lista cerrada y el número no admite invisibles', () => {
    expect(validarDocumentoDeCobro({ ...base, claimedCurrency: 'XXX' }, hoy).ok).toBe(false);
    expect(validarDocumentoDeCobro({ ...base, documentNumber: 'F\u200B1' }, hoy).ok).toBe(false);
  });

  it('un reporte de pago con fecha fuera de rango se rechaza', () => {
    expect(validarReporteDePago({ paidOn: '0000-01-01', externalReference: 'R-1' }).ok).toBe(false);
    expect(validarReporteDePago({ paidOn: '2026-05-01', externalReference: 'R-1' }).ok).toBe(true);
  });
});
