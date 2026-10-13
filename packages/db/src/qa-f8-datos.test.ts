/**
 * QA ADVERSARIAL F8 · datos, estados y puertas (V2 · Fase 8). Dos bloques:
 *
 *  A. CORREGIDO (antes `it.fails`): hallazgos CONFIRMADOS por el QA y corregidos en FIX-B (migración 033 y los
 *     casos de uso). Cada uno ejecuta el ataque UNA vez y la ÚNICA aserción que puede fallar es
 *     `expect(ataque.vulnerable).toBe(false)`; así un error de preparación no se confunde con el hallazgo.
 *  B. SEGURO (`it`): lo que se atacó y NO cedió, como regresión permanente.
 *
 * Datos sintéticos. Base `_test`. La limpieza usa el bypass de pruebas de `limpiarEscenarioDeOperacion`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Result, User } from '@tcl-kol-os/domain';
import { PROPOSED_ACTION_SPECS, roleCan, rolPuedeConfirmar, rolPuedeProponer } from '@tcl-kol-os/domain';
import { cancelarAcuerdo, crearAcuerdo, registrarVersionDeAcuerdo } from './agreements.ts';
import {
  anularDocumento,
  cancelarObligacionDePago,
  obtenerSeguimientoDePago,
  registrarDocumentoDeCobro,
  registrarNotaDeCorreccionDePago,
  reportarPago,
  validarDocumento,
} from './billing-payment.ts';
import { closePool, getPool, query, transaction } from './client.ts';
import { adminPool } from './test-admin.ts';
import { corregirMedicionKpi, registrarMedicionKpi } from './kpi-measurements.ts';
import { aplicarEventoOperativo } from './operational-events.ts';
import { registrarKpiObjetivo, retirarKpiObjetivo } from './kpi-targets.ts';
import { listarEvidenciaDeSujeto, retractarEvidencia, adjuntarEvidenciaOperativa } from './ops-evidence.ts';
import {
  type EscenarioDeOperacion,
  archivoDePrueba,
  crearAcuerdoPorSql,
  crearEscenarioDeOperacion,
  dia,
  hashSolicitud,
  insertar,
  limpiarEscenarioDeOperacion,
  moverPorSql,
  nuevaParticipacion,
  unico,
} from './ops-test-support.ts';
import { guardarPii, obtenerPiiResumen, revelarPii } from './pii.ts';
import { crearEnvio, listarEnviosDeParticipacion, transicionarEnvio } from './shipments.ts';

let op: EscenarioDeOperacion;
let e: EscenarioDeOperacion['e'];

beforeAll(async () => {
  op = await crearEscenarioDeOperacion('QA F8 datos');
  e = op.e;
}, 120_000);

afterAll(async () => {
  await limpiarEscenarioDeOperacion(op);
  await closePool();
});

// ─────────────────────────── ayudas ────────────────────────────────────────────

interface Ataque {
  readonly vulnerable: boolean;
  readonly detalle: string;
}

function exito<T>(r: Result<T>): T {
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message} ${JSON.stringify(r.error.details)}`);
  return r.value;
}

/** ¿La operación LANZÓ (500 para la persona) en vez de devolver un `Result`? */
async function lanza(fn: () => Promise<unknown>): Promise<{ lanzo: boolean; mensaje: string }> {
  try {
    await fn();
    return { lanzo: false, mensaje: '' };
  } catch (error) {
    return { lanzo: true, mensaje: error instanceof Error ? error.message : String(error) };
  }
}

/** ¿La base ACEPTÓ el SQL (commit incluido)? */
async function aceptada(fn: () => Promise<unknown>): Promise<boolean> {
  try {
    await fn();
    return true;
  } catch {
    return false;
  }
}

const dosPersonas = async (): Promise<{ ci: string; influencerId: string }> => nuevaParticipacion(op, 'Qa8');

// ═════════════════════════════════════════════════════════════════════════════
// A. CORREGIDO — hallazgos confirmados por el QA
// ═════════════════════════════════════════════════════════════════════════════

describe('CORREGIDO P2 · numeric acepta NaN en las columnas de dinero y KPI (SQL directo)', () => {
  async function ataqueFee(): Promise<Ataque> {
    const { ci } = await dosPersonas();
    const ok = await aceptada(() =>
      transaction(async (c) => {
        const agreementId = await insertar(c, 'agreements', {
          organization_id: e.operativo.organizationId,
          campaign_id: e.campanaId,
          campaign_influencer_id: ci,
          created_by: e.operativo.id,
        });
        await c.query(
          `INSERT INTO agreement_versions (organization_id, campaign_id, agreement_id, compensation_type,
                                           fee_amount, fee_currency, created_by)
           VALUES ($1, $2, $3, 'fee', 'NaN', 'COP', $4)`,
          [e.operativo.organizationId, e.campanaId, agreementId, e.operativo.id],
        );
        const obligacion = await insertar(c, 'payment_obligations', {
          organization_id: e.operativo.organizationId,
          campaign_id: e.campanaId,
          agreement_id: agreementId,
          status: 'pending',
          created_by: e.operativo.id,
        });
        await moverPorSql(c, {
          tabla: 'payment_obligations',
          id: obligacion,
          tipo: 'payment.applicability_set',
          hacia: 'pending',
          por: e.operativo,
        });
      }),
    );
    return { vulnerable: ok, detalle: 'fee_amount = NaN aceptado (NaN > 0 es verdadero en numeric)' };
  }

  it('agreement_versions.fee_amount rechaza NaN', async () => {
    const ataque = await ataqueFee();
    expect(ataque.vulnerable, ataque.detalle).toBe(false);
  });

  it('kpi_measurements.value y kpi_targets.target_value rechazan NaN', async () => {
    const { ci } = await dosPersonas();
    const medicion = await aceptada(() =>
      query(
        `INSERT INTO kpi_measurements (organization_id, campaign_id, campaign_influencer_id, metric, unit, value,
                                       observed_at, recorded_by, idempotency_key, request_hash)
         VALUES ($1, $2, $3, 'views', 'count', 'NaN', now(), $4, $5, $6)`,
        [e.operativo.organizationId, e.campanaId, ci, e.operativo.id, unico('nan'), hashSolicitud()],
      ),
    );
    const objetivo = await aceptada(() =>
      query(
        `INSERT INTO kpi_targets (organization_id, campaign_id, campaign_influencer_id, metric, unit, target_value,
                                  created_by, idempotency_key, request_hash)
         VALUES ($1, $2, $3, 'views', 'count', 'NaN', $4, $5, $6)`,
        [e.operativo.organizationId, e.campanaId, ci, e.consultor.id, unico('nan'), hashSolicitud()],
      ),
    );
    const ataque: Ataque = {
      vulnerable: medicion || objetivo,
      detalle: `medicion=${medicion} objetivo=${objetivo}`,
    };
    expect(ataque.vulnerable, ataque.detalle).toBe(false);
  });

  it('shipments.shipping_cost rechaza NaN', async () => {
    const { ci } = await dosPersonas();
    const ok = await aceptada(() =>
      transaction(async (c) => {
        const id = await insertar(c, 'shipments', {
          organization_id: e.operativo.organizationId,
          campaign_id: e.campanaId,
          campaign_influencer_id: ci,
          shipping_cost: 'NaN',
          shipping_currency: 'COP',
          created_by: e.operativo.id,
        });
        await moverPorSql(c, {
          tabla: 'shipments',
          id,
          tipo: 'shipment.created',
          hacia: 'pending',
          por: e.operativo,
        });
      }),
    );
    const ataque: Ataque = { vulnerable: ok, detalle: 'shipping_cost = NaN aceptado' };
    expect(ataque.vulnerable, ataque.detalle).toBe(false);
  });
});

