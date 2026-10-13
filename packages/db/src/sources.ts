/**
 * Repositorio de fuentes documentales (Épica E4).
 *
 * Igual que en campañas: la política la decide `packages/domain`, aquí solo se
 * aplica, y toda consulta filtra además por organización en el propio SQL.
 */

import {
  FORMATOS_CON_EXTRACCION,
  analizarEnlaceDeFuente,
  esHojaDeCalculo,
  etiquetaDeProveedor,
  isTclVisible,
  roleCan,
  validarArchivo,
  type ConfidentialityLevel,
  type Result,
  type SourceLocator,
  type User,
  type Visibility,
  err,
  ok,
} from '@tcl-kol-os/domain';
import { assertCapability } from './authz.ts';
import { getPool, transaction } from './client.ts';
import { recordAudit } from './audit.ts';
import { type ContextoDeAuditoria, auditoriaDe, exigirPersona } from './audit-context.ts';
import { SQL_FRAGMENTO_VIGENTE_SIN_ALIAS } from './fragment-scope.ts';
import { localizadorDeFila } from './locators.ts';
import {
  SQL_FUENTE_SIN_EVIDENCIA_OPERATIVA,
  SQL_FUENTE_SIN_EVIDENCIA_OPERATIVA_SIN_ALIAS,
  esEvidenciaOperativa,
} from './ops-source-scope.ts';
import { sqlFuenteSinGuionNoAprobado } from './script-scope.ts';
import { guardarOriginal, rutaAbsoluta } from './storage.ts';
import { Abortar, transaccionConResultado } from './tx-result.ts';

export type SourceType = 'ppt_global' | 'ficha_tecnica' | 'brief_cliente' | 'imagen' | 'otro';
/**
 * `por_resolver` (V2 · Fase 4): fuente enlazada registrada cuyo contenido aún no
 * se resuelve; no hay job ni lectura externa.
 */
export type SourceStatus = 'pendiente' | 'por_resolver' | 'procesando' | 'procesado' | 'fallido';
/** Una fuente es un archivo subido o un enlace externo (V2 · Fase 4). */
export type SourceOrigin = 'file' | 'link';

export interface SourceRow {
  readonly id: string;
  readonly campaign_id: string;
  readonly type: SourceType;
  /** Nombre del archivo, o el título de un enlace. */
  readonly filename: string;
  readonly origin: SourceOrigin;
  /** Solo archivos; `null` en enlaces. */
  readonly mime_type: string | null;
  readonly size_bytes: string | null;
  readonly hash: string | null;
  /** Solo enlaces: proveedor reconocido, URL registrada y URL canónica. */
  readonly external_provider: string | null;
  readonly external_url: string | null;
  readonly canonical_url: string | null;
  /** Solo enlaces sincronizados: el snapshot vigente (V2 · Fase 5). */
  readonly current_snapshot_id: string | null;
  readonly status: SourceStatus;
  /**
   * Clasificación de la fuente (V2 · Fase 6). La necesita la política de lectura
   * para IA (`fuenteLegibleParaIA`): una fuente `sensible` nunca llega a un modelo.
   */
  readonly confidentiality_level: ConfidentialityLevel;
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
  /** Ubicación con el contrato único (página, diapositiva, sección, hoja, fila, rango…). */
  readonly locator: SourceLocator | undefined;
  readonly text: string;
  readonly metadata: Record<string, unknown>;
  /**
   * Snapshot del que sale el fragmento (V2 · Fase 6); `null` en fuentes-archivo.
   * Permite anclar una cita a la lectura concreta (los snapshots son inmutables).
   */
  readonly snapshotId: string | null;
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
 *  · Cliente: sin alcance (no tiene `source:read`; lo suyo va por la proyección TCL).
 */
export interface AlcanceDeFuentes {
  /** Organización dueña de las fuentes (la de la campaña, no la del actor). */
  readonly organizationId: string;
  readonly soloVisibleParaTcl: boolean;
  /**
   * V2 · Fase 7: no lee las fuentes ligadas a una versión de guion NO aprobada. Lo fija el rol:
   * quien tiene `source:read` pero no `script:read` (el Operativo) y, defensivamente, TCL.
   */
  readonly excluirGuionesNoAprobados: boolean;
  /**
   * V2 · Fase 8: la evidencia operativa (`soporte_operativo`) no se lee por las fuentes para NINGÚN rol;
   * solo los casos de uso de evidencia operativa la exponen. Siempre `true`.
   */
  readonly excluirEvidenciaOperativa: true;
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
    return ok({
      organizationId: actor.organizationId,
      soloVisibleParaTcl: false,
      excluirGuionesNoAprobados: !roleCan(actor.role, 'script:read'),
      excluirEvidenciaOperativa: true,
    });
  }

