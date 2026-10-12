/**
 * V2 · Fase 9 (WAVE 1) — PROYECCIÓN TCL del servidor contra PostgreSQL real.
 *
 * Matriz: aislamiento (campaña visible / interna / otra agencia / UUID directo), influencers sin PII ni dinero,
 * contenido (solo `approved` vigente), Brief (solo aprobado vigente, ES/EN, fuga histórica fee/canje/condiciones),
 * operación sin dinero ni modo, KPI (compatibles; `other` e `internal` no salen), documentos (cada fuente se comparte
 * a propósito), export (misma proyección, columnas ⊆ DTO, fórmulas neutralizadas), escrituras del cliente denegadas,
 * espía del pool (jamás consulta tablas prohibidas) y claves de cada DTO = lista blanca exacta.
 *
 * Todo sintético. Escenario propio; se limpia al final.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { type User, CLAVES_DE_DTO_TCL, clavesProhibidasEn, roleCan } from '@tcl-kol-os/domain';
import { crearAcuerdo } from './agreements.ts';
import { archiveCampaign, createCampaign, getCampaign, listCampaigns } from './campaigns.ts';
import { asociarInfluencerACampana, retirarInfluencerDeCampana } from './campaign-influencers.ts';
import { closePool, getPool, query } from './client.ts';
import { crearComentarioDeRevision, solicitarCambiosDeScript } from './script-review.ts';
import { crearEntregable } from './deliverables.ts';
import { crearInfluencer } from './influencers.ts';
import { corregirMedicionKpi, registrarMedicionKpi } from './kpi-measurements.ts';
import { registrarKpiObjetivo } from './kpi-targets.ts';
import { crearSheetDePrueba } from './kpi-test-support.ts';
import { obtenerKpiDeParticipacion, obtenerResumenKpiDeCampana } from './kpi-views.ts';
import { guardarPii } from './pii.ts';
import { crearEnvio, transicionarEnvio } from './shipments.ts';
import {
  obtenerSeguimientoDePago,
  registrarDocumentoDeCobro,
  reportarPago,
  validarDocumento,
} from './billing-payment.ts';
import { archivoDePrueba, dia, unico } from './ops-test-support.ts';
import { listSources, setSourceVisibility, uploadSource } from './sources.ts';
import {
  aprobarDirecto,
  otraVersionRevisada,
  revisarComoHumano,
  versionNueva,
  versionRevisada,
} from './script-approval-test-support.ts';
import { revisarConIA } from './script-approval-test-support.ts';
import { registrarVersionDeGuion } from './script-versions.ts';
import { obtenerBriefRector } from './content-analysis.ts';
import { obtenerBriefWorkspace } from './brief-workspace.ts';
import { obtenerRepresentacion, obtenerVersionLogica } from './brief-representations.ts';
import { verCamposDeVersion, versionesDelBrief } from './extraction.ts';
import {
  autorizarCampanaParaTcl,
  exportarCampanaParaTcl,
  listarCampanasParaTcl,
  obtenerBriefParaTcl,
  obtenerContenidoParaTcl,
  obtenerDetalleTclDeCampana,
  obtenerDocumentosParaTcl,
  obtenerInfluencersParaTcl,
  obtenerKpisParaTcl,
  obtenerOperacionParaTcl,
  obtenerProyeccionTclDeCampana,
} from './tcl-projection.ts';
import {
  type BriefDePrueba,
  type EscenarioDeOperacion,
  claveDePrueba,
  crearAcuerdoDePrueba,
  crearBriefAprobadoDePrueba,
  crearBriefHijoDePrueba,
  crearEscenarioDeOperacion,
  crearFuenteDePrueba,
  limpiarEscenarioDeOperacion,
} from './test-utils.ts';

// ─────────────────────────── Sentinelas: JAMÁS deben salir ─────────────────────

const FEE = 9876543;
const COSTO_ENVIO = 7654321;
const COBRO = 5432198;
const CEDULA = String(1_000_000_000 + Math.floor(Math.random() * 8_000_000_000));
const TELEFONO = '3001112233';
const DIRECCION = 'Calle 99 # 88-77 Apto SENT';
const GUIA = 'GUIA-SENT-777';
const TRANSPORTADORA = 'TRANSPORTADORA-SENT';
const NOTA = 'NOTA-SENT-INTERNA';
const REFERENCIA = 'REF-EXT-SENT-555';
const EVIDENCIA = 'EVIDENCIA-SENT-FILE';
const MOTIVO_KPI = 'SENT-MOTIVO-CORRECCION-5521';
const COMENTARIO = 'SENT-COMENTARIO-DE-REVISION-9931';
const HALLAZGO = 'SENT-HALLAZGO-INTERNO-7741';
const CONDICIONES = 'SENT-CONDICION-DEL-ACUERDO-3321';
const FEE_HIST = 'FEE-HIST-7712345';
const CANJE_HIST = 'CANJE-HIST-lavadora-4455';
const COND_HIST = 'COND-HIST-exclusividad-6677';
const TEL_HIST = 'TEL-HIST-3001239876';
const PRESUPUESTO = 'SENT-PRESUPUESTO-TOTAL-8812';

const SENTINELAS = [
  String(FEE),
  String(COSTO_ENVIO),
  String(COBRO),
  CEDULA,
  TELEFONO,
  DIRECCION,
  GUIA,
  TRANSPORTADORA,
  NOTA,
  REFERENCIA,
  EVIDENCIA,
  MOTIVO_KPI,
  COMENTARIO,
  HALLAZGO,
  CONDICIONES,
  FEE_HIST,
  CANJE_HIST,
  COND_HIST,
  TEL_HIST,
  PRESUPUESTO,
];

/** Ningún sentinela aparece en ninguna parte del valor serializado. */
function sinSentinelas(valor: unknown): void {
  const texto = JSON.stringify(valor);
  for (const s of SENTINELAS) expect(texto, `sale «${s}»`).not.toContain(s);
}

const NO_ENCONTRADO = { code: 'RESOURCE_NOT_FOUND', message: 'El recurso no existe o no está disponible.' };

/** `err()` devuelve una clase de error: se compara su contenido (código, mensaje y detalles), no la instancia. */
function plano(r: unknown): unknown {
  const x = r as { ok: boolean; error?: { code: string; message: string; details?: unknown } };
  return x.ok
    ? { ok: true }
    : { ok: false, error: { code: x.error!.code, message: x.error!.message, details: x.error!.details } };
}
const NO_ENCONTRADO_PLANO = { ok: false, error: { ...NO_ENCONTRADO, details: undefined } };
/** Sin UUID (un id aleatorio puede contener «fee» u otra subcadena). */
const sinUuids = (v: unknown): string =>
  JSON.stringify(v).replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gu, '');

function exito<T>(r: {
  ok: boolean;
  value?: T;
  error?: { code: string; message: string; details?: unknown };
}): T {
  if (!r.ok)
    throw new Error(`${r.error?.code}: ${r.error?.message} ${JSON.stringify(r.error?.details ?? {})}`);
  return r.value as T;
}
function codigo(r: { ok: boolean; error?: { code: string } }): string {
  return r.ok ? 'OK' : r.error!.code;
}
const claves = (o: object): string[] => Object.keys(o).sort();
const esperadas = (n: keyof typeof CLAVES_DE_DTO_TCL): string[] => [...CLAVES_DE_DTO_TCL[n]].sort();

// ─────────────────────────── Escenario ─────────────────────────────────────────

let op: EscenarioDeOperacion;
let tcl: User;
let rios: string;
let gomez: string;
let diego: string;
let retirada: string;
let briefA: BriefDePrueba;
/** campaña B (visible): Brief aprobado con EN DESACTUALIZADA y un hijo en borrador. */
let campanaB: string;
let briefB: BriefDePrueba;
/** campaña C (visible): solo Brief en borrador. */
let campanaC: string;
/** campaña interna (de la misma agencia) y campaña cancelada (visible por visibilidad, no por estado). */
let internaId: string;
let canceladaId: string;
let sheetSourceId = '';
let docTcl = '';
let docInterno = '';
let docGuionAprobado = '';
let docGuionNoAprobado = '';

const VERSIONES: Record<string, string> = {};

async function campanaNueva(etiqueta: string, visibilidad: string, estado = 'activa'): Promise<string> {
  const [c] = await query<{ id: string }>(
    `INSERT INTO campaigns (organization_id, name, owner_id, created_by, visibility, status)
     VALUES ($1, $2, $3, $3, $4::visibility_level, $5::campaign_status) RETURNING id`,
    [op.admin.organizationId, `F9 · ${etiqueta} · ${op.sufijo}`, op.admin.id, visibilidad, estado],
  );
  op.campanas.push(c!.id);
  return c!.id;
}

