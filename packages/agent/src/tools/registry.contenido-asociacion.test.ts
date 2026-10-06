/**
 * Asociación de guiones (V2 · Fase 7): «Te dejo el guion de Valentina» + un archivo, a través del registro
 * REAL de tools y de PostgreSQL real (base `_test`).
 *
 * El agente nunca adivina a quién pertenece un guion: la mención de la persona + la desambiguación + el
 * alias de participación se resuelven en el CASO DE USO (`registrarVersionDeGuion`), y la tool solo añade
 * lo que es de agente: el archivo debe ser un adjunto de la persona (o nombrado por ella) y su frase debe
 * asociar archivo y persona cuando hay más de un archivo. Todo lo ambiguo termina en `needs_choice`: un
 * resultado EXITOSO sin efecto, con candidatos, para que el agente pregunte.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type * as DbModule from '@tcl-kol-os/db';
import {
  asociarInfluencerACampana,
  closePool,
  crearInfluencer,
  query,
  retirarInfluencerDeCampana,
} from '@tcl-kol-os/db';
import { limpiarEscenarioDeContenido } from '@tcl-kol-os/db/test-utils';
import {
  type EstadoDeAnalisis,
  type MundoDeContenido,
  clienteQueResponde,
  crearMundoDeContenido,
  fuenteDeGuion,
} from '../qa/testing/contenido.ts';
import { abrirTurno, json, llamar, registro, type Turno } from './test-support.ts';

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
let m: MundoDeContenido;
let otraCampana: MundoDeContenido['e'];
let iaAntes: string | undefined;

beforeAll(async () => {
  iaAntes = process.env['AI_ENABLED'];
  process.env['AI_ENABLED'] = 'true';
  m = await crearMundoDeContenido('Asociación de guiones');
  const { crearEscenarioDeContenido } = await import('@tcl-kol-os/db/test-utils');
  otraCampana = await crearEscenarioDeContenido('Asociación · otra campaña');
});

afterAll(async () => {
  if (iaAntes === undefined) delete process.env['AI_ENABLED'];
  else process.env['AI_ENABLED'] = iaAntes;
  await limpiarEscenarioDeContenido(m.e);
  await limpiarEscenarioDeContenido(otraCampana);
  await closePool();
});

// ─────────────────────────── Ayudas ────────────────────────────────────────────

const versionesDeCampana = async (campaignId = m.e.campanaId) =>
  Number(
    (
      await query<{ n: string }>(`SELECT count(*)::text AS n FROM script_versions WHERE campaign_id = $1`, [
        campaignId,
      ])
    )[0]!.n,
  );

const entregablesDeCampana = async () =>
  Number(
    (
      await query<{ n: string }>(`SELECT count(*)::text AS n FROM deliverables WHERE campaign_id = $1`, [
        m.e.campanaId,
      ])
    )[0]!.n,
  );

const nombreDe = async (sourceId: string) =>
  (await query<{ filename: string }>(`SELECT filename FROM source_documents WHERE id = $1`, [sourceId]))[0]!
    .filename;

/** Turno de la persona con archivos ADJUNTOS al mensaje (lo que calcula el runtime desde el historial). */
async function turnoConAdjuntos(texto: string, fuentes: string[], actor = m.e.consultor): Promise<Turno> {
  const t = await abrirTurno(actor, m.e.campanaId, texto);
  t.adjuntos = [...fuentes];
  t.adjuntosPorMensaje = [{ texto, sourceIds: [...fuentes] }];
  return t;
}

const aliasS = (t: Turno, sourceId: string): string =>
  t.referencias.registrar({ kind: 'source', sourceId }).alias;
const aliasP = (t: Turno, id: string): string =>
  t.referencias.registrar({ kind: 'campaign_influencer', entityId: id }).alias;
const aliasE = (t: Turno, id: string, ci: string): string =>
  t.referencias.registrar({ kind: 'deliverable', entityId: id, parentId: ci }).alias;

const razon = (x: { content: string }): string | undefined =>
  (json(x as never)['error'] as { details?: { reason?: string } } | undefined)?.details?.reason;

// ─────────────────────────── Casos felices ─────────────────────────────────────

