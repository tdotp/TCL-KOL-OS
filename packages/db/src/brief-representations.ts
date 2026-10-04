/**
 * Representaciones lingüísticas de una versión lógica del brief (V2 · Fase 2).
 *
 *   Brief → Versión lógica N → { ES (original), EN (traducción) }
 *
 * Una sola identidad, un solo estado, una sola aprobación: ES y EN son
 * representaciones hijas de la versión. Este módulo:
 *
 *  · lee la versión lógica con sus representaciones (`obtenerVersionLogica`) y
 *    una representación localizada campo a campo (`obtenerRepresentacion`);
 *  · registra una traducción de un campo (`registrarTraduccion`) con su origen
 *    y la huella del valor original, de modo que si el original cambia después
 *    la traducción quede `stale` y no pueda darse por equivalente.
 *
 * No genera traducciones: no hay IA de traducción en esta fase. Quien las
 * produzca (persona, y más adelante un proceso asistido) usa
 * `registrarTraduccion`, que audita con origen (`ui` | `chat` | `system`).
 */

import {
  type AuditCorrelation,
  type AuditOrigin,
  type Language,
  type LegacyLanguageLink,
  type LocalizedField,
  type LocalizedRepresentation,
  type LogicalBriefVersion,
  type RepresentationSummary,
  type Result,
  type TranslationSyncState,
  type User,
  canAccessResource,
  err,
  isImmutable,
  ok,
  resumirSincronizacion,
  roleCan,
} from '@tcl-kol-os/domain';
import { assertCapability } from './authz.ts';
import { recordAudit, resolveOrigin } from './audit.ts';
import { getPool, transaction } from './client.ts';
import { cargarRepresentaciones } from './brief-version.ts';
import { verCamposDeVersion } from './extraction.ts';

const NO_ENCONTRADO = {
  code: 'RESOURCE_NOT_FOUND',
  message: 'El recurso no existe o no está disponible.',
} as const;

/** Idioma original de toda versión lógica nueva. */
const IDIOMA_ORIGINAL: Language = 'es';

interface AlcanceDeVersion {
  readonly campaignId: string;
  readonly organizationId: string;
}

/** Autoriza la LECTURA de una versión lógica (mismo criterio que `verCamposDeVersion`). */
async function autorizarLectura(actor: User, versionId: string): Promise<Result<AlcanceDeVersion>> {
  const permitido = assertCapability(actor, 'brief:read');
  if (!permitido.ok) return err({ code: permitido.error.code, message: permitido.error.message });

  const { rows } = await getPool().query<{
    organization_id: string;
    confidentiality_level: string;
    visibility: string;
    campaign_id: string;
  }>(
    `SELECT c.organization_id, c.confidentiality_level, c.visibility, c.id AS campaign_id
       FROM brief_versions v
       JOIN briefs b ON b.id = v.brief_id
       JOIN campaigns c ON c.id = b.campaign_id
      WHERE v.id = $1`,
    [versionId],
  );
  const fila = rows[0];
  if (
    !fila ||
    !canAccessResource(actor, {
      organizationId: fila.organization_id,
      confidentialityLevel: fila.confidentiality_level as 'publica' | 'interna' | 'confidencial' | 'sensible',
      visibility: fila.visibility as 'interna' | 'tcl' | 'compartida',
      createdBy: '',
    })
  ) {
    return err(NO_ENCONTRADO);
  }
  return ok({ campaignId: fila.campaign_id, organizationId: fila.organization_id });
}

// ─────────────────────────── Lectura ───────────────────────────────────────────

/**
 * La versión lógica con sus representaciones: metadatos y estado ÚNICOS, y ES /
 * EN como hijas. Personal de SmartPR ve el detalle de sincronización y las
 * inconsistencias históricas; el cliente solo ve qué idiomas existen.
 */
