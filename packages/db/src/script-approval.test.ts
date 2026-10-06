/**
 * V2 · Fase 7 — aprobación de guiones (`script-approval.ts`), contra PostgreSQL real (migraciones 023–024).
 *
 * Cubre la aprobación DIRECTA de una persona (admin/director, canal `ui`, con la huella que vio), la regla
 * de negocio (aprobar exige una revisión CURRENT contra el Brief rector; los hallazgos no bloquean), los
 * rechazos sin efecto (roles, otra organización, chat, sistema), el reemplazo de la versión aprobada
 * anterior con sus marcas intactas y la lectura autorizada de la evaluación.
 *
 * El camino HITL está en `script-hitl.test.ts`; la concurrencia y la atomicidad, en
 * `script-approval-concurrencia.test.ts`; el SQL directo y la adversarial, en `qa-script-approval.test.ts`.
 * Todo sobre campañas, influencers y fuentes sintéticos y desechables (INC-001A).
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { User } from '@tcl-kol-os/domain';
import { archiveCampaign } from './campaigns.ts';
import { retirarInfluencerDeCampana } from './campaign-influencers.ts';
import { closePool, getPool, query } from './client.ts';
import { ClienteDeAnalisisGuionado, falloGuionado } from './content-analysis-client.ts';
import {
  ENV_CON_IA,
  claveNueva,
  clienteQueResponde,
  registrarGuionDePrueba,
} from './content-analysis-test-support.ts';
import { solicitarAnalisisDeGuion } from './content-analysis.ts';
import { archivarEntregable } from './deliverables.ts';
import { crearComentarioDeRevision, solicitarCambiosDeScript } from './script-review.ts';
import {
  aprobarScriptVersion,
  evaluarAprobacionDeScript,
  obtenerEvaluacionDeAprobacion,
} from './script-approval.ts';
import {
  type EscenarioDeAprobacion,
  aprobacionesDelEntregable,
  aprobarDirecto,
  codigo,
  contarAuditoria,
  crearEscenarioDeAprobacion,
  entregableNuevo,
  estadoDeVersion,
  esperar,
  evaluar,
  huellaDe,
  otraVersionRevisada,
  razon,
  revisarComoHumano,
  revisarConIA,
  valor,
  versionNueva,
  versionRevisada,
} from './script-approval-test-support.ts';
import {
  crearBriefHijoDePrueba,
  crearEscenarioDeContenido,
  limpiarEscenarioDeContenido,
  type EscenarioDeContenido,
} from './test-utils.ts';

let a: EscenarioDeAprobacion;
/** Escenario aparte: su Brief rector cambia (hijas aprobadas). */
let b: EscenarioDeAprobacion;
/** Escenario aparte para lo destructivo (archivar campaña, retirar participación). */
let d: EscenarioDeAprobacion;
/** Escenario sin Brief. */
let sinBrief: EscenarioDeContenido;

beforeAll(async () => {
  a = await crearEscenarioDeAprobacion('F7 aprobación');
  b = await crearEscenarioDeAprobacion('F7 aprobación brief');
  d = await crearEscenarioDeAprobacion('F7 aprobación destructiva');
  sinBrief = await crearEscenarioDeContenido('F7 aprobación sin brief');
});

afterAll(async () => {
  await limpiarEscenarioDeContenido(a.e);
  await limpiarEscenarioDeContenido(b.e);
  await limpiarEscenarioDeContenido(d.e);
  await limpiarEscenarioDeContenido(sinBrief);
  await closePool();
});

interface FilaDeVersion {
  status: string;
  approved_by: string | null;
  approved_at: Date | null;
  approved_via_proposed_action_id: string | null;
  approved_analysis_id: string | null;
  approved_brief_version_id: string | null;
  approval_snapshot: Record<string, unknown> | null;
  superseded_by_version_id: string | null;
  superseded_at: Date | null;
  source_document_id: string;
  source_hash: string;
  updated_at: Date;
}

async function fila(versionId: string): Promise<FilaDeVersion> {
  return (
    await query<FilaDeVersion>(
      `SELECT status, approved_by, approved_at, approved_via_proposed_action_id, approved_analysis_id,
              approved_brief_version_id, approval_snapshot, superseded_by_version_id, superseded_at,
              source_document_id, source_hash, updated_at
         FROM script_versions WHERE id = $1`,
      [versionId],
    )
  )[0]!;
}

const MARCAS_DE_APROBACION = [
  'approved_by',
  'approved_at',
  'approved_via_proposed_action_id',
  'approved_analysis_id',
  'approved_brief_version_id',
  'approval_snapshot',
] as const;

/** Rechazo sin efecto: la versión sigue en el estado dado, sin marcas ni auditoría de aprobación. */
async function sinEfecto(versionId: string, deliverableId: string, estado = 'in_review'): Promise<void> {
  const f = await fila(versionId);
  expect(f.status).toBe(estado);
  expect(f.approved_by).toBeNull();
  expect(f.approved_at).toBeNull();
  expect(f.approval_snapshot).toBeNull();
  expect(await contarAuditoria(versionId, 'script_version.approve')).toBe(0);
  expect(await aprobacionesDelEntregable(deliverableId)).toBe(0);
}

