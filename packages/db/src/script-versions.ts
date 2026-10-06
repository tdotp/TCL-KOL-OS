/**
 * Versiones de guion (`ScriptVersion`): lo RECIBIDO, inmutable y numerado (V2 · Fase 7).
 *
 * Una versión de guion es el archivo tal como llegó (`source_documents`, origen `file`,
 * visibilidad `interna`): el contenido vive en la fuente y la versión solo añade el
 * entregable al que pertenece, su número y su estado de revisión. Nunca se sobrescribe:
 * un guion nuevo es una versión nueva; un cambio solicitado es terminal (se registra la
 * N+1). La numeración la asigna la base, serializada por el bloqueo del entregable.
 *
 * Este módulo registra, lista y arranca la revisión. Comentarios y cambios solicitados
 * (`script-review.ts`), análisis (`content-analysis.ts`) y aprobación (`script-approval.ts`)
 * son de otros módulos; todos usan `bloquearEntregable` primero.
 *
 * Registrar NO exige que la fuente esté procesada (el original queda preservado): el
 * resultado informa su `sourceState` derivado para que quien llama diga qué falta. Analizar
 * sí exige una fuente legible (otro módulo).
 *
 * Autorización: registrar = `script:manage` + `source:read` (+ `deliverable:manage` solo si
 * hay que crear el entregable); leer = `script:read`; el Operativo NO lee versiones (solo
 * ve el estado por `listarEntregablesDeCampana`). Otra organización o cliente →
 * `RESOURCE_NOT_FOUND`; sin la capacidad → `FORBIDDEN_ROLE`.
 */

import type pg from 'pg';
import {
  type Deliverable,
  type PreparacionDeFuente,
  type Result,
  type ScriptVersion,
  type ScriptVersionStatus,
  type User,
  authorizeInternalResource,
  candidatosDeParticipacion,
  derivarPreparacionDeFuente,
  err,
  etiquetasParecidas,
  normalizarEtiquetaDeEntregable,
  ok,
} from '@tcl-kol-os/domain';
import { recordAudit } from './audit.ts';
import { type ContextoDeAuditoria, auditoriaDe, exigirPersona } from './audit-context.ts';
import { assertCapability } from './authz.ts';
import { getPool } from './client.ts';
import {
  type FilaDeEntregable,
  NO_ENCONTRADO_DE_CONTENIDO,
  SELECT_ENTREGABLE,
  bloquearEntregable,
  comoEntregable,
  conReglasDeBase,
  crearEntregableEnTransaccion,
  esUuid,
  exigirCampanaYParticipacionActivas,
} from './deliverables.ts';
import { type SourceRow, getSource } from './sources.ts';
import { Abortar, transaccionConResultado } from './tx-result.ts';

// ─────────────────────────── Filas y mapeo ─────────────────────────────────────

interface FilaDeVersion {
  readonly id: string;
  readonly organization_id: string;
  readonly campaign_id: string;
  readonly deliverable_id: string;
  readonly version: number;
  readonly status: ScriptVersionStatus;
  readonly source_document_id: string;
  readonly source_filename: string;
  readonly source_hash: string;
  readonly created_by: string;
  readonly created_at: Date;
  readonly updated_at: Date;
  readonly approved_by: string | null;
  readonly approved_at: Date | null;
  readonly approved_via_proposed_action_id: string | null;
  readonly approved_analysis_id: string | null;
  readonly approved_brief_version_id: string | null;
  readonly approval_snapshot: Record<string, unknown> | null;
  readonly superseded_by_version_id: string | null;
  readonly superseded_at: Date | null;
}

const COLUMNAS_DE_VERSION = `
  id, organization_id, campaign_id, deliverable_id, version, status, source_document_id,
  source_filename, source_hash, created_by, created_at, updated_at, approved_by, approved_at,
  approved_via_proposed_action_id, approved_analysis_id, approved_brief_version_id, approval_snapshot,
  superseded_by_version_id, superseded_at
`;

const SELECT_VERSION = `SELECT ${COLUMNAS_DE_VERSION} FROM script_versions`;

function comoVersion(row: FilaDeVersion): ScriptVersion {
  return {
    id: row.id,
    organizationId: row.organization_id,
    campaignId: row.campaign_id,
    deliverableId: row.deliverable_id,
    version: row.version,
    status: row.status,
    sourceDocumentId: row.source_document_id,
    sourceFilename: row.source_filename,
    sourceHash: row.source_hash,
    createdBy: row.created_by,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    approvedBy: row.approved_by ?? undefined,
    approvedAt: row.approved_at?.toISOString(),
    supersededByVersionId: row.superseded_by_version_id ?? undefined,
    supersededAt: row.superseded_at?.toISOString(),
  };
}

