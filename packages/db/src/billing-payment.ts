/**
 * Documentos de cobro y seguimiento de pago (V2 · Fase 8, DEC-049, DEC-014 precisada).
 *
 * PAYMENT TRACKING ≠ PAYMENT EXECUTION. Este módulo NUNCA mueve dinero, ni toca bancos, impuestos o ledger:
 * registra que una PERSONA con rol REPORTÓ que un tercero pagó. Registrar un documento de cobro ≠ validarlo ≠
 * pagarlo; reportar el pago NO se bloquea si no hay documento validado (queda
 * `billing_validated_at_report = false` y la UI avisa).
 *
 *   billing_document     registered → validated | rejected ; registered | validated → voided
 *   payment_obligation   not_applicable ↔ pending ; pending → reported_paid | cancelled ; not_applicable → cancelled
 *
 * La IA, el chat y el sistema JAMÁS registran ni cambian nada de esto: se rechazan antes de tocar la base
 * (`HUMAN_CONFIRMATION_REQUIRED` para el chat, `FORBIDDEN_ROLE` para el sistema u otro origen), y la base lo
 * repite (`origin = 'ui'`, roles cerrados). Todo cambio de estado es un evento (`aplicarEventoOperativo`):
 * idempotente por `idempotencyKey`, concurrente por `expectedSeq`. Toda lectura de dinero exige `finance:read`.
 *
 * El alta de la obligación de pago desde el acuerdo (`payment.applicability_set`) la hace W1d con
 * `aplicarEventoOperativo`; aquí solo se registran documentos, se reporta, se cancela y se anota una corrección.
 */

import type pg from 'pg';
import {
  type BillingDocumentStatus,
  type EvidenceKind,
  EVENTO_DE_DOCUMENTO_POR_DESTINO,
  type PaymentObligationStatus,
  type PaymentTracking,
  type Result,
  type User,
  authorizeInternalResource,
  derivarSeguimientoDePago,
  err,
  isEvidenceKind,
  ok,
  validarDocumentoDeCobro,
  validarReporteDePago,
} from '@tcl-kol-os/domain';
import { type ContextoDeAuditoria } from './audit-context.ts';
import { getPool } from './client.ts';
import { NO_ENCONTRADO_DE_CONTENIDO, esUuid } from './deliverables.ts';
import {
  type EventoOperativo,
  type SujetoBloqueado,
  aplicarEventoOperativo,
  autorizarOAbortar,
  buscarReintentoDeCreacion,
  calcularHuellaDeEvento,
  cargarEventoOperativo,
  exigirPersonaPorUiOAbortar,
  transaccionOperativa,
} from './operational-events.ts';
import { type ArchivoDeEvidencia, subirEvidenciaOperativa } from './ops-evidence.ts';
import { calcularHash } from './storage.ts';
import { Abortar } from './tx-result.ts';

type Consultor = pg.Pool | pg.PoolClient;

// ─────────────────────────── Vistas (todas exigen finance:read) ────────────────

export interface DocumentoDeCobroVista {
  readonly id: string;
  readonly paymentObligationId: string;
  readonly campaignId: string;
  readonly documentNumber: string;
  readonly issuedOn: string;
  /** Lo que el documento DICE cobrar (no se compara ni se paga). */
  readonly claimedAmount: string;
  readonly claimedCurrency: string;
  readonly status: BillingDocumentStatus;
  /** `expectedSeq` de la próxima transición. */
  readonly rowSeq: number;
  readonly sourceDocumentId: string;
  readonly sourceFilename: string;
  readonly validatedBy: string | null;
  readonly validatedAt: string | null;
  readonly createdAt: string;
}

export interface ObligacionDePagoVista {
  readonly id: string;
  readonly agreementId: string;
  readonly campaignId: string;
  readonly status: PaymentObligationStatus;
  /** `expectedSeq` de la próxima transición. */
  readonly rowSeq: number;
  readonly reportedBy: string | null;
  readonly reportedAt: string | null;
  readonly paidOn: string | null;
  readonly externalReference: string | null;
  /** ¿Había un documento validado cuando se reportó? (`null` si aún no se reportó). */
  readonly billingValidatedAtReport: boolean | null;
}

