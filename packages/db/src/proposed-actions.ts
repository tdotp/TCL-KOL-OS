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
 * Una herramienta del agente solo debería llamar a `proponerAccion` (y a las
 * lecturas). Las funciones `confirmarAccion` y `ejecutarAccion` exigen una
 * persona y el canal `ui`; y `transicionarBrief`, `applyInfluencerImport` y
 * `resolveImportRecord` rechazan el canal `chat` para sus decisiones críticas,
 * así que no existe un atajo para decidir «actuando como el usuario».
 *
 * Lo propio de cada TIPO de acción (qué recurso valida, qué huella calcula, qué
 * caso de uso ejecuta y con qué garantía de atomicidad) vive en el registro de
 * handlers `proposed-action-handlers.ts` (V2 · Fase 6); este módulo es el ciclo
 * común y no conoce ningún tipo concreto.
 */

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
  rolPuedeConfirmar,
  rolPuedeProponer,
  specDeAccion,
} from '@tcl-kol-os/domain';
import { recordAudit, resolveOrigin } from './audit.ts';
import { type ContextoDeAuditoria, exigirPersona } from './audit-context.ts';
import { getPool, transaction } from './client.ts';
import { canonico, handlerDe, sha256 } from './proposed-action-handlers.ts';

const TTL_POR_DEFECTO_SEGUNDOS = 24 * 60 * 60;

/** Reintentos ante una violación del UNIQUE parcial de propuestas abiertas (carrera). */
const INTENTOS_DE_PROPUESTA = 3;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const NO_ENCONTRADO = {
  code: 'RESOURCE_NOT_FOUND',
  message: 'El recurso no existe o no está disponible.',
} as const;

// ─────────────────────────── Huellas ───────────────────────────────────────────

