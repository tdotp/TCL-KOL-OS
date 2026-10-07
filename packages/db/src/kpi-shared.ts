/**
 * Piezas comunes de los casos de uso de KPI (V2 · Fase 8, W2a): transacción con traducción de errores de la base,
 * lectura de la participación, filas y vistas de objetivos y mediciones.
 *
 * Reglas de oro (las mismas de `agreements.ts` / `deliverables.ts`):
 *  · Recurso de otra organización o actor `cliente` → `RESOURCE_NOT_FOUND`; rol sin la capacidad → `FORBIDDEN_ROLE`.
 *  · Las invariantes también las impone la base (migración 032): aquí se validan ANTES para devolver errores de
 *    dominio con motivo; una carrera que las pase produce un conflicto, no un 500.
 *  · La auditoría se escribe en la MISMA transacción, con ids, métrica y unidad: jamás texto libre (motivos,
 *    etiquetas `other`) ni valores.
 */

import type pg from 'pg';
import {
  type Action,
  type KpiComparator,
  type KpiMetric,
  type KpiUnit,
  type MedicionDeKpi,
  type ObjetivoDeKpi,
  type Result,
  type User,
  authorizeInternalResource,
  err,
  ok,
} from '@tcl-kol-os/domain';
import { transaction } from './client.ts';
import { NO_ENCONTRADO_DE_CONTENIDO, esUuid } from './deliverables.ts';
import { Abortar } from './tx-result.ts';

export type Consultor = pg.Pool | pg.PoolClient;

export const NO_ENCONTRADO = NO_ENCONTRADO_DE_CONTENIDO;
export { esUuid };

// ─────────────────────────── Errores ───────────────────────────────────────────

export function conflicto(message: string, reason: string, extra: Record<string, unknown> = {}): Abortar {
  return new Abortar({ code: 'RESOURCE_CONFLICT', message, details: { reason, ...extra } });
}

export function invalido(message: string, field: string, reason?: string): Abortar {
  return new Abortar({
    code: 'VALIDATION_FAILED',
    message,
    details: reason === undefined ? { field } : { field, reason },
  });
}

/** Desenvuelve un `Result` del dominio o aborta la transacción con su error. */
export function aceptar<T>(r: Result<T>): T {
  if (!r.ok) throw new Abortar({ code: r.error.code, message: r.error.message, details: r.error.details });
  return r.value;
}

export function autorizarOAbortar(actor: User, action: Action, organizationId: string): void {
  const r = authorizeInternalResource(actor, action, organizationId);
  if (!r.ok) throw new Abortar({ code: r.error.code, message: r.error.message, details: r.error.details });
}

interface ErrorDePg {
  readonly code?: unknown;
  readonly constraint?: unknown;
  readonly message?: unknown;
}

const CONFLICTOS_DE_UNICIDAD: Readonly<Record<string, { reason: string; message: string }>> = {
  kpi_targets_vigente_key: {
    reason: 'active_target_exists',
    message: 'Ya hay un objetivo vigente para ese ámbito y esa métrica: reemplácelo en lugar de crear otro.',
  },
  kpi_targets_sucesor_key: {
    reason: 'already_superseded',
    message: 'Ese objetivo ya tiene un sucesor.',
  },
  kpi_measurements_correccion_key: {
    reason: 'already_corrected',
    message: 'Esa medición ya fue corregida (una sola corrección por medición).',
  },
  kpi_targets_clave_key: {
    reason: 'idempotency_key_reused',
    message: 'Esa clave de idempotencia ya se usó con otra solicitud.',
  },
  kpi_measurements_clave_key: {
    reason: 'idempotency_key_reused',
    message: 'Esa clave de idempotencia ya se usó con otra solicitud.',
  },
};

