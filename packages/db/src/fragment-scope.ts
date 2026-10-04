/**
 * Qué fragmentos están VIGENTES (V2 · Fase 5).
 *
 * Una fuente-archivo tiene sus fragmentos sin snapshot (`snapshot_id IS NULL`).
 * Una fuente enlazada (Google Sheet) acumula snapshots inmutables: sus
 * fragmentos cuelgan de cada uno, y solo los del snapshot VIGENTE
 * (`source_documents.current_snapshot_id`) entran por defecto a la búsqueda, la
 * extracción y las lecturas. Los de snapshots anteriores se conservan intactos
 * —la evidencia que los citó sigue resolviendo a ellos— pero no se mezclan con
 * el contenido actual.
 *
 * Un solo sitio para la regla: todo lector de `source_fragments` que sirva
 * «el contenido de la fuente» la aplica con estas expresiones.
 */

/** Con alias `f` (source_fragments) y `s` (source_documents) en la consulta. */
export const SQL_FRAGMENTO_VIGENTE = '(f.snapshot_id IS NULL OR f.snapshot_id = s.current_snapshot_id)';

/** Para consultas sobre `source_fragments` sin alias ni join con la fuente. */
export const SQL_FRAGMENTO_VIGENTE_SIN_ALIAS = `(snapshot_id IS NULL OR snapshot_id = (
  SELECT d.current_snapshot_id FROM source_documents d WHERE d.id = source_fragments.source_id))`;