  return err({
    code: 'FORBIDDEN_ROLE',
    message: `El rol ${actor.role} no puede ejecutar la acción source:read.`,
    details: { action: 'source:read', role: actor.role },
  });
}

// ─────────────────────────── Consultas ────────────────────────────────────────

const SELECT_SOURCES = `
  SELECT s.id, s.campaign_id, s.type, s.filename, s.origin::text AS origin, s.mime_type,
         s.size_bytes::text AS size_bytes, s.hash,
         s.external_provider, s.external_url, s.canonical_url, s.current_snapshot_id, s.status,
         s.confidentiality_level::text AS confidentiality_level, s.created_at,
         (SELECT count(*)::int FROM source_fragments f
           WHERE f.source_id = s.id
             AND (f.snapshot_id IS NULL OR f.snapshot_id = s.current_snapshot_id)) AS fragmentos,
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
        AND ${sqlFuenteSinGuionNoAprobado('$4')}
        AND ${SQL_FUENTE_SIN_EVIDENCIA_OPERATIVA}
      ORDER BY s.created_at DESC`,
    [
      campaignId,
      alcance.value.organizationId,
      alcance.value.soloVisibleParaTcl,
      alcance.value.excluirGuionesNoAprobados,
    ],
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

/**
 * Autoriza la lectura de UNA fuente por id con el mismo alcance que el listado
 * (`resolverAlcanceDeFuentes`). Es el único camino de lectura por id: lo usan
 * `getSource`, `getFragments` y la representación normalizada.
 */
async function autorizarLecturaDeFuente(
  actor: User,
  sourceId: string,
): Promise<Result<{ campaignId: string; organizationId: string; soloVisibleParaTcl: boolean }>> {
  const { rows: fuentes } = await getPool().query<{
    campaign_id: string;
    organization_id: string;
    visibility: Visibility;
    guion_no_aprobado: boolean;
    type: string;
  }>(
    `SELECT campaign_id, organization_id, visibility, type::text AS type,
            EXISTS (SELECT 1 FROM script_versions sv WHERE sv.source_document_id = source_documents.id
                     AND sv.status <> 'approved') AS guion_no_aprobado
       FROM source_documents WHERE id = $1`,
    [sourceId],
  );
  const fuente = fuentes[0];

  // Sin la capacidad, el error es de rol aunque la fuente no exista (no hay
  // nada que proteger todavía); con la capacidad, todo lo demás es «no existe».
  if (!roleCan(actor.role, 'source:read')) {
    return err({
      code: 'FORBIDDEN_ROLE',
      message: `El rol ${actor.role} no puede ejecutar la acción source:read.`,
      details: { action: 'source:read', role: actor.role },
    });
  }
  if (!fuente) return err(NO_ENCONTRADO);
  // V2 · Fase 8: la evidencia operativa no se lee como fuente (para ningún rol).
  if (esEvidenciaOperativa(fuente.type)) return err(NO_ENCONTRADO);

  const alcance = await resolverAlcanceDeFuentes(actor, fuente.campaign_id);
  if (!alcance.ok) return err(NO_ENCONTRADO);
  if (fuente.organization_id !== alcance.value.organizationId) return err(NO_ENCONTRADO);
  if (alcance.value.soloVisibleParaTcl && !isTclVisible(fuente.visibility)) return err(NO_ENCONTRADO);
  // V2 · Fase 7: un guion no aprobado no lo lee quien no revisa guiones (Operativo).
  if (alcance.value.excluirGuionesNoAprobados && fuente.guion_no_aprobado) return err(NO_ENCONTRADO);

  return ok({
    campaignId: fuente.campaign_id,
    organizationId: fuente.organization_id,
    soloVisibleParaTcl: alcance.value.soloVisibleParaTcl,
  });
}

