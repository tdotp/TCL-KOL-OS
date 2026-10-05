/**
 * QA adversarial · vector 2: HITL (el chat / system / el agente nunca aprueban, confirman ni ejecutan).
 *
 * Todas las propuestas las deja el REGISTRO de tools real (origin=chat). Los ataques se hacen contra
 * los casos de uso de db y, donde aplica, contra el SQL directo. BD real (base `_test`).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  aprobarBrief,
  applyInfluencerImport,
  cancelarAccion,
  closePool,
  confirmarAccion,
  corregirCampo,
  crearBriefManual,
  ejecutarAccion,
  proponerAccion,
  query,
  resolveImportRecord,
  transicionarBrief,
  getPool,
} from '@tcl-kol-os/db';
import {
  type EscenarioDeChat,
  asegurarUsuarioDePrueba,
  crearEscenarioDeChat,
  eliminarCampanaDePrueba,
  eliminarInfluencersDePrueba,
} from '@tcl-kol-os/db/test-utils';
import type { User } from '@tcl-kol-os/domain';
import { abrirTurno, codigo, contar, json, llamar, nuevaCampana, registro } from './testing/harness.ts';
import { GoogleSimulado, hayWorkerLocal, prepararPlan, type GoogleSimuladoLike } from './testing/sheet.ts';

let e: EscenarioDeChat;
let google: GoogleSimuladoLike;
let director2: User;
const r = registro();
const sufijo = Date.now().toString(36);
const influencers: string[] = [];

beforeAll(async () => {
  e = await crearEscenarioDeChat('QA HITL');
  google = await GoogleSimulado.crear();
  director2 = await asegurarUsuarioDePrueba(
    `qa-director2-${sufijo}@smartpr.co`,
    'Director dos QA',
    'director',
    e.admin.organizationId,
  );
});
afterAll(async () => {
  await eliminarInfluencersDePrueba(influencers).catch(() => undefined);
  await eliminarCampanaDePrueba(e.campanas);
  await google.limpiar();
  await closePool();
});

/** Campaña con una versión de brief en `internal_review` y la propuesta que deja la tool del agente. */
async function propuestaDeAprobacion(etiqueta: string) {
  const campana = await nuevaCampana(e.admin.organizationId, e.admin.id, `HITL ${etiqueta}`, e.campanas);
  const creado = await crearBriefManual(e.admin, campana);
  if (!creado.ok) throw new Error(creado.error.message);
  await query(`UPDATE brief_versions SET status = 'internal_review' WHERE id = $1`, [creado.value.versionId]);
  const t = await abrirTurno(e.consultor, campana, 'Propón la aprobación del brief, por favor');
  const x = await llamar(r, t, 'brief_propose_approval', { evidenceQuote: 'Propón la aprobación del brief' });
  if (x.status !== 'succeeded' || x.proposedActionId === undefined)
    throw new Error(`propuesta: ${x.content}`);
  const [p] = await query<{ payload_hash: string }>(
    `SELECT payload_hash FROM proposed_actions WHERE id = $1`,
    [x.proposedActionId],
  );
  return {
    campana,
    versionId: creado.value.versionId,
    id: x.proposedActionId,
    hash: p!.payload_hash,
    turno: t,
  };
}

const estadoDe = async (id: string) =>
  (await query<{ status: string }>(`SELECT status FROM proposed_actions WHERE id = $1`, [id]))[0]!.status;
const estadoVersion = async (id: string) =>
  (await query<{ status: string }>(`SELECT status::text FROM brief_versions WHERE id = $1`, [id]))[0]!.status;

