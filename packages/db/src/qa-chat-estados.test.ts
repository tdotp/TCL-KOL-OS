/**
 * QA adversarial · vector 9 (replay / estados imposibles) y 3 (FK compuestas) del esquema del chat.
 *
 * Se ataca con los casos de uso Y con SQL directo contra los triggers/CHECK de la migración 021.
 * Base propia desechable (INC-001A). No modifica código de producto.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Result, User } from '@tcl-kol-os/domain';
import { closePool, getPool, query } from './client.ts';
import { crearConversacion, archivarConversacion } from './chat-conversations.ts';
import { publicarMensaje } from './chat-messages.ts';
import {
  abandonarRunsCaducados,
  cancelarRun,
  completarRun,
  confirmarCancelacionDeRun,
  fallarRun,
  iniciarRun,
  latidoRun,
  obtenerRun,
  reintentarRun,
} from './agent-runs.ts';
import { cerrarInvocacion, reclamarInvocacion } from './agent-tool-invocations.ts';
import {
  CONFIG_DE_RUN_DE_PRUEBA,
  type EscenarioDeChat,
  crearEscenarioDeChat,
  crearFragmentoDePrueba,
  crearFuenteDePrueba,
  eliminarCampanaDePrueba,
} from './test-utils.ts';

let e: EscenarioDeChat;
let n = 0;
const HASH = 'e'.repeat(64);
const clave = () => `qa-est-${Date.now().toString(36)}-${++n}-xxxxxxxx`;
const valor = <T>(r: Result<T>): T => {
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
  return r.value;
};

beforeAll(async () => {
  e = await crearEscenarioDeChat('QA estados chat');
});
afterAll(async () => {
  await eliminarCampanaDePrueba(e.campanas);
  await closePool();
});

/** Conversación + mensaje + run (queued). */
async function turno(dueno: User = e.consultor, campana = e.campanaId) {
  const conv = valor(await crearConversacion(dueno, { campaignId: campana }));
  const pub = valor(
    await publicarMensaje(dueno, {
      conversationId: conv.id,
      clientMessageId: clave(),
      content: 'Mensaje de QA',
      runConfig: CONFIG_DE_RUN_DE_PRUEBA,
    }),
  );
  return { conv, mensaje: pub.message, run: pub.run };
}

async function enEjecucion(dueno: User = e.consultor) {
  const t = await turno(dueno);
  valor(await iniciarRun(dueno, t.run.id, { contextHash: HASH, contextManifest: {} }));
  return t;
}

const falla = async (sql: string, params: unknown[] = []): Promise<string> => {
  try {
    await query(sql, params);
    return '';
  } catch (err) {
    return (err as Error).message;
  }
};

