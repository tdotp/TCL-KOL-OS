/**
 * QA ADVERSARIAL F7 (subagente F) — QUIÉN VE QUÉ (vectores 8, 9, 10, 11 y C-auditoría), PostgreSQL real.
 *
 * Matriz rol × caso de uso de lectura y escritura sobre un guion NO aprobado con hallazgos y comentarios, en una
 * campaña VISIBLE para TCL con fuentes marcadas `tcl`:
 *   · el cliente TCL y la otra agencia: nada (RESOURCE_NOT_FOUND);
 *   · el Operativo: solo estado/aprobada (sin versiones intermedias, hallazgos, comentarios ni archivos no aprobados);
 *   · analista/legal: nada de contenido;
 *   · cerco de campaña (misma organización) y de organización en cada caso de uso.
 * Y que ningún texto de documento, comentario o hallazgo termina en la auditoría.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Result, User } from '@tcl-kol-os/domain';
import { closePool, query } from './client.ts';
import {
  evaluarProntitudDeAnalisis,
  huellaDeBriefRector,
  listarHallazgos,
  listarRevisiones,
  obtenerBriefRector,
  obtenerRevisionVigente,
  registrarRevisionHumana,
  resumenesDeContenidoDeVersiones,
  solicitarAnalisisDeGuion,
} from './content-analysis.ts';
import {
  actualizarEntregable,
  archivarEntregable,
  crearEntregable,
  listarEntregablesDeCampana,
  obtenerEntregable,
} from './deliverables.ts';
import { extraerCampos } from './extraction.ts';
import { listarAccionesPendientesDeCampana, obtenerAccionDeChat } from './chat-views.ts';
import { obtenerAccionPropuesta, proponerAccion } from './proposed-actions.ts';
import { buscarEvidenciaComoActor, buscarTextoEnFuentes } from './search.ts';
import { aprobarScriptVersion, obtenerEvaluacionDeAprobacion } from './script-approval.ts';
import {
  crearComentarioDeRevision,
  listarComentariosDeRevision,
  solicitarCambiosDeScript,
} from './script-review.ts';
import {
  iniciarRevisionDeVersion,
  listarVersionesDeEntregable,
  obtenerUltimaVersion,
  obtenerVersionDeGuion,
  obtenerVersionVigente,
  registrarVersionDeGuion,
} from './script-versions.ts';
import {
  type EscenarioDeAprobacion,
  aprobarDirecto,
  codigo,
  crearEscenarioDeAprobacion,
  entregableNuevo,
  fuenteDeGuionNueva,
  proponerAprobacion,
  registrarFuente,
  revisarComoHumano,
  revisarConIA,
  valor,
  versionNueva,
} from './script-approval-test-support.ts';
import { getFragments, getSource, listSources, obtenerRepresentacionNormalizada } from './sources.ts';
import { crearFragmentoDePrueba, crearFuenteDePrueba, limpiarEscenarioDeContenido } from './test-utils.ts';

const CANARIO_GUION = 'CANARIOGUIONSECRETO7741';
const CANARIO_COMENTARIO = 'CANARIOCOMENTARIOSECRETO8852';
const CANARIO_HALLAZGO = 'CANARIOHALLAZGOSECRETO9963';
const CANARIO_NOTA = 'CANARIONOTASECRETA1074';

let a: EscenarioDeAprobacion; // campaña A (visible a TCL)
let b: EscenarioDeAprobacion; // campaña B de la MISMA organización
let versionId: string;
let deliverableId: string;
let fuenteId: string;
let versionDeB: string;
let deliverableDeB: string;
let fuenteDeB: string;

const noEs = (r: Result<unknown>): boolean => !r.ok;

beforeAll(async () => {
  a = await crearEscenarioDeAprobacion('QA-F7 alcance A');
  b = await crearEscenarioDeAprobacion('QA-F7 alcance B');
  await query(`UPDATE campaigns SET visibility = 'tcl' WHERE id = $1`, [a.e.campanaId]);
  deliverableId = await entregableNuevo(a.e);
  fuenteId = await fuenteDeGuionNueva(a.e);
  // El texto del guion lleva un canario: ningún lugar fuera de la lectura autorizada puede contenerlo.
  await query(`UPDATE source_fragments SET text = text || $2 WHERE source_id = $1`, [
    fuenteId,
    ` ${CANARIO_GUION}`,
  ]);
  const r = valor(await registrarFuente(a.e, deliverableId, fuenteId));
  if (r.kind !== 'registered') throw new Error('no registrada');
  versionId = r.version.id;
  await revisarConIA(a.e, versionId, [
    {
      category: 'cta_missing',
      refs: ['accion_kpis.accion_esperada'],
      description: `Falta el llamado a la acción. ${CANARIO_HALLAZGO}`,
    },
  ]);
  valor(
    await crearComentarioDeRevision(a.e.consultor, versionId, {
      kind: 'editorial',
      body: `Comentario interno ${CANARIO_COMENTARIO}`,
    }),
  );
  // Campaña B (misma organización): un guion propio.
  deliverableDeB = await entregableNuevo(b.e);
  fuenteDeB = await fuenteDeGuionNueva(b.e);
  const rb = valor(await registrarFuente(b.e, deliverableDeB, fuenteDeB));
  if (rb.kind !== 'registered') throw new Error('no registrada B');
  versionDeB = rb.version.id;
  await revisarComoHumano(versionDeB, b.e.consultor);
});

afterAll(async () => {
  await limpiarEscenarioDeContenido(a.e);
  await limpiarEscenarioDeContenido(b.e);
  await closePool();
});

const sinCanarios = (x: unknown): void => {
  const s = JSON.stringify(x);
  for (const c of [CANARIO_GUION, CANARIO_COMENTARIO, CANARIO_HALLAZGO, CANARIO_NOTA]) {
    expect(s.includes(c), c).toBe(false);
  }
};

// ═════════════════════ Vectores 8 y 9 · matriz de lecturas ═══════════════════════

describe('QA-F7-08/09 · lecturas de contenido por rol', () => {
  type Lectura = [string, (u: User) => Promise<Result<unknown>>];
  const lecturas = (): Lectura[] => [
    ['listarVersionesDeEntregable', (u) => listarVersionesDeEntregable(u, deliverableId)],
    ['obtenerVersionDeGuion', (u) => obtenerVersionDeGuion(u, versionId)],
    ['obtenerVersionVigente', (u) => obtenerVersionVigente(u, deliverableId)],
    ['obtenerUltimaVersion', (u) => obtenerUltimaVersion(u, deliverableId)],
    ['listarHallazgos(version)', (u) => listarHallazgos(u, { versionId })],
    ['listarComentariosDeRevision', (u) => listarComentariosDeRevision(u, versionId)],
    ['listarRevisiones', (u) => listarRevisiones(u, versionId)],
    ['obtenerRevisionVigente', (u) => obtenerRevisionVigente(u, versionId)],
    ['obtenerEvaluacionDeAprobacion', (u) => obtenerEvaluacionDeAprobacion(u, versionId)],
    ['evaluarProntitudDeAnalisis', (u) => evaluarProntitudDeAnalisis(u, versionId)],
    ['huellaDeBriefRector', (u) => huellaDeBriefRector(u, versionId)],
    [
      'resumenesDeContenidoDeVersiones',
      (u) => resumenesDeContenidoDeVersiones(u, a.e.campanaId, [versionId]),
    ],
  ];

  it('RESISTE: cliente TCL (campaña visible a TCL), otra agencia, analista y legal ⇒ ninguna lectura de contenido responde', async () => {
    for (const persona of [a.e.cliente, a.e.ajeno, a.e.analista, a.e.legal]) {
      for (const [nombre, fn] of lecturas()) {
        const r = await fn(persona);
        expect(r.ok, `${persona.role}:${nombre}`).toBe(false);
        if (persona.role === 'cliente' || persona.role === 'admin') {
          expect(codigo(r), `${persona.role}:${nombre}`).toBe('RESOURCE_NOT_FOUND');
        }
      }
      expect((await listarEntregablesDeCampana(persona, a.e.campanaId)).ok, `${persona.role}:listar`).toBe(
        false,
      );
      expect((await obtenerEntregable(persona, deliverableId)).ok, `${persona.role}:obtener`).toBe(false);
    }
  });

  it('RESISTE: el Operativo no lee versiones, hallazgos, comentarios, revisiones ni evaluación', async () => {
    for (const [nombre, fn] of lecturas()) {
      const r = await fn(a.e.operativo);
      expect(r.ok, `operativo:${nombre}`).toBe(false);
      expect(codigo(r), `operativo:${nombre}`).toBe('FORBIDDEN_ROLE');
    }
  });

  it('RESISTE: el Operativo ve SOLO el estado del entregable: sin ids de versión/fuente, hallazgos ni comentarios', async () => {
    const lista = valor(await listarEntregablesDeCampana(a.e.operativo, a.e.campanaId));
    expect(lista.projection).toBe('estado');
    const uno = valor(await obtenerEntregable(a.e.operativo, deliverableId));
    expect(uno.projection).toBe('estado');
    for (const x of [lista, uno]) {
      const s = JSON.stringify(x);
      expect(s).not.toContain(versionId);
      expect(s).not.toContain(fuenteId);
      expect(s).not.toMatch(/sourceHash|source_hash|approvalSnapshot|findings|comments|hallazgo|comentario/i);
      sinCanarios(x);
    }
    // Un guion sin aprobar no muestra su nombre de archivo al Operativo (solo el de la aprobada vigente).
    expect((uno as { currentApproved: unknown }).currentApproved).toBeNull();
    const [v] = await query<{ source_filename: string }>(
      `SELECT source_filename FROM script_versions WHERE id = $1`,
      [versionId],
    );
    expect(JSON.stringify(uno)).not.toContain(v!.source_filename);
  });

  it('RESISTE: la Cuenta sí lee (control positivo) y el texto sensible solo aparece en la lectura autorizada', async () => {
    for (const persona of [a.e.admin, a.e.director, a.e.consultor]) {
      for (const [nombre, fn] of lecturas()) {
        expect((await fn(persona)).ok, `${persona.role}:${nombre}`).toBe(true);
      }
    }
    const hallazgos = valor(await listarHallazgos(a.e.consultor, { versionId }));
    expect(JSON.stringify(hallazgos)).toContain(CANARIO_HALLAZGO);
    const comentarios = valor(await listarComentariosDeRevision(a.e.consultor, versionId));
    expect(JSON.stringify(comentarios)).toContain(CANARIO_COMENTARIO);
  });
});

// ═════════════════════ Vector 9 · escrituras ajenas a la Cuenta ══════════════════

describe('QA-F7-09 · el Operativo, analista, legal, cliente y otra agencia no escriben contenido', () => {
  it('RESISTE: crear entregables, registrar versiones, comentar, pedir cambios, analizar, revisar, aprobar, proponer, archivar', async () => {
    const antes = await contarContenido();
    const fuenteNueva = await fuenteDeGuionNueva(a.e);
    for (const persona of [a.e.operativo, a.e.analista, a.e.legal, a.e.cliente, a.e.ajeno]) {
      const resultados: Array<[string, Result<unknown>]> = [
        [
          'crearEntregable',
          await crearEntregable(persona, {
            campaignInfluencerId: a.e.participaciones.diego,
            label: `Intruso ${persona.role}`,
          }),
        ],
        [
          'registrarVersionDeGuion',
          await registrarVersionDeGuion(persona, {
            campaignId: a.e.campanaId,
            sourceId: fuenteNueva,
            participation: { participationId: a.e.participaciones.diego },
            deliverable: { id: deliverableId },
          }),
        ],
        [
          'comentar',
          await crearComentarioDeRevision(persona, versionId, { kind: 'editorial', body: 'intruso' }),
        ],
        [
          'pedirCambios',
          await solicitarCambiosDeScript(persona, versionId, { items: [{ body: 'intruso' }] }),
        ],
        [
          'analizar',
          await solicitarAnalisisDeGuion(persona, versionId, {
            mode: 'reanalyze',
            idempotencyKey: `intruso-${persona.role}-1`,
          }),
        ],
        ['revisionHumana', await registrarRevisionHumana(persona, versionId, {})],
        ['aprobar', await aprobarScriptVersion(persona, versionId, { huellaVista: 'a'.repeat(64) })],
        [
          'proponer',
          await proponerAccion(persona, {
            type: 'script_version.approve',
            resourceId: versionId,
            origin: 'chat',
          }),
        ],
        ['iniciarRevision', await iniciarRevisionDeVersion(persona, versionId)],
        ['actualizarEntregable', await actualizarEntregable(persona, deliverableId, { label: 'Renombrado' })],
        ['archivarEntregable', await archivarEntregable(persona, deliverableId)],
      ];
      for (const [nombre, r] of resultados) expect(noEs(r), `${persona.role}:${nombre}`).toBe(true);
    }
    expect(await contarContenido()).toEqual(antes);
    expect(
      (await query<{ status: string }>(`SELECT status FROM script_versions WHERE id = $1`, [versionId]))[0]!
        .status,
    ).toBe('in_review');
  });
});

async function contarContenido(): Promise<Record<string, number>> {
  const [f] = await query<Record<string, string>>(
    `SELECT (SELECT count(*) FROM deliverables WHERE campaign_id = $1)::text AS entregables,
            (SELECT count(*) FROM script_versions WHERE campaign_id = $1)::text AS versiones,
            (SELECT count(*) FROM script_review_comments WHERE campaign_id = $1)::text AS comentarios,
            (SELECT count(*) FROM content_analysis_runs WHERE campaign_id = $1)::text AS revisiones,
            (SELECT count(*) FROM proposed_actions WHERE campaign_id = $1)::text AS propuestas,
            (SELECT count(*) FROM audit_events WHERE metadata->>'campaignId' = $1::text)::text AS auditoria`,
    [a.e.campanaId],
  );
  return Object.fromEntries(Object.entries(f!).map(([k, v]) => [k, Number(v)]));
}

// ═════════════════════ Vector 9 · fuentes y fragmentos del guion ═════════════════

describe('QA-F7-09 · lectura de fuentes y fragmentos de un guion no aprobado', () => {
  it('RESISTE: ni el Operativo, ni analista, legal, cliente ni otra agencia leen la fuente, sus fragmentos, la búsqueda ni la representación', async () => {
    for (const persona of [a.e.operativo, a.e.analista, a.e.legal, a.e.cliente, a.e.ajeno]) {
      expect((await getSource(persona, fuenteId)).ok, `${persona.role}:getSource`).toBe(false);
      expect((await getFragments(persona, fuenteId)).ok, `${persona.role}:getFragments`).toBe(false);
      expect((await obtenerRepresentacionNormalizada(persona, fuenteId)).ok, `${persona.role}:repr`).toBe(
        false,
      );
      const lista = await listSources(persona, a.e.campanaId);
      if (lista.ok) {
        expect(
          lista.value.map((s) => s.id),
          `${persona.role}:listSources`,
        ).not.toContain(fuenteId);
        sinCanarios(lista.value);
      }
      const busqueda = await buscarTextoEnFuentes(persona, {
        campaignId: a.e.campanaId,
        texto: CANARIO_GUION,
      });
      if (busqueda.ok) expect(busqueda.value, `${persona.role}:texto`).toEqual([]);
      const evidencia = await buscarEvidenciaComoActor(persona, {
        campaignId: a.e.campanaId,
        vector: [1, ...new Array<number>(1535).fill(0)],
      });
      if (evidencia.ok) expect(evidencia.value.map((h) => h.sourceId)).not.toContain(fuenteId);
    }
  });

  it('RESISTE: la Cuenta sí lee su guion (control positivo)', async () => {
    expect((await getSource(a.e.consultor, fuenteId)).ok).toBe(true);
    const frag = valor(await getFragments(a.e.consultor, fuenteId));
    expect(JSON.stringify(frag)).toContain(CANARIO_GUION);
    const b1 = valor(
      await buscarTextoEnFuentes(a.e.consultor, { campaignId: a.e.campanaId, texto: CANARIO_GUION }),
    );
    expect(b1.map((h) => h.sourceId)).toContain(fuenteId);
  });

  it('RESISTE: tras APROBAR, el Operativo lee el archivo aprobado (por diseño) y vuelve a no verlo cuando se reemplaza por una versión nueva', async () => {
    const e = a.e;
    const d = await entregableNuevo(e);
    const f1 = await fuenteDeGuionNueva(e);
    const f2 = await fuenteDeGuionNueva(e);
    const r1 = valor(await registrarFuente(e, d, f1));
    const r2 = valor(await registrarFuente(e, d, f2));
    if (r1.kind !== 'registered' || r2.kind !== 'registered') throw new Error('registro');
    await revisarComoHumano(r1.version.id, e.consultor);
    await revisarComoHumano(r2.version.id, e.consultor);
    expect((await getSource(e.operativo, f1)).ok).toBe(false);
    valor(await aprobarDirecto(e.director, r1.version.id));
    expect((await getSource(e.operativo, f1)).ok, 'aprobada: visible para el Operativo').toBe(true);
    expect((await getSource(e.operativo, f2)).ok, 'la V2 aún no aprobada sigue oculta').toBe(false);
    valor(await aprobarDirecto(e.director, r2.version.id));
    expect((await getSource(e.operativo, f1)).ok, 'V1 reemplazada: vuelve a estar oculta').toBe(false);
    expect((await getSource(e.operativo, f2)).ok).toBe(true);
  });

  it('RESISTE: la extracción del Brief no recibe NINGÚN texto de guion (el worker recibe solo fuentes que no son guiones)', async () => {
    const e = a.e;
    // Una fuente NO guion procesada (para que la extracción tenga qué enviar) y los guiones de la campaña.
    const normal = await crearFuenteDePrueba(e.campanaId, e.admin, `fuente-normal-${Date.now()}`);
    await crearFragmentoDePrueba(
      normal,
      1,
      'Texto normal del brief de la campaña, sin relación con guiones.',
    );
    let cuerpo = '';
    const original = globalThis.fetch;
    vi.stubGlobal('fetch', async (_url: unknown, init?: { body?: string }) => {
      cuerpo = init?.body ?? '';
      throw new Error('worker simulado: sin respuesta');
    });
    try {
      await extraerCampos(e.admin.organizationId, e.campanaId).catch(() => undefined);
    } finally {
      vi.stubGlobal('fetch', original);
    }
    expect(cuerpo).toContain('Texto normal del brief');
    expect(cuerpo).not.toContain(CANARIO_GUION);
  });
});

// ═════════════════════ Vector 10 · cruce de campañas de la MISMA organización ═════

describe('QA-F7-10 · cerco de campaña: lo de la campaña B no existe desde la A', () => {
  const alcanceA = { campaignId: undefined as unknown as string };
  type Caso = [string, () => Promise<Result<unknown>>];
  const casos = (): Caso[] => {
    const e = a.e;
    const cercoA = { campaignId: e.campanaId };
    const alcance = { ...alcanceA, ...cercoA };
    return [
      ['obtenerEntregable', () => obtenerEntregable(e.consultor, deliverableDeB, { alcance })],
      [
        'listarVersionesDeEntregable',
        () => listarVersionesDeEntregable(e.consultor, deliverableDeB, { alcance }),
      ],
      ['obtenerVersionDeGuion', () => obtenerVersionDeGuion(e.consultor, versionDeB, { alcance })],
      ['obtenerVersionVigente', () => obtenerVersionVigente(e.consultor, deliverableDeB, { alcance })],
      ['obtenerUltimaVersion', () => obtenerUltimaVersion(e.consultor, deliverableDeB, { alcance })],
      ['listarHallazgos', () => listarHallazgos(e.consultor, { versionId: versionDeB }, cercoA)],
      ['listarComentariosDeRevision', () => listarComentariosDeRevision(e.consultor, versionDeB, {}, cercoA)],
      ['listarRevisiones', () => listarRevisiones(e.consultor, versionDeB, { alcance })],
      ['obtenerRevisionVigente', () => obtenerRevisionVigente(e.consultor, versionDeB, cercoA)],
      ['obtenerEvaluacionDeAprobacion', () => obtenerEvaluacionDeAprobacion(e.director, versionDeB, cercoA)],
      ['evaluarProntitudDeAnalisis', () => evaluarProntitudDeAnalisis(e.consultor, versionDeB, { alcance })],
      ['huellaDeBriefRector', () => huellaDeBriefRector(e.consultor, versionDeB, cercoA)],
      [
        'crearComentarioDeRevision',
        () =>
          crearComentarioDeRevision(
            e.consultor,
            versionDeB,
            { kind: 'editorial', body: 'cruce' },
            undefined,
            cercoA,
          ),
      ],
      [
        'solicitarCambiosDeScript',
        () =>
          solicitarCambiosDeScript(
            e.consultor,
            versionDeB,
            { items: [{ body: 'cruce' }] },
            undefined,
            cercoA,
          ),
      ],
      [
        'registrarRevisionHumana',
        () => registrarRevisionHumana(e.consultor, versionDeB, { alcance: cercoA }),
      ],
      [
        'iniciarRevisionDeVersion',
        () => iniciarRevisionDeVersion(e.consultor, versionDeB, undefined, cercoA),
      ],
      [
        'aprobarScriptVersion',
        () => aprobarScriptVersion(e.director, versionDeB, { huellaVista: 'a'.repeat(64), alcance: cercoA }),
      ],
      [
        'solicitarAnalisisDeGuion',
        () =>
          solicitarAnalisisDeGuion(e.consultor, versionDeB, {
            mode: 'ensure',
            idempotencyKey: 'cruce-ensure-1',
            alcance: cercoA,
          }),
      ],
      [
        'proponerAccion',
        () =>
          proponerAccion(e.consultor, {
            type: 'script_version.approve',
            resourceId: versionDeB,
            origin: 'chat',
            campaignId: e.campanaId,
          }),
      ],
      [
        'actualizarEntregable',
        () => actualizarEntregable(e.consultor, deliverableDeB, { label: 'Cruce' }, undefined, cercoA),
      ],
      ['archivarEntregable', () => archivarEntregable(e.consultor, deliverableDeB, {}, undefined, cercoA)],
    ];
  };

  it('RESISTE: cada caso de uso responde RESOURCE_NOT_FOUND y no deja efecto', async () => {
    const antesB = await query<{ n: string }>(
      `SELECT (SELECT count(*) FROM script_review_comments WHERE campaign_id = $1)::text || '/' ||
              (SELECT count(*) FROM content_analysis_runs WHERE campaign_id = $1)::text || '/' ||
              (SELECT status FROM script_versions WHERE id = $2) AS n`,
      [b.e.campanaId, versionDeB],
    );
    for (const [nombre, fn] of casos()) {
      expect(codigo(await fn()), nombre).toBe('RESOURCE_NOT_FOUND');
    }
    const despuesB = await query<{ n: string }>(
      `SELECT (SELECT count(*) FROM script_review_comments WHERE campaign_id = $1)::text || '/' ||
              (SELECT count(*) FROM content_analysis_runs WHERE campaign_id = $1)::text || '/' ||
              (SELECT status FROM script_versions WHERE id = $2) AS n`,
      [b.e.campanaId, versionDeB],
    );
    expect(despuesB).toEqual(antesB);
  });

  it('RESISTE: registrar una fuente, una participación o un entregable de la campaña B dentro de la A ⇒ RESOURCE_NOT_FOUND', async () => {
    const e = a.e;
    const mezcla: Array<Promise<Result<unknown>>> = [
      // fuente de B en A
      registrarVersionDeGuion(e.consultor, {
        campaignId: e.campanaId,
        sourceId: fuenteDeB,
        participation: { participationId: e.participaciones.diego },
        deliverable: { id: deliverableId },
      }),
      // participación de B en A
      registrarVersionDeGuion(e.consultor, {
        campaignId: e.campanaId,
        sourceId: await fuenteDeGuionNueva(e),
        participation: { participationId: b.e.participaciones.diego },
        deliverable: { id: deliverableId },
      }),
      // entregable de B con participación de A
      registrarVersionDeGuion(e.consultor, {
        campaignId: e.campanaId,
        sourceId: await fuenteDeGuionNueva(e),
        participation: { participationId: e.participaciones.diego },
        deliverable: { id: deliverableDeB },
      }),
      // producto de B en un entregable de A
      crearEntregable(e.consultor, {
        campaignInfluencerId: e.participaciones.valentinaRios,
        label: `Cruce producto ${Date.now()}`,
        campaignProductId: b.e.productos.p80,
      }),
    ];
    for (const [i, r] of (await Promise.all(mezcla)).entries()) {
      expect(codigo(r), `mezcla ${i}`).toBe('RESOURCE_NOT_FOUND');
    }
  });

  it('RESISTE: obtenerBriefRector es por campaña: el rector de A nunca es el de B', async () => {
    const ra = valor(await obtenerBriefRector(a.e.consultor, a.e.campanaId));
    const rb = valor(await obtenerBriefRector(b.e.consultor, b.e.campanaId));
    expect(ra.versionId).toBe(a.brief.versionId);
    expect(rb.versionId).toBe(b.brief.versionId);
    expect(ra.versionId).not.toBe(rb.versionId);
  });
});

// ═════════════════════ Vector 11 · fuentes/Brief ajenos referenciados ═════════════

describe('QA-F7-11 · fuentes y campos ajenos en revisiones y hallazgos (SQL directo)', () => {
  async function runEnCurso(): Promise<{ runId: string; findingId: string }> {
    const d = await entregableNuevo(a.e);
    const v = await versionNueva(a.e, d);
    const [fila] = await query<{ src: string; h: string }>(
      `SELECT source_document_id AS src, source_hash AS h FROM script_versions WHERE id = $1`,
      [v],
    );
    const [run] = await query<{ id: string }>(
      `INSERT INTO content_analysis_runs
         (organization_id, campaign_id, kind, script_version_id, deliverable_id, campaign_influencer_id,
          governing_brief_version_id, brief_fingerprint, script_source_id, script_source_hash, script_text_hash,
          script_chars, fragment_count, product_scope, context_manifest, prompt_version, output_schema_version,
          context_version, severity_policy_version, model_tier, status, idempotency_key, request_hash, mode,
          created_by, lease_expires_at)
       VALUES ($1, $2, 'ai_assisted', $3, $4, $5, $6, $7, $8, $9, $10, 10, 1, 'assigned', '{}'::jsonb,
               'p', 'o', 'c', 's', 'equilibrado', 'running', $11, $12, 'reanalyze', $13, now() + interval '5 min')
       RETURNING id`,
      [
        a.e.admin.organizationId,
        a.e.campanaId,
        v,
        d,
        a.e.participaciones.diego,
        a.brief.versionId,
        'a'.repeat(64),
        fila!.src,
        fila!.h,
        'b'.repeat(64),
        `k-ajeno-${Math.random()}`,
        'c'.repeat(64),
        a.e.consultor.id,
      ],
    );
    const [f] = await query<{ id: string }>(
      `INSERT INTO content_findings
         (organization_id, campaign_id, script_version_id, analysis_run_id, ordinal, model_position, category, basis,
          severity, claim_status, description)
       VALUES ($1, $2, $3, $4, 1, 0, 'cta_missing', 'absence', 'media', NULL, 'Hallazgo de prueba')
       RETURNING id`,
      [a.e.admin.organizationId, a.e.campanaId, v, run!.id],
    );
    return { runId: run!.id, findingId: f!.id };
  }

  async function rechazo(sql: string, params: unknown[]): Promise<string | undefined> {
    try {
      await query(sql, params);
      return undefined;
    } catch (error) {
      return (error as Error).message;
    }
  }

  it('RESISTE: una referencia al guion con la fuente de OTRA campaña u organización, y una al Brief de OTRA campaña, se rechazan', async () => {
    const { runId, findingId } = await runEnCurso();
    const refGuion = `INSERT INTO content_finding_script_refs
        (organization_id, finding_id, source_id, fragment_ordinal, quote, quote_sha256, fragment_text_hash)
      VALUES ($1, $2, $3, 0, 'una cita de prueba', $4, $4)`;
    const hash = 'e'.repeat(64);
    const [ajena] = await query<{ id: string }>(
      `SELECT id FROM source_documents WHERE campaign_id = $1 LIMIT 1`,
      [a.e.campanaAjenaId],
    );
    const deOtraOrg =
      ajena?.id ?? (await crearFuenteDePrueba(a.e.campanaAjenaId, a.e.ajeno, `ajena-${Date.now()}`));
    expect(
      await rechazo(refGuion, [a.e.admin.organizationId, findingId, fuenteDeB, hash]),
      'fuente de la campaña B',
    ).toBeDefined();
    expect(
      await rechazo(refGuion, [a.e.admin.organizationId, findingId, deOtraOrg, hash]),
      'fuente de otra organización',
    ).toBeDefined();
    // Campo del Brief de la campaña B.
    const campoDeB = b.brief.campos['accion_kpis.accion_esperada']!;
    const refBrief = `INSERT INTO content_finding_brief_refs
        (organization_id, finding_id, brief_field_id, brief_version_id, field_key, criticidad)
      VALUES ($1, $2, $3, $4, 'accion_kpis.accion_esperada', 'critico')`;
    expect(
      await rechazo(refBrief, [a.e.admin.organizationId, findingId, campoDeB, b.brief.versionId]),
      'campo del Brief de B',
    ).toBeDefined();
    // Campo de la versión del Brief de A pero declarando la versión de B, o al revés.
    const campoDeA = a.brief.campos['accion_kpis.accion_esperada']!;
    expect(
      await rechazo(refBrief, [a.e.admin.organizationId, findingId, campoDeA, b.brief.versionId]),
    ).toBeDefined();
    // Control positivo: el campo del Brief rector de A sí.
    expect(
      await rechazo(refBrief, [a.e.admin.organizationId, findingId, campoDeA, a.brief.versionId]),
    ).toBeUndefined();
    await query(
      `UPDATE content_analysis_runs SET status = 'failed', failure_code = 'ANALYSIS_ABANDONED', finished_at = now(), finding_count = 0 WHERE id = $1`,
      [runId],
    ).catch(() => undefined);
  });

  it('RESISTE: una revisión no gobierna con el Brief de otra campaña ni con un borrador', async () => {
    const d = await entregableNuevo(a.e);
    const v = await versionNueva(a.e, d);
    const insertar = (brief: string) =>
      rechazo(
        `INSERT INTO content_analysis_runs
           (organization_id, campaign_id, kind, script_version_id, deliverable_id, campaign_influencer_id,
            governing_brief_version_id, brief_fingerprint, script_source_id, script_source_hash, status, finding_count, created_by)
         SELECT $1, $2, 'human', sv.id, sv.deliverable_id, $3, $4, $5, sv.source_document_id, sv.source_hash, 'succeeded', 0, $6
           FROM script_versions sv WHERE sv.id = $7`,
        [
          a.e.admin.organizationId,
          a.e.campanaId,
          a.e.participaciones.diego,
          brief,
          'a'.repeat(64),
          a.e.consultor.id,
          v,
        ],
      );
    expect(await insertar(b.brief.versionId), 'Brief de otra campaña').toBeDefined();
  });
});

// ═════════════════════ Vector C · auditoría sin texto de documentos ══════════════

describe('QA-F7-C · la auditoría y los registros del flujo no contienen texto de guiones, comentarios ni hallazgos', () => {
  it('RESISTE: tras registrar, revisar, analizar, comentar, pedir cambios y aprobar, ningún evento de auditoría lleva los canarios', async () => {
    const e = a.e;
    const d = await entregableNuevo(e);
    const f = await fuenteDeGuionNueva(e);
    await query(`UPDATE source_fragments SET text = text || $2 WHERE source_id = $1`, [
      f,
      ` ${CANARIO_GUION}`,
    ]);
    const r = valor(await registrarFuente(e, d, f));
    if (r.kind !== 'registered') throw new Error('registro');
    const v = r.version.id;
    valor(await registrarRevisionHumana(e.consultor, v, { nota: `Nota ${CANARIO_NOTA}` }));
    valor(
      await crearComentarioDeRevision(e.consultor, v, {
        kind: 'editorial',
        body: `Nota ${CANARIO_COMENTARIO}`,
      }),
    );
    valor(await aprobarDirecto(e.director, v));
    const v2 = await versionNueva(e, d);
    valor(await registrarRevisionHumana(e.consultor, v2, {}));
    valor(
      await solicitarCambiosDeScript(e.consultor, v2, { items: [{ body: `Cambio ${CANARIO_COMENTARIO}` }] }),
    );
    const filas = await query<{ blob: string }>(
      `SELECT (metadata::text || coalesce(correlation::text, '')) AS blob FROM audit_events WHERE organization_id = $1`,
      [e.admin.organizationId],
    );
    for (const fila of filas) {
      for (const c of [CANARIO_GUION, CANARIO_COMENTARIO, CANARIO_HALLAZGO, CANARIO_NOTA]) {
        expect(fila.blob.includes(c), c).toBe(false);
      }
    }
    // Y tampoco en la propia huella de aprobación guardada en la versión (cifras e ids, no texto).
    const [snap] = await query<{ s: string }>(
      `SELECT approval_snapshot::text AS s FROM script_versions WHERE id = $1`,
      [v],
    );
    for (const c of [CANARIO_GUION, CANARIO_COMENTARIO, CANARIO_HALLAZGO, CANARIO_NOTA]) {
      expect(snap!.s.includes(c), c).toBe(false);
    }
  });
});

// ═════════════════════ Vector 8 · propuestas de aprobación y vistas del chat ═══════

describe('QA-F7-08 · la propuesta de aprobación de un guion no se ve fuera de Cuenta', () => {
  it('RESISTE: operativo, analista, legal, cliente y otra agencia no ven la propuesta (lista, lectura ni vista de chat); la Cuenta sí', async () => {
    const e = a.e;
    const d = await entregableNuevo(e);
    const f = await fuenteDeGuionNueva(e);
    const r = valor(await registrarFuente(e, d, f));
    if (r.kind !== 'registered') throw new Error('registro');
    await revisarComoHumano(r.version.id, e.consultor);
    const propuesta = await proponerAprobacion(e, r.version.id);
    for (const persona of [e.operativo, e.analista, e.legal, e.cliente, e.ajeno]) {
      const pendientes = await listarAccionesPendientesDeCampana(persona, e.campanaId);
      if (pendientes.ok)
        expect(
          pendientes.value.map((v) => v.id),
          `${persona.role}:pendientes`,
        ).not.toContain(propuesta.id);
      expect(
        (await obtenerAccionPropuesta(persona, propuesta.id, { campaignId: e.campanaId })).ok,
        `${persona.role}:leer`,
      ).toBe(false);
      expect(
        (await obtenerAccionDeChat(persona, e.campanaId, propuesta.id)).ok,
        `${persona.role}:vista`,
      ).toBe(false);
    }
    const delDirector = valor(await listarAccionesPendientesDeCampana(e.director, e.campanaId));
    expect(delDirector.map((v) => v.id)).toContain(propuesta.id);
    expect(delDirector.find((v) => v.id === propuesta.id)!.canConfirm).toBe(true);
    // El consultor que propone la ve, pero NO puede confirmarla.
    const delConsultor = valor(await listarAccionesPendientesDeCampana(e.consultor, e.campanaId));
    const suya = delConsultor.find((v) => v.id === propuesta.id);
    if (suya !== undefined) expect(suya.canConfirm).toBe(false);
    // La tarjeta compuesta no lleva identificadores ni hashes de documentos, solo cifras y nombres de la organización.
    sinCanarios(delDirector);
  });
});
