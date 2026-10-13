/**
 * Revisión de un guion contra el Brief aprobado vigente (V2 · Fase 7): análisis asistido y revisión humana.
 *
 * Una REVISIÓN (`content_analysis_runs`) es el hecho «este guion se contrastó con ESTE Brief aprobado». Hay
 * dos tipos y AMBOS pueden ser la revisión CURRENT que habilita aprobar (decisión del usuario):
 *   · `ai_assisted`: el modelo propone observaciones (hallazgos); todo-o-nada; la IA analiza y señala, nunca
 *     decide ni aprueba.
 *   · `human`: una persona (canal `ui`, `script:manage`) declara que revisó el guion contra el Brief. Sin
 *     hallazgos; los hallazgos NO son requisito: la decisión es humana.
 *
 * Reglas de oro:
 *  · Brief RECTOR (`obtenerBriefRector`): versión lógica `es` aprobada alguna vez (approved|superseded), la
 *    de mayor `approved_at`. Nunca un borrador. Sin rector ⇒ `BRIEF_NOT_APPROVED` y NO se llama al modelo.
 *  · CURRENT/STALE se DERIVA en lectura (`vigenciaDelAnalisis`): CURRENT = último run `succeeded` de la
 *    versión cuyo Brief gobernante es el rector actual; STALE = solo hay `succeeded` contra otros Briefs
 *    (sigue legible). Un reanálisis `failed` no desplaza al `succeeded`.
 *  · La llamada al worker ocurre FUERA de toda transacción. Luego UNA transacción persiste hallazgos +
 *    referencias + ledger (`ai_runs`, una fila POR LLAMADA, también en fallos) + auditoría + `succeeded`.
 *    Salida inválida ⇒ run `failed`/`ANALYSIS_INVALID_OUTPUT` con CERO hallazgos.
 *  · Idempotencia: `idempotency_key` + `request_hash`; reanálisis = run NUEVO (los anteriores no se tocan).
 *  · Nada de lo que devuelve el modelo (ni del guion, ni del Brief) es una instrucción: son datos. Los
 *    textos que esta capa devuelve (`description`, citas, valores del Brief) son NO CONFIABLES.
 *  · Orden de bloqueo: acción propuesta → ENTREGABLE → versión → Brief. El mutex del entregable serializa
 *    reclamar/cerrar un run con comentarios, pedir cambios y aprobar.
 *  · Aprobar NO vive aquí (`script-approval.ts`): este módulo nunca cambia a `approved`.
 */

import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import {
  type BriefRequirementInput,
  type DomainErrorPayload,
  type Criticality,
  type FieldStatus,
  type LlamadaDelWorker,
  type ProductoEnAlcance,
  type ProntitudDeAnalisis,
  type Result,
  type ScriptVersionStatus,
  type SourceLocator,
  type User,
  ANALYSIS_PROMPT_VERSION,
  CONTEXT_VERSION,
  OUTPUT_SCHEMA_VERSION,
  SEVERITY_POLICY_VERSION,
  authorizeInternalResource,
  campoDelCatalogo,
  codigoDeFalloDeAnalisis,
  construirContextoDeAnalisis,
  construirPeticionDeAnalisis,
  construirUnidadesDeRequisito,
  err,
  errorDeProntitudDeAnalisis,
  esFalloReintentablePorNode,
  evaluarProntitudDeAnalisis as evaluarProntitudPura,
  huellaDeProyeccionDeBrief,
  iaActiva,
  normalizarCifrasDeLlamada,
  ok,
  sanitizarMensajeDeError,
  secretoDelNonce,
  sha256Hex,
  validarSalidaDeAnalisis,
  vigenciaDelAnalisis,
} from '@tcl-kol-os/domain';
import { derivarNonce } from './agent-context.ts';
import { recordAudit } from './audit.ts';
import { type ContextoDeAuditoria, auditoriaDe, exigirPersona } from './audit-context.ts';
import { getPool, transaction } from './client.ts';
import {
  type ClienteDeAnalisis,
  type FalloDelModelo,
  type ResultadoDeLlamada,
  crearClienteDeAnalisisHttp,
} from './content-analysis-client.ts';
import {
  NO_ENCONTRADO_DE_CONTENIDO,
  bloquearEntregable,
  conReglasDeBase,
  esUuid,
  exigirCampanaYParticipacionActivas,
} from './deliverables.ts';
import { camposDeVersion } from './extraction.ts';
import { iniciarRevisionDeVersionEnTransaccion } from './script-versions.ts';
import { getFragments, getSource } from './sources.ts';
import { Abortar, transaccionConResultado } from './tx-result.ts';

// ─────────────────────────── Constantes ────────────────────────────────────────

/** Tope de análisis asistidos por versión de guion (cada uno cuesta). Reanalizar más exige otra versión. */
export const LIMITE_DE_ANALISIS_POR_VERSION = 10;
/** Plazo (lease) de un análisis en curso: pasado este plazo, el siguiente intento lo barre como abandonado. */
export const PLAZO_DE_ANALISIS_MS = 10 * 60 * 1000;
/** Tope de fragmentos que se leen de un guion (más ⇒ no cabe: `SCRIPT_CONTEXT_TOO_LARGE`). */
const MAX_FRAGMENTOS_DE_GUION = 2_000;

const MENSAJE_DE_FALLO =
  'El análisis no pudo completarse. Puede revisar el guion manualmente; la IA nunca es requisito.';

const ESTADOS_REVISABLES: readonly ScriptVersionStatus[] = ['received', 'in_review', 'approved'];

const CLAVE_DE_IDEMPOTENCIA = /^[A-Za-z0-9_.:-]{8,200}$/u;

type Consultor = pg.Pool | pg.PoolClient;
type LectorDeEntorno = (nombre: string) => string | undefined;

const entornoDelProceso: LectorDeEntorno = (n) => process.env[n];

// ─────────────────────────── Tipos públicos ────────────────────────────────────

export type TipoDeRevision = 'ai_assisted' | 'human';
export type EstadoDeRevision = 'queued' | 'running' | 'succeeded' | 'failed';
export type VigenciaDeRevision = 'current' | 'stale' | 'none' | 'failed' | 'running';
/** Vigencia de UNA revisión concreta (para listados). */
export type VigenciaDeRun = 'current' | 'stale' | 'no_governing_brief' | 'running' | 'failed';

export interface SeveridadesDeHallazgos {
  readonly alta: number;
  readonly media: number;
  readonly baja: number;
}

export interface RevisionDeContenido {
  readonly id: string;
  readonly kind: TipoDeRevision;
  /** Estado EFECTIVO: un run en curso con el plazo vencido se informa `failed`/`ANALYSIS_ABANDONED`. */
  readonly status: EstadoDeRevision;
  readonly vigencia: VigenciaDeRun;
  readonly organizationId: string;
  readonly campaignId: string;
  readonly scriptVersionId: string;
  readonly deliverableId: string;
  readonly campaignInfluencerId: string;
  readonly governingBriefVersionId: string;
  readonly governingBriefNumber: number;
  readonly briefApprovedAt: string;
  readonly briefFingerprint: string;
  readonly scriptSourceId: string;
  readonly scriptSourceHash: string;
  readonly findingCount: number;
  readonly findingsBySeverity: SeveridadesDeHallazgos;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly finishedAt: string | undefined;
  /** Solo `human`. Texto de una persona (no se interpreta). */
  readonly note: string | undefined;
  // Solo ai_assisted ─────────────────────────────────────────────────────────────
  readonly mode: 'ensure' | 'reanalyze' | undefined;
  readonly provider: string | undefined;
  readonly model: string | undefined;
  readonly promptVersion: string | undefined;
  readonly productScope: 'assigned' | 'all_campaign' | undefined;
  readonly failureCode: string | undefined;
  /** Códigos y cifras (sin contenido del modelo). */
  readonly failureDetail: Readonly<Record<string, unknown>> | undefined;
  /** Llamadas al proveedor registradas en el ledger y su costo (SUM de `ai_runs.cost_usd`). */
  readonly aiCalls: number;
  readonly costUsd: number | undefined;
  readonly context:
    | {
        readonly requirements: number;
        readonly notEvaluable: number;
        readonly truncated: number;
        readonly fragments: number;
      }
    | undefined;
}

export interface BriefRector {
  readonly versionId: string;
  readonly briefId: string;
  readonly campaignId: string;
  readonly number: number;
  readonly approvedAt: string;
  readonly status: 'approved' | 'superseded';
  /** Informativo: una versión posterior (borrador/en revisión) que todavía NO rige. */
  readonly sucesorEnTrabajo: {
    readonly versionId: string;
    readonly number: number;
    readonly status: string;
  } | null;
}

export interface HuellaDeBrief {
  readonly briefVersionId: string;
  readonly briefNumber: number;
  /** sha256 de la proyección canónica de los campos permitidos (valor original ES). */
  readonly fingerprint: string;
  readonly productScope: 'assigned' | 'all_campaign';
  readonly requirementCount: number;
  readonly notEvaluable: number;
}

export interface ProntitudDeVersion {
  readonly prontitud: ProntitudDeAnalisis;
  readonly briefRector: { readonly versionId: string; readonly number: number } | null;
  readonly scriptChars: number | undefined;
  readonly fragmentCount: number | undefined;
}

export interface RevisionVigente {
  readonly vigencia: VigenciaDeRevision;
  /** La revisión CURRENT; si no hay, la `succeeded` más reciente (STALE); si no, `null`. */
  readonly run: RevisionDeContenido | null;
  readonly kind: TipoDeRevision | null;
  /** Brief contra el que se hizo la revisión elegida. */
  readonly briefVersion: { readonly id: string; readonly number: number } | null;
  /** Brief rector actual. */
  readonly currentBriefVersion: { readonly id: string; readonly number: number } | null;
  readonly findingsBySeverity: SeveridadesDeHallazgos;
  readonly findingTotal: number;
  /** El último intento (cualquier tipo/estado): informa un reanálisis en curso o fallido sin desplazar a `run`. */
  readonly latestAttempt: RevisionDeContenido | null;
}

export interface EvidenciaDeBrief {
  readonly quote: string;
  readonly relation: string;
  readonly filename: string;
  readonly sourceId: string;
  readonly sourceVisibility: string;
  readonly locator: SourceLocator | null;
}

export interface ReferenciaDeBriefDeHallazgo {
  readonly fieldId: string;
  readonly fieldKey: string;
  readonly briefVersionId: string;
  readonly itemIndex: number | undefined;
  readonly criticidad: Criticality;
  /** Valor que se le mandó al modelo (texto del Brief: dato no confiable). */
  readonly valueSnippet: string;
  /** Evidencia y fuente ORIGINAL del Brief, adjuntadas por código desde el campo (no del modelo). */
  readonly evidence: readonly EvidenciaDeBrief[];
}

export interface ReferenciaDeGuionDeHallazgo {
  readonly sourceId: string;
  readonly fragmentOrdinal: number;
  readonly locator: SourceLocator | undefined;
  /** Cita del guion verificada literal (texto no confiable). */
  readonly quote: string;
  readonly quoteSha256: string;
}

export interface HallazgoDeContenido {
  readonly id: string;
  readonly analysisRunId: string;
  readonly ordinal: number;
  readonly category: string;
  readonly basis: string;
  readonly severity: 'baja' | 'media' | 'alta';
  readonly claimStatus: string | undefined;
  /** Texto del MODELO: dato no confiable, nunca una instrucción. */
  readonly description: string;
  readonly briefRefs: readonly ReferenciaDeBriefDeHallazgo[];
  readonly scriptRefs: readonly ReferenciaDeGuionDeHallazgo[];
  readonly createdAt: string;
}

