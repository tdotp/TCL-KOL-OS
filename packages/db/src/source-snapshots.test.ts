/**
 * V2 · Fase 5 — snapshots de fuentes enlazadas y sincronización controlada.
 *
 * Tres bloques:
 *   1. La base impone las invariantes (inmutabilidad, vigente atómico, tenant,
 *      tipo de job): se prueban con SQL directo, sin worker.
 *   2. La solicitud de sincronización (permisos, concurrencia, fuentes admitidas).
 *   3. De punta a punta con el WORKER REAL y un Google simulado (sin red): primer
 *      snapshot, sin cambios, cambio, fallos, reintentos, evidencia histórica.
 *
 * Datos sintéticos, campañas propias y desechables. Sin entorno de Python del
 * worker, el bloque 3 se omite con un aviso explícito (nunca en silencio).
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Result, User } from '@tcl-kol-os/domain';
import { closePool, query } from './client.ts';
import { asegurarUsuarioDePrueba, eliminarCampanaDePrueba } from './test-utils.ts';
import { findUserByEmail } from './users.ts';
import { crearBriefManual } from './manual.ts';
import {
  registerLinkedSource,
  uploadSource,
  getFragments,
  listSources,
  obtenerRepresentacionNormalizada,
} from './sources.ts';
import { buscarTextoEnFuentes } from './search.ts';
import {
  getSourceSnapshot,
  getSnapshotFragments,
  getSyncRun,
  listSourceSnapshots,
  listSyncRuns,
  syncGoogleSheetSource,
} from './source-sync.ts';
import { GoogleSimulado, type PestanaDePrueba } from './google-test-utils.ts';
import { hayWorkerLocal, procesarColaConWorker } from './worker-test-utils.ts';

const sufijo = Date.now().toString(36);
const ID = (n: number) => `1Snap${sufijo}${String(n).padStart(3, '0')}${'x'.repeat(30)}`.slice(0, 44);
const SHEET = (n: number, gid?: number) =>
  `https://docs.google.com/spreadsheets/d/${ID(n)}/edit${gid === undefined ? '' : `#gid=${gid}`}`;

let admin: User;
let consultor: User;
let operativo: User;
let cliente: User;
let ajeno: User;
let campanaId: string;
let campanaAjenaId: string;
let campoId: string;
const campanas: string[] = [];
let hayWorker = false;
let google: GoogleSimulado;
let contador = 100;

function valor<T>(r: Result<T>): T {
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
  return r.value;
}
type Resultado = { readonly ok: true } | { readonly ok: false; readonly error: { readonly code: string } };
const codigo = (r: Resultado) => (r.ok ? undefined : r.error.code);

/** Pestaña de ejemplo con una sola persona (el contenido exacto da igual aquí). */
function pestanaCon(texto: string, gid = 11): PestanaDePrueba {
  return {
    nombre: 'Datos',
    gid,
    filas: [
      ['Nombre', 'Nota'],
      [texto, 'x'],
    ],
  };
}

/** Registra un Google Sheet en la campaña y devuelve su id de fuente y el del libro. */
async function nuevaFuente(owner: User = admin, campaign = campanaId, gid?: number) {
  const n = contador++;
  const r = valor(await registerLinkedSource(owner, { campaignId: campaign, url: SHEET(n, gid) }));
  return { sourceId: r.id, libroId: ID(n) };
}

/** Pide la sincronización y deja que el worker real la procese. */
async function sincronizar(sourceId: string, entorno: Record<string, string> = google.entorno) {
  const pedido = valor(await syncGoogleSheetSource(admin, sourceId));
  const salida = await procesarColaConWorker(entorno);
  const run = valor(await getSyncRun(admin, pedido.runId));
  return { pedido, run, salida };
}

async function auditoria(entityId: string) {
  return query<{
    action: string;
    origin: string | null;
    actor_id: string | null;
    metadata: Record<string, unknown>;
  }>(
    `SELECT action, origin, actor_id, metadata FROM audit_events WHERE entity_id = $1 ORDER BY created_at, id`,
    [entityId],
  );
}

beforeAll(async () => {
  admin = (await findUserByEmail('gerardo@smartpr.co'))!;
  consultor = (await findUserByEmail('consultor@smartpr.co'))!;
  cliente = (await findUserByEmail('marena@tcl.com'))!;
  ajeno = (await findUserByEmail('ajeno@otraagencia.co'))!;
  operativo = await asegurarUsuarioDePrueba(
    'operativo@smartpr.co',
    'Usuario Operativo',
    'operativo',
    admin.organizationId,
  );
  hayWorker = hayWorkerLocal();
  if (!hayWorker) {
    console.warn(
      'No hay entorno de Python del worker (services/ai-worker/.venv); se omiten las pruebas con worker real. ' +
        'Créelo con: cd services/ai-worker && python3 -m venv .venv && .venv/bin/pip install -r requirements.txt',
    );
  }
  google = await GoogleSimulado.crear();

  for (const [owner, nombre] of [
    [admin, 'Snapshots'],
    [ajeno, 'Snapshots ajena'],
  ] as const) {
    const [c] = await query<{ id: string }>(
      `INSERT INTO campaigns (organization_id, name, owner_id, created_by) VALUES ($1, $2, $3, $3) RETURNING id`,
      [owner.organizationId, `${nombre} · ${sufijo}`, owner.id],
    );
    campanas.push(c!.id);
    if (owner === admin) campanaId = c!.id;
    else campanaAjenaId = c!.id;
  }
  const brief = valor(await crearBriefManual(admin, campanaId));
  const [campo] = await query<{ id: string }>(
    `SELECT id FROM brief_fields WHERE brief_version_id = $1 AND campaign_product_id IS NULL ORDER BY key LIMIT 1`,
    [brief.versionId],
  );
  campoId = campo!.id;
});

