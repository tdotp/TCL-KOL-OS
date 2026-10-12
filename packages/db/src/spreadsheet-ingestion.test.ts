/**
 * V2 · Fase 4 — ingestión de hojas de cálculo de punta a punta, con el worker real.
 *
 * Subir un `.xlsx` → el original se conserva → el worker (Python) lo procesa →
 * fragmentos con hoja/rango, estructura normalizada, auditoría, búsqueda y
 * evidencia. También los rechazos al subir y los fallos del worker, y que los
 * formatos existentes (Markdown, PPTX) no cambian.
 *
 * Datos sintéticos (`fixtures/spreadsheets`), campaña propia y desechable. El
 * worker se lanza con `worker.py --once` contra la base `_test`; sin entorno de
 * Python del worker se omite con un aviso explícito (nunca en silencio).
 */

import { obtenerDocumentosParaTcl } from './tcl-projection.ts';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MIME_CSV, MIME_XLSX, describirLocalizador, type Result, type User } from '@tcl-kol-os/domain';
import { closePool, query } from './client.ts';
import { eliminarCampanaDePrueba } from './test-utils.ts';
import { findUserByEmail } from './users.ts';
import { calcularHash, extensionSegura, leerOriginal } from './storage.ts';
import {
  getFragments,
  getSource,
  listSources,
  obtenerRepresentacionNormalizada,
  retrySource,
  setSourceVisibility,
  uploadSource,
} from './sources.ts';
import { buscarEvidencia, buscarTextoEnFuentes } from './search.ts';
import { crearBriefManual } from './manual.ts';
import { verCamposDeVersion } from './extraction.ts';
import { crearZipDePrueba, hayWorkerLocal, procesarColaConWorker } from './worker-test-utils.ts';

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const sufijo = Date.now().toString(36);

let admin: User;
let consultor: User;
let operativo: User;
let cliente: User;
let ajeno: User;
let campanaId: string;
let versionId: string;
let campoId: string;
const campanas: string[] = [];
let hayWorker = false;

function valor<T>(r: Result<T>): T {
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
  return r.value;
}
type Resultado = { readonly ok: true } | { readonly ok: false; readonly error: { readonly code: string } };
const codigo = (r: Resultado) => (r.ok ? undefined : r.error.code);

async function fixture(nombre: string): Promise<Uint8Array> {
  return new Uint8Array(await readFile(join(RAIZ, 'fixtures', 'spreadsheets', nombre)));
}

/** Contenido distinto por corrida: el hash por campaña no choca con cargas previas. */
function conSufijo(texto: string): Uint8Array {
  return new TextEncoder().encode(`${texto}\n<!-- ${sufijo} -->\n`);
}

async function subir(nombre: string, contenido: Uint8Array, tipo?: string) {
  return uploadSource(admin, { campaignId: campanaId, filename: nombre, contenido, tipoDeclarado: tipo });
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
  operativo = (await findUserByEmail('operativo@smartpr.co'))!;
  cliente = (await findUserByEmail('marena@tcl.com'))!;
  ajeno = (await findUserByEmail('ajeno@otraagencia.co'))!;
  hayWorker = hayWorkerLocal();
  if (!hayWorker) {
    console.warn(
      'No hay entorno de Python del worker (services/ai-worker/.venv); se omiten las pruebas con worker real. ' +
        'Créelo con: cd services/ai-worker && python3 -m venv .venv && .venv/bin/pip install -r requirements.txt',
    );
  }
  const [c] = await query<{ id: string }>(
    `INSERT INTO campaigns (organization_id, name, owner_id, created_by) VALUES ($1, $2, $3, $3) RETURNING id`,
    [admin.organizationId, `Ingestión XLSX · ${sufijo}`, admin.id],
  );
  campanaId = c!.id;
  campanas.push(campanaId);
  const brief = valor(await crearBriefManual(admin, campanaId));
  versionId = brief.versionId;
  const [campo] = await query<{ id: string }>(
    `SELECT id FROM brief_fields WHERE brief_version_id = $1 AND campaign_product_id IS NULL ORDER BY key LIMIT 1`,
    [versionId],
  );
  campoId = campo!.id;
});