/** La versión con sus marcas de aprobación completas (para quien revisa y aprueba). */
export interface VersionDeGuionDetalle extends ScriptVersion {
  readonly deliverable: {
    readonly id: string;
    readonly label: string;
    readonly campaignInfluencerId: string;
    readonly status: Deliverable['status'];
  };
  readonly approvedViaProposedActionId: string | undefined;
  readonly approvedAnalysisId: string | undefined;
  readonly approvedBriefVersionId: string | undefined;
  readonly approvalSnapshot: Readonly<Record<string, unknown>> | undefined;
}

function comoDetalle(row: FilaDeVersion, entregable: FilaDeEntregable): VersionDeGuionDetalle {
  return {
    ...comoVersion(row),
    deliverable: {
      id: entregable.id,
      label: entregable.label,
      campaignInfluencerId: entregable.campaign_influencer_id,
      status: entregable.status,
    },
    approvedViaProposedActionId: row.approved_via_proposed_action_id ?? undefined,
    approvedAnalysisId: row.approved_analysis_id ?? undefined,
    approvedBriefVersionId: row.approved_brief_version_id ?? undefined,
    approvalSnapshot: row.approval_snapshot ?? undefined,
  };
}

export interface OpcionesDeLecturaDeVersion {
  /** Cerco de campaña: un recurso de otra campaña se responde como inexistente. */
  readonly alcance?: { readonly campaignId: string } | undefined;
}

// ─────────────────────────── Registrar una versión ─────────────────────────────

/** Un participante propuesto cuando la mención no basta (para que la persona elija). */
export interface CandidatoDeParticipacion {
  readonly campaignInfluencerId: string;
  readonly displayName: string;
  readonly status: 'activo' | 'retirado';
  readonly accounts: readonly { readonly platform: string; readonly handle: string }[];
  readonly products: readonly string[];
  readonly deliverables: readonly CandidatoDeEntregable[];
}

/** Un entregable propuesto cuando falta o es ambigua la elección. */
export interface CandidatoDeEntregable {
  readonly id: string;
  readonly label: string;
  readonly platform: string | undefined;
  readonly lastVersion: { readonly version: number; readonly status: ScriptVersionStatus } | null;
}

export interface RegistrarVersionDeGuionInput {
  readonly campaignId: string;
  /** La fuente (archivo) con el guion: de ESTA campaña y organización, no restringida. */
  readonly sourceId: string;
  readonly participation: {
    /** Directo (la UI lo conoce). Con `mention`, debe ser exactamente el elegido. */
    readonly participationId?: string | undefined;
    /** Lo que dijo la persona («Valentina», «@valentina.rojas»). */
    readonly mention?: string | undefined;
    /** Apellido, handle o producto que desambigua entre varios con la misma mención. */
    readonly disambiguation?: string | undefined;
  };
  /**
   * `{id}`: un entregable existente de ESA participación. `{label}`: coincidencia normalizada o,
   * si no hay nada igual ni parecido, se CREA con esa etiqueta literal. Sin nada: solo si la
   * participación tiene exactamente un entregable activo.
   */
  readonly deliverable?: { readonly id: string } | { readonly label: string } | undefined;
}

export type RegistroDeGuion =
  | {
      readonly kind: 'registered';
      readonly version: ScriptVersion;
      readonly deliverable: Deliverable;
      readonly createdDeliverable: boolean;
      readonly sourceState: PreparacionDeFuente;
    }
  | {
      /** La fuente YA era una versión: reenviar el mismo archivo nunca crea la N+1. */
      readonly kind: 'deduplicated';
      readonly version: ScriptVersion;
      readonly deliverable: Deliverable;
      readonly sourceState: PreparacionDeFuente;
    }
  | {
      /** SIN efecto: falta una elección humana. */
      readonly kind: 'needs_choice';
      readonly reason: 'participation_ambiguous' | 'participation_not_found';
      readonly candidates: readonly CandidatoDeParticipacion[];
    }
  | {
      readonly kind: 'needs_choice';
      readonly reason: 'deliverable_required' | 'deliverable_ambiguous';
      readonly participation: { readonly campaignInfluencerId: string; readonly displayName: string };
      readonly candidates: readonly CandidatoDeEntregable[];
    };

function preparacionDe(row: SourceRow): PreparacionDeFuente {
  return derivarPreparacionDeFuente({
    origin: row.origin,
    status: row.status,
    confidentialityLevel: row.confidentiality_level,
    fragmentCount: row.fragmentos,
    jobStatus: row.job_status,
    provider: row.external_provider,
  });
}

interface FilaDeParticipante {
  readonly id: string;
  readonly influencer_id: string;
  readonly status: 'activo' | 'retirado';
  readonly display_name: string;
}