describe('H1 · el agente (origin chat) y system no tienen camino a la decisión', () => {
  it('confirmar y ejecutar con canal chat/system o actor system se rechazan para los 3 tipos', async () => {
    const a = await propuestaDeAprobacion('canales');
    for (const canal of ['chat', 'system'] as const) {
      const c = await confirmarAccion(e.admin, a.id, { canal, payloadHash: a.hash });
      expect(!c.ok && c.error.code, `confirmar ${canal}`).toBe('HUMAN_CONFIRMATION_REQUIRED');
      const x = await ejecutarAccion(e.admin, a.id, { canal });
      expect(!x.ok && x.error.code, `ejecutar ${canal}`).toBe('HUMAN_CONFIRMATION_REQUIRED');
    }
    expect((await confirmarAccion('system', a.id, { canal: 'ui', payloadHash: a.hash })).ok).toBe(false);
    expect((await ejecutarAccion('system', a.id, { canal: 'ui' })).ok).toBe(false);
    expect(await estadoDe(a.id)).toBe('pending');
    expect(await estadoVersion(a.versionId)).toBe('internal_review');
  });

  it('transicionarBrief / aprobarBrief hacia approved con origin chat o system, o actor system, no aprueban', async () => {
    const a = await propuestaDeAprobacion('transicion');
    for (const origen of ['chat', 'system'] as const) {
      const t = await transicionarBrief(e.admin, a.versionId, 'approved', { origen });
      expect(!t.ok && t.error.code, `transicionar ${origen}`).toBe('HUMAN_CONFIRMATION_REQUIRED');
      const ap = await aprobarBrief(e.admin, a.versionId, { origen });
      expect(ap.ok, `aprobarBrief ${origen}`).toBe(false);
    }
    expect((await transicionarBrief('system', a.versionId, 'approved')).ok).toBe(false);
    expect(await estadoVersion(a.versionId)).toBe('internal_review');
  });

  it('proponer como `system` un tipo de importación se rechaza; proponer como persona con origin system también', async () => {
    const a = await propuestaDeAprobacion('proponer-system');
    const r1 = await proponerAccion('system', {
      type: 'influencer_import.apply',
      resourceId: a.versionId,
    });
    expect(r1.ok).toBe(false);
    const r2 = await proponerAccion(e.consultor, {
      type: 'brief.approve',
      resourceId: a.versionId,
      origin: 'system',
    });
    expect(r2.ok).toBe(false);
    // tipos inventados o heredados del prototipo no son acciones
    for (const type of ['constructor', '__proto__', 'toString', 'brief.approve ', 'BRIEF.APPROVE']) {
      const x = await proponerAccion(e.consultor, { type: type as never, resourceId: a.versionId });
      expect(x.ok, type).toBe(false);
    }
  });

  it('el rol sin la capacidad no ve ni propone: operativo, cliente, analista y legal (lectura y escritura)', async () => {
    const a = await propuestaDeAprobacion('roles');
    for (const actor of [e.operativo, e.cliente, e.analista, e.legal]) {
      const p = await proponerAccion(actor, {
        type: 'brief.approve',
        resourceId: a.versionId,
        origin: 'chat',
      });
      expect(p.ok, `${actor.role} propuso`).toBe(false);
      const c = await confirmarAccion(actor, a.id, { canal: 'ui', payloadHash: a.hash });
      expect(c.ok, `${actor.role} confirmó`).toBe(false);
      const x = await cancelarAccion(actor, a.id);
      expect(x.ok, `${actor.role} canceló`).toBe(false);
    }
    expect(await estadoDe(a.id)).toBe('pending');
  });
});