/** Traduce un rechazo de la base (también los diferidos al COMMIT) a un error de dominio, o `undefined`. */
export function errorDeBaseComoAbortar(error: unknown): Abortar | undefined {
  const e = (typeof error === 'object' && error !== null ? error : {}) as ErrorDePg;
  const mensaje = typeof e.message === 'string' ? e.message : 'La base rechazó la operación.';
  if (e.code === 'P0001') return conflicto(mensaje, 'db_rule');
  if (e.code === '23514') {
    return new Abortar({
      code: 'VALIDATION_FAILED',
      message: 'Un valor no cumple las reglas de la base.',
      details: { reason: 'db_check' },
    });
  }
  if (e.code === '23505') {
    const conocido = typeof e.constraint === 'string' ? CONFLICTOS_DE_UNICIDAD[e.constraint] : undefined;
    return conflicto(conocido?.message ?? 'El registro ya existe.', conocido?.reason ?? 'duplicate');
  }
  if (e.code === '23503') {
    return new Abortar({
      code: 'VALIDATION_FAILED',
      message: 'Una referencia no existe o no pertenece a esta campaña.',
      details: { reason: 'db_reference' },
    });
  }
  if (e.code === '40001' || e.code === '40P01') {
    return conflicto(
      'Otra operación simultánea tocó el mismo registro: inténtelo de nuevo.',
      'concurrent_update',
    );
  }
  return undefined;
}

/**
 * Transacción de un caso de uso de KPI, con `Result`. Una violación de UNIQUE concurrente (doble envío, dos
 * reemplazos, dos correcciones) se REINTENTA una vez: la segunda pasada ve lo que la ganadora dejó y responde con
 * el reintento idéntico o con el conflicto con su motivo; si aun así choca, se traduce.
 */
export async function transaccionKpi<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<Result<T>> {
  for (let intento = 0; ; intento++) {
    try {
      return ok(await transaction(fn));
    } catch (error) {
      if (error instanceof Abortar) return err(error.payload);
      const e = (typeof error === 'object' && error !== null ? error : {}) as ErrorDePg;
      if (e.code === '23505' && intento === 0) continue;
      const traducido = errorDeBaseComoAbortar(error);
      if (traducido !== undefined) return err(traducido.payload);
      throw error;
    }
  }
}

/** Ejecuta una lectura: un `Abortar` se devuelve como error de dominio; lo demás se relanza. */
export async function lectura<T>(fn: () => Promise<T>): Promise<Result<T>> {
  try {
    return ok(await fn());
  } catch (error) {
    if (error instanceof Abortar) return err(error.payload);
    throw error;
  }
}

// ─────────────────────────── Participación ─────────────────────────────────────

export interface ParticipacionDeKpi {
  readonly id: string;
  readonly organization_id: string;
  readonly campaign_id: string;
  readonly status: string;
  readonly campana: string;
}

/** Participación y estado de su campaña. `bloquear`: `FOR SHARE` de la participación (serializa con su retiro). */
export async function leerParticipacion(
  db: Consultor,
  id: unknown,
  bloquear: boolean,
): Promise<ParticipacionDeKpi | undefined> {
  if (!esUuid(id)) return undefined;
  const { rows } = await db.query<ParticipacionDeKpi>(
    `SELECT ci.id, ci.organization_id, ci.campaign_id, ci.status::text AS status, c.status::text AS campana
       FROM campaign_influencers ci
       JOIN campaigns c ON c.id = ci.campaign_id
      WHERE ci.id = $1
      ${bloquear ? 'FOR SHARE OF ci' : ''}`,
    [id],
  );
  return rows[0];
}

/** El entregable (si viene) es de ESTA participación. */
export async function exigirEntregableDeParticipacion(
  db: Consultor,
  deliverableId: string | null | undefined,
  campaignInfluencerId: string,
): Promise<string | null> {
  if (deliverableId === undefined || deliverableId === null) return null;
  if (!esUuid(deliverableId)) {
    throw invalido('El entregable no es válido.', 'deliverableId', 'deliverable_not_in_participation');
  }
  const { rows } = await db.query<{ id: string }>(
    `SELECT id FROM deliverables WHERE id = $1 AND campaign_influencer_id = $2`,
    [deliverableId, campaignInfluencerId],
  );
  if (rows[0] === undefined) {
    throw invalido(
      'El entregable no pertenece a esta participación.',
      'deliverableId',
      'deliverable_not_in_participation',
    );
  }
  return deliverableId;
}

