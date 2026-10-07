/**
 * Eventos operativos (V2 · Fase 8, DEC-049): los hechos append-only que MUEVEN el estado de un envío,
 * un documento de cobro o una obligación de pago.
 *
 * Módulo PURO (sin IO, sin cifrado). La base impone lo mismo en la migración 031: la arista
 * (tipo de evento, estado de origen, estado destino) es la ÚNICA definición de los grafos de estado, y una
 * prueba de paridad ejecuta esta matriz contra `operaciones_arista_valida` en Postgres. Aquí viven la lista
 * cerrada de tipos de evento, qué `to_status` produce cada uno, los hechos que cada tipo exige, las
 * capacidades por rol (espejo de `operaciones_exigir_rol`) y la validación de la solicitud.
 *
 * Principios:
 *   · La IA, el chat y el sistema NUNCA registran estado operativo: `origin` es siempre `ui`.
 *   · `delivered` solo por evento humano (`shipment.delivered`); jamás se infiere de la asignación.
 *   · `note` es interna: no va a auditoría ni al agente (la UI avisa «no escriba datos personales»).
 */

import { type Result, err, ok } from './errors';
import type { Action } from './permissions';
import type { Role } from './types';

// ─────────────────────────── Sujetos y tipos de evento ─────────────────────────

export type OperationalSubjectType = 'shipment' | 'billing_document' | 'payment_obligation';

export const OPERATIONAL_SUBJECT_TYPES: readonly OperationalSubjectType[] = [
  'shipment',
  'billing_document',
  'payment_obligation',
] as const;

/** Lista CERRADA de tipos de evento (la repite el CHECK de `operational_events`). */
export const OPERATIONAL_EVENT_TYPES = [
  'shipment.created',
  'shipment.prepared',
  'shipment.shipped',
  'shipment.delivered',
  'shipment.failed',
  'shipment.returned',
  'shipment.cancelled',
  'billing.registered',
  'billing.validated',
  'billing.rejected',
  'billing.voided',
  'payment.applicability_set',
  'payment.reported',
  'payment.cancelled',
  'payment.correction_noted',
  'evidence.attached',
] as const;

export type OperationalEventType = (typeof OPERATIONAL_EVENT_TYPES)[number];

export function isOperationalEventType(value: unknown): value is OperationalEventType {
  return typeof value === 'string' && (OPERATIONAL_EVENT_TYPES as readonly string[]).includes(value);
}

export function isOperationalSubjectType(value: unknown): value is OperationalSubjectType {
  return typeof value === 'string' && (OPERATIONAL_SUBJECT_TYPES as readonly string[]).includes(value);
}

/** Eventos que NO cambian el estado del sujeto (`to_status` NULL): notas y evidencia. */
export const NOTE_EVENT_TYPES: readonly OperationalEventType[] = [
  'payment.correction_noted',
  'evidence.attached',
] as const;

export function isNoteEventType(eventType: OperationalEventType): boolean {
  return NOTE_EVENT_TYPES.includes(eventType);
}

/**
 * Sujeto al que pertenece un tipo de evento. `evidence.attached` puede colgar de cualquiera:
 * devuelve `undefined`.
 */
export function subjectTypeOfEventType(eventType: OperationalEventType): OperationalSubjectType | undefined {
  if (eventType.startsWith('shipment.')) return 'shipment';
  if (eventType.startsWith('billing.')) return 'billing_document';
  if (eventType.startsWith('payment.')) return 'payment_obligation';
  return undefined;
}

// ─────────────────────────── Aristas (el grafo) ────────────────────────────────

export interface OperationalEventEdge {
  readonly eventType: OperationalEventType;
  /** `null` = evento de creación del sujeto. */
  readonly from: string | null;
  readonly to: string;
}

/**
 * Espejo EXACTO de `operaciones_arista_valida` (migración 031). Las tres máquinas de estado:
 *
 *   shipment            pending → prepared → shipped → delivered; pending|prepared → cancelled;
 *                       shipped → failed | returned; delivered → returned
 *   billing_document    registered → validated | rejected; registered|validated → voided
 *   payment_obligation  not_applicable ↔ pending; pending → reported_paid | cancelled; not_applicable → cancelled
 */