export interface PaginaDeHallazgos {
  readonly run: RevisionDeContenido | null;
  readonly vigencia: VigenciaDeRevision;
  readonly items: readonly HallazgoDeContenido[];
  readonly total: number;
  readonly limite: number;
  readonly desde: number;
  /** Aviso para quien lo reenvíe a un modelo o a una vista: `description` y las citas son texto no confiable. */
  readonly untrustedText: true;
}

export interface PaginaDeRevisiones {
  readonly items: readonly RevisionDeContenido[];
  readonly total: number;
  readonly limite: number;
  readonly desde: number;
}

export interface SolicitudDeAnalisis {
  /** `ensure`: si ya hay un análisis CURRENT con los mismos insumos lo devuelve sin llamar al modelo. `reanalyze`: run nuevo. */
  readonly mode: 'ensure' | 'reanalyze';
  /** UI: token aleatorio por render del formulario. Chat: `tool:{toolInvocationId}`. */
  readonly idempotencyKey: string;
  /** Cerco de campaña: una versión de otra campaña se responde como inexistente. */
  readonly alcance?: { readonly campaignId: string } | undefined;
}

export interface AnalisisSolicitado {
  /** `created`: se ejecutó ahora; `reused_current` (ensure): ya había uno CURRENT; `replayed`: misma clave de idempotencia. */
  readonly outcome: 'created' | 'reused_current' | 'replayed';
  readonly run: RevisionDeContenido;
  readonly warnings: readonly string[];
}

export interface RevisionHumanaRegistrada {
  readonly run: RevisionDeContenido;
  /** `true` si esa persona ya había registrado la revisión contra este Brief (doble clic idempotente). */
  readonly reused: boolean;
}

export interface DependenciasDeAnalisis {
  /** Cliente del worker. Por defecto, HTTP (`AI_WORKER_URL ?? WORKER_URL`). */
  readonly cliente?: ClienteDeAnalisis | undefined;
  /** Entorno inyectable (`AI_ENABLED`, `AGENT_NONCE_SECRET`/`SESSION_SECRET`, `AI_PROVIDER`…). */
  readonly env?: LectorDeEntorno | undefined;
  readonly ahora?: (() => Date) | undefined;
  /** Espera entre el intento y su reintento de transporte (por defecto 1 s, acotada por `Retry-After`). */
  readonly esperar?: ((ms: number) => Promise<void>) | undefined;
  /** Plazo de un análisis en curso. */
  readonly plazoMs?: number | undefined;
}

// ─────────────────────────── Filas de apoyo ────────────────────────────────────

interface FilaDeVersionParaRevision {
  readonly id: string;
  readonly organization_id: string;
  readonly campaign_id: string;
  readonly deliverable_id: string;
  readonly version: number;
  readonly status: ScriptVersionStatus;
  readonly source_document_id: string;
  readonly source_hash: string;
  readonly campaign_influencer_id: string;
  readonly deliverable_label: string;
  readonly deliverable_status: string;
  readonly campaign_product_id: string | null;
  readonly display_name: string;
}

async function cargarVersion(
  db: Consultor,
  versionId: string,
): Promise<FilaDeVersionParaRevision | undefined> {
  const { rows } = await db.query<FilaDeVersionParaRevision>(
    `SELECT sv.id, sv.organization_id, sv.campaign_id, sv.deliverable_id, sv.version, sv.status,
            sv.source_document_id, sv.source_hash, d.campaign_influencer_id, d.label AS deliverable_label,
            d.status AS deliverable_status, d.campaign_product_id, i.display_name
       FROM script_versions sv
       JOIN deliverables d ON d.id = sv.deliverable_id
       JOIN campaign_influencers ci ON ci.id = d.campaign_influencer_id
       JOIN influencers i ON i.id = ci.influencer_id
      WHERE sv.id = $1`,
    [versionId],
  );
  return rows[0];
}

interface FilaDeRevision {
  readonly id: string;
  readonly organization_id: string;
  readonly campaign_id: string;
  readonly kind: TipoDeRevision;
  readonly script_version_id: string;
  readonly deliverable_id: string;
  readonly campaign_influencer_id: string;
  readonly governing_brief_version_id: string;
  readonly governing_brief_number: number;
  readonly brief_approved_at: Date;
  readonly brief_fingerprint: string;
  readonly script_source_id: string;
  readonly script_source_hash: string;
  readonly product_scope: 'assigned' | 'all_campaign' | null;
  readonly counts: {
    requirements?: number;
    notEvaluable?: number;
    truncated?: number;
    fragments?: number;
  } | null;
  readonly prompt_version: string | null;
  readonly provider: string | null;
  readonly model: string | null;
  readonly status: EstadoDeRevision;
  readonly failure_code: string | null;
  readonly failure_detail: Record<string, unknown> | null;
  readonly finding_count: number;
  readonly mode: 'ensure' | 'reanalyze' | null;
  readonly note: string | null;
  readonly created_by: string;
  readonly created_at: Date;
  readonly finished_at: Date | null;
  readonly lease_vencido: boolean;
  readonly alta: number;
  readonly media: number;
  readonly baja: number;
  readonly llamadas: number;
  readonly costo: string | null;
}

const SELECT_REVISION = `
  SELECT r.id, r.organization_id, r.campaign_id, r.kind, r.script_version_id, r.deliverable_id,
         r.campaign_influencer_id, r.governing_brief_version_id, r.governing_brief_number, r.brief_approved_at,
         r.brief_fingerprint, r.script_source_id, r.script_source_hash, r.product_scope,
         r.context_manifest->'counts' AS counts, r.prompt_version, r.provider, r.model, r.status,
         r.failure_code, r.failure_detail, r.finding_count, r.mode, r.note, r.created_by, r.created_at,
         r.finished_at,
         (r.status IN ('queued', 'running') AND r.lease_expires_at < now()) AS lease_vencido,
         COALESCE(fc.alta, 0) AS alta, COALESCE(fc.media, 0) AS media, COALESCE(fc.baja, 0) AS baja,
         COALESCE(a.n, 0) AS llamadas, a.costo
    FROM content_analysis_runs r
    LEFT JOIN LATERAL (
      SELECT count(*) FILTER (WHERE f.severity = 'alta')::int AS alta,
             count(*) FILTER (WHERE f.severity = 'media')::int AS media,
             count(*) FILTER (WHERE f.severity = 'baja')::int AS baja
        FROM content_findings f WHERE f.analysis_run_id = r.id
    ) fc ON true
    LEFT JOIN LATERAL (
      SELECT count(*)::int AS n, sum(ar.cost_usd) AS costo
        FROM ai_runs ar WHERE ar.content_analysis_run_id = r.id
    ) a ON true
`;

const ABANDONADO = 'ANALYSIS_ABANDONED';

function comoRevision(f: FilaDeRevision, rectorId: string | undefined): RevisionDeContenido {
  const abandonado = f.lease_vencido;
  const status: EstadoDeRevision = abandonado ? 'failed' : f.status;
  let vigencia: VigenciaDeRun;
  if (status === 'succeeded') {
    vigencia = vigenciaDelRun(f.governing_brief_version_id, rectorId);
  } else if (status === 'failed') {
    vigencia = 'failed';
  } else {
    vigencia = 'running';
  }
  return {
    id: f.id,
    kind: f.kind,
    status,
    vigencia,
    organizationId: f.organization_id,
    campaignId: f.campaign_id,
    scriptVersionId: f.script_version_id,
    deliverableId: f.deliverable_id,
    campaignInfluencerId: f.campaign_influencer_id,
    governingBriefVersionId: f.governing_brief_version_id,
    governingBriefNumber: f.governing_brief_number,
    briefApprovedAt: f.brief_approved_at.toISOString(),
    briefFingerprint: f.brief_fingerprint,
    scriptSourceId: f.script_source_id,
    scriptSourceHash: f.script_source_hash,
    findingCount: f.finding_count,
    findingsBySeverity: { alta: f.alta, media: f.media, baja: f.baja },
    createdBy: f.created_by,
    createdAt: f.created_at.toISOString(),
    finishedAt: f.finished_at?.toISOString(),
    note: f.note ?? undefined,
    mode: f.mode ?? undefined,
    provider: f.provider ?? undefined,
    model: f.model ?? undefined,
    promptVersion: f.prompt_version ?? undefined,
    productScope: f.product_scope ?? undefined,
    failureCode: abandonado ? ABANDONADO : (f.failure_code ?? undefined),
    failureDetail: abandonado ? { reason: 'lease_expired' } : (f.failure_detail ?? undefined),
    aiCalls: f.llamadas,
    costUsd: f.costo === null ? undefined : Number(f.costo),
    context:
      f.counts === null
        ? undefined
        : {
            requirements: f.counts.requirements ?? 0,
            notEvaluable: f.counts.notEvaluable ?? 0,
            truncated: f.counts.truncated ?? 0,
            fragments: f.counts.fragments ?? 0,
          },
  };
}

/** La función pura del dominio es la ÚNICA definición de CURRENT/STALE. */
function vigenciaDelRun(governing: string, rectorId: string | undefined): VigenciaDeRun {
  return vigenciaDelAnalisis({
    runGoverningBriefVersionId: governing,
    currentGoverningBriefVersionId: rectorId,
  }).status;
}

async function leerRevision(
  db: Consultor,
  runId: string,
  rectorId: string | undefined,
): Promise<RevisionDeContenido | undefined> {
  const { rows } = await db.query<FilaDeRevision>(`${SELECT_REVISION} WHERE r.id = $1`, [runId]);
  return rows[0] === undefined ? undefined : comoRevision(rows[0], rectorId);
}

// ─────────────────────────── Brief rector ──────────────────────────────────────

interface FilaDeRector {
  readonly id: string;
  readonly brief_id: string;
  readonly version: number;
  readonly approved_at: Date;
  readonly status: 'approved' | 'superseded';
}

/**
 * El Brief que rige la campaña (SQL de REPORTE B §5; paridad probada con `brief_rector_de_campana`):
 * versión lógica `es` con `approved_at` y estado approved|superseded, la de mayor `approved_at` (luego
 * `version`). Una hija en borrador NO desplaza al padre. Jamás devuelve un borrador.
 */
export async function leerRector(
  db: Consultor,
  campaignId: string,
  organizationId: string,
): Promise<BriefRector | undefined> {
  const { rows } = await db.query<FilaDeRector>(
    `SELECT v.id, v.brief_id, v.version, v.approved_at, v.status::text AS status
       FROM brief_versions v JOIN briefs b ON b.id = v.brief_id
      WHERE b.campaign_id = $1 AND v.organization_id = $2 AND v.language = 'es'
        AND v.approved_at IS NOT NULL AND v.status IN ('approved', 'superseded')
      ORDER BY v.approved_at DESC, v.version DESC
      LIMIT 1`,
    [campaignId, organizationId],
  );
  const r = rows[0];
  if (r === undefined) return undefined;
  const { rows: sucesores } = await db.query<{ id: string; version: number; status: string }>(
    `SELECT id, version, status::text AS status FROM brief_versions
      WHERE brief_id = $1 AND language = 'es' AND version > $2 AND status <> 'cancelled'
      ORDER BY version DESC LIMIT 1`,
    [r.brief_id, r.version],
  );
  const s = sucesores[0];
  return {
    versionId: r.id,
    briefId: r.brief_id,
    campaignId,
    number: r.version,
    approvedAt: r.approved_at.toISOString(),
    status: r.status,
    sucesorEnTrabajo: s === undefined ? null : { versionId: s.id, number: s.version, status: s.status },
  };
}

