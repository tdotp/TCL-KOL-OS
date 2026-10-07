/**
 * Lectura y validación de los formularios de Operación (V2 · Fase 8). Módulo PURO: sin base de datos,
 * sin sesión y sin `next`; lo usan las server actions (`operacion-actions.ts`), el route handler de
 * evidencia y las pruebas.
 *
 * Reglas (no son negocio: el dominio las repite y manda):
 *  · ids con forma de UUID, enums cerrados, montos como decimales positivos con hasta 2 decimales
 *    (se normalizan a «1500000.00»), fechas `AAAA-MM-DD` reales, enteros acotados;
 *  · NADA que decide la autorización viaja en el formulario: ni organización, ni rol, ni origen, ni autor.
 *    El `campaignId` de una acción sale del recurso (nunca del formulario);
 *  · `idempotencyKey` (campo oculto generado en el cliente) y `expectedSeq`/`expectedVersion` son
 *    obligatorios donde el caso de uso los pide.
 *
 * Cada `leerX` devuelve `{ ok: true, value }` o `{ ok: false, field, message }` con el mensaje en español
 * para la persona (nunca el valor recibido: puede ser PII).
 */

import {
  COMPENSATION_TYPES,
  type CompensationType,
  type EvidenceKind,
  EVIDENCE_KINDS,
  type KpiComparator,
  type KpiMetric,
  type ShipmentStatus,
  KPI_COMPARATORS,
  KPI_METRICS,
  MAX_CANTIDAD_DE_PRODUCTO,
  MAX_CONDICIONES,
  MAX_EVENT_NOTE_LENGTH,
  MAX_GUIA,
  MAX_MOTIVO_DE_CAMBIO,
  MAX_MOTIVO_DE_CANCELACION,
  MAX_NUMERO_DE_DOCUMENTO,
  MAX_REFERENCIA_EXTERNA,
  MAX_TRANSPORTADORA,
  KPI_MAX_MOTIVO,
  SHIPMENT_STATUSES,
  esMonedaValida,
  isIsoDate,
  normalizarMonto,
} from '@tcl-kol-os/domain';

// ─────────────────────────── Tipos de lectura ──────────────────────────────────

export type Lectura<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly field: string; readonly message: string };

export class ErrorDeFormulario extends Error {
  readonly field: string;
  constructor(field: string, message: string) {
    super(message);
    this.name = 'ErrorDeFormulario';
    this.field = field;
  }
}

function falla(field: string, message: string): never {
  throw new ErrorDeFormulario(field, message);
}

/** Ejecuta un lector sobre un `FormData` y devuelve el resultado sin lanzar por errores de formulario. */
export function leer<T>(entrada: unknown, lector: (fd: FormData) => T): Lectura<T> {
  if (!(entrada instanceof FormData)) {
    return { ok: false, field: 'form', message: 'La solicitud no es válida. Recarga la página.' };
  }
  try {
    return { ok: true, value: lector(entrada) };
  } catch (error) {
    if (error instanceof ErrorDeFormulario) return { ok: false, field: error.field, message: error.message };
    throw error;
  }
}

// ─────────────────────────── Lectores de campo ─────────────────────────────────

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const CONTROL = /[\p{Cc}\p{Cf}]/u;

export const esUuidDeFormulario = (valor: unknown): valor is string =>
  typeof valor === 'string' && UUID.test(valor);

const capitalizar = (texto: string): string => texto.charAt(0).toUpperCase() + texto.slice(1);

function crudo(fd: FormData, campo: string): string | undefined {
  const valor = fd.get(campo);
  if (valor === null) return undefined;
  if (typeof valor !== 'string') return falla(campo, 'El valor enviado no es válido.');
  return valor;
}

interface OpcionesDeTexto {
  readonly max: number;
  readonly multilinea?: boolean;
}

function leerTextoOpcional(
  fd: FormData,
  campo: string,
  etiqueta: string,
  opciones: OpcionesDeTexto,
): string | undefined {
  const valor = crudo(fd, campo)?.trim();
  if (valor === undefined || valor === '') return undefined;
  if (valor.length > opciones.max) {
    return falla(campo, `${capitalizar(etiqueta)} no puede superar ${opciones.max} caracteres.`);
  }
  const sinSaltos = opciones.multilinea === true ? valor.replace(/[\n\r\t]/gu, ' ') : valor;
  if (CONTROL.test(sinSaltos))
    return falla(campo, `${capitalizar(etiqueta)} contiene caracteres no válidos.`);
  return valor;
}

function leerTexto(fd: FormData, campo: string, etiqueta: string, opciones: OpcionesDeTexto): string {
  return leerTextoOpcional(fd, campo, etiqueta, opciones) ?? falla(campo, `Indica ${etiqueta}.`);
}

