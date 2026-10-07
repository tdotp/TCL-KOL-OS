/**
 * LOADERS de Operación (V2 · Fase 8). Solo de servidor: los llaman las páginas de
 * `/campanas/[id]/operacion/**` (server components), jamás un componente de cliente.
 *
 * Cada loader recibe la PERSONA ya resuelta (`currentUser()`), comprueba antes de todo que su rol tiene
 * `operations:read` y traduce el `Result` del caso de uso a datos o a `notFound()`:
 *  · un id con mala forma, un recurso inexistente, ajeno (otra organización), de un rol sin acceso (cliente,
 *    analista, legal) o de otra campaña dan EXACTAMENTE el mismo 404: no se distingue «no existe» de
 *    «no autorizado»;
 *  · lo que cada rol puede ver ya lo proyecta el caso de uso por capacidad (el consultor no recibe dinero; la
 *    PII solo existe como resumen de qué campos hay). Aquí no se filtra de nuevo, solo se evita CONSULTAR lo
 *    que el rol no puede leer: los loaders de secciones opcionales devuelven `null` (no 404) si el rol
 *    carece de la capacidad de esa sección; usa `permisos` para decidir qué renderizar.
 *
 * Nada de lo que se devuelve incluye valores de datos personales, contenido de archivos ni rutas de
 * almacenamiento.
 */

import { notFound } from 'next/navigation';
import {
  type AcuerdoVista,
  type DocumentoDeCobroVista,
  type EnvioVista,
  type EstadoOperativoDeParticipacion,
  type EventoOperativo,
  type FiltrosDeResumenOperativo,
  type HistorialDeKpi,
  type KpiDeParticipacion,
  type KpiPactadoDelSheet,
  type ResumenOperativoDeCampana,
  type SeguimientoDePago,
  type VersionDeAcuerdoVista,
  esUuid,
  getCampaign,
  listarDocumentosDeCobro,
  listarEnviosDeParticipacion,
  listarEventosOperativos,
  listarEvidenciaDeSujeto,
  listarVersionesDeAcuerdo,
  obtenerAcuerdo,
  obtenerCampaignInfluencer,
  obtenerEnvio,
  obtenerEstadoOperativoDeParticipacion,
  obtenerHistorialDeKpi,
  obtenerKpiDeParticipacion,
  obtenerKpiPactadoDelSheet,
  obtenerPiiResumen,
  obtenerResumenOperativoDeCampana,
  obtenerSeguimientoDePago,
} from '@tcl-kol-os/db';
import {
  type EvidenceKind,
  type KpiMetric,
  type OperationalSubjectType,
  type PiiSummary,
  type ResumenKpi,
  type Result,
  type User,
  isKpiMetric,
  isOperationalSubjectType,
  puedeVerSeccionOperativa,
  readActionForSubject,
  roleCan,
} from '@tcl-kol-os/domain';
import { type PermisosDeOperacion, permisosDeOperacion } from './operacion-comun.ts';

// ─────────────────────────── Guardas y tipos comunes ───────────────────────────

/** Campaña tal como la necesitan las páginas (cabecera, nav, solo lectura si no está activa). */
export interface CampanaDeOperacion {
  readonly id: string;
  readonly name: string;
  /** `activa` | `archivada` | `cancelada`…: las escrituras solo se ofrecen con la campaña `activa`. */
  readonly status: string;
}

function desenvolver<T>(resultado: Result<T>): T {
  // Cualquier error (ajeno, inexistente, sin permiso, validación) es el mismo 404.
  if (!resultado.ok) return notFound();
  return resultado.value;
}

function exigirUuid(valor: string): string {
  return esUuid(valor) ? valor : notFound();
}

/** Rol con `operations:read` (cliente, analista y legal ⇒ 404). Se llama ANTES de consultar nada. */
function exigirOperacion(user: User): void {
  if (!roleCan(user.role, 'operations:read')) notFound();
}

async function campanaDe(user: User, campaignId: string): Promise<CampanaDeOperacion> {
  const campana = desenvolver(await getCampaign(user, exigirUuid(campaignId)));
  const { id, name, status } = campana.campaign;
  return { id, name, status };
}

// ─────────────────────────── Lista de la campaña ───────────────────────────────

/** Filtros de la lista: se leen de la URL con `filtrosDeOperacionDesdeUrl`. */
export type FiltrosDeOperacion = FiltrosDeResumenOperativo;

export interface ResumenDeOperacion {
  readonly campana: CampanaDeOperacion;
  readonly resumen: ResumenOperativoDeCampana<ResumenKpi>;
  readonly permisos: PermisosDeOperacion;
}

