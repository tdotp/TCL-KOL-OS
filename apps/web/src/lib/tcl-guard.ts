/**
 * Guardas del cliente TCL (V2 · Fase 9).
 *
 *  · `usuarioDeTcl`: guard ÚNICO de `/tcl/**` (lo usa `tcl/layout.tsx` y, como el resultado es el mismo por
 *    petición, cada página): sin sesión → `/login`; rol distinto de `cliente` → 404 (personal interno no usa `/tcl`).
 *  · `desviarClienteDeRutaLegada`: en las rutas legadas `/campanas/**`, `/brief`, `/fuentes`, el cliente se
 *    redirige a su equivalente de `/tcl` (o 404) ANTES de ejecutar cualquier cargador interno.
 */

import { cache } from 'react';
import { notFound, redirect } from 'next/navigation';
import type { User } from '@tcl-kol-os/domain';
import { currentUser } from './session.ts';
import { type RutaLegada, destinoTclDeRutaLegada } from './tcl-rutas.ts';

export const usuarioDeTcl = cache(async (): Promise<User> => {
  const user = await currentUser();
  if (user === undefined) redirect('/login');
  if (user.role !== 'cliente') notFound();
  return user;
});

/** Llamar justo después de comprobar la sesión y ANTES de cualquier cargador. No hace nada para personal interno. */
export function desviarClienteDeRutaLegada(user: User, ruta: RutaLegada): void {
  if (user.role !== 'cliente') return;
  const destino = destinoTclDeRutaLegada(ruta);
  if (destino === null) notFound();
  redirect(destino);
}
