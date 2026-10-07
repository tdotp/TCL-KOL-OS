/**
 * Evidencia operativa (V2 · Fase 8, DEC-049): el soporte de un envío, un documento de cobro o un pago.
 *
 * La evidencia es una FUENTE (`source_documents`, tipo `soporte_operativo`) — no hay un segundo almacén de
 * documentos. Nace confidencial (`sensible`), interna, `procesado`, SIN `processing_jobs` ni fragmentos (la
 * base lo impone con triggers en la 031): no se indexa, no se busca, no llega al agente ni a TCL. Solo estos
 * casos de uso la exponen (nombre, hash, tamaño y tipo; NUNCA el contenido), con la capacidad de su sujeto:
 * envío ⇒ `shipment:read`; documento de cobro y pago ⇒ `finance:read`.
 *
 *  · `subirEvidenciaOperativa` (dentro de una transacción) valida el archivo por contenido real, guarda el
 *    original con el mismo almacenamiento y hash que `uploadSource`, y crea la fuente. Si el mismo contenido ya
 *    existe en la campaña (UNIQUE(campaign_id, hash)) REUTILIZA esa fuente en vez de duplicar o fallar — pero
 *    solo si ya es soporte operativo: un guion o un brief con los mismos bytes no se convierte en evidencia.
 *  · `adjuntarEvidenciaOperativa` añade soporte a un sujeto existente con un evento `evidence.attached` (la
 *    evidencia de un evento se adjunta en la MISMA transacción que el evento).
 *  · `retractarEvidencia` marca (no borra) el vínculo.
 *
 * La auditoría lleva solo ids, tipo y conteos: jamás nombres de archivo ni contenido.
 */

import type pg from 'pg';
import {
  type Action,
  type EvidenceKind,
  type OperationalSubjectType,
  type Result,
  type User,
  authorizeInternalResource,
  err,
  isEvidenceKind,
  isOperationalSubjectType,
  manageActionForSubject,
  ok,
  readActionForSubject,
  roleCan,
  validarArchivo,
} from '@tcl-kol-os/domain';
import { recordAudit } from './audit.ts';
import { type ContextoDeAuditoria, auditoriaDe } from './audit-context.ts';
import { getPool, query } from './client.ts';
import { NO_ENCONTRADO_DE_CONTENIDO, esUuid } from './deliverables.ts';
import {
  type ResultadoDeEvento,
  aplicarEventoOperativo,
  autorizarOAbortar,
  exigirPersonaPorUiOAbortar,
  sujetoDeEvento,
  transaccionOperativa,
} from './operational-events.ts';
import { guardarOriginal } from './storage.ts';
import { Abortar } from './tx-result.ts';

// ─────────────────────────── Subida ────────────────────────────────────────────

export interface ArchivoDeEvidencia {
  readonly filename: string;
  readonly contenido: Uint8Array;
  /** MIME que declara el navegador; el tipo real se detecta por el contenido. */
  readonly tipoDeclarado?: string | undefined;
}

export interface SubirEvidenciaInput {
  readonly actor: User;
  readonly contexto?: ContextoDeAuditoria | undefined;
  readonly campaignId: string;
  readonly archivo: ArchivoDeEvidencia;
}

export interface EvidenciaSubida {
  /** La fuente `soporte_operativo` (nueva o reutilizada). */
  readonly sourceDocumentId: string;
  /** `true` si el mismo contenido ya era evidencia de la campaña: se reutilizó la fuente. */
  readonly reutilizada: boolean;
  readonly mimeType: string;
  readonly sizeBytes: number;
}

function maxBytes(): number {
  const mb = Number(process.env['MAX_UPLOAD_MB'] ?? '50');
  return (Number.isFinite(mb) && mb > 0 ? mb : 50) * 1024 * 1024;
}

const MAX_NOMBRE_DE_ARCHIVO = 200;

/** Nombre para mostrar: sin ruta, sin caracteres de control, acotado. El original vive por `fileId`, no por nombre. */
export function nombreSeguroDeEvidencia(nombre: unknown): string | undefined {
  if (typeof nombre !== 'string') return undefined;
  const base = nombre.split(/[\\/]/u).pop() ?? '';
  const limpio = base.replace(/[\p{Cc}\p{Cf}]/gu, '').trim();
  if (limpio === '' || limpio === '.' || limpio === '..') return undefined;
  return limpio.length > MAX_NOMBRE_DE_ARCHIVO ? limpio.slice(0, MAX_NOMBRE_DE_ARCHIVO) : limpio;
}

