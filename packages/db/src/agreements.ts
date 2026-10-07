/**
 * Acuerdos con el KOL (V2 · Fase 8, DEC-049): alta, versiones inmutables, cancelación y lectura.
 *
 *   campaign_influencers ─< agreements (UNO por participación)
 *                              ├─< agreement_versions ─< agreement_product_commitments   (inmutables)
 *                              └─< payment_obligations                                    (seguimiento, DEC-014)
 *
 * Cada acuerdo nace CON su versión 1, sus compromisos de producto y su obligación de pago, en UNA transacción
 * (la base lo exige al cerrarla, migración 027): barter ⇒ obligación `not_applicable` (NUNCA `pending`);
 * fee/mixed ⇒ `pending`. La obligación se crea con `row_seq = 0` y la lleva a 1 su evento
 * `payment.applicability_set` (motor de `operational-events.ts`).
 *
 * Editar los términos materiales = versión N+1 con su motivo (jamás UPDATE). Si el modo cambia entre barter y
 * fee/mixed, la misma transacción ajusta la obligación con otro `payment.applicability_set`. Concurrencia:
 * el orden de bloqueos es obligación → acuerdo (el mismo del trigger de versiones), de modo que dos cambios con
 * la misma `expectedVersion` se serializan y solo gana uno (`stale_version` para el otro).
 *
 * Capacidades: escribir exige `agreement:manage` (admin, director, operativo), SIEMPRE una persona por la UI
 * (el chat y el sistema se rechazan). Leer exige `agreement:read`; el DINERO (fee, moneda y la obligación de
 * pago) solo se proyecta con `finance:read`: el consultor ve modo, vigencia, condiciones y productos, jamás un
 * monto. Auditoría `agreement.*` con la allowlist de `audit.ts` (ids, versión, modo, estado): nunca montos,
 * condiciones ni motivos.
 */

import type pg from 'pg';
import {
  type AgreementStatus,
  type AgreementTerms,
  type CompensationType,
  type PaymentObligationStatus,
  type ProductCommitmentInput,
  type Result,
  type User,
  authorizeInternalResource,
  err,
  esClaveDeIdempotenciaValida,
  obligacionInicialPara,
  ok,
  puedeVersionarAcuerdo,
  roleCan,
  validarMotivoDeCancelacionDeAcuerdo,
  validarTerminosDeAcuerdo,
} from '@tcl-kol-os/domain';
import { recordAudit } from './audit.ts';
import { type ContextoDeAuditoria, auditoriaDe } from './audit-context.ts';
import { getPool } from './client.ts';
import { NO_ENCONTRADO_DE_CONTENIDO, esUuid } from './deliverables.ts';
import {
  aplicarEventoOperativo,
  autorizarOAbortar,
  buscarEventoPorClave,
  calcularHuellaDeEvento,
  exigirPersonaPorUiOAbortar,
  huellaDeSolicitud,
  transaccionOperativa,
} from './operational-events.ts';
import { Abortar } from './tx-result.ts';

type Consultor = pg.Pool | pg.PoolClient;

// ─────────────────────────── Vistas ────────────────────────────────────────────

export interface CompromisoDeProductoVista {
  /** `campaign_products.id`: el producto EN la campaña. */
  readonly campaignProductId: string;
  readonly productName: string;
  readonly quantity: number;
}

/**
 * Una versión del acuerdo. `feeAmount` y `feeCurrency` EXISTEN solo con `finance:read` (sin esa capacidad la
 * clave no está: la base ni siquiera las entrega a la aplicación).
 */
export interface VersionDeAcuerdoVista {
  readonly id: string;
  readonly version: number;
  readonly compensationType: CompensationType;
  readonly startsOn: string | null;
  readonly endsOn: string | null;
  readonly conditions: string | null;
  /** Motivo del cambio (obligatorio desde la versión 2). */
  readonly changeReason: string | null;
  readonly commitments: readonly CompromisoDeProductoVista[];
  readonly createdBy: string;
  readonly createdByName: string | null;
  readonly createdAt: string;
  readonly feeAmount?: string | null;
  readonly feeCurrency?: string | null;
}

/** Obligación de pago del acuerdo (solo con `finance:read`). `rowSeq` es el `expectedSeq` de su próximo evento. */
export interface ObligacionDeAcuerdoVista {
  readonly id: string;
  readonly status: PaymentObligationStatus;
  readonly rowSeq: number;
}

export interface AcuerdoVista {
  readonly id: string;
  readonly campaignId: string;
  readonly campaignInfluencerId: string;
  readonly status: AgreementStatus;
  /** `expectedVersion` de la próxima versión. */
  readonly currentVersion: number;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly cancelledAt: string | null;
  readonly cancelledBy: string | null;
  readonly cancelReason: string | null;
  /** Términos de la versión vigente. */
  readonly terms: VersionDeAcuerdoVista;
  /** Solo con `finance:read`. */
  readonly paymentObligation?: ObligacionDeAcuerdoVista | undefined;
}

