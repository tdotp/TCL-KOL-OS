/**
 * QA adversarial · aislamiento de CONTENIDO (V2 · Fase 7): entregables (E), versiones (V), hallazgos (H) y
 * comentarios (C) de OTRA organización y de OTRA campaña de la misma organización.
 *
 * Tres formas de colarlos: un alias inventado, un UUID (el esquema lo rechaza: solo hay alias) y un registro
 * de referencias CONTAMINADO (el alias existe en el registro del run pero apunta a un recurso ajeno). En todos
 * los casos: `RESOURCE_NOT_FOUND` / `VALIDATION_FAILED` y SIN efecto. El cerco de campaña vive en el caso de
 * uso (`alcance`) Y en la tool (`guards.ts`): se prueba cada capa y el conjunto.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type * as DbModule from '@tcl-kol-os/db';
import {
  asociarInfluencerACampana,
  closePool,
  crearComentarioDeRevision,
  crearEntregable,
  crearInfluencer,
  listarComentariosDeRevision,
  listarHallazgos,
  obtenerEntregable,
  obtenerVersionDeGuion,
  query,
  registrarVersionDeGuion,
  solicitarAnalisisDeGuion,
} from '@tcl-kol-os/db';
import {
  asegurarUsuarioDePrueba,
  crearBriefAprobadoDePrueba,
  crearFuenteDeGuionConTexto,
  eliminarCampanaDePrueba,
  eliminarInfluencersDePrueba,
  limpiarEscenarioDeContenido,
} from '@tcl-kol-os/db/test-utils';
import { RegistroDeReferencias } from '@tcl-kol-os/domain';
import {
  type EstadoDeAnalisis,
  type MundoDeContenido,
  TEXTO_DE_GUION,
  clienteQueResponde,
  crearMundoDeContenido,
  fuenteDeGuion,
  registrarVersionDePrueba,
} from './testing/contenido.ts';
import { RECURSO_NO_ENCONTRADO, resolverAliasEstricto } from '../tools/guards.ts';
import { abrirTurno, clave, llamar, registro, type Turno } from '../tools/test-support.ts';
import type { ToolCtx } from '../tools/types.ts';
import { contar } from './testing/harness.ts';

const analisis = vi.hoisted(() => ({ cliente: undefined, iaActiva: true }) as EstadoDeAnalisis);
vi.mock('@tcl-kol-os/db', async (importOriginal) => {
  const real = await importOriginal<typeof DbModule>();
  return {
    ...real,
    solicitarAnalisisDeGuion: (
      actor: Parameters<typeof real.solicitarAnalisisDeGuion>[0],
      versionId: string,
      input: Parameters<typeof real.solicitarAnalisisDeGuion>[2],
      contexto?: Parameters<typeof real.solicitarAnalisisDeGuion>[3],
    ) =>
      real.solicitarAnalisisDeGuion(actor, versionId, input, contexto, {
        ...(analisis.cliente === undefined ? {} : { cliente: analisis.cliente }),
        env: (n: string) =>
          n === 'AI_ENABLED' ? String(analisis.iaActiva) : n === 'AI_PROVIDER' ? 'fake' : undefined,
      }),
  };
});

const r = registro();
let a: MundoDeContenido; // la campaña del run
let b: MundoDeContenido; // OTRA campaña de la misma organización
let iaAntes: string | undefined;
const influencersAjenos: string[] = [];

interface Ajeno {
  readonly entregableId: string;
  readonly versionId: string;
  readonly participacionId: string;
  readonly fuenteId: string;
  readonly hallazgoId: string | undefined;
  readonly comentarioId: string;
}
let enB: Ajeno; // contenido de la otra campaña (misma org)
let enOtraOrg: Ajeno; // contenido de la otra organización

const VALIDATION = 'VALIDATION_FAILED';

/** Un contenido completo (entregable, versión analizada, comentario) en una campaña. */
async function sembrar(
  e: MundoDeContenido['e'],
  campanaId: string,
  actor: MundoDeContenido['e']['admin'],
  etiqueta: string,
  conAnalisis: boolean,
): Promise<Ajeno> {
  const inf = await crearInfluencer(actor, {
    displayName: `Ajena ${etiqueta}`,
    cuentas: [{ platform: 'instagram', handle: `ajena.${etiqueta}.${e.sufijo}` }],
  });
  if (!inf.ok) throw new Error(inf.error.message);
  influencersAjenos.push(inf.value.influencer.id);
  const ci = await asociarInfluencerACampana(actor, {
    campaignId: campanaId,
    influencerId: inf.value.influencer.id,
  });
  if (!ci.ok) throw new Error(ci.error.message);
  const ent = await crearEntregable(actor, { campaignInfluencerId: ci.value.id, label: `Pieza ${etiqueta}` });
  if (!ent.ok) throw new Error(ent.error.message);
  const fuenteId = await crearFuenteDeGuionConTexto(campanaId, actor, `guion-${etiqueta}`, TEXTO_DE_GUION);
  const reg = await registrarVersionDeGuion(actor, {
    campaignId: campanaId,
    sourceId: fuenteId,
    participation: { participationId: ci.value.id },
    deliverable: { id: ent.value.id },
  });
  if (!reg.ok || reg.value.kind !== 'registered') throw new Error('no se registró la versión ajena');
  const versionId = reg.value.version.id;
  let hallazgoId: string | undefined;
  if (conAnalisis) {
    analisis.cliente = clienteQueResponde([
      {
        category: 'cta_missing',
        refs: ['accion_kpis.accion_esperada'],
        description: `Hallazgo ajeno ${etiqueta}.`,
      },
    ]);
    const x = await solicitarAnalisisDeGuion(actor, versionId, { mode: 'ensure', idempotencyKey: clave() });
    if (!x.ok) throw new Error(`análisis ajeno: ${x.error.code}`);
    const h = await listarHallazgos(actor, { versionId });
    if (h.ok) hallazgoId = h.value.items[0]?.id;
  }
  const c = await crearComentarioDeRevision(actor, versionId, {
    kind: 'editorial',
    body: `Comentario ajeno ${etiqueta}`,
  });
  if (!c.ok) throw new Error(c.error.message);
  return {
    entregableId: ent.value.id,
    versionId,
    participacionId: ci.value.id,
    fuenteId,
    hallazgoId,
    comentarioId: c.value.comment.id,
  };
}

