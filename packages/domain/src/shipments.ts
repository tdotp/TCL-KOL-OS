/**
 * Envíos de producto (V2 · Fase 8, DEC-049): logística de UNA participación.
 *
 * Módulo PURO (sin IO). La base repite el grafo y las reglas de preparación en las migraciones 029 y 031.
 *
 *   pending → prepared → shipped → delivered
 *   pending | prepared → cancelled          shipped → failed | returned          delivered → returned
 *   Terminales: cancelled, failed, returned. Reenviar = envío nuevo.
 *
 * `delivered` SOLO se alcanza con un evento humano (`shipment.delivered`, con fecha): jamás se infiere de la
 * asignación del producto ni de un envío. Producto ASIGNADO ≠ COMPROMETIDO ≠ ENVIADO ≠ ENTREGADO.
 *
 * La PII (dirección, cédula, teléfono) NUNCA está en el envío: solo `piiRecordId` (referencia segura).
 */

import {
  esMonedaValida,
  normalizarMonto,
  type CompensationType,
  MAX_CANTIDAD_DE_PRODUCTO,
} from './agreements';
import { type Result, err, ok } from './errors';

// ─────────────────────────── Estados ───────────────────────────────────────────

export type ShipmentStatus =
  'pending' | 'prepared' | 'shipped' | 'delivered' | 'failed' | 'returned' | 'cancelled';

export const SHIPMENT_STATUSES: readonly ShipmentStatus[] = [
  'pending',
  'prepared',
  'shipped',
  'delivered',
  'failed',
  'returned',
  'cancelled',
] as const;

/** Transiciones válidas (las mismas que impone la base vía las aristas de la 031). */
export const SHIPMENT_TRANSITIONS: Readonly<Record<ShipmentStatus, readonly ShipmentStatus[]>> = {
  pending: ['prepared', 'cancelled'],
  prepared: ['shipped', 'cancelled'],
  shipped: ['delivered', 'failed', 'returned'],
  delivered: ['returned'],
  failed: [],
  returned: [],
  cancelled: [],
};

export function isShipmentStatus(value: unknown): value is ShipmentStatus {
  return typeof value === 'string' && (SHIPMENT_STATUSES as readonly string[]).includes(value);
}

export function puedeTransicionarEnvio(from: ShipmentStatus, to: ShipmentStatus): boolean {
  return SHIPMENT_TRANSITIONS[from].includes(to);
}

export function esEnvioTerminal(status: ShipmentStatus): boolean {
  return SHIPMENT_TRANSITIONS[status].length === 0;
}

/**
 * Envío ABIERTO: aún puede avanzar o llegar. Un producto en un envío abierto no se desasigna de la
 * participación (guarda de la 029).
 */
export const ESTADOS_DE_ENVIO_ABIERTOS: readonly ShipmentStatus[] = [
  'pending',
  'prepared',
  'shipped',
] as const;

export function esEnvioAbierto(status: ShipmentStatus): boolean {
  return ESTADOS_DE_ENVIO_ABIERTOS.includes(status);
}

/** Tipo de evento que produce cada estado destino (el único camino a cambiar `status`). */
export const EVENTO_DE_ENVIO_POR_DESTINO: Readonly<Record<ShipmentStatus, string>> = {
  pending: 'shipment.created',
  prepared: 'shipment.prepared',
  shipped: 'shipment.shipped',
  delivered: 'shipment.delivered',
  failed: 'shipment.failed',
  returned: 'shipment.returned',
  cancelled: 'shipment.cancelled',
};

// ─────────────────────────── Datos del envío ───────────────────────────────────

export const MAX_TRANSPORTADORA = 120;
export const MAX_GUIA = 200;
export const MAX_MOTIVO_DE_CANCELACION = 500;

export interface ShipmentDetailsInput {
  readonly carrier?: string | null | undefined;
  readonly trackingRef?: string | null | undefined;
  readonly shippingCost?: unknown;
  readonly shippingCurrency?: unknown;
}