// ─────────────────────────── Aprobación directa ────────────────────────────────

describe('aprobación directa por una persona de Dirección', () => {
  it('el director aprueba con la huella vista: marcas de aprobación, snapshot y auditorías `ui`', async () => {
    const { deliverableId, versionId, runId } = await versionRevisada(a.e);
    const ev = await evaluar(versionId);
    expect(ev).toMatchObject({ elegible: true, bloqueos: [] });
    const [campanaAntes] = await query<{ visibility: string }>(
      `SELECT visibility::text AS visibility FROM campaigns WHERE id = $1`,
      [a.e.campanaId],
    );

    const r = valor(await aprobarScriptVersion(a.e.director, versionId, { huellaVista: ev.huella }));
    expect(r).toMatchObject({
      versionId,
      deliverableId,
      version: 1,
      status: 'approved',
      via: 'direct',
      fingerprint: ev.huella,
      reviewId: runId,
      reviewKind: 'human',
      briefVersionId: a.brief.versionId,
      previousApproved: null,
      replaced: [],
    });

    const f = await fila(versionId);
    expect(f.status).toBe('approved');
    expect(f.approved_by).toBe(a.e.director.id);
    expect(f.approved_at).not.toBeNull();
    expect(f.approved_via_proposed_action_id).toBeNull();
    expect(f.approved_analysis_id).toBe(runId);
    expect(f.approved_brief_version_id).toBe(a.brief.versionId);
    // El snapshot guardado ES el que dio la huella mostrada.
    expect(f.approval_snapshot).toEqual(JSON.parse(JSON.stringify(ev.snapshot)));
    expect(f.superseded_at).toBeNull();

    const [aprobar] = await query<{
      origin: string;
      actor_id: string;
      correlation: unknown;
      metadata: Record<string, unknown>;
    }>(
      `SELECT origin, actor_id, correlation, metadata FROM audit_events
        WHERE entity_id = $1 AND action = 'script_version.approve'`,
      [versionId],
    );
    expect(aprobar).toMatchObject({ origin: 'ui', actor_id: a.e.director.id, correlation: null });
    expect(aprobar!.metadata).toMatchObject({
      versionNumber: 1,
      via: 'direct',
      fingerprint: ev.huella,
      reviewId: runId,
      reviewKind: 'human',
      briefVersionId: a.brief.versionId,
      findings: { total: 0, openBySeverity: { alta: 0, media: 0, baja: 0 } },
      comments: { total: 0 },
    });
    expect(aprobar!.metadata).not.toHaveProperty('payloadHash');
    expect(aprobar!.metadata).not.toHaveProperty('replacedVersionId');
    expect(JSON.stringify(aprobar!.metadata)).not.toMatch(/toolInvocationId/);

    const [cambio] = await query<{ origin: string; metadata: Record<string, unknown> }>(
      `SELECT origin, metadata FROM audit_events
        WHERE entity_id = $1 AND action = 'deliverable.current_approved_changed'`,
      [deliverableId],
    );
    expect(cambio).toMatchObject({ origin: 'ui' });
    expect(cambio!.metadata).toMatchObject({ from: null, to: versionId, fromVersion: null, toVersion: 1 });

    // Aprobar NO cambia la visibilidad de la campaña ni expone la fuente a TCL.
    const [campanaDespues] = await query<{ visibility: string }>(
      `SELECT visibility::text AS visibility FROM campaigns WHERE id = $1`,
      [a.e.campanaId],
    );
    expect(campanaDespues!.visibility).toBe(campanaAntes!.visibility);
    const [fuente] = await query<{ visibility: string }>(
      `SELECT visibility::text AS visibility FROM source_documents WHERE id = $1`,
      [f.source_document_id],
    );
    expect(fuente!.visibility).toBe('interna');
  });

  it('el administrador también aprueba', async () => {
    const { versionId } = await versionRevisada(a.e);
    const r = valor(await aprobarDirecto(a.e.admin, versionId));
    expect(r.status).toBe('approved');
    expect((await fila(versionId)).approved_by).toBe(a.e.admin.id);
  });

  it('reintentar sobre una versión ya aprobada es un error de estado, no un éxito silencioso', async () => {
    const { deliverableId, versionId } = await versionRevisada(a.e);
    const huella = await huellaDe(versionId);
    valor(await aprobarScriptVersion(a.e.director, versionId, { huellaVista: huella }));
    const otra = await aprobarScriptVersion(a.e.director, versionId, { huellaVista: huella });
    expect(codigo(otra)).toBe('SCRIPT_INVALID_TRANSITION');
    expect(razon(otra)).toBe('not_in_review');
    expect(await contarAuditoria(versionId, 'script_version.approve')).toBe(1);
    expect(await aprobacionesDelEntregable(deliverableId)).toBe(1);
  });

  it('la huella mostrada es obligatoria y debe coincidir: falta o mal formada ⇒ VALIDATION_FAILED; otra ⇒ PROPOSAL_STALE(view_stale)', async () => {
    const { deliverableId, versionId } = await versionRevisada(a.e);
    for (const mala of [undefined, '', 'abc', 'Z'.repeat(64), 123 as unknown as string]) {
      const r = await aprobarScriptVersion(a.e.director, versionId, { huellaVista: mala as string });
      expect(codigo(r), String(mala)).toBe('VALIDATION_FAILED');
    }
    const sinOpciones = await aprobarScriptVersion(a.e.director, versionId, undefined as never);
    expect(codigo(sinOpciones)).toBe('VALIDATION_FAILED');
    const otra = await aprobarScriptVersion(a.e.director, versionId, { huellaVista: 'a'.repeat(64) });
    expect(codigo(otra)).toBe('PROPOSAL_STALE');
    expect(razon(otra)).toBe('view_stale');
    await sinEfecto(versionId, deliverableId);
  });
});