afterAll(async () => {
  await eliminarCampanaDePrueba(campanas);
  await google.limpiar();
  await closePool();
});

// ─────────────────────────── 1. La base impone las invariantes ─────────────────

/** Inserta un snapshot completo a mano (fila, fragmento) para probar las restricciones. */
async function snapshotManual(
  sourceId: string,
  organizationId: string,
  sequence: number,
  conFragmento = true,
) {
  const [s] = await query<{ id: string }>(
    `INSERT INTO source_snapshots (source_id, organization_id, sequence, provider, fetched_at,
                                   content_hash, hash_version, structure, generator)
     VALUES ($1, $2, $3, 'google_sheets', now(), $4, 'grid-sha256/1', '{"sheets":[]}'::jsonb, 'prueba')
     RETURNING id`,
    [sourceId, organizationId, sequence, `${sequence}`.padStart(64, 'a')],
  );
  await query(
    `INSERT INTO source_snapshot_rows (snapshot_id, sheet, sheet_gid, row_number, cells)
     VALUES ($1, 'Datos', 1, 1, '[{"col":1,"text":"a","type":"texto"}]'::jsonb)`,
    [s!.id],
  );
  let fragmentoId: string | undefined;
  if (conFragmento) {
    const [f] = await query<{ id: string }>(
      `INSERT INTO source_fragments (source_id, snapshot_id, ordinal, section, text, locator)
       VALUES ($1, $2, 0, 'Datos', 'texto original', '{"kind":"range","sheet":"Datos","range":"A1:A1","rowStart":1,"rowEnd":1,"colStart":1,"colEnd":1}'::jsonb)
       RETURNING id`,
      [sourceId, s!.id],
    );
    fragmentoId = f!.id;
  }
  return { snapshotId: s!.id, fragmentoId };
}