function leerUuidOpcional(fd: FormData, campo: string, etiqueta: string): string | undefined {
  const valor = crudo(fd, campo)?.trim();
  if (valor === undefined || valor === '') return undefined;
  if (!UUID.test(valor)) return falla(campo, `${capitalizar(etiqueta)} no es válido.`);
  return valor.toLowerCase();
}

function leerUuid(fd: FormData, campo: string, etiqueta: string): string {
  return leerUuidOpcional(fd, campo, etiqueta) ?? falla(campo, `Falta ${etiqueta}. Recarga la página.`);
}

/** Clave de idempotencia (campo oculto generado en el cliente): ≤ 200 caracteres, sin control. */
function leerClave(fd: FormData): string {
  const valor = crudo(fd, 'idempotencyKey')?.trim();
  if (valor === undefined || valor === '' || valor.length > 200 || /[\p{Cc}]/u.test(valor)) {
    return falla('idempotencyKey', 'Falta la clave de la solicitud. Recarga la página e inténtalo de nuevo.');
  }
  return valor;
}

/** `expectedSeq` / `expectedVersion`: entero ≥ 0 que la persona vio. */
function leerSecuencia(fd: FormData, campo: 'expectedSeq' | 'expectedVersion'): number {
  const valor = crudo(fd, campo)?.trim();
  if (valor === undefined || !/^\d{1,9}$/u.test(valor)) {
    return falla(campo, 'Falta el estado que viste del registro. Recarga la página e inténtalo de nuevo.');
  }
  return Number(valor);
}

function leerFechaOpcional(fd: FormData, campo: string, etiqueta: string): string | undefined {
  const valor = crudo(fd, campo)?.trim();
  if (valor === undefined || valor === '') return undefined;
  if (!isIsoDate(valor))
    return falla(campo, `${capitalizar(etiqueta)} debe ser una fecha válida (AAAA-MM-DD).`);
  return valor;
}

function leerFecha(fd: FormData, campo: string, etiqueta: string): string {
  return leerFechaOpcional(fd, campo, etiqueta) ?? falla(campo, `Indica ${etiqueta}.`);
}

function leerMontoOpcional(fd: FormData, campo: string): string | undefined {
  const valor = crudo(fd, campo)?.trim();
  if (valor === undefined || valor === '') return undefined;
  const monto = normalizarMonto(valor);
  if (!monto.ok) return falla(campo, monto.error.message);
  return monto.value;
}

function leerMonto(fd: FormData, campo: string, etiqueta: string): string {
  return leerMontoOpcional(fd, campo) ?? falla(campo, `Indica ${etiqueta}.`);
}

function leerMonedaOpcional(fd: FormData, campo: string): string | undefined {
  const valor = crudo(fd, campo)?.trim().toUpperCase();
  if (valor === undefined || valor === '') return undefined;
  if (!esMonedaValida(valor))
    return falla(campo, 'La moneda debe ser un código de tres letras (p. ej. COP, USD).');
  return valor;
}

function leerMoneda(fd: FormData, campo: string): string {
  return leerMonedaOpcional(fd, campo) ?? falla(campo, 'Indica la moneda (tres letras, p. ej. COP).');
}

function leerEnum<T extends string>(fd: FormData, campo: string, valores: readonly T[], etiqueta: string): T {
  const valor = crudo(fd, campo)?.trim();
  if (valor === undefined || !(valores as readonly string[]).includes(valor)) {
    return falla(campo, `Elige ${etiqueta}.`);
  }
  return valor as T;
}

function leerEnumOpcional<T extends string>(
  fd: FormData,
  campo: string,
  valores: readonly T[],
  etiqueta: string,
): T | undefined {
  const valor = crudo(fd, campo)?.trim();
  if (valor === undefined || valor === '') return undefined;
  if (!(valores as readonly string[]).includes(valor)) return falla(campo, `Elige ${etiqueta}.`);
  return valor as T;
}

/** Decimal con signo opcional (valores de KPI). El dominio valida el rango según la métrica. */
function leerNumero(fd: FormData, campo: string, etiqueta: string): number {
  const valor = crudo(fd, campo)?.trim();
  if (valor === undefined || !/^-?\d{1,15}(\.\d{1,6})?$/u.test(valor)) {
    return falla(campo, `${capitalizar(etiqueta)} debe ser un número (con punto decimal, sin separadores).`);
  }
  const numero = Number(valor);
  if (!Number.isFinite(numero)) return falla(campo, `${capitalizar(etiqueta)} no es válido.`);
  return numero;
}

/**
 * Fecha (y hora opcional) de una observación → ISO 8601 en UTC. Acepta `AAAA-MM-DD` (00:00 UTC) y
 * `AAAA-MM-DDTHH:mm[:ss[.sss]][Z]` (se interpreta como UTC).
 */
