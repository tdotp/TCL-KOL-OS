/**
 * V2 · Fase 8 — esquema de la operación (migraciones 026–031): invariantes que impone LA BASE.
 *
 * Todo con SQL directo, sin casos de uso (los hacen W1b/W1c): lo que la aplicación omita, la base lo
 * rechaza. Acuerdos y versiones inmutables, compromisos, obligación de pago (barter ⇒ not_applicable),
 * máquinas de estado por evento (envío, documento de cobro, obligación), eventos append-only e idempotentes,
 * evidencia como fuente `soporte_operativo`, PII cifrada (envoltorio, versión, cripto-borrado, cédula
 * duplicada), roles cerrados con paridad contra el dominio, aislamiento por FK compuestas y sin DELETE/TRUNCATE.
 */

import { createHash, randomBytes } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  OPERATIONAL_EVENT_EDGES,
  OPERATIONAL_EVENT_TYPES,
  OPERATIONAL_SUBJECT_TYPES,
  OPERATIONS_CAPABILITY_ROLES,
  ROLES,
  isValidOperationalEdge,
  statusesOf,
  subjectTypeOfEventType,
  type OperationalEventType,
  type OperationsCapability,
  type User,
} from '@tcl-kol-os/domain';
import { closePool, getPool, query, transaction } from './client.ts';
import { adminPool } from './test-admin.ts';
import {
  type EscenarioDeContenido,
  crearEscenarioDeContenido,
  eliminarInfluencersDePrueba,
  limpiarEscenarioDeContenido,
} from './test-utils.ts';

let e: EscenarioDeContenido;
const influencersExtra: string[] = [];

beforeAll(async () => {
  e = await crearEscenarioDeContenido('F8 esquema');
});

afterAll(async () => {
  await transaction(async (c) => {
    await c.query(`SET LOCAL tclkolos.permitir_borrado_historico = 'on'`);
    const camp = e.campanas;
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
      [...e.influencerIds, ...influencersExtra],
    ]);
  });
  await limpiarEscenarioDeContenido(e);
  await eliminarInfluencersDePrueba(influencersExtra);
  await closePool();
});

// ─────────────────────────── Ayudas ────────────────────────────────────────────

type Cliente = pg.PoolClient | pg.Pool;
const pool = (): pg.Pool => getPool();

/** Mensaje del rechazo de la base ('' si pasó). */
async function rechazo(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
    return '';
  } catch (error) {
    return (error as Error).message;
  }
}

async function conBypass(fn: (c: pg.PoolClient) => Promise<void>): Promise<void> {
  await transaction(async (c) => {
    await c.query(`SET LOCAL tclkolos.permitir_borrado_historico = 'on'`);
    await fn(c);
  });
}

async function insertar(c: Cliente, tabla: string, fila: Record<string, unknown>): Promise<string> {
  const cols = Object.keys(fila);
  const r = await c.query(
    `INSERT INTO ${tabla} (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`,
    cols.map((k) => fila[k]),
  );
  return r.rows[0].id as string;
}

let secuencia = 0;
/** Fecha `YYYY-MM-DD` de hace `atras` días (los hechos no pueden estar en el futuro). */
const dia = (atras: number): string => new Date(Date.now() - atras * 86_400_000).toISOString().slice(0, 10);
const unico = (p: string) =>
  `${p}-${++secuencia}-${Date.now().toString(36)}${randomBytes(3).toString('hex')}`;
const hashSolicitud = () => createHash('sha256').update(unico('req')).digest('hex');

/** Persona + participación nueva en la campaña (con productos asignados opcionales). */
async function nuevaParticipacion(
  etiqueta: string,
  productos: string[] = [],
  campaignId: string = e.campanaId,
): Promise<{ ci: string; influencerId: string }> {
  const influencerId = await insertar(pool(), 'influencers', {
    organization_id: e.admin.organizationId,
    display_name: `${etiqueta} ${unico('p')}`,
    created_by: e.admin.id,
  });
  influencersExtra.push(influencerId);
  const ci = await insertar(pool(), 'campaign_influencers', {
    organization_id: e.admin.organizationId,
    campaign_id: campaignId,
    influencer_id: influencerId,
    created_by: e.admin.id,
  });
  for (const producto of productos) {
    await insertar(pool(), 'campaign_influencer_products', {
      campaign_id: campaignId,
      campaign_influencer_id: ci,
      campaign_product_id: producto,
      created_by: e.admin.id,
    });
  }
  return { ci, influencerId };
}

/** Producto de la OTRA campaña de la agencia (para probar el aislamiento por campaña). */
let productoAjenoCache: string | undefined;
async function productoDeOtraCampana(): Promise<string> {
  if (productoAjenoCache !== undefined) return productoAjenoCache;
  const [p] = await query<{ id: string }>(`SELECT id FROM products WHERE model = 'P80'`);
  productoAjenoCache = await insertar(pool(), 'campaign_products', {
    campaign_id: e.otraCampanaId,
    product_id: p!.id,
    rol: 'secundario',
    prioridad: 1,
    participacion_presupuesto: 0.5,
  });
  return productoAjenoCache;
}

/** Fuente `soporte_operativo` válida (sensible, interna, procesada, sin job ni fragmentos). */
async function crearSoporte(campaignId: string = e.campanaId, por: User = e.admin): Promise<string> {
  const unica = unico('soporte');
  return insertar(pool(), 'source_documents', {
    campaign_id: campaignId,
    organization_id: por.organizationId,
    type: 'soporte_operativo',
    filename: `${unica}.pdf`,
    file_id: `test/${unica}.pdf`,
    mime_type: 'application/pdf',
    size_bytes: 1234,
    hash: createHash('sha256').update(unica).digest('hex'),
    status: 'procesado',
    confidentiality_level: 'sensible',
    visibility: 'interna',
    created_by: por.id,
  });
}

type Tabla = 'shipments' | 'billing_documents' | 'payment_obligations';
const SUJETO: Record<Tabla, { tipo: string; fk: string }> = {
  shipments: { tipo: 'shipment', fk: 'shipment_id' },
  billing_documents: { tipo: 'billing_document', fk: 'billing_document_id' },
  payment_obligations: { tipo: 'payment_obligation', fk: 'payment_obligation_id' },
};

interface Mover {
  tabla: Tabla;
  id: string;
  tipo: string;
  /** Estado destino; omitido o `null` = nota/evidencia. */
  hacia?: string | null;
  por?: User;
  happenedOn?: string;
  externalReference?: string;
  note?: string;
  /** Columnas extra del UPDATE del sujeto. */
  set?: Record<string, unknown>;
  /** Columnas del evento que sustituyen a las calculadas (pruebas negativas). */
  evento?: Record<string, unknown>;
}

