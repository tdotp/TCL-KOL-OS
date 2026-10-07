/**
 * V2 · Fase 8 (W2b) — read models del Operativo: matriz rol × sección, dinero solo con finance:read, jamás PII
 * (ni guía, notas, referencias ni nombres de evidencia), barter ⇒ pago no aplicable, mixto con logística y pago
 * independientes, consultas por lotes (sin N+1), aislamiento por organización y hook de KPI inyectable.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Result, User } from '@tcl-kol-os/domain';
import {
  crearAcuerdoDePrueba,
  crearEscenarioDeOperacion,
  limpiarEscenarioDeOperacion,
} from './test-utils.ts';
import type { EscenarioDeOperacion } from './test-utils.ts';
import { archivoDePrueba, dia, unico } from './ops-test-support.ts';
import {
  asociarInfluencerACampana,
  asociarProductoAInfluencer,
  retirarInfluencerDeCampana,
} from './campaign-influencers.ts';
import { crearInfluencer } from './influencers.ts';
import { closePool, getPool, query } from './client.ts';
import { guardarPii } from './pii.ts';
import { crearEnvio, transicionarEnvio } from './shipments.ts';
import {
  obtenerSeguimientoDePago,
  registrarDocumentoDeCobro,
  reportarPago,
  validarDocumento,
} from './billing-payment.ts';
import {
  type EstadoOperativoDeParticipacion,
  type ResumenOperativoDeCampana,
  obtenerEstadoOperativoDeParticipacion,
  obtenerResumenOperativoDeCampana,
} from './operativo-views.ts';

// Datos centinela sintéticos: NINGUNO debe aparecer fuera de lo que su capacidad permite.
const FEE = 9876543;
const COSTO_ENVIO = 7654321;
const COBRO = 5432198;
const CEDULA = String(1_000_000_000 + Math.floor(Math.random() * 8_000_000_000));
const TELEFONO = '3001112233';
const DIRECCION = 'Calle 99 # 88-77 Apto SENT';
const GUIA = 'GUIA-SENT-777';
const TRANSPORTADORA = 'TRANSPORTADORA-SENT';
const NOTA = 'NOTA-SENT-INTERNA';
const REFERENCIA = 'REF-EXT-SENT-555';
const EVIDENCIA = 'EVIDENCIA-SENT-FILE';
const CENTINELAS_NO_DINERO = [CEDULA, TELEFONO, DIRECCION, GUIA, TRANSPORTADORA, NOTA, REFERENCIA, EVIDENCIA];
const CENTINELAS_DINERO = [String(FEE), String(COSTO_ENVIO), String(COBRO)];

let op: EscenarioDeOperacion;
let rios: string;
let gomez: string;
let diego: string;

function exito<T>(r: Result<T>): T {
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message} ${JSON.stringify(r.error.details)}`);
  return r.value;
}
function codigo<T>(r: Result<T>): string {
  return r.ok ? 'OK' : r.error.code;
}
const serializado = (v: unknown): string => JSON.stringify(v);

async function nuevaParticipacion(etiqueta: string, productos: readonly string[] = []): Promise<string> {
  const creado = exito(
    await crearInfluencer(op.admin, {
      displayName: `${etiqueta} ${unico('p')}`.slice(0, 80),
      cuentas: [
        {
          platform: 'instagram',
          handle: `${etiqueta}.${unico('h')}`.toLowerCase().replace(/[^a-z0-9._]/g, ''),
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

async function envio(
  ci: string,
  producto: string,
  cantidad: number,
  extra: Partial<Parameters<typeof crearEnvio>[1]> = {},
) {
  return exito(
    await crearEnvio(op.operativo, {
      campaignInfluencerId: ci,
      items: [{ campaignProductId: producto, quantity: cantidad }],
      idempotencyKey: unico('envio'),
      ...extra,
    }),
  ).envio;
}

async function mover(
  s: { id: string; rowSeq: number },
  to: Parameters<typeof transicionarEnvio>[1]['to'],
  extra: Partial<Parameters<typeof transicionarEnvio>[1]> = {},
) {
  return exito(
    await transicionarEnvio(op.operativo, {
      shipmentId: s.id,
      to,
      expectedSeq: s.rowSeq,
      idempotencyKey: unico(to),
      ...extra,
    }),
  ).envio;
}

/** Envío que llega a `delivered` pasando por prepared y shipped. */
async function entregar(
  ci: string,
  producto: string,
  cantidad: number,
  extra: Partial<Parameters<typeof crearEnvio>[1]> = {},
) {
  let s = await envio(ci, producto, cantidad, extra);
  s = await mover(s, 'prepared');
  s = await mover(s, 'shipped', {
    happenedOn: dia(3),
    carrier: TRANSPORTADORA,
    trackingRef: GUIA,
    note: NOTA,
  });
  return mover(s, 'delivered', { happenedOn: dia(1) });
}

