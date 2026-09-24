import type { BriefStatus } from '@tcl-kol-os/domain';

/** Los doce estados reales de §7.3, en español — usado en overview y brief. */
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
 * Agrupa los 12 estados reales en 4 etapas solo para la representación
 * visual del stepper (referencia: spec "TCL KOL OS — UI Standalone") — nunca
 * una máquina de estados paralela. La única fuente de verdad de qué
 * transición es válida sigue siendo `allowedTransitions` del dominio.
 */
export type EtapaCampana = 'fuentes' | 'brief' | 'revision_cliente' | 'aprobado';

export const ETAPAS: readonly { id: EtapaCampana; nombre: string }[] = [
  { id: 'fuentes', nombre: 'Fuentes' },
  { id: 'brief', nombre: 'Brief' },
  { id: 'revision_cliente', nombre: 'Revisión cliente' },
  { id: 'aprobado', nombre: 'Aprobado' },
];

export function etapaDeStatus(status: BriefStatus | undefined): EtapaCampana {
  if (status === undefined) return 'fuentes';
  if (status === 'approved' || status === 'superseded') return 'aprobado';
  if (status === 'client_review' || status === 'client_changes_requested') return 'revision_cliente';
  return 'brief';
}
