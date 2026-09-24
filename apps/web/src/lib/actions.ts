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
  aprobarComoCliente,
  aprobarInternamente,
  confirmarCampo,
  corregirCampo,
  crearComentario,
  crearBriefManual,
  crearVersionHija,
  createCampaign,
  declararExcepcionProducto,
  descartarPregunta,
  extraerBrief,
  findUserByEmail,
  generarPreguntas,
  listarComentarios,
  reabrirComentario,
  reintentarExtraccion,
  resolverComentario,
  resolverConflicto,
  responderPregunta,
  retrySource,
  revertirExcepcionProducto,
  solicitarCambiosCliente,
  solicitarCambiosInternos,
  transicionarBrief,
  uploadSource,
  type ComentarioDeCampo,
} from '@tcl-kol-os/db';
import type { BriefStatus } from '@tcl-kol-os/domain';
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

/**
 * Reintento tras `processing_failed` (§3.4) — reusa la transición ya
 * definida en el dominio. Formulario simple de una sola acción (patrón de
 * `archivarCampana`): el error no se filtra en detalle a la URL (§11.6), se
 * redirige con un aviso genérico y el estado real sigue visible en la
 * pantalla del brief.
 */
export async function reintentarExtraccionDeBrief(formData: FormData): Promise<void> {
  const user = await currentUser();
  if (user === undefined) redirect('/login');

  const campaignId = String(formData.get('campaignId') ?? '');
  const versionId = String(formData.get('versionId') ?? '');

  const resultado = await reintentarExtraccion(user, campaignId, versionId);
  if (!resultado.ok) {
    redirect(`/campanas/${campaignId}/brief?error=${encodeURIComponent(resultado.error.message)}`);
  }

  revalidatePath(`/campanas/${campaignId}/brief`);
  redirect(`/campanas/${campaignId}/brief`);
}

// ─────────────────────────── Camino manual (§3.3, E7-4) ───────────────────────

/**
 * Crea (o reutiliza) la versión de trabajo sin pasar por el worker (DEC-024).
 * Es la acción real detrás de "empiece el brief a mano" — antes de este
 * cierre, ese texto no tenía ningún formulario detrás.
 */
export async function crearBriefManualDeCampana(formData: FormData): Promise<void> {
  const user = await currentUser();
  if (user === undefined) redirect('/login');

  const campaignId = String(formData.get('campaignId') ?? '');
  const resultado = await crearBriefManual(user, campaignId);
  if (!resultado.ok) {
    redirect(`/campanas/${campaignId}?error=${encodeURIComponent(resultado.error.message)}`);
  }

  revalidatePath(`/campanas/${campaignId}`);
  redirect(`/campanas/${campaignId}/brief/editar`);
}

// ─────────────────────────── Confirmar y corregir campos (§3.1) ───────────────

export async function confirmarCampoDeBrief(
  _previo: unknown,
  formData: FormData,
): Promise<{ error?: string; ok?: boolean }> {
  const user = await currentUser();
  if (user === undefined) return { error: 'Sesión no válida.' };

  const versionId = String(formData.get('versionId') ?? '');
  const fieldId = String(formData.get('fieldId') ?? '');
  const revisionEsperada = Number(formData.get('revision') ?? Number.NaN);
  if (versionId === '' || fieldId === '' || Number.isNaN(revisionEsperada)) {
    return { error: 'Faltan datos del campo a confirmar.' };
  }

  const resultado = await confirmarCampo(user, versionId, fieldId, { revisionEsperada });
  if (!resultado.ok) return { error: resultado.error.message };

  revalidatePath(`/campanas/[id]/brief`);
  return { ok: true };
}