beforeAll(async () => {
  op = await crearEscenarioDeOperacion('F8 operativo');
  rios = op.participaciones.valentinaRios;
  gomez = op.participaciones.valentinaGomez;
  diego = op.participaciones.diego;

  // Rios: MIXTO (fee centinela + 4 P80). Gomez: BARTER (2 P80 Pro). Diego: sin acuerdo.
  await crearAcuerdoDePrueba(op.admin, {
    campaignInfluencerId: rios,
    mode: 'mixed',
    campaignProductId: op.productos.p80,
    amount: FEE,
    currency: 'COP',
    quantity: 4,
    conditions: 'Condición sintética del acuerdo',
  });
  await crearAcuerdoDePrueba(op.admin, {
    campaignInfluencerId: gomez,
    mode: 'barter',
    campaignProductId: op.productos.pro,
    quantity: 2,
  });

  // PII de Rios (cifrada) referenciada por su envío: jamás debe salir.
  const influencer = (
    await query<{ influencer_id: string }>(`SELECT influencer_id FROM campaign_influencers WHERE id = $1`, [
      rios,
    ])
  )[0]!.influencer_id;
  const pii = exito(
    await guardarPii(op.operativo, {
      influencerId: influencer,
      documentId: CEDULA,
      phone: TELEFONO,
      address: DIRECCION,
    }),
  );

  // Rios: un envío ENTREGADO (2 P80, con costo, guía, transportadora y nota) y otro PENDIENTE (1 P80).
  await entregar(rios, op.productos.p80, 2, {
    shippingCost: COSTO_ENVIO,
    shippingCurrency: 'COP',
    piiRecordId: pii.record.recordId,
    note: NOTA,
  });
  await envio(rios, op.productos.p80, 1);
  // Gomez (barter): un envío pendiente.
  await envio(gomez, op.productos.pro, 2);

  // Rios: cuenta de cobro REGISTRADA con archivo y monto centinela.
  const seguimiento = exito(await obtenerSeguimientoDePago(op.operativo, rios))!;
  exito(
    await registrarDocumentoDeCobro(op.operativo, {
      paymentObligationId: seguimiento.obligation.id,
      documentNumber: 'DOC-SENT-001',
      issuedOn: dia(2),
      claimedAmount: COBRO,
      claimedCurrency: 'COP',
      archivo: archivoDePrueba(EVIDENCIA),
      idempotencyKey: unico('doc'),
      note: NOTA,
    }),
  );
}, 60_000);

afterAll(async () => {
  await limpiarEscenarioDeOperacion(op);
  await closePool();
});

afterEach(() => {
  vi.restoreAllMocks();
});

function item(r: ResumenOperativoDeCampana, ci: string) {
  const i = r.items.find((x) => x.participacionId === ci);
  if (i === undefined) throw new Error(`falta la participación ${ci}`);
  return i;
}

// ─────────────────────────── Matriz rol × sección ──────────────────────────────

