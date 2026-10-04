/**
 * Lectura del localizador en SQL y en filas (V2 · Fase 4).
 *
 * El contrato es `SourceLocator` (packages/domain). Un fragmento SIEMPRE tiene
 * `locator`. La evidencia histórica puede no tenerlo (no se reescribe; la de
 * versiones aprobadas está congelada): se deriva de sus columnas legacy.
 */

import { type SourceLocator, localizadorDesdeLegacy, validarLocalizador } from '@tcl-kol-os/domain';

/** Localizador efectivo de una fila `evidence` aliasada como `e`. */
export const SQL_LOCALIZADOR_DE_EVIDENCIA =
  'COALESCE(e.locator, source_locator_desde_legacy(e.page, e.slide, e.section, e.linea))';

interface ColumnasConLocalizador {
  readonly locator?: unknown;
  readonly page?: number | null | undefined;
  readonly slide?: number | null | undefined;
  readonly section?: string | null | undefined;
  readonly linea?: number | null | undefined;
}

/**
 * Localizador de una fila leída de la base: el que trae, validado, o el derivado
 * de las columnas legacy. `undefined` si no hay ninguna ubicación (evidencia
 * manual histórica sin fragmento).
 */
export function localizadorDeFila(fila: ColumnasConLocalizador): SourceLocator | undefined {
  if (fila.locator !== undefined && fila.locator !== null) {
    const valido = validarLocalizador(fila.locator);
    if (valido.ok) return valido.value;
  }
  return localizadorDesdeLegacy(fila);
}
