/**
 * Repositorio de campañas.
 *
 * Dos capas de defensa, deliberadamente redundantes:
 *  1. La política de `packages/domain` decide si el actor puede (ADR-008: aquí
 *     no se redefine ninguna regla, solo se aplica).
 *  2. Toda consulta filtra por `organization_id` en el propio SQL.
 *
 * La redundancia es intencional: si alguien olvida el `authorize()` en una ruta
 * nueva, el filtro de SQL sigue impidiendo el acceso cruzado (caso S-01).
 */

import { authorize, type CampaignProduct, type Result, type User, err, ok } from '@tcl-kol-os/domain';
import { assertCapability } from './authz.ts';
import { getPool, transaction } from './client.ts';
import { recordAudit } from './audit.ts';
import { type ContextoDeAuditoria, auditoriaDe, exigirPersona } from './audit-context.ts';
import { Abortar, transaccionConResultado } from './tx-result.ts';

/**
 * Comprobación de capacidad, sin recurso de por medio.
 *
 * Para **crear** o **listar** no existe todavía un recurso cuya existencia
 * proteger, así que la respuesta correcta es `FORBIDDEN_ROLE`: decir
 * "no encontrado" sería engañoso y dificultaría diagnosticar un permiso mal
 * configurado.
 *
 * `authorize()` sigue usándose para recursos concretos, donde sí hay que
 * ocultar la existencia (caso S-01).
 */
// ─────────────────────────── Tipos ────────────────────────────────────────────

export interface CampaignProductInput {
  readonly productId: string;
  readonly rol?: 'flagship' | 'secundario' | 'entrada' | 'unico' | undefined;
  readonly prioridad?: number | undefined;
  readonly participacionPresupuesto?: number | undefined;
}

export interface CreateCampaignInput {
  readonly name: string;
  readonly market?: string | undefined;
  readonly category?: string | undefined;
  readonly ownerId: string;
  readonly startDate?: string | undefined;
  readonly endDate?: string | undefined;
  readonly productos: readonly CampaignProductInput[];
}

export interface CampaignRow {
  readonly id: string;
  readonly organization_id: string;
  readonly name: string;
  readonly market: string;
  readonly category: string | null;
  readonly owner_id: string;
  readonly owner_name: string;
  readonly start_date: Date | null;
  readonly end_date: Date | null;
  readonly status: 'activa' | 'archivada' | 'cancelada';
  readonly confidentiality_level: string;
  readonly visibility: string;
  readonly created_at: Date;
}

export interface CampaignProductRow {
  readonly id: string;
  readonly product_id: string;
  readonly brand: string;
  readonly model: string;
  readonly category: string;
  readonly rol: string;
  readonly prioridad: number;
  readonly participacion_presupuesto: string | null;
}

export interface CampaignWithProducts {
  readonly campaign: CampaignRow;
  readonly productos: readonly CampaignProductRow[];
  /**
   * DEC-016 / historia E3-9: el reparto declarado puede no sumar 1.
   * El brief P80 declara 0.6 + 0.2 + 0.1 = 0.9. No se bloquea; se avisa.
   */
  readonly avisoPresupuesto: string | undefined;
}

const SELECT_CAMPAIGN = `
  SELECT c.id, c.organization_id, c.name, c.market, c.category, c.owner_id,
         u.name AS owner_name, c.start_date, c.end_date, c.status,
         c.confidentiality_level, c.visibility, c.created_at
    FROM campaigns c
    JOIN users u ON u.id = c.owner_id
`;

// ─────────────────────────── Consultas ────────────────────────────────────────

function scopeOf(row: Pick<CampaignRow, 'organization_id' | 'confidentiality_level' | 'visibility'>) {
  return {
    organizationId: row.organization_id,
    confidentialityLevel: row.confidentiality_level as 'publica' | 'interna' | 'confidencial' | 'sensible',
    visibility: row.visibility as 'interna' | 'tcl' | 'compartida',
    createdBy: '',
  };
}

