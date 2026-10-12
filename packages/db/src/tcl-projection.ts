/**
 * Proyección TCL del servidor (V2 · Fase 9, DEC-050): lo ÚNICO que el dashboard de TCL (y su export) puede leer.
 *
 *   dominio interno → PROYECCIÓN (lista blanca campo por campo, `packages/domain/src/tcl-projection.ts`) → DTO
 *
 * Este módulo hace las CONSULTAS y arma las ENTRADAS PÚBLICAS; los DTO los construyen las funciones puras del
 * dominio. TCL nunca recibe una entidad interna ni un read model interno «con menos campos».
 *
 * GUARD ÚNICO (`autorizarCampanaParaTcl`): rol `cliente` activo + capacidad de la sección + UUID válido + campaña
 * con visibilidad `tcl | compartida` y NO cancelada. Cualquier fallo ⇒ `RESOURCE_NOT_FOUND` idéntico (no existe,
 * no es visible, está cancelada, otra agencia en `interna`, rol sin capacidad: indistinguibles). Una campaña de otra
 * agencia en `tcl | compartida` ES visible por contrato (esa visibilidad es la compartición explícita con TCL; la
 * entidad no lleva una organización cliente propia: deuda declarada en DEC-050).
 *
 * Qué reutiliza (sin duplicar su lógica): `cargarDatosOperativos` / `derivarDeParticipacion` (solo secciones
 * `acuerdo`, `logistica` y `contenido`: NUNCA `facturacion_pagos`), la fila `approved` de `script_versions`,
 * `leerRector` (Brief vigente) + `cargarRepresentaciones` + `construirRepresentacionLocalizada` (ES/EN y su estado
 * de sincronización), `kpisPublicosDeCampana` (bloque `public` de KPI), `resolverAlcanceDeFuentes` (alcance solo-TCL)
 * y `sqlFragmentoSinTextoHistorico` (snapshots históricos del Sheet con fee/canje/condiciones).
 *
 * Qué NO toca jamás: `payment_obligations`, `billing_documents`, `influencer_pii_records`, `content_findings`,
 * `content_analysis_runs`, comentarios (`field_comments`, `script_review_comments`), `ai_runs`, eventos operativos
 * ni evidencia operativa. Una prueba espía el pool y lo comprueba. Cero imports de PII.
 *
 * Export (`exportarCampanaParaTcl`): llama a ESTA MISMA proyección y serializa solo sus campos; no lee tablas.
 */

import {
  type Action,
  type BriefTcl,
  type CampanaDetalleTcl,
  type CampanaListaTcl,
  type ContenidoAprobadoTcl,
  type DocumentoTcl,
  type ExportDeTcl,
  type FormatoDeExportTcl,
  type InfluencerTcl,
  type KpiPorParticipacionTcl,
  type KpiTcl,
  type Language,
  type ProyeccionTclDeCampana,
  type ProyeccionTclDeOperacion,
  type Result,
  type SeccionOperativa,
  type User,
  asegurarProyeccionTcl,
  err,
  esFormatoDeExportTcl,
  isTclVisible,
  nombreDeArchivoDeExportTcl,
  ok,
  proyectarBriefParaTcl,
  proyectarCampanaDetalleParaTcl,
  proyectarCampanaListaParaTcl,
  proyectarContenidoParaTcl,
  proyectarDocumentoParaTcl,
  proyectarInfluencerParaTcl,
  proyectarKpiParaTcl,
  proyectarOperacionParaTcl,
  roleCan,
  serializarExportTcl,
} from '@tcl-kol-os/domain';
import type pg from 'pg';
import { construirRepresentacionLocalizada, resumirRepresentaciones } from './brief-representations.ts';
import { cargarRepresentaciones } from './brief-version.ts';
import { getPool } from './client.ts';
import { leerRector } from './content-analysis.ts';
import { NO_ENCONTRADO_DE_CONTENIDO, esUuid } from './deliverables.ts';
import { camposDeVersion } from './extraction.ts';
import { sqlFragmentoSinTextoHistorico, sqlFuenteEsSheetDeInfluencers } from './fragment-scope.ts';
import { kpisPublicosDeCampana } from './kpi-views.ts';
import { cargarDatosOperativos, derivarDeParticipacion } from './operativo-views.ts';
import { SQL_FUENTE_SIN_EVIDENCIA_OPERATIVA } from './ops-source-scope.ts';
import { sqlFuenteSinGuionNoAprobado } from './script-scope.ts';
import { resolverAlcanceDeFuentes } from './sources.ts';

