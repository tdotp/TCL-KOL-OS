import type { ReactNode } from 'react';
import { redirect } from 'next/navigation';
import { currentUser } from '@/lib/session';
import { AppShell } from '@/components/AppShell';

export const dynamic = 'force-dynamic';

/**
 * Zona autenticada: agrupa `/`, `/campanas` y sus subrutas bajo un shell
 * persistente sin cambiar ninguna URL (route group `(app)`). `/login` queda
 * fuera a propósito — nunca debe mostrar sidebar ni sesión.
 */
export default async function AppLayout({ children }: { children: ReactNode }) {
  const user = await currentUser();
  if (user === undefined) redirect('/login');

  return <AppShell user={user}>{children}</AppShell>;
}