describe('la base impone las invariantes de snapshot', () => {
  it('un snapshot, sus filas y sus fragmentos no se modifican ni se borran', async () => {
    const { sourceId } = await nuevaFuente();
    const { snapshotId, fragmentoId } = await snapshotManual(sourceId, admin.organizationId, 1);

    await expect(
      query(`UPDATE source_snapshots SET content_hash = $2 WHERE id = $1`, [snapshotId, 'b'.repeat(64)]),
    ).rejects.toThrow(/no se modifica/);
    await expect(query(`DELETE FROM source_snapshots WHERE id = $1`, [snapshotId])).rejects.toThrow(
      /no se borra/,
    );
    await expect(
      query(`UPDATE source_snapshot_rows SET cells = '[]'::jsonb WHERE snapshot_id = $1`, [snapshotId]),
    ).rejects.toThrow(/no se modifican/);
    await expect(
      query(`DELETE FROM source_snapshot_rows WHERE snapshot_id = $1`, [snapshotId]),
    ).rejects.toThrow(/no se borran/);
    await expect(
      query(`UPDATE source_fragments SET text = 'reescrito' WHERE id = $1`, [fragmentoId]),
    ).rejects.toThrow(/no se modifican/);
    await expect(
      query(`UPDATE source_fragments SET locator = NULL WHERE id = $1`, [fragmentoId]),
    ).rejects.toThrow();
    await expect(query(`DELETE FROM source_fragments WHERE id = $1`, [fragmentoId])).rejects.toThrow(
      /no se borran/,
    );
    // Y el contenido sigue intacto.
    const [f] = await query<{ text: string }>(`SELECT text FROM source_fragments WHERE id = $1`, [
      fragmentoId,
    ]);
    expect(f!.text).toBe('texto original');
  });

  it('lo único que puede cambiar en un fragmento de snapshot es su índice vectorial', async () => {
    const { sourceId } = await nuevaFuente();
    const { fragmentoId } = await snapshotManual(sourceId, admin.organizationId, 1);
    await query(
      `UPDATE source_fragments SET embedding = array_fill(0.01::real, ARRAY[1536])::vector WHERE id = $1`,
      [fragmentoId],
    );
    const [f] = await query<{ con: boolean }>(
      `SELECT embedding IS NOT NULL AS con FROM source_fragments WHERE id = $1`,
      [fragmentoId],
    );
    expect(f!.con).toBe(true);
  });

  it('el snapshot vigente cambia solo con fragmentos guardados y solo hacia adelante', async () => {
    const { sourceId } = await nuevaFuente();
    const vacio = await snapshotManual(sourceId, admin.organizationId, 1, false);
    // Sin fragmentos: la lectura no está completa → no puede ser el vigente.
    await expect(
      query(`UPDATE source_documents SET current_snapshot_id = $2 WHERE id = $1`, [
        sourceId,
        vacio.snapshotId,
      ]),
    ).rejects.toThrow(/no tiene fragmentos guardados/);

    const uno = await snapshotManual(sourceId, admin.organizationId, 2);
    await query(`UPDATE source_documents SET current_snapshot_id = $2, status = 'procesado' WHERE id = $1`, [
      sourceId,
      uno.snapshotId,
    ]);
    const dos = await snapshotManual(sourceId, admin.organizationId, 3);
    await query(`UPDATE source_documents SET current_snapshot_id = $2 WHERE id = $1`, [
      sourceId,
      dos.snapshotId,
    ]);

    // No se retrocede, no se repite, no se borra.
    await expect(
      query(`UPDATE source_documents SET current_snapshot_id = $2 WHERE id = $1`, [sourceId, uno.snapshotId]),
    ).rejects.toThrow(/solo avanza/);
    await expect(
      query(`UPDATE source_documents SET current_snapshot_id = NULL WHERE id = $1`, [sourceId]),
    ).rejects.toThrow(/no puede quedarse sin él/);
    const [vigente] = await query<{ current_snapshot_id: string }>(
      `SELECT current_snapshot_id FROM source_documents WHERE id = $1`,
      [sourceId],
    );
    expect(vigente!.current_snapshot_id).toBe(dos.snapshotId);
  });

  it('el snapshot vigente es de la MISMA fuente', async () => {
    const a = await nuevaFuente();
    const b = await nuevaFuente();
    const deB = await snapshotManual(b.sourceId, admin.organizationId, 1);
    await expect(
      query(`UPDATE source_documents SET current_snapshot_id = $2 WHERE id = $1`, [
        a.sourceId,
        deB.snapshotId,
      ]),
    ).rejects.toThrow(/source_documents_current_snapshot_fkey/);
  });

  it('un archivo no tiene snapshots y un enlace solo tiene fragmentos de snapshot', async () => {
    const enlace = await nuevaFuente();
    await expect(
      query(
        `INSERT INTO source_fragments (source_id, ordinal, section, text) VALUES ($1, 0, 'x', 'sin snapshot')`,
        [enlace.sourceId],
      ),
    ).rejects.toThrow(/pertenecen a un snapshot/);

    const archivo = valor(
      await uploadSource(admin, {
        campaignId: campanaId,
        filename: `nota-${sufijo}.md`,
        contenido: new TextEncoder().encode(`# Nota\n\ntexto ${sufijo}\n`),
      }),
    );
    const otroSnapshot = await snapshotManual(enlace.sourceId, admin.organizationId, 1);
    await expect(
      query(
        `INSERT INTO source_fragments (source_id, snapshot_id, ordinal, section, text) VALUES ($1, $2, 5, 'x', 'mal')`,
        [archivo.id, otroSnapshot.snapshotId],
      ),
    ).rejects.toThrow();
    await expect(
      query(`UPDATE source_documents SET current_snapshot_id = $2 WHERE id = $1`, [
        archivo.id,
        otroSnapshot.snapshotId,
      ]),
    ).rejects.toThrow();
  });

  it('aislamiento por organización también por SQL directo', async () => {
    const { sourceId } = await nuevaFuente();
    // Un snapshot declarado de OTRA organización que la de su fuente no existe.
    await expect(
      query(
        `INSERT INTO source_snapshots (source_id, organization_id, sequence, provider, fetched_at, content_hash, hash_version, structure, generator)
         VALUES ($1, $2, 1, 'google_sheets', now(), $3, 'grid-sha256/1', '{}'::jsonb, 'x')`,
        [sourceId, ajeno.organizationId, 'c'.repeat(64)],
      ),
    ).rejects.toThrow(/source_snapshots_source_fkey/);
    // La ejecución de sincronización tampoco puede cruzar organización.
    const [job] = await query<{ id: string }>(
      `INSERT INTO processing_jobs (source_id, kind) VALUES ($1, 'google_sheet_sync') RETURNING id`,
      [sourceId],
    );
    await expect(
      query(
        `INSERT INTO source_sync_runs (organization_id, source_id, job_id, initiated_by) VALUES ($1, $2, $3, $4)`,
        [ajeno.organizationId, sourceId, job!.id, ajeno.id],
      ),
    ).rejects.toThrow(/source_sync_runs_source_fkey/);
  });

  it('hash, secuencia y formas inválidas se rechazan', async () => {
    const { sourceId } = await nuevaFuente();
    const insertar = (secuencia: number, hash: string) =>
      query(
        `INSERT INTO source_snapshots (source_id, organization_id, sequence, provider, fetched_at, content_hash, hash_version, structure, generator)
         VALUES ($1, $2, $3, 'google_sheets', now(), $4, 'v', '{}'::jsonb, 'x')`,
        [sourceId, admin.organizationId, secuencia, hash],
      );
    await expect(insertar(1, 'no-es-hex')).rejects.toThrow(/source_snapshots_hash_valido/);
    await expect(insertar(0, 'd'.repeat(64))).rejects.toThrow(/source_snapshots_sequence_positiva/);
    await insertar(1, 'd'.repeat(64));
    await expect(insertar(1, 'e'.repeat(64))).rejects.toThrow(/source_snapshots_sequence_key/);
  });
});

