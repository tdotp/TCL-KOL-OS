/**
 * Épica E4 · Carga de fuentes contra base real.
 *
 * Cubre los casos S-05 (MIME falsificado), S-06 (tamaño excesivo), F-10
 * (duplicado por hash) y la idempotencia de E4-10.
 *
 * El procesamiento en sí lo prueban los tests del worker en Python; aquí se
 * verifica el contrato de carga: qué entra, qué se rechaza y qué se encola.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { User } from '@tcl-kol-os/domain';
import { closePool, query } from './client.ts';
import { findUserByEmail } from './users.ts';
import { listSources, uploadSource } from './sources.ts';

let admin: User;
let consultor: User;
let cliente: User;
let campanaId: string;

/** PDF mínimo pero válido: cabecera real, no una extensión mentida. */
function pdfValido(marca: string): Uint8Array {
  return new TextEncoder().encode(`%PDF-1.4\n% ${marca}\n1 0 obj\n<<>>\nendobj\ntrailer\n%%EOF\n`);
}

beforeAll(async () => {
  admin = (await findUserByEmail('gerardo@smartpr.co'))!;
  consultor = (await findUserByEmail('consultor@smartpr.co'))!;
  cliente = (await findUserByEmail('marena@tcl.com'))!;

  const filas = await query<{ id: string }>(`SELECT id FROM campaigns WHERE name = 'Lanzamiento C7L'`);
  campanaId = filas[0]!.id;
});

afterAll(async () => {
  await query(`DELETE FROM source_documents WHERE filename LIKE 'test-%'`);
  await closePool();
});

// ─────────────────────────── Caso S-05 ────────────────────────────────────────

describe('validación por contenido real (caso S-05)', () => {
  it('rechaza un ejecutable renombrado como PDF', async () => {
    const elf = new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00, ...new Array(64).fill(0)]);

    const resultado = await uploadSource(admin, {
      campaignId: campanaId,
      filename: 'test-ficha-tecnica.pdf',
      contenido: elf,
      tipoDeclarado: 'application/pdf',
    });

    expect(resultado.ok).toBe(false);
    if (!resultado.ok) expect(resultado.error.message).toContain('No se reconoce');
  });

  it('rechaza un archivo cuyo contenido no es reconocible', async () => {
    const basura = new TextEncoder().encode('esto no es ningún formato conocido');
    const resultado = await uploadSource(admin, {
      campaignId: campanaId,
      filename: 'test-basura.docx',
      contenido: basura,
    });
    expect(resultado.ok).toBe(false);
  });

  it('acepta un PDF legítimo aunque el navegador declare otro tipo', async () => {
    const resultado = await uploadSource(admin, {
      campaignId: campanaId,
      filename: 'test-declarado-mal.pdf',
      contenido: pdfValido('declarado-mal'),
      tipoDeclarado: 'application/octet-stream',
    });

    expect(resultado.ok).toBe(true);
    if (resultado.ok) {
      expect(resultado.value.mimeType).toBe('application/pdf');
      // La discrepancia se informa, no bloquea.
      expect(resultado.value.aviso).toContain('no coincide');
    }
  });
});

// ─────────────────────────── Caso S-06 ────────────────────────────────────────

describe('límite de tamaño (caso S-06)', () => {
  it('rechaza un archivo por encima del límite sin tumbar nada', async () => {
    const original = process.env['MAX_UPLOAD_MB'];
    process.env['MAX_UPLOAD_MB'] = '1';

    // 2 MB de PDF válido.
    const grande = new Uint8Array(2 * 1024 * 1024);
    grande.set(new TextEncoder().encode('%PDF-1.4\n'), 0);

    const resultado = await uploadSource(admin, {
      campaignId: campanaId,
      filename: 'test-enorme.pdf',
      contenido: grande,
    });

    process.env['MAX_UPLOAD_MB'] = original;

    expect(resultado.ok).toBe(false);
    if (!resultado.ok) expect(resultado.error.message).toContain('límite es 1 MB');
  });
});

// ─────────────────────────── Duplicados (F-10) ────────────────────────────────

describe('detección de duplicados por hash (E4-3, caso F-10)', () => {
  it('el mismo contenido con distinto nombre se detecta como duplicado', async () => {
    const contenido = pdfValido('duplicado');

    const primera = await uploadSource(admin, {
      campaignId: campanaId,
      filename: 'test-brief-v1.pdf',
      contenido,
    });
    expect(primera.ok).toBe(true);

    const segunda = await uploadSource(admin, {
      campaignId: campanaId,
      filename: 'test-brief-FINAL-definitivo.pdf',
      contenido,
    });

    expect(segunda.ok).toBe(false);
    if (!segunda.ok) {
      // El mensaje nombra el archivo original: es lo que el consultor necesita
      // para entender que no perdió nada.
      expect(segunda.error.message).toContain('test-brief-v1.pdf');
      expect(segunda.error.message).toContain('aunque el nombre difiera');
    }
  });
});

