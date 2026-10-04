/**
 * V2 · Fase 4 — fuentes enlazadas: una fuente puede ser un archivo O un enlace.
 *
 * Registrar un enlace NO es descargarlo: ninguna de estas rutas hace red (la
 * prueba lo comprueba sustituyendo `fetch`). Datos propios y desechables.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Result, User } from '@tcl-kol-os/domain';
import { closePool, query } from './client.ts';
import { asegurarUsuarioDePrueba, eliminarCampanaDePrueba } from './test-utils.ts';
import { findUserByEmail } from './users.ts';
import {
  getFragments,
  getSource,
  listSources,
  obtenerRepresentacionNormalizada,
  registerLinkedSource,
  retrySource,
  setSourceVisibility,
} from './sources.ts';
import { buscarTextoEnFuentes } from './search.ts';

const sufijo = Date.now().toString(36);
const ID = (n: number) => `1Link${sufijo}${String(n).padStart(3, '0')}${'x'.repeat(24)}`.slice(0, 44);
const SHEET = (n: number) => `https://docs.google.com/spreadsheets/d/${ID(n)}`;

let admin: User;
let consultor: User;
let operativo: User;
let cliente: User;
let ajeno: User;
let campanaId: string;
let campanaAjenaId: string;
const campanas: string[] = [];

function valor<T>(r: Result<T>): T {
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
  return r.value;
}

type Resultado = { readonly ok: true } | { readonly ok: false; readonly error: { readonly code: string } };
const codigo = (r: Resultado) => (r.ok ? undefined : r.error.code);

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

  for (const [owner, nombre] of [
    [admin, 'Enlaces'],
    [ajeno, 'Enlaces ajena'],
  ] as const) {
    const [c] = await query<{ id: string }>(
      `INSERT INTO campaigns (organization_id, name, owner_id, created_by) VALUES ($1, $2, $3, $3) RETURNING id`,
      [owner.organizationId, `${nombre} · ${sufijo}`, owner.id],
    );
    campanas.push(c!.id);
    if (owner === admin) campanaId = c!.id;
    else campanaAjenaId = c!.id;
  }
});

afterAll(async () => {
  await eliminarCampanaDePrueba(campanas);
  await closePool();
});

describe('registrar un enlace', () => {
  it('lo asocia a la campaña, sin archivo local, por resolver y como interno', async () => {
    const r = valor(
      await registerLinkedSource(consultor, {
        campaignId: campanaId,
        url: `${SHEET(1)}/edit?usp=sharing`,
        title: 'Sheet de influencers',
      }),
    );
    expect(r).toMatchObject({
      provider: 'google_sheets',
      externalId: ID(1),
      canonicalUrl: SHEET(1),
      status: 'por_resolver',
    });

    const fuente = valor(await getSource(admin, r.id));
    expect(fuente).toMatchObject({
      campaign_id: campanaId,
      origin: 'link',
      filename: 'Sheet de influencers',
      status: 'por_resolver',
      external_provider: 'google_sheets',
      canonical_url: SHEET(1),
      mime_type: null,
      size_bytes: null,
      hash: null,
      fragmentos: 0,
    });
    expect(fuente.external_url).toBe(`${SHEET(1)}/edit?usp=sharing`); // la URL original se conserva

    const [fila] = await query<{
      visibility: string;
      organization_id: string;
      file_id: string | null;
      created_by: string;
    }>(`SELECT visibility::text, organization_id, file_id, created_by FROM source_documents WHERE id = $1`, [
      r.id,
    ]);
    expect(fila).toMatchObject({
      visibility: 'interna',
      organization_id: admin.organizationId,
      file_id: null,
      created_by: consultor.id,
    });
  });

  it('se puede listar junto a los archivos y obtener por id', async () => {
    const r = valor(await registerLinkedSource(admin, { campaignId: campanaId, url: SHEET(2) }));
    const lista = valor(await listSources(admin, campanaId));
    expect(lista.some((f) => f.id === r.id && f.origin === 'link')).toBe(true);
    expect(valor(await getSource(operativo, r.id)).id).toBe(r.id);
    // Sin título, el nombre es el del proveedor.
    expect(valor(await getSource(admin, r.id)).filename).toMatch(/^Google Sheets · /);
  });

  it('rechaza una URL inválida o de un proveedor no admitido, sin registrar nada', async () => {
    const antes = valor(await listSources(admin, campanaId)).length;
    for (const url of [
      'no es una url',
      'http://docs.google.com/spreadsheets/d/' + ID(3),
      'https://evil.com/x',
      `https://docs.google.com@evil.com/spreadsheets/d/${ID(3)}`,
      'javascript:alert(1)',
    ]) {
      expect(codigo(await registerLinkedSource(admin, { campaignId: campanaId, url })), url).toBe(
        'INVALID_SOURCE_URL',
      );
    }
    expect(valor(await listSources(admin, campanaId)).length).toBe(antes);
  });

  it('NO hace ninguna petición de red', async () => {
    const original = globalThis.fetch;
    let llamadas = 0;
    globalThis.fetch = (() => {
      llamadas += 1;
      throw new Error('no debe haber red al registrar un enlace');
    }) as typeof fetch;
    try {
      valor(await registerLinkedSource(admin, { campaignId: campanaId, url: SHEET(4) }));
      await registerLinkedSource(admin, { campaignId: campanaId, url: 'https://evil.com/x' });
    } finally {
      globalThis.fetch = original;
    }
    expect(llamadas).toBe(0);
  });

  it('no encola procesamiento: un enlace no tiene job y la base lo impide', async () => {
    const r = valor(await registerLinkedSource(admin, { campaignId: campanaId, url: SHEET(5) }));
    expect(await query(`SELECT 1 FROM processing_jobs WHERE source_id = $1`, [r.id])).toHaveLength(0);
    await expect(query(`INSERT INTO processing_jobs (source_id) VALUES ($1)`, [r.id])).rejects.toThrow(
      /fuentes enlazadas/,
    );
    // Reintentar un enlace no inventa trabajo.
    const reintento = await retrySource(admin, r.id);
    expect(codigo(reintento)).toBe('RESOURCE_CONFLICT');
    expect(await query(`SELECT 1 FROM processing_jobs WHERE source_id = $1`, [r.id])).toHaveLength(0);
  });
});

describe('deduplicación', () => {
  it('el mismo enlace (aunque cambie la forma de escribirlo) no se registra dos veces en la campaña', async () => {
    const primero = valor(await registerLinkedSource(admin, { campaignId: campanaId, url: SHEET(6) }));
    for (const variante of [`${SHEET(6)}/edit`, `${SHEET(6)}/edit?usp=sharing`, `${SHEET(6)}/view?utm=x`]) {
      const r = await registerLinkedSource(consultor, { campaignId: campanaId, url: variante });
      expect(codigo(r), variante).toBe('SOURCE_ALREADY_EXISTS');
      if (!r.ok) expect(r.error.details).toMatchObject({ reason: 'same_link', sourceId: primero.id });
    }
    const filas = await query(
      `SELECT 1 FROM source_documents WHERE campaign_id = $1 AND canonical_url = $2`,
      [campanaId, SHEET(6)],
    );
    expect(filas).toHaveLength(1);
  });

  it('NO fusiona recursos distintos: otra pestaña (gid) del mismo libro es otra fuente', async () => {
    valor(await registerLinkedSource(admin, { campaignId: campanaId, url: `${SHEET(7)}/edit#gid=0` }));
    const otraPestana = valor(
      await registerLinkedSource(admin, { campaignId: campanaId, url: `${SHEET(7)}/edit#gid=999` }),
    );
    expect(otraPestana.externalId).toBe(ID(7));
    expect((await getSource(admin, otraPestana.id)).ok).toBe(true);
  });

  it('una carrera de registros simultáneos deja una sola fuente', async () => {
    const resultados = await Promise.all(
      [1, 2, 3].map(() => registerLinkedSource(admin, { campaignId: campanaId, url: SHEET(8) })),
    );
    expect(resultados.filter((r) => r.ok)).toHaveLength(1);
    for (const r of resultados.filter((x) => !x.ok)) expect(codigo(r)).toBe('SOURCE_ALREADY_EXISTS');
  });

  it('el mismo enlace sí puede estar en otra campaña (la deduplicación es por campaña)', async () => {
    const [otra] = await query<{ id: string }>(
      `INSERT INTO campaigns (organization_id, name, owner_id, created_by) VALUES ($1, $2, $3, $3) RETURNING id`,
      [admin.organizationId, `Enlaces otra · ${sufijo}`, admin.id],
    );
    campanas.push(otra!.id);
    valor(await registerLinkedSource(admin, { campaignId: campanaId, url: SHEET(9) }));
    valor(await registerLinkedSource(admin, { campaignId: otra!.id, url: SHEET(9) }));
  });

  it('el índice único lo impone la base aunque se salte la aplicación', async () => {
    const r = valor(await registerLinkedSource(admin, { campaignId: campanaId, url: SHEET(10) }));
    await expect(
      query(
        `INSERT INTO source_documents (campaign_id, organization_id, type, filename, origin, status, created_by,
                                       external_provider, external_id, external_url, canonical_url)
         VALUES ($1, $2, 'otro', 'dup', 'link', 'por_resolver', $3, 'google_sheets', $4, $5, $5)`,
        [campanaId, admin.organizationId, admin.id, ID(10), SHEET(10)],
      ),
    ).rejects.toThrow(/source_documents_canonical_campaign_key/);
    expect(r.canonicalUrl).toBe(SHEET(10));
  });
});

describe('integridad del modelo (origen archivo | enlace)', () => {
  it('un enlace no puede llevar datos de archivo y un archivo no puede carecer de ellos', async () => {
    const base = [campanaId, admin.organizationId, admin.id];
    // Enlace con hash.
    await expect(
      query(
        `INSERT INTO source_documents (campaign_id, organization_id, type, filename, origin, status, created_by,
                                       external_provider, external_id, external_url, canonical_url, hash)
         VALUES ($1, $2, 'otro', 'x', 'link', 'por_resolver', $3, 'google_sheets', 'i', 'https://a', 'https://a', 'h')`,
        base,
      ),
    ).rejects.toThrow(/source_documents_origen_coherente/);
    // Archivo sin hash.
    await expect(
      query(
        `INSERT INTO source_documents (campaign_id, organization_id, type, filename, file_id, mime_type, size_bytes, status, created_by)
         VALUES ($1, $2, 'otro', 'x', 'f', 'text/markdown', 1, 'procesado', $3)`,
        base,
      ),
    ).rejects.toThrow(/source_documents_origen_coherente/);
    // Enlace sin URL canónica.
    await expect(
      query(
        `INSERT INTO source_documents (campaign_id, organization_id, type, filename, origin, status, created_by, external_provider, external_id, external_url)
         VALUES ($1, $2, 'otro', 'x', 'link', 'por_resolver', $3, 'google_sheets', 'i', 'https://a')`,
        base,
      ),
    ).rejects.toThrow(/source_documents_origen_coherente/);
  });

  it('el estado «por resolver» es solo de enlaces; un enlace nunca está «pendiente»; solo https y proveedores conocidos', async () => {
    const link = (
      estado: string,
      proveedor = 'google_sheets',
      url = 'https://docs.google.com/spreadsheets/d/x',
    ) =>
      query(
        `INSERT INTO source_documents (campaign_id, organization_id, type, filename, origin, status, created_by,
                                       external_provider, external_id, external_url, canonical_url)
         VALUES ($1, $2, 'otro', 'x', 'link', $3::source_status, $4, $5, 'i', $6, $6)`,
        [campanaId, admin.organizationId, estado, admin.id, proveedor, url + Math.random()],
      );
    await expect(link('pendiente')).rejects.toThrow(/source_documents_estado_por_origen/);
    await expect(link('por_resolver', 'dropbox')).rejects.toThrow(/source_documents_proveedor_conocido/);
    await expect(link('por_resolver', 'google_sheets', 'http://insegura/')).rejects.toThrow(
      /source_documents_url_https/,
    );
    await expect(
      query(
        `INSERT INTO source_documents (campaign_id, organization_id, type, filename, file_id, mime_type, size_bytes, hash, status, created_by)
         VALUES ($1, $2, 'otro', 'x', 'f', 'text/markdown', 1, $3, 'por_resolver', $4)`,
        [campanaId, admin.organizationId, `h-${sufijo}-estado`, admin.id],
      ),
    ).rejects.toThrow(/source_documents_estado_por_origen/);
  });
});

describe('permisos y aislamiento', () => {
  it('solo quien puede cargar fuentes registra enlaces; Operativo, cliente y sistema no', async () => {
    expect(codigo(await registerLinkedSource(operativo, { campaignId: campanaId, url: SHEET(11) }))).toBe(
      'FORBIDDEN_ROLE',
    );
    expect(codigo(await registerLinkedSource(cliente, { campaignId: campanaId, url: SHEET(11) }))).toBe(
      'FORBIDDEN_ROLE',
    );
    expect(
      codigo(
        await registerLinkedSource('system' as unknown as User, { campaignId: campanaId, url: SHEET(11) }),
      ),
    ).toBe('FORBIDDEN_ROLE');
    expect(await query(`SELECT 1 FROM source_documents WHERE canonical_url = $1`, [SHEET(11)])).toHaveLength(
      0,
    );
  });

  it('no se registra un enlace en una campaña ajena ni inexistente', async () => {
    expect(codigo(await registerLinkedSource(admin, { campaignId: campanaAjenaId, url: SHEET(12) }))).toBe(
      'RESOURCE_NOT_FOUND',
    );
    expect(codigo(await registerLinkedSource(ajeno, { campaignId: campanaId, url: SHEET(12) }))).toBe(
      'RESOURCE_NOT_FOUND',
    );
    expect(
      codigo(
        await registerLinkedSource(admin, {
          campaignId: '00000000-0000-4000-8000-000000000000',
          url: SHEET(12),
        }),
      ),
    ).toBe('RESOURCE_NOT_FOUND');
    expect(await query(`SELECT 1 FROM source_documents WHERE canonical_url = $1`, [SHEET(12)])).toHaveLength(
      0,
    );
  });

  it('otra organización no lee ni lista el enlace', async () => {
    const r = valor(await registerLinkedSource(admin, { campaignId: campanaId, url: SHEET(13) }));
    expect(codigo(await getSource(ajeno, r.id))).toBe('RESOURCE_NOT_FOUND');
    expect(codigo(await listSources(ajeno, campanaId))).toBe('RESOURCE_NOT_FOUND');
    expect(codigo(await getFragments(ajeno, r.id))).toBe('RESOURCE_NOT_FOUND');
    expect(codigo(await obtenerRepresentacionNormalizada(ajeno, r.id))).toBe('RESOURCE_NOT_FOUND');
  });

  it('el mismo contrato de visibilidad de la Fase 1: el cliente no ve el enlace interno; sí el TCL-visible', async () => {
    await query(`UPDATE campaigns SET visibility = 'tcl' WHERE id = $1`, [campanaId]);
    try {
      const r = valor(await registerLinkedSource(admin, { campaignId: campanaId, url: SHEET(14) }));

      // Interna: el cliente no la ve en ningún camino.
      expect(valor(await listSources(cliente, campanaId)).some((f) => f.id === r.id)).toBe(false);
      expect(codigo(await getSource(cliente, r.id))).toBe('RESOURCE_NOT_FOUND');
      expect(codigo(await obtenerRepresentacionNormalizada(cliente, r.id))).toBe('RESOURCE_NOT_FOUND');
      // El personal de SmartPR sí.
      expect((await getSource(consultor, r.id)).ok).toBe(true);
      expect((await getSource(operativo, r.id)).ok).toBe(true);

      // SmartPR decide exponerla: es la misma decisión explícita y auditada.
      valor(await setSourceVisibility(admin, r.id, 'tcl'));
      expect(valor(await listSources(cliente, campanaId)).some((f) => f.id === r.id)).toBe(true);
      const vista = valor(await getSource(cliente, r.id));
      expect(vista.origin).toBe('link');
      expect(vista.job_status).toBeNull(); // el estado técnico sigue siendo interno

      // Volver a interna la oculta de nuevo.
      valor(await setSourceVisibility(admin, r.id, 'interna'));
      expect(codigo(await getSource(cliente, r.id))).toBe('RESOURCE_NOT_FOUND');
    } finally {
      await query(`UPDATE campaigns SET visibility = 'interna' WHERE id = $1`, [campanaId]);
    }
  });

  it('el cliente no puede registrar, y no obtiene fragmentos ni resultados de búsqueda de fuentes internas', async () => {
    await query(`UPDATE campaigns SET visibility = 'tcl' WHERE id = $1`, [campanaId]);
    try {
      const r = valor(await registerLinkedSource(admin, { campaignId: campanaId, url: SHEET(15) }));
      expect(codigo(await getFragments(cliente, r.id))).toBe('RESOURCE_NOT_FOUND');
      const hits = valor(await buscarTextoEnFuentes(cliente, { campaignId: campanaId, texto: 'cualquier' }));
      expect(hits).toEqual([]);
    } finally {
      await query(`UPDATE campaigns SET visibility = 'interna' WHERE id = $1`, [campanaId]);
    }
  });
});

describe('auditoría', () => {
  it('el registro queda auditado con origen ui, el actor y la URL canónica (no la original)', async () => {
    const original = `${SHEET(16)}/edit?resourcekey=SECRETO&usp=sharing`;
    const r = valor(await registerLinkedSource(consultor, { campaignId: campanaId, url: original }));
    const [evento] = await auditoria(r.id);
    expect(evento).toMatchObject({ action: 'source.link_register', origin: 'ui', actor_id: consultor.id });
    expect(evento!.metadata).toMatchObject({
      provider: 'google_sheets',
      canonicalUrl: SHEET(16),
      campaignId: campanaId,
    });
    expect(JSON.stringify(evento!.metadata)).not.toContain('SECRETO');
  });

  it('la correlación futura viaja al evento; no se admite origen «system» para una persona', async () => {
    const r = valor(
      await registerLinkedSource(
        admin,
        { campaignId: campanaId, url: SHEET(17) },
        { correlation: { conversationId: 'conv-4' } },
      ),
    );
    const [evento] = await query<{ correlation: unknown }>(
      `SELECT correlation FROM audit_events WHERE entity_id = $1`,
      [r.id],
    );
    expect(evento!.correlation).toEqual({ conversationId: 'conv-4' });
    expect(
      codigo(
        await registerLinkedSource(admin, { campaignId: campanaId, url: SHEET(18) }, { origin: 'system' }),
      ),
    ).toBe('FORBIDDEN_ROLE');
  });

  it('cambiar la visibilidad de un enlace se audita como el de cualquier fuente', async () => {
    const r = valor(await registerLinkedSource(admin, { campaignId: campanaId, url: SHEET(19) }));
    valor(await setSourceVisibility(admin, r.id, 'tcl'));
    expect((await auditoria(r.id)).map((e) => e.action)).toEqual([
      'source.link_register',
      'source.set_visibility',
    ]);
  });
});

describe('representación normalizada de un enlace', () => {
  it('declara el original (enlace) y que aún no hay contenido resuelto: no inventa fragmentos ni estructura', async () => {
    const r = valor(await registerLinkedSource(admin, { campaignId: campanaId, url: SHEET(20) }));
    const rep = valor(await obtenerRepresentacionNormalizada(admin, r.id));
    expect(rep.original).toMatchObject({
      origin: 'link',
      provider: 'google_sheets',
      canonicalUrl: SHEET(20),
    });
    expect(rep.estructura).toBeNull();
    expect(rep.fragmentos).toEqual({ total: 0, items: [] });
    expect(rep.source.status).toBe('por_resolver');
  });
});
