/**
 * QA adversarial · PRUEBAS ROJAS de la capa db del chat (hoy FALLAN a propósito: demuestran defectos).
 * No se tocó código de producto. Ver el reporte del QA para severidad y corrección sugerida.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Result, User } from '@tcl-kol-os/domain';
import { closePool, query } from './client.ts';
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
const clave = () => `qa-red-${Date.now().toString(36)}-${++n}-xxxxxxxx`;
const valor = <T>(r: Result<T>): T => {
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
  return r.value;
};

beforeAll(async () => {
  e = await crearEscenarioDeChat('QA defectos db');
});
afterAll(async () => {
  await eliminarCampanaDePrueba(e.campanas);
  await closePool();
});

async function conversacionCerrada(dueno: User) {
  const conv = valor(await crearConversacion(dueno, { campaignId: e.campanaId }));
  const pub = valor(
    await publicarMensaje(dueno, {
      conversationId: conv.id,
      clientMessageId: clave(),
      content: 'hola',
      runConfig: CONFIG_DE_RUN_DE_PRUEBA,
    }),
  );
  valor(await fallarRun(dueno, pub.run.id, { errorCode: 'FIN_DE_QA' }));
  return conv;
}

describe('QA-10 · owner-scope solo en los casos de uso: el esquema deja que otro usuario escriba en la conversación ajena', () => {
  it.fails(
    'DEUDA (defensa en profundidad) · un mensaje de usuario de OTRA persona de la organización en una conversación que no es suya debería rechazarse en la base',
    async () => {
      const conv = await conversacionCerrada(e.consultor);
      let rechazo = '';
      try {
        await query(
          `INSERT INTO chat_messages (organization_id, campaign_id, conversation_id, role, user_id, content, client_message_id)
         VALUES ($1, $2, $3, 'user', $4, 'escrito por el director en la conversación del consultor', $5)`,
          [e.admin.organizationId, e.campanaId, conv.id, e.director.id, clave()],
        );
      } catch (err) {
        rechazo = (err as Error).message;
      }
      // DEBERÍA: trigger que exija autor = created_by de la conversación. Hoy el INSERT pasa.
      expect(rechazo).not.toBe('');
    },
  );
});

describe('QA-11 · chat_exigir_personal_de_agencia solo excluye `cliente`: un analista/legal/operativo puede ser dueño por SQL', () => {
  it.fails(
    'DEUDA (defensa en profundidad) · una conversación creada por SQL para un usuario sin chat:write (operativo) debería rechazarse',
    async () => {
      let rechazo = '';
      try {
        await query(
          `INSERT INTO chat_conversations (organization_id, campaign_id, created_by) VALUES ($1, $2, $3)`,
          [e.admin.organizationId, e.campanaId, e.operativo.id],
        );
      } catch (err) {
        rechazo = (err as Error).message;
      }
      expect(rechazo).not.toBe('');
    },
  );
});

describe('QA-12 · proposed_actions admite INSERT directo de estados terminales (el trigger de integridad solo cubre UPDATE/DELETE)', () => {
  it.fails(
    'DEUDA (defensa en profundidad) · una propuesta insertada ya como `executed` con confirmed_by arbitrario debería rechazarse (toda propuesta nace pending)',
    async () => {
      let rechazo = '';
      try {
        await query(
          `INSERT INTO proposed_actions (organization_id, campaign_id, action_type, resource_type, resource_id, payload, payload_hash,
                                       status, proposed_origin, confirmed_by, confirmed_at, executed_at, expires_at)
         VALUES ($1, $2, 'brief.approve', 'brief_version', gen_random_uuid(), '{}'::jsonb, $3,
                 'executed', 'chat', $4, now(), now(), now() + interval '1 hour')`,
          [e.admin.organizationId, e.campanaId, 'a'.repeat(64), e.consultor.id],
        );
      } catch (err) {
        rechazo = (err as Error).message;
      }
      expect(rechazo).not.toBe('');
    },
  );
});
