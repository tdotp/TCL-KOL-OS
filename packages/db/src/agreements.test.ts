/**
 * V2 · Fase 8 (W1d) — acuerdos con el KOL: fee, barter y mixed; barter ⇒ obligación `not_applicable` (sin pago);
 * versiones inmutables con historial; ajuste de la obligación al cambiar de modo; permisos por rol y proyección
 * SIN dinero para quien no tiene `finance:read`; aislamiento por organización; auditoría sin montos ni
 * condiciones; idempotencia y cancelación.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Result, User } from '@tcl-kol-os/domain';
import {
  cancelarAcuerdo,
  crearAcuerdo,
  listarVersionesDeAcuerdo,
  obtenerAcuerdo,
  registrarVersionDeAcuerdo,
} from './agreements.ts';
import { asociarInfluencerACampana, asociarProductoAInfluencer } from './campaign-influencers.ts';
import { anularDocumento, registrarDocumentoDeCobro, reportarPago } from './billing-payment.ts';
import { closePool, query } from './client.ts';
import { crearInfluencer } from './influencers.ts';
import { listarEventosOperativos } from './operational-events.ts';
import { archivoDePrueba, auditoriaDeSujeto, dia, fila } from './ops-test-support.ts';
import {
  type EscenarioDeOperacion,
  claveDePrueba as clave,
  crearEscenarioDeOperacion,
  limpiarEscenarioDeOperacion,
} from './test-utils.ts';

let op: EscenarioDeOperacion;
let sufijoDeParticipantes = 0;

beforeAll(async () => {
  op = await crearEscenarioDeOperacion('F8 acuerdos');
});

afterAll(async () => {
  await limpiarEscenarioDeOperacion(op);
  await closePool();
});

const MONTO = 987654.32;
const CONDICIONES = 'SENTINELA-CONDICIONES-exclusividad-7731';
const MOTIVO = 'SENTINELA-MOTIVO-ajuste-4410';
const CANCELACION = 'SENTINELA-CANCELA-razon-9902';

function exito<T>(r: Result<T>): T {
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message} ${JSON.stringify(r.error.details)}`);
  return r.value;
}
const codigo = <T>(r: Result<T>): string => (r.ok ? 'OK' : r.error.code);
const razon = <T>(r: Result<T>): unknown =>
  r.ok ? undefined : (r.error.details as { reason?: unknown } | undefined)?.reason;

/** Participación nueva (persona + participación + productos asignados) en la campaña activa. */
async function participacion(productos: readonly string[] = []): Promise<string> {
  const creado = exito(
    await crearInfluencer(op.admin, {
      displayName: `Acuerdo Prueba ${++sufijoDeParticipantes}`,
      cuentas: [
        {
          platform: 'instagram',
          handle: `acuerdo.${sufijoDeParticipantes}.${op.sufijo}.${Date.now().toString(36)}`,
        },
      ],
    }),
  );
  op.influencerIds.push(creado.influencer.id);
  const ci = exito(
    await asociarInfluencerACampana(op.admin, {
      campaignId: op.campanaId,
      influencerId: creado.influencer.id,
    }),
  ).id;
  for (const p of productos) {
    exito(await asociarProductoAInfluencer(op.admin, { campaignInfluencerId: ci, campaignProductId: p }));
  }
  return ci;
}

async function nuevoAcuerdo(
  mode: 'fee' | 'barter' | 'mixed',
  extra: { readonly actor?: User; readonly conditions?: string; readonly amount?: number } = {},
) {
  const productos = mode === 'fee' ? [] : [op.productos.p80];
  const ci = await participacion(productos);
  const r = exito(
    await crearAcuerdo(extra.actor ?? op.operativo, {
      campaignInfluencerId: ci,
      compensationType: mode,
      ...(mode === 'barter' ? {} : { feeAmount: extra.amount ?? MONTO, feeCurrency: 'COP' }),
      conditions: extra.conditions,
      commitments: mode === 'fee' ? [] : [{ campaignProductId: op.productos.p80, quantity: 3 }],
      idempotencyKey: clave('crear'),
    }),
  );
  return { ci, acuerdo: r.acuerdo, obligationId: r.acuerdo.paymentObligation!.id };
}

async function estadoDeObligacion(agreementId: string) {
  return fila<{ id: string; status: string; row_seq: number }>(
    `SELECT id, status, row_seq FROM payment_obligations WHERE agreement_id = $1`,
    [agreementId],
  );
}

function versionDe(acuerdoId: string, version: number, cambios: Record<string, unknown> = {}) {
  return {
    compensationType: 'fee' as const,
    feeAmount: 2_000_000,
    feeCurrency: 'COP',
    commitments: [] as { campaignProductId: string; quantity: number }[],
    changeReason: MOTIVO,
    expectedVersion: version,
    idempotencyKey: clave(`ver-${acuerdoId.slice(0, 4)}`),
    ...cambios,
  };
}

// ─────────────────────────── crearAcuerdo: los tres modos ──────────────────────

