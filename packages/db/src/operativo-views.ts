/**
 * Read models del Operativo (V2 · Fase 8, DEC-049): resumen de campaña por participación y estado detallado de
 * una participación. Solo COMPONEN lo que cada dominio ya guarda (acuerdo, envíos, documentos de cobro,
 * obligación de pago, entregables): ninguno escribe, y nada se duplica en `campaign_influencers.status`.
 *
 * Capacidades (dentro de la consulta, no en la página):
 *   · TODO exige `operations:read` (admin, director, consultor, operativo). Cliente y otra organización ⇒
 *     `RESOURCE_NOT_FOUND`; analista y legal ⇒ `FORBIDDEN_ROLE`.
 *   · Cada sección se EJECUTA solo si el actor tiene su capacidad (no se consulta y luego se oculta):
 *     acuerdo `agreement:read`, logística `shipment:read`, facturación y pagos `finance:read`, contenido
 *     `deliverable:read`, KPI `kpi:read`. Una sección sin permiso NO existe en el objeto.
 *   · Dinero (fee, costo de envío, montos de cobro) solo con `finance:read`. El consultor ve el acuerdo sin
 *     montos y la logística sin costo, y no ve facturación ni pagos.
 *   · JAMÁS dirección, teléfono ni cédula (a lo sumo el booleano `tienePii` de la logística). Tampoco notas,
 *     referencias externas, nombres de archivo de evidencia, guía ni transportadora: eso vive en los módulos
 *     de cada dominio con su propia capacidad.
 *
 * La LISTA se arma con consultas por LOTES de toda la campaña (≈10, constantes, con columnas de lista blanca:
 * nunca `SELECT *` ni una consulta por participación) y deriva cada estado con las funciones puras de
 * `operational-summary.ts`. El DETALLE reutiliza los casos de uso existentes (`obtenerAcuerdo`,
 * `listarEnviosDeParticipacion`, `obtenerSeguimientoDePago`, `listarEntregablesDeCampana`).
 *
 * KPI: `seccionKpi` es un parámetro INTERNO opcional (`ProveedoresOperativos`), no una dependencia de este
 * módulo: quien lo cablea pasa un proveedor (p. ej. sobre `obtenerResumenKpiDeCampana`). Sin proveedor, un actor
 * con `kpi:read` recibe `kpi: null` (la sección existe pero aún no hay datos conectados).
 */

import type pg from 'pg';
import {
  type BillingDocumentStatus,
  type CompensationType,
  type DatosParaFiltrar,
  type FiltrosOperativos,
  type PaymentObligationStatus,
  type ProgresoDeProducto,
  type ResumenDeAcuerdo,
  type ResumenDeContenido,
  type ResumenDeEntregable,
  type ResumenDeFacturacion,
  type ResumenDeLogistica,
  type ResumenDePago,
  type ResumenKpi,
  type ResumenOperativoDeParticipacion,
  type Result,
  type SeccionOperativa,
  type ShipmentStatus,
  type User,
  authorizeInternalResource,
  calcularProgresoDeProductos,
  componerResumenOperativo,
  contarDocumentos,
  cumpleFiltrosOperativos,
  derivarEstadoDeContenido,
  derivarEstadoLogistico,
  derivarPagoDeParticipacion,
  err,
  esLogisticaPendiente,
  esPagoPendiente,
  ok,
  puedeVerSeccionOperativa,
  resumenDeEntregable,
  resumirAcuerdo,
  seccionesPermitidas,
  validarFiltrosOperativos,
} from '@tcl-kol-os/domain';
import { obtenerAcuerdo } from './agreements.ts';
import { obtenerSeguimientoDePago } from './billing-payment.ts';
import { getPool } from './client.ts';
import { NO_ENCONTRADO_DE_CONTENIDO, esUuid, listarEntregablesDeCampana } from './deliverables.ts';
import { obtenerResumenKpiDeCampana } from './kpi-views.ts';
import { listarEnviosDeParticipacion } from './shipments.ts';

type Consultor = pg.Pool | pg.PoolClient;

// ─────────────────────────── Proveedor de KPI (parámetro interno) ──────────────

/**
 * Proveedor de la sección KPI. Recibe el actor (que YA tiene `kpi:read`), la campaña y las participaciones de la
 * página, y devuelve lo que corresponda a cada una (`null`/ausente = sin datos). Se llama UNA vez por consulta.
 */
export type SeccionKpi<Kpi> = (entrada: {
  readonly actor: User;
  readonly campaignId: string;
  readonly participacionIds: readonly string[];
}) => Promise<ReadonlyMap<string, Kpi | null>>;

export interface ProveedoresOperativos<Kpi = unknown> {
  readonly seccionKpi?: SeccionKpi<Kpi> | undefined;
}

/**
 * Proveedor por defecto: el resumen de KPI de `kpi-views.ts` (consulta por lotes). El actor YA tiene `kpi:read`
 * (la sección solo se ejecuta si lo tiene); si la lectura falla, la sección queda vacía, nunca el resumen entero.
 */
