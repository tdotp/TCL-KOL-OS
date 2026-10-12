import { describe, expect, it } from 'vitest';
import {
  COLUMNAS_CSV_TCL,
  clavesDeDtoConocidasParaTcl,
  esFormatoDeExportTcl,
  filasDeExportTcl,
  neutralizarFormulaCsv,
  nombreDeArchivoDeExportTcl,
  serializarCsvTcl,
  serializarExportTcl,
} from './tcl-export';
import { type ProyeccionTclDeCampana, CLAVES_DE_DTO_TCL } from './tcl-projection';
import { clavesProhibidasEn } from './tcl-projection-operacion';

const PROYECCION: ProyeccionTclDeCampana = {
  campana: {
    id: 'c1',
    nombre: 'Lanzamiento P80',
    mercado: 'CO',
    categoria: 'Smartphones',
    fechaInicio: '2026-11-01',
    fechaFin: null,
    estado: 'en_curso',
    conteos: {
      influencersActivos: 2,
      guionesAprobados: 1,
      guionesTotales: 2,
      kpiCumplidos: 0,
      kpiTotales: 1,
    },
    productos: [{ marca: 'TCL', modelo: 'P80', categoria: 'Smartphone' }],
  },
  influencers: [
    {
      participacionId: 'p1',
      nombreVisible: '=HYPERLINK("http://malo","clic")',
      cuentas: [{ plataforma: 'instagram', handle: 'valentina.rios' }],
      productos: [{ marca: 'TCL', modelo: 'P80', categoria: 'Smartphone' }],
      etapa: 'en_curso',
      productoRecibido: 'si',
      guion: { estado: 'parcial', aprobados: 1, total: 2 },
      kpis: [],
    },
  ],
  contenido: [
    {
      participacionId: 'p1',
      entregable: { id: 'e1', etiqueta: '-Reel, "principal"', plataforma: 'instagram', producto: null },
      estado: 'aprobado',
      aprobadoEl: '2026-10-05T12:00:00.000Z',
    },
  ],
  brief: {
    version: 2,
    aprobadoEl: '2026-10-05T12:00:00.000Z',
    idiomaOriginal: 'es',
    representaciones: [
      {
        idioma: 'es',
        campos: [
          {
            clave: 'practico.restricciones',
            etiqueta: 'Restricciones',
            bloque: 'practico',
            producto: null,
            texto: null,
            items: ['@alguien', 'No comparar'],
          },
        ],
      },
    ],
  },
  operacion: [
    {
      participacionId: 'p1',
      nombreVisible: 'Valentina',
      etapa: 'en_curso',
      productoRecibido: 'si',
      guion: { estado: 'parcial', aprobados: 1, total: 2 },
      produccion: 'no_disponible',
      publicacion: 'no_disponible',
    },
  ],
  kpis: [
    {
      participacionId: 'p1',
      nombreVisible: 'Valentina',
      kpis: [
        {
          metrica: 'views',
          unidad: 'count',
          comparador: 'gte',
          objetivo: 100000,
          resultado: 85000,
          cumplimiento: 85,
          estado: 'por_debajo',
          plataforma: 'instagram',
          fecha: '2026-10-05',
        },
      ],
    },
  ],
  documentos: [
    { sourceId: 's1', titulo: '+ficha.pdf', tipo: 'ficha_tecnica', idioma: 'es', fecha: '2026-10-01' },
  ],
};

describe('columnas del CSV ⊆ claves de los DTO', () => {
  it('toda columna (salvo el discriminador `seccion`) es clave de algún DTO', () => {
    const conocidas = clavesDeDtoConocidasParaTcl();
    const ajenas = COLUMNAS_CSV_TCL.filter((c) => c !== 'seccion' && !conocidas.has(c));
    expect(ajenas).toEqual([]);
    expect(Object.values(CLAVES_DE_DTO_TCL).flat()).toEqual(expect.arrayContaining(['sourceId', 'texto']));
  });
  it('ninguna columna es una clave prohibida', () => {
    expect(clavesProhibidasEn(Object.fromEntries(COLUMNAS_CSV_TCL.map((c) => [c, 1])))).toEqual([]);
  });
  it('las filas solo usan columnas declaradas', () => {
    const permitidas = new Set<string>(COLUMNAS_CSV_TCL);
    for (const fila of filasDeExportTcl(PROYECCION)) {
      for (const k of Object.keys(fila)) expect(permitidas.has(k), k).toBe(true);
    }
  });
});

