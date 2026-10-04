/**
 * Casos de validación del localizador (V2 · Fase 4), compartidos entre la prueba
 * de dominio y la de la base (`source_locator_valido`) para que ambas validaciones
 * no se separen. Datos de prueba: no los usa ningún código de producción.
 */

export const LOCATOR_CASOS_VALIDOS: ReadonlyArray<readonly [string, unknown]> = [
  ['página', { kind: 'page', page: 3 }],
  ['página con sección y línea', { kind: 'page', page: 3, section: 'Intro', line: 12 }],
  ['diapositiva', { kind: 'slide', slide: 8 }],
  ['diapositiva con título', { kind: 'slide', slide: 8, section: 'Ficha técnica' }],
  ['sección', { kind: 'section', section: 'El Reto › Audiencia' }],
  ['sección con línea', { kind: 'section', section: 'El Reto', line: 4 }],
  ['hoja', { kind: 'sheet', sheet: 'Influencers' }],
  ['fila', { kind: 'row', sheet: 'Influencers', row: 14 }],
  ['celda', { kind: 'cell', sheet: 'Producto', cell: 'B7', row: 7, col: 2 }],
  ['celda lejana', { kind: 'cell', sheet: 'S', cell: 'AA100', row: 100, col: 27 }],
  [
    'rango',
    { kind: 'range', sheet: 'Producto', range: 'B7:D9', rowStart: 7, rowEnd: 9, colStart: 2, colEnd: 4 },
  ],
  [
    'rango de una fila',
    { kind: 'range', sheet: 'H', range: 'A14:H14', rowStart: 14, rowEnd: 14, colStart: 1, colEnd: 8 },
  ],
  ['región de imagen', { kind: 'region', x: 0.1, y: 0.2, width: 0.5, height: 0.3 }],
  ['región de página', { kind: 'region', page: 2, x: 0, y: 0, width: 1, height: 1 }],
  ['región de diapositiva', { kind: 'region', slide: 5, x: 0.25, y: 0.25, width: 0.5, height: 0.5 }],
];

export const LOCATOR_CASOS_INVALIDOS: ReadonlyArray<readonly [string, unknown]> = [
  ['no es un objeto', 'page'],
  ['arreglo', []],
  ['null', null],
  ['sin tipo', { page: 3 }],
  ['tipo desconocido', { kind: 'video', second: 3 }],
  ['página 0', { kind: 'page', page: 0 }],
  ['página negativa', { kind: 'page', page: -1 }],
  ['página decimal', { kind: 'page', page: 1.5 }],
  ['página como texto', { kind: 'page', page: '3' }],
  ['clave que no corresponde', { kind: 'page', page: 3, sheet: 'x' }],
  ['diapositiva sin número', { kind: 'slide' }],
  ['sección vacía', { kind: 'section', section: '   ' }],
  ['hoja vacía', { kind: 'sheet', sheet: '' }],
  ['fila sin hoja', { kind: 'row', row: 14 }],
  ['fila 0', { kind: 'row', sheet: 'H', row: 0 }],
  ['fila fuera del máximo de Excel', { kind: 'row', sheet: 'H', row: 1048577 }],
  ['celda incoherente con row/col', { kind: 'cell', sheet: 'H', cell: 'B7', row: 8, col: 2 }],
  ['celda con minúsculas', { kind: 'cell', sheet: 'H', cell: 'b7', row: 7, col: 2 }],
  ['columna fuera del máximo', { kind: 'cell', sheet: 'H', cell: 'XFE1', row: 1, col: 16385 }],
  [
    'rango invertido',
    { kind: 'range', sheet: 'H', range: 'D9:B7', rowStart: 9, rowEnd: 7, colStart: 4, colEnd: 2 },
  ],
  [
    'rango incoherente con sus límites',
    { kind: 'range', sheet: 'H', range: 'A1:A1', rowStart: 7, rowEnd: 9, colStart: 2, colEnd: 4 },
  ],
  ['región fuera de la imagen', { kind: 'region', x: 0.8, y: 0, width: 0.5, height: 0.5 }],
  ['región vacía', { kind: 'region', x: 0, y: 0, width: 0, height: 0.5 }],
  [
    'región de página y diapositiva a la vez',
    { kind: 'region', page: 1, slide: 1, x: 0, y: 0, width: 1, height: 1 },
  ],
  ['coordenada negativa', { kind: 'region', x: -0.1, y: 0, width: 0.5, height: 0.5 }],
];
