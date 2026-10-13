/**
 * Cabeceras de seguridad (Release Readiness · Bloque 1).
 *
 * Tres capas: el módulo puro (`security-headers.mjs`), el cableado (`next.config.mjs`) y el middleware REAL
 * (`src/middleware.ts`) ejecutado con peticiones de Next. La verificación contra `next start` está en
 * `scripts/release-readiness-verificacion.sh`.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import {
  CABECERAS_ESTATICAS,
  HASH_ESTILO_404_DE_NEXT,
  HSTS_MAX_AGE_POR_DEFECTO,
  cabecerasDeDocumento,
  construirCsp,
  esBucleLocal,
  hostnameDeCabeceraHost,
  generarNonce,
  leerConfiguracionHsts,
  sirveSobreHttps,
} from './security-headers.mjs';
import nextConfig from './next.config.mjs';
import { config as configDelMiddleware, middleware } from './src/middleware.ts';

const valor = (clave: string): string | undefined => CABECERAS_ESTATICAS.find((c) => c.key === clave)?.value;

/** Directivas de una CSP como mapa nombre → fuentes. */
function directivas(csp: string): Map<string, string[]> {
  return new Map(
    csp
      .split(';')
      .map((d) => d.trim())
      .filter((d) => d !== '')
      .map((d) => {
        const [nombre, ...fuentes] = d.split(/\s+/u);
        return [nombre!, fuentes] as [string, string[]];
      }),
  );
}

const PROD = { produccion: true, nonce: 'NONCE_DE_PRUEBA' } as const;

describe('cabeceras estáticas (F10, preservadas)', () => {
  it('define las cuatro cabeceras que no dependen de la petición', () => {
    expect(valor('X-Content-Type-Options')).toBe('nosniff');
    expect(valor('X-Frame-Options')).toBe('DENY');
    expect(valor('Referrer-Policy')).toBe('strict-origin-when-cross-origin');
    expect(valor('Permissions-Policy')).toBe('camera=(), microphone=(), geolocation=()');
    expect(CABECERAS_ESTATICAS).toHaveLength(4);
  });

  it('next.config las aplica a todas las rutas y NO repite la CSP (un solo mecanismo)', async () => {
    const reglas = await (
      nextConfig as { headers: () => Promise<{ source: string; headers: { key: string }[] }[]> }
    ).headers();
    expect(reglas).toEqual([{ source: '/(.*)', headers: CABECERAS_ESTATICAS }]);
    expect(reglas.flatMap((r) => r.headers.map((h) => h.key.toLowerCase()))).not.toContain(
      'content-security-policy',
    );
  });
});

