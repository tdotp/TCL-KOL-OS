/**
 * Comentarios internos por campo (E7-6, Sprint 5 Fase B).
 *
 * Diferidos desde el cierre de Sprint 4 (D0-17 §2.4). El rol `cliente` no
 * tiene `comment:internal` en `packages/domain/src/permissions.ts` — toda
 * función de este módulo lo exige antes de tocar `field_comments`, así que
 * un intento del cliente falla en la capa de autorización, nunca por
 * casualidad de qué le muestra la interfaz.
 */

import { type Result, type User, assertEditable, err, ok } from '@tcl-kol-os/domain';
import { assertCapability } from './authz.ts';
import { recordAudit } from './audit.ts';
import { getPool, transaction } from './client.ts';
import { cargarVersion } from './brief-version.ts';

export interface ComentarioDeCampo {
  readonly id: string;
  readonly briefVersionId: string;
  readonly fieldKey: string;
  readonly campaignProductId: string | undefined;
  readonly parentCommentId: string | undefined;
  readonly authorId: string;
  readonly authorName: string;
  readonly content: string;
  readonly status: 'abierto' | 'resuelto';
  readonly resolvedBy: string | undefined;
  readonly resolvedByName: string | undefined;
  readonly resolvedAt: string | undefined;
  readonly createdAt: string;
}

interface FilaComentario {
  id: string;
  brief_version_id: string;
  field_key: string;
  campaign_product_id: string | null;
  parent_comment_id: string | null;
  author_id: string;
  author_name: string;
  content: string;
  status: 'abierto' | 'resuelto';
  resolved_by: string | null;
  resolved_by_name: string | null;
  resolved_at: Date | null;
  created_at: Date;
}

function aDominio(f: FilaComentario): ComentarioDeCampo {
  return {
    id: f.id,
    briefVersionId: f.brief_version_id,
    fieldKey: f.field_key,
    campaignProductId: f.campaign_product_id ?? undefined,
    parentCommentId: f.parent_comment_id ?? undefined,
    authorId: f.author_id,
    authorName: f.author_name,
    content: f.content,
    status: f.status,
    resolvedBy: f.resolved_by ?? undefined,
    resolvedByName: f.resolved_by_name ?? undefined,
    resolvedAt: f.resolved_at?.toISOString(),
    createdAt: f.created_at.toISOString(),
  };
}

async function cargarVersionAutorizada(
  actor: User,
  versionId: string,
): Promise<Result<{ organizationId: string }>> {
  const datos = await cargarVersion(getPool(), versionId);
  if (!datos || datos.organizationId !== actor.organizationId) {
    return err({ code: 'RESOURCE_NOT_FOUND', message: 'El recurso no existe o no está disponible.' });
  }
  return ok({ organizationId: datos.organizationId });
}

/**
 * Toda la conversación de un campo, en orden cronológico — respuestas
 * incluidas, aplanadas (el llamador las agrupa por `parentCommentId` si
 * quiere anidarlas visualmente).
 */
export async function listarComentarios(
  actor: User,
  versionId: string,
  fieldKey: string,
): Promise<Result<readonly ComentarioDeCampo[]>> {
  const permitido = assertCapability(actor, 'comment:internal');
  if (!permitido.ok) return err({ code: permitido.error.code, message: permitido.error.message });

  const version = await cargarVersionAutorizada(actor, versionId);
  if (!version.ok) return version;

  const { rows } = await getPool().query<FilaComentario>(
    `SELECT c.id, c.brief_version_id, c.field_key, c.campaign_product_id, c.parent_comment_id,
            c.author_id, u.name AS author_name, c.content, c.status,
            c.resolved_by, ru.name AS resolved_by_name, c.resolved_at, c.created_at
       FROM field_comments c
       JOIN users u ON u.id = c.author_id
       LEFT JOIN users ru ON ru.id = c.resolved_by
      WHERE c.brief_version_id = $1 AND c.field_key = $2
      ORDER BY c.created_at ASC`,
    [versionId, fieldKey],
  );
  return ok(rows.map(aDominio));
}

/**
 * Todos los comentarios de una versión, de cualquier campo — Sprint 6,
 * Checkpoint 2 (modo "Actividad"). Misma guarda que `listarComentarios`
 * (`comment:internal`, nunca el rol `cliente`); solo cambia el filtro de
 * `field_key` a la versión completa.
 */
export async function listarComentariosDeVersion(
  actor: User,
  versionId: string,
): Promise<Result<readonly ComentarioDeCampo[]>> {
  const permitido = assertCapability(actor, 'comment:internal');
  if (!permitido.ok) return err({ code: permitido.error.code, message: permitido.error.message });

  const version = await cargarVersionAutorizada(actor, versionId);
  if (!version.ok) return version;

  const { rows } = await getPool().query<FilaComentario>(
    `SELECT c.id, c.brief_version_id, c.field_key, c.campaign_product_id, c.parent_comment_id,
            c.author_id, u.name AS author_name, c.content, c.status,
            c.resolved_by, ru.name AS resolved_by_name, c.resolved_at, c.created_at
       FROM field_comments c
       JOIN users u ON u.id = c.author_id
       LEFT JOIN users ru ON ru.id = c.resolved_by
      WHERE c.brief_version_id = $1
      ORDER BY c.created_at DESC`,
    [versionId],
  );
  return ok(rows.map(aDominio));
}

