'use server';

/**
 * Server actions del chat de Cuenta (V2 · Fase 6, Wave 3).
 *
 * Adaptadores finos: cada una resuelve la PERSONA (`currentUser`, releída de la base en
 * cada llamada), comprueba que la campaña es de su organización y que su rol puede usar
 * el chat, y delega en los casos de uso existentes (`admitirTurno`, `cancelarRun`,
 * `barrerYReintentar`, `confirmarAccion`, `ejecutarAccion`, `cancelarAccion`). Aquí no se
 * decide ninguna regla de negocio.
 *
 * Reglas de esta capa:
 *  · El cliente NUNCA elige organización, conversación, origen ni canal. Lo único que
 *    manda es la campaña (verificada), el texto, la clave de idempotencia del envío y los
 *    ids de fuentes ya subidas (verificados contra la campaña por `publicarMensaje`).
 *  · La confirmación humana de una acción propuesta usa el canal `'ui'` FIJO en servidor;
 *    es el único camino propuesta → confirmación → ejecución y solo existe aquí.
 *  · Los errores se traducen a mensajes en español; nunca se devuelven trazas.
 *  · El texto de los mensajes y de las propuestas es dato: aquí no se interpreta ni se
 *    ejecuta nada de lo que digan.
 */

import { revalidatePath } from 'next/cache';
import { barrerYReintentar, admitirTurno } from '@tcl-kol-os/agent';
import {
  cancelarAccion,
  cancelarRun,
  confirmarAccion,
  ejecutarAccion,
  getCampaign,
  obtenerAccionDeChat,
  obtenerMensaje,
  obtenerRun,
} from '@tcl-kol-os/db';
import { type DomainErrorCode, type User, roleCan } from '@tcl-kol-os/domain';
import { currentUser } from './session.ts';
import { dispararRunEnSegundoPlano, estadoDelAsistente, obtenerOCrearConversacion } from './chat-server.ts';

export type ResultadoDeChat<T extends object = object> =
  | ({ readonly ok: true } & T)
  | {
      readonly ok: false;
      readonly error: string;
      /** Código estable para la interfaz (p. ej. `SESSION`, `PROPOSAL_STALE`); sin detalles internos. */
      readonly codigo: string;
    };

const GENERICO = 'Ocurrió un error inesperado. Inténtalo de nuevo.';

const fallo = (error: string, codigo: string): { ok: false; error: string; codigo: string } => ({
  ok: false,
  error,
  codigo,
});

/** Traduce un error de dominio a un texto en español, sin detalles internos. */
function mensajeDe(error: {
  readonly code: DomainErrorCode;
  readonly message: string;
  readonly details?: Readonly<Record<string, unknown>> | undefined;
}): string {
  const razon = error.details?.['reason'];
  switch (error.code) {
    case 'FORBIDDEN_ROLE':
      return 'Tu rol no puede realizar esta acción.';
    case 'RESOURCE_NOT_FOUND':
      return 'No encontramos ese elemento. Recarga la página e inténtalo de nuevo.';
    case 'AI_DISABLED':
      return 'La IA está desactivada: el asistente no puede responder ahora.';
    case 'PROPOSAL_EXPIRED':
      return 'La propuesta venció. Pídele al asistente que la proponga de nuevo.';
    case 'PROPOSAL_INVALID_STATE':
      return 'La propuesta ya no admite esa acción (puede que ya se haya confirmado, ejecutado o cancelado). Recarga la página.';
    case 'HUMAN_CONFIRMATION_REQUIRED':
      return 'Esta acción solo la confirma una persona desde la interfaz.';
    case 'RESOURCE_CONFLICT':
      switch (razon) {
        case 'run_in_progress':
          return 'El asistente sigue respondiendo el mensaje anterior. Espera a que termine o cancélalo.';
        case 'client_message_id_reused':
          return 'Ese mensaje ya se había enviado con otro contenido. Vuelve a enviarlo.';
        case 'campaign_not_active':
          return 'La campaña no está activa: el chat es de solo lectura.';
        case 'conversation_archived':
          return 'La conversación está archivada.';
        case 'attachment_scope':
          return 'Uno de los adjuntos no está disponible en esta campaña.';
        case 'run_not_retryable':
          return 'Este turno ya no se puede reintentar.';
        case 'message_not_latest':
          return 'Solo se puede reintentar el último mensaje de la conversación.';
        case 'run_not_active':
          return 'El turno ya había terminado.';
        default:
          return 'La conversación cambió mientras se procesaba la operación. Reintenta.';
      }
    default:
      // El resto son errores de dominio con mensaje propio, escrito para la persona
      // (validación, transiciones del brief, propuesta obsoleta…). Nunca trazas.
      return error.message === '' ? GENERICO : error.message;
  }
}