function leerFechaHora(fd: FormData, campo: string, etiqueta: string): string {
  const valor = crudo(fd, campo)?.trim();
  if (valor === undefined || valor === '') return falla(campo, `Indica ${etiqueta}.`);
  const parcial = /^(\d{4}-\d{2}-\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?Z?)?$/u.exec(valor);
  if (parcial === null || !isIsoDate(parcial[1])) {
    return falla(
      campo,
      `${capitalizar(etiqueta)} debe ser una fecha válida (AAAA-MM-DD o AAAA-MM-DDTHH:mm).`,
    );
  }
  const [, dia, hh = '00', mm = '00', ss = '00', ms = '0'] = parcial;
  if (Number(hh) > 23 || Number(mm) > 59 || Number(ss) > 59) {
    return falla(campo, `${capitalizar(etiqueta)} tiene una hora que no existe.`);
  }
  return `${dia}T${hh}:${mm}:${ss}.${ms.padEnd(3, '0')}Z`;
}

function leerNota(fd: FormData, campo = 'note'): string | undefined {
  return leerTextoOpcional(fd, campo, 'la nota', { max: MAX_EVENT_NOTE_LENGTH, multilinea: true });
}

/** Filas producto/cantidad (campos repetidos y alineados). Una fila totalmente vacía se ignora. */
function leerFilas(
  fd: FormData,
  campoProducto: string,
  campoCantidad: string,
): { campaignProductId: string; quantity: number }[] {
  const productos = fd.getAll(campoProducto);
  const cantidades = fd.getAll(campoCantidad);
  if (productos.length !== cantidades.length) {
    return falla(campoProducto, 'Cada producto necesita su cantidad.');
  }
  const filas: { campaignProductId: string; quantity: number }[] = [];
  productos.forEach((p, i) => {
    const q = cantidades[i];
    if (typeof p !== 'string' || typeof q !== 'string') {
      return falla(campoProducto, 'El valor enviado no es válido.');
    }
    const producto = p.trim();
    const cantidad = q.trim();
    if (producto === '' && cantidad === '') return;
    if (producto === '' || cantidad === '')
      return falla(campoProducto, 'Cada producto necesita su cantidad.');
    if (!UUID.test(producto)) return falla(campoProducto, 'El producto no es válido.');
    const n = /^\d{1,6}$/u.test(cantidad) ? Number(cantidad) : Number.NaN;
    if (!Number.isInteger(n) || n < 1 || n > MAX_CANTIDAD_DE_PRODUCTO) {
      return falla(campoCantidad, `La cantidad debe ser un entero entre 1 y ${MAX_CANTIDAD_DE_PRODUCTO}.`);
    }
    filas.push({ campaignProductId: producto.toLowerCase(), quantity: n });
  });
  return filas;
}

// ─────────────────────────── Acuerdos ──────────────────────────────────────────

export interface TerminosLeidos {
  readonly compensationType: CompensationType;
  readonly feeAmount?: string;
  readonly feeCurrency?: string;
  readonly startsOn?: string;
  readonly endsOn?: string;
  readonly conditions?: string;
  readonly commitments: readonly { campaignProductId: string; quantity: number }[];
}

function leerTerminos(fd: FormData): TerminosLeidos {
  const feeAmount = leerMontoOpcional(fd, 'feeAmount');
  const feeCurrency = leerMonedaOpcional(fd, 'feeCurrency');
  const startsOn = leerFechaOpcional(fd, 'startsOn', 'el inicio de la vigencia');
  const endsOn = leerFechaOpcional(fd, 'endsOn', 'el fin de la vigencia');
  if (startsOn !== undefined && endsOn !== undefined && endsOn < startsOn) {
    return falla('endsOn', 'El fin de la vigencia no puede ser anterior al inicio.');
  }
  const conditions = leerTextoOpcional(fd, 'conditions', 'las condiciones', {
    max: MAX_CONDICIONES,
    multilinea: true,
  });
  return {
    compensationType: leerEnum(fd, 'compensationType', COMPENSATION_TYPES, 'el modo de compensación'),
    ...(feeAmount !== undefined ? { feeAmount } : {}),
    ...(feeCurrency !== undefined ? { feeCurrency } : {}),
    ...(startsOn !== undefined ? { startsOn } : {}),
    ...(endsOn !== undefined ? { endsOn } : {}),
    ...(conditions !== undefined ? { conditions } : {}),
    commitments: leerFilas(fd, 'commitmentProductId', 'commitmentQuantity'),
  };
}

export interface CrearAcuerdoLeido extends TerminosLeidos {
  readonly campaignInfluencerId: string;
  readonly idempotencyKey: string;
}

export const leerCrearAcuerdo = (entrada: unknown): Lectura<CrearAcuerdoLeido> =>
  leer(entrada, (fd) => ({
    campaignInfluencerId: leerUuid(fd, 'participacionId', 'la participación'),
    idempotencyKey: leerClave(fd),
    ...leerTerminos(fd),
  }));