export interface SeguimientoDePago {
  readonly campaignInfluencerId: string;
  readonly agreement: {
    readonly id: string;
    readonly status: string;
    readonly compensationType: string;
    readonly currentVersion: number;
  };
  readonly obligation: ObligacionDePagoVista;
  /** Derivado de la obligación y sus documentos (no se almacena). */
  readonly tracking: PaymentTracking;
  readonly documents: readonly DocumentoDeCobroVista[];
}

interface FilaDeDocumento {
  id: string;
  payment_obligation_id: string;
  campaign_id: string;
  document_number: string;
  issued_on: string;
  claimed_amount: string;
  claimed_currency: string;
  status: BillingDocumentStatus;
  row_seq: number;
  source_document_id: string;
  source_filename: string;
  validated_by: string | null;
  validated_at: Date | null;
  created_at: Date;
}

const SELECT_DOCUMENTO = `
  SELECT d.id, d.payment_obligation_id, d.campaign_id, d.document_number, d.issued_on::text AS issued_on,
         d.claimed_amount::text AS claimed_amount, d.claimed_currency::text AS claimed_currency, d.status,
         d.row_seq, d.source_document_id, s.filename AS source_filename, d.validated_by, d.validated_at,
         d.created_at
    FROM billing_documents d
    JOIN source_documents s ON s.id = d.source_document_id
`;

function comoDocumento(f: FilaDeDocumento): DocumentoDeCobroVista {
  return {
    id: f.id,
    paymentObligationId: f.payment_obligation_id,
    campaignId: f.campaign_id,
    documentNumber: f.document_number,
    issuedOn: f.issued_on,
    claimedAmount: f.claimed_amount,
    claimedCurrency: f.claimed_currency,
    status: f.status,
    rowSeq: f.row_seq,
    sourceDocumentId: f.source_document_id,
    sourceFilename: f.source_filename,
    validatedBy: f.validated_by,
    validatedAt: f.validated_at === null ? null : f.validated_at.toISOString(),
    createdAt: f.created_at.toISOString(),
  };
}

async function cargarDocumentos(db: Consultor, condicion: string, parametros: readonly unknown[]) {
  const { rows } = await db.query<FilaDeDocumento>(
    `${SELECT_DOCUMENTO} WHERE ${condicion} ORDER BY d.created_at, d.id`,
    [...parametros],
  );
  return rows.map(comoDocumento);
}

interface FilaDeObligacion {
  id: string;
  agreement_id: string;
  campaign_id: string;
  status: PaymentObligationStatus;
  row_seq: number;
  reported_by: string | null;
  reported_at: Date | null;
  paid_on: string | null;
  external_reference: string | null;
  billing_validated_at_report: boolean | null;
}

const SELECT_OBLIGACION = `
  SELECT id, agreement_id, campaign_id, status, row_seq, reported_by, reported_at, paid_on::text AS paid_on,
         external_reference, billing_validated_at_report
    FROM payment_obligations
`;

function comoObligacion(f: FilaDeObligacion): ObligacionDePagoVista {
  return {
    id: f.id,
    agreementId: f.agreement_id,
    campaignId: f.campaign_id,
    status: f.status,
    rowSeq: f.row_seq,
    reportedBy: f.reported_by,
    reportedAt: f.reported_at === null ? null : f.reported_at.toISOString(),
    paidOn: f.paid_on,
    externalReference: f.external_reference,
    billingValidatedAtReport: f.billing_validated_at_report,
  };
}

// ─────────────────────────── Ayudas ────────────────────────────────────────────

interface ObligacionDeEscritura {
  readonly organization_id: string;
  readonly campaign_id: string;
  readonly status: PaymentObligationStatus;
}

