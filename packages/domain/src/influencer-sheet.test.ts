/**
 * V2 · Fase 5 — esquema TCL_KOL_OS_INFLUENCERS_V1 y su validador (puro).
 *
 * Propiedad central: un Sheet que no cumple el contrato NO produce registros
 * importables, y nunca se «arregla» en silencio. Los valores de las columnas
 * futuras se validan y se conservan, pero no se materializan.
 */

import { describe, expect, it } from 'vitest';
import {
  INFLUENCER_SHEET_MARKER,
  normalizeHeader,
  normalizeProductRef,
  validateInfluencerSheet,
  type InfluencerSheetValidation,
  type SheetIssueCode,
} from './influencer-sheet';
import type { SnapshotGrid, SnapshotSheet } from './source-snapshots';

type Celda = string | number | { fecha: string } | null;

const CABECERAS = ['clave_influencer', 'nombre', 'plataforma', 'handle', 'producto'];

/** Construye una pestaña: A1 = marcador, fila 2 = cabeceras, datos desde la fila 3. */
function pestana(
  filas: readonly (readonly Celda[])[],
  opciones: {
    marcador?: string | null;
    cabeceras?: readonly string[];
    nombre?: string;
    gid?: number;
    estado?: 'visible' | 'hidden';
    extraFila1?: boolean;
  } = {},
): SnapshotSheet {
  const celdas = (valores: readonly Celda[], fila: number) => ({
    row: fila,
    cells: valores.flatMap((v, i) =>
      v === null || v === ''
        ? []
        : [
            {
              col: i + 1,
              text: typeof v === 'object' ? v.fecha : String(v),
              type: typeof v === 'object' ? 'fecha' : typeof v === 'number' ? 'numero' : 'texto',
            },
          ],
    ),
  });
  const marcador = opciones.marcador === undefined ? INFLUENCER_SHEET_MARKER : opciones.marcador;
  return {
    name: opciones.nombre ?? 'Influencers',
    gid: opciones.gid ?? 11,
    state: opciones.estado ?? 'visible',
    rows: [
      ...(marcador === null
        ? []
        : [celdas(opciones.extraFila1 === true ? [marcador, 'nota'] : [marcador], 1)]),
      celdas(opciones.cabeceras ?? CABECERAS, 2),
      ...filas.map((f, i) => celdas(f, 3 + i)),
    ].filter((r) => r.cells.length > 0),
  };
}

const grid = (...hojas: SnapshotSheet[]): SnapshotGrid => ({ sheets: hojas });
const codigos = (lista: readonly { code: SheetIssueCode }[]) => lista.map((i) => i.code);

function valida(filas: readonly (readonly Celda[])[], extra: Parameters<typeof pestana>[1] = {}) {
  return validateInfluencerSheet(grid(pestana(filas, extra)));
}

const VALENTINA = ['INF-001', 'Valentina Rojas', 'Instagram', '@valentina.rojas', 'P80'];

