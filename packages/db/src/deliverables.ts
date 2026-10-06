/**
 * Entregables (`Deliverable`): la pieza de contenido de UNA participación (V2 · Fase 7).
 *
 * Un entregable cuelga de `CampaignInfluencer`, nunca de `Influencer` (DEC-044), y es el
 * contenedor de las versiones de guion (`script-versions.ts`). Esta capa solo conoce la
 * identidad (participación, etiqueta, plataforma informativa, producto) y su estado
 * (`active` | `archived`); sin fee, pago, envío, KPI, acuerdo ni publicación.
 *
 * Reglas de oro (las mismas del resto del repo):
 *  · Solo mutan personas (`exigirPersona`); el canal (`ui` | `chat`) y la correlación
 *    viajan en `contexto` y quedan en la auditoría, escrita en la MISMA transacción.
 *  · Recurso de otra organización o actor `cliente` → `RESOURCE_NOT_FOUND`; rol sin la
 *    capacidad → `FORBIDDEN_ROLE`.
 *  · Campaña no activa o participación retirada → no se crean entregables ni se editan;
 *    las lecturas siguen funcionando.
 *  · Las invariantes también las impone la base (claves compuestas, UNIQUE, triggers 023):
 *    aquí se validan antes para devolver errores de dominio claros.
 *  · Orden de bloqueo: acción propuesta → ENTREGABLE → versión → Brief gobernante. Todo
 *    caso de uso que cambie algo relevante del entregable toma `bloquearEntregable` primero.
 *
 * Lectura con PROYECCIÓN según la capacidad: Cuenta (`script:read`) ve el detalle; el
 * Operativo (`deliverable:read` sin `script:read`) solo ve el estado: la última versión
 * `{version, status}` y la aprobada vigente `{version, approvedAt, filename}`; nunca
 * versiones intermedias, hallazgos, comentarios, motivos ni ids de fuente o de versión.
 */

import type pg from 'pg';
import {
  type Deliverable,
  type DeliverableStatus,
  type ResumenDeEntregable,
  type Result,
  type ScriptVersionStatus,
  type SocialPlatform,
  type User,
  authorizeInternalResource,
  err,
  isSocialPlatform,
  normalizarEtiquetaDeEntregable,
  ok,
  resumenDeEntregable,
  roleCan,
} from '@tcl-kol-os/domain';
import { recordAudit } from './audit.ts';
import { type ContextoDeAuditoria, auditoriaDe, exigirPersona } from './audit-context.ts';
import { getPool } from './client.ts';
import { Abortar, transaccionConResultado } from './tx-result.ts';

export const NO_ENCONTRADO_DE_CONTENIDO = {
  code: 'RESOURCE_NOT_FOUND',
  message: 'El recurso no existe o no está disponible.',
} as const;

type Consultor = pg.Pool | pg.PoolClient;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/** Un id mal formado es «no existe» (no una excepción de la base). */
export function esUuid(valor: unknown): valor is string {
  return typeof valor === 'string' && UUID.test(valor);
}

// ─────────────────────────── Filas y mapeo ─────────────────────────────────────

export interface FilaDeEntregable {
  readonly id: string;
  readonly organization_id: string;
  readonly campaign_id: string;
  readonly campaign_influencer_id: string;
  readonly platform: string | null;
  readonly label: string;
  readonly label_key: string;
  readonly campaign_product_id: string | null;
  readonly status: DeliverableStatus;
  readonly archived_at: Date | null;
  readonly last_version: number;
  readonly created_by: string;
  readonly created_at: Date;
  readonly updated_at: Date;
}

export const SELECT_ENTREGABLE = `
  SELECT id, organization_id, campaign_id, campaign_influencer_id, platform::text AS platform, label,
         label_key, campaign_product_id, status, archived_at, last_version, created_by, created_at, updated_at
    FROM deliverables
`;

