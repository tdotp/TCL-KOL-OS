/**
 * Localizador de evidencia (V2 · Fase 4).
 *
 * Un fragmento (y la evidencia que lo cita) debe poder volver al punto exacto de
 * su fuente. Hasta la Fase 3 eso eran las columnas `page`, `slide`, `section` y
 * `linea`; una hoja de cálculo no tiene ninguna de ellas. `SourceLocator` es el
 * contrato único: un objeto serializable y validable que expresa la ubicación en
 * cualquier formato.
 *
 *   page     PDF                    { kind: 'page', page: 3 }
 *   slide    PowerPoint             { kind: 'slide', slide: 8 }
 *   section  Markdown / DOCX        { kind: 'section', section: 'El Reto › Audiencia', line: 12 }
 *   sheet    una hoja completa      { kind: 'sheet', sheet: 'Influencers' }
 *   row      una fila               { kind: 'row', sheet: 'Influencers', row: 14 }
 *   cell     una celda              { kind: 'cell', sheet: 'Producto', cell: 'B7', row: 7, col: 2 }
 *   range    un rango               { kind: 'range', sheet: 'Producto', range: 'B7:D9', rowStart: 7, … }
 *   region   región visual          { kind: 'region', page?: n, slide?: n, x, y, width, height }
 *
 * Compatibilidad: las columnas legacy siguen existiendo y siguen siendo lo que
 * escriben los parsers de PDF/PPTX/DOCX/MD. La base deriva `locator` de ellas
 * (y `localizadorDesdeLegacy` es el espejo en TypeScript), de modo que todo
 * fragmento tiene un localizador y nada histórico se reescribe.
 *
 * La misma validación existe en la base (`source_locator_valido`); las pruebas
 * comprueban que ambas coinciden.
 */

import { type Result, err, ok } from './errors';

// ─────────────────────────── Tipos ─────────────────────────────────────────────

export interface PageLocator {
  readonly kind: 'page';
  readonly page: number;
  readonly section?: string | undefined;
  readonly line?: number | undefined;
}

export interface SlideLocator {
  readonly kind: 'slide';
  readonly slide: number;
  readonly section?: string | undefined;
}

export interface SectionLocator {
  readonly kind: 'section';
  readonly section: string;
  readonly line?: number | undefined;
}

export interface SheetLocator {
  readonly kind: 'sheet';
  readonly sheet: string;
}

export interface RowLocator {
  readonly kind: 'row';
  readonly sheet: string;
  readonly row: number;
}

export interface CellLocator {
  readonly kind: 'cell';
  readonly sheet: string;
  /** Notación A1, p. ej. `B7`. */
  readonly cell: string;
  readonly row: number;
  readonly col: number;
}

export interface RangeLocator {
  readonly kind: 'range';
  readonly sheet: string;
  /** Notación A1, p. ej. `B7:D9`. */
  readonly range: string;
  readonly rowStart: number;
  readonly rowEnd: number;
  readonly colStart: number;
  readonly colEnd: number;
}

/**
 * Región visual normalizada (0–1) dentro de una página, una diapositiva o la
 * imagen completa (si no trae ni `page` ni `slide`). Reservado para la
 * extracción visual: hoy ningún parser lo produce.
 */
export interface RegionLocator {
  readonly kind: 'region';
  readonly page?: number | undefined;
  readonly slide?: number | undefined;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export type SourceLocator =
  | PageLocator
  | SlideLocator
  | SectionLocator
  | SheetLocator
  | RowLocator
  | CellLocator
  | RangeLocator
  | RegionLocator;

export const SOURCE_LOCATOR_KINDS = [
  'page',
  'slide',
  'section',
  'sheet',
  'row',
  'cell',
  'range',
  'region',
] as const;

export type SourceLocatorKind = (typeof SOURCE_LOCATOR_KINDS)[number];

// ─────────────────────────── Notación A1 ───────────────────────────────────────

/** Columna 1-based → letras (1 → A, 27 → AA). */
export function columnaALetras(col: number): string {
  if (!Number.isInteger(col) || col < 1) throw new RangeError('La columna debe ser un entero ≥ 1.');
  let n = col;
  let letras = '';
  while (n > 0) {
    const resto = (n - 1) % 26;
    letras = String.fromCharCode(65 + resto) + letras;
    n = Math.floor((n - 1) / 26);
  }
  return letras;
}

/** Letras → columna 1-based (A → 1, AA → 27). `undefined` si no son letras A–Z. */
export function letrasAColumna(letras: string): number | undefined {
  if (!/^[A-Z]{1,3}$/.test(letras)) return undefined;
  let col = 0;
  for (const ch of letras) col = col * 26 + (ch.charCodeAt(0) - 64);
  return col;
}

export function celdaA1(row: number, col: number): string {
  return `${columnaALetras(col)}${row}`;
}

export function rangoA1(rowStart: number, colStart: number, rowEnd: number, colEnd: number): string {
  return `${celdaA1(rowStart, colStart)}:${celdaA1(rowEnd, colEnd)}`;
}

/** Máximos de Excel: 1.048.576 filas × 16.384 columnas (XFD). */
export const MAX_FILA = 1_048_576;
export const MAX_COLUMNA = 16_384;

// ─────────────────────────── Constructores ─────────────────────────────────────

export function localizadorDeCelda(sheet: string, row: number, col: number): CellLocator {
  return { kind: 'cell', sheet, cell: celdaA1(row, col), row, col };
}

export function localizadorDeRango(
  sheet: string,
  rowStart: number,
  colStart: number,
  rowEnd: number,
  colEnd: number,
): RangeLocator {
  return {
    kind: 'range',
    sheet,
    range: rangoA1(rowStart, colStart, rowEnd, colEnd),
    rowStart,
    rowEnd,
    colStart,
    colEnd,
  };
}

// ─────────────────────────── Validación ────────────────────────────────────────

const A1_CELDA = /^([A-Z]{1,3})([1-9][0-9]{0,6})$/;
/** Excel limita el nombre de hoja a 31; se deja holgura para CSV (nombre de archivo). */
const MAX_HOJA = 255;
const MAX_SECCION = 4000;

function esEnteroPositivo(v: unknown, max = Number.MAX_SAFE_INTEGER): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= max;
}

