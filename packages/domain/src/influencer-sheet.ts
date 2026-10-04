/**
 * TCL KOL OS INFLUENCER SHEET — esquema V1 (V2 · Fase 5).
 *
 * El Google Sheet de influencers es una FUENTE OPERATIVA ESTRUCTURADA con un
 * contrato propio, versionado y verificable por máquina. NO se adivina un layout
 * arbitrario ni se detecta una tabla por heurística (a diferencia de la cabecera
 * de un XLSX genérico, que es una heurística declarada de la Fase 4).
 *
 *   Pestaña   cualquiera; se identifica por el MARCADOR, no por su nombre.
 *   A1        TCL_KOL_OS_INFLUENCERS_V1        ← señal inequívoca de esquema y versión
 *   Fila 2    cabeceras canónicas
 *   Fila 3+   datos: UNA FILA = UNA CUENTA (plataforma + handle) de una persona
 *
 * Una persona con varias cuentas ocupa varias filas que comparten la misma
 * `clave_influencer`. La clave es una identidad estable DENTRO de esta fuente
 * (INF-001, INF-002…): jamás se agrupa por nombre, porque dos personas pueden
 * llamarse igual. No es el id global del Influencer; solo evita fusionar o
 * duplicar personas entre sincronizaciones.
 *
 * Columnas:
 *   REQUERIDAS      clave_influencer · nombre · plataforma · handle
 *   OPCIONAL (núcleo)  producto        → se resuelve contra los `campaign_products`
 *   FUTURAS         entregables · tipo_acuerdo · fee · canje · fecha_inicio ·
 *                   fecha_fin · kpi_objetivo · condiciones
 *                   → se VALIDAN y se CONSERVAN en el snapshot (con su localizador);
 *                     no se materializan: Agreements, Deliverables y KPIs son
 *                     entidades de fases posteriores. Nunca se vuelcan como JSON a
 *                     `CampaignInfluencer`.
 *
 * Columnas desconocidas: advertencia (se conservan en el snapshot, no se
 * interpretan). Nada se ignora en silencio: todo queda en el informe.
 *
 * Este módulo es PURO (sin base de datos ni red): recibe la rejilla de un
 * snapshot y devuelve un informe. Si el esquema es inválido, el informe lo dice y
 * el dominio no se toca.
 */

import {
  type NormalizedHandle,
  type SocialPlatform,
  isSocialPlatform,
  normalizeDisplayName,
  normalizeHandle,
} from './influencers';
import type { SnapshotGrid, SnapshotRow, SnapshotSheet } from './source-snapshots';
import { columnLetters } from './source-snapshots';

// ─────────────────────────── Contrato ──────────────────────────────────────────

export const INFLUENCER_SHEET_SCHEMA_ID = 'TCL_KOL_OS_INFLUENCERS';
export const INFLUENCER_SHEET_VERSION = 1;
export const INFLUENCER_SHEET_MARKER = `${INFLUENCER_SHEET_SCHEMA_ID}_V${INFLUENCER_SHEET_VERSION}`;
/** El marcador (cualquier versión): `TCL_KOL_OS_INFLUENCERS_V<n>`. */
const PATRON_DE_MARCADOR = /^TCL_KOL_OS_INFLUENCERS_V(\d{1,4})$/;
const PREFIJO_DE_MARCADOR = 'TCL_KOL_OS_INFLUENCERS';

export const MARKER_ROW = 1;
export const HEADER_ROW = 2;
export const FIRST_DATA_ROW = 3;

export type InfluencerSheetColumn =
  | 'clave_influencer'
  | 'nombre'
  | 'plataforma'
  | 'handle'
  | 'producto'
  | 'entregables'
  | 'tipo_acuerdo'
  | 'fee'
  | 'canje'
  | 'fecha_inicio'
  | 'fecha_fin'
  | 'kpi_objetivo'
  | 'condiciones';

export const REQUIRED_COLUMNS: readonly InfluencerSheetColumn[] = [
  'clave_influencer',
  'nombre',
  'plataforma',
  'handle',
] as const;

/** Columnas del núcleo que la Fase 5 SÍ materializa (además de las obligatorias). */
export const OPTIONAL_CORE_COLUMNS: readonly InfluencerSheetColumn[] = ['producto'] as const;