async function leerObligacion(client: pg.PoolClient, id: string): Promise<ObligacionDeEscritura> {
  if (!esUuid(id)) throw new Abortar(NO_ENCONTRADO_DE_CONTENIDO);
  const { rows } = await client.query<ObligacionDeEscritura>(
    `SELECT organization_id, campaign_id, status FROM payment_obligations WHERE id = $1`,
    [id],
  );
  const fila = rows[0];
  if (fila === undefined) throw new Abortar(NO_ENCONTRADO_DE_CONTENIDO);
  return fila;
}

function conflicto(message: string, reason: string): Abortar {
  return new Abortar({ code: 'RESOURCE_CONFLICT', message, details: { reason } });
}

async function documentosVivos(client: pg.PoolClient, obligationId: string): Promise<number> {
  const { rows } = await client.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM billing_documents
      WHERE payment_obligation_id = $1 AND status IN ('registered', 'validated')`,
    [obligationId],
  );
  return rows[0]!.n;
}

function validarTipoDeSoporte(kind: unknown): Result<true> {
  return isEvidenceKind(kind)
    ? ok(true)
    : err({
        code: 'VALIDATION_FAILED',
        message: 'El tipo de soporte no es válido.',
        details: { field: 'kind' },
      });
}

// ─────────────────────────── Registrar un documento de cobro ───────────────────

export interface RegistrarDocumentoDeCobroInput {
  readonly paymentObligationId: string;
  readonly documentNumber: string;
  /** `YYYY-MM-DD`. */
  readonly issuedOn: string;
  /** Lo que el documento DICE cobrar. */
  readonly claimedAmount: unknown;
  readonly claimedCurrency: unknown;
  /** El archivo del documento: OBLIGATORIO. Se guarda como evidencia (`soporte_operativo`) en la misma transacción. */
  readonly archivo: ArchivoDeEvidencia;
  readonly idempotencyKey: string;
  /** Nota interna (sin datos personales). */
  readonly note?: string | null | undefined;
}

export interface DocumentoRegistrado {
  readonly documento: DocumentoDeCobroVista;
  readonly evento: EventoOperativo;
  readonly repetido: boolean;
}

/**
 * Registra una cuenta de cobro o factura contra una obligación `pending` o `reported_paid`: sube el archivo
 * como evidencia, crea el documento `registered` y su evento `billing.registered`, todo en UNA transacción.
 * Exige `billing:manage` y `ops_evidence:attach`. NO valida ni paga. Idempotente por `idempotencyKey`.
 */
export async function registrarDocumentoDeCobro(
  actor: User,
  input: RegistrarDocumentoDeCobroInput,
  contexto?: ContextoDeAuditoria,
): Promise<Result<DocumentoRegistrado>> {
  if (typeof input.archivo?.filename !== 'string' || !(input.archivo.contenido instanceof Uint8Array)) {
    return err({
      code: 'VALIDATION_FAILED',
      message: 'Todo documento de cobro exige su soporte (archivo de evidencia).',
      details: { field: 'archivo' },
    });
  }
  // Valida los datos antes de abrir la transacción (el id de la fuente real se conoce tras subir el archivo).
  const previo = validarDocumentoDeCobro({
    documentNumber: input.documentNumber,
    issuedOn: input.issuedOn,
    claimedAmount: input.claimedAmount,
    claimedCurrency: input.claimedCurrency,
    sourceDocumentId: '00000000-0000-4000-8000-000000000000',
  });
  if (!previo.ok) return previo;
  const datos = previo.value;

  return transaccionOperativa(async (client) => {
    const persona = exigirPersonaPorUiOAbortar(actor, contexto);
    const obligacion = await leerObligacion(client, input.paymentObligationId);
    autorizarOAbortar(persona, 'billing:manage', obligacion.organization_id);
    autorizarOAbortar(persona, 'finance:read', obligacion.organization_id);
    if (obligacion.status !== 'pending' && obligacion.status !== 'reported_paid') {
      throw conflicto(
        'Solo se registra un documento de cobro contra una obligación de pago pendiente o ya reportada.',
        obligacion.status === 'not_applicable'
          ? 'payment_not_applicable'
          : 'obligation_not_accepting_documents',
      );
    }

    // La subida es idempotente (mismo contenido ⇒ misma fuente): va antes de la huella, que incluye la fuente.
    const subida = await subirEvidenciaOperativa(client, {
      actor: persona,
      contexto,
      campaignId: obligacion.campaign_id,
      archivo: input.archivo,
    });
    const evidencias = [{ sourceDocumentId: subida.sourceDocumentId, kind: 'cuenta_cobro' as EvidenceKind }];
    const huellaExtra = {
      paymentObligationId: input.paymentObligationId,
      documentNumber: datos.documentNumber,
      issuedOn: datos.issuedOn,
      claimedAmount: datos.claimedAmount,
      claimedCurrency: datos.claimedCurrency,
      contentHash: calcularHash(input.archivo.contenido),
    };
    const huella = calcularHuellaDeEvento({
      sujeto: { tipo: 'billing_document', id: '' },
      eventType: 'billing.registered',
      toStatus: 'registered',
      expectedSeq: 0,
      note: input.note,
      evidencias,
      huellaExtra,
    });
    const reintento = await buscarReintentoDeCreacion(
      client,
      obligacion.organization_id,
      input.idempotencyKey,
      huella,
    );
    if (reintento !== undefined) {
      const [documento] = await cargarDocumentos(client, 'd.id = $1', [reintento.sujeto.id]);
      return {
        documento: documento!,
        evento: await cargarEventoOperativo(client, reintento.eventoId),
        repetido: true,
      };
    }

    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO billing_documents
         (organization_id, campaign_id, payment_obligation_id, document_number, issued_on, claimed_amount,
          claimed_currency, source_document_id, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING id`,
      [
        obligacion.organization_id,
        obligacion.campaign_id,
        input.paymentObligationId,
        datos.documentNumber,
        datos.issuedOn,
        datos.claimedAmount,
        datos.claimedCurrency,
        subida.sourceDocumentId,
        persona.id,
      ],
    );
    const documentoId = rows[0]!.id;
    const aplicado = await aplicarEventoOperativo(client, {
      actor: persona,
      contexto,
      action: 'billing:manage',
      sujeto: { tipo: 'billing_document', id: documentoId },
      eventType: 'billing.registered',
      toStatus: 'registered',
      expectedSeq: 0,
      idempotencyKey: input.idempotencyKey,
      note: input.note,
      evidencias,
      huellaExtra,
      auditoria: { kind: 'cuenta_cobro' },
    });
    const [documento] = await cargarDocumentos(client, 'd.id = $1', [documentoId]);
    return { documento: documento!, evento: aplicado.evento, repetido: false };
  });
}

