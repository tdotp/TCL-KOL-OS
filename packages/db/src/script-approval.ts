/**
 * Aprobación de una versión de guion (V2 · Fase 7).
 *
 * Aprobar un guion es una decisión HUMANA y crítica. Hay UN solo caso de uso de aprobación
 * (`aprobarScriptVersion` / `aprobarScriptVersionEnTransaccion`) y dos formas de llegar a él:
 *
 *   persona (admin/director) ─► botón «Aprobar versión» ─► aprobarScriptVersion ───────────┐
 *   agente ─► script_propose_approval ─► proponerAccion ─► tarjeta ─► persona confirma ─►   │
 *            ejecutarAccion ─► handler `script_version.approve` ─► …EnTransaccion ──────────┘
 *
 * Reglas (decisiones del usuario, vinculantes):
 *  · Aprobar exige una revisión CURRENT (asistida por IA o humana) contra el Brief rector vigente. NO se
 *    exige cero hallazgos: los hallazgos y los comentarios informan, la decisión es de la persona; se
 *    muestran y quedan en el snapshot de lo aprobado.
 *  · Aprueban SOLO `script:approve` (admin y director). Quien tiene `script:manage` propone.
 *  · La IA, el chat y el sistema nunca aprueban: origen distinto de `ui` ⇒ `HUMAN_CONFIRMATION_REQUIRED`;
 *    el chat solo PROPONE y la confirmación es de una persona por la interfaz.
 *  · `huellaVista` es OBLIGATORIA (también en la aprobación directa): la persona aprueba lo que vio. Si algo
 *    relevante cambió entre lo mostrado y la escritura ⇒ `PROPOSAL_STALE{reason:'view_stale'}`.
 *
 * `evaluarAprobacionDeScript` es la ÚNICA fuente de la elegibilidad, el snapshot y la huella: la usan la UI,
 * el handler HITL (proponer, confirmar, ejecutar) y la verificación bajo bloqueo de este mismo caso de uso.
 *
 * Concurrencia. Orden de bloqueo: acción propuesta (si la hay; la toma el executor) → campaña (FOR SHARE) →
 * ENTREGABLE (`bloquearEntregable`, el mutex común de F7) → versión (FOR UPDATE) → Brief rector (FOR SHARE,
 * serializa con `crearVersionHija`). Con ellos tomados se RECALCULA la evaluación y se compara con la huella
 * mostrada: la comprobación y la escritura ven el mismo estado.
 *
 * Orden de escritura (impuesto por los triggers de 023): (1) la fuente de la versión aprobada anterior baja a
 * `interna` si no lo está; (2) las versiones MENORES en received|in_review|approved pasan a `superseded`
 * (ascendente, con la sucesora y su fecha); (3) la versión pasa a `approved` con sus marcas (aprobador,
 * acción propuesta, revisión, Brief, snapshot). El trigger diferido de 023 exige que la sucesora quede
 * aprobada al COMMIT. Auditoría en la misma transacción. NO cambia la visibilidad de la campaña ni expone la
 * fuente a TCL (eso es de la Fase 9).
 */

import type pg from 'pg';
import {
  type AuditCorrelation,
  type AuditOrigin,
  type DomainErrorPayload,
  type Result,
  type ScriptVersionStatus,
  type User,
  authorizeInternalResource,
  err,
  ok,
} from '@tcl-kol-os/domain';
import { recordAudit } from './audit.ts';
import { exigirPersona } from './audit-context.ts';
import { assertCapability } from './authz.ts';
import { getPool } from './client.ts';
import { leerInsumosDeRevisionParaAprobar } from './content-analysis.ts';
import { NO_ENCONTRADO_DE_CONTENIDO, bloquearEntregable, conReglasDeBase, esUuid } from './deliverables.ts';
import { canonico, sha256 } from './proposed-action-handlers.ts';
import { Abortar, transaccionConResultado } from './tx-result.ts';

type Consultor = pg.Pool | pg.PoolClient;

// ─────────────────────────── Tipos públicos ────────────────────────────────────

export interface SeveridadesAbiertas {
  readonly alta: number;
  readonly media: number;
  readonly baja: number;
}