/** Una fuente por id (archivo o enlace), con el alcance de lectura del actor. */
export async function getSource(actor: User, sourceId: string): Promise<Result<SourceRow>> {
  const alcance = await autorizarLecturaDeFuente(actor, sourceId);
  if (!alcance.ok) return err({ code: alcance.error.code, message: alcance.error.message });

  const { rows } = await getPool().query<SourceRow>(
    `${SELECT_SOURCES} WHERE s.id = $1 AND ${SQL_FUENTE_SIN_EVIDENCIA_OPERATIVA}`,
    [sourceId],
  );
  const fila = rows[0];
  if (!fila) return err(NO_ENCONTRADO);
  return ok(
    alcance.value.soloVisibleParaTcl
      ? { ...fila, job_status: null, job_intentos: null, job_error: null, job_disponible_en: null }
      : fila,
  );
}

interface FilaDeFragmento extends Omit<FragmentRow, 'locator'> {
  readonly locator: unknown;
}

function comoFragmento(fila: FilaDeFragmento): FragmentRow {
  return { ...fila, locator: localizadorDeFila(fila) };
}

export async function getFragments(
  actor: User,
  sourceId: string,
  limite = 200,
): Promise<Result<FragmentRow[]>> {
  const alcance = await autorizarLecturaDeFuente(actor, sourceId);
  if (!alcance.ok) return err({ code: alcance.error.code, message: alcance.error.message });

  const { rows } = await getPool().query<FilaDeFragmento>(
    `SELECT id, ordinal, page, slide, section, linea, locator, text, metadata, snapshot_id AS "snapshotId"
       FROM source_fragments WHERE source_id = $1 AND ${SQL_FRAGMENTO_VIGENTE_SIN_ALIAS}
      ORDER BY ordinal LIMIT $2`,
    [sourceId, limite],
  );
  return ok(rows.map(comoFragmento));
}

// ─────────────────────────── Representación normalizada ───────────────────────

/**
 * Lo que obtiene el agente (y cualquier consumidor) de una fuente, en un solo
 * sitio y con el mismo alcance de lectura que el resto:
 *
 *   original       la fuente tal como se registró (archivo con hash/MIME, o
 *                  enlace con su URL); NUNCA se reemplaza.
 *   estructura     el manifiesto normalizado de lo que no cabe en una lista de
 *                  fragmentos (hoy: hojas, tablas, cabeceras y rangos de un
 *                  libro de cálculo). `null` si el formato no la necesita.
 *   fragmentos     el contenido procesable, cada uno con su localizador para
 *                  volver al punto exacto del original.
 */
export interface RepresentacionNormalizada {
  readonly source: SourceRow;
  readonly original:
    | {
        readonly origin: 'file';
        readonly mimeType: string;
        readonly sizeBytes: string;
        readonly hash: string;
      }
    | {
        readonly origin: 'link';
        readonly provider: string;
        readonly url: string;
        readonly canonicalUrl: string;
      };
  readonly estructura: {
    readonly format: string;
    readonly generator: string;
    readonly content: Record<string, unknown>;
  } | null;
  /**
   * Solo enlaces sincronizados (V2 · Fase 5): de QUÉ lectura salen la estructura
   * y los fragmentos devueltos — el snapshot vigente. `null` si aún no hay.
   */
  readonly snapshot: {
    readonly id: string;
    readonly sequence: number;
    readonly fetchedAt: string;
    readonly contentHash: string;
  } | null;
  readonly fragmentos: {
    readonly total: number;
    readonly items: readonly FragmentRow[];
  };
}

