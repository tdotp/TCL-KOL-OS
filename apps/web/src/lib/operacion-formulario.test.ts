import { describe, expect, it } from 'vitest';
import {
  extensionDeEvidenciaPermitida,
  leerCancelacionDeAcuerdo,
  leerCorreccionDeMedicion,
  leerCrearAcuerdo,
  leerCrearEnvio,
  leerEntradaDeEvidencia,
  leerMedicionDeKpi,
  leerNotaDeCorreccion,
  leerNuevaVersionDeAcuerdo,
  leerObjetivoDeKpi,
  leerPiiAGuardar,
  leerReporteDePago,
  leerTransicionDeDocumento,
  leerTransicionDeEnvio,
  origenPermitidoEstricto,
} from './operacion-formulario.ts';

const U1 = '11111111-1111-4111-8111-111111111111';
const U2 = '22222222-2222-4222-8222-222222222222';
const U3 = '33333333-3333-4333-8333-333333333333';
const HASH = 'a'.repeat(64);

function form(campos: Record<string, string | string[]>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(campos)) {
    for (const x of Array.isArray(v) ? v : [v]) fd.append(k, x);
  }
  return fd;
}

describe('leerCrearAcuerdo', () => {
  const base = {
    participacionId: U1,
    idempotencyKey: 'clave-1',
    compensationType: 'fee',
    feeAmount: '1500000',
    feeCurrency: 'cop',
  };

  it('normaliza el monto a 2 decimales y la moneda a mayúsculas', () => {
    const r = leerCrearAcuerdo(form(base));
    expect(r).toMatchObject({
      ok: true,
      value: {
        campaignInfluencerId: U1,
        compensationType: 'fee',
        feeAmount: '1500000.00',
        feeCurrency: 'COP',
        commitments: [],
      },
    });
  });

  it('lee filas alineadas de compromisos e ignora filas vacías', () => {
    const r = leerCrearAcuerdo(
      form({
        participacionId: U1,
        idempotencyKey: 'k',
        compensationType: 'barter',
        commitmentProductId: [U2, ''],
        commitmentQuantity: ['3', ''],
      }),
    );
    expect(r).toMatchObject({ ok: true, value: { commitments: [{ campaignProductId: U2, quantity: 3 }] } });
  });

  it('no deja pasar organización, rol, origen ni autor del formulario', () => {
    const r = leerCrearAcuerdo(
      form({ ...base, organizationId: U3, role: 'admin', origin: 'chat', createdBy: U3, campaignId: U3 }),
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      const claves = Object.keys(r.value);
      for (const prohibida of ['organizationId', 'role', 'origin', 'createdBy', 'campaignId']) {
        expect(claves).not.toContain(prohibida);
      }
    }
  });

  it.each([
    ['sin clave de idempotencia', { ...base, idempotencyKey: '' }, 'idempotencyKey'],
    ['participación que no es uuid', { ...base, participacionId: 'no-es-uuid' }, 'participacionId'],
    ['modo fuera del enum', { ...base, compensationType: 'regalo' }, 'compensationType'],
    ['monto con coma', { ...base, feeAmount: '1.500,50' }, 'feeAmount'],
    ['monto con 3 decimales', { ...base, feeAmount: '10.123' }, 'feeAmount'],
    ['monto negativo', { ...base, feeAmount: '-5' }, 'feeAmount'],
    ['moneda de 2 letras', { ...base, feeCurrency: 'CO' }, 'feeCurrency'],
    ['fecha inexistente', { ...base, startsOn: '2026-02-31' }, 'startsOn'],
    ['fin anterior al inicio', { ...base, startsOn: '2026-05-10', endsOn: '2026-05-01' }, 'endsOn'],
  ])('rechaza %s', (_nombre, campos, campo) => {
    const r = leerCrearAcuerdo(form(campos));
    expect(r).toMatchObject({ ok: false, field: campo });
  });

  it('rechaza una fila con producto y sin cantidad, y cantidades fuera de rango', () => {
    expect(
      leerCrearAcuerdo(form({ ...base, commitmentProductId: [U2], commitmentQuantity: [''] })),
    ).toMatchObject({ ok: false, field: 'commitmentProductId' });
    expect(
      leerCrearAcuerdo(form({ ...base, commitmentProductId: [U2], commitmentQuantity: ['0'] })),
    ).toMatchObject({ ok: false, field: 'commitmentQuantity' });
    expect(
      leerCrearAcuerdo(form({ ...base, commitmentProductId: [U2, U3], commitmentQuantity: ['1'] })),
    ).toMatchObject({ ok: false, field: 'commitmentProductId' });
  });

  it('rechaza algo que no es un FormData', () => {
    expect(leerCrearAcuerdo({ participacionId: U1 })).toMatchObject({ ok: false, field: 'form' });
  });

  it('un archivo en un campo de texto no es un valor válido', () => {
    const fd = form(base);
    fd.set('conditions', new File(['x'], 'a.txt'));
    expect(leerCrearAcuerdo(fd)).toMatchObject({ ok: false, field: 'conditions' });
  });
});