/**
 * Lo que la persona aprueba (cifras e ids; NUNCA texto de documentos). `sha256(canonico(snapshot))` es la
 * huella de la aprobación: si algo de esto cambia entre lo mostrado y lo escrito, la aprobación se rechaza.
 */
export interface SnapshotDeAprobacion {
  readonly scriptVersion: {
    readonly id: string;
    readonly number: number;
    readonly sourceId: string;
    readonly sourceHash: string;
  };
  /** `headVersionId`: la versión de mayor número del entregable (si nace una V(N+1) cambia la huella). */
  readonly deliverable: { readonly id: string; readonly headVersionId: string };
  /** La versión aprobada vigente que esta aprobación reemplazaría (si la hay). */
  readonly replaces: { readonly versionId: string; readonly number: number } | null;
  /** El Brief rector. `null` si no existe (bloqueo `BRIEF_NOT_APPROVED`). */
  readonly brief: {
    readonly versionId: string;
    readonly number: number;
    readonly contentFingerprint: string;
  } | null;
  /** La revisión CURRENT. `null` si no hay (bloqueo `SCRIPT_REVIEW_REQUIRED`). */
  readonly review: {
    readonly id: string;
    readonly kind: 'ai_assisted' | 'human';
    readonly inputHash: string | null;
  } | null;
  /**
   * F7 no tiene triage: «abiertos» = los hallazgos del run de la revisión CURRENT (agrupados por severidad).
   * No bloquean.
   */
  readonly findings: { readonly total: number; readonly openBySeverity: SeveridadesAbiertas };
  /** Comentarios de revisión de la versión (cantidad y huella de sus ids). No bloquean. */
  readonly comments: { readonly total: number; readonly digest: string };
  readonly participation: { readonly campaignInfluencerId: string; readonly status: string };
}

/** Solo para MOSTRAR (no se compara ni entra en la huella). Son nombres de la propia organización. */
export interface EtiquetasDeAprobacion {
  readonly influencer: string;
  readonly deliverable: string;
  readonly product: string | null;
  /** «Brief V2» o `null` si no hay rector. */
  readonly brief: string | null;
  /** Número de la versión más reciente del entregable (para «existe una versión más reciente»). */
  readonly headVersion: number;
  /** Cuándo se hizo la revisión CURRENT (ISO) o `null`. */
  readonly reviewedAt: string | null;
}

export interface EvaluacionDeAprobacion {
  readonly elegible: boolean;
  /** Bloqueos duros, tipificados. El primero es el que se devuelve como error. Vacío ⇒ elegible. */
  readonly bloqueos: readonly DomainErrorPayload[];
  readonly snapshot: SnapshotDeAprobacion;
  /** `sha256(canonico(snapshot))`. */
  readonly huella: string;
  readonly etiquetas: EtiquetasDeAprobacion;
  readonly ubicacion: {
    readonly organizationId: string;
    readonly campaignId: string;
    readonly deliverableId: string;
    readonly versionNumber: number;
    readonly versionStatus: ScriptVersionStatus;
  };
}

export interface OpcionesDeAprobacion {
  /** OBLIGATORIA: la huella de la aprobación tal como se le mostró a la persona. */
  readonly huellaVista: string;
  /** Canal. Solo `ui` aprueba; cualquier otro ⇒ `HUMAN_CONFIRMATION_REQUIRED`. Por defecto `ui` (`system` si el actor es el sistema). */
  readonly origen?: AuditOrigin | undefined;
  /** Con `proposedActionId` la aprobación nace de una propuesta confirmada (la base verifica la acción). */
  readonly correlation?: AuditCorrelation | undefined;
  /** Cerco de campaña: una versión de otra campaña se responde como inexistente. */
  readonly alcance?: { readonly campaignId: string } | undefined;
}

export interface VersionReemplazada {
  readonly versionId: string;
  readonly version: number;
  readonly previousStatus: ScriptVersionStatus;
}