/** Columnas que la Fase 5 valida y conserva, pero NO ejecuta. */
export const FUTURE_COLUMNS: readonly InfluencerSheetColumn[] = [
  'entregables',
  'tipo_acuerdo',
  'fee',
  'canje',
  'fecha_inicio',
  'fecha_fin',
  'kpi_objetivo',
  'condiciones',
] as const;

export const KNOWN_COLUMNS: readonly InfluencerSheetColumn[] = [
  ...REQUIRED_COLUMNS,
  ...OPTIONAL_CORE_COLUMNS,
  ...FUTURE_COLUMNS,
];

export const AGREEMENT_TYPES = ['fee', 'canje', 'mixto'] as const;

const MAX_CLAVE = 64;
const PATRON_DE_CLAVE = /^[A-Z0-9][A-Z0-9._-]*$/;
const PATRON_DE_FECHA = /^\d{4}-\d{2}-\d{2}$/;
const PATRON_DE_NUMERO = /^\d+(?:[.,]\d+)?$/;

// ─────────────────────────── Informe ───────────────────────────────────────────

export type SheetIssueCode =
  // estructurales (invalidan el Sheet entero: no se importa nada)
  | 'SHEET_TAB_NOT_FOUND'
  | 'MARKER_MISSING'
  | 'MARKER_UNSUPPORTED_VERSION'
  | 'MARKER_AMBIGUOUS_TAB'
  | 'HEADER_ROW_EMPTY'
  | 'HEADER_REQUIRED_MISSING'
  | 'HEADER_DUPLICATE'
  // advertencias (se informan; el Sheet sigue siendo válido)
  | 'HEADER_UNKNOWN'
  | 'COLUMN_WITHOUT_HEADER'
  | 'MARKER_ROW_EXTRA_CELLS'
  | 'SHEET_HIDDEN'
  // por registro (invalidan ESE registro, no el Sheet)
  | 'ROW_KEY_MISSING'
  | 'ROW_KEY_INVALID'
  | 'ROW_NAME_INVALID'
  | 'ROW_PLATFORM_MISSING'
  | 'ROW_PLATFORM_UNSUPPORTED'
  | 'ROW_HANDLE_INVALID'
  | 'CELL_ERROR'
  | 'KEY_NAME_INCONSISTENT'
  | 'ACCOUNT_DUPLICATE_IN_KEY'
  | 'ACCOUNT_IN_TWO_KEYS'
  | 'FUTURE_FIELD_INVALID';

export interface SheetIssue {
  readonly code: SheetIssueCode;
  readonly message: string;
  readonly row?: number | undefined;
  readonly column?: string | undefined;
  readonly header?: string | undefined;
}

export interface SheetAccount {
  readonly platform: SocialPlatform;
  /** Como se escribió, sin `@` inicial. */
  readonly handle: string;
  /** Clave de comparación (la regla única de la Fase 3). */
  readonly normalizedHandle: string;
  readonly row: number;
}

export interface SheetProductRef {
  /** Como se escribió. */
  readonly ref: string;
  /** Clave de comparación (`normalizeProductRef`). */
  readonly normalizedRef: string;
  readonly row: number;
}

/** Un valor de una columna FUTURA: se conserva, no se ejecuta. */
export interface SheetFutureValue {
  readonly column: InfluencerSheetColumn;
  readonly row: number;
  readonly text: string;
}

/** Ubicación de una fila del Sheet dentro del snapshot (rango A1 de la fila). */
export interface SheetRowLocator {
  readonly kind: 'range';
  readonly sheet: string;
  readonly range: string;
  readonly rowStart: number;
  readonly rowEnd: number;
  readonly colStart: number;
  readonly colEnd: number;
}

export interface SheetRecord {
  /** Clave estable dentro de la fuente, normalizada a MAYÚSCULAS. `__FILA_<n>` si la fila no la tiene. */
  readonly sourceKey: string;
  readonly displayName: string;
  readonly accounts: readonly SheetAccount[];
  readonly products: readonly SheetProductRef[];
  readonly futureValues: readonly SheetFutureValue[];
  /** Filas del Sheet que componen el registro. */
  readonly rows: readonly number[];
  readonly locators: readonly SheetRowLocator[];
  /** Errores de ESTE registro (no del Sheet). Con alguno, el registro es inválido. */
  readonly problems: readonly SheetIssue[];
  /**
   * Huella estable del contenido del registro, por partes (incluidos los valores
   * futuros). Quien persiste la hashea; sirve para detectar QUÉ cambió entre
   * snapshots sin depender del número de fila y sin guardar los valores.
   */
  readonly fingerprint: RecordFingerprint;
}

