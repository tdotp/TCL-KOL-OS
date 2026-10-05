/**
 * Participación de un influencer en una campaña (`CampaignInfluencer`) y los
 * productos de ESA campaña que trabaja (V2 · Fase 3).
 *
 * `CampaignInfluencer` es el punto de anclaje de lo que venga después (acuerdo,
 * entregables, guiones, operación, KPIs). Esta capa solo conoce: la relación,
 * su estado (`activo` / `retirado`) y los `campaign_products` asignados.
 *
 * Las invariantes también las impone la base (claves compuestas por
 * organización y campaña, UNIQUE): aquí se validan antes para devolver errores
 * de dominio claros y auditar en la misma transacción.
 */

import type pg from 'pg';
import {
  type AssignedProduct,
  type CampaignInfluencer,
  type CampaignInfluencerDetail,
  type CampaignInfluencerStatus,
  type Result,
  type User,
  authorizeInternalResource,
  err,
  ok,
} from '@tcl-kol-os/domain';
import { recordAudit } from './audit.ts';
import { getPool } from './client.ts';
import {
  type ContextoDeAuditoria,
  NO_ENCONTRADO,
  SELECT_INFLUENCER,
  type InfluencerRow,
  auditoriaDe,
  comoInfluencer,
  cuentasDe,
  exigirPersona,
} from './influencers.ts';
import { Abortar, transaccionConResultado } from './tx-result.ts';

// ─────────────────────────── Filas ─────────────────────────────────────────────

interface CampaignInfluencerRow {
  readonly id: string;
  readonly organization_id: string;
  readonly campaign_id: string;
  readonly influencer_id: string;
  readonly status: CampaignInfluencerStatus;
  readonly retired_at: Date | null;
  readonly created_by: string;
  readonly created_at: Date;
  readonly updated_at: Date;
}

const SELECT_PARTICIPACION = `
  SELECT id, organization_id, campaign_id, influencer_id, status, retired_at, created_by,
         created_at, updated_at
    FROM campaign_influencers
`;