afterAll(async () => {
  await eliminarCampanaDePrueba(campanas);
  await closePool();
});

// ─────────────────────────── Carga: validación y original ──────────────────────

describe('subir una hoja de cálculo', () => {
  it('acepta un XLSX válido, conserva el ORIGINAL íntegro y encola su procesamiento', async () => {
    const bytes = await fixture('campana-influencers.xlsx');
    const r = valor(await subir(`seguimiento-${sufijo}.xlsx`, bytes, MIME_XLSX));
    expect(r).toMatchObject({ mimeType: MIME_XLSX, encolado: true });

    const fuente = valor(await getSource(admin, r.id));
    expect(fuente).toMatchObject({
      origin: 'file',
      mime_type: MIME_XLSX,
      status: 'pendiente',
      hash: calcularHash(bytes),
    });

    // El original está en el almacenamiento, byte a byte.
    const [fila] = await query<{ file_id: string }>(`SELECT file_id FROM source_documents WHERE id = $1`, [
      r.id,
    ]);
    expect(Buffer.from(await leerOriginal(fila!.file_id)).equals(Buffer.from(bytes))).toBe(true);

    const [auditado] = await auditoria(r.id);
    expect(auditado).toMatchObject({ action: 'source.upload', origin: 'ui' });
    expect(auditado!.metadata).toMatchObject({ hojaDeCalculo: true, encolado: true });
  });

  it('rechaza el mismo libro por contenido, aunque se llame distinto, con SOURCE_ALREADY_EXISTS', async () => {
    const bytes = await fixture('campana-influencers.xlsx');
    const r = await subir(`copia-${sufijo}.xlsx`, bytes, MIME_XLSX);
    expect(codigo(r)).toBe('SOURCE_ALREADY_EXISTS');
    if (!r.ok) expect(r.error.details).toMatchObject({ reason: 'same_content' });
  });

  it('rechaza un libro con macros, una ZIP bomb, un .xls binario y un archivo que no es lo que dice', async () => {
    const wb = '<workbook/>';
    const base = [
      { nombre: '[Content_Types].xml', datos: '<Types/>' },
      { nombre: 'xl/workbook.xml', datos: wb },
    ];
    const antes = valor(await listSources(admin, campanaId)).length;

    const macros = crearZipDePrueba([...base, { nombre: 'xl/vbaProject.bin', datos: new Uint8Array(8) }]);
    expect(codigo(await subir(`macros-${sufijo}.xlsx`, macros))).toBe('INVALID_SPREADSHEET');

    // Pesa poco comprimido pero declara 60 MB descomprimidos: razón de compresión sospechosa.
    const bomba = crearZipDePrueba([
      ...base,
      { nombre: 'xl/worksheets/sheet1.xml', datos: new Uint8Array(16), declarado: 60 * 1024 * 1024 },
    ]);
    expect(codigo(await subir(`bomba-${sufijo}.xlsx`, bomba))).toBe('INVALID_SPREADSHEET');

    const ole = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, ...new Array(300).fill(0)]);
    expect(codigo(await subir(`viejo-${sufijo}.xls`, ole))).toBe('UNSUPPORTED_SOURCE_FORMAT');

    const falso = new TextEncoder().encode(`#!/bin/sh\necho ${sufijo}\n`);
    expect(codigo(await subir(`falso-${sufijo}.xlsx`, falso, MIME_XLSX))).toBe(
      'BRIEF_MISSING_CRITICAL_FIELD',
    );

    // Nada de lo rechazado dejó fuente ni encolado trabajo.
    expect(valor(await listSources(admin, campanaId)).length).toBe(antes);
  });

  it('respeta el límite de tamaño de carga también para hojas de cálculo', async () => {
    const original = process.env['MAX_UPLOAD_MB'];
    process.env['MAX_UPLOAD_MB'] = '0.001';
    try {
      const r = await subir(`grande-${sufijo}.xlsx`, await fixture('campana-influencers.xlsx'), MIME_XLSX);
      expect(codigo(r)).toBe('BRIEF_MISSING_CRITICAL_FIELD');
      if (!r.ok) expect(r.error.message).toContain('límite');
    } finally {
      if (original === undefined) delete process.env['MAX_UPLOAD_MB'];
      else process.env['MAX_UPLOAD_MB'] = original;
    }
  });

  it('la extensión del archivo guardado nunca puede formar una ruta (path traversal)', () => {
    expect(extensionSegura('libro.xlsx')).toBe('.xlsx');
    expect(extensionSegura('LIBRO.XLSX')).toBe('.xlsx');
    expect(extensionSegura('a.tar.gz')).toBe('.gz');
    expect(extensionSegura('sin-extension')).toBe('');
    expect(extensionSegura('termina.')).toBe('');
    for (const hostil of [
      'x./../../../etc/passwd',
      'x.a/b/c',
      'x.\\..\\win',
      'x.%2e%2e',
      'x.p\u0000df',
      'x.' + 'a'.repeat(40),
    ]) {
      const ext = extensionSegura(hostil);
      expect(ext, hostil).toMatch(/^(\.[a-z0-9]{1,10})?$/);
      expect(ext).not.toMatch(/[\\/.]{2}|[\\/]/);
    }
  });
});