export function comoEntregable(row: FilaDeEntregable): Deliverable {
  return {
    id: row.id,
    organizationId: row.organization_id,
    campaignId: row.campaign_id,
    campaignInfluencerId: row.campaign_influencer_id,
    platform: row.platform ?? undefined,
    label: row.label,
    labelKey: row.label_key,
    campaignProductId: row.campaign_product_id ?? undefined,
    status: row.status,
    archivedAt: row.archived_at?.toISOString(),
    lastVersion: row.last_version,
    createdBy: row.created_by,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

// ─────────────────────────── Bloqueo y estado de la campaña ────────────────────

/**
 * Bloquea el entregable (`SELECT … FOR UPDATE`) y devuelve su fila. Es el mutex de todo
 * lo que cambia estado relevante: registrar versión, transicionar, comentar, aprobar.
 * Primero la acción propuesta (si la hay), LUEGO esto, luego la versión.
 */
export async function bloquearEntregable(
  client: pg.PoolClient,
  deliverableId: string,
): Promise<FilaDeEntregable | undefined> {
  const { rows } = await client.query<FilaDeEntregable>(`${SELECT_ENTREGABLE} WHERE id = $1 FOR UPDATE`, [
    deliverableId,
  ]);
  return rows[0];
}

/**
 * Traduce un rechazo de las reglas de la base (trigger 023 o CHECK) a un error de dominio:
 * una carrera que pasó la comprobación previa no produce un 500, produce un conflicto.
 */
export function reglaDeBaseComoAbortar(error: unknown): unknown {
  const e = error as { code?: unknown; message?: unknown } | null;
  if (typeof e === 'object' && e !== null) {
    if (e.code === 'P0001') {
      return new Abortar({
        code: 'RESOURCE_CONFLICT',
        message: typeof e.message === 'string' ? e.message : 'La base rechazó la operación.',
        details: { reason: 'db_rule' },
      });
    }
    if (e.code === '23514') {
      return new Abortar({
        code: 'VALIDATION_FAILED',
        message: 'Un valor no cumple las reglas de la base.',
        details: { reason: 'db_check' },
      });
    }
  }
  return error;
}

/** Ejecuta una escritura traduciendo los rechazos de la base. */
export async function conReglasDeBase<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    throw reglaDeBaseComoAbortar(error);
  }
}

/** Campaña activa y participación activa, o el conflicto accionable. */
export async function exigirCampanaYParticipacionActivas(
  db: Consultor,
  entregable: Pick<FilaDeEntregable, 'campaign_id' | 'campaign_influencer_id'>,
): Promise<void> {
  const { rows } = await db.query<{ campana: string; participacion: string }>(
    `SELECT c.status::text AS campana, ci.status::text AS participacion
       FROM campaigns c, campaign_influencers ci
      WHERE c.id = $1 AND ci.id = $2`,
    [entregable.campaign_id, entregable.campaign_influencer_id],
  );
  const fila = rows[0];
  if (fila === undefined) throw new Abortar(NO_ENCONTRADO_DE_CONTENIDO);
  if (fila.campana !== 'activa') {
    throw new Abortar({
      code: 'RESOURCE_CONFLICT',
      message: 'La campaña no está activa: no se crean ni se modifican entregables ni guiones.',
      details: { reason: 'campaign_not_active', campaignId: entregable.campaign_id },
    });
  }
  if (fila.participacion !== 'activo') {
    throw new Abortar({
      code: 'RESOURCE_CONFLICT',
      message: 'El influencer está retirado de la campaña: reactívelo para trabajar su contenido.',
      details: {
        reason: 'campaign_influencer_retired',
        campaignInfluencerId: entregable.campaign_influencer_id,
      },
    });
  }
}

// ─────────────────────────── Proyecciones ──────────────────────────────────────

export interface VersionResumida {
  readonly version: number;
  readonly status: ScriptVersionStatus;
}

export interface VersionVigenteResumida {
  readonly version: number;
  readonly approvedAt: string;
  readonly filename: string;
}

/**
 * Proyección del OPERATIVO: solo el estado. Sin ids de versión ni de fuente, sin versiones
 * intermedias, sin hallazgos, comentarios ni motivos.
 */
export interface EntregableDeEstado {
  readonly projection: 'estado';
  readonly deliverableId: string;
  readonly campaignInfluencerId: string;
  readonly label: string;
  readonly platform: string | undefined;
  readonly status: DeliverableStatus;
  readonly resumen: ResumenDeEntregable;
  readonly latest: VersionResumida | null;
  readonly currentApproved: VersionVigenteResumida | null;
}