describe('H2 · ciclo de vida de la propuesta del agente', () => {
  it('flujo completo: propone el agente, confirma y ejecuta la persona (ui); aprobación única, auditada con la correlación de la propuesta', async () => {
    const a = await propuestaDeAprobacion('flujo');
    const c = await confirmarAccion(e.admin, a.id, { canal: 'ui', payloadHash: a.hash });
    expect(c.ok).toBe(true);
    const x = await ejecutarAccion(e.admin, a.id, { canal: 'ui' });
    expect(x.ok).toBe(true);
    expect(await estadoVersion(a.versionId)).toBe('approved');
    const ev = await query<{ origin: string; correlation: Record<string, string> | null; action: string }>(
      `SELECT origin, correlation, action FROM audit_events WHERE entity_id = $1 AND action = 'brief.transition' ORDER BY created_at`,
      [a.versionId],
    );
    const aprobacion = ev.filter((v) => (v as unknown as { metadata?: unknown }) !== undefined);
    expect(aprobacion.every((v) => v.origin !== 'chat')).toBe(true);
    // la decisión humana queda con origin ui y nunca con la correlación de la tool
    const decididos = await query<{ origin: string; correlation: Record<string, string> | null }>(
      `SELECT origin, correlation FROM audit_events WHERE entity_type = 'brief_version' AND entity_id = $1 AND metadata->>'to' = 'approved'`,
      [a.versionId],
    );
    expect(decididos).toHaveLength(1);
    expect(decididos[0]!.origin).toBe('ui');
    expect(decididos[0]!.correlation?.['proposedActionId']).toBe(a.id);
    expect(decididos[0]!.correlation?.['toolInvocationId']).toBeUndefined();
  });

  it('ejecutar sin confirmar, ejecutar por otro admin que no confirmó, y repetir una ejecución: todo rechazado; un solo efecto', async () => {
    const a = await propuestaDeAprobacion('replay');
    const sinConfirmar = await ejecutarAccion(e.admin, a.id, { canal: 'ui' });
    expect(!sinConfirmar.ok && sinConfirmar.error.code).toBe('PROPOSAL_INVALID_STATE');
    expect((await confirmarAccion(e.admin, a.id, { canal: 'ui', payloadHash: a.hash })).ok).toBe(true);
    const otro = await ejecutarAccion(director2, a.id, { canal: 'ui' });
    expect(!otro.ok && otro.error.code).toBe('HUMAN_CONFIRMATION_REQUIRED');
    expect((await ejecutarAccion(e.admin, a.id, { canal: 'ui' })).ok).toBe(true);
    for (let i = 0; i < 3; i++) {
      const rep = await ejecutarAccion(e.admin, a.id, { canal: 'ui' });
      expect(!rep.ok && rep.error.code).toBe('PROPOSAL_INVALID_STATE');
    }
    expect(
      await contar(
        `audit_events WHERE entity_id = $1 AND action = 'brief.transition' AND metadata->>'to' = 'approved'`,
        [a.versionId],
      ),
    ).toBe(1);
    expect(
      await contar(`audit_events WHERE entity_id = $1 AND action = 'proposed_action.execute'`, [a.id]),
    ).toBe(1);
  });

  it('un payloadHash viejo, ajeno o inventado no confirma; confirmar dos veces tampoco', async () => {
    const a = await propuestaDeAprobacion('hash');
    const b = await propuestaDeAprobacion('hash-b');
    for (const h of [b.hash, 'a'.repeat(64), '', a.hash.toUpperCase()]) {
      const c = await confirmarAccion(e.admin, a.id, { canal: 'ui', payloadHash: h });
      expect(!c.ok && c.error.code, h.slice(0, 8)).toBe('PROPOSAL_STALE');
    }
    expect((await confirmarAccion(e.admin, a.id, { canal: 'ui', payloadHash: a.hash })).ok).toBe(true);
    const otra = await confirmarAccion(director2, a.id, { canal: 'ui', payloadHash: a.hash });
    expect(!otra.ok && otra.error.code).toBe('PROPOSAL_INVALID_STATE');
  });

  it('cambio de contenido entre propuesta y confirmación, y entre confirmación y ejecución = PROPOSAL_STALE, sin aprobar', async () => {
    for (const fase of ['confirmar', 'ejecutar'] as const) {
      const a = await propuestaDeAprobacion(`stale-${fase}`);
      const [campo] = await query<{ id: string; revision: number }>(
        `SELECT id, revision FROM brief_fields WHERE brief_version_id = $1 LIMIT 1`,
        [a.versionId],
      );
      if (fase === 'ejecutar') {
        expect((await confirmarAccion(e.admin, a.id, { canal: 'ui', payloadHash: a.hash })).ok).toBe(true);
      }
      const ed = await corregirCampo(e.admin, a.versionId, campo!.id, {
        value: 'Valor cambiado tras la propuesta',
        revisionEsperada: campo!.revision,
      });
      expect(ed.ok, !ed.ok ? ed.error.message : '').toBe(true);
      const x =
        fase === 'confirmar'
          ? await confirmarAccion(e.admin, a.id, { canal: 'ui', payloadHash: a.hash })
          : await ejecutarAccion(e.admin, a.id, { canal: 'ui' });
      expect(!x.ok && x.error.code, fase).toBe('PROPOSAL_STALE');
      expect(await estadoVersion(a.versionId)).toBe('internal_review');
    }
  });

  it('una propuesta vencida (TTL 1 s) no se confirma ni se ejecuta; pasa a `expired` con auditoría', async () => {
    const campana = await nuevaCampana(e.admin.organizationId, e.admin.id, 'HITL ttl', e.campanas);
    const creado = await crearBriefManual(e.admin, campana);
    if (!creado.ok) throw new Error('brief');
    await query(`UPDATE brief_versions SET status = 'internal_review' WHERE id = $1`, [
      creado.value.versionId,
    ]);
    const p = await proponerAccion(e.consultor, {
      type: 'brief.approve',
      resourceId: creado.value.versionId,
      origin: 'chat',
      ttlSegundos: 1,
    });
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    await new Promise((res) => setTimeout(res, 1_300));
    const c = await confirmarAccion(e.admin, p.value.id, { canal: 'ui', payloadHash: p.value.payloadHash });
    expect(!c.ok && c.error.code).toBe('PROPOSAL_EXPIRED');
    expect(await estadoDe(p.value.id)).toBe('expired');
    expect(await estadoVersion(creado.value.versionId)).toBe('internal_review');
    // y la propuesta vencida libera el recurso para una nueva
    const otra = await proponerAccion(e.consultor, {
      type: 'brief.approve',
      resourceId: creado.value.versionId,
      origin: 'chat',
    });
    expect(otra.ok && otra.value.id !== p.value.id).toBe(true);
  });
});

