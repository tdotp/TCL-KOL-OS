/**
 * Apoyo SOLO de pruebas del QA adversarial F10: siembra una campaña de SmartPR con un dato «con centinela» en
 * cada superficie (campaña, fuente, fragmento, Brief, guion, acuerdo, envío, KPI, PII, chat, propuesta) para que
 * cualquier fuga —a otra organización, a TCL o a un actor sin permiso— sea una cadena detectable.
 */
import type { User } from '@tcl-kol-os/domain';
import * as db from './index.ts';
import { query } from './client.ts';
import { crearComentarioDeRevision } from './script-review.ts';
import { crearConversacion } from './chat-conversations.ts';
import { publicarMensaje } from './chat-messages.ts';
import { crearEnvio } from './shipments.ts';
import { guardarPii } from './pii.ts';
import { proponerAccion } from './proposed-actions.ts';
import { registrarKpiObjetivo } from './kpi-targets.ts';
import { registrarMedicionKpi } from './kpi-measurements.ts';
import { unico } from './ops-test-support.ts';
import { aprobarDirecto, versionNueva, versionRevisada } from './script-approval-test-support.ts';
import {
  type EscenarioDeOperacion,
  claveDePrueba,
  crearAcuerdoDePrueba,
  crearBriefAprobadoDePrueba,
  crearFragmentoDePrueba,
  crearFuenteDePrueba,
  CONFIG_DE_RUN_DE_PRUEBA,
} from './test-utils.ts';

export const C = {
  campana: 'QAF10-CAMPANA-SECRETA',
  fuente: 'QAF10-FUENTE-SECRETA',
  fragmento: 'QAF10-FRAGMENTO-SECRETO',
  brief: 'QAF10-BRIEF-SECRETO',
  guion: 'QAF10-GUION-SECRETO',
  condiciones: 'QAF10-CONDICIONES-SECRETAS',
  feeCifra: '7351842',
  telefono: '3159876543',
  direccion: 'QAF10-DIRECCION-SECRETA-calle-99',
  documento: '1098765432',
  comentario: 'QAF10-COMENTARIO-SECRETO',
  kpiOtro: 'QAF10-KPI-OTRO',
  mensajeChat: 'QAF10-MENSAJE-CHAT-SECRETO',
} as const;

/** Todo texto que NO debe salir nunca hacia otra organización. */
export const CENTINELAS_INTERNOS: readonly string[] = [
  C.campana,
  C.fuente,
  C.fragmento,
  C.brief,
  C.guion,
  C.condiciones,
  C.feeCifra,
  C.telefono,
  C.direccion,
  C.documento,
  C.comentario,
  C.mensajeChat,
];

export interface Sembrado {
  readonly campanaId: string;
  readonly fuenteId: string;
  readonly fragmentoId: string;
  readonly briefVersionId: string;
  readonly briefFieldId: string;
  readonly guionAprobadoId: string;
  readonly guionBorradorId: string;
  readonly guionPropuestoId: string;
  readonly entregableId: string;
  readonly participacionId: string;
  readonly participacionBarterId: string;
  readonly influencerId: string;
  readonly piiRecordId: string;
  readonly acuerdoId: string;
  readonly obligacionId: string;
  readonly obligacionBarterId: string;
  readonly envioId: string;
  readonly objetivoKpiId: string;
  readonly medicionKpiId: string;
  readonly accionId: string;
  readonly conversacionId: string;
  readonly comentarioId: string;
  readonly ids: Readonly<Record<string, string>>;
}

