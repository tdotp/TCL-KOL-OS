/**
 * Import-boundary (D15), comprobado sobre el CÓDIGO (AST de TypeScript).
 *
 *  (a) cada export de valor de `@tcl-kol-os/db` está clasificado (uno nuevo rompe el test);
 *  (b) solo los archivos-puerta importan de db (use-cases.ts; y runtime/db-ports.ts del runtime), con el
 *      especificador REAL resuelto (rutas relativas, enlaces simbólicos de node_modules, subrutas), sin
 *      `export *` ni `import *` en las puertas, sin `import()`/`require()` no literales, sin `createRequire`
 *      y sin cadenas que nombren db fuera de un import;
 *  (c) nada en `tools/` NI en `runtime/` nombra un identificador PROHIBIDO; las puertas importan solo lo
 *      importable y quien importa de una puerta tampoco puede pedir una función prohibida;
 *  (d) ninguna tool registrada es prohibida ni usa SQL; transicionarBrief solo con destino `internal_review`.
 */
import { readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { CATALOGO_V1 } from './catalog/index.ts';
import {
  CLASIFICACIONES,
  MANIFIESTO_DE_DB,
  clasificacionDe,
  esImportablePorElAgente,
  identificadoresProhibidos,
} from './manifest.ts';
import { createToolRegistry } from './registry.ts';
import type { AnyToolDefinition } from './types.ts';

const AQUI = dirname(fileURLToPath(import.meta.url));
const SRC_AGENT = resolve(AQUI, '..');
const SRC_DB = resolve(AQUI, '../../../db/src');

const fuente = (ruta: string) =>
  ts.createSourceFile(ruta, readFileSync(ruta, 'utf8'), ts.ScriptTarget.ES2022, true);

function archivosTs(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) return n === 'node_modules' ? [] : archivosTs(p);
    return p.endsWith('.ts') ? [p] : [];
  });
}

const esDePrueba = (p: string) =>
  p.endsWith('.test.ts') || p.endsWith('test-support.ts') || p.includes('/testing/');

// ─────────────────────────── exports de db ─────────────────────────────────────

function exportsDeValor(archivo: string, vistos = new Set<string>()): Set<string> {
  const salida = new Set<string>();
  if (vistos.has(archivo)) return salida;
  vistos.add(archivo);
  const sf = fuente(archivo);
  const exportado = (n: ts.Node) =>
    ts.canHaveModifiers(n) &&
    ts.getModifiers(n)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) === true;
  for (const s of sf.statements) {
    if (
      (ts.isFunctionDeclaration(s) || ts.isClassDeclaration(s) || ts.isEnumDeclaration(s)) &&
      exportado(s) &&
      s.name
    ) {
      salida.add(s.name.text);
    } else if (ts.isVariableStatement(s) && exportado(s)) {
      for (const d of s.declarationList.declarations) if (ts.isIdentifier(d.name)) salida.add(d.name.text);
    } else if (ts.isExportDeclaration(s)) {
      if (s.isTypeOnly) continue;
      if (s.exportClause !== undefined && ts.isNamedExports(s.exportClause)) {
        for (const e of s.exportClause.elements) if (!e.isTypeOnly) salida.add(e.name.text);
      } else if (s.moduleSpecifier !== undefined && ts.isStringLiteral(s.moduleSpecifier)) {
        // `export * from './x.ts'`
        for (const n of exportsDeValor(resolve(dirname(archivo), s.moduleSpecifier.text), vistos))
          salida.add(n);
      }
    }
  }
  return salida;
}

const exportsDeDb = exportsDeValor(join(SRC_DB, 'index.ts'));

