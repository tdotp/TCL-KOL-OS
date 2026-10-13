/**
 * QA ADVERSARIAL F8 · el fee del Google Sheet sale por los FRAGMENTOS de la fuente (ataque 1, 3, 18).
 *
 * El Sheet de influencers puede traer las columnas `fee`, `canje` y `condiciones` (esquema V1). El worker las
 * conserva en `source_snapshot_rows` y TAMBIÉN las vuelca, como texto «cabecera: valor», en `source_fragments`
 * (`services/ai-worker/app/parsers/tabular.py::fragmentar_hoja`: un fragmento por grupo de filas con TODAS las
 * columnas). Las pruebas de F8 sembraron el centinela solo en `source_snapshot_rows` y dejaron el fragmento como
 * «texto de prueba»: un falso negativo. Aquí el fragmento tiene el texto REAL que produce el worker.
 *
 * Resultado: el fee del Sheet llega a quien lee fragmentos (consultor, analista, legal: sin `finance:read`), a TCL
 * (`cliente`) si SmartPR comparte campaña y fuente, y al AGENTE (`source_read_content`, `source_search_text`
 * ), aunque F8 declara «ni el agente ni quien no tiene finance:read ve un monto».
 *
 * Corregido: `fragmentar_hoja` arma el texto con una LISTA BLANCA de columnas del esquema V1 (sin `fee`, `canje`,
 * `condiciones` ni columnas desconocidas); el fee SIGUE en `source_snapshot_rows` (rejilla inmutable) y solo
 * dejó de volcarse al texto de los fragmentos. El fragmento sembrado es la salida REAL del worker.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePool, getFragments, query, setSourceVisibility } from '@tcl-kol-os/db';
import { abrirTurno, llamar, registro } from '../tools/test-support.ts';
import {
  type MundoDeOperacion,
  crearMundoDeOperacion,
  crearSheetConKpi,
  limpiarMundoDeOperacion,
} from './testing/operacion.ts';

const r = registro();
const FEE_DEL_SHEET = 'FEE-SHEET-QA8-9876543';
let m: MundoDeOperacion;
let sourceId = '';
let snapshotId = '';

/**
 * Salida REAL de `fragmentar_hoja` (services/ai-worker/app/parsers/tabular.py) para la hoja que siembra
 * `snapshotConFee` (fee y canje incluidos en la rejilla): el texto ya no lleva `fee`, `canje` ni `condiciones`.
 */
const TEXTO_DEL_WORKER =
  'Hoja «Influencers» · filas 1–3\nFila 1\nA: TCL_KOL_OS_INFLUENCERS_V1\nFila 3\nclave_influencer: INF-001\nnombre: Valentina Rios\nplataforma: instagram\nhandle: val.rios\nproducto: P80\nkpi_objetivo: Alcanzar 50.000 vistas';

const LOCALIZADOR =
  '{"kind":"range","sheet":"Influencers","range":"A1:H3","rowStart":1,"rowEnd":3,"colStart":1,"colEnd":8}';

async function snapshotConFee(sequence: number, fee: string): Promise<string> {
  const [s] = await query<{ id: string }>(
    `INSERT INTO source_snapshots (source_id, organization_id, sequence, provider, fetched_at, content_hash,
                                   hash_version, structure, generator)
     VALUES ($1, $2, $3, 'google_sheets', now(), $4, 'grid-sha256/1', $5::jsonb, 'qa-f8')
     RETURNING id`,
    [
      sourceId,
      m.op.admin.organizationId,
      sequence,
      String(sequence).padStart(64, 'd'),
      JSON.stringify({ sheets: [{ name: 'Influencers', state: 'visible' }] }),
    ],
  );
  const cab = [
    'clave_influencer',
    'nombre',
    'plataforma',
    'handle',
    'producto',
    'fee',
    'canje',
    'kpi_objetivo',
  ];
  const fila = [
    'INF-001',
    'Valentina Rios',
    'instagram',
    'val.rios',
    'P80',
    fee,
    'lavadora',
    'Alcanzar 50.000 vistas',
  ];
  const filas = [['TCL_KOL_OS_INFLUENCERS_V1'], cab, fila];
  for (const [i, f] of filas.entries()) {
    await query(
      `INSERT INTO source_snapshot_rows (snapshot_id, sheet, sheet_gid, row_number, cells)
       VALUES ($1, 'Influencers', 11, $2, $3::jsonb)`,
      [s!.id, i + 1, JSON.stringify(f.map((t, c) => ({ col: c + 1, text: t, type: 'texto' })))],
    );
  }
  await query(
    `INSERT INTO source_fragments (source_id, snapshot_id, ordinal, section, text, locator)
     VALUES ($1, $2, 1, 'Influencers', $3, $4::jsonb)`,
    [sourceId, s!.id, TEXTO_DEL_WORKER, LOCALIZADOR],
  );
  return s!.id;
}