// ─────────────────────────── Vistas ────────────────────────────────────────────

export type EstadoDeObjetivo = 'active' | 'superseded' | 'retired';

export interface ObjetivoDeKpiVista {
  readonly id: string;
  readonly campaignId: string;
  readonly campaignInfluencerId: string;
  readonly deliverableId: string | null;
  readonly platform: string | null;
  readonly metric: KpiMetric;
  readonly otherLabel: string | null;
  readonly unit: KpiUnit;
  readonly targetValue: number;
  readonly comparator: KpiComparator;
  readonly periodStart: string | null;
  readonly periodEnd: string | null;
  readonly status: EstadoDeObjetivo;
  readonly supersedesId: string | null;
  readonly origin: 'manual' | 'sheet_suggestion';
  readonly originChannel: 'ui' | 'chat';
  readonly createdBy: string;
  readonly createdAt: string;
  readonly supersededAt: string | null;
  readonly retiredAt: string | null;
}

export interface MedicionDeKpiVista {
  readonly id: string;
  readonly campaignId: string;
  readonly campaignInfluencerId: string;
  readonly deliverableId: string | null;
  readonly platform: string | null;
  readonly metric: KpiMetric;
  readonly otherLabel: string | null;
  readonly unit: KpiUnit;
  readonly value: number;
  readonly observedAt: string;
  readonly periodStart: string | null;
  readonly periodEnd: string | null;
  readonly supersedesId: string | null;
  readonly recordedBy: string;
  readonly recordedAt: string;
}

export interface FilaDeObjetivo {
  readonly id: string;
  readonly organization_id: string;
  readonly campaign_id: string;
  readonly campaign_influencer_id: string;
  readonly deliverable_id: string | null;
  readonly platform: string | null;
  readonly metric: KpiMetric;
  readonly other_label: string | null;
  readonly unit: KpiUnit;
  readonly target_value: string;
  readonly comparator: KpiComparator;
  readonly period_start: string | null;
  readonly period_end: string | null;
  readonly status: EstadoDeObjetivo;
  readonly supersedes_id: string | null;
  readonly superseded_at: Date | null;
  readonly retired_at: Date | null;
  readonly retired_by: string | null;
  readonly origin: 'manual' | 'sheet_suggestion';
  readonly source_snapshot_id: string | null;
  readonly source_locator: unknown;
  readonly source_text_hash: string | null;
  readonly origin_channel: 'ui' | 'chat';
  readonly idempotency_key: string;
  readonly request_hash: string;
  readonly created_by: string;
  readonly created_at: Date;
  readonly seq: string;
}

/** Columnas por lista blanca (nunca `SELECT *`). Fechas de periodo como texto. */
const COLUMNAS_DE_OBJETIVO = `
         t.id, t.organization_id, t.campaign_id, t.campaign_influencer_id, t.deliverable_id, t.platform,
         t.metric, t.other_label, t.unit, t.target_value::text AS target_value, t.comparator,
         t.period_start::text AS period_start, t.period_end::text AS period_end, t.status, t.supersedes_id,
         t.superseded_at, t.retired_at, t.retired_by, t.origin, t.source_snapshot_id, t.source_locator,
         t.source_text_hash, t.origin_channel, t.idempotency_key, t.request_hash, t.created_by, t.created_at,
         t.seq::text AS seq`;

export const SELECT_OBJETIVO = `SELECT ${COLUMNAS_DE_OBJETIVO} FROM kpi_targets t`;
/** Con el nombre de quien lo fijó (`actor_name`): solo para el bloque interno. */
export const SELECT_OBJETIVO_CON_AUTOR = `SELECT ${COLUMNAS_DE_OBJETIVO}, u.name AS actor_name
    FROM kpi_targets t JOIN users u ON u.id = t.created_by`;