describe('(a) manifiesto de exports de @tcl-kol-os/db', () => {
  it('lee los exports reales de db (comprobación de cordura)', () => {
    expect(exportsDeDb.size).toBeGreaterThan(100);
    for (const n of ['getCampaign', 'proponerAccion', 'aprobarBrief', 'recordAudit', 'reclamarInvocacion']) {
      expect(exportsDeDb.has(n)).toBe(true);
    }
  });

  it('TODO export de db está clasificado (un caso de uso nuevo rompe este test hasta clasificarlo)', () => {
    const sinClasificar = [...exportsDeDb].filter((n) => !Object.hasOwn(MANIFIESTO_DE_DB, n)).sort();
    expect(sinClasificar).toEqual([]);
  });

  it('no hay clasificaciones obsoletas (de funciones que db ya no exporta)', () => {
    const obsoletas = Object.keys(MANIFIESTO_DE_DB).filter((n) => !exportsDeDb.has(n));
    expect(obsoletas).toEqual([]);
  });

  it('un export no clasificado se trata como PROHIBIDO', () => {
    expect(clasificacionDe('algoNuevoDeDb')).toBe('prohibited');
    expect(esImportablePorElAgente('algoNuevoDeDb')).toBe(false);
  });

  it('lo decisorio está prohibido y proponer es el único camino', () => {
    const prohibidas = [
      'aprobarBrief',
      'confirmarAccion',
      'ejecutarAccion',
      'solicitarCambiosInternos',
      'crearVersionHija',
      'setSourceVisibility',
      'archiveCampaign',
      'createCampaign',
      'recordAudit',
      'getPool',
      'query',
      'transaction',
      'applyInfluencerImport',
      'resolveImportRecord',
      'retirarInfluencerDeCampana',
      'reactivarInfluencerEnCampana',
      'desasociarProducto',
      'actualizarInfluencer',
      'actualizarCuenta',
      'transicionarBriefEnTransaccion',
      // F7: la revisión humana la registra una persona por ui; archivar/reactivar es de la persona; los
      // internos reciben un cliente de BD o son el mutex.
      'registrarRevisionHumana',
      'archivarEntregable',
      'reactivarEntregable',
      'iniciarRevisionDeVersionEnTransaccion',
      'bloquearEntregable',
      'aprobarScriptVersion',
      'aprobarScriptVersionEnTransaccion',
    ];
    for (const n of prohibidas) expect(clasificacionDe(n), n).toBe('prohibited');
    expect(clasificacionDe('proponerAccion')).toBe('proposal-tool');
    for (const n of [
      'completarRun',
      'fallarRun',
      'iniciarRun',
      'latidoRun',
      'confirmarCancelacionDeRun',
      'abandonarRunsCaducados',
      'registrarLlamadaDeModelo',
      'reclamarInvocacion',
      'cerrarInvocacion',
    ]) {
      expect(clasificacionDe(n), n).toBe('runtime-only');
    }
    for (const n of [
      'publicarMensaje',
      'crearConversacion',
      'cancelarRun',
      'reintentarRun',
      'archivarConversacion',
    ]) {
      expect(clasificacionDe(n), n).toBe('ui-only');
    }
    expect(CLASIFICACIONES).toHaveLength(6);
  });
});

// ─────────────────────────── (b) puertas hacia db ──────────────────────────────

/** Una referencia a un módulo en el código: import/export-from, `import()`, `require()` o `import x = require()`. */
interface UsoDeModulo {
  readonly tipo: 'import' | 'export' | 'import()' | 'require' | 'import-require';
  /** Especificador literal; `undefined` si no es un literal de cadena (no se puede saber a qué apunta). */
  readonly especificador: string | undefined;
  readonly nodo: ts.Node;
}

function usosDeModulos(sf: ts.SourceFile): UsoDeModulo[] {
  const salida: UsoDeModulo[] = [];
  const visita = (n: ts.Node): void => {
    if (ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier)) {
      salida.push({ tipo: 'import', especificador: n.moduleSpecifier.text, nodo: n });
    } else if (ts.isExportDeclaration(n) && n.moduleSpecifier !== undefined) {
      salida.push({
        tipo: 'export',
        especificador: ts.isStringLiteral(n.moduleSpecifier) ? n.moduleSpecifier.text : undefined,
        nodo: n,
      });
    } else if (
      ts.isImportEqualsDeclaration(n) &&
      ts.isExternalModuleReference(n.moduleReference) &&
      n.moduleReference.expression !== undefined
    ) {
      const e = n.moduleReference.expression;
      salida.push({
        tipo: 'import-require',
        especificador: ts.isStringLiteralLike(e) ? e.text : undefined,
        nodo: n,
      });
    } else if (
      ts.isCallExpression(n) &&
      (n.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(n.expression) && n.expression.text === 'require'))
    ) {
      const a = n.arguments[0];
      salida.push({
        tipo: n.expression.kind === ts.SyntaxKind.ImportKeyword ? 'import()' : 'require',
        especificador: a !== undefined && ts.isStringLiteralLike(a) ? a.text : undefined,
        nodo: n,
      });
    }
    ts.forEachChild(n, visita);
  };
  visita(sf);
  return salida;
}

