/**
 * Conecta `transition()` del dominio con la base (Sprint 4, cierre §3.4).
 *
 * Antes de este incremento, `packages/domain/src/brief-states.ts` tenía 12
 * estados, ~25 transiciones y 4 guardas completamente probadas — y ningún
 * archivo de `packages/db` ni `apps/web` la importaba. Un `brief_version`
 * nacía en `draft` y ahí se quedaba: nada en el sistema podía moverlo.
 *
 * Esta es la única función que cambia `brief_versions.status`. Nunca se hace
 * con un `UPDATE` directo en otro archivo — así toda transición pasa
 * siempre por las mismas guardas, sin excepción y sin reimplementarlas.
 */

import { type Actor, type BriefStatus, type Result, err, ok, transition } from '@tcl-kol-os/domain';
import { assertCapability } from './authz.ts';
import { recordAudit } from './audit.ts';
import { getPool, transaction } from './client.ts';
import { cargarVersion } from './brief-version.ts';

async function contextoDeGuardas(
  ejecutor: Parameters<typeof cargarVersion>[0],
  versionId: string,
): Promise<{
  pendingCriticalQuestions: number;
  pendingQuestionsTotal: number;
  unresolvedCriticalFields: string[];
}> {
  const [criticas, total, sinResolver] = await Promise.all([
    ejecutor.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM local_questions
        WHERE brief_version_id = $1 AND criticidad = 'critico' AND status = 'pendiente'`,
      [versionId],
    ),
    ejecutor.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM local_questions
        WHERE brief_version_id = $1 AND status = 'pendiente'`,
      [versionId],
    ),
    ejecutor.query<{ key: string }>(
      `SELECT bf.key FROM brief_fields bf
        WHERE bf.brief_version_id = $1 AND bf.criticidad = 'critico' AND bf.status <> 'found'
          AND NOT EXISTS (
            SELECT 1 FROM local_questions lq
             WHERE lq.brief_version_id = bf.brief_version_id
               AND lq.key = bf.key
               AND lq.campaign_product_id IS NOT DISTINCT FROM bf.campaign_product_id
               AND lq.status = 'descartada'
          )
        ORDER BY bf.key`,
      [versionId],
    ),
  ]);

  return {
    pendingCriticalQuestions: Number(criticas.rows[0]?.n ?? 0),
    pendingQuestionsTotal: Number(total.rows[0]?.n ?? 0),
    unresolvedCriticalFields: sinResolver.rows.map((r) => r.key),
  };
}

/**
 * Ejecuta una transición de estado, con las mismas reglas para un humano o
 * para el sistema (`actor: 'system'`, usado por `extraerBrief` alrededor de
 * la llamada al worker).
 *
 * Si el dominio rechaza la transición, el `message` de la guarda que falló
 * se devuelve tal cual — es el error accionable que exige la sección 7 del
 * pedido, nunca un "brief inválido" genérico (ADR-008: esta capa no
 * reinterpreta la razón, solo la transporta).
 */
export async function transicionarBrief(
  actor: Actor,
  versionId: string,
  to: BriefStatus,
): Promise<Result<{ status: BriefStatus }>> {
  if (actor !== 'system') {
    const permitido = assertCapability(actor, 'brief:transition');
    if (!permitido.ok) return err({ code: permitido.error.code, message: permitido.error.message });
  }

  const datos = await cargarVersion(getPool(), versionId);
  if (!datos) {
    return err({ code: 'RESOURCE_NOT_FOUND', message: 'El recurso no existe o no está disponible.' });
  }

  if (actor !== 'system' && datos.organizationId !== actor.organizationId) {
    return err({ code: 'RESOURCE_NOT_FOUND', message: 'El recurso no existe o no está disponible.' });
  }

  const contexto = await contextoDeGuardas(getPool(), versionId);
  const from = datos.version.status;

  const resultado = transition(
    {
      version: datos.version,
      actor,
      pendingCriticalQuestions: contexto.pendingCriticalQuestions,
      pendingQuestionsTotal: contexto.pendingQuestionsTotal,
      unresolvedCriticalFields: contexto.unresolvedCriticalFields,
    },
    to,
  );

  if (!resultado.ok) {
    return err({
      code: resultado.error.code,
      message: resultado.error.message,
      details: resultado.error.details,
    });
  }

  await transaction(async (client) => {
    if (to === 'approved') {
      await client.query(
        `UPDATE brief_versions SET status = $1::brief_status, approved_at = now() WHERE id = $2`,
        [to, versionId],
      );
    } else {
      await client.query(`UPDATE brief_versions SET status = $1::brief_status WHERE id = $2`, [
        to,
        versionId,
      ]);
    }

    await recordAudit(client, {
      actor,
      organizationId: datos.organizationId,
      action: 'brief.transition',
      entityType: 'brief_version',
      entityId: versionId,
      metadata: { from, to },
    });
  });

  return ok({ status: to });
}
