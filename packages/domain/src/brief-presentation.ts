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

/**
 * Traduce una `action` cruda de `audit_events` (`packages/db/src/audit.ts`,
 * `field.correct`, `brief.transition`, etc.) a algo legible — Sprint 6,
 * Checkpoint 2, "no mostrar JSON crudo como experiencia principal" (§3.4).
 * Puramente presentacional: nunca decide qué pasó, solo cómo se dice.
 */
export interface EventoHumano {
  readonly tipo: string;
  readonly detalle?: string | undefined;
}

function comoTexto(valor: unknown): string | undefined {
  return typeof valor === 'string' && valor.trim() !== '' ? valor : undefined;
}

export function humanoDeEvento(action: string, metadata: Readonly<Record<string, unknown>>): EventoHumano {
  switch (action) {
    case 'campaign.create':
      return { tipo: 'Creó la campaña' };
    case 'campaign.archive':
      return { tipo: 'Archivó la campaña' };
    case 'brief.manual_create':
      return { tipo: 'Inició el brief a mano' };
    case 'brief.create_child_version':
      return { tipo: 'Creó una nueva versión a partir de esta' };
    case 'brief.superseded':
      return { tipo: 'Esta versión quedó reemplazada' };
    case 'brief.transition': {
      const to = comoTexto(metadata['to']);
      const etiqueta = to !== undefined ? (ESTADO_EN_ESPANOL[to as BriefStatus] ?? to) : 'otro estado';
      return { tipo: `Cambió el estado a «${etiqueta}»`, detalle: comoTexto(metadata['motivo']) };
    }
    case 'question.generate':
      return { tipo: 'Generó preguntas locales de lo que faltaba' };
    case 'question.answer':
      return { tipo: 'Respondió una pregunta local' };
    case 'question.discard':
      return { tipo: 'Descartó una pregunta local', detalle: comoTexto(metadata['justificacion']) };
    case 'source.upload':
      return { tipo: 'Cargó una fuente' };
    case 'source.retry':
      return { tipo: 'Reintentó procesar una fuente' };
    default:
      // Nunca debería quedar sin traducir en la práctica — si aparece un
      // `action` nuevo que este mapa no conoce, se muestra tal cual (con
      // puntos por espacios) en vez de fallar u ocultar el evento entero.
      return { tipo: action.replaceAll('.', ' · ') };
  }
}

const ACCION_REVISION_CAMPO: Record<string, string> = {
  confirm: 'Confirmó el campo tal como estaba',
  correct: 'Corrigió el valor del campo',
  resolve_conflict: 'Resolvió un conflicto entre fuentes',
  apply_answer: 'Aplicó la respuesta de una pregunta local',
  declare_exception: 'Declaró una excepción para este producto',
  revert_exception: 'Volvió al valor compartido',
};

export function humanoDeRevisionCampo(accion: string): string {
  return ACCION_REVISION_CAMPO[accion] ?? accion;
}

/**
 * A quién le toca actuar y por qué, en una frase — Sprint 6, Checkpoint 2,
 * §3.5: "no limitarse a esconder el botón", y "no hardcodear una segunda
 * matriz de transiciones en la UI". Se arma aquí, una sola vez, a partir de
 * lo que el dominio ya decidió (`allowedTransitions`) y de los contadores
 * reales del workspace — la UI solo la muestra.
 */
export function mensajeResponsabilidad(params: {
  readonly status: BriefStatus;
  readonly criticalPending: number;
  readonly decisionsPending: number;
  readonly siguienteVersionNumero?: number | undefined;
}): string {
  const { status, criticalPending, decisionsPending, siguienteVersionNumero } = params;

  if (status === 'approved') return 'Esta versión está aprobada y es inmutable.';
  if (status === 'cancelled') return 'Esta versión fue cancelada.';
  if (status === 'superseded') {
    return siguienteVersionNumero !== undefined
      ? `Esta versión fue reemplazada por la versión ${siguienteVersionNumero}.`
      : 'Esta versión fue reemplazada por una versión más reciente.';
  }
  if (status === 'client_review') return 'El cliente está revisando esta versión.';
  if (status === 'client_changes_requested') return 'El cliente solicitó cambios.';
  if (status === 'internal_review') return 'Pendiente de aprobación por Dirección.';
  if (status === 'internal_changes_requested') {
    return 'Se solicitaron cambios internos — quedan por resolver antes de reenviar.';
  }
  if (criticalPending > 0) {
    const decisionPlural = criticalPending > 1 ? 'decisiones' : 'decisión';
    const s = criticalPending > 1 ? 's' : '';
    return `Tienes ${criticalPending} ${decisionPlural} crítica${s} pendiente${s}.`;
  }
  if (decisionsPending > 0) {
    return `Quedan ${decisionsPending} pregunta(s) por resolver antes de enviar a revisión interna.`;
  }
  return 'Sin pendientes — puede enviarse a revisión interna.';
}
