/**
 * V2 · Fase 6 — esquema del chat (migración 021): invariantes que impone LA BASE.
 *
 * Todo se prueba con SQL directo, sin pasar por los casos de uso: lo que la
 * aplicación omita, la base lo rechaza. Aislamiento por organización y campaña,
 * mensajes inmutables, `seq` concurrente, conversaciones archivadas, el chat no es
 * de un cliente, ningún razonamiento del modelo en ninguna columna, y el índice
 * único de propuestas abiertas (D7).
 */

import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { User } from '@tcl-kol-os/domain';
import { closePool, query, transaction } from './client.ts';
import {
  type EscenarioDeChat,
  asegurarUsuarioDePrueba,
  crearEscenarioDeChat,
  eliminarCampanaDePrueba,
} from './test-utils.ts';

let e: EscenarioDeChat;

async function nuevaConversacion(dueno: User = e.consultor, campana = e.campanaId): Promise<string> {
  const [c] = await query<{ id: string }>(
    `INSERT INTO chat_conversations (organization_id, campaign_id, created_by)
     VALUES ($1, $2, $3) RETURNING id`,
    [dueno.organizationId, campana, dueno.id],
  );
  return c!.id;
}

async function nuevoMensajeUsuario(
  conversacion: string,
  dueno: User = e.consultor,
  contenido = 'Hola agente',
  campana = e.campanaId,
): Promise<string> {
  const [m] = await query<{ id: string }>(
    `INSERT INTO chat_messages (organization_id, campaign_id, conversation_id, role, user_id, content, client_message_id)
     VALUES ($1, $2, $3, 'user', $4, $5, $6) RETURNING id`,
    [
      dueno.organizationId,
      campana,
      conversacion,
      dueno.id,
      contenido,
      `cm-${Math.random().toString(36).slice(2)}-${Date.now()}`,
    ],
  );
  return m!.id;
}

async function nuevoRun(conversacion: string, mensaje: string, dueno: User = e.consultor): Promise<string> {
  const [r] = await query<{ id: string }>(
    `INSERT INTO agent_runs (organization_id, campaign_id, conversation_id, user_message_id, user_id,
                             provider, model, tier, prompt_version, context_version)
     VALUES ($1, $2, $3, $4, $5, 'p', 'm', 'equilibrado', 'v1', 'c1') RETURNING id`,
    [dueno.organizationId, e.campanaId, conversacion, mensaje, dueno.id],
  );
  return r!.id;
}

const HASH = 'a'.repeat(64);

async function iniciar(runId: string): Promise<void> {
  await query(
    `UPDATE agent_runs SET status = 'running', started_at = now(), heartbeat_at = now(),
            context_hash = $2, context_manifest = '{}'::jsonb WHERE id = $1`,
    [runId, HASH],
  );
}

beforeAll(async () => {
  e = await crearEscenarioDeChat('Esquema del chat');
});

afterAll(async () => {
  await eliminarCampanaDePrueba(e.campanas);
  await closePool();
});

describe('aislamiento por organización y campaña (FK compuestas)', () => {
  it('el creador debe ser de la misma organización que la campaña', async () => {
    await expect(
      query(`INSERT INTO chat_conversations (organization_id, campaign_id, created_by) VALUES ($1, $2, $3)`, [
        e.admin.organizationId,
        e.campanaId,
        e.ajeno.id,
      ]),
    ).rejects.toThrow(/chat_conversations_creador_fkey/);
  });

  it('la campaña debe ser de la organización declarada', async () => {
    await expect(
      query(`INSERT INTO chat_conversations (organization_id, campaign_id, created_by) VALUES ($1, $2, $3)`, [
        e.admin.organizationId,
        e.campanaAjenaId,
        e.consultor.id,
      ]),
    ).rejects.toThrow(/chat_conversations_campaign_fkey/);
  });

  it('un mensaje no puede declarar otra campaña ni otra organización que su conversación', async () => {
    const conv = await nuevaConversacion();
    await expect(
      query(
        `INSERT INTO chat_messages (organization_id, campaign_id, conversation_id, role, user_id, content, client_message_id)
         VALUES ($1, $2, $3, 'user', $4, 'x', 'cm-otra-campana-1')`,
        [e.admin.organizationId, e.otraCampanaId, conv, e.consultor.id],
      ),
    ).rejects.toThrow(/chat_messages_conversation_fkey/);
    await expect(
      query(
        `INSERT INTO chat_messages (organization_id, campaign_id, conversation_id, role, user_id, content, client_message_id)
         VALUES ($1, $2, $3, 'user', $4, 'x', 'cm-otra-org-0001')`,
        [e.ajeno.organizationId, e.campanaId, conv, e.ajeno.id],
      ),
    ).rejects.toThrow(/chat_messages_conversation_fkey/);
  });

  it('el autor de un mensaje debe ser de la organización de la conversación', async () => {
    const conv = await nuevaConversacion();
    await expect(
      query(
        `INSERT INTO chat_messages (organization_id, campaign_id, conversation_id, role, user_id, content, client_message_id)
         VALUES ($1, $2, $3, 'user', $4, 'x', 'cm-autor-ajeno-1')`,
        [e.admin.organizationId, e.campanaId, conv, e.ajeno.id],
      ),
    ).rejects.toThrow(/chat_messages_usuario_fkey/);
  });

  it('un run, un adjunto y una invocación no cruzan organización ni campaña', async () => {
    const conv = await nuevaConversacion();
    const msg = await nuevoMensajeUsuario(conv);
    // Run con campaña distinta de la conversación.
    await expect(
      query(
        `INSERT INTO agent_runs (organization_id, campaign_id, conversation_id, user_message_id, user_id,
                                 provider, model, tier, prompt_version, context_version)
         VALUES ($1, $2, $3, $4, $5, 'p', 'm', 'equilibrado', 'v1', 'c1')`,
        [e.admin.organizationId, e.otraCampanaId, conv, msg, e.consultor.id],
      ),
    ).rejects.toThrow(/agent_runs_conversation_fkey/);
    const run = await nuevoRun(conv, msg);
    await iniciar(run);
    // Invocación con campaña distinta de la de su run.
    await expect(
      query(
        `INSERT INTO agent_tool_invocations (organization_id, campaign_id, agent_run_id, sequence, tool_name,
                                             risk_class, args_sha256, idempotency_key)
         VALUES ($1, $2, $3, 1, 'campaign_get', 'read', $4, 'k-1')`,
        [e.admin.organizationId, e.otraCampanaId, run, HASH],
      ),
    ).rejects.toThrow(/agent_tool_invocations_run_fkey/);
  });
});

