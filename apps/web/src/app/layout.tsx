import type { Metadata } from 'next';
import type { ReactNode } from 'react';

export const metadata: Metadata = {
  title: 'TCL KOL OS',
  description: 'Plataforma interna de SmartPR para coordinar campañas KOL de TCL',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="es">
      <body
        style={{
          margin: 0,
          fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
          background: '#f6f7f9',
          color: '#16191d',
        }}
      >
        {children}
      </body>
    </html>
  );
}
