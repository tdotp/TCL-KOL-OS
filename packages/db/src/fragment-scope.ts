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

/**
 * Fragmentos de snapshots del Sheet de influencers ANTERIORES a la lista blanca de columnas (cierre de F8).
 *
 * El worker arma hoy el texto de los fragmentos del Sheet `TCL_KOL_OS_INFLUENCERS` con una lista blanca de columnas
 * y lo declara en la estructura del snapshot (`sheets[].fragmentTextAllowlist`). Los snapshots creados ANTES conservan
 * en `source_fragments.text` una línea «cabecera: valor» por cada columna, incluidos `fee`, `canje`, `condiciones` y
 * cualquier columna desconocida (teléfono, dirección…). Son inmutables: no se reescriben. Para que ese texto no llegue
 * a TCL, al agente, a la búsqueda, al insumo del LLM del Brief ni a ningún rol sin permiso financiero, ningún lector
 * de contenido de fuente lo devuelve: es SEGURO POR DEFECTO (un fragmento es ilegible mientras su pestaña lleve el
 * marcador del esquema de influencers en A1 y la estructura del snapshot no declare la lista blanca de esa pestaña).
 * Para recuperarlo hay que re-sincronizar el Sheet: el snapshot nuevo ya trae la marca. La rejilla del snapshot
 * (`source_snapshot_rows`) no se toca: la validación y el plan de importación no dependen del texto.
 *
 * Una sola expresión para todo lector; `alias` es el alias (o el nombre) de `source_fragments` en la consulta.
 */
export function sqlFragmentoSinTextoHistorico(alias: string): string {
  return `(${alias}.snapshot_id IS NULL OR NOT EXISTS (
  SELECT 1
    FROM source_snapshot_rows hr
    JOIN source_snapshots hs ON hs.id = hr.snapshot_id
   WHERE hr.snapshot_id = ${alias}.snapshot_id
     AND hr.row_number = 1
     AND jsonb_path_exists(hr.cells, '$[*] ? (@.col == 1 && @.text like_regex "TCL_KOL_OS_INFLUENCERS" flag "i")')
     AND NOT jsonb_path_exists(
           hs.structure,
           '$.sheets[*] ? (@.name == $n && exists(@.fragmentTextAllowlist))',
           jsonb_build_object('n', hr.sheet))))`;
}

/** Texto que sustituye a una cita de evidencia cuyo fragmento es ilegible por ser histórico (F10, QA-F10-05). */
export const CITA_HISTORICA_RESTRINGIDA =
  'Cita no disponible: proviene de una versión histórica restringida de la fuente.';

/**
 * `evidence.quote` guarda una COPIA literal del fragmento citado, fuera de `source_fragments`: una cita de un
 * snapshot histórico del Sheet de influencers (anterior a la lista blanca de columnas) conservaría `fee`/`canje`/
 * `condiciones`. Todo lector que devuelva la cita la pasa por esta expresión: `e` = alias de `evidence`, `f` = alias
 * de `source_fragments` unido por `e.fragment_id` (LEFT JOIN). Sin fragmento (evidencia manual) la cita se sirve.
 */
export function sqlCitaDeEvidenciaServible(e: string, f: string): string {
  return `(CASE WHEN ${f}.id IS NULL OR ${sqlFragmentoSinTextoHistorico(f)} THEN ${e}.quote
            ELSE '${CITA_HISTORICA_RESTRINGIDA}' END)`;
}

/** Con alias `f` (source_fragments) y `s` (source_documents) en la consulta. */
export const SQL_FRAGMENTO_VIGENTE = `((f.snapshot_id IS NULL OR f.snapshot_id = s.current_snapshot_id)
  AND ${sqlFragmentoSinTextoHistorico('f')})`;

/** Para consultas sobre `source_fragments` sin alias ni join con la fuente. */
export const SQL_FRAGMENTO_VIGENTE_SIN_ALIAS = `((snapshot_id IS NULL OR snapshot_id = (
  SELECT d.current_snapshot_id FROM source_documents d WHERE d.id = source_fragments.source_id))
  AND ${sqlFragmentoSinTextoHistorico('source_fragments')})`;

/**
 * ¿La fuente (alias `alias` = source_documents) es el Sheet de influencers? Dos señales, cualquiera basta:
 *   · SNAPSHOT: alguno de sus snapshots (vigente o histórico) lleva el marcador `TCL_KOL_OS_INFLUENCERS` en A1 de
 *     alguna pestaña (fuente enlazada de Google Sheets);
 *   · ARCHIVO: el marcador aparece en uno de los primeros fragmentos de la fuente (la celda A1 del xlsx/CSV subido
 *     como archivo, sin snapshots; el parser la emite en el primer fragmento: «A: TCL_KOL_OS_INFLUENCERS_V1»).
 * Ese Sheet trae `fee`, `canje` y `condiciones` por influencer: la proyección de TCL (V2 · Fase 9) no lo muestra como
 * documento ni acepta campos del Brief que lo citen como evidencia, sea cual sea su visibilidad.
 */
export function sqlFuenteEsSheetDeInfluencers(alias: string): string {
  return `(EXISTS (
  SELECT 1
    FROM source_snapshots es
    JOIN source_snapshot_rows er ON er.snapshot_id = es.id
   WHERE es.source_id = ${alias}.id
     AND er.row_number = 1
     AND jsonb_path_exists(er.cells, '$[*] ? (@.col == 1 && @.text like_regex "TCL_KOL_OS_INFLUENCERS" flag "i")'))
  OR EXISTS (
  SELECT 1
    FROM source_fragments ef
   WHERE ef.source_id = ${alias}.id
     AND ef.ordinal <= 3
     AND ef.text ~* 'TCL_KOL_OS_INFLUENCERS'))`;
}

/**
 * ¿La fuente es una HOJA DE CÁLCULO (xlsx/xls/csv/tsv/ods por tipo MIME o extensión, o una fuente enlazada de
 * Google Sheets)? Una hoja puede ser el Sheet de influencers aunque no se reconozca su marcador (subida antes del
 * esquema, columnas desplazadas…): la evidencia de Brief que proviene de una hoja se trata como NO servible a TCL
 * (fail-closed). Solo se usa para evidencia del Brief; los documentos compartidos a propósito no se filtran por esto.
 */
export function sqlFuenteEsHojaDeCalculo(alias: string): string {
  return `(${alias}.external_provider ILIKE '%sheets%'
  OR ${alias}.mime_type ~* '(spreadsheet|ms-excel|csv|tab-separated|opendocument\\.spreadsheet)'
  OR ${alias}.filename ~* '\\.(xlsx|xlsm|xls|csv|tsv|ods)$')`;
}
