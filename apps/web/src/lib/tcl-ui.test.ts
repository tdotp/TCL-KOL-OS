import { describe, expect, it } from 'vitest';
import {
  agruparPorBloque,
  coincideConBusqueda,
  esUuidTcl,
  etiquetaDeComparador,
  etiquetaDeMetrica,
  formatearCumplimiento,
  formatearFecha,
  formatearNumero,
  formatearRango,
  formatearValorDeKpi,
  nombreDeProducto,
  tonoDeEtapa,
  tonoDeGuion,
  tonoDeKpi,
} from './tcl-ui.ts';

describe('esUuidTcl', () => {
  it('acepta UUID y rechaza todo lo demás', () => {
    expect(esUuidTcl('11111111-1111-4111-8111-111111111111')).toBe(true);
    for (const malo of [
      '',
      'abc',
      '1; DROP TABLE',
      undefined,
      null,
      5,
      '11111111-1111-4111-8111-11111111111g',
    ]) {
      expect(esUuidTcl(malo)).toBe(false);
    }
  });
});

describe('formatos', () => {
  it('fecha: ISO con o sin hora, y valores inválidos', () => {
    expect(formatearFecha('2026-10-03')).toBe('3 oct 2026');
    expect(formatearFecha('2026-01-15T23:59:00.000Z')).toBe('15 ene 2026');
    for (const malo of [null, undefined, '', 'ayer', '2026-13-01']) expect(formatearFecha(malo)).toBe('—');
  });

  it('rango de fechas', () => {
    expect(formatearRango('2026-10-03', '2026-11-03')).toBe('3 oct 2026 – 3 nov 2026');
    expect(formatearRango('2026-10-03', null)).toBe('Desde 3 oct 2026');
    expect(formatearRango(null, '2026-11-03')).toBe('Hasta 3 nov 2026');
    expect(formatearRango(null, null)).toBe('Sin fechas');
  });

  it('números: miles con punto, decimales con coma, nulos con raya', () => {
    expect(formatearNumero(0)).toBe('0');
    expect(formatearNumero(12000)).toBe('12.000');
    expect(formatearNumero(1234567)).toBe('1.234.567');
    expect(formatearNumero(4.5)).toBe('4,5');
    expect(formatearNumero(100)).toBe('100');
    expect(formatearNumero(null)).toBe('—');
    expect(formatearNumero(Number.NaN)).toBe('—');
  });

  it('KPI: unidad, cumplimiento y comparador', () => {
    expect(formatearValorDeKpi(4.5, 'percent')).toBe('4,5 %');
    expect(formatearValorDeKpi(12000, 'count')).toBe('12.000');
    expect(formatearValorDeKpi(null, 'count')).toBe('—');
    expect(formatearCumplimiento(83.4)).toBe('83 %');
    expect(formatearCumplimiento(null)).toBe('—');
    expect(etiquetaDeComparador('gte')).toBe('al menos');
    expect(etiquetaDeComparador('lte')).toBe('como máximo');
    expect(etiquetaDeMetrica('views')).toBe('Vistas');
    expect(etiquetaDeMetrica('lo-que-sea')).toBe('Métrica');
  });
});

describe('textos y tonos', () => {
  it('nombre de producto', () => {
    expect(nombreDeProducto({ marca: 'TCL', modelo: 'P80' })).toBe('TCL P80');
    expect(nombreDeProducto({ marca: null, modelo: 'P80' })).toBe('P80');
    expect(nombreDeProducto({ marca: null, modelo: null })).toBeNull();
    expect(nombreDeProducto(null)).toBeNull();
  });

  it('los tonos no confunden estados', () => {
    expect(tonoDeEtapa('listo')).toBe('ok');
    expect(tonoDeEtapa('pendiente')).toBe('neutro');
    expect(tonoDeGuion('aprobado')).toBe('ok');
    expect(tonoDeGuion('parcial')).toBe('warn');
    expect(tonoDeKpi('por_debajo')).toBe('warn');
    expect(tonoDeKpi('sin_medicion')).toBe('neutro');
  });

  it('búsqueda sin tildes ni mayúsculas, y vacía = todo', () => {
    const c = { nombre: 'Lanzamiento línea P80', mercado: 'Colombia', categoria: null };
    expect(coincideConBusqueda(c, '')).toBe(true);
    expect(coincideConBusqueda(c, 'LINEA')).toBe(true);
    expect(coincideConBusqueda(c, 'colombia')).toBe(true);
    expect(coincideConBusqueda(c, 'mexico')).toBe(false);
  });

  it('agrupa por bloque conservando el orden de aparición', () => {
    const g = agruparPorBloque([
      { bloque: 'b', n: 1 },
      { bloque: 'a', n: 2 },
      { bloque: 'b', n: 3 },
    ]);
    expect(g.map((x) => x.bloque)).toEqual(['b', 'a']);
    expect(g[0]!.campos.map((c) => c.n)).toEqual([1, 3]);
  });
});