/** Quita los filtros que el rol no puede usar (filtrar por una sección que no ve sería una forma de leerla). */
function filtrosPermitidos(user: User, filtros: FiltrosDeOperacion): FiltrosDeOperacion {
  return {
    ...(filtros.logisticaPendiente === true && puedeVerSeccionOperativa(user.role, 'logistica')
      ? { logisticaPendiente: true }
      : {}),
    ...(filtros.pagoPendiente === true && puedeVerSeccionOperativa(user.role, 'facturacion_pagos')
      ? { pagoPendiente: true }
      : {}),
    ...(filtros.sinAcuerdo === true && puedeVerSeccionOperativa(user.role, 'acuerdo')
      ? { sinAcuerdo: true }
      : {}),
    ...(filtros.incluirRetirados === true ? { incluirRetirados: true } : {}),
    ...(filtros.limite !== undefined ? { limite: filtros.limite } : {}),
    ...(filtros.desde !== undefined ? { desde: filtros.desde } : {}),
  };
}

/**
 * Resumen operativo de la campaña (una fila por participación, con conteos y filtros). Las secciones que el
 * rol no ve (dinero, KPI…) no existen en el resultado.
 */
export async function cargarResumenOperacion(
  user: User,
  campaignId: string,
  filtros: FiltrosDeOperacion = {},
): Promise<ResumenDeOperacion> {
  exigirOperacion(user);
  const campana = await campanaDe(user, campaignId);
  const resumen = desenvolver(
    await obtenerResumenOperativoDeCampana<ResumenKpi>(user, campana.id, filtrosPermitidos(user, filtros)),
  );
  return { campana, resumen, permisos: permisosDeOperacion(user.role) };
}

type ParametrosDeUrl = Readonly<Record<string, string | readonly string[] | undefined>>;

function primero(valor: string | readonly string[] | undefined): string | undefined {
  return typeof valor === 'string' ? valor : valor?.[0];
}

const esVerdadero = (valor: string | readonly string[] | undefined): boolean =>
  ['1', 'true', 'on'].includes(primero(valor) ?? '');

function enteroDeUrl(
  valor: string | readonly string[] | undefined,
  min: number,
  max: number,
): number | undefined {
  const texto = primero(valor);
  if (texto === undefined || !/^\d{1,6}$/u.test(texto)) return undefined;
  const n = Number(texto);
  return n >= min && n <= max ? n : undefined;
}

/**
 * Filtros de la lista a partir de `searchParams`: `logisticaPendiente=1`, `pagoPendiente=1`, `sinAcuerdo=1`,
 * `retirados=1`, `limite` (1–200) y `desde`. Valores raros se ignoran.
 */
export function filtrosDeOperacionDesdeUrl(params: ParametrosDeUrl): FiltrosDeOperacion {
  const limite = enteroDeUrl(params['limite'], 1, 200);
  const desde = enteroDeUrl(params['desde'], 0, 100000);
  return {
    ...(esVerdadero(params['logisticaPendiente']) ? { logisticaPendiente: true } : {}),
    ...(esVerdadero(params['pagoPendiente']) ? { pagoPendiente: true } : {}),
    ...(esVerdadero(params['sinAcuerdo']) ? { sinAcuerdo: true } : {}),
    ...(esVerdadero(params['retirados']) ? { incluirRetirados: true } : {}),
    ...(limite !== undefined ? { limite } : {}),
    ...(desde !== undefined ? { desde } : {}),
  };
}

// ─────────────────────────── Detalle de una participación ──────────────────────

export interface EstadoDeOperacion {
  readonly campana: CampanaDeOperacion;
  readonly estado: EstadoOperativoDeParticipacion<ResumenKpi>;
  readonly permisos: PermisosDeOperacion;
}

/**
 * Estado operativo de UNA participación (acuerdo, logística, facturación y pagos, contenido y KPI según el
 * rol). Pasa SIEMPRE `campaignId` (el de la URL): si la participación es de otra campaña, 404.
 */
export async function cargarEstadoOperativo(
  user: User,
  participacionId: string,
  campaignId?: string,
): Promise<EstadoDeOperacion> {
  exigirOperacion(user);
  const id = exigirUuid(participacionId);
  if (campaignId !== undefined) exigirUuid(campaignId);
  const estado = desenvolver(await obtenerEstadoOperativoDeParticipacion<ResumenKpi>(user, id));
  if (campaignId !== undefined && estado.campaignId !== campaignId.toLowerCase()) notFound();
  const campana = await campanaDe(user, estado.campaignId);
  return { campana, estado, permisos: permisosDeOperacion(user.role) };
}

