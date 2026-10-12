/**
 * Etiquetas y formatos PUROS del dashboard TCL (V2 · Fase 9). Sin acceso a datos: solo traduce los valores ya
 * proyectados (DTO de `@tcl-kol-os/domain`) a texto legible. Todo estado se expresa con TEXTO, no solo con color.
 */

import type {
  EstadoDeCampanaParaTcl,
  EstadoDeContenidoParaTcl,
  EstadoDeGuionParaTcl,
  EstadoDeKpiParaTcl,
  EtapaParaTcl,
  ProductoRecibidoParaTcl,
  ProductoTcl,
} from '@tcl-kol-os/domain';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** ¿`valor` es un UUID? Un id que no lo es «no existe»: no llega a la base. */
export function esUuidTcl(valor: unknown): valor is string {
  return typeof valor === 'string' && UUID.test(valor);
}

export const ETIQUETA_DE_ESTADO_DE_CAMPANA: Readonly<Record<EstadoDeCampanaParaTcl, string>> = {
  en_curso: 'En curso',
  finalizada: 'Finalizada',
};

export const ETIQUETA_DE_ETAPA: Readonly<Record<EtapaParaTcl, string>> = {
  pendiente: 'Pendiente',
  en_curso: 'En curso',
  listo: 'Listo',
};

export const ETIQUETA_DE_PRODUCTO_RECIBIDO: Readonly<Record<ProductoRecibidoParaTcl, string>> = {
  si: 'Sí',
  no: 'No',
  parcial: 'Parcial',
};

export const ETIQUETA_DE_GUION: Readonly<Record<EstadoDeGuionParaTcl, string>> = {
  sin_entregables: 'Sin entregables',
  pendiente: 'Pendiente de aprobación',
  parcial: 'Aprobado parcialmente',
  aprobado: 'Aprobado',
};

export const ETIQUETA_DE_CONTENIDO: Readonly<Record<EstadoDeContenidoParaTcl, string>> = {
  aprobado: 'Aprobado',
  pendiente: 'Pendiente de aprobación',
};

export const ETIQUETA_DE_ESTADO_DE_KPI: Readonly<Record<EstadoDeKpiParaTcl, string>> = {
  cumplido: 'Cumplido',
  por_debajo: 'Por debajo del objetivo',
  sin_medicion: 'Sin medición',
};

const ETIQUETA_DE_METRICA: Readonly<Record<string, string>> = {
  views: 'Vistas',
  reach: 'Alcance',
  impressions: 'Impresiones',
  likes: 'Me gusta',
  comments: 'Comentarios',
  shares: 'Compartidos',
  saves: 'Guardados',
  link_clicks: 'Clics en el enlace',
  engagement_rate: 'Tasa de interacción',
};

export function etiquetaDeMetrica(metrica: string): string {
  return ETIQUETA_DE_METRICA[metrica] ?? 'Métrica';
}

export function etiquetaDeComparador(comparador: string): string {
  return comparador === 'lte' ? 'como máximo' : 'al menos';
}

/** Clase de la píldora por estado (solo refuerzo visual: el texto siempre acompaña). */
export function claseDePildora(tono: 'ok' | 'warn' | 'neutro' | 'info'): string {
  return `pill ${tono}`;
}

export function tonoDeEtapa(etapa: EtapaParaTcl): 'ok' | 'info' | 'neutro' {
  return etapa === 'listo' ? 'ok' : etapa === 'en_curso' ? 'info' : 'neutro';
}

export function tonoDeGuion(estado: EstadoDeGuionParaTcl): 'ok' | 'warn' | 'neutro' {
  return estado === 'aprobado' ? 'ok' : estado === 'sin_entregables' ? 'neutro' : 'warn';
}

export function tonoDeKpi(estado: EstadoDeKpiParaTcl): 'ok' | 'warn' | 'neutro' {
  return estado === 'cumplido' ? 'ok' : estado === 'por_debajo' ? 'warn' : 'neutro';
}

const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'] as const;