// ─────────────────────────── Quién aprueba ─────────────────────────────────────

describe('quién puede aprobar: solo Dirección, solo por la interfaz, solo de su organización', () => {
  it('consultor, operativo, analista, legal, cliente y otra organización son rechazados SIN efecto', async () => {
    const { deliverableId, versionId } = await versionRevisada(a.e);
    const huella = await huellaDe(versionId);
    const intentos: Array<[string, User, string]> = [
      ['consultor', a.e.consultor, 'FORBIDDEN_ROLE'],
      ['operativo', a.e.operativo, 'FORBIDDEN_ROLE'],
      ['analista', a.e.analista, 'FORBIDDEN_ROLE'],
      ['legal', a.e.legal, 'FORBIDDEN_ROLE'],
      ['cliente', a.e.cliente, 'FORBIDDEN_ROLE'],
      // Otra organización: tiene la capacidad pero el recurso no existe para ella.
      ['otra organización', a.e.ajeno, 'RESOURCE_NOT_FOUND'],
    ];
    for (const [nombre, actor, esperado] of intentos) {
      const r = await aprobarScriptVersion(actor, versionId, { huellaVista: huella });
      expect(codigo(r), nombre).toBe(esperado);
    }
    await sinEfecto(versionId, deliverableId);
  });

  it('un usuario inactivo no aprueba', async () => {
    const { deliverableId, versionId } = await versionRevisada(a.e);
    const inactivo: User = { ...a.e.director, status: 'inactivo' };
    const r = await aprobarDirecto(inactivo, versionId);
    expect(r.ok).toBe(false);
    await sinEfecto(versionId, deliverableId);
  });

  it('el chat y el sistema nunca aprueban: origen distinto de ui ⇒ HUMAN_CONFIRMATION_REQUIRED, sin efecto', async () => {
    const { deliverableId, versionId } = await versionRevisada(a.e);
    const huellaVista = await huellaDe(versionId);
    for (const origen of ['chat', 'system'] as const) {
      const r = await aprobarScriptVersion(a.e.director, versionId, { huellaVista, origen });
      expect(codigo(r), origen).toBe('HUMAN_CONFIRMATION_REQUIRED');
    }
    // El propio sistema como actor (por el borde de tipos) tampoco: ni con origen ui ni con el suyo.
    for (const opciones of [{ huellaVista }, { huellaVista, origen: 'system' as const }]) {
      const r = await aprobarScriptVersion('system' as unknown as User, versionId, opciones);
      expect(codigo(r)).toBe('HUMAN_CONFIRMATION_REQUIRED');
    }
    await sinEfecto(versionId, deliverableId);
  });

  it('el cerco de campaña y un id mal formado o inexistente responden «no existe»', async () => {
    const { deliverableId, versionId } = await versionRevisada(a.e);
    const huellaVista = await huellaDe(versionId);
    const otraCampana = await aprobarScriptVersion(a.e.director, versionId, {
      huellaVista,
      alcance: { campaignId: a.e.otraCampanaId },
    });
    expect(codigo(otraCampana)).toBe('RESOURCE_NOT_FOUND');
    expect(codigo(await aprobarScriptVersion(a.e.director, 'no-es-uuid', { huellaVista }))).toBe(
      'RESOURCE_NOT_FOUND',
    );
    expect(
      codigo(
        await aprobarScriptVersion(a.e.director, '00000000-0000-4000-8000-000000000000', { huellaVista }),
      ),
    ).toBe('RESOURCE_NOT_FOUND');
    await sinEfecto(versionId, deliverableId);
    // Con el cerco correcto sí aprueba.
    const r = await aprobarScriptVersion(a.e.director, versionId, {
      huellaVista,
      alcance: { campaignId: a.e.campanaId },
    });
    expect(r.ok).toBe(true);
  });
});

// ─────────────────────────── Regla de negocio ──────────────────────────────────

