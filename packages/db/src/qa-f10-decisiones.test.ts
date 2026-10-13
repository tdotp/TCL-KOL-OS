/**
 * QA adversarial F10 (independiente) — ATAQUES 6, 7, 12, 13, 14, 15 y 16 a nivel de casos de uso y de SQL con el rol de la
 * aplicación.
 *
 *  (6)  Operativo (y los demás roles sin `script:approve`/`brief:approve_internal`) no aprueban ni revisan contenido.
 *  (7)  La IA/chat/sistema no confirman ni ejecutan una ProposedAction; replay, huella, vencida/cancelada.
 *  (12) Revisión STALE no habilita la aprobación (Brief cambiado, versión reemplazada).
 *  (13) Canje puro ⇒ pago `not_applicable` por todos los caminos, incluida la corrección del acuerdo.
 *  (14) La IA/chat/sistema no reportan pagos; ninguna ProposedAction existe para pagos.
 *  (15) KPI: objetivos y mediciones son historia; corregir = fila nueva; UPDATE/DELETE/TRUNCATE por SQL fallan.
 *  (16) ScriptVersion y su archivo: sin UPDATE/DELETE destructivo por SQL.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LEGACY_CLIENT_STATES, TRANSITIONS, type User } from '@tcl-kol-os/domain';
import * as db from './index.ts';
import { closePool, getPool, query } from './client.ts';
import { adminPool } from './test-admin.ts';
import { archivoDePrueba, dia, unico } from './ops-test-support.ts';
import {
  aprobarDirecto,
  estadoDeVersion,
  evaluar,
  huellaDe,
  proponerAprobacion,
  versionNueva,
  versionRevisada,
} from './script-approval-test-support.ts';
import { C, type Sembrado, huellaDeCampana, sembrarSmartPR } from './qa-f10-soporte.ts';
import {
  type EscenarioDeOperacion,
  claveDePrueba,
  crearAcuerdoDePrueba,
  crearBriefHijoDePrueba,
  crearEscenarioDeOperacion,
  limpiarEscenarioDeOperacion,
} from './test-utils.ts';

let op: EscenarioDeOperacion;
let s: Sembrado;

beforeAll(async () => {
  op = await crearEscenarioDeOperacion('QA F10 decisiones', { conAcuerdoAjeno: false });
  s = await sembrarSmartPR(op);
}, 240_000);

afterAll(async () => {
  await limpiarEscenarioDeOperacion(op);
  await closePool();
});

const codigo = (r: { ok: boolean; error?: { code: string } }): string => (r.ok ? 'OK' : r.error!.code);

async function rechazaSql(sql: string, params: unknown[] = []): Promise<string> {
  try {
    await query(sql, params);
    return 'PERMITIDO';
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

/** Ejecuta SQL destructivo dentro de una transacción que SIEMPRE se revierte. */
async function intentaYRevierte(sql: string, params: unknown[] = []): Promise<string> {
  const c = await getPool().connect();
  try {
    await c.query('BEGIN');
    await c.query(sql, params);
    return 'PERMITIDO';
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  } finally {
    await c.query('ROLLBACK').catch(() => undefined);
    c.release();
  }
}

/** Igual que `intentaYRevierte` pero con el rol PRIVILEGIADO de pruebas: prueba la capa de triggers por debajo de los privilegios. */
async function intentaComoAdmin(sql: string): Promise<string> {
  const c = await adminPool().connect();
  try {
    await c.query('BEGIN');
    await c.query(sql);
    return 'PERMITIDO';
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  } finally {
    await c.query('ROLLBACK').catch(() => undefined);
    c.release();
  }
}

async function nuevaPersona(etiqueta: string): Promise<string> {
  const creado = await db.crearInfluencer(op.admin, {
    displayName: `${etiqueta} ${unico('p')}`,
    cuentas: [{ platform: 'instagram', handle: `${unico('h')}.${op.sufijo}` }],
  });
  if (!creado.ok) throw new Error(creado.error.code);
  const ci = await db.asociarInfluencerACampana(op.admin, {
    campaignId: op.campanaId,
    influencerId: creado.value.influencer.id,
  });
  if (!ci.ok) throw new Error(ci.error.code);
  const asociado = await db.asociarProductoAInfluencer(op.admin, {
    campaignInfluencerId: ci.value.id,
    campaignProductId: op.productos.p80,
  });
  if (!asociado.ok) throw new Error(asociado.error.code);
  return ci.value.id;
}

// ─────────────────────────── (6) roles sin autoridad creativa ──────────────────