export function comoObjetivoVista(f: FilaDeObjetivo): ObjetivoDeKpiVista {
  return {
    id: f.id,
    campaignId: f.campaign_id,
    campaignInfluencerId: f.campaign_influencer_id,
    deliverableId: f.deliverable_id,
    platform: f.platform,
    metric: f.metric,
    otherLabel: f.other_label,
    unit: f.unit,
    targetValue: Number(f.target_value),
    comparator: f.comparator,
    periodStart: f.period_start,
    periodEnd: f.period_end,
    status: f.status,
    supersedesId: f.supersedes_id,
    origin: f.origin,
    originChannel: f.origin_channel,
    createdBy: f.created_by,
    createdAt: f.created_at.toISOString(),
    supersededAt: f.superseded_at === null ? null : f.superseded_at.toISOString(),
    retiredAt: f.retired_at === null ? null : f.retired_at.toISOString(),
  };
}

export function comoObjetivoDeDominio(f: FilaDeObjetivo): ObjetivoDeKpi {
  return {
    id: f.id,
    campaignInfluencerId: f.campaign_influencer_id,
    deliverableId: f.deliverable_id,
    platform: f.platform,
    metric: f.metric,
    otherLabel: f.other_label,
    unit: f.unit,
    targetValue: Number(f.target_value),
    comparator: f.comparator,
  };
}

export interface FilaDeMedicion {
  readonly id: string;
  readonly organization_id: string;
  readonly campaign_id: string;
  readonly campaign_influencer_id: string;
  readonly deliverable_id: string | null;
  readonly platform: string | null;
  readonly metric: KpiMetric;
  readonly other_label: string | null;
  readonly unit: KpiUnit;
  readonly value: string;
  readonly observed_at: Date;
  readonly period_start: string | null;
  readonly period_end: string | null;
  readonly recorded_by: string;
  readonly recorded_at: Date;
  readonly origin_channel: string;
  readonly idempotency_key: string;
  readonly request_hash: string;
  readonly supersedes_id: string | null;
  readonly correction_reason: string | null;
  readonly seq: string;
}

const COLUMNAS_DE_MEDICION = `
         m.id, m.organization_id, m.campaign_id, m.campaign_influencer_id, m.deliverable_id, m.platform,
         m.metric, m.other_label, m.unit, m.value::text AS value, m.observed_at,
         m.period_start::text AS period_start, m.period_end::text AS period_end, m.recorded_by, m.recorded_at,
         m.origin_channel, m.idempotency_key, m.request_hash, m.supersedes_id, m.correction_reason,
         m.seq::text AS seq`;

export const SELECT_MEDICION = `SELECT ${COLUMNAS_DE_MEDICION} FROM kpi_measurements m`;
/** Con el nombre de quien la registró (`actor_name`): solo para el bloque interno. */
export const SELECT_MEDICION_CON_AUTOR = `SELECT ${COLUMNAS_DE_MEDICION}, u.name AS actor_name
    FROM kpi_measurements m JOIN users u ON u.id = m.recorded_by`;

export function comoMedicionVista(f: FilaDeMedicion): MedicionDeKpiVista {
  return {
    id: f.id,
    campaignId: f.campaign_id,
    campaignInfluencerId: f.campaign_influencer_id,
    deliverableId: f.deliverable_id,
    platform: f.platform,
    metric: f.metric,
    otherLabel: f.other_label,
    unit: f.unit,
    value: Number(f.value),
    observedAt: f.observed_at.toISOString(),
    periodStart: f.period_start,
    periodEnd: f.period_end,
    supersedesId: f.supersedes_id,
    recordedBy: f.recorded_by,
    recordedAt: f.recorded_at.toISOString(),
  };
}

export function comoMedicionDeDominio(f: FilaDeMedicion): MedicionDeKpi {
  return {
    id: f.id,
    campaignInfluencerId: f.campaign_influencer_id,
    deliverableId: f.deliverable_id,
    platform: f.platform,
    metric: f.metric,
    otherLabel: f.other_label,
    unit: f.unit,
    value: Number(f.value),
    observedAt: f.observed_at.toISOString(),
    seq: Number(f.seq),
    supersedesId: f.supersedes_id,
  };
}
