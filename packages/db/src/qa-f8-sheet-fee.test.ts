/**
 * QA ADVERSARIAL F8 · el fee del Google Sheet sale por la BÚSQUEDA y por la EXTRACCIÓN del Brief (ataque 1, 16, 18).
 *
 * Complementa `packages/agent/src/qa/qa-f8-sheet-fee.test.ts`. El worker vuelca TODAS las columnas del Sheet de
 * influencers (incluidas `fee`, `canje` y `condiciones`) en `source_fragments.text`; los lectores genéricos de
 * fragmentos no conocen esas columnas. Aquí: la búsqueda textual (consultor, TCL) y el insumo que `extraerCampos`
 * envía al LLM del worker para rellenar el Brief (que TCL puede leer con `brief:read`).
 *
 * Corregido: `fragmentar_hoja` arma el texto con una LISTA BLANCA de columnas del esquema V1 (sin `fee`, `canje`,
 * `condiciones` ni columnas desconocidas). El fragmento sembrado es la salida REAL del worker para esta hoja.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { closePool, query } from './client.ts';
import { extraerCampos } from './extraction.ts';
import { crearSheetDePrueba } from './kpi-test-support.ts';
import { buscarTextoEnFuentes } from './search.ts';
import { setSourceVisibility } from './sources.ts';
import {
  type EscenarioDeOperacion,
  crearEscenarioDeOperacion,
  limpiarEscenarioDeOperacion,
} from './test-utils.ts';

const FEE = 'FEE-QA8-SHEET-9876543';
let op: EscenarioDeOperacion;
let sourceId = '';

/**
 * Salida REAL de `fragmentar_hoja` (services/ai-worker/app/parsers/tabular.py) para una hoja V1 con las columnas
 * clave_influencer, nombre, plataforma, handle, producto, fee, canje y kpi_objetivo (fee = FEE, canje = lavadora).
 * Generada con el worker: el fee y el canje de la hoja NO aparecen en el texto.
 */
const TEXTO_DEL_WORKER =
  'Hoja «Influencers» · filas 1–3\nFila 1\nA: TCL_KOL_OS_INFLUENCERS_V1\nFila 3\nclave_influencer: INF-001\nnombre: Valentina Rios\nplataforma: instagram\nhandle: val.rios\nproducto: P80\nkpi_objetivo: Alcanzar 50.000 vistas';

beforeAll(async () => {
  op = await crearEscenarioDeOperacion('QA F8 sheet fee db', { conAcuerdoAjeno: false });
  const sheet = await crearSheetDePrueba(op.admin, {
    campaignId: op.campanaId,
    campaignInfluencerId: op.participaciones.valentinaRios,
    kpiOrigen: 'a',
    kpiVigente: 'b',
  });
  sourceId = sheet.sourceId;
  await query(
    `INSERT INTO source_fragments (source_id, snapshot_id, ordinal, section, text, locator)
     VALUES ($1, $2, 1, 'Influencers', $3,
             '{"kind":"range","sheet":"Influencers","range":"A1:H3","rowStart":1,"rowEnd":3,"colStart":1,"colEnd":8}'::jsonb)`,
    [sourceId, sheet.vigenteSnapshotId, TEXTO_DEL_WORKER],
  );
  await query(`UPDATE source_documents SET status = 'procesado' WHERE id = $1`, [sourceId]);
});

afterAll(async () => {
  vi.unstubAllGlobals();
  await limpiarEscenarioDeOperacion(op);
  await closePool();
});

describe('CONTROL: el fragmento vigente de una fuente procesada es el del worker, sin columnas financieras', () => {
  it('hay exactamente un fragmento con la identidad del influencer y ninguno con «fee: …» ni «canje: …»', async () => {
    const [f] = await query<{ n: string }>(
      `SELECT count(*) AS n FROM source_fragments WHERE source_id = $1 AND text LIKE $2`,
      [sourceId, '%nombre: Valentina Rios%'],
    );
    expect(Number(f!.n)).toBe(1);
    const [g] = await query<{ n: string }>(
      `SELECT count(*) AS n FROM source_fragments WHERE source_id = $1 AND (text LIKE $2 OR text LIKE $3)`,
      [sourceId, '%fee:%', '%canje:%'],
    );
    expect(Number(g!.n)).toBe(0);
  });
});

describe('P0 corregido · búsqueda textual', () => {
  it('el consultor (sin finance:read) no encuentra ni lee el monto del fee buscando «fee»', async () => {
    const r = await buscarTextoEnFuentes(op.consultor, { campaignId: op.campanaId, texto: 'fee' });
    expect(r.ok).toBe(true);
    expect(JSON.stringify(r)).not.toContain(FEE);
  });

  it('TCL (cliente), con campaña y fuente compartidas, no encuentra el fee buscando «fee»', async () => {
    await query(`UPDATE campaigns SET visibility = 'tcl' WHERE id = $1`, [op.campanaId]);
    expect((await setSourceVisibility(op.admin, sourceId, 'tcl')).ok).toBe(true);
    // Fase 9 (ciclo QA): sin `source:read_shared` la búsqueda del cliente se deniega por completo.
    const r = await buscarTextoEnFuentes(op.cliente, { campaignId: op.campanaId, texto: 'fee' });
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toContain(FEE);
  });
});

describe('P0 corregido · extracción del Brief (insumo del LLM; el Brief lo lee TCL)', () => {
  it('extraerCampos no envía el fee del Sheet al worker', async () => {
    await query(`UPDATE source_documents SET visibility = 'interna' WHERE id = $1`, [sourceId]);
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
    expect(enviado).not.toBe('');
    expect(enviado).not.toContain(FEE);
  });
});