// ─────────────────────────── Validar · rechazar · anular ───────────────────────

export interface TransicionDeDocumentoInput {
  readonly billingDocumentId: string;
  /** `rowSeq` del documento que el llamador vio. */
  readonly expectedSeq: number;
  readonly idempotencyKey: string;
  /** Nota interna (p. ej. el motivo del rechazo). Sin datos personales. */
  readonly note?: string | null | undefined;
}

export interface DocumentoTransicionado {
  readonly documento: DocumentoDeCobroVista;
  readonly evento: EventoOperativo;
  readonly repetido: boolean;
}

async function transicionarDocumento(
  actor: User,
  to: Exclude<BillingDocumentStatus, 'registered'>,
  input: TransicionDeDocumentoInput,
  contexto: ContextoDeAuditoria | undefined,
): Promise<Result<DocumentoTransicionado>> {
  return transaccionOperativa(async (client) => {
    const persona = exigirPersonaPorUiOAbortar(actor, contexto);
    const aplicado = await aplicarEventoOperativo(client, {
      actor: persona,
      contexto,
      action: 'billing:manage',
      sujeto: { tipo: 'billing_document', id: input.billingDocumentId },
      eventType: EVENTO_DE_DOCUMENTO_POR_DESTINO[to] as
        'billing.validated' | 'billing.rejected' | 'billing.voided',
      toStatus: to,
      expectedSeq: input.expectedSeq,
      idempotencyKey: input.idempotencyKey,
      note: input.note,
      precondicion:
        to === 'validated'
          ? async ({ client: c, sujeto }) => {
              if (sujeto.status !== 'registered') return; // lo rechaza la arista
              const { rows } = await c.query<{ status: string }>(
                `SELECT po.status FROM billing_documents d
                   JOIN payment_obligations po ON po.id = d.payment_obligation_id WHERE d.id = $1`,
                [sujeto.id],
              );
              if (rows[0]?.status !== 'pending' && rows[0]?.status !== 'reported_paid') {
                throw conflicto(
                  'Solo se valida un documento de cobro de una obligación pendiente o ya reportada.',
                  'obligation_not_accepting_documents',
                );
              }
            }
          : undefined,
    });
    const [documento] = await cargarDocumentos(client, 'd.id = $1', [input.billingDocumentId]);
    return { documento: documento!, evento: aplicado.evento, repetido: aplicado.repetido };
  });
}

