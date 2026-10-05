/**
 * Fixture de QA: un plan de importación de influencers real (worker Python + Google simulado),
 * armado con las MISMAS tools del agente (registrar enlace → sync → plan). Solo pruebas.
 */
import { query } from '@tcl-kol-os/db';
import type { User } from '@tcl-kol-os/domain';
import { abrirTurno, json, llamar, registro, type Turno } from './harness.ts';

const RUTA_DB = '../../../../db/src';
export interface GoogleSimuladoLike {
  readonly entorno: Record<string, string>;
  publicar(id: string, pestanas: readonly unknown[]): Promise<void>;
  limpiar(): Promise<void>;
}
const googleUtils = (await import(`${RUTA_DB}/google-test-utils.ts`)) as {
  GoogleSimulado: { crear(): Promise<GoogleSimuladoLike> };
  pestanaDeInfluencers(filas: readonly (readonly string[])[], opciones?: Record<string, unknown>): unknown;
};
const workerUtils = (await import(`${RUTA_DB}/worker-test-utils.ts`)) as {
  hayWorkerLocal(): boolean;
  procesarColaConWorker(entorno: Record<string, string>): Promise<unknown>;
};

export const { GoogleSimulado, pestanaDeInfluencers } = googleUtils;
export const { hayWorkerLocal, procesarColaConWorker } = workerUtils;

export interface PlanDePrueba {
  readonly turno: Turno;
  readonly sourceId: string;
  readonly sourceAlias: string;
  readonly planId: string;
  readonly planAlias: string;
  readonly recordIds: readonly string[];
}

let contador = 0;

/** Registra un Sheet, lo sincroniza, prepara el plan y devuelve ids. */
export async function prepararPlan(
  google: GoogleSimuladoLike,
  actor: User,
  campaignId: string,
  filas: readonly (readonly string[])[],
): Promise<PlanDePrueba> {
  const r = registro();
  contador += 1;
  const libro = `1Qa${Date.now().toString(36)}${contador}${'q'.repeat(44)}`.slice(0, 44);
  const url = `https://docs.google.com/spreadsheets/d/${libro}/edit#gid=${100 + contador}`;
  await google.publicar(libro, [pestanaDeInfluencers(filas, { gid: 100 + contador })]);
  const t = await abrirTurno(
    actor,
    campaignId,
    `Aquí está el Sheet: ${url} . Regístralo, sincronízalo, prepara el plan y propón aplicarlo. Resuelve el registro.`,
  );
  const reg = await llamar(r, t, 'source_register_link', { url, title: 'Sheet QA' });
  if (reg.status !== 'succeeded') throw new Error(`registro: ${reg.content}`);
  const alias = json(reg)['source'] as string;
  const sync = await llamar(r, t, 'sheet_sync', { sourceId: alias, evidenceQuote: 'sincronízalo' });
  if (sync.status !== 'succeeded') throw new Error(`sync: ${sync.content}`);
  await procesarColaConWorker(google.entorno);
  const plan = await llamar(r, t, 'sheet_prepare_import_plan', {
    sourceId: alias,
    evidenceQuote: 'prepara el plan',
  });
  if (plan.status !== 'succeeded') throw new Error(`plan: ${plan.content}`);
  const planAlias = json(plan)['plan'] as string;
  const [fuente] = await query<{ id: string }>(
    `SELECT id FROM source_documents WHERE campaign_id = $1 AND canonical_url LIKE $2`,
    [campaignId, `%${libro}%`],
  );
  const [pf] = await query<{ id: string }>(
    `SELECT id FROM influencer_import_plans WHERE campaign_id = $1 AND source_id = $2 ORDER BY created_at DESC LIMIT 1`,
    [campaignId, fuente!.id],
  );
  const regs = await query<{ id: string }>(
    `SELECT id FROM influencer_import_records WHERE plan_id = $1 ORDER BY source_key`,
    [pf!.id],
  );
  return {
    turno: t,
    sourceId: fuente!.id,
    sourceAlias: alias,
    planId: pf!.id,
    planAlias,
    recordIds: regs.map((x) => x.id),
  };
}
