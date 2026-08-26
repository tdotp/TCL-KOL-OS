/**
 * Confirmar, corregir y resolver conflictos de un campo del brief (§3.1).
 *
 * La pantalla de extracción prometía esta acción sin que existiera —
 * `BotonExtraer.tsx` decía "lo que salga de aquí queda en borrador para que
 * usted lo confirme" y no había ningún botón detrás. Este módulo es esa
 * acción real, con dos reglas que no se negocian:
 *
 *   - confirmar NUNCA cambia `provenance_type`: la procedencia extraída no
 *     se sobrescribe en silencio, solo se marca como revisada.
 *   - todo cambio pasa por control de concurrencia optimista (corrección 7
 *     del cierre): si otra persona ya modificó el campo, se rechaza con un
 *     error accionable en vez de aplicar "el último que escribe gana".
 */

import { type Result, type User, assertEditable, campoDelCatalogo, err, ok } from '@tcl-kol-os/domain';
import { assertCapability } from './authz.ts';
import { recordAudit } from './audit.ts';
import { getPool, transaction } from './client.ts';
import { cargarVersion } from './brief-version.ts';

interface CampoObjetivo {
  readonly id: string;
  readonly versionId: string;
  readonly organizationId: string;
  readonly key: string;
  readonly value: unknown;
}

async function cargarCampoAutorizado(
  actor: User,
  versionId: string,
  fieldId: string,
): Promise<Result<CampoObjetivo>> {
  const datos = await cargarVersion(getPool(), versionId);
  if (!datos || datos.organizationId !== actor.organizationId) {
    return err({ code: 'RESOURCE_NOT_FOUND', message: 'El recurso no existe o no está disponible.' });
  }

  const editable = assertEditable(datos.version);
  if (!editable.ok) return err({ code: editable.error.code, message: editable.error.message });

  const campo = datos.version.fields.find((f) => f.id === fieldId);
  if (!campo) {
    return err({ code: 'RESOURCE_NOT_FOUND', message: 'El recurso no existe o no está disponible.' });
  }

  return ok({
    id: campo.id,
    versionId,
    organizationId: datos.organizationId,
    key: campo.key,
    value: campo.value,
  });
}

export async function confirmarCampo(
  actor: User,
  versionId: string,
  fieldId: string,
  opciones: { revisionEsperada: number },
): Promise<Result<{ revision: number }>> {
  const permitido = assertCapability(actor, 'field:confirm');
  if (!permitido.ok) return err({ code: permitido.error.code, message: permitido.error.message });

  const campo = await cargarCampoAutorizado(actor, versionId, fieldId);
  if (!campo.ok) return campo;

  return transaction(async (client) => {
    const actualizado = await client.query<{ revision: number }>(
      `UPDATE brief_fields
          SET review_status = 'confirmed', reviewed_by = $1, reviewed_at = now()
        WHERE id = $2 AND revision = $3
        RETURNING revision`,
      [actor.id, fieldId, opciones.revisionEsperada],
    );
    if (actualizado.rowCount === 0) {
      return err({
        code: 'FIELD_REVISION_CONFLICT',
        message: 'Alguien más modificó este campo. Recargue para ver el valor actual.',
      });
    }

    await client.query(
      `INSERT INTO brief_field_revisions (brief_field_id, brief_version_id, accion, valor_anterior, valor_nuevo, actor_id)
       VALUES ($1, $2, 'confirm', $3::jsonb, $3::jsonb, $4)`,
      [fieldId, versionId, campo.value.value === null ? null : JSON.stringify(campo.value.value), actor.id],
    );
    await recordAudit(client, {
      actor,
      action: 'field.confirm',
      entityType: 'brief_field',
      entityId: fieldId,
      metadata: { key: campo.value.key },
    });

    return ok({ revision: actualizado.rows[0]!.revision });
  });
}

export async function corregirCampo(
  actor: User,
  versionId: string,
  fieldId: string,
  opciones: { value: unknown; motivo?: string | undefined; revisionEsperada: number },
): Promise<Result<{ revision: number }>> {
  const permitido = assertCapability(actor, 'field:correct');
  if (!permitido.ok) return err({ code: permitido.error.code, message: permitido.error.message });

  const campo = await cargarCampoAutorizado(actor, versionId, fieldId);
  if (!campo.ok) return campo;

  return transaction(async (client) => {
    const actualizado = await client.query<{ revision: number }>(
      `UPDATE brief_fields
          SET value = $1::jsonb, status = 'found', provenance_type = 'manual_local',
              review_status = 'corrected', reviewed_by = $2, reviewed_at = now()
        WHERE id = $3 AND revision = $4
        RETURNING revision`,
      [JSON.stringify(opciones.value), actor.id, fieldId, opciones.revisionEsperada],
    );
    if (actualizado.rowCount === 0) {
      return err({
        code: 'FIELD_REVISION_CONFLICT',
        message: 'Alguien más modificó este campo. Recargue para ver el valor actual.',
      });
    }

    await client.query(
      `INSERT INTO brief_field_revisions
              (brief_field_id, brief_version_id, accion, valor_anterior, valor_nuevo, motivo, actor_id)
       VALUES ($1, $2, 'correct', $3::jsonb, $4::jsonb, $5, $6)`,
      [
        fieldId,
        versionId,
        campo.value.value === null ? null : JSON.stringify(campo.value.value),
        JSON.stringify(opciones.value),
        opciones.motivo ?? null,
        actor.id,
      ],
    );
    await recordAudit(client, {
      actor,
      action: 'field.correct',
      entityType: 'brief_field',
      entityId: fieldId,
      metadata: { key: campo.value.key, motivo: opciones.motivo },
    });

    return ok({ revision: actualizado.rows[0]!.revision });
  });
}

