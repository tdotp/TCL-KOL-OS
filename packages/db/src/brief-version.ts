/**
 * Ciclo de vida de la "versión de trabajo" (DEC-024, cierre de Sprint 4).
 *
 * Mientras el estado de una versión no sea terminal ni `approved`, es la
 * misma fila la que se reutiliza para confirmar, corregir, responder
 * preguntas y resolver conflictos — nunca una versión nueva por cada acción.
 * Este módulo concentra las dos operaciones que todo lo demás necesita:
 * encontrar o crear esa versión, y cargarla con la forma exacta que exige
 * `packages/domain` para evaluar una transición o una guarda.
 */

import type pg from 'pg';
import type { BriefField, BriefVersion, ReviewStatus, FieldStatus, ProvenanceType, Criticality } from '@tcl-kol-os/domain';
import { getPool } from './client.ts';

type Ejecutor = pg.Pool | pg.PoolClient;

/** Estados que ya no admiten reutilizar la versión como "de trabajo". */
const ESTADOS_CERRADOS = ['approved', 'superseded', 'cancelled'];

export interface VersionDeTrabajo {
  readonly briefId: string;
  readonly versionId: string;
  /** `true` si esta llamada la creó; `false` si ya existía y se reutilizó. */
  readonly esNueva: boolean;
}

/**
 * Encuentra la versión `es` no terminal de la campaña, o crea una en `draft`.
 *
 * La usan tanto `extraerBrief` como `crearBriefManual`: la primera vez que
 * cualquiera de los dos toca una campaña nace la versión; las siguientes,
 * ambas caminos convergen sobre la misma fila.
 */
export async function obtenerOCrearVersionDeTrabajo(
  client: pg.PoolClient,
  opciones: { campaignId: string; organizationId: string; createdBy: string },
): Promise<VersionDeTrabajo> {
  const { campaignId, organizationId, createdBy } = opciones;

  const brief = await client.query<{ id: string }>(
    `INSERT INTO briefs (campaign_id) VALUES ($1)
     ON CONFLICT (campaign_id) DO UPDATE SET campaign_id = EXCLUDED.campaign_id
     RETURNING id`,
    [campaignId],
  );
  const briefId = brief.rows[0]!.id;

  const existente = await client.query<{ id: string }>(
    `SELECT id FROM brief_versions
      WHERE brief_id = $1 AND language = 'es' AND status <> ALL($2::brief_status[])
      ORDER BY version DESC LIMIT 1`,
    [briefId, ESTADOS_CERRADOS],
  );
  if (existente.rows[0]) {
    return { briefId, versionId: existente.rows[0].id, esNueva: false };
  }

  const siguiente = await client.query<{ proxima: number }>(
    `SELECT COALESCE(MAX(version), 0) + 1 AS proxima
       FROM brief_versions WHERE brief_id = $1 AND language = 'es'`,
    [briefId],
  );
  const version = await client.query<{ id: string }>(
    `INSERT INTO brief_versions (brief_id, organization_id, version, created_by)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [briefId, organizationId, siguiente.rows[0]!.proxima, createdBy],
  );

  return { briefId, versionId: version.rows[0]!.id, esNueva: true };
}

interface FilaVersion {
  id: string;
  brief_id: string;
  version: number;
  language: 'es' | 'en';
  parent_version_id: string | null;
  translation_of_id: string | null;
  status: BriefVersion['status'];
  created_by: string;
  created_at: Date;
  organization_id: string;
  campaign_id: string;
}

interface FilaCampo {
  id: string;
  key: string;
  campaign_product_id: string | null;
  value: unknown;
  status: FieldStatus;
  confidence: string | null;
  provenance_type: ProvenanceType;
  criticidad: Criticality;
  review_status: ReviewStatus;
  reviewed_by: string | null;
  reviewed_at: Date | null;
  revision: number;
  evidence: Array<{
    sourceId: string;
    fragmentId: string | null;
    page: number | null;
    slide: number | null;
    quote: string;
    relation: 'soporta' | 'contradice' | 'contexto';
  }>;
}

/** La versión + sus campos, con la organización y campaña que la poseen. */
export interface VersionCargada {
  readonly version: BriefVersion;
  readonly organizationId: string;
  readonly campaignId: string;
}

/**
 * Carga una versión con la forma exacta de dominio, incluida cada evidencia.
 * Es lo que necesita `transition()` para evaluar sus guardas — nunca una
 * proyección parcial que le esconda un campo.
 */
export async function cargarVersion(
  ejecutor: Ejecutor,
  versionId: string,
): Promise<VersionCargada | undefined> {
  const db = ejecutor ?? getPool();

  const filaVersion = await db.query<FilaVersion>(
    `SELECT v.id, v.brief_id, v.version, v.language, v.parent_version_id, v.translation_of_id,
            v.status::text AS status, v.created_by, v.created_at, v.organization_id,
            b.campaign_id
       FROM brief_versions v
       JOIN briefs b ON b.id = v.brief_id
      WHERE v.id = $1`,
    [versionId],
  );
  const version = filaVersion.rows[0];
  if (!version) return undefined;

  const filasCampos = await db.query<FilaCampo>(
    `SELECT bf.id, bf.key, bf.campaign_product_id, bf.value, bf.status::text AS status,
            bf.confidence, bf.provenance_type::text AS provenance_type,
            bf.criticidad::text AS criticidad, bf.review_status, bf.reviewed_by,
            bf.reviewed_at, bf.revision,
            COALESCE(
              json_agg(
                json_build_object(
                  'sourceId', e.source_id, 'fragmentId', e.fragment_id,
                  'page', e.page, 'slide', e.slide, 'quote', e.quote,
                  'relation', e.relation::text
                ) ORDER BY e.created_at
              ) FILTER (WHERE e.id IS NOT NULL),
              '[]'::json
            ) AS evidence
       FROM brief_fields bf
       LEFT JOIN evidence e ON e.brief_field_id = bf.id
      WHERE bf.brief_version_id = $1
      GROUP BY bf.id
      ORDER BY bf.key`,
    [versionId],
  );

  const fields: BriefField[] = filasCampos.rows.map((f) => ({
    id: f.id,
    key: f.key,
    campaignProductId: f.campaign_product_id ?? undefined,
    value: f.value,
    status: f.status,
    confidence: f.confidence === null ? undefined : Number(f.confidence),
    provenanceType: f.provenance_type,
    criticidad: f.criticidad,
    evidence: f.evidence.map((e) => ({
      sourceId: e.sourceId,
      fragmentId: e.fragmentId ?? undefined,
      page: e.page ?? undefined,
      slide: e.slide ?? undefined,
      quote: e.quote,
      relation: e.relation,
    })),
    reviewStatus: f.review_status,
    reviewedBy: f.reviewed_by ?? undefined,
    reviewedAt: f.reviewed_at?.toISOString(),
    revision: f.revision,
  }));

  return {
    organizationId: version.organization_id,
    campaignId: version.campaign_id,
    version: {
      id: version.id,
      briefId: version.brief_id,
      version: version.version,
      language: version.language,
      parentVersionId: version.parent_version_id ?? undefined,
      translationOfId: version.translation_of_id ?? undefined,
      status: version.status,
      fields,
      createdBy: version.created_by,
      createdAt: version.created_at.toISOString(),
    },
  };
}