describe('regla de negocio: aprobar exige una revisión CURRENT; los hallazgos no bloquean', () => {
  it('sin revisión ⇒ SCRIPT_REVIEW_REQUIRED{none} (y la versión recibida tampoco está en revisión)', async () => {
    const deliverableId = await entregableNuevo(a.e);
    const versionId = await versionNueva(a.e, deliverableId);
    const ev = await evaluar(versionId);
    expect(ev.elegible).toBe(false);
    const codigos = ev.bloqueos.map((x) => x.code);
    expect(codigos).toContain('SCRIPT_REVIEW_REQUIRED');
    expect(ev.bloqueos.find((x) => x.code === 'SCRIPT_REVIEW_REQUIRED')?.details).toMatchObject({
      reason: 'none',
    });
    expect(ev.snapshot.review).toBeNull();
    const r = await aprobarDirecto(a.e.director, versionId);
    expect(codigo(r)).toBe('SCRIPT_INVALID_TRANSITION'); // received: primero el estado
    await sinEfecto(versionId, deliverableId, 'received');
  });

  it('en revisión pero sin revisión CURRENT (p. ej. se pidió cambios y no hubo revisión) ⇒ SCRIPT_REVIEW_REQUIRED{none}', async () => {
    // Una versión pasa a `in_review` con un comentario, sin haber registrado revisión alguna.
    const deliverableId = await entregableNuevo(a.e);
    const versionId = await versionNueva(a.e, deliverableId);
    valor(
      await crearComentarioDeRevision(a.e.consultor, versionId, { kind: 'editorial', body: 'Comentario' }),
    );
    expect(await estadoDeVersion(versionId)).toBe('in_review');
    const r = await aprobarDirecto(a.e.director, versionId);
    expect(codigo(r)).toBe('SCRIPT_REVIEW_REQUIRED');
    expect(razon(r)).toBe('none');
    await sinEfecto(versionId, deliverableId);
  });

  it('una revisión solo contra el Brief anterior ⇒ SCRIPT_REVIEW_REQUIRED{stale}; revisar de nuevo contra el vigente lo habilita', async () => {
    const { deliverableId, versionId } = await versionRevisada(b.e);
    expect((await evaluar(versionId)).elegible).toBe(true);
    const hija = await crearBriefHijoDePrueba(b.e.admin, b.brief.versionId, {
      cambios: { 'mensaje_principal.one_line': 'Mensaje nuevo del Brief V2.' },
    });
    const ev = await evaluar(versionId);
    expect(ev.elegible).toBe(false);
    expect(ev.snapshot.brief?.versionId).toBe(hija.versionId);
    const bloqueo = ev.bloqueos.find((x) => x.code === 'SCRIPT_REVIEW_REQUIRED');
    expect(bloqueo?.details).toMatchObject({ reason: 'stale' });
    const r = await aprobarScriptVersion(b.e.director, versionId, { huellaVista: ev.huella });
    expect(codigo(r)).toBe('SCRIPT_REVIEW_REQUIRED');
    expect(razon(r)).toBe('stale');
    await sinEfecto(versionId, deliverableId);

    // Nueva revisión humana contra el Brief V2 (otra persona, otro Brief): ahora sí.
    const { runId } = await revisarComoHumano(versionId, b.e.director);
    const listo = await evaluar(versionId);
    expect(listo.elegible).toBe(true);
    expect(listo.snapshot.review).toMatchObject({ id: runId, kind: 'human' });
    expect(listo.snapshot.brief?.versionId).toBe(hija.versionId);
    const ok = valor(await aprobarScriptVersion(b.e.director, versionId, { huellaVista: listo.huella }));
    expect(ok.briefVersionId).toBe(hija.versionId);
    expect((await fila(versionId)).approved_brief_version_id).toBe(hija.versionId);
  });

  it('una hija del Brief en BORRADOR no desplaza al rector: la revisión sigue CURRENT', async () => {
    const e = b.e;
    const { versionId } = await versionRevisada(e);
    // Estado del rector del escenario `b` en este punto: la hija aprobada de la prueba anterior (V2).
    const rector = (
      await query<{ id: string }>(`SELECT brief_rector_de_campana($1) AS id`, [e.campanaId])
    )[0]!.id;
    // `versionRevisada` ya revisó contra el rector vigente; una hija en borrador no cambia nada.
    await crearBriefHijoDePrueba(e.admin, rector, { aprobar: false });
    const ev = await evaluar(versionId);
    expect(ev.elegible).toBe(true);
    expect(ev.snapshot.brief?.versionId).toBe(rector);
  });

  it('cero hallazgos aprueba (revisión humana sin hallazgos)', async () => {
    const { versionId } = await versionRevisada(a.e);
    const ev = await evaluar(versionId);
    expect(ev.snapshot.findings).toEqual({ total: 0, openBySeverity: { alta: 0, media: 0, baja: 0 } });
    expect(valor(await aprobarDirecto(a.e.director, versionId)).status).toBe('approved');
  });

  it('N hallazgos abiertos APRUEBAN: no bloquean y el snapshot guarda N con sus severidades', async () => {
    const deliverableId = await entregableNuevo(a.e);
    const versionId = await versionNueva(a.e, deliverableId);
    const { runId } = await revisarConIA(a.e, versionId, [
      { category: 'cta_missing', refs: ['accion_kpis.accion_esperada'] },
      { category: 'requirement_not_covered', refs: ['mandatorios#1'] },
    ]);
    const ev = await evaluar(versionId);
    expect(ev.elegible).toBe(true);
    expect(ev.snapshot.review).toMatchObject({ id: runId, kind: 'ai_assisted' });
    expect(ev.snapshot.review?.inputHash).toMatch(/^[0-9a-f]{64}$/);
    expect(ev.snapshot.findings.total).toBe(2);
    const { alta, media, baja } = ev.snapshot.findings.openBySeverity;
    expect(alta + media + baja).toBe(2);

    const r = valor(await aprobarScriptVersion(a.e.director, versionId, { huellaVista: ev.huella }));
    expect(r).toMatchObject({ reviewKind: 'ai_assisted', reviewId: runId });
    expect(r.findings.total).toBe(2);
    const f = await fila(versionId);
    expect(f.approval_snapshot).toMatchObject({ findings: { total: 2 } });
    const [aud] = await query<{ metadata: { findings: { total: number } } }>(
      `SELECT metadata FROM audit_events WHERE entity_id = $1 AND action = 'script_version.approve'`,
      [versionId],
    );
    expect(aud!.metadata.findings.total).toBe(2);
  });

  it('sin Brief rector ⇒ BRIEF_NOT_APPROVED (y la revisión requerida es «brief_missing»)', async () => {
    const deliverableId = await entregableNuevo(sinBrief);
    const versionId = await versionNueva(sinBrief, deliverableId);
    // Sin Brief no hay revisión posible; se arma el estado en_revisión con un comentario.
    valor(
      await crearComentarioDeRevision(sinBrief.consultor, versionId, { kind: 'editorial', body: 'Nota' }),
    );
    const ev = await evaluar(versionId);
    expect(ev.elegible).toBe(false);
    expect(ev.bloqueos.map((x) => x.code)).toEqual(['BRIEF_NOT_APPROVED', 'SCRIPT_REVIEW_REQUIRED']);
    expect(ev.bloqueos[1]!.details).toMatchObject({ reason: 'brief_missing' });
    expect(ev.snapshot.brief).toBeNull();
    const r = await aprobarScriptVersion(sinBrief.director, versionId, { huellaVista: ev.huella });
    expect(codigo(r)).toBe('BRIEF_NOT_APPROVED');
    await sinEfecto(versionId, deliverableId);
  });

  it('una revisión failed no cuenta como revisión', async () => {
    const deliverableId = await entregableNuevo(a.e);
    const versionId = await versionNueva(a.e, deliverableId);
    const fallida = await solicitarAnalisisDeGuion(
      a.e.consultor,
      versionId,
      { mode: 'ensure', idempotencyKey: claveNueva('ko') },
      undefined,
      {
        cliente: new ClienteDeAnalisisGuionado(falloGuionado('MODEL_BAD_RESPONSE')),
        env: ENV_CON_IA,
        esperar: async () => {},
      },
    );
    expect(codigo(fallida)).toBe('AI_ANALYSIS_FAILED');
    const ev = await evaluar(versionId);
    expect(ev.elegible).toBe(false);
    expect(ev.snapshot.review).toBeNull();
    expect(ev.bloqueos.find((x) => x.code === 'SCRIPT_REVIEW_REQUIRED')?.details).toMatchObject({
      reason: 'none',
    });
    expect(codigo(await aprobarDirecto(a.e.director, versionId))).toBe('SCRIPT_REVIEW_REQUIRED');
  });

  it('una revisión humana cuenta: kind human, sin hallazgos y con su nota', async () => {
    const deliverableId = await entregableNuevo(a.e);
    const versionId = await versionNueva(a.e, deliverableId);
    const { runId } = await revisarComoHumano(versionId, a.e.consultor, 'Revisado a mano.');
    const ev = await evaluar(versionId);
    expect(ev.elegible).toBe(true);
    expect(ev.snapshot.review).toEqual({ id: runId, kind: 'human', inputHash: null });
    const r = valor(await aprobarScriptVersion(a.e.director, versionId, { huellaVista: ev.huella }));
    expect(r.reviewKind).toBe('human');
  });

  it('una revisión EN CURSO no bloquea si ya hay una CURRENT; si no la hay, no la sustituye', async () => {
    const deliverableId = await entregableNuevo(a.e);
    const versionId = await versionNueva(a.e, deliverableId);

    // Un análisis asistido en curso (el «modelo» espera) sin ninguna revisión terminada: no es CURRENT.
    let liberar!: () => void;
    const espera = new Promise<void>((resolver) => {
      liberar = resolver;
    });
    const enCurso = solicitarAnalisisDeGuion(
      a.e.consultor,
      versionId,
      { mode: 'reanalyze', idempotencyKey: claveNueva('curso') },
      undefined,
      {
        cliente: clienteQueResponde(
          [{ category: 'cta_missing', refs: ['accion_kpis.accion_esperada'] }],
          () => espera,
        ),
        env: ENV_CON_IA,
        esperar: async () => {},
      },
    );
    for (let i = 0; i < 100; i += 1) {
      const [{ n }] = (await query<{ n: string }>(
        `SELECT count(*)::text AS n FROM content_analysis_runs WHERE script_version_id = $1 AND status = 'running'`,
        [versionId],
      )) as [{ n: string }];
      if (n === '1') break;
      await esperar(50);
    }
    const sinCurrent = await evaluar(versionId);
    expect(sinCurrent.elegible).toBe(false);
    expect(sinCurrent.snapshot.review).toBeNull();
    expect(sinCurrent.bloqueos.find((x) => x.code === 'SCRIPT_REVIEW_REQUIRED')?.details).toMatchObject({
      reason: 'none',
    });

    // Con una revisión humana CURRENT, la que sigue en curso NO bloquea ni cambia la huella.
    const { runId } = await revisarComoHumano(versionId, a.e.consultor);
    const conCurrent = await evaluar(versionId);
    expect(conCurrent.elegible).toBe(true);
    expect(conCurrent.snapshot.review?.id).toBe(runId);
    liberar();
    expect((await enCurso).ok).toBe(true);
    // Al terminar, la del modelo es otra revisión CURRENT más reciente: cambia review.id (huella nueva).
    const despues = await evaluar(versionId);
    expect(despues.snapshot.review?.kind).toBe('ai_assisted');
    expect(despues.huella).not.toBe(conCurrent.huella);
  });
});