export interface NuevaVersionLeida {
  readonly agreementId: string;
  readonly input: TerminosLeidos & {
    readonly changeReason: string;
    readonly expectedVersion: number;
    readonly idempotencyKey: string;
  };
}

export const leerNuevaVersionDeAcuerdo = (entrada: unknown): Lectura<NuevaVersionLeida> =>
  leer(entrada, (fd) => ({
    agreementId: leerUuid(fd, 'agreementId', 'el acuerdo'),
    input: {
      ...leerTerminos(fd),
      changeReason: leerTexto(fd, 'changeReason', 'el motivo del cambio', {
        max: MAX_MOTIVO_DE_CAMBIO,
        multilinea: true,
      }),
      expectedVersion: leerSecuencia(fd, 'expectedVersion'),
      idempotencyKey: leerClave(fd),
    },
  }));

export interface CancelacionDeAcuerdoLeida {
  readonly agreementId: string;
  readonly input: { readonly reason: string; readonly idempotencyKey: string };
}

export const leerCancelacionDeAcuerdo = (entrada: unknown): Lectura<CancelacionDeAcuerdoLeida> =>
  leer(entrada, (fd) => ({
    agreementId: leerUuid(fd, 'agreementId', 'el acuerdo'),
    input: {
      reason: leerTexto(fd, 'reason', 'el motivo de la cancelación', { max: 500, multilinea: true }),
      idempotencyKey: leerClave(fd),
    },
  }));

// ─────────────────────────── Envíos ────────────────────────────────────────────

export interface CrearEnvioLeido {
  readonly campaignInfluencerId: string;
  readonly items: readonly { campaignProductId: string; quantity: number }[];
  readonly carrier?: string;
  readonly trackingRef?: string;
  readonly shippingCost?: string;
  readonly shippingCurrency?: string;
  readonly piiRecordId?: string;
  readonly idempotencyKey: string;
  readonly note?: string;
}

export const leerCrearEnvio = (entrada: unknown): Lectura<CrearEnvioLeido> =>
  leer(entrada, (fd) => {
    const items = leerFilas(fd, 'itemProductId', 'itemQuantity');
    if (items.length === 0) return falla('itemProductId', 'Un envío lleva al menos un producto.');
    const carrier = leerTextoOpcional(fd, 'carrier', 'la transportadora', { max: MAX_TRANSPORTADORA });
    const trackingRef = leerTextoOpcional(fd, 'trackingRef', 'la guía', { max: MAX_GUIA });
    const shippingCost = leerMontoOpcional(fd, 'shippingCost');
    const shippingCurrency = leerMonedaOpcional(fd, 'shippingCurrency');
    const piiRecordId = leerUuidOpcional(fd, 'piiRecordId', 'el registro de datos personales');
    const note = leerNota(fd);
    return {
      campaignInfluencerId: leerUuid(fd, 'participacionId', 'la participación'),
      items,
      ...(carrier !== undefined ? { carrier } : {}),
      ...(trackingRef !== undefined ? { trackingRef } : {}),
      ...(shippingCost !== undefined ? { shippingCost } : {}),
      ...(shippingCurrency !== undefined ? { shippingCurrency } : {}),
      ...(piiRecordId !== undefined ? { piiRecordId } : {}),
      idempotencyKey: leerClave(fd),
      ...(note !== undefined ? { note } : {}),
    };
  });

/** Destinos de una transición de envío (un envío nace `pending`; solo avanza). */
export const DESTINOS_DE_ENVIO: readonly ShipmentStatus[] = SHIPMENT_STATUSES.filter((s) => s !== 'pending');

export interface TransicionDeEnvioLeida {
  readonly shipmentId: string;
  readonly to: ShipmentStatus;
  readonly expectedSeq: number;
  readonly idempotencyKey: string;
  readonly happenedOn?: string;
  readonly carrier?: string;
  readonly trackingRef?: string;
  readonly cancelReason?: string;
  readonly note?: string;
}

export function leerTransicionDeEnvioDe(fd: FormData): TransicionDeEnvioLeida {
  const happenedOn = leerFechaOpcional(fd, 'happenedOn', 'la fecha del hecho');
  const carrier = leerTextoOpcional(fd, 'carrier', 'la transportadora', { max: MAX_TRANSPORTADORA });
  const trackingRef = leerTextoOpcional(fd, 'trackingRef', 'la guía', { max: MAX_GUIA });
  const cancelReason = leerTextoOpcional(fd, 'cancelReason', 'el motivo de la cancelación', {
    max: MAX_MOTIVO_DE_CANCELACION,
    multilinea: true,
  });
  const note = leerNota(fd);
  return {
    shipmentId: leerUuid(fd, 'shipmentId', 'el envío'),
    to: leerEnum(fd, 'to', DESTINOS_DE_ENVIO, 'el nuevo estado del envío'),
    expectedSeq: leerSecuencia(fd, 'expectedSeq'),
    idempotencyKey: leerClave(fd),
    ...(happenedOn !== undefined ? { happenedOn } : {}),
    ...(carrier !== undefined ? { carrier } : {}),
    ...(trackingRef !== undefined ? { trackingRef } : {}),
    ...(cancelReason !== undefined ? { cancelReason } : {}),
    ...(note !== undefined ? { note } : {}),
  };
}