export async function obtenerRepresentacionNormalizada(
  actor: User,
  sourceId: string,
  opciones: { readonly limite?: number; readonly desde?: number } = {},
): Promise<Result<RepresentacionNormalizada>> {
  const fuente = await getSource(actor, sourceId);
  if (!fuente.ok) return fuente;
  const source = fuente.value;

  const limite = Math.min(Math.max(Math.trunc(opciones.limite ?? 200), 1), 1000);
  const desde = Math.max(Math.trunc(opciones.desde ?? 0), 0);

  // Un enlace sincronizado entrega la estructura de su snapshot VIGENTE; un
  // archivo, la suya de siempre (`source_representations`).
  const { rows: snapshots } = await getPool().query<{
    id: string;
    sequence: number;
    fetched_at: Date;
    content_hash: string;
    generator: string;
    structure: Record<string, unknown>;
  }>(
    `SELECT n.id, n.sequence, n.fetched_at, n.content_hash, n.generator, n.structure
       FROM source_snapshots n
       JOIN source_documents s ON s.current_snapshot_id = n.id
      WHERE s.id = $1`,
    [sourceId],
  );
  const vigente = snapshots[0];
  const { rows: estructuras } = await getPool().query<{
    format: string;
    generator: string;
    content: Record<string, unknown>;
  }>(
    `SELECT format, generator, content FROM source_representations WHERE source_id = $1 AND kind = 'structure'`,
    [sourceId],
  );
  const { rows: fragmentos } = await getPool().query<FilaDeFragmento>(
    `SELECT id, ordinal, page, slide, section, linea, locator, text, metadata, snapshot_id AS "snapshotId"
       FROM source_fragments
      WHERE source_id = $1 AND ordinal >= $2 AND ${SQL_FRAGMENTO_VIGENTE_SIN_ALIAS}
      ORDER BY ordinal LIMIT $3`,
    [sourceId, desde, limite],
  );
  const { rows: total } = await getPool().query<{ n: number }>(
    `SELECT count(*)::int AS n FROM source_fragments
      WHERE source_id = $1 AND ${SQL_FRAGMENTO_VIGENTE_SIN_ALIAS}`,
    [sourceId],
  );

  return ok({
    source,
    original:
      source.origin === 'link'
        ? {
            origin: 'link',
            provider: source.external_provider!,
            url: source.external_url!,
            canonicalUrl: source.canonical_url!,
          }
        : {
            origin: 'file',
            mimeType: source.mime_type!,
            sizeBytes: source.size_bytes!,
            hash: source.hash!,
          },
    estructura:
      vigente !== undefined
        ? { format: 'google_sheets', generator: vigente.generator, content: vigente.structure }
        : (estructuras[0] ?? null),
    snapshot:
      vigente === undefined
        ? null
        : {
            id: vigente.id,
            sequence: vigente.sequence,
            fetchedAt: vigente.fetched_at.toISOString(),
            contentHash: vigente.content_hash,
          },
    fragmentos: { total: total[0]?.n ?? 0, items: fragmentos.map(comoFragmento) },
  });
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
    `SELECT visibility, filename FROM source_documents s
      WHERE id = $1 AND organization_id = $2 AND ${SQL_FUENTE_SIN_EVIDENCIA_OPERATIVA}`,
    [sourceId, actor.organizationId],
  );
  const fuente = rows[0];
  if (!fuente) return err(NO_ENCONTRADO);
  if (fuente.visibility === visibility) return ok({ visibility });

  // V2 · Fase 7: la fuente de un guion que no es la aprobada vigente no se expone a TCL. La base
  // lo impone (trigger 023); aquí se devuelve un error accionable antes de tocarla.
  if (visibility !== 'interna') {
    const { rows: guiones } = await getPool().query<{ n: number }>(
      `SELECT count(*)::int AS n FROM script_versions WHERE source_document_id = $1 AND status <> 'approved'`,
      [sourceId],
    );
    if ((guiones[0]?.n ?? 0) > 0) {
      return err({
        code: 'RESOURCE_CONFLICT',
        message:
          'Esta fuente respalda una versión de guion que no es la aprobada vigente: no se expone a TCL.',
        details: { reason: 'bound_to_script_version' },
      });
    }
  }

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