export const OPERATIONAL_EVENT_EDGES: readonly OperationalEventEdge[] = [
  { eventType: 'shipment.created', from: null, to: 'pending' },
  { eventType: 'shipment.prepared', from: 'pending', to: 'prepared' },
  { eventType: 'shipment.shipped', from: 'prepared', to: 'shipped' },
  { eventType: 'shipment.delivered', from: 'shipped', to: 'delivered' },
  { eventType: 'shipment.failed', from: 'shipped', to: 'failed' },
  { eventType: 'shipment.returned', from: 'shipped', to: 'returned' },
  { eventType: 'shipment.returned', from: 'delivered', to: 'returned' },
  { eventType: 'shipment.cancelled', from: 'pending', to: 'cancelled' },
  { eventType: 'shipment.cancelled', from: 'prepared', to: 'cancelled' },
  { eventType: 'billing.registered', from: null, to: 'registered' },
  { eventType: 'billing.validated', from: 'registered', to: 'validated' },
  { eventType: 'billing.rejected', from: 'registered', to: 'rejected' },
  { eventType: 'billing.voided', from: 'registered', to: 'voided' },
  { eventType: 'billing.voided', from: 'validated', to: 'voided' },
  { eventType: 'payment.applicability_set', from: null, to: 'not_applicable' },
  { eventType: 'payment.applicability_set', from: null, to: 'pending' },
  { eventType: 'payment.applicability_set', from: 'not_applicable', to: 'pending' },
  { eventType: 'payment.applicability_set', from: 'pending', to: 'not_applicable' },
  { eventType: 'payment.reported', from: 'pending', to: 'reported_paid' },
  { eventType: 'payment.cancelled', from: 'pending', to: 'cancelled' },
  { eventType: 'payment.cancelled', from: 'not_applicable', to: 'cancelled' },
] as const;

/** ¿Existe la arista (tipo de evento, origen, destino)? `from = null` es la creación. */
export function isValidOperationalEdge(
  eventType: OperationalEventType,
  from: string | null,
  to: string,
): boolean {
  return OPERATIONAL_EVENT_EDGES.some((e) => e.eventType === eventType && e.from === from && e.to === to);
}

/** `to_status` que puede producir un tipo de evento (vacío para las notas). */
export function statusesProducedBy(eventType: OperationalEventType): readonly string[] {
  return [...new Set(OPERATIONAL_EVENT_EDGES.filter((e) => e.eventType === eventType).map((e) => e.to))];
}

/** ¿Es el evento que CREA al sujeto (primer evento, sin estado de origen)? */
export function isCreationEventType(eventType: OperationalEventType): boolean {
  return OPERATIONAL_EVENT_EDGES.some((e) => e.eventType === eventType && e.from === null);
}

/** Evento de creación de cada sujeto (el que lleva `row_seq` de 0 a 1). */
export const CREATION_EVENT_TYPE: Readonly<Record<OperationalSubjectType, OperationalEventType>> = {
  shipment: 'shipment.created',
  billing_document: 'billing.registered',
  payment_obligation: 'payment.applicability_set',
};

/** Tipos de evento que producen la transición `from → to` de un sujeto (normalmente uno). */
export function eventTypesForTransition(
  subject: OperationalSubjectType,
  from: string | null,
  to: string,
): readonly OperationalEventType[] {
  return [
    ...new Set(
      OPERATIONAL_EVENT_EDGES.filter(
        (e) => subjectTypeOfEventType(e.eventType) === subject && e.from === from && e.to === to,
      ).map((e) => e.eventType),
    ),
  ];
}

/** Estados desde los que se puede salir (o nacer, con `null`) hacia `to`, para un sujeto. */
export function statusesOf(subject: OperationalSubjectType): readonly string[] {
  const todos = OPERATIONAL_EVENT_EDGES.filter(
    (e) => subjectTypeOfEventType(e.eventType) === subject,
  ).flatMap((e) => (e.from === null ? [e.to] : [e.from, e.to]));
  return [...new Set(todos)];
}

/** Estados con los que NACE un sujeto. */
export function initialStatusesOf(subject: OperationalSubjectType): readonly string[] {
  return [
    ...new Set(
      OPERATIONAL_EVENT_EDGES.filter(
        (e) => subjectTypeOfEventType(e.eventType) === subject && e.from === null,
      ).map((e) => e.to),
    ),
  ];
}

/** Transición de estado válida de un sujeto, sin importar qué tipo de evento la produzca. */
export function canTransitionOperationalSubject(
  subject: OperationalSubjectType,
  from: string,
  to: string,
): boolean {
  return eventTypesForTransition(subject, from, to).length > 0;
}

