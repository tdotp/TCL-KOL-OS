/**
 * Acciones propuestas — human-in-the-loop verificable en servidor (V2 · Fase 1D).
 *
 *   intención → acción propuesta → control visible → confirmación humana → ejecución
 *
 * La política (quién propone, quién confirma, qué estados admiten qué) vive en
 * `packages/domain/src/proposed-actions.ts`; aquí se aplica contra la base,
 * garantizando que:
 *
 *  · la confirmación la hace una PERSONA autenticada desde la interfaz
 *    (`canal: 'ui'`); ni `system` ni `chat` confirman su propia acción;
 *  · el permiso de la persona se verifica de nuevo al confirmar y al ejecutar;
 *  · la confirmación queda ligada al contenido original (huella del payload y
 *    del estado del recurso): si algo cambió, falla;
 *  · una acción se ejecuta UNA sola vez (bloqueo de fila + estados terminales
 *    protegidos por trigger);
 *  · propuesta, confirmación y ejecución quedan en `audit_events`.
 *
 * Una herramienta del agente solo debería llamar a `proponerAccion`. Las
 * funciones `confirmarAccion` y `ejecutarAccion` exigen una persona y el canal
 * `ui`; y `transicionarBrief` rechaza `approved` desde cualquier otro canal,
 * así que no existe un atajo para aprobar «actuando como el usuario».
 */

import { createHash } from 'node:crypto';
import type pg from 'pg';
import {
  type AuditCorrelation,
  type AuditOrigin,
  type ProposedAction,
  type ProposedActionStatus,
  type ProposedActionType,
  type Result,
  type User,
  err,
  ok,
  puedeCancelar,
  puedeConfirmar,
  puedeEjecutar,
  puedeProponer,
  specDeAccion,
  transitionsFrom,
} from '@tcl-kol-os/domain';
import { recordAudit, resolveOrigin } from './audit.ts';
import { getPool, transaction } from './client.ts';
import { transicionarBriefEnTransaccion } from './transitions.ts';

const TTL_POR_DEFECTO_SEGUNDOS = 24 * 60 * 60;

const NO_ENCONTRADO = {
  code: 'RESOURCE_NOT_FOUND',
  message: 'El recurso no existe o no está disponible.',
} as const;

// ─────────────────────────── Huellas ───────────────────────────────────────────