/** Productos de la campaña asignados al influencer (para los selectores de compromisos y envíos). */
export interface ProductoAsignado {
  readonly campaignProductId: string;
  readonly brand: string;
  readonly model: string;
}

/** Solo marca y modelo: ni la identidad del influencer ni sus cuentas salen de aquí. */
export async function cargarProductosAsignados(
  user: User,
  participacionId: string,
): Promise<readonly ProductoAsignado[]> {
  exigirOperacion(user);
  const detalle = desenvolver(await obtenerCampaignInfluencer(user, exigirUuid(participacionId)));
  return detalle.products.map((p) => ({
    campaignProductId: p.campaignProductId,
    brand: p.brand,
    model: p.model,
  }));
}

// ─────────────────────────── Acuerdo ───────────────────────────────────────────

export interface AcuerdoConHistorial {
  /** `null` si la participación aún no tiene acuerdo. */
  readonly acuerdo: AcuerdoVista | null;
  /** Versiones inmutables de la 1 a la vigente, con sus compromisos de producto (sin dinero sin `finance:read`). */
  readonly versiones: readonly VersionDeAcuerdoVista[];
}

export async function cargarAcuerdoConHistorial(
  user: User,
  participacionId: string,
): Promise<AcuerdoConHistorial | null> {
  exigirOperacion(user);
  const id = exigirUuid(participacionId);
  if (!roleCan(user.role, 'agreement:read')) return null;
  const acuerdo = desenvolver(await obtenerAcuerdo(user, id));
  if (acuerdo === null) return { acuerdo: null, versiones: [] };
  const versiones = desenvolver(await listarVersionesDeAcuerdo(user, acuerdo.id));
  return { acuerdo, versiones };
}

// ─────────────────────────── Envíos ────────────────────────────────────────────

/** Envíos de la participación (estado, fechas, transportadora y guía; costo solo con `finance:read`). */
export async function cargarEnvios(
  user: User,
  participacionId: string,
): Promise<readonly EnvioVista[] | null> {
  exigirOperacion(user);
  const id = exigirUuid(participacionId);
  if (!roleCan(user.role, 'shipment:read')) return null;
  return desenvolver(await listarEnviosDeParticipacion(user, id));
}

export async function cargarEnvio(user: User, shipmentId: string): Promise<EnvioVista | null> {
  exigirOperacion(user);
  const id = exigirUuid(shipmentId);
  if (!roleCan(user.role, 'shipment:read')) return null;
  return desenvolver(await obtenerEnvio(user, id));
}

// ─────────────────────────── Facturación y pagos (finance:read) ────────────────

/**
 * Obligación de pago, documentos de cobro y seguimiento derivado. `null` si el rol no tiene `finance:read` o
 * si la participación aún no tiene acuerdo (distingue con `permisos.verFinanzas`).
 */
export async function cargarSeguimientoDePago(
  user: User,
  participacionId: string,
): Promise<SeguimientoDePago | null> {
  exigirOperacion(user);
  const id = exigirUuid(participacionId);
  if (!roleCan(user.role, 'finance:read')) return null;
  return desenvolver(await obtenerSeguimientoDePago(user, id));
}

/** Documentos de cobro de una obligación. `null` si el rol no tiene `finance:read`. */
export async function cargarDocumentosDeCobro(
  user: User,
  paymentObligationId: string,
): Promise<readonly DocumentoDeCobroVista[] | null> {
  exigirOperacion(user);
  const id = exigirUuid(paymentObligationId);
  if (!roleCan(user.role, 'finance:read')) return null;
  return desenvolver(await listarDocumentosDeCobro(user, id));
}

// ─────────────────────────── Historial y evidencia ─────────────────────────────

export interface SujetoOperativo {
  readonly subjectType: OperationalSubjectType;
  readonly subjectId: string;
}

function sujetoValido(sujeto: SujetoOperativo): SujetoOperativo {
  if (!isOperationalSubjectType(sujeto.subjectType)) return notFound();
  return { subjectType: sujeto.subjectType, subjectId: exigirUuid(sujeto.subjectId) };
}

/**
 * Historial de eventos de un envío, documento de cobro u obligación de pago. Capacidad según el sujeto:
 * envío ⇒ `shipment:read`; documento y pago ⇒ `finance:read` (si falta: `null`). La nota y la referencia
 * externa solo vienen para quien gestiona el sujeto.
 */