describe('contrato V1', () => {
  it('un Sheet válido produce un registro por persona con su ubicación', () => {
    const v = valida([VALENTINA, ['INF-002', 'Juan Pérez', 'tiktok', 'juanp', 'C7L']]);
    expect(v.status).toBe('valid');
    expect(v.schema).toEqual({ id: 'TCL_KOL_OS_INFLUENCERS', version: 1 });
    expect(v.sheet).toEqual({ name: 'Influencers', gid: 11 });
    expect(v.errors).toEqual([]);
    expect(v.records.map((r) => r.sourceKey)).toEqual(['INF-001', 'INF-002']);
    const [valentina] = v.records;
    expect(valentina).toMatchObject({
      displayName: 'Valentina Rojas',
      problems: [],
      rows: [3],
      accounts: [
        { platform: 'instagram', handle: 'valentina.rojas', normalizedHandle: 'valentina.rojas', row: 3 },
      ],
      products: [{ ref: 'P80', normalizedRef: 'p80', row: 3 }],
    });
    // La ubicación del registro es la de su fila, con el contrato único.
    expect(valentina!.locators[0]).toMatchObject({
      kind: 'range',
      sheet: 'Influencers',
      range: 'A3:E3',
      rowStart: 3,
    });
  });

  it('el marcador identifica la pestaña, no su nombre', () => {
    const v = validateInfluencerSheet(
      grid(
        pestana([], { marcador: 'otra cosa', nombre: 'Influencers', gid: 1 }),
        pestana([VALENTINA], { nombre: 'Hoja3', gid: 2 }),
      ),
    );
    expect(v.status).toBe('valid');
    expect(v.sheet).toEqual({ name: 'Hoja3', gid: 2 });
  });

  it('cabeceras: mayúsculas, espacios y guiones se normalizan; nada más', () => {
    expect(normalizeHeader('  Clave Influencer ')).toBe('clave_influencer');
    expect(normalizeHeader('TIPO-ACUERDO')).toBe('tipo_acuerdo');
    const v = valida([VALENTINA], {
      cabeceras: ['Clave Influencer', 'NOMBRE', 'Plataforma', 'Handle', 'Producto'],
    });
    expect(v.status).toBe('valid');
    // «influencer» o «name» NO son alias: no hay adivinación.
    const sinAlias = valida([VALENTINA], { cabeceras: ['id', 'name', 'plataforma', 'handle'] });
    expect(sinAlias.status).toBe('invalid');
  });
});

describe('errores estructurales (el Sheet entero es inválido y no produce registros)', () => {
  it('marcador ausente', () => {
    const v = valida([VALENTINA], { marcador: null });
    expect(v.status).toBe('invalid');
    expect(codigos(v.errors)).toEqual(['MARKER_MISSING']);
    expect(v.records).toEqual([]);
    expect(v.schema).toBeNull();
  });

  it('marcador con otro texto en A1', () => {
    expect(codigos(valida([VALENTINA], { marcador: 'Influencers 2026' }).errors)).toEqual(['MARKER_MISSING']);
  });

  it('versión desconocida', () => {
    const v = valida([VALENTINA], { marcador: 'TCL_KOL_OS_INFLUENCERS_V2' });
    expect(codigos(v.errors)).toEqual(['MARKER_UNSUPPORTED_VERSION']);
    expect(v.records).toEqual([]);
    expect(codigos(valida([VALENTINA], { marcador: 'TCL_KOL_OS_INFLUENCERS_V1X' }).errors)).toEqual([
      'MARKER_UNSUPPORTED_VERSION',
    ]);
  });

  it('el marcador es insensible a mayúsculas y espacios en los extremos', () => {
    expect(valida([VALENTINA], { marcador: '  tcl_kol_os_influencers_v1 ' }).status).toBe('valid');
  });

  it('cabecera requerida ausente', () => {
    const v = valida([['INF-001', 'Ana', 'instagram']], {
      cabeceras: ['clave_influencer', 'nombre', 'plataforma'],
    });
    expect(v.status).toBe('invalid');
    expect(codigos(v.errors)).toEqual(['HEADER_REQUIRED_MISSING']);
    expect(v.errors[0]!.header).toBe('handle');
    expect(v.records).toEqual([]);
  });

  it('cabecera duplicada (también tras normalizar)', () => {
    const v = valida([VALENTINA], {
      cabeceras: ['clave_influencer', 'nombre', 'plataforma', 'handle', 'Handle'],
    });
    expect(codigos(v.errors)).toEqual(['HEADER_DUPLICATE']);
  });

  it('fila de cabeceras vacía', () => {
    const v = validateInfluencerSheet(
      grid({
        name: 'X',
        gid: 1,
        state: 'visible',
        rows: [{ row: 1, cells: [{ col: 1, text: INFLUENCER_SHEET_MARKER, type: 'texto' }] }],
      }),
    );
    expect(codigos(v.errors)).toEqual(['HEADER_ROW_EMPTY']);
  });

  it('dos pestañas con marcador sin gid → ambiguo; con gid, se elige esa', () => {
    const a = pestana([VALENTINA], { nombre: 'A', gid: 1 });
    const b = pestana([['INF-009', 'Otra', 'x', 'otra', '']], { nombre: 'B', gid: 2 });
    expect(codigos(validateInfluencerSheet(grid(a, b)).errors)).toEqual(['MARKER_AMBIGUOUS_TAB']);
    const elegida = validateInfluencerSheet(grid(a, b), { gid: 2 });
    expect(elegida.status).toBe('valid');
    expect(elegida.sheet?.name).toBe('B');
  });

  it('gid de una pestaña inexistente, o sin marcador, es un error de pestaña', () => {
    const a = pestana([VALENTINA], { gid: 1 });
    expect(codigos(validateInfluencerSheet(grid(a), { gid: 99 }).errors)).toEqual(['SHEET_TAB_NOT_FOUND']);
    const sin = pestana([VALENTINA], { gid: 5, marcador: null });
    expect(codigos(validateInfluencerSheet(grid(sin), { gid: 5 }).errors)).toEqual(['MARKER_MISSING']);
  });

  it('un libro sin pestañas', () => {
    expect(codigos(validateInfluencerSheet(grid()).errors)).toEqual(['MARKER_MISSING']);
  });
});