type Consultor = pg.Pool | pg.PoolClient;

// ─────────────────────────── Capacidades ───────────────────────────────────────

const CAP_CAMPANA: Action = 'campaign:read_client';
const CAP_CONTENIDO: Action = 'content:read_approved_client';
const CAP_OPERACION: Action = 'operations:read_summary_client';
const CAP_KPI: Action = 'kpi:read_client';
const CAP_DOCUMENTOS: Action = 'source:read_shared';
const CAP_EXPORT: Action = 'export:client';

/** La proyección completa exige todas las capacidades de lectura del cliente. */
const CAPS_DE_LECTURA_COMPLETA: readonly Action[] = [
  CAP_CAMPANA,
  CAP_CONTENIDO,
  CAP_OPERACION,
  CAP_KPI,
  CAP_DOCUMENTOS,
];

/**
 * Secciones operativas que TCL puede ver derivadas: acuerdo (solo para las UNIDADES comprometidas), logística y
 * contenido. Nunca `facturacion_pagos` (dinero) ni `kpi` (tiene su propia proyección).
 */
const SECCIONES_TCL: ReadonlySet<SeccionOperativa> = new Set<SeccionOperativa>([
  'acuerdo',
  'logistica',
  'contenido',
]);

// ─────────────────────────── Guard único ───────────────────────────────────────

/** Campaña ya autorizada para TCL. Solo uso INTERNO del servidor: nada de esto llega a un DTO. */
export interface CampanaAutorizadaParaTcl {
  readonly id: string;
  readonly organizationId: string;
  readonly name: string;
  readonly market: string;
  readonly category: string | null;
  readonly startDate: string | null;
  readonly endDate: string | null;
  readonly status: string;
}

interface FilaDeCampana {
  id: string;
  organization_id: string;
  name: string;
  market: string;
  category: string | null;
  start_date: string | null;
  end_date: string | null;
  status: string;
  visibility: 'interna' | 'tcl' | 'compartida';
}

/** `SELECT` explícito: nada de owner, presupuesto ni confidencialidad. */
const SELECT_CAMPANA_TCL = `SELECT c.id, c.organization_id, c.name, c.market, c.category,
       c.start_date::text AS start_date, c.end_date::text AS end_date, c.status::text AS status,
       c.visibility::text AS visibility
  FROM campaigns c`;

function actorTclValido(actor: User, capacidades: readonly Action[]): boolean {
  return (
    typeof actor === 'object' &&
    actor !== null &&
    actor.role === 'cliente' &&
    actor.status === 'activo' &&
    capacidades.every((c) => roleCan(actor.role, c))
  );
}

/**
 * El guard ÚNICO de la proyección. Mismo error en todos los fallos (no distingue por qué): el cliente no puede
 * sondear campañas de otros ni la existencia de las internas.
 */