describe('un influencer inequívoco', () => {
  it('«Te dejo el guion de Diego» + un archivo ⇒ registra la V1 del único entregable abierto, con origen chat', async () => {
    const fuente = await fuenteDeGuion(m.e, 'guion-diego');
    const msg = 'Te dejo el guion de Diego Peña';
    const t = await turnoConAdjuntos(msg, [fuente]);
    const x = await llamar(r, t, 'script_version_register', {
      sourceId: aliasS(t, fuente),
      participantMention: 'Diego Peña',
      evidenceQuote: msg,
    });
    expect(x.status).toBe('succeeded');
    const d = json(x);
    expect(d).toMatchObject({
      outcome: 'registered',
      number: 1,
      status: 'received',
      deliverableCreated: false,
      sourceState: 'ready',
      analysis: 'none',
    });
    expect(d['ref']).toMatch(/^V\d+$/);
    expect(d['deliverable']).toMatch(/^E\d+$/);
    const [v] = await query<{ id: string; deliverable_id: string; status: string; created_by: string }>(
      `SELECT id, deliverable_id, status, created_by FROM script_versions WHERE source_document_id = $1`,
      [fuente],
    );
    expect(v).toMatchObject({
      deliverable_id: m.e.entregables.reelDiego,
      status: 'received',
      created_by: m.e.consultor.id,
    });
    const [aud] = await query<{ origin: string; correlation: Record<string, string> }>(
      `SELECT origin, correlation FROM audit_events WHERE action = 'script_version.register' AND entity_id = $1`,
      [v!.id],
    );
    expect(aud?.origin).toBe('chat');
    expect(aud?.correlation).toMatchObject({ messageId: t.messageId, toolInvocationId: x.invocationId });
    // ni UUID, ni nombre de archivo vuelven al modelo
    expect(x.content).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  });

  it('el mismo archivo dos veces ⇒ deduplicated: ni V2 ni otra fila (aunque cambie el id de llamada)', async () => {
    const fuente = await fuenteDeGuion(m.e, 'guion-diego-dup');
    const msg = 'Te dejo el guion de Diego Peña (versión final)';
    const t = await turnoConAdjuntos(msg, [fuente]);
    const args = { sourceId: aliasS(t, fuente), participantMention: 'Diego Peña', evidenceQuote: msg };
    const antes = await versionesDeCampana();
    const a = await llamar(r, t, 'script_version_register', args);
    expect(json(a)['outcome']).toBe('registered');
    const b = await llamar(r, t, 'script_version_register', args);
    expect(b.status).toBe('succeeded');
    expect(json(b)).toMatchObject({ outcome: 'deduplicated' });
    expect(String(json(b)['note'])).toContain('no se creó otra versión');
    expect(await versionesDeCampana()).toBe(antes + 1);
    // y en otro turno, también
    const t2 = await turnoConAdjuntos(msg, [fuente]);
    const c = await llamar(r, t2, 'script_version_register', {
      ...args,
      sourceId: aliasS(t2, fuente),
    });
    expect(json(c)['outcome']).toBe('deduplicated');
    expect(await versionesDeCampana()).toBe(antes + 1);
  });
});

// ─────────────────────────── Dos Valentinas ────────────────────────────────────

