/**
 * Snapshots de fuentes enlazadas (V2 · Fase 5).
 *
 * Un Google Sheet es mutable: no basta con «su contenido actual». Cada lectura
 * que cambia el contenido produce un SNAPSHOT inmutable, con su hash canónico; la
 * fuente apunta al último completo y válido (`current_snapshot_id`). Una lectura
 * idéntica no crea nada, y una fallida jamás toca el vigente.
 *
 * Este módulo solo define los tipos y las reglas puras. La sincronización
 * (red, credenciales) vive en el worker (`services/ai-worker/app/google_sheets.py`);
 * la persistencia, en `packages/db/src/source-sync.ts`.
 */

import type { ExternalProvider } from './linked-sources';

/** Proveedores que admiten sincronización con snapshots. Hoy, solo Google Sheets. */
export const SYNCABLE_PROVIDERS = ['google_sheets'] as const satisfies readonly ExternalProvider[];
export type SyncableProvider = (typeof SYNCABLE_PROVIDERS)[number];

export function isSyncableProvider(value: unknown): value is SyncableProvider {
  return typeof value === 'string' && (SYNCABLE_PROVIDERS as readonly string[]).includes(value);
}

/**
 * Estado TÉCNICO de una sincronización. No es el estado de negocio de la
 * importación de influencers (ese vive en el plan de importación).
 */
export type SyncRunStatus = 'queued' | 'running' | 'completed' | 'unchanged' | 'failed';

/** Una celda de la rejilla de un snapshot (las columnas son 1-based). */
export interface SnapshotCell {
  readonly col: number;
  readonly text: string;
  /** `texto | numero | fecha | booleano | error`: el tipo del contrato tabular de la Fase 4. */
  readonly type: string;
}

export interface SnapshotRow {
  readonly row: number;
  readonly cells: readonly SnapshotCell[];
}

export interface SnapshotSheet {
  readonly name: string;
  /** Identidad estable de la pestaña en Google (`sheetId`); el nombre puede cambiar. */
  readonly gid?: number | undefined;
  readonly state: 'visible' | 'hidden';
  readonly rows: readonly SnapshotRow[];
}

/** La rejilla completa de un snapshot, en la forma que consumen los validadores. */
export interface SnapshotGrid {
  readonly sheets: readonly SnapshotSheet[];
}

/** Letras de columna (1 → A, 27 → AA): espejo de `col_letras` del worker. */
export function columnLetters(col: number): string {
  if (!Number.isInteger(col) || col < 1) throw new RangeError('La columna debe ser un entero ≥ 1.');
  let letras = '';
  let n = col;
  while (n > 0) {
    const resto = (n - 1) % 26;
    letras = String.fromCharCode(65 + resto) + letras;
    n = Math.floor((n - 1) / 26);
  }
  return letras;
}