beforeAll(async () => {
  iaAntes = process.env['AI_ENABLED'];
  process.env['AI_ENABLED'] = 'true';
  a = await crearMundoDeContenido('QA tenant contenido A');
  b = await crearMundoDeContenido('QA tenant contenido B');
  enB = await sembrar(b.e, b.e.campanaId, b.e.admin, 'otra-campana', true);

  // OTRA organización: su campaña, con Brief aprobado y su propio contenido. Lo siembra un admin PRIVADO de esa
  // organización (no el `ajeno` compartido: otras pruebas afirman que ese usuario nunca creó entregables).
  const duenoAjeno = await asegurarUsuarioDePrueba(
    'qa-f7-tenant@otraagencia.co',
    'Admin ajeno (QA contenido)',
    'admin',
    a.e.ajeno.organizationId,
  );
  await crearBriefAprobadoDePrueba(a.e.campanaAjenaId, duenoAjeno, { productos: [] });
  enOtraOrg = await sembrar(a.e, a.e.campanaAjenaId, duenoAjeno, 'otra-org', true);
});

afterAll(async () => {
  if (iaAntes === undefined) delete process.env['AI_ENABLED'];
  else process.env['AI_ENABLED'] = iaAntes;
  await limpiarEscenarioDeContenido(a.e);
  await limpiarEscenarioDeContenido(b.e);
  await eliminarCampanaDePrueba(a.e.campanaAjenaId);
  await eliminarInfluencersDePrueba(influencersAjenos);
  await closePool();
});

