/** Route handler del export TCL sin base de datos: 404 uniforme, cabeceras seguras y 500 genérico. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { type Role, type User, err, ok } from '@tcl-kol-os/domain';

const ID = '44444444-4444-4444-8444-444444444444';

const mocks = vi.hoisted(() => ({ currentUser: vi.fn(), exportarCampanaParaTcl: vi.fn() }));
vi.mock('./session.ts', () => ({ currentUser: mocks.currentUser }));
vi.mock('@tcl-kol-os/db', () => ({ exportarCampanaParaTcl: mocks.exportarCampanaParaTcl }));

const usuario = (role: Role): User => ({
  id: '22222222-2222-4222-8222-222222222222',
  email: 'p@tcl.test',
  name: 'Persona',
  organizationId: '55555555-5555-4555-8555-555555555555',
  role,
  status: 'activo',
});

async function pedir(id: string, query = 'formato=csv'): Promise<Response> {
  const { GET } = await import('../app/api/tcl/campanas/[id]/export/route.ts');
  return GET(new Request(`http://localhost/api/tcl/campanas/${id}/export?${query}`), {
    params: Promise.resolve({ id }),
  });
}

const NO_ENCONTRADO = { code: 'RESOURCE_NOT_FOUND' as const, message: 'x' };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.currentUser.mockResolvedValue(usuario('cliente'));
  mocks.exportarCampanaParaTcl.mockResolvedValue(
    ok({
      formato: 'csv',
      contentType: 'text/csv; charset=utf-8',
      extension: 'csv',
      contenido: 'a,b\n',
      nombreDeArchivo: 'tcl-campana-20261003.csv',
    }),
  );
});

describe('GET /api/tcl/campanas/[id]/export', () => {
  it('entrega el archivo con las cabeceras seguras', async () => {
    const r = await pedir(ID);
    expect(r.status).toBe(200);
    expect(await r.text()).toBe('a,b\n');
    expect(r.headers.get('content-type')).toBe('text/csv; charset=utf-8');
    expect(r.headers.get('content-disposition')).toBe('attachment; filename="tcl-campana-20261003.csv"');
    expect(r.headers.get('x-content-type-options')).toBe('nosniff');
    expect(r.headers.get('cache-control')).toBe('private, no-store');
    expect(mocks.exportarCampanaParaTcl).toHaveBeenCalledWith(expect.anything(), ID, 'csv');
  });

  it('sanea un nombre de archivo hostil', async () => {
    mocks.exportarCampanaParaTcl.mockResolvedValue(
      ok({
        contenido: '{}',
        contentType: 'application/json',
        extension: 'json',
        formato: 'json',
        nombreDeArchivo: 'a"\r\nSet-Cookie: x.json',
      }),
    );
    const r = await pedir(ID, 'formato=json');
    const cd = r.headers.get('content-disposition') ?? '';
    expect(cd).not.toMatch(/[\r\n]/u);
    expect(cd.match(/"/gu)?.length).toBe(2);
  });

  it('sin sesión, rol interno, id mal formado, formato desconocido o fallo del caso de uso: el MISMO 404', async () => {
    const respuestas: Response[] = [];
    mocks.currentUser.mockResolvedValueOnce(undefined);
    respuestas.push(await pedir(ID));
    for (const rol of ['admin', 'director', 'consultor', 'operativo', 'analista', 'legal'] as const) {
      mocks.currentUser.mockResolvedValueOnce(usuario(rol));
      respuestas.push(await pedir(ID));
    }
    respuestas.push(await pedir('no-es-uuid'));
    respuestas.push(await pedir(ID, 'formato=xml'));
    respuestas.push(await pedir(ID, ''));
    mocks.exportarCampanaParaTcl.mockResolvedValueOnce(err(NO_ENCONTRADO));
    respuestas.push(await pedir(ID));
    const cuerpos = await Promise.all(respuestas.map(async (r) => [r.status, await r.text()] as const));
    for (const c of cuerpos) expect(c).toEqual(cuerpos[0]);
    expect(cuerpos[0]![0]).toBe(404);
    expect(mocks.exportarCampanaParaTcl).toHaveBeenCalledTimes(1);
  });

  it('un error inesperado da 500 genérico, sin detalles', async () => {
    const espiar = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    mocks.exportarCampanaParaTcl.mockRejectedValueOnce(new Error('SECRETO-DE-BASE-DE-DATOS'));
    const r = await pedir(ID);
    expect(r.status).toBe(500);
    const t = await r.text();
    expect(t).not.toContain('SECRETO');
    expect(r.headers.get('cache-control')).toBe('private, no-store');
    espiar.mockRestore();
  });
});
