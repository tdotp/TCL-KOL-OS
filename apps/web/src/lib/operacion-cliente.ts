/**
 * Lo mínimo de la capa web de Operación (V2 · Fase 8) que SÍ puede importarse desde componentes de cliente.
 *
 * Importa del dominio solo por el subpath `@tcl-kol-os/domain/operational-events` (módulo puro): el barril
 * `@tcl-kol-os/domain` arrastra `node:crypto` (análisis de contenido) y rompe el bundle del navegador.
 * `operacion-comun.ts` re-exporta esto para el servidor; los componentes de cliente importan de aquí.
 */

import { NOTE_PII_WARNING } from '@tcl-kol-os/domain/operational-events';

/** Aviso que acompaña a todo campo de texto libre operativo (notas, motivos): no se escribe PII ahí. */
export const AVISO_NOTAS_SIN_PII: string = NOTE_PII_WARNING;

export const MENSAJE_GENERICO = 'Ocurrió un error inesperado. Inténtalo de nuevo.';

/**
 * Lo que devuelve TODA server action de escritura de Operación (serializable, apto para `useActionState`).
 * `message` es siempre un texto en español para la persona. `field` es el campo del formulario con el
 * problema (si se conoce). `code` es estable para la interfaz y nunca lleva ids ni detalles internos.
 */
export interface EstadoDeAccion {
  readonly ok: boolean;
  readonly message: string;
  readonly field?: string;
  readonly code?: string;
  /** `true` si era un reintento idéntico (misma clave y solicitud): no se escribió nada nuevo. */
  readonly repeated?: boolean;
}

/** Estado inicial para `useActionState`: ni éxito ni error (`message === ''` ⇒ aún sin enviar). */
export const ESTADO_INICIAL: EstadoDeAccion = { ok: false, message: '' };
