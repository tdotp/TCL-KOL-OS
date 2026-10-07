/**
 * Fixtures de las pruebas de la operación (V2 · Fase 8, W1b): envíos, cobro/pago, evidencia y eventos.
 *
 * Solo para pruebas (datos sintéticos). Arma el escenario sobre `crearEscenarioDeContenido` y crea por SQL
 * DIRECTO —según las reglas diferidas de las migraciones 027/031— lo que los casos de uso de W1d (acuerdos) aún
 * no hacen: acuerdo + versión + compromisos + obligación de pago con su evento de creación. La limpieza borra las
 * tablas F8 ANTES que campañas y participaciones, con el bypass de bases `_test`.
 *
 * Los originales de evidencia se guardan en un directorio temporal (`STORAGE_LOCAL_PATH`), no en `.storage`.
 */

import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type pg from 'pg';
import type { User } from '@tcl-kol-os/domain';
import { getPool, query, transaction } from './client.ts';
import {
  type EscenarioDeContenido,
  crearEscenarioDeContenido,
  eliminarInfluencersDePrueba,
  limpiarEscenarioDeContenido,
} from './test-utils.ts';

export interface EscenarioDeOperacion {
  readonly e: EscenarioDeContenido;
  /** Influencers creados por `nuevaParticipacion` (para limpiar). */
  readonly influencersExtra: string[];
  readonly directorioDeOriginales: string;
  readonly estadoPrevioDeStorage: string | undefined;
}

export async function crearEscenarioDeOperacion(nombre: string): Promise<EscenarioDeOperacion> {
  const estadoPrevioDeStorage = process.env['STORAGE_LOCAL_PATH'];
  const directorioDeOriginales = mkdtempSync(join(tmpdir(), 'tcl-ops-'));
  process.env['STORAGE_LOCAL_PATH'] = directorioDeOriginales;
  const e = await crearEscenarioDeContenido(nombre);
  return { e, influencersExtra: [], directorioDeOriginales, estadoPrevioDeStorage };
}

/** Borra TODO lo F8 de las campañas del escenario (historia sin DELETE: solo con el bypass de `_test`) y el escenario. */
export async function limpiarEscenarioDeOperacion(op: EscenarioDeOperacion): Promise<void> {
  const camp = op.e.campanas;
  await transaction(async (c) => {
    await c.query(`SET LOCAL tclkolos.permitir_borrado_historico = 'on'`);
    await c.query(`DELETE FROM operational_evidence WHERE campaign_id = ANY($1)`, [camp]);
    await c.query(`DELETE FROM operational_events WHERE campaign_id = ANY($1)`, [camp]);
    await c.query(`DELETE FROM shipment_items WHERE campaign_id = ANY($1)`, [camp]);
    await c.query(`DELETE FROM shipments WHERE campaign_id = ANY($1)`, [camp]);
    await c.query(`DELETE FROM billing_documents WHERE campaign_id = ANY($1)`, [camp]);
    await c.query(`DELETE FROM payment_obligations WHERE campaign_id = ANY($1)`, [camp]);
    await c.query(`DELETE FROM agreement_product_commitments WHERE campaign_id = ANY($1)`, [camp]);
    await c.query(`DELETE FROM agreement_versions WHERE campaign_id = ANY($1)`, [camp]);
    await c.query(`DELETE FROM agreements WHERE campaign_id = ANY($1)`, [camp]);
    await c.query(`DELETE FROM influencer_pii_records WHERE influencer_id = ANY($1)`, [
      [...op.e.influencerIds, ...op.influencersExtra],
    ]);
  });
  await limpiarEscenarioDeContenido(op.e);
  await eliminarInfluencersDePrueba(op.influencersExtra);
  if (op.estadoPrevioDeStorage === undefined) delete process.env['STORAGE_LOCAL_PATH'];
  else process.env['STORAGE_LOCAL_PATH'] = op.estadoPrevioDeStorage;
  rmSync(op.directorioDeOriginales, { recursive: true, force: true });
}

// ─────────────────────────── SQL directo ───────────────────────────────────────

type Cliente = pg.PoolClient | pg.Pool;

