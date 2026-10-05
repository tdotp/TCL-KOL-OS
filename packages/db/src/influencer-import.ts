/**
 * Importación de influencers desde un Google Sheet (V2 · Fase 5).
 *
 *   Snapshot ─► validación del esquema ─► PLAN ─► aplicar ─► Influencer →
 *   CampaignInfluencer → producto de campaña
 *                          └► resolución HUMANA de lo ambiguo
 *
 * Leer el Sheet y mutar el dominio son pasos separados con un plan verificable en
 * medio: el plan está ligado a UN snapshot (no se recalcula contra otro
 * contenido) y dice, por registro, qué se haría y por qué.
 *
 * Reglas que esta capa impone (además de las de `packages/domain`):
 *
 *  · Solo una PERSONA importa o resuelve (`exigirPersona`): `system` y el chat
 *    como canal nunca deciden una ambigüedad. Se revalidan los permisos al
 *    aplicar; el actor y su correlación quedan en cada mutación (`created_by` de
 *    los Influencer/CampaignInfluencer es la persona, no el worker).
 *  · Los casos de uso de la Fase 3 hacen la escritura (`crearInfluencer`,
 *    `agregarCuenta`, `asociarInfluencerACampana`, `asociarProductoAInfluencer`):
 *    no se duplican sus reglas. Cada uno es atómico; el binding y los efectos de
 *    un registro se confirman juntos DESPUÉS, y volver a aplicar reanuda sin
 *    duplicar (la cuenta ya existente se reconoce por coincidencia exacta).
 *  · Nada se elimina ni se reemplaza por ausencia o cambio: una persona que
 *    desaparece del Sheet, un cambio de producto o de cuenta, o una participación
 *    retirada quedan como decisión humana. Se admite añadir; no se reescribe.
 *  · Una campaña archivada o cancelada puede leer, comparar y planear, pero no
 *    materializar: ni aplicar ni resolver.
 *  · No se usa `ProposedAction`: importar o asociar una persona iniciada por Cuenta
 *    no equivale a aprobar un brief. La decisión humana queda como hecho
 *    append-only y auditado; HITL de aprobaciones críticas no se toca.
 */

import { createHash } from 'node:crypto';
import type pg from 'pg';
import {
  type AdditiveAccount,
  type IdentityDecision,
  type IdentityFacts,
  type ProductDecision,
  type RecordChange,
  type Result,
  type SheetIssue,
  type SheetRecord,
  type SheetRowLocator,
  type SocialPlatform,
  type User,
  authorizeInternalResource,
  compararRegistros,
  decidirIdentidad,
  decidirProductos,
  err,
  normalizeProductRef,
  ok,
  validateInfluencerSheet,
} from '@tcl-kol-os/domain';
import { recordAudit } from './audit.ts';
import { getPool, transaction } from './client.ts';
import { agregarCuenta, buscarInfluencerPorCuenta, crearInfluencer, cuentasDe } from './influencers.ts';
import { asociarInfluencerACampana, asociarProductoAInfluencer } from './campaign-influencers.ts';
import { NO_ENCONTRADO } from './influencers.ts';
import { type ContextoDeAuditoria, auditoriaDe, exigirPersona } from './audit-context.ts';
import { cargarRejillaDeSnapshot } from './source-sync.ts';
import { Abortar } from './tx-result.ts';

type Consultor = pg.Pool | pg.PoolClient;

// ─────────────────────────── Tipos públicos ────────────────────────────────────

export type ImportPlanStatus = 'schema_invalid' | 'ready' | 'needs_resolution' | 'applied' | 'superseded';

/**
 * Estado de un registro dentro del plan, derivado de lo que YA ocurrió:
 *   actionable  se puede aplicar (o falta terminar de aplicar)
 *   blocked     espera una decisión humana (ambiguo, conflicto, cambio, retirado…)
 *   invalid     no cumple el esquema: se arregla en el Sheet o se ignora
 *   review      desapareció del Sheet: lo revisa una persona (nunca se retira solo)
 *   applied     ya materializado
 *   ignored     una persona decidió ignorarlo
 */
export type ImportRecordState = 'actionable' | 'blocked' | 'invalid' | 'review' | 'applied' | 'ignored';

export interface ImportPlan {
  readonly id: string;
  readonly organizationId: string;
  readonly campaignId: string;
  readonly sourceId: string;
  readonly snapshotId: string;
  readonly basePlanId: string | undefined;
  readonly schemaId: string;
  readonly schemaVersion: number | undefined;
  readonly status: ImportPlanStatus;
  readonly validation: ImportValidationReport;
  readonly summary: ImportPlanSummary;
  readonly createdBy: string;
  readonly createdAt: string;
}

/** Informe de validación guardado en el plan (sin valores del Sheet). */
export interface ImportValidationReport {
  readonly status: 'valid' | 'invalid';
  readonly schema: { readonly id: string; readonly version: number } | null;
  readonly sheet: { readonly name: string; readonly gid: number | null } | null;
  readonly errors: readonly SheetIssue[];
  readonly warnings: readonly SheetIssue[];
}

export interface ImportPlanSummary {
  readonly records: number;
  readonly byIdentity: Readonly<Record<string, number>>;
  readonly byChange: Readonly<Record<string, number>>;
  readonly productsPending: number;
  readonly blocking: number;
  readonly warnings: number;
  readonly errors: number;
}

export interface ImportResolution {
  readonly id: string;
  readonly recordId: string;
  readonly dimension: 'identity' | 'product' | 'ignore';
  readonly decision: ImportDecision['kind'];
  readonly influencerId: string | undefined;
  readonly campaignProductId: string | undefined;
  readonly productRef: string | undefined;
  readonly decidedBy: string;
  readonly reason: string | undefined;
  readonly createdAt: string;
}

export interface ImportRecordView {
  readonly id: string;
  readonly planId: string;
  readonly sourceKey: string;
  readonly kind: 'person' | 'missing_from_source';
  readonly displayName: string | undefined;
  readonly accounts: readonly {
    platform: SocialPlatform;
    handle: string;
    normalizedHandle: string;
    row: number;
  }[];
  readonly productRefs: readonly { ref: string; normalizedRef: string; row: number }[];
  readonly locators: readonly SheetRowLocator[];
  /** Columnas futuras con valor (solo nombres: los valores siguen en el snapshot). */
  readonly futureFields: readonly string[];
  readonly change: RecordChange;
  readonly changedFields: readonly string[];
  readonly identity: {
    readonly outcome: string;
    readonly influencerId: string | undefined;
    readonly campaignInfluencerId: string | undefined;
    readonly candidates: readonly string[];
    readonly reasons: readonly string[];
    readonly additiveAccounts: readonly AdditiveAccount[];
    readonly accountChanges: readonly AdditiveAccount[];
    readonly nameDiffers: { sheet: string; existing: string } | undefined;
  };
  readonly participation: string | undefined;
  readonly productOutcomes: readonly ProductDecision[];
  readonly problems: readonly SheetIssue[];
  readonly state: ImportRecordState;
  /** Por qué aún no está terminado (vacío si `applied` o `ignored`). */
  readonly pending: readonly string[];
  readonly binding: { influencerId: string; campaignInfluencerId: string; boundVia: string } | undefined;
  readonly resolutions: readonly ImportResolution[];
}

export interface ImportPlanDetail {
  readonly plan: ImportPlan;
  readonly records: readonly ImportRecordView[];
}

export type ImportDecision =
  | { readonly kind: 'use_existing_influencer'; readonly influencerId: string; readonly reason?: string }
  | { readonly kind: 'create_new_influencer'; readonly reason?: string }
  | {
      readonly kind: 'choose_product';
      readonly productRef: string;
      readonly campaignProductId: string;
      readonly reason?: string;
    }
  | { readonly kind: 'ignore_record'; readonly reason?: string };

export interface ImportRecordResult {
  readonly recordId: string;
  readonly sourceKey: string;
  readonly status: 'applied' | 'unchanged' | 'blocked' | 'ignored' | 'skipped';
  readonly reason: string | undefined;
  readonly influencerId: string | undefined;
  readonly campaignInfluencerId: string | undefined;
  readonly created: {
    readonly influencer: boolean;
    readonly accounts: number;
    readonly participation: boolean;
    readonly products: number;
  };
  readonly pending: readonly string[];
}

export interface ImportApplication {
  readonly planId: string;
  readonly planStatus: ImportPlanStatus;
  readonly records: readonly ImportRecordResult[];
}

// ─────────────────────────── Utilidades ────────────────────────────────────────

const sha256 = (texto: string): string => createHash('sha256').update(texto).digest('hex');

async function resultado<T>(fn: () => Promise<T>): Promise<Result<T>> {
  try {
    return ok(await fn());
  } catch (error) {
    if (error instanceof Abortar) return err(error.payload);
    throw error;
  }
}

function exigir(
  actor: User,
  organizationId: string,
  ...acciones: Parameters<typeof authorizeInternalResource>[1][]
): void {
  for (const accion of acciones) {
    const permitido = authorizeInternalResource(actor, accion, organizationId);
    if (!permitido.ok) throw new Abortar(permitido.error);
  }
}

const CONTEXTO_VACIO: ContextoDeAuditoria = {};

/**
 * Aplicar un plan y resolver un registro son decisiones humanas. Desde el
 * canal chat NO se ejecutan directamente (V2 · Fase 6, D6): el agente solo
 * puede PROPONERLAS (`proponerAccion`: `influencer_import.apply` /
 * `influencer_import.resolve_record`); las ejecuta la acción confirmada por
 * una persona desde la interfaz, con origen `ui` y la correlación de la
 * acción propuesta. Mismo patrón que `transicionarBrief` → `approved`.
 */
function exigirCanalHumano(contexto: ContextoDeAuditoria | undefined, accion: string): Result<true> {
  if (contexto?.origin === 'chat') {
    return err({
      code: 'HUMAN_CONFIRMATION_REQUIRED',
      message:
        'Esta decisión es humana: desde el chat debe proponerse como acción y confirmarla una persona desde la interfaz.',
      details: { accion, origen: 'chat' },
    });
  }
  return ok(true);
}

// ─────────────────────────── Filas ─────────────────────────────────────────────

interface PlanRow {
  readonly id: string;
  readonly organization_id: string;
  readonly campaign_id: string;
  readonly source_id: string;
  readonly snapshot_id: string;
  readonly base_plan_id: string | null;
  readonly schema_id: string;
  readonly schema_version: number | null;
  readonly status: ImportPlanStatus;
  readonly validation: ImportValidationReport;
  readonly summary: ImportPlanSummary;
  readonly created_by: string;
  readonly created_at: Date;
}

const SELECT_PLAN = `
  SELECT id, organization_id, campaign_id, source_id, snapshot_id, base_plan_id, schema_id, schema_version,
         status, validation, summary, created_by, created_at
    FROM influencer_import_plans
`;

function comoPlan(r: PlanRow): ImportPlan {
  return {
    id: r.id,
    organizationId: r.organization_id,
    campaignId: r.campaign_id,
    sourceId: r.source_id,
    snapshotId: r.snapshot_id,
    basePlanId: r.base_plan_id ?? undefined,
    schemaId: r.schema_id,
    schemaVersion: r.schema_version ?? undefined,
    status: r.status,
    validation: r.validation,
    summary: r.summary,
    createdBy: r.created_by,
    createdAt: r.created_at.toISOString(),
  };
}