/** Partes comparables de un registro, cada una en JSON canónico. */
export interface RecordFingerprint {
  readonly name: string;
  readonly accounts: string;
  readonly products: string;
  readonly future: string;
}

export interface InfluencerSheetValidation {
  /** Esquema reconocido, o `null` si no se encontró el marcador. */
  readonly schema: { readonly id: string; readonly version: number } | null;
  readonly sheet: { readonly name: string; readonly gid: number | undefined } | null;
  /** `invalid` = error ESTRUCTURAL (versión, marcador, cabeceras): no se importa nada. */
  readonly status: 'valid' | 'invalid';
  readonly errors: readonly SheetIssue[];
  readonly warnings: readonly SheetIssue[];
  /** Cabeceras reconocidas: columna canónica → letra y posición. */
  readonly headers: readonly {
    readonly column: InfluencerSheetColumn;
    readonly index: number;
    readonly letter: string;
  }[];
  readonly records: readonly SheetRecord[];
}

// ─────────────────────────── Normalizaciones ───────────────────────────────────

/** Cabecera → clave canónica: NFKC, minúsculas, espacios y guiones a `_`. */
export function normalizeHeader(raw: string): string {
  return raw
    .normalize('NFKC')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/gu, '_');
}

/**
 * Referencia de producto → clave de comparación: NFKC, espacios colapsados,
 * minúsculas. Determinística: sin similitud, sin sinónimos.
 */
export function normalizeProductRef(raw: string): string {
  return raw.normalize('NFKC').replace(/\s+/gu, ' ').trim().toLowerCase();
}

function limpiarTexto(raw: string): string {
  return raw.normalize('NFC').replace(/\s+/gu, ' ').trim();
}

// ─────────────────────────── Validación ────────────────────────────────────────

function celdaEn(fila: SnapshotRow | undefined, col: number) {
  return fila?.cells.find((c) => c.col === col);
}

function esFechaIsoValida(texto: string): boolean {
  if (!PATRON_DE_FECHA.test(texto)) return false;
  const [a, m, d] = texto.split('-').map(Number) as [number, number, number];
  const f = new Date(Date.UTC(a, m - 1, d));
  return f.getUTCFullYear() === a && f.getUTCMonth() === m - 1 && f.getUTCDate() === d;
}

interface Opciones {
  /** `gid` de la pestaña a la que apuntaba el enlace registrado, si lo traía. */
  readonly gid?: number | undefined;
}

/** Marcador de una pestaña (celda A1), o `undefined` si no es de este esquema. */
function marcadorDe(hoja: SnapshotSheet): string | undefined {
  const texto = celdaEn(
    hoja.rows.find((r) => r.row === MARKER_ROW),
    1,
  )?.text;
  const limpio = texto?.normalize('NFKC').trim().toUpperCase();
  return limpio !== undefined && limpio.startsWith(PREFIJO_DE_MARCADOR) ? limpio : undefined;
}

function estructuralInvalido(
  errors: SheetIssue[],
  warnings: SheetIssue[],
  schema: InfluencerSheetValidation['schema'],
  sheet: InfluencerSheetValidation['sheet'],
): InfluencerSheetValidation {
  return { schema, sheet, status: 'invalid', errors, warnings, headers: [], records: [] };
}

/**
 * Valida la rejilla de un snapshot contra el esquema V1 y extrae los registros.
 * Nunca lanza: todo hallazgo queda en el informe.
 */