describe('matriz rol × sección (resumen de campaña)', () => {
  const COMPLETAS = ['acuerdo', 'logistica', 'facturacion_pagos', 'contenido', 'kpi'];

  it.each(['admin', 'director', 'operativo'] as const)('%s ve las cinco secciones', async (rol) => {
    const r = exito(await obtenerResumenOperativoDeCampana(op[rol], op.campanaId));
    expect(r.secciones).toEqual(COMPLETAS);
    const i = item(r, rios).resumen;
    expect(Object.keys(i).sort()).toEqual([
      'acuerdo',
      'contenido',
      'facturacion',
      'kpi',
      'logistica',
      'pago',
    ]);
    expect(i.kpi).toMatchObject({ estado: 'sin_objetivos' });
  });

  it('el consultor ve acuerdo, logística, contenido y KPI; NO facturación ni pago (claves ausentes)', async () => {
    const r = exito(await obtenerResumenOperativoDeCampana(op.consultor, op.campanaId));
    expect(r.secciones).toEqual(['acuerdo', 'logistica', 'contenido', 'kpi']);
    for (const i of r.items) {
      expect('facturacion' in i.resumen).toBe(false);
      expect('pago' in i.resumen).toBe(false);
      expect(Object.keys(i.resumen).sort()).toEqual(['acuerdo', 'contenido', 'kpi', 'logistica']);
    }
    expect(r.conteos).not.toHaveProperty('pagoPendiente');
  });

  it('analista y legal ⇒ FORBIDDEN_ROLE; cliente y ajeno ⇒ RESOURCE_NOT_FOUND', async () => {
    expect(codigo(await obtenerResumenOperativoDeCampana(op.analista, op.campanaId))).toBe('FORBIDDEN_ROLE');
    expect(codigo(await obtenerResumenOperativoDeCampana(op.legal, op.campanaId))).toBe('FORBIDDEN_ROLE');
    expect(codigo(await obtenerResumenOperativoDeCampana(op.cliente, op.campanaId))).toBe(
      'RESOURCE_NOT_FOUND',
    );
    expect(codigo(await obtenerResumenOperativoDeCampana(op.ajeno, op.campanaId))).toBe('RESOURCE_NOT_FOUND');
    expect(codigo(await obtenerResumenOperativoDeCampana(op.admin, 'no-es-uuid'))).toBe('RESOURCE_NOT_FOUND');
  });
});

describe('matriz rol × sección (estado de una participación)', () => {
  it.each(['admin', 'director', 'operativo'] as const)(
    '%s ve las cinco secciones del detalle',
    async (rol) => {
      const e = exito(await obtenerEstadoOperativoDeParticipacion(op[rol], rios));
      expect(
        Object.keys(e)
          .filter((k) => ['acuerdo', 'logistica', 'facturacion', 'pago', 'contenido', 'kpi'].includes(k))
          .sort(),
      ).toEqual(['acuerdo', 'contenido', 'facturacion', 'kpi', 'logistica', 'pago']);
    },
  );

  it('el consultor ve el detalle sin facturación ni pago', async () => {
    const e = exito(await obtenerEstadoOperativoDeParticipacion(op.consultor, rios));
    expect(e.secciones).toEqual(['acuerdo', 'logistica', 'contenido', 'kpi']);
    expect('facturacion' in e).toBe(false);
    expect('pago' in e).toBe(false);
  });

  it('analista y legal ⇒ FORBIDDEN_ROLE; cliente y ajeno ⇒ RESOURCE_NOT_FOUND', async () => {
    expect(codigo(await obtenerEstadoOperativoDeParticipacion(op.analista, rios))).toBe('FORBIDDEN_ROLE');
    expect(codigo(await obtenerEstadoOperativoDeParticipacion(op.legal, rios))).toBe('FORBIDDEN_ROLE');
    expect(codigo(await obtenerEstadoOperativoDeParticipacion(op.cliente, rios))).toBe('RESOURCE_NOT_FOUND');
    expect(codigo(await obtenerEstadoOperativoDeParticipacion(op.ajeno, rios))).toBe('RESOURCE_NOT_FOUND');
    expect(codigo(await obtenerEstadoOperativoDeParticipacion(op.admin, 'no-es-uuid'))).toBe(
      'RESOURCE_NOT_FOUND',
    );
  });
});

// ─────────────────────────── Contenido del resumen ─────────────────────────────

