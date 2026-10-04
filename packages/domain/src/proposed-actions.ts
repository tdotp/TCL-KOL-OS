/**
 * Acciones propuestas — contrato human-in-the-loop (V2 · Fase 1D).
 *
 * La IA puede detectar una intención, analizar y preparar una acción; no puede
 * ejecutar una decisión crítica. El flujo es:
 *
 *   intención → acción propuesta → control visible → confirmación humana → ejecución
 *
 * Este módulo es la política pura (sin base de datos): quién puede proponer,
 * quién puede confirmar, qué estados admiten qué. `packages/db` la aplica y
 * garantiza la ejecución única.
 */

import type { Action } from './permissions';
import { roleCan } from './permissions';
import type { AuditCorrelation, AuditOrigin, User } from './types';
import { type DomainErrorPayload, type Result, err, ok } from './errors';

export type ProposedActionStatus = 'pending' | 'confirmed' | 'executed' | 'cancelled' | 'expired';

export type ProposedActionType = 'brief.approve';

export interface ProposedActionSpec {
  readonly type: ProposedActionType;
  readonly resourceType: 'brief_version';
  /** Capacidad que debe tener quien PROPONE (una persona o el agente en su nombre). */
  readonly proposeCapability: Action;
  /** Capacidad que debe tener la PERSONA que confirma y ejecuta. */
  readonly confirmCapability: Action;
}

export const PROPOSED_ACTION_SPECS: Readonly<Record<ProposedActionType, ProposedActionSpec>> = {
  'brief.approve': {
    type: 'brief.approve',
    resourceType: 'brief_version',
    proposeCapability: 'brief:request_review',
    confirmCapability: 'brief:approve_internal',
  },
};

export function specDeAccion(type: string): ProposedActionSpec | undefined {
  return (PROPOSED_ACTION_SPECS as Record<string, ProposedActionSpec | undefined>)[type];
}

export interface ProposedAction {
  readonly id: string;
  readonly organizationId: string;
  readonly campaignId: string;
  readonly type: ProposedActionType;
  readonly resourceType: string;
  readonly resourceId: string;
  readonly payload: Readonly<Record<string, unknown>>;
  /** Huella de tipo + recurso + payload: liga la confirmación a la propuesta original. */
  readonly payloadHash: string;
  readonly status: ProposedActionStatus;
  /** `null` cuando la propuso el sistema (worker) sin una persona. */
  readonly proposedBy: string | null;
  readonly proposedOrigin: AuditOrigin;
  readonly correlation?: AuditCorrelation | undefined;
  /** Si está definido, solo esta persona puede confirmar. */
  readonly assignedTo?: string | undefined;
  readonly confirmedBy?: string | undefined;
  readonly confirmedAt?: string | undefined;
  readonly executedAt?: string | undefined;
  readonly cancelledBy?: string | undefined;
  readonly cancelledAt?: string | undefined;
  readonly expiresAt: string;
  readonly createdAt: string;
}

const NO_ENCONTRADO: DomainErrorPayload = {
  code: 'RESOURCE_NOT_FOUND',
  message: 'El recurso no existe o no está disponible.',
};

/**
 * ¿Puede este actor proponer? Una persona necesita la capacidad; el sistema
 * puede proponer (el agente prepara), pero nunca confirma. Cliente y Operativo
 * no tienen la capacidad.
 */
export function puedeProponer(actor: User | 'system', spec: ProposedActionSpec): Result<true> {
  if (actor === 'system') return ok(true);
  if (actor.status !== 'activo') {
    return err({ code: 'FORBIDDEN_ROLE', message: 'El usuario no está activo.' });
  }
  if (!roleCan(actor.role, spec.proposeCapability)) {
    return err({
      code: 'FORBIDDEN_ROLE',
      message: `El rol ${actor.role} no puede proponer la acción ${spec.type}.`,
      details: { action: spec.proposeCapability, role: actor.role },
    });
  }
  return ok(true);
}

function vencida(accion: ProposedAction, ahora: Date): boolean {
  return new Date(accion.expiresAt).getTime() <= ahora.getTime();
}

