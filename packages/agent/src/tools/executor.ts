/**
 * Executor de tools: el pipeline de seguridad de CADA llamada (V2 · Fase 6, §2).
 *
 *   existe → actor releído → claim de idempotencia → campaña (org + campaña de la
 *   conversación) → esquema estricto → capability → estado de campaña →
 *   grounding → cuota/presupuesto → caso de uso (con contexto chat + correlación) →
 *   proyección acotada → cierre de la invocación
 *
 * Sin caché: el actor, la campaña y el rol se vuelven a leer en CADA llamada, así que un
 * permiso revocado entre dos llamadas del mismo run se nota en la segunda. Nunca lanza
 * por errores esperables: toda salida es un `ToolExecution`. Una excepción inesperada
 * se registra en el log del servidor y al modelo le llega `AGENT_TOOL_FAILED` sin
 * detalle (ni stack, ni SQL, ni rutas).
 *
 * Toda llamada deja traza en `agent_tool_invocations` (también las rechazadas y las de
 * tools inexistentes o prohibidas, con `riskClass = 'unregistered'`) siempre que haya un
 * run activo y una persona válida; el claim es la idempotencia: la misma llamada nunca
 * ejecuta dos veces.
 */

import {
  type Action,
  type ToolInvocation,
  type ToolRiskClass,
  type User,
  nonceValido,
  roleCan,
  sanitizarArgsDeTool,
  verificarCitaLiteral,
  verificarUrlLiteral,
} from '@tcl-kol-os/domain';
import type { ToolCallRequest, ToolExecution, ToolRunContext } from '../contracts.ts';
import {
  MAX_OUTPUT_BYTES,
  bytesUtf8,
  detallesSeguros,
  serializarError,
  serializarExito,
} from './projection.ts';
import { describirIncidencias, validarArgumentos } from './schema.ts';
import type { AnyToolDefinition, ToolCtx } from './types.ts';
import * as uc from './use-cases.ts';

/** Capacidad base: el agente de Cuenta solo trabaja para quien puede escribir en el chat. */
export const CAPACIDAD_BASE: Action = 'chat:write';

/** Presupuesto por run (arquitectura C §2): lecturas y efectos/propuestas. */
export const MAX_LECTURAS_POR_RUN = 25;
export const MAX_EFECTOS_POR_RUN = 10;

export const CODIGO_PRESUPUESTO = 'TOOL_BUDGET_EXCEEDED';

export interface OpcionesDeEjecucion {
  readonly tools: ReadonlyMap<string, AnyToolDefinition>;
  /** Nonce de los sobres no confiables del run (HMAC con el secreto del servidor). */
  readonly nonceForRun: (agentRunId: string) => string;
  /** Registro de errores inesperados (solo servidor). Por defecto, `console.error`. */
  readonly onUnexpectedError?: ((tool: string, error: unknown) => void) | undefined;
}

// ─────────────────────────── Construcción de resultados ────────────────────────

interface Falla {
  readonly code: string;
  readonly message: string;
  readonly retryable?: boolean;
  readonly details?: Readonly<Record<string, unknown>> | undefined;
}

type Cuerpo =
  | {
      readonly kind: 'ok';
      readonly content: string;
      readonly stored: Readonly<Record<string, unknown>>;
      readonly proposedActionId?: string | undefined;
    }
  | { readonly kind: 'failed'; readonly falla: Falla }
  | { readonly kind: 'cancelled'; readonly falla: Falla };

const fallido = (falla: Falla): Cuerpo => ({ kind: 'failed', falla });

/** Códigos de error de dominio que el modelo puede corregir reintentando con otros datos. */
const REINTENTABLES: ReadonlySet<string> = new Set(['VALIDATION_FAILED', 'FIELD_REVISION_CONFLICT']);

function contenidoDeFalla(f: Falla): string {
  return serializarError({
    code: f.code,
    message: f.message,
    retryable: f.retryable ?? REINTENTABLES.has(f.code),
    details: detallesSeguros(f.details),
  });
}

