/**
 * Textos y constantes de presentación de Operación (V2 · Fase 8). Sin lógica de negocio y sin imports de
 * runtime de los paquetes (también lo usan los componentes cliente).
 */

type Tabla = Readonly<Record<string, string>>;

export const ESTADO_DE_ACUERDO: Tabla = {
  sin_acuerdo: 'Sin acuerdo',
  active: 'Vigente',
  cancelled: 'Cancelado',
};
export const PILL_DE_ACUERDO: Tabla = {
  sin_acuerdo: 'pill warn',
  active: 'pill ok',
  cancelled: 'pill neutro',
};

export const MODO_DE_ACUERDO: Tabla = {
  fee: 'Fee (pago en dinero)',
  barter: 'Canje (producto)',
  mixed: 'Mixto (fee y producto)',
};

export const ESTADO_LOGISTICO: Tabla = {
  sin_envio: 'Sin envío',
  pendiente: 'Pendiente',
  en_transito: 'En tránsito',
  entregado: 'Entregado',
  devuelto: 'Devuelto',
  fallido: 'Fallido',
  cancelado: 'Cancelado',
};
export const PILL_LOGISTICO: Tabla = {
  sin_envio: 'pill neutro',
  pendiente: 'pill warn',
  en_transito: 'pill curso',
  entregado: 'pill ok',
  devuelto: 'pill bad',
  fallido: 'pill bad',
  cancelado: 'pill neutro',
};

export const ESTADO_DE_ENVIO: Tabla = {
  pending: 'Pendiente',
  prepared: 'Preparado',
  shipped: 'Enviado',
  delivered: 'Entregado',
  failed: 'Fallido',
  returned: 'Devuelto',
  cancelled: 'Cancelado',
};
export const PILL_DE_ENVIO: Tabla = {
  pending: 'pill warn',
  prepared: 'pill curso',
  shipped: 'pill curso',
  delivered: 'pill ok',
  failed: 'pill bad',
  returned: 'pill bad',
  cancelled: 'pill neutro',
};

export const ESTADO_DE_CONTENIDO: Tabla = {
  sin_entregables: 'Sin entregables',
  sin_guion: 'Sin guion',
  en_curso: 'En curso',
  cambios_solicitados: 'Cambios solicitados',
  parcial: 'Parcial',
  aprobado: 'Aprobado',
};
export const PILL_DE_CONTENIDO: Tabla = {
  sin_entregables: 'pill neutro',
  sin_guion: 'pill neutro',
  en_curso: 'pill curso',
  cambios_solicitados: 'pill warn',
  parcial: 'pill curso',
  aprobado: 'pill ok',
};

export const ESTADO_DE_KPI_RESUMEN: Tabla = {
  sin_objetivos: 'Sin objetivos',
  sin_mediciones: 'Sin mediciones',
  parcial: 'Parcial',
  completo: 'Completo',
};
export const PILL_DE_KPI_RESUMEN: Tabla = {
  sin_objetivos: 'pill neutro',
  sin_mediciones: 'pill warn',
  parcial: 'pill curso',
  completo: 'pill ok',
};

export const ESTADO_DE_KPI: Tabla = {
  sin_medicion: 'Sin medición',
  no_comparable: 'No comparable',
  por_debajo: 'Por debajo',
  cumplido: 'Cumplido',
};
export const PILL_DE_KPI: Tabla = {
  sin_medicion: 'pill neutro',
  no_comparable: 'pill neutro',
  por_debajo: 'pill warn',
  cumplido: 'pill ok',
};

export const SEGUIMIENTO_DE_PAGO: Tabla = {
  not_applicable: 'No aplica',
  pending_document: 'Pendiente de documento',
  document_received: 'Documento recibido',
  pending_payment: 'Pendiente de pago',
  reported_paid: 'Pago reportado',
};
export const PILL_DE_PAGO: Tabla = {
  not_applicable: 'pill neutro',
  pending_document: 'pill warn',
  document_received: 'pill curso',
  pending_payment: 'pill warn',
  reported_paid: 'pill ok',
};