export async function listCampaigns(actor: User): Promise<Result<CampaignRow[]>> {
  const permitido = assertCapability(actor, 'campaign:read');
  if (!permitido.ok) return err({ code: permitido.error.code, message: permitido.error.message });

  // El cliente TCL es de OTRA organización por definición (DEC-012) — un
  // `organization_id = $actor` lo dejaría sin ver nunca nada, sin importar
  // la visibilidad (defecto real, encontrado en Sprint 5 al ejercitar por
  // primera vez la revisión del cliente de punta a punta: `canAccessResource`
  // ya trata `visibility` como el único límite para `cliente`, pero esta
  // consulta seguía filtrando por organización primero). Ve lo que se le
  // compartió, de cualquier organización; el resto de roles sigue viendo
  // solo lo de la suya, como siempre.
  const { rows } = await getPool().query<CampaignRow>(
    actor.role === 'cliente'
      ? `${SELECT_CAMPAIGN} WHERE c.visibility IN ('tcl', 'compartida') ORDER BY c.created_at DESC`
      : `${SELECT_CAMPAIGN} WHERE c.organization_id = $1 ORDER BY c.created_at DESC`,
    actor.role === 'cliente' ? [] : [actor.organizationId],
  );
  return ok(rows);
}

export async function getCampaign(actor: User, id: string): Promise<Result<CampaignWithProducts>> {
  const { rows } = await getPool().query<CampaignRow>(`${SELECT_CAMPAIGN} WHERE c.id = $1`, [id]);
  const campaign = rows[0];

  // No existe, o es de otra organización: la respuesta es la misma.
  // Distinguirlas revelaría que el recurso existe (caso S-01).
  if (campaign === undefined) {
    return err({ code: 'RESOURCE_NOT_FOUND', message: 'El recurso no existe o no está disponible.' });
  }

  const permitido = authorize(actor, 'campaign:read', scopeOf(campaign));
  if (!permitido.ok) {
    return err({ code: 'RESOURCE_NOT_FOUND', message: 'El recurso no existe o no está disponible.' });
  }

  const { rows: productos } = await getPool().query<CampaignProductRow>(
    `SELECT cp.id, cp.product_id, p.brand, p.model, p.category,
            cp.rol, cp.prioridad, cp.participacion_presupuesto
       FROM campaign_products cp
       JOIN products p ON p.id = cp.product_id
      WHERE cp.campaign_id = $1
      ORDER BY cp.prioridad ASC`,
    [id],
  );

  return ok({ campaign, productos, avisoPresupuesto: avisoDeReparto(productos) });
}

/**
 * `CampaignProductRow` (forma de fila SQL) sigue siendo responsabilidad de
 * esta capa de persistencia — DEC-029 no la elimina. Lo que cruza hacia
 * `apps/web` es el tipo de negocio de dominio; este mapeo es la frontera.
 */
export function comoProductoDeDominio(row: CampaignProductRow, campaignId: string): CampaignProduct {
  return {
    id: row.id,
    campaignId,
    productId: row.product_id,
    rol: row.rol as CampaignProduct['rol'],
    prioridad: row.prioridad,
    participacionPresupuesto:
      row.participacion_presupuesto === null ? undefined : Number(row.participacion_presupuesto),
  };
}

/** Historia E3-9. Devuelve el aviso o `undefined` si el reparto está bien. */
export function avisoDeReparto(productos: readonly CampaignProductRow[]): string | undefined {
  const declarados = productos.filter((p) => p.participacion_presupuesto !== null);
  if (declarados.length === 0) return undefined;

  const suma = declarados.reduce((acc, p) => acc + Number(p.participacion_presupuesto), 0);
  const porcentaje = Math.round(suma * 1000) / 10;
  if (Math.abs(suma - 1) < 0.001) return undefined;

  if (declarados.length < productos.length) {
    return `El reparto de presupuesto suma ${porcentaje}% y ${productos.length - declarados.length} producto(s) no lo declaran.`;
  }
  return `El reparto de presupuesto suma ${porcentaje}%, no 100%.`;
}

// ─────────────────────────── Mutaciones ───────────────────────────────────────

