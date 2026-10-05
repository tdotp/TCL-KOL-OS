/**
 * Piezas compartidas por las definiciones del catálogo.
 */

import type { ObjectSchema, StringSchema } from '../schema.ts';
import type { AnyToolDefinition, ToolDefinition } from '../types.ts';

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