interface RecordRow {
  readonly id: string;
  readonly plan_id: string;
  readonly organization_id: string;
  readonly campaign_id: string;
  readonly source_id: string;
  readonly snapshot_id: string;
  readonly source_key: string;
  readonly kind: 'person' | 'missing_from_source';
  readonly display_name: string | null;
  readonly accounts: ImportRecordView['accounts'];
  readonly product_refs: ImportRecordView['productRefs'];
  readonly locators: readonly SheetRowLocator[];
  readonly future_fields: readonly string[];
  readonly change: RecordChange;
  readonly change_detail: { fields?: string[]; parts?: Record<string, string> };
  readonly identity_outcome: string;
  readonly identity_detail: {
    influencerId?: string;
    campaignInfluencerId?: string;
    candidates?: string[];
    reasons?: string[];
    additiveAccounts?: AdditiveAccount[];
    accountChanges?: AdditiveAccount[];
    nameDiffers?: { sheet: string; existing: string };
  };
  readonly participation_outcome: string | null;
  readonly product_outcomes: readonly ProductDecision[];
  readonly problems: readonly SheetIssue[];
}

const SELECT_REGISTRO = `
  SELECT id, plan_id, organization_id, campaign_id, source_id, snapshot_id, source_key, kind, display_name,
         accounts, product_refs, locators, future_fields, change, change_detail, identity_outcome,
         identity_detail, participation_outcome, product_outcomes, problems
    FROM influencer_import_records
`;

interface ResolutionRow {
  readonly id: string;
  readonly record_id: string;
  readonly dimension: 'identity' | 'product' | 'ignore';
  readonly decision: ImportDecision['kind'];
  readonly influencer_id: string | null;
  readonly campaign_product_id: string | null;
  readonly product_ref: string | null;
  readonly decided_by: string;
  readonly reason: string | null;
  readonly created_at: Date;
}

const SELECT_RESOLUCION = `
  SELECT id, record_id, dimension, decision, influencer_id, campaign_product_id, product_ref, decided_by,
         reason, created_at
    FROM influencer_import_resolutions
`;

function comoResolucion(r: ResolutionRow): ImportResolution {
  return {
    id: r.id,
    recordId: r.record_id,
    dimension: r.dimension,
    decision: r.decision,
    influencerId: r.influencer_id ?? undefined,
    campaignProductId: r.campaign_product_id ?? undefined,
    productRef: r.product_ref ?? undefined,
    decidedBy: r.decided_by,
    reason: r.reason ?? undefined,
    createdAt: r.created_at.toISOString(),
  };
}

/** Reconstruye el registro del Sheet desde su fila del plan (lo que las decisiones necesitan). */
function registroDesdeFila(f: RecordRow): SheetRecord {
  return {
    sourceKey: f.source_key,
    displayName: f.display_name ?? '',
    accounts: f.accounts,
    products: f.product_refs,
    futureValues: [],
    rows: f.locators.map((l) => l.rowStart),
    locators: f.locators,
    problems: f.problems,
    fingerprint: { name: '', accounts: '', products: '', future: '' },
  };
}

// ─────────────────────────── Contexto de campaña y fuente ──────────────────────

interface CampanaCargada {
  readonly id: string;
  readonly organizationId: string;
  readonly status: string;
}

async function cargarCampana(db: Consultor, actor: User, campaignId: string): Promise<CampanaCargada> {
  const { rows } = await db.query<{ id: string; organization_id: string; status: string }>(
    `SELECT id, organization_id, status::text AS status FROM campaigns WHERE id = $1`,
    [campaignId],
  );
  const fila = rows[0];
  if (fila === undefined) throw new Abortar(NO_ENCONTRADO);
  // Un recurso ajeno se responde igual que uno inexistente (authorizeInternalResource).
  exigir(actor, fila.organization_id, 'campaign_influencer:read');
  return { id: fila.id, organizationId: fila.organization_id, status: fila.status };
}

interface FuenteDeSheet {
  readonly id: string;
  readonly currentSnapshotId: string | undefined;
  readonly gid: number | undefined;
}

async function cargarFuenteDeSheet(
  db: Consultor,
  campaign: CampanaCargada,
  sourceId: string,
): Promise<FuenteDeSheet> {
  const { rows } = await db.query<{
    id: string;
    origin: string;
    external_provider: string | null;
    external_metadata: { gid?: string };
    current_snapshot_id: string | null;
  }>(
    `SELECT id, origin::text AS origin, external_provider, external_metadata, current_snapshot_id
       FROM source_documents WHERE id = $1 AND campaign_id = $2 AND organization_id = $3`,
    [sourceId, campaign.id, campaign.organizationId],
  );
  const fila = rows[0];
  if (fila === undefined) throw new Abortar(NO_ENCONTRADO);
  if (fila.origin !== 'link' || fila.external_provider !== 'google_sheets') {
    throw new Abortar({
      code: 'VALIDATION_FAILED',
      message: 'La fuente no es un Google Sheet: solo un Sheet estructurado define influencers.',
      details: { reason: 'source_not_google_sheet' },
    });
  }
  const gid = fila.external_metadata.gid;
  return {
    id: fila.id,
    currentSnapshotId: fila.current_snapshot_id ?? undefined,
    gid: gid !== undefined && /^\d+$/.test(gid) ? Number(gid) : undefined,
  };
}

function exigirCampanaActiva(campaign: CampanaCargada): void {
  if (campaign.status !== 'activa') {
    throw new Abortar({
      code: 'RESOURCE_CONFLICT',
      message: `La campaña está ${campaign.status}: puede consultarse, pero no admite nuevas materializaciones desde el Sheet.`,
      details: { reason: 'campaign_not_active', campaignStatus: campaign.status },
    });
  }
}

// ─────────────────────────── Evaluación contra el dominio ──────────────────────

interface Evaluacion {
  readonly decision: IdentityDecision;
  readonly productos: ProductDecision[];
}

/**
 * Consulta los HECHOS del dominio (cuentas, bindings, participaciones, productos)
 * y aplica las reglas puras. Solo lee. Se usa al planear y de nuevo al aplicar
 * (la decisión de aplicar siempre se toma con el estado ACTUAL, no con el del plan).
 */
async function evaluarRegistros(
  db: Consultor,
  actor: User,
  campaign: CampanaCargada,
  sourceId: string,
  registros: readonly SheetRecord[],
): Promise<Map<string, Evaluacion>> {
  const { rows: bindings } = await db.query<{
    source_key: string;
    influencer_id: string;
    campaign_influencer_id: string;
  }>(
    `SELECT source_key, influencer_id, campaign_influencer_id FROM influencer_source_bindings WHERE source_id = $1`,
    [sourceId],
  );
  const bindingPorClave = new Map(bindings.map((b) => [b.source_key, b]));
  const vinculadoAClave = new Map(bindings.map((b) => [b.influencer_id, b.source_key]));

  const { rows: participaciones } = await db.query<{
    id: string;
    influencer_id: string;
    status: 'activo' | 'retirado';
  }>(`SELECT id, influencer_id, status FROM campaign_influencers WHERE campaign_id = $1`, [campaign.id]);
  const participacionDe = new Map(
    participaciones.map((p) => [p.influencer_id, { id: p.id, status: p.status }]),
  );

  // Coincidencia EXACTA de cuenta mediante el caso de uso de la Fase 3.
  const duenos = new Map<string, string>();
  const nombres = new Map<string, string>();
  const cuentasPorInfluencer = new Map<string, Map<SocialPlatform, Set<string>>>();
  const registrarCuentas = (
    influencerId: string,
    cuentas: readonly { platform: SocialPlatform; normalizedHandle: string }[],
  ): void => {
    const porPlataforma = cuentasPorInfluencer.get(influencerId) ?? new Map<SocialPlatform, Set<string>>();
    for (const c of cuentas) {
      const set = porPlataforma.get(c.platform) ?? new Set<string>();
      set.add(c.normalizedHandle);
      porPlataforma.set(c.platform, set);
    }
    cuentasPorInfluencer.set(influencerId, porPlataforma);
  };
  const vistas = new Set<string>();
  for (const registro of registros) {
    if (registro.problems.length > 0) continue;
    for (const cuenta of registro.accounts) {
      const clave = `${cuenta.platform}:${cuenta.normalizedHandle}`;
      if (vistas.has(clave)) continue;
      vistas.add(clave);
      const encontrado = await buscarInfluencerPorCuenta(actor, cuenta.platform, cuenta.handle);
      if (!encontrado.ok) throw new Abortar(encontrado.error);
      if (encontrado.value === undefined) continue;
      duenos.set(clave, encontrado.value.influencer.id);
      nombres.set(encontrado.value.influencer.id, encontrado.value.influencer.displayName);
      registrarCuentas(encontrado.value.influencer.id, encontrado.value.accounts);
    }
  }
  // Las personas con binding se evalúan aunque ninguna cuenta del registro coincida.
  const conBinding = bindings.map((b) => b.influencer_id).filter((id) => !cuentasPorInfluencer.has(id));
  if (conBinding.length > 0) {
    const cuentas = await cuentasDe(db, conBinding);
    for (const [id, lista] of cuentas) registrarCuentas(id, lista);
    const { rows } = await db.query<{ id: string; display_name: string }>(
      `SELECT id, display_name FROM influencers WHERE id = ANY($1::uuid[])`,
      [conBinding],
    );
    for (const r of rows) nombres.set(r.id, r.display_name);
  }

  const { rows: opciones } = await db.query<{ campaign_product_id: string; brand: string; model: string }>(
    `SELECT cp.id AS campaign_product_id, p.brand, p.model
       FROM campaign_products cp JOIN products p ON p.id = cp.product_id
      WHERE cp.campaign_id = $1`,
    [campaign.id],
  );
  const { rows: asignaciones } = await db.query<{
    campaign_influencer_id: string;
    campaign_product_id: string;
  }>(
    `SELECT campaign_influencer_id, campaign_product_id FROM campaign_influencer_products WHERE campaign_id = $1`,
    [campaign.id],
  );
  const asignadosPor = new Map<string, Set<string>>();
  for (const a of asignaciones) {
    const set = asignadosPor.get(a.campaign_influencer_id) ?? new Set<string>();
    set.add(a.campaign_product_id);
    asignadosPor.set(a.campaign_influencer_id, set);
  }

  const resultado = new Map<string, Evaluacion>();
  for (const registro of registros) {
    const binding = bindingPorClave.get(registro.sourceKey);
    const hechos: IdentityFacts = {
      binding:
        binding === undefined
          ? undefined
          : { influencerId: binding.influencer_id, campaignInfluencerId: binding.campaign_influencer_id },
      accountOwners: duenos,
      boundToOtherKey: vinculadoAClave,
      accountsByInfluencer: cuentasPorInfluencer,
      participations: participacionDe,
      displayNames: nombres,
    };
    const decision = decidirIdentidad(registro, hechos);
    const participacionId =
      decision.campaignInfluencerId ??
      (decision.influencerId === undefined ? undefined : participacionDe.get(decision.influencerId)?.id);
    const asignados =
      participacionId === undefined ? new Set<string>() : (asignadosPor.get(participacionId) ?? new Set());
    resultado.set(registro.sourceKey, {
      decision,
      productos: decidirProductos(
        registro,
        opciones.map((o) => ({
          campaignProductId: o.campaign_product_id,
          brand: o.brand,
          model: o.model,
        })),
        asignados,
      ),
    });
  }
  return resultado;
}

// ─────────────────────────── Validación y plan ─────────────────────────────────

