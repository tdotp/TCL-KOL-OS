import { describe, expect, it } from 'vitest';
import {
  AGREEMENT_TRANSITIONS,
  cambiaTerminosEconomicos,
  compromisosRetirados,
  MONEDAS_ISO_4217,
  esMonedaValida,
  normalizarMonto,
  obligacionCoherenteConModo,
  obligacionInicialPara,
  puedeTransicionarAcuerdo,
  puedeVersionarAcuerdo,
  requiereCompromisos,
  requiereMonto,
  validarMontoYMonedaPorModo,
  validarMotivoDeCancelacionDeAcuerdo,
  validarTerminosDeAcuerdo,
  type CompensationType,
} from './agreements';

describe('grafo del acuerdo', () => {
  it('active → cancelled; cancelled es terminal; no hay self-loops', () => {
    expect(puedeTransicionarAcuerdo('active', 'cancelled')).toBe(true);
    expect(puedeTransicionarAcuerdo('cancelled', 'active')).toBe(false);
    expect(puedeTransicionarAcuerdo('active', 'active')).toBe(false);
    expect(AGREEMENT_TRANSITIONS.cancelled).toEqual([]);
  });
});

describe('monto y moneda por modo', () => {
  it('normalizarMonto devuelve la cadena canónica y rechaza lo dudoso', () => {
    expect(normalizarMonto(1500000)).toEqual(expect.objectContaining({ ok: true, value: '1500000.00' }));
    expect(normalizarMonto('1500000.5')).toEqual(expect.objectContaining({ ok: true, value: '1500000.50' }));
    expect(normalizarMonto('007.10')).toEqual(expect.objectContaining({ ok: true, value: '7.10' }));
    expect(normalizarMonto(0.1 + 0.2)).toEqual(expect.objectContaining({ ok: true, value: '0.30' }));
    expect(normalizarMonto(0.123).ok).toBe(false);
    for (const malo of [
      0,
      -5,
      '0',
      '0.00',
      '1e3',
      '1,000.00',
      '12.345',
      'abc',
      NaN,
      Infinity,
      null,
      undefined,
      '',
      '1234567890123',
    ]) {
      expect(normalizarMonto(malo).ok, String(malo)).toBe(false);
    }
  });

  it('moneda: tres letras mayúsculas', () => {
    expect(esMonedaValida('COP')).toBe(true);
    for (const mala of ['cop', 'CO', 'COPP', 'C0P', '', null, 3]) expect(esMonedaValida(mala)).toBe(false);
  });

  it('barter no lleva monto ni moneda; fee/mixed exigen ambos', () => {
    expect(validarMontoYMonedaPorModo('barter', undefined, undefined).ok).toBe(true);
    expect(validarMontoYMonedaPorModo('barter', 100, undefined).ok).toBe(false);
    expect(validarMontoYMonedaPorModo('barter', undefined, 'COP').ok).toBe(false);
    for (const modo of ['fee', 'mixed'] as const) {
      expect(validarMontoYMonedaPorModo(modo, 100, 'COP').ok).toBe(true);
      expect(validarMontoYMonedaPorModo(modo, undefined, 'COP').ok).toBe(false);
      expect(validarMontoYMonedaPorModo(modo, 100, undefined).ok).toBe(false);
      expect(validarMontoYMonedaPorModo(modo, 0, 'COP').ok).toBe(false);
      expect(validarMontoYMonedaPorModo(modo, 100, 'cop').ok).toBe(false);
    }
  });
});

describe('regla barter ⇒ not_applicable', () => {
  it('estado inicial de la obligación según el modo', () => {
    expect(obligacionInicialPara('barter')).toBe('not_applicable');
    expect(obligacionInicialPara('fee')).toBe('pending');
    expect(obligacionInicialPara('mixed')).toBe('pending');
  });

  it('coherencia obligación/modo (espejo del invariante diferido)', () => {
    const estados = ['not_applicable', 'pending', 'reported_paid', 'cancelled'] as const;
    const esperado: Record<CompensationType, readonly string[]> = {
      barter: ['not_applicable', 'cancelled'],
      fee: ['pending', 'reported_paid', 'cancelled'],
      mixed: ['pending', 'reported_paid', 'cancelled'],
    };
    for (const modo of ['barter', 'fee', 'mixed'] as const) {
      for (const estado of estados) {
        expect(obligacionCoherenteConModo(modo, estado), `${modo}/${estado}`).toBe(
          esperado[modo].includes(estado),
        );
      }
    }
    expect(requiereMonto('barter')).toBe(false);
    expect(requiereCompromisos('fee')).toBe(false);
    expect(requiereCompromisos('mixed')).toBe(true);
  });
});