describe('resumen por participación', () => {
  it('deriva el estado de cada dominio sin duplicarlo', async () => {
    const r = exito(await obtenerResumenOperativoDeCampana(op.admin, op.campanaId));
    const a = item(r, rios).resumen;
    expect(a.acuerdo).toEqual({ estado: 'active', modo: 'mixed', version: 1 });
    // Un envío entregado y otro pendiente: hay uno abierto ⇒ la logística sigue pendiente.
    expect(a.logistica).toMatchObject({
      estado: 'pendiente',
      abiertos: 1,
      ultimoEstado: 'pending',
      comprometidas: 4,
      enviadas: 2,
      entregadas: 2,
      tienePii: true,
    });
    expect(a.facturacion).toEqual({
      documentos: { registrados: 1, validados: 0, rechazados: 0, anulados: 0 },
    });
    expect(a.pago).toEqual({ seguimiento: 'document_received', obligacion: 'pending' });
    expect(a.contenido).toMatchObject({ estado: 'sin_guion', entregables: 2 });

    const sin = item(r, diego).resumen;
    expect(sin.acuerdo).toEqual({ estado: 'sin_acuerdo', modo: null, version: null });
    expect(sin.logistica).toMatchObject({
      estado: 'sin_envio',
      abiertos: 0,
      ultimoEstado: null,
      comprometidas: 0,
    });
    expect(sin.pago).toEqual({ seguimiento: null, obligacion: null });
  });

  it('barter puro ⇒ pago not_applicable (nunca pendiente), también con un envío abierto', async () => {
    const r = exito(await obtenerResumenOperativoDeCampana(op.admin, op.campanaId));
    const b = item(r, gomez).resumen;
    expect(b.acuerdo).toMatchObject({ modo: 'barter' });
    expect(b.pago).toEqual({ seguimiento: 'not_applicable', obligacion: 'not_applicable' });
    expect(b.logistica).toMatchObject({ estado: 'pendiente', abiertos: 1 });
    const d = exito(await obtenerEstadoOperativoDeParticipacion(op.operativo, gomez));
    expect(d.pago).toMatchObject({ seguimiento: 'not_applicable', obligacion: 'not_applicable' });
  });

  it('el nombre del influencer es el visible; hay conteos sobre el total', async () => {
    const r = exito(await obtenerResumenOperativoDeCampana(op.admin, op.campanaId));
    expect(item(r, rios).nombre).toBe('Valentina Ríos');
    expect(r.total).toBe(3);
    expect(r.conteos).toEqual({ participaciones: 3, sinAcuerdo: 1, logisticaPendiente: 2, pagoPendiente: 1 });
  });
});

// ─────────────────────────── Filtros y paginación ──────────────────────────────

describe('filtros y paginación', () => {
  const ids = (r: ResumenOperativoDeCampana): string[] => r.items.map((i) => i.participacionId).sort();

  it('sin acuerdo', async () => {
    const r = exito(await obtenerResumenOperativoDeCampana(op.admin, op.campanaId, { sinAcuerdo: true }));
    expect(ids(r)).toEqual([diego]);
    expect(r.total).toBe(1);
    expect(r.conteos.participaciones).toBe(3);
  });

  it('logística pendiente: lo que tiene envío abierto; Diego (sin compromisos) no', async () => {
    const r = exito(
      await obtenerResumenOperativoDeCampana(op.admin, op.campanaId, { logisticaPendiente: true }),
    );
    expect(ids(r)).toEqual([rios, gomez].sort());
  });

  it('pago pendiente: Rios sí; Gomez (barter) y Diego (sin acuerdo) no', async () => {
    const r = exito(
      await obtenerResumenOperativoDeCampana(op.operativo, op.campanaId, { pagoPendiente: true }),
    );
    expect(ids(r)).toEqual([rios]);
  });

  it('los filtros se combinan con Y', async () => {
    const r = exito(
      await obtenerResumenOperativoDeCampana(op.admin, op.campanaId, {
        pagoPendiente: true,
        logisticaPendiente: true,
      }),
    );
    expect(ids(r)).toEqual([rios]);
    const vacio = exito(
      await obtenerResumenOperativoDeCampana(op.admin, op.campanaId, {
        pagoPendiente: true,
        sinAcuerdo: true,
      }),
    );
    expect(vacio.items).toEqual([]);
  });

  it('el consultor no puede filtrar por pago (no es una forma de leerlo)', async () => {
    expect(
      codigo(await obtenerResumenOperativoDeCampana(op.consultor, op.campanaId, { pagoPendiente: true })),
    ).toBe('FORBIDDEN_ROLE');
    const ok = exito(
      await obtenerResumenOperativoDeCampana(op.consultor, op.campanaId, { logisticaPendiente: true }),
    );
    expect(ok.items.length).toBe(2);
  });

  it('pagina con el total real', async () => {
    const p1 = exito(await obtenerResumenOperativoDeCampana(op.admin, op.campanaId, { limite: 2, desde: 0 }));
    const p2 = exito(await obtenerResumenOperativoDeCampana(op.admin, op.campanaId, { limite: 2, desde: 2 }));
    expect(p1.items.length).toBe(2);
    expect(p2.items.length).toBe(1);
    expect(p1.total).toBe(3);
    expect(p2.total).toBe(3);
    const todos = [...p1.items, ...p2.items].map((i) => i.participacionId).sort();
    expect(todos).toEqual([rios, gomez, diego].sort());
    const topado = exito(await obtenerResumenOperativoDeCampana(op.admin, op.campanaId, { limite: 100000 }));
    expect(topado.limite).toBe(200);
  });

  it('los retirados no salen por defecto; con incluirRetirados sí', async () => {
    const ci = await nuevaParticipacion('Retirada');
    exito(await retirarInfluencerDeCampana(op.admin, ci, { motivo: 'prueba' }));
    const por = exito(await obtenerResumenOperativoDeCampana(op.admin, op.campanaId));
    expect(por.items.some((i) => i.participacionId === ci)).toBe(false);
    const con = exito(
      await obtenerResumenOperativoDeCampana(op.admin, op.campanaId, { incluirRetirados: true }),
    );
    expect(con.items.find((i) => i.participacionId === ci)?.estadoDeParticipacion).toBe('retirado');
  });
});

