/**
 * E5-2 · Búsqueda de evidencia: el filtro va dentro de la consulta.
 *
 * La prueba central de este archivo es deliberadamente hostil. Se planta, en la
 * campaña de **otra agencia**, un fragmento cuyo vector es idéntico al de un
 * fragmento de SmartPR: distancia 0, la coincidencia más fuerte posible. Si el
 * filtro por organización se aplicara después de ordenar —el error que §10.3
 * regla 7 prohíbe—, ese fragmento saldría primero y la fuga sería visible.
 *
 * Un fragmento ajeno que empata en el peor caso posible es la única forma
 * honesta de comprobar que el aislamiento no depende de que nadie se parezca.
 *
 * Casos S-02 y S-03 de D0-12, llevados al índice vectorial.
 *
 * Reproducibilidad desde cero (corrección posterior al cierre): ya no
 * depende de que algún worker haya indexado un fragmento real antes de
 * correr — el «vector conocido» se planta aquí mismo, sintético, en una
 * campaña propia y desechable. Solo se apoya en lo que `npm run seed` deja
 * de forma determinística (usuario `gerardo@smartpr.co`, campaña fija
 * `Campaña confidencial de otra agencia`), igual que `isolation.test.ts`.
 *
 * Requiere la base levantada:  docker compose up -d db
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePool, query } from './client.ts';
import { eliminarCampanaDePrueba } from './test-utils.ts';
import { buscarEvidencia, estadoDelIndice } from './search.ts';

const DIMENSIONES = 1536;

let orgPropia: string;
let campanaPropia: string;
let orgAjena: string;
let campanaAjena: string;
let usuarioAjeno: string;

/** Vector sintético plantado por esta prueba; se reutiliza como consulta. */
let vectorConocido: number[];
let textoConocido: string;

/** Filas plantadas por esta prueba, para borrarlas al final. */
let fuentePropia: string | null = null;
let fuenteAjena: string | null = null;
let fuenteSensible: string | null = null;
let fuenteCercana: string | null = null;
let fuenteLejana: string | null = null;

beforeAll(async () => {
  const [admin] = await query<{ org_id: string; user_id: string }>(
    `SELECT organization_id AS org_id, id AS user_id FROM users WHERE email = 'gerardo@smartpr.co'`,
  );
  if (!admin) throw new Error('Falta el seed: corra npm run seed antes de estas pruebas.');
  orgPropia = admin.org_id;

  const campana = await query<{ id: string }>(
    `INSERT INTO campaigns (organization_id, name, owner_id, created_by)
     VALUES ($1, $2, $3, $3) RETURNING id`,
    [orgPropia, `Búsqueda · corrida de prueba ${Date.now()}`, admin.user_id],
  );
  campanaPropia = campana[0]!.id;

  const [ajena] = await query<{ org_id: string; campaign_id: string; user_id: string }>(
    `SELECT c.organization_id AS org_id, c.id AS campaign_id, u.id AS user_id
       FROM campaigns c
       JOIN users u ON u.organization_id = c.organization_id
      WHERE c.name = 'Campaña confidencial de otra agencia'
      LIMIT 1`,
  );
  if (!ajena) throw new Error('Falta el seed: corra npm run seed antes de estas pruebas.');

  orgAjena = ajena.org_id;
  campanaAjena = ajena.campaign_id;
  usuarioAjeno = ajena.user_id;

  // El vector «conocido»: sintético, propio de esta corrida — nunca depende
  // de que un worker haya indexado algo antes.
  textoConocido = 'Fragmento propio sintético, usado como vector de consulta en esta suite.';
  vectorConocido = Array.from({ length: DIMENSIONES }, (_, i) => Math.sin(i / 97));

  fuentePropia = await plantarFuente({
    organizationId: orgPropia,
    campaignId: campanaPropia,
    createdBy: admin.user_id,
    filename: 'Fragmento propio de prueba.md',
    confidencialidad: 'interna',
    texto: textoConocido,
    embedding: vectorConocido,
  });

  // Dos fragmentos más, a distancias crecientes del vector conocido — para
  // que la prueba de orden ascendente tenga señal real por sí sola, sin
  // depender de que haya más material indexado en la base.
  fuenteCercana = await plantarFuente({
    organizationId: orgPropia,
    campaignId: campanaPropia,
    createdBy: admin.user_id,
    filename: 'Fragmento propio cercano.md',
    confidencialidad: 'interna',
    texto: 'Fragmento propio a distancia intermedia del vector de consulta.',
    embedding: vectorConocido.map((v, i) => v + (i % 2 === 0 ? 0.05 : -0.05)),
  });
  fuenteLejana = await plantarFuente({
    organizationId: orgPropia,
    campaignId: campanaPropia,
    createdBy: admin.user_id,
    filename: 'Fragmento propio lejano.md',
    confidencialidad: 'interna',
    texto: 'Fragmento propio a mayor distancia del vector de consulta.',
    embedding: Array.from({ length: DIMENSIONES }, (_, i) => Math.cos(i / 53)),
  });

  // El fragmento ajeno: mismo vector, distancia 0.
  fuenteAjena = await plantarFuente({
    organizationId: orgAjena,
    campaignId: campanaAjena,
    createdBy: usuarioAjeno,
    filename: 'Documento de otra agencia.md',
    confidencialidad: 'interna',
    texto: 'Contenido ajeno que resultó ser idéntico al nuestro.',
    embedding: vectorConocido,
  });

  // Un documento propio pero sensible: no debe salir jamás (§12.3).
  fuenteSensible = await plantarFuente({
    organizationId: orgPropia,
    campaignId: campanaPropia,
    createdBy: (await unUsuarioDe(orgPropia))!,
    filename: 'Cédulas de los KOL.md',
    confidencialidad: 'sensible',
    texto: 'Documento de identidad y datos bancarios del creador.',
    embedding: vectorConocido,
  });
});

