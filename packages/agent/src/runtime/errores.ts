/**
 * Códigos y mensajes con los que el runtime cierra un run. Los códigos son
 * identificadores en MAYÚSCULAS (`esCodigoDeErrorValido`); los mensajes son FIJOS:
 * nunca incluyen contenido del proveedor, de documentos ni de mensajes.
 */
import type { DomainErrorCode } from '@tcl-kol-os/domain';
import { type ModelError } from '../contracts.ts';

/** Códigos aditivos de dominio (errors.ts) que el runtime usa tal cual. */
export const COD_IA_APAGADA: DomainErrorCode = 'AI_DISABLED';
export const COD_MODELO_NO_DISPONIBLE: DomainErrorCode = 'AGENT_MODEL_UNAVAILABLE';
export const COD_CONTEXTO_FALLIDO: DomainErrorCode = 'AGENT_CONTEXT_FAILED';
export const COD_RUN_TIMEOUT: DomainErrorCode = 'AGENT_RUN_TIMEOUT';
export const COD_PERSONA_SIN_ACCESO: DomainErrorCode = 'FORBIDDEN_ROLE';
/** Excepción inesperada del runtime (no es un código de dominio: solo del run). */
export const COD_ERROR_DEL_RUNTIME = 'AGENT_RUNTIME_ERROR';

export interface FalloDeRun {
  readonly code: string;
  readonly message: string;
}

export const FALLOS = {
  iaApagada: {
    code: COD_IA_APAGADA,
    message: 'La IA está desactivada: el agente no puede responder ahora.',
  },
  timeout: {
    code: COD_RUN_TIMEOUT,
    message: 'El turno superó el tiempo máximo y se detuvo.',
  },
  personaSinAcceso: {
    code: COD_PERSONA_SIN_ACCESO,
    message: 'La persona ya no tiene acceso al chat de esta campaña.',
  },
  errorDelRuntime: {
    code: COD_ERROR_DEL_RUNTIME,
    message: 'Error interno del agente. El turno se detuvo.',
  },
  respuestaInvalida: {
    code: COD_MODELO_NO_DISPONIBLE,
    message: 'El modelo devolvió una respuesta inválida (MODEL_BAD_RESPONSE).',
  },
} as const satisfies Record<string, FalloDeRun>;

export function falloDeContexto(codigoDeLectura: string): FalloDeRun {
  return {
    code: COD_CONTEXTO_FALLIDO,
    message: `No se pudo preparar el contexto del turno (${codigoDeLectura.slice(0, 40)}).`,
  };
}

/** Traduce el error del cliente de modelo al cierre del run (sin reflejar nada del proveedor). */
export function falloDeModelo(error: ModelError): FalloDeRun {
  switch (error.code) {
    case 'AI_DISABLED':
      return FALLOS.iaApagada;
    case 'MODEL_CONTEXT_TOO_LARGE':
      return {
        code: COD_CONTEXTO_FALLIDO,
        message: 'La conversación es demasiado larga para el modelo (MODEL_CONTEXT_TOO_LARGE).',
      };
    case 'MODEL_NOT_CONFIGURED':
      return {
        code: COD_MODELO_NO_DISPONIBLE,
        message: 'El modelo no está configurado (MODEL_NOT_CONFIGURED).',
      };
    default:
      return {
        code: COD_MODELO_NO_DISPONIBLE,
        message: `El modelo no está disponible en este momento (${error.code}). Reintente en unos minutos.`,
      };
  }
}
