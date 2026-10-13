/**
 * Cabeceras de seguridad (§11.6). Módulo aparte, puro y sin dependencias de Next, para probarlas sin arrancar nada.
 *
 * Dos mecanismos, cada uno en un solo lugar:
 *
 *   1. `CABECERAS_ESTATICAS` — no dependen de la petición; `next.config.mjs` las aplica a TODAS las rutas
 *      (también a los estáticos de `/_next`).
 *   2. `cabecerasDeDocumento()` — dependen de la petición (nonce por respuesta, ¿HTTPS?); las aplica
 *      `src/middleware.ts` a toda ruta que no sea un estático. NO se repite en `next.config.mjs`: una CSP duplicada
 *      se evaluaría las dos veces (la intersección de ambas) y una divergencia silenciosa rompería la página.
 *
 * CSP:
 *   · PRODUCCIÓN — lista blanca explícita. `script-src 'self' 'nonce-…'`: Next (App Router) lee el nonce de la CSP de
 *     la PETICIÓN y lo pone en sus scripts en línea (flight de RSC, arranque) y en sus fragmentos; por eso el
 *     middleware la fija también en la petición. Sin `unsafe-inline` ni `unsafe-eval` ni comodines. Las páginas deben
 *     renderizarse por petición (el layout raíz es `force-dynamic`): una página prerrenderizada no puede llevar nonce.
 *   · DESARROLLO — `next dev` necesita `eval`, scripts en línea sin nonce y WebSocket del HMR: solo se conservan las
 *     directivas que no tocan scripts (la CSP «mínima» de F10). No se debilita producción para que funcione `next dev`.
 *
 * HSTS: solo en producción, solo si la respuesta se sirve por HTTPS y nunca en bucle local. `HSTS_MAX_AGE` lo
 * configura (segundos; `0` lo apaga); `includeSubDomains` y `preload` son OPT-IN explícito porque comprometen a todo
 * el dominio / a las listas de los navegadores y la infraestructura real aún no garantiza esos contratos.
 */

/** Cabeceras que no dependen de la petición. */
export const CABECERAS_ESTATICAS = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
];

/** Directivas sin efecto sobre scripts: valen igual en desarrollo y en producción. */
const DIRECTIVAS_BASE = [
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "object-src 'none'",
  "form-action 'self'",
];

/** sha256 (base64) del `<style>` de la página 404 predeterminada de Next 15.5: ver `security-headers.test.ts`. */
export const HASH_ESTILO_404_DE_NEXT = 'sha256-Z5XTK23DFuEMs0PwnyZDO9SWxemQ5HxcpVaBNuUJyWY=';

/** Un nonce nuevo por respuesta: 16 bytes aleatorios en base64 (la CSP exige base64, no hex). */
export function generarNonce() {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  let binario = '';
  for (const b of bytes) binario += String.fromCharCode(b);
  return globalThis.btoa(binario);
}

/**
 * CSP de la respuesta.
 * @param {{ nonce: string, produccion: boolean, https: boolean }} o
 */
export function construirCsp({ nonce, produccion, https }) {
  if (!produccion) return DIRECTIVAS_BASE.join('; ');
  const directivas = [
    "default-src 'none'",
    // Solo código propio y el que lleve el nonce de ESTA respuesta.
    `script-src 'self' 'nonce-${nonce}'`,
    // Las hojas son archivos propios. Única excepción: el `<style>` en línea de la página 404 predeterminada de Next
    // (un hash, no `unsafe-inline`); su contenido lo fija el framework y `security-headers.test.ts` detecta si cambia
    // con una actualización. Los atributos `style=""` que renderiza el servidor no admiten nonce: `style-src-attr`.
    `style-src 'self' '${HASH_ESTILO_404_DE_NEXT}'`,
    "style-src-attr 'unsafe-inline'",
    // Sin imágenes externas: no hay <img> ni fondos remotos. `data:` solo para iconos incrustados en CSS.
    "img-src 'self' data:",
    // Inter se descarga en el build (next/font) y se sirve desde /_next/static/media.
    "font-src 'self'",
    // fetch del navegador: solo rutas /api propias (adjuntos, evidencia). El worker y Google se llaman desde el servidor.
    "connect-src 'self'",
    "frame-src 'none'",
    "worker-src 'none'",
    "manifest-src 'none'",
    "media-src 'none'",
    ...DIRECTIVAS_BASE,
  ];
  // Solo bajo HTTPS: sobre http://localhost (`next start` en local) subiría los subrecursos a un https que no existe.
  if (https) directivas.push('upgrade-insecure-requests');
  return directivas.join('; ');
}

const UN_ANO = 31_536_000;
/** Por defecto: 180 días, sin includeSubDomains ni preload. Se sube (o se apaga con 0) con `HSTS_MAX_AGE`. */
export const HSTS_MAX_AGE_POR_DEFECTO = 15_552_000;

