/**
 * V2 · Fase 8 (W1c) — `excluirEvidenciaOperativa`: las fuentes `type = 'soporte_operativo'` (evidencia de la
 * operación) NO aparecen en las lecturas generales de fuentes para NINGÚN rol, ni en la búsqueda (vectorial y
 * textual), la extracción, el contexto del agente ni los adjuntos del chat; y `uploadSource` no puede crearlas.
 *
 * La fuente de evidencia se crea por SQL directo respetando los triggers de la 031 (archivo, interna, sensible,
 * procesada, sin job ni fragmentos). Para probar que la APLICACIÓN también excluye (defensa en profundidad), un
 * fragmento «fantasma» se inserta saltando los triggers (`session_replication_role = replica`, solo bases `_test`
 * con superusuario): si la prueba no puede hacerlo, esos casos se omiten.
 */

import { createHash, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Result, User } from '@tcl-kol-os/domain';
import { esLegibleParaIA, registrarAdjuntoDeArchivo } from './agent-context.ts';
import { crearConversacion } from './chat-conversations.ts';
import { publicarMensaje } from './chat-messages.ts';
import { closePool, getPool, query, transaction } from './client.ts';
import { extraerCampos } from './extraction.ts';
import { buscarEvidencia, buscarTextoEnFuentes, estadoDelIndice } from './search.ts';
import {
  getFragments,
  getSource,
  listSources,
  obtenerRepresentacionNormalizada,
  registerLinkedSource,
  retrySource,
  setSourceVisibility,
  uploadSource,
} from './sources.ts';
import {
  CONFIG_DE_RUN_DE_PRUEBA,
  type EscenarioDeContenido,
  crearEscenarioDeContenido,
  crearFragmentoDePrueba,
  crearFuenteDePrueba,
  limpiarEscenarioDeContenido,
} from './test-utils.ts';

const DIMENSIONES = 1536;
const VECTOR = Array.from({ length: DIMENSIONES }, (_, i) => Math.sin(i / 97));
const LITERAL_VECTOR = `[${VECTOR.join(',')}]`;
const CENTINELA = `centinela-evidencia-${randomBytes(4).toString('hex')}`;

let e: EscenarioDeContenido;
/** Fuente de evidencia operativa (sin fragmentos). */
let evidencia: string;
/** Fuente de evidencia con el MISMO contenido que un archivo que se intentará subir. */
let evidenciaConHash: string;
const contenidoDuplicado = new TextEncoder().encode(
  `%PDF-1.4\n% evidencia-${randomBytes(6).toString('hex')}\n1 0 obj\n<<>>\nendobj\ntrailer\n%%EOF\n`,
);
/** Fuente normal de control (misma campaña, con fragmento, vectorizado). */
let control: string;
/** Campaña SIN fuentes normales: solo evidencia (para la extracción). */
let campanaSoloEvidencia: string;
let puedeForjar = false;
/** Evidencia operativa NO sensible con fragmento (forjada saltando los triggers). */
let forjada = '';

function valor<T>(r: Result<T>): T {
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
  return r.value;
}
const codigo = (r: Result<unknown>): string => (r.ok ? 'ok' : r.error.code);

async function crearSoporte(campaignId: string, hash?: string): Promise<string> {
  const unica = `soporte-${Date.now().toString(36)}${randomBytes(3).toString('hex')}`;
  const [f] = await query<{ id: string }>(
    `INSERT INTO source_documents
       (campaign_id, organization_id, type, filename, file_id, mime_type, size_bytes, hash, status,
        confidentiality_level, visibility, created_by)
     VALUES ($1, $2, 'soporte_operativo', $3, $4, 'application/pdf', 1234, $5, 'procesado', 'sensible', 'interna', $6)
     RETURNING id`,
    [
      campaignId,
      e.admin.organizationId,
      `${unica}.pdf`,
      `test/${unica}.pdf`,
      hash ?? createHash('sha256').update(unica).digest('hex'),
      e.admin.id,
    ],
  );
  return f!.id;
}

/**
 * Fuente `soporte_operativo` NO sensible, con un fragmento vectorizado, que salta los triggers de la base
 * (solo para probar que la APLICACIÓN la excluye por sí sola, sin apoyarse en `sensible` ni en los triggers).
 */
