/**
 * E5-3 a E5-6 · La extracción, del worker a la base.
 *
 * Estas pruebas verifican el reparto de responsabilidades, no la calidad del
 * modelo. Concretamente: que esta capa **solo entregue al worker fragmentos que
 * el usuario podía ver**, y que lo que vuelve se persista con las mismas reglas
 * que rigen a un campo escrito a mano.
 *
 * Las que llaman al modelo de verdad están marcadas y cuestan unos centavos de
 * dólar por corrida; se saltan solas si el worker no responde, para que una
 * suite completa no dependa de tener todo levantado.
 *
 * Requiere: docker compose up -d db worker
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePool, query } from './client.ts';
import {
  camposDeVersion,
  extraerCampos,
  persistirExtraccion,
  type CampoExtraido,
  type ResultadoExtraccion,
} from './extraction.ts';

let orgId: string;
let campaignId: string;
let userId: string;
let orgAjena: string;
let campanaAjena: string;

let hayWorker = false;
const versionesCreadas: string[] = [];

beforeAll(async () => {
  const [propia] = await query<{ org: string; camp: string; usr: string }>(
    `SELECT c.organization_id AS org, c.id AS camp, u.id AS usr
       FROM campaigns c
       JOIN users u ON u.organization_id = c.organization_id AND u.email = 'gerardo@smartpr.co'
      WHERE EXISTS (
              SELECT 1 FROM source_documents s
               WHERE s.campaign_id = c.id AND s.status = 'procesado')
      LIMIT 1`,
  );
  if (!propia) throw new Error('Se necesita una campaña con al menos una fuente procesada.');

  orgId = propia.org;
  campaignId = propia.camp;
  userId = propia.usr;

  const [ajena] = await query<{ org: string; camp: string }>(
    `SELECT organization_id AS org, id AS camp FROM campaigns WHERE organization_id <> $1 LIMIT 1`,
    [orgId],
  );
  orgAjena = ajena!.org;
  campanaAjena = ajena!.camp;

  hayWorker = await workerVivo();
});

afterAll(async () => {
  if (versionesCreadas.length > 0) {
    // Una versión aprobada es inmutable pero sí se puede borrar en limpieza:
    // el trigger protege contra edición, no contra DELETE de la versión.
    await query(`DELETE FROM brief_versions WHERE id = ANY($1::uuid[])`, [versionesCreadas]);
  }
  await closePool();
});

async function workerVivo(): Promise<boolean> {
  try {
    const url = (process.env['AI_WORKER_URL'] ?? 'http://localhost:8000').replace(/\/+$/, '');
    const r = await fetch(`${url}/ready`, { signal: AbortSignal.timeout(3000) });
    if (!r.ok) return false;
    return ((await r.json()) as { ai_enabled?: boolean }).ai_enabled === true;
  } catch {
    return false;
  }
}

// ─────────────────── Lo que se le entrega al worker ───────────────────────────

describe('el worker solo ve fragmentos ya autorizados', () => {
  it('exige organización y campaña', async () => {
    await expect(extraerCampos('', campaignId)).rejects.toThrow(/exige organización y campaña/);
    await expect(extraerCampos(orgId, '')).rejects.toThrow(/exige organización y campaña/);
  });

  it('una campaña sin fuentes procesadas no llega a llamar al modelo', async () => {
    // Falla antes de gastar una llamada, y lo dice en términos accionables.
    await expect(extraerCampos(orgAjena, campanaAjena)).rejects.toThrow(
      /no tiene fuentes procesadas/,
    );
  });

  it('la organización equivocada no puede extraer de una campaña ajena', async () => {
    // Mismo campaignId, organización distinta: no hay fragmentos que entregar.
    await expect(extraerCampos(orgAjena, campaignId)).rejects.toThrow(
      /no tiene fuentes procesadas/,
    );
  });
});

// ─────────────────────────── Persistencia ─────────────────────────────────────

/** Resultado sintético: prueba la persistencia sin gastar una llamada al modelo. */
function resultadoDePrueba(campos: CampoExtraido[]): ResultadoExtraccion {
  return {
    modelo: 'modelo/de-prueba',
    nivel: 'eficiente',
    promptVersion: 'prueba-1',
    inputHash: 'a'.repeat(64),
    costoUsd: 0.000123,
    latenciaMs: 1234,
    promptTokens: 100,
    completionTokens: 50,
    generationId: 'gen-de-prueba',
    descartes: [],
    campos,
  };
}