export function validateInfluencerSheet(
  grid: SnapshotGrid,
  opciones: Opciones = {},
): InfluencerSheetValidation {
  const errors: SheetIssue[] = [];
  const warnings: SheetIssue[] = [];

  // 1. ¿Qué pestaña? Por `gid` si el enlace apuntaba a una; si no, la que lleva el marcador.
  let hoja: SnapshotSheet | undefined;
  if (opciones.gid !== undefined) {
    hoja = grid.sheets.find((s) => s.gid === opciones.gid);
    if (hoja === undefined) {
      errors.push({
        code: 'SHEET_TAB_NOT_FOUND',
        message: 'La pestaña indicada en el enlace del Sheet no existe en la lectura.',
      });
      return estructuralInvalido(errors, warnings, null, null);
    }
  } else {
    const conMarcador = grid.sheets.filter((s) => marcadorDe(s) !== undefined);
    if (conMarcador.length === 0) {
      errors.push({
        code: 'MARKER_MISSING',
        message: `Ninguna pestaña tiene el marcador ${INFLUENCER_SHEET_MARKER} en la celda A1.`,
      });
      return estructuralInvalido(errors, warnings, null, null);
    }
    if (conMarcador.length > 1) {
      errors.push({
        code: 'MARKER_AMBIGUOUS_TAB',
        message: `Hay ${conMarcador.length} pestañas con marcador (${conMarcador
          .map((s) => `«${s.name}»`)
          .join(', ')}). Deje una sola o use el enlace de la pestaña.`,
      });
      return estructuralInvalido(errors, warnings, null, null);
    }
    hoja = conMarcador[0]!;
  }
  const sheetInfo = { name: hoja.name, gid: hoja.gid };

  // 2. Marcador y versión.
  const marcador = marcadorDe(hoja);
  if (marcador === undefined) {
    errors.push({
      code: 'MARKER_MISSING',
      message: `La pestaña «${hoja.name}» no tiene el marcador ${INFLUENCER_SHEET_MARKER} en A1.`,
      row: MARKER_ROW,
      column: 'A',
    });
    return estructuralInvalido(errors, warnings, null, sheetInfo);
  }
  const version = PATRON_DE_MARCADOR.exec(marcador)?.[1];
  if (version === undefined || Number(version) !== INFLUENCER_SHEET_VERSION) {
    errors.push({
      code: 'MARKER_UNSUPPORTED_VERSION',
      message: `Versión de esquema no soportada: «${marcador}». Esta versión del sistema lee ${INFLUENCER_SHEET_MARKER}.`,
      row: MARKER_ROW,
      column: 'A',
    });
    return estructuralInvalido(errors, warnings, null, sheetInfo);
  }
  const schema = { id: INFLUENCER_SHEET_SCHEMA_ID, version: INFLUENCER_SHEET_VERSION };

  if (hoja.state !== 'visible') {
    warnings.push({ code: 'SHEET_HIDDEN', message: `La pestaña «${hoja.name}» está oculta.` });
  }
  const filaMarcador = hoja.rows.find((r) => r.row === MARKER_ROW);
  if ((filaMarcador?.cells.length ?? 0) > 1) {
    warnings.push({
      code: 'MARKER_ROW_EXTRA_CELLS',
      message: 'La fila 1 solo debe contener el marcador en A1; el resto se ignora.',
      row: MARKER_ROW,
    });
  }

  // 3. Cabeceras (fila 2, posición fija).
  const filaCabecera = hoja.rows.find((r) => r.row === HEADER_ROW);
  if (filaCabecera === undefined || filaCabecera.cells.length === 0) {
    errors.push({
      code: 'HEADER_ROW_EMPTY',
      message: `La fila ${HEADER_ROW} debe contener las cabeceras de columna.`,
      row: HEADER_ROW,
    });
    return estructuralInvalido(errors, warnings, schema, sheetInfo);
  }
  const columnas = new Map<InfluencerSheetColumn, number>();
  const cabeceras: { column: InfluencerSheetColumn; index: number; letter: string }[] = [];
  const conocidas = new Set<string>(KNOWN_COLUMNS);
  const columnasConCabecera = new Set<number>();
  for (const celda of filaCabecera.cells) {
    const original = limpiarTexto(celda.text);
    if (original === '') continue;
    columnasConCabecera.add(celda.col);
    const canonica = normalizeHeader(original);
    if (!conocidas.has(canonica)) {
      warnings.push({
        code: 'HEADER_UNKNOWN',
        message: `Columna desconocida «${original}»: se conserva en el snapshot pero no se interpreta.`,
        row: HEADER_ROW,
        column: columnLetters(celda.col),
        header: original,
      });
      continue;
    }
    const columna = canonica as InfluencerSheetColumn;
    if (columnas.has(columna)) {
      errors.push({
        code: 'HEADER_DUPLICATE',
        message: `La cabecera «${columna}» aparece más de una vez.`,
        row: HEADER_ROW,
        column: columnLetters(celda.col),
        header: original,
      });
      continue;
    }
    columnas.set(columna, celda.col);
    cabeceras.push({ column: columna, index: celda.col, letter: columnLetters(celda.col) });
  }
  for (const requerida of REQUIRED_COLUMNS) {
    if (!columnas.has(requerida)) {
      errors.push({
        code: 'HEADER_REQUIRED_MISSING',
        message: `Falta la columna obligatoria «${requerida}».`,
        row: HEADER_ROW,
        header: requerida,
      });
    }
  }
  if (errors.length > 0) {
    return { schema, sheet: sheetInfo, status: 'invalid', errors, warnings, headers: cabeceras, records: [] };
  }

  // Datos en columnas sin cabecera: se avisa una vez por columna.
  const sinCabecera = new Set<number>();
  for (const fila of hoja.rows) {
    if (fila.row < FIRST_DATA_ROW) continue;
    for (const c of fila.cells) {
      if (!columnasConCabecera.has(c.col) && limpiarTexto(c.text) !== '') sinCabecera.add(c.col);
    }
  }
  for (const col of [...sinCabecera].sort((a, b) => a - b)) {
    warnings.push({
      code: 'COLUMN_WITHOUT_HEADER',
      message: `La columna ${columnLetters(col)} tiene datos pero no tiene cabecera: se conserva y no se interpreta.`,
      column: columnLetters(col),
    });
  }

  const records = extraerRegistros(hoja, columnas);
  return { schema, sheet: sheetInfo, status: 'valid', errors, warnings, headers: cabeceras, records };
}

