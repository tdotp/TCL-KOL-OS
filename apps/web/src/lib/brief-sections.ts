/**
 * Reexporta las constantes de sección desde `@tcl-kol-os/domain` (Sprint 6,
 * Fase B) — antes vivían solo aquí; se movieron para que `packages/db`
 * también pueda agrupar campos por sección sin duplicar la lista. Este
 * archivo se conserva para no romper los imports existentes en `apps/web`.
 */
export { ORDEN_DE_SECCIONES, TITULO_SECCION } from '@tcl-kol-os/domain';