/** Registra en el run alias que apuntan a recursos AJENOS (registro contaminado). */
function contaminar(t: Turno, aj: Ajeno) {
  const reg = t.referencias;
  return {
    e: reg.registrar({ kind: 'deliverable', entityId: aj.entregableId, parentId: aj.participacionId }).alias,
    v: reg.registrar({ kind: 'script_version', entityId: aj.versionId, parentId: aj.entregableId }).alias,
    p: reg.registrar({ kind: 'campaign_influencer', entityId: aj.participacionId }).alias,
    s: reg.registrar({ kind: 'source', sourceId: aj.fuenteId }).alias,
    h:
      aj.hallazgoId === undefined
        ? 'H1'
        : reg.registrar({ kind: 'finding', entityId: aj.hallazgoId, parentId: aj.versionId }).alias,
    c: reg.registrar({ kind: 'review_comment', entityId: aj.comentarioId, parentId: aj.versionId }).alias,
  };
}

const estadoAjeno = async (aj: Ajeno) => ({
  version: (
    await query<{ status: string }>(`SELECT status::text FROM script_versions WHERE id = $1`, [aj.versionId])
  )[0]!.status,
  comentarios: await contar('script_review_comments WHERE script_version_id = $1', [aj.versionId]),
  propuestas: await contar('proposed_actions WHERE resource_id = $1', [aj.versionId]),
  analisis: await contar('content_analysis_runs WHERE script_version_id = $1', [aj.versionId]),
  versionesDelEntregable: await contar('script_versions WHERE deliverable_id = $1', [aj.entregableId]),
});

const AJENOS: [string, () => Ajeno][] = [
  ['otra campaña de la misma organización', () => enB],
  ['otra organización', () => enOtraOrg],
];

describe('registro contaminado: el alias existe en el run pero apunta a un recurso AJENO', () => {
  for (const [donde, ajeno] of AJENOS) {
    it(`${donde}: cada tool con V, E, P o S responde RESOURCE_NOT_FOUND y no deja ningún efecto`, async () => {
      const aj = ajeno();
      const antes = await estadoAjeno(aj);
      const cliente = clienteQueResponde([]);
      analisis.cliente = cliente;
      const msg =
        'Quiero que apruebes, analices y comentes este guion de Ajena y Diego Peña: el cierre es demasiado largo para el formato';
      const t = await abrirTurno(a.e.consultor, a.e.campanaId, msg);
      // un archivo PROPIO (adjunto de la persona): así la prueba de `register` llega al cerco de P y de E
      const propia = await fuenteDeGuion(a.e, 'guion-propio-tenant');
      t.adjuntos = [propia];
      t.adjuntosPorMensaje = [{ texto: msg, sourceIds: [propia] }];
      const aliasPropia = t.referencias.registrar({ kind: 'source', sourceId: propia }).alias;
      const x = contaminar(t, aj);
      const cita = 'Quiero que apruebes, analices y comentes este guion de Ajena y Diego Peña';
      const casos: [string, Record<string, unknown>][] = [
        ['deliverable_get', { deliverableId: x.e }],
        ['deliverable_list', { participationId: x.p }],
        ['script_version_get', { versionId: x.v }],
        ['finding_list', { versionId: x.v }],
        ['review_comment_list', { versionId: x.v }],
        ['content_analysis_request', { versionId: x.v, evidenceQuote: cita }],
        ['review_comment_add', { versionId: x.v, quote: 'el cierre es demasiado largo para el formato' }],
        ['script_request_changes', { versionId: x.v, quote: 'el cierre es demasiado largo para el formato' }],
        ['script_propose_approval', { versionId: x.v, evidenceQuote: cita }],
        // la fuente es ajena
        ['script_version_register', { sourceId: x.s, participantMention: 'Ajena', evidenceQuote: cita }],
        // la fuente es propia, pero la participación o el entregable son ajenos
        [
          'script_version_register',
          {
            sourceId: aliasPropia,
            participantMention: 'Diego Peña',
            participationId: x.p,
            evidenceQuote: cita,
          },
        ],
        [
          'script_version_register',
          {
            sourceId: aliasPropia,
            participantMention: 'Diego Peña',
            deliverableId: x.e,
            evidenceQuote: cita,
          },
        ],
      ];
      for (const [tool, args] of casos) {
        const res = await llamar(r, t, tool, args);
        expect(res.status, `${tool} ${JSON.stringify(Object.keys(args))}`).toBe('failed');
        // el grounding pasa (la persona dijo todo esto): lo que frena es el CERCO de campaña
        expect(res.errorCode, `${tool}: ${res.content.slice(0, 160)}`).toBe('RESOURCE_NOT_FOUND');
        // nada de lo ajeno vuelve al modelo
        expect(res.content).not.toContain('Ajena ');
        expect(res.content).not.toContain('Hallazgo ajeno');
        expect(res.content).not.toContain('Comentario ajeno');
      }
      // y las lecturas puras, más estrictas: SIEMPRE not found
      for (const [tool, args] of casos.filter(
        ([n]) =>
          !n.includes('_register') &&
          !n.includes('_add') &&
          !n.includes('_changes') &&
          !n.includes('_request') &&
          !n.includes('_propose'),
      )) {
        const res = await llamar(r, t, tool, args);
        expect(res.errorCode, tool).toBe('RESOURCE_NOT_FOUND');
      }
      expect(await estadoAjeno(aj)).toEqual(antes);
      expect(cliente.llamadas).toBe(0);
    });
  }

  it('un alias de hallazgo (H) o de comentario (C) no vale donde se pide una versión (V) o un entregable (E)', async () => {
    const t = await abrirTurno(
      a.e.consultor,
      a.e.campanaId,
      'revisa el hallazgo y el comentario de la versión',
    );
    const x = contaminar(t, enB);
    for (const tool of ['script_version_get', 'finding_list', 'review_comment_list']) {
      for (const alias of [x.h, x.c, x.e]) {
        const res = await llamar(r, t, tool, { versionId: alias });
        expect(res.status, `${tool} ${alias}`).toBe('failed');
        expect(res.errorCode, `${tool} ${alias}`).toBe(VALIDATION);
      }
    }
    for (const alias of [x.h, x.c, x.v]) {
      const res = await llamar(r, t, 'deliverable_get', { deliverableId: alias });
      expect(res.errorCode, alias).toBe(VALIDATION);
    }
  });
});

