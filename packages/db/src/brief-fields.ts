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

import { type Result, type User, assertEditable, err, ok } from '@tcl-kol-os/domain';
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

  return ok({ id: campo.id, versionId, organizationId: datos.organizationId, key: campo.key, value: campo.value });
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