// ─────────────────────────── Capacidades y roles ───────────────────────────────

/** Capacidades de la base (`operaciones_exigir_rol`, migración 027). */
export type OperationsCapability = 'manage_ops' | 'report_payment' | 'pii' | 'kpi_target' | 'kpi_measure';

/**
 * Listas CERRADAS por capacidad. Espejo de `operaciones_exigir_rol`: una prueba de paridad las compara con
 * `roleCan` del dominio y con la base. Un rol nuevo no obtiene acceso por omisión.
 */
export const OPERATIONS_CAPABILITY_ROLES: Readonly<Record<OperationsCapability, readonly Role[]>> = {
  manage_ops: ['admin', 'director', 'operativo'],
  report_payment: ['admin', 'operativo'],
  pii: ['admin', 'operativo'],
  kpi_target: ['admin', 'director', 'consultor'],
  kpi_measure: ['admin', 'director', 'operativo'],
};

/** Acciones de `permissions.ts` que cada capacidad de la base espeja. */
export const OPERATIONS_CAPABILITY_ACTIONS: Readonly<Record<OperationsCapability, readonly Action[]>> = {
  manage_ops: ['agreement:manage', 'shipment:manage', 'billing:manage', 'ops_evidence:attach'],
  report_payment: ['payment:report'],
  pii: ['pii:read', 'pii:manage'],
  kpi_target: ['kpi:target_manage'],
  kpi_measure: ['kpi:measure'],
};

/** Capacidad que exige registrar un tipo de evento: reportar un pago ⇒ `report_payment`; el resto, `manage_ops`. */
export function capabilityForEventType(eventType: OperationalEventType): 'manage_ops' | 'report_payment' {
  return eventType === 'payment.reported' ? 'report_payment' : 'manage_ops';
}

export function roleMayRecordEvent(role: Role, eventType: OperationalEventType): boolean {
  return OPERATIONS_CAPABILITY_ROLES[capabilityForEventType(eventType)].includes(role);
}

/**
 * Capacidad de LECTURA de la evidencia de un sujeto: el envío se lee con `shipment:read`; el documento de
 * cobro y la obligación de pago (evidencia financiera) con `finance:read`.
 */
export function readActionForSubject(subject: OperationalSubjectType): Action {
  return subject === 'shipment' ? 'shipment:read' : 'finance:read';
}

/**
 * Capacidad de GESTIÓN del sujeto: el envío se gestiona con `shipment:manage`; el documento de cobro y la
 * obligación de pago con `billing:manage`. Quien retira evidencia de un sujeto necesita la de su sujeto.
 */
export function manageActionForSubject(subject: OperationalSubjectType): Action {
  return subject === 'shipment' ? 'shipment:manage' : 'billing:manage';
}

// ─────────────────────────── Evidencia ─────────────────────────────────────────

export const EVIDENCE_KINDS = [
  'guia',
  'cotizacion',
  'orden_compra',
  'cuenta_cobro',
  'comprobante',
  'soporte',
  'otro',
] as const;

export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];

export function isEvidenceKind(value: unknown): value is EvidenceKind {
  return typeof value === 'string' && (EVIDENCE_KINDS as readonly string[]).includes(value);
}

// ─────────────────────────── Hechos que exige cada evento ──────────────────────

/** Eventos que exigen la fecha del hecho (`happened_on`): envío, entrega y fecha de pago. */
export const EVENT_TYPES_REQUIRING_DATE: readonly OperationalEventType[] = [
  'shipment.shipped',
  'shipment.delivered',
  'payment.reported',
] as const;

/** Eventos que exigen una referencia externa (el pago reportado: comprobante, transferencia, etc.). */
export const EVENT_TYPES_REQUIRING_REFERENCE: readonly OperationalEventType[] = ['payment.reported'] as const;

// ─────────────────────────── Validación de la solicitud ────────────────────────

export const MAX_EVENT_NOTE_LENGTH = 2000;
export const MAX_EVENT_REFERENCE_LENGTH = 200;
export const MAX_IDEMPOTENCY_KEY_LENGTH = 200;

/** Aviso estándar que la UI muestra junto a toda nota. */
export const NOTE_PII_WARNING = 'No escriba datos personales (cédula, teléfono, dirección) en las notas.';