async function entregablesComoCandidatos(
  db: pg.Pool | pg.PoolClient,
  participacionIds: readonly string[],
): Promise<Map<string, CandidatoDeEntregable[]>> {
  const salida = new Map<string, CandidatoDeEntregable[]>();
  if (participacionIds.length === 0) return salida;
  const { rows } = await db.query<{
    id: string;
    campaign_influencer_id: string;
    label: string;
    platform: string | null;
    version: number | null;
    status: ScriptVersionStatus | null;
  }>(
    `SELECT d.id, d.campaign_influencer_id, d.label, d.platform::text AS platform, lv.version, lv.status
       FROM deliverables d
       LEFT JOIN script_versions lv ON lv.deliverable_id = d.id AND lv.version = d.last_version
      WHERE d.campaign_influencer_id = ANY($1::uuid[]) AND d.status = 'active'
      ORDER BY d.created_at, d.id`,
    [participacionIds],
  );
  for (const r of rows) {
    const lista = salida.get(r.campaign_influencer_id) ?? [];
    lista.push({
      id: r.id,
      label: r.label,
      platform: r.platform ?? undefined,
      lastVersion: r.version === null || r.status === null ? null : { version: r.version, status: r.status },
    });
    salida.set(r.campaign_influencer_id, lista);
  }
  return salida;
}

/**
 * Registra un guion recibido como una versión NUEVA de un entregable.
 *
 * Resolución (nunca adivina): la participación debe ser INEQUÍVOCA (por id directo o por
 * mención + desambiguación vía `candidatosDeParticipacion`); el entregable, único o dado
 * literalmente. Si falta una elección devuelve `needs_choice` con los candidatos y SIN
 * ningún efecto. Reenviar la misma fuente devuelve `deduplicated`.
 *
 * Todo (entregable implícito, versión, auditoría) ocurre en una sola transacción. La
 * procedencia «vino del mensaje M» queda en `contexto.correlation.messageId` del evento
 * `script_version.register`.
 */