export interface TerminosDeAcuerdoInput {
  readonly compensationType: CompensationType;
  /** Número o cadena decimal (máx. 2 decimales). Obligatorio en fee/mixed; ausente en barter. */
  readonly feeAmount?: number | string | null | undefined;
  /** ISO de tres letras mayúsculas. */
  readonly feeCurrency?: string | null | undefined;
  /** `YYYY-MM-DD`. */
  readonly startsOn?: string | null | undefined;
  readonly endsOn?: string | null | undefined;
  readonly conditions?: string | null | undefined;
  /** Productos comprometidos (`campaign_products.id` asignados a la participación). barter/mixed ≥ 1; fee ninguno. */
  readonly commitments?: readonly ProductCommitmentInput[] | undefined;
}

export interface CrearAcuerdoInput extends TerminosDeAcuerdoInput {
  readonly campaignInfluencerId: string;
  readonly idempotencyKey: string;
}

export interface AcuerdoRegistrado {
  readonly acuerdo: AcuerdoVista;
  /** `true` si era un reintento idéntico (misma clave y solicitud): no se escribió nada. */
  readonly repetido: boolean;
}

export interface RegistrarVersionInput extends TerminosDeAcuerdoInput {
  /** Obligatorio: editar registra una versión nueva con su porqué. */
  readonly changeReason: string;
  /** Versión vigente que el llamador vio. */
  readonly expectedVersion: number;
  readonly idempotencyKey: string;
}

export interface VersionRegistrada {
  readonly acuerdo: AcuerdoVista;
  readonly repetido: boolean;
  /** ¿Cambió la obligación de pago (`not_applicable ↔ pending`) por el cambio de modo? */
  readonly obligacionAjustada: boolean;
}

export interface CancelarAcuerdoInput {
  readonly reason: string;
  readonly idempotencyKey: string;
}

export interface AcuerdoCancelado {
  readonly acuerdo: AcuerdoVista;
  readonly repetido: boolean;
  /** ¿Se canceló también la obligación? (No si ya estaba reportada como pagada o tiene documentos de cobro vivos.) */
  readonly obligacionCancelada: boolean;
}

// ─────────────────────────── Filas internas ────────────────────────────────────

interface FilaDeAcuerdo {
  readonly id: string;
  readonly organization_id: string;
  readonly campaign_id: string;
  readonly campaign_influencer_id: string;
  readonly status: AgreementStatus;
  readonly current_version: number;
  readonly cancelled_at: Date | null;
  readonly cancelled_by: string | null;
  readonly cancel_reason: string | null;
  readonly created_by: string;
  readonly created_at: Date;
}

const SELECT_ACUERDO = `
  SELECT id, organization_id, campaign_id, campaign_influencer_id, status, current_version, cancelled_at,
         cancelled_by, cancel_reason, created_by, created_at
    FROM agreements
`;

interface FilaDeVersion {
  readonly id: string;
  readonly version: number;
  readonly compensation_type: CompensationType;
  readonly fee_amount: string | null;
  readonly fee_currency: string | null;
  readonly starts_on: string | null;
  readonly ends_on: string | null;
  readonly conditions: string | null;
  readonly change_reason: string | null;
  readonly created_by: string;
  readonly created_by_name: string | null;
  readonly created_at: Date;
}

/** Con `conDinero = false` el dinero ni sale de la base (`NULL`). */
function selectDeVersion(conDinero: boolean): string {
  const dinero = conDinero
    ? `v.fee_amount::text AS fee_amount, v.fee_currency::text AS fee_currency`
    : `NULL::text AS fee_amount, NULL::text AS fee_currency`;
  return `
    SELECT v.id, v.version, v.compensation_type, ${dinero}, v.starts_on::text AS starts_on,
           v.ends_on::text AS ends_on, v.conditions, v.change_reason, v.created_by, u.name AS created_by_name,
           v.created_at
      FROM agreement_versions v
      JOIN users u ON u.id = v.created_by
  `;
}

interface FilaDeCompromiso {
  readonly agreement_version_id: string;
  readonly campaign_product_id: string;
  readonly quantity: number;
  readonly product_name: string;
}

async function cargarCompromisos(
  db: Consultor,
  versionIds: readonly string[],
): Promise<Map<string, CompromisoDeProductoVista[]>> {
  const porVersion = new Map<string, CompromisoDeProductoVista[]>();
  if (versionIds.length === 0) return porVersion;
  const { rows } = await db.query<FilaDeCompromiso>(
    `SELECT c.agreement_version_id, c.campaign_product_id, c.quantity,
            p.brand || ' ' || p.model AS product_name
       FROM agreement_product_commitments c
       JOIN campaign_products cp ON cp.id = c.campaign_product_id
       JOIN products p ON p.id = cp.product_id
      WHERE c.agreement_version_id = ANY($1)
      ORDER BY p.brand, p.model, c.campaign_product_id`,
    [[...versionIds]],
  );
  for (const f of rows) {
    const lista = porVersion.get(f.agreement_version_id) ?? [];
    lista.push({
      campaignProductId: f.campaign_product_id,
      productName: f.product_name,
      quantity: f.quantity,
    });
    porVersion.set(f.agreement_version_id, lista);
  }
  return porVersion;
}