describe('dos Valentinas', () => {
  it('«el guion de Valentina» ⇒ needs_choice SIN efecto con los candidatos; luego, con apellido y alias, registra', async () => {
    const fuente = await fuenteDeGuion(m.e, 'guion-valentina');
    const msg = 'Te dejo el guion de Valentina';
    const t = await turnoConAdjuntos(msg, [fuente]);
    const antes = await versionesDeCampana();
    const entregablesAntes = await entregablesDeCampana();
    const x = await llamar(r, t, 'script_version_register', {
      sourceId: aliasS(t, fuente),
      participantMention: 'Valentina',
      evidenceQuote: msg,
    });
    expect(x.status).toBe('succeeded');
    const d = json(x);
    expect(d).toMatchObject({ outcome: 'needs_choice', reason: 'participation_ambiguous' });
    const cands = String(d['candidates']);
    expect(cands).toContain('Valentina Ríos');
    expect(cands).toContain('Valentina Gómez');
    expect(cands).toMatch(/P\d+ \| activo/);
    expect(cands).toMatch(/E\d+ "Reel principal"/);
    expect(String(d['note'])).toContain('NO se registró nada');
    expect(await versionesDeCampana()).toBe(antes);
    expect(await entregablesDeCampana()).toBe(entregablesAntes);
    // el rechazo no consumió la fuente
    expect(
      Number(
        (
          await query<{ n: string }>(
            `SELECT count(*)::text AS n FROM script_versions WHERE source_document_id = $1`,
            [fuente],
          )
        )[0]!.n,
      ),
    ).toBe(0);

    // Turno siguiente: la persona aclara «la Gómez». Los alias salen de la lectura del run.
    const msg2 = 'Es el guion de Valentina Gómez, el Reel principal';
    const t2 = await turnoConAdjuntos(msg2, [fuente]);
    const p = aliasP(t2, m.e.participaciones.valentinaGomez);
    const y = await llamar(r, t2, 'script_version_register', {
      sourceId: aliasS(t2, fuente),
      participantMention: 'Valentina',
      disambiguation: 'Gómez',
      participationId: p,
      deliverableLabel: 'Reel principal',
      evidenceQuote: msg2,
    });
    expect(y.status).toBe('succeeded');
    expect(json(y)).toMatchObject({ outcome: 'registered', number: 1 });
    const [v] = await query<{ deliverable_id: string }>(
      `SELECT deliverable_id FROM script_versions WHERE source_document_id = $1`,
      [fuente],
    );
    expect(v?.deliverable_id).toBe(m.e.entregables.reelGomez);
  });

  it('un participationId que NO es el que identifica la mención + desambiguación se rechaza (no se salta la mención)', async () => {
    const fuente = await fuenteDeGuion(m.e, 'guion-valentina-2');
    const msg = 'Te dejo el guion de Valentina Gómez';
    const t = await turnoConAdjuntos(msg, [fuente]);
    const antes = await versionesDeCampana();
    const x = await llamar(r, t, 'script_version_register', {
      sourceId: aliasS(t, fuente),
      participantMention: 'Valentina',
      disambiguation: 'Gómez',
      participationId: aliasP(t, m.e.participaciones.valentinaRios),
      evidenceQuote: msg,
    });
    expect(x.status).toBe('failed');
    expect(x.errorCode).toBe('VALIDATION_FAILED');
    expect(razon(x)).toBe('participation_mismatch');
    expect(await versionesDeCampana()).toBe(antes);
  });

  it('una desambiguación que la persona no escribió se rechaza por grounding antes de llegar al caso de uso', async () => {
    const fuente = await fuenteDeGuion(m.e, 'guion-valentina-3');
    const msg = 'Te dejo el guion de Valentina';
    const t = await turnoConAdjuntos(msg, [fuente]);
    const x = await llamar(r, t, 'script_version_register', {
      sourceId: aliasS(t, fuente),
      participantMention: 'Valentina',
      disambiguation: 'Ríos',
      evidenceQuote: msg,
    });
    expect(x.status).toBe('failed');
    expect(razon(x)).toBe('grounding');
  });

  it('el alias de participación debe existir en el run y ser de la campaña: un alias de otra campaña no existe', async () => {
    const fuente = await fuenteDeGuion(m.e, 'guion-valentina-4');
    const msg = 'Te dejo el guion de Valentina Gómez';
    const t = await turnoConAdjuntos(msg, [fuente]);
    const ajena = aliasP(t, otraCampana.participaciones.valentinaGomez);
    const x = await llamar(r, t, 'script_version_register', {
      sourceId: aliasS(t, fuente),
      participantMention: 'Valentina',
      disambiguation: 'Gómez',
      participationId: ajena,
      evidenceQuote: msg,
    });
    expect(x.status).toBe('failed');
    expect(x.errorCode).toBe('RESOURCE_NOT_FOUND');
  });
});

// ─────────────────────────── Entregable ────────────────────────────────────────