beforeAll(async () => {
  m = await crearMundoDeOperacion('QA F8 sheet fee');
  const s = await crearSheetConKpi(m.op.admin, m.op.campanaId, m.rios, 'Alcanzar 50.000 vistas');
  sourceId = s.sourceId;
  snapshotId = await snapshotConFee(2, FEE_DEL_SHEET);
  await query(`UPDATE source_documents SET current_snapshot_id = $2, status = 'procesado' WHERE id = $1`, [
    sourceId,
    snapshotId,
  ]);
}, 120_000);

afterAll(async () => {
  await limpiarMundoDeOperacion(m);
  await closePool();
});

describe('CONTROL: el fee SÍ está en la rejilla del snapshot pero NO en los fragmentos (no es un falso negativo)', () => {
  it('la rejilla conserva el fee y el fragmento trae la identidad del influencer sin «fee: …»', async () => {
    const [rejilla] = await query<{ n: string }>(
      `SELECT count(*) AS n FROM source_snapshot_rows WHERE snapshot_id = $1 AND cells::text LIKE $2`,
      [snapshotId, `%${FEE_DEL_SHEET}%`],
    );
    expect(Number(rejilla!.n)).toBe(1);
    const [f] = await query<{ n: string }>(
      `SELECT count(*) AS n FROM source_fragments WHERE snapshot_id = $1 AND text LIKE $2`,
      [snapshotId, '%nombre: Valentina Rios%'],
    );
    expect(Number(f!.n)).toBe(1);
    const [g] = await query<{ n: string }>(
      `SELECT count(*) AS n FROM source_fragments WHERE snapshot_id = $1 AND (text LIKE $2 OR text LIKE $3)`,
      [snapshotId, '%fee:%', `%${FEE_DEL_SHEET}%`],
    );
    expect(Number(g!.n)).toBe(0);
  });
});

describe('P0 corregido · el fee del Sheet sale por getFragments (sin finance:read)', () => {
  for (const rol of ['consultor', 'analista', 'legal'] as const) {
    it(`${rol} (sin finance:read) no debe leer el monto del fee en los fragmentos del Sheet`, async () => {
      const a = await getFragments(m.op[rol], sourceId);
      expect(JSON.stringify(a)).not.toContain(FEE_DEL_SHEET);
    });
  }
});

describe('P0 corregido · TCL (cliente) lee el fee del Sheet cuando SmartPR comparte campaña y fuente', () => {
  it('getFragments(cliente) no debe traer fee, canje ni condiciones', async () => {
    await query(`UPDATE campaigns SET visibility = 'tcl' WHERE id = $1`, [m.op.campanaId]);
    const v = await setSourceVisibility(m.op.admin, sourceId, 'tcl');
    expect(v.ok).toBe(true);
    const fragmentos = await getFragments(m.op.cliente, sourceId);
    expect(JSON.stringify(fragmentos)).not.toContain(FEE_DEL_SHEET);
  });
});

describe('P0 corregido · el AGENTE recibe el fee del Sheet', () => {
  it('source_read_content y source_search_text no deben entregar el monto del fee al modelo', async () => {
    await query(`UPDATE source_documents SET visibility = 'interna' WHERE id = $1`, [sourceId]);
    const t = await abrirTurno(m.op.consultor, m.op.campanaId, 'Lee el Sheet de influencers');
    await llamar(r, t, 'source_list', {});
    const leido = await llamar(r, t, 'source_read_content', { sourceId: 'S1' });
    const buscado = await llamar(r, t, 'source_search_text', { text: 'fee' });
    expect(leido.content).not.toContain(FEE_DEL_SHEET);
    expect(buscado.content).not.toContain(FEE_DEL_SHEET);
  });
});