/** `YYYY-MM-DD` (o ISO con hora, en UTC) → «3 oct 2026». `—` si no hay fecha válida. Determinista (sin ICU ni zona). */
export function formatearFecha(valor: string | null | undefined): string {
  if (typeof valor !== 'string') return '—';
  const m = /^(\d{4})-(\d{2})-(\d{2})/u.exec(valor);
  if (m === null) return '—';
  const mes = Number(m[2]);
  if (mes < 1 || mes > 12) return '—';
  return `${Number(m[3])} ${MESES[mes - 1]!} ${m[1]}`;
}

/** Rango de fechas de la campaña: «3 oct 2026 – 3 nov 2026», «Desde …», «Hasta …» o «Sin fechas». */
export function formatearRango(inicio: string | null, fin: string | null): string {
  if (inicio !== null && fin !== null) return `${formatearFecha(inicio)} – ${formatearFecha(fin)}`;
  if (inicio !== null) return `Desde ${formatearFecha(inicio)}`;
  if (fin !== null) return `Hasta ${formatearFecha(fin)}`;
  return 'Sin fechas';
}

/** Número con separador de miles fijo (`.`) y decimal `,`: determinista, sin depender de ICU. */
export function formatearNumero(valor: number | null): string {
  if (valor === null || !Number.isFinite(valor)) return '—';
  const [entero = '0', decimales] = Math.abs(valor)
    .toFixed(2)
    .replace(/\.?0+$/u, '')
    .split('.');
  const miles = entero.replace(/\B(?=(\d{3})+(?!\d))/gu, '.');
  return `${valor < 0 ? '-' : ''}${miles}${decimales === undefined ? '' : `,${decimales}`}`;
}

/** Objetivo o resultado de un KPI con su unidad: `12.000` o `4,5 %`. */
export function formatearValorDeKpi(valor: number | null, unidad: 'count' | 'percent'): string {
  if (valor === null) return '—';
  return unidad === 'percent' ? `${formatearNumero(valor)} %` : formatearNumero(valor);
}

export function formatearCumplimiento(valor: number | null): string {
  return valor === null ? '—' : `${formatearNumero(Math.round(valor))} %`;
}

/** «TCL P80», «TCL», o `null` si no hay ni marca ni modelo. */
export function nombreDeProducto(p: Pick<ProductoTcl, 'marca' | 'modelo'> | null): string | null {
  if (p === null) return null;
  const partes = [p.marca, p.modelo].filter((x): x is string => x !== null && x !== '');
  return partes.length === 0 ? null : partes.join(' ');
}

/** Filtra la lista de campañas por texto (nombre, mercado o categoría), sin distinguir mayúsculas ni tildes. */
export function coincideConBusqueda(
  campana: { nombre: string | null; mercado: string | null; categoria: string | null },
  consulta: string,
): boolean {
  const normal = (t: string): string =>
    t
      .normalize('NFD')
      .replace(/\p{Diacritic}/gu, '')
      .toLowerCase();
  const q = normal(consulta.trim());
  if (q === '') return true;
  return [campana.nombre, campana.mercado, campana.categoria].some(
    (t) => t !== null && normal(t).includes(q),
  );
}

/** Agrupa por bloque del Brief conservando el orden de aparición. */
export function agruparPorBloque<T extends { readonly bloque: string }>(
  campos: readonly T[],
): { readonly bloque: string; readonly campos: readonly T[] }[] {
  const grupos = new Map<string, T[]>();
  for (const c of campos) {
    const g = grupos.get(c.bloque);
    if (g === undefined) grupos.set(c.bloque, [c]);
    else g.push(c);
  }
  return [...grupos.entries()].map(([bloque, lista]) => ({ bloque, campos: lista }));
}

export const ETIQUETA_DE_TIPO_DE_DOCUMENTO: Readonly<Record<string, string>> = {
  ppt_global: 'Presentación global',
  ficha_tecnica: 'Ficha técnica',
  brief_cliente: 'Brief del cliente',
  imagen: 'Imagen',
  otro: 'Otro',
};