/** `registered → validated`. Exige `billing:manage`. A lo sumo un documento validado por obligación. */
export function validarDocumento(
  actor: User,
  input: TransicionDeDocumentoInput,
  contexto?: ContextoDeAuditoria,
): Promise<Result<DocumentoTransicionado>> {
  return transicionarDocumento(actor, 'validated', input, contexto);
}

/** `registered → rejected` (terminal). Exige `billing:manage`. */
export function rechazarDocumento(
  actor: User,
  input: TransicionDeDocumentoInput,
  contexto?: ContextoDeAuditoria,
): Promise<Result<DocumentoTransicionado>> {
  return transicionarDocumento(actor, 'rejected', input, contexto);
}

/** `registered | validated → voided` (terminal). Un error se corrige anulando y registrando de nuevo. */
export function anularDocumento(
  actor: User,
  input: TransicionDeDocumentoInput,
  contexto?: ContextoDeAuditoria,
): Promise<Result<DocumentoTransicionado>> {
  return transicionarDocumento(actor, 'voided', input, contexto);
}

// ─────────────────────────── Reportar el pago ──────────────────────────────────

export interface ReportarPagoInput {
  readonly paymentObligationId: string;
  /** `rowSeq` de la obligación que el llamador vio. */
  readonly expectedSeq: number;
  readonly idempotencyKey: string;
  /** Fecha del pago `YYYY-MM-DD` (obligatoria). */
  readonly paidOn: string;
  /** Referencia externa del pago (comprobante, transferencia…): obligatoria. */
  readonly externalReference: string;
  readonly note?: string | null | undefined;
  /** Soporte opcional (comprobante) en la misma transacción. */
  readonly evidencia?: { readonly archivo: ArchivoDeEvidencia; readonly kind: EvidenceKind } | undefined;
}

export interface PagoReportado {
  readonly obligacion: ObligacionDePagoVista;
  readonly evento: EventoOperativo;
  readonly repetido: boolean;
}

async function cargarObligacion(db: Consultor, id: string): Promise<ObligacionDePagoVista> {
  const { rows } = await db.query<FilaDeObligacion>(`${SELECT_OBLIGACION} WHERE id = $1`, [id]);
  return comoObligacion(rows[0]!);
}

/**
 * Reporta que un tercero PAGÓ (`pending → reported_paid`, terminal y sellado). SOLO una persona con
 * `payment:report` (admin, operativo) por la UI: el chat, la IA y el sistema se rechazan. Exige fecha de pago y
 * referencia externa. NO se bloquea si no hay documento validado: la base fija
 * `billingValidatedAtReport` (verdadero solo si lo había). Un canje puro (`not_applicable`) no admite pago.
 */
