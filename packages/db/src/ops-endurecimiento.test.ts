/**
 * Endurecimiento de la operación (V2 · Fase 8, FIX-B, migración 033): lo que corrigió el QA adversarial y NO
 * cubre ya `qa-f8-datos.test.ts`. Datos sintéticos; base `_test`.
 *
 *  · CHECK anti-NaN presentes y validados en las cinco columnas de dinero/KPI.
 *  · Un envío devuelto es historia (UPDATE de transportadora rechazado).
 *  · La referencia de PII de un envío es SOLO la versión vigente (también en la base).
 *  · «Entregado» no antes que «enviado» (dominio y base).
 *  · Revalidar producto asignado/comprometido al pasar a `shipped` también en la base.
 *  · La etiqueta de KPI `other` es NFKC en la base.
 *  · Retirar evidencia exige la capacidad del sujeto; la evidencia financiera reutilizada no filtra su nombre.
 *  · La carrera de creación con la misma clave se resuelve con el reintento idéntico, sin sujeto huérfano.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Result } from '@tcl-kol-os/domain';
import { registrarVersionDeAcuerdo } from './agreements.ts';
import { registrarDocumentoDeCobro, reportarPago } from './billing-payment.ts';
import { closePool, query, transaction } from './client.ts';
import {
  CreacionPerdida,
  aplicarEventoOperativo,
  buscarEventoPorClave,
  transaccionOperativa,
} from './operational-events.ts';
import {
  adjuntarEvidenciaOperativa,
  listarEvidenciaDeEvento,
  listarEvidenciaDeSujeto,
  retractarEvidencia,
} from './ops-evidence.ts';
import {
  type EscenarioDeOperacion,
  archivoDePrueba,
  crearAcuerdoPorSql,
  crearEscenarioDeOperacion,
  dia,
  insertar,
  insertarPiiPorSql,
  limpiarEscenarioDeOperacion,
  moverPorSql,
  nuevaParticipacion,
  unico,
} from './ops-test-support.ts';
import { crearEnvio, transicionarEnvio } from './shipments.ts';

let op: EscenarioDeOperacion;
let e: EscenarioDeOperacion['e'];

beforeAll(async () => {
  op = await crearEscenarioDeOperacion('Endurecimiento F8');
  e = op.e;
}, 120_000);

afterAll(async () => {
  await limpiarEscenarioDeOperacion(op);
  await closePool();
});

function exito<T>(r: Result<T>): T {
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message} ${JSON.stringify(r.error.details)}`);
  return r.value;
}

async function rechazo(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
    return '';
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

async function envioAbierto(
  etiqueta: string,
): Promise<{ ci: string; influencerId: string; id: string; rowSeq: number }> {
  const { ci, influencerId } = await nuevaParticipacion(op, etiqueta, [e.productos.p80]);
  const envio = exito(
    await crearEnvio(e.operativo, {
      campaignInfluencerId: ci,
      items: [{ campaignProductId: e.productos.p80, quantity: 1 }],
      idempotencyKey: unico('env'),
    }),
  ).envio;
  return { ci, influencerId, id: envio.id, rowSeq: envio.rowSeq };
}

async function paso(
  envio: { id: string; rowSeq: number },
  x: Omit<Parameters<typeof transicionarEnvio>[1], 'shipmentId' | 'expectedSeq' | 'idempotencyKey'>,
): Promise<void> {
  const r = exito(
    await transicionarEnvio(e.operativo, {
      ...x,
      shipmentId: envio.id,
      expectedSeq: envio.rowSeq,
      idempotencyKey: unico('paso'),
    }),
  ).envio;
  envio.rowSeq = r.rowSeq;
}

describe('033 · NaN: las cinco columnas llevan su CHECK, ya validado', () => {
  it('existen y están validados (convalidated)', async () => {
    const filas = await query<{ conname: string; convalidated: boolean }>(
      `SELECT conname, convalidated FROM pg_constraint
        WHERE conname IN ('agreement_versions_fee_finito', 'shipments_costo_finito',
                          'billing_documents_monto_finito', 'kpi_targets_valor_finito',
                          'kpi_measurements_valor_finito')`,
    );
    expect(filas.map((f) => f.conname).sort()).toEqual([
      'agreement_versions_fee_finito',
      'billing_documents_monto_finito',
      'kpi_measurements_valor_finito',
      'kpi_targets_valor_finito',
      'shipments_costo_finito',
    ]);
    expect(filas.every((f) => f.convalidated)).toBe(true);
  });

  it('un monto reclamado NaN en un documento de cobro se rechaza en la base', async () => {
    const { ci } = await nuevaParticipacion(op, 'NaNCobro');
    const a = await crearAcuerdoPorSql(op, { ci, mode: 'fee' });
    const doc = exito(
      await registrarDocumentoDeCobro(e.operativo, {
        paymentObligationId: a.obligationId,
        documentNumber: unico('N'),
        issuedOn: dia(1),
        claimedAmount: 10,
        claimedCurrency: 'COP',
        archivo: archivoDePrueba(),
        idempotencyKey: unico('nan'),
      }),
    ).documento;
    const mensaje = await rechazo(() =>
      query(`UPDATE billing_documents SET claimed_amount = 'NaN' WHERE id = $1`, [doc.id]),
    );
    expect(mensaje).not.toBe('');
  });
});

describe('033 · el envío devuelto es historia', () => {
  it('shipped → returned: carrier y tracking_ref ya no cambian por UPDATE', async () => {
    const envio = await envioAbierto('Devuelto');
    await paso(envio, { to: 'prepared' });
    await paso(envio, { to: 'shipped', happenedOn: dia(3), carrier: 'Servientrega', trackingRef: 'G-1' });
    await paso(envio, { to: 'returned', happenedOn: dia(1) });
    for (const sql of [
      `UPDATE shipments SET carrier = 'Otra' WHERE id = $1`,
      `UPDATE shipments SET tracking_ref = 'G-2' WHERE id = $1`,
    ]) {
      expect(await rechazo(() => query(sql, [envio.id])), sql).toMatch(/histórico/);
    }
  });
});

describe('033 · PII: un envío solo se enlaza a la versión VIGENTE', () => {
  it('por SQL directo: la versión 1 se rechaza cuando ya existe la 2; la 2 se acepta', async () => {
    const { ci, influencerId } = await nuevaParticipacion(op, 'PiiVigente', [e.productos.p80]);
    const v1 = await insertarPiiPorSql(op, influencerId);
    const v2 = await insertarPiiPorSql(op, influencerId);
    const insertarEnvio = (pii: string) =>
      transaction(async (c) => {
        const id = await insertar(c, 'shipments', {
          organization_id: e.operativo.organizationId,
          campaign_id: e.campanaId,
          campaign_influencer_id: ci,
          pii_record_id: pii,
          created_by: e.operativo.id,
        });
        await moverPorSql(c, {
          tabla: 'shipments',
          id,
          tipo: 'shipment.created',
          hacia: 'pending',
          por: e.operativo,
        });
      });
    expect(await rechazo(() => insertarEnvio(v1))).toMatch(/versión vigente/);
    expect(await rechazo(() => insertarEnvio(v2))).toBe('');
  });
});

describe('033 · «entregado» no se fecha antes que «enviado»', () => {
  it('el caso de uso responde VALIDATION_FAILED (happenedOn) y la base también lo impone', async () => {
    const envio = await envioAbierto('Fechas');
    await paso(envio, { to: 'prepared' });
    await paso(envio, { to: 'shipped', happenedOn: dia(2) });
    const r = await transicionarEnvio(e.operativo, {
      shipmentId: envio.id,
      to: 'delivered',
      expectedSeq: envio.rowSeq,
      idempotencyKey: unico('d'),
      happenedOn: dia(10),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('VALIDATION_FAILED');
      expect(r.error.details).toMatchObject({ field: 'happenedOn', reason: 'delivered_before_shipped' });
    }
    // La base, aunque se salte el caso de uso.
    const mensaje = await rechazo(() =>
      transaction((c) =>
        moverPorSql(c, {
          tabla: 'shipments',
          id: envio.id,
          tipo: 'shipment.delivered',
          hacia: 'delivered',
          por: e.operativo,
          happenedOn: dia(10),
        }),
      ),
    );
    expect(mensaje).toMatch(/antes del envío/);
    // El mismo día y después sí.
    await paso(envio, { to: 'delivered', happenedOn: dia(2) });
  });
});

describe('033 · shipped revalida producto asignado y comprometido (también en la base)', () => {
  it('por SQL: pasar a shipped con el producto ya no comprometido en la versión vigente se rechaza', async () => {
    const { ci } = await nuevaParticipacion(op, 'Revalida', [e.productos.p80, e.productos.pro]);
    const a = await crearAcuerdoPorSql(op, { ci, mode: 'barter', productos: [[e.productos.p80, 2]] });
    const envio = exito(
      await crearEnvio(e.operativo, {
        campaignInfluencerId: ci,
        items: [{ campaignProductId: e.productos.p80, quantity: 1 }],
        idempotencyKey: unico('env'),
      }),
    ).envio;
    const s = { id: envio.id, rowSeq: envio.rowSeq };
    await paso(s, { to: 'prepared' });
    exito(
      await registrarVersionDeAcuerdo(e.operativo, a.agreementId, {
        compensationType: 'barter',
        commitments: [{ campaignProductId: e.productos.pro, quantity: 1 }],
        changeReason: 'Cambia el producto del canje',
        expectedVersion: 1,
        idempotencyKey: unico('v2'),
      }),
    );
    const mensaje = await rechazo(() =>
      transaction((c) =>
        moverPorSql(c, {
          tabla: 'shipments',
          id: s.id,
          tipo: 'shipment.shipped',
          hacia: 'shipped',
          por: e.operativo,
          happenedOn: dia(1),
        }),
      ),
    );
    expect(mensaje).toMatch(/comprometido/);
  });
});

describe('033 · KPI: la etiqueta `other` es NFKC en la base', () => {
  it('una etiqueta en ancho completo se rechaza por SQL; la equivalente NFKC se acepta', async () => {
    const { ci } = await nuevaParticipacion(op, 'Nfkc');
    const insertar_ = (etiqueta: string) =>
      query(
        `INSERT INTO kpi_targets (organization_id, campaign_id, campaign_influencer_id, metric, other_label, unit,
                                  target_value, created_by, idempotency_key, request_hash)
         VALUES ($1, $2, $3, 'other', $4, 'other', 5, $5, $6, repeat('a', 64))`,
        [e.operativo.organizationId, e.campanaId, ci, etiqueta, e.consultor.id, unico('nfkc')],
      );
    expect(await rechazo(() => insertar_('ｃonversión'))).toMatch(/etiqueta_nfkc|violates check/);
    expect(await rechazo(() => insertar_('conversión'))).toBe('');
  });
});

describe('P2-3 · retirar y listar evidencia con la capacidad del sujeto', () => {
  async function evidenciaDeEnvio(): Promise<{ evidenciaId: string; eventoId: string; envioId: string }> {
    const envio = await envioAbierto('EvEnvio');
    const r = exito(
      await adjuntarEvidenciaOperativa(e.operativo, {
        subjectType: 'shipment',
        subjectId: envio.id,
        expectedSeq: envio.rowSeq,
        idempotencyKey: unico('adj'),
        kind: 'guia',
        archivo: archivoDePrueba(),
      }),
    );
    const [f] = await query<{ id: string }>(`SELECT id FROM operational_evidence WHERE event_id = $1`, [
      r.evento.id,
    ]);
    return { evidenciaId: f!.id, eventoId: r.evento.id, envioId: envio.id };
  }

  it('el director (shipment:manage) retira evidencia de un envío; el consultor (sin ops_evidence:attach) no', async () => {
    const a = await evidenciaDeEnvio();
    const consultor = await retractarEvidencia(e.consultor, a.evidenciaId);
    expect(consultor.ok).toBe(false);
    if (!consultor.ok) expect(consultor.error.code).toBe('FORBIDDEN_ROLE');
    exito(await retractarEvidencia(e.director, a.evidenciaId));
  });

  it('el soporte de un pago reportado solo lo retira quien tiene payment:report (operativo sí, director no)', async () => {
    const { ci } = await nuevaParticipacion(op, 'EvPago');
    const a = await crearAcuerdoPorSql(op, { ci, mode: 'fee' });
    exito(
      await reportarPago(e.operativo, {
        paymentObligationId: a.obligationId,
        expectedSeq: 1,
        idempotencyKey: unico('rep'),
        paidOn: dia(0),
        externalReference: 'REF-END-1',
        evidencia: { archivo: archivoDePrueba(), kind: 'comprobante' },
      }),
    );
    const [ev] = await query<{ id: string }>(
      `SELECT oe.id FROM operational_evidence oe JOIN operational_events x ON x.id = oe.event_id
        WHERE x.payment_obligation_id = $1 AND x.event_type = 'payment.reported'`,
      [a.obligationId],
    );
    const director = await retractarEvidencia(e.director, ev!.id);
    expect(director.ok).toBe(false);
    if (!director.ok) expect(director.error.code).toBe('FORBIDDEN_ROLE');
    exito(await retractarEvidencia(e.operativo, ev!.id));
  });

  it('la evidencia financiera reutilizada por hash oculta nombre y hash a quien solo lee envíos; el dueño la ve', async () => {
    const financiero = 'cuenta_cobro_REUSO_END.pdf';
    const contenido = archivoDePrueba().contenido;
    const { ci } = await nuevaParticipacion(op, 'ReusoEnd', [e.productos.p80]);
    const a = await crearAcuerdoPorSql(op, { ci, mode: 'fee' });
    exito(
      await registrarDocumentoDeCobro(e.operativo, {
        paymentObligationId: a.obligationId,
        documentNumber: unico('RE'),
        issuedOn: dia(1),
        claimedAmount: 1_000,
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
    const adj = exito(
      await adjuntarEvidenciaOperativa(e.operativo, {
        subjectType: 'shipment',
        subjectId: envio.id,
        expectedSeq: envio.rowSeq,
        idempotencyKey: unico('adj'),
        kind: 'guia',
        archivo: { filename: 'guia.pdf', contenido },
      }),
    );
    const delConsultor = exito(
      await listarEvidenciaDeSujeto(e.consultor, { subjectType: 'shipment', subjectId: envio.id }),
    );
    expect(delConsultor).toHaveLength(1);
    expect(delConsultor[0]!.filename).not.toContain('REUSO_END');
    expect(delConsultor[0]!.hash).toBeNull();
    const porEvento = exito(await listarEvidenciaDeEvento(e.consultor, adj.evento.id));
    expect(porEvento[0]!.filename).not.toContain('REUSO_END');
    // quien tiene finance:read la ve completa
    const delOperativo = exito(
      await listarEvidenciaDeSujeto(e.operativo, { subjectType: 'shipment', subjectId: envio.id }),
    );
    expect(delOperativo[0]!.filename).toBe(financiero);
    expect(delOperativo[0]!.hash).not.toBeNull();
  });
});

describe('P2-6 · la carrera de creación con la misma clave se resuelve con el reintento idéntico', () => {
  it('la perdedora se revierte (sin sujeto huérfano) y la segunda vuelta devuelve el evento de la ganadora', async () => {
    const { ci } = await nuevaParticipacion(op, 'Carrera', [e.productos.p80]);
    const clave = unico('carrera');
    const huellaExtra = { campaignInfluencerId: ci, tag: 'carrera-end' };
    const solicitud = (id: string) => ({
      actor: e.operativo,
      action: 'shipment:manage' as const,
      sujeto: { tipo: 'shipment' as const, id },
      eventType: 'shipment.created' as const,
      toStatus: 'pending',
      expectedSeq: 0,
      idempotencyKey: clave,
      huellaExtra,
    });
    const nuevoEnvio = (c: Parameters<typeof insertar>[0]) =>
      insertar(c, 'shipments', {
        organization_id: e.operativo.organizationId,
        campaign_id: e.campanaId,
        campaign_influencer_id: ci,
        created_by: e.operativo.id,
      });

    let vueltas = 0;
    const r = await transaccionOperativa(async (c) => {
      vueltas++;
      const previo = await buscarEventoPorClave(c, e.operativo.organizationId, clave);
      if (previo !== undefined) return { repetido: true, eventoId: previo.id };
      const id = await nuevoEnvio(c);
      if (vueltas === 1) {
        // La ganadora confirma ANTES de que esta transacción aplique su evento.
        await transaction(async (w) => {
          const ganadora = await nuevoEnvio(w);
          await aplicarEventoOperativo(w, solicitud(ganadora));
        });
      }
      const a = await aplicarEventoOperativo(c, solicitud(id));
      return { repetido: a.repetido, eventoId: a.evento.id };
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.repetido).toBe(true);
    expect(vueltas).toBe(2);
    const [n] = await query<{ n: string }>(
      `SELECT count(*) AS n FROM shipments WHERE campaign_influencer_id = $1`,
      [ci],
    );
    expect(Number(n!.n)).toBe(1);
  });

  it('CreacionPerdida es un error propio (no un conflicto de commit)', () => {
    const x = new CreacionPerdida('evento-1');
    expect(x).toBeInstanceOf(Error);
    expect(x.eventoId).toBe('evento-1');
  });
});