describe('crearAcuerdo', () => {
  it('fee: acuerdo v1 con su obligación pending y el evento de creación', async () => {
    const { acuerdo, obligationId } = await nuevoAcuerdo('fee', { conditions: CONDICIONES });
    expect(acuerdo).toMatchObject({
      status: 'active',
      currentVersion: 1,
      terms: {
        version: 1,
        compensationType: 'fee',
        feeAmount: '987654.32',
        feeCurrency: 'COP',
        conditions: CONDICIONES,
        commitments: [],
        changeReason: null,
      },
      paymentObligation: { id: obligationId, status: 'pending', rowSeq: 1 },
    });
    const eventos = exito(
      await listarEventosOperativos(op.operativo, {
        subjectType: 'payment_obligation',
        subjectId: obligationId,
      }),
    );
    expect(eventos.map((x) => [x.eventType, x.fromStatus, x.toStatus, x.subjectSeq])).toEqual([
      ['payment.applicability_set', null, 'pending', 1],
    ]);
  });

  it('barter: obligación not_applicable (nunca pending) y no se puede reportar un pago', async () => {
    const { acuerdo, obligationId } = await nuevoAcuerdo('barter');
    expect(acuerdo.terms.compensationType).toBe('barter');
    expect(acuerdo.terms.feeAmount).toBeNull();
    expect(acuerdo.terms.feeCurrency).toBeNull();
    expect(acuerdo.terms.commitments).toEqual([
      expect.objectContaining({ campaignProductId: op.productos.p80, quantity: 3 }),
    ]);
    expect(acuerdo.paymentObligation).toMatchObject({ status: 'not_applicable', rowSeq: 1 });

    const reporte = await reportarPago(op.operativo, {
      paymentObligationId: obligationId,
      expectedSeq: 1,
      idempotencyKey: clave('pago'),
      paidOn: dia(1),
      externalReference: 'REF-BARTER',
    });
    expect(codigo(reporte)).toBe('RESOURCE_CONFLICT');
    expect(razon(reporte)).toBe('payment_not_applicable');
    expect((await estadoDeObligacion(acuerdo.id)).status).toBe('not_applicable');

    // La base lo impone también por SQL directo: no hay camino a `pending` sin un evento coherente con barter.
    await expect(
      query(`UPDATE payment_obligations SET status = 'pending' WHERE id = $1`, [obligationId]),
    ).rejects.toThrow();
  });

  it('mixed: tarifa + producto comprometido, obligación pending', async () => {
    const { acuerdo } = await nuevoAcuerdo('mixed');
    expect(acuerdo.terms).toMatchObject({
      compensationType: 'mixed',
      feeAmount: '987654.32',
      feeCurrency: 'COP',
      commitments: [expect.objectContaining({ campaignProductId: op.productos.p80, quantity: 3 })],
    });
    expect(acuerdo.paymentObligation?.status).toBe('pending');
  });

  it('rechaza términos incoherentes sin dejar nada escrito', async () => {
    const ci = await participacion([op.productos.p80]);
    const base = { campaignInfluencerId: ci, idempotencyKey: clave('inv') };
    const prod = { campaignProductId: op.productos.p80, quantity: 1 };
    const casos: Array<[string, Parameters<typeof crearAcuerdo>[1]]> = [
      [
        'barter con monto',
        { ...base, compensationType: 'barter', feeAmount: 10, feeCurrency: 'COP', commitments: [prod] },
      ],
      ['fee sin monto', { ...base, compensationType: 'fee', feeCurrency: 'COP', commitments: [] }],
      [
        'fee con moneda inválida',
        { ...base, compensationType: 'fee', feeAmount: 10, feeCurrency: 'cop', commitments: [] },
      ],
      [
        'fee con producto',
        { ...base, compensationType: 'fee', feeAmount: 10, feeCurrency: 'COP', commitments: [prod] },
      ],
      ['barter sin producto', { ...base, compensationType: 'barter', commitments: [] }],
      [
        'mixed sin producto',
        { ...base, compensationType: 'mixed', feeAmount: 10, feeCurrency: 'COP', commitments: [] },
      ],
      ['monto cero', { ...base, compensationType: 'fee', feeAmount: 0, feeCurrency: 'COP', commitments: [] }],
      [
        'vigencia invertida',
        {
          ...base,
          compensationType: 'fee',
          feeAmount: 5,
          feeCurrency: 'COP',
          startsOn: '2026-12-01',
          endsOn: '2026-11-01',
          commitments: [],
        },
      ],
    ];
    for (const [nombre, entrada] of casos) {
      const r = await crearAcuerdo(op.operativo, entrada);
      expect(codigo(r), nombre).toBe('VALIDATION_FAILED');
    }
    expect(exito(await obtenerAcuerdo(op.operativo, ci))).toBeNull();
  });

  it('los productos deben ser de la campaña y estar asignados a la participación', async () => {
    const ci = await participacion([op.productos.p80]);
    const [p] = await query<{ id: string }>(`SELECT id FROM products WHERE model = 'P80'`);
    const deOtraCampana = (
      await query<{ id: string }>(
        `INSERT INTO campaign_products (campaign_id, product_id, rol, prioridad, participacion_presupuesto)
         VALUES ($1, $2, 'secundario', 1, 0.5) RETURNING id`,
        [op.otraCampanaId, p!.id],
      )
    )[0]!.id;
    const ajeno = await crearAcuerdo(op.operativo, {
      campaignInfluencerId: ci,
      compensationType: 'barter',
      commitments: [{ campaignProductId: deOtraCampana, quantity: 1 }],
      idempotencyKey: clave('otra'),
    });
    expect(codigo(ajeno)).toBe('VALIDATION_FAILED');
    expect(razon(ajeno)).toBe('product_not_in_campaign');

    // `pro` es de la campaña pero está asignado a OTRA participación.
    const noAsignado = await crearAcuerdo(op.operativo, {
      campaignInfluencerId: ci,
      compensationType: 'barter',
      commitments: [{ campaignProductId: op.productos.pro, quantity: 1 }],
      idempotencyKey: clave('noasig'),
    });
    expect(codigo(noAsignado)).toBe('VALIDATION_FAILED');
    expect(razon(noAsignado)).toBe('product_not_assigned');
    expect(exito(await obtenerAcuerdo(op.operativo, ci))).toBeNull();
  });

  it('un acuerdo por participación: el segundo ⇒ agreement_exists con el id', async () => {
    const { ci, acuerdo } = await nuevoAcuerdo('fee');
    const otro = await crearAcuerdo(op.operativo, {
      campaignInfluencerId: ci,
      compensationType: 'fee',
      feeAmount: 1,
      feeCurrency: 'COP',
      commitments: [],
      idempotencyKey: clave('otro'),
    });
    expect(codigo(otro)).toBe('RESOURCE_CONFLICT');
    expect(razon(otro)).toBe('agreement_exists');
    expect(!otro.ok && (otro.error.details as { agreementId?: string }).agreementId).toBe(acuerdo.id);
  });

  it('idempotencia: reintento idéntico ⇒ el mismo acuerdo; otra solicitud con la misma clave ⇒ conflicto', async () => {
    const ci = await participacion();
    const entrada = {
      campaignInfluencerId: ci,
      compensationType: 'fee' as const,
      feeAmount: 750000,
      feeCurrency: 'COP',
      commitments: [],
      idempotencyKey: clave('idem'),
    };
    const a = exito(await crearAcuerdo(op.operativo, entrada));
    const b = exito(await crearAcuerdo(op.operativo, entrada));
    expect(a.repetido).toBe(false);
    expect(b.repetido).toBe(true);
    expect(b.acuerdo.id).toBe(a.acuerdo.id);
    const [n] = await query<{ n: number }>(
      `SELECT (SELECT count(*) FROM agreements WHERE campaign_influencer_id = $1)::int AS n`,
      [ci],
    );
    expect(n!.n).toBe(1);
    const eventos = await query(`SELECT 1 FROM operational_events WHERE payment_obligation_id = $1`, [
      a.acuerdo.paymentObligation!.id,
    ]);
    expect(eventos).toHaveLength(1);

    const distinta = await crearAcuerdo(op.operativo, { ...entrada, feeAmount: 750001 });
    expect(codigo(distinta)).toBe('RESOURCE_CONFLICT');
    expect(razon(distinta)).toBe('idempotency_key_reused');
  });

  it('una campaña archivada o cancelada no admite acuerdos nuevos', async () => {
    const ci = await participacion();
    await query(`UPDATE campaigns SET status = 'archivada' WHERE id = $1`, [op.campanaId]);
    try {
      const r = await crearAcuerdo(op.operativo, {
        campaignInfluencerId: ci,
        compensationType: 'fee',
        feeAmount: 5,
        feeCurrency: 'COP',
        commitments: [],
        idempotencyKey: clave('arch'),
      });
      expect(codigo(r)).toBe('RESOURCE_CONFLICT');
      expect(razon(r)).toBe('campaign_not_active');
    } finally {
      await query(`UPDATE campaigns SET status = 'activa' WHERE id = $1`, [op.campanaId]);
    }
  });
});