const kpiPorDefecto: SeccionKpi<ResumenKpi> = async ({ actor, campaignId, participacionIds }) => {
  const r = await obtenerResumenKpiDeCampana(actor, campaignId);
  const salida = new Map<string, ResumenKpi | null>();
  for (const id of participacionIds) salida.set(id, r.ok ? (r.value.get(id) ?? null) : null);
  return salida;
};

export function proveedorKpi<Kpi>(proveedores: ProveedoresOperativos<Kpi>): SeccionKpi<Kpi> {
  return proveedores.seccionKpi ?? (kpiPorDefecto as unknown as SeccionKpi<Kpi>);
}

// ─────────────────────────── Tipos ─────────────────────────────────────────────

export interface OpcionesDeResumenOperativo {
  /** Por defecto solo los activos; `true` incluye los retirados (historia). */
  readonly incluirRetirados?: boolean | undefined;
  /** 1–200 (por defecto 50). */
  readonly limite?: number | undefined;
  readonly desde?: number | undefined;
}

export type FiltrosDeResumenOperativo = FiltrosOperativos & OpcionesDeResumenOperativo;

export interface ParticipacionOperativa<Kpi = unknown> {
  readonly participacionId: string;
  readonly influencerId: string;
  /** Nombre visible del influencer: texto de una persona (NO CONFIABLE). */
  readonly nombre: string;
  readonly estadoDeParticipacion: 'activo' | 'retirado';
  readonly resumen: ResumenOperativoDeParticipacion<Kpi>;
}

/** Conteos sobre TODAS las participaciones consideradas (antes de filtrar). Una clave solo existe si el actor ve su sección. */
export interface ConteosOperativos {
  readonly participaciones: number;
  readonly sinAcuerdo?: number;
  readonly logisticaPendiente?: number;
  readonly pagoPendiente?: number;
}

export interface ResumenOperativoDeCampana<Kpi = unknown> {
  readonly campaignId: string;
  /** Secciones que el actor puede ver. */
  readonly secciones: readonly SeccionOperativa[];
  readonly items: readonly ParticipacionOperativa<Kpi>[];
  /** Total que cumple los filtros (independiente de la página). */
  readonly total: number;
  readonly limite: number;
  readonly desde: number;
  readonly conteos: ConteosOperativos;
}

export interface DetalleDeAcuerdo extends ResumenDeAcuerdo {
  /** `null` sin acuerdo. */
  readonly id: string | null;
  readonly vigencia: { readonly desde: string | null; readonly hasta: string | null } | null;
  /** Productos COMPROMETIDOS en la versión vigente. */
  readonly productos: readonly {
    readonly campaignProductId: string;
    readonly producto: string;
    readonly cantidad: number;
  }[];
  readonly canceladoEn: string | null;
  /** SOLO con `finance:read`. */
  readonly dinero?: { readonly monto: string | null; readonly moneda: string | null };
}

export interface DetalleDeEnvio {
  readonly id: string;
  readonly estado: ShipmentStatus;
  /** `expectedSeq` de la próxima transición. */
  readonly rowSeq: number;
  readonly enviadoEl: string | null;
  readonly entregadoEl: string | null;
  readonly items: readonly {
    readonly campaignProductId: string;
    readonly producto: string;
    readonly cantidad: number;
  }[];
  readonly tienePii: boolean;
  /** SOLO con `finance:read`. */
  readonly costoDeEnvio?: { readonly monto: string | null; readonly moneda: string | null };
}

export interface DetalleDeLogistica extends ResumenDeLogistica {
  readonly envios: readonly DetalleDeEnvio[];
  readonly productos: readonly ProgresoDeProducto[];
}

export interface DetalleDeFacturacion extends ResumenDeFacturacion {
  readonly lista: readonly {
    readonly id: string;
    readonly numero: string;
    readonly emitidoEl: string;
    readonly estado: BillingDocumentStatus;
    readonly rowSeq: number;
    readonly montoReclamado: string;
    readonly monedaReclamada: string;
  }[];
}

export interface DetalleDePago extends ResumenDePago {
  readonly obligacionId: string | null;
  readonly rowSeq: number | null;
  readonly reportadoEl: string | null;
  readonly pagadoEl: string | null;
  readonly billingValidadoAlReportar: boolean | null;
}

export interface DetalleDeContenido extends ResumenDeContenido {
  readonly items: readonly {
    readonly id: string;
    readonly etiqueta: string;
    readonly plataforma: string | null;
    readonly estado: 'active' | 'archived';
    readonly resumen: ResumenDeEntregable;
    readonly ultimaVersion: { readonly numero: number; readonly estado: string } | null;
    readonly aprobadaVigente: { readonly numero: number; readonly aprobadaEl: string } | null;
  }[];
}

