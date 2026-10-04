/**
 * Almacenamiento del archivo original.
 *
 * El original se conserva íntegro y nunca se modifica (§9.3, paso 1). La
 * aplicación guarda una referencia estable —`fileId`— nunca el nombre del
 * archivo (§10.3, regla 5).
 *
 * Tres proveedores previstos:
 *   local  → sistema de archivos, para desarrollo
 *   drive  → Google Drive con cuenta de servicio (DEC-006), Sprint 3
 *   s3     → derivados y exportaciones
 *
 * Solo `local` está implementado. Los otros dos comparten esta interfaz, así que
 * añadirlos no toca a quien la usa.
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export type StorageProvider = 'local' | 'drive' | 's3';

export interface ArchivoAlmacenado {
  readonly fileId: string;
  readonly provider: StorageProvider;
  readonly hash: string;
  readonly sizeBytes: number;
}

/**
 * Raíz del monorepo, derivada de la ubicación de este módulo.
 *
 * NO se usa `process.cwd()`: la aplicación web, los tests y los scripts corren
 * desde directorios distintos, y una ruta relativa a cwd hace que el mismo
 * archivo termine en sitios diferentes según quién lo guarde. Eso ya ocurrió una
 * vez y el worker no encontraba el original.
 */
const RAIZ_MONOREPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

/** Directorio donde se guardan los originales. Siempre absoluto. */
export function rutaBase(): string {
  const configurada = process.env['STORAGE_LOCAL_PATH'];
  if (configurada === undefined || configurada.trim() === '') {
    return join(RAIZ_MONOREPO, '.storage');
  }
  const limpia = configurada.trim();
  return isAbsolute(limpia) ? limpia : resolve(RAIZ_MONOREPO, limpia);
}

/** SHA-256 del contenido. Detecta duplicados y cambios (E4-3). */
export function calcularHash(contenido: Uint8Array): string {
  return createHash('sha256').update(contenido).digest('hex');
}

/**
 * Extensión del nombre original para el `fileId`, restringida a 1–10
 * alfanuméricos ASCII. El nombre lo controla quien sube el archivo: nada de
 * lo que traiga después del último punto (barras, `..`, caracteres de control)
 * puede formar parte de una ruta.
 */
export function extensionSegura(nombreOriginal: string): string {
  const punto = nombreOriginal.lastIndexOf('.');
  if (punto < 0) return '';
  const candidata = nombreOriginal.slice(punto + 1).toLowerCase();
  return /^[a-z0-9]{1,10}$/.test(candidata) ? `.${candidata}` : '';
}

/**
 * Guarda el original y devuelve su referencia.
 *
 * El `fileId` se deriva del hash: el mismo contenido produce la misma ruta, así
 * que guardar dos veces el mismo archivo no duplica bytes en disco.
 */
export async function guardarOriginal(
  contenido: Uint8Array,
  organizationId: string,
  nombreOriginal: string,
): Promise<ArchivoAlmacenado> {
  const hash = calcularHash(contenido);
  const extension = extensionSegura(nombreOriginal);

  // Se reparte en dos niveles por los primeros caracteres del hash: un solo
  // directorio con decenas de miles de archivos degrada el sistema de archivos.
  const fileId = join(organizationId, hash.slice(0, 2), hash.slice(2, 4), `${hash}${extension}`);
  const destino = join(rutaBase(), fileId);

  await mkdir(dirname(destino), { recursive: true });
  await writeFile(destino, contenido);

  return { fileId, provider: 'local', hash, sizeBytes: contenido.byteLength };
}

/** Ruta absoluta de un archivo almacenado localmente. La usa el worker. */
export function rutaAbsoluta(fileId: string): string {
  return join(rutaBase(), fileId);
}

export async function leerOriginal(fileId: string): Promise<Uint8Array> {
  return new Uint8Array(await readFile(rutaAbsoluta(fileId)));
}
