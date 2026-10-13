/**
 * Sincronización de fuentes enlazadas y lectura de snapshots (V2 · Fase 5).
 *
 * LinkedSource ≠ fetch remoto genérico. Este módulo NO hace red: solo (a) pide la
 * sincronización —encola un job `google_sheet_sync`, que únicamente la base
 * admite para fuentes `google_sheets`— y (b) lee lo que el worker dejó guardado.
 * La lectura de Google, con credenciales de solo lectura, vive en
 * `services/ai-worker/app/google_sheets.py`.
 *
 *  · Solo una PERSONA pide una sincronización (`initiated_by`): el worker lee
 *    Google, pero no finge ser quien decidió importar. Una sincronización
 *    programada y autónoma necesitaría una decisión explícita de actor de
 *    servicio; no se resuelve aquí.
 *  · Como máximo UNA sincronización activa por fuente (índice parcial en la base).
 *  · Snapshots, filas y fragmentos son inmutables; esta capa solo los lee.
 *  · Los snapshots y las ejecuciones son material INTERNO de SmartPR
 *    (`source:read`): el cliente nunca los ve, ni siquiera de una campaña visible.
 */

import type pg from 'pg';
import {
  type Result,
  type SnapshotGrid,
  type SnapshotSheet,
  type SyncRunStatus,
  type User,
  authorizeInternalResource,
  err,
  isSyncableProvider,
  ok,
} from '@tcl-kol-os/domain';
import { recordAudit } from './audit.ts';
import { getPool } from './client.ts';
import { type ContextoDeAuditoria, NO_ENCONTRADO, auditoriaDe, exigirPersona } from './influencers.ts';
import { Abortar, transaccionConResultado } from './tx-result.ts';

/** Una sincronización activa sin avanzar más de esto se considera abandonada. */
const MINUTOS_PARA_ABANDONAR = 30;

// ─────────────────────────── Tipos ─────────────────────────────────────────────

export interface SyncRun {
  readonly id: string;
  readonly sourceId: string;
  readonly status: SyncRunStatus;
  readonly initiatedBy: string;
  readonly snapshotId: string | undefined;
  readonly errorCode: string | undefined;
  readonly errorMessage: string | undefined;
  readonly requestedAt: string;
  readonly startedAt: string | undefined;
  readonly finishedAt: string | undefined;
}

export interface SyncRequested {
  readonly runId: string;
  readonly jobId: string;
  readonly status: 'queued';
}

// ─────────────────────────── Filas ─────────────────────────────────────────────

interface SyncRunRow {
  readonly id: string;
  readonly source_id: string;
  readonly status: SyncRunStatus;
  readonly initiated_by: string;
  readonly snapshot_id: string | null;
  readonly error_code: string | null;
  readonly error_message: string | null;
  readonly requested_at: Date;
  readonly started_at: Date | null;
  readonly finished_at: Date | null;
}

const SELECT_RUN = `
  SELECT id, source_id, status, initiated_by, snapshot_id, error_code, error_message,
         requested_at, started_at, finished_at
    FROM source_sync_runs
`;

function comoEjecucion(r: SyncRunRow): SyncRun {
  return {
    id: r.id,
    sourceId: r.source_id,
    status: r.status,
    initiatedBy: r.initiated_by,
    snapshotId: r.snapshot_id ?? undefined,
    errorCode: r.error_code ?? undefined,
    errorMessage: r.error_message ?? undefined,
    requestedAt: r.requested_at.toISOString(),
    startedAt: r.started_at?.toISOString(),
    finishedAt: r.finished_at?.toISOString(),
  };
}

// ─────────────────────────── Solicitud de sincronización ───────────────────────

const SYNC_EN_CURSO = {
  code: 'RESOURCE_CONFLICT',
  message: 'Ya hay una sincronización en curso para esta fuente.',
  details: { reason: 'sync_in_progress' },
} as const;

