/**
 * Vista operativa PARA EL AGENTE DE CUENTA (V2 · Fase 8, DEC-049): lo que las tools `operations_summary_list` y
 * `operations_participation_status` pueden devolver. Exports SOLO para el agente (no se usan en la UI).
 *
 * El DTO NO tiene, por construcción, ninguno de estos datos —ni siquiera para un admin—: dinero (fee, montos,
 * moneda), facturación, pagos, costos de envío, guía, transportadora, datos personales, notas, referencias
 * externas ni nombres de archivo. No hay una sección de finanzas: `facturacion_pagos` JAMÁS se ejecuta aquí (no
 * se consulta y luego se oculta: ni se toca la tabla), y cada campo del DTO se copia uno a uno desde la
 * derivación (nunca se esparce un objeto de la base).
 *
 * Contiene solo: la participación (id, influencerId, nombre visible), el acuerdo (modo, estado, versión,
 * fechas), productos comprometidos vs enviados vs entregados por producto, el estado logístico, el estado de
 * contenido y el KPI (agregado; lo conecta quien llama con `ProveedoresOperativos.seccionKpi`).
 *
 * Los nombres del influencer y de los productos son datos NO CONFIABLES (los escribió una persona o vienen de un
 * documento): el DTO los marca `untrusted: true` para que la tool los envuelva en el sobre de contenido no
 * confiable. Aquí no se arma ese sobre.
 *
 * Capacidades: `operations:read` y, para incluir cada sección, la suya (`agreement:read`, `shipment:read`,
 * `deliverable:read`, `kpi:read`). Cliente y otra organización ⇒ `RESOURCE_NOT_FOUND`; analista y legal ⇒
 * `FORBIDDEN_ROLE`.
 */

import {
  type CompensationType,
  type EstadoDeAcuerdoEnResumen,
  type EstadoDeContenidoDeParticipacion,
  type EstadoLogisticoDerivado,
  type FiltrosOperativos,
  type ResumenDeEntregable,
  type Result,
  type SeccionOperativa,
  type ShipmentStatus,
  type User,
  cumpleFiltrosOperativos,
  err,
  ok,
  seccionesPermitidas,
  validarFiltrosOperativos,
} from '@tcl-kol-os/domain';
import { getPool } from './client.ts';
import {
  type ConteosOperativos,
  type DerivadoDeParticipacion,
  type OpcionesDeResumenOperativo,
  type ProveedoresOperativos,
  proveedorKpi,
  autorizarCampanaOperativa,
  autorizarParticipacionOperativa,
  cargarDatosOperativos,
  contarOperativos,
  datosParaFiltrar,
  derivarDeParticipacion,
  paginaDe,
  seccionesAEjecutar,
} from './operativo-views.ts';

// ─────────────────────────── DTO ───────────────────────────────────────────────

/** Texto que escribió una persona o vino de un documento: la tool lo envuelve en el sobre no confiable. */
export interface TextoNoConfiable {
  readonly valor: string;
  readonly untrusted: true;
}

function noConfiable(valor: string): TextoNoConfiable {
  return { valor, untrusted: true };
}

export interface ProductoParaAgente {
  /** `campaign_products.id`. */
  readonly campaignProductId: string;
  /** Nombre del producto en la campaña (NO CONFIABLE). */
  readonly nombre: TextoNoConfiable;
  readonly comprometido: number;
  /** En envíos que ya salieron y no fallaron ni volvieron (`shipped` o `delivered`). */
  readonly enviado: number;
  /** En envíos `delivered`. */
  readonly entregado: number;
}

export interface AcuerdoParaAgente {
  readonly estado: EstadoDeAcuerdoEnResumen;
  readonly modo: CompensationType | null;
  readonly version: number | null;
  /** `YYYY-MM-DD` o `null`. */
  readonly inicio: string | null;
  readonly fin: string | null;
}

export interface LogisticaParaAgente {
  readonly estado: EstadoLogisticoDerivado;
  readonly abiertos: number;
  readonly ultimoEstado: ShipmentStatus | null;
  readonly productos: readonly ProductoParaAgente[];
}

