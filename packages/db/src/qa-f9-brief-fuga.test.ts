/**
 * QA adversarial F9 (independiente) — Brief servido a TCL.
 *
 * (A) Texto libre del Brief con dinero / canje / tarifa en formas que la heurística `esTextoSeguroParaTcl` no
 *     reconoce: se siembra un Brief APROBADO y se comprueba, de extremo a extremo (proyección + export JSON + CSV),
 *     qué sale. Cada aserción describe el comportamiento SEGURO esperado: un fallo = fuga demostrada.
 * (B) Campos de texto LIMPIO con evidencia ligada a fuentes sensibles (snapshot histórico del Sheet de influencers,
 *     snapshot vigente con lista blanca, evidencia sin fragmento, Sheet subido como archivo): ¿se excluyen?
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePool, query } from './client.ts';
import { crearSheetDePrueba } from './kpi-test-support.ts';
import { registerLinkedSource, setSourceVisibility } from './sources.ts';
import { exportarCampanaParaTcl, obtenerBriefParaTcl } from './tcl-projection.ts';
import {
  type EscenarioDeOperacion,
  crearBriefAprobadoDePrueba,
  crearEscenarioDeOperacion,
  crearFuenteDePrueba,
  limpiarEscenarioDeOperacion,
} from './test-utils.ts';

let op: EscenarioDeOperacion;
let campana: string;

const ID = (n: string) => `QAF9-${n}`;

/** Texto (clave catálogo → valor) con marcador único; todos deberían OMITIRSE. */
const TEXTOS_PELIGROSOS: Array<[string, string, string]> = [
  // [clave, id, texto]
  ['contexto.situacion', 'P01', `${ID('P01')} El creador recibirá cuatro millones de pesos por la campaña`],
  ['contexto.categoria', 'P02', `${ID('P02')} El f-e-e del creador está cerrado`],
  ['contexto.contexto_global', 'P03', `${ID('P03')} El f\u2009ee del creador está cerrado`], // espacio fino
  ['objetivo.tipo', 'P04', `${ID('P04')} Recibirá 4k USD por pieza`],
  ['objetivo.negocio', 'P05', `${ID('P05')} La marca le paga al creador un monto fijo`],
  ['objetivo.marca_comunicacion', 'P06', `${ID('P06')} El fеe del creador es alto`], // «е» cirílica
  ['objetivo.comportamiento_esperado', 'P07', `${ID('P07')} Se canjeó el producto por contenido`],
  ['target_audiencia.descripcion', 'P08', `${ID('P08')} El acuerdo es de 4,000 por reel`],
  ['target_audiencia.rango_edad', 'P09', `${ID('P09')} Contenido a cambio de producto`],
  ['target_audiencia.ubicacion', 'P10', `${ID('P10')} Cuatro mil dólares por pieza`],
  // Controles: SÍ deben omitirse hoy (si fallan, el filtro retrocedió).
  ['target_audiencia.comportamiento', 'C01', `${ID('C01')} Su tarifa es alta`],
  ['target_audiencia.relacion_categoria', 'C02', `${ID('C02')} USD 4,000`],
  ['problema_insight.problema', 'C03', `${ID('C03')} COP$4.000.000`],
  ['problema_insight.tension', 'C04', `${ID('C04')} 4 millones`],
  ['problema_insight.insight', 'C05', `${ID('C05')} El fee del creador`],
  ['problema_insight.cambio_comportamiento', 'C06', `${ID('C06')} El f\u200Bee del creador`], // zero-width
];

let fuenteLimpia: string;
let sheetSourceId: string;
let fragmentoHistorico = '';
let sheetVigenteConLista: string;
let sheetVigenteFragmento: string;
let sheetArchivoId: string;
let sheetArchivoFragmento: string;