// ─────────────────────────── Worker: procesamiento ─────────────────────────────

describe('procesar una hoja de cálculo (worker real)', () => {
  it('produce fragmentos con hoja y rango exactos, estructura normalizada y auditoría', async () => {
    if (!hayWorker) return;
    const [fuenteFila] = await query<{ id: string }>(
      `SELECT id FROM source_documents WHERE campaign_id = $1 AND filename = $2`,
      [campanaId, `seguimiento-${sufijo}.xlsx`],
    );
    const sourceId = fuenteFila!.id;

    const corrida = await procesarColaConWorker();
    expect(corrida.codigo, corrida.salida).toBe(0);

    const fuente = valor(await getSource(admin, sourceId));
    expect(fuente.status).toBe('procesado');
    expect(fuente.fragmentos).toBeGreaterThan(1);
    expect(fuente.job_status).toBe('completado');

    // Todo fragmento sabe su hoja y su rango; el rango coincide con las filas del texto.
    const fragmentos = valor(await getFragments(admin, sourceId, 1000));
    for (const f of fragmentos) {
      expect(f.locator?.kind).toBe('range');
      if (f.locator?.kind !== 'range') continue;
      expect(['Influencers', 'Producto']).toContain(f.locator.sheet);
      const filas = [...f.text.matchAll(/^Fila (\d+)$/gm)].map((m) => Number(m[1]));
      expect(filas[0]).toBe(f.locator.rowStart);
      expect(filas[filas.length - 1]).toBe(f.locator.rowEnd);
    }

    // La relación cabecera → valor se conserva en el texto.
    const deValentina = fragmentos.find((f) => f.text.includes('Valentina Rojas'))!;
    expect(deValentina.text).toContain('Nombre: Valentina Rojas');
    expect(deValentina.text).toContain('Instagram: @valentina');
    expect(deValentina.text).toContain('Entregable: Reel principal');
    expect(deValentina.text).toContain('Publicación: 2026-10-20'); // fecha → ISO
    expect(deValentina.text).toContain('Activo: TRUE'); // booleano consistente
    expect(deValentina.locator).toMatchObject({ kind: 'range', sheet: 'Influencers' });
    if (deValentina.locator?.kind === 'range') {
      expect(deValentina.locator.rowStart).toBeLessThanOrEqual(14);
      expect(deValentina.locator.rowEnd).toBe(14);
    }
    // Las columnas legacy conservan algo legible (la hoja) para quien aún las lea.
    expect(deValentina.section).toBe('Influencers');
    expect(deValentina.page).toBeNull();
    expect(deValentina.slide).toBeNull();

    // Estructura normalizada: hojas, cabeceras y rangos.
    const rep = valor(await obtenerRepresentacionNormalizada(admin, sourceId));
    expect(rep.original).toMatchObject({ origin: 'file', mimeType: MIME_XLSX });
    expect(rep.estructura?.format).toBe('xlsx');
    const hojas = (rep.estructura!.content['sheets'] as Array<Record<string, unknown>>).map((h) => h['name']);
    expect(hojas).toEqual(['Influencers', 'Producto']);
    const producto = (rep.estructura!.content['sheets'] as Array<Record<string, unknown>>)[1]!;
    expect(producto).toMatchObject({ headerRow: 6, rowCount: 6 });
    expect(rep.fragmentos.total).toBe(fragmentos.length);

    // Auditoría: subida (ui) e ingestión completada (sistema, sin actor).
    const eventos = await auditoria(sourceId);
    expect(eventos.map((e) => e.action)).toEqual(['source.upload', 'source.ingest_completed']);
    expect(eventos[1]).toMatchObject({ origin: 'system', actor_id: null });
    expect(eventos[1]!.metadata).toMatchObject({ hojas: 2, mimeType: MIME_XLSX });
  });

  it('la búsqueda encuentra el contenido de la hoja y llega a hoja + fila', async () => {
    if (!hayWorker) return;
    const hits = valor(await buscarTextoEnFuentes(admin, { campaignId: campanaId, texto: 'valentina' }));
    expect(hits.length).toBeGreaterThan(0);
    const hit = hits.find((h) => h.text.includes('Valentina Rojas'))!;
    expect(hit.locator).toMatchObject({ kind: 'range', sheet: 'Influencers' });
    expect(describirLocalizador(hit.locator!)).toMatch(/^hoja «Influencers», rango A\d+:G14$/);

    // Sin coincidencias → vacío; texto demasiado corto → error de validación.
    expect(
      valor(await buscarTextoEnFuentes(admin, { campaignId: campanaId, texto: 'zzz-no-existe' })),
    ).toEqual([]);
    expect(codigo(await buscarTextoEnFuentes(admin, { campaignId: campanaId, texto: 'a' }))).toBe(
      'VALIDATION_FAILED',
    );
    // Los comodines LIKE no se interpretan: «%» busca un «%» literal.
    expect(valor(await buscarTextoEnFuentes(admin, { campaignId: campanaId, texto: '%%' }))).toEqual([]);
  });

  it('la búsqueda vectorial devuelve el localizador de hoja de un fragmento indexado', async () => {
    if (!hayWorker) return;
    const [frag] = await query<{ id: string; source_id: string }>(
      `SELECT f.id, f.source_id FROM source_fragments f JOIN source_documents s ON s.id = f.source_id
        WHERE s.campaign_id = $1 AND f.text LIKE '%Valentina Rojas%' LIMIT 1`,
      [campanaId],
    );
    const vector = Array.from({ length: 1536 }, (_, i) => (i === 7 ? 1 : 0));
    await query(`UPDATE source_fragments SET embedding = $2::vector WHERE id = $1`, [
      frag!.id,
      `[${vector.join(',')}]`,
    ]);
    const hits = await buscarEvidencia({
      organizationId: admin.organizationId,
      campaignId: campanaId,
      vector,
      limite: 3,
    });
    expect(hits[0]).toMatchObject({ fragmentId: frag!.id, locator: { kind: 'range', sheet: 'Influencers' } });
  });

  it('la evidencia puede apuntar a un fragmento de la hoja y vuelve con su rango', async () => {
    if (!hayWorker) return;
    const [frag] = await query<{ id: string; source_id: string }>(
      `SELECT f.id, f.source_id FROM source_fragments f JOIN source_documents s ON s.id = f.source_id
        WHERE s.campaign_id = $1 AND f.text LIKE '%Brillo%' LIMIT 1`,
      [campanaId],
    );
    await query(
      `INSERT INTO evidence (brief_field_id, source_id, fragment_id, quote) VALUES ($1, $2, $3, 'Brillo')`,
      [campoId, frag!.source_id, frag!.id],
    );
    const campos = valor(await verCamposDeVersion(admin, versionId));
    const ev = campos.flatMap((c) => c.evidencias).find((e) => e.quote === 'Brillo')!;
    expect(ev.locator).toMatchObject({ kind: 'range', sheet: 'Producto' });
    expect(describirLocalizador(ev.locator!)).toMatch(/^hoja «Producto», rango A7:D\d+$/);
  });

  it('reprocesar es idempotente: mismos fragmentos, una sola estructura', async () => {
    if (!hayWorker) return;
    const [{ id: sourceId }] = (await query<{ id: string }>(
      `SELECT id FROM source_documents WHERE campaign_id = $1 AND filename = $2`,
      [campanaId, `seguimiento-${sufijo}.xlsx`],
    )) as [{ id: string }];
    const antes = valor(await getSource(admin, sourceId)).fragmentos;

    valor(await retrySource(admin, sourceId));
    const corrida = await procesarColaConWorker();
    expect(corrida.codigo, corrida.salida).toBe(0);

    expect(valor(await getSource(admin, sourceId)).fragmentos).toBe(antes);
    expect(await query(`SELECT 1 FROM source_representations WHERE source_id = $1`, [sourceId])).toHaveLength(
      1,
    );
    expect((await auditoria(sourceId)).map((e) => e.action)).toEqual([
      'source.upload',
      'source.ingest_completed',
      'source.retry',
      'source.ingest_completed',
    ]);
  });

  it('visibilidad: el cliente nunca lee filas ni fragmentos de una hoja (ni interna ni expuesta); el personal sí', async () => {
    if (!hayWorker) return;
    const [{ id: sourceId }] = (await query<{ id: string }>(
      `SELECT id FROM source_documents WHERE campaign_id = $1 AND filename = $2`,
      [campanaId, `seguimiento-${sufijo}.xlsx`],
    )) as [{ id: string }];
    await query(`UPDATE campaigns SET visibility = 'tcl' WHERE id = $1`, [campanaId]);
    try {
      // Fase 9 (ciclo QA): el cliente ya no tiene `source:read_shared`: ni fragmentos, ni búsqueda, ni representación,
      // ni el listado, estén o no expuestas. Lo compartido a propósito lo ve por la proyección TCL (solo metadatos).
      const leer = async () => {
        expect(codigo(await getFragments(cliente, sourceId))).toBe('FORBIDDEN_ROLE');
        expect(codigo(await obtenerRepresentacionNormalizada(cliente, sourceId))).toBe('FORBIDDEN_ROLE');
        expect(
          codigo(await buscarTextoEnFuentes(cliente, { campaignId: campanaId, texto: 'Valentina' })),
        ).toBe('FORBIDDEN_ROLE');
        expect(codigo(await listSources(cliente, campanaId))).toBe('FORBIDDEN_ROLE');
      };
      await leer();
      // Operativo (SmartPR) sí; otra agencia no.
      expect((await getFragments(operativo, sourceId)).ok).toBe(true);
      expect(codigo(await getFragments(ajeno, sourceId))).toBe('RESOURCE_NOT_FOUND');

      valor(await setSourceVisibility(consultor, sourceId, 'tcl'));
      await leer();
      const docs = await obtenerDocumentosParaTcl(cliente, campanaId);
      expect(docs.ok && docs.value.some((d) => d.sourceId === sourceId)).toBe(true);
    } finally {
      await query(`UPDATE campaigns SET visibility = 'interna' WHERE id = $1`, [campanaId]);
    }
  });
});

