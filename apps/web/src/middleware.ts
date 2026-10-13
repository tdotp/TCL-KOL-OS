import { NextResponse, type NextRequest } from 'next/server';
import { cabecerasDeDocumento, generarNonce, hostnameDeCabeceraHost } from '../security-headers.mjs';

/**
 * CSP y HSTS por respuesta (ver `security-headers.mjs`). Next lee el nonce de la CSP de la PETICIÓN: por eso la
 * política se fija en las cabeceras de la petición reenviada y también en la respuesta. El nonce nunca se reutiliza.
 */
export function middleware(request: NextRequest): NextResponse {
  const nonce = generarNonce();
  const cabeceras = cabecerasDeDocumento({
    nonce,
    produccion: process.env['NODE_ENV'] === 'production',
    protocolo: request.nextUrl.protocol,
    forwardedProto: request.headers.get('x-forwarded-proto'),
    // `nextUrl.hostname` NO sirve: `next start` lo construye con su propio host de escucha (localhost), no con el de la
    // petición. El nombre con que llegó el cliente es la cabecera `Host` (el proxy debe conservarla).
    hostnames: [hostnameDeCabeceraHost(request.headers.get('host') ?? '')],
    env: process.env,
  });

  const delanteras = new Headers(request.headers);
  for (const { key, value } of cabeceras) {
    if (key === 'Content-Security-Policy') delanteras.set(key, value);
  }

  const respuesta = NextResponse.next({ request: { headers: delanteras } });
  for (const { key, value } of cabeceras) respuesta.headers.set(key, value);
  return respuesta;
}

export const config = {
  // Todo menos los estáticos que sirve Next (no son documentos): reciben solo las cabeceras estáticas de next.config.
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