function esTextoNoVacio(v: unknown, max: number): v is string {
  return typeof v === 'string' && v.trim() !== '' && v.length <= max;
}

const esSeccion = (v: unknown): v is string => esTextoNoVacio(v, MAX_SECCION);
const esHoja = (v: unknown): v is string => esTextoNoVacio(v, MAX_HOJA);

function esOpcional<T>(v: unknown, esValido: (x: unknown) => x is T): boolean {
  return v === undefined || v === null || esValido(v);
}

function esFraccion(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1;
}

function invalido(motivo: string): Result<SourceLocator> {
  return err({
    code: 'VALIDATION_FAILED',
    message: `Localizador no válido: ${motivo}`,
    details: { field: 'locator' },
  });
}

/** Solo estas claves por tipo: lo desconocido se rechaza en vez de guardarse. */
const CLAVES_POR_TIPO: Readonly<Record<SourceLocatorKind, readonly string[]>> = {
  page: ['kind', 'page', 'section', 'line'],
  slide: ['kind', 'slide', 'section'],
  section: ['kind', 'section', 'line'],
  sheet: ['kind', 'sheet'],
  row: ['kind', 'sheet', 'row'],
  cell: ['kind', 'sheet', 'cell', 'row', 'col'],
  range: ['kind', 'sheet', 'range', 'rowStart', 'rowEnd', 'colStart', 'colEnd'],
  region: ['kind', 'page', 'slide', 'x', 'y', 'width', 'height'],
};

/**
 * Valida un localizador (por ejemplo, leído de la base o recibido del worker).
 * Devuelve el localizador tipado o `VALIDATION_FAILED` con el motivo.
 */
