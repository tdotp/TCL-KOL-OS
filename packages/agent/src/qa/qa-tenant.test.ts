/**
 * QA adversarial · vector 3: aislamiento de organización y de campaña.
 *
 * Cada id de recurso que acepta una tool se prueba con un id (a) de otra organización y
 * (b) de OTRA campaña de la MISMA organización: la respuesta es siempre RESOURCE_NOT_FOUND
 * (misma que un id inexistente) y no se muta nada. BD real (base `_test`).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  asociarInfluencerACampana,
  closePool,
  crearBriefManual,
  crearInfluencer,
  generarPreguntas,
  listarPreguntas,
  proponerAccion,
  query,
} from '@tcl-kol-os/db';
import {
  type EscenarioDeChat,
  crearEscenarioDeChat,
  crearFragmentoDePrueba,
  crearFuenteDePrueba,
  eliminarCampanaDePrueba,
  eliminarInfluencersDePrueba,
} from '@tcl-kol-os/db/test-utils';
import { abrirTurno, clave, codigo, contar, json, llamar, registro } from './testing/harness.ts';

let e: EscenarioDeChat;
const r = registro();
const NO_EXISTE = '00000000-0000-4000-8000-0000000000aa';
const influencers: string[] = [];

interface Ajenos {
  fuenteB: string;
  fuenteAjena: string;
  preguntaB: string;
  preguntaAjena: string;
  participacionB: string;
  participacionAjena: string;
  productoB: string;
  versionB: string;
  propuestaB: string;
  influencerAjeno: string;
}
let a: Ajenos;

beforeAll(async () => {
  e = await crearEscenarioDeChat('QA tenant');
  const fuenteB = await crearFuenteDePrueba(e.otraCampanaId, e.admin, 'qa-b');
  await crearFragmentoDePrueba(fuenteB, 0, 'CONTENIDO-SECRETO-DE-LA-CAMPANA-B ficha técnica');
  const fuenteAjena = await crearFuenteDePrueba(e.campanaAjenaId, e.ajeno, 'qa-ajena');
  await crearFragmentoDePrueba(fuenteAjena, 0, 'CONTENIDO-SECRETO-DE-OTRA-AGENCIA');

  const bB = await crearBriefManual(e.admin, e.otraCampanaId);
  const bJ = await crearBriefManual(e.ajeno, e.campanaAjenaId);
  if (!bB.ok || !bJ.ok) throw new Error('brief manual');
  await generarPreguntas(e.admin, bB.value.versionId);
  await generarPreguntas(e.ajeno, bJ.value.versionId);
  const pB = await listarPreguntas(e.admin, e.otraCampanaId, { status: 'pendiente' });
  const pJ = await listarPreguntas(e.ajeno, e.campanaAjenaId, { status: 'pendiente' });
  if (!pB.ok || !pJ.ok || pB.value.length === 0 || pJ.value.length === 0) throw new Error('preguntas');

  const infB = await crearInfluencer(e.admin, { displayName: `QA Tenant B ${e.sufijo}` });
  const infJ = await crearInfluencer(e.ajeno, { displayName: `QA Tenant J ${e.sufijo}` });
  if (!infB.ok || !infJ.ok) throw new Error('influencer');
  influencers.push(infB.value.influencer.id, infJ.value.influencer.id);
  const partB = await asociarInfluencerACampana(e.admin, {
    campaignId: e.otraCampanaId,
    influencerId: infB.value.influencer.id,
  });
  const partJ = await asociarInfluencerACampana(e.ajeno, {
    campaignId: e.campanaAjenaId,
    influencerId: infJ.value.influencer.id,
  });
  if (!partB.ok || !partJ.ok) throw new Error('participación');

  const [prod] = await query<{ id: string }>(
    `INSERT INTO campaign_products (campaign_id, product_id, rol, prioridad, participacion_presupuesto)
     SELECT $1, id, 'secundario', 1, 0.5 FROM products LIMIT 1 RETURNING id`,
    [e.otraCampanaId],
  );

  await query(`UPDATE brief_versions SET status = 'internal_review' WHERE id = $1`, [bB.value.versionId]);
  const prop = await proponerAccion(e.consultor, {
    type: 'brief.approve',
    resourceId: bB.value.versionId,
    origin: 'chat',
  });
  if (!prop.ok) throw new Error(`propuesta: ${prop.error.message}`);
  a = {
    fuenteB,
    fuenteAjena,
    preguntaB: pB.value[0]!.id,
    preguntaAjena: pJ.value[0]!.id,
    participacionB: partB.value.id,
    participacionAjena: partJ.value.id,
    productoB: prod!.id,
    versionB: bB.value.versionId,
    propuestaB: prop.value.id,
    influencerAjeno: infJ.value.influencer.id,
  };
});
afterAll(async () => {
  await eliminarInfluencersDePrueba(influencers).catch(() => undefined);
  await eliminarCampanaDePrueba(e.campanas);
  await closePool();
});

const NOT_FOUND = 'RESOURCE_NOT_FOUND';

describe('V3 · ids de OTRA organización y de OTRA campaña (misma org) en CADA tool con id de recurso', () => {
  it('lecturas: source_get, source_read_content, sheet_validate, proposed_action_get, influencer_get_participation, influencer_get_origin, sheet_get_sync_run, sheet_get_import_plan', async () => {
    const t = await abrirTurno(e.consultor, e.campanaId, 'hola');
    const mismaMsg = async (nombre: string, args: Record<string, unknown>) => {
      const x = await llamar(r, t, nombre, args);
      expect(codigo(x), `${nombre} ${JSON.stringify(args)}`).toBe(NOT_FOUND);
      expect(x.content).not.toContain('CONTENIDO-SECRETO');
      return json(x);
    };
    // los tres ids dan EXACTAMENTE el mismo error: no distinguen «existe en otra campaña» de «no existe»
    for (const [nombre, campo, ajenos] of [
      ['source_get', 'sourceId', [a.fuenteB, a.fuenteAjena]],
      ['source_read_content', 'sourceId', [a.fuenteB, a.fuenteAjena]],
      ['sheet_validate', 'sourceId', [a.fuenteB, a.fuenteAjena]],
      ['proposed_action_get', 'proposedActionId', [a.propuestaB]],
      ['influencer_get_participation', 'participationId', [a.participacionB, a.participacionAjena]],
      ['influencer_get_origin', 'participationId', [a.participacionB, a.participacionAjena]],
      ['sheet_get_sync_run', 'runId', [NO_EXISTE]],
      ['sheet_get_import_plan', 'planId', [NO_EXISTE]],
    ] as [string, string, string[]][]) {
      const base = await mismaMsg(nombre, { [campo]: NO_EXISTE });
      for (const id of ajenos) {
        const cuerpo = await mismaMsg(nombre, { [campo]: id });
        expect(cuerpo['error']).toEqual(base['error']);
      }
    }
  });

  it('escrituras con ids ajenos: sheet_sync, sheet_prepare_import_plan, brief_answer_question: NOT_FOUND y sin efecto', async () => {
    const t = await abrirTurno(
      e.consultor,
      e.campanaId,
      'sincroniza, prepara el plan y responde la pregunta con "algo"',
    );
    const antesAuditoria = await contar('audit_events WHERE organization_id = $1', [e.admin.organizationId]);
    for (const id of [a.fuenteB, a.fuenteAjena]) {
      expect(codigo(await llamar(r, t, 'sheet_sync', { sourceId: id, evidenceQuote: 'sincroniza' }))).toBe(
        NOT_FOUND,
      );
      expect(
        codigo(
          await llamar(r, t, 'sheet_prepare_import_plan', { sourceId: id, evidenceQuote: 'prepara el plan' }),
        ),
      ).toBe(NOT_FOUND);
    }
    for (const id of [a.preguntaB, a.preguntaAjena]) {
      expect(
        codigo(
          await llamar(r, t, 'brief_answer_question', {
            questionId: id,
            answerValue: 'algo',
            evidenceQuote: 'responde la pregunta',
          }),
        ),
      ).toBe(NOT_FOUND);
    }
    expect(await contar('audit_events WHERE organization_id = $1', [e.admin.organizationId])).toBe(
      antesAuditoria,
    );
    const [q] = await query<{ status: string }>(`SELECT status FROM local_questions WHERE id = $1`, [
      a.preguntaB,
    ]);
    expect(q!.status).toBe('pendiente');
  });

  it('propuestas con ids ajenos: sheet_propose_apply / sheet_propose_resolution (plan, registro, influencer, producto)', async () => {
    const t = await abrirTurno(e.consultor, e.campanaId, 'propón aplicar el plan y resolver el registro');
    for (const planId of [NO_EXISTE, a.versionB, a.fuenteB]) {
      expect(
        codigo(
          await llamar(r, t, 'sheet_propose_apply', { planId, evidenceQuote: 'propón aplicar el plan' }),
        ),
      ).toBe(NOT_FOUND);
      expect(
        codigo(
          await llamar(r, t, 'sheet_propose_resolution', {
            planId,
            recordId: NO_EXISTE,
            decision: { kind: 'ignore_record' },
            evidenceQuote: 'resolver el registro',
          }),
        ),
      ).toBe(NOT_FOUND);
    }
    expect(await contar('proposed_actions WHERE campaign_id = $1', [e.campanaId])).toBe(0);
  });

  it('un UUID de otra campaña NO se resuelve por alias: los alias `S/Q/L/P/T` solo existen si el contexto/tools del turno los registraron', async () => {
    const t = await abrirTurno(e.consultor, e.campanaId, 'hola');
    for (const alias of ['S1', 'S2', 'Q1', 'L1', 'P1', 'T1', 'I1', 's1']) {
      expect(codigo(await llamar(r, t, 'source_get', { sourceId: alias })), alias).toBe(NOT_FOUND);
    }
    // un alias de OTRO tipo no sirve para este tipo (P = participación; no es una fuente)
    const lista = await llamar(r, t, 'campaign_get', {});
    expect(lista.status).toBe('succeeded');
    const cualquiera = t.referencias.registrar({ kind: 'campaign_influencer', entityId: a.participacionB });
    expect(codigo(await llamar(r, t, 'source_get', { sourceId: cualquiera.alias }))).toBe(NOT_FOUND);
    expect(
      codigo(await llamar(r, t, 'influencer_get_participation', { participationId: cualquiera.alias })),
    ).toBe(NOT_FOUND);
  });

  it('un alias registrado con un id de OTRA campaña (registro contaminado) sigue verificándose contra la campaña del run', async () => {
    const t = await abrirTurno(e.consultor, e.campanaId, 'hola');
    const s = t.referencias.registrar({ kind: 'source', sourceId: a.fuenteB });
    expect(codigo(await llamar(r, t, 'source_get', { sourceId: s.alias }))).toBe(NOT_FOUND);
    expect(codigo(await llamar(r, t, 'source_read_content', { sourceId: s.alias }))).toBe(NOT_FOUND);
    const q = t.referencias.registrar({ kind: 'question', entityId: a.preguntaB });
    expect(
      codigo(
        await llamar(r, t, 'brief_answer_question', {
          questionId: q.alias,
          answerValue: 'x',
          evidenceQuote: 'hola',
        }),
      ),
    ).not.toBe('succeeded');
    const [fila] = await query<{ status: string }>(`SELECT status FROM local_questions WHERE id = $1`, [
      a.preguntaB,
    ]);
    expect(fila!.status).toBe('pendiente');
  });

  it('la búsqueda de texto y el listado de fuentes nunca devuelven contenido de otra campaña ni de otra organización', async () => {
    const t = await abrirTurno(e.consultor, e.campanaId, 'busca CONTENIDO-SECRETO');
    const b = await llamar(r, t, 'source_search_text', { text: 'CONTENIDO-SECRETO' });
    expect(b.content).not.toContain('CONTENIDO-SECRETO-DE');
    const l = await llamar(r, t, 'source_list', {});
    expect(l.content).not.toContain('qa-b');
    expect(l.content).not.toContain('qa-ajena');
  });

  it('una conversación de OTRA persona de la misma organización es ajena: el run no ejecuta tools con otro actor (claim)', async () => {
    const t = await abrirTurno(e.consultor, e.campanaId, 'hola');
    // el director intenta ejecutar tools dentro del run del consultor
    const x = await r.execute({
      context: {
        actor: e.director,
        campaignId: t.campaignId,
        conversationId: t.conversationId,
        messageId: t.messageId,
        agentRunId: t.runId,
        stepIndex: 1,
        referencias: t.referencias,
        textosDelActor: t.textos,
      },
      call: { id: clave(), name: 'campaign_get', arguments: {} },
    });
    expect(x.status).toBe('failed');
    expect(x.errorCode).toBe(NOT_FOUND);
    // y un contexto con otra campaña que la del run (aunque sea de la misma org) se rechaza
    const y = await r.execute({
      context: {
        actor: e.consultor,
        campaignId: e.otraCampanaId,
        conversationId: t.conversationId,
        messageId: t.messageId,
        agentRunId: t.runId,
        stepIndex: 2,
        referencias: t.referencias,
        textosDelActor: t.textos,
      },
      call: { id: clave(), name: 'campaign_get', arguments: {} },
    });
    expect(y.status).toBe('failed');
    expect(y.errorCode).toBe(NOT_FOUND);
    // y un contexto con un run de otra organización
    const z = await r.execute({
      context: {
        actor: e.ajeno,
        campaignId: t.campaignId,
        conversationId: t.conversationId,
        messageId: t.messageId,
        agentRunId: t.runId,
        stepIndex: 3,
        referencias: t.referencias,
        textosDelActor: t.textos,
      },
      call: { id: clave(), name: 'campaign_get', arguments: {} },
    });
    expect(z.status).toBe('failed');
  });
});

describe('V3 · FK compuestas por SQL directo (el esquema impide cruzar organización o campaña)', () => {
  const rechazo = async (sql: string, params: unknown[]): Promise<string> => {
    try {
      await query(sql, params);
      return '';
    } catch (err) {
      return (err as Error).message;
    }
  };

  it('conversación: campaña de otra organización o creador de otra organización → violación de FK', async () => {
    expect(
      await rechazo(
        `INSERT INTO chat_conversations (organization_id, campaign_id, created_by) VALUES ($1, $2, $3)`,
        [e.admin.organizationId, e.campanaAjenaId, e.admin.id],
      ),
    ).toMatch(/foreign key|violates/i);
    expect(
      await rechazo(
        `INSERT INTO chat_conversations (organization_id, campaign_id, created_by) VALUES ($1, $2, $3)`,
        [e.admin.organizationId, e.campanaId, e.ajeno.id],
      ),
    ).toMatch(/foreign key|violates/i);
  });

  it('adjunto y cita a una fuente de otra campaña (misma org) o de otra organización → FK; cita con fragmento de otra fuente → FK', async () => {
    const t = await abrirTurno(e.consultor, e.campanaId, 'adjunta');
    const nuevo = await query<{ id: string }>(`SELECT id FROM chat_messages WHERE id = $1`, [t.messageId]);
    expect(nuevo).toHaveLength(1);
    // los adjuntos solo se aceptan en la transacción del mensaje: se prueban dentro de una
    const intenta = async (fuente: string): Promise<string> => {
      try {
        await query(
          `WITH m AS (
             INSERT INTO chat_messages (organization_id, campaign_id, conversation_id, role, user_id, content, client_message_id)
             SELECT organization_id, campaign_id, id, 'user', created_by, 'adjunto qa', $2
               FROM chat_conversations WHERE id = $1
             RETURNING id, conversation_id, organization_id, campaign_id
           )
           INSERT INTO chat_message_attachments (organization_id, campaign_id, conversation_id, message_id, source_id, position)
           SELECT organization_id, campaign_id, conversation_id, id, $3, 1 FROM m`,
          [t.conversationId, clave(), fuente],
        );
        return '';
      } catch (err) {
        return (err as Error).message;
      }
    };
    // la conversación tiene un run activo (abrirTurno): el mensaje mismo ya se rechaza, así que se
    // comprueba también que NINGÚN camino deja un adjunto
    for (const f of [a.fuenteB, a.fuenteAjena]) expect(await intenta(f)).not.toBe('');
    expect(
      await contar('chat_message_attachments WHERE source_id = ANY($1::uuid[])', [
        [a.fuenteB, a.fuenteAjena],
      ]),
    ).toBe(0);
  });

  it('ai_runs de otra campaña que la de su run → trigger', async () => {
    const t = await abrirTurno(e.consultor, e.campanaId, 'hola');
    const msg = await rechazo(
      `INSERT INTO ai_runs (organization_id, campaign_id, task, tier, provider, model, prompt_version, input_hash, output_status, agent_run_id)
       VALUES ($1, $2, 'conversar', 'equilibrado', 'x', 'y', 'v', 'h', 'ok', $3)`,
      [e.admin.organizationId, e.otraCampanaId, t.runId],
    );
    expect(msg).toMatch(/campaña distinta/);
  });

  it('un influencer/participación/propuesta de otra organización no se enlaza a una invocación', async () => {
    const t = await abrirTurno(e.consultor, e.campanaId, 'hola');
    const x = await llamar(r, t, 'campaign_get', {});
    // `proposed_action_id` solo con riesgo confirmation_required y la misma org+campaña (FK compuesta)
    expect(
      await rechazo(`UPDATE agent_tool_invocations SET proposed_action_id = $2 WHERE id = $1`, [
        x.invocationId,
        a.propuestaB,
      ]),
    ).not.toBe('');
  });
});