describe('alias inventados y UUID', () => {
  it('un alias que el run nunca registró (V42, E42, P42, S42) ⇒ RESOURCE_NOT_FOUND en cada tool', async () => {
    const t = await abrirTurno(
      a.e.consultor,
      a.e.campanaId,
      'comenta el guion: el cierre es demasiado largo para el formato',
    );
    for (const tool of ['script_version_get', 'finding_list', 'review_comment_list']) {
      expect((await llamar(r, t, tool, { versionId: 'V42' })).errorCode, tool).toBe('RESOURCE_NOT_FOUND');
    }
    expect((await llamar(r, t, 'deliverable_get', { deliverableId: 'E42' })).errorCode).toBe(
      'RESOURCE_NOT_FOUND',
    );
    expect((await llamar(r, t, 'deliverable_list', { participationId: 'P42' })).errorCode).toBe(
      'RESOURCE_NOT_FOUND',
    );
    expect(
      (
        await llamar(r, t, 'review_comment_add', {
          versionId: 'V42',
          quote: 'el cierre es demasiado largo para el formato',
        })
      ).errorCode,
    ).toBe('RESOURCE_NOT_FOUND');
  });

  it('un UUID (aunque sea REAL y de esta campaña) no pasa el esquema de ninguna tool: solo hay alias', async () => {
    const v = await registrarVersionDePrueba(a.e, a.e.entregables.reelDiego, a.e.participaciones.diego);
    const t = await abrirTurno(
      a.e.consultor,
      a.e.campanaId,
      'comenta el guion: el cierre es demasiado largo para el formato',
    );
    const reales = {
      versionId: v.versionId,
      deliverableId: a.e.entregables.reelDiego,
      participationId: a.e.participaciones.diego,
      sourceId: v.fuenteId,
    };
    for (const tool of [
      'script_version_get',
      'finding_list',
      'review_comment_list',
      'content_analysis_request',
      'review_comment_add',
      'script_request_changes',
      'script_propose_approval',
    ]) {
      const res = await llamar(r, t, tool, {
        versionId: reales.versionId,
        evidenceQuote: 'comenta el guion',
        quote: 'el cierre es demasiado largo para el formato',
      });
      expect(res.errorCode, tool).toBe(VALIDATION);
    }
    expect((await llamar(r, t, 'deliverable_get', { deliverableId: reales.deliverableId })).errorCode).toBe(
      VALIDATION,
    );
    expect(
      (await llamar(r, t, 'deliverable_list', { participationId: reales.participationId })).errorCode,
    ).toBe(VALIDATION);
    expect(
      (
        await llamar(r, t, 'script_version_register', {
          sourceId: reales.sourceId,
          participantMention: 'Diego',
          evidenceQuote: 'comenta el guion',
        })
      ).errorCode,
    ).toBe(VALIDATION);
  });

  it('`resolverAliasEstricto` (la capa de la tool) también rechaza un UUID que esté en el registro: RESOURCE_NOT_FOUND', () => {
    const referencias = new RegistroDeReferencias();
    const id = '123e4567-e89b-42d3-a456-426614174000';
    const alias = referencias.registrar({ kind: 'script_version', entityId: id }).alias;
    const ctx = { run: { referencias } } as unknown as ToolCtx;
    expect(resolverAliasEstricto(ctx, alias, 'script_version')).toEqual({ ok: true, value: id });
    for (const valor of [id, id.toUpperCase(), ` ${id} `, `V1;${id}`, 'V1 ', 7, null, undefined, {}]) {
      const x = resolverAliasEstricto(ctx, valor, 'script_version');
      if (valor === 'V1 ') {
        expect(x.ok).toBe(true); // el alias con espacios se recorta
      } else {
        expect(x.ok, String(valor)).toBe(false);
        expect(!x.ok && x.error.code).toBe(RECURSO_NO_ENCONTRADO.code);
      }
    }
    // el tipo debe coincidir
    expect(resolverAliasEstricto(ctx, alias, 'deliverable').ok).toBe(false);
  });
});

