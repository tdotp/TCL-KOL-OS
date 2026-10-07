/**
 * Documentos de cobro y seguimiento de pago (V2 · Fase 8, DEC-049).
 *
 * Módulo PURO (sin IO). La base repite el grafo y los sellos en las migraciones 027, 030 y 031.
 *
 *   PAYMENT TRACKING ≠ PAYMENT EXECUTION (DEC-014). Este sistema NUNCA mueve dinero, ni toca bancos,
 *   impuestos o ledger: registra que una persona con rol REPORTÓ que un tercero pagó. Registrar un documento
 *   de cobro ≠ validarlo ≠ pagarlo.
 *
 *   billing_document     registered → validated | rejected ; registered | validated → voided
 *   payment_obligation   not_applicable ↔ pending ; pending → reported_paid | cancelled ; not_applicable → cancelled
 *
 * `reported_paid` es terminal y SELLADO (quién, cuándo, fecha de pago y referencia externa); una corrección
 * es un evento `payment.correction_noted`, sin cambio de estado. Reportar sin documento validado NO se
 * bloquea: queda `billingValidatedAtReport = false` y la UI avisa.
 */

import { type CompensationType, esMonedaValida, normalizarMonto } from './agreements';
import { type Result, err, ok } from './errors';
import { isIsoDate } from './operational-events';

// ─────────────────────────── Documento de cobro ────────────────────────────────

export type BillingDocumentStatus = 'registered' | 'validated' | 'rejected' | 'voided';

export const BILLING_DOCUMENT_STATUSES: readonly BillingDocumentStatus[] = [
  'registered',
  'validated',
  'rejected',
  'voided',
] as const;

export const BILLING_DOCUMENT_TRANSITIONS: Readonly<
  Record<BillingDocumentStatus, readonly BillingDocumentStatus[]>
> = {
  registered: ['validated', 'rejected', 'voided'],
  validated: ['voided'],
  rejected: [],
  voided: [],
};

export function isBillingDocumentStatus(value: unknown): value is BillingDocumentStatus {
  return typeof value === 'string' && (BILLING_DOCUMENT_STATUSES as readonly string[]).includes(value);
}

export function puedeTransicionarDocumento(from: BillingDocumentStatus, to: BillingDocumentStatus): boolean {
  return BILLING_DOCUMENT_TRANSITIONS[from].includes(to);
}

/** Documento VIVO: `registered` o `validated` (ocupa la unicidad de número y archivo; bloquea cambios de obligación). */
export function esDocumentoVivo(status: BillingDocumentStatus): boolean {
  return status === 'registered' || status === 'validated';
}

export const EVENTO_DE_DOCUMENTO_POR_DESTINO: Readonly<Record<BillingDocumentStatus, string>> = {
  registered: 'billing.registered',
  validated: 'billing.validated',
  rejected: 'billing.rejected',
  voided: 'billing.voided',
};

export const MAX_NUMERO_DE_DOCUMENTO = 100;

/**
 * Cuánto puede adelantarse la fecha de emisión de un documento de cobro respecto de hoy: un documento con fecha
 * de emisión en el futuro lejano (p. ej. 2999-01-01) es un error o un intento de falsear el seguimiento. Se
 * tolera hasta un año (cuentas de cobro programadas), nunca más.
 */
export const MAX_EMISION_ADELANTADA_DIAS = 365;

export interface BillingDocumentInput {
  readonly documentNumber: string;
  readonly issuedOn: string;
  readonly claimedAmount: unknown;
  readonly claimedCurrency: unknown;
  /** Fuente `soporte_operativo` que respalda el documento: OBLIGATORIA. */
  readonly sourceDocumentId: string | null | undefined;
}

export interface ValidatedBillingDocument {
  readonly documentNumber: string;
  readonly issuedOn: string;
  readonly claimedAmount: string;
  readonly claimedCurrency: string;
  readonly sourceDocumentId: string;
}

function invalido<T>(field: string, message: string): Result<T> {
  return err({ code: 'VALIDATION_FAILED', message, details: { field } });
}

/**
 * Valida el registro de un documento de cobro: número, fecha, monto y moneda RECLAMADOS (lo que el documento
 * dice; no se compara ni se paga) y su soporte obligatorio.
 */
