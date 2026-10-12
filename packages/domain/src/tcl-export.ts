/**
 * Export de la proyección TCL (V2 · Fase 9, DEC-050). Serializadores PUROS: no consultan nada.
 *
 * Reciben la MISMA `ProyeccionTclDeCampana` que muestra la interfaz y la serializan; no existe un camino de
 * export que lea tablas ni que añada columnas por su cuenta (paridad interfaz–export: EXPORT ⊆ UI).
 *
 *   · JSON: la proyección tal cual (mismas claves y estructura que el DTO).
 *   · CSV: una tabla plana con una columna estructural `seccion` (campana | influencer | contenido | operacion |
 *     kpi | brief | documento) y, para el resto, SOLO claves de los DTO (`COLUMNAS_CSV_TCL`, verificado por
 *     pruebas contra `CLAVES_DE_DTO_TCL`). Los campos compuestos (cuentas, productos, items) se unen con « | ».
 *     BOM UTF-8, saltos CRLF y neutralización de fórmulas (`= + - @ \t \r`, también en su forma de ancho completo)
 *     en TODA celda de texto: se antepone una comilla simple.
 */

import {
  type BriefCampoTcl,
  type ProductoTcl,
  type ProyeccionTclDeCampana,
  CLAVES_DE_DTO_TCL,
  asegurarProyeccionTcl,
} from './tcl-projection';

export const FORMATOS_DE_EXPORT_TCL = ['csv', 'json'] as const;
export type FormatoDeExportTcl = (typeof FORMATOS_DE_EXPORT_TCL)[number];

export function esFormatoDeExportTcl(valor: unknown): valor is FormatoDeExportTcl {
  return typeof valor === 'string' && (FORMATOS_DE_EXPORT_TCL as readonly string[]).includes(valor);
}

/** `seccion` es el único nombre que no es clave de un DTO: discrimina el tipo de fila de la tabla plana. */
export const COLUMNAS_CSV_TCL = [
  'seccion',
  'id',
  'participacionId',
  'sourceId',
  'nombre',
  'nombreVisible',
  'mercado',
  'categoria',
  'fechaInicio',
  'fechaFin',
  'estado',
  'influencersActivos',
  'guionesAprobados',
  'guionesTotales',
  'kpiCumplidos',
  'kpiTotales',
  'cuentas',
  'productos',
  'producto',
  'etapa',
  'productoRecibido',
  'guion',
  'aprobados',
  'total',
  'produccion',
  'publicacion',
  'etiqueta',
  'plataforma',
  'aprobadoEl',
  'metrica',
  'unidad',
  'comparador',
  'objetivo',
  'resultado',
  'cumplimiento',
  'fecha',
  'version',
  'idioma',
  'clave',
  'bloque',
  'texto',
  'items',
  'titulo',
  'tipo',
] as const;

export type ColumnaCsvTcl = (typeof COLUMNAS_CSV_TCL)[number];

export type FilaDeExportTcl = Partial<Record<ColumnaCsvTcl, string | number | null>>;

/** Todas las claves de DTO conocidas (para verificar que las columnas del CSV no inventan nombres). */
export function clavesDeDtoConocidasParaTcl(): ReadonlySet<string> {
  return new Set(Object.values(CLAVES_DE_DTO_TCL).flat());
}

const SEPARADOR = ' | ';

function nombreDeProducto(
  p: ProductoTcl | { marca: string | null; modelo: string | null } | null,
): string | null {
  if (p === null) return null;
  const partes = [p.marca, p.modelo].filter((x): x is string => x !== null);
  return partes.length === 0 ? null : partes.join(' ');
}

function unir(valores: readonly (string | null)[]): string | null {
  const l = valores.filter((v): v is string => v !== null);
  return l.length === 0 ? null : l.join(SEPARADOR);
}

function filaDeBrief(
  b: NonNullable<ProyeccionTclDeCampana['brief']>,
  idioma: string,
  c: BriefCampoTcl,
): FilaDeExportTcl {
  return {
    seccion: 'brief',
    version: b.version,
    aprobadoEl: b.aprobadoEl,
    idioma,
    clave: c.clave,
    etiqueta: c.etiqueta,
    bloque: c.bloque,
    producto: nombreDeProducto(c.producto),
    texto: c.texto,
    items: c.items === null ? null : c.items.join(SEPARADOR),
  };
}

