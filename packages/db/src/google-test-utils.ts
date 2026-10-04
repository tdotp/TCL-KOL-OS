/**
 * Google Sheets simulado para las pruebas (V2 · Fase 5).
 *
 * La suite normal NO usa una cuenta real de Google. El worker real corre con
 * `GOOGLE_SHEETS_FIXTURE_DIR` (solo honrada en bases `_test`): en lugar de llamar
 * a `sheets.googleapis.com`, `ProveedorGoogleSheets` lee respuestas de la API
 * desde archivos JSON que esta utilidad escribe. Toda la lógica del proveedor
 * (validación del id, mapeo de errores, conversión de celdas, hash) corre de
 * verdad; solo se omite el salto HTTP.
 *
 * Solo para pruebas; nunca lo importa código de la aplicación.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Una celda de prueba: texto, número, booleano, fecha (serie) o vacía. */
export type CeldaDePrueba = string | number | boolean | { readonly fecha: number } | null;

export interface PestanaDePrueba {
  readonly nombre: string;
  readonly gid: number;
  readonly filas: readonly (readonly CeldaDePrueba[])[];
  readonly oculta?: boolean;
}

function valorDeApi(celda: CeldaDePrueba): Record<string, unknown> {
  if (celda === null) return {};
  if (typeof celda === 'string') return celda === '' ? {} : { effectiveValue: { stringValue: celda } };
  if (typeof celda === 'number') return { effectiveValue: { numberValue: celda } };
  if (typeof celda === 'boolean') return { effectiveValue: { boolValue: celda } };
  return {
    effectiveValue: { numberValue: celda.fecha },
    effectiveFormat: { numberFormat: { type: 'DATE' } },
  };
}

/** Cuerpo de respuesta de la API de Sheets (`spreadsheets.get` con rejilla). */
export function libroDeGoogle(pestanas: readonly PestanaDePrueba[], titulo = 'Libro de prueba') {
  return {
    spreadsheetId: 'x',
    properties: { title: titulo },
    sheets: pestanas.map((p, indice) => ({
      properties: {
        sheetId: p.gid,
        title: p.nombre,
        index: indice,
        sheetType: 'GRID',
        ...(p.oculta === true ? { hidden: true } : {}),
      },
      data: [
        {
          startRow: 0,
          startColumn: 0,
          rowData: p.filas.map((fila) => ({ values: fila.map(valorDeApi) })),
        },
      ],
    })),
  };
}

export class GoogleSimulado {
  private constructor(readonly directorio: string) {}

  static async crear(): Promise<GoogleSimulado> {
    return new GoogleSimulado(await mkdtemp(join(tmpdir(), 'tcl-google-')));
  }

  /** Variables de entorno que el worker necesita para usar este simulador. */
  get entorno(): Record<string, string> {
    return { GOOGLE_SHEETS_FIXTURE_DIR: this.directorio };
  }

  /** El Sheet `id` responde con este libro (lo reemplaza si ya existía). */
  async publicar(id: string, pestanas: readonly PestanaDePrueba[], titulo?: string): Promise<void> {
    await this.escribir(id, { status: 200, body: libroDeGoogle(pestanas, titulo) });
  }

  /** El Sheet `id` responde con un error HTTP. */
  async fallar(
    id: string,
    status: number,
    headers: Record<string, string> = {},
    body: unknown = {},
  ): Promise<void> {
    await this.escribir(id, { status, headers, body });
  }

  /** El Sheet `id` provoca un fallo de red. */
  async fallarRed(id: string, tipo: 'timeout' | 'connection'): Promise<void> {
    await this.escribir(id, { raise: tipo });
  }

  async quitar(id: string): Promise<void> {
    await rm(join(this.directorio, `${id}.json`), { force: true });
  }

  async limpiar(): Promise<void> {
    await rm(this.directorio, { recursive: true, force: true });
  }

  private async escribir(id: string, contenido: unknown): Promise<void> {
    await writeFile(join(this.directorio, `${id}.json`), JSON.stringify(contenido), 'utf-8');
  }
}