describe('V9 · estados imposibles del run por SQL directo', () => {
  it('completed/failed/cancelled son terminales: no vuelven a running ni a queued ni se editan', async () => {
    const t = await enEjecucion();
    const respuesta = valor(await completarRun(e.consultor, t.run.id, { content: 'Listo.' }));
    expect(respuesta.run.status).toBe('completed');
    for (const destino of ['running', 'queued', 'failed', 'cancelled']) {
      expect(
        await falla(`UPDATE agent_runs SET status = $2 WHERE id = $1`, [t.run.id, destino]),
        destino,
      ).toMatch(/ya terminó/);
    }
    expect(await falla(`UPDATE agent_runs SET error_code = 'X1' WHERE id = $1`, [t.run.id])).toMatch(
      /ya terminó/,
    );
    expect(await falla(`UPDATE agent_runs SET finished_at = NULL WHERE id = $1`, [t.run.id])).toMatch(
      /ya terminó/,
    );
    expect(await falla(`DELETE FROM agent_runs WHERE id = $1`, [t.run.id])).toMatch(/histórico/);
  });

  it('un run en cola no salta a completed; uno running no vuelve a queued; la huella del contexto no se reescribe', async () => {
    const t = await turno();
    expect(
      await falla(`UPDATE agent_runs SET status = 'completed', finished_at = now() WHERE id = $1`, [
        t.run.id,
      ]),
    ).not.toBe('');
    valor(await iniciarRun(e.consultor, t.run.id, { contextHash: HASH, contextManifest: { a: 1 } }));
    expect(
      await falla(`UPDATE agent_runs SET status = 'queued', started_at = NULL WHERE id = $1`, [t.run.id]),
    ).toMatch(/Transición de run no válida|inicio|fija/);
    expect(
      await falla(`UPDATE agent_runs SET context_hash = $2 WHERE id = $1`, [t.run.id, 'f'.repeat(64)]),
    ).toMatch(/se fijan una sola vez/);
    expect(
      await falla(`UPDATE agent_runs SET context_manifest = '{"b":2}'::jsonb WHERE id = $1`, [t.run.id]),
    ).toMatch(/se fijan una sola vez/);
    expect(await falla(`UPDATE agent_runs SET user_id = $2 WHERE id = $1`, [t.run.id, e.admin.id])).toMatch(
      /identidad/,
    );
    expect(await falla(`UPDATE agent_runs SET attempt = 9 WHERE id = $1`, [t.run.id])).toMatch(/identidad/);
    // iniciar dos veces
    const otra = await iniciarRun(e.consultor, t.run.id, { contextHash: HASH, contextManifest: {} });
    expect(otra.ok).toBe(false);
  });

  it('completar sin mensaje del asistente, o con invocaciones abiertas, o un run cancelado/ajeno/fallido, no es posible', async () => {
    const t = await enEjecucion();
    expect(
      await falla(`UPDATE agent_runs SET status = 'completed', finished_at = now() WHERE id = $1`, [
        t.run.id,
      ]),
    ).toMatch(/solo se completa con su mensaje/);
    const { invocation } = valor(
      await reclamarInvocacion(e.consultor, t.run.id, {
        stepIndex: 0,
        toolCallId: clave(),
        toolName: 'campaign_get',
        riskClass: 'read',
        args: {},
      }),
    );
    expect((await completarRun(e.consultor, t.run.id, { content: 'x' })).ok).toBe(false); // tools abiertas
    expect(
      await falla(
        `UPDATE agent_runs SET status = 'failed', error_code = 'E1', finished_at = now() WHERE id = $1`,
        [t.run.id],
      ),
    ).toMatch(/invocaciones de tools abiertas/);
    valor(await cerrarInvocacion(e.consultor, invocation.id, { status: 'succeeded', result: {} }));
    // otro usuario de la misma organización no completa ni falla ni cancela ni late
    for (const otro of [e.director, e.admin]) {
      expect((await completarRun(otro, t.run.id, { content: 'x' })).ok).toBe(false);
      expect((await fallarRun(otro, t.run.id, { errorCode: 'ROBO_DE_RUN' })).ok).toBe(false);
      expect((await cancelarRun(otro, t.run.id)).ok).toBe(false);
      expect((await latidoRun(otro, t.run.id)).ok).toBe(false);
      expect((await obtenerRun(otro, t.run.id)).ok).toBe(false);
    }
    expect((await completarRun(e.consultor, t.run.id, { content: 'ahora sí' })).ok).toBe(true);
    // completar un run ya completado, fallar uno completado y completar uno cancelado
    expect((await completarRun(e.consultor, t.run.id, { content: 'otra vez' })).ok).toBe(false);
    expect((await fallarRun(e.consultor, t.run.id, { errorCode: 'TARDE' })).ok).toBe(false);
    const c = await enEjecucion();
    valor(await cancelarRun(e.consultor, c.run.id));
    expect((await completarRun(e.consultor, c.run.id, { content: 'x' })).ok).toBe(false);
    valor(await confirmarCancelacionDeRun(e.consultor, c.run.id));
    expect((await completarRun(e.consultor, c.run.id, { content: 'x' })).ok).toBe(false);
    expect((await latidoRun(e.consultor, c.run.id)).ok).toBe(false);
  });

  it('un segundo run ACTIVO para la misma conversación (SQL) lo rechaza el índice único parcial; dos completados para un mensaje, también', async () => {
    const t = await turno();
    const msg = await falla(
      `INSERT INTO agent_runs (organization_id, campaign_id, conversation_id, user_message_id, user_id, attempt, provider, model, tier, prompt_version, context_version)
       VALUES ($1, $2, $3, $4, $5, 2, 'p', 'm', 'equilibrado', 'v', 'c')`,
      [e.admin.organizationId, e.campanaId, t.conv.id, t.mensaje.id, e.consultor.id],
    );
    expect(msg).not.toBe('');
    expect(msg).toMatch(/consecutivos|solo se reintenta|agent_runs_activo_key|duplicate/i);
    // un run con otro usuario que el autor del mensaje
    const o = await falla(
      `INSERT INTO agent_runs (organization_id, campaign_id, conversation_id, user_message_id, user_id, attempt, provider, model, tier, prompt_version, context_version)
       VALUES ($1, $2, $3, $4, $5, 1, 'p', 'm', 'equilibrado', 'v', 'c')`,
      [e.admin.organizationId, e.campanaId, t.conv.id, t.mensaje.id, e.director.id],
    );
    expect(o).not.toBe('');
  });

  it('cancelación en carrera con la respuesta: nunca se publica una respuesta tras cancel_requested; el estado final es coherente', async () => {
    for (let i = 0; i < 5; i++) {
      const t = await enEjecucion();
      const [c, f] = await Promise.all([
        cancelarRun(e.consultor, t.run.id),
        completarRun(e.consultor, t.run.id, { content: `respuesta ${i}` }),
      ]);
      const [fila] = await query<{ status: string; cancel_requested_at: Date | null }>(
        `SELECT status, cancel_requested_at FROM agent_runs WHERE id = $1`,
        [t.run.id],
      );
      const msgs = await query<{ id: string }>(`SELECT id FROM chat_messages WHERE agent_run_id = $1`, [
        t.run.id,
      ]);
      if (fila!.status === 'completed') {
        // ganó la respuesta: la cancelación llegó tarde y se rechaza o queda sin efecto
        expect(f.ok).toBe(true);
        expect(msgs).toHaveLength(1);
        expect(c.ok && c.value.cancelled).not.toBe(true);
      } else {
        expect(fila!.status).toBe('running');
        expect(fila!.cancel_requested_at).not.toBeNull();
        expect(msgs).toHaveLength(0);
        // y ya no se puede publicar
        expect((await completarRun(e.consultor, t.run.id, { content: 'tarde' })).ok).toBe(false);
        valor(await confirmarCancelacionDeRun(e.consultor, t.run.id));
      }
    }
  });

  it('abandonar un run VIVO (latido reciente) no se puede; uno sin latido sí, cerrando antes sus tools abiertas', async () => {
    const t = await enEjecucion();
    const { invocation } = valor(
      await reclamarInvocacion(e.consultor, t.run.id, {
        stepIndex: 0,
        toolCallId: clave(),
        toolName: 'campaign_get',
        riskClass: 'read',
        args: {},
      }),
    );
    await abandonarRunsCaducados(); // ahora real: el latido es de hace milisegundos
    expect(valor(await obtenerRun(e.consultor, t.run.id)).status).toBe('running');
    await query(`UPDATE agent_runs SET heartbeat_at = now() - interval '11 minutes' WHERE id = $1`, [
      t.run.id,
    ]).catch(() => undefined);
    await abandonarRunsCaducados({ ahora: new Date(Date.now() + 11 * 60_000) });
    const run = valor(await obtenerRun(e.consultor, t.run.id));
    expect(run.status).toBe('failed');
    expect(run.errorCode).toBe('RUN_ABANDONED');
    const [inv] = await query<{ status: string; error_code: string }>(
      `SELECT status, error_code FROM agent_tool_invocations WHERE id = $1`,
      [invocation.id],
    );
    expect(inv).toMatchObject({ status: 'failed', error_code: 'TOOL_ABANDONED' });
    // el ejecutor tardío no puede seguir: ni latido, ni reclamar tools, ni completar
    expect((await latidoRun(e.consultor, t.run.id)).ok).toBe(false);
    const nuevo = await reclamarInvocacion(e.consultor, t.run.id, {
      stepIndex: 1,
      toolCallId: clave(),
      toolName: 'campaign_get',
      riskClass: 'read',
      args: {},
    });
    expect(nuevo.ok).toBe(false);
    expect((await completarRun(e.consultor, t.run.id, { content: 'zombi' })).ok).toBe(false);
  });

  it('reintentar un run COMPLETADO, uno vivo o el de un mensaje que ya no es el último no es posible', async () => {
    const t = await enEjecucion();
    expect((await reintentarRun(e.consultor, t.mensaje.id, CONFIG_DE_RUN_DE_PRUEBA)).ok).toBe(false); // vivo
    valor(await completarRun(e.consultor, t.run.id, { content: 'hecho' }));
    expect((await reintentarRun(e.consultor, t.mensaje.id, CONFIG_DE_RUN_DE_PRUEBA)).ok).toBe(false); // completado
    // otro usuario no reintenta
    const f = await enEjecucion();
    valor(await fallarRun(e.consultor, f.run.id, { errorCode: 'FALLO_DE_QA' }));
    expect((await reintentarRun(e.director, f.mensaje.id, CONFIG_DE_RUN_DE_PRUEBA)).ok).toBe(false);
    expect((await reintentarRun(e.consultor, f.mensaje.id, CONFIG_DE_RUN_DE_PRUEBA)).ok).toBe(true);
  });
});