export async function corregirCampoDeBrief(
  _previo: unknown,
  formData: FormData,
): Promise<{ error?: string; ok?: boolean }> {
  const user = await currentUser();
  if (user === undefined) return { error: 'Sesión no válida.' };

  const versionId = String(formData.get('versionId') ?? '');
  const fieldId = String(formData.get('fieldId') ?? '');
  const revisionEsperada = Number(formData.get('revision') ?? Number.NaN);
  const valorCrudo = String(formData.get('value') ?? '');
  const motivo = String(formData.get('motivo') ?? '').trim() || undefined;

  if (versionId === '' || fieldId === '' || Number.isNaN(revisionEsperada)) {
    return { error: 'Faltan datos del campo a corregir.' };
  }

  let value: unknown;
  try {
    // El editor envía el valor ya serializado en JSON (así un campo de
    // lista o de fecha con precisión llega con su forma real, no como texto
    // libre — corrección 3 del cierre).
    value = JSON.parse(valorCrudo);
  } catch {
    value = valorCrudo;
  }

  const resultado = await corregirCampo(user, versionId, fieldId, { value, motivo, revisionEsperada });
  if (!resultado.ok) return { error: resultado.error.message };

  revalidatePath(`/campanas/[id]/brief`);
  return { ok: true };
}

export async function resolverConflictoDeBrief(
  _previo: unknown,
  formData: FormData,
): Promise<{ error?: string; ok?: boolean }> {
  const user = await currentUser();
  if (user === undefined) return { error: 'Sesión no válida.' };

  const versionId = String(formData.get('versionId') ?? '');
  const fieldId = String(formData.get('fieldId') ?? '');
  const revisionEsperada = Number(formData.get('revision') ?? Number.NaN);
  const valorCrudo = String(formData.get('value') ?? '');
  const keepEvidenceIds = formData.getAll('keepEvidenceIds').map(String);

  if (versionId === '' || fieldId === '' || Number.isNaN(revisionEsperada)) {
    return { error: 'Faltan datos del conflicto a resolver.' };
  }

  let value: unknown;
  try {
    value = JSON.parse(valorCrudo);
  } catch {
    value = valorCrudo;
  }

  const resultado = await resolverConflicto(user, versionId, fieldId, {
    value,
    keepEvidenceIds,
    revisionEsperada,
  });
  if (!resultado.ok) return { error: resultado.error.message };

  revalidatePath(`/campanas/[id]/brief`);
  return { ok: true };
}

// ────────── E7-8 · Excepción por producto en un campo compartido ──────────────

export async function declararExcepcionDeCampo(
  _previo: unknown,
  formData: FormData,
): Promise<{ error?: string; ok?: boolean }> {
  const user = await currentUser();
  if (user === undefined) return { error: 'Sesión no válida.' };

  const versionId = String(formData.get('versionId') ?? '');
  const key = String(formData.get('key') ?? '');
  const campaignProductId = String(formData.get('campaignProductId') ?? '');
  const valorCrudo = String(formData.get('value') ?? '');
  const motivo = String(formData.get('motivo') ?? '').trim();
  const revisionCrudo = formData.get('revision');
  const revisionEsperada = revisionCrudo === null || revisionCrudo === '' ? undefined : Number(revisionCrudo);

  if (versionId === '' || key === '' || campaignProductId === '') {
    return { error: 'Faltan datos para declarar la excepción.' };
  }
  if (motivo === '') {
    return { error: 'Declarar una excepción por producto exige un motivo (E7-8).' };
  }

  let value: unknown;
  try {
    value = JSON.parse(valorCrudo);
  } catch {
    value = valorCrudo;
  }

  const resultado = await declararExcepcionProducto(user, versionId, {
    key,
    campaignProductId,
    value,
    motivo,
    revisionEsperada,
  });
  if (!resultado.ok) return { error: resultado.error.message };

  revalidatePath(`/campanas/[id]/brief/editar`);
  return { ok: true };
}

export async function revertirExcepcionDeCampo(
  _previo: unknown,
  formData: FormData,
): Promise<{ error?: string; ok?: boolean }> {
  const user = await currentUser();
  if (user === undefined) return { error: 'Sesión no válida.' };

  const versionId = String(formData.get('versionId') ?? '');
  const fieldId = String(formData.get('fieldId') ?? '');
  if (versionId === '' || fieldId === '') return { error: 'Falta la excepción a revertir.' };

  const resultado = await revertirExcepcionProducto(user, versionId, fieldId);
  if (!resultado.ok) return { error: resultado.error.message };

  revalidatePath(`/campanas/[id]/brief/editar`);
  return { ok: true };
}