function canonico(valor: unknown): string {
  if (Array.isArray(valor)) return `[${valor.map(canonico).join(',')}]`;
  if (valor !== null && typeof valor === 'object') {
    const claves = Object.keys(valor as Record<string, unknown>).sort();
    return `{${claves
      .map((k) => `${JSON.stringify(k)}:${canonico((valor as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(valor);
}

function sha256(texto: string): string {
  return createHash('sha256').update(texto).digest('hex');
}

/** Huella que liga tipo + recurso + payload; la confirmación debe presentarla idéntica. */
export function huellaDeAccion(
  type: string,
  resourceType: string,
  resourceId: string,
  payload: Readonly<Record<string, unknown>>,
): string {
  return sha256(canonico({ type, resourceType, resourceId, payload }));
}

/**
 * Huella del CONTENIDO de la versión del brief (campos, valores, revisiones).
 * Si cambia entre la propuesta y la confirmación, quien confirma estaría
 * aprobando algo distinto de lo que se le propuso.
 */
async function huellaDeContenidoDeVersion(
  ejecutor: pg.Pool | pg.PoolClient,
  versionId: string,
): Promise<string> {
  const { rows } = await ejecutor.query<{ k: string; p: string | null; r: number; v: string; s: string }>(
    `SELECT key AS k, campaign_product_id::text AS p, revision AS r, md5(value::text) AS v, status::text AS s
       FROM brief_fields WHERE brief_version_id = $1 ORDER BY key, campaign_product_id NULLS FIRST`,
    [versionId],
  );
  return sha256(canonico(rows));
}

// ─────────────────────────── Filas ─────────────────────────────────────────────

interface Fila {
  id: string;
  organization_id: string;
  campaign_id: string;
  action_type: string;
  resource_type: string;
  resource_id: string;
  payload: Record<string, unknown>;
  payload_hash: string;
  status: ProposedActionStatus;
  proposed_by: string | null;
  proposed_origin: AuditOrigin;
  correlation: AuditCorrelation | null;
  assigned_to: string | null;
  confirmed_by: string | null;
  confirmed_at: Date | null;
  executed_at: Date | null;
  cancelled_by: string | null;
  cancelled_at: Date | null;
  expires_at: Date;
  created_at: Date;
}

const COLUMNAS = `id, organization_id, campaign_id, action_type, resource_type, resource_id, payload,
  payload_hash, status, proposed_by, proposed_origin, correlation, assigned_to, confirmed_by,
  confirmed_at, executed_at, cancelled_by, cancelled_at, expires_at, created_at`;

function iso(d: Date | null): string | undefined {
  return d === null ? undefined : d.toISOString();
}

function comoAccion(f: Fila): ProposedAction {
  return {
    id: f.id,
    organizationId: f.organization_id,
    campaignId: f.campaign_id,
    type: f.action_type as ProposedActionType,
    resourceType: f.resource_type,
    resourceId: f.resource_id,
    payload: f.payload,
    payloadHash: f.payload_hash,
    status: f.status,
    proposedBy: f.proposed_by,
    proposedOrigin: f.proposed_origin,
    correlation: f.correlation ?? undefined,
    assignedTo: f.assigned_to ?? undefined,
    confirmedBy: f.confirmed_by ?? undefined,
    confirmedAt: iso(f.confirmed_at),
    executedAt: iso(f.executed_at),
    cancelledBy: f.cancelled_by ?? undefined,
    cancelledAt: iso(f.cancelled_at),
    expiresAt: f.expires_at.toISOString(),
    createdAt: f.created_at.toISOString(),
  };
}

/** Lee una acción propuesta con bloqueo de fila (ejecución única). */
async function cargarBloqueada(client: pg.PoolClient, id: string): Promise<Fila | undefined> {
  const { rows } = await client.query<Fila>(
    `SELECT ${COLUMNAS} FROM proposed_actions WHERE id = $1 FOR UPDATE`,
    [id],
  );
  return rows[0];
}

/** Marca como vencida una acción pendiente o confirmada cuyo plazo pasó. */
async function registrarVencimiento(client: pg.PoolClient, fila: Fila): Promise<void> {
  if (fila.status !== 'pending' && fila.status !== 'confirmed') return;
  await client.query(`UPDATE proposed_actions SET status = 'expired' WHERE id = $1`, [fila.id]);
  await recordAudit(client, {
    actor: 'system',
    organizationId: fila.organization_id,
    action: 'proposed_action.expire',
    entityType: 'proposed_action',
    entityId: fila.id,
    metadata: { type: fila.action_type, estadoAnterior: fila.status },
    correlation: { proposedActionId: fila.id },
  });
}

// ─────────────────────────── Recurso: versión del brief ────────────────────────

interface VersionDeBrief {
  readonly status: string;
  readonly campaignId: string;
  readonly organizationId: string;
}

async function cargarVersionDeBrief(
  ejecutor: pg.Pool | pg.PoolClient,
  versionId: string,
): Promise<VersionDeBrief | undefined> {
  const { rows } = await ejecutor.query<{ status: string; campaign_id: string; organization_id: string }>(
    `SELECT v.status::text AS status, b.campaign_id, c.organization_id
       FROM brief_versions v
       JOIN briefs b ON b.id = v.brief_id
       JOIN campaigns c ON c.id = b.campaign_id
      WHERE v.id = $1`,
    [versionId],
  );
  const fila = rows[0];
  return fila === undefined
    ? undefined
    : { status: fila.status, campaignId: fila.campaign_id, organizationId: fila.organization_id };
}

// ─────────────────────────── Proponer ──────────────────────────────────────────

export interface PropuestaInput {
  readonly type: ProposedActionType;
  /** Para `brief.approve`: el id de la versión del brief. */
  readonly resourceId: string;
  /** Canal que propone. Por defecto: `system` si propone el sistema; `ui` si una persona. */
  readonly origin?: AuditOrigin | undefined;
  readonly correlation?: AuditCorrelation | undefined;
  /** Si se indica, solo esa persona puede confirmar. */
  readonly assignedTo?: string | undefined;
  readonly ttlSegundos?: number | undefined;
}

/**
 * Propone una acción crítica. NO ejecuta nada: deja una acción `pending` que
 * una persona autorizada debe confirmar. Puede proponer una persona (también a
 * través del chat) o el sistema; nunca confirma.
 *
 * Idempotente: si ya hay una propuesta abierta e idéntica para el mismo recurso
 * y contenido, la devuelve; si el contenido cambió, la anterior vence y se crea
 * una nueva.
 */
export async function proponerAccion(
  actor: User | 'system',
  input: PropuestaInput,
): Promise<Result<ProposedAction>> {
  const spec = specDeAccion(input.type);
  if (spec === undefined) {
    return err({
      code: 'BRIEF_FIELD_INVALID',
      message: `«${String(input.type)}» no es una acción propuesta válida.`,
    });
  }

  const puede = puedeProponer(actor, spec);
  if (!puede.ok) return puede;

  let origin: AuditOrigin;
  try {
    origin = resolveOrigin(actor, input.origin);
  } catch (error) {
    return err({ code: 'HUMAN_CONFIRMATION_REQUIRED', message: (error as Error).message });
  }

  const version = await cargarVersionDeBrief(getPool(), input.resourceId);
  if (version === undefined || (actor !== 'system' && actor.organizationId !== version.organizationId)) {
    return err(NO_ENCONTRADO);
  }

  // Falla pronto lo que nunca podría ejecutarse: no se propone aprobar una
  // versión que no admite la transición.
  if (!transitionsFrom(version.status as never).some((t) => t.to === 'approved')) {
    return err({
      code: 'BRIEF_INVALID_TRANSITION',
      message: `Una versión en estado ${version.status} no se puede aprobar.`,
      details: { status: version.status },
    });
  }

  const payload = {
    versionId: input.resourceId,
    contentFingerprint: await huellaDeContenidoDeVersion(getPool(), input.resourceId),
  };
  const payloadHash = huellaDeAccion(input.type, spec.resourceType, input.resourceId, payload);
  const ttl = Math.max(1, Math.floor(input.ttlSegundos ?? TTL_POR_DEFECTO_SEGUNDOS));

  return transaction(async (client) => {
    // Una propuesta abierta del mismo recurso: se reutiliza si es idéntica.
    const { rows: abiertas } = await client.query<Fila>(
      `SELECT ${COLUMNAS} FROM proposed_actions
        WHERE action_type = $1 AND resource_id = $2 AND status IN ('pending', 'confirmed')
          AND expires_at > now()
        FOR UPDATE`,
      [input.type, input.resourceId],
    );
    for (const abierta of abiertas) {
      if (abierta.payload_hash === payloadHash) return ok(comoAccion(abierta));
      await registrarVencimiento(client, abierta);
    }

    const { rows } = await client.query<Fila>(
      `INSERT INTO proposed_actions
         (organization_id, campaign_id, action_type, resource_type, resource_id, payload, payload_hash,
          proposed_by, proposed_origin, correlation, assigned_to, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, now() + make_interval(secs => $12))
       RETURNING ${COLUMNAS}`,
      [
        version.organizationId,
        version.campaignId,
        input.type,
        spec.resourceType,
        input.resourceId,
        JSON.stringify(payload),
        payloadHash,
        actor === 'system' ? null : actor.id,
        origin,
        input.correlation === undefined ? null : JSON.stringify(input.correlation),
        input.assignedTo ?? null,
        ttl,
      ],
    );
    const creada = rows[0]!;

    await recordAudit(client, {
      actor,
      organizationId: version.organizationId,
      origin,
      correlation: { ...input.correlation, proposedActionId: creada.id },
      action: 'proposed_action.propose',
      entityType: 'proposed_action',
      entityId: creada.id,
      metadata: {
        type: input.type,
        resourceId: input.resourceId,
        payloadHash,
        ...(input.assignedTo !== undefined ? { assignedTo: input.assignedTo } : {}),
      },
    });

    return ok(comoAccion(creada));
  });
}

// ─────────────────────────── Confirmar ─────────────────────────────────────────

export interface ConfirmacionInput {
  /**
   * Canal por el que llega la confirmación. Solo `ui` (una persona en la
   * interfaz) es válido; cualquier otro se rechaza.
   */
  readonly canal: AuditOrigin;
  /** Huella de la acción tal como se le mostró a la persona. Debe coincidir. */
  readonly payloadHash: string;
}

/** Comprueba que el recurso no cambió desde la propuesta. */
async function verificarContenidoVigente(client: pg.PoolClient, fila: Fila): Promise<Result<true>> {
  const recalculada = huellaDeAccion(fila.action_type, fila.resource_type, fila.resource_id, fila.payload);
  if (recalculada !== fila.payload_hash) {
    return err({
      code: 'PROPOSAL_STALE',
      message: 'El contenido de la acción propuesta no coincide con su huella.',
    });
  }
  if (fila.action_type === 'brief.approve') {
    const actual = await huellaDeContenidoDeVersion(client, fila.resource_id);
    if (actual !== fila.payload['contentFingerprint']) {
      return err({
        code: 'PROPOSAL_STALE',
        message: 'El brief cambió después de proponerse la aprobación. Hay que proponerla de nuevo.',
      });
    }
  }
  return ok(true);
}

/**
 * Confirma una acción propuesta. Exige una persona con la capacidad vigente,
 * el canal `ui` y la huella exacta de lo que se le mostró. Queda asociada a la
 * persona autenticada. No ejecuta: ver `ejecutarAccion`.
 */
export async function confirmarAccion(
  actor: User | 'system',
  id: string,
  input: ConfirmacionInput,
): Promise<Result<ProposedAction>> {
  return transaction(async (client) => {
    const fila = await cargarBloqueada(client, id);
    if (fila === undefined) return err(NO_ENCONTRADO);

    const accion = comoAccion(fila);
    const permitido = puedeConfirmar(actor, input.canal, accion, new Date());
    if (!permitido.ok) {
      if (permitido.error.code === 'PROPOSAL_EXPIRED') await registrarVencimiento(client, fila);
      return permitido;
    }
    const humano = permitido.value;

    if (input.payloadHash !== fila.payload_hash) {
      return err({
        code: 'PROPOSAL_STALE',
        message: 'La confirmación no corresponde a la acción propuesta (la huella no coincide).',
      });
    }
    const vigente = await verificarContenidoVigente(client, fila);
    if (!vigente.ok) return vigente;

    const { rows } = await client.query<Fila>(
      `UPDATE proposed_actions SET status = 'confirmed', confirmed_by = $2, confirmed_at = now()
        WHERE id = $1 AND status = 'pending'
        RETURNING ${COLUMNAS}`,
      [id, humano.id],
    );
    const confirmada = rows[0];
    if (confirmada === undefined) {
      return err({ code: 'PROPOSAL_INVALID_STATE', message: 'La acción ya no está pendiente.' });
    }

    await recordAudit(client, {
      actor: humano,
      organizationId: fila.organization_id,
      origin: 'ui',
      correlation: { proposedActionId: id },
      action: 'proposed_action.confirm',
      entityType: 'proposed_action',
      entityId: id,
      metadata: {
        type: fila.action_type,
        payloadHash: fila.payload_hash,
        proposedOrigin: fila.proposed_origin,
      },
    });

    return ok(comoAccion(confirmada));
  });
}

// ─────────────────────────── Ejecutar ──────────────────────────────────────────

/**
 * Ejecuta una acción ya confirmada, una sola vez. La misma persona que
 * confirmó, con su permiso vigente, desde la interfaz. El bloqueo de fila hace
 * que dos ejecuciones simultáneas no puedan ambas proceder; la repetición
 * posterior falla porque el estado es terminal.
 *
 * Atomicidad: la aprobación del brief, el cambio a `executed` y la auditoría
 * ocurren en UNA transacción. Si el caso de uso es rechazado (por ejemplo una
 * guarda del dominio) la acción queda `confirmed` y se devuelve el error real;
 * si algo falla a mitad de camino (error de base de datos), todo se revierte:
 * nunca queda el dominio aplicado con la acción `confirmed`, ni `executed` sin
 * dominio aplicado. La acción sigue `confirmed` y puede reintentarse.
 */
export async function ejecutarAccion(
  actor: User | 'system',
  id: string,
  input: { readonly canal: AuditOrigin },
): Promise<Result<ProposedAction>> {
  return transaction(async (client) => {
    const fila = await cargarBloqueada(client, id);
    if (fila === undefined) return err(NO_ENCONTRADO);

    const accion = comoAccion(fila);
    const permitido = puedeEjecutar(actor, input.canal, accion, new Date());
    if (!permitido.ok) {
      if (permitido.error.code === 'PROPOSAL_EXPIRED') await registrarVencimiento(client, fila);
      return permitido;
    }
    const humano = permitido.value;

    const vigente = await verificarContenidoVigente(client, fila);
    if (!vigente.ok) return vigente;

    // Caso de uso: la misma aprobación humana directa que ya existía, con
    // origen `ui` (una persona lo está ejecutando) y correlación a la propuesta.
    // Corre DENTRO de esta transacción (misma conexión): el cambio de dominio,
    // la marca `executed` y la auditoría se confirman juntos o no se confirman.
    // Si cualquier paso posterior lanza, el ROLLBACK revierte también el brief.
    const resultado = await transicionarBriefEnTransaccion(client, humano, fila.resource_id, 'approved', {
      origen: 'ui',
      correlation: { proposedActionId: id },
    });
    if (!resultado.ok) return err(resultado.error);

    const { rows } = await client.query<Fila>(
      `UPDATE proposed_actions SET status = 'executed', executed_at = now()
        WHERE id = $1 AND status = 'confirmed'
        RETURNING ${COLUMNAS}`,
      [id],
    );
    const ejecutada = rows[0];
    if (ejecutada === undefined) {
      return err({ code: 'PROPOSAL_INVALID_STATE', message: 'La acción ya no está confirmada.' });
    }

    await recordAudit(client, {
      actor: humano,
      organizationId: fila.organization_id,
      origin: 'ui',
      correlation: { proposedActionId: id },
      action: 'proposed_action.execute',
      entityType: 'proposed_action',
      entityId: id,
      metadata: {
        type: fila.action_type,
        resourceId: fila.resource_id,
        proposedOrigin: fila.proposed_origin,
      },
    });

    return ok(comoAccion(ejecutada));
  });
}

// ─────────────────────────── Cancelar, leer, vencer ────────────────────────────

/** Cancela una acción pendiente o confirmada (quien la propuso, o quien puede confirmarla). */
export async function cancelarAccion(actor: User, id: string): Promise<Result<ProposedAction>> {
  return transaction(async (client) => {
    const fila = await cargarBloqueada(client, id);
    if (fila === undefined) return err(NO_ENCONTRADO);

    const permitido = puedeCancelar(actor, comoAccion(fila));
    if (!permitido.ok) return permitido;

    const { rows } = await client.query<Fila>(
      `UPDATE proposed_actions SET status = 'cancelled', cancelled_by = $2, cancelled_at = now()
        WHERE id = $1 AND status IN ('pending', 'confirmed')
        RETURNING ${COLUMNAS}`,
      [id, actor.id],
    );
    const cancelada = rows[0];
    if (cancelada === undefined) {
      return err({ code: 'PROPOSAL_INVALID_STATE', message: 'La acción ya no se puede cancelar.' });
    }

    await recordAudit(client, {
      actor,
      organizationId: fila.organization_id,
      origin: 'ui',
      correlation: { proposedActionId: id },
      action: 'proposed_action.cancel',
      entityType: 'proposed_action',
      entityId: id,
      metadata: { type: fila.action_type, estadoAnterior: fila.status },
    });

    return ok(comoAccion(cancelada));
  });
}

/** Lee una acción propuesta de la organización del actor. */
export async function obtenerAccionPropuesta(actor: User, id: string): Promise<Result<ProposedAction>> {
  const { rows } = await getPool().query<Fila>(
    `SELECT ${COLUMNAS} FROM proposed_actions WHERE id = $1 AND organization_id = $2`,
    [id, actor.organizationId],
  );
  const fila = rows[0];
  if (fila === undefined || actor.status !== 'activo') return err(NO_ENCONTRADO);
  const spec = specDeAccion(fila.action_type);
  if (spec === undefined) return err(NO_ENCONTRADO);
  return ok(comoAccion(fila));
}

/**
 * Marca como vencidas las acciones pendientes o confirmadas cuyo plazo pasó.
 * Pensada para correrse periódicamente; no es necesaria para la corrección
 * (confirmar y ejecutar ya rechazan una acción vencida).
 */
export async function vencerAccionesCaducadas(): Promise<number> {
  return transaction(async (client) => {
    const { rows } = await client.query<Fila>(
      `SELECT ${COLUMNAS} FROM proposed_actions
        WHERE status IN ('pending', 'confirmed') AND expires_at <= now()
        FOR UPDATE`,
    );
    for (const fila of rows) await registrarVencimiento(client, fila);
    return rows.length;
  });
}
