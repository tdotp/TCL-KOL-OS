/**
 * Ciclo de aprobación — Fases C y D del pedido de Sprint 5.
 *
 * Envoltorios finos sobre `transicionarBrief` (única función que cambia
 * `brief_versions.status`, `packages/db/src/transitions.ts`) con el nombre
 * de cada paso del pedido, para que las server actions de `apps/web` no
 * tengan que construir `to`/`motivo` a mano y para concentrar aquí la
 * validación que no es de dominio (p. ej. que los campos señalados por el
 * cliente existan en el catálogo).
 */

import { type Result, type User, campoDelCatalogo, err, ok } from '@tcl-kol-os/domain';
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

/** Aprobación interna: envía el brief a revisión del cliente. */
export async function aprobarInternamente(
  actor: User,
  versionId: string,
): Promise<Result<{ status: 'client_review' }>> {
  const resultado = await transicionarBrief(actor, versionId, 'client_review');
  if (!resultado.ok) return resultado;
  return ok({ status: 'client_review' as const });
}

// ─────────────────────────── Fase D · Revisión del cliente ─────────────────────

function camposValidos(campos: readonly string[]): Result<true> {
  const invalido = campos.find((k) => campoDelCatalogo(k) === undefined);
  if (invalido !== undefined) {
    return err({
      code: 'BRIEF_FIELD_INVALID',
      message: `«${invalido}» no es un campo del catálogo del brief.`,
    });
  }
  return ok(true as const);
}

/** El cliente solicita cambios sobre uno o varios campos. Motivo general obligatorio. */
export async function solicitarCambiosCliente(
  actor: User,
  versionId: string,
  opciones: { motivo: string; camposSenalados?: readonly string[] | undefined },
): Promise<Result<{ status: 'client_changes_requested' }>> {
  const campos = opciones.camposSenalados ?? [];
  const validacion = camposValidos(campos);
  if (!validacion.ok) return validacion;

  const resultado = await transicionarBrief(actor, versionId, 'client_changes_requested', {
    motivo: opciones.motivo,
    camposSenalados: campos,
  });
  if (!resultado.ok) return resultado;
  return ok({ status: 'client_changes_requested' as const });
}

/** El cliente aprueba el brief. Congela la versión (ADR-003) y fija `approved_at`. */
export async function aprobarComoCliente(
  actor: User,
  versionId: string,
): Promise<Result<{ status: 'approved' }>> {
  const resultado = await transicionarBrief(actor, versionId, 'approved');
  if (!resultado.ok) return resultado;
  return ok({ status: 'approved' as const });
}