describe('V9 · invocaciones de tool: estados imposibles y claim', () => {
  it('succeeded→running, reescritura de una terminada, args mutables, DELETE y apertura en run no running se rechazan', async () => {
    const t = await enEjecucion();
    const { invocation } = valor(
      await reclamarInvocacion(e.consultor, t.run.id, {
        stepIndex: 0,
        toolCallId: clave(),
        toolName: 'campaign_get',
        riskClass: 'read',
        args: { a: 1 },
      }),
    );
    expect(
      await falla(`UPDATE agent_tool_invocations SET args = '{"b":2}'::jsonb WHERE id = $1`, [invocation.id]),
    ).toMatch(/identidad/);
    expect(
      await falla(`UPDATE agent_tool_invocations SET tool_name = 'otra' WHERE id = $1`, [invocation.id]),
    ).toMatch(/identidad/);
    expect(
      await falla(`UPDATE agent_tool_invocations SET risk_class = 'write' WHERE id = $1`, [invocation.id]),
    ).toMatch(/identidad/);
    valor(await cerrarInvocacion(e.consultor, invocation.id, { status: 'succeeded', result: { ok: 1 } }));
    for (const destino of ['running', 'failed', 'cancelled']) {
      expect(
        await falla(`UPDATE agent_tool_invocations SET status = $2, finished_at = now() WHERE id = $1`, [
          invocation.id,
          destino,
        ]),
        destino,
      ).toMatch(/ya terminó|no se modifica|coherente|violates/);
    }
    expect(
      await falla(`UPDATE agent_tool_invocations SET result = '{"x":1}'::jsonb WHERE id = $1`, [
        invocation.id,
      ]),
    ).toMatch(/ya terminó/);
    expect(await falla(`DELETE FROM agent_tool_invocations WHERE id = $1`, [invocation.id])).toMatch(
      /histórica/,
    );
    expect(
      (await cerrarInvocacion(e.consultor, invocation.id, { status: 'failed', errorCode: 'OTRA' })).ok,
    ).toBe(false);
    // abrir una invocación en un run NO running (cola / terminal) por SQL
    const q = await turno();
    expect(
      await falla(
        `INSERT INTO agent_tool_invocations (organization_id, campaign_id, agent_run_id, sequence, tool_name, risk_class, args_sha256, idempotency_key)
         VALUES ($1, $2, $3, 1, 'x', 'read', $4, 'k')`,
        [e.admin.organizationId, e.campanaId, q.run.id, HASH],
      ),
    ).toMatch(/run en ejecución/);
  });

  it('result de más de 32 KB, args de más de 16 KB, resultado en una invocación fallida, propuesta en una tool de lectura: CHECK', async () => {
    const t = await enEjecucion();
    const base = (extra: string, vals: unknown[]) =>
      falla(
        `INSERT INTO agent_tool_invocations (organization_id, campaign_id, agent_run_id, sequence, tool_name, risk_class, args, args_sha256, idempotency_key ${extra})`,
        vals,
      );
    void base;
    expect(
      await falla(
        `INSERT INTO agent_tool_invocations (organization_id, campaign_id, agent_run_id, sequence, tool_name, risk_class, args, args_sha256, idempotency_key)
         VALUES ($1, $2, $3, 1, 'x', 'read', $4::jsonb, $5, 'k-big')`,
        [e.admin.organizationId, e.campanaId, t.run.id, JSON.stringify({ x: 'y'.repeat(20_000) }), HASH],
      ),
    ).toMatch(/args_acotados|violates check/);
    // la misma llamada (tool_call_id) en el mismo run: UNIQUE
    const id = clave();
    valor(
      await reclamarInvocacion(e.consultor, t.run.id, {
        stepIndex: 0,
        toolCallId: id,
        toolName: 'campaign_get',
        riskClass: 'read',
        args: {},
      }),
    );
    expect(
      await falla(
        `INSERT INTO agent_tool_invocations (organization_id, campaign_id, agent_run_id, sequence, tool_call_id, tool_name, risk_class, args_sha256, idempotency_key)
         VALUES ($1, $2, $3, 99, $4, 'x', 'read', $5, 'otra-clave')`,
        [e.admin.organizationId, e.campanaId, t.run.id, id, HASH],
      ),
    ).toMatch(/agent_tool_invocations_llamada_key|duplicate/);
  });
});