function comoParticipacion(row: CampaignInfluencerRow): CampaignInfluencer {
  return {
    id: row.id,
    organizationId: row.organization_id,
    campaignId: row.campaign_id,
    influencerId: row.influencer_id,
    status: row.status,
    retiredAt: row.retired_at?.toISOString(),
    createdBy: row.created_by,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

interface AsignacionRow {
  readonly campaign_influencer_id: string;
  readonly campaign_product_id: string;
  readonly product_id: string;
  readonly brand: string;
  readonly model: string;
  readonly category: string;
  readonly rol: string;
  readonly created_at: Date;
}

const SELECT_ASIGNACIONES = `
  SELECT cip.campaign_influencer_id, cp.id AS campaign_product_id, cp.product_id,
         p.brand, p.model, p.category, cp.rol, cip.created_at
    FROM campaign_influencer_products cip
    JOIN campaign_products cp ON cp.id = cip.campaign_product_id
    JOIN products p ON p.id = cp.product_id
`;

function comoProductoAsignado(row: AsignacionRow): AssignedProduct {
  return {
    campaignProductId: row.campaign_product_id,
    productId: row.product_id,
    brand: row.brand,
    model: row.model,
    category: row.category,
    rol: row.rol,
    assignedAt: row.created_at.toISOString(),
  };
}

type Consultor = pg.Pool | pg.PoolClient;

async function productosDe(
  db: Consultor,
  participacionIds: readonly string[],
): Promise<Map<string, AssignedProduct[]>> {
  const porParticipacion = new Map<string, AssignedProduct[]>();
  if (participacionIds.length === 0) return porParticipacion;
  const { rows } = await db.query<AsignacionRow>(
    `${SELECT_ASIGNACIONES} WHERE cip.campaign_influencer_id = ANY($1::uuid[]) ORDER BY cp.prioridad, p.model`,
    [participacionIds],
  );
  for (const row of rows) {
    const lista = porParticipacion.get(row.campaign_influencer_id) ?? [];
    lista.push(comoProductoAsignado(row));
    porParticipacion.set(row.campaign_influencer_id, lista);
  }
  return porParticipacion;
}

// ─────────────────────────── Carga con autorización ────────────────────────────

/** Organización de la campaña, o `NO_ENCONTRADO`. */
async function organizacionDeCampana(db: Consultor, campaignId: string): Promise<string> {
  const { rows } = await db.query<{ organization_id: string }>(
    `SELECT organization_id FROM campaigns WHERE id = $1`,
    [campaignId],
  );
  const fila = rows[0];
  if (fila === undefined) throw new Abortar(NO_ENCONTRADO);
  return fila.organization_id;
}

async function cargarParticipacionParaMutar(
  client: pg.PoolClient,
  actor: User,
  participacionId: string,
): Promise<CampaignInfluencerRow> {
  const { rows } = await client.query<CampaignInfluencerRow>(
    `${SELECT_PARTICIPACION} WHERE id = $1 FOR UPDATE`,
    [participacionId],
  );
  const fila = rows[0];
  if (fila === undefined) throw new Abortar(NO_ENCONTRADO);
  const permitido = authorizeInternalResource(actor, 'campaign_influencer:manage', fila.organization_id);
  if (!permitido.ok) throw new Abortar(permitido.error);
  return fila;
}

/** Leer el detalle exige poder leer la participación Y la identidad. */
function autorizarLectura(actor: User, organizationId: string): Result<true> {
  const permitido = authorizeInternalResource(actor, 'campaign_influencer:read', organizationId);
  if (!permitido.ok) return permitido;
  return authorizeInternalResource(actor, 'influencer:read', organizationId);
}

const CONFLICTO_PARTICIPACION = {
  code: 'RESOURCE_CONFLICT',
  message: 'El influencer ya participa en esta campaña.',
  details: { reason: 'already_associated' },
} as const;

// ─────────────────────────── Participación ─────────────────────────────────────

export interface AsociarInfluencerInput {
  readonly campaignId: string;
  readonly influencerId: string;
}

/**
 * Asocia un influencer a una campaña. Como máximo una participación por
 * (campaña, influencer): una segunda llamada falla con `RESOURCE_CONFLICT` e
 * indica la existente y su estado — también si está retirada: volver a
 * activarla es una acción explícita (`reactivarInfluencerEnCampana`), no un
 * efecto lateral de asociar de nuevo.
 */
export async function asociarInfluencerACampana(
  actor: User,
  input: AsociarInfluencerInput,
  contexto?: ContextoDeAuditoria,
): Promise<Result<CampaignInfluencer>> {
  const persona = exigirPersona(actor, contexto);
  if (!persona.ok) return persona;

  return transaccionConResultado(async (client) => {
    const organizationId = await organizacionDeCampana(client, input.campaignId);
    const permitido = authorizeInternalResource(actor, 'campaign_influencer:manage', organizationId);
    if (!permitido.ok) throw new Abortar(permitido.error);

    // El influencer debe ser de la misma organización que la campaña.
    const { rows: influencers } = await client.query<{ id: string }>(
      `SELECT id FROM influencers WHERE id = $1 AND organization_id = $2`,
      [input.influencerId, organizationId],
    );
    if (influencers[0] === undefined) throw new Abortar(NO_ENCONTRADO);

    const { rows: existentes } = await client.query<CampaignInfluencerRow>(
      `${SELECT_PARTICIPACION} WHERE campaign_id = $1 AND influencer_id = $2`,
      [input.campaignId, input.influencerId],
    );
    if (existentes[0] !== undefined) {
      throw new Abortar({
        ...CONFLICTO_PARTICIPACION,
        details: {
          reason: 'already_associated',
          campaignInfluencerId: existentes[0].id,
          status: existentes[0].status,
        },
      });
    }

    const { rows } = await client.query<CampaignInfluencerRow>(
      `INSERT INTO campaign_influencers (organization_id, campaign_id, influencer_id, created_by)
       VALUES ($1, $2, $3, $4)
       RETURNING id, organization_id, campaign_id, influencer_id, status, retired_at, created_by,
                 created_at, updated_at`,
      [organizationId, input.campaignId, input.influencerId, actor.id],
    );
    const creada = comoParticipacion(rows[0]!);
    await recordAudit(
      client,
      auditoriaDe(actor, contexto, {
        action: 'campaign_influencer.associate',
        entityType: 'campaign_influencer',
        entityId: creada.id,
        metadata: { campaignId: creada.campaignId, influencerId: creada.influencerId },
      }),
    );
    return creada;
  }, CONFLICTO_PARTICIPACION);
}

const MAX_MOTIVO = 500;

/**
 * Retira a un influencer de la campaña SIN borrar la participación: conserva su
 * historia (y los productos asignados) y puede reactivarse. Mientras está
 * retirado no admite cambios de producto.
 */
export async function retirarInfluencerDeCampana(
  actor: User,
  participacionId: string,
  opciones: { readonly motivo?: string | undefined } = {},
  contexto?: ContextoDeAuditoria,
): Promise<Result<CampaignInfluencer>> {
  return cambiarEstado(actor, participacionId, 'retirado', opciones.motivo, contexto);
}

export async function reactivarInfluencerEnCampana(
  actor: User,
  participacionId: string,
  opciones: { readonly motivo?: string | undefined } = {},
  contexto?: ContextoDeAuditoria,
): Promise<Result<CampaignInfluencer>> {
  return cambiarEstado(actor, participacionId, 'activo', opciones.motivo, contexto);
}

async function cambiarEstado(
  actor: User,
  participacionId: string,
  destino: CampaignInfluencerStatus,
  motivo: string | undefined,
  contexto: ContextoDeAuditoria | undefined,
): Promise<Result<CampaignInfluencer>> {
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
      const actual = await cargarParticipacionParaMutar(client, actor, participacionId);
      if (actual.status === destino) {
        throw new Abortar({
          code: 'RESOURCE_CONFLICT',
          message:
            destino === 'retirado'
              ? 'El influencer ya está retirado de la campaña.'
              : 'El influencer ya está activo en la campaña.',
          details: { reason: 'already_in_status', status: destino, campaignInfluencerId: actual.id },
        });
      }
      const { rows } = await client.query<CampaignInfluencerRow>(
        `UPDATE campaign_influencers
            SET status = $2::campaign_influencer_status,
                retired_at = CASE WHEN $2::campaign_influencer_status = 'retirado' THEN now() ELSE NULL END
          WHERE id = $1
          RETURNING id, organization_id, campaign_id, influencer_id, status, retired_at, created_by,
                    created_at, updated_at`,
        [participacionId, destino],
      );
      const nueva = comoParticipacion(rows[0]!);
      await recordAudit(
        client,
        auditoriaDe(actor, contexto, {
          action: destino === 'retirado' ? 'campaign_influencer.retire' : 'campaign_influencer.reactivate',
          entityType: 'campaign_influencer',
          entityId: nueva.id,
          metadata: {
            campaignId: nueva.campaignId,
            influencerId: nueva.influencerId,
            estadoAnterior: actual.status,
            ...(motivoLimpio === undefined || motivoLimpio === '' ? {} : { motivo: motivoLimpio }),
          },
        }),
      );
      return nueva;
    },
    { code: 'RESOURCE_CONFLICT', message: 'La participación cambió mientras se actualizaba.' },
  );
}

