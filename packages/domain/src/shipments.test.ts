import { describe, expect, it } from 'vitest';
import {
  EVENTO_DE_ENVIO_POR_DESTINO,
  SHIPMENT_STATUSES,
  SHIPMENT_TRANSITIONS,
  esEnvioAbierto,
  esEnvioTerminal,
  evaluarPreparacionDeEnvio,
  puedeDesasignarProducto,
  puedePrepararEnvio,
  puedeTransicionarEnvio,
  validarDatosDeEnvio,
  validarItemsDeEnvio,
  validarMotivoDeCancelacion,
  validarOrdenDeFechasDeEnvio,
} from './shipments';
import { canTransitionOperationalSubject, eventTypesForTransition } from './operational-events';

describe('grafo del envío', () => {
  it('camino feliz y cancelaciones', () => {
    expect(puedeTransicionarEnvio('pending', 'prepared')).toBe(true);
    expect(puedeTransicionarEnvio('prepared', 'shipped')).toBe(true);
    expect(puedeTransicionarEnvio('shipped', 'delivered')).toBe(true);
    expect(puedeTransicionarEnvio('pending', 'cancelled')).toBe(true);
    expect(puedeTransicionarEnvio('prepared', 'cancelled')).toBe(true);
    expect(puedeTransicionarEnvio('shipped', 'failed')).toBe(true);
    expect(puedeTransicionarEnvio('shipped', 'returned')).toBe(true);
    expect(puedeTransicionarEnvio('delivered', 'returned')).toBe(true);
  });

  it('delivered jamás se alcanza saltando pasos', () => {
    for (const desde of SHIPMENT_STATUSES.filter((s) => s !== 'shipped')) {
      expect(puedeTransicionarEnvio(desde, 'delivered'), desde).toBe(false);
    }
  });

  it('terminales: cancelled, failed, returned; shipped no se cancela', () => {
    for (const t of ['cancelled', 'failed', 'returned'] as const) expect(esEnvioTerminal(t)).toBe(true);
    expect(esEnvioTerminal('delivered')).toBe(false);
    expect(puedeTransicionarEnvio('shipped', 'cancelled')).toBe(false);
    expect(puedeTransicionarEnvio('cancelled', 'pending')).toBe(false);
    expect(esEnvioAbierto('shipped')).toBe(true);
    expect(esEnvioAbierto('delivered')).toBe(false);
  });

  it('PARIDAD con las aristas de eventos (base 031): el mismo grafo', () => {
    for (const desde of SHIPMENT_STATUSES) {
      for (const hacia of SHIPMENT_STATUSES) {
        expect(canTransitionOperationalSubject('shipment', desde, hacia), `${desde}→${hacia}`).toBe(
          puedeTransicionarEnvio(desde, hacia),
        );
        if (puedeTransicionarEnvio(desde, hacia)) {
          expect(eventTypesForTransition('shipment', desde, hacia)).toEqual([
            EVENTO_DE_ENVIO_POR_DESTINO[hacia],
          ]);
        }
      }
    }
    expect(Object.keys(SHIPMENT_TRANSITIONS).sort()).toEqual([...SHIPMENT_STATUSES].sort());
  });
});

describe('datos del envío', () => {
  it('costo y moneda van juntos; el costo puede ser cero', () => {
    expect(validarDatosDeEnvio({ carrier: ' Servientrega ', trackingRef: 'GUIA-1' }).ok).toBe(true);
    expect(validarDatosDeEnvio({ shippingCost: 12000 }).ok).toBe(false);
    expect(validarDatosDeEnvio({ shippingCurrency: 'COP' }).ok).toBe(false);
    const r = validarDatosDeEnvio({ shippingCost: 0, shippingCurrency: 'COP' });
    expect(r.ok && r.value.shippingCost).toBe('0.00');
    expect(validarDatosDeEnvio({ shippingCost: -1, shippingCurrency: 'COP' }).ok).toBe(false);
    expect(validarDatosDeEnvio({ shippingCost: 5, shippingCurrency: 'cop' }).ok).toBe(false);
    expect(validarDatosDeEnvio({ carrier: 'x'.repeat(121) }).ok).toBe(false);
    expect(validarDatosDeEnvio({ trackingRef: 'a\u0000b' }).ok).toBe(false);
  });

  it('el motivo de cancelación es obligatorio', () => {
    expect(validarMotivoDeCancelacion('  ').ok).toBe(false);
    expect(validarMotivoDeCancelacion(undefined).ok).toBe(false);
    expect(validarMotivoDeCancelacion('El KOL desistió').ok).toBe(true);
  });
});