/**
 * Lee la configuración de HSTS del entorno. Lanza si es inválida: una configuración de seguridad ambigua no se
 * interpreta en silencio (ni se endurece ni se relaja sola).
 *
 *   HSTS_MAX_AGE            segundos (entero ≥ 0). Vacío = 180 días. 0 = HSTS apagado.
 *   HSTS_INCLUDE_SUBDOMAINS "true" para incluir subdominios (solo si TODOS sirven HTTPS). Por defecto no.
 *   HSTS_PRELOAD            "true" para `preload` (exige includeSubDomains y max-age ≥ 1 año; no se activa solo).
 *
 * @param {Record<string, string | undefined>} env
 * @returns {{ habilitado: boolean, valor: string | null }}
 */
export function leerConfiguracionHsts(env) {
  const bruto = env['HSTS_MAX_AGE']?.trim();
  let maxAge = HSTS_MAX_AGE_POR_DEFECTO;
  if (bruto !== undefined && bruto !== '') {
    if (!/^\d+$/u.test(bruto))
      throw new Error(`HSTS_MAX_AGE inválido ("${bruto}"): debe ser un entero ≥ 0 en segundos.`);
    maxAge = Number(bruto);
  }
  const bandera = (nombre) => {
    const v = env[nombre]?.trim().toLowerCase();
    if (v === undefined || v === '' || v === 'false') return false;
    if (v === 'true') return true;
    throw new Error(`${nombre} inválido ("${v}"): use "true" o "false".`);
  };
  const subdominios = bandera('HSTS_INCLUDE_SUBDOMAINS');
  const preload = bandera('HSTS_PRELOAD');
  if (preload && (!subdominios || maxAge < UN_ANO)) {
    throw new Error('HSTS_PRELOAD exige HSTS_INCLUDE_SUBDOMAINS=true y HSTS_MAX_AGE ≥ 31536000.');
  }
  if (maxAge === 0) return { habilitado: false, valor: null };
  const partes = [`max-age=${maxAge}`];
  if (subdominios) partes.push('includeSubDomains');
  if (preload) partes.push('preload');
  return { habilitado: true, valor: partes.join('; ') };
}

/** `localhost`, `*.localhost`, 127.0.0.0/8 y ::1: ahí nunca se fija HSTS (quedaría clavado en el navegador del desarrollador). */
export function esBucleLocal(hostname) {
  const h = hostname.toLowerCase().replace(/^\[|\]$/gu, '');
  return h === 'localhost' || h.endsWith('.localhost') || h === '::1' || /^127(?:\.\d{1,3}){3}$/u.test(h);
}

/** Nombre de host de una cabecera `Host` («host», «host:3000», «[::1]:3000»). */
export function hostnameDeCabeceraHost(host) {
  const h = host.trim();
  if (h.startsWith('[')) return h.slice(0, h.indexOf(']') + 1);
  return h.split(':')[0] ?? '';
}

/**
 * ¿La respuesta se sirve por HTTPS? Tras un proxy que termina TLS la aplicación ve http: el proxy lo declara con
 * `X-Forwarded-Proto`. Si un cliente lo inventa por HTTP plano, el navegador IGNORA `Strict-Transport-Security`
 * recibido sobre un transporte no seguro (RFC 6797 §8.1): no hay efecto.
 *
 * @param {{ protocolo: string, forwardedProto: string | null }} o  protocolo con los dos puntos ("https:").
 */
export function sirveSobreHttps({ protocolo, forwardedProto }) {
  if (protocolo === 'https:') return true;
  const primero = forwardedProto?.split(',')[0]?.trim().toLowerCase();
  return primero === 'https';
}

/**
 * Cabeceras que dependen de la petición: CSP siempre; HSTS solo en producción, sobre HTTPS, fuera de bucle local y
 * si la configuración no lo apaga.
 *
 * `hostnames` reúne los nombres con que se llegó (la cabecera `Host`; el proxy debe conservarla): basta que uno sea
 * bucle local —o que no haya ninguno— para omitir HSTS (un `Host` inventado solo puede quitarlo).
 *
 * @param {{
 *   nonce: string, produccion: boolean, protocolo: string, forwardedProto: string | null, hostnames: string[],
 *   env: Record<string, string | undefined>
 * }} o
 * @returns {Array<{ key: string, value: string }>}
 */
export function cabecerasDeDocumento({ nonce, produccion, protocolo, forwardedProto, hostnames, env }) {
  const https = sirveSobreHttps({ protocolo, forwardedProto });
  const cabeceras = [{ key: 'Content-Security-Policy', value: construirCsp({ nonce, produccion, https }) }];
  // Sin un nombre de host utilizable (`Host` ausente) no se puede descartar un bucle local: fail-safe, sin HSTS.
  const hostConocido = hostnames.length > 0 && hostnames.every((h) => h !== '');
  if (produccion && https && hostConocido && !hostnames.some(esBucleLocal)) {
    const hsts = leerConfiguracionHsts(env);
    if (hsts.habilitado) cabeceras.push({ key: 'Strict-Transport-Security', value: hsts.valor });
  }
  return cabeceras;
}