export const leerTransicionDeEnvio = (entrada: unknown): Lectura<TransicionDeEnvioLeida> =>
  leer(entrada, leerTransicionDeEnvioDe);

// ─────────────────────────── Documentos de cobro y pagos ───────────────────────

export interface TransicionDeDocumentoLeida {
  readonly billingDocumentId: string;
  readonly expectedSeq: number;
  readonly idempotencyKey: string;
  readonly note?: string;
}

export const leerTransicionDeDocumento = (entrada: unknown): Lectura<TransicionDeDocumentoLeida> =>
  leer(entrada, (fd) => {
    const note = leerNota(fd);
    return {
      billingDocumentId: leerUuid(fd, 'billingDocumentId', 'el documento de cobro'),
      expectedSeq: leerSecuencia(fd, 'expectedSeq'),
      idempotencyKey: leerClave(fd),
      ...(note !== undefined ? { note } : {}),
    };
  });

export interface ReporteDePagoLeido {
  readonly paymentObligationId: string;
  readonly expectedSeq: number;
  readonly idempotencyKey: string;
  readonly paidOn: string;
  readonly externalReference: string;
  readonly note?: string;
}

export function leerReporteDePagoDe(fd: FormData): ReporteDePagoLeido {
  const note = leerNota(fd);
  return {
    paymentObligationId: leerUuid(fd, 'paymentObligationId', 'la obligación de pago'),
    expectedSeq: leerSecuencia(fd, 'expectedSeq'),
    idempotencyKey: leerClave(fd),
    paidOn: leerFecha(fd, 'paidOn', 'la fecha del pago'),
    externalReference: leerTexto(fd, 'externalReference', 'la referencia externa del pago', {
      max: MAX_REFERENCIA_EXTERNA,
    }),
    ...(note !== undefined ? { note } : {}),
  };
}

export const leerReporteDePago = (entrada: unknown): Lectura<ReporteDePagoLeido> =>
  leer(entrada, leerReporteDePagoDe);

export interface CancelacionDeObligacionLeida {
  readonly paymentObligationId: string;
  readonly expectedSeq: number;
  readonly idempotencyKey: string;
  readonly note?: string;
}

export const leerCancelacionDeObligacion = (entrada: unknown): Lectura<CancelacionDeObligacionLeida> =>
  leer(entrada, (fd) => {
    const note = leerNota(fd);
    return {
      paymentObligationId: leerUuid(fd, 'paymentObligationId', 'la obligación de pago'),
      expectedSeq: leerSecuencia(fd, 'expectedSeq'),
      idempotencyKey: leerClave(fd),
      ...(note !== undefined ? { note } : {}),
    };
  });

export interface NotaDeCorreccionLeida {
  readonly paymentObligationId: string;
  readonly expectedSeq: number;
  readonly idempotencyKey: string;
  readonly note: string;
  readonly externalReference?: string;
  readonly happenedOn?: string;
}

export const leerNotaDeCorreccion = (entrada: unknown): Lectura<NotaDeCorreccionLeida> =>
  leer(entrada, (fd) => {
    const externalReference = leerTextoOpcional(fd, 'externalReference', 'la referencia externa', {
      max: MAX_REFERENCIA_EXTERNA,
    });
    const happenedOn = leerFechaOpcional(fd, 'happenedOn', 'la fecha corregida');
    return {
      paymentObligationId: leerUuid(fd, 'paymentObligationId', 'la obligación de pago'),
      expectedSeq: leerSecuencia(fd, 'expectedSeq'),
      idempotencyKey: leerClave(fd),
      note: leerTexto(fd, 'note', 'qué se corrige y por qué', {
        max: MAX_EVENT_NOTE_LENGTH,
        multilinea: true,
      }),
      ...(externalReference !== undefined ? { externalReference } : {}),
      ...(happenedOn !== undefined ? { happenedOn } : {}),
    };
  });

// ─────────────────────────── KPIs ──────────────────────────────────────────────

export interface ObjetivoDeKpiLeido {
  readonly campaignInfluencerId: string;
  readonly deliverableId?: string;
  readonly metric: KpiMetric;
  readonly otherLabel?: string;
  readonly targetValue: number;
  readonly comparator: KpiComparator;
  readonly platform?: string;
  readonly periodStart?: string;
  readonly periodEnd?: string;
  readonly supersedesId?: string;
  readonly idempotencyKey: string;
  /** La persona pidió registrar el objetivo con la procedencia del Sheet (el servidor la resuelve). */
  readonly usarSugerenciaDelSheet: boolean;
  /** Huella (SHA-256) del texto del Sheet que la persona VIO: si cambió, no se registra. */
  readonly sheetTextHash?: string;
}

