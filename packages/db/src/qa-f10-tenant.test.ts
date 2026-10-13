/**
 * QA adversarial F10 (independiente) — ATAQUES 1 y 2: aislamiento entre organizaciones.
 *
 * El atacante es el admin de OTRA agencia (`op.ajeno`: rol con TODAS las capacidades, pero en otra organización).
 * La campaña de SmartPR está sembrada con un centinela en cada superficie (ver `qa-f10-soporte.ts`).
 *
 *  · (1) LECTURA: cada lector exportado con ids reales de SmartPR responde el MISMO error que con un uuid inexistente
 *        (404 uniforme: no se revela qué existe) y jamás devuelve un centinela.
 *  · (2) ESCRITURA: cada mutador con ids de SmartPR falla y la huella de la campaña y del conteo de auditoría de la
 *        organización de SmartPR no cambia.
 *  · (3) BARRIDO: TODA función exportada de `@tcl-kol-os/db` llamada con el actor ajeno y todos los ids de SmartPR en
 *        muchas formas de argumentos: ningún resultado contiene un centinela y no cambia ninguna fila de SmartPR.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as db from './index.ts';
import { closePool, query } from './client.ts';
import { unico } from './ops-test-support.ts';
import {
  C,
  CENTINELAS_INTERNOS,
  type Sembrado,
  escriturasDe,
  huellaDeCampana,
  sembrarSmartPR,
} from './qa-f10-soporte.ts';
import {
  type EscenarioDeOperacion,
  crearEscenarioDeOperacion,
  limpiarEscenarioDeOperacion,
} from './test-utils.ts';

let op: EscenarioDeOperacion;
let s: Sembrado;
let huellaInicial = '';
const INEXISTENTE = '99999999-9999-4999-8999-999999999999';

beforeAll(async () => {
  op = await crearEscenarioDeOperacion('QA F10 tenant', { conAcuerdoAjeno: true });
  s = await sembrarSmartPR(op);
  huellaInicial = await huellaDeCampana(op.campanaId, op.admin.organizationId);
}, 240_000);

afterAll(async () => {
  await limpiarEscenarioDeOperacion(op);
  await closePool();
});

function sinCentinelas(valor: unknown, etiqueta: string): void {
  const texto =
    JSON.stringify(valor, (_k, x) => (typeof x === 'bigint' ? String(x) : x instanceof Map ? [...x] : x)) ??
    '';
  for (const c of CENTINELAS_INTERNOS) expect(texto, `${etiqueta} contiene ${c}`).not.toContain(c);
}

type Resultado = { ok: boolean; error?: { code: string; message: string }; value?: unknown };

describe('QA F10 · (1) lectura cross-org: el mismo 404 que un id inexistente, sin centinelas', () => {
  const A = () => op.ajeno;
  const lecturas: Array<[string, (id: string) => Promise<unknown>, () => string]> = [
    ['getCampaign', (id) => db.getCampaign(A(), id), () => s.campanaId],
    ['listSources', (id) => db.listSources(A(), id), () => s.campanaId],
    ['getSource', (id) => db.getSource(A(), id), () => s.fuenteId],
    ['getFragments', (id) => db.getFragments(A(), id), () => s.fuenteId],
    [
      'obtenerRepresentacionNormalizada',
      (id) => db.obtenerRepresentacionNormalizada(A(), id, {}),
      () => s.fuenteId,
    ],
    [
      'buscarTextoEnFuentes',
      (id) => db.buscarTextoEnFuentes(A(), { campaignId: id, texto: 'QAF10' }),
      () => s.campanaId,
    ],
    ['versionesDelBrief', (id) => db.versionesDelBrief(A(), id), () => s.campanaId],
    ['verCamposDeVersion', (id) => db.verCamposDeVersion(A(), id), () => s.briefVersionId],
    ['obtenerBriefWorkspace', (id) => db.obtenerBriefWorkspace(A(), id), () => s.campanaId],
    ['obtenerBriefRector', (id) => db.obtenerBriefRector(A(), id), () => s.campanaId],
    ['listarPreguntas', (id) => db.listarPreguntas(A(), id), () => s.campanaId],
    ['listarEntregablesDeCampana', (id) => db.listarEntregablesDeCampana(A(), id), () => s.campanaId],
    ['obtenerEntregable', (id) => db.obtenerEntregable(A(), id), () => s.entregableId],
    ['listarVersionesDeEntregable', (id) => db.listarVersionesDeEntregable(A(), id), () => s.entregableId],
    ['obtenerVersionDeGuion', (id) => db.obtenerVersionDeGuion(A(), id), () => s.guionAprobadoId],
    ['obtenerVersionVigente', (id) => db.obtenerVersionVigente(A(), id), () => s.entregableId],
    ['obtenerUltimaVersion', (id) => db.obtenerUltimaVersion(A(), id), () => s.entregableId],
    ['listarComentariosDeRevision', (id) => db.listarComentariosDeRevision(A(), id), () => s.guionBorradorId],
    ['listarRevisiones', (id) => db.listarRevisiones(A(), id), () => s.guionAprobadoId],
    ['listarHallazgos', (id) => db.listarHallazgos(A(), { versionId: id }), () => s.guionAprobadoId],
    ['obtenerRevisionVigente', (id) => db.obtenerRevisionVigente(A(), id), () => s.guionAprobadoId],
    [
      'obtenerEvaluacionDeAprobacion',
      (id) => db.obtenerEvaluacionDeAprobacion(A(), id),
      () => s.guionAprobadoId,
    ],
    ['listarContenidoDeCampana', (id) => db.listarContenidoDeCampana(A(), id), () => s.campanaId],
    [
      'obtenerDeliverableConVersiones',
      (id) => db.obtenerDeliverableConVersiones(A(), id, { alcance: { campaignId: s.campanaId } }),
      () => s.entregableId,
    ],
    ['obtenerAcuerdo', (id) => db.obtenerAcuerdo(A(), id), () => s.acuerdoId],
    ['listarVersionesDeAcuerdo', (id) => db.listarVersionesDeAcuerdo(A(), id), () => s.acuerdoId],
    ['obtenerSeguimientoDePago', (id) => db.obtenerSeguimientoDePago(A(), id), () => s.participacionId],
    ['listarDocumentosDeCobro', (id) => db.listarDocumentosDeCobro(A(), id), () => s.participacionId],
    ['obtenerEnvio', (id) => db.obtenerEnvio(A(), id), () => s.envioId],
    ['listarEnviosDeParticipacion', (id) => db.listarEnviosDeParticipacion(A(), id), () => s.participacionId],
    ['obtenerKpiDeParticipacion', (id) => db.obtenerKpiDeParticipacion(A(), id), () => s.participacionId],
    [
      'obtenerHistorialDeKpi',
      (id) => db.obtenerHistorialDeKpi(A(), { campaignInfluencerId: id }),
      () => s.participacionId,
    ],
    ['obtenerResumenKpiDeCampana', (id) => db.obtenerResumenKpiDeCampana(A(), id), () => s.campanaId],
    ['obtenerKpiPactadoDelSheet', (id) => db.obtenerKpiPactadoDelSheet(A(), id), () => s.participacionId],
    [
      'obtenerResumenOperativoDeCampana',
      (id) => db.obtenerResumenOperativoDeCampana(A(), id),
      () => s.campanaId,
    ],
    [
      'obtenerEstadoOperativoDeParticipacion',
      (id) => db.obtenerEstadoOperativoDeParticipacion(A(), id),
      () => s.participacionId,
    ],
    [
      'obtenerResumenOperativoParaAgente',
      (id) => db.obtenerResumenOperativoParaAgente(A(), id),
      () => s.campanaId,
    ],
    [
      'obtenerEstadoOperativoParaAgente',
      (id) => db.obtenerEstadoOperativoParaAgente(A(), id),
      () => s.participacionId,
    ],
    [
      'listarEventosOperativos',
      (id) => db.listarEventosOperativos(A(), { subjectType: 'payment_obligation', subjectId: id }),
      () => s.obligacionId,
    ],
    [
      'listarEvidenciaDeSujeto',
      (id) => db.listarEvidenciaDeSujeto(A(), { subjectType: 'payment_obligation', subjectId: id }),
      () => s.obligacionId,
    ],
    ['obtenerPiiResumen', (id) => db.obtenerPiiResumen(A(), id), () => s.influencerId],
    ['revelarPii', (id) => db.revelarPii(A(), id, ['phone', 'address', 'document_id']), () => s.piiRecordId],
    ['obtenerCampaignInfluencer', (id) => db.obtenerCampaignInfluencer(A(), id), () => s.participacionId],
    ['listarInfluencersDeCampana', (id) => db.listarInfluencersDeCampana(A(), id), () => s.campanaId],
    [
      'listarInfluencersDeCampanaConConteo',
      (id) => db.listarInfluencersDeCampanaConConteo(A(), id),
      () => s.campanaId,
    ],
    ['obtenerConversacion', (id) => db.obtenerConversacion(A(), id), () => s.conversacionId],
    ['listarMensajes', (id) => db.listarMensajes(A(), id), () => s.conversacionId],
    ['obtenerConversacionDeCampana', (id) => db.obtenerConversacionDeCampana(A(), id), () => s.campanaId],
    ['obtenerMensajesDeChat', (id) => db.obtenerMensajesDeChat(A(), id), () => s.conversacionId],
    ['cargarVistaDeChat', (id) => db.cargarVistaDeChat(A(), id), () => s.campanaId],
    [
      'listarAccionesDeConversacion',
      (id) => db.listarAccionesDeConversacion(A(), id),
      () => s.conversacionId,
    ],
    [
      'listarAccionesPendientesDeCampana',
      (id) => db.listarAccionesPendientesDeCampana(A(), id),
      () => s.campanaId,
    ],
    ['obtenerAccionPropuesta', (id) => db.obtenerAccionPropuesta(A(), id), () => s.accionId],
    ['obtenerAccionDeChat', (id) => db.obtenerAccionDeChat(A(), s.campanaId, id), () => s.accionId],
    ['trazaDeConversacion', (id) => db.trazaDeConversacion(A(), id), () => s.conversacionId],
    ['trazaDeAccionPropuesta', (id) => db.trazaDeAccionPropuesta(A(), id), () => s.accionId],
    [
      'listarComentarios',
      (id) => db.listarComentarios(A(), id, 'mensaje_principal.one_line'),
      () => s.briefVersionId,
    ],
    ['evaluarProntitudDeAnalisis', (id) => db.evaluarProntitudDeAnalisis(A(), id), () => s.guionAprobadoId],
    ['resolverAlcanceDeFuentes', (id) => db.resolverAlcanceDeFuentes(A(), id), () => s.campanaId],
  ];

  it.each(lecturas)('%s: id de SmartPR ≡ id inexistente y sin centinelas', async (nombre, llamar, idDe) => {
    const real = (await llamar(idDe())) as Resultado;
    const nada = (await llamar(INEXISTENTE)) as Resultado;
    // Algunas funciones no devuelven Result (p. ej. arreglos): se exige entonces que no contengan centinelas.
    if (typeof real === 'object' && real !== null && 'ok' in real) {
      if (real.ok) {
        // Las listas filtradas por la organización del actor responden VACÍO, idéntico al id inexistente.
        expect(JSON.stringify(real), `${nombre}: ok con datos distintos a un id inexistente`).toBe(
          JSON.stringify(nada),
        );
      } else {
        expect(real.error?.code).toBe((nada as Resultado).error?.code);
        expect(real.error?.message).toBe((nada as Resultado).error?.message);
      }
    }
    sinCentinelas(real, nombre);
  });

  it('un sujeto de OTRA campaña de la misma organización tampoco se cuela por la campaña propia del atacante', async () => {
    // El atacante usa SU campaña con el id de recursos de SmartPR: la búsqueda textual, la lista de fuentes y el
    // workspace de Brief de la campaña AJENA nunca mezclan datos de SmartPR.
    const r1 = await db.buscarTextoEnFuentes(op.ajeno, { campaignId: op.campanaAjenaId, texto: 'QAF10' });
    sinCentinelas(r1, 'buscarTextoEnFuentes campaña ajena');
    const r2 = await db.listSources(op.ajeno, op.campanaAjenaId);
    sinCentinelas(r2, 'listSources campaña ajena');
    const r3 = await db.obtenerResumenOperativoDeCampana(op.ajeno, op.campanaAjenaId);
    sinCentinelas(r3, 'resumen operativo campaña ajena');
  });
});

describe('QA F10 · (2) escritura cross-org: ningún mutador cambia nada de SmartPR', () => {
  it('cada mutador con ids de SmartPR y argumentos válidos falla con el 404 uniforme y no escribe nada', async () => {
    const escrituras = escriturasDe(op.ajeno, s);
    expect(escrituras.length).toBeGreaterThanOrEqual(35);
    for (const [nombre, llamar] of escrituras) {
      const antes = await huellaDeCampana(op.campanaId, op.admin.organizationId);
      let r: unknown;
      try {
        r = await llamar();
      } catch (e) {
        r = { ok: false, lanzo: e instanceof Error ? e.name : typeof e };
      }
      const o = r as Resultado;
      if (typeof o === 'object' && o !== null && 'ok' in o) {
        expect(o.ok, `${nombre} devolvió ok:true con un actor de otra organización`).toBe(false);
        // La autorización va ANTES que la validación: el error es el 404 uniforme (un código de validación
        // delataría que la prueba falló por la forma de los argumentos y no por el aislamiento).
        expect(o.error?.code, `${nombre}: no es el 404 uniforme`).toBe('RESOURCE_NOT_FOUND');
      }
      const despues = await huellaDeCampana(op.campanaId, op.admin.organizationId);
      expect(despues, `${nombre} cambió filas de SmartPR`).toBe(antes);
      sinCentinelas(r, nombre);
    }
  }, 120_000);
});

describe('QA F10 · (3) barrido por reflexión: TODA función exportada con el actor ajeno', () => {
  // Mantenimiento sin actor que opera sobre TODAS las organizaciones por diseño: no se barren (no reciben actor).
  const SIN_ACTOR = new Set([
    'closePool',
    'getPool',
    'query',
    'queryOne',
    'transaction',
    'migrate',
    'abandonarRunsCaducados',
    'vencerAccionesCaducadas',
    'transaccionOperativa',
  ]);

  it('ningún resultado contiene centinelas de SmartPR y la campaña sembrada queda intacta', async () => {
    const ids = Object.values({ ...s.ids, [`inexistente`]: INEXISTENTE });
    const kitchen = (id: string): Record<string, unknown> => ({
      campaignId: s.campanaId,
      campaignInfluencerId: s.participacionId,
      participationId: s.participacionId,
      influencerId: s.influencerId,
      deliverableId: s.entregableId,
      sourceId: s.fuenteId,
      versionId: s.briefVersionId,
      scriptVersionId: s.guionBorradorId,
      userId: op.admin.id,
      conversationId: s.conversacionId,
      idempotencyKey: unico('qa-f10-sweep-xxxx'),
      expectedSeq: 1,
      label: 'qa',
      note: 'qa',
      body: 'qa f10 barrido',
      text: 'QAF10',
      texto: 'QAF10',
      query: 'QAF10',
      to: 'approved',
      visibility: 'tcl',
      id,
    });
    const nombres = Object.keys(db)
      .filter((n) => typeof (db as Record<string, unknown>)[n] === 'function')
      .filter((n) => !SIN_ACTOR.has(n))
      .sort();
    const fugas: string[] = [];
    for (const nombre of nombres) {
      const fn = (db as unknown as Record<string, (...a: unknown[]) => unknown>)[nombre]!;
      const intentos: unknown[][] = [[op.ajeno], [op.ajeno, kitchen(s.campanaId)]];
      for (const id of ids) {
        intentos.push([op.ajeno, id], [op.ajeno, id, {}], [op.ajeno, id, kitchen(id)]);
        intentos.push(
          [op.ajeno, kitchen(id)],
          [op.ajeno, { campaignId: id, id, sourceId: id, versionId: id }],
        );
      }
      for (const args of intentos) {
        let r: unknown;
        try {
          r = await Promise.race([
            Promise.resolve(fn(...args)),
            new Promise((res) => setTimeout(() => res('TIMEOUT'), 4000)),
          ]);
        } catch {
          continue;
        }
        const texto = (() => {
          try {
            return JSON.stringify(r, (_k, x) => (typeof x === 'bigint' ? String(x) : x)) ?? '';
          } catch {
            return '';
          }
        })();
        for (const c of CENTINELAS_INTERNOS) {
          // Un eco del PROPIO argumento (`body`, `texto`: «QAF10 …») no cuenta: solo los centinelas de datos.
          if (texto.includes(c)) fugas.push(`${nombre} → ${c}`);
        }
      }
    }
    expect([...new Set(fugas)], 'fugas de datos de SmartPR hacia otra organización').toEqual([]);
    const final = await huellaDeCampana(op.campanaId, op.admin.organizationId);
    expect(final, 'el barrido modificó filas de SmartPR').toBe(huellaInicial);
  }, 900_000);

  it('CONTROL: el propio actor SÍ ve su dato (el centinela es detectable)', async () => {
    const r = await db.listSources(op.admin, s.campanaId);
    expect(JSON.stringify(r)).toContain(C.fuente);
    const [n] = await query<{ n: string }>(`SELECT count(*)::text AS n FROM campaigns WHERE name LIKE $1`, [
      `${C.campana}%`,
    ]);
    expect(Number(n!.n)).toBe(1);
  });
});