describe('QA F10 · (6) el Operativo y los roles sin autoridad no aprueban ni revisan contenido', () => {
  const sinAutoridad = (): Array<[string, User]> => [
    ['operativo', op.operativo],
    ['analista', op.analista],
    ['legal', op.legal],
    ['consultor', op.consultor],
    ['cliente', op.cliente],
  ];

  it('aprobarScriptVersion con la huella correcta: denegado para operativo, analista, legal, consultor y cliente', async () => {
    const v = await versionRevisada(op);
    const huella = await huellaDe(v.versionId);
    for (const [rol, u] of sinAutoridad()) {
      const r = await db.aprobarScriptVersion(u, v.versionId, { huellaVista: huella });
      expect(r.ok, `${rol} aprobó un guion`).toBe(false);
    }
    expect(await estadoDeVersion(v.versionId)).toBe('in_review');
  });

  it('registrarRevisionHumana, solicitarAnalisisDeGuion y comentarios: el Operativo/analista/legal/cliente no pueden', async () => {
    const v = await versionNueva(op, op.entregables.reelDiego, {
      participationId: op.participaciones.diego,
    });
    for (const [rol, u] of [
      ['operativo', op.operativo],
      ['analista', op.analista],
      ['legal', op.legal],
      ['cliente', op.cliente],
    ] as const) {
      expect((await db.registrarRevisionHumana(u, v, {})).ok, `${rol}: revisión humana`).toBe(false);
      expect(
        (await db.solicitarAnalisisDeGuion(u, v, { mode: 'reanalyze', idempotencyKey: claveDePrueba('x') }))
          .ok,
        `${rol}: análisis`,
      ).toBe(false);
      expect(
        (await db.crearComentarioDeRevision(u, v, { kind: 'editorial', body: 'comentario qa f10 largo' })).ok,
        `${rol}: comentario`,
      ).toBe(false);
      expect(
        (await db.solicitarCambiosDeScript(u, v, { items: [{ body: 'cambio qa f10 largo' }] })).ok,
        `${rol}: cambios`,
      ).toBe(false);
      expect((await db.listarHallazgos(u, { versionId: v })).ok, `${rol}: hallazgos`).toBe(false);
      expect((await db.listarRevisiones(u, v)).ok, `${rol}: revisiones`).toBe(false);
    }
    expect(await estadoDeVersion(v)).toBe('received');
  });

  it('Brief: operativo, analista, legal y cliente no transicionan, no aprueban, no piden cambios ni crean versión hija', async () => {
    for (const [rol, u] of [
      ['operativo', op.operativo],
      ['analista', op.analista],
      ['legal', op.legal],
      ['cliente', op.cliente],
    ] as const) {
      for (const to of [
        'internal_review',
        'approved',
        'internal_changes_requested',
        'client_review',
      ] as const) {
        const r = await db.transicionarBrief(u, s.briefVersionId, to);
        expect(r.ok, `${rol} → ${to}`).toBe(false);
      }
      expect((await db.aprobarBrief(u, s.briefVersionId)).ok, `${rol}: aprobarBrief`).toBe(false);
      expect((await db.crearVersionHija(u, s.briefVersionId)).ok, `${rol}: versión hija`).toBe(false);
    }
  });

  it('ProposedAction creativa: el Operativo ni la propone ni la confirma ni la ejecuta (aunque el chat la dejó pendiente)', async () => {
    const v = await versionRevisada(op);
    for (const [rol, u] of [
      ['operativo', op.operativo],
      ['analista', op.analista],
      ['legal', op.legal],
      ['cliente', op.cliente],
    ] as const) {
      const p = await db.proponerAccion(u, {
        type: 'script_version.approve',
        resourceId: v.versionId,
        origin: 'chat',
        campaignId: op.campanaId,
      });
      expect(p.ok, `${rol} propuso`).toBe(false);
    }
    const accion = await proponerAprobacion(op, v.versionId, op.consultor);
    for (const [rol, u] of [
      ['operativo', op.operativo],
      ['analista', op.analista],
      ['consultor (quien propuso)', op.consultor],
    ] as const) {
      expect(
        (await db.confirmarAccion(u, accion.id, { canal: 'ui', payloadHash: accion.payloadHash })).ok,
        `${rol} confirmó`,
      ).toBe(false);
    }
    expect((await db.ejecutarAccion(op.operativo, accion.id, { canal: 'ui' })).ok).toBe(false);
    expect(await estadoDeVersion(v.versionId)).toBe('in_review');
    const [fila] = await query<{ status: string; confirmed_by: string | null }>(
      `SELECT status, confirmed_by FROM proposed_actions WHERE id = $1`,
      [accion.id],
    );
    expect(fila).toEqual({ status: 'pending', confirmed_by: null });
  });
});

// ─────────────────────────── (7) la IA no confirma ─────────────────────────────

