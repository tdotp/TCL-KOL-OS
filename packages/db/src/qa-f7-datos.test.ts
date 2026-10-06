/**
 * QA ADVERSARIAL F7 (subagente F) — integridad de DATOS contra PostgreSQL real.
 *
 * Vectores: 1 (overwrite de versiones), 2 (V(N+1) concurrentes), 3 («approved pointer» corrupto) y
 * 16 (comentarios atribuidos a system/IA, SQL directo). Cada defensa que RESISTE tiene su prueba; cada
 * vulnerabilidad CONFIRMADA se escribió como `it.fails(...)` «QA-F7-xx abierto»; W5a las corrigió (migración
 * 025 y casos de uso) y las volteó a `it(...)` «(Px, corregido)».
 *
 * Solo ataca (no corrige producción). Datos sintéticos; escenario propio, se limpia al final.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePool, query, transaction } from './client.ts';
import { registrarVersionDeGuion } from './script-versions.ts';
import {
  type EscenarioDeAprobacion,
  aprobarDirecto,
  conDemora,
  crearEscenarioDeAprobacion,
  entregableNuevo,
  estadoDeVersion,
  fuenteDeGuionNueva,
  otraVersionRevisada,
  registrarFuente,
  valor,
  versionNueva,
  versionRevisada,
} from './script-approval-test-support.ts';
import { limpiarEscenarioDeContenido } from './test-utils.ts';

let a: EscenarioDeAprobacion;

beforeAll(async () => {
  a = await crearEscenarioDeAprobacion('QA-F7 datos');
});

afterAll(async () => {
  await limpiarEscenarioDeContenido(a.e);
  await closePool();
});

/** Mensaje del rechazo de la base, o `undefined` si la sentencia NO se rechazó (= la defensa no existe). */
async function rechazo(sql: string, params: unknown[] = []): Promise<string | undefined> {
  try {
    await query(sql, params);
    return undefined;
  } catch (error) {
    return (error as Error).message;
  }
}

/**
 * Aprobación por SQL directo CON la revisión y el Brief que exige la base (025): sirve para probar el resto de
 * reglas (aprobador, orden, índice único) sin que las enmascare la exigencia de revisión.
 */
const APROBAR_POR_SQL = `UPDATE script_versions
     SET status = 'approved', approved_by = $2, approved_analysis_id = $3, approved_brief_version_id = $4
   WHERE id = $1`;

async function versionAprobada(): Promise<{ deliverableId: string; versionId: string }> {
  const { deliverableId, versionId } = await versionRevisada(a.e);
  valor(await aprobarDirecto(a.e.director, versionId));
  return { deliverableId, versionId };
}

// ═════════════════════════ Vector 1 · overwrite de una versión ════════════════════

