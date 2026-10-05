/**
 * Utilidades SOLO de pruebas del registro de tools (BD real, base `_test`).
 * Los archivos `*.test.ts` y este están excluidos del test estático de import-boundary.
 */
import { RegistroDeReferencias, type User } from '@tcl-kol-os/domain';
import { crearConversacion, derivarNonce, iniciarRun, publicarMensaje, query } from '@tcl-kol-os/db';
import { CONFIG_DE_RUN_DE_PRUEBA } from '@tcl-kol-os/db/test-utils';
import type { ToolExecution, ToolRunContext } from '../contracts.ts';
import { createToolRegistry } from './registry.ts';

export const SECRETO = 's'.repeat(32);
export const nonceDePrueba = (runId: string): string => derivarNonce(SECRETO, runId);

export const registro = () =>
  createToolRegistry({
    nonceForRun: nonceDePrueba,
    onUnexpectedError: (t, e) => {
      if (process.env['TOOLS_DEBUG']) console.error('[debug]', t, e);
    },
  });

let contador = 0;
export const clave = (): string => `tw2a-${Date.now().toString(36)}-${++contador}-xxxxxxxx`;

export interface Turno {
  readonly conversationId: string;
  readonly messageId: string;
  readonly runId: string;
  readonly actor: User;
  readonly campaignId: string;
  readonly referencias: RegistroDeReferencias;
  readonly textos: string[];
  step: number;
}

/** Conversación + mensaje de la persona + run `running`, listo para ejecutar tools. */
export async function abrirTurno(actor: User, campaignId: string, texto: string): Promise<Turno> {
  const conv = await crearConversacion(actor, { campaignId });
  if (!conv.ok) throw new Error(`conversación: ${conv.error.code}`);
  const pub = await publicarMensaje(actor, {
    conversationId: conv.value.id,
    clientMessageId: clave(),
    content: texto,
    runConfig: CONFIG_DE_RUN_DE_PRUEBA,
  });
  if (!pub.ok) throw new Error(`mensaje: ${pub.error.code}`);
  const run = await iniciarRun(actor, pub.value.run.id, { contextHash: 'f'.repeat(64), contextManifest: {} });
  if (!run.ok) throw new Error(`run: ${run.error.code}`);
  return {
    conversationId: conv.value.id,
    messageId: pub.value.message.id,
    runId: pub.value.run.id,
    actor,
    campaignId,
    referencias: new RegistroDeReferencias(),
    textos: [texto],
    step: 0,
  };
}

export function contextoDe(t: Turno): ToolRunContext {
  return {
    actor: t.actor,
    campaignId: t.campaignId,
    conversationId: t.conversationId,
    messageId: t.messageId,
    agentRunId: t.runId,
    stepIndex: t.step,
    referencias: t.referencias,
    textosDelActor: t.textos,
  };
}

export type Registro = ReturnType<typeof registro>;

/** Ejecuta una llamada nueva (id y paso distintos) y devuelve la ejecución. */
export function llamar(
  r: Registro,
  t: Turno,
  name: string,
  args: unknown,
  id: string = clave(),
): Promise<ToolExecution> {
  t.step += 1;
  return r.execute({ context: contextoDe(t), call: { id, name, arguments: args } });
}

export const json = (e: ToolExecution): Record<string, unknown> =>
  JSON.parse(e.content) as Record<string, unknown>;

export async function auditoriaDe(entityId: string) {
  return query<{
    action: string;
    origin: string | null;
    actor_id: string | null;
    correlation: Record<string, string> | null;
    metadata: Record<string, unknown>;
  }>(
    `SELECT action, origin, actor_id, correlation, metadata FROM audit_events WHERE entity_id = $1 ORDER BY created_at, id`,
    [entityId],
  );
}
