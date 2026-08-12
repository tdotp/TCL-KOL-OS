'use server';

/**
 * Server actions.
 *
 * Cada una resuelve el usuario, delega la decisión de permisos a
 * `packages/domain` (vía `packages/db`) y traduce el resultado a la interfaz.
 * Aquí no se decide nada de negocio (ADR-008).
 */

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { cookies } from 'next/headers';
import { archiveCampaign, createCampaign, findUserByEmail } from '@tcl-kol-os/db';
import { SESSION_COOKIE, SESSION_MAX_AGE, authProvider, buildSessionValue, currentUser } from './session.ts';

export async function iniciarSesion(_previo: unknown, formData: FormData): Promise<{ error?: string }> {
  if (authProvider() !== 'dev') {
    return { error: 'El proveedor de identidad configurado no admite este formulario.' };
  }

  const email = String(formData.get('email') ?? '').trim();
  if (email === '') return { error: 'Indique un correo.' };

  const user = await findUserByEmail(email);
  // Mismo mensaje exista o no el usuario: distinguirlos permitiría enumerar
  // correos válidos de la organización.
  if (user === undefined || user.status !== 'activo') {
    return { error: 'No se pudo iniciar sesión con ese correo.' };
  }

  const store = await cookies();
  store.set(SESSION_COOKIE, buildSessionValue(user.id), {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env['NODE_ENV'] === 'production',
    path: '/',
    maxAge: SESSION_MAX_AGE,
  });

  redirect('/campanas');
}

export async function cerrarSesion(): Promise<void> {
  const store = await cookies();
  store.delete(SESSION_COOKIE);
  redirect('/login');
}

export async function crearCampana(_previo: unknown, formData: FormData): Promise<{ error?: string }> {
  const user = await currentUser();
  if (user === undefined) redirect('/login');

  const name = String(formData.get('name') ?? '').trim();
  if (name === '') return { error: 'La campaña necesita un nombre.' };

  const productIds = formData
    .getAll('productos')
    .map(String)
    .filter((v) => v !== '');
  if (productIds.length === 0) {
    return { error: 'Seleccione al menos un producto (DEC-016).' };
  }

  const productos = productIds.map((productId, indice) => {
    const participacion = formData.get(`participacion_${productId}`);
    const valor =
      participacion === null || String(participacion).trim() === '' ? undefined : Number(participacion) / 100;
    return {
      productId,
      rol: (productIds.length === 1 ? 'unico' : indice === 0 ? 'flagship' : 'secundario') as
        'unico' | 'flagship' | 'secundario',
      prioridad: indice + 1,
      participacionPresupuesto: valor,
    };
  });

  const fechaInicio = String(formData.get('startDate') ?? '').trim();
  const fechaFin = String(formData.get('endDate') ?? '').trim();

  const resultado = await createCampaign(user, {
    name,
    market: String(formData.get('market') ?? 'CO'),
    category: String(formData.get('category') ?? '').trim() || undefined,
    ownerId: user.id,
    startDate: fechaInicio === '' ? undefined : fechaInicio,
    endDate: fechaFin === '' ? undefined : fechaFin,
    productos,
  });

  if (!resultado.ok) return { error: resultado.error.message };

  revalidatePath('/campanas');
  redirect(`/campanas/${resultado.value.id}`);
}

export async function archivarCampana(formData: FormData): Promise<void> {
  const user = await currentUser();
  if (user === undefined) redirect('/login');

  const id = String(formData.get('id') ?? '');
  const resultado = await archiveCampaign(user, id);
  if (!resultado.ok) {
    // No se filtra el motivo exacto a la interfaz (§11.6).
    redirect(`/campanas/${id}?error=no_permitido`);
  }

  revalidatePath('/campanas');
  redirect('/campanas');
}