async function traducirTodo(versionId: string): Promise<void> {
  const [original] = await query<{ id: string }>(
    `SELECT id FROM brief_version_representations WHERE brief_version_id = $1 AND kind = 'original'`,
    [versionId],
  );
  const [en] = await query<{ id: string }>(
    `INSERT INTO brief_version_representations (brief_version_id, language, kind, source_representation_id, created_by)
     VALUES ($1, 'en', 'translation', $2, $3) RETURNING id`,
    [versionId, original!.id, op.admin.id],
  );
  await query(
    `INSERT INTO brief_field_translations
       (brief_field_id, representation_id, value, translator, source_value_hash, source_revision)
     SELECT f.id, $2,
            CASE WHEN jsonb_typeof(f.value) = 'string' THEN to_jsonb('EN: ' || (f.value #>> '{}')) ELSE f.value END,
            'ai', brief_value_hash(f.value), f.revision
       FROM brief_fields f
      WHERE f.brief_version_id = $1 AND f.value IS NOT NULL AND f.value <> 'null'::jsonb`,
    [versionId, en!.id],
  );
}

async function aprobarBrief(versionId: string): Promise<void> {
  await query(`UPDATE brief_versions SET status = 'approved', approved_at = now() WHERE id = $1`, [
    versionId,
  ]);
}

async function nuevaParticipacion(etiqueta: string): Promise<{ id: string; influencerId: string }> {
  const creado = exito(
    await crearInfluencer(op.admin, {
      displayName: `${etiqueta} ${unico('p')}`.slice(0, 80),
      cuentas: [
        {
          platform: 'instagram',
          handle: `${etiqueta}.${unico('h')}`.toLowerCase().replace(/[^a-z0-9._]/g, ''),
        },
      ],
    }),
  );
  op.influencerIds.push(creado.influencer.id);
  const ci = exito(
    await asociarInfluencerACampana(op.admin, {
      campaignId: op.campanaId,
      influencerId: creado.influencer.id,
    }),
  );
  return { id: ci.id, influencerId: creado.influencer.id };
}

async function envio(ci: string, producto: string, cantidad: number) {
  return exito(
    await crearEnvio(op.operativo, {
      campaignInfluencerId: ci,
      items: [{ campaignProductId: producto, quantity: cantidad }],
      idempotencyKey: unico('envio'),
    }),
  ).envio;
}
async function mover(
  s: { id: string; rowSeq: number },
  to: Parameters<typeof transicionarEnvio>[1]['to'],
  extra: Partial<Parameters<typeof transicionarEnvio>[1]> = {},
) {
  return exito(
    await transicionarEnvio(op.operativo, {
      shipmentId: s.id,
      to,
      expectedSeq: s.rowSeq,
      idempotencyKey: unico(to),
      ...extra,
    }),
  ).envio;
}

beforeAll(async () => {
  op = await crearEscenarioDeOperacion('F9 TCL', { conAcuerdoAjeno: false });
  tcl = op.cliente;
  rios = op.participaciones.valentinaRios;
  gomez = op.participaciones.valentinaGomez;
  diego = op.participaciones.diego;

  // Campañas: A (la del escenario) visible para TCL; B y C visibles; interna; cancelada; la de otra agencia sigue interna.
  await query(`UPDATE campaigns SET visibility = 'tcl' WHERE id = $1`, [op.campanaId]);
  campanaB = op.otraCampanaId;
  await query(`UPDATE campaigns SET visibility = 'compartida' WHERE id = $1`, [campanaB]);
  campanaC = await campanaNueva('C solo borrador', 'tcl');
  internaId = await campanaNueva('interna', 'interna');
  canceladaId = await campanaNueva('cancelada', 'tcl', 'cancelada');

  // Hoja de influencers con snapshots HISTÓRICOS (sin lista blanca): fee, canje, condiciones y teléfono en el texto.
  const sheet = await crearSheetDePrueba(op.admin, {
    campaignId: op.campanaId,
    campaignInfluencerId: rios,
    kpiOrigen: 'a',
    kpiVigente: 'b',
  });
  sheetSourceId = sheet.sourceId;
  const textoAntiguo = [
    'Hoja «Influencers» · filas 1–3',
    'A: TCL_KOL_OS_INFLUENCERS_V1',
    `fee: ${FEE_HIST}`,
    `canje: ${CANJE_HIST}`,
    `condiciones: ${COND_HIST}`,
    `telefono: ${TEL_HIST}`,
  ].join('\n');
  const [fragmentoHistorico] = await query<{ id: string }>(
    `INSERT INTO source_fragments (source_id, snapshot_id, ordinal, section, text, locator)
     VALUES ($1, $2, 7, 'Influencers', $3,
             '{"kind":"range","sheet":"Influencers","range":"A1:J3","rowStart":1,"rowEnd":3,"colStart":1,"colEnd":10}'::jsonb)
     RETURNING id`,
    [sheetSourceId, sheet.vigenteSnapshotId, textoAntiguo],
  );
  await query(`UPDATE source_documents SET status = 'procesado' WHERE id = $1`, [sheetSourceId]);

  // Brief A (borrador → campos extra → traducción EN completa → aprobado). Texto con fee y presupuesto, y un campo
  // de texto LIMPIO cuya evidencia cita el fragmento histórico del Sheet (derivado de un snapshot histórico).
  briefA = await crearBriefAprobadoDePrueba(op.campanaId, op.admin, {
    estado: 'draft',
    productos: [op.productos.p80, op.productos.pro],
    valores: {
      'mensaje_principal.tono': 'Cercano, aspiracional y directo',
      'contexto.situacion': 'Exclusividad total de seis meses con la marca',
      'objetivo.negocio': 'Crecer las ventas; el fee del creador es de $ 5.000.000',
      'practico.presupuesto': `Presupuesto total ${PRESUPUESTO}`,
      'entregable_creativo.canales': ['Instagram', 'TikTok'],
      // Un campo en CONFLICTO (valor sin resolver) no se sirve aunque tenga valor.
      'objetivo.marca_comunicacion': 'CONFLICTO-SIN-RESOLVER-NO-VISIBLE',
    },
  });
  await query(`UPDATE brief_fields SET status = 'conflict' WHERE id = $1`, [
    briefA.campos['objetivo.marca_comunicacion'],
  ]);
  await query(
    `INSERT INTO evidence (brief_field_id, source_id, fragment_id, quote, relation)
     VALUES ($1, $2, $3, 'Cita del Sheet histórico', 'soporta')`,
    [briefA.campos['contexto.situacion'], sheetSourceId, fragmentoHistorico!.id],
  );
  await traducirTodo(briefA.versionId);
  await aprobarBrief(briefA.versionId);

  // Brief B: EN desactualizada (el original cambió tras traducir) + un hijo en borrador con otro valor.
  briefB = await crearBriefAprobadoDePrueba(campanaB, op.admin, {
    estado: 'draft',
    valores: { 'mensaje_principal.tono': 'Tono del brief aprobado' },
  });
  await traducirTodo(briefB.versionId);
  await query(`UPDATE brief_fields SET value = '"Tono del brief aprobado, ajustado"'::jsonb WHERE id = $1`, [
    briefB.campos['mensaje_principal.tono'],
  ]);
  await aprobarBrief(briefB.versionId);
  await crearBriefHijoDePrueba(op.admin, briefB.versionId, {
    cambios: { 'mensaje_principal.tono': 'CAMBIO-EN-BORRADOR-NO-VISIBLE' },
    aprobar: false,
  });

  // Brief C: solo borrador.
  await crearBriefAprobadoDePrueba(campanaC, op.admin, { estado: 'draft' });

  // Operación: rios MIXTO (fee + 4 P80); gomez BARTER (2 P80 Pro); diego sin acuerdo.
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
  const [filaRios] = await query<{ influencer_id: string }>(
    `SELECT influencer_id FROM campaign_influencers WHERE id = $1`,
    [rios],
  );
  const pii = exito(
    await guardarPii(op.operativo, {
      influencerId: filaRios!.influencer_id,
      documentId: CEDULA,
      phone: TELEFONO,
      address: DIRECCION,
    }),
  );
  // rios: un envío ENTREGADO (2 de 4) y otro PENDIENTE; gomez: uno pendiente.
  let s = await envio(rios, op.productos.p80, 2);
  s = await mover(s, 'prepared');
  s = await mover(s, 'shipped', {
    happenedOn: dia(3),
    carrier: TRANSPORTADORA,
    trackingRef: GUIA,
    note: NOTA,
  });
  await mover(s, 'delivered', { happenedOn: dia(1) });
  await crearEnvio(op.operativo, {
    campaignInfluencerId: rios,
    items: [{ campaignProductId: op.productos.p80, quantity: 1 }],
    idempotencyKey: unico('envio'),
    shippingCost: COSTO_ENVIO,
    shippingCurrency: 'COP',
    piiRecordId: pii.record.recordId,
    note: NOTA,
  });
  await envio(gomez, op.productos.pro, 2);
  // Cuenta de cobro con monto, archivo y nota (dinero y evidencia que no deben salir).
  const seguimiento = exito(await obtenerSeguimientoDePago(op.operativo, rios))!;
  exito(
    await registrarDocumentoDeCobro(op.operativo, {
      paymentObligationId: seguimiento.obligation.id,
      documentNumber: 'DOC-SENT-001',
      issuedOn: dia(2),
      claimedAmount: COBRO,
      claimedCurrency: 'COP',
      archivo: archivoDePrueba(EVIDENCIA),
      idempotencyKey: unico('doc'),
      note: NOTA,
    }),
  );

  // Contenido (reelRios: V1 aprobada + V2 en revisión; storyRios: V1 recibida; reelGomez: V1 en revisión con
  // hallazgos y comentarios; reelDiego: V1 con cambios solicitados).
  const reelRios = await versionRevisada(op, undefined, {
    deliverableId: op.entregables.reelRios,
    participationId: rios,
  });
  exito(await aprobarDirecto(op.director, reelRios.versionId));
  const v2 = await versionNueva(op, op.entregables.reelRios, { participationId: rios });
  await revisarComoHumano(v2, op.consultor);
  VERSIONES['reelRios.v1'] = reelRios.versionId;
  VERSIONES['reelRios.v2'] = v2;
  VERSIONES['storyRios.v1'] = await versionNueva(op, op.entregables.storyRios, { participationId: rios });
  const reelGomez = await versionRevisada(op, undefined, {
    deliverableId: op.entregables.reelGomez,
    participationId: gomez,
  });
  VERSIONES['reelGomez.v1'] = reelGomez.versionId;
  exito(
    await crearComentarioDeRevision(op.consultor, reelGomez.versionId, {
      kind: 'editorial',
      body: COMENTARIO,
    }),
  );
  const reelDiego = await versionRevisada(op, undefined, {
    deliverableId: op.entregables.reelDiego,
    participationId: diego,
  });
  VERSIONES['reelDiego.v1'] = reelDiego.versionId;
  exito(await solicitarCambiosDeScript(op.consultor, reelDiego.versionId, { items: [{ body: HALLAZGO }] }));
  await revisarConIA(op, VERSIONES['storyRios.v1']!, [
    { category: 'cta_missing', refs: ['accion_kpis.accion_esperada'], description: HALLAZGO },
  ]).catch(() => undefined);

  // Participación retirada: no debe salir en ninguna lista.
  const r = await nuevaParticipacion('Retirada');
  retirada = r.id;
  exito(
    await crearEntregable(op.consultor, { campaignInfluencerId: retirada, label: 'Entregable de retirada' }),
  );
  exito(await retirarInfluencerDeCampana(op.admin, retirada, { motivo: 'prueba' }));

  // KPI de rios.
  const objetivo = async (extra: Record<string, unknown>) =>
    exito(
      await registrarKpiObjetivo(op.consultor, {
        campaignInfluencerId: rios,
        idempotencyKey: claveDePrueba('t'),
        ...extra,
      } as never),
    ).objetivo;
  const medir = async (extra: Record<string, unknown>) =>
    exito(
      await registrarMedicionKpi(op.operativo, {
        campaignInfluencerId: rios,
        observedAt: dia(1),
        idempotencyKey: claveDePrueba('m'),
        ...extra,
      } as never),
    ).medicion;
  await objetivo({ metric: 'views', targetValue: 100_000 });
  await objetivo({ metric: 'engagement_rate', targetValue: 4 });
  await objetivo({ metric: 'likes', targetValue: 500 });
  await objetivo({ metric: 'other', otherLabel: 'Menciones', targetValue: 3 });
  await objetivo({ metric: 'reach', targetValue: 1000, platform: 'tiktok' });
  const vistas = await medir({ metric: 'views', value: 85_000 });
  await medir({ metric: 'engagement_rate', value: 4.7 });
  await medir({ metric: 'other', otherLabel: 'Menciones', value: 3 });
  await medir({ metric: 'reach', value: 5000, platform: 'instagram' });
  exito(
    await corregirMedicionKpi(op.operativo, vistas.id, {
      value: 90_000,
      correctionReason: MOTIVO_KPI,
      idempotencyKey: claveDePrueba('c'),
    }),
  );

  // Documentos: compartido a propósito vs interno; guion aprobado compartido vs guion no aprobado.
  docTcl = await crearFuenteDePrueba(op.campanaId, op.admin, 'ficha-tecnica-tcl');
  docInterno = await crearFuenteDePrueba(op.campanaId, op.admin, 'documento-interno');
  exito(await setSourceVisibility(op.admin, docTcl, 'tcl'));
  const [guionAprobado] = await query<{ source_document_id: string }>(
    `SELECT source_document_id FROM script_versions WHERE id = $1`,
    [VERSIONES['reelRios.v1']],
  );
  docGuionAprobado = guionAprobado!.source_document_id;
  exito(await setSourceVisibility(op.admin, docGuionAprobado, 'tcl'));
  const [guionNoAprobado] = await query<{ source_document_id: string }>(
    `SELECT source_document_id FROM script_versions WHERE id = $1`,
    [VERSIONES['reelGomez.v1']],
  );
  docGuionNoAprobado = guionNoAprobado!.source_document_id;
  // El Sheet de influencers compartido a propósito (error humano): aun así NO se muestra como documento.
  await query(`UPDATE source_documents SET visibility = 'tcl' WHERE id = $1`, [sheetSourceId]);
}, 120_000);