export async function reportarPago(
  actor: User,
  input: ReportarPagoInput,
  contexto?: ContextoDeAuditoria,
): Promise<Result<PagoReportado>> {
  // La IA, el chat y el sistema jamás: antes de validar nada ni tocar la base.
  const persona = ((): Result<User> => {
    if (typeof actor !== 'object' || actor === null) {
      return err({
        code: 'FORBIDDEN_ROLE',
        message: 'Solo una persona con permiso reporta un pago, no el sistema.',
      });
    }
    const origen = contexto?.origin ?? 'ui';
    if (origen === 'chat') {
      return err({
        code: 'HUMAN_CONFIRMATION_REQUIRED',
        message: 'Reportar un pago lo hace una persona por la interfaz, no el chat.',
        details: { reason: 'operational_state_is_ui_only' },
      });
    }
    if (origen !== 'ui') {
      return err({
        code: 'FORBIDDEN_ROLE',
        message: 'Solo una persona, por la interfaz, reporta un pago (la IA y el sistema no).',
        details: { reason: 'operational_state_is_ui_only' },
      });
    }
    return ok(actor);
  })();
  if (!persona.ok) return persona;

  const reporte = validarReporteDePago({ paidOn: input.paidOn, externalReference: input.externalReference });
  if (!reporte.ok) return reporte;
  if (input.evidencia !== undefined) {
    const tipo = validarTipoDeSoporte(input.evidencia.kind);
    if (!tipo.ok) return tipo;
  }

  return transaccionOperativa(async (client) => {
    const obligacion = await leerObligacion(client, input.paymentObligationId);
    autorizarOAbortar(actor, 'payment:report', obligacion.organization_id);
    autorizarOAbortar(actor, 'finance:read', obligacion.organization_id);

    let evidencias: Array<{ sourceDocumentId: string; kind: EvidenceKind }> = [];
    if (input.evidencia !== undefined) {
      const subida = await subirEvidenciaOperativa(client, {
        actor,
        contexto,
        campaignId: obligacion.campaign_id,
        archivo: input.evidencia.archivo,
      });
      evidencias = [{ sourceDocumentId: subida.sourceDocumentId, kind: input.evidencia.kind }];
    }

    const aplicado = await aplicarEventoOperativo(client, {
      actor,
      contexto,
      action: 'payment:report',
      sujeto: { tipo: 'payment_obligation', id: input.paymentObligationId },
      eventType: 'payment.reported',
      toStatus: 'reported_paid',
      expectedSeq: input.expectedSeq,
      idempotencyKey: input.idempotencyKey,
      happenedOn: reporte.value.paidOn,
      externalReference: reporte.value.externalReference,
      note: input.note,
      evidencias,
      precondicion: async ({ sujeto }) => exigirObligacionPendiente(sujeto),
    });
    return {
      obligacion: await cargarObligacion(client, input.paymentObligationId),
      evento: aplicado.evento,
      repetido: aplicado.repetido,
    };
  });
}

function exigirObligacionPendiente(sujeto: SujetoBloqueado): void {
  switch (sujeto.status) {
    case 'pending':
      return;
    case 'not_applicable':
      throw conflicto(
        'Este acuerdo no genera pago (canje puro): no hay nada que reportar.',
        'payment_not_applicable',
      );
    case 'reported_paid':
      throw conflicto('El pago de este acuerdo ya fue reportado.', 'payment_already_reported');
    default:
      throw conflicto('La obligación de pago está cancelada.', 'obligation_cancelled');
  }
}

// ─────────────────────────── Cancelar la obligación ────────────────────────────

export interface CancelarObligacionInput {
  readonly paymentObligationId: string;
  readonly expectedSeq: number;
  readonly idempotencyKey: string;
  readonly note?: string | null | undefined;
}

/**
 * `pending | not_applicable → cancelled` (terminal). Exige `billing:manage`; solo sin documentos de cobro vivos
 * (anúlelos o recházelos antes).
 */
