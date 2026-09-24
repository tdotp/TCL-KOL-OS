/**
 * Registro de auditoría.
 *
 * §10.3, regla 4: cada mutación sensible genera un `AuditEvent`.
 * Se escribe SIEMPRE dentro de la misma transacción que la mutación, para que
 * no pueda existir un cambio sin su rastro.
 */

import type pg from 'pg';
import type { User } from '@tcl-kol-os/domain';

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

  await client.query(
    `INSERT INTO audit_events (organization_id, actor_id, action, entity_type, entity_id, metadata)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      organizationId,
      actorId,
      input.action,
      input.entityType,
      input.entityId ?? null,
      JSON.stringify(sanitizeMetadata(input.metadata)),
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
}

/** Auditoría de la organización del actor. Nunca de otra. */
export async function listAudit(
  client: pg.Pool | pg.PoolClient,
  organizationId: string,
  limit = 50,
): Promise<AuditEventRow[]> {
  const { rows } = await client.query<AuditEventRow>(
    `SELECT a.id, u.name AS actor_name, a.action, a.entity_type, a.entity_id, a.metadata, a.created_at
       FROM audit_events a
       LEFT JOIN users u ON u.id = a.actor_id
      WHERE a.organization_id = $1
      ORDER BY a.created_at DESC
      LIMIT $2`,
    [organizationId, limit],
  );
  return rows;
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
     SELECT a.id, u.name AS actor_name, a.action, a.entity_type, a.entity_id, a.metadata, a.created_at
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
