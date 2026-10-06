/**
 * Mensajes en español de los errores de dominio del contenido (V2 · Fase 7).
 *
 * Lo comparten las server actions (`contenido-actions.ts`, que solo puede exportar funciones
 * asíncronas) y el route handler de subida de guiones. Sin lógica de negocio: traduce el código (y,
 * cuando existe, la razón) a un texto para la persona. Nunca devuelve trazas ni detalles internos.
 */

import type { DomainErrorCode } from '@tcl-kol-os/domain';

export const MENSAJE_GENERICO = 'Ocurrió un error inesperado. Inténtalo de nuevo.';

export const MENSAJE_SIN_BRIEF_APROBADO =
  'Todavía no existe un Brief aprobado para usar como documento rector. Aprueba el Brief de la campaña antes de revisar o aprobar guiones.';

export interface ErrorDeContenido {
  readonly code: DomainErrorCode;
  readonly message: string;
  readonly details?: Readonly<Record<string, unknown>> | undefined;
}

const MOTIVO_DE_FUENTE: Readonly<Record<string, string>> = {
  source_queued:
    'El texto del guion está en cola de procesamiento. Espera a que termine e inténtalo de nuevo.',
  source_running: 'El texto del guion se está procesando. Espera a que termine e inténtalo de nuevo.',
  source_failed:
    'Falló el procesamiento del archivo del guion. Puedes revisarlo manualmente o subir otra versión.',
  source_no_text:
    'El archivo del guion no tiene texto legible (puede ser una imagen). Puedes revisarlo manualmente.',
  source_restricted:
    'El asistente no puede leer este archivo (está restringido). Puedes revisarlo manualmente.',
  source_unknown: 'El estado del archivo del guion no permite analizarlo todavía.',
};

/** Traduce un error de dominio a un texto en español para la persona. */
export function mensajeDeContenido(error: ErrorDeContenido): string {
  const razon = error.details?.['reason'];
  switch (error.code) {
    case 'FORBIDDEN_ROLE':
      return 'Tu rol no puede realizar esta acción.';
    case 'RESOURCE_NOT_FOUND':
      return 'No encontramos ese elemento. Recarga la página e inténtalo de nuevo.';
    case 'BRIEF_NOT_APPROVED':
      return MENSAJE_SIN_BRIEF_APROBADO;
    case 'SCRIPT_SOURCE_NOT_READY':
      return (
        (typeof razon === 'string' ? MOTIVO_DE_FUENTE[razon] : undefined) ??
        'El texto del guion todavía no está disponible para el análisis.'
      );
    case 'SCRIPT_CONTEXT_TOO_LARGE':
      return 'El guion es demasiado largo para el análisis asistido (nunca se recorta). Puedes revisarlo manualmente.';
    case 'AI_ANALYSIS_FAILED':
      return 'El análisis asistido no pudo completarse. Puedes revisar el guion manualmente: la IA nunca es requisito.';
    case 'AI_DISABLED':
      return 'La IA está desactivada en este entorno: el análisis asistido no está disponible. Puedes registrar tu revisión humana.';
    case 'SCRIPT_INVALID_TRANSITION':
      if (razon === 'not_in_review') {
        return 'Solo se puede aprobar una versión que está en revisión. Registra tu revisión o solicita el análisis primero.';
      }
      if (razon === 'not_newer') {
        return 'Ya hay una versión más nueva aprobada: no se aprueba hacia atrás.';
      }
      return 'Esa versión ya no admite esa acción: su estado cambió. Recarga la página.';
    case 'SCRIPT_REVIEW_REQUIRED':
      if (razon === 'stale') {
        return 'La revisión es de un Brief anterior. Revisa el guion contra el Brief aprobado vigente (registra tu revisión humana o solicita un análisis nuevo).';
      }
      if (razon === 'brief_missing') return MENSAJE_SIN_BRIEF_APROBADO;
      return 'Aprobar exige una revisión del guion contra el Brief aprobado vigente. Registra tu revisión humana o solicita el análisis.';
    case 'HUMAN_CONFIRMATION_REQUIRED':
      return 'Esta decisión solo la toma una persona desde la interfaz: ni el chat ni el sistema pueden hacerlo.';
    case 'PROPOSAL_STALE':
      return 'Lo que viste cambió antes de aprobar (el guion, su revisión, el Brief o los comentarios). Recarga la página, revisa de nuevo y vuelve a aprobar.';
    case 'PROPOSAL_EXPIRED':
      return 'La propuesta venció. Pídele al asistente que la proponga de nuevo.';
    case 'PROPOSAL_INVALID_STATE':
      return 'La propuesta ya no admite esa acción. Recarga la página.';
    case 'RESOURCE_CONFLICT':
      switch (razon) {
        case 'campaign_not_active':
          return 'La campaña no está activa: el contenido es de solo lectura.';
        case 'campaign_influencer_retired':
          return 'El influencer está retirado de la campaña: reactívalo para trabajar su contenido.';
        case 'deliverable_archived':
          return 'El entregable está archivado: reactívalo para trabajar sus versiones.';
        case 'label_already_exists':
          return 'Esa participación ya tiene un entregable activo con esa etiqueta.';
        case 'not_open':
          return 'La versión ya no admite revisión: su estado cambió. Recarga la página.';
        case 'view_stale':
          return 'El Brief aprobado cambió desde que se mostró la pantalla. Recarga la página y vuelve a intentarlo.';
        case 'source_visible_to_tcl':
          return 'El archivo ya es visible para TCL: no se usa como guion hasta bajarlo a interno.';
        case 'source_changed':
          return 'El original del guion cambió desde que se recibió la versión: no se aprueba.';
        case 'concurrent_update':
          return 'El contenido cambió mientras se procesaba la operación. Recarga la página e inténtalo de nuevo.';
        default:
          return error.message === '' ? MENSAJE_GENERICO : error.message;
      }
    default:
      // El resto son errores de dominio con mensaje propio, escrito para la persona (validación,
      // archivo inválido, duplicados…). Nunca trazas.
      return error.message === '' ? MENSAJE_GENERICO : error.message;
  }
}