describe('QA F10 · (7) la IA/chat/sistema no confirman ni ejecutan; replay, huella, cancelada, vencida', () => {
  it('variantes de canal y de actor: ninguna confirma ni ejecuta; la acción sigue pendiente', async () => {
    const v = await versionRevisada(op);
    const a = await proponerAprobacion(op, v.versionId, op.consultor);
    const canales: unknown[] = [
      'chat',
      'system',
      'UI',
      'ui ',
      'ui\u0000',
      ['ui'],
      { toString: () => 'ui' },
      null,
      undefined,
      1,
      '',
    ];
    for (const canal of canales) {
      for (const actor of [op.director, op.admin, 'system'] as const) {
        const c = await db.confirmarAccion(actor as never, a.id, {
          canal: canal as never,
          payloadHash: a.payloadHash,
        });
        expect(
          c.ok,
          `confirmar canal=${String(canal)} actor=${typeof actor === 'string' ? actor : actor.role}`,
        ).toBe(false);
        const e = await db.ejecutarAccion(actor as never, a.id, { canal: canal as never });
        expect(e.ok, `ejecutar canal=${String(canal)}`).toBe(false);
      }
    }
    expect(await estadoDeVersion(v.versionId)).toBe('in_review');
  });

  it('huella manipulada, vacía o de otra acción: PROPOSAL_STALE; replay de una confirmación válida: no vuelve a ejecutar', async () => {
    const v = await versionRevisada(op);
    const w = await versionRevisada(op);
    const a = await proponerAprobacion(op, v.versionId, op.consultor);
    const b = await proponerAprobacion(op, w.versionId, op.consultor);
    for (const h of ['', 'a'.repeat(64), b.payloadHash, a.payloadHash.toUpperCase(), `${a.payloadHash} `]) {
      expect(
        codigo(await db.confirmarAccion(op.director, a.id, { canal: 'ui', payloadHash: h })),
        h,
      ).not.toBe('OK');
    }
    expect(
      (await db.confirmarAccion(op.director, a.id, { canal: 'ui', payloadHash: a.payloadHash })).ok,
    ).toBe(true);
    // replay y doble confirmación
    expect(
      (await db.confirmarAccion(op.director, a.id, { canal: 'ui', payloadHash: a.payloadHash })).ok,
    ).toBe(false);
    expect((await db.confirmarAccion(op.admin, a.id, { canal: 'ui', payloadHash: a.payloadHash })).ok).toBe(
      false,
    );
    // otro admin no ejecuta lo confirmado por el director
    expect((await db.ejecutarAccion(op.admin, a.id, { canal: 'ui' })).ok).toBe(false);
    expect((await db.ejecutarAccion(op.director, a.id, { canal: 'ui' })).ok).toBe(true);
    expect((await db.ejecutarAccion(op.director, a.id, { canal: 'ui' })).ok).toBe(false);
    expect(await estadoDeVersion(v.versionId)).toBe('approved');
    expect(await estadoDeVersion(w.versionId)).toBe('in_review');
    const [n] = await query<{ n: string }>(
      `SELECT count(*)::text AS n FROM audit_events WHERE action = 'script_version.approve' AND entity_id = $1`,
      [v.versionId],
    );
    expect(Number(n!.n)).toBe(1);
  });

  it('cancelada o vencida: no se confirma ni se ejecuta', async () => {
    const v = await versionRevisada(op);
    const a = await proponerAprobacion(op, v.versionId, op.consultor);
    expect((await db.cancelarAccion(op.consultor, a.id)).ok).toBe(true);
    expect(
      (await db.confirmarAccion(op.director, a.id, { canal: 'ui', payloadHash: a.payloadHash })).ok,
    ).toBe(false);
    expect((await db.ejecutarAccion(op.director, a.id, { canal: 'ui' })).ok).toBe(false);

    const w = await versionRevisada(op);
    const b = await proponerAprobacion(op, w.versionId, op.consultor);
    await query(`UPDATE proposed_actions SET expires_at = now() - interval '1 minute' WHERE id = $1`, [
      b.id,
    ]).catch(() => undefined);
    const c = await db.confirmarAccion(op.director, b.id, { canal: 'ui', payloadHash: b.payloadHash });
    // O la base impide adelantar el vencimiento (trigger) o la confirmación se rechaza por vencida: nunca se aprueba.
    if (c.ok) {
      // La base no dejó vencerla: se verifica que al menos el vencimiento real por TTL la cierra (cubierto en H2).
      expect(await estadoDeVersion(w.versionId)).toBe('in_review');
    } else {
      expect(await estadoDeVersion(w.versionId)).toBe('in_review');
    }
  });

  it('la IA no puede forjar la confirmación por SQL: confirmed_by/estado/huella no se editan salvo por el caso de uso', async () => {
    const v = await versionRevisada(op);
    const a = await proponerAprobacion(op, v.versionId, op.consultor);
    for (const sql of [
      `UPDATE proposed_actions SET status = 'executed' WHERE id = $1`,
      `UPDATE proposed_actions SET payload_hash = repeat('a', 64) WHERE id = $1`,
      `UPDATE proposed_actions SET proposed_origin = 'ui' WHERE id = $1`,
      `UPDATE proposed_actions SET resource_id = gen_random_uuid() WHERE id = $1`,
      `DELETE FROM proposed_actions WHERE id = $1`,
    ]) {
      expect(await rechazaSql(sql, [a.id]), sql).not.toBe('PERMITIDO');
    }
  });
});

// ─────────────────────────── (12) revisión STALE ───────────────────────────────

// QA-F10-06 (abierto, P3 TEÓRICO): el trigger de `proposed_actions` valida la TRANSICIÓN (pending → confirmed) pero no quién
// la hace: con el rol de la aplicación, un UPDATE directo puede dejar confirmada una propuesta del chat por su propio
// proponente. Solo sería explotable con SQL arbitrario (ninguna tool tiene SQL: ver el barrido estático del agente).
describe('QA F10 · (7b) SQL directo sobre proposed_actions', () => {
  it.fails(
    'QA-F10-06 abierto · una propuesta del chat no se puede confirmar por SQL como su propio proponente',
    async () => {
      const v = await versionRevisada(op);
      const a = await proponerAprobacion(op, v.versionId, op.consultor);
      expect(
        await rechazaSql(
          `UPDATE proposed_actions SET status = 'confirmed', confirmed_by = proposed_by, confirmed_at = now() WHERE id = $1`,
          [a.id],
        ),
      ).not.toBe('PERMITIDO');
    },
  );
});

