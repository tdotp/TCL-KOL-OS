/**
 * Autorización y aislamiento entre organizaciones.
 *
 * Implementa `docs/product/D0-07-matriz-roles-permisos.md` y la regla de
 * separación de la sección 3.4 del documento maestro.
 *
 * Criterio de aceptación de la Épica E2:
 *   "ningún usuario puede consultar IDs de otra organización aunque manipule
 *    URL o API".
 */

import type { ResourceScope, Role, User } from './types';
import { type Result, err, ok } from './errors';

/** Acciones sobre recursos del dominio. */
export type Action =
  | 'campaign:create'
  | 'campaign:read'
  | 'campaign:update'
  | 'campaign:archive'
  | 'source:upload'
  | 'source:read'
  | 'source:process'
  | 'brief:read'
  | 'brief:edit'
  | 'brief:request_review'
  | 'brief:approve_internal'
  | 'brief:translate'
  | 'brief:export'
  | 'question:answer'
  // Sprint 4 (cierre): E6 y E7 completas necesitan distinguir cada acción de
  // escritura sobre el brief — antes solo existía `brief:edit` genérico.
  | 'question:create'
  | 'question:discard'
  | 'field:confirm'
  | 'field:correct'
  // E7-8: declarar (o revertir) una excepción por producto en un campo
  // `compartido_con_excepcion` (DEC-016) es una acción propia — crea una fila
  // nueva anclada a un producto, no una corrección sobre la fila compartida.
  | 'field:declare_exception'
  | 'brief:manual_create'
  | 'brief:transition'
  | 'glossary:propose'
  | 'glossary:approve'
  | 'comment:internal'
  | 'comment:client_visible'
  | 'audit:read'
  | 'airun:read'
  | 'admin:users'
  | 'admin:integrations'
  | 'admin:ai_flag';

const PERMISSIONS: Readonly<Record<Role, readonly Action[]>> = {
  admin: [
    'campaign:create',
    'campaign:read',
    'campaign:update',
    'campaign:archive',
    'source:upload',
    'source:read',
    'source:process',
    'brief:read',
    'brief:edit',
    'brief:request_review',
    'brief:approve_internal',
    'brief:translate',
    'brief:export',
    'question:answer',
    'question:create',
    'question:discard',
    'field:confirm',
    'field:correct',
    'field:declare_exception',
    'brief:manual_create',
    'brief:transition',
    'glossary:propose',
    'glossary:approve',
    'comment:internal',
    'comment:client_visible',
    'audit:read',
    'airun:read',
    'admin:users',
    'admin:integrations',
    'admin:ai_flag',
  ],
  director: [
    'campaign:create',
    'campaign:read',
    'campaign:update',
    'campaign:archive',
    'source:upload',
    'source:read',
    'source:process',
    'brief:read',
    'brief:edit',
    'brief:request_review',
    'brief:approve_internal',
    'brief:translate',
    'brief:export',
    'question:answer',
    'question:create',
    'question:discard',
    'field:confirm',
    'field:correct',
    'field:declare_exception',
    'brief:manual_create',
    'brief:transition',
    'glossary:propose',
    'glossary:approve',
    'comment:internal',
    'comment:client_visible',
    'audit:read',
    'airun:read',
  ],
  consultor: [
    'campaign:create',
    'campaign:read',
    'campaign:update',
    'source:upload',
    'source:read',
    'source:process',
    'brief:read',
    'brief:edit',
    'brief:request_review',
    // No puede aprobar internamente: esa es la separación de responsabilidades
    // que hace que la revisión signifique algo (D0-07 §2).
    'brief:translate',
    'brief:export',
    'question:answer',
    'question:create',
    'question:discard',
    'field:confirm',
    'field:correct',
    'field:declare_exception',
    'brief:manual_create',
    'brief:transition',
    'glossary:propose',
    'comment:internal',
    'comment:client_visible',
  ],
  analista: [
    'campaign:read',
    'source:read',
    'brief:read',
    'brief:export',
    'comment:internal',
    'audit:read',
    'airun:read',
  ],
  legal: ['campaign:read', 'source:read', 'brief:read', 'question:answer', 'comment:internal', 'audit:read'],
  // El cliente TCL es de solo lectura: consulta lo que ya tiene visible y
  // descarga el entregable (DEC-012 / ADR-004). No aprueba, no pide cambios y
  // no mueve ningún estado — esas decisiones son de SmartPR (corrección del
  // workflow cliente, `docs/product/CLIENT_WORKFLOW_CORRECTION.md`).
  cliente: ['campaign:read', 'brief:read', 'brief:export'],
};

/** ¿El rol tiene la capacidad, con independencia del recurso concreto? */
export function roleCan(role: Role, action: Action): boolean {
  return PERMISSIONS[role].includes(action);
}

/** Acciones disponibles para un rol. Útil para construir la interfaz. */
export function actionsFor(role: Role): readonly Action[] {
  return PERMISSIONS[role];
}

/**
 * ¿El usuario puede ver este recurso?
 *
 * Dos condiciones, en este orden:
 *  1. Misma organización que el recurso, salvo que sea visible para el cliente.
 *  2. El rol `cliente` nunca ve recursos con visibilidad `interna`.
 */
export function canAccessResource(user: User, scope: ResourceScope): boolean {
  if (user.status !== 'activo') return false;

  const sameOrg = user.organizationId === scope.organizationId;

  if (user.role === 'cliente') {
    // El cliente pertenece a otra organización por definición: accede solo a lo
    // que se le compartió explícitamente, y nunca a material interno.
    return scope.visibility === 'tcl' || scope.visibility === 'compartida';
  }

  if (!sameOrg) return false;

  // El rol legal accede solo a lo que su función requiere; el contenido
  // confidencial exige una asignación explícita que se resolverá en MVP 3.
  if (user.role === 'legal' && scope.confidentialityLevel === 'confidencial') return false;

  return true;
}

/**
 * Autoriza una acción sobre un recurso concreto.
 *
 * Devuelve `RESOURCE_NOT_FOUND` —no `FORBIDDEN_ROLE`— cuando el recurso es de
 * otra organización: revelar que existe ya sería una filtración (caso S-01).
 */
export function authorize(user: User, action: Action, scope: ResourceScope): Result<true> {
  if (!canAccessResource(user, scope)) {
    return err({
      code: 'RESOURCE_NOT_FOUND',
      message: 'El recurso no existe o no está disponible.',
      details: {},
    });
  }

  if (!roleCan(user.role, action)) {
    return err({
      code: 'FORBIDDEN_ROLE',
      message: `El rol ${user.role} no puede ejecutar la acción ${action}.`,
      details: { action, role: user.role },
    });
  }

  return ok(true);
}
