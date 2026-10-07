/**
 * Envíos de producto (V2 · Fase 8, DEC-049): la logística de UNA participación (`CampaignInfluencer`).
 *
 * Un envío nace `pending` con su evento `shipment.created` y solo cambia de estado con un evento humano
 * (`transicionarEnvio` → `aplicarEventoOperativo`): pending → prepared → shipped → delivered; pending|prepared →
 * cancelled; shipped → failed | returned; delivered → returned. `delivered` JAMÁS se infiere de la asignación del
 * producto. Producto ASIGNADO ≠ COMPROMETIDO ≠ ENVIADO ≠ ENTREGADO: al preparar, cada ítem debe estar asignado a
 * la participación y —si el acuerdo vigente es barter/mixed— comprometido (la base lo repite en la 029).
 *
 * Datos personales: el envío NUNCA lleva dirección, teléfono ni cédula; solo una referencia segura
 * (`piiRecordId`) al registro cifrado del MISMO influencer, que se adjunta con `pii:manage` y se revela solo con
 * `pii:read` en el módulo de PII. `shipment:manage` no implica `pii:read`.
 *
 * Lectura con PROYECCIÓN por capacidad (la decide el servidor): `shipment:read` ve estado, fechas, transportadora,
 * guía e ítems; el costo del envío y su moneda SOLO con `finance:read`; `tienePii` es un booleano para todos y el
 * id opaco del registro de PII solo con `pii:read`.
 */

import type pg from 'pg';
import {
  type CompensationType,
  type EvidenceKind,
  EVENTO_DE_ENVIO_POR_DESTINO,
  type Result,
  type ShipmentItemInput,
  type ShipmentStatus,
  type User,
  authorizeInternalResource,
  err,
  evaluarPreparacionDeEnvio,
  isEvidenceKind,
  isShipmentStatus,
  ok,
  roleCan,
  validarDatosDeEnvio,
  validarItemsDeEnvio,
  validarMotivoDeCancelacion,
} from '@tcl-kol-os/domain';
import { type ContextoDeAuditoria } from './audit-context.ts';
import { getPool, query } from './client.ts';
import { NO_ENCONTRADO_DE_CONTENIDO, esUuid } from './deliverables.ts';
import {
  type EventoOperativo,
  aplicarEventoOperativo,
  autorizarOAbortar,
  buscarReintentoDeCreacion,
  calcularHuellaDeEvento,
  cargarEventoOperativo,
  exigirPersonaPorUiOAbortar,
  transaccionOperativa,
} from './operational-events.ts';
import { type ArchivoDeEvidencia, subirEvidenciaOperativa } from './ops-evidence.ts';
import { Abortar } from './tx-result.ts';

// ─────────────────────────── Vistas ────────────────────────────────────────────

export interface ItemDeEnvioVista {
  readonly campaignProductId: string;
  readonly quantity: number;
  readonly productModel: string;
}

export interface EnvioVista {
  readonly id: string;
  readonly campaignId: string;
  readonly campaignInfluencerId: string;
  readonly status: ShipmentStatus;
  /** Contador de eventos: el `expectedSeq` de la próxima transición. */
  readonly rowSeq: number;
  readonly carrier: string | null;
  readonly trackingRef: string | null;
  readonly cancelReason: string | null;
  /** `YYYY-MM-DD` de los eventos de envío y entrega (`null` si aún no ocurrieron). */
  readonly shippedOn: string | null;
  readonly deliveredOn: string | null;
  readonly items: readonly ItemDeEnvioVista[];
  /** ¿Tiene una referencia a datos personales? (el dato mismo vive cifrado en otro módulo). */
  readonly tienePii: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** SOLO con `finance:read`. */
  readonly shippingCost?: string | null | undefined;
  readonly shippingCurrency?: string | null | undefined;
  /** SOLO con `pii:read`: id opaco del registro cifrado (no es un dato personal). */
  readonly piiRecordId?: string | null | undefined;
}

interface FilaDeEnvio {
  id: string;
  campaign_id: string;
  campaign_influencer_id: string;
  status: ShipmentStatus;
  row_seq: number;
  carrier: string | null;
  tracking_ref: string | null;
  cancel_reason: string | null;
  shipping_cost: string | null;
  shipping_currency: string | null;
  pii_record_id: string | null;
  tiene_pii: boolean;
  shipped_on: string | null;
  delivered_on: string | null;
  created_at: Date;
  updated_at: Date;
}