async function estadoDelUltimoBrief(db: Consultor, campaignId: string): Promise<string | undefined> {
  const { rows } = await db.query<{ status: string }>(
    `SELECT v.status::text AS status FROM brief_versions v JOIN briefs b ON b.id = v.brief_id
      WHERE b.campaign_id = $1 AND v.language = 'es' ORDER BY v.version DESC LIMIT 1`,
    [campaignId],
  );
  return rows[0]?.status;
}

function sinRector(latestStatus: string | undefined): Result<never> {
  return err({
    code: 'BRIEF_NOT_APPROVED',
    message: 'Todavía no existe un Brief aprobado para esta campaña.',
    ...(latestStatus === undefined ? {} : { details: { latestStatus } }),
  });
}

/**
 * El Brief aprobado vigente de la campaña, o `BRIEF_NOT_APPROVED`. Exige `brief:read` sobre la organización
 * (cliente/otra agencia ⇒ `RESOURCE_NOT_FOUND`). NUNCA devuelve un borrador; `sucesorEnTrabajo` es solo
 * informativo.
 */
export async function obtenerBriefRector(actor: User, campaignId: string): Promise<Result<BriefRector>> {
  if (!esUuid(campaignId)) return err(NO_ENCONTRADO_DE_CONTENIDO);
  const { rows } = await getPool().query<{ organization_id: string }>(
    `SELECT organization_id FROM campaigns WHERE id = $1`,
    [campaignId],
  );
  const campana = rows[0];
  if (campana === undefined) return err(NO_ENCONTRADO_DE_CONTENIDO);
  const permitido = authorizeInternalResource(actor, 'brief:read', campana.organization_id);
  if (!permitido.ok) return permitido;
  const rector = await leerRector(getPool(), campaignId, campana.organization_id);
  if (rector === undefined) return sinRector(await estadoDelUltimoBrief(getPool(), campaignId));
  return ok(rector);
}

// ─────────────────────────── Insumos del análisis ──────────────────────────────

interface Insumos {
  readonly productos: readonly ProductoEnAlcance[];
  readonly productScope: 'assigned' | 'all_campaign';
  readonly requisitos: readonly BriefRequirementInput[];
}

/**
 * Productos en alcance del guion: el del entregable si lo tiene; si no, los asignados a la participación
 * (DEC-044); si no hay asignados, TODOS los de la campaña con advertencia (`all_campaign`). No se inventa.
 */
async function productosEnAlcance(
  db: Consultor,
  fila: Pick<FilaDeVersionParaRevision, 'campaign_id' | 'campaign_influencer_id' | 'campaign_product_id'>,
): Promise<{ productos: ProductoEnAlcance[]; scope: 'assigned' | 'all_campaign' }> {
  const comoProductos = (rows: { id: string; brand: string; model: string }[]): ProductoEnAlcance[] =>
    rows.map((r) => ({ id: r.id, nombre: `${r.brand} ${r.model}`.trim() }));
  if (fila.campaign_product_id !== null) {
    const { rows } = await db.query<{ id: string; brand: string; model: string }>(
      `SELECT cp.id, p.brand, p.model FROM campaign_products cp JOIN products p ON p.id = cp.product_id
        WHERE cp.id = $1 AND cp.campaign_id = $2`,
      [fila.campaign_product_id, fila.campaign_id],
    );
    return { productos: comoProductos(rows), scope: 'assigned' };
  }
  const { rows: asignados } = await db.query<{ id: string; brand: string; model: string }>(
    `SELECT cp.id, p.brand, p.model
       FROM campaign_influencer_products cip
       JOIN campaign_products cp ON cp.id = cip.campaign_product_id
       JOIN products p ON p.id = cp.product_id
      WHERE cip.campaign_influencer_id = $1 ORDER BY cp.prioridad, cp.id`,
    [fila.campaign_influencer_id],
  );
  if (asignados.length > 0) return { productos: comoProductos(asignados), scope: 'assigned' };
  const { rows: todos } = await db.query<{ id: string; brand: string; model: string }>(
    `SELECT cp.id, p.brand, p.model FROM campaign_products cp JOIN products p ON p.id = cp.product_id
      WHERE cp.campaign_id = $1 ORDER BY cp.prioridad, cp.id`,
    [fila.campaign_id],
  );
  return { productos: comoProductos(todos), scope: 'all_campaign' };
}

/**
 * Los campos de la versión del Brief rector tal cual (valor ORIGINAL ES), listos para el dominio. Se lee con
 * el `db` dado (el pool o el cliente de una transacción: la aprobación lo usa BAJO sus bloqueos); es la misma
 * proyección de campos que `camposDeVersion` (sin evidencias, que no entran en la huella ni en el contexto).
 */
async function requisitosDelRector(db: Consultor, rectorVersionId: string): Promise<BriefRequirementInput[]> {
  const { rows } = await db.query<{
    id: string;
    key: string;
    campaign_product_id: string | null;
    value: unknown;
    status: string;
    criticidad: string;
  }>(
    `SELECT bf.id, bf.key, bf.campaign_product_id, bf.value, bf.status::text AS status,
            bf.criticidad::text AS criticidad
       FROM brief_fields bf WHERE bf.brief_version_id = $1 ORDER BY bf.key`,
    [rectorVersionId],
  );
  return rows.map((c) => ({
    campo: c.key,
    etiqueta: campoDelCatalogo(c.key)?.label ?? c.key,
    criticidad: c.criticidad as Criticality,
    status: c.status as FieldStatus,
    valor: c.value,
    ...(c.campaign_product_id === null ? {} : { productoId: c.campaign_product_id }),
    fieldId: c.id,
  }));
}

async function cargarInsumos(
  db: Consultor,
  fila: FilaDeVersionParaRevision,
  rector: BriefRector,
): Promise<Insumos> {
  const alcance = await productosEnAlcance(db, fila);
  return {
    productos: alcance.productos,
    productScope: alcance.scope,
    requisitos: await requisitosDelRector(db, rector.versionId),
  };
}

function huellaDe(insumos: Insumos, rector: BriefRector): HuellaDeBrief {
  const { unidades } = construirUnidadesDeRequisito(insumos.requisitos, insumos.productos);
  return {
    briefVersionId: rector.versionId,
    briefNumber: rector.number,
    fingerprint: huellaDeProyeccionDeBrief(unidades, rector.versionId),
    productScope: insumos.productScope,
    requirementCount: unidades.length,
    notEvaluable: unidades.filter((u) => !u.evaluable).length,
  };
}

// ─────────────────────────── Autorización común ────────────────────────────────

interface VersionAutorizada {
  readonly fila: FilaDeVersionParaRevision;
}

async function versionAutorizada(
  actor: User,
  versionId: string,
  acciones: readonly ('script:read' | 'script:manage' | 'brief:read')[],
  alcance: { readonly campaignId: string } | undefined,
): Promise<Result<VersionAutorizada>> {
  if (!esUuid(versionId)) return err(NO_ENCONTRADO_DE_CONTENIDO);
  const fila = await cargarVersion(getPool(), versionId);
  if (fila === undefined) return err(NO_ENCONTRADO_DE_CONTENIDO);
  if (alcance !== undefined && fila.campaign_id !== alcance.campaignId)
    return err(NO_ENCONTRADO_DE_CONTENIDO);
  for (const accion of acciones) {
    const permitido = authorizeInternalResource(actor, accion, fila.organization_id);
    if (!permitido.ok) return permitido;
  }
  return ok({ fila });
}

/** Campaña, participación y entregable activos (si no, conflicto accionable). Lanza `Abortar`. */
async function exigirActivos(db: Consultor, fila: FilaDeVersionParaRevision): Promise<void> {
  if (fila.deliverable_status !== 'active') {
    throw new Abortar({
      code: 'RESOURCE_CONFLICT',
      message: 'El entregable está archivado: reactívelo para revisar sus versiones.',
      details: { reason: 'deliverable_archived', deliverableId: fila.deliverable_id },
    });
  }
  await exigirCampanaYParticipacionActivas(db, fila);
}

function payloadDeEstado(estado: ScriptVersionStatus): DomainErrorPayload {
  return {
    code: 'RESOURCE_CONFLICT',
    message: `La versión está en estado «${estado}»: ya no admite revisiones.`,
    details: { reason: 'version_not_reviewable', status: estado },
  };
}

function errorDeEstado(estado: ScriptVersionStatus): Result<never> {
  return err(payloadDeEstado(estado));
}

async function comoResultado<T>(fn: () => Promise<Result<T>>): Promise<Result<T>> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof Abortar) return err(error.payload);
    throw error;
  }
}

// ─────────────────────────── Prontitud y huella (lecturas) ─────────────────────

/**
 * ¿Se puede analizar este guion AHORA? Compone la función pura del dominio con la base: kill-switch
 * (`AI_ENABLED`), Brief rector, preparación de la fuente (misma política que el chat) y tamaño del guion.
 * Sin gasto ni run. Exige `script:read` y `brief:read` (Cuenta).
 */
export async function evaluarProntitudDeAnalisis(
  actor: User,
  versionId: string,
  opciones: {
    readonly alcance?: { readonly campaignId: string } | undefined;
    readonly env?: LectorDeEntorno | undefined;
  } = {},
): Promise<Result<ProntitudDeVersion>> {
  const a = await versionAutorizada(actor, versionId, ['script:read', 'brief:read'], opciones.alcance);
  if (!a.ok) return a;
  const { fila } = a.value;
  const env = opciones.env ?? entornoDelProceso;
  const rector = await leerRector(getPool(), fila.campaign_id, fila.organization_id);
  const resumenRector = rector === undefined ? null : { versionId: rector.versionId, number: rector.number };
  const fuente = await getSource(actor, fila.source_document_id);
  if (!fuente.ok) return err(NO_ENCONTRADO_DE_CONTENIDO);
  const entrada = {
    origin: fuente.value.origin,
    status: fuente.value.status,
    confidentialityLevel: fuente.value.confidentiality_level,
    fragmentCount: fuente.value.fragmentos,
    jobStatus: fuente.value.job_status,
    provider: fuente.value.external_provider,
  };
  const base = { iaActiva: iaActiva(env), hayBriefRector: rector !== undefined, fuente: entrada };
  const primera = evaluarProntitudPura(base);
  if (primera !== 'ready') {
    return ok({
      prontitud: primera,
      briefRector: resumenRector,
      scriptChars: undefined,
      fragmentCount: undefined,
    });
  }
  const fragmentos = await getFragments(actor, fila.source_document_id, MAX_FRAGMENTOS_DE_GUION + 1);
  if (!fragmentos.ok) return err(NO_ENCONTRADO_DE_CONTENIDO);
  const con = fragmentos.value.filter((f) => f.text.trim() !== '');
  const chars = con.reduce((s, f) => s + f.text.length, 0);
  const prontitud =
    fragmentos.value.length > MAX_FRAGMENTOS_DE_GUION
      ? 'script_too_large'
      : evaluarProntitudPura({ ...base, scriptChars: chars });
  return ok({ prontitud, briefRector: resumenRector, scriptChars: chars, fragmentCount: con.length });
}