// ─────────────────────────── versiones ─────────────────────────────────────────

describe('registrarVersionDeAcuerdo', () => {
  it('registra la v2 con motivo y deja la v1 intacta (historial inmutable)', async () => {
    const { acuerdo } = await nuevoAcuerdo('fee', { conditions: CONDICIONES });
    const r = exito(
      await registrarVersionDeAcuerdo(
        op.director,
        acuerdo.id,
        versionDe(acuerdo.id, 1, {
          feeAmount: 2_000_000,
          conditions: 'Condiciones nuevas',
          startsOn: '2026-11-01',
          endsOn: '2026-12-01',
        }),
      ),
    );
    expect(r.repetido).toBe(false);
    expect(r.obligacionAjustada).toBe(false);
    expect(r.acuerdo).toMatchObject({
      currentVersion: 2,
      terms: {
        version: 2,
        feeAmount: '2000000.00',
        changeReason: MOTIVO,
        startsOn: '2026-11-01',
        endsOn: '2026-12-01',
      },
      paymentObligation: { status: 'pending', rowSeq: 1 },
    });
    const historial = exito(await listarVersionesDeAcuerdo(op.operativo, acuerdo.id));
    expect(historial.map((v) => [v.version, v.feeAmount, v.conditions, v.changeReason])).toEqual([
      [1, '987654.32', CONDICIONES, null],
      [2, '2000000.00', 'Condiciones nuevas', MOTIVO],
    ]);
    expect(historial[1]!.createdBy).toBe(op.director.id);

    // Inmutables incluso por SQL directo.
    await expect(
      query(`UPDATE agreement_versions SET fee_amount = 1 WHERE agreement_id = $1 AND version = 1`, [
        acuerdo.id,
      ]),
    ).rejects.toThrow();
    await expect(
      query(`UPDATE agreement_product_commitments SET quantity = 9 WHERE campaign_id = $1`, [op.campanaId]),
    ).rejects.toThrow();
  });

  it('exige el motivo del cambio y la versión vigente (stale_version)', async () => {
    const { acuerdo } = await nuevoAcuerdo('fee');
    const sinMotivo = await registrarVersionDeAcuerdo(
      op.operativo,
      acuerdo.id,
      versionDe(acuerdo.id, 1, { changeReason: '  ' }),
    );
    expect(codigo(sinMotivo)).toBe('VALIDATION_FAILED');

    exito(await registrarVersionDeAcuerdo(op.operativo, acuerdo.id, versionDe(acuerdo.id, 1)));
    const vieja = await registrarVersionDeAcuerdo(
      op.operativo,
      acuerdo.id,
      versionDe(acuerdo.id, 1, { feeAmount: 3_000_000 }),
    );
    expect(codigo(vieja)).toBe('RESOURCE_CONFLICT');
    expect(razon(vieja)).toBe('stale_version');
    expect(exito(await listarVersionesDeAcuerdo(op.operativo, acuerdo.id))).toHaveLength(2);
  });

  it('reintento idéntico (misma persona, misma versión esperada) ⇒ la versión ya registrada', async () => {
    const { acuerdo } = await nuevoAcuerdo('fee');
    const entrada = versionDe(acuerdo.id, 1);
    const a = exito(await registrarVersionDeAcuerdo(op.operativo, acuerdo.id, entrada));
    const b = exito(await registrarVersionDeAcuerdo(op.operativo, acuerdo.id, entrada));
    expect(a.repetido).toBe(false);
    expect(b.repetido).toBe(true);
    expect(b.acuerdo.currentVersion).toBe(2);
    expect(exito(await listarVersionesDeAcuerdo(op.operativo, acuerdo.id))).toHaveLength(2);
    // Otra persona con la misma versión esperada y el mismo contenido NO es un reintento.
    const otra = await registrarVersionDeAcuerdo(op.director, acuerdo.id, entrada);
    expect(razon(otra)).toBe('stale_version');
  });

  it('barter → fee: la obligación pasa not_applicable → pending en la misma transacción', async () => {
    const { acuerdo } = await nuevoAcuerdo('barter');
    expect(acuerdo.paymentObligation?.status).toBe('not_applicable');
    const r = exito(
      await registrarVersionDeAcuerdo(
        op.operativo,
        acuerdo.id,
        versionDe(acuerdo.id, 1, {
          compensationType: 'mixed',
          commitments: [{ campaignProductId: op.productos.p80, quantity: 1 }],
        }),
      ),
    );
    expect(r.obligacionAjustada).toBe(true);
    expect(r.acuerdo.paymentObligation).toMatchObject({ status: 'pending', rowSeq: 2 });
    const eventos = exito(
      await listarEventosOperativos(op.operativo, {
        subjectType: 'payment_obligation',
        subjectId: acuerdo.paymentObligation!.id,
      }),
    );
    expect(eventos.map((x) => [x.eventType, x.fromStatus, x.toStatus])).toEqual([
      ['payment.applicability_set', null, 'not_applicable'],
      ['payment.applicability_set', 'not_applicable', 'pending'],
    ]);
  });

  it('fee → barter: pending → not_applicable solo sin documentos de cobro vivos', async () => {
    const { acuerdo, obligationId } = await nuevoAcuerdo('fee');
    const doc = exito(
      await registrarDocumentoDeCobro(op.operativo, {
        paymentObligationId: obligationId,
        documentNumber: 'DOC-1',
        issuedOn: dia(2),
        claimedAmount: 1000,
        claimedCurrency: 'COP',
        archivo: archivoDePrueba(),
        idempotencyKey: clave('doc'),
      }),
    );
    expect(doc.documento.status).toBe('registered');
    const aBarter = versionDe(acuerdo.id, 1, {
      compensationType: 'barter',
      feeAmount: undefined,
      feeCurrency: undefined,
      commitments: [{ campaignProductId: op.productos.p80, quantity: 1 }],
    });
    // La participación no tiene el P80 asignado: se asigna para poder comprometerlo.
    const ci = acuerdo.campaignInfluencerId;
    exito(
      await asociarProductoAInfluencer(op.admin, {
        campaignInfluencerId: ci,
        campaignProductId: op.productos.p80,
      }),
    );
    const bloqueada = await registrarVersionDeAcuerdo(op.operativo, acuerdo.id, aBarter);
    expect(codigo(bloqueada)).toBe('RESOURCE_CONFLICT');
    expect(razon(bloqueada)).toBe('live_documents');
    expect(exito(await listarVersionesDeAcuerdo(op.operativo, acuerdo.id))).toHaveLength(1);

    // Sin documentos vivos (anulado) sí se puede.
    exito(
      await anularDocumento(op.operativo, {
        billingDocumentId: doc.documento.id,
        expectedSeq: 1,
        idempotencyKey: clave('anular'),
      }),
    );
    const r = exito(
      await registrarVersionDeAcuerdo(op.operativo, acuerdo.id, { ...aBarter, idempotencyKey: clave('b') }),
    );
    expect(r.obligacionAjustada).toBe(true);
    expect(r.acuerdo.paymentObligation?.status).toBe('not_applicable');
    expect(r.acuerdo.terms.feeAmount).toBeNull();
  });

  it('con el pago reportado, un cambio de modo/monto/moneda se rechaza; vigencia y condiciones sí', async () => {
    const { acuerdo, obligationId } = await nuevoAcuerdo('fee');
    exito(
      await reportarPago(op.operativo, {
        paymentObligationId: obligationId,
        expectedSeq: 1,
        idempotencyKey: clave('pago'),
        paidOn: dia(1),
        externalReference: 'REF-1',
      }),
    );
    for (const cambio of [
      { feeAmount: 5_000_000 },
      { feeCurrency: 'USD' },
      {
        compensationType: 'barter',
        feeAmount: undefined,
        feeCurrency: undefined,
        commitments: [{ campaignProductId: op.productos.p80, quantity: 1 }],
      },
    ]) {
      const r = await registrarVersionDeAcuerdo(
        op.operativo,
        acuerdo.id,
        versionDe(acuerdo.id, 1, { feeAmount: MONTO, ...cambio }),
      );
      expect(codigo(r)).toBe('RESOURCE_CONFLICT');
      expect(razon(r)).toBe('payment_reported');
    }
    const ok = exito(
      await registrarVersionDeAcuerdo(
        op.operativo,
        acuerdo.id,
        versionDe(acuerdo.id, 1, { feeAmount: MONTO, conditions: 'Solo condiciones', endsOn: '2027-01-31' }),
      ),
    );
    expect(ok.acuerdo.currentVersion).toBe(2);
    expect(ok.acuerdo.paymentObligation?.status).toBe('reported_paid');
  });

  it('un acuerdo ajeno o inexistente ⇒ RESOURCE_NOT_FOUND; un rol sin agreement:manage ⇒ FORBIDDEN_ROLE', async () => {
    const { acuerdo } = await nuevoAcuerdo('fee');
    expect(codigo(await registrarVersionDeAcuerdo(op.ajeno, acuerdo.id, versionDe(acuerdo.id, 1)))).toBe(
      'RESOURCE_NOT_FOUND',
    );
    expect(codigo(await registrarVersionDeAcuerdo(op.cliente, acuerdo.id, versionDe(acuerdo.id, 1)))).toBe(
      'RESOURCE_NOT_FOUND',
    );
    expect(
      codigo(
        await registrarVersionDeAcuerdo(
          op.operativo,
          '00000000-0000-4000-8000-000000000000',
          versionDe(acuerdo.id, 1),
        ),
      ),
    ).toBe('RESOURCE_NOT_FOUND');
    for (const u of [op.consultor, op.analista, op.legal]) {
      expect(codigo(await registrarVersionDeAcuerdo(u, acuerdo.id, versionDe(acuerdo.id, 1)))).toBe(
        'FORBIDDEN_ROLE',
      );
    }
  });
});

