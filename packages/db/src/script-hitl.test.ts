/**
 * V2 · Fase 7 — aprobar un guion por el camino HITL (`script_version.approve`), contra PostgreSQL real.
 *
 *   el agente propone (chat) → una persona de Dirección confirma (ui, con la huella) → ejecuta (ui)
 *
 * Cubre: que proponer y confirmar NO cambian el dominio; que ejecutar aprueba UNA vez; que el chat, el
 * sistema y quien no tiene `script:approve` no confirman ni ejecutan; un caso por cada causa de PROPOSAL_STALE
 * (en confirmar y en ejecutar); la tarjeta (advertencias compuestas solo desde el payload) y las propuestas
 * simultáneas. Todo sobre campañas, influencers y fuentes sintéticos y desechables (INC-001A).
 */

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ProposedAction } from '@tcl-kol-os/domain';
import { archiveCampaign } from './campaigns.ts';
import { retirarInfluencerDeCampana } from './campaign-influencers.ts';
import { closePool, getPool, query, transaction } from './client.ts';
import { listarAccionesPendientesDeCampana } from './chat-views.ts';
import { archivarEntregable } from './deliverables.ts';
import { cancelarAccion, confirmarAccion, ejecutarAccion, proponerAccion } from './proposed-actions.ts';
import { crearComentarioDeRevision, solicitarCambiosDeScript } from './script-review.ts';
import { aprobarScriptVersion } from './script-approval.ts';
import {
  type EscenarioDeAprobacion,
  aprobarDirecto,
  codigo,
  confirmarAprobacion,
  contarAuditoria,
  crearEscenarioDeAprobacion,
  ejecutarAprobacion,
  entregableNuevo,
  estadoDeAccion,
  estadoDeVersion,
  evaluar,
  otraVersionRevisada,
  proponerAprobacion,
  razon,
  revisarComoHumano,
  revisarConIA,
  valor,
  versionNueva,
  versionRevisada,
} from './script-approval-test-support.ts';
import { crearBriefHijoDePrueba, limpiarEscenarioDeContenido } from './test-utils.ts';

let a: EscenarioDeAprobacion;
let b: EscenarioDeAprobacion;
/** Escenarios para lo destructivo: archivar la campaña (uno por fase). */
let archivaConfirmar: EscenarioDeAprobacion;
let archivaEjecutar: EscenarioDeAprobacion;

beforeAll(async () => {
  a = await crearEscenarioDeAprobacion('F7 HITL');
  b = await crearEscenarioDeAprobacion('F7 HITL brief');
  archivaConfirmar = await crearEscenarioDeAprobacion('F7 HITL archiva confirmar');
  archivaEjecutar = await crearEscenarioDeAprobacion('F7 HITL archiva ejecutar');
});

afterAll(async () => {
  for (const x of [a, b, archivaConfirmar, archivaEjecutar]) await limpiarEscenarioDeContenido(x.e);
  await closePool();
});

interface FilaDeVersion {
  status: string;
  approved_by: string | null;
  approved_at: Date | null;
  approved_via_proposed_action_id: string | null;
  approval_snapshot: Record<string, unknown> | null;
}

async function fila(versionId: string): Promise<FilaDeVersion> {
  return (
    await query<FilaDeVersion>(
      `SELECT status, approved_by, approved_at, approved_via_proposed_action_id, approval_snapshot
         FROM script_versions WHERE id = $1`,
      [versionId],
    )
  )[0]!;
}

async function intacta(versionId: string, estado = 'in_review'): Promise<void> {
  const f = await fila(versionId);
  expect(f.status).toBe(estado);
  expect(f.approved_by).toBeNull();
  expect(f.approved_at).toBeNull();
  expect(f.approved_via_proposed_action_id).toBeNull();
  expect(f.approval_snapshot).toBeNull();
  expect(await contarAuditoria(versionId, 'script_version.approve')).toBe(0);
}

// ─────────────────────────── El flujo completo ─────────────────────────────────

