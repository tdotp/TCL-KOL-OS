/**
 * Registro de auditoría.
 *
 * §10.3, regla 4: cada mutación sensible genera un `AuditEvent`.
 * Se escribe SIEMPRE dentro de la misma transacción que la mutación, para que
 * no pueda existir un cambio sin su rastro.
 */

import type pg from 'pg';
import { getPool } from './client.ts';
import {
  AUDIT_ORIGINS,
  roleCan,
  type AuditCorrelation,
  type AuditOrigin,
  type User,
  isKpiMetric,
} from '@tcl-kol-os/domain';

export interface AuditInput {
  /**
   * `'system'` audita una transición disparada por el worker (p. ej.
   * `processing → extraction_review`), no por una persona — Sprint 4, cierre.
   * En ese caso `organizationId` es obligatorio, porque no hay `User` del que
   * derivarlo.
   */
  readonly actor: User | 'system';
  readonly organizationId?: string | undefined;
  readonly action: string;
  readonly entityType: string;
  readonly entityId?: string | undefined;
  readonly metadata?: Readonly<Record<string, unknown>> | undefined;
  /**
   * Canal desde el que ocurrió la acción (V2 · Fase 1C). Por defecto: `system`
   * si el actor es el sistema, `ui` si es una persona. Una persona nunca queda
   * registrada como `system`, ni el sistema como `ui`.
   */
  readonly origin?: AuditOrigin | undefined;
  /** Correlación opcional con conversación / mensaje / ejecución / acción propuesta. */
  readonly correlation?: AuditCorrelation | undefined;
}

const CLAVES_DE_CORRELACION = [
  'conversationId',
  'messageId',
  'agentRunId',
  'toolInvocationId',
  'proposedActionId',
] as const;

/** Solo las claves conocidas y con valor de texto; nada más llega a la base. */
export function sanitizeCorrelation(
  correlation: AuditCorrelation | undefined,
): Record<string, string> | null {
  if (correlation === undefined) return null;
  const limpio: Record<string, string> = {};
  for (const clave of CLAVES_DE_CORRELACION) {
    const valor = correlation[clave];
    if (typeof valor === 'string' && valor !== '') limpio[clave] = valor;
  }
  return Object.keys(limpio).length === 0 ? null : limpio;
}

/**
 * Una invocación de tool (`toolInvocationId`, V2 · Fase 6) solo existe dentro del
 * agente: lo que lleva esa correlación se registra con origen `chat`. (Las
 * confirmaciones y ejecuciones humanas usan `ui` con `proposedActionId`.)
 */
export function validarCorrelacion(origin: AuditOrigin, correlation: AuditCorrelation | undefined): void {
  const herramienta = sanitizeCorrelation(correlation)?.['toolInvocationId'];
  if (herramienta !== undefined && origin !== 'chat') {
    throw new Error('recordAudit: una correlación con toolInvocationId solo se registra con origen chat.');
  }
}

/** Origen efectivo de un evento, validando que sea coherente con el actor. */
export function resolveOrigin(actor: User | 'system', origin: AuditOrigin | undefined): AuditOrigin {
  const efectivo = origin ?? (actor === 'system' ? 'system' : 'ui');
  if (!AUDIT_ORIGINS.includes(efectivo)) {
    throw new Error(`recordAudit: origen «${String(efectivo)}» no válido.`);
  }
  if (actor === 'system' && efectivo !== 'system') {
    throw new Error('recordAudit: una acción del sistema no puede registrarse con origen ui o chat.');
  }
  if (actor !== 'system' && efectivo === 'system') {
    throw new Error('recordAudit: una acción de una persona no puede registrarse con origen system.');
  }
  return efectivo;
}

/**
 * Los logs no llevan contenido sensible (§11.6, caso S-10).
 * `metadata` guarda qué cambió, no necesariamente el contenido íntegro.
 */
const CLAVES_PROHIBIDAS = new Set([
  'password',
  'token',
  'accessToken',
  'refreshToken',
  'apiKey',
  'secret',
  'cedula',
  'telefono',
  'direccion',
]);

/**
 * V2 · Fase 8 (DEC-049, DEC-013): las acciones operativas y de PII se auditan con una
 * ALLOWLIST estricta, no con la denylist de arriba. Su metadata solo puede llevar
 * identificadores, estados, versiones, conteos, tipos y nombres de campo — jamás montos,
 * referencias externas, notas, nombres de archivo ni valores de datos personales. Lo que
 * no está permitido se redacta (no se descarta en silencio, para que el defecto se vea).
 */
export const PREFIJOS_OPERATIVOS = [
  'pii.',
  'shipment.',
  'payment.',
  'payment_obligation.',
  'billing.',
  'agreement.',
  'ops_evidence.',
  'operational_event.',
] as const;