function comoVersion(
  f: FilaDeVersion,
  compromisos: readonly CompromisoDeProductoVista[],
  conDinero: boolean,
): VersionDeAcuerdoVista {
  const base: VersionDeAcuerdoVista = {
    id: f.id,
    version: f.version,
    compensationType: f.compensation_type,
    startsOn: f.starts_on,
    endsOn: f.ends_on,
    conditions: f.conditions,
    changeReason: f.change_reason,
    commitments: compromisos,
    createdBy: f.created_by,
    createdByName: f.created_by_name,
    createdAt: f.created_at.toISOString(),
  };
  return conDinero ? { ...base, feeAmount: f.fee_amount, feeCurrency: f.fee_currency } : base;
}

async function cargarVersiones(
  db: Consultor,
  agreementId: string,
  conDinero: boolean,
  soloVigente: number | undefined,
): Promise<VersionDeAcuerdoVista[]> {
  const { rows } = await db.query<FilaDeVersion>(
    `${selectDeVersion(conDinero)}
      WHERE v.agreement_id = $1 ${soloVigente === undefined ? '' : 'AND v.version = $2'}
      ORDER BY v.version`,
    soloVigente === undefined ? [agreementId] : [agreementId, soloVigente],
  );
  const compromisos = await cargarCompromisos(
    db,
    rows.map((v) => v.id),
  );
  return rows.map((v) => comoVersion(v, compromisos.get(v.id) ?? [], conDinero));
}

/** Proyección por capacidad: `conDinero` ⇔ el actor tiene `finance:read`. */
async function cargarVistaDeAcuerdo(db: Consultor, fila: FilaDeAcuerdo, actor: User): Promise<AcuerdoVista> {
  const conDinero = roleCan(actor.role, 'finance:read');
  const [terms] = await cargarVersiones(db, fila.id, conDinero, fila.current_version);
  let paymentObligation: ObligacionDeAcuerdoVista | undefined;
  if (conDinero) {
    const { rows } = await db.query<{ id: string; status: PaymentObligationStatus; row_seq: number }>(
      `SELECT id, status, row_seq FROM payment_obligations WHERE agreement_id = $1`,
      [fila.id],
    );
    const o = rows[0];
    if (o !== undefined) paymentObligation = { id: o.id, status: o.status, rowSeq: o.row_seq };
  }
  return {
    id: fila.id,
    campaignId: fila.campaign_id,
    campaignInfluencerId: fila.campaign_influencer_id,
    status: fila.status,
    currentVersion: fila.current_version,
    createdBy: fila.created_by,
    createdAt: fila.created_at.toISOString(),
    cancelledAt: fila.cancelled_at === null ? null : fila.cancelled_at.toISOString(),
    cancelledBy: fila.cancelled_by,
    cancelReason: fila.cancel_reason,
    terms: terms!,
    ...(conDinero ? { paymentObligation } : {}),
  };
}

// ─────────────────────────── Ayudas ────────────────────────────────────────────

function conflicto(message: string, reason: string, extra: Record<string, unknown> = {}): Abortar {
  return new Abortar({ code: 'RESOURCE_CONFLICT', message, details: { reason, ...extra } });
}

function invalido(message: string, field: string, reason?: string): Abortar {
  return new Abortar({
    code: 'VALIDATION_FAILED',
    message,
    details: reason === undefined ? { field } : { field, reason },
  });
}

function aceptar<T>(r: Result<T>): T {
  if (!r.ok) {
    throw new Abortar({ code: r.error.code, message: r.error.message, details: r.error.details });
  }
  return r.value;
}

function exigirClave(clave: unknown): string {
  if (!esClaveDeIdempotenciaValida(clave)) {
    throw invalido(
      'La clave de idempotencia es obligatoria (hasta 200 caracteres, sin espacios en los extremos).',
      'idempotencyKey',
    );
  }
  return clave;
}

function ordenarCompromisos(c: readonly ProductCommitmentInput[]): ProductCommitmentInput[] {
  return [...c].sort((a, b) => a.campaignProductId.localeCompare(b.campaignProductId));
}

/** Huella de los términos (sin dinero en claro en ninguna parte que salga de la base). */
function huellaDeTerminos(t: AgreementTerms): string {
  return huellaDeSolicitud({ ...t, commitments: ordenarCompromisos(t.commitments) });
}

interface Participacion {
  readonly id: string;
  readonly organization_id: string;
  readonly campaign_id: string;
  readonly status: string;
  readonly campana: string;
}

/** Campaña activa e influencer activo en ella (el trigger lo repite; aquí el mensaje es accionable). */
function exigirParticipacionActiva(p: { status: string; campana: string }): void {
  if (p.campana !== 'activa') {
    throw conflicto(
      'La campaña debe estar activa para registrar o cambiar un acuerdo.',
      'campaign_not_active',
    );
  }
  if (p.status !== 'activo') {
    throw conflicto(
      'El influencer debe estar activo en la campaña para registrar o cambiar un acuerdo.',
      'participation_not_active',
    );
  }
}