describe('validarTerminosDeAcuerdo', () => {
  const p1 = { campaignProductId: 'p1', quantity: 2 };
  it('canje: sin monto, con compromisos', () => {
    const r = validarTerminosDeAcuerdo({ compensationType: 'barter', commitments: [p1] });
    expect(r.ok).toBe(true);
    expect(validarTerminosDeAcuerdo({ compensationType: 'barter' }).ok).toBe(false);
    expect(
      validarTerminosDeAcuerdo({
        compensationType: 'barter',
        feeAmount: 10,
        feeCurrency: 'COP',
        commitments: [p1],
      }).ok,
    ).toBe(false);
  });

  it('fee: con monto y sin compromisos; mixed: con ambos', () => {
    expect(
      validarTerminosDeAcuerdo({ compensationType: 'fee', feeAmount: '2000000', feeCurrency: 'COP' }).ok,
    ).toBe(true);
    expect(
      validarTerminosDeAcuerdo({
        compensationType: 'fee',
        feeAmount: 2,
        feeCurrency: 'COP',
        commitments: [p1],
      }).ok,
    ).toBe(false);
    expect(
      validarTerminosDeAcuerdo({
        compensationType: 'mixed',
        feeAmount: 2,
        feeCurrency: 'USD',
        commitments: [p1],
      }).ok,
    ).toBe(true);
    expect(validarTerminosDeAcuerdo({ compensationType: 'mixed', feeAmount: 2, feeCurrency: 'USD' }).ok).toBe(
      false,
    );
  });

  it('productos repetidos, cantidades y fechas', () => {
    expect(validarTerminosDeAcuerdo({ compensationType: 'barter', commitments: [p1, p1] }).ok).toBe(false);
    for (const quantity of [0, -1, 1.5, 100001]) {
      expect(
        validarTerminosDeAcuerdo({
          compensationType: 'barter',
          commitments: [{ campaignProductId: 'p1', quantity }],
        }).ok,
      ).toBe(false);
    }
    expect(
      validarTerminosDeAcuerdo({
        compensationType: 'barter',
        commitments: [p1],
        startsOn: '2026-11-01',
        endsOn: '2026-10-01',
      }).ok,
    ).toBe(false);
    expect(
      validarTerminosDeAcuerdo({ compensationType: 'barter', commitments: [p1], startsOn: '2026-13-01' }).ok,
    ).toBe(false);
    expect(validarTerminosDeAcuerdo({ compensationType: 'canje' }).ok).toBe(false);
  });

  it('una versión posterior a la 1 exige el motivo del cambio', () => {
    const base = { compensationType: 'fee', feeAmount: 10, feeCurrency: 'COP' } as const;
    expect(validarTerminosDeAcuerdo(base, 1).ok).toBe(true);
    expect(validarTerminosDeAcuerdo(base, 2).ok).toBe(false);
    expect(validarTerminosDeAcuerdo({ ...base, changeReason: 'Renegociación' }, 2).ok).toBe(true);
    expect(validarTerminosDeAcuerdo({ ...base, conditions: 'x'.repeat(4001) }).ok).toBe(false);
  });
});