/**
 * E7-8 · Declara una excepción por producto sobre un campo
 * `compartido_con_excepcion` (DEC-016): crea (o corrige, si ya existía) una
 * fila anclada a `campaignProductId`, distinta de la fila compartida
 * (`campaign_product_id IS NULL`) — editar el compartido sigue afectando a
 * todos los productos que no tengan su propia excepción; declarar una acá
 * desengancha solo ese producto. Exige motivo: es la única acción de campo
 * que crea contenido nuevo en vez de corregir lo que ya había, y el porqué
 * de esa divergencia debe quedar dicho, no implícito.
 */
export async function declararExcepcionProducto(
  actor: User,
  versionId: string,
  opciones: {
    key: string;
    campaignProductId: string;
    value: unknown;
    motivo: string;
    revisionEsperada?: number | undefined;
  },
): Promise<Result<{ fieldId: string; revision: number }>> {
  const permitido = assertCapability(actor, 'field:declare_exception');
  if (!permitido.ok) return err({ code: permitido.error.code, message: permitido.error.message });

  if (opciones.motivo.trim() === '') {
    return err({
      code: 'BRIEF_FIELD_INVALID',
      message: 'Declarar una excepción por producto exige un motivo.',
    });
  }

  const catalogo = campoDelCatalogo(opciones.key);
  if (!catalogo || catalogo.nivel !== 'compartido_con_excepcion') {
    return err({
      code: 'BRIEF_FIELD_INVALID',
      message: `«${opciones.key}» no es un campo compartido con excepción por producto.`,
    });
  }

  const datos = await cargarVersion(getPool(), versionId);
  if (!datos || datos.organizationId !== actor.organizationId) {
    return err({ code: 'RESOURCE_NOT_FOUND', message: 'El recurso no existe o no está disponible.' });
  }
  const editable = assertEditable(datos.version);
  if (!editable.ok) return err({ code: editable.error.code, message: editable.error.message });

  const compartido = datos.version.fields.find(
    (f) => f.key === opciones.key && f.campaignProductId === undefined,
  );
  if (!compartido) {
    return err({ code: 'RESOURCE_NOT_FOUND', message: 'El campo compartido no existe en esta versión.' });
  }

  return transaction(async (client) => {
    // Defensa en profundidad — el trigger de la migración 005 igual lo exige.
    const producto = await client.query(
      `SELECT id FROM campaign_products WHERE id = $1 AND campaign_id = $2`,
      [opciones.campaignProductId, datos.campaignId],
    );
    if (producto.rowCount === 0) {
      return err({ code: 'BRIEF_FIELD_INVALID', message: 'Ese producto no pertenece a esta campaña.' });
    }

    const existente = await client.query<{ id: string; revision: number; value: unknown }>(
      `SELECT id, revision, value FROM brief_fields
        WHERE brief_version_id = $1 AND key = $2 AND campaign_product_id = $3`,
      [versionId, opciones.key, opciones.campaignProductId],
    );

    let fieldId: string;
    let revision: number;
    const valorAnterior = existente.rows[0]?.value ?? null;

    if (existente.rows[0]) {
      if (
        opciones.revisionEsperada !== undefined &&
        existente.rows[0].revision !== opciones.revisionEsperada
      ) {
        return err({
          code: 'FIELD_REVISION_CONFLICT',
          message: 'Alguien más modificó esta excepción. Recargue para ver el valor actual.',
        });
      }
      const actualizado = await client.query<{ revision: number }>(
        `UPDATE brief_fields
            SET value = $1::jsonb, status = 'found', provenance_type = 'manual_local',
                review_status = 'corrected', reviewed_by = $2, reviewed_at = now()
          WHERE id = $3
          RETURNING revision`,
        [JSON.stringify(opciones.value), actor.id, existente.rows[0].id],
      );
      fieldId = existente.rows[0].id;
      revision = actualizado.rows[0]!.revision;
    } else {
      const insertado = await client.query<{ id: string; revision: number }>(
        `INSERT INTO brief_fields
           (brief_version_id, campaign_product_id, key, value, status, provenance_type, criticidad,
            review_status, reviewed_by, reviewed_at)
         VALUES ($1, $2, $3, $4::jsonb, 'found', 'manual_local', $5, 'corrected', $6, now())
         RETURNING id, revision`,
        [
          versionId,
          opciones.campaignProductId,
          opciones.key,
          JSON.stringify(opciones.value),
          compartido.criticidad,
          actor.id,
        ],
      );
      fieldId = insertado.rows[0]!.id;
      revision = insertado.rows[0]!.revision;
    }

    await client.query(
      `INSERT INTO brief_field_revisions
              (brief_field_id, brief_version_id, accion, valor_anterior, valor_nuevo, motivo, actor_id)
       VALUES ($1, $2, 'declare_exception', $3::jsonb, $4::jsonb, $5, $6)`,
      [
        fieldId,
        versionId,
        valorAnterior === null ? null : JSON.stringify(valorAnterior),
        JSON.stringify(opciones.value),
        opciones.motivo,
        actor.id,
      ],
    );
    await recordAudit(client, {
      actor,
      action: 'field.declare_exception',
      entityType: 'brief_field',
      entityId: fieldId,
      metadata: { key: opciones.key, campaignProductId: opciones.campaignProductId },
    });

    return ok({ fieldId, revision });
  });
}