/**
 * Huella de la proyección REAL del Brief rector (solo campos permitidos, valor original ES, alcance de
 * producto de la participación) para una versión de guion. Es la misma que guardan las revisiones: sirve
 * para la huella de aprobación y para detectar que el Brief rector cambió. Excluye traducciones,
 * comentarios, preguntas y actividad. Exige `script:read` y `brief:read`.
 */
export async function huellaDeBriefRector(
  actor: User,
  versionId: string,
  alcance?: { readonly campaignId: string },
): Promise<Result<HuellaDeBrief>> {
  const a = await versionAutorizada(actor, versionId, ['script:read', 'brief:read'], alcance);
  if (!a.ok) return a;
  const { fila } = a.value;
  const rector = await leerRector(getPool(), fila.campaign_id, fila.organization_id);
  if (rector === undefined) return sinRector(await estadoDelUltimoBrief(getPool(), fila.campaign_id));
  return ok(huellaDe(await cargarInsumos(getPool(), fila, rector), rector));
}

// ─────────────────────────── Insumos de la aprobación (W3a) ────────────────────

/**
 * Huella ACTUAL de la proyección del Brief rector para esta participación (la misma que guardan las
 * revisiones). Sin memoria: se recalcula con el `db` dado (la aprobación corre bajo bloqueos).
 */
async function huellaVigenteDeProyeccion(
  db: Consultor,
  fila: Pick<FilaDeVersionParaRevision, 'campaign_id' | 'campaign_influencer_id' | 'campaign_product_id'>,
  rector: BriefRector,
): Promise<{ fingerprint: string; productScope: 'assigned' | 'all_campaign' }> {
  const alcance = await productosEnAlcance(db, fila);
  const h = huellaDe(
    {
      productos: alcance.productos,
      productScope: alcance.scope,
      requisitos: await requisitosDelRector(db, rector.versionId),
    },
    rector,
  );
  return { fingerprint: h.fingerprint, productScope: h.productScope };
}

/**
 * Lo que la aprobación de un guion necesita de este módulo, leído con un `db` cualquiera (el pool o el
 * cliente de una transacción: la aprobación lo usa BAJO los bloqueos, sin pedir otra conexión). Es la
 * MISMA definición de rector y de CURRENT/STALE que usan las lecturas (`leerRector`, `elegirVigente`); no
 * autoriza (quien llama ya lo hizo).
 */
export interface InsumosDeRevisionParaAprobar {
  readonly rector: BriefRector | undefined;
  readonly vigente: RevisionVigente;
  /** `request_hash` de la revisión elegida (solo `ai_assisted`); `null` en una revisión humana o sin revisión. */
  readonly inputHash: string | null;
  /**
   * La revisión CURRENT se hizo con otros insumos que los de hoy aunque el Brief rector sea el mismo: la
   * proyección del Brief para esta participación (productos en alcance) cambió después (QA-F7-04b). Solo se
   * calcula al aprobar (cuesta una lectura de los campos del Brief); las lecturas y listados siguen
   * derivando CURRENT/STALE solo por el Brief rector (limitación documentada).
   */
  readonly insumosCambiaron: boolean;
}

export async function leerInsumosDeRevisionParaAprobar(
  db: pg.Pool | pg.PoolClient,
  version: {
    readonly id: string;
    readonly campaign_id: string;
    readonly organization_id: string;
    /** Opcionales: si el llamador ya los leyó, se evita una consulta más (la aprobación corre bajo carga). */
    readonly campaign_influencer_id?: string;
    readonly campaign_product_id?: string | null;
  },
): Promise<InsumosDeRevisionParaAprobar> {
  const rector = await leerRector(db, version.campaign_id, version.organization_id);
  const filas = await filasDeVersion(db, version.id);
  const vigente = elegirVigente(filas, rector);
  const runId = vigente.run?.id;
  let inputHash: string | null = null;
  if (runId !== undefined) {
    const { rows } = await db.query<{ request_hash: string | null }>(
      `SELECT request_hash FROM content_analysis_runs WHERE id = $1`,
      [runId],
    );
    inputHash = rows[0]?.request_hash ?? null;
  }
  let insumosCambiaron = false;
  if (rector !== undefined && vigente.vigencia === 'current' && vigente.run !== null) {
    const fila =
      version.campaign_influencer_id !== undefined && version.campaign_product_id !== undefined
        ? {
            ...version,
            campaign_influencer_id: version.campaign_influencer_id,
            campaign_product_id: version.campaign_product_id,
          }
        : await cargarVersion(db, version.id);
    if (fila !== undefined) {
      const actual = await huellaVigenteDeProyeccion(db, fila, rector);
      const guardada = vigente.run;
      insumosCambiaron =
        guardada.briefFingerprint !== actual.fingerprint ||
        (guardada.productScope !== undefined && guardada.productScope !== actual.productScope);
    }
  }
  return { rector, vigente, inputHash, insumosCambiaron };
}

// ─────────────────────────── Vigencia y listados ───────────────────────────────

function porRecientes(a: FilaDeRevision, b: FilaDeRevision): number {
  const ta = (a.finished_at ?? a.created_at).getTime();
  const tb = (b.finished_at ?? b.created_at).getTime();
  return tb - ta || b.created_at.getTime() - a.created_at.getTime() || (a.id < b.id ? 1 : -1);
}

async function filasDeVersion(db: Consultor, versionId: string): Promise<FilaDeRevision[]> {
  const { rows } = await db.query<FilaDeRevision>(
    `${SELECT_REVISION} WHERE r.script_version_id = $1 ORDER BY r.created_at DESC, r.id DESC LIMIT 500`,
    [versionId],
  );
  return rows;
}

const SIN_HALLAZGOS: SeveridadesDeHallazgos = { alta: 0, media: 0, baja: 0 };

/** Elige la revisión vigente de una versión entre sus runs (pura: sin E/S). */
function elegirVigente(filas: readonly FilaDeRevision[], rector: BriefRector | undefined): RevisionVigente {
  const rectorId = rector?.versionId;
  const resumenRector = rector === undefined ? null : { id: rector.versionId, number: rector.number };
  const efectivas = filas.map((f) => ({ f, r: comoRevision(f, rectorId) }));
  const exitosas = efectivas.filter((x) => x.r.status === 'succeeded').sort((x, y) => porRecientes(x.f, y.f));
  const ultimoIntento = [...efectivas].sort((x, y) => y.f.created_at.getTime() - x.f.created_at.getTime())[0];
  const current = exitosas.find((x) => x.r.vigencia === 'current');
  const elegida = current ?? exitosas[0];
  let vigencia: VigenciaDeRevision;
  if (current !== undefined) vigencia = 'current';
  else if (elegida !== undefined) vigencia = 'stale';
  else if (ultimoIntento?.r.status === 'running' || ultimoIntento?.r.status === 'queued')
    vigencia = 'running';
  else if (ultimoIntento?.r.status === 'failed') vigencia = 'failed';
  else vigencia = 'none';
  return {
    vigencia,
    run: elegida?.r ?? null,
    kind: elegida?.r.kind ?? null,
    briefVersion:
      elegida === undefined
        ? null
        : { id: elegida.r.governingBriefVersionId, number: elegida.r.governingBriefNumber },
    currentBriefVersion: resumenRector,
    findingsBySeverity: elegida?.r.findingsBySeverity ?? SIN_HALLAZGOS,
    findingTotal: elegida?.r.findingCount ?? 0,
    latestAttempt: ultimoIntento?.r ?? null,
  };
}

/**
 * La revisión VIGENTE de una versión de guion, derivada en lectura:
 *   current  hay una revisión `succeeded` (IA o humana) contra el Brief rector actual;
 *   stale    solo hay `succeeded` contra otros Briefs (siguen legibles);
 *   running / failed  no hay ninguna `succeeded` y el último intento está en curso / falló;
 *   none     nunca se revisó.
 * Un reanálisis `failed` o en curso NO desplaza a la `succeeded` (queda en `latestAttempt`).
 * Exige `script:read` (admin/director/consultor; el Operativo y el cliente no).
 */
export async function obtenerRevisionVigente(
  actor: User,
  versionId: string,
  alcance?: { readonly campaignId: string },
): Promise<Result<RevisionVigente>> {
  const a = await versionAutorizada(actor, versionId, ['script:read'], alcance);
  if (!a.ok) return a;
  const { fila } = a.value;
  const [rector, filas] = await Promise.all([
    leerRector(getPool(), fila.campaign_id, fila.organization_id),
    filasDeVersion(getPool(), fila.id),
  ]);
  return ok(elegirVigente(filas, rector));
}

export interface OpcionesDeListado {
  readonly limite?: number | undefined;
  readonly desde?: number | undefined;
  readonly alcance?: { readonly campaignId: string } | undefined;
}

/** Historial de revisiones de una versión (más recientes primero), cada una con su vigencia. Exige `script:read`. */
export async function listarRevisiones(
  actor: User,
  versionId: string,
  opciones: OpcionesDeListado = {},
): Promise<Result<PaginaDeRevisiones>> {
  const a = await versionAutorizada(actor, versionId, ['script:read'], opciones.alcance);
  if (!a.ok) return a;
  const { fila } = a.value;
  const limite = Math.min(Math.max(Math.trunc(opciones.limite ?? 50), 1), 200);
  const desde = Math.max(Math.trunc(opciones.desde ?? 0), 0);
  const [rector, filas] = await Promise.all([
    leerRector(getPool(), fila.campaign_id, fila.organization_id),
    filasDeVersion(getPool(), fila.id),
  ]);
  return ok({
    items: filas.slice(desde, desde + limite).map((f) => comoRevision(f, rector?.versionId)),
    total: filas.length,
    limite,
    desde,
  });
}

interface FilaDeHallazgo {
  readonly id: string;
  readonly analysis_run_id: string;
  readonly ordinal: number;
  readonly category: string;
  readonly basis: string;
  readonly severity: 'baja' | 'media' | 'alta';
  readonly claim_status: string | null;
  readonly description: string;
  readonly created_at: Date;
}

/**
 * Hallazgos con sus referencias. Por `{runId}` los de esa revisión; por `{versionId}` los de la revisión
 * vigente (CURRENT; si no hay, la `succeeded` más reciente, STALE). La evidencia y la fuente original del
 * Brief se adjuntan por código desde el campo referenciado. `description`, citas y valores del Brief son
 * texto NO CONFIABLE (`untrustedText`): nunca instrucciones. Exige `script:read`.
 */