// ─────────────────────────── permisos, origen y proyección ─────────────────────

describe('permisos y origen', () => {
  it('escribir exige agreement:manage: admin, director y operativo sí; consultor, analista y legal no', async () => {
    for (const u of [op.admin, op.director, op.operativo]) {
      const ci = await participacion();
      const r = await crearAcuerdo(u, {
        campaignInfluencerId: ci,
        compensationType: 'fee',
        feeAmount: 100,
        feeCurrency: 'COP',
        commitments: [],
        idempotencyKey: clave(`rol-${u.role}`),
      });
      expect(codigo(r), u.role).toBe('OK');
    }
    const ci = await participacion();
    for (const u of [op.consultor, op.analista, op.legal]) {
      const r = await crearAcuerdo(u, {
        campaignInfluencerId: ci,
        compensationType: 'fee',
        feeAmount: 100,
        feeCurrency: 'COP',
        commitments: [],
        idempotencyKey: clave(`no-${u.role}`),
      });
      expect(codigo(r), u.role).toBe('FORBIDDEN_ROLE');
    }
    // cliente (TCL) y admin de otra agencia: el recurso «no existe».
    for (const u of [op.cliente, op.ajeno]) {
      const r = await crearAcuerdo(u, {
        campaignInfluencerId: ci,
        compensationType: 'fee',
        feeAmount: 100,
        feeCurrency: 'COP',
        commitments: [],
        idempotencyKey: clave(`aj-${u.role}`),
      });
      expect(codigo(r), u.role).toBe('RESOURCE_NOT_FOUND');
    }
    expect(exito(await obtenerAcuerdo(op.operativo, ci))).toBeNull();
  });

  it('solo una persona por la UI: el chat y el sistema se rechazan antes de tocar la base', async () => {
    const { acuerdo } = await nuevoAcuerdo('fee');
    const ci = await participacion();
    const crear = (actor: User, contexto?: Parameters<typeof crearAcuerdo>[2]) =>
      crearAcuerdo(
        actor,
        {
          campaignInfluencerId: ci,
          compensationType: 'fee',
          feeAmount: 100,
          feeCurrency: 'COP',
          commitments: [],
          idempotencyKey: clave('origen'),
        },
        contexto,
      );
    expect(codigo(await crear(op.admin, { origin: 'chat' }))).toBe('HUMAN_CONFIRMATION_REQUIRED');
    expect(codigo(await crear('system' as unknown as User))).toBe('FORBIDDEN_ROLE');
    expect(codigo(await crear(op.admin, { origin: 'agent' as never }))).toBe('FORBIDDEN_ROLE');
    expect(
      codigo(
        await registrarVersionDeAcuerdo(op.admin, acuerdo.id, versionDe(acuerdo.id, 1), { origin: 'chat' }),
      ),
    ).toBe('HUMAN_CONFIRMATION_REQUIRED');
    expect(
      codigo(
        await cancelarAcuerdo(
          op.admin,
          acuerdo.id,
          { reason: 'x', idempotencyKey: clave('c') },
          { origin: 'chat' },
        ),
      ),
    ).toBe('HUMAN_CONFIRMATION_REQUIRED');
    expect(exito(await obtenerAcuerdo(op.operativo, ci))).toBeNull();
    expect((await estadoDeObligacion(acuerdo.id)).status).toBe('pending');
  });

  it('proyección: el consultor ve modo, vigencia, condiciones y productos, jamás dinero', async () => {
    const { ci, acuerdo } = await nuevoAcuerdo('mixed', { conditions: CONDICIONES });
    exito(
      await registrarVersionDeAcuerdo(
        op.operativo,
        acuerdo.id,
        versionDe(acuerdo.id, 1, {
          compensationType: 'mixed',
          commitments: [{ campaignProductId: op.productos.p80, quantity: 4 }],
          conditions: CONDICIONES,
          startsOn: '2026-11-01',
        }),
      ),
    );
    const vista = exito(await obtenerAcuerdo(op.consultor, ci))!;
    expect(vista).toMatchObject({
      currentVersion: 2,
      status: 'active',
      terms: {
        compensationType: 'mixed',
        startsOn: '2026-11-01',
        conditions: CONDICIONES,
        commitments: [expect.objectContaining({ campaignProductId: op.productos.p80, quantity: 4 })],
      },
    });
    const versiones = exito(await listarVersionesDeAcuerdo(op.consultor, acuerdo.id));
    expect(versiones).toHaveLength(2);
    for (const resultado of [JSON.stringify(vista), JSON.stringify(versiones)]) {
      expect(resultado).not.toMatch(
        /"[a-zA-Z]*(fee|amount|currency|payment|obligation)[a-zA-Z]*"\s*:|987654|2000000|"COP"/i,
      );
    }
    expect('feeAmount' in vista.terms).toBe(false);
    expect('feeCurrency' in vista.terms).toBe(false);
    expect('paymentObligation' in vista).toBe(false);

    // Con finance:read (admin, director, operativo) sí hay dinero y obligación.
    for (const u of [op.admin, op.director, op.operativo]) {
      const v = exito(await obtenerAcuerdo(u, ci))!;
      expect(v.terms.feeAmount, u.role).toBe('2000000.00');
      expect(v.terms.feeCurrency).toBe('COP');
      expect(v.paymentObligation?.status).toBe('pending');
    }
  });

  it('lectura: analista y legal ⇒ FORBIDDEN_ROLE; cliente y ajeno ⇒ RESOURCE_NOT_FOUND', async () => {
    const { ci, acuerdo } = await nuevoAcuerdo('fee');
    for (const u of [op.analista, op.legal]) {
      expect(codigo(await obtenerAcuerdo(u, ci)), u.role).toBe('FORBIDDEN_ROLE');
      expect(codigo(await listarVersionesDeAcuerdo(u, acuerdo.id)), u.role).toBe('FORBIDDEN_ROLE');
    }
    for (const u of [op.cliente, op.ajeno]) {
      expect(codigo(await obtenerAcuerdo(u, ci)), u.role).toBe('RESOURCE_NOT_FOUND');
      expect(codigo(await listarVersionesDeAcuerdo(u, acuerdo.id)), u.role).toBe('RESOURCE_NOT_FOUND');
    }
    expect(codigo(await obtenerAcuerdo(op.operativo, 'no-es-uuid'))).toBe('RESOURCE_NOT_FOUND');
  });
});