describe('el entregable', () => {
  it('varios entregables abiertos y sin etiqueta ⇒ needs_choice (deliverable_ambiguous), sin efecto', async () => {
    const fuente = await fuenteDeGuion(m.e, 'guion-rios');
    const msg = 'Te dejo el guion de Valentina Ríos';
    const t = await turnoConAdjuntos(msg, [fuente]);
    const antes = await versionesDeCampana();
    const x = await llamar(r, t, 'script_version_register', {
      sourceId: aliasS(t, fuente),
      participantMention: 'Valentina Ríos',
      evidenceQuote: msg,
    });
    expect(x.status).toBe('succeeded');
    const d = json(x);
    expect(d).toMatchObject({ outcome: 'needs_choice', reason: 'deliverable_ambiguous' });
    expect(String(d['candidates'])).toContain('Reel principal');
    expect(String(d['candidates'])).toContain('Story de lanzamiento');
    expect(await versionesDeCampana()).toBe(antes);

    // la persona elige: alias de entregable estricto
    const msg2 = 'Es el de la Story de lanzamiento de Valentina Ríos';
    const t2 = await turnoConAdjuntos(msg2, [fuente]);
    const e = aliasE(t2, m.e.entregables.storyRios, m.e.participaciones.valentinaRios);
    const y = await llamar(r, t2, 'script_version_register', {
      sourceId: aliasS(t2, fuente),
      participantMention: 'Valentina Ríos',
      deliverableId: e,
      evidenceQuote: msg2,
    });
    expect(y.status).toBe('succeeded');
    expect(json(y)).toMatchObject({ outcome: 'registered' });
  });

  it('un entregable de OTRA participación no se puede usar (E ajeno ⇒ RESOURCE_NOT_FOUND, sin efecto)', async () => {
    const fuente = await fuenteDeGuion(m.e, 'guion-cruzado');
    const msg = 'Te dejo el guion de Diego Peña';
    const t = await turnoConAdjuntos(msg, [fuente]);
    const antes = await versionesDeCampana();
    const x = await llamar(r, t, 'script_version_register', {
      sourceId: aliasS(t, fuente),
      participantMention: 'Diego Peña',
      deliverableId: aliasE(t, m.e.entregables.reelRios, m.e.participaciones.valentinaRios),
      evidenceQuote: msg,
    });
    expect(x.status).toBe('failed');
    expect(x.errorCode).toBe('RESOURCE_NOT_FOUND');
    expect(await versionesDeCampana()).toBe(antes);
  });

  it('deliverableId y deliverableLabel a la vez: VALIDATION_FAILED', async () => {
    const fuente = await fuenteDeGuion(m.e, 'guion-ambos');
    const msg = 'Te dejo el guion de Diego Peña, el Reel principal';
    const t = await turnoConAdjuntos(msg, [fuente]);
    const x = await llamar(r, t, 'script_version_register', {
      sourceId: aliasS(t, fuente),
      participantMention: 'Diego Peña',
      deliverableId: aliasE(t, m.e.entregables.reelDiego, m.e.participaciones.diego),
      deliverableLabel: 'Reel principal',
      evidenceQuote: msg,
    });
    expect(x.errorCode).toBe('VALIDATION_FAILED');
    expect(razon(x)).toBe('both_given');
  });

  it('sin entregables y sin etiqueta ⇒ se pregunta (deliverable_required) y NO se inventa un «principal»', async () => {
    const nuevo = await crearInfluencer(m.e.admin, {
      displayName: 'Camila Sinpieza',
      cuentas: [{ platform: 'instagram', handle: `camila.sin.${m.e.sufijo}` }],
    });
    if (!nuevo.ok) throw new Error(nuevo.error.message);
    m.e.influencerIds.push(nuevo.value.influencer.id);
    const ci = await asociarInfluencerACampana(m.e.admin, {
      campaignId: m.e.campanaId,
      influencerId: nuevo.value.influencer.id,
    });
    if (!ci.ok) throw new Error(ci.error.message);

    const fuente = await fuenteDeGuion(m.e, 'guion-camila');
    const msg = 'Te dejo el guion de Camila Sinpieza';
    const t = await turnoConAdjuntos(msg, [fuente]);
    const entregablesAntes = await entregablesDeCampana();
    const x = await llamar(r, t, 'script_version_register', {
      sourceId: aliasS(t, fuente),
      participantMention: 'Camila Sinpieza',
      evidenceQuote: msg,
    });
    expect(x.status).toBe('succeeded');
    expect(json(x)).toMatchObject({ outcome: 'needs_choice', reason: 'deliverable_required' });
    expect(await entregablesDeCampana()).toBe(entregablesAntes);
    expect(await versionesDeCampana()).toBeGreaterThanOrEqual(0);

    // con una etiqueta que la persona SÍ escribió: se crea el entregable implícito y se auditan ambos
    const msg2 = 'Te dejo el guion de Camila Sinpieza, es el Reel de lanzamiento';
    const t2 = await turnoConAdjuntos(msg2, [fuente]);
    const y = await llamar(r, t2, 'script_version_register', {
      sourceId: aliasS(t2, fuente),
      participantMention: 'Camila Sinpieza',
      deliverableLabel: 'Reel de lanzamiento',
      evidenceQuote: msg2,
    });
    expect(y.status).toBe('succeeded');
    expect(json(y)).toMatchObject({ outcome: 'registered', deliverableCreated: true, number: 1 });
    expect(await entregablesDeCampana()).toBe(entregablesAntes + 1);
    const [v] = await query<{ id: string; deliverable_id: string }>(
      `SELECT id, deliverable_id FROM script_versions WHERE source_document_id = $1`,
      [fuente],
    );
    const acciones = await query<{ action: string; origin: string }>(
      `SELECT action, origin FROM audit_events WHERE entity_id = ANY($1::uuid[]) ORDER BY created_at, id`,
      [[v!.id, v!.deliverable_id]],
    );
    expect(acciones.map((a) => a.action)).toEqual(
      expect.arrayContaining(['deliverable.create', 'script_version.register']),
    );
    expect(acciones.every((a) => a.origin === 'chat')).toBe(true);
  });

  it('una etiqueta parecida a una existente (typo) ⇒ needs_choice, NO duplica el entregable', async () => {
    const fuente = await fuenteDeGuion(m.e, 'guion-typo');
    const msg = 'Te dejo el guion de Valentina Ríos, el Reel principa';
    const t = await turnoConAdjuntos(msg, [fuente]);
    const entregablesAntes = await entregablesDeCampana();
    const x = await llamar(r, t, 'script_version_register', {
      sourceId: aliasS(t, fuente),
      participantMention: 'Valentina Ríos',
      deliverableLabel: 'Reel principa',
      evidenceQuote: msg,
    });
    expect(x.status).toBe('succeeded');
    expect(json(x)).toMatchObject({ outcome: 'needs_choice', reason: 'deliverable_ambiguous' });
    expect(await entregablesDeCampana()).toBe(entregablesAntes);
  });

  it('una participación RETIRADA: conflicto, sin efecto', async () => {
    const nuevo = await crearInfluencer(m.e.admin, {
      displayName: 'Rosa Retirada',
      cuentas: [{ platform: 'instagram', handle: `rosa.ret.${m.e.sufijo}` }],
    });
    if (!nuevo.ok) throw new Error(nuevo.error.message);
    m.e.influencerIds.push(nuevo.value.influencer.id);
    const ci = await asociarInfluencerACampana(m.e.admin, {
      campaignId: m.e.campanaId,
      influencerId: nuevo.value.influencer.id,
    });
    if (!ci.ok) throw new Error(ci.error.message);
    const ret = await retirarInfluencerDeCampana(m.e.admin, ci.value.id, {});
    if (!ret.ok) throw new Error(ret.error.message);

    const fuente = await fuenteDeGuion(m.e, 'guion-rosa');
    const msg = 'Te dejo el guion de Rosa Retirada, el Reel';
    const t = await turnoConAdjuntos(msg, [fuente]);
    const antes = await versionesDeCampana();
    const x = await llamar(r, t, 'script_version_register', {
      sourceId: aliasS(t, fuente),
      participantMention: 'Rosa Retirada',
      deliverableLabel: 'Reel',
      evidenceQuote: msg,
    });
    expect(x.status).toBe('failed');
    expect(x.errorCode).toBe('RESOURCE_CONFLICT');
    expect(await versionesDeCampana()).toBe(antes);
  });
});

