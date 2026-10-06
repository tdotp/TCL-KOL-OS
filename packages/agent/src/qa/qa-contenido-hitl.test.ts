/**
 * QA de runtime · HITL del contenido (V2 · Fase 7): «aprueba el guion de Valentina».
 *
 * El agente (ScriptedModel + REGISTRO REAL + runtime real + BD real `_test`) solo PROPONE. La versión sigue
 * sin aprobar, sin ningún evento de aprobación; aprobar lo decide una persona con `script:approve` por el
 * canal `ui`, y solo si la huella de lo que vio sigue vigente. Quien no tiene la capacidad (consultor), el
 * chat y el sistema no pueden. Una confirmación vieja (el Brief cambió, hay un comentario nuevo) es
 * PROPOSAL_STALE y no aprueba.
 *
 * La veracidad del TEXTO final del modelo («quedó aprobado») es política de prompt, no de código: aquí se
 * comprueba la verdad en la base y que el resultado de la tool dice «NO se aplicó nada».
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type * as DbModule from '@tcl-kol-os/db';
import {
  closePool,
  confirmarAccion,
  crearComentarioDeRevision,
  crearEntregable,
  derivarNonce,
  ejecutarAccion,
  query,
  solicitarAnalisisDeGuion,
} from '@tcl-kol-os/db';
import { crearBriefHijoDePrueba, limpiarEscenarioDeContenido } from '@tcl-kol-os/db/test-utils';
import type { User } from '@tcl-kol-os/domain';
import { ScriptedModel, respuestaConTools, respuestaFinal } from '../model/scripted-model.ts';
import type { ModelTurnRequest } from '../contracts.ts';
import { ejecutarRun } from '../runtime/ejecutar-run.ts';
import {
  SECRETO_DE_PRUEBA,
  admitir,
  dependencias,
  entornoDePrueba,
  filaDelRun,
  nuevaConversacion,
  valor,
} from '../runtime/testing/harness.ts';
import { createToolRegistry } from '../tools/registry.ts';
import {
  type EstadoDeAnalisis,
  type MundoDeContenido,
  clienteQueResponde,
  crearMundoDeContenido,
  registrarVersionDePrueba,
} from './testing/contenido.ts';
import { contar } from './testing/harness.ts';

const analisis = vi.hoisted(() => ({ cliente: undefined, iaActiva: true }) as EstadoDeAnalisis);
vi.mock('@tcl-kol-os/db', async (importOriginal) => {
  const real = await importOriginal<typeof DbModule>();
  return {
    ...real,
    solicitarAnalisisDeGuion: (
      actor: Parameters<typeof real.solicitarAnalisisDeGuion>[0],
      versionId: string,
      input: Parameters<typeof real.solicitarAnalisisDeGuion>[2],
      contexto?: Parameters<typeof real.solicitarAnalisisDeGuion>[3],
    ) =>
      real.solicitarAnalisisDeGuion(actor, versionId, input, contexto, {
        ...(analisis.cliente === undefined ? {} : { cliente: analisis.cliente }),
        env: (n: string) =>
          n === 'AI_ENABLED' ? String(analisis.iaActiva) : n === 'AI_PROVIDER' ? 'fake' : undefined,
      }),
  };
});

const registry = createToolRegistry({
  nonceForRun: (runId) => derivarNonce(SECRETO_DE_PRUEBA, runId),
  onUnexpectedError: () => undefined,
});

let m: MundoDeContenido;
let iaAntes: string | undefined;
let contador = 0;

beforeAll(async () => {
  iaAntes = process.env['AI_ENABLED'];
  process.env['AI_ENABLED'] = 'true';
  m = await crearMundoDeContenido('QA contenido · HITL');
});
afterAll(async () => {
  if (iaAntes === undefined) delete process.env['AI_ENABLED'];
  else process.env['AI_ENABLED'] = iaAntes;
  await limpiarEscenarioDeContenido(m.e);
  await closePool();
});

/**
 * El alias V… que `deliverable_list` le dio al modelo para el entregable con esa etiqueta: se lee del resultado
 * de la tool (lo que el modelo realmente vio), no se supone.
 */
function aliasDeVersionVisto(peticion: ModelTurnRequest, etiqueta: string): string {
  const tools = peticion.messages.filter((x) => x.role === 'tool');
  const ultimo = tools[tools.length - 1];
  const cuerpo = ultimo === undefined ? '{}' : ultimo.content;
  const lista = String((JSON.parse(cuerpo) as { deliverables?: string }).deliverables ?? '');
  const linea = lista.split('\n').find((l) => l.includes(etiqueta));
  const alias = linea === undefined ? undefined : /última (V\d+)/.exec(linea)?.[1];
  if (alias === undefined)
    throw new Error(`el modelo no vio la versión de «${etiqueta}» en: ${cuerpo.slice(0, 300)}`);
  return alias;
}

