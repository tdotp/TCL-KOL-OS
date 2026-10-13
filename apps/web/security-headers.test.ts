/** Cabeceras de seguridad globales: lista exacta y cableado en `next.config.mjs`. */
import { describe, expect, it } from 'vitest';
import { CABECERAS_DE_SEGURIDAD } from './security-headers.mjs';
import nextConfig from './next.config.mjs';

const valor = (clave: string): string | undefined =>
  (CABECERAS_DE_SEGURIDAD as { key: string; value: string }[]).find((c) => c.key === clave)?.value;

describe('cabeceras de seguridad', () => {
  it('define las cinco cabeceras esperadas', () => {
    expect(valor('X-Content-Type-Options')).toBe('nosniff');
    expect(valor('X-Frame-Options')).toBe('DENY');
    expect(valor('Referrer-Policy')).toBe('strict-origin-when-cross-origin');
    expect(valor('Permissions-Policy')).toBe('camera=(), microphone=(), geolocation=()');
    expect(valor('Content-Security-Policy')).toBe(
      "frame-ancestors 'none'; base-uri 'self'; object-src 'none'; form-action 'self'",
    );
  });

  it('el CSP no restringe scripts (RSC y HMR usan inline/eval)', () => {
    const csp = valor('Content-Security-Policy') ?? '';
    expect(csp).not.toMatch(/script-src|default-src/u);
  });

  it('next.config las aplica a todas las rutas', async () => {
    const reglas = await (
      nextConfig as { headers: () => Promise<{ source: string; headers: unknown[] }[]> }
    ).headers();
    expect(reglas).toEqual([{ source: '/(.*)', headers: CABECERAS_DE_SEGURIDAD }]);
  });
});
