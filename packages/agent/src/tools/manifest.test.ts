/**
 * Import-boundary (D15), comprobado sobre el CÓDIGO (AST de TypeScript).
 *
 *  (a) cada export de valor de `@tcl-kol-os/db` está clasificado (uno nuevo rompe el test);
 *  (b) solo los archivos-puerta importan de db (use-cases.ts; y runtime/db-ports.ts del runtime);
 *  (c) nada en `tools/` nombra un identificador PROHIBIDO; use-cases.ts importa solo lo importable;
 *  (d) ninguna tool registrada es prohibida ni usa SQL; transicionarBrief solo con destino `internal_review`.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
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

/** Módulos especificados en imports, exports-from, import() y require() de un archivo. */
function especificadores(sf: ts.SourceFile): string[] {
  const salida: string[] = [];
  const visita = (n: ts.Node): void => {
    if (
      (ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) &&
      n.moduleSpecifier &&
      ts.isStringLiteral(n.moduleSpecifier)
    ) {
      salida.push(n.moduleSpecifier.text);
    }
    if (ts.isCallExpression(n) && n.arguments.length > 0 && ts.isStringLiteralLike(n.arguments[0]!)) {
      if (
        n.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(n.expression) && n.expression.text === 'require')
      ) {
        salida.push((n.arguments[0] as ts.StringLiteralLike).text);
      }
    }
    ts.forEachChild(n, visita);
  };
  visita(sf);
  return salida;
}

const apuntaADb = (archivo: string, esp: string): boolean => {
  if (esp === '@tcl-kol-os/db' || esp.startsWith('@tcl-kol-os/db/')) return true;
  if (!esp.startsWith('.')) return false;
  const destino = resolve(dirname(archivo), esp);
  return destino === SRC_DB || destino.startsWith(`${SRC_DB}/`) || /(^|\/)packages\/db(\/|$)/.test(destino);
};

/** Puertas autorizadas: la de las tools y la del runtime (W2-B). Cualquier otro archivo falla. */
const PUERTAS = ['tools/use-cases.ts', 'runtime/db-ports.ts'];

describe('(b) solo las puertas importan de db', () => {
  const todos = archivosTs(SRC_AGENT).filter((p) => !esDePrueba(p));

  it('ningún archivo de packages/agent/src (salvo las puertas) importa de @tcl-kol-os/db ni de rutas relativas a db', () => {
    const infractores = todos
      .filter((p) => !PUERTAS.includes(relative(SRC_AGENT, p)))
      .filter((p) => especificadores(fuente(p)).some((e) => apuntaADb(p, e)))
      .map((p) => relative(SRC_AGENT, p));
    expect(infractores).toEqual([]);
  });

  it('tools/use-cases.ts es la puerta de las tools y existe', () => {
    const p = join(AQUI, 'use-cases.ts');
    expect(especificadores(fuente(p)).some((e) => e === '@tcl-kol-os/db')).toBe(true);
  });

  it('el detector atrapa un import relativo, uno dinámico y un require (control del propio test)', () => {
    const falso = ts.createSourceFile(
      'x.ts',
      `import a from '../../../db/src/index.ts'; const b = await import('@tcl-kol-os/db'); const c = require('@tcl-kol-os/db/test-utils');`,
      ts.ScriptTarget.ES2022,
      true,
    );
    const archivoFalso = join(SRC_AGENT, 'runtime', 'x.ts');
    expect(especificadores(falso).filter((e) => apuntaADb(archivoFalso, e))).toHaveLength(3);
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

describe('(c) nada en tools/ nombra una función PROHIBIDA', () => {
  const prohibidos = new Set(identificadoresProhibidos());
  const deTools = archivosTs(AQUI).filter((p) => !esDePrueba(p) && !p.endsWith('manifest.ts'));

  it('hay archivos que revisar y hay identificadores prohibidos que buscar', () => {
    expect(deTools.length).toBeGreaterThan(8);
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

  it('tiene 14 READ, 8 WRITE y 3 CONFIRMATION_REQUIRED, todos distintos', () => {
    const por = (r: string) => CATALOGO_V1.filter((t) => t.risk === r).map((t) => t.name);
    expect(por('read')).toHaveLength(14);
    expect(por('write')).toHaveLength(8);
    expect(por('confirmation_required').sort()).toEqual([
      'brief_propose_approval',
      'sheet_propose_apply',
      'sheet_propose_resolution',
    ]);
    expect(new Set(CATALOGO_V1.map((t) => t.name)).size).toBe(25);
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