export interface EstadoOperativoDeParticipacion<Kpi = unknown> extends ResumenOperativoDeParticipacion<
  Kpi,
  DetalleDeAcuerdo,
  DetalleDeLogistica,
  DetalleDeFacturacion,
  DetalleDePago,
  DetalleDeContenido
> {
  readonly participacionId: string;
  readonly campaignId: string;
  readonly influencerId: string;
  /** Nombre visible del influencer: texto de una persona (NO CONFIABLE). */
  readonly nombre: string;
  readonly estadoDeParticipacion: 'activo' | 'retirado';
  readonly secciones: readonly SeccionOperativa[];
}

// ─────────────────────────── Autorización ──────────────────────────────────────

const LIMITE_MAXIMO = 200;
const LIMITE_POR_DEFECTO = 50;

function actorOError(actor: User): Result<User> {
  if (typeof actor !== 'object' || actor === null) {
    return err({ code: 'FORBIDDEN_ROLE', message: 'Esta consulta la hace una persona autorizada.' });
  }
  return ok(actor);
}

/** Campaña del actor con `operations:read` (o el error que corresponda). */
export async function autorizarCampanaOperativa(
  actor: User,
  campaignId: string,
): Promise<Result<{ organizationId: string }>> {
  const persona = actorOError(actor);
  if (!persona.ok) return persona;
  if (!esUuid(campaignId)) return err(NO_ENCONTRADO_DE_CONTENIDO);
  const { rows } = await getPool().query<{ organization_id: string }>(
    `SELECT organization_id FROM campaigns WHERE id = $1`,
    [campaignId],
  );
  if (rows[0] === undefined) return err(NO_ENCONTRADO_DE_CONTENIDO);
  const permitido = authorizeInternalResource(persona.value, 'operations:read', rows[0].organization_id);
  if (!permitido.ok) return permitido;
  return ok({ organizationId: rows[0].organization_id });
}

export interface ParticipacionAutorizada {
  readonly id: string;
  readonly organizationId: string;
  readonly campaignId: string;
  readonly influencerId: string;
  readonly nombre: string;
  readonly estado: 'activo' | 'retirado';
}

/** Participación del actor con `operations:read` (o el error que corresponda). */
export async function autorizarParticipacionOperativa(
  actor: User,
  campaignInfluencerId: string,
): Promise<Result<ParticipacionAutorizada>> {
  const persona = actorOError(actor);
  if (!persona.ok) return persona;
  if (!esUuid(campaignInfluencerId)) return err(NO_ENCONTRADO_DE_CONTENIDO);
  const { rows } = await getPool().query<{
    id: string;
    organization_id: string;
    campaign_id: string;
    influencer_id: string;
    status: 'activo' | 'retirado';
    display_name: string;
  }>(
    `SELECT ci.id, ci.organization_id, ci.campaign_id, ci.influencer_id, ci.status::text AS status, i.display_name
       FROM campaign_influencers ci
       JOIN influencers i ON i.id = ci.influencer_id
      WHERE ci.id = $1`,
    [campaignInfluencerId],
  );
  const fila = rows[0];
  if (fila === undefined) return err(NO_ENCONTRADO_DE_CONTENIDO);
  const permitido = authorizeInternalResource(persona.value, 'operations:read', fila.organization_id);
  if (!permitido.ok) return permitido;
  return ok({
    id: fila.id,
    organizationId: fila.organization_id,
    campaignId: fila.campaign_id,
    influencerId: fila.influencer_id,
    nombre: fila.display_name,
    estado: fila.status,
  });
}

// ─────────────────────────── Carga por lotes ───────────────────────────────────

export interface AlcanceOperativo {
  readonly campaignId: string;
  readonly organizationId: string;
  /** Si se indica, todas las consultas se acotan a esa participación. */
  readonly participacionId?: string | undefined;
  readonly incluirRetirados?: boolean | undefined;
}

interface FilaDeParticipacion {
  id: string;
  influencer_id: string;
  status: 'activo' | 'retirado';
  display_name: string;
}
interface FilaDeAcuerdo {
  campaign_influencer_id: string;
  status: 'active' | 'cancelled';
  current_version: number;
  compensation_type: CompensationType;
  starts_on: string | null;
  ends_on: string | null;
}
interface FilaDeCompromiso {
  campaign_influencer_id: string;
  campaign_product_id: string;
  nombre: string;
  quantity: number;
}
interface FilaDeEnvioResumido {
  id: string;
  campaign_influencer_id: string;
  status: ShipmentStatus;
  tiene_pii: boolean;
}
interface FilaDeItemAgregado {
  campaign_influencer_id: string;
  campaign_product_id: string;
  nombre: string;
  status: ShipmentStatus;
  quantity: number;
}
interface FilaDeObligacion {
  campaign_influencer_id: string;
  status: PaymentObligationStatus;
  modo: CompensationType;
}
interface FilaDeDocumentosPorEstado {
  campaign_influencer_id: string;
  status: BillingDocumentStatus;
  n: number;
}
interface FilaDeVersionDeEntregable {
  campaign_influencer_id: string;
  deliverable_id: string;
  version: number | null;
  status: string | null;
}

