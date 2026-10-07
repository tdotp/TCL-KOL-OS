/**
 * Apoyo de las pruebas de KPI (V2 · Fase 8, W2a). Solo para pruebas (datos sintéticos).
 *
 * Arma, por SQL directo y SIN el worker, un Google Sheet enlazado con dos lecturas (snapshots) y el binding de
 * una participación a su fila: la lectura de ORIGEN dice una cosa y la VIGENTE otra, para probar que
 * `obtenerKpiPactadoDelSheet` lee la vigente.
 */

import { randomUUID } from 'node:crypto';
import type { Result, User } from '@tcl-kol-os/domain';
import { asociarInfluencerACampana } from './campaign-influencers.ts';
import { query } from './client.ts';
import { crearInfluencer } from './influencers.ts';
import { registerLinkedSource } from './sources.ts';
import type { EscenarioDeOperacion } from './test-utils.ts';

export function exito<T>(r: Result<T>): T {
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message} ${JSON.stringify(r.error.details)}`);
  return r.value;
}

export const codigo = <T>(r: Result<T>): string => (r.ok ? 'OK' : r.error.code);
export const razon = <T>(r: Result<T>): unknown =>
  r.ok ? undefined : (r.error.details as { reason?: unknown } | undefined)?.reason;

export const SENTINELA_FEE = 'SENTINELA-FEE-4815162342';
export const SENTINELA_CANJE = 'SENTINELA-CANJE-lavadora-9911';

export interface SheetDePrueba {
  readonly sourceId: string;
  readonly origenSnapshotId: string;
  readonly vigenteSnapshotId: string;
  readonly sourceKey: string;
  readonly bindingId: string;
}

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

/** Filas con datos; la columna `kpi_objetivo` es la octava (H). */
async function insertarSnapshot(
  sourceId: string,
  organizationId: string,
  sequence: number,
  gid: number,
  cabeceras: readonly string[],
  filas: readonly (readonly Celda[])[],
): Promise<string> {
  const [s] = await query<{ id: string }>(
    `INSERT INTO source_snapshots (source_id, organization_id, sequence, provider, fetched_at, content_hash,
                                   hash_version, structure, generator)
     VALUES ($1, $2, $3, 'google_sheets', now(), $4, 'grid-sha256/1', $5::jsonb, 'prueba-kpi')
     RETURNING id`,
    [
      sourceId,
      organizationId,
      sequence,
      String(sequence).padStart(64, 'f'),
      JSON.stringify({ sheets: [{ name: 'Influencers', state: 'visible' }] }),
    ],
  );
  const todas: (readonly Celda[])[] = [['TCL_KOL_OS_INFLUENCERS_V1'], [...cabeceras], ...filas];
  for (const [i, fila] of todas.entries()) {
    const celdas = fila.flatMap((texto, c) =>
      texto === null || texto === '' ? [] : [{ col: c + 1, text: texto, type: 'texto' }],
    );
    await query(
      `INSERT INTO source_snapshot_rows (snapshot_id, sheet, sheet_gid, row_number, cells)
       VALUES ($1, 'Influencers', $2, $3, $4::jsonb)`,
      [s!.id, gid, i + 1, JSON.stringify(celdas)],
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
 * Sheet enlazado a la campaña con el binding de la participación a `INF-001`. Lectura 1 (origen) y lectura 2
 * (vigente) traen textos DISTINTOS en `kpi_objetivo`; `fee` y `canje` llevan sentinelas que jamás deben salir.
 */
export async function crearSheetDePrueba(
  actor: User,
  o: {
    readonly campaignId: string;
    readonly campaignInfluencerId: string;
    readonly kpiOrigen: string | null;
    readonly kpiVigente: string | null;
    /** Si es `false`, las lecturas no traen la columna `kpi_objetivo`. */
    readonly conColumna?: boolean;
  },
): Promise<SheetDePrueba> {
  const libro = `1Kpi${randomUUID().replace(/-/g, '')}${'z'.repeat(30)}`.slice(0, 44);
  const fuente = await registerLinkedSource(actor, {
    campaignId: o.campaignId,
    url: `https://docs.google.com/spreadsheets/d/${libro}/edit#gid=11`,
  });
  if (!fuente.ok) throw new Error(`registerLinkedSource: ${fuente.error.message}`);
  const sourceId = fuente.value.id;
  const fila = (kpi: string | null): readonly Celda[] =>
    o.conColumna === false
      ? [
          'INF-001',
          'Valentina Rios',
          'instagram',
          'valentina.rios.kpi',
          'P80',
          SENTINELA_FEE,
          SENTINELA_CANJE,
        ]
      : [
          'INF-001',
          'Valentina Rios',
          'instagram',
          'valentina.rios.kpi',
          'P80',
          SENTINELA_FEE,
          SENTINELA_CANJE,
          kpi,
        ];
  const cabeceras = o.conColumna === false ? CABECERAS.filter((c) => c !== 'kpi_objetivo') : [...CABECERAS];
  const origen = await insertarSnapshot(sourceId, actor.organizationId, 1, 11, cabeceras, [
    fila(o.kpiOrigen),
  ]);
  const vigente = await insertarSnapshot(sourceId, actor.organizationId, 2, 11, cabeceras, [
    fila(o.kpiVigente),
  ]);
  const [persona] = await query<{ influencer_id: string }>(
    `SELECT influencer_id FROM campaign_influencers WHERE id = $1`,
    [o.campaignInfluencerId],
  );
  await query(`UPDATE source_documents SET current_snapshot_id = $2 WHERE id = $1`, [sourceId, origen]);
  await query(`UPDATE source_documents SET current_snapshot_id = $2 WHERE id = $1`, [sourceId, vigente]);

  const [plan] = await query<{ id: string }>(
    `INSERT INTO influencer_import_plans (organization_id, campaign_id, source_id, snapshot_id, schema_id,
                                          schema_version, status, validation, summary, created_by)
     VALUES ($1, $2, $3, $4, 'TCL_KOL_OS_INFLUENCERS', 1, 'applied', '{}'::jsonb, '{}'::jsonb, $5) RETURNING id`,
    [actor.organizationId, o.campaignId, sourceId, origen, actor.id],
  );
  const [registro] = await query<{ id: string }>(
    `INSERT INTO influencer_import_records (plan_id, organization_id, campaign_id, source_id, snapshot_id,
                                            source_key, kind, display_name, change, identity_outcome)
     VALUES ($1, $2, $3, $4, $5, 'INF-001', 'person', 'Valentina Rios', 'new', 'create_new') RETURNING id`,
    [plan!.id, actor.organizationId, o.campaignId, sourceId, origen],
  );
  const [binding] = await query<{ id: string }>(
    `INSERT INTO influencer_source_bindings (organization_id, campaign_id, source_id, source_key, influencer_id,
                                             campaign_influencer_id, bound_via, origin_snapshot_id,
                                             origin_record_id, origin_locators, bound_by)
     VALUES ($1, $2, $3, 'INF-001', $4, $5, 'created', $6, $7, '[]'::jsonb, $8) RETURNING id`,
    [
      actor.organizationId,
      o.campaignId,
      sourceId,
      persona!.influencer_id,
      o.campaignInfluencerId,
      origen,
      registro!.id,
      actor.id,
    ],
  );
  return {
    sourceId,
    origenSnapshotId: origen,
    vigenteSnapshotId: vigente,
    sourceKey: 'INF-001',
    bindingId: binding!.id,
  };
}