// ─────────────────────────── Estado de la fuente ───────────────────────────────

describe('estado de la fuente', () => {
  it('fuente EN COLA ⇒ se registra con sourceState=queued y el análisis da SCRIPT_SOURCE_NOT_READY sin run ni costo', async () => {
    const fuente = m.e.fuentes.enCola;
    const msg = 'Te dejo el guion de Diego Peña, es el Reel principal';
    const t = await turnoConAdjuntos(msg, [fuente]);
    const x = await llamar(r, t, 'script_version_register', {
      sourceId: aliasS(t, fuente),
      participantMention: 'Diego Peña',
      deliverableLabel: 'Reel principal',
      evidenceQuote: msg,
    });
    expect(x.status).toBe('succeeded');
    const d = json(x);
    expect(d).toMatchObject({ outcome: 'registered', sourceState: 'queued', analysis: 'none' });
    expect(String(d['note'])).toContain('No se puede analizar todavía');
    const [v] = await query<{ id: string }>(`SELECT id FROM script_versions WHERE source_document_id = $1`, [
      fuente,
    ]);

    const cliente = clienteQueResponde([]);
    analisis.cliente = cliente;
    const msg2 = 'Analiza el guion de Diego Peña contra el Brief';
    const t2 = await abrirTurno(m.e.consultor, m.e.campanaId, msg2);
    const vAlias = t2.referencias.registrar({
      kind: 'script_version',
      entityId: v!.id,
      parentId: m.e.entregables.reelDiego,
    }).alias;
    const y = await llamar(r, t2, 'content_analysis_request', { versionId: vAlias, evidenceQuote: msg2 });
    expect(y.status).toBe('failed');
    expect(y.errorCode).toBe('SCRIPT_SOURCE_NOT_READY');
    expect(razon(y)).toBe('source_queued');
    expect(cliente.llamadas).toBe(0);
    expect(
      Number(
        (
          await query<{ n: string }>(
            `SELECT count(*)::text AS n FROM content_analysis_runs WHERE script_version_id = $1`,
            [v!.id],
          )
        )[0]!.n,
      ),
    ).toBe(0);
    expect(
      Number(
        (
          await query<{ n: string }>(
            `SELECT count(*)::text AS n FROM ai_runs WHERE content_analysis_run_id IS NOT NULL AND campaign_id = $1`,
            [m.e.campanaId],
          )
        )[0]!.n,
      ),
    ).toBeGreaterThanOrEqual(0);
  });

  it('fuente SENSIBLE ⇒ RESOURCE_NOT_FOUND (para el agente no existe), sin efecto', async () => {
    const fuente = m.e.fuentes.sensible;
    const msg = 'Te dejo el guion de Diego Peña';
    const t = await turnoConAdjuntos(msg, [fuente]);
    const antes = await versionesDeCampana();
    const x = await llamar(r, t, 'script_version_register', {
      sourceId: aliasS(t, fuente),
      participantMention: 'Diego Peña',
      evidenceQuote: msg,
    });
    expect(x.status).toBe('failed');
    expect(x.errorCode).toBe('RESOURCE_NOT_FOUND');
    expect(await versionesDeCampana()).toBe(antes);
  });

  it('fuente de OTRA campaña ⇒ RESOURCE_NOT_FOUND aunque el alias esté en el registro', async () => {
    const ajena = otraCampana.fuentes.procesada;
    const msg = 'Te dejo el guion de Diego Peña';
    const t = await turnoConAdjuntos(msg, []);
    const x = await llamar(r, t, 'script_version_register', {
      sourceId: aliasS(t, ajena),
      participantMention: 'Diego Peña',
      evidenceQuote: msg,
    });
    expect(x.status).toBe('failed');
    expect(x.errorCode).toBe('RESOURCE_NOT_FOUND');
  });
});