/** Datos crudos (de lista blanca) agrupados por participación. Solo se llenan las secciones pedidas. */
export interface DatosOperativos {
  readonly participaciones: readonly FilaDeParticipacion[];
  readonly acuerdos: ReadonlyMap<string, FilaDeAcuerdo>;
  readonly compromisos: ReadonlyMap<string, readonly FilaDeCompromiso[]>;
  readonly envios: ReadonlyMap<string, readonly FilaDeEnvioResumido[]>;
  readonly items: ReadonlyMap<string, readonly FilaDeItemAgregado[]>;
  readonly obligaciones: ReadonlyMap<string, FilaDeObligacion>;
  readonly documentos: ReadonlyMap<string, readonly BillingDocumentStatus[]>;
  readonly contenido: ReadonlyMap<string, readonly ResumenDeEntregable[]>;
}

function agrupar<T extends { campaign_influencer_id: string }>(filas: readonly T[]): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const f of filas) {
    const l = m.get(f.campaign_influencer_id) ?? [];
    l.push(f);
    m.set(f.campaign_influencer_id, l);
  }
  return m;
}

/**
 * Carga POR LOTES (una consulta por tabla relevante para TODA la campaña, o para una participación) con
 * columnas de lista blanca. Solo ejecuta las consultas de las secciones que se piden: el llamador decide el
 * conjunto a partir de las capacidades del actor, de modo que lo no permitido ni se consulta. En particular, el
 * dinero (cuentas de cobro, obligaciones) solo se toca con `facturacion_pagos`.
 */