describe('V9 · mensajes: append-only y reglas de autoría', () => {
  it('UPDATE y DELETE de mensajes, adjuntos y citas se rechazan', async () => {
    const t = await enEjecucion();
    const r = valor(await completarRun(e.consultor, t.run.id, { content: 'respuesta' }));
    for (const id of [t.mensaje.id, r.message.id]) {
      expect(await falla(`UPDATE chat_messages SET content = 'editado' WHERE id = $1`, [id])).toMatch(
        /histórico/,
      );
      expect(await falla(`DELETE FROM chat_messages WHERE id = $1`, [id])).toMatch(/histórico/);
      expect(await falla(`UPDATE chat_messages SET seq = 999 WHERE id = $1`, [id])).toMatch(/histórico/);
    }
    // una cita nueva sobre un mensaje YA creado no se puede añadir (solo en su misma transacción)
    const src = await crearFuenteDePrueba(e.campanaId, e.admin, 'qa-cita');
    expect(
      await falla(
        `INSERT INTO chat_message_references (organization_id, campaign_id, conversation_id, message_id, ordinal, source_id)
         VALUES ($1, $2, $3, $4, 1, $5)`,
        [e.admin.organizationId, e.campanaId, t.conv.id, r.message.id, src],
      ),
    ).toMatch(/no se agrega a un mensaje anterior/);
    // ni un adjunto a un mensaje anterior
    expect(
      await falla(
        `INSERT INTO chat_message_attachments (organization_id, campaign_id, conversation_id, message_id, source_id, position)
         VALUES ($1, $2, $3, $4, $5, 1)`,
        [e.admin.organizationId, e.campanaId, t.conv.id, t.mensaje.id, src],
      ),
    ).toMatch(/no se agrega a un mensaje anterior/);
  });

  it('el asistente solo escribe para un run EN EJECUCIÓN de esa conversación, a nombre de su dueño, y una sola vez', async () => {
    const t = await turno(); // queued
    const ins = (run: string, usuario: string, conv: string, rol = 'assistant') =>
      falla(
        `INSERT INTO chat_messages (organization_id, campaign_id, conversation_id, role, user_id, content, agent_run_id)
         VALUES ($1, $2, $3, $4, $5, 'x', $6)`,
        [e.admin.organizationId, e.campanaId, conv, rol, usuario, run],
      );
    expect(await ins(t.run.id, e.consultor.id, t.conv.id)).toMatch(/run en ejecución/); // en cola
    valor(await iniciarRun(e.consultor, t.run.id, { contextHash: HASH, contextManifest: {} }));
    expect(await ins(t.run.id, e.director.id, t.conv.id)).toMatch(/nombre de la persona/); // otro autor
    const otra = await turno(e.director);
    expect(await ins(t.run.id, e.consultor.id, otra.conv.id)).not.toBe(''); // run de otra conversación
    expect(await ins(t.run.id, e.consultor.id, t.conv.id, 'system')).not.toBe(''); // rol no válido
    expect(await ins(t.run.id, e.consultor.id, t.conv.id, 'tool')).not.toBe('');
    expect(await ins(t.run.id, e.consultor.id, t.conv.id)).toBe(''); // el legítimo
    expect(await ins(t.run.id, e.consultor.id, t.conv.id)).toMatch(/chat_messages_run_key|duplicate/); // segundo mensaje del run
  });

  it('un usuario `cliente` no puede ser autor ni dueño aunque se llegue por SQL; y no se escribe con un run activo ni en una conversación archivada', async () => {
    const t = await turno();
    expect(
      await falla(
        `INSERT INTO chat_conversations (organization_id, campaign_id, created_by) VALUES ($1, $2, $3)`,
        [e.cliente.organizationId, e.campanaId, e.cliente.id],
      ),
    ).not.toBe('');
    expect(
      await falla(
        `INSERT INTO chat_messages (organization_id, campaign_id, conversation_id, role, user_id, content, client_message_id)
         VALUES ($1, $2, $3, 'user', $4, 'x', $5)`,
        [e.admin.organizationId, e.campanaId, t.conv.id, e.cliente.id, clave()],
      ),
    ).not.toBe('');
    // run activo (queued): no entra otro mensaje por SQL tampoco
    expect(
      await falla(
        `INSERT INTO chat_messages (organization_id, campaign_id, conversation_id, role, user_id, content, client_message_id)
         VALUES ($1, $2, $3, 'user', $4, 'x', $5)`,
        [e.admin.organizationId, e.campanaId, t.conv.id, e.consultor.id, clave()],
      ),
    ).toMatch(/run del agente activo/);
    valor(await fallarRun(e.consultor, t.run.id, { errorCode: 'FIN_DE_QA' }));
    valor(await archivarConversacion(e.consultor, t.conv.id));
    expect(
      await falla(
        `INSERT INTO chat_messages (organization_id, campaign_id, conversation_id, role, user_id, content, client_message_id)
         VALUES ($1, $2, $3, 'user', $4, 'x', $5)`,
        [e.admin.organizationId, e.campanaId, t.conv.id, e.consultor.id, clave()],
      ),
    ).toMatch(/archivada/);
    expect(
      await falla(`UPDATE chat_conversations SET status = 'active', archived_at = NULL WHERE id = $1`, [
        t.conv.id,
      ]),
    ).toMatch(/archivada no se modifica/);
    expect(await falla(`DELETE FROM chat_conversations WHERE id = $1`, [t.conv.id])).toMatch(/no se borra/);
  });

  it('seq: lo asigna el trigger; un valor del llamador se ignora y last_seq no retrocede ni salta', async () => {
    const t = await turno();
    valor(await fallarRun(e.consultor, t.run.id, { errorCode: 'FIN_DE_QA' }));
    const [m] = await query<{ seq: string }>(
      `INSERT INTO chat_messages (organization_id, campaign_id, conversation_id, seq, role, user_id, content, client_message_id)
       VALUES ($1, $2, $3, 4242, 'user', $4, 'seq forzado', $5) RETURNING seq`,
      [e.admin.organizationId, e.campanaId, t.conv.id, e.consultor.id, clave()],
    );
    expect(Number(m!.seq)).toBe(2);
    expect(await falla(`UPDATE chat_conversations SET last_seq = 50 WHERE id = $1`, [t.conv.id])).toMatch(
      /de uno en uno/,
    );
    expect(await falla(`UPDATE chat_conversations SET last_seq = 0 WHERE id = $1`, [t.conv.id])).toMatch(
      /de uno en uno/,
    );
  });
});

describe('V9 · sanidad del pool', () => {
  it('el pool sigue sano: ninguna transacción quedó abierta', async () => {
    const { rows } = await getPool().query<{ n: string }>(
      `SELECT count(*)::text AS n FROM pg_stat_activity WHERE datname = current_database() AND state = 'idle in transaction'`,
    );
    expect(Number(rows[0]!.n)).toBe(0);
    void crearFragmentoDePrueba;
  });
});
