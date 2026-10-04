/**
 * V2 · Fase 4 — validación de archivos: hojas de cálculo.
 *
 * Los ZIP de prueba se construyen a mano (método «stored», sin comprimir): el
 * validador solo lee el directorio central, así que se pueden declarar tamaños
 * descomprimidos arbitrarios sin reservar memoria.
 */

import { describe, expect, it } from 'vitest';
import {
  MIME_CSV,
  MIME_DOCX,
  MIME_PPTX,
  MIME_XLSX,
  XLSX_MAX_BYTES_DESCOMPRIMIDOS,
  XLSX_MAX_ENTRADAS,
  detectarTipo,
  esHojaDeCalculo,
  listarEntradasZip,
  validarArchivo,
} from './file-validation';

interface EntradaDePrueba {
  readonly nombre: string;
  readonly datos?: Uint8Array;
  /** Tamaño descomprimido DECLARADO en el directorio central (puede mentir). */
  readonly declarado?: number;
  readonly comprimido?: number;
}

function zip(entradas: readonly EntradaDePrueba[]): Uint8Array {
  const partes: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let desplazamiento = 0;
  const enc = new TextEncoder();
  for (const e of entradas) {
    const nombre = enc.encode(e.nombre);
    const datos = e.datos ?? new Uint8Array(0);
    const local = new Uint8Array(30 + nombre.length);
    const v = new DataView(local.buffer);
    v.setUint32(0, 0x04034b50, true);
    v.setUint16(4, 20, true);
    v.setUint32(18, datos.length, true);
    v.setUint32(22, datos.length, true);
    v.setUint16(26, nombre.length, true);
    local.set(nombre, 30);
    partes.push(local, datos);

    const cd = new Uint8Array(46 + nombre.length);
    const c = new DataView(cd.buffer);
    c.setUint32(0, 0x02014b50, true);
    c.setUint16(4, 20, true);
    c.setUint16(6, 20, true);
    c.setUint32(20, e.comprimido ?? datos.length, true);
    c.setUint32(24, e.declarado ?? datos.length, true);
    c.setUint16(28, nombre.length, true);
    c.setUint32(42, desplazamiento, true);
    cd.set(nombre, 46);
    central.push(cd);
    desplazamiento += local.length + datos.length;
  }
  const tamanoCentral = central.reduce((n, p) => n + p.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, entradas.length, true);
  ev.setUint16(10, entradas.length, true);
  ev.setUint32(12, tamanoCentral, true);
  ev.setUint32(16, desplazamiento, true);
  const todo = [...partes, ...central, eocd];
  const salida = new Uint8Array(todo.reduce((n, p) => n + p.length, 0));
  let pos = 0;
  for (const p of todo) {
    salida.set(p, pos);
    pos += p.length;
  }
  return salida;
}

const BASE_XLSX: EntradaDePrueba[] = [
  { nombre: '[Content_Types].xml', datos: new TextEncoder().encode('<Types/>') },
  { nombre: 'xl/workbook.xml', datos: new TextEncoder().encode('<workbook/>') },
];
const MAX = 50 * 1024 * 1024;

describe('listarEntradasZip', () => {
  it('lee el directorio central sin descomprimir', () => {
    const entradas = listarEntradasZip(zip(BASE_XLSX));
    expect(entradas?.map((e) => e.nombre)).toEqual(['[Content_Types].xml', 'xl/workbook.xml']);
  });

  it('devuelve undefined si no es un ZIP legible', () => {
    expect(
      listarEntradasZip(new TextEncoder().encode('no es un zip, solo texto largo suficiente')),
    ).toBeUndefined();
    expect(listarEntradasZip(new Uint8Array(10))).toBeUndefined();
  });
});

describe('detección de formatos OOXML', () => {
  it('distingue XLSX, PPTX y DOCX por los nombres del directorio central', () => {
    expect(detectarTipo(zip(BASE_XLSX), 'a.xlsx')).toBe(MIME_XLSX);
    expect(detectarTipo(zip([{ nombre: 'ppt/presentation.xml' }]), 'a.pptx')).toBe(MIME_PPTX);
    expect(detectarTipo(zip([{ nombre: 'word/document.xml' }]), 'a.docx')).toBe(MIME_DOCX);
  });

  it('un XLSX cuyas partes aparecen tras muchos bytes de datos sigue reconociéndose', () => {
    // Antes se buscaba solo en los primeros 8 KB; ahora se lee el directorio central.
    const relleno = new Uint8Array(20_000).fill(7);
    const grande = zip([{ nombre: 'relleno.bin', datos: relleno }, ...BASE_XLSX]);
    expect(detectarTipo(grande, 'libro.xlsx')).toBe(MIME_XLSX);
  });

  it('un CSV se reconoce por contenido de texto y extensión; sin extensión no', () => {
    const csv = new TextEncoder().encode('nombre,producto\nValentina,C7K\n');
    expect(detectarTipo(csv, 'datos.csv')).toBe(MIME_CSV);
    expect(detectarTipo(csv, 'datos')).toBeUndefined();
    expect(detectarTipo(csv, 'datos.exe')).toBeUndefined();
    expect(esHojaDeCalculo(MIME_CSV) && esHojaDeCalculo(MIME_XLSX) && !esHojaDeCalculo(MIME_DOCX)).toBe(true);
  });
});