export const ESTADO_DE_DOCUMENTO: Tabla = {
  registered: 'Registrado',
  validated: 'Validado',
  rejected: 'Rechazado',
  voided: 'Anulado',
};
export const PILL_DE_DOCUMENTO: Tabla = {
  registered: 'pill curso',
  validated: 'pill ok',
  rejected: 'pill bad',
  voided: 'pill neutro',
};

export const TIPO_DE_EVENTO: Tabla = {
  'shipment.created': 'Envío creado',
  'shipment.prepared': 'Envío preparado',
  'shipment.shipped': 'Envío enviado',
  'shipment.delivered': 'Envío entregado',
  'shipment.failed': 'Envío fallido',
  'shipment.returned': 'Envío devuelto',
  'shipment.cancelled': 'Envío cancelado',
  'billing.registered': 'Documento de cobro registrado',
  'billing.validated': 'Documento de cobro validado',
  'billing.rejected': 'Documento de cobro rechazado',
  'billing.voided': 'Documento de cobro anulado',
  'payment.applicability_set': 'Aplicabilidad del pago definida',
  'payment.reported': 'Pago reportado',
  'payment.cancelled': 'Obligación de pago cancelada',
  'payment.correction_noted': 'Corrección de pago anotada',
  'evidence.attached': 'Evidencia adjunta',
};

export const TIPO_DE_SOPORTE: readonly { readonly valor: string; readonly etiqueta: string }[] = [
  { valor: 'guia', etiqueta: 'Guía' },
  { valor: 'cotizacion', etiqueta: 'Cotización' },
  { valor: 'orden_compra', etiqueta: 'Orden de compra' },
  { valor: 'cuenta_cobro', etiqueta: 'Cuenta de cobro' },
  { valor: 'comprobante', etiqueta: 'Comprobante' },
  { valor: 'soporte', etiqueta: 'Soporte' },
  { valor: 'otro', etiqueta: 'Otro' },
];

export const METRICA_DE_KPI: Tabla = {
  views: 'Vistas',
  reach: 'Alcance',
  impressions: 'Impresiones',
  likes: 'Me gusta',
  comments: 'Comentarios',
  shares: 'Compartidos',
  saves: 'Guardados',
  link_clicks: 'Clics en el enlace',
  engagement_rate: 'Tasa de interacción (%)',
  other: 'Otra métrica',
};

export const UNIDAD_DE_KPI: Tabla = { count: 'conteo', percent: '%', other: '' };
export const COMPARADOR_DE_KPI: Tabla = { gte: 'al menos', lte: 'como máximo' };
export const ESTADO_DE_OBJETIVO: Tabla = {
  active: 'Vigente',
  superseded: 'Reemplazado',
  retired: 'Retirado',
};

export const ETIQUETA_DE_CAMPO_PII: Tabla = {
  document_id: 'Documento de identidad',
  phone: 'Teléfono',
  address: 'Dirección',
};

/** Etiqueta de la métrica; para `other` usa la etiqueta que escribió la persona (texto, no confiable). */
export function nombreDeMetrica(metric: string, otherLabel: string | null | undefined): string {
  if (metric === 'other' && otherLabel !== null && otherLabel !== undefined && otherLabel !== '') {
    return `Otra: ${otherLabel}`;
  }
  return METRICA_DE_KPI[metric] ?? metric;
}

const FORMATO_NUMERO = new Intl.NumberFormat('es-CO', { maximumFractionDigits: 2 });

export function numero(valor: number | null | undefined): string {
  return valor === null || valor === undefined ? '—' : FORMATO_NUMERO.format(valor);
}

/** `AAAA-MM-DD` → `DD/MM/AAAA` sin pasar por `Date` (una fecha de día no tiene zona horaria). */
export function fechaDeDia(valor: string | null | undefined): string {
  if (valor === null || valor === undefined || valor === '') return '—';
  const m = /^(\d{4})-(\d{2})-(\d{2})/u.exec(valor);
  return m === null ? valor : `${m[3]}/${m[2]}/${m[1]}`;
}

/** Hoy en Colombia (`AAAA-MM-DD`), para prellenar fechas de hechos. */
export function hoyEnColombia(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Bogota',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

export const ACEPTA_EVIDENCIA = '.pdf,.png,.jpg,.jpeg,.xlsx,.csv,.docx';
