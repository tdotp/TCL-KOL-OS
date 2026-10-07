/**
 * Read models del Operativo (V2 · Fase 8, DEC-049): tipos y funciones PURAS del resumen por participación.
 *
 * Cada dominio mantiene la AUTORIDAD de su estado (acuerdo, envíos, documentos de cobro, obligación de pago,
 * entregables): aquí solo se DERIVA una lectura compuesta; nada se duplica ni se escribe en
 * `campaign_influencers.status`.
 *
 * Capacidades. Todo el resumen exige `operations:read`; cada sección, además, la suya:
 *   acuerdo → agreement:read · logistica → shipment:read · facturacion_pagos → finance:read ·
 *   contenido → deliverable:read · kpi → kpi:read.
 * Una sección cuyo permiso falta NO existe en el objeto (clave ausente; no es `null`). `kpi` es la única que
 * puede ser `null` estando presente: «el actor la puede ver pero aún no hay objetivos ni mediciones».
 *
 * Jamás hay aquí dirección, teléfono, cédula ni notas: a lo sumo el booleano `tienePii` de la logística.
 */

import type { Result } from './errors';
import { err, ok } from './errors';
import type { Action } from './permissions';
import { roleCan } from './permissions';
import type { Role } from './types';
import type { AgreementStatus, CompensationType } from './agreements';
import type { BillingDocumentStatus, PaymentObligationStatus, PaymentTracking } from './billing-payment';
import { derivarSeguimientoDePago } from './billing-payment';
import type { ResumenDeEntregable } from './content';
import type { ShipmentStatus } from './shipments';
import { esEnvioAbierto } from './shipments';

// ─────────────────────────── Secciones y capacidades ───────────────────────────

export type SeccionOperativa = 'acuerdo' | 'logistica' | 'facturacion_pagos' | 'contenido' | 'kpi';

export const SECCIONES_OPERATIVAS: readonly SeccionOperativa[] = [
  'acuerdo',
  'logistica',
  'facturacion_pagos',
  'contenido',
  'kpi',
] as const;

/** Capacidad que exige TODO el resumen operativo (además de la de cada sección). */
export const CAPACIDAD_DEL_RESUMEN_OPERATIVO: Action = 'operations:read';

/** Capacidad que exige cada sección. */
export const CAPACIDAD_POR_SECCION: Readonly<Record<SeccionOperativa, Action>> = {
  acuerdo: 'agreement:read',
  logistica: 'shipment:read',
  facturacion_pagos: 'finance:read',
  contenido: 'deliverable:read',
  kpi: 'kpi:read',
};

export function isSeccionOperativa(value: unknown): value is SeccionOperativa {
  return typeof value === 'string' && (SECCIONES_OPERATIVAS as readonly string[]).includes(value);
}

/** ¿El rol puede abrir el resumen operativo (`operations:read`)? */
export function puedeVerResumenOperativo(role: Role): boolean {
  return roleCan(role, CAPACIDAD_DEL_RESUMEN_OPERATIVO);
}

export function puedeVerSeccionOperativa(role: Role, seccion: SeccionOperativa): boolean {
  return puedeVerResumenOperativo(role) && roleCan(role, CAPACIDAD_POR_SECCION[seccion]);
}

/** Secciones que el rol puede ver, en orden estable. Sin `operations:read` ⇒ ninguna. */
export function seccionesPermitidas(role: Role): readonly SeccionOperativa[] {
  return SECCIONES_OPERATIVAS.filter((s) => puedeVerSeccionOperativa(role, s));
}

// ─────────────────────────── Acuerdo ───────────────────────────────────────────

export type EstadoDeAcuerdoEnResumen = 'sin_acuerdo' | AgreementStatus;

export interface ResumenDeAcuerdo {
  readonly estado: EstadoDeAcuerdoEnResumen;
  /** `null` solo sin acuerdo. */
  readonly modo: CompensationType | null;
  /** Versión vigente (`null` sin acuerdo). */
  readonly version: number | null;
}

export function resumirAcuerdo(
  acuerdo: { status: AgreementStatus; compensationType: CompensationType; currentVersion: number } | null,
): ResumenDeAcuerdo {
  if (acuerdo === null) return { estado: 'sin_acuerdo', modo: null, version: null };
  return { estado: acuerdo.status, modo: acuerdo.compensationType, version: acuerdo.currentVersion };
}