// ─────────────────────────── Épica E6 — Preguntas locales ─────────────────────

export async function generarPreguntasDeBrief(formData: FormData): Promise<void> {
  const user = await currentUser();
  if (user === undefined) redirect('/login');

  const versionId = String(formData.get('versionId') ?? '');
  const campaignId = String(formData.get('campaignId') ?? '');

  const resultado = await generarPreguntas(user, versionId);
  if (!resultado.ok) {
    redirect(
      `/campanas/${campaignId}/brief/editar?panel=preguntas&error=${encodeURIComponent(resultado.error.message)}`,
    );
  }

  revalidatePath(`/campanas/${campaignId}/brief/editar`);
  redirect(`/campanas/${campaignId}/brief/editar?panel=preguntas`);
}

export async function responderPreguntaLocal(
  _previo: unknown,
  formData: FormData,
): Promise<{ error?: string; ok?: boolean }> {
  const user = await currentUser();
  if (user === undefined) return { error: 'Sesión no válida.' };

  const questionId = String(formData.get('questionId') ?? '');
  const campaignId = String(formData.get('campaignId') ?? '');
  const answerCrudo = String(formData.get('answerValue') ?? '');
  const answer = String(formData.get('answer') ?? '').trim() || undefined;
  if (questionId === '') return { error: 'Falta la pregunta a responder.' };

  let answerValue: unknown;
  try {
    // El formulario de UI-09 arma el JSON según el `valueType` del catálogo
    // (texto/lista/enum/fecha con precisión/número) — nunca un único
    // `<textarea>` genérico para todo (§5.3 del pedido).
    answerValue = JSON.parse(answerCrudo);
  } catch {
    answerValue = answerCrudo;
  }

  const resultado = await responderPregunta(user, questionId, { answerValue, answer });
  if (!resultado.ok) return { error: resultado.error.message };

  if (campaignId !== '') {
    revalidatePath(`/campanas/${campaignId}/brief/editar`);
    // Sprint 6, Fase C: el workspace guiado (`BRIEF_WORKSPACE_V2`) lee la
    // misma pregunta a través de `obtenerBriefWorkspace` — sin esto, la
    // tarea recién respondida seguiría apareciendo en la cola hasta el
    // próximo refresh manual.
    revalidatePath(`/campanas/${campaignId}/brief/workspace`);
  }
  return { ok: true };
}

export async function descartarPreguntaLocal(
  _previo: unknown,
  formData: FormData,
): Promise<{ error?: string; ok?: boolean }> {
  const user = await currentUser();
  if (user === undefined) return { error: 'Sesión no válida.' };

  const questionId = String(formData.get('questionId') ?? '');
  const campaignId = String(formData.get('campaignId') ?? '');
  const justificacion = String(formData.get('justificacion') ?? '').trim();
  if (questionId === '') return { error: 'Falta la pregunta a descartar.' };
  if (justificacion === '') return { error: 'Descartar una pregunta exige indicar por qué (E6-4).' };

  const resultado = await descartarPregunta(user, questionId, justificacion);
  if (!resultado.ok) return { error: resultado.error.message };

  if (campaignId !== '') {
    revalidatePath(`/campanas/${campaignId}/brief/editar`);
    revalidatePath(`/campanas/${campaignId}/brief/workspace`);
  }
  return { ok: true };
}

// ─────────────────────────── Transiciones de estado (§3.4) ────────────────────

/**
 * Ejecuta una transición de estado del brief. Nunca reimplementa una guarda:
 * si `transicionarBrief` la rechaza, el mensaje del dominio se muestra tal
 * cual (ADR-008, sección 7 del pedido — el error debe decir exactamente qué
 * falta, no "brief inválido"). Formulario simple de una sola acción: el
 * mensaje y, si la guarda los trae, los campos exactos que faltan viajan en
 * la URL de redirección — nada sensible, solo claves del catálogo (§11.6).
 */
