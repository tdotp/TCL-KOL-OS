/**
 * Ciclo de revisión y cierre del brief — decisiones internas de SmartPR.
 *
 * Envoltorios finos sobre `transicionarBrief` (única función que cambia
 * `brief_versions.status`, `packages/db/src/transitions.ts`) con el nombre
 * de cada paso, para que las server actions de `apps/web` no tengan que
 * construir `to`/`motivo` a mano.
 *
 * El cliente NO aprueba ni solicita cambios (corrección del workflow cliente,
 * `docs/product/CLIENT_WORKFLOW_CORRECTION.md`): `aprobarComoCliente` y
 * `solicitarCambiosCliente` se eliminaron. El nombre del archivo se conserva
 * por compatibilidad de imports.
 */

import { type Result, type User, ok } from '@tcl-kol-os/domain';
import { transicionarBrief } from './transitions.ts';

// ─────────────────────────── Fase C · Revisión interna ─────────────────────────

/** El revisor devuelve el brief con cambios solicitados. Motivo obligatorio. */
export async function solicitarCambiosInternos(
  actor: User,
  versionId: string,
  motivo: string,
): Promise<Result<{ status: 'internal_changes_requested' }>> {
  const resultado = await transicionarBrief(actor, versionId, 'internal_changes_requested', { motivo });
  if (!resultado.ok) return resultado;
  return ok({ status: 'internal_changes_requested' as const });
}

/**
 * Aprobación del brief por Dirección de SmartPR (admin/director). Congela la
 * versión (ADR-003), fija `approved_at` y hace la campaña visible para el
 * cliente en modo lectura. También cierra una versión heredada en
 * `client_review`.
 */
export async function aprobarBrief(actor: User, versionId: string): Promise<Result<{ status: 'approved' }>> {
  const resultado = await transicionarBrief(actor, versionId, 'approved');
  if (!resultado.ok) return resultado;
  return ok({ status: 'approved' as const });
}