describe('flujo HITL completo: proponer → confirmar → ejecutar', () => {
  it('proponer NO cambia el dominio; confirmar tampoco; ejecutar aprueba UNA vez, con la persona que confirmó y su correlación', async () => {
    const { deliverableId, versionId, runId } = await versionRevisada(a.e);
    const ev = await evaluar(versionId);

    const propuesta = await proponerAprobacion(a.e, versionId);
    expect(propuesta).toMatchObject({
      type: 'script_version.approve',
      resourceType: 'script_version',
      resourceId: versionId,
      status: 'pending',
      proposedOrigin: 'chat',
      proposedBy: a.e.consultor.id,
      campaignId: a.e.campanaId,
    });
    // El payload es el snapshot + su huella + las etiquetas para mostrar; el payload_hash lo cubre.
    expect(Object.keys(propuesta.payload).sort()).toEqual(['approvalFingerprint', 'etiquetas', 'snapshot']);
    expect(propuesta.payload['approvalFingerprint']).toBe(ev.huella);
    expect(propuesta.payload['snapshot']).toEqual(JSON.parse(JSON.stringify(ev.snapshot)));
    await intacta(versionId);
    expect(await contarAuditoria(propuesta.id, 'proposed_action.propose')).toBe(1);

    const confirmada = valor(await confirmarAprobacion(a.e.director, propuesta));
    expect(confirmada).toMatchObject({ status: 'confirmed', confirmedBy: a.e.director.id });
    await intacta(versionId); // confirmar NO cambia el dominio
    expect(await contarAuditoria(propuesta.id, 'proposed_action.confirm')).toBe(1);

    const ejecutada = valor(await ejecutarAprobacion(a.e.director, propuesta));
    expect(ejecutada.status).toBe('executed');
    const f = await fila(versionId);
    expect(f).toMatchObject({
      status: 'approved',
      approved_by: a.e.director.id,
      approved_via_proposed_action_id: propuesta.id,
    });
    expect(f.approval_snapshot).toEqual(JSON.parse(JSON.stringify(ev.snapshot)));
    const [analisis] = await query<{ approved_analysis_id: string }>(
      `SELECT approved_analysis_id FROM script_versions WHERE id = $1`,
      [versionId],
    );
    expect(analisis!.approved_analysis_id).toBe(runId);

    const [aprobar] = await query<{
      origin: string;
      actor_id: string;
      correlation: Record<string, string>;
      metadata: Record<string, unknown>;
    }>(
      `SELECT origin, actor_id, correlation, metadata FROM audit_events
        WHERE entity_id = $1 AND action = 'script_version.approve'`,
      [versionId],
    );
    expect(aprobar).toMatchObject({ origin: 'ui', actor_id: a.e.director.id });
    expect(aprobar!.correlation).toEqual({ proposedActionId: propuesta.id });
    expect(aprobar!.metadata).toMatchObject({
      via: 'proposal',
      payloadHash: propuesta.payloadHash,
      fingerprint: ev.huella,
    });
    const [ejecucion] = await query<{ origin: string; metadata: Record<string, unknown> }>(
      `SELECT origin, metadata FROM audit_events
        WHERE entity_id = $1 AND action = 'proposed_action.execute'`,
      [propuesta.id],
    );
    expect(ejecucion).toMatchObject({ origin: 'ui' });
    expect(ejecucion!.metadata).toMatchObject({
      mode: 'atomic',
      scriptVersionId: versionId,
      versionNumber: 1,
      reviewKind: 'human',
      findingTotal: 0,
      commentTotal: 0,
      supersededCount: 0,
    });
    // El resumen es de cifras: sin payload ni textos.
    expect(JSON.stringify(ejecucion!.metadata)).not.toMatch(/snapshot|etiquetas/);
    expect(await contarAuditoria(deliverableId, 'deliverable.current_approved_changed')).toBe(1);
  });

  it('replay: una acción ejecutada no se repite (PROPOSAL_INVALID_STATE) y la aprobación se audita una sola vez', async () => {
    const { versionId } = await versionRevisada(a.e);
    const propuesta = await proponerAprobacion(a.e, versionId);
    valor(await confirmarAprobacion(a.e.director, propuesta));
    valor(await ejecutarAprobacion(a.e.director, propuesta));
    for (const r of [
      await ejecutarAprobacion(a.e.director, propuesta),
      await confirmarAprobacion(a.e.director, propuesta),
    ]) {
      expect(codigo(r)).toBe('PROPOSAL_INVALID_STATE');
    }
    expect(await contarAuditoria(versionId, 'script_version.approve')).toBe(1);
    expect(await contarAuditoria(propuesta.id, 'proposed_action.execute')).toBe(1);
    // Tampoco por la vía directa: el estado ya no lo admite.
    expect(codigo(await aprobarDirecto(a.e.director, versionId))).toBe('SCRIPT_INVALID_TRANSITION');
  });

  it('solo ejecuta quien confirmó; otro director o administrador no', async () => {
    const { versionId } = await versionRevisada(a.e);
    const propuesta = await proponerAprobacion(a.e, versionId);
    valor(await confirmarAprobacion(a.e.director, propuesta));
    expect(codigo(await ejecutarAprobacion(a.e.admin, propuesta))).toBe('HUMAN_CONFIRMATION_REQUIRED');
    await intacta(versionId);
    expect(await estadoDeAccion(propuesta.id)).toBe('confirmed');
    expect(valor(await ejecutarAprobacion(a.e.director, propuesta)).status).toBe('executed');
  });

  it('una aprobación puede confirmarla y ejecutarla el administrador', async () => {
    const { versionId } = await versionRevisada(a.e);
    const propuesta = await proponerAprobacion(a.e, versionId, a.e.admin);
    valor(await confirmarAprobacion(a.e.admin, propuesta));
    valor(await ejecutarAprobacion(a.e.admin, propuesta));
    expect((await fila(versionId)).approved_by).toBe(a.e.admin.id);
  });
});

