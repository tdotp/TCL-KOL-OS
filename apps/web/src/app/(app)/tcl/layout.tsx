import type { ReactNode } from 'react';
import { usuarioDeTcl } from '@/lib/tcl-guard';

export const dynamic = 'force-dynamic';

/**
 * Guard ÚNICO de `/tcl/**` (V2 · Fase 9): sin sesión → `/login`; cualquier rol distinto de `cliente` → 404.
 * El shell y la autenticación base los pone `(app)/layout.tsx`; aquí solo se decide quién puede estar en `/tcl`.
 */
export default async function TclLayout({ children }: { children: ReactNode }) {
  await usuarioDeTcl();
  return <>{children}</>;
}
