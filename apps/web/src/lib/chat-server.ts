/**
 * Cableado del agente de Cuenta en el servidor web (V2 · Fase 6, Wave 3).
 *
 * Aquí (y solo aquí) se crean el cliente del modelo y el registro de tools del agente y
 * se programa el run en segundo plano. NO hay lógica de negocio: la admisión del turno,
 * el bucle, las tools y el cierre del run viven en `@tcl-kol-os/agent`/`db`.
 *
 *   Server action → admitirTurno (persiste mensaje + run `queued`)
 *                 → iniciarEnSegundoPlano(after, …)   // `after()` de Next: tras responder
 *                 → ejecutarRun (bucle del agente, como la PERSONA, con el modelo del worker)
 *
 * El modelo se llama a través del worker Python (`POST /modelo/turno`): la web nunca
 * habla con el proveedor ni ve su clave (D1). Si el worker no responde, el run termina
 * `failed` (`AGENT_MODEL_UNAVAILABLE`) y la persona lo reintenta; si el proceso web cae
 * a mitad de un run, el barrido perezoso lo cierra como `RUN_ABANDONED`.
 *
 * Este módulo es solo de servidor (importa `next/server` y las tools): jamás desde un
 * componente cliente.
 */

import { after } from 'next/server';
import {
  type ModelClient,
  type ToolRegistryConFichas,
  WorkerModelClient,
  createToolRegistry,
  envDelProceso,
  iaActiva,
  iniciarEnSegundoPlano,
  secretoDelNonce,
} from '@tcl-kol-os/agent';
import {
  archivarConversacion,
  crearConversacion,
  derivarNonce,
  obtenerConversacionDeCampana,
} from '@tcl-kol-os/db';
import { type Result, type User, ok } from '@tcl-kol-os/domain';

interface RuntimeDelChat {
  readonly model: ModelClient;
  readonly registry: ToolRegistryConFichas;
}

/**
 * Una instancia por módulo (no por proceso, a propósito): Next puede cargar este módulo y el
 * paquete del agente más de una vez (una por capa/chunk de compilación). Si el cliente del modelo
 * se compartiera entre instancias por `globalThis`, sus `ModelError` ya no serían `instanceof` de la
 * clase que mira el runtime y todo fallo de red acabaría como `AGENT_RUNTIME_ERROR` en vez de
 * `AGENT_MODEL_UNAVAILABLE`. Ambos objetos son baratos y sin estado de negocio.
 */
let runtimeEnCache: RuntimeDelChat | undefined;

/**
 * Cliente del modelo + registro de tools. `undefined` si falta un secreto utilizable para
 * el nonce de los sobres (en producción exige `AGENT_NONCE_SECRET` o `SESSION_SECRET` de
 * ≥16 caracteres): sin él el asistente se declara no disponible, no arranca a medias.
 */
export function runtimeDelChat(): RuntimeDelChat | undefined {
  if (runtimeEnCache !== undefined) return runtimeEnCache;
  const secreto = secretoDelNonce(envDelProceso);
  if (secreto === undefined) return undefined;
  runtimeEnCache = {
    // `AI_WORKER_URL ?? WORKER_URL` (D17); el plazo y los reintentos son los del cliente.
    model: new WorkerModelClient(),
    registry: createToolRegistry({ nonceForRun: (agentRunId) => derivarNonce(secreto, agentRunId) }),
  };
  return runtimeEnCache;
}

/** Estado del asistente para la interfaz: apagado por el kill-switch, sin configurar, o listo. */
export type EstadoDelAsistente = 'activo' | 'ia_apagada' | 'sin_configurar';

export function estadoDelAsistente(): EstadoDelAsistente {
  if (!iaActiva(envDelProceso)) return 'ia_apagada';
  return runtimeDelChat() === undefined ? 'sin_configurar' : 'activo';
}

/** Etiqueta en español de una tool por su nombre interno (para la actividad legible). */
export function etiquetaDeTool(nombre: string): string | undefined {
  return runtimeDelChat()?.registry.labelFor(nombre);
}

/**
 * Programa el run para DESPUÉS de responder a la persona (`after()`). Idempotente: si dos
 * ejecutores compiten por el mismo run, uno solo lo toma. Devuelve `false` si el runtime no
 * está disponible (el run quedará `queued` y lo cerrará el barrido).
 */
export function dispararRunEnSegundoPlano(actor: User, runId: string): boolean {
  const runtime = runtimeDelChat();
  if (runtime === undefined) return false;
  iniciarEnSegundoPlano(after, actor, runId, { model: runtime.model, registry: runtime.registry });
  return true;
}

/**
 * La conversación del actor en la campaña; la crea si todavía no existe (creación
 * PEREZOSA, al enviar el primer mensaje: abrir la pantalla nunca escribe). Si dos envíos
 * simultáneos crean dos, gana la que ya tenía actividad o, a igualdad, la más antigua; la
 * vacía sobrante se archiva.
 */
export async function obtenerOCrearConversacion(
  actor: User,
  campaignId: string,
): Promise<Result<{ readonly id: string }>> {
  const existente = await obtenerConversacionDeCampana(actor, campaignId);
  if (!existente.ok) return existente;
  if (existente.value !== null) return ok({ id: existente.value.id });

  const creada = await crearConversacion(actor, { campaignId });
  if (!creada.ok) return creada;

  const ganadora = await obtenerConversacionDeCampana(actor, campaignId);
  if (ganadora.ok && ganadora.value !== null && ganadora.value.id !== creada.value.id) {
    // La nuestra no ganó la carrera: está vacía y sin runs, se archiva sin consecuencias.
    await archivarConversacion(actor, creada.value.id);
    return ok({ id: ganadora.value.id });
  }
  return ok({ id: creada.value.id });
}

// ─────────────────────────── Adjuntos ──────────────────────────────────────────

/** Tope por defecto de un adjunto del chat (MB). */
export const ADJUNTO_MAX_MB_POR_DEFECTO = 25;

function mbDeEnv(nombre: string, porDefecto: number): number {
  const n = Number(process.env[nombre]);
  return Number.isFinite(n) && n > 0 ? n : porDefecto;
}

/**
 * Tope EXPLÍCITO de tamaño de un adjunto (bytes): `CHAT_ATTACHMENT_MAX_MB` (25 MB por defecto)
 * y nunca más que el límite del flujo de fuentes (`MAX_UPLOAD_MB`, 50 MB), que `uploadSource`
 * vuelve a imponer. La ruta HTTP de adjuntos lo comprueba ANTES de leer el cuerpo.
 */
export function limiteDeAdjuntoBytes(): number {
  const mb = Math.min(
    mbDeEnv('CHAT_ATTACHMENT_MAX_MB', ADJUNTO_MAX_MB_POR_DEFECTO),
    mbDeEnv('MAX_UPLOAD_MB', 50),
  );
  return Math.floor(mb * 1024 * 1024);
}
