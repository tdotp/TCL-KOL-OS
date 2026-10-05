/**
 * Verificaciones comunes de las tools: todo id de recurso que aporta el modelo se
 * resuelve (alias del registro o UUID) y se COMPRUEBA contra la campaña del run con
 * el mismo caso de uso de lectura que usaría la UI. Un recurso de otra campaña (aunque
 * sea de la misma organización) o de otra organización responde igual que uno
 * inexistente: `RESOURCE_NOT_FOUND`.
 */

import {
  type ContextReferenceKind,
  type Result,
  type PreparacionDeFuente,
  describirPreparacion,
  err,
  ok,
} from '@tcl-kol-os/domain';
import type { SourceRow } from './use-cases.ts';
import * as uc from './use-cases.ts';
import type { ToolCtx } from './types.ts';

export const RECURSO_NO_ENCONTRADO = {
  code: 'RESOURCE_NOT_FOUND',
  message: 'El recurso no existe o no está disponible.',
} as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ALIAS = /^[A-Za-z]{1,2}\d{1,5}$/;

export function esUuid(valor: unknown): valor is string {
  return typeof valor === 'string' && UUID.test(valor);
}

/**
 * Resuelve lo que el modelo escribió como identificador: un alias del registro del run
 * (`S1`, `P3`…) o un UUID. Un alias fuera del registro, o de otro tipo, no existe.
 * El UUID se devuelve tal cual: aún hay que verificarlo contra la campaña.
 */
export function resolverId(ctx: ToolCtx, valor: unknown, kind: ContextReferenceKind): Result<string> {
  if (typeof valor !== 'string') return err(RECURSO_NO_ENCONTRADO);
  const limpio = valor.trim();
  if (ALIAS.test(limpio)) {
    const ref = ctx.run.referencias.resolver(limpio, kind);
    if (!ref.ok) return err(RECURSO_NO_ENCONTRADO);
    const id = kind === 'source' ? ref.value.sourceId : ref.value.entityId;
    return id === undefined ? err(RECURSO_NO_ENCONTRADO) : ok(id);
  }
  return UUID.test(limpio) ? ok(limpio.toLowerCase()) : err(RECURSO_NO_ENCONTRADO);
}

/** Registra (o reutiliza) el alias de una fuente. Mismos campos que el ensamblador de contexto. */
export function aliasDeFuente(ctx: ToolCtx, f: SourceRow): string {
  return ctx.run.referencias.registrar({
    kind: 'source',
    sourceId: f.id,
    sourceHash: f.hash ?? undefined,
    snapshotId: f.current_snapshot_id ?? undefined,
  }).alias;
}

export interface FuenteVerificada {
  readonly row: SourceRow;
  readonly alias: string;
  readonly preparacion: PreparacionDeFuente;
  /** Política única de lectura para IA (`fuenteLegibleParaIA`). */
  readonly legible: boolean;
  readonly descripcion: string;
}

/**
 * Fuente de LA campaña del run, con la política de lectura para IA aplicada. Una fuente
 * `restricted` (sensible o con confidencialidad desconocida) se trata como inexistente:
 * el modelo no puede ni saber que existe. Las demás devuelven su preparación (una fuente
 * en cola o fallida existe, pero no es legible).
 */
export async function fuenteDeCampana(ctx: ToolCtx, valor: unknown): Promise<Result<FuenteVerificada>> {
  const id = resolverId(ctx, valor, 'source');
  if (!id.ok) return id;
  const r = await uc.getSource(ctx.actor, id.value);
  if (!r.ok || r.value.campaign_id !== ctx.run.campaignId) return err(RECURSO_NO_ENCONTRADO);
  const preparacion = uc.preparacionDeFuente(r.value);
  if (preparacion === 'restricted') return err(RECURSO_NO_ENCONTRADO);
  return ok({
    row: r.value,
    alias: aliasDeFuente(ctx, r.value),
    preparacion,
    legible: uc.esLegibleParaIA(r.value),
    descripcion: describirPreparacion(preparacion),
  });
}

/** Etiqueta breve en español de un estado de plan/registro para el texto de salida. */
export function sinContenido(descripcion: string): string {
  return `La fuente no tiene contenido que se pueda leer: ${descripcion}.`;
}