export async function obtenerVersionLogica(
  actor: User,
  versionId: string,
): Promise<Result<LogicalBriefVersion>> {
  const alcance = await autorizarLectura(actor, versionId);
  if (!alcance.ok) return alcance;

  const { rows } = await getPool().query<{
    id: string;
    brief_id: string;
    version: number;
    status: string;
    language: Language;
    parent_version_id: string | null;
    approved_at: Date | null;
    created_at: Date;
  }>(
    `SELECT id, brief_id, version, status::text AS status, language, parent_version_id, approved_at, created_at
       FROM brief_versions WHERE id = $1`,
    [versionId],
  );
  const v = rows[0];
  if (!v) return err(NO_ENCONTRADO);

  const personal =
    roleCan(actor.role, 'brief:edit') || roleCan(actor.role, 'audit:read') || actor.role === 'operativo';
  const reps = await cargarRepresentaciones(getPool(), versionId);
  const representaciones: Partial<Record<Language, RepresentationSummary>> = {};
  for (const r of reps) {
    representaciones[r.language] = {
      id: r.id,
      language: r.language,
      kind: r.kind,
      sourceLanguage: r.sourceLanguage,
      copiedFromRepresentationId: r.copiedFromRepresentationId,
      createdAt: r.createdAt,
      sync: resumirSincronizacion(r),
      ...(personal
        ? {
            staleFieldKeys: r.staleFieldKeys,
            unverifiedFieldKeys: r.unverifiedFieldKeys,
            missingFieldKeys: r.missingFieldKeys,
          }
        : {}),
    };
  }

  let legacyLanguageLinks: LegacyLanguageLink[] = [];
  if (personal) {
    const links = await getPool().query<{
      en_version_id: string;
      es_version_id: string | null;
      classification: LegacyLanguageLink['classification'];
      reason: string;
      detected_at: Date;
    }>(
      `SELECT en_version_id, es_version_id, classification, reason, detected_at
         FROM brief_legacy_language_links
        WHERE es_version_id = $1 OR en_version_id = $1 OR en_version_id IN (
              SELECT id FROM brief_versions WHERE brief_id = $2 AND translation_of_id = $1)
        ORDER BY detected_at`,
      [versionId, v.brief_id],
    );
    legacyLanguageLinks = links.rows.map((l) => ({
      enVersionId: l.en_version_id,
      esVersionId: l.es_version_id ?? undefined,
      classification: l.classification,
      reason: l.reason,
      detectedAt: l.detected_at.toISOString(),
    }));
  }

  return ok({
    id: v.id,
    briefId: v.brief_id,
    campaignId: alcance.value.campaignId,
    version: v.version,
    status: v.status as LogicalBriefVersion['status'],
    parentVersionId: v.parent_version_id ?? undefined,
    approvedAt: v.approved_at?.toISOString(),
    createdAt: v.created_at.toISOString(),
    originalLanguage: v.language,
    representations: representaciones,
    legacyLanguageLinks,
  });
}

/**
 * Una representación campo a campo. El idioma original muestra los valores de
 * los campos; una traducción muestra el valor localizado y su estado frente al
 * original. La evidencia es siempre la del campo original (compartida): por
 * eso se reutiliza `verCamposDeVersion`, incluida su regla de visibilidad para
 * el cliente.
 */
export async function obtenerRepresentacion(
  actor: User,
  versionId: string,
  language: Language,
): Promise<Result<LocalizedRepresentation>> {
  const logica = await obtenerVersionLogica(actor, versionId);
  if (!logica.ok) return logica;
  const resumen = logica.value.representations[language];
  if (!resumen) return err(NO_ENCONTRADO);

  const campos = await verCamposDeVersion(actor, versionId);
  if (!campos.ok) return campos;

  const evidencias = (c: (typeof campos.value)[number]) =>
    c.evidencias.map((e) => ({
      quote: e.quote,
      filename: e.filename,
      page: e.page,
      slide: e.slide,
      section: e.section,
    }));

  if (resumen.kind === 'original') {
    return ok({
      versionId,
      language,
      kind: resumen.kind,
      sync: 'original',
      fields: campos.value.map<LocalizedField>((c) => ({
        key: c.key,
        campaignProductId: c.campaignProductId,
        value: c.value,
        status: c.status,
        provenanceType: c.provenanceType as LocalizedField['provenanceType'],
        sync: 'original',
        evidencias: evidencias(c),
      })),
    });
  }

  const { rows } = await getPool().query<{
    brief_field_id: string;
    value: unknown;
    provenance_type: LocalizedField['provenanceType'];
    translator: 'ai' | 'human' | 'legacy';
    state: TranslationSyncState;
  }>(
    `SELECT t.brief_field_id, t.value, t.provenance_type::text AS provenance_type, t.translator,
            COALESCE(s.state, 'missing') AS state
       FROM brief_field_translations t
       LEFT JOIN brief_translation_sync s
              ON s.representation_id = t.representation_id AND s.brief_field_id = t.brief_field_id
      WHERE t.representation_id = $1`,
    [resumen.id],
  );
  const porCampo = new Map(rows.map((r) => [r.brief_field_id, r]));

  return ok({
    versionId,
    language,
    kind: resumen.kind,
    sync: resumen.sync,
    fields: campos.value
      .filter((c) => c.value !== null && c.value !== undefined)
      .map<LocalizedField>((c) => {
        const t = porCampo.get(c.id);
        return {
          key: c.key,
          campaignProductId: c.campaignProductId,
          value: t?.value,
          status: c.status,
          provenanceType: t?.provenance_type ?? 'translated',
          sync: t === undefined ? 'missing' : t.state,
          sourceLanguage: resumen.sourceLanguage,
          translator: t?.translator,
          evidencias: evidencias(c),
        };
      }),
  });
}