function verificarHumanoConCapacidad(
  actor: User | 'system',
  canal: AuditOrigin,
  accion: ProposedAction,
): Result<User> {
  if (actor === 'system' || canal !== 'ui') {
    return err({
      code: 'HUMAN_CONFIRMATION_REQUIRED',
      message:
        'Una acción crítica solo la confirma una persona desde la interfaz, nunca el sistema ni el chat.',
      details: { canal: actor === 'system' ? 'system' : canal },
    });
  }
  if (actor.status !== 'activo') {
    return err({ code: 'FORBIDDEN_ROLE', message: 'El usuario no está activo.' });
  }
  const spec = specDeAccion(accion.type);
  if (spec === undefined) return err(NO_ENCONTRADO);
  if (actor.organizationId !== accion.organizationId) return err(NO_ENCONTRADO);
  if (!roleCan(actor.role, spec.confirmCapability)) {
    return err({
      code: 'FORBIDDEN_ROLE',
      message: `El rol ${actor.role} no puede confirmar la acción ${accion.type}.`,
      details: { action: spec.confirmCapability, role: actor.role },
    });
  }
  return ok(actor);
}

/** Reglas para pasar de `pending` a `confirmed`. */
export function puedeConfirmar(
  actor: User | 'system',
  canal: AuditOrigin,
  accion: ProposedAction,
  ahora: Date,
): Result<User> {
  const humano = verificarHumanoConCapacidad(actor, canal, accion);
  if (!humano.ok) return humano;
  if (accion.status !== 'pending') {
    return err({
      code: 'PROPOSAL_INVALID_STATE',
      message: `La acción está ${accion.status}; solo una acción pendiente se confirma.`,
      details: { status: accion.status },
    });
  }
  if (vencida(accion, ahora)) {
    return err({ code: 'PROPOSAL_EXPIRED', message: 'La acción propuesta venció.' });
  }
  if (accion.assignedTo !== undefined && accion.assignedTo !== humano.value.id) {
    return err({
      code: 'FORBIDDEN_ROLE',
      message: 'La acción fue asignada a otra persona para su confirmación.',
    });
  }
  return humano;
}

/** Reglas para pasar de `confirmed` a `executed`: la misma persona, con el permiso vigente. */
export function puedeEjecutar(
  actor: User | 'system',
  canal: AuditOrigin,
  accion: ProposedAction,
  ahora: Date,
): Result<User> {
  const humano = verificarHumanoConCapacidad(actor, canal, accion);
  if (!humano.ok) return humano;
  if (accion.status !== 'confirmed') {
    return err({
      code: 'PROPOSAL_INVALID_STATE',
      message: `La acción está ${accion.status}; solo una acción confirmada se ejecuta (y una sola vez).`,
      details: { status: accion.status },
    });
  }
  if (accion.confirmedBy !== humano.value.id) {
    return err({
      code: 'HUMAN_CONFIRMATION_REQUIRED',
      message: 'Solo la persona que confirmó la acción puede ejecutarla.',
    });
  }
  if (vencida(accion, ahora)) {
    return err({ code: 'PROPOSAL_EXPIRED', message: 'La acción confirmada venció antes de ejecutarse.' });
  }
  return humano;
}

/** ¿Puede cancelar? Quien la propuso o cualquier persona con capacidad de confirmar. */
export function puedeCancelar(actor: User, accion: ProposedAction): Result<true> {
  if (actor.status !== 'activo' || actor.organizationId !== accion.organizationId) return err(NO_ENCONTRADO);
  const spec = specDeAccion(accion.type);
  if (spec === undefined) return err(NO_ENCONTRADO);
  const esProponente = accion.proposedBy === actor.id;
  if (!esProponente && !roleCan(actor.role, spec.confirmCapability)) {
    return err({
      code: 'FORBIDDEN_ROLE',
      message: `El rol ${actor.role} no puede cancelar la acción ${accion.type}.`,
    });
  }
  if (accion.status !== 'pending' && accion.status !== 'confirmed') {
    return err({
      code: 'PROPOSAL_INVALID_STATE',
      message: `La acción está ${accion.status} y ya no se puede cancelar.`,
      details: { status: accion.status },
    });
  }
  return ok(true);
}