/** Los productos son de la campaña y están ASIGNADOS a la participación (comprometer ≠ asignar). */
async function validarProductos(
  client: pg.PoolClient,
  campaignId: string,
  campaignInfluencerId: string,
  compromisos: readonly ProductCommitmentInput[],
): Promise<void> {
  if (compromisos.length === 0) return;
  const ids = compromisos.map((c) => c.campaignProductId);
  if (!ids.every(esUuid)) {
    throw invalido('Un producto comprometido no es válido.', 'commitments', 'product_not_in_campaign');
  }
  const { rows } = await client.query<{ id: string; asignado: boolean }>(
    `SELECT cp.id, (cip.campaign_product_id IS NOT NULL) AS asignado
       FROM campaign_products cp
       LEFT JOIN campaign_influencer_products cip
              ON cip.campaign_product_id = cp.id AND cip.campaign_influencer_id = $3
      WHERE cp.id = ANY($1) AND cp.campaign_id = $2`,
    [ids, campaignId, campaignInfluencerId],
  );
  const porId = new Map(rows.map((r) => [r.id, r.asignado]));
  for (const id of ids) {
    if (!porId.has(id)) {
      throw invalido(
        'Un producto comprometido no pertenece a esta campaña.',
        'commitments',
        'product_not_in_campaign',
      );
    }
    if (porId.get(id) !== true) {
      throw invalido(
        'Un producto comprometido no está asignado a este influencer: asígnelo antes de comprometerlo.',
        'commitments',
        'product_not_assigned',
      );
    }
  }
}

async function insertarVersion(
  client: pg.PoolClient,
  a: { organizationId: string; campaignId: string; agreementId: string },
  t: AgreementTerms,
  autorId: string,
): Promise<{ id: string; version: number }> {
  const { rows } = await client.query<{ id: string; version: number }>(
    `INSERT INTO agreement_versions
       (organization_id, campaign_id, agreement_id, compensation_type, fee_amount, fee_currency, starts_on,
        ends_on, conditions, change_reason, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     RETURNING id, version`,
    [
      a.organizationId,
      a.campaignId,
      a.agreementId,
      t.compensationType,
      t.feeAmount,
      t.feeCurrency,
      t.startsOn,
      t.endsOn,
      t.conditions,
      t.changeReason,
      autorId,
    ],
  );
  const version = rows[0]!;
  for (const c of t.commitments) {
    await client.query(
      `INSERT INTO agreement_product_commitments
         (organization_id, campaign_id, agreement_version_id, campaign_product_id, quantity)
       VALUES ($1, $2, $3, $4, $5)`,
      [a.organizationId, a.campaignId, version.id, c.campaignProductId, c.quantity],
    );
  }
  return version;
}

interface ObligacionBloqueada {
  readonly id: string;
  readonly status: PaymentObligationStatus;
  readonly rowSeq: number;
}

/**
 * Bloquea obligación → acuerdo (el orden del trigger de versiones: sin cruces) y devuelve ambos YA bloqueados.
 * Todo lo que dependa del estado vigente se lee DESPUÉS de esto.
 */
async function bloquearAcuerdo(
  client: pg.PoolClient,
  agreementId: string,
): Promise<{ acuerdo: FilaDeAcuerdo; obligacion: ObligacionBloqueada | undefined }> {
  const { rows: o } = await client.query<{ id: string; status: PaymentObligationStatus; row_seq: number }>(
    `SELECT id, status, row_seq FROM payment_obligations WHERE agreement_id = $1 FOR UPDATE`,
    [agreementId],
  );
  const { rows: a } = await client.query<FilaDeAcuerdo>(`${SELECT_ACUERDO} WHERE id = $1 FOR UPDATE`, [
    agreementId,
  ]);
  if (a[0] === undefined) throw new Abortar(NO_ENCONTRADO_DE_CONTENIDO);
  const fila = o[0];
  return {
    acuerdo: a[0],
    obligacion: fila === undefined ? undefined : { id: fila.id, status: fila.status, rowSeq: fila.row_seq },
  };
}

