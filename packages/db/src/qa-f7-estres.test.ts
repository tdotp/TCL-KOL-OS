/**
 * QA ADVERSARIAL F7 (subagente F) — ESTRÉS de concurrencia (vector H) y de recursos (vector B), PostgreSQL real.
 *
 * H: aprobaciones, comentarios, cambios solicitados, registros de V(N+1), propuestas, confirmaciones y cambios de
 *    visibilidad cruzados sobre los mismos entregables NO pueden producir deadlocks (40P01) ni excepciones crudas
 *    (todo error esperable debe volver como `Result`).
 * B: 10 000 comentarios, tope de hallazgos y tamaños: las lecturas y la evaluación de aprobación se acotan.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePool, query } from './client.ts';
import {
  crearComentarioDeRevision,
  listarComentariosDeRevision,
  solicitarCambiosDeScript,
} from './script-review.ts';
import { aprobarScriptVersion } from './script-approval.ts';
import { setSourceVisibility } from './sources.ts';
import {
  type EscenarioDeAprobacion,
  aprobarDirecto,
  confirmarAprobacion,
  crearEscenarioDeAprobacion,
  ejecutarAprobacion,
  entregableNuevo,
  evaluar,
  fuenteDeGuionNueva,
  proponerAprobacion,
  registrarFuente,
  valor,
  versionRevisada,
} from './script-approval-test-support.ts';
import { limpiarEscenarioDeContenido } from './test-utils.ts';

let a: EscenarioDeAprobacion;

beforeAll(async () => {
  a = await crearEscenarioDeAprobacion('QA-F7 estrés');
});

afterAll(async () => {
  await limpiarEscenarioDeContenido(a.e);
  await closePool();
});

describe('QA-F7-H · estrés cruzado sin deadlocks', () => {
  it('RESISTE: 3 rondas de ~50 operaciones cruzadas ⇒ 0 excepciones crudas (40P01 incluido) y estado final consistente', async () => {
    const e = a.e;
    const crudos: unknown[] = [];
    const seguro = async (fn: () => Promise<unknown>): Promise<void> => {
      try {
        await fn();
      } catch (error) {
        crudos.push(error);
      }
    };

    for (let ronda = 0; ronda < 3; ronda += 1) {
      // 4 entregables con 2 versiones revisadas cada uno.
      const grupos = await Promise.all(
        Array.from({ length: 4 }, async () => {
          const r = await versionRevisada(e);
          const otra = await (async () => {
            const f = await fuenteDeGuionNueva(e);
            const reg = valor(await registrarFuente(e, r.deliverableId, f));
            if (reg.kind !== 'registered') throw new Error('no registrada');
            return reg.version.id;
          })();
          return { ...r, otraId: otra };
        }),
      );
      const ops: Array<() => Promise<unknown>> = [];
      for (const g of grupos) {
        ops.push(
          () => aprobarScriptVersion(e.director, g.versionId, { huellaVista: 'a'.repeat(64) }),
          () => aprobarDirecto(e.director, g.versionId),
          () =>
            crearComentarioDeRevision(e.consultor, g.versionId, {
              kind: 'editorial',
              body: `comentario de estrés ${Math.random()}`,
            }),
          () =>
            crearComentarioDeRevision(e.consultor, g.otraId, {
              kind: 'editorial',
              body: `otro comentario ${Math.random()}`,
            }),
          () =>
            solicitarCambiosDeScript(e.consultor, g.otraId, {
              items: [{ body: `cambio de estrés ${Math.random()}` }],
            }),
          async () => {
            const f = await fuenteDeGuionNueva(e);
            return registrarFuente(e, g.deliverableId, f);
          },
          async () => {
            const p = await proponerAprobacion(e, g.versionId);
            await confirmarAprobacion(e.director, p);
            return ejecutarAprobacion(e.director, p);
          },
          async () => {
            const [{ source_document_id: src }] = (await query<{ source_document_id: string }>(
              `SELECT source_document_id FROM script_versions WHERE id = $1`,
              [g.versionId],
            )) as [{ source_document_id: string }];
            return setSourceVisibility(e.admin, src, 'tcl');
          },
        );
      }
      // Mezcla determinista-aleatoria.
      ops.sort(() => Math.random() - 0.5);
      await Promise.all(ops.map((op) => seguro(op)));
    }

    const mensajes = crudos.map((c) => `${(c as { code?: string }).code ?? ''} ${(c as Error).message}`);
    expect(mensajes, mensajes.join('\n')).toEqual([]);

    // Invariantes finales de todo el escenario (y la prueba hizo algo: hubo aprobaciones y comentarios).
    const [hechos] = await query<{ aprobadas: string; comentarios: string }>(
      `SELECT (SELECT count(*) FROM script_versions WHERE campaign_id = $1 AND status = 'approved')::text AS aprobadas,
              (SELECT count(*) FROM script_review_comments WHERE campaign_id = $1)::text AS comentarios`,
      [e.campanaId],
    );
    // «La prueba hizo algo»: con ~100 operaciones simultáneas sobre los mismos entregables, la mayoría de las
    // aprobaciones pierden la carrera (view_stale / not_in_review: es lo correcto). Desde la 025 la evaluación
    // además compara los insumos de la revisión (QA-F7-04b), lo que ensancha un poco esa ventana: basta con que
    // alguna aprobación haya ganado.
    expect(Number(hechos!.aprobadas)).toBeGreaterThanOrEqual(1);
    expect(Number(hechos!.comentarios)).toBeGreaterThanOrEqual(3);
    const dobles = await query<{ deliverable_id: string }>(
      `SELECT deliverable_id FROM script_versions WHERE campaign_id = $1 AND status = 'approved'
        GROUP BY deliverable_id HAVING count(*) > 1`,
      [e.campanaId],
    );
    expect(dobles).toEqual([]);
    const desordenadas = await query<{ id: string }>(
      `SELECT a.id FROM script_versions a JOIN script_versions b
         ON a.deliverable_id = b.deliverable_id AND b.version > a.version
        WHERE a.campaign_id = $1 AND a.status = 'approved' AND b.approved_at IS NOT NULL`,
      [e.campanaId],
    );
    expect(desordenadas).toEqual([]);
    // Ninguna fuente de un guion NO aprobado quedó visible para TCL.
    const expuestas = await query<{ id: string }>(
      `SELECT s.id FROM source_documents s JOIN script_versions sv ON sv.source_document_id = s.id
        WHERE s.campaign_id = $1 AND s.visibility <> 'interna' AND sv.status <> 'approved'`,
      [e.campanaId],
    );
    expect(expuestas).toEqual([]);
    // La numeración sigue siendo contigua por entregable.
    const huecos = await query<{ deliverable_id: string }>(
      `SELECT deliverable_id FROM script_versions WHERE campaign_id = $1
        GROUP BY deliverable_id HAVING max(version) <> count(*)`,
      [e.campanaId],
    );
    expect(huecos).toEqual([]);
  }, 120_000);
});

describe('QA-F7-B · recursos y límites', () => {
  it('RESISTE: 10 000 comentarios en una versión ⇒ la página se acota, la evaluación sigue siendo exacta y rápida', async () => {
    const e = a.e;
    const { versionId } = await versionRevisada(e);
    await query(
      `INSERT INTO script_review_comments
         (organization_id, campaign_id, script_version_id, author_id, kind, body, origin)
       SELECT $1, $2, $3, $4, 'editorial', 'comentario masivo ' || g, 'ui' FROM generate_series(1, 10000) g`,
      [e.admin.organizationId, e.campanaId, versionId, e.consultor.id],
    );
    const t0 = Date.now();
    const pagina = valor(await listarComentariosDeRevision(e.consultor, versionId, { limite: 100000 }));
    expect(pagina.items.length).toBeLessThanOrEqual(200);
    expect(pagina.total).toBe(10000);
    const ev = await evaluar(versionId);
    expect(ev.snapshot.comments.total).toBe(10000);
    expect(Date.now() - t0).toBeLessThan(5000);
    // Se puede aprobar con 10 000 comentarios (no bloquean) y la huella los cubre.
    valor(await aprobarDirecto(e.director, versionId));
  });

  it('RESISTE: la base impone el tope de 100 hallazgos y de 2000 caracteres por comentario aunque el código fallara', async () => {
    const e = a.e;
    const entregable = await entregableNuevo(e);
    const f = await fuenteDeGuionNueva(e);
    const reg = valor(await registrarFuente(e, entregable, f));
    if (reg.kind !== 'registered') throw new Error('no registrada');
    const largo = await query(
      `INSERT INTO script_review_comments
         (organization_id, campaign_id, script_version_id, author_id, kind, body, origin)
       VALUES ($1, $2, $3, $4, 'editorial', repeat('x', 2001), 'ui')`,
      [e.admin.organizationId, e.campanaId, reg.version.id, e.consultor.id],
    ).then(
      () => undefined,
      (error: Error) => error.message,
    );
    expect(largo).toBeDefined();
    const tope = await query(
      `INSERT INTO content_analysis_runs
         (organization_id, campaign_id, kind, script_version_id, deliverable_id, campaign_influencer_id,
          governing_brief_version_id, brief_fingerprint, script_source_id, script_source_hash, script_text_hash,
          script_chars, fragment_count, product_scope, context_manifest, prompt_version, output_schema_version,
          context_version, severity_policy_version, model_tier, status, idempotency_key, request_hash, mode,
          created_by, lease_expires_at, finding_count)
       VALUES ($1, $2, 'ai_assisted', $3, $4, $5, $6, $7, $8, $9, $10, 10, 1, 'assigned', '{}'::jsonb,
               'p', 'o', 'c', 's', 'equilibrado', 'running', 'k-tope-101', $11, 'reanalyze', $12,
               now() + interval '5 min', 101)`,
      [
        e.admin.organizationId,
        e.campanaId,
        reg.version.id,
        entregable,
        e.participaciones.diego,
        a.brief.versionId,
        'a'.repeat(64),
        f,
        reg.version.sourceHash,
        'b'.repeat(64),
        'c'.repeat(64),
        e.consultor.id,
      ],
    ).then(
      () => undefined,
      (error: Error) => error.message,
    );
    expect(tope).toBeDefined();
  });
});
