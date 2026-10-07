/**
 * Mundo de pruebas de OPERACIÓN y KPIs (V2 · Fase 8): sembrado de datos CENTINELA (dinero, PII, guía, notas,
 * referencias externas, nombres de archivo de evidencia) con los casos de uso reales de W1, contra PostgreSQL real
 * (base `_test`). Solo para pruebas; datos sintéticos. Los archivos de `testing/` quedan fuera del test estático de D15.
 */
import { randomUUID } from 'node:crypto';
import {
  asociarInfluencerACampana,
  crearEnvio,
  guardarPii,
  obtenerSeguimientoDePago,
  query,
  registerLinkedSource,
  registrarDocumentoDeCobro,
  reportarPago,
  transicionarEnvio,
} from '@tcl-kol-os/db';
import {
  type EscenarioDeOperacion,
  crearAcuerdoDePrueba,
  crearEscenarioDeOperacion,
  limpiarEscenarioDeOperacion,
} from '@tcl-kol-os/db/test-utils';
import type { Result, User } from '@tcl-kol-os/domain';

// Claves de cifrado de PII SOLO DE PRUEBA (las mismas que usa la suite de db) y solo con una base `_test`: sin ellas
// `guardarPii` falla con PII_NOT_CONFIGURED. Si el entorno ya las define, se respetan.
if (/_test(\?.*)?$/.test(process.env['DATABASE_URL'] ?? '')) {
  if (!process.env['PII_ENCRYPTION_KEYS']?.trim()) {
    process.env['PII_ENCRYPTION_KEYS'] = `prueba-1:${Buffer.alloc(32, 0x11).toString('base64')}`;
  }
  if (!process.env['PII_INDEX_KEY']?.trim())
    process.env['PII_INDEX_KEY'] = Buffer.alloc(32, 0x22).toString('base64');
}

export const FEE = 9876543;
export const COSTO_DE_ENVIO = 7654321;
export const COBRO = 5432198;
export const CEDULA = '1098765432';
export const TELEFONO = '3001112233';
export const DIRECCION = 'Calle 99 # 88-77 Apto SENT';
export const GUIA = 'GUIA-SENT-777';
export const TRANSPORTADORA = 'TRANSPORTADORA-SENT';
export const NOTA = 'NOTA-SENT-INTERNA';
export const CONDICIONES = 'CONDICIONES-SENT-del-acuerdo';
export const EVIDENCIA = 'EVIDENCIA-SENT-FILE';
export const REFERENCIA_EXTERNA = 'REFEXT-SENT-4455';
export const NUMERO_DE_DOCUMENTO = 'DOC-SENT-001';
/** Todo lo que JAMÁS puede salir hacia un modelo ni quedar en lo que se guarda de una tool. */
export const CENTINELAS: readonly string[] = [
  String(FEE),
  String(COSTO_DE_ENVIO),
  String(COBRO),
  CEDULA,
  TELEFONO,
  DIRECCION,
  GUIA,
  TRANSPORTADORA,
  NOTA,
  CONDICIONES,
  EVIDENCIA,
  REFERENCIA_EXTERNA,
  NUMERO_DE_DOCUMENTO,
];