interface FilaDeItem {
  shipment_id: string;
  campaign_product_id: string;
  quantity: number;
  model: string;
}

/** Proyección de un actor: qué capacidades extra tiene (la decide el servidor, nunca el llamador). */
function capacidades(actor: User): { conCosto: boolean; conPii: boolean } {
  return { conCosto: roleCan(actor.role, 'finance:read'), conPii: roleCan(actor.role, 'pii:read') };
}

type Consultor = pg.Pool | pg.PoolClient;

/** Lista cerrada de columnas: nunca `SELECT *`. El costo y la referencia de PII solo se leen con su capacidad. */
async function cargarEnvios(
  db: Consultor,
  actor: User,
  condicion: string,
  parametros: readonly unknown[],
): Promise<EnvioVista[]> {
  const { conCosto, conPii } = capacidades(actor);
  const { rows } = await db.query<FilaDeEnvio>(
    `SELECT s.id, s.campaign_id, s.campaign_influencer_id, s.status, s.row_seq, s.carrier, s.tracking_ref,
            s.cancel_reason,
            ${conCosto ? 's.shipping_cost::text' : 'NULL::text'} AS shipping_cost,
            ${conCosto ? 's.shipping_currency::text' : 'NULL::text'} AS shipping_currency,
            ${conPii ? 's.pii_record_id' : 'NULL::uuid'} AS pii_record_id,
            (s.pii_record_id IS NOT NULL) AS tiene_pii,
            (SELECT e.happened_on::text FROM operational_events e
              WHERE e.shipment_id = s.id AND e.event_type = 'shipment.shipped') AS shipped_on,
            (SELECT e.happened_on::text FROM operational_events e
              WHERE e.shipment_id = s.id AND e.event_type = 'shipment.delivered') AS delivered_on,
            s.created_at, s.updated_at
       FROM shipments s
      WHERE ${condicion}
      ORDER BY s.created_at, s.id`,
    [...parametros],
  );
  if (rows.length === 0) return [];
  const { rows: items } = await db.query<FilaDeItem>(
    `SELECT si.shipment_id, si.campaign_product_id, si.quantity, p.model
       FROM shipment_items si
       JOIN campaign_products cp ON cp.id = si.campaign_product_id
       JOIN products p ON p.id = cp.product_id
      WHERE si.shipment_id = ANY($1::uuid[])
      ORDER BY p.model, si.id`,
    [rows.map((r) => r.id)],
  );
  return rows.map((r) => {
    const base: EnvioVista = {
      id: r.id,
      campaignId: r.campaign_id,
      campaignInfluencerId: r.campaign_influencer_id,
      status: r.status,
      rowSeq: r.row_seq,
      carrier: r.carrier,
      trackingRef: r.tracking_ref,
      cancelReason: r.cancel_reason,
      shippedOn: r.shipped_on,
      deliveredOn: r.delivered_on,
      items: items
        .filter((i) => i.shipment_id === r.id)
        .map((i) => ({
          campaignProductId: i.campaign_product_id,
          quantity: i.quantity,
          productModel: i.model,
        })),
      tienePii: r.tiene_pii,
      createdAt: r.created_at.toISOString(),
      updatedAt: r.updated_at.toISOString(),
    };
    return {
      ...base,
      ...(conCosto ? { shippingCost: r.shipping_cost, shippingCurrency: r.shipping_currency } : {}),
      ...(conPii ? { piiRecordId: r.pii_record_id } : {}),
    };
  });
}

// ─────────────────────────── Crear ─────────────────────────────────────────────

export interface CrearEnvioInput {
  readonly campaignInfluencerId: string;
  /** Productos y cantidades (de ESTA campaña). La asignación/compromiso se exige al PREPARAR. */
  readonly items: readonly ShipmentItemInput[];
  readonly carrier?: string | null | undefined;
  readonly trackingRef?: string | null | undefined;
  /** Costo del envío (dato financiero interno: exige `finance:read`). Va con su moneda. */
  readonly shippingCost?: unknown;
  readonly shippingCurrency?: unknown;
  /** Referencia segura al registro de PII del MISMO influencer (exige `pii:manage`). */
  readonly piiRecordId?: string | null | undefined;
  readonly idempotencyKey: string;
  /** Nota interna (no a auditoría ni al agente). Sin datos personales. */
  readonly note?: string | null | undefined;
}