function informeDe(v: ReturnType<typeof validateInfluencerSheet>): ImportValidationReport {
  return {
    status: v.status,
    schema: v.schema,
    sheet: v.sheet === null ? null : { name: v.sheet.name, gid: v.sheet.gid ?? null },
    errors: v.errors,
    warnings: v.warnings,
  };
}

/** Valida un snapshot contra el esquema V1 SIN persistir nada. */
export async function validateInfluencerSheetSnapshot(
  actor: User,
  input: { readonly campaignId: string; readonly sourceId: string; readonly snapshotId?: string | undefined },
) {
  return resultado(async () => {
    const campana = await cargarCampana(getPool(), actor, input.campaignId);
    exigir(actor, campana.organizationId, 'source:read', 'influencer:read');
    const fuente = await cargarFuenteDeSheet(getPool(), campana, input.sourceId);
    const snapshotId = input.snapshotId ?? fuente.currentSnapshotId;
    if (snapshotId === undefined) {
      throw new Abortar({
        code: 'VALIDATION_FAILED',
        message: 'La fuente aún no tiene ninguna lectura (snapshot): sincronícela primero.',
        details: { reason: 'no_snapshot' },
      });
    }
    await exigirSnapshotDeFuente(getPool(), fuente.id, snapshotId);
    const grid = await cargarRejillaDeSnapshot(getPool(), snapshotId);
    return { snapshotId, ...validateInfluencerSheet(grid, { gid: fuente.gid }) };
  });
}

async function exigirSnapshotDeFuente(db: Consultor, sourceId: string, snapshotId: string): Promise<number> {
  const { rows } = await db.query<{ sequence: number }>(
    `SELECT sequence FROM source_snapshots WHERE id = $1 AND source_id = $2`,
    [snapshotId, sourceId],
  );
  if (rows[0] === undefined) throw new Abortar(NO_ENCONTRADO);
  return rows[0].sequence;
}

function huellaDe(registro: SheetRecord) {
  const partes = {
    name: sha256(registro.fingerprint.name),
    accounts: sha256(registro.fingerprint.accounts),
    products: sha256(registro.fingerprint.products),
    future: sha256(registro.fingerprint.future),
  };
  return { partes, contentHash: sha256(JSON.stringify(partes)) };
}

function esBloqueante(
  identity: string,
  participation: string | undefined,
  productos: readonly ProductDecision[],
): boolean {
  return (
    ['ambiguous', 'conflict', 'needs_resolution', 'invalid', 'missing_from_source'].includes(identity) ||
    participation === 'retired' ||
    productos.some((p) => ['unresolved', 'ambiguous', 'product_change'].includes(p.outcome))
  );
}

/**
 * Prepara el plan de importación de UN snapshot: valida el esquema, evalúa cada
 * registro contra el dominio (solo lectura) y lo persiste. Idempotente: el mismo
 * snapshot devuelve el mismo plan. NO muta Influencers ni participaciones.
 */
export async function prepareInfluencerImport(
  actor: User,
  input: { readonly campaignId: string; readonly sourceId: string; readonly snapshotId?: string | undefined },
  contexto: ContextoDeAuditoria = CONTEXTO_VACIO,
): Promise<Result<ImportPlanDetail>> {
  const persona = exigirPersona(actor, contexto);
  if (!persona.ok) return persona;

  return resultado(async () => {
    const campana = await cargarCampana(getPool(), actor, input.campaignId);
    exigir(actor, campana.organizationId, 'source:read', 'influencer:read', 'campaign_influencer:manage');
    const fuente = await cargarFuenteDeSheet(getPool(), campana, input.sourceId);
    const snapshotId = input.snapshotId ?? fuente.currentSnapshotId;
    if (snapshotId === undefined) {
      throw new Abortar({
        code: 'VALIDATION_FAILED',
        message: 'La fuente aún no tiene ninguna lectura (snapshot): sincronícela primero.',
        details: { reason: 'no_snapshot' },
      });
    }
    const secuencia = await exigirSnapshotDeFuente(getPool(), fuente.id, snapshotId);

    const existente = await getPool().query<{ id: string }>(
      `SELECT id FROM influencer_import_plans WHERE source_id = $1 AND snapshot_id = $2`,
      [fuente.id, snapshotId],
    );
    if (existente.rows[0] !== undefined) return cargarDetalle(getPool(), existente.rows[0].id);

    const grid = await cargarRejillaDeSnapshot(getPool(), snapshotId);
    const validacion = validateInfluencerSheet(grid, { gid: fuente.gid });

    // Plan anterior con el que comparar (el más reciente con esquema válido).
    const { rows: bases } = await getPool().query<{ id: string }>(
      `SELECT p.id FROM influencer_import_plans p
         JOIN source_snapshots n ON n.id = p.snapshot_id
        WHERE p.source_id = $1 AND p.status <> 'schema_invalid' AND n.sequence < $2
        ORDER BY n.sequence DESC LIMIT 1`,
      [fuente.id, secuencia],
    );
    const basePlanId = bases[0]?.id;

    const esquemaValido = validacion.status === 'valid';
    const evaluaciones = esquemaValido
      ? await evaluarRegistros(getPool(), actor, campana, fuente.id, validacion.records)
      : new Map<string, Evaluacion>();

    // Registros del plan anterior (para nuevo / sin cambios / cambiado / desaparecido).
    const anteriores = basePlanId === undefined ? [] : await huellasDelPlan(getPool(), basePlanId);
    const diffs = compararRegistros(
      anteriores.map((a) => ({ sourceKey: a.sourceKey, fingerprint: a.parts })),
      validacion.records.map((r) => ({ sourceKey: r.sourceKey, fingerprint: huellaDe(r).partes })),
    );
    const cambioDe = new Map(diffs.map((d) => [d.sourceKey, d]));

    // Claves vinculadas que ya no aparecen en el Sheet: se REVISAN, nunca se retiran
    // solas. Se parte de los bindings (no del plan anterior), de modo que una ausencia
    // sostenida sigue señalada hasta que una persona la revisa (ignora).
    const clavesActuales = new Set(validacion.records.map((r) => r.sourceKey));
    const faltantes = esquemaValido
      ? (
          await getPool().query<{
            source_key: string;
            influencer_id: string;
            campaign_influencer_id: string;
            display_name: string | null;
            accounts: ImportRecordView['accounts'];
          }>(
            `SELECT b.source_key, b.influencer_id, b.campaign_influencer_id, r.display_name, r.accounts
               FROM influencer_source_bindings b
               JOIN influencer_import_records r ON r.id = b.origin_record_id
              WHERE b.source_id = $1
                AND NOT EXISTS (
                  -- Ya revisada: una ausencia ignorada no se vuelve a señalar mientras
                  -- la clave no haya reaparecido en un plan posterior.
                  SELECT 1
                    FROM influencer_import_records m
                    JOIN influencer_import_resolutions x ON x.record_id = m.id AND x.dimension = 'ignore'
                    JOIN influencer_import_plans mp ON mp.id = m.plan_id
                   WHERE m.source_id = b.source_id AND m.source_key = b.source_key
                     AND m.kind = 'missing_from_source'
                     AND NOT EXISTS (
                       SELECT 1
                         FROM influencer_import_records q
                         JOIN influencer_import_plans qp ON qp.id = q.plan_id
                        WHERE q.source_id = b.source_id AND q.source_key = b.source_key
                          AND q.kind = 'person' AND qp.created_at > mp.created_at))`,
            [fuente.id],
          )
        ).rows
          .filter((b) => !clavesActuales.has(b.source_key))
          .map((b) => ({
            binding: {
              source_key: b.source_key,
              influencer_id: b.influencer_id,
              campaign_influencer_id: b.campaign_influencer_id,
            },
            previo: {
              sourceKey: b.source_key,
              displayName: b.display_name ?? '',
              accounts: b.accounts,
              parts: anteriores.find((a) => a.sourceKey === b.source_key)?.parts,
            },
          }))
      : [];

    const resumen = (
      filas: { identity: string; change: string; bloqueante: boolean; pendientes: number }[],
    ) => {
      const porIdentidad: Record<string, number> = {};
      const porCambio: Record<string, number> = {};
      for (const f of filas) {
        porIdentidad[f.identity] = (porIdentidad[f.identity] ?? 0) + 1;
        porCambio[f.change] = (porCambio[f.change] ?? 0) + 1;
      }
      return {
        records: filas.length,
        byIdentity: porIdentidad,
        byChange: porCambio,
        productsPending: filas.reduce((n, f) => n + f.pendientes, 0),
        blocking: filas.filter((f) => f.bloqueante).length,
        warnings: validacion.warnings.length,
        errors: validacion.errors.length,
      } satisfies ImportPlanSummary;
    };

    const filas = validacion.records.map((registro) => {
      const evaluacion = evaluaciones.get(registro.sourceKey)!;
      const cambio = cambioDe.get(registro.sourceKey);
      return {
        registro,
        evaluacion,
        cambio: (cambio?.change ?? 'new') as RecordChange,
        campos: cambio?.fields ?? [],
      };
    });
    const resumenFilas = [
      ...filas.map((f) => ({
        identity: f.evaluacion.decision.outcome,
        change: f.cambio,
        bloqueante: esBloqueante(
          f.evaluacion.decision.outcome,
          f.evaluacion.decision.participation,
          f.evaluacion.productos,
        ),
        pendientes: f.evaluacion.productos.filter((p) =>
          ['unresolved', 'ambiguous', 'product_change'].includes(p.outcome),
        ).length,
      })),
      ...faltantes.map(() => ({
        identity: 'missing_from_source',
        change: 'missing_from_source',
        bloqueante: true,
        pendientes: 0,
      })),
    ];
    const estado: ImportPlanStatus = !esquemaValido
      ? 'schema_invalid'
      : resumenFilas.some((f) => f.bloqueante)
        ? 'needs_resolution'
        : 'ready';

    return transaction(async (client) => {
      // Serializa la preparación de la misma fuente; otra pudo ganar la carrera.
      await client.query(`SELECT id FROM source_documents WHERE id = $1 FOR UPDATE`, [fuente.id]);
      const carrera = await client.query<{ id: string }>(
        `SELECT id FROM influencer_import_plans WHERE source_id = $1 AND snapshot_id = $2`,
        [fuente.id, snapshotId],
      );
      if (carrera.rows[0] !== undefined) return cargarDetalle(client, carrera.rows[0].id);

      const informe = informeDe(validacion);
      const { rows: creados } = await client.query<{ id: string }>(
        `INSERT INTO influencer_import_plans
                (organization_id, campaign_id, source_id, snapshot_id, base_plan_id, schema_id, schema_version,
                 status, validation, summary, created_by, correlation)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb, $11, $12::jsonb)
         RETURNING id`,
        [
          campana.organizationId,
          campana.id,
          fuente.id,
          snapshotId,
          basePlanId ?? null,
          validacion.schema?.id ?? 'TCL_KOL_OS_INFLUENCERS',
          validacion.schema?.version ?? null,
          estado,
          JSON.stringify(informe),
          JSON.stringify(resumen(resumenFilas)),
          actor.id,
          contexto.correlation === undefined ? null : JSON.stringify(contexto.correlation),
        ],
      );
      const planId = creados[0]!.id;

      const insertar = async (valores: {
        sourceKey: string;
        kind: 'person' | 'missing_from_source';
        displayName: string | undefined;
        accounts: unknown;
        productRefs: unknown;
        locators: unknown;
        futureFields: string[];
        contentHash: string | undefined;
        change: RecordChange;
        changeDetail: unknown;
        identity: string;
        identityDetail: unknown;
        participation: string | undefined;
        productOutcomes: unknown;
        problems: unknown;
      }): Promise<void> => {
        await client.query(
          `INSERT INTO influencer_import_records
                  (plan_id, organization_id, campaign_id, source_id, snapshot_id, source_key, kind, display_name,
                   accounts, product_refs, locators, future_fields, content_hash, change, change_detail,
                   identity_outcome, identity_detail, participation_outcome, product_outcomes, problems)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb, $11::jsonb, $12::jsonb, $13, $14,
                   $15::jsonb, $16, $17::jsonb, $18, $19::jsonb, $20::jsonb)`,
          [
            planId,
            campana.organizationId,
            campana.id,
            fuente.id,
            snapshotId,
            valores.sourceKey,
            valores.kind,
            valores.displayName ?? null,
            JSON.stringify(valores.accounts),
            JSON.stringify(valores.productRefs),
            JSON.stringify(valores.locators),
            JSON.stringify(valores.futureFields),
            valores.contentHash ?? null,
            valores.change,
            JSON.stringify(valores.changeDetail),
            valores.identity,
            JSON.stringify(valores.identityDetail),
            valores.participation ?? null,
            JSON.stringify(valores.productOutcomes),
            JSON.stringify(valores.problems),
          ],
        );
      };

      for (const f of filas) {
        const { partes, contentHash } = huellaDe(f.registro);
        const d = f.evaluacion.decision;
        await insertar({
          sourceKey: f.registro.sourceKey,
          kind: 'person',
          displayName: f.registro.displayName,
          accounts: f.registro.accounts,
          productRefs: f.registro.products,
          locators: f.registro.locators,
          futureFields: [...new Set(f.registro.futureValues.map((v) => v.column))],
          contentHash,
          change: f.cambio,
          changeDetail: { fields: f.campos, parts: partes },
          identity: d.outcome,
          identityDetail: {
            influencerId: d.influencerId,
            campaignInfluencerId: d.campaignInfluencerId,
            candidates: d.candidates,
            reasons: d.reasons,
            additiveAccounts: d.additiveAccounts,
            accountChanges: d.accountChanges,
            nameDiffers: d.nameDiffers,
          },
          participation: d.participation,
          productOutcomes: f.evaluacion.productos,
          problems: f.registro.problems,
        });
      }
      for (const { binding, previo } of faltantes) {
        await insertar({
          sourceKey: previo.sourceKey,
          kind: 'missing_from_source',
          displayName: previo.displayName,
          accounts: previo.accounts,
          productRefs: [],
          locators: [],
          futureFields: [],
          contentHash: undefined,
          change: 'missing_from_source',
          changeDetail: previo.parts === undefined ? {} : { parts: previo.parts },
          identity: 'missing_from_source',
          identityDetail: {
            influencerId: binding.influencer_id,
            campaignInfluencerId: binding.campaign_influencer_id,
            candidates: [],
            reasons: [],
            additiveAccounts: [],
            accountChanges: [],
          },
          participation: undefined,
          productOutcomes: [],
          problems: [],
        });
      }

      // Los planes pendientes de lecturas anteriores quedan reemplazados por este.
      await client.query(
        `UPDATE influencer_import_plans p SET status = 'superseded'
           FROM source_snapshots n
          WHERE p.snapshot_id = n.id AND p.source_id = $1 AND p.id <> $2
            AND p.status IN ('ready', 'needs_resolution') AND n.sequence < $3`,
        [fuente.id, planId, secuencia],
      );

      await recordAudit(
        client,
        auditoriaDe(actor, contexto, {
          action: 'influencer_import.schema_validate',
          entityType: 'source_document',
          entityId: fuente.id,
          metadata: {
            planId,
            snapshotId,
            sequence: secuencia,
            result: validacion.status,
            schema: validacion.schema,
            errors: validacion.errors.map((e) => e.code),
            warnings: validacion.warnings.length,
          },
        }),
      );
      await recordAudit(
        client,
        auditoriaDe(actor, contexto, {
          action: 'influencer_import.plan_create',
          entityType: 'influencer_import_plan',
          entityId: planId,
          metadata: {
            campaignId: campana.id,
            sourceId: fuente.id,
            snapshotId,
            status: estado,
            ...resumen(resumenFilas),
          },
        }),
      );
      return cargarDetalle(client, planId);
    });
  });
}