beforeAll(async () => {
  op = await crearEscenarioDeOperacion('QA F9 brief', { conAcuerdoAjeno: false });
  campana = op.campanaId;
  await query(`UPDATE campaigns SET visibility = 'tcl' WHERE id = $1`, [campana]);

  // Fuente de TCL normal (compartida) para un control.
  fuenteLimpia = await crearFuenteDePrueba(campana, op.admin, 'qa-f9-normal');

  // (1) Sheet con snapshots históricos SIN lista blanca (fee/canje en el texto del fragmento).
  const sheet = await crearSheetDePrueba(op.admin, {
    campaignId: campana,
    campaignInfluencerId: op.participaciones.valentinaRios,
    kpiOrigen: 'a',
    kpiVigente: 'b',
  });
  sheetSourceId = sheet.sourceId;
  const [fh] = await query<{ id: string }>(
    `INSERT INTO source_fragments (source_id, snapshot_id, ordinal, section, text, locator)
     VALUES ($1, $2, 7, 'Influencers', 'fee: FEE-HIST-7712345\ncanje: lavadora', '{"kind":"range","sheet":"Influencers","range":"A1:J3","rowStart":1,"rowEnd":3,"colStart":1,"colEnd":10}'::jsonb)
     RETURNING id`,
    [sheetSourceId, sheet.vigenteSnapshotId],
  );
  fragmentoHistorico = fh!.id;

  // (2) Otro Sheet de influencers con snapshot VIGENTE con lista blanca (texto ya filtrado) y vinculado.
  const libro = `1QaF9${Math.random().toString(36).slice(2)}${'z'.repeat(40)}`.slice(0, 44);
  const vinculada = await registerLinkedSource(op.admin, {
    campaignId: campana,
    url: `https://docs.google.com/spreadsheets/d/${libro}/edit#gid=11`,
  });
  if (!vinculada.ok) throw new Error(vinculada.error.message);
  sheetVigenteConLista = vinculada.value.id;
  const [snap] = await query<{ id: string }>(
    `INSERT INTO source_snapshots (source_id, organization_id, sequence, provider, fetched_at, content_hash,
                                   hash_version, structure, generator)
     VALUES ($1, $2, 1, 'google_sheets', now(), $3, 'grid-sha256/1', $4::jsonb, 'qa')
     RETURNING id`,
    [
      sheetVigenteConLista,
      op.admin.organizationId,
      'e'.repeat(64),
      JSON.stringify({
        sheets: [{ name: 'Influencers', state: 'visible', fragmentTextAllowlist: ['nombre'] }],
      }),
    ],
  );
  await query(
    `INSERT INTO source_snapshot_rows (snapshot_id, sheet, sheet_gid, row_number, cells)
     VALUES ($1, 'Influencers', 11, 1, '[{"col":1,"text":"TCL_KOL_OS_INFLUENCERS_V1","type":"texto"}]'::jsonb)`,
    [snap!.id],
  );
  const [fv] = await query<{ id: string }>(
    `INSERT INTO source_fragments (source_id, snapshot_id, ordinal, section, text, locator)
     VALUES ($1, $2, 1, 'Influencers', 'nombre: Valentina', '{"kind":"range","sheet":"Influencers","range":"A1:B2","rowStart":1,"rowEnd":2,"colStart":1,"colEnd":2}'::jsonb)
     RETURNING id`,
    [sheetVigenteConLista, snap!.id],
  );
  sheetVigenteFragmento = fv!.id;
  await query(`UPDATE source_documents SET current_snapshot_id = $2 WHERE id = $1`, [
    sheetVigenteConLista,
    snap!.id,
  ]);

  // (3) Sheet de influencers SUBIDO COMO ARCHIVO (xlsx): fragmentos sin snapshot, con fee en texto (subido antes de la
  //     lista blanca). No hay `source_snapshots`.
  sheetArchivoId = await crearFuenteDePrueba(campana, op.admin, 'qa-f9-influencers-archivo');
  const [fa] = await query<{ id: string }>(
    `INSERT INTO source_fragments (source_id, ordinal, section, text)
     VALUES ($1, 1, 'Influencers', 'A: TCL_KOL_OS_INFLUENCERS_V1\nfee: 9999999\ncanje: lavadora') RETURNING id`,
    [sheetArchivoId],
  );
  sheetArchivoFragmento = fa!.id;

  // Brief aprobado: claves de texto con payloads + campos LIMPIOS con evidencia sensible.
  const valores: Record<string, unknown> = {};
  for (const [clave, , texto] of TEXTOS_PELIGROSOS) valores[clave] = texto;
  valores['mensaje_principal.tono'] = `${ID('E-HIST')} Cercano y directo`; // evidencia → fragmento histórico
  valores['mensaje_principal.mensaje_clave'] = `${ID('E-VIGENTE')} Fotografía profesional`; // → Sheet vigente con lista
  valores['mensaje_principal.beneficio_diferencial'] = `${ID('E-SINFRAG')} Detalle con poca luz`; // → Sheet sin fragmento
  valores['accion_kpis.criterio_exito'] = `${ID('E-ARCHIVO')} Superar el alcance previsto`; // → Sheet archivo
  valores['accion_kpis.accion_esperada'] = `${ID('E-NORMAL')} Visitar la tienda oficial`; // control: fuente normal
  const brief = await crearBriefAprobadoDePrueba(campana, op.admin, { estado: 'draft', valores });
  const campo = (k: string) => brief.campos[k]!;
  const ev = (campoId: string, source: string, fragment: string | null) =>
    query(
      `INSERT INTO evidence (brief_field_id, source_id, fragment_id, quote, relation)
       VALUES ($1, $2, $3, 'cita', 'soporta')`,
      [campoId, source, fragment],
    );
  await ev(campo('mensaje_principal.tono'), sheetSourceId, fragmentoHistorico);
  await ev(campo('mensaje_principal.mensaje_clave'), sheetVigenteConLista, sheetVigenteFragmento);
  await ev(campo('mensaje_principal.beneficio_diferencial'), sheetVigenteConLista, null);
  await ev(campo('accion_kpis.criterio_exito'), sheetArchivoId, sheetArchivoFragmento);
  await ev(campo('accion_kpis.accion_esperada'), fuenteLimpia, null);
  await query(`UPDATE brief_versions SET status = 'approved', approved_at = now() WHERE id = $1`, [
    brief.versionId,
  ]);
  void setSourceVisibility;
}, 120_000);