/** Un entregable NUEVO con una versión en revisión y una revisión CURRENT (análisis guionado), lista para proponer. */
async function versionEnRevision(): Promise<{ versionId: string; entregableId: string; etiqueta: string }> {
  contador += 1;
  const etiqueta = `Pieza QA HITL ${contador}`;
  const e = await crearEntregable(m.e.consultor, {
    campaignInfluencerId: m.e.participaciones.valentinaRios,
    label: etiqueta,
  });
  if (!e.ok) throw new Error(e.error.message);
  const v = await registrarVersionDePrueba(m.e, e.value.id, m.e.participaciones.valentinaRios);
  analisis.cliente = clienteQueResponde([
    {
      category: 'cta_missing',
      refs: ['accion_kpis.accion_esperada'],
      description: 'Falta la llamada a la acción.',
    },
  ]);
  const a = await solicitarAnalisisDeGuion(m.e.consultor, v.versionId, {
    mode: 'ensure',
    idempotencyKey: `qa-hitl-${Date.now().toString(36)}-${contador}`,
  });
  if (!a.ok) throw new Error(`análisis: ${a.error.code}`);
  return { versionId: v.versionId, entregableId: e.value.id, etiqueta };
}

/** El agente (consultor) recibe «aprueba el guion de Valentina» y propone con la cita de la persona. */
async function agenteProponeAprobar(etiqueta: string, texto = 'aprueba el guion de Valentina') {
  const ent = entornoDePrueba();
  const conv = await nuevaConversacion(m.e.consultor, m.e.campanaId);
  const t = await admitir(m.e.consultor, conv, texto, ent);
  const modelo = new ScriptedModel([
    respuestaConTools([{ id: 'l1', name: 'deliverable_list', arguments: { limit: 50 } }]),
    (req) =>
      respuestaConTools([
        {
          id: 'p1',
          name: 'script_propose_approval',
          arguments: { versionId: aliasDeVersionVisto(req, etiqueta), evidenceQuote: texto },
        },
      ]),
    respuestaFinal('Dejé una propuesta pendiente de tu confirmación; no se aprobó nada.'),
  ]);
  const r = valor(await ejecutarRun(m.e.consultor, t.run.id, dependencias(modelo, registry, ent)));
  return { t, r, modelo, ent };
}

const estadoVersion = async (id: string) =>
  (
    await query<{ status: string; approved_at: Date | null; approved_by: string | null }>(
      `SELECT status::text, approved_at, approved_by FROM script_versions WHERE id = $1`,
      [id],
    )
  )[0]!;

const propuestasDe = async (versionId: string) =>
  query<{
    id: string;
    status: string;
    proposed_origin: string;
    action_type: string;
    payload_hash: string;
    correlation: Record<string, string>;
  }>(
    `SELECT id, status, proposed_origin, action_type, payload_hash, correlation FROM proposed_actions WHERE resource_id = $1 ORDER BY created_at`,
    [versionId],
  );

