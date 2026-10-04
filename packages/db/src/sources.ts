/**
 * Repositorio de fuentes documentales (Épica E4).
 *
 * Igual que en campañas: la política la decide `packages/domain`, aquí solo se
 * aplica, y toda consulta filtra además por organización en el propio SQL.
 */

import {
  FORMATOS_CON_EXTRACCION,
  canAccessResource,
  isTclVisible,
  roleCan,
  validarArchivo,
  type Result,
  type User,
  type Visibility,
  err,
  ok,
} from '@tcl-kol-os/domain';
import { assertCapability } from './authz.ts';
import { getPool, transaction } from './client.ts';
import { recordAudit } from './audit.ts';
import { guardarOriginal, rutaAbsoluta } from './storage.ts';

export type SourceType = 'ppt_global' | 'ficha_tecnica' | 'brief_cliente' | 'imagen' | 'otro';
export type SourceStatus = 'pendiente' | 'procesando' | 'procesado' | 'fallido';

export interface SourceRow {
  readonly id: string;
  readonly campaign_id: string;
  readonly type: SourceType;
  readonly filename: string;
  readonly mime_type: string;
  readonly size_bytes: string;
  readonly hash: string;
  readonly status: SourceStatus;
  readonly created_at: Date;
  readonly fragmentos: number;
  readonly job_status: string | null;
  readonly job_intentos: number | null;
  readonly job_error: string | null;
  readonly job_disponible_en: Date | null;
}

export interface FragmentRow {
  readonly id: string;
  readonly ordinal: number;
  readonly page: number | null;
  readonly slide: number | null;
  readonly section: string | null;
  readonly linea: number | null;
  readonly text: string;
  readonly metadata: Record<string, unknown>;
}

/** Comprueba que la campaña pertenece a la organización del actor. */
async function campanaPropia(actor: User, campaignId: string): Promise<boolean> {
  const { rows } = await getPool().query<{ id: string }>(
    `SELECT id FROM campaigns WHERE id = $1 AND organization_id = $2`,
    [campaignId, actor.organizationId],
  );
  return rows.length > 0;
}

const NO_ENCONTRADO = {
  code: 'RESOURCE_NOT_FOUND',
  message: 'El recurso no existe o no está disponible.',
} as const;

/**
 * Alcance con el que un actor puede leer las fuentes de una campaña
 * (V2 · Fase 1A). Es el ÚNICO sitio donde se decide, y lo reutilizan los
 * listados, la lectura por id, la búsqueda y la evidencia.
 *
 *  · Personal de SmartPR con `source:read`: todas las fuentes de su
 *    organización.
 *  · Cliente con `source:read_shared`: solo si la campaña ya es visible para
 *    TCL **y**, además, únicamente las fuentes marcadas como visibles para TCL.
 *    Que la campaña sea visible NO expone sus fuentes.
 */
export interface AlcanceDeFuentes {
  /** Organización dueña de las fuentes (la de la campaña, no la del actor). */
  readonly organizationId: string;
  readonly soloVisibleParaTcl: boolean;
}

export async function resolverAlcanceDeFuentes(
  actor: User,
  campaignId: string,
): Promise<Result<AlcanceDeFuentes>> {
  if (actor.status !== 'activo') {
    return err({ code: 'FORBIDDEN_ROLE', message: 'El usuario no está activo.' });
  }

  if (roleCan(actor.role, 'source:read')) {
    if (!(await campanaPropia(actor, campaignId))) return err(NO_ENCONTRADO);
    return ok({ organizationId: actor.organizationId, soloVisibleParaTcl: false });
  }

  if (roleCan(actor.role, 'source:read_shared')) {
    const { rows } = await getPool().query<{
      organization_id: string;
      confidentiality_level: string;
      visibility: Visibility;
    }>(`SELECT organization_id, confidentiality_level, visibility FROM campaigns WHERE id = $1`, [
      campaignId,
    ]);
    const campana = rows[0];
    if (
      !campana ||
      !canAccessResource(actor, {
        organizationId: campana.organization_id,
        confidentialityLevel: campana.confidentiality_level as
          'publica' | 'interna' | 'confidencial' | 'sensible',
        visibility: campana.visibility,
        createdBy: '',
      })
    ) {
      return err(NO_ENCONTRADO);
    }
    return ok({ organizationId: campana.organization_id, soloVisibleParaTcl: true });
  }

  return err({
    code: 'FORBIDDEN_ROLE',
    message: `El rol ${actor.role} no puede ejecutar la acción source:read.`,
    details: { action: 'source:read', role: actor.role },
  });
}

