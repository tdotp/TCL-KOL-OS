/**
 * Registro de tools · flujo del Google Sheet con el worker REAL y Google simulado:
 * registrar enlace → sincronizar → validar → plan → (propuestas HITL). Aplicar y resolver
 * NO ocurren: el agente solo deja propuestas pendientes.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePool, query } from '@tcl-kol-os/db';
import {
  type EscenarioDeChat,
  crearEscenarioDeChat,
  eliminarCampanaDePrueba,
} from '@tcl-kol-os/db/test-utils';
import type { ToolExecution } from '../contracts.ts';
import { abrirTurno, auditoriaDe, json, llamar, registro } from './test-support.ts';

// Utilidades de prueba del paquete db (no exportadas): se cargan por ruta, fuera del rootDir de tsc.
const RUTA_DB = '../../../db/src';
interface GoogleSimuladoLike {
  readonly entorno: Record<string, string>;
  publicar(id: string, pestanas: readonly unknown[]): Promise<void>;
  limpiar(): Promise<void>;
}
const googleUtils = (await import(`${RUTA_DB}/google-test-utils.ts`)) as {
  GoogleSimulado: { crear(): Promise<GoogleSimuladoLike> };
  pestanaDeInfluencers(filas: readonly (readonly string[])[]): unknown;
};
const workerUtils = (await import(`${RUTA_DB}/worker-test-utils.ts`)) as {
  hayWorkerLocal(): boolean;
  procesarColaConWorker(entorno: Record<string, string>): Promise<unknown>;
};
const { GoogleSimulado, pestanaDeInfluencers } = googleUtils;
const { hayWorkerLocal, procesarColaConWorker } = workerUtils;
const hayWorker = hayWorkerLocal();
const r = registro();
let e: EscenarioDeChat;
let google: GoogleSimuladoLike;
const sufijo = Date.now().toString(36);
const LIBRO = `1Tls${sufijo}${'w'.repeat(40)}`.slice(0, 44);
const URL = `https://docs.google.com/spreadsheets/d/${LIBRO}/edit#gid=11`;
const codigo = (x: ToolExecution) => x.errorCode;

beforeAll(async () => {
  e = await crearEscenarioDeChat('Tools W2A sheets');
  google = await GoogleSimulado.crear();
});

afterAll(async () => {
  await eliminarCampanaDePrueba(e.campanas);
  await google.limpiar();
  await closePool();
});

describe.skipIf(!hayWorker)('flujo del Sheet de influencers', () => {
  it('registrar → sincronizar → validar → plan → proponer; nada se aplica sin la persona', async () => {
    await google.publicar(LIBRO, [
      pestanaDeInfluencers([
        ['INF-001', `Valentina ${sufijo}`, 'instagram', `@vale${sufijo}`, ''],
        ['INF-002', `Camilo ${sufijo}`, 'tiktok', `@cami${sufijo}`, ''],
      ]),
    ]);
    const t = await abrirTurno(
      e.consultor,
      e.campanaId,
      `Aquí está el Sheet de influencers: ${URL} . Regístralo, sincronízalo, prepara el plan y propón aplicarlo.`,
    );
    const reg = await llamar(r, t, 'source_register_link', { url: URL, title: 'Influencers' });
    expect(reg.status).toBe('succeeded');
    const alias = json(reg)['source'] as string;
    expect(alias).toMatch(/^S\d+$/);

    // sincronización: auditada con origin chat y correlación guardada en el run
    const sync = await llamar(r, t, 'sheet_sync', { sourceId: alias, evidenceQuote: 'sincronízalo' });
    expect(sync.status).toBe('succeeded');
    const syncRunId = json(sync)['syncRunId'] as string;
    const [sr] = await query<{ correlation: Record<string, string> | null }>(
      `SELECT correlation FROM source_sync_runs WHERE id = $1`,
      [syncRunId],
    );
    expect(sr!.correlation).toMatchObject({ agentRunId: t.runId, toolInvocationId: sync.invocationId });
    const [fuente] = await query<{ id: string }>(
      `SELECT id FROM source_documents WHERE campaign_id = $1 AND origin = 'link'`,
      [e.campanaId],
    );
    const evSync = (await auditoriaDe(fuente!.id)).find((a) => a.action === 'source.sync_request');
    expect(evSync).toMatchObject({ origin: 'chat' });
    // una segunda solicitud mientras sigue en cola devuelve la misma ejecución (informativo)
    const otra = await llamar(r, t, 'sheet_sync', { sourceId: alias, evidenceQuote: 'sincronízalo' });
    expect(otra.status).toBe('succeeded');
    expect(json(otra)).toMatchObject({ inProgress: true, syncRunId });

    await procesarColaConWorker(google.entorno);
    const run = await llamar(r, t, 'sheet_get_sync_run', { runId: syncRunId });
    expect(json(run)['status']).toBe('completed');
    const snapshotId = json(run)['snapshotId'] as string;
    expect(snapshotId).toMatch(/^[0-9a-f-]{36}$/);

    // un run de sync de OTRA campaña (aunque sea de la misma org) no se ve desde esta
    const tB = await abrirTurno(e.consultor, e.otraCampanaId, 'estado de la sync');
    expect(codigo(await llamar(r, tB, 'sheet_get_sync_run', { runId: syncRunId }))).toBe(
      'RESOURCE_NOT_FOUND',
    );
    expect(
      codigo(await llamar(r, tB, 'sheet_get_sync_run', { runId: '00000000-0000-4000-8000-000000000000' })),
    ).toBe('RESOURCE_NOT_FOUND');

    const val = await llamar(r, t, 'sheet_validate', { sourceId: alias });
    expect(json(val)).toMatchObject({ status: 'valid', records: 2 });

    const plan = await llamar(r, t, 'sheet_prepare_import_plan', {
      sourceId: alias,
      evidenceQuote: 'prepara el plan',
    });
    expect(plan.status).toBe('succeeded');
    const aliasPlan = json(plan)['plan'] as string;
    expect(aliasPlan).toMatch(/^L\d+$/);

    const detalle = await llamar(r, t, 'sheet_get_import_plan', { planId: aliasPlan });
    expect(Buffer.byteLength(detalle.content)).toBeLessThanOrEqual(16_384);
    const d = json(detalle);
    expect(d['records']).toHaveLength(2);
    const recordId = (d['records'] as { recordId: string }[])[0]!.recordId;
    // el contenido del Sheet va en un sobre no confiable
    expect(d['untrusted']).toContain('<<<NC:');
    expect(detalle.content).not.toContain('external_url');

    // el plan y sus registros son de la campaña A: la B no los ve
    const [planFila] = await query<{ id: string }>(
      `SELECT id FROM influencer_import_plans WHERE campaign_id = $1`,
      [e.campanaId],
    );
    expect(codigo(await llamar(r, tB, 'sheet_get_import_plan', { planId: planFila!.id }))).toBe(
      'RESOURCE_NOT_FOUND',
    );
    expect(
      codigo(
        await llamar(r, tB, 'sheet_propose_apply', {
          planId: planFila!.id,
          evidenceQuote: 'estado de la sync',
        }),
      ),
    ).toBe('RESOURCE_NOT_FOUND');

    // PROPONER aplicar: pending, origin chat, y NO se crea ningún influencer
    const antesInf = Number(
      (
        await query<{ n: string }>(
          `SELECT count(*)::text AS n FROM campaign_influencers WHERE campaign_id = $1`,
          [e.campanaId],
        )
      )[0]!.n,
    );
    const prop = await llamar(r, t, 'sheet_propose_apply', {
      planId: aliasPlan,
      evidenceQuote: 'propón aplicarlo',
    });
    if (prop.status !== 'succeeded') throw new Error(prop.content);
    expect(prop.proposedActionId).toBeDefined();
    expect(json(prop)).toMatchObject({
      status: 'pending',
      type: 'influencer_import.apply',
      requiresHumanConfirmation: true,
    });
    const [pa] = await query<{ status: string; proposed_origin: string; executed_at: Date | null }>(
      `SELECT status, proposed_origin, executed_at FROM proposed_actions WHERE id = $1`,
      [prop.proposedActionId],
    );
    expect(pa).toMatchObject({ status: 'pending', proposed_origin: 'chat', executed_at: null });
    expect(
      Number(
        (
          await query<{ n: string }>(
            `SELECT count(*)::text AS n FROM campaign_influencers WHERE campaign_id = $1`,
            [e.campanaId],
          )
        )[0]!.n,
      ),
    ).toBe(antesInf);
    const evProp = (await auditoriaDe(prop.proposedActionId!)).find(
      (a) => a.action === 'proposed_action.propose',
    );
    expect(evProp!.correlation).toMatchObject({ toolInvocationId: prop.invocationId, agentRunId: t.runId });

    // PROPONER resolver un registro (ignorarlo): pending, sin resolución escrita
    const res = await llamar(r, t, 'sheet_propose_resolution', {
      planId: aliasPlan,
      recordId,
      decision: { kind: 'ignore_record', reason: 'La persona dijo que no va' },
      evidenceQuote: 'propón aplicarlo',
    });
    if (res.status !== 'succeeded') throw new Error(res.content);
    expect(json(res)).toMatchObject({ status: 'pending', type: 'influencer_import.resolve_record' });
    expect(
      Number(
        (
          await query<{ n: string }>(
            `SELECT count(*)::text AS n FROM influencer_import_resolutions WHERE record_id = $1`,
            [recordId],
          )
        )[0]!.n,
      ),
    ).toBe(0);

    // el registro de OTRO plan/campaña o un id inventado no se acepta
    expect(
      codigo(
        await llamar(r, t, 'sheet_propose_resolution', {
          planId: aliasPlan,
          recordId: '00000000-0000-4000-8000-000000000000',
          decision: { kind: 'ignore_record' },
          evidenceQuote: 'propón aplicarlo',
        }),
      ),
    ).toBe('RESOURCE_NOT_FOUND');
    // una decisión con claves que su tipo no admite la rechaza el handler (db), no la tool
    const mala = await llamar(r, t, 'sheet_propose_resolution', {
      planId: aliasPlan,
      recordId,
      decision: { kind: 'ignore_record', influencerId: '00000000-0000-4000-8000-000000000000' },
      evidenceQuote: 'propón aplicarlo',
    });
    expect(mala.status).toBe('failed');
    // y las tools que sí aplicarían o resolverían no existen
    for (const n of ['sheet_apply', 'sheet_resolve_record', 'applyInfluencerImport', 'resolveImportRecord']) {
      expect(codigo(await llamar(r, t, n, { planId: aliasPlan }))).toBe('AGENT_INVALID_TOOL_CALL');
    }
  });
});