describe('el chat es del personal de la agencia, no de un cliente', () => {
  it('un usuario cliente (aunque sea de la organización de la campaña) no crea conversaciones', async () => {
    const clienteDeAgencia = await asegurarUsuarioDePrueba(
      'cliente-en-agencia@smartpr.co',
      'Cliente mal ubicado',
      'cliente',
      e.admin.organizationId,
    );
    await expect(
      query(`INSERT INTO chat_conversations (organization_id, campaign_id, created_by) VALUES ($1, $2, $3)`, [
        clienteDeAgencia.organizationId,
        e.campanaId,
        clienteDeAgencia.id,
      ]),
    ).rejects.toThrow(/cliente no crea conversaciones/);
  });

  it('el usuario de TCL tampoco, ni siquiera en una campaña de su propia organización', async () => {
    const [c] = await query<{ id: string }>(
      `INSERT INTO campaigns (organization_id, name, owner_id, created_by) VALUES ($1, $2, $3, $3) RETURNING id`,
      [e.cliente.organizationId, `Campaña TCL · ${e.sufijo}`, e.cliente.id],
    );
    e.campanas.push(c!.id);
    await expect(
      query(`INSERT INTO chat_conversations (organization_id, campaign_id, created_by) VALUES ($1, $2, $3)`, [
        e.cliente.organizationId,
        c!.id,
        e.cliente.id,
      ]),
    ).rejects.toThrow(/cliente no crea conversaciones/);
  });
});

