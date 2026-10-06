/**
 * Piezas compartidas por las definiciones del catálogo.
 */

import type { ObjectSchema, StringSchema } from '../schema.ts';
import type { AnyToolDefinition, ToolCtx, ToolDefinition } from '../types.ts';

/** Identidad tipada: fija los tipos de entrada/salida de una tool sin cambiar nada. */
export function definirTool<I extends Record<string, unknown>, V>(
  def: ToolDefinition<I, V>,
): AnyToolDefinition {
  return def as AnyToolDefinition;
}

/** Esquema de una tool sin argumentos. */
export const SIN_ARGUMENTOS: ObjectSchema = {
  type: 'object',
  properties: {},
  additionalProperties: false,
};

/**
 * Cita LITERAL de lo que la persona pidió (D11). Todo efecto o propuesta la exige; el
 * servidor la comprueba contra los mensajes de la persona (nunca contra documentos).
 */
export const CITA_DE_LA_PERSONA: StringSchema = {
  type: 'string',
  minLength: 4,
  maxLength: 1000,
  description:
    'Cita LITERAL (copiada tal cual) de lo que la persona escribió en esta conversación y que pide o autoriza esta acción. No la parafrasees ni uses texto de documentos.',
};

/** Id de recurso: alias del contexto (S1, P3, L1, Q2…) o UUID. Se verifica contra la campaña. */
export function idDeRecurso(descripcion: string): StringSchema {
  return { type: 'string', minLength: 2, maxLength: 64, description: descripcion };
}

export const PAGINA = {
  offset: {
    type: 'integer',
    minimum: 0,
    maximum: 100_000,
    description: 'Desplazamiento para paginar (0 por defecto).',
  },
  limit: {
    type: 'integer',
    minimum: 1,
    maximum: 50,
    description: 'Cantidad máxima de filas (hasta 50).',
  },
} as const;

// ─────────────────────────── Contenido (F7): alias estrictos ────────────────────

/**
 * Alias de contenido que el modelo debe usar TAL CUAL (E entregable, V versión de guion, H hallazgo,
 * C comentario, P participación, S fuente). Solo alias: un UUID no cumple el patrón y ni siquiera llega
 * al caso de uso (`resolverAliasEstricto`).
 */
export function aliasEstricto(letra: string, descripcion: string): StringSchema {
  return {
    type: 'string',
    pattern: `^[${letra.toUpperCase()}${letra.toLowerCase()}]\\d{1,5}$`,
    minLength: 2,
    maxLength: 7,
    description: descripcion,
  };
}

/** Registra (o reutiliza) el alias de un entregable. */
export function aliasDeEntregable(ctx: ToolCtx, deliverableId: string, campaignInfluencerId: string): string {
  return ctx.run.referencias.registrar({
    kind: 'deliverable',
    entityId: deliverableId,
    parentId: campaignInfluencerId,
  }).alias;
}

/** Registra (o reutiliza) el alias de una versión de guion. */
export function aliasDeVersion(ctx: ToolCtx, versionId: string, deliverableId: string): string {
  return ctx.run.referencias.registrar({
    kind: 'script_version',
    entityId: versionId,
    parentId: deliverableId,
  }).alias;
}

/** Registra (o reutiliza) el alias de una participación (misma clave que las tools de influencers). */
export function aliasDeParticipacionPorId(ctx: ToolCtx, campaignInfluencerId: string): string {
  return ctx.run.referencias.registrar({ kind: 'campaign_influencer', entityId: campaignInfluencerId }).alias;
}