/** Proyección de CUENTA (admin, director, consultor): el entregable completo y su estado derivado. */
export interface EntregableDeCuenta {
  readonly projection: 'cuenta';
  readonly deliverable: Deliverable;
  readonly influencerDisplayName: string;
  readonly resumen: ResumenDeEntregable;
  readonly versionCount: number;
  readonly latest: {
    readonly id: string;
    readonly version: number;
    readonly status: ScriptVersionStatus;
    readonly filename: string;
    readonly createdAt: string;
  } | null;
  readonly currentApproved: {
    readonly id: string;
    readonly version: number;
    readonly approvedAt: string;
    readonly filename: string;
  } | null;
}

export type EntregableProyectado = EntregableDeCuenta | EntregableDeEstado;

interface FilaDeListado extends FilaDeEntregable {
  readonly influencer_display_name: string;
  readonly latest_id: string | null;
  readonly latest_version: number | null;
  readonly latest_status: ScriptVersionStatus | null;
  readonly latest_filename: string | null;
  readonly latest_created_at: Date | null;
  readonly approved_id: string | null;
  readonly approved_version: number | null;
  readonly approved_at: Date | null;
  readonly approved_filename: string | null;
}

const SELECT_LISTADO = `
  SELECT d.id, d.organization_id, d.campaign_id, d.campaign_influencer_id, d.platform::text AS platform,
         d.label, d.label_key, d.campaign_product_id, d.status, d.archived_at, d.last_version,
         d.created_by, d.created_at, d.updated_at,
         i.display_name AS influencer_display_name,
         lv.id AS latest_id, lv.version AS latest_version, lv.status AS latest_status,
         lv.source_filename AS latest_filename, lv.created_at AS latest_created_at,
         av.id AS approved_id, av.version AS approved_version, av.approved_at AS approved_at,
         av.source_filename AS approved_filename
    FROM deliverables d
    JOIN campaign_influencers ci ON ci.id = d.campaign_influencer_id
    JOIN influencers i ON i.id = ci.influencer_id
    LEFT JOIN script_versions lv ON lv.deliverable_id = d.id AND lv.version = d.last_version
    LEFT JOIN script_versions av ON av.deliverable_id = d.id AND av.status = 'approved'
`;

/** Pares (versión, estado) de varios entregables, para derivar el resumen sin guardarlo. */
async function versionesParaResumen(
  db: Consultor,
  ids: readonly string[],
): Promise<Map<string, VersionResumida[]>> {
  const porEntregable = new Map<string, VersionResumida[]>();
  if (ids.length === 0) return porEntregable;
  const { rows } = await db.query<{ deliverable_id: string; version: number; status: ScriptVersionStatus }>(
    `SELECT deliverable_id, version, status FROM script_versions WHERE deliverable_id = ANY($1::uuid[])`,
    [ids],
  );
  for (const r of rows) {
    const lista = porEntregable.get(r.deliverable_id) ?? [];
    lista.push({ version: r.version, status: r.status });
    porEntregable.set(r.deliverable_id, lista);
  }
  return porEntregable;
}

function proyectar(
  filas: readonly FilaDeListado[],
  versiones: ReadonlyMap<string, readonly VersionResumida[]>,
  proyeccion: 'cuenta' | 'estado',
): EntregableProyectado[] {
  return filas.map((f) => {
    const todas = versiones.get(f.id) ?? [];
    const resumen = resumenDeEntregable(todas);
    if (proyeccion === 'estado') {
      return {
        projection: 'estado',
        deliverableId: f.id,
        campaignInfluencerId: f.campaign_influencer_id,
        label: f.label,
        platform: f.platform ?? undefined,
        status: f.status,
        resumen,
        latest:
          f.latest_version === null || f.latest_status === null
            ? null
            : { version: f.latest_version, status: f.latest_status },
        currentApproved:
          f.approved_version === null || f.approved_at === null || f.approved_filename === null
            ? null
            : {
                version: f.approved_version,
                approvedAt: f.approved_at.toISOString(),
                filename: f.approved_filename,
              },
      } satisfies EntregableDeEstado;
    }
    return {
      projection: 'cuenta',
      deliverable: comoEntregable(f),
      influencerDisplayName: f.influencer_display_name,
      resumen,
      versionCount: todas.length,
      latest:
        f.latest_id === null ||
        f.latest_version === null ||
        f.latest_status === null ||
        f.latest_filename === null ||
        f.latest_created_at === null
          ? null
          : {
              id: f.latest_id,
              version: f.latest_version,
              status: f.latest_status,
              filename: f.latest_filename,
              createdAt: f.latest_created_at.toISOString(),
            },
      currentApproved:
        f.approved_id === null ||
        f.approved_version === null ||
        f.approved_at === null ||
        f.approved_filename === null
          ? null
          : {
              id: f.approved_id,
              version: f.approved_version,
              approvedAt: f.approved_at.toISOString(),
              filename: f.approved_filename,
            },
    } satisfies EntregableDeCuenta;
  });
}

