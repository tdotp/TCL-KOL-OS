/**
 * Contexto de auditoría de un caso de uso (V2 · Fase 1C, aislado en la Fase 6).
 *
 * Un caso de uso que muta recibe, además del actor, un contexto OPCIONAL con el
 * canal desde el que se invoca (`ui` por defecto; `chat` cuando lo llama una
 * herramienta del agente en nombre de la persona) y la correlación
 * (conversación, mensaje, ejecución, invocación de herramienta, acción
 * propuesta). Quien llama NO inventa el actor: el contexto solo describe de
 * dónde viene la acción. Sin contexto, el comportamiento es el de siempre.
 *
 * Vive en un módulo propio para que los casos de uso de cualquier área
 * (campañas, fuentes, brief, influencers, importación) lo compartan sin
 * depender de `influencers.ts`; este lo reexporta para no romper importaciones.
 */

import { type AuditCorrelation, type AuditOrigin, type Result, type User, err, ok } from '@tcl-kol-os/domain';
import { type AuditInput, resolveOrigin } from './audit.ts';

/** Canal y correlación de la acción (V2 · Fase 1C). Por defecto: `ui`. */
export interface ContextoDeAuditoria {
  readonly origin?: AuditOrigin | undefined;
  readonly correlation?: AuditCorrelation | undefined;
}

/**
 * Solo una persona muta. Un `'system'` (o cualquier valor que no sea un
 * usuario) que llegue por el borde de tipos se rechaza en ejecución.
 */
export function exigirPersona(actor: unknown, contexto: ContextoDeAuditoria | undefined): Result<User> {
  if (typeof actor !== 'object' || actor === null) {
    return err({
      code: 'FORBIDDEN_ROLE',
      message: 'Esta operación la ejecuta una persona autorizada, no el sistema.',
    });
  }
  const persona = actor as User;
  try {
    resolveOrigin(persona, contexto?.origin);
  } catch (error) {
    return err({ code: 'FORBIDDEN_ROLE', message: (error as Error).message });
  }
  return ok(persona);
}

/** Campos comunes de auditoría de una persona con su contexto. */
export function auditoriaDe(
  actor: User,
  contexto: ContextoDeAuditoria | undefined,
  evento: Pick<AuditInput, 'action' | 'entityType' | 'entityId' | 'metadata'>,
): AuditInput {
  return { actor, origin: contexto?.origin, correlation: contexto?.correlation, ...evento };
}
