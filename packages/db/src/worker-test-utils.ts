/**
 * Ejecución del worker real en las pruebas (V2 · Fase 4).
 *
 * El procesamiento de documentos vive en Python; para probarlo de punta a punta
 * contra la base de pruebas se lanza `worker.py --once` (procesa lo pendiente y
 * termina). No usa Redis (la cola es Postgres, ADR-007) ni ningún proveedor de
 * IA: `AI_ENABLED=false`.
 *
 * Solo para pruebas; nunca lo importa código de la aplicación.
 */

import { spawn } from 'node:child_process';
import { crc32 } from 'node:zlib';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const DIRECTORIO_DEL_WORKER = join(RAIZ, 'services', 'ai-worker');
const PYTHON = join(DIRECTORIO_DEL_WORKER, '.venv', 'bin', 'python');

/** ¿Hay un entorno de Python del worker disponible en esta máquina? */
export function hayWorkerLocal(): boolean {
  return existsSync(PYTHON);
}

export interface SalidaDelWorker {
  readonly codigo: number | null;
  readonly salida: string;
}

/** Procesa todo lo pendiente de la cola de la base de pruebas y termina. */
export async function procesarColaConWorker(
  entorno: Readonly<Record<string, string>> = {},
): Promise<SalidaDelWorker> {
  const url = process.env['DATABASE_URL'];
  if (!url || !/_test(?:\?.*)?$/.test(url)) {
    throw new Error('El worker de pruebas solo corre contra una base cuyo nombre termina en «_test».');
  }
  return new Promise((resolve, reject) => {
    const hijo = spawn(PYTHON, ['worker.py', '--once'], {
      cwd: DIRECTORIO_DEL_WORKER,
      env: {
        ...process.env,
        DATABASE_URL: url,
        REDIS_URL: 'redis://localhost:6379',
        AI_ENABLED: 'false',
        PYTHONPATH: '.',
        // Sin credenciales de Google en el entorno de pruebas, salvo que el caso las pida.
        GOOGLE_SERVICE_ACCOUNT_KEY_PATH: '',
        GOOGLE_SHEETS_FIXTURE_DIR: '',
        ...entorno,
      },
    });
    let salida = '';
    hijo.stdout.on('data', (d: Buffer) => (salida += d.toString()));
    hijo.stderr.on('data', (d: Buffer) => (salida += d.toString()));
    hijo.on('error', reject);
    hijo.on('close', (codigo) => resolve({ codigo, salida }));
  });
}

export interface EntradaZip {
  readonly nombre: string;
  readonly datos: Uint8Array | string;
  /** Tamaño descomprimido DECLARADO en el directorio central (para simular una ZIP bomb). */
  readonly declarado?: number;
}

/**
 * ZIP mínimo (método «stored») con CRC correcto, legible por Python. Sirve para
 * fabricar libros dañados u hostiles que ninguna herramienta legítima produce.
 */
export function crearZipDePrueba(entradas: readonly EntradaZip[]): Uint8Array {
  const enc = new TextEncoder();
  const partes: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let desplazamiento = 0;
  for (const e of entradas) {
    const nombre = enc.encode(e.nombre);
    const datos = typeof e.datos === 'string' ? enc.encode(e.datos) : e.datos;
    const crc = crc32(datos);

    const local = new Uint8Array(30 + nombre.length);
    const l = new DataView(local.buffer);
    l.setUint32(0, 0x04034b50, true);
    l.setUint16(4, 20, true);
    l.setUint32(14, crc, true);
    l.setUint32(18, datos.length, true);
    l.setUint32(22, datos.length, true);
    l.setUint16(26, nombre.length, true);
    local.set(nombre, 30);
    partes.push(local, datos);

    const cd = new Uint8Array(46 + nombre.length);
    const c = new DataView(cd.buffer);
    c.setUint32(0, 0x02014b50, true);
    c.setUint16(4, 20, true);
    c.setUint16(6, 20, true);
    c.setUint32(16, crc, true);
    c.setUint32(20, datos.length, true);
    c.setUint32(24, e.declarado ?? datos.length, true);
    c.setUint16(28, nombre.length, true);
    c.setUint32(42, desplazamiento, true);
    cd.set(nombre, 46);
    central.push(cd);
    desplazamiento += local.length + datos.length;
  }
  const tamanoCentral = central.reduce((n, p) => n + p.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, entradas.length, true);
  ev.setUint16(10, entradas.length, true);
  ev.setUint32(12, tamanoCentral, true);
  ev.setUint32(16, desplazamiento, true);
  const todo = [...partes, ...central, eocd];
  const salida = new Uint8Array(todo.reduce((n, p) => n + p.length, 0));
  let pos = 0;
  for (const p of todo) {
    salida.set(p, pos);
    pos += p.length;
  }
  return salida;
}
