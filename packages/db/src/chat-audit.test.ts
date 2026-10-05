/**
 * V2 · Fase 6 — auditoría y traza del chat.
 *
 * Cada efecto de una tool queda en `audit_events` con origen `chat` y la
 * correlación completa {conversationId, messageId, agentRunId, toolInvocationId};
 * `chat-trace` reconstruye usuario → conversación → mensaje → run → tool → efecto.
 * Los eventos del chat no llevan contenido de mensajes y no aparecen en la
 * actividad del brief que ve el cliente.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Result, User } from '@tcl-kol-os/domain';
import { closePool, getPool, query, transaction } from './client.ts';
import { listBriefActivity, recordAudit, sanitizeCorrelation, validarCorrelacion } from './audit.ts';
import { archivarConversacion, crearConversacion } from './chat-conversations.ts';
import { publicarMensaje } from './chat-messages.ts';
import { cancelarRun, completarRun, iniciarRun } from './agent-runs.ts';
import { cerrarInvocacion, reclamarInvocacion } from './agent-tool-invocations.ts';
import { trazaDeAccionPropuesta, trazaDeConversacion, trazaDeInvocacion, trazaDeRun } from './chat-trace.ts';
import { registerLinkedSource } from './sources.ts';
import {
  CONFIG_DE_RUN_DE_PRUEBA,
  type EscenarioDeChat,
  crearEscenarioDeChat,
  eliminarCampanaDePrueba,
} from './test-utils.ts';

let e: EscenarioDeChat;
let contador = 0;
const HASH = 'c'.repeat(64);
const TEXTO_SENSIBLE = 'CONTENIDO-CONFIDENCIAL-DEL-MENSAJE-7731';

function valor<T>(r: Result<T>): T {
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
  return r.value;
}
const clave = () => `cm-aud-${Date.now().toString(36)}-${++contador}-xxxxxxxx`;
const SHEET = (n: string) =>
  `https://docs.google.com/spreadsheets/d/1Aud${n}${e.sufijo}${'y'.repeat(30)}/edit`.slice(0, 84);

async function turno(dueno: User = e.consultor, contenido = 'Registra este Sheet') {
  const conv = valor(await crearConversacion(dueno, { campaignId: e.campanaId }));
  const p = valor(
    await publicarMensaje(dueno, {
      conversationId: conv.id,
      clientMessageId: clave(),
      content: contenido,
      runConfig: CONFIG_DE_RUN_DE_PRUEBA,
    }),
  );
  const run = valor(await iniciarRun(dueno, p.run.id, { contextHash: HASH, contextManifest: {} }));
  return { conv, mensaje: p.message, run };
}

beforeAll(async () => {
  e = await crearEscenarioDeChat('Auditoría del chat');
});

afterAll(async () => {
  await eliminarCampanaDePrueba(e.campanas);
  await closePool();
});

describe('correlación con toolInvocationId', () => {
  it('se conserva junto al resto de las claves y se sanea como las demás', () => {
    expect(
      sanitizeCorrelation({
        conversationId: 'c',
        messageId: 'm',
        agentRunId: 'r',
        toolInvocationId: 't',
        proposedActionId: 'p',
        extra: 'x',
      } as never),
    ).toEqual({
      conversationId: 'c',
      messageId: 'm',
      agentRunId: 'r',
      toolInvocationId: 't',
      proposedActionId: 'p',
    });
    expect(sanitizeCorrelation({ toolInvocationId: 5 } as never)).toBeNull();
  });

  it('solo se registra con origen chat: ni la interfaz ni el sistema lo usan', async () => {
    expect(() => validarCorrelacion('ui', { toolInvocationId: 't' })).toThrow(
      /solo se registra con origen chat/,
    );
    expect(() => validarCorrelacion('system', { toolInvocationId: 't' })).toThrow(
      /solo se registra con origen chat/,
    );
    expect(() => validarCorrelacion('chat', { toolInvocationId: 't' })).not.toThrow();
    expect(() => validarCorrelacion('ui', { conversationId: 'c', proposedActionId: 'p' })).not.toThrow();

    await expect(
      transaction((client) =>
        recordAudit(client, {
          actor: e.consultor,
          action: 'test.herramienta_ui',
          entityType: 'source_document',
          origin: 'ui',
          correlation: { toolInvocationId: 't' },
        }),
      ),
    ).rejects.toThrow(/solo se registra con origen chat/);
    await expect(
      transaction((client) =>
        recordAudit(client, {
          actor: 'system',
          organizationId: e.admin.organizationId,
          action: 'test.herramienta_system',
          entityType: 'source_document',
          correlation: { toolInvocationId: 't' },
        }),
      ),
    ).rejects.toThrow();
  });

  it('la coherencia actor↔origen sigue intacta: una persona puede ser chat, nunca system', async () => {
    await transaction((client) =>
      recordAudit(client, {
        actor: e.consultor,
        action: 'test.chat_completo',
        entityType: 'source_document',
        origin: 'chat',
        correlation: { conversationId: 'c-1', messageId: 'm-1', agentRunId: 'r-1', toolInvocationId: 't-1' },
      }),
    );
    const [fila] = await query<{ origin: string; correlation: unknown }>(
      `SELECT origin, correlation FROM audit_events WHERE action = 'test.chat_completo' AND organization_id = $1
        ORDER BY created_at DESC LIMIT 1`,
      [e.admin.organizationId],
    );
    expect(fila).toEqual({
      origin: 'chat',
      correlation: { conversationId: 'c-1', messageId: 'm-1', agentRunId: 'r-1', toolInvocationId: 't-1' },
    });
    await expect(
      transaction((client) =>
        recordAudit(client, {
          actor: e.consultor,
          action: 'test.persona_system',
          entityType: 'source_document',
          origin: 'system',
        }),
      ),
    ).rejects.toThrow(/persona no puede registrarse con origen system/);
  });
});

describe('auditoría del ciclo de la conversación y del run', () => {
  it('crear y archivar quedan auditados con origen ui, entity_type conversation y sin contenido', async () => {
    const conv = valor(
      await crearConversacion(e.consultor, { campaignId: e.campanaId, title: 'Título visible' }),
    );
    valor(await archivarConversacion(e.consultor, conv.id));
    const eventos = await query<{
      action: string;
      origin: string;
      entity_type: string;
      actor_id: string;
      correlation: Record<string, string>;
      metadata: Record<string, unknown>;
    }>(
      `SELECT action, origin, entity_type, actor_id, correlation, metadata FROM audit_events
        WHERE entity_id = $1 ORDER BY created_at, id`,
      [conv.id],
    );
    expect(eventos.map((ev) => ev.action)).toEqual(['conversation.create', 'conversation.archive']);
    for (const ev of eventos) {
      expect(ev).toMatchObject({ origin: 'ui', entity_type: 'conversation', actor_id: e.consultor.id });
      expect(ev.correlation).toEqual({ conversationId: conv.id });
      expect(ev.metadata).toEqual({ campaignId: e.campanaId });
    }
  });

  it('el contenido de los mensajes nunca llega a la auditoría', async () => {
    const t = await turno(e.consultor, TEXTO_SENSIBLE);
    valor(await cancelarRun(e.consultor, t.run.id));
    const eventos = await query<{ metadata: unknown; correlation: unknown; action: string }>(
      `SELECT action, metadata, correlation FROM audit_events
        WHERE organization_id = $1 AND (correlation->>'conversationId' = $2 OR entity_id = ANY($3::uuid[]))`,
      [e.admin.organizationId, t.conv.id, [t.conv.id, t.run.id]],
    );
    expect(eventos.length).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(eventos)).not.toContain(TEXTO_SENSIBLE);
  });

  it('los eventos del chat no aparecen en la actividad del brief (la que ve el cliente)', async () => {
    const t = await turno();
    valor(await cancelarRun(e.consultor, t.run.id));
    const actividad = await listBriefActivity(getPool(), e.admin.organizationId, e.campanaId, 500);
    const tipos = new Set(actividad.map((a) => a.entity_type));
    expect(tipos.has('conversation')).toBe(false);
    expect(tipos.has('agent_run')).toBe(false);
    expect(
      actividad.some((a) => a.action.startsWith('conversation.') || a.action.startsWith('agent_run.')),
    ).toBe(false);
  });
});

describe('reconstrucción usuario → conversación → mensaje → run → tool → efecto', () => {
  it('une por correlación los efectos reales de una tool (registerLinkedSource con origen chat)', async () => {
    const t = await turno();
    const { invocation, claimed } = valor(
      await reclamarInvocacion(e.consultor, t.run.id, {
        stepIndex: 0,
        toolCallId: 'call_registrar',
        toolName: 'source.link_register',
        riskClass: 'write',
        args: { url: SHEET('uno') },
      }),
    );
    expect(claimed).toBe(true);

    // El efecto: el caso de uso existente, con el actor real, origen chat y la correlación completa.
    const enlace = valor(
      await registerLinkedSource(
        e.consultor,
        { campaignId: e.campanaId, url: SHEET('uno') },
        {
          origin: 'chat',
          correlation: {
            conversationId: t.conv.id,
            messageId: t.mensaje.id,
            agentRunId: t.run.id,
            toolInvocationId: invocation.id,
          },
        },
      ),
    );
    valor(
      await cerrarInvocacion(e.consultor, invocation.id, {
        status: 'succeeded',
        result: { sourceId: enlace.id },
      }),
    );
    valor(await completarRun(e.consultor, t.run.id, { content: 'Registré el Sheet.' }));

    const traza = valor(await trazaDeInvocacion(e.consultor, invocation.id));
    expect(traza.user).toMatchObject({ id: e.consultor.id, name: e.consultor.name });
    expect(traza.conversation.id).toBe(t.conv.id);
    expect(traza.userMessage.id).toBe(t.mensaje.id);
    expect(traza.run.id).toBe(t.run.id);
    expect(traza.trace.invocation).toMatchObject({
      id: invocation.id,
      status: 'succeeded',
      toolName: 'source.link_register',
    });
    expect(traza.trace.effects).toHaveLength(1);
    expect(traza.trace.effects[0]).toMatchObject({
      action: 'source.link_register',
      entityType: 'source_document',
      entityId: enlace.id,
      origin: 'chat',
      actorId: e.consultor.id,
      correlation: {
        conversationId: t.conv.id,
        messageId: t.mensaje.id,
        agentRunId: t.run.id,
        toolInvocationId: invocation.id,
      },
    });

    const delRun = valor(await trazaDeRun(e.consultor, t.run.id));
    expect(delRun.invocations).toHaveLength(1);
    expect(delRun.invocations[0]!.effects.map((x) => x.entityId)).toEqual([enlace.id]);
    expect(delRun.assistantMessageId).toBeDefined();

    const completa = valor(await trazaDeConversacion(e.consultor, t.conv.id));
    expect(completa.user.id).toBe(e.consultor.id);
    expect(completa.events.map((x) => x.action)).toEqual(['conversation.create']);
    expect(completa.turns).toHaveLength(1);
    expect(completa.turns[0]!.userMessage.id).toBe(t.mensaje.id);
    expect(completa.turns[0]!.runs[0]!.invocations[0]!.effects[0]!.entityId).toBe(enlace.id);
  });

  it('dos llamadas del mismo run al mismo caso de uso son distinguibles por toolInvocationId', async () => {
    const t = await turno();
    const llamadas = [];
    for (const n of ['a', 'b']) {
      const { invocation } = valor(
        await reclamarInvocacion(e.consultor, t.run.id, {
          stepIndex: 0,
          toolCallId: `call_${n}`,
          toolName: 'source.link_register',
          riskClass: 'write',
          args: { url: SHEET(n) },
        }),
      );
      const enlace = valor(
        await registerLinkedSource(
          e.consultor,
          { campaignId: e.campanaId, url: SHEET(n) },
          {
            origin: 'chat',
            correlation: {
              conversationId: t.conv.id,
              messageId: t.mensaje.id,
              agentRunId: t.run.id,
              toolInvocationId: invocation.id,
            },
          },
        ),
      );
      valor(
        await cerrarInvocacion(e.consultor, invocation.id, {
          status: 'succeeded',
          result: { sourceId: enlace.id },
        }),
      );
      llamadas.push({ invocation, enlace });
    }
    for (const { invocation, enlace } of llamadas) {
      const traza = valor(await trazaDeInvocacion(e.consultor, invocation.id));
      expect(traza.trace.effects.map((x) => x.entityId)).toEqual([enlace.id]);
    }
  });

  it('un efecto que no se produjo se ve: invocación abierta sin eventos', async () => {
    const t = await turno();
    const { invocation } = valor(
      await reclamarInvocacion(e.consultor, t.run.id, {
        stepIndex: 0,
        toolName: 'source.link_register',
        riskClass: 'write',
        args: {},
      }),
    );
    const traza = valor(await trazaDeInvocacion(e.consultor, invocation.id));
    expect(traza.trace.invocation.status).toBe('running');
    expect(traza.trace.effects).toEqual([]);
  });

  it('de una acción propuesta hacia atrás: qué invocación del agente la dejó', async () => {
    const t = await turno();
    const { invocation } = valor(
      await reclamarInvocacion(e.consultor, t.run.id, {
        stepIndex: 0,
        toolName: 'brief_propose_approval',
        riskClass: 'confirmation_required',
        args: {},
      }),
    );
    const [accion] = await query<{ id: string }>(
      `INSERT INTO proposed_actions (organization_id, campaign_id, action_type, resource_type, resource_id, payload,
                                     payload_hash, proposed_by, proposed_origin, correlation, expires_at)
       VALUES ($1, $2, 'brief.approve', 'brief_version', uuid_generate_v4(), '{}'::jsonb, 'h', $3, 'chat', $4::jsonb,
               now() + interval '1 day') RETURNING id`,
      [
        e.admin.organizationId,
        e.campanaId,
        e.consultor.id,
        JSON.stringify({ conversationId: t.conv.id, toolInvocationId: invocation.id }),
      ],
    );
    valor(
      await cerrarInvocacion(e.consultor, invocation.id, {
        status: 'succeeded',
        proposedActionId: accion!.id,
        result: { proposedActionId: accion!.id },
      }),
    );
    const trazas = valor(await trazaDeAccionPropuesta(e.consultor, accion!.id));
    expect(trazas).toHaveLength(1);
    expect(trazas[0]).toMatchObject({
      conversation: { id: t.conv.id },
      userMessage: { id: t.mensaje.id },
      run: { id: t.run.id },
      trace: { invocation: { id: invocation.id, proposedActionId: accion!.id } },
    });
    // Otra persona no puede seguirle la pista.
    expect((await trazaDeAccionPropuesta(e.admin, accion!.id)).ok).toBe(false);
  });
});

describe('índices de expresión sobre audit_events.correlation', () => {
  it('la consulta de reconstrucción puede usarlos (sin escaneo secuencial forzado)', async () => {
    const casos: [string, string][] = [
      ['conversationId', 'audit_events_conversation_idx'],
      ['messageId', 'audit_events_message_idx'],
      ['agentRunId', 'audit_events_agent_run_idx'],
      ['toolInvocationId', 'audit_events_tool_invocation_idx'],
    ];
    for (const [clave, indice] of casos) {
      const plan = await transaction(async (client) => {
        await client.query(`SET LOCAL enable_seqscan = off`);
        const { rows } = await client.query<{ 'QUERY PLAN': string }>(
          `EXPLAIN SELECT id FROM audit_events WHERE organization_id = $1 AND correlation->>'${clave}' = ANY($2::text[])`,
          [e.admin.organizationId, ['x']],
        );
        return rows.map((r) => r['QUERY PLAN']).join('\n');
      });
      expect(plan, clave).toContain(indice);
    }
  });
});