/** Huellas por clave del plan anterior (solo personas del Sheet). */
async function huellasDelPlan(db: Consultor, planId: string) {
  const { rows } = await db.query<{
    source_key: string;
    display_name: string | null;
    accounts: ImportRecordView['accounts'];
    change_detail: { parts?: Record<'name' | 'accounts' | 'products' | 'future', string> };
  }>(
    `SELECT source_key, display_name, accounts, change_detail FROM influencer_import_records
      WHERE plan_id = $1 AND kind = 'person' AND identity_outcome <> 'invalid'`,
    [planId],
  );
  return rows.flatMap((r) =>
    r.change_detail.parts === undefined
      ? []
      : [
          {
            sourceKey: r.source_key,
            displayName: r.display_name ?? '',
            accounts: r.accounts,
            parts: r.change_detail.parts,
          },
        ],
  );
}

// ─────────────────────────── Lectura del plan ──────────────────────────────────

/** Estado de cada registro, derivado de lo que ya se aplicó (bindings, asignaciones, decisiones). */
async function vistaDeRegistros(
  db: Consultor,
  plan: PlanRow,
  filas: readonly RecordRow[],
): Promise<ImportRecordView[]> {
  const { rows: bindings } = await db.query<{
    source_key: string;
    influencer_id: string;
    campaign_influencer_id: string;
    bound_via: string;
  }>(
    `SELECT source_key, influencer_id, campaign_influencer_id, bound_via FROM influencer_source_bindings WHERE source_id = $1`,
    [plan.source_id],
  );
  const bindingDe = new Map(bindings.map((b) => [b.source_key, b]));

  const { rows: resoluciones } = await db.query<ResolutionRow>(
    `${SELECT_RESOLUCION} WHERE record_id = ANY($1::uuid[]) ORDER BY created_at, id`,
    [filas.map((f) => f.id)],
  );
  const resolucionesDe = new Map<string, ResolutionRow[]>();
  for (const r of resoluciones)
    resolucionesDe.set(r.record_id, [...(resolucionesDe.get(r.record_id) ?? []), r]);

  const { rows: asignaciones } = await db.query<{
    campaign_influencer_id: string;
    campaign_product_id: string;
  }>(
    `SELECT campaign_influencer_id, campaign_product_id FROM campaign_influencer_products WHERE campaign_id = $1`,
    [plan.campaign_id],
  );
  const asignado = new Set(asignaciones.map((a) => `${a.campaign_influencer_id}:${a.campaign_product_id}`));
  const { rows: estados } = await db.query<{ id: string; status: string }>(
    `SELECT id, status FROM campaign_influencers WHERE campaign_id = $1`,
    [plan.campaign_id],
  );
  const estadoDeParticipacion = new Map(estados.map((e) => [e.id, e.status]));
  const influencerIds = bindings.map((b) => b.influencer_id);
  const cuentas = influencerIds.length === 0 ? new Map() : await cuentasDe(db, influencerIds);

  return filas.map((f): ImportRecordView => {
    const binding = bindingDe.get(f.source_key);
    const decisiones = resolucionesDe.get(f.id) ?? [];
    const pendientes: string[] = [];
    let state: ImportRecordState;

    const ignorado = decisiones.some((d) => d.dimension === 'ignore');
    if (ignorado) {
      state = 'ignored';
    } else if (f.kind === 'missing_from_source') {
      state = 'review';
      pendientes.push('missing_from_source');
    } else if (f.identity_outcome === 'invalid') {
      state = 'invalid';
      pendientes.push('record_invalid');
    } else if (binding === undefined) {
      const accionable = ['matched_existing', 'create_new', 'matched_binding'].includes(f.identity_outcome);
      state = accionable ? 'actionable' : 'blocked';
      pendientes.push(accionable ? 'identity_not_applied' : `identity_${f.identity_outcome}`);
    } else {
      // Ya vinculado: ¿falta algo? (cuentas nuevas, productos, participación retirada)
      let bloqueado = false;
      let porAplicar = false;
      if (['conflict', 'ambiguous'].includes(f.identity_outcome)) {
        bloqueado = true;
        pendientes.push(`identity_${f.identity_outcome}`);
      }
      if (estadoDeParticipacion.get(binding.campaign_influencer_id) === 'retirado') {
        bloqueado = true;
        pendientes.push('participation_retired');
      }
      const propias = cuentas.get(binding.influencer_id) ?? [];
      for (const c of f.accounts) {
        const existe = propias.some(
          (p: { platform: string; normalizedHandle: string }) =>
            p.platform === c.platform && p.normalizedHandle === c.normalizedHandle,
        );
        if (existe) continue;
        const cambio = (f.identity_detail.accountChanges ?? []).some(
          (a) => a.platform === c.platform && a.normalizedHandle === c.normalizedHandle,
        );
        const aceptada = decisiones.some((d) => d.dimension === 'identity');
        if (cambio && !aceptada) {
          bloqueado = true;
          pendientes.push('account_change');
        } else {
          porAplicar = true;
          pendientes.push('account_not_added');
        }
      }
      for (const p of f.product_outcomes) {
        const elegido = decisiones.find(
          (d) => d.dimension === 'product' && d.product_ref === p.normalizedRef,
        );
        const objetivo = elegido?.campaign_product_id ?? p.campaignProductId;
        if (
          objetivo !== null &&
          objetivo !== undefined &&
          asignado.has(`${binding.campaign_influencer_id}:${objetivo}`)
        )
          continue;
        if (p.outcome === 'assign' || elegido !== undefined) {
          porAplicar = true;
          pendientes.push(`product_not_assigned:${p.normalizedRef}`);
        } else if (p.outcome !== 'unchanged') {
          bloqueado = true;
          pendientes.push(`product_${p.outcome}:${p.normalizedRef}`);
        }
      }
      state = bloqueado ? 'blocked' : porAplicar ? 'actionable' : 'applied';
    }

    return {
      id: f.id,
      planId: f.plan_id,
      sourceKey: f.source_key,
      kind: f.kind,
      displayName: f.display_name ?? undefined,
      accounts: f.accounts,
      productRefs: f.product_refs,
      locators: f.locators,
      futureFields: f.future_fields,
      change: f.change,
      changedFields: f.change_detail.fields ?? [],
      identity: {
        outcome: f.identity_outcome,
        influencerId: f.identity_detail.influencerId,
        campaignInfluencerId: f.identity_detail.campaignInfluencerId,
        candidates: f.identity_detail.candidates ?? [],
        reasons: f.identity_detail.reasons ?? [],
        additiveAccounts: f.identity_detail.additiveAccounts ?? [],
        accountChanges: f.identity_detail.accountChanges ?? [],
        nameDiffers: f.identity_detail.nameDiffers,
      },
      participation: f.participation_outcome ?? undefined,
      productOutcomes: f.product_outcomes,
      problems: f.problems,
      state,
      pending: state === 'applied' || state === 'ignored' ? [] : pendientes,
      binding:
        binding === undefined
          ? undefined
          : {
              influencerId: binding.influencer_id,
              campaignInfluencerId: binding.campaign_influencer_id,
              boundVia: binding.bound_via,
            },
      resolutions: decisiones.map(comoResolucion),
    };
  });
}