describe('lo persistido respeta las reglas del brief', () => {
  it('guarda campos y evidencias, y deja el AIRun con su costo', async () => {
    const [frag] = await query<{ id: string; source_id: string }>(
      `SELECT f.id, f.source_id
         FROM source_fragments f
         JOIN source_documents s ON s.id = f.source_id
        WHERE s.campaign_id = $1 LIMIT 1`,
      [campaignId],
    );

    const resultado = resultadoDePrueba([
      {
        key: 'mensaje_principal.beneficio_diferencial',
        value: 'Pantalla que se lee bajo el sol',
        status: 'found',
        criticidad: 'claim',
        confidence: 0.9,
        nota: null,
        evidence: [
          {
            fragmentId: frag!.id,
            sourceId: frag!.source_id,
            quote: 'cita de prueba',
            relation: 'soporta',
          },
        ],
      },
      {
        key: 'practico.presupuesto',
        value: null,
        status: 'not_found',
        criticidad: 'informativo',
        confidence: null,
        nota: null,
        evidence: [],
      },
    ]);

    const guardado = await persistirExtraccion({
      organizationId: orgId,
      campaignId,
      createdBy: userId,
      resultado,
    });
    versionesCreadas.push(guardado.versionId);

    expect(guardado.campos).toBe(2);
    expect(guardado.evidencias).toBe(1);

    const [run] = await query<{ cost_usd: string; model: string; task: string; tier: string }>(
      `SELECT cost_usd, model, task, tier FROM ai_runs WHERE id = $1`,
      [guardado.aiRunId],
    );
    expect(run!.task).toBe('extraer_campos');
    expect(run!.model).toBe('modelo/de-prueba');
    expect(Number(run!.cost_usd)).toBeCloseTo(0.000123, 6);
  });

  it('la versión nace en borrador: la IA no aprueba (ADR-002)', async () => {
    const resultado = resultadoDePrueba([
      {
        key: 'contexto.categoria',
        value: 'Smartphones',
        status: 'found',
        criticidad: 'informativo',
        confidence: null,
        nota: null,
        evidence: [],
      },
    ]);

    const guardado = await persistirExtraccion({
      organizationId: orgId,
      campaignId,
      createdBy: userId,
      resultado,
    });
    versionesCreadas.push(guardado.versionId);

    const [v] = await query<{ status: string; approved_at: string | null }>(
      `SELECT status::text, approved_at FROM brief_versions WHERE id = $1`,
      [guardado.versionId],
    );
    expect(v!.status).toBe('draft');
    expect(v!.approved_at).toBeNull();
  });

  it('un conflicto se guarda sin valor, con sus dos evidencias', async () => {
    const frags = await query<{ id: string; source_id: string }>(
      `SELECT f.id, f.source_id
         FROM source_fragments f
         JOIN source_documents s ON s.id = f.source_id
        WHERE s.campaign_id = $1 LIMIT 2`,
      [campaignId],
    );

    const resultado = resultadoDePrueba([
      {
        key: 'practico.fecha_inicio',
        // El worker ya lo anula; que la base lo reciba anulado igual es la red
        // de seguridad: dos capas, no una convención.
        value: 'Septiembre 2026',
        status: 'conflict',
        criticidad: 'critico',
        confidence: null,
        nota: null,
        evidence: [
          {
            fragmentId: frags[0]!.id,
            sourceId: frags[0]!.source_id,
            quote: 'septiembre',
            relation: 'soporta',
          },
          {
            fragmentId: frags[1]!.id,
            sourceId: frags[1]!.source_id,
            quote: 'octubre',
            relation: 'contradice',
          },
        ],
      },
    ]);

    const guardado = await persistirExtraccion({
      organizationId: orgId,
      campaignId,
      createdBy: userId,
      resultado,
    });
    versionesCreadas.push(guardado.versionId);

    const campos = await camposDeVersion(guardado.versionId);
    const conflicto = campos.find((c) => c.key === 'practico.fecha_inicio')!;
    expect(conflicto.status).toBe('conflict');
    expect(conflicto.value).toBeNull();
    expect(conflicto.evidencias).toHaveLength(2);
  });

  it('la evidencia trae el localizador para abrir la fuente (E5-6)', async () => {
    const [frag] = await query<{ id: string; source_id: string }>(
      `SELECT f.id, f.source_id
         FROM source_fragments f
         JOIN source_documents s ON s.id = f.source_id
        WHERE s.campaign_id = $1
          AND (f.slide IS NOT NULL OR f.page IS NOT NULL OR f.section IS NOT NULL)
        LIMIT 1`,
      [campaignId],
    );

    const guardado = await persistirExtraccion({
      organizationId: orgId,
      campaignId,
      createdBy: userId,
      resultado: resultadoDePrueba([
        {
          key: 'marca_producto[].rtbs',
          value: 'Pantalla AMOLED',
          status: 'found',
          criticidad: 'claim',
          confidence: null,
          nota: null,
          evidence: [
            {
              fragmentId: frag!.id,
              sourceId: frag!.source_id,
              quote: 'AMOLED',
              relation: 'soporta',
            },
          ],
        },
      ]),
    });
    versionesCreadas.push(guardado.versionId);

    const campos = await camposDeVersion(guardado.versionId);
    const ev = campos[0]!.evidencias[0]!;
    expect(ev.filename).toBeTruthy();
    expect(ev.page !== null || ev.slide !== null || ev.section !== null).toBe(true);
  });
});

// ────────────────── Contra el modelo real (cuesta dinero) ─────────────────────

describe('extracción contra el modelo real', () => {
  it(
    'produce campos verificados y una versión aprobable',
    async () => {
      if (!hayWorker) {
        console.warn('Worker no disponible o AI_ENABLED=false: se omite la extracción real.');
        return;
      }

      const resultado = await extraerCampos(orgId, campaignId);
      expect(resultado.campos.length).toBeGreaterThan(0);
      expect(resultado.costoUsd).toBeGreaterThan(0);

      // Lo esencial: ningún claim encontrado se queda sin respaldo. El worker
      // ya bajó a not_found los que no pudo verificar.
      const claimsSinRespaldo = resultado.campos.filter(
        (c) => c.criticidad === 'claim' && c.status === 'found' && c.evidence.length === 0,
      );
      expect(claimsSinRespaldo).toEqual([]);

      // Y ningún not_found conserva valor.
      const ausentesConValor = resultado.campos.filter(
        (c) => c.status === 'not_found' && c.value !== null,
      );
      expect(ausentesConValor).toEqual([]);

      const guardado = await persistirExtraccion({
        organizationId: orgId,
        campaignId,
        createdBy: userId,
        resultado,
      });
      versionesCreadas.push(guardado.versionId);

      // La prueba de fuego: la base la deja aprobar, porque todo claim cita.
      await expect(
        query(`UPDATE brief_versions SET status='approved', approved_at=now() WHERE id=$1`, [
          guardado.versionId,
        ]),
      ).resolves.toBeDefined();
    },
    { timeout: 120_000 },
  );
});