/**
 * Pide la sincronización de un Google Sheet registrado. No lee Google: encola un
 * job que ejecuta el worker con la cuenta de servicio de solo lectura.
 *
 * El resultado (snapshot nuevo, sin cambios o fallo) se consulta con
 * `getSyncRun`. Una campaña archivada o cancelada SÍ puede sincronizarse (leer
 * y conservar snapshots es inocuo); lo que no admite es materializar influencers
 * o productos a partir de ellos (ver `influencer-import.ts`).
 */
export async function syncGoogleSheetSource(
  actor: User,
  sourceId: string,
  contexto?: ContextoDeAuditoria,
): Promise<Result<SyncRequested>> {
  const persona = exigirPersona(actor, contexto);
  if (!persona.ok) return persona;

  return transaccionConResultado(async (client) => {
    // Bloquea la fuente: dos solicitudes simultáneas se serializan aquí.
    const { rows } = await client.query<{
      organization_id: string;
      campaign_id: string;
      origin: string;
      external_provider: string | null;
      external_id: string | null;
    }>(
      `SELECT organization_id, campaign_id, origin::text AS origin, external_provider, external_id
         FROM source_documents WHERE id = $1 FOR UPDATE`,
      [sourceId],
    );
    const fuente = rows[0];
    if (fuente === undefined) throw new Abortar(NO_ENCONTRADO);
    const permitido = authorizeInternalResource(actor, 'source:process', fuente.organization_id);
    if (!permitido.ok) throw new Abortar(permitido.error);

    if (
      fuente.origin !== 'link' ||
      !isSyncableProvider(fuente.external_provider) ||
      fuente.external_id === null
    ) {
      throw new Abortar({
        code: 'VALIDATION_FAILED',
        message: 'Esta fuente no admite sincronización: solo los enlaces de Google Sheets.',
        details: { reason: 'source_not_syncable' },
      });
    }

    // Una ejecución activa que no avanza hace más de 30 min se da por abandonada
    // (worker caído a mitad): se cierra como fallida para no bloquear la fuente.
    await client.query(
      `UPDATE processing_jobs j SET status = 'fallido', finished_at = now(),
              error = 'La sincronización quedó sin completarse y se dio por abandonada.'
        WHERE j.source_id = $1 AND j.kind = 'google_sheet_sync' AND j.status IN ('pendiente', 'ejecutando')
          AND COALESCE(j.started_at, j.created_at) < now() - make_interval(mins => $2)`,
      [sourceId, MINUTOS_PARA_ABANDONAR],
    );
    await client.query(
      `UPDATE source_sync_runs SET status = 'failed', error_code = 'SYNC_ABANDONED',
              error_message = 'La sincronización quedó sin completarse y se dio por abandonada.',
              finished_at = now()
        WHERE source_id = $1 AND status IN ('queued', 'running')
          AND job_id IN (SELECT id FROM processing_jobs WHERE source_id = $1 AND status = 'fallido')`,
      [sourceId],
    );

    const { rows: activas } = await client.query<{ id: string }>(
      `SELECT id FROM source_sync_runs WHERE source_id = $1 AND status IN ('queued', 'running')`,
      [sourceId],
    );
    if (activas[0] !== undefined) {
      throw new Abortar({ ...SYNC_EN_CURSO, details: { reason: 'sync_in_progress', runId: activas[0].id } });
    }

    const { rows: jobs } = await client.query<{ id: string }>(
      `INSERT INTO processing_jobs (source_id, kind) VALUES ($1, 'google_sheet_sync') RETURNING id`,
      [sourceId],
    );
    const jobId = jobs[0]!.id;
    const { rows: runs } = await client.query<{ id: string }>(
      `INSERT INTO source_sync_runs (organization_id, source_id, job_id, initiated_by, correlation)
       VALUES ($1, $2, $3, $4, $5::jsonb)
       RETURNING id`,
      [
        fuente.organization_id,
        sourceId,
        jobId,
        actor.id,
        contexto?.correlation === undefined ? null : JSON.stringify(contexto.correlation),
      ],
    );
    const runId = runs[0]!.id;

    await recordAudit(
      client,
      auditoriaDe(actor, contexto, {
        action: 'source.sync_request',
        entityType: 'source_document',
        entityId: sourceId,
        metadata: {
          campaignId: fuente.campaign_id,
          provider: fuente.external_provider,
          externalId: fuente.external_id,
          runId,
          jobId,
        },
      }),
    );
    return { runId, jobId, status: 'queued' as const };
  }, SYNC_EN_CURSO);
}