// ─────────────────────────── aislamiento por organización ──────────────────────

describe('aislamiento entre organizaciones', () => {
  it('cada agencia solo ve y cambia lo suyo (la ajena ⇒ RESOURCE_NOT_FOUND, también por id de acuerdo)', async () => {
    expect(op.ajena.acuerdoId).toBeDefined();
    const propio = exito(await obtenerAcuerdo(op.ajeno, op.ajena.participacion))!;
    expect(propio.id).toBe(op.ajena.acuerdoId);
    expect(propio.terms.feeAmount).toBe('1500000.00');
    // La agencia principal no ve el acuerdo de la ajena…
    expect(codigo(await obtenerAcuerdo(op.admin, op.ajena.participacion))).toBe('RESOURCE_NOT_FOUND');
    expect(codigo(await listarVersionesDeAcuerdo(op.admin, op.ajena.acuerdoId!))).toBe('RESOURCE_NOT_FOUND');
    expect(
      codigo(
        await cancelarAcuerdo(op.admin, op.ajena.acuerdoId!, {
          reason: 'intento',
          idempotencyKey: clave('x'),
        }),
      ),
    ).toBe('RESOURCE_NOT_FOUND');
    // …ni la ajena ve los de la principal.
    const { ci, acuerdo } = await nuevoAcuerdo('fee');
    expect(codigo(await obtenerAcuerdo(op.ajeno, ci))).toBe('RESOURCE_NOT_FOUND');
    expect(codigo(await listarVersionesDeAcuerdo(op.ajeno, acuerdo.id))).toBe('RESOURCE_NOT_FOUND');
    expect((await estadoDeObligacion(op.ajena.acuerdoId!)).status).toBe('pending');
  });
});