export async function autorizarCampanaParaTcl(
  actor: User,
  campaignId: unknown,
  capacidades: readonly Action[],
): Promise<Result<CampanaAutorizadaParaTcl>> {
  if (!actorTclValido(actor, capacidades) || !esUuid(campaignId)) return err(NO_ENCONTRADO_DE_CONTENIDO);
  const { rows } = await getPool().query<FilaDeCampana>(
    `${SELECT_CAMPANA_TCL} WHERE c.id = $1 AND c.visibility IN ('tcl', 'compartida') AND c.status <> 'cancelada'`,
    [campaignId],
  );
  const c = rows[0];
  if (c === undefined || !isTclVisible(c.visibility)) return err(NO_ENCONTRADO_DE_CONTENIDO);
  return ok({
    id: c.id,
    organizationId: c.organization_id,
    name: c.name,
    market: c.market,
    category: c.category,
    startDate: c.start_date,
    endDate: c.end_date,
    status: c.status,
  });
}

function comoEntradaDeCampana(c: CampanaAutorizadaParaTcl) {
  return {
    id: c.id,
    nombre: c.name,
    mercado: c.market,
    categoria: c.category,
    fechaInicio: c.startDate,
    fechaFin: c.endDate,
    estadoInterno: c.status,
  };
}

// ─────────────────────────── Lista de campañas ─────────────────────────────────

/** Campañas visibles para TCL (de cualquier agencia que las haya compartido), no canceladas. */
export async function listarCampanasParaTcl(actor: User): Promise<Result<CampanaListaTcl[]>> {
  if (!actorTclValido(actor, [CAP_CAMPANA])) return err(NO_ENCONTRADO_DE_CONTENIDO);
  const { rows } = await getPool().query<FilaDeCampana>(
    `${SELECT_CAMPANA_TCL}
      WHERE c.visibility IN ('tcl', 'compartida') AND c.status <> 'cancelada'
      ORDER BY c.start_date DESC NULLS LAST, c.created_at DESC, c.id`,
  );
  return ok(
    asegurarProyeccionTcl(
      rows
        .filter((c) => isTclVisible(c.visibility))
        .map((c) =>
          proyectarCampanaListaParaTcl(
            comoEntradaDeCampana({
              id: c.id,
              organizationId: c.organization_id,
              name: c.name,
              market: c.market,
              category: c.category,
              startDate: c.start_date,
              endDate: c.end_date,
              status: c.status,
            }),
          ),
        ),
    ),
  );
}

// ─────────────────────────── Cargas internas por sección ───────────────────────

interface ParticipacionTcl {
  readonly influencerId: string;
  readonly operacion: ProyeccionTclDeOperacion;
}

/**
 * Operación derivada de las participaciones ACTIVAS: reutiliza `cargarDatosOperativos` / `derivarDeParticipacion`
 * con las secciones sin dinero y la proyecta con `proyectarOperacionParaTcl` (entrada pública explícita).
 */
async function cargarParticipaciones(c: CampanaAutorizadaParaTcl): Promise<ParticipacionTcl[]> {
  const datos = await cargarDatosOperativos(
    getPool(),
    { campaignId: c.id, organizationId: c.organizationId, incluirRetirados: false },
    SECCIONES_TCL,
  );
  return datos.participaciones
    .filter((p) => p.status === 'activo')
    .map((p) => {
      const d = derivarDeParticipacion(datos, p.id, SECCIONES_TCL);
      const porEstado = d.contenido?.porEstado;
      return {
        influencerId: p.influencer_id,
        operacion: proyectarOperacionParaTcl({
          participacionId: p.id,
          nombreVisible: p.display_name,
          unidadesComprometidas: d.logistica?.comprometidas ?? 0,
          unidadesEntregadas: d.logistica?.entregadas ?? 0,
          hayEnvioAbierto: (d.logistica?.abiertos ?? 0) > 0,
          entregablesTotales: d.contenido?.entregables ?? 0,
          // aprobado + aprobado con una versión nueva en revisión: ambos tienen una fila `approved` vigente
          entregablesConGuionAprobado:
            (porEstado?.aprobado ?? 0) + (porEstado?.aprobado_con_nueva_en_revision ?? 0),
        }),
      };
    });
}