export async function registrarVersionDeGuion(
  actor: User,
  input: RegistrarVersionDeGuionInput,
  contexto?: ContextoDeAuditoria,
): Promise<Result<RegistroDeGuion>> {
  const persona = exigirPersona(actor, contexto);
  if (!persona.ok) return persona;
  if (!esUuid(input.campaignId) || !esUuid(input.sourceId)) return err(NO_ENCONTRADO_DE_CONTENIDO);

  // La fuente se lee con el alcance de lectura del actor (`getSource`) ANTES de abrir la
  // transacción; dentro se vuelve a bloquear y a comprobar lo que no puede cambiar.
  const { rows: campanas } = await getPool().query<{ organization_id: string }>(
    `SELECT organization_id FROM campaigns WHERE id = $1`,
    [input.campaignId],
  );
  if (campanas[0] === undefined) return err(NO_ENCONTRADO_DE_CONTENIDO);
  const organizationId = campanas[0].organization_id;
  const permitido = authorizeInternalResource(actor, 'script:manage', organizationId);
  if (!permitido.ok) return permitido;
  const puedeLeerFuentes = assertCapability(actor, 'source:read');
  if (!puedeLeerFuentes.ok) return puedeLeerFuentes;

  const fuente = await getSource(actor, input.sourceId);
  if (!fuente.ok || fuente.value.campaign_id !== input.campaignId) return err(NO_ENCONTRADO_DE_CONTENIDO);
  const sourceState = preparacionDe(fuente.value);
  // Una fuente restringida (sensible o confidencialidad desconocida) no existe para esta operación.
  if (sourceState === 'restricted') return err(NO_ENCONTRADO_DE_CONTENIDO);

  return transaccionConResultado(
    async (client): Promise<RegistroDeGuion> => {
      const { rows: estadoDeCampana } = await client.query<{ status: string }>(
        `SELECT status::text AS status FROM campaigns WHERE id = $1 FOR SHARE`,
        [input.campaignId],
      );
      if (estadoDeCampana[0]?.status !== 'activa') {
        throw new Abortar({
          code: 'RESOURCE_CONFLICT',
          message: 'La campaña no está activa: no se registran guiones.',
          details: { reason: 'campaign_not_active', campaignId: input.campaignId },
        });
      }

      // La fuente: archivo (no enlace), interna y con hash SHA-256 (se vuelve a leer con bloqueo).
      const { rows: fuentes } = await client.query<{
        origin: string;
        visibility: string;
        hash: string | null;
      }>(
        `SELECT origin::text AS origin, visibility::text AS visibility, hash FROM source_documents WHERE id = $1 FOR SHARE`,
        [input.sourceId],
      );
      const f = fuentes[0];
      if (f === undefined) throw new Abortar(NO_ENCONTRADO_DE_CONTENIDO);
      if (f.origin !== 'file' || f.hash === null || !/^[0-9a-f]{64}$/u.test(f.hash)) {
        throw new Abortar({
          code: 'VALIDATION_FAILED',
          message:
            'El guion debe ser un archivo cargado (no un enlace): un enlace puede cambiar y rompería la historia.',
          details: { field: 'sourceId', reason: 'source_not_file' },
        });
      }
      if (f.visibility !== 'interna') {
        throw new Abortar({
          code: 'RESOURCE_CONFLICT',
          message: 'La fuente es visible para TCL: bájela a interna antes de usarla como guion.',
          details: { reason: 'source_visible_to_tcl', sourceId: input.sourceId },
        });
      }

      // Reenviar el mismo archivo no crea otra versión.
      const existente = await versionDeFuente(client, input.sourceId);
      if (existente !== undefined) return await comoDeduplicada(client, existente, sourceState);

      // Punto de retorno: si dos registros simultáneos de la MISMA fuente hacia entregables distintos (cada
      // uno bajo su propio mutex) llegan a insertar, la base (025 · UNIQUE (source_document_id)) deja pasar a
      // uno y rechaza al otro con 23505; el perdedor deshace SOLO lo suyo (incluido un entregable implícito
      // recién creado) y devuelve la versión ya registrada como `deduplicated`.
      await client.query(`SAVEPOINT registro_de_guion`);

      // ── Participación inequívoca ──
      const eleccion = await resolverParticipacion(client, actor, input, organizationId);
      if ('needsChoice' in eleccion) return eleccion.needsChoice;
      const participante = eleccion.participante;
      if (participante.status !== 'activo') {
        throw new Abortar({
          code: 'RESOURCE_CONFLICT',
          message: 'El influencer está retirado de la campaña: reactívelo para trabajar su contenido.',
          details: { reason: 'campaign_influencer_retired', campaignInfluencerId: participante.id },
        });
      }

      // ── Entregable inequívoco (o creado con la etiqueta literal) ──
      const decision = await resolverEntregable(client, participante, input.deliverable);
      if ('needsChoice' in decision) return decision.needsChoice;
      let entregable: FilaDeEntregable;
      let creado = false;
      if ('crear' in decision) {
        const nuevo = await crearEntregableEnTransaccion(
          client,
          actor,
          { campaignInfluencerId: participante.id, label: decision.crear },
          contexto,
        );
        creado = true;
        const fila = await bloquearEntregable(client, nuevo.id);
        if (fila === undefined) throw new Abortar(NO_ENCONTRADO_DE_CONTENIDO);
        entregable = fila;
      } else {
        const fila = await bloquearEntregable(client, decision.existente.id);
        if (fila === undefined) throw new Abortar(NO_ENCONTRADO_DE_CONTENIDO);
        entregable = fila;
      }
      if (entregable.status !== 'active') {
        throw new Abortar({
          code: 'RESOURCE_CONFLICT',
          message: 'El entregable está archivado: reactívelo para registrar versiones.',
          details: { reason: 'deliverable_archived', deliverableId: entregable.id },
        });
      }
      await exigirCampanaYParticipacionActivas(client, entregable);

      // Con el entregable bloqueado, otra solicitud simultánea con la misma fuente ya pudo registrarla.
      const carrera = await versionDeFuente(client, input.sourceId);
      if (carrera !== undefined) {
        // También deshace un entregable implícito recién creado: no queda uno vacío huérfano.
        await client.query(`ROLLBACK TO SAVEPOINT registro_de_guion`);
        return await comoDeduplicada(client, carrera, sourceState);
      }

      let version: ScriptVersion;
      try {
        version = await conReglasDeBase(async () => {
          const { rows } = await client.query<FilaDeVersion>(
            `INSERT INTO script_versions (organization_id, campaign_id, deliverable_id, source_document_id, created_by)
             VALUES ($1, $2, $3, $4, $5)
             RETURNING ${COLUMNAS_DE_VERSION}`,
            [entregable.organization_id, entregable.campaign_id, entregable.id, input.sourceId, actor.id],
          );
          return comoVersion(rows[0]!);
        });
      } catch (error) {
        if (!esViolacionDeFuenteUnica(error)) throw error;
        await client.query(`ROLLBACK TO SAVEPOINT registro_de_guion`);
        const ganadora = await versionDeFuente(client, input.sourceId);
        if (ganadora === undefined) throw error;
        return await comoDeduplicada(client, ganadora, sourceState);
      }
      await recordAudit(
        client,
        auditoriaDe(actor, contexto, {
          action: 'script_version.register',
          entityType: 'script_version',
          entityId: version.id,
          metadata: {
            campaignId: version.campaignId,
            deliverableId: version.deliverableId,
            version: version.version,
            sourceId: version.sourceDocumentId,
            filename: version.sourceFilename,
            createdDeliverable: creado,
          },
        }),
      );
      // El entregable devuelto refleja el contador ya avanzado por la base.
      const { rows: refrescado } = await client.query<FilaDeEntregable>(
        `${SELECT_ENTREGABLE} WHERE id = $1`,
        [entregable.id],
      );
      return {
        kind: 'registered',
        version,
        deliverable: comoEntregable(refrescado[0]!),
        createdDeliverable: creado,
        sourceState,
      };
    },
    {
      code: 'RESOURCE_CONFLICT',
      message: 'La versión cambió mientras se registraba: reintente.',
      details: { reason: 'concurrent_update' },
    },
  );
}