describe('CORREGIDO P1 · revelarPii y guardarPii aceptan el origen chat (el agente podría leer PII)', () => {
  const CHAT = { origin: 'chat', correlation: { toolInvocationId: 'qa8-tool' } } as const;

  async function influencerDe(ci: string): Promise<string> {
    const [f] = await query<{ influencer_id: string }>(
      `SELECT influencer_id FROM campaign_influencers WHERE id = $1`,
      [ci],
    );
    return f!.influencer_id;
  }

  it('guardarPii con origen chat se rechaza (HUMAN_CONFIRMATION_REQUIRED), como el resto de la operación', async () => {
    const { ci } = await dosPersonas();
    const r = await guardarPii(
      e.operativo,
      { influencerId: await influencerDe(ci), phone: '3005550101' },
      CHAT,
    );
    const ataque: Ataque = {
      vulnerable: r.ok,
      detalle: `guardarPii(chat) => ${r.ok ? 'OK' : r.error.code}`,
    };
    expect(ataque.vulnerable, ataque.detalle).toBe(false);
  });

  it('revelarPii con origen chat NO devuelve el valor en claro', async () => {
    const { ci } = await dosPersonas();
    const guardado = exito(
      await guardarPii(e.operativo, { influencerId: await influencerDe(ci), phone: '3005550102' }),
    );
    const r = await revelarPii(e.operativo, guardado.record.recordId, ['phone'], CHAT);
    const sinTool = await revelarPii(e.operativo, guardado.record.recordId, ['phone'], { origin: 'chat' });
    const ataque: Ataque = {
      vulnerable: r.ok || sinTool.ok,
      detalle: `revelarPii(chat) => ${r.ok ? JSON.stringify(r.value.values) : r.error.code}; sin toolInvocationId => ${sinTool.ok ? 'OK' : sinTool.error.code}`,
    };
    expect(ataque.vulnerable, ataque.detalle).toBe(false);
  });
});

describe('CORREGIDO P2 · un envío preparado sigue adelante con un producto que la versión vigente ya no compromete', () => {
  it('shipped se rechaza si el producto del envío dejó de estar comprometido (canje/mixto)', async () => {
    const { ci } = await nuevaParticipacion(op, 'Canje', [e.productos.p80, e.productos.pro]);
    const a = await crearAcuerdoPorSql(op, { ci, mode: 'barter', productos: [[e.productos.p80, 2]] });
    const envio = exito(
      await crearEnvio(e.operativo, {
        campaignInfluencerId: ci,
        items: [{ campaignProductId: e.productos.p80, quantity: 1 }],
        idempotencyKey: unico('env'),
      }),
    ).envio;
    const preparado = exito(
      await transicionarEnvio(e.operativo, {
        shipmentId: envio.id,
        to: 'prepared',
        expectedSeq: envio.rowSeq,
        idempotencyKey: unico('prep'),
      }),
    ).envio;
    // Versión 2: ya no se compromete p80 (solo pro).
    exito(
      await registrarVersionDeAcuerdo(e.operativo, a.agreementId, {
        compensationType: 'barter',
        commitments: [{ campaignProductId: e.productos.pro, quantity: 1 }],
        changeReason: 'Cambia el producto del canje',
        expectedVersion: 1,
        idempotencyKey: unico('v2'),
      }),
    );
    const enviado = await transicionarEnvio(e.operativo, {
      shipmentId: preparado.id,
      to: 'shipped',
      expectedSeq: preparado.rowSeq,
      idempotencyKey: unico('ship'),
      happenedOn: dia(1),
    });
    const ataque: Ataque = {
      vulnerable: enviado.ok,
      detalle: `shipped con p80 NO comprometido en v2 => ${enviado.ok ? 'OK (se envió)' : enviado.error.code}`,
    };
    expect(ataque.vulnerable, ataque.detalle).toBe(false);
  });
});

describe('CORREGIDO P2 · un rol sin payment:report altera el soporte de un pago ya reportado', () => {
  it('retractarEvidencia del comprobante de un pago reportado exige payment:report', async () => {
    const { ci } = await dosPersonas();
    const a = await crearAcuerdoPorSql(op, { ci, mode: 'fee' });
    const reportado = exito(
      await reportarPago(e.operativo, {
        paymentObligationId: a.obligationId,
        expectedSeq: 1,
        idempotencyKey: unico('rep'),
        paidOn: dia(0),
        externalReference: 'REF-QA8-1',
        evidencia: { archivo: archivoDePrueba(), kind: 'comprobante' },
      }),
    );
    expect(reportado.obligacion.status).toBe('reported_paid');
    const [ev] = await query<{ id: string }>(
      `SELECT oe.id FROM operational_evidence oe JOIN operational_events x ON x.id = oe.event_id
        WHERE x.payment_obligation_id = $1 AND x.event_type = 'payment.reported'`,
      [a.obligationId],
    );
    expect(roleCan(e.director.role, 'payment:report')).toBe(false);
    const r = await retractarEvidencia(e.director, ev!.id);
    const ataque: Ataque = {
      vulnerable: r.ok,
      detalle: `director (sin payment:report) retira el comprobante de un pago reportado => ${r.ok ? 'OK' : r.error.code}`,
    };
    expect(ataque.vulnerable, ataque.detalle).toBe(false);
  });
});