/** Qué proyección le toca al actor (la decide el servidor, nunca el llamador). */
function proyeccionDe(actor: User): 'cuenta' | 'estado' {
  return roleCan(actor.role, 'script:read') ? 'cuenta' : 'estado';
}

// ─────────────────────────── Crear ─────────────────────────────────────────────

export interface CrearEntregableInput {
  /** La participación (CampaignInfluencer) a la que pertenece el entregable. */
  readonly campaignInfluencerId: string;
  readonly label: string;
  /** Informativa; puede faltar. */
  readonly platform?: SocialPlatform | undefined;
  /** `campaign_products.id` de ESTA campaña, asignado a la participación. Inmutable. */
  readonly campaignProductId?: string | undefined;
}

function conflictoDeEtiqueta(existente: { id: string; status: DeliverableStatus }) {
  return {
    code: 'RESOURCE_CONFLICT',
    message: 'Esa participación ya tiene un entregable activo con esa etiqueta.',
    details: { reason: 'label_already_exists', deliverableId: existente.id },
  } as const;
}

/**
 * Crea un entregable DENTRO de una transacción abierta por el llamador (lo usan
 * `crearEntregable` y el registro de un guion que necesita crear su entregable). Lanza
 * `Abortar` con el error de dominio; no hace COMMIT ni ROLLBACK.
 */
export async function crearEntregableEnTransaccion(
  client: pg.PoolClient,
  actor: User,
  input: CrearEntregableInput,
  contexto?: ContextoDeAuditoria,
): Promise<Deliverable> {
  const etiqueta = normalizarEtiquetaDeEntregable(input.label);
  if (!etiqueta.ok) throw new Abortar(etiqueta.error);
  if (input.platform !== undefined && !isSocialPlatform(input.platform)) {
    throw new Abortar({
      code: 'VALIDATION_FAILED',
      message: 'La plataforma no es válida.',
      details: { field: 'platform' },
    });
  }
  if (!esUuid(input.campaignInfluencerId)) throw new Abortar(NO_ENCONTRADO_DE_CONTENIDO);

  const { rows: participaciones } = await client.query<{
    id: string;
    organization_id: string;
    campaign_id: string;
  }>(`SELECT id, organization_id, campaign_id FROM campaign_influencers WHERE id = $1 FOR SHARE`, [
    input.campaignInfluencerId,
  ]);
  const participacion = participaciones[0];
  if (participacion === undefined) throw new Abortar(NO_ENCONTRADO_DE_CONTENIDO);
  const permitido = authorizeInternalResource(actor, 'deliverable:manage', participacion.organization_id);
  if (!permitido.ok) throw new Abortar(permitido.error);

  await exigirCampanaYParticipacionActivas(client, {
    campaign_id: participacion.campaign_id,
    campaign_influencer_id: participacion.id,
  });

  if (input.campaignProductId !== undefined) {
    if (!esUuid(input.campaignProductId)) throw new Abortar(NO_ENCONTRADO_DE_CONTENIDO);
    const { rows: producto } = await client.query<{ asignado: boolean }>(
      `SELECT EXISTS (
                SELECT 1 FROM campaign_influencer_products
                 WHERE campaign_influencer_id = $1 AND campaign_product_id = $2
              ) AS asignado
         FROM campaign_products WHERE id = $2 AND campaign_id = $3`,
      [participacion.id, input.campaignProductId, participacion.campaign_id],
    );
    // De otra campaña: se responde igual que si no existiera.
    if (producto[0] === undefined) throw new Abortar(NO_ENCONTRADO_DE_CONTENIDO);
    if (!producto[0].asignado) {
      throw new Abortar({
        code: 'VALIDATION_FAILED',
        message: 'El producto no está asignado a este influencer en la campaña.',
        details: { field: 'campaignProductId', reason: 'product_not_assigned' },
      });
    }
  }

  const { rows: existentes } = await client.query<{ id: string; status: DeliverableStatus }>(
    `SELECT id, status FROM deliverables
      WHERE campaign_influencer_id = $1 AND label_key = $2 AND status = 'active'`,
    [participacion.id, etiqueta.value.key],
  );
  if (existentes[0] !== undefined) throw new Abortar(conflictoDeEtiqueta(existentes[0]));

  const creado = await conReglasDeBase(async () => {
    const { rows } = await client.query<FilaDeEntregable>(
      `INSERT INTO deliverables
         (organization_id, campaign_id, campaign_influencer_id, platform, label, label_key,
          campaign_product_id, created_by)
       VALUES ($1, $2, $3, $4::social_platform, $5, $6, $7, $8)
       RETURNING id, organization_id, campaign_id, campaign_influencer_id, platform::text AS platform,
                 label, label_key, campaign_product_id, status, archived_at, last_version,
                 created_by, created_at, updated_at`,
      [
        participacion.organization_id,
        participacion.campaign_id,
        participacion.id,
        input.platform ?? null,
        etiqueta.value.label,
        etiqueta.value.key,
        input.campaignProductId ?? null,
        actor.id,
      ],
    );
    return comoEntregable(rows[0]!);
  });
  await recordAudit(
    client,
    auditoriaDe(actor, contexto, {
      action: 'deliverable.create',
      entityType: 'deliverable',
      entityId: creado.id,
      metadata: {
        campaignId: creado.campaignId,
        campaignInfluencerId: creado.campaignInfluencerId,
        platform: creado.platform ?? null,
        label: creado.label,
      },
    }),
  );
  return creado;
}

