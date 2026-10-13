import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CABECERAS_DE_SEGURIDAD } from './security-headers.mjs';

/**
 * Carga el `.env` de la raíz del monorepo.
 *
 * Next.js busca el `.env` en el directorio de la aplicación, pero en este
 * repositorio la configuración es única y vive en la raíz: una sola fuente de
 * verdad para la web, el worker y los scripts de migración.
 *
 * No sobreescribe variables ya definidas, para que el entorno real (Docker, CI)
 * siempre gane sobre el archivo local.
 */
function cargarEnvRaiz() {
  const raiz = join(dirname(fileURLToPath(import.meta.url)), '../..');
  const archivo = join(raiz, '.env');
  if (!existsSync(archivo)) return;

  for (const linea of readFileSync(archivo, 'utf8').split('\n')) {
    const limpia = linea.trim();
    if (limpia === '' || limpia.startsWith('#')) continue;

    const separador = limpia.indexOf('=');
    if (separador === -1) continue;

    const clave = limpia.slice(0, separador).trim();
    const valor = limpia.slice(separador + 1).trim();
    if (process.env[clave] === undefined) process.env[clave] = valor;
  }
}

cargarEnvRaiz();

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Los paquetes del monorepo se consumen como fuente TypeScript.
  transpilePackages: ['@tcl-kol-os/domain', '@tcl-kol-os/db', '@tcl-kol-os/agent'],
  // No se exponen rutas internas ni trazas al cliente (§11.6).
  poweredByHeader: false,
  // Cabeceras de seguridad en todas las respuestas.
  async headers() {
    return [{ source: '/(.*)', headers: CABECERAS_DE_SEGURIDAD }];
  },
};

export default nextConfig;