afterAll(async () => {
  await limpiarEscenarioDeOperacion(op);
  await closePool();
});

// ═════════════════════════ 1 · Guard único y aislamiento ═════════════════════════

describe('guard único: rol cliente + capacidad + UUID + visibilidad + no cancelada', () => {
  it('la campaña visible se ve: lista, detalle y proyección completa', async () => {
    const lista = exito(await listarCampanasParaTcl(tcl));
    expect(lista.map((c) => c.id)).toEqual(expect.arrayContaining([op.campanaId, campanaB, campanaC]));
    const detalle = exito(await obtenerDetalleTclDeCampana(tcl, op.campanaId));
    expect(detalle.id).toBe(op.campanaId);
    expect(detalle.estado).toBe('en_curso');
    expect(codigo(await obtenerProyeccionTclDeCampana(tcl, op.campanaId))).toBe('OK');
  });

  it('la lista excluye la interna, la cancelada y la de otra agencia en `interna`', async () => {
    const ids = exito(await listarCampanasParaTcl(tcl)).map((c) => c.id);
    for (const prohibida of [internaId, canceladaId, op.campanaAjenaId]) expect(ids).not.toContain(prohibida);
  });

  it('toda campaña listada es visible (tcl | compartida) y no cancelada en la base', async () => {
    const ids = exito(await listarCampanasParaTcl(tcl)).map((c) => c.id);
    const filas = await query<{ visibility: string; status: string }>(
      `SELECT visibility::text, status::text FROM campaigns WHERE id = ANY($1::uuid[])`,
      [ids],
    );
    expect(filas.length).toBe(ids.length);
    for (const f of filas) {
      expect(['tcl', 'compartida']).toContain(f.visibility);
      expect(f.status).not.toBe('cancelada');
    }
  });

  const LECTURAS: ReadonlyArray<readonly [string, (a: User, id: string) => Promise<{ ok: boolean }>]> = [
    ['detalle', obtenerDetalleTclDeCampana],
    ['influencers', obtenerInfluencersParaTcl],
    ['contenido', obtenerContenidoParaTcl],
    ['brief', obtenerBriefParaTcl],
    ['operación', obtenerOperacionParaTcl],
    ['kpi', obtenerKpisParaTcl],
    ['documentos', obtenerDocumentosParaTcl],
    ['proyección', obtenerProyeccionTclDeCampana],
    ['export', (a, id) => exportarCampanaParaTcl(a, id, 'json')],
  ];

  it.each(LECTURAS)(
    '%s: campaña interna, cancelada, de otra agencia, inexistente y UUID inválido ⇒ el MISMO error 404',
    async (_nombre, lectura) => {
      for (const id of [
        internaId,
        op.otraCampanaId === campanaB ? internaId : op.otraCampanaId,
        canceladaId,
        op.campanaAjenaId,
        '00000000-0000-4000-8000-000000000000',
        'no-es-uuid',
        '',
        "' OR 1=1 --",
      ]) {
        const r = await lectura(tcl, id);
        expect(r.ok, id).toBe(false);
        expect(plano(r), id).toEqual(NO_ENCONTRADO_PLANO);
      }
    },
  );

  it('una campaña de OTRA agencia compartida (`compartida`) es visible por contrato; vuelta a `interna` ⇒ 404', async () => {
    await query(`UPDATE campaigns SET visibility = 'compartida' WHERE id = $1`, [op.campanaAjenaId]);
    try {
      expect(codigo(await obtenerDetalleTclDeCampana(tcl, op.campanaAjenaId))).toBe('OK');
      expect(exito(await listarCampanasParaTcl(tcl)).map((c) => c.id)).toContain(op.campanaAjenaId);
    } finally {
      await query(`UPDATE campaigns SET visibility = 'interna' WHERE id = $1`, [op.campanaAjenaId]);
    }
    expect(plano(await obtenerDetalleTclDeCampana(tcl, op.campanaAjenaId))).toEqual(NO_ENCONTRADO_PLANO);
  });

  it('una campaña que pasa a `interna` o a `cancelada` deja de verse al instante', async () => {
    const id = await campanaNueva('transitoria', 'tcl');
    expect(codigo(await obtenerDetalleTclDeCampana(tcl, id))).toBe('OK');
    await query(`UPDATE campaigns SET visibility = 'interna' WHERE id = $1`, [id]);
    expect((await obtenerDetalleTclDeCampana(tcl, id)).ok).toBe(false);
    await query(`UPDATE campaigns SET visibility = 'tcl', status = 'cancelada' WHERE id = $1`, [id]);
    expect((await obtenerDetalleTclDeCampana(tcl, id)).ok).toBe(false);
    await query(`UPDATE campaigns SET status = 'archivada' WHERE id = $1`, [id]);
    expect(exito(await obtenerDetalleTclDeCampana(tcl, id)).estado).toBe('finalizada');
  });

  it('todo rol que no es cliente (y el cliente inactivo) recibe el mismo 404 en TODAS las lecturas', async () => {
    const inactivo = { ...tcl, status: 'inactivo' } as unknown as User;
    for (const actor of [
      op.admin,
      op.director,
      op.consultor,
      op.operativo,
      op.analista,
      op.legal,
      op.ajeno,
      inactivo,
    ]) {
      for (const [nombre, lectura] of LECTURAS) {
        const r = await lectura(actor, op.campanaId);
        expect(plano(r), `${actor.role} ${nombre}`).toEqual(NO_ENCONTRADO_PLANO);
      }
      expect(plano(await listarCampanasParaTcl(actor)), actor.role).toEqual(NO_ENCONTRADO_PLANO);
    }
  });

  it('un cliente al que se le quita una capacidad recibe el mismo 404 (guard por capacidad, no solo por rol)', async () => {
    const sinExport = { ...tcl } as User;
    const original = roleCan('cliente', 'export:client');
    expect(original).toBe(true);
    // La capacidad se comprueba con `roleCan`: el guard directo lo demuestra con una capacidad que el cliente NO tiene.
    for (const capacidad of [
      'finance:read',
      'pii:read',
      'campaign:read',
      'brief:read',
      'kpi:read',
    ] as const) {
      expect(plano(await autorizarCampanaParaTcl(sinExport, op.campanaId, [capacidad])), capacidad).toEqual(
        NO_ENCONTRADO_PLANO,
      );
    }
  });
});