function registrarFallo(accion: string, error: unknown): void {
  // Solo el nombre del error: ni mensaje, ni traza, ni datos de la petición.
  console.error(`[chat-actions] ${accion}`, error instanceof Error ? error.name : typeof error);
}

/** Persona con acceso al chat de ESA campaña, o el fallo ya traducido. */
async function personaConAcceso(
  campaignId: unknown,
): Promise<{ readonly user: User; readonly campaignId: string } | ReturnType<typeof fallo>> {
  const user = await currentUser();
  if (user === undefined) return fallo('Tu sesión expiró. Inicia sesión de nuevo.', 'SESSION');
  if (typeof campaignId !== 'string' || !roleCan(user.role, 'chat:write')) {
    return fallo(
      'No encontramos ese elemento. Recarga la página e inténtalo de nuevo.',
      'RESOURCE_NOT_FOUND',
    );
  }
  const campana = await getCampaign(user, campaignId);
  if (!campana.ok) {
    return fallo(
      'No encontramos ese elemento. Recarga la página e inténtalo de nuevo.',
      'RESOURCE_NOT_FOUND',
    );
  }
  return { user, campaignId: campana.value.campaign.id };
}

const esFallo = (x: unknown): x is ReturnType<typeof fallo> =>
  typeof x === 'object' && x !== null && (x as { ok?: unknown }).ok === false;

const rutaDelChat = (campaignId: string): string => `/campanas/${campaignId}/chat`;

// ─────────────────────────── Enviar, cancelar, reintentar ──────────────────────

/**
 * Envía un mensaje al asistente: admisión (mensaje + run `queued`, idempotente por
 * `clientMessageId`) y disparo del run en segundo plano. La conversación se crea al primer
 * envío. También se dispara el run de un reenvío idempotente que sigue `queued` (el primer
 * `after()` pudo perderse); si ya corre, el segundo disparo termina sin hacer nada.
 */
export async function enviarMensajeDeChat(
  campaignId: string,
  clientMessageId: string,
  contenido: string,
  sourceIds: readonly string[],
): Promise<ResultadoDeChat<{ readonly reproducido: boolean }>> {
  try {
    const acceso = await personaConAcceso(campaignId);
    if (esFallo(acceso)) return acceso;
    const { user } = acceso;
    if (typeof clientMessageId !== 'string' || typeof contenido !== 'string' || !Array.isArray(sourceIds)) {
      return fallo('El mensaje no es válido.', 'VALIDATION_FAILED');
    }

    const estado = estadoDelAsistente();
    if (estado === 'ia_apagada') return fallo(mensajeDe({ code: 'AI_DISABLED', message: '' }), 'AI_DISABLED');
    if (estado === 'sin_configurar') {
      return fallo(
        'El asistente no está configurado en este entorno. Avisa a quien administra la plataforma.',
        'AI_NOT_CONFIGURED',
      );
    }

    const conversacion = await obtenerOCrearConversacion(user, acceso.campaignId);
    if (!conversacion.ok) return fallo(mensajeDe(conversacion.error), conversacion.error.code);

    const admitido = await admitirTurno(user, {
      conversationId: conversacion.value.id,
      content: contenido,
      clientMessageId,
      sourceIds: sourceIds.filter((id): id is string => typeof id === 'string'),
    });
    if (!admitido.ok) return fallo(mensajeDe(admitido.error), admitido.error.code);

    if (admitido.value.run.status === 'queued') dispararRunEnSegundoPlano(user, admitido.value.run.id);
    revalidatePath(rutaDelChat(acceso.campaignId));
    return { ok: true, reproducido: admitido.value.replayed };
  } catch (error) {
    registrarFallo('enviarMensajeDeChat', error);
    return fallo(GENERICO, 'INTERNAL');
  }
}