describe('imágenes: se conservan, pero no se inventa texto', () => {
  it('un PNG queda guardado y disponible, sin trabajo, sin fragmentos y con el aviso de que falta extracción visual', async () => {
    const png = new Uint8Array([
      0x89,
      0x50,
      0x4e,
      0x47,
      0x0d,
      0x0a,
      0x1a,
      0x0a,
      ...new Array(64).fill(sufijo.length),
    ]);
    const r = valor(await subir(`imagen-${sufijo}.png`, png));
    expect(r).toMatchObject({ mimeType: 'image/png', encolado: false });
    expect(r.aviso).toMatch(/OCR/);

    const fuente = valor(await getSource(admin, r.id));
    expect(fuente).toMatchObject({ origin: 'file', status: 'procesado', fragmentos: 0 });
    const [fila] = await query<{ file_id: string }>(`SELECT file_id FROM source_documents WHERE id = $1`, [
      r.id,
    ]);
    expect(Buffer.from(await leerOriginal(fila!.file_id)).equals(Buffer.from(png))).toBe(true);
    expect(await query(`SELECT 1 FROM processing_jobs WHERE source_id = $1`, [r.id])).toHaveLength(0);
    expect(await query(`SELECT 1 FROM source_fragments WHERE source_id = $1`, [r.id])).toHaveLength(0);
    // Ningún texto salió de la imagen: no hay nada que buscar en ella.
    const rep = valor(await obtenerRepresentacionNormalizada(admin, r.id));
    expect(rep.fragmentos).toEqual({ total: 0, items: [] });
    expect(rep.estructura).toBeNull();
  });
});

