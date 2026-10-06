/**
 * V2 · Fase 7 — QA de la base: las invariantes del análisis de contenido por SQL DIRECTO (migración 024).
 *
 * Nada de esto pasa por los casos de uso: se intenta saltárselos y la BASE debe rechazarlo. Hallazgos y
 * referencias inmutables, solo bajo un run ai_assisted en curso; Brief gobernante nunca un borrador;
 * coherencia de organización/campaña/entregable/participación/fuente; terminal congelado; humana sin
 * hallazgos y con autor humano; una activa por versión; ledger coherente; FK de aprobación.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ANALYSIS_CATEGORIES, ANALYSIS_BASES, MATRIZ_DE_CATEGORIAS } from '@tcl-kol-os/domain';
import { closePool, query } from './client.ts';
import {
  type EscenarioDeAnalisis,
  crearEscenarioDeAnalisis,
  registrarGuionDePrueba,
} from './content-analysis-test-support.ts';
import {
  crearBriefAprobadoDePrueba,
  crearBriefHijoDePrueba,
  limpiarEscenarioDeContenido,
} from './test-utils.ts';

let a: EscenarioDeAnalisis;

const HASH = 'b'.repeat(64);

const versionNueva = async (): Promise<string> =>
  (await registrarGuionDePrueba(a.e, a.deliverableId, a.e.participaciones.valentinaRios, a.e.consultor))
    .versionId;

interface OpcionesDeRun {
  readonly kind?: 'ai_assisted' | 'human';
  readonly status?: string;
  readonly brief?: string;
  readonly createdBy?: string;
  readonly campaignId?: string;
  readonly campaignInfluencerId?: string;
  readonly sourceHash?: string;
  readonly provider?: string | null;
  readonly note?: string | null;
  readonly clave?: string | null;
}

let n = 0;

/** INSERT directo de una revisión: por defecto ai_assisted `running` válido. */
async function insertarRun(versionId: string, o: OpcionesDeRun = {}): Promise<string> {
  n += 1;
  const kind = o.kind ?? 'ai_assisted';
  const ia = kind === 'ai_assisted';
  const status = o.status ?? (ia ? 'running' : 'succeeded');
  const [fila] = await query<{ id: string }>(
    `INSERT INTO content_analysis_runs
       (organization_id, campaign_id, kind, script_version_id, deliverable_id, campaign_influencer_id,
        governing_brief_version_id, brief_fingerprint, script_source_id, script_source_hash,
        script_text_hash, script_chars, fragment_count, product_scope, context_manifest, prompt_version,
        output_schema_version, context_version, severity_policy_version, model_tier, provider,
        status, idempotency_key, request_hash, mode, note, created_by, lease_expires_at, started_at, finished_at)
     SELECT sv.organization_id, COALESCE($3::uuid, sv.campaign_id), $2, sv.id, sv.deliverable_id,
            COALESCE($4::uuid, d.campaign_influencer_id), $5, repeat('a', 64), sv.source_document_id,
            COALESCE($6, sv.source_hash),
            CASE WHEN $7 THEN repeat('c', 64) END, CASE WHEN $7 THEN 100 END, CASE WHEN $7 THEN 2 END,
            CASE WHEN $7 THEN 'assigned' END, CASE WHEN $7 THEN '{"counts":{}}'::jsonb END,
            CASE WHEN $7 THEN 'analisis-guion-1' END, CASE WHEN $7 THEN 'analisis-guion-salida-1' END,
            CASE WHEN $7 THEN 'ctx-analisis-1' END, CASE WHEN $7 THEN 'sev-1' END,
            CASE WHEN $7 THEN 'equilibrado' END, $8,
            $9, CASE WHEN $7 THEN COALESCE($10, 'clave-' || $11 || '-' || sv.id) END,
            CASE WHEN $7 THEN repeat('d', 64) END, CASE WHEN $7 THEN 'ensure' END, $12, $13,
            CASE WHEN $9 IN ('queued', 'running') THEN now() + interval '10 minutes' END,
            CASE WHEN $7 THEN now() END,
            CASE WHEN $9 IN ('succeeded', 'failed') THEN now() END
       FROM script_versions sv JOIN deliverables d ON d.id = sv.deliverable_id
      WHERE sv.id = $1
     RETURNING id`,
    [
      versionId,
      kind,
      o.campaignId ?? null,
      o.campaignInfluencerId ?? null,
      o.brief ?? a.brief.versionId,
      o.sourceHash ?? null,
      ia,
      o.provider === undefined ? (ia && status === 'succeeded' ? 'fake' : null) : o.provider,
      status,
      o.clave ?? null,
      n,
      o.note ?? null,
      o.createdBy ?? a.e.consultor.id,
    ],
  );
  return fila!.id;
}