describe('mensajes: contenido, hash, orden y roles', () => {
  it('rechaza contenido vacío, demasiado largo y claves de idempotencia inválidas', async () => {
    const conv = await nuevaConversacion();
    const insertar = (contenido: string, clave: string) =>
      query(
        `INSERT INTO chat_messages (organization_id, campaign_id, conversation_id, role, user_id, content, client_message_id)
         VALUES ($1, $2, $3, 'user', $4, $5, $6)`,
        [e.admin.organizationId, e.campanaId, conv, e.consultor.id, contenido, clave],
      );
    await expect(insertar('   ', 'clave-valida-01')).rejects.toThrow(/chat_messages_contenido_acotado/);
    await expect(insertar('x'.repeat(20_001), 'clave-valida-02')).rejects.toThrow(
      /chat_messages_contenido_acotado/,
    );
    await expect(insertar('ok', 'corta')).rejects.toThrow(/chat_messages_clave_valida/);
    await expect(insertar('ok', 'tiene espacios en la clave')).rejects.toThrow(/chat_messages_clave_valida/);
    await insertar('x'.repeat(20_000), 'clave-valida-03');
  });

  it('el hash y la hora los fija la base, no el llamador', async () => {
    const conv = await nuevaConversacion();
    const [m] = await query<{ content_sha256: string; created_at: Date }>(
      `INSERT INTO chat_messages (organization_id, campaign_id, conversation_id, role, user_id, content,
                                  client_message_id, content_sha256, created_at, seq)
       VALUES ($1, $2, $3, 'user', $4, 'Contenido ñandú', 'clave-hash-0001', $5, '2001-01-01', 999)
       RETURNING content_sha256, created_at`,
      [e.admin.organizationId, e.campanaId, conv, e.consultor.id, 'b'.repeat(64)],
    );
    expect(m!.content_sha256).toBe(createHash('sha256').update('Contenido ñandú', 'utf8').digest('hex'));
    expect(m!.created_at.getFullYear()).toBeGreaterThan(2020);
    const [{ seq } = { seq: '0' }] = await query<{ seq: string }>(
      `SELECT seq FROM chat_messages WHERE conversation_id = $1`,
      [conv],
    );
    expect(Number(seq)).toBe(1);
  });

  it('la clave de idempotencia es única por conversación', async () => {
    const conv = await nuevaConversacion();
    const insertar = () =>
      query(
        `INSERT INTO chat_messages (organization_id, campaign_id, conversation_id, role, user_id, content, client_message_id)
         VALUES ($1, $2, $3, 'user', $4, 'hola', 'clave-repetida-1')`,
        [e.admin.organizationId, e.campanaId, conv, e.consultor.id],
      );
    await insertar();
    await expect(insertar()).rejects.toThrow(/chat_messages_cliente_key/);
    // En otra conversación, la misma clave es otra clave.
    const otra = await nuevaConversacion();
    await query(
      `INSERT INTO chat_messages (organization_id, campaign_id, conversation_id, role, user_id, content, client_message_id)
       VALUES ($1, $2, $3, 'user', $4, 'hola', 'clave-repetida-1')`,
      [e.admin.organizationId, e.campanaId, otra, e.consultor.id],
    );
  });

  it('solo existen los roles user y assistant, cada uno con su forma', async () => {
    const conv = await nuevaConversacion();
    const msg = await nuevoMensajeUsuario(conv);
    const run = await nuevoRun(conv, msg);
    await iniciar(run);
    const sql = `INSERT INTO chat_messages (organization_id, campaign_id, conversation_id, role, user_id, content,
                                            client_message_id, agent_run_id)
                 VALUES ($1, $2, $3, $4, $5, 'x', $6, $7)`;
    const base = [e.admin.organizationId, e.campanaId, conv];
    await expect(query(sql, [...base, 'system', e.consultor.id, 'clave-system-01', null])).rejects.toThrow(
      /rol «system» no válido/,
    );
    await expect(query(sql, [...base, 'tool', e.consultor.id, 'clave-tool-0001', null])).rejects.toThrow(
      /rol «tool» no válido/,
    );
    // assistant con clave de cliente / sin run.
    await expect(query(sql, [...base, 'assistant', e.consultor.id, 'clave-asist-01', run])).rejects.toThrow(
      /chat_messages_rol_coherente/,
    );
    await expect(query(sql, [...base, 'assistant', e.consultor.id, null, null])).rejects.toThrow(
      /solo se escribe para un run en ejecución/,
    );
    // user sin clave y user con run: en una conversación sin run activo.
    const libre = await nuevaConversacion();
    const baseLibre = [e.admin.organizationId, e.campanaId, libre];
    await expect(query(sql, [...baseLibre, 'user', e.consultor.id, null, null])).rejects.toThrow(
      /chat_messages_rol_coherente/,
    );
    await expect(query(sql, [...baseLibre, 'user', e.consultor.id, 'clave-user-run-1', run])).rejects.toThrow(
      /chat_messages_rol_coherente|chat_messages_run_fkey/,
    );
  });

  it('seq: 10 inserciones concurrentes producen 1..10 sin huecos ni repetidos', async () => {
    const conv = await nuevaConversacion();
    await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        query(
          `INSERT INTO chat_messages (organization_id, campaign_id, conversation_id, role, user_id, content, client_message_id)
           VALUES ($1, $2, $3, 'user', $4, $5, $6)`,
          [
            e.admin.organizationId,
            e.campanaId,
            conv,
            e.consultor.id,
            `mensaje ${i}`,
            `clave-concurrente-${i}`,
          ],
        ),
      ),
    );
    const filas = await query<{ seq: string }>(
      `SELECT seq FROM chat_messages WHERE conversation_id = $1 ORDER BY seq`,
      [conv],
    );
    expect(filas.map((f) => Number(f.seq))).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    const [{ last_seq } = { last_seq: '0' }] = await query<{ last_seq: string }>(
      `SELECT last_seq FROM chat_conversations WHERE id = $1`,
      [conv],
    );
    expect(Number(last_seq)).toBe(10);
  });

  it('un mensaje rechazado no consume seq', async () => {
    const conv = await nuevaConversacion();
    await nuevoMensajeUsuario(conv);
    await expect(
      query(
        `INSERT INTO chat_messages (organization_id, campaign_id, conversation_id, role, user_id, content, client_message_id)
         VALUES ($1, $2, $3, 'user', $4, '   ', 'clave-rechazada-1')`,
        [e.admin.organizationId, e.campanaId, conv, e.consultor.id],
      ),
    ).rejects.toThrow();
    // El rechazo ocurre en una sentencia (se deshace sola): el siguiente mensaje es el 2.
    await nuevoMensajeUsuario(conv);
    const filas = await query<{ seq: string }>(
      `SELECT seq FROM chat_messages WHERE conversation_id = $1 ORDER BY seq`,
      [conv],
    );
    expect(filas.map((f) => Number(f.seq))).toEqual([1, 2]);
  });
});

