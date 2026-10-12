/**
 * Prueba ESTÁTICA (V2 · Fase 9, DEC-050): `app/(app)/tcl/**`, `app/api/tcl/**` y `lib/tcl-*` solo pueden leer datos
 * por la proyección TCL de `@tcl-kol-os/db`. Falla si importan de `@tcl-kol-os/db` algo fuera de la lista permitida,
 * de módulos de PII/finanzas/operación interna/chat/agente, o si contienen formularios o controles de edición.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Funciones de la proyección TCL: lo ÚNICO que se puede traer de `@tcl-kol-os/db`. */
export const FUNCIONES_TCL_PERMITIDAS: readonly string[] = [
  'listarCampanasParaTcl',
  'obtenerDetalleTclDeCampana',
  'obtenerInfluencersParaTcl',
  'obtenerContenidoParaTcl',
  'obtenerBriefParaTcl',
  'obtenerOperacionParaTcl',
  'obtenerKpisParaTcl',
  'obtenerDocumentosParaTcl',
  'obtenerProyeccionTclDeCampana',
  'exportarCampanaParaTcl',
  'ExportDeCampanaTcl',
];

/** Módulos (por especificador) que la zona TCL no puede importar nunca. */
const MODULOS_PROHIBIDOS =
  /pii|financ|billing|payment|pago|acuerdo|logistic|operacion-|chat-|contenido-|\/actions|agent|test-utils|fuentes|campanas\//iu;

/** Nombres importados del dominio que huelen a PII/finanzas. */
const NOMBRES_DE_DOMINIO_PROHIBIDOS =
  /pii|finance|payment|billing|fee\b|invoice|agreement|acuerdo|shipment/iu;

const ESPECIFICADORES_PERMITIDOS: readonly RegExp[] = [
  /^react$/u,
  /^next\/(navigation|cache)$/u,
  /^@tcl-kol-os\/domain$/u,
  /^@tcl-kol-os\/db$/u,
  /^@\/lib\/session$/u,
  /^@\/lib\/tcl-[a-z-]+$/u,
  /^@\/lib\/monograma$/u,
  /^\.{1,2}\//u, // relativos: se validan aparte (no salen de la zona TCL)
];

interface Importacion {
  readonly especificador: string;
  readonly nombres: readonly string[] | null; // null = `import *`, por defecto, dinámico o `export … from`
}