// ─────────────────────────── Consultas ────────────────────────────────────────

const SELECT_SOURCES = `
  SELECT s.id, s.campaign_id, s.type, s.filename, s.mime_type,
         s.size_bytes::text AS size_bytes, s.hash, s.status, s.created_at,
         (SELECT count(*)::int FROM source_fragments f WHERE f.source_id = s.id) AS fragmentos,
         j.status::text AS job_status, j.intentos AS job_intentos,
         j.error AS job_error, j.disponible_en AS job_disponible_en
    FROM source_documents s
    LEFT JOIN LATERAL (
      SELECT status, intentos, error, disponible_en
        FROM processing_jobs
       WHERE source_id = s.id
       ORDER BY created_at DESC
       LIMIT 1
    ) j ON true
`;

export async function listSources(actor: User, campaignId: string): Promise<Result<SourceRow[]>> {
  const alcance = await resolverAlcanceDeFuentes(actor, campaignId);
  if (!alcance.ok) return err({ code: alcance.error.code, message: alcance.error.message });

  const { rows } = await getPool().query<SourceRow>(
    `${SELECT_SOURCES}
      WHERE s.campaign_id = $1 AND s.organization_id = $2
        AND ($3::boolean = false OR s.visibility IN ('tcl', 'compartida'))
      ORDER BY s.created_at DESC`,
    [campaignId, alcance.value.organizationId, alcance.value.soloVisibleParaTcl],
  );

  // El estado técnico del procesamiento (errores, reintentos) es interno.
  return ok(
    alcance.value.soloVisibleParaTcl
      ? rows.map((r) => ({
          ...r,
          job_status: null,
          job_intentos: null,
          job_error: null,
          job_disponible_en: null,
        }))
      : rows,
  );
}

export async function getFragments(
  actor: User,
  sourceId: string,
  limite = 200,
): Promise<Result<FragmentRow[]>> {
  const { rows: fuentes } = await getPool().query<{
    campaign_id: string;
    organization_id: string;
    visibility: Visibility;
  }>(`SELECT campaign_id, organization_id, visibility FROM source_documents WHERE id = $1`, [sourceId]);
  const fuente = fuentes[0];

  // Sin la capacidad, el error es de rol aunque la fuente no exista (no hay
  // nada que proteger todavía); con la capacidad, todo lo demás es «no existe».
  if (!roleCan(actor.role, 'source:read') && !roleCan(actor.role, 'source:read_shared')) {
    return err({
      code: 'FORBIDDEN_ROLE',
      message: `El rol ${actor.role} no puede ejecutar la acción source:read.`,
      details: { action: 'source:read', role: actor.role },
    });
  }
  if (!fuente) return err(NO_ENCONTRADO);

  const alcance = await resolverAlcanceDeFuentes(actor, fuente.campaign_id);
  if (!alcance.ok) return err(NO_ENCONTRADO);
  if (fuente.organization_id !== alcance.value.organizationId) return err(NO_ENCONTRADO);
  if (alcance.value.soloVisibleParaTcl && !isTclVisible(fuente.visibility)) return err(NO_ENCONTRADO);

  const { rows } = await getPool().query<FragmentRow>(
    `SELECT id, ordinal, page, slide, section, linea, text, metadata
       FROM source_fragments WHERE source_id = $1 ORDER BY ordinal LIMIT $2`,
    [sourceId, limite],
  );
  return ok(rows);
}