describe('los mensajes son inmutables', () => {
  it('no se actualiza ningún campo y no se borra', async () => {
    const conv = await nuevaConversacion();
    const msg = await nuevoMensajeUsuario(conv);
    await expect(query(`UPDATE chat_messages SET content = 'editado' WHERE id = $1`, [msg])).rejects.toThrow(
      /histórico y no se modifica/,
    );
    await expect(query(`UPDATE chat_messages SET seq = 99 WHERE id = $1`, [msg])).rejects.toThrow(
      /histórico y no se modifica/,
    );
    await expect(query(`UPDATE chat_messages SET content = content WHERE id = $1`, [msg])).rejects.toThrow(
      /histórico y no se modifica/,
    );
    await expect(query(`DELETE FROM chat_messages WHERE id = $1`, [msg])).rejects.toThrow(
      /histórico y no se borra/,
    );
    const [fila] = await query<{ content: string }>(`SELECT content FROM chat_messages WHERE id = $1`, [msg]);
    expect(fila!.content).toBe('Hola agente');
  });
});

describe('conversaciones: identidad, archivo y candados', () => {
  it('la identidad es inmutable, last_seq solo avanza por mensajes y no se borra', async () => {
    const conv = await nuevaConversacion();
    await expect(
      query(`UPDATE chat_conversations SET created_by = $2 WHERE id = $1`, [conv, e.admin.id]),
    ).rejects.toThrow(/identidad de una conversación/);
    await expect(
      query(`UPDATE chat_conversations SET campaign_id = $2 WHERE id = $1`, [conv, e.otraCampanaId]),
    ).rejects.toThrow(/identidad de una conversación/);
    await expect(query(`UPDATE chat_conversations SET last_seq = 5 WHERE id = $1`, [conv])).rejects.toThrow(
      /last_seq solo avanza/,
    );
    await expect(query(`DELETE FROM chat_conversations WHERE id = $1`, [conv])).rejects.toThrow(
      /no se borra/,
    );
    await query(`UPDATE chat_conversations SET title = 'Título nuevo' WHERE id = $1`, [conv]);
  });

  it('archivada es terminal: no admite mensajes, runs ni cambios', async () => {
    const conv = await nuevaConversacion();
    const msg = await nuevoMensajeUsuario(conv);
    await query(`UPDATE chat_conversations SET status = 'archived', archived_at = now() WHERE id = $1`, [
      conv,
    ]);
    await expect(nuevoMensajeUsuario(conv)).rejects.toThrow(/archivada/);
    await expect(nuevoRun(conv, msg)).rejects.toThrow(/archivada/);
    await expect(query(`UPDATE chat_conversations SET title = 'x' WHERE id = $1`, [conv])).rejects.toThrow(
      /archivada no se modifica/,
    );
    await expect(
      query(`UPDATE chat_conversations SET status = 'active', archived_at = NULL WHERE id = $1`, [conv]),
    ).rejects.toThrow(/archivada no se modifica/);
  });

  it('status y archived_at son coherentes', async () => {
    const conv = await nuevaConversacion();
    await expect(
      query(`UPDATE chat_conversations SET status = 'archived' WHERE id = $1`, [conv]),
    ).rejects.toThrow(/chat_conversations_archivo_coherente/);
  });

  it('no se archiva con un run activo', async () => {
    const conv = await nuevaConversacion();
    const msg = await nuevoMensajeUsuario(conv);
    await nuevoRun(conv, msg);
    await expect(
      query(`UPDATE chat_conversations SET status = 'archived', archived_at = now() WHERE id = $1`, [conv]),
    ).rejects.toThrow(/run del agente activo/);
  });

  it('un mensaje de usuario no entra con un run activo en la conversación', async () => {
    const conv = await nuevaConversacion();
    const msg = await nuevoMensajeUsuario(conv);
    await nuevoRun(conv, msg);
    await expect(nuevoMensajeUsuario(conv)).rejects.toThrow(/run del agente activo/);
  });
});