// ─────────────────────────── Quién propone, confirma y ejecuta ─────────────────

describe('quién propone, confirma y ejecuta: la IA, el chat y el sistema nunca aprueban', () => {
  it('propone admin, director y consultor; no operativo, analista, legal ni cliente; el sistema no propone una aprobación', async () => {
    const { versionId } = await versionRevisada(a.e);
    for (const actor of [a.e.operativo, a.e.analista, a.e.legal, a.e.cliente]) {
      const r = await proponerAccion(actor, {
        type: 'script_version.approve',
        resourceId: versionId,
        origin: 'chat',
      });
      expect(codigo(r), actor.role).toBe('FORBIDDEN_ROLE');
    }
    const delSistema = await proponerAccion('system', {
      type: 'script_version.approve',
      resourceId: versionId,
    });
    expect(codigo(delSistema)).toBe('FORBIDDEN_ROLE');
    // Otra organización: tiene la capacidad pero el guion no existe para ella.
    const ajena = await proponerAccion(a.e.ajeno, {
      type: 'script_version.approve',
      resourceId: versionId,
      origin: 'chat',
    });
    expect(codigo(ajena)).toBe('RESOURCE_NOT_FOUND');
    const [{ n }] = (await query<{ n: string }>(
      `SELECT count(*)::text AS n FROM proposed_actions WHERE resource_id = $1`,
      [versionId],
    )) as [{ n: string }];
    expect(n).toBe('0');
    for (const rol of [a.e.admin, a.e.director, a.e.consultor]) {
      const r = await proponerAprobacion(a.e, versionId, rol);
      expect(r.status).toBe('pending');
    }
  });

  it('el consultor propone pero NO confirma ni ejecuta; operativo, analista, legal, cliente y ajeno tampoco', async () => {
    const { versionId } = await versionRevisada(a.e);
    const propuesta = await proponerAprobacion(a.e, versionId);
    for (const actor of [a.e.consultor, a.e.operativo, a.e.analista, a.e.legal, a.e.cliente]) {
      expect(codigo(await confirmarAprobacion(actor, propuesta)), actor.role).toBe(
        actor.role === 'cliente' ? 'RESOURCE_NOT_FOUND' : 'FORBIDDEN_ROLE',
      );
    }
    expect(codigo(await confirmarAprobacion(a.e.ajeno, propuesta))).toBe('RESOURCE_NOT_FOUND');
    expect(await estadoDeAccion(propuesta.id)).toBe('pending');
    valor(await confirmarAprobacion(a.e.director, propuesta));
    for (const actor of [a.e.consultor, a.e.operativo, a.e.cliente]) {
      expect((await ejecutarAprobacion(actor, propuesta)).ok, actor.role).toBe(false);
    }
    await intacta(versionId);
  });

  it('el chat y el sistema no confirman ni ejecutan, ni siquiera con un director como actor', async () => {
    const { versionId } = await versionRevisada(a.e);
    const propuesta = await proponerAprobacion(a.e, versionId);
    const hash = propuesta.payloadHash;
    for (const canal of ['chat', 'system'] as const) {
      expect(
        codigo(await confirmarAccion(a.e.director, propuesta.id, { canal, payloadHash: hash })),
        canal,
      ).toBe('HUMAN_CONFIRMATION_REQUIRED');
    }
    expect(codigo(await confirmarAccion('system', propuesta.id, { canal: 'ui', payloadHash: hash }))).toBe(
      'HUMAN_CONFIRMATION_REQUIRED',
    );
    expect(await estadoDeAccion(propuesta.id)).toBe('pending');

    valor(await confirmarAprobacion(a.e.director, propuesta));
    for (const canal of ['chat', 'system'] as const) {
      expect(codigo(await ejecutarAccion(a.e.director, propuesta.id, { canal }))).toBe(
        'HUMAN_CONFIRMATION_REQUIRED',
      );
    }
    expect(codigo(await ejecutarAccion('system', propuesta.id, { canal: 'ui' }))).toBe(
      'HUMAN_CONFIRMATION_REQUIRED',
    );
    await intacta(versionId);
    expect(await estadoDeAccion(propuesta.id)).toBe('confirmed');
  });

  it('una acción cancelada o vencida no avanza ni aprueba', async () => {
    const cancelada = await versionRevisada(a.e);
    const p1 = await proponerAprobacion(a.e, cancelada.versionId);
    valor(await confirmarAprobacion(a.e.director, p1));
    valor(await cancelarAccion(a.e.consultor, p1.id));
    expect(codigo(await ejecutarAprobacion(a.e.director, p1))).toBe('PROPOSAL_INVALID_STATE');
    expect(codigo(await confirmarAprobacion(a.e.director, p1))).toBe('PROPOSAL_INVALID_STATE');
    await intacta(cancelada.versionId);

    const vencida = await versionRevisada(a.e);
    const p2 = valor(
      await proponerAccion(a.e.consultor, {
        type: 'script_version.approve',
        resourceId: vencida.versionId,
        origin: 'chat',
        ttlSegundos: 1,
      }),
    );
    await new Promise((r) => setTimeout(r, 1200));
    expect(codigo(await confirmarAprobacion(a.e.director, p2))).toBe('PROPOSAL_EXPIRED');
    expect(await estadoDeAccion(p2.id)).toBe('expired');
    expect((await ejecutarAprobacion(a.e.director, p2)).ok).toBe(false);
    await intacta(vencida.versionId);
  });
});

