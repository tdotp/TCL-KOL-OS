/**
 * Mensajes del chat de Cuenta (V2 · Fase 6).
 *
 *   publicarMensaje: mensaje de usuario (+ adjuntos) + run `queued`, en UNA transacción.
 *
 *  · Idempotente por `clientMessageId` (UNIQUE por conversación): reenviar el mismo
 *    mensaje devuelve el mismo mensaje y el mismo run (`replayed: true`); la misma
 *    clave con otro contenido, otro autor u otros adjuntos es un conflicto
 *    (`client_message_id_reused`).
 *  · Un solo run activo por conversación: con uno activo no se admite otro mensaje
 *    (`run_in_progress`). Antes se cierran los runs abandonados de la conversación.
 *  · Un adjunto es una fuente (`source_documents`) YA registrada por el flujo de
 *    fuentes y de la MISMA organización y campaña que la conversación. No hay un
 *    blob paralelo del mensaje. El archivo se sube antes (ruta HTTP de adjuntos →
 *    `uploadSource`); un fallo intermedio deja una fuente sin adjuntar (benigno).
 *  · Los mensajes son append-only (la base rechaza UPDATE). El del asistente lo
 *    escribe `completarRun` (agent-runs.ts), nunca esta función.
 *  · No se audita cada mensaje (no es una mutación sensible del dominio): los efectos
 *    los audita cada caso de uso con origen `chat` y correlación al mensaje/run.
 */

import {
  type AgentRun,
  type AgentRunConfig,
  type ChatMessage,
  type Result,
  type User,
  CHAT_CONFLICT_REASONS,
  err,
  ok,
  validarAdjuntos,
  validarClientMessageId,
  validarConfiguracionDeRun,
  validarContenidoMensaje,
} from '@tcl-kol-os/domain';
import {
  CHAT_NO_ENCONTRADO,
  chatCargarConversacionAutorizada,
  chatCargarMensajePorId,
  chatCargarMensajes,
  chatEstadoDeCampana,
  chatSha256,
} from './chat-conversations.ts';
import { chatCerrarRunsCaducados, chatInsertarRun, chatUltimoRunDeMensaje } from './agent-runs.ts';
import { getPool } from './client.ts';
import { Abortar, transaccionConResultado } from './tx-result.ts';

const CONFLICTO_MENSAJE = {
  code: 'RESOURCE_CONFLICT',
  message: 'La conversación cambió mientras se procesaba el mensaje. Reintente.',
  details: { reason: CHAT_CONFLICT_REASONS.runInProgress },
} as const;

export interface PublicarMensajeInput {
  readonly conversationId: string;
  /** Clave de idempotencia generada por la interfaz para este envío (p. ej. un UUID). */
  readonly clientMessageId: string;
  readonly content: string;
  /** Fuentes ya registradas en la campaña de la conversación. */
  readonly sourceIds?: readonly string[] | undefined;
  /** Configuración con la que se admite el run (la conoce el runtime del agente). */
  readonly runConfig: AgentRunConfig;
}

export interface MensajePublicado {
  readonly message: ChatMessage;
  readonly run: AgentRun;
  /** `true` si era un reenvío de un mensaje ya publicado: no se creó nada nuevo. */
  readonly replayed: boolean;
}

/**
 * Publica un mensaje de usuario y deja el run `queued` que lo atenderá. El
 * disparo del agente (`after()`) es de la capa de aplicación, DESPUÉS de este commit.
 */