afterAll(async () => {
  await limpiarEscenarioDeOperacion(op);
  await closePool();
});

async function textosServidos(): Promise<string> {
  const r = await obtenerBriefParaTcl(op.cliente, campana);
  if (!r.ok) throw new Error(r.error.code);
  return JSON.stringify(r.value);
}

describe('QA F9 · (A) texto libre del Brief aprobado: dinero/canje/tarifa en formatos evasivos', () => {
  for (const [clave, id, texto] of TEXTOS_PELIGROSOS) {
    it(`${id} ${clave}: «${texto.replace(`${ID(id)} `, '')}» NO debe servirse`, async () => {
      const servido = await textosServidos();
      expect(servido, `SE SIRVE ${id}`).not.toContain(ID(id));
    });
  }

  it('la fuga llega intacta al export JSON y al CSV (sin segunda defensa)', async () => {
    const json = await exportarCampanaParaTcl(op.cliente, campana, 'json');
    const csv = await exportarCampanaParaTcl(op.cliente, campana, 'csv');
    if (!json.ok || !csv.ok) throw new Error('export');
    for (const [, id] of TEXTOS_PELIGROSOS.filter(([, i]) => i.startsWith('P'))) {
      expect(json.value.contenido, `JSON ${id}`).not.toContain(ID(id));
      expect(csv.value.contenido, `CSV ${id}`).not.toContain(ID(id));
    }
  });
});

describe('QA F9 · (B) campo LIMPIO con evidencia sensible: debe excluirse completo', () => {
  it('control: campo con evidencia de una fuente normal SÍ se sirve (la regla no sobre-excluye)', async () => {
    expect(await textosServidos()).toContain(ID('E-NORMAL'));
  });
  it('evidencia → fragmento de snapshot HISTÓRICO del Sheet de influencers', async () => {
    expect(await textosServidos()).not.toContain(ID('E-HIST'));
  });
  it('evidencia → fragmento del snapshot VIGENTE (con lista blanca) del Sheet de influencers', async () => {
    expect(await textosServidos()).not.toContain(ID('E-VIGENTE'));
  });
  it('evidencia → Sheet de influencers SIN fragmento', async () => {
    expect(await textosServidos()).not.toContain(ID('E-SINFRAG'));
  });
  it('evidencia → Sheet de influencers subido como ARCHIVO (fragmentos sin snapshot, con fee en texto)', async () => {
    expect(
      await textosServidos(),
      'GAP: sqlFuenteEsSheetDeInfluencers solo mira source_snapshots',
    ).not.toContain(ID('E-ARCHIVO'));
  });
});