export async function listarHallazgos(
  actor: User,
  objetivo: { readonly versionId: string } | { readonly runId: string },
  alcance?: { readonly campaignId: string },
  opciones: { readonly limite?: number | undefined; readonly desde?: number | undefined } = {},
): Promise<Result<PaginaDeHallazgos>> {
  const limite = Math.min(Math.max(Math.trunc(opciones.limite ?? 50), 1), 100);
  const desde = Math.max(Math.trunc(opciones.desde ?? 0), 0);
  let versionId: string;
  let runId: string | undefined;
  if ('runId' in objetivo) {
    if (!esUuid(objetivo.runId)) return err(NO_ENCONTRADO_DE_CONTENIDO);
    const { rows } = await getPool().query<{ script_version_id: string }>(
      `SELECT script_version_id FROM content_analysis_runs WHERE id = $1`,
      [objetivo.runId],
    );
    if (rows[0] === undefined) return err(NO_ENCONTRADO_DE_CONTENIDO);
    versionId = rows[0].script_version_id;
    runId = objetivo.runId;
  } else {
    versionId = objetivo.versionId;
  }
  const a = await versionAutorizada(actor, versionId, ['script:read'], alcance);
  if (!a.ok) return a;
  const { fila } = a.value;
  const rector = await leerRector(getPool(), fila.campaign_id, fila.organization_id);
  const filas = await filasDeVersion(getPool(), fila.id);
  const vigente = elegirVigente(filas, rector);

  let revision: RevisionDeContenido | null;
  let vigencia: VigenciaDeRevision;
  if (runId !== undefined) {
    const f = filas.find((x) => x.id === runId);
    revision = f === undefined ? null : comoRevision(f, rector?.versionId);
    vigencia =
      revision === null
        ? 'none'
        : revision.status === 'succeeded'
          ? revision.vigencia === 'current'
            ? 'current'
            : 'stale'
          : revision.status === 'failed'
            ? 'failed'
            : 'running';
  } else {
    revision = vigente.run;
    vigencia = vigente.vigencia;
  }
  if (revision === null || revision.kind === 'human' || revision.findingCount === 0) {
    return ok({ run: revision, vigencia, items: [], total: 0, limite, desde, untrustedText: true });
  }

  const { rows: hallazgos } = await getPool().query<FilaDeHallazgo>(
    `SELECT id, analysis_run_id, ordinal, category, basis, severity, claim_status, description, created_at
       FROM content_findings WHERE analysis_run_id = $1 ORDER BY ordinal LIMIT ${limite} OFFSET ${desde}`,
    [revision.id],
  );
  const ids = hallazgos.map((h) => h.id);
  const { rows: refsBrief } =
    ids.length === 0
      ? {
          rows: [] as {
            finding_id: string;
            brief_field_id: string;
            brief_version_id: string;
            item_index: number | null;
            field_key: string;
            criticidad: Criticality;
            value_snippet: string;
          }[],
        }
      : await getPool().query<{
          finding_id: string;
          brief_field_id: string;
          brief_version_id: string;
          item_index: number | null;
          field_key: string;
          criticidad: Criticality;
          value_snippet: string;
        }>(
          `SELECT finding_id, brief_field_id, brief_version_id, item_index, field_key, criticidad, value_snippet
           FROM content_finding_brief_refs WHERE finding_id = ANY($1::uuid[])
          ORDER BY created_at, id`,
          [ids],
        );
  const { rows: refsGuion } =
    ids.length === 0
      ? {
          rows: [] as {
            finding_id: string;
            source_id: string;
            fragment_ordinal: number;
            locator: SourceLocator | null;
            quote: string;
            quote_sha256: string;
          }[],
        }
      : await getPool().query<{
          finding_id: string;
          source_id: string;
          fragment_ordinal: number;
          locator: SourceLocator | null;
          quote: string;
          quote_sha256: string;
        }>(
          `SELECT finding_id, source_id, fragment_ordinal, locator, quote, quote_sha256
           FROM content_finding_script_refs WHERE finding_id = ANY($1::uuid[])
          ORDER BY created_at, id`,
          [ids],
        );

  // Evidencia y fuente original del Brief: del propio campo de la versión gobernante (inmutable).
  const camposDelBrief = new Map(
    (refsBrief.length === 0 ? [] : await camposDeVersion(revision.governingBriefVersionId)).map((c) => [
      c.id,
      c,
    ]),
  );

  return ok({
    run: revision,
    vigencia,
    untrustedText: true,
    total: revision.findingCount,
    limite,
    desde,
    items: hallazgos.map((h) => ({
      id: h.id,
      analysisRunId: h.analysis_run_id,
      ordinal: h.ordinal,
      category: h.category,
      basis: h.basis,
      severity: h.severity,
      claimStatus: h.claim_status ?? undefined,
      description: h.description,
      createdAt: h.created_at.toISOString(),
      briefRefs: refsBrief
        .filter((r) => r.finding_id === h.id)
        .map((r) => ({
          fieldId: r.brief_field_id,
          fieldKey: r.field_key,
          briefVersionId: r.brief_version_id,
          itemIndex: r.item_index ?? undefined,
          criticidad: r.criticidad,
          valueSnippet: r.value_snippet,
          evidence: (camposDelBrief.get(r.brief_field_id)?.evidencias ?? []).slice(0, 5).map((e) => ({
            quote: e.quote.slice(0, 300),
            relation: e.relation,
            filename: e.filename,
            sourceId: e.sourceId,
            sourceVisibility: e.sourceVisibility,
            locator: e.locator,
          })),
        })),
      scriptRefs: refsGuion
        .filter((r) => r.finding_id === h.id)
        .map((r) => ({
          sourceId: r.source_id,
          fragmentOrdinal: r.fragment_ordinal,
          locator: r.locator ?? undefined,
          quote: r.quote,
          quoteSha256: r.quote_sha256,
        })),
    })),
  });
}

// ─────────────────────────── Revisión humana ───────────────────────────────────

/**
 * Registra que UNA PERSONA revisó el guion contra el Brief rector (`kind='human'`). Es una revisión válida
 * para aprobar (igual que la asistida) pero SIN hallazgos ni modelo: la IA nunca es requisito.
 *
 *  · SOLO canal `ui`: cualquier otro origen (chat, system) ⇒ `HUMAN_CONFIRMATION_REQUIRED`. Evita que el
 *    agente fabrique una «revisión humana». El actor es una persona con `script:manage`.
 *  · Exige Brief rector (`BRIEF_NOT_APPROVED`). Guarda su huella de contenido y el hash de la fuente: si el
 *    rector cambia, la revisión queda STALE (se deriva en lectura).
 *  · `huellaVista` (opcional): la huella del Brief que la persona vio (`huellaDeBriefRector`); si el Brief
 *    cambió mientras tanto ⇒ `RESOURCE_CONFLICT{reason:'view_stale'}`.
 *  · Versión en received|in_review|approved; `received → in_review` en la misma transacción.
 *  · Idempotente por (versión, Brief rector, persona): repetirla devuelve la misma (`reused`). Otra persona
 *    sí añade la suya. Las notas son inmutables: repetir con otra nota no la cambia.
 */
export async function registrarRevisionHumana(
  actor: User,
  versionId: string,
  input: {
    readonly nota?: string | undefined;
    readonly huellaVista?: string | undefined;
    readonly alcance?: { readonly campaignId: string } | undefined;
  } = {},
  contexto?: ContextoDeAuditoria,
): Promise<Result<RevisionHumanaRegistrada>> {
  if (contexto?.origin !== undefined && contexto.origin !== 'ui') {
    return err({
      code: 'HUMAN_CONFIRMATION_REQUIRED',
      message:
        'La revisión humana la registra una persona desde la interfaz: ni el chat ni el sistema pueden hacerlo.',
      details: { origen: contexto.origin },
    });
  }
  const persona = exigirPersona(actor, contexto);
  if (!persona.ok) return persona;

  const nota = input.nota === undefined || input.nota.trim() === '' ? undefined : input.nota.trim();
  if (nota !== undefined && nota.length > 1000) {
    return err({
      code: 'VALIDATION_FAILED',
      message: 'La nota de la revisión no puede superar 1000 caracteres.',
      details: { field: 'nota' },
    });
  }

  const a = await versionAutorizada(actor, versionId, ['script:manage', 'brief:read'], input.alcance);
  if (!a.ok) return a;
  const { fila } = a.value;
  if (!ESTADOS_REVISABLES.includes(fila.status)) return errorDeEstado(fila.status);
  const rector = await leerRector(getPool(), fila.campaign_id, fila.organization_id);
  if (rector === undefined) return sinRector(await estadoDelUltimoBrief(getPool(), fila.campaign_id));

  const huella = huellaDe(await cargarInsumos(getPool(), fila, rector), rector);
  if (input.huellaVista !== undefined && input.huellaVista !== huella.fingerprint) {
    return err({
      code: 'RESOURCE_CONFLICT',
      message:
        'El Brief aprobado cambió desde que se mostró la pantalla: vuelva a cargarla antes de registrar la revisión.',
      details: { reason: 'view_stale' },
    });
  }

  return comoResultado(async () => {
    const r = await transaccionConResultado(
      async (client): Promise<RevisionHumanaRegistrada> => {
        const entregable = await bloquearEntregable(client, fila.deliverable_id);
        if (entregable === undefined) throw new Abortar(NO_ENCONTRADO_DE_CONTENIDO);
        const { rows: v } = await client.query<{ status: ScriptVersionStatus }>(
          `SELECT status FROM script_versions WHERE id = $1 FOR UPDATE`,
          [fila.id],
        );
        const estado = v[0]?.status;
        if (estado === undefined) throw new Abortar(NO_ENCONTRADO_DE_CONTENIDO);
        if (!ESTADOS_REVISABLES.includes(estado)) {
          throw new Abortar(payloadDeEstado(estado));
        }
        await exigirActivos(client, { ...fila, deliverable_status: entregable.status });

        const { rows: previas } = await client.query<{ id: string }>(
          `SELECT id FROM content_analysis_runs
            WHERE script_version_id = $1 AND kind = 'human' AND governing_brief_version_id = $2 AND created_by = $3`,
          [fila.id, rector.versionId, actor.id],
        );
        if (previas[0] !== undefined) {
          const existente = await leerRevision(client, previas[0].id, rector.versionId);
          return { run: existente!, reused: true };
        }

        if (estado === 'received') {
          const inicio = await iniciarRevisionDeVersionEnTransaccion(
            client,
            actor,
            fila.id,
            contexto,
            input.alcance,
          );
          if (!inicio.ok) throw new Abortar(inicio.error);
        }
        const { rows } = await conReglasDeBase(() =>
          client.query<{ id: string }>(
            `INSERT INTO content_analysis_runs
               (organization_id, campaign_id, kind, script_version_id, deliverable_id, campaign_influencer_id,
                governing_brief_version_id, brief_fingerprint, script_source_id, script_source_hash, status,
                finding_count, note, created_by)
             VALUES ($1, $2, 'human', $3, $4, $5, $6, $7, $8, $9, 'succeeded', 0, $10, $11)
             RETURNING id`,
            [
              fila.organization_id,
              fila.campaign_id,
              fila.id,
              fila.deliverable_id,
              fila.campaign_influencer_id,
              rector.versionId,
              huella.fingerprint,
              fila.source_document_id,
              fila.source_hash,
              nota ?? null,
              actor.id,
            ],
          ),
        );
        const runId = rows[0]!.id;
        await recordAudit(
          client,
          auditoriaDe(actor, contexto, {
            action: 'script_review.human',
            entityType: 'content_analysis_run',
            entityId: runId,
            metadata: {
              campaignId: fila.campaign_id,
              scriptVersionId: fila.id,
              version: fila.version,
              governingBriefVersionId: rector.versionId,
              briefNumber: rector.number,
              briefFingerprint: huella.fingerprint,
              scriptSourceHash: fila.source_hash,
              hasNote: nota !== undefined,
            },
          }),
        );
        return { run: (await leerRevision(client, runId, rector.versionId))!, reused: false };
      },
      {
        code: 'RESOURCE_CONFLICT',
        message: 'La revisión cambió mientras se registraba: reintente.',
        details: { reason: 'concurrent_update' },
      },
    );
    return r;
  });
}

// ─────────────────────────── Análisis asistido ─────────────────────────────────