export async function insertar(c: Cliente, tabla: string, fila: Record<string, unknown>): Promise<string> {
  const cols = Object.keys(fila);
  const r = await c.query(
    `INSERT INTO ${tabla} (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`,
    cols.map((k) => fila[k]),
  );
  return r.rows[0].id as string;
}

let secuencia = 0;
export const unico = (p: string): string =>
  `${p}-${++secuencia}-${Date.now().toString(36)}${randomBytes(3).toString('hex')}`;
export const hashSolicitud = (): string => createHash('sha256').update(unico('req')).digest('hex');
/** Fecha `YYYY-MM-DD` de hace `atras` días (los hechos no pueden estar en el futuro). */
export const dia = (atras: number): string =>
  new Date(Date.now() - atras * 86_400_000).toISOString().slice(0, 10);

/** PDF mínimo pero válido, de contenido ÚNICO por `marca` (el hash de la evidencia es por contenido). */
export function pdfDePrueba(marca: string = unico('soporte')): Uint8Array {
  return new TextEncoder().encode(`%PDF-1.4\n% ${marca}\n1 0 obj\n<<>>\nendobj\ntrailer\n%%EOF\n`);
}

export function archivoDePrueba(marca?: string): { filename: string; contenido: Uint8Array } {
  const m = marca ?? unico('soporte');
  return { filename: `${m}.pdf`, contenido: pdfDePrueba(m) };
}

/** Persona + participación nueva en la campaña (con productos asignados opcionales). */
export async function nuevaParticipacion(
  op: EscenarioDeOperacion,
  etiqueta: string,
  productos: readonly string[] = [],
  campaignId: string = op.e.campanaId,
): Promise<{ ci: string; influencerId: string }> {
  const e = op.e;
  const pool = getPool();
  const influencerId = await insertar(pool, 'influencers', {
    organization_id: e.admin.organizationId,
    display_name: `${etiqueta} ${unico('p')}`,
    created_by: e.admin.id,
  });
  op.influencersExtra.push(influencerId);
  const ci = await insertar(pool, 'campaign_influencers', {
    organization_id: e.admin.organizationId,
    campaign_id: campaignId,
    influencer_id: influencerId,
    created_by: e.admin.id,
  });
  for (const producto of productos) {
    await insertar(pool, 'campaign_influencer_products', {
      campaign_id: campaignId,
      campaign_influencer_id: ci,
      campaign_product_id: producto,
      created_by: e.admin.id,
    });
  }
  return { ci, influencerId };
}

type Tabla = 'shipments' | 'billing_documents' | 'payment_obligations';
const SUJETO: Record<Tabla, { tipo: string; fk: string }> = {
  shipments: { tipo: 'shipment', fk: 'shipment_id' },
  billing_documents: { tipo: 'billing_document', fk: 'billing_document_id' },
  payment_obligations: { tipo: 'payment_obligation', fk: 'payment_obligation_id' },
};

