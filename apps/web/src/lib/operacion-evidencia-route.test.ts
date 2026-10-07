/**
 * Route handler de evidencia operativa SIN base de datos: origen, sesión, 404 uniforme, límites y tipos de
 * archivo se resuelven ANTES de llamar a un caso de uso. Importa la ruta con rutas relativas y simula sus
 * dependencias (`@/lib/*` se simula por su ruta resuelta).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { type Role, type User, err, ok } from '@tcl-kol-os/domain';

const U1 = '11111111-1111-4111-8111-111111111111';
const U2 = '22222222-2222-4222-8222-222222222222';
const CAMPANA = '44444444-4444-4444-8444-444444444444';
const OTRA = '55555555-5555-4555-8555-555555555555';

const mocks = vi.hoisted(() => ({
  currentUser: vi.fn(),
  revalidatePath: vi.fn(),
  getCampaign: vi.fn(),
  obtenerEnvio: vi.fn(),
  obtenerSeguimientoDePago: vi.fn(),
  registrarDocumentoDeCobro: vi.fn(),
  reportarPago: vi.fn(),
  transicionarEnvio: vi.fn(),
  adjuntarEvidenciaOperativa: vi.fn(),
}));

vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock('./session.ts', () => ({ currentUser: mocks.currentUser }));
vi.mock('./chat-server.ts', () => ({ limiteDeAdjuntoBytes: () => 1024 * 1024 }));
vi.mock('@tcl-kol-os/db', () => ({
  getCampaign: mocks.getCampaign,
  obtenerEnvio: mocks.obtenerEnvio,
  obtenerSeguimientoDePago: mocks.obtenerSeguimientoDePago,
  registrarDocumentoDeCobro: mocks.registrarDocumentoDeCobro,
  reportarPago: mocks.reportarPago,
  transicionarEnvio: mocks.transicionarEnvio,
  adjuntarEvidenciaOperativa: mocks.adjuntarEvidenciaOperativa,
}));

const PDF = new Uint8Array([
  0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a, 0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a,
]);

const usuario = (role: Role): User => ({
  id: U2,
  email: 'persona@agencia.test',
  name: 'Persona',
  organizationId: OTRA,
  role,
  status: 'activo',
});

function cargarRuta() {
  return import('../app/api/campanas/[id]/operacion/evidencia/route.ts');
}

async function peticion(
  campos: Record<string, string>,
  archivo: { nombre: string; bytes: Uint8Array; tipo?: string } | null,
  cabeceras: Record<string, string> = {},
): Promise<Request> {
  const fd = new FormData();
  for (const [k, v] of Object.entries(campos)) fd.append(k, v);
  if (archivo !== null) {
    fd.append(
      'archivo',
      new File([new Uint8Array(archivo.bytes)], archivo.nombre, { type: archivo.tipo ?? 'application/pdf' }),
    );
  }
  // El cuerpo se serializa para que `Content-Length` sea el real.
  const serializado = new Response(fd);
  const cuerpo = new Uint8Array(await serializado.arrayBuffer());
  const headers = new Headers(cabeceras);
  headers.set('host', 'app.test');
  headers.set('content-type', serializado.headers.get('content-type') ?? '');
  headers.set('content-length', String(cuerpo.byteLength));
  return new Request('http://app.test/api/campanas/x/operacion/evidencia', {
    method: 'POST',
    body: cuerpo,
    headers,
  });
}

const contexto = (id: string = CAMPANA) => ({ params: Promise.resolve({ id }) });

const envioTransicion = {
  tipo: 'envio',
  accion: 'transicionar',
  shipmentId: U1,
  to: 'shipped',
  expectedSeq: '1',
  idempotencyKey: 'k-1',
  happenedOn: '2026-05-04',
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.currentUser.mockResolvedValue(usuario('operativo'));
  mocks.getCampaign.mockResolvedValue(ok({ campaign: { id: CAMPANA } }));
});

describe('POST /api/campanas/[id]/operacion/evidencia', () => {
  it('rechaza otro origen sin tocar sesión ni base (y no confía en x-forwarded-host)', async () => {
    const { POST } = await cargarRuta();
    const r = await POST(
      await peticion(
        envioTransicion,
        { nombre: 'g.pdf', bytes: PDF },
        { origin: 'http://evil.test', 'x-forwarded-host': 'evil.test' },
      ),
      contexto(),
    );
    expect(r.status).toBe(403);
    expect(mocks.currentUser).not.toHaveBeenCalled();
    expect(mocks.transicionarEnvio).not.toHaveBeenCalled();
  });

  it('sin sesión: 401', async () => {
    mocks.currentUser.mockResolvedValue(undefined);
    const { POST } = await cargarRuta();
    const r = await POST(await peticion(envioTransicion, { nombre: 'g.pdf', bytes: PDF }), contexto());
    expect(r.status).toBe(401);
  });

  it.each(['cliente', 'analista', 'legal'] as const)(
    '%s recibe el mismo 404 que una campaña inexistente',
    async (rol) => {
      mocks.currentUser.mockResolvedValue(usuario(rol));
      const { POST } = await cargarRuta();
      const a = await POST(await peticion(envioTransicion, { nombre: 'g.pdf', bytes: PDF }), contexto());
      mocks.currentUser.mockResolvedValue(usuario('operativo'));
      mocks.getCampaign.mockResolvedValue(err({ code: 'RESOURCE_NOT_FOUND', message: 'x' }));
      const b = await POST(await peticion(envioTransicion, { nombre: 'g.pdf', bytes: PDF }), contexto());
      expect(a.status).toBe(404);
      expect(b.status).toBe(404);
      expect(await a.json()).toEqual(await b.json());
      expect(mocks.transicionarEnvio).not.toHaveBeenCalled();
    },
  );

  it('un id de campaña que no es uuid ⇒ 404', async () => {
    const { POST } = await cargarRuta();
    const r = await POST(
      await peticion(envioTransicion, { nombre: 'g.pdf', bytes: PDF }),
      contexto('no-uuid'),
    );
    expect(r.status).toBe(404);
    expect(mocks.getCampaign).not.toHaveBeenCalled();
  });

  it('archivo ausente, vacío, demasiado grande o de tipo no permitido: se rechaza antes de la base', async () => {
    const { POST } = await cargarRuta();
    expect((await POST(await peticion(envioTransicion, null), contexto())).status).toBe(422);
    expect(
      (await POST(await peticion(envioTransicion, { nombre: 'g.pdf', bytes: new Uint8Array(0) }), contexto()))
        .status,
    ).toBe(422);
    const grande = await POST(
      await peticion(envioTransicion, { nombre: 'g.pdf', bytes: new Uint8Array(2 * 1024 * 1024) }),
      contexto(),
    );
    expect(grande.status).toBe(413);
    const exe = await POST(await peticion(envioTransicion, { nombre: 'virus.exe', bytes: PDF }), contexto());
    expect(exe.status).toBe(415);
    expect(JSON.stringify(await exe.json())).not.toContain('virus');
    const md = await POST(await peticion(envioTransicion, { nombre: 'notas.md', bytes: PDF }), contexto());
    expect(md.status).toBe(415);
    expect(mocks.obtenerEnvio).not.toHaveBeenCalled();
    expect(mocks.transicionarEnvio).not.toHaveBeenCalled();
  });

  it('una extensión permitida con contenido que no es ese tipo se rechaza (el contenido manda)', async () => {
    mocks.obtenerEnvio.mockResolvedValue(ok({ id: U1, campaignId: CAMPANA }));
    const { POST } = await cargarRuta();
    const r = await POST(
      await peticion(envioTransicion, {
        nombre: 'g.pdf',
        bytes: new TextEncoder().encode('MZ\u0090 no es un pdf'),
      }),
      contexto(),
    );
    expect([415, 422]).toContain(r.status);
    expect(mocks.transicionarEnvio).not.toHaveBeenCalled();
  });

  it('validación del formulario: 422 con el campo', async () => {
    const { POST } = await cargarRuta();
    const r = await POST(
      await peticion({ ...envioTransicion, expectedSeq: '' }, { nombre: 'g.pdf', bytes: PDF }),
      contexto(),
    );
    expect(r.status).toBe(422);
    expect(await r.json()).toMatchObject({ ok: false, campo: 'expectedSeq' });
  });

  it('un envío de OTRA campaña es un 404 y no se guarda nada', async () => {
    mocks.obtenerEnvio.mockResolvedValue(ok({ id: U1, campaignId: OTRA }));
    const { POST } = await cargarRuta();
    const r = await POST(await peticion(envioTransicion, { nombre: 'g.pdf', bytes: PDF }), contexto());
    expect(r.status).toBe(404);
    expect(mocks.transicionarEnvio).not.toHaveBeenCalled();
  });

  it('una obligación que no es la de la participación es un 404', async () => {
    mocks.obtenerSeguimientoDePago.mockResolvedValue(
      ok({ obligation: { id: OTRA, campaignId: CAMPANA }, documents: [] }),
    );
    const { POST } = await cargarRuta();
    const r = await POST(
      await peticion(
        {
          tipo: 'pago',
          accion: 'reportar',
          participacionId: U1,
          paymentObligationId: U1,
          expectedSeq: '1',
          idempotencyKey: 'k',
          paidOn: '2026-05-04',
          externalReference: 'T',
        },
        { nombre: 'c.pdf', bytes: PDF },
      ),
      contexto(),
    );
    expect(r.status).toBe(404);
    expect(mocks.reportarPago).not.toHaveBeenCalled();
  });

  it('transicionar un envío con guía: llama al caso de uso con origen ui y devuelve solo estado y rowSeq', async () => {
    mocks.obtenerEnvio.mockResolvedValue(ok({ id: U1, campaignId: CAMPANA }));
    mocks.transicionarEnvio.mockResolvedValue(
      ok({ repetido: false, envio: { id: U1, status: 'shipped', rowSeq: 2, campaignId: CAMPANA } }),
    );
    const { POST } = await cargarRuta();
    const r = await POST(
      await peticion(
        { ...envioTransicion, organizationId: OTRA, origin: 'chat' },
        { nombre: 'guia.pdf', bytes: PDF },
      ),
      contexto(),
    );
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({
      ok: true,
      tipo: 'envio',
      accion: 'transicionar',
      repetido: false,
      estado: 'shipped',
      rowSeq: 2,
    });
    const [actor, entrada, ctx] = mocks.transicionarEnvio.mock.calls[0]!;
    expect(actor).toMatchObject({ role: 'operativo' });
    expect(ctx).toEqual({ origin: 'ui' });
    expect(entrada).toMatchObject({ shipmentId: U1, to: 'shipped', expectedSeq: 1 });
    expect(entrada.evidencia).toMatchObject({ kind: 'guia', archivo: { filename: 'guia.pdf' } });
    expect(Object.keys(entrada)).not.toContain('organizationId');
    expect(mocks.revalidatePath).toHaveBeenCalledWith(`/campanas/${CAMPANA}/operacion`, 'layout');
  });

  it('errores del dominio: mensaje en español sin ids ni detalles, con el estado HTTP que corresponde', async () => {
    mocks.obtenerEnvio.mockResolvedValue(ok({ id: U1, campaignId: CAMPANA }));
    mocks.transicionarEnvio.mockResolvedValue(
      err({
        code: 'RESOURCE_CONFLICT',
        message: 'interno',
        details: { reason: 'stale_transition', currentSeq: 9, id: OTRA },
      }),
    );
    const { POST } = await cargarRuta();
    const r = await POST(await peticion(envioTransicion, { nombre: 'g.pdf', bytes: PDF }), contexto());
    expect(r.status).toBe(409);
    const cuerpo = JSON.stringify(await r.json());
    expect(cuerpo).toContain('Otra persona cambió este registro');
    expect(cuerpo).not.toContain(OTRA);
    expect(cuerpo).not.toContain('currentSeq');
  });

  it('un fallo inesperado devuelve 500 genérico', async () => {
    mocks.obtenerEnvio.mockRejectedValue(new Error('boom postgres://secreto'));
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { POST } = await cargarRuta();
    const r = await POST(await peticion(envioTransicion, { nombre: 'g.pdf', bytes: PDF }), contexto());
    expect(r.status).toBe(500);
    expect(JSON.stringify(await r.json())).not.toContain('secreto');
    spy.mockRestore();
  });
});