/**
 * Crea un entregable. Idempotente por (participación, etiqueta normalizada): repetirlo
 * falla con `RESOURCE_CONFLICT{reason:'label_already_exists', deliverableId}`.
 */
export async function crearEntregable(
  actor: User,
  input: CrearEntregableInput,
  contexto?: ContextoDeAuditoria,
): Promise<Result<Deliverable>> {
  const persona = exigirPersona(actor, contexto);
  if (!persona.ok) return persona;
  // Validación previa (sin abrir transacción) de lo que no depende de la base.
  const etiqueta = normalizarEtiquetaDeEntregable(input.label);
  if (!etiqueta.ok) return etiqueta;

  return transaccionConResultado((client) => crearEntregableEnTransaccion(client, actor, input, contexto), {
    code: 'RESOURCE_CONFLICT',
    message: 'Esa participación ya tiene un entregable activo con esa etiqueta.',
    details: { reason: 'label_already_exists' },
  });
}

// ─────────────────────────── Actualizar / archivar / reactivar ─────────────────

async function cargarParaMutar(
  client: pg.PoolClient,
  actor: User,
  deliverableId: string,
  alcance?: { readonly campaignId: string } | undefined,
): Promise<FilaDeEntregable> {
  if (!esUuid(deliverableId)) throw new Abortar(NO_ENCONTRADO_DE_CONTENIDO);
  const fila = await bloquearEntregable(client, deliverableId);
  if (fila === undefined) throw new Abortar(NO_ENCONTRADO_DE_CONTENIDO);
  if (alcance !== undefined && fila.campaign_id !== alcance.campaignId) {
    throw new Abortar(NO_ENCONTRADO_DE_CONTENIDO);
  }
  const permitido = authorizeInternalResource(actor, 'deliverable:manage', fila.organization_id);
  if (!permitido.ok) throw new Abortar(permitido.error);
  return fila;
}

export interface ActualizarEntregableInput {
  readonly label?: string | undefined;
  /** `null` borra la plataforma informativa. */
  readonly platform?: SocialPlatform | null | undefined;
}

/**
 * Renombra el entregable o ajusta su plataforma informativa. La identidad (participación,
 * producto, campaña) no cambia. Exige campaña y participación activas y entregable activo.
 */