function leerPeriodo(fd: FormData): { periodStart?: string; periodEnd?: string } {
  const periodStart = leerFechaOpcional(fd, 'periodStart', 'el inicio del periodo');
  const periodEnd = leerFechaOpcional(fd, 'periodEnd', 'el fin del periodo');
  if (periodStart !== undefined && periodEnd !== undefined && periodEnd < periodStart) {
    return falla('periodEnd', 'El fin del periodo no puede ser anterior al inicio.');
  }
  return {
    ...(periodStart !== undefined ? { periodStart } : {}),
    ...(periodEnd !== undefined ? { periodEnd } : {}),
  };
}

export const leerObjetivoDeKpi = (entrada: unknown): Lectura<ObjetivoDeKpiLeido> =>
  leer(entrada, (fd) => {
    const metric = leerEnum(fd, 'metric', KPI_METRICS, 'la métrica');
    const otherLabel = leerTextoOpcional(fd, 'otherLabel', 'la etiqueta de la métrica', { max: 80 });
    const deliverableId = leerUuidOpcional(fd, 'deliverableId', 'el entregable');
    const platform = leerTextoOpcional(fd, 'platform', 'la plataforma', { max: 40 })?.toLowerCase();
    const supersedesId = leerUuidOpcional(fd, 'supersedesId', 'el objetivo a reemplazar');
    const usar = crudo(fd, 'usarSugerenciaDelSheet')?.trim();
    const sheetTextHash = crudo(fd, 'sheetTextHash')?.trim().toLowerCase();
    if (usar !== undefined && usar !== '' && !['1', 'true', 'on'].includes(usar)) {
      return falla('usarSugerenciaDelSheet', 'El valor enviado no es válido.');
    }
    const usarSugerenciaDelSheet = usar !== undefined && usar !== '';
    if (usarSugerenciaDelSheet && (sheetTextHash === undefined || !/^[0-9a-f]{64}$/u.test(sheetTextHash))) {
      return falla('sheetTextHash', 'Falta la huella del KPI pactado en el Sheet. Recarga la página.');
    }
    return {
      campaignInfluencerId: leerUuid(fd, 'participacionId', 'la participación'),
      ...(deliverableId !== undefined ? { deliverableId } : {}),
      metric,
      ...(otherLabel !== undefined ? { otherLabel } : {}),
      targetValue: leerNumero(fd, 'targetValue', 'el valor objetivo'),
      comparator: leerEnumOpcional(fd, 'comparator', KPI_COMPARATORS, 'el comparador') ?? 'gte',
      ...(platform !== undefined ? { platform } : {}),
      ...leerPeriodo(fd),
      ...(supersedesId !== undefined ? { supersedesId } : {}),
      idempotencyKey: leerClave(fd),
      usarSugerenciaDelSheet,
      ...(usarSugerenciaDelSheet && sheetTextHash !== undefined ? { sheetTextHash } : {}),
    };
  });

export const leerRetiroDeObjetivo = (entrada: unknown): Lectura<{ readonly targetId: string }> =>
  leer(entrada, (fd) => ({ targetId: leerUuid(fd, 'targetId', 'el objetivo') }));

export interface MedicionDeKpiLeida {
  readonly campaignInfluencerId: string;
  readonly deliverableId?: string;
  readonly platform?: string;
  readonly metric: KpiMetric;
  readonly otherLabel?: string;
  readonly value: number;
  readonly observedAt: string;
  readonly periodStart?: string;
  readonly periodEnd?: string;
  readonly idempotencyKey: string;
}

export const leerMedicionDeKpi = (entrada: unknown): Lectura<MedicionDeKpiLeida> =>
  leer(entrada, (fd) => {
    const metric = leerEnum(fd, 'metric', KPI_METRICS, 'la métrica');
    const otherLabel = leerTextoOpcional(fd, 'otherLabel', 'la etiqueta de la métrica', { max: 80 });
    const deliverableId = leerUuidOpcional(fd, 'deliverableId', 'el entregable');
    const platform = leerTextoOpcional(fd, 'platform', 'la plataforma', { max: 40 })?.toLowerCase();
    return {
      campaignInfluencerId: leerUuid(fd, 'participacionId', 'la participación'),
      ...(deliverableId !== undefined ? { deliverableId } : {}),
      ...(platform !== undefined ? { platform } : {}),
      metric,
      ...(otherLabel !== undefined ? { otherLabel } : {}),
      value: leerNumero(fd, 'value', 'el valor medido'),
      observedAt: leerFechaHora(fd, 'observedAt', 'la fecha de la observación'),
      ...leerPeriodo(fd),
      idempotencyKey: leerClave(fd),
    };
  });