describe('neutralización de fórmulas', () => {
  it('antepone comilla a = + - @ tab y retorno de carro (también tras espacios y en ancho completo)', () => {
    for (const v of [
      '=1+1',
      '+57300',
      '-5',
      '@SUM(A1)',
      '\tx',
      '\rx',
      '  =1+1',
      '＝1+1',
      '＋1',
      '－1',
      '＠x',
    ]) {
      expect(neutralizarFormulaCsv(v), JSON.stringify(v)).toBe(`'${v}`);
    }
  });
  it('no toca texto normal', () => {
    for (const v of ['Hola', '2026-10-11', 'a=b', 'x+y', '', 'Reel principal']) {
      expect(neutralizarFormulaCsv(v)).toBe(v);
    }
  });
});

describe('CSV', () => {
  const csv = serializarExportTcl(PROYECCION, 'csv');
  it('BOM UTF-8, CRLF, content-type y extensión', () => {
    expect(csv.contenido.startsWith('\uFEFF')).toBe(true);
    expect(csv.contenido).toContain('\r\n');
    expect(csv.contentType).toBe('text/csv; charset=utf-8');
    expect(csv.extension).toBe('csv');
  });
  it('encabezado = columnas declaradas', () => {
    expect(csv.contenido.slice(1).split('\r\n')[0]).toBe(COLUMNAS_CSV_TCL.join(','));
  });
  it('ninguna celda de texto empieza por un carácter de fórmula sin neutralizar', () => {
    const lineas = csv.contenido.slice(1).split('\r\n');
    expect(lineas.join('\n')).toContain(`'=HYPERLINK`);
    expect(lineas.join('\n')).toContain(`'@alguien`);
    expect(lineas.join('\n')).toContain(`'+ficha.pdf`);
    // la celda con comas y comillas queda entre comillas y escapada
    expect(csv.contenido).toContain(`"'-Reel, ""principal"""`);
    // los números NO se neutralizan
    expect(csv.contenido).toContain('100000');
  });
  it('una fila por elemento de cada sección', () => {
    const filas = filasDeExportTcl(PROYECCION);
    const por = (s: string) => filas.filter((f) => f.seccion === s).length;
    expect([por('campana'), por('influencer'), por('contenido'), por('operacion'), por('kpi')]).toEqual([
      1, 1, 1, 1, 1,
    ]);
    expect([por('brief'), por('documento')]).toEqual([1, 1]);
  });
  it('un brief ausente no genera filas', () => {
    expect(filasDeExportTcl({ ...PROYECCION, brief: null }).filter((f) => f.seccion === 'brief')).toEqual([]);
  });
  it('serializarCsvTcl es determinista', () => {
    expect(serializarCsvTcl(filasDeExportTcl(PROYECCION))).toBe(csv.contenido);
  });
});

describe('JSON', () => {
  it('es la proyección tal cual (mismas claves y valores)', () => {
    const json = serializarExportTcl(PROYECCION, 'json');
    expect(json.contentType).toBe('application/json; charset=utf-8');
    expect(JSON.parse(json.contenido)).toEqual(PROYECCION);
  });
  it('se niega a serializar una proyección con claves prohibidas', () => {
    const sucia = { ...PROYECCION, fee: 1 } as unknown as ProyeccionTclDeCampana;
    expect(() => serializarExportTcl(sucia, 'json')).toThrow(/prohibidas/u);
    expect(() => serializarExportTcl(sucia, 'csv')).toThrow(/prohibidas/u);
  });
});

describe('formato y nombre de archivo', () => {
  it('formatos válidos', () => {
    expect(esFormatoDeExportTcl('csv')).toBe(true);
    expect(esFormatoDeExportTcl('json')).toBe(true);
    for (const f of ['xlsx', 'CSV', '', null, undefined, 1]) expect(esFormatoDeExportTcl(f)).toBe(false);
  });
  it('el nombre se sanea: solo a-z, 0-9 y guiones; sin comillas, saltos ni rutas', () => {
    const fecha = new Date('2026-10-11T12:00:00Z');
    expect(nombreDeArchivoDeExportTcl('Lanzamiento P80 «Ultra»', 'csv', fecha)).toBe(
      'tcl-lanzamiento-p80-ultra-20261011.csv',
    );
    const raro = nombreDeArchivoDeExportTcl('../../etc/passwd"\r\nX: y', 'json', fecha);
    expect(raro).toMatch(/^[a-z0-9-]+\.json$/u);
    expect(raro).not.toMatch(/[/\\"\r\n]/u);
    expect(nombreDeArchivoDeExportTcl(null, 'csv', fecha)).toBe('tcl-campana-20261011.csv');
    expect(nombreDeArchivoDeExportTcl('x'.repeat(200), 'csv', fecha).length).toBeLessThan(60);
  });
});
