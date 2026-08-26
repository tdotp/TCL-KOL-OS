/**
 * Camino 100% manual del brief (§3.3, §6.2 del cierre de Sprint 4).
 *
 * No llama al worker, no depende de `AI_ENABLED`. Es la acción real detrás
 * del texto que la interfaz ya prometía ("empiece el brief a mano") sin que
 * existiera — el hallazgo del propio HANDOFF.
 */

import { type Result, type User, catalogoDelBrief, err, ok } from '@tcl-kol-os/domain';
import { assertCapability } from './authz.ts';
import { recordAudit } from './audit.ts';
import { getPool, transaction } from './client.ts';
import { obtenerOCrearVersionDeTrabajo } from './brief-version.ts';

/**
 * Crea (o reutiliza, si ya existe) la versión de trabajo de una campaña y la
 * siembra con las 41 claves del catálogo (DEC-021) — una fila por producto en
 * los campos de nivel `producto`, una fila compartida en el resto. Todas
 * nacen `not_found` / `provenance_type: 'pending'`: nadie las ha tocado.
 */
export async function crearBriefManual(
  actor: User,
  campaignId: string,
): Promise<Result<{ briefId: string; versionId: string; esNueva: boolean }>> {
  const permitido = assertCapability(actor, 'brief:manual_create');
  if (!permitido.ok) return err({ code: permitido.error.code, message: permitido.error.message });

  const campana = await getPool().query<{ id: string }>(
    `SELECT id FROM campaigns WHERE id = $1 AND organization_id = $2`,
    [campaignId, actor.organizationId],
  );
  if (campana.rowCount === 0) {
    return err({ code: 'RESOURCE_NOT_FOUND', message: 'El recurso no existe o no está disponible.' });
  }

  const resultado = await transaction(async (client) => {
    const version = await obtenerOCrearVersionDeTrabajo(client, {
      campaignId,
      organizationId: actor.organizationId,
      createdBy: actor.id,
    });

    if (version.esNueva) {
      const productos = await client.query<{ id: string }>(
        `SELECT id FROM campaign_products WHERE campaign_id = $1 ORDER BY prioridad`,
        [campaignId],
      );

      for (const campo of catalogoDelBrief()) {
        if (campo.nivel === 'producto') {
          for (const producto of productos.rows) {
            await client.query(
              `INSERT INTO brief_fields
                      (brief_version_id, key, campaign_product_id, status, provenance_type, criticidad)
               VALUES ($1, $2, $3, 'not_found', 'pending', $4::criticality)`,
              [version.versionId, campo.key, producto.id, campo.criticidad],
            );
          }
        } else {
          await client.query(
            `INSERT INTO brief_fields (brief_version_id, key, status, provenance_type, criticidad)
             VALUES ($1, $2, 'not_found', 'pending', $3::criticality)`,
            [version.versionId, campo.key, campo.criticidad],
          );
        }
      }

      await recordAudit(client, {
        actor,
        action: 'brief.manual_create',
        entityType: 'brief_version',
        entityId: version.versionId,
        metadata: { campaignId },
      });
    }

    return version;
  });

  return ok(resultado);
}