describe('runs: un solo run activo y transiciones', () => {
  it('el índice parcial impide dos runs activos en la conversación, también por SQL directo', async () => {
    const conv = await nuevaConversacion();
    // Dos mensajes de usuario SIN run (el trigger de mensajes solo bloquea cuando ya hay un run activo).
    const msg1 = await nuevoMensajeUsuario(conv);
    const msg2 = await nuevoMensajeUsuario(conv);
    await nuevoRun(conv, msg1);
    // Un run activo para OTRO mensaje de la misma conversación: lo rechaza el índice único parcial.
    await expect(nuevoRun(conv, msg2)).rejects.toThrow(/agent_runs_activo_key/);
    // Terminado el primero, el segundo ya puede arrancar.
    await query(
      `UPDATE agent_runs SET status = 'cancelled', finished_at = now() WHERE user_message_id = $1`,
      [msg1],
    );
    await nuevoRun(conv, msg2);
  });

  it('un reintento exige que el intento anterior haya fallado o se haya cancelado', async () => {
    const conv = await nuevaConversacion();
    const msg = await nuevoMensajeUsuario(conv);
    await nuevoRun(conv, msg);
    await expect(
      query(
        `INSERT INTO agent_runs (organization_id, campaign_id, conversation_id, user_message_id, user_id, attempt,
                                 provider, model, tier, prompt_version, context_version)
         VALUES ($1, $2, $3, $4, $5, 2, 'p', 'm', 'equilibrado', 'v1', 'c1')`,
        [e.admin.organizationId, e.campanaId, conv, msg, e.consultor.id],
      ),
    ).rejects.toThrow(/Solo se reintenta un run fallido o cancelado/);
    // Los intentos son consecutivos.
    await query(
      `UPDATE agent_runs SET status = 'cancelled', finished_at = now() WHERE user_message_id = $1`,
      [msg],
    );
    await expect(
      query(
        `INSERT INTO agent_runs (organization_id, campaign_id, conversation_id, user_message_id, user_id, attempt,
                                 provider, model, tier, prompt_version, context_version)
         VALUES ($1, $2, $3, $4, $5, 5, 'p', 'm', 'equilibrado', 'v1', 'c1')`,
        [e.admin.organizationId, e.campanaId, conv, msg, e.consultor.id],
      ),
    ).rejects.toThrow(/intentos de un run son consecutivos/);
  });

  it('un run nace en cola, de un mensaje de usuario de su conversación y de la misma persona', async () => {
    const conv = await nuevaConversacion();
    const otra = await nuevaConversacion();
    const msg = await nuevoMensajeUsuario(conv);
    const insertar = (convId: string, msgId: string, userId: string, estado = 'queued') =>
      query(
        `INSERT INTO agent_runs (organization_id, campaign_id, conversation_id, user_message_id, user_id, status,
                                 provider, model, tier, prompt_version, context_version, started_at, context_hash, context_manifest)
         VALUES ($1, $2, $3, $4, $5, $6, 'p', 'm', 'equilibrado', 'v1', 'c1',
                 CASE WHEN $6 = 'queued' THEN NULL ELSE now() END,
                 CASE WHEN $6 = 'queued' THEN NULL ELSE $7 END,
                 CASE WHEN $6 = 'queued' THEN NULL ELSE '{}'::jsonb END)`,
        [e.admin.organizationId, e.campanaId, convId, msgId, userId, estado, HASH],
      );
    await expect(insertar(conv, msg, e.consultor.id, 'running')).rejects.toThrow(/nace en cola/);
    // El mensaje es de otra conversación.
    await expect(insertar(otra, msg, e.consultor.id)).rejects.toThrow(
      /debe colgar de un mensaje de usuario de su conversación/,
    );
    // Otra persona (director) no puede colgar un run del mensaje del consultor.
    await expect(insertar(conv, msg, e.director.id)).rejects.toThrow(/misma persona/);
  });

  it('las transiciones inválidas y los estados terminales se rechazan', async () => {
    const conv = await nuevaConversacion();
    const msg = await nuevoMensajeUsuario(conv);
    const run = await nuevoRun(conv, msg);
    // queued → completed no existe (y no hay mensaje del asistente).
    await expect(
      query(`UPDATE agent_runs SET status = 'completed', finished_at = now() WHERE id = $1`, [run]),
    ).rejects.toThrow();
    // running exige contexto y hora de inicio (CHECK).
    await expect(query(`UPDATE agent_runs SET status = 'running' WHERE id = $1`, [run])).rejects.toThrow(
      /agent_runs_inicio_coherente/,
    );
    await iniciar(run);
    // El contexto se fija una sola vez.
    await expect(
      query(`UPDATE agent_runs SET context_hash = $2 WHERE id = $1`, [run, 'c'.repeat(64)]),
    ).rejects.toThrow(/se fijan una sola vez/);
    // running → completed sin mensaje del asistente.
    await expect(
      query(`UPDATE agent_runs SET status = 'completed', finished_at = now() WHERE id = $1`, [run]),
    ).rejects.toThrow(/solo se completa con su mensaje del asistente/);
    // running → failed exige código de error.
    await expect(
      query(`UPDATE agent_runs SET status = 'failed', finished_at = now() WHERE id = $1`, [run]),
    ).rejects.toThrow(/agent_runs_error_coherente/);
    await query(
      `UPDATE agent_runs SET status = 'failed', finished_at = now(), error_code = 'MODEL_UNAVAILABLE' WHERE id = $1`,
      [run],
    );
    // Terminal: nada cambia, ni siquiera sin cambiar valores.
    await expect(query(`UPDATE agent_runs SET status = 'running' WHERE id = $1`, [run])).rejects.toThrow(
      /ya terminó/,
    );
    await expect(query(`UPDATE agent_runs SET error_message = 'x' WHERE id = $1`, [run])).rejects.toThrow(
      /ya terminó/,
    );
    await expect(query(`DELETE FROM agent_runs WHERE id = $1`, [run])).rejects.toThrow(/no se borra/);
  });

  it('la identidad del run (configuración, mensaje, intento) no se modifica', async () => {
    const conv = await nuevaConversacion();
    const msg = await nuevoMensajeUsuario(conv);
    const run = await nuevoRun(conv, msg);
    await expect(query(`UPDATE agent_runs SET model = 'otro' WHERE id = $1`, [run])).rejects.toThrow(
      /identidad de un run/,
    );
    await expect(query(`UPDATE agent_runs SET attempt = 2 WHERE id = $1`, [run])).rejects.toThrow(
      /identidad de un run/,
    );
    await expect(
      query(`UPDATE agent_runs SET queued_at = now() - interval '1 day' WHERE id = $1`, [run]),
    ).rejects.toThrow(/identidad de un run/);
  });

  it('el mensaje del asistente solo existe para un run en ejecución, en nombre de la misma persona', async () => {
    const conv = await nuevaConversacion();
    const msg = await nuevoMensajeUsuario(conv);
    const run = await nuevoRun(conv, msg);
    const insertar = (userId: string) =>
      query(
        `INSERT INTO chat_messages (organization_id, campaign_id, conversation_id, role, user_id, content, agent_run_id)
         VALUES ($1, $2, $3, 'assistant', $4, 'respuesta', $5)`,
        [e.admin.organizationId, e.campanaId, conv, userId, run],
      );
    await expect(insertar(e.consultor.id)).rejects.toThrow(/solo se escribe para un run en ejecución/);
    await iniciar(run);
    await expect(insertar(e.director.id)).rejects.toThrow(/en nombre de la persona/);
    await insertar(e.consultor.id);
    // Un run produce a lo sumo UNA respuesta.
    await expect(insertar(e.consultor.id)).rejects.toThrow(/chat_messages_run_key/);
    await query(`UPDATE agent_runs SET status = 'completed', finished_at = now() WHERE id = $1`, [run]);
    // Y una vez completado, otro mensaje de usuario sí entra.
    await nuevoMensajeUsuario(conv);
  });
});