/** Módulos especificados (solo literales) en imports, exports-from, import() y require() de un archivo. */
const especificadores = (sf: ts.SourceFile): string[] =>
  usosDeModulos(sf).flatMap((u) => (u.especificador === undefined ? [] : [u.especificador]));

const OPCIONES_DE_RESOLUCION: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  allowImportingTsExtensions: true,
};

const realpath = (ruta: string): string | undefined => {
  try {
    return realpathSync(ruta);
  } catch {
    return undefined;
  }
};

const SRC_DB_REAL = realpath(SRC_DB) ?? SRC_DB;
/** El paquete db en cualquier forma de escribirlo: nombre, ruta del enlace de node_modules o ruta del repo. */
const NOMBRE_DE_DB = /(^|[\\/])@tcl-kol-os[\\/]db([\\/]|$)|(^|[\\/])packages[\\/]db([\\/]|$)/;

/**
 * ¿El especificador, visto desde `archivo`, apunta al paquete db? Se resuelve de verdad: nombre del
 * paquete (con o sin subruta), ruta relativa o absoluta, ruta por el enlace simbólico de
 * `node_modules/@tcl-kol-os/db` y el destino real que da la resolución de módulos de TypeScript.
 */
const apuntaADb = (archivo: string, esp: string): boolean => {
  if (NOMBRE_DE_DB.test(esp)) return true;
  const destino = esp.startsWith('.') || isAbsolute(esp) ? resolve(dirname(archivo), esp) : undefined;
  if (destino !== undefined) {
    if (destino === SRC_DB || destino.startsWith(`${SRC_DB}/`) || NOMBRE_DE_DB.test(destino)) return true;
  }
  const real = ts.resolveModuleName(esp, archivo, OPCIONES_DE_RESOLUCION, ts.sys).resolvedModule
    ?.resolvedFileName;
  if (real === undefined) return false;
  const fisico = realpath(real) ?? real;
  return fisico === SRC_DB_REAL || fisico.startsWith(`${SRC_DB_REAL}/`) || NOMBRE_DE_DB.test(fisico);
};

/** Puertas autorizadas: la de las tools y la del runtime (W2-B). Cualquier otro archivo falla. */
const PUERTAS = ['tools/use-cases.ts', 'runtime/db-ports.ts'];
const esPuerta = (archivo: string): boolean => PUERTAS.includes(relative(SRC_AGENT, archivo));

/** Infracciones de las puertas: `export *`, `import *`/por defecto de db y accesos no nombrados. */
function infraccionesDePuerta(sf: ts.SourceFile): string[] {
  const malas: string[] = [];
  for (const s of sf.statements) {
    if (ts.isExportDeclaration(s) && s.moduleSpecifier !== undefined) {
      if (s.exportClause === undefined) malas.push('export * from');
      else if (ts.isNamespaceExport(s.exportClause)) malas.push('export * as … from');
    }
    if (ts.isImportDeclaration(s) && ts.isStringLiteral(s.moduleSpecifier) && s.importClause !== undefined) {
      const c = s.importClause;
      if (c.name !== undefined && !c.isTypeOnly)
        malas.push(`import por defecto de ${s.moduleSpecifier.text}`);
      if (c.namedBindings !== undefined && ts.isNamespaceImport(c.namedBindings) && !c.isTypeOnly) {
        malas.push(`import * de ${s.moduleSpecifier.text}`);
      }
    }
  }
  return malas;
}

/** Cadenas que nombran db fuera de un import/export-from (p. ej. `req('@tcl-kol-os/db')`). */
function cadenasQueNombranDb(sf: ts.SourceFile): string[] {
  const malas: string[] = [];
  const visita = (n: ts.Node): void => {
    if (
      (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) &&
      NOMBRE_DE_DB.test(n.text) &&
      !(
        (ts.isImportDeclaration(n.parent) || ts.isExportDeclaration(n.parent)) &&
        n.parent.moduleSpecifier === n
      )
    ) {
      malas.push(n.text);
    }
    ts.forEachChild(n, visita);
  };
  visita(sf);
  return malas;
}

/** `createRequire` (con o sin alias, importado o como propiedad) y `node:module`: no hay uso legítimo en el agente. */
function usosDeRequireIndirecto(sf: ts.SourceFile): string[] {
  const malas: string[] = [];
  const visita = (n: ts.Node): void => {
    if (ts.isIdentifier(n) && n.text === 'createRequire') malas.push('createRequire');
    ts.forEachChild(n, visita);
  };
  visita(sf);
  for (const u of usosDeModulos(sf)) {
    if (u.especificador === 'module' || u.especificador === 'node:module') malas.push(u.especificador);
  }
  return malas;
}

