/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // El paquete de dominio se consume como fuente TypeScript desde el monorepo.
  transpilePackages: ['@tcl-kol-os/domain'],
  // No se exponen rutas internas ni trazas al cliente (§11.6).
  poweredByHeader: false,
};

export default nextConfig;