// ═════════════════════════ 2 · Lista y detalle ═════════════════════════════════

describe('lista y detalle de campañas', () => {
  it('claves exactas: sin owner, presupuesto, confidencialidad, visibilidad ni organización', async () => {
    const lista = exito(await listarCampanasParaTcl(tcl));
    const a = lista.find((c) => c.id === op.campanaId)!;
    expect(claves(a)).toEqual(esperadas('campanaLista'));
    const d = exito(await obtenerDetalleTclDeCampana(tcl, op.campanaId));
    expect(claves(d)).toEqual(esperadas('campanaDetalle'));
    expect(claves(d.conteos)).toEqual(esperadas('conteos'));
    for (const p of d.productos) expect(claves(p)).toEqual(esperadas('producto'));
    const texto = JSON.stringify([lista, d]);
    for (const prohibido of ['owner', 'budget', 'confidential', 'visibility', 'organization', op.admin.id]) {
      expect(texto.toLowerCase()).not.toContain(prohibido.toLowerCase());
    }
  });

  it('conteos y productos reales', async () => {
    const d = exito(await obtenerDetalleTclDeCampana(tcl, op.campanaId));
    expect(d.conteos).toMatchObject({
      influencersActivos: 3, // la retirada no cuenta
      guionesAprobados: 1,
      guionesTotales: 4,
      kpiTotales: 4, // views, engagement_rate, likes, reach (other no)
      kpiCumplidos: 1, // views (90 000 de 100 000) está por debajo; engagement_rate (4.7 ≥ 4) cumplido
    });
    expect(d.productos.map((p) => p.modelo).sort()).toEqual(['P80', 'P80 Pro']);
  });

  it('el estado interno colapsa a en_curso | finalizada', async () => {
    const detalles = exito(await listarCampanasParaTcl(tcl));
    for (const c of detalles) expect(['en_curso', 'finalizada']).toContain(c.estado);
  });
});

// ═════════════════════════ 3 · Influencers ═════════════════════════════════════

describe('influencers: sin PII, dinero, acuerdo ni identidad interna', () => {
  it('claves exactas y solo participaciones ACTIVAS', async () => {
    const lista = exito(await obtenerInfluencersParaTcl(tcl, op.campanaId));
    expect(lista.map((i) => i.participacionId).sort()).toEqual([rios, gomez, diego].sort());
    expect(lista.map((i) => i.participacionId)).not.toContain(retirada);
    for (const i of lista) {
      expect(claves(i)).toEqual(esperadas('influencer'));
      expect(claves(i.guion)).toEqual(esperadas('guion'));
      for (const c of i.cuentas) expect(claves(c)).toEqual(esperadas('cuenta'));
      for (const p of i.productos) expect(claves(p)).toEqual(esperadas('producto'));
      for (const k of i.kpis) expect(claves(k)).toEqual(esperadas('kpi'));
    }
  });

  it('nombre, cuentas y productos asignados; etapa, producto recibido y guion derivados', async () => {
    const lista = exito(await obtenerInfluencersParaTcl(tcl, op.campanaId));
    const r = lista.find((i) => i.participacionId === rios)!;
    expect(r.nombreVisible).toBe('Valentina Ríos');
    expect(r.cuentas).toEqual([expect.objectContaining({ plataforma: 'instagram' })]);
    expect(r.cuentas[0]!.handle).toContain('valentina.rios');
    expect(r.productos.map((p) => p.modelo)).toEqual(['P80']);
    expect(r.productoRecibido).toBe('parcial'); // 2 de 4 entregadas
    expect(r.etapa).toBe('en_curso');
    expect(r.guion).toEqual({ estado: 'parcial', aprobados: 1, total: 2 });
    const g = lista.find((i) => i.participacionId === gomez)!;
    expect(g.productoRecibido).toBe('no');
    expect(g.guion).toEqual({ estado: 'pendiente', aprobados: 0, total: 1 });
    const d = lista.find((i) => i.participacionId === diego)!;
    expect(d.etapa).toBe('pendiente');
    expect(d.productoRecibido).toBe('no');
  });

  it('ninguna clave ni valor de PII, dinero, acuerdo, logística fina o notas', async () => {
    const lista = exito(await obtenerInfluencersParaTcl(tcl, op.campanaId));
    sinSentinelas(lista);
    expect(clavesProhibidasEn(lista)).toEqual([]);
    const texto = sinUuids(lista).toLowerCase();
    for (const t of [
      'influencerid',
      'influencer_id',
      'agreement',
      'mixed',
      'barter',
      'compensation',
      'fee',
    ]) {
      expect(texto, t).not.toContain(t);
    }
  });
});

// ═════════════════════════ 4 · Contenido aprobado ══════════════════════════════

describe('contenido: solo el guion APROBADO vigente; nada interno', () => {
  it('claves exactas; reelRios aprobado con la fecha de la V1 (la V2 en revisión no la desplaza)', async () => {
    const lista = exito(await obtenerContenidoParaTcl(tcl, op.campanaId));
    // el entregable de la participación RETIRADA no sale
    expect(lista.map((c) => c.participacionId)).not.toContain(retirada);
    for (const c of lista) {
      expect(claves(c)).toEqual(esperadas('contenido'));
      expect(claves(c.entregable)).toEqual(esperadas('entregable'));
    }
    const porId = new Map(lista.map((c) => [c.entregable.id, c]));
    const reel = porId.get(op.entregables.reelRios)!;
    expect(reel.estado).toBe('aprobado');
    const [v1] = await query<{ approved_at: Date }>(`SELECT approved_at FROM script_versions WHERE id = $1`, [
      VERSIONES['reelRios.v1'],
    ]);
    expect(reel.aprobadoEl).toBe(v1!.approved_at.toISOString());
    // La V2 sigue en revisión y no es la visible.
    const [estadoV2] = await query<{ status: string }>(`SELECT status FROM script_versions WHERE id = $1`, [
      VERSIONES['reelRios.v2'],
    ]);
    expect(estadoV2!.status).toBe('in_review');
  });

  it('recibido, en revisión y con cambios solicitados ⇒ «pendiente» sin ningún rastro', async () => {
    const lista = exito(await obtenerContenidoParaTcl(tcl, op.campanaId));
    const porId = new Map(lista.map((c) => [c.entregable.id, c]));
    for (const id of [op.entregables.storyRios, op.entregables.reelGomez, op.entregables.reelDiego]) {
      expect(porId.get(id), id).toMatchObject({ estado: 'pendiente', aprobadoEl: null });
    }
    const texto = JSON.stringify(lista);
    for (const interno of ['received', 'in_review', 'changes_requested', 'superseded', 'draft', 'rechaz']) {
      expect(texto, interno).not.toContain(interno);
    }
  });

  it('hallazgos, comentarios de revisión, análisis y textos de guion ausentes', async () => {
    const p = exito(await obtenerProyeccionTclDeCampana(tcl, op.campanaId));
    sinSentinelas(p);
    const texto = JSON.stringify(p.contenido);
    for (const t of [
      'finding',
      'hallazgo',
      'comment',
      'comentario',
      'analysis',
      'ai_run',
      'Texto sintético',
    ]) {
      expect(texto.toLowerCase(), t).not.toContain(t.toLowerCase());
    }
  });
});