async function cargarDetalle(db: Consultor, planId: string): Promise<ImportPlanDetail> {
  const { rows } = await db.query<PlanRow>(`${SELECT_PLAN} WHERE id = $1`, [planId]);
  const plan = rows[0];
  if (plan === undefined) throw new Abortar(NO_ENCONTRADO);
  const { rows: filas } = await db.query<RecordRow>(
    `${SELECT_REGISTRO} WHERE plan_id = $1 ORDER BY source_key`,
    [planId],
  );
  return { plan: comoPlan(plan), records: await vistaDeRegistros(db, plan, filas) };
}

/** Plan y registros, con el estado actual de cada uno. Material interno (nunca para el cliente). */
export async function getImportPlan(actor: User, planId: string): Promise<Result<ImportPlanDetail>> {
  return resultado(async () => {
    const { rows } = await getPool().query<{ organization_id: string }>(
      `SELECT organization_id FROM influencer_import_plans WHERE id = $1`,
      [planId],
    );
    if (rows[0] === undefined) throw new Abortar(NO_ENCONTRADO);
    exigir(actor, rows[0].organization_id, 'source:read', 'influencer:read', 'campaign_influencer:read');
    return cargarDetalle(getPool(), planId);
  });
}

export async function listImportPlans(actor: User, sourceId: string): Promise<Result<ImportPlan[]>> {
  return resultado(async () => {
    const { rows: fuente } = await getPool().query<{ organization_id: string }>(
      `SELECT organization_id FROM source_documents WHERE id = $1`,
      [sourceId],
    );
    if (fuente[0] === undefined) throw new Abortar(NO_ENCONTRADO);
    exigir(actor, fuente[0].organization_id, 'source:read', 'influencer:read', 'campaign_influencer:read');
    const { rows } = await getPool().query<PlanRow>(
      `${SELECT_PLAN} WHERE source_id = $1 ORDER BY created_at DESC`,
      [sourceId],
    );
    return rows.map(comoPlan);
  });
}

/**
 * Compara dos lecturas del Sheet por clave estable: nuevo / sin cambios /
 * cambiado / desaparecido. Solo lectura; no persiste ni muta nada.
 */
export async function compareSheetSnapshots(
  actor: User,
  input: {
    readonly campaignId: string;
    readonly sourceId: string;
    readonly fromSnapshotId: string;
    readonly toSnapshotId: string;
  },
) {
  return resultado(async () => {
    const campana = await cargarCampana(getPool(), actor, input.campaignId);
    exigir(actor, campana.organizationId, 'source:read', 'influencer:read');
    const fuente = await cargarFuenteDeSheet(getPool(), campana, input.sourceId);
    const leer = async (snapshotId: string) => {
      await exigirSnapshotDeFuente(getPool(), fuente.id, snapshotId);
      return validateInfluencerSheet(await cargarRejillaDeSnapshot(getPool(), snapshotId), {
        gid: fuente.gid,
      });
    };
    const [antes, despues] = [await leer(input.fromSnapshotId), await leer(input.toSnapshotId)];
    if (antes.status === 'invalid' || despues.status === 'invalid') {
      throw new Abortar({
        code: 'VALIDATION_FAILED',
        message: 'Una de las lecturas no cumple el esquema: no se pueden comparar registros.',
        details: {
          reason: 'schema_invalid',
          fromValid: antes.status === 'valid',
          toValid: despues.status === 'valid',
        },
      });
    }
    return compararRegistros(
      antes.records.map((r) => ({ sourceKey: r.sourceKey, fingerprint: r.fingerprint })),
      despues.records.map((r) => ({ sourceKey: r.sourceKey, fingerprint: r.fingerprint })),
    );
  });
}

// ─────────────────────────── Aplicar ───────────────────────────────────────────

async function recalcularEstadoDelPlan(db: Consultor, planId: string): Promise<ImportPlanStatus> {
  const detalle = await cargarDetalle(db, planId);
  if (detalle.plan.status === 'schema_invalid' || detalle.plan.status === 'superseded')
    return detalle.plan.status;
  const estados = detalle.records.map((r) => r.state);
  const siguiente: ImportPlanStatus = estados.every((e) => e === 'applied' || e === 'ignored')
    ? 'applied'
    : estados.some((e) => e === 'blocked' || e === 'invalid' || e === 'review')
      ? 'needs_resolution'
      : 'ready';
  if (siguiente !== detalle.plan.status) {
    await db.query(`UPDATE influencer_import_plans SET status = $2 WHERE id = $1`, [planId, siguiente]);
  }
  return siguiente;
}

function resultadoVacio(f: RecordRow): ImportRecordResult {
  return {
    recordId: f.id,
    sourceKey: f.source_key,
    status: 'skipped',
    reason: undefined,
    influencerId: undefined,
    campaignInfluencerId: undefined,
    created: { influencer: false, accounts: 0, participation: false, products: 0 },
    pending: [],
  };
}

type Efecto = {
  readonly entityType:
    'influencer' | 'influencer_account' | 'campaign_influencer' | 'campaign_influencer_product';
  readonly entityId: string;
  readonly action: 'created' | 'existing';
};

/**
 * Materializa UN registro con el estado ACTUAL del dominio. Idempotente: un
 * registro ya aplicado no crea nada nuevo. Devuelve qué hizo y qué sigue pendiente.
 */
async function aplicarRegistro(
  actor: User,
  plan: PlanRow,
  fila: RecordRow,
  contexto: ContextoDeAuditoria,
): Promise<ImportRecordResult> {
  const base = resultadoVacio(fila);
  const bloqueado = (reason: string, extra: Partial<ImportRecordResult> = {}): ImportRecordResult => ({
    ...base,
    status: 'blocked',
    reason,
    pending: [reason],
    ...extra,
  });

  const { rows: decisionesRows } = await getPool().query<ResolutionRow>(
    `${SELECT_RESOLUCION} WHERE record_id = $1 ORDER BY created_at, id`,
    [fila.id],
  );
  if (decisionesRows.some((d) => d.dimension === 'ignore'))
    return { ...base, status: 'ignored', reason: 'ignored_by_human' };
  if (fila.kind === 'missing_from_source')
    return { ...base, status: 'skipped', reason: 'missing_from_source' };
  if (fila.identity_outcome === 'invalid') return { ...base, status: 'skipped', reason: 'record_invalid' };

  const registro = registroDesdeFila(fila);
  const campana: CampanaCargada = {
    id: plan.campaign_id,
    organizationId: plan.organization_id,
    status: 'activa',
  };
  const evaluacion = (await evaluarRegistros(getPool(), actor, campana, plan.source_id, [registro])).get(
    registro.sourceKey,
  )!;
  const decision = evaluacion.decision;
  const eleccion = [...decisionesRows].reverse().find((d) => d.dimension === 'identity');

  const { rows: vinculos } = await getPool().query<{ influencer_id: string }>(
    `SELECT influencer_id FROM influencer_source_bindings WHERE source_id = $1 AND source_key = $2`,
    [plan.source_id, fila.source_key],
  );
  const vinculado = vinculos[0]?.influencer_id;

  /** Dueño actual de cada cuenta del registro (coincidencia exacta, caso de uso de la Fase 3). */
  const duenos = async (): Promise<Map<string, string>> => {
    const mapa = new Map<string, string>();
    for (const cuenta of registro.accounts) {
      const encontrado = await buscarInfluencerPorCuenta(actor, cuenta.platform, cuenta.handle);
      if (encontrado.ok && encontrado.value !== undefined) {
        mapa.set(`${cuenta.platform}:${cuenta.normalizedHandle}`, encontrado.value.influencer.id);
      }
    }
    return mapa;
  };

  // ¿Quién es la persona? Binding previo > decisión humana > coincidencia exacta > crear.
  let via: 'account_match' | 'created' | 'human_existing' | 'human_new';
  let crear = false;
  let influencerId: string | undefined;
  let cuentasNuevas: readonly AdditiveAccount[] = [];
  const pendientes: string[] = [];

  if (vinculado !== undefined) {
    // El binding gana: la identidad ya está resuelta, no se vuelve a inferir.
    if (decision.outcome === 'conflict') return bloqueado('identity_conflict', { influencerId: vinculado });
    if (decision.reasons.includes('participation_retired')) {
      return bloqueado('participation_retired', { influencerId: vinculado });
    }
    influencerId = vinculado;
    via = 'account_match';
    const aceptaCambio =
      eleccion?.decision === 'use_existing_influencer' && eleccion.influencer_id === vinculado;
    cuentasNuevas = [...decision.additiveAccounts, ...(aceptaCambio ? decision.accountChanges : [])];
    if (decision.accountChanges.length > 0 && !aceptaCambio) pendientes.push('account_change');
  } else if (eleccion?.decision === 'use_existing_influencer' && eleccion.influencer_id !== null) {
    // Decisión humana: esa persona. Los hechos de hoy deben seguir permitiéndolo.
    const propietarios = await duenos();
    const x = eleccion.influencer_id;
    if ([...propietarios.values()].some((id) => id !== x)) return bloqueado('identity_decision_stale');
    const { rows: ocupada } = await getPool().query(
      `SELECT 1 FROM influencer_source_bindings WHERE source_id = $1 AND influencer_id = $2`,
      [plan.source_id, x],
    );
    if (ocupada[0] !== undefined) return bloqueado('identity_decision_stale');
    influencerId = x;
    via = 'human_existing';
    cuentasNuevas = registro.accounts.filter((c) => !propietarios.has(`${c.platform}:${c.normalizedHandle}`));
  } else if (eleccion?.decision === 'create_new_influencer') {
    if ((await duenos()).size > 0) return bloqueado('identity_decision_stale');
    via = 'human_new';
    crear = true;
  } else if (decision.outcome === 'matched_existing') {
    influencerId = decision.influencerId;
    via = 'account_match';
    cuentasNuevas = decision.additiveAccounts;
  } else if (decision.outcome === 'create_new') {
    via = 'created';
    crear = true;
  } else if (decision.outcome === 'needs_resolution') {
    return bloqueado(
      decision.reasons.includes('participation_retired') ? 'participation_retired' : 'account_change',
      {
        influencerId: decision.influencerId,
        campaignInfluencerId: decision.campaignInfluencerId,
      },
    );
  } else {
    return bloqueado(`identity_${decision.outcome}`, { influencerId: decision.influencerId });
  }

  const efectos: Efecto[] = [];
  const creado = { influencer: false, accounts: 0, participation: false, products: 0 };

  // 1. La persona y sus cuentas (casos de uso de la Fase 3).
  if (crear) {
    const nuevo = await crearInfluencer(
      actor,
      {
        displayName: registro.displayName,
        cuentas: registro.accounts.map((a) => ({ platform: a.platform, handle: a.handle })),
      },
      contexto,
    );
    if (!nuevo.ok)
      return bloqueado(nuevo.error.code === 'RESOURCE_CONFLICT' ? 'identity_conflict' : nuevo.error.code);
    influencerId = nuevo.value.influencer.id;
    creado.influencer = true;
    creado.accounts = nuevo.value.accounts.length;
    efectos.push({ entityType: 'influencer', entityId: influencerId, action: 'created' });
    for (const cuenta of nuevo.value.accounts) {
      efectos.push({ entityType: 'influencer_account', entityId: cuenta.id, action: 'created' });
    }
  } else if (influencerId !== undefined) {
    efectos.push({ entityType: 'influencer', entityId: influencerId, action: 'existing' });
    for (const cuenta of cuentasNuevas) {
      const agregada = await agregarCuenta(
        actor,
        influencerId,
        { platform: cuenta.platform, handle: cuenta.handle },
        contexto,
      );
      if (!agregada.ok) {
        return bloqueado(
          agregada.error.code === 'RESOURCE_CONFLICT' ? 'account_conflict' : agregada.error.code,
          {
            influencerId,
          },
        );
      }
      creado.accounts += 1;
      efectos.push({ entityType: 'influencer_account', entityId: agregada.value.id, action: 'created' });
    }
  }
  if (influencerId === undefined) return bloqueado('identity_unresolved');

  // 2. Su participación en ESTA campaña.
  const { rows: actuales } = await getPool().query<{ id: string; status: string }>(
    `SELECT id, status FROM campaign_influencers WHERE campaign_id = $1 AND influencer_id = $2`,
    [plan.campaign_id, influencerId],
  );
  let participacionId = actuales[0]?.id;
  if (participacionId === undefined) {
    const asociada = await asociarInfluencerACampana(
      actor,
      { campaignId: plan.campaign_id, influencerId },
      contexto,
    );
    if (!asociada.ok) return bloqueado(asociada.error.code, { influencerId });
    participacionId = asociada.value.id;
    creado.participation = true;
    efectos.push({ entityType: 'campaign_influencer', entityId: participacionId, action: 'created' });
  } else if (actuales[0]!.status === 'retirado') {
    return bloqueado('participation_retired', { influencerId, campaignInfluencerId: participacionId });
  } else {
    efectos.push({ entityType: 'campaign_influencer', entityId: participacionId, action: 'existing' });
  }

  // 3. Productos de ESTA campaña. Solo lo inequívoco o lo que una persona eligió.
  // Se evalúa de nuevo: con la persona y su participación ya existentes, los
  // productos asignados son los reales.
  const productos = (await evaluarRegistros(getPool(), actor, campana, plan.source_id, [registro])).get(
    registro.sourceKey,
  )!.productos;
  const { rows: asignadosRows } = await getPool().query<{ campaign_product_id: string }>(
    `SELECT campaign_product_id FROM campaign_influencer_products WHERE campaign_influencer_id = $1`,
    [participacionId],
  );
  const asignados = new Set(asignadosRows.map((a) => a.campaign_product_id));
  for (const producto of productos) {
    const elegido = [...decisionesRows]
      .reverse()
      .find((d) => d.dimension === 'product' && d.product_ref === producto.normalizedRef);
    const objetivo =
      elegido?.campaign_product_id ??
      (producto.outcome === 'assign' || producto.outcome === 'unchanged'
        ? producto.campaignProductId
        : undefined);
    if (objetivo === undefined || objetivo === null) {
      pendientes.push(`product_${producto.outcome}:${producto.normalizedRef}`);
      continue;
    }
    if (asignados.has(objetivo)) continue;
    const asignado = await asociarProductoAInfluencer(
      actor,
      { campaignInfluencerId: participacionId, campaignProductId: objetivo },
      contexto,
    );
    if (!asignado.ok) {
      if (asignado.error.code === 'RESOURCE_CONFLICT') {
        asignados.add(objetivo);
      } else {
        pendientes.push(`product_${asignado.error.code}:${producto.normalizedRef}`);
      }
      continue;
    }
    asignados.add(objetivo);
    creado.products += 1;
    efectos.push({
      entityType: 'campaign_influencer_product',
      entityId: await idDeAsignacion(participacionId, objetivo),
      action: 'created',
    });
  }

  // 4. Binding + efectos + auditoría, juntos.
  let vinculoNuevo = false;
  await transaction(async (client) => {
    const vinculo = await client.query(
      `INSERT INTO influencer_source_bindings
              (organization_id, campaign_id, source_id, source_key, influencer_id, campaign_influencer_id, bound_via,
               origin_snapshot_id, origin_record_id, origin_locators, bound_by, correlation)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12::jsonb)
       ON CONFLICT (source_id, source_key) DO NOTHING
       RETURNING id`,
      [
        plan.organization_id,
        plan.campaign_id,
        plan.source_id,
        fila.source_key,
        influencerId,
        participacionId,
        via,
        plan.snapshot_id,
        fila.id,
        JSON.stringify(fila.locators),
        actor.id,
        contexto.correlation === undefined ? null : JSON.stringify(contexto.correlation),
      ],
    );
    vinculoNuevo = (vinculo.rowCount ?? 0) > 0;
    for (const efecto of efectos) {
      await client.query(
        `INSERT INTO influencer_import_effects (organization_id, campaign_id, record_id, entity_type, entity_id, action, applied_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (record_id, entity_type, entity_id) DO NOTHING`,
        [
          plan.organization_id,
          plan.campaign_id,
          fila.id,
          efecto.entityType,
          efecto.entityId,
          efecto.action,
          actor.id,
        ],
      );
    }
    const cambio =
      vinculoNuevo || creado.influencer || creado.accounts > 0 || creado.participation || creado.products > 0;
    if (cambio) {
      await recordAudit(
        client,
        auditoriaDe(actor, contexto, {
          action: 'influencer_import.record_apply',
          entityType: 'influencer_import_record',
          entityId: fila.id,
          metadata: {
            planId: plan.id,
            snapshotId: plan.snapshot_id,
            sourceId: plan.source_id,
            sourceKey: fila.source_key,
            influencerId,
            campaignInfluencerId: participacionId,
            via,
            created: creado,
            locators: fila.locators.map((l) => `${l.sheet}!${l.range}`),
          },
        }),
      );
    }
  });

  return {
    ...base,
    status:
      vinculoNuevo || creado.influencer || creado.accounts > 0 || creado.participation || creado.products > 0
        ? 'applied'
        : 'unchanged',
    influencerId,
    campaignInfluencerId: participacionId,
    created: creado,
    pending: pendientes,
  };
}