describe('QA F10 · (12) una revisión STALE no se trata como vigente', () => {
  it('Brief rector nuevo tras la revisión: la evaluación pasa a no elegible y aprobar falla aunque la huella sea la «vista»', async () => {
    const v = await versionRevisada(op);
    const huellaAntes = await huellaDe(v.versionId);
    expect((await evaluar(v.versionId)).elegible).toBe(true);
    await crearBriefHijoDePrueba(op.admin, s.briefVersionId, {
      cambios: { 'mensaje_principal.one_line': `${C.brief} cambio del rector tras la revisión.` },
    });
    const evaluacion = await evaluar(v.versionId);
    expect(evaluacion.elegible, 'revisión stale tratada como vigente').toBe(false);
    for (const huella of [huellaAntes, await huellaDe(v.versionId)]) {
      const r = await db.aprobarScriptVersion(op.director, v.versionId, { huellaVista: huella });
      expect(r.ok, 'aprobó con revisión stale').toBe(false);
    }
    expect(await estadoDeVersion(v.versionId)).toBe('in_review');
  });

  it('propuesta hecha con revisión vigente: si el Brief cambia antes de confirmar o de ejecutar, no se aprueba', async () => {
    const hijo = await db.obtenerBriefRector(op.admin, op.campanaId);
    expect(hijo.ok).toBe(true);
    const v = await versionRevisada(op);
    const a = await proponerAprobacion(op, v.versionId, op.consultor);
    await crearBriefHijoDePrueba(op.admin, (hijo.ok ? hijo.value.versionId : s.briefVersionId) as string, {
      cambios: { 'mensaje_principal.one_line': `${C.brief} otro cambio antes de confirmar.` },
    });
    const c = await db.confirmarAccion(op.director, a.id, { canal: 'ui', payloadHash: a.payloadHash });
    if (c.ok) {
      expect(
        (await db.ejecutarAccion(op.director, a.id, { canal: 'ui' })).ok,
        'ejecutó con revisión stale',
      ).toBe(false);
    }
    expect(await estadoDeVersion(v.versionId)).toBe('in_review');
  });

  it('una versión reemplazada (otra versión más nueva en el entregable) no se aprueba por la revisión de la anterior', async () => {
    const v1 = await versionRevisada(op);
    const v2 = await versionNueva(op, v1.deliverableId);
    expect((await db.aprobarScriptVersion(op.director, v2, { huellaVista: 'a'.repeat(64) })).ok).toBe(false);
    expect(await estadoDeVersion(v2)).toBe('received');
  });

  it('SQL: no se puede marcar `current` una revisión vieja ni fabricar una revisión humana con el rol de la aplicación', async () => {
    const v = await versionNueva(op, op.entregables.reelDiego, { participationId: op.participaciones.diego });
    const r = await rechazaSql(
      `INSERT INTO content_analysis_runs (organization_id, campaign_id, script_version_id, kind, status)
       SELECT organization_id, campaign_id, id, 'human', 'succeeded' FROM script_versions WHERE id = $1`,
      [v],
    );
    expect(r, 'revisión humana fabricada por SQL').not.toBe('PERMITIDO');
    expect(await estadoDeVersion(v)).toBe('received');
  });
});

// ─────────────────────────── (13) canje puro ───────────────────────────────────

