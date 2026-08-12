/**
 * Repositorio de fuentes documentales (Épica E4).
 *
 * Igual que en campañas: la política la decide `packages/domain`, aquí solo se
 * aplica, y toda consulta filtra además por organización en el propio SQL.
 */

import {
  FORMATOS_CON_EXTRACCION,
  roleCan,
  validarArchivo,
  type Action,
  type Result,
  type User,
  err,
  ok,
} from '@tcl-kol-os/domain';
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

function assertCapability(actor: User, action: Action): Result<true> {
  if (actor.status !== 'activo') {
    return err({ code: 'FORBIDDEN_ROLE', message: 'El usuario no está activo.' });
  }
  if (!roleCan(actor.role, action)) {
    return err({
      code: 'FORBIDDEN_ROLE',
      message: `El rol ${actor.role} no puede ejecutar la acción ${action}.`,
    });
  }
  return ok(true);
}

/** Comprueba que la campaña pertenece a la organización del actor. */
async function campanaPropia(actor: User, campaignId: string): Promise<boolean> {
  const { rows } = await getPool().query<{ id: string }>(
    `SELECT id FROM campaigns WHERE id = $1 AND organization_id = $2`,
    [campaignId, actor.organizationId],
  );
  return rows.length > 0;
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
  const permitido = assertCapability(actor, 'source:read');
  if (!permitido.ok) return err({ code: permitido.error.code, message: permitido.error.message });

  if (!(await campanaPropia(actor, campaignId))) {
    return err({ code: 'RESOURCE_NOT_FOUND', message: 'El recurso no existe o no está disponible.' });
  }

  const { rows } = await getPool().query<SourceRow>(
    `${SELECT_SOURCES} WHERE s.campaign_id = $1 AND s.organization_id = $2 ORDER BY s.created_at DESC`,
    [campaignId, actor.organizationId],
  );
  return ok(rows);
}

export async function getFragments(
  actor: User,
  sourceId: string,
  limite = 200,
): Promise<Result<FragmentRow[]>> {
  const permitido = assertCapability(actor, 'source:read');
  if (!permitido.ok) return err({ code: permitido.error.code, message: permitido.error.message });

  const { rows: propias } = await getPool().query<{ id: string }>(
    `SELECT id FROM source_documents WHERE id = $1 AND organization_id = $2`,
    [sourceId, actor.organizationId],
  );
  if (propias.length === 0) {
    return err({ code: 'RESOURCE_NOT_FOUND', message: 'El recurso no existe o no está disponible.' });
  }

  const { rows } = await getPool().query<FragmentRow>(
    `SELECT id, ordinal, page, slide, section, linea, text, metadata
       FROM source_fragments WHERE source_id = $1 ORDER BY ordinal LIMIT $2`,
    [sourceId, limite],
  );
  return ok(rows);
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