/**
 * Sube (o reutiliza) un archivo como evidencia operativa DENTRO de la transacción del llamador. Lanza `Abortar`.
 * Exige `ops_evidence:attach` sobre la organización de la campaña; campaña ajena ⇒ `RESOURCE_NOT_FOUND`.
 */
export async function subirEvidenciaOperativa(
  client: pg.PoolClient,
  input: SubirEvidenciaInput,
): Promise<EvidenciaSubida> {
  const actor = exigirPersonaPorUiOAbortar(input.actor, input.contexto);
  if (!esUuid(input.campaignId)) throw new Abortar(NO_ENCONTRADO_DE_CONTENIDO);
  const { rows: campanas } = await client.query<{ organization_id: string }>(
    `SELECT organization_id FROM campaigns WHERE id = $1`,
    [input.campaignId],
  );
  const campana = campanas[0];
  if (campana === undefined) throw new Abortar(NO_ENCONTRADO_DE_CONTENIDO);
  autorizarOAbortar(actor, 'ops_evidence:attach', campana.organization_id);

  const nombre = nombreSeguroDeEvidencia(input.archivo.filename);
  if (nombre === undefined) {
    throw new Abortar({
      code: 'VALIDATION_FAILED',
      message: 'El archivo necesita un nombre válido.',
      details: { field: 'filename' },
    });
  }
  // Validación por contenido real, no por extensión (mismo criterio que `uploadSource`).
  const contenido = input.archivo.contenido;
  const validacion = validarArchivo(
    contenido,
    contenido.byteLength,
    maxBytes(),
    input.archivo.tipoDeclarado,
    nombre,
  );
  if (!validacion.valido || validacion.mimeType === undefined) {
    throw new Abortar({
      code: validacion.codigo ?? 'VALIDATION_FAILED',
      message: validacion.motivo ?? 'El archivo no es válido.',
      details: { field: 'archivo' },
    });
  }
  const mimeType = validacion.mimeType;
  const almacenado = await guardarOriginal(contenido, campana.organization_id, nombre);

  const buscar = async (): Promise<{ id: string; type: string } | undefined> => {
    const { rows } = await client.query<{ id: string; type: string }>(
      `SELECT id, type::text AS type FROM source_documents WHERE campaign_id = $1 AND hash = $2`,
      [input.campaignId, almacenado.hash],
    );
    return rows[0];
  };

  let existente = await buscar();
  let reutilizada = existente !== undefined;
  if (existente === undefined) {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO source_documents
         (campaign_id, organization_id, type, filename, file_id, storage_provider, mime_type, size_bytes, hash,
          status, confidentiality_level, visibility, created_by)
       VALUES ($1, $2, 'soporte_operativo', $3, $4, $5, $6, $7, $8, 'procesado', 'sensible', 'interna', $9)
       ON CONFLICT (campaign_id, hash) DO NOTHING
       RETURNING id`,
      [
        input.campaignId,
        campana.organization_id,
        nombre,
        almacenado.fileId,
        almacenado.provider,
        mimeType,
        almacenado.sizeBytes,
        almacenado.hash,
        actor.id,
      ],
    );
    if (rows[0] === undefined) {
      // Otra transacción la creó entre la lectura y la inserción: se reutiliza.
      existente = await buscar();
      reutilizada = true;
    } else {
      existente = { id: rows[0].id, type: 'soporte_operativo' };
    }
  }
  if (existente === undefined || existente.type !== 'soporte_operativo') {
    // El mismo contenido ya está en la campaña como OTRO tipo de fuente: no se convierte en evidencia.
    throw new Abortar({
      code: 'RESOURCE_CONFLICT',
      message:
        'Ese contenido ya existe en la campaña como otra fuente y no puede usarse como evidencia operativa.',
      details: { reason: 'hash_in_other_source' },
    });
  }

  await recordAudit(
    client,
    auditoriaDe(actor, input.contexto, {
      action: 'ops_evidence.uploaded',
      entityType: 'source_document',
      entityId: existente.id,
      metadata: { sourceId: existente.id, campaignId: input.campaignId, replayed: reutilizada },
    }),
  );
  return { sourceDocumentId: existente.id, reutilizada, mimeType, sizeBytes: almacenado.sizeBytes };
}

// ─────────────────────────── Adjuntar a un sujeto existente ────────────────────

export interface AdjuntarEvidenciaInput {
  readonly subjectType: OperationalSubjectType;
  readonly subjectId: string;
  /** `row_seq` que el llamador vio del sujeto. */
  readonly expectedSeq: number;
  readonly idempotencyKey: string;
  readonly kind: EvidenceKind;
  readonly archivo: ArchivoDeEvidencia;
  /** Nota interna del evento (no a auditoría ni al agente). */
  readonly note?: string | undefined;
}

/** Organización y campaña del sujeto (lectura sin bloqueo: no cambian). */
async function propietariaDeSujeto(
  tipo: OperationalSubjectType,
  id: string,
): Promise<{ organizationId: string; campaignId: string } | undefined> {
  if (!isOperationalSubjectType(tipo) || !esUuid(id)) return undefined;
  const sql =
    tipo === 'shipment'
      ? `SELECT organization_id, campaign_id FROM shipments WHERE id = $1`
      : tipo === 'billing_document'
        ? `SELECT organization_id, campaign_id FROM billing_documents WHERE id = $1`
        : `SELECT organization_id, campaign_id FROM payment_obligations WHERE id = $1`;
  const filas = await query<{ organization_id: string; campaign_id: string }>(sql, [id]);
  const f = filas[0];
  return f === undefined ? undefined : { organizationId: f.organization_id, campaignId: f.campaign_id };
}

/**
 * Adjunta soporte a un envío, documento de cobro u obligación de pago con un evento `evidence.attached`
 * (sube o reutiliza la fuente en la misma transacción). Capacidades: `ops_evidence:attach` y la de lectura del
 * sujeto (`shipment:read` | `finance:read`). Idempotente por `idempotencyKey`.
 */
export async function adjuntarEvidenciaOperativa(
  actor: User,
  input: AdjuntarEvidenciaInput,
  contexto?: ContextoDeAuditoria,
): Promise<Result<ResultadoDeEvento>> {
  if (!isEvidenceKind(input.kind)) {
    return err({
      code: 'VALIDATION_FAILED',
      message: 'El tipo de soporte no es válido.',
      details: { field: 'kind' },
    });
  }
  const propietaria = await propietariaDeSujeto(input.subjectType, input.subjectId);
  return transaccionOperativa(async (client) => {
    if (propietaria === undefined) throw new Abortar(NO_ENCONTRADO_DE_CONTENIDO);
    const persona = exigirPersonaPorUiOAbortar(actor, contexto);
    autorizarOAbortar(persona, readActionForSubject(input.subjectType), propietaria.organizationId);
    const subida = await subirEvidenciaOperativa(client, {
      actor: persona,
      contexto,
      campaignId: propietaria.campaignId,
      archivo: input.archivo,
    });
    return aplicarEventoOperativo(client, {
      actor: persona,
      contexto,
      action: 'ops_evidence:attach',
      sujeto: { tipo: input.subjectType, id: input.subjectId },
      eventType: 'evidence.attached',
      toStatus: null,
      expectedSeq: input.expectedSeq,
      idempotencyKey: input.idempotencyKey,
      note: input.note,
      evidencias: [{ sourceDocumentId: subida.sourceDocumentId, kind: input.kind }],
      auditoria: { kind: input.kind },
    });
  });
}

// ─────────────────────────── Retirar ───────────────────────────────────────────

export interface EvidenciaRetirada {
  readonly evidenceId: string;
  readonly retractedAt: string;
}

/**
 * Retira (marca, no borra) un vínculo de evidencia. La fuente y el evento se conservan. Una sola vez:
 * retirar lo ya retirado es `RESOURCE_CONFLICT`. Exige `ops_evidence:attach` MÁS la capacidad de GESTIÓN del
 * SUJETO de la evidencia (envío ⇒ `shipment:manage`; documento de cobro u obligación de pago ⇒ `billing:manage`),
 * y, si el soporte es el de un pago reportado (evento `payment.reported` u obligación `reported_paid`),
 * `payment:report`: quien no puede reportar un pago no altera su soporte. Ajeno ⇒ `RESOURCE_NOT_FOUND`.
 */
export async function retractarEvidencia(
  actor: User,
  evidenceId: string,
  contexto?: ContextoDeAuditoria,
): Promise<Result<EvidenciaRetirada>> {
  return transaccionOperativa(async (client) => {
    const persona = exigirPersonaPorUiOAbortar(actor, contexto);
    if (!esUuid(evidenceId)) throw new Abortar(NO_ENCONTRADO_DE_CONTENIDO);
    const { rows } = await client.query<{
      organization_id: string;
      event_id: string;
      kind: string;
      retracted_at: Date | null;
    }>(
      `SELECT organization_id, event_id, kind, retracted_at FROM operational_evidence WHERE id = $1 FOR UPDATE`,
      [evidenceId],
    );
    const fila = rows[0];
    if (fila === undefined) throw new Abortar(NO_ENCONTRADO_DE_CONTENIDO);
    autorizarOAbortar(persona, 'ops_evidence:attach', fila.organization_id);
    // La capacidad del SUJETO de la evidencia (no solo la genérica de adjuntar).
    const { rows: deSujeto } = await client.query<{
      subject_type: OperationalSubjectType;
      event_type: string;
      obligacion_reportada: boolean;
    }>(
      `SELECT e.subject_type, e.event_type,
              (e.subject_type = 'payment_obligation'
               AND EXISTS (SELECT 1 FROM payment_obligations po
                            WHERE po.id = e.payment_obligation_id AND po.status = 'reported_paid')) AS obligacion_reportada
         FROM operational_events e WHERE e.id = $1`,
      [fila.event_id],
    );
    const sujeto = deSujeto[0];
    if (sujeto === undefined) throw new Abortar(NO_ENCONTRADO_DE_CONTENIDO);
    autorizarOAbortar(persona, manageActionForSubject(sujeto.subject_type), fila.organization_id);
    if (sujeto.event_type === 'payment.reported' || sujeto.obligacion_reportada) {
      autorizarOAbortar(persona, 'payment:report', fila.organization_id);
    }
    if (fila.retracted_at !== null) {
      throw new Abortar({
        code: 'RESOURCE_CONFLICT',
        message: 'Esa evidencia ya fue retirada.',
        details: { reason: 'already_retracted' },
      });
    }
    const { rows: actualizadas } = await client.query<{ retracted_at: Date }>(
      `UPDATE operational_evidence SET retracted_at = now(), retracted_by = $2 WHERE id = $1 RETURNING retracted_at`,
      [evidenceId, persona.id],
    );
    await recordAudit(
      client,
      auditoriaDe(persona, contexto, {
        action: 'ops_evidence.retracted',
        entityType: 'operational_evidence',
        entityId: evidenceId,
        metadata: { evidenceId, eventId: fila.event_id, kind: fila.kind },
      }),
    );
    return { evidenceId, retractedAt: actualizadas[0]!.retracted_at.toISOString() };
  });
}

// ─────────────────────────── Lecturas ──────────────────────────────────────────

/** Evidencia tal como la ve quien tiene la capacidad de su sujeto: metadatos, nunca contenido. */
export interface EvidenciaVista {
  readonly id: string;
  readonly eventId: string;
  readonly eventType: string;
  readonly subjectType: OperationalSubjectType;
  readonly subjectId: string;
  readonly sourceDocumentId: string;
  readonly kind: EvidenceKind;
  readonly filename: string;
  readonly mimeType: string | null;
  readonly sizeBytes: number | null;
  readonly hash: string | null;
  readonly attachedBy: string;
  readonly attachedAt: string;
  /** `null` = vigente. */
  readonly retractedAt: string | null;
}

interface FilaDeEvidencia {
  /** ¿La fuente respalda también evidencia de un documento de cobro o un pago (financiera)? */
  financiera: boolean;
  id: string;
  event_id: string;
  event_type: string;
  subject_type: OperationalSubjectType;
  subject_id: string;
  source_document_id: string;
  kind: EvidenceKind;
  filename: string;
  mime_type: string | null;
  size_bytes: string | number | null;
  hash: string | null;
  attached_by: string;
  created_at: Date;
  retracted_at: Date | null;
}

const SELECT_EVIDENCIA = `
  SELECT oe.id, oe.event_id, e.event_type, e.subject_type,
         COALESCE(e.shipment_id, e.billing_document_id, e.payment_obligation_id) AS subject_id,
         oe.source_document_id, oe.kind, s.filename, s.mime_type, s.size_bytes, s.hash,
         oe.attached_by, oe.created_at, oe.retracted_at,
         EXISTS (SELECT 1 FROM operational_evidence o2
                   JOIN operational_events e2 ON e2.id = o2.event_id
                  WHERE o2.source_document_id = oe.source_document_id
                    AND e2.subject_type <> 'shipment') AS financiera
    FROM operational_evidence oe
    JOIN operational_events e ON e.id = oe.event_id
    JOIN source_documents s ON s.id = oe.source_document_id
`;

/** Nombre mostrado cuando la persona no tiene la capacidad del sujeto ORIGINAL de la evidencia. */
export const NOMBRE_DE_EVIDENCIA_RESTRINGIDO = 'Soporte financiero (nombre restringido)';

/**
 * Proyección por capacidad del SUJETO ORIGINAL: una fuente puede reutilizarse por hash (mismo contenido) como
 * evidencia de un envío; si esa fuente respalda también un documento de cobro o un pago, su nombre y su hash
 * son financieros y solo los ve quien tiene `finance:read` (no basta `shipment:read`).
 */
function comoEvidencia(f: FilaDeEvidencia, verFinanciero: boolean): EvidenciaVista {
  const oculto = f.financiera && !verFinanciero;
  return {
    id: f.id,
    eventId: f.event_id,
    eventType: f.event_type,
    subjectType: f.subject_type,
    subjectId: f.subject_id,
    sourceDocumentId: f.source_document_id,
    kind: f.kind,
    filename: oculto ? NOMBRE_DE_EVIDENCIA_RESTRINGIDO : f.filename,
    mimeType: f.mime_type,
    sizeBytes: f.size_bytes === null ? null : Number(f.size_bytes),
    hash: oculto ? null : f.hash,
    attachedBy: f.attached_by,
    attachedAt: f.created_at.toISOString(),
    retractedAt: f.retracted_at === null ? null : f.retracted_at.toISOString(),
  };
}

function autorizarLectura(actor: User, tipo: OperationalSubjectType, organizationId: string): Result<true> {
  const accion: Action = readActionForSubject(tipo);
  return authorizeInternalResource(actor, accion, organizationId);
}

/**
 * Evidencia de UN evento. Capacidad según el sujeto del evento (envío ⇒ `shipment:read`; documento de cobro
 * y pago ⇒ `finance:read`); ajeno ⇒ `RESOURCE_NOT_FOUND`. Devuelve nombre, hash, tamaño y tipo — nunca el
 * contenido. Incluye la retirada (con su marca).
 */
export async function listarEvidenciaDeEvento(
  actor: User,
  eventId: string,
): Promise<Result<EvidenciaVista[]>> {
  if (typeof actor !== 'object' || actor === null) {
    return err({ code: 'FORBIDDEN_ROLE', message: 'Esta consulta la hace una persona autorizada.' });
  }
  if (!esUuid(eventId)) return err(NO_ENCONTRADO_DE_CONTENIDO);
  const sujeto = await sujetoDeEvento(getPool(), eventId);
  if (sujeto === undefined) return err(NO_ENCONTRADO_DE_CONTENIDO);
  const permitido = autorizarLectura(actor, sujeto.tipo, sujeto.organizationId);
  if (!permitido.ok) return permitido;
  const filas = await query<FilaDeEvidencia>(
    `${SELECT_EVIDENCIA} WHERE oe.event_id = $1 ORDER BY oe.created_at, oe.id`,
    [eventId],
  );
  return ok(filas.map((f) => comoEvidencia(f, roleCan(actor.role, 'finance:read'))));
}

/** Evidencia de TODOS los eventos de un sujeto (misma capacidad y proyección que `listarEvidenciaDeEvento`). */
export async function listarEvidenciaDeSujeto(
  actor: User,
  sujeto: { readonly subjectType: OperationalSubjectType; readonly subjectId: string },
): Promise<Result<EvidenciaVista[]>> {
  if (typeof actor !== 'object' || actor === null) {
    return err({ code: 'FORBIDDEN_ROLE', message: 'Esta consulta la hace una persona autorizada.' });
  }
  const propietaria = await propietariaDeSujeto(sujeto.subjectType, sujeto.subjectId);
  if (propietaria === undefined) return err(NO_ENCONTRADO_DE_CONTENIDO);
  const permitido = autorizarLectura(actor, sujeto.subjectType, propietaria.organizationId);
  if (!permitido.ok) return permitido;
  const columna =
    sujeto.subjectType === 'shipment'
      ? 'e.shipment_id'
      : sujeto.subjectType === 'billing_document'
        ? 'e.billing_document_id'
        : 'e.payment_obligation_id';
  const filas = await query<FilaDeEvidencia>(
    `${SELECT_EVIDENCIA} WHERE ${columna} = $1 ORDER BY e.subject_seq, oe.created_at, oe.id`,
    [sujeto.subjectId],
  );
  return ok(filas.map((f) => comoEvidencia(f, roleCan(actor.role, 'finance:read'))));
}