export async function cancelarObligacionDePago(
  actor: User,
  input: CancelarObligacionInput,
  contexto?: ContextoDeAuditoria,
): Promise<Result<PagoReportado>> {
  return transaccionOperativa(async (client) => {
    const persona = exigirPersonaPorUiOAbortar(actor, contexto);
    const aplicado = await aplicarEventoOperativo(client, {
      actor: persona,
      contexto,
      action: 'billing:manage',
      sujeto: { tipo: 'payment_obligation', id: input.paymentObligationId },
      eventType: 'payment.cancelled',
      toStatus: 'cancelled',
      expectedSeq: input.expectedSeq,
      idempotencyKey: input.idempotencyKey,
      note: input.note,
      precondicion: async ({ client: c, sujeto }) => {
        if (sujeto.status !== 'pending' && sujeto.status !== 'not_applicable') return; // lo rechaza la arista
        if ((await documentosVivos(c, sujeto.id)) > 0) {
          throw conflicto(
            'Hay documentos de cobro vivos: anúlelos o recházelos antes de cancelar la obligación.',
            'live_documents',
          );
        }
      },
    });
    return {
      obligacion: await cargarObligacion(client, input.paymentObligationId),
      evento: aplicado.evento,
      repetido: aplicado.repetido,
    };
  });
}

// ─────────────────────────── Nota de corrección de un pago reportado ──────────

export interface NotaDeCorreccionInput {
  readonly paymentObligationId: string;
  readonly expectedSeq: number;
  readonly idempotencyKey: string;
  /** Qué se corrige y por qué (obligatoria; interna, sin datos personales). */
  readonly note: string;
  /** Referencia o fecha corregidas, si aplica (no cambian el sello original: lo anotan). */
  readonly externalReference?: string | null | undefined;
  readonly happenedOn?: string | null | undefined;
  readonly evidencia?: { readonly archivo: ArchivoDeEvidencia; readonly kind: EvidenceKind } | undefined;
}

/**
 * Anota una corrección sobre un pago YA reportado (`payment.correction_noted`, sin cambio de estado: el sello
 * del reporte es inmutable). Exige `payment:report`.
 */
export async function registrarNotaDeCorreccionDePago(
  actor: User,
  input: NotaDeCorreccionInput,
  contexto?: ContextoDeAuditoria,
): Promise<Result<PagoReportado>> {
  if (typeof input.note !== 'string' || input.note.trim() === '') {
    return err({
      code: 'VALIDATION_FAILED',
      message: 'La nota de corrección es obligatoria.',
      details: { field: 'note' },
    });
  }
  if (input.evidencia !== undefined) {
    const tipo = validarTipoDeSoporte(input.evidencia.kind);
    if (!tipo.ok) return tipo;
  }
  return transaccionOperativa(async (client) => {
    const persona = exigirPersonaPorUiOAbortar(actor, contexto);
    const obligacion = await leerObligacion(client, input.paymentObligationId);
    autorizarOAbortar(persona, 'payment:report', obligacion.organization_id);
    autorizarOAbortar(persona, 'finance:read', obligacion.organization_id);
    let evidencias: Array<{ sourceDocumentId: string; kind: EvidenceKind }> = [];
    if (input.evidencia !== undefined) {
      const subida = await subirEvidenciaOperativa(client, {
        actor: persona,
        contexto,
        campaignId: obligacion.campaign_id,
        archivo: input.evidencia.archivo,
      });
      evidencias = [{ sourceDocumentId: subida.sourceDocumentId, kind: input.evidencia.kind }];
    }
    const aplicado = await aplicarEventoOperativo(client, {
      actor: persona,
      contexto,
      action: 'payment:report',
      sujeto: { tipo: 'payment_obligation', id: input.paymentObligationId },
      eventType: 'payment.correction_noted',
      toStatus: null,
      expectedSeq: input.expectedSeq,
      idempotencyKey: input.idempotencyKey,
      note: input.note,
      externalReference: input.externalReference,
      happenedOn: input.happenedOn,
      evidencias,
      precondicion: async ({ sujeto }) => {
        if (sujeto.status !== 'reported_paid') {
          throw conflicto('Solo un pago ya reportado admite una corrección anotada.', 'payment_not_reported');
        }
      },
    });
    return {
      obligacion: await cargarObligacion(client, input.paymentObligationId),
      evento: aplicado.evento,
      repetido: aplicado.repetido,
    };
  });
}