/** Filas de la tabla plana, derivadas SOLO de la proyección (nunca de otra fuente). */
export function filasDeExportTcl(p: ProyeccionTclDeCampana): FilaDeExportTcl[] {
  const filas: FilaDeExportTcl[] = [];
  const c = p.campana;
  filas.push({
    seccion: 'campana',
    id: c.id,
    nombre: c.nombre,
    mercado: c.mercado,
    categoria: c.categoria,
    fechaInicio: c.fechaInicio,
    fechaFin: c.fechaFin,
    estado: c.estado,
    influencersActivos: c.conteos.influencersActivos,
    guionesAprobados: c.conteos.guionesAprobados,
    guionesTotales: c.conteos.guionesTotales,
    kpiCumplidos: c.conteos.kpiCumplidos,
    kpiTotales: c.conteos.kpiTotales,
    productos: unir(c.productos.map(nombreDeProducto)),
  });
  for (const i of p.influencers) {
    filas.push({
      seccion: 'influencer',
      participacionId: i.participacionId,
      nombreVisible: i.nombreVisible,
      cuentas: unir(i.cuentas.map((x) => (x.handle === null ? null : `${x.plataforma}:${x.handle}`))),
      productos: unir(i.productos.map(nombreDeProducto)),
      etapa: i.etapa,
      productoRecibido: i.productoRecibido,
      guion: i.guion.estado,
      aprobados: i.guion.aprobados,
      total: i.guion.total,
    });
  }
  for (const x of p.contenido) {
    filas.push({
      seccion: 'contenido',
      participacionId: x.participacionId,
      id: x.entregable.id,
      etiqueta: x.entregable.etiqueta,
      plataforma: x.entregable.plataforma,
      producto: nombreDeProducto(x.entregable.producto),
      estado: x.estado,
      aprobadoEl: x.aprobadoEl,
    });
  }
  for (const o of p.operacion) {
    filas.push({
      seccion: 'operacion',
      participacionId: o.participacionId,
      nombreVisible: o.nombreVisible,
      etapa: o.etapa,
      productoRecibido: o.productoRecibido,
      guion: o.guion.estado,
      aprobados: o.guion.aprobados,
      total: o.guion.total,
      produccion: o.produccion,
      publicacion: o.publicacion,
    });
  }
  for (const k of p.kpis) {
    for (const x of k.kpis) {
      filas.push({
        seccion: 'kpi',
        participacionId: k.participacionId,
        nombreVisible: k.nombreVisible,
        metrica: x.metrica,
        unidad: x.unidad,
        comparador: x.comparador,
        objetivo: x.objetivo,
        resultado: x.resultado,
        cumplimiento: x.cumplimiento,
        estado: x.estado,
        plataforma: x.plataforma,
        fecha: x.fecha,
      });
    }
  }
  if (p.brief !== null) {
    for (const r of p.brief.representaciones) {
      for (const campo of r.campos) filas.push(filaDeBrief(p.brief, r.idioma, campo));
    }
  }
  for (const d of p.documentos) {
    filas.push({
      seccion: 'documento',
      sourceId: d.sourceId,
      titulo: d.titulo,
      tipo: d.tipo,
      idioma: d.idioma,
      fecha: d.fecha,
    });
  }
  return filas;
}

// ─────────────────────────── CSV ───────────────────────────────────────────────

/** Caracteres que un programa de hojas de cálculo interpreta como inicio de fórmula. */
const INICIOS_DE_FORMULA = new Set(['=', '+', '-', '@', '\t', '\r']);

/**
 * Neutraliza una celda de texto que podría ejecutarse como fórmula: si empieza (también tras espacios, y en su
 * forma de ancho completo) por `= + - @ \t \r`, se antepone `'`. No toca números.
 */
export function neutralizarFormulaCsv(valor: string): string {
  const sinEspacios = valor.replace(/^[ \u00A0]+/u, '');
  const primero = sinEspacios === '' ? '' : sinEspacios.normalize('NFKC').charAt(0);
  return INICIOS_DE_FORMULA.has(primero) || INICIOS_DE_FORMULA.has(valor.charAt(0)) ? `'${valor}` : valor;
}

function celdaCsv(valor: string | number | null | undefined): string {
  if (valor === null || valor === undefined) return '';
  const texto =
    typeof valor === 'number' ? (Number.isFinite(valor) ? String(valor) : '') : neutralizarFormulaCsv(valor);
  return /[",\r\n]/u.test(texto) ? `"${texto.replace(/"/gu, '""')}"` : texto;
}

const BOM = '\uFEFF';

export function serializarCsvTcl(filas: readonly FilaDeExportTcl[]): string {
  const lineas = [COLUMNAS_CSV_TCL.join(',')];
  for (const f of filas) lineas.push(COLUMNAS_CSV_TCL.map((col) => celdaCsv(f[col])).join(','));
  return `${BOM}${lineas.join('\r\n')}\r\n`;
}

// ─────────────────────────── Serialización ─────────────────────────────────────

export interface ExportDeTcl {
  readonly formato: FormatoDeExportTcl;
  readonly contentType: string;
  readonly extension: 'csv' | 'json';
  readonly contenido: string;
}

/** Serializa la proyección. Verifica antes que ninguna clave de la salida sea prohibida. */
export function serializarExportTcl(p: ProyeccionTclDeCampana, formato: FormatoDeExportTcl): ExportDeTcl {
  asegurarProyeccionTcl(p);
  if (formato === 'json') {
    return {
      formato,
      contentType: 'application/json; charset=utf-8',
      extension: 'json',
      contenido: `${JSON.stringify(p, null, 2)}\n`,
    };
  }
  return {
    formato,
    contentType: 'text/csv; charset=utf-8',
    extension: 'csv',
    contenido: serializarCsvTcl(filasDeExportTcl(p)),
  };
}

/**
 * Nombre de archivo SANEADO para `Content-Disposition`: solo `a-z0-9-` (sin acentos, sin comillas, sin saltos
 * de línea ni separadores de ruta), con la fecha del export. Nunca se usa el nombre de la campaña tal cual.
 */
export function nombreDeArchivoDeExportTcl(
  nombreDeCampana: string | null,
  formato: FormatoDeExportTcl,
  fecha: Date,
): string {
  const slug = (nombreDeCampana ?? '')
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 40)
    .replace(/-+$/u, '');
  const dia = Number.isNaN(fecha.getTime()) ? '' : fecha.toISOString().slice(0, 10).replace(/-/gu, '');
  return `tcl-${slug === '' ? 'campana' : slug}${dia === '' ? '' : `-${dia}`}.${formato}`;
}