let secuencia = 0;

/** Una participación nueva (persona nueva) en la campaña indicada (por omisión la del escenario). */
export async function nuevaParticipacionDePrueba(
  op: EscenarioDeOperacion,
  campaignId: string = op.campanaId,
): Promise<string> {
  const creado = exito(
    await crearInfluencer(op.admin, {
      displayName: `Kpi Prueba ${++secuencia}`,
      cuentas: [{ platform: 'instagram', handle: `kpi.prueba.${secuencia}.${op.sufijo}` }],
    }),
  );
  op.influencerIds.push(creado.influencer.id);
  return exito(await asociarInfluencerACampana(op.admin, { campaignId, influencerId: creado.influencer.id }))
    .id;
}

/** Una campaña nueva de la agencia con una participación activa; luego pasa al estado pedido. */
export async function campanaConParticipacionDePrueba(
  op: EscenarioDeOperacion,
  estado: 'activa' | 'archivada' | 'cancelada',
): Promise<{ readonly campaignId: string; readonly participacion: string }> {
  const [c] = await query<{ id: string }>(
    `INSERT INTO campaigns (organization_id, name, owner_id, created_by) VALUES ($1, $2, $3, $3) RETURNING id`,
    [op.admin.organizationId, `F8 kpi ${estado} ${op.sufijo} ${++secuencia}`, op.admin.id],
  );
  op.campanas.push(c!.id);
  const participacion = await nuevaParticipacionDePrueba(op, c!.id);
  if (estado !== 'activa') await query(`UPDATE campaigns SET status = $2 WHERE id = $1`, [c!.id, estado]);
  return { campaignId: c!.id, participacion };
}

/** Una lectura NUEVA del Sheet (la sincronización siguiente): pasa a ser la vigente. */
export async function agregarLecturaDePrueba(
  actor: User,
  sheet: SheetDePrueba,
  o: { readonly sequence: number; readonly kpi: string | null },
): Promise<string> {
  const id = await insertarSnapshot(
    sheet.sourceId,
    actor.organizationId,
    o.sequence,
    11,
    [...CABECERAS],
    [
      [
        'INF-001',
        'Valentina Rios',
        'instagram',
        'valentina.rios.kpi',
        'P80',
        SENTINELA_FEE,
        SENTINELA_CANJE,
        o.kpi,
      ],
    ],
  );
  await query(`UPDATE source_documents SET current_snapshot_id = $2 WHERE id = $1`, [sheet.sourceId, id]);
  return id;
}

/** `SELECT count(*)::int AS n …` → n. */
export async function contar(sql: string, params: readonly unknown[] = []): Promise<number> {
  const [fila] = await query<{ n: number }>(sql, params);
  return fila!.n;
}