// ─────────────────────────── Otros bloqueos duros ──────────────────────────────

describe('bloqueos duros tipificados', () => {
  it('una versión con cambios solicitados o reemplazada no se aprueba (SCRIPT_INVALID_TRANSITION)', async () => {
    const { deliverableId, versionId } = await versionRevisada(a.e);
    valor(
      await solicitarCambiosDeScript(a.e.consultor, versionId, { items: [{ body: 'Ajustar la apertura' }] }),
    );
    const r = await aprobarDirecto(a.e.director, versionId);
    expect(codigo(r)).toBe('SCRIPT_INVALID_TRANSITION');
    expect(r.ok ? undefined : (r.error.details as { from?: string }).from).toBe('changes_requested');
    await sinEfecto(versionId, deliverableId, 'changes_requested');
  });

  it('entregable archivado ⇒ RESOURCE_CONFLICT{deliverable_archived}', async () => {
    const { deliverableId, versionId } = await versionRevisada(a.e);
    const huellaVista = await huellaDe(versionId);
    valor(await archivarEntregable(a.e.consultor, deliverableId));
    const r = await aprobarScriptVersion(a.e.director, versionId, { huellaVista });
    expect(codigo(r)).toBe('RESOURCE_CONFLICT');
    expect(razon(r)).toBe('deliverable_archived');
    await sinEfecto(versionId, deliverableId);
  });

  it('participación retirada ⇒ RESOURCE_CONFLICT{campaign_influencer_retired}', async () => {
    const { deliverableId, versionId } = await versionRevisada(d.e);
    const huellaVista = await huellaDe(versionId);
    valor(await retirarInfluencerDeCampana(d.e.admin, d.e.participaciones.diego));
    const r = await aprobarScriptVersion(d.e.director, versionId, { huellaVista });
    expect(codigo(r)).toBe('RESOURCE_CONFLICT');
    expect(razon(r)).toBe('campaign_influencer_retired');
    await sinEfecto(versionId, deliverableId);
  });

  it('campaña archivada ⇒ RESOURCE_CONFLICT{campaign_not_active}', async () => {
    // `d` ya retiró a Diego en la prueba anterior: se usa a Valentina Ríos en su lugar.
    const reelRios = d.e.entregables.reelRios;
    const v = await registrarGuionDePrueba(d.e, reelRios, d.e.participaciones.valentinaRios, d.e.consultor);
    await revisarComoHumano(v.versionId, d.e.consultor);
    const huellaVista = await huellaDe(v.versionId);
    valor(await archiveCampaign(d.e.admin, d.e.campanaId));
    const r = await aprobarScriptVersion(d.e.director, v.versionId, { huellaVista });
    expect(codigo(r)).toBe('RESOURCE_CONFLICT');
    expect(razon(r)).toBe('campaign_not_active');
    await sinEfecto(v.versionId, reelRios);
  });
});