/** La restricción de la 025 que impone «una fuente es versión de un solo entregable». */
function esViolacionDeFuenteUnica(error: unknown): boolean {
  const e = error as { code?: unknown; constraint?: unknown } | null;
  return (
    typeof e === 'object' &&
    e !== null &&
    e.code === '23505' &&
    e.constraint === 'script_versions_fuente_unica_key'
  );
}

async function versionDeFuente(client: pg.PoolClient, sourceId: string): Promise<FilaDeVersion | undefined> {
  const { rows } = await client.query<FilaDeVersion>(
    `${SELECT_VERSION} WHERE source_document_id = $1 ORDER BY version LIMIT 1`,
    [sourceId],
  );
  return rows[0];
}

async function comoDeduplicada(
  client: pg.PoolClient,
  fila: FilaDeVersion,
  sourceState: PreparacionDeFuente,
): Promise<RegistroDeGuion> {
  const { rows } = await client.query<FilaDeEntregable>(`${SELECT_ENTREGABLE} WHERE id = $1`, [
    fila.deliverable_id,
  ]);
  return {
    kind: 'deduplicated',
    version: comoVersion(fila),
    deliverable: comoEntregable(rows[0]!),
    sourceState,
  };
}

interface ParticipanteDeCampana {
  readonly id: string;
  readonly status: 'activo' | 'retirado';
  readonly displayName: string;
  readonly handles: readonly string[];
  readonly products: readonly string[];
  readonly accounts: readonly { readonly platform: string; readonly handle: string }[];
}

async function participantesDeCampana(
  client: pg.PoolClient,
  campaignId: string,
  organizationId: string,
): Promise<ParticipanteDeCampana[]> {
  const { rows } = await client.query<FilaDeParticipante>(
    `SELECT ci.id, ci.influencer_id, ci.status::text AS status, i.display_name
       FROM campaign_influencers ci JOIN influencers i ON i.id = ci.influencer_id
      WHERE ci.campaign_id = $1 AND ci.organization_id = $2
      ORDER BY ci.created_at, ci.id`,
    [campaignId, organizationId],
  );
  if (rows.length === 0) return [];
  const { rows: cuentas } = await client.query<{ influencer_id: string; platform: string; handle: string }>(
    `SELECT influencer_id, platform::text AS platform, handle FROM influencer_accounts
      WHERE influencer_id = ANY($1::uuid[]) ORDER BY platform, handle`,
    [rows.map((r) => r.influencer_id)],
  );
  const { rows: productos } = await client.query<{
    campaign_influencer_id: string;
    brand: string;
    model: string;
  }>(
    `SELECT cip.campaign_influencer_id, p.brand, p.model
       FROM campaign_influencer_products cip
       JOIN campaign_products cp ON cp.id = cip.campaign_product_id
       JOIN products p ON p.id = cp.product_id
      WHERE cip.campaign_influencer_id = ANY($1::uuid[])`,
    [rows.map((r) => r.id)],
  );
  return rows.map((r) => ({
    id: r.id,
    status: r.status,
    displayName: r.display_name,
    handles: cuentas.filter((c) => c.influencer_id === r.influencer_id).map((c) => c.handle),
    accounts: cuentas
      .filter((c) => c.influencer_id === r.influencer_id)
      .map((c) => ({ platform: c.platform, handle: c.handle })),
    products: productos
      .filter((p) => p.campaign_influencer_id === r.id)
      .map((p) => `${p.brand} ${p.model}`.trim()),
  }));
}

async function comoCandidatos(
  client: pg.PoolClient,
  participantes: readonly ParticipanteDeCampana[],
): Promise<CandidatoDeParticipacion[]> {
  const entregables = await entregablesComoCandidatos(
    client,
    participantes.map((p) => p.id),
  );
  return participantes.map((p) => ({
    campaignInfluencerId: p.id,
    displayName: p.displayName,
    status: p.status,
    accounts: p.accounts,
    products: p.products,
    deliverables: entregables.get(p.id) ?? [],
  }));
}

type EleccionDeParticipacion =
  { readonly participante: ParticipanteDeCampana } | { readonly needsChoice: RegistroDeGuion };

/**
 * La participación inequívoca, o `needs_choice` sin efecto. Un `participationId` que no es EXACTAMENTE
 * el elegido por la mención se rechaza: no es una forma de saltarse la mención.
 */