// ─────────────────────────── Lecturas ──────────────────────────────────────────

export async function obtenerCampaignInfluencer(
  actor: User,
  participacionId: string,
): Promise<Result<CampaignInfluencerDetail>> {
  const { rows } = await getPool().query<CampaignInfluencerRow>(`${SELECT_PARTICIPACION} WHERE id = $1`, [
    participacionId,
  ]);
  const fila = rows[0];
  if (fila === undefined) return err(NO_ENCONTRADO);
  const permitido = autorizarLectura(actor, fila.organization_id);
  if (!permitido.ok) return permitido;

  const detalles = await detallesDe(getPool(), [fila]);
  return ok(detalles[0]!);
}

export interface ListarParticipantesOpciones {
  /** Por defecto solo los activos; `true` incluye los retirados (historia). */
  readonly incluirRetirados?: boolean | undefined;
  /**
   * Paginación opcional (V2 · Fase 6): sin `limite` se devuelven todos, como
   * siempre. Con `limite` se acota (1–500) y `desde` es el desplazamiento.
   */
  readonly limite?: number | undefined;
  readonly desde?: number | undefined;
}

/** Tope duro de una página de participantes. */
const LIMITE_MAXIMO_PARTICIPANTES = 500;

/** Una página de participantes con el total real (aditivo, V2 · Fase 6). */
export interface PaginaDeParticipantes {
  readonly items: CampaignInfluencerDetail[];
  /** Total que cumple el filtro (con o sin retirados), independiente de la página. */
  readonly total: number;
  readonly activos: number;
  readonly retirados: number;
  readonly limite: number | undefined;
  readonly desde: number;
}