async function documentosVivos(client: pg.PoolClient, obligationId: string): Promise<number> {
  const { rows } = await client.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM billing_documents
      WHERE payment_obligation_id = $1 AND status IN ('registered', 'validated')`,
    [obligationId],
  );
  return rows[0]!.n;
}

async function leerParticipacion(client: pg.PoolClient, id: string): Promise<Participacion | undefined> {
  if (!esUuid(id)) return undefined;
  const { rows } = await client.query<Participacion>(
    `SELECT ci.id, ci.organization_id, ci.campaign_id, ci.status::text AS status, c.status::text AS campana
       FROM campaign_influencers ci
       JOIN campaigns c ON c.id = ci.campaign_id
      WHERE ci.id = $1
        FOR NO KEY UPDATE OF ci`,
    [id],
  );
  return rows[0];
}

// ─────────────────────────── Crear el acuerdo ──────────────────────────────────

/**
 * Crea el acuerdo de una participación: cabecera, versión 1, compromisos de producto y su obligación de pago
 * (barter ⇒ `not_applicable`; fee/mixed ⇒ `pending`) con su evento `payment.applicability_set`, en UNA
 * transacción. Exige `agreement:manage`, persona por la UI. Un acuerdo por participación: el segundo ⇒
 * `RESOURCE_CONFLICT` `agreement_exists` (con el id). Idempotente por `idempotencyKey`: el reintento idéntico
 * devuelve el mismo acuerdo (`repetido`); la misma clave con otra solicitud ⇒ `idempotency_key_reused`.
 */
export async function crearAcuerdo(
  actor: User,
  input: CrearAcuerdoInput,
  contexto?: ContextoDeAuditoria,
): Promise<Result<AcuerdoRegistrado>> {
  return transaccionOperativa(async (client) => {
    const persona = exigirPersonaPorUiOAbortar(actor, contexto);
    const participacion = await leerParticipacion(client, input.campaignInfluencerId);
    if (participacion === undefined) throw new Abortar(NO_ENCONTRADO_DE_CONTENIDO);
    autorizarOAbortar(persona, 'agreement:manage', participacion.organization_id);
    const clave = exigirClave(input.idempotencyKey);
    const terminos = aceptar(
      validarTerminosDeAcuerdo({
        compensationType: input.compensationType,
        feeAmount: input.feeAmount,
        feeCurrency: input.feeCurrency,
        startsOn: input.startsOn,
        endsOn: input.endsOn,
        conditions: input.conditions,
        changeReason: null,
        commitments: input.commitments,
      }),
    );
    const estadoInicial = obligacionInicialPara(terminos.compensationType);
    const extraDe = (agreementId: string): Record<string, unknown> => ({
      agreementId,
      campaignInfluencerId: participacion.id,
      terminos: huellaDeTerminos(terminos),
    });
    const huellaDe = (agreementId: string): string =>
      calcularHuellaDeEvento({
        sujeto: { tipo: 'payment_obligation', id: '' },
        eventType: 'payment.applicability_set',
        toStatus: estadoInicial,
        expectedSeq: 0,
        huellaExtra: extraDe(agreementId),
      });

    // Idempotencia y unicidad ANTES de escribir (la participación está bloqueada: serializa el alta).
    const previo = await buscarEventoPorClave(client, participacion.organization_id, clave);
    const { rows: existente } = await client.query<FilaDeAcuerdo>(
      `${SELECT_ACUERDO} WHERE campaign_influencer_id = $1`,
      [participacion.id],
    );
    if (existente[0] !== undefined) {
      if (previo !== undefined && previo.requestHash === huellaDe(existente[0].id)) {
        return { acuerdo: await cargarVistaDeAcuerdo(client, existente[0], persona), repetido: true };
      }
      if (previo !== undefined) {
        throw conflicto('Esa clave de idempotencia ya se usó con otra solicitud.', 'idempotency_key_reused');
      }
      throw conflicto(
        'Esta participación ya tiene un acuerdo: registre una versión nueva.',
        'agreement_exists',
        {
          agreementId: existente[0].id,
        },
      );
    }
    if (previo !== undefined) {
      throw conflicto('Esa clave de idempotencia ya se usó con otra solicitud.', 'idempotency_key_reused');
    }

    exigirParticipacionActiva(participacion);
    await validarProductos(client, participacion.campaign_id, participacion.id, terminos.commitments);

    const { rows: creado } = await client.query<{ id: string }>(
      `INSERT INTO agreements (organization_id, campaign_id, campaign_influencer_id, created_by)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [participacion.organization_id, participacion.campaign_id, participacion.id, persona.id],
    );
    const agreementId = creado[0]!.id;
    const ambito = {
      organizationId: participacion.organization_id,
      campaignId: participacion.campaign_id,
      agreementId,
    };
    await insertarVersion(client, ambito, terminos, persona.id);
    const { rows: obligacion } = await client.query<{ id: string }>(
      `INSERT INTO payment_obligations (organization_id, campaign_id, agreement_id, status, created_by)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [participacion.organization_id, participacion.campaign_id, agreementId, estadoInicial, persona.id],
    );
    await aplicarEventoOperativo(client, {
      actor: persona,
      contexto,
      action: 'agreement:manage',
      sujeto: { tipo: 'payment_obligation', id: obligacion[0]!.id },
      eventType: 'payment.applicability_set',
      toStatus: estadoInicial,
      expectedSeq: 0,
      idempotencyKey: clave,
      huellaExtra: extraDe(agreementId),
      auditoria: { agreementId, compensationType: terminos.compensationType },
    });
    await recordAudit(
      client,
      auditoriaDe(persona, contexto, {
        action: 'agreement.created',
        entityType: 'agreement',
        entityId: agreementId,
        metadata: {
          agreementId,
          campaignId: participacion.campaign_id,
          campaignInfluencerId: participacion.id,
          version: 1,
          compensationType: terminos.compensationType,
          status: 'active',
          count: terminos.commitments.length,
        },
      }),
    );
    const { rows } = await client.query<FilaDeAcuerdo>(`${SELECT_ACUERDO} WHERE id = $1`, [agreementId]);
    return { acuerdo: await cargarVistaDeAcuerdo(client, rows[0]!, persona), repetido: false };
  });
}

// ─────────────────────────── Registrar una versión ─────────────────────────────

/** ¿La versión `numero` del acuerdo ya es EXACTAMENTE esta solicitud, de esta misma persona? (reintento) */
async function versionCoincide(
  client: pg.PoolClient,
  agreementId: string,
  numero: number,
  t: AgreementTerms,
  autorId: string,
): Promise<boolean> {
  const { rows } = await client.query<FilaDeVersion>(
    `${selectDeVersion(true)} WHERE v.agreement_id = $1 AND v.version = $2`,
    [agreementId, numero],
  );
  const v = rows[0];
  if (v === undefined || v.created_by !== autorId) return false;
  if (
    v.compensation_type !== t.compensationType ||
    v.fee_amount !== t.feeAmount ||
    v.fee_currency !== t.feeCurrency ||
    v.starts_on !== t.startsOn ||
    v.ends_on !== t.endsOn ||
    v.conditions !== t.conditions ||
    v.change_reason !== t.changeReason
  ) {
    return false;
  }
  const guardados = (await cargarCompromisos(client, [v.id])).get(v.id) ?? [];
  const pedidos = ordenarCompromisos(t.commitments);
  const propios = [...guardados].sort((a, b) => a.campaignProductId.localeCompare(b.campaignProductId));
  return (
    propios.length === pedidos.length &&
    propios.every(
      (c, i) => c.campaignProductId === pedidos[i]!.campaignProductId && c.quantity === pedidos[i]!.quantity,
    )
  );
}

/**
 * Registra la versión N+1 de un acuerdo (los términos anteriores quedan intactos, con su historial). Exige
 * `agreement:manage`, persona por la UI, el motivo del cambio y `expectedVersion` (desfasada ⇒ `RESOURCE_CONFLICT`
 * `stale_version`: con dos cambios simultáneos sobre la misma versión gana exactamente uno). Si el modo cambia
 * entre barter y fee/mixed ajusta la obligación (`payment.applicability_set`): `pending → not_applicable` exige
 * cero documentos de cobro vivos; con el pago ya reportado, un cambio de modo, monto o moneda se rechaza
 * (`payment_reported`). El reintento idéntico (misma persona, misma `expectedVersion` y solicitud) devuelve la
 * versión ya registrada (`repetido`).
 */
export async function registrarVersionDeAcuerdo(
  actor: User,
  agreementId: string,
  input: RegistrarVersionInput,
  contexto?: ContextoDeAuditoria,
): Promise<Result<VersionRegistrada>> {
  return transaccionOperativa(async (client) => {
    const persona = exigirPersonaPorUiOAbortar(actor, contexto);
    if (!esUuid(agreementId)) throw new Abortar(NO_ENCONTRADO_DE_CONTENIDO);
    const { rows: dueña } = await client.query<{ organization_id: string }>(
      `SELECT organization_id FROM agreements WHERE id = $1`,
      [agreementId],
    );
    if (dueña[0] === undefined) throw new Abortar(NO_ENCONTRADO_DE_CONTENIDO);
    autorizarOAbortar(persona, 'agreement:manage', dueña[0].organization_id);
    const clave = exigirClave(input.idempotencyKey);
    if (!Number.isInteger(input.expectedVersion) || input.expectedVersion < 1) {
      throw invalido('expectedVersion debe ser la versión vigente que vio (entero ≥ 1).', 'expectedVersion');
    }
    const terminos = aceptar(
      validarTerminosDeAcuerdo(
        {
          compensationType: input.compensationType,
          feeAmount: input.feeAmount,
          feeCurrency: input.feeCurrency,
          startsOn: input.startsOn,
          endsOn: input.endsOn,
          conditions: input.conditions,
          changeReason: input.changeReason,
          commitments: input.commitments,
        },
        input.expectedVersion + 1,
      ),
    );

    const { acuerdo, obligacion } = await bloquearAcuerdo(client, agreementId);
    // Reintento: la versión siguiente ya es esta solicitud, de esta persona.
    if (
      acuerdo.current_version === input.expectedVersion + 1 &&
      (await versionCoincide(client, agreementId, acuerdo.current_version, terminos, persona.id))
    ) {
      return {
        acuerdo: await cargarVistaDeAcuerdo(client, acuerdo, persona),
        repetido: true,
        obligacionAjustada: false,
      };
    }
    if (acuerdo.status !== 'active') {
      throw conflicto('El acuerdo está cancelado: no admite versiones nuevas.', 'agreement_cancelled');
    }
    if (acuerdo.current_version !== input.expectedVersion) {
      throw conflicto(
        'El acuerdo cambió mientras lo editaba: recargue e inténtelo de nuevo.',
        'stale_version',
        { expectedVersion: input.expectedVersion, currentVersion: acuerdo.current_version },
      );
    }
    const participacion = await leerParticipacion(client, acuerdo.campaign_influencer_id);
    exigirParticipacionActiva(participacion!);

    const [previa] = await cargarVersiones(client, agreementId, true, acuerdo.current_version);
    aceptar(
      puedeVersionarAcuerdo(
        {
          compensationType: previa!.compensationType,
          feeAmount: previa!.feeAmount ?? null,
          feeCurrency: previa!.feeCurrency ?? null,
        },
        {
          compensationType: terminos.compensationType,
          feeAmount: terminos.feeAmount,
          feeCurrency: terminos.feeCurrency,
        },
        obligacion?.status,
      ),
    );
    await validarProductos(client, acuerdo.campaign_id, acuerdo.campaign_influencer_id, terminos.commitments);

    // ¿Ajusta la obligación? not_applicable → pending (pasa a tener tarifa) · pending → not_applicable (canje puro).
    let nuevoEstado: 'pending' | 'not_applicable' | null = null;
    if (obligacion?.status === 'not_applicable' && terminos.compensationType !== 'barter') {
      nuevoEstado = 'pending';
    } else if (obligacion?.status === 'pending' && terminos.compensationType === 'barter') {
      if ((await documentosVivos(client, obligacion.id)) > 0) {
        throw conflicto(
          'La obligación tiene documentos de cobro vivos: anúlelos o recházelos antes de pasar a canje puro.',
          'live_documents',
        );
      }
      nuevoEstado = 'not_applicable';
    }

    const ambito = {
      organizationId: acuerdo.organization_id,
      campaignId: acuerdo.campaign_id,
      agreementId,
    };
    // La versión va ANTES del evento: las reglas de la obligación leen la versión vigente.
    const version = await insertarVersion(client, ambito, terminos, persona.id);
    if (nuevoEstado !== null && obligacion !== undefined) {
      await aplicarEventoOperativo(client, {
        actor: persona,
        contexto,
        action: 'agreement:manage',
        sujeto: { tipo: 'payment_obligation', id: obligacion.id },
        eventType: 'payment.applicability_set',
        toStatus: nuevoEstado,
        expectedSeq: obligacion.rowSeq,
        idempotencyKey: clave,
        huellaExtra: {
          agreementId,
          expectedVersion: input.expectedVersion,
          terminos: huellaDeTerminos(terminos),
        },
        auditoria: { agreementId, version: version.version, compensationType: terminos.compensationType },
      });
    }
    await recordAudit(
      client,
      auditoriaDe(persona, contexto, {
        action: 'agreement.version_registered',
        entityType: 'agreement',
        entityId: agreementId,
        metadata: {
          agreementId,
          campaignId: acuerdo.campaign_id,
          campaignInfluencerId: acuerdo.campaign_influencer_id,
          version: version.version,
          compensationType: terminos.compensationType,
          status: 'active',
          count: terminos.commitments.length,
        },
      }),
    );
    const { rows } = await client.query<FilaDeAcuerdo>(`${SELECT_ACUERDO} WHERE id = $1`, [agreementId]);
    return {
      acuerdo: await cargarVistaDeAcuerdo(client, rows[0]!, persona),
      repetido: false,
      obligacionAjustada: nuevoEstado !== null,
    };
  });
}

// ─────────────────────────── Cancelar el acuerdo ───────────────────────────────

/**
 * `active → cancelled`, con motivo y quién (el estado se conserva: nada se borra). Exige `agreement:manage`,
 * persona por la UI. Si la obligación está `pending` o `not_applicable` y sin documentos de cobro vivos, la
 * cancela por el motor (`payment.cancelled`); con el pago ya reportado no se toca. Cancelar dos veces con el
 * mismo motivo y la misma persona devuelve el resultado (`repetido`); si no, `agreement_cancelled`.
 */
export async function cancelarAcuerdo(
  actor: User,
  agreementId: string,
  input: CancelarAcuerdoInput,
  contexto?: ContextoDeAuditoria,
): Promise<Result<AcuerdoCancelado>> {
  return transaccionOperativa(async (client) => {
    const persona = exigirPersonaPorUiOAbortar(actor, contexto);
    if (!esUuid(agreementId)) throw new Abortar(NO_ENCONTRADO_DE_CONTENIDO);
    const { rows: dueña } = await client.query<{ organization_id: string }>(
      `SELECT organization_id FROM agreements WHERE id = $1`,
      [agreementId],
    );
    if (dueña[0] === undefined) throw new Abortar(NO_ENCONTRADO_DE_CONTENIDO);
    autorizarOAbortar(persona, 'agreement:manage', dueña[0].organization_id);
    const clave = exigirClave(input.idempotencyKey);
    const motivo = aceptar(validarMotivoDeCancelacionDeAcuerdo(input.reason));

    const { acuerdo, obligacion } = await bloquearAcuerdo(client, agreementId);
    if (acuerdo.status === 'cancelled') {
      if (acuerdo.cancelled_by === persona.id && acuerdo.cancel_reason === motivo) {
        return {
          acuerdo: await cargarVistaDeAcuerdo(client, acuerdo, persona),
          repetido: true,
          obligacionCancelada: obligacion?.status === 'cancelled',
        };
      }
      throw conflicto('El acuerdo ya está cancelado.', 'agreement_cancelled');
    }

    const [vigente] = await cargarVersiones(client, agreementId, false, acuerdo.current_version);
    await client.query(
      `UPDATE agreements SET status = 'cancelled', cancelled_by = $2, cancel_reason = $3 WHERE id = $1`,
      [agreementId, persona.id, motivo],
    );
    let obligacionCancelada = false;
    if (
      obligacion !== undefined &&
      (obligacion.status === 'pending' || obligacion.status === 'not_applicable') &&
      (await documentosVivos(client, obligacion.id)) === 0
    ) {
      await aplicarEventoOperativo(client, {
        actor: persona,
        contexto,
        action: 'agreement:manage',
        sujeto: { tipo: 'payment_obligation', id: obligacion.id },
        eventType: 'payment.cancelled',
        toStatus: 'cancelled',
        expectedSeq: obligacion.rowSeq,
        idempotencyKey: clave,
        huellaExtra: { agreementId, cancelaAcuerdo: true },
        auditoria: { agreementId },
      });
      obligacionCancelada = true;
    }
    await recordAudit(
      client,
      auditoriaDe(persona, contexto, {
        action: 'agreement.cancelled',
        entityType: 'agreement',
        entityId: agreementId,
        metadata: {
          agreementId,
          campaignId: acuerdo.campaign_id,
          campaignInfluencerId: acuerdo.campaign_influencer_id,
          version: acuerdo.current_version,
          compensationType: vigente!.compensationType,
          status: 'cancelled',
        },
      }),
    );
    const { rows } = await client.query<FilaDeAcuerdo>(`${SELECT_ACUERDO} WHERE id = $1`, [agreementId]);
    return {
      acuerdo: await cargarVistaDeAcuerdo(client, rows[0]!, persona),
      repetido: false,
      obligacionCancelada,
    };
  });
}

// ─────────────────────────── Lecturas ──────────────────────────────────────────

function personaOError(actor: unknown): Result<User> {
  if (typeof actor !== 'object' || actor === null) {
    return err({ code: 'FORBIDDEN_ROLE', message: 'Esta consulta la hace una persona autorizada.' });
  }
  return ok(actor as User);
}

/**
 * Acuerdo de una participación con los términos de su versión vigente. Exige `agreement:read` (admin, director,
 * consultor, operativo): sin dinero. El fee, la moneda y la obligación de pago solo con `finance:read`. Cliente,
 * ajeno ⇒ `RESOURCE_NOT_FOUND`; analista/legal ⇒ `FORBIDDEN_ROLE`. `null` si la participación aún no tiene acuerdo.
 */
export async function obtenerAcuerdo(
  actor: User,
  campaignInfluencerId: string,
): Promise<Result<AcuerdoVista | null>> {
  const persona = personaOError(actor);
  if (!persona.ok) return persona;
  if (!esUuid(campaignInfluencerId)) return err(NO_ENCONTRADO_DE_CONTENIDO);
  const pool = getPool();
  const { rows: dueña } = await pool.query<{ organization_id: string }>(
    `SELECT organization_id FROM campaign_influencers WHERE id = $1`,
    [campaignInfluencerId],
  );
  if (dueña[0] === undefined) return err(NO_ENCONTRADO_DE_CONTENIDO);
  const permitido = authorizeInternalResource(persona.value, 'agreement:read', dueña[0].organization_id);
  if (!permitido.ok) return permitido;
  const { rows } = await pool.query<FilaDeAcuerdo>(`${SELECT_ACUERDO} WHERE campaign_influencer_id = $1`, [
    campaignInfluencerId,
  ]);
  if (rows[0] === undefined) return ok(null);
  return ok(await cargarVistaDeAcuerdo(pool, rows[0], persona.value));
}

/**
 * Historial de versiones del acuerdo (inmutables), de la 1 a la vigente, cada una con sus compromisos de
 * producto. Misma proyección por capacidad que `obtenerAcuerdo` (el dinero solo con `finance:read`).
 */
export async function listarVersionesDeAcuerdo(
  actor: User,
  agreementId: string,
): Promise<Result<VersionDeAcuerdoVista[]>> {
  const persona = personaOError(actor);
  if (!persona.ok) return persona;
  if (!esUuid(agreementId)) return err(NO_ENCONTRADO_DE_CONTENIDO);
  const pool = getPool();
  const { rows: dueña } = await pool.query<{ organization_id: string }>(
    `SELECT organization_id FROM agreements WHERE id = $1`,
    [agreementId],
  );
  if (dueña[0] === undefined) return err(NO_ENCONTRADO_DE_CONTENIDO);
  const permitido = authorizeInternalResource(persona.value, 'agreement:read', dueña[0].organization_id);
  if (!permitido.ok) return permitido;
  return ok(await cargarVersiones(pool, agreementId, roleCan(persona.value.role, 'finance:read'), undefined));
}
