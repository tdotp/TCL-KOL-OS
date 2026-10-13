/**
 * QA adversarial F10 (independiente) — ATAQUE 10: fragmento HISTÓRICO del Sheet de influencers (fee/canje/condiciones).
 *
 * Complementa `qa-f8-snapshots-historicos` (lectores de fragmentos). Aquí se ataca por las COPIAS del texto que ya
 * quedaron guardadas fuera de `source_fragments`: la CITA de la evidencia del Brief (`evidence.quote`), que se escribió
 * antes de la lista blanca de columnas y se sigue sirviendo por lectores internos (Brief, hallazgos, contenido, agente).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as db from './index.ts';
import { closePool, query } from './client.ts';
import { crearSheetDePrueba } from './kpi-test-support.ts';
import {
  ENV_CON_IA,
  claveNueva,
  clienteQueResponde,
  registrarGuionDePrueba,
} from './content-analysis-test-support.ts';
import {
  type EscenarioDeOperacion,
  crearBriefAprobadoDePrueba,
  crearEscenarioDeOperacion,
  limpiarEscenarioDeOperacion,
} from './test-utils.ts';

const FEE = 'FEE-HIST-QAF10-7712345';
const CANJE = 'CANJE-HIST-QAF10-lavadora';
const SENTINELAS = [FEE, CANJE];

let op: EscenarioDeOperacion;
let briefVersionId = '';
let guionVersionId = '';
let fuenteSheet = '';

const salida: Record<string, string> = {};
function nota(nombre: string, valor: unknown): void {
  salida[nombre] = JSON.stringify(valor, (_k, x) => (typeof x === 'bigint' ? String(x) : x)) ?? '';
}

beforeAll(async () => {
  op = await crearEscenarioDeOperacion('QA F10 historico', { conAcuerdoAjeno: false });
  const sheet = await crearSheetDePrueba(op.admin, {
    campaignId: op.campanaId,
    campaignInfluencerId: op.participaciones.valentinaRios,
    kpiOrigen: 'a',
    kpiVigente: 'b',
  });
  fuenteSheet = sheet.sourceId;
  const [frag] = await query<{ id: string }>(
    `INSERT INTO source_fragments (source_id, snapshot_id, ordinal, section, text, locator)
     VALUES ($1, $2, 9, 'Influencers', $3,
             '{"kind":"range","sheet":"Influencers","range":"A1:J3","rowStart":1,"rowEnd":3,"colStart":1,"colEnd":10}'::jsonb)
     RETURNING id`,
    [sheet.sourceId, sheet.vigenteSnapshotId, `fee: ${FEE}\ncanje: ${CANJE}`],
  );
  const brief = await crearBriefAprobadoDePrueba(op.campanaId, op.admin, {
    estado: 'draft',
    productos: [op.productos.p80, op.productos.pro],
    noEncontrados: ['objetivo.comportamiento_esperado'],
  });
  briefVersionId = brief.versionId;
  // Evidencia ANTERIOR a la corrección: la cita es copia literal del fragmento histórico.
  await query(
    `INSERT INTO evidence (brief_field_id, source_id, fragment_id, quote, relation)
     VALUES ($1, $2, $3, $4, 'soporta')`,
    [brief.campos['accion_kpis.accion_esperada']!, sheet.sourceId, frag!.id, `fee: ${FEE} canje: ${CANJE}`],
  );
  await query(`UPDATE brief_versions SET status = 'approved', approved_at = now() WHERE id = $1`, [
    briefVersionId,
  ]);
  guionVersionId = (
    await registrarGuionDePrueba(op, op.entregables.reelRios, op.participaciones.valentinaRios, op.consultor)
  ).versionId;
  const r = await db.solicitarAnalisisDeGuion(
    op.consultor,
    guionVersionId,
    { mode: 'reanalyze', idempotencyKey: claveNueva('f10h') },
    undefined,
    {
      cliente: clienteQueResponde([{ category: 'cta_missing', refs: ['accion_kpis.accion_esperada'] }]),
      env: ENV_CON_IA,
      esperar: async () => {},
    },
  );
  if (!r.ok) throw new Error(`análisis: ${r.error.code} ${r.error.message}`);
}, 240_000);

afterAll(async () => {
  await limpiarEscenarioDeOperacion(op);
  await closePool();
});

describe('QA F10 · (10) los 3 lectores históricos de snapshots NO existen y nada nuevo los reemplaza', () => {
  it('listSourceSnapshots, getSourceSnapshot y getSnapshotFragments ya no se exportan', () => {
    const exportados = Object.keys(db);
    for (const n of ['listSourceSnapshots', 'getSourceSnapshot', 'getSnapshotFragments']) {
      expect(exportados, n).not.toContain(n);
    }
  });

  it('todo export cuyo nombre toca snapshots o fragmentos está en la lista conocida (un lector nuevo exige revisión)', () => {
    const conocidos = new Set([
      'getFragments', // con vigencia y filtro histórico
      'cargarRejillaDeSnapshot', // rejilla (celdas) sin actor; solo la usa validación/importación interna (X en el manifiesto)
      'compareSheetSnapshots',
      'validateInfluencerSheetSnapshot',
      'crearFragmentoDePrueba',
    ]);
    const sospechosos = Object.keys(db).filter((n) => /snapshot|fragment/iu.test(n) && !conocidos.has(n));
    expect(sospechosos).toEqual([]);
  });
});

// QA-F10-05 (CORREGIDO en F10: `camposDeVersion` sirve la cita por `sqlCitaDeEvidenciaServible`; antes P1 condicional): `evidence.quote` guarda una COPIA literal del fragmento citado. Las extracciones
// anteriores a la lista blanca de columnas del Sheet pudieron citar el texto con fee/canje; esa copia NO pasa por
// `sqlFragmentoSinTextoHistorico` y la sirven lectores internos (verCamposDeVersion, obtenerBriefWorkspace, listarHallazgos
// y la vista de contenido) incluso a roles SIN `finance:read` (consultor, analista, legal). La proyección TCL SÍ excluye el
// campo (`camposConEvidenciaNoServible`) y el agente NO recibe la cita (proyecciones de `brief_get_workspace`/`finding_list`).
// Se explota solo con evidencia heredada (datos previos al cierre de F8); no con datos nuevos (extraction.ts filtra al insertar).
describe('QA F10 · (10) la CITA de evidencia del Brief con texto histórico no sale por lectores internos', () => {
  it('CONTROL: la cita con fee existe en la base y el fragmento histórico es ilegible por los lectores de fragmentos', async () => {
    const [e] = await query<{ n: string }>(`SELECT count(*)::text AS n FROM evidence WHERE quote LIKE $1`, [
      `%${FEE}%`,
    ]);
    expect(Number(e!.n)).toBe(1);
    nota('getFragments', await db.getFragments(op.consultor, fuenteSheet));
    for (const s of SENTINELAS) expect(salida['getFragments']).not.toContain(s);
  });

  it('QA-F10-05 corregido · listarHallazgos (consultor) no trae el fee de la cita del Brief', async () => {
    const r = await db.listarHallazgos(op.consultor, { versionId: guionVersionId });
    expect(r.ok && r.value.items.length).toBeGreaterThan(0);
    nota('listarHallazgos', r);
    for (const s of SENTINELAS) expect(salida['listarHallazgos'], s).not.toContain(s);
  });

  it('QA-F10-05 corregido · obtenerBriefWorkspace (consultor) no trae el fee de la cita del Brief', async () => {
    const r = await db.obtenerBriefWorkspace(op.consultor, op.campanaId, { incluirActividad: false });
    nota('obtenerBriefWorkspace', r);
    for (const s of SENTINELAS) expect(salida['obtenerBriefWorkspace'], s).not.toContain(s);
  });

  it('QA-F10-05 corregido · verCamposDeVersion (analista, sin finance:read) no trae el fee', async () => {
    const r = await db.verCamposDeVersion(op.analista, briefVersionId);
    nota('verCamposDeVersion', r);
    for (const s of SENTINELAS) expect(salida['verCamposDeVersion'], s).not.toContain(s);
  });

  it('QA-F10-05 corregido · la vista de contenido de la UI (consultor) no trae el fee', async () => {
    const r = await db.obtenerDeliverableConVersiones(op.consultor, op.entregables.reelRios, {
      alcance: { campaignId: op.campanaId },
    });
    nota('obtenerDeliverableConVersiones', r);
    for (const s of SENTINELAS) expect(salida['obtenerDeliverableConVersiones'], s).not.toContain(s);
  });

  it('TCL: el campo con esa evidencia se excluye COMPLETO de la proyección y del export (defensa en capas vigente)', async () => {
    await query(`UPDATE campaigns SET visibility = 'tcl' WHERE id = $1`, [op.campanaId]);
    const p = await db.obtenerProyeccionTclDeCampana(op.cliente, op.campanaId);
    const j = await db.exportarCampanaParaTcl(op.cliente, op.campanaId, 'json');
    const c = await db.exportarCampanaParaTcl(op.cliente, op.campanaId, 'csv');
    if (!p.ok || !j.ok || !c.ok) throw new Error('proyección TCL');
    for (const s of SENTINELAS) {
      expect(JSON.stringify(p.value)).not.toContain(s);
      expect(j.value.contenido).not.toContain(s);
      expect(c.value.contenido).not.toContain(s);
    }
    expect(JSON.stringify(p.value.brief)).not.toContain('Invitar a la audiencia a visitar la tienda oficial');
  });
});
