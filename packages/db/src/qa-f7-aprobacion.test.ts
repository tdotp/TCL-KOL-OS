/**
 * QA ADVERSARIAL F7 (subagente F) — APROBACIÓN, HITL y carreras, contra PostgreSQL real.
 *
 * Vectores: 4 (revisión stale / ausente / de otra versión o Brief), 5 (hallazgos no bloquean; cero hallazgos no
 * sustituye la revisión), 6 (la IA nunca aprueba), 7 (propuestas con huella vieja, replay, doble confirmación…),
 * F (carreras con retirar/archivar/crearVersionHija) y H (deadlocks).
 *
 * Cada defensa que RESISTE tiene su prueba; cada vulnerabilidad CONFIRMADA lleva `it.fails(...)` con
 * «QA-F7-xx abierto» (ya corregidas y volteadas a `it` por W5a). Solo ataca: no corrige producción.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { User } from '@tcl-kol-os/domain';
import { archiveCampaign } from './campaigns.ts';
import { retirarInfluencerDeCampana } from './campaign-influencers.ts';
import { closePool, getPool, query } from './client.ts';
import { ClienteDeAnalisisGuionado, falloGuionado } from './content-analysis-client.ts';
import { ENV_CON_IA, claveNueva } from './content-analysis-test-support.ts';
import { solicitarAnalisisDeGuion } from './content-analysis.ts';
import { archivarEntregable, reactivarEntregable } from './deliverables.ts';
import { cancelarAccion, confirmarAccion, ejecutarAccion, proponerAccion } from './proposed-actions.ts';
import { aprobarScriptVersion, evaluarAprobacionDeScript } from './script-approval.ts';
import {
  type EscenarioDeAprobacion,
  aprobarDirecto,
  codigo,
  conDemora,
  confirmarAprobacion,
  crearEscenarioDeAprobacion,
  ejecutarAprobacion,
  entregableNuevo,
  esperar,
  estadoDeAccion,
  estadoDeVersion,
  evaluar,
  fuenteDeGuionNueva,
  huellaDe,
  otraVersionRevisada,
  proponerAprobacion,
  razon,
  revisarComoHumano,
  revisarConIA,
  valor,
  versionNueva,
  versionRevisada,
} from './script-approval-test-support.ts';
import { crearComentarioDeRevision } from './script-review.ts';
import { iniciarRevisionDeVersion, registrarVersionDeGuion } from './script-versions.ts';
import { crearBriefHijoDePrueba, limpiarEscenarioDeContenido } from './test-utils.ts';

const escenarios: EscenarioDeAprobacion[] = [];
async function escenario(nombre: string): Promise<EscenarioDeAprobacion> {
  const a = await crearEscenarioDeAprobacion(nombre);
  escenarios.push(a);
  return a;
}

let a: EscenarioDeAprobacion;

beforeAll(async () => {
  a = await escenario('QA-F7 aprobación base');
});

afterAll(async () => {
  for (const s of escenarios) await limpiarEscenarioDeContenido(s.e);
  await closePool();
});

const HUELLA_FALSA = 'f'.repeat(64);

// ═════════════════════════ Vector 4 · revisión stale / ausente ════════════════════

describe('QA-F7-04 · aprobar exige una revisión CURRENT contra el Brief rector', () => {
  it('RESISTE: una versión en revisión SIN ninguna revisión no se aprueba (SCRIPT_REVIEW_REQUIRED/none)', async () => {
    const deliverableId = await entregableNuevo(a.e);
    const versionId = await versionNueva(a.e, deliverableId);
    valor(await iniciarRevisionDeVersion(a.e.consultor, versionId));
    const ev = await evaluar(versionId);
    expect(ev.elegible).toBe(false);
    expect(ev.bloqueos.map((b) => b.code)).toContain('SCRIPT_REVIEW_REQUIRED');
    const r = await aprobarScriptVersion(a.e.director, versionId, { huellaVista: ev.huella });
    expect(codigo(r)).toBe('SCRIPT_REVIEW_REQUIRED');
    expect(razon(r)).toBe('none');
    expect(await estadoDeVersion(versionId)).toBe('in_review');
  });

  it('RESISTE: la revisión de OTRA versión del mismo entregable no habilita esta', async () => {
    const deliverableId = await entregableNuevo(a.e);
    const v1 = await versionNueva(a.e, deliverableId);
    await revisarComoHumano(v1, a.e.consultor);
    const v2 = await versionNueva(a.e, deliverableId);
    valor(await iniciarRevisionDeVersion(a.e.consultor, v2));
    const r = await aprobarScriptVersion(a.e.director, v2, { huellaVista: await huellaDe(v2) });
    expect(codigo(r)).toBe('SCRIPT_REVIEW_REQUIRED');
  });

  it('RESISTE: un análisis fallido o en curso NO cuenta como revisión', async () => {
    const e = a.e;
    const deliverableId = await entregableNuevo(e);
    const versionId = await versionNueva(e, deliverableId);
    // Fallido (el worker no responde).
    const falla = await solicitarAnalisisDeGuion(
      e.consultor,
      versionId,
      { mode: 'reanalyze', idempotencyKey: claveNueva('f') },
      undefined,
      {
        cliente: new ClienteDeAnalisisGuionado(() => falloGuionado('MODEL_INVALID_OUTPUT')),
        env: ENV_CON_IA,
        esperar: async () => {},
      },
    );
    expect(falla.ok).toBe(false);
    let ev = await evaluar(versionId);
    expect(ev.snapshot.review).toBeNull();
    expect(codigo(await aprobarScriptVersion(e.director, versionId, { huellaVista: ev.huella }))).toBe(
      'SCRIPT_REVIEW_REQUIRED',
    );
    // En curso: una fila `running` (sin cierre) tampoco.
    const [fila] = await query<{
      organization_id: string;
      campaign_id: string;
      ci: string;
      src: string;
      h: string;
    }>(
      `SELECT sv.organization_id, sv.campaign_id, d.campaign_influencer_id AS ci, sv.source_document_id AS src,
              sv.source_hash AS h
         FROM script_versions sv JOIN deliverables d ON d.id = sv.deliverable_id WHERE sv.id = $1`,
      [versionId],
    );
    await query(
      `UPDATE content_analysis_runs SET status = 'failed', failure_code = 'ANALYSIS_ABANDONED', finished_at = now()
        WHERE script_version_id = $1 AND status IN ('queued', 'running')`,
      [versionId],
    );
    await query(
      `INSERT INTO content_analysis_runs
         (organization_id, campaign_id, kind, script_version_id, deliverable_id, campaign_influencer_id,
          governing_brief_version_id, brief_fingerprint, script_source_id, script_source_hash, script_text_hash,
          script_chars, fragment_count, product_scope, context_manifest, prompt_version, output_schema_version,
          context_version, severity_policy_version, model_tier, status, idempotency_key, request_hash, mode,
          created_by, lease_expires_at)
       VALUES ($1, $2, 'ai_assisted', $3, $4, $5, $6, $7, $8, $9, $10, 10, 1, 'assigned', '{}'::jsonb,
               'p', 'o', 'c', 's', 'equilibrado', 'running', $11, $12, 'reanalyze', $13, now() + interval '5 min')`,
      [
        fila!.organization_id,
        fila!.campaign_id,
        versionId,
        deliverableId,
        fila!.ci,
        a.brief.versionId,
        'a'.repeat(64),
        fila!.src,
        fila!.h,
        'b'.repeat(64),
        claveNueva('run'),
        'c'.repeat(64),
        e.consultor.id,
      ],
    );
    ev = await evaluar(versionId);
    expect(ev.snapshot.review).toBeNull();
    expect(codigo(await aprobarScriptVersion(e.director, versionId, { huellaVista: ev.huella }))).toBe(
      'SCRIPT_REVIEW_REQUIRED',
    );
    await query(
      `UPDATE content_analysis_runs SET status = 'failed', failure_code = 'ANALYSIS_ABANDONED', finished_at = now()
        WHERE script_version_id = $1 AND status = 'running'`,
      [versionId],
    );
  });

  it('RESISTE: si cambia el Brief rector, la revisión queda STALE y la huella vista deja de valer', async () => {
    const s = await escenario('QA-F7 stale');
    const { versionId } = await versionRevisada(s.e);
    const vista = await huellaDe(versionId);
    await crearBriefHijoDePrueba(s.e.admin, s.brief.versionId, {
      cambios: { 'mensaje_principal.one_line': 'Un mensaje nuevo y distinto del Brief aprobado.' },
    });
    const ev = await evaluar(versionId);
    expect(ev.elegible).toBe(false);
    const r = await aprobarScriptVersion(s.e.director, versionId, { huellaVista: vista });
    expect(codigo(r)).toBe('SCRIPT_REVIEW_REQUIRED');
    expect(razon(r)).toBe('stale');
    expect(await estadoDeVersion(versionId)).toBe('in_review');
    // Una revisión nueva contra el Brief nuevo la habilita (control positivo).
    await revisarComoHumano(versionId, s.e.admin);
    valor(await aprobarDirecto(s.e.director, versionId));
  });

  it('RESISTE: una versión hija del Brief en BORRADOR no desplaza al rector (la revisión sigue CURRENT)', async () => {
    const s = await escenario('QA-F7 borrador');
    const { versionId } = await versionRevisada(s.e);
    await crearBriefHijoDePrueba(s.e.admin, s.brief.versionId, { aprobar: false });
    expect((await evaluar(versionId)).elegible).toBe(true);
  });

  it('RESISTE (HITL): el Brief cambia ENTRE la propuesta y la confirmación, y ENTRE confirmar y ejecutar ⇒ PROPOSAL_STALE y nada se aprueba', async () => {
    const s = await escenario('QA-F7 hitl brief');
    const x = await versionRevisada(s.e);
    const propuesta = await proponerAprobacion(s.e, x.versionId);
    await crearBriefHijoDePrueba(s.e.admin, s.brief.versionId, {
      cambios: { 'mensaje_principal.one_line': 'Otro mensaje principal, distinto del que se revisó.' },
    });
    expect(codigo(await confirmarAprobacion(s.e.director, propuesta))).toBe('PROPOSAL_STALE');
    expect(await estadoDeVersion(x.versionId)).toBe('in_review');

    // Segundo caso: confirmada y luego cambia el Brief.
    const s2 = await escenario('QA-F7 hitl brief 2');
    const y = await versionRevisada(s2.e);
    const p2 = await proponerAprobacion(s2.e, y.versionId);
    valor(await confirmarAprobacion(s2.e.director, p2));
    await crearBriefHijoDePrueba(s2.e.admin, s2.brief.versionId, {
      cambios: { 'mensaje_principal.one_line': 'Mensaje cambiado después de confirmar la propuesta.' },
    });
    expect(codigo(await ejecutarAprobacion(s2.e.director, p2))).toBe('PROPOSAL_STALE');
    expect(await estadoDeVersion(y.versionId)).toBe('in_review');
    expect(await estadoDeAccion(p2.id)).toBe('confirmed');
  });
});

// ═════════════════════════ Vector 5 · hallazgos abiertos NO bloquean ══════════════

describe('QA-F7-05 · los hallazgos informan: no bloquean (y cero hallazgos no sustituye la revisión)', () => {
  it('RESISTE: una revisión asistida con hallazgos abiertos de las 3 severidades NO impide aprobar; el snapshot los registra', async () => {
    const s = await escenario('QA-F7 hallazgos');
    const deliverableId = await entregableNuevo(s.e);
    const versionId = await versionNueva(s.e, deliverableId);
    await revisarConIA(s.e, versionId, [
      { category: 'cta_missing', refs: ['accion_kpis.accion_esperada'] },
      {
        category: 'key_message_incomplete',
        refs: ['mensaje_principal.mensaje_clave'],
        quotes: [{ fragment: 'F1' }],
      },
      { category: 'restriction_violated', refs: ['practico.restricciones'], quotes: [{ fragment: 'F1' }] },
    ]);
    const ev = await evaluar(versionId);
    expect(ev.snapshot.findings.total).toBeGreaterThanOrEqual(1);
    expect(ev.elegible).toBe(true);
    const r = valor(await aprobarDirecto(s.e.director, versionId));
    expect(r.findings.total).toBe(ev.snapshot.findings.total);
    expect(await estadoDeVersion(versionId)).toBe('approved');
  });

  it('RESISTE (inversa): cero hallazgos NO equivale a revisión: sin run no hay aprobación aunque no exista ningún hallazgo', async () => {
    const deliverableId = await entregableNuevo(a.e);
    const versionId = await versionNueva(a.e, deliverableId);
    valor(await iniciarRevisionDeVersion(a.e.consultor, versionId));
    const [n] = await query<{ n: string }>(
      `SELECT count(*)::text AS n FROM content_findings WHERE script_version_id = $1`,
      [versionId],
    );
    expect(n!.n).toBe('0');
    expect(
      codigo(await aprobarScriptVersion(a.e.director, versionId, { huellaVista: await huellaDe(versionId) })),
    ).toBe('SCRIPT_REVIEW_REQUIRED');
  });

  it('RESISTE: la revisión HUMANA habilita aprobar con cero hallazgos y sin IA', async () => {
    const { versionId } = await versionRevisada(a.e);
    const r = valor(await aprobarDirecto(a.e.director, versionId));
    expect(r.reviewKind).toBe('human');
    expect(r.findings.total).toBe(0);
  });
});

// ═════════════════════════ Vector 6 · la IA nunca aprueba ═════════════════════════

describe('QA-F7-06 · ni el chat, ni el sistema, ni la IA aprueban', () => {
  it('RESISTE: aprobarScriptVersion con origen chat/system/ai/otro ⇒ HUMAN_CONFIRMATION_REQUIRED y la versión no cambia', async () => {
    const { versionId } = await versionRevisada(a.e);
    const huellaVista = await huellaDe(versionId);
    for (const origen of ['chat', 'system', 'ai', 'agent', 'api', '']) {
      const r = await aprobarScriptVersion(a.e.director, versionId, {
        huellaVista,
        origen: origen as never,
      });
      expect(codigo(r), `origen=${origen}`).toBe('HUMAN_CONFIRMATION_REQUIRED');
    }
    // El actor «system» (cadena) tampoco aprueba, con o sin origen.
    for (const opciones of [{ huellaVista }, { huellaVista, origen: 'ui' as const }]) {
      const r = await aprobarScriptVersion('system' as unknown as User, versionId, opciones);
      expect(r.ok, JSON.stringify(opciones)).toBe(false);
    }
    expect(await estadoDeVersion(versionId)).toBe('in_review');
  });

  it('RESISTE: confirmar/ejecutar por canal chat o system, o como actor system ⇒ rechazado; proponer como system ⇒ rechazado', async () => {
    const s = await escenario('QA-F7 ia');
    const { versionId } = await versionRevisada(s.e);
    const propuesta = await proponerAprobacion(s.e, versionId);
    for (const canal of ['chat', 'system'] as const) {
      const c = await confirmarAccion(s.e.director, propuesta.id, {
        canal,
        payloadHash: propuesta.payloadHash,
      });
      expect(c.ok, `confirmar ${canal}`).toBe(false);
    }
    expect(
      (await confirmarAccion('system', propuesta.id, { canal: 'ui', payloadHash: propuesta.payloadHash })).ok,
    ).toBe(false);
    valor(await confirmarAprobacion(s.e.director, propuesta));
    for (const canal of ['chat', 'system'] as const) {
      const r = await ejecutarAccion(s.e.director, propuesta.id, { canal });
      expect(r.ok, `ejecutar ${canal}`).toBe(false);
    }
    expect((await ejecutarAccion('system', propuesta.id, { canal: 'ui' })).ok).toBe(false);
    expect(await estadoDeVersion(versionId)).toBe('in_review');
    const delSistema = await proponerAccion('system', {
      type: 'script_version.approve',
      resourceId: versionId,
    });
    expect(delSistema.ok).toBe(false);
  });

  it('RESISTE: quien propone sin `script:approve` (consultor, analista, legal, operativo) no confirma ni ejecuta', async () => {
    const s = await escenario('QA-F7 sin approve');
    const { versionId } = await versionRevisada(s.e);
    const propuesta = await proponerAprobacion(s.e, versionId);
    for (const persona of [s.e.consultor, s.e.analista, s.e.legal, s.e.operativo]) {
      const c = await confirmarAprobacion(persona, propuesta);
      expect(c.ok, `${persona.role} confirma`).toBe(false);
    }
    valor(await confirmarAprobacion(s.e.director, propuesta));
    for (const persona of [s.e.consultor, s.e.analista, s.e.legal, s.e.operativo]) {
      const r = await ejecutarAprobacion(persona, propuesta);
      expect(r.ok, `${persona.role} ejecuta`).toBe(false);
    }
    expect(await estadoDeVersion(versionId)).toBe('in_review');
  });

  it('RESISTE: quien propuso por el chat y NO es aprobador no puede aprobar de forma directa; un aprobador sí, y queda auditado con origen ui', async () => {
    const { versionId } = await versionRevisada(a.e);
    const huellaVista = await huellaDe(versionId);
    for (const persona of [a.e.consultor, a.e.operativo, a.e.analista, a.e.legal]) {
      expect(codigo(await aprobarScriptVersion(persona, versionId, { huellaVista })), persona.role).toMatch(
        /FORBIDDEN_ROLE|RESOURCE_NOT_FOUND/,
      );
    }
    valor(await aprobarScriptVersion(a.e.director, versionId, { huellaVista }));
    const [ev] = await query<{ origin: string; actor_id: string }>(
      `SELECT origin, actor_id FROM audit_events WHERE action = 'script_version.approve' AND entity_id = $1`,
      [versionId],
    );
    expect(ev!.origin).toBe('ui');
    expect(ev!.actor_id).toBe(a.e.director.id);
  });
});

// ═════════════════════════ Vector 7 · propuestas con huella vieja ═════════════════

describe('QA-F7-07 · una propuesta solo vale para lo que se propuso', () => {
  it('RESISTE: una V(N+1), un comentario nuevo o un cambio de la aprobada vigente invalidan la propuesta (al confirmar)', async () => {
    const s = await escenario('QA-F7 huella');
    const x = await versionRevisada(s.e);
    const p1 = await proponerAprobacion(s.e, x.versionId);
    await versionNueva(s.e, x.deliverableId); // V2 del mismo entregable ⇒ cambia headVersionId
    expect(codigo(await confirmarAprobacion(s.e.director, p1))).toBe('PROPOSAL_STALE');

    const y = await versionRevisada(s.e);
    const p2 = await proponerAprobacion(s.e, y.versionId);
    valor(
      await crearComentarioDeRevision(s.e.consultor, y.versionId, {
        kind: 'editorial',
        body: 'Comentario añadido después de proponer la aprobación.',
      }),
    );
    expect(codigo(await confirmarAprobacion(s.e.director, p2))).toBe('PROPOSAL_STALE');

    // La aprobada vigente cambia: V1 aprobada, V2 propuesta; luego otra V3 se aprueba antes de confirmar la de V2.
    const z = await versionRevisada(s.e);
    const v2 = await otraVersionRevisada(s.e, z.deliverableId);
    const v3 = await otraVersionRevisada(s.e, z.deliverableId);
    const p3 = await proponerAprobacion(s.e, v2.versionId);
    valor(await aprobarDirecto(s.e.director, v3.versionId));
    const c3 = await confirmarAprobacion(s.e.director, p3);
    expect(c3.ok).toBe(false);
    expect(await estadoDeVersion(v2.versionId)).not.toBe('approved');
  });

  it('RESISTE: replay, doble confirmación, doble ejecución, ejecución tras cancelar o expirar', async () => {
    const s = await escenario('QA-F7 replay');
    const { versionId } = await versionRevisada(s.e);
    const p = await proponerAprobacion(s.e, versionId);
    // doble confirmación simultánea: una gana
    const [c1, c2] = await Promise.all([
      confirmarAprobacion(s.e.director, p),
      confirmarAprobacion(s.e.director, p),
    ]);
    expect([c1.ok, c2.ok].filter(Boolean)).toHaveLength(1);
    // doble ejecución simultánea: una aprueba
    const [e1, e2] = await Promise.all([
      ejecutarAprobacion(s.e.director, p),
      ejecutarAprobacion(s.e.director, p),
    ]);
    expect([e1.ok, e2.ok].filter(Boolean)).toHaveLength(1);
    expect(await estadoDeVersion(versionId)).toBe('approved');
    // replay posterior
    expect((await ejecutarAprobacion(s.e.director, p)).ok).toBe(false);
    expect((await confirmarAprobacion(s.e.director, p)).ok).toBe(false);
    const [n] = await query<{ n: string }>(
      `SELECT count(*)::text AS n FROM audit_events WHERE action = 'script_version.approve' AND entity_id = $1`,
      [versionId],
    );
    expect(n!.n).toBe('1');

    // cancelar y ejecutar
    const y = await versionRevisada(s.e);
    const p2 = await proponerAprobacion(s.e, y.versionId);
    valor(await confirmarAprobacion(s.e.director, p2));
    valor(await cancelarAccion(s.e.director, p2.id));
    expect((await ejecutarAprobacion(s.e.director, p2)).ok).toBe(false);
    expect(await estadoDeVersion(y.versionId)).toBe('in_review');

    // expirar y ejecutar (la acción es inmutable: el plazo se agota de verdad)
    const z = await versionRevisada(s.e);
    const p3 = valor(
      await proponerAccion(s.e.consultor, {
        type: 'script_version.approve',
        resourceId: z.versionId,
        origin: 'chat',
        campaignId: s.e.campanaId,
        ttlSegundos: 1,
      }),
    );
    valor(await confirmarAprobacion(s.e.director, p3));
    await esperar(1300);
    expect(codigo(await ejecutarAprobacion(s.e.director, p3))).toBe('PROPOSAL_EXPIRED');
    expect(await estadoDeVersion(z.versionId)).toBe('in_review');
  });

  it('RESISTE: la confirmación de una persona no la ejecuta otra', async () => {
    const s = await escenario('QA-F7 otra persona');
    const { versionId } = await versionRevisada(s.e);
    const p = await proponerAprobacion(s.e, versionId);
    valor(await confirmarAprobacion(s.e.director, p));
    expect((await ejecutarAprobacion(s.e.admin, p)).ok, 'ejecuta otra persona').toBe(false);
    expect(await estadoDeVersion(versionId)).toBe('in_review');
    valor(await ejecutarAprobacion(s.e.director, p));
  });

  it('RESISTE: una propuesta no se puede manipular por SQL (payload, huella, recurso, estado)', async () => {
    const s = await escenario('QA-F7 payload');
    const x = await versionRevisada(s.e);
    const y = await versionRevisada(s.e);
    const p = await proponerAprobacion(s.e, x.versionId);
    for (const [sql, params] of [
      [
        `UPDATE proposed_actions SET payload = jsonb_set(payload, '{approvalFingerprint}', '"${HUELLA_FALSA}"') WHERE id = $1`,
        [],
      ],
      [`UPDATE proposed_actions SET payload_hash = '${HUELLA_FALSA}' WHERE id = $1`, []],
      [`UPDATE proposed_actions SET resource_id = $2 WHERE id = $1`, [y.versionId]],
      [`UPDATE proposed_actions SET status = 'executed', executed_at = now() WHERE id = $1`, []],
    ] as Array<[string, unknown[]]>) {
      const m = await query(sql, [p.id, ...params]).then(
        () => undefined,
        (e: Error) => e.message,
      );
      expect(m, sql).toBeDefined();
    }
    expect(await estadoDeVersion(x.versionId)).toBe('in_review');
    expect(await estadoDeAccion(p.id)).toBe('pending');
  });
});

// ═════════════════════════ Vector F · carreras ════════════════════════════════════

async function dormirEn(
  tabla: string,
  evento: 'UPDATE' | 'INSERT',
  condicion: string,
  segundos: number,
  fn: () => Promise<void>,
): Promise<void> {
  const pool = getPool();
  const nombre = `aa_qaf7_${tabla}_${Math.random().toString(36).slice(2, 8)}`;
  await pool.query(`CREATE OR REPLACE FUNCTION ${nombre}() RETURNS trigger AS $$
    BEGIN PERFORM pg_sleep(${segundos}); RETURN NEW; END; $$ LANGUAGE plpgsql`);
  await pool.query(
    `CREATE TRIGGER ${nombre} BEFORE ${evento} ON ${tabla} FOR EACH ROW WHEN (${condicion}) EXECUTE FUNCTION ${nombre}()`,
  );
  try {
    await fn();
  } finally {
    await pool.query(`DROP TRIGGER IF EXISTS ${nombre} ON ${tabla}`);
    await pool.query(`DROP FUNCTION IF EXISTS ${nombre}()`);
  }
}

describe('QA-F7-F · carreras de la aprobación con retirar, archivar y la versión hija del Brief', () => {
  it('RESISTE: retirar a la persona mientras se aprueba ⇒ o aprueba antes de retirar, o se rechaza; nunca se aprueba bajo una participación retirada', async () => {
    const s = await escenario('QA-F7 carrera retirar');
    const { versionId } = await versionRevisada(s.e);
    const huellaVista = await huellaDe(versionId);
    const [d] = await query<{ ci: string }>(
      `SELECT d.campaign_influencer_id AS ci FROM script_versions sv JOIN deliverables d ON d.id = sv.deliverable_id WHERE sv.id = $1`,
      [versionId],
    );
    // El retiro tarda 1.5 s con la fila de la participación bloqueada; la aprobación llega a mitad.
    await dormirEn(
      'campaign_influencers',
      'UPDATE',
      `NEW.id = '${d!.ci}' AND NEW.status = 'retirado'`,
      1.5,
      async () => {
        const retiro = retirarInfluencerDeCampana(s.e.admin, d!.ci, { motivo: 'qa' });
        await esperar(400);
        const aprobar = aprobarScriptVersion(s.e.director, versionId, { huellaVista });
        const [r1, r2] = await Promise.all([retiro, aprobar]);
        expect(r1.ok).toBe(true);
        // Si el retiro ya había empezado, la aprobación no puede quedar aprobada bajo la participación retirada.
        const [fila] = await query<{ status: string; ci_status: string }>(
          `SELECT sv.status, ci.status::text AS ci_status
           FROM script_versions sv JOIN deliverables d ON d.id = sv.deliverable_id
           JOIN campaign_influencers ci ON ci.id = d.campaign_influencer_id WHERE sv.id = $1`,
          [versionId],
        );
        expect(fila!.ci_status).toBe('retirado');
        expect(r2.ok ? 'approved' : 'in_review').toBe(fila!.status);
        expect(fila!.status).toBe('in_review');
      },
    );
  });

  it('RESISTE: archivar el entregable mientras se aprueba ⇒ estado coherente (aprobada primero o rechazada), sin aprobada «huérfana»', async () => {
    const s = await escenario('QA-F7 carrera archivar');
    const { versionId, deliverableId } = await versionRevisada(s.e);
    const huellaVista = await huellaDe(versionId);
    await conDemora('aprobar', versionId, 1.2, async () => {
      const aprobar = aprobarScriptVersion(s.e.director, versionId, { huellaVista });
      await esperar(300);
      const archivar = archivarEntregable(s.e.consultor, deliverableId);
      const [r1, r2] = await Promise.all([aprobar, archivar]);
      expect(r1.ok).toBe(true); // ya tenía los bloqueos: la archivación espera
      expect(r2.ok).toBe(true);
    });
    const [f] = await query<{ approved_at: Date; archived_at: Date }>(
      `SELECT sv.approved_at, d.archived_at FROM script_versions sv JOIN deliverables d ON d.id = sv.deliverable_id WHERE sv.id = $1`,
      [versionId],
    );
    expect(f!.approved_at.getTime()).toBeLessThanOrEqual(f!.archived_at.getTime());
  });

  it('RESISTE: archivar la CAMPAÑA mientras se aprueba espera a la aprobación; después no se aprueba más', async () => {
    const s = await escenario('QA-F7 carrera campaña');
    const { versionId } = await versionRevisada(s.e);
    const huellaVista = await huellaDe(versionId);
    await conDemora('aprobar', versionId, 1.2, async () => {
      const aprobar = aprobarScriptVersion(s.e.director, versionId, { huellaVista });
      await esperar(300);
      const archivar = archiveCampaign(s.e.admin, s.e.campanaId);
      const [r1, r2] = await Promise.all([aprobar, archivar]);
      expect(r1.ok).toBe(true);
      expect(r2.ok).toBe(true);
    });
    const otra = await versionRevisada(s.e).catch((e: unknown) => e);
    // En una campaña archivada ya no se registran ni se aprueban guiones.
    expect(otra instanceof Error || (otra as { versionId?: string }).versionId === undefined).toBe(true);
  });

  it('RESISTE: crear la versión hija del Brief mientras se aprueba ⇒ la aprobación queda ligada al Brief que regía; su revisión pasa a STALE', async () => {
    const s = await escenario('QA-F7 carrera brief');
    const { versionId } = await versionRevisada(s.e);
    const huellaVista = await huellaDe(versionId);
    await conDemora('aprobar', versionId, 1.2, async () => {
      const aprobar = aprobarScriptVersion(s.e.director, versionId, { huellaVista });
      await esperar(300);
      const hija = crearBriefHijoDePrueba(s.e.admin, s.brief.versionId, {
        cambios: { 'mensaje_principal.one_line': 'Mensaje nuevo aprobado durante la aprobación del guion.' },
      });
      const [r1] = await Promise.all([aprobar, hija]);
      expect(r1.ok).toBe(true);
    });
    const [f] = await query<{ approved_brief_version_id: string; governing: string }>(
      `SELECT sv.approved_brief_version_id, r.governing_brief_version_id AS governing
         FROM script_versions sv JOIN content_analysis_runs r ON r.id = sv.approved_analysis_id WHERE sv.id = $1`,
      [versionId],
    );
    expect(f!.approved_brief_version_id).toBe(s.brief.versionId);
    expect(f!.governing).toBe(f!.approved_brief_version_id);
  });

  it('RESISTE: registrar una V(N+1) mientras se aprueba ⇒ serializadas; la huella vista (con la cabeza vieja) ya no vale si la V(N+1) entró primero', async () => {
    const s = await escenario('QA-F7 carrera registro');
    const { versionId, deliverableId } = await versionRevisada(s.e);
    const huellaVista = await huellaDe(versionId);
    const nueva = await fuenteDeGuionNueva(s.e);
    await conDemora('alta_de_version', deliverableId, 1.2, async () => {
      const registro = registrarVersionDeGuion(s.e.consultor, {
        campaignId: s.e.campanaId,
        sourceId: nueva,
        participation: { participationId: s.e.participaciones.diego },
        deliverable: { id: deliverableId },
      });
      await esperar(300);
      const aprobar = aprobarScriptVersion(s.e.director, versionId, { huellaVista });
      const [r1, r2] = await Promise.all([registro, aprobar]);
      expect(r1.ok).toBe(true);
      // El registro retenía el mutex: la aprobación vio la cabeza NUEVA ⇒ huella vista obsoleta.
      expect(codigo(r2)).toBe('PROPOSAL_STALE');
    });
    expect(await estadoDeVersion(versionId)).toBe('in_review');
  });
});

// ═════════════════════════ Vector H · deadlocks ═══════════════════════════════════

describe('QA-F7-H · orden de bloqueos', () => {
  // Hipótesis descartada: `reactivarEntregable` toma entregable→campaña(FOR SHARE) y aprobar toma campaña(FOR SHARE)→entregable;
  // con un UPDATE de campaña en medio parecía un ciclo, pero un FOR SHARE compatible no hace cola tras el UPDATE pendiente.
  it('RESISTE: reactivar un entregable, aprobar y archivar la campaña a la vez no producen un deadlock (40P01)', async () => {
    const s = await escenario('QA-F7 deadlock');
    const { versionId, deliverableId } = await versionRevisada(s.e);
    valor(await archivarEntregable(s.e.consultor, deliverableId));
    const huellaVista = HUELLA_FALSA;
    const errores: unknown[] = [];
    await dormirEn(
      'deliverables',
      'UPDATE',
      `NEW.id = '${deliverableId}' AND NEW.status = 'active'`,
      2,
      async () => {
        const captura = (p: Promise<unknown>) => p.catch((e: unknown) => errores.push(e));
        const reactivar = captura(reactivarEntregable(s.e.consultor, deliverableId));
        await esperar(400);
        const aprobar = captura(aprobarScriptVersion(s.e.director, versionId, { huellaVista }));
        await esperar(400);
        const archivar = captura(archiveCampaign(s.e.admin, s.e.campanaId));
        await Promise.all([reactivar, aprobar, archivar]);
      },
    );
    const deadlocks = errores.filter((e) => (e as { code?: string }).code === '40P01');
    expect(deadlocks).toHaveLength(0);
  });
});

// Mantener referencias a utilidades importadas para ampliaciones futuras sin ruido de lint.
void evaluarAprobacionDeScript;
void revisarConIA;