export async function cargarDatosOperativos(
  db: Consultor,
  alcance: AlcanceOperativo,
  secciones: ReadonlySet<SeccionOperativa>,
): Promise<DatosOperativos> {
  const params: unknown[] = [alcance.campaignId, alcance.organizationId];
  if (alcance.participacionId !== undefined) params.push(alcance.participacionId);
  const por = (alias: string): string =>
    alcance.participacionId === undefined ? '' : ` AND ${alias}.campaign_influencer_id = $3`;
  const conAcuerdo = secciones.has('acuerdo');
  const conLogistica = secciones.has('logistica');
  const conFinanzas = secciones.has('facturacion_pagos');
  const conContenido = secciones.has('contenido');
  const vacio = Promise.resolve({ rows: [] as never[] });

  const [
    participaciones,
    acuerdos,
    compromisos,
    envios,
    items,
    obligaciones,
    documentos,
    versionesDeEntregables,
  ] = await Promise.all([
    db.query<FilaDeParticipacion>(
      `SELECT ci.id, ci.influencer_id, ci.status::text AS status, i.display_name
         FROM campaign_influencers ci
         JOIN influencers i ON i.id = ci.influencer_id
        WHERE ci.campaign_id = $1 AND ci.organization_id = $2
              ${alcance.participacionId === undefined ? '' : 'AND ci.id = $3'}
              ${
                alcance.participacionId === undefined && alcance.incluirRetirados !== true
                  ? `AND ci.status = 'activo'`
                  : ''
              }
        ORDER BY ci.created_at, ci.id`,
      params,
    ),
    conAcuerdo
      ? db.query<FilaDeAcuerdo>(
          `SELECT a.campaign_influencer_id, a.status, a.current_version, av.compensation_type,
                  av.starts_on::text AS starts_on, av.ends_on::text AS ends_on
             FROM agreements a
             JOIN agreement_versions av ON av.agreement_id = a.id AND av.version = a.current_version
            WHERE a.campaign_id = $1 AND a.organization_id = $2${por('a')}`,
          params,
        )
      : vacio,
    conAcuerdo
      ? db.query<FilaDeCompromiso>(
          `SELECT a.campaign_influencer_id, c.campaign_product_id, p.brand || ' ' || p.model AS nombre, c.quantity
             FROM agreements a
             JOIN agreement_versions av ON av.agreement_id = a.id AND av.version = a.current_version
             JOIN agreement_product_commitments c ON c.agreement_version_id = av.id
             JOIN campaign_products cp ON cp.id = c.campaign_product_id
             JOIN products p ON p.id = cp.product_id
            WHERE a.campaign_id = $1 AND a.organization_id = $2 AND a.status = 'active'${por('a')}
            ORDER BY p.brand, p.model, c.campaign_product_id`,
          params,
        )
      : vacio,
    conLogistica
      ? db.query<FilaDeEnvioResumido>(
          `SELECT s.id, s.campaign_influencer_id, s.status, (s.pii_record_id IS NOT NULL) AS tiene_pii
             FROM shipments s
            WHERE s.campaign_id = $1 AND s.organization_id = $2${por('s')}
            ORDER BY s.created_at, s.id`,
          params,
        )
      : vacio,
    conLogistica
      ? db.query<FilaDeItemAgregado>(
          `SELECT s.campaign_influencer_id, si.campaign_product_id, p.brand || ' ' || p.model AS nombre, s.status,
                  sum(si.quantity)::int AS quantity
             FROM shipment_items si
             JOIN shipments s ON s.id = si.shipment_id
             JOIN campaign_products cp ON cp.id = si.campaign_product_id
             JOIN products p ON p.id = cp.product_id
            WHERE s.campaign_id = $1 AND s.organization_id = $2${por('s')}
            GROUP BY s.campaign_influencer_id, si.campaign_product_id, p.brand, p.model, s.status
            ORDER BY p.brand, p.model, si.campaign_product_id`,
          params,
        )
      : vacio,
    conFinanzas
      ? db.query<FilaDeObligacion>(
          `SELECT a.campaign_influencer_id, po.status, av.compensation_type AS modo
             FROM payment_obligations po
             JOIN agreements a ON a.id = po.agreement_id
             JOIN agreement_versions av ON av.agreement_id = a.id AND av.version = a.current_version
            WHERE po.campaign_id = $1 AND po.organization_id = $2${por('a')}`,
          params,
        )
      : vacio,
    conFinanzas
      ? db.query<FilaDeDocumentosPorEstado>(
          `SELECT a.campaign_influencer_id, d.status, count(*)::int AS n
             FROM billing_documents d
             JOIN payment_obligations po ON po.id = d.payment_obligation_id
             JOIN agreements a ON a.id = po.agreement_id
            WHERE d.campaign_id = $1 AND d.organization_id = $2${por('a')}
            GROUP BY a.campaign_influencer_id, d.status`,
          params,
        )
      : vacio,
    conContenido
      ? db.query<FilaDeVersionDeEntregable>(
          `SELECT d.campaign_influencer_id, d.id AS deliverable_id, sv.version, sv.status
             FROM deliverables d
             LEFT JOIN script_versions sv ON sv.deliverable_id = d.id
            WHERE d.campaign_id = $1 AND d.organization_id = $2 AND d.status = 'active'${por('d')}`,
          params,
        )
      : vacio,
  ]);

  const documentosPorParticipacion = new Map<string, BillingDocumentStatus[]>();
  for (const f of documentos.rows) {
    const l = documentosPorParticipacion.get(f.campaign_influencer_id) ?? [];
    for (let i = 0; i < f.n; i += 1) l.push(f.status);
    documentosPorParticipacion.set(f.campaign_influencer_id, l);
  }

  // Resumen de cada entregable activo a partir de sus versiones (misma función pura que usa el módulo de contenido).
  const versionesPorEntregable = new Map<
    string,
    { ci: string; versiones: { version: number; status: string }[] }
  >();
  for (const f of versionesDeEntregables.rows) {
    const e = versionesPorEntregable.get(f.deliverable_id) ?? { ci: f.campaign_influencer_id, versiones: [] };
    if (f.version !== null && f.status !== null) e.versiones.push({ version: f.version, status: f.status });
    versionesPorEntregable.set(f.deliverable_id, e);
  }
  const contenido = new Map<string, ResumenDeEntregable[]>();
  for (const { ci, versiones } of versionesPorEntregable.values()) {
    const l = contenido.get(ci) ?? [];
    l.push(resumenDeEntregable(versiones as Parameters<typeof resumenDeEntregable>[0]));
    contenido.set(ci, l);
  }

  return {
    participaciones: participaciones.rows,
    acuerdos: new Map(acuerdos.rows.map((f) => [f.campaign_influencer_id, f])),
    compromisos: agrupar(compromisos.rows),
    envios: agrupar(envios.rows),
    items: agrupar(items.rows),
    obligaciones: new Map(obligaciones.rows.map((f) => [f.campaign_influencer_id, f])),
    documentos: documentosPorParticipacion,
    contenido,
  };
}

// ─────────────────────────── Derivación por participación ──────────────────────

/** Estado derivado de una participación (sin proyectar por rol: quien llama decide qué expone). */
export interface DerivadoDeParticipacion {
  readonly acuerdo: ResumenDeAcuerdo | undefined;
  readonly logistica: ResumenDeLogistica | undefined;
  readonly progreso: readonly ProgresoDeProducto[] | undefined;
  readonly facturacion: ResumenDeFacturacion | undefined;
  readonly pago: ResumenDePago | undefined;
  readonly contenido: ResumenDeContenido | undefined;
  readonly tieneCompromisos: boolean;
  readonly vigencia: { readonly desde: string | null; readonly hasta: string | null } | null;
}