const CLAVES_OPERATIVAS_PERMITIDAS = new Set([
  'status',
  'fromStatus',
  'toStatus',
  'eventType',
  'subjectType',
  'version',
  'seq',
  'count',
  'kind',
  'mode',
  'compensationType',
  'idempotent',
  'replayed',
  'hasEvidence',
  'evidenceCount',
  'fields',
  'itemCount',
  // KPI (`kpi_target.*`, `kpi_measurement.*`): la métrica es un token del catálogo y la unidad un token corto.
  'metric',
  'unit',
]);

/**
 * V2 · Fase 8: los KPI también se auditan con la allowlist (ids, `metric` del catálogo, `unit`, `version`; el
 * resto se redacta: jamás el valor, la etiqueta `other`, el motivo de una corrección ni texto del Sheet). NO son
 * «operativos» para el lector de la actividad (no son financieros ni de PII): por eso no están en
 * `PREFIJOS_OPERATIVOS`.
 */
const PREFIJOS_DE_KPI = ['kpi_target.', 'kpi_measurement.'] as const;

export function esAccionDeKpi(action: string): boolean {
  return PREFIJOS_DE_KPI.some((p) => action.startsWith(p));
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOKEN_CORTO = /^[A-Za-z0-9_.:-]{1,48}$/;

function valorOperativoSeguro(clave: string, v: unknown): boolean {
  if (clave === 'metric') return typeof v === 'string' && isKpiMetric(v);
  if (typeof v === 'boolean' || typeof v === 'number') return Number.isFinite(Number(v));
  if (v === null) return true;
  if (typeof v === 'string') return /(^id$|Id$|_id$)/.test(clave) ? UUID.test(v) : TOKEN_CORTO.test(v);
  if (clave === 'fields' && Array.isArray(v)) {
    return v.length <= 8 && v.every((x) => typeof x === 'string' && /^[a-z_]{1,24}$/.test(x));
  }
  return false;
}

export function esAccionOperativa(action: string): boolean {
  return PREFIJOS_OPERATIVOS.some((p) => action.startsWith(p));
}

export function sanitizeMetadataOperativa(
  metadata: Readonly<Record<string, unknown>> | undefined,
): Record<string, unknown> {
  if (metadata === undefined) return {};
  const limpio: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(metadata)) {
    const claveOk = CLAVES_OPERATIVAS_PERMITIDAS.has(k) || /(^id$|Id$|_id$)/.test(k);
    limpio[k] = claveOk && valorOperativoSeguro(k, v) ? v : '[redactado]';
  }
  return limpio;
}

export function sanitizeMetadata(
  metadata: Readonly<Record<string, unknown>> | undefined,
): Record<string, unknown> {
  if (metadata === undefined) return {};
  const limpio: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(metadata)) {
    limpio[k] = CLAVES_PROHIBIDAS.has(k) ? '[redactado]' : v;
  }
  return limpio;
}