async function resolverParticipacion(
  client: pg.PoolClient,
  actor: User,
  input: RegistrarVersionDeGuionInput,
  organizationId: string,
): Promise<EleccionDeParticipacion> {
  // Leer participantes exige poder leerlos (la identidad y la participación).
  for (const accion of ['campaign_influencer:read', 'influencer:read'] as const) {
    const permitido = authorizeInternalResource(actor, accion, organizationId);
    if (!permitido.ok) throw new Abortar(permitido.error);
  }
  const { mention, participationId, disambiguation } = input.participation;
  if (participationId !== undefined && !esUuid(participationId))
    throw new Abortar(NO_ENCONTRADO_DE_CONTENIDO);
  const participantes = await participantesDeCampana(client, input.campaignId, organizationId);

  if (mention === undefined || mention.trim() === '') {
    if (participationId === undefined) {
      throw new Abortar({
        code: 'VALIDATION_FAILED',
        message: 'Indique a qué participación pertenece el guion (su id o el nombre que dijo la persona).',
        details: { field: 'participation' },
      });
    }
    const directa = participantes.find((p) => p.id === participationId);
    if (directa === undefined) throw new Abortar(NO_ENCONTRADO_DE_CONTENIDO);
    return { participante: directa };
  }

  const r = candidatosDeParticipacion(mention, participantes, disambiguation);
  if (r.razon === 'not_found') {
    return {
      needsChoice: { kind: 'needs_choice', reason: 'participation_not_found', candidates: [] },
    };
  }
  if (r.elegido === undefined) {
    return {
      needsChoice: {
        kind: 'needs_choice',
        reason: 'participation_ambiguous',
        candidates: await comoCandidatos(client, r.candidatos),
      },
    };
  }
  if (participationId !== undefined && participationId !== r.elegido.id) {
    throw new Abortar({
      code: 'VALIDATION_FAILED',
      message: 'El participante indicado no es el que identifica la mención.',
      details: { field: 'participationId', reason: 'participation_mismatch' },
    });
  }
  return { participante: r.elegido };
}

type DecisionDeEntregable =
  | { readonly existente: { readonly id: string } }
  | { readonly crear: string }
  | { readonly needsChoice: RegistroDeGuion };

async function resolverEntregable(
  client: pg.PoolClient,
  participante: ParticipanteDeCampana,
  pedido: RegistrarVersionDeGuionInput['deliverable'],
): Promise<DecisionDeEntregable> {
  if (pedido !== undefined && 'id' in pedido) {
    if (!esUuid(pedido.id)) throw new Abortar(NO_ENCONTRADO_DE_CONTENIDO);
    // De ESA participación; de otra participación se responde como inexistente.
    const { rows } = await client.query<{ id: string }>(
      `SELECT id FROM deliverables WHERE id = $1 AND campaign_influencer_id = $2`,
      [pedido.id, participante.id],
    );
    if (rows[0] === undefined) throw new Abortar(NO_ENCONTRADO_DE_CONTENIDO);
    return { existente: rows[0] };
  }

  const activos = (await entregablesComoCandidatos(client, [participante.id])).get(participante.id) ?? [];
  const sobre = { campaignInfluencerId: participante.id, displayName: participante.displayName };

  if (pedido !== undefined && 'label' in pedido) {
    const etiqueta = normalizarEtiquetaDeEntregable(pedido.label);
    if (!etiqueta.ok) throw new Abortar(etiqueta.error);
    const { rows: claves } = await client.query<{ id: string; label_key: string }>(
      `SELECT id, label_key FROM deliverables WHERE campaign_influencer_id = $1 AND status = 'active'`,
      [participante.id],
    );
    const igual = claves.find((c) => c.label_key === etiqueta.value.key);
    if (igual !== undefined) return { existente: igual };
    const parecidos = claves.filter((c) => etiquetasParecidas(c.label_key, etiqueta.value.key));
    if (parecidos.length > 0) {
      return {
        needsChoice: {
          kind: 'needs_choice',
          reason: 'deliverable_ambiguous',
          participation: sobre,
          candidates: activos.filter((a) => parecidos.some((p) => p.id === a.id)),
        },
      };
    }
    return { crear: etiqueta.value.label };
  }

  if (activos.length === 1) return { existente: activos[0]! };
  return {
    needsChoice: {
      kind: 'needs_choice',
      reason: activos.length === 0 ? 'deliverable_required' : 'deliverable_ambiguous',
      participation: sobre,
      candidates: activos,
    },
  };
}

// ─────────────────────────── Lecturas ──────────────────────────────────────────