async function cargarKpisPorParticipacion(
  db: Consultor,
  campaignId: string,
): Promise<ReadonlyMap<string, readonly KpiTcl[]>> {
  const publicos = await kpisPublicosDeCampana(db, campaignId);
  const salida = new Map<string, readonly KpiTcl[]>();
  for (const [ci, lista] of publicos) {
    salida.set(
      ci,
      lista.flatMap((k) => {
        const proyectado = proyectarKpiParaTcl({
          metric: k.metric,
          unit: k.unit,
          comparator: k.comparator,
          target: k.target,
          actual: k.actual,
          achievement: k.achievement,
          estado: k.estado,
          platform: k.platform,
          observedAt: k.observedAt,
        });
        return proyectado === null ? [] : [proyectado];
      }),
    );
  }
  return salida;
}

async function cargarProductosDeCampana(campaignId: string) {
  const { rows } = await getPool().query<{ brand: string; model: string; category: string }>(
    `SELECT p.brand, p.model, p.category
       FROM campaign_products cp JOIN products p ON p.id = cp.product_id
      WHERE cp.campaign_id = $1
      ORDER BY cp.prioridad, p.brand, p.model`,
    [campaignId],
  );
  return rows.map((r) => ({ marca: r.brand, modelo: r.model, categoria: r.category }));
}

async function cargarCuentasYProductosAsignados(
  c: CampanaAutorizadaParaTcl,
  participaciones: readonly ParticipacionTcl[],
) {
  const idsInfluencer = [...new Set(participaciones.map((p) => p.influencerId))];
  const cuentas = new Map<string, { plataforma: string; handle: string }[]>();
  if (idsInfluencer.length > 0) {
    const { rows } = await getPool().query<{ influencer_id: string; platform: string; handle: string }>(
      `SELECT influencer_id, platform::text AS platform, handle
         FROM influencer_accounts
        WHERE organization_id = $1 AND influencer_id = ANY($2::uuid[])
        ORDER BY platform, handle`,
      [c.organizationId, idsInfluencer],
    );
    for (const r of rows) {
      const l = cuentas.get(r.influencer_id) ?? [];
      l.push({ plataforma: r.platform, handle: r.handle });
      cuentas.set(r.influencer_id, l);
    }
  }
  const { rows: asignados } = await getPool().query<{
    campaign_influencer_id: string;
    brand: string;
    model: string;
    category: string;
  }>(
    `SELECT cip.campaign_influencer_id, p.brand, p.model, p.category
       FROM campaign_influencer_products cip
       JOIN campaign_products cp ON cp.id = cip.campaign_product_id
       JOIN products p ON p.id = cp.product_id
      WHERE cip.campaign_id = $1
      ORDER BY cp.prioridad, p.brand, p.model`,
    [c.id],
  );
  const productos = new Map<string, { marca: string; modelo: string; categoria: string }[]>();
  for (const r of asignados) {
    const l = productos.get(r.campaign_influencer_id) ?? [];
    l.push({ marca: r.brand, modelo: r.model, categoria: r.category });
    productos.set(r.campaign_influencer_id, l);
  }
  return { cuentas, productos };
}

// ─────────────────────────── Secciones ─────────────────────────────────────────

/** Participaciones activas (operación derivada) y KPI públicos: la base común de varias secciones. */
interface BaseDeCampana {
  readonly participaciones: readonly ParticipacionTcl[];
  readonly kpis: ReadonlyMap<string, readonly KpiTcl[]>;
}

async function cargarBase(c: CampanaAutorizadaParaTcl): Promise<BaseDeCampana> {
  const [participaciones, kpis] = await Promise.all([
    cargarParticipaciones(c),
    cargarKpisPorParticipacion(getPool(), c.id),
  ]);
  return { participaciones, kpis };
}

