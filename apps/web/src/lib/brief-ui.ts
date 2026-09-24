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