export interface AprobacionDeScript {
  readonly versionId: string;
  readonly deliverableId: string;
  readonly version: number;
  readonly status: 'approved';
  readonly approvedAt: string;
  readonly via: 'direct' | 'proposal';
  readonly fingerprint: string;
  readonly reviewId: string;
  readonly reviewKind: 'ai_assisted' | 'human';
  readonly briefVersionId: string;
  readonly findings: { readonly total: number; readonly openBySeverity: SeveridadesAbiertas };
  readonly comments: { readonly total: number };
  /** La versión aprobada anterior que dejó de ser la vigente, si la había. */
  readonly previousApproved: { readonly versionId: string; readonly version: number } | null;
  /** Todas las versiones que pasaron a `superseded` (la anterior aprobada y las abiertas menores). */
  readonly replaced: readonly VersionReemplazada[];
}

// ─────────────────────────── Evaluación ────────────────────────────────────────

interface FilaDeEvaluacion {
  readonly id: string;
  readonly organization_id: string;
  readonly campaign_id: string;
  readonly deliverable_id: string;
  readonly version: number;
  readonly status: ScriptVersionStatus;
  readonly source_document_id: string;
  readonly source_hash: string;
  /** Hash ACTUAL del original de la fuente (debe coincidir con el recibido: provenance intacta). */
  readonly source_live_hash: string;
  readonly deliverable_status: string;
  readonly deliverable_label: string;
  readonly campaign_influencer_id: string;
  readonly campaign_status: string;
  readonly participation_status: string;
  readonly display_name: string;
  readonly product_label: string | null;
}

const PRODUCTO_DE_ENTREGABLE = `
  (SELECT btrim(p.brand || ' ' || p.model)
     FROM campaign_products cp JOIN products p ON p.id = cp.product_id
    WHERE cp.id = d.campaign_product_id)
`;

async function cargarFila(db: Consultor, versionId: string): Promise<FilaDeEvaluacion | undefined> {
  const { rows } = await db.query<FilaDeEvaluacion>(
    `SELECT sv.id, sv.organization_id, sv.campaign_id, sv.deliverable_id, sv.version, sv.status,
            sv.source_document_id, sv.source_hash, s.hash AS source_live_hash,
            d.status AS deliverable_status, d.label AS deliverable_label, d.campaign_influencer_id,
            c.status::text AS campaign_status, ci.status::text AS participation_status,
            i.display_name, ${PRODUCTO_DE_ENTREGABLE} AS product_label
       FROM script_versions sv
       JOIN source_documents s ON s.id = sv.source_document_id
       JOIN deliverables d ON d.id = sv.deliverable_id
       JOIN campaigns c ON c.id = sv.campaign_id
       JOIN campaign_influencers ci ON ci.id = d.campaign_influencer_id
       JOIN influencers i ON i.id = ci.influencer_id
      WHERE sv.id = $1`,
    [versionId],
  );
  return rows[0];
}

/**
 * Huella del CONTENIDO del Brief rector (campos de la versión lógica ES: clave, producto, revisión, valor y
 * estado). Se calcula con el `db` dado, sin pedir otra conexión (la aprobación corre bajo bloqueos).
 */
async function huellaDeContenidoDelBrief(db: Consultor, briefVersionId: string): Promise<string> {
  const { rows } = await db.query<{
    k: string;
    p: string | null;
    r: number;
    v: string;
    s: string;
    c: string;
  }>(
    `SELECT key AS k, campaign_product_id::text AS p, revision AS r, md5(value::text) AS v,
            status::text AS s, criticidad::text AS c
       FROM brief_fields WHERE brief_version_id = $1
      ORDER BY key, campaign_product_id NULLS FIRST`,
    [briefVersionId],
  );
  return sha256(canonico(rows));
}

const bloqueoDeEstado = (estado: ScriptVersionStatus): DomainErrorPayload => ({
  code: 'SCRIPT_INVALID_TRANSITION',
  message: `Una versión en estado «${estado}» no se puede aprobar: debe estar en revisión.`,
  details: { from: estado, to: 'approved', reason: 'not_in_review' },
});