describe('fallos y otros formatos (worker real)', () => {
  it('un libro dañado que pasó la carga falla limpiamente, sin reintentos inútiles, y se audita', async () => {
    if (!hayWorker) return;
    const danado = crearZipDePrueba([
      { nombre: '[Content_Types].xml', datos: '<Types/>' },
      {
        nombre: 'xl/workbook.xml',
        datos:
          '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
          'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
          '<sheets><sheet name="Datos" sheetId="1" r:id="rId1"/></sheets></workbook>',
      },
      {
        nombre: 'xl/_rels/workbook.xml.rels',
        datos:
          '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
          '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
          '</Relationships>',
      },
      { nombre: 'xl/worksheets/sheet1.xml', datos: `<worksheet><sheetData><row r="1"><c r="A1"` },
      { nombre: `sello-${sufijo}.txt`, datos: sufijo },
    ]);
    const r = valor(await subir(`danado-${sufijo}.xlsx`, danado, MIME_XLSX));
    const corrida = await procesarColaConWorker();
    expect(corrida.codigo, corrida.salida).toBe(0);

    const fuente = valor(await getSource(admin, r.id));
    expect(fuente.status).toBe('fallido');
    expect(fuente.job_intentos).toBe(1); // determinista: no se agotan los reintentos con backoff
    expect(fuente.job_error).toMatch(/dañad/);
    expect(fuente.job_error).not.toMatch(/Traceback|File "/); // sin trazas internas

    const fallo = (await auditoria(r.id)).find((e) => e.action === 'source.ingest_failed')!;
    expect(fallo).toMatchObject({ origin: 'system', actor_id: null });
    expect(fallo.metadata).toMatchObject({ codigo: 'SPREADSHEET_PARSE_FAILED' });
    expect(await query(`SELECT 1 FROM source_fragments WHERE source_id = $1`, [r.id])).toHaveLength(0);
  });

  it('un CSV se procesa con la misma forma que una hoja', async () => {
    if (!hayWorker) return;
    const csv = new TextEncoder().encode(
      `Nombre;Producto;Fee\nValentina Rojas;C7K;${Date.now()}\nMateo Díaz;X955;900000\n`,
    );
    const r = valor(await subir(`datos-${sufijo}.csv`, csv, MIME_CSV));
    expect(r.mimeType).toBe(MIME_CSV);
    await procesarColaConWorker();
    const fragmentos = valor(await getFragments(admin, r.id));
    expect(fragmentos[0]!.locator).toMatchObject({ kind: 'range', sheet: 'CSV', range: 'A2:C3' });
    expect(fragmentos[0]!.text).toContain('Producto: C7K');
  });

  it('los formatos existentes no cambian: Markdown y PPTX conservan sus columnas y reciben un localizador derivado', async () => {
    if (!hayWorker) return;
    const md = valor(
      await subir(`brief-${sufijo}.md`, conSufijo('# El Reto\n\nLanzar el C7K.\n\n## Audiencia\n\nJóvenes.')),
    );
    const pptxBytes = new Uint8Array(
      await readFile(join(RAIZ, 'fixtures', 'pipeline', 'documento-de-prueba.pptx')),
    );
    const pptx = await subir(`deck-${sufijo}.pptx`, pptxBytes);
    await procesarColaConWorker();

    const deMd = valor(await getFragments(admin, md.id));
    expect(deMd[0]).toMatchObject({ section: 'El Reto', page: null, slide: null });
    expect(deMd[0]!.locator).toMatchObject({ kind: 'section', section: 'El Reto' });
    expect(valor(await obtenerRepresentacionNormalizada(admin, md.id)).estructura).toBeNull();

    if (pptx.ok) {
      const deDeck = valor(await getFragments(admin, pptx.value.id));
      expect(deDeck.length).toBeGreaterThan(0);
      for (const f of deDeck) {
        expect(f.slide).not.toBeNull();
        expect(f.locator).toMatchObject({ kind: 'slide', slide: f.slide });
      }
    }
  });
});