describe('validarArchivo — XLSX', () => {
  it('acepta un libro válido', () => {
    const r = validarArchivo(zip(BASE_XLSX), 100, MAX, MIME_XLSX, 'libro.xlsx');
    expect(r).toMatchObject({ valido: true, mimeType: MIME_XLSX });
  });

  it('rechaza un libro con macros', () => {
    const r = validarArchivo(
      zip([...BASE_XLSX, { nombre: 'xl/vbaProject.bin' }]),
      100,
      MAX,
      undefined,
      'm.xlsx',
    );
    expect(r).toMatchObject({ valido: false, codigo: 'INVALID_SPREADSHEET' });
    expect(r.motivo).toContain('macros');
  });

  it('rechaza un ZIP que imita un XLSX sin su estructura mínima', () => {
    const r = validarArchivo(zip([{ nombre: 'xl/hoja.xml' }]), 100, MAX, undefined, 'x.xlsx');
    expect(r).toMatchObject({ valido: false, codigo: 'INVALID_SPREADSHEET' });
  });

  it('rechaza una ZIP bomb por razón de compresión y por tamaño descomprimido total', () => {
    const razon = zip([
      ...BASE_XLSX,
      {
        nombre: 'xl/worksheets/sheet1.xml',
        datos: new Uint8Array(100),
        declarado: 60 * 1024 * 1024,
        comprimido: 100,
      },
    ]);
    expect(validarArchivo(razon, 100, MAX, undefined, 'b.xlsx')).toMatchObject({
      valido: false,
      codigo: 'INVALID_SPREADSHEET',
    });
    const tamano = zip([
      ...BASE_XLSX,
      {
        nombre: 'xl/worksheets/sheet1.xml',
        declarado: XLSX_MAX_BYTES_DESCOMPRIMIDOS + 1,
        comprimido: XLSX_MAX_BYTES_DESCOMPRIMIDOS / 10,
      },
    ]);
    const r = validarArchivo(tamano, 100, MAX, undefined, 'b.xlsx');
    expect(r.valido).toBe(false);
    expect(r.motivo).toContain('descomprimirse');
  });

  it('rechaza rutas internas peligrosas y demasiadas entradas', () => {
    expect(
      validarArchivo(zip([...BASE_XLSX, { nombre: 'xl/../../evil' }]), 100, MAX, undefined, 'p.xlsx').valido,
    ).toBe(false);
    expect(
      validarArchivo(zip([...BASE_XLSX, { nombre: '/etc/passwd' }]), 100, MAX, undefined, 'p.xlsx').valido,
    ).toBe(false);
    const muchas = zip([
      ...BASE_XLSX,
      ...Array.from({ length: XLSX_MAX_ENTRADAS }, (_, i) => ({ nombre: `xl/e${i}.xml` })),
    ]);
    expect(validarArchivo(muchas, 100, MAX, undefined, 'p.xlsx').valido).toBe(false);
  });

  it('el límite de tamaño de carga se aplica igual que a cualquier archivo', () => {
    const r = validarArchivo(zip(BASE_XLSX), 60 * 1024 * 1024, MAX, undefined, 'grande.xlsx');
    expect(r.valido).toBe(false);
    expect(r.motivo).toContain('límite');
  });
});

describe('validarArchivo — formatos no soportados', () => {
  it('un .xls binario (OLE) se rechaza explícitamente con un código propio', () => {
    const ole = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, ...new Array(200).fill(0)]);
    const r = validarArchivo(ole, ole.length, MAX, undefined, 'viejo.xls');
    expect(r).toMatchObject({ valido: false, codigo: 'UNSUPPORTED_SOURCE_FORMAT' });
    expect(r.motivo).toContain('.xlsx');
  });

  it('un archivo renombrado a .xlsx que no es un ZIP se rechaza por contenido', () => {
    const texto = new TextEncoder().encode('#!/bin/sh\nrm -rf /\n');
    expect(validarArchivo(texto, texto.length, MAX, MIME_XLSX, 'falso.xlsx').valido).toBe(false);
  });
});