export function derivarDeParticipacion(
  datos: DatosOperativos,
  ci: string,
  secciones: ReadonlySet<SeccionOperativa>,
): DerivadoDeParticipacion {
  const fila = datos.acuerdos.get(ci);
  const acuerdo = secciones.has('acuerdo')
    ? resumirAcuerdo(
        fila === undefined
          ? null
          : {
              status: fila.status,
              compensationType: fila.compensation_type,
              currentVersion: fila.current_version,
            },
      )
    : undefined;

  const compromisos = datos.compromisos.get(ci) ?? [];
  const comprometidas = secciones.has('acuerdo') ? compromisos.reduce((s, c) => s + c.quantity, 0) : null;
  const tieneCompromisos = comprometidas !== null && comprometidas > 0;

  let logistica: ResumenDeLogistica | undefined;
  let progreso: ProgresoDeProducto[] | undefined;
  if (secciones.has('logistica')) {
    const envios = datos.envios.get(ci) ?? [];
    const derivada = derivarEstadoLogistico(envios.map((e) => e.status));
    progreso = calcularProgresoDeProductos(
      compromisos.map((c) => ({
        campaignProductId: c.campaign_product_id,
        nombre: c.nombre,
        quantity: c.quantity,
      })),
      (datos.items.get(ci) ?? []).map((i) => ({
        campaignProductId: i.campaign_product_id,
        nombre: i.nombre,
        status: i.status,
        quantity: i.quantity,
      })),
    );
    logistica = {
      ...derivada,
      comprometidas,
      enviadas: progreso.reduce((s, p) => s + p.enviado, 0),
      entregadas: progreso.reduce((s, p) => s + p.entregado, 0),
      tienePii: envios.some((e) => e.tiene_pii),
    };
  }

  let facturacion: ResumenDeFacturacion | undefined;
  let pago: ResumenDePago | undefined;
  if (secciones.has('facturacion_pagos')) {
    const obligacion = datos.obligaciones.get(ci);
    const documentos = datos.documentos.get(ci) ?? [];
    facturacion = { documentos: contarDocumentos(documentos) };
    pago = derivarPagoDeParticipacion({
      modo: obligacion?.modo ?? null,
      obligacion: obligacion?.status ?? null,
      documentos,
    });
  }

  const contenido = secciones.has('contenido')
    ? derivarEstadoDeContenido(datos.contenido.get(ci) ?? [])
    : undefined;

  return {
    acuerdo,
    logistica,
    progreso,
    facturacion,
    pago,
    contenido,
    tieneCompromisos,
    vigencia: fila === undefined ? null : { desde: fila.starts_on, hasta: fila.ends_on },
  };
}

/** Conjunto de secciones a EJECUTAR: las que el rol permite (`operations:read` incluido). */
export function seccionesAEjecutar(
  actor: User,
  excluir: readonly SeccionOperativa[] = [],
): Set<SeccionOperativa> {
  return new Set(seccionesPermitidas(actor.role).filter((s) => !excluir.includes(s)));
}

export function datosParaFiltrar(d: DerivadoDeParticipacion): DatosParaFiltrar {
  return {
    acuerdo: d.acuerdo,
    logistica: d.logistica,
    pago: d.pago,
    tieneCompromisos: d.tieneCompromisos,
  };
}

/** Normaliza límite y desplazamiento de página. */
export function paginaDe(opciones: OpcionesDeResumenOperativo): { limite: number; desde: number } {
  return {
    limite: Math.min(Math.max(Math.trunc(opciones.limite ?? LIMITE_POR_DEFECTO), 1), LIMITE_MAXIMO),
    desde: Math.max(Math.trunc(opciones.desde ?? 0), 0),
  };
}

/** Conteos sobre el conjunto completo (antes de filtrar y paginar), solo de las secciones ejecutadas. */
export function contarOperativos(
  derivados: readonly DerivadoDeParticipacion[],
  secciones: ReadonlySet<SeccionOperativa>,
): ConteosOperativos {
  return {
    participaciones: derivados.length,
    ...(secciones.has('acuerdo')
      ? { sinAcuerdo: derivados.filter((d) => d.acuerdo?.estado === 'sin_acuerdo').length }
      : {}),
    ...(secciones.has('logistica')
      ? {
          logisticaPendiente: derivados.filter(
            (d) =>
              d.logistica !== undefined &&
              esLogisticaPendiente({
                estado: d.logistica.estado,
                abiertos: d.logistica.abiertos,
                tieneCompromisos: d.tieneCompromisos,
              }),
          ).length,
        }
      : {}),
    ...(secciones.has('facturacion_pagos')
      ? { pagoPendiente: derivados.filter((d) => esPagoPendiente(d.pago?.seguimiento ?? null)).length }
      : {}),
  };
}

// ─────────────────────────── Resumen de campaña ────────────────────────────────

/**
 * Resumen operativo de la campaña, por participación, con filtros (logística pendiente, pago pendiente, sin
 * acuerdo), conteos y paginación. Un filtro de una sección que el rol no ve ⇒ `FORBIDDEN_ROLE` (no es una forma
 * de leerla). Consultas por LOTES: el número de consultas NO depende del de participaciones.
 */