async function insertarHallazgo(
  runId: string,
  ordinal = 1,
  over: Record<string, unknown> = {},
): Promise<string> {
  const [fila] = await query<{ id: string }>(
    `INSERT INTO content_findings
       (organization_id, campaign_id, script_version_id, analysis_run_id, ordinal, model_position, category,
        basis, severity, claim_status, description)
     SELECT r.organization_id, r.campaign_id, r.script_version_id, r.id, $2, 0, $3, $4, 'media', $5, 'Descripción de prueba del hallazgo.'
       FROM content_analysis_runs r WHERE r.id = $1
     RETURNING id`,
    [runId, ordinal, over['category'] ?? 'cta_missing', over['basis'] ?? 'absence', over['claim'] ?? null],
  );
  return fila!.id;
}

const campo = (clave: string): string => a.brief.campos[clave]!;

let hijaEnBorrador: { versionId: string } | undefined;
/** UNA hija en borrador del Brief de la campaña (el padre queda `superseded`); se reutiliza entre pruebas. */
async function hijaBorrador(): Promise<{ versionId: string }> {
  hijaEnBorrador ??= await crearBriefHijoDePrueba(a.e.admin, a.brief.versionId, { aprobar: false });
  return hijaEnBorrador;
}

async function insertarRefDeBrief(findingId: string, fieldId: string, versionDelBrief: string, key: string) {
  return query(
    `INSERT INTO content_finding_brief_refs
       (organization_id, finding_id, brief_field_id, brief_version_id, field_key, criticidad, value_snippet)
     SELECT f.organization_id, f.id, $2, $3, $4, 'critico', 'valor' FROM content_findings f WHERE f.id = $1`,
    [findingId, fieldId, versionDelBrief, key],
  );
}

async function insertarRefDeGuion(findingId: string, sourceId: string) {
  return query(
    `INSERT INTO content_finding_script_refs
       (organization_id, finding_id, source_id, fragment_ordinal, quote, quote_sha256, fragment_text_hash)
     SELECT f.organization_id, f.id, $2, 1, 'cámara de 200 MP', $3, $3 FROM content_findings f WHERE f.id = $1`,
    [findingId, sourceId, HASH],
  );
}

beforeAll(async () => {
  a = await crearEscenarioDeAnalisis('analisis-triggers');
});

afterAll(async () => {
  await limpiarEscenarioDeContenido(a.e);
  await closePool();
});