export function validarDocumentoDeCobro(
  input: BillingDocumentInput,
  ahora: Date = new Date(),
): Result<ValidatedBillingDocument> {
  const numero = typeof input.documentNumber === 'string' ? input.documentNumber.trim() : '';
  if (numero === '' || numero.length > MAX_NUMERO_DE_DOCUMENTO || /[\p{Cc}\p{Cf}]/u.test(numero)) {
    return invalido(
      'documentNumber',
      'El número del documento es obligatorio (hasta 100 caracteres, sin caracteres de control).',
    );
  }
  if (!isIsoDate(input.issuedOn)) return invalido('issuedOn', 'La fecha de emisión debe ser YYYY-MM-DD.');
  const limite = new Date(ahora.getTime());
  limite.setUTCDate(limite.getUTCDate() + MAX_EMISION_ADELANTADA_DIAS);
  if (input.issuedOn > limite.toISOString().slice(0, 10)) {
    return err({
      code: 'VALIDATION_FAILED',
      message: `La fecha de emisión no puede estar más de ${MAX_EMISION_ADELANTADA_DIAS} días en el futuro.`,
      details: { field: 'issuedOn', reason: 'in_the_far_future' },
    });
  }
  const monto = normalizarMonto(input.claimedAmount);
  if (!monto.ok) return invalido('claimedAmount', monto.error.message);
  if (!esMonedaValida(input.claimedCurrency)) {
    return invalido('claimedCurrency', 'La moneda debe ser un código ISO de tres letras mayúsculas.');
  }
  if (typeof input.sourceDocumentId !== 'string' || input.sourceDocumentId === '') {
    return invalido('sourceDocumentId', 'Todo documento de cobro exige su soporte (archivo de evidencia).');
  }
  return ok({
    documentNumber: numero,
    issuedOn: input.issuedOn,
    claimedAmount: monto.value,
    claimedCurrency: input.claimedCurrency,
    sourceDocumentId: input.sourceDocumentId,
  });
}

// ─────────────────────────── Obligación de pago ────────────────────────────────

export type PaymentObligationStatus = 'not_applicable' | 'pending' | 'reported_paid' | 'cancelled';

export const PAYMENT_OBLIGATION_STATUSES: readonly PaymentObligationStatus[] = [
  'not_applicable',
  'pending',
  'reported_paid',
  'cancelled',
] as const;

export const PAYMENT_OBLIGATION_TRANSITIONS: Readonly<
  Record<PaymentObligationStatus, readonly PaymentObligationStatus[]>
> = {
  not_applicable: ['pending', 'cancelled'],
  pending: ['not_applicable', 'reported_paid', 'cancelled'],
  reported_paid: [],
  cancelled: [],
};

export function isPaymentObligationStatus(value: unknown): value is PaymentObligationStatus {
  return typeof value === 'string' && (PAYMENT_OBLIGATION_STATUSES as readonly string[]).includes(value);
}

export function puedeTransicionarObligacion(
  from: PaymentObligationStatus,
  to: PaymentObligationStatus,
): boolean {
  return PAYMENT_OBLIGATION_TRANSITIONS[from].includes(to);
}

export const EVENTO_DE_OBLIGACION_POR_DESTINO: Readonly<Record<PaymentObligationStatus, string>> = {
  not_applicable: 'payment.applicability_set',
  pending: 'payment.applicability_set',
  reported_paid: 'payment.reported',
  cancelled: 'payment.cancelled',
};

export interface ObligationChangeContext {
  readonly to: PaymentObligationStatus;
  readonly from: PaymentObligationStatus;
  /** Modo de la versión VIGENTE del acuerdo ACTIVO. */
  readonly agreementMode: CompensationType;
  readonly agreementActive: boolean;
  /** Documentos de cobro `registered | validated` de la obligación. */
  readonly liveDocuments: number;
}

/**
 * Espejo de `payment_obligations_reglas` (031) para los cambios de estado de la obligación:
 *  · → pending            solo con acuerdo activo y versión vigente con tarifa (fee/mixed);
 *  · → not_applicable     solo con acuerdo activo y versión vigente barter, y CERO documentos vivos;
 *  · → cancelled          solo con CERO documentos vivos;
 *  · → reported_paid      solo con acuerdo activo con tarifa (el reporte lo valida `validarReporteDePago`).
 */
