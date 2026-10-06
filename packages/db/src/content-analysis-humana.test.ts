/**
 * V2 · Fase 7 — revisión HUMANA contra el Brief rector (kind = 'human'), PostgreSQL real.
 *
 * Solo una persona por la interfaz (`ui`); nunca el chat, el sistema ni la IA. Es una revisión válida para
 * aprobar (igual que la asistida) pero SIN hallazgos; queda STALE si cambia el Brief rector.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Result, User } from '@tcl-kol-os/domain';
import { closePool, query } from './client.ts';
import { ClienteDeAnalisisGuionado, falloGuionado } from './content-analysis-client.ts';
import {
  ENV_CON_IA,
  type EscenarioDeAnalisis,
  claveNueva,
  clienteQueResponde,
  crearEscenarioDeAnalisis,
  registrarGuionDePrueba,
} from './content-analysis-test-support.ts';
import {
  huellaDeBriefRector,
  listarHallazgos,
  listarRevisiones,
  obtenerRevisionVigente,
  registrarRevisionHumana,
  solicitarAnalisisDeGuion,
} from './content-analysis.ts';
import {
  crearBriefHijoDePrueba,
  crearEscenarioDeContenido,
  limpiarEscenarioDeContenido,
  type EscenarioDeContenido,
} from './test-utils.ts';

let a: EscenarioDeAnalisis;
let sinBrief: EscenarioDeContenido;

const codigo = <T>(r: Result<T>): string | undefined => (r.ok ? undefined : r.error.code);
const detalle = <T>(r: Result<T>, campo: string): unknown =>
  r.ok ? undefined : (r.error.details as Record<string, unknown> | undefined)?.[campo];
const valor = <T>(r: Result<T>): T => {
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
  return r.value;
};

const versionNueva = async (): Promise<string> =>
  (await registrarGuionDePrueba(a.e, a.deliverableId, a.e.participaciones.valentinaRios, a.e.consultor))
    .versionId;

const estadoDe = async (versionId: string): Promise<string> =>
  (await query<{ status: string }>(`SELECT status FROM script_versions WHERE id = $1`, [versionId]))[0]!
    .status;

const humanas = async (versionId: string): Promise<number> =>
  Number(
    (
      await query<{ n: string }>(
        `SELECT count(*) AS n FROM content_analysis_runs WHERE script_version_id = $1 AND kind = 'human'`,
        [versionId],
      )
    )[0]!.n,
  );

beforeAll(async () => {
  a = await crearEscenarioDeAnalisis('analisis-humana');
  sinBrief = await crearEscenarioDeContenido('analisis-humana-sin-brief');
});

afterAll(async () => {
  await limpiarEscenarioDeContenido(a.e);
  await limpiarEscenarioDeContenido(sinBrief);
  await closePool();
});

describe('registrar la revisión humana (solo ui)', () => {
  it('una persona con script:manage registra la revisión: guarda la huella del Brief y el hash de la fuente, y pone la versión en revisión', async () => {
    const versionId = await versionNueva();
    const huella = valor(await huellaDeBriefRector(a.e.consultor, versionId));
    const r = valor(
      await registrarRevisionHumana(a.e.consultor, versionId, {
        nota: 'Revisado contra el Brief V1.',
        huellaVista: huella.fingerprint,
      }),
    );
    expect(r.reused).toBe(false);
    expect(r.run).toMatchObject({
      kind: 'human',
      status: 'succeeded',
      vigencia: 'current',
      findingCount: 0,
      createdBy: a.e.consultor.id,
      governingBriefVersionId: a.brief.versionId,
      governingBriefNumber: 1,
      briefFingerprint: huella.fingerprint,
      note: 'Revisado contra el Brief V1.',
      aiCalls: 0,
    });
    expect(r.run.provider).toBeUndefined();
    expect(r.run.model).toBeUndefined();
    expect(r.run.mode).toBeUndefined();
    const [v] = await query<{ source_hash: string }>(
      `SELECT source_hash FROM script_versions WHERE id = $1`,
      [versionId],
    );
    expect(r.run.scriptSourceHash).toBe(v!.source_hash);
    expect(await estadoDe(versionId)).toBe('in_review');

    const vig = valor(await obtenerRevisionVigente(a.e.consultor, versionId));
    expect(vig).toMatchObject({ vigencia: 'current', kind: 'human', findingTotal: 0 });
    expect(vig.run?.id).toBe(r.run.id);

    const ev = await query<{
      action: string;
      origin: string;
      actor_id: string;
      metadata: Record<string, unknown>;
    }>(`SELECT action, origin, actor_id, metadata FROM audit_events WHERE entity_id = $1`, [r.run.id]);
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ action: 'script_review.human', origin: 'ui', actor_id: a.e.consultor.id });
    expect(ev[0]!.metadata).toMatchObject({ hasNote: true, briefFingerprint: huella.fingerprint });
    // La nota (texto de una persona) no viaja a la auditoría.
    expect(JSON.stringify(ev[0]!.metadata)).not.toContain('Revisado contra');
  });

  it('admin y director también pueden; la nota es opcional', async () => {
    for (const actor of [a.e.admin, a.e.director]) {
      const versionId = await versionNueva();
      const r = valor(await registrarRevisionHumana(actor, versionId));
      expect(r.run.note).toBeUndefined();
      expect(r.run.createdBy).toBe(actor.id);
    }
  });

  it('el chat, el sistema y la IA NO pueden: HUMAN_CONFIRMATION_REQUIRED, sin run ni cambio de estado', async () => {
    const versionId = await versionNueva();
    for (const origin of ['chat', 'system'] as const) {
      const r = await registrarRevisionHumana(a.e.consultor, versionId, {}, { origin });
      expect(codigo(r)).toBe('HUMAN_CONFIRMATION_REQUIRED');
    }
    // Con la correlación de una tool del agente, también.
    const conTool = await registrarRevisionHumana(
      a.e.consultor,
      versionId,
      {},
      { origin: 'chat', correlation: { toolInvocationId: '44444444-4444-4444-8444-444444444444' } },
    );
    expect(codigo(conTool)).toBe('HUMAN_CONFIRMATION_REQUIRED');
    // El actor «system» (no una persona) tampoco.
    expect(codigo(await registrarRevisionHumana('system' as unknown as User, versionId))).toBe(
      'FORBIDDEN_ROLE',
    );
    expect(await humanas(versionId)).toBe(0);
    expect(await estadoDe(versionId)).toBe('received');
  });

  it('cliente y otra agencia ⇒ RESOURCE_NOT_FOUND; operativo, analista y legal ⇒ FORBIDDEN_ROLE', async () => {
    const versionId = await versionNueva();
    expect(codigo(await registrarRevisionHumana(a.e.cliente, versionId))).toBe('RESOURCE_NOT_FOUND');
    expect(codigo(await registrarRevisionHumana(a.e.ajeno, versionId))).toBe('RESOURCE_NOT_FOUND');
    for (const actor of [a.e.operativo, a.e.analista, a.e.legal]) {
      expect(codigo(await registrarRevisionHumana(actor, versionId))).toBe('FORBIDDEN_ROLE');
    }
    expect(await humanas(versionId)).toBe(0);
  });

  it('sin Brief rector no hay revisión (BRIEF_NOT_APPROVED)', async () => {
    const { versionId } = await registrarGuionDePrueba(
      sinBrief,
      sinBrief.entregables.reelRios,
      sinBrief.participaciones.valentinaRios,
      sinBrief.consultor,
    );
    const r = await registrarRevisionHumana(sinBrief.consultor, versionId);
    expect(codigo(r)).toBe('BRIEF_NOT_APPROVED');
    expect(await humanas(versionId)).toBe(0);
    expect(await estadoDe(versionId)).toBe('received');
  });

  it('la huella que la persona vio debe coincidir con el Brief rector actual (view_stale)', async () => {
    const versionId = await versionNueva();
    const r = await registrarRevisionHumana(a.e.consultor, versionId, { huellaVista: 'a'.repeat(64) });
    expect(codigo(r)).toBe('RESOURCE_CONFLICT');
    expect(detalle(r, 'reason')).toBe('view_stale');
    expect(await humanas(versionId)).toBe(0);
  });

  it('validaciones: nota de más de 1000 caracteres; id mal formado; estado no revisable', async () => {
    const versionId = await versionNueva();
    expect(codigo(await registrarRevisionHumana(a.e.consultor, versionId, { nota: 'x'.repeat(1001) }))).toBe(
      'VALIDATION_FAILED',
    );
    expect(codigo(await registrarRevisionHumana(a.e.consultor, 'no-es-un-uuid'))).toBe('RESOURCE_NOT_FOUND');
    await query(`UPDATE script_versions SET status = 'changes_requested' WHERE id = $1`, [versionId]);
    const r = await registrarRevisionHumana(a.e.consultor, versionId);
    expect(codigo(r)).toBe('RESOURCE_CONFLICT');
    expect(detalle(r, 'reason')).toBe('version_not_reviewable');
    expect(await humanas(versionId)).toBe(0);
  });

  it('una versión ya APROBADA se puede revisar (útil con un Brief nuevo) y no se transiciona', async () => {
    const versionId = await versionNueva();
    await query(`UPDATE script_versions SET status = 'in_review' WHERE id = $1`, [versionId]);
    await query(`UPDATE script_versions SET status = 'approved', approved_by = $2 WHERE id = $1`, [
      versionId,
      a.e.director.id,
    ]);
    const r = valor(await registrarRevisionHumana(a.e.consultor, versionId));
    expect(r.run.kind).toBe('human');
    expect(await estadoDe(versionId)).toBe('approved');
  });
});

describe('idempotencia de la revisión humana', () => {
  it('la misma persona contra el mismo Brief no duplica (doble clic): devuelve la misma y conserva su nota', async () => {
    const versionId = await versionNueva();
    const primero = valor(await registrarRevisionHumana(a.e.consultor, versionId, { nota: 'Primera nota.' }));
    const segundo = valor(await registrarRevisionHumana(a.e.consultor, versionId, { nota: 'Otra nota.' }));
    expect(segundo.reused).toBe(true);
    expect(segundo.run.id).toBe(primero.run.id);
    expect(segundo.run.note).toBe('Primera nota.');
    expect(await humanas(versionId)).toBe(1);
  });

  it('dos personas distintas añaden cada una la suya', async () => {
    const versionId = await versionNueva();
    valor(await registrarRevisionHumana(a.e.consultor, versionId));
    valor(await registrarRevisionHumana(a.e.director, versionId));
    expect(await humanas(versionId)).toBe(2);
    expect(valor(await listarRevisiones(a.e.consultor, versionId)).total).toBe(2);
  });

  it('simultáneas de la misma persona ⇒ una sola', async () => {
    const versionId = await versionNueva();
    const rs = await Promise.all(
      Array.from({ length: 4 }, () => registrarRevisionHumana(a.e.consultor, versionId)),
    );
    expect(rs.every((r) => r.ok)).toBe(true);
    expect(new Set(rs.map((r) => (r.ok ? r.value.run.id : ''))).size).toBe(1);
    expect(rs.filter((r) => r.ok && !r.value.reused)).toHaveLength(1);
    expect(await humanas(versionId)).toBe(1);
  });
});

describe('vigencia de la revisión humana', () => {
  it('queda STALE si cambia el Brief rector y una nueva revisión humana la vuelve CURRENT', async () => {
    const versionId = await versionNueva();
    const h = valor(await registrarRevisionHumana(a.e.consultor, versionId));
    const rector = a.brief.versionId;
    const hija = await crearBriefHijoDePrueba(a.e.admin, rector, {
      cambios: {
        'accion_kpis.accion_esperada': 'Una acción esperada distinta en el Brief nuevo de la campaña.',
      },
    });
    const vig = valor(await obtenerRevisionVigente(a.e.consultor, versionId));
    expect(vig.vigencia).toBe('stale');
    expect(vig.kind).toBe('human');
    expect(vig.run?.id).toBe(h.run.id);
    expect(vig.currentBriefVersion?.id).toBe(hija.versionId);

    // La misma persona registra de nuevo contra el Brief NUEVO: es otra revisión (no «reused»).
    const otra = valor(await registrarRevisionHumana(a.e.consultor, versionId));
    expect(otra.reused).toBe(false);
    expect(otra.run.governingBriefVersionId).toBe(hija.versionId);
    expect(valor(await obtenerRevisionVigente(a.e.consultor, versionId)).vigencia).toBe('current');
    expect(await humanas(versionId)).toBe(2);
  });

  it('nunca crea hallazgos; listarHallazgos de una revisión humana está vacío', async () => {
    const versionId = await versionNueva();
    const h = valor(await registrarRevisionHumana(a.e.consultor, versionId));
    const p = valor(await listarHallazgos(a.e.consultor, { runId: h.run.id }));
    expect(p.items).toEqual([]);
    expect(p.run?.kind).toBe('human');
    const total = Number(
      (
        await query<{ n: string }>(
          `SELECT count(*) AS n FROM content_findings WHERE script_version_id = $1`,
          [versionId],
        )
      )[0]!.n,
    );
    expect(total).toBe(0);
  });

  it('la IA y la revisión humana coexisten: CURRENT es la última succeeded; un análisis fallido no la desplaza', async () => {
    const versionId = await versionNueva();
    const ia = valor(
      await solicitarAnalisisDeGuion(
        a.e.consultor,
        versionId,
        { mode: 'ensure', idempotencyKey: claveNueva('coex') },
        undefined,
        {
          cliente: clienteQueResponde([{ category: 'cta_missing', refs: ['accion_kpis.accion_esperada'] }]),
          env: ENV_CON_IA,
          esperar: async () => {},
        },
      ),
    );
    await new Promise((r) => setTimeout(r, 20));
    const humana = valor(await registrarRevisionHumana(a.e.consultor, versionId));
    const vig = valor(await obtenerRevisionVigente(a.e.consultor, versionId));
    expect(vig.vigencia).toBe('current');
    expect(vig.run?.id).toBe(humana.run.id);
    expect(vig.kind).toBe('human');

    // Un reanálisis fallido no desplaza la CURRENT.
    await solicitarAnalisisDeGuion(
      a.e.consultor,
      versionId,
      { mode: 'reanalyze', idempotencyKey: claveNueva('coex2') },
      undefined,
      {
        cliente: new ClienteDeAnalisisGuionado(falloGuionado('MODEL_BAD_RESPONSE')),
        env: ENV_CON_IA,
        esperar: async () => {},
      },
    );
    const despues = valor(await obtenerRevisionVigente(a.e.consultor, versionId));
    expect(despues.run?.id).toBe(humana.run.id);
    expect(despues.latestAttempt?.status).toBe('failed');
    // El análisis asistido anterior sigue disponible por id.
    expect(valor(await listarHallazgos(a.e.consultor, { runId: ia.run.id })).items).toHaveLength(1);
  });

  it('con la IA APAGADA la revisión humana sigue funcionando (la IA nunca es requisito)', async () => {
    const versionId = await versionNueva();
    const r = valor(await registrarRevisionHumana(a.e.consultor, versionId));
    expect(r.run.status).toBe('succeeded');
  });
});