/** Carga un entregable y exige `script:read` sobre su organización (cerco de campaña opcional). */
async function entregableParaLeer(
  actor: User,
  deliverableId: string,
  alcance: { readonly campaignId: string } | undefined,
): Promise<Result<FilaDeEntregable>> {
  if (!esUuid(deliverableId)) return err(NO_ENCONTRADO_DE_CONTENIDO);
  const { rows } = await getPool().query<FilaDeEntregable>(`${SELECT_ENTREGABLE} WHERE id = $1`, [
    deliverableId,
  ]);
  const fila = rows[0];
  if (fila === undefined) return err(NO_ENCONTRADO_DE_CONTENIDO);
  if (alcance !== undefined && fila.campaign_id !== alcance.campaignId)
    return err(NO_ENCONTRADO_DE_CONTENIDO);
  const permitido = authorizeInternalResource(actor, 'script:read', fila.organization_id);
  if (!permitido.ok) return permitido;
  return ok(fila);
}

export interface ListarVersionesOpciones extends OpcionesDeLecturaDeVersion {
  readonly limite?: number | undefined;
  readonly desde?: number | undefined;
}

export interface PaginaDeVersiones {
  /** De la más nueva a la más antigua. */
  readonly items: ScriptVersion[];
  readonly total: number;
  readonly limite: number;
  readonly desde: number;
}

/** El historial de versiones de un entregable (más nueva primero). Exige `script:read`. */
export async function listarVersionesDeEntregable(
  actor: User,
  deliverableId: string,
  opciones: ListarVersionesOpciones = {},
): Promise<Result<PaginaDeVersiones>> {
  const entregable = await entregableParaLeer(actor, deliverableId, opciones.alcance);
  if (!entregable.ok) return entregable;
  const limite = Math.min(Math.max(Math.trunc(opciones.limite ?? 50), 1), 200);
  const desde = Math.max(Math.trunc(opciones.desde ?? 0), 0);
  const { rows } = await getPool().query<FilaDeVersion>(
    `${SELECT_VERSION} WHERE deliverable_id = $1 ORDER BY version DESC LIMIT ${limite} OFFSET ${desde}`,
    [deliverableId],
  );
  return ok({ items: rows.map(comoVersion), total: entregable.value.last_version, limite, desde });
}

/** Una versión con sus marcas de aprobación y su entregable. Exige `script:read`. */
export async function obtenerVersionDeGuion(
  actor: User,
  versionId: string,
  opciones: OpcionesDeLecturaDeVersion = {},
): Promise<Result<VersionDeGuionDetalle>> {
  if (!esUuid(versionId)) return err(NO_ENCONTRADO_DE_CONTENIDO);
  const { rows } = await getPool().query<FilaDeVersion>(`${SELECT_VERSION} WHERE id = $1`, [versionId]);
  const fila = rows[0];
  if (fila === undefined) return err(NO_ENCONTRADO_DE_CONTENIDO);
  if (opciones.alcance !== undefined && fila.campaign_id !== opciones.alcance.campaignId) {
    return err(NO_ENCONTRADO_DE_CONTENIDO);
  }
  const permitido = authorizeInternalResource(actor, 'script:read', fila.organization_id);
  if (!permitido.ok) return permitido;
  const { rows: entregables } = await getPool().query<FilaDeEntregable>(
    `${SELECT_ENTREGABLE} WHERE id = $1`,
    [fila.deliverable_id],
  );
  return ok(comoDetalle(fila, entregables[0]!));
}

/** La versión aprobada vigente (la única `approved`), o `null`. Exige `script:read`. */
export async function obtenerVersionVigente(
  actor: User,
  deliverableId: string,
  opciones: OpcionesDeLecturaDeVersion = {},
): Promise<Result<ScriptVersion | null>> {
  const entregable = await entregableParaLeer(actor, deliverableId, opciones.alcance);
  if (!entregable.ok) return entregable;
  const { rows } = await getPool().query<FilaDeVersion>(
    `${SELECT_VERSION} WHERE deliverable_id = $1 AND status = 'approved'`,
    [deliverableId],
  );
  return ok(rows[0] === undefined ? null : comoVersion(rows[0]));
}

/** La última versión registrada (mayor número, cualquier estado), o `null`. Exige `script:read`. */
export async function obtenerUltimaVersion(
  actor: User,
  deliverableId: string,
  opciones: OpcionesDeLecturaDeVersion = {},
): Promise<Result<ScriptVersion | null>> {
  const entregable = await entregableParaLeer(actor, deliverableId, opciones.alcance);
  if (!entregable.ok) return entregable;
  const { rows } = await getPool().query<FilaDeVersion>(
    `${SELECT_VERSION} WHERE deliverable_id = $1 ORDER BY version DESC LIMIT 1`,
    [deliverableId],
  );
  return ok(rows[0] === undefined ? null : comoVersion(rows[0]));
}

// ─────────────────────────── Iniciar la revisión ───────────────────────────────

export interface RevisionIniciada {
  readonly version: ScriptVersion;
  /** `false` si ya estaba en revisión (idempotente: sin escritura ni auditoría). */
  readonly changed: boolean;
}

