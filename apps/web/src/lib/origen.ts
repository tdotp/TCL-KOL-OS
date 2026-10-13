/**
 * Comprobación de origen (CSRF) de los route handlers de escritura. Módulo PURO: solo lee cabeceras.
 *
 * ESTRICTA: `Sec-Fetch-Site` solo puede ser `same-origin`/`none`; si hay `Origin`, su host debe ser
 * EXACTAMENTE el de la cabecera `Host`. NO se confía en `x-forwarded-host`: es una cabecera que pone
 * cualquiera que llegue sin proxy (UI-09). Sin `Origin` ni `Sec-Fetch-Site` no es un navegador (curl,
 * pruebas) y el CSRF exige el navegador de la víctima.
 */
export function origenPermitidoEstricto(request: Request): boolean {
  const sitio = request.headers.get('sec-fetch-site');
  if (sitio !== null && sitio !== 'same-origin' && sitio !== 'none') return false;
  const origen = request.headers.get('origin');
  if (origen === null) return true;
  let host: string;
  try {
    host = new URL(origen).host;
  } catch {
    return false;
  }
  const propio = request.headers.get('host');
  return propio !== null && propio !== '' && propio === host;
}