async function influencersDe(c: CampanaAutorizadaParaTcl, base: BaseDeCampana): Promise<InfluencerTcl[]> {
  const { participaciones, kpis } = base;
  const { cuentas, productos } = await cargarCuentasYProductosAsignados(c, participaciones);
  return participaciones.map((p) =>
    proyectarInfluencerParaTcl({
      operacion: p.operacion,
      cuentas: cuentas.get(p.influencerId) ?? [],
      productos: productos.get(p.operacion.participacionId) ?? [],
      kpis: kpis.get(p.operacion.participacionId) ?? [],
    }),
  );
}

async function contenidoDe(c: CampanaAutorizadaParaTcl): Promise<ContenidoAprobadoTcl[]> {
  const { rows } = await getPool().query<{
    entregable_id: string;
    campaign_influencer_id: string;
    label: string;
    platform: string | null;
    brand: string | null;
    model: string | null;
    category: string | null;
    estado_aprobado: string | null;
    approved_at: Date | null;
  }>(
    `SELECT d.id AS entregable_id, d.campaign_influencer_id, d.label, d.platform::text AS platform,
            p.brand, p.model, p.category, sv.status AS estado_aprobado, sv.approved_at
       FROM deliverables d
       JOIN campaign_influencers ci ON ci.id = d.campaign_influencer_id AND ci.status = 'activo'
       LEFT JOIN campaign_products cp ON cp.id = d.campaign_product_id
       LEFT JOIN products p ON p.id = cp.product_id
       LEFT JOIN LATERAL (
         SELECT s.status, s.approved_at
           FROM script_versions s
          WHERE s.deliverable_id = d.id AND s.status = 'approved'
          ORDER BY s.version DESC
          LIMIT 1
       ) sv ON true
      WHERE d.campaign_id = $1 AND d.organization_id = $2 AND d.status = 'active'
      ORDER BY ci.created_at, d.created_at, d.id`,
    [c.id, c.organizationId],
  );
  return rows.map((r) =>
    proyectarContenidoParaTcl({
      participacionId: r.campaign_influencer_id,
      entregableId: r.entregable_id,
      etiqueta: r.label,
      plataforma: r.platform,
      producto: r.model === null ? null : { marca: r.brand, modelo: r.model, categoria: r.category },
      estadoDeLaVersionAprobada: r.estado_aprobado,
      aprobadoEl: r.approved_at === null ? null : r.approved_at.toISOString(),
    }),
  );
}

/**
 * Campos del Brief cuya evidencia NO se puede servir a TCL: cita un fragmento ilegible por `fragment-scope`
 * (snapshot histórico del Sheet de influencers con fee/canje/condiciones), proviene del Sheet de influencers o de
 * evidencia operativa. Esos campos se excluyen COMPLETOS (el valor pudo derivarse de ese texto), sin importar la
 * visibilidad de la fuente.
 */
async function camposConEvidenciaNoServible(versionId: string): Promise<ReadonlySet<string>> {
  const { rows } = await getPool().query<{ id: string }>(
    `SELECT DISTINCT e.brief_field_id AS id
       FROM evidence e
       JOIN brief_fields bf ON bf.id = e.brief_field_id
       JOIN source_documents s ON s.id = e.source_id
       LEFT JOIN source_fragments f ON f.id = e.fragment_id
      WHERE bf.brief_version_id = $1
        AND ((f.id IS NOT NULL AND NOT ${sqlFragmentoSinTextoHistorico('f')})
             OR ${sqlFuenteEsSheetDeInfluencers('s')}
             OR s.type::text = 'soporte_operativo')`,
    [versionId],
  );
  return new Set(rows.map((r) => r.id));
}

/** Estados de campo con valor utilizable en un Brief aprobado. */
const ESTADOS_DE_CAMPO_SERVIBLES: ReadonlySet<string> = new Set(['found', 'manual']);

