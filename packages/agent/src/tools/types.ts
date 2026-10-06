/**
 * Tipos internos del registro de tools (V2 · Fase 6).
 *
 * Una tool es un ADAPTADOR FINO sobre un caso de uso existente: valida su forma
 * (esquema cerrado), delega y proyecta la salida de forma acotada. No contiene
 * reglas de negocio, no toca SQL y no conoce el bucle del agente.
 */

import type { Action, Result, ToolRiskClass, User } from '@tcl-kol-os/domain';
import type { ToolRunContext } from '../contracts.ts';
import type { CampaignWithProducts, ContextoDeAuditoria } from './use-cases.ts';
import type { ObjectSchema } from './schema.ts';

/** Riesgo declarado de una tool REGISTRADA (`unregistered` solo lo asigna el executor). */
export type RiesgoDeTool = Exclude<ToolRiskClass, 'unregistered'>;

/**
 * Cuota por run. `perRun` = ejecuciones que llegaron al caso de uso (las rechazadas por
 * esquema, permiso o grounding no cuentan).
 */
export interface CuotaDeTool {
  readonly perRun: number;
  readonly why: string;
  /** Códigos de error con los que una ejecución FALLIDA sigue contando (consumió el recurso caro). */
  readonly countsFailedWith?: readonly string[];
}

/**
 * Qué argumentos del modelo deben aparecer LITERALMENTE en un mensaje de la persona
 * (D11). Nunca se contrasta contra el contenido de fuentes.
 */
export interface GroundingDeTool {
  /** Campo con la cita literal de lo que la persona pidió (`evidenceQuote`). */
  readonly quoteField?: string;
  /** Campo con una URL que debe aparecer idéntica en un mensaje de la persona. */
  readonly urlField?: string;
  /** Campos de texto que deben aparecer (normalizados) dentro de un mensaje de la persona. */
  readonly literalFields?: readonly { readonly field: string; readonly minChars?: number }[];
  /**
   * Campos `AAAA-MM-DD` que la persona debe haber escrito (en cualquier formato habitual:
   * `2027-03-01`, `1 de marzo de 2027`, `01/03/2027`…). Ver `fechaFundamentada`.
   */
  readonly dateFields?: readonly string[];
  /**
   * Grounding REFORZADO (F7): el campo debe ser una subcadena EXACTA (sin plegar mayúsculas ni
   * acentos) del texto del MENSAJE EN CURSO de la persona —no de uno anterior, no del asistente, no de
   * un documento—, con al menos `minChars` caracteres. Lo usan las tools que guardan palabras de la
   * persona como texto propio (`review_comment_add`, `script_request_changes`): la base lo vuelve a
   * imponer con el mensaje del run, así que ni un bug de aquí permite guardar texto redactado.
   */
  readonly currentMessageQuote?: { readonly field: string; readonly minChars: number };
}

/** Contexto que el executor entrega a una tool, ya verificado. */
export interface ToolCtx {
  /** Actor RELEÍDO de la BD en esta llamada (activo, misma organización que la campaña). */
  readonly actor: User;
  /** Campaña releída con el alcance del actor. */
  readonly campaign: CampaignWithProducts;
  readonly run: ToolRunContext;
  readonly invocationId: string;
  /** `origin: 'chat'` + correlación completa (incluye `toolInvocationId`). */
  readonly contexto: ContextoDeAuditoria;
  /** Nonce del run para los sobres de contenido no confiable. */
  readonly nonce: string;
}

/** Lo que una tool devuelve al modelo y lo que se guarda en la invocación. */
export interface Proyeccion {
  /** JSON acotado que vuelve al modelo (el executor lo serializa y vigila el tope). */
  readonly data: Readonly<Record<string, unknown>>;
  /** Resumen compacto para `agent_tool_invocations.result`: ids, conteos y referencias; nunca texto de documentos. */
  readonly stored: Readonly<Record<string, unknown>>;
  /** Propuesta HITL que dejó la tool. */
  readonly proposedActionId?: string;
}

export interface ToolDefinition<I extends Record<string, unknown> = Record<string, unknown>, V = unknown> {
  readonly name: string;
  readonly version: number;
  /** Etiqueta en español para la UI («Consultando las fuentes»). */
  readonly label: string;
  /** Descripción que lee el modelo (en español, sin instrucciones sobre datos de documentos). */
  readonly description: string;
  readonly risk: RiesgoDeTool;
  /** Capacidad(es) que el rol ACTUAL de la persona debe tener (todas). Define qué tools se ofrecen y se ejecutan. */
  readonly requiredAction: Action | readonly Action[];
  readonly inputSchema: ObjectSchema;
  /** `activa` = la campaña debe estar activa (escrituras de brief y propuestas). */
  readonly campaignStatus: 'activa' | 'any';
  readonly grounding?: GroundingDeTool;
  readonly quota?: CuotaDeTool;
  /**
   * ¿Qué caso(s) de uso existente(s) reutiliza? (DEC-047). Nombres exactos de las
   * funciones de `use-cases.ts`. Toda tool tiene al menos uno; el único caso de uso
   * NUEVO de la fase es `actualizarCampana`.
   */
  readonly reuses: readonly string[];
  /** Nota de reutilización para la tabla de DEC-047. */
  readonly reuseNote: string;
  /** Ejecuta el caso de uso. Los argumentos ya pasaron el esquema, los ids de recurso no. */
  run(ctx: ToolCtx, input: I): Promise<Result<V>>;
  /** Proyección acotada de la salida (los datos de documentos van en sobres no confiables). */
  project(valor: V, ctx: ToolCtx, input: I): Proyeccion;
}

/** Tool cualquiera del catálogo (el executor no conoce sus tipos). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyToolDefinition = ToolDefinition<any, any>;
