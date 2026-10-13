/**
 * QA adversarial F10 (independiente) — ATAQUES 17, 18, 19 y EXTRA a la capa web, SIN base de datos.
 *
 *  · (18) rutas legadas `/campanas/**`: el cliente se desvía ANTES de cualquier cargador (orden textual y banderas).
 *  · (19) banderas: `AUTH_PROVIDER`, `AI_ENABLED`, `BRIEF_WORKSPACE_V2`; el acceso de desarrollo nunca se abre por omisión.
 *  · (17) export TCL: HEAD ⇒ 405 sin sesión ni base, solo GET/HEAD, 404 byte a byte idéntico en todos los fallos.
 *  · EXTRA: cabeceras de seguridad, `origenPermitidoEstricto` (Origin falso, userinfo, subdominios, `x-forwarded-host`).
 *
 * Los hallazgos abiertos se marcan `it.fails` con su identificador QA-F10-NN: pasan en verde mientras el defecto exista y
 * se ponen en rojo el día que se corrija (entonces hay que convertirlos en pruebas normales).
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { iaActiva, secretoDelNonce, type Role, type User, err, ok } from '@tcl-kol-os/domain';
import { CABECERAS_DE_SEGURIDAD } from '../../security-headers.mjs';
import type * as ModuloSesion from './session.ts';
import { origenPermitidoEstricto } from './origen.ts';
import { destinoTclDeRutaLegada } from './tcl-rutas.ts';

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const RAIZ = resolve(SRC, '../../..');

const mocks = vi.hoisted(() => ({
  currentUser: vi.fn(),
  exportarCampanaParaTcl: vi.fn(),
  findUserByEmail: vi.fn(),
  findUserById: vi.fn(),
}));
vi.mock('./session.ts', async (importar) => {
  const real = await importar<typeof ModuloSesion>();
  return { ...real, currentUser: mocks.currentUser };
});
vi.mock('next/headers', () => ({
  cookies: async () => ({ set: vi.fn(), delete: vi.fn(), get: () => undefined }),
}));
vi.mock('next/navigation', () => ({
  redirect: (u: string) => {
    throw new Error(`NEXT_REDIRECT:${u}`);
  },
  notFound: () => {
    throw new Error('NEXT_NOT_FOUND');
  },
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@tcl-kol-os/db', () => ({
  exportarCampanaParaTcl: mocks.exportarCampanaParaTcl,
  findUserByEmail: mocks.findUserByEmail,
  findUserById: mocks.findUserById,
}));

function archivos(dir: string, patron: RegExp): string[] {
  const salida: string[] = [];
  for (const nombre of readdirSync(dir)) {
    const ruta = join(dir, nombre);
    if (statSync(ruta).isDirectory()) salida.push(...archivos(ruta, patron));
    else if (patron.test(nombre)) salida.push(ruta);
  }
  return salida;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

// ─────────────────────────── (18) rutas legadas ────────────────────────────────

describe('QA F10 · (18) rutas legadas: el cliente se desvía ANTES de cualquier cargador', () => {
  const paginas = archivos(join(SRC, 'app/(app)/campanas'), /^page\.tsx$/u).concat(
    join(SRC, 'app/(app)/page.tsx'),
  );

  it('encuentra las 16 páginas legadas y TODAS invocan el desvío del cliente', () => {
    expect(paginas.length).toBe(16);
    for (const p of paginas) {
      expect(readFileSync(p, 'utf8'), relative(SRC, p)).toContain('desviarClienteDeRutaLegada(');
    }
  });

  it('antes del desvío no hay llamadas a cargadores de db, lectura de banderas ni de parámetros de búsqueda', () => {
    for (const p of paginas) {
      const t = readFileSync(p, 'utf8');
      const nombresDeDb = [
        ...(t.match(/import\s*\{([^}]*)\}\s*from\s*'@tcl-kol-os\/db'/u)?.[1] ?? '').split(','),
      ]
        .map((n) => n.trim().replace(/^type\s+/u, ''))
        .filter((n) => n !== '');
      const cuerpo = t.slice(t.search(/export default (async )?function/u));
      const corte = cuerpo.indexOf('desviarClienteDeRutaLegada(');
      const previo = cuerpo.slice(0, corte);
      for (const n of nombresDeDb) {
        expect(previo, `${relative(SRC, p)}: ${n}() antes del desvío`).not.toMatch(
          new RegExp(`\\b${n}\\(`, 'u'),
        );
      }
      expect(previo, `${relative(SRC, p)}: bandera leída antes del desvío`).not.toContain('process.env');
    }
  });

  it('un cliente jamás recibe un destino que no sea /tcl; ids hostiles nunca llegan a la redirección', () => {
    const hostiles = [
      '../../evil',
      'x?y=1',
      '//evil.test',
      '',
      'javascript:alert(1)',
      '11111111-1111-4111-8111-11111111111g',
      '11111111-1111-4111-8111-111111111111/../../x',
      '%2e%2e/x',
    ];
    for (const tipo of ['detalle', 'brief', 'fuentes'] as const) {
      for (const id of hostiles) expect(destinoTclDeRutaLegada({ tipo, id }), `${tipo} ${id}`).toBeNull();
    }
    for (const tipo of ['oculta', 'lista'] as const) {
      const d = destinoTclDeRutaLegada({ tipo } as never);
      expect(d === null || d === '/tcl').toBe(true);
    }
  });

  it('el layout autenticado solo comprueba sesión; la página es quien desvía (y no hay middleware que lo contradiga)', () => {
    expect(readdirSync(join(SRC)).filter((n) => /^middleware\./u.test(n))).toEqual([]);
    const layout = readFileSync(join(SRC, 'app/(app)/layout.tsx'), 'utf8');
    expect(layout).not.toMatch(/@tcl-kol-os\/db/u);
  });

  it('ninguna ruta legada expone una route handler de escritura (solo los 3 POST internos de subida con origen estricto)', () => {
    const rutas = archivos(join(SRC, 'app/api'), /^route\.ts$/u)
      .map((r) => relative(SRC, r))
      .sort();
    expect(rutas).toEqual([
      'app/api/campanas/[id]/chat/adjuntos/route.ts',
      'app/api/campanas/[id]/contenido/guiones/route.ts',
      'app/api/campanas/[id]/operacion/evidencia/route.ts',
      'app/api/health/route.ts',
      'app/api/ready/route.ts',
      'app/api/tcl/campanas/[id]/export/route.ts',
    ]);
    for (const r of rutas.filter((x) => x.includes('/campanas/[id]/') && !x.includes('/tcl/'))) {
      const t = readFileSync(join(SRC, r), 'utf8');
      expect(t, r).toMatch(/origenPermitidoEstricto\(request\)/u);
      // Cliente TCL: ni siquiera el rol con `chat:write`/`script:manage`/`operations:read`.
      expect(t, r).toMatch(/roleCan\(/u);
    }
  });
});

// ─────────────────────────── (19) banderas ─────────────────────────────────────

describe('QA F10 · (19) banderas de entorno', () => {
  const combos: Array<[string | undefined, string, string]> = [
    [undefined, 'production', 'oidc'],
    ['', 'production', 'oidc'],
    ['  dev  ', 'production', 'oidc'],
    ['DEV', 'production', 'oidc'],
    ['true', 'production', 'oidc'],
    ['oidc', 'production', 'oidc'],
    ['oidc', 'development', 'oidc'],
    ['dev', 'development', 'dev'],
    [undefined, 'development', 'dev'],
    [undefined, 'test', 'dev'],
  ];
  it.each(combos)('authProvider(AUTH_PROVIDER=%j, NODE_ENV=%s) = %s', async (valor, nodeEnv, esperado) => {
    vi.stubEnv('NODE_ENV', nodeEnv);
    if (valor === undefined) {
      delete process.env['AUTH_PROVIDER'];
    } else vi.stubEnv('AUTH_PROVIDER', valor);
    const { authProvider } = await vi.importActual<typeof ModuloSesion>('./session.ts');
    expect(authProvider()).toBe(esperado);
  });

  it('iniciarSesion en producción sin AUTH_PROVIDER (o con un valor raro) NO consulta usuarios ni crea cookie', async () => {
    const { iniciarSesion } = await import('./actions.ts');
    for (const valor of [undefined, '', 'Dev', 'cualquiera', 'oidc']) {
      vi.stubEnv('NODE_ENV', 'production');
      if (valor === undefined) delete process.env['AUTH_PROVIDER'];
      else vi.stubEnv('AUTH_PROVIDER', valor);
      const f = new FormData();
      f.set('email', 'gerardo@smartpr.co');
      const r = await iniciarSesion(undefined, f);
      expect(r.error, String(valor)).toBeDefined();
    }
    expect(mocks.findUserByEmail).not.toHaveBeenCalled();
  });

  it('el kill-switch de IA: solo 1/true/yes (sin mayúsculas ni espacios) lo enciende; todo lo demás, apagado', () => {
    const on = (v: string | undefined): boolean => iaActiva((n) => (n === 'AI_ENABLED' ? v : undefined));
    for (const v of ['1', 'true', 'TRUE', ' yes ', 'Yes']) expect(on(v), v).toBe(true);
    for (const v of [
      undefined,
      '',
      'false',
      '0',
      'no',
      'on',
      'enabled',
      'tru',
      'truee',
      'true;',
      '2',
      'null',
    ])
      expect(on(v), String(v)).toBe(false);
  });

  it('el secreto del nonce falla CERRADO en producción (vacío, corto o con espacios) y nunca devuelve un valor corto', () => {
    const s = (env: Record<string, string>): string | undefined => secretoDelNonce((n) => env[n]);
    expect(s({ NODE_ENV: 'production' })).toBeUndefined();
    expect(s({ NODE_ENV: 'production', SESSION_SECRET: 'corto' })).toBeUndefined();
    expect(
      s({ NODE_ENV: 'production', AGENT_NONCE_SECRET: 'corto', SESSION_SECRET: 'x'.repeat(40) }),
    ).toBeUndefined();
    expect(s({ NODE_ENV: 'production', SESSION_SECRET: ' '.repeat(40) })).toBeUndefined();
    expect(s({ NODE_ENV: 'production', SESSION_SECRET: 'x'.repeat(16) })).toBe('x'.repeat(16));
    expect(s({ NODE_ENV: 'development' })).toBe('desarrollo-inseguro-no-usar-en-produccion');
  });

  it('BRIEF_WORKSPACE_V2 solo se compara con la cadena exacta "true" y nunca antes del desvío del cliente', () => {
    for (const p of [
      'app/(app)/campanas/[id]/page.tsx',
      'app/(app)/campanas/[id]/brief/workspace/page.tsx',
    ]) {
      const t = readFileSync(join(SRC, p), 'utf8');
      expect(t).toMatch(/process\.env\['BRIEF_WORKSPACE_V2'\] === 'true'/u);
      const cuerpo = t.slice(t.search(/export default (async )?function/u));
      expect(cuerpo.indexOf('desviarClienteDeRutaLegada('), p).toBeGreaterThan(-1);
      expect(
        cuerpo.indexOf('briefWorkspaceV2Activo()') === -1 ||
          cuerpo.indexOf('desviarClienteDeRutaLegada(') < cuerpo.indexOf('briefWorkspaceV2Activo()'),
        p,
      ).toBe(true);
    }
  });

  // QA-F10-02 (abierto, P2): la plantilla `.env.example` trae `AUTH_PROVIDER=dev` ACTIVO. Quien la copia a `.env`
  // (como indica su cabecera) y despliega con NODE_ENV=production anula el cierre por omisión: «dev» ES el opt-in.
  it('QA-F10-02 corregido · la plantilla .env.example no activa AUTH_PROVIDER=dev por omisión', () => {
    const plantilla = readFileSync(join(RAIZ, '.env.example'), 'utf8');
    expect(plantilla).not.toMatch(/^AUTH_PROVIDER=dev\s*$/mu);
  });

  // QA-F10-03 (abierto, P3): en producción `SESSION_SECRET` solo debe ser «no vacío» (1 carácter basta), mientras que el
  // secreto del nonce exige ≥16. Una cookie firmada con un secreto trivial es falsificable por fuerza bruta.
  it('QA-F10-03 corregido · un SESSION_SECRET corto se rechaza en producción', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('SESSION_SECRET', 'x');
    const { buildSessionValue } = await vi.importActual<typeof ModuloSesion>('./session.ts');
    expect(() => buildSessionValue('11111111-1111-4111-8111-111111111111')).toThrow();
  });
});

// ─────────────────────────── (17) export TCL ───────────────────────────────────

const ID = '44444444-4444-4444-8444-444444444444';
const usuario = (role: Role): User => ({
  id: '22222222-2222-4222-8222-222222222222',
  email: 'p@tcl.test',
  name: 'Persona',
  organizationId: '55555555-5555-4555-8555-555555555555',
  role,
  status: 'activo',
});

describe('QA F10 · (17) export TCL', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.currentUser.mockResolvedValue(usuario('cliente'));
    mocks.exportarCampanaParaTcl.mockResolvedValue(
      ok({
        formato: 'csv',
        contentType: 'text/csv; charset=utf-8',
        extension: 'csv',
        contenido: 'a\r\n',
        nombreDeArchivo: 'tcl-campana-20261012.csv',
      }),
    );
  });

  it('HEAD ⇒ 405 con Allow: GET, sin leer sesión ni ejecutar la proyección (con y sin sesión de cliente)', async () => {
    const ruta = await import('../app/api/tcl/campanas/[id]/export/route.ts');
    for (const u of [usuario('cliente'), undefined, usuario('admin')]) {
      mocks.currentUser.mockResolvedValue(u);
      const r = ruta.HEAD();
      expect(r.status).toBe(405);
      expect(r.headers.get('allow')).toBe('GET');
      expect(await r.text()).toBe('');
    }
    expect(mocks.currentUser).not.toHaveBeenCalled();
    expect(mocks.exportarCampanaParaTcl).not.toHaveBeenCalled();
  });

  it('la ruta solo exporta GET y HEAD: POST/PUT/PATCH/DELETE los responde Next con 405', async () => {
    const ruta = (await import('../app/api/tcl/campanas/[id]/export/route.ts')) as Record<string, unknown>;
    const metodos = Object.keys(ruta).filter((k) => /^[A-Z]+$/u.test(k));
    expect(metodos.sort()).toEqual(['GET', 'HEAD']);
  });

  it('todo fallo (sin sesión, rol interno, id raro, formato raro, caso de uso denegado) da el MISMO 404 byte a byte', async () => {
    const { GET } = await import('../app/api/tcl/campanas/[id]/export/route.ts');
    const pedir = async (id: string, query: string): Promise<Response> =>
      GET(new Request(`http://localhost/api/tcl/campanas/${id}/export?${query}`), {
        params: Promise.resolve({ id }),
      });
    const cuerpos = new Set<string>();
    const cabeceras = new Set<string>();
    const anotar = async (r: Response): Promise<void> => {
      expect(r.status).toBe(404);
      cuerpos.add(await r.text());
      cabeceras.add(JSON.stringify([...r.headers.entries()].filter(([k]) => k !== 'content-length').sort()));
    };
    mocks.currentUser.mockResolvedValueOnce(undefined);
    await anotar(await pedir(ID, 'formato=csv'));
    for (const rol of ['admin', 'director', 'consultor', 'operativo', 'analista', 'legal'] as const) {
      mocks.currentUser.mockResolvedValueOnce(usuario(rol));
      await anotar(await pedir(ID, 'formato=csv'));
    }
    for (const id of ['no-es-uuid', '../x', '%00', 'A'.repeat(500), ''])
      await anotar(await pedir(id, 'formato=csv'));
    for (const q of [
      'formato=xml',
      'formato=CSV',

      'formato[]=csv',
      'formato=',
      '',
      'formato=csv%00',
      'formato=json%0d%0aSet-Cookie:a=b',
    ])
      await anotar(await pedir(ID, q));
    mocks.exportarCampanaParaTcl.mockResolvedValueOnce(err({ code: 'RESOURCE_NOT_FOUND', message: 'x' }));
    await anotar(await pedir(ID, 'formato=csv'));
    mocks.exportarCampanaParaTcl.mockResolvedValueOnce(
      err({ code: 'FORBIDDEN_ROLE', message: 'detalle interno' }),
    );
    await anotar(await pedir(ID, 'formato=csv'));
    expect(cuerpos.size, 'cuerpos distintos revelan por qué falló').toBe(1);
    expect(cabeceras.size, 'cabeceras distintas revelan por qué falló').toBe(1);
  });

  it('un error inesperado del caso de uso da un 500 genérico sin trazas ni mensajes', async () => {
    const { GET } = await import('../app/api/tcl/campanas/[id]/export/route.ts');
    mocks.exportarCampanaParaTcl.mockRejectedValueOnce(
      new Error('connection to server at "db" failed: password authentication for user tclkolos'),
    );
    const r = await GET(new Request(`http://localhost/x?formato=csv`), {
      params: Promise.resolve({ id: ID }),
    });
    expect(r.status).toBe(500);
    const t = await r.text();
    expect(t).not.toMatch(/password|tclkolos|connection|at \w+/iu);
  });
});

// ─────────────────────────── EXTRA: cabeceras y origen ─────────────────────────

describe('QA F10 · EXTRA · cabeceras de seguridad', () => {
  const por = (k: string): string | undefined => CABECERAS_DE_SEGURIDAD.find((c) => c.key === k)?.value;

  it('nosniff, DENY, referrer estricto, permisos mínimos y CSP sin directivas permisivas', () => {
    expect(por('X-Content-Type-Options')).toBe('nosniff');
    expect(por('X-Frame-Options')).toBe('DENY');
    expect(por('Referrer-Policy')).toBe('strict-origin-when-cross-origin');
    expect(por('Permissions-Policy')).toBe('camera=(), microphone=(), geolocation=()');
    const csp = por('Content-Security-Policy')!;
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'self'");
    expect(csp).toContain("form-action 'self'");
    expect(csp).not.toMatch(/unsafe-|\*|data:|http:/u);
  });

  it('se aplican a TODAS las rutas (también /api y /tcl) por next.config', () => {
    const t = readFileSync(join(SRC, '../next.config.mjs'), 'utf8');
    expect(t).toMatch(/source:\s*'\/\(\.\*\)'/u);
    expect(t).toContain('CABECERAS_DE_SEGURIDAD');
    expect(t).toMatch(/poweredByHeader:\s*false/u);
  });

  it('el CSP coincide en la clave exacta y no hay claves duplicadas', () => {
    const claves = CABECERAS_DE_SEGURIDAD.map((c) => c.key.toLowerCase());
    expect(new Set(claves).size).toBe(claves.length);
  });

  // QA-F10-04 (abierto, P3): sin `Strict-Transport-Security` ni `script-src`/`default-src`: no hay defensa en
  // profundidad frente a XSS ni degradación a HTTP (declarado en `security-headers.mjs`; sin cerrar).
  it.fails('QA-F10-04 abierto · hay HSTS y una política de scripts', () => {
    expect(por('Strict-Transport-Security')).toBeDefined();
    expect(por('Content-Security-Policy')).toMatch(/script-src|default-src/u);
  });
});

describe('QA F10 · EXTRA · origenPermitidoEstricto', () => {
  const pet = (cabeceras: Record<string, string>): Request =>
    new Request('http://app.test/api/x', { method: 'POST', headers: { host: 'app.test', ...cabeceras } });

  it.each<[string, Record<string, string>, boolean]>([
    ['mismo origen', { origin: 'http://app.test' }, true],
    ['Origin en mayúsculas', { origin: 'http://APP.TEST' }, true],
    ['sin cabeceras (no es un navegador)', {}, true],
    ['sec-fetch-site none', { 'sec-fetch-site': 'none' }, true],
    ['origen ajeno', { origin: 'http://evil.test' }, false],
    ['subdominio que contiene el host', { origin: 'http://app.test.evil.test' }, false],
    ['host como sufijo', { origin: 'http://evilapp.test' }, false],
    ['userinfo engañoso', { origin: 'http://app.test@evil.test' }, false],
    ['userinfo inverso', { origin: 'http://evil.test@app.test' }, true],
    ['otro puerto', { origin: 'http://app.test:8080' }, false],
    ['Origin: null (iframe sandbox, file://)', { origin: 'null' }, false],
    ['Origin con basura', { origin: 'no es una url' }, false],
    ['Origin vacío', { origin: '' }, false],
    [
      'cross-site declarado aunque el Origin sea propio',
      { origin: 'http://app.test', 'sec-fetch-site': 'cross-site' },
      false,
    ],
    ['same-site (otro subdominio) no basta', { 'sec-fetch-site': 'same-site' }, false],
    ['x-forwarded-host no cuenta', { origin: 'http://evil.test', 'x-forwarded-host': 'evil.test' }, false],
    [
      'x-forwarded-host lista',
      { origin: 'http://evil.test', 'x-forwarded-host': 'a.test, evil.test' },
      false,
    ],
    ['forwarded estándar no cuenta', { origin: 'http://evil.test', forwarded: 'host=evil.test' }, false],
    ['x-original-host no cuenta', { origin: 'http://evil.test', 'x-original-host': 'evil.test' }, false],
    [
      'x-forwarded-host ajeno pero Origin propio sigue siendo propio',
      { origin: 'http://app.test', 'x-forwarded-host': 'evil.test' },
      true,
    ],
  ])('%s', (_n, cabeceras, esperado) => {
    expect(origenPermitidoEstricto(pet(cabeceras))).toBe(esperado);
  });

  it('un Host vacío o ausente nunca coincide con un Origin', () => {
    const sinHost = new Request('http://app.test/api/x', {
      method: 'POST',
      headers: { origin: 'http://app.test' },
    });
    // `Request` añade Host solo en servidor real; sin él, el Origin no se puede comparar y se rechaza.
    expect(origenPermitidoEstricto(sinHost) === false || sinHost.headers.get('host') === 'app.test').toBe(
      true,
    );
  });
});