describe('defensa en profundidad: la capa del caso de uso por sí sola (alcance de campaña)', () => {
  it('con `alcance` de OTRA campaña, los casos de uso responden RESOURCE_NOT_FOUND (E, V, comentarios, hallazgos)', async () => {
    const alcance = { campaignId: a.e.campanaId };
    const e = await obtenerEntregable(a.e.admin, enB.entregableId, { alcance });
    expect(!e.ok && e.error.code).toBe('RESOURCE_NOT_FOUND');
    const v = await obtenerVersionDeGuion(a.e.admin, enB.versionId, { alcance });
    expect(!v.ok && v.error.code).toBe('RESOURCE_NOT_FOUND');
    const c = await listarComentariosDeRevision(a.e.admin, enB.versionId, {}, alcance);
    expect(!c.ok && c.error.code).toBe('RESOURCE_NOT_FOUND');
    const h = await listarHallazgos(a.e.admin, { versionId: enB.versionId }, alcance);
    expect(!h.ok && h.error.code).toBe('RESOURCE_NOT_FOUND');
    // y los de OTRA organización, aunque se pida con el alcance correcto de SU campaña: el actor no es de esa org
    const o = await obtenerVersionDeGuion(a.e.admin, enOtraOrg.versionId, {
      alcance: { campaignId: a.e.campanaAjenaId },
    });
    expect(!o.ok && o.error.code).toBe('RESOURCE_NOT_FOUND');
    // sin alcance (la UI) el mismo actor SÍ lee lo de su organización: el cerco es del agente, no un bug de lectura
    const sin = await obtenerVersionDeGuion(a.e.admin, enB.versionId);
    expect(sin.ok).toBe(true);
  });
});