describe('CORREGIDO P2 · doble envío del formulario: la perdedora de la carrera recibe un CONFLICTO en vez del reintento idéntico', () => {
  it('crearEnvio con la misma clave, cuando la ganadora ya confirmó, devuelve ok con repetido=true', async () => {
    const { ci } = await nuevaParticipacion(op, 'Doble', [e.productos.p80]);
    const clave = unico('doble');
    const entrada = {
      campaignInfluencerId: ci,
      items: [{ campaignProductId: e.productos.p80, quantity: 1 }],
      idempotencyKey: clave,
    };
    // Misma `huellaExtra` que arma `crearEnvio`: así la ganadora y la perdedora comparten huella.
    const huellaExtra = {
      campaignInfluencerId: ci,
      items: [{ p: e.productos.p80, q: 1 }],
      carrier: null,
      trackingRef: null,
      shippingCost: null,
      shippingCurrency: null,
      piiRecordId: null,
    };
    // Fija el orden: la perdedora pasa su comprobación de idempotencia, inserta su envío y se detiene en la FK del
    // ítem (el producto está bloqueado); mientras tanto la ganadora confirma su evento con la misma clave.
    const bloqueo = await getPool().connect();
    let perdedora: ReturnType<typeof crearEnvio> | undefined;
    try {
      await bloqueo.query('BEGIN');
      await bloqueo.query(`SELECT id FROM campaign_products WHERE id = $1 FOR UPDATE`, [e.productos.p80]);
      perdedora = crearEnvio(e.operativo, entrada);
      await new Promise((r) => setTimeout(r, 400));
      await transaction(async (c) => {
        const id = await insertar(c, 'shipments', {
          organization_id: e.operativo.organizationId,
          campaign_id: e.campanaId,
          campaign_influencer_id: ci,
          created_by: e.operativo.id,
        });
        await aplicarEventoOperativo(c, {
          actor: e.operativo,
          action: 'shipment:manage',
          sujeto: { tipo: 'shipment', id },
          eventType: 'shipment.created',
          toStatus: 'pending',
          expectedSeq: 0,
          idempotencyKey: clave,
          huellaExtra,
        });
      });
    } finally {
      await bloqueo.query('COMMIT');
      bloqueo.release();
    }
    const r = await perdedora!;
    const [n] = await query<{ n: string }>(
      `SELECT count(*) AS n FROM shipments WHERE campaign_influencer_id = $1`,
      [ci],
    );
    expect(Number(n!.n), 'nunca se duplica el envío').toBe(1);
    const ataque: Ataque = {
      vulnerable: !r.ok,
      detalle: `perdedora => ${r.ok ? `ok repetido=${r.value.repetido}` : `${r.error.code}: ${r.error.message}`}`,
    };
    expect(ataque.vulnerable, ataque.detalle).toBe(false);
  });
});

describe('CORREGIDO P1 · historia: los datos de un envío ya despachado/entregado/cancelado se reescriben por UPDATE, sin evento', () => {
  async function envioHasta(hasta: 'delivered' | 'cancelled'): Promise<{ id: string; rowSeq: number }> {
    const { ci } = await nuevaParticipacion(op, 'Historia', [e.productos.p80]);
    let envio = exito(
      await crearEnvio(e.operativo, {
        campaignInfluencerId: ci,
        items: [{ campaignProductId: e.productos.p80, quantity: 1 }],
        shippingCost: 5000,
        shippingCurrency: 'COP',
        idempotencyKey: unico('h'),
      }),
    ).envio;
    const paso = async (
      x: Omit<Parameters<typeof transicionarEnvio>[1], 'shipmentId' | 'expectedSeq' | 'idempotencyKey'>,
    ) => {
      envio = exito(
        await transicionarEnvio(e.operativo, {
          ...x,
          shipmentId: envio.id,
          expectedSeq: envio.rowSeq,
          idempotencyKey: unico('h'),
        }),
      ).envio;
    };
    if (hasta === 'cancelled') {
      await paso({ to: 'cancelled', cancelReason: 'Motivo original del cancelado' });
    } else {
      await paso({ to: 'prepared' });
      await paso({
        to: 'shipped',
        happenedOn: dia(3),
        carrier: 'Servientrega',
        trackingRef: 'GUIA-ORIGINAL',
      });
      await paso({ to: 'delivered', happenedOn: dia(1) });
    }
    return { id: envio.id, rowSeq: envio.rowSeq };
  }

  it('carrier, tracking_ref y shipping_cost de un envío entregado, y cancel_reason de uno cancelado, no cambian fuera de una transición', async () => {
    const entregado = await envioHasta('delivered');
    const cancelado = await envioHasta('cancelled');
    const antes = await query<{ row_seq: number; last_event_id: string }>(
      `SELECT row_seq, last_event_id FROM shipments WHERE id = $1`,
      [entregado.id],
    );
    const aceptadas: string[] = [];
    for (const [columna, sql, id] of [
      ['tracking_ref', `UPDATE shipments SET tracking_ref = 'GUIA-REESCRITA' WHERE id = $1`, entregado.id],
      ['carrier', `UPDATE shipments SET carrier = 'Otra' WHERE id = $1`, entregado.id],
      ['shipping_cost', `UPDATE shipments SET shipping_cost = 1 WHERE id = $1`, entregado.id],
      [
        'cancel_reason',
        `UPDATE shipments SET cancel_reason = 'Motivo reescrito' WHERE id = $1`,
        cancelado.id,
      ],
    ] as const) {
      if (await aceptada(() => query(sql, [id]))) aceptadas.push(columna);
    }
    const despues = await query<{ row_seq: number; last_event_id: string }>(
      `SELECT row_seq, last_event_id FROM shipments WHERE id = $1`,
      [entregado.id],
    );
    const ataque: Ataque = {
      vulnerable: aceptadas.length > 0,
      detalle: `UPDATE aceptado sobre ${aceptadas.join(', ')}; row_seq ${antes[0]!.row_seq} → ${despues[0]!.row_seq} y last_event_id intacto: no queda rastro`,
    };
    expect(ataque.vulnerable, ataque.detalle).toBe(false);
  });
});

