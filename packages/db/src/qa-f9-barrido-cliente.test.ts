/**
 * QA adversarial F9 (independiente) — BARRIDO de TODO export de `@tcl-kol-os/db` con el actor cliente (marena@tcl.com).
 *
 * Idea: el dashboard TCL es seguro solo si cada camino alternativo (read model, caso de uso, función con actor) también
 * lo es: una server action, un route handler futuro o una tool pueden llamar cualquier export. Aquí se invoca CADA
 * función exportada con el actor cliente y con ids reales de la campaña visible (campaña, fuente, versión de Brief,
 * participación, entregable, versión de guion, usuario…), en varias formas de argumentos. Todo resultado `ok: true`
 * (o dato crudo) que NO sea de la proyección TCL se reporta.
 *
 * Esperado SEGURO: el cliente solo obtiene `ok:true` de la proyección TCL. Cualquier otra cosa = hallazgo.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as db from './index.ts';
import { closePool, query } from './client.ts';
import { crearSheetDePrueba } from './kpi-test-support.ts';
import { unico } from './ops-test-support.ts';
import { aprobarDirecto, versionNueva, versionRevisada } from './script-approval-test-support.ts';
import {
  type EscenarioDeOperacion,
  crearBriefAprobadoDePrueba,
  crearBriefHijoDePrueba,
  crearEscenarioDeOperacion,
  crearFuenteDePrueba,
  crearFragmentoDePrueba,
  limpiarEscenarioDeOperacion,
} from './test-utils.ts';

let op: EscenarioDeOperacion;
const ids: Record<string, string> = {};

const DENEGADAS_POR_DISENO = new Set(['closePool', 'getPool', 'query', 'queryOne', 'transaction', 'migrate']);

/** Lecturas que el cliente SÍ puede hacer por contrato (proyección TCL y fuentes compartidas). */
const PERMITIDAS = new Set([
  'listarCampanasParaTcl',
  'obtenerDetalleTclDeCampana',
  'obtenerInfluencersParaTcl',
  'obtenerContenidoParaTcl',
  'obtenerBriefParaTcl',
  'obtenerOperacionParaTcl',
  'obtenerKpisParaTcl',
  'obtenerDocumentosParaTcl',
  'obtenerProyeccionTclDeCampana',
  'exportarCampanaParaTcl',
  'autorizarCampanaParaTcl',
  // Lecturas legadas de fuentes (el cliente no tiene `source:read`: se deniegan por capacidad). Hallazgo QA-F9-P2
  // (ver `qa-f9-fuentes-legadas.test.ts`).
  'listSources',
  'getSource',
  'getFragments',
  'obtenerRepresentacionNormalizada',
  'resolverAlcanceDeFuentes',
  // Directorios SIN actor (no autorizan): `listProducts` el catálogo.
  'listProducts',
  // Helpers puros / de infraestructura sin actor que solo «reflejan» el primer argumento (no devuelven datos de negocio).
  'abandonarRunsCaducados',
  'vencerAccionesCaducadas',
  'auditoriaDe',
  'comoProductoDeDominio',
  'crearClienteDeAnalisisHttp',
  'esEvidenciaOperativa',
  'esLegibleParaIA',
  'esUuid',
  'exigirPersona',
  'huellaDeAccion',
  'llamadaOk',
  'preparacionDeFuente',
  'resolveOrigin',
  'respuestaGuionada',
  'rutaBase',
  'sanitizeMetadata',
  'sanitizeMetadataOperativa',
]);

beforeAll(async () => {
  op = await crearEscenarioDeOperacion('QA F9 barrido', { conAcuerdoAjeno: false });
  await query(`UPDATE campaigns SET visibility = 'tcl' WHERE id = $1`, [op.campanaId]);
  ids['campana'] = op.campanaId;
  const [interna] = await query<{ id: string }>(
    `INSERT INTO campaigns (organization_id, name, owner_id, created_by, visibility)
     VALUES ($1, $2, $3, $3, 'interna') RETURNING id`,
    [op.admin.organizationId, `QA F9 interna ${op.sufijo}`, op.admin.id],
  );
  op.campanas.push(interna!.id);
  ids['campanaInterna'] = interna!.id;
  ids['campanaAjena'] = op.campanaAjenaId;
  ids['participacion'] = op.participaciones.valentinaRios;
  ids['entregable'] = op.entregables.reelRios;
  ids['usuario'] = op.admin.id;

  // Fuentes: una compartida normal con fragmento, una interna, el Sheet de influencers compartido por error.
  ids['fuenteCompartida'] = await crearFuenteDePrueba(op.campanaId, op.admin, 'qa-f9-compartida');
  await crearFragmentoDePrueba(ids['fuenteCompartida'], 1, 'Fragmento compartido legible');
  await query(`UPDATE source_documents SET visibility = 'tcl' WHERE id = $1`, [ids['fuenteCompartida']]);
  ids['fuenteInterna'] = await crearFuenteDePrueba(op.campanaId, op.admin, 'qa-f9-interna');
  await crearFragmentoDePrueba(ids['fuenteInterna'], 1, 'SECRETO INTERNO-QA');
  const sheet = await crearSheetDePrueba(op.admin, {
    campaignId: op.campanaId,
    campaignInfluencerId: op.participaciones.valentinaRios,
    kpiOrigen: 'a',
    kpiVigente: 'b',
  });
  ids['sheet'] = sheet.sourceId;
  await query(`UPDATE source_documents SET visibility = 'tcl' WHERE id = $1`, [sheet.sourceId]);

  const brief = await crearBriefAprobadoDePrueba(op.campanaId, op.admin, {
    productos: [op.productos.p80],
  });
  ids['briefVersion'] = brief.versionId;
  ids['brief'] = brief.briefId;
  const hijo = await crearBriefHijoDePrueba(op.admin, brief.versionId, {
    cambios: { 'mensaje_principal.one_line': 'BORRADOR-SECRETO-QA' },
    aprobar: false,
  });
  ids['briefBorrador'] = hijo.versionId;
  ids['campoBrief'] = Object.values(brief.campos)[0]!;

  const aprobada = await versionRevisada(op, undefined, {
    deliverableId: op.entregables.reelRios,
    participationId: op.participaciones.valentinaRios,
  });
  await aprobarDirecto(op.director, aprobada.versionId);
  ids['guionAprobado'] = aprobada.versionId;
  ids['guionBorrador'] = await versionNueva(op, op.entregables.reelGomez, {
    participationId: op.participaciones.valentinaGomez,
  });
  const [inf] = await query<{ influencer_id: string }>(
    `SELECT influencer_id FROM campaign_influencers WHERE id = $1`,
    [ids['participacion']],
  );
  ids['influencer'] = inf!.influencer_id;
}, 180_000);