describe('H3 · carreras', () => {
  it('N confirmaciones simultáneas: exactamente una gana; N ejecuciones simultáneas: un solo efecto de dominio', async () => {
    const a = await propuestaDeAprobacion('carrera');
    const conf = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        confirmarAccion(i % 2 === 0 ? e.admin : director2, a.id, { canal: 'ui', payloadHash: a.hash }),
      ),
    );
    const ganadoras = conf.filter((x) => x.ok);
    expect(ganadoras).toHaveLength(1);
    const confirmador = (
      await query<{ confirmed_by: string }>(`SELECT confirmed_by FROM proposed_actions WHERE id = $1`, [a.id])
    )[0]!.confirmed_by;
    const quien = confirmador === e.admin.id ? e.admin : director2;
    const exe = await Promise.all(
      Array.from({ length: 6 }, () => ejecutarAccion(quien, a.id, { canal: 'ui' })),
    );
    expect(exe.filter((x) => x.ok)).toHaveLength(1);
    expect(
      await contar(
        `audit_events WHERE entity_id = $1 AND action = 'brief.transition' AND metadata->>'to' = 'approved'`,
        [a.versionId],
      ),
    ).toBe(1);
  });

  it('confirmar vs cancelar en carrera: el estado final es uno solo y coherente', async () => {
    const a = await propuestaDeAprobacion('conf-cancel');
    const [c, x] = await Promise.all([
      confirmarAccion(e.admin, a.id, { canal: 'ui', payloadHash: a.hash }),
      cancelarAccion(e.consultor, a.id),
    ]);
    const estado = await estadoDe(a.id);
    expect(['confirmed', 'cancelled']).toContain(estado);
    if (estado === 'confirmed') expect(c.ok).toBe(true);
    if (estado === 'cancelled') expect(x.ok).toBe(true);
    // si quedó confirmada, el consultor (proponente) aún puede cancelarla; después nadie ejecuta
    if (estado === 'confirmed') {
      expect((await cancelarAccion(e.consultor, a.id)).ok).toBe(true);
    }
    const ej = await ejecutarAccion(e.admin, a.id, { canal: 'ui' });
    expect(ej.ok).toBe(false);
    expect(await estadoVersion(a.versionId)).toBe('internal_review');
  });

  it('N propuestas simultáneas sobre el mismo recurso dejan UNA abierta (índice parcial + advisory lock)', async () => {
    const a = await propuestaDeAprobacion('proponer-carrera');
    const res = await Promise.all(
      Array.from({ length: 10 }, () =>
        proponerAccion(e.consultor, { type: 'brief.approve', resourceId: a.versionId, origin: 'chat' }),
      ),
    );
    expect(res.every((x) => x.ok)).toBe(true);
    const ids = new Set(res.map((x) => (x.ok ? x.value.id : '')));
    expect(ids.size).toBe(1);
    expect(
      await contar(`proposed_actions WHERE resource_id = $1 AND status IN ('pending','confirmed')`, [
        a.versionId,
      ]),
    ).toBe(1);
  });
});

