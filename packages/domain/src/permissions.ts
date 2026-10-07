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

import type { ResourceScope, Role, User, Visibility } from './types';
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
  // V2 · Fase 1A: lectura de las fuentes que SmartPR marcó como visibles para
  // TCL. Es distinta de `source:read` (todo lo de la organización): el cliente
  // nunca recibe `source:read`.
  | 'source:read_shared'
  // Decidir qué fuentes ve TCL. Es una decisión de SmartPR, no del cliente.
  | 'source:set_visibility'
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
  // V2 · Fase 3: identidad del influencer y su participación en una campaña.
  // Son lecturas/gestión INTERNAS de SmartPR; el cliente no recibe ninguna (su
  // dashboard tendrá una proyección propia, no estas lecturas).
  | 'influencer:read'
  | 'influencer:manage'
  | 'campaign_influencer:read'
  | 'campaign_influencer:manage'
  // V2 · Fase 7: contenido. `deliverable:read` ve las piezas y su ESTADO (el
  // Operativo lo recibe, con una proyección sin contenido); el resto es interno
  // de Cuenta. `script:approve` solo admin/director (mismo criterio que
  // `brief:approve_internal`, DEC-042); el consultor prepara y propone con
  // `script:manage`. El cliente TCL no recibe nada hasta la Fase 9.
  | 'deliverable:read'
  | 'deliverable:manage'
  | 'script:read'
  | 'script:manage'
  | 'script:approve'
  // V2 · Fase 8: operación y KPIs (DEC-049). Capacidades SEPARADAS de las
  // creativas: el Operativo ejecuta y registra; Cuenta consulta el estado sin
  // dinero ni datos personales; TCL no recibe nada hasta la Fase 9.
  // `finance:read` (fee, costos, facturas, pagos) y `pii:read` (dirección,
  // cédula, teléfono) son lecturas aparte: `shipment:manage` NO implica `pii:read`.
  // `payment:report` REGISTRA que una persona/entidad externa reportó un pago;
  // este sistema no ejecuta pagos (DEC-014).
  | 'operations:read'
  | 'agreement:read'
  | 'agreement:manage'
  | 'finance:read'
  | 'shipment:read'
  | 'shipment:manage'
  | 'billing:manage'
  | 'payment:report'
  | 'pii:read'
  | 'pii:manage'
  | 'ops_evidence:attach'
  | 'kpi:read'
  | 'kpi:target_manage'
  | 'kpi:measure'
  | 'glossary:propose'
  | 'glossary:approve'
  | 'comment:internal'
  | 'comment:client_visible'
  | 'audit:read'
  | 'airun:read'
  // V2 · Fase 6 (D4): el chat del agente es de Cuenta. `chat:read` lista y lee las
  // conversaciones PROPIAS (owner-scoped); `chat:write` las crea/archiva, publica
  // mensajes y cancela/reintenta runs. Las tools del agente NO tienen permisos de
  // chat propios: cada caso de uso exige la capacidad de la persona.
  | 'chat:read'
  | 'chat:write'
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
    'source:set_visibility',
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
    'influencer:read',
    'influencer:manage',
    'campaign_influencer:read',
    'campaign_influencer:manage',
    'deliverable:read',
    'deliverable:manage',
    'script:read',
    'script:manage',
    'script:approve',
    'glossary:propose',
    'glossary:approve',
    'comment:internal',
    'comment:client_visible',
    'audit:read',
    'airun:read',
    'chat:read',
    'chat:write',
    'operations:read',
    'agreement:read',
    'agreement:manage',
    'finance:read',
    'shipment:read',
    'shipment:manage',
    'billing:manage',
    'payment:report',
    'pii:read',
    'pii:manage',
    'ops_evidence:attach',
    'kpi:read',
    'kpi:target_manage',
    'kpi:measure',
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
    'source:set_visibility',
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
    'influencer:read',
    'influencer:manage',
    'campaign_influencer:read',
    'campaign_influencer:manage',
    'deliverable:read',
    'deliverable:manage',
    'script:read',
    'script:manage',
    'script:approve',
    'glossary:propose',
    'glossary:approve',
    'comment:internal',
    'comment:client_visible',
    'audit:read',
    'airun:read',
    'chat:read',
    'chat:write',
    'operations:read',
    'agreement:read',
    'agreement:manage',
    'finance:read',
    'shipment:read',
    'shipment:manage',
    'billing:manage',
    'ops_evidence:attach',
    'kpi:read',
    'kpi:target_manage',
    'kpi:measure',
  ],
  consultor: [
    'campaign:create',
    'campaign:read',
    'campaign:update',
    'source:upload',
    'source:read',
    'source:process',
    'source:set_visibility',
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
    'influencer:read',
    'influencer:manage',
    'campaign_influencer:read',
    'campaign_influencer:manage',
    'deliverable:read',
    'deliverable:manage',
    'script:read',
    'script:manage',
    'glossary:propose',
    'comment:internal',
    'comment:client_visible',
    'chat:read',
    'chat:write',
    'operations:read',
    'agreement:read',
    'shipment:read',
    'kpi:read',
    'kpi:target_manage',
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
  // Usuario Operativo (V2 · Fase 1B). Solo entra y consulta el contexto del
  // proyecto: campaña, fuentes internas y brief. NO aprueba, no transiciona ni
  // edita el brief, no tiene permisos administrativos y no es cliente. Las
  // capacidades operativas y financieras (acuerdos, envíos, pagos, KPIs) se
  // añadirán —separadas de las creativas— cuando existan esas entidades.
  // Fase 3: además LEE los influencers y su participación en la campaña (con
  // los productos asignados); no gestiona la identidad ni la participación.
  operativo: [
    'campaign:read',
    'source:read',
    'brief:read',
    'influencer:read',
    'campaign_influencer:read',
    // Fase 7: ve las piezas y su estado (proyección sin contenido ni revisión).
    'deliverable:read',
    // Fase 8: opera y registra (acuerdos, logística, facturación/pagos como
    // SEGUIMIENTO, KPIs reales). Nada creativo: ni script:*, ni brief:*, ni chat:*.
    'operations:read',
    'agreement:read',
    'agreement:manage',
    'finance:read',
    'shipment:read',
    'shipment:manage',
    'billing:manage',
    'payment:report',
    'pii:read',
    'pii:manage',
    'ops_evidence:attach',
    'kpi:read',
    'kpi:measure',
  ],
  // El cliente TCL es de solo lectura: consulta lo que ya tiene visible y
  // descarga el entregable (DEC-012 / ADR-004). No aprueba, no pide cambios y
  // no mueve ningún estado — esas decisiones son de SmartPR (corrección del
  // workflow cliente, `docs/product/CLIENT_WORKFLOW_CORRECTION.md`).
  cliente: ['campaign:read', 'source:read_shared', 'brief:read', 'brief:export'],
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
/**
 * ¿Esta visibilidad expone el recurso a TCL? Contrato único (V2 · Fase 1A):
 * `interna` es solo de SmartPR; `tcl` y `compartida` son visibles para TCL.
 * Todo lo que deba decidirse por visibilidad pasa por aquí.
 */
export function isTclVisible(visibility: Visibility): boolean {
  return visibility === 'tcl' || visibility === 'compartida';
}

export function canAccessResource(user: User, scope: ResourceScope): boolean {
  if (user.status !== 'activo') return false;

  const sameOrg = user.organizationId === scope.organizationId;

  if (user.role === 'cliente') {
    // El cliente pertenece a otra organización por definición: accede solo a lo
    // que se le compartió explícitamente, y nunca a material interno.
    return isTclVisible(scope.visibility);
  }

  if (!sameOrg) return false;

  // El rol legal accede solo a lo que su función requiere; el contenido
  // confidencial exige una asignación explícita que se resolverá en MVP 3.
  if (user.role === 'legal' && scope.confidentialityLevel === 'confidencial') return false;

  return true;
}

/**
 * Autoriza una acción sobre un recurso INTERNO de la organización que no tiene
 * visibilidad hacia TCL (V2 · Fase 3: influencers y su participación).
 *
 * Distinto de `authorize`: aquí la visibilidad no existe, así que no puede
 * ampliar el acceso. Solo el personal de la misma organización accede; el
 * cliente (otra organización por definición) nunca, ni aunque la campaña a la
 * que se asocia sea visible para TCL. Un recurso ajeno devuelve
 * `RESOURCE_NOT_FOUND` (no revela su existencia); un rol sin la capacidad,
 * `FORBIDDEN_ROLE`.
 */
export function authorizeInternalResource(user: User, action: Action, organizationId: string): Result<true> {
  if (user.status !== 'activo' || user.role === 'cliente' || user.organizationId !== organizationId) {
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
