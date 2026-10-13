/**
 * Comprobación de origen de los route handlers de chat y guiones SIN base de datos: usan la comprobación
 * ESTRICTA (no confían en `x-forwarded-host`, UI-09) y rechazan ANTES de tocar sesión o base.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { origenPermitidoEstricto } from './origen.ts';

const CAMPANA = '44444444-4444-4444-8444-444444444444';

const mocks = vi.hoisted(() => ({ currentUser: vi.fn(), getCampaign: vi.fn() }));

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('./session.ts', () => ({ currentUser: mocks.currentUser }));
vi.mock('./chat-server.ts', () => ({ limiteDeAdjuntoBytes: () => 1024 * 1024 }));
vi.mock('@tcl-kol-os/db', () => ({ getCampaign: mocks.getCampaign }));

const contexto = { params: Promise.resolve({ id: CAMPANA }) };

function peticion(cabeceras: Record<string, string>): Request {
  return new Request('http://app.test/api/x', {
    method: 'POST',
    headers: { host: 'app.test', ...cabeceras },
  });
}

const HOSTILES: Record<string, string>[] = [
  { origin: 'http://evil.test', 'x-forwarded-host': 'evil.test' },
  { origin: 'http://evil.test' },
  { 'sec-fetch-site': 'cross-site' },
];

beforeEach(() => {
  vi.clearAllMocks();
});

describe('origenPermitidoEstricto (compartida)', () => {
  it('no confía en x-forwarded-host', () => {
    expect(
      origenPermitidoEstricto(peticion({ origin: 'http://evil.test', 'x-forwarded-host': 'evil.test' })),
    ).toBe(false);
    expect(origenPermitidoEstricto(peticion({ origin: 'http://app.test' }))).toBe(true);
  });
});

describe('POST /api/campanas/[id]/chat/adjuntos', () => {
  it.each(HOSTILES)('rechaza el origen %o con 403 sin tocar sesión ni base', async (cabeceras) => {
    const { POST } = await import('../app/api/campanas/[id]/chat/adjuntos/route.ts');
    const r = await POST(peticion(cabeceras), contexto);
    expect(r.status).toBe(403);
    expect(await r.json()).toEqual({ error: 'Petición no permitida.' });
    expect(mocks.currentUser).not.toHaveBeenCalled();
    expect(mocks.getCampaign).not.toHaveBeenCalled();
  });

  it('el mismo origen pasa a la sesión (401 sin sesión)', async () => {
    mocks.currentUser.mockResolvedValue(undefined);
    const { POST } = await import('../app/api/campanas/[id]/chat/adjuntos/route.ts');
    const r = await POST(peticion({ origin: 'http://app.test', 'sec-fetch-site': 'same-origin' }), contexto);
    expect(r.status).toBe(401);
  });
});

describe('POST /api/campanas/[id]/contenido/guiones', () => {
  it.each(HOSTILES)('rechaza el origen %o con 403 FORBIDDEN sin tocar sesión ni base', async (cabeceras) => {
    const { POST } = await import('../app/api/campanas/[id]/contenido/guiones/route.ts');
    const r = await POST(peticion(cabeceras), contexto);
    expect(r.status).toBe(403);
    expect(await r.json()).toMatchObject({ ok: false, codigo: 'FORBIDDEN' });
    expect(mocks.currentUser).not.toHaveBeenCalled();
    expect(mocks.getCampaign).not.toHaveBeenCalled();
  });

  it('el mismo origen pasa a la sesión (401 sin sesión)', async () => {
    mocks.currentUser.mockResolvedValue(undefined);
    const { POST } = await import('../app/api/campanas/[id]/contenido/guiones/route.ts');
    const r = await POST(peticion({ origin: 'http://app.test', 'sec-fetch-site': 'same-origin' }), contexto);
    expect(r.status).toBe(401);
  });
});