describe('errores por registro (solo ese registro es inválido)', () => {
  const problemas = (fila: readonly Celda[]) => valida([fila]).records[0]!.problems.map((p) => p.code);

  it.each([
    [['', 'Ana', 'instagram', 'ana', ''], 'ROW_KEY_MISSING'],
    [['INF 001!', 'Ana', 'instagram', 'ana', ''], 'ROW_KEY_INVALID'],
    [['INF-001', '', 'instagram', 'ana', ''], 'ROW_NAME_INVALID'],
    [['INF-001', 'Ana', '', 'ana', ''], 'ROW_PLATFORM_MISSING'],
    [['INF-001', 'Ana', 'myspace', 'ana', ''], 'ROW_PLATFORM_UNSUPPORTED'],
    [['INF-001', 'Ana', 'instagram', '', ''], 'ROW_HANDLE_INVALID'],
    [['INF-001', 'Ana', 'instagram', 'a b', ''], 'ROW_HANDLE_INVALID'],
    [['INF-001', 'Ana', 'instagram', 'https://instagram.com/ana', ''], 'ROW_HANDLE_INVALID'],
    [['INF-001', 'Ana', 'instagram', 'ana/otra', ''], 'ROW_HANDLE_INVALID'],
  ] as const)('%j → %s', (fila, esperado) => {
    expect(problemas(fila)).toContain(esperado);
  });

  it('un registro inválido no impide los demás, y queda marcado', () => {
    const v = valida([
      VALENTINA,
      ['INF-002', 'Roto', 'myspace', 'x', ''],
      ['INF-003', 'Tercero', 'youtube', 'tercero', ''],
    ]);
    expect(v.status).toBe('valid');
    expect(v.records.map((r) => [r.sourceKey, r.problems.length === 0])).toEqual([
      ['INF-001', true],
      ['INF-002', false],
      ['INF-003', true],
    ]);
  });

  it('una fila sin clave es su propio registro y nunca se agrupa con otra', () => {
    const v = valida([
      ['', 'Ana', 'instagram', 'ana', ''],
      ['', 'Ana', 'tiktok', 'ana', ''],
    ]);
    expect(v.records.map((r) => r.sourceKey)).toEqual(['__FILA_3', '__FILA_4']);
  });

  it('celda con error de la hoja en una columna requerida', () => {
    const v = valida([['INF-001', 'Ana', 'instagram', '#REF!', '']]);
    expect(v.records[0]!.problems.length).toBeGreaterThan(0);
  });

  it('el mismo handle bajo claves distintas invalida AMBOS registros', () => {
    const v = valida([
      ['INF-001', 'Ana', 'instagram', '@ana', ''],
      ['INF-002', 'Ana Otra', 'instagram', 'ANA', ''],
    ]);
    expect(v.records.map((r) => r.problems.map((p) => p.code))).toEqual([
      ['ACCOUNT_IN_TWO_KEYS'],
      ['ACCOUNT_IN_TWO_KEYS'],
    ]);
  });
});