describe('CORREGIDO P3 · robustez: entradas que LANZAN (500) en vez de devolver VALIDATION_FAILED', () => {
  it('NUL (U+0000) en conditions / motivo de cancelación / motivo de versión devuelve un Result', async () => {
    const r1 = await lanza(async () => {
      const { ci } = await dosPersonas();
      return crearAcuerdo(e.operativo, {
        campaignInfluencerId: ci,
        compensationType: 'fee',
        feeAmount: 100,
        feeCurrency: 'COP',
        conditions: 'a\u0000b',
        idempotencyKey: unico('nul'),
      });
    });
    const r2 = await lanza(async () => {
      const { ci } = await dosPersonas();
      const a = await crearAcuerdoPorSql(op, { ci, mode: 'fee' });
      return cancelarAcuerdo(e.operativo, a.agreementId, {
        reason: 'a\u0000b',
        idempotencyKey: unico('nul'),
      });
    });
    const r3 = await lanza(async () => {
      const { ci } = await dosPersonas();
      const a = await crearAcuerdoPorSql(op, { ci, mode: 'fee' });
      return registrarVersionDeAcuerdo(e.operativo, a.agreementId, {
        compensationType: 'fee',
        feeAmount: 200,
        feeCurrency: 'COP',
        changeReason: 'a\u0000b',
        expectedVersion: 1,
        idempotencyKey: unico('nul'),
      });
    });
    const ataque: Ataque = {
      vulnerable: r1.lanzo || r2.lanzo || r3.lanzo,
      detalle: `conditions=${r1.lanzo} cancel=${r2.lanzo} version=${r3.lanzo}: ${r1.mensaje || r2.mensaje || r3.mensaje}`,
    };
    expect(ataque.vulnerable, ataque.detalle).toBe(false);
  });

  it('fecha 0000-01-01 (válida para el validador, fuera de rango para date) devuelve un Result', async () => {
    const { ci } = await nuevaParticipacion(op, 'Fecha', [e.productos.p80]);
    const a = await crearAcuerdoPorSql(op, { ci, mode: 'fee' });
    const intentos = await Promise.all([
      lanza(async () =>
        crearAcuerdo(e.operativo, {
          campaignInfluencerId: (await dosPersonas()).ci,
          compensationType: 'fee',
          feeAmount: 100,
          feeCurrency: 'COP',
          startsOn: '0000-01-01',
          idempotencyKey: unico('f0'),
        }),
      ),
      lanza(() =>
        registrarDocumentoDeCobro(e.operativo, {
          paymentObligationId: a.obligationId,
          documentNumber: unico('D'),
          issuedOn: '0000-01-01',
          claimedAmount: 10,
          claimedCurrency: 'COP',
          archivo: archivoDePrueba(),
          idempotencyKey: unico('f0'),
        }),
      ),
      lanza(() =>
        reportarPago(e.operativo, {
          paymentObligationId: a.obligationId,
          expectedSeq: 1,
          idempotencyKey: unico('f0'),
          paidOn: '0000-01-01',
          externalReference: 'R',
        }),
      ),
      lanza(() =>
        registrarMedicionKpi(e.operativo, {
          campaignInfluencerId: ci,
          metric: 'views',
          value: 1,
          observedAt: '0000-01-01T00:00:00Z',
          idempotencyKey: unico('f0'),
        }),
      ),
    ]);
    const ataque: Ataque = {
      vulnerable: intentos.some((i) => i.lanzo),
      detalle: intentos.map((i) => (i.lanzo ? i.mensaje.slice(0, 60) : 'Result')).join(' | '),
    };
    expect(ataque.vulnerable, ataque.detalle).toBe(false);
  });
});

describe('CORREGIDO P3 · validación de contenido de campos (moneda, bidi, fechas incoherentes)', () => {
  it('una moneda que no existe en ISO 4217 (XXX, ABC) no se acepta como moneda de un acuerdo', async () => {
    const { ci } = await dosPersonas();
    const r = await crearAcuerdo(e.operativo, {
      campaignInfluencerId: ci,
      compensationType: 'fee',
      feeAmount: 100,
      feeCurrency: 'ABC',
      idempotencyKey: unico('mon'),
    });
    const ataque: Ataque = {
      vulnerable: r.ok,
      detalle: `feeCurrency ABC => ${r.ok ? 'OK' : r.error.code}`,
    };
    expect(ataque.vulnerable, ataque.detalle).toBe(false);
  });

  it('caracteres bidi/invisibles (U+202E, U+200B) no entran en conditions, motivos ni claves de idempotencia', async () => {
    const { ci } = await dosPersonas();
    const a = await crearAcuerdo(e.operativo, {
      campaignInfluencerId: ci,
      compensationType: 'fee',
      feeAmount: 100,
      feeCurrency: 'COP',
      conditions: 'pagar ‮odagap‬ antes',
      idempotencyKey: unico('bidi'),
    });
    const k = await crearAcuerdo(e.operativo, {
      campaignInfluencerId: (await dosPersonas()).ci,
      compensationType: 'fee',
      feeAmount: 100,
      feeCurrency: 'COP',
      idempotencyKey: `${unico('bidi')}‮`,
    });
    const ataque: Ataque = { vulnerable: a.ok || k.ok, detalle: `conditions=${a.ok} clave=${k.ok}` };
    expect(ataque.vulnerable, ataque.detalle).toBe(false);
  });

  it('«entregado» no puede fecharse antes que «enviado»; el documento de cobro no se emite en el futuro', async () => {
    const { ci } = await nuevaParticipacion(op, 'Fechas', [e.productos.p80]);
    const envio = exito(
      await crearEnvio(e.operativo, {
        campaignInfluencerId: ci,
        items: [{ campaignProductId: e.productos.p80, quantity: 1 }],
        idempotencyKey: unico('env'),
      }),
    ).envio;
    const p = exito(
      await transicionarEnvio(e.operativo, {
        shipmentId: envio.id,
        to: 'prepared',
        expectedSeq: envio.rowSeq,
        idempotencyKey: unico('p'),
      }),
    ).envio;
    const s = exito(
      await transicionarEnvio(e.operativo, {
        shipmentId: p.id,
        to: 'shipped',
        expectedSeq: p.rowSeq,
        idempotencyKey: unico('s'),
        happenedOn: dia(2),
      }),
    ).envio;
    const d = await transicionarEnvio(e.operativo, {
      shipmentId: s.id,
      to: 'delivered',
      expectedSeq: s.rowSeq,
      idempotencyKey: unico('d'),
      happenedOn: dia(30),
    });
    const a = await crearAcuerdoPorSql(op, { ci: (await dosPersonas()).ci, mode: 'fee' });
    const futuro = await registrarDocumentoDeCobro(e.operativo, {
      paymentObligationId: a.obligationId,
      documentNumber: unico('F'),
      issuedOn: '2999-01-01',
      claimedAmount: 10,
      claimedCurrency: 'COP',
      archivo: archivoDePrueba(),
      idempotencyKey: unico('fut'),
    });
    const ataque: Ataque = {
      vulnerable: d.ok || futuro.ok,
      detalle: `delivered(hace 30 d) tras shipped(hace 2 d)=${d.ok}; issuedOn 2999=${futuro.ok}`,
    };
    expect(ataque.vulnerable, ataque.detalle).toBe(false);
  });
});