describe('QA-F7-01 · una versión recibida no se sobrescribe', () => {
  it('RESISTE: ningún UPDATE directo cambia identidad, binding, número ni autor de una versión (abierta o aprobada)', async () => {
    const abierta = (await versionRevisada(a.e)).versionId;
    const aprobada = (await versionAprobada()).versionId;
    const otraFuente = await fuenteDeGuionNueva(a.e);
    const ataques: Array<[string, unknown[]]> = [
      [`UPDATE script_versions SET source_document_id = $2 WHERE id = $1`, [otraFuente]],
      [`UPDATE script_versions SET source_hash = repeat('a', 64) WHERE id = $1`, []],
      [`UPDATE script_versions SET source_filename = 'otro.md' WHERE id = $1`, []],
      [`UPDATE script_versions SET version = 99 WHERE id = $1`, []],
      [`UPDATE script_versions SET version = version + 1 WHERE id = $1`, []],
      [`UPDATE script_versions SET created_by = $2 WHERE id = $1`, [a.e.admin.id]],
      [`UPDATE script_versions SET created_at = now() - interval '9 days' WHERE id = $1`, []],
      [`UPDATE script_versions SET deliverable_id = $2 WHERE id = $1`, [a.e.entregables.reelRios]],
    ];
    for (const id of [abierta, aprobada]) {
      for (const [sql, extra] of ataques) {
        const m = await rechazo(sql, [id, ...extra]);
        expect(m, `${id.slice(0, 8)} :: ${sql}`).toBeDefined();
      }
    }
  });

  it('RESISTE: una versión aprobada no cambia de estado, de marcas ni de snapshot, y no se borra', async () => {
    const { versionId } = await versionAprobada();
    for (const sql of [
      `UPDATE script_versions SET status = 'in_review' WHERE id = $1`,
      `UPDATE script_versions SET status = 'received' WHERE id = $1`,
      `UPDATE script_versions SET status = 'changes_requested' WHERE id = $1`,
      `UPDATE script_versions SET approved_by = NULL, approved_at = NULL WHERE id = $1`,
      `UPDATE script_versions SET approved_at = now() - interval '30 days' WHERE id = $1`,
      `UPDATE script_versions SET approval_snapshot = '{}'::jsonb WHERE id = $1`,
      `UPDATE script_versions SET approved_analysis_id = NULL WHERE id = $1`,
      `UPDATE script_versions SET approved_brief_version_id = NULL WHERE id = $1`,
      `DELETE FROM script_versions WHERE id = $1`,
    ]) {
      expect(await rechazo(sql, [versionId]), sql).toBeDefined();
    }
    expect(await estadoDeVersion(versionId)).toBe('approved');
  });

  it('RESISTE: reutilizar un número es imposible (la base numera; un INSERT con version=1 recibe el siguiente)', async () => {
    const deliverableId = await entregableNuevo(a.e);
    const v1 = await versionNueva(a.e, deliverableId);
    const v2 = await versionNueva(a.e, deliverableId);
    const fuente = await fuenteDeGuionNueva(a.e);
    const [fila] = await query<{ version: number; source_filename: string; source_hash: string }>(
      `INSERT INTO script_versions (organization_id, campaign_id, deliverable_id, version, source_document_id,
                                    source_filename, source_hash, created_by)
       VALUES ($1, $2, $3, 1, $4, 'mentira.md', $5, $6)
       RETURNING version, source_filename, source_hash`,
      [a.e.admin.organizationId, a.e.campanaId, deliverableId, fuente, 'b'.repeat(64), a.e.consultor.id],
    );
    expect(fila!.version).toBe(3);
    // El nombre y el hash los deriva la base de la fuente, no del llamador.
    expect(fila!.source_filename).not.toBe('mentira.md');
    expect(fila!.source_hash).not.toBe('b'.repeat(64));
    // Un duplicado explícito del par (entregable, versión) tampoco existe.
    expect(
      await rechazo(`UPDATE script_versions SET version = 1 WHERE id = $1`, [v2]),
      'renumerar V2 como V1',
    ).toBeDefined();
    expect(await estadoDeVersion(v1)).toBe('received');
  });

  it('RESISTE: la fuente enlazada a una versión no cambia de original, no se borra ni se reasigna', async () => {
    const { versionId } = await versionAprobada();
    const [v] = await query<{ source_document_id: string }>(
      `SELECT source_document_id FROM script_versions WHERE id = $1`,
      [versionId],
    );
    const fuente = v!.source_document_id;
    for (const sql of [
      `UPDATE source_documents SET hash = repeat('c', 64) WHERE id = $1`,
      `UPDATE source_documents SET filename = 'otro.md' WHERE id = $1`,
      `UPDATE source_documents SET file_id = 'x/otro.md' WHERE id = $1`,
      `UPDATE source_documents SET size_bytes = 1 WHERE id = $1`,
      `UPDATE source_documents SET origin = 'link' WHERE id = $1`,
      `DELETE FROM source_documents WHERE id = $1`,
    ]) {
      expect(await rechazo(sql, [fuente]), sql).toBeDefined();
    }
  });

  // QA-F7-01a: el texto extraído (source_fragments) de la fuente de un guion SÍ se puede reescribir o borrar
  // con SQL directo: la inmutabilidad protege `source_documents` (hash/nombre) pero no los fragmentos sobre los
  // que se hizo la revisión y de los que citan los hallazgos (`fragment_text_hash`). Solo SQL (el worker no
  // reprocesa por `retrySource`, que está guardado).
  it('QA-F7-01a (P3, corregido): los fragmentos de la fuente de un guion registrado son inmutables', async () => {
    const { versionId } = await versionRevisada(a.e);
    const [v] = await query<{ source_document_id: string }>(
      `SELECT source_document_id FROM script_versions WHERE id = $1`,
      [versionId],
    );
    const upd = await rechazo(`UPDATE source_fragments SET text = 'TEXTO REESCRITO' WHERE source_id = $1`, [
      v!.source_document_id,
    ]);
    const del = await rechazo(`DELETE FROM source_fragments WHERE source_id = $1`, [v!.source_document_id]);
    expect(upd).toBeDefined();
    expect(del).toBeDefined();
  });

  // QA-F7-01b: `deliverables.last_version` puede avanzarse de uno en uno SIN registrar versión: el siguiente
  // registro salta un número (hueco) y `listarEntregables` (`lv.version = d.last_version`) deja de ver la última.
  it('QA-F7-01b (P3, corregido): last_version no avanza sin registrar una versión (sin huecos)', async () => {
    const deliverableId = await entregableNuevo(a.e);
    await versionNueva(a.e, deliverableId);
    const m = await rechazo(`UPDATE deliverables SET last_version = last_version + 1 WHERE id = $1`, [
      deliverableId,
    ]);
    expect(m).toBeDefined();
  });

  // QA-F7-01c: nada impide que UNA misma fuente respalde dos versiones de entregables DISTINTOS (no hay UNIQUE
  // (source_document_id) y el trigger solo compara contra la última versión del MISMO entregable).
  it('QA-F7-01c (P2, corregido): un archivo no puede ser la versión de dos entregables distintos', async () => {
    const d1 = await entregableNuevo(a.e);
    const d2 = await entregableNuevo(a.e);
    const fuente = await fuenteDeGuionNueva(a.e);
    valor(await registrarFuente(a.e, d1, fuente));
    // Segundo alta por SQL directo en OTRO entregable con la misma fuente.
    const m = await rechazo(
      `INSERT INTO script_versions (organization_id, campaign_id, deliverable_id, version, source_document_id,
                                    source_filename, source_hash, created_by)
       VALUES ($1, $2, $3, 1, $4, 'x', $5, $6)`,
      [a.e.admin.organizationId, a.e.campanaId, d2, fuente, 'd'.repeat(64), a.e.consultor.id],
    );
    expect(m).toBeDefined();
  });
});