// ─────────────────────────── Logística ─────────────────────────────────────────

export type EstadoLogisticoDerivado =
  'sin_envio' | 'pendiente' | 'en_transito' | 'entregado' | 'devuelto' | 'fallido' | 'cancelado';

export const ESTADOS_LOGISTICOS_DERIVADOS: readonly EstadoLogisticoDerivado[] = [
  'sin_envio',
  'pendiente',
  'en_transito',
  'entregado',
  'devuelto',
  'fallido',
  'cancelado',
] as const;

export interface LogisticaDerivada {
  readonly estado: EstadoLogisticoDerivado;
  /** Envíos abiertos (pending, prepared, shipped). */
  readonly abiertos: number;
  /** Estado crudo del envío MÁS RECIENTE (`null` si no hay). */
  readonly ultimoEstado: ShipmentStatus | null;
}

const ESTADO_LOGISTICO_DE_TERMINAL: Readonly<
  Record<'returned' | 'failed' | 'cancelled', EstadoLogisticoDerivado>
> = { returned: 'devuelto', failed: 'fallido', cancelled: 'cancelado' };

/**
 * Estado logístico de una participación a partir de los estados de sus envíos, del MÁS ANTIGUO al MÁS RECIENTE
 * (reenviar = envío nuevo; puede haber varios). Reglas, en este orden:
 *   1. sin envíos ⇒ `sin_envio`;
 *   2. algún envío abierto ⇒ `en_transito` si alguno ya salió (`shipped`), si no `pendiente`;
 *   3. sin abiertos y algún `delivered` ⇒ `entregado`;
 *   4. si no, el estado terminal del envío más reciente (`devuelto`, `fallido`, `cancelado`).
 * `delivered` jamás se infiere: viene de un evento humano sobre el envío.
 */
export function derivarEstadoLogistico(statuses: readonly ShipmentStatus[]): LogisticaDerivada {
  const ultimo = statuses[statuses.length - 1];
  if (ultimo === undefined) return { estado: 'sin_envio', abiertos: 0, ultimoEstado: null };
  const abiertos = statuses.filter(esEnvioAbierto).length;
  if (abiertos > 0) {
    const enCamino = statuses.includes('shipped');
    return { estado: enCamino ? 'en_transito' : 'pendiente', abiertos, ultimoEstado: ultimo };
  }
  if (statuses.includes('delivered')) return { estado: 'entregado', abiertos: 0, ultimoEstado: ultimo };
  const terminal =
    ultimo === 'returned' || ultimo === 'failed' || ultimo === 'cancelled' ? ultimo : 'cancelled';
  return { estado: ESTADO_LOGISTICO_DE_TERMINAL[terminal], abiertos: 0, ultimoEstado: ultimo };
}

/**
 * «Logística pendiente»: aún falta que llegue producto. No lo está lo ya `entregado`; lo está lo que tiene un
 * envío abierto; y lo que no tiene ninguno solo si el acuerdo vigente compromete producto (fee puro no envía).
 */
export function esLogisticaPendiente(l: {
  readonly estado: EstadoLogisticoDerivado;
  readonly abiertos: number;
  readonly tieneCompromisos: boolean;
}): boolean {
  if (l.estado === 'entregado') return false;
  if (l.abiertos > 0) return true;
  return l.tieneCompromisos;
}

/** Progreso por producto: comprometido ≠ enviado ≠ entregado (y ninguno es «asignado»). */
export interface ProgresoDeProducto<N = string> {
  readonly campaignProductId: string;
  readonly nombre: N;
  readonly comprometido: number;
  /** Unidades en envíos que ya salieron y no fallaron ni volvieron: `shipped` o `delivered`. */
  readonly enviado: number;
  /** Unidades en envíos `delivered`. */
  readonly entregado: number;
}

export interface CompromisoParaProgreso<N = string> {
  readonly campaignProductId: string;
  readonly nombre: N;
  readonly quantity: number;
}

export interface ItemParaProgreso<N = string> {
  readonly campaignProductId: string;
  readonly nombre: N;
  readonly status: ShipmentStatus;
  readonly quantity: number;
}