// ─────────────────────────── Detalle ───────────────────────────────────────────

describe('estado detallado de una participación', () => {
  let admin: EstadoOperativoDeParticipacion;

  beforeAll(async () => {
    admin = exito(await obtenerEstadoOperativoDeParticipacion(op.admin, rios));
  });

  it('acuerdo, logística, facturación y pago, con dinero para quien tiene finance:read', () => {
    expect(admin.acuerdo).toMatchObject({
      estado: 'active',
      modo: 'mixed',
      version: 1,
      dinero: { monto: `${FEE}.00`, moneda: 'COP' },
    });
    expect(admin.acuerdo?.productos).toEqual([
      { campaignProductId: op.productos.p80, producto: 'TCL P80', cantidad: 4 },
    ]);
    expect(admin.logistica?.productos).toEqual([
      { campaignProductId: op.productos.p80, nombre: 'TCL P80', comprometido: 4, enviado: 2, entregado: 2 },
    ]);
    expect(admin.logistica?.envios.map((e) => e.estado).sort()).toEqual(['delivered', 'pending']);
    const entregado = admin.logistica?.envios.find((e) => e.estado === 'delivered');
    expect(entregado?.costoDeEnvio).toEqual({ monto: `${COSTO_ENVIO}.00`, moneda: 'COP' });
    expect(entregado?.tienePii).toBe(true);
    expect(admin.facturacion?.lista[0]).toMatchObject({
      numero: 'DOC-SENT-001',
      estado: 'registered',
      montoReclamado: `${COBRO}.00`,
    });
    expect(admin.pago).toMatchObject({ seguimiento: 'document_received', obligacion: 'pending' });
    expect(admin.contenido?.items.length).toBe(2);
  });

  it('el consultor ve acuerdo sin montos y logística sin costo', async () => {
    const c = exito(await obtenerEstadoOperativoDeParticipacion(op.consultor, rios));
    expect(c.acuerdo).toMatchObject({ estado: 'active', modo: 'mixed' });
    expect(c.acuerdo).not.toHaveProperty('dinero');
    for (const e of c.logistica?.envios ?? []) expect(e).not.toHaveProperty('costoDeEnvio');
    expect(c.logistica?.productos[0]).toMatchObject({ comprometido: 4, enviado: 2, entregado: 2 });
    expect(c.contenido?.items.length).toBe(2);
  });

  it('el Operativo ve el contenido como proyección de estado (sin nombres de archivo)', async () => {
    const o = exito(await obtenerEstadoOperativoDeParticipacion(op.operativo, rios));
    expect(o.contenido?.items.every((i) => i.ultimaVersion === null && i.aprobadaVigente === null)).toBe(
      true,
    );
    expect(o.contenido?.estado).toBe('sin_guion');
  });

  it('un acuerdo ausente deja las secciones coherentes', async () => {
    const d = exito(await obtenerEstadoOperativoDeParticipacion(op.admin, diego));
    expect(d.acuerdo).toMatchObject({ estado: 'sin_acuerdo', modo: null, id: null, productos: [] });
    expect(d.pago).toMatchObject({ seguimiento: null, obligacionId: null });
    expect(d.logistica).toMatchObject({ estado: 'sin_envio' });
  });
});

