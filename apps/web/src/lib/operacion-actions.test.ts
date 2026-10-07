/**
 * Server actions de Operación SIN base de datos: sesión y casos de uso simulados. Comprueba lo que esta capa
 * decide (quién, qué se valida antes de llamar, el origen fijo, el mapeo de errores a español sin filtrar
 * detalles internos y qué se revalida); las reglas de negocio las prueba `packages/db` y las cubre el E2E.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { type Role, type User, err, ok } from '@tcl-kol-os/domain';

const U1 = '11111111-1111-4111-8111-111111111111';
const U2 = '22222222-2222-4222-8222-222222222222';
const U3 = '33333333-3333-4333-8333-333333333333';
const CAMPANA = '44444444-4444-4444-8444-444444444444';
const HASH = 'b'.repeat(64);

const mocks = vi.hoisted(() => {
  const nombres = [
    'anularDocumento',
    'cancelarAcuerdo',
    'cancelarObligacionDePago',
    'corregirMedicionKpi',
    'crearAcuerdo',
    'crearEnvio',
    'guardarPii',
    'obtenerCampaignInfluencer',
    'obtenerKpiPactadoDelSheet',
    'rechazarDocumento',
    'registrarKpiObjetivo',
    'registrarMedicionKpi',
    'registrarNotaDeCorreccionDePago',
    'registrarVersionDeAcuerdo',
    'reportarPago',
    'retirarKpiObjetivo',
    'revelarPii',
    'transicionarEnvio',
    'validarDocumento',
  ] as const;
  const db: Record<string, ReturnType<typeof vi.fn>> = {};
  for (const n of nombres) db[n] = vi.fn();
  return { db, currentUser: vi.fn(), revalidatePath: vi.fn() };
});

vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock('./session.ts', () => ({ currentUser: mocks.currentUser }));
vi.mock('@tcl-kol-os/db', () => ({ ...mocks.db }));

const {
  crearAcuerdoAction,
  registrarVersionDeAcuerdoAction,
  transicionarEnvioAction,
  reportarPagoAction,
  validarDocumentoAction,
  registrarKpiObjetivoAction,
  registrarMedicionKpiAction,
  guardarPiiAction,
  revelarPiiAction,
} = await import('./operacion-actions.ts');
import { ESTADO_INICIAL } from './operacion-comun.ts';

const usuario = (role: Role): User => ({
  id: U3,
  email: 'persona@agencia.test',
  name: 'Persona',
  organizationId: U2,
  role,
  status: 'activo',
});

function form(campos: Record<string, string | string[]>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(campos)) {
    for (const x of Array.isArray(v) ? v : [v]) fd.append(k, x);
  }
  return fd;
}

const acuerdoFee = {
  participacionId: U1,
  idempotencyKey: 'k-1',
  compensationType: 'fee',
  feeAmount: '1000',
  feeCurrency: 'COP',
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.currentUser.mockResolvedValue(usuario('operativo'));
});

describe('guardas comunes', () => {
  it('sin sesión: SESSION y no toca la base', async () => {
    mocks.currentUser.mockResolvedValue(undefined);
    const r = await crearAcuerdoAction(ESTADO_INICIAL, form(acuerdoFee));
    expect(r).toMatchObject({ ok: false, code: 'SESSION' });
    expect(mocks.db['crearAcuerdo']).not.toHaveBeenCalled();
  });

  it.each(['cliente', 'analista', 'legal'] as const)(
    '%s recibe «no encontrado» y no toca la base',
    async (rol) => {
      mocks.currentUser.mockResolvedValue(usuario(rol));
      const r = await crearAcuerdoAction(ESTADO_INICIAL, form(acuerdoFee));
      expect(r).toMatchObject({ ok: false, code: 'RESOURCE_NOT_FOUND' });
      expect(mocks.db['crearAcuerdo']).not.toHaveBeenCalled();
    },
  );

  it('el consultor lee pero no escribe acuerdos, envíos ni pagos', async () => {
    mocks.currentUser.mockResolvedValue(usuario('consultor'));
    for (const accion of [
      crearAcuerdoAction,
      transicionarEnvioAction,
      reportarPagoAction,
      validarDocumentoAction,
    ]) {
      const r = await accion(ESTADO_INICIAL, form(acuerdoFee));
      expect(r).toMatchObject({
        ok: false,
        code: 'FORBIDDEN_ROLE',
        message: 'Tu rol no puede realizar esta acción.',
      });
    }
    expect(mocks.db['crearAcuerdo']).not.toHaveBeenCalled();
    expect(mocks.db['transicionarEnvio']).not.toHaveBeenCalled();
  });

  it('el director no reporta pagos (solo admin y operativo)', async () => {
    mocks.currentUser.mockResolvedValue(usuario('director'));
    const r = await reportarPagoAction(
      ESTADO_INICIAL,
      form({
        paymentObligationId: U1,
        expectedSeq: '1',
        idempotencyKey: 'k',
        paidOn: '2026-05-04',
        externalReference: 'T',
      }),
    );
    expect(r).toMatchObject({ ok: false, code: 'FORBIDDEN_ROLE' });
    expect(mocks.db['reportarPago']).not.toHaveBeenCalled();
  });

  it('la validación falla ANTES de llamar al caso de uso, con el campo y sin ecos del valor', async () => {
    const r = await crearAcuerdoAction(ESTADO_INICIAL, form({ ...acuerdoFee, idempotencyKey: '' }));
    expect(r).toMatchObject({ ok: false, code: 'VALIDATION_FAILED', field: 'idempotencyKey' });
    const r2 = await crearAcuerdoAction(ESTADO_INICIAL, form({ ...acuerdoFee, feeAmount: '12,5' }));
    expect(r2).toMatchObject({ ok: false, field: 'feeAmount' });
    expect(mocks.db['crearAcuerdo']).not.toHaveBeenCalled();
  });

  it('un argumento que no es FormData no llega a la base', async () => {
    const r = await crearAcuerdoAction(ESTADO_INICIAL, { participacionId: U1 } as unknown as FormData);
    expect(r).toMatchObject({ ok: false, code: 'VALIDATION_FAILED' });
    expect(mocks.db['crearAcuerdo']).not.toHaveBeenCalled();
  });
});

describe('escritura correcta', () => {
  it('crear acuerdo: persona de la sesión, origen ui fijo, sin campos de autorización, revalida la operación', async () => {
    mocks.db['crearAcuerdo']!.mockResolvedValue(
      ok({ repetido: false, acuerdo: { campaignId: CAMPANA, currentVersion: 1 } }),
    );
    const r = await crearAcuerdoAction(
      ESTADO_INICIAL,
      form({ ...acuerdoFee, organizationId: U3, role: 'admin', origin: 'chat', campaignId: U3 }),
    );
    expect(r).toMatchObject({ ok: true, message: 'Acuerdo registrado (versión 1).' });
    const [actor, entrada, contexto] = mocks.db['crearAcuerdo']!.mock.calls[0]!;
    expect(actor).toMatchObject({ id: U3, role: 'operativo', organizationId: U2 });
    expect(contexto).toEqual({ origin: 'ui' });
    expect(entrada).toMatchObject({
      campaignInfluencerId: U1,
      idempotencyKey: 'k-1',
      compensationType: 'fee',
      feeAmount: '1000.00',
      feeCurrency: 'COP',
    });
    expect(Object.keys(entrada)).not.toEqual(expect.arrayContaining(['organizationId']));
    expect(mocks.revalidatePath).toHaveBeenCalledWith(`/campanas/${CAMPANA}/operacion`, 'layout');
  });

  it('un reintento idéntico se reporta como repetido', async () => {
    mocks.db['crearAcuerdo']!.mockResolvedValue(
      ok({ repetido: true, acuerdo: { campaignId: CAMPANA, currentVersion: 1 } }),
    );
    const r = await crearAcuerdoAction(ESTADO_INICIAL, form(acuerdoFee));
    expect(r).toMatchObject({ ok: true, repeated: true });
  });

  it('reportar un pago sin documento validado lo avisa', async () => {
    mocks.db['reportarPago']!.mockResolvedValue(
      ok({ repetido: false, obligacion: { campaignId: CAMPANA, billingValidatedAtReport: false } }),
    );
    const r = await reportarPagoAction(
      ESTADO_INICIAL,
      form({
        paymentObligationId: U1,
        expectedSeq: '2',
        idempotencyKey: 'k',
        paidOn: '2026-05-04',
        externalReference: 'T-1',
      }),
    );
    expect(r.ok).toBe(true);
    expect(r.message).toContain('sin un documento de cobro validado');
    expect(mocks.db['reportarPago']!.mock.calls[0]![1]).toMatchObject({
      expectedSeq: 2,
      externalReference: 'T-1',
    });
  });

  it('transicionar envío pasa expectedSeq y destino', async () => {
    mocks.db['transicionarEnvio']!.mockResolvedValue(
      ok({ repetido: false, envio: { campaignId: CAMPANA, status: 'shipped' } }),
    );
    const r = await transicionarEnvioAction(
      ESTADO_INICIAL,
      form({
        shipmentId: U1,
        to: 'shipped',
        expectedSeq: '1',
        idempotencyKey: 'k',
        happenedOn: '2026-05-04',
      }),
    );
    expect(r).toMatchObject({ ok: true, message: 'Envío marcado como enviado.' });
    expect(mocks.db['transicionarEnvio']!.mock.calls[0]![1]).toMatchObject({ to: 'shipped', expectedSeq: 1 });
  });

  it('nueva versión del acuerdo pasa expectedVersion', async () => {
    mocks.db['registrarVersionDeAcuerdo']!.mockResolvedValue(
      ok({ repetido: false, obligacionAjustada: true, acuerdo: { campaignId: CAMPANA, currentVersion: 3 } }),
    );
    const r = await registrarVersionDeAcuerdoAction(
      ESTADO_INICIAL,
      form({
        agreementId: U1,
        expectedVersion: '2',
        changeReason: 'Pasa a canje',
        idempotencyKey: 'k',
        compensationType: 'barter',
        commitmentProductId: [U2],
        commitmentQuantity: ['1'],
      }),
    );
    expect(r.ok).toBe(true);
    expect(r.message).toContain('Versión 3');
    expect(r.message).toContain('obligación de pago se ajustó');
    expect(mocks.db['registrarVersionDeAcuerdo']!.mock.calls[0]![1]).toBe(U1);
    expect(mocks.db['registrarVersionDeAcuerdo']!.mock.calls[0]![2]).toMatchObject({ expectedVersion: 2 });
  });
});

describe('errores del dominio → español, sin filtrar detalles', () => {
  it.each(['stale_transition', 'stale_version'])(
    '%s ⇒ «otra persona cambió este registro; recarga»',
    async (razon) => {
      mocks.db['validarDocumento']!.mockResolvedValue(
        err({
          code: 'RESOURCE_CONFLICT',
          message: 'texto interno',
          details: { reason: razon, expectedSeq: 1, currentSeq: 7, agreementId: U3 },
        }),
      );
      const r = await validarDocumentoAction(
        ESTADO_INICIAL,
        form({ billingDocumentId: U1, expectedSeq: '1', idempotencyKey: 'k' }),
      );
      expect(r).toMatchObject({ ok: false, code: 'STALE' });
      expect(r.message).toContain('Otra persona cambió este registro');
      expect(JSON.stringify(r)).not.toContain(U3);
      expect(JSON.stringify(r)).not.toContain('currentSeq');
    },
  );

  it('canje puro: no hay pago que reportar', async () => {
    mocks.db['reportarPago']!.mockResolvedValue(
      err({ code: 'RESOURCE_CONFLICT', message: 'x', details: { reason: 'payment_not_applicable' } }),
    );
    const r = await reportarPagoAction(
      ESTADO_INICIAL,
      form({
        paymentObligationId: U1,
        expectedSeq: '1',
        idempotencyKey: 'k',
        paidOn: '2026-05-04',
        externalReference: 'T',
      }),
    );
    expect(r.message).toContain('canje puro');
  });

  it('el texto crudo de una regla de la base no se muestra', async () => {
    mocks.db['crearAcuerdo']!.mockResolvedValue(
      err({
        code: 'RESOURCE_CONFLICT',
        message: 'ERROR: trigger agreement_versions_guard relation "agreements" violates constraint',
        details: { reason: 'db_rule' },
      }),
    );
    const r = await crearAcuerdoAction(ESTADO_INICIAL, form(acuerdoFee));
    expect(r.message).not.toContain('trigger');
    expect(r.message).not.toContain('agreements');
  });

  it('el cifrado sin configurar no nombra variables de entorno', async () => {
    mocks.db['obtenerCampaignInfluencer']!.mockResolvedValue(
      ok({ campaignInfluencer: { influencerId: U2, campaignId: CAMPANA } }),
    );
    mocks.db['guardarPii']!.mockResolvedValue(
      err({
        code: 'VALIDATION_FAILED',
        message: 'El cifrado de datos personales no está configurado (PII_ENCRYPTION_KEYS y PII_INDEX_KEY).',
        details: { reason: 'PII_NOT_CONFIGURED' },
      }),
    );
    const r = await guardarPiiAction(ESTADO_INICIAL, form({ participacionId: U1, documentId: '1020304050' }));
    expect(r.ok).toBe(false);
    expect(r.message).not.toContain('PII_ENCRYPTION_KEYS');
    expect(JSON.stringify(r)).not.toContain('1020304050');
  });

  it('un error inesperado devuelve el mensaje genérico, no la excepción', async () => {
    mocks.db['crearAcuerdo']!.mockRejectedValue(new Error('connection refused postgres://secreto'));
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const r = await crearAcuerdoAction(ESTADO_INICIAL, form(acuerdoFee));
    expect(r).toMatchObject({ ok: false, code: 'INTERNAL' });
    expect(r.message).not.toContain('postgres');
    expect(JSON.stringify(spy.mock.calls)).not.toContain('secreto');
    spy.mockRestore();
  });

  it('el campo de un error de validación del dominio llega a la interfaz', async () => {
    mocks.db['crearAcuerdo']!.mockResolvedValue(
      err({
        code: 'VALIDATION_FAILED',
        message: 'Un acuerdo fee exige el monto.',
        details: { field: 'amount' },
      }),
    );
    const r = await crearAcuerdoAction(
      ESTADO_INICIAL,
      form({ participacionId: U1, idempotencyKey: 'k', compensationType: 'fee' }),
    );
    expect(r).toMatchObject({ ok: false, field: 'feeAmount', message: 'Un acuerdo fee exige el monto.' });
  });
});

describe('KPI y el Sheet', () => {
  const base = { participacionId: U1, idempotencyKey: 'k', metric: 'views', targetValue: '5000' };
  const pactado = (textHash: string) =>
    ok({
      text: '5k views',
      provenance: {
        snapshotId: U2,
        locator: { kind: 'range', sheet: 'S', range: 'F2', rowStart: 2, rowEnd: 2, colStart: 5, colEnd: 5 },
        textHash,
      },
    });

  beforeEach(() => {
    mocks.currentUser.mockResolvedValue(usuario('director'));
  });

  it('sin sugerencia: no consulta el Sheet', async () => {
    mocks.db['registrarKpiObjetivo']!.mockResolvedValue(
      ok({ repetido: false, objetivo: { campaignId: CAMPANA, supersedesId: null } }),
    );
    const r = await registrarKpiObjetivoAction(ESTADO_INICIAL, form(base));
    expect(r).toMatchObject({ ok: true, message: 'Objetivo de KPI registrado.' });
    expect(mocks.db['obtenerKpiPactadoDelSheet']).not.toHaveBeenCalled();
    expect(mocks.db['registrarKpiObjetivo']!.mock.calls[0]![1]).not.toHaveProperty('sheetSuggestion');
  });

  it('la procedencia la resuelve el servidor (nunca el cliente) y exige la misma huella', async () => {
    mocks.db['obtenerKpiPactadoDelSheet']!.mockResolvedValue(pactado(HASH));
    mocks.db['registrarKpiObjetivo']!.mockResolvedValue(
      ok({ repetido: false, objetivo: { campaignId: CAMPANA, supersedesId: null } }),
    );
    const r = await registrarKpiObjetivoAction(
      ESTADO_INICIAL,
      form({ ...base, usarSugerenciaDelSheet: '1', sheetTextHash: HASH, snapshotId: U3 }),
    );
    expect(r.ok).toBe(true);
    expect(mocks.db['registrarKpiObjetivo']!.mock.calls[0]![1].sheetSuggestion).toMatchObject({
      snapshotId: U2,
      textHash: HASH,
    });
  });

  it('si el Sheet cambió, no registra', async () => {
    mocks.db['obtenerKpiPactadoDelSheet']!.mockResolvedValue(pactado('c'.repeat(64)));
    const r = await registrarKpiObjetivoAction(
      ESTADO_INICIAL,
      form({ ...base, usarSugerenciaDelSheet: '1', sheetTextHash: HASH }),
    );
    expect(r).toMatchObject({ ok: false, code: 'RESOURCE_CONFLICT' });
    expect(r.message).toContain('Sheet cambió');
    expect(mocks.db['registrarKpiObjetivo']).not.toHaveBeenCalled();
  });

  it('el operativo no fija objetivos; el consultor no mide', async () => {
    mocks.currentUser.mockResolvedValue(usuario('operativo'));
    const r1 = await registrarKpiObjetivoAction(ESTADO_INICIAL, form(base));
    expect(r1).toMatchObject({ ok: false, code: 'FORBIDDEN_ROLE' });
    mocks.currentUser.mockResolvedValue(usuario('consultor'));
    const r2 = await registrarMedicionKpiAction(
      ESTADO_INICIAL,
      form({
        participacionId: U1,
        idempotencyKey: 'k',
        metric: 'likes',
        value: '10',
        observedAt: '2026-05-04',
      }),
    );
    expect(r2).toMatchObject({ ok: false, code: 'FORBIDDEN_ROLE' });
    expect(mocks.db['registrarMedicionKpi']).not.toHaveBeenCalled();
  });
});

describe('PII', () => {
  it('guardar: el influencer sale de la participación, el estado no devuelve valores', async () => {
    mocks.db['obtenerCampaignInfluencer']!.mockResolvedValue(
      ok({ campaignInfluencer: { influencerId: U2, campaignId: CAMPANA } }),
    );
    mocks.db['guardarPii']!.mockResolvedValue(ok({ replayed: false, record: { version: 2 } }));
    const r = await guardarPiiAction(
      ESTADO_INICIAL,
      form({ participacionId: U1, phone: '3001234567', influencerId: U3 }),
    );
    expect(r).toMatchObject({ ok: true, message: 'Datos personales guardados (versión 2).' });
    expect(JSON.stringify(r)).not.toContain('3001234567');
    expect(mocks.db['guardarPii']!.mock.calls[0]![1]).toEqual({ influencerId: U2, phone: '3001234567' });
    expect(mocks.db['guardarPii']!.mock.calls[0]![2]).toEqual({ origin: 'ui' });
  });

  it('los roles sin pii:manage no guardan (director, consultor)', async () => {
    for (const rol of ['director', 'consultor'] as const) {
      mocks.currentUser.mockResolvedValue(usuario(rol));
      const r = await guardarPiiAction(ESTADO_INICIAL, form({ participacionId: U1, phone: '3001234567' }));
      expect(r).toMatchObject({ ok: false, code: 'FORBIDDEN_ROLE' });
    }
    expect(mocks.db['guardarPii']).not.toHaveBeenCalled();
  });

  it('revelar: solo pii:read, validando uuid y campos, con origen ui', async () => {
    mocks.db['revelarPii']!.mockResolvedValue(ok({ values: { document_id: '1020304050' } }));
    const r = await revelarPiiAction(U1, ['document_id']);
    expect(r).toMatchObject({ ok: true, values: { document_id: '1020304050' } });
    expect(mocks.db['revelarPii']!.mock.calls[0]).toEqual([
      expect.objectContaining({ role: 'operativo' }),
      U1,
      ['document_id'],
      { origin: 'ui' },
    ]);
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it.each(['director', 'consultor', 'cliente', 'analista'] as const)(
    'revelar con rol %s no llega a la base',
    async (rol) => {
      mocks.currentUser.mockResolvedValue(usuario(rol));
      const r = await revelarPiiAction(U1, ['phone']);
      expect(r.ok).toBe(false);
      expect(mocks.db['revelarPii']).not.toHaveBeenCalled();
    },
  );

  it('revelar con ids o campos inválidos no llega a la base', async () => {
    expect((await revelarPiiAction('no-uuid', ['phone'])).ok).toBe(false);
    expect((await revelarPiiAction(U1, [])).ok).toBe(false);
    expect((await revelarPiiAction(U1, ['password'])).ok).toBe(false);
    expect((await revelarPiiAction(U1, 'phone' as unknown as string[])).ok).toBe(false);
    expect(mocks.db['revelarPii']).not.toHaveBeenCalled();
  });

  it('revelar sin sesión', async () => {
    mocks.currentUser.mockResolvedValue(undefined);
    expect(await revelarPiiAction(U1, ['phone'])).toMatchObject({ ok: false, code: 'SESSION' });
  });
});