/**
 * Une los compromisos de la versión vigente con los ítems de los envíos. Un producto enviado sin compromiso
 * aparece con `comprometido: 0` (fee puro con envío de cortesía, p. ej.). Orden: compromisos primero.
 */
export function calcularProgresoDeProductos<N>(
  compromisos: readonly CompromisoParaProgreso<N>[],
  items: readonly ItemParaProgreso<N>[],
): ProgresoDeProducto<N>[] {
  const porProducto = new Map<
    string,
    { nombre: N; comprometido: number; enviado: number; entregado: number }
  >();
  for (const c of compromisos) {
    const actual = porProducto.get(c.campaignProductId);
    if (actual === undefined) {
      porProducto.set(c.campaignProductId, {
        nombre: c.nombre,
        comprometido: c.quantity,
        enviado: 0,
        entregado: 0,
      });
    } else {
      actual.comprometido += c.quantity;
    }
  }
  for (const i of items) {
    const actual = porProducto.get(i.campaignProductId) ?? {
      nombre: i.nombre,
      comprometido: 0,
      enviado: 0,
      entregado: 0,
    };
    if (i.status === 'shipped' || i.status === 'delivered') actual.enviado += i.quantity;
    if (i.status === 'delivered') actual.entregado += i.quantity;
    porProducto.set(i.campaignProductId, actual);
  }
  return [...porProducto.entries()].map(([campaignProductId, v]) => ({ campaignProductId, ...v }));
}

export interface ResumenDeLogistica extends LogisticaDerivada {
  /** Unidades comprometidas en el acuerdo vigente (`null` si el actor no ve acuerdos o no hay acuerdo activo). */
  readonly comprometidas: number | null;
  readonly enviadas: number;
  readonly entregadas: number;
  /** ¿Algún envío referencia datos personales? (el dato mismo vive cifrado en otro módulo). */
  readonly tienePii: boolean;
}

// ─────────────────────────── Facturación y pago ────────────────────────────────

export interface ResumenDeFacturacion {
  readonly documentos: {
    readonly registrados: number;
    readonly validados: number;
    readonly rechazados: number;
    readonly anulados: number;
  };
}

export interface ResumenDePago {
  /** `null` sin acuerdo (no hay obligación). */
  readonly seguimiento: PaymentTracking | null;
  /** Estado crudo de la obligación (`null` sin acuerdo). */
  readonly obligacion: PaymentObligationStatus | null;
}

export function contarDocumentos(
  statuses: readonly BillingDocumentStatus[],
): ResumenDeFacturacion['documentos'] {
  const n = (s: BillingDocumentStatus): number => statuses.filter((x) => x === s).length;
  return {
    registrados: n('registered'),
    validados: n('validated'),
    rechazados: n('rejected'),
    anulados: n('voided'),
  };
}

/**
 * Seguimiento de pago de la participación. Un canje PURO (barter) es `not_applicable` salvo que ya conste un pago
 * reportado: jamás `pending_*`, aunque la obligación estuviera mal sembrada (defensa; la base ya lo impone con
 * su invariante diferido de la 027). Sin acuerdo ⇒ `seguimiento: null`.
 */
export function derivarPagoDeParticipacion(entrada: {
  readonly modo: CompensationType | null;
  readonly obligacion: PaymentObligationStatus | null;
  readonly documentos: readonly BillingDocumentStatus[];
}): ResumenDePago {
  if (entrada.obligacion === null) return { seguimiento: null, obligacion: null };
  if (entrada.modo === 'barter' && entrada.obligacion !== 'reported_paid') {
    return { seguimiento: 'not_applicable', obligacion: entrada.obligacion };
  }
  return {
    seguimiento: derivarSeguimientoDePago(entrada.obligacion, entrada.documentos),
    obligacion: entrada.obligacion,
  };
}

/** «Pago pendiente»: se espera un pago y aún no se reportó (falta documento, validación o el pago mismo). */
export function esPagoPendiente(seguimiento: PaymentTracking | null): boolean {
  return (
    seguimiento === 'pending_document' ||
    seguimiento === 'document_received' ||
    seguimiento === 'pending_payment'
  );
}

// ─────────────────────────── Contenido ─────────────────────────────────────────

export type EstadoDeContenidoDeParticipacion =
  'sin_entregables' | 'sin_guion' | 'en_curso' | 'cambios_solicitados' | 'parcial' | 'aprobado';