/**
 * E7-8 · Revierte una excepción: borra la fila anclada al producto y el
 * campo vuelve a mostrar el valor compartido. No se registra en
 * `brief_field_revisions` — esa tabla es el historial de una fila, y la fila
 * deja de existir (`ON DELETE CASCADE` se lo llevaría de todas formas); el
 * rastro de que alguien revirtió queda en `audit_events`, que no depende de
 * que el campo siga existiendo.
 */
export async function revertirExcepcionProducto(
  actor: User,
  versionId: string,
  fieldId: string,
): Promise<Result<{ revertido: true }>> {
  const permitido = assertCapability(actor, 'field:declare_exception');
  if (!permitido.ok) return err({ code: permitido.error.code, message: permitido.error.message });

  const datos = await cargarVersion(getPool(), versionId);
  if (!datos || datos.organizationId !== actor.organizationId) {
    return err({ code: 'RESOURCE_NOT_FOUND', message: 'El recurso no existe o no está disponible.' });
  }
  const editable = assertEditable(datos.version);
  if (!editable.ok) return err({ code: editable.error.code, message: editable.error.message });

  const campo = datos.version.fields.find((f) => f.id === fieldId);
  if (!campo || campo.campaignProductId === undefined) {
    return err({ code: 'RESOURCE_NOT_FOUND', message: 'La excepción no existe en esta versión.' });
  }

  return transaction(async (client) => {
    await client.query(`DELETE FROM brief_fields WHERE id = $1`, [fieldId]);
    await recordAudit(client, {
      actor,
      action: 'field.revert_exception',
      entityType: 'brief_field',
      entityId: fieldId,
      metadata: { key: campo.key, campaignProductId: campo.campaignProductId },
    });
    return ok({ revertido: true as const });
  });
}

export async function resolverConflicto(
  actor: User,
  versionId: string,
  fieldId: string,
  opciones: { value: unknown; keepEvidenceIds: readonly string[]; revisionEsperada: number },
): Promise<Result<{ revision: number }>> {
  const permitido = assertCapability(actor, 'field:correct');
  if (!permitido.ok) return err({ code: permitido.error.code, message: permitido.error.message });

  const campo = await cargarCampoAutorizado(actor, versionId, fieldId);
  if (!campo.ok) return campo;

  return transaction(async (client) => {
    const actualizado = await client.query<{ revision: number }>(
      `UPDATE brief_fields
          SET value = $1::jsonb, status = 'found', provenance_type = 'manual_local',
              review_status = 'corrected', reviewed_by = $2, reviewed_at = now()
        WHERE id = $3 AND revision = $4
        RETURNING revision`,
      [JSON.stringify(opciones.value), actor.id, fieldId, opciones.revisionEsperada],
    );
    if (actualizado.rowCount === 0) {
      return err({
        code: 'FIELD_REVISION_CONFLICT',
        message: 'Alguien más modificó este campo. Recargue para ver el valor actual.',
      });
    }

    if (opciones.keepEvidenceIds.length > 0) {
      await client.query(`DELETE FROM evidence WHERE brief_field_id = $1 AND id <> ALL($2)`, [
        fieldId,
        opciones.keepEvidenceIds,
      ]);
    }

    await client.query(
      `INSERT INTO brief_field_revisions
              (brief_field_id, brief_version_id, accion, valor_anterior, valor_nuevo, actor_id)
       VALUES ($1, $2, 'resolve_conflict', $3::jsonb, $4::jsonb, $5)`,
      [
        fieldId,
        versionId,
        campo.value.value === null ? null : JSON.stringify(campo.value.value),
        JSON.stringify(opciones.value),
        actor.id,
      ],
    );
    await recordAudit(client, {
      actor,
      action: 'field.resolve_conflict',
      entityType: 'brief_field',
      entityId: fieldId,
      metadata: { key: campo.value.key },
    });

    return ok({ revision: actualizado.rows[0]!.revision });
  });
}