/** El mecanismo del freeze §3 por SQL: bloquea el sujeto, inserta el evento y actualiza status/row_seq/last_event_id. */
export async function moverPorSql(
  c: pg.PoolClient,
  m: {
    tabla: Tabla;
    id: string;
    tipo: string;
    hacia?: string | null;
    por: User;
    happenedOn?: string;
    externalReference?: string;
    note?: string;
    set?: Record<string, unknown>;
  },
): Promise<string> {
  const { tipo: tipoSujeto, fk } = SUJETO[m.tabla];
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
    subject_type: tipoSujeto,
    [fk]: m.id,
    event_type: m.tipo,
    from_status: hacia === null || s.row_seq === 0 ? null : s.status,
    to_status: hacia,
    subject_seq: s.row_seq + 1,
    recorded_by: m.por.id,
    idempotency_key: unico('idem'),
    request_hash: hashSolicitud(),
    external_reference: m.externalReference ?? null,
    happened_on: m.happenedOn ?? null,
    note: m.note ?? null,
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

export interface AcuerdoDePrueba {
  readonly agreementId: string;
  readonly versionId: string;
  readonly obligationId: string;
}

/**
 * Acuerdo + versión 1 + compromisos + obligación con su evento de creación, por SQL directo (una transacción).
 * `obligacion` fuerza el estado inicial; por defecto barter ⇒ `not_applicable`, fee/mixed ⇒ `pending`.
 */
export async function crearAcuerdoPorSql(
  op: EscenarioDeOperacion,
  o: {
    ci: string;
    mode: 'fee' | 'barter' | 'mixed';
    amount?: number;
    currency?: string;
    productos?: ReadonlyArray<readonly [string, number]>;
    por?: User;
    campaignId?: string;
  },
): Promise<AcuerdoDePrueba> {
  const por = o.por ?? op.e.operativo;
  const campaignId = o.campaignId ?? op.e.campanaId;
  return transaction(async (c) => {
    const agreementId = await insertar(c, 'agreements', {
      organization_id: por.organizationId,
      campaign_id: campaignId,
      campaign_influencer_id: o.ci,
      created_by: por.id,
    });
    const versionId = await insertar(c, 'agreement_versions', {
      organization_id: por.organizationId,
      campaign_id: campaignId,
      agreement_id: agreementId,
      compensation_type: o.mode,
      fee_amount: o.mode === 'barter' ? null : (o.amount ?? 1_000_000),
      fee_currency: o.mode === 'barter' ? null : (o.currency ?? 'COP'),
      created_by: por.id,
    });
    for (const [producto, cantidad] of o.productos ?? []) {
      await insertar(c, 'agreement_product_commitments', {
        organization_id: por.organizationId,
        campaign_id: campaignId,
        agreement_version_id: versionId,
        campaign_product_id: producto,
        quantity: cantidad,
      });
    }
    const estado = o.mode === 'barter' ? 'not_applicable' : 'pending';
    const obligationId = await insertar(c, 'payment_obligations', {
      organization_id: por.organizationId,
      campaign_id: campaignId,
      agreement_id: agreementId,
      status: estado,
      created_by: por.id,
    });
    await moverPorSql(c, {
      tabla: 'payment_obligations',
      id: obligationId,
      tipo: 'payment.applicability_set',
      hacia: estado,
      por,
    });
    return { agreementId, versionId, obligationId };
  });
}

/** Fila cruda por SQL (para verificar lo que los casos de uso dejaron en la base). */
export async function fila<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T> {
  return (await query<Record<string, unknown>>(sql, params))[0] as T;
}

/** Acción de auditoría reciente del sujeto (la metadata completa, serializada, para buscar texto sentinela). */
export async function auditoriaDeSujeto(
  entityId: string,
): Promise<Array<{ action: string; metadata: unknown }>> {
  return query<{ action: string; metadata: unknown }>(
    `SELECT action, metadata FROM audit_events WHERE entity_id = $1 ORDER BY created_at, id`,
    [entityId],
  );
}

/** Registro de PII por SQL (envoltorio sintético válido: el contenido no se descifra jamás en estas pruebas). */
export async function insertarPiiPorSql(op: EscenarioDeOperacion, influencerId: string): Promise<string> {
  const b = (largo: number): Buffer => {
    const x = randomBytes(largo);
    x[0] = 1;
    return x;
  };
  return insertar(getPool(), 'influencer_pii_records', {
    organization_id: op.e.admin.organizationId,
    influencer_id: influencerId,
    document_id_enc: b(40),
    phone_enc: b(36),
    address_enc: b(60),
    key_id: 'k1',
    blind_index: createHash('sha256').update(unico('idx')).digest(),
    created_by: op.e.operativo.id,
  });
}

/** Producto de la OTRA campaña de la agencia (para probar el aislamiento por campaña). */
export async function productoDeOtraCampana(op: EscenarioDeOperacion): Promise<string> {
  const [p] = await query<{ id: string }>(`SELECT id FROM products WHERE model = 'P80'`);
  return insertar(getPool(), 'campaign_products', {
    campaign_id: op.e.otraCampanaId,
    product_id: p!.id,
    rol: 'secundario',
    prioridad: 1,
    participacion_presupuesto: 0.5,
  });
}