describe('CORREGIDO P3 · KPI: etiquetas equivalentes bajo NFKC conviven como objetivos vigentes', () => {
  it('«Conversión» y «ｃonversión» (ancho completo) no pueden ser dos objetivos vigentes del mismo ámbito', async () => {
    const { ci } = await dosPersonas();
    const a = await registrarKpiObjetivo(e.consultor, {
      campaignInfluencerId: ci,
      metric: 'other',
      otherLabel: 'Conversión',
      targetValue: 5,
      idempotencyKey: unico('nfkc'),
    });
    const b = await registrarKpiObjetivo(e.consultor, {
      campaignInfluencerId: ci,
      metric: 'other',
      otherLabel: 'ｃonversión',
      targetValue: 8,
      idempotencyKey: unico('nfkc'),
    });
    const ataque: Ataque = {
      vulnerable: a.ok && b.ok,
      detalle: `NFC=${a.ok ? 'OK' : a.error.code} ancho-completo=${b.ok ? 'OK' : b.error.code} (la comparación del dominio las trata como la misma etiqueta con NFKC)`,
    };
    expect(ataque.vulnerable, ataque.detalle).toBe(false);
  });
});

describe('CORREGIDO P3 · la marca de tiempo de la evidencia se reescribe', () => {
  it('source_documents.created_at de una evidencia operativa no cambia por UPDATE', async () => {
    const { ci } = await nuevaParticipacion(op, 'Marca', [e.productos.p80]);
    const envio = exito(
      await crearEnvio(e.operativo, {
        campaignInfluencerId: ci,
        items: [{ campaignProductId: e.productos.p80, quantity: 1 }],
        idempotencyKey: unico('marca'),
      }),
    ).envio;
    exito(
      await adjuntarEvidenciaOperativa(e.operativo, {
        subjectType: 'shipment',
        subjectId: envio.id,
        expectedSeq: envio.rowSeq,
        idempotencyKey: unico('marca'),
        kind: 'guia',
        archivo: archivoDePrueba(),
      }),
    );
    const [f] = await query<{ id: string }>(
      `SELECT source_document_id AS id FROM operational_evidence WHERE campaign_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [e.campanaId],
    );
    const ok = await aceptada(() =>
      query(`UPDATE source_documents SET created_at = created_at - interval '400 days' WHERE id = $1`, [
        f!.id,
      ]),
    );
    const ataque: Ataque = { vulnerable: ok, detalle: 'created_at de la evidencia retrocedido 400 días' };
    expect(ataque.vulnerable, ataque.detalle).toBe(false);
  });
});

describe('CORREGIDO P3 · PII y evidencia', () => {
  it('un envío nuevo no se enlaza a una versión de PII que ya no es la vigente', async () => {
    const { ci, influencerId } = await dosPersonas();
    const v1 = exito(await guardarPii(e.operativo, { influencerId, address: 'Calle 1 # 2-3 Bogotá' })).record;
    exito(await guardarPii(e.operativo, { influencerId, address: 'Carrera 9 # 8-7 Medellín' }));
    expect((exito(await obtenerPiiResumen(e.operativo, influencerId)) as { version: number }).version).toBe(
      2,
    );
    const r = await crearEnvio(e.operativo, {
      campaignInfluencerId: ci,
      items: [{ campaignProductId: e.productos.p80, quantity: 1 }],
      piiRecordId: v1.recordId,
      idempotencyKey: unico('piiold'),
    });
    const ataque: Ataque = {
      vulnerable: r.ok,
      detalle: `envío enlazado a la versión ${v1.version} (la vigente es la 2) => ${r.ok ? 'OK' : r.error.code}`,
    };
    expect(ataque.vulnerable, ataque.detalle).toBe(false);
  });

  it('la evidencia financiera reutilizada por hash no expone su nombre de archivo a shipment:read (consultor)', async () => {
    const financiero = 'cuenta_cobro_VALENTINA_5millones_QA8.pdf';
    const contenido = archivoDePrueba().contenido;
    const { ci } = await nuevaParticipacion(op, 'Reuso', [e.productos.p80]);
    const a = await crearAcuerdoPorSql(op, { ci, mode: 'fee' });
    exito(
      await registrarDocumentoDeCobro(e.operativo, {
        paymentObligationId: a.obligationId,
        documentNumber: unico('RE'),
        issuedOn: dia(1),
        claimedAmount: 5_000_000,
        claimedCurrency: 'COP',
        archivo: { filename: financiero, contenido },
        idempotencyKey: unico('reuso'),
      }),
    );
    const envio = exito(
      await crearEnvio(e.operativo, {
        campaignInfluencerId: ci,
        items: [{ campaignProductId: e.productos.p80, quantity: 1 }],
        idempotencyKey: unico('env'),
      }),
    ).envio;
    exito(
      await adjuntarEvidenciaOperativa(e.operativo, {
        subjectType: 'shipment',
        subjectId: envio.id,
        expectedSeq: envio.rowSeq,
        idempotencyKey: unico('adj'),
        kind: 'guia',
        archivo: { filename: 'guia.pdf', contenido },
      }),
    );
    const visto = exito(
      await listarEvidenciaDeSujeto(e.consultor, { subjectType: 'shipment', subjectId: envio.id }),
    );
    const ataque: Ataque = {
      vulnerable: visto.some((x) => x.filename === financiero),
      detalle: `consultor lista la evidencia del envío: ${visto.map((x) => x.filename).join(', ')}`,
    };
    expect(ataque.vulnerable, ataque.detalle).toBe(false);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// B. SEGURO — se atacó y no cedió
// ═════════════════════════════════════════════════════════════════════════════

describe('SEGURO · historia: TRUNCATE ... CASCADE desde las tablas PADRE tampoco la borra', () => {
  it('TRUNCATE campaigns | users | organizations | influencers | campaign_influencers | source_documents CASCADE falla (se revierte)', async () => {
    await crearAcuerdoPorSql(op, { ci: (await dosPersonas()).ci, mode: 'fee' });
    for (const padre of [
      'campaigns',
      'users',
      'organizations',
      'influencers',
      'campaign_influencers',
      'source_documents',
    ]) {
      const c = await adminPool().connect(); // capa de triggers: rol privilegiado (el de ejecución no tiene TRUNCATE)
      try {
        await c.query('BEGIN');
        let mensaje = '';
        try {
          await c.query(`TRUNCATE ${padre} CASCADE`);
        } catch (error) {
          mensaje = (error as Error).message;
        }
        await c.query('ROLLBACK');
        expect(mensaje, padre).toMatch(/TRUNCATE|historia|no admite|append-only/i);
      } finally {
        c.release();
      }
    }
    const [n] = await query<{ n: string }>(`SELECT count(*) AS n FROM agreements WHERE campaign_id = $1`, [
      e.campanaId,
    ]);
    expect(Number(n!.n)).toBeGreaterThan(0);
  });

  it('INSERT … ON CONFLICT DO UPDATE no es una puerta de UPDATE sobre eventos, mediciones ni evidencia', async () => {
    const { ci } = await dosPersonas();
    const a = await crearAcuerdoPorSql(op, { ci, mode: 'fee' });
    const [ev] = await query<{ id: string; organization_id: string; idempotency_key: string }>(
      `SELECT id, organization_id, idempotency_key FROM operational_events WHERE payment_obligation_id = $1`,
      [a.obligationId],
    );
    const intento = async (sql: string, params: unknown[]): Promise<string> => {
      try {
        await query(sql, params);
        return 'OK';
      } catch (error) {
        return (error as Error).message;
      }
    };
    const msg = await intento(
      `INSERT INTO operational_events (organization_id, campaign_id, subject_type, payment_obligation_id, event_type,
                                       from_status, to_status, subject_seq, recorded_by, idempotency_key, request_hash, note)
       VALUES ($1, $2, 'payment_obligation', $3, 'payment.cancelled', 'pending', 'cancelled', 2, $4, $5, $6, 'reescrito')
       ON CONFLICT (organization_id, idempotency_key) DO UPDATE SET note = 'reescrito'`,
      [
        ev!.organization_id,
        e.campanaId,
        a.obligationId,
        e.operativo.id,
        ev!.idempotency_key,
        hashSolicitud(),
      ],
    );
    expect(msg).toMatch(/append-only/);
    const [nota] = await query<{ note: string | null }>(`SELECT note FROM operational_events WHERE id = $1`, [
      ev!.id,
    ]);
    expect(nota!.note).toBeNull();
  });
});

describe('SEGURO · ninguna puerta de IA, chat ni sistema registra estado operativo ni KPI real', () => {
  const CHAT = { origin: 'chat', correlation: { toolInvocationId: 'qa8-tool' } } as const;
  const SISTEMA = 'system' as unknown as User;

  async function contar(): Promise<string> {
    const [r] = await query<{ x: string }>(
      `SELECT (SELECT count(*) FROM operational_events WHERE campaign_id = $1)::text || '/' ||
              (SELECT count(*) FROM agreements WHERE campaign_id = $1)::text || '/' ||
              (SELECT count(*) FROM agreement_versions WHERE campaign_id = $1)::text || '/' ||
              (SELECT count(*) FROM kpi_measurements WHERE campaign_id = $1)::text || '/' ||
              (SELECT count(*) FROM operational_evidence WHERE campaign_id = $1)::text AS x`,
      [e.campanaId],
    );
    return r!.x;
  }

  it('chat y sistema: acuerdos, envíos, cobro, pago, corrección, evidencia, medición y corrección de KPI se rechazan sin escribir', async () => {
    const { ci } = await nuevaParticipacion(op, 'Puertas', [e.productos.p80]);
    const fee = await crearAcuerdoPorSql(op, { ci, mode: 'fee' });
    const envio = exito(
      await crearEnvio(e.operativo, {
        campaignInfluencerId: ci,
        items: [{ campaignProductId: e.productos.p80, quantity: 1 }],
        idempotencyKey: unico('env'),
      }),
    ).envio;
    const documento = exito(
      await registrarDocumentoDeCobro(e.operativo, {
        paymentObligationId: fee.obligationId,
        documentNumber: unico('P'),
        issuedOn: dia(1),
        claimedAmount: 10,
        claimedCurrency: 'COP',
        archivo: archivoDePrueba(),
        idempotencyKey: unico('doc'),
      }),
    ).documento;
    const medicion = exito(
      await registrarMedicionKpi(e.operativo, {
        campaignInfluencerId: ci,
        metric: 'views',
        value: 5,
        observedAt: new Date().toISOString(),
        idempotencyKey: unico('m'),
      }),
    ).medicion;
    const objetivo = exito(
      await registrarKpiObjetivo(e.consultor, {
        campaignInfluencerId: ci,
        metric: 'likes',
        targetValue: 10,
        idempotencyKey: unico('t'),
      }),
    ).objetivo;
    const antes = await contar();

    for (const [canal, contexto] of [
      ['chat', CHAT],
      ['sistema', { origin: 'system' } as const],
    ] as const) {
      const actor = (u: User): User => (canal === 'sistema' && u === e.operativo ? u : u);
      const nombre = (n: string): string => `${canal}:${n}`;
      const intentos: Array<[string, Promise<Result<unknown>>]> = [
        [
          nombre('crearAcuerdo'),
          crearAcuerdo(
            actor(e.operativo),
            {
              campaignInfluencerId: (await dosPersonas()).ci,
              compensationType: 'fee',
              feeAmount: 1,
              feeCurrency: 'COP',
              idempotencyKey: unico('x'),
            },
            contexto,
          ),
        ],
        [
          nombre('cancelarAcuerdo'),
          cancelarAcuerdo(
            e.operativo,
            fee.agreementId,
            { reason: 'x', idempotencyKey: unico('x') },
            contexto,
          ),
        ],
        [
          nombre('crearEnvio'),
          crearEnvio(
            e.operativo,
            {
              campaignInfluencerId: ci,
              items: [{ campaignProductId: e.productos.p80, quantity: 1 }],
              idempotencyKey: unico('x'),
            },
            contexto,
          ),
        ],
        [
          nombre('transicionarEnvio'),
          transicionarEnvio(
            e.operativo,
            { shipmentId: envio.id, to: 'prepared', expectedSeq: envio.rowSeq, idempotencyKey: unico('x') },
            contexto,
          ),
        ],
        [
          nombre('registrarDocumentoDeCobro'),
          registrarDocumentoDeCobro(
            e.operativo,
            {
              paymentObligationId: fee.obligationId,
              documentNumber: unico('Z'),
              issuedOn: dia(1),
              claimedAmount: 1,
              claimedCurrency: 'COP',
              archivo: archivoDePrueba(),
              idempotencyKey: unico('x'),
            },
            contexto,
          ),
        ],
        [
          nombre('validarDocumento'),
          validarDocumento(
            e.operativo,
            { billingDocumentId: documento.id, expectedSeq: documento.rowSeq, idempotencyKey: unico('x') },
            contexto,
          ),
        ],
        [
          nombre('anularDocumento'),
          anularDocumento(
            e.operativo,
            { billingDocumentId: documento.id, expectedSeq: documento.rowSeq, idempotencyKey: unico('x') },
            contexto,
          ),
        ],
        [
          nombre('reportarPago'),
          reportarPago(
            e.operativo,
            {
              paymentObligationId: fee.obligationId,
              expectedSeq: 1,
              idempotencyKey: unico('x'),
              paidOn: dia(0),
              externalReference: 'R',
            },
            contexto,
          ),
        ],
        [
          nombre('cancelarObligacion'),
          cancelarObligacionDePago(
            e.operativo,
            { paymentObligationId: fee.obligationId, expectedSeq: 1, idempotencyKey: unico('x') },
            contexto,
          ),
        ],
        [
          nombre('notaDeCorreccion'),
          registrarNotaDeCorreccionDePago(
            e.operativo,
            { paymentObligationId: fee.obligationId, expectedSeq: 1, idempotencyKey: unico('x'), note: 'n' },
            contexto,
          ),
        ],
        [
          nombre('adjuntarEvidencia'),
          adjuntarEvidenciaOperativa(
            e.operativo,
            {
              subjectType: 'shipment',
              subjectId: envio.id,
              expectedSeq: envio.rowSeq,
              idempotencyKey: unico('x'),
              kind: 'guia',
              archivo: archivoDePrueba(),
            },
            contexto,
          ),
        ],
        [
          nombre('registrarMedicion'),
          registrarMedicionKpi(
            e.operativo,
            {
              campaignInfluencerId: ci,
              metric: 'views',
              value: 9,
              observedAt: new Date().toISOString(),
              idempotencyKey: unico('x'),
            },
            contexto,
          ),
        ],
        [
          nombre('corregirMedicion'),
          corregirMedicionKpi(
            e.operativo,
            medicion.id,
            { value: 6, correctionReason: 'x', idempotencyKey: unico('x') },
            contexto,
          ),
        ],
        [nombre('retirarObjetivo'), retirarKpiObjetivo(e.consultor, objetivo.id, contexto)],
      ];
      for (const [n, promesa] of intentos) {
        const r = await promesa;
        expect(r.ok, n).toBe(false);
        if (!r.ok) expect(['HUMAN_CONFIRMATION_REQUIRED', 'FORBIDDEN_ROLE'], n).toContain(r.error.code);
      }
    }
    // Un actor que no es una persona (`'system'` por el borde de tipos) tampoco escribe.
    for (const [n, promesa] of [
      [
        'system:crearAcuerdo',
        crearAcuerdo(SISTEMA, {
          campaignInfluencerId: ci,
          compensationType: 'fee',
          feeAmount: 1,
          feeCurrency: 'COP',
          idempotencyKey: unico('s'),
        }),
      ],
      [
        'system:reportarPago',
        reportarPago(SISTEMA, {
          paymentObligationId: fee.obligationId,
          expectedSeq: 1,
          idempotencyKey: unico('s'),
          paidOn: dia(0),
          externalReference: 'R',
        }),
      ],
      [
        'system:registrarMedicion',
        registrarMedicionKpi(SISTEMA, {
          campaignInfluencerId: ci,
          metric: 'views',
          value: 9,
          observedAt: new Date().toISOString(),
          idempotencyKey: unico('s'),
        }),
      ],
    ] as const) {
      const r = await promesa;
      expect(r.ok, n).toBe(false);
    }
    expect(await contar()).toBe(antes);
  });

  it('chat sin toolInvocationId no fija un objetivo de KPI (solo la herramienta del agente puede)', async () => {
    const { ci } = await dosPersonas();
    const r = await registrarKpiObjetivo(
      e.consultor,
      { campaignInfluencerId: ci, metric: 'views', targetValue: 10, idempotencyKey: unico('t') },
      { origin: 'chat' },
    );
    expect(r.ok).toBe(false);
  });
});

describe('SEGURO · barter jamás termina en pago pendiente', () => {
  it('SQL directo: barter + pending falla al cerrar; UPDATE de la obligación a pending y reported_paid falla', async () => {
    const { ci } = await nuevaParticipacion(op, 'Barter', [e.productos.p80]);
    const a = await crearAcuerdoPorSql(op, { ci, mode: 'barter', productos: [[e.productos.p80, 1]] });
    for (const estado of ['pending', 'reported_paid']) {
      await expect(
        transaction(async (c) => {
          await c.query(`UPDATE payment_obligations SET status = $2 WHERE id = $1`, [a.obligationId, estado]);
        }),
      ).rejects.toThrow();
    }
    // y un evento payment.reported tampoco: la arista exige pending
    const r = await reportarPago(e.operativo, {
      paymentObligationId: a.obligationId,
      expectedSeq: 1,
      idempotencyKey: unico('b'),
      paidOn: dia(0),
      externalReference: 'R',
    });
    expect(r.ok).toBe(false);
    const [o] = await query<{ status: string }>(`SELECT status FROM payment_obligations WHERE id = $1`, [
      a.obligationId,
    ]);
    expect(o!.status).toBe('not_applicable');
  });

  it('mixed → barter con la obligación ya reportada se rechaza; con documentos vivos también', async () => {
    const { ci } = await nuevaParticipacion(op, 'Mixto', [e.productos.p80]);
    const a = await crearAcuerdoPorSql(op, { ci, mode: 'mixed', productos: [[e.productos.p80, 1]] });
    const doc = exito(
      await registrarDocumentoDeCobro(e.operativo, {
        paymentObligationId: a.obligationId,
        documentNumber: unico('M'),
        issuedOn: dia(1),
        claimedAmount: 10,
        claimedCurrency: 'COP',
        archivo: archivoDePrueba(),
        idempotencyKey: unico('doc'),
      }),
    ).documento;
    const vivos = await registrarVersionDeAcuerdo(e.operativo, a.agreementId, {
      compensationType: 'barter',
      commitments: [{ campaignProductId: e.productos.p80, quantity: 1 }],
      changeReason: 'pasa a canje',
      expectedVersion: 1,
      idempotencyKey: unico('v'),
    });
    expect(vivos.ok).toBe(false);
    exito(
      await anularDocumento(e.operativo, {
        billingDocumentId: doc.id,
        expectedSeq: doc.rowSeq,
        idempotencyKey: unico('an'),
      }),
    );
    exito(
      await reportarPago(e.operativo, {
        paymentObligationId: a.obligationId,
        expectedSeq: exito(await obtenerSeguimientoDePago(e.operativo, ci))!.obligation.rowSeq,
        idempotencyKey: unico('rep'),
        paidOn: dia(0),
        externalReference: 'R-QA8',
      }),
    );
    const reportado = await registrarVersionDeAcuerdo(e.operativo, a.agreementId, {
      compensationType: 'barter',
      commitments: [{ campaignProductId: e.productos.p80, quantity: 1 }],
      changeReason: 'pasa a canje',
      expectedVersion: 1,
      idempotencyKey: unico('v'),
    });
    expect(reportado.ok).toBe(false);
  });
});

describe('SEGURO · una misma clave de idempotencia no cruza sujetos ni participaciones', () => {
  it('la clave de un envío no sirve para otro envío distinto ni para un acuerdo (conflicto, nada se duplica)', async () => {
    const { ci: ci1 } = await nuevaParticipacion(op, 'Idem1', [e.productos.p80]);
    const { ci: ci2 } = await nuevaParticipacion(op, 'Idem2', [e.productos.p80]);
    const clave = unico('cruce');
    const a = await crearEnvio(e.operativo, {
      campaignInfluencerId: ci1,
      items: [{ campaignProductId: e.productos.p80, quantity: 1 }],
      idempotencyKey: clave,
    });
    expect(a.ok).toBe(true);
    const b = await crearEnvio(e.operativo, {
      campaignInfluencerId: ci2,
      items: [{ campaignProductId: e.productos.p80, quantity: 1 }],
      idempotencyKey: clave,
    });
    expect(b.ok).toBe(false);
    const c = await crearAcuerdo(e.operativo, {
      campaignInfluencerId: ci2,
      compensationType: 'fee',
      feeAmount: 10,
      feeCurrency: 'COP',
      idempotencyKey: clave,
    });
    expect(c.ok).toBe(false);
    expect(exito(await listarEnviosDeParticipacion(e.operativo, ci2))).toHaveLength(0);
    const replay = await crearEnvio(e.operativo, {
      campaignInfluencerId: ci1,
      items: [{ campaignProductId: e.productos.p80, quantity: 1 }],
      idempotencyKey: clave,
    });
    expect(replay.ok && replay.value.repetido).toBe(true);
  });
});

describe('SEGURO · operativo no aprueba ni revisa contenido', () => {
  it('sin script:approve, brief:approve_internal, brief:transition, script:manage, chat:*; la base lo repite (contenido_exigir_rol)', async () => {
    for (const accion of [
      'script:approve',
      'script:manage',
      'brief:approve_internal',
      'brief:transition',
      'brief:edit',
      'chat:read',
      'chat:write',
      'script:read',
    ] as const) {
      expect(roleCan('operativo', accion), accion).toBe(false);
    }
    for (const capacidad of ['approve', 'manage']) {
      await expect(
        query(`SELECT contenido_exigir_rol($1, $2)`, [e.operativo.id, capacidad]),
      ).rejects.toThrow();
    }
    // El consultor prepara pero no aprueba; el director sí aprueba.
    await expect(query(`SELECT contenido_exigir_rol($1, 'approve')`, [e.consultor.id])).rejects.toThrow();
    await expect(query(`SELECT contenido_exigir_rol($1, 'approve')`, [e.director.id])).resolves.toBeTruthy();
  });

  it('ninguna acción propuesta (HITL) la propone ni la confirma operativo, analista, legal ni cliente; las F8 no existen como acción propuesta', () => {
    for (const spec of Object.values(PROPOSED_ACTION_SPECS)) {
      for (const rol of ['operativo', 'analista', 'legal', 'cliente'] as const) {
        expect(rolPuedeProponer(rol, spec), `${rol} propone ${spec.type}`).toBe(false);
        expect(rolPuedeConfirmar(rol, spec), `${rol} confirma ${spec.type}`).toBe(false);
      }
      expect(spec.type, 'ninguna acción propuesta mueve envíos, cobro, pagos, PII ni evidencia').not.toMatch(
        /^(shipment|payment|billing|agreement|pii|ops_evidence|kpi_measurement)/,
      );
    }
  });
});

describe('SEGURO · evidencia: no cruza campañas, no se expone a TCL ni se reconvierte', () => {
  it('una fuente de evidencia de la campaña A no se vincula a un evento de la campaña B (misma organización); su visibilidad, tipo y campaña no cambian', async () => {
    const { ci } = await nuevaParticipacion(op, 'EvA', [e.productos.p80]);
    const envio = exito(
      await crearEnvio(e.operativo, {
        campaignInfluencerId: ci,
        items: [{ campaignProductId: e.productos.p80, quantity: 1 }],
        idempotencyKey: unico('evA'),
      }),
    ).envio;
    exito(
      await adjuntarEvidenciaOperativa(e.operativo, {
        subjectType: 'shipment',
        subjectId: envio.id,
        expectedSeq: envio.rowSeq,
        idempotencyKey: unico('adj'),
        kind: 'guia',
        archivo: archivoDePrueba(),
      }),
    );
    const [fuente] = await query<{ source_document_id: string }>(
      `SELECT source_document_id FROM operational_evidence WHERE campaign_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [e.campanaId],
    );
    const fuenteId = fuente!.source_document_id;

    // Evento en OTRA campaña de la misma agencia (SQL directo) y vínculo a la fuente de la campaña A.
    const { ci: ciB } = await nuevaParticipacion(op, 'EvB', [], e.otraCampanaId);
    const rechazo = async (fn: () => Promise<unknown>): Promise<string> => {
      try {
        await fn();
        return 'ACEPTADO';
      } catch (error) {
        return (error as Error).message;
      }
    };
    const vinculo = await rechazo(() =>
      transaction(async (c) => {
        const envioB = await insertar(c, 'shipments', {
          organization_id: e.operativo.organizationId,
          campaign_id: e.otraCampanaId,
          campaign_influencer_id: ciB,
          created_by: e.operativo.id,
        });
        const evento = await moverPorSql(c, {
          tabla: 'shipments',
          id: envioB,
          tipo: 'shipment.created',
          hacia: 'pending',
          por: e.operativo,
        });
        await insertar(c, 'operational_evidence', {
          organization_id: e.operativo.organizationId,
          campaign_id: e.otraCampanaId,
          event_id: evento,
          source_document_id: fuenteId,
          kind: 'guia',
          attached_by: e.operativo.id,
        });
      }),
    );
    expect(vinculo).not.toBe('ACEPTADO');

    for (const sql of [
      `UPDATE source_documents SET visibility = 'tcl' WHERE id = $1`,
      `UPDATE source_documents SET visibility = 'compartida' WHERE id = $1`,
      `UPDATE source_documents SET confidentiality_level = 'interna' WHERE id = $1`,
      `UPDATE source_documents SET type = 'ficha_tecnica' WHERE id = $1`,
      `UPDATE source_documents SET status = 'pendiente' WHERE id = $1`,
      `UPDATE source_documents SET filename = 'otro.pdf' WHERE id = $1`,
      `UPDATE source_documents SET hash = repeat('a', 64) WHERE id = $1`,
    ]) {
      expect(await rechazo(() => query(sql, [fuenteId])), sql).not.toBe('ACEPTADO');
    }
    expect(
      await rechazo(() =>
        query(`UPDATE source_documents SET campaign_id = $2 WHERE id = $1`, [fuenteId, e.otraCampanaId]),
      ),
    ).not.toBe('ACEPTADO');
    const [estado] = await query<{ visibility: string; type: string; confidentiality_level: string }>(
      `SELECT visibility::text AS visibility, type::text AS type, confidentiality_level::text AS confidentiality_level FROM source_documents WHERE id = $1`,
      [fuenteId],
    );
    expect(estado).toEqual({
      visibility: 'interna',
      type: 'soporte_operativo',
      confidentiality_level: 'sensible',
    });
  });
});