export interface ResumenDeContenido {
  readonly estado: EstadoDeContenidoDeParticipacion;
  /** Entregables ACTIVOS. */
  readonly entregables: number;
  readonly porEstado: Readonly<Record<ResumenDeEntregable, number>>;
}

const RESUMENES_DE_ENTREGABLE: readonly ResumenDeEntregable[] = [
  'sin_guion',
  'en_curso',
  'cambios_solicitados',
  'aprobado',
  'aprobado_con_nueva_en_revision',
] as const;

/**
 * Estado de contenido de la participación a partir del resumen de cada entregable activo:
 *   sin entregables ⇒ `sin_entregables`; todos `aprobado` ⇒ `aprobado`; alguno `cambios_solicitados` ⇒
 *   `cambios_solicitados`; alguno `en_curso` o `aprobado_con_nueva_en_revision` ⇒ `en_curso`; todos
 *   `sin_guion` ⇒ `sin_guion`; si no (mezcla de aprobados y sin guion) ⇒ `parcial`.
 */
export function derivarEstadoDeContenido(resumenes: readonly ResumenDeEntregable[]): ResumenDeContenido {
  const porEstado = Object.fromEntries(
    RESUMENES_DE_ENTREGABLE.map((r) => [r, resumenes.filter((x) => x === r).length]),
  ) as Record<ResumenDeEntregable, number>;
  const total = resumenes.length;
  let estado: EstadoDeContenidoDeParticipacion;
  if (total === 0) estado = 'sin_entregables';
  else if (porEstado.aprobado === total) estado = 'aprobado';
  else if (porEstado.cambios_solicitados > 0) estado = 'cambios_solicitados';
  else if (porEstado.en_curso > 0 || porEstado.aprobado_con_nueva_en_revision > 0) estado = 'en_curso';
  else if (porEstado.sin_guion === total) estado = 'sin_guion';
  else estado = 'parcial';
  return { estado, entregables: total, porEstado };
}

// ─────────────────────────── Composición ───────────────────────────────────────

/**
 * Resumen compuesto de UNA participación. Las claves de una sección sin permiso NO existen. `facturacion` y
 * `pago` pertenecen a la sección `facturacion_pagos` (`finance:read`). `kpi` lo define quien lo conecta.
 */
export interface ResumenOperativoDeParticipacion<
  Kpi = unknown,
  Acuerdo = ResumenDeAcuerdo,
  Logistica = ResumenDeLogistica,
  Facturacion = ResumenDeFacturacion,
  Pago = ResumenDePago,
  Contenido = ResumenDeContenido,
> {
  readonly acuerdo?: Acuerdo;
  readonly logistica?: Logistica;
  readonly facturacion?: Facturacion;
  readonly pago?: Pago;
  readonly contenido?: Contenido;
  readonly kpi?: Kpi | null;
}

export interface PartesDelResumenOperativo<Kpi, Acuerdo, Logistica, Facturacion, Pago, Contenido> {
  readonly acuerdo?: Acuerdo | undefined;
  readonly logistica?: Logistica | undefined;
  readonly facturacion?: Facturacion | undefined;
  readonly pago?: Pago | undefined;
  readonly contenido?: Contenido | undefined;
  readonly kpi?: Kpi | null | undefined;
}

/**
 * Compone el resumen dejando SOLO las secciones que el rol puede ver, aunque quien llame pase de más (defensa en
 * profundidad: el caso de uso ni siquiera consulta lo que no está permitido). Sin `operations:read` ⇒ `{}`.
 */
export function componerResumenOperativo<
  Kpi = unknown,
  Acuerdo = ResumenDeAcuerdo,
  Logistica = ResumenDeLogistica,
  Facturacion = ResumenDeFacturacion,
  Pago = ResumenDePago,
  Contenido = ResumenDeContenido,