// ═════════════════════════ Vector 2 · V(N+1) concurrentes ═════════════════════════

describe('QA-F7-02 · registros concurrentes', () => {
  it('RESISTE: 8 fuentes distintas registradas a la vez en el mismo entregable ⇒ números 1..8 sin huecos ni duplicados', async () => {
    const deliverableId = await entregableNuevo(a.e);
    const fuentes = await Promise.all(Array.from({ length: 8 }, () => fuenteDeGuionNueva(a.e)));
    const rs = await Promise.all(fuentes.map((f) => registrarFuente(a.e, deliverableId, f)));
    for (const r of rs) expect(r.ok).toBe(true);
    const filas = await query<{ version: number }>(
      `SELECT version FROM script_versions WHERE deliverable_id = $1 ORDER BY version`,
      [deliverableId],
    );
    expect(filas.map((f) => f.version)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    const [d] = await query<{ last_version: number }>(`SELECT last_version FROM deliverables WHERE id = $1`, [
      deliverableId,
    ]);
    expect(d!.last_version).toBe(8);
  });

  it('RESISTE: la MISMA fuente registrada 6 veces a la vez en el mismo entregable ⇒ una versión y cinco «deduplicated»', async () => {
    const deliverableId = await entregableNuevo(a.e);
    const fuente = await fuenteDeGuionNueva(a.e);
    const rs = await Promise.all(
      Array.from({ length: 6 }, () => registrarFuente(a.e, deliverableId, fuente)),
    );
    const tipos = rs.map((r) => (r.ok ? r.value.kind : r.error.code));
    expect(tipos.filter((t) => t === 'registered')).toHaveLength(1);
    expect(tipos.filter((t) => t === 'deduplicated')).toHaveLength(5);
    const [n] = await query<{ n: string }>(
      `SELECT count(*)::text AS n FROM script_versions WHERE source_document_id = $1`,
      [fuente],
    );
    expect(n!.n).toBe('1');
  });

  it('RESISTE: con una demora inyectada (1 s) dentro del alta, dos registros del mismo entregable se serializan', async () => {
    const deliverableId = await entregableNuevo(a.e);
    const [f1, f2] = await Promise.all([fuenteDeGuionNueva(a.e), fuenteDeGuionNueva(a.e)]);
    await conDemora('alta_de_version', deliverableId, 1, async () => {
      const rs = await Promise.all([
        registrarFuente(a.e, deliverableId, f1!),
        registrarFuente(a.e, deliverableId, f2!),
      ]);
      expect(rs.every((r) => r.ok)).toBe(true);
    });
    const filas = await query<{ version: number }>(
      `SELECT version FROM script_versions WHERE deliverable_id = $1 ORDER BY version`,
      [deliverableId],
    );
    expect(filas.map((f) => f.version)).toEqual([1, 2]);
  });

  // QA-F7-02a: la deduplicación por fuente de `registrarVersionDeGuion` corre bajo el mutex del ENTREGABLE, no de
  // la fuente. Dos registros simultáneos de la MISMA fuente hacia dos entregables distintos (dos influencers)
  // pasan ambos la comprobación y ambos insertan: un archivo queda como guion de dos personas.
  it('QA-F7-02a (P2, corregido): el mismo archivo registrado a la vez para dos entregables solo vale para uno', async () => {
    const fuente = await fuenteDeGuionNueva(a.e);
    const dA = a.e.entregables.reelRios;
    const dB = a.e.entregables.reelDiego;
    const registrar = (deliverableId: string, participationId: string) =>
      registrarVersionDeGuion(a.e.consultor, {
        campaignId: a.e.campanaId,
        sourceId: fuente,
        participation: { participationId },
        deliverable: { id: deliverableId },
      });
    let resultados: Awaited<ReturnType<typeof registrar>>[] = [];
    await conDemora('alta_de_version', dA, 1, async () => {
      await conDemora('alta_de_version', dB, 1, async () => {
        resultados = await Promise.all([
          registrar(dA, a.e.participaciones.valentinaRios),
          registrar(dB, a.e.participaciones.diego),
        ]);
      });
    });
    const [n] = await query<{ n: string }>(
      `SELECT count(*)::text AS n FROM script_versions WHERE source_document_id = $1`,
      [fuente],
    );
    expect(n!.n).toBe('1');
    // El perdedor de la carrera recibe la versión ya registrada (deduplicated), no un conflicto.
    expect(resultados.map((r) => (r.ok ? r.value.kind : r.error.code)).sort()).toEqual([
      'deduplicated',
      'registered',
    ]);
  });
});

// ═════════════════════════ Vector 3 · «approved pointer» corrupto ═════════════════

describe('QA-F7-03 · la versión aprobada vigente es un estado íntegro', () => {
  it('RESISTE: dos aprobadas vigentes del mismo entregable son imposibles (índice único parcial)', async () => {
    const { deliverableId } = await versionAprobada();
    const { versionId: v2 } = await otraVersionRevisada(a.e, deliverableId);
    // El caso de uso reemplaza a la anterior: la V2 ya es la vigente y V1 quedó `superseded`.
    valor(await aprobarDirecto(a.e.director, v2));
    const { versionId: v3, runId: r3 } = await otraVersionRevisada(a.e, deliverableId);
    // Por SQL, aprobar la V3 SIN reemplazar a la V2 viola el índice único.
    const m = await rechazo(APROBAR_POR_SQL, [v3, a.e.director.id, r3, a.brief.versionId]);
    expect(m).toMatch(/duplicate key|script_versions_aprobada_vigente_key|unique/i);
    const [n] = await query<{ n: string }>(
      `SELECT count(*)::text AS n FROM script_versions WHERE deliverable_id = $1 AND status = 'approved'`,
      [deliverableId],
    );
    expect(n!.n).toBe('1');
  });

  it('RESISTE: aprobar hacia atrás se rechaza por SQL y por el caso de uso (not_newer)', async () => {
    const deliverableId = await entregableNuevo(a.e);
    const { versionId: v1, runId: r1 } = await otraVersionRevisada(a.e, deliverableId);
    const { versionId: v2, runId: r2 } = await otraVersionRevisada(a.e, deliverableId);
    // V2 aprobada por SQL (sin reemplazar V1): la V1 queda abierta y MENOR que una aprobada.
    await query(APROBAR_POR_SQL, [v2, a.e.director.id, r2, a.brief.versionId]);
    const m = await rechazo(APROBAR_POR_SQL, [v1, a.e.director.id, r1, a.brief.versionId]);
    expect(m).toMatch(/hacia atr[aá]s/i);
    const [fila] = await query<{ version: number }>(`SELECT version FROM script_versions WHERE id = $1`, [
      v1,
    ]);
    expect(fila!.version).toBe(1);
  });

  it('RESISTE: superseded exige sucesora MAYOR y que quede aprobada al COMMIT', async () => {
    const deliverableId = await entregableNuevo(a.e);
    const v1 = await versionNueva(a.e, deliverableId);
    const v2 = await versionNueva(a.e, deliverableId);
    await query(`UPDATE script_versions SET status = 'in_review' WHERE id = ANY($1::uuid[])`, [[v1, v2]]);
    // sin sucesora
    expect(
      await rechazo(`UPDATE script_versions SET status = 'superseded' WHERE id = $1`, [v1]),
    ).toBeDefined();
    // sucesora menor (la mayor no puede quedar reemplazada por una menor)
    expect(
      await rechazo(
        `UPDATE script_versions SET status = 'superseded', superseded_by_version_id = $2 WHERE id = $1`,
        [v2, v1],
      ),
    ).toBeDefined();
    // sucesora mayor pero NO aprobada ⇒ el trigger diferido lo rechaza al COMMIT
    expect(
      await rechazo(
        `UPDATE script_versions SET status = 'superseded', superseded_by_version_id = $2 WHERE id = $1`,
        [v1, v2],
      ),
    ).toMatch(/sucesora/i);
    expect(await estadoDeVersion(v1)).toBe('in_review');
    // una sucesora de OTRO entregable tampoco vale
    const otro = await versionNueva(a.e, await entregableNuevo(a.e));
    expect(
      await rechazo(
        `UPDATE script_versions SET status = 'superseded', superseded_by_version_id = $2 WHERE id = $1`,
        [v1, otro],
      ),
    ).toBeDefined();
  });

  it('RESISTE: status approved sin aprobador, con aprobador sin rol o con fecha falsificada', async () => {
    const deliverableId = await entregableNuevo(a.e);
    const { versionId: v1, runId: r1 } = await otraVersionRevisada(a.e, deliverableId);
    const brief = a.brief.versionId;
    // Sin aprobador (con revisión y Brief, para que falle por el aprobador y no por la falta de revisión).
    expect(
      await rechazo(
        `UPDATE script_versions SET status = 'approved', approved_analysis_id = $2, approved_brief_version_id = $3
          WHERE id = $1`,
        [v1, r1, brief],
      ),
    ).toBeDefined();
    expect(await rechazo(APROBAR_POR_SQL, [v1, a.e.consultor.id, r1, brief])).toBeDefined();
    // La fecha de aprobación la fija la base: una fecha enviada se ignora.
    await query(
      `UPDATE script_versions SET status = 'approved', approved_by = $2, approved_at = '2001-01-01',
              approved_analysis_id = $3, approved_brief_version_id = $4 WHERE id = $1`,
      [v1, a.e.director.id, r1, brief],
    );
    const [f] = await query<{ viejo: boolean }>(
      `SELECT approved_at < now() - interval '1 year' AS viejo FROM script_versions WHERE id = $1`,
      [v1],
    );
    expect(f!.viejo).toBe(false);
  });

  // QA-F7-03a: la base admite una versión `approved` SIN revisión (approved_analysis_id NULL) y con un
  // approved_brief_version_id cualquiera (de otra campaña de la misma organización): la regla «aprobar exige una
  // revisión CURRENT contra el Brief rector» vive solo en el caso de uso. Defensa en profundidad ausente.
  it('QA-F7-03a (P3, corregido): la base exige revisión y Brief rector de la misma campaña para aprobar', async () => {
    const deliverableId = await entregableNuevo(a.e);
    const v1 = await versionNueva(a.e, deliverableId);
    await query(`UPDATE script_versions SET status = 'in_review' WHERE id = $1`, [v1]);
    const m = await rechazo(
      `UPDATE script_versions SET status = 'approved', approved_by = $2 WHERE id = $1`,
      [v1, a.e.director.id],
    );
    expect(m, 'aprobada sin approved_analysis_id ni approved_brief_version_id').toBeDefined();
  });

  it('RESISTE: citar una revisión de OTRA versión o de otro Brief en approved_analysis_id', async () => {
    const x = await versionRevisada(a.e);
    const y = await versionRevisada(a.e);
    const m = await rechazo(
      `UPDATE script_versions SET status = 'approved', approved_by = $2, approved_analysis_id = $3 WHERE id = $1`,
      [x.versionId, a.e.director.id, y.runId],
    );
    expect(m).toBeDefined();
    expect(await estadoDeVersion(x.versionId)).toBe('in_review');
  });
});

// ═════════════════════════ Vector 16 · comentarios atribuidos (SQL) ═══════════════

describe('QA-F7-16 · un comentario no puede firmarlo el sistema, la IA ni una persona sin rol', () => {
  async function versionAbierta(): Promise<string> {
    return (await versionRevisada(a.e)).versionId;
  }
  const INSERTAR = `INSERT INTO script_review_comments
      (organization_id, campaign_id, script_version_id, author_id, kind, body, origin, chat_message_id)
    VALUES ($1, $2, $3, $4, 'editorial', $5, $6, $7)`;

  it('RESISTE: no hay autor sistema/IA: origin system, autor NULL, autor ajeno, cliente u operativo se rechazan', async () => {
    const v = await versionAbierta();
    const org = a.e.admin.organizationId;
    expect(
      await rechazo(INSERTAR, [org, a.e.campanaId, v, a.e.consultor.id, 'x', 'system', null]),
    ).toBeDefined();
    expect(await rechazo(INSERTAR, [org, a.e.campanaId, v, null, 'x', 'ui', null])).toBeDefined();
    expect(await rechazo(INSERTAR, [org, a.e.campanaId, v, a.e.ajeno.id, 'x', 'ui', null])).toBeDefined();
    expect(await rechazo(INSERTAR, [org, a.e.campanaId, v, a.e.cliente.id, 'x', 'ui', null])).toBeDefined();
    expect(await rechazo(INSERTAR, [org, a.e.campanaId, v, a.e.operativo.id, 'x', 'ui', null])).toBeDefined();
    expect(await rechazo(INSERTAR, [org, a.e.campanaId, v, a.e.legal.id, 'x', 'ui', null])).toBeDefined();
  });

  it('RESISTE: origin chat exige el mensaje de la PERSONA (no el del asistente, ni el de otra persona, ni de otra campaña) y cita exacta', async () => {
    const v = await versionAbierta();
    const org = a.e.admin.organizationId;
    // Conversación y mensajes sintéticos.
    const [conv] = await query<{ id: string }>(
      `INSERT INTO chat_conversations (organization_id, campaign_id, created_by, title)
       VALUES ($1, $2, $3, 'qa-f7') RETURNING id`,
      [org, a.e.campanaId, a.e.consultor.id],
    );
    const deUsuario = async (usuario: string, texto: string, conversacion = conv!.id): Promise<string> => {
      const [m] = await query<{ id: string }>(
        `INSERT INTO chat_messages (organization_id, campaign_id, conversation_id, role, user_id, content, client_message_id)
         VALUES ($1, $2, $3, 'user', $4, $5, $6) RETURNING id`,
        [
          org,
          a.e.campanaId,
          conversacion,
          usuario,
          texto,
          `cm-${Math.random().toString(36).slice(2)}-${Date.now()}`,
        ],
      );
      return m!.id;
    };
    const delUsuario = await deUsuario(a.e.consultor.id, 'Quiero que el cierre sea más breve y directo.');
    const [convOtro] = await query<{ id: string }>(
      `INSERT INTO chat_conversations (organization_id, campaign_id, created_by, title)
       VALUES ($1, $2, $3, 'qa-f7-otro') RETURNING id`,
      [org, a.e.campanaId, a.e.director.id],
    );
    const deOtro = await deUsuario(
      a.e.director.id,
      'Texto de otra persona del equipo para citar.',
      convOtro!.id,
    );
    const base = await deUsuario(a.e.consultor.id, 'pregunta base del usuario');
    const [run] = await query<{ id: string }>(
      `INSERT INTO agent_runs (organization_id, campaign_id, conversation_id, user_message_id, user_id,
                               provider, model, tier, prompt_version, context_version)
       VALUES ($1, $2, $3, $4, $5, 'p', 'm', 'equilibrado', 'v1', 'c1') RETURNING id`,
      [org, a.e.campanaId, conv!.id, base, a.e.consultor.id],
    );
    await query(
      `UPDATE agent_runs SET status = 'running', started_at = now(), heartbeat_at = now(),
              context_hash = $2, context_manifest = '{}'::jsonb WHERE id = $1`,
      [run!.id, 'a'.repeat(64)],
    );
    const [asis] = await query<{ id: string }>(
      `INSERT INTO chat_messages (organization_id, campaign_id, conversation_id, role, user_id, content, agent_run_id)
       VALUES ($1, $2, $3, 'assistant', $4, $5, $6) RETURNING id`,
      [
        org,
        a.e.campanaId,
        conv!.id,
        a.e.consultor.id,
        'Sugerencia del asistente: cambiar el tono del cierre.',
        run!.id,
      ],
    );
    const delAsistente = asis!.id;
    expect(
      await rechazo(INSERTAR, [
        org,
        a.e.campanaId,
        v,
        a.e.consultor.id,
        'cambiar el tono del cierre',
        'chat',
        delAsistente,
      ]),
      'mensaje del asistente',
    ).toMatch(/cita|mensaje/i);
    expect(
      await rechazo(INSERTAR, [
        org,
        a.e.campanaId,
        v,
        a.e.consultor.id,
        'Texto de otra persona',
        'chat',
        deOtro,
      ]),
      'mensaje de otra persona',
    ).toMatch(/cita|mensaje/i);
    expect(
      await rechazo(INSERTAR, [
        org,
        a.e.campanaId,
        v,
        a.e.consultor.id,
        'una paráfrasis inventada',
        'chat',
        delUsuario,
      ]),
      'no es subcadena exacta',
    ).toMatch(/cita exacta/i);
    // La que SÍ es subcadena exacta del propio mensaje pasa (control positivo).
    expect(
      await rechazo(INSERTAR, [
        org,
        a.e.campanaId,
        v,
        a.e.consultor.id,
        'el cierre sea más breve',
        'chat',
        delUsuario,
      ]),
    ).toBeUndefined();
    // origin ui con mensaje, o chat sin mensaje, son incoherentes.
    expect(
      await rechazo(INSERTAR, [org, a.e.campanaId, v, a.e.consultor.id, 'x', 'ui', delUsuario]),
    ).toBeDefined();
    expect(
      await rechazo(INSERTAR, [org, a.e.campanaId, v, a.e.consultor.id, 'x', 'chat', null]),
    ).toBeDefined();
  });

  it('RESISTE: un comentario es append-only y no se agrega a una versión cerrada', async () => {
    const { versionId } = await versionAprobada();
    const org = a.e.admin.organizationId;
    expect(
      await rechazo(INSERTAR, [org, a.e.campanaId, versionId, a.e.consultor.id, 'tarde', 'ui', null]),
    ).toMatch(/cerrada|no admite/i);
    const v = await versionAbierta();
    await query(INSERTAR, [org, a.e.campanaId, v, a.e.consultor.id, 'nota', 'ui', null]);
    expect(
      await rechazo(`UPDATE script_review_comments SET body = 'editado' WHERE script_version_id = $1`, [v]),
    ).toBeDefined();
    expect(
      await rechazo(`DELETE FROM script_review_comments WHERE script_version_id = $1`, [v]),
    ).toBeDefined();
  });

  // Vector 16: ni la base ni el caso de uso saben QUIÉN está al otro lado de una sesión SQL: con origin `ui` un
  // proceso con acceso directo puede firmar como cualquier consultor. No es explotable por el agente (no hay SQL),
  // se documenta como límite conocido (el atacante necesita credenciales de la base).
  it('LÍMITE CONOCIDO (no es una brecha del agente): por SQL, origin ui permite firmar como cualquier persona con rol manage', async () => {
    const v = await versionAbierta();
    const m = await rechazo(INSERTAR, [
      a.e.admin.organizationId,
      a.e.campanaId,
      v,
      a.e.director.id,
      'firmado por otro por SQL',
      'ui',
      null,
    ]);
    expect(m).toBeUndefined();
  });
});

// ═════════════════ W5a · controles de la migración 025 (no rompe lo legítimo) ════════

describe('W5a · migración 025: lo legítimo sigue funcionando', () => {
  it('fragmentos: el índice vectorial (embedding) de un guion revisado SÍ se puede recalcular; el texto no', async () => {
    const { versionId } = await versionRevisada(a.e);
    const [v] = await query<{ source_document_id: string }>(
      `SELECT source_document_id FROM script_versions WHERE id = $1`,
      [versionId],
    );
    const fuente = v!.source_document_id;
    expect(
      await rechazo(
        `UPDATE source_fragments SET embedding = array_fill(0.1::float4, ARRAY[1536])::vector WHERE source_id = $1`,
        [fuente],
      ),
    ).toBeUndefined();
    expect(
      await rechazo(`UPDATE source_fragments SET metadata = '{"x":1}' WHERE source_id = $1`, [fuente]),
    ).toBeDefined();
  });

  it('fragmentos: el worker ingiere DESPUÉS de registrar (fuente aún no procesada) y la fuente `fallido` se reprocesa; ya `procesado` y ligada, no', async () => {
    const deliverableId = await entregableNuevo(a.e);
    const fuente = await fuenteDeGuionNueva(a.e);
    valor(await registrarFuente(a.e, deliverableId, fuente));
    // Reprocesamiento (retrySource deja la fuente en `pendiente`): el worker borra e inserta sus fragmentos.
    await query(`UPDATE source_documents SET status = 'pendiente' WHERE id = $1`, [fuente]);
    expect(await rechazo(`DELETE FROM source_fragments WHERE source_id = $1`, [fuente])).toBeUndefined();
    expect(
      await rechazo(
        `INSERT INTO source_fragments (source_id, ordinal, page, text) VALUES ($1, 1, 1, 'texto reingerido')`,
        [fuente],
      ),
    ).toBeUndefined();
    await query(`UPDATE source_documents SET status = 'procesado' WHERE id = $1`, [fuente]);
    expect(await rechazo(`DELETE FROM source_fragments WHERE source_id = $1`, [fuente])).toBeDefined();
    expect(
      await rechazo(`UPDATE source_fragments SET text = 'otro' WHERE source_id = $1`, [fuente]),
    ).toBeDefined();
  });

  it('fragmentos: una fuente que NO es un guion sigue siendo reescribible por el worker', async () => {
    const fuente = await fuenteDeGuionNueva(a.e); // procesada, sin registrar como versión
    expect(
      await rechazo(`UPDATE source_fragments SET text = 'otro' WHERE source_id = $1`, [fuente]),
    ).toBeUndefined();
    expect(await rechazo(`DELETE FROM source_fragments WHERE source_id = $1`, [fuente])).toBeUndefined();
  });

  it('02a: el perdedor de la carrera con entregables IMPLÍCITOS no deja un entregable vacío huérfano', async () => {
    const fuente = await fuenteDeGuionNueva(a.e);
    const sufijo = `${Date.now()}`;
    const registrar = (participationId: string, label: string) =>
      registrarVersionDeGuion(a.e.consultor, {
        campaignId: a.e.campanaId,
        sourceId: fuente,
        participation: { participationId },
        deliverable: { label },
      });
    const rs = await Promise.all([
      registrar(a.e.participaciones.valentinaRios, `Carrera implícita A ${sufijo}`),
      registrar(a.e.participaciones.diego, `Carrera implícita B ${sufijo}`),
    ]);
    expect(rs.every((r) => r.ok)).toBe(true);
    const tipos = rs.map((r) => (r.ok ? r.value.kind : 'error')).sort();
    expect(tipos).toEqual(['deduplicated', 'registered']);
    const [n] = await query<{ n: string }>(
      `SELECT count(*)::text AS n FROM script_versions WHERE source_document_id = $1`,
      [fuente],
    );
    expect(n!.n).toBe('1');
    const vacios = await query<{ label: string }>(
      `SELECT label FROM deliverables WHERE campaign_id = $1 AND label LIKE $2 AND last_version = 0`,
      [a.e.campanaId, `Carrera implícita % ${sufijo}`],
    );
    expect(vacios).toEqual([]);
  });

  it('03a: el Brief citado para aprobar debe ser de la MISMA campaña (aunque sea de la misma organización)', async () => {
    const otro = await crearEscenarioDeAprobacion('QA-F7 otra campaña');
    try {
      const { versionId, runId } = await versionRevisada(a.e);
      const m = await rechazo(APROBAR_POR_SQL, [versionId, a.e.director.id, runId, otro.brief.versionId]);
      expect(m).toMatch(/Brief/i);
      expect(await estadoDeVersion(versionId)).toBe('in_review');
    } finally {
      await limpiarEscenarioDeContenido(otro.e);
    }
  });

  it('01b: el contador last_version sigue siendo consistente tras registros normales y concurrentes', async () => {
    const deliverableId = await entregableNuevo(a.e);
    const fuentes = await Promise.all(Array.from({ length: 3 }, () => fuenteDeGuionNueva(a.e)));
    await Promise.all(fuentes.map((f) => registrarFuente(a.e, deliverableId, f)));
    const [d] = await query<{ last_version: number; maxima: number }>(
      `SELECT d.last_version, (SELECT max(version) FROM script_versions WHERE deliverable_id = d.id) AS maxima
         FROM deliverables d WHERE d.id = $1`,
      [deliverableId],
    );
    expect(d!.last_version).toBe(3);
    expect(d!.maxima).toBe(3);
  });
});

// Una referencia explícita para que `transaction` no quede sin usar si se amplía el archivo.
void transaction;