// ═════════════════════════ 5 · Brief ═══════════════════════════════════════════

describe('Brief: solo el aprobado vigente, por lista blanca de claves', () => {
  it('claves exactas; versión y fecha de aprobación; ES y EN vigente', async () => {
    const b = exito(await obtenerBriefParaTcl(tcl, op.campanaId))!;
    expect(claves(b)).toEqual(esperadas('brief'));
    expect(b.version).toBe(briefA.version);
    expect(b.idiomaOriginal).toBe('es');
    expect(b.representaciones.map((r) => r.idioma)).toEqual(['es', 'en']);
    for (const r of b.representaciones) {
      expect(claves(r)).toEqual(esperadas('briefRepresentacion'));
      for (const c of r.campos) expect(claves(c)).toEqual(esperadas('briefCampo'));
    }
    const es = b.representaciones[0]!.campos;
    const en = b.representaciones[1]!.campos;
    expect(es.find((c) => c.clave === 'mensaje_principal.tono')!.texto).toBe(
      'Cercano, aspiracional y directo',
    );
    expect(en.find((c) => c.clave === 'mensaje_principal.tono')!.texto).toBe(
      'EN: Cercano, aspiracional y directo',
    );
    // mandatorios como «categoría: descripción»; campos de producto con su producto
    expect(es.find((c) => c.clave === 'mandatorios')!.items).toEqual([
      'mensaje: Mencionar el hashtag #P80Pro en la publicación.',
      'legal: Incluir la etiqueta de publicidad al inicio del video.',
    ]);
    const rtbs = es.filter((c) => c.clave === 'marca_producto[].rtbs');
    expect(rtbs.map((c) => c.producto?.modelo).sort()).toEqual(['P80', 'P80 Pro']);
  });

  it('el presupuesto no sale; tampoco un campo con fee/dinero (se omite COMPLETO)', async () => {
    const b = exito(await obtenerBriefParaTcl(tcl, op.campanaId))!;
    const claves = b.representaciones.flatMap((r) => r.campos.map((c) => c.clave));
    expect(claves).not.toContain('practico.presupuesto');
    expect(claves).not.toContain('objetivo.negocio');
    // un campo en conflicto (sin resolver) tampoco
    expect(claves).not.toContain('objetivo.marca_comunicacion');
    expect(JSON.stringify(b)).not.toContain('CONFLICTO-SIN-RESOLVER');
    sinSentinelas(b);
    expect(JSON.stringify(b)).not.toMatch(/fee|5\.000\.000/u);
  });

  it('FUGA HISTÓRICA: un campo limpio derivado de un snapshot histórico (evidencia en el Sheet) NO sale', async () => {
    // El texto del campo es inocuo (el filtro de texto no lo detecta); lo bloquea la evidencia.
    const b = exito(await obtenerBriefParaTcl(tcl, op.campanaId))!;
    const todas = b.representaciones.flatMap((r) => r.campos);
    expect(todas.some((c) => c.clave === 'contexto.situacion')).toBe(false);
    expect(JSON.stringify(b)).not.toContain('Exclusividad total');
    // CONTROL: el campo existe en la base y el filtro de texto lo habría dejado pasar.
    const [campo] = await query<{ value: string }>(`SELECT value FROM brief_fields WHERE id = $1`, [
      briefA.campos['contexto.situacion'],
    ]);
    expect(campo!.value).toContain('Exclusividad total');
    // Y el fragmento histórico sí contiene el texto financiero en la base (no se lee por ningún camino).
    const [f] = await query<{ n: string }>(
      `SELECT count(*) AS n FROM source_fragments WHERE source_id = $1 AND text LIKE $2`,
      [sheetSourceId, `%${FEE_HIST}%`],
    );
    expect(Number(f!.n)).toBe(1);
  });

  it('un campo con evidencia de una fuente normal SÍ sale (la regla no sobre-excluye)', async () => {
    const b = exito(await obtenerBriefParaTcl(tcl, op.campanaId))!;
    expect(b.representaciones[0]!.campos.map((c) => c.clave)).toEqual(
      expect.arrayContaining(['mensaje_principal.one_line', 'mensaje_principal.mensaje_clave']),
    );
  });

  it('sin evidencias, procedencia ni revisión en la salida', async () => {
    const b = exito(await obtenerBriefParaTcl(tcl, op.campanaId))!;
    const texto = JSON.stringify(b).toLowerCase();
    for (const t of [
      'evidence',
      'evidencia',
      'quote',
      'filename',
      'provenance',
      'confidence',
      'reviewstatus',
      'locator',
    ]) {
      expect(texto, t).not.toContain(t);
    }
  });

  it('EN desactualizada (stale) NO se sirve; un hijo en borrador no desplaza al aprobado', async () => {
    const b = exito(await obtenerBriefParaTcl(tcl, campanaB))!;
    expect(b.version).toBe(briefB.version);
    expect(b.representaciones.map((r) => r.idioma)).toEqual(['es']);
    const tono = b.representaciones[0]!.campos.find((c) => c.clave === 'mensaje_principal.tono')!;
    expect(tono.texto).toBe('Tono del brief aprobado, ajustado');
    expect(JSON.stringify(b)).not.toContain('CAMBIO-EN-BORRADOR');
    // CONTROL: la EN existe y es stale en la base.
    const [s] = await query<{ state: string }>(
      `SELECT state FROM brief_translation_sync WHERE brief_version_id = $1 AND language = 'en' AND key = 'mensaje_principal.tono'`,
      [briefB.versionId],
    );
    expect(s!.state).toBe('stale');
  });

  it('solo borrador (o sin Brief) ⇒ brief null', async () => {
    expect(exito(await obtenerBriefParaTcl(tcl, campanaC))).toBeNull();
    const sinBrief = await campanaNueva('sin brief', 'tcl');
    expect(exito(await obtenerBriefParaTcl(tcl, sinBrief))).toBeNull();
  });

  it('el Brief servido coincide con el rector (misma definición de «vigente»)', async () => {
    const r = exito(await obtenerBriefRector(op.admin, op.campanaId));
    expect(exito(await obtenerBriefParaTcl(tcl, op.campanaId))!.version).toBe(r.number);
  });
});

// ═════════════════════════ 6 · Resumen operativo ═══════════════════════════════

describe('resumen operativo: etapa, producto recibido y guion; nada de dinero ni modo', () => {
  it('claves exactas y valores derivados', async () => {
    const lista = exito(await obtenerOperacionParaTcl(tcl, op.campanaId));
    expect(lista).toHaveLength(3);
    for (const o of lista) {
      expect(claves(o)).toEqual(esperadas('operacion'));
      expect(o.produccion).toBe('no_disponible');
      expect(o.publicacion).toBe('no_disponible');
    }
    const r = lista.find((o) => o.participacionId === rios)!;
    expect(r).toMatchObject({ etapa: 'en_curso', productoRecibido: 'parcial' });
    expect(lista.find((o) => o.participacionId === diego)).toMatchObject({ etapa: 'pendiente' });
  });

  it('sin fee, factura, pago, costos, PII ni modo barter/mixto/fee', async () => {
    const lista = exito(await obtenerOperacionParaTcl(tcl, op.campanaId));
    sinSentinelas(lista);
    expect(clavesProhibidasEn(lista)).toEqual([]);
    const texto = sinUuids(lista).toLowerCase();
    for (const t of [
      'fee',
      'barter',
      'mixed',
      'invoice',
      'factura',
      'payment',
      'pago',
      'cost',
      'pii',
      'shipping',
      'tracking',
    ]) {
      expect(texto, t).not.toContain(t);
    }
  });

  it('validar la factura y reportar el pago no cambia lo que TCL ve', async () => {
    const antes = exito(await obtenerOperacionParaTcl(tcl, op.campanaId));
    const s1 = exito(await obtenerSeguimientoDePago(op.operativo, rios))!;
    const doc = s1.documents[0]!;
    exito(
      await validarDocumento(op.operativo, {
        billingDocumentId: doc.id,
        expectedSeq: doc.rowSeq,
        idempotencyKey: unico('val'),
      }),
    );
    const s2 = exito(await obtenerSeguimientoDePago(op.operativo, rios))!;
    exito(
      await reportarPago(op.operativo, {
        paymentObligationId: s2.obligation.id,
        expectedSeq: s2.obligation.rowSeq,
        idempotencyKey: unico('pago'),
        paidOn: dia(0),
        externalReference: REFERENCIA,
      }),
    );
    expect(exito(await obtenerOperacionParaTcl(tcl, op.campanaId))).toEqual(antes);
    sinSentinelas(exito(await obtenerProyeccionTclDeCampana(tcl, op.campanaId)));
  });
});