// ─────────────────────────── Escritura: traducciones ───────────────────────────

export interface TraduccionInput {
  readonly language: Language;
  readonly fieldKey: string;
  readonly campaignProductId?: string | null | undefined;
  /** Valor en el idioma de destino. */
  readonly value: unknown;
  /** `human`: lo escribió una persona; `ai`: lo produjo un proceso de traducción. */
  readonly translator: 'ai' | 'human';
  /** Canal. Por defecto `ui` (persona) o `system` (proceso). */
  readonly origin?: AuditOrigin | undefined;
  readonly correlation?: AuditCorrelation | undefined;
}

/**
 * Registra (o actualiza) la traducción de UN campo de una versión editable.
 * Crea la representación de destino la primera vez, con la original como
 * origen. Guarda la huella del valor original vigente: si ese valor cambia
 * después, la traducción queda `stale` hasta que se vuelva a registrar.
 *
 * No aprueba nada ni cambia el estado de la versión: traducir es una acción de
 * contenido, no una decisión. El estado sigue siendo único.
 */
export async function registrarTraduccion(
  actor: User | 'system',
  versionId: string,
  input: TraduccionInput,
): Promise<Result<{ representationId: string; sync: TranslationSyncState }>> {
  if (actor !== 'system') {
    const permitido = assertCapability(actor, 'brief:translate');
    if (!permitido.ok) return err({ code: permitido.error.code, message: permitido.error.message });
  } else if (input.translator === 'human') {
    return err({
      code: 'FORBIDDEN_ROLE',
      message: 'Una traducción humana la registra una persona, no el sistema.',
    });
  }

  let origin: AuditOrigin;
  try {
    origin = resolveOrigin(actor, input.origin);
  } catch (error) {
    return err({ code: 'HUMAN_CONFIRMATION_REQUIRED', message: (error as Error).message });
  }

  if (input.language === IDIOMA_ORIGINAL) {
    return err({
      code: 'BRIEF_FIELD_INVALID',
      message: 'El idioma original no se traduce: sus valores son los del campo.',
    });
  }
  if (input.value === null || input.value === undefined || input.value === '') {
    return err({ code: 'BRIEF_FIELD_INVALID', message: 'La traducción no puede estar vacía.' });
  }

  return transaction(async (client) => {
    const { rows: versiones } = await client.query<{
      status: string;
      organization_id: string;
      language: Language;
    }>(
      `SELECT v.status::text AS status, c.organization_id, v.language
         FROM brief_versions v
         JOIN briefs b ON b.id = v.brief_id
         JOIN campaigns c ON c.id = b.campaign_id
        WHERE v.id = $1 FOR UPDATE OF v`,
      [versionId],
    );
    const version = versiones[0];
    if (!version || (actor !== 'system' && actor.organizationId !== version.organization_id)) {
      return err(NO_ENCONTRADO);
    }
    if (version.language !== IDIOMA_ORIGINAL) {
      return err({
        code: 'BRIEF_INVALID_TRANSITION',
        message: 'Esta es una versión en inglés anterior a V2: opere sobre la versión lógica.',
      });
    }
    if (isImmutable(version.status as never)) {
      return err({
        code: 'BRIEF_VERSION_IMMUTABLE',
        message: `La versión está en estado ${version.status} y no admite cambios, tampoco en sus traducciones. Cree una versión nueva.`,
        details: { status: version.status },
      });
    }

    const { rows: campos } = await client.query<{ id: string; value: unknown; revision: number }>(
      `SELECT id, value, revision FROM brief_fields
        WHERE brief_version_id = $1 AND key = $2 AND campaign_product_id IS NOT DISTINCT FROM $3::uuid`,
      [versionId, input.fieldKey, input.campaignProductId ?? null],
    );
    const campo = campos[0];
    if (!campo) return err(NO_ENCONTRADO);
    if (campo.value === null) {
      return err({ code: 'BRIEF_FIELD_INVALID', message: 'Un campo sin valor no se traduce.' });
    }

    // Representación de destino: se crea la primera vez, con la original como origen.
    const { rows: original } = await client.query<{ id: string }>(
      `SELECT id FROM brief_version_representations WHERE brief_version_id = $1 AND kind = 'original'`,
      [versionId],
    );
    const origen = original[0];
    if (!origen) {
      return err({ code: 'REPRESENTATION_MISSING', message: 'La versión no tiene representación original.' });
    }
    const existente = await client.query<{ id: string }>(
      `SELECT id FROM brief_version_representations WHERE brief_version_id = $1 AND language = $2`,
      [versionId, input.language],
    );
    let representationId = existente.rows[0]?.id;
    if (representationId === undefined) {
      const creada = await client.query<{ id: string }>(
        `INSERT INTO brief_version_representations
           (brief_version_id, language, kind, source_representation_id, created_by)
         VALUES ($1, $2, 'translation', $3, $4) RETURNING id`,
        [versionId, input.language, origen.id, actor === 'system' ? null : actor.id],
      );
      representationId = creada.rows[0]!.id;
      await recordAudit(client, {
        actor,
        organizationId: version.organization_id,
        origin,
        correlation: input.correlation,
        action: 'brief.representation.create',
        entityType: 'brief_version',
        entityId: versionId,
        metadata: { language: input.language, kind: 'translation', sourceLanguage: IDIOMA_ORIGINAL },
      });
    }

    const anterior = await client.query<{ value: unknown }>(
      `SELECT value FROM brief_field_translations WHERE brief_field_id = $1 AND representation_id = $2`,
      [campo.id, representationId],
    );

    await client.query(
      `INSERT INTO brief_field_translations
         (brief_field_id, representation_id, value, provenance_type, translator,
          source_value_hash, source_revision, translated_by)
       VALUES ($1, $2, $3::jsonb, $4::provenance_type, $5, brief_value_hash($6::jsonb), $7, $8)
       ON CONFLICT (brief_field_id, representation_id) DO UPDATE
         SET value = EXCLUDED.value, provenance_type = EXCLUDED.provenance_type,
             translator = EXCLUDED.translator, source_value_hash = EXCLUDED.source_value_hash,
             source_revision = EXCLUDED.source_revision, translated_by = EXCLUDED.translated_by`,
      [
        campo.id,
        representationId,
        JSON.stringify(input.value),
        input.translator === 'human' ? 'manual_local' : 'translated',
        input.translator,
        JSON.stringify(campo.value),
        campo.revision,
        actor === 'system' ? null : actor.id,
      ],
    );

    await client.query(
      `INSERT INTO brief_field_revisions
         (brief_field_id, brief_version_id, accion, valor_anterior, valor_nuevo, actor_id, language)
       VALUES ($1, $2, 'translate', $3::jsonb, $4::jsonb, $5, $6)`,
      [
        campo.id,
        versionId,
        anterior.rows[0] === undefined ? null : JSON.stringify(anterior.rows[0].value),
        JSON.stringify(input.value),
        actor === 'system' ? null : actor.id,
        input.language,
      ],
    );

    await recordAudit(client, {
      actor,
      organizationId: version.organization_id,
      origin,
      correlation: input.correlation,
      action: 'brief.translation.set',
      entityType: 'brief_version',
      entityId: versionId,
      metadata: {
        fieldKey: input.fieldKey,
        language: input.language,
        translator: input.translator,
        sourceLanguage: IDIOMA_ORIGINAL,
        sourceRevision: campo.revision,
      },
    });

    return ok({ representationId, sync: 'current' as const });
  });
}