/**
 * `received → in_review`, el primer acto de revisión (explícito, o implícito al
 * analizar, revisar a mano o comentar). IDEMPOTENTE: si ya está en revisión no hace nada.
 * Cualquier otro estado (cambios solicitados, aprobada, reemplazada) →
 * `SCRIPT_INVALID_TRANSITION`. Exige `script:manage`, entregable/participación/campaña activos.
 * Canal `ui` o `chat`: no es una decisión crítica.
 *
 * DENTRO de una transacción abierta por el llamador (no hace COMMIT ni ROLLBACK). Orden de
 * bloqueo: entregable → versión.
 */
export async function iniciarRevisionDeVersionEnTransaccion(
  client: pg.PoolClient,
  actor: User,
  versionId: string,
  contexto?: ContextoDeAuditoria,
  alcance?: { readonly campaignId: string } | undefined,
): Promise<Result<RevisionIniciada>> {
  const persona = exigirPersona(actor, contexto);
  if (!persona.ok) return persona;
  if (!esUuid(versionId)) return err(NO_ENCONTRADO_DE_CONTENIDO);

  const { rows: ubicacion } = await client.query<{
    deliverable_id: string;
    organization_id: string;
    campaign_id: string;
  }>(`SELECT deliverable_id, organization_id, campaign_id FROM script_versions WHERE id = $1`, [versionId]);
  const donde = ubicacion[0];
  if (donde === undefined) return err(NO_ENCONTRADO_DE_CONTENIDO);
  if (alcance !== undefined && donde.campaign_id !== alcance.campaignId)
    return err(NO_ENCONTRADO_DE_CONTENIDO);
  const permitido = authorizeInternalResource(actor, 'script:manage', donde.organization_id);
  if (!permitido.ok) return permitido;

  try {
    const entregable = await bloquearEntregable(client, donde.deliverable_id);
    if (entregable === undefined) return err(NO_ENCONTRADO_DE_CONTENIDO);
    const { rows } = await client.query<FilaDeVersion>(`${SELECT_VERSION} WHERE id = $1 FOR UPDATE`, [
      versionId,
    ]);
    const actual = rows[0];
    if (actual === undefined) return err(NO_ENCONTRADO_DE_CONTENIDO);

    if (actual.status === 'in_review') return ok({ version: comoVersion(actual), changed: false });
    if (actual.status !== 'received') {
      return err({
        code: 'SCRIPT_INVALID_TRANSITION',
        message: `Una versión en estado «${actual.status}» no se puede poner en revisión.`,
        details: { from: actual.status, to: 'in_review' },
      });
    }
    if (entregable.status !== 'active') {
      return err({
        code: 'RESOURCE_CONFLICT',
        message: 'El entregable está archivado: reactívelo para revisar sus versiones.',
        details: { reason: 'deliverable_archived', deliverableId: entregable.id },
      });
    }
    await exigirCampanaYParticipacionActivas(client, entregable);

    const nueva = await conReglasDeBase(async () => {
      const { rows: filas } = await client.query<FilaDeVersion>(
        `UPDATE script_versions SET status = 'in_review' WHERE id = $1 RETURNING ${COLUMNAS_DE_VERSION}`,
        [versionId],
      );
      return comoVersion(filas[0]!);
    });
    await recordAudit(
      client,
      auditoriaDe(actor, contexto, {
        action: 'script_version.transition',
        entityType: 'script_version',
        entityId: versionId,
        metadata: {
          campaignId: actual.campaign_id,
          deliverableId: actual.deliverable_id,
          version: actual.version,
          from: 'received',
          to: 'in_review',
        },
      }),
    );
    return ok({ version: nueva, changed: true });
  } catch (error) {
    if (error instanceof Abortar) return err(error.payload);
    throw error;
  }
}

/** `received → in_review` en su propia transacción (ver `iniciarRevisionDeVersionEnTransaccion`). */
export async function iniciarRevisionDeVersion(
  actor: User,
  versionId: string,
  contexto?: ContextoDeAuditoria,
  alcance?: { readonly campaignId: string } | undefined,
): Promise<Result<RevisionIniciada>> {
  const persona = exigirPersona(actor, contexto);
  if (!persona.ok) return persona;
  let resultado: Result<RevisionIniciada> | undefined;
  const r = await transaccionConResultado(
    async (client) => {
      resultado = await iniciarRevisionDeVersionEnTransaccion(client, actor, versionId, contexto, alcance);
      // Un error de dominio deshace la transacción entera (nada a medias).
      if (!resultado.ok) throw new Abortar(resultado.error);
      return resultado.value;
    },
    {
      code: 'RESOURCE_CONFLICT',
      message: 'La versión cambió mientras se actualizaba.',
      details: { reason: 'concurrent_update' },
    },
  );
  return r;
}
