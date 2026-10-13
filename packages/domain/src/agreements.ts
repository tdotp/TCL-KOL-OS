/**
 * Acuerdos con el KOL (V2 · Fase 8, DEC-049): cabecera, versiones inmutables de los términos materiales y
 * compromisos de producto.
 *
 * Módulo PURO (sin IO). La base repite estas reglas en la migración 027 (CHECK, triggers e invariantes
 * diferidos); una prueba ejecuta la matriz contra Postgres para detectar si divergen.
 *
 *   Acuerdo      = UNO por participación (CampaignInfluencer). `active → cancelled` (estado, nunca DELETE).
 *   Versión      = términos materiales INMUTABLES. Editar = versión N+1 (la numera la base).
 *   Compromiso   = producto COMPROMETIDO en una versión (≠ asignado ≠ enviado ≠ entregado).
 *   Obligación   = seguimiento de pago (DEC-014: tracking, no ejecución): barter ⇒ not_applicable.
 *
 * Montos: `numeric(14,2)` en la base; aquí viajan como cadena decimal canónica («1500000.00») para no perder
 * exactitud. Moneda: código ISO 4217 de una lista CERRADA (`MONEDAS_ISO_4217`; la base repite la forma
 * `^[A-Z]{3}$`).
 */

import { type Result, err, ok } from './errors';
import { isIsoDate, tieneCaracteresNoValidos } from './operational-events';

// ─────────────────────────── Estados del acuerdo ───────────────────────────────

export type AgreementStatus = 'active' | 'cancelled';

export const AGREEMENT_STATUSES: readonly AgreementStatus[] = ['active', 'cancelled'] as const;

/** `active → cancelled`; `cancelled` es terminal. Un cambio de términos NO es una transición: es una versión. */
export const AGREEMENT_TRANSITIONS: Readonly<Record<AgreementStatus, readonly AgreementStatus[]>> = {
  active: ['cancelled'],
  cancelled: [],
};

export function puedeTransicionarAcuerdo(from: AgreementStatus, to: AgreementStatus): boolean {
  return AGREEMENT_TRANSITIONS[from].includes(to);
}

// ─────────────────────────── Modo de compensación ──────────────────────────────

/** barter = canje puro (producto); fee = tarifa en dinero; mixed = tarifa + producto. */
export type CompensationType = 'fee' | 'barter' | 'mixed';

export const COMPENSATION_TYPES: readonly CompensationType[] = ['fee', 'barter', 'mixed'] as const;

export function isCompensationType(value: unknown): value is CompensationType {
  return typeof value === 'string' && (COMPENSATION_TYPES as readonly string[]).includes(value);
}

/** fee y mixed llevan monto y moneda; barter no. */
export function requiereMonto(mode: CompensationType): boolean {
  return mode !== 'barter';
}

/** barter y mixed exigen ≥ 1 compromiso de producto; fee puro no compromete producto. */
export function requiereCompromisos(mode: CompensationType): boolean {
  return mode !== 'fee';
}

/**
 * Estado con el que NACE la obligación de pago de un acuerdo: barter ⇒ `not_applicable`
 * (nunca `pending`); fee/mixed ⇒ `pending`.
 */
export function obligacionInicialPara(mode: CompensationType): 'not_applicable' | 'pending' {
  return mode === 'barter' ? 'not_applicable' : 'pending';
}

/**
 * Regla barter⇒not_applicable (invariante DIFERIDO de la base): con la versión vigente barter la
 * obligación es `not_applicable` (o `cancelled`); con fee/mixed, cualquiera menos `not_applicable`.
 */
export function obligacionCoherenteConModo(
  mode: CompensationType,
  obligationStatus: 'not_applicable' | 'pending' | 'reported_paid' | 'cancelled',
): boolean {
  if (mode === 'barter') return obligationStatus === 'not_applicable' || obligationStatus === 'cancelled';
  return obligationStatus !== 'not_applicable';
}

// ─────────────────────────── Dinero ────────────────────────────────────────────

const MONTO_CANONICO = /^\d{1,12}(?:\.\d{1,2})?$/u;

