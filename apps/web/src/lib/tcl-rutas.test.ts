import { describe, expect, it } from 'vitest';
import {
  SECCIONES_TCL,
  destinoTclDeRutaLegada,
  nombreDeArchivoSeguro,
  rutaDeCampanaTcl,
  rutaDeExportTcl,
} from './tcl-rutas.ts';

const ID = '11111111-1111-4111-8111-111111111111';

describe('rutas de TCL', () => {
  it('cubre exactamente las secciones de la especificación y no incluye Publicaciones', () => {
    expect(SECCIONES_TCL.map((s) => s.id)).toEqual([
      'resumen',
      'influencers',
      'contenido',
      'operacion',
      'kpi',
      'documentos',
      'brief',
    ]);
    expect(JSON.stringify(SECCIONES_TCL)).not.toMatch(/publicaci/iu);
  });

  it('arma rutas de campaña y de export', () => {
    expect(rutaDeCampanaTcl(ID)).toBe(`/tcl/campanas/${ID}`);
    expect(rutaDeCampanaTcl(ID, 'kpi')).toBe(`/tcl/campanas/${ID}/kpi`);
    expect(rutaDeExportTcl(ID, 'csv')).toBe(`/api/tcl/campanas/${ID}/export?formato=csv`);
  });
});

describe('destinoTclDeRutaLegada', () => {
  it('las rutas con equivalente redirigen; el resto es 404 (null)', () => {
    expect(destinoTclDeRutaLegada({ tipo: 'lista' })).toBe('/tcl');
    expect(destinoTclDeRutaLegada({ tipo: 'detalle', id: ID })).toBe(`/tcl/campanas/${ID}`);
    expect(destinoTclDeRutaLegada({ tipo: 'brief', id: ID })).toBe(`/tcl/campanas/${ID}/brief`);
    expect(destinoTclDeRutaLegada({ tipo: 'fuentes', id: ID })).toBe(`/tcl/campanas/${ID}/documentos`);
    expect(destinoTclDeRutaLegada({ tipo: 'oculta' })).toBeNull();
  });

  it('un id que no es UUID nunca se coloca en una redirección', () => {
    for (const id of ['../../evil', 'x?y=1', '//evil.test', '']) {
      for (const tipo of ['detalle', 'brief', 'fuentes'] as const) {
        expect(destinoTclDeRutaLegada({ tipo, id })).toBeNull();
      }
    }
  });
});

describe('nombreDeArchivoSeguro', () => {
  it('deja solo caracteres seguros y nunca vacío', () => {
    expect(nombreDeArchivoSeguro('tcl-campana-20261003.csv')).toBe('tcl-campana-20261003.csv');
    expect(nombreDeArchivoSeguro('a"b\r\nc/d\\e.csv')).toBe('a-b--c-d-e.csv');
    expect(nombreDeArchivoSeguro('..')).toBe('export-tcl');
    expect(nombreDeArchivoSeguro('')).toBe('export-tcl');
  });
});