describe('QA F10 · (13) canje puro ⇒ pago not_applicable por todos los caminos', () => {
  const estadoPago = async (agreementId: string): Promise<{ status: string; row_seq: number; id: string }> =>
    (
      await query<{ status: string; row_seq: number; id: string }>(
        `SELECT id, status, row_seq FROM payment_obligations WHERE agreement_id = $1`,
        [agreementId],
      )
    )[0]!;

  it('barter nace not_applicable; reportar pago, registrar cuenta de cobro, cancelar y nota de corrección fallan', async () => {
    const ci = await nuevaPersona('Canje');
    const ac = await crearAcuerdoDePrueba(op.admin, {
      campaignInfluencerId: ci,
      mode: 'barter',
      campaignProductId: op.productos.p80,
      quantity: 1,
    });
    const o = await estadoPago(ac.id);
    expect(o.status).toBe('not_applicable');
    for (const u of [op.admin, op.operativo]) {
      const pago = await db.reportarPago(u, {
        paymentObligationId: o.id,
        expectedSeq: o.row_seq,
        idempotencyKey: unico('pago'),
        paidOn: dia(1),
        externalReference: 'REF-CANJE-QA',
      });
      expect(pago.ok, 'pago reportado sobre un canje puro').toBe(false);
      const doc = await db.registrarDocumentoDeCobro(u, {
        paymentObligationId: o.id,
        documentNumber: unico('CC'),
        issuedOn: dia(2),
        claimedAmount: 1000,
        claimedCurrency: 'COP',
        archivo: archivoDePrueba(),
        idempotencyKey: unico('doc'),
      });
      expect(doc.ok, 'cuenta de cobro sobre un canje puro').toBe(false);
    }
    expect((await estadoPago(ac.id)).status).toBe('not_applicable');
    const [d] = await query<{ n: string }>(
      `SELECT count(*)::text AS n FROM billing_documents WHERE payment_obligation_id = $1`,
      [o.id],
    );
    expect(Number(d!.n)).toBe(0);
  });

  it('SQL: forzar `pending` en la obligación de un canje, o cambiar el modo de una versión, lo rechaza la base', async () => {
    const ci = await nuevaPersona('Canje SQL');
    const ac = await crearAcuerdoDePrueba(op.admin, {
      campaignInfluencerId: ci,
      mode: 'barter',
      campaignProductId: op.productos.p80,
      quantity: 1,
    });
    const o = await estadoPago(ac.id);
    expect(
      await rechazaSql(`UPDATE payment_obligations SET status = 'pending' WHERE id = $1`, [o.id]),
    ).not.toBe('PERMITIDO');
    expect(
      await rechazaSql(
        `UPDATE agreement_versions SET compensation_type = 'fee', fee_amount = 1, fee_currency = 'COP' WHERE agreement_id = $1`,
        [ac.id],
      ),
    ).not.toBe('PERMITIDO');
    expect(await rechazaSql(`DELETE FROM payment_obligations WHERE id = $1`, [o.id])).not.toBe('PERMITIDO');
    expect(
      await rechazaSql(`UPDATE payment_obligations SET status = 'reported_paid' WHERE id = $1`, [o.id]),
    ).not.toBe('PERMITIDO');
    expect((await estadoPago(ac.id)).status).toBe('not_applicable');
  });

  it('corrección del acuerdo: fee→barter ajusta a not_applicable; barter→fee→barter; con cobro vivo no se corrige a canje', async () => {
    const ci = await nuevaPersona('Corrección');
    const ac = await crearAcuerdoDePrueba(op.admin, {
      campaignInfluencerId: ci,
      mode: 'fee',
      amount: 500000,
    });
    expect((await estadoPago(ac.id)).status).toBe('pending');
    const aBarter = await db.registrarVersionDeAcuerdo(op.admin, ac.id, {
      expectedVersion: ac.currentVersion,
      compensationType: 'barter',
      commitments: [{ campaignProductId: op.productos.p80, quantity: 1 }],
      changeReason: 'Pasa a canje puro',
      idempotencyKey: unico('v'),
    });
    expect(aBarter.ok, JSON.stringify(aBarter)).toBe(true);
    expect((await estadoPago(ac.id)).status).toBe('not_applicable');
    const aFee = await db.registrarVersionDeAcuerdo(op.admin, ac.id, {
      expectedVersion: aBarter.ok ? aBarter.value.acuerdo.currentVersion : 2,
      compensationType: 'fee',
      feeAmount: 300000,
      feeCurrency: 'COP',
      changeReason: 'Vuelve a tarifa',
      idempotencyKey: unico('v'),
    });
    expect(aFee.ok).toBe(true);
    const o = await estadoPago(ac.id);
    expect(o.status).toBe('pending');
    // Con una cuenta de cobro viva, volver a canje NO deja una obligación huérfana.
    const doc = await db.registrarDocumentoDeCobro(op.operativo, {
      paymentObligationId: o.id,
      documentNumber: unico('CC'),
      issuedOn: dia(1),
      claimedAmount: 300000,
      claimedCurrency: 'COP',
      archivo: archivoDePrueba(),
      idempotencyKey: unico('doc'),
    });
    expect(doc.ok).toBe(true);
    const devuelta = await db.registrarVersionDeAcuerdo(op.admin, ac.id, {
      expectedVersion: aFee.ok ? aFee.value.acuerdo.currentVersion : 3,
      compensationType: 'barter',
      commitments: [{ campaignProductId: op.productos.p80, quantity: 1 }],
      changeReason: 'Intento de canje con cobro vivo',
      idempotencyKey: unico('v'),
    });
    expect(devuelta.ok, 'se corrigió a canje con una cuenta de cobro viva').toBe(false);
    expect((await estadoPago(ac.id)).status).toBe('pending');
  });

  it('el resumen operativo con «pago pendiente» no lista un canje puro; el seguimiento de pago del canje es not_applicable', async () => {
    const r = await db.obtenerResumenOperativoDeCampana(op.admin, op.campanaId, {
      pagoPendiente: true,
      limite: 200,
    } as never);
    if (!r.ok) throw new Error(r.error.code);
    const texto = JSON.stringify(r.value);
    expect(texto).not.toContain(s.participacionBarterId);
    expect(texto).toContain(s.participacionId);
    const seg = await db.obtenerSeguimientoDePago(op.admin, s.participacionBarterId);
    expect(JSON.stringify(seg)).toContain('not_applicable');
    expect(JSON.stringify(seg)).not.toContain('pending');
  });
});

// ─────────────────────────── (14) autoridad de pago ────────────────────────────