export async function cargarEventosOperativos(
  user: User,
  sujeto: SujetoOperativo,
): Promise<readonly EventoOperativo[] | null> {
  exigirOperacion(user);
  const valido = sujetoValido(sujeto);
  if (!roleCan(user.role, readActionForSubject(valido.subjectType))) return null;
  return desenvolver(await listarEventosOperativos(user, valido));
}

/** Evidencia como la ve la interfaz: metadatos, nunca el contenido ni el id de la fuente. */
export interface EvidenciaDeOperacion {
  readonly id: string;
  readonly eventId: string;
  readonly eventType: string;
  readonly kind: EvidenceKind;
  readonly filename: string;
  readonly mimeType: string | null;
  readonly sizeBytes: number | null;
  readonly hash: string | null;
  readonly attachedAt: string;
  /** `null` = vigente. */
  readonly retractedAt: string | null;
}

/** Evidencia de todos los eventos de un sujeto (misma capacidad que `cargarEventosOperativos`; si falta, `null`). */
export async function cargarEvidenciaDeSujeto(
  user: User,
  sujeto: SujetoOperativo,
): Promise<readonly EvidenciaDeOperacion[] | null> {
  exigirOperacion(user);
  const valido = sujetoValido(sujeto);
  if (!roleCan(user.role, readActionForSubject(valido.subjectType))) return null;
  const evidencia = desenvolver(await listarEvidenciaDeSujeto(user, valido));
  return evidencia.map((e) => ({
    id: e.id,
    eventId: e.eventId,
    eventType: e.eventType,
    kind: e.kind,
    filename: e.filename,
    mimeType: e.mimeType,
    sizeBytes: e.sizeBytes,
    hash: e.hash,
    attachedAt: e.attachedAt,
    retractedAt: e.retractedAt,
  }));
}

// ─────────────────────────── KPIs ──────────────────────────────────────────────

/** Marcador de KPIs (objetivo · actual · logro · estado). `null` sin `kpi:read`. */
export async function cargarKpiDeParticipacion(
  user: User,
  participacionId: string,
): Promise<KpiDeParticipacion | null> {
  exigirOperacion(user);
  const id = exigirUuid(participacionId);
  if (!roleCan(user.role, 'kpi:read')) return null;
  return desenvolver(await obtenerKpiDeParticipacion(user, id));
}

/** Historial completo de KPIs (opcionalmente de una métrica del catálogo; otra se ignora). `null` sin `kpi:read`. */
export async function cargarHistorialDeKpi(
  user: User,
  participacionId: string,
  metric?: string,
): Promise<HistorialDeKpi | null> {
  exigirOperacion(user);
  const id = exigirUuid(participacionId);
  if (!roleCan(user.role, 'kpi:read')) return null;
  const metrica: KpiMetric | undefined = isKpiMetric(metric) ? metric : undefined;
  return desenvolver(
    await obtenerHistorialDeKpi(user, {
      campaignInfluencerId: id,
      ...(metrica !== undefined ? { metric: metrica } : {}),
    }),
  );
}

/**
 * KPI pactado en el Sheet: una SUGERENCIA (texto literal de un tercero: NO CONFIABLE, se muestra como texto
 * y nunca se interpreta). `null` si el rol no puede fijar objetivos o si no hay nada pactado en el Sheet.
 */
export async function cargarKpiPactadoDelSheet(
  user: User,
  participacionId: string,
): Promise<KpiPactadoDelSheet | null> {
  exigirOperacion(user);
  const id = exigirUuid(participacionId);
  if (!roleCan(user.role, 'kpi:target_manage')) return null;
  return desenvolver(await obtenerKpiPactadoDelSheet(user, id));
}

// ─────────────────────────── Datos personales (solo resumen) ───────────────────

/**
 * QUÉ campos de datos personales existen para el influencer de la participación y de qué versión: JAMÁS los
 * valores (esos solo salen por `revelarPiiAction`, por clic). `null` si el rol no tiene `pii:read` ni
 * `pii:manage`, o si aún no hay registro.
 */
export async function cargarResumenPii(user: User, participacionId: string): Promise<PiiSummary | null> {
  exigirOperacion(user);
  const id = exigirUuid(participacionId);
  if (!roleCan(user.role, 'pii:read') && !roleCan(user.role, 'pii:manage')) return null;
  const participacion = desenvolver(await obtenerCampaignInfluencer(user, id));
  return desenvolver(await obtenerPiiResumen(user, participacion.campaignInfluencer.influencerId));
}