/**
 * Monedas aceptadas (ISO 4217), lista CERRADA y razonable para campañas KOL en la región y sus mercados: una
 * moneda que no existe («ABC», «XXX») no entra como moneda de un acuerdo, un envío ni un documento de cobro.
 * Agregar una es un cambio de dominio deliberado (una línea aquí), no una cadena libre.
 */
export const MONEDAS_ISO_4217: readonly string[] = [
  'USD',
  'COP',
  'EUR',
  'MXN',
  'BRL',
  'ARS',
  'CLP',
  'PEN',
  'UYU',
  'BOB',
  'PYG',
  'VES',
  'CRC',
  'GTQ',
  'DOP',
  'PAB',
  'GBP',
  'CAD',
  'CHF',
  'AUD',
  'CNY',
  'JPY',
  'KRW',
  'INR',
] as const;

export function esMonedaValida(value: unknown): value is string {
  return typeof value === 'string' && MONEDAS_ISO_4217.includes(value);
}

/**
 * Normaliza un monto (número o cadena) a la cadena decimal canónica de 2 decimales («1500000.00»).
 * Rechaza negativos, cero, más de 2 decimales, notación científica y valores fuera de `numeric(14,2)`.
 */
export function normalizarMonto(value: unknown): Result<string> {
  let texto: string;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return montoInvalido('El monto debe ser un número finito.');
    const centavos = Math.round(value * 100);
    if (Math.abs(value * 100 - centavos) > 1e-6) return montoInvalido('El monto admite máximo 2 decimales.');
    if (!Number.isSafeInteger(centavos)) return montoInvalido('El monto está fuera de rango.');
    texto = (centavos / 100).toFixed(2);
  } else if (typeof value === 'string') {
    texto = value.trim();
    if (!MONTO_CANONICO.test(texto)) {
      return montoInvalido(
        'El monto debe ser un decimal positivo con máximo 2 decimales (sin separadores de miles).',
      );
    }
  } else {
    return montoInvalido('El monto es obligatorio.');
  }
  const [entero = '0', decimales = ''] = texto.split('.');
  const canonico = `${entero.replace(/^0+(?=\d)/u, '')}.${decimales.padEnd(2, '0')}`;
  if (!MONTO_CANONICO.test(canonico)) return montoInvalido('El monto está fuera de rango.');
  if (Number(canonico) <= 0) return montoInvalido('El monto debe ser mayor que cero.');
  return ok(canonico);
}

function montoInvalido(message: string): Result<string> {
  return err({ code: 'VALIDATION_FAILED', message, details: { field: 'amount' } });
}

/**
 * Valida el par (monto, moneda) de un modo: barter ⇒ ambos AUSENTES; fee/mixed ⇒ monto > 0 y moneda
 * `^[A-Z]{3}$`. Devuelve el par normalizado.
 */
export function validarMontoYMonedaPorModo(
  mode: CompensationType,
  amount: unknown,
  currency: unknown,
): Result<{ readonly amount: string | null; readonly currency: string | null }> {
  const sinMonto = amount === undefined || amount === null || amount === '';
  const sinMoneda = currency === undefined || currency === null || currency === '';
  if (mode === 'barter') {
    if (!sinMonto || !sinMoneda) {
      return err({
        code: 'VALIDATION_FAILED',
        message: 'Un acuerdo de canje (barter) no lleva monto ni moneda.',
        details: { field: 'amount', mode },
      });
    }
    return ok({ amount: null, currency: null });
  }
  if (sinMonto) {
    return err({
      code: 'VALIDATION_FAILED',
      message: `Un acuerdo ${mode} exige el monto.`,
      details: { field: 'amount', mode },
    });
  }
  const monto = normalizarMonto(amount);
  if (!monto.ok) return monto;
  if (sinMoneda || !esMonedaValida(currency)) {
    return err({
      code: 'VALIDATION_FAILED',
      message: 'La moneda debe ser un código ISO de tres letras mayúsculas (p. ej. COP, USD).',
      details: { field: 'currency', mode },
    });
  }
  return ok({ amount: monto.value, currency });
}

// ─────────────────────────── Términos de una versión ───────────────────────────

export const MAX_CONDICIONES = 4000;
export const MAX_MOTIVO_DE_CAMBIO = 1000;
export const MAX_CANTIDAD_DE_PRODUCTO = 100000;