export interface EnvioRegistrado {
  readonly envio: EnvioVista;
  readonly evento: EventoOperativo;
  /** `true` si era un reintento idéntico (misma clave y solicitud): no se creó otro envío. */
  readonly repetido: boolean;
}

/**
 * Crea un envío `pending` (con sus ítems) y su evento `shipment.created`, en una transacción. Exige
 * `shipment:manage`; ajeno ⇒ `RESOURCE_NOT_FOUND`. Campaña activa e influencer activo. Idempotente por
 * `idempotencyKey`: el reintento idéntico devuelve el MISMO envío; la clave con otra solicitud es conflicto.
 */
export async function crearEnvio(
  actor: User,
  input: CrearEnvioInput,
  contexto?: ContextoDeAuditoria,
): Promise<Result<EnvioRegistrado>> {
  const items = validarItemsDeEnvio(input.items);
  if (!items.ok) return items;
  const datos = validarDatosDeEnvio({
    carrier: input.carrier,
    trackingRef: input.trackingRef,
    shippingCost: input.shippingCost,
    shippingCurrency: input.shippingCurrency,
  });
  if (!datos.ok) return datos;
  const piiRecordId = input.piiRecordId ?? null;
  if (piiRecordId !== null && !esUuid(piiRecordId)) return err(NO_ENCONTRADO_DE_CONTENIDO);

  return transaccionOperativa(async (client) => {
    const persona = exigirPersonaPorUiOAbortar(actor, contexto);
    if (!esUuid(input.campaignInfluencerId)) throw new Abortar(NO_ENCONTRADO_DE_CONTENIDO);
    const { rows } = await client.query<{
      organization_id: string;
      campaign_id: string;
      influencer_id: string;
      status: string;
      campana: string;
    }>(
      `SELECT ci.organization_id, ci.campaign_id, ci.influencer_id, ci.status::text AS status,
              c.status::text AS campana
         FROM campaign_influencers ci JOIN campaigns c ON c.id = ci.campaign_id
        WHERE ci.id = $1 FOR SHARE OF ci`,
      [input.campaignInfluencerId],
    );
    const participacion = rows[0];
    if (participacion === undefined) throw new Abortar(NO_ENCONTRADO_DE_CONTENIDO);
    autorizarOAbortar(persona, 'shipment:manage', participacion.organization_id);
    if (datos.value.shippingCost !== null) {
      autorizarOAbortar(persona, 'finance:read', participacion.organization_id);
    }
    if (participacion.campana !== 'activa' || participacion.status !== 'activo') {
      throw new Abortar({
        code: 'RESOURCE_CONFLICT',
        message: 'La campaña debe estar activa y el influencer activo en ella para registrar un envío.',
        details: { reason: 'campaign_or_participation_not_active' },
      });
    }

    if (piiRecordId !== null) {
      autorizarOAbortar(persona, 'pii:manage', participacion.organization_id);
      const { rows: pii } = await client.query<{
        organization_id: string;
        influencer_id: string;
        erased_at: Date | null;
      }>(`SELECT organization_id, influencer_id, erased_at FROM influencer_pii_records WHERE id = $1`, [
        piiRecordId,
      ]);
      const registro = pii[0];
      if (registro === undefined || registro.organization_id !== participacion.organization_id) {
        throw new Abortar(NO_ENCONTRADO_DE_CONTENIDO);
      }
      if (registro.influencer_id !== participacion.influencer_id || registro.erased_at !== null) {
        throw new Abortar({
          code: 'VALIDATION_FAILED',
          message: 'El registro de datos personales no corresponde al influencer de esta participación.',
          details: { field: 'piiRecordId' },
        });
      }
    }

    const huellaExtra = {
      campaignInfluencerId: input.campaignInfluencerId,
      items: [...items.value]
        .map((i) => ({ p: i.campaignProductId, q: i.quantity }))
        .sort((a, b) => a.p.localeCompare(b.p)),
      carrier: datos.value.carrier,
      trackingRef: datos.value.trackingRef,
      shippingCost: datos.value.shippingCost,
      shippingCurrency: datos.value.shippingCurrency,
      piiRecordId,
    };
    const huella = calcularHuellaDeEvento({
      sujeto: { tipo: 'shipment', id: '' },
      eventType: 'shipment.created',
      toStatus: 'pending',
      expectedSeq: 0,
      note: input.note,
      huellaExtra,
    });
    const reintento = await buscarReintentoDeCreacion(
      client,
      participacion.organization_id,
      input.idempotencyKey,
      huella,
    );
    if (reintento !== undefined) {
      const [envio] = await cargarEnvios(client, persona, 's.id = $1', [reintento.sujeto.id]);
      return {
        envio: envio!,
        evento: await cargarEventoOperativo(client, reintento.eventoId),
        repetido: true,
      };
    }

    const { rows: creados } = await client.query<{ id: string }>(
      `INSERT INTO shipments
         (organization_id, campaign_id, campaign_influencer_id, carrier, tracking_ref, shipping_cost,
          shipping_currency, pii_record_id, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING id`,
      [
        participacion.organization_id,
        participacion.campaign_id,
        input.campaignInfluencerId,
        datos.value.carrier,
        datos.value.trackingRef,
        datos.value.shippingCost,
        datos.value.shippingCurrency,
        piiRecordId,
        persona.id,
      ],
    );
    const shipmentId = creados[0]!.id;
    for (const item of items.value) {
      await client.query(
        `INSERT INTO shipment_items (organization_id, campaign_id, shipment_id, campaign_product_id, quantity, created_by)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          participacion.organization_id,
          participacion.campaign_id,
          shipmentId,
          item.campaignProductId,
          item.quantity,
          persona.id,
        ],
      );
    }
    const aplicado = await aplicarEventoOperativo(client, {
      actor: persona,
      contexto,
      action: 'shipment:manage',
      sujeto: { tipo: 'shipment', id: shipmentId },
      eventType: 'shipment.created',
      toStatus: 'pending',
      expectedSeq: 0,
      idempotencyKey: input.idempotencyKey,
      note: input.note,
      huellaExtra,
      auditoria: { itemCount: items.value.length },
    });
    const [envio] = await cargarEnvios(client, persona, 's.id = $1', [shipmentId]);
    return { envio: envio!, evento: aplicado.evento, repetido: false };
  });
}

// ─────────────────────────── Transicionar ──────────────────────────────────────

export interface TransicionarEnvioInput {
  readonly shipmentId: string;
  /** Estado destino (todos menos `pending`, que solo lo da la creación). */
  readonly to: ShipmentStatus;
  /** `rowSeq` del envío que el llamador vio. */
  readonly expectedSeq: number;
  readonly idempotencyKey: string;
  /** `YYYY-MM-DD`: obligatorio al enviar (`shipped`) y al entregar (`delivered`). */
  readonly happenedOn?: string | undefined;
  /** Solo al pasar a `shipped`. */
  readonly carrier?: string | null | undefined;
  readonly trackingRef?: string | null | undefined;
  /** Obligatorio al cancelar. */
  readonly cancelReason?: string | undefined;
  readonly note?: string | null | undefined;
  /** Soporte opcional (p. ej. la guía) que viaja en la misma transacción que el evento. */
  readonly evidencia?: { readonly archivo: ArchivoDeEvidencia; readonly kind: EvidenceKind } | undefined;
}

export interface EnvioTransicionado {
  readonly envio: EnvioVista;
  readonly evento: EventoOperativo;
  readonly repetido: boolean;
}

/**
 * Mueve un envío con un evento humano. Exige `shipment:manage` (`ops_evidence:attach` si adjunta soporte);
 * ajeno ⇒ `RESOURCE_NOT_FOUND`. Concurrencia por `expectedSeq` (`stale_transition`), idempotente por
 * `idempotencyKey`. Preparar exige ≥ 1 ítem asignado (y comprometido si el acuerdo es barter/mixed).
 */
export async function transicionarEnvio(
  actor: User,
  input: TransicionarEnvioInput,
  contexto?: ContextoDeAuditoria,
): Promise<Result<EnvioTransicionado>> {
  if (!isShipmentStatus(input.to) || input.to === 'pending') {
    return err({
      code: 'VALIDATION_FAILED',
      message: 'El estado destino no es válido (un envío nace pendiente; solo avanza).',
      details: { field: 'to' },
    });
  }
  if (input.to !== 'shipped' && (input.carrier != null || input.trackingRef != null)) {
    return err({
      code: 'VALIDATION_FAILED',
      message: 'La transportadora y la guía se informan al marcar el envío como enviado.',
      details: { field: 'carrier' },
    });
  }
  if (input.to !== 'cancelled' && input.cancelReason !== undefined) {
    return err({
      code: 'VALIDATION_FAILED',
      message: 'El motivo solo aplica al cancelar.',
      details: { field: 'cancelReason' },
    });
  }
  let cambios: Record<string, string | null> | undefined;
  if (input.to === 'shipped') {
    const datos = validarDatosDeEnvio({ carrier: input.carrier, trackingRef: input.trackingRef });
    if (!datos.ok) return datos;
    cambios = {};
    if (datos.value.carrier !== null) cambios['carrier'] = datos.value.carrier;
    if (datos.value.trackingRef !== null) cambios['tracking_ref'] = datos.value.trackingRef;
  } else if (input.to === 'cancelled') {
    const motivo = validarMotivoDeCancelacion(input.cancelReason);
    if (!motivo.ok) return motivo;
    cambios = { cancel_reason: motivo.value };
  }
  if (input.evidencia !== undefined && !isEvidenceKind(input.evidencia.kind)) {
    return err({
      code: 'VALIDATION_FAILED',
      message: 'El tipo de soporte no es válido.',
      details: { field: 'evidencia' },
    });
  }

  return transaccionOperativa(async (client) => {
    const persona = exigirPersonaPorUiOAbortar(actor, contexto);
    if (!esUuid(input.shipmentId)) throw new Abortar(NO_ENCONTRADO_DE_CONTENIDO);
    const { rows } = await client.query<{ organization_id: string; campaign_id: string }>(
      `SELECT organization_id, campaign_id FROM shipments WHERE id = $1`,
      [input.shipmentId],
    );
    const propietaria = rows[0];
    if (propietaria === undefined) throw new Abortar(NO_ENCONTRADO_DE_CONTENIDO);
    autorizarOAbortar(persona, 'shipment:manage', propietaria.organization_id);

    let evidencias: Array<{ sourceDocumentId: string; kind: EvidenceKind }> = [];
    if (input.evidencia !== undefined) {
      const subida = await subirEvidenciaOperativa(client, {
        actor: persona,
        contexto,
        campaignId: propietaria.campaign_id,
        archivo: input.evidencia.archivo,
      });
      evidencias = [{ sourceDocumentId: subida.sourceDocumentId, kind: input.evidencia.kind }];
    }

    const aplicado = await aplicarEventoOperativo(client, {
      actor: persona,
      contexto,
      action: 'shipment:manage',
      sujeto: { tipo: 'shipment', id: input.shipmentId },
      eventType: EVENTO_DE_ENVIO_POR_DESTINO[input.to] as
        | 'shipment.prepared'
        | 'shipment.shipped'
        | 'shipment.delivered'
        | 'shipment.failed'
        | 'shipment.returned'
        | 'shipment.cancelled',
      toStatus: input.to,
      expectedSeq: input.expectedSeq,
      idempotencyKey: input.idempotencyKey,
      happenedOn: input.happenedOn,
      note: input.note,
      cambios,
      evidencias,
      precondicion: input.to === 'prepared' ? exigirEnvioPreparable : undefined,
    });
    const [envio] = await cargarEnvios(client, persona, 's.id = $1', [input.shipmentId]);
    return { envio: envio!, evento: aplicado.evento, repetido: aplicado.repetido };
  });
}

/** Espejo de `shipments_preparacion` (029) con el dominio puro, para devolver un error accionable. */
async function exigirEnvioPreparable(ctx: {
  client: pg.PoolClient;
  sujeto: { id: string; status: string };
}): Promise<void> {
  const { client, sujeto } = ctx;
  if (sujeto.status !== 'pending') return; // otro origen: lo rechaza la arista del grafo
  const { rows: envio } = await client.query<{ campaign_influencer_id: string }>(
    `SELECT campaign_influencer_id FROM shipments WHERE id = $1`,
    [sujeto.id],
  );
  const ci = envio[0]!.campaign_influencer_id;
  const { rows: items } = await client.query<{ campaign_product_id: string; quantity: number }>(
    `SELECT campaign_product_id, quantity FROM shipment_items WHERE shipment_id = $1`,
    [sujeto.id],
  );
  const { rows: asignados } = await client.query<{ campaign_product_id: string }>(
    `SELECT campaign_product_id FROM campaign_influencer_products WHERE campaign_influencer_id = $1`,
    [ci],
  );
  const { rows: acuerdo } = await client.query<{ id: string; compensation_type: CompensationType }>(
    `SELECT a.id, av.compensation_type
       FROM agreements a
       JOIN agreement_versions av ON av.agreement_id = a.id AND av.version = a.current_version
      WHERE a.campaign_influencer_id = $1 AND a.status = 'active'`,
    [ci],
  );
  const vigente = acuerdo[0];
  let comprometidos: string[] = [];
  if (
    vigente !== undefined &&
    (vigente.compensation_type === 'barter' || vigente.compensation_type === 'mixed')
  ) {
    const { rows } = await client.query<{ campaign_product_id: string }>(
      `SELECT pc.campaign_product_id
         FROM agreement_product_commitments pc
         JOIN agreement_versions av ON av.id = pc.agreement_version_id
         JOIN agreements a ON a.id = av.agreement_id AND a.current_version = av.version
        WHERE a.id = $1`,
      [vigente.id],
    );
    comprometidos = rows.map((r) => r.campaign_product_id);
  }
  const fallos = evaluarPreparacionDeEnvio({
    items: items.map((i) => ({ campaignProductId: i.campaign_product_id, quantity: i.quantity })),
    assignedProductIds: asignados.map((a) => a.campaign_product_id),
    agreementMode: vigente?.compensation_type,
    committedProductIds: comprometidos,
  });
  if (fallos.length > 0) {
    throw new Abortar({
      code: 'RESOURCE_CONFLICT',
      message:
        'El envío no se puede preparar: cada producto debe estar asignado al influencer y, si el acuerdo es de canje o mixto, comprometido en la versión vigente.',
      details: { reason: 'preparation_failed', failures: fallos.map((f) => f.reason) },
    });
  }
}

// ─────────────────────────── Lecturas ──────────────────────────────────────────

/**
 * Envíos de una participación, con la proyección del actor. Exige `shipment:read` (consultor lo tiene: ve
 * estado y fechas, nunca el costo); ajeno o `cliente` ⇒ `RESOURCE_NOT_FOUND`.
 */
export async function listarEnviosDeParticipacion(
  actor: User,
  campaignInfluencerId: string,
): Promise<Result<EnvioVista[]>> {
  if (typeof actor !== 'object' || actor === null) {
    return err({ code: 'FORBIDDEN_ROLE', message: 'Esta consulta la hace una persona autorizada.' });
  }
  if (!esUuid(campaignInfluencerId)) return err(NO_ENCONTRADO_DE_CONTENIDO);
  const filas = await query<{ organization_id: string }>(
    `SELECT organization_id FROM campaign_influencers WHERE id = $1`,
    [campaignInfluencerId],
  );
  const dueña = filas[0];
  if (dueña === undefined) return err(NO_ENCONTRADO_DE_CONTENIDO);
  const permitido = authorizeInternalResource(actor, 'shipment:read', dueña.organization_id);
  if (!permitido.ok) return permitido;
  return ok(await cargarEnvios(getPool(), actor, 's.campaign_influencer_id = $1', [campaignInfluencerId]));
}

/** Un envío, con la proyección del actor (misma autorización que `listarEnviosDeParticipacion`). */
export async function obtenerEnvio(actor: User, shipmentId: string): Promise<Result<EnvioVista>> {
  if (typeof actor !== 'object' || actor === null) {
    return err({ code: 'FORBIDDEN_ROLE', message: 'Esta consulta la hace una persona autorizada.' });
  }
  if (!esUuid(shipmentId)) return err(NO_ENCONTRADO_DE_CONTENIDO);
  const filas = await query<{ organization_id: string }>(
    `SELECT organization_id FROM shipments WHERE id = $1`,
    [shipmentId],
  );
  const dueña = filas[0];
  if (dueña === undefined) return err(NO_ENCONTRADO_DE_CONTENIDO);
  const permitido = authorizeInternalResource(actor, 'shipment:read', dueña.organization_id);
  if (!permitido.ok) return permitido;
  const [envio] = await cargarEnvios(getPool(), actor, 's.id = $1', [shipmentId]);
  return envio === undefined ? err(NO_ENCONTRADO_DE_CONTENIDO) : ok(envio);
}