describe('H4 · aislamiento de la propuesta', () => {
  it('un admin de OTRA organización no ve, confirma, cancela ni ejecuta; el rol sin permiso tampoco la lee con la tool', async () => {
    const a = await propuestaDeAprobacion('tenant');
    const c = await confirmarAccion(e.ajeno, a.id, { canal: 'ui', payloadHash: a.hash });
    expect(!c.ok && c.error.code).toBe('RESOURCE_NOT_FOUND');
    expect((await cancelarAccion(e.ajeno, a.id)).ok).toBe(false);
    expect((await ejecutarAccion(e.ajeno, a.id, { canal: 'ui' })).ok).toBe(false);
    expect(await estadoDe(a.id)).toBe('pending');
    // un id de propuesta de otra campaña (misma org) no se lee desde una conversación de otra campaña
    const t2 = await abrirTurno(e.consultor, e.otraCampanaId, 'estado de la propuesta');
    expect(codigo(await llamar(r, t2, 'proposed_action_get', { proposedActionId: a.id }))).toBe(
      'RESOURCE_NOT_FOUND',
    );
    // proponer sobre una versión de brief de OTRA organización
    const ajena = await nuevaCampana(e.ajeno.organizationId, e.ajeno.id, 'HITL ajena', e.campanas);
    const bj = await crearBriefManual(e.ajeno, ajena);
    if (!bj.ok) throw new Error('brief ajeno');
    await query(`UPDATE brief_versions SET status = 'internal_review' WHERE id = $1`, [bj.value.versionId]);
    const p = await proponerAccion(e.consultor, {
      type: 'brief.approve',
      resourceId: bj.value.versionId,
      origin: 'chat',
    });
    expect(!p.ok && p.error.code).toBe('RESOURCE_NOT_FOUND');
    // y con el alcance de campaña del chat: una versión de otra campaña (misma org)
    const dentro = await proponerAccion(e.consultor, {
      type: 'brief.approve',
      resourceId: a.versionId,
      origin: 'chat',
      campaignId: e.otraCampanaId,
    });
    expect(!dentro.ok && dentro.error.code).toBe('RESOURCE_NOT_FOUND');
  });
});

describe('H5 · SQL directo contra los triggers de proposed_actions', () => {
  it('los estados imposibles y la edición del contenido se rechazan; DELETE también', async () => {
    const a = await propuestaDeAprobacion('sql');
    const falla = async (sql: string, params: unknown[] = []) => {
      let msg = '';
      try {
        await query(sql, params);
      } catch (err) {
        msg = (err as Error).message;
      }
      return msg;
    };
    expect(
      await falla(`UPDATE proposed_actions SET status = 'executed', executed_at = now() WHERE id = $1`, [
        a.id,
      ]),
    ).toMatch(/Transición|no válida|confirmed_by|violates/i);
    expect(await falla(`UPDATE proposed_actions SET payload = '{}'::jsonb WHERE id = $1`, [a.id])).toMatch(
      /inmutable/,
    );
    expect(
      await falla(`UPDATE proposed_actions SET payload_hash = $2 WHERE id = $1`, [a.id, 'b'.repeat(64)]),
    ).toMatch(/inmutable/);
    expect(
      await falla(`UPDATE proposed_actions SET expires_at = now() + interval '10 years' WHERE id = $1`, [
        a.id,
      ]),
    ).toMatch(/inmutable/);
    expect(await falla(`UPDATE proposed_actions SET proposed_origin = 'ui' WHERE id = $1`, [a.id])).toMatch(
      /inmutable/,
    );
    expect(
      await falla(`UPDATE proposed_actions SET proposed_by = $2 WHERE id = $1`, [a.id, e.admin.id]),
    ).toMatch(/inmutable/);
    expect(
      await falla(`UPDATE proposed_actions SET confirmed_by = $2 WHERE id = $1`, [a.id, e.admin.id]),
    ).toMatch(/solo cambia sus marcas/);
    expect(await falla(`DELETE FROM proposed_actions WHERE id = $1`, [a.id])).toMatch(/no admite DELETE/);
    // terminal → pending
    expect((await confirmarAccion(e.admin, a.id, { canal: 'ui', payloadHash: a.hash })).ok).toBe(true);
    expect((await ejecutarAccion(e.admin, a.id, { canal: 'ui' })).ok).toBe(true);
    for (const destino of ['pending', 'confirmed', 'cancelled', 'expired']) {
      expect(
        await falla(`UPDATE proposed_actions SET status = $2 WHERE id = $1`, [a.id, destino]),
        destino,
      ).toMatch(/terminales|no válida|Transición/);
    }
  });

  it('un segundo INSERT abierto para el mismo recurso lo rechaza el índice único parcial (D7)', async () => {
    const a = await propuestaDeAprobacion('unique');
    let msg = '';
    try {
      await query(
        `INSERT INTO proposed_actions (organization_id, campaign_id, action_type, resource_type, resource_id, payload, payload_hash, proposed_origin, expires_at)
         VALUES ($1, $2, 'brief.approve', 'brief_version', $3, '{}'::jsonb, $4, 'chat', now() + interval '1 hour')`,
        [e.admin.organizationId, a.campana, a.versionId, 'c'.repeat(64)],
      );
    } catch (err) {
      msg = (err as Error).message;
    }
    expect(msg).toMatch(/proposed_actions_abierta_key|duplicate/);
  });

  it('el pool sigue sano tras los errores (no quedaron transacciones abiertas)', async () => {
    const { rows } = await getPool().query<{ n: string }>(
      `SELECT count(*)::text AS n FROM pg_stat_activity WHERE datname = current_database() AND state = 'idle in transaction'`,
    );
    expect(Number(rows[0]!.n)).toBe(0);
  });
});