export async function actualizarEntregable(
  actor: User,
  deliverableId: string,
  cambios: ActualizarEntregableInput,
  contexto?: ContextoDeAuditoria,
  alcance?: { readonly campaignId: string } | undefined,
): Promise<Result<Deliverable>> {
  const persona = exigirPersona(actor, contexto);
  if (!persona.ok) return persona;

  let nueva: { label: string; key: string } | undefined;
  if (cambios.label !== undefined) {
    const etiqueta = normalizarEtiquetaDeEntregable(cambios.label);
    if (!etiqueta.ok) return etiqueta;
    nueva = etiqueta.value;
  }
  if (cambios.platform !== undefined && cambios.platform !== null && !isSocialPlatform(cambios.platform)) {
    return err({
      code: 'VALIDATION_FAILED',
      message: 'La plataforma no es válida.',
      details: { field: 'platform' },
    });
  }
  if (nueva === undefined && cambios.platform === undefined) {
    return err({
      code: 'VALIDATION_FAILED',
      message: 'No hay nada que cambiar: indique una etiqueta o una plataforma.',
      details: { field: 'label' },
    });
  }

  return transaccionConResultado(
    async (client) => {
      const actual = await cargarParaMutar(client, actor, deliverableId, alcance);
      if (actual.status !== 'active') {
        throw new Abortar({
          code: 'RESOURCE_CONFLICT',
          message: 'El entregable está archivado: reactívelo para modificarlo.',
          details: { reason: 'deliverable_archived', deliverableId: actual.id },
        });
      }
      await exigirCampanaYParticipacionActivas(client, actual);

      const labelFinal = nueva?.label ?? actual.label;
      const keyFinal = nueva?.key ?? actual.label_key;
      const platformFinal = cambios.platform === undefined ? actual.platform : cambios.platform;
      if (labelFinal === actual.label && platformFinal === actual.platform) {
        return comoEntregable(actual); // nada cambia: sin escritura ni auditoría
      }
      if (keyFinal !== actual.label_key) {
        const { rows: choque } = await client.query<{ id: string; status: DeliverableStatus }>(
          `SELECT id, status FROM deliverables
            WHERE campaign_influencer_id = $1 AND label_key = $2 AND status = 'active' AND id <> $3`,
          [actual.campaign_influencer_id, keyFinal, actual.id],
        );
        if (choque[0] !== undefined) throw new Abortar(conflictoDeEtiqueta(choque[0]));
      }

      const actualizado = await conReglasDeBase(async () => {
        const { rows } = await client.query<FilaDeEntregable>(
          `UPDATE deliverables SET label = $2, label_key = $3, platform = $4::social_platform
            WHERE id = $1
            RETURNING id, organization_id, campaign_id, campaign_influencer_id, platform::text AS platform,
                      label, label_key, campaign_product_id, status, archived_at, last_version,
                      created_by, created_at, updated_at`,
          [actual.id, labelFinal, keyFinal, platformFinal],
        );
        return comoEntregable(rows[0]!);
      });
      await recordAudit(
        client,
        auditoriaDe(actor, contexto, {
          action: 'deliverable.update',
          entityType: 'deliverable',
          entityId: actual.id,
          metadata: {
            campaignId: actual.campaign_id,
            labelAnterior: actual.label,
            label: labelFinal,
            platformAnterior: actual.platform,
            platform: platformFinal,
          },
        }),
      );
      return actualizado;
    },
    {
      code: 'RESOURCE_CONFLICT',
      message: 'Esa participación ya tiene un entregable activo con esa etiqueta.',
      details: { reason: 'label_already_exists' },
    },
  );
}

const MAX_MOTIVO = 500;

