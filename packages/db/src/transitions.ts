/**
 * Conecta `transition()` del dominio con la base (Sprint 4, cierre §3.4).
 *
 * Antes de este incremento, `packages/domain/src/brief-states.ts` tenía 12
 * estados, ~25 transiciones y 4 guardas completamente probadas — y ningún
 * archivo de `packages/db` ni `apps/web` la importaba. Un `brief_version`
 * nacía en `draft` y ahí se quedaba: nada en el sistema podía moverlo.
 *
 * Esta es la única función que cambia `brief_versions.status`. Nunca se hace
 * con un `UPDATE` directo en otro archivo — así toda transición pasa
 * siempre por las mismas guardas, sin excepción y sin reimplementarlas.
 */

import {
  type Action,
  type Actor,
  type BriefStatus,
  type Result,
  canAccessResource,
  err,
  ok,
  transition,
} from '@tcl-kol-os/domain';
import { assertCapability } from './authz.ts';
import { recordAudit } from './audit.ts';
import { getPool, transaction } from './client.ts';
import { cargarVersion } from './brief-version.ts';

async function contextoDeGuardas(
  ejecutor: Parameters<typeof cargarVersion>[0],
  versionId: string,
): Promise<{
  pendingCriticalQuestions: number;
  pendingQuestionsTotal: number;
  unresolvedCriticalFields: string[];
}> {
  const [criticas, total, sinResolver] = await Promise.all([
    ejecutor.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM local_questions
        WHERE brief_version_id = $1 AND criticidad = 'critico' AND status = 'pendiente'`,
      [versionId],
    ),
    ejecutor.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM local_questions
        WHERE brief_version_id = $1 AND status = 'pendiente'`,
      [versionId],
    ),
    ejecutor.query<{ key: string }>(
      `SELECT bf.key FROM brief_fields bf
        WHERE bf.brief_version_id = $1 AND bf.criticidad = 'critico' AND bf.status <> 'found'
          AND NOT EXISTS (
            SELECT 1 FROM local_questions lq
             WHERE lq.brief_version_id = bf.brief_version_id
               AND lq.key = bf.key
               AND lq.campaign_product_id IS NOT DISTINCT FROM bf.campaign_product_id
               AND lq.status = 'descartada'
          )
        ORDER BY bf.key`,
      [versionId],
    ),
  ]);

  return {
    pendingCriticalQuestions: Number(criticas.rows[0]?.n ?? 0),
    pendingQuestionsTotal: Number(total.rows[0]?.n ?? 0),
    unresolvedCriticalFields: sinResolver.rows.map((r) => r.key),
  };
}

/**
 * Qué `Action` exige cada destino, en vez del genérico `brief:transition`
 * (Sprint 5, Fase C/D). El rol `cliente` nunca tiene `brief:transition` —
 * solo `brief:request_client_changes`/`brief:register_client_decision` — así
 * que sin este mapa no podría ejecutar ninguna transición, y con un único
 * `brief:transition` para todos, alcanzaría cualquier destino que el dominio
 * (`ruleAllowsActor`) no bloqueara. Un destino que no aparece aquí sigue
 * exigiendo `brief:transition`, sin cambio de comportamiento.
 */
function accionParaDestino(to: BriefStatus): Action {
  switch (to) {
    case 'internal_changes_requested':
    case 'client_review':
      return 'brief:approve_internal';
    case 'client_changes_requested':
      return 'brief:request_client_changes';
    case 'approved':
      return 'brief:register_client_decision';
    default:
      return 'brief:transition';
  }
}

/**
 * Ejecuta una transición de estado, con las mismas reglas para un humano o
 * para el sistema (`actor: 'system'`, usado por `extraerBrief` alrededor de
 * la llamada al worker).
 *
 * Si el dominio rechaza la transición, el `message` de la guarda que falló
 * se devuelve tal cual — es el error accionable que exige la sección 7 del
 * pedido, nunca un "brief inválido" genérico (ADR-008: esta capa no
 * reinterpreta la razón, solo la transporta).
 *
 * `motivo` es obligatorio para `internal_changes_requested` y
 * `client_changes_requested` (Fase C/D del pedido: "motivo obligatorio") —
 * se valida aquí, antes de tocar el dominio, y queda en
 * `audit_events.metadata`, nunca en el contenido del brief (DEC-024).
 */