export async function createCampaign(
  actor: User,
  input: CreateCampaignInput,
): Promise<Result<{ id: string }>> {
  const permitido = assertCapability(actor, 'campaign:create');
  if (!permitido.ok) return err({ code: permitido.error.code, message: permitido.error.message });

  if (input.productos.length === 0) {
    return err({
      code: 'BRIEF_MISSING_CRITICAL_FIELD',
      message: 'Una campaña debe cubrir al menos un producto (DEC-016).',
    });
  }

  const idsUnicos = new Set(input.productos.map((p) => p.productId));
  if (idsUnicos.size !== input.productos.length) {
    return err({
      code: 'BRIEF_MISSING_CRITICAL_FIELD',
      message: 'Un producto no puede aparecer dos veces en la misma campaña.',
    });
  }

  const id = await transaction(async (client) => {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO campaigns (organization_id, name, market, category, owner_id, start_date, end_date, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id`,
      [
        actor.organizationId,
        input.name,
        input.market ?? 'CO',
        input.category ?? null,
        input.ownerId,
        input.startDate ?? null,
        input.endDate ?? null,
        actor.id,
      ],
    );
    const campaignId = rows[0]!.id;

    for (const [indice, producto] of input.productos.entries()) {
      await client.query(
        `INSERT INTO campaign_products (campaign_id, product_id, rol, prioridad, participacion_presupuesto)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          campaignId,
          producto.productId,
          producto.rol ?? (input.productos.length === 1 ? 'unico' : 'secundario'),
          producto.prioridad ?? indice + 1,
          producto.participacionPresupuesto ?? null,
        ],
      );
    }

    await recordAudit(client, {
      actor,
      action: 'campaign.create',
      entityType: 'campaign',
      entityId: campaignId,
      metadata: { name: input.name, productos: input.productos.length },
    });

    return campaignId;
  });

  return ok({ id });
}

export async function archiveCampaign(actor: User, id: string): Promise<Result<true>> {
  const actual = await getCampaign(actor, id);
  if (!actual.ok) return err({ code: actual.error.code, message: actual.error.message });

  const permitido = authorize(actor, 'campaign:archive', scopeOf(actual.value.campaign));
  if (!permitido.ok) return err({ code: permitido.error.code, message: permitido.error.message });

  await transaction(async (client) => {
    await client.query(`UPDATE campaigns SET status = 'archivada' WHERE id = $1`, [id]);
    await recordAudit(client, {
      actor,
      action: 'campaign.archive',
      entityType: 'campaign',
      entityId: id,
      metadata: { estadoAnterior: actual.value.campaign.status },
    });
  });

  return ok(true);
}

// ─────────────────────────── Actualizar metadatos (V2 · Fase 6) ───────────────

export interface ActualizarCampanaInput {
  readonly name?: string | undefined;
  /** `YYYY-MM-DD`; `null` la borra. Ausente = no se toca. */
  readonly startDate?: string | null | undefined;
  readonly endDate?: string | null | undefined;
}

export interface CampanaActualizada {
  readonly cambios: readonly ('name' | 'startDate' | 'endDate')[];
  readonly antes: { name: string; startDate: string | null; endDate: string | null };
  readonly despues: { name: string; startDate: string | null; endDate: string | null };
}

const LONGITUD_MAXIMA_NOMBRE = 200;

function fechaIsoValida(valor: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(valor)) return false;
  const [anio, mes, dia] = valor.split('-').map(Number) as [number, number, number];
  const fecha = new Date(Date.UTC(anio, mes - 1, dia));
  return fecha.getUTCFullYear() === anio && fecha.getUTCMonth() === mes - 1 && fecha.getUTCDate() === dia;
}

/**
 * Actualiza el nombre y las fechas de una campaña ACTIVA. Es el único cambio de
 * metadatos que existe: no toca el estado, la visibilidad, el responsable, el
 * mercado ni los productos (archivar y crear siguen siendo decisiones propias).
 *
 *  · Capacidad `campaign:update`; una campaña de otra organización responde
 *    `RESOURCE_NOT_FOUND` (el filtro por organización va en el propio SQL).
 *  · La coherencia de fechas se valida mezclando lo enviado con lo vigente (el
 *    CHECK de la base daría un 23514 crudo, no un error accionable).
 *  · Una campaña archivada o cancelada no se edita.
 *  · Sin cambios reales no escribe ni audita (idempotente); con cambios, UN
 *    evento `campaign.update` con el antes y el después, el canal y la
 *    correlación de quien la invoca (`contexto`; `ui` por defecto).
 */
