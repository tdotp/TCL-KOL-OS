/**
 * V2 · Fase 1B — Usuario Operativo representable en el modelo de roles.
 *
 * Hoy solo entra y consulta el contexto del proyecto (campaña, fuentes
 * internas, brief). No aprueba, no transiciona, no edita, no administra y no
 * es cliente. Las capacidades operativas/financieras llegarán con sus entidades.
 *
 * Campaña propia y desechable (INC-001A).
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { User } from '@tcl-kol-os/domain';
import { closePool, query } from './client.ts';
import { asegurarUsuarioDePrueba, eliminarCampanaDePrueba } from './test-utils.ts';
import { findUserByEmail } from './users.ts';
import { getCampaign, listCampaigns } from './campaigns.ts';
import { getFragments, listSources, setSourceVisibility, uploadSource } from './sources.ts';
import { crearBriefManual } from './manual.ts';
import { verCamposDeVersion } from './extraction.ts';
import { corregirCampo, confirmarCampo } from './brief-fields.ts';
import { aprobarBrief, solicitarCambiosInternos } from './client-review.ts';
import { transicionarBrief } from './transitions.ts';
import { crearVersionHija } from './versioning.ts';
import { crearComentario } from './comments.ts';

let admin: User;
let operativo: User;
let cliente: User;
let campaignId: string;
let versionId: string;
let fuenteId: string;
let campanaAjenaId: string;

beforeAll(async () => {
  admin = (await findUserByEmail('gerardo@smartpr.co'))!;
  cliente = (await findUserByEmail('marena@tcl.com'))!;
  operativo = await asegurarUsuarioDePrueba(
    'operativo@smartpr.co',
    'Usuario Operativo',
    'operativo',
    admin.organizationId,
  );

  const [c] = await query<{ id: string }>(
    `INSERT INTO campaigns (organization_id, name, owner_id, created_by)
     VALUES ($1, $2, $3, $3) RETURNING id`,
    [admin.organizationId, `Operativo · ${Date.now()}`, admin.id],
  );
  campaignId = c!.id;
  const creado = await crearBriefManual(admin, campaignId);
  if (!creado.ok) throw new Error(creado.error.message);
  versionId = creado.value.versionId;

  const [f] = await query<{ id: string }>(
    `INSERT INTO source_documents
       (campaign_id, organization_id, type, filename, file_id, mime_type, size_bytes, hash, status, created_by)
     VALUES ($1, $2, 'otro', 'interna.md', 'test/interna.md', 'text/markdown', 10, $3, 'procesado', $4)
     RETURNING id`,
    [campaignId, admin.organizationId, `hash-operativo-${Date.now()}`, admin.id],
  );
  fuenteId = f!.id;
  await query(
    `INSERT INTO source_fragments (source_id, ordinal, page, text) VALUES ($1, 1, 1, 'texto interno')`,
    [fuenteId],
  );

  const [ajena] = await query<{ id: string }>(
    `SELECT id FROM campaigns WHERE name = 'Campaña confidencial de otra agencia'`,
  );
  campanaAjenaId = ajena!.id;
});

afterAll(async () => {
  await eliminarCampanaDePrueba(campaignId);
  await closePool();
});

describe('el rol existe en la base y en el dominio', () => {
  it('se persiste como operativo y no se confunde con cliente ni analista', () => {
    expect(operativo.role).toBe('operativo');
    expect(operativo.role).not.toBe('cliente');
    expect(operativo.role).not.toBe('analista');
    expect(operativo.organizationId).toBe(admin.organizationId);
  });
});

describe('puede entrar y consultar el contexto del proyecto', () => {
  it('lista y abre una campaña de su organización', async () => {
    const lista = await listCampaigns(operativo);
    expect(lista.ok && lista.value.some((c) => c.id === campaignId)).toBe(true);
    expect((await getCampaign(operativo, campaignId)).ok).toBe(true);
  });

  it('lee el brief (campos) y las fuentes internas de su organización', async () => {
    expect((await verCamposDeVersion(operativo, versionId)).ok).toBe(true);
    const fuentes = await listSources(operativo, campaignId);
    expect(fuentes.ok && fuentes.value.map((f) => f.filename)).toEqual(['interna.md']);
    expect((await getFragments(operativo, fuenteId)).ok).toBe(true);
  });

  it('aislamiento: no ve la campaña de otra agencia', async () => {
    const r = await getCampaign(operativo, campanaAjenaId);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('RESOURCE_NOT_FOUND');
  });
});

describe('NO tiene privilegios de decisión, edición ni administración', () => {
  it('no aprueba el brief ni solicita cambios', async () => {
    for (const r of [
      await aprobarBrief(operativo, versionId),
      await solicitarCambiosInternos(operativo, versionId, 'x'),
    ]) {
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('FORBIDDEN_ROLE');
    }
  });

  it('no cambia estados del brief', async () => {
    for (const to of ['internal_review', 'approved', 'cancelled'] as const) {
      const r = await transicionarBrief(operativo, versionId, to, { motivo: 'intento' });
      expect(r.ok, `logró → ${to}`).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('FORBIDDEN_ROLE');
    }
    const [fila] = await query<{ status: string }>(`SELECT status::text FROM brief_versions WHERE id = $1`, [
      versionId,
    ]);
    expect(fila!.status).toBe('draft');
  });

  it('no edita campos, no comenta, no crea briefs ni versiones, no carga fuentes', async () => {
    const [campo] = await query<{ id: string; key: string }>(
      `SELECT id, key FROM brief_fields WHERE brief_version_id = $1 LIMIT 1`,
      [versionId],
    );
    const intentos = [
      await corregirCampo(operativo, versionId, campo!.id, { value: 'x', revisionEsperada: 0 }),
      await confirmarCampo(operativo, versionId, campo!.id, { revisionEsperada: 0 }),
      await crearComentario(operativo, versionId, { fieldKey: campo!.key, content: 'x' }),
      await crearBriefManual(operativo, campaignId),
      await crearVersionHija(operativo, versionId),
      await uploadSource(operativo, {
        campaignId,
        filename: 'x.md',
        contenido: new TextEncoder().encode('# x'),
      }),
      await setSourceVisibility(operativo, fuenteId, 'tcl'),
    ];
    for (const r of intentos) expect(r.ok).toBe(false);
  });
});

describe('cliente sigue de solo lectura (DEC-042)', () => {
  it('no aprueba ni transiciona', async () => {
    expect((await aprobarBrief(cliente, versionId)).ok).toBe(false);
    expect((await transicionarBrief(cliente, versionId, 'internal_review')).ok).toBe(false);
  });
});