// ─────────────────────────── Proponer falla pronto ─────────────────────────────

describe('proponer falla pronto cuando nunca podría ejecutarse', () => {
  it('sin revisión, con la versión recibida, cerrada o de otra campaña: error tipificado y ninguna propuesta', async () => {
    const sinRevisar = await entregableNuevo(a.e);
    const recibida = await versionNueva(a.e, sinRevisar);
    const r1 = await proponerAccion(a.e.consultor, {
      type: 'script_version.approve',
      resourceId: recibida,
      origin: 'chat',
    });
    expect(codigo(r1)).toBe('SCRIPT_INVALID_TRANSITION');

    // En revisión pero sin revisión CURRENT (se comentó sin revisar).
    valor(await crearComentarioDeRevision(a.e.consultor, recibida, { kind: 'editorial', body: 'Nota' }));
    const r2 = await proponerAccion(a.e.consultor, {
      type: 'script_version.approve',
      resourceId: recibida,
      origin: 'chat',
    });
    expect(codigo(r2)).toBe('SCRIPT_REVIEW_REQUIRED');
    expect(razon(r2)).toBe('none');

    const lista = await versionRevisada(a.e);
    const otraCampana = await proponerAccion(a.e.consultor, {
      type: 'script_version.approve',
      resourceId: lista.versionId,
      origin: 'chat',
      campaignId: a.e.otraCampanaId,
    });
    expect(codigo(otraCampana)).toBe('RESOURCE_NOT_FOUND');
    for (const id of ['no-es-uuid', '00000000-0000-4000-8000-000000000000']) {
      expect(
        codigo(await proponerAccion(a.e.consultor, { type: 'script_version.approve', resourceId: id })),
      ).toBe('RESOURCE_NOT_FOUND');
    }
    const [{ n }] = (await query<{ n: string }>(
      `SELECT count(*)::text AS n FROM proposed_actions WHERE resource_id = ANY($1::uuid[])`,
      [[recibida, lista.versionId]],
    )) as [{ n: string }];
    expect(n).toBe('0');
  });

  it('es idempotente: la misma propuesta vigente se reutiliza; si lo propuesto cambia, la anterior vence y nace otra', async () => {
    const { versionId } = await versionRevisada(a.e);
    const p1 = await proponerAprobacion(a.e, versionId);
    const p2 = await proponerAprobacion(a.e, versionId);
    expect(p2.id).toBe(p1.id);
    valor(
      await crearComentarioDeRevision(a.e.consultor, versionId, {
        kind: 'editorial',
        body: 'Cambia la huella',
      }),
    );
    const p3 = await proponerAprobacion(a.e, versionId);
    expect(p3.id).not.toBe(p1.id);
    expect(p3.payloadHash).not.toBe(p1.payloadHash);
    expect(await estadoDeAccion(p1.id)).toBe('expired');
    expect(await estadoDeAccion(p3.id)).toBe('pending');
  });

  it('12 propuestas simultáneas del mismo guion dejan UNA vigente', async () => {
    const { versionId } = await versionRevisada(a.e);
    const rs = await Promise.all(
      Array.from({ length: 12 }, () =>
        proponerAccion(a.e.consultor, {
          type: 'script_version.approve',
          resourceId: versionId,
          origin: 'chat',
          campaignId: a.e.campanaId,
        }),
      ),
    );
    const ids = new Set(rs.map((r) => valor(r).id));
    expect(ids.size).toBe(1);
    const [{ n }] = (await query<{ n: string }>(
      `SELECT count(*)::text AS n FROM proposed_actions
        WHERE resource_id = $1 AND status IN ('pending', 'confirmed')`,
      [versionId],
    )) as [{ n: string }];
    expect(n).toBe('1');
  });
});