export async function obtenerResumenOperativoDeCampana<Kpi = unknown>(
  actor: User,
  campaignId: string,
  filtros: FiltrosDeResumenOperativo = {},
  proveedores: ProveedoresOperativos<Kpi> = {},
): Promise<Result<ResumenOperativoDeCampana<Kpi>>> {
  const campana = await autorizarCampanaOperativa(actor, campaignId);
  if (!campana.ok) return campana;
  const validos = validarFiltrosOperativos(actor.role, filtros);
  if (!validos.ok) return validos;

  const secciones = seccionesAEjecutar(actor);
  const datos = await cargarDatosOperativos(
    getPool(),
    { campaignId, organizationId: campana.value.organizationId, incluirRetirados: filtros.incluirRetirados },
    secciones,
  );
  const derivados = datos.participaciones.map((p) => ({
    fila: p,
    derivado: derivarDeParticipacion(datos, p.id, secciones),
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

  const items = pagina.map(({ fila, derivado }): ParticipacionOperativa<Kpi> => ({
    participacionId: fila.id,
    influencerId: fila.influencer_id,
    nombre: fila.display_name,
    estadoDeParticipacion: fila.status,
    resumen: componerResumenOperativo<Kpi>(actor.role, {
      acuerdo: derivado.acuerdo,
      logistica: derivado.logistica,
      facturacion: derivado.facturacion,
      pago: derivado.pago,
      contenido: derivado.contenido,
      ...(secciones.has('kpi') ? { kpi: kpis?.get(fila.id) ?? null } : {}),
    }),
  }));

  return ok({
    campaignId,
    secciones: seccionesPermitidas(actor.role),
    items,
    total: coinciden.length,
    limite,
    desde,
    conteos,
  });
}

// ─────────────────────────── Estado de una participación ───────────────────────

/**
 * Estado operativo detallado de UNA participación: hasta cinco secciones, cada una solo si el actor tiene su
 * capacidad y reutilizando el caso de uso de su dominio. Aquí no hay dirección, teléfono ni cédula (solo
 * `tienePii`), ni guía, transportadora, notas, referencias ni nombres de archivo.
 */
export async function obtenerEstadoOperativoDeParticipacion<Kpi = unknown>(
  actor: User,
  campaignInfluencerId: string,
  proveedores: ProveedoresOperativos<Kpi> = {},
): Promise<Result<EstadoOperativoDeParticipacion<Kpi>>> {
  const p = await autorizarParticipacionOperativa(actor, campaignInfluencerId);
  if (!p.ok) return p;
  const rol = actor.role;
  const ve = (s: SeccionOperativa): boolean => puedeVerSeccionOperativa(rol, s);
  const conDinero = ve('facturacion_pagos');

  {
    // ── acuerdo ──
    let acuerdo: DetalleDeAcuerdo | undefined;
    let compromisos: { campaignProductId: string; nombre: string; quantity: number }[] = [];
    if (ve('acuerdo')) {
      const r = await obtenerAcuerdo(actor, campaignInfluencerId);
      if (!r.ok) return r;
      const a = r.value;
      const base = resumirAcuerdo(
        a === null
          ? null
          : {
              status: a.status,
              compensationType: a.terms.compensationType,
              currentVersion: a.currentVersion,
            },
      );
      if (a !== null && a.status === 'active') {
        compromisos = a.terms.commitments.map((c) => ({
          campaignProductId: c.campaignProductId,
          nombre: c.productName,
          quantity: c.quantity,
        }));
      }
      acuerdo = {
        ...base,
        id: a?.id ?? null,
        vigencia: a === null ? null : { desde: a.terms.startsOn, hasta: a.terms.endsOn },
        productos: (a?.terms.commitments ?? []).map((c) => ({
          campaignProductId: c.campaignProductId,
          producto: c.productName,
          cantidad: c.quantity,
        })),
        canceladoEn: a?.cancelledAt ?? null,
        ...(conDinero && a !== null
          ? { dinero: { monto: a.terms.feeAmount ?? null, moneda: a.terms.feeCurrency ?? null } }
          : {}),
      };
    }

    // ── logística ──
    let logistica: DetalleDeLogistica | undefined;
    if (ve('logistica')) {
      const r = await listarEnviosDeParticipacion(actor, campaignInfluencerId);
      if (!r.ok) return r;
      const envios = r.value;
      const derivada = derivarEstadoLogistico(envios.map((e) => e.status));
      // Un mismo nombre por producto (el del acuerdo, «marca modelo») aunque el envío traiga solo el modelo.
      const nombreDe = new Map(compromisos.map((c) => [c.campaignProductId, c.nombre]));
      const progreso = calcularProgresoDeProductos(
        compromisos,
        envios.flatMap((e) =>
          e.items.map((i) => ({
            campaignProductId: i.campaignProductId,
            nombre: nombreDe.get(i.campaignProductId) ?? i.productModel,
            status: e.status,
            quantity: i.quantity,
          })),
        ),
      );
      logistica = {
        ...derivada,
        comprometidas: ve('acuerdo') ? compromisos.reduce((s, c) => s + c.quantity, 0) : null,
        enviadas: progreso.reduce((s, x) => s + x.enviado, 0),
        entregadas: progreso.reduce((s, x) => s + x.entregado, 0),
        tienePii: envios.some((e) => e.tienePii),
        productos: progreso,
        envios: envios.map((e) => ({
          id: e.id,
          estado: e.status,
          rowSeq: e.rowSeq,
          enviadoEl: e.shippedOn,
          entregadoEl: e.deliveredOn,
          items: e.items.map((i) => ({
            campaignProductId: i.campaignProductId,
            producto: nombreDe.get(i.campaignProductId) ?? i.productModel,
            cantidad: i.quantity,
          })),
          tienePii: e.tienePii,
          ...('shippingCost' in e
            ? { costoDeEnvio: { monto: e.shippingCost ?? null, moneda: e.shippingCurrency ?? null } }
            : {}),
        })),
      };
    }

    // ── facturación y pagos ──
    let facturacion: DetalleDeFacturacion | undefined;
    let pago: DetalleDePago | undefined;
    if (conDinero) {
      const r = await obtenerSeguimientoDePago(actor, campaignInfluencerId);
      if (!r.ok) return r;
      const s = r.value;
      const documentos = s?.documents ?? [];
      facturacion = {
        documentos: contarDocumentos(documentos.map((d) => d.status)),
        lista: documentos.map((d) => ({
          id: d.id,
          numero: d.documentNumber,
          emitidoEl: d.issuedOn,
          estado: d.status,
          rowSeq: d.rowSeq,
          montoReclamado: d.claimedAmount,
          monedaReclamada: d.claimedCurrency,
        })),
      };
      const derivado = derivarPagoDeParticipacion({
        modo: s === null ? null : (s.agreement.compensationType as CompensationType),
        obligacion: s?.obligation.status ?? null,
        documentos: documentos.map((d) => d.status),
      });
      pago = {
        ...derivado,
        obligacionId: s?.obligation.id ?? null,
        rowSeq: s?.obligation.rowSeq ?? null,
        reportadoEl: s?.obligation.reportedAt ?? null,
        pagadoEl: s?.obligation.paidOn ?? null,
        billingValidadoAlReportar: s?.obligation.billingValidatedAtReport ?? null,
      };
    }

    // ── contenido ──
    let contenido: DetalleDeContenido | undefined;
    if (ve('contenido')) {
      const r = await listarEntregablesDeCampana(actor, p.value.campaignId, {
        participationId: campaignInfluencerId,
        limite: LIMITE_MAXIMO,
      });
      if (!r.ok) return r;
      const pagina = r.value;
      const items: DetalleDeContenido['items'][number][] = pagina.items.map((e) =>
        e.projection === 'estado'
          ? {
              id: e.deliverableId,
              etiqueta: e.label,
              plataforma: e.platform ?? null,
              estado: e.status,
              resumen: e.resumen,
              ultimaVersion: e.latest === null ? null : { numero: e.latest.version, estado: e.latest.status },
              aprobadaVigente:
                e.currentApproved === null
                  ? null
                  : { numero: e.currentApproved.version, aprobadaEl: e.currentApproved.approvedAt },
            }
          : {
              id: e.deliverable.id,
              etiqueta: e.deliverable.label,
              plataforma: e.deliverable.platform ?? null,
              estado: e.deliverable.status,
              resumen: e.resumen,
              ultimaVersion: e.latest === null ? null : { numero: e.latest.version, estado: e.latest.status },
              aprobadaVigente:
                e.currentApproved === null
                  ? null
                  : { numero: e.currentApproved.version, aprobadaEl: e.currentApproved.approvedAt },
            },
      );
      const activos = items.filter((i) => i.estado === 'active');
      contenido = { ...derivarEstadoDeContenido(activos.map((i) => i.resumen)), items };
    }

    // ── KPI (proveedor inyectado) ──
    let kpi: Kpi | null | undefined;
    if (ve('kpi')) {
      const mapa = await proveedorKpi(proveedores)({
        actor,
        campaignId: p.value.campaignId,
        participacionIds: [campaignInfluencerId],
      });
      kpi = mapa?.get(campaignInfluencerId) ?? null;
    }

    const partes = componerResumenOperativo<
      Kpi,
      DetalleDeAcuerdo,
      DetalleDeLogistica,
      DetalleDeFacturacion,
      DetalleDePago,
      DetalleDeContenido
    >(rol, { acuerdo, logistica, facturacion, pago, contenido, kpi });
    return ok({
      participacionId: p.value.id,
      campaignId: p.value.campaignId,
      influencerId: p.value.influencerId,
      nombre: p.value.nombre,
      estadoDeParticipacion: p.value.estado,
      secciones: seccionesPermitidas(rol),
      ...partes,
    });
  }
}