export async function transicionarBriefDeCampana(formData: FormData): Promise<void> {
  const user = await currentUser();
  if (user === undefined) redirect('/login');

  const versionId = String(formData.get('versionId') ?? '');
  const campaignId = String(formData.get('campaignId') ?? '');
  const to = String(formData.get('to') ?? '') as BriefStatus;

  const resultado = await transicionarBrief(user, versionId, to);
  if (!resultado.ok) {
    const campos = resultado.error.details?.['campos'];
    const detalle = Array.isArray(campos) ? `&detalle=${encodeURIComponent(campos.join(', '))}` : '';
    redirect(`/campanas/${campaignId}/brief?error=${encodeURIComponent(resultado.error.message)}${detalle}`);
  }

  revalidatePath(`/campanas/${campaignId}/brief`);
  redirect(`/campanas/${campaignId}/brief`);
}

/** Fase C · el revisor devuelve el brief con cambios solicitados. Motivo obligatorio. */
export async function solicitarCambiosInternosDeCampana(
  _previo: unknown,
  formData: FormData,
): Promise<{ error?: string; ok?: boolean }> {
  const user = await currentUser();
  if (user === undefined) return { error: 'Sesión no válida.' };

  const versionId = String(formData.get('versionId') ?? '');
  const campaignId = String(formData.get('campaignId') ?? '');
  const motivo = String(formData.get('motivo') ?? '').trim();
  if (versionId === '') return { error: 'Falta la versión.' };
  if (motivo === '') return { error: 'Solicitar cambios internos exige un motivo.' };

  const resultado = await solicitarCambiosInternos(user, versionId, motivo);
  if (!resultado.ok) return { error: resultado.error.message };

  if (campaignId !== '') revalidatePath(`/campanas/${campaignId}/brief`);
  return { ok: true };
}

/** Fase C · aprobación interna: envía el brief a revisión del cliente. */
export async function aprobarInternamenteDeCampana(formData: FormData): Promise<void> {
  const user = await currentUser();
  if (user === undefined) redirect('/login');

  const versionId = String(formData.get('versionId') ?? '');
  const campaignId = String(formData.get('campaignId') ?? '');

  const resultado = await aprobarInternamente(user, versionId);
  if (!resultado.ok) {
    redirect(`/campanas/${campaignId}/brief?error=${encodeURIComponent(resultado.error.message)}`);
  }

  revalidatePath(`/campanas/${campaignId}/brief`);
  redirect(`/campanas/${campaignId}/brief`);
}

// ─────────────────────────── Fase D · Revisión del cliente ────────────────────

/** El cliente solicita cambios. Motivo general obligatorio; campos señalados opcionales. */
export async function solicitarCambiosClienteDeCampana(
  _previo: unknown,
  formData: FormData,
): Promise<{ error?: string; ok?: boolean }> {
  const user = await currentUser();
  if (user === undefined) return { error: 'Sesión no válida.' };

  const versionId = String(formData.get('versionId') ?? '');
  const campaignId = String(formData.get('campaignId') ?? '');
  const motivo = String(formData.get('motivo') ?? '').trim();
  const camposSenalados = formData
    .getAll('campo')
    .map(String)
    .filter((c) => c !== '');
  if (versionId === '') return { error: 'Falta la versión.' };
  if (motivo === '') return { error: 'Solicitar cambios exige un motivo.' };

  const resultado = await solicitarCambiosCliente(user, versionId, { motivo, camposSenalados });
  if (!resultado.ok) return { error: resultado.error.message };

  if (campaignId !== '') revalidatePath(`/campanas/${campaignId}/brief`);
  return { ok: true };
}

/** El cliente aprueba el brief. */
export async function aprobarComoClienteDeCampana(formData: FormData): Promise<void> {
  const user = await currentUser();
  if (user === undefined) redirect('/login');

  const versionId = String(formData.get('versionId') ?? '');
  const campaignId = String(formData.get('campaignId') ?? '');

  const resultado = await aprobarComoCliente(user, versionId);
  if (!resultado.ok) {
    redirect(`/campanas/${campaignId}/brief?error=${encodeURIComponent(resultado.error.message)}`);
  }

  revalidatePath(`/campanas/${campaignId}/brief`);
  redirect(`/campanas/${campaignId}/brief`);
}