describe('identidad estable: la clave agrupa, el nombre NO', () => {
  it('varias filas con la misma clave son UNA persona con varias cuentas', () => {
    const v = valida([
      ['INF-001', 'Valentina Rojas', 'instagram', 'valentina.rojas', 'P80'],
      ['INF-001', 'Valentina Rojas', 'tiktok', 'valerojas', 'P80 Pro'],
    ]);
    expect(v.records).toHaveLength(1);
    expect(v.records[0]).toMatchObject({ rows: [3, 4], problems: [] });
    expect(v.records[0]!.accounts.map((a) => a.platform)).toEqual(['instagram', 'tiktok']);
    expect(v.records[0]!.products.map((p) => p.normalizedRef)).toEqual(['p80', 'p80 pro']);
    expect(v.records[0]!.locators).toHaveLength(2);
  });

  it('dos personas con el MISMO nombre y claves distintas son dos registros (no se fusionan)', () => {
    const v = valida([
      ['INF-001', 'María García', 'instagram', 'maria.g', ''],
      ['INF-002', 'María García', 'instagram', 'mariagarcia2', ''],
    ]);
    expect(v.records.map((r) => r.sourceKey)).toEqual(['INF-001', 'INF-002']);
    expect(v.records.every((r) => r.problems.length === 0)).toBe(true);
  });

  it('la misma clave con nombres distintos es inconsistente (una clave = una persona)', () => {
    const v = valida([
      ['INF-001', 'Ana Ruiz', 'instagram', 'ana', ''],
      ['INF-001', 'Luisa Pérez', 'tiktok', 'luisa', ''],
    ]);
    expect(v.records[0]!.problems.map((p) => p.code)).toContain('KEY_NAME_INCONSISTENT');
  });

  it('la misma cuenta dos veces bajo la misma clave es un duplicado', () => {
    const v = valida([
      ['INF-001', 'Ana', 'instagram', 'ana', ''],
      ['INF-001', 'Ana', 'instagram', '@ANA', ''],
    ]);
    expect(v.records[0]!.problems.map((p) => p.code)).toContain('ACCOUNT_DUPLICATE_IN_KEY');
  });

  it('la clave se compara sin distinguir mayúsculas', () => {
    const v = valida([
      ['inf-001', 'Ana', 'instagram', 'ana', ''],
      ['INF-001', 'Ana', 'tiktok', 'ana2', ''],
    ]);
    expect(v.records).toHaveLength(1);
    expect(v.records[0]!.sourceKey).toBe('INF-001');
  });

  it('la huella no depende de la fila ni del orden de las cuentas', () => {
    const a = valida([
      ['INF-001', 'Ana', 'instagram', 'ana', 'P80'],
      ['INF-001', 'Ana', 'tiktok', 'ana2', 'P80'],
    ]).records[0]!;
    const b = valida([
      ['INF-009', 'Otro', 'x', 'otro', ''],
      ['INF-001', 'Ana', 'tiktok', 'ana2', 'P80'],
      ['INF-001', 'Ana', 'instagram', 'ana', 'P80'],
    ]).records.find((r) => r.sourceKey === 'INF-001')!;
    expect(a.fingerprint).toEqual(b.fingerprint);
    expect(a.rows).not.toEqual(b.rows);
  });
});