describe('invocaciones de tools', () => {
  it('solo un run en ejecución abre invocaciones y una terminada no se reescribe', async () => {
    const conv = await nuevaConversacion();
    const msg = await nuevoMensajeUsuario(conv);
    const run = await nuevoRun(conv, msg);
    const abrir = (clave: string, seq: number) =>
      query<{ id: string }>(
        `INSERT INTO agent_tool_invocations (organization_id, campaign_id, agent_run_id, sequence, tool_name,
                                             risk_class, args_sha256, idempotency_key)
         VALUES ($1, $2, $3, $4, 'campaign_get', 'read', $5, $6) RETURNING id`,
        [e.admin.organizationId, e.campanaId, run, seq, HASH, clave],
      );
    await expect(abrir('k-1', 1)).rejects.toThrow(/Solo un run en ejecución/);
    await iniciar(run);
    const [t] = await abrir('k-1', 1);
    // Claves únicas por run (idempotencia) y secuencia única.
    await expect(abrir('k-1', 2)).rejects.toThrow(/agent_tool_invocations_clave_key/);
    await expect(abrir('k-2', 1)).rejects.toThrow(/agent_tool_invocations_secuencia_key/);
    // Un run no termina con una invocación abierta.
    await expect(
      query(`UPDATE agent_runs SET status = 'failed', error_code = 'X1', finished_at = now() WHERE id = $1`, [
        run,
      ]),
    ).rejects.toThrow(/invocaciones de tools abiertas/);
    await query(`UPDATE agent_tool_invocations SET status = 'succeeded', finished_at = now() WHERE id = $1`, [
      t!.id,
    ]);
    await expect(
      query(`UPDATE agent_tool_invocations SET status = 'failed', error_code = 'X1' WHERE id = $1`, [t!.id]),
    ).rejects.toThrow(/ya terminó/);
    await expect(
      query(`UPDATE agent_tool_invocations SET tool_name = 'otra' WHERE id = $1`, [t!.id]),
    ).rejects.toThrow(/ya terminó/);
    await expect(query(`DELETE FROM agent_tool_invocations WHERE id = $1`, [t!.id])).rejects.toThrow(
      /no se borra/,
    );
  });

  it('args y result están acotados y el resultado solo existe si la invocación fue exitosa', async () => {
    const conv = await nuevaConversacion();
    const msg = await nuevoMensajeUsuario(conv);
    const run = await nuevoRun(conv, msg);
    await iniciar(run);
    const grande = JSON.stringify({ texto: 'x'.repeat(17_000) });
    await expect(
      query(
        `INSERT INTO agent_tool_invocations (organization_id, campaign_id, agent_run_id, sequence, tool_name,
                                             risk_class, args, args_sha256, idempotency_key)
         VALUES ($1, $2, $3, 1, 'campaign_get', 'read', $4::jsonb, $5, 'k-grande')`,
        [e.admin.organizationId, e.campanaId, run, grande, HASH],
      ),
    ).rejects.toThrow(/agent_tool_invocations_args_acotados/);
    await expect(
      query(
        `INSERT INTO agent_tool_invocations (organization_id, campaign_id, agent_run_id, sequence, tool_name,
                                             risk_class, args, args_sha256, idempotency_key)
         VALUES ($1, $2, $3, 1, 'campaign_get', 'read', '[1]'::jsonb, $4, 'k-lista')`,
        [e.admin.organizationId, e.campanaId, run, HASH],
      ),
    ).rejects.toThrow(/agent_tool_invocations_args_acotados/);
    await expect(
      query(
        `INSERT INTO agent_tool_invocations (organization_id, campaign_id, agent_run_id, sequence, tool_name,
                                             risk_class, args_sha256, idempotency_key, result, status, finished_at)
         VALUES ($1, $2, $3, 1, 'campaign_get', 'read', $4, 'k-res', '{}'::jsonb, 'running', NULL)`,
        [e.admin.organizationId, e.campanaId, run, HASH],
      ),
    ).rejects.toThrow(/agent_tool_invocations_resultado_acotado/);
  });
});