describe('(b) solo las puertas importan de db', () => {
  const todos = archivosTs(SRC_AGENT).filter((p) => !esDePrueba(p));

  it('ningún archivo de packages/agent/src (salvo las puertas) importa de @tcl-kol-os/db ni de rutas hacia db', () => {
    const infractores = todos
      .filter((p) => !esPuerta(p))
      .filter((p) => especificadores(fuente(p)).some((e) => apuntaADb(p, e)))
      .map((p) => relative(SRC_AGENT, p));
    expect(infractores).toEqual([]);
  });

  it('tools/use-cases.ts es la puerta de las tools y existe', () => {
    const p = join(AQUI, 'use-cases.ts');
    expect(especificadores(fuente(p)).some((e) => e === '@tcl-kol-os/db')).toBe(true);
  });

  it('ambas puertas existen y son las únicas que importan de db (exactamente esas dos)', () => {
    const conDb = todos.filter((p) => especificadores(fuente(p)).some((e) => apuntaADb(p, e)));
    expect(conDb.map((p) => relative(SRC_AGENT, p)).sort()).toEqual([...PUERTAS].sort());
  });

  it('las puertas no usan `export *`, `import *` ni import por defecto: solo nombres explícitos', () => {
    for (const puerta of PUERTAS) {
      expect(infraccionesDePuerta(fuente(join(SRC_AGENT, puerta))), puerta).toEqual([]);
    }
  });

  it('ningún `import()` / `require()` del código tiene un especificador no literal (no se puede saber a qué apunta)', () => {
    const infractores: string[] = [];
    for (const p of todos) {
      for (const u of usosDeModulos(fuente(p))) {
        if (u.especificador === undefined && u.tipo !== 'import' && u.tipo !== 'export') {
          infractores.push(`${relative(SRC_AGENT, p)}: ${u.tipo} no literal`);
        }
      }
    }
    expect(infractores).toEqual([]);
  });

  it('ningún archivo usa createRequire/node:module ni nombra db en una cadena fuera de un import', () => {
    const infractores: string[] = [];
    for (const p of todos) {
      const sf = fuente(p);
      for (const m of usosDeRequireIndirecto(sf)) infractores.push(`${relative(SRC_AGENT, p)}: ${m}`);
      for (const c of cadenasQueNombranDb(sf)) infractores.push(`${relative(SRC_AGENT, p)}: «${c}»`);
    }
    expect(infractores).toEqual([]);
  });

  it('el código de producción no importa archivos de prueba (testing/, test-support, *.test) que sí pueden usar db', () => {
    const infractores: string[] = [];
    for (const p of todos) {
      for (const e of especificadores(fuente(p))) {
        if (/(^|\/)testing(\/|$)|test-support|\.test(\.ts)?$|\/test-utils/.test(e)) {
          infractores.push(`${relative(SRC_AGENT, p)}: ${e}`);
        }
      }
    }
    expect(infractores).toEqual([]);
  });

  describe('controles del propio detector (cada mutación conocida SE DETECTA)', () => {
    const sf = (codigo: string) => ts.createSourceFile('x.ts', codigo, ts.ScriptTarget.ES2022, true);
    const desde = (carpeta: string, codigo: string) => {
      const archivo = join(SRC_AGENT, carpeta, 'x.ts');
      return usosDeModulos(sf(codigo)).filter(
        (u) => u.especificador !== undefined && apuntaADb(archivo, u.especificador),
      );
    };

    it('import relativo, dinámico y require hacia db', () => {
      expect(
        desde(
          'runtime',
          `import a from '../../../db/src/index.ts'; const b = await import('@tcl-kol-os/db'); const c = require('@tcl-kol-os/db/test-utils');`,
        ),
      ).toHaveLength(3);
    });

    it('QA-13: ruta por el enlace simbólico del workspace (node_modules/@tcl-kol-os/db), relativa o absoluta', () => {
      const subir = '../'.repeat(8);
      expect(
        desde('tools/catalog', `import { x } from '${subir}node_modules/@tcl-kol-os/db/src/index.ts';`),
      ).toHaveLength(1);
      expect(
        desde(
          'tools',
          `import { x } from '${join(SRC_AGENT, '../../../node_modules/@tcl-kol-os/db/src/index.ts')}';`,
        ),
      ).toHaveLength(1);
      expect(desde('tools', `export { x } from '../../../db/src/campaigns.ts';`)).toHaveLength(1);
    });

    it('un import legítimo (relativo dentro del agente, bibliotecas) NO se marca', () => {
      expect(
        desde(
          'tools',
          `import { a } from './use-cases.ts'; import { b } from '@tcl-kol-os/domain'; import z from 'node:crypto';`,
        ),
      ).toHaveLength(0);
    });

    it('QA-14: `export *` (y `export * as`) en una puerta; import * / por defecto de db', () => {
      expect(infraccionesDePuerta(sf(`export * from '@tcl-kol-os/db';`))).toEqual(['export * from']);
      expect(infraccionesDePuerta(sf(`export * as todo from '@tcl-kol-os/db';`))).toEqual([
        'export * as … from',
      ]);
      expect(infraccionesDePuerta(sf(`import * as db from '@tcl-kol-os/db';`))).toEqual([
        'import * de @tcl-kol-os/db',
      ]);
      expect(infraccionesDePuerta(sf(`import db from '@tcl-kol-os/db';`))).toEqual([
        'import por defecto de @tcl-kol-os/db',
      ]);
      expect(infraccionesDePuerta(sf(`import { a } from '@tcl-kol-os/db'; export { a };`))).toEqual([]);
    });

    it('QA-15: import() y require() no literales; createRequire con alias; cadena que nombra db', () => {
      const noLiterales = (c: string) =>
        usosDeModulos(sf(c)).filter((u) => u.especificador === undefined && u.tipo !== 'import');
      expect(noLiterales(`export const f = () => import(['@tcl-kol-os', 'db'].join('/'));`)).toHaveLength(1);
      expect(noLiterales(`const m = '@tcl-kol-os/' + 'db'; require(m);`)).toHaveLength(1);
      expect(noLiterales(`import(\`@tcl-kol-os/\${'db'}\`)`)).toHaveLength(1);
      expect(
        usosDeRequireIndirecto(
          sf(
            `import { createRequire as cr } from 'node:module'; const req = cr(import.meta.url); req('@tcl-kol-os/db');`,
          ),
        ).length,
      ).toBeGreaterThan(0);
      expect(
        usosDeRequireIndirecto(sf(`import * as m from 'node:module'; m.createRequire('/x');`)).length,
      ).toBeGreaterThan(0);
      expect(cadenasQueNombranDb(sf(`const req = r(); req('@tcl-kol-os/db');`))).toEqual(['@tcl-kol-os/db']);
      expect(cadenasQueNombranDb(sf(`import { a } from '@tcl-kol-os/db';`))).toEqual([]);
    });
  });
});

