/**
 * Carga de datos de las páginas de `/tcl/**` (V2 · Fase 9). Toda la lectura pasa por la proyección TCL
 * (`@tcl-kol-os/db`): cualquier fallo es el mismo `RESOURCE_NOT_FOUND` y aquí se vuelve 404 uniforme.
 */

import { cache } from 'react';
import { notFound } from 'next/navigation';
import type { Result, User } from '@tcl-kol-os/domain';
import { obtenerDetalleTclDeCampana } from '@tcl-kol-os/db';
import { usuarioDeTcl } from './tcl-guard.ts';
import { esUuidTcl } from './tcl-ui.ts';

/** Desenvuelve un `Result` de la proyección: cualquier fallo es 404 (no existe, no es visible o no es de TCL). */
export function valorOr404<T>(resultado: Result<T>): T {
  if (!resultado.ok) notFound();
  return resultado.value;
}

const detalleDeCampana = cache(async (id: string) => {
  const user = await usuarioDeTcl();
  return obtenerDetalleTclDeCampana(user, id);
});

/** Usuario TCL + detalle de la campaña de la URL (valida el UUID antes de tocar la base). */
export async function cargarCampanaTcl(id: string) {
  if (!esUuidTcl(id)) notFound();
  const user: User = await usuarioDeTcl();
  const campana = valorOr404(await detalleDeCampana(id));
  return { user, campana };
}
