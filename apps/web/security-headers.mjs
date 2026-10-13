/**
 * Cabeceras de seguridad globales (§11.6). Módulo aparte para poder probarlas sin arrancar Next.
 *
 * El CSP es MÍNIMO a propósito: solo directivas que no afectan a los scripts. NO hay `script-src` ni
 * `default-src` porque el flight de RSC y el HMR de desarrollo usan inline/eval.
 */
export const CABECERAS_DE_SEGURIDAD = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
  {
    key: 'Content-Security-Policy',
    value: "frame-ancestors 'none'; base-uri 'self'; object-src 'none'; form-action 'self'",
  },
];