afterAll(async () => {
  await limpiarEscenarioDeOperacion(op);
  await closePool();
});

type Hallazgo = { fn: string; args: string; resultado: string };

function resumir(v: unknown): string {
  try {
    return (
      JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? String(x) : x))?.slice(0, 220) ?? 'undefined'
    );
  } catch {
    return String(v).slice(0, 120);
  }
}

async function conTope<T>(p: Promise<T> | T, ms = 4000): Promise<T | 'TIMEOUT'> {
  return Promise.race([
    Promise.resolve(p),
    new Promise<'TIMEOUT'>((r) => setTimeout(() => r('TIMEOUT'), ms)),
  ]);
}

describe('QA F9 · barrido de exports de db con el actor cliente', () => {
  it('ninguna función exportada entrega datos/efectos al cliente fuera de la proyección TCL', async () => {
    const cliente = op.cliente;
    const sinMeta = { ...ids };
    const kitchen = (): Record<string, unknown> => ({
      campaignId: sinMeta['campana'],
      campaignInfluencerId: sinMeta['participacion'],
      participationId: sinMeta['participacion'],
      participacionId: sinMeta['participacion'],
      influencerId: sinMeta['influencer'],
      deliverableId: sinMeta['entregable'],
      entregableId: sinMeta['entregable'],
      sourceId: sinMeta['fuenteInterna'],
      versionId: sinMeta['briefVersion'],
      briefVersionId: sinMeta['briefBorrador'],
      scriptVersionId: sinMeta['guionBorrador'],
      userId: sinMeta['usuario'],
      fieldId: sinMeta['campoBrief'],
      briefFieldId: sinMeta['campoBrief'],
      idempotencyKey: unico('qa'),
      label: 'qa',
      displayName: 'QA',
      name: 'QA',
      note: 'qa',
      visibility: 'tcl',
      to: 'approved',
      language: 'es',
      body: 'qa',
      text: 'qa',
      query: 'creador',
      q: 'creador',
    });
    const candidatos = Object.values(ids);
    const hallazgos: Hallazgo[] = [];
    const nombres = Object.keys(db)
      .filter((n) => typeof (db as Record<string, unknown>)[n] === 'function')
      .filter((n) => !DENEGADAS_POR_DISENO.has(n))
      .sort();

    for (const nombre of nombres) {
      const fn = (db as unknown as Record<string, (...a: unknown[]) => unknown>)[nombre]!;
      const intentos: unknown[][] = [[cliente], [cliente, kitchen()]];
      for (const id of candidatos) {
        intentos.push([cliente, id], [cliente, id, {}], [cliente, id, kitchen()], [cliente, id, id]);
        intentos.push([cliente, { ...kitchen(), campaignId: id, sourceId: id, versionId: id }]);
      }
      let visto = 0;
      for (const args of intentos) {
        let r: unknown;
        try {
          r = await conTope(fn(...args));
        } catch {
          continue;
        }
        if (r === 'TIMEOUT' || r === undefined || r === null) continue;
        const o = r as { ok?: unknown };
        const esResultado = typeof r === 'object' && 'ok' in (r as object);
        const exito = esResultado ? o.ok === true : true;
        if (exito && visto < 2) {
          visto += 1;
          hallazgos.push({
            fn: nombre,
            args: resumir(args.slice(1)),
            resultado: resumir(esResultado ? (r as { value?: unknown }).value : r),
          });
        }
      }
    }
    // F10: `actividadReciente(actor)` devuelve VACÍO al cliente (sin `audit:read`): se acepta solo con resultado `[]`.
    const fuera = hallazgos.filter(
      (h) => !PERMITIDAS.has(h.fn) && !(h.fn === 'actividadReciente' && h.resultado === '[]'),
    );
    // eslint-disable-next-line no-console
    console.log(
      `BARRIDO-QA-F9\n${fuera.map((h) => `${h.fn}  args=${h.args}\n    → ${h.resultado}`).join('\n')}`,
    );
    expect(fuera.map((h) => h.fn)).toEqual([]);
  }, 600_000);
});