export async function actualizarCampana(
  actor: User,
  campaignId: string,
  input: ActualizarCampanaInput,
  contexto?: ContextoDeAuditoria,
): Promise<Result<CampanaActualizada>> {
  const persona = exigirPersona(actor, contexto);
  if (!persona.ok) return persona;
  const permitido = assertCapability(actor, 'campaign:update');
  if (!permitido.ok) return err({ code: permitido.error.code, message: permitido.error.message });

  let nombre: string | undefined;
  if (input.name !== undefined) {
    nombre = input.name.trim();
    if (nombre === '' || nombre.length > LONGITUD_MAXIMA_NOMBRE) {
      return err({
        code: 'VALIDATION_FAILED',
        message: `El nombre debe tener entre 1 y ${LONGITUD_MAXIMA_NOMBRE} caracteres.`,
        details: { field: 'name' },
      });
    }
  }
  for (const [campo, valor] of [
    ['startDate', input.startDate],
    ['endDate', input.endDate],
  ] as const) {
    if (valor !== undefined && valor !== null && !fechaIsoValida(valor)) {
      return err({
        code: 'VALIDATION_FAILED',
        message: 'La fecha debe ser un día real con formato AAAA-MM-DD.',
        details: { field: campo },
      });
    }
  }
  if (nombre === undefined && input.startDate === undefined && input.endDate === undefined) {
    return err({
      code: 'VALIDATION_FAILED',
      message: 'No hay nada que actualizar: indique el nombre o alguna de las fechas.',
      details: { reason: 'empty_update' },
    });
  }

  return transaccionConResultado(
    async (client) => {
      const { rows } = await client.query<{
        organization_id: string;
        confidentiality_level: string;
        visibility: string;
        status: string;
        name: string;
        start_date: string | null;
        end_date: string | null;
      }>(
        `SELECT organization_id, confidentiality_level::text AS confidentiality_level,
                visibility::text AS visibility, status::text AS status, name,
                to_char(start_date, 'YYYY-MM-DD') AS start_date, to_char(end_date, 'YYYY-MM-DD') AS end_date
           FROM campaigns WHERE id = $1 AND organization_id = $2 FOR UPDATE`,
        [campaignId, actor.organizationId],
      );
      const fila = rows[0];
      // Inexistente o de otra organización: la misma respuesta (caso S-01).
      if (fila === undefined) {
        throw new Abortar({
          code: 'RESOURCE_NOT_FOUND',
          message: 'El recurso no existe o no está disponible.',
        });
      }
      const alcance = authorize(
        actor,
        'campaign:update',
        scopeOf({
          organization_id: fila.organization_id,
          confidentiality_level: fila.confidentiality_level,
          visibility: fila.visibility,
        }),
      );
      if (!alcance.ok) throw new Abortar({ code: alcance.error.code, message: alcance.error.message });
      if (fila.status !== 'activa') {
        throw new Abortar({
          code: 'RESOURCE_CONFLICT',
          message: `La campaña está ${fila.status}: ya no se edita.`,
          details: { reason: 'campaign_not_active', campaignStatus: fila.status },
        });
      }

      const antes = { name: fila.name, startDate: fila.start_date, endDate: fila.end_date };
      const despues = {
        name: nombre ?? antes.name,
        startDate: input.startDate === undefined ? antes.startDate : input.startDate,
        endDate: input.endDate === undefined ? antes.endDate : input.endDate,
      };
      if (
        despues.startDate !== null &&
        despues.endDate !== null &&
        despues.endDate < despues.startDate // ISO: el orden de texto es el cronológico
      ) {
        throw new Abortar({
          code: 'VALIDATION_FAILED',
          message: 'La fecha de fin no puede ser anterior a la de inicio.',
          details: { field: 'endDate', startDate: despues.startDate, endDate: despues.endDate },
        });
      }

      const cambios = (['name', 'startDate', 'endDate'] as const).filter((c) => antes[c] !== despues[c]);
      if (cambios.length === 0) return { cambios, antes, despues };

      await client.query(
        `UPDATE campaigns SET name = $2, start_date = $3::date, end_date = $4::date, updated_at = now()
          WHERE id = $1`,
        [campaignId, despues.name, despues.startDate, despues.endDate],
      );
      await recordAudit(
        client,
        auditoriaDe(actor, contexto, {
          action: 'campaign.update',
          entityType: 'campaign',
          entityId: campaignId,
          metadata: { cambios, antes, despues },
        }),
      );
      return { cambios, antes, despues };
    },
    { code: 'RESOURCE_CONFLICT', message: 'La campaña cambió mientras se actualizaba: reintente.' },
  );
}