describe('versiones y cancelación de acuerdo', () => {
  it('la versión nueva exige expectedVersion, motivo y clave', () => {
    const ok = {
      agreementId: U1,
      compensationType: 'mixed',
      feeAmount: '100.5',
      feeCurrency: 'USD',
      changeReason: 'Cambió el alcance',
      expectedVersion: '2',
      idempotencyKey: 'k',
      commitmentProductId: [U2],
      commitmentQuantity: ['1'],
    };
    expect(leerNuevaVersionDeAcuerdo(form(ok))).toMatchObject({
      ok: true,
      value: {
        agreementId: U1,
        input: { expectedVersion: 2, feeAmount: '100.50', changeReason: 'Cambió el alcance' },
      },
    });
    expect(leerNuevaVersionDeAcuerdo(form({ ...ok, expectedVersion: '' }))).toMatchObject({
      ok: false,
      field: 'expectedVersion',
    });
    expect(leerNuevaVersionDeAcuerdo(form({ ...ok, expectedVersion: '-1' }))).toMatchObject({
      ok: false,
      field: 'expectedVersion',
    });
    expect(leerNuevaVersionDeAcuerdo(form({ ...ok, changeReason: '  ' }))).toMatchObject({
      ok: false,
      field: 'changeReason',
    });
  });

  it('cancelar exige motivo', () => {
    expect(leerCancelacionDeAcuerdo(form({ agreementId: U1, idempotencyKey: 'k' }))).toMatchObject({
      ok: false,
      field: 'reason',
    });
    expect(
      leerCancelacionDeAcuerdo(form({ agreementId: U1, idempotencyKey: 'k', reason: 'Se cayó' })),
    ).toMatchObject({
      ok: true,
    });
  });
});

describe('envíos', () => {
  it('crear: al menos un producto; costo y moneda normalizados', () => {
    const base = { participacionId: U1, idempotencyKey: 'k' };
    expect(leerCrearEnvio(form(base))).toMatchObject({ ok: false, field: 'itemProductId' });
    expect(
      leerCrearEnvio(
        form({
          ...base,
          itemProductId: [U2],
          itemQuantity: ['2'],
          shippingCost: '25000',
          shippingCurrency: 'cop',
          carrier: 'Servientrega',
        }),
      ),
    ).toMatchObject({
      ok: true,
      value: {
        items: [{ campaignProductId: U2, quantity: 2 }],
        shippingCost: '25000.00',
        shippingCurrency: 'COP',
        carrier: 'Servientrega',
      },
    });
  });

  it('transicionar: destino de la lista cerrada (nunca pending) y expectedSeq', () => {
    const base = {
      shipmentId: U1,
      expectedSeq: '3',
      idempotencyKey: 'k',
      to: 'shipped',
      happenedOn: '2026-05-04',
    };
    expect(leerTransicionDeEnvio(form(base))).toMatchObject({
      ok: true,
      value: { shipmentId: U1, to: 'shipped', expectedSeq: 3, happenedOn: '2026-05-04' },
    });
    expect(leerTransicionDeEnvio(form({ ...base, to: 'pending' }))).toMatchObject({ ok: false, field: 'to' });
    expect(leerTransicionDeEnvio(form({ ...base, to: 'inventado' }))).toMatchObject({
      ok: false,
      field: 'to',
    });
    expect(leerTransicionDeEnvio(form({ ...base, expectedSeq: 'x' }))).toMatchObject({
      ok: false,
      field: 'expectedSeq',
    });
    expect(leerTransicionDeEnvio(form({ ...base, happenedOn: '04/05/2026' }))).toMatchObject({
      ok: false,
      field: 'happenedOn',
    });
  });
});