// ═════════════════════════ 7 · KPI ═════════════════════════════════════════════

describe('KPI: objetivo, resultado y cumplimiento compatibles; `other` e `internal` no salen', () => {
  it('claves exactas y valores; la corrección vigente es el resultado', async () => {
    const lista = exito(await obtenerKpisParaTcl(tcl, op.campanaId));
    const r = lista.find((k) => k.participacionId === rios)!;
    expect(claves(r)).toEqual(esperadas('kpiPorParticipacion'));
    for (const k of r.kpis) expect(claves(k)).toEqual(esperadas('kpi'));
    const por = (m: string) => r.kpis.find((k) => k.metrica === m)!;
    expect(por('views')).toMatchObject({
      unidad: 'count',
      objetivo: 100_000,
      resultado: 90_000,
      cumplimiento: 90,
      estado: 'por_debajo',
    });
    expect(por('engagement_rate')).toMatchObject({ unidad: 'percent', resultado: 4.7, estado: 'cumplido' });
  });

  it('sin medición ⇒ solo objetivo; ámbito distinto (otra plataforma) ⇒ no se compara', async () => {
    const r = exito(await obtenerKpisParaTcl(tcl, op.campanaId)).find((k) => k.participacionId === rios)!;
    expect(r.kpis.find((k) => k.metrica === 'likes')).toMatchObject({
      objetivo: 500,
      resultado: null,
      cumplimiento: null,
      estado: 'sin_medicion',
      fecha: null,
    });
    expect(r.kpis.find((k) => k.metrica === 'reach')).toMatchObject({
      resultado: null,
      cumplimiento: null,
      estado: 'sin_medicion',
      plataforma: 'tiktok',
    });
  });

  it('la métrica `other` y todo el bloque `internal` (motivo, autor, procedencia) no salen', async () => {
    const lista = exito(await obtenerKpisParaTcl(tcl, op.campanaId));
    const r = lista.find((k) => k.participacionId === rios)!;
    expect(r.kpis.map((k) => k.metrica)).not.toContain('other');
    sinSentinelas(lista);
    const texto = JSON.stringify(lista);
    for (const t of [
      'Menciones',
      'correction',
      'recordedBy',
      'createdBy',
      'sheetProvenance',
      'targetId',
      'measurementId',
      'Usuario',
    ]) {
      expect(texto, t).not.toContain(t);
    }
  });

  it('paridad con `obtenerKpiDeParticipacion().public` (misma comparación y mismo orden)', async () => {
    const interno = exito(await obtenerKpiDeParticipacion(op.consultor, rios));
    const tclKpis = exito(await obtenerKpisParaTcl(tcl, op.campanaId)).find(
      (k) => k.participacionId === rios,
    )!.kpis;
    const esperado = interno.public
      .filter((k) => k.metric !== 'other')
      .map((k) => ({
        metrica: k.metric,
        objetivo: k.target,
        resultado: k.actual,
        cumplimiento: k.achievement,
        estado: k.estado === 'cumplido' || k.estado === 'por_debajo' ? k.estado : 'sin_medicion',
      }));
    expect(
      tclKpis.map((k) => ({
        metrica: k.metrica,
        objetivo: k.objetivo,
        resultado: k.resultado,
        cumplimiento: k.cumplimiento,
        estado: k.estado,
      })),
    ).toEqual(esperado);
    // y el resumen por campaña no se contradice con los conteos del detalle
    const resumen = exito(await obtenerResumenKpiDeCampana(op.consultor, op.campanaId));
    expect(resumen.get(rios)).toBeDefined();
  });

  it('el cliente no puede leer los KPI por los casos de uso internos', async () => {
    expect(codigo(await obtenerKpiDeParticipacion(tcl, rios))).toBe('RESOURCE_NOT_FOUND');
    expect(codigo(await obtenerResumenKpiDeCampana(tcl, op.campanaId))).toBe('RESOURCE_NOT_FOUND');
  });
});

// ═════════════════════════ 8 · Documentos ══════════════════════════════════════

describe('documentos: cada fuente se comparte a propósito', () => {
  it('visible solo la compartida; la interna, el guion no aprobado y el Sheet de influencers NO', async () => {
    const docs = exito(await obtenerDocumentosParaTcl(tcl, op.campanaId));
    for (const d of docs) expect(claves(d)).toEqual(esperadas('documento'));
    const ids = docs.map((d) => d.sourceId);
    expect(ids).toContain(docTcl);
    expect(ids).toContain(docGuionAprobado); // un guion APROBADO compartido a propósito sí es un documento
    for (const no of [docInterno, docGuionNoAprobado, sheetSourceId]) expect(ids, no).not.toContain(no);
  });

  it('la fuente de un guion NO aprobado no puede compartirse (la base lo impide) y por tanto no sale', async () => {
    const r = await setSourceVisibility(op.admin, docGuionNoAprobado, 'tcl');
    expect(codigo(r)).toBe('RESOURCE_CONFLICT');
    await expect(
      query(`UPDATE source_documents SET visibility = 'tcl' WHERE id = $1`, [docGuionNoAprobado]),
    ).rejects.toThrow(/no es la aprobada vigente/u);
    expect(exito(await obtenerDocumentosParaTcl(tcl, op.campanaId)).map((d) => d.sourceId)).not.toContain(
      docGuionNoAprobado,
    );
  });

  it('campaña visible NO sobreescribe la visibilidad de la fuente (interna ⇒ no sale)', async () => {
    const ids = exito(await obtenerDocumentosParaTcl(tcl, op.campanaId)).map((d) => d.sourceId);
    expect(ids).not.toContain(docInterno);
    // y la lectura legada por id sigue denegada para la interna
    const fuentes = exito(await listSources(tcl, op.campanaId));
    expect(fuentes.map((f) => f.id)).not.toContain(docInterno);
    expect(fuentes.map((f) => f.id)).toContain(docTcl);
  });

  it('sin hash, URLs, jobs, fragmentos, tamaño ni confidencialidad', async () => {
    const docs = exito(await obtenerDocumentosParaTcl(tcl, op.campanaId));
    const texto = JSON.stringify(docs).toLowerCase();
    for (const t of [
      'hash',
      'url',
      'job',
      'fragment',
      'size',
      'confidential',
      'mime',
      'storage',
      'file_id',
    ]) {
      expect(texto, t).not.toContain(t);
    }
    sinSentinelas(docs);
  });

  it('una fuente que pasa a `interna` desaparece; la de otra campaña no se mezcla', async () => {
    await query(`UPDATE source_documents SET visibility = 'interna' WHERE id = $1`, [docTcl]);
    expect(exito(await obtenerDocumentosParaTcl(tcl, op.campanaId)).map((d) => d.sourceId)).not.toContain(
      docTcl,
    );
    await query(`UPDATE source_documents SET visibility = 'tcl' WHERE id = $1`, [docTcl]);
    expect(exito(await obtenerDocumentosParaTcl(tcl, campanaB)).map((d) => d.sourceId)).not.toContain(docTcl);
  });

  it('un título con dinero se omite (null) pero el documento sigue existiendo', async () => {
    const id = await crearFuenteDePrueba(op.campanaId, op.admin, 'Cotizacion fee 5 millones');
    exito(await setSourceVisibility(op.admin, id, 'tcl'));
    const d = exito(await obtenerDocumentosParaTcl(tcl, op.campanaId)).find((x) => x.sourceId === id)!;
    expect(d.titulo).toBeNull();
  });
});

// ═════════════════════════ 9 · Export ══════════════════════════════════════════