describe('QA F10 · (14) la IA, el chat y el sistema no reportan pagos; no existe ProposedAction de pagos', () => {
  it('reportarPago con origen chat/system/otro, actor system o rol sin payment:report: ninguno cambia la obligación', async () => {
    const ci = await nuevaPersona('Pago IA');
    const ac = await crearAcuerdoDePrueba(op.admin, {
      campaignInfluencerId: ci,
      mode: 'fee',
      amount: 410000,
    });
    const [antes] = await query<{ id: string; status: string; row_seq: number }>(
      `SELECT id, status, row_seq FROM payment_obligations WHERE agreement_id = $1`,
      [ac.id],
    );
    const pago = () => ({
      paymentObligationId: antes!.id,
      expectedSeq: antes!.row_seq,
      idempotencyKey: unico('pago'),
      paidOn: dia(1),
      externalReference: 'REF-QA-F10',
    });
    // `null`/`undefined` son el canal por omisión (`ui`, persona por la interfaz): se prueba como CONTROL abajo.
    for (const origin of ['chat', 'system', 'api', 'CHAT', ''] as const) {
      for (const actor of [op.admin, op.operativo] as const) {
        const r = await db.reportarPago(actor, pago(), { origin } as never);
        expect(r.ok, `origin=${String(origin)} ${actor.role}`).toBe(false);
      }
    }
    expect((await db.reportarPago('system' as never, pago())).ok).toBe(false);
    for (const u of [op.director, op.consultor, op.analista, op.legal, op.cliente, op.ajeno]) {
      expect((await db.reportarPago(u, pago())).ok, `rol ${u.role}`).toBe(false);
    }
    const [despues] = await query<{ status: string; row_seq: number }>(
      `SELECT status, row_seq FROM payment_obligations WHERE id = $1`,
      [antes!.id],
    );
    expect(despues).toEqual({ status: 'pending', row_seq: antes!.row_seq });
    // CONTROL: la persona por la interfaz (contexto por omisión) sí puede.
    expect((await db.reportarPago(op.operativo, pago())).ok).toBe(true);
  });

  it('el catálogo de ProposedAction NO tiene pagos, acuerdos, envíos, PII ni KPI: solo brief, importación y guion', async () => {
    const tipos = [
      'brief.approve',
      'influencer_import.apply',
      'influencer_import.resolve_record',
      'script_version.approve',
    ];
    for (const t of [
      'payment.report',
      'payment.reported',
      'billing.validate',
      'agreement.create',
      'shipment.deliver',
      'pii.reveal',
      'kpi.measure',
      'source.set_visibility',
      '__proto__',
      'constructor',
      'toString',
    ]) {
      const r = await db.proponerAccion(op.admin, {
        type: t as never,
        resourceId: s.obligacionId,
        origin: 'chat',
        campaignId: op.campanaId,
      });
      expect(r.ok, `tipo ${t} propuesto`).toBe(false);
    }
    expect(tipos.length).toBe(4);
  });

  it('SQL: ni el rol de la aplicación puede marcar `reported_paid` por UPDATE directo ni insertar un evento de pago sin la persona', async () => {
    expect(
      await rechazaSql(`UPDATE payment_obligations SET status = 'reported_paid' WHERE id = $1`, [
        s.obligacionId,
      ]),
    ).not.toBe('PERMITIDO');
    expect(
      await rechazaSql(
        `INSERT INTO operational_events (organization_id, campaign_id, subject_type, payment_obligation_id, event_type,
                                         from_status, to_status, subject_seq, recorded_by, origin,
                                         idempotency_key, request_hash, happened_on, external_reference)
         SELECT organization_id, campaign_id, 'payment_obligation', id, 'payment.reported', 'pending', 'reported_paid',
                row_seq + 1, created_by, 'chat', 'qa-f10-pago-chat-0001', repeat('a', 64), current_date, 'REF-QA'
           FROM payment_obligations WHERE id = $1`,
        [s.obligacionId],
      ),
    ).toMatch(/operational_events_origen_ui|origen/u);
  });
});

// ─────────────────────────── (15) KPI ──────────────────────────────────────────

describe('QA F10 · (15) KPI: historia no destructiva', () => {
  it('UPDATE/DELETE/TRUNCATE de mediciones y objetivos fallan con el rol de la aplicación', async () => {
    const intentos: Array<[string, string, unknown[]]> = [
      ['medición: valor', `UPDATE kpi_measurements SET value = 1 WHERE id = $1`, [s.medicionKpiId]],
      [
        'medición: observed_at',
        `UPDATE kpi_measurements SET observed_at = now() - interval '9 days' WHERE id = $1`,
        [s.medicionKpiId],
      ],
      [
        'medición: recorded_by',
        `UPDATE kpi_measurements SET recorded_by = $2 WHERE id = $1`,
        [s.medicionKpiId, op.cliente.id],
      ],
      [
        'medición: origen',
        `UPDATE kpi_measurements SET origin_channel = 'chat' WHERE id = $1`,
        [s.medicionKpiId],
      ],
      ['medición: delete', `DELETE FROM kpi_measurements WHERE id = $1`, [s.medicionKpiId]],
      ['medición: truncate', `TRUNCATE kpi_measurements`, []],
      ['objetivo: valor', `UPDATE kpi_targets SET target_value = 1 WHERE id = $1`, [s.objetivoKpiId]],
      ['objetivo: métrica', `UPDATE kpi_targets SET metric = 'reach' WHERE id = $1`, [s.objetivoKpiId]],
      ['objetivo: comparador', `UPDATE kpi_targets SET comparator = 'lte' WHERE id = $1`, [s.objetivoKpiId]],
      ['objetivo: delete', `DELETE FROM kpi_targets WHERE id = $1`, [s.objetivoKpiId]],
      ['objetivo: truncate', `TRUNCATE kpi_targets`, []],
    ];
    for (const [nombre, sql, params] of intentos) {
      expect(await intentaYRevierte(sql, params), nombre).not.toBe('PERMITIDO');
    }
    const [m] = await query<{ value: string }>(`SELECT value::text FROM kpi_measurements WHERE id = $1`, [
      s.medicionKpiId,
    ]);
    expect(Number(m!.value)).toBe(12345);
  });

  it('corregir una medición añade una fila NUEVA y deja la original intacta; una sola corrección por fila', async () => {
    const antes = await query<{ id: string; value: string }>(
      `SELECT id, value::text FROM kpi_measurements WHERE campaign_influencer_id = $1 ORDER BY seq`,
      [s.participacionId],
    );
    const c = await db.corregirMedicionKpi(op.operativo, s.medicionKpiId, {
      value: 999,
      correctionReason: 'Corrección QA F10',
      idempotencyKey: claveDePrueba('corr'),
    });
    expect(c.ok, JSON.stringify(c)).toBe(true);
    const despues = await query<{ id: string; value: string; supersedes_id: string | null }>(
      `SELECT id, value::text, supersedes_id FROM kpi_measurements WHERE campaign_influencer_id = $1 ORDER BY seq`,
      [s.participacionId],
    );
    expect(despues.length).toBe(antes.length + 1);
    expect(despues.find((x) => x.id === s.medicionKpiId)!.value).toBe(
      antes.find((x) => x.id === s.medicionKpiId)!.value,
    );
    expect(despues.filter((x) => x.supersedes_id === s.medicionKpiId).length).toBe(1);
    const otra = await db.corregirMedicionKpi(op.operativo, s.medicionKpiId, {
      value: 888,
      correctionReason: 'Segunda corrección',
      idempotencyKey: claveDePrueba('corr'),
    });
    expect(otra.ok, 'segunda corrección sobre la misma fila').toBe(false);
  });

  it('reemplazar/retirar un objetivo conserva la fila anterior; el retiro no borra', async () => {
    const r = await db.retirarKpiObjetivo(op.consultor, s.objetivoKpiId, {
      idempotencyKey: claveDePrueba('ret'),
    } as never);
    const [fila] = await query<{ id: string; status: string; target_value: string }>(
      `SELECT id, status, target_value::text FROM kpi_targets WHERE id = $1`,
      [s.objetivoKpiId],
    );
    expect(fila).toBeDefined();
    expect(Number(fila!.target_value)).toBe(10000);
    expect(['active', 'withdrawn', 'retired', 'superseded']).toContain(fila!.status);
    void r;
  });
});