export interface OperationalEventRequest {
  readonly eventType: string;
  readonly subjectType: string;
  /** Estado vigente del sujeto (`null`/`undefined` solo para el evento de creación). */
  readonly fromStatus?: string | null | undefined;
  /** Estado destino; omitido para las notas. */
  readonly toStatus?: string | null | undefined;
  readonly idempotencyKey: string;
  /** Canal de la solicitud. Solo `ui` registra estado operativo. */
  readonly origin?: string | undefined;
  readonly externalReference?: string | null | undefined;
  /** Fecha del hecho `YYYY-MM-DD`. */
  readonly happenedOn?: string | null | undefined;
  readonly note?: string | null | undefined;
}

export interface ValidatedOperationalEvent {
  readonly eventType: OperationalEventType;
  readonly subjectType: OperationalSubjectType;
  readonly fromStatus: string | null;
  readonly toStatus: string | null;
  readonly idempotencyKey: string;
  readonly externalReference: string | null;
  readonly happenedOn: string | null;
  readonly note: string | null;
}

function invalid<T>(field: string, message: string): Result<T> {
  return err({ code: 'VALIDATION_FAILED', message, details: { field } });
}

/**
 * Rango de fechas `YYYY-MM-DD` aceptado: dentro de lo que `date` de Postgres guarda sin error (el año 0000 no
 * existe allí) y de lo que tiene sentido para un hecho operativo. Un valor fuera de rango es una validación
 * fallida, nunca un 500 de la base.
 */
export const FECHA_ISO_MINIMA = '1900-01-01';
export const FECHA_ISO_MAXIMA = '9999-12-31';

/** `YYYY-MM-DD` que es un día real del calendario y está dentro de `FECHA_ISO_MINIMA..FECHA_ISO_MAXIMA`. */
export function isIsoDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  if (value < FECHA_ISO_MINIMA || value > FECHA_ISO_MAXIMA) return false;
  const fecha = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(fecha.getTime()) && fecha.toISOString().slice(0, 10) === value;
}

const CONTROL = /[\p{Cc}\p{Cf}]/u;

/**
 * ¿El texto lleva caracteres de control (NUL incluido), invisibles o de dirección bidi (`\p{Cc}` y `\p{Cf}`:
 * U+0000, U+200B, U+202E…)? Con `multilinea`, el salto de línea, el retorno y el tabulador se toleran.
 * Criterio ÚNICO del dominio para texto libre de la operación (la web aplica el mismo).
 */
export function tieneCaracteresNoValidos(texto: string, multilinea = false): boolean {
  return CONTROL.test(multilinea ? texto.replace(/[\n\r\t]/gu, ' ') : texto);
}

/**
 * Clave de idempotencia válida: texto sin espacios en los extremos, de 1 a `MAX_IDEMPOTENCY_KEY_LENGTH`
 * caracteres, sin control ni invisibles/bidi (una clave con U+202E parecería otra en pantalla).
 */
export function esClaveDeIdempotenciaValida(clave: unknown): clave is string {
  return (
    typeof clave === 'string' &&
    clave === clave.trim() &&
    clave !== '' &&
    clave.length <= MAX_IDEMPOTENCY_KEY_LENGTH &&
    !tieneCaracteresNoValidos(clave)
  );
}

function textoOpcional(
  value: string | null | undefined,
  field: string,
  max: number,
  multiline: boolean,
): Result<string | null> {
  if (value === undefined || value === null) return ok(null);
  if (typeof value !== 'string') return invalid(field, `«${field}» debe ser texto.`);
  const texto = value.trim();
  if (texto === '') return ok(null);
  if (texto.length > max) return invalid(field, `«${field}» no puede superar ${max} caracteres.`);
  const sinSaltos = multiline ? texto.replace(/[\n\r\t]/gu, ' ') : texto;
  if (CONTROL.test(sinSaltos)) return invalid(field, `«${field}» contiene caracteres no válidos.`);
  return ok(texto);
}

/**
 * Valida una solicitud de evento ANTES de tocar la base (la base repite estas reglas). Pura: `now` se
 * inyecta para comparar la fecha del hecho (no puede estar en el futuro; se tolera +1 día por zona horaria,
 * igual que la base).
 */