function ejecucion(riesgo: ToolRiskClass, cuerpo: Cuerpo, invocacion?: ToolInvocation): ToolExecution {
  const base = {
    riskClass: riesgo,
    ...(invocacion === undefined ? {} : { invocationId: invocacion.id }),
  };
  if (cuerpo.kind === 'ok') {
    return {
      ...base,
      status: 'succeeded',
      content: cuerpo.content,
      ...(cuerpo.proposedActionId === undefined ? {} : { proposedActionId: cuerpo.proposedActionId }),
    };
  }
  return {
    ...base,
    status: cuerpo.kind === 'cancelled' ? 'cancelled' : 'failed',
    content: contenidoDeFalla(cuerpo.falla),
    errorCode: cuerpo.falla.code,
  };
}

/** Una cadena JSON canónica (claves ordenadas) para comparar argumentos. */
function canonico(valor: unknown): string {
  if (Array.isArray(valor)) return `[${valor.map(canonico).join(',')}]`;
  if (valor !== null && typeof valor === 'object') {
    const o = valor as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonico(o[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(valor) ?? 'null';
}

// ─────────────────────────── Grounding (D11) ───────────────────────────────────

/**
 * Los argumentos con efecto deben salir de lo que la PERSONA escribió en esta
 * conversación: se contrastan SOLO con sus mensajes (nunca con contenido de fuentes).
 */
function verificarGrounding(
  def: AnyToolDefinition,
  args: Readonly<Record<string, unknown>>,
  textosDelActor: readonly string[],
): Falla | undefined {
  const g = def.grounding;
  if (g === undefined) return undefined;
  const fallaDe = (field: string, motivo: string, mensaje: string): Falla => ({
    code: 'VALIDATION_FAILED',
    message: mensaje,
    details: { reason: 'grounding', field, motivo },
  });
  if (g.quoteField !== undefined) {
    const r = verificarCitaLiteral(args[g.quoteField], textosDelActor);
    if (!r.ok) {
      return fallaDe(
        g.quoteField,
        r.motivo,
        'La cita no aparece literalmente en un mensaje de la persona en esta conversación. Cita sus palabras tal cual, no las de un documento ni las tuyas.',
      );
    }
  }
  if (g.urlField !== undefined) {
    const r = verificarUrlLiteral(args[g.urlField], textosDelActor);
    if (!r.ok) {
      return fallaDe(
        g.urlField,
        r.motivo,
        'La URL no aparece idéntica en un mensaje de la persona. Solo se registran enlaces que la persona escribió o pegó en esta conversación.',
      );
    }
  }
  for (const campo of g.literalFields ?? []) {
    const valor = args[campo.field];
    if (valor === undefined) continue;
    const r = verificarCitaLiteral(valor, textosDelActor, { minChars: campo.minChars });
    if (!r.ok) {
      return fallaDe(
        campo.field,
        r.motivo,
        `El valor de «${campo.field}» no aparece en los mensajes de la persona: usa exactamente lo que ella escribió.`,
      );
    }
  }
  return undefined;
}

// ─────────────────────────── Cuota y presupuesto ───────────────────────────────

async function verificarPresupuesto(
  def: AnyToolDefinition,
  actor: User,
  runId: string,
  invocacionActual: string,
): Promise<Falla | undefined> {
  const lista = await uc.listarInvocacionesDeRun(actor, runId);
  if (!lista.ok) {
    return { code: lista.error.code, message: lista.error.message };
  }
  const otras = lista.value.filter((i) => i.id !== invocacionActual && i.status !== 'cancelled');
  const esEfecto = def.risk !== 'read';
  const usadas = otras.filter(
    (i) => (i.riskClass === 'read') === !esEfecto && i.riskClass !== 'unregistered',
  ).length;
  const tope = esEfecto ? MAX_EFECTOS_POR_RUN : MAX_LECTURAS_POR_RUN;
  if (usadas >= tope) {
    return {
      code: CODIGO_PRESUPUESTO,
      message: `Se alcanzó el máximo de ${esEfecto ? 'acciones con efecto' : 'lecturas'} por turno (${tope}). Responde con lo que ya tienes.`,
      details: { reason: 'run_budget', limit: tope },
    };
  }
  if (def.quota !== undefined) {
    const contadas = otras.filter(
      (i) =>
        i.toolName === def.name &&
        (i.status === 'running' ||
          i.status === 'succeeded' ||
          (i.status === 'failed' &&
            i.errorCode !== undefined &&
            (def.quota?.countsFailedWith ?? []).includes(i.errorCode))),
    ).length;
    if (contadas >= def.quota.perRun) {
      return {
        code: CODIGO_PRESUPUESTO,
        message: `«${def.name}» solo puede usarse ${def.quota.perRun} vez por turno. ${def.quota.why}`,
        details: { reason: 'tool_quota', tool: def.name, limit: def.quota.perRun },
      };
    }
  }
  return undefined;
}

// ─────────────────────────── Cuerpo del pipeline ───────────────────────────────

async function cuerpoDelPipeline(
  opts: OpcionesDeEjecucion,
  def: AnyToolDefinition | undefined,
  actor: User,
  run: ToolRunContext,
  invocacion: ToolInvocation,
  argumentos: unknown,
  /** `false` en el replay de una lectura: no hay presupuesto ni cuota que descontar. */
  contarPresupuesto: boolean,
): Promise<Cuerpo> {
  if (def === undefined) {
    return fallido({
      code: 'AGENT_INVALID_TOOL_CALL',
      message:
        'La herramienta pedida no existe o no está disponible para ti. Usa solo las herramientas ofrecidas.',
      retryable: false,
    });
  }

  // El run y la invocación pertenecen a esta campaña y a la organización de la persona.
  if (invocacion.campaignId !== run.campaignId || invocacion.organizationId !== actor.organizationId) {
    return fallido({ code: 'RESOURCE_NOT_FOUND', message: 'El recurso no existe o no está disponible.' });
  }

  // Esquema estricto: ni identidad, ni ámbito, ni canal, ni estado vienen del modelo.
  const valida = validarArgumentos(def.inputSchema, argumentos);
  if (!valida.ok) {
    const prohibida = valida.issues.some((i) => i.reason === 'forbidden_key' || i.reason === 'dangerous_key');
    return fallido({
      code: 'VALIDATION_FAILED',
      message: `Argumentos inválidos para ${def.name}: ${describirIncidencias(valida.issues)}`,
      details: { reason: prohibida ? 'forbidden_argument' : 'schema', tool: def.name },
    });
  }

  // Campaña releída con el alcance de la persona, y de SU organización.
  const campana = await uc.getCampaign(actor, run.campaignId);
  if (!campana.ok || campana.value.campaign.organization_id !== actor.organizationId) {
    return fallido({ code: 'RESOURCE_NOT_FOUND', message: 'El recurso no existe o no está disponible.' });
  }

  // Capability del rol ACTUAL (releído arriba): base del agente + la de la tool.
  const exigidas: readonly Action[] = [
    CAPACIDAD_BASE,
    ...(typeof def.requiredAction === 'string' ? [def.requiredAction] : def.requiredAction),
  ];
  const faltante = exigidas.find((a) => !roleCan(actor.role, a));
  if (faltante !== undefined) {
    return fallido({
      code: 'FORBIDDEN_ROLE',
      message: 'Tu rol actual no permite esta acción.',
      details: { reason: 'capability', tool: def.name },
    });
  }

  if (def.campaignStatus === 'activa' && campana.value.campaign.status !== 'activa') {
    return fallido({
      code: 'RESOURCE_CONFLICT',
      message: `La campaña está ${campana.value.campaign.status}: esta acción ya no se puede hacer.`,
      details: { reason: 'campaign_not_active', campaignStatus: campana.value.campaign.status },
    });
  }

  const sinGrounding = verificarGrounding(def, valida.value, run.textosDelActor);
  if (sinGrounding !== undefined) return fallido(sinGrounding);

  if (contarPresupuesto) {
    const sinPresupuesto = await verificarPresupuesto(def, actor, run.agentRunId, invocacion.id);
    if (sinPresupuesto !== undefined) return fallido(sinPresupuesto);
  }

  const nonce = opts.nonceForRun(run.agentRunId);
  if (!nonceValido(nonce)) {
    opts.onUnexpectedError?.(def.name, new Error('nonce inválido'));
    return fallido({
      code: 'AGENT_TOOL_FAILED',
      message: 'La herramienta no pudo ejecutarse.',
      retryable: false,
    });
  }
  if (run.signal?.aborted === true) {
    return {
      kind: 'cancelled',
      falla: {
        code: 'RUN_CANCELLED',
        message: 'El turno se canceló antes de ejecutar la herramienta.',
        retryable: false,
      },
    };
  }

  const ctx: ToolCtx = {
    actor,
    campaign: campana.value,
    run,
    invocationId: invocacion.id,
    contexto: {
      origin: 'chat',
      correlation: {
        conversationId: run.conversationId,
        messageId: run.messageId,
        agentRunId: run.agentRunId,
        toolInvocationId: invocacion.id,
      },
    },
    nonce,
  };

  // Caso de uso y proyección. Un error de dominio es esperable; una excepción no.
  try {
    const r = await def.run(ctx, valida.value);
    if (!r.ok) {
      return fallido({
        code: r.error.code,
        message: r.error.message,
        details: r.error.details,
      });
    }
    const p = def.project(r.value, ctx, valida.value);
    let content = serializarExito(p.data);
    if (bytesUtf8(content) > MAX_OUTPUT_BYTES) {
      // Red de seguridad: ninguna proyección debería llegar aquí. Se descarta el detalle.
      content = serializarExito({
        truncated: true,
        note: 'La salida excedió el límite y se descartó. Acota la consulta (paginación, filtros).',
        summary: p.stored,
      });
      if (bytesUtf8(content) > MAX_OUTPUT_BYTES) {
        content = serializarExito({ truncated: true });
      }
    }
    return { kind: 'ok', content, stored: p.stored, proposedActionId: p.proposedActionId };
  } catch (error) {
    opts.onUnexpectedError?.(def.name, error);
    return fallido({
      code: 'AGENT_TOOL_FAILED',
      message: 'La herramienta no pudo completarse.',
      retryable: false,
    });
  }
}

// ─────────────────────────── Punto de entrada ──────────────────────────────────

export async function ejecutarTool(
  opts: OpcionesDeEjecucion,
  run: ToolRunContext,
  llamada: ToolCallRequest,
): Promise<ToolExecution> {
  const nombre = typeof llamada.name === 'string' ? llamada.name : '';
  const def = opts.tools.get(nombre);
  const riesgo: ToolRiskClass = def?.risk ?? 'unregistered';

  try {
    // 1. Actor RELEÍDO en cada llamada: activo y con el mismo id que el del run.
    const actor = await uc.findUserById(run.actor.id);
    if (actor === undefined || actor.status !== 'activo') {
      return ejecucion(
        riesgo,
        fallido({
          code: 'FORBIDDEN_ROLE',
          message: 'La persona ya no está activa: no se ejecuta la herramienta.',
        }),
      );
    }
    if (run.signal?.aborted === true) {
      return ejecucion(riesgo, {
        kind: 'cancelled',
        falla: { code: 'RUN_CANCELLED', message: 'El turno se canceló.' },
      });
    }

    // 2. Claim de idempotencia (y traza). Sin claim no se ejecuta nada.
    const reclamo = await uc.reclamarInvocacion(actor, run.agentRunId, {
      stepIndex: run.stepIndex,
      toolCallId: llamada.id,
      toolName: nombre === '' ? '(sin nombre)' : nombre.slice(0, 100),
      riskClass: riesgo,
      args: llamada.arguments,
    });
    if (!reclamo.ok) {
      const noEnMarcha = reclamo.error.details?.['reason'] === 'run_not_running';
      return ejecucion(riesgo, {
        kind: noEnMarcha ? 'cancelled' : 'failed',
        falla: {
          code: noEnMarcha ? 'RUN_NOT_RUNNING' : reclamo.error.code,
          message: reclamo.error.message,
          retryable: false,
        },
      });
    }
    const { invocation, claimed } = reclamo.value;

    // 3. Replay: la misma llamada no vuelve a ejecutar un efecto.
    if (!claimed) {
      const previos = sanitizarArgsDeTool(invocation.args).valor;
      const actuales = sanitizarArgsDeTool(llamada.arguments).valor;
      if (canonico(previos) !== canonico(actuales)) {
        return ejecucion(
          riesgo,
          fallido({
            code: 'VALIDATION_FAILED',
            message: 'El id de esta llamada ya se usó con otros argumentos. Haz una llamada nueva.',
            details: { reason: 'idempotency_key_reuse' },
          }),
        );
      }
      if (invocation.status === 'running') {
        return ejecucion(
          riesgo,
          fallido({
            code: 'RESOURCE_CONFLICT',
            message: 'Esta llamada ya está en curso.',
            retryable: false,
            details: { reason: 'tool_in_progress' },
          }),
          invocation,
        );
      }
      if (invocation.riskClass === 'read' && invocation.status === 'succeeded') {
        // Una lectura no tiene efecto: se vuelve a leer (datos frescos), sin descontar presupuesto.
        const cuerpo = await cuerpoDelPipeline(opts, def, actor, run, invocation, llamada.arguments, false);
        return ejecucion(riesgo, cuerpo, invocation);
      }
      if (invocation.status === 'succeeded') {
        return ejecucion(
          riesgo,
          {
            kind: 'ok',
            content: serializarExito({
              replayed: true,
              note: 'Esta llamada ya se había ejecutado: no se repitió el efecto.',
              ...(invocation.result ?? {}),
            }),
            stored: invocation.result ?? {},
            proposedActionId: invocation.proposedActionId,
          },
          invocation,
        );
      }
      return ejecucion(
        riesgo,
        fallido({
          code: invocation.errorCode ?? 'AGENT_TOOL_FAILED',
          message: 'Esta llamada ya se había procesado antes y no tuvo éxito: no se repitió.',
          retryable: false,
          details: { reason: 'replayed' },
        }),
        invocation,
      );
    }

    // 4. Pipeline y cierre de la invocación.
    const cuerpo = await cuerpoDelPipeline(opts, def, actor, run, invocation, llamada.arguments, true);
    try {
      if (cuerpo.kind === 'ok') {
        await uc.cerrarInvocacion(actor, invocation.id, {
          status: 'succeeded',
          result: cuerpo.stored,
          ...(cuerpo.proposedActionId === undefined ? {} : { proposedActionId: cuerpo.proposedActionId }),
        });
      } else if (cuerpo.kind === 'cancelled') {
        await uc.cerrarInvocacion(actor, invocation.id, { status: 'cancelled' });
      } else {
        await uc.cerrarInvocacion(actor, invocation.id, { status: 'failed', errorCode: cuerpo.falla.code });
      }
    } catch (error) {
      // El efecto (si lo hubo) ya ocurrió y está auditado con la correlación: no se pierde la respuesta.
      opts.onUnexpectedError?.(nombre, error);
    }
    return ejecucion(riesgo, cuerpo, invocation);
  } catch (error) {
    opts.onUnexpectedError?.(nombre, error);
    return ejecucion(
      riesgo,
      fallido({
        code: 'AGENT_TOOL_FAILED',
        message: 'La herramienta no pudo completarse.',
        retryable: false,
      }),
    );
  }
}
