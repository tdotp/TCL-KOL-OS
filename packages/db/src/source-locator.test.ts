/**
 * V2 · Fase 4 — el localizador generalizado en la base: validación, derivación
 * desde las columnas legacy y coherencia de la evidencia con su fragmento.
 *
 * Datos propios y desechables (INC-001A).
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  LOCATOR_CASOS_INVALIDOS,
  LOCATOR_CASOS_VALIDOS,
  localizadorDesdeLegacy,
  type User,
} from '@tcl-kol-os/domain';
import { closePool, query } from './client.ts';
import { eliminarCampanaDePrueba } from './test-utils.ts';
import { findUserByEmail } from './users.ts';
import { crearBriefManual } from './manual.ts';
import { verCamposDeVersion } from './extraction.ts';
import { crearVersionHija } from './versioning.ts';

const sufijo = Date.now().toString(36);

let admin: User;
let campanaId: string;
let versionId: string;
let campoId: string;
let fuenteA: string;
let fuenteB: string;
const campanas: string[] = [];

async function fuente(nombre: string): Promise<string> {
  const [f] = await query<{ id: string }>(
    `INSERT INTO source_documents
       (campaign_id, organization_id, type, filename, file_id, mime_type, size_bytes, hash, status, created_by)
     VALUES ($1, $2, 'otro', $3, $4, 'text/markdown', 10, $5, 'procesado', $6) RETURNING id`,
    [campanaId, admin.organizationId, nombre, `test/${nombre}`, `hash-${nombre}-${sufijo}`, admin.id],
  );
  return f!.id;
}

async function fragmento(
  sourceId: string,
  ordinal: number,
  columnas: { page?: number; slide?: number; section?: string; linea?: number; locator?: unknown },
): Promise<string> {
  const [f] = await query<{ id: string }>(
    `INSERT INTO source_fragments (source_id, ordinal, page, slide, section, linea, locator, text)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, 'texto del fragmento') RETURNING id`,
    [
      sourceId,
      ordinal,
      columnas.page ?? null,
      columnas.slide ?? null,
      columnas.section ?? null,
      columnas.linea ?? null,
      columnas.locator === undefined ? null : JSON.stringify(columnas.locator),
    ],
  );
  return f!.id;
}

beforeAll(async () => {
  admin = (await findUserByEmail('gerardo@smartpr.co'))!;
  const [c] = await query<{ id: string }>(
    `INSERT INTO campaigns (organization_id, name, owner_id, created_by) VALUES ($1, $2, $3, $3) RETURNING id`,
    [admin.organizationId, `Localizador · ${sufijo}`, admin.id],
  );
  campanaId = c!.id;
  campanas.push(campanaId);
  const creado = await crearBriefManual(admin, campanaId);
  if (!creado.ok) throw new Error(creado.error.message);
  versionId = creado.value.versionId;
  const [campo] = await query<{ id: string }>(
    `SELECT id FROM brief_fields WHERE brief_version_id = $1 AND campaign_product_id IS NULL ORDER BY key LIMIT 1`,
    [versionId],
  );
  campoId = campo!.id;
  fuenteA = await fuente('a.md');
  fuenteB = await fuente('b.md');
});

afterAll(async () => {
  await eliminarCampanaDePrueba(campanas);
  await closePool();
});

// ─────────────────────────── Paridad TypeScript ↔ base ─────────────────────────

describe('source_locator_valido() coincide con validarLocalizador()', () => {
  it.each(LOCATOR_CASOS_VALIDOS)('la base acepta: %s', async (_nombre, valor) => {
    const [r] = await query<{ ok: boolean }>(`SELECT source_locator_valido($1::jsonb) AS ok`, [
      JSON.stringify(valor),
    ]);
    expect(r!.ok, JSON.stringify(valor)).toBe(true);
  });

  it.each(LOCATOR_CASOS_INVALIDOS)('la base rechaza: %s', async (_nombre, valor) => {
    const [r] = await query<{ ok: boolean }>(`SELECT source_locator_valido($1::jsonb) AS ok`, [
      JSON.stringify(valor),
    ]);
    expect(r!.ok, JSON.stringify(valor)).toBe(false);
  });
});

type ColumnasLegacy = { page?: number; slide?: number; section?: string; linea?: number };
const CASOS_LEGACY: ReadonlyArray<readonly [string, ColumnasLegacy]> = [
  ['página', { page: 3 }],
  ['diapositiva con título', { slide: 8, section: 'Ficha técnica' }],
  ['sección con línea', { section: 'El Reto › Audiencia', linea: 12 }],
  ['página con sección', { page: 2, section: 'Intro' }],
];

// ─────────────────────────── Fragmentos ────────────────────────────────────────

describe('fragmentos: legacy y nuevos coexisten', () => {
  it('los fragmentos que ya existían tienen localizador (se completó sin reescribir sus columnas)', async () => {
    const [r] = await query<{ sin: string }>(
      `SELECT count(*)::text AS sin FROM source_fragments WHERE locator IS NULL`,
    );
    expect(r!.sin).toBe('0');
  });

  it.each(CASOS_LEGACY)(
    'un parser legacy escribe %s y la base deriva el mismo localizador que el dominio',
    async (_n, columnas) => {
      const id = await fragmento(fuenteA, Math.floor(Math.random() * 1e6), columnas);
      const [f] = await query<{ locator: unknown; page: number | null; slide: number | null }>(
        `SELECT locator, page, slide FROM source_fragments WHERE id = $1`,
        [id],
      );
      expect(f!.locator).toEqual(localizadorDesdeLegacy(columnas));
      // Las columnas legacy NO se tocan.
      expect(f!.page).toBe(columnas.page ?? null);
      expect(f!.slide).toBe(columnas.slide ?? null);
    },
  );

  it('un fragmento de hoja de cálculo se guarda con su localizador de rango', async () => {
    const locator = {
      kind: 'range',
      sheet: 'Producto',
      range: 'B7:D9',
      rowStart: 7,
      rowEnd: 9,
      colStart: 2,
      colEnd: 4,
    };
    const id = await fragmento(fuenteA, 900001, { section: 'Producto', locator });
    const [f] = await query<{ locator: unknown }>(`SELECT locator FROM source_fragments WHERE id = $1`, [id]);
    expect(f!.locator).toEqual(locator);
  });

  it('un fragmento sin ninguna ubicación, o con un localizador inválido, se rechaza', async () => {
    await expect(fragmento(fuenteA, 900002, {})).rejects.toThrow(/source_fragments_localizado/);
    await expect(fragmento(fuenteA, 900003, { locator: { kind: 'range', sheet: 'H' } })).rejects.toThrow(
      /source_fragments_localizado/,
    );
    await expect(
      fragmento(fuenteA, 900004, {
        section: 'ok',
        locator: { kind: 'cell', sheet: 'H', cell: 'B7', row: 8, col: 2 },
      }),
    ).rejects.toThrow(/source_fragments_localizado/);
  });
});

// ─────────────────────────── Evidencia ─────────────────────────────────────────

describe('evidencia: apunta a fragmentos de cualquier formato', () => {
  it('copia SIEMPRE la ubicación del fragmento citado (aunque no se informe)', async () => {
    const locator = {
      kind: 'range',
      sheet: 'Producto',
      range: 'B7:D9',
      rowStart: 7,
      rowEnd: 9,
      colStart: 2,
      colEnd: 4,
    };
    const frag = await fragmento(fuenteA, 900010, { section: 'Producto', locator });
    const [e] = await query<{ locator: unknown }>(
      `INSERT INTO evidence (brief_field_id, source_id, fragment_id, quote)
       VALUES ($1, $2, $3, 'cita de la hoja') RETURNING locator`,
      [campoId, fuenteA, frag],
    );
    expect(e!.locator).toEqual(locator);
  });

  it('page y slide existentes siguen funcionando: la evidencia sobre un fragmento de PDF/PPTX conserva su ubicación', async () => {
    const pagina = await fragmento(fuenteA, 900011, { page: 3 });
    const diapositiva = await fragmento(fuenteA, 900012, { slide: 8 });
    for (const [frag, esperado] of [
      [pagina, { kind: 'page', page: 3 }],
      [diapositiva, { kind: 'slide', slide: 8 }],
    ] as const) {
      const [e] = await query<{ locator: unknown }>(
        `INSERT INTO evidence (brief_field_id, source_id, fragment_id, quote, page, slide)
         SELECT $1, $2, f.id, 'cita', f.page, f.slide FROM source_fragments f WHERE f.id = $3 RETURNING locator`,
        [campoId, fuenteA, frag],
      );
      expect(e!.locator).toEqual(esperado);
    }
  });

  it('rechaza una evidencia con ubicación inválida', async () => {
    await expect(
      query(
        `INSERT INTO evidence (brief_field_id, source_id, quote, locator) VALUES ($1, $2, 'x', '{"kind":"range"}'::jsonb)`,
        [campoId, fuenteA],
      ),
    ).rejects.toThrow(/evidence_localizador_valido/);
  });

  it('rechaza una evidencia cuyo localizador contradice el de su fragmento', async () => {
    const frag = await fragmento(fuenteA, 900013, { page: 4 });
    await expect(
      query(
        `INSERT INTO evidence (brief_field_id, source_id, fragment_id, quote, locator)
         VALUES ($1, $2, $3, 'x', '{"kind":"page","page":5}'::jsonb)`,
        [campoId, fuenteA, frag],
      ),
    ).rejects.toThrow(/no coincide/);
  });

  it('rechaza una evidencia que cita un fragmento de OTRA fuente', async () => {
    const deB = await fragmento(fuenteB, 900014, { page: 1 });
    await expect(
      query(`INSERT INTO evidence (brief_field_id, source_id, fragment_id, quote) VALUES ($1, $2, $3, 'x')`, [
        campoId,
        fuenteA,
        deB,
      ]),
    ).rejects.toThrow(/otra fuente/);
  });

  it('la evidencia histórica sin ubicación sigue siendo legible (no se reescribe)', async () => {
    const [e] = await query<{ id: string; locator: unknown }>(
      `INSERT INTO evidence (brief_field_id, source_id, quote) VALUES ($1, $2, 'cita manual sin ubicación') RETURNING id, locator`,
      [campoId, fuenteA],
    );
    expect(e!.locator).toBeNull();
    const campos = await verCamposDeVersion(admin, versionId);
    expect(campos.ok).toBe(true);
    if (campos.ok) {
      const ev = campos.value
        .flatMap((c) => c.evidencias)
        .find((x) => x.quote === 'cita manual sin ubicación');
      expect(ev).toBeDefined();
      expect(ev!.locator).toBeNull();
    }
  });

  it('al leer el brief, la evidencia trae su localizador (hoja de cálculo y legacy, derivado)', async () => {
    const hoja = await fragmento(fuenteA, 900020, {
      section: 'Influencers',
      locator: {
        kind: 'range',
        sheet: 'Influencers',
        range: 'A14:G14',
        rowStart: 14,
        rowEnd: 14,
        colStart: 1,
        colEnd: 7,
      },
    });
    await query(
      `INSERT INTO evidence (brief_field_id, source_id, fragment_id, quote) VALUES ($1, $2, $3, 'fila 14')`,
      [campoId, fuenteA, hoja],
    );
    // Evidencia legacy (solo columnas): el localizador se deriva al leer.
    await query(
      `INSERT INTO evidence (brief_field_id, source_id, quote, page) VALUES ($1, $2, 'legacy', 7)`,
      [campoId, fuenteA],
    );
    const campos = await verCamposDeVersion(admin, versionId);
    if (!campos.ok) throw new Error(campos.error.message);
    const todas = campos.value.flatMap((c) => c.evidencias);
    expect(todas.find((e) => e.quote === 'fila 14')!.locator).toMatchObject({
      kind: 'range',
      sheet: 'Influencers',
      range: 'A14:G14',
    });
    expect(todas.find((e) => e.quote === 'legacy')!.locator).toEqual({ kind: 'page', page: 7 });
  });

  it('una versión nueva copia la evidencia con su localizador', async () => {
    const [c] = await query<{ id: string }>(
      `INSERT INTO campaigns (organization_id, name, owner_id, created_by) VALUES ($1, $2, $3, $3) RETURNING id`,
      [admin.organizationId, `Localizador versión · ${sufijo}`, admin.id],
    );
    campanas.push(c!.id);
    const creado = await crearBriefManual(admin, c!.id);
    if (!creado.ok) throw new Error(creado.error.message);
    const [campo] = await query<{ id: string }>(
      `SELECT id FROM brief_fields WHERE brief_version_id = $1 AND campaign_product_id IS NULL ORDER BY key LIMIT 1`,
      [creado.value.versionId],
    );
    const [f] = await query<{ id: string }>(
      `INSERT INTO source_documents (campaign_id, organization_id, type, filename, file_id, mime_type, size_bytes, hash, status, created_by)
       VALUES ($1, $2, 'otro', 'v.xlsx', 'test/v.xlsx', 'text/csv', 10, $3, 'procesado', $4) RETURNING id`,
      [c!.id, admin.organizationId, `hash-ver-${sufijo}`, admin.id],
    );
    const locator = {
      kind: 'range',
      sheet: 'H',
      range: 'A2:B3',
      rowStart: 2,
      rowEnd: 3,
      colStart: 1,
      colEnd: 2,
    };
    const [frag] = await query<{ id: string }>(
      `INSERT INTO source_fragments (source_id, ordinal, section, locator, text) VALUES ($1, 1, 'H', $2::jsonb, 't') RETURNING id`,
      [f!.id, JSON.stringify(locator)],
    );
    await query(
      `INSERT INTO evidence (brief_field_id, source_id, fragment_id, quote) VALUES ($1, $2, $3, 'cita')`,
      [campo!.id, f!.id, frag!.id],
    );
    await query(`UPDATE brief_versions SET status = 'approved', approved_at = now() WHERE id = $1`, [
      creado.value.versionId,
    ]);

    const hija = await crearVersionHija(admin, creado.value.versionId);
    if (!hija.ok) throw new Error(hija.error.message);
    const copiada = await query<{ locator: unknown }>(
      `SELECT e.locator FROM evidence e JOIN brief_fields bf ON bf.id = e.brief_field_id WHERE bf.brief_version_id = $1`,
      [hija.value.versionId],
    );
    expect(copiada.map((e) => e.locator)).toEqual([locator]);
  });
});