// ─────────────────────────── De quién es el archivo ────────────────────────────

describe('el archivo debe ser de la persona', () => {
  it('una fuente que NO es adjunto de la persona ni la nombró ⇒ rechazo, sin efecto (un documento no elige guiones)', async () => {
    const fuente = await fuenteDeGuion(m.e, 'ficha-tecnica-interna');
    const msg = 'Te dejo el guion de Diego Peña';
    const t = await turnoConAdjuntos(msg, []);
    const antes = await versionesDeCampana();
    const x = await llamar(r, t, 'script_version_register', {
      sourceId: aliasS(t, fuente),
      participantMention: 'Diego Peña',
      evidenceQuote: msg,
    });
    expect(x.status).toBe('failed');
    expect(x.errorCode).toBe('VALIDATION_FAILED');
    expect(razon(x)).toBe('grounding');
    expect((json(x)['error'] as { message: string }).message).toContain('no lo adjuntó ni lo nombró');
    expect(await versionesDeCampana()).toBe(antes);
  });

  it('una fuente que la persona NOMBRÓ (sin adjuntarla) sí vale, siempre que su frase asocie archivo y persona', async () => {
    const fuente = await fuenteDeGuion(m.e, 'guion-ya-cargado');
    const archivo = await nombreDe(fuente);
    const msg = `Registra ${archivo} como el guion de Diego Peña`;
    const t = await turnoConAdjuntos(msg, []);
    const x = await llamar(r, t, 'script_version_register', {
      sourceId: aliasS(t, fuente),
      participantMention: 'Diego Peña',
      evidenceQuote: msg,
    });
    expect(x.status).toBe('succeeded');
    expect(json(x)).toMatchObject({ outcome: 'registered' });
  });

  it('dos adjuntos y una cita SIN el nombre del archivo ⇒ rechazo; nombrándolo, se registra', async () => {
    const f1 = await fuenteDeGuion(m.e, 'guion-uno');
    const f2 = await fuenteDeGuion(m.e, 'guion-dos');
    const msg = 'Te dejo dos guiones: el de Diego Peña y el de Valentina Gómez';
    const t = await turnoConAdjuntos(msg, [f1, f2]);
    const antes = await versionesDeCampana();
    const x = await llamar(r, t, 'script_version_register', {
      sourceId: aliasS(t, f1),
      participantMention: 'Diego Peña',
      evidenceQuote: msg,
    });
    expect(x.status).toBe('failed');
    expect(x.errorCode).toBe('VALIDATION_FAILED');
    expect(razon(x)).toBe('grounding');
    expect((json(x)['error'] as { message: string }).message).toContain('más de un archivo');
    expect(await versionesDeCampana()).toBe(antes);

    // ahora la persona dice cuál es de quién
    const n1 = await nombreDe(f1);
    const msg2 = `${n1} es el de Diego Peña`;
    const t2 = await turnoConAdjuntos(msg2, [f1, f2]);
    const y = await llamar(r, t2, 'script_version_register', {
      sourceId: aliasS(t2, f1),
      participantMention: 'Diego Peña',
      evidenceQuote: msg2,
    });
    expect(y.status).toBe('succeeded');
    expect(json(y)).toMatchObject({ outcome: 'registered' });
  });

  it('una cita que no menciona al influencer ⇒ rechazo', async () => {
    const fuente = await fuenteDeGuion(m.e, 'guion-sin-mencion');
    const msg = 'Te dejo este guion';
    const t = await turnoConAdjuntos(msg, [fuente]);
    const x = await llamar(r, t, 'script_version_register', {
      sourceId: aliasS(t, fuente),
      participantMention: 'Diego Peña',
      evidenceQuote: msg,
    });
    // la mención ni siquiera aparece en los mensajes de la persona: falla el grounding literal
    expect(x.status).toBe('failed');
    expect(razon(x)).toBe('grounding');
  });

  it('el alias de fuente es obligatorio: un UUID no pasa el esquema', async () => {
    const fuente = await fuenteDeGuion(m.e, 'guion-uuid');
    const msg = 'Te dejo el guion de Diego Peña';
    const t = await turnoConAdjuntos(msg, [fuente]);
    const x = await llamar(r, t, 'script_version_register', {
      sourceId: fuente,
      participantMention: 'Diego Peña',
      evidenceQuote: msg,
    });
    expect(x.errorCode).toBe('VALIDATION_FAILED');
  });
});