// ─────────────────────────── (c) identificadores prohibidos ────────────────────

function identificadores(sf: ts.SourceFile): Set<string> {
  const salida = new Set<string>();
  const visita = (n: ts.Node): void => {
    if (ts.isIdentifier(n)) salida.add(n.text);
    ts.forEachChild(n, visita);
  };
  visita(sf);
  return salida;
}

function importadosDeDb(sf: ts.SourceFile): string[] {
  const salida: string[] = [];
  for (const s of sf.statements) {
    if (
      (ts.isImportDeclaration(s) || ts.isExportDeclaration(s)) &&
      s.moduleSpecifier &&
      ts.isStringLiteral(s.moduleSpecifier)
    ) {
      if (s.moduleSpecifier.text !== '@tcl-kol-os/db') continue;
      const clausula = ts.isImportDeclaration(s) ? s.importClause : s.exportClause;
      const typeOnly = ts.isImportDeclaration(s) ? s.importClause?.isTypeOnly === true : s.isTypeOnly;
      if (typeOnly || clausula === undefined) continue;
      const named = ts.isImportDeclaration(s)
        ? (s.importClause?.namedBindings as ts.NamedImportBindings | undefined)
        : clausula;
      if (named !== undefined && (ts.isNamedImports(named) || ts.isNamedExports(named))) {
        for (const e of named.elements) if (!e.isTypeOnly) salida.push((e.propertyName ?? e.name).text);
      }
    }
  }
  return salida;
}