// ─────────────────────────── Registros ─────────────────────────────────────────

interface FilaLeida {
  readonly row: number;
  readonly clave: string | undefined;
  readonly nombre: string | undefined;
  readonly cuenta: SheetAccount | undefined;
  readonly producto: SheetProductRef | undefined;
  readonly futuros: SheetFutureValue[];
  readonly problemas: SheetIssue[];
  readonly locator: SheetRowLocator;
}

function leerFila(
  hoja: SnapshotSheet,
  fila: SnapshotRow,
  columnas: ReadonlyMap<InfluencerSheetColumn, number>,
): FilaLeida {
  const problemas: SheetIssue[] = [];
  const texto = (col: InfluencerSheetColumn): { text: string; tipo: string } | undefined => {
    const posicion = columnas.get(col);
    if (posicion === undefined) return undefined;
    const celda = celdaEn(fila, posicion);
    if (celda === undefined) return undefined;
    const limpio = limpiarTexto(celda.text);
    if (limpio === '') return undefined;
    if (celda.type === 'error') {
      problemas.push({
        code: 'CELL_ERROR',
        message: `La celda de «${col}» contiene un error de la hoja (${limpio}).`,
        row: fila.row,
        column: columnLetters(posicion),
        header: col,
      });
      return undefined;
    }
    return { text: limpio, tipo: celda.type };
  };
  const incidencia = (code: SheetIssueCode, message: string, col: InfluencerSheetColumn): void => {
    problemas.push({
      code,
      message,
      row: fila.row,
      column: columnas.has(col) ? columnLetters(columnas.get(col)!) : undefined,
      header: col,
    });
  };

  // clave
  const claveCruda = texto('clave_influencer');
  let clave: string | undefined;
  if (claveCruda === undefined) {
    incidencia('ROW_KEY_MISSING', 'La fila no tiene clave_influencer.', 'clave_influencer');
  } else {
    const candidata = claveCruda.text.normalize('NFKC').toUpperCase();
    if (candidata.length > MAX_CLAVE || !PATRON_DE_CLAVE.test(candidata)) {
      incidencia(
        'ROW_KEY_INVALID',
        `La clave «${claveCruda.text}» no es válida: letras, números, punto, guion y guion bajo (máx. ${MAX_CLAVE}).`,
        'clave_influencer',
      );
    } else {
      clave = candidata;
    }
  }

  // nombre
  let nombre: string | undefined;
  const nombreCrudo = texto('nombre');
  const nombreValido = normalizeDisplayName(nombreCrudo?.text);
  if (nombreValido.ok) nombre = nombreValido.value;
  else incidencia('ROW_NAME_INVALID', nombreValido.error.message, 'nombre');

  // plataforma + handle
  let cuenta: SheetAccount | undefined;
  const plataformaCruda = texto('plataforma');
  const plataforma = plataformaCruda?.text.normalize('NFKC').toLowerCase();
  const handleCrudo = texto('handle');
  if (plataforma === undefined) {
    incidencia('ROW_PLATFORM_MISSING', 'La fila no tiene plataforma.', 'plataforma');
  } else if (!isSocialPlatform(plataforma)) {
    incidencia(
      'ROW_PLATFORM_UNSUPPORTED',
      `La plataforma «${plataformaCruda!.text}» no está soportada.`,
      'plataforma',
    );
  } else {
    const handle = normalizeHandle(plataforma, handleCrudo?.text);
    if (!handle.ok) {
      incidencia('ROW_HANDLE_INVALID', handle.error.message, 'handle');
    } else {
      const normalizado: NormalizedHandle = handle.value;
      cuenta = {
        platform: plataforma,
        handle: normalizado.handle,
        normalizedHandle: normalizado.normalized,
        row: fila.row,
      };
    }
  }

  // producto (núcleo opcional)
  let producto: SheetProductRef | undefined;
  const productoCrudo = texto('producto');
  if (productoCrudo !== undefined) {
    producto = {
      ref: productoCrudo.text,
      normalizedRef: normalizeProductRef(productoCrudo.text),
      row: fila.row,
    };
  }

  // columnas futuras: se validan y se conservan
  const futuros: SheetFutureValue[] = [];
  for (const col of FUTURE_COLUMNS) {
    const v = texto(col);
    if (v === undefined) continue;
    futuros.push({ column: col, row: fila.row, text: v.text });
    if (col === 'tipo_acuerdo' && !(AGREEMENT_TYPES as readonly string[]).includes(v.text.toLowerCase())) {
      incidencia(
        'FUTURE_FIELD_INVALID',
        `tipo_acuerdo «${v.text}» no es válido: ${AGREEMENT_TYPES.join(', ')}.`,
        col,
      );
    }
    if (col === 'fee' && !(v.tipo === 'numero' || PATRON_DE_NUMERO.test(v.text))) {
      incidencia('FUTURE_FIELD_INVALID', `fee «${v.text}» debe ser un número.`, col);
    }
    if ((col === 'fecha_inicio' || col === 'fecha_fin') && !esFechaIsoValida(v.text.slice(0, 10))) {
      incidencia('FUTURE_FIELD_INVALID', `${col} «${v.text}» debe ser una fecha (AAAA-MM-DD).`, col);
    }
  }
  const inicio = futuros.find((f) => f.column === 'fecha_inicio')?.text.slice(0, 10);
  const fin = futuros.find((f) => f.column === 'fecha_fin')?.text.slice(0, 10);
  if (
    inicio !== undefined &&
    fin !== undefined &&
    esFechaIsoValida(inicio) &&
    esFechaIsoValida(fin) &&
    inicio > fin
  ) {
    incidencia('FUTURE_FIELD_INVALID', 'fecha_fin no puede ser anterior a fecha_inicio.', 'fecha_fin');
  }

  const columnasUsadas = fila.cells.map((c) => c.col);
  const colStart = Math.min(...columnasUsadas);
  const colEnd = Math.max(...columnasUsadas);
  return {
    row: fila.row,
    clave,
    nombre,
    cuenta,
    producto,
    futuros,
    problemas,
    locator: {
      kind: 'range',
      sheet: hoja.name,
      range: `${columnLetters(colStart)}${fila.row}:${columnLetters(colEnd)}${fila.row}`,
      rowStart: fila.row,
      rowEnd: fila.row,
      colStart,
      colEnd,
    },
  };
}