// ─────────────────────────── Cada causa de PROPOSAL_STALE ──────────────────────

type Fase = 'confirmar' | 'ejecutar';

interface Contexto {
  readonly esc: EscenarioDeAprobacion;
  readonly deliverableId: string;
  readonly versionId: string;
}

/**
 * Propone (y, para la fase `ejecutar`, confirma); aplica el cambio; y comprueba que la acción obsoleta NO
 * avanza (PROPOSAL_STALE), que la tarjeta la marca obsoleta con su aviso y que el dominio queda intacto.
 */
async function caso(
  esc: EscenarioDeAprobacion,
  fase: Fase,
  preparar: (c: Contexto) => Promise<Contexto | void>,
  mutar: (c: Contexto) => Promise<void>,
  esperado: { readonly estadoFinal?: string } = {},
): Promise<void> {
  const base = await versionRevisada(esc.e);
  const preparado = (await preparar({ esc, ...base })) ?? { esc, ...base };
  const propuesta = await proponerAprobacion(esc.e, preparado.versionId);
  if (fase === 'ejecutar') valor(await confirmarAprobacion(esc.e.director, propuesta));
  await mutar(preparado);

  const r =
    fase === 'confirmar'
      ? await confirmarAprobacion(esc.e.director, propuesta)
      : await ejecutarAprobacion(esc.e.director, propuesta);
  expect(codigo(r), `${fase}`).toBe('PROPOSAL_STALE');
  expect(await estadoDeAccion(propuesta.id)).toBe(fase === 'confirmar' ? 'pending' : 'confirmed');
  const f = await fila(preparado.versionId);
  expect(f.approved_by).toBeNull();
  expect(f.approval_snapshot).toBeNull();
  expect(await contarAuditoria(preparado.versionId, 'script_version.approve')).toBe(0);
  if (esperado.estadoFinal !== undefined) expect(f.status).toBe(esperado.estadoFinal);

  const vistas = valor(await listarAccionesPendientesDeCampana(esc.e.director, esc.e.campanaId));
  const tarjeta = vistas.find((v) => v.id === propuesta.id);
  expect(tarjeta, 'la tarjeta de la propuesta obsoleta sigue visible (para cancelarla)').toBeDefined();
  expect(tarjeta!.obsoleta).toBe(true);
  expect(tarjeta!.canConfirm).toBe(false);
  expect(tarjeta!.canRetryExecute).toBe(false);
  expect(tarjeta!.canCancel).toBe(true);
  expect(tarjeta!.advertencias.join(' ')).toMatch(/desactualizada/);
  valor(await cancelarAccion(esc.e.director, propuesta.id)); // se puede cancelar
}