export async function publicarMensaje(
  actor: User,
  input: PublicarMensajeInput,
): Promise<Result<MensajePublicado>> {
  return transaccionConResultado(async (client) => {
    // 1. Candado de la conversación + autorización (owner-scoped, chat:write).
    const cargada = await chatCargarConversacionAutorizada(
      client,
      actor,
      'chat:write',
      input.conversationId,
      true,
    );
    if (!cargada.ok) {
      throw new Abortar({
        code: cargada.error.code,
        message: cargada.error.message,
        details: cargada.error.details,
      });
    }
    const conversacion = cargada.value;

    // 2. Validaciones de forma (después de autorizar: un rol sin capacidad no sondea).
    const contenido = validarContenidoMensaje(input.content);
    if (!contenido.ok)
      throw new Abortar({
        code: contenido.error.code,
        message: contenido.error.message,
        details: contenido.error.details,
      });
    const clave = validarClientMessageId(input.clientMessageId);
    if (!clave.ok)
      throw new Abortar({
        code: clave.error.code,
        message: clave.error.message,
        details: clave.error.details,
      });
    const adjuntos = validarAdjuntos(input.sourceIds);
    if (!adjuntos.ok)
      throw new Abortar({
        code: adjuntos.error.code,
        message: adjuntos.error.message,
        details: adjuntos.error.details,
      });
    const config = validarConfiguracionDeRun(input.runConfig);
    if (!config.ok)
      throw new Abortar({
        code: config.error.code,
        message: config.error.message,
        details: config.error.details,
      });

    // 3. Replay idempotente.
    const { rows: previos } = await client.query<{ id: string; user_id: string; content_sha256: string }>(
      `SELECT id, user_id, content_sha256 FROM chat_messages
        WHERE conversation_id = $1 AND client_message_id = $2`,
      [conversacion.id, clave.value],
    );
    const previo = previos[0];
    if (previo !== undefined) {
      const existente = (await chatCargarMensajePorId(client, previo.id))!;
      const mismosAdjuntos =
        existente.attachments.length === adjuntos.value.length &&
        existente.attachments.every((a, i) => a.sourceId === adjuntos.value[i]);
      if (
        previo.user_id !== actor.id ||
        previo.content_sha256 !== chatSha256(contenido.value) ||
        !mismosAdjuntos
      ) {
        throw new Abortar({
          code: 'RESOURCE_CONFLICT',
          message: 'Esa clave de mensaje ya se usó con otro contenido.',
          details: { reason: CHAT_CONFLICT_REASONS.clientMessageIdReused },
        });
      }
      const run = await chatUltimoRunDeMensaje(client, existente.id);
      if (run === undefined) throw new Abortar(CHAT_NO_ENCONTRADO);
      return { message: existente, run, replayed: true };
    }

    // 4. Conversación y campaña en estado de recibir mensajes.
    if (conversacion.status === 'archived') {
      throw new Abortar({
        code: 'RESOURCE_CONFLICT',
        message: 'La conversación está archivada.',
        details: { reason: CHAT_CONFLICT_REASONS.conversationArchived },
      });
    }
    const estadoCampana = await chatEstadoDeCampana(
      client,
      conversacion.organizationId,
      conversacion.campaignId,
    );
    if (estadoCampana !== 'activa') {
      throw new Abortar({
        code: 'RESOURCE_CONFLICT',
        message: 'La campaña no está activa: no admite mensajes nuevos.',
        details: { reason: CHAT_CONFLICT_REASONS.campaignNotActive, status: estadoCampana },
      });
    }

    // 5. Un solo run activo: primero se cierran los abandonados de esta conversación.
    await chatCerrarRunsCaducados(client, { conversationId: conversacion.id });
    const { rows: activos } = await client.query<{ id: string }>(
      `SELECT id FROM agent_runs WHERE conversation_id = $1 AND status IN ('queued', 'running')`,
      [conversacion.id],
    );
    if (activos[0] !== undefined) {
      throw new Abortar({
        code: 'RESOURCE_CONFLICT',
        message: 'El agente sigue respondiendo el mensaje anterior.',
        details: { reason: CHAT_CONFLICT_REASONS.runInProgress, runId: activos[0].id },
      });
    }

    // 6. Adjuntos: fuentes de la misma organización Y campaña (mismo error si no existen,
    //    son de otra campaña o de otra organización: no se revela cuál).
    if (adjuntos.value.length > 0) {
      const { rows: validas } = await client
        .query<{ id: string }>(
          `SELECT id FROM source_documents
            WHERE id = ANY($1::uuid[]) AND organization_id = $2 AND campaign_id = $3`,
          [adjuntos.value, conversacion.organizationId, conversacion.campaignId],
        )
        .catch((error: unknown) => {
          if ((error as { code?: string }).code === '22P02') return { rows: [] as { id: string }[] };
          throw error;
        });
      if (validas.length !== adjuntos.value.length) {
        throw new Abortar({
          code: 'RESOURCE_NOT_FOUND',
          message: 'Una de las fuentes adjuntas no existe o no está disponible en esta campaña.',
          details: { reason: CHAT_CONFLICT_REASONS.attachmentScope },
        });
      }
    }

    // 7. Mensaje + adjuntos + run, en la misma transacción.
    const { rows: nuevo } = await client.query<{ id: string }>(
      `INSERT INTO chat_messages
         (organization_id, campaign_id, conversation_id, role, user_id, content, client_message_id)
       VALUES ($1, $2, $3, 'user', $4, $5, $6) RETURNING id`,
      [
        conversacion.organizationId,
        conversacion.campaignId,
        conversacion.id,
        actor.id,
        contenido.value,
        clave.value,
      ],
    );
    const mensajeId = nuevo[0]!.id;
    let posicion = 0;
    for (const sourceId of adjuntos.value) {
      posicion += 1;
      await client.query(
        `INSERT INTO chat_message_attachments
           (organization_id, campaign_id, conversation_id, message_id, source_id, position)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          conversacion.organizationId,
          conversacion.campaignId,
          conversacion.id,
          mensajeId,
          sourceId,
          posicion,
        ],
      );
    }
    const run = await chatInsertarRun(client, {
      organizationId: conversacion.organizationId,
      campaignId: conversacion.campaignId,
      conversationId: conversacion.id,
      userMessageId: mensajeId,
      userId: actor.id,
      attempt: 1,
      config: config.value,
    });
    const message = (await chatCargarMensajePorId(client, mensajeId))!;
    return { message, run, replayed: false };
  }, CONFLICTO_MENSAJE);
}

export interface ListarMensajesOpciones {
  /** Solo los mensajes con `seq` mayor (para sondeo incremental). */
  readonly desdeSeq?: number | undefined;
  readonly limite?: number | undefined;
  /** Los últimos `limite` mensajes en vez de los primeros. */
  readonly ultimos?: boolean | undefined;
}

/** Mensajes de una conversación propia, en orden, con adjuntos y citas. */
export async function listarMensajes(
  actor: User,
  conversationId: string,
  opciones: ListarMensajesOpciones = {},
): Promise<Result<ChatMessage[]>> {
  const cargada = await chatCargarConversacionAutorizada(getPool(), actor, 'chat:read', conversationId);
  if (!cargada.ok) return err(cargada.error);
  return ok(await chatCargarMensajes(getPool(), conversationId, opciones));
}

/** Un mensaje por id (de una conversación propia). */
export async function obtenerMensaje(actor: User, messageId: string): Promise<Result<ChatMessage>> {
  const mensaje = await chatCargarMensajePorId(getPool(), messageId).catch((error: unknown) => {
    if ((error as { code?: string }).code === '22P02') return undefined;
    throw error;
  });
  if (mensaje === undefined) return err(CHAT_NO_ENCONTRADO);
  const cargada = await chatCargarConversacionAutorizada(
    getPool(),
    actor,
    'chat:read',
    mensaje.conversationId,
  );
  if (!cargada.ok) return err(cargada.error);
  return ok(mensaje);
}