// ─────────────────────────── cancelación ───────────────────────────────────────

describe('cancelarAcuerdo', () => {
  it('fee pending: cancela el acuerdo (con motivo y quién) y su obligación; el historial se conserva', async () => {
    const { acuerdo, obligationId } = await nuevoAcuerdo('fee');
    const r = exito(
      await cancelarAcuerdo(op.director, acuerdo.id, { reason: CANCELACION, idempotencyKey: clave('canc') }),
    );
    expect(r.repetido).toBe(false);
    expect(r.obligacionCancelada).toBe(true);
    expect(r.acuerdo).toMatchObject({
      status: 'cancelled',
      cancelledBy: op.director.id,
      cancelReason: CANCELACION,
      currentVersion: 1,
      paymentObligation: { status: 'cancelled', rowSeq: 2 },
    });
    expect(r.acuerdo.cancelledAt).not.toBeNull();
    const eventos = exito(
      await listarEventosOperativos(op.operativo, {
        subjectType: 'payment_obligation',
        subjectId: obligationId,
      }),
    );
    expect(eventos.map((x) => x.eventType)).toEqual(['payment.applicability_set', 'payment.cancelled']);
    expect(exito(await listarVersionesDeAcuerdo(op.operativo, acuerdo.id))).toHaveLength(1);

    // Cancelado es histórico: sin versiones nuevas ni segunda cancelación; sigue siendo EL acuerdo de la participación.
    const version = await registrarVersionDeAcuerdo(op.operativo, acuerdo.id, versionDe(acuerdo.id, 1));
    expect(razon(version)).toBe('agreement_cancelled');
    const otra = await cancelarAcuerdo(op.operativo, acuerdo.id, {
      reason: 'otra',
      idempotencyKey: clave('c2'),
    });
    expect(razon(otra)).toBe('agreement_cancelled');
    const nuevo = await crearAcuerdo(op.operativo, {
      campaignInfluencerId: acuerdo.campaignInfluencerId,
      compensationType: 'fee',
      feeAmount: 5,
      feeCurrency: 'COP',
      commitments: [],
      idempotencyKey: clave('re'),
    });
    expect(razon(nuevo)).toBe('agreement_exists');
  });

  it('barter: la obligación not_applicable también se cancela; el reintento idéntico es idempotente', async () => {
    const { acuerdo } = await nuevoAcuerdo('barter');
    const entrada = { reason: 'El influencer se retiró', idempotencyKey: clave('cb') };
    const a = exito(await cancelarAcuerdo(op.operativo, acuerdo.id, entrada));
    expect(a.obligacionCancelada).toBe(true);
    expect(a.acuerdo.paymentObligation?.status).toBe('cancelled');
    const b = exito(await cancelarAcuerdo(op.operativo, acuerdo.id, entrada));
    expect(b.repetido).toBe(true);
    expect(b.acuerdo.paymentObligation?.rowSeq).toBe(a.acuerdo.paymentObligation?.rowSeq);
  });

  it('con documentos de cobro vivos o el pago reportado, la obligación no se toca', async () => {
    const vivo = await nuevoAcuerdo('fee');
    exito(
      await registrarDocumentoDeCobro(op.operativo, {
        paymentObligationId: vivo.obligationId,
        documentNumber: 'DOC-V',
        issuedOn: dia(2),
        claimedAmount: 10,
        claimedCurrency: 'COP',
        archivo: archivoDePrueba(),
        idempotencyKey: clave('docv'),
      }),
    );
    const r1 = exito(
      await cancelarAcuerdo(op.operativo, vivo.acuerdo.id, {
        reason: 'Cancelado',
        idempotencyKey: clave('c1'),
      }),
    );
    expect(r1.acuerdo.status).toBe('cancelled');
    expect(r1.obligacionCancelada).toBe(false);
    expect(r1.acuerdo.paymentObligation?.status).toBe('pending');

    const pagado = await nuevoAcuerdo('fee');
    exito(
      await reportarPago(op.operativo, {
        paymentObligationId: pagado.obligationId,
        expectedSeq: 1,
        idempotencyKey: clave('pg'),
        paidOn: dia(1),
        externalReference: 'REF-2',
      }),
    );
    const r2 = exito(
      await cancelarAcuerdo(op.admin, pagado.acuerdo.id, {
        reason: 'Cancelado',
        idempotencyKey: clave('c3'),
      }),
    );
    expect(r2.acuerdo.status).toBe('cancelled');
    expect(r2.obligacionCancelada).toBe(false);
    expect(r2.acuerdo.paymentObligation).toMatchObject({ status: 'reported_paid', rowSeq: 2 });
  });

  it('exige motivo y capacidad', async () => {
    const { acuerdo } = await nuevoAcuerdo('fee');
    expect(
      codigo(await cancelarAcuerdo(op.operativo, acuerdo.id, { reason: '   ', idempotencyKey: clave('m') })),
    ).toBe('VALIDATION_FAILED');
    for (const u of [op.consultor, op.analista, op.legal]) {
      expect(
        codigo(await cancelarAcuerdo(u, acuerdo.id, { reason: 'x', idempotencyKey: clave('p') })),
        u.role,
      ).toBe('FORBIDDEN_ROLE');
    }
    expect((await obtenerAcuerdoEstado(acuerdo.id)).status).toBe('active');
  });
});