// ─────────────────────────── Lecturas ──────────────────────────────────────────

async function organizacionDeFuente(
  db: pg.Pool | pg.PoolClient,
  sourceId: string,
): Promise<string | undefined> {
  const { rows } = await db.query<{ organization_id: string }>(
    `SELECT organization_id FROM source_documents WHERE id = $1`,
    [sourceId],
  );
  return rows[0]?.organization_id;
}

/** Autoriza la lectura INTERNA de una fuente (no hay vista para el cliente). */
async function autorizarLecturaInterna(actor: User, sourceId: string): Promise<Result<true>> {
  const organizacion = await organizacionDeFuente(getPool(), sourceId);
  if (organizacion === undefined) return err(NO_ENCONTRADO);
  return authorizeInternalResource(actor, 'source:read', organizacion);
}

export async function getSyncRun(actor: User, runId: string): Promise<Result<SyncRun>> {
  const { rows } = await getPool().query<SyncRunRow>(`${SELECT_RUN} WHERE id = $1`, [runId]);
  const fila = rows[0];
  if (fila === undefined) return err(NO_ENCONTRADO);
  const permitido = await autorizarLecturaInterna(actor, fila.source_id);
  if (!permitido.ok) return permitido;
  return ok(comoEjecucion(fila));
}

export async function listSyncRuns(actor: User, sourceId: string, limite = 20): Promise<Result<SyncRun[]>> {
  const permitido = await autorizarLecturaInterna(actor, sourceId);
  if (!permitido.ok) return permitido;
  const { rows } = await getPool().query<SyncRunRow>(
    `${SELECT_RUN} WHERE source_id = $1 ORDER BY requested_at DESC LIMIT $2`,
    [sourceId, Math.min(Math.max(Math.trunc(limite), 1), 100)],
  );
  return ok(rows.map(comoEjecucion));
}

/**
 * La rejilla de un snapshot (hoja → fila → celdas), reconstruida desde
 * `source_snapshot_rows`. Es la entrada de la validación de esquema: no depende
 * del texto de los fragmentos.
 */
export async function cargarRejillaDeSnapshot(
  db: pg.Pool | pg.PoolClient,
  snapshotId: string,
): Promise<SnapshotGrid> {
  const { rows: estructura } = await db.query<{ structure: { sheets?: { name: string; state?: string }[] } }>(
    `SELECT structure FROM source_snapshots WHERE id = $1`,
    [snapshotId],
  );
  const estados = new Map<string, 'visible' | 'hidden'>();
  for (const hoja of estructura[0]?.structure.sheets ?? []) {
    estados.set(hoja.name, hoja.state === 'visible' ? 'visible' : 'hidden');
  }

  const { rows } = await db.query<{
    sheet: string;
    sheet_gid: string | null;
    row_number: number;
    cells: { col: number; text: string; type: string }[];
  }>(
    `SELECT sheet, sheet_gid::text AS sheet_gid, row_number, cells
       FROM source_snapshot_rows WHERE snapshot_id = $1 ORDER BY sheet, row_number`,
    [snapshotId],
  );

  const hojas = new Map<
    string,
    { gid: number | undefined; rows: { row: number; cells: (typeof rows)[number]['cells'] }[] }
  >();
  for (const r of rows) {
    let hoja = hojas.get(r.sheet);
    if (hoja === undefined) {
      hoja = { gid: r.sheet_gid === null ? undefined : Number(r.sheet_gid), rows: [] };
      hojas.set(r.sheet, hoja);
    }
    hoja.rows.push({ row: r.row_number, cells: r.cells });
  }
  const sheets: SnapshotSheet[] = [...hojas.entries()].map(([name, h]) => ({
    name,
    gid: h.gid,
    state: estados.get(name) ?? 'visible',
    rows: h.rows,
  }));
  return { sheets };
}
