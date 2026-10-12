/**
 * Rutas del dashboard TCL y equivalencias de las rutas legadas (V2 · Fase 9). PURO: sin acceso a datos ni a
 * `next/navigation`, para poder probarlo sin servidor.
 *
 * Contrato del cliente TCL: toda ruta legada con equivalente redirige a `/tcl/**`; las que no la tienen
 * (Contenido interno, Operación, Asistente, edición del Brief, detalle de fuentes…) dan el mismo 404 que una
 * ruta inexistente. Ni un redirect ni un 404 ejecutan antes un cargador interno.
 */

import { esUuidTcl } from './tcl-ui.ts';

export const RUTA_TCL = '/tcl';

export type SeccionTcl =
  'resumen' | 'influencers' | 'contenido' | 'operacion' | 'kpi' | 'documentos' | 'brief';

export const SECCIONES_TCL: readonly {
  readonly id: SeccionTcl;
  readonly etiqueta: string;
  readonly ruta: string;
}[] = [
  { id: 'resumen', etiqueta: 'Resumen', ruta: '' },
  { id: 'influencers', etiqueta: 'Influencers', ruta: '/influencers' },
  { id: 'contenido', etiqueta: 'Contenido', ruta: '/contenido' },
  { id: 'operacion', etiqueta: 'Operación', ruta: '/operacion' },
  { id: 'kpi', etiqueta: 'KPI', ruta: '/kpi' },
  { id: 'documentos', etiqueta: 'Documentos', ruta: '/documentos' },
  { id: 'brief', etiqueta: 'Brief', ruta: '/brief' },
];

export function rutaDeCampanaTcl(campaignId: string, seccion: SeccionTcl = 'resumen'): string {
  const s = SECCIONES_TCL.find((x) => x.id === seccion);
  return `${RUTA_TCL}/campanas/${campaignId}${s?.ruta ?? ''}`;
}

export function rutaDeExportTcl(campaignId: string, formato: 'csv' | 'json'): string {
  return `/api/tcl/campanas/${campaignId}/export?formato=${formato}`;
}

/** Qué ruta legada se está abriendo. `redirige` = tiene equivalente en `/tcl`; `oculta` = no lo tiene (404). */
export type RutaLegada =
  | { readonly tipo: 'lista' }
  | { readonly tipo: 'detalle'; readonly id: string }
  | { readonly tipo: 'brief'; readonly id: string }
  | { readonly tipo: 'fuentes'; readonly id: string }
  | { readonly tipo: 'oculta' };

/** Destino de la redirección del cliente, o `null` si la ruta debe dar 404. */
export function destinoTclDeRutaLegada(ruta: RutaLegada): string | null {
  switch (ruta.tipo) {
    case 'lista':
      return RUTA_TCL;
    case 'detalle':
      return esUuidTcl(ruta.id) ? rutaDeCampanaTcl(ruta.id) : null;
    case 'brief':
      return esUuidTcl(ruta.id) ? rutaDeCampanaTcl(ruta.id, 'brief') : null;
    case 'fuentes':
      return esUuidTcl(ruta.id) ? rutaDeCampanaTcl(ruta.id, 'documentos') : null;
    case 'oculta':
      return null;
  }
}

/** Nombre de archivo para `Content-Disposition`: solo `A-Za-z0-9._-` (la proyección ya lo sanea; aquí se reafirma). */
export function nombreDeArchivoSeguro(nombre: string): string {
  const limpio = nombre
    .replace(/[^A-Za-z0-9._-]/g, '-')
    .replace(/^\.+/, '')
    .slice(0, 100);
  return limpio === '' ? 'export-tcl' : limpio;
}