async function obtenerAcuerdoEstado(id: string) {
  return fila<{ status: string }>(`SELECT status FROM agreements WHERE id = $1`, [id]);
}

// ─────────────────────────── auditoría ─────────────────────────────────────────

describe('auditoría', () => {
  it('registra agreement.* con ids, versión, modo y estado: jamás montos, condiciones ni motivos', async () => {
    const { acuerdo } = await nuevoAcuerdo('mixed', { conditions: CONDICIONES });
    exito(
      await registrarVersionDeAcuerdo(
        op.operativo,
        acuerdo.id,
        versionDe(acuerdo.id, 1, {
          compensationType: 'mixed',
          feeAmount: MONTO,
          commitments: [{ campaignProductId: op.productos.p80, quantity: 1 }],
          conditions: CONDICIONES,
        }),
      ),
    );
    exito(
      await cancelarAcuerdo(op.operativo, acuerdo.id, { reason: CANCELACION, idempotencyKey: clave('ca') }),
    );

    const delAcuerdo = await auditoriaDeSujeto(acuerdo.id);
    expect(delAcuerdo.map((a) => a.action)).toEqual([
      'agreement.created',
      'agreement.version_registered',
      'agreement.cancelled',
    ]);
    expect(delAcuerdo[0]!.metadata).toMatchObject({
      agreementId: acuerdo.id,
      campaignId: op.campanaId,
      version: 1,
      compensationType: 'mixed',
      status: 'active',
    });
    expect(delAcuerdo[1]!.metadata).toMatchObject({ version: 2, compensationType: 'mixed' });
    expect(delAcuerdo[2]!.metadata).toMatchObject({ status: 'cancelled' });
    const delPago = await auditoriaDeSujeto(acuerdo.paymentObligation!.id);
    expect(delPago.map((a) => a.action)).toEqual(['payment.applicability_set', 'payment.cancelled']);

    const todo = JSON.stringify([...delAcuerdo, ...delPago]);
    for (const secreto of [
      'SENTINELA',
      '987654',
      '2000000',
      CONDICIONES,
      MOTIVO,
      CANCELACION,
      'feeAmount',
      'fee_amount',
      'conditions',
      'reason',
      '[redactado]',
    ]) {
      expect(todo, secreto).not.toContain(secreto);
    }
  });
});