async function forjarFuenteConFragmento(campaignId: string, locator: unknown): Promise<string> {
  return transaction(async (c) => {
    await c.query(`SET LOCAL session_replication_role = replica`);
    const unica = `forjada-${Date.now().toString(36)}${randomBytes(3).toString('hex')}`;
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO source_documents
         (campaign_id, organization_id, type, filename, file_id, mime_type, size_bytes, hash, status,
          confidentiality_level, visibility, created_by)
       VALUES ($1, $2, 'soporte_operativo', $3, $4, 'application/pdf', 10, $5, 'procesado', 'interna', 'interna', $6)
       RETURNING id`,
      [
        campaignId,
        e.admin.organizationId,
        `${unica}.pdf`,
        `test/${unica}.pdf`,
        createHash('sha256').update(unica).digest('hex'),
        e.admin.id,
      ],
    );
    const id = rows[0]!.id;
    await c.query(
      `INSERT INTO source_fragments (source_id, ordinal, page, text, embedding, locator)
       VALUES ($1, 1, 1, $2, $3::vector, $4::jsonb)`,
      [id, `Texto de evidencia ${CENTINELA}`, LITERAL_VECTOR, JSON.stringify(locator)],
    );
    return id;
  });
}

beforeAll(async () => {
  e = await crearEscenarioDeContenido('F8 guardas de fuentes');
  evidencia = await crearSoporte(e.campanaId);
  evidenciaConHash = await crearSoporte(
    e.campanaId,
    createHash('sha256').update(contenidoDuplicado).digest('hex'),
  );

  control = await crearFuenteDePrueba(e.campanaId, e.admin, `control-${CENTINELA}`);
  await crearFragmentoDePrueba(control, 1, `Texto de control ${CENTINELA}`);
  await query(`UPDATE source_fragments SET embedding = $2::vector WHERE source_id = $1`, [
    control,
    LITERAL_VECTOR,
  ]);
  const [fragmento] = await query<{ locator: unknown }>(
    `SELECT locator FROM source_fragments WHERE source_id = $1`,
    [control],
  );

  const [campana] = await query<{ id: string }>(
    `INSERT INTO campaigns (organization_id, name, owner_id, created_by) VALUES ($1, $2, $3, $3) RETURNING id`,
    [e.admin.organizationId, `F8 solo evidencia ${e.sufijo}`, e.admin.id],
  );
  campanaSoloEvidencia = campana!.id;
  e.campanas.push(campanaSoloEvidencia);

  try {
    forjada = await forjarFuenteConFragmento(e.campanaId, fragmento!.locator);
    await forjarFuenteConFragmento(campanaSoloEvidencia, fragmento!.locator);
    puedeForjar = true;
  } catch {
    puedeForjar = false;
  }
});

afterAll(async () => {
  await limpiarEscenarioDeContenido(e);
  await closePool();
});

function roles(): ReadonlyArray<readonly [string, User]> {
  return [
    ['admin', e.admin],
    ['director', e.director],
    ['consultor', e.consultor],
    ['operativo', e.operativo],
    ['analista', e.analista],
    ['legal', e.legal],
  ];
}

describe('la fuente de evidencia respeta la 031', () => {
  it('es archivo, interna, sensible y procesada; no admite job ni fragmentos', async () => {
    const [f] = await query<{
      origin: string;
      visibility: string;
      confidentiality_level: string;
      status: string;
    }>(
      `SELECT origin::text, visibility::text, confidentiality_level::text, status::text
         FROM source_documents WHERE id = $1`,
      [evidencia],
    );
    expect(f).toEqual({
      origin: 'file',
      visibility: 'interna',
      confidentiality_level: 'sensible',
      status: 'procesado',
    });
    await expect(query(`INSERT INTO processing_jobs (source_id) VALUES ($1)`, [evidencia])).rejects.toThrow(
      /no se procesa/u,
    );
    await expect(
      query(`INSERT INTO source_fragments (source_id, ordinal, page, text) VALUES ($1, 1, 1, 'x')`, [
        evidencia,
      ]),
    ).rejects.toThrow(/no se procesa|sin trabajos/u);
  });
});

describe('lecturas de fuentes: ningún rol ve la evidencia operativa', () => {
  it('listSources no la incluye (y sí la fuente normal de control)', async () => {
    for (const [nombre, actor] of roles()) {
      const r = await listSources(actor, e.campanaId);
      if (!r.ok) continue; // un rol sin source:read no ve nada: tampoco la evidencia
      const ids = r.value.map((s) => s.id);
      expect(ids, nombre).not.toContain(evidencia);
      expect(ids, nombre).not.toContain(evidenciaConHash);
      expect(ids, nombre).toContain(control);
    }
    // El cliente (TCL) tampoco: o no accede, o no la ve.
    const cliente = await listSources(e.cliente, e.campanaId);
    if (cliente.ok) expect(cliente.value.map((s) => s.id)).not.toContain(evidencia);
  });

  it('getSource, getFragments y la representación normalizada responden RESOURCE_NOT_FOUND', async () => {
    for (const [nombre, actor] of [...roles(), ['cliente', e.cliente] as const]) {
      const una = await getSource(actor, evidencia);
      expect(una.ok, nombre).toBe(false);
      if (!una.ok && nombre !== 'analista' && nombre !== 'legal' && nombre !== 'cliente') {
        expect(una.error.code, nombre).toBe('RESOURCE_NOT_FOUND');
      }
      expect((await getFragments(actor, evidencia)).ok, nombre).toBe(false);
      expect((await obtenerRepresentacionNormalizada(actor, evidencia)).ok, nombre).toBe(false);
    }
    expect(codigo(await getSource(e.admin, evidencia))).toBe('RESOURCE_NOT_FOUND');
    expect(codigo(await getFragments(e.operativo, evidencia))).toBe('RESOURCE_NOT_FOUND');
    expect(valor(await getSource(e.admin, control)).id).toBe(control);
  });

  it('aunque una evidencia llegara sin ser sensible ni sin fragmentos, las lecturas la excluyen igual', async (ctx) => {
    if (!puedeForjar) return ctx.skip();
    for (const [nombre, actor] of roles()) {
      const r = await listSources(actor, e.campanaId);
      if (r.ok)
        expect(
          r.value.map((x) => x.id),
          nombre,
        ).not.toContain(forjada);
    }
    expect(codigo(await getSource(e.admin, forjada))).toBe('RESOURCE_NOT_FOUND');
    expect(codigo(await getSource(e.operativo, forjada))).toBe('RESOURCE_NOT_FOUND');
    expect(codigo(await getFragments(e.admin, forjada))).toBe('RESOURCE_NOT_FOUND');
    expect(codigo(await obtenerRepresentacionNormalizada(e.consultor, forjada))).toBe('RESOURCE_NOT_FOUND');
    expect(codigo(await setSourceVisibility(e.admin, forjada, 'tcl'))).toBe('RESOURCE_NOT_FOUND');
    expect(codigo(await retrySource(e.admin, forjada))).toBe('RESOURCE_NOT_FOUND');
  });

  it('no se cambia su visibilidad ni se reprocesa por los casos de uso de fuentes', async () => {
    expect(codigo(await setSourceVisibility(e.admin, evidencia, 'tcl'))).toBe('RESOURCE_NOT_FOUND');
    expect(codigo(await retrySource(e.admin, evidencia))).toBe('RESOURCE_NOT_FOUND');
    const [f] = await query<{ visibility: string }>(
      `SELECT visibility::text FROM source_documents WHERE id = $1`,
      [evidencia],
    );
    expect(f!.visibility).toBe('interna');
  });

  it('el estado legible para IA es siempre falso para la evidencia operativa', async () => {
    const fila = valor(await getSource(e.admin, control));
    expect(esLegibleParaIA(fila)).toBe(true);
    // Aunque (hipotéticamente) llegara a esta capa, con cualquier otro dato, no es legible.
    expect(esLegibleParaIA({ ...fila, type: 'soporte_operativo' as never })).toBe(false);
    expect(esLegibleParaIA({ ...fila, type: 'soporte_operativo' as never, fragmentos: 9 })).toBe(false);
  });
});

describe('búsqueda y extracción (con un fragmento fantasma que salta los triggers)', () => {
  it('la búsqueda vectorial no devuelve fragmentos de la evidencia; sí los de control', async (ctx) => {
    if (!puedeForjar) return ctx.skip();
    const hits = await buscarEvidencia({
      organizationId: e.admin.organizationId,
      campaignId: e.campanaId,
      vector: VECTOR,
      distanciaMaxima: 1,
      limite: 50,
    });
    const fuentes = hits.map((h) => h.sourceId);
    expect(fuentes).toContain(control);
    expect(fuentes).not.toContain(forjada);
    // Control del montaje: el fragmento fantasma existe, está vectorizado y NO es sensible.
    const [fantasma] = await query<{ n: string; sensible: boolean }>(
      `SELECT count(*)::text AS n, bool_or(s.confidentiality_level = 'sensible') AS sensible
         FROM source_fragments f JOIN source_documents s ON s.id = f.source_id
        WHERE s.id = $1 AND f.embedding IS NOT NULL`,
      [forjada],
    );
    expect(fantasma).toEqual({ n: '1', sensible: false });
    const antes = await estadoDelIndice(e.admin.organizationId, e.campanaId);
    const sinFantasma = await query<{ n: string }>(
      `SELECT count(*)::text AS n FROM source_fragments f JOIN source_documents s ON s.id = f.source_id
        WHERE s.campaign_id = $1 AND s.type::text <> 'soporte_operativo' AND f.embedding IS NOT NULL
          AND s.confidentiality_level <> 'sensible'`,
      [e.campanaId],
    );
    expect(antes.indexados).toBe(Number(sinFantasma[0]!.n));
  });

  it('la búsqueda textual no la devuelve a ningún rol', async (ctx) => {
    if (!puedeForjar) return ctx.skip();
    for (const [nombre, actor] of roles()) {
      const r = await buscarTextoEnFuentes(actor, { campaignId: e.campanaId, texto: CENTINELA });
      if (!r.ok) continue;
      const fuentes = r.value.map((h) => h.sourceId);
      expect(fuentes, nombre).not.toContain(forjada);
      if (nombre === 'admin') expect(fuentes).toEqual([control]);
    }
  });

  it('la extracción no lee la evidencia: una campaña con solo evidencia «no tiene fuentes procesadas»', async (ctx) => {
    if (!puedeForjar) return ctx.skip();
    await expect(extraerCampos(e.admin.organizationId, campanaSoloEvidencia)).rejects.toThrow(
      /no tiene fuentes procesadas/u,
    );
  });
});

describe('carga y adjuntos del chat', () => {
  it('uploadSource, registerLinkedSource y registrarAdjuntoDeArchivo no pueden crear el tipo', async () => {
    const tipo = 'soporte_operativo' as never;
    const subida = await uploadSource(e.admin, {
      campaignId: e.campanaId,
      filename: 'intento.pdf',
      contenido: new TextEncoder().encode(`%PDF-1.4\n% ${randomBytes(6).toString('hex')}\n%%EOF\n`),
      tipoDeclarado: 'application/pdf',
      type: tipo,
    });
    expect(codigo(subida)).toBe('VALIDATION_FAILED');
    const enlace = await registerLinkedSource(e.admin, {
      campaignId: e.campanaId,
      url: 'https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789/edit',
      type: tipo,
    });
    expect(codigo(enlace)).toBe('VALIDATION_FAILED');
    const adjunto = await registrarAdjuntoDeArchivo(e.admin, {
      campaignId: e.campanaId,
      filename: 'intento.pdf',
      contenido: new TextEncoder().encode(`%PDF-1.4\n% ${randomBytes(6).toString('hex')}\n%%EOF\n`),
      type: tipo,
    });
    expect(codigo(adjunto)).toBe('VALIDATION_FAILED');
    const creadas = await query(
      `SELECT 1 FROM source_documents WHERE campaign_id = $1 AND type = 'soporte_operativo' AND id <> ALL($2::uuid[])`,
      [e.campanaId, [evidencia, evidenciaConHash, forjada].filter((id) => id !== '')],
    );
    expect(creadas).toHaveLength(0);
  });

  it('un archivo con el mismo contenido que una evidencia no la vincula ni revela su id o nombre', async () => {
    const subida = await uploadSource(e.admin, {
      campaignId: e.campanaId,
      filename: 'mismo-contenido.pdf',
      contenido: contenidoDuplicado,
      tipoDeclarado: 'application/pdf',
      vincularSiDuplicado: true,
    });
    expect(codigo(subida)).toBe('SOURCE_ALREADY_EXISTS');
    const adjunto = await registrarAdjuntoDeArchivo(e.admin, {
      campaignId: e.campanaId,
      filename: 'mismo-contenido.pdf',
      contenido: contenidoDuplicado,
      tipoDeclarado: 'application/pdf',
    });
    expect(codigo(adjunto)).toBe('SOURCE_ALREADY_EXISTS');
    for (const r of [subida, adjunto]) {
      const texto = JSON.stringify(r);
      expect(texto).not.toContain(evidenciaConHash);
      expect(texto).not.toContain('soporte-');
    }
  });

  it('el chat rechaza adjuntar una fuente de evidencia operativa (VALIDATION_FAILED); una normal sí', async () => {
    const conversacion = valor(await crearConversacion(e.consultor, { campaignId: e.campanaId })).id;
    const publicar = (sourceIds: string[]) =>
      publicarMensaje(e.consultor, {
        conversationId: conversacion,
        clientMessageId: `cm-ops-${randomBytes(6).toString('hex')}`,
        content: 'Adjunto',
        sourceIds,
        runConfig: CONFIG_DE_RUN_DE_PRUEBA,
      });
    const rechazado = await publicar([evidencia]);
    expect(rechazado.ok).toBe(false);
    if (!rechazado.ok) {
      expect(rechazado.error.code).toBe('VALIDATION_FAILED');
      expect(rechazado.error.details?.['reason']).toBe('attachment_operational_evidence');
    }
    const mezclado = await publicar([control, evidencia]);
    expect(codigo(mezclado)).toBe('VALIDATION_FAILED');
    expect(valor(await publicar([control])).replayed).toBe(false);
    // No quedó ningún adjunto de evidencia.
    const adjuntos = await getPool().query(`SELECT 1 FROM chat_message_attachments WHERE source_id = $1`, [
      evidencia,
    ]);
    expect(adjuntos.rows).toHaveLength(0);
  });
});