export interface CorreccionDeMedicionLeida {
  readonly measurementId: string;
  readonly input: {
    readonly value: number;
    readonly correctionReason: string;
    readonly observedAt?: string;
    readonly idempotencyKey: string;
  };
}

export const leerCorreccionDeMedicion = (entrada: unknown): Lectura<CorreccionDeMedicionLeida> =>
  leer(entrada, (fd) => {
    const observado = crudo(fd, 'observedAt')?.trim();
    return {
      measurementId: leerUuid(fd, 'measurementId', 'la medición'),
      input: {
        value: leerNumero(fd, 'value', 'el valor correcto'),
        correctionReason: leerTexto(fd, 'correctionReason', 'el motivo de la corrección', {
          max: KPI_MAX_MOTIVO,
          multilinea: true,
        }),
        ...(observado !== undefined && observado !== ''
          ? { observedAt: leerFechaHora(fd, 'observedAt', 'la fecha de la observación') }
          : {}),
        idempotencyKey: leerClave(fd),
      },
    };
  });

// ─────────────────────────── Datos personales ──────────────────────────────────

export interface PiiLeida {
  readonly participacionId: string;
  readonly documentId?: string;
  readonly phone?: string;
  readonly address?: string;
}

/** Los valores de PII se leen aquí y NUNCA se devuelven ni se registran (los mensajes no los citan). */
export const leerPiiAGuardar = (entrada: unknown): Lectura<PiiLeida> =>
  leer(entrada, (fd) => {
    const documentId = leerTextoOpcional(fd, 'documentId', 'el documento de identidad', { max: 40 });
    const phone = leerTextoOpcional(fd, 'phone', 'el teléfono', { max: 40 });
    const address = leerTextoOpcional(fd, 'address', 'la dirección', { max: 300, multilinea: true });
    if (documentId === undefined && phone === undefined && address === undefined) {
      return falla('documentId', 'Indica al menos un dato personal para guardar.');
    }
    return {
      participacionId: leerUuid(fd, 'participacionId', 'la participación'),
      ...(documentId !== undefined ? { documentId } : {}),
      ...(phone !== undefined ? { phone } : {}),
      ...(address !== undefined ? { address } : {}),
    };
  });

// ─────────────────────────── Evidencia (route handler) ─────────────────────────

export const TIPOS_DE_EVIDENCIA = ['documento_cobro', 'envio', 'pago'] as const;
export type TipoDeEvidencia = (typeof TIPOS_DE_EVIDENCIA)[number];

/** Soporte aceptado por la ruta (el contenido real lo vuelve a validar el caso de uso). */
export const EXTENSIONES_DE_EVIDENCIA: readonly string[] = [
  'pdf',
  'png',
  'jpg',
  'jpeg',
  'xlsx',
  'csv',
  'docx',
];
export const MIMES_DE_EVIDENCIA: readonly string[] = [
  'application/pdf',
  'image/png',
  'image/jpeg',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'text/csv',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
];
export const MENSAJE_TIPO_DE_EVIDENCIA = 'Tipo de archivo no permitido. Usa PDF, PNG, JPG, XLSX, CSV o DOCX.';

export function extensionDeEvidenciaPermitida(nombre: string): boolean {
  const base = nombre.split(/[\\/]/u).pop() ?? '';
  const punto = base.lastIndexOf('.');
  if (punto < 0) return false;
  return EXTENSIONES_DE_EVIDENCIA.includes(base.slice(punto + 1).toLowerCase());
}

const KIND_POR_DEFECTO: Readonly<Record<TipoDeEvidencia, EvidenceKind>> = {
  documento_cobro: 'cuenta_cobro',
  envio: 'guia',
  pago: 'comprobante',
};

export type EntradaDeEvidencia =
  | ({
      readonly tipo: 'documento_cobro';
      readonly accion: 'registrar';
      readonly participacionId: string;
      readonly paymentObligationId: string;
      readonly documentNumber: string;
      readonly issuedOn: string;
      readonly claimedAmount: string;
      readonly claimedCurrency: string;
      readonly idempotencyKey: string;
    } & { readonly note?: string })
  | ({
      readonly tipo: 'documento_cobro';
      readonly accion: 'adjuntar';
      readonly participacionId: string;
      readonly billingDocumentId: string;
      readonly expectedSeq: number;
      readonly kind: EvidenceKind;
      readonly idempotencyKey: string;
    } & { readonly note?: string })
  | ({
      readonly tipo: 'envio';
      readonly accion: 'transicionar';
      readonly kind: EvidenceKind;
    } & TransicionDeEnvioLeida)
  | ({
      readonly tipo: 'envio';
      readonly accion: 'adjuntar';
      readonly shipmentId: string;
      readonly expectedSeq: number;
      readonly kind: EvidenceKind;
      readonly idempotencyKey: string;
    } & { readonly note?: string })
  | ({
      readonly tipo: 'pago';
      readonly accion: 'reportar';
      readonly participacionId: string;
      readonly kind: EvidenceKind;
    } & ReporteDePagoLeido)
  | ({
      readonly tipo: 'pago';
      readonly accion: 'adjuntar';
      readonly participacionId: string;
      readonly paymentObligationId: string;
      readonly expectedSeq: number;
      readonly kind: EvidenceKind;
      readonly idempotencyKey: string;
    } & { readonly note?: string });