describe('documentos de cobro y pagos', () => {
  it('transición de documento', () => {
    expect(
      leerTransicionDeDocumento(
        form({ billingDocumentId: U1, expectedSeq: '1', idempotencyKey: 'k', note: 'Falta firma' }),
      ),
    ).toMatchObject({ ok: true, value: { billingDocumentId: U1, expectedSeq: 1, note: 'Falta firma' } });
    expect(leerTransicionDeDocumento(form({ billingDocumentId: U1, idempotencyKey: 'k' }))).toMatchObject({
      ok: false,
      field: 'expectedSeq',
    });
  });

  it('reportar un pago exige fecha y referencia', () => {
    const base = {
      paymentObligationId: U1,
      expectedSeq: '1',
      idempotencyKey: 'k',
      paidOn: '2026-05-04',
      externalReference: 'TRX-9',
    };
    expect(leerReporteDePago(form(base))).toMatchObject({
      ok: true,
      value: { paidOn: '2026-05-04', externalReference: 'TRX-9' },
    });
    expect(leerReporteDePago(form({ ...base, paidOn: '' }))).toMatchObject({ ok: false, field: 'paidOn' });
    expect(leerReporteDePago(form({ ...base, externalReference: ' ' }))).toMatchObject({
      ok: false,
      field: 'externalReference',
    });
  });

  it('la nota de corrección exige nota', () => {
    const base = { paymentObligationId: U1, expectedSeq: '2', idempotencyKey: 'k' };
    expect(leerNotaDeCorreccion(form(base))).toMatchObject({ ok: false, field: 'note' });
    expect(
      leerNotaDeCorreccion(form({ ...base, note: 'Referencia mal digitada', externalReference: 'TRX-10' })),
    ).toMatchObject({
      ok: true,
    });
  });

  it('una nota con caracteres de control o bidi se rechaza', () => {
    const r = leerNotaDeCorreccion(
      form({ paymentObligationId: U1, expectedSeq: '2', idempotencyKey: 'k', note: 'ok‮evil' }),
    );
    expect(r).toMatchObject({ ok: false, field: 'note' });
  });
});