async function briefDe(c: CampanaAutorizadaParaTcl): Promise<BriefTcl | null> {
  const rector = await leerRector(getPool(), c.id, c.organizationId);
  if (rector === undefined) return null;

  const [representaciones, campos, excluidos, productos] = await Promise.all([
    cargarRepresentaciones(getPool(), rector.versionId),
    camposDeVersion(rector.versionId),
    camposConEvidenciaNoServible(rector.versionId),
    getPool().query<{ id: string; brand: string; model: string }>(
      `SELECT cp.id, p.brand, p.model
         FROM campaign_products cp JOIN products p ON p.id = cp.product_id
        WHERE cp.campaign_id = $1`,
      [c.id],
    ),
  ]);
  const productoDe = new Map(productos.rows.map((p) => [p.id, { marca: p.brand, modelo: p.model }]));
  // Sin evidencia, sin procedencia, sin revisión: solo lo necesario para localizar el valor.
  const camposServibles = campos
    .filter(
      (f) =>
        !excluidos.has(f.id) &&
        ESTADOS_DE_CAMPO_SERVIBLES.has(f.status) &&
        f.value !== null &&
        f.value !== undefined,
    )
    .map((f) => ({ ...f, evidencias: [] }));

  const resumenes = resumirRepresentaciones(representaciones, false);
  const salida: Array<{
    idioma: Language;
    campos: { key: string; producto: { marca: string; modelo: string } | null; value: unknown }[];
  }> = [];
  for (const idioma of ['es', 'en'] as const) {
    const resumen = resumenes[idioma];
    if (resumen === undefined) continue;
    // ES: la representación original. EN: solo si es una traducción VIGENTE respecto del original (una `stale`,
    // `unverified` o `incomplete` no se sirve: no equivale al original aprobado).
    if (idioma === 'es' ? resumen.sync !== 'original' : resumen.sync !== 'current') continue;
    const localizada = await construirRepresentacionLocalizada(
      rector.versionId,
      idioma,
      resumen,
      camposServibles,
    );
    const lista: { key: string; producto: { marca: string; modelo: string } | null; value: unknown }[] = [];
    for (const f of localizada.fields) {
      if (f.value === undefined || f.value === null) continue;
      if (idioma === 'en' && f.sync !== 'current') continue;
      if (f.campaignProductId === null) {
        lista.push({ key: f.key, producto: null, value: f.value });
        continue;
      }
      const producto = productoDe.get(f.campaignProductId);
      if (producto !== undefined) lista.push({ key: f.key, producto, value: f.value });
    }
    salida.push({ idioma, campos: lista });
  }
  if (!salida.some((r) => r.idioma === 'es')) return null;
  return proyectarBriefParaTcl({
    version: rector.number,
    aprobadoEl: rector.approvedAt,
    representaciones: salida,
  });
}

function operacionDe(base: BaseDeCampana): ProyeccionTclDeOperacion[] {
  return base.participaciones.map((p) => p.operacion);
}

function kpisDe(base: BaseDeCampana): KpiPorParticipacionTcl[] {
  const { participaciones, kpis } = base;
  return participaciones.map((p) => ({
    participacionId: p.operacion.participacionId,
    nombreVisible: p.operacion.nombreVisible,
    kpis: kpis.get(p.operacion.participacionId) ?? [],
  }));
}

/**
 * Documentos: fuentes que SmartPR marcó `tcl | compartida` (alcance de `resolverAlcanceDeFuentes`, el único punto
 * de decisión), sin evidencia operativa, sin guiones NO aprobados y sin el Sheet de influencers. Columnas de lista
 * blanca: nada de hash, URLs, jobs ni fragmentos.
 */