describe('export: la MISMA proyección, columnas ⊆ DTO, sin financieros ni PII', () => {
  it('JSON = proyección (paridad EXPORT ⊆ UI)', async () => {
    const ui = exito(await obtenerProyeccionTclDeCampana(tcl, op.campanaId));
    const ex = exito(await exportarCampanaParaTcl(tcl, op.campanaId, 'json'));
    expect(ex.contentType).toBe('application/json; charset=utf-8');
    expect(JSON.parse(ex.contenido)).toEqual(JSON.parse(JSON.stringify(ui)));
    expect(ex.nombreDeArchivo).toMatch(/^tcl-[a-z0-9-]+\.json$/u);
  });

  it('claves de la proyección = lista blanca exacta (nivel raíz y anidadas)', async () => {
    const p = exito(await obtenerProyeccionTclDeCampana(tcl, op.campanaId));
    expect(claves(p)).toEqual(esperadas('proyeccion'));
    expect(claves(p.campana)).toEqual(esperadas('campanaDetalle'));
    for (const i of p.influencers) expect(claves(i)).toEqual(esperadas('influencer'));
    for (const c of p.contenido) expect(claves(c)).toEqual(esperadas('contenido'));
    for (const o of p.operacion) expect(claves(o)).toEqual(esperadas('operacion'));
    for (const k of p.kpis) expect(claves(k)).toEqual(esperadas('kpiPorParticipacion'));
    for (const d of p.documentos) expect(claves(d)).toEqual(esperadas('documento'));
    expect(clavesProhibidasEn(p)).toEqual([]);
  });

  it('CSV: BOM, encabezado ⊆ claves de DTO, una fila por elemento y sin sentinelas', async () => {
    const ui = exito(await obtenerProyeccionTclDeCampana(tcl, op.campanaId));
    const ex = exito(await exportarCampanaParaTcl(tcl, op.campanaId, 'csv'));
    expect(ex.contentType).toBe('text/csv; charset=utf-8');
    expect(ex.contenido.startsWith('\uFEFF')).toBe(true);
    const lineas = ex.contenido
      .slice(1)
      .split('\r\n')
      .filter((l) => l !== '');
    const encabezado = lineas[0]!.split(',');
    const conocidas = new Set<string>(Object.values(CLAVES_DE_DTO_TCL).flat());
    for (const col of encabezado) expect(col === 'seccion' || conocidas.has(col), col).toBe(true);
    const esperadoFilas =
      1 +
      ui.influencers.length +
      ui.contenido.length +
      ui.operacion.length +
      ui.kpis.reduce((s, k) => s + k.kpis.length, 0) +
      (ui.brief?.representaciones.reduce((s, r) => s + r.campos.length, 0) ?? 0) +
      ui.documentos.length;
    // (los campos con saltos de línea dentro de comillas no existen en estos datos)
    expect(lineas.length - 1).toBe(esperadoFilas);
    sinSentinelas(ex.contenido);
  });

  it('CSV: una celda que parece fórmula se neutraliza (nombre de influencer malicioso)', async () => {
    const mala = await nuevaParticipacion('=HYPERLINK');
    try {
      await query(`UPDATE influencers SET display_name = '=cmd|calc' WHERE id = $1`, [mala.influencerId]);
      const ex = exito(await exportarCampanaParaTcl(tcl, op.campanaId, 'csv'));
      expect(ex.contenido).toContain(`'=cmd|calc`);
      expect(ex.contenido).not.toMatch(/(^|,)=cmd/mu);
      const json = exito(await exportarCampanaParaTcl(tcl, op.campanaId, 'json'));
      expect(json.contenido).toContain('=cmd|calc'); // el JSON conserva el valor (no es una hoja de cálculo)
    } finally {
      exito(await retirarInfluencerDeCampana(op.admin, mala.id, { motivo: 'limpieza' }));
    }
  });

  it('formato inválido ⇒ VALIDATION_FAILED (solo tras autorizar); sin autorización ⇒ 404 aunque el formato sea inválido', async () => {
    expect(codigo(await exportarCampanaParaTcl(tcl, op.campanaId, 'xlsx'))).toBe('VALIDATION_FAILED');
    expect(plano(await exportarCampanaParaTcl(tcl, internaId, 'xlsx'))).toEqual(NO_ENCONTRADO_PLANO);
    expect(plano(await exportarCampanaParaTcl(op.admin, op.campanaId, 'csv'))).toEqual(NO_ENCONTRADO_PLANO);
  });

  it('exportar no escribe nada (sin auditoría ni filas nuevas)', async () => {
    const contar = async () =>
      Number(
        (
          await query<{ n: string }>(
            `SELECT (SELECT count(*) FROM audit_events WHERE entity_id = $1::uuid)
                  + (SELECT count(*) FROM script_versions WHERE campaign_id = $1::uuid) AS n`,
            [op.campanaId],
          )
        )[0]!.n,
      );
    const antes = await contar();
    exito(await exportarCampanaParaTcl(tcl, op.campanaId, 'csv'));
    exito(await exportarCampanaParaTcl(tcl, op.campanaId, 'json'));
    expect(await contar()).toBe(antes);
  });
});

// ═════════════════════════ 10 · Espía del pool ═════════════════════════════════

describe('espía del pool: la proyección NUNCA consulta tablas prohibidas', () => {
  const PROHIBIDAS = [
    'payment_obligations',
    'billing_documents',
    'influencer_pii_records',
    'content_findings',
    'content_analysis_runs',
    'field_comments',
    'script_review_comments',
    'ai_runs',
    'operational_events',
    'operational_evidence',
    'audit_events',
    'chat_messages',
    'chat_conversations',
    'proposed_actions',
  ];

  it('ninguna consulta de ninguna sección ni del export menciona una tabla prohibida', async () => {
    const pool = getPool();
    const original = pool.query.bind(pool) as (...a: unknown[]) => unknown;
    const sqls: string[] = [];
    const espia = vi.spyOn(pool, 'query').mockImplementation(((...args: unknown[]) => {
      const primero = args[0];
      sqls.push(typeof primero === 'string' ? primero : String((primero as { text?: string })?.text ?? ''));
      return original(...args);
    }) as never);
    try {
      exito(await listarCampanasParaTcl(tcl));
      exito(await obtenerProyeccionTclDeCampana(tcl, op.campanaId));
      exito(await obtenerProyeccionTclDeCampana(tcl, campanaB));
      exito(await exportarCampanaParaTcl(tcl, op.campanaId, 'csv'));
      exito(await exportarCampanaParaTcl(tcl, op.campanaId, 'json'));
      await obtenerDetalleTclDeCampana(tcl, internaId);
    } finally {
      espia.mockRestore();
    }
    expect(sqls.length).toBeGreaterThan(10);
    for (const sql of sqls) {
      for (const tabla of PROHIBIDAS) {
        expect(new RegExp(`\\b${tabla}\\b`, 'u').test(sql), `${tabla} en: ${sql.slice(0, 120)}`).toBe(false);
      }
      // jamás `SELECT *` ni columnas de PII
      expect(/select\s+\*/iu.test(sql), sql.slice(0, 80)).toBe(false);
    }
    // el acuerdo se consulta SOLO para las unidades comprometidas (nunca monto ni moneda)
    const delAcuerdo = sqls.filter((s) => /agreement_versions/u.test(s)).join('\n');
    expect(delAcuerdo).not.toMatch(/fee_amount|fee_currency|conditions/u);
  });

  it('el guard deniega ANTES de consultar secciones (rol interno: una sola consulta como máximo)', async () => {
    const pool = getPool();
    const original = pool.query.bind(pool) as (...a: unknown[]) => unknown;
    let n = 0;
    const espia = vi.spyOn(pool, 'query').mockImplementation(((...args: unknown[]) => {
      n += 1;
      return original(...args);
    }) as never);
    try {
      await obtenerProyeccionTclDeCampana(op.admin, op.campanaId);
      await obtenerProyeccionTclDeCampana(tcl, 'no-es-uuid');
    } finally {
      espia.mockRestore();
    }
    expect(n).toBe(0);
  });
});

// ═════════════════════════ 11 · Lecturas legadas y escrituras ══════════════════

describe('lecturas legadas del cliente: cerradas por capacidad', () => {
  const denegado = (r: { ok: boolean; error?: { code: string } }, nombre: string) => {
    expect(r.ok, nombre).toBe(false);
    expect(['FORBIDDEN_ROLE', 'RESOURCE_NOT_FOUND'], nombre).toContain(r.error?.code);
  };

  it('campaña, brief, versiones, campos, representaciones, rector y workspace ⇒ denegado', async () => {
    denegado(await listCampaigns(tcl), 'listCampaigns');
    denegado(await getCampaign(tcl, op.campanaId), 'getCampaign');
    denegado(await versionesDelBrief(tcl, op.campanaId), 'versionesDelBrief');
    denegado(await verCamposDeVersion(tcl, briefA.versionId), 'verCamposDeVersion');
    denegado(await obtenerVersionLogica(tcl, briefA.versionId), 'obtenerVersionLogica');
    denegado(await obtenerRepresentacion(tcl, briefA.versionId, 'es'), 'obtenerRepresentacion es');
    denegado(await obtenerRepresentacion(tcl, briefB.versionId, 'en'), 'obtenerRepresentacion en');
    denegado(await obtenerBriefWorkspace(tcl, op.campanaId), 'obtenerBriefWorkspace');
    denegado(await obtenerBriefRector(tcl, op.campanaId), 'obtenerBriefRector');
  });

  it('las capacidades que se retiraron son las que cierran la puerta (por capacidad, no por casualidad)', async () => {
    for (const retirada of ['campaign:read', 'brief:read', 'brief:export'] as const) {
      expect(roleCan('cliente', retirada), retirada).toBe(false);
    }
    expect(codigo(await listCampaigns(tcl))).toBe('FORBIDDEN_ROLE');
    expect(codigo(await versionesDelBrief(tcl, op.campanaId))).toBe('FORBIDDEN_ROLE');
    expect(codigo(await verCamposDeVersion(tcl, briefA.versionId))).toBe('FORBIDDEN_ROLE');
    expect(codigo(await obtenerVersionLogica(tcl, briefA.versionId))).toBe('FORBIDDEN_ROLE');
  });

  it('un versionId arbitrario (incluida una versión en borrador o una EN stale) no se lee', async () => {
    const hijo = (
      await query<{ id: string }>(`SELECT id FROM brief_versions WHERE brief_id = $1 AND status = 'draft'`, [
        briefB.briefId,
      ])
    )[0]!.id;
    for (const v of [hijo, briefB.versionId, briefA.versionId, '00000000-0000-4000-8000-000000000000']) {
      denegado(await verCamposDeVersion(tcl, v), `campos ${v}`);
      denegado(await obtenerRepresentacion(tcl, v, 'en'), `representación ${v}`);
    }
  });
});

