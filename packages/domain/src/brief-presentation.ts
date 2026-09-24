/**
 * Etiquetas de presentación del brief — compartidas entre `packages/db` (el
 * nuevo `BriefWorkspace`, Sprint 6) y `apps/web` (las pantallas existentes).
 *
 * Vivían solo en `apps/web/src/lib/brief-sections.ts` y
 * `apps/web/src/lib/brief-ui.ts`. Se mueven aquí sin cambiar su contenido
 * porque `packages/db` no puede importar de `apps/web` (ADR-008: la
 * dependencia del monorepo es unidireccional) y el nuevo `obtenerBriefWorkspace`
 * necesita agrupar campos por sección y describir las transiciones
 * disponibles exactamente como ya lo hace la UI actual — nunca una segunda
 * traducción que se desincronice de la primera.
 */

import type { BriefStatus } from './types';

/**
 * Los diez bloques canónicos de D0-05 §2.1, en el orden en que se navegan.
 */
export const ORDEN_DE_SECCIONES = [
  'contexto',
  'objetivo',
  'target_audiencia',
  'problema_insight',
  'marca_producto',
  'mandatorios',
  'mensaje_principal',
  'accion_kpis',
  'entregable_creativo',
  'practico',
] as const;

export const TITULO_SECCION: Record<string, string> = {
  contexto: 'Contexto',
  objetivo: 'Objetivo',
  target_audiencia: 'Audiencia objetivo',
  problema_insight: 'Problema e insight',
  marca_producto: 'Marca y producto',
  mandatorios: 'Mandatorios',
  mensaje_principal: 'Mensaje principal',
  accion_kpis: 'Acción y KPIs',
  entregable_creativo: 'Entregable creativo',
  practico: 'Datos prácticos',
};

/** Los doce estados reales de §7.3, en español. */
export const ESTADO_EN_ESPANOL: Record<BriefStatus, string> = {
  draft: 'borrador',
  processing: 'extrayendo…',
  extraction_review: 'revisión de extracción',
  local_questions: 'preguntas locales',
  internal_review: 'revisión interna',
  internal_changes_requested: 'cambios internos solicitados',
  client_review: 'revisión del cliente',
  client_changes_requested: 'cambios del cliente solicitados',
  approved: 'aprobado',
  superseded: 'reemplazado',
  cancelled: 'cancelado',
  processing_failed: 'extracción fallida',
};

/** Qué transición ofrecer y con qué texto — la regla vive en el dominio, esto solo la muestra. */
export const TEXTO_DEL_BOTON: Partial<Record<BriefStatus, string>> = {
  local_questions: 'Ir a las preguntas',
  extraction_review: 'Volver al brief',
  internal_review: 'Enviar a revisión interna',
  client_review: 'Aprobar internamente',
  approved: 'Aprobar',
};