describe('KPIs', () => {
  const base = { participacionId: U1, idempotencyKey: 'k', metric: 'views', targetValue: '100000' };

  it('objetivo: comparador por defecto gte; sugerencia del Sheet exige huella', () => {
    expect(leerObjetivoDeKpi(form(base))).toMatchObject({
      ok: true,
      value: { metric: 'views', targetValue: 100000, comparator: 'gte', usarSugerenciaDelSheet: false },
    });
    expect(leerObjetivoDeKpi(form({ ...base, usarSugerenciaDelSheet: '1' }))).toMatchObject({
      ok: false,
      field: 'sheetTextHash',
    });
    expect(
      leerObjetivoDeKpi(form({ ...base, usarSugerenciaDelSheet: '1', sheetTextHash: HASH })),
    ).toMatchObject({
      ok: true,
      value: { usarSugerenciaDelSheet: true, sheetTextHash: HASH },
    });
  });

  it('objetivo: métrica fuera del catálogo, comparador inválido y número mal formado', () => {
    expect(leerObjetivoDeKpi(form({ ...base, metric: 'costo_por_view' }))).toMatchObject({
      ok: false,
      field: 'metric',
    });
    expect(leerObjetivoDeKpi(form({ ...base, comparator: 'eq' }))).toMatchObject({
      ok: false,
      field: 'comparator',
    });
    expect(leerObjetivoDeKpi(form({ ...base, targetValue: '1e6' }))).toMatchObject({
      ok: false,
      field: 'targetValue',
    });
    expect(leerObjetivoDeKpi(form({ ...base, targetValue: '1,5' }))).toMatchObject({
      ok: false,
      field: 'targetValue',
    });
  });

  it('medición: normaliza observedAt a ISO UTC', () => {
    const m = { participacionId: U1, idempotencyKey: 'k', metric: 'likes', value: '1200' };
    expect(leerMedicionDeKpi(form({ ...m, observedAt: '2026-05-04' }))).toMatchObject({
      ok: true,
      value: { observedAt: '2026-05-04T00:00:00.000Z', value: 1200 },
    });
    expect(leerMedicionDeKpi(form({ ...m, observedAt: '2026-05-04T13:45' }))).toMatchObject({
      ok: true,
      value: { observedAt: '2026-05-04T13:45:00.000Z' },
    });
    expect(leerMedicionDeKpi(form({ ...m, observedAt: '2026-05-04T25:00' }))).toMatchObject({
      ok: false,
      field: 'observedAt',
    });
    expect(leerMedicionDeKpi(form({ ...m, observedAt: 'ayer' }))).toMatchObject({
      ok: false,
      field: 'observedAt',
    });
    expect(leerMedicionDeKpi(form(m))).toMatchObject({ ok: false, field: 'observedAt' });
  });

  it('corrección: motivo obligatorio', () => {
    const base = { measurementId: U1, value: '90', idempotencyKey: 'k' };
    expect(leerCorreccionDeMedicion(form(base))).toMatchObject({ ok: false, field: 'correctionReason' });
    expect(leerCorreccionDeMedicion(form({ ...base, correctionReason: 'Error de captura' }))).toMatchObject({
      ok: true,
      value: { measurementId: U1, input: { value: 90, correctionReason: 'Error de captura' } },
    });
  });
});

