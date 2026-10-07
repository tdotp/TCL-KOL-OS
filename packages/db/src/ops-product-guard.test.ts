/**
 * V2 · Fase 8 (W1c) — guarda de desasignación de productos (migración 029) con error tipado, y limpieza
 * de pruebas de las tablas de la operación (`eliminarCampanaDePrueba` / `eliminarInfluencersDePrueba`).
 *
 * Los acuerdos y envíos se crean por SQL directo (los casos de uso son de otras olas); aquí solo importa
 * que `desasociarProducto` traduzca la guarda de la base a `RESOURCE_CONFLICT` / `product_in_use`.
 */

import { createHash, randomBytes } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Result } from '@tcl-kol-os/domain';
import { asociarProductoAInfluencer, desasociarProducto } from './campaign-influencers.ts';
import { closePool, getPool, query, transaction } from './client.ts';
import { guardarPii } from './pii.ts';
import {
  type EscenarioDeContenido,
  crearEscenarioDeContenido,
  limpiarEscenarioDeContenido,
} from './test-utils.ts';

let e: EscenarioDeContenido;

beforeAll(async () => {
  e = await crearEscenarioDeContenido('F8 guarda de producto');
});

afterAll(async () => {
  await limpiarEscenarioDeContenido(e);
  await closePool();
});

let secuencia = 0;
const unico = (p: string) =>
  `${p}-${++secuencia}-${Date.now().toString(36)}${randomBytes(3).toString('hex')}`;
const hashSolicitud = () => createHash('sha256').update(unico('req')).digest('hex');

function valor<T>(r: Result<T>): T {
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
  return r.value;
}

async function insertar(
  c: pg.PoolClient | pg.Pool,
  tabla: string,
  fila: Record<string, unknown>,
): Promise<string> {
  const cols = Object.keys(fila);
  const r = await c.query(
    `INSERT INTO ${tabla} (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`,
    cols.map((k) => fila[k]),
  );
  return r.rows[0].id as string;
}

type Tabla = 'shipments' | 'billing_documents' | 'payment_obligations';
const SUJETO: Record<Tabla, { tipo: string; fk: string }> = {
  shipments: { tipo: 'shipment', fk: 'shipment_id' },
  billing_documents: { tipo: 'billing_document', fk: 'billing_document_id' },
  payment_obligations: { tipo: 'payment_obligation', fk: 'payment_obligation_id' },
};

/** Mecanismo del freeze §3: bloquea el sujeto, inserta el evento y avanza status/row_seq/last_event_id. */
async function mover(
  c: pg.PoolClient,
  m: { tabla: Tabla; id: string; tipo: string; hacia?: string | null; set?: Record<string, unknown> },
): Promise<string> {
  const { tipo, fk } = SUJETO[m.tabla];
  const s = (
    await c.query(
      `SELECT organization_id, campaign_id, status, row_seq FROM ${m.tabla} WHERE id = $1 FOR UPDATE`,
      [m.id],
    )
  ).rows[0];
  const hacia = m.hacia ?? null;
  const evento = await insertar(c, 'operational_events', {
    organization_id: s.organization_id,
    campaign_id: s.campaign_id,
    subject_type: tipo,
    [fk]: m.id,
    event_type: m.tipo,
    from_status: hacia === null || s.row_seq === 0 ? null : s.status,
    to_status: hacia,
    subject_seq: s.row_seq + 1,
    recorded_by: e.operativo.id,
    idempotency_key: unico('idem'),
    request_hash: hashSolicitud(),
  });
  const extra = Object.entries(m.set ?? {});
  await c.query(
    `UPDATE ${m.tabla} SET status = $2, row_seq = $3, last_event_id = $4${extra
      .map(([k], i) => `, ${k} = $${i + 5}`)
      .join('')} WHERE id = $1`,
    [m.id, hacia ?? s.status, s.row_seq + 1, evento, ...extra.map(([, v]) => v)],
  );
  return evento;
}