/** Huella que liga tipo + recurso + payload; la confirmación debe presentarla idéntica. */
export function huellaDeAccion(
  type: string,
  resourceType: string,
  resourceId: string,
  payload: Readonly<Record<string, unknown>>,
): string {
  return sha256(canonico({ type, resourceType, resourceId, payload }));
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

// ─────────────────────────── Proponer ──────────────────────────────────────────

export interface PropuestaInput {
  readonly type: ProposedActionType;
  /**
   * El recurso sobre el que se propone: para `brief.approve`, la versión del
   * brief; para `influencer_import.apply`, el plan; para
   * `influencer_import.resolve_record`, el registro del plan.
   */
  readonly resourceId: string;
  /** Canal que propone. Por defecto: `system` si propone el sistema; `ui` si una persona. */
  readonly origin?: AuditOrigin | undefined;
  readonly correlation?: AuditCorrelation | undefined;
  /** Si se indica, solo esa persona puede confirmar. */
  readonly assignedTo?: string | undefined;
  readonly ttlSegundos?: number | undefined;
  /**
   * Parámetros propios del tipo (p. ej. `{ decision }` de
   * `influencer_import.resolve_record`). Entrada NO confiable: la valida el
   * handler del tipo.
   */
  readonly parametros?: Readonly<Record<string, unknown>> | undefined;
  /**
   * Alcance de campaña: si se indica (el chat pasa la de la conversación), el
   * recurso debe pertenecer a esa campaña; si es de otra, `RESOURCE_NOT_FOUND`.
   */
  readonly campaignId?: string | undefined;
}

/** Violación de un índice UNIQUE (propuesta abierta duplicada por una carrera). */
function esViolacionUnica(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === '23505';
}

/**
 * Propone una acción crítica. NO ejecuta nada: deja una acción `pending` que
 * una persona autorizada debe confirmar. Puede proponer una persona (también a
 * través del chat) o el sistema; nunca confirma.
 *
 * Idempotente: si ya hay una propuesta abierta e idéntica para el mismo recurso
 * y contenido, la devuelve; si el contenido cambió, la anterior vence y se crea
 * una nueva.
 *
 * Concurrencia (V2 · Fase 6, D7): N propuestas simultáneas sobre el mismo
 * (tipo, recurso) dejan UNA vigente. Un bloqueo consultivo transaccional por
 * (tipo, recurso) las serializa (no hay fila que bloquear cuando aún no hay
 * propuesta abierta); además, antes de insertar se vencen las abiertas cuyo
 * plazo pasó (si no, ocuparían el índice único parcial), y si el índice único
 * parcial `(action_type, resource_id) WHERE status IN ('pending','confirmed')`
 * (migración 021) rechaza el INSERT, se relee y se devuelve la vigente en lugar
 * de fallar. Funciona con y sin ese índice.
 */
export async function proponerAccion(
  actor: User | 'system',
  input: PropuestaInput,
): Promise<Result<ProposedAction>> {
  const spec = specDeAccion(input.type);
  const handler = handlerDe(input.type);
  if (spec === undefined || handler === undefined) {
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

  // Un id mal formado nunca es un recurso (y no debe llegar al motor como un 22P02).
  if (!UUID.test(input.resourceId)) return err(NO_ENCONTRADO);

  const preparada = await handler.prepararPropuesta(getPool(), actor, input.resourceId, input.parametros);
  if (!preparada.ok) return preparada;
  // El recurso es de otra campaña que la del alcance pedido: no se revela que existe.
  if (input.campaignId !== undefined && preparada.value.campaignId !== input.campaignId) {
    return err(NO_ENCONTRADO);
  }
  const { organizationId, campaignId, payload } = preparada.value;

  const payloadHash = huellaDeAccion(input.type, spec.resourceType, input.resourceId, payload);
  const ttl = Math.max(1, Math.floor(input.ttlSegundos ?? TTL_POR_DEFECTO_SEGUNDOS));

  const intentar = () =>
    transaction(async (client): Promise<Result<ProposedAction>> => {
      // Serializa las propuestas del mismo (tipo, recurso): sin esto, dos
      // transacciones que no ven ninguna abierta insertan ambas.
      await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [
        `proposed_action:${input.type}:${input.resourceId}`,
      ]);

      // Abiertas del mismo recurso (también las de plazo vencido: ocuparían el
      // índice único parcial). Una idéntica y vigente se reutiliza; el resto vence.
      const { rows: abiertas } = await client.query<Fila>(
        `SELECT ${COLUMNAS} FROM proposed_actions
          WHERE action_type = $1 AND resource_id = $2 AND status IN ('pending', 'confirmed')
          FOR UPDATE`,
        [input.type, input.resourceId],
      );
      for (const abierta of abiertas) {
        if (abierta.payload_hash === payloadHash && abierta.expires_at.getTime() > Date.now()) {
          return ok(comoAccion(abierta));
        }
        await registrarVencimiento(client, abierta);
      }

      const { rows } = await client.query<Fila>(
        `INSERT INTO proposed_actions
           (organization_id, campaign_id, action_type, resource_type, resource_id, payload, payload_hash,
            proposed_by, proposed_origin, correlation, assigned_to, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, now() + make_interval(secs => $12))
         RETURNING ${COLUMNAS}`,
        [
          organizationId,
          campaignId,
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
        organizationId,
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

  for (let intento = 1; ; intento += 1) {
    try {
      return await intentar();
    } catch (error) {
      // El índice único parcial vio otra propuesta abierta concurrente: se relee
      // (la otra ya confirmó su transacción) y se devuelve la vigente.
      if (!esViolacionUnica(error)) throw error;
      if (intento >= INTENTOS_DE_PROPUESTA) {
        return err({
          code: 'RESOURCE_CONFLICT',
          message: 'Otra propuesta para este recurso se está registrando. Reintente.',
          details: { reason: 'proposal_in_progress' },
        });
      }
    }
  }
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

/**
 * Comprueba que lo propuesto no cambió: el payload guardado sigue coincidiendo
 * con su huella y el handler del tipo confirma que el recurso es el mismo.
 */
async function verificarContenidoVigente(
  client: pg.PoolClient,
  fila: Fila,
  fase: 'confirmar' | 'ejecutar',
): Promise<Result<true>> {
  const recalculada = huellaDeAccion(fila.action_type, fila.resource_type, fila.resource_id, fila.payload);
  if (recalculada !== fila.payload_hash) {
    return err({
      code: 'PROPOSAL_STALE',
      message: 'El contenido de la acción propuesta no coincide con su huella.',
    });
  }
  const handler = handlerDe(fila.action_type);
  if (handler === undefined) return err(NO_ENCONTRADO);
  return handler.verificarVigente(client, fila, fase);
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
    const vigente = await verificarContenidoVigente(client, fila, 'confirmar');
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
 * La ejecución la hace el handler del tipo (`proposed-action-handlers.ts`), que
 * llama al caso de uso existente como la persona, con origen `ui` y correlación
 * a la acción. Garantía según el MODO del tipo:
 *
 *  · `atomic` (`brief.approve`): el cambio de dominio, la marca `executed` y la
 *    auditoría ocurren en UNA transacción. Si el caso de uso es rechazado (por
 *    ejemplo una guarda del dominio) la acción queda `confirmed` y se devuelve
 *    el error real; si algo falla a mitad de camino (error de base de datos),
 *    todo se revierte: nunca queda el dominio aplicado con la acción
 *    `confirmed`, ni `executed` sin dominio aplicado. Puede reintentarse.
 *
 *  · `idempotent_external` (`influencer_import.*`): el caso de uso usa sus
 *    propias transacciones, así que NO es atómico con la marca `executed`. La
 *    garantía es más débil (DEC-047): la ejecución única la da el bloqueo de fila
 *    mientras dura la llamada; si el caso de uso se aplicó y la marca falla, la
 *    acción queda `confirmed` y reintentar reconcilia sin duplicar.
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

    const vigente = await verificarContenidoVigente(client, fila, 'ejecutar');
    if (!vigente.ok) return vigente;

    const handler = handlerDe(fila.action_type);
    if (handler === undefined) return err(NO_ENCONTRADO);
    const resultado = await handler.ejecutar(client, humano, fila);
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
        mode: handler.modo,
        ...(resultado.value ?? {}),
      },
    });

    return ok(comoAccion(ejecutada));
  });
}

// ─────────────────────────── Cancelar, leer, vencer ────────────────────────────

/**
 * Cancela una acción pendiente o confirmada (quien la propuso, o quien puede
 * confirmarla). Cancelar solo reduce riesgo: lo puede pedir también el chat en
 * nombre de la persona (`contexto.origin = 'chat'`); sin contexto, `ui`.
 */
export async function cancelarAccion(
  actor: User,
  id: string,
  contexto?: ContextoDeAuditoria,
): Promise<Result<ProposedAction>> {
  const persona = exigirPersona(actor, contexto);
  if (!persona.ok) return persona;
  if (!UUID.test(id)) return err(NO_ENCONTRADO);

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
      origin: contexto?.origin ?? 'ui',
      correlation: { ...contexto?.correlation, proposedActionId: id },
      action: 'proposed_action.cancel',
      entityType: 'proposed_action',
      entityId: id,
      metadata: { type: fila.action_type, estadoAnterior: fila.status },
    });

    return ok(comoAccion(cancelada));
  });
}