export interface ContenidoParaAgente {
  readonly estado: EstadoDeContenidoDeParticipacion;
  readonly entregables: number;
  readonly porEstado: Readonly<Record<ResumenDeEntregable, number>>;
}

export interface ParticipacionParaAgente<Kpi = unknown> {
  readonly participacionId: string;
  readonly influencerId: string;
  /** Nombre visible del influencer (NO CONFIABLE). */
  readonly nombre: TextoNoConfiable;
  readonly estadoDeParticipacion: 'activo' | 'retirado';
  readonly acuerdo?: AcuerdoParaAgente;
  readonly logistica?: LogisticaParaAgente;
  readonly contenido?: ContenidoParaAgente;
  readonly kpi?: Kpi | null;
}

export type ConteosParaAgente = Pick<
  ConteosOperativos,
  'participaciones' | 'sinAcuerdo' | 'logisticaPendiente'
>;

export interface ResumenOperativoParaAgente<Kpi = unknown> {
  readonly campaignId: string;
  /** Secciones incluidas (nunca `facturacion_pagos`). */
  readonly secciones: readonly SeccionOperativa[];
  readonly items: readonly ParticipacionParaAgente<Kpi>[];
  readonly total: number;
  readonly limite: number;
  readonly desde: number;
  readonly conteos: ConteosParaAgente;
}

export interface EstadoOperativoParaAgente<Kpi = unknown> extends ParticipacionParaAgente<Kpi> {
  readonly campaignId: string;
  readonly secciones: readonly SeccionOperativa[];
}

/** Filtros que el agente puede pedir. `pagoPendiente` no existe para él (los pagos no son suyos). */
export type FiltrosParaAgente = Pick<FiltrosOperativos, 'logisticaPendiente' | 'sinAcuerdo'> &
  OpcionesDeResumenOperativo;

// ─────────────────────────── Construcción del DTO ──────────────────────────────

/** Secciones que el agente puede recibir: las del rol MENOS finanzas, siempre. */
function seccionesDelAgente(actor: User): Set<SeccionOperativa> {
  return seccionesAEjecutar(actor, ['facturacion_pagos']);
}

function aParticipacionParaAgente<Kpi>(
  fila: { id: string; influencer_id: string; display_name: string; status: 'activo' | 'retirado' },
  d: DerivadoDeParticipacion,
  secciones: ReadonlySet<SeccionOperativa>,
  kpi: Kpi | null | undefined,
): ParticipacionParaAgente<Kpi> {
  return {
    participacionId: fila.id,
    influencerId: fila.influencer_id,
    nombre: noConfiable(fila.display_name),
    estadoDeParticipacion: fila.status,
    ...(secciones.has('acuerdo') && d.acuerdo !== undefined
      ? {
          acuerdo: {
            estado: d.acuerdo.estado,
            modo: d.acuerdo.modo,
            version: d.acuerdo.version,
            inicio: d.vigencia?.desde ?? null,
            fin: d.vigencia?.hasta ?? null,
          },
        }
      : {}),
    ...(secciones.has('logistica') && d.logistica !== undefined
      ? {
          logistica: {
            estado: d.logistica.estado,
            abiertos: d.logistica.abiertos,
            ultimoEstado: d.logistica.ultimoEstado,
            productos: (d.progreso ?? []).map((p) => ({
              campaignProductId: p.campaignProductId,
              nombre: noConfiable(p.nombre),
              comprometido: p.comprometido,
              enviado: p.enviado,
              entregado: p.entregado,
            })),
          },
        }
      : {}),
    ...(secciones.has('contenido') && d.contenido !== undefined
      ? {
          contenido: {
            estado: d.contenido.estado,
            entregables: d.contenido.entregables,
            porEstado: { ...d.contenido.porEstado },
          },
        }
      : {}),
    ...(secciones.has('kpi') ? { kpi: kpi ?? null } : {}),
  };
}

// ─────────────────────────── Resumen de campaña ────────────────────────────────

/**
 * Resumen operativo de la campaña para el agente: una entrada por participación, con filtros (logística
 * pendiente, sin acuerdo), conteos y paginación. Sin dinero, pagos, facturación ni PII, aunque el actor sea admin.
 * Consultas por LOTES (el número no depende del de participaciones).
 */