/** Nombres que quien importa de una puerta pide: imports nombrados y accesos `ns.nombre` / `ns['nombre']` a un `import *`. */
function nombresPedidosALaPuerta(archivo: string, sf: ts.SourceFile, puerta: string): string[] {
  const real = realpath(puerta) ?? puerta;
  const pedidos: string[] = [];
  const alias = new Set<string>();
  for (const s of sf.statements) {
    if (!ts.isImportDeclaration(s) || !ts.isStringLiteral(s.moduleSpecifier)) continue;
    const destino = ts.resolveModuleName(s.moduleSpecifier.text, archivo, OPCIONES_DE_RESOLUCION, ts.sys)
      .resolvedModule?.resolvedFileName;
    if (destino === undefined || (realpath(destino) ?? destino) !== real) continue;
    const b = s.importClause?.namedBindings;
    if (b === undefined) continue;
    if (ts.isNamespaceImport(b)) alias.add(b.name.text);
    else for (const e of b.elements) pedidos.push((e.propertyName ?? e.name).text);
  }
  if (alias.size > 0) {
    const visita = (n: ts.Node): void => {
      if (ts.isPropertyAccessExpression(n) && ts.isIdentifier(n.expression) && alias.has(n.expression.text)) {
        pedidos.push(n.name.text);
      } else if (
        ts.isElementAccessExpression(n) &&
        ts.isIdentifier(n.expression) &&
        alias.has(n.expression.text)
      ) {
        pedidos.push(
          ts.isStringLiteralLike(n.argumentExpression) ? n.argumentExpression.text : '[acceso calculado]',
        );
      }
      ts.forEachChild(n, visita);
    };
    visita(sf);
  }
  return pedidos;
}

/** Excepciones EXPLÍCITAS y mínimas: archivos del runtime que legítimamente nombran un identificador prohibido. */
const EXCEPCIONES_DE_RUNTIME: Readonly<Record<string, readonly string[]>> = {};

describe('(c) nada en tools/ ni runtime/ nombra una función PROHIBIDA', () => {
  const prohibidos = new Set(identificadoresProhibidos());
  const deTools = archivosTs(AQUI).filter((p) => !esDePrueba(p) && !p.endsWith('manifest.ts'));
  const deRuntime = archivosTs(join(SRC_AGENT, 'runtime')).filter((p) => !esDePrueba(p));

  it('hay archivos que revisar y hay identificadores prohibidos que buscar', () => {
    expect(deTools.length).toBeGreaterThan(8);
    expect(deRuntime.length).toBeGreaterThan(6);
    expect(prohibidos.size).toBeGreaterThan(30);
  });

  it('ningún archivo de tools/ (código, sin comentarios ni textos) referencia un identificador prohibido', () => {
    const infractores: string[] = [];
    for (const p of deTools) {
      const ids = identificadores(fuente(p));
      for (const n of prohibidos) if (ids.has(n)) infractores.push(`${relative(SRC_AGENT, p)}: ${n}`);
    }
    expect(infractores).toEqual([]);
  });

  it('ningún archivo de runtime/ referencia un identificador prohibido (salvo excepciones explícitas)', () => {
    const infractores: string[] = [];
    for (const p of deRuntime) {
      const ids = identificadores(fuente(p));
      const permitidos = new Set(EXCEPCIONES_DE_RUNTIME[relative(SRC_AGENT, p)] ?? []);
      for (const n of prohibidos) {
        if (ids.has(n) && !permitidos.has(n)) infractores.push(`${relative(SRC_AGENT, p)}: ${n}`);
      }
    }
    expect(infractores).toEqual([]);
  });

  it('quien importa de una puerta (nombres o `ns.nombre`) no pide nada prohibido, ni accede por nombre calculado', () => {
    const infractores: string[] = [];
    for (const puerta of PUERTAS) {
      const rutaPuerta = join(SRC_AGENT, puerta);
      for (const p of [...deTools, ...deRuntime].filter((x) => x !== rutaPuerta)) {
        for (const nombre of nombresPedidosALaPuerta(p, fuente(p), rutaPuerta)) {
          const malo =
            nombre === '[acceso calculado]' ||
            prohibidos.has(nombre) ||
            (Object.hasOwn(MANIFIESTO_DE_DB, nombre) && clasificacionDe(nombre) === 'prohibited');
          if (malo) infractores.push(`${relative(SRC_AGENT, p)} ← ${puerta}: ${nombre}`);
        }
      }
    }
    expect(infractores).toEqual([]);
  });

  it('control: pedir a una puerta una función prohibida o un acceso calculado SE DETECTA (QA-14, QA-15)', () => {
    const falso = (c: string) => ts.createSourceFile('x.ts', c, ts.ScriptTarget.ES2022, true);
    const rutaPuerta = join(SRC_AGENT, 'runtime', 'db-ports.ts');
    const archivo = join(SRC_AGENT, 'runtime', 'ejecutar-run.ts');
    expect(
      nombresPedidosALaPuerta(archivo, falso(`import { confirmarAccion } from './db-ports.ts';`), rutaPuerta),
    ).toEqual(['confirmarAccion']);
    expect(
      nombresPedidosALaPuerta(
        archivo,
        falso(`import * as p from './db-ports.ts'; p.aprobarBrief; p['x' + 'y'];`),
        rutaPuerta,
      ),
    ).toEqual(['aprobarBrief', '[acceso calculado]']);
    expect(prohibidos.has('confirmarAccion')).toBe(true);
    expect(esImportablePorElAgente('confirmarAccion')).toBe(false);
  });

  it('use-cases.ts solo importa funciones importables (read/write/proposal/runtime) y ninguna prohibida', () => {
    const importadas = importadosDeDb(fuente(join(AQUI, 'use-cases.ts')));
    expect(importadas.length).toBeGreaterThan(20);
    const malas = importadas.filter((n) => !esImportablePorElAgente(n));
    expect(malas).toEqual([]);
    expect(importadas.filter((n) => clasificacionDe(n) === 'prohibited')).toEqual([]);
  });

  it('la puerta del runtime tampoco importa nada prohibido', () => {
    const importadas = importadosDeDb(fuente(join(SRC_AGENT, 'runtime', 'db-ports.ts')));
    expect(importadas.filter((n) => clasificacionDe(n) === 'prohibited')).toEqual([]);
  });

  it('transicionarBrief solo se llama con el destino fijo internal_review y nunca con approved', () => {
    const sf = fuente(join(AQUI, 'use-cases.ts'));
    const destinos: string[] = [];
    const visita = (n: ts.Node): void => {
      if (
        ts.isCallExpression(n) &&
        ts.isIdentifier(n.expression) &&
        n.expression.text === 'transicionarBrief'
      ) {
        const d = n.arguments[2];
        destinos.push(d !== undefined && ts.isStringLiteral(d) ? d.text : '(no literal)');
      }
      ts.forEachChild(n, visita);
    };
    visita(sf);
    expect(destinos).toEqual(['internal_review']);
    expect(readFileSync(join(AQUI, 'use-cases.ts'), 'utf8')).not.toMatch(/'approved'/);
  });
});