/** Siembra la campaña `op.campanaId` (de SmartPR) con centinelas. NO la hace visible a TCL. */
export async function sembrarSmartPR(op: EscenarioDeOperacion): Promise<Sembrado> {
  const { admin, consultor, operativo, director } = op;
  await query(`UPDATE campaigns SET name = $2 WHERE id = $1`, [op.campanaId, `${C.campana} ${op.sufijo}`]);

  const fuenteId = await crearFuenteDePrueba(op.campanaId, admin, C.fuente);
  await query(`UPDATE source_documents SET filename = $2 WHERE id = $1`, [fuenteId, `${C.fuente}.pdf`]);
  await crearFragmentoDePrueba(fuenteId, 1, C.fragmento);
  const [frag] = await query<{ id: string }>(`SELECT id FROM source_fragments WHERE source_id = $1 LIMIT 1`, [
    fuenteId,
  ]);

  const brief = await crearBriefAprobadoDePrueba(op.campanaId, admin, {
    productos: [op.productos.p80],
    valores: { 'mensaje_principal.one_line': `${C.brief} El P80 Pro lleva tu fotografía a otro nivel.` },
  });
  const briefFieldId = Object.values(brief.campos)[0]!;

  const acuerdoFee = await crearAcuerdoDePrueba(admin, {
    campaignInfluencerId: op.participaciones.valentinaRios,
    mode: 'fee',
    amount: C.feeCifra,
    conditions: C.condiciones,
  });
  const acuerdoBarter = await crearAcuerdoDePrueba(admin, {
    campaignInfluencerId: op.participaciones.valentinaGomez,
    mode: 'barter',
    campaignProductId: op.productos.pro,
    quantity: 2,
  });
  const [oblFee] = await query<{ id: string }>(`SELECT id FROM payment_obligations WHERE agreement_id = $1`, [
    acuerdoFee.id,
  ]);
  const [oblBarter] = await query<{ id: string }>(
    `SELECT id FROM payment_obligations WHERE agreement_id = $1`,
    [acuerdoBarter.id],
  );

  const revisada = await versionRevisada(op, undefined, {
    deliverableId: op.entregables.reelRios,
    participationId: op.participaciones.valentinaRios,
  });
  const aprobada = await aprobarDirecto(director, revisada.versionId);
  if (!aprobada.ok) throw new Error(`sembrar guion aprobado: ${aprobada.error.code}`);
  const borrador = await versionNueva(op, op.entregables.reelGomez, {
    participationId: op.participaciones.valentinaGomez,
    fragmentos: [`${C.guion} borrador interno`],
  });

  const comentario = await crearComentarioDeRevision(consultor, borrador, {
    kind: 'editorial',
    body: C.comentario,
  });
  if (!comentario.ok) throw new Error(`sembrar comentario: ${comentario.error.code}`);
  const comentarioId = comentario.value.comment.id;

  const envio = await crearEnvio(operativo, {
    campaignInfluencerId: op.participaciones.valentinaGomez,
    items: [{ campaignProductId: op.productos.pro, quantity: 1 }],
    idempotencyKey: unico('f10-envio'),
  });
  if (!envio.ok) throw new Error(`sembrar envío: ${envio.error.code}`);

  const objetivo = await registrarKpiObjetivo(consultor, {
    campaignInfluencerId: op.participaciones.valentinaRios,
    metric: 'views',
    targetValue: 10_000,
    idempotencyKey: claveDePrueba('f10t'),
  });
  if (!objetivo.ok) throw new Error(`sembrar objetivo: ${objetivo.error.code}`);
  const medicion = await registrarMedicionKpi(operativo, {
    campaignInfluencerId: op.participaciones.valentinaRios,
    metric: 'views',
    value: 12_345,
    observedAt: new Date(Date.now() - 86_400_000).toISOString(),
    idempotencyKey: claveDePrueba('f10m'),
  });
  if (!medicion.ok) throw new Error(`sembrar medición: ${medicion.error.code}`);

  const [infl] = await query<{ influencer_id: string }>(
    `SELECT influencer_id FROM campaign_influencers WHERE id = $1`,
    [op.participaciones.valentinaRios],
  );
  const pii = await guardarPii(operativo, {
    influencerId: infl!.influencer_id,
    documentId: C.documento,
    phone: C.telefono,
    address: C.direccion,
  });
  if (!pii.ok) throw new Error(`sembrar PII: ${pii.error.code}`);

  const conv = await crearConversacion(consultor, { campaignId: op.campanaId });
  if (!conv.ok) throw new Error(`sembrar conversación: ${conv.error.code}`);
  const mensaje = await publicarMensaje(consultor, {
    conversationId: conv.value.id,
    clientMessageId: unico('f10-msg-xxxxxxxx'),
    content: C.mensajeChat,
    runConfig: CONFIG_DE_RUN_DE_PRUEBA,
  });
  if (!mensaje.ok) throw new Error(`sembrar mensaje: ${mensaje.error.code}`);

  const paraProponer = await versionRevisada(op);
  const accion = await proponerAccion(consultor, {
    type: 'script_version.approve',
    resourceId: paraProponer.versionId,
    origin: 'chat',
    campaignId: op.campanaId,
  });
  if (!accion.ok) throw new Error(`sembrar propuesta: ${accion.error.code}`);

  const ids = {
    campana: op.campanaId,
    otraCampana: op.otraCampanaId,
    fuente: fuenteId,
    fragmento: frag!.id,
    briefVersion: brief.versionId,
    brief: brief.briefId,
    briefField: briefFieldId,
    guionAprobado: revisada.versionId,
    guionBorrador: borrador,
    guionPropuesto: paraProponer.versionId,
    entregable: op.entregables.reelRios,
    entregableBorrador: op.entregables.reelGomez,
    participacion: op.participaciones.valentinaRios,
    participacionBarter: op.participaciones.valentinaGomez,
    influencer: infl!.influencer_id,
    piiRecord: pii.value.record.recordId,
    acuerdo: acuerdoFee.id,
    acuerdoBarter: acuerdoBarter.id,
    obligacion: oblFee!.id,
    obligacionBarter: oblBarter!.id,
    envio: envio.value.envio.id,
    objetivo: objetivo.value.objetivo.id,
    medicion: medicion.value.medicion.id,
    accion: accion.value.id,
    conversacion: conv.value.id,
    comentario: comentarioId,
    usuario: admin.id,
    producto: op.productos.p80,
  };
  return {
    campanaId: op.campanaId,
    fuenteId,
    fragmentoId: frag!.id,
    briefVersionId: brief.versionId,
    briefFieldId,
    guionAprobadoId: revisada.versionId,
    guionBorradorId: borrador,
    guionPropuestoId: paraProponer.versionId,
    entregableId: op.entregables.reelRios,
    participacionId: op.participaciones.valentinaRios,
    participacionBarterId: op.participaciones.valentinaGomez,
    influencerId: infl!.influencer_id,
    piiRecordId: pii.value.record.recordId,
    acuerdoId: acuerdoFee.id,
    obligacionId: oblFee!.id,
    obligacionBarterId: oblBarter!.id,
    envioId: envio.value.envio.id,
    objetivoKpiId: objetivo.value.objetivo.id,
    medicionKpiId: medicion.value.medicion.id,
    accionId: accion.value.id,
    conversacionId: conv.value.id,
    comentarioId,
    ids: Object.fromEntries(Object.entries(ids).filter(([, v]) => v !== '')),
  };
}

