/**
 * `ToolRegistry` FALSO para probar el runtime sin el registro real (W2-A).
 *
 * Cumple el contrato de `contracts.ts`: `definitionsFor(actor)` filtra por el rol
 * (como el real) y `execute` devuelve una `ToolExecution` (no lanza por errores
 * esperables). Graba lo que se le ofreció y lo que se le pidió ejecutar. Solo para
 * pruebas: no se exporta desde el índice del paquete.
 */
import { type Action, type ToolRiskClass, type User, roleCan } from '@tcl-kol-os/domain';
import type { ModelToolDefinition, ToolExecution, ToolRegistry, ToolRunCall } from '../../contracts.ts';

export interface HerramientaFalsa {
  readonly name: string;
  readonly requiredAction: Action;
  readonly riskClass: ToolRiskClass;
  /** Contenido que vuelve al modelo, o una función que lo calcula (puede lanzar o esperar). */
  readonly resultado:
    string | ((call: ToolRunCall) => string | ToolExecution | Promise<string | ToolExecution>);
}

export class FakeToolRegistry implements ToolRegistry {
  readonly catalogHash = 'c'.repeat(64);
  /** Nombres de tools ofrecidas en cada llamada a `definitionsFor`, en orden. */
  readonly ofrecidas: string[][] = [];
  /** Llamadas recibidas por `execute`, en orden. */
  readonly ejecuciones: ToolRunCall[] = [];
  /** Máximo de ejecuciones simultáneas observadas (debe ser 1: secuenciales). */
  maxSimultaneas = 0;
  private enCurso = 0;

  constructor(private readonly herramientas: readonly HerramientaFalsa[]) {}

  definitionsFor(actor: User): readonly ModelToolDefinition[] {
    const visibles = this.herramientas.filter((h) => roleCan(actor.role, h.requiredAction));
    this.ofrecidas.push(visibles.map((h) => h.name));
    return visibles.map((h) => ({
      name: h.name,
      description: `Herramienta falsa ${h.name}`,
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    }));
  }

  async execute(call: ToolRunCall): Promise<ToolExecution> {
    this.ejecuciones.push(call);
    this.enCurso += 1;
    this.maxSimultaneas = Math.max(this.maxSimultaneas, this.enCurso);
    try {
      const herramienta = this.herramientas.find((h) => h.name === call.call.name);
      if (herramienta === undefined) {
        return {
          content: JSON.stringify({
            error: { code: 'AGENT_INVALID_TOOL_CALL', message: 'Herramienta inexistente.' },
          }),
          status: 'failed',
          errorCode: 'AGENT_INVALID_TOOL_CALL',
          riskClass: 'unregistered',
        };
      }
      if (!roleCan(call.context.actor.role, herramienta.requiredAction)) {
        return {
          content: JSON.stringify({ error: { code: 'FORBIDDEN_ROLE', message: 'Sin permiso.' } }),
          status: 'failed',
          errorCode: 'FORBIDDEN_ROLE',
          riskClass: herramienta.riskClass,
        };
      }
      const salida =
        typeof herramienta.resultado === 'function'
          ? await herramienta.resultado(call)
          : herramienta.resultado;
      if (typeof salida === 'string') {
        return { content: salida, status: 'succeeded', riskClass: herramienta.riskClass };
      }
      return salida;
    } finally {
      this.enCurso -= 1;
    }
  }

  nombresEjecutados(): string[] {
    return this.ejecuciones.map((e) => e.call.name);
  }
}

export const lectura = (
  name: string,
  resultado: HerramientaFalsa['resultado'] = '{"ok":true}',
): HerramientaFalsa => ({
  name,
  requiredAction: 'campaign:read',
  riskClass: 'read',
  resultado,
});

/** Tool de escritura que solo ve un admin (permite probar que el rol vigente filtra las tools). */
export const escrituraSoloAdmin = (
  name: string,
  resultado: HerramientaFalsa['resultado'] = '{"ok":true}',
): HerramientaFalsa => ({ name, requiredAction: 'admin:ai_flag', riskClass: 'write', resultado });