/**
 * ¿Se puede aprobar esta versión AHORA y con qué huella? Lectura pura con el `db` dado (el pool o el cliente
 * de una transacción), SIN autorizar: quien llama ya lo hizo (el caso de uso, el handler HITL o la lectura
 * autorizada `obtenerEvaluacionDeAprobacion`). No toma bloqueos: el caso de uso los toma antes de llamarla.
 *
 * Bloqueos duros (el primero se devuelve como error): versión en `in_review`; entregable, campaña y
 * participación activos; no aprobar hacia atrás; existe Brief rector (`BRIEF_NOT_APPROVED`); existe una
 * revisión CURRENT contra él (`SCRIPT_REVIEW_REQUIRED{reason:'none'|'stale'|'brief_missing'}`).
 * NO bloquean: cero hallazgos, hallazgos abiertos, comentarios ni una revisión en curso o fallida.
 */
export async function evaluarAprobacionDeScript(
  db: Consultor,
  versionId: string,
): Promise<Result<EvaluacionDeAprobacion>> {
  if (!esUuid(versionId)) return err(NO_ENCONTRADO_DE_CONTENIDO);
  const fila = await cargarFila(db, versionId);
  if (fila === undefined) return err(NO_ENCONTRADO_DE_CONTENIDO);

  const { rows: versiones } = await db.query<{
    id: string;
    version: number;
    status: ScriptVersionStatus;
    aprobada_alguna_vez: boolean;
  }>(
    `SELECT id, version, status, (approved_at IS NOT NULL) AS aprobada_alguna_vez
       FROM script_versions WHERE deliverable_id = $1 ORDER BY version DESC`,
    [fila.deliverable_id],
  );
  const cabeza = versiones[0]!;
  const vigenteActual = versiones.find((v) => v.status === 'approved' && v.id !== fila.id);
  const aprobadaMasNueva = versiones.find((v) => v.aprobada_alguna_vez && v.version > fila.version);

  const { rows: comentarios } = await db.query<{ id: string }>(
    `SELECT id FROM script_review_comments WHERE script_version_id = $1 ORDER BY id`,
    [fila.id],
  );

  const insumos = await leerInsumosDeRevisionParaAprobar(db, fila);
  const rector = insumos.rector;
  const revision = insumos.vigente.vigencia === 'current' ? insumos.vigente.run : null;

  const bloqueos: DomainErrorPayload[] = [];
  if (fila.status !== 'in_review') bloqueos.push(bloqueoDeEstado(fila.status));
  if (fila.deliverable_status !== 'active') {
    bloqueos.push({
      code: 'RESOURCE_CONFLICT',
      message: 'El entregable está archivado: reactívelo para aprobar sus versiones.',
      details: { reason: 'deliverable_archived', deliverableId: fila.deliverable_id },
    });
  }
  if (fila.campaign_status !== 'activa') {
    bloqueos.push({
      code: 'RESOURCE_CONFLICT',
      message: 'La campaña no está activa: no se aprueban guiones.',
      details: { reason: 'campaign_not_active', campaignId: fila.campaign_id },
    });
  }
  if (fila.participation_status !== 'activo') {
    bloqueos.push({
      code: 'RESOURCE_CONFLICT',
      message: 'El influencer está retirado de la campaña: reactívelo para aprobar su contenido.',
      details: { reason: 'campaign_influencer_retired', campaignInfluencerId: fila.campaign_influencer_id },
    });
  }
  if (fila.source_live_hash !== fila.source_hash) {
    bloqueos.push({
      code: 'RESOURCE_CONFLICT',
      message: 'El original del guion cambió desde que se recibió la versión: no se aprueba.',
      details: { reason: 'source_changed', sourceId: fila.source_document_id },
    });
  }
  if (aprobadaMasNueva !== undefined) {
    bloqueos.push({
      code: 'SCRIPT_INVALID_TRANSITION',
      message: 'Ya hay una versión más nueva aprobada: no se aprueba hacia atrás.',
      details: {
        from: fila.status,
        to: 'approved',
        reason: 'not_newer',
        latestApprovedVersion: aprobadaMasNueva.version,
      },
    });
  }
  if (rector === undefined) {
    bloqueos.push({
      code: 'BRIEF_NOT_APPROVED',
      message: 'Todavía no existe un Brief aprobado para esta campaña: no hay contra qué revisar el guion.',
    });
    bloqueos.push({
      code: 'SCRIPT_REVIEW_REQUIRED',
      message: 'Aprobar exige una revisión contra el Brief aprobado vigente, y aún no hay Brief aprobado.',
      details: { reason: 'brief_missing' },
    });
  } else if (revision === null) {
    const hayExitosa = insumos.vigente.vigencia === 'stale';
    bloqueos.push({
      code: 'SCRIPT_REVIEW_REQUIRED',
      message: hayExitosa
        ? 'La revisión del guion es de un Brief anterior: hay que revisarlo contra el Brief aprobado vigente.'
        : 'Aprobar exige una revisión del guion (asistida o humana) contra el Brief aprobado vigente.',
      details: { reason: hayExitosa ? 'stale' : 'none', briefVersionId: rector.versionId },
    });
  }

  const snapshot: SnapshotDeAprobacion = {
    scriptVersion: {
      id: fila.id,
      number: fila.version,
      sourceId: fila.source_document_id,
      // El hash ACTUAL del original: si la fuente cambió desde que se recibió, la huella cambia.
      sourceHash: fila.source_live_hash,
    },
    deliverable: { id: fila.deliverable_id, headVersionId: cabeza.id },
    replaces:
      vigenteActual === undefined ? null : { versionId: vigenteActual.id, number: vigenteActual.version },
    brief:
      rector === undefined
        ? null
        : {
            versionId: rector.versionId,
            number: rector.number,
            contentFingerprint: await huellaDeContenidoDelBrief(db, rector.versionId),
          },
    review: revision === null ? null : { id: revision.id, kind: revision.kind, inputHash: insumos.inputHash },
    findings: {
      total: revision?.findingCount ?? 0,
      openBySeverity: {
        alta: revision?.findingsBySeverity.alta ?? 0,
        media: revision?.findingsBySeverity.media ?? 0,
        baja: revision?.findingsBySeverity.baja ?? 0,
      },
    },
    comments: {
      total: comentarios.length,
      digest: sha256(comentarios.map((c) => c.id).join(',')),
    },
    participation: {
      campaignInfluencerId: fila.campaign_influencer_id,
      status: fila.participation_status,
    },
  };

  return ok({
    elegible: bloqueos.length === 0,
    bloqueos,
    snapshot,
    huella: sha256(canonico(snapshot)),
    etiquetas: {
      influencer: fila.display_name,
      deliverable: fila.deliverable_label,
      product: fila.product_label,
      brief: rector === undefined ? null : `Brief V${rector.number}`,
      headVersion: cabeza.version,
      reviewedAt: revision?.finishedAt ?? revision?.createdAt ?? null,
    },
    ubicacion: {
      organizationId: fila.organization_id,
      campaignId: fila.campaign_id,
      deliverableId: fila.deliverable_id,
      versionNumber: fila.version,
      versionStatus: fila.status,
    },
  });
}