describe('cada causa de PROPOSAL_STALE, al confirmar y al ejecutar', () => {
  for (const fase of ['confirmar', 'ejecutar'] as const) {
    describe(`fase «${fase}»`, () => {
      it('la versión ya no está en revisión (se pidieron cambios)', async () => {
        await caso(
          a,
          fase,
          async () => undefined,
          async (c) => {
            valor(
              await solicitarCambiosDeScript(a.e.consultor, c.versionId, { items: [{ body: 'Reescribir' }] }),
            );
          },
          { estadoFinal: 'changes_requested' },
        );
      });

      it('nació una versión V(N+1) del entregable (cambia headVersionId)', async () => {
        await caso(
          a,
          fase,
          async () => undefined,
          async (c) => {
            await versionNueva(a.e, c.deliverableId);
          },
        );
      });

      it('cambió la aprobada vigente (otra versión menor se aprobó: cambia replaces)', async () => {
        await caso(
          a,
          fase,
          async (c) => {
            // V1 revisada (aprobable) y V2 revisada (la que se propone); luego se aprueba V1.
            const v2 = await otraVersionRevisada(a.e, c.deliverableId);
            return { ...c, versionId: v2.versionId, v1: c.versionId } as Contexto;
          },
          async (c) => {
            const v1 = (c as Contexto & { v1: string }).v1;
            valor(await aprobarDirecto(a.e.director, v1));
          },
        );
      });

      it('cambió el Brief rector (una hija aprobada)', async () => {
        const rector = (
          await query<{ id: string }>(`SELECT brief_rector_de_campana($1) AS id`, [b.e.campanaId])
        )[0]!.id;
        await caso(
          b,
          fase,
          async () => undefined,
          async () => {
            await crearBriefHijoDePrueba(b.e.admin, rector, {
              cambios: { 'mensaje_principal.one_line': `Mensaje ${fase} del Brief nuevo.` },
            });
          },
        );
      });

      it('cambió el contenido del Brief rector (su huella)', async () => {
        await caso(
          b,
          fase,
          async () => undefined,
          async () => {
            // Solo una base `_test` con el bypass explícito admite tocar un campo de un Brief aprobado.
            await transaction(async (client) => {
              await client.query(`SET LOCAL tclkolos.permitir_borrado_historico = 'on'`);
              await client.query(
                `UPDATE brief_fields SET value = to_jsonb($2::text)
                  WHERE brief_version_id = brief_rector_de_campana($1)
                    AND key = 'mensaje_principal.mensaje_clave' AND campaign_product_id IS NULL`,
                [b.e.campanaId, `Mensaje clave alterado ${fase}`],
              );
            });
          },
        );
      });

      it('se registró una revisión más reciente (cambia review.id)', async () => {
        await caso(
          a,
          fase,
          async () => undefined,
          async (c) => {
            await revisarComoHumano(c.versionId, a.e.director, 'Segunda revisión');
          },
        );
      });

      it('se añadió un comentario de revisión', async () => {
        await caso(
          a,
          fase,
          async () => undefined,
          async (c) => {
            valor(
              await crearComentarioDeRevision(a.e.consultor, c.versionId, {
                kind: 'editorial',
                body: 'Comentario posterior a la propuesta',
              }),
            );
          },
        );
      });

      it('el entregable se archivó', async () => {
        await caso(
          a,
          fase,
          async () => undefined,
          async (c) => {
            valor(await archivarEntregable(a.e.consultor, c.deliverableId));
          },
        );
      });

      it('el participante se retiró de la campaña', async () => {
        const destino =
          fase === 'confirmar'
            ? {
                deliverableId: a.e.entregables.reelGomez,
                participationId: a.e.participaciones.valentinaGomez,
              }
            : { deliverableId: a.e.entregables.reelRios, participationId: a.e.participaciones.valentinaRios };
        const base = await versionRevisada(a.e, undefined, destino);
        const propuesta = await proponerAprobacion(a.e, base.versionId);
        if (fase === 'ejecutar') valor(await confirmarAprobacion(a.e.director, propuesta));
        valor(await retirarInfluencerDeCampana(a.e.admin, destino.participationId));
        const r =
          fase === 'confirmar'
            ? await confirmarAprobacion(a.e.director, propuesta)
            : await ejecutarAprobacion(a.e.director, propuesta);
        expect(codigo(r)).toBe('PROPOSAL_STALE');
        await intacta(base.versionId);
      });

      it('la campaña se archivó', async () => {
        const esc = fase === 'confirmar' ? archivaConfirmar : archivaEjecutar;
        const base = await versionRevisada(esc.e);
        const propuesta = await proponerAprobacion(esc.e, base.versionId);
        if (fase === 'ejecutar') valor(await confirmarAprobacion(esc.e.director, propuesta));
        valor(await archiveCampaign(esc.e.admin, esc.e.campanaId));
        const r =
          fase === 'confirmar'
            ? await confirmarAprobacion(esc.e.director, propuesta)
            : await ejecutarAprobacion(esc.e.director, propuesta);
        expect(codigo(r)).toBe('PROPOSAL_STALE');
        await intacta(base.versionId);
      });

      it('el original de la fuente cambió (hash distinto del recibido)', async () => {
        await caso(
          a,
          fase,
          async () => undefined,
          async (c) => {
            const [v] = await query<{ source_document_id: string }>(
              `SELECT source_document_id FROM script_versions WHERE id = $1`,
              [c.versionId],
            );
            // El trigger de 023 impide cambiar el original de una fuente de guion: para simular que el
            // original cambió se suspende SOLO ese trigger durante la escritura y se restaura.
            const pool = getPool();
            await pool.query(`ALTER TABLE source_documents DISABLE TRIGGER source_documents_guion_guarda`);
            try {
              await pool.query(`UPDATE source_documents SET hash = $2 WHERE id = $1`, [
                v!.source_document_id,
                `${randomUUID()}${randomUUID()}`.replaceAll('-', ''),
              ]);
            } finally {
              await pool.query(`ALTER TABLE source_documents ENABLE TRIGGER source_documents_guion_guarda`);
            }
          },
        );
      });
    });
  }
});