function tipoReservado(): Result<never> {
  return err({
    code: 'VALIDATION_FAILED',
    message: 'El tipo de fuente no es válido.',
    details: { field: 'type', reason: 'reserved_source_type' },
  });
}

export interface UploadInput {
  readonly campaignId: string;
  readonly filename: string;
  readonly contenido: Uint8Array;
  readonly tipoDeclarado?: string | undefined;
  readonly type?: SourceType | undefined;
  /**
   * Opt-in (V2 · Fase 6, adjuntos del chat): si el mismo contenido ya está en la
   * campaña, en vez de `SOURCE_ALREADY_EXISTS` se devuelve la fuente existente con
   * `deduplicated: true`. Por defecto `false`: el comportamiento de siempre.
   */
  readonly vincularSiDuplicado?: boolean | undefined;
}

export interface UploadResultado {
  readonly id: string;
  readonly mimeType: string;
  readonly encolado: boolean;
  readonly aviso?: string | undefined;
  /** `true` solo con `vincularSiDuplicado`: se vinculó la fuente existente, no se creó otra. */
  readonly deduplicated?: boolean | undefined;
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
export async function uploadSource(
  actor: User,
  input: UploadInput,
  contexto?: ContextoDeAuditoria,
): Promise<Result<UploadResultado>> {
  const persona = exigirPersona(actor, contexto);
  if (!persona.ok) return persona;
  const permitido = assertCapability(actor, 'source:upload');
  if (!permitido.ok) return err({ code: permitido.error.code, message: permitido.error.message });

  // V2 · Fase 8: el tipo `soporte_operativo` lo crea solo el caso de uso de evidencia operativa.
  if (esEvidenciaOperativa(String(input.type))) return tipoReservado();

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
      // Los rechazos con causa propia (Office antiguo, libro con macros o
      // sospechoso) llevan su código semántico; el resto conserva el anterior.
      code: validacion.codigo ?? 'BRIEF_MISSING_CRITICAL_FIELD',
      message: validacion.motivo ?? 'El archivo no es válido.',
    });
  }

  const mimeType = validacion.mimeType;
  const almacenado = await guardarOriginal(input.contenido, actor.organizationId, input.filename);

  // Duplicado en la misma campaña (E4-3): se detecta por hash, no por nombre.
  const { rows: existentes } = await getPool().query<{ id: string; filename: string; type: string }>(
    `SELECT id, filename, type::text AS type FROM source_documents WHERE campaign_id = $1 AND hash = $2`,
    [input.campaignId, almacenado.hash],
  );
  const duplicado = existentes[0];
  // V2 · Fase 8: el mismo contenido ya es evidencia operativa de la campaña. Ni se vincula (adjuntos del
  // chat) ni se revelan su id o su nombre: es un conflicto genérico.
  if (duplicado !== undefined && esEvidenciaOperativa(duplicado.type)) {
    return err({
      code: 'SOURCE_ALREADY_EXISTS',
      message: 'Este archivo ya está cargado en la campaña (mismo contenido).',
      details: { reason: 'same_content' },
    });
  }
  if (duplicado !== undefined && input.vincularSiDuplicado === true) {
    return ok({ id: duplicado.id, mimeType, encolado: false, deduplicated: true });
  }
  if (duplicado !== undefined) {
    return err({
      code: 'SOURCE_ALREADY_EXISTS',
      message: `Este archivo ya está cargado en la campaña como «${duplicado.filename}». Es el mismo contenido, aunque el nombre difiera.`,
      details: { reason: 'same_content', sourceId: duplicado.id },
    });
  }

  const conExtraccion = FORMATOS_CON_EXTRACCION.includes(mimeType);

  const subida = await transaccionConResultado(
    async (client) => {
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

      await recordAudit(
        client,
        auditoriaDe(actor, contexto, {
          action: 'source.upload',
          entityType: 'source_document',
          entityId: sourceId,
          metadata: {
            filename: input.filename,
            mimeType,
            sizeBytes: almacenado.sizeBytes,
            encolado: conExtraccion,
            hojaDeCalculo: esHojaDeCalculo(mimeType),
          },
        }),
      );

      return sourceId;
    },
    {
      // Dos cargas simultáneas del mismo contenido: gana una, la otra es un duplicado.
      code: 'SOURCE_ALREADY_EXISTS',
      message: 'Este archivo ya está cargado en la campaña (mismo contenido).',
      details: { reason: 'same_content' },
    },
  );
  if (!subida.ok) return subida;
  const id = subida.value;

  return ok({
    id,
    mimeType,
    encolado: conExtraccion,
    aviso: conExtraccion
      ? validacion.motivo
      : (validacion.motivo ?? 'El archivo se conserva, pero su texto requiere OCR (pendiente en esta fase).'),
  });
}