describe('el tipo de job está acotado a lo que la integración autoriza', () => {
  it('un enlace NO soportado no puede crear ningún job remoto', async () => {
    const docs = valor(
      await registerLinkedSource(admin, {
        campaignId: campanaId,
        url: `https://docs.google.com/document/d/${ID(900)}/edit`,
      }),
    );
    const slides = valor(
      await registerLinkedSource(admin, {
        campaignId: campanaId,
        url: `https://docs.google.com/presentation/d/${ID(901)}/edit`,
      }),
    );
    for (const id of [docs.id, slides.id]) {
      for (const kind of ['google_sheet_sync', 'source_ingest_file']) {
        await expect(
          query(`INSERT INTO processing_jobs (source_id, kind) VALUES ($1, $2)`, [id, kind]),
        ).rejects.toThrow(/fuentes enlazadas/);
      }
      expect(await query(`SELECT 1 FROM processing_jobs WHERE source_id = $1`, [id])).toHaveLength(0);
      // Y la API tampoco lo ofrece.
      expect(codigo(await syncGoogleSheetSource(admin, id))).toBe('VALIDATION_FAILED');
    }
  });

  it('un Google Sheet admite SOLO el job de sincronización; un archivo SOLO la ingestión', async () => {
    const { sourceId } = await nuevaFuente();
    await expect(query(`INSERT INTO processing_jobs (source_id) VALUES ($1)`, [sourceId])).rejects.toThrow(
      /fuentes enlazadas/,
    );
    await expect(
      query(`INSERT INTO processing_jobs (source_id, kind) VALUES ($1, 'otro')`, [sourceId]),
    ).rejects.toThrow(/No hay procesamiento/);

    const archivo = valor(
      await uploadSource(admin, {
        campaignId: campanaId,
        filename: `archivo-${sufijo}.md`,
        contenido: new TextEncoder().encode(`# Otra\n\ntexto ${sufijo} ${contador}\n`),
      }),
    );
    await expect(
      query(`INSERT INTO processing_jobs (source_id, kind) VALUES ($1, 'google_sheet_sync')`, [archivo.id]),
    ).rejects.toThrow(/fuentes enlazadas/);
    expect(codigo(await syncGoogleSheetSource(admin, archivo.id))).toBe('VALIDATION_FAILED');
  });

  it('el tipo y la fuente de un job no se reasignan', async () => {
    const { sourceId } = await nuevaFuente();
    const [job] = await query<{ id: string }>(
      `INSERT INTO processing_jobs (source_id, kind) VALUES ($1, 'google_sheet_sync') RETURNING id`,
      [sourceId],
    );
    await expect(
      query(`UPDATE processing_jobs SET kind = 'source_ingest_file' WHERE id = $1`, [job!.id]),
    ).rejects.toThrow(/fuentes enlazadas/);
  });
});

describe('ejecuciones de sincronización', () => {
  it('una ejecución terminada no se reescribe y solo hay una activa por fuente', async () => {
    const { sourceId } = await nuevaFuente();
    const pedido = valor(await syncGoogleSheetSource(admin, sourceId));
    await expect(
      query(
        `INSERT INTO source_sync_runs (organization_id, source_id, job_id, initiated_by)
         SELECT $1, $2, j.id, $3 FROM (SELECT gen_random_uuid() AS x) q, processing_jobs j WHERE j.id = $4`,
        [admin.organizationId, sourceId, admin.id, pedido.jobId],
      ),
    ).rejects.toThrow(/source_sync_runs_job_key|duplicate key/);
    await query(
      `UPDATE source_sync_runs SET status = 'failed', error_code = 'X', finished_at = now() WHERE id = $1`,
      [pedido.runId],
    );
    await expect(
      query(
        `UPDATE source_sync_runs SET status = 'queued', error_code = NULL, finished_at = NULL WHERE id = $1`,
        [pedido.runId],
      ),
    ).rejects.toThrow(/ya terminó/);
    await expect(query(`DELETE FROM source_sync_runs WHERE id = $1`, [pedido.runId])).rejects.toThrow(
      /no se borra/,
    );
    await expect(
      query(`UPDATE source_sync_runs SET initiated_by = $2 WHERE id = $1`, [pedido.runId, consultor.id]),
    ).rejects.toThrow();
  });

  it('estado y resultado deben ser coherentes', async () => {
    const { sourceId } = await nuevaFuente();
    const pedido = valor(await syncGoogleSheetSource(admin, sourceId));
    await expect(
      query(`UPDATE source_sync_runs SET status = 'completed', finished_at = now() WHERE id = $1`, [
        pedido.runId,
      ]),
    ).rejects.toThrow(/source_sync_runs_resultado_coherente/);
    await expect(
      query(`UPDATE source_sync_runs SET status = 'failed', finished_at = now() WHERE id = $1`, [
        pedido.runId,
      ]),
    ).rejects.toThrow(/source_sync_runs_resultado_coherente/);
  });
});

// ─────────────────────────── 2. Solicitud de sincronización ────────────────────