/** El mecanismo del freeze §3: bloquea el sujeto, inserta el evento y actualiza status/row_seq/last_event_id. */
async function mover(c: pg.PoolClient, m: Mover): Promise<string> {
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
    recorded_by: (m.por ?? e.operativo).id,
    idempotency_key: unico('idem'),
    request_hash: hashSolicitud(),
    external_reference: m.externalReference ?? null,
    happened_on: m.happenedOn ?? null,
    note: m.note ?? null,
    ...m.evento,
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

interface AcuerdoCreado {
  agreementId: string;
  versionId: string;
  obligationId: string;
}

/** Acuerdo + versión 1 + compromisos + obligación con su evento de creación (una transacción). */
async function crearAcuerdo(
  c: pg.PoolClient,
  o: {
    ci: string;
    mode: 'fee' | 'barter' | 'mixed';
    amount?: number;
    currency?: string;
    productos?: Array<[string, number]>;
    por?: User;
    obligacion?: 'not_applicable' | 'pending';
    sinObligacion?: boolean;
    campaignId?: string;
  },
): Promise<AcuerdoCreado> {
  const por = o.por ?? e.operativo;
  const campaignId = o.campaignId ?? e.campanaId;
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
  let obligationId = '';
  if (o.sinObligacion !== true) {
    const estado = o.obligacion ?? (o.mode === 'barter' ? 'not_applicable' : 'pending');
    obligationId = await insertar(c, 'payment_obligations', {
      organization_id: por.organizationId,
      campaign_id: campaignId,
      agreement_id: agreementId,
      status: estado,
      created_by: por.id,
    });
    await mover(c, {
      tabla: 'payment_obligations',
      id: obligationId,
      tipo: 'payment.applicability_set',
      hacia: estado,
      por,
    });
  }
  return { agreementId, versionId, obligationId };
}

async function acuerdo(o: Parameters<typeof crearAcuerdo>[1]): Promise<AcuerdoCreado> {
  return transaction((c) => crearAcuerdo(c, o));
}

async function crearEnvio(
  c: pg.PoolClient,
  o: { ci: string; items?: Array<[string, number]>; por?: User; extra?: Record<string, unknown> },
): Promise<string> {
  const por = o.por ?? e.operativo;
  const id = await insertar(c, 'shipments', {
    organization_id: por.organizationId,
    campaign_id: e.campanaId,
    campaign_influencer_id: o.ci,
    created_by: por.id,
    ...o.extra,
  });
  await mover(c, { tabla: 'shipments', id, tipo: 'shipment.created', hacia: 'pending', por });
  for (const [producto, cantidad] of o.items ?? []) {
    await insertar(c, 'shipment_items', {
      organization_id: por.organizationId,
      campaign_id: e.campanaId,
      shipment_id: id,
      campaign_product_id: producto,
      quantity: cantidad,
      created_by: por.id,
    });
  }
  return id;
}

async function crearDocumento(
  c: pg.PoolClient,
  o: {
    obligationId: string;
    sourceId?: string;
    numero?: string;
    monto?: number;
    por?: User;
    extra?: Record<string, unknown>;
  },
): Promise<string> {
  const por = o.por ?? e.operativo;
  const id = await insertar(c, 'billing_documents', {
    organization_id: por.organizationId,
    campaign_id: e.campanaId,
    payment_obligation_id: o.obligationId,
    document_number: o.numero ?? unico('CC'),
    issued_on: '2026-10-01',
    claimed_amount: o.monto ?? 1_000_000,
    claimed_currency: 'COP',
    source_document_id: o.sourceId ?? (await crearSoporte()),
    created_by: por.id,
    ...o.extra,
  });
  await mover(c, { tabla: 'billing_documents', id, tipo: 'billing.registered', hacia: 'registered', por });
  return id;
}

const fila = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T> =>
  (await query<Record<string, unknown>>(sql, params))[0] as T;

const bytes = (largo: number, primero = 1): Buffer => {
  const b = randomBytes(largo);
  b[0] = primero;
  return b;
};

// ─────────────────────────── 1. Estructura ─────────────────────────────────────

const TABLAS_F8 = [
  'agreements',
  'agreement_versions',
  'agreement_product_commitments',
  'payment_obligations',
  'influencer_pii_records',
  'shipments',
  'shipment_items',
  'billing_documents',
  'operational_events',
  'operational_evidence',
] as const;

describe('estructura', () => {
  it('existen las diez tablas y NINGUNA lleva visibilidad, cliente ni acceso de TCL', async () => {
    const cols = await query<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = ANY($1)`,
      [[...TABLAS_F8]],
    );
    expect([...new Set(cols.map((c) => c.table_name))].sort()).toEqual([...TABLAS_F8].sort());
    expect(cols.filter((c) => /visib|client|confidential|tcl/i.test(c.column_name))).toEqual([]);
    // toda tabla F8 lleva organization_id y created_at, salvo el evento (recorded_at) y la evidencia (created_at)
    for (const tabla of TABLAS_F8) {
      expect(
        cols.some((c) => c.table_name === tabla && c.column_name === 'organization_id'),
        tabla,
      ).toBe(true);
    }
  });

  it('montos numeric(14,2) y moneda char(3)', async () => {
    const r = await query<{
      table_name: string;
      column_name: string;
      data_type: string;
      numeric_precision: number | null;
      numeric_scale: number | null;
      character_maximum_length: number | null;
    }>(
      `SELECT table_name, column_name, data_type, numeric_precision, numeric_scale, character_maximum_length
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND (column_name IN ('fee_amount', 'claimed_amount', 'shipping_cost')
               OR column_name IN ('fee_currency', 'claimed_currency', 'shipping_currency'))`,
    );
    expect(r.length).toBe(6);
    for (const col of r) {
      if (/amount|cost/.test(col.column_name)) {
        expect([col.data_type, col.numeric_precision, col.numeric_scale], col.column_name).toEqual([
          'numeric',
          14,
          2,
        ]);
      } else {
        expect([col.data_type, col.character_maximum_length], col.column_name).toEqual(['character', 3]);
      }
    }
  });

  it('el tipo de fuente soporte_operativo existe', async () => {
    const r = await query<{ enumlabel: string }>(
      `SELECT enumlabel FROM pg_enum WHERE enumtypid = 'source_type'::regtype`,
    );
    expect(r.map((x) => x.enumlabel)).toContain('soporte_operativo');
  });
});

// ─────────────────────────── 2. Roles cerrados ─────────────────────────────────

describe('operaciones_exigir_rol: paridad con el dominio', () => {
  const usuarios = (): Array<[string, User]> => [
    ['admin', e.admin],
    ['director', e.director],
    ['consultor', e.consultor],
    ['operativo', e.operativo],
    ['analista', e.analista],
    ['legal', e.legal],
    ['cliente', e.cliente],
  ];
  const capacidades = Object.keys(OPERATIONS_CAPABILITY_ROLES) as OperationsCapability[];

  it('cada capacidad admite exactamente su lista de roles (dominio = base)', async () => {
    for (const capacidad of capacidades) {
      for (const [rol, usuario] of usuarios()) {
        const msg = await rechazo(() =>
          query(`SELECT operaciones_exigir_rol($1, $2)`, [usuario.id, capacidad]),
        );
        const permitido = OPERATIONS_CAPABILITY_ROLES[capacidad].includes(rol as never);
        expect(msg === '', `${capacidad} ← ${rol}`).toBe(permitido);
      }
    }
    expect(new Set(usuarios().map(([r]) => r)).size).toBe(ROLES.length);
  });

  it('capacidad desconocida, usuario inexistente, NULL e inactivo se rechazan', async () => {
    expect(await rechazo(() => query(`SELECT operaciones_exigir_rol($1, 'otra')`, [e.admin.id]))).toMatch(
      /no puede ejecutar/,
    );
    expect(
      await rechazo(() => query(`SELECT operaciones_exigir_rol(gen_random_uuid(), 'manage_ops')`)),
    ).toMatch(/no puede ejecutar/);
    expect(await rechazo(() => query(`SELECT operaciones_exigir_rol(NULL, 'manage_ops')`))).toMatch(
      /no puede ejecutar/,
    );
    const inactivo = await insertar(pool(), 'users', {
      email: `inactivo-${unico('f8')}@smartpr.co`,
      name: 'Inactivo F8',
      organization_id: e.admin.organizationId,
      role: 'admin',
      status: 'inactivo',
    });
    expect(await rechazo(() => query(`SELECT operaciones_exigir_rol($1, 'manage_ops')`, [inactivo]))).toMatch(
      /no puede ejecutar/,
    );
    await conBypass(async (c) => void (await c.query(`DELETE FROM users WHERE id = $1`, [inactivo])));
  });
});

// ─────────────────────────── 3. Acuerdos ───────────────────────────────────────

describe('acuerdos y versiones', () => {
  it('barter ⇒ sin monto ni moneda; fee/mixed ⇒ monto > 0 y moneda ^[A-Z]{3}$', async () => {
    const { ci } = await nuevaParticipacion('modos', [e.productos.p80]);
    const { agreementId } = await acuerdo({ ci, mode: 'fee' });
    const version = (campos: Record<string, unknown>) =>
      insertar(pool(), 'agreement_versions', {
        organization_id: e.admin.organizationId,
        campaign_id: e.campanaId,
        agreement_id: agreementId,
        created_by: e.operativo.id,
        ...campos,
      });
    const malos: Array<Record<string, unknown>> = [
      { compensation_type: 'barter', fee_amount: 100, fee_currency: 'COP' },
      { compensation_type: 'barter', fee_amount: 100 },
      { compensation_type: 'barter', fee_currency: 'COP' },
      { compensation_type: 'fee' },
      { compensation_type: 'fee', fee_amount: 100 },
      { compensation_type: 'fee', fee_currency: 'COP' },
      { compensation_type: 'fee', fee_amount: 0, fee_currency: 'COP' },
      { compensation_type: 'fee', fee_amount: -5, fee_currency: 'COP' },
      { compensation_type: 'fee', fee_amount: 100, fee_currency: 'cop' },
      { compensation_type: 'mixed', fee_amount: 100, fee_currency: 'COPP' },
      { compensation_type: 'mixed', fee_amount: 100, fee_currency: 'C0P' },
      { compensation_type: 'canje', fee_amount: 100, fee_currency: 'COP' },
      {
        compensation_type: 'fee',
        fee_amount: 100,
        fee_currency: 'COP',
        starts_on: '2026-12-01',
        ends_on: '2026-11-01',
      },
      { compensation_type: 'fee', fee_amount: 100, fee_currency: 'COP', conditions: '   ' },
    ];
    for (const m of malos) {
      expect(await rechazo(() => version(m)), JSON.stringify(m)).toMatch(
        /check constraint|violates|too long/,
      );
    }
    // numeric(14,2): demasiado grande
    expect(
      await rechazo(() => version({ compensation_type: 'fee', fee_amount: 1e12, fee_currency: 'COP' })),
    ).toMatch(/numeric|overflow|range/i);
  });

  it('la versión la numera la base (1, 2, 3), ignora la del llamador y las versiones son inmutables', async () => {
    const { ci } = await nuevaParticipacion('versiones');
    const { agreementId, versionId } = await acuerdo({ ci, mode: 'fee' });
    const v2 = await insertar(pool(), 'agreement_versions', {
      organization_id: e.admin.organizationId,
      campaign_id: e.campanaId,
      agreement_id: agreementId,
      version: 99,
      compensation_type: 'fee',
      fee_amount: 2_000_000,
      fee_currency: 'COP',
      change_reason: 'Renegociación',
      created_by: e.director.id,
    });
    const v3 = await insertar(pool(), 'agreement_versions', {
      organization_id: e.admin.organizationId,
      campaign_id: e.campanaId,
      agreement_id: agreementId,
      compensation_type: 'fee',
      fee_amount: 2_500_000,
      fee_currency: 'COP',
      created_by: e.operativo.id,
    });
    const filas = await query<{ id: string; version: number }>(
      `SELECT id, version FROM agreement_versions WHERE agreement_id = $1 ORDER BY version`,
      [agreementId],
    );
    expect(filas.map((f) => f.version)).toEqual([1, 2, 3]);
    expect(filas.map((f) => f.id)).toEqual([versionId, v2, v3]);
    expect(
      (
        await fila<{ current_version: number }>(`SELECT current_version FROM agreements WHERE id = $1`, [
          agreementId,
        ])
      ).current_version,
    ).toBe(3);

    expect(
      await rechazo(() => query(`UPDATE agreement_versions SET fee_amount = 1 WHERE id = $1`, [v2])),
    ).toMatch(/append-only/);
    expect(await rechazo(() => query(`DELETE FROM agreement_versions WHERE id = $1`, [v2]))).toMatch(
      /no admite DELETE/,
    );
    // ni siquiera con el bypass de pruebas se «edita» una versión
    expect(
      await rechazo(() =>
        conBypass(
          async (c) =>
            void (await c.query(`UPDATE agreement_versions SET fee_amount = 1 WHERE id = $1`, [v2])),
        ),
      ),
    ).toMatch(/append-only/);
  });

  it('current_version no se adelanta a mano (hueco)', async () => {
    const { ci } = await nuevaParticipacion('hueco');
    const { agreementId } = await acuerdo({ ci, mode: 'fee' });
    expect(
      await rechazo(() =>
        query(`UPDATE agreements SET current_version = current_version + 2 WHERE id = $1`, [agreementId]),
      ),
    ).toMatch(/de uno en uno/);
    // +1 sin versión: el invariante diferido lo atrapa al cerrar la transacción
    expect(
      await rechazo(() =>
        query(`UPDATE agreements SET current_version = current_version + 1 WHERE id = $1`, [agreementId]),
      ),
    ).toMatch(/current_version/);
  });

  it('un acuerdo por participación; la participación debe ser de la campaña y activa', async () => {
    const { ci } = await nuevaParticipacion('unico');
    await acuerdo({ ci, mode: 'fee' });
    expect(await rechazo(() => acuerdo({ ci, mode: 'fee' }))).toMatch(/agreements_participacion_key/);
    // participación de OTRA campaña con la campaña equivocada: la clave compuesta lo impide
    const otra = await nuevaParticipacion('otra', [], e.otraCampanaId);
    expect(
      await rechazo(() =>
        insertar(pool(), 'agreements', {
          organization_id: e.admin.organizationId,
          campaign_id: e.campanaId,
          campaign_influencer_id: otra.ci,
          created_by: e.operativo.id,
        }),
      ),
    ).toMatch(/agreements_participacion_fkey/);
    // organización ajena
    const libre = await nuevaParticipacion('unico-libre');
    expect(
      await rechazo(() =>
        insertar(pool(), 'agreements', {
          organization_id: e.ajeno.organizationId,
          campaign_id: e.campanaId,
          campaign_influencer_id: libre.ci,
          created_by: e.ajeno.id,
        }),
      ),
    ).toMatch(/agreements_campaign_fkey/);
  });

  it('roles: solo admin, director y operativo registran acuerdos y versiones', async () => {
    for (const quien of [e.consultor, e.analista, e.legal, e.cliente]) {
      const { ci } = await nuevaParticipacion('rol');
      expect(await rechazo(() => acuerdo({ ci, mode: 'fee', por: quien })), quien.role).toMatch(
        /no puede ejecutar|violates foreign key/,
      );
    }
    const { ci } = await nuevaParticipacion('rol-ok');
    for (const quien of [e.admin, e.director, e.operativo]) {
      const { ci: ci2 } = await nuevaParticipacion(`rol-${quien.role}`);
      await acuerdo({ ci: ci2, mode: 'fee', por: quien });
    }
    const { agreementId } = await acuerdo({ ci, mode: 'fee' });
    expect(
      await rechazo(() =>
        insertar(pool(), 'agreement_versions', {
          organization_id: e.admin.organizationId,
          campaign_id: e.campanaId,
          agreement_id: agreementId,
          compensation_type: 'fee',
          fee_amount: 5,
          fee_currency: 'COP',
          created_by: e.consultor.id,
        }),
      ),
    ).toMatch(/no puede ejecutar/);
  });

  it('cancelar: active → cancelled con motivo y persona; luego es histórico', async () => {
    const { ci } = await nuevaParticipacion('cancelar');
    const { agreementId } = await acuerdo({ ci, mode: 'fee' });
    expect(
      await rechazo(() =>
        query(`UPDATE agreements SET status = 'cancelled', cancelled_by = $2 WHERE id = $1`, [
          agreementId,
          e.operativo.id,
        ]),
      ),
    ).toMatch(/agreements_cancelacion_coherente/);
    expect(
      await rechazo(() => query(`UPDATE agreements SET status = 'cancelled' WHERE id = $1`, [agreementId])),
    ).toMatch(/agreements_cancelacion_coherente|no puede ejecutar/);
    expect(
      await rechazo(() =>
        query(
          `UPDATE agreements SET status = 'cancelled', cancelled_by = $2, cancel_reason = 'x' WHERE id = $1`,
          [agreementId, e.consultor.id],
        ),
      ),
    ).toMatch(/no puede ejecutar/);
    await query(
      `UPDATE agreements SET status = 'cancelled', cancelled_by = $2, cancel_reason = 'KOL desistió' WHERE id = $1`,
      [agreementId, e.operativo.id],
    );
    expect(
      (
        await fila<{ cancelled_at: Date | null }>(`SELECT cancelled_at FROM agreements WHERE id = $1`, [
          agreementId,
        ])
      ).cancelled_at,
    ).not.toBeNull();
    expect(
      await rechazo(() =>
        query(
          `UPDATE agreements SET status = 'active', cancelled_at = NULL, cancelled_by = NULL, cancel_reason = NULL WHERE id = $1`,
          [agreementId],
        ),
      ),
    ).toMatch(/cancelado es histórico/);
    expect(
      await rechazo(() =>
        insertar(pool(), 'agreement_versions', {
          organization_id: e.admin.organizationId,
          campaign_id: e.campanaId,
          agreement_id: agreementId,
          compensation_type: 'fee',
          fee_amount: 5,
          fee_currency: 'COP',
          created_by: e.operativo.id,
        }),
      ),
    ).toMatch(/cancelado/);
    expect(await rechazo(() => query(`DELETE FROM agreements WHERE id = $1`, [agreementId]))).toMatch(
      /no admite DELETE/,
    );
  });
});

describe('compromisos de producto', () => {
  it('barter y mixed exigen ≥ 1 compromiso al cerrar la transacción; fee no admite ninguno', async () => {
    const { ci } = await nuevaParticipacion('comprom', [e.productos.p80]);
    expect(await rechazo(() => acuerdo({ ci, mode: 'barter' }))).toMatch(/al menos un compromiso/);
    expect(await rechazo(() => acuerdo({ ci, mode: 'mixed' }))).toMatch(/al menos un compromiso/);
    expect(await rechazo(() => acuerdo({ ci, mode: 'fee', productos: [[e.productos.p80, 1]] }))).toMatch(
      /solo los acuerdos de canje/i,
    );
    await acuerdo({ ci, mode: 'barter', productos: [[e.productos.p80, 2]] });
  });

  it('el producto debe estar asignado a la participación y ser de la campaña', async () => {
    const { ci } = await nuevaParticipacion('comprom-asig', [e.productos.p80]);
    expect(await rechazo(() => acuerdo({ ci, mode: 'barter', productos: [[e.productos.pro, 1]] }))).toMatch(
      /no está asignado/,
    );
    const ajeno = await productoDeOtraCampana();
    expect(await rechazo(() => acuerdo({ ci, mode: 'barter', productos: [[ajeno, 1]] }))).toMatch(
      /agreement_product_commitments_producto_fkey|no está asignado/,
    );
  });

  it('cantidad positiva; un producto por versión', async () => {
    const { ci } = await nuevaParticipacion('comprom-cant', [e.productos.p80]);
    for (const cantidad of [0, -1, 100001]) {
      expect(
        await rechazo(() => acuerdo({ ci, mode: 'barter', productos: [[e.productos.p80, cantidad]] })),
        String(cantidad),
      ).toMatch(/cantidad_valida/);
    }
    expect(
      await rechazo(() =>
        acuerdo({
          ci,
          mode: 'barter',
          productos: [
            [e.productos.p80, 1],
            [e.productos.p80, 2],
          ],
        }),
      ),
    ).toMatch(/agreement_product_commitments_unico_key/);
  });

  it('un compromiso tardío (otra transacción) no se acepta: los términos de una versión no cambian', async () => {
    const { ci } = await nuevaParticipacion('comprom-tarde', [e.productos.p80, e.productos.pro]);
    const { versionId } = await acuerdo({ ci, mode: 'mixed', productos: [[e.productos.p80, 1]] });
    expect(
      await rechazo(() =>
        insertar(pool(), 'agreement_product_commitments', {
          organization_id: e.admin.organizationId,
          campaign_id: e.campanaId,
          agreement_version_id: versionId,
          campaign_product_id: e.productos.pro,
          quantity: 1,
        }),
      ),
    ).toMatch(/en la misma transacción/);
    expect(
      await rechazo(() =>
        query(`UPDATE agreement_product_commitments SET quantity = 5 WHERE agreement_version_id = $1`, [
          versionId,
        ]),
      ),
    ).toMatch(/append-only/);
    expect(
      await rechazo(() =>
        query(`DELETE FROM agreement_product_commitments WHERE agreement_version_id = $1`, [versionId]),
      ),
    ).toMatch(/no admite DELETE/);
  });
});

describe('obligación de pago: barter ⇒ not_applicable (invariante diferido)', () => {
  it('barter con obligación pending falla al cerrar; fee/mixed con not_applicable también', async () => {
    const { ci } = await nuevaParticipacion('oblig', [e.productos.p80]);
    expect(
      await rechazo(() =>
        acuerdo({ ci, mode: 'barter', productos: [[e.productos.p80, 1]], obligacion: 'pending' }),
      ),
    ).toMatch(/Estado inicial de la obligación incoherente/);
    expect(await rechazo(() => acuerdo({ ci, mode: 'fee', obligacion: 'not_applicable' }))).toMatch(
      /obligación de pago distinta de not_applicable|coherente|Estado inicial/,
    );
    expect(
      await rechazo(() =>
        acuerdo({ ci, mode: 'mixed', productos: [[e.productos.p80, 1]], obligacion: 'not_applicable' }),
      ),
    ).toMatch(/Estado inicial|distinta de not_applicable/);
  });

  it('el estado inicial correcto se acepta en los tres modos', async () => {
    const { ci } = await nuevaParticipacion('oblig-ok', [e.productos.p80, e.productos.pro]);
    const barter = await acuerdo({ ci, mode: 'barter', productos: [[e.productos.p80, 1]] });
    expect(
      (
        await fila<{ status: string }>(`SELECT status FROM payment_obligations WHERE id = $1`, [
          barter.obligationId,
        ])
      ).status,
    ).toBe('not_applicable');
    const b = await nuevaParticipacion('oblig-fee');
    const fee = await acuerdo({ ci: b.ci, mode: 'fee' });
    expect(
      (
        await fila<{ status: string }>(`SELECT status FROM payment_obligations WHERE id = $1`, [
          fee.obligationId,
        ])
      ).status,
    ).toBe('pending');
    const m = await nuevaParticipacion('oblig-mixed', [e.productos.pro]);
    const mixto = await acuerdo({ ci: m.ci, mode: 'mixed', productos: [[e.productos.pro, 1]] });
    expect(
      (
        await fila<{ status: string }>(`SELECT status FROM payment_obligations WHERE id = $1`, [
          mixto.obligationId,
        ])
      ).status,
    ).toBe('pending');
  });

  it('todo acuerdo exige su obligación y una obligación exige acuerdo con versión', async () => {
    const { ci } = await nuevaParticipacion('oblig-falta');
    expect(await rechazo(() => acuerdo({ ci, mode: 'fee', sinObligacion: true }))).toMatch(
      /exige su obligación de pago/,
    );
    expect(
      await rechazo(() =>
        transaction(async (c) => {
          const agreementId = await insertar(c, 'agreements', {
            organization_id: e.admin.organizationId,
            campaign_id: e.campanaId,
            campaign_influencer_id: ci,
            created_by: e.operativo.id,
          });
          await insertar(c, 'payment_obligations', {
            organization_id: e.admin.organizationId,
            campaign_id: e.campanaId,
            agreement_id: agreementId,
            status: 'pending',
            created_by: e.operativo.id,
          });
        }),
      ),
    ).toMatch(/al menos una versión/);
    // y un acuerdo sin versión 1 no sobrevive
    expect(
      await rechazo(() =>
        transaction((c) =>
          insertar(c, 'agreements', {
            organization_id: e.admin.organizationId,
            campaign_id: e.campanaId,
            campaign_influencer_id: ci,
            created_by: e.operativo.id,
          }),
        ),
      ),
    ).toMatch(/exige su versión 1/);
  });

  it('cambiar el modo en una versión nueva obliga a ajustar la obligación en la MISMA transacción', async () => {
    const { ci } = await nuevaParticipacion('oblig-cambio', [e.productos.p80]);
    const { agreementId, obligationId } = await acuerdo({ ci, mode: 'fee' });
    const versionBarter = (c: pg.PoolClient) =>
      insertar(c, 'agreement_versions', {
        organization_id: e.admin.organizationId,
        campaign_id: e.campanaId,
        agreement_id: agreementId,
        compensation_type: 'barter',
        change_reason: 'Pasa a canje',
        created_by: e.operativo.id,
      }).then((versionId) =>
        insertar(c, 'agreement_product_commitments', {
          organization_id: e.admin.organizationId,
          campaign_id: e.campanaId,
          agreement_version_id: versionId,
          campaign_product_id: e.productos.p80,
          quantity: 1,
        }),
      );
    // sin ajustar la obligación: falla
    expect(await rechazo(() => transaction((c) => versionBarter(c)))).toMatch(
      /canje \(barter\) no tiene pago/,
    );
    // ajustándola con su evento: pasa
    await transaction(async (c) => {
      await versionBarter(c);
      await mover(c, {
        tabla: 'payment_obligations',
        id: obligationId,
        tipo: 'payment.applicability_set',
        hacia: 'not_applicable',
      });
    });
    expect(
      (await fila<{ status: string }>(`SELECT status FROM payment_obligations WHERE id = $1`, [obligationId]))
        .status,
    ).toBe('not_applicable');
    // pending/not_applicable incoherente con la versión vigente: el trigger de estado lo rechaza
    expect(
      await rechazo(() =>
        transaction((c) =>
          mover(c, {
            tabla: 'payment_obligations',
            id: obligationId,
            tipo: 'payment.applicability_set',
            hacia: 'pending',
          }),
        ),
      ),
    ).toMatch(/solo pasa a pending/);
  });

  it('con documentos de cobro vivos no pasa a not_applicable ni se cancela', async () => {
    const { ci } = await nuevaParticipacion('oblig-docs', [e.productos.p80]);
    const { agreementId, obligationId } = await acuerdo({ ci, mode: 'fee' });
    const doc = await transaction((c) => crearDocumento(c, { obligationId }));
    const aBarter = (c: pg.PoolClient) =>
      insertar(c, 'agreement_versions', {
        organization_id: e.admin.organizationId,
        campaign_id: e.campanaId,
        agreement_id: agreementId,
        compensation_type: 'barter',
        change_reason: 'a canje',
        created_by: e.operativo.id,
      }).then((v) =>
        insertar(c, 'agreement_product_commitments', {
          organization_id: e.admin.organizationId,
          campaign_id: e.campanaId,
          agreement_version_id: v,
          campaign_product_id: e.productos.p80,
          quantity: 1,
        }),
      );
    expect(
      await rechazo(() =>
        transaction(async (c) => {
          await aBarter(c);
          await mover(c, {
            tabla: 'payment_obligations',
            id: obligationId,
            tipo: 'payment.applicability_set',
            hacia: 'not_applicable',
          });
        }),
      ),
    ).toMatch(/documento\(s\) de cobro vivos/);
    expect(
      await rechazo(() =>
        transaction((c) =>
          mover(c, {
            tabla: 'payment_obligations',
            id: obligationId,
            tipo: 'payment.cancelled',
            hacia: 'cancelled',
          }),
        ),
      ),
    ).toMatch(/documento\(s\) de cobro vivos/);
    // anulado el documento, sí se puede
    await transaction((c) =>
      mover(c, { tabla: 'billing_documents', id: doc, tipo: 'billing.voided', hacia: 'voided' }),
    );
    await transaction(async (c) => {
      await aBarter(c);
      await mover(c, {
        tabla: 'payment_obligations',
        id: obligationId,
        tipo: 'payment.applicability_set',
        hacia: 'not_applicable',
      });
    });
  });

  it('con el pago reportado, una versión con modo/monto/moneda distinto se rechaza; vigencia y condiciones sí', async () => {
    const { ci } = await nuevaParticipacion('oblig-reportado');
    const { agreementId, obligationId } = await acuerdo({ ci, mode: 'fee', amount: 3_000_000 });
    await transaction((c) =>
      mover(c, {
        tabla: 'payment_obligations',
        id: obligationId,
        tipo: 'payment.reported',
        hacia: 'reported_paid',
        happenedOn: dia(2),
        externalReference: 'TRX-1',
      }),
    );
    const version = (campos: Record<string, unknown>) =>
      insertar(pool(), 'agreement_versions', {
        organization_id: e.admin.organizationId,
        campaign_id: e.campanaId,
        agreement_id: agreementId,
        compensation_type: 'fee',
        fee_amount: 3_000_000,
        fee_currency: 'COP',
        change_reason: 'cambio',
        created_by: e.operativo.id,
        ...campos,
      });
    expect(await rechazo(() => version({ fee_amount: 3_000_001 }))).toMatch(/ya fue reportado/);
    expect(await rechazo(() => version({ fee_currency: 'USD' }))).toMatch(/ya fue reportado/);
    expect(await rechazo(() => version({ compensation_type: 'mixed' }))).toMatch(/ya fue reportado/);
    await version({ ends_on: '2027-01-31', conditions: 'Prórroga de vigencia' });
  });
});

// ─────────────────────────── 4. Eventos operativos ─────────────────────────────

describe('operational_events: restricciones de la tabla', () => {
  /** Un envío pendiente y una obligación pendiente NUEVOS: cada prueba parte de un estado conocido. */
  async function fresco() {
    const { ci } = await nuevaParticipacion('eventos', [e.productos.p80]);
    const { obligationId } = await acuerdo({ ci, mode: 'fee' });
    const envio = await transaction((c) => crearEnvio(c, { ci, items: [[e.productos.p80, 1]] }));
    const base = (extra: Record<string, unknown> = {}) => ({
      organization_id: e.admin.organizationId,
      campaign_id: e.campanaId,
      subject_type: 'shipment',
      shipment_id: envio,
      event_type: 'shipment.prepared',
      from_status: 'pending',
      to_status: 'prepared',
      subject_seq: 2,
      recorded_by: e.operativo.id,
      idempotency_key: unico('idem'),
      request_hash: hashSolicitud(),
      ...extra,
    });
    /** Inserta el evento SIN aplicarlo al sujeto: solo interesa qué rechaza la base. */
    const intento = (extra: Record<string, unknown>) =>
      rechazo(() => transaction((c) => insertar(c, 'operational_events', base(extra))));
    const basePago = (extra: Record<string, unknown> = {}) => ({
      organization_id: e.admin.organizationId,
      campaign_id: e.campanaId,
      subject_type: 'payment_obligation',
      payment_obligation_id: obligationId,
      event_type: 'payment.reported',
      from_status: 'pending',
      to_status: 'reported_paid',
      subject_seq: 2,
      recorded_by: e.operativo.id,
      idempotency_key: unico('idem'),
      request_hash: hashSolicitud(),
      happened_on: dia(2),
      external_reference: 'TRX-1',
      ...extra,
    });
    const intentoPago = (extra: Record<string, unknown>) =>
      rechazo(() => transaction((c) => insertar(c, 'operational_events', basePago(extra))));
    return { ci, obligationId, envio, base, intento, basePago, intentoPago };
  }

  it('origin solo ui (la IA, el chat y el sistema no registran estado operativo)', async () => {
    const { intento } = await fresco();
    for (const origin of ['agent', 'chat', 'system', 'api', 'UI']) {
      expect(await intento({ origin }), origin).toMatch(/operational_events_origen_ui/);
    }
  });

  it('lista cerrada de tipos y exactamente UNA FK de sujeto según subject_type', async () => {
    const { intento, envio, obligationId } = await fresco();
    // (los CHECK se evalúan por orden alfabético: un tipo inventado cae en alguno de los tres)
    expect(await intento({ event_type: 'shipment.exploded' })).toMatch(
      /arista_valida|nota_coherente|tipo_valido/,
    );
    expect(await intento({ event_type: 'shipment.exploded', from_status: null, to_status: null })).toMatch(
      /nota_coherente|tipo_valido/,
    );
    expect(await intento({ subject_type: 'otro' })).toMatch(/sujeto_valido|no existe/);
    expect(await intento({ billing_document_id: envio })).toMatch(/operational_events_sujeto_unico/);
    expect(await intento({ payment_obligation_id: obligationId })).toMatch(/operational_events_sujeto_unico/);
    expect(await intento({ shipment_id: null })).toMatch(/sujeto_unico|no existe/);
    expect(await intento({ subject_type: 'billing_document' })).toMatch(/sujeto_unico|no existe/);
    // el tipo de evento es del sujeto
    expect(
      await intento({ event_type: 'billing.validated', from_status: 'registered', to_status: 'validated' }),
    ).toMatch(/tipo_sujeto|arista|estado de origen/);
    expect(
      await intento({ event_type: 'billing.registered', from_status: 'pending', to_status: 'registered' }),
    ).toMatch(/tipo_sujeto|arista|estado de origen/);
  });

  it('aristas, notas y secuencia coherentes', async () => {
    const { intento } = await fresco();
    expect(await intento({ to_status: 'delivered' })).toMatch(/operational_events_arista_valida/);
    expect(await intento({ from_status: 'prepared' })).toMatch(/arista_valida|no es el estado vigente/);
    expect(await intento({ to_status: null })).toMatch(/operational_events_nota_coherente/);
    expect(await intento({ event_type: 'evidence.attached', to_status: null })).toMatch(
      /operational_events_nota_coherente/,
    );
    expect(await intento({ event_type: 'evidence.attached', to_status: 'prepared' })).toMatch(
      /arista_valida|nota_coherente/,
    );
    expect(
      await intento({ event_type: 'payment.correction_noted', to_status: null, from_status: null }),
    ).toMatch(/tipo_sujeto|corrección anotada/);
    expect(await intento({ subject_seq: 0 })).toMatch(/seq_valido|no tiene huecos/);
    expect(await intento({ subject_seq: 1 })).toMatch(/seq_valido|no tiene huecos/);
    expect(await intento({ subject_seq: 5 })).toMatch(/no tiene huecos/);
    expect(await intento({ subject_seq: 1, from_status: null })).toMatch(
      /no tiene huecos|creación no coincide/,
    );
  });

  it('hechos exigidos: enviado/entregado/pago con fecha; pago con referencia', async () => {
    const { ci } = await nuevaParticipacion('eventos-hechos', [e.productos.p80]);
    const envio = await transaction((c) => crearEnvio(c, { ci, items: [[e.productos.p80, 1]] }));
    await transaction((c) =>
      mover(c, { tabla: 'shipments', id: envio, tipo: 'shipment.prepared', hacia: 'prepared' }),
    );
    const enviar = (extra: Record<string, unknown>) =>
      rechazo(() =>
        transaction((c) =>
          insertar(c, 'operational_events', {
            organization_id: e.admin.organizationId,
            campaign_id: e.campanaId,
            subject_type: 'shipment',
            shipment_id: envio,
            event_type: 'shipment.shipped',
            from_status: 'prepared',
            to_status: 'shipped',
            subject_seq: 3,
            recorded_by: e.operativo.id,
            idempotency_key: unico('idem'),
            request_hash: hashSolicitud(),
            ...extra,
          }),
        ),
      );
    expect(await enviar({})).toMatch(/operational_events_hechos_requeridos/);
    const { intentoPago } = await fresco();
    expect(await intentoPago({ external_reference: null })).toMatch(/operational_events_hechos_requeridos/);
    expect(await intentoPago({ happened_on: null })).toMatch(/operational_events_hechos_requeridos/);
  });

  it('clave de idempotencia, huella, fecha, referencia y nota válidas', async () => {
    const { intento } = await fresco();
    expect(await intento({ idempotency_key: '' })).toMatch(/operational_events_clave_valida/);
    expect(await intento({ idempotency_key: ' x' })).toMatch(/operational_events_clave_valida/);
    expect(await intento({ idempotency_key: 'x'.repeat(201) })).toMatch(/operational_events_clave_valida/);
    expect(await intento({ request_hash: 'abc' })).toMatch(/operational_events_huella_valida/);
    expect(await intento({ request_hash: 'A'.repeat(64) })).toMatch(/operational_events_huella_valida/);
    expect(await intento({ note: '   ' })).toMatch(/operational_events_nota_valida/);
    expect(await intento({ note: 'x'.repeat(2001) })).toMatch(/operational_events_nota_valida/);
    expect(await intento({ external_reference: ' ' })).toMatch(/operational_events_referencia_valida/);
    expect(await intento({ happened_on: '2099-01-01' })).toMatch(/futuro/);
  });

  it('UNIQUE(org, idempotency_key) y UNIQUE por sujeto (sujeto, subject_seq)', async () => {
    const { envio, base, intento } = await fresco();
    const clave = unico('idem-dup');
    await transaction(async (c) => {
      const ev = await insertar(c, 'operational_events', base({ idempotency_key: clave }));
      await c.query(
        `UPDATE shipments SET status = 'prepared', row_seq = 2, last_event_id = $2 WHERE id = $1`,
        [envio, ev],
      );
    });
    // misma clave en la misma organización: choca (aunque el resto cambie)
    expect(
      await intento({
        idempotency_key: clave,
        event_type: 'evidence.attached',
        from_status: null,
        to_status: null,
        subject_seq: 3,
      }),
    ).toMatch(/operational_events_idempotencia_key/);
    // misma posición del sujeto: la secuencia ya está ocupada
    expect(
      await intento({
        event_type: 'shipment.shipped',
        from_status: 'prepared',
        to_status: 'shipped',
        happened_on: dia(1),
        subject_seq: 2,
      }),
    ).toMatch(/no tiene huecos|operational_events_envio_seq_key/);
    // la unicidad es por organización
    const def = await fila<{ def: string }>(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'operational_events_idempotencia_key'`,
    );
    expect(def.def).toContain('organization_id, idempotency_key');
    const seq = await fila<{ def: string }>(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'operational_events_envio_seq_key'`,
    );
    expect(seq.def).toContain('shipment_id, subject_seq');
  });

  it('recorded_by: rol vigente por tipo (payment.reported ⇒ report_payment; resto ⇒ manage_ops)', async () => {
    const { intento, intentoPago } = await fresco();
    for (const quien of [e.director, e.consultor, e.analista, e.legal]) {
      expect(await intentoPago({ recorded_by: quien.id }), quien.role).toMatch(
        /no puede ejecutar «report_payment»/,
      );
    }
    expect(await intentoPago({ recorded_by: e.cliente.id })).toMatch(
      /no puede ejecutar|operational_events_autor_fkey/,
    );
    // el resto de acciones: manage_ops (el director sí; consultor, analista y legal no)
    for (const quien of [e.consultor, e.analista, e.legal]) {
      expect(await intento({ recorded_by: quien.id }), quien.role).toMatch(/no puede ejecutar «manage_ops»/);
    }
    // una persona de OTRA organización no se cuela (FK compuesta con la organización del evento)
    expect(await intento({ recorded_by: e.ajeno.id })).toMatch(/operational_events_autor_fkey/);
    // quien sí puede, pasa: el reporte lo registra un operativo
    await transaction(async (c) => {
      const f = await fresco();
      await mover(c, {
        tabla: 'payment_obligations',
        id: f.obligationId,
        tipo: 'payment.reported',
        hacia: 'reported_paid',
        por: e.operativo,
        happenedOn: dia(2),
        externalReference: 'TRX-R',
      });
    });
  });

  it('aislamiento: sujeto de otra campaña/organización no cabe (FK compuestas)', async () => {
    const { intento } = await fresco();
    expect(await intento({ campaign_id: e.otraCampanaId })).toMatch(/operational_events_envio_fkey/);
    expect(
      await intento({
        organization_id: e.ajeno.organizationId,
        campaign_id: e.campanaAjenaId,
        recorded_by: e.ajeno.id,
      }),
    ).toMatch(/operational_events_envio_fkey/);
  });

  it('append-only: sin UPDATE ni DELETE (ni con el bypass de pruebas para UPDATE)', async () => {
    const { ci } = await nuevaParticipacion('eventos-append', [e.productos.p80]);
    const envio = await transaction((c) => crearEnvio(c, { ci, items: [[e.productos.p80, 1]] }));
    const ev = await fila<{ id: string }>(`SELECT last_event_id AS id FROM shipments WHERE id = $1`, [envio]);
    expect(
      await rechazo(() => query(`UPDATE operational_events SET note = 'x' WHERE id = $1`, [ev.id])),
    ).toMatch(/append-only/);
    expect(
      await rechazo(() =>
        conBypass(
          async (c) =>
            void (await c.query(`UPDATE operational_events SET note = 'x' WHERE id = $1`, [ev.id])),
        ),
      ),
    ).toMatch(/append-only/);
    expect(await rechazo(() => query(`DELETE FROM operational_events WHERE id = $1`, [ev.id]))).toMatch(
      /no admite DELETE/,
    );
  });
});

describe('máquinas de estado: solo cambian con un evento', () => {
  const casos = (): Array<{
    nombre: Tabla;
    crear: () => Promise<string>;
    estado: string;
    evento: string;
    siguiente: string;
  }> => [
    {
      nombre: 'shipments',
      estado: 'pending',
      evento: 'shipment.prepared',
      siguiente: 'prepared',
      crear: async () => {
        const { ci } = await nuevaParticipacion('maq-envio', [e.productos.p80]);
        return transaction((c) => crearEnvio(c, { ci, items: [[e.productos.p80, 1]] }));
      },
    },
    {
      nombre: 'billing_documents',
      estado: 'registered',
      evento: 'billing.validated',
      siguiente: 'validated',
      crear: async () => {
        const { ci } = await nuevaParticipacion('maq-doc');
        const { obligationId } = await acuerdo({ ci, mode: 'fee' });
        return transaction((c) => crearDocumento(c, { obligationId }));
      },
    },
    {
      nombre: 'payment_obligations',
      estado: 'pending',
      evento: 'payment.cancelled',
      siguiente: 'cancelled',
      crear: async () => {
        const { ci } = await nuevaParticipacion('maq-oblig');
        return (await acuerdo({ ci, mode: 'fee' })).obligationId;
      },
    },
  ];

  it('UPDATE directo de status (sin evento) falla en las tres tablas', async () => {
    for (const caso of casos()) {
      const id = await caso.crear();
      expect(
        await rechazo(() =>
          query(`UPDATE ${caso.nombre} SET status = $2 WHERE id = $1`, [id, caso.siguiente]),
        ),
        caso.nombre,
      ).toMatch(/solo cambia con un evento operativo/);
      // ni tocando row_seq sin evento
      expect(
        await rechazo(() =>
          query(`UPDATE ${caso.nombre} SET status = $2, row_seq = row_seq + 1 WHERE id = $1`, [
            id,
            caso.siguiente,
          ]),
        ),
        caso.nombre,
      ).toMatch(/debe citar el evento|no es el evento/);
      // ni cambiando solo last_event_id
      expect(
        await rechazo(() => query(`UPDATE ${caso.nombre} SET last_event_id = NULL WHERE id = $1`, [id])),
        caso.nombre,
      ).toMatch(/solo cambia con un evento operativo|row_seq_valido/);
    }
  });

  it('el evento citado debe ser del MISMO sujeto, con el to_status y el seq correctos', async () => {
    const { ci } = await nuevaParticipacion('maq-cita', [e.productos.p80]);
    const a = await transaction((c) => crearEnvio(c, { ci, items: [[e.productos.p80, 1]] }));
    const { ci: ci2 } = await nuevaParticipacion('maq-cita-2', [e.productos.p80]);
    const b = await transaction((c) => crearEnvio(c, { ci: ci2, items: [[e.productos.p80, 1]] }));
    const eventoDeB = (
      await fila<{ last_event_id: string }>(`SELECT last_event_id FROM shipments WHERE id = $1`, [b])
    ).last_event_id;

    // evento de OTRO sujeto
    expect(
      await rechazo(() =>
        transaction(async (c) => {
          await insertar(c, 'operational_events', {
            organization_id: e.admin.organizationId,
            campaign_id: e.campanaId,
            subject_type: 'shipment',
            shipment_id: a,
            event_type: 'shipment.prepared',
            from_status: 'pending',
            to_status: 'prepared',
            subject_seq: 2,
            recorded_by: e.operativo.id,
            idempotency_key: unico('i'),
            request_hash: hashSolicitud(),
          });
          await c.query(
            `UPDATE shipments SET status = 'prepared', row_seq = 2, last_event_id = $2 WHERE id = $1`,
            [a, eventoDeB],
          );
        }),
      ),
    ).toMatch(/no es el evento 2 de este sujeto/);

    // evento con otro to_status
    expect(
      await rechazo(() =>
        transaction(async (c) => {
          const ev = await insertar(c, 'operational_events', {
            organization_id: e.admin.organizationId,
            campaign_id: e.campanaId,
            subject_type: 'shipment',
            shipment_id: a,
            event_type: 'shipment.cancelled',
            from_status: 'pending',
            to_status: 'cancelled',
            subject_seq: 2,
            recorded_by: e.operativo.id,
            idempotency_key: unico('i'),
            request_hash: hashSolicitud(),
          });
          await c.query(
            `UPDATE shipments SET status = 'prepared', row_seq = 2, last_event_id = $2 WHERE id = $1`,
            [a, ev],
          );
        }),
      ),
    ).toMatch(/Transición no válida/);

    // row_seq que salta
    expect(
      await rechazo(() =>
        transaction(async (c) => {
          const ev = await insertar(c, 'operational_events', {
            organization_id: e.admin.organizationId,
            campaign_id: e.campanaId,
            subject_type: 'shipment',
            shipment_id: a,
            event_type: 'shipment.prepared',
            from_status: 'pending',
            to_status: 'prepared',
            subject_seq: 2,
            recorded_by: e.operativo.id,
            idempotency_key: unico('i'),
            request_hash: hashSolicitud(),
          });
          await c.query(
            `UPDATE shipments SET status = 'prepared', row_seq = 3, last_event_id = $2 WHERE id = $1`,
            [a, ev],
          );
        }),
      ),
    ).toMatch(/solo avanza de uno en uno/);

    // un evento de estado sin cambio de estado
    expect(
      await rechazo(() =>
        transaction(async (c) => {
          const ev = await insertar(c, 'operational_events', {
            organization_id: e.admin.organizationId,
            campaign_id: e.campanaId,
            subject_type: 'shipment',
            shipment_id: a,
            event_type: 'shipment.prepared',
            from_status: 'pending',
            to_status: 'prepared',
            subject_seq: 2,
            recorded_by: e.operativo.id,
            idempotency_key: unico('i'),
            request_hash: hashSolicitud(),
          });
          await c.query(`UPDATE shipments SET row_seq = 2, last_event_id = $2 WHERE id = $1`, [a, ev]);
        }),
      ),
    ).toMatch(/exige el cambio de estado/);
  });

  it('un evento insertado sin aplicar al sujeto (huérfano) o un sujeto sin evento de creación no sobreviven al commit', async () => {
    const { ci } = await nuevaParticipacion('maq-huerfano', [e.productos.p80]);
    const id = await transaction((c) => crearEnvio(c, { ci, items: [[e.productos.p80, 1]] }));
    expect(
      await rechazo(() =>
        transaction((c) =>
          insertar(c, 'operational_events', {
            organization_id: e.admin.organizationId,
            campaign_id: e.campanaId,
            subject_type: 'shipment',
            shipment_id: id,
            event_type: 'shipment.prepared',
            from_status: 'pending',
            to_status: 'prepared',
            subject_seq: 2,
            recorded_by: e.operativo.id,
            idempotency_key: unico('i'),
            request_hash: hashSolicitud(),
          }),
        ),
      ),
    ).toMatch(/no se aplicó a su sujeto/);
    const { ci: ci2 } = await nuevaParticipacion('maq-sin-creacion');
    expect(
      await rechazo(() =>
        transaction((c) =>
          insertar(c, 'shipments', {
            organization_id: e.admin.organizationId,
            campaign_id: e.campanaId,
            campaign_influencer_id: ci2,
            created_by: e.operativo.id,
          }),
        ),
      ),
    ).toMatch(/evento de creación/);
    // un sujeto no nace en otro estado ni con seq > 0
    expect(
      await rechazo(() =>
        query(
          `INSERT INTO shipments (organization_id, campaign_id, campaign_influencer_id, created_by, status) VALUES ($1, $2, $3, $4, 'shipped')`,
          [e.admin.organizationId, e.campanaId, ci2, e.operativo.id],
        ),
      ),
    ).toMatch(/nace pendiente/);
  });

  it('recorrido completo del envío, con las aristas y los hechos exigidos', async () => {
    const { ci } = await nuevaParticipacion('maq-envio-completo', [e.productos.p80]);
    const id = await transaction((c) => crearEnvio(c, { ci, items: [[e.productos.p80, 2]] }));
    const paso = (tipo: string, hacia: string, extra: Partial<Mover> = {}) =>
      transaction((c) => mover(c, { tabla: 'shipments', id, tipo, hacia, ...extra }));
    // saltarse pasos falla: delivered solo desde shipped
    expect(await rechazo(() => paso('shipment.delivered', 'delivered', { happenedOn: dia(1) }))).toMatch(
      /operational_events_arista_valida|no es el estado vigente/,
    );
    await paso('shipment.prepared', 'prepared');
    expect(await rechazo(() => paso('shipment.delivered', 'delivered', { happenedOn: dia(1) }))).toMatch(
      /operational_events_arista_valida/,
    );
    await paso('shipment.shipped', 'shipped', {
      happenedOn: dia(1),
      set: { carrier: 'Servientrega', tracking_ref: 'G-123' },
    });
    expect(
      await rechazo(() => paso('shipment.cancelled', 'cancelled', { set: { cancel_reason: 'x' } })),
    ).toMatch(/operational_events_arista_valida/);
    await paso('shipment.delivered', 'delivered', { happenedOn: dia(0) });
    await paso('shipment.returned', 'returned');
    const s = await fila<{ status: string; row_seq: number; carrier: string }>(
      `SELECT status, row_seq, carrier FROM shipments WHERE id = $1`,
      [id],
    );
    expect(s).toMatchObject({ status: 'returned', row_seq: 5, carrier: 'Servientrega' });
    // terminal: nada sale de returned ni se editan sus datos
    expect(await rechazo(() => paso('shipment.shipped', 'shipped', { happenedOn: dia(0) }))).toMatch(
      /operational_events_arista_valida/,
    );
    expect(await rechazo(() => query(`UPDATE shipments SET carrier = 'otra' WHERE id = $1`, [id]))).toMatch(
      /histórico/,
    );
  });

  it('cancelar un envío exige motivo y solo desde pending o prepared', async () => {
    const { ci } = await nuevaParticipacion('maq-cancelar', [e.productos.p80]);
    const id = await transaction((c) => crearEnvio(c, { ci, items: [[e.productos.p80, 1]] }));
    expect(
      await rechazo(() =>
        transaction((c) =>
          mover(c, { tabla: 'shipments', id, tipo: 'shipment.cancelled', hacia: 'cancelled' }),
        ),
      ),
    ).toMatch(/shipments_cancelacion_coherente/);
    await transaction((c) =>
      mover(c, {
        tabla: 'shipments',
        id,
        tipo: 'shipment.cancelled',
        hacia: 'cancelled',
        set: { cancel_reason: 'KOL no disponible' },
      }),
    );
    expect(
      await rechazo(() => query(`UPDATE shipments SET cancel_reason = NULL WHERE id = $1`, [id])),
    ).toMatch(/shipments_cancelacion_coherente|histórico/);
  });

  it('nota/evidencia: avanza row_seq sin cambiar el estado; la corrección solo sobre un pago reportado', async () => {
    const { ci } = await nuevaParticipacion('maq-nota');
    const { obligationId } = await acuerdo({ ci, mode: 'fee' });
    expect(
      await rechazo(() =>
        transaction((c) =>
          mover(c, {
            tabla: 'payment_obligations',
            id: obligationId,
            tipo: 'payment.correction_noted',
            note: 'ajuste',
          }),
        ),
      ),
    ).toMatch(/ya reportado admite una corrección/);
    await transaction((c) =>
      mover(c, {
        tabla: 'payment_obligations',
        id: obligationId,
        tipo: 'payment.reported',
        hacia: 'reported_paid',
        happenedOn: dia(2),
        externalReference: 'TRX-N',
      }),
    );
    await transaction((c) =>
      mover(c, {
        tabla: 'payment_obligations',
        id: obligationId,
        tipo: 'payment.correction_noted',
        note: 'Referencia corregida por el banco',
      }),
    );
    const o = await fila<{ status: string; row_seq: number; external_reference: string }>(
      `SELECT status, row_seq, external_reference FROM payment_obligations WHERE id = $1`,
      [obligationId],
    );
    expect(o).toMatchObject({ status: 'reported_paid', row_seq: 3, external_reference: 'TRX-N' });
  });
});

describe('pago reportado: sellado e inmutable', () => {
  it('los sellos salen del evento (quién, cuándo, fecha, referencia) y quedan fijos', async () => {
    const { ci } = await nuevaParticipacion('sello');
    const { obligationId } = await acuerdo({ ci, mode: 'fee' });
    await transaction((c) =>
      mover(c, {
        tabla: 'payment_obligations',
        id: obligationId,
        tipo: 'payment.reported',
        hacia: 'reported_paid',
        por: e.operativo,
        happenedOn: dia(3),
        externalReference: 'TRX-SELLO',
      }),
    );
    const o = await fila<{
      reported_by: string;
      reported_at: Date;
      paid_on: Date;
      external_reference: string;
      billing_validated_at_report: boolean;
    }>(
      `SELECT reported_by, reported_at, paid_on::text AS paid_on, external_reference, billing_validated_at_report FROM payment_obligations WHERE id = $1`,
      [obligationId],
    );
    expect(o.reported_by).toBe(e.operativo.id);
    expect(o.reported_at).toBeInstanceOf(Date);
    expect(o.paid_on).toBe(dia(3));
    expect(o.external_reference).toBe('TRX-SELLO');
    // sin documento validado: NO se bloquea, se deja constancia
    expect(o.billing_validated_at_report).toBe(false);
    for (const set of [
      `paid_on = '2026-10-05'`,
      `external_reference = 'otra'`,
      `reported_by = '${e.admin.id}'`,
      `billing_validated_at_report = true`,
      `reported_at = now() + interval '1 day'`,
    ]) {
      expect(
        await rechazo(() => query(`UPDATE payment_obligations SET ${set} WHERE id = $1`, [obligationId])),
        set,
      ).toMatch(/sellado|no se modifica/);
    }
    // terminal
    for (const [tipo, hacia] of [
      ['payment.cancelled', 'cancelled'],
      ['payment.applicability_set', 'not_applicable'],
      ['payment.applicability_set', 'pending'],
    ] as const) {
      expect(
        await rechazo(() =>
          transaction((c) => mover(c, { tabla: 'payment_obligations', id: obligationId, tipo, hacia })),
        ),
        `${tipo} → ${hacia}`,
      ).toMatch(/operational_events_arista_valida/);
    }
  });

  it('con documento validado queda billing_validated_at_report = true', async () => {
    const { ci } = await nuevaParticipacion('sello-doc');
    const { obligationId } = await acuerdo({ ci, mode: 'fee' });
    const doc = await transaction((c) => crearDocumento(c, { obligationId }));
    await transaction((c) =>
      mover(c, { tabla: 'billing_documents', id: doc, tipo: 'billing.validated', hacia: 'validated' }),
    );
    await transaction((c) =>
      mover(c, {
        tabla: 'payment_obligations',
        id: obligationId,
        tipo: 'payment.reported',
        hacia: 'reported_paid',
        happenedOn: dia(3),
        externalReference: 'TRX-OK',
      }),
    );
    expect(
      (
        await fila<{ billing_validated_at_report: boolean }>(
          `SELECT billing_validated_at_report FROM payment_obligations WHERE id = $1`,
          [obligationId],
        )
      ).billing_validated_at_report,
    ).toBe(true);
  });

  it('un reporte sin fecha o sin referencia no cabe en el evento (CHECK), y el canje no se reporta', async () => {
    const { ci } = await nuevaParticipacion('sello-barter', [e.productos.p80]);
    const { obligationId } = await acuerdo({ ci, mode: 'barter', productos: [[e.productos.p80, 1]] });
    expect(
      await rechazo(() =>
        transaction((c) =>
          mover(c, {
            tabla: 'payment_obligations',
            id: obligationId,
            tipo: 'payment.reported',
            hacia: 'reported_paid',
            happenedOn: dia(3),
            externalReference: 'T',
          }),
        ),
      ),
    ).toMatch(/operational_events_arista_valida/);
    expect(
      await rechazo(() =>
        query(`UPDATE payment_obligations SET reported_by = $2 WHERE id = $1`, [
          obligationId,
          e.operativo.id,
        ]),
      ),
    ).toMatch(/payment_obligations_reporte_completo/);
  });

  it('con el acuerdo cancelado ya no se reporta el pago ni se reabre la obligación; sí se puede cancelar', async () => {
    const { ci } = await nuevaParticipacion('sello-cancelado');
    const { agreementId, obligationId } = await acuerdo({ ci, mode: 'fee' });
    await query(
      `UPDATE agreements SET status = 'cancelled', cancelled_by = $2, cancel_reason = 'fin' WHERE id = $1`,
      [agreementId, e.operativo.id],
    );
    expect(
      await rechazo(() =>
        transaction((c) =>
          mover(c, {
            tabla: 'payment_obligations',
            id: obligationId,
            tipo: 'payment.reported',
            hacia: 'reported_paid',
            happenedOn: dia(2),
            externalReference: 'TRX-C',
          }),
        ),
      ),
    ).toMatch(/acuerdo activo con tarifa/);
    await transaction((c) =>
      mover(c, {
        tabla: 'payment_obligations',
        id: obligationId,
        tipo: 'payment.cancelled',
        hacia: 'cancelled',
      }),
    );
  });

  it('concurrencia: dos transiciones con el mismo row_seq → una gana, la otra falla (sin doble reporte)', async () => {
    const { ci } = await nuevaParticipacion('concurrencia');
    const { obligationId } = await acuerdo({ ci, mode: 'fee' });
    const a = await pool().connect();
    const b = await pool().connect();
    try {
      await a.query('BEGIN');
      await b.query('BEGIN');
      await mover(a, {
        tabla: 'payment_obligations',
        id: obligationId,
        tipo: 'payment.reported',
        hacia: 'reported_paid',
        happenedOn: dia(3),
        externalReference: 'TRX-A',
      });
      // B queda esperando el bloqueo del sujeto hasta que A termine
      const pendiente = mover(b, {
        tabla: 'payment_obligations',
        id: obligationId,
        tipo: 'payment.cancelled',
        hacia: 'cancelled',
      }).then(
        () => '',
        (error: Error) => error.message,
      );
      await new Promise((r) => setTimeout(r, 200));
      await a.query('COMMIT');
      const mensaje = await pendiente;
      expect(mensaje).toMatch(
        /operational_events_arista_valida|estado de origen|no tiene huecos|no es el estado vigente/,
      );
      await b.query('ROLLBACK');
    } finally {
      a.release();
      b.release();
    }
    expect(
      (await fila<{ status: string }>(`SELECT status FROM payment_obligations WHERE id = $1`, [obligationId]))
        .status,
    ).toBe('reported_paid');
  });
});

// ─────────────────────────── 5. Envíos ─────────────────────────────────────────

describe('envíos', () => {
  it('datos válidos: costo con moneda, transportadora/guía sin control, motivo de cancelación', async () => {
    const { ci } = await nuevaParticipacion('envio-datos');
    const intento = (extra: Record<string, unknown>) =>
      rechazo(() => transaction((c) => crearEnvio(c, { ci, extra })));
    expect(await intento({ shipping_cost: 5000 })).toMatch(/shipments_costo_valido/);
    expect(await intento({ shipping_currency: 'COP' })).toMatch(/shipments_costo_valido/);
    expect(await intento({ shipping_cost: -1, shipping_currency: 'COP' })).toMatch(/shipments_costo_valido/);
    expect(await intento({ shipping_cost: 10, shipping_currency: 'cop' })).toMatch(/shipments_costo_valido/);
    expect(await intento({ carrier: '  ' })).toMatch(/shipments_transportadora_valida/);
    expect(await intento({ tracking_ref: 'a\u0007b' })).toMatch(/shipments_guia_valida/);
    expect(await intento({ cancel_reason: 'x' })).toMatch(/nace pendiente/);
    await transaction((c) => crearEnvio(c, { ci, extra: { shipping_cost: 0, shipping_currency: 'COP' } }));
  });

  it('roles y aislamiento del alta', async () => {
    const { ci } = await nuevaParticipacion('envio-rol');
    for (const quien of [e.consultor, e.analista, e.legal]) {
      expect(await rechazo(() => transaction((c) => crearEnvio(c, { ci, por: quien }))), quien.role).toMatch(
        /no puede ejecutar/,
      );
    }
    const otra = await nuevaParticipacion('envio-otra', [], e.otraCampanaId);
    expect(
      await rechazo(() =>
        insertar(pool(), 'shipments', {
          organization_id: e.admin.organizationId,
          campaign_id: e.campanaId,
          campaign_influencer_id: otra.ci,
          created_by: e.operativo.id,
        }),
      ),
    ).toMatch(/shipments_participacion_fkey/);
  });

  it('ítems: un producto por envío, cantidad > 0, solo con el envío pendiente', async () => {
    const { ci } = await nuevaParticipacion('envio-items', [e.productos.p80, e.productos.pro]);
    const id = await transaction((c) => crearEnvio(c, { ci, items: [[e.productos.p80, 1]] }));
    const item = (producto: string, cantidad: number) =>
      insertar(pool(), 'shipment_items', {
        organization_id: e.admin.organizationId,
        campaign_id: e.campanaId,
        shipment_id: id,
        campaign_product_id: producto,
        quantity: cantidad,
        created_by: e.operativo.id,
      });
    expect(await rechazo(() => item(e.productos.p80, 1))).toMatch(/shipment_items_unico_key/);
    expect(await rechazo(() => item(e.productos.pro, 0))).toMatch(/shipment_items_cantidad_valida/);
    const ajenoProducto = await productoDeOtraCampana();
    expect(await rechazo(() => item(ajenoProducto, 1))).toMatch(/shipment_items_producto_fkey/);
    await item(e.productos.pro, 3);
    await transaction((c) =>
      mover(c, { tabla: 'shipments', id, tipo: 'shipment.prepared', hacia: 'prepared' }),
    );
    expect(await rechazo(() => item(e.productos.pro, 1))).toMatch(
      /Solo se agregan ítems a un envío pendiente/,
    );
    expect(
      await rechazo(() => query(`UPDATE shipment_items SET quantity = 9 WHERE shipment_id = $1`, [id])),
    ).toMatch(/append-only/);
    expect(await rechazo(() => query(`DELETE FROM shipment_items WHERE shipment_id = $1`, [id]))).toMatch(
      /no admite DELETE/,
    );
  });

  it('preparar: ≥ 1 ítem y cada ítem asignado a la participación', async () => {
    const { ci } = await nuevaParticipacion('envio-prep', [e.productos.p80]);
    const vacio = await transaction((c) => crearEnvio(c, { ci }));
    expect(
      await rechazo(() =>
        transaction((c) =>
          mover(c, { tabla: 'shipments', id: vacio, tipo: 'shipment.prepared', hacia: 'prepared' }),
        ),
      ),
    ).toMatch(/sin ítems no se prepara/);
    // ítem de un producto que NO está asignado a la participación
    const sinAsignar = await transaction((c) => crearEnvio(c, { ci, items: [[e.productos.pro, 1]] }));
    expect(
      await rechazo(() =>
        transaction((c) =>
          mover(c, { tabla: 'shipments', id: sinAsignar, tipo: 'shipment.prepared', hacia: 'prepared' }),
        ),
      ),
    ).toMatch(/no está asignado a esta participación/);
    const bien = await transaction((c) => crearEnvio(c, { ci, items: [[e.productos.p80, 1]] }));
    await transaction((c) =>
      mover(c, { tabla: 'shipments', id: bien, tipo: 'shipment.prepared', hacia: 'prepared' }),
    );
  });

  it('preparar con acuerdo barter/mixed: el ítem debe estar comprometido en la versión vigente; con fee, no', async () => {
    const { ci } = await nuevaParticipacion('envio-comprom', [e.productos.p80, e.productos.pro]);
    const { agreementId } = await acuerdo({ ci, mode: 'mixed', productos: [[e.productos.p80, 2]] });
    const preparar = async (producto: string) => {
      const id = await transaction((c) => crearEnvio(c, { ci, items: [[producto, 1]] }));
      return rechazo(() =>
        transaction((c) =>
          mover(c, { tabla: 'shipments', id, tipo: 'shipment.prepared', hacia: 'prepared' }),
        ),
      );
    };
    expect(await preparar(e.productos.pro)).toMatch(/no está comprometido en la versión vigente/);
    expect(await preparar(e.productos.p80)).toBe('');
    // la versión 2 pasa a fee puro (sin compromisos): asignado basta
    await transaction(async (c) => {
      await insertar(c, 'agreement_versions', {
        organization_id: e.admin.organizationId,
        campaign_id: e.campanaId,
        agreement_id: agreementId,
        compensation_type: 'fee',
        fee_amount: 10,
        fee_currency: 'COP',
        change_reason: 'a tarifa',
        created_by: e.operativo.id,
      });
      const o = await fila<{ id: string }>(`SELECT id FROM payment_obligations WHERE agreement_id = $1`, [
        agreementId,
      ]);
      void o;
    });
    expect(await preparar(e.productos.pro)).toBe('');
  });

  it('pii_record_id: solo un registro del MISMO influencer, vigente y de la misma organización', async () => {
    const a = await nuevaParticipacion('envio-pii-a');
    const b = await nuevaParticipacion('envio-pii-b');
    const piiA = await insertarPii(a.influencerId, { cedula: '1000000001' });
    const piiB = await insertarPii(b.influencerId, { cedula: '1000000002' });
    expect(
      await rechazo(() => transaction((c) => crearEnvio(c, { ci: a.ci, extra: { pii_record_id: piiB } }))),
    ).toMatch(/no pertenece al influencer/);
    expect(
      await rechazo(() =>
        transaction((c) => crearEnvio(c, { ci: a.ci, extra: { pii_record_id: randomUuid() } })),
      ),
    ).toMatch(/shipments_pii_fkey|no pertenece/);
    const id = await transaction((c) => crearEnvio(c, { ci: a.ci, extra: { pii_record_id: piiA } }));
    expect(
      await rechazo(() => query(`UPDATE shipments SET pii_record_id = $2 WHERE id = $1`, [id, piiB])),
    ).toMatch(/no pertenece al influencer/);
    // un registro borrado (cripto-borrado) no se vincula
    await borrarPii(piiA);
    expect(
      await rechazo(() => transaction((c) => crearEnvio(c, { ci: a.ci, extra: { pii_record_id: piiA } }))),
    ).toMatch(/fue borrado/);
  });
});

const randomUuid = (): string => '00000000-0000-4000-8000-' + randomBytes(6).toString('hex');

describe('guarda de desasignación (campaign_influencer_products)', () => {
  it('no se desasigna un producto comprometido en la versión vigente', async () => {
    const { ci } = await nuevaParticipacion('guarda-comprom', [e.productos.p80, e.productos.pro]);
    await acuerdo({ ci, mode: 'barter', productos: [[e.productos.p80, 1]] });
    expect(
      await rechazo(() =>
        query(
          `DELETE FROM campaign_influencer_products WHERE campaign_influencer_id = $1 AND campaign_product_id = $2`,
          [ci, e.productos.p80],
        ),
      ),
    ).toMatch(/comprometido en el acuerdo vigente/);
    // el no comprometido sí
    await query(
      `DELETE FROM campaign_influencer_products WHERE campaign_influencer_id = $1 AND campaign_product_id = $2`,
      [ci, e.productos.pro],
    );
  });

  it('un compromiso de una versión ANTERIOR no bloquea; tampoco el de un acuerdo cancelado', async () => {
    const { ci } = await nuevaParticipacion('guarda-vieja', [e.productos.p80, e.productos.pro]);
    const { agreementId } = await acuerdo({ ci, mode: 'barter', productos: [[e.productos.p80, 1]] });
    await transaction(async (c) => {
      const v = await insertar(c, 'agreement_versions', {
        organization_id: e.admin.organizationId,
        campaign_id: e.campanaId,
        agreement_id: agreementId,
        compensation_type: 'barter',
        change_reason: 'otro producto',
        created_by: e.operativo.id,
      });
      await insertar(c, 'agreement_product_commitments', {
        organization_id: e.admin.organizationId,
        campaign_id: e.campanaId,
        agreement_version_id: v,
        campaign_product_id: e.productos.pro,
        quantity: 1,
      });
    });
    await query(
      `DELETE FROM campaign_influencer_products WHERE campaign_influencer_id = $1 AND campaign_product_id = $2`,
      [ci, e.productos.p80],
    );
    expect(
      await rechazo(() =>
        query(
          `DELETE FROM campaign_influencer_products WHERE campaign_influencer_id = $1 AND campaign_product_id = $2`,
          [ci, e.productos.pro],
        ),
      ),
    ).toMatch(/comprometido/);
    await query(
      `UPDATE agreements SET status = 'cancelled', cancelled_by = $2, cancel_reason = 'fin' WHERE id = $1`,
      [agreementId, e.operativo.id],
    );
    await query(
      `DELETE FROM campaign_influencer_products WHERE campaign_influencer_id = $1 AND campaign_product_id = $2`,
      [ci, e.productos.pro],
    );
  });

  it('no se desasigna un producto de un envío abierto (pending, prepared, shipped); sí tras entregarse o cancelarse', async () => {
    const { ci } = await nuevaParticipacion('guarda-envio', [e.productos.p80]);
    const id = await transaction((c) => crearEnvio(c, { ci, items: [[e.productos.p80, 1]] }));
    const borrar = () =>
      query(
        `DELETE FROM campaign_influencer_products WHERE campaign_influencer_id = $1 AND campaign_product_id = $2`,
        [ci, e.productos.p80],
      );
    expect(await rechazo(borrar)).toMatch(/envío abierto/);
    await transaction((c) =>
      mover(c, { tabla: 'shipments', id, tipo: 'shipment.prepared', hacia: 'prepared' }),
    );
    expect(await rechazo(borrar)).toMatch(/envío abierto/);
    await transaction((c) =>
      mover(c, { tabla: 'shipments', id, tipo: 'shipment.shipped', hacia: 'shipped', happenedOn: dia(1) }),
    );
    expect(await rechazo(borrar)).toMatch(/envío abierto/);
    await transaction((c) =>
      mover(c, {
        tabla: 'shipments',
        id,
        tipo: 'shipment.delivered',
        hacia: 'delivered',
        happenedOn: dia(0),
      }),
    );
    expect(await rechazo(borrar)).toBe('');
  });
});

// ─────────────────────────── 6. Documentos de cobro ────────────────────────────

describe('documentos de cobro', () => {
  it('el soporte es OBLIGATORIO, de la misma campaña y de tipo soporte_operativo', async () => {
    const { ci } = await nuevaParticipacion('doc-soporte');
    const { obligationId } = await acuerdo({ ci, mode: 'fee' });
    const intento = (extra: Record<string, unknown>) =>
      rechazo(() => transaction((c) => crearDocumento(c, { obligationId, extra })));
    expect(await intento({ source_document_id: null })).toMatch(/null value|not-null|debe ser una fuente/);
    // fuente de otra campaña de la misma organización
    expect(await intento({ source_document_id: await crearSoporte(e.otraCampanaId) })).toMatch(
      /billing_documents_fuente_campaign_fkey/,
    );
    // fuente de otra organización
    expect(await intento({ source_document_id: await crearSoporte(e.campanaAjenaId, e.ajeno) })).toMatch(
      /billing_documents_fuente_(org|campaign)_fkey/,
    );
    // fuente de otro tipo (un guion, un brief): no es soporte operativo
    const [otra] = await query<{ id: string }>(
      `INSERT INTO source_documents (campaign_id, organization_id, type, filename, file_id, mime_type, size_bytes, hash, status, created_by)
       VALUES ($1, $2, 'otro', 'x.md', $3, 'text/markdown', 10, $4, 'procesado', $5) RETURNING id`,
      [
        e.campanaId,
        e.admin.organizationId,
        unico('f'),
        createHash('sha256').update(unico('h')).digest('hex'),
        e.admin.id,
      ],
    );
    expect(await intento({ source_document_id: otra!.id })).toMatch(
      /debe ser una fuente de tipo soporte_operativo/,
    );
    await transaction((c) => crearDocumento(c, { obligationId }));
  });

  it('solo se registra contra una obligación pending o reported_paid', async () => {
    const { ci } = await nuevaParticipacion('doc-oblig', [e.productos.p80]);
    const { obligationId } = await acuerdo({ ci, mode: 'barter', productos: [[e.productos.p80, 1]] });
    expect(await rechazo(() => transaction((c) => crearDocumento(c, { obligationId })))).toMatch(
      /obligación de pago pendiente o ya reportada/,
    );
  });

  it('validar: un solo documento validado por obligación; número y archivo no se repiten mientras viven', async () => {
    const { ci } = await nuevaParticipacion('doc-unico');
    const { obligationId } = await acuerdo({ ci, mode: 'fee' });
    const d1 = await transaction((c) => crearDocumento(c, { obligationId, numero: 'CC-100' }));
    expect(
      await rechazo(() => transaction((c) => crearDocumento(c, { obligationId, numero: 'CC-100' }))),
    ).toMatch(/billing_documents_numero_vivo_key/);
    const soporte = await crearSoporte();
    const d2 = await transaction((c) =>
      crearDocumento(c, { obligationId, numero: 'CC-101', sourceId: soporte }),
    );
    expect(
      await rechazo(() =>
        transaction((c) => crearDocumento(c, { obligationId, numero: 'CC-102', sourceId: soporte })),
      ),
    ).toMatch(/billing_documents_fuente_viva_key/);
    await transaction((c) =>
      mover(c, { tabla: 'billing_documents', id: d1, tipo: 'billing.validated', hacia: 'validated' }),
    );
    // el segundo validado choca con el índice único parcial
    expect(
      await rechazo(() =>
        transaction((c) =>
          mover(c, { tabla: 'billing_documents', id: d2, tipo: 'billing.validated', hacia: 'validated' }),
        ),
      ),
    ).toMatch(/billing_documents_validado_key/);
    // anulado el primero, el segundo puede validarse
    await transaction((c) =>
      mover(c, { tabla: 'billing_documents', id: d1, tipo: 'billing.voided', hacia: 'voided' }),
    );
    await transaction((c) =>
      mover(c, { tabla: 'billing_documents', id: d2, tipo: 'billing.validated', hacia: 'validated' }),
    );
    // el número de un documento anulado queda libre
    await transaction((c) => crearDocumento(c, { obligationId, numero: 'CC-100' }));
  });

  it('registrar ≠ validar ≠ pagar: sello de validación desde el evento; rechazado y anulado son terminales', async () => {
    const { ci } = await nuevaParticipacion('doc-estados');
    const { obligationId } = await acuerdo({ ci, mode: 'fee' });
    const doc = await transaction((c) => crearDocumento(c, { obligationId }));
    const antes = await fila<{ status: string; validated_by: string | null }>(
      `SELECT status, validated_by FROM billing_documents WHERE id = $1`,
      [doc],
    );
    expect(antes).toMatchObject({ status: 'registered', validated_by: null });
    // un documento no se «valida» por UPDATE ni se le fijan sellos a mano
    expect(
      await rechazo(() =>
        query(`UPDATE billing_documents SET validated_by = $2, validated_at = now() WHERE id = $1`, [
          doc,
          e.admin.id,
        ]),
      ),
    ).toMatch(/billing_documents_validado_coherente|sello de validación/);
    await transaction((c) =>
      mover(c, {
        tabla: 'billing_documents',
        id: doc,
        tipo: 'billing.validated',
        hacia: 'validated',
        por: e.director,
      }),
    );
    const v = await fila<{ status: string; validated_by: string; validated_at: Date }>(
      `SELECT status, validated_by, validated_at FROM billing_documents WHERE id = $1`,
      [doc],
    );
    expect(v.status).toBe('validated');
    expect(v.validated_by).toBe(e.director.id);
    expect(v.validated_at).toBeInstanceOf(Date);
    expect(
      await rechazo(() =>
        query(`UPDATE billing_documents SET validated_by = $2 WHERE id = $1`, [doc, e.admin.id]),
      ),
    ).toMatch(/sello de validación/);
    // validated → rejected no existe; validated → voided sí (conserva el sello)
    expect(
      await rechazo(() =>
        transaction((c) =>
          mover(c, { tabla: 'billing_documents', id: doc, tipo: 'billing.rejected', hacia: 'rejected' }),
        ),
      ),
    ).toMatch(/operational_events_arista_valida/);
    await transaction((c) =>
      mover(c, { tabla: 'billing_documents', id: doc, tipo: 'billing.voided', hacia: 'voided' }),
    );
    expect(
      (
        await fila<{ validated_by: string }>(`SELECT validated_by FROM billing_documents WHERE id = $1`, [
          doc,
        ])
      ).validated_by,
    ).toBe(e.director.id);
    expect(
      await rechazo(() =>
        transaction((c) =>
          mover(c, { tabla: 'billing_documents', id: doc, tipo: 'billing.validated', hacia: 'validated' }),
        ),
      ),
    ).toMatch(/operational_events_arista_valida/);
    // rechazar un registrado: terminal
    const otro = await transaction((c) => crearDocumento(c, { obligationId }));
    await transaction((c) =>
      mover(c, { tabla: 'billing_documents', id: otro, tipo: 'billing.rejected', hacia: 'rejected' }),
    );
    expect(
      await rechazo(() =>
        transaction((c) =>
          mover(c, { tabla: 'billing_documents', id: otro, tipo: 'billing.voided', hacia: 'voided' }),
        ),
      ),
    ).toMatch(/operational_events_arista_valida/);
  });

  it('los datos registrados no se editan; sin DELETE', async () => {
    const { ci } = await nuevaParticipacion('doc-inmutable');
    const { obligationId } = await acuerdo({ ci, mode: 'fee' });
    const doc = await transaction((c) => crearDocumento(c, { obligationId }));
    for (const set of [
      `claimed_amount = 1`,
      `claimed_currency = 'USD'`,
      `document_number = 'otro'`,
      `issued_on = '2020-01-01'`,
      `payment_obligation_id = payment_obligation_id`,
    ]) {
      const msg = await rechazo(() => query(`UPDATE billing_documents SET ${set} WHERE id = $1`, [doc]));
      if (set.startsWith('payment_obligation_id')) expect(msg).toBe('');
      else expect(msg, set).toMatch(/no se edita/);
    }
    const otroSoporte = await crearSoporte();
    expect(
      await rechazo(() =>
        query(`UPDATE billing_documents SET source_document_id = $2 WHERE id = $1`, [doc, otroSoporte]),
      ),
    ).toMatch(/no se edita/);
    expect(await rechazo(() => query(`DELETE FROM billing_documents WHERE id = $1`, [doc]))).toMatch(
      /no admite DELETE/,
    );
  });

  it('validaciones de monto y moneda reclamados; roles', async () => {
    const { ci } = await nuevaParticipacion('doc-monto');
    const { obligationId } = await acuerdo({ ci, mode: 'fee' });
    const intento = (extra: Record<string, unknown>, por?: User) =>
      rechazo(() => transaction((c) => crearDocumento(c, { obligationId, extra, ...(por ? { por } : {}) })));
    expect(await intento({ claimed_amount: 0 })).toMatch(/billing_documents_monto_valido/);
    expect(await intento({ claimed_currency: 'cop' })).toMatch(/billing_documents_moneda_valida/);
    expect(await intento({ document_number: '  ' })).toMatch(/billing_documents_numero_valido/);
    expect(await intento({ status: 'validated' })).toMatch(/nace registrado/);
    for (const quien of [e.consultor, e.analista, e.legal]) {
      expect(await intento({}, quien), quien.role).toMatch(/no puede ejecutar/);
    }
    // el consultor tampoco VALIDA (rol del evento)
    const doc = await transaction((c) => crearDocumento(c, { obligationId }));
    expect(
      await rechazo(() =>
        transaction((c) =>
          mover(c, {
            tabla: 'billing_documents',
            id: doc,
            tipo: 'billing.validated',
            hacia: 'validated',
            por: e.consultor,
          }),
        ),
      ),
    ).toMatch(/no puede ejecutar «manage_ops»/);
  });
});

// ─────────────────────────── 7. Evidencia ──────────────────────────────────────

describe('operational_evidence', () => {
  async function eventoDeEvidencia(c: pg.PoolClient, obligationId: string): Promise<string> {
    return mover(c, {
      tabla: 'payment_obligations',
      id: obligationId,
      tipo: 'evidence.attached',
      note: 'Soporte',
    });
  }

  it('evidencia = fuente soporte_operativo de la misma organización y campaña; una vez por (evento, fuente)', async () => {
    const { ci } = await nuevaParticipacion('evid');
    const { obligationId } = await acuerdo({ ci, mode: 'fee' });
    const evidencia = (
      c: pg.PoolClient,
      evento: string,
      fuente: string,
      extra: Record<string, unknown> = {},
    ) =>
      insertar(c, 'operational_evidence', {
        organization_id: e.admin.organizationId,
        campaign_id: e.campanaId,
        event_id: evento,
        source_document_id: fuente,
        kind: 'comprobante',
        attached_by: e.operativo.id,
        ...extra,
      });

    const fuente = await crearSoporte();
    expect(
      await rechazo(() =>
        transaction(async (c) => {
          const ev = await eventoDeEvidencia(c, obligationId);
          await evidencia(c, ev, fuente);
          await evidencia(c, ev, fuente);
        }),
      ),
    ).toMatch(/operational_evidence_unica_key/);

    const ok = await transaction(async (c) => {
      const ev = await eventoDeEvidencia(c, obligationId);
      return { ev, id: await evidencia(c, ev, fuente) };
    });
    expect(ok.id).toBeTruthy();

    const malos: Array<[string, (c: pg.PoolClient, ev: string) => Promise<unknown>, RegExp]> = [
      [
        'kind inválido',
        async (c, ev) => evidencia(c, ev, await crearSoporte(), { kind: 'foto' }),
        /operational_evidence_tipo_valido/,
      ],
      [
        'otra campaña',
        async (c, ev) => evidencia(c, ev, await crearSoporte(e.otraCampanaId)),
        /operational_evidence_fuente_campaign_fkey/,
      ],
      [
        'otra organización',
        async (c, ev) => evidencia(c, ev, await crearSoporte(e.campanaAjenaId, e.ajeno)),
        /operational_evidence_fuente_(org|campaign)_fkey/,
      ],
      [
        'rol sin capacidad',
        async (c, ev) => evidencia(c, ev, await crearSoporte(), { attached_by: e.consultor.id }),
        /no puede ejecutar «manage_ops»/,
      ],
      [
        'persona de otra organización',
        async (c, ev) => evidencia(c, ev, await crearSoporte(), { attached_by: e.ajeno.id }),
        /operational_evidence_autor_fkey/,
      ],
      [
        'retirada al nacer',
        async (c, ev) =>
          evidencia(c, ev, await crearSoporte(), { retracted_at: new Date(), retracted_by: e.operativo.id }),
        /nace vigente/,
      ],
    ];
    for (const [nombre, fn, patron] of malos) {
      expect(
        await rechazo(() => transaction(async (c) => fn(c, await eventoDeEvidencia(c, obligationId)))),
        nombre,
      ).toMatch(patron);
    }
  });

  it('una fuente que no es soporte operativo no es evidencia', async () => {
    const { ci } = await nuevaParticipacion('evid-tipo');
    const { obligationId } = await acuerdo({ ci, mode: 'fee' });
    const [otra] = await query<{ id: string }>(
      `INSERT INTO source_documents (campaign_id, organization_id, type, filename, file_id, mime_type, size_bytes, hash, status, created_by)
       VALUES ($1, $2, 'ficha_tecnica', 'f.pdf', $3, 'application/pdf', 10, $4, 'procesado', $5) RETURNING id`,
      [
        e.campanaId,
        e.admin.organizationId,
        unico('f'),
        createHash('sha256').update(unico('h')).digest('hex'),
        e.admin.id,
      ],
    );
    expect(
      await rechazo(() =>
        transaction(async (c) => {
          const ev = await eventoDeEvidencia(c, obligationId);
          await insertar(c, 'operational_evidence', {
            organization_id: e.admin.organizationId,
            campaign_id: e.campanaId,
            event_id: ev,
            source_document_id: otra!.id,
            kind: 'soporte',
            attached_by: e.operativo.id,
          });
        }),
      ),
    ).toMatch(/debe ser una fuente de tipo soporte_operativo/);
  });

  it('evidence.attached exige su evidencia; la evidencia solo nace con su evento (misma transacción)', async () => {
    const { ci } = await nuevaParticipacion('evid-evento');
    const { obligationId } = await acuerdo({ ci, mode: 'fee' });
    expect(await rechazo(() => transaction((c) => eventoDeEvidencia(c, obligationId)))).toMatch(
      /exige su evidencia/,
    );
    // un evento viejo (otra transacción) ya no admite evidencia: se registra un evento nuevo
    const evViejo = await transaction((c) =>
      mover(c, {
        tabla: 'payment_obligations',
        id: obligationId,
        tipo: 'payment.cancelled',
        hacia: 'cancelled',
      }),
    );
    expect(
      await rechazo(async () =>
        insertar(pool(), 'operational_evidence', {
          organization_id: e.admin.organizationId,
          campaign_id: e.campanaId,
          event_id: evViejo,
          source_document_id: await crearSoporte(),
          kind: 'soporte',
          attached_by: e.operativo.id,
        }),
      ),
    ).toMatch(/misma transacción/);
  });

  it('retirar = marca (única mutación); el vínculo no se borra ni se reescribe', async () => {
    const { ci } = await nuevaParticipacion('evid-retiro');
    const { obligationId } = await acuerdo({ ci, mode: 'fee' });
    const fuente = await crearSoporte();
    const id = await transaction(async (c) => {
      const ev = await eventoDeEvidencia(c, obligationId);
      return insertar(c, 'operational_evidence', {
        organization_id: e.admin.organizationId,
        campaign_id: e.campanaId,
        event_id: ev,
        source_document_id: fuente,
        kind: 'guia',
        attached_by: e.operativo.id,
      });
    });
    expect(
      await rechazo(() => query(`UPDATE operational_evidence SET kind = 'otro' WHERE id = $1`, [id])),
    ).toMatch(/solo admite la marca de retiro/);
    expect(
      await rechazo(() =>
        query(
          `UPDATE operational_evidence SET retracted_at = now(), retracted_by = $2, kind = 'otro' WHERE id = $1`,
          [id, e.operativo.id],
        ),
      ),
    ).toMatch(/solo fija retracted_at/);
    expect(
      await rechazo(() =>
        query(`UPDATE operational_evidence SET retracted_at = now(), retracted_by = $2 WHERE id = $1`, [
          id,
          e.consultor.id,
        ]),
      ),
    ).toMatch(/no puede ejecutar/);
    await query(`UPDATE operational_evidence SET retracted_at = now(), retracted_by = $2 WHERE id = $1`, [
      id,
      e.operativo.id,
    ]);
    expect(
      await rechazo(() =>
        query(`UPDATE operational_evidence SET retracted_at = now(), retracted_by = $2 WHERE id = $1`, [
          id,
          e.operativo.id,
        ]),
      ),
    ).toMatch(/ya fue retirada/);
    expect(await rechazo(() => query(`DELETE FROM operational_evidence WHERE id = $1`, [id]))).toMatch(
      /no admite DELETE/,
    );
  });
});

// ─────────────────────────── 8. Fuentes soporte_operativo ──────────────────────

describe('fuentes soporte_operativo', () => {
  const nueva = (extra: Record<string, unknown> = {}) => {
    const unica = unico('s');
    return insertar(pool(), 'source_documents', {
      campaign_id: e.campanaId,
      organization_id: e.admin.organizationId,
      type: 'soporte_operativo',
      filename: `${unica}.pdf`,
      file_id: `test/${unica}`,
      mime_type: 'application/pdf',
      size_bytes: 10,
      hash: createHash('sha256').update(unica).digest('hex'),
      status: 'procesado',
      confidentiality_level: 'sensible',
      visibility: 'interna',
      created_by: e.admin.id,
      ...extra,
    });
  };

  it('siempre interna, sensible, archivo y procesada', async () => {
    expect(await rechazo(() => nueva({ visibility: 'tcl' }))).toMatch(/siempre interna/);
    expect(await rechazo(() => nueva({ visibility: 'compartida' }))).toMatch(/siempre interna/);
    expect(await rechazo(() => nueva({ confidentiality_level: 'interna' }))).toMatch(/sensible/);
    expect(await rechazo(() => nueva({ confidentiality_level: 'confidencial' }))).toMatch(/sensible/);
    expect(await rechazo(() => nueva({ status: 'pendiente' }))).toMatch(/no se procesa/);
    expect(await rechazo(() => nueva({ status: 'fallido' }))).toMatch(/no se procesa/);
    expect(
      await rechazo(() =>
        nueva({
          origin: 'link',
          file_id: null,
          mime_type: null,
          size_bytes: null,
          hash: null,
          external_provider: 'google_drive_file',
          external_id: 'x',
          external_url: 'https://drive.google.com/x',
          canonical_url: 'https://drive.google.com/x',
        }),
      ),
    ).toMatch(/archivo, no un enlace|source_documents_estado_por_origen/);
    expect(await nueva()).toBeTruthy();
  });

  it('su visibilidad, su tipo y su original no cambian', async () => {
    const id = await nueva();
    expect(
      await rechazo(() => query(`UPDATE source_documents SET visibility = 'tcl' WHERE id = $1`, [id])),
    ).toMatch(/siempre interna/);
    expect(
      await rechazo(() => query(`UPDATE source_documents SET visibility = 'compartida' WHERE id = $1`, [id])),
    ).toMatch(/siempre interna/);
    expect(
      await rechazo(() =>
        query(`UPDATE source_documents SET confidentiality_level = 'interna' WHERE id = $1`, [id]),
      ),
    ).toMatch(/sensible/);
    expect(
      await rechazo(() => query(`UPDATE source_documents SET type = 'otro' WHERE id = $1`, [id])),
    ).toMatch(/no cambia/);
    expect(
      await rechazo(() => query(`UPDATE source_documents SET hash = $2 WHERE id = $1`, [id, 'f'.repeat(64)])),
    ).toMatch(/original de una evidencia/);
    expect(
      await rechazo(() => query(`UPDATE source_documents SET filename = 'otro.pdf' WHERE id = $1`, [id])),
    ).toMatch(/original de una evidencia/);
    // y una fuente ya existente de otro tipo no se vuelve soporte operativo
    const [normal] = await query<{ id: string }>(
      `INSERT INTO source_documents (campaign_id, organization_id, type, filename, file_id, mime_type, size_bytes, hash, status, created_by)
       VALUES ($1, $2, 'otro', 'n.md', $3, 'text/markdown', 10, $4, 'procesado', $5) RETURNING id`,
      [
        e.campanaId,
        e.admin.organizationId,
        unico('n'),
        createHash('sha256').update(unico('hn')).digest('hex'),
        e.admin.id,
      ],
    );
    expect(
      await rechazo(() =>
        query(`UPDATE source_documents SET type = 'soporte_operativo' WHERE id = $1`, [normal!.id]),
      ),
    ).toMatch(/no cambia/);
  });

  it('sin processing_jobs y sin fragmentos; las demás fuentes no se afectan', async () => {
    const id = await nueva();
    expect(await rechazo(() => query(`INSERT INTO processing_jobs (source_id) VALUES ($1)`, [id]))).toMatch(
      /no se procesa/,
    );
    expect(
      await rechazo(() =>
        query(`INSERT INTO source_fragments (source_id, ordinal, page, text) VALUES ($1, 1, 1, 'texto')`, [
          id,
        ]),
      ),
    ).toMatch(/no se procesa/);
    // regresión: una fuente normal conserva su job y sus fragmentos
    const [normal] = await query<{ id: string }>(
      `INSERT INTO source_documents (campaign_id, organization_id, type, filename, file_id, mime_type, size_bytes, hash, status, created_by)
       VALUES ($1, $2, 'ficha_tecnica', 'n.pdf', $3, 'application/pdf', 10, $4, 'pendiente', $5) RETURNING id`,
      [
        e.campanaId,
        e.admin.organizationId,
        unico('n'),
        createHash('sha256').update(unico('hn')).digest('hex'),
        e.admin.id,
      ],
    );
    await query(`INSERT INTO processing_jobs (source_id) VALUES ($1)`, [normal!.id]);
    await query(`INSERT INTO source_fragments (source_id, ordinal, page, text) VALUES ($1, 1, 1, 'texto')`, [
      normal!.id,
    ]);
  });
});

// ─────────────────────────── 9. PII ────────────────────────────────────────────

async function insertarPii(
  influencerId: string,
  o: {
    cedula?: string;
    telefono?: boolean;
    direccion?: boolean;
    extra?: Record<string, unknown>;
    por?: User;
  } = {},
): Promise<string> {
  const indice = o.cedula === undefined ? null : createHash('sha256').update(`idx:${o.cedula}`).digest();
  return insertar(pool(), 'influencer_pii_records', {
    organization_id: e.admin.organizationId,
    influencer_id: influencerId,
    document_id_enc: o.cedula === undefined ? null : bytes(40),
    phone_enc: o.telefono === true ? bytes(36) : null,
    address_enc: o.direccion === true ? bytes(60) : null,
    key_id: 'k1',
    blind_index: indice,
    created_by: (o.por ?? e.operativo).id,
    ...o.extra,
  });
}

async function borrarPii(id: string): Promise<void> {
  await query(
    `UPDATE influencer_pii_records SET erased_at = now(), erased_by = $2, document_id_enc = NULL, phone_enc = NULL,
            address_enc = NULL, blind_index = NULL WHERE id = $1`,
    [id, e.operativo.id],
  );
}

describe('influencer_pii_records', () => {
  it('envoltorio: texto plano o formato desconocido no caben; el cifrado válido sí', async () => {
    const { influencerId } = await nuevaParticipacion('pii-env');
    for (const columna of ['document_id_enc', 'phone_enc', 'address_enc']) {
      const intento = (valor: Buffer) =>
        rechazo(() =>
          insertarPii(influencerId, {
            extra: {
              document_id_enc: null,
              phone_enc: null,
              address_enc: null,
              blind_index: columna === 'document_id_enc' ? randomBytes(32) : null,
              [columna]: valor,
            },
          }),
        );
      expect(await intento(Buffer.from('1234567890')), `${columna} texto plano`).toMatch(/envoltorio_valido/);
      expect(
        await intento(Buffer.from('Calle 10 # 5-20, Bogotá, apto 301, torre 2')),
        `${columna} dirección en claro`,
      ).toMatch(/envoltorio_valido/);
      expect(await intento(bytes(28)), `${columna} corto`).toMatch(/envoltorio_valido/);
      expect(await intento(bytes(40, 2)), `${columna} versión desconocida`).toMatch(/envoltorio_valido/);
      expect(await intento(bytes(40, 0)), `${columna} versión 0`).toMatch(/envoltorio_valido/);
    }
    expect(
      await insertarPii(influencerId, { cedula: '1112223334', telefono: true, direccion: true }),
    ).toBeTruthy();
    // mínimo exacto: 29 bytes (texto cifrado vacío)
    const otro = await nuevaParticipacion('pii-min');
    await insertarPii(otro.influencerId, { extra: { phone_enc: bytes(29) } });
  });

  it('índice ciego de 32 bytes, coherente con la cédula cifrada; key_id válido; algo que guardar', async () => {
    const { influencerId } = await nuevaParticipacion('pii-indice');
    expect(
      await rechazo(() =>
        insertarPii(influencerId, { cedula: '2000000001', extra: { blind_index: randomBytes(31) } }),
      ),
    ).toMatch(/indice_valido/);
    expect(
      await rechazo(() =>
        insertarPii(influencerId, { telefono: true, extra: { blind_index: randomBytes(32) } }),
      ),
    ).toMatch(/indice_coherente/);
    expect(
      await rechazo(() => insertarPii(influencerId, { cedula: '2000000002', extra: { blind_index: null } })),
    ).toMatch(/indice_coherente/);
    expect(
      await rechazo(() =>
        insertarPii(influencerId, { cedula: '2000000003', extra: { key_id: 'con espacio' } }),
      ),
    ).toMatch(/key_id_valido/);
    expect(await rechazo(() => insertarPii(influencerId, { extra: {} }))).toMatch(/borrado_coherente/);
  });

  it('la versión la numera la base y el registro es append-only (solo el cripto-borrado muta)', async () => {
    const { influencerId } = await nuevaParticipacion('pii-version');
    const v1 = await insertarPii(influencerId, { cedula: '3000000001', extra: { version: 50 } });
    const v2 = await insertarPii(influencerId, { cedula: '3000000001', telefono: true });
    const filas = await query<{ id: string; version: number }>(
      `SELECT id, version FROM influencer_pii_records WHERE influencer_id = $1 ORDER BY version`,
      [influencerId],
    );
    expect(filas).toEqual([
      { id: v1, version: 1 },
      { id: v2, version: 2 },
    ]);

    expect(
      await rechazo(() =>
        query(`UPDATE influencer_pii_records SET phone_enc = $2 WHERE id = $1`, [v2, bytes(40)]),
      ),
    ).toMatch(/append-only por versión/);
    expect(
      await rechazo(() => query(`UPDATE influencer_pii_records SET key_id = 'k2' WHERE id = $1`, [v2])),
    ).toMatch(/append-only por versión/);
    expect(await rechazo(() => query(`DELETE FROM influencer_pii_records WHERE id = $1`, [v2]))).toMatch(
      /no admite DELETE/,
    );
    expect(
      await rechazo(() =>
        conBypass(
          async (c) =>
            void (await c.query(`UPDATE influencer_pii_records SET phone_enc = $2 WHERE id = $1`, [
              v2,
              bytes(40),
            ])),
        ),
      ),
    ).toMatch(/append-only por versión/);
  });

  it('cripto-borrado: una vez, por persona con rol, anulando los bytea y el índice', async () => {
    const { influencerId } = await nuevaParticipacion('pii-borrado');
    const id = await insertarPii(influencerId, { cedula: '4000000001', telefono: true });
    // no se borra dejando datos cifrados
    expect(
      await rechazo(() =>
        query(`UPDATE influencer_pii_records SET erased_at = now(), erased_by = $2 WHERE id = $1`, [
          id,
          e.operativo.id,
        ]),
      ),
    ).toMatch(/borrado_coherente/);
    // ni sin responsable
    expect(
      await rechazo(() =>
        query(
          `UPDATE influencer_pii_records SET erased_at = now(), document_id_enc = NULL, phone_enc = NULL, blind_index = NULL WHERE id = $1`,
          [id],
        ),
      ),
    ).toMatch(/borrado_coherente|no puede ejecutar/);
    // ni por quien no tiene la capacidad
    expect(
      await rechazo(() =>
        query(
          `UPDATE influencer_pii_records SET erased_at = now(), erased_by = $2, document_id_enc = NULL, phone_enc = NULL, blind_index = NULL WHERE id = $1`,
          [id, e.director.id],
        ),
      ),
    ).toMatch(/no puede ejecutar «pii»/);
    await borrarPii(id);
    const f = await fila<{
      erased_at: Date;
      document_id_enc: Buffer | null;
      blind_index: Buffer | null;
      key_id: string;
    }>(`SELECT erased_at, document_id_enc, blind_index, key_id FROM influencer_pii_records WHERE id = $1`, [
      id,
    ]);
    expect(f.erased_at).toBeInstanceOf(Date);
    expect(f.document_id_enc).toBeNull();
    expect(f.blind_index).toBeNull();
    expect(await rechazo(() => borrarPii(id))).toMatch(/ya borrado/);
    expect(
      await rechazo(() => query(`UPDATE influencer_pii_records SET erased_at = NULL WHERE id = $1`, [id])),
    ).toMatch(/ya borrado/);
  });

  it('cédula duplicada entre influencers: unique_violation; el mismo influencer puede versionar', async () => {
    const a = await nuevaParticipacion('pii-dup-a');
    const b = await nuevaParticipacion('pii-dup-b');
    const cedula = `5${Date.now()}`.slice(0, 12);
    await insertarPii(a.influencerId, { cedula });
    await insertarPii(a.influencerId, { cedula, telefono: true });
    let codigo = '';
    try {
      await insertarPii(b.influencerId, { cedula });
    } catch (error) {
      codigo = (error as { code?: string }).code ?? '';
    }
    expect(codigo).toBe('23505');
    // A cambia de cédula en su versión vigente: la anterior queda libre para B
    await insertarPii(a.influencerId, { cedula: `${cedula}9` });
    await insertarPii(b.influencerId, { cedula });
    // y una cédula borrada también queda libre
    const c = await nuevaParticipacion('pii-dup-c');
    const x = await insertarPii(c.influencerId, { cedula: `${cedula}7` });
    await borrarPii(x);
    const d = await nuevaParticipacion('pii-dup-d');
    await insertarPii(d.influencerId, { cedula: `${cedula}7` });
  });

  it('cédula duplicada y concurrente: solo una de las dos transacciones simultáneas prospera', async () => {
    const a = await nuevaParticipacion('pii-conc-a');
    const b = await nuevaParticipacion('pii-conc-b');
    const cedula = `6${Date.now()}`.slice(0, 12);
    const resultados = await Promise.all(
      [a.influencerId, b.influencerId].map((influencerId) =>
        transaction(async (c) => {
          await c.query(
            `INSERT INTO influencer_pii_records (organization_id, influencer_id, document_id_enc, key_id, blind_index, created_by)
             VALUES ($1, $2, $3, 'k1', $4, $5)`,
            [
              e.admin.organizationId,
              influencerId,
              bytes(40),
              createHash('sha256').update(`idx:${cedula}`).digest(),
              e.operativo.id,
            ],
          );
          await new Promise((r) => setTimeout(r, 150));
        }).then(
          () => 'ok',
          (error: { code?: string }) => error.code ?? 'error',
        ),
      ),
    );
    expect(resultados.sort()).toEqual(['23505', 'ok']);
  });

  it('roles (pii: admin, operativo) y aislamiento por organización', async () => {
    const { influencerId } = await nuevaParticipacion('pii-roles');
    for (const quien of [e.director, e.consultor, e.analista, e.legal]) {
      expect(
        await rechazo(() =>
          insertarPii(influencerId, { cedula: `70${randomBytes(4).readUInt32BE().toString()}`, por: quien }),
        ),
        quien.role,
      ).toMatch(/no puede ejecutar «pii»/);
    }
    for (const quien of [e.admin, e.operativo]) {
      await insertarPii(influencerId, { telefono: true, por: quien });
    }
    expect(await rechazo(() => insertarPii(influencerId, { telefono: true, por: e.ajeno }))).toMatch(
      /influencer_pii_records_autor_fkey/,
    );
    expect(
      await rechazo(() =>
        insertarPii(influencerId, {
          telefono: true,
          extra: { organization_id: e.ajeno.organizationId, created_by: e.ajeno.id },
        }),
      ),
    ).toMatch(/influencer_pii_records_influencer_fkey/);
  });
});

// ─────────────────────────── 10. Sin DELETE ni TRUNCATE ────────────────────────

describe('historia: sin DELETE ni TRUNCATE en ninguna tabla F8', () => {
  it('DELETE rechazado salvo el bypass de bases _test (que además exige el nombre de base)', async () => {
    for (const tabla of TABLAS_F8) {
      const msg = await rechazo(() => query(`DELETE FROM ${tabla} WHERE id = gen_random_uuid()`));
      // sin filas que borrar el trigger de fila no dispara: se prueba con una fila real si existe
      const hay = await fila<{ id: string } | undefined>(`SELECT id FROM ${tabla} LIMIT 1`);
      if (hay !== undefined) {
        expect(await rechazo(() => query(`DELETE FROM ${tabla} WHERE id = $1`, [hay.id])), tabla).toMatch(
          /no admite DELETE|append-only|histórico|historia/,
        );
      } else {
        expect(msg).toBe('');
      }
    }
  });

  it('TRUNCATE rechazado en todas (en una transacción que siempre se revierte)', async () => {
    for (const tabla of TABLAS_F8) {
      // Capa de triggers: se prueba con el rol privilegiado (el rol de ejecución no tiene TRUNCATE; ver qa-rr-privilegios).
      const c = await adminPool().connect();
      try {
        await c.query('BEGIN');
        const msg = await rechazo(() => c.query(`TRUNCATE ${tabla} CASCADE`));
        expect(msg, tabla).toMatch(/no admite TRUNCATE/);
      } finally {
        await c.query('ROLLBACK');
        c.release();
      }
    }
  });
});

// ─────────────────────────── 11. Paridad del grafo con el dominio ──────────────

describe('paridad dominio ↔ base del grafo de estados', () => {
  it('operaciones_arista_valida coincide con isValidOperationalEdge para toda combinación', async () => {
    let comprobadas = 0;
    for (const tipo of OPERATIONAL_EVENT_TYPES) {
      const sujeto = subjectTypeOfEventType(tipo);
      const sujetos = sujeto === undefined ? OPERATIONAL_SUBJECT_TYPES : [sujeto];
      const estados = [...new Set(sujetos.flatMap((s) => statusesOf(s)))];
      for (const desde of [null, ...estados]) {
        for (const hacia of estados) {
          const r = await fila<{ v: boolean }>(`SELECT operaciones_arista_valida($1, $2, $3) AS v`, [
            tipo,
            desde,
            hacia,
          ]);
          expect(r.v, `${tipo}: ${desde} → ${hacia}`).toBe(
            isValidOperationalEdge(tipo as OperationalEventType, desde, hacia),
          );
          comprobadas += 1;
        }
      }
    }
    expect(comprobadas).toBeGreaterThan(500);
    // y la lista de aristas del dominio no trae ninguna que la base rechace
    for (const arista of OPERATIONAL_EVENT_EDGES) {
      expect(
        (
          await fila<{ v: boolean }>(`SELECT operaciones_arista_valida($1, $2, $3) AS v`, [
            arista.eventType,
            arista.from,
            arista.to,
          ])
        ).v,
      ).toBe(true);
    }
    // evidence.attached y correction_noted no producen estados
    expect(
      (
        await fila<{ v: boolean }>(
          `SELECT operaciones_arista_valida('evidence.attached', NULL, 'pending') AS v`,
        )
      ).v,
    ).toBe(false);
  });

  it('la lista cerrada de tipos de la base coincide con la del dominio', async () => {
    const def = await fila<{ def: string }>(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'operational_events_tipo_valido'`,
    );
    const enBase = [...def.def.matchAll(/'([a-z_]+\.[a-z_]+)'/g)].map((m) => m[1]!).sort();
    expect(enBase).toEqual([...OPERATIONAL_EVENT_TYPES].sort());
  });
});