describe('PII', () => {
  it('exige al menos un dato y el error no cita el valor', () => {
    expect(leerPiiAGuardar(form({ participacionId: U1 }))).toMatchObject({ ok: false });
    const r = leerPiiAGuardar(form({ participacionId: U1, phone: 'x'.repeat(60) }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).not.toContain('xxxxx');
    expect(leerPiiAGuardar(form({ participacionId: U1, documentId: '1020304050' }))).toMatchObject({
      ok: true,
      value: { participacionId: U1, documentId: '1020304050' },
    });
  });
});

describe('leerEntradaDeEvidencia', () => {
  const comun = { idempotencyKey: 'k' };

  it('documento de cobro: registrar', () => {
    const r = leerEntradaDeEvidencia(
      form({
        ...comun,
        tipo: 'documento_cobro',
        accion: 'registrar',
        participacionId: U1,
        paymentObligationId: U2,
        documentNumber: 'CC-001',
        issuedOn: '2026-05-01',
        claimedAmount: '2500000',
        claimedCurrency: 'cop',
      }),
    );
    expect(r).toMatchObject({
      ok: true,
      value: {
        tipo: 'documento_cobro',
        accion: 'registrar',
        claimedAmount: '2500000.00',
        claimedCurrency: 'COP',
      },
    });
  });

  it('envío: transicionar con soporte (kind por defecto: guia) y adjuntar', () => {
    expect(
      leerEntradaDeEvidencia(
        form({
          ...comun,
          tipo: 'envio',
          accion: 'transicionar',
          shipmentId: U1,
          to: 'shipped',
          expectedSeq: '2',
          happenedOn: '2026-05-04',
        }),
      ),
    ).toMatchObject({
      ok: true,
      value: { tipo: 'envio', accion: 'transicionar', kind: 'guia', to: 'shipped' },
    });
    expect(
      leerEntradaDeEvidencia(
        form({
          ...comun,
          tipo: 'envio',
          accion: 'adjuntar',
          shipmentId: U1,
          expectedSeq: '2',
          kind: 'soporte',
        }),
      ),
    ).toMatchObject({ ok: true, value: { accion: 'adjuntar', kind: 'soporte' } });
  });

  it('pago: reportar con comprobante por defecto', () => {
    expect(
      leerEntradaDeEvidencia(
        form({
          ...comun,
          tipo: 'pago',
          accion: 'reportar',
          participacionId: U1,
          paymentObligationId: U2,
          expectedSeq: '1',
          paidOn: '2026-05-04',
          externalReference: 'TRX-1',
        }),
      ),
    ).toMatchObject({ ok: true, value: { tipo: 'pago', accion: 'reportar', kind: 'comprobante' } });
  });

  it('rechaza tipo o acción inválidos y combinaciones cruzadas', () => {
    expect(leerEntradaDeEvidencia(form({ ...comun, tipo: 'otro', accion: 'adjuntar' }))).toMatchObject({
      ok: false,
      field: 'tipo',
    });
    expect(
      leerEntradaDeEvidencia(
        form({ ...comun, tipo: 'envio', accion: 'reportar', shipmentId: U1, expectedSeq: '1' }),
      ),
    ).toMatchObject({ ok: false, field: 'accion' });
    expect(
      leerEntradaDeEvidencia(
        form({ ...comun, tipo: 'pago', accion: 'registrar', participacionId: U1, paymentObligationId: U2 }),
      ),
    ).toMatchObject({ ok: false, field: 'accion' });
  });

  it('rechaza un kind inventado', () => {
    expect(
      leerEntradaDeEvidencia(
        form({
          ...comun,
          tipo: 'envio',
          accion: 'adjuntar',
          shipmentId: U1,
          expectedSeq: '2',
          kind: 'malware',
        }),
      ),
    ).toMatchObject({ ok: false, field: 'kind' });
  });
});

describe('extensiones de evidencia', () => {
  it.each([
    ['guia.pdf', true],
    ['FOTO.JPG', true],
    ['foto.jpeg', true],
    ['x.png', true],
    ['planilla.xlsx', true],
    ['datos.csv', true],
    ['acta.docx', true],
    ['notas.md', false],
    ['deck.pptx', false],
    ['script.exe', false],
    ['sin_extension', false],
    ['doble.pdf.exe', false],
  ])('%s → %s', (nombre, esperado) => {
    expect(extensionDeEvidenciaPermitida(nombre)).toBe(esperado);
  });
});

describe('origenPermitidoEstricto', () => {
  const req = (headers: Record<string, string>) =>
    new Request('http://app.test/api', { method: 'POST', headers });

  it('acepta el mismo origen y las peticiones sin Origin (no son de un navegador)', () => {
    expect(origenPermitidoEstricto(req({ host: 'app.test', origin: 'http://app.test' }))).toBe(true);
    expect(origenPermitidoEstricto(req({ host: 'app.test', 'sec-fetch-site': 'same-origin' }))).toBe(true);
    expect(origenPermitidoEstricto(req({ host: 'app.test' }))).toBe(true);
  });

  it('rechaza otro sitio, otro puerto y un Origin ilegible', () => {
    expect(origenPermitidoEstricto(req({ host: 'app.test', origin: 'http://evil.test' }))).toBe(false);
    expect(origenPermitidoEstricto(req({ host: 'app.test', origin: 'http://app.test:81' }))).toBe(false);
    expect(origenPermitidoEstricto(req({ host: 'app.test', origin: 'null' }))).toBe(false);
    expect(origenPermitidoEstricto(req({ host: 'app.test', 'sec-fetch-site': 'cross-site' }))).toBe(false);
    expect(origenPermitidoEstricto(req({ host: 'app.test', 'sec-fetch-site': 'same-site' }))).toBe(false);
  });

  it('NO confía en x-forwarded-host (UI-09)', () => {
    expect(
      origenPermitidoEstricto(
        req({ host: 'app.test', origin: 'http://evil.test', 'x-forwarded-host': 'evil.test' }),
      ),
    ).toBe(false);
  });
});
