/**
 * Mutación del test estático de import-boundary (D15) SIN tocar el código real: se copia
 * `packages/agent/src` y `packages/db/src` a un directorio temporal (con la misma disposición
 * relativa, porque `manifest.test.ts` localiza db con `../../../db/src`), se aplica una mutación
 * a la COPIA y se ejecuta allí la copia de `manifest.test.ts`. Solo pruebas de QA.
 */
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const AQUI = dirname(fileURLToPath(import.meta.url));
/** packages/agent */
export const RAIZ_AGENT = resolve(AQUI, '..', '..', '..');
const REPO = resolve(RAIZ_AGENT, '..', '..');
export const BASE_TMP = join(RAIZ_AGENT, 'qa-tmp-mutacion');

export interface Copia {
  /** Raíz de la copia: contiene `agent/src` y `db/src`. */
  readonly raiz: string;
  readonly agent: string;
  readonly db: string;
  leer(rutaRelativa: string): string;
  escribir(rutaRelativa: string, contenido: string): void;
  /** Añade texto al final de un archivo de la copia. */
  anadir(rutaRelativa: string, texto: string): void;
  reemplazar(rutaRelativa: string, desde: string | RegExp, hacia: string): void;
}

let contador = 0;

export function crearCopia(): Copia {
  contador += 1;
  const raiz = join(BASE_TMP, `c${process.pid}-${contador}`);
  mkdirSync(raiz, { recursive: true });
  const agent = join(raiz, 'agent', 'src');
  const db = join(raiz, 'db', 'src');
  // Se parte del ÁRBOL COMMITEADO (HEAD), no del directorio de trabajo: otros agentes pueden estar
  // editando db/web en paralelo y el baseline debe ser estable.
  const crudo = join(raiz, '_head');
  mkdirSync(crudo, { recursive: true });
  execFileSync(
    'sh',
    ['-c', `git -C "${REPO}" archive HEAD packages/agent/src packages/db/src | tar -x -C "${crudo}"`],
    { stdio: 'ignore' },
  );
  mkdirSync(join(raiz, 'agent'), { recursive: true });
  mkdirSync(join(raiz, 'db'), { recursive: true });
  cpSync(join(crudo, 'packages', 'agent', 'src'), agent, { recursive: true });
  cpSync(join(crudo, 'packages', 'db', 'src'), db, { recursive: true });
  rmSync(crudo, { recursive: true, force: true });
  const ruta = (carpeta: string, r: string): string => join(carpeta, r);
  const donde = (r: string): string =>
    r.startsWith('db/') ? join(raiz, r.replace(/^db\//, 'db/src/')) : ruta(agent, r);
  return {
    raiz,
    agent,
    db,
    leer: (r) => readFileSync(donde(r), 'utf8'),
    escribir: (r, c) => {
      mkdirSync(dirname(donde(r)), { recursive: true });
      writeFileSync(donde(r), c);
    },
    anadir: (r, t) => writeFileSync(donde(r), `${readFileSync(donde(r), 'utf8')}\n${t}\n`),
    reemplazar: (r, desde, hacia) => {
      const actual = readFileSync(donde(r), 'utf8');
      const nuevo = actual.replace(desde, hacia);
      if (nuevo === actual) throw new Error(`mutación sin efecto en ${r}`);
      writeFileSync(donde(r), nuevo);
    },
  };
}

export interface ResultadoDeManifiesto {
  readonly detectado: boolean;
  readonly salida: string;
}

/** Ejecuta la copia de `manifest.test.ts` y dice si el test estático FALLÓ (= la mutación se detectó). */
export function correrManifiesto(copia: Copia): ResultadoDeManifiesto {
  const prueba = join(copia.agent, 'tools', 'manifest.test.ts');
  try {
    const salida = execFileSync('npx', ['vitest', 'run', prueba, '--reporter=dot'], {
      cwd: RAIZ_AGENT,
      env: { ...process.env, FORCE_COLOR: '0' },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 120_000,
    });
    return { detectado: false, salida };
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string; status?: number | null };
    const salida = `${e.stdout ?? ''}${e.stderr ?? ''}`;
    // un fallo de ejecución (no de aserciones) no cuenta como detección
    if (/Failed Tests|FAIL |AssertionError/.test(salida)) return { detectado: true, salida };
    throw new Error(`el test estático no pudo ejecutarse en la copia:\n${salida.slice(0, 2000)}`);
  }
}

export function limpiarMutaciones(): void {
  rmSync(BASE_TMP, { recursive: true, force: true });
}