export const exito = <T>(r: Result<T>): T => {
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message} ${JSON.stringify(r.error.details)}`);
  return r.value;
};

export const dia = (atras: number): string =>
  new Date(Date.now() - atras * 86_400_000).toISOString().slice(0, 10);

let secuencia = 0;
export const unico = (p: string): string => `${p}-${++secuencia}-${Date.now().toString(36)}`;

export function archivoDePrueba(marca: string): { filename: string; contenido: Uint8Array } {
  return {
    filename: `${marca}.pdf`,
    contenido: new TextEncoder().encode(`%PDF-1.4\n% ${marca}\n1 0 obj\n<<>>\nendobj\ntrailer\n%%EOF\n`),
  };
}

export interface MundoDeOperacion {
  readonly op: EscenarioDeOperacion;
  /** Participaciones: Ríos (acuerdo mixto, PII, envíos, cobro y pago), Gómez (canje) y Diego (sin acuerdo). */
  readonly rios: string;
  readonly gomez: string;
  readonly diego: string;
}

/** Siembra TODO lo F8 con centinelas: acuerdos, PII, envíos (uno entregado), cobro, pago y evidencia. */
export async function crearMundoDeOperacion(nombre: string): Promise<MundoDeOperacion> {
  const op = await crearEscenarioDeOperacion(nombre, { conAcuerdoAjeno: true });
  const rios = op.participaciones.valentinaRios;
  const gomez = op.participaciones.valentinaGomez;
  const diego = op.participaciones.diego;

  await crearAcuerdoDePrueba(op.admin, {
    campaignInfluencerId: rios,
    mode: 'mixed',
    campaignProductId: op.productos.p80,
    amount: FEE,
    currency: 'COP',
    quantity: 4,
    conditions: CONDICIONES,
  });
  await crearAcuerdoDePrueba(op.admin, {
    campaignInfluencerId: gomez,
    mode: 'barter',
    campaignProductId: op.productos.pro,
    quantity: 2,
  });

  const [persona] = await query<{ influencer_id: string }>(
    `SELECT influencer_id FROM campaign_influencers WHERE id = $1`,
    [rios],
  );
  const pii = exito(
    await guardarPii(op.operativo, {
      influencerId: persona!.influencer_id,
      documentId: CEDULA,
      phone: TELEFONO,
      address: DIRECCION,
    }),
  );

  const mover = async (
    ci: string,
    producto: string,
    cantidad: number,
    hasta: 'pending' | 'delivered',
    extra: Partial<Parameters<typeof crearEnvio>[1]> = {},
  ): Promise<void> => {
    let s = exito(
      await crearEnvio(op.operativo, {
        campaignInfluencerId: ci,
        items: [{ campaignProductId: producto, quantity: cantidad }],
        idempotencyKey: unico('envio'),
        ...extra,
      }),
    ).envio;
    if (hasta === 'pending') return;
    const paso = async (
      to: Parameters<typeof transicionarEnvio>[1]['to'],
      x: Partial<Parameters<typeof transicionarEnvio>[1]> = {},
    ): Promise<void> => {
      s = exito(
        await transicionarEnvio(op.operativo, {
          shipmentId: s.id,
          to,
          expectedSeq: s.rowSeq,
          idempotencyKey: unico(to),
          ...x,
        }),
      ).envio;
    };
    await paso('prepared');
    await paso('shipped', { happenedOn: dia(3), carrier: TRANSPORTADORA, trackingRef: GUIA, note: NOTA });
    await paso('delivered', { happenedOn: dia(1) });
  };
  await mover(rios, op.productos.p80, 2, 'delivered', {
    shippingCost: COSTO_DE_ENVIO,
    shippingCurrency: 'COP',
    piiRecordId: pii.record.recordId,
    note: NOTA,
  });
  await mover(rios, op.productos.p80, 1, 'pending');
  await mover(gomez, op.productos.pro, 2, 'pending');

  const seguimiento = exito(await obtenerSeguimientoDePago(op.operativo, rios))!;
  exito(
    await registrarDocumentoDeCobro(op.operativo, {
      paymentObligationId: seguimiento.obligation.id,
      documentNumber: NUMERO_DE_DOCUMENTO,
      issuedOn: dia(2),
      claimedAmount: COBRO,
      claimedCurrency: 'COP',
      archivo: archivoDePrueba(EVIDENCIA),
      idempotencyKey: unico('doc'),
      note: NOTA,
    }),
  );
  const despues = exito(await obtenerSeguimientoDePago(op.operativo, rios))!;
  exito(
    await reportarPago(op.operativo, {
      paymentObligationId: despues.obligation.id,
      expectedSeq: despues.obligation.rowSeq,
      idempotencyKey: unico('pago'),
      paidOn: dia(0),
      externalReference: REFERENCIA_EXTERNA,
      note: NOTA,
    }),
  );
  return { op, rios, gomez, diego };
}

export async function limpiarMundoDeOperacion(m: MundoDeOperacion): Promise<void> {
  await limpiarEscenarioDeOperacion(m.op);
}

/** Una participación nueva (identidad nueva) en la campaña indicada, de la agencia del admin. */
export async function participacionEnCampana(
  op: EscenarioDeOperacion,
  campaignId: string,
  influencerId: string,
): Promise<string> {
  return exito(await asociarInfluencerACampana(op.admin, { campaignId, influencerId })).id;
}

// ─────────────────────────── Sheet con `kpi_objetivo` ──────────────────────────

type Celda = string | null;

const CABECERAS = [
  'clave_influencer',
  'nombre',
  'plataforma',
  'handle',
  'producto',
  'fee',
  'canje',
  'kpi_objetivo',
] as const;

export const SENTINELA_FEE_DEL_SHEET = 'SENTINELA-FEE-SHEET-4815162342';
export const SENTINELA_CANJE_DEL_SHEET = 'SENTINELA-CANJE-SHEET-lavadora-9911';

async function insertarLectura(
  sourceId: string,
  organizationId: string,
  sequence: number,
  kpi: string | null,
): Promise<string> {
  const [s] = await query<{ id: string }>(
    `INSERT INTO source_snapshots (source_id, organization_id, sequence, provider, fetched_at, content_hash,
                                   hash_version, structure, generator)
     VALUES ($1, $2, $3, 'google_sheets', now(), $4, 'grid-sha256/1', $5::jsonb, 'prueba-agente-f8')
     RETURNING id`,
    [
      sourceId,
      organizationId,
      sequence,
      String(sequence).padStart(64, 'e'),
      JSON.stringify({ sheets: [{ name: 'Influencers', state: 'visible' }] }),
    ],
  );
  const filas: (readonly Celda[])[] = [
    ['TCL_KOL_OS_INFLUENCERS_V1'],
    [...CABECERAS],
    [
      'INF-001',
      'Valentina Rios',
      'instagram',
      'valentina.rios.kpi',
      'P80',
      SENTINELA_FEE_DEL_SHEET,
      SENTINELA_CANJE_DEL_SHEET,
      kpi,
    ],
  ];
  for (const [i, fila] of filas.entries()) {
    const celdas = fila.flatMap((texto, c) =>
      texto === null || texto === '' ? [] : [{ col: c + 1, text: texto, type: 'texto' }],
    );
    await query(
      `INSERT INTO source_snapshot_rows (snapshot_id, sheet, sheet_gid, row_number, cells)
       VALUES ($1, 'Influencers', 11, $2, $3::jsonb)`,
      [s!.id, i + 1, JSON.stringify(celdas)],
    );
  }
  await query(
    `INSERT INTO source_fragments (source_id, snapshot_id, ordinal, section, text, locator)
     VALUES ($1, $2, 0, 'Influencers', 'texto de prueba',
             '{"kind":"range","sheet":"Influencers","range":"A1:A1","rowStart":1,"rowEnd":1,"colStart":1,"colEnd":1}'::jsonb)`,
    [sourceId, s!.id],
  );
  return s!.id;
}

/**
 * Un Google Sheet enlazado a la campaña, con el binding de la participación a la fila `INF-001` y una lectura
 * VIGENTE con `kpi_objetivo = kpi`. `fee` y `canje` llevan centinelas que jamás deben salir.
 */
export async function crearSheetConKpi(
  actor: User,
  campaignId: string,
  participacion: string,
  kpi: string | null,
): Promise<{ sourceId: string; snapshotId: string }> {
  const libro = `1Opr${randomUUID().replace(/-/g, '')}${'z'.repeat(30)}`.slice(0, 44);
  const fuente = exito(
    await registerLinkedSource(actor, {
      campaignId,
      url: `https://docs.google.com/spreadsheets/d/${libro}/edit#gid=11`,
    }),
  );
  const snapshotId = await insertarLectura(fuente.id, actor.organizationId, 1, kpi);
  const [persona] = await query<{ influencer_id: string }>(
    `SELECT influencer_id FROM campaign_influencers WHERE id = $1`,
    [participacion],
  );
  await query(`UPDATE source_documents SET current_snapshot_id = $2 WHERE id = $1`, [fuente.id, snapshotId]);
  const [plan] = await query<{ id: string }>(
    `INSERT INTO influencer_import_plans (organization_id, campaign_id, source_id, snapshot_id, schema_id,
                                          schema_version, status, validation, summary, created_by)
     VALUES ($1, $2, $3, $4, 'TCL_KOL_OS_INFLUENCERS', 1, 'applied', '{}'::jsonb, '{}'::jsonb, $5) RETURNING id`,
    [actor.organizationId, campaignId, fuente.id, snapshotId, actor.id],
  );
  const [registro] = await query<{ id: string }>(
    `INSERT INTO influencer_import_records (plan_id, organization_id, campaign_id, source_id, snapshot_id,
                                            source_key, kind, display_name, change, identity_outcome)
     VALUES ($1, $2, $3, $4, $5, 'INF-001', 'person', 'Valentina Rios', 'new', 'create_new') RETURNING id`,
    [plan!.id, actor.organizationId, campaignId, fuente.id, snapshotId],
  );
  await query(
    `INSERT INTO influencer_source_bindings (organization_id, campaign_id, source_id, source_key, influencer_id,
                                             campaign_influencer_id, bound_via, origin_snapshot_id,
                                             origin_record_id, origin_locators, bound_by)
     VALUES ($1, $2, $3, 'INF-001', $4, $5, 'created', $6, $7, '[]'::jsonb, $8)`,
    [
      actor.organizationId,
      campaignId,
      fuente.id,
      persona!.influencer_id,
      participacion,
      snapshotId,
      registro!.id,
      actor.id,
    ],
  );
  return { sourceId: fuente.id, snapshotId };
}
