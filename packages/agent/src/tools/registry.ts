/**
 * Registro de tools del agente de Cuenta (V2 · Fase 6).
 *
 * Implementa `ToolRegistry` (contracts.ts): qué tools se ofrecen al modelo con el rol
 * ACTUAL de la persona y la ejecución de cada llamada con el pipeline completo
 * (`executor.ts`). El catálogo es cerrado: una tool prohibida (aprobar, confirmar,
 * ejecutar…) no existe aquí, y `createToolRegistry` rechaza registrar una cuyo nombre o
 * caso de uso sea de las prohibidas.
 */

import { createHash } from 'node:crypto';
import { type User, roleCan } from '@tcl-kol-os/domain';
import type { ModelToolDefinition, ToolExecution, ToolRegistry, ToolRunCall } from '../contracts.ts';
import { CATALOGO_V1 } from './catalog/index.ts';
import { CAPACIDAD_BASE, ejecutarTool } from './executor.ts';
import { identificadoresProhibidos } from './manifest.ts';
import { assertEsquemaCerrado } from './schema.ts';
import type { AnyToolDefinition } from './types.ts';

export interface OpcionesDelRegistro {
  /** Nonce de los sobres no confiables de un run (HMAC con el secreto del servidor). */
  readonly nonceForRun: (agentRunId: string) => string;
  /** Catálogo alternativo (pruebas, extensiones). Por defecto, el catálogo v1. */
  readonly tools?: readonly AnyToolDefinition[];
  /** Registro de excepciones inesperadas (solo servidor). Por defecto `console.error`. */
  readonly onUnexpectedError?: (tool: string, error: unknown) => void;
}

export interface FichaDeTool {
  readonly name: string;
  readonly label: string;
  readonly risk: AnyToolDefinition['risk'];
  readonly requiredAction: AnyToolDefinition['requiredAction'];
  readonly reuses: readonly string[];
  readonly reuseNote: string;
}

export interface ToolRegistryConFichas extends ToolRegistry {
  /** Metadatos de cada tool (UI, DEC-047). */
  catalog(): readonly FichaDeTool[];
  labelFor(name: string): string | undefined;
}

/** JSON canónico (claves ordenadas) para huellas estables. */
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

/** Huella estable del catálogo: nombre, versión, descripción, schema, riesgo, capability, cuota y grounding. */
export function huellaDelCatalogo(tools: readonly AnyToolDefinition[]): string {
  const filas = [...tools]
    .sort((a, b) => (a.name < b.name ? -1 : 1))
    .map((t) => ({
      name: t.name,
      version: t.version,
      description: t.description,
      risk: t.risk,
      requiredAction: t.requiredAction,
      campaignStatus: t.campaignStatus,
      inputSchema: t.inputSchema,
      quota: t.quota ?? null,
      grounding: t.grounding ?? null,
    }));
  return createHash('sha256').update(canonico(filas)).digest('hex');
}

function validarCatalogo(tools: readonly AnyToolDefinition[]): void {
  const prohibidos = new Set(identificadoresProhibidos().map((n) => n.toLowerCase()));
  const nombres = new Set<string>();
  for (const t of tools) {
    if (!/^[a-z][a-z0-9_]{2,63}$/.test(t.name)) throw new Error(`Tool «${t.name}»: nombre no válido.`);
    if (nombres.has(t.name)) throw new Error(`Tool «${t.name}» duplicada.`);
    nombres.add(t.name);
    if (prohibidos.has(t.name.toLowerCase().replaceAll('_', ''))) {
      throw new Error(`Tool «${t.name}»: nombra una operación PROHIBIDA para el agente.`);
    }
    for (const caso of t.reuses) {
      const nombreDeFuncion = caso.split(' ')[0]!;
      if (prohibidos.has(nombreDeFuncion.toLowerCase())) {
        throw new Error(`Tool «${t.name}»: reutiliza «${caso}», prohibido para el agente.`);
      }
    }
    if (t.reuses.length === 0) throw new Error(`Tool «${t.name}»: declara qué caso de uso reutiliza.`);
    assertEsquemaCerrado(t.inputSchema, t.name);
  }
}

export function createToolRegistry(opciones: OpcionesDelRegistro): ToolRegistryConFichas {
  const tools = opciones.tools ?? CATALOGO_V1;
  validarCatalogo(tools);
  const porNombre = new Map(tools.map((t) => [t.name, t]));
  const catalogHash = huellaDelCatalogo(tools);

  const puede = (actor: User, t: AnyToolDefinition): boolean => {
    if (actor.status !== 'activo' || !roleCan(actor.role, CAPACIDAD_BASE)) return false;
    const exigidas = typeof t.requiredAction === 'string' ? [t.requiredAction] : t.requiredAction;
    return exigidas.every((a) => roleCan(actor.role, a));
  };

  return {
    catalogHash,
    definitionsFor(actor: User): readonly ModelToolDefinition[] {
      return tools
        .filter((t) => puede(actor, t))
        .map((t) => ({
          name: t.name,
          description: t.description,
          parameters: t.inputSchema as unknown as Readonly<Record<string, unknown>>,
        }));
    },
    execute(call: ToolRunCall): Promise<ToolExecution> {
      return ejecutarTool(
        {
          tools: porNombre,
          nonceForRun: opciones.nonceForRun,
          onUnexpectedError:
            opciones.onUnexpectedError ??
            ((tool, error) => {
              console.error(`[agent-tool] ${tool}`, error);
            }),
        },
        call.context,
        call.call,
      );
    },
    catalog(): readonly FichaDeTool[] {
      return tools.map((t) => ({
        name: t.name,
        label: t.label,
        risk: t.risk,
        requiredAction: t.requiredAction,
        reuses: t.reuses,
        reuseNote: t.reuseNote,
      }));
    },
    labelFor(name: string): string | undefined {
      return porNombre.get(name)?.label;
    },
  };
}