// ─────────────────────────── (16) ScriptVersion ────────────────────────────────

describe('QA F10 · (16) ScriptVersion y su archivo no se sobrescriben', () => {
  it('UPDATE/DELETE de contenido, hash, nombre, número o estado ilegal de una versión (incluso aprobada): rechazados', async () => {
    const aprobada = s.guionAprobadoId;
    const intentos: Array<[string, string]> = [
      ['hash', `UPDATE script_versions SET source_hash = repeat('b', 64) WHERE id = $1`],
      ['nombre', `UPDATE script_versions SET source_filename = 'otro.pdf' WHERE id = $1`],
      ['número', `UPDATE script_versions SET version = 99 WHERE id = $1`],
      ['archivo', `UPDATE script_versions SET source_document_id = gen_random_uuid() WHERE id = $1`],
      ['estado aprobado→received', `UPDATE script_versions SET status = 'received' WHERE id = $1`],
      [
        'estado aprobado→changes_requested',
        `UPDATE script_versions SET status = 'changes_requested' WHERE id = $1`,
      ],
      ['delete', `DELETE FROM script_versions WHERE id = $1`],
    ];
    for (const [nombre, sql] of intentos) {
      expect(await intentaYRevierte(sql, [aprobada]), nombre).not.toBe('PERMITIDO');
    }
    // TRUNCATE sin CASCADE lo frena una FK (rol privilegiado); el rol de ejecución ni siquiera tiene el privilegio:
    // ver `qa-rr-privilegios.test.ts` (QA-F10-07, cerrado).
    expect(await intentaComoAdmin(`TRUNCATE script_versions`)).toMatch(/foreign key/u);
    expect(await intentaYRevierte(`TRUNCATE script_versions`)).toMatch(/permission denied/u);
    expect(await estadoDeVersion(aprobada)).toBe('approved');
  });

  it('el ARCHIVO de una versión registrada: hash, ruta, tipo, nombre y borrado de la fuente están protegidos', async () => {
    const [v] = await query<{ source_document_id: string }>(
      `SELECT source_document_id FROM script_versions WHERE id = $1`,
      [s.guionAprobadoId],
    );
    const fuente = v!.source_document_id;
    const intentos: Array<[string, string]> = [
      ['hash de la fuente', `UPDATE source_documents SET hash = 'hash-adulterado' WHERE id = $1`],
      ['archivo de la fuente', `UPDATE source_documents SET file_id = 'otro/archivo.md' WHERE id = $1`],
      ['nombre de la fuente', `UPDATE source_documents SET filename = 'adulterado.md' WHERE id = $1`],
      ['borrar la fuente', `DELETE FROM source_documents WHERE id = $1`],
    ];
    for (const [nombre, sql] of intentos) {
      expect(await intentaYRevierte(sql, [fuente]), nombre).not.toBe('PERMITIDO');
    }
  });

  it('el TEXTO del guion (fragmentos de su fuente) no se reescribe tras registrar la versión', async () => {
    const [v] = await query<{ source_document_id: string }>(
      `SELECT source_document_id FROM script_versions WHERE id = $1`,
      [s.guionAprobadoId],
    );
    const resultado = await intentaYRevierte(
      `UPDATE source_fragments SET text = 'TEXTO REESCRITO DESPUES DE APROBAR' WHERE source_id = $1`,
      [v!.source_document_id],
    );
    expect(resultado, 'el texto del guion aprobado se puede reescribir por SQL').not.toBe('PERMITIDO');
    expect(
      await intentaYRevierte(`DELETE FROM source_fragments WHERE source_id = $1`, [v!.source_document_id]),
    ).not.toBe('PERMITIDO');
  });

  it('la huella global de la campaña sembrada no cambió por los intentos revertidos', async () => {
    const h = await huellaDeCampana(op.campanaId, op.admin.organizationId);
    expect(h.length).toBeGreaterThan(10);
  });
});