async function idDeAsignacion(participacionId: string, campaignProductId: string): Promise<string> {
  const { rows } = await getPool().query<{ id: string }>(
    `SELECT id FROM campaign_influencer_products WHERE campaign_influencer_id = $1 AND campaign_product_id = $2`,
    [participacionId, campaignProductId],
  );
  return rows[0]!.id;
}

/**
 * Lo que `applyInfluencerImport` verifica antes de tocar nada (permiso, campaña
 * activa, plan aplicable). Solo lee y lanza `Abortar`; la reutiliza la propuesta
 * de aplicar (HITL, Fase 6) para no duplicar ninguna regla.
 */
async function validarAplicacion(actor: User, planId: string): Promise<PlanRow> {
  const { rows } = await getPool().query<PlanRow>(`${SELECT_PLAN} WHERE id = $1`, [planId]);
  const plan = rows[0];
  if (plan === undefined) throw new Abortar(NO_ENCONTRADO);
  exigir(actor, plan.organization_id, 'influencer:manage', 'campaign_influencer:manage');
  const campana = await cargarCampana(getPool(), actor, plan.campaign_id);
  exigirCampanaActiva(campana);
  if (plan.status === 'schema_invalid') {
    throw new Abortar({
      code: 'VALIDATION_FAILED',
      message: 'El Sheet no cumple el esquema: corríjalo, sincronice y prepare un plan nuevo.',
      details: { reason: 'schema_invalid' },
    });
  }
  if (plan.status === 'superseded') {
    throw new Abortar({
      code: 'RESOURCE_CONFLICT',
      message: 'Este plan fue reemplazado por uno más reciente del mismo Sheet.',
      details: { reason: 'plan_superseded' },
    });
  }
  return plan;
}

/**
 * Aplica un plan: crea o asocia lo inequívoco y deja pendiente lo ambiguo.
 * Idempotente (aplicarlo dos veces no duplica nada) y ligado a su snapshot.
 */
export async function applyInfluencerImport(
  actor: User,
  planId: string,
  contexto: ContextoDeAuditoria = CONTEXTO_VACIO,
): Promise<Result<ImportApplication>> {
  const persona = exigirPersona(actor, contexto);
  if (!persona.ok) return persona;
  const humano = exigirCanalHumano(contexto, 'influencer_import.apply');
  if (!humano.ok) return humano;

  return resultado(async () => {
    const plan = await validarAplicacion(actor, planId);

    // El plan se bloquea mientras se aplica: dos aplicaciones simultáneas se serializan.
    return transaction(async (bloqueo) => {
      await bloqueo.query(`SELECT id FROM influencer_import_plans WHERE id = $1 FOR UPDATE`, [planId]);
      const { rows: filas } = await getPool().query<RecordRow>(
        `${SELECT_REGISTRO} WHERE plan_id = $1 ORDER BY source_key`,
        [planId],
      );
      const resultados: ImportRecordResult[] = [];
      for (const fila of filas) resultados.push(await aplicarRegistro(actor, plan, fila, contexto));

      const estado = await recalcularEstadoDelPlan(bloqueo, planId);
      await recordAudit(
        bloqueo,
        auditoriaDe(actor, contexto, {
          action: 'influencer_import.apply',
          entityType: 'influencer_import_plan',
          entityId: planId,
          metadata: {
            campaignId: plan.campaign_id,
            sourceId: plan.source_id,
            snapshotId: plan.snapshot_id,
            planStatus: estado,
            applied: resultados.filter((r) => r.status === 'applied').length,
            unchanged: resultados.filter((r) => r.status === 'unchanged').length,
            blocked: resultados.filter((r) => r.status === 'blocked').length,
          },
        }),
      );
      return { planId, planStatus: estado, records: resultados };
    });
  });
}

// ─────────────────────────── Resolución humana ─────────────────────────────────

/** La resolución que una acción propuesta concreta ya dejó sobre un registro (si la hay). */
async function resolucionDeAccion(
  recordId: string,
  decidedBy: string,
  proposedActionId: string,
): Promise<ImportResolution | undefined> {
  const { rows } = await getPool().query<ResolutionRow>(
    `${SELECT_RESOLUCION}
      WHERE record_id = $1 AND decided_by = $2 AND correlation->>'proposedActionId' = $3
      ORDER BY created_at, id LIMIT 1`,
    [recordId, decidedBy, proposedActionId],
  );
  return rows[0] === undefined ? undefined : comoResolucion(rows[0]);
}

/**
 * Todo lo que `resolveImportRecord` verifica ANTES de escribir la decisión
 * (permiso, campaña activa, plan vigente, reglas de cada tipo de decisión). Solo
 * lee y lanza `Abortar`. Lo usa también la propuesta de una resolución (HITL,
 * Fase 6) para fallar pronto sin duplicar ninguna regla.
 */