export function importacionesDe(fuente: string): Importacion[] {
  const resultado: Importacion[] = [];
  for (const m of fuente.matchAll(
    /(?:import|export)\s+(?:type\s+)?\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/gu,
  )) {
    const nombres = m[1]!
      .split(',')
      .map((n) =>
        n
          .trim()
          .replace(/^type\s+/u, '')
          .split(/\s+as\s+/u)[0]!
          .trim(),
      )
      .filter((n) => n !== '');
    resultado.push({ especificador: m[2]!, nombres });
  }
  for (const m of fuente.matchAll(
    /(?:import|export)\s+(?:type\s+)?(?!\{)[^'";]*?\s*from\s*['"]([^'"]+)['"]/gu,
  )) {
    resultado.push({ especificador: m[1]!, nombres: null });
  }
  for (const m of fuente.matchAll(/import\s*['"]([^'"]+)['"]/gu))
    resultado.push({ especificador: m[1]!, nombres: null });
  for (const m of fuente.matchAll(/(?:import|require)\s*\(\s*['"]([^'"]+)['"]\s*\)/gu)) {
    resultado.push({ especificador: m[1]!, nombres: null });
  }
  return resultado;
}

/** Violaciones de un archivo (vacío = correcto). `rutaRelativaOk` valida los imports relativos. */
export function violacionesDe(
  fuente: string,
  rutaRelativaOk: (especificador: string) => boolean = () => true,
): string[] {
  const v: string[] = [];
  for (const imp of importacionesDe(fuente)) {
    const e = imp.especificador;
    if (e.startsWith('@tcl-kol-os/db')) {
      if (e !== '@tcl-kol-os/db') v.push(`subruta de db no permitida: ${e}`);
      else if (imp.nombres === null)
        v.push('import de db sin lista de nombres (*, default, dinámico o reexport)');
      else
        for (const n of imp.nombres)
          if (!FUNCIONES_TCL_PERMITIDAS.includes(n)) v.push(`db: «${n}» no está en la lista permitida`);
      continue;
    }
    if (!ESPECIFICADORES_PERMITIDOS.some((r) => r.test(e))) v.push(`módulo no permitido: ${e}`);
    else if (e.startsWith('.')) {
      if (!rutaRelativaOk(e)) v.push(`import relativo fuera de la zona TCL: ${e}`);
    } else if (MODULOS_PROHIBIDOS.test(e)) v.push(`módulo prohibido: ${e}`);
    if (e === '@tcl-kol-os/domain' && imp.nombres !== null) {
      for (const n of imp.nombres)
        if (NOMBRES_DE_DOMINIO_PROHIBIDOS.test(n)) v.push(`dominio: «${n}» prohibido`);
    }
  }
  return v;
}

function archivos(dir: string): string[] {
  const salida: string[] = [];
  for (const nombre of readdirSync(dir)) {
    const ruta = join(dir, nombre);
    if (statSync(ruta).isDirectory()) salida.push(...archivos(ruta));
    else if (/\.(ts|tsx)$/u.test(nombre) && !/\.test\.tsx?$/u.test(nombre)) salida.push(ruta);
  }
  return salida;
}

const ZONAS = [join(SRC, 'app/(app)/tcl'), join(SRC, 'app/api/tcl')];
const LIB_TCL = readdirSync(join(SRC, 'lib'))
  .filter((n) => /^tcl-[a-z-]+\.tsx?$/u.test(n) && !/\.test\./u.test(n))
  .map((n) => join(SRC, 'lib', n));
const TODOS = [...ZONAS.flatMap(archivos), ...LIB_TCL];

describe('aislamiento estático de la zona TCL', () => {
  it('encuentra los archivos que debe vigilar', () => {
    expect(TODOS.length).toBeGreaterThan(15);
    expect(TODOS.some((f) => f.endsWith('export/route.ts'))).toBe(true);
    expect(TODOS.some((f) => f.endsWith('tcl/layout.tsx'))).toBe(true);
  });

  it('cada archivo importa solo lo permitido', () => {
    const fallos: string[] = [];
    for (const f of TODOS) {
      const dentro = (esp: string): boolean => {
        const destino = resolve(dirname(f), esp);
        const enZona = ZONAS.some((z) => destino === z || destino.startsWith(`${z}/`));
        const enLib = /\/src\/lib\/(tcl-[a-z-]+|session|monograma)(\.tsx?)?$/u.test(destino);
        return enZona || enLib;
      };
      for (const v of violacionesDe(readFileSync(f, 'utf8'), dentro))
        fallos.push(`${relative(SRC, f)}: ${v}`);
    }
    expect(fallos).toEqual([]);
  });

  it('no hay formularios, controles de edición, server actions ni «Publicaciones»', () => {
    const fallos: string[] = [];
    for (const f of TODOS) {
      const t = readFileSync(f, 'utf8');
      const rel = relative(SRC, f);
      if (/<form[\s>]|<input[\s>]|<textarea[\s>]|<select[\s>]/u.test(t))
        fallos.push(`${rel}: control de formulario`);
      if (/<button[\s>]/u.test(t) && !rel.endsWith('tcl/error.tsx')) fallos.push(`${rel}: botón`);
      if (/['"]use server['"]/u.test(t)) fallos.push(`${rel}: server action`);
      if (/export\s+(async\s+)?function\s+(POST|PUT|PATCH|DELETE)\b/u.test(t))
        fallos.push(`${rel}: método de escritura`);
      if (/publicaciones/iu.test(t)) fallos.push(`${rel}: «Publicaciones»`);
    }
    expect(fallos).toEqual([]);
  });
});

describe('el verificador detecta lo prohibido (prueba del propio test)', () => {
  it('rechaza imports de db fuera de la lista, de PII/finanzas y de módulos internos', () => {
    const malos = [
      "import { getCampaign } from '@tcl-kol-os/db';",
      "import { listarCampanasParaTcl, getPool } from '@tcl-kol-os/db';",
      "import * as db from '@tcl-kol-os/db';",
      "import db from '@tcl-kol-os/db';",
      "import { x } from '@tcl-kol-os/db/test-utils';",
      "export { guardarPii } from '@tcl-kol-os/db';",
      "const m = await import('@tcl-kol-os/db');",
      "import { cargar } from '@/lib/operacion-server';",
      "import { pagar } from '@/lib/pagos-actions';",
      "import { x } from '@tcl-kol-os/agent';",
      "import { PiiRecord } from '@tcl-kol-os/domain';",
      "import { y } from '../../campanas/[id]/fuentes/TablaFuentes';",
    ];
    for (const m of malos) expect(violacionesDe(m, () => false).length, m).toBeGreaterThan(0);
  });

  it('acepta las funciones TCL, el dominio puro y los módulos propios', () => {
    const bueno = `
      import type { CampanaDetalleTcl } from '@tcl-kol-os/domain';
      import {
        obtenerDetalleTclDeCampana,
        type ExportDeCampanaTcl,
      } from '@tcl-kol-os/db';
      import { cache } from 'react';
      import { notFound } from 'next/navigation';
      import { usuarioDeTcl } from '@/lib/tcl-guard';
      import { currentUser } from '@/lib/session';`;
    expect(violacionesDe(bueno)).toEqual([]);
  });
});