// ─────────────────────────── Fuentes enlazadas (V2 · Fase 4) ──────────────────

export interface RegistrarEnlaceInput {
  readonly campaignId: string;
  readonly url: string;
  /** Nombre para mostrar; por defecto, el del proveedor. */
  readonly title?: string | undefined;
  readonly type?: SourceType | undefined;
}

export interface EnlaceRegistrado {
  readonly id: string;
  readonly provider: string;
  readonly externalId: string;
  readonly canonicalUrl: string;
  readonly status: SourceStatus;
}

const MAX_TITULO = 200;

const ENLACE_YA_REGISTRADO = {
  code: 'SOURCE_ALREADY_EXISTS',
  message: 'Este enlace ya está registrado en la campaña.',
  details: { reason: 'same_link' },
} as const;

/**
 * Registra una fuente cuyo origen es un enlace externo. SOLO registra: no
 * descarga, no consulta ni autentica contra el proveedor — no hay ninguna
 * llamada de red en esta ruta (la resolución del contenido será una
 * integración específica). La fuente nace `interna` y `por_resolver`; la
 * visibilidad hacia TCL es la misma decisión explícita de siempre
 * (`setSourceVisibility`).
 */
export async function registerLinkedSource(
  actor: User,
  input: RegistrarEnlaceInput,
  contexto?: ContextoDeAuditoria,
): Promise<Result<EnlaceRegistrado>> {
  const persona = exigirPersona(actor, contexto);
  if (!persona.ok) return persona;
  const permitido = assertCapability(actor, 'source:upload');
  if (!permitido.ok) return err({ code: permitido.error.code, message: permitido.error.message });

  // V2 · Fase 8: el tipo `soporte_operativo` lo crea solo el caso de uso de evidencia operativa.
  if (esEvidenciaOperativa(String(input.type))) return tipoReservado();

  if (!(await campanaPropia(actor, input.campaignId))) return err(NO_ENCONTRADO);

  const enlace = analizarEnlaceDeFuente(input.url);
  if (!enlace.ok) return enlace;
  const { provider, externalId, originalUrl, canonicalUrl, metadata } = enlace.value;

  const titulo = (input.title ?? '').replace(/\s+/gu, ' ').trim();
  if (titulo.length > MAX_TITULO) {
    return err({
      code: 'VALIDATION_FAILED',
      message: `El título no puede superar ${MAX_TITULO} caracteres.`,
      details: { field: 'title' },
    });
  }
  const nombre = titulo === '' ? `${etiquetaDeProveedor(provider)} · ${externalId.slice(0, 8)}…` : titulo;

  return transaccionConResultado(async (client) => {
    const { rows: existentes } = await client.query<{ id: string }>(
      `SELECT id FROM source_documents WHERE campaign_id = $1 AND canonical_url = $2 AND origin = 'link'`,
      [input.campaignId, canonicalUrl],
    );
    if (existentes[0] !== undefined) {
      throw new Abortar({
        ...ENLACE_YA_REGISTRADO,
        details: { reason: 'same_link', sourceId: existentes[0].id },
      });
    }

    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO source_documents
              (campaign_id, organization_id, type, filename, origin, status, created_by,
               external_provider, external_id, external_url, canonical_url, external_metadata)
       VALUES ($1, $2, $3, $4, 'link', 'por_resolver', $5, $6, $7, $8, $9, $10::jsonb)
       RETURNING id`,
      [
        input.campaignId,
        actor.organizationId,
        input.type ?? 'otro',
        nombre,
        actor.id,
        provider,
        externalId,
        originalUrl,
        canonicalUrl,
        JSON.stringify(metadata),
      ],
    );
    const id = rows[0]!.id;

    // La auditoría guarda la URL canónica, no la original: un enlace de Drive
    // puede traer una clave de acceso (`resourcekey`) que no debe viajar a logs.
    await recordAudit(
      client,
      auditoriaDe(actor, contexto, {
        action: 'source.link_register',
        entityType: 'source_document',
        entityId: id,
        metadata: { campaignId: input.campaignId, provider, externalId, canonicalUrl, title: nombre },
      }),
    );
    return { id, provider, externalId, canonicalUrl, status: 'por_resolver' as const };
  }, ENLACE_YA_REGISTRADO);
}

// ─────────────────────────── Reintento (E4-9) ─────────────────────────────────

export async function retrySource(actor: User, sourceId: string): Promise<Result<true>> {
  const permitido = assertCapability(actor, 'source:process');
  if (!permitido.ok) return err({ code: permitido.error.code, message: permitido.error.message });

  const { rows } = await getPool().query<{
    id: string;
    filename: string;
    origin: SourceOrigin;
    status: SourceStatus;
    ligada_a_guion: boolean;
  }>(
    `SELECT id, filename, origin::text AS origin, status::text AS status,
            EXISTS (SELECT 1 FROM script_versions sv WHERE sv.source_document_id = source_documents.id) AS ligada_a_guion
       FROM source_documents WHERE id = $1 AND organization_id = $2
        AND ${SQL_FUENTE_SIN_EVIDENCIA_OPERATIVA_SIN_ALIAS}`,
    [sourceId, actor.organizationId],
  );
  const fuente = rows[0];
  if (fuente === undefined) {
    return err({ code: 'RESOURCE_NOT_FOUND', message: 'El recurso no existe o no está disponible.' });
  }
  // Una fuente enlazada no tiene qué reprocesar: no hay contenido resuelto.
  if (fuente.origin === 'link') {
    return err({
      code: 'RESOURCE_CONFLICT',
      message: 'Una fuente enlazada no se reprocesa: su contenido aún no se resuelve.',
      details: { reason: 'link_not_processable' },
    });
  }

  // V2 · Fase 7: reprocesar regenera los fragmentos de los que citan la revisión y la aprobación de
  // un guion. Una fuente ligada a una versión de guion no se reprocesa, SALVO que su procesamiento
  // haya fallado (no hay contenido legible que proteger: es la única vía para destrabarla).
  if (fuente.ligada_a_guion && fuente.status !== 'fallido') {
    return err({
      code: 'RESOURCE_CONFLICT',
      message:
        'Esta fuente es un guion registrado: no se reprocesa (cambiaría el contenido sobre el que se revisó). Registre una versión nueva.',
      details: { reason: 'bound_to_script_version' },
    });
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