// ─────────────────────────── (d) catálogo ──────────────────────────────────────

const usoDeSql = /\b(getPool|queryOne|transaction)\b|\bfrom\s+['"]pg['"]|\.query\s*\(/;

describe('(d) el catálogo registrado', () => {
  const nombresDeUseCases = importadosDeDb(fuente(join(AQUI, 'use-cases.ts')));
  const permitidosParaTools = new Set([...nombresDeUseCases, 'solicitarRevisionInternaDelBrief']);

  it('tiene 19 READ, 13 WRITE y 4 CONFIRMATION_REQUIRED, todos distintos (36 tools)', () => {
    const por = (r: string) => CATALOGO_V1.filter((t) => t.risk === r).map((t) => t.name);
    expect(por('read')).toHaveLength(19);
    expect(por('write')).toHaveLength(13);
    expect(por('confirmation_required').sort()).toEqual([
      'brief_propose_approval',
      'script_propose_approval',
      'sheet_propose_apply',
      'sheet_propose_resolution',
    ]);
    expect(new Set(CATALOGO_V1.map((t) => t.name)).size).toBe(36);
  });

  it('F7: las 11 tools de contenido son exactamente estas (5 lectura, 5 escritura, 1 propuesta)', () => {
    const f7 = (r: string, nombres: string[]) =>
      expect(
        CATALOGO_V1.filter((t) => t.risk === r && nombres.includes(t.name))
          .map((t) => t.name)
          .sort(),
      ).toEqual([...nombres].sort());
    f7('read', [
      'deliverable_list',
      'deliverable_get',
      'script_version_get',
      'finding_list',
      'review_comment_list',
    ]);
    f7('write', [
      'deliverable_create',
      'script_version_register',
      'content_analysis_request',
      'review_comment_add',
      'script_request_changes',
    ]);
    f7('confirmation_required', ['script_propose_approval']);
  });

  it('(c′) ninguna tool tiene un nombre de decisión (approve/confirm/execute/reject/dismiss/publish/visibility/archive) salvo `_propose_`', () => {
    const decision = /(^|_)(approve|approval|confirm|execute|reject|dismiss|publish|visibility|archive)(_|$)/;
    for (const t of CATALOGO_V1) {
      if (t.name.includes('_propose_')) continue;
      expect(decision.test(t.name), t.name).toBe(false);
    }
    // el patrón detecta justo lo que debe (control)
    for (const malo of [
      'script_approve',
      'finding_dismiss',
      'deliverable_archive',
      'script_version_visibility',
    ]) {
      expect(decision.test(malo), malo).toBe(true);
    }
    expect(decision.test('script_propose_approval')).toBe(true); // por eso se exceptúa `_propose_`
  });

  it('F7: ninguna tool de contenido tiene una propiedad de esquema que el modelo no deba aportar', () => {
    const prohibidas = [
      'approved',
      'authorId',
      'versionNumber',
      'briefVersionId',
      'analysisId',
      'mode',
      'force',
      'idempotencyKey',
      'chatMessageId',
      'status',
    ];
    for (const t of CATALOGO_V1) {
      for (const p of prohibidas)
        expect(Object.hasOwn(t.inputSchema.properties, p), `${t.name}.${p}`).toBe(false);
    }
  });

  it('ninguna tool es PROHIBIDA: ni por nombre ni por el caso de uso que reutiliza', () => {
    const prohibidos = new Set(identificadoresProhibidos().map((n) => n.toLowerCase()));
    for (const t of CATALOGO_V1) {
      expect(prohibidos.has(t.name.toLowerCase().replaceAll('_', '')), t.name).toBe(false);
      expect(t.reuses.length, t.name).toBeGreaterThan(0);
      for (const caso of t.reuses) {
        const funcion = caso.split(' ')[0]!;
        expect(prohibidos.has(funcion.toLowerCase()), `${t.name} → ${caso}`).toBe(false);
        expect(permitidosParaTools.has(funcion), `${t.name} → ${caso} no está en use-cases.ts`).toBe(true);
        if (Object.hasOwn(MANIFIESTO_DE_DB, funcion)) {
          expect(esImportablePorElAgente(funcion), `${t.name} → ${funcion}`).toBe(true);
        }
      }
    }
  });

  it('las tools de escritura y de propuesta reutilizan un caso de uso de escritura/propuesta (nunca SQL)', () => {
    for (const t of CATALOGO_V1.filter((x) => x.risk !== 'read')) {
      const clases = t.reuses.map((r) => clasificacionDe(r.split(' ')[0]!));
      const esperada = t.risk === 'write' ? 'write-tool' : 'proposal-tool';
      expect(clases, t.name).toContain(esperada);
    }
  });

  it('el único caso de uso NUEVO que reutilizan las tools es actualizarCampana', () => {
    const quienes = CATALOGO_V1.filter((t) => t.reuses.includes('actualizarCampana')).map((t) => t.name);
    expect(quienes).toEqual(['campaign_update_metadata']);
  });

  it('ningún archivo de tools/ (catálogo, executor, registro) usa SQL ni importa pg', () => {
    const archivos = archivosTs(AQUI).filter((p) => !esDePrueba(p) && !p.endsWith('manifest.ts'));
    for (const p of archivos) {
      const codigo = readFileSync(p, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
      expect(usoDeSql.test(codigo), relative(SRC_AGENT, p)).toBe(false);
    }
  });

  it('el registro RECHAZA registrar una tool prohibida (por nombre o por caso de uso)', () => {
    const base = CATALOGO_V1[0]!;
    const falsa = (name: string, reuses: readonly string[]): AnyToolDefinition => ({ ...base, name, reuses });
    const nonceForRun = () => 'a'.repeat(32);
    expect(() =>
      createToolRegistry({ nonceForRun, tools: [falsa('aprobar_brief', ['getCampaign'])] }),
    ).toThrow(/PROHIBIDA/);
    expect(() =>
      createToolRegistry({ nonceForRun, tools: [falsa('brief_approve', ['aprobarBrief'])] }),
    ).toThrow(/prohibido/);
    expect(() =>
      createToolRegistry({ nonceForRun, tools: [falsa('confirm_action', ['confirmarAccion'])] }),
    ).toThrow(/prohibido/);
    expect(() => createToolRegistry({ nonceForRun, tools: [falsa('x_tool', [])] })).toThrow(/reutiliza/);
    expect(() => createToolRegistry({ nonceForRun, tools: [CATALOGO_V1[0]!, CATALOGO_V1[0]!] })).toThrow(
      /duplicada/,
    );
  });
});