/** Huella (md5 por tabla) de TODO lo que cuelga de una campaña u organización: detecta cualquier escritura. */
export async function huellaDeCampana(campaignId: string, organizationId: string): Promise<string> {
  const tablas = await query<{ table_name: string; col: string }>(
    `SELECT table_name, column_name AS col
       FROM information_schema.columns
      WHERE table_schema = 'public' AND column_name IN ('campaign_id')
        AND table_name NOT IN ('audit_events')
      ORDER BY table_name`,
  );
  const partes: string[] = [];
  for (const t of tablas) {
    const [fila] = await query<{ h: string }>(
      `SELECT md5(coalesce(string_agg(x::text, '|' ORDER BY x::text), '')) AS h FROM ${t.table_name} x
        WHERE x.${t.col} = $1`,
      [campaignId],
    );
    partes.push(`${t.table_name}:${fila!.h}`);
  }
  const [a] = await query<{ n: string }>(
    `SELECT count(*)::text AS n FROM audit_events WHERE organization_id = $1`,
    [organizationId],
  );
  partes.push(`audit:${a!.n}`);
  return partes.join('\n');
}

/** Un mutador por caso de uso, con ids REALES de SmartPR y argumentos válidos: lo que haría un atacante. */
export function escriturasDe(A: User, s: Sembrado): Array<[string, () => Promise<unknown>]> {
  const ahora = (): string => new Date(Date.now() - 3_600_000).toISOString();
  const hoy = (): string => new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  return [
    [
      'aprobarScriptVersion',
      () => db.aprobarScriptVersion(A, s.guionBorradorId, { huellaVista: 'a'.repeat(64) }),
    ],
    [
      'crearComentarioDeRevision',
      () => db.crearComentarioDeRevision(A, s.guionBorradorId, { kind: 'editorial', body: 'x'.repeat(10) }),
    ],
    [
      'solicitarCambiosDeScript',
      () =>
        db.solicitarCambiosDeScript(A, s.guionBorradorId, {
          cambios: [{ body: 'cambio qa f10' }],
        } as never),
    ],
    [
      'registrarVersionDeGuion',
      () =>
        db.registrarVersionDeGuion(A, {
          campaignId: s.campanaId,
          sourceId: s.fuenteId,
          participation: { participationId: s.participacionId },
          deliverable: { id: s.entregableId },
        }),
    ],
    [
      'crearEntregable',
      () =>
        db.crearEntregable(A, {
          campaignInfluencerId: s.participacionId,
          label: 'qa-f10',
          platform: 'instagram',
        }),
    ],
    ['archivarEntregable', () => db.archivarEntregable(A, s.entregableId)],
    ['registrarRevisionHumana', () => db.registrarRevisionHumana(A, s.guionBorradorId, {})],
    [
      'solicitarAnalisisDeGuion',
      () =>
        db.solicitarAnalisisDeGuion(A, s.guionBorradorId, {
          mode: 'reanalyze',
          idempotencyKey: claveDePrueba('qa'),
        }),
    ],
    [
      'reportarPago',
      () =>
        db.reportarPago(A, {
          participacionId: s.participacionId,
          paymentObligationId: s.obligacionId,
          expectedSeq: 1,
          paidOn: hoy(),
          externalReference: 'REF-QA-F10',
          idempotencyKey: unico('qa'),
        } as never),
    ],
    [
      'cancelarObligacionDePago',
      () =>
        db.cancelarObligacionDePago(A, {
          paymentObligationId: s.obligacionId,
          expectedSeq: 1,
          reason: 'qa',
          idempotencyKey: unico('qa'),
        } as never),
    ],
    [
      'registrarMedicionKpi',
      () =>
        db.registrarMedicionKpi(A, {
          campaignInfluencerId: s.participacionId,
          metric: 'views',
          value: 1,
          observedAt: ahora(),
          idempotencyKey: claveDePrueba('qa'),
        }),
    ],
    [
      'corregirMedicionKpi',
      () =>
        db.corregirMedicionKpi(A, s.medicionKpiId, {
          value: 1,
          correctionReason: 'qa f10',
          idempotencyKey: claveDePrueba('qa'),
        }),
    ],
    [
      'registrarKpiObjetivo',
      () =>
        db.registrarKpiObjetivo(A, {
          campaignInfluencerId: s.participacionId,
          metric: 'views',
          targetValue: 1,
          idempotencyKey: claveDePrueba('qa'),
        }),
    ],
    [
      'retirarKpiObjetivo',
      () => db.retirarKpiObjetivo(A, s.objetivoKpiId, { idempotencyKey: claveDePrueba('qa') } as never),
    ],
    [
      'crearAcuerdo',
      () =>
        db.crearAcuerdo(A, {
          campaignInfluencerId: s.participacionId,
          compensationType: 'fee',
          feeAmount: 1,
          feeCurrency: 'COP',
          commitments: [],
          idempotencyKey: claveDePrueba('qa'),
        }),
    ],
    [
      'registrarVersionDeAcuerdo',
      () =>
        db.registrarVersionDeAcuerdo(A, s.acuerdoId, {
          compensationType: 'fee',
          feeAmount: 1,
          feeCurrency: 'COP',
          commitments: [],
          expectedSeq: 1,
          idempotencyKey: claveDePrueba('qa'),
        } as never),
    ],
    [
      'cancelarAcuerdo',
      () =>
        db.cancelarAcuerdo(A, s.acuerdoId, {
          expectedSeq: 1,
          reason: 'qa',
          idempotencyKey: claveDePrueba('qa'),
        } as never),
    ],
    [
      'crearEnvio',
      () =>
        db.crearEnvio(A, {
          campaignInfluencerId: s.participacionId,
          items: [{ campaignProductId: s.ids['producto']!, quantity: 1 }],
          idempotencyKey: unico('qa'),
        }),
    ],
    [
      'transicionarEnvio',
      () =>
        db.transicionarEnvio(A, {
          shipmentId: s.envioId,
          to: 'prepared',
          expectedSeq: 1,
          idempotencyKey: unico('qa'),
        }),
    ],
    [
      'guardarPii',
      () => db.guardarPii(A, { influencerId: s.influencerId, phone: '3000000000', documentId: '1000000001' }),
    ],
    ['setSourceVisibility', () => db.setSourceVisibility(A, s.fuenteId, 'tcl')],
    ['retrySource', () => db.retrySource(A, s.fuenteId)],
    ['aprobarBrief', () => db.aprobarBrief(A, s.briefVersionId)],
    ['solicitarCambiosInternos', () => db.solicitarCambiosInternos(A, s.briefVersionId, 'qa' as never)],
    ['transicionarBrief', () => db.transicionarBrief(A, s.briefVersionId, 'internal_review')],
    ['crearVersionHija', () => db.crearVersionHija(A, s.briefVersionId)],
    ['confirmarCampo', () => db.confirmarCampo(A, s.briefVersionId, s.briefFieldId, { revisionEsperada: 1 })],
    [
      'corregirCampo',
      () => db.corregirCampo(A, s.briefVersionId, s.briefFieldId, { value: 'qa', revisionEsperada: 1 }),
    ],
    ['archiveCampaign', () => db.archiveCampaign(A, s.campanaId)],
    ['actualizarCampana', () => db.actualizarCampana(A, s.campanaId, { name: 'QA-F10-HIJACK' } as never)],
    [
      'asociarInfluencerACampana',
      () => db.asociarInfluencerACampana(A, { campaignId: s.campanaId, influencerId: s.influencerId }),
    ],
    ['retirarInfluencerDeCampana', () => db.retirarInfluencerDeCampana(A, s.participacionId)],
    [
      'proponerAccion (chat)',
      () =>
        db.proponerAccion(A, {
          type: 'script_version.approve',
          resourceId: s.guionBorradorId,
          origin: 'chat',
          campaignId: s.campanaId,
        }),
    ],
    [
      'confirmarAccion',
      () => db.confirmarAccion(A, s.accionId, { canal: 'ui', payloadHash: 'a'.repeat(64) }),
    ],
    ['ejecutarAccion', () => db.ejecutarAccion(A, s.accionId, { canal: 'ui' })],
    ['cancelarAccion', () => db.cancelarAccion(A, s.accionId)],
    ['crearConversacion (campaña ajena)', () => db.crearConversacion(A, { campaignId: s.campanaId })],
    [
      'publicarMensaje (conversación ajena)',
      () =>
        db.publicarMensaje(A, {
          conversationId: s.conversacionId,
          clientMessageId: unico('qa-msg-xxxxxxxx'),
          content: 'hola desde otra agencia',
          runConfig: {
            provider: 'x',
            model: 'x',
            tier: 'equilibrado',
            promptVersion: 'x',
            contextVersion: 'x',
          } as never,
        }),
    ],
    ['archivarConversacion', () => db.archivarConversacion(A, s.conversacionId)],
  ];
}