export function validarLocalizador(valor: unknown): Result<SourceLocator> {
  if (typeof valor !== 'object' || valor === null || Array.isArray(valor)) {
    return invalido('debe ser un objeto.');
  }
  const l = valor as Record<string, unknown>;
  const kind = l['kind'];
  if (typeof kind !== 'string' || !(SOURCE_LOCATOR_KINDS as readonly string[]).includes(kind)) {
    return invalido('el tipo (`kind`) no es reconocido.');
  }
  const permitidas = CLAVES_POR_TIPO[kind as SourceLocatorKind];
  for (const clave of Object.keys(l)) {
    if (!permitidas.includes(clave)) return invalido(`la clave «${clave}» no corresponde a «${kind}».`);
  }

  switch (kind as SourceLocatorKind) {
    case 'page':
      if (!esEnteroPositivo(l['page'])) return invalido('«page» debe ser un entero ≥ 1.');
      if (!esOpcional(l['section'], esSeccion) || !esOpcional(l['line'], esEnteroPositivo)) {
        return invalido('«section» o «line» inválidos.');
      }
      break;
    case 'slide':
      if (!esEnteroPositivo(l['slide'])) return invalido('«slide» debe ser un entero ≥ 1.');
      if (!esOpcional(l['section'], esSeccion)) return invalido('«section» inválida.');
      break;
    case 'section':
      if (!esSeccion(l['section'])) return invalido('«section» no puede estar vacía.');
      if (!esOpcional(l['line'], esEnteroPositivo)) return invalido('«line» inválida.');
      break;
    case 'sheet':
      if (!esHoja(l['sheet'])) return invalido('«sheet» no puede estar vacía.');
      break;
    case 'row':
      if (!esHoja(l['sheet'])) return invalido('«sheet» no puede estar vacía.');
      if (!esEnteroPositivo(l['row'], MAX_FILA)) return invalido('«row» fuera de rango.');
      break;
    case 'cell': {
      if (!esHoja(l['sheet'])) return invalido('«sheet» no puede estar vacía.');
      if (!esEnteroPositivo(l['row'], MAX_FILA) || !esEnteroPositivo(l['col'], MAX_COLUMNA)) {
        return invalido('«row» o «col» fuera de rango.');
      }
      const m = typeof l['cell'] === 'string' ? A1_CELDA.exec(l['cell']) : null;
      if (m === null || letrasAColumna(m[1]!) !== l['col'] || Number(m[2]) !== l['row']) {
        return invalido('«cell» no coincide con «row» y «col».');
      }
      break;
    }
    case 'range': {
      if (!esHoja(l['sheet'])) return invalido('«sheet» no puede estar vacía.');
      const { rowStart, rowEnd, colStart, colEnd } = l;
      if (
        !esEnteroPositivo(rowStart, MAX_FILA) ||
        !esEnteroPositivo(rowEnd, MAX_FILA) ||
        !esEnteroPositivo(colStart, MAX_COLUMNA) ||
        !esEnteroPositivo(colEnd, MAX_COLUMNA)
      ) {
        return invalido('el rango tiene filas o columnas fuera de rango.');
      }
      if (rowEnd < rowStart || colEnd < colStart) return invalido('el rango está invertido.');
      if (l['range'] !== rangoA1(rowStart, colStart, rowEnd, colEnd)) {
        return invalido('«range» no coincide con las filas y columnas.');
      }
      break;
    }
    case 'region':
      if (!esOpcional(l['page'], esEnteroPositivo) || !esOpcional(l['slide'], esEnteroPositivo)) {
        return invalido('«page» o «slide» inválidos.');
      }
      if (l['page'] != null && l['slide'] != null)
        return invalido('una región es de página o de diapositiva, no ambas.');
      if (![l['x'], l['y'], l['width'], l['height']].every(esFraccion)) {
        return invalido('x, y, width y height deben estar entre 0 y 1.');
      }
      if ((l['width'] as number) <= 0 || (l['height'] as number) <= 0)
        return invalido('la región no puede ser vacía.');
      if (
        (l['x'] as number) + (l['width'] as number) > 1 ||
        (l['y'] as number) + (l['height'] as number) > 1
      ) {
        return invalido('la región se sale de la imagen.');
      }
      break;
  }
  return ok(l as unknown as SourceLocator);
}

// ─────────────────────────── Compatibilidad con las columnas legacy ────────────

export interface ColumnasLegacy {
  readonly page?: number | null | undefined;
  readonly slide?: number | null | undefined;
  readonly section?: string | null | undefined;
  readonly linea?: number | null | undefined;
}

/**
 * Localizador equivalente a las columnas legacy (espejo del trigger de la base).
 * Precedencia: diapositiva > página > sección. El título/sección y la línea se
 * conservan como contexto cuando existen. `undefined` si no hay ubicación.
 */
export function localizadorDesdeLegacy(c: ColumnasLegacy): SourceLocator | undefined {
  const section = typeof c.section === 'string' && c.section.trim() !== '' ? c.section : undefined;
  const line = c.linea ?? undefined;
  if (c.slide != null)
    return { kind: 'slide', slide: c.slide, ...(section === undefined ? {} : { section }) };
  if (c.page != null) {
    return {
      kind: 'page',
      page: c.page,
      ...(section === undefined ? {} : { section }),
      ...(line === undefined ? {} : { line }),
    };
  }
  if (section !== undefined) return { kind: 'section', section, ...(line === undefined ? {} : { line }) };
  return undefined;
}

// ─────────────────────────── Presentación ──────────────────────────────────────

/** Texto legible en español para citar una ubicación. */
export function describirLocalizador(l: SourceLocator): string {
  switch (l.kind) {
    case 'page':
      return `página ${l.page}`;
    case 'slide':
      return `diapositiva ${l.slide}`;
    case 'section':
      return `sección «${l.section}»${l.line === undefined ? '' : `, línea ${l.line}`}`;
    case 'sheet':
      return `hoja «${l.sheet}»`;
    case 'row':
      return `hoja «${l.sheet}», fila ${l.row}`;
    case 'cell':
      return `hoja «${l.sheet}», celda ${l.cell}`;
    case 'range':
      return `hoja «${l.sheet}», rango ${l.range}`;
    case 'region':
      return l.page !== undefined
        ? `región de la página ${l.page}`
        : l.slide !== undefined
          ? `región de la diapositiva ${l.slide}`
          : 'región de la imagen';
  }
}

/** ¿El localizador apunta a una hoja de cálculo? */
export function esLocalizadorDeHoja(
  l: SourceLocator,
): l is SheetLocator | RowLocator | CellLocator | RangeLocator {
  return l.kind === 'sheet' || l.kind === 'row' || l.kind === 'cell' || l.kind === 'range';
}