async function documentosDe(actor: User, c: CampanaAutorizadaParaTcl): Promise<DocumentoTcl[]> {
  const alcance = await resolverAlcanceDeFuentes(actor, c.id);
  if (!alcance.ok || !alcance.value.soloVisibleParaTcl) return [];
  const { rows } = await getPool().query<{
    id: string;
    filename: string;
    type: string;
    language: string | null;
    created_at: Date;
  }>(
    `SELECT s.id, s.filename, s.type::text AS type, s.language, s.created_at
       FROM source_documents s
      WHERE s.campaign_id = $1 AND s.organization_id = $2
        AND s.visibility IN ('tcl', 'compartida')
        AND ${sqlFuenteSinGuionNoAprobado('true')}
        AND ${SQL_FUENTE_SIN_EVIDENCIA_OPERATIVA}
        AND NOT (${sqlFuenteEsSheetDeInfluencers('s')})
      ORDER BY s.created_at DESC, s.id`,
    [c.id, alcance.value.organizationId],
  );
  return rows.map((r) =>
    proyectarDocumentoParaTcl({
      sourceId: r.id,
      titulo: r.filename,
      tipo: r.type,
      idioma: r.language,
      fecha: r.created_at.toISOString(),
    }),
  );
}

async function detalleDe(c: CampanaAutorizadaParaTcl, base: BaseDeCampana): Promise<CampanaDetalleTcl> {
  const { participaciones, kpis } = base;
  const productos = await cargarProductosDeCampana(c.id);
  const idsActivos = new Set(participaciones.map((p) => p.operacion.participacionId));
  const todos = [...kpis].filter(([ci]) => idsActivos.has(ci)).flatMap(([, l]) => l);
  return proyectarCampanaDetalleParaTcl({
    ...comoEntradaDeCampana(c),
    influencersActivos: participaciones.length,
    guionesAprobados: participaciones.reduce((s, p) => s + p.operacion.guion.aprobados, 0),
    guionesTotales: participaciones.reduce((s, p) => s + p.operacion.guion.total, 0),
    kpiCumplidos: todos.filter((k) => k.estado === 'cumplido').length,
    kpiTotales: todos.length,
    productos,
  });
}

// ─────────────────────────── API pública (una por sección) ─────────────────────

/** Detalle de la campaña: lo de la lista + conteos + productos. `campaign:read_client`. */
export async function obtenerDetalleTclDeCampana(
  actor: User,
  campaignId: string,
): Promise<Result<CampanaDetalleTcl>> {
  const c = await autorizarCampanaParaTcl(actor, campaignId, [CAP_CAMPANA]);
  if (!c.ok) return c;
  return ok(asegurarProyeccionTcl(await detalleDe(c.value, await cargarBase(c.value))));
}

/** Influencers activos con cuentas, productos asignados, etapa, producto recibido, guion y KPI. `campaign:read_client`. */
export async function obtenerInfluencersParaTcl(
  actor: User,
  campaignId: string,
): Promise<Result<InfluencerTcl[]>> {
  const c = await autorizarCampanaParaTcl(actor, campaignId, [CAP_CAMPANA]);
  if (!c.ok) return c;
  return ok(asegurarProyeccionTcl(await influencersDe(c.value, await cargarBase(c.value))));
}

/** Entregables activos y el estado de su guion (`aprobado` solo con fila `approved` vigente). `content:read_approved_client`. */
export async function obtenerContenidoParaTcl(
  actor: User,
  campaignId: string,
): Promise<Result<ContenidoAprobadoTcl[]>> {
  const c = await autorizarCampanaParaTcl(actor, campaignId, [CAP_CONTENIDO]);
  if (!c.ok) return c;
  return ok(asegurarProyeccionTcl(await contenidoDe(c.value)));
}

/** Brief aprobado vigente (ES y, si está vigente, EN) por lista blanca de claves; `null` sin Brief aprobado. `campaign:read_client`. */
export async function obtenerBriefParaTcl(actor: User, campaignId: string): Promise<Result<BriefTcl | null>> {
  const c = await autorizarCampanaParaTcl(actor, campaignId, [CAP_CAMPANA]);
  if (!c.ok) return c;
  return ok(asegurarProyeccionTcl(await briefDe(c.value)));
}