describe('«aprueba el guion de Valentina»: el agente propone, la versión NO se aprueba', () => {
  it('AgentRun completed → ProposedAction pending (origen chat, correlación completa); la versión intacta y 0 eventos de aprobación', async () => {
    const { versionId, entregableId, etiqueta } = await versionEnRevision();
    const antes = await estadoVersion(versionId);
    expect(antes.status).toBe('in_review');

    const { t, r } = await agenteProponeAprobar(etiqueta);
    expect(r).toMatchObject({ salida: 'completed', status: 'completed', toolCalls: 2 });
    expect((await filaDelRun(m.e.consultor, t.run.id)).status).toBe('completed');

    const ps = await propuestasDe(versionId);
    expect(ps).toHaveLength(1);
    expect(ps[0]).toMatchObject({
      status: 'pending',
      proposed_origin: 'chat',
      action_type: 'script_version.approve',
    });
    expect(ps[0]!.correlation).toMatchObject({
      conversationId: t.conversationId,
      messageId: t.mensaje.id,
      agentRunId: t.run.id,
    });
    expect(ps[0]!.correlation['toolInvocationId']).toBeDefined();
    const [inv] = await query<{ proposed_action_id: string; id: string }>(
      `SELECT id, proposed_action_id FROM agent_tool_invocations WHERE agent_run_id = $1 AND tool_name = 'script_propose_approval'`,
      [t.run.id],
    );
    expect(inv?.proposed_action_id).toBe(ps[0]!.id);
    expect(inv?.id).toBe(ps[0]!.correlation['toolInvocationId']);

    // La versión NO cambió: ni estado, ni marcas de aprobación; ningún evento de aprobación.
    const despues = await estadoVersion(versionId);
    expect(despues).toMatchObject({ status: 'in_review', approved_at: null, approved_by: null });
    expect(
      await contar(
        `audit_events WHERE entity_id = $1 AND action IN ('script_version.approve', 'deliverable.current_approved_changed')`,
        [versionId],
      ),
    ).toBe(0);
    expect(
      await contar(`script_versions WHERE deliverable_id = $1 AND status = 'approved'`, [entregableId]),
    ).toBe(0);
  });

  it('un modelo que MIENTE («quedó aprobado») no cambia la verdad en la base: la tool dijo «NO se aplicó nada»', async () => {
    const { versionId, etiqueta } = await versionEnRevision();
    const ent = entornoDePrueba();
    const conv = await nuevaConversacion(m.e.consultor, m.e.campanaId);
    const t = await admitir(m.e.consultor, conv, 'aprueba el guion de Valentina', ent);
    const modelo = new ScriptedModel([
      respuestaConTools([{ id: 'l1', name: 'deliverable_list', arguments: { limit: 50 } }]),
      (req) =>
        respuestaConTools([
          {
            id: 'p1',
            name: 'script_propose_approval',
            arguments: {
              versionId: aliasDeVersionVisto(req, etiqueta),
              evidenceQuote: 'aprueba el guion de Valentina',
            },
          },
        ]),
      respuestaFinal('Listo: el guion de Valentina quedó aprobado.'),
    ]);
    const r = valor(await ejecutarRun(m.e.consultor, t.run.id, dependencias(modelo, registry, ent)));
    expect(r.salida).toBe('completed');
    const resultado = modelo.requests[2]!.messages.filter((x) => x.role === 'tool').pop()!;
    expect(resultado.content).toContain('NO se aplicó nada');
    expect((await estadoVersion(versionId)).status).toBe('in_review');
    expect((await propuestasDe(versionId))[0]!.status).toBe('pending');
  });
});