describe('versionar con el pago reportado', () => {
  const prev = { compensationType: 'fee', feeAmount: '100.00', feeCurrency: 'COP' } as const;
  it('detecta cambios económicos', () => {
    expect(cambiaTerminosEconomicos(prev, prev)).toBe(false);
    expect(cambiaTerminosEconomicos(prev, { ...prev, feeAmount: '101.00' })).toBe(true);
    expect(cambiaTerminosEconomicos(prev, { ...prev, feeCurrency: 'USD' })).toBe(true);
    expect(
      cambiaTerminosEconomicos(prev, { compensationType: 'mixed', feeAmount: '100.00', feeCurrency: 'COP' }),
    ).toBe(true);
  });

  it('reported_paid bloquea el cambio económico, no el resto', () => {
    expect(puedeVersionarAcuerdo(prev, { ...prev, feeAmount: '1.00' }, 'reported_paid').ok).toBe(false);
    expect(puedeVersionarAcuerdo(prev, prev, 'reported_paid').ok).toBe(true);
    expect(puedeVersionarAcuerdo(prev, { ...prev, feeAmount: '1.00' }, 'pending').ok).toBe(true);
  });

  it('lista los compromisos que una versión retira', () => {
    expect(
      compromisosRetirados(
        [
          { campaignProductId: 'a', quantity: 1 },
          { campaignProductId: 'b', quantity: 1 },
        ],
        [{ campaignProductId: 'b', quantity: 2 }],
      ),
    ).toEqual(['a']);
  });
});

describe('endurecimiento (FIX-B): moneda ISO 4217 cerrada, fechas en rango y texto sin control', () => {
  it('la moneda es de una lista cerrada: COP, USD, EUR, MXN… sí; ABC, XXX, cop y vacío, no', () => {
    for (const m of ['USD', 'COP', 'EUR', 'MXN', 'BRL', 'ARS', 'CLP', 'PEN', 'GBP', 'CAD', 'CNY', 'JPY']) {
      expect(esMonedaValida(m), m).toBe(true);
      expect(MONEDAS_ISO_4217).toContain(m);
    }
    for (const m of ['ABC', 'XXX', 'cop', 'COPP', '', 'US', null, undefined, 12]) {
      expect(esMonedaValida(m), String(m)).toBe(false);
    }
    expect(validarMontoYMonedaPorModo('fee', 100, 'ABC').ok).toBe(false);
  });

  const base = { compensationType: 'fee', feeAmount: 100, feeCurrency: 'COP' } as const;

  it('una fecha fuera del calendario o del rango de Postgres (0000-01-01) es validación, no un 500', () => {
    for (const startsOn of ['0000-01-01', '1899-12-31', '2026-02-30', '2026-13-01']) {
      const r = validarTerminosDeAcuerdo({ ...base, startsOn });
      expect(r.ok, startsOn).toBe(false);
      if (!r.ok) expect(r.error.details).toMatchObject({ field: 'startsOn' });
    }
    expect(validarTerminosDeAcuerdo({ ...base, startsOn: '2026-01-31', endsOn: '2026-12-31' }).ok).toBe(true);
  });

  it('NUL, control, invisibles y bidi en conditions o motivo de cambio se rechazan; el salto de línea no', () => {
    for (const mala of ['a\u0000b', 'pagar \u202Eodagap\u202C antes', 'a\u200Bb', 'a\u0007b']) {
      const r = validarTerminosDeAcuerdo({ ...base, conditions: mala });
      expect(r.ok, JSON.stringify(mala)).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('VALIDATION_FAILED');
      expect(validarTerminosDeAcuerdo({ ...base, changeReason: mala }, 2).ok, JSON.stringify(mala)).toBe(
        false,
      );
    }
    expect(validarTerminosDeAcuerdo({ ...base, conditions: 'línea 1\nlínea 2\tcon tab' }).ok).toBe(true);
  });

  it('el motivo de cancelación del acuerdo es obligatorio, ≤ 500 y sin control/bidi', () => {
    expect(validarMotivoDeCancelacionDeAcuerdo('  Se acordó cerrar  ')).toEqual(
      expect.objectContaining({ ok: true, value: 'Se acordó cerrar' }),
    );
    for (const malo of ['', '   ', 'x'.repeat(501), 'a\u0000b', 'a\u202Eb', 7, undefined]) {
      expect(validarMotivoDeCancelacionDeAcuerdo(malo).ok, JSON.stringify(malo)).toBe(false);
    }
  });
});
