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

// ─────────────────────────── Contenido (F7): alias estricto y cerco de campaña ──

/**
 * Alias del registro del run, y NADA más. A diferencia de `resolverId`, un UUID (aunque exista, aunque
 * sea de la campaña) se trata como inexistente: un id que el modelo vio en un documento nunca llega a un
 * caso de uso, y una versión solo puede proponerse para aprobar si ESTE run la mostró.
 */
export function resolverAliasEstricto(
  ctx: ToolCtx,
  valor: unknown,
  kind: ContextReferenceKind,
): Result<string> {
  if (typeof valor !== 'string') return err(RECURSO_NO_ENCONTRADO);
  const limpio = valor.trim();
  if (!ALIAS.test(limpio)) return err(RECURSO_NO_ENCONTRADO);
  const ref = ctx.run.referencias.resolver(limpio, kind);
  if (!ref.ok) return err(RECURSO_NO_ENCONTRADO);
  return ref.value.entityId === undefined ? err(RECURSO_NO_ENCONTRADO) : ok(ref.value.entityId);
}

/**
 * Participación de LA campaña del run (cerco: otra campaña u otra organización ⇒ inexistente). Con
 * `soloAlias` rechaza los UUID (las tools de contenido); sin él acepta alias o UUID (tools de influencers).
 */
export async function participacionDeCampana(
  ctx: ToolCtx,
  valor: unknown,
  opciones: { readonly soloAlias?: boolean } = {},
): ReturnType<typeof uc.obtenerCampaignInfluencer> {
  const id =
    opciones.soloAlias === true
      ? resolverAliasEstricto(ctx, valor, 'campaign_influencer')
      : resolverId(ctx, valor, 'campaign_influencer');
  if (!id.ok) return id;
  const r = await uc.obtenerCampaignInfluencer(ctx.actor, id.value);
  if (!r.ok || r.value.campaignInfluencer.campaignId !== ctx.run.campaignId)
    return err(RECURSO_NO_ENCONTRADO);
  return r;
}

/**
 * Entregable de LA campaña del run por alias `E…`. Dos capas de cerco: el caso de uso filtra por campaña
 * (`alcance`) y aquí se vuelve a comprobar, de modo que un registro contaminado sigue verificándose.
 */
export async function entregableDeCampana(
  ctx: ToolCtx,
  valor: unknown,
): Promise<Result<uc.EntregableDeCuenta>> {
  const id = resolverAliasEstricto(ctx, valor, 'deliverable');
  if (!id.ok) return id;
  const r = await uc.obtenerEntregable(ctx.actor, id.value, { alcance: { campaignId: ctx.run.campaignId } });
  if (!r.ok || r.value.projection !== 'cuenta' || r.value.deliverable.campaignId !== ctx.run.campaignId) {
    return err(RECURSO_NO_ENCONTRADO);
  }
  return ok(r.value);
}

/** Versión de guion de LA campaña del run por alias `V…` (misma doble capa de cerco). */
export async function versionDeGuionDeCampana(
  ctx: ToolCtx,
  valor: unknown,
): Promise<Result<uc.VersionDeGuionDetalle>> {
  const id = resolverAliasEstricto(ctx, valor, 'script_version');
  if (!id.ok) return id;
  const r = await uc.obtenerVersionDeGuion(ctx.actor, id.value, {
    alcance: { campaignId: ctx.run.campaignId },
  });
  if (!r.ok || r.value.campaignId !== ctx.run.campaignId) return err(RECURSO_NO_ENCONTRADO);
  return ok(r.value);
}

/**
 * Nombres de archivo que SÍ pueden verse. La política de lectura para IA (QA-04) oculta el nombre de una fuente
 * restringida (sensible) o de estado desconocido, aunque la versión de guion ya exista: la fuente pudo volverse
 * sensible después de registrarse. Una fuente que el actor no ve tampoco tiene nombre. Una sola lectura de las
 * fuentes de la campaña (con el alcance de la persona); si falla, ningún nombre se muestra.
 */
export async function nombresDeFuentesVisibles(
  ctx: ToolCtx,
  sourceIds: readonly string[],
): Promise<ReadonlyMap<string, string>> {
  const salida = new Map<string, string>();
  const r = await uc.listSources(ctx.actor, ctx.run.campaignId);
  if (!r.ok) return salida;
  const pedidos = new Set(sourceIds);
  for (const f of r.value) {
    if (!pedidos.has(f.id)) continue;
    const p = uc.preparacionDeFuente(f);
    if (p === 'restricted' || p === 'unknown') continue;
    salida.set(f.id, f.filename);
  }
  return salida;
}
