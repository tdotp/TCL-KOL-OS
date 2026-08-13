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
import {
  archiveCampaign,
  createCampaign,
  extraerBrief,
  findUserByEmail,
  retrySource,
  uploadSource,
} from '@tcl-kol-os/db';
import type { SourceType } from '@tcl-kol-os/db';
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

  // El reparto de presupuesto no se pide aquí: llega del brief del cliente
  // cuando exista (DEC-017). Pedirlo al crear la campaña obligaría a inventarlo.
  const productos = productIds.map((productId, indice) => ({
    productId,
    rol: (productIds.length === 1 ? 'unico' : indice === 0 ? 'flagship' : 'secundario') as
      'unico' | 'flagship' | 'secundario',
    prioridad: indice + 1,
  }));

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

// ─────────────────────────── Fuentes documentales (Épica E4) ──────────────────

/**
 * Carga de una fuente (UI-06).
 *
 * Devuelve de inmediato: la validación y el hash son rápidos, y el
 * procesamiento —que para un PPT de 25 MB tarda unos 6 segundos— ocurre en el
 * worker. La interfaz nunca se bloquea (criterio de la Épica E4).
 */
export async function cargarFuente(
  _previo: unknown,
  formData: FormData,
): Promise<{ error?: string | undefined; aviso?: string | undefined; ok?: boolean | undefined }> {
  const user = await currentUser();
  if (user === undefined) redirect('/login');

  const campaignId = String(formData.get('campaignId') ?? '');
  const archivo = formData.get('archivo');

  if (!(archivo instanceof File) || archivo.size === 0) {
    return { error: 'Seleccione un archivo.' };
  }

  const contenido = new Uint8Array(await archivo.arrayBuffer());

  const resultado = await uploadSource(user, {
    campaignId,
    filename: archivo.name,
    contenido,
    tipoDeclarado: archivo.type === '' ? undefined : archivo.type,
    type: (String(formData.get('tipo') ?? 'otro') || 'otro') as SourceType,
  });

  if (!resultado.ok) return { error: resultado.error.message };

  revalidatePath(`/campanas/${campaignId}/fuentes`);
  return { ok: true, aviso: resultado.value.aviso };
}

/** Reintento de un procesamiento fallido (UI-07, E4-9). */
export async function reintentarFuente(formData: FormData): Promise<void> {
  const user = await currentUser();
  if (user === undefined) redirect('/login');

  const sourceId = String(formData.get('sourceId') ?? '');
  const campaignId = String(formData.get('campaignId') ?? '');

  await retrySource(user, sourceId);
  revalidatePath(`/campanas/${campaignId}/fuentes`);
  redirect(`/campanas/${campaignId}/fuentes`);
}

/**
 * Lanza la extracción asistida de una campaña (UI-08).
 *
 * Es una acción cara —tarda ~12 s y cuesta dinero— así que no se dispara sola
 * al abrir la pantalla: la pide una persona cuando decide que ya cargó las
 * fuentes que quería.
 */
export async function extraerBriefDeCampana(
  _previo: unknown,
  formData: FormData,
): Promise<{ error?: string; ok?: string }> {
  const user = await currentUser();
  if (user === undefined) return { error: 'Sesión no válida.' };

  const campaignId = String(formData.get('campaignId') ?? '');
  if (campaignId === '') return { error: 'Falta la campaña.' };

  const resultado = await extraerBrief(user, campaignId);
  if (!resultado.ok) return { error: resultado.error.message };

  revalidatePath(`/campanas/${campaignId}/brief`);
  return {
    ok:
      `Se extrajeron ${resultado.value.campos} campos con ${resultado.value.evidencias} ` +
      `evidencias verificadas (USD ${resultado.value.costoUsd.toFixed(4)}).`,
  };
}
