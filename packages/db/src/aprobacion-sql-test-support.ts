/**
 * Soporte de pruebas (V2 · Fase 7, migración 025): aprobar una versión de guion por SQL DIRECTO exige, también en
 * la base, citar la revisión que la habilitó y el Brief aprobado de la MISMA campaña. Las pruebas de esquema que
 * ejercen OTRAS reglas del trigger de aprobación (aprobador, orden, hash, acción propuesta, índice único…) las
 * preparan con esto para que la falta de revisión no las enmascare.
 *
 *   await prepararRevisionPorSql(e, versionId);   // Brief aprobado de la campaña + revisión humana `succeeded`
 *   UPDATE script_versions SET status = 'approved', approved_by = $2, ${CON_REVISION_DE_LA_VERSION} WHERE id = $1
 *
 * La revisión se inserta por SQL (no por el caso de uso): no transiciona la versión ni toca su estado.
 */

import { query } from './client.ts';
import { type EscenarioDeContenido, crearBriefAprobadoDePrueba } from './test-utils.ts';

/** Fragmento SQL: la revisión `succeeded` más reciente de la versión `$1` y el Brief contra el que se hizo. */
export const CON_REVISION_DE_LA_VERSION = `approved_analysis_id = (SELECT id FROM content_analysis_runs WHERE script_version_id = $1 AND status = 'succeeded' ORDER BY created_at DESC LIMIT 1),
       approved_brief_version_id = (SELECT governing_brief_version_id FROM content_analysis_runs WHERE script_version_id = $1 AND status = 'succeeded' ORDER BY created_at DESC LIMIT 1)`;

const briefsPorCampana = new Map<string, string>();

/** El Brief aprobado de la campaña del escenario (se crea una sola vez). */
export async function briefAprobadoDeLaCampana(e: EscenarioDeContenido): Promise<string> {
  const existente = briefsPorCampana.get(e.campanaId);
  if (existente !== undefined) return existente;
  const brief = await crearBriefAprobadoDePrueba(e.campanaId, e.admin, {
    productos: [e.productos.p80, e.productos.pro],
    noEncontrados: ['objetivo.comportamiento_esperado'],
  });
  briefsPorCampana.set(e.campanaId, brief.versionId);
  return brief.versionId;
}

/** Inserta (si falta) una revisión humana `succeeded` de la versión, contra el Brief aprobado de su campaña. */
export async function prepararRevisionPorSql(
  e: EscenarioDeContenido,
  versionId: string,
  /** El Brief aprobado de la campaña, si el escenario ya tiene uno (si no, se crea). */
  briefVersionId?: string,
): Promise<void> {
  const brief = briefVersionId ?? (await briefAprobadoDeLaCampana(e));
  await query(
    `INSERT INTO content_analysis_runs
       (organization_id, campaign_id, kind, script_version_id, deliverable_id, campaign_influencer_id,
        governing_brief_version_id, brief_fingerprint, script_source_id, script_source_hash, status,
        finding_count, created_by)
     SELECT sv.organization_id, sv.campaign_id, 'human', sv.id, sv.deliverable_id, d.campaign_influencer_id,
            $2, repeat('a', 64), sv.source_document_id, sv.source_hash, 'succeeded', 0, $3
       FROM script_versions sv JOIN deliverables d ON d.id = sv.deliverable_id
      WHERE sv.id = $1
        AND NOT EXISTS (SELECT 1 FROM content_analysis_runs r WHERE r.script_version_id = sv.id AND r.status = 'succeeded')`,
    [versionId, brief, e.consultor.id],
  );
}