function proveedorDelEntorno(env: LectorDeEntorno): { provider: string; model: string } {
  const modelo = (env('AI_MODEL_EQUILIBRADO') ?? '').trim();
  return {
    provider: (env('AI_PROVIDER') ?? '').trim().toLowerCase() === 'fake' ? 'fake' : 'openrouter',
    model: modelo === '' ? 'desconocido' : modelo.slice(0, 200),
  };
}

function fallo(failureCode: string, runId: string, extra: Record<string, unknown> = {}): Result<never> {
  return err({
    code: 'AI_ANALYSIS_FAILED',
    message: MENSAJE_DE_FALLO,
    details: { failureCode, runId, ...extra },
  });
}

function correlacionDelSistema(contexto: ContextoDeAuditoria | undefined) {
  const c = contexto?.correlation;
  if (c === undefined) return undefined;
  // `toolInvocationId` solo se registra con origen chat; los eventos del sistema llevan el resto.
  return {
    conversationId: c.conversationId,
    messageId: c.messageId,
    agentRunId: c.agentRunId,
    proposedActionId: c.proposedActionId,
  };
}

interface DatosDeLlamada {
  readonly organizationId: string;
  readonly campaignId: string;
  readonly briefVersionId: string;
  readonly runId: string;
  readonly inputHash: string;
  readonly provider: string;
  readonly model: string;
  readonly tier: string;
}

/**
 * Una fila de `ai_runs` POR LLAMADA al proveedor (también en fallos). Nunca el prompt, la respuesta ni el
 * razonamiento: hashes y cifras. Las cifras raras del proveedor se normalizan (QA-06) y la anomalía queda
 * en `error`; un fallo de la inserción NO tumba el análisis.
 */