describe('ai_runs: enlace con el run del agente', () => {
  it('el INSERT del worker (sin agent_run_id) sigue funcionando y el enlace respeta la organización', async () => {
    const [sinRun] = await query<{ id: string; agent_run_id: string | null; step_index: number | null }>(
      `INSERT INTO ai_runs (organization_id, campaign_id, task, tier, model, prompt_version, input_hash, output_status)
       VALUES ($1, $2, 'extraer_campos', 'eficiente', 'm', 'v1', 'h', 'ok') RETURNING id, agent_run_id, step_index`,
      [e.admin.organizationId, e.campanaId],
    );
    expect(sinRun!.agent_run_id).toBeNull();
    expect(sinRun!.step_index).toBeNull();

    const conv = await nuevaConversacion();
    const msg = await nuevoMensajeUsuario(conv);
    const run = await nuevoRun(conv, msg);
    const insertar = (org: string, campana: string | null, paso: number | null) =>
      query(
        `INSERT INTO ai_runs (organization_id, campaign_id, task, tier, model, prompt_version, input_hash,
                              output_status, agent_run_id, step_index)
         VALUES ($1, $2, 'conversar', 'equilibrado', 'm', 'v1', 'h', 'ok', $3, $4)`,
        [org, campana, run, paso],
      );
    await insertar(e.admin.organizationId, e.campanaId, 0);
    // Otra organización no puede colgar costo del run.
    await expect(insertar(e.ajeno.organizationId, null, 0)).rejects.toThrow(/ai_runs_agent_run_fkey/);
    // Otra campaña distinta de la del run.
    await expect(insertar(e.admin.organizationId, e.otraCampanaId, 0)).rejects.toThrow(
      /otra campaña|campaña distinta/,
    );
    // step_index negativo.
    await expect(insertar(e.admin.organizationId, e.campanaId, -1)).rejects.toThrow(/ai_runs_step_valido/);
  });
});

describe('sin razonamiento interno del modelo y artefactos de la migración', () => {
  it('ninguna tabla del chat tiene una columna de razonamiento / chain-of-thought', async () => {
    const columnas = await query<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name IN ('chat_conversations', 'chat_messages', 'chat_message_attachments',
                             'chat_message_references', 'agent_runs', 'agent_tool_invocations')`,
    );
    expect(columnas.length).toBeGreaterThan(40);
    const sospechosas = columnas.filter((c) =>
      /reason|thought|thinking|cot|scratch|monolog|chain/i.test(c.column_name),
    );
    expect(sospechosas).toEqual([]);
  });

  it('existen los índices parciales y de expresión de la migración', async () => {
    const filas = await query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE schemaname = 'public'
        AND indexname IN ('agent_runs_activo_key', 'agent_runs_completado_key', 'proposed_actions_abierta_key',
                          'audit_events_conversation_idx', 'audit_events_message_idx',
                          'audit_events_agent_run_idx', 'audit_events_tool_invocation_idx')`,
    );
    expect(filas.map((f) => f.indexname).sort()).toEqual([
      'agent_runs_activo_key',
      'agent_runs_completado_key',
      'audit_events_agent_run_idx',
      'audit_events_conversation_idx',
      'audit_events_message_idx',
      'audit_events_tool_invocation_idx',
      'proposed_actions_abierta_key',
    ]);
  });

  it('no hay trigger de validación sobre audit_events (D5): solo el de solo-inserción', async () => {
    const filas = await query<{ tgname: string }>(
      `SELECT tgname FROM pg_trigger WHERE tgrelid = 'audit_events'::regclass AND NOT tgisinternal`,
    );
    expect(filas.map((f) => f.tgname)).toEqual(['audit_events_no_update']);
  });
});

