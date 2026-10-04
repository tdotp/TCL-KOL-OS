/**
 * V2 · Fase 1A — visibilidad documental protegida en servidor.
 *
 * Contrato: `interna` es solo de SmartPR; `tcl` / `compartida` son visibles
 * para TCL. Que la CAMPAÑA sea visible no expone sus fuentes: cada fuente debe
 * marcarse explícitamente. La regla vale para listados, lectura por id,
 * búsqueda y evidencia — nunca depende de que la interfaz oculte algo.
 *
 * Campaña propia y desechable (INC-001A).
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { User } from '@tcl-kol-os/domain';
import { closePool, query } from './client.ts';
import { eliminarCampanaDePrueba } from './test-utils.ts';
import { findUserByEmail } from './users.ts';
import { getFragments, listSources, setSourceVisibility } from './sources.ts';
import { buscarEvidencia, buscarEvidenciaComoActor } from './search.ts';
import { crearBriefManual } from './manual.ts';
import { verCamposDeVersion } from './extraction.ts';

let admin: User;
let consultor: User;
let cliente: User;
let ajeno: User;
let campaignId: string;
let campanaInternaId: string;
let fuenteInterna: string;
let fuenteTcl: string;

const VECTOR = [1, ...new Array<number>(1535).fill(0)];

async function insertarFuente(
  campana: string,
  filename: string,
  visibility: 'interna' | 'tcl' | 'compartida',
): Promise<string> {
  const [fila] = await query<{ id: string }>(
    `INSERT INTO source_documents
       (campaign_id, organization_id, type, filename, file_id, mime_type, size_bytes, hash,
        status, visibility, created_by)
     VALUES ($1, $2, 'otro', $3, $4, 'text/markdown', 10, $5, 'procesado', $6::visibility_level, $7)
     RETURNING id`,
    [
      campana,
      admin.organizationId,
      filename,
      `test/${filename}`,
      `hash-${filename}-${Date.now()}`,
      visibility,
      admin.id,
    ],
  );
  const id = fila!.id;
  await query(
    `INSERT INTO source_fragments (source_id, ordinal, page, text, embedding)
     VALUES ($1, 1, 1, $2, $3::vector)`,
    [id, `Contenido de ${filename}`, `[${VECTOR.join(',')}]`],
  );
  return id;
}

beforeAll(async () => {
  admin = (await findUserByEmail('gerardo@smartpr.co'))!;
  consultor = (await findUserByEmail('consultor@smartpr.co'))!;
  cliente = (await findUserByEmail('marena@tcl.com'))!;
  ajeno = (await findUserByEmail('ajeno@otraagencia.co'))!;

  const [c1] = await query<{ id: string }>(
    `INSERT INTO campaigns (organization_id, name, owner_id, created_by, visibility)
     VALUES ($1, $2, $3, $3, 'tcl') RETURNING id`,
    [admin.organizationId, `Visibilidad · campaña visible · ${Date.now()}`, admin.id],
  );
  campaignId = c1!.id;
  const [c2] = await query<{ id: string }>(
    `INSERT INTO campaigns (organization_id, name, owner_id, created_by)
     VALUES ($1, $2, $3, $3) RETURNING id`,
    [admin.organizationId, `Visibilidad · campaña interna · ${Date.now()}`, admin.id],
  );
  campanaInternaId = c2!.id;

  fuenteInterna = await insertarFuente(campaignId, 'interna.md', 'interna');
  fuenteTcl = await insertarFuente(campaignId, 'tcl.md', 'tcl');
  await insertarFuente(campanaInternaId, 'otra-tcl.md', 'tcl');
});

afterAll(async () => {
  await eliminarCampanaDePrueba([campaignId, campanaInternaId]);
  await closePool();
});

describe('cliente: listados', () => {
  it('NO lista la fuente interna de una campaña visible; sí la marcada para TCL', async () => {
    const r = await listSources(cliente, campaignId);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.map((f) => f.filename)).toEqual(['tcl.md']);
  });

  it('una campaña interna no se lista aunque la fuente esté marcada TCL', async () => {
    const r = await listSources(cliente, campanaInternaId);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('RESOURCE_NOT_FOUND');
  });

  it('no recibe el estado técnico del procesamiento', async () => {
    const r = await listSources(cliente, campaignId);
    if (!r.ok) throw new Error('lectura falló');
    expect(r.value[0]!.job_error).toBeNull();
    expect(r.value[0]!.job_status).toBeNull();
  });
});

describe('cliente: lectura por id', () => {
  it('NO obtiene los fragmentos de una fuente interna (mismo error que «no existe»)', async () => {
    const r = await getFragments(cliente, fuenteInterna);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('RESOURCE_NOT_FOUND');
  });

  it('SÍ obtiene los fragmentos de una fuente marcada para TCL', async () => {
    const r = await getFragments(cliente, fuenteTcl);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value[0]!.text).toContain('tcl.md');
  });

  it('una fuente marcada TCL de una campaña interna tampoco se lee', async () => {
    const [f] = await query<{ id: string }>(`SELECT id FROM source_documents WHERE campaign_id = $1`, [
      campanaInternaId,
    ]);
    const r = await getFragments(cliente, f!.id);
    expect(r.ok).toBe(false);
  });
});

describe('cliente: búsqueda', () => {
  it('NO encuentra la fuente interna; sí la marcada para TCL', async () => {
    const r = await buscarEvidenciaComoActor(cliente, { campaignId, vector: VECTOR });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.map((h) => h.filename)).toEqual(['tcl.md']);
  });

  it('el personal de SmartPR busca en todas las fuentes de su organización', async () => {
    const r = await buscarEvidenciaComoActor(consultor, { campaignId, vector: VECTOR });
    if (!r.ok) throw new Error('búsqueda falló');
    expect(r.value.map((h) => h.filename).sort()).toEqual(['interna.md', 'tcl.md']);
  });

  it('la búsqueda de bajo nivel acepta el filtro explícito de visibilidad', async () => {
    const hits = await buscarEvidencia({
      organizationId: admin.organizationId,
      campaignId,
      vector: VECTOR,
      soloVisibleParaTcl: true,
    });
    expect(hits.map((h) => h.filename)).toEqual(['tcl.md']);
  });
});

describe('cliente: evidencia de un brief visible', () => {
  it('no recibe la cita de una fuente interna', async () => {
    const creado = await crearBriefManual(admin, campaignId);
    if (!creado.ok) throw new Error(creado.error.message);
    const [campo] = await query<{ id: string }>(
      `SELECT id FROM brief_fields WHERE brief_version_id = $1 LIMIT 1`,
      [creado.value.versionId],
    );
    for (const [fuente, texto] of [
      [fuenteInterna, 'CITA-INTERNA'],
      [fuenteTcl, 'CITA-TCL'],
    ] as const) {
      await query(
        `INSERT INTO evidence (brief_field_id, source_id, quote, relation, page)
         VALUES ($1, $2, $3, 'soporta', 1)`,
        [campo!.id, fuente, texto],
      );
    }

    const comoCliente = await verCamposDeVersion(cliente, creado.value.versionId);
    if (!comoCliente.ok) throw new Error(comoCliente.error.message);
    const citas = comoCliente.value.flatMap((c) => c.evidencias.map((e) => e.quote));
    expect(citas).toEqual(['CITA-TCL']);

    const comoStaff = await verCamposDeVersion(consultor, creado.value.versionId);
    if (!comoStaff.ok) throw new Error(comoStaff.error.message);
    expect(comoStaff.value.flatMap((c) => c.evidencias.map((e) => e.quote)).sort()).toEqual([
      'CITA-INTERNA',
      'CITA-TCL',
    ]);
  });
});

describe('marcar visibilidad: decisión explícita y auditada de SmartPR', () => {
  it('el cliente no puede marcar nada; el consultor sí, y queda auditado', async () => {
    const denegado = await setSourceVisibility(cliente, fuenteInterna, 'tcl');
    expect(denegado.ok).toBe(false);
    if (!denegado.ok) expect(denegado.error.code).toBe('FORBIDDEN_ROLE');

    const ok = await setSourceVisibility(consultor, fuenteInterna, 'tcl');
    expect(ok.ok).toBe(true);
    expect((await getFragments(cliente, fuenteInterna)).ok).toBe(true);

    const [evento] = await query<{ metadata: { from: string; to: string }; origin: string | null }>(
      `SELECT metadata, origin FROM audit_events
        WHERE entity_id = $1 AND action = 'source.set_visibility' ORDER BY created_at DESC LIMIT 1`,
      [fuenteInterna],
    );
    expect(evento!.metadata).toMatchObject({ from: 'interna', to: 'tcl' });

    // Revertir vuelve a esconderla.
    await setSourceVisibility(consultor, fuenteInterna, 'interna');
    expect((await getFragments(cliente, fuenteInterna)).ok).toBe(false);
  });

  it('un valor inválido se rechaza', async () => {
    const r = await setSourceVisibility(consultor, fuenteInterna, 'publica' as never);
    expect(r.ok).toBe(false);
  });
});

describe('aislamiento entre organizaciones intacto', () => {
  it('otra agencia no lista, lee ni busca fuentes de esta', async () => {
    expect((await listSources(ajeno, campaignId)).ok).toBe(false);
    expect((await getFragments(ajeno, fuenteTcl)).ok).toBe(false);
    expect((await buscarEvidenciaComoActor(ajeno, { campaignId, vector: VECTOR })).ok).toBe(false);
    expect((await setSourceVisibility(ajeno, fuenteTcl, 'interna')).ok).toBe(false);
  });
});