function leerKind(fd: FormData, tipo: TipoDeEvidencia): EvidenceKind {
  return leerEnumOpcional(fd, 'kind', EVIDENCE_KINDS, 'el tipo de soporte') ?? KIND_POR_DEFECTO[tipo];
}

/** Campos de texto de la subida de evidencia (el archivo lo lee el route handler). */
export const leerEntradaDeEvidencia = (entrada: unknown): Lectura<EntradaDeEvidencia> =>
  leer(entrada, (fd): EntradaDeEvidencia => {
    const tipo = leerEnum(fd, 'tipo', TIPOS_DE_EVIDENCIA, 'el tipo de registro');
    const accion = crudo(fd, 'accion')?.trim();
    const note = leerNota(fd);
    const nota = note !== undefined ? { note } : {};
    const kind = leerKind(fd, tipo);
    if (tipo === 'documento_cobro') {
      if (accion === 'registrar') {
        return {
          tipo,
          accion,
          participacionId: leerUuid(fd, 'participacionId', 'la participación'),
          paymentObligationId: leerUuid(fd, 'paymentObligationId', 'la obligación de pago'),
          documentNumber: leerTexto(fd, 'documentNumber', 'el número del documento', {
            max: MAX_NUMERO_DE_DOCUMENTO,
          }),
          issuedOn: leerFecha(fd, 'issuedOn', 'la fecha de emisión'),
          claimedAmount: leerMonto(fd, 'claimedAmount', 'el monto del documento'),
          claimedCurrency: leerMoneda(fd, 'claimedCurrency'),
          idempotencyKey: leerClave(fd),
          ...nota,
        };
      }
      if (accion === 'adjuntar') {
        return {
          tipo,
          accion,
          participacionId: leerUuid(fd, 'participacionId', 'la participación'),
          billingDocumentId: leerUuid(fd, 'billingDocumentId', 'el documento de cobro'),
          expectedSeq: leerSecuencia(fd, 'expectedSeq'),
          kind,
          idempotencyKey: leerClave(fd),
          ...nota,
        };
      }
    } else if (tipo === 'envio') {
      if (accion === 'transicionar') return { tipo, accion, kind, ...leerTransicionDeEnvioDe(fd) };
      if (accion === 'adjuntar') {
        return {
          tipo,
          accion,
          shipmentId: leerUuid(fd, 'shipmentId', 'el envío'),
          expectedSeq: leerSecuencia(fd, 'expectedSeq'),
          kind,
          idempotencyKey: leerClave(fd),
          ...nota,
        };
      }
    } else {
      if (accion === 'reportar') {
        return {
          tipo,
          accion,
          participacionId: leerUuid(fd, 'participacionId', 'la participación'),
          kind,
          ...leerReporteDePagoDe(fd),
        };
      }
      if (accion === 'adjuntar') {
        return {
          tipo,
          accion,
          participacionId: leerUuid(fd, 'participacionId', 'la participación'),
          paymentObligationId: leerUuid(fd, 'paymentObligationId', 'la obligación de pago'),
          expectedSeq: leerSecuencia(fd, 'expectedSeq'),
          kind,
          idempotencyKey: leerClave(fd),
          ...nota,
        };
      }
    }
    return falla('accion', 'La acción pedida no es válida para ese tipo de registro.');
  });

// ─────────────────────────── Origen de la petición (CSRF) ──────────────────────

/**
 * CSRF para los route handlers de escritura de Operación: comprobación ESTRICTA. `Sec-Fetch-Site` solo
 * puede ser `same-origin`/`none`; si hay `Origin`, su host debe ser EXACTAMENTE el de la cabecera `Host`.
 * A diferencia del route handler de guiones (UI-09), NO se confía en `x-forwarded-host`: es una cabecera que
 * pone cualquiera que llegue sin proxy. Sin `Origin` ni `Sec-Fetch-Site` no es un navegador (curl, pruebas)
 * y el CSRF exige el navegador de la víctima.
 */
export function origenPermitidoEstricto(request: Request): boolean {
  const sitio = request.headers.get('sec-fetch-site');
  if (sitio !== null && sitio !== 'same-origin' && sitio !== 'none') return false;
  const origen = request.headers.get('origin');
  if (origen === null) return true;
  let host: string;
  try {
    host = new URL(origen).host;
  } catch {
    return false;
  }
  const propio = request.headers.get('host');
  return propio !== null && propio !== '' && propio === host;
}