async function crearSoporte(): Promise<string> {
  const unica = unico('soporte');
  return insertar(getPool(), 'source_documents', {
    campaign_id: e.campanaId,
    organization_id: e.admin.organizationId,
    type: 'soporte_operativo',
    filename: `${unica}.pdf`,
    file_id: `test/${unica}.pdf`,
    mime_type: 'application/pdf',
    size_bytes: 1234,
    hash: createHash('sha256').update(unica).digest('hex'),
    status: 'procesado',
    confidentiality_level: 'sensible',
    visibility: 'interna',
    created_by: e.admin.id,
  });
}

/** Acuerdo (versión 1) con obligación de pago y, opcionalmente, compromisos de producto. */
async function acuerdo(
  ci: string,
  modo: 'fee' | 'barter',
  productos: string[] = [],
): Promise<{ agreementId: string; versionId: string; obligationId: string }> {
  return transaction(async (c) => {
    const agreementId = await insertar(c, 'agreements', {
      organization_id: e.operativo.organizationId,
      campaign_id: e.campanaId,
      campaign_influencer_id: ci,
      created_by: e.operativo.id,
    });
    const versionId = await insertar(c, 'agreement_versions', {
      organization_id: e.operativo.organizationId,
      campaign_id: e.campanaId,
      agreement_id: agreementId,
      compensation_type: modo,
      fee_amount: modo === 'barter' ? null : 1_000_000,
      fee_currency: modo === 'barter' ? null : 'COP',
      created_by: e.operativo.id,
    });
    for (const producto of productos) {
      await insertar(c, 'agreement_product_commitments', {
        organization_id: e.operativo.organizationId,
        campaign_id: e.campanaId,
        agreement_version_id: versionId,
        campaign_product_id: producto,
        quantity: 1,
      });
    }
    const estado = modo === 'barter' ? 'not_applicable' : 'pending';
    const obligationId = await insertar(c, 'payment_obligations', {
      organization_id: e.operativo.organizationId,
      campaign_id: e.campanaId,
      agreement_id: agreementId,
      status: estado,
      created_by: e.operativo.id,
    });
    await mover(c, {
      tabla: 'payment_obligations',
      id: obligationId,
      tipo: 'payment.applicability_set',
      hacia: estado,
    });
    return { agreementId, versionId, obligationId };
  });
}

async function envio(ci: string, productos: string[]): Promise<string> {
  return transaction(async (c) => {
    const id = await insertar(c, 'shipments', {
      organization_id: e.operativo.organizationId,
      campaign_id: e.campanaId,
      campaign_influencer_id: ci,
      created_by: e.operativo.id,
    });
    await mover(c, { tabla: 'shipments', id, tipo: 'shipment.created', hacia: 'pending' });
    for (const producto of productos) {
      await insertar(c, 'shipment_items', {
        organization_id: e.operativo.organizationId,
        campaign_id: e.campanaId,
        shipment_id: id,
        campaign_product_id: producto,
        quantity: 1,
        created_by: e.operativo.id,
      });
    }
    return id;
  });
}

const asignado = async (ci: string, producto: string): Promise<boolean> =>
  (
    await query(
      `SELECT 1 FROM campaign_influencer_products WHERE campaign_influencer_id = $1 AND campaign_product_id = $2`,
      [ci, producto],
    )
  ).length > 0;