// ─────────────────────────── La huella y el snapshot ───────────────────────────

describe('snapshot y huella', () => {
  it('el snapshot lleva ids y cifras (no texto de documentos) y la huella cambia con cada línea relevante', async () => {
    const { deliverableId, versionId, runId } = await versionRevisada(a.e);
    const ev = await evaluar(versionId);
    expect(ev.snapshot).toMatchObject({
      scriptVersion: { id: versionId, number: 1 },
      deliverable: { id: deliverableId, headVersionId: versionId },
      replaces: null,
      brief: { versionId: a.brief.versionId, number: 1 },
      review: { id: runId, kind: 'human', inputHash: null },
      findings: { total: 0 },
      comments: { total: 0 },
      participation: { campaignInfluencerId: a.e.participaciones.diego, status: 'activo' },
    });
    expect(ev.snapshot.scriptVersion.sourceHash).toMatch(/^[0-9a-f]{64}$/);
    expect(ev.snapshot.brief?.contentFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(ev.snapshot.comments.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(ev.huella).toMatch(/^[0-9a-f]{64}$/);
    expect(ev.etiquetas).toMatchObject({ influencer: 'Diego Peña', brief: 'Brief V1', headVersion: 1 });
    expect(ev.etiquetas.deliverable).toContain('Aprobación');
    // Es una función pura de la base: misma entrada, misma huella.
    expect((await evaluar(versionId)).huella).toBe(ev.huella);

    // Un comentario nuevo cambia la huella (y nada más del snapshot).
    valor(await crearComentarioDeRevision(a.e.consultor, versionId, { kind: 'editorial', body: 'Nota 1' }));
    const conComentario = await evaluar(versionId);
    expect(conComentario.elegible).toBe(true);
    expect(conComentario.snapshot.comments.total).toBe(1);
    expect(conComentario.snapshot.comments.digest).not.toBe(ev.snapshot.comments.digest);
    expect(conComentario.huella).not.toBe(ev.huella);

    // Una versión más reciente cambia headVersionId (y la huella); se puede aprobar la que no es la última.
    const siguiente = await versionNueva(a.e, deliverableId);
    const conCabeza = await evaluar(versionId);
    expect(conCabeza.elegible).toBe(true);
    expect(conCabeza.snapshot.deliverable.headVersionId).toBe(siguiente);
    expect(conCabeza.etiquetas.headVersion).toBe(2);
    expect(conCabeza.huella).not.toBe(conComentario.huella);
    valor(await aprobarScriptVersion(a.e.director, versionId, { huellaVista: conCabeza.huella }));
    // La V2 (más reciente, sin tocar) sigue recibida.
    expect(await estadoDeVersion(siguiente)).toBe('received');
  });

  it('evaluarAprobacionDeScript sobre un id inexistente o mal formado es «no existe»', async () => {
    for (const id of ['x', '00000000-0000-4000-8000-000000000000']) {
      const r = await evaluarAprobacionDeScript(getPool(), id);
      expect(codigo(r)).toBe('RESOURCE_NOT_FOUND');
    }
  });
});

// ─────────────────────────── Lectura autorizada ────────────────────────────────

describe('obtenerEvaluacionDeAprobacion (lo que ve la interfaz)', () => {
  it('Cuenta lee la evaluación con su huella; operativo, cliente y otra organización no', async () => {
    const { versionId } = await versionRevisada(a.e);
    for (const actor of [a.e.consultor, a.e.director, a.e.admin]) {
      const r = valor(await obtenerEvaluacionDeAprobacion(actor, versionId));
      expect(r.elegible).toBe(true);
      expect(r.huella).toBe(await huellaDe(versionId));
    }
    expect(codigo(await obtenerEvaluacionDeAprobacion(a.e.operativo, versionId))).toBe('FORBIDDEN_ROLE');
    expect(codigo(await obtenerEvaluacionDeAprobacion(a.e.cliente, versionId))).toBe('RESOURCE_NOT_FOUND');
    expect(codigo(await obtenerEvaluacionDeAprobacion(a.e.ajeno, versionId))).toBe('RESOURCE_NOT_FOUND');
    expect(
      codigo(await obtenerEvaluacionDeAprobacion(a.e.director, versionId, { campaignId: a.e.otraCampanaId })),
    ).toBe('RESOURCE_NOT_FOUND');
    expect(codigo(await obtenerEvaluacionDeAprobacion(a.e.director, 'no-uuid'))).toBe('RESOURCE_NOT_FOUND');
  });
});

// ─────────────────────────── Reemplazo de la versión anterior ──────────────────

describe('aprobar una versión nueva reemplaza a la aprobada anterior', () => {
  it('V1 aprobada → V2 aprobada: V1 pasa a superseded con TODAS sus marcas intactas; su fuente baja a interna; 3 auditorías', async () => {
    const { deliverableId, versionId: v1 } = await versionRevisada(a.e);
    valor(await aprobarDirecto(a.e.director, v1));
    const antes = await fila(v1);
    // Alguien (Fase 9) expuso la fuente de la aprobada vigente a TCL: aprobar la sucesora la baja.
    await query(`UPDATE source_documents SET visibility = 'tcl' WHERE id = $1`, [antes.source_document_id]);

    const { versionId: v2, runId } = await otraVersionRevisada(a.e, deliverableId, a.e.director);
    const ev = await evaluar(v2);
    expect(ev.snapshot.replaces).toEqual({ versionId: v1, number: 1 });
    const r = valor(await aprobarScriptVersion(a.e.director, v2, { huellaVista: ev.huella }));
    expect(r.previousApproved).toEqual({ versionId: v1, version: 1 });
    expect(r.replaced).toEqual([{ versionId: v1, version: 1, previousStatus: 'approved' }]);

    const despues = await fila(v1);
    expect(despues.status).toBe('superseded');
    expect(despues.superseded_by_version_id).toBe(v2);
    expect(despues.superseded_at).not.toBeNull();
    for (const marca of MARCAS_DE_APROBACION) expect(despues[marca], marca).toEqual(antes[marca]);
    expect(despues.source_hash).toBe(antes.source_hash);
    const nueva = await fila(v2);
    expect(nueva).toMatchObject({
      status: 'approved',
      approved_by: a.e.director.id,
      approved_analysis_id: runId,
    });
    // Exactamente UNA aprobada vigente.
    const [{ n }] = (await query<{ n: string }>(
      `SELECT count(*)::text AS n FROM script_versions WHERE deliverable_id = $1 AND status = 'approved'`,
      [deliverableId],
    )) as [{ n: string }];
    expect(n).toBe('1');

    const [fuente] = await query<{ visibility: string }>(
      `SELECT visibility::text AS visibility FROM source_documents WHERE id = $1`,
      [antes.source_document_id],
    );
    expect(fuente!.visibility).toBe('interna');
    const [vis] = await query<{ origin: string; metadata: Record<string, unknown> }>(
      `SELECT origin, metadata FROM audit_events
        WHERE entity_id = $1 AND action = 'source.set_visibility' ORDER BY created_at DESC LIMIT 1`,
      [antes.source_document_id],
    );
    expect(vis).toMatchObject({ origin: 'ui' });
    expect(vis!.metadata).toMatchObject({ from: 'tcl', to: 'interna', reason: 'script_superseded' });

    const [aprobar] = await query<{ metadata: Record<string, unknown> }>(
      `SELECT metadata FROM audit_events WHERE entity_id = $1 AND action = 'script_version.approve'`,
      [v2],
    );
    expect(aprobar!.metadata).toMatchObject({ replacedVersionId: v1, supersededCount: 1 });
    const [reemplazo] = await query<{ origin: string; metadata: Record<string, unknown> }>(
      `SELECT origin, metadata FROM audit_events WHERE entity_id = $1 AND action = 'script_version.supersede'`,
      [v1],
    );
    expect(reemplazo).toMatchObject({ origin: 'ui' });
    expect(reemplazo!.metadata).toMatchObject({
      from: 'approved',
      to: 'superseded',
      supersededByVersionId: v2,
    });
    const [vigente] = await query<{ metadata: Record<string, unknown> }>(
      `SELECT metadata FROM audit_events
        WHERE entity_id = $1 AND action = 'deliverable.current_approved_changed' ORDER BY created_at DESC LIMIT 1`,
      [deliverableId],
    );
    expect(vigente!.metadata).toMatchObject({ from: v1, to: v2, fromVersion: 1, toVersion: 2 });
  });

  it('V3 → V4: V3 queda intacta salvo estado y marcas de reemplazo; las abiertas menores también se reemplazan; aprobar V2 después se rechaza', async () => {
    const deliverableId = await entregableNuevo(a.e);
    // V1 aprobada, V2 recibida (sin revisar), V3 revisada y aprobada, V4 revisada.
    const v1 = await versionNueva(a.e, deliverableId);
    await revisarComoHumano(v1, a.e.consultor);
    valor(await aprobarDirecto(a.e.director, v1));
    const v2 = await versionNueva(a.e, deliverableId);
    const v3 = (await otraVersionRevisada(a.e, deliverableId)).versionId;
    valor(await aprobarDirecto(a.e.director, v3));
    // V3 aprobada reemplazó a V1 (aprobada) y a V2 (recibida).
    expect(await estadoDeVersion(v1)).toBe('superseded');
    expect(await estadoDeVersion(v2)).toBe('superseded');
    const v2Marcas = await fila(v2);
    expect(v2Marcas.approved_at).toBeNull();
    expect(v2Marcas.superseded_by_version_id).toBe(v3);

    const v3Antes = await fila(v3);
    const v4 = (await otraVersionRevisada(a.e, deliverableId)).versionId;
    valor(await aprobarDirecto(a.e.director, v4));
    const v3Despues = await fila(v3);
    expect(v3Despues.status).toBe('superseded');
    expect(v3Despues.superseded_by_version_id).toBe(v4);
    for (const marca of MARCAS_DE_APROBACION) expect(v3Despues[marca], marca).toEqual(v3Antes[marca]);
    expect(v3Despues.source_hash).toBe(v3Antes.source_hash);
    expect(v3Despues.source_document_id).toBe(v3Antes.source_document_id);
    expect(await estadoDeVersion(v4)).toBe('approved');

    // Aprobar hacia atrás: V2 es histórica; no se aprueba (ni siquiera con su huella).
    const hacia = await aprobarDirecto(a.e.director, v2);
    expect(codigo(hacia)).toBe('SCRIPT_INVALID_TRANSITION');
    expect(await estadoDeVersion(v2)).toBe('superseded');
    expect(await aprobacionesDelEntregable(deliverableId)).toBe(3);
  });

  it('una versión con cambios solicitados NO se reemplaza al aprobar una más nueva (terminal por sí misma)', async () => {
    const deliverableId = await entregableNuevo(a.e);
    const v1 = await versionNueva(a.e, deliverableId);
    valor(await solicitarCambiosDeScript(a.e.consultor, v1, { items: [{ body: 'Cambiar el cierre' }] }));
    const v2 = (await otraVersionRevisada(a.e, deliverableId)).versionId;
    valor(await aprobarDirecto(a.e.director, v2));
    expect(await estadoDeVersion(v1)).toBe('changes_requested');
    expect((await fila(v1)).superseded_at).toBeNull();
  });
});
