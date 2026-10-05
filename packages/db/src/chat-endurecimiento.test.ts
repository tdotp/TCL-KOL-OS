/**
 * Fase 6.1 · migración 022: defensa en profundidad en la BASE (cierra QA-10, QA-11 y QA-12).
 *
 * Todo se ataca por SQL directo, saltándose los casos de uso: la base debe rechazarlo sola.
 *   QA-10 · solo la persona dueña de una conversación escribe en ella.
 *   QA-11 · el dueño (y el autor de mensajes/runs) debe ser admin, director o consultor de una agencia.
 *   QA-12 · una acción propuesta nace `pending`; los demás estados solo se alcanzan por transición.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Result, type Role, type User, roleCan } from '@tcl-kol-os/domain';
import { closePool, getPool, query } from './client.ts';
import { crearConversacion } from './chat-conversations.ts';
import { publicarMensaje } from './chat-messages.ts';
import { fallarRun } from './agent-runs.ts';
import {
  CONFIG_DE_RUN_DE_PRUEBA,
  type EscenarioDeChat,
  crearEscenarioDeChat,
  eliminarCampanaDePrueba,
} from './test-utils.ts';

let e: EscenarioDeChat;
let n = 0;
const clave = () => `f61-${Date.now().toString(36)}-${++n}-xxxxxxxx`;
const valor = <T>(r: Result<T>): T => {
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
  return r.value;
};

beforeAll(async () => {
  e = await crearEscenarioDeChat('F6.1 endurecimiento');
});
afterAll(async () => {
  await eliminarCampanaDePrueba(e.campanas);
  await closePool();
});

/** Ejecuta SQL y devuelve el mensaje del rechazo de la base ('' si pasó). */
async function rechazo(sql: string, params: unknown[]): Promise<string> {
  try {
    await query(sql, params);
    return '';
  } catch (error) {
    return (error as Error).message;
  }
}

/** Conversación del dueño con un turno ya cerrado (para poder escribir otro mensaje). */
async function conversacionDe(dueno: User) {
  const conv = valor(await crearConversacion(dueno, { campaignId: e.campanaId }));
  const pub = valor(
    await publicarMensaje(dueno, {
      conversationId: conv.id,
      clientMessageId: clave(),
      content: 'hola',
      runConfig: CONFIG_DE_RUN_DE_PRUEBA,
    }),
  );
  valor(await fallarRun(dueno, pub.run.id, { errorCode: 'FIN_DE_PRUEBA' }));
  return conv;
}

const contarMensajes = async (conversationId: string): Promise<number> =>
  Number(
    (
      await query<{ c: string }>(`SELECT count(*)::text AS c FROM chat_messages WHERE conversation_id = $1`, [
        conversationId,
      ])
    )[0]?.c,
  );

const INSERTAR_MENSAJE = `INSERT INTO chat_messages (organization_id, campaign_id, conversation_id, role, user_id, content, client_message_id)
                          VALUES ($1, $2, $3, 'user', $4, 'escrito por SQL directo', $5)`;

describe('QA-10 · owner-scope de mensajes en la base', () => {
  it('un mensaje de OTRA persona con chat:write de la misma organización se rechaza, aunque la conversación esté libre', async () => {
    const conv = await conversacionDe(e.consultor);
    const antes = await contarMensajes(conv.id);
    for (const intruso of [e.director, e.admin]) {
      const mensaje = await rechazo(INSERTAR_MENSAJE, [
        e.admin.organizationId,
        e.campanaId,
        conv.id,
        intruso.id,
        clave(),
      ]);
      expect(mensaje).toMatch(/personal: solo la persona que la creó/);
    }
    expect(await contarMensajes(conv.id)).toBe(antes);
  });

  it('el dueño sí escribe (por el caso de uso) y la base no estorba al flujo normal', async () => {
    const conv = await conversacionDe(e.consultor);
    const otra = valor(
      await publicarMensaje(e.consultor, {
        conversationId: conv.id,
        clientMessageId: clave(),
        content: 'segundo turno',
        runConfig: CONFIG_DE_RUN_DE_PRUEBA,
      }),
    );
    expect(otra.message.seq).toBe(2);
    valor(await fallarRun(e.consultor, otra.run.id, { errorCode: 'FIN_DE_PRUEBA' }));
  });

  it('un mensaje del asistente a nombre de otra persona sigue rechazado (run ajeno)', async () => {
    const conv = valor(await crearConversacion(e.consultor, { campaignId: e.campanaId }));
    const pub = valor(
      await publicarMensaje(e.consultor, {
        conversationId: conv.id,
        clientMessageId: clave(),
        content: 'hola',
        runConfig: CONFIG_DE_RUN_DE_PRUEBA,
      }),
    );
    const mensaje = await rechazo(
      `INSERT INTO chat_messages (organization_id, campaign_id, conversation_id, role, user_id, content, agent_run_id)
       VALUES ($1, $2, $3, 'assistant', $4, 'respuesta falsa', $5)`,
      [e.admin.organizationId, e.campanaId, conv.id, e.director.id, pub.run.id],
    );
    expect(mensaje).not.toBe('');
    valor(await fallarRun(e.consultor, pub.run.id, { errorCode: 'FIN_DE_PRUEBA' }));
  });
});