// ─────────────────────────── Mixto: pago y logística independientes ────────────

describe('mixto: seguimiento de pago y logística independientes', () => {
  it('el pago avanza sin mover la logística y viceversa', async () => {
    const ci = await nuevaParticipacion('Mixta', [op.productos.p80]);
    await crearAcuerdoDePrueba(op.admin, {
      campaignInfluencerId: ci,
      mode: 'mixed',
      campaignProductId: op.productos.p80,
      quantity: 1,
      amount: 100,
    });
    const estado = async () => exito(await obtenerEstadoOperativoDeParticipacion(op.operativo, ci));

    let e = await estado();
    expect(e.pago?.seguimiento).toBe('pending_document');
    expect(e.logistica?.estado).toBe('sin_envio');

    // La logística llega a entregado: el pago NO se mueve.
    await entregar(ci, op.productos.p80, 1);
    e = await estado();
    expect(e.logistica?.estado).toBe('entregado');
    expect(e.pago?.seguimiento).toBe('pending_document');

    // El pago recorre su camino: la logística NO se mueve.
    const obligacion = exito(await obtenerSeguimientoDePago(op.operativo, ci))!.obligation;
    const doc = exito(
      await registrarDocumentoDeCobro(op.operativo, {
        paymentObligationId: obligacion.id,
        documentNumber: 'DOC-MIX-1',
        issuedOn: dia(2),
        claimedAmount: 100,
        claimedCurrency: 'COP',
        archivo: archivoDePrueba(),
        idempotencyKey: unico('doc'),
      }),
    ).documento;
    e = await estado();
    expect(e.pago?.seguimiento).toBe('document_received');
    expect(e.logistica?.estado).toBe('entregado');

    exito(
      await validarDocumento(op.operativo, {
        billingDocumentId: doc.id,
        expectedSeq: doc.rowSeq,
        idempotencyKey: unico('val'),
      }),
    );
    e = await estado();
    expect(e.pago?.seguimiento).toBe('pending_payment');
    expect(e.facturacion?.documentos.validados).toBe(1);

    const o2 = exito(await obtenerSeguimientoDePago(op.operativo, ci))!.obligation;
    exito(
      await reportarPago(op.operativo, {
        paymentObligationId: o2.id,
        expectedSeq: o2.rowSeq,
        idempotencyKey: unico('pago'),
        paidOn: dia(0),
        externalReference: REFERENCIA,
      }),
    );
    e = await estado();
    expect(e.pago).toMatchObject({ seguimiento: 'reported_paid', obligacion: 'reported_paid' });
    expect(e.logistica?.estado).toBe('entregado');
    expect(e.pago).not.toHaveProperty('externalReference');

    const lista = exito(
      await obtenerResumenOperativoDeCampana(op.operativo, op.campanaId, { pagoPendiente: true }),
    );
    expect(lista.items.some((i) => i.participacionId === ci)).toBe(false);
  }, 60_000);
});

// ─────────────────────────── Centinelas ────────────────────────────────────────

describe('datos centinela', () => {
  it('el consultor jamás ve dinero, PII, guía, transportadora, notas, referencias ni evidencia', async () => {
    const lista = serializado(exito(await obtenerResumenOperativoDeCampana(op.consultor, op.campanaId)));
    const detalle = serializado(exito(await obtenerEstadoOperativoDeParticipacion(op.consultor, rios)));
    for (const texto of [lista, detalle]) {
      for (const c of [...CENTINELAS_NO_DINERO, ...CENTINELAS_DINERO]) expect(texto).not.toContain(c);
      // Sin claves de dinero (se revisan las CLAVES: un uuid puede contener «fee» por casualidad).
      const claves = [...texto.matchAll(/"([A-Za-z_]+)":/g)].map((m) => m[1]!);
      expect(
        claves.filter((k) =>
          /^(dinero|monto|moneda|costoDeEnvio|montoReclamado|monedaReclamada|fee.*)$/i.test(k),
        ),
      ).toEqual([]);
    }
  });

  it('ni siquiera quien tiene finance:read ve PII, guía, transportadora, notas, referencias ni nombres de evidencia', async () => {
    for (const rol of ['admin', 'director', 'operativo'] as const) {
      const lista = serializado(exito(await obtenerResumenOperativoDeCampana(op[rol], op.campanaId)));
      const detalle = serializado(exito(await obtenerEstadoOperativoDeParticipacion(op[rol], rios)));
      for (const texto of [lista, detalle]) {
        for (const c of CENTINELAS_NO_DINERO) expect(texto).not.toContain(c);
      }
    }
  });

  it('el dinero SÍ aparece con finance:read en el detalle (el centinela es real), pero no en la lista', async () => {
    const detalle = serializado(exito(await obtenerEstadoOperativoDeParticipacion(op.admin, rios)));
    for (const c of CENTINELAS_DINERO) expect(detalle).toContain(c);
    const lista = serializado(exito(await obtenerResumenOperativoDeCampana(op.admin, op.campanaId)));
    for (const c of CENTINELAS_DINERO) expect(lista).not.toContain(c);
  });
});