describe('escrituras: el cliente no puede mutar con ningún caso de uso interno', () => {
  async function contadores(): Promise<Record<string, number>> {
    const tablas: Array<[string, string]> = [
      ['deliverables', 'campaign_id'],
      ['script_versions', 'campaign_id'],
      ['agreements', 'campaign_id'],
      ['shipments', 'campaign_id'],
      ['kpi_targets', 'campaign_id'],
      ['kpi_measurements', 'campaign_id'],
      ['campaign_influencers', 'campaign_id'],
      ['source_documents', 'campaign_id'],
      ['proposed_actions', 'campaign_id'],
    ];
    const salida: Record<string, number> = {};
    for (const [t, col] of tablas) {
      const [f] = await query<{ n: string }>(`SELECT count(*) AS n FROM ${t} WHERE ${col} = $1`, [
        op.campanaId,
      ]);
      salida[t] = Number(f!.n);
    }
    const [c] = await query<{ visibility: string; status: string; name: string }>(
      `SELECT visibility::text, status::text, name FROM campaigns WHERE id = $1`,
      [op.campanaId],
    );
    salida['campana'] = JSON.stringify(c).length;
    return salida;
  }

  it('crear, aprobar, solicitar, registrar, enviar, medir, cobrar, subir, compartir y archivar ⇒ denegados y sin efecto', async () => {
    const antes = await contadores();
    const [fuente] = await query<{ id: string }>(
      `SELECT id FROM source_documents WHERE campaign_id = $1 AND type::text <> 'soporte_operativo' LIMIT 1`,
      [op.campanaId],
    );
    const intentos: Array<[string, () => Promise<{ ok: boolean; error?: { code: string } }>]> = [
      ['crearEntregable', () => crearEntregable(tcl, { campaignInfluencerId: rios, label: 'Intento' })],
      [
        'registrarVersionDeGuion',
        () =>
          registrarVersionDeGuion(tcl, {
            campaignId: op.campanaId,
            sourceId: fuente!.id,
            participation: { participationId: rios },
            deliverable: { id: op.entregables.reelRios },
          }),
      ],
      ['aprobarScriptVersion', () => aprobarDirecto(tcl, VERSIONES['reelRios.v2']!)],
      [
        'solicitarCambiosDeScript',
        () => solicitarCambiosDeScript(tcl, VERSIONES['reelRios.v2']!, { items: [{ body: 'x' }] }),
      ],
      [
        'crearComentarioDeRevision',
        () => crearComentarioDeRevision(tcl, VERSIONES['reelRios.v2']!, { kind: 'editorial', body: 'x' }),
      ],
      [
        'crearAcuerdo',
        () =>
          crearAcuerdo(tcl, {
            campaignInfluencerId: diego,
            compensationType: 'fee',
            feeAmount: 1,
            feeCurrency: 'COP',
            commitments: [],
            idempotencyKey: unico('x'),
          }),
      ],
      [
        'crearEnvio',
        () =>
          crearEnvio(tcl, {
            campaignInfluencerId: rios,
            items: [{ campaignProductId: op.productos.p80, quantity: 1 }],
            idempotencyKey: unico('x'),
          }),
      ],
      [
        'registrarKpiObjetivo',
        () =>
          registrarKpiObjetivo(tcl, {
            campaignInfluencerId: rios,
            metric: 'saves',
            targetValue: 10,
            idempotencyKey: unico('x'),
          }),
      ],
      [
        'registrarMedicionKpi',
        () =>
          registrarMedicionKpi(tcl, {
            campaignInfluencerId: rios,
            metric: 'views',
            value: 1,
            observedAt: dia(1),
            idempotencyKey: unico('x'),
          }),
      ],
      [
        'guardarPii',
        () =>
          guardarPii(tcl, { influencerId: op.influencerIds[0]!, documentId: '123456', phone: '3001234567' }),
      ],
      [
        'uploadSource',
        () =>
          uploadSource(tcl, {
            campaignId: op.campanaId,
            filename: 'x.md',
            mimeType: 'text/markdown',
            contenido: new TextEncoder().encode('hola mundo'),
            type: 'otro',
          } as never),
      ],
      ['setSourceVisibility', () => setSourceVisibility(tcl, docInterno, 'tcl')],
      ['archiveCampaign', () => archiveCampaign(tcl, op.campanaId)],
      [
        'createCampaign',
        () =>
          createCampaign(tcl, {
            name: 'Intento',
            ownerId: tcl.id,
            productos: [{ productId: op.productos.p80 }],
          }),
      ],
      [
        'asociarInfluencerACampana',
        () =>
          asociarInfluencerACampana(tcl, { campaignId: op.campanaId, influencerId: op.influencerIds[0]! }),
      ],
      ['retirarInfluencerDeCampana', () => retirarInfluencerDeCampana(tcl, diego)],
    ];
    for (const [nombre, intento] of intentos) {
      let r: { ok: boolean; error?: { code: string } };
      try {
        r = await intento();
      } catch (e) {
        throw new Error(`${nombre} lanzó en lugar de denegar: ${(e as Error).message}`);
      }
      expect(r.ok, nombre).toBe(false);
      expect(['FORBIDDEN_ROLE', 'RESOURCE_NOT_FOUND', 'HUMAN_CONFIRMATION_REQUIRED'], nombre).toContain(
        r.error?.code,
      );
    }
    expect(await contadores()).toEqual(antes);
  });

  it('el pago nunca lo reporta el cliente', async () => {
    const seguimiento = exito(await obtenerSeguimientoDePago(op.operativo, rios))!;
    const r = await reportarPago(tcl, {
      paymentObligationId: seguimiento.obligation.id,
      expectedSeq: seguimiento.obligation.rowSeq,
      idempotencyKey: unico('x'),
    } as never);
    expect(r.ok).toBe(false);
    void claveDePrueba;
  });
});

// ═════════════════════════ 12 · Guion superado (al final: cambia el estado de Diego) ═══

describe('contenido: versión superada', () => {
  it('un guion superado por una versión nueva aprobada muestra la vigente (aprobada)', async () => {
    const entregable = exito(
      await crearEntregable(op.consultor, { campaignInfluencerId: diego, label: `Superado ${unico('s')}` }),
    ).id;
    const v1 = await versionRevisada(op, undefined, { deliverableId: entregable, participationId: diego });
    exito(await aprobarDirecto(op.director, v1.versionId));
    // La fuente del guion aprobado V1 se comparte a propósito con TCL…
    const [fuenteV1] = await query<{ source_document_id: string }>(
      `SELECT source_document_id FROM script_versions WHERE id = $1`,
      [v1.versionId],
    );
    exito(await setSourceVisibility(op.admin, fuenteV1!.source_document_id, 'tcl'));
    expect(exito(await obtenerDocumentosParaTcl(tcl, op.campanaId)).map((d) => d.sourceId)).toContain(
      fuenteV1!.source_document_id,
    );
    // …y al ser reemplazada por una versión aprobada nueva ya NO es «el guion aprobado vigente»: la base devuelve
    // su fuente a `interna` (migración 023) y la proyección además la excluye por su cuenta (defensa en profundidad).
    const v2 = await otraVersionRevisada(op, entregable);
    exito(await aprobarDirecto(op.director, v2.versionId));
    const [visibilidadV1] = await query<{ visibility: string }>(
      `SELECT visibility::text FROM source_documents WHERE id = $1`,
      [fuenteV1!.source_document_id],
    );
    expect(visibilidadV1!.visibility).toBe('interna');
    expect(exito(await obtenerDocumentosParaTcl(tcl, op.campanaId)).map((d) => d.sourceId)).not.toContain(
      fuenteV1!.source_document_id,
    );
    const [filas] = await query<{ status: string }>(`SELECT status FROM script_versions WHERE id = $1`, [
      v1.versionId,
    ]);
    expect(filas!.status).toBe('superseded');
    const c = exito(await obtenerContenidoParaTcl(tcl, op.campanaId)).find(
      (x) => x.entregable.id === entregable,
    )!;
    expect(c.estado).toBe('aprobado');
    const [vigente] = await query<{ approved_at: Date }>(
      `SELECT approved_at FROM script_versions WHERE id = $1`,
      [v2.versionId],
    );
    expect(c.aprobadoEl).toBe(vigente!.approved_at.toISOString());
  });
});
