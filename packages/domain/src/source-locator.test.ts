/**
 * V2 · Fase 4 — contrato único de localización de evidencia.
 *
 * Los casos válidos/inválidos viven en `source-locator.fixtures.ts` y se ejecutan
 * también en `packages/db/src/source-locator.test.ts` contra `source_locator_valido()`:
 * si la validación de TypeScript y la de la base se separan, falla una de las dos.
 */

import { describe, expect, it } from 'vitest';
import {
  LOCATOR_CASOS_INVALIDOS as CASOS_INVALIDOS,
  LOCATOR_CASOS_VALIDOS as CASOS_VALIDOS,
} from './source-locator.fixtures';
import {
  celdaA1,
  columnaALetras,
  describirLocalizador,
  esLocalizadorDeHoja,
  letrasAColumna,
  localizadorDeCelda,
  localizadorDeRango,
  localizadorDesdeLegacy,
  rangoA1,
  validarLocalizador,
} from './source-locator';

describe('validarLocalizador', () => {
  it.each(CASOS_VALIDOS)('acepta: %s', (_nombre, valor) => {
    const r = validarLocalizador(valor);
    expect(r.ok, JSON.stringify(valor)).toBe(true);
  });

  it.each(CASOS_INVALIDOS)('rechaza: %s', (_nombre, valor) => {
    const r = validarLocalizador(valor);
    expect(r.ok, JSON.stringify(valor)).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('VALIDATION_FAILED');
  });

  it('es serializable: sobrevive a JSON sin pérdida', () => {
    for (const [, valor] of CASOS_VALIDOS) {
      const r = validarLocalizador(JSON.parse(JSON.stringify(valor)));
      expect(r.ok && r.value).toEqual(valor);
    }
  });
});

describe('notación A1', () => {
  it('convierte columnas y celdas en ambos sentidos', () => {
    expect(columnaALetras(1)).toBe('A');
    expect(columnaALetras(26)).toBe('Z');
    expect(columnaALetras(27)).toBe('AA');
    expect(columnaALetras(702)).toBe('ZZ');
    expect(columnaALetras(703)).toBe('AAA');
    expect(columnaALetras(16384)).toBe('XFD');
    for (const col of [1, 2, 26, 27, 52, 53, 702, 703, 16384]) {
      expect(letrasAColumna(columnaALetras(col))).toBe(col);
    }
    expect(celdaA1(7, 2)).toBe('B7');
    expect(rangoA1(7, 2, 9, 4)).toBe('B7:D9');
    expect(letrasAColumna('a')).toBeUndefined();
  });

  it('los constructores producen localizadores válidos', () => {
    expect(validarLocalizador(localizadorDeCelda('Producto', 7, 2)).ok).toBe(true);
    expect(validarLocalizador(localizadorDeRango('Producto', 7, 2, 9, 4)).ok).toBe(true);
    expect(localizadorDeRango('Producto', 7, 2, 9, 4).range).toBe('B7:D9');
  });
});

describe('compatibilidad con las columnas legacy', () => {
  it('page y slide existentes se conservan como localizador', () => {
    expect(localizadorDesdeLegacy({ page: 3 })).toEqual({ kind: 'page', page: 3 });
    expect(localizadorDesdeLegacy({ slide: 8, section: 'Ficha' })).toEqual({
      kind: 'slide',
      slide: 8,
      section: 'Ficha',
    });
    expect(localizadorDesdeLegacy({ section: 'El Reto', linea: 4 })).toEqual({
      kind: 'section',
      section: 'El Reto',
      line: 4,
    });
  });

  it('precedencia: diapositiva > página > sección; sin ubicación = undefined', () => {
    expect(localizadorDesdeLegacy({ slide: 2, page: 5, section: 'x' })?.kind).toBe('slide');
    expect(localizadorDesdeLegacy({ page: 5, section: 'x' })?.kind).toBe('page');
    expect(localizadorDesdeLegacy({})).toBeUndefined();
    expect(localizadorDesdeLegacy({ section: '   ' })).toBeUndefined();
  });

  it('todo localizador derivado es válido', () => {
    for (const legacy of [{ page: 1 }, { slide: 1, section: 'T' }, { section: 'S', linea: 9 }]) {
      const l = localizadorDesdeLegacy(legacy);
      expect(l && validarLocalizador(l).ok).toBe(true);
    }
  });
});

describe('descripción legible', () => {
  it('cita cada tipo en español', () => {
    expect(describirLocalizador({ kind: 'page', page: 3 })).toBe('página 3');
    expect(describirLocalizador({ kind: 'slide', slide: 8 })).toBe('diapositiva 8');
    expect(describirLocalizador({ kind: 'section', section: 'El Reto', line: 4 })).toBe(
      'sección «El Reto», línea 4',
    );
    expect(describirLocalizador({ kind: 'row', sheet: 'Influencers', row: 14 })).toBe(
      'hoja «Influencers», fila 14',
    );
    expect(describirLocalizador(localizadorDeRango('Producto', 7, 2, 9, 4))).toBe(
      'hoja «Producto», rango B7:D9',
    );
    expect(describirLocalizador(localizadorDeCelda('Producto', 7, 2))).toBe('hoja «Producto», celda B7');
    expect(describirLocalizador({ kind: 'region', slide: 5, x: 0, y: 0, width: 1, height: 1 })).toContain(
      'diapositiva 5',
    );
  });

  it('distingue las ubicaciones de hoja de cálculo', () => {
    expect(esLocalizadorDeHoja({ kind: 'sheet', sheet: 'H' })).toBe(true);
    expect(esLocalizadorDeHoja({ kind: 'page', page: 1 })).toBe(false);
  });
});