// ─────────────────────────── Visibilidad ──────────────────────────────────────

const VISIBILIDADES: readonly Visibility[] = ['interna', 'tcl', 'compartida'];

/**
 * Decide si una fuente es visible para TCL (V2 · Fase 1A). Es una decisión
 * explícita y auditada de SmartPR: ninguna fuente se expone por defecto
 * (`visibility` nace `interna`) ni por pertenecer a una campaña visible.
 */
export async function setSourceVisibility(
  actor: User,
  sourceId: string,
  visibility: Visibility,
): Promise<Result<{ visibility: Visibility }>> {
  const permitido = assertCapability(actor, 'source:set_visibility');
  if (!permitido.ok) return err({ code: permitido.error.code, message: permitido.error.message });

  if (!VISIBILIDADES.includes(visibility)) {
    return err({
      code: 'BRIEF_FIELD_INVALID',
      message: `«${String(visibility)}» no es una visibilidad válida.`,
    });
  }

  const { rows } = await getPool().query<{ visibility: Visibility; filename: string }>(
    `SELECT visibility, filename FROM source_documents WHERE id = $1 AND organization_id = $2`,
    [sourceId, actor.organizationId],
  );
  const fuente = rows[0];
  if (!fuente) return err(NO_ENCONTRADO);
  if (fuente.visibility === visibility) return ok({ visibility });

  await transaction(async (client) => {
    await client.query(`UPDATE source_documents SET visibility = $1::visibility_level WHERE id = $2`, [
      visibility,
      sourceId,
    ]);
    await recordAudit(client, {
      actor,
      action: 'source.set_visibility',
      entityType: 'source_document',
      entityId: sourceId,
      metadata: { from: fuente.visibility, to: visibility, filename: fuente.filename },
    });
  });

  return ok({ visibility });
}

// ─────────────────────────── Carga ────────────────────────────────────────────

export interface UploadInput {
  readonly campaignId: string;
  readonly filename: string;
  readonly contenido: Uint8Array;
  readonly tipoDeclarado?: string | undefined;
  readonly type?: SourceType | undefined;
}

export interface UploadResultado {
  readonly id: string;
  readonly mimeType: string;
  readonly encolado: boolean;
  readonly aviso?: string | undefined;
}

function maxBytes(): number {
  const mb = Number(process.env['MAX_UPLOAD_MB'] ?? '50');
  return (Number.isFinite(mb) && mb > 0 ? mb : 50) * 1024 * 1024;
}

/**
 * Carga una fuente: valida por contenido real, calcula hash, guarda el original
 * y encola el procesamiento (E4-1, E4-3, E4-4).
 *
 * La respuesta es inmediata: el trabajo pesado ocurre en el worker. Un PPT de
 * 25 MB tarda ~6 s en procesarse; bloquear la interfaz ese tiempo sería
 * inaceptable (criterio de la Épica E4).
 */