// ─────────────────────────── Fase E · Versionado posterior a aprobación ───────

/** Crea una versión hija a partir de una versión `approved` (DEC-027). */
export async function crearVersionHijaDeCampana(formData: FormData): Promise<void> {
  const user = await currentUser();
  if (user === undefined) redirect('/login');

  const versionId = String(formData.get('versionId') ?? '');
  const campaignId = String(formData.get('campaignId') ?? '');

  const resultado = await crearVersionHija(user, versionId);
  if (!resultado.ok) {
    redirect(`/campanas/${campaignId}/brief?error=${encodeURIComponent(resultado.error.message)}`);
  }

  revalidatePath(`/campanas/${campaignId}/brief`);
  revalidatePath(`/campanas/${campaignId}/brief/editar`);
  redirect(`/campanas/${campaignId}/brief/editar`);
}

// ─────────────────────────── Fase B · Comentarios internos (E7-6) ─────────────

/**
 * Se llama directo desde un componente cliente (no es un `<form action>`) —
 * Next.js admite invocar una server action como función normal. Sigue
 * resolviendo el usuario y delegando el permiso (`comment:internal`) a
 * `listarComentarios`, igual que cualquier otra acción de este archivo.
 */
export async function obtenerComentariosDeCampo(
  versionId: string,
  fieldKey: string,
): Promise<{ error?: string; comentarios?: readonly ComentarioDeCampo[] }> {
  const user = await currentUser();
  if (user === undefined) return { error: 'Sesión no válida.' };

  const resultado = await listarComentarios(user, versionId, fieldKey);
  if (!resultado.ok) return { error: resultado.error.message };

  return { comentarios: resultado.value };
}

export async function crearComentarioDeCampo(
  _previo: unknown,
  formData: FormData,
): Promise<{ error?: string; ok?: boolean }> {
  const user = await currentUser();
  if (user === undefined) return { error: 'Sesión no válida.' };

  const versionId = String(formData.get('versionId') ?? '');
  const fieldKey = String(formData.get('fieldKey') ?? '');
  const campaignProductId = String(formData.get('campaignProductId') ?? '') || undefined;
  const parentCommentId = String(formData.get('parentCommentId') ?? '') || undefined;
  const content = String(formData.get('content') ?? '');
  if (versionId === '' || fieldKey === '') return { error: 'Falta el campo del comentario.' };

  const resultado = await crearComentario(user, versionId, {
    fieldKey,
    campaignProductId,
    parentCommentId,
    content,
  });
  if (!resultado.ok) return { error: resultado.error.message };

  revalidatePath(`/campanas/[id]/brief/editar`);
  return { ok: true };
}

export async function resolverComentarioDeCampo(
  _previo: unknown,
  formData: FormData,
): Promise<{ error?: string; ok?: boolean }> {
  const user = await currentUser();
  if (user === undefined) return { error: 'Sesión no válida.' };

  const versionId = String(formData.get('versionId') ?? '');
  const commentId = String(formData.get('commentId') ?? '');
  if (versionId === '' || commentId === '') return { error: 'Falta el comentario a resolver.' };

  const resultado = await resolverComentario(user, versionId, commentId);
  if (!resultado.ok) return { error: resultado.error.message };

  revalidatePath(`/campanas/[id]/brief/editar`);
  return { ok: true };
}

export async function reabrirComentarioDeCampo(
  _previo: unknown,
  formData: FormData,
): Promise<{ error?: string; ok?: boolean }> {
  const user = await currentUser();
  if (user === undefined) return { error: 'Sesión no válida.' };

  const versionId = String(formData.get('versionId') ?? '');
  const commentId = String(formData.get('commentId') ?? '');
  if (versionId === '' || commentId === '') return { error: 'Falta el comentario a reabrir.' };

  const resultado = await reabrirComentario(user, versionId, commentId);
  if (!resultado.ok) return { error: resultado.error.message };

  revalidatePath(`/campanas/[id]/brief/editar`);
  return { ok: true };
}