>(
  role: Role,
  partes: PartesDelResumenOperativo<Kpi, Acuerdo, Logistica, Facturacion, Pago, Contenido>,
): ResumenOperativoDeParticipacion<Kpi, Acuerdo, Logistica, Facturacion, Pago, Contenido> {
  const ve = (s: SeccionOperativa): boolean => puedeVerSeccionOperativa(role, s);
  return {
    ...(ve('acuerdo') && partes.acuerdo !== undefined ? { acuerdo: partes.acuerdo } : {}),
    ...(ve('logistica') && partes.logistica !== undefined ? { logistica: partes.logistica } : {}),
    ...(ve('facturacion_pagos') && partes.facturacion !== undefined
      ? { facturacion: partes.facturacion }
      : {}),
    ...(ve('facturacion_pagos') && partes.pago !== undefined ? { pago: partes.pago } : {}),
    ...(ve('contenido') && partes.contenido !== undefined ? { contenido: partes.contenido } : {}),
    ...(ve('kpi') && partes.kpi !== undefined ? { kpi: partes.kpi } : {}),
  };
}

// ─────────────────────────── Filtros de la lista ───────────────────────────────

export interface FiltrosOperativos {
  /** Solo las participaciones con logística pendiente (ver `esLogisticaPendiente`). Exige `shipment:read`. */
  readonly logisticaPendiente?: boolean | undefined;
  /** Solo las que esperan un pago aún no reportado (ver `esPagoPendiente`). Exige `finance:read`. */
  readonly pagoPendiente?: boolean | undefined;
  /** Solo las participaciones sin acuerdo. Exige `agreement:read`. */
  readonly sinAcuerdo?: boolean | undefined;
}

const SECCION_DE_FILTRO: Readonly<Record<keyof FiltrosOperativos, SeccionOperativa>> = {
  logisticaPendiente: 'logistica',
  pagoPendiente: 'facturacion_pagos',
  sinAcuerdo: 'acuerdo',
};

/**
 * Valida que el rol pueda usar cada filtro pedido: filtrar por una sección que no puede ver sería una forma de
 * leerla. Un filtro `false`/ausente no cuenta. Devuelve los filtros normalizados (solo los activos).
 */
export function validarFiltrosOperativos(
  role: Role,
  filtros: FiltrosOperativos | undefined,
): Result<FiltrosOperativos> {
  const activos: { -readonly [K in keyof FiltrosOperativos]: boolean } = {};
  for (const clave of Object.keys(SECCION_DE_FILTRO) as (keyof FiltrosOperativos)[]) {
    const valor = filtros?.[clave];
    if (valor === undefined || valor === false) continue;
    if (valor !== true) {
      return err({
        code: 'VALIDATION_FAILED',
        message: `El filtro ${clave} debe ser verdadero o falso.`,
        details: { field: clave },
      });
    }
    const seccion = SECCION_DE_FILTRO[clave];
    if (!puedeVerSeccionOperativa(role, seccion)) {
      return err({
        code: 'FORBIDDEN_ROLE',
        message: `El rol ${role} no puede filtrar por ${clave}.`,
        details: { filter: clave, capability: CAPACIDAD_POR_SECCION[seccion] },
      });
    }
    activos[clave] = true;
  }
  return ok(activos);
}

/** Datos mínimos de una participación para evaluar los filtros. */
export interface DatosParaFiltrar {
  readonly acuerdo?: Pick<ResumenDeAcuerdo, 'estado'> | undefined;
  readonly logistica?: Pick<ResumenDeLogistica, 'estado' | 'abiertos'> | undefined;
  readonly pago?: Pick<ResumenDePago, 'seguimiento'> | undefined;
  /** ¿El acuerdo vigente compromete producto? (para `logisticaPendiente` sin envíos). */
  readonly tieneCompromisos?: boolean | undefined;
}

/** Los filtros se combinan con Y. Un filtro cuya sección falta en `datos` no se cumple (nunca se asume). */
export function cumpleFiltrosOperativos(datos: DatosParaFiltrar, filtros: FiltrosOperativos): boolean {
  if (filtros.sinAcuerdo === true && datos.acuerdo?.estado !== 'sin_acuerdo') return false;
  if (filtros.logisticaPendiente === true) {
    if (datos.logistica === undefined) return false;
    const pendiente = esLogisticaPendiente({
      estado: datos.logistica.estado,
      abiertos: datos.logistica.abiertos,
      tieneCompromisos: datos.tieneCompromisos === true,
    });
    if (!pendiente) return false;
  }
  if (filtros.pagoPendiente === true && !esPagoPendiente(datos.pago?.seguimiento ?? null)) return false;
  return true;
}