describe('desasociarProducto: guarda de producto en uso (migración 029)', () => {
  it('un producto comprometido en el acuerdo vigente no se desasigna: RESOURCE_CONFLICT product_in_use', async () => {
    const ci = e.participaciones.valentinaRios;
    await acuerdo(ci, 'barter', [e.productos.p80]);
    const r = await desasociarProducto(e.admin, {
      campaignInfluencerId: ci,
      campaignProductId: e.productos.p80,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('RESOURCE_CONFLICT');
      expect(r.error.details?.['reason']).toBe('product_in_use');
      expect(r.error.details?.['blockedBy']).toBe('agreement');
    }
    expect(await asignado(ci, e.productos.p80)).toBe(true);
    // Sin evento de desasignación en la auditoría (la transacción se deshizo).
    const rastro = await query(
      `SELECT 1 FROM audit_events WHERE entity_id = $1 AND action = 'campaign_influencer.product_unassign'`,
      [ci],
    );
    expect(rastro).toHaveLength(0);
  });

  it('un producto en un envío abierto no se desasigna; al cancelar el envío, sí', async () => {
    const ci = e.participaciones.valentinaGomez;
    const id = await envio(ci, [e.productos.pro]);
    const bloqueada = await desasociarProducto(e.admin, {
      campaignInfluencerId: ci,
      campaignProductId: e.productos.pro,
    });
    expect(bloqueada.ok).toBe(false);
    if (!bloqueada.ok) {
      expect(bloqueada.error.code).toBe('RESOURCE_CONFLICT');
      expect(bloqueada.error.details).toMatchObject({ reason: 'product_in_use', blockedBy: 'shipment' });
    }
    expect(await asignado(ci, e.productos.pro)).toBe(true);

    await transaction((c) =>
      mover(c, {
        tabla: 'shipments',
        id,
        tipo: 'shipment.cancelled',
        hacia: 'cancelled',
        set: { cancel_reason: 'Prueba de limpieza' },
      }),
    );
    valor(
      await desasociarProducto(e.admin, { campaignInfluencerId: ci, campaignProductId: e.productos.pro }),
    );
    expect(await asignado(ci, e.productos.pro)).toBe(false);
  });

  it('sin compromiso ni envío abierto la desasignación sigue funcionando (acuerdo fee, sin compromisos)', async () => {
    const ci = e.participaciones.diego;
    valor(
      await asociarProductoAInfluencer(e.admin, {
        campaignInfluencerId: ci,
        campaignProductId: e.productos.p80,
      }),
    );
    await acuerdo(ci, 'fee');
    valor(
      await desasociarProducto(e.admin, { campaignInfluencerId: ci, campaignProductId: e.productos.p80 }),
    );
    expect(await asignado(ci, e.productos.p80)).toBe(false);
  });
});

describe('limpieza de pruebas con tablas de la operación', () => {
  it('eliminarCampanaDePrueba / eliminarInfluencersDePrueba borran todo lo F8 (incluida PII y soporte operativo)', async () => {
    // Evidencia y documento de cobro sobre una obligación de pago.
    const ci = e.participaciones.valentinaGomez;
    const { obligationId } = await acuerdo(ci, 'fee');
    const soporte = await crearSoporte();
    await transaction(async (c) => {
      const evento = await mover(c, {
        tabla: 'payment_obligations',
        id: obligationId,
        tipo: 'evidence.attached',
      });
      await insertar(c, 'operational_evidence', {
        organization_id: e.admin.organizationId,
        campaign_id: e.campanaId,
        event_id: evento,
        source_document_id: soporte,
        kind: 'comprobante',
        attached_by: e.operativo.id,
      });
    });
    const cuenta = await crearSoporte();
    await transaction(async (c) => {
      const doc = await insertar(c, 'billing_documents', {
        organization_id: e.operativo.organizationId,
        campaign_id: e.campanaId,
        payment_obligation_id: obligationId,
        document_number: unico('CC'),
        issued_on: '2026-10-01',
        claimed_amount: 1_000_000,
        claimed_currency: 'COP',
        source_document_id: cuenta,
        created_by: e.operativo.id,
      });
      await mover(c, {
        tabla: 'billing_documents',
        id: doc,
        tipo: 'billing.registered',
        hacia: 'registered',
      });
    });
    await envio(e.participaciones.diego, []);
    const influencerId = e.influencerIds[0]!;
    valor(await guardarPii(e.admin, { influencerId, phone: '+573001112233' }));

    const campanas = e.campanas;
    await limpiarEscenarioDeContenido(e);

    for (const tabla of [
      'operational_evidence',
      'operational_events',
      'shipment_items',
      'shipments',
      'billing_documents',
      'payment_obligations',
      'agreement_product_commitments',
      'agreement_versions',
      'agreements',
    ]) {
      const filas = await query(`SELECT 1 FROM ${tabla} WHERE campaign_id = ANY($1)`, [campanas]);
      expect(filas, tabla).toHaveLength(0);
    }
    expect(
      await query(`SELECT 1 FROM source_documents WHERE campaign_id = ANY($1)`, [campanas]),
    ).toHaveLength(0);
    expect(
      await query(`SELECT 1 FROM influencer_pii_records WHERE influencer_id = ANY($1)`, [e.influencerIds]),
    ).toHaveLength(0);
  });
});