describe.skipIf(!hayWorkerLocal())(
  'H6 · importación de influencers: apply / resolve solo por confirmación humana',
  () => {
    it('applyInfluencerImport y resolveImportRecord con origin chat se rechazan; la tool solo propone; la persona ejecuta una vez', async () => {
      const campana = await nuevaCampana(e.admin.organizationId, e.admin.id, 'HITL import', e.campanas);
      const plan = await prepararPlan(google, e.consultor, campana, [
        ['QA-1', `Valentina QA ${sufijo}`, 'instagram', `@valeqa${sufijo}`, ''],
        ['QA-2', `Camilo QA ${sufijo}`, 'tiktok', `@camiqa${sufijo}`, ''],
      ]);
      expect(plan.recordIds.length).toBe(2);

      // 1) el agente NO puede aplicar: ni con origin chat ni con system
      const chat = await applyInfluencerImport(e.consultor, plan.planId, { origin: 'chat' });
      expect(!chat.ok && chat.error.code).toBe('HUMAN_CONFIRMATION_REQUIRED');
      const sys = await applyInfluencerImport(e.consultor, plan.planId, { origin: 'system' });
      expect(sys.ok).toBe(false);
      const res = await resolveImportRecord(
        e.consultor,
        plan.recordIds[0]!,
        { kind: 'ignore_record' },
        { origin: 'chat' },
      );
      expect(!res.ok && res.error.code).toBe('HUMAN_CONFIRMATION_REQUIRED');
      expect(await contar('campaign_influencers WHERE campaign_id = $1', [campana])).toBe(0);

      // 2) la tool deja una propuesta; nada se aplica
      const x = await llamar(r, plan.turno, 'sheet_propose_apply', {
        planId: plan.planAlias,
        evidenceQuote: 'propón aplicarlo',
      });
      expect(x.status).toBe('succeeded');
      expect(json(x)['requiresHumanConfirmation']).toBe(true);
      const id = x.proposedActionId!;
      expect(await contar('campaign_influencers WHERE campaign_id = $1', [campana])).toBe(0);
      const [p] = await query<{ payload_hash: string; proposed_origin: string }>(
        `SELECT payload_hash, proposed_origin FROM proposed_actions WHERE id = $1`,
        [id],
      );
      expect(p!.proposed_origin).toBe('chat');

      // 3) operativo / cliente / analista / legal no confirman
      for (const actor of [e.operativo, e.cliente, e.analista, e.legal]) {
        const c = await confirmarAccion(actor, id, { canal: 'ui', payloadHash: p!.payload_hash });
        expect(c.ok, actor.role).toBe(false);
      }
      // 4) la persona confirma y ejecuta (ui): se aplica UNA vez
      expect((await confirmarAccion(e.consultor, id, { canal: 'ui', payloadHash: p!.payload_hash })).ok).toBe(
        true,
      );
      const ej = await Promise.all(
        Array.from({ length: 4 }, () => ejecutarAccion(e.consultor, id, { canal: 'ui' })),
      );
      expect(ej.filter((z) => z.ok)).toHaveLength(1);
      expect(await contar('campaign_influencers WHERE campaign_id = $1', [campana])).toBe(2);
      const ev = await query<{ origin: string; correlation: Record<string, string> | null }>(
        `SELECT origin, correlation FROM audit_events WHERE correlation->>'proposedActionId' = $1 AND action NOT LIKE 'proposed_action.%'`,
        [id],
      );
      expect(ev.length).toBeGreaterThan(0);
      expect(ev.every((v) => v.origin === 'ui')).toBe(true);
      // un id de plan de OTRA campaña no se propone
      const t2 = await abrirTurno(e.consultor, e.campanaId, 'propón aplicar el plan');
      expect(
        codigo(
          await llamar(r, t2, 'sheet_propose_apply', {
            planId: plan.planId,
            evidenceQuote: 'propón aplicar',
          }),
        ),
      ).toBe('RESOURCE_NOT_FOUND');
      const ids = await query<{ influencer_id: string }>(
        `SELECT influencer_id FROM campaign_influencers WHERE campaign_id = $1`,
        [campana],
      );
      influencers.push(...ids.map((i) => i.influencer_id));
    });
  },
);