describe('huella, contenido y vencimiento de la propuesta', () => {
  it('la huella mostrada distinta de la propuesta ⇒ PROPOSAL_STALE y la acción sigue pendiente', async () => {
    const { versionId } = await versionRevisada(a.e);
    const propuesta = await proponerAprobacion(a.e, versionId);
    const r = await confirmarAccion(a.e.director, propuesta.id, { canal: 'ui', payloadHash: 'b'.repeat(64) });
    expect(codigo(r)).toBe('PROPOSAL_STALE');
    expect(await estadoDeAccion(propuesta.id)).toBe('pending');
    await intacta(versionId);
  });

  it('el payload no se puede alterar por SQL (trigger de 013): la huella y el contenido son inmutables', async () => {
    const { versionId } = await versionRevisada(a.e);
    const propuesta = await proponerAprobacion(a.e, versionId);
    await expect(
      query(`UPDATE proposed_actions SET payload = '{"snapshot":{}}'::jsonb WHERE id = $1`, [propuesta.id]),
    ).rejects.toThrow(/inmutable/);
    await expect(
      query(`UPDATE proposed_actions SET payload_hash = $2 WHERE id = $1`, [propuesta.id, 'c'.repeat(64)]),
    ).rejects.toThrow(/inmutable/);
    await expect(
      query(`UPDATE proposed_actions SET resource_id = gen_random_uuid() WHERE id = $1`, [propuesta.id]),
    ).rejects.toThrow(/inmutable/);
    valor(await confirmarAprobacion(a.e.director, propuesta));
  });

  it('una propuesta de otra campaña no se confirma desde el alcance de otra (la lectura no la revela)', async () => {
    const { versionId } = await versionRevisada(a.e);
    const propuesta = await proponerAprobacion(a.e, versionId);
    const vistas = valor(await listarAccionesPendientesDeCampana(a.e.director, a.e.otraCampanaId));
    expect(vistas.find((v) => v.id === propuesta.id)).toBeUndefined();
    valor(await cancelarAccion(a.e.consultor, propuesta.id));
  });
});

// ─────────────────────────── La tarjeta ────────────────────────────────────────