async function paginaDeParticipantes(
  actor: User,
  campaignId: string,
  opciones: ListarParticipantesOpciones,
): Promise<Result<PaginaDeParticipantes>> {
  const { rows: campanas } = await getPool().query<{ organization_id: string }>(
    `SELECT organization_id FROM campaigns WHERE id = $1`,
    [campaignId],
  );
  if (campanas[0] === undefined) return err(NO_ENCONTRADO);
  const permitido = autorizarLectura(actor, campanas[0].organization_id);
  if (!permitido.ok) return permitido;

  const incluirRetirados = opciones.incluirRetirados === true;
  const limite =
    opciones.limite === undefined
      ? undefined
      : Math.min(Math.max(Math.trunc(opciones.limite), 1), LIMITE_MAXIMO_PARTICIPANTES);
  const desde = Math.max(Math.trunc(opciones.desde ?? 0), 0);

  const { rows: conteos } = await getPool().query<{ activos: number; retirados: number }>(
    `SELECT count(*) FILTER (WHERE status = 'activo')::int AS activos,
            count(*) FILTER (WHERE status = 'retirado')::int AS retirados
       FROM campaign_influencers WHERE campaign_id = $1`,
    [campaignId],
  );
  const activos = conteos[0]?.activos ?? 0;
  const retirados = conteos[0]?.retirados ?? 0;

  const { rows } = await getPool().query<CampaignInfluencerRow>(
    `${SELECT_PARTICIPACION}
      WHERE campaign_id = $1 ${incluirRetirados ? '' : `AND status = 'activo'`}
      ORDER BY created_at, id
      ${limite === undefined ? '' : 'LIMIT $2 OFFSET $3'}`,
    limite === undefined ? [campaignId] : [campaignId, limite, desde],
  );
  return ok({
    items: await detallesDe(getPool(), rows),
    total: incluirRetirados ? activos + retirados : activos,
    activos,
    retirados,
    limite,
    desde,
  });
}

export async function listarInfluencersDeCampana(
  actor: User,
  campaignId: string,
  opciones: ListarParticipantesOpciones = {},
): Promise<Result<CampaignInfluencerDetail[]>> {
  const pagina = await paginaDeParticipantes(actor, campaignId, opciones);
  if (!pagina.ok) return pagina;
  return ok(pagina.value.items);
}

/**
 * Misma lectura y mismo alcance que `listarInfluencersDeCampana`, pero devuelve
 * además el conteo total (activos/retirados): lo que necesita quien solo puede
 * mostrar una página y debe decir cuántos quedaron fuera (V2 · Fase 6).
 */
export async function listarInfluencersDeCampanaConConteo(
  actor: User,
  campaignId: string,
  opciones: ListarParticipantesOpciones = {},
): Promise<Result<PaginaDeParticipantes>> {
  return paginaDeParticipantes(actor, campaignId, opciones);
}

async function detallesDe(
  db: Consultor,
  participaciones: readonly CampaignInfluencerRow[],
): Promise<CampaignInfluencerDetail[]> {
  if (participaciones.length === 0) return [];
  const { rows: influencers } = await db.query<InfluencerRow>(
    `${SELECT_INFLUENCER} WHERE id = ANY($1::uuid[])`,
    [participaciones.map((p) => p.influencer_id)],
  );
  const porId = new Map(influencers.map((i) => [i.id, i]));
  const cuentas = await cuentasDe(
    db,
    influencers.map((i) => i.id),
  );
  const productos = await productosDe(
    db,
    participaciones.map((p) => p.id),
  );

  return participaciones.map((p) => ({
    campaignInfluencer: comoParticipacion(p),
    influencer: comoInfluencer(porId.get(p.influencer_id)!),
    accounts: cuentas.get(p.influencer_id) ?? [],
    products: productos.get(p.id) ?? [],
  }));
}

// ─────────────────────────── Producto asignado ─────────────────────────────────

export interface ProductoDeInfluencerInput {
  readonly campaignInfluencerId: string;
  /** `campaign_products.id`: el producto EN esta campaña (no el catálogo). */
  readonly campaignProductId: string;
}

function exigirParticipacionActiva(fila: CampaignInfluencerRow): void {
  if (fila.status !== 'activo') {
    throw new Abortar({
      code: 'RESOURCE_CONFLICT',
      message: 'El influencer está retirado de la campaña: reactívelo para cambiar sus productos.',
      details: { reason: 'campaign_influencer_retired', campaignInfluencerId: fila.id },
    });
  }
}