async function validarResolucion(
  actor: User,
  recordId: string,
  decision: ImportDecision,
  opciones: { readonly omitirReglasDeDecision?: boolean } = {},
): Promise<{ readonly fila: RecordRow; readonly plan: PlanRow }> {
  const { rows } = await getPool().query<RecordRow>(`${SELECT_REGISTRO} WHERE id = $1`, [recordId]);
  const fila = rows[0];
  if (fila === undefined) throw new Abortar(NO_ENCONTRADO);
  exigir(actor, fila.organization_id, 'influencer:manage', 'campaign_influencer:manage');
  const { rows: planes } = await getPool().query<PlanRow>(`${SELECT_PLAN} WHERE id = $1`, [fila.plan_id]);
  const plan = planes[0]!;
  const campana = await cargarCampana(getPool(), actor, plan.campaign_id);
  exigirCampanaActiva(campana);
  if (plan.status === 'schema_invalid' || plan.status === 'superseded') {
    throw new Abortar({
      code: 'RESOURCE_CONFLICT',
      message: 'Este plan ya no admite decisiones (esquema inválido o reemplazado).',
      details: { reason: plan.status === 'superseded' ? 'plan_superseded' : 'schema_invalid' },
    });
  }
  if (decision.reason !== undefined && decision.reason.length > 500) {
    throw new Abortar({
      code: 'VALIDATION_FAILED',
      message: 'El motivo no puede superar 500 caracteres.',
      details: { field: 'reason' },
    });
  }

  // Reintento de una resolución ya registrada por la MISMA acción propuesta: el
  // estado ya refleja su efecto, así que las reglas de la decisión no se vuelven
  // a exigir (se reconcilia, no se vuelve a decidir).
  if (opciones.omitirReglasDeDecision === true) return { fila, plan };

  const registro = registroDesdeFila(fila);
  const evaluacion = (await evaluarRegistros(getPool(), actor, campana, plan.source_id, [registro])).get(
    registro.sourceKey,
  )!;
  const conflicto = (reason: string, message: string) =>
    new Abortar({ code: 'RESOURCE_CONFLICT', message, details: { reason, recordId } });

  switch (decision.kind) {
    case 'use_existing_influencer': {
      if (fila.kind !== 'person' || fila.identity_outcome === 'invalid') {
        throw conflicto(
          'record_not_resolvable',
          'Este registro no admite una persona: no cumple el esquema.',
        );
      }
      const { rows: influencers } = await getPool().query<{ id: string }>(
        `SELECT id FROM influencers WHERE id = $1 AND organization_id = $2`,
        [decision.influencerId, plan.organization_id],
      );
      if (influencers[0] === undefined) throw new Abortar(NO_ENCONTRADO);
      const binding = await getPool().query<{ influencer_id: string }>(
        `SELECT influencer_id FROM influencer_source_bindings WHERE source_id = $1 AND source_key = $2`,
        [plan.source_id, fila.source_key],
      );
      if (binding.rows[0] !== undefined && binding.rows[0].influencer_id !== decision.influencerId) {
        throw conflicto('already_bound', 'La clave ya está vinculada a otra persona; no se reasigna.');
      }
      // Las cuentas del Sheet que ya son de OTRA persona no se mueven.
      for (const cuenta of registro.accounts) {
        const dueno = await buscarInfluencerPorCuenta(actor, cuenta.platform, cuenta.handle);
        if (dueno.ok && dueno.value !== undefined && dueno.value.influencer.id !== decision.influencerId) {
          throw conflicto(
            'account_owned_by_other',
            'Una cuenta del registro pertenece a otro Influencer: no se mueve.',
          );
        }
      }
      const otraClave = await getPool().query<{ source_key: string }>(
        `SELECT source_key FROM influencer_source_bindings WHERE source_id = $1 AND influencer_id = $2 AND source_key <> $3`,
        [plan.source_id, decision.influencerId, fila.source_key],
      );
      if (otraClave.rows[0] !== undefined) {
        throw conflicto(
          'influencer_bound_to_other_key',
          'Esa persona ya está vinculada a otra clave del mismo Sheet.',
        );
      }
      break;
    }
    case 'create_new_influencer': {
      if (fila.kind !== 'person' || fila.identity_outcome === 'invalid') {
        throw conflicto(
          'record_not_resolvable',
          'Este registro no admite una persona: no cumple el esquema.',
        );
      }
      if (evaluacion.decision.influencerId !== undefined || evaluacion.decision.candidates.length > 0) {
        throw conflicto(
          'accounts_already_exist',
          'Alguna cuenta del registro ya existe: no se puede crear una persona nueva con ella.',
        );
      }
      const binding = await getPool().query(
        `SELECT 1 FROM influencer_source_bindings WHERE source_id = $1 AND source_key = $2`,
        [plan.source_id, fila.source_key],
      );
      if (binding.rows[0] !== undefined)
        throw conflicto('already_bound', 'La clave ya está vinculada a una persona.');
      break;
    }
    case 'choose_product': {
      const normalizada = normalizeProductRef(decision.productRef);
      if (!fila.product_refs.some((p) => p.normalizedRef === normalizada)) {
        throw new Abortar({
          code: 'VALIDATION_FAILED',
          message: 'Ese producto no es una referencia de este registro.',
          details: { field: 'productRef' },
        });
      }
      // El producto debe ser de ESTA campaña (también lo impone la base).
      const { rows: productos } = await getPool().query<{ id: string }>(
        `SELECT id FROM campaign_products WHERE id = $1 AND campaign_id = $2`,
        [decision.campaignProductId, plan.campaign_id],
      );
      if (productos[0] === undefined) throw new Abortar(NO_ENCONTRADO);
      break;
    }
    case 'ignore_record':
      break;
  }
  return { fila, plan };
}

/**
 * Registra la decisión de una PERSONA sobre un registro ambiguo o bloqueado y la
 * aplica a ese registro. Elegir un Influencer existente, crear uno nuevo, elegir
 * el producto o ignorar el registro. `system` nunca resuelve: la ambigüedad es
 * humana por definición.
 */
export async function resolveImportRecord(
  actor: User,
  recordId: string,
  decision: ImportDecision,
  contexto: ContextoDeAuditoria = CONTEXTO_VACIO,
): Promise<
  Result<{
    resolution: ImportResolution;
    result: ImportRecordResult | undefined;
    planStatus: ImportPlanStatus;
  }>
> {
  const persona = exigirPersona(actor, contexto);
  if (!persona.ok) return persona;
  const humano = exigirCanalHumano(contexto, 'influencer_import.resolve_record');
  if (!humano.ok) return humano;

  return resultado(async () => {
    // Reintento de la ejecución de una acción propuesta (HITL, Fase 6): si esta
    // misma acción ya dejó su resolución, no se escribe otra; se reconcilia.
    const accionId = contexto.correlation?.proposedActionId;
    const previa =
      accionId === undefined ? undefined : await resolucionDeAccion(recordId, actor.id, accionId);
    const { fila, plan } = await validarResolucion(actor, recordId, decision, {
      omitirReglasDeDecision: previa !== undefined,
    });

    const dimension =
      decision.kind === 'ignore_record'
        ? 'ignore'
        : decision.kind === 'choose_product'
          ? 'product'
          : 'identity';
    const productoRef = decision.kind === 'choose_product' ? normalizeProductRef(decision.productRef) : null;
    const resolucion =
      previa ??
      (await transaction(async (client) => {
        const { rows: creada } = await client.query<ResolutionRow>(
          `INSERT INTO influencer_import_resolutions
                (organization_id, campaign_id, record_id, dimension, decision, influencer_id, campaign_product_id,
                 product_ref, decided_by, reason, correlation)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb)
         RETURNING id, record_id, dimension, decision, influencer_id, campaign_product_id, product_ref, decided_by,
                   reason, created_at`,
          [
            plan.organization_id,
            plan.campaign_id,
            recordId,
            dimension,
            decision.kind,
            decision.kind === 'use_existing_influencer' ? decision.influencerId : null,
            decision.kind === 'choose_product' ? decision.campaignProductId : null,
            productoRef,
            actor.id,
            decision.reason ?? null,
            contexto.correlation === undefined ? null : JSON.stringify(contexto.correlation),
          ],
        );
        await recordAudit(
          client,
          auditoriaDe(actor, contexto, {
            action: 'influencer_import.record_resolve',
            entityType: 'influencer_import_record',
            entityId: recordId,
            metadata: {
              planId: plan.id,
              snapshotId: plan.snapshot_id,
              sourceKey: fila.source_key,
              decision: decision.kind,
              influencerId: decision.kind === 'use_existing_influencer' ? decision.influencerId : undefined,
              campaignProductId: decision.kind === 'choose_product' ? decision.campaignProductId : undefined,
              productRef: productoRef ?? undefined,
              reason: decision.reason,
            },
          }),
        );
        return comoResolucion(creada[0]!);
      }));

    // La decisión se materializa de inmediato sobre ESE registro (y crea el binding estable).
    const resultadoAplicado =
      decision.kind === 'ignore_record' ? undefined : await aplicarRegistro(actor, plan, fila, contexto);
    const planStatus = await recalcularEstadoDelPlan(getPool(), plan.id);
    return { resolution: resolucion, result: resultadoAplicado, planStatus };
  });
}

// ─────────────────────────── Propuesta humana (HITL · Fase 6) ───────────────────

/*
 * Aplicar un plan y resolver un registro, por el canal chat, pasan por una
 * ACCIÓN PROPUESTA que una persona confirma desde la interfaz
 * (`proposed-action-handlers.ts`). Lo que sigue es lo que ese registro de
 * handlers necesita de la importación, sin duplicar ninguna de sus reglas: las
 * validaciones son las MISMAS funciones que usan `applyInfluencerImport` y
 * `resolveImportRecord`, y el «material» es el contenido que la persona
 * confirma, listo para huellar. La huella cubre exactamente lo que se le muestra:
 *
 *  · `estable`: el contenido inmutable del plan o del registro (filas del plan,
 *    contenido del snapshot) más las resoluciones humanas que ya existen. Cambia
 *    solo si alguien decide algo nuevo: confirmar y ejecutar lo exigen igual.
 *  · `vivo`: el estado actual derivado (qué está aplicado, bloqueado, vinculado).
 *    Se exige al CONFIRMAR (la persona ve lo que hay hoy) pero no al EJECUTAR: si
 *    una ejecución se aplicó a medias y se reintenta, el estado ya avanzó y el
 *    reintento debe poder reconciliar sin duplicar (modo `idempotent_external`).
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Lee y normaliza la decisión que formaliza el agente. Es entrada NO confiable:
 * claves exactas por tipo, identificadores bien formados y motivo acotado.
 */
export function leerDecisionDeImportacion(valor: unknown): Result<ImportDecision> {
  const invalida = (message: string, field?: string) =>
    err<never>({ code: 'VALIDATION_FAILED', message, details: { field: field ?? 'decision' } });
  if (typeof valor !== 'object' || valor === null || Array.isArray(valor)) {
    return invalida('La decisión debe ser un objeto.');
  }
  const d = valor as Record<string, unknown>;
  const permitidas: Record<string, readonly string[]> = {
    use_existing_influencer: ['kind', 'influencerId', 'reason'],
    create_new_influencer: ['kind', 'reason'],
    choose_product: ['kind', 'productRef', 'campaignProductId', 'reason'],
    ignore_record: ['kind', 'reason'],
  };
  const kind = d['kind'];
  if (typeof kind !== 'string' || !Object.hasOwn(permitidas, kind)) {
    return invalida('El tipo de decisión no es válido.', 'kind');
  }
  for (const clave of Object.keys(d)) {
    if (!permitidas[kind]!.includes(clave)) return invalida(`La decisión no admite «${clave}».`, clave);
  }
  const reason = d['reason'];
  if (reason !== undefined && (typeof reason !== 'string' || reason.length > 500)) {
    return invalida('El motivo debe ser un texto de hasta 500 caracteres.', 'reason');
  }
  const motivo = reason === undefined ? {} : { reason };
  switch (kind) {
    case 'use_existing_influencer': {
      const id = d['influencerId'];
      if (typeof id !== 'string' || !UUID.test(id))
        return invalida('influencerId no es un id válido.', 'influencerId');
      return ok({ kind, influencerId: id.toLowerCase(), ...motivo });
    }
    case 'choose_product': {
      const ref = d['productRef'];
      const id = d['campaignProductId'];
      if (typeof ref !== 'string' || ref.trim() === '' || ref.length > 200) {
        return invalida('productRef debe ser un texto de 1 a 200 caracteres.', 'productRef');
      }
      if (typeof id !== 'string' || !UUID.test(id)) {
        return invalida('campaignProductId no es un id válido.', 'campaignProductId');
      }
      return ok({ kind, productRef: ref.trim(), campaignProductId: id.toLowerCase(), ...motivo });
    }
    default:
      return ok({ kind: kind as 'create_new_influencer' | 'ignore_record', ...motivo });
  }
}