// ─────────────────────────── Encolado (E4-4) ──────────────────────────────────

describe('encolado del procesamiento (E4-4)', () => {
  it('un PDF queda pendiente y con job en cola', async () => {
    const resultado = await uploadSource(admin, {
      campaignId: campanaId,
      filename: 'test-encolado.pdf',
      contenido: pdfValido('encolado'),
    });

    expect(resultado.ok).toBe(true);
    if (!resultado.ok) return;
    expect(resultado.value.encolado).toBe(true);

    const jobs = await query<{ status: string; intentos: number }>(
      `SELECT status, intentos FROM processing_jobs WHERE source_id = $1`,
      [resultado.value.id],
    );
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.status).toBe('pendiente');
  });

  it('una imagen se conserva pero no se encola: su OCR llega en E4-7', async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...new Array(64).fill(0)]);

    const resultado = await uploadSource(admin, {
      campaignId: campanaId,
      filename: 'test-referencia.png',
      contenido: png,
    });

    expect(resultado.ok).toBe(true);
    if (!resultado.ok) return;
    expect(resultado.value.encolado).toBe(false);
    expect(resultado.value.aviso).toContain('OCR');

    const jobs = await query(`SELECT id FROM processing_jobs WHERE source_id = $1`, [resultado.value.id]);
    expect(jobs).toHaveLength(0);
  });

  it('el índice parcial impide dos jobs activos para el mismo documento (E4-10)', async () => {
    const resultado = await uploadSource(admin, {
      campaignId: campanaId,
      filename: 'test-un-solo-job.pdf',
      contenido: pdfValido('un-solo-job'),
    });
    expect(resultado.ok).toBe(true);
    if (!resultado.ok) return;

    await expect(
      query(`INSERT INTO processing_jobs (source_id) VALUES ($1)`, [resultado.value.id]),
    ).rejects.toThrow();
  });
});

// ─────────────────────────── Permisos ─────────────────────────────────────────

describe('permisos sobre fuentes', () => {
  it('el cliente TCL no puede cargar fuentes', async () => {
    const resultado = await uploadSource(cliente, {
      campaignId: campanaId,
      filename: 'test-del-cliente.pdf',
      contenido: pdfValido('cliente'),
    });

    expect(resultado.ok).toBe(false);
    if (!resultado.ok) expect(resultado.error.code).toBe('FORBIDDEN_ROLE');
  });

  it('el consultor sí puede cargar fuentes', async () => {
    const resultado = await uploadSource(consultor, {
      campaignId: campanaId,
      filename: 'test-del-consultor.pdf',
      contenido: pdfValido('consultor'),
    });
    expect(resultado.ok).toBe(true);
  });

  it('no se pueden cargar fuentes en una campaña de otra organización', async () => {
    const ajenas = await query<{ id: string }>(
      `SELECT id FROM campaigns WHERE name = 'Campaña confidencial de otra agencia'`,
    );

    const resultado = await uploadSource(admin, {
      campaignId: ajenas[0]!.id,
      filename: 'test-intruso.pdf',
      contenido: pdfValido('intruso'),
    });

    expect(resultado.ok).toBe(false);
    if (!resultado.ok) expect(resultado.error.code).toBe('RESOURCE_NOT_FOUND');
  });

  it('el listado de fuentes respeta el aislamiento', async () => {
    const ajenas = await query<{ id: string }>(
      `SELECT id FROM campaigns WHERE name = 'Campaña confidencial de otra agencia'`,
    );
    const resultado = await listSources(admin, ajenas[0]!.id);

    expect(resultado.ok).toBe(false);
    if (!resultado.ok) expect(resultado.error.code).toBe('RESOURCE_NOT_FOUND');
  });
});

// ─────────────────────────── Auditoría ────────────────────────────────────────

describe('auditoría de la carga', () => {
  it('cargar una fuente deja rastro con actor y metadatos', async () => {
    const resultado = await uploadSource(admin, {
      campaignId: campanaId,
      filename: 'test-auditada.pdf',
      contenido: pdfValido(`auditada-${Date.now()}`),
    });
    expect(resultado.ok).toBe(true);
    if (!resultado.ok) return;

    const eventos = await query<{ action: string; actor_id: string; metadata: Record<string, unknown> }>(
      `SELECT action, actor_id, metadata FROM audit_events WHERE entity_id = $1`,
      [resultado.value.id],
    );

    expect(eventos).toHaveLength(1);
    expect(eventos[0]!.action).toBe('source.upload');
    expect(eventos[0]!.actor_id).toBe(admin.id);
    expect(eventos[0]!.metadata['encolado']).toBe(true);
  });
});