afterAll(async () => {
  for (const id of [fuentePropia, fuenteAjena, fuenteSensible, fuenteCercana, fuenteLejana]) {
    if (id) await query(`DELETE FROM source_documents WHERE id = $1`, [id]);
  }
  if (campanaPropia) {
    await eliminarCampanaDePrueba(campanaPropia);
  }
  await closePool();
});

async function unUsuarioDe(organizationId: string): Promise<string | undefined> {
  const [u] = await query<{ id: string }>(`SELECT id FROM users WHERE organization_id = $1 LIMIT 1`, [
    organizationId,
  ]);
  return u?.id;
}

async function plantarFuente(opciones: {
  organizationId: string;
  campaignId: string;
  createdBy: string;
  filename: string;
  confidencialidad: string;
  texto: string;
  embedding: number[];
}): Promise<string> {
  const [fuente] = await query<{ id: string }>(
    `INSERT INTO source_documents
            (campaign_id, organization_id, type, filename, file_id, mime_type,
             size_bytes, hash, status, confidentiality_level, created_by)
     VALUES ($1, $2, 'otro', $3, $4, 'text/markdown', 100, $5, 'procesado', $6::confidentiality_level, $7)
     RETURNING id`,
    [
      opciones.campaignId,
      opciones.organizationId,
      opciones.filename,
      `prueba/${Date.now()}-${Math.random().toString(36).slice(2)}`,
      `hash-de-prueba-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      opciones.confidencialidad,
      opciones.createdBy,
    ],
  );

  await query(
    `INSERT INTO source_fragments (source_id, ordinal, section, text, embedding)
     VALUES ($1, 1, 'Sección de prueba', $2, $3::vector)`,
    [fuente!.id, opciones.texto, `[${opciones.embedding.join(',')}]`],
  );

  return fuente!.id;
}

// ───────────────────── El aislamiento, en el peor caso ────────────────────────

describe('§10.3 regla 7 · el filtro va dentro de la consulta', () => {
  it('no devuelve el fragmento de otra organización aunque empate en distancia 0', async () => {
    const hits = await buscarEvidencia({
      organizationId: orgPropia,
      campaignId: campanaPropia,
      vector: vectorConocido,
      limite: 20,
    });

    expect(hits.length).toBeGreaterThan(0);
    expect(hits.map((h) => h.filename)).not.toContain('Documento de otra agencia.md');

    // Y todo lo que salió es de la campaña pedida.
    const ajenos = await query<{ n: string }>(
      `SELECT count(*) AS n FROM source_documents
        WHERE id = ANY($1::uuid[]) AND (organization_id <> $2 OR campaign_id <> $3)`,
      [hits.map((h) => h.sourceId), orgPropia, campanaPropia],
    );
    expect(Number(ajenos[0]!.n)).toBe(0);
  });

  it('la otra agencia sí ve el suyo, y solo el suyo', async () => {
    const hits = await buscarEvidencia({
      organizationId: orgAjena,
      campaignId: campanaAjena,
      vector: vectorConocido,
      limite: 20,
    });

    expect(hits.map((h) => h.filename)).toEqual(['Documento de otra agencia.md']);
    expect(hits[0]!.distancia).toBeCloseTo(0, 5);
  });

  it('rechaza una búsqueda sin alcance en vez de mirar toda la base', async () => {
    await expect(
      buscarEvidencia({
        organizationId: '',
        campaignId: campanaPropia,
        vector: vectorConocido,
      }),
    ).rejects.toThrow(/exige organización y campaña/);
  });
});

// ───────────────────── §12.3 · Lo que no entra al índice ──────────────────────

describe('§12.3 · el material sensible no aparece en la búsqueda', () => {
  it('excluye el documento sensible aunque su vector sea idéntico', async () => {
    const hits = await buscarEvidencia({
      organizationId: orgPropia,
      campaignId: campanaPropia,
      vector: vectorConocido,
      limite: 20,
    });
    expect(hits.map((h) => h.filename)).not.toContain('Cédulas de los KOL.md');
  });

  it('el estado del índice cuenta los excluidos aparte', async () => {
    const estado = await estadoDelIndice(orgPropia, campanaPropia);
    expect(estado.indexados).toBeGreaterThan(0);
    expect(estado.excluidos).toBeGreaterThan(0);
  });
});

// ──────────────────────── Forma de los resultados ─────────────────────────────

describe('los resultados sirven para abrir la fuente', () => {
  it('cada acierto trae un localizador utilizable (DEC-018)', async () => {
    const hits = await buscarEvidencia({
      organizationId: orgPropia,
      campaignId: campanaPropia,
      vector: vectorConocido,
    });

    for (const hit of hits) {
      const tieneLocalizador =
        hit.page !== null || hit.slide !== null || (hit.section !== null && hit.section !== '');
      expect(tieneLocalizador, `${hit.filename} salió sin localizador`).toBe(true);
      expect(hit.text.length).toBeGreaterThan(0);
    }
  });

  it('el fragmento cuyo vector se usó como consulta sale primero', async () => {
    const hits = await buscarEvidencia({
      organizationId: orgPropia,
      campaignId: campanaPropia,
      vector: vectorConocido,
    });
    expect(hits[0]!.text).toBe(textoConocido);
    expect(hits[0]!.distancia).toBeCloseTo(0, 5);
  });

  it('ordena por distancia ascendente', async () => {
    const hits = await buscarEvidencia({
      organizationId: orgPropia,
      campaignId: campanaPropia,
      vector: vectorConocido,
      limite: 10,
      distanciaMaxima: 2,
    });
    const distancias = hits.map((h) => h.distancia);
    expect([...distancias].sort((a, b) => a - b)).toEqual(distancias);
  });

  it('rechaza un vector de otra dimensión', async () => {
    await expect(
      buscarEvidencia({
        organizationId: orgPropia,
        campaignId: campanaPropia,
        vector: [0.1, 0.2, 0.3],
      }),
    ).rejects.toThrow(new RegExp(`3 dimensiones y el índice espera ${DIMENSIONES}`));
  });

  it('respeta el tope duro de resultados', async () => {
    const hits = await buscarEvidencia({
      organizationId: orgPropia,
      campaignId: campanaPropia,
      vector: vectorConocido,
      limite: 9999,
      distanciaMaxima: 2,
    });
    expect(hits.length).toBeLessThanOrEqual(50);
  });
});