/** Cuántas conversaciones (hilos raíz) siguen abiertas en toda la versión — para el contador del editor. */
export async function contarConversacionesAbiertas(
  actor: User,
  versionId: string,
): Promise<Result<Record<string, number>>> {
  const permitido = assertCapability(actor, 'comment:internal');
  if (!permitido.ok) return err({ code: permitido.error.code, message: permitido.error.message });

  const version = await cargarVersionAutorizada(actor, versionId);
  if (!version.ok) return version;

  const { rows } = await getPool().query<{ field_key: string; n: string }>(
    `SELECT field_key, count(*)::text AS n
       FROM field_comments
      WHERE brief_version_id = $1 AND parent_comment_id IS NULL AND status = 'abierto'
      GROUP BY field_key`,
    [versionId],
  );
  const porCampo: Record<string, number> = {};
  for (const r of rows) porCampo[r.field_key] = Number(r.n);
  return ok(porCampo);
}

export async function crearComentario(
  actor: User,
  versionId: string,
  opciones: {
    fieldKey: string;
    campaignProductId?: string | undefined;
    content: string;
    parentCommentId?: string | undefined;
  },
): Promise<Result<{ id: string }>> {
  const permitido = assertCapability(actor, 'comment:internal');
  if (!permitido.ok) return err({ code: permitido.error.code, message: permitido.error.message });

  if (opciones.content.trim() === '') {
    return err({ code: 'BRIEF_FIELD_INVALID', message: 'Un comentario no puede quedar vacío.' });
  }

  const datos = await cargarVersion(getPool(), versionId);
  if (!datos || datos.organizationId !== actor.organizationId) {
    return err({ code: 'RESOURCE_NOT_FOUND', message: 'El recurso no existe o no está disponible.' });
  }
  const editable = assertEditable(datos.version);
  if (!editable.ok) return err({ code: editable.error.code, message: editable.error.message });

  return transaction(async (client) => {
    if (opciones.parentCommentId !== undefined) {
      const padre = await client.query<{ field_key: string }>(
        `SELECT field_key FROM field_comments WHERE id = $1 AND brief_version_id = $2`,
        [opciones.parentCommentId, versionId],
      );
      if (!padre.rows[0] || padre.rows[0].field_key !== opciones.fieldKey) {
        return err({ code: 'RESOURCE_NOT_FOUND', message: 'El comentario al que responde no existe.' });
      }
    }

    const insertado = await client.query<{ id: string }>(
      `INSERT INTO field_comments
              (organization_id, brief_version_id, field_key, campaign_product_id, parent_comment_id, author_id, content)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id`,
      [
        datos.organizationId,
        versionId,
        opciones.fieldKey,
        opciones.campaignProductId ?? null,
        opciones.parentCommentId ?? null,
        actor.id,
        opciones.content.trim(),
      ],
    );
    const id = insertado.rows[0]!.id;

    await recordAudit(client, {
      actor,
      action: opciones.parentCommentId === undefined ? 'comment.create' : 'comment.reply',
      entityType: 'field_comment',
      entityId: id,
      metadata: { fieldKey: opciones.fieldKey },
    });

    return ok({ id });
  });
}

async function cambiarEstadoComentario(
  actor: User,
  versionId: string,
  commentId: string,
  aEstado: 'resuelto' | 'abierto',
): Promise<Result<true>> {
  const permitido = assertCapability(actor, 'comment:internal');
  if (!permitido.ok) return err({ code: permitido.error.code, message: permitido.error.message });

  const datos = await cargarVersion(getPool(), versionId);
  if (!datos || datos.organizationId !== actor.organizationId) {
    return err({ code: 'RESOURCE_NOT_FOUND', message: 'El recurso no existe o no está disponible.' });
  }
  const editable = assertEditable(datos.version);
  if (!editable.ok) return err({ code: editable.error.code, message: editable.error.message });

  return transaction(async (client) => {
    const actualizado =
      aEstado === 'resuelto'
        ? await client.query(
            `UPDATE field_comments
                SET status = 'resuelto', resolved_by = $1, resolved_at = now()
              WHERE id = $2 AND brief_version_id = $3
              RETURNING id`,
            [actor.id, commentId, versionId],
          )
        : await client.query(
            `UPDATE field_comments
                SET status = 'abierto', resolved_by = NULL, resolved_at = NULL
              WHERE id = $1 AND brief_version_id = $2
              RETURNING id`,
            [commentId, versionId],
          );

    if (actualizado.rowCount === 0) {
      return err({ code: 'RESOURCE_NOT_FOUND', message: 'El comentario no existe en esta versión.' });
    }

    await recordAudit(client, {
      actor,
      action: aEstado === 'resuelto' ? 'comment.resolve' : 'comment.reopen',
      entityType: 'field_comment',
      entityId: commentId,
      metadata: {},
    });

    return ok(true as const);
  });
}

export async function resolverComentario(
  actor: User,
  versionId: string,
  commentId: string,
): Promise<Result<true>> {
  return cambiarEstadoComentario(actor, versionId, commentId, 'resuelto');
}

export async function reabrirComentario(
  actor: User,
  versionId: string,
  commentId: string,
): Promise<Result<true>> {
  return cambiarEstadoComentario(actor, versionId, commentId, 'abierto');
}