const CONFLICTO_ASIGNACION = {
  code: 'RESOURCE_CONFLICT',
  message: 'Ese producto ya está asignado al influencer en esta campaña.',
  details: { reason: 'product_already_assigned' },
} as const;

export async function asociarProductoAInfluencer(
  actor: User,
  input: ProductoDeInfluencerInput,
  contexto?: ContextoDeAuditoria,
): Promise<Result<AssignedProduct>> {
  const persona = exigirPersona(actor, contexto);
  if (!persona.ok) return persona;

  return transaccionConResultado(async (client) => {
    const participacion = await cargarParticipacionParaMutar(client, actor, input.campaignInfluencerId);
    exigirParticipacionActiva(participacion);

    // El producto debe ser de ESTA campaña. Que sea de otra (aunque sea de la
    // misma organización) se responde igual que si no existiera.
    const { rows: productos } = await client.query<{ id: string; product_id: string }>(
      `SELECT id, product_id FROM campaign_products WHERE id = $1 AND campaign_id = $2`,
      [input.campaignProductId, participacion.campaign_id],
    );
    if (productos[0] === undefined) throw new Abortar(NO_ENCONTRADO);

    const { rows: existentes } = await client.query(
      `SELECT 1 FROM campaign_influencer_products WHERE campaign_influencer_id = $1 AND campaign_product_id = $2`,
      [participacion.id, input.campaignProductId],
    );
    if (existentes[0] !== undefined) throw new Abortar(CONFLICTO_ASIGNACION);

    await client.query(
      `INSERT INTO campaign_influencer_products (campaign_id, campaign_influencer_id, campaign_product_id, created_by)
       VALUES ($1, $2, $3, $4)`,
      [participacion.campaign_id, participacion.id, input.campaignProductId, actor.id],
    );
    const { rows } = await client.query<AsignacionRow>(
      `${SELECT_ASIGNACIONES} WHERE cip.campaign_influencer_id = $1 AND cip.campaign_product_id = $2`,
      [participacion.id, input.campaignProductId],
    );
    const asignado = comoProductoAsignado(rows[0]!);
    await recordAudit(
      client,
      auditoriaDe(actor, contexto, {
        action: 'campaign_influencer.product_assign',
        entityType: 'campaign_influencer',
        entityId: participacion.id,
        metadata: {
          campaignId: participacion.campaign_id,
          influencerId: participacion.influencer_id,
          campaignProductId: asignado.campaignProductId,
          productId: asignado.productId,
          model: asignado.model,
        },
      }),
    );
    return asignado;
  }, CONFLICTO_ASIGNACION);
}

/** Quita el vínculo con el producto. No borra el producto ni la participación. */
export async function desasociarProducto(
  actor: User,
  input: ProductoDeInfluencerInput,
  contexto?: ContextoDeAuditoria,
): Promise<Result<true>> {
  const persona = exigirPersona(actor, contexto);
  if (!persona.ok) return persona;

  return transaccionConResultado(
    async (client) => {
      const participacion = await cargarParticipacionParaMutar(client, actor, input.campaignInfluencerId);
      exigirParticipacionActiva(participacion);

      const { rows } = await client.query<AsignacionRow>(
        `${SELECT_ASIGNACIONES} WHERE cip.campaign_influencer_id = $1 AND cip.campaign_product_id = $2`,
        [participacion.id, input.campaignProductId],
      );
      if (rows[0] === undefined) throw new Abortar(NO_ENCONTRADO);

      await client.query(
        `DELETE FROM campaign_influencer_products WHERE campaign_influencer_id = $1 AND campaign_product_id = $2`,
        [participacion.id, input.campaignProductId],
      );
      await recordAudit(
        client,
        auditoriaDe(actor, contexto, {
          action: 'campaign_influencer.product_unassign',
          entityType: 'campaign_influencer',
          entityId: participacion.id,
          metadata: {
            campaignId: participacion.campaign_id,
            influencerId: participacion.influencer_id,
            campaignProductId: rows[0].campaign_product_id,
            productId: rows[0].product_id,
            model: rows[0].model,
          },
        }),
      );
      return true as const;
    },
    { code: 'RESOURCE_CONFLICT', message: 'La asignación cambió mientras se actualizaba.' },
  );
}