describe('quién puede confirmar y por qué canal', () => {
  it('rol sin capacidad ⇒ FORBIDDEN_ROLE; canal chat/system ⇒ HUMAN_CONFIRMATION_REQUIRED; huella equivocada ⇒ error; nada se aprueba', async () => {
    const { versionId, etiqueta } = await versionEnRevision();
    await agenteProponeAprobar(etiqueta);
    const [p] = await propuestasDe(versionId);

    // el consultor propuso pero no tiene `script:approve`
    const sinCapacidad = await confirmarAccion(m.e.consultor, p!.id, {
      canal: 'ui',
      payloadHash: p!.payload_hash,
    });
    expect(!sinCapacidad.ok && sinCapacidad.error.code).toBe('FORBIDDEN_ROLE');
    // otros roles sin la capacidad (operativo, analista, legal, cliente): tampoco
    for (const u of [m.e.operativo, m.e.analista, m.e.legal, m.e.cliente] as User[]) {
      const x = await confirmarAccion(u, p!.id, { canal: 'ui', payloadHash: p!.payload_hash });
      expect(x.ok, u.role).toBe(false);
    }
    // el canal chat / system nunca confirma, aunque quien lo pida sea director
    for (const canal of ['chat', 'system'] as const) {
      const c = await confirmarAccion(m.e.director, p!.id, { canal, payloadHash: p!.payload_hash });
      expect(!c.ok && c.error.code, `confirmar ${canal}`).toBe('HUMAN_CONFIRMATION_REQUIRED');
      const x = await ejecutarAccion(m.e.director, p!.id, { canal });
      expect(!x.ok && x.error.code, `ejecutar ${canal}`).toBe('HUMAN_CONFIRMATION_REQUIRED');
    }
    expect((await confirmarAccion('system', p!.id, { canal: 'ui', payloadHash: p!.payload_hash })).ok).toBe(
      false,
    );
    // una huella equivocada no confirma
    for (const h of ['a'.repeat(64), '', p!.payload_hash.toUpperCase()]) {
      const c = await confirmarAccion(m.e.director, p!.id, { canal: 'ui', payloadHash: h });
      expect(!c.ok && c.error.code, h.slice(0, 6)).toBe('PROPOSAL_STALE');
    }
    expect((await propuestasDe(versionId))[0]!.status).toBe('pending');
    expect((await estadoVersion(versionId)).status).toBe('in_review');
  });

  it('el director confirma y ejecuta por la UI ⇒ versión aprobada, auditoría origen ui con la propuesta; doble ejecución = una vez', async () => {
    const { versionId, etiqueta } = await versionEnRevision();
    const { t } = await agenteProponeAprobar(etiqueta);
    const [p] = await propuestasDe(versionId);

    const c = await confirmarAccion(m.e.director, p!.id, { canal: 'ui', payloadHash: p!.payload_hash });
    expect(c.ok, !c.ok ? c.error.message : '').toBe(true);
    expect((await estadoVersion(versionId)).status).toBe('in_review'); // confirmar no aprueba
    const x = await ejecutarAccion(m.e.director, p!.id, { canal: 'ui' });
    expect(x.ok, !x.ok ? `${x.error.code}: ${x.error.message}` : '').toBe(true);

    const v = await estadoVersion(versionId);
    expect(v.status).toBe('approved');
    expect(v.approved_by).toBe(m.e.director.id);

    const ev = await query<{ origin: string; correlation: Record<string, string> | null }>(
      `SELECT origin, correlation FROM audit_events WHERE entity_id = $1 AND action = 'script_version.approve'`,
      [versionId],
    );
    expect(ev).toHaveLength(1);
    expect(ev[0]!.origin).toBe('ui');
    expect(ev[0]!.correlation?.['proposedActionId']).toBe(p!.id);
    // la decisión humana nunca lleva la correlación de la tool del agente
    expect(ev[0]!.correlation?.['toolInvocationId']).toBeUndefined();
    expect(ev[0]!.correlation?.['agentRunId']).not.toBe(t.run.id);

    for (let i = 0; i < 3; i += 1) {
      const rep = await ejecutarAccion(m.e.director, p!.id, { canal: 'ui' });
      expect(!rep.ok && rep.error.code).toBe('PROPOSAL_INVALID_STATE');
    }
    expect(
      await contar(`audit_events WHERE entity_id = $1 AND action = 'script_version.approve'`, [versionId]),
    ).toBe(1);
  });
});

describe('variante STALE: lo que vio la persona ya no es lo que hay', () => {
  it('el Brief gobernante cambió entre la propuesta y la confirmación ⇒ PROPOSAL_STALE y la versión sigue sin aprobar', async () => {
    const { versionId, etiqueta } = await versionEnRevision();
    await agenteProponeAprobar(etiqueta);
    const [p] = await propuestasDe(versionId);
    // un Brief hijo aprobado pasa a ser el rector: la revisión queda desactualizada
    await crearBriefHijoDePrueba(m.e.admin, m.brief.versionId, {
      cambios: { 'mensaje_principal.one_line': 'Un mensaje principal distinto tras la propuesta.' },
    });
    const c = await confirmarAccion(m.e.director, p!.id, { canal: 'ui', payloadHash: p!.payload_hash });
    expect(!c.ok && c.error.code).toBe('PROPOSAL_STALE');
    expect((await estadoVersion(versionId)).status).toBe('in_review');
    expect(
      await contar(`audit_events WHERE entity_id = $1 AND action = 'script_version.approve'`, [versionId]),
    ).toBe(0);
  });

  it('se añadió un comentario entre confirmar y ejecutar ⇒ PROPOSAL_STALE al ejecutar; sin aprobar', async () => {
    const { versionId, etiqueta } = await versionEnRevision();
    await agenteProponeAprobar(etiqueta);
    const [p] = await propuestasDe(versionId);
    expect(
      (await confirmarAccion(m.e.director, p!.id, { canal: 'ui', payloadHash: p!.payload_hash })).ok,
    ).toBe(true);
    // la persona (por la UI) comenta la versión antes de ejecutar
    const comentario = await crearComentarioDeRevision(m.e.consultor, versionId, {
      kind: 'editorial',
      body: 'Revisar el tono del cierre antes de aprobar',
    });
    expect(comentario.ok).toBe(true);
    const x = await ejecutarAccion(m.e.director, p!.id, { canal: 'ui' });
    expect(!x.ok && x.error.code).toBe('PROPOSAL_STALE');
    expect((await estadoVersion(versionId)).status).toBe('in_review');
  });
});