/**
 * Lee una acción propuesta de la organización del actor. Lectura acotada:
 *
 *  · el actor debe estar activo y su ROL poder proponer o confirmar ESE tipo
 *    (cada handler/spec declara su capacidad); sin ella, el recurso no existe
 *    para él (`RESOURCE_NOT_FOUND`, no revela que existe);
 *  · el recurso es de SU organización; uno ajeno es `RESOURCE_NOT_FOUND`;
 *  · con `alcance.campaignId` (el chat pasa la de la conversación), una acción de
 *    otra campaña también es `RESOURCE_NOT_FOUND`.
 */
export async function obtenerAccionPropuesta(
  actor: User,
  id: string,
  alcance?: { readonly campaignId?: string | undefined },
): Promise<Result<ProposedAction>> {
  if (actor.status !== 'activo' || !UUID.test(id)) return err(NO_ENCONTRADO);
  const { rows } = await getPool().query<Fila>(
    `SELECT ${COLUMNAS} FROM proposed_actions WHERE id = $1 AND organization_id = $2`,
    [id, actor.organizationId],
  );
  const fila = rows[0];
  if (fila === undefined) return err(NO_ENCONTRADO);
  const spec = specDeAccion(fila.action_type);
  if (spec === undefined || handlerDe(fila.action_type) === undefined) return err(NO_ENCONTRADO);
  if (!rolPuedeProponer(actor.role, spec) && !rolPuedeConfirmar(actor.role, spec)) {
    return err(NO_ENCONTRADO);
  }
  if (alcance?.campaignId !== undefined && fila.campaign_id !== alcance.campaignId) {
    return err(NO_ENCONTRADO);
  }
  return ok(comoAccion(fila));
}

/** Nombre explícito de la lectura acotada para quien llama «como actor» (el adaptador del chat). */
export const obtenerAccionPropuestaComoActor = obtenerAccionPropuesta;

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