describe('QA-11 · rol autorizado del dueño en la base', () => {
  const sinChat = (): Array<[string, User]> => [
    ['operativo', e.operativo],
    ['analista', e.analista],
    ['legal', e.legal],
  ];

  it('crear una conversación para un rol sin chat:write se rechaza por SQL directo', async () => {
    for (const [rol, usuario] of sinChat()) {
      const mensaje = await rechazo(
        `INSERT INTO chat_conversations (organization_id, campaign_id, created_by) VALUES ($1, $2, $3)`,
        [e.admin.organizationId, e.campanaId, usuario.id],
      );
      expect(mensaje, rol).toMatch(/admin, director o consultor/);
    }
    const [fila] = await query<{ c: string }>(
      `SELECT count(*)::text AS c FROM chat_conversations WHERE campaign_id = $1 AND created_by = ANY($2::uuid[])`,
      [e.campanaId, sinChat().map(([, u]) => u.id)],
    );
    expect(fila?.c).toBe('0');
  });

  it('el cliente (TCL) tampoco, aunque se le fuerce la organización de la agencia', async () => {
    const mensaje = await rechazo(
      `INSERT INTO chat_conversations (organization_id, campaign_id, created_by) VALUES ($1, $2, $3)`,
      [e.admin.organizationId, e.campanaId, e.cliente.id],
    );
    expect(mensaje).not.toBe('');
  });

  it('un rol degradado después de crear la conversación ya no puede escribir en ella por SQL directo', async () => {
    const conv = await conversacionDe(e.consultor);
    const antes = await contarMensajes(conv.id);
    await query(`UPDATE users SET role = 'operativo' WHERE id = $1`, [e.consultor.id]);
    try {
      const mensaje = await rechazo(INSERTAR_MENSAJE, [
        e.admin.organizationId,
        e.campanaId,
        conv.id,
        e.consultor.id,
        clave(),
      ]);
      expect(mensaje).toMatch(/admin, director o consultor/);
    } finally {
      await query(`UPDATE users SET role = 'consultor' WHERE id = $1`, [e.consultor.id]);
    }
    expect(await contarMensajes(conv.id)).toBe(antes);
  });

  it('admin y director sí son dueños válidos (la base no es más estricta que el dominio)', async () => {
    for (const dueno of [e.admin, e.director]) {
      const conv = valor(await crearConversacion(dueno, { campaignId: e.campanaId }));
      expect(conv.id).toBeTruthy();
    }
  });

  it('paridad con el dominio: la base acepta exactamente los roles con chat:write', async () => {
    const porRol: Array<[Role, User]> = [
      ['admin', e.admin],
      ['director', e.director],
      ['consultor', e.consultor],
      ['operativo', e.operativo],
      ['analista', e.analista],
      ['legal', e.legal],
      ['cliente', e.cliente],
    ];
    for (const [rol, usuario] of porRol) {
      let acepta = true;
      try {
        await getPool().query(`SELECT chat_exigir_personal_de_agencia($1)`, [usuario.id]);
      } catch {
        acepta = false;
      }
      expect(acepta, `la base y roleCan(${rol}, 'chat:write') divergen`).toBe(roleCan(rol, 'chat:write'));
    }
  });
});