describe('ítems y preparación', () => {
  it('ítems: ≥1, sin repetidos, cantidad entera', () => {
    expect(validarItemsDeEnvio([]).ok).toBe(false);
    expect(validarItemsDeEnvio([{ campaignProductId: 'a', quantity: 1 }]).ok).toBe(true);
    expect(
      validarItemsDeEnvio([
        { campaignProductId: 'a', quantity: 1 },
        { campaignProductId: 'a', quantity: 2 },
      ]).ok,
    ).toBe(false);
    expect(validarItemsDeEnvio([{ campaignProductId: 'a', quantity: 0 }]).ok).toBe(false);
  });

  it('preparar: asignado siempre; comprometido solo si el acuerdo es barter/mixed', () => {
    const items = [{ campaignProductId: 'a', quantity: 1 }];
    expect(puedePrepararEnvio({ items: [], assignedProductIds: ['a'] })).toBe(false);
    expect(evaluarPreparacionDeEnvio({ items, assignedProductIds: [] })).toEqual([
      { reason: 'not_assigned', campaignProductId: 'a' },
    ]);
    expect(puedePrepararEnvio({ items, assignedProductIds: ['a'] })).toBe(true);
    expect(
      puedePrepararEnvio({ items, assignedProductIds: ['a'], agreementMode: 'fee', committedProductIds: [] }),
    ).toBe(true);
    for (const modo of ['barter', 'mixed'] as const) {
      expect(
        evaluarPreparacionDeEnvio({
          items,
          assignedProductIds: ['a'],
          agreementMode: modo,
          committedProductIds: [],
        }),
      ).toEqual([{ reason: 'not_committed', campaignProductId: 'a' }]);
      expect(
        puedePrepararEnvio({
          items,
          assignedProductIds: ['a'],
          agreementMode: modo,
          committedProductIds: ['a'],
        }),
      ).toBe(true);
    }
  });

  it('desasignar: ni comprometido en la versión vigente ni en un envío abierto', () => {
    expect(puedeDesasignarProducto({ committedInCurrentVersion: true, shipmentStatuses: [] }).ok).toBe(false);
    for (const s of ['pending', 'prepared', 'shipped'] as const) {
      expect(puedeDesasignarProducto({ committedInCurrentVersion: false, shipmentStatuses: [s] }).ok).toBe(
        false,
      );
    }
    for (const s of ['delivered', 'cancelled', 'failed', 'returned'] as const) {
      expect(puedeDesasignarProducto({ committedInCurrentVersion: false, shipmentStatuses: [s] }).ok).toBe(
        true,
      );
    }
  });
});

describe('«entregado» no se fecha antes que «enviado» (FIX-B)', () => {
  it('antes ⇒ VALIDATION_FAILED en happenedOn; el mismo día y después valen; sin fecha de envío, nada que comparar', () => {
    const antes = validarOrdenDeFechasDeEnvio('2026-05-10', '2026-05-09');
    expect(antes.ok).toBe(false);
    if (!antes.ok) {
      expect(antes.error.code).toBe('VALIDATION_FAILED');
      expect(antes.error.details).toMatchObject({ field: 'happenedOn', reason: 'delivered_before_shipped' });
    }
    expect(validarOrdenDeFechasDeEnvio('2026-05-10', '2026-05-10').ok).toBe(true);
    expect(validarOrdenDeFechasDeEnvio('2026-05-10', '2026-06-01').ok).toBe(true);
    expect(validarOrdenDeFechasDeEnvio(null, '2026-05-09').ok).toBe(true);
    expect(validarOrdenDeFechasDeEnvio('2026-05-10', undefined).ok).toBe(true);
  });

  it('la moneda del costo del envío es de la lista cerrada', () => {
    expect(validarDatosDeEnvio({ shippingCost: 5000, shippingCurrency: 'ABC' }).ok).toBe(false);
    expect(validarDatosDeEnvio({ shippingCost: 5000, shippingCurrency: 'COP' }).ok).toBe(true);
  });
});
