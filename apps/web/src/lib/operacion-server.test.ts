/**
 * Loaders de Operación SIN base de datos (casos de uso simulados): comprueban el guard `operations:read`
 * antes de consultar, el 404 indistinguible, que no se consulta lo que el rol no puede leer y que el DTO de
 * evidencia no lleva ids de fuente. La proyección por capacidad la prueban `packages/db` y el E2E.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { type Role, type User, err, ok } from '@tcl-kol-os/domain';

const U1 = '11111111-1111-4111-8111-111111111111';
const U2 = '22222222-2222-4222-8222-222222222222';
const CAMPANA = '44444444-4444-4444-8444-444444444444';
const OTRA = '55555555-5555-4555-8555-555555555555';

class NotFoundSimulado extends Error {
  constructor() {
    super('NEXT_NOT_FOUND');
  }
}

const mocks = vi.hoisted(() => {
  const nombres = [
    'getCampaign',
    'listarDocumentosDeCobro',
    'listarEnviosDeParticipacion',
    'listarEventosOperativos',
    'listarEvidenciaDeSujeto',
    'listarVersionesDeAcuerdo',
    'obtenerAcuerdo',
    'obtenerCampaignInfluencer',
    'obtenerEnvio',
    'obtenerEstadoOperativoDeParticipacion',
    'obtenerHistorialDeKpi',
    'obtenerKpiDeParticipacion',
    'obtenerKpiPactadoDelSheet',
    'obtenerPiiResumen',
    'obtenerResumenOperativoDeCampana',
    'obtenerSeguimientoDePago',
  ] as const;
  const db: Record<string, ReturnType<typeof vi.fn>> = {};
  for (const n of nombres) db[n] = vi.fn();
  return { db };
});

vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new NotFoundSimulado();
  },
}));
vi.mock('@tcl-kol-os/db', () => ({
  ...mocks.db,
  esUuid: (v: unknown) =>
    typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v),
}));

const server = await import('./operacion-server.ts');

const usuario = (role: Role): User => ({
  id: U2,
  email: 'persona@agencia.test',
  name: 'Persona',
  organizationId: OTRA,
  role,
  status: 'activo',
});

const noEncontrado = err({ code: 'RESOURCE_NOT_FOUND', message: 'x' });
const prohibido = err({ code: 'FORBIDDEN_ROLE', message: 'x' });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.db['getCampaign']!.mockResolvedValue(
    ok({ campaign: { id: CAMPANA, name: 'Campaña', status: 'activa', secreto: 'no-sale' } }),
  );
});

function sinBase(): void {
  for (const [nombre, fn] of Object.entries(mocks.db)) {
    if (nombre === 'getCampaign') continue;
    expect(fn).not.toHaveBeenCalled();
  }
}

describe('guard operations:read y 404 indistinguible', () => {
  it.each(['cliente', 'analista', 'legal'] as const)('%s ⇒ 404 antes de consultar nada', async (rol) => {
    const u = usuario(rol);
    await expect(server.cargarResumenOperacion(u, CAMPANA)).rejects.toBeInstanceOf(NotFoundSimulado);
    await expect(server.cargarEstadoOperativo(u, U1, CAMPANA)).rejects.toBeInstanceOf(NotFoundSimulado);
    await expect(server.cargarAcuerdoConHistorial(u, U1)).rejects.toBeInstanceOf(NotFoundSimulado);
    await expect(server.cargarEnvios(u, U1)).rejects.toBeInstanceOf(NotFoundSimulado);
    await expect(server.cargarSeguimientoDePago(u, U1)).rejects.toBeInstanceOf(NotFoundSimulado);
    await expect(server.cargarKpiDeParticipacion(u, U1)).rejects.toBeInstanceOf(NotFoundSimulado);
    await expect(server.cargarResumenPii(u, U1)).rejects.toBeInstanceOf(NotFoundSimulado);
    expect(mocks.db['getCampaign']).not.toHaveBeenCalled();
    sinBase();
  });

  it('un id que no es uuid ⇒ 404 sin tocar la base', async () => {
    const u = usuario('admin');
    await expect(server.cargarResumenOperacion(u, 'no-uuid')).rejects.toBeInstanceOf(NotFoundSimulado);
    await expect(server.cargarEstadoOperativo(u, 'no-uuid')).rejects.toBeInstanceOf(NotFoundSimulado);
    await expect(server.cargarEnvio(u, '../etc')).rejects.toBeInstanceOf(NotFoundSimulado);
    await expect(
      server.cargarEventosOperativos(u, { subjectType: 'shipment', subjectId: 'x' }),
    ).rejects.toBeInstanceOf(NotFoundSimulado);
    sinBase();
    expect(mocks.db['getCampaign']).not.toHaveBeenCalled();
  });

  it('ajeno, inexistente y sin permiso dan el MISMO 404', async () => {
    const u = usuario('operativo');
    mocks.db['obtenerEstadoOperativoDeParticipacion']!.mockResolvedValueOnce(noEncontrado);
    const a = await server.cargarEstadoOperativo(u, U1).catch((e: unknown) => e);
    mocks.db['obtenerEstadoOperativoDeParticipacion']!.mockResolvedValueOnce(prohibido);
    const b = await server.cargarEstadoOperativo(u, U1).catch((e: unknown) => e);
    mocks.db['getCampaign']!.mockResolvedValueOnce(noEncontrado);
    mocks.db['obtenerResumenOperativoDeCampana']!.mockResolvedValue(ok({}));
    const c = await server.cargarResumenOperacion(u, CAMPANA).catch((e: unknown) => e);
    for (const x of [a, b, c]) {
      expect(x).toBeInstanceOf(NotFoundSimulado);
      expect((x as Error).message).toBe('NEXT_NOT_FOUND');
    }
  });
});

describe('cargarResumenOperacion', () => {
  it('devuelve la campaña mínima, el resumen y los permisos; quita los filtros que el rol no puede usar', async () => {
    mocks.db['obtenerResumenOperativoDeCampana']!.mockResolvedValue(ok({ campaignId: CAMPANA, items: [] }));
    const r = await server.cargarResumenOperacion(usuario('consultor'), CAMPANA, {
      pagoPendiente: true,
      logisticaPendiente: true,
      sinAcuerdo: true,
      limite: 20,
    });
    expect(r.campana).toEqual({ id: CAMPANA, name: 'Campaña', status: 'activa' });
    expect(r.permisos).toMatchObject({
      verFinanzas: false,
      verKpi: true,
      gestionarAcuerdo: false,
      gestionarObjetivosKpi: true,
    });
    // El consultor no ve finanzas: el filtro de pago se descarta; los demás se conservan.
    expect(mocks.db['obtenerResumenOperativoDeCampana']!.mock.calls[0]![2]).toEqual({
      logisticaPendiente: true,
      sinAcuerdo: true,
      limite: 20,
    });
  });

  it('el operativo conserva el filtro de pago', async () => {
    mocks.db['obtenerResumenOperativoDeCampana']!.mockResolvedValue(ok({ items: [] }));
    await server.cargarResumenOperacion(usuario('operativo'), CAMPANA, { pagoPendiente: true });
    expect(mocks.db['obtenerResumenOperativoDeCampana']!.mock.calls[0]![2]).toEqual({ pagoPendiente: true });
  });
});

describe('cargarEstadoOperativo', () => {
  it('con campaignId distinto al de la participación ⇒ 404', async () => {
    mocks.db['obtenerEstadoOperativoDeParticipacion']!.mockResolvedValue(
      ok({ campaignId: OTRA, participacionId: U1 }),
    );
    await expect(server.cargarEstadoOperativo(usuario('admin'), U1, CAMPANA)).rejects.toBeInstanceOf(
      NotFoundSimulado,
    );
    expect(mocks.db['getCampaign']).not.toHaveBeenCalled();
  });

  it('con la campaña correcta devuelve estado, campaña y permisos', async () => {
    mocks.db['obtenerEstadoOperativoDeParticipacion']!.mockResolvedValue(
      ok({ campaignId: CAMPANA, participacionId: U1 }),
    );
    const r = await server.cargarEstadoOperativo(usuario('admin'), U1, CAMPANA);
    expect(r.estado.participacionId).toBe(U1);
    expect(r.campana.id).toBe(CAMPANA);
    expect(r.permisos.revelarPii).toBe(true);
  });
});

describe('secciones opcionales: no se consulta lo que el rol no puede leer', () => {
  it('finanzas solo con finance:read', async () => {
    expect(await server.cargarSeguimientoDePago(usuario('consultor'), U1)).toBeNull();
    expect(await server.cargarDocumentosDeCobro(usuario('consultor'), U1)).toBeNull();
    sinBase();
    mocks.db['obtenerSeguimientoDePago']!.mockResolvedValue(ok({ campaignInfluencerId: U1 }));
    expect(await server.cargarSeguimientoDePago(usuario('operativo'), U1)).toEqual({
      campaignInfluencerId: U1,
    });
  });

  it('el historial de pagos y su evidencia siguen la capacidad del sujeto', async () => {
    const consultor = usuario('consultor');
    expect(
      await server.cargarEventosOperativos(consultor, { subjectType: 'payment_obligation', subjectId: U1 }),
    ).toBeNull();
    expect(
      await server.cargarEvidenciaDeSujeto(consultor, { subjectType: 'billing_document', subjectId: U1 }),
    ).toBeNull();
    sinBase();
    mocks.db['listarEventosOperativos']!.mockResolvedValue(ok([]));
    expect(
      await server.cargarEventosOperativos(consultor, { subjectType: 'shipment', subjectId: U1 }),
    ).toEqual([]);
  });

  it('un tipo de sujeto inventado ⇒ 404', async () => {
    await expect(
      server.cargarEventosOperativos(usuario('admin'), { subjectType: 'user' as never, subjectId: U1 }),
    ).rejects.toBeInstanceOf(NotFoundSimulado);
  });

  it('KPI pactado del Sheet solo con kpi:target_manage; PII solo con pii', async () => {
    expect(await server.cargarKpiPactadoDelSheet(usuario('operativo'), U1)).toBeNull();
    expect(await server.cargarResumenPii(usuario('consultor'), U1)).toBeNull();
    expect(await server.cargarResumenPii(usuario('director'), U1)).toBeNull();
    sinBase();
  });

  it('PII: resuelve el influencer de la participación y devuelve el resumen (sin valores)', async () => {
    mocks.db['obtenerCampaignInfluencer']!.mockResolvedValue(
      ok({ campaignInfluencer: { influencerId: U2 }, products: [] }),
    );
    mocks.db['obtenerPiiResumen']!.mockResolvedValue(
      ok({
        recordId: U1,
        influencerId: U2,
        version: 1,
        hasDocumentId: true,
        hasPhone: false,
        hasAddress: true,
        erased: false,
      }),
    );
    const r = await server.cargarResumenPii(usuario('operativo'), U1);
    expect(r).toMatchObject({ recordId: U1, hasDocumentId: true, hasPhone: false });
    expect(mocks.db['obtenerPiiResumen']!.mock.calls[0]![1]).toBe(U2);
  });

  it('historial de KPI: una métrica fuera del catálogo se ignora', async () => {
    mocks.db['obtenerHistorialDeKpi']!.mockResolvedValue(ok({}));
    await server.cargarHistorialDeKpi(usuario('admin'), U1, 'costo');
    expect(mocks.db['obtenerHistorialDeKpi']!.mock.calls[0]![1]).toEqual({ campaignInfluencerId: U1 });
    await server.cargarHistorialDeKpi(usuario('admin'), U1, 'views');
    expect(mocks.db['obtenerHistorialDeKpi']!.mock.calls[1]![1]).toEqual({
      campaignInfluencerId: U1,
      metric: 'views',
    });
  });
});

describe('DTO de evidencia y productos', () => {
  it('la evidencia no lleva el id de la fuente ni el actor', async () => {
    mocks.db['listarEvidenciaDeSujeto']!.mockResolvedValue(
      ok([
        {
          id: U1,
          eventId: U2,
          eventType: 'evidence.attached',
          subjectType: 'shipment',
          subjectId: U1,
          sourceDocumentId: OTRA,
          kind: 'guia',
          filename: 'guia.pdf',
          mimeType: 'application/pdf',
          sizeBytes: 10,
          hash: 'h',
          attachedBy: OTRA,
          attachedAt: '2026-05-01T00:00:00.000Z',
          retractedAt: null,
        },
      ]),
    );
    const r = await server.cargarEvidenciaDeSujeto(usuario('operativo'), {
      subjectType: 'shipment',
      subjectId: U1,
    });
    expect(r).toHaveLength(1);
    const dto = r![0]!;
    expect(Object.keys(dto)).not.toContain('sourceDocumentId');
    expect(Object.keys(dto)).not.toContain('attachedBy');
    expect(dto).toMatchObject({ filename: 'guia.pdf', kind: 'guia', hash: 'h' });
  });

  it('los productos asignados solo exponen marca y modelo (nada de la identidad del influencer)', async () => {
    mocks.db['obtenerCampaignInfluencer']!.mockResolvedValue(
      ok({
        campaignInfluencer: { influencerId: U2 },
        influencer: { displayName: 'Nombre' },
        accounts: [{ handle: 'x' }],
        products: [
          {
            campaignProductId: U1,
            productId: OTRA,
            brand: 'TCL',
            model: 'C655',
            category: 'TV',
            rol: 'x',
            assignedAt: 'y',
          },
        ],
      }),
    );
    const r = await server.cargarProductosAsignados(usuario('operativo'), U1);
    expect(r).toEqual([{ campaignProductId: U1, brand: 'TCL', model: 'C655' }]);
  });

  it('el acuerdo sin registrar devuelve acuerdo null y no pide versiones', async () => {
    mocks.db['obtenerAcuerdo']!.mockResolvedValue(ok(null));
    expect(await server.cargarAcuerdoConHistorial(usuario('consultor'), U1)).toEqual({
      acuerdo: null,
      versiones: [],
    });
    expect(mocks.db['listarVersionesDeAcuerdo']).not.toHaveBeenCalled();
  });
});

describe('filtrosDeOperacionDesdeUrl', () => {
  it('lee los booleanos y los límites; ignora lo raro', () => {
    expect(
      server.filtrosDeOperacionDesdeUrl({
        logisticaPendiente: '1',
        pagoPendiente: 'true',
        retirados: 'on',
        limite: '25',
        desde: '50',
      }),
    ).toEqual({
      logisticaPendiente: true,
      pagoPendiente: true,
      incluirRetirados: true,
      limite: 25,
      desde: 50,
    });
    expect(
      server.filtrosDeOperacionDesdeUrl({
        sinAcuerdo: ['1', '0'],
        logisticaPendiente: '0',
        limite: '9999',
        desde: '-1',
      }),
    ).toEqual({ sinAcuerdo: true });
    expect(server.filtrosDeOperacionDesdeUrl({ limite: 'abc', pagoPendiente: undefined })).toEqual({});
  });
});