function extraerRegistros(
  hoja: SnapshotSheet,
  columnas: ReadonlyMap<InfluencerSheetColumn, number>,
): SheetRecord[] {
  const filas = hoja.rows
    .filter((r) => r.row >= FIRST_DATA_ROW && r.cells.some((c) => limpiarTexto(c.text) !== ''))
    .sort((a, b) => a.row - b.row)
    .map((r) => leerFila(hoja, r, columnas));

  // Agrupar por clave estable. Una fila sin clave válida es su propio registro (inválido).
  const grupos = new Map<string, FilaLeida[]>();
  for (const f of filas) {
    const clave = f.clave ?? `__FILA_${f.row}`;
    const lista = grupos.get(clave) ?? [];
    lista.push(f);
    grupos.set(clave, lista);
  }

  const registros: SheetRecord[] = [];
  for (const [clave, lista] of grupos) {
    const problemas: SheetIssue[] = lista.flatMap((f) => f.problemas);

    // El nombre debe ser el mismo en todas las filas de la clave.
    const nombres = lista.filter((f) => f.nombre !== undefined);
    const nombre = nombres[0]?.nombre ?? '';
    for (const f of nombres.slice(1)) {
      if (f.nombre!.toLowerCase() !== nombre.toLowerCase()) {
        problemas.push({
          code: 'KEY_NAME_INCONSISTENT',
          message: `La clave ${clave} tiene nombres distintos («${nombre}» y «${f.nombre}»): una clave identifica a una sola persona.`,
          row: f.row,
          column: columnas.has('nombre') ? columnLetters(columnas.get('nombre')!) : undefined,
          header: 'nombre',
        });
      }
    }

    // Cuentas: sin repetir dentro de la clave.
    const cuentas: SheetAccount[] = [];
    const vistas = new Set<string>();
    for (const f of lista) {
      if (f.cuenta === undefined) continue;
      const id = `${f.cuenta.platform}:${f.cuenta.normalizedHandle}`;
      if (vistas.has(id)) {
        problemas.push({
          code: 'ACCOUNT_DUPLICATE_IN_KEY',
          message: `La cuenta ${f.cuenta.platform} @${f.cuenta.handle} aparece dos veces en la clave ${clave}.`,
          row: f.row,
          header: 'handle',
        });
        continue;
      }
      vistas.add(id);
      cuentas.push(f.cuenta);
    }

    // Productos: distintos por referencia normalizada.
    const productos: SheetProductRef[] = [];
    for (const f of lista) {
      if (f.producto !== undefined && !productos.some((p) => p.normalizedRef === f.producto!.normalizedRef)) {
        productos.push(f.producto);
      }
    }

    const futuros = lista.flatMap((f) => f.futuros);
    const ordenar = (lista: readonly (readonly string[])[]) =>
      [...lista].sort((a, b) => (a.join(':') < b.join(':') ? -1 : 1));
    const fingerprint: RecordFingerprint = {
      name: JSON.stringify(nombre.toLowerCase()),
      accounts: JSON.stringify(ordenar(cuentas.map((c) => [c.platform, c.normalizedHandle]))),
      products: JSON.stringify(productos.map((p) => p.normalizedRef).sort()),
      future: JSON.stringify(ordenar(futuros.map((v) => [v.column, v.text]))),
    };
    registros.push({
      sourceKey: clave,
      displayName: nombre,
      accounts: cuentas,
      products: productos,
      futureValues: futuros,
      rows: lista.map((f) => f.row),
      locators: lista.map((f) => f.locator),
      problems: problemas,
      fingerprint,
    });
  }

  // Una misma cuenta bajo dos claves distintas: ambas inválidas (no se adivina quién es).
  const duenos = new Map<string, string[]>();
  for (const r of registros) {
    for (const c of r.accounts) {
      const id = `${c.platform}:${c.normalizedHandle}`;
      duenos.set(id, [...(duenos.get(id) ?? []), r.sourceKey]);
    }
  }
  return registros.map((r) => {
    const choques = r.accounts.filter(
      (c) => (duenos.get(`${c.platform}:${c.normalizedHandle}`)?.length ?? 0) > 1,
    );
    if (choques.length === 0) return r;
    return {
      ...r,
      problems: [
        ...r.problems,
        ...choques.map((c): SheetIssue => ({
          code: 'ACCOUNT_IN_TWO_KEYS',
          message: `La cuenta ${c.platform} @${c.handle} aparece bajo claves distintas (${duenos
            .get(`${c.platform}:${c.normalizedHandle}`)!
            .join(', ')}).`,
          row: c.row,
          header: 'handle',
        })),
      ],
    };
  });
}

/** ¿El registro puede materializarse? Sin problemas propios. */
export function isRecordValid(record: SheetRecord): boolean {
  return record.problems.length === 0;
}
