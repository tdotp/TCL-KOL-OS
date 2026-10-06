/**
 * Qué fuentes son GUIONES (V2 · Fase 7).
 *
 * Una fuente ligada a una `script_version` es contenido RECIBIDO, no insumo del Brief ni
 * material visible para quien no revisa guiones:
 *
 *  · La extracción del Brief y la sugerencia de evidencia NUNCA leen una fuente de guion
 *    (el análisis se haría contra un Brief alimentado por el propio guion: circularidad).
 *  · El Operativo (y TCL, defensivamente) no leen fuentes ligadas a una versión NO aprobada.
 *
 * Un solo sitio para la regla (como `fragment-scope.ts`): todo lector de `source_documents`
 * que sirva «las fuentes de la campaña» aplica estas expresiones. Alias `s` = source_documents.
 */

/** Fuente ligada a CUALQUIER versión de guion: excluida de extracción y evidencia del Brief. */
export const SQL_FUENTE_SIN_GUION =
  '(NOT EXISTS (SELECT 1 FROM script_versions sv WHERE sv.source_document_id = s.id))';

/**
 * Con el parámetro booleano `$n` en true, excluye la fuente ligada a una versión que NO está
 * aprobada (recibida, en revisión, con cambios solicitados o reemplazada). Con false, no filtra.
 */
export function sqlFuenteSinGuionNoAprobado(parametro: string): string {
  return `(${parametro}::boolean = false OR NOT EXISTS (
    SELECT 1 FROM script_versions sv WHERE sv.source_document_id = s.id AND sv.status <> 'approved'))`;
}