/**
 * La evaluación para la INTERFAZ: lo que se le muestra a la persona antes de aprobar y la huella que debe
 * devolver (`huellaVista`). Exige `script:read` sobre la organización (el Operativo y el cliente no leen
 * guiones); otra organización o cliente → `RESOURCE_NOT_FOUND`. No es una tool del agente.
 */
export async function obtenerEvaluacionDeAprobacion(
  actor: User,
  versionId: string,
  alcance?: { readonly campaignId: string },
): Promise<Result<EvaluacionDeAprobacion>> {
  if (!esUuid(versionId)) return err(NO_ENCONTRADO_DE_CONTENIDO);
  const { rows } = await getPool().query<{ organization_id: string; campaign_id: string }>(
    `SELECT organization_id, campaign_id FROM script_versions WHERE id = $1`,
    [versionId],
  );
  const donde = rows[0];
  if (donde === undefined) return err(NO_ENCONTRADO_DE_CONTENIDO);
  if (alcance !== undefined && donde.campaign_id !== alcance.campaignId) {
    return err(NO_ENCONTRADO_DE_CONTENIDO);
  }
  const permitido = authorizeInternalResource(actor, 'script:read', donde.organization_id);
  if (!permitido.ok) return permitido;
  return evaluarAprobacionDeScript(getPool(), versionId);
}

// ─────────────────────────── Aprobar ───────────────────────────────────────────

const SAVEPOINT = 'aprobar_guion';

