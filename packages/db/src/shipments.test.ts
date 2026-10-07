/**
 * V2 · Fase 8 (W1b) — envíos: creación, máquina de estados por eventos, reglas de preparación (asignado ≠
 * comprometido ≠ enviado ≠ entregado), PII solo por referencia, proyección por capacidad y aislamiento.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Result } from '@tcl-kol-os/domain';
import { closePool } from './client.ts';
import {
  type EscenarioDeOperacion,
  archivoDePrueba,
  crearAcuerdoPorSql,
  crearEscenarioDeOperacion,
  dia,
  fila,
  insertarPiiPorSql,
  limpiarEscenarioDeOperacion,
  nuevaParticipacion,
  productoDeOtraCampana,
  unico,
} from './ops-test-support.ts';
import {
  type EnvioVista,
  crearEnvio,
  listarEnviosDeParticipacion,
  obtenerEnvio,
  transicionarEnvio,
} from './shipments.ts';

let op: EscenarioDeOperacion;
let e: EscenarioDeOperacion['e'];

beforeAll(async () => {
  op = await crearEscenarioDeOperacion('F8 envios');
  e = op.e;
});

afterAll(async () => {
  await limpiarEscenarioDeOperacion(op);
  await closePool();
});

function exito<T>(r: Result<T>): T {
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message} ${JSON.stringify(r.error.details)}`);
  return r.value;
}

function codigo<T>(r: Result<T>): string {
  return r.ok ? 'OK' : r.error.code;
}

async function nuevoEnvio(
  ci: string,
  producto: string,
  extra: Partial<Parameters<typeof crearEnvio>[1]> = {},
): Promise<EnvioVista> {
  return exito(
    await crearEnvio(e.operativo, {
      campaignInfluencerId: ci,
      items: [{ campaignProductId: producto, quantity: 2 }],
      idempotencyKey: unico('crear'),
      ...extra,
    }),
  ).envio;
}

async function paso(
  s: EnvioVista,
  to: Parameters<typeof transicionarEnvio>[1]['to'],
  extra: Partial<Parameters<typeof transicionarEnvio>[1]> = {},
): Promise<EnvioVista> {
  const r = exito(
    await transicionarEnvio(e.operativo, {
      shipmentId: s.id,
      to,
      expectedSeq: s.rowSeq,
      idempotencyKey: unico(to),
      ...extra,
    }),
  );
  return r.envio;
}

describe('crearEnvio', () => {
  it('nace pending con su evento shipment.created, sus ítems y row_seq 1', async () => {
    const { ci } = await nuevaParticipacion(op, 'Crea', [e.productos.p80]);
    const r = exito(
      await crearEnvio(e.operativo, {
        campaignInfluencerId: ci,
        items: [{ campaignProductId: e.productos.p80, quantity: 3 }],
        idempotencyKey: unico('c'),
      }),
    );
    expect(r.repetido).toBe(false);
    expect(r.evento).toMatchObject({
      eventType: 'shipment.created',
      fromStatus: null,
      toStatus: 'pending',
      subjectSeq: 1,
    });
    expect(r.envio).toMatchObject({
      status: 'pending',
      rowSeq: 1,
      campaignInfluencerId: ci,
      tienePii: false,
    });
    expect(r.envio.items).toEqual([{ campaignProductId: e.productos.p80, quantity: 3, productModel: 'P80' }]);
  });

  it('idempotente: el reintento idéntico devuelve el MISMO envío; la clave con otra solicitud es conflicto', async () => {
    const { ci } = await nuevaParticipacion(op, 'Idem', [e.productos.p80]);
    const clave = unico('idem');
    const entrada = {
      campaignInfluencerId: ci,
      items: [{ campaignProductId: e.productos.p80, quantity: 1 }],
      idempotencyKey: clave,
    };
    const a = exito(await crearEnvio(e.operativo, entrada));
    const b = exito(await crearEnvio(e.operativo, entrada));
    expect(b.repetido).toBe(true);
    expect(b.envio.id).toBe(a.envio.id);
    expect(b.evento.id).toBe(a.evento.id);
    const otra = await crearEnvio(e.operativo, {
      ...entrada,
      items: [{ campaignProductId: e.productos.p80, quantity: 9 }],
    });
    expect(otra.ok).toBe(false);
    if (!otra.ok) expect(otra.error.details).toMatchObject({ reason: 'idempotency_key_reused' });
    const n = await fila<{ n: string }>(
      `SELECT count(*) AS n FROM shipments WHERE campaign_influencer_id = $1`,
      [ci],
    );
    expect(Number(n.n)).toBe(1);
  });

  it('rechaza ítems vacíos, repetidos o de otra campaña; costo sin moneda; y exige shipment:manage', async () => {
    const { ci } = await nuevaParticipacion(op, 'Valida', [e.productos.p80]);
    const base = { campaignInfluencerId: ci, idempotencyKey: unico('v') };
    expect(codigo(await crearEnvio(e.operativo, { ...base, items: [] }))).toBe('VALIDATION_FAILED');
    expect(
      codigo(
        await crearEnvio(e.operativo, {
          ...base,
          idempotencyKey: unico('v2'),
          items: [
            { campaignProductId: e.productos.p80, quantity: 1 },
            { campaignProductId: e.productos.p80, quantity: 1 },
          ],
        }),
      ),
    ).toBe('VALIDATION_FAILED');
    expect(
      codigo(
        await crearEnvio(e.operativo, {
          ...base,
          idempotencyKey: unico('v3'),
          items: [{ campaignProductId: await productoDeOtraCampana(op), quantity: 1 }],
        }),
      ),
    ).toBe('VALIDATION_FAILED');
    expect(
      codigo(
        await crearEnvio(e.operativo, {
          ...base,
          idempotencyKey: unico('v4'),
          items: [{ campaignProductId: e.productos.p80, quantity: 1 }],
          shippingCost: 1000,
        }),
      ),
    ).toBe('VALIDATION_FAILED');
    const consultor = await crearEnvio(e.consultor, {
      ...base,
      idempotencyKey: unico('v5'),
      items: [{ campaignProductId: e.productos.p80, quantity: 1 }],
    });
    expect(codigo(consultor)).toBe('FORBIDDEN_ROLE');
  });

  it('ajeno, cliente y participación inexistente ⇒ RESOURCE_NOT_FOUND', async () => {
    const { ci } = await nuevaParticipacion(op, 'Ajeno', [e.productos.p80]);
    const entrada = {
      campaignInfluencerId: ci,
      items: [{ campaignProductId: e.productos.p80, quantity: 1 }],
    };
    for (const actor of [e.ajeno, e.cliente]) {
      expect(codigo(await crearEnvio(actor, { ...entrada, idempotencyKey: unico('a') })), actor.role).toBe(
        'RESOURCE_NOT_FOUND',
      );
    }
    expect(
      codigo(
        await crearEnvio(e.operativo, {
          ...entrada,
          campaignInfluencerId: '00000000-0000-4000-8000-000000000000',
          idempotencyKey: unico('a'),
        }),
      ),
    ).toBe('RESOURCE_NOT_FOUND');
  });

  it('no crea envíos de una participación retirada', async () => {
    const { ci } = await nuevaParticipacion(op, 'Retirada', [e.productos.p80]);
    await fila(`UPDATE campaign_influencers SET status = 'retirado', retired_at = now() WHERE id = $1`, [ci]);
    const r = await crearEnvio(e.operativo, {
      campaignInfluencerId: ci,
      items: [{ campaignProductId: e.productos.p80, quantity: 1 }],
      idempotencyKey: unico('r'),
    });
    expect(codigo(r)).toBe('RESOURCE_CONFLICT');
  });
});

describe('máquina de estados', () => {
  it('pending → prepared → shipped → delivered, con fechas, transportadora y guía', async () => {
    const { ci } = await nuevaParticipacion(op, 'Flujo', [e.productos.p80]);
    let s = await nuevoEnvio(ci, e.productos.p80);
    s = await paso(s, 'prepared');
    expect(s).toMatchObject({ status: 'prepared', rowSeq: 2 });
    s = await paso(s, 'shipped', {
      carrier: 'Servientrega',
      trackingRef: 'GUIA-123',
      happenedOn: dia(2),
      evidencia: { archivo: archivoDePrueba(), kind: 'guia' },
    });
    expect(s).toMatchObject({
      status: 'shipped',
      carrier: 'Servientrega',
      trackingRef: 'GUIA-123',
      shippedOn: dia(2),
    });
    s = await paso(s, 'delivered', { happenedOn: dia(0) });
    expect(s).toMatchObject({ status: 'delivered', deliveredOn: dia(0), rowSeq: 4 });
    s = await paso(s, 'returned', { note: 'devuelto por el cliente' });
    expect(s.status).toBe('returned');
    // terminal: no sale
    const otra = await transicionarEnvio(e.operativo, {
      shipmentId: s.id,
      to: 'delivered',
      expectedSeq: s.rowSeq,
      idempotencyKey: unico('x'),
      happenedOn: dia(0),
    });
    expect(codigo(otra)).toBe('RESOURCE_CONFLICT');
    const ev = await fila<{ n: string }>(
      `SELECT count(*) AS n FROM operational_events WHERE shipment_id = $1`,
      [s.id],
    );
    expect(Number(ev.n)).toBe(5);
  });

  it('shipped y delivered exigen la fecha del hecho; delivered jamás se infiere (no se salta shipped)', async () => {
    const { ci } = await nuevaParticipacion(op, 'Fechas', [e.productos.p80]);
    let s = await nuevoEnvio(ci, e.productos.p80);
    const directa = await transicionarEnvio(e.operativo, {
      shipmentId: s.id,
      to: 'delivered',
      expectedSeq: s.rowSeq,
      idempotencyKey: unico('d'),
      happenedOn: dia(0),
    });
    expect(codigo(directa)).toBe('RESOURCE_CONFLICT');
    s = await paso(s, 'prepared');
    const sinFecha = await transicionarEnvio(e.operativo, {
      shipmentId: s.id,
      to: 'shipped',
      expectedSeq: s.rowSeq,
      idempotencyKey: unico('sf'),
    });
    expect(codigo(sinFecha)).toBe('VALIDATION_FAILED');
    const futura = await transicionarEnvio(e.operativo, {
      shipmentId: s.id,
      to: 'shipped',
      expectedSeq: s.rowSeq,
      idempotencyKey: unico('fu'),
      happenedOn: '2999-01-01',
    });
    expect(codigo(futura)).toBe('VALIDATION_FAILED');
  });

  it('failed y returned salen de shipped; cancelled exige motivo y solo sale de pending|prepared', async () => {
    const { ci } = await nuevaParticipacion(op, 'Salidas', [e.productos.p80]);
    // failed
    let a = await paso(await nuevoEnvio(ci, e.productos.p80), 'prepared');
    a = await paso(a, 'shipped', { happenedOn: dia(1) });
    a = await paso(a, 'failed');
    expect(a.status).toBe('failed');
    // returned desde shipped
    let b = await paso(await nuevoEnvio(ci, e.productos.p80), 'prepared');
    b = await paso(b, 'shipped', { happenedOn: dia(1) });
    b = await paso(b, 'returned');
    expect(b.status).toBe('returned');
    // cancelled
    const c = await nuevoEnvio(ci, e.productos.p80);
    const sinMotivo = await transicionarEnvio(e.operativo, {
      shipmentId: c.id,
      to: 'cancelled',
      expectedSeq: c.rowSeq,
      idempotencyKey: unico('cm'),
    });
    expect(codigo(sinMotivo)).toBe('VALIDATION_FAILED');
    const cancelado = await paso(c, 'cancelled', { cancelReason: 'Dirección errónea' });
    expect(cancelado).toMatchObject({ status: 'cancelled', cancelReason: 'Dirección errónea' });
    // un envío en shipped ya no se cancela
    let d = await paso(await nuevoEnvio(ci, e.productos.p80), 'prepared');
    d = await paso(d, 'shipped', { happenedOn: dia(1) });
    const tarde = await transicionarEnvio(e.operativo, {
      shipmentId: d.id,
      to: 'cancelled',
      expectedSeq: d.rowSeq,
      idempotencyKey: unico('ct'),
      cancelReason: 'tarde',
    });
    expect(codigo(tarde)).toBe('RESOURCE_CONFLICT');
  });

  it('control optimista e idempotencia en la transición', async () => {
    const { ci } = await nuevaParticipacion(op, 'Optimista', [e.productos.p80]);
    const s = await nuevoEnvio(ci, e.productos.p80);
    const clave = unico('idem');
    const a = exito(
      await transicionarEnvio(e.operativo, {
        shipmentId: s.id,
        to: 'prepared',
        expectedSeq: s.rowSeq,
        idempotencyKey: clave,
      }),
    );
    const b = exito(
      await transicionarEnvio(e.operativo, {
        shipmentId: s.id,
        to: 'prepared',
        expectedSeq: s.rowSeq,
        idempotencyKey: clave,
      }),
    );
    expect(b.repetido).toBe(true);
    expect(b.evento.id).toBe(a.evento.id);
    const viejo = await transicionarEnvio(e.operativo, {
      shipmentId: s.id,
      to: 'cancelled',
      expectedSeq: s.rowSeq,
      idempotencyKey: unico('v'),
      cancelReason: 'x',
    });
    expect(codigo(viejo)).toBe('RESOURCE_CONFLICT');
    if (!viejo.ok) expect(viejo.error.details).toMatchObject({ reason: 'stale_transition' });
  });

  it('transportadora y guía solo al enviar; el motivo solo al cancelar; pending no es destino', async () => {
    const { ci } = await nuevaParticipacion(op, 'Campos', [e.productos.p80]);
    const s = await nuevoEnvio(ci, e.productos.p80);
    const base = { shipmentId: s.id, expectedSeq: s.rowSeq, idempotencyKey: unico('k') };
    expect(codigo(await transicionarEnvio(e.operativo, { ...base, to: 'prepared', carrier: 'X' }))).toBe(
      'VALIDATION_FAILED',
    );
    expect(codigo(await transicionarEnvio(e.operativo, { ...base, to: 'prepared', cancelReason: 'x' }))).toBe(
      'VALIDATION_FAILED',
    );
    expect(codigo(await transicionarEnvio(e.operativo, { ...base, to: 'pending' }))).toBe(
      'VALIDATION_FAILED',
    );
  });
});

describe('preparar: asignado ≠ comprometido', () => {
  it('un producto NO asignado a la participación no se prepara (y el envío sigue pending)', async () => {
    const { ci } = await nuevaParticipacion(op, 'No asignado'); // sin productos
    const s = await nuevoEnvio(ci, e.productos.p80);
    const r = await transicionarEnvio(e.operativo, {
      shipmentId: s.id,
      to: 'prepared',
      expectedSeq: s.rowSeq,
      idempotencyKey: unico('p'),
    });
    expect(codigo(r)).toBe('RESOURCE_CONFLICT');
    if (!r.ok)
      expect(r.error.details).toMatchObject({ reason: 'preparation_failed', failures: ['not_assigned'] });
    const bd = await fila<{ status: string }>(`SELECT status FROM shipments WHERE id = $1`, [s.id]);
    expect(bd.status).toBe('pending');
  });

  it('con acuerdo barter/mixed el producto debe estar además COMPROMETIDO en la versión vigente', async () => {
    const { ci } = await nuevaParticipacion(op, 'Canje', [e.productos.p80, e.productos.pro]);
    await crearAcuerdoPorSql(op, { ci, mode: 'mixed', productos: [[e.productos.p80, 1]] });
    const sinCompromiso = await nuevoEnvio(ci, e.productos.pro);
    const r = await transicionarEnvio(e.operativo, {
      shipmentId: sinCompromiso.id,
      to: 'prepared',
      expectedSeq: sinCompromiso.rowSeq,
      idempotencyKey: unico('p'),
    });
    expect(codigo(r)).toBe('RESOURCE_CONFLICT');
    if (!r.ok)
      expect(r.error.details).toMatchObject({ reason: 'preparation_failed', failures: ['not_committed'] });
    const comprometido = await nuevoEnvio(ci, e.productos.p80);
    expect((await paso(comprometido, 'prepared')).status).toBe('prepared');
  });

  it('con acuerdo solo de tarifa (fee) basta con que esté asignado', async () => {
    const { ci } = await nuevaParticipacion(op, 'Fee', [e.productos.p80]);
    await crearAcuerdoPorSql(op, { ci, mode: 'fee' });
    expect((await paso(await nuevoEnvio(ci, e.productos.p80), 'prepared')).status).toBe('prepared');
  });
});

describe('datos personales y costo: solo por referencia y por capacidad', () => {
  it('piiRecordId exige pii:manage y pertenecer al MISMO influencer; el envío solo expone un booleano', async () => {
    const { ci, influencerId } = await nuevaParticipacion(op, 'Pii', [e.productos.p80]);
    const otra = await nuevaParticipacion(op, 'Pii otra', [e.productos.p80]);
    const piiPropio = await insertarPiiPorSql(op, influencerId);
    const piiOtro = await insertarPiiPorSql(op, otra.influencerId);
    const entrada = {
      campaignInfluencerId: ci,
      items: [{ campaignProductId: e.productos.p80, quantity: 1 }],
    };

    // director: shipment:manage pero NO pii:manage
    expect(
      codigo(
        await crearEnvio(e.director, { ...entrada, piiRecordId: piiPropio, idempotencyKey: unico('p') }),
      ),
    ).toBe('FORBIDDEN_ROLE');
    // de otro influencer ⇒ validación
    expect(
      codigo(await crearEnvio(e.operativo, { ...entrada, piiRecordId: piiOtro, idempotencyKey: unico('p') })),
    ).toBe('VALIDATION_FAILED');
    // inexistente ⇒ no encontrado
    expect(
      codigo(
        await crearEnvio(e.operativo, {
          ...entrada,
          piiRecordId: '00000000-0000-4000-8000-000000000000',
          idempotencyKey: unico('p'),
        }),
      ),
    ).toBe('RESOURCE_NOT_FOUND');
    const ok = exito(
      await crearEnvio(e.operativo, { ...entrada, piiRecordId: piiPropio, idempotencyKey: unico('p') }),
    );
    expect(ok.envio.tienePii).toBe(true);
    // el operativo (pii:read) recibe el id opaco; NUNCA dirección, teléfono o cédula
    expect(ok.envio.piiRecordId).toBe(piiPropio);
    const texto = JSON.stringify(ok.envio);
    for (const prohibido of ['address', 'phone', 'document', 'direccion', 'telefono', 'cedula']) {
      expect(texto.toLowerCase()).not.toContain(prohibido);
    }
  });

  it('proyección: el costo solo con finance:read; el consultor ve estado y fechas sin costo ni referencia de PII', async () => {
    const { ci, influencerId } = await nuevaParticipacion(op, 'Proyección', [e.productos.p80]);
    const pii = await insertarPiiPorSql(op, influencerId);
    const s = exito(
      await crearEnvio(e.operativo, {
        campaignInfluencerId: ci,
        items: [{ campaignProductId: e.productos.p80, quantity: 1 }],
        shippingCost: '15000.5',
        shippingCurrency: 'COP',
        piiRecordId: pii,
        idempotencyKey: unico('pr'),
      }),
    ).envio;
    expect(s).toMatchObject({ shippingCost: '15000.50', shippingCurrency: 'COP' });

    const consultor = exito(await listarEnviosDeParticipacion(e.consultor, ci));
    expect(consultor).toHaveLength(1);
    expect(consultor[0]).toMatchObject({ id: s.id, status: 'pending', tienePii: true });
    expect(consultor[0]).not.toHaveProperty('shippingCost');
    expect(consultor[0]).not.toHaveProperty('shippingCurrency');
    expect(consultor[0]).not.toHaveProperty('piiRecordId');
    expect(JSON.stringify(consultor)).not.toContain('15000');

    const unoSolo = exito(await obtenerEnvio(e.consultor, s.id));
    expect(unoSolo).not.toHaveProperty('shippingCost');

    const director = exito(await obtenerEnvio(e.director, s.id));
    expect(director.shippingCost).toBe('15000.50');
    expect(director).not.toHaveProperty('piiRecordId'); // director: finance:read pero no pii:read
    const operativo = exito(await obtenerEnvio(e.operativo, s.id));
    expect(operativo.shippingCost).toBe('15000.50');
  });

  it('lecturas: ajeno y cliente ⇒ RESOURCE_NOT_FOUND; un rol sin shipment:read ⇒ FORBIDDEN_ROLE', async () => {
    const { ci } = await nuevaParticipacion(op, 'Lecturas', [e.productos.p80]);
    const s = await nuevoEnvio(ci, e.productos.p80);
    for (const actor of [e.ajeno, e.cliente]) {
      expect(codigo(await listarEnviosDeParticipacion(actor, ci)), actor.role).toBe('RESOURCE_NOT_FOUND');
      expect(codigo(await obtenerEnvio(actor, s.id)), actor.role).toBe('RESOURCE_NOT_FOUND');
    }
    expect(codigo(await obtenerEnvio(e.legal, s.id))).toBe('FORBIDDEN_ROLE');
    expect(codigo(await obtenerEnvio(e.operativo, 'no-uuid'))).toBe('RESOURCE_NOT_FOUND');
  });
});

describe('solo personas por la UI', () => {
  it('el chat y el sistema no crean ni mueven envíos', async () => {
    const { ci } = await nuevaParticipacion(op, 'Chat', [e.productos.p80]);
    const entrada = {
      campaignInfluencerId: ci,
      items: [{ campaignProductId: e.productos.p80, quantity: 1 }],
      idempotencyKey: unico('chat'),
    };
    expect(codigo(await crearEnvio(e.operativo, entrada, { origin: 'chat' }))).toBe(
      'HUMAN_CONFIRMATION_REQUIRED',
    );
    expect(codigo(await crearEnvio(e.operativo, entrada, { origin: 'system' }))).toBe('FORBIDDEN_ROLE');
    const s = await nuevoEnvio(ci, e.productos.p80);
    const r = await transicionarEnvio(
      e.operativo,
      { shipmentId: s.id, to: 'prepared', expectedSeq: s.rowSeq, idempotencyKey: unico('chat2') },
      { origin: 'chat' },
    );
    expect(codigo(r)).toBe('HUMAN_CONFIRMATION_REQUIRED');
    const n = await fila<{ n: string }>(
      `SELECT count(*) AS n FROM shipments WHERE campaign_influencer_id = $1`,
      [ci],
    );
    expect(Number(n.n)).toBe(1);
  });
});