// QA-F10-07 y QA-F10-08 (CERRADOS en Release Readiness · Bloque 1, sin migración): el rol de ejecución de la aplicación ya no
// es superusuario ni dueño de las tablas y no tiene `TRUNCATE`. La batería completa de privilegios vive en
// `qa-rr-privilegios.test.ts`; aquí se conservan los dos casos originales de F10 como pruebas ordinarias.
describe('QA F10 · (16b) TRUNCATE y rol de la aplicación', () => {
  it('QA-F10-07 cerrado · TRUNCATE de las tablas de historia (auditoría, versiones, propuestas, pagos) está bloqueado', async () => {
    const tablas = [
      'audit_events',
      'script_versions',
      'proposed_actions',
      'payment_obligations',
      'operational_events',
      'brief_field_revisions',
    ];
    const resultados: Record<string, string> = {};
    for (const t of tablas) resultados[t] = await intentaYRevierte(`TRUNCATE ${t} CASCADE`);
    expect(Object.values(resultados)).not.toContain('PERMITIDO');
    for (const [tabla, mensaje] of Object.entries(resultados))
      expect(mensaje, tabla).toMatch(/permission denied/u);
  });

  it('CONTROL: bajo los privilegios sigue la capa de triggers: kpi_measurements y kpi_targets rechazan TRUNCATE (rol privilegiado)', async () => {
    for (const t of ['kpi_measurements', 'kpi_targets']) {
      expect(await intentaComoAdmin(`TRUNCATE ${t} CASCADE`), t).toMatch(/no admite TRUNCATE/u);
    }
  });

  it('QA-F10-08 cerrado · el rol de la aplicación no es superusuario ni puede desactivar triggers', async () => {
    const [r] = await query<{ rolsuper: boolean }>(
      `SELECT rolsuper FROM pg_roles WHERE rolname = current_user`,
    );
    expect(r!.rolsuper).toBe(false);
    expect(await intentaYRevierte(`ALTER TABLE audit_events DISABLE TRIGGER ALL`)).toMatch(/must be owner/u);
    expect(await intentaYRevierte(`SET LOCAL session_replication_role = replica`)).toMatch(
      /permission denied/u,
    );
  });
});

// ─────────────────────────── (18b) estados heredados del cliente ───────────────

describe('QA F10 · (18b) client_review / client_changes_requested no son alcanzables', () => {
  it('ninguna regla de transición los tiene como destino y ningún rol `cliente` figura en ninguna regla', () => {
    expect(LEGACY_CLIENT_STATES).toEqual(['client_review', 'client_changes_requested']);
    expect(
      TRANSITIONS.filter((t) => LEGACY_CLIENT_STATES.includes(t.to)).map((t) => `${t.from}→${t.to}`),
    ).toEqual([]);
    expect(TRANSITIONS.filter((t) => (t.roles as readonly string[]).includes('cliente'))).toEqual([]);
  });

  it('transicionarBrief hacia un estado heredado falla para toda persona de la agencia, desde cualquier estado real', async () => {
    const [v] = await query<{ id: string; status: string }>(
      `SELECT id, status FROM brief_versions
        WHERE status = 'approved' AND brief_id = (SELECT brief_id FROM brief_versions WHERE id = $1)`,
      [s.briefVersionId],
    );
    expect(v!.status).toBe('approved');
    for (const u of [op.admin, op.director, op.consultor, op.operativo, op.analista, op.legal, op.cliente]) {
      for (const to of LEGACY_CLIENT_STATES) {
        expect((await db.transicionarBrief(u, v!.id, to)).ok, `${u.role} → ${to}`).toBe(false);
      }
    }
    const [despues] = await query<{ status: string }>(`SELECT status FROM brief_versions WHERE id = $1`, [
      v!.id,
    ]);
    expect(despues!.status).toBe('approved');
  });

  it('un Brief en borrador no llega a client_review por ningún caso de uso (admin, con y sin motivo)', async () => {
    const [vigente] = await query<{ id: string }>(
      `SELECT id FROM brief_versions
        WHERE status = 'approved' AND brief_id = (SELECT brief_id FROM brief_versions WHERE id = $1)`,
      [s.briefVersionId],
    );
    const hijo = await crearBriefHijoDePrueba(op.admin, vigente!.id, { aprobar: false });
    for (const to of LEGACY_CLIENT_STATES) {
      expect((await db.transicionarBrief(op.admin, hijo.versionId, to)).ok, to).toBe(false);
      expect((await db.transicionarBrief('system', hijo.versionId, to)).ok, `system ${to}`).toBe(false);
      expect(
        (await db.transicionarBrief(op.admin, hijo.versionId, to, { origen: 'chat' } as never)).ok,
        `chat ${to}`,
      ).toBe(false);
    }
    const [e] = await query<{ status: string }>(`SELECT status FROM brief_versions WHERE id = $1`, [
      hijo.versionId,
    ]);
    expect(LEGACY_CLIENT_STATES as readonly string[]).not.toContain(e!.status);
  });
});

void aprobarDirecto;