/** ¿Se puede PROPONER aplicar este plan? Las mismas reglas que aplicarlo (más: que haya algo por hacer). */
export async function validarAplicacionDePlan(
  actor: User,
  planId: string,
): Promise<Result<{ organizationId: string; campaignId: string }>> {
  return resultado(async () => {
    const plan = await validarAplicacion(actor, planId);
    if (plan.status === 'applied') {
      throw new Abortar({
        code: 'RESOURCE_CONFLICT',
        message: 'Este plan ya está aplicado por completo: no queda nada por aplicar.',
        details: { reason: 'plan_already_applied' },
      });
    }
    return { organizationId: plan.organization_id, campaignId: plan.campaign_id };
  });
}

/** ¿Se puede PROPONER esta decisión? Las mismas reglas que resolverla. */
export async function validarResolucionDeRegistro(
  actor: User,
  recordId: string,
  decision: ImportDecision,
): Promise<Result<{ organizationId: string; campaignId: string; planId: string }>> {
  return resultado(async () => {
    const { plan } = await validarResolucion(actor, recordId, decision);
    return { organizationId: plan.organization_id, campaignId: plan.campaign_id, planId: plan.id };
  });
}

export interface MaterialDePlan {
  readonly organizationId: string;
  readonly campaignId: string;
  readonly planId: string;
  readonly planStatus: ImportPlanStatus;
  readonly snapshotId: string;
  readonly snapshotContentHash: string;
  readonly estable: unknown;
  readonly vivo: unknown;
  /** Lo que se muestra a la persona (cifras). Va en el payload de la propuesta. */
  readonly muestra: {
    readonly registros: number;
    readonly porEstado: Readonly<Record<string, number>>;
    readonly bloqueantesAlPlanear: number;
  };
}

const COLUMNAS_INMUTABLES_DE_REGISTRO = `id, source_key, kind, display_name, accounts, product_refs, locators,
  future_fields, content_hash, change, change_detail, identity_outcome, identity_detail,
  participation_outcome, product_outcomes, problems`;

/** Material de un plan para la propuesta de aplicarlo. `undefined` si no existe. */
export async function materialDePlan(db: Consultor, planId: string): Promise<MaterialDePlan | undefined> {
  const { rows: planes } = await db.query<PlanRow>(`${SELECT_PLAN} WHERE id = $1`, [planId]);
  const plan = planes[0];
  if (plan === undefined) return undefined;
  const { rows: registros } = await db.query(
    `SELECT ${COLUMNAS_INMUTABLES_DE_REGISTRO} FROM influencer_import_records
      WHERE plan_id = $1 ORDER BY source_key`,
    [planId],
  );
  const { rows: resoluciones } = await db.query<{ id: string }>(
    `SELECT res.id::text AS id FROM influencer_import_resolutions res
       JOIN influencer_import_records r ON r.id = res.record_id
      WHERE r.plan_id = $1 ORDER BY res.id`,
    [planId],
  );
  const { rows: snapshots } = await db.query<{ content_hash: string }>(
    `SELECT content_hash FROM source_snapshots WHERE id = $1`,
    [plan.snapshot_id],
  );
  const snapshotContentHash = snapshots[0]?.content_hash ?? '';
  const detalle = await cargarDetalle(db, planId);
  const porEstado: Record<string, number> = {};
  for (const r of detalle.records) porEstado[r.state] = (porEstado[r.state] ?? 0) + 1;
  return {
    organizationId: plan.organization_id,
    campaignId: plan.campaign_id,
    planId,
    planStatus: detalle.plan.status,
    snapshotId: plan.snapshot_id,
    snapshotContentHash,
    estable: {
      planId,
      snapshotId: plan.snapshot_id,
      snapshotContentHash,
      registros,
      resoluciones: resoluciones.map((r) => r.id),
    },
    vivo: detalle.records.map((r) => ({
      id: r.id,
      state: r.state,
      pending: r.pending,
      binding: r.binding ?? null,
    })),
    muestra: {
      registros: detalle.records.length,
      porEstado,
      bloqueantesAlPlanear: plan.summary.blocking,
    },
  };
}

export interface MaterialDeRegistro {
  readonly organizationId: string;
  readonly campaignId: string;
  readonly planId: string;
  readonly planStatus: ImportPlanStatus;
  readonly estable: unknown;
  readonly vivo: unknown;
  readonly muestra: {
    readonly sourceKey: string;
    readonly displayName: string | null;
    readonly accounts: readonly { platform: string; handle: string }[];
    readonly productRefs: readonly string[];
    readonly state: ImportRecordState;
    readonly pending: readonly string[];
  };
}

/**
 * Material de un registro para la propuesta de resolverlo. `ignorarAccionId`
 * excluye de las resoluciones existentes las que dejó ESA acción propuesta (para
 * reconciliar un reintento de su ejecución sin que su propio efecto la invalide).
 */
export async function materialDeRegistro(
  db: Consultor,
  recordId: string,
  ignorarAccionId?: string,
): Promise<MaterialDeRegistro | undefined> {
  const { rows: filas } = await db.query<RecordRow>(`${SELECT_REGISTRO} WHERE id = $1`, [recordId]);
  const fila = filas[0];
  if (fila === undefined) return undefined;
  const { rows: planes } = await db.query<PlanRow>(`${SELECT_PLAN} WHERE id = $1`, [fila.plan_id]);
  const plan = planes[0]!;
  const { rows: inmutables } = await db.query(
    `SELECT ${COLUMNAS_INMUTABLES_DE_REGISTRO} FROM influencer_import_records WHERE id = $1`,
    [recordId],
  );
  const { rows: resoluciones } = await db.query<{ id: string }>(
    `SELECT id::text AS id FROM influencer_import_resolutions
      WHERE record_id = $1 AND ($2::text IS NULL OR correlation->>'proposedActionId' IS DISTINCT FROM $2)
      ORDER BY id`,
    [recordId, ignorarAccionId ?? null],
  );
  const [vista] = await vistaDeRegistros(db, plan, [fila]);
  return {
    organizationId: plan.organization_id,
    campaignId: plan.campaign_id,
    planId: plan.id,
    planStatus: plan.status,
    estable: { planId: plan.id, registro: inmutables[0], resoluciones: resoluciones.map((r) => r.id) },
    vivo: { state: vista!.state, pending: vista!.pending, binding: vista!.binding ?? null },
    muestra: {
      sourceKey: fila.source_key,
      displayName: fila.display_name,
      accounts: fila.accounts.map((c) => ({ platform: c.platform, handle: c.handle })),
      productRefs: fila.product_refs.map((p) => p.ref),
      state: vista!.state,
      pending: vista!.pending,
    },
  };
}

// ─────────────────────────── Procedencia ───────────────────────────────────────

export interface ParticipationOrigin {
  readonly campaignInfluencerId: string;
  readonly sourceKey: string;
  readonly boundVia: string;
  readonly source: { id: string; title: string; provider: string };
  readonly snapshot: { id: string; sequence: number; fetchedAt: string; contentHash: string };
  readonly plan: { id: string };
  readonly record: { id: string };
  readonly locators: readonly SheetRowLocator[];
  readonly boundBy: string;
  readonly products: readonly {
    campaignProductId: string;
    action: 'created' | 'existing';
    recordId: string;
    snapshotSequence: number;
  }[];
}

/**
 * ¿Por qué existe este CampaignInfluencer? → binding → registro → plan →
 * snapshot → hoja y rango → fuente. `undefined` si no vino de un Sheet.
 */
export async function getParticipationOrigin(
  actor: User,
  campaignInfluencerId: string,
): Promise<Result<ParticipationOrigin | undefined>> {
  return resultado(async () => {
    const { rows } = await getPool().query<{
      organization_id: string;
      source_key: string;
      bound_via: string;
      bound_by: string;
      source_id: string;
      filename: string;
      external_provider: string;
      snapshot_id: string;
      sequence: number;
      fetched_at: Date;
      content_hash: string;
      plan_id: string;
      record_id: string;
      locators: SheetRowLocator[];
    }>(
      `SELECT b.organization_id, b.source_key, b.bound_via, b.bound_by, b.source_id, s.filename, s.external_provider,
              n.id AS snapshot_id, n.sequence, n.fetched_at, n.content_hash, r.plan_id, r.id AS record_id,
              b.origin_locators AS locators
         FROM influencer_source_bindings b
         JOIN source_documents s ON s.id = b.source_id
         JOIN source_snapshots n ON n.id = b.origin_snapshot_id
         JOIN influencer_import_records r ON r.id = b.origin_record_id
        WHERE b.campaign_influencer_id = $1`,
      [campaignInfluencerId],
    );
    const fila = rows[0];
    if (fila === undefined) {
      const { rows: participacion } = await getPool().query<{ organization_id: string }>(
        `SELECT organization_id FROM campaign_influencers WHERE id = $1`,
        [campaignInfluencerId],
      );
      if (participacion[0] === undefined) throw new Abortar(NO_ENCONTRADO);
      exigir(actor, participacion[0].organization_id, 'campaign_influencer:read', 'source:read');
      return undefined;
    }
    exigir(actor, fila.organization_id, 'campaign_influencer:read', 'source:read');
    const { rows: productos } = await getPool().query<{
      entity_id: string;
      action: 'created' | 'existing';
      record_id: string;
      sequence: number;
      campaign_product_id: string | null;
    }>(
      `SELECT e.entity_id, e.action, e.record_id, n.sequence, cip.campaign_product_id
         FROM influencer_import_effects e
         JOIN influencer_import_records r ON r.id = e.record_id
         JOIN source_snapshots n ON n.id = r.snapshot_id
         LEFT JOIN campaign_influencer_products cip ON cip.id = e.entity_id
        WHERE e.entity_type = 'campaign_influencer_product'
          AND (SELECT campaign_influencer_id FROM campaign_influencer_products WHERE id = e.entity_id) = $1
        ORDER BY n.sequence`,
      [campaignInfluencerId],
    );
    return {
      campaignInfluencerId,
      sourceKey: fila.source_key,
      boundVia: fila.bound_via,
      source: { id: fila.source_id, title: fila.filename, provider: fila.external_provider },
      snapshot: {
        id: fila.snapshot_id,
        sequence: fila.sequence,
        fetchedAt: fila.fetched_at.toISOString(),
        contentHash: fila.content_hash,
      },
      plan: { id: fila.plan_id },
      record: { id: fila.record_id },
      locators: fila.locators,
      boundBy: fila.bound_by,
      products: productos
        .filter((p) => p.campaign_product_id !== null)
        .map((p) => ({
          campaignProductId: p.campaign_product_id!,
          action: p.action,
          recordId: p.record_id,
          snapshotSequence: p.sequence,
        })),
    };
  });
}