export function puedeCambiarObligacion(context: ObligationChangeContext): Result<true> {
  if (!puedeTransicionarObligacion(context.from, context.to)) {
    return err({
      code: 'RESOURCE_CONFLICT',
      message: `Transición no válida de la obligación: ${context.from} → ${context.to}.`,
      details: { reason: 'invalid_transition' },
    });
  }
  const conTarifa = context.agreementMode === 'fee' || context.agreementMode === 'mixed';
  const conflicto = (message: string, reason: string): Result<true> =>
    err({ code: 'RESOURCE_CONFLICT', message, details: { reason } });
  switch (context.to) {
    case 'pending':
    case 'reported_paid':
      if (!context.agreementActive || !conTarifa) {
        return conflicto(
          'La obligación solo admite pago con un acuerdo activo con tarifa (fee o mixed).',
          'agreement_mode',
        );
      }
      return ok(true);
    case 'not_applicable':
      if (!context.agreementActive || context.agreementMode !== 'barter') {
        return conflicto(
          'La obligación solo es not_applicable con un acuerdo activo de canje puro (barter).',
          'agreement_mode',
        );
      }
      if (context.liveDocuments > 0) {
        return conflicto('Hay documentos de cobro vivos: anúlelos o recházelos antes.', 'live_documents');
      }
      return ok(true);
    case 'cancelled':
      if (context.liveDocuments > 0) {
        return conflicto('Hay documentos de cobro vivos: anúlelos o recházelos antes.', 'live_documents');
      }
      return ok(true);
    default:
      return ok(true);
  }
}

// ─────────────────────────── Reportar el pago ──────────────────────────────────

export interface PaymentReportInput {
  readonly paidOn: unknown;
  readonly externalReference: unknown;
}

export interface ValidatedPaymentReport {
  readonly paidOn: string;
  readonly externalReference: string;
}

export const MAX_REFERENCIA_EXTERNA = 200;

/**
 * Valida los hechos que sellan un pago reportado: fecha de pago (`YYYY-MM-DD`, no futura la valida el evento)
 * y referencia externa. El actor (`reportedBy`) y el instante (`reportedAt`) los toma la base del evento.
 */
export function validarReporteDePago(input: PaymentReportInput): Result<ValidatedPaymentReport> {
  if (!isIsoDate(input.paidOn)) return invalido('paidOn', 'La fecha de pago debe ser YYYY-MM-DD.');
  const referencia = typeof input.externalReference === 'string' ? input.externalReference.trim() : '';
  if (referencia === '' || referencia.length > MAX_REFERENCIA_EXTERNA || /[\p{Cc}\p{Cf}]/u.test(referencia)) {
    return invalido(
      'externalReference',
      'La referencia externa del pago es obligatoria (hasta 200 caracteres).',
    );
  }
  return ok({ paidOn: input.paidOn, externalReference: referencia });
}

/** ¿Hay un documento validado? (se sella en `billing_validated_at_report`; NO bloquea el reporte). */
export function billingValidadoAlReportar(documentStatuses: readonly BillingDocumentStatus[]): boolean {
  return documentStatuses.includes('validated');
}

// ─────────────────────────── Seguimiento derivado ──────────────────────────────

/**
 * Seguimiento de pago DERIVADO (no se almacena):
 *   not_applicable     no hay pago esperado (canje puro, o la obligación fue cancelada);
 *   pending_document   pago pendiente y aún sin documento de cobro vivo;
 *   document_received  hay documento registrado, aún sin validar;
 *   pending_payment    hay documento validado; falta que se reporte el pago;
 *   reported_paid      el pago fue REPORTADO (sellado).
 */
export type PaymentTracking =
  'not_applicable' | 'pending_document' | 'document_received' | 'pending_payment' | 'reported_paid';

export const PAYMENT_TRACKING_VALUES: readonly PaymentTracking[] = [
  'not_applicable',
  'pending_document',
  'document_received',
  'pending_payment',
  'reported_paid',
] as const;

export function derivarSeguimientoDePago(
  obligationStatus: PaymentObligationStatus,
  documentStatuses: readonly BillingDocumentStatus[],
): PaymentTracking {
  switch (obligationStatus) {
    case 'reported_paid':
      return 'reported_paid';
    case 'not_applicable':
    case 'cancelled':
      return 'not_applicable';
    case 'pending':
      if (documentStatuses.includes('validated')) return 'pending_payment';
      if (documentStatuses.includes('registered')) return 'document_received';
      return 'pending_document';
  }
}
