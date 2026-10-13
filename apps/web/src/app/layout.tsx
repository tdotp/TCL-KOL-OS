import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { Inter } from 'next/font/google';
import './globals.css';

/**
 * Rediseño v2 (spec "TCL KOL OS — UI Standalone"): un solo family, Inter,
 * para todo — títulos, etiquetas de sección y cuerpo. Reemplaza el par
 * Fraunces/Public Sans de la primera iteración.
 */
const inter = Inter({
  subsets: ['latin'],
  variable: '--font-body',
  display: 'swap',
});

/**
 * La CSP de producción exige un nonce por respuesta (`src/middleware.ts`): una página prerrenderizada en el build no
 * puede llevarlo y sus scripts se bloquearían. Todas las rutas ya son dinámicas (sesión, base de datos); esto lo hace
 * explícito también para `/_not-found`.
 */
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'TCL KOL OS',
  description: 'Plataforma interna de SmartPR para coordinar campañas KOL de TCL',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="es" className={inter.variable}>
      <body>{children}</body>
    </html>
  );
}