/** Resumen operativo por participación (sin acuerdo, modo, logística fina ni dinero). `operations:read_summary_client`. */
export async function obtenerOperacionParaTcl(
  actor: User,
  campaignId: string,
): Promise<Result<ProyeccionTclDeOperacion[]>> {
  const c = await autorizarCampanaParaTcl(actor, campaignId, [CAP_OPERACION]);
  if (!c.ok) return c;
  return ok(
    asegurarProyeccionTcl(
      operacionDe({ participaciones: await cargarParticipaciones(c.value), kpis: new Map() }),
    ),
  );
}

/** KPI por participación (bloque `public`; sin `other` ni `internal`). `kpi:read_client`. */
export async function obtenerKpisParaTcl(
  actor: User,
  campaignId: string,
): Promise<Result<KpiPorParticipacionTcl[]>> {
  const c = await autorizarCampanaParaTcl(actor, campaignId, [CAP_KPI]);
  if (!c.ok) return c;
  return ok(asegurarProyeccionTcl(kpisDe(await cargarBase(c.value))));
}

/** Documentos compartidos con TCL a propósito. `source:read_shared`. */
export async function obtenerDocumentosParaTcl(
  actor: User,
  campaignId: string,
): Promise<Result<DocumentoTcl[]>> {
  const c = await autorizarCampanaParaTcl(actor, campaignId, [CAP_DOCUMENTOS]);
  if (!c.ok) return c;
  return ok(asegurarProyeccionTcl(await documentosDe(actor, c.value)));
}

async function componer(actor: User, c: CampanaAutorizadaParaTcl): Promise<ProyeccionTclDeCampana> {
  const base = await cargarBase(c);
  const campana = await detalleDe(c, base);
  const influencers = await influencersDe(c, base);
  const contenido = await contenidoDe(c);
  const brief = await briefDe(c);
  const documentos = await documentosDe(actor, c);
  return asegurarProyeccionTcl({
    campana,
    influencers,
    contenido,
    brief,
    operacion: operacionDe(base),
    kpis: kpisDe(base),
    documentos,
  });
}

/** TODO lo que TCL ve de una campaña, en una sola estructura. Es exactamente lo que serializa el export. */
export async function obtenerProyeccionTclDeCampana(
  actor: User,
  campaignId: string,
): Promise<Result<ProyeccionTclDeCampana>> {
  const c = await autorizarCampanaParaTcl(actor, campaignId, CAPS_DE_LECTURA_COMPLETA);
  if (!c.ok) return c;
  return ok(await componer(actor, c.value));
}

export interface ExportDeCampanaTcl extends ExportDeTcl {
  /** Nombre de archivo SANEADO (`a-z0-9-`), listo para `Content-Disposition`. */
  readonly nombreDeArchivo: string;
}

/**
 * Export (CSV o JSON) de la MISMA proyección que muestra la interfaz: mismo guard (más `export:client`), misma
 * composición, sin consultas propias. `formato` desconocido ⇒ `VALIDATION_FAILED` (solo tras autorizar).
 */
export async function exportarCampanaParaTcl(
  actor: User,
  campaignId: string,
  formato: FormatoDeExportTcl | string,
): Promise<Result<ExportDeCampanaTcl>> {
  const c = await autorizarCampanaParaTcl(actor, campaignId, [...CAPS_DE_LECTURA_COMPLETA, CAP_EXPORT]);
  if (!c.ok) return c;
  if (!esFormatoDeExportTcl(formato)) {
    return err({
      code: 'VALIDATION_FAILED',
      message: 'El formato de exportación debe ser csv o json.',
      details: { field: 'formato' },
    });
  }
  const proyeccion = await componer(actor, c.value);
  const exportado = serializarExportTcl(proyeccion, formato);
  return ok({
    ...exportado,
    nombreDeArchivo: nombreDeArchivoDeExportTcl(proyeccion.campana.nombre, formato, new Date()),
  });
}