async function registrarLlamadasEnLedger(
  client: pg.PoolClient,
  d: DatosDeLlamada,
  llamadas: readonly LlamadaDelWorker[],
  opciones: { readonly ultimaInvalida: boolean; readonly codigoDeFallo?: string | undefined },
): Promise<void> {
  for (const [i, c] of llamadas.entries()) {
    const esUltima = i === llamadas.length - 1;
    const estado =
      c.outcome === 'error'
        ? 'error'
        : c.outcome === 'ok' && !(esUltima && opciones.ultimaInvalida)
          ? 'ok'
          : 'invalido';
    const cifras = normalizarCifrasDeLlamada({
      latencyMs: c.latency_ms,
      promptTokens: c.usage?.prompt_tokens,
      completionTokens: c.usage?.completion_tokens,
      costUsd: c.usage?.cost_usd ?? undefined,
    });
    const motivo =
      estado === 'error'
        ? ((esUltima ? opciones.codigoDeFallo : undefined) ?? 'MODEL_CALL_ERROR')
        : estado === 'invalido'
          ? 'ANALYSIS_INVALID_OUTPUT'
          : undefined;
    const anomalia =
      cifras.anomalias.length > 0
        ? `cifras del proveedor acotadas: ${cifras.anomalias.join(', ')}`
        : undefined;
    const errorTexto = sanitizarMensajeDeError([motivo, anomalia].filter(Boolean).join(' · ')) ?? null;
    await client.query(
      `INSERT INTO ai_runs
         (organization_id, campaign_id, brief_version_id, task, tier, provider, model, prompt_version, input_hash,
          output_status, latency_ms, prompt_tokens, completion_tokens, cost_usd, generation_id, error,
          content_analysis_run_id)
       VALUES ($1, $2, $3, 'analizar_guion', $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
      [
        d.organizationId,
        d.campaignId,
        d.briefVersionId,
        d.tier.slice(0, 50),
        d.provider.slice(0, 100),
        d.model.slice(0, 200),
        ANALYSIS_PROMPT_VERSION,
        d.inputHash.slice(0, 128),
        estado,
        cifras.latencyMs,
        cifras.promptTokens,
        cifras.completionTokens,
        cifras.costUsd,
        c.generation_id === null ? null : c.generation_id.slice(0, 200),
        errorTexto,
        d.runId,
      ],
    );
  }
}

interface ContextoDeEjecucion {
  readonly fila: FilaDeVersionParaRevision;
  readonly rector: BriefRector;
  readonly runId: string;
  readonly inputHash: string;
  readonly env: LectorDeEntorno;
  readonly contexto: ContextoDeAuditoria | undefined;
}

/**
 * Cierra un run como `failed` (UNA transacción: ledger + estado + auditoría). Devuelve el código EFECTIVO:
 * si otro proceso ya lo había cerrado (p. ej. barrido como abandonado) conserva el de la base.
 */
async function cerrarConFallo(
  e: ContextoDeEjecucion,
  f: {
    readonly failureCode: string;
    readonly detail: Record<string, unknown>;
    readonly llamadas: readonly LlamadaDelWorker[];
    readonly ultimaInvalida: boolean;
    readonly provider?: string | undefined;
    readonly model?: string | undefined;
    readonly tier?: string | undefined;
  },
): Promise<string> {
  const entorno = proveedorDelEntorno(e.env);
  try {
    return await transaction(async (client) => {
      await bloquearEntregable(client, e.fila.deliverable_id);
      await registrarLlamadasEnLedger(
        client,
        {
          organizationId: e.fila.organization_id,
          campaignId: e.fila.campaign_id,
          briefVersionId: e.rector.versionId,
          runId: e.runId,
          inputHash: e.inputHash,
          provider: f.provider ?? entorno.provider,
          model: f.model ?? entorno.model,
          tier: f.tier ?? 'equilibrado',
        },
        f.llamadas,
        { ultimaInvalida: f.ultimaInvalida, codigoDeFallo: f.failureCode },
      );
      const { rows } = await client.query<{ id: string }>(
        `UPDATE content_analysis_runs
            SET status = 'failed', failure_code = $2, failure_detail = $3::jsonb, finished_at = now(),
                provider = COALESCE($4, provider), model = COALESCE($5, model)
          WHERE id = $1 AND status IN ('queued', 'running')
          RETURNING id`,
        [e.runId, f.failureCode, JSON.stringify(f.detail), f.provider ?? null, f.model ?? null],
      );
      if (rows[0] === undefined) {
        const { rows: actual } = await client.query<{ failure_code: string | null }>(
          `SELECT failure_code FROM content_analysis_runs WHERE id = $1`,
          [e.runId],
        );
        return actual[0]?.failure_code ?? f.failureCode;
      }
      await recordAudit(client, {
        actor: 'system',
        organizationId: e.fila.organization_id,
        action: 'script_analysis.fail',
        entityType: 'content_analysis_run',
        entityId: e.runId,
        metadata: {
          campaignId: e.fila.campaign_id,
          scriptVersionId: e.fila.id,
          failureCode: f.failureCode,
          aiCalls: f.llamadas.length,
        },
        correlation: correlacionDelSistema(e.contexto),
      });
      return f.failureCode;
    });
  } catch {
    // El run queda `running` hasta que lo barra el plazo: nada se pierde ni se inventa.
    return f.failureCode;
  }
}

type Reclamo =
  | { readonly kind: 'ejecutar'; readonly warnings: readonly string[] }
  | { readonly kind: 'existente'; readonly runId: string; readonly outcome: 'reused_current' | 'replayed' };

/**
 * Pide un análisis asistido de UNA versión de guion contra el Brief rector.
 *
 * Orden: autorización (`script:manage` + `brief:read`) → kill-switch y prontitud (`AI_DISABLED`,
 * `BRIEF_NOT_APPROVED`, fuente lista, tamaño) SIN run ni gasto → ensamblado del contexto (sobres no
 * confiables; el guion NUNCA se recorta) → reclamo del run con idempotencia (una transacción corta) →
 * llamada al worker FUERA de transacción (un reintento de transporte) → validación estricta todo-o-nada →
 * UNA transacción que persiste hallazgos, referencias, ledger y auditoría y cierra el run.
 *
 *  · `mode:'ensure'`: si ya hay un análisis `ai_assisted` CURRENT con los mismos insumos (hash del guion,
 *    huella del Brief, versión de prompt) lo devuelve sin llamar al modelo. `reanalyze`: run NUEVO.
 *  · Misma `idempotencyKey` + mismo pedido ⇒ el mismo run (sin nueva llamada); con otro pedido ⇒
 *    `RESOURCE_CONFLICT{reason:'idempotency_key_reuse'}`; con un run en curso ⇒ `analysis_in_progress`.
 *  · Una versión en `received` pasa a `in_review`. Una aprobada se puede analizar (no se transiciona).
 *  · Fallo del modelo o salida inválida ⇒ `AI_ANALYSIS_FAILED{failureCode}` con run `failed` y CERO
 *    hallazgos. La IA nunca es requisito: siempre queda la revisión humana.
 */
export async function solicitarAnalisisDeGuion(
  actor: User,
  versionId: string,
  input: SolicitudDeAnalisis,
  contexto?: ContextoDeAuditoria,
  deps: DependenciasDeAnalisis = {},
): Promise<Result<AnalisisSolicitado>> {
  const persona = exigirPersona(actor, contexto);
  if (!persona.ok) return persona;
  if (input.mode !== 'ensure' && input.mode !== 'reanalyze') {
    return err({
      code: 'VALIDATION_FAILED',
      message: 'El modo del análisis no es válido.',
      details: { field: 'mode' },
    });
  }
  if (!CLAVE_DE_IDEMPOTENCIA.test(input.idempotencyKey)) {
    return err({
      code: 'VALIDATION_FAILED',
      message: 'La clave de idempotencia debe tener entre 8 y 200 caracteres (letras, números y _.:-).',
      details: { field: 'idempotencyKey' },
    });
  }
  const a = await versionAutorizada(actor, versionId, ['script:manage', 'brief:read'], input.alcance);
  if (!a.ok) return a;
  const { fila } = a.value;
  const env = deps.env ?? entornoDelProceso;
  const ahora = deps.ahora ?? (() => new Date());

  if (!ESTADOS_REVISABLES.includes(fila.status)) return errorDeEstado(fila.status);
  const activos = await comoResultado(async () => {
    await exigirActivos(getPool(), fila);
    return ok(true as const);
  });
  if (!activos.ok) return activos;

  // ── Prontitud (sin run, sin gasto) ──
  const rector = await leerRector(getPool(), fila.campaign_id, fila.organization_id);
  const fuente = await getSource(actor, fila.source_document_id);
  if (!fuente.ok) return err(NO_ENCONTRADO_DE_CONTENIDO);
  const entradaDeFuente = {
    origin: fuente.value.origin,
    status: fuente.value.status,
    confidentialityLevel: fuente.value.confidentiality_level,
    fragmentCount: fuente.value.fragmentos,
    jobStatus: fuente.value.job_status,
    provider: fuente.value.external_provider,
  };
  const base = { iaActiva: iaActiva(env), hayBriefRector: rector !== undefined, fuente: entradaDeFuente };
  const primera = evaluarProntitudPura(base);
  if (primera === 'no_governing_brief') {
    return sinRector(await estadoDelUltimoBrief(getPool(), fila.campaign_id));
  }
  if (primera !== 'ready') return errorDeProntitudDeAnalisis(primera) as Result<never>;
  if (rector === undefined) return sinRector(undefined);

  const fragmentos = await getFragments(actor, fila.source_document_id, MAX_FRAGMENTOS_DE_GUION + 1);
  if (!fragmentos.ok) return err(NO_ENCONTRADO_DE_CONTENIDO);
  const conTexto = fragmentos.value.filter((f) => f.text.trim() !== '');
  const chars = conTexto.reduce((s, f) => s + f.text.length, 0);
  const segunda =
    fragmentos.value.length > MAX_FRAGMENTOS_DE_GUION
      ? 'script_too_large'
      : evaluarProntitudPura({ ...base, scriptChars: chars });
  if (segunda !== 'ready') return errorDeProntitudDeAnalisis(segunda, chars) as Result<never>;

  const secreto = secretoDelNonce(env);
  if (secreto === undefined) {
    return err({
      code: 'AI_ANALYSIS_FAILED',
      message: MENSAJE_DE_FALLO,
      details: { failureCode: 'ANALYSIS_INTERNAL_ERROR', reason: 'nonce_secret_missing' },
    });
  }

  // ── Contexto del analizador (sobres no confiables; guion completo, nunca recortado) ──
  const insumos = await cargarInsumos(getPool(), fila, rector);
  const runId = randomUUID();
  const ctx = construirContextoDeAnalisis({
    nonce: derivarNonce(secreto, runId),
    briefVersion: { id: rector.versionId, number: rector.number, approvedAt: rector.approvedAt },
    requisitos: insumos.requisitos,
    fragmentos: conTexto.map((f) => ({
      ordinal: f.ordinal,
      texto: f.text,
      ...(f.locator === undefined ? {} : { locator: f.locator }),
      fragmentId: f.id,
    })),
    productosEnAlcance: insumos.productos,
    productScope: insumos.productScope,
    datos: { influencerNombre: fila.display_name, entregable: fila.deliverable_label },
  });
  if (!ctx.ok) return ctx;
  const contextoDeAnalisis = ctx.value;
  const requestHash = sha256Hex(`analisis-guion:${fila.id}:${input.mode}`);
  const warnings: string[] = [];
  if (insumos.productScope === 'all_campaign') warnings.push('product_scope_all_campaign');
  if (contextoDeAnalisis.manifest.counts.truncated > 0) warnings.push('brief_units_truncated');

  // ── Reclamo del run (transacción corta, serializada por el mutex del entregable) ──
  const reclamo = await comoResultado(async () =>
    transaccionConResultado(
      async (client): Promise<Reclamo> => {
        const entregable = await bloquearEntregable(client, fila.deliverable_id);
        if (entregable === undefined) throw new Abortar(NO_ENCONTRADO_DE_CONTENIDO);
        const { rows: v } = await client.query<{ status: ScriptVersionStatus }>(
          `SELECT status FROM script_versions WHERE id = $1 FOR UPDATE`,
          [fila.id],
        );
        const estado = v[0]?.status;
        if (estado === undefined) throw new Abortar(NO_ENCONTRADO_DE_CONTENIDO);
        if (!ESTADOS_REVISABLES.includes(estado)) {
          throw new Abortar(payloadDeEstado(estado));
        }
        await exigirActivos(client, { ...fila, deliverable_status: entregable.status });

        // Barrido perezoso: un análisis en curso con el plazo vencido pasa a `failed`/ANALYSIS_ABANDONED.
        const { rows: barridos } = await client.query<{ id: string }>(
          `UPDATE content_analysis_runs
              SET status = 'failed', failure_code = 'ANALYSIS_ABANDONED',
                  failure_detail = '{"reason":"lease_expired"}'::jsonb, finished_at = now()
            WHERE script_version_id = $1 AND kind = 'ai_assisted' AND status IN ('queued', 'running')
              AND lease_expires_at < now()
            RETURNING id`,
          [fila.id],
        );
        for (const b of barridos) {
          await recordAudit(client, {
            actor: 'system',
            organizationId: fila.organization_id,
            action: 'script_analysis.fail',
            entityType: 'content_analysis_run',
            entityId: b.id,
            metadata: { campaignId: fila.campaign_id, scriptVersionId: fila.id, failureCode: ABANDONADO },
          });
        }

        // Idempotencia: la misma clave es el mismo pedido.
        const { rows: previos } = await client.query<{
          id: string;
          request_hash: string;
          status: EstadoDeRevision;
        }>(
          `SELECT id, request_hash, status FROM content_analysis_runs
            WHERE organization_id = $1 AND script_version_id = $2 AND idempotency_key = $3`,
          [fila.organization_id, fila.id, input.idempotencyKey],
        );
        const previo = previos[0];
        if (previo !== undefined) {
          if (previo.request_hash !== requestHash) {
            throw new Abortar({
              code: 'RESOURCE_CONFLICT',
              message: 'Esa clave de idempotencia ya se usó para otro pedido.',
              details: { reason: 'idempotency_key_reuse' },
            });
          }
          if (previo.status === 'queued' || previo.status === 'running') {
            throw new Abortar({
              code: 'RESOURCE_CONFLICT',
              message: 'Ya hay un análisis en curso para esta versión.',
              details: { reason: 'analysis_in_progress', runId: previo.id },
            });
          }
          return { kind: 'existente', runId: previo.id, outcome: 'replayed' };
        }

        if (input.mode === 'ensure') {
          const { rows: vigentes } = await client.query<{ id: string }>(
            `SELECT id FROM content_analysis_runs
              WHERE script_version_id = $1 AND kind = 'ai_assisted' AND status = 'succeeded'
                AND governing_brief_version_id = $2 AND brief_fingerprint = $3 AND script_source_hash = $4
                AND prompt_version = $5 AND context_version = $6
              ORDER BY finished_at DESC, created_at DESC LIMIT 1`,
            [
              fila.id,
              rector.versionId,
              contextoDeAnalisis.briefFingerprint,
              fila.source_hash,
              ANALYSIS_PROMPT_VERSION,
              CONTEXT_VERSION,
            ],
          );
          if (vigentes[0] !== undefined) {
            return { kind: 'existente', runId: vigentes[0].id, outcome: 'reused_current' };
          }
        }

        const { rows: activo } = await client.query<{ id: string }>(
          `SELECT id FROM content_analysis_runs
            WHERE script_version_id = $1 AND kind = 'ai_assisted' AND status IN ('queued', 'running')`,
          [fila.id],
        );
        if (activo[0] !== undefined) {
          throw new Abortar({
            code: 'RESOURCE_CONFLICT',
            message: 'Ya hay un análisis en curso para esta versión.',
            details: { reason: 'analysis_in_progress', runId: activo[0].id },
          });
        }
        const { rows: total } = await client.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM content_analysis_runs WHERE script_version_id = $1 AND kind = 'ai_assisted'`,
          [fila.id],
        );
        if ((total[0]?.n ?? 0) >= LIMITE_DE_ANALISIS_POR_VERSION) {
          throw new Abortar({
            code: 'RESOURCE_CONFLICT',
            message: `Esta versión ya agotó sus ${LIMITE_DE_ANALISIS_POR_VERSION} análisis asistidos; revise a mano o registre una versión nueva.`,
            details: { reason: 'reanalysis_limit', limit: LIMITE_DE_ANALISIS_POR_VERSION },
          });
        }

        if (estado === 'received') {
          const inicio = await iniciarRevisionDeVersionEnTransaccion(
            client,
            actor,
            fila.id,
            contexto,
            input.alcance,
          );
          if (!inicio.ok) throw new Abortar(inicio.error);
        }

        const vence = new Date(ahora().getTime() + (deps.plazoMs ?? PLAZO_DE_ANALISIS_MS));
        await conReglasDeBase(() =>
          client.query(
            `INSERT INTO content_analysis_runs
               (id, organization_id, campaign_id, kind, script_version_id, deliverable_id, campaign_influencer_id,
                governing_brief_version_id, brief_fingerprint, script_source_id, script_source_hash,
                script_text_hash, script_chars, fragment_count, product_scope, context_manifest,
                prompt_version, output_schema_version, context_version, severity_policy_version, model_tier,
                status, idempotency_key, request_hash, mode, created_by, lease_expires_at)
             VALUES ($1, $2, $3, 'ai_assisted', $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15::jsonb,
                     $16, $17, $18, $19, 'equilibrado', 'running', $20, $21, $22, $23, $24)`,
            [
              runId,
              fila.organization_id,
              fila.campaign_id,
              fila.id,
              fila.deliverable_id,
              fila.campaign_influencer_id,
              rector.versionId,
              contextoDeAnalisis.briefFingerprint,
              fila.source_document_id,
              fila.source_hash,
              contextoDeAnalisis.scriptTextHash,
              contextoDeAnalisis.scriptChars,
              contextoDeAnalisis.manifest.counts.fragments,
              insumos.productScope,
              JSON.stringify(contextoDeAnalisis.manifest),
              ANALYSIS_PROMPT_VERSION,
              OUTPUT_SCHEMA_VERSION,
              CONTEXT_VERSION,
              SEVERITY_POLICY_VERSION,
              input.idempotencyKey,
              requestHash,
              input.mode,
              actor.id,
              vence.toISOString(),
            ],
          ),
        );
        await recordAudit(
          client,
          auditoriaDe(actor, contexto, {
            action: 'script_analysis.request',
            entityType: 'content_analysis_run',
            entityId: runId,
            metadata: {
              campaignId: fila.campaign_id,
              scriptVersionId: fila.id,
              version: fila.version,
              deliverableId: fila.deliverable_id,
              governingBriefVersionId: rector.versionId,
              briefNumber: rector.number,
              mode: input.mode,
              promptVersion: ANALYSIS_PROMPT_VERSION,
              productScope: insumos.productScope,
            },
          }),
        );
        return { kind: 'ejecutar', warnings };
      },
      {
        code: 'RESOURCE_CONFLICT',
        message: 'Ya hay un análisis en curso para esta versión.',
        details: { reason: 'analysis_in_progress' },
      },
    ),
  );
  if (!reclamo.ok) return reclamo;

  if (reclamo.value.kind === 'existente') {
    const existente = await leerRevision(getPool(), reclamo.value.runId, rector.versionId);
    if (existente === undefined) return err(NO_ENCONTRADO_DE_CONTENIDO);
    if (existente.status === 'failed') {
      return fallo(existente.failureCode ?? 'ANALYSIS_INTERNAL_ERROR', existente.id, { replayed: true });
    }
    return ok({ outcome: reclamo.value.outcome, run: existente, warnings });
  }

  // ── Llamada al worker, FUERA de toda transacción ──
  const e: ContextoDeEjecucion = {
    fila,
    rector,
    runId,
    inputHash: contextoDeAnalisis.inputHash,
    env,
    contexto,
  };
  const cliente = deps.cliente ?? crearClienteDeAnalisisHttp({ env });
  const peticion = construirPeticionDeAnalisis(contextoDeAnalisis, { analysisRunId: runId });
  const llamadas: LlamadaDelWorker[] = [];
  let intentos = 0;
  let resultado: ResultadoDeLlamada;
  for (;;) {
    intentos += 1;
    try {
      resultado = await cliente.analizar(peticion);
    } catch {
      resultado = {
        ok: false,
        fallo: { code: 'WORKER_UNREACHABLE', retryable: true, retryAfterS: null, calls: [] },
      };
    }
    llamadas.push(...(resultado.ok ? resultado.respuesta.calls : resultado.fallo.calls));
    if (
      !resultado.ok &&
      intentos === 1 &&
      esFalloReintentablePorNode(codigoDeFalloDeAnalisis(resultado.fallo.code))
    ) {
      const espera = Math.min((resultado.fallo.retryAfterS ?? 1) * 1_000, 5_000);
      await (deps.esperar ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms))))(espera);
      continue;
    }
    break;
  }

  if (!resultado.ok) {
    const f: FalloDelModelo = resultado.fallo;
    const code = await cerrarConFallo(e, {
      failureCode: codigoDeFalloDeAnalisis(f.code),
      detail: {
        workerCode: f.code,
        attempts: intentos,
        aiCalls: llamadas.length,
        ...(f.httpStatus === undefined ? {} : { httpStatus: f.httpStatus }),
        ...(f.reason === undefined ? {} : { reason: f.reason }),
      },
      llamadas,
      ultimaInvalida: codigoDeFalloDeAnalisis(f.code) === 'ANALYSIS_INVALID_OUTPUT',
    });
    return fallo(code, runId);
  }

  const respuesta = resultado.respuesta;
  const llamadasDeLaRespuesta = llamadas.length > 0 ? llamadas : sintetizarLlamada(respuesta);
  const validada = validarSalidaDeAnalisis(respuesta.output, {
    requisitos: contextoDeAnalisis.requisitos,
    fragmentos: contextoDeAnalisis.fragmentos,
    productosEnAlcance: insumos.productos.map((p) => p.id),
  });
  if (!validada.ok) {
    const detalles = (validada.error.details ?? {}) as Record<string, unknown>;
    const code = await cerrarConFallo(e, {
      failureCode: 'ANALYSIS_INVALID_OUTPUT',
      detail: {
        attempts: intentos,
        aiCalls: llamadasDeLaRespuesta.length,
        reasonCount: detalles['reasonCount'] ?? 0,
        reasons: detalles['reasons'] ?? [],
      },
      llamadas: llamadasDeLaRespuesta,
      ultimaInvalida: true,
      provider: respuesta.provider,
      model: respuesta.model,
      tier: respuesta.tier,
    });
    return fallo(code, runId);
  }

  // ── Persistencia: UNA transacción, todo-o-nada ──
  const analisis = validada.value;
  try {
    await transaction(async (client) => {
      await bloquearEntregable(client, fila.deliverable_id);
      await registrarLlamadasEnLedger(
        client,
        {
          organizationId: fila.organization_id,
          campaignId: fila.campaign_id,
          briefVersionId: rector.versionId,
          runId,
          inputHash: contextoDeAnalisis.inputHash,
          provider: respuesta.provider,
          model: respuesta.model,
          tier: respuesta.tier,
        },
        llamadasDeLaRespuesta,
        { ultimaInvalida: false },
      );
      for (const h of analisis.findings) {
        const { rows } = await client.query<{ id: string }>(
          `INSERT INTO content_findings
             (organization_id, campaign_id, script_version_id, analysis_run_id, ordinal, model_position,
              category, basis, severity, claim_status, description)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
          [
            fila.organization_id,
            fila.campaign_id,
            fila.id,
            runId,
            h.ordinal,
            h.modelPosition,
            h.category,
            h.basis,
            h.severity,
            h.claimStatus,
            h.description,
          ],
        );
        const findingId = rows[0]!.id;
        for (const r of h.briefRefs) {
          if (r.fieldId === undefined) throw new Error('referencia al Brief sin campo');
          await client.query(
            `INSERT INTO content_finding_brief_refs
               (organization_id, finding_id, brief_field_id, brief_version_id, item_index, field_key, criticidad, value_snippet)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
            [
              fila.organization_id,
              findingId,
              r.fieldId,
              rector.versionId,
              r.itemIndex ?? null,
              r.campo,
              r.criticidad,
              r.valueSnippet,
            ],
          );
        }
        for (const r of h.scriptRefs) {
          await client.query(
            `INSERT INTO content_finding_script_refs
               (organization_id, finding_id, source_id, fragment_ordinal, fragment_id, locator, quote, quote_sha256,
                fragment_text_hash)
             VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9)`,
            [
              fila.organization_id,
              findingId,
              fila.source_document_id,
              r.ordinal,
              r.fragmentId ?? null,
              r.locator === undefined ? null : JSON.stringify(r.locator),
              r.quote,
              r.quoteSha256,
              r.fragmentTextHash,
            ],
          );
        }
      }
      const { rows: cerrado } = await client.query<{ id: string }>(
        `UPDATE content_analysis_runs
            SET status = 'succeeded', provider = $2, model = $3, finding_count = $4, finished_at = now()
          WHERE id = $1 AND status = 'running'
          RETURNING id`,
        [runId, respuesta.provider.slice(0, 100), respuesta.model.slice(0, 200), analisis.findings.length],
      );
      if (cerrado[0] === undefined) throw new Error('el análisis ya no estaba en curso');
      await recordAudit(client, {
        actor: 'system',
        organizationId: fila.organization_id,
        action: 'script_analysis.complete',
        entityType: 'content_analysis_run',
        entityId: runId,
        metadata: {
          campaignId: fila.campaign_id,
          scriptVersionId: fila.id,
          kind: 'ai_assisted',
          governingBriefVersionId: rector.versionId,
          findingCount: analisis.findings.length,
          duplicatesCollapsed: analisis.duplicatesCollapsed,
          aiCalls: llamadasDeLaRespuesta.length,
          provider: respuesta.provider,
          model: respuesta.model,
        },
        correlation: correlacionDelSistema(contexto),
      });
    });
  } catch {
    // Todo se revirtió (cero hallazgos). Se registra el fallo y el costo en otra transacción.
    const code = await cerrarConFallo(e, {
      failureCode: 'ANALYSIS_INTERNAL_ERROR',
      detail: { attempts: intentos, aiCalls: llamadasDeLaRespuesta.length, reason: 'persist_failed' },
      llamadas: llamadasDeLaRespuesta,
      ultimaInvalida: false,
      provider: respuesta.provider,
      model: respuesta.model,
      tier: respuesta.tier,
    });
    return fallo(code, runId);
  }

  const run = await leerRevision(getPool(), runId, rector.versionId);
  if (run === undefined) return err(NO_ENCONTRADO_DE_CONTENIDO);
  if (analisis.duplicatesCollapsed > 0) warnings.push('duplicates_collapsed');
  return ok({ outcome: 'created', run, warnings });
}

