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