export async function transicionarBrief(
  actor: Actor,
  versionId: string,
  to: BriefStatus,
  opciones?: { motivo?: string | undefined; camposSenalados?: readonly string[] | undefined },
): Promise<Result<{ status: BriefStatus }>> {
  const motivoObligatorio = to === 'internal_changes_requested' || to === 'client_changes_requested';
  const motivo = opciones?.motivo?.trim();
  if (motivoObligatorio && (motivo === undefined || motivo === '')) {
    return err({
      code: 'BRIEF_FIELD_INVALID',
      message: 'Solicitar cambios exige un motivo.',
    });
  }

  if (actor !== 'system') {
    const permitido = assertCapability(actor, accionParaDestino(to));
    if (!permitido.ok) return err({ code: permitido.error.code, message: permitido.error.message });
  }

  const datos = await cargarVersion(getPool(), versionId);
  if (!datos) {
    return err({ code: 'RESOURCE_NOT_FOUND', message: 'El recurso no existe o no está disponible.' });
  }

  if (actor !== 'system') {
    // Un `cliente` es de OTRA organización por definición (DEC-012) — el
    // simple `organizationId === organizationId` que basta para el resto de
    // roles lo bloquearía siempre. `canAccessResource` ya resuelve esto para
    // `campaign:read` (`packages/db/src/campaigns.ts`); aquí se aplica el
    // mismo criterio de visibilidad de la campaña sobre su brief.
    const campana = await getPool().query<{
      organization_id: string;
      confidentiality_level: string;
      visibility: string;
    }>(`SELECT organization_id, confidentiality_level, visibility FROM campaigns WHERE id = $1`, [
      datos.campaignId,
    ]);
    const filaCampana = campana.rows[0];
    if (
      !filaCampana ||
      !canAccessResource(actor, {
        organizationId: filaCampana.organization_id,
        confidentialityLevel: filaCampana.confidentiality_level as
          'publica' | 'interna' | 'confidencial' | 'sensible',
        visibility: filaCampana.visibility as 'interna' | 'tcl' | 'compartida',
        createdBy: '',
      })
    ) {
      return err({ code: 'RESOURCE_NOT_FOUND', message: 'El recurso no existe o no está disponible.' });
    }
  }

  const contexto = await contextoDeGuardas(getPool(), versionId);
  const from = datos.version.status;

  const resultado = transition(
    {
      version: datos.version,
      actor,
      pendingCriticalQuestions: contexto.pendingCriticalQuestions,
      pendingQuestionsTotal: contexto.pendingQuestionsTotal,
      unresolvedCriticalFields: contexto.unresolvedCriticalFields,
    },
    to,
  );

  if (!resultado.ok) {
    return err({
      code: resultado.error.code,
      message: resultado.error.message,
      details: resultado.error.details,
    });
  }

  await transaction(async (client) => {
    if (to === 'client_review') {
      // ADR-004: la vista de TCL es "visible únicamente a partir del envío".
      // Sin esto, `visibility` se queda en su default `interna` para
      // siempre — ninguna campaña llegaría nunca a ser visible para el rol
      // `cliente`, aunque el brief ya esté en revisión del cliente. Solo
      // sube el nivel (interna → tcl); nunca lo baja ni toca una campaña ya
      // `compartida`.
      await client.query(`UPDATE campaigns SET visibility = 'tcl' WHERE id = $1 AND visibility = 'interna'`, [
        datos.campaignId,
      ]);
    }

    if (to === 'approved') {
      await client.query(
        `UPDATE brief_versions SET status = $1::brief_status, approved_at = now() WHERE id = $2`,
        [to, versionId],
      );
    } else {
      await client.query(`UPDATE brief_versions SET status = $1::brief_status WHERE id = $2`, [
        to,
        versionId,
      ]);
    }

    await recordAudit(client, {
      actor,
      organizationId: datos.organizationId,
      action: 'brief.transition',
      entityType: 'brief_version',
      entityId: versionId,
      metadata: {
        from,
        to,
        ...(motivo !== undefined && motivo !== '' ? { motivo } : {}),
        ...(opciones?.camposSenalados && opciones.camposSenalados.length > 0
          ? { camposSenalados: opciones.camposSenalados }
          : {}),
      },
    });
  });

  return ok({ status: to });
}

export interface MotivoDevolucion {
  readonly to: BriefStatus;
  readonly motivo: string;
  readonly camposSenalados: readonly string[];
  readonly actorName: string | null;
  readonly createdAt: string;
}

/**
 * El motivo más reciente de una devolución (`internal_changes_requested` o
 * `client_changes_requested`) sobre esta versión — "mostrar el motivo en el
 * editor" (Fase C) y en la vista del cliente (Fase D). `undefined` si la
 * versión nunca fue devuelta. Se lee de `audit_events`, nunca de una tabla de
 * contenido del brief (DEC-024).
 */
export async function motivoDeUltimaDevolucion(versionId: string): Promise<MotivoDevolucion | undefined> {
  const { rows } = await getPool().query<{
    metadata: { to: BriefStatus; motivo?: string; camposSenalados?: string[] };
    actor_name: string | null;
    created_at: Date;
  }>(
    `SELECT a.metadata, u.name AS actor_name, a.created_at
       FROM audit_events a
       LEFT JOIN users u ON u.id = a.actor_id
      WHERE a.entity_type = 'brief_version' AND a.entity_id = $1
        AND a.action = 'brief.transition'
        AND a.metadata->>'to' IN ('internal_changes_requested', 'client_changes_requested')
      ORDER BY a.created_at DESC
      LIMIT 1`,
    [versionId],
  );
  const fila = rows[0];
  if (!fila || fila.metadata.motivo === undefined) return undefined;

  return {
    to: fila.metadata.to,
    motivo: fila.metadata.motivo,
    camposSenalados: fila.metadata.camposSenalados ?? [],
    actorName: fila.actor_name,
    createdAt: fila.created_at.toISOString(),
  };
}