async function cambiarEstadoDeEntregable(
  actor: User,
  deliverableId: string,
  destino: DeliverableStatus,
  motivo: string | undefined,
  contexto: ContextoDeAuditoria | undefined,
  alcance: { readonly campaignId: string } | undefined,
): Promise<Result<Deliverable>> {
  const persona = exigirPersona(actor, contexto);
  if (!persona.ok) return persona;

  const motivoLimpio = motivo?.trim();
  if (motivoLimpio !== undefined && motivoLimpio.length > MAX_MOTIVO) {
    return err({
      code: 'VALIDATION_FAILED',
      message: `El motivo no puede superar ${MAX_MOTIVO} caracteres.`,
      details: { field: 'motivo' },
    });
  }

  return transaccionConResultado(
    async (client) => {
      const actual = await cargarParaMutar(client, actor, deliverableId, alcance);
      if (actual.status === destino) {
        throw new Abortar({
          code: 'RESOURCE_CONFLICT',
          message:
            destino === 'archived' ? 'El entregable ya está archivado.' : 'El entregable ya está activo.',
          details: { reason: 'already_in_status', status: destino, deliverableId: actual.id },
        });
      }
      if (destino === 'active') {
        // Reactivar reanuda el trabajo: exige campaña y participación activas, y que no
        // haya otro entregable activo con la misma etiqueta.
        await exigirCampanaYParticipacionActivas(client, actual);
        const { rows: choque } = await client.query<{ id: string; status: DeliverableStatus }>(
          `SELECT id, status FROM deliverables
            WHERE campaign_influencer_id = $1 AND label_key = $2 AND status = 'active' AND id <> $3`,
          [actual.campaign_influencer_id, actual.label_key, actual.id],
        );
        if (choque[0] !== undefined) throw new Abortar(conflictoDeEtiqueta(choque[0]));
      }
      const nuevo = await conReglasDeBase(async () => {
        const { rows } = await client.query<FilaDeEntregable>(
          `UPDATE deliverables
              SET status = $2,
                  archived_at = CASE WHEN $2 = 'archived' THEN now() ELSE NULL END
            WHERE id = $1
            RETURNING id, organization_id, campaign_id, campaign_influencer_id, platform::text AS platform,
                      label, label_key, campaign_product_id, status, archived_at, last_version,
                      created_by, created_at, updated_at`,
          [actual.id, destino],
        );
        return comoEntregable(rows[0]!);
      });
      await recordAudit(
        client,
        auditoriaDe(actor, contexto, {
          action: destino === 'archived' ? 'deliverable.archive' : 'deliverable.unarchive',
          entityType: 'deliverable',
          entityId: actual.id,
          metadata: {
            campaignId: actual.campaign_id,
            estadoAnterior: actual.status,
            ...(motivoLimpio === undefined || motivoLimpio === '' ? {} : { motivo: motivoLimpio }),
          },
        }),
      );
      return nuevo;
    },
    {
      code: 'RESOURCE_CONFLICT',
      message: 'El entregable cambió mientras se actualizaba.',
      details: { reason: 'label_already_exists' },
    },
  );
}

/**
 * Archiva un entregable SIN borrarlo (la historia se conserva) y libera su etiqueta.
 * Las versiones en revisión quedan en pausa: no se crean ni transicionan versiones
 * de un entregable archivado. No es una tool del agente.
 */
export async function archivarEntregable(
  actor: User,
  deliverableId: string,
  opciones: { readonly motivo?: string | undefined } = {},
  contexto?: ContextoDeAuditoria,
  alcance?: { readonly campaignId: string } | undefined,
): Promise<Result<Deliverable>> {
  return cambiarEstadoDeEntregable(actor, deliverableId, 'archived', opciones.motivo, contexto, alcance);
}

/** Reactiva un entregable archivado (si su etiqueta sigue libre y la participación está activa). */
export async function reactivarEntregable(
  actor: User,
  deliverableId: string,
  opciones: { readonly motivo?: string | undefined } = {},
  contexto?: ContextoDeAuditoria,
  alcance?: { readonly campaignId: string } | undefined,
): Promise<Result<Deliverable>> {
  return cambiarEstadoDeEntregable(actor, deliverableId, 'active', opciones.motivo, contexto, alcance);
}

// ─────────────────────────── Lecturas ──────────────────────────────────────────

export interface OpcionesDeLecturaDeEntregable {
  /** Cerco de campaña: un recurso de otra campaña se responde como inexistente. */
  readonly alcance?: { readonly campaignId: string } | undefined;
}

/**
 * Un entregable con su estado derivado. La proyección la decide el rol del actor:
 * Cuenta ve el detalle; el Operativo, solo el estado.
 */