export interface ShipmentDetails {
  readonly carrier: string | null;
  readonly trackingRef: string | null;
  readonly shippingCost: string | null;
  readonly shippingCurrency: string | null;
}

const CONTROL = /[\p{Cc}\p{Cf}]/u;

function invalido<T>(field: string, message: string): Result<T> {
  return err({ code: 'VALIDATION_FAILED', message, details: { field } });
}

function textoCorto(value: string | null | undefined, field: string, max: number): Result<string | null> {
  if (value === undefined || value === null) return ok(null);
  if (typeof value !== 'string') return invalido(field, `«${field}» debe ser texto.`);
  const texto = value.trim();
  if (texto === '') return ok(null);
  if (texto.length > max) return invalido(field, `«${field}» no puede superar ${max} caracteres.`);
  if (CONTROL.test(texto)) return invalido(field, `«${field}» contiene caracteres no válidos.`);
  return ok(texto);
}

/**
 * Valida transportadora, guía y costo del envío. El costo es DATO FINANCIERO INTERNO (`finance:read`);
 * costo y moneda van juntos o ninguno; el costo puede ser 0 (envío sin cargo).
 */
export function validarDatosDeEnvio(input: ShipmentDetailsInput): Result<ShipmentDetails> {
  const carrier = textoCorto(input.carrier, 'carrier', MAX_TRANSPORTADORA);
  if (!carrier.ok) return carrier;
  const trackingRef = textoCorto(input.trackingRef, 'trackingRef', MAX_GUIA);
  if (!trackingRef.ok) return trackingRef;

  const sinCosto =
    input.shippingCost === undefined || input.shippingCost === null || input.shippingCost === '';
  const sinMoneda =
    input.shippingCurrency === undefined || input.shippingCurrency === null || input.shippingCurrency === '';
  if (sinCosto && sinMoneda) {
    return ok({
      carrier: carrier.value,
      trackingRef: trackingRef.value,
      shippingCost: null,
      shippingCurrency: null,
    });
  }
  if (sinCosto || sinMoneda) {
    return invalido('shippingCost', 'El costo del envío y su moneda se informan juntos.');
  }
  let costo: string;
  if (input.shippingCost === 0 || input.shippingCost === '0' || input.shippingCost === '0.00') {
    costo = '0.00';
  } else {
    const normal = normalizarMonto(input.shippingCost);
    if (!normal.ok) return invalido('shippingCost', normal.error.message);
    costo = normal.value;
  }
  if (!esMonedaValida(input.shippingCurrency)) {
    return invalido('shippingCurrency', 'La moneda debe ser un código ISO de tres letras mayúsculas.');
  }
  return ok({
    carrier: carrier.value,
    trackingRef: trackingRef.value,
    shippingCost: costo,
    shippingCurrency: input.shippingCurrency,
  });
}

/** Motivo obligatorio al cancelar (la base exige `cancelled ⇔ cancel_reason`). */
export function validarMotivoDeCancelacion(value: unknown): Result<string> {
  if (typeof value !== 'string')
    return invalido('cancelReason', 'El motivo de la cancelación es obligatorio.');
  const texto = value.trim();
  if (texto === '') return invalido('cancelReason', 'El motivo de la cancelación es obligatorio.');
  if (texto.length > MAX_MOTIVO_DE_CANCELACION) {
    return invalido('cancelReason', `El motivo no puede superar ${MAX_MOTIVO_DE_CANCELACION} caracteres.`);
  }
  if (CONTROL.test(texto)) return invalido('cancelReason', 'El motivo contiene caracteres no válidos.');
  return ok(texto);
}

// ─────────────────────────── Ítems ─────────────────────────────────────────────

export interface ShipmentItemInput {
  readonly campaignProductId: string;
  readonly quantity: number;
}

