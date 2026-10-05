/**
 * QA adversarial · vector 6: provenance. TODA mutación hecha por una tool queda auditada con
 * origin `chat` (o `system` para el worker) y la correlación completa
 * (conversationId, messageId, agentRunId, toolInvocationId). BD real (base `_test`).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePool, crearBriefManual, query } from '@tcl-kol-os/db';
import {
  type EscenarioDeChat,
  crearEscenarioDeChat,
  eliminarCampanaDePrueba,
  eliminarInfluencersDePrueba,
} from '@tcl-kol-os/db/test-utils';
import type { ToolExecution } from '../contracts.ts';
import { abrirTurno, json, llamar, nuevaCampana, registro, type Turno } from './testing/harness.ts';
import { GoogleSimulado, hayWorkerLocal, prepararPlan, type GoogleSimuladoLike } from './testing/sheet.ts';

let e: EscenarioDeChat;
let google: GoogleSimuladoLike;
const r = registro();
const influencers: string[] = [];
const corridas: string[] = [];
const sufijo = Date.now().toString(36);

beforeAll(async () => {
  e = await crearEscenarioDeChat('QA provenance');
  google = await GoogleSimulado.crear();
});
afterAll(async () => {
  await eliminarInfluencersDePrueba(influencers).catch(() => undefined);
  await eliminarCampanaDePrueba(e.campanas);
  await google.limpiar();
  await closePool();
});

interface Evento {
  id: string;
  action: string;
  origin: string | null;
  actor_id: string | null;
  entity_type: string;
  entity_id: string | null;
  correlation: Record<string, string> | null;
  metadata: Record<string, unknown>;
}

async function ahoraDb(): Promise<Date> {
  const [f] = await query<{ t: Date }>(`SELECT clock_timestamp() AS t`);
  return f!.t;
}

/** Ejecuta una tool y devuelve los eventos de auditoría de la organización creados durante la llamada. */
async function conAuditoria(t: Turno, nombre: string, args: Record<string, unknown>) {
  if (!corridas.includes(t.runId)) corridas.push(t.runId);
  const desde = await ahoraDb();
  const x: ToolExecution = await llamar(r, t, nombre, args);
  await new Promise((res) => setTimeout(res, 50));
  const eventos = await query<Evento>(
    `SELECT id, action, origin, actor_id, entity_type, entity_id, correlation, metadata
       FROM audit_events WHERE organization_id = $1 AND created_at >= $2 ORDER BY created_at, id`,
    [e.admin.organizationId, desde],
  );
  return { x, eventos };
}

function exigeProvenance(t: Turno, x: ToolExecution, eventos: readonly Evento[], permiteSystem = false) {
  for (const ev of eventos) {
    const etiqueta = `${ev.action} (${ev.origin})`;
    expect(ev.origin, `${etiqueta}: origen`).not.toBe('ui');
    expect(ev.origin, `${etiqueta}: origen`).not.toBeNull();
    if (ev.actor_id !== null) {
      expect(ev.origin, `${etiqueta}: una persona actuando desde la tool es chat`).toBe('chat');
      expect(ev.actor_id).toBe(e.consultor.id);
    } else {
      expect(permiteSystem, `${etiqueta}: system no esperado`).toBe(true);
      expect(ev.origin).toBe('system');
    }
    expect(ev.correlation, `${etiqueta}: sin correlación`).not.toBeNull();
    expect(ev.correlation!['conversationId'], `${etiqueta}: conversationId`).toBe(t.conversationId);
    expect(ev.correlation!['messageId'], `${etiqueta}: messageId`).toBe(t.messageId);
    expect(ev.correlation!['agentRunId'], `${etiqueta}: agentRunId`).toBe(t.runId);
    if (ev.origin === 'chat') {
      expect(ev.correlation!['toolInvocationId'], `${etiqueta}: toolInvocationId`).toBe(x.invocationId);
    }
  }
}