/** Cancela el run activo. En cola se cancela al instante; en ejecución se pide y el agente corta en su próximo paso. */
export async function cancelarRunDeChat(
  campaignId: string,
  runId: string,
): Promise<ResultadoDeChat<{ readonly cancelado: boolean }>> {
  try {
    const acceso = await personaConAcceso(campaignId);
    if (esFallo(acceso)) return acceso;
    const { user } = acceso;
    if (typeof runId !== 'string')
      return fallo(mensajeDe({ code: 'RESOURCE_NOT_FOUND', message: '' }), 'RESOURCE_NOT_FOUND');

    // El run debe ser de una conversación DE LA PERSONA y de ESA campaña.
    const run = await obtenerRun(user, runId);
    if (!run.ok || run.value.campaignId !== acceso.campaignId) {
      return fallo(mensajeDe({ code: 'RESOURCE_NOT_FOUND', message: '' }), 'RESOURCE_NOT_FOUND');
    }
    const r = await cancelarRun(user, runId);
    if (!r.ok) return fallo(mensajeDe(r.error), r.error.code);
    revalidatePath(rutaDelChat(acceso.campaignId));
    return { ok: true, cancelado: r.value.cancelled };
  } catch (error) {
    registrarFallo('cancelarRunDeChat', error);
    return fallo(GENERICO, 'INTERNAL');
  }
}

/**
 * Reintenta el turno de un mensaje fallido o cancelado (nuevo run, intento + 1). Barre antes
 * los runs abandonados (si el anterior quedó huérfano, se cierra como `RUN_ABANDONED`).
 */
export async function reintentarRunDeChat(
  campaignId: string,
  userMessageId: string,
): Promise<ResultadoDeChat> {
  try {
    const acceso = await personaConAcceso(campaignId);
    if (esFallo(acceso)) return acceso;
    const { user } = acceso;
    if (typeof userMessageId !== 'string') {
      return fallo(mensajeDe({ code: 'RESOURCE_NOT_FOUND', message: '' }), 'RESOURCE_NOT_FOUND');
    }
    if (estadoDelAsistente() !== 'activo') {
      return fallo(mensajeDe({ code: 'AI_DISABLED', message: '' }), 'AI_DISABLED');
    }

    const mensaje = await obtenerMensaje(user, userMessageId);
    if (!mensaje.ok || mensaje.value.campaignId !== acceso.campaignId) {
      return fallo(mensajeDe({ code: 'RESOURCE_NOT_FOUND', message: '' }), 'RESOURCE_NOT_FOUND');
    }

    const barrido = await barrerYReintentar(user, { userMessageId });
    const reintento = barrido.reintento;
    if (reintento === undefined) return fallo(GENERICO, 'INTERNAL');
    if (!reintento.ok) return fallo(mensajeDe(reintento.error), reintento.error.code);

    dispararRunEnSegundoPlano(user, reintento.value.id);
    revalidatePath(rutaDelChat(acceso.campaignId));
    return { ok: true };
  } catch (error) {
    registrarFallo('reintentarRunDeChat', error);
    return fallo(GENERICO, 'INTERNAL');
  }
}

// ─────────────────────────── Acciones propuestas (HITL humano) ─────────────────

/**
 * Confirma y ejecuta una acción propuesta. ES EL CAMINO HUMANO: la persona (releída de la
 * base) pulsó «Confirmar» en la tarjeta que le mostró la huella `huellaMostrada`.
 *
 *  1. La acción debe ser de ESTA campaña y de esta organización, haber nacido en un chat de
 *     la campaña y ser suya (su conversación) o confirmable por su rol (`obtenerAccionDeChat`).
 *  2. La huella que vio la persona debe coincidir con la vigente en la base; si no,
 *     `PROPOSAL_STALE` (no se confirma algo distinto de lo mostrado).
 *  3. `confirmarAccion(..., { canal: 'ui', payloadHash })` y `ejecutarAccion(..., { canal: 'ui' })`.
 *     El canal es siempre `'ui'` y se fija AQUÍ: no es un parámetro. Una acción ya confirmada
 *     por la misma persona (ejecución fallida a medias) se reintenta sin volver a confirmar.
 *
 * El agente, las tools y el worker no importan este módulo (lo comprueba la frontera de
 * importaciones del paquete del agente).
 */