export interface ProductCommitmentInput {
  readonly campaignProductId: string;
  readonly quantity: number;
}

export interface AgreementTermsInput {
  readonly compensationType: string;
  readonly feeAmount?: unknown;
  readonly feeCurrency?: unknown;
  readonly startsOn?: string | null | undefined;
  readonly endsOn?: string | null | undefined;
  readonly conditions?: string | null | undefined;
  readonly changeReason?: string | null | undefined;
  readonly commitments?: readonly ProductCommitmentInput[] | undefined;
}

export interface AgreementTerms {
  readonly compensationType: CompensationType;
  readonly feeAmount: string | null;
  readonly feeCurrency: string | null;
  readonly startsOn: string | null;
  readonly endsOn: string | null;
  readonly conditions: string | null;
  readonly changeReason: string | null;
  readonly commitments: readonly ProductCommitmentInput[];
}

function terminoInvalido<T>(field: string, message: string): Result<T> {
  return err({ code: 'VALIDATION_FAILED', message, details: { field } });
}

/** Texto libre de varias líneas: sin NUL, control, invisibles ni bidi (`\n`, `\r` y `\t` se toleran). */
function textoLargo(value: string | null | undefined, field: string, max: number): Result<string | null> {
  if (value === undefined || value === null) return ok(null);
  if (typeof value !== 'string') return terminoInvalido(field, `«${field}» debe ser texto.`);
  const texto = value.trim();
  if (texto === '') return ok(null);
  if (texto.length > max) return terminoInvalido(field, `«${field}» no puede superar ${max} caracteres.`);
  if (tieneCaracteresNoValidos(texto, true)) {
    return terminoInvalido(field, `«${field}» contiene caracteres no válidos (control, invisibles o bidi).`);
  }
  return ok(texto);
}

export const MAX_MOTIVO_DE_CANCELACION_DE_ACUERDO = 500;

/** Motivo obligatorio al cancelar un acuerdo: 1 a 500 caracteres, sin control, invisibles ni bidi. */
export function validarMotivoDeCancelacionDeAcuerdo(value: unknown): Result<string> {
  if (typeof value !== 'string') {
    return terminoInvalido('reason', 'El motivo de la cancelación es obligatorio (hasta 500 caracteres).');
  }
  const texto = value.trim();
  if (texto === '' || texto.length > MAX_MOTIVO_DE_CANCELACION_DE_ACUERDO) {
    return terminoInvalido('reason', 'El motivo de la cancelación es obligatorio (hasta 500 caracteres).');
  }
  if (tieneCaracteresNoValidos(texto, true)) {
    return terminoInvalido(
      'reason',
      'El motivo contiene caracteres no válidos (control, invisibles o bidi).',
    );
  }
  return ok(texto);
}

/**
 * Valida los términos de una versión del acuerdo (la base repite cada regla):
 *  · modo y monto/moneda coherentes (barter sin monto; fee/mixed con monto > 0 y moneda ISO);
 *  · barter/mixed ⇒ ≥ 1 compromiso de producto; fee ⇒ ninguno; sin productos repetidos; cantidad entera 1..100000;
 *  · vigencia con `endsOn ≥ startsOn`; condiciones ≤ 4000; motivo de cambio ≤ 1000.
 *
 * `versionNumber` (si se informa y es > 1) exige el motivo del cambio: editar = versión N+1 con su porqué.
 */