describe('la tarjeta: texto y advertencias compuestos SOLO desde el payload', () => {
  async function tarjetaDe(propuesta: ProposedAction) {
    const vistas = valor(await listarAccionesPendientesDeCampana(a.e.director, a.e.campanaId));
    const v = vistas.find((x) => x.id === propuesta.id);
    expect(v).toBeDefined();
    return v!;
  }

  it('hallazgos abiertos: se listan por cifras (sin el texto del modelo) y avisan sin bloquear', async () => {
    const deliverableId = await entregableNuevo(a.e);
    const versionId = await versionNueva(a.e, deliverableId);
    await revisarConIA(a.e, versionId, [
      {
        category: 'cta_missing',
        refs: ['accion_kpis.accion_esperada'],
        description: 'TEXTO-DEL-MODELO-NO-CONFIABLE',
      },
      { category: 'requirement_not_covered', refs: ['mandatorios#1'] },
    ]);
    const propuesta = await proponerAprobacion(a.e, versionId);
    const t = await tarjetaDe(propuesta);
    expect(t.tipo).toBe('script_version.approve');
    expect(t.titulo).toBe('Aprobar una versión de guion');
    expect(t.textoHumano).toMatch(/Aprobará la versión 1 del guion/);
    expect(t.textoHumano).toContain('Diego Peña');
    expect(t.detalle.join(' ')).toMatch(/Revisión asistida por IA contra el Brief V1/);
    expect(t.detalle.join(' ')).toMatch(/Hallazgos de la revisión: 2 \(/);
    expect(t.advertencias.join(' ')).toMatch(/2 hallazgos abiertos/);
    expect(t.advertencias.join(' ')).not.toMatch(/no asistida/);
    // Ningún texto del modelo ni del guion llega a la tarjeta.
    expect(JSON.stringify([t.textoHumano, t.detalle, t.advertencias])).not.toMatch(/TEXTO-DEL-MODELO/);
    expect(t.canConfirm).toBe(true);
    expect(t.obsoleta).toBe(false);
    expect(t.quienConfirma).not.toMatch(/consultor/i);
    // Los hallazgos abiertos NO bloquean: se aprueba.
    valor(await confirmarAprobacion(a.e.director, propuesta));
    valor(await ejecutarAprobacion(a.e.director, propuesta));
    expect(await estadoDeVersion(versionId)).toBe('approved');
  });

  it('revisión humana: la tarjeta advierte «no asistida por IA»; sin hallazgos lo dice', async () => {
    const { versionId } = await versionRevisada(a.e);
    const t = await tarjetaDe(await proponerAprobacion(a.e, versionId));
    expect(t.advertencias).toContain('Revisión humana, no asistida por IA.');
    expect(t.detalle.join(' ')).toMatch(/La revisión no dejó hallazgos/);
    expect(t.detalle.join(' ')).toMatch(/Revisión humana contra el Brief V1/);
  });

  it('existe una versión más reciente y reemplaza a la aprobada vigente: ambos avisos', async () => {
    const { deliverableId, versionId: v1 } = await versionRevisada(a.e);
    valor(await aprobarDirecto(a.e.director, v1));
    const v2 = (await otraVersionRevisada(a.e, deliverableId)).versionId;
    await versionNueva(a.e, deliverableId); // V3 recibida: V2 ya no es la última
    const propuesta = await proponerAprobacion(a.e, v2);
    const t = await tarjetaDe(propuesta);
    expect(t.textoHumano).toMatch(/versión 2/);
    expect(t.advertencias.join(' ')).toMatch(/Existe una versión más reciente \(V3\)/);
    expect(t.advertencias.join(' ')).toMatch(/Reemplaza a la versión 1 aprobada/);
    expect(t.detalle.join(' ')).not.toMatch(/Comentarios de revisión registrados/);
  });

  it('con comentarios de revisión, la tarjeta los cuenta', async () => {
    const { versionId } = await versionRevisada(a.e);
    valor(await crearComentarioDeRevision(a.e.consultor, versionId, { kind: 'editorial', body: 'Uno' }));
    valor(await crearComentarioDeRevision(a.e.director, versionId, { kind: 'editorial', body: 'Dos' }));
    const t = await tarjetaDe(await proponerAprobacion(a.e, versionId));
    expect(t.detalle.join(' ')).toMatch(/Comentarios de revisión registrados: 2/);
  });
});

// La aprobación directa y la propuesta coexisten: ejecutar tras aprobar directo es obsoleta (no duplica).
describe('coherencia entre la vía directa y la propuesta', () => {
  it('si se aprueba directo una versión con propuesta abierta, la propuesta queda obsoleta y no duplica nada', async () => {
    const { versionId } = await versionRevisada(a.e);
    const propuesta = await proponerAprobacion(a.e, versionId);
    valor(await confirmarAprobacion(a.e.director, propuesta));
    valor(await aprobarDirecto(a.e.admin, versionId));
    expect(codigo(await ejecutarAprobacion(a.e.director, propuesta))).toBe('PROPOSAL_STALE');
    expect(await contarAuditoria(versionId, 'script_version.approve')).toBe(1);
    expect((await fila(versionId)).approved_via_proposed_action_id).toBeNull();
    // La huella directa no sirve para otra versión.
    const otra = await versionRevisada(a.e);
    const r = await aprobarScriptVersion(a.e.director, otra.versionId, { huellaVista: 'd'.repeat(64) });
    expect(codigo(r)).toBe('PROPOSAL_STALE');
  });
});