export async function confirmarAccionPropuestaDeChat(
  campaignId: string,
  actionId: string,
  huellaMostrada: string,
): Promise<ResultadoDeChat<{ readonly estado: 'ejecutada' }>> {
  try {
    const acceso = await personaConAcceso(campaignId);
    if (esFallo(acceso)) return acceso;
    const { user } = acceso;
    if (typeof actionId !== 'string' || typeof huellaMostrada !== 'string') {
      return fallo(mensajeDe({ code: 'RESOURCE_NOT_FOUND', message: '' }), 'RESOURCE_NOT_FOUND');
    }

    const vista = await obtenerAccionDeChat(user, acceso.campaignId, actionId);
    if (!vista.ok) return fallo(mensajeDe(vista.error), vista.error.code);
    const accion = vista.value;

    if (huellaMostrada !== accion.payloadHash) {
      return fallo(
        'Lo propuesto cambió desde que lo viste (la huella ya no coincide). Recarga la página y revisa la propuesta vigente.',
        'PROPOSAL_STALE',
      );
    }
    if (accion.obsoleta) {
      return fallo(
        'Lo propuesto ya no corresponde al estado actual (el contenido cambió después de proponerse). Pídele al asistente que lo proponga de nuevo.',
        'PROPOSAL_STALE',
      );
    }

    if (accion.estado === 'pending') {
      const confirmada = await confirmarAccion(user, actionId, { canal: 'ui', payloadHash: huellaMostrada });
      if (!confirmada.ok) {
        revalidatePath(rutaDelChat(acceso.campaignId));
        return fallo(mensajeDe(confirmada.error), confirmada.error.code);
      }
    } else if (!accion.canRetryExecute) {
      // Ni pendiente ni «confirmada por mí»: ya ejecutada, cancelada, vencida o de otra persona.
      const codigo = accion.estado === 'expired' ? 'PROPOSAL_EXPIRED' : 'PROPOSAL_INVALID_STATE';
      return fallo(mensajeDe({ code: codigo, message: '' }), codigo);
    }

    const ejecutada = await ejecutarAccion(user, actionId, { canal: 'ui' });
    revalidatePath(rutaDelChat(acceso.campaignId));
    if (!ejecutada.ok) {
      return fallo(
        `La acción quedó confirmada, pero no se pudo ejecutar: ${mensajeDe(ejecutada.error)} Puedes reintentar la ejecución.`,
        ejecutada.error.code,
      );
    }
    return { ok: true, estado: 'ejecutada' };
  } catch (error) {
    registrarFallo('confirmarAccionPropuestaDeChat', error);
    return fallo(GENERICO, 'INTERNAL');
  }
}

/** Cancela una acción propuesta (quien la propuso o quien puede confirmarla). Contexto `ui` por omisión. */
export async function cancelarAccionPropuestaDeChat(
  campaignId: string,
  actionId: string,
): Promise<ResultadoDeChat> {
  try {
    const acceso = await personaConAcceso(campaignId);
    if (esFallo(acceso)) return acceso;
    const { user } = acceso;
    if (typeof actionId !== 'string') {
      return fallo(mensajeDe({ code: 'RESOURCE_NOT_FOUND', message: '' }), 'RESOURCE_NOT_FOUND');
    }
    const vista = await obtenerAccionDeChat(user, acceso.campaignId, actionId);
    if (!vista.ok) return fallo(mensajeDe(vista.error), vista.error.code);

    const r = await cancelarAccion(user, actionId);
    revalidatePath(rutaDelChat(acceso.campaignId));
    if (!r.ok) return fallo(mensajeDe(r.error), r.error.code);
    return { ok: true };
  } catch (error) {
    registrarFallo('cancelarAccionPropuestaDeChat', error);
    return fallo(GENERICO, 'INTERNAL');
  }
}