/** Un worker que no informó `calls` (no debería): una llamada sintética con el uso agregado. */
function sintetizarLlamada(r: {
  usage: { promptTokens: number; completionTokens: number; totalTokens: number; costUsd: number | null };
  latencyMs: number;
  generationId: string | null;
}): LlamadaDelWorker[] {
  return [
    {
      usage: {
        prompt_tokens: r.usage.promptTokens,
        completion_tokens: r.usage.completionTokens,
        total_tokens: r.usage.totalTokens,
        cost_usd: r.usage.costUsd,
      },
      latency_ms: r.latencyMs,
      generation_id: r.generationId,
      outcome: 'ok',
    },
  ];
}

// ─────────────────────────── Resumen por versión (contexto del agente) ─────────

/**
 * Lo que el contexto del agente necesita saber de la ÚLTIMA versión de cada entregable: vigencia de su
 * revisión, hallazgos por severidad (cifras; nunca el texto), cambios pedidos y si hay una propuesta de
 * aprobación abierta. Solo cifras y estados.
 */
export interface ResumenDeContenidoDeVersion {
  readonly versionId: string;
  readonly vigencia: VigenciaDeRevision;
  readonly kind: TipoDeRevision | null;
  readonly findingsBySeverity: SeveridadesDeHallazgos;
  readonly findingTotal: number;
  /** Comentarios `change_request` registrados sobre esa versión. */
  readonly requestedChanges: number;
  /** Propuesta `script_version.approve` abierta (`pending`/`confirmed`, sin vencer) para esa versión. */
  readonly pendingApproval: boolean;
}

/** Tope de versiones por llamada (un entregable por versión). */
const MAX_VERSIONES_DE_RESUMEN = 200;

/**
 * Resumen de revisión de VARIAS versiones de una campaña en una sola pasada (sin N+1): tres consultas
 * agregadas más el rector. Misma regla de vigencia que `obtenerRevisionVigente` (`elegirVigente`).
 * Exige `script:read` sobre la organización de la campaña; una versión que no sea de la campaña no
 * aparece en el resultado. Aditivo: no cambia ninguna otra función de este módulo.
 */
export async function resumenesDeContenidoDeVersiones(
  actor: User,
  campaignId: string,
  versionIds: readonly string[],
): Promise<Result<ReadonlyMap<string, ResumenDeContenidoDeVersion>>> {
  if (!esUuid(campaignId)) return err(NO_ENCONTRADO_DE_CONTENIDO);
  const { rows: campanas } = await getPool().query<{ organization_id: string }>(
    `SELECT organization_id FROM campaigns WHERE id = $1`,
    [campaignId],
  );
  if (campanas[0] === undefined) return err(NO_ENCONTRADO_DE_CONTENIDO);
  const organizationId = campanas[0].organization_id;
  const permitido = authorizeInternalResource(actor, 'script:read', organizationId);
  if (!permitido.ok) return permitido;

  const ids = [...new Set(versionIds.filter(esUuid))].slice(0, MAX_VERSIONES_DE_RESUMEN);
  const salida = new Map<string, ResumenDeContenidoDeVersion>();
  if (ids.length === 0) return ok(salida);

  const [rector, revisiones, cambios, propuestas] = await Promise.all([
    leerRector(getPool(), campaignId, organizationId),
    getPool().query<FilaDeRevision>(
      `${SELECT_REVISION}
        WHERE r.script_version_id = ANY($1::uuid[]) AND r.campaign_id = $2 AND r.organization_id = $3
        ORDER BY r.created_at DESC, r.id DESC`,
      [ids, campaignId, organizationId],
    ),
    getPool().query<{ script_version_id: string; n: number }>(
      `SELECT script_version_id, count(*)::int AS n FROM script_review_comments
        WHERE script_version_id = ANY($1::uuid[]) AND campaign_id = $2 AND kind = 'change_request'
        GROUP BY script_version_id`,
      [ids, campaignId],
    ),
    getPool().query<{ resource_id: string }>(
      `SELECT DISTINCT resource_id FROM proposed_actions
        WHERE campaign_id = $2 AND organization_id = $3 AND resource_id = ANY($1::uuid[])
          AND action_type = 'script_version.approve'
          AND status IN ('pending', 'confirmed') AND expires_at > now()`,
      [ids, campaignId, organizationId],
    ),
  ]);

  const porVersion = new Map<string, FilaDeRevision[]>();
  for (const f of revisiones.rows) {
    const lista = porVersion.get(f.script_version_id) ?? [];
    lista.push(f);
    porVersion.set(f.script_version_id, lista);
  }
  const conCambios = new Map(cambios.rows.map((c) => [c.script_version_id, c.n]));
  const conPropuesta = new Set(propuestas.rows.map((p) => p.resource_id));
  // Solo las versiones que pertenecen a la campaña (las demás se descartan sin decir por qué).
  const { rows: propias } = await getPool().query<{ id: string }>(
    `SELECT id FROM script_versions WHERE id = ANY($1::uuid[]) AND campaign_id = $2 AND organization_id = $3`,
    [ids, campaignId, organizationId],
  );
  for (const { id } of propias) {
    const vigente = elegirVigente(porVersion.get(id) ?? [], rector);
    salida.set(id, {
      versionId: id,
      vigencia: vigente.vigencia,
      kind: vigente.kind,
      findingsBySeverity: vigente.findingsBySeverity,
      findingTotal: vigente.findingTotal,
      requestedChanges: conCambios.get(id) ?? 0,
      pendingApproval: conPropuesta.has(id),
    });
  }
  return ok(salida);
}