// ─────────────────────────── Qué se consulta ───────────────────────────────────

describe('cada sección se ejecuta solo con su capacidad', () => {
  function textosDeConsulta(espia: ReturnType<typeof vi.spyOn>): string[] {
    return espia.mock.calls.map((c) => (typeof c[0] === 'string' ? c[0] : (c[0] as { text: string }).text));
  }

  it('el consultor: ni se toca facturación, obligaciones ni costo de envío', async () => {
    const espia = vi.spyOn(getPool(), 'query');
    exito(await obtenerResumenOperativoDeCampana(op.consultor, op.campanaId));
    exito(await obtenerEstadoOperativoDeParticipacion(op.consultor, rios));
    const sql = textosDeConsulta(espia).join('\n');
    expect(sql.length).toBeGreaterThan(0);
    expect(sql).not.toMatch(/billing_documents|payment_obligations/);
    expect(sql).not.toMatch(/s\.shipping_cost::text/);
    expect(sql).not.toMatch(/v\.fee_amount/);
    expect(sql).not.toMatch(/select\s+\*/i);
  });

  it('el resumen de campaña nunca usa SELECT * y solo lee columnas de lista blanca', async () => {
    const espia = vi.spyOn(getPool(), 'query');
    exito(await obtenerResumenOperativoDeCampana(op.admin, op.campanaId));
    const sql = textosDeConsulta(espia).join('\n');
    expect(sql).not.toMatch(/select\s+\*/i);
    expect(sql).not.toMatch(/\.\*/);
    // `(s.pii_record_id IS NOT NULL)` solo calcula el booleano `tienePii`: el id del registro no se lee.
    expect(sql.replace(/\(s\.pii_record_id IS NOT NULL\)/g, '')).not.toMatch(
      /pii_record|document_id_enc|phone_enc|address_enc|tracking_ref|carrier|shipping_cost|fee_amount|\bnote\b|external_reference|filename/,
    );
  });
});

// ─────────────────────────── Sin N+1 ───────────────────────────────────────────

describe('consultas por lotes', () => {
  it('el número de consultas no depende del de participaciones (20 más)', async () => {
    const espia = vi.spyOn(getPool(), 'query');
    exito(await obtenerResumenOperativoDeCampana(op.admin, op.campanaId));
    const base = espia.mock.calls.length;
    espia.mockClear();

    for (let i = 0; i < 20; i += 1) {
      const ci = await nuevaParticipacion(`Lote${i}`, [op.productos.p80]);
      await crearAcuerdoDePrueba(op.admin, {
        campaignInfluencerId: ci,
        mode: i % 2 === 0 ? 'fee' : 'barter',
        campaignProductId: op.productos.p80,
        quantity: 1,
      });
      if (i % 3 === 0) await envio(ci, op.productos.p80, 1).catch(() => undefined);
    }
    espia.mockClear();

    const r = exito(await obtenerResumenOperativoDeCampana(op.admin, op.campanaId, { limite: 200 }));
    expect(r.total).toBeGreaterThanOrEqual(23);
    const con20 = espia.mock.calls.length;
    expect(con20).toBe(base);
    expect(con20).toBeLessThanOrEqual(15);

    espia.mockClear();
    exito(await obtenerResumenOperativoDeCampana(op.consultor, op.campanaId, { limite: 200 }));
    expect(espia.mock.calls.length).toBeLessThanOrEqual(14);
  }, 120_000);
});