export function validateOperationalEventRequest(
  request: OperationalEventRequest,
  now: Date,
): Result<ValidatedOperationalEvent> {
  if (request.origin !== undefined && request.origin !== 'ui') {
    return err({
      code: 'FORBIDDEN_ROLE',
      message:
        'Solo una persona, por la interfaz, registra estado operativo (la IA, el chat y el sistema no).',
      details: { field: 'origin' },
    });
  }
  if (!isOperationalEventType(request.eventType)) {
    return invalid('eventType', 'Tipo de evento operativo no reconocido.');
  }
  if (!isOperationalSubjectType(request.subjectType)) {
    return invalid('subjectType', 'Tipo de sujeto operativo no reconocido.');
  }
  const eventType = request.eventType;
  const subjectType = request.subjectType;
  const propio = subjectTypeOfEventType(eventType);
  if (propio !== undefined && propio !== subjectType) {
    return invalid('subjectType', `El evento ${eventType} no corresponde a un sujeto ${subjectType}.`);
  }

  const key = typeof request.idempotencyKey === 'string' ? request.idempotencyKey : '';
  if (!esClaveDeIdempotenciaValida(key)) {
    return invalid(
      'idempotencyKey',
      'La clave de idempotencia es obligatoria (hasta 200 caracteres, sin espacios en los extremos).',
    );
  }

  const fromStatus = request.fromStatus ?? null;
  const toStatus = request.toStatus ?? null;
  if (isNoteEventType(eventType)) {
    if (toStatus !== null || fromStatus !== null) {
      return invalid(
        'toStatus',
        `El evento ${eventType} no cambia el estado: no lleva estado de origen ni destino.`,
      );
    }
  } else {
    if (toStatus === null) return invalid('toStatus', `El evento ${eventType} exige el estado destino.`);
    if (!isValidOperationalEdge(eventType, fromStatus, toStatus)) {
      return err({
        code: 'RESOURCE_CONFLICT',
        message: `Transición no válida: ${fromStatus ?? '(creación)'} → ${toStatus} con el evento ${eventType}.`,
        details: { reason: 'invalid_transition', eventType, from: fromStatus, to: toStatus },
      });
    }
  }

  const reference = textoOpcional(
    request.externalReference,
    'externalReference',
    MAX_EVENT_REFERENCE_LENGTH,
    false,
  );
  if (!reference.ok) return reference;
  const note = textoOpcional(request.note, 'note', MAX_EVENT_NOTE_LENGTH, true);
  if (!note.ok) return note;

  let happenedOn: string | null = null;
  if (request.happenedOn !== undefined && request.happenedOn !== null) {
    if (!isIsoDate(request.happenedOn))
      return invalid('happenedOn', 'La fecha del hecho debe ser YYYY-MM-DD.');
    const limite = new Date(now.getTime());
    limite.setUTCDate(limite.getUTCDate() + 1);
    if (request.happenedOn > limite.toISOString().slice(0, 10)) {
      return invalid('happenedOn', 'La fecha del hecho no puede estar en el futuro.');
    }
    happenedOn = request.happenedOn;
  }
  if (EVENT_TYPES_REQUIRING_DATE.includes(eventType) && happenedOn === null) {
    return invalid('happenedOn', `El evento ${eventType} exige la fecha del hecho.`);
  }
  if (EVENT_TYPES_REQUIRING_REFERENCE.includes(eventType) && reference.value === null) {
    return invalid('externalReference', `El evento ${eventType} exige la referencia externa.`);
  }

  return ok({
    eventType,
    subjectType,
    fromStatus,
    toStatus,
    idempotencyKey: key,
    externalReference: reference.value,
    happenedOn,
    note: note.value,
  });
}

// ─────────────────────────── Idempotencia y concurrencia ───────────────────────

export type IdempotencyOutcome = 'new' | 'replay' | 'conflict';

/**
 * Resultado de buscar un evento previo con la misma clave: ninguno ⇒ `new`; misma huella ⇒ `replay`
 * (se devuelve el MISMO evento); otra huella ⇒ `conflict`.
 */
export function classifyIdempotency(
  existing: { readonly requestHash: string } | undefined,
  requestHash: string,
): IdempotencyOutcome {
  if (existing === undefined) return 'new';
  return existing.requestHash === requestHash ? 'replay' : 'conflict';
}

/** Control optimista: `expected_seq` debe ser el `row_seq` vigente del sujeto. */
export function isStaleTransition(expectedSeq: number, currentSeq: number): boolean {
  return expectedSeq !== currentSeq;
}