describe('una sola propuesta abierta por acción y recurso (D7)', () => {
  async function proponer(tipo: string, recurso: string, estado = 'pending') {
    return query(
      `INSERT INTO proposed_actions (organization_id, campaign_id, action_type, resource_type, resource_id, payload,
                                     payload_hash, status, proposed_origin, expires_at, confirmed_by, confirmed_at)
       VALUES ($1, $2, $3, 'brief_version', $4, '{}'::jsonb, $5, $6, 'chat', now() + interval '1 day',
               CASE WHEN $6 = 'confirmed' THEN $7::uuid END, CASE WHEN $6 = 'confirmed' THEN now() END)
       RETURNING id`,
      [e.admin.organizationId, e.campanaId, tipo, recurso, `h-${Math.random()}`, estado, e.admin.id],
    );
  }

  it('la base rechaza dos abiertas (pending/confirmed) y admite una nueva tras vencer la anterior', async () => {
    const recurso = (await query<{ id: string }>(`SELECT uuid_generate_v4() AS id`))[0]!.id;
    const [primera] = (await proponer('brief.approve', recurso)) as unknown as { id: string }[];
    await expect(proponer('brief.approve', recurso)).rejects.toThrow(/proposed_actions_abierta_key/);
    await expect(proponer('brief.approve', recurso, 'confirmed')).rejects.toThrow(
      /proposed_actions_abierta_key/,
    );
    // Otro tipo de acción sobre el mismo recurso es otra propuesta.
    await proponer('influencer_import.apply', recurso);
    await query(`UPDATE proposed_actions SET status = 'expired' WHERE id = $1`, [primera!.id]);
    await proponer('brief.approve', recurso);
  });

  it('las propuestas terminales no estorban', async () => {
    const recurso = (await query<{ id: string }>(`SELECT uuid_generate_v4() AS id`))[0]!.id;
    const [a] = (await proponer('brief.approve', recurso)) as unknown as { id: string }[];
    await query(
      `UPDATE proposed_actions SET status = 'cancelled', cancelled_by = $2, cancelled_at = now() WHERE id = $1`,
      [a!.id, e.admin.id],
    );
    const [b] = (await proponer('brief.approve', recurso)) as unknown as { id: string }[];
    await query(`UPDATE proposed_actions SET status = 'expired' WHERE id = $1`, [b!.id]);
    await proponer('brief.approve', recurso);
    const [{ n } = { n: '0' }] = await query<{ n: string }>(
      `SELECT count(*) AS n FROM proposed_actions WHERE resource_id = $1`,
      [recurso],
    );
    expect(Number(n)).toBe(3);
  });
});

describe('limpieza con el bypass restringido a bases de prueba', () => {
  it('eliminarCampanaDePrueba borra el chat completo de una campaña (hechos históricos incluidos)', async () => {
    const [c] = await query<{ id: string }>(
      `INSERT INTO campaigns (organization_id, name, owner_id, created_by) VALUES ($1, $2, $3, $3) RETURNING id`,
      [e.admin.organizationId, `Limpieza chat · ${e.sufijo}`, e.admin.id],
    );
    const conv = await query<{ id: string }>(
      `INSERT INTO chat_conversations (organization_id, campaign_id, created_by) VALUES ($1, $2, $3) RETURNING id`,
      [e.admin.organizationId, c!.id, e.consultor.id],
    );
    const [m] = await query<{ id: string }>(
      `INSERT INTO chat_messages (organization_id, campaign_id, conversation_id, role, user_id, content, client_message_id)
       VALUES ($1, $2, $3, 'user', $4, 'hola', 'clave-limpieza-01') RETURNING id`,
      [e.admin.organizationId, c!.id, conv[0]!.id, e.consultor.id],
    );
    await query(
      `INSERT INTO agent_runs (organization_id, campaign_id, conversation_id, user_message_id, user_id, provider, model,
                               tier, prompt_version, context_version)
       VALUES ($1, $2, $3, $4, $5, 'p', 'm', 'equilibrado', 'v1', 'c1')`,
      [e.admin.organizationId, c!.id, conv[0]!.id, m!.id, e.consultor.id],
    );
    await eliminarCampanaDePrueba(c!.id);
    const [{ n } = { n: '0' }] = await query<{ n: string }>(
      `SELECT count(*) AS n FROM chat_conversations WHERE campaign_id = $1`,
      [c!.id],
    );
    expect(Number(n)).toBe(0);
    // El bypass no se activa fuera de la transacción de limpieza.
    await expect(transaction((client) => client.query(`SELECT 1`))).resolves.toBeDefined();
  });
});