describe('pedir una sincronización', () => {
  it('encola un job de sincronización, crea la ejecución y audita con origen y correlación', async () => {
    const { sourceId, libroId } = await nuevaFuente();
    const pedido = valor(
      await syncGoogleSheetSource(admin, sourceId, {
        correlation: { conversationId: 'conv-1', messageId: 'm-1' },
      }),
    );
    expect(pedido.status).toBe('queued');

    const [job] = await query<{ kind: string; status: string }>(
      `SELECT kind, status::text AS status FROM processing_jobs WHERE id = $1`,
      [pedido.jobId],
    );
    expect(job).toMatchObject({ kind: 'google_sheet_sync', status: 'pendiente' });
    const run = valor(await getSyncRun(admin, pedido.runId));
    expect(run).toMatchObject({ status: 'queued', initiatedBy: admin.id, sourceId });

    const evento = (await auditoria(sourceId)).find((e) => e.action === 'source.sync_request')!;
    expect(evento).toMatchObject({ origin: 'ui', actor_id: admin.id });
    expect(evento.metadata).toMatchObject({
      provider: 'google_sheets',
      externalId: libroId,
      runId: pedido.runId,
    });
    const [conCorrelacion] = await query<{ correlation: Record<string, string> }>(
      `SELECT correlation FROM audit_events WHERE entity_id = $1 AND action = 'source.sync_request'`,
      [sourceId],
    );
    expect(conCorrelacion!.correlation).toMatchObject({ conversationId: 'conv-1', messageId: 'm-1' });
    // Ninguna URL original ni secreto en la auditoría.
    expect(JSON.stringify(evento.metadata)).not.toMatch(/https?:|key|token/i);
  });

  it('permisos: SmartPR de cuenta puede; Operativo no; el cliente y otra agencia no ven la fuente', async () => {
    const { sourceId } = await nuevaFuente();
    expect(codigo(await syncGoogleSheetSource(operativo, sourceId))).toBe('FORBIDDEN_ROLE');
    expect(codigo(await syncGoogleSheetSource(cliente, sourceId))).toBe('RESOURCE_NOT_FOUND');
    expect(codigo(await syncGoogleSheetSource(ajeno, sourceId))).toBe('RESOURCE_NOT_FOUND');
    // 'system' nunca pide una sincronización: la pide una persona.
    expect(codigo(await syncGoogleSheetSource('system' as unknown as User, sourceId))).toBe('FORBIDDEN_ROLE');
    expect(await query(`SELECT 1 FROM processing_jobs WHERE source_id = $1`, [sourceId])).toHaveLength(0);
    valor(await syncGoogleSheetSource(consultor, sourceId));
  });

  it('una fuente inexistente o de otra organización responde igual', async () => {
    const ajena = await nuevaFuente(ajeno, campanaAjenaId);
    expect(codigo(await syncGoogleSheetSource(admin, ajena.sourceId))).toBe('RESOURCE_NOT_FOUND');
    expect(codigo(await syncGoogleSheetSource(admin, '00000000-0000-4000-8000-000000000000'))).toBe(
      'RESOURCE_NOT_FOUND',
    );
  });

  it('máximo una sincronización activa: la segunda solicitud falla y la concurrente se serializa', async () => {
    const { sourceId } = await nuevaFuente();
    const primera = valor(await syncGoogleSheetSource(admin, sourceId));
    const segunda = await syncGoogleSheetSource(admin, sourceId);
    expect(codigo(segunda)).toBe('RESOURCE_CONFLICT');
    if (!segunda.ok)
      expect(segunda.error.details).toMatchObject({ reason: 'sync_in_progress', runId: primera.runId });

    const otra = await nuevaFuente();
    const resultados = await Promise.all([
      syncGoogleSheetSource(admin, otra.sourceId),
      syncGoogleSheetSource(consultor, otra.sourceId),
      syncGoogleSheetSource(admin, otra.sourceId),
    ]);
    expect(resultados.filter((r) => r.ok)).toHaveLength(1);
    expect(resultados.filter((r) => !r.ok).every((r) => codigo(r) === 'RESOURCE_CONFLICT')).toBe(true);
    expect(await query(`SELECT 1 FROM source_sync_runs WHERE source_id = $1`, [otra.sourceId])).toHaveLength(
      1,
    );
  });

  it('una ejecución abandonada (worker caído) no bloquea la fuente para siempre', async () => {
    const { sourceId } = await nuevaFuente();
    const vieja = valor(await syncGoogleSheetSource(admin, sourceId));
    await query(
      `UPDATE processing_jobs SET status = 'ejecutando', started_at = now() - interval '2 hours' WHERE id = $1`,
      [vieja.jobId],
    );
    await query(
      `UPDATE source_sync_runs SET status = 'running', started_at = now() - interval '2 hours' WHERE id = $1`,
      [vieja.runId],
    );

    const nueva = valor(await syncGoogleSheetSource(admin, sourceId));
    expect(nueva.runId).not.toBe(vieja.runId);
    expect(valor(await getSyncRun(admin, vieja.runId))).toMatchObject({
      status: 'failed',
      errorCode: 'SYNC_ABANDONED',
    });
  });

  it('el historial de ejecuciones es interno', async () => {
    const { sourceId } = await nuevaFuente();
    valor(await syncGoogleSheetSource(admin, sourceId));
    expect(valor(await listSyncRuns(admin, sourceId))).toHaveLength(1);
    expect(valor(await listSyncRuns(operativo, sourceId))).toHaveLength(1);
    expect(codigo(await listSyncRuns(cliente, sourceId))).toBe('RESOURCE_NOT_FOUND');
    expect(codigo(await listSyncRuns(ajeno, sourceId))).toBe('RESOURCE_NOT_FOUND');
  });
});

// ─────────────────────────── 3. De punta a punta con el worker real ────────────