describe('CSP de PRODUCCIÓN', () => {
  const csp = construirCsp({ ...PROD, https: false });
  const d = directivas(csp);

  it('cierra por defecto y declara una lista blanca explícita por tipo de recurso', () => {
    expect(d.get('default-src')).toEqual(["'none'"]);
    expect(d.get('script-src')).toEqual(["'self'", `'nonce-${PROD.nonce}'`]);
    expect(d.get('style-src')).toEqual(["'self'", `'${HASH_ESTILO_404_DE_NEXT}'`]);
    expect(d.get('style-src-attr')).toEqual(["'unsafe-inline'"]);
    expect(d.get('img-src')).toEqual(["'self'", 'data:']);
    expect(d.get('font-src')).toEqual(["'self'"]);
    expect(d.get('connect-src')).toEqual(["'self'"]);
    expect(d.get('frame-src')).toEqual(["'none'"]);
    expect(d.get('object-src')).toEqual(["'none'"]);
    expect(d.get('base-uri')).toEqual(["'self'"]);
    expect(d.get('form-action')).toEqual(["'self'"]);
    expect(d.get('frame-ancestors')).toEqual(["'none'"]);
  });

  it('sin comodines, sin esquemas amplios y sin unsafe-eval; unsafe-inline solo en style-src-attr', () => {
    expect(csp).not.toMatch(/\*/u);
    expect(csp).not.toMatch(/\bhttps?:(?!\/\/)/u);
    expect(csp).not.toMatch(/unsafe-eval|strict-dynamic|blob:|ws:|wss:/u);
    for (const [nombre, fuentes] of d) {
      if (nombre === 'style-src-attr') continue;
      expect(fuentes, nombre).not.toContain("'unsafe-inline'");
    }
    // Ningún host externo en ninguna directiva.
    expect(csp).not.toMatch(/\bhttps?:\/\//u);
    expect(csp).not.toMatch(/\.[a-z]{2,}\b(?!['"])/u);
  });

  it('upgrade-insecure-requests solo bajo HTTPS (en http://localhost rompería `next start`)', () => {
    expect(csp).not.toContain('upgrade-insecure-requests');
    expect(construirCsp({ ...PROD, https: true })).toContain('upgrade-insecure-requests');
  });

  it('el hash de style-src es el del <style> real de la 404 de Next (detecta cambios al actualizar Next)', () => {
    const fuente = readFileSync(
      join(
        dirname(fileURLToPath(import.meta.url)),
        '../../node_modules/next/dist/client/components/http-access-fallback/error-fallback.js',
      ),
      'utf8',
    );
    const estilo = /__html:\s*"((?:[^"\\]|\\.)*)"/u.exec(fuente)?.[1];
    expect(estilo, 'no se encontró el <style> de la 404 en next/dist (¿cambió Next?)').toBeDefined();
    const hash = `sha256-${createHash('sha256')
      .update(JSON.parse(`"${estilo!}"`), 'utf8')
      .digest('base64')}`;
    expect(hash).toBe(HASH_ESTILO_404_DE_NEXT);
  });

  it('el nonce es base64, de 128 bits, y distinto en cada llamada', () => {
    const nonces = new Set(Array.from({ length: 50 }, () => generarNonce()));
    expect(nonces.size).toBe(50);
    for (const n of nonces) expect(n).toMatch(/^[A-Za-z0-9+/]{22}==$/u);
  });
});

describe('CSP de DESARROLLO', () => {
  const csp = construirCsp({ produccion: false, nonce: 'X', https: true });

  it('conserva las directivas que no tocan scripts y NO restringe scripts (HMR y eval de next dev)', () => {
    expect(csp).toBe("frame-ancestors 'none'; base-uri 'self'; object-src 'none'; form-action 'self'");
    expect(csp).not.toMatch(/script-src|default-src|nonce|upgrade-insecure/u);
  });
});

describe('HSTS: configuración', () => {
  it('por defecto 180 días, sin includeSubDomains ni preload', () => {
    expect(leerConfiguracionHsts({})).toEqual({
      habilitado: true,
      valor: `max-age=${HSTS_MAX_AGE_POR_DEFECTO}`,
    });
    expect(HSTS_MAX_AGE_POR_DEFECTO).toBe(15_552_000);
    expect(leerConfiguracionHsts({ HSTS_MAX_AGE: '' }).valor).toBe('max-age=15552000');
  });

  it('HSTS_MAX_AGE configura los segundos y 0 lo apaga', () => {
    expect(leerConfiguracionHsts({ HSTS_MAX_AGE: '300' }).valor).toBe('max-age=300');
    expect(leerConfiguracionHsts({ HSTS_MAX_AGE: '0' })).toEqual({ habilitado: false, valor: null });
  });

  it('includeSubDomains y preload son opt-in explícito', () => {
    expect(leerConfiguracionHsts({ HSTS_INCLUDE_SUBDOMAINS: 'true' }).valor).toBe(
      'max-age=15552000; includeSubDomains',
    );
    expect(leerConfiguracionHsts({ HSTS_INCLUDE_SUBDOMAINS: 'false' }).valor).toBe('max-age=15552000');
    expect(
      leerConfiguracionHsts({
        HSTS_MAX_AGE: '31536000',
        HSTS_INCLUDE_SUBDOMAINS: 'true',
        HSTS_PRELOAD: 'true',
      }).valor,
    ).toBe('max-age=31536000; includeSubDomains; preload');
  });

  it.each<[string, Record<string, string>]>([
    ['max-age no numérico', { HSTS_MAX_AGE: 'abc' }],
    ['max-age negativo', { HSTS_MAX_AGE: '-1' }],
    ['max-age decimal', { HSTS_MAX_AGE: '1.5' }],
    ['bandera ambigua', { HSTS_INCLUDE_SUBDOMAINS: 'yes' }],
    ['preload sin includeSubDomains', { HSTS_MAX_AGE: '31536000', HSTS_PRELOAD: 'true' }],
    ['preload con max-age < 1 año', { HSTS_INCLUDE_SUBDOMAINS: 'true', HSTS_PRELOAD: 'true' }],
  ])('una configuración inválida falla en vez de interpretarse (%s)', (_nombre, env) => {
    expect(() => leerConfiguracionHsts(env)).toThrow(/HSTS_/u);
  });

  it('next.config se niega a arrancar con HSTS inválido (no hay 500 por petición)', async () => {
    vi.stubEnv('HSTS_MAX_AGE', 'abc');
    vi.resetModules();
    const modulo = './next.config.mjs?hsts-invalido'; // la query fuerza una evaluación nueva del módulo
    await expect(import(modulo)).rejects.toThrow(/HSTS_MAX_AGE/u);
    vi.unstubAllEnvs();
  });
});

describe('HSTS: cuándo se emite', () => {
  const base = {
    nonce: 'n',
    produccion: true,
    protocolo: 'https:',
    forwardedProto: null as string | null,
    hostnames: ['tcl.smartpr.example'],
    env: {} as Record<string, string | undefined>,
  };
  const claves = (o: Partial<typeof base>): string[] =>
    cabecerasDeDocumento({ ...base, ...o }).map((c) => c.key);

  it('producción + HTTPS + dominio real → Strict-Transport-Security', () => {
    expect(claves({})).toEqual(['Content-Security-Policy', 'Strict-Transport-Security']);
    const hsts = cabecerasDeDocumento(base).find((c) => c.key === 'Strict-Transport-Security');
    expect(hsts?.value).toBe('max-age=15552000');
  });

  it('tras un proxy TLS (X-Forwarded-Proto: https) también', () => {
    expect(claves({ protocolo: 'http:', forwardedProto: 'https' })).toContain('Strict-Transport-Security');
    expect(claves({ protocolo: 'http:', forwardedProto: 'https, http' })).toContain(
      'Strict-Transport-Security',
    );
  });

  it('HTTP plano → sin HSTS (ni upgrade-insecure-requests)', () => {
    const c = cabecerasDeDocumento({ ...base, protocolo: 'http:' });
    expect(c.map((h) => h.key)).toEqual(['Content-Security-Policy']);
    expect(c[0]!.value).not.toContain('upgrade-insecure-requests');
    expect(claves({ protocolo: 'http:', forwardedProto: 'http' })).not.toContain('Strict-Transport-Security');
  });

  it('DESARROLLO → nunca HSTS, aunque haya HTTPS y configuración explícita', () => {
    const env = { HSTS_MAX_AGE: '31536000', HSTS_INCLUDE_SUBDOMAINS: 'true' };
    expect(claves({ produccion: false, env })).toEqual(['Content-Security-Policy']);
    expect(claves({ produccion: false, protocolo: 'http:', forwardedProto: 'https', env })).toEqual([
      'Content-Security-Policy',
    ]);
  });

  it.each(['localhost', 'app.localhost', '127.0.0.1', '127.1.2.3', '[::1]', '::1', 'LOCALHOST'])(
    'bucle local (%s) → nunca HSTS, ni en producción con HTTPS',
    (hostname) => {
      expect(esBucleLocal(hostname)).toBe(true);
      expect(claves({ hostnames: [hostname] })).not.toContain('Strict-Transport-Security');
    },
  );

  it('sin cabecera Host utilizable → sin HSTS (fail-safe)', () => {
    expect(claves({ hostnames: [] })).not.toContain('Strict-Transport-Security');
    expect(claves({ hostnames: [''] })).not.toContain('Strict-Transport-Security');
  });

  it('basta que UNO de los nombres sea bucle local (URL de Next o cabecera Host) para omitir HSTS', () => {
    expect(claves({ hostnames: ['tcl.smartpr.example', 'localhost'] })).not.toContain(
      'Strict-Transport-Security',
    );
    expect(hostnameDeCabeceraHost('localhost:3000')).toBe('localhost');
    expect(hostnameDeCabeceraHost('[::1]:3000')).toBe('[::1]');
    expect(hostnameDeCabeceraHost('tcl.smartpr.example')).toBe('tcl.smartpr.example');
    expect(hostnameDeCabeceraHost('')).toBe('');
  });

  it('esBucleLocal no confunde dominios reales', () => {
    for (const h of [
      'localhost.example.com',
      'mylocalhost',
      '127.0.0.1.example.com',
      '10.0.0.1',
      'tcl.com',
    ]) {
      expect(esBucleLocal(h), h).toBe(false);
    }
  });

  it('HSTS_MAX_AGE=0 lo apaga en producción sobre HTTPS', () => {
    expect(claves({ env: { HSTS_MAX_AGE: '0' } })).toEqual(['Content-Security-Policy']);
  });

  it('la configuración llega al valor emitido', () => {
    const env = { HSTS_MAX_AGE: '31536000', HSTS_INCLUDE_SUBDOMAINS: 'true', HSTS_PRELOAD: 'true' };
    const hsts = cabecerasDeDocumento({ ...base, env }).find((c) => c.key === 'Strict-Transport-Security');
    expect(hsts?.value).toBe('max-age=31536000; includeSubDomains; preload');
  });

  it('sirveSobreHttps: protocolo propio o X-Forwarded-Proto', () => {
    expect(sirveSobreHttps({ protocolo: 'https:', forwardedProto: null })).toBe(true);
    expect(sirveSobreHttps({ protocolo: 'http:', forwardedProto: 'HTTPS' })).toBe(true);
    expect(sirveSobreHttps({ protocolo: 'http:', forwardedProto: 'http' })).toBe(false);
    expect(sirveSobreHttps({ protocolo: 'http:', forwardedProto: null })).toBe(false);
  });
});

describe('middleware (ejecutado con peticiones de Next)', () => {
  afterEach(() => vi.unstubAllEnvs());
  const pedir = (url: string, cabeceras: Record<string, string> = {}): NextRequest =>
    new NextRequest(url, { headers: cabeceras });

  it('PRODUCCIÓN: CSP con nonce propio de la respuesta, el mismo en la petición reenviada; sin HSTS en http', () => {
    vi.stubEnv('NODE_ENV', 'production');
    const r = middleware(pedir('http://localhost:3000/login'));
    const csp = r.headers.get('content-security-policy')!;
    const nonce = /'nonce-([^']+)'/u.exec(csp)![1]!;
    // Next lee el nonce de la CSP de la PETICIÓN reenviada.
    expect(r.headers.get('x-middleware-request-content-security-policy')).toBe(csp);
    expect(csp).toContain(`script-src 'self' 'nonce-${nonce}'`);
    expect(r.headers.get('strict-transport-security')).toBeNull();
  });

  it('PRODUCCIÓN: cada respuesta lleva un nonce distinto', () => {
    vi.stubEnv('NODE_ENV', 'production');
    const nonces = [1, 2, 3].map(
      (i) =>
        /'nonce-([^']+)'/u.exec(
          middleware(pedir(`http://localhost:3000/p${i}`)).headers.get('content-security-policy')!,
        )![1],
    );
    expect(new Set(nonces).size).toBe(3);
  });

  it('PRODUCCIÓN + HTTPS (tras el proxy) + dominio real: HSTS configurable por entorno', () => {
    vi.stubEnv('NODE_ENV', 'production');
    const proxy = { 'x-forwarded-proto': 'https', host: 'tcl.smartpr.example' };
    const r = middleware(pedir('http://tcl.smartpr.example/tcl', proxy));
    expect(r.headers.get('strict-transport-security')).toBe('max-age=15552000');
    expect(r.headers.get('content-security-policy')).toContain('upgrade-insecure-requests');

    vi.stubEnv('HSTS_MAX_AGE', '86400');
    vi.stubEnv('HSTS_INCLUDE_SUBDOMAINS', 'true');
    expect(
      middleware(pedir('http://tcl.smartpr.example/tcl', proxy)).headers.get('strict-transport-security'),
    ).toBe('max-age=86400; includeSubDomains');

    vi.stubEnv('HSTS_MAX_AGE', '0');
    expect(
      middleware(pedir('http://tcl.smartpr.example/tcl', proxy)).headers.get('strict-transport-security'),
    ).toBeNull();
  });

  it('PRODUCCIÓN + localhost: sin HSTS aunque el proxy diga https', () => {
    vi.stubEnv('NODE_ENV', 'production');
    const r = middleware(pedir('http://localhost:3000/', { 'x-forwarded-proto': 'https' }));
    expect(r.headers.get('strict-transport-security')).toBeNull();
  });

  it('DESARROLLO: CSP mínima sin script-src y sin HSTS aunque se pida por https', () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('HSTS_MAX_AGE', '31536000');
    for (const url of ['http://localhost:3000/login', 'https://tcl.smartpr.example/login']) {
      const r = middleware(pedir(url, { 'x-forwarded-proto': 'https' }));
      expect(r.headers.get('content-security-policy')).toBe(
        "frame-ancestors 'none'; base-uri 'self'; object-src 'none'; form-action 'self'",
      );
      expect(r.headers.get('strict-transport-security')).toBeNull();
    }
  });

  it('el matcher excluye solo los estáticos de Next (todo documento y /api pasan por el middleware)', () => {
    const [patron] = configDelMiddleware.matcher;
    const re = new RegExp(`^${patron!}$`, 'u');
    for (const ruta of [
      '/',
      '/login',
      '/tcl',
      '/campanas/abc/chat',
      '/api/health',
      '/api/tcl/campanas/x/export',
    ]) {
      expect(re.test(ruta), ruta).toBe(true);
    }
    for (const ruta of ['/_next/static/chunks/a.js', '/_next/image', '/favicon.ico']) {
      expect(re.test(ruta), ruta).toBe(false);
    }
  });
});