describe('columnas futuras y desconocidas', () => {
  const CON_FUTURAS = [
    ...CABECERAS,
    'entregables',
    'tipo_acuerdo',
    'fee',
    'canje',
    'fecha_inicio',
    'fecha_fin',
    'kpi_objetivo',
    'condiciones',
  ];

  it('se validan y se CONSERVAN, sin convertirse en nada más', () => {
    const v = valida(
      [
        [
          ...VALENTINA,
          '2 reels',
          'Mixto',
          1500000,
          'Equipo P80',
          { fecha: '2026-11-01' },
          { fecha: '2026-12-01' },
          '50.000 views',
          'Sin exclusividad',
        ],
      ],
      { cabeceras: CON_FUTURAS },
    );
    expect(v.status).toBe('valid');
    const r = v.records[0]!;
    expect(r.problems).toEqual([]);
    expect(r.futureValues.map((f) => f.column).sort()).toEqual(
      [
        'canje',
        'condiciones',
        'entregables',
        'fecha_fin',
        'fecha_inicio',
        'fee',
        'kpi_objetivo',
        'tipo_acuerdo',
      ].sort(),
    );
    expect(r.futureValues.find((f) => f.column === 'fee')).toMatchObject({ text: '1500000', row: 3 });
    // Los futuros forman parte de la huella (un cambio de fee es un cambio).
    expect(r.fingerprint.future).toContain('1500000');
  });

  it.each([
    ['tipo_acuerdo', 'regalo'],
    ['fee', 'mucho'],
    ['fecha_inicio', '01/11/2026'],
    ['fecha_inicio', { fecha: '2026-13-45' }],
  ] as const)('%s inválido «%j» invalida el registro', (columna, valor) => {
    const fila: Celda[] = [...VALENTINA, '', '', '', '', '', '', '', ''];
    fila[CABECERAS.length + CON_FUTURAS.slice(CABECERAS.length).indexOf(columna)] = valor as Celda;
    const v = valida([fila], { cabeceras: CON_FUTURAS });
    expect(v.records[0]!.problems.map((p) => p.code)).toContain('FUTURE_FIELD_INVALID');
  });

  it('fecha_fin anterior a fecha_inicio', () => {
    const v = valida(
      [[...VALENTINA, '', '', '', '', { fecha: '2026-12-01' }, { fecha: '2026-11-01' }, '', '']],
      { cabeceras: CON_FUTURAS },
    );
    expect(v.records[0]!.problems.map((p) => p.code)).toContain('FUTURE_FIELD_INVALID');
  });

  it('una columna desconocida es una ADVERTENCIA visible, no un descarte silencioso', () => {
    const v = valida([[...VALENTINA, 'texto libre']], { cabeceras: [...CABECERAS, 'Notas del equipo'] });
    expect(v.status).toBe('valid');
    expect(v.warnings.map((w) => [w.code, w.header])).toEqual([['HEADER_UNKNOWN', 'Notas del equipo']]);
    expect(v.records[0]!.problems).toEqual([]);
  });

  it('datos en una columna sin cabecera se avisan; fila 1 con celdas extra también; pestaña oculta también', () => {
    const v = valida([[...VALENTINA, 'huérfano']], { extraFila1: true, estado: 'hidden' });
    expect(codigos(v.warnings).sort()).toEqual([
      'COLUMN_WITHOUT_HEADER',
      'MARKER_ROW_EXTRA_CELLS',
      'SHEET_HIDDEN',
    ]);
    expect(v.status).toBe('valid');
  });
});

describe('productos', () => {
  it('la referencia se normaliza sin similitud', () => {
    expect(normalizeProductRef('  P80   PRO ')).toBe('p80 pro');
    expect(normalizeProductRef('P80') === normalizeProductRef('P80 Pro')).toBe(false);
  });
});

describe('el informe es determinístico y nunca lanza', () => {
  it('mismas entradas, mismo informe', () => {
    const entrada = grid(pestana([VALENTINA]));
    const a: InfluencerSheetValidation = validateInfluencerSheet(entrada);
    const b = validateInfluencerSheet(entrada);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('filas completamente vacías se ignoran', () => {
    const v = valida([VALENTINA, ['', '', '', '', ''], ['  ', '', '', '', '']]);
    expect(v.records).toHaveLength(1);
  });
});
