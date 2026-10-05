/**
 * Textos y constantes de presentación del chat. Sin lógica de negocio y sin imports de
 * runtime de los paquetes (también lo usan los componentes cliente).
 */

/**
 * Límites de la interfaz. Reflejan `CHAT_LIMITS` del dominio (el servidor los vuelve a
 * validar siempre); se copian aquí para no arrastrar el dominio al bundle del navegador.
 */
export const MAX_CARACTERES_DEL_MENSAJE = 20_000;
export const MAX_ADJUNTOS_POR_MENSAJE = 10;

/** Formatos que acepta el flujo de fuentes (se valida por contenido real en el servidor). */
export const ACEPTA_ADJUNTOS = '.pdf,.pptx,.docx,.xlsx,.csv,.md,.png,.jpg,.jpeg';

/** Mensajes con los que se explica un run fallido. El código viaja aparte, sanitizado. */
const FALLO_DE_RUN: Readonly<Record<string, string>> = {
  AI_DISABLED: 'La IA está desactivada: el asistente no puede responder ahora.',
  AGENT_MODEL_UNAVAILABLE: 'El modelo no respondió. Puedes reintentar en unos minutos.',
  AGENT_CONTEXT_FAILED: 'No se pudo preparar el contexto de este turno.',
  AGENT_RUN_TIMEOUT: 'El turno tardó demasiado y se detuvo.',
  FORBIDDEN_ROLE: 'Ya no tienes acceso al chat de esta campaña.',
  AGENT_RUNTIME_ERROR: 'Ocurrió un error interno del asistente.',
  RUN_ABANDONED: 'El turno se interrumpió antes de terminar.',
};

export function mensajeDeFalloDeRun(codigo: string | undefined): string {
  if (codigo === undefined) return 'El turno no se pudo completar.';
  return FALLO_DE_RUN[codigo] ?? 'El turno no se pudo completar.';
}

const CODIGO_SEGURO = /^[A-Z][A-Z0-9_]{1,63}$/;

/** El código solo se muestra si tiene la forma de un identificador (nunca texto libre). */
export function codigoVisible(codigo: string | undefined): string | undefined {
  return codigo !== undefined && CODIGO_SEGURO.test(codigo) ? codigo : undefined;
}

export const ESTADO_DE_PROPUESTA: Readonly<Record<string, string>> = {
  pending: 'Pendiente de confirmación',
  confirmed: 'Confirmada, falta ejecutar',
  executed: 'Ejecutada',
  cancelled: 'Cancelada',
  expired: 'Vencida',
};

export const ESTADO_DE_ACTIVIDAD: Readonly<Record<string, string>> = {
  en_curso: 'en curso',
  completada: 'listo',
  fallida: 'no se pudo completar',
  cancelada: 'cancelado',
};

const FORMATO = new Intl.DateTimeFormat('es-CO', {
  day: 'numeric',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
  timeZone: 'America/Bogota',
});

/** Fecha y hora legibles en hora de Colombia (determinista entre servidor y cliente). */
export function fechaHora(iso: string | undefined): string {
  if (iso === undefined) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : FORMATO.format(d);
}

/** Primeros 8 caracteres de la huella (SHA-256) para mostrarla sin ruido. */
export function huellaCorta(huella: string): string {
  return huella.slice(0, 8);
}

/** Clave de idempotencia del envío: UUID si hay `crypto.randomUUID`, y alternativas si no (HTTP, navegadores viejos). */
export function nuevoClientMessageId(): string {
  const c: Crypto | undefined = typeof crypto === 'undefined' ? undefined : crypto;
  if (c !== undefined && typeof c.randomUUID === 'function') return c.randomUUID();
  if (c !== undefined && typeof c.getRandomValues === 'function') {
    const bytes = c.getRandomValues(new Uint8Array(16));
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  }
  return `m${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}${Math.random()
    .toString(36)
    .slice(2, 12)}`;
}