export async function obtenerResumenOperativoParaAgente<Kpi = unknown>(
  actor: User,
  campaignId: string,
  filtros: FiltrosParaAgente = {},
  proveedores: ProveedoresOperativos<Kpi> = {},
): Promise<Result<ResumenOperativoParaAgente<Kpi>>> {
  if ((filtros as { pagoPendiente?: unknown }).pagoPendiente !== undefined) {
    return err({
      code: 'FORBIDDEN_ROLE',
      message: 'El agente no filtra ni consulta pagos.',
      details: { filter: 'pagoPendiente' },
    });
  }
  const campana = await autorizarCampanaOperativa(actor, campaignId);
  if (!campana.ok) return campana;
  const validos = validarFiltrosOperativos(actor.role, {
    logisticaPendiente: filtros.logisticaPendiente,
    sinAcuerdo: filtros.sinAcuerdo,
  });
  if (!validos.ok) return validos;

  const secciones = seccionesDelAgente(actor);
  const datos = await cargarDatosOperativos(
    getPool(),
    { campaignId, organizationId: campana.value.organizationId, incluirRetirados: filtros.incluirRetirados },
    secciones,
  );
  const derivados = datos.participaciones.map((fila) => ({
    fila,
    derivado: derivarDeParticipacion(datos, fila.id, secciones),
  }));
  const conteos = contarOperativos(
    derivados.map((d) => d.derivado),
    secciones,
  );
  const coinciden = derivados.filter((d) =>
    cumpleFiltrosOperativos(datosParaFiltrar(d.derivado), validos.value),
  );
  const { limite, desde } = paginaDe(filtros);
  const pagina = coinciden.slice(desde, desde + limite);

  const kpis =
    secciones.has('kpi') && pagina.length > 0
      ? await proveedorKpi(proveedores)({ actor, campaignId, participacionIds: pagina.map((p) => p.fila.id) })
      : undefined;

  return ok({
    campaignId,
    secciones: seccionesPermitidas(actor.role).filter((s) => secciones.has(s)),
    items: pagina.map((p) => aParticipacionParaAgente(p.fila, p.derivado, secciones, kpis?.get(p.fila.id))),
    total: coinciden.length,
    limite,
    desde,
    conteos: {
      participaciones: conteos.participaciones,
      ...(conteos.sinAcuerdo === undefined ? {} : { sinAcuerdo: conteos.sinAcuerdo }),
      ...(conteos.logisticaPendiente === undefined ? {} : { logisticaPendiente: conteos.logisticaPendiente }),
    },
  });
}

// ─────────────────────────── Estado de una participación ───────────────────────

/**
 * Estado operativo de UNA participación para el agente (mismo DTO que cada entrada del resumen, más la campaña
 * y las secciones incluidas). Participación inexistente, de otra organización o `cliente` ⇒ `RESOURCE_NOT_FOUND`.
 */
export async function obtenerEstadoOperativoParaAgente<Kpi = unknown>(
  actor: User,
  campaignInfluencerId: string,
  proveedores: ProveedoresOperativos<Kpi> = {},
): Promise<Result<EstadoOperativoParaAgente<Kpi>>> {
  const p = await autorizarParticipacionOperativa(actor, campaignInfluencerId);
  if (!p.ok) return p;
  const secciones = seccionesDelAgente(actor);
  const datos = await cargarDatosOperativos(
    getPool(),
    { campaignId: p.value.campaignId, organizationId: p.value.organizationId, participacionId: p.value.id },
    secciones,
  );
  const fila = datos.participaciones[0];
  if (fila === undefined) {
    return err({
      code: 'RESOURCE_NOT_FOUND',
      message: 'El recurso no existe o no está disponible.',
      details: {},
    });
  }
  const derivado = derivarDeParticipacion(datos, fila.id, secciones);
  const kpis = secciones.has('kpi')
    ? await proveedorKpi(proveedores)({
        actor,
        campaignId: p.value.campaignId,
        participacionIds: [fila.id],
      })
    : undefined;
  return ok({
    campaignId: p.value.campaignId,
    secciones: seccionesPermitidas(actor.role).filter((s) => secciones.has(s)),
    ...aParticipacionParaAgente(fila, derivado, secciones, kpis?.get(fila.id)),
  });
}