export async function obtenerEntregable(
  actor: User,
  deliverableId: string,
  opciones: OpcionesDeLecturaDeEntregable = {},
): Promise<Result<EntregableProyectado>> {
  if (!esUuid(deliverableId)) return err(NO_ENCONTRADO_DE_CONTENIDO);
  const { rows } = await getPool().query<FilaDeListado>(`${SELECT_LISTADO} WHERE d.id = $1`, [deliverableId]);
  const fila = rows[0];
  if (fila === undefined) return err(NO_ENCONTRADO_DE_CONTENIDO);
  if (opciones.alcance !== undefined && fila.campaign_id !== opciones.alcance.campaignId) {
    return err(NO_ENCONTRADO_DE_CONTENIDO);
  }
  const permitido = authorizeInternalResource(actor, 'deliverable:read', fila.organization_id);
  if (!permitido.ok) return permitido;
  const versiones = await versionesParaResumen(getPool(), [fila.id]);
  return ok(proyectar([fila], versiones, proyeccionDe(actor))[0]!);
}

export interface ListarEntregablesOpciones {
  /** Solo los de una participación. */
  readonly participationId?: string | undefined;
  /** Por defecto solo los activos; `true` incluye los archivados. */
  readonly incluirArchivados?: boolean | undefined;
  readonly limite?: number | undefined;
  readonly desde?: number | undefined;
}

const LIMITE_MAXIMO = 200;
const LIMITE_POR_DEFECTO = 50;

export interface PaginaDeEntregables {
  readonly items: EntregableProyectado[];
  /** Total que cumple el filtro, independiente de la página. */
  readonly total: number;
  readonly limite: number;
  readonly desde: number;
  /** Qué proyección se aplicó (la decide el rol del actor). */
  readonly projection: 'cuenta' | 'estado';
}

/** Los entregables de una campaña con su estado derivado (proyección según el rol). */
export async function listarEntregablesDeCampana(
  actor: User,
  campaignId: string,
  opciones: ListarEntregablesOpciones = {},
): Promise<Result<PaginaDeEntregables>> {
  if (!esUuid(campaignId) || (opciones.participationId !== undefined && !esUuid(opciones.participationId))) {
    return err(NO_ENCONTRADO_DE_CONTENIDO);
  }
  const { rows: campanas } = await getPool().query<{ organization_id: string }>(
    `SELECT organization_id FROM campaigns WHERE id = $1`,
    [campaignId],
  );
  if (campanas[0] === undefined) return err(NO_ENCONTRADO_DE_CONTENIDO);
  const permitido = authorizeInternalResource(actor, 'deliverable:read', campanas[0].organization_id);
  if (!permitido.ok) return permitido;

  const limite = Math.min(Math.max(Math.trunc(opciones.limite ?? LIMITE_POR_DEFECTO), 1), LIMITE_MAXIMO);
  const desde = Math.max(Math.trunc(opciones.desde ?? 0), 0);
  const filtroEstado = opciones.incluirArchivados === true ? '' : `AND d.status = 'active'`;
  const filtroParticipacion =
    opciones.participationId === undefined ? '' : `AND d.campaign_influencer_id = $3`;
  const parametros: unknown[] = [campaignId, campanas[0].organization_id];
  if (opciones.participationId !== undefined) parametros.push(opciones.participationId);

  const { rows: conteo } = await getPool().query<{ total: number }>(
    `SELECT count(*)::int AS total FROM deliverables d
      WHERE d.campaign_id = $1 AND d.organization_id = $2 ${filtroEstado} ${filtroParticipacion}`,
    parametros,
  );
  const { rows } = await getPool().query<FilaDeListado>(
    `${SELECT_LISTADO}
      WHERE d.campaign_id = $1 AND d.organization_id = $2 ${filtroEstado} ${filtroParticipacion}
      ORDER BY ci.created_at, d.created_at, d.id
      LIMIT ${limite} OFFSET ${desde}`,
    parametros,
  );
  const versiones = await versionesParaResumen(
    getPool(),
    rows.map((r) => r.id),
  );
  const proyeccion = proyeccionDe(actor);
  return ok({
    items: proyectar(rows, versiones, proyeccion),
    total: conteo[0]?.total ?? 0,
    limite,
    desde,
    projection: proyeccion,
  });
}
