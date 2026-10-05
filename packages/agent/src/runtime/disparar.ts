/**
 * Disparo en segundo plano y barrido de abandonados (D9).
 *
 * Uso previsto en la capa web (Wave 3), tras persistir el mensaje:
 *
 *   const admitido = await admitirTurno(actor, input);
 *   if (admitido.ok && admitido.value.run.status === 'queued') {
 *     iniciarEnSegundoPlano(after, actor, admitido.value.run.id, { model, registry });
 *   }
 *
 * `after` es el de `next/server`. El disparo es idempotente: si dos ejecutores
 * compiten (p. ej. un reenvío idempotente y el primer `after()`), `iniciarRun` deja
 * pasar a uno solo y el otro termina como `skipped`.
 *
 * No hay auto-reencolado (D9): un run huérfano lo cierra el barrido como
 * `failed RUN_ABANDONED` y la persona lo reintenta (`reintentarRun`, attempt + 1).
 */
import type { AgentRun, Result, User } from '@tcl-kol-os/domain';
import { err } from '@tcl-kol-os/domain';
import { type EnvReader, envDelProceso } from '../model/env.ts';
import { configuracionDeRun, iaActiva } from './config.ts';
import { abandonarRunsCaducados, reintentarRun } from './db-ports.ts';
import { releerActor } from './admitir-turno.ts';
import { FALLOS } from './errores.ts';
import { type DependenciasDelRuntime, type ResultadoDeRun, ejecutarRun } from './ejecutar-run.ts';

/**
 * Ejecuta el run y NUNCA rechaza la promesa (no hay a quién propagar un error desde
 * `after()`): lo que no se pueda cerrar lo cubre el barrido de abandonados.
 */
export async function dispararRun(
  actor: User,
  runId: string,
  deps: DependenciasDelRuntime,
): Promise<ResultadoDeRun | undefined> {
  try {
    const r = await ejecutarRun(actor, runId, deps);
    return r.ok ? r.value : undefined;
  } catch {
    return undefined;
  }
}

/** Programador de tareas posteriores a la respuesta: `after` de Next, o cualquier función equivalente. */
export type Programador = (tarea: () => Promise<unknown>) => void;

/** Programa `dispararRun` para después de responder al usuario. */
export function iniciarEnSegundoPlano(
  programar: Programador,
  actor: User,
  runId: string,
  deps: DependenciasDelRuntime,
): void {
  programar(async () => {
    await dispararRun(actor, runId, deps);
  });
}

export interface BarridoInput {
  /** Si se da, tras el barrido se reintenta el turno de ese mensaje (último, fallido o cancelado). */
  readonly userMessageId?: string | undefined;
}

export interface DependenciasDeBarrido {
  readonly env?: EnvReader | undefined;
  readonly now?: (() => Date) | undefined;
}

export interface ResultadoDeBarrido {
  /** Runs `queued`/`running` sin latido que se cerraron como `RUN_ABANDONED`. */
  readonly abandonados: number;
  /** Solo si se pidió reintentar: el nuevo run `queued` (attempt + 1) o el motivo por el que no. */
  readonly reintento?: Result<AgentRun> | undefined;
}

/**
 * Cierra los runs abandonados y, opcionalmente, reintenta el turno de un mensaje con
 * la configuración vigente (`runConfig`). El barrido es mantenimiento de sistema
 * (`abandonarRunsCaducados`); el reintento es de la PERSONA (releída de la base).
 * El nuevo run queda `queued`: quien llama lo dispara con `iniciarEnSegundoPlano`.
 */
export async function barrerYReintentar(
  actor: User,
  input: BarridoInput = {},
  deps: DependenciasDeBarrido = {},
): Promise<ResultadoDeBarrido> {
  const env = deps.env ?? envDelProceso;
  const abandonados = await abandonarRunsCaducados({ ahora: (deps.now ?? (() => new Date()))() });
  if (input.userMessageId === undefined) return { abandonados };

  const vigente = await releerActor(actor);
  if (vigente === undefined) {
    return {
      abandonados,
      reintento: err({ code: 'FORBIDDEN_ROLE', message: FALLOS.personaSinAcceso.message }),
    };
  }
  if (!iaActiva(env)) {
    return {
      abandonados,
      reintento: err({ code: FALLOS.iaApagada.code, message: FALLOS.iaApagada.message }),
    };
  }
  return {
    abandonados,
    reintento: await reintentarRun(vigente, input.userMessageId, configuracionDeRun(env)),
  };
}
