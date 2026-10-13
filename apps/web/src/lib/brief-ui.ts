import type { BriefStatus } from '@tcl-kol-os/domain';

/**
 * `ESTADO_EN_ESPANOL` y `TEXTO_DEL_BOTON` viven en `@tcl-kol-os/domain`
 * desde Sprint 6 (Fase B) — el nuevo `obtenerBriefWorkspace` las necesita
 * para describir `allowedActions` sin duplicar la traducción. Reexportadas
 * aquí para no romper los imports existentes en `apps/web`.
 */
export { ESTADO_EN_ESPANOL, TEXTO_DEL_BOTON } from '@tcl-kol-os/domain';

/**
 * Agrupa los 12 estados reales en 4 etapas solo para la representación
 * visual del stepper (referencia: spec "TCL KOL OS — UI Standalone") — nunca
 * una máquina de estados paralela. La única fuente de verdad de qué
 * transición es válida sigue siendo `allowedTransitions` del dominio.
 */
export type EtapaCampana = 'fuentes' | 'brief' | 'revision_interna' | 'aprobado';

export const ETAPAS: readonly { id: EtapaCampana; nombre: string }[] = [
  { id: 'fuentes', nombre: 'Fuentes' },
  { id: 'brief', nombre: 'Brief' },
  { id: 'revision_interna', nombre: 'Revisión interna' },
  { id: 'aprobado', nombre: 'Aprobado' },
];

export function etapaDeStatus(status: BriefStatus | undefined): EtapaCampana {
  if (status === undefined) return 'fuentes';
  if (status === 'approved' || status === 'superseded') return 'aprobado';
  // El cliente no revisa el brief en V2 (DEC-042): la revisión es interna. Los estados `client_*` solo
  // existen como legado y se muestran en la misma etapa.
  if (
    status === 'internal_review' ||
    status === 'internal_changes_requested' ||
    status === 'client_review' ||
    status === 'client_changes_requested'
  ) {
    return 'revision_interna';
  }
  return 'brief';
}