export async function uploadSource(actor: User, input: UploadInput): Promise<Result<UploadResultado>> {
  const permitido = assertCapability(actor, 'source:upload');
  if (!permitido.ok) return err({ code: permitido.error.code, message: permitido.error.message });

  if (!(await campanaPropia(actor, input.campaignId))) {
    return err({ code: 'RESOURCE_NOT_FOUND', message: 'El recurso no existe o no está disponible.' });
  }

  // Validación por contenido real, no por extensión (caso S-05).
  const validacion = validarArchivo(
    input.contenido,
    input.contenido.byteLength,
    maxBytes(),
    input.tipoDeclarado,
    input.filename,
  );

  if (!validacion.valido || validacion.mimeType === undefined) {
    return err({
      code: 'BRIEF_MISSING_CRITICAL_FIELD',
      message: validacion.motivo ?? 'El archivo no es válido.',
    });
  }

  const mimeType = validacion.mimeType;
  const almacenado = await guardarOriginal(input.contenido, actor.organizationId, input.filename);

  // Duplicado en la misma campaña (E4-3): se detecta por hash, no por nombre.
  const { rows: existentes } = await getPool().query<{ id: string; filename: string }>(
    `SELECT id, filename FROM source_documents WHERE campaign_id = $1 AND hash = $2`,
    [input.campaignId, almacenado.hash],
  );
  const duplicado = existentes[0];
  if (duplicado !== undefined) {
    return err({
      code: 'BRIEF_MISSING_CRITICAL_FIELD',
      message: `Este archivo ya está cargado en la campaña como «${duplicado.filename}». Es el mismo contenido, aunque el nombre difiera.`,
    });
  }

  const conExtraccion = FORMATOS_CON_EXTRACCION.includes(mimeType);

  const id = await transaction(async (client) => {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO source_documents
              (campaign_id, organization_id, type, filename, file_id, storage_provider,
               mime_type, size_bytes, hash, status, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING id`,
      [
        input.campaignId,
        actor.organizationId,
        input.type ?? 'otro',
        input.filename,
        almacenado.fileId,
        almacenado.provider,
        mimeType,
        almacenado.sizeBytes,
        almacenado.hash,
        conExtraccion ? 'pendiente' : 'procesado',
        actor.id,
      ],
    );
    const sourceId = rows[0]!.id;

    // Solo se encola lo que tiene extracción automática. Una imagen se conserva
    // y queda disponible, pero su OCR llega en E4-7.
    if (conExtraccion) {
      await client.query(`INSERT INTO processing_jobs (source_id) VALUES ($1)`, [sourceId]);
    }

    await recordAudit(client, {
      actor,
      action: 'source.upload',
      entityType: 'source_document',
      entityId: sourceId,
      metadata: {
        filename: input.filename,
        mimeType,
        sizeBytes: almacenado.sizeBytes,
        encolado: conExtraccion,
      },
    });

    return sourceId;
  });

  return ok({
    id,
    mimeType,
    encolado: conExtraccion,
    aviso: conExtraccion
      ? validacion.motivo
      : (validacion.motivo ?? 'El archivo se conserva, pero su texto requiere OCR (pendiente en esta fase).'),
  });
}

// ─────────────────────────── Reintento (E4-9) ─────────────────────────────────

export async function retrySource(actor: User, sourceId: string): Promise<Result<true>> {
  const permitido = assertCapability(actor, 'source:process');
  if (!permitido.ok) return err({ code: permitido.error.code, message: permitido.error.message });

  const { rows } = await getPool().query<{ id: string; filename: string }>(
    `SELECT id, filename FROM source_documents WHERE id = $1 AND organization_id = $2`,
    [sourceId, actor.organizationId],
  );
  const fuente = rows[0];
  if (fuente === undefined) {
    return err({ code: 'RESOURCE_NOT_FOUND', message: 'El recurso no existe o no está disponible.' });
  }

  await transaction(async (client) => {
    // El índice parcial `processing_jobs_activo_key` impide dos jobs activos
    // para el mismo documento, así que se cierra el anterior antes de encolar.
    await client.query(
      `UPDATE processing_jobs SET status = 'fallido', finished_at = now()
        WHERE source_id = $1 AND status IN ('pendiente', 'ejecutando')`,
      [sourceId],
    );
    await client.query(`INSERT INTO processing_jobs (source_id) VALUES ($1)`, [sourceId]);
    await client.query(`UPDATE source_documents SET status = 'pendiente' WHERE id = $1`, [sourceId]);

    await recordAudit(client, {
      actor,
      action: 'source.retry',
      entityType: 'source_document',
      entityId: sourceId,
      metadata: { filename: fuente.filename },
    });
  });

  return ok(true);
}

export { rutaAbsoluta };