describe('forma de la migración 024', () => {
  it('crea las tablas, la columna del ledger y los UNIQUE/FK esperados', async () => {
    const tablas = await query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables WHERE table_name LIKE 'content\\_%' ORDER BY 1`,
    );
    expect(tablas.map((t) => t.table_name)).toEqual([
      'content_analysis_runs',
      'content_finding_brief_refs',
      'content_finding_script_refs',
      'content_findings',
    ]);
    const col = await query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'ai_runs' AND column_name = 'content_analysis_run_id'`,
    );
    expect(col).toHaveLength(1);
    const defs = await query<{ conname: string; def: string }>(
      `SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE conname IN ('ai_runs_content_analysis_run_fkey', 'script_versions_analisis_fkey',
                          'brief_fields_id_version_key', 'content_finding_brief_refs_campo_fkey')`,
    );
    const por = Object.fromEntries(defs.map((d) => [d.conname, d.def]));
    expect(por['ai_runs_content_analysis_run_fkey']).toContain(
      'ON DELETE SET NULL (content_analysis_run_id)',
    );
    expect(por['script_versions_analisis_fkey']).toContain(
      'REFERENCES content_analysis_runs(id, script_version_id)',
    );
    expect(por['brief_fields_id_version_key']).toContain('UNIQUE (id, brief_version_id)');
    expect(por['content_finding_brief_refs_campo_fkey']).toContain(
      'REFERENCES brief_fields(id, brief_version_id)',
    );
  });

  it('los hallazgos NO tienen columna de estado, resolución ni autor humano (sin triage en F7)', async () => {
    const cols = (
      await query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns WHERE table_name = 'content_findings'`,
      )
    ).map((c) => c.column_name);
    for (const prohibida of [
      'status',
      'resolution',
      'resolved_by',
      'resolved_at',
      'author_id',
      'created_by',
    ]) {
      expect(cols).not.toContain(prohibida);
    }
  });

  it('el CHECK de la matriz categoría ↔ base ↔ claim_status espeja MATRIZ_DE_CATEGORIAS del dominio', async () => {
    const versionId = await versionNueva();
    const runId = await insertarRun(versionId);
    let ordinal = 0;
    const discrepancias: string[] = [];
    for (const category of ANALYSIS_CATEGORIES) {
      for (const basis of ANALYSIS_BASES) {
        for (const claim of [null, 'unsupported', 'contradicted', 'supported']) {
          const regla = MATRIZ_DE_CATEGORIAS[category];
          const valido = regla.basis === basis && regla.claimStatus === claim;
          ordinal += 1;
          const aceptado = await insertarHallazgo(runId, ordinal, { category, basis, claim }).then(
            () => true,
            (error: Error) => {
              if (!/content_findings_matriz/u.test(error.message)) throw error;
              return false;
            },
          );
          if (aceptado !== valido)
            discrepancias.push(`${category}/${basis}/${String(claim)}: SQL=${aceptado}`);
        }
      }
    }
    expect(discrepancias).toEqual([]);
  });
});

describe('hallazgos y referencias: inmutables y solo bajo un análisis en curso', () => {
  it('UPDATE y DELETE de hallazgos y de ambas referencias se rechazan', async () => {
    const versionId = await versionNueva();
    const runId = await insertarRun(versionId);
    const f = await insertarHallazgo(runId);
    await insertarRefDeBrief(
      f,
      campo('accion_kpis.accion_esperada'),
      a.brief.versionId,
      'accion_kpis.accion_esperada',
    );
    await insertarRefDeGuion(
      f,
      a.fuenteId === ''
        ? ''
        : (
            await query<{ source_document_id: string }>(
              `SELECT source_document_id FROM script_versions WHERE id = $1`,
              [versionId],
            )
          )[0]!.source_document_id,
    );
    await expect(query(`UPDATE content_findings SET severity = 'alta' WHERE id = $1`, [f])).rejects.toThrow(
      /inmutable/u,
    );
    await expect(
      query(`UPDATE content_findings SET description = 'otra' WHERE id = $1`, [f]),
    ).rejects.toThrow(/inmutable/u);
    await expect(query(`DELETE FROM content_findings WHERE id = $1`, [f])).rejects.toThrow(/inmutable/u);
    await expect(
      query(`UPDATE content_finding_brief_refs SET value_snippet = 'x' WHERE finding_id = $1`, [f]),
    ).rejects.toThrow(/inmutable/u);
    await expect(query(`DELETE FROM content_finding_brief_refs WHERE finding_id = $1`, [f])).rejects.toThrow(
      /inmutable/u,
    );
    await expect(
      query(`UPDATE content_finding_script_refs SET quote = 'x' WHERE finding_id = $1`, [f]),
    ).rejects.toThrow(/inmutable/u);
    await expect(query(`DELETE FROM content_finding_script_refs WHERE finding_id = $1`, [f])).rejects.toThrow(
      /inmutable/u,
    );
  });

  it('un hallazgo solo se inserta con un run ai_assisted en estado running', async () => {
    const versionId = await versionNueva();
    // Un análisis asistido NO nace terminado: el INSERT directo ya se rechaza.
    await expect(insertarRun(versionId, { status: 'succeeded' })).rejects.toThrow(/nace en cola o en curso/u);
    const exitoso = await insertarRun(versionId);
    await query(
      `UPDATE content_analysis_runs SET status = 'succeeded', provider = 'fake', model = 'm' WHERE id = $1`,
      [exitoso],
    );
    await expect(insertarHallazgo(exitoso)).rejects.toThrow(/análisis asistido en curso/u);
    const v2 = await versionNueva();
    const fallido = await insertarRun(v2);
    await query(
      `UPDATE content_analysis_runs SET status = 'failed', failure_code = 'MODEL_TIMEOUT' WHERE id = $1`,
      [fallido],
    );
    await expect(insertarHallazgo(fallido)).rejects.toThrow(/análisis asistido en curso/u);
    const v3 = await versionNueva();
    const humana = await insertarRun(v3, { kind: 'human' });
    await expect(insertarHallazgo(humana)).rejects.toThrow(/análisis asistido en curso/u);
  });

  it('una referencia al Brief solo apunta a campos de la versión GOBERNANTE del run', async () => {
    const versionId = await versionNueva();
    const runId = await insertarRun(versionId);
    const f = await insertarHallazgo(runId);
    // Campo de OTRA versión del Brief (hija en borrador): la FK compuesta es válida pero el trigger lo rechaza.
    const hija = await hijaBorrador();
    const [campoHija] = await query<{ id: string }>(
      `SELECT id FROM brief_fields WHERE brief_version_id = $1 AND key = 'accion_kpis.accion_esperada'`,
      [hija.versionId],
    );
    await expect(
      insertarRefDeBrief(f, campoHija!.id, hija.versionId, 'accion_kpis.accion_esperada'),
    ).rejects.toThrow(/Brief gobernante/u);
    // Campo de una versión pero declarando otra: la FK compuesta lo rechaza.
    await expect(
      insertarRefDeBrief(f, campoHija!.id, a.brief.versionId, 'accion_kpis.accion_esperada'),
    ).rejects.toThrow(/clave de campo|content_finding_brief_refs_campo_fkey/u);
    // Clave que no es la del campo.
    await expect(
      insertarRefDeBrief(f, campo('accion_kpis.accion_esperada'), a.brief.versionId, 'mandatorios'),
    ).rejects.toThrow(/clave de campo/u);
    await expect(
      insertarRefDeBrief(
        f,
        campo('accion_kpis.accion_esperada'),
        a.brief.versionId,
        'accion_kpis.accion_esperada',
      ),
    ).resolves.toBeTruthy();
    // Con el run ya cerrado no se añaden más referencias.
    await query(
      `UPDATE content_analysis_runs SET status = 'succeeded', provider = 'fake', model = 'm', finding_count = 1 WHERE id = $1`,
      [runId],
    );
    await expect(
      insertarRefDeBrief(f, campo('mandatorios'), a.brief.versionId, 'mandatorios'),
    ).rejects.toThrow(/análisis asistido en curso/u);
  });

  it('una referencia al guion solo apunta a la fuente del guion analizado', async () => {
    const versionId = await versionNueva();
    const runId = await insertarRun(versionId);
    const f = await insertarHallazgo(runId);
    const otraFuente = a.e.fuentes.procesada;
    await expect(insertarRefDeGuion(f, otraFuente)).rejects.toThrow(/fuente del guion analizado/u);
    const [v] = await query<{ source_document_id: string }>(
      `SELECT source_document_id FROM script_versions WHERE id = $1`,
      [versionId],
    );
    await expect(insertarRefDeGuion(f, v!.source_document_id)).resolves.toBeTruthy();
  });

  it('finding_count debe coincidir con las filas al pasar a succeeded; un failed no puede tener hallazgos', async () => {
    const versionId = await versionNueva();
    const runId = await insertarRun(versionId);
    await insertarHallazgo(runId, 1);
    await insertarHallazgo(runId, 2, { category: 'requirement_not_covered' });
    await expect(
      query(
        `UPDATE content_analysis_runs SET status = 'succeeded', provider = 'fake', model = 'm', finding_count = 5 WHERE id = $1`,
        [runId],
      ),
    ).rejects.toThrow(/finding_count/u);
    await expect(
      query(
        `UPDATE content_analysis_runs SET status = 'failed', failure_code = 'ANALYSIS_INVALID_OUTPUT' WHERE id = $1`,
        [runId],
      ),
    ).rejects.toThrow(/todo-o-nada/u);
    await expect(
      query(
        `UPDATE content_analysis_runs SET status = 'succeeded', provider = 'fake', model = 'm', finding_count = 2 WHERE id = $1`,
        [runId],
      ),
    ).resolves.toBeTruthy();
    // Con 0 hallazgos declarar 3 también se rechaza.
    const v2 = await versionNueva();
    const r2 = await insertarRun(v2);
    await expect(
      query(
        `UPDATE content_analysis_runs SET status = 'succeeded', provider = 'fake', model = 'm', finding_count = 3 WHERE id = $1`,
        [r2],
      ),
    ).rejects.toThrow(/finding_count/u);
  });
});

describe('revisiones: insumos inmutables, estado hacia adelante, terminal congelado', () => {
  it('los insumos de un run en curso no se modifican; solo se renueva el plazo', async () => {
    const versionId = await versionNueva();
    const runId = await insertarRun(versionId);
    for (const [col, val] of [
      ['brief_fingerprint', `repeat('e', 64)`],
      ['script_source_hash', `repeat('e', 64)`],
      ['prompt_version', `'otra'`],
      ['idempotency_key', `'otra-clave-1234'`],
      ['created_by', `'${a.e.director.id}'`],
      ['mode', `'reanalyze'`],
    ] as const) {
      await expect(
        query(`UPDATE content_analysis_runs SET ${col} = ${val} WHERE id = $1`, [runId]),
      ).rejects.toThrow(/insumos de una revisión/u);
    }
    await expect(
      query(`UPDATE content_analysis_runs SET provider = 'x' WHERE id = $1`, [runId]),
    ).rejects.toThrow(/solo cambia de estado o renueva su plazo/u);
    await expect(
      query(
        `UPDATE content_analysis_runs SET lease_expires_at = now() + interval '20 minutes' WHERE id = $1`,
        [runId],
      ),
    ).resolves.toBeTruthy();
  });

  it('un estado terminal está congelado y no hay marcha atrás', async () => {
    const versionId = await versionNueva();
    const runId = await insertarRun(versionId);
    await query(
      `UPDATE content_analysis_runs SET status = 'succeeded', provider = 'fake', model = 'm', finding_count = 0 WHERE id = $1`,
      [runId],
    );
    await expect(
      query(`UPDATE content_analysis_runs SET status = 'running' WHERE id = $1`, [runId]),
    ).rejects.toThrow(/congelada/u);
    await expect(query(`UPDATE content_analysis_runs SET note = 'x' WHERE id = $1`, [runId])).rejects.toThrow(
      /congelada/u,
    );
    await expect(
      query(`UPDATE content_analysis_runs SET finding_count = 1 WHERE id = $1`, [runId]),
    ).rejects.toThrow(/congelada/u);
    const v2 = await versionNueva();
    const r2 = await insertarRun(v2);
    await query(
      `UPDATE content_analysis_runs SET status = 'failed', failure_code = 'MODEL_TIMEOUT' WHERE id = $1`,
      [r2],
    );
    await expect(
      query(
        `UPDATE content_analysis_runs SET status = 'succeeded', provider = 'f', model = 'm' WHERE id = $1`,
        [r2],
      ),
    ).rejects.toThrow(/congelada/u);
    // La revisión humana nace terminal: tampoco se toca.
    const v3 = await versionNueva();
    const humana = await insertarRun(v3, { kind: 'human' });
    await expect(
      query(`UPDATE content_analysis_runs SET note = 'x' WHERE id = $1`, [humana]),
    ).rejects.toThrow(/congelada/u);
  });

  it('no hay DELETE (la historia se conserva)', async () => {
    const versionId = await versionNueva();
    const runId = await insertarRun(versionId);
    await expect(query(`DELETE FROM content_analysis_runs WHERE id = $1`, [runId])).rejects.toThrow(
      /no admite DELETE/u,
    );
  });

  it('un failed exige código y finding_count = 0; un succeeded exige proveedor y modelo', async () => {
    const versionId = await versionNueva();
    const runId = await insertarRun(versionId);
    await expect(
      query(`UPDATE content_analysis_runs SET status = 'failed' WHERE id = $1`, [runId]),
    ).rejects.toThrow(/cierre_coherente/u);
    await expect(
      query(`UPDATE content_analysis_runs SET status = 'succeeded' WHERE id = $1`, [runId]),
    ).rejects.toThrow(/cierre_coherente/u);
    await expect(
      query(`UPDATE content_analysis_runs SET status = 'failed', failure_code = 'no valido' WHERE id = $1`, [
        runId,
      ]),
    ).rejects.toThrow(/codigo_fallo_valido|cierre_coherente/u);
  });

  it('un solo análisis asistido ACTIVO por versión; una humana por (versión, Brief, persona)', async () => {
    const versionId = await versionNueva();
    await insertarRun(versionId);
    await expect(insertarRun(versionId)).rejects.toThrow(/content_analysis_runs_activo_key/u);
    // Con el primero cerrado ya cabe otro.
    await query(
      `UPDATE content_analysis_runs SET status = 'failed', failure_code = 'MODEL_TIMEOUT' WHERE script_version_id = $1`,
      [versionId],
    );
    await expect(insertarRun(versionId)).resolves.toBeTruthy();
    const v2 = await versionNueva();
    await insertarRun(v2, { kind: 'human' });
    await expect(insertarRun(v2, { kind: 'human' })).rejects.toThrow(/content_analysis_runs_humana_key/u);
    await expect(insertarRun(v2, { kind: 'human', createdBy: a.e.director.id })).resolves.toBeTruthy();
  });

  it('la misma clave de idempotencia en una versión es única', async () => {
    const versionId = await versionNueva();
    const r = await insertarRun(versionId, { clave: 'clave-repetida-123' });
    await query(
      `UPDATE content_analysis_runs SET status = 'failed', failure_code = 'MODEL_TIMEOUT' WHERE id = $1`,
      [r],
    );
    await expect(insertarRun(versionId, { clave: 'clave-repetida-123' })).rejects.toThrow(
      /content_analysis_runs_clave_key/u,
    );
  });
});

describe('el Brief gobernante: nunca un borrador, de la misma campaña', () => {
  it('rechaza un borrador, una versión cancelada y un Brief de OTRA campaña', async () => {
    const versionId = await versionNueva();
    const hija = await hijaBorrador();
    await expect(insertarRun(versionId, { brief: hija.versionId })).rejects.toThrow(/nunca un borrador/u);
    await query(`UPDATE brief_versions SET status = 'cancelled' WHERE id = $1`, [hija.versionId]);
    await expect(insertarRun(versionId, { brief: hija.versionId })).rejects.toThrow(/nunca un borrador/u);
    const ajeno = await crearBriefAprobadoDePrueba(a.e.otraCampanaId, a.e.admin);
    await expect(insertarRun(versionId, { brief: ajeno.versionId })).rejects.toThrow(/nunca un borrador/u);
    // Una versión `superseded` (el padre tras crear la hija) SÍ es un gobernante válido.
    const [padre] = await query<{ status: string }>(`SELECT status FROM brief_versions WHERE id = $1`, [
      a.brief.versionId,
    ]);
    expect(padre!.status).toBe('superseded');
    await expect(insertarRun(versionId, { brief: a.brief.versionId })).resolves.toBeTruthy();
  });

  it('número y fecha de aprobación del Brief los deriva la base (no el llamador)', async () => {
    const versionId = await versionNueva();
    const runId = await insertarRun(versionId);
    const [r] = await query<{ governing_brief_number: number; same: boolean }>(
      `SELECT r.governing_brief_number, (r.brief_approved_at = v.approved_at) AS same
         FROM content_analysis_runs r JOIN brief_versions v ON v.id = r.governing_brief_version_id WHERE r.id = $1`,
      [runId],
    );
    expect(r).toEqual({ governing_brief_number: 1, same: true });
  });
});

describe('coherencia con la versión de guion', () => {
  it('rechaza campaña, participación, fuente y hash que no son los de la versión', async () => {
    const versionId = await versionNueva();
    await expect(insertarRun(versionId, { campaignId: a.e.otraCampanaId })).rejects.toThrow(
      /script_versions|campaña/u,
    );
    await expect(insertarRun(versionId, { campaignInfluencerId: a.e.participaciones.diego })).rejects.toThrow(
      /participación distinta/u,
    );
    await expect(insertarRun(versionId, { sourceHash: 'f'.repeat(64) })).rejects.toThrow(/fuente y el hash/u);
  });

  it('una versión que ya no está abierta (cambios solicitados, reemplazada) no admite revisiones', async () => {
    const versionId = await versionNueva();
    await query(`UPDATE script_versions SET status = 'changes_requested' WHERE id = $1`, [versionId]);
    await expect(insertarRun(versionId)).rejects.toThrow(/ya no admite nuevas revisiones/u);
    await expect(insertarRun(versionId, { kind: 'human' })).rejects.toThrow(
      /ya no admite nuevas revisiones/u,
    );
  });
});

describe('revisión humana: sin hallazgos, sin modelo, autor humano con script:manage', () => {
  it('la forma de una humana: nace succeeded, sin proveedor, sin modelo, sin idempotencia', async () => {
    const v = await versionNueva();
    await expect(insertarRun(v, { kind: 'human', status: 'running' })).rejects.toThrow(
      /forma_humana|cierre_coherente/u,
    );
    await expect(insertarRun(v, { kind: 'human', provider: 'fake' })).rejects.toThrow(/forma_humana/u);
    await expect(insertarRun(v, { kind: 'human', note: '' })).rejects.toThrow(/nota_valida/u);
    await expect(insertarRun(v, { kind: 'human', note: 'x'.repeat(1001) })).rejects.toThrow(/nota_valida/u);
    await expect(insertarRun(v, { kind: 'human', note: 'Revisión completa.' })).resolves.toBeTruthy();
  });

  it('el autor debe ser personal de la agencia con rol manage (paridad con roleCan); sin autor no hay revisión', async () => {
    const v = await versionNueva();
    for (const rol of [a.e.operativo, a.e.analista, a.e.legal]) {
      await expect(insertarRun(v, { kind: 'human', createdBy: rol.id })).rejects.toThrow(
        /no puede ejecutar «manage»/u,
      );
      await expect(insertarRun(v, { createdBy: rol.id })).rejects.toThrow(/no puede ejecutar «manage»/u);
    }
    await expect(insertarRun(v, { kind: 'human', createdBy: a.e.cliente.id })).rejects.toThrow();
    await expect(insertarRun(v, { kind: 'human', createdBy: a.e.ajeno.id })).rejects.toThrow();
    await expect(
      query(
        `INSERT INTO content_analysis_runs
           (organization_id, campaign_id, kind, script_version_id, deliverable_id, campaign_influencer_id,
            governing_brief_version_id, brief_fingerprint, script_source_id, script_source_hash, status, finding_count, finished_at, created_by)
         SELECT sv.organization_id, sv.campaign_id, 'human', sv.id, sv.deliverable_id, d.campaign_influencer_id, $2,
                repeat('a', 64), sv.source_document_id, sv.source_hash, 'succeeded', 0, now(), NULL
           FROM script_versions sv JOIN deliverables d ON d.id = sv.deliverable_id WHERE sv.id = $1`,
        [v, a.brief.versionId],
      ),
    ).rejects.toThrow(/no puede ejecutar «manage»|not-null|created_by/u);
    for (const ok of [a.e.admin, a.e.director, a.e.consultor]) {
      const vv = await versionNueva();
      await expect(insertarRun(vv, { kind: 'human', createdBy: ok.id })).resolves.toBeTruthy();
    }
  });
});

describe('ledger (ai_runs) y aprobación', () => {
  const insertarLlamada = (runId: string, over: { campaign?: string | null; task?: string } = {}) =>
    query(
      `INSERT INTO ai_runs (organization_id, campaign_id, task, tier, provider, model, prompt_version, input_hash,
                            output_status, content_analysis_run_id)
       SELECT r.organization_id, COALESCE($3::uuid, r.campaign_id), $2, 'equilibrado', 'fake', 'm', 'analisis-guion-1', repeat('a', 64), 'ok', r.id
         FROM content_analysis_runs r WHERE r.id = $1`,
      [runId, over.task ?? 'analizar_guion', over.campaign ?? null],
    );

  it('una llamada se enlaza solo a un análisis de SU campaña y de la tarea analizar_guion', async () => {
    const v = await versionNueva();
    const runId = await insertarRun(v);
    await expect(insertarLlamada(runId)).resolves.toBeTruthy();
    await expect(insertarLlamada(runId, { campaign: a.e.otraCampanaId })).rejects.toThrow(
      /campaña distinta/u,
    );
    await expect(insertarLlamada(runId, { task: 'conversar' })).rejects.toThrow(/analizar_guion/u);
  });

  it('script_versions.approved_analysis_id: FK compuesta, revisión succeeded y contra el mismo Brief', async () => {
    const v = await versionNueva();
    const otra = await versionNueva();
    await query(`UPDATE script_versions SET status = 'in_review' WHERE id = ANY($1::uuid[])`, [[v, otra]]);
    const humana = await insertarRun(v, { kind: 'human' });
    const deOtraVersion = await insertarRun(otra, { kind: 'human' });
    const enCurso = await insertarRun(otra);

    const aprobar = (analisis: string, brief: string | null) =>
      query(
        `UPDATE script_versions SET status = 'approved', approved_by = $2, approved_analysis_id = $3,
                approved_brief_version_id = $4 WHERE id = $1`,
        [v, a.e.director.id, analisis, brief],
      );
    // La revisión es de OTRA versión ⇒ la rechaza el trigger de 025 («no es una revisión … de esta versión»)
    // o, si éste no existiera, la FK compuesta (defensa en profundidad doble).
    await expect(aprobar(deOtraVersion, a.brief.versionId)).rejects.toThrow(
      /script_versions_analisis_fkey|revisión terminada de esta versión/u,
    );
    // Una revisión en curso (de otra versión, y además no terminada) tampoco.
    await expect(aprobar(enCurso, a.brief.versionId)).rejects.toThrow();
    // Contra otro Brief que el que se aprueba.
    const otroBrief = await crearBriefAprobadoDePrueba(a.e.campanaId, a.e.admin, {
      productos: [a.e.productos.p80],
    });
    await expect(aprobar(humana, otroBrief.versionId)).rejects.toThrow(/otro Brief/u);
    // La correcta aprueba.
    await expect(aprobar(humana, a.brief.versionId)).resolves.toBeTruthy();
    const [fila] = await query<{ status: string; approved_analysis_id: string }>(
      `SELECT status, approved_analysis_id FROM script_versions WHERE id = $1`,
      [v],
    );
    expect(fila).toEqual({ status: 'approved', approved_analysis_id: humana });
  });
});