export async function recordAudit(client: pg.PoolClient, input: AuditInput): Promise<void> {
  // `input.organizationId` explícito manda siempre que se pase — necesario
  // desde Sprint 5, donde un actor `cliente` (de OTRA organización, DEC-012)
  // puede transicionar el brief de la agencia: el evento debe quedar
  // archivado bajo la organización DUEÑA del recurso, no la del actor, o el
  // rastro de auditoría de la agencia nunca lo vería (`listAudit` filtra por
  // `actor.organizationId` de quien consulta). Sin `organizationId` explícito,
  // se sigue derivando de `actor.organizationId` como antes.
  const organizationId =
    input.organizationId ?? (input.actor === 'system' ? undefined : input.actor.organizationId);
  if (!organizationId) {
    throw new Error('recordAudit: organizationId es obligatorio cuando el actor es "system".');
  }
  const actorId = input.actor === 'system' ? null : input.actor.id;
  const origin = resolveOrigin(input.actor, input.origin);
  validarCorrelacion(origin, input.correlation);
  const correlation = sanitizeCorrelation(input.correlation);

  await client.query(
    `INSERT INTO audit_events
       (organization_id, actor_id, action, entity_type, entity_id, metadata, origin, correlation)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      organizationId,
      actorId,
      input.action,
      input.entityType,
      input.entityId ?? null,
      JSON.stringify(
        esAccionOperativa(input.action) || esAccionDeKpi(input.action)
          ? sanitizeMetadataOperativa(input.metadata)
          : sanitizeMetadata(input.metadata),
      ),
      origin,
      correlation === null ? null : JSON.stringify(correlation),
    ],
  );
}

export interface AuditEventRow {
  readonly id: string;
  readonly actor_name: string | null;
  readonly action: string;
  readonly entity_type: string;
  readonly entity_id: string | null;
  readonly metadata: Record<string, unknown>;
  readonly created_at: Date;
  /** `null` = evento anterior a V2 (origen no registrado). */
  readonly origin: AuditOrigin | null;
  readonly correlation: AuditCorrelation | null;
}

export interface OpcionesDeListaDeAuditoria {
  /**
   * Incluye las acciones operativas y de PII (`PREFIJOS_OPERATIVOS`: pii, pagos, cobro, acuerdos, envíos,
   * evidencia). Por omisión se EXCLUYEN: quién reportó un pago o reveló datos personales y cuándo es actividad
   * financiera/de PII. Solo quien tiene `finance:read` la pide (la decide el llamador con `roleCan`).
   */
  readonly incluirOperativas?: boolean | undefined;
}

/**
 * Auditoría de la organización del actor. Nunca de otra. Sin `incluirOperativas`, excluye las acciones
 * operativas/PII (mismo criterio que `esAccionOperativa`: no hay una segunda lista).
 */
export async function listAudit(
  client: pg.Pool | pg.PoolClient,
  organizationId: string,
  limit = 50,
  opciones: OpcionesDeListaDeAuditoria = {},
): Promise<AuditEventRow[]> {
  const excluir = opciones.incluirOperativas !== true;
  const { rows } = await client.query<AuditEventRow>(
    `SELECT a.id, u.name AS actor_name, a.action, a.entity_type, a.entity_id, a.metadata, a.created_at,
            a.origin, a.correlation
       FROM audit_events a
       LEFT JOIN users u ON u.id = a.actor_id
      WHERE a.organization_id = $1
        AND ($3::boolean = false
             OR NOT EXISTS (SELECT 1 FROM unnest($4::text[]) p WHERE starts_with(a.action, p)))
      ORDER BY a.created_at DESC
      LIMIT $2`,
    [organizationId, limit, excluir, [...PREFIJOS_OPERATIVOS]],
  );
  return rows;
}

/**
 * Actividad reciente de la organización del actor para el Inicio y la lista de campañas. Caso de uso CON actor:
 * sin `audit:read` devuelve vacío (el cliente TCL nunca la ve) y las acciones operativas/PII solo se incluyen con
 * `finance:read`. Sustituye a las compuertas que antes vivían copiadas en las páginas.
 */
export async function actividadReciente(actor: User, limite = 6): Promise<AuditEventRow[]> {
  if (!roleCan(actor.role, 'audit:read')) return [];
  return listAudit(getPool(), actor.organizationId, limite, {
    incluirOperativas: roleCan(actor.role, 'finance:read'),
  });
}

/**
 * Auditoría de una campaña concreta (Sprint 6, Fase B — `BriefWorkspace.activity`).
 *
 * `audit_events.entity_id` es heterogéneo a propósito (§10.3): según la
 * mutación, apunta a la campaña, una versión, un campo, una pregunta o un
 * comentario — nunca hay una FK directa a `campaign_id` en la tabla de
 * auditoría porque no toda mutación ocurre sobre un recurso que la tenga.
 * Esta consulta reconstruye la pertenencia a la campaña por cada tipo de
 * entidad, en un solo viaje a la base — "no crear otra fuente paralela de
 * auditoría, esta vista se deriva de registros existentes" (Sprint 6 §6.3).
 */
export async function listBriefActivity(
  client: pg.Pool | pg.PoolClient,
  organizationId: string,
  campaignId: string,
  limit = 30,
): Promise<AuditEventRow[]> {
  const { rows } = await client.query<AuditEventRow>(
    `WITH version_ids AS (
       SELECT v.id FROM brief_versions v JOIN briefs b ON b.id = v.brief_id WHERE b.campaign_id = $2
     ), field_ids AS (
       SELECT id FROM brief_fields WHERE brief_version_id IN (SELECT id FROM version_ids)
     ), question_ids AS (
       SELECT id FROM local_questions WHERE campaign_id = $2
     ), comment_ids AS (
       SELECT id FROM field_comments WHERE brief_version_id IN (SELECT id FROM version_ids)
     )
     SELECT a.id, u.name AS actor_name, a.action, a.entity_type, a.entity_id, a.metadata, a.created_at,
            a.origin, a.correlation
       FROM audit_events a
       LEFT JOIN users u ON u.id = a.actor_id
      WHERE a.organization_id = $1
        AND (
          (a.entity_type = 'campaign' AND a.entity_id = $2)
          OR (a.entity_type = 'brief_version' AND a.entity_id IN (SELECT id FROM version_ids))
          OR (a.entity_type = 'brief_field' AND a.entity_id IN (SELECT id FROM field_ids))
          OR (a.entity_type = 'local_question' AND a.entity_id IN (SELECT id FROM question_ids))
          OR (a.entity_type = 'field_comment' AND a.entity_id IN (SELECT id FROM comment_ids))
        )
      ORDER BY a.created_at DESC
      LIMIT $3`,
    [organizationId, campaignId, limit],
  );
  return rows;
}
