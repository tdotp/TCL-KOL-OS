/**
 * CIERRE F8 · snapshots HISTÓRICOS del Sheet de influencers con `fee`, `canje` y `condiciones` en el TEXTO de sus fragmentos.
 *
 * La corrección del P0 (worker: lista blanca de columnas) solo protege los snapshots NUEVOS: los snapshots creados antes
 * conservan el texto antiguo en `source_fragments.text` (son inmutables; no se reescribe historia). Aquí se demuestra
 * que ese texto NO sale por ningún camino de lectura accesible a un rol sin permiso financiero, a TCL, al agente ni al
 * insumo del LLM que rellena el Brief, ni siquiera cuando el snapshot antiguo sigue siendo el VIGENTE de la fuente.
 *
 * Los textos sembrados son los que producía el worker ANTES de la corrección: una línea «cabecera: valor» por cada
 * columna de la hoja (fee, canje, condiciones y una columna desconocida: teléfono), sin la marca `fragmentTextAllowlist`
 * en la estructura del snapshot.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { closePool, query } from './client.ts';
import { extraerCampos } from './extraction.ts';
import { crearSheetDePrueba } from './kpi-test-support.ts';
import { buscarEvidencia, buscarEvidenciaComoActor, buscarTextoEnFuentes } from './search.ts';
import { getSnapshotFragments } from './source-sync.ts';
import { getFragments, obtenerRepresentacionNormalizada, setSourceVisibility } from './sources.ts';
import {
  type EscenarioDeOperacion,
  crearEscenarioDeOperacion,
  limpiarEscenarioDeOperacion,
} from './test-utils.ts';

const FEE = 'FEE-HIST-7712345';
const CANJE = 'CANJE-HIST-lavadora-4455';
const CONDICIONES = 'COND-HIST-exclusividad-6677';
const TELEFONO = 'TEL-HIST-3001239876';
const DIMENSIONES = 1536;
const VECTOR = Array.from({ length: DIMENSIONES }, () => 0.01);

const TEXTO_ANTIGUO = [
  'Hoja «Influencers» · filas 1–3',
  'Fila 1',
  'A: TCL_KOL_OS_INFLUENCERS_V1',
  'Fila 3',
  'clave_influencer: INF-001',
  'nombre: Valentina Rios',
  'plataforma: instagram',
  'handle: val.rios',
  'producto: P80',
  `fee: ${FEE}`,
  `canje: ${CANJE}`,
  `condiciones: ${CONDICIONES}`,
  `telefono: ${TELEFONO}`,
  'kpi_objetivo: Alcanzar 50.000 vistas',
].join('\n');

const LOCALIZADOR =
  '{"kind":"range","sheet":"Influencers","range":"A1:J3","rowStart":1,"rowEnd":3,"colStart":1,"colEnd":10}';

let op: EscenarioDeOperacion;
let sourceId = '';
let snapshotVigente = '';
let snapshotAnterior = '';

const NO_DEBE_SALIR = [FEE, CANJE, CONDICIONES, TELEFONO];
function sinFinanzas(valor: unknown): void {
  const texto = JSON.stringify(valor);
  for (const s of NO_DEBE_SALIR) expect(texto).not.toContain(s);
}

async function fragmentoAntiguo(snapshotId: string, ordinal: number): Promise<void> {
  await query(
    `INSERT INTO source_fragments (source_id, snapshot_id, ordinal, section, text, locator, embedding)
     VALUES ($1, $2, $3, 'Influencers', $4, $5::jsonb, $6::vector)`,
    [sourceId, snapshotId, ordinal, TEXTO_ANTIGUO, LOCALIZADOR, `[${VECTOR.join(',')}]`],
  );
}

beforeAll(async () => {
  op = await crearEscenarioDeOperacion('F8 snapshots historicos', { conAcuerdoAjeno: false });
  const sheet = await crearSheetDePrueba(op.admin, {
    campaignId: op.campanaId,
    campaignInfluencerId: op.participaciones.valentinaRios,
    kpiOrigen: 'a',
    kpiVigente: 'b',
  });
  sourceId = sheet.sourceId;
  snapshotVigente = sheet.vigenteSnapshotId;
  snapshotAnterior = sheet.origenSnapshotId;
  // Los dos snapshots son «anteriores al fix»: texto con las columnas financieras y sin marca de lista blanca.
  await fragmentoAntiguo(snapshotVigente, 1);
  await fragmentoAntiguo(snapshotAnterior, 1);
  await query(`UPDATE source_documents SET status = 'procesado' WHERE id = $1`, [sourceId]);
});

afterAll(async () => {
  vi.unstubAllGlobals();
  await limpiarEscenarioDeOperacion(op);
  await closePool();
});

describe('CONTROL: el escenario sí contiene el texto antiguo en la base', () => {
  it('hay fragmentos con fee, canje, condiciones y teléfono en el snapshot vigente y en el anterior', async () => {
    const [r] = await query<{ n: string }>(
      `SELECT count(*) AS n FROM source_fragments WHERE source_id = $1 AND text LIKE $2 AND text LIKE $3`,
      [sourceId, `%${FEE}%`, `%${TELEFONO}%`],
    );
    expect(Number(r!.n)).toBe(2);
  });
});

describe('snapshot antiguo VIGENTE · lectura de fragmentos y representación (consultor, sin finance:read)', () => {
  it('getFragments no devuelve el texto financiero', async () => {
    const r = await getFragments(op.consultor, sourceId);
    sinFinanzas(r);
  });

  it('obtenerRepresentacionNormalizada no devuelve el texto financiero', async () => {
    const r = await obtenerRepresentacionNormalizada(op.consultor, sourceId, {});
    sinFinanzas(r);
  });

  it('getSnapshotFragments (vigente y anterior) no devuelve el texto financiero', async () => {
    sinFinanzas(await getSnapshotFragments(op.consultor, snapshotVigente));
    sinFinanzas(await getSnapshotFragments(op.consultor, snapshotAnterior));
  });
});

describe('snapshot antiguo VIGENTE · búsquedas (consultor y TCL)', () => {
  it('búsqueda textual del consultor: ni «fee» ni el valor ni el teléfono', async () => {
    for (const texto of ['fee', FEE, 'canje', 'condiciones', TELEFONO, 'telefono']) {
      const r = await buscarTextoEnFuentes(op.consultor, { campaignId: op.campanaId, texto });
      expect(r.ok).toBe(true);
      sinFinanzas(r);
    }
  });

  it('búsqueda semántica del consultor no devuelve el texto financiero', async () => {
    const r = await buscarEvidenciaComoActor(op.consultor, {
      campaignId: op.campanaId,
      vector: VECTOR,
      distanciaMaxima: 2,
    });
    expect(r.ok).toBe(true);
    sinFinanzas(r);
  });

  it('TCL (fuente y campaña compartidas): ni búsqueda textual, ni semántica, ni lectura de fragmentos', async () => {
    await query(`UPDATE campaigns SET visibility = 'tcl' WHERE id = $1`, [op.campanaId]);
    expect((await setSourceVisibility(op.admin, sourceId, 'tcl')).ok).toBe(true);
    for (const texto of ['fee', FEE, 'canje', TELEFONO]) {
      sinFinanzas(await buscarTextoEnFuentes(op.cliente, { campaignId: op.campanaId, texto }));
    }
    sinFinanzas(
      await buscarEvidenciaComoActor(op.cliente, {
        campaignId: op.campanaId,
        vector: VECTOR,
        distanciaMaxima: 2,
      }),
    );
    sinFinanzas(await getFragments(op.cliente, sourceId));
    sinFinanzas(await obtenerRepresentacionNormalizada(op.cliente, sourceId, {}));
    await query(`UPDATE source_documents SET visibility = 'interna' WHERE id = $1`, [sourceId]);
  });

  it('buscarEvidencia (proceso interno de SmartPR) tampoco devuelve el texto financiero', async () => {
    const hits = await buscarEvidencia({
      organizationId: op.admin.organizationId,
      campaignId: op.campanaId,
      vector: VECTOR,
      distanciaMaxima: 2,
    });
    sinFinanzas(hits);
  });
});

describe('snapshot antiguo VIGENTE · el insumo del LLM que rellena el Brief (el Brief lo lee TCL)', () => {
  it('extraerCampos no envía el texto financiero al worker', async () => {
    let enviado = '';
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: unknown, init?: { body?: string }) => {
        enviado = String(init?.body ?? '');
        throw new Error('worker simulado: corte tras capturar el cuerpo');
      }),
    );
    await extraerCampos(op.admin.organizationId, op.campanaId).catch(() => undefined);
    vi.unstubAllGlobals();
    for (const s of NO_DEBE_SALIR) expect(enviado).not.toContain(s);
  });
});

describe('snapshot NUEVO (con lista blanca) vigente y el antiguo ya no vigente', () => {
  const TEXTO_NUEVO = [
    'Hoja «Influencers» · filas 1–3',
    'Fila 1',
    'A: TCL_KOL_OS_INFLUENCERS_V1',
    'Fila 3',
    'clave_influencer: INF-001',
    'nombre: Valentina Rios',
    'plataforma: instagram',
    'handle: val.rios',
    'producto: P80',
    'kpi_objetivo: SENTINELA-NUEVO-LEGIBLE',
  ].join('\n');
  let snapshotNuevo = '';

  beforeAll(async () => {
    // Snapshot posterior a la corrección: el worker declara la lista blanca en la estructura de la pestaña.
    const [s] = await query<{ id: string }>(
      `INSERT INTO source_snapshots (source_id, organization_id, sequence, provider, fetched_at, content_hash,
                                     hash_version, structure, generator)
       VALUES ($1, $2, 3, 'google_sheets', now(), $3, 'grid-sha256/1', $4::jsonb, 'qa-f8-cierre') RETURNING id`,
      [
        sourceId,
        op.admin.organizationId,
        'c'.repeat(64),
        JSON.stringify({
          sheets: [
            {
              name: 'Influencers',
              state: 'visible',
              fragmentTextAllowlist: {
                schema: 'TCL_KOL_OS_INFLUENCERS',
                columns: ['handle'],
                columnsWithheld: 3,
              },
            },
          ],
        }),
      ],
    );
    snapshotNuevo = s!.id;
    await query(
      `INSERT INTO source_snapshot_rows (snapshot_id, sheet, sheet_gid, row_number, cells)
       VALUES ($1, 'Influencers', 11, 1, $2::jsonb)`,
      [snapshotNuevo, JSON.stringify([{ col: 1, text: 'TCL_KOL_OS_INFLUENCERS_V1', type: 'texto' }])],
    );
    await query(
      `INSERT INTO source_fragments (source_id, snapshot_id, ordinal, section, text, locator, embedding)
       VALUES ($1, $2, 1, 'Influencers', $3, $4::jsonb, $5::vector)`,
      [sourceId, snapshotNuevo, TEXTO_NUEVO, LOCALIZADOR, `[${VECTOR.join(',')}]`],
    );
    await query(`UPDATE source_documents SET current_snapshot_id = $2 WHERE id = $1`, [
      sourceId,
      snapshotNuevo,
    ]);
  });

  it('CONTROL POSITIVO: el texto del snapshot nuevo SÍ es legible (la guarda no bloquea lo que ya viene protegido)', async () => {
    const f = await getFragments(op.consultor, sourceId);
    expect(JSON.stringify(f)).toContain('SENTINELA-NUEVO-LEGIBLE');
    const b = await buscarTextoEnFuentes(op.consultor, {
      campaignId: op.campanaId,
      texto: 'SENTINELA-NUEVO-LEGIBLE',
    });
    expect(JSON.stringify(b)).toContain('SENTINELA-NUEVO-LEGIBLE');
  });

  it('el snapshot antiguo (no vigente) no entra por lectura, búsqueda ni lectura explícita de su snapshot', async () => {
    sinFinanzas(await getFragments(op.consultor, sourceId));
    sinFinanzas(await obtenerRepresentacionNormalizada(op.consultor, sourceId, {}));
    sinFinanzas(await buscarTextoEnFuentes(op.consultor, { campaignId: op.campanaId, texto: FEE }));
    sinFinanzas(await getSnapshotFragments(op.consultor, snapshotAnterior));
    sinFinanzas(await getSnapshotFragments(op.consultor, snapshotVigente));
  });
});
