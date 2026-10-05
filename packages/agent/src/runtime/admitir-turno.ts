/**
 * Admisión de un turno del agente: kill-switch → persona vigente → mensaje + run `queued`.
 *
 * Decisión (IA apagada): con `AI_ENABLED` apagado NO se persiste nada (ni mensaje ni
 * run) y se devuelve `AI_DISABLED`. `publicarMensaje` es atómico (mensaje + run) y un
 * run que jamás va a correr solo dejaría un turno `failed` visible que exigiría
 * «reintentar»; la interfaz conserva el texto en el cuadro y muestra el estado de la IA
 * (D10: con IA apagada el chat muestra estado, no rompe). Contrapartida: un reenvío
 * idempotente de un mensaje YA admitido tampoco se atiende con la IA apagada.
 *
 * El actor se RELEE de la base (activo, misma organización, con `chat:write`): la
 * sesión de la interfaz pudo quedar vieja.
 */
import { type DomainErrorCode, type Result, type User, err, roleCan } from '@tcl-kol-os/domain';
import { type EnvReader, envDelProceso } from '../model/env.ts';
import { configuracionDeRun, iaActiva } from './config.ts';
import { FALLOS } from './errores.ts';
import { type MensajePublicado, findUserById, publicarMensaje } from './db-ports.ts';

export interface AdmitirTurnoInput {
  readonly conversationId: string;
  readonly content: string;
  /** Clave de idempotencia del envío (la genera la interfaz; p. ej. un UUID). */
  readonly clientMessageId: string;
  /** Fuentes ya registradas en la campaña de la conversación (adjuntos). */
  readonly sourceIds?: readonly string[] | undefined;
}

export interface DependenciasDeAdmision {
  readonly env?: EnvReader | undefined;
}

const SIN_ACCESO = {
  code: 'FORBIDDEN_ROLE' as DomainErrorCode,
  message: 'No tienes acceso al chat del agente.',
};

/** Persona vigente: existe, activa, de la misma organización que la sesión y con `chat:write`. */
export async function releerActor(actor: User): Promise<User | undefined> {
  const fresco = await findUserById(actor.id);
  if (
    fresco === undefined ||
    fresco.status !== 'activo' ||
    fresco.organizationId !== actor.organizationId ||
    !roleCan(fresco.role, 'chat:write')
  ) {
    return undefined;
  }
  return fresco;
}

/**
 * Admite un turno. Devuelve el mensaje y el run `queued` (o el existente si es un
 * reenvío: `replayed`). El disparo del agente lo hace quien llama, DESPUÉS de este
 * retorno (`iniciarEnSegundoPlano` con `after()` de Next).
 */
export async function admitirTurno(
  actor: User,
  input: AdmitirTurnoInput,
  deps: DependenciasDeAdmision = {},
): Promise<Result<MensajePublicado>> {
  const env = deps.env ?? envDelProceso;

  const vigente = await releerActor(actor);
  if (vigente === undefined) return err(SIN_ACCESO);

  if (!iaActiva(env)) {
    return err({ code: FALLOS.iaApagada.code, message: FALLOS.iaApagada.message });
  }

  return publicarMensaje(vigente, {
    conversationId: input.conversationId,
    clientMessageId: input.clientMessageId,
    content: input.content,
    sourceIds: input.sourceIds,
    runConfig: configuracionDeRun(env),
  });
}