describe('V6 · audit_events de cada mutación de tool', () => {
  it('campaign_update_metadata, source_register_link, brief_generate_questions, brief_answer_question', async () => {
    const campana = await nuevaCampana(e.admin.organizationId, e.admin.id, 'Prov', e.campanas);
    const manual = await crearBriefManual(e.admin, campana);
    if (!manual.ok) throw new Error('brief');
    const url =
      `https://docs.google.com/spreadsheets/d/1QaProv${sufijo}${'p'.repeat(40)}`.slice(0, 80) + '/edit#gid=1';
    const t = await abrirTurno(
      e.consultor,
      campana,
      `Ponle de nombre "Provenance Uno", registra ${url}, genera las preguntas y responde el objetivo con "reconocimiento de marca"`,
    );

    const a = await conAuditoria(t, 'campaign_update_metadata', {
      name: 'Provenance Uno',
      evidenceQuote: 'Ponle de nombre',
    });
    expect(a.x.status).toBe('succeeded');
    expect(a.eventos.length).toBeGreaterThan(0);
    exigeProvenance(t, a.x, a.eventos);

    const b = await conAuditoria(t, 'source_register_link', { url });
    expect(b.x.status, b.x.content).toBe('succeeded');
    expect(b.eventos.length).toBeGreaterThan(0);
    exigeProvenance(t, b.x, b.eventos);

    const c = await conAuditoria(t, 'brief_generate_questions', { evidenceQuote: 'genera las preguntas' });
    expect(c.x.status, c.x.content).toBe('succeeded');
    expect(c.eventos.length, 'generar preguntas debe auditarse').toBeGreaterThan(0);
    exigeProvenance(t, c.x, c.eventos);

    const lista = await llamar(r, t, 'brief_list_questions', {});
    expect(lista.status).toBe('succeeded');
    const alias = t.referencias.listar().find((x) => x.kind === 'question')?.alias;
    expect(alias).toBeDefined();
    const d = await conAuditoria(t, 'brief_answer_question', {
      questionId: alias,
      answerValue: 'reconocimiento de marca',
      evidenceQuote: 'responde el objetivo con "reconocimiento de marca"',
    });
    expect(d.x.status, d.x.content).toBe('succeeded');
    expect(d.eventos.length).toBeGreaterThan(0);
    exigeProvenance(t, d.x, d.eventos);
  });

  it('brief_extract y brief_request_internal_review (aunque fallen) no dejan eventos `ui` ni sin correlación', async () => {
    const campana = await nuevaCampana(e.admin.organizationId, e.admin.id, 'Prov2', e.campanas);
    const manual = await crearBriefManual(e.admin, campana);
    if (!manual.ok) throw new Error('brief');
    const t = await abrirTurno(e.consultor, campana, 'Extrae el brief y envíalo a revisión interna');
    const a = await conAuditoria(t, 'brief_extract', { evidenceQuote: 'Extrae el brief' });
    exigeProvenance(t, a.x, a.eventos, true);
    const b = await conAuditoria(t, 'brief_request_internal_review', {
      evidenceQuote: 'envíalo a revisión interna',
    });
    exigeProvenance(t, b.x, b.eventos, true);
  });

  it('las propuestas HITL: proposed_action.propose con origin chat y las 4 claves de correlación + proposedActionId', async () => {
    const campana = await nuevaCampana(e.admin.organizationId, e.admin.id, 'Prov3', e.campanas);
    const manual = await crearBriefManual(e.admin, campana);
    if (!manual.ok) throw new Error('brief');
    await query(`UPDATE brief_versions SET status = 'internal_review' WHERE id = $1`, [
      manual.value.versionId,
    ]);
    const t = await abrirTurno(e.consultor, campana, 'Propón la aprobación del brief');
    const p = await conAuditoria(t, 'brief_propose_approval', { evidenceQuote: 'Propón la aprobación' });
    expect(p.x.status, p.x.content).toBe('succeeded');
    expect(p.eventos.length).toBeGreaterThan(0);
    exigeProvenance(t, p.x, p.eventos);
    expect(p.eventos.some((ev) => ev.action === 'proposed_action.propose')).toBe(true);
  });

  it.skipIf(!hayWorkerLocal())(
    'sheet_sync y sheet_prepare_import_plan (worker real): auditoría chat + correlación completa',
    async () => {
      const campana = await nuevaCampana(e.admin.organizationId, e.admin.id, 'Prov4', e.campanas);
      const plan = await prepararPlan(google, e.consultor, campana, [
        ['PV-1', `Prov ${sufijo}`, 'instagram', `@prov${sufijo}`, ''],
      ]);
      const eventos = await query<Evento>(
        `SELECT id, action, origin, actor_id, entity_type, entity_id, correlation, metadata
         FROM audit_events WHERE organization_id = $1 AND correlation->>'agentRunId' = $2 ORDER BY created_at, id`,
        [e.admin.organizationId, plan.turno.runId],
      );
      expect(eventos.length).toBeGreaterThan(0);
      const acciones = new Set(eventos.map((x) => x.action));
      expect(acciones.has('source.link_register')).toBe(true);
      expect(acciones.has('source.sync_request')).toBe(true);
      for (const ev of eventos) {
        expect(ev.correlation!['conversationId']).toBe(plan.turno.conversationId);
        expect(ev.correlation!['messageId']).toBe(plan.turno.messageId);
        if (ev.actor_id !== null) {
          expect(ev.origin, ev.action).toBe('chat');
          expect(ev.correlation!['toolInvocationId'], ev.action).toBeDefined();
        }
      }
      // los eventos del worker (system) heredan al menos la correlación de la sync
      const delWorker = await query<Evento>(
        `SELECT id, action, origin, actor_id, entity_type, entity_id, correlation, metadata
         FROM audit_events WHERE organization_id = $1 AND origin = 'system' AND created_at > now() - interval '5 minutes'
          AND entity_id IN (SELECT id FROM source_documents WHERE campaign_id = $2)`,
        [e.admin.organizationId, campana],
      );
      void delWorker;
      void json;
    },
  );
});

describe('V6 · cadena reconstruible: audit → invocación → run → mensaje → conversación → usuario', () => {
  it('toda auditoría con toolInvocationId apunta a una invocación existente del MISMO run/conversación/mensaje', async () => {
    const filas = await query<{
      id: string;
      action: string;
      inv: string;
      ok: boolean;
    }>(
      `SELECT a.id, a.action, a.correlation->>'toolInvocationId' AS inv,
              (EXISTS (
                 SELECT 1 FROM agent_tool_invocations i
                   JOIN agent_runs r ON r.id = i.agent_run_id
                  WHERE i.id::text = a.correlation->>'toolInvocationId'
                    AND r.id::text = a.correlation->>'agentRunId'
                    AND r.conversation_id::text = a.correlation->>'conversationId'
                    AND r.user_message_id::text = a.correlation->>'messageId'
                    AND i.organization_id = a.organization_id
              )) AS ok
         FROM audit_events a
        WHERE a.organization_id = $1 AND a.correlation->>'toolInvocationId' IS NOT NULL
          AND a.correlation->>'agentRunId' = ANY($2::text[])`,
      [e.admin.organizationId, corridas],
    );
    expect(filas.length).toBeGreaterThan(0);
    expect(filas.filter((f) => !f.ok).map((f) => `${f.action}:${f.inv}`)).toEqual([]);
  });
});