describe('QA-12 · una acción propuesta nace pending (INSERT directo)', () => {
  const INSERTAR = `INSERT INTO proposed_actions (organization_id, campaign_id, action_type, resource_type, resource_id, payload, payload_hash,
                                               status, proposed_origin, confirmed_by, confirmed_at, executed_at, cancelled_by, cancelled_at, expires_at)
                    VALUES ($1, $2, 'brief.approve', 'brief_version', gen_random_uuid(), '{}'::jsonb, $3,
                            $4, 'chat', $5, $6::timestamptz, $7::timestamptz, $8, $9::timestamptz, now() + interval '1 hour')
                    RETURNING id`;
  const base = (hash: string, estado: string, over: Partial<Record<number, unknown>> = {}) => {
    const p: unknown[] = [e.admin.organizationId, e.campanaId, hash, estado, null, null, null, null, null];
    for (const [i, v] of Object.entries(over)) p[Number(i)] = v;
    return p;
  };
  const ahora = new Date().toISOString();

  it('insertar ya como confirmed, executed, cancelled o expired se rechaza', async () => {
    const casos: Array<[string, Partial<Record<number, unknown>>]> = [
      ['confirmed', { 4: e.director.id, 5: ahora }],
      ['executed', { 4: e.director.id, 5: ahora, 6: ahora }],
      ['cancelled', { 7: e.consultor.id, 8: ahora }],
      ['expired', {}],
    ];
    for (const [estado, extra] of casos) {
      const mensaje = await rechazo(INSERTAR, base('b'.repeat(64), estado, extra));
      expect(mensaje, estado).toMatch(/nace pendiente/);
    }
    const [fila] = await query<{ c: string }>(
      `SELECT count(*)::text AS c FROM proposed_actions WHERE campaign_id = $1 AND payload_hash = $2`,
      [e.campanaId, 'b'.repeat(64)],
    );
    expect(fila?.c).toBe('0');
  });

  it('un pending con marcas de confirmación, ejecución o cancelación también se rechaza', async () => {
    const casos: Array<Partial<Record<number, unknown>>> = [
      { 4: e.director.id },
      { 5: ahora },
      { 6: ahora },
      { 7: e.consultor.id },
      { 8: ahora },
    ];
    for (const extra of casos) {
      const mensaje = await rechazo(INSERTAR, base('c'.repeat(64), 'pending', extra));
      expect(mensaje).toMatch(/nace pendiente/);
    }
  });

  it('el bypass de borrado histórico de las bases _test NO permite insertar estados terminales', async () => {
    const cliente = await getPool().connect();
    try {
      await cliente.query('BEGIN');
      await cliente.query(`SET LOCAL tclkolos.permitir_borrado_historico = 'on'`);
      await expect(
        cliente.query(INSERTAR, base('d'.repeat(64), 'executed', { 4: e.director.id, 5: ahora, 6: ahora })),
      ).rejects.toThrow(/nace pendiente/);
    } finally {
      await cliente.query('ROLLBACK');
      cliente.release();
    }
  });

  it('una propuesta pending sí nace y sigue el camino legal pending → confirmed → executed por UPDATE', async () => {
    const [creada] = await query<{ id: string }>(INSERTAR, base('e'.repeat(64), 'pending'));
    const id = creada!.id;
    await query(
      `UPDATE proposed_actions SET status = 'confirmed', confirmed_by = $2, confirmed_at = now() WHERE id = $1`,
      [id, e.director.id],
    );
    await query(`UPDATE proposed_actions SET status = 'executed', executed_at = now() WHERE id = $1`, [id]);
    const [fila] = await query<{ status: string }>(`SELECT status FROM proposed_actions WHERE id = $1`, [id]);
    expect(fila?.status).toBe('executed');
    // y los terminales siguen siéndolo (regla de la 013, sin cambios)
    expect(await rechazo(`UPDATE proposed_actions SET status = 'pending' WHERE id = $1`, [id])).toMatch(
      /Transición de acción propuesta no válida/,
    );
  });
});