// ─────────────────────────── Lecturas (finance:read) ───────────────────────────

/**
 * Seguimiento de pago de una participación: la obligación, sus documentos y el estado DERIVADO (`not_applicable
 * | pending_document | document_received | pending_payment | reported_paid`). Exige `finance:read`; ajeno o
 * `cliente` ⇒ `RESOURCE_NOT_FOUND`. `null` si la participación aún no tiene acuerdo.
 */
export async function obtenerSeguimientoDePago(
  actor: User,
  campaignInfluencerId: string,
): Promise<Result<SeguimientoDePago | null>> {
  if (typeof actor !== 'object' || actor === null) {
    return err({ code: 'FORBIDDEN_ROLE', message: 'Esta consulta la hace una persona autorizada.' });
  }
  if (!esUuid(campaignInfluencerId)) return err(NO_ENCONTRADO_DE_CONTENIDO);
  const pool = getPool();
  const { rows: dueña } = await pool.query<{ organization_id: string }>(
    `SELECT organization_id FROM campaign_influencers WHERE id = $1`,
    [campaignInfluencerId],
  );
  if (dueña[0] === undefined) return err(NO_ENCONTRADO_DE_CONTENIDO);
  const permitido = authorizeInternalResource(actor, 'finance:read', dueña[0].organization_id);
  if (!permitido.ok) return permitido;

  const { rows } = await pool.query<{
    agreement_id: string;
    agreement_status: string;
    current_version: number;
    compensation_type: string | null;
    obligation_id: string | null;
  }>(
    `SELECT a.id AS agreement_id, a.status AS agreement_status, a.current_version,
            av.compensation_type, po.id AS obligation_id
       FROM agreements a
       LEFT JOIN agreement_versions av ON av.agreement_id = a.id AND av.version = a.current_version
       LEFT JOIN payment_obligations po ON po.agreement_id = a.id
      WHERE a.campaign_influencer_id = $1`,
    [campaignInfluencerId],
  );
  const fila = rows[0];
  if (fila === undefined || fila.obligation_id === null) return ok(null);
  const obligacion = await cargarObligacion(pool, fila.obligation_id);
  const documentos = await cargarDocumentos(pool, 'd.payment_obligation_id = $1', [fila.obligation_id]);
  return ok({
    campaignInfluencerId,
    agreement: {
      id: fila.agreement_id,
      status: fila.agreement_status,
      compensationType: fila.compensation_type ?? 'unknown',
      currentVersion: fila.current_version,
    },
    obligation: obligacion,
    tracking: derivarSeguimientoDePago(
      obligacion.status,
      documentos.map((d) => d.status),
    ),
    documents: documentos,
  });
}

/** Documentos de cobro de una obligación (todos los estados), en orden de registro. Exige `finance:read`. */
export async function listarDocumentosDeCobro(
  actor: User,
  paymentObligationId: string,
): Promise<Result<DocumentoDeCobroVista[]>> {
  if (typeof actor !== 'object' || actor === null) {
    return err({ code: 'FORBIDDEN_ROLE', message: 'Esta consulta la hace una persona autorizada.' });
  }
  if (!esUuid(paymentObligationId)) return err(NO_ENCONTRADO_DE_CONTENIDO);
  const pool = getPool();
  const { rows } = await pool.query<{ organization_id: string }>(
    `SELECT organization_id FROM payment_obligations WHERE id = $1`,
    [paymentObligationId],
  );
  if (rows[0] === undefined) return err(NO_ENCONTRADO_DE_CONTENIDO);
  const permitido = authorizeInternalResource(actor, 'finance:read', rows[0].organization_id);
  if (!permitido.ok) return permitido;
  return ok(await cargarDocumentos(pool, 'd.payment_obligation_id = $1', [paymentObligationId]));
}