function sinInvocacionDeTool(correlation: AuditCorrelation | undefined): AuditCorrelation {
  const { toolInvocationId: _omitida, ...resto } = correlation ?? {};
  void _omitida;
  return resto;
}

function esViolacionUnica(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === '23505';
}

/**
 * Aprueba una versión de guion DENTRO de una transacción que abrió el llamador (no hace COMMIT ni ROLLBACK):
 * es lo que permite que ejecutar la propuesta, marcarla `executed` y auditar sean un único cambio atómico.
 * Todas las reglas son las de `aprobarScriptVersion` (que es esta función en su propia transacción).
 *
 * Una vez que empieza a escribir, un rechazo de la base deshace SOLO su parte (savepoint) y se devuelve como
 * error de dominio: el llamador nunca confirma una aprobación a medias. Cualquier otro fallo se propaga.
 */
export async function aprobarScriptVersionEnTransaccion(
  client: pg.PoolClient,
  actor: User,
  versionId: string,
  opciones: OpcionesDeAprobacion,
): Promise<Result<AprobacionDeScript>> {
  // 1. Canal, persona, capacidad, aislamiento. Nada de esto toca la base de contenido.
  const op: Partial<OpcionesDeAprobacion> = typeof opciones === 'object' && opciones !== null ? opciones : {};
  // Un `'system'` que llegue por el borde de tipos cuenta como canal `system` (mismo criterio que `transitions.ts`).
  const origen: AuditOrigin = op.origen ?? (typeof (actor as unknown) === 'string' ? 'system' : 'ui');
  if (origen !== 'ui') {
    return err({
      code: 'HUMAN_CONFIRMATION_REQUIRED',
      message:
        'Aprobar un guion es una decisión humana: debe proponerse como acción y confirmarla una persona con permiso desde la interfaz.',
      details: { origen },
    });
  }
  const persona = exigirPersona(actor, { origin: origen });
  if (!persona.ok) return persona;
  const capacidad = assertCapability(actor, 'script:approve');
  if (!capacidad.ok) return err(capacidad.error);
  const huellaVista: unknown = op.huellaVista;
  if (typeof huellaVista !== 'string' || !/^[0-9a-f]{64}$/u.test(huellaVista)) {
    return err({
      code: 'VALIDATION_FAILED',
      message: 'Aprobar exige la huella de lo que la persona vio (huellaVista).',
      details: { field: 'huellaVista' },
    });
  }
  if (!esUuid(versionId)) return err(NO_ENCONTRADO_DE_CONTENIDO);

  const { rows: ubicacion } = await client.query<{
    organization_id: string;
    campaign_id: string;
    deliverable_id: string;
  }>(`SELECT organization_id, campaign_id, deliverable_id FROM script_versions WHERE id = $1`, [versionId]);
  const donde = ubicacion[0];
  if (donde === undefined) return err(NO_ENCONTRADO_DE_CONTENIDO);
  if (op.alcance !== undefined && donde.campaign_id !== op.alcance.campaignId) {
    return err(NO_ENCONTRADO_DE_CONTENIDO);
  }
  const permitido = authorizeInternalResource(actor, 'script:approve', donde.organization_id);
  if (!permitido.ok) return permitido;

  // 2. Bloqueos: campaña (FOR SHARE) → entregable → versión → Brief rector (FOR SHARE).
  await client.query(`SELECT 1 FROM campaigns WHERE id = $1 FOR SHARE`, [donde.campaign_id]);
  const entregable = await bloquearEntregable(client, donde.deliverable_id);
  if (entregable === undefined) return err(NO_ENCONTRADO_DE_CONTENIDO);
  await client.query(`SELECT 1 FROM script_versions WHERE id = $1 FOR UPDATE`, [versionId]);
  await client.query(`SELECT 1 FROM brief_versions WHERE id = brief_rector_de_campana($1) FOR SHARE`, [
    donde.campaign_id,
  ]);

  // 3. Se RECALCULA bajo bloqueo (cierra el TOCTOU entre lo mostrado/confirmado y la escritura).
  const evaluada = await evaluarAprobacionDeScript(client, versionId);
  if (!evaluada.ok) return evaluada;
  const ev = evaluada.value;
  if (!ev.elegible) return err(ev.bloqueos[0]!);
  if (ev.huella !== huellaVista) {
    return err({
      code: 'PROPOSAL_STALE',
      message:
        'Lo que se le mostró a la persona cambió antes de aprobar (otra versión, revisión, Brief o comentarios). Vuelva a revisar y apruebe de nuevo.',
      details: { reason: 'view_stale' },
    });
  }
  const snap = ev.snapshot;
  const revision = snap.review!;
  const brief = snap.brief!;

  const correlation = sinInvocacionDeTool(op.correlation);
  const proposedActionId = correlation.proposedActionId;
  let payloadHash: string | undefined;
  if (proposedActionId !== undefined) {
    const { rows } = esUuid(proposedActionId)
      ? await client.query<{ payload_hash: string }>(
          `SELECT payload_hash FROM proposed_actions WHERE id = $1`,
          [proposedActionId],
        )
      : { rows: [] };
    payloadHash = rows[0]?.payload_hash;
  }

  // 4. Escritura, bajo savepoint: un rechazo de la base deshace esta parte y vuelve como error de dominio.
  await client.query(`SAVEPOINT ${SAVEPOINT}`);
  try {
    // Versiones menores aún relevantes (la aprobada anterior incluida), de la más baja a la más alta.
    const { rows: menores } = await client.query<{
      id: string;
      version: number;
      status: ScriptVersionStatus;
      source_document_id: string;
    }>(
      `SELECT id, version, status, source_document_id FROM script_versions
        WHERE deliverable_id = $1 AND version < $2 AND status IN ('received', 'in_review', 'approved')
        ORDER BY version ASC FOR UPDATE`,
      [donde.deliverable_id, snap.scriptVersion.number],
    );
    const anterior = menores.find((m) => m.status === 'approved');

    // (a) La fuente de la aprobada anterior baja a `interna` ANTES de reemplazarla (trigger de 023).
    if (anterior !== undefined) {
      const { rows: fuente } = await client.query<{ visibility: string; filename: string }>(
        `SELECT visibility::text AS visibility, filename FROM source_documents WHERE id = $1 FOR UPDATE`,
        [anterior.source_document_id],
      );
      if (fuente[0] !== undefined && fuente[0].visibility !== 'interna') {
        await conReglasDeBase(() =>
          client.query(`UPDATE source_documents SET visibility = 'interna'::visibility_level WHERE id = $1`, [
            anterior.source_document_id,
          ]),
        );
        await recordAudit(client, {
          actor,
          organizationId: donde.organization_id,
          origin: 'ui',
          correlation,
          action: 'source.set_visibility',
          entityType: 'source_document',
          entityId: anterior.source_document_id,
          metadata: {
            from: fuente[0].visibility,
            to: 'interna',
            filename: fuente[0].filename,
            reason: 'script_superseded',
            scriptVersionId: anterior.id,
            supersededByVersionId: versionId,
          },
        });
      }
    }

    // (b) Las menores pasan a `superseded` (la sucesora es la que se aprueba; el trigger diferido exige que
    // quede aprobada al COMMIT).
    const reemplazadas: VersionReemplazada[] = [];
    for (const m of menores) {
      await conReglasDeBase(() =>
        client.query(
          `UPDATE script_versions SET status = 'superseded', superseded_by_version_id = $2 WHERE id = $1`,
          [m.id, versionId],
        ),
      );
      reemplazadas.push({ versionId: m.id, version: m.version, previousStatus: m.status });
    }

    // (c) La versión pasa a `approved` con sus marcas.
    const aprobada = await conReglasDeBase(async () => {
      const { rows } = await client.query<{ approved_at: Date }>(
        `UPDATE script_versions
            SET status = 'approved', approved_by = $2, approved_via_proposed_action_id = $3,
                approved_analysis_id = $4, approved_brief_version_id = $5, approval_snapshot = $6::jsonb
          WHERE id = $1
          RETURNING approved_at`,
        [versionId, actor.id, proposedActionId ?? null, revision.id, brief.versionId, JSON.stringify(snap)],
      );
      return rows[0]!;
    });

    // Auditoría (misma transacción; solo cifras e ids, nunca texto de documentos).
    await recordAudit(client, {
      actor,
      organizationId: donde.organization_id,
      origin: 'ui',
      correlation,
      action: 'script_version.approve',
      entityType: 'script_version',
      entityId: versionId,
      metadata: {
        campaignId: donde.campaign_id,
        deliverableId: donde.deliverable_id,
        versionNumber: snap.scriptVersion.number,
        via: proposedActionId === undefined ? 'direct' : 'proposal',
        fingerprint: ev.huella,
        ...(payloadHash === undefined ? {} : { payloadHash }),
        reviewId: revision.id,
        reviewKind: revision.kind,
        briefVersionId: brief.versionId,
        briefNumber: brief.number,
        findings: snap.findings,
        comments: { total: snap.comments.total },
        ...(anterior === undefined ? {} : { replacedVersionId: anterior.id }),
        supersededCount: reemplazadas.length,
      },
    });
    for (const r of reemplazadas) {
      await recordAudit(client, {
        actor,
        organizationId: donde.organization_id,
        origin: 'ui',
        correlation,
        action: 'script_version.supersede',
        entityType: 'script_version',
        entityId: r.versionId,
        metadata: {
          campaignId: donde.campaign_id,
          deliverableId: donde.deliverable_id,
          version: r.version,
          from: r.previousStatus,
          to: 'superseded',
          supersededByVersionId: versionId,
          supersededByVersion: snap.scriptVersion.number,
        },
      });
    }
    await recordAudit(client, {
      actor,
      organizationId: donde.organization_id,
      origin: 'ui',
      correlation,
      action: 'deliverable.current_approved_changed',
      entityType: 'deliverable',
      entityId: donde.deliverable_id,
      metadata: {
        campaignId: donde.campaign_id,
        from: anterior === undefined ? null : anterior.id,
        to: versionId,
        fromVersion: anterior === undefined ? null : anterior.version,
        toVersion: snap.scriptVersion.number,
      },
    });

    return ok({
      versionId,
      deliverableId: donde.deliverable_id,
      version: snap.scriptVersion.number,
      status: 'approved',
      approvedAt: aprobada.approved_at.toISOString(),
      via: proposedActionId === undefined ? 'direct' : 'proposal',
      fingerprint: ev.huella,
      reviewId: revision.id,
      reviewKind: revision.kind,
      briefVersionId: brief.versionId,
      findings: snap.findings,
      comments: { total: snap.comments.total },
      previousApproved: anterior === undefined ? null : { versionId: anterior.id, version: anterior.version },
      replaced: reemplazadas,
    });
  } catch (error) {
    await client.query(`ROLLBACK TO SAVEPOINT ${SAVEPOINT}`);
    if (error instanceof Abortar) return err(error.payload);
    if (esViolacionUnica(error)) {
      return err({
        code: 'RESOURCE_CONFLICT',
        message: 'La versión cambió mientras se aprobaba: reintente.',
        details: { reason: 'concurrent_update' },
      });
    }
    throw error;
  } finally {
    // Si todo salió bien el savepoint solo se libera (si ya se deshizo, el RELEASE falla: se ignora).
    await client.query(`RELEASE SAVEPOINT ${SAVEPOINT}`).catch(() => undefined);
  }
}

/**
 * Aprueba una versión de guion en su propia transacción: la aprobación DIRECTA de una persona desde la
 * interfaz (`origen: 'ui'`, por defecto). Un origen distinto (chat, sistema) se rechaza: el agente solo puede
 * PROPONER. Reintentar sobre una versión ya aprobada es un error de estado, no un éxito silencioso.
 */
export async function aprobarScriptVersion(
  actor: User,
  versionId: string,
  opciones: OpcionesDeAprobacion,
): Promise<Result<AprobacionDeScript>> {
  return transaccionConResultado(
    async (client) => {
      const r = await aprobarScriptVersionEnTransaccion(client, actor, versionId, opciones);
      // Un error de dominio deshace la transacción entera (nada a medias).
      if (!r.ok) throw new Abortar(r.error);
      return r.value;
    },
    {
      code: 'RESOURCE_CONFLICT',
      message: 'La versión cambió mientras se aprobaba: reintente.',
      details: { reason: 'concurrent_update' },
    },
  );
}