// ─────────────────────────── Aislamiento ───────────────────────────────────────

describe('aislamiento por organización', () => {
  it('otra organización no ve la campaña ni la participación; la suya sí y solo la suya', async () => {
    expect(codigo(await obtenerEstadoOperativoDeParticipacion(op.admin, op.ajena.participacion))).toBe(
      'RESOURCE_NOT_FOUND',
    );
    expect(codigo(await obtenerResumenOperativoDeCampana(op.admin, op.campanaAjenaId))).toBe(
      'RESOURCE_NOT_FOUND',
    );
    expect(codigo(await obtenerResumenOperativoDeCampana(op.ajeno, op.campanaId))).toBe('RESOURCE_NOT_FOUND');
    const propia = exito(await obtenerResumenOperativoDeCampana(op.ajeno, op.campanaAjenaId));
    expect(propia.items.map((i) => i.participacionId)).toEqual([op.ajena.participacion]);
    expect(serializado(propia)).not.toContain(String(FEE));
    exito(await obtenerEstadoOperativoDeParticipacion(op.ajeno, op.ajena.participacion));
  });

  it('una participación de la campaña no sale con el id de otra campaña', async () => {
    const r = exito(await obtenerResumenOperativoDeCampana(op.admin, op.otraCampanaId));
    expect(r.items).toEqual([]);
    expect(r.conteos.participaciones).toBe(0);
  });
});

// ─────────────────────────── Hook de KPI ───────────────────────────────────────

describe('seccionKpi inyectable (proveedor falso)', () => {
  it('se llama UNA vez por consulta con el actor y los ids de la página; su resultado va a `kpi`', async () => {
    const proveedor = vi.fn(
      async ({ participacionIds }: { participacionIds: readonly string[] }) =>
        new Map<string, { objetivos: number }>(participacionIds.map((id) => [id, { objetivos: 3 }])),
    );
    const r = exito(
      await obtenerResumenOperativoDeCampana(
        op.consultor,
        op.campanaId,
        { limite: 2 },
        { seccionKpi: proveedor },
      ),
    );
    expect(proveedor).toHaveBeenCalledTimes(1);
    const llamada = proveedor.mock.calls[0]![0] as unknown as {
      actor: User;
      campaignId: string;
      participacionIds: string[];
    };
    expect(llamada.actor.id).toBe(op.consultor.id);
    expect(llamada.campaignId).toBe(op.campanaId);
    expect(llamada.participacionIds.sort()).toEqual(r.items.map((i) => i.participacionId).sort());
    expect(r.items.every((i) => (i.resumen.kpi as { objetivos: number }).objetivos === 3)).toBe(true);
  });

  it('un participante sin dato recibe null; sin proveedor, null; el detalle usa el mismo hook', async () => {
    const parcial = new Map([[rios, { objetivos: 1 }]]);
    const r = exito(
      await obtenerResumenOperativoDeCampana(op.admin, op.campanaId, {}, { seccionKpi: async () => parcial }),
    );
    expect(item(r, rios).resumen.kpi).toEqual({ objetivos: 1 });
    expect(item(r, gomez).resumen.kpi).toBeNull();
    const detalle = exito(
      await obtenerEstadoOperativoDeParticipacion(op.operativo, rios, { seccionKpi: async () => parcial }),
    );
    expect(detalle.kpi).toEqual({ objetivos: 1 });
    const sin = exito(await obtenerEstadoOperativoDeParticipacion(op.operativo, rios));
    // Sin proveedor inyectado se usa el resumen real de `kpi-views.ts` (sin objetivos en este escenario).
    expect(sin.kpi).toMatchObject({ estado: 'sin_objetivos' });
  });

  it('los roles sin operations:read no llegan al proveedor', async () => {
    const proveedor = vi.fn(async () => new Map<string, unknown>());
    await obtenerResumenOperativoDeCampana(op.analista, op.campanaId, {}, { seccionKpi: proveedor });
    await obtenerResumenOperativoDeCampana(op.cliente, op.campanaId, {}, { seccionKpi: proveedor });
    await obtenerEstadoOperativoDeParticipacion(op.legal, rios, { seccionKpi: proveedor });
    expect(proveedor).not.toHaveBeenCalled();
  });
});