export function validarTerminosDeAcuerdo(
  input: AgreementTermsInput,
  versionNumber?: number,
): Result<AgreementTerms> {
  if (!isCompensationType(input.compensationType)) {
    return terminoInvalido('compensationType', 'El modo de compensación debe ser fee, barter o mixed.');
  }
  const mode = input.compensationType;
  const dinero = validarMontoYMonedaPorModo(mode, input.feeAmount, input.feeCurrency);
  if (!dinero.ok) return dinero;

  const compromisos = input.commitments ?? [];
  if (requiereCompromisos(mode) && compromisos.length === 0) {
    return terminoInvalido('commitments', `Un acuerdo ${mode} exige al menos un producto comprometido.`);
  }
  if (!requiereCompromisos(mode) && compromisos.length > 0) {
    return terminoInvalido('commitments', 'Un acuerdo con tarifa pura (fee) no compromete producto.');
  }
  const vistos = new Set<string>();
  for (const c of compromisos) {
    if (typeof c.campaignProductId !== 'string' || c.campaignProductId === '') {
      return terminoInvalido('commitments', 'Cada compromiso necesita su producto de campaña.');
    }
    if (vistos.has(c.campaignProductId)) {
      return terminoInvalido('commitments', 'Un producto no se compromete dos veces en la misma versión.');
    }
    vistos.add(c.campaignProductId);
    if (!Number.isInteger(c.quantity) || c.quantity < 1 || c.quantity > MAX_CANTIDAD_DE_PRODUCTO) {
      return terminoInvalido(
        'commitments',
        `La cantidad comprometida debe ser un entero entre 1 y ${MAX_CANTIDAD_DE_PRODUCTO}.`,
      );
    }
  }

  const startsOn = input.startsOn ?? null;
  const endsOn = input.endsOn ?? null;
  if (startsOn !== null && !isIsoDate(startsOn))
    return terminoInvalido('startsOn', 'La fecha de inicio debe ser YYYY-MM-DD.');
  if (endsOn !== null && !isIsoDate(endsOn))
    return terminoInvalido('endsOn', 'La fecha de fin debe ser YYYY-MM-DD.');
  if (startsOn !== null && endsOn !== null && endsOn < startsOn) {
    return terminoInvalido('endsOn', 'La vigencia termina antes de empezar.');
  }

  const conditions = textoLargo(input.conditions, 'conditions', MAX_CONDICIONES);
  if (!conditions.ok) return conditions;
  const changeReason = textoLargo(input.changeReason, 'changeReason', MAX_MOTIVO_DE_CAMBIO);
  if (!changeReason.ok) return changeReason;
  if (versionNumber !== undefined && versionNumber > 1 && changeReason.value === null) {
    return terminoInvalido(
      'changeReason',
      'Editar un acuerdo registra una versión nueva: indique el motivo del cambio.',
    );
  }

  return ok({
    compensationType: mode,
    feeAmount: dinero.value.amount,
    feeCurrency: dinero.value.currency,
    startsOn,
    endsOn,
    conditions: conditions.value,
    changeReason: changeReason.value,
    commitments: compromisos.map((c) => ({ campaignProductId: c.campaignProductId, quantity: c.quantity })),
  });
}

// ─────────────────────────── Cambios entre versiones ───────────────────────────

export interface EconomicTerms {
  readonly compensationType: CompensationType;
  readonly feeAmount: string | null;
  readonly feeCurrency: string | null;
}

/** ¿Cambian el modo, el monto o la moneda (los términos económicos)? */
export function cambiaTerminosEconomicos(prev: EconomicTerms, next: EconomicTerms): boolean {
  return (
    prev.compensationType !== next.compensationType ||
    prev.feeAmount !== next.feeAmount ||
    prev.feeCurrency !== next.feeCurrency
  );
}

/**
 * Con el pago ya REPORTADO (`reported_paid`) no se versionan modo, monto ni moneda (sí vigencia y condiciones).
 * Espejo del trigger de `agreement_versions`.
 */
export function puedeVersionarAcuerdo(
  prev: EconomicTerms,
  next: EconomicTerms,
  obligationStatus: 'not_applicable' | 'pending' | 'reported_paid' | 'cancelled' | undefined,
): Result<true> {
  if (obligationStatus === 'reported_paid' && cambiaTerminosEconomicos(prev, next)) {
    return err({
      code: 'RESOURCE_CONFLICT',
      message: 'El pago de este acuerdo ya fue reportado: no se cambia el modo, el monto ni la moneda.',
      details: { reason: 'payment_reported' },
    });
  }
  return ok(true);
}

/** Productos comprometidos que una versión nueva QUITA respecto de la anterior (para avisar a la UI). */
export function compromisosRetirados(
  prev: readonly ProductCommitmentInput[],
  next: readonly ProductCommitmentInput[],
): readonly string[] {
  const nuevos = new Set(next.map((c) => c.campaignProductId));
  return prev.map((c) => c.campaignProductId).filter((id) => !nuevos.has(id));
}