describe('sincronizar con el worker real (Google simulado)', () => {
  // Los bloques anteriores dejan jobs pendientes sin Google simulado: se cierran para
  // que cada pasada del worker procese solo lo que prueba cada caso.
  beforeAll(async () => {
    await query(
      `UPDATE source_sync_runs SET status = 'failed', error_code = 'TEST_CLEANUP', finished_at = now()
        WHERE status IN ('queued', 'running')
          AND source_id IN (SELECT id FROM source_documents WHERE campaign_id = ANY($1::uuid[]))`,
      [campanas],
    );
    await query(
      `UPDATE processing_jobs SET status = 'fallido', finished_at = now()
        WHERE status IN ('pendiente', 'ejecutando')
          AND source_id IN (SELECT id FROM source_documents WHERE campaign_id = ANY($1::uuid[]))`,
      [campanas],
    );
  });

  const si = (nombre: string, fn: () => Promise<void>) =>
    it(nombre, async () => (hayWorker ? fn() : undefined));

  si('la primera sincronización crea el snapshot 1, lo vuelve vigente y deja el rastro', async () => {
    const { sourceId, libroId } = await nuevaFuente(admin, campanaId, 11);
    await google.publicar(libroId, [pestanaCon('Valentina Rojas', 11)], 'Mi libro');
    const { run, salida } = await sincronizar(sourceId);
    expect(salida.codigo).toBe(0);
    expect(run.status).toBe('completed');

    const snapshots = valor(await listSourceSnapshots(admin, sourceId));
    expect(snapshots).toHaveLength(1);
    const [s1] = snapshots;
    expect(s1).toMatchObject({ sequence: 1, isCurrent: true, provider: 'google_sheets', rows: 2 });
    expect(s1!.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(s1!.fragments).toBeGreaterThan(0);
    expect(run.snapshotId).toBe(s1!.id);

    const detalle = valor(await getSourceSnapshot(admin, s1!.id));
    expect(detalle.structure).toMatchObject({ format: 'google_sheets', sheetCount: 1, title: 'Mi libro' });
    expect((detalle.structure['sheets'] as { gid: number }[])[0]!.gid).toBe(11);

    const fragmentos = valor(await getSnapshotFragments(admin, s1!.id));
    expect(fragmentos[0]!.locator).toMatchObject({ kind: 'range', sheet: 'Datos' });
    expect(fragmentos[0]!.text).toContain('Nombre: Valentina Rojas');

    // La fuente quedó procesada, el original (el enlace) intacto, y todo se audita.
    const [fuente] = await query<{ status: string; current_snapshot_id: string; external_id: string }>(
      `SELECT status::text AS status, current_snapshot_id, external_id FROM source_documents WHERE id = $1`,
      [sourceId],
    );
    expect(fuente).toMatchObject({ status: 'procesado', current_snapshot_id: s1!.id, external_id: libroId });
    const eventos = await auditoria(sourceId);
    const creado = eventos.find((e) => e.action === 'source.sync_snapshot_created')!;
    expect(creado).toMatchObject({ origin: 'system', actor_id: null });
    expect(creado.metadata).toMatchObject({
      initiatedBy: admin.id,
      sequence: 1,
      snapshotId: s1!.id,
      contentHash: s1!.contentHash,
    });
  });

  si('el mismo contenido NO crea otro snapshot: queda registrado como sin cambios', async () => {
    const { sourceId, libroId } = await nuevaFuente();
    await google.publicar(libroId, [pestanaCon('Ana Gómez')]);
    const primera = await sincronizar(sourceId);
    const segunda = await sincronizar(sourceId);

    expect(segunda.run.status).toBe('unchanged');
    expect(segunda.run.snapshotId).toBe(primera.run.snapshotId);
    expect(valor(await listSourceSnapshots(admin, sourceId))).toHaveLength(1);
    const [n] = await query<{ n: number }>(
      `SELECT count(*)::int AS n FROM source_fragments WHERE source_id = $1`,
      [sourceId],
    );
    expect(n!.n).toBe(valor(await getSourceSnapshot(admin, primera.run.snapshotId!)).fragments);
    expect((await auditoria(sourceId)).map((e) => e.action)).toEqual(
      expect.arrayContaining(['source.sync_snapshot_created', 'source.sync_unchanged']),
    );
  });

  si('un contenido distinto crea el snapshot 2; el 1 sigue accesible, intacto y es histórico', async () => {
    const { sourceId, libroId } = await nuevaFuente();
    await google.publicar(libroId, [pestanaCon('Primera versión')]);
    const uno = await sincronizar(sourceId);
    const antes = valor(await getSnapshotFragments(admin, uno.run.snapshotId!));
    const hashUno = valor(await getSourceSnapshot(admin, uno.run.snapshotId!)).contentHash;

    await google.publicar(libroId, [pestanaCon('Segunda versión')]);
    const dos = await sincronizar(sourceId);
    expect(dos.run.status).toBe('completed');
    expect(dos.run.snapshotId).not.toBe(uno.run.snapshotId);

    const lista = valor(await listSourceSnapshots(admin, sourceId));
    expect(lista.map((s) => [s.sequence, s.isCurrent])).toEqual([
      [2, true],
      [1, false],
    ]);
    // El snapshot 1 es exactamente el que era.
    const despues = valor(await getSnapshotFragments(admin, uno.run.snapshotId!));
    expect(despues).toEqual(antes);
    expect(valor(await getSourceSnapshot(admin, uno.run.snapshotId!)).contentHash).toBe(hashUno);
    expect(despues[0]!.text).toContain('Primera versión');
    const vigente = valor(await getSnapshotFragments(admin, dos.run.snapshotId!));
    expect(vigente[0]!.text).toContain('Segunda versión');
  });

  si('la evidencia histórica sigue resolviendo al contenido del snapshot que la originó', async () => {
    const { sourceId, libroId } = await nuevaFuente();
    await google.publicar(libroId, [pestanaCon('Contenido ORIGINAL')]);
    const uno = await sincronizar(sourceId);
    const [frag] = valor(await getSnapshotFragments(admin, uno.run.snapshotId!));

    const [ev] = await query<{ id: string; locator: unknown }>(
      `INSERT INTO evidence (brief_field_id, source_id, fragment_id, quote) VALUES ($1, $2, $3, 'cita') RETURNING id, locator`,
      [campoId, sourceId, frag!.id],
    );
    expect(ev!.locator).toEqual(frag!.locator);

    await google.publicar(libroId, [pestanaCon('Contenido NUEVO')]);
    const dos = await sincronizar(sourceId);
    expect(dos.run.status).toBe('completed');

    const [despues] = await query<{
      fragment_id: string;
      snapshot_id: string;
      text: string;
      locator: unknown;
    }>(
      `SELECT e.fragment_id, f.snapshot_id, f.text, e.locator
         FROM evidence e JOIN source_fragments f ON f.id = e.fragment_id WHERE e.id = $1`,
      [ev!.id],
    );
    expect(despues!.fragment_id).toBe(frag!.id);
    expect(despues!.snapshot_id).toBe(uno.run.snapshotId);
    expect(despues!.text).toContain('Contenido ORIGINAL');
    expect(despues!.locator).toEqual(frag!.locator);
  });

  si('la búsqueda y las lecturas usan por defecto el snapshot vigente', async () => {
    const { sourceId, libroId } = await nuevaFuente();
    const marca1 = `zzUno${sufijo}`;
    const marca2 = `zzDos${sufijo}`;
    await google.publicar(libroId, [pestanaCon(marca1)]);
    await sincronizar(sourceId);
    expect(valor(await buscarTextoEnFuentes(admin, { campaignId: campanaId, texto: marca1 }))).toHaveLength(
      1,
    );

    await google.publicar(libroId, [pestanaCon(marca2)]);
    const dos = await sincronizar(sourceId);
    expect(valor(await buscarTextoEnFuentes(admin, { campaignId: campanaId, texto: marca1 }))).toHaveLength(
      0,
    );
    expect(valor(await buscarTextoEnFuentes(admin, { campaignId: campanaId, texto: marca2 }))).toHaveLength(
      1,
    );

    const fragmentos = valor(await getFragments(admin, sourceId));
    expect(fragmentos).toHaveLength(valor(await getSourceSnapshot(admin, dos.run.snapshotId!)).fragments);
    expect(fragmentos[0]!.text).toContain(marca2);
    const fuente = valor(await listSources(admin, campanaId)).find((s) => s.id === sourceId)!;
    expect(fuente.fragmentos).toBe(fragmentos.length);
    const representacion = valor(await obtenerRepresentacionNormalizada(admin, sourceId));
    expect(representacion.snapshot).toMatchObject({ id: dos.run.snapshotId, sequence: 2 });
    expect(representacion.estructura).toMatchObject({ format: 'google_sheets' });
    expect(representacion.fragmentos.items.every((f) => f.text.includes(marca2))).toBe(true);
  });

  si('un fallo determinista (403) deja la ejecución fallida y NO toca el snapshot vigente', async () => {
    const { sourceId, libroId } = await nuevaFuente();
    await google.publicar(libroId, [pestanaCon('Estable')]);
    const uno = await sincronizar(sourceId);

    await google.fallar(libroId, 403, {}, { error: { message: 'detalle interno de Google SECRETO123' } });
    const malo = await sincronizar(sourceId);
    expect(malo.run).toMatchObject({ status: 'failed', errorCode: 'GOOGLE_FORBIDDEN' });
    expect(malo.run.errorMessage).not.toContain('SECRETO123');

    // Determinista: un solo intento, sin reintentos con backoff.
    const [job] = await query<{ status: string; intentos: number }>(
      `SELECT status::text AS status, intentos FROM processing_jobs WHERE id = $1`,
      [malo.pedido.jobId],
    );
    expect(job).toMatchObject({ status: 'fallido', intentos: 1 });

    const [fuente] = await query<{ status: string; current_snapshot_id: string }>(
      `SELECT status::text AS status, current_snapshot_id FROM source_documents WHERE id = $1`,
      [sourceId],
    );
    expect(fuente).toMatchObject({ status: 'procesado', current_snapshot_id: uno.run.snapshotId });
    expect(valor(await listSourceSnapshots(admin, sourceId))).toHaveLength(1);
    const falla = (await auditoria(sourceId)).find((e) => e.action === 'source.sync_failed')!;
    expect(falla).toMatchObject({ origin: 'system' });
    expect(falla.metadata).toMatchObject({ codigo: 'GOOGLE_FORBIDDEN' });
    expect(JSON.stringify(falla.metadata)).not.toContain('SECRETO123');
  });

  si(
    'si la fuente jamás tuvo snapshot, un fallo la deja «fallido»; el siguiente éxito la recupera',
    async () => {
      const { sourceId, libroId } = await nuevaFuente();
      await google.fallar(libroId, 404);
      const malo = await sincronizar(sourceId);
      expect(malo.run).toMatchObject({ status: 'failed', errorCode: 'GOOGLE_NOT_FOUND' });
      const [fuente] = await query<{ status: string; current_snapshot_id: string | null }>(
        `SELECT status::text AS status, current_snapshot_id FROM source_documents WHERE id = $1`,
        [sourceId],
      );
      expect(fuente).toMatchObject({ status: 'fallido', current_snapshot_id: null });

      await google.publicar(libroId, [pestanaCon('Ya existe')]);
      const bueno = await sincronizar(sourceId);
      expect(bueno.run.status).toBe('completed');
      const [recuperada] = await query<{ status: string }>(
        `SELECT status::text AS status FROM source_documents WHERE id = $1`,
        [sourceId],
      );
      expect(recuperada!.status).toBe('procesado');
    },
  );

  si(
    'un fallo transitorio (503) se reintenta con backoff; el éxito posterior completa la MISMA ejecución',
    async () => {
      const { sourceId, libroId } = await nuevaFuente();
      await google.fallar(libroId, 503);
      const primero = await sincronizar(sourceId);
      expect(primero.run.status).toBe('queued');
      const [job] = await query<{ status: string; intentos: number; en_el_futuro: boolean }>(
        `SELECT status::text AS status, intentos, disponible_en > now() AS en_el_futuro FROM processing_jobs WHERE id = $1`,
        [primero.pedido.jobId],
      );
      expect(job).toMatchObject({ status: 'pendiente', intentos: 1, en_el_futuro: true });
      expect(valor(await listSourceSnapshots(admin, sourceId))).toHaveLength(0);

      // Pasado el backoff y con Google recuperado, el reintento termina la misma ejecución.
      await google.publicar(libroId, [pestanaCon('Tras el reintento')]);
      await query(`UPDATE processing_jobs SET disponible_en = now() WHERE id = $1`, [primero.pedido.jobId]);
      await procesarColaConWorker(google.entorno);
      const final = valor(await getSyncRun(admin, primero.pedido.runId));
      expect(final.status).toBe('completed');
      const [job2] = await query<{ intentos: number }>(`SELECT intentos FROM processing_jobs WHERE id = $1`, [
        primero.pedido.jobId,
      ]);
      expect(job2!.intentos).toBe(2);
    },
  );

  si('429 respeta Retry-After; agotar los reintentos cierra la ejecución como fallida', async () => {
    const { sourceId, libroId } = await nuevaFuente();
    await google.fallar(libroId, 429, { 'Retry-After': '1200' });
    const r = await sincronizar(sourceId);
    expect(r.run.status).toBe('queued');
    const [job] = await query<{ min: number }>(
      `SELECT extract(epoch FROM (disponible_en - now()))::int AS min FROM processing_jobs WHERE id = $1`,
      [r.pedido.jobId],
    );
    // Retry-After 1200 s se acota a 900 s: bastante más que el backoff base (300 s al 1.er intento).
    expect(job!.min).toBeGreaterThan(600);

    for (let i = 0; i < 3; i++) {
      await query(`UPDATE processing_jobs SET disponible_en = now() WHERE id = $1`, [r.pedido.jobId]);
      await procesarColaConWorker(google.entorno);
    }
    expect(valor(await getSyncRun(admin, r.pedido.runId))).toMatchObject({
      status: 'failed',
      errorCode: 'GOOGLE_RATE_LIMITED',
    });
  });

  si('timeout de red: transitorio; sin credenciales configuradas: determinista', async () => {
    const a = await nuevaFuente();
    await google.fallarRed(a.libroId, 'timeout');
    const t = await sincronizar(a.sourceId);
    expect(t.run.status).toBe('queued');

    // Sin simulador ni clave: la integración real no está configurada.
    const b = await nuevaFuente();
    const sinConfig = await sincronizar(b.sourceId, {});
    expect(sinConfig.run).toMatchObject({ status: 'failed', errorCode: 'GOOGLE_NOT_CONFIGURED' });
    const [job] = await query<{ intentos: number }>(`SELECT intentos FROM processing_jobs WHERE id = $1`, [
      sinConfig.pedido.jobId,
    ]);
    expect(job!.intentos).toBe(1);
  });

  si('un libro vacío o con una pestaña (gid) que ya no existe se rechaza sin snapshot', async () => {
    const vacio = await nuevaFuente();
    await google.publicar(vacio.libroId, [{ nombre: 'Datos', gid: 1, filas: [] }]);
    expect((await sincronizar(vacio.sourceId)).run).toMatchObject({
      status: 'failed',
      errorCode: 'SPREADSHEET_PARSE_FAILED',
    });

    const sinTab = await nuevaFuente(admin, campanaId, 777);
    await google.publicar(sinTab.libroId, [pestanaCon('X', 11)]);
    const r = await sincronizar(sinTab.sourceId);
    expect(r.run).toMatchObject({ status: 'failed', errorCode: 'GOOGLE_SHEET_TAB_NOT_FOUND' });
    expect(valor(await listSourceSnapshots(admin, sinTab.sourceId))).toHaveLength(0);
  });

  si('el destino de la lectura sale del id registrado, no de la URL que pegó el usuario', async () => {
    // El destino sale de `external_id`; la URL pegada (aunque traiga basura) no se usa.
    const n = contador++;
    const r = valor(
      await registerLinkedSource(admin, {
        campaignId: campanaId,
        url: `https://docs.google.com/spreadsheets/d/${ID(n)}/edit?usp=sharing#gid=11`,
      }),
    );
    await google.publicar(ID(n), [pestanaCon('Por id', 11)]);
    expect((await sincronizar(r.id)).run.status).toBe('completed');
    const [fila] = await query<{ external_url: string }>(
      `SELECT external_url FROM source_documents WHERE id = $1`,
      [r.id],
    );
    expect(fila!.external_url).toContain('docs.google.com');
  });

  si('sincronizaciones consecutivas numeran los snapshots 1, 2, 3 y el hash es determinista', async () => {
    const { sourceId, libroId } = await nuevaFuente();
    const hashes: string[] = [];
    for (const texto of ['A', 'B', 'A']) {
      await google.publicar(libroId, [pestanaCon(texto)]);
      const r = await sincronizar(sourceId);
      hashes.push(valor(await getSourceSnapshot(admin, r.run.snapshotId!)).contentHash);
    }
    expect(valor(await listSourceSnapshots(admin, sourceId)).map((s) => s.sequence)).toEqual([3, 2, 1]);
    // Volver a un contenido anterior da el MISMO hash (determinista), pero es una lectura nueva.
    expect(hashes[0]).toBe(hashes[2]);
    expect(hashes[0]).not.toBe(hashes[1]);
  });
});