/** Ítems de un envío: ≥ 1, sin productos repetidos, cantidad entera 1..100000. */
export function validarItemsDeEnvio(
  items: readonly ShipmentItemInput[],
): Result<readonly ShipmentItemInput[]> {
  if (items.length === 0) return invalido('items', 'Un envío lleva al menos un producto.');
  const vistos = new Set<string>();
  for (const item of items) {
    if (typeof item.campaignProductId !== 'string' || item.campaignProductId === '') {
      return invalido('items', 'Cada ítem necesita su producto de campaña.');
    }
    if (vistos.has(item.campaignProductId))
      return invalido('items', 'Un producto no se repite en el mismo envío.');
    vistos.add(item.campaignProductId);
    if (!Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > MAX_CANTIDAD_DE_PRODUCTO) {
      return invalido('items', `La cantidad debe ser un entero entre 1 y ${MAX_CANTIDAD_DE_PRODUCTO}.`);
    }
  }
  return ok(items.map((i) => ({ campaignProductId: i.campaignProductId, quantity: i.quantity })));
}

// ─────────────────────────── Preparar el envío ─────────────────────────────────

export interface PreparationContext {
  readonly items: readonly ShipmentItemInput[];
  /** Productos ASIGNADOS a la participación (`campaign_influencer_products`). */
  readonly assignedProductIds: readonly string[];
  /** Modo del acuerdo ACTIVO vigente; `undefined` si no hay acuerdo (solo exige la asignación). */
  readonly agreementMode?: CompensationType | undefined;
  /** Productos COMPROMETIDOS en la versión vigente del acuerdo. */
  readonly committedProductIds?: readonly string[] | undefined;
}

export type PreparationFailure =
  | { readonly reason: 'no_items' }
  | { readonly reason: 'not_assigned'; readonly campaignProductId: string }
  | { readonly reason: 'not_committed'; readonly campaignProductId: string };

/**
 * Espejo de `shipments_preparacion` (029): en la transición a `prepared`, ≥ 1 ítem; cada ítem asignado a la
 * participación y, si el acuerdo vigente es barter o mixed, comprometido en la versión vigente.
 * Lista TODOS los incumplimientos (la UI los muestra juntos).
 */
export function evaluarPreparacionDeEnvio(context: PreparationContext): readonly PreparationFailure[] {
  if (context.items.length === 0) return [{ reason: 'no_items' }];
  const asignados = new Set(context.assignedProductIds);
  const comprometidos = new Set(context.committedProductIds ?? []);
  const exigeCompromiso = context.agreementMode === 'barter' || context.agreementMode === 'mixed';
  const fallos: PreparationFailure[] = [];
  for (const item of context.items) {
    if (!asignados.has(item.campaignProductId)) {
      fallos.push({ reason: 'not_assigned', campaignProductId: item.campaignProductId });
    } else if (exigeCompromiso && !comprometidos.has(item.campaignProductId)) {
      fallos.push({ reason: 'not_committed', campaignProductId: item.campaignProductId });
    }
  }
  return fallos;
}

export function puedePrepararEnvio(context: PreparationContext): boolean {
  return evaluarPreparacionDeEnvio(context).length === 0;
}

// ─────────────────────────── Desasignar producto ───────────────────────────────

export interface UnassignContext {
  /** ¿Está comprometido en la versión vigente de un acuerdo ACTIVO de la participación? */
  readonly committedInCurrentVersion: boolean;
  /** Estados de los envíos de la participación que incluyen el producto. */
  readonly shipmentStatuses: readonly ShipmentStatus[];
}

/**
 * Espejo de la guarda de `campaign_influencer_products` (029): no se desasigna un producto comprometido en
 * la versión vigente ni incluido en un envío abierto (pending | prepared | shipped).
 */
export function puedeDesasignarProducto(context: UnassignContext): Result<true> {
  if (context.committedInCurrentVersion) {
    return err({
      code: 'RESOURCE_CONFLICT',
      message: 'El producto está comprometido en el acuerdo vigente de esta participación: no se desasigna.',
      details: { reason: 'committed' },
    });
  }
  if (context.shipmentStatuses.some(esEnvioAbierto)) {
    return err({
      code: 'RESOURCE_CONFLICT',
      message: 'El producto está en un envío abierto de esta participación: no se desasigna.',
      details: { reason: 'open_shipment' },
    });
  }
  return ok(true);
}
