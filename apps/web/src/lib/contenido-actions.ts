'use server';

/**
 * Server actions del contenido (entregables y guiones) de Cuenta (V2 · Fase 7).
 *
 * Adaptadores finos, con el mismo patrón que `chat-actions.ts`: cada una resuelve la PERSONA
 * (`currentUser`, releída de la base en cada llamada), comprueba que la campaña es de su organización y
 * que su rol puede hacer eso, y delega en el caso de uso existente. Aquí no se decide ninguna regla de
 * negocio (estados, vigencia, elegibilidad, huella): las decide el dominio.
 *
 * Reglas de esta capa:
 *  · El cliente NUNCA elige organización, origen, canal, estado ni autor. El canal es `ui` FIJO en
 *    servidor; el autor es la persona de la sesión. Lo único que manda es la campaña (verificada), los
 *    ids de lo que ve y el texto que escribe.
 *  · Aprobar exige la huella (`huellaVista`) de la evaluación que la persona VIO y solo la ejecuta quien
 *    tiene `script:approve` (admin y director); el consultor prepara y propone. La revisión humana y la
 *    aprobación NO existen por otro canal: ni el chat ni el sistema.
 *  · La SUBIDA del archivo de un guion no vive aquí: las server actions de Next 15 limitan el cuerpo a
 *    1 MB. La hace el route handler `POST /api/campanas/[id]/contenido/guiones`.
 *  · Los errores se traducen a mensajes en español; nunca se devuelven trazas.
 *  · Todo texto (comentarios, etiquetas) es dato de una persona: aquí no se interpreta ni se ejecuta.
 */

import { revalidatePath } from 'next/cache';
import {
  aprobarScriptVersion,
  crearComentarioDeRevision,
  crearEntregable,
  getCampaign,
  obtenerCampaignInfluencer,
  registrarRevisionHumana,
  solicitarAnalisisDeGuion,
  solicitarCambiosDeScript,
} from '@tcl-kol-os/db';
import { type SocialPlatform, type User, isSocialPlatform, roleCan } from '@tcl-kol-os/domain';
import { MENSAJE_GENERICO, mensajeDeContenido } from './contenido-mensajes.ts';
import { currentUser } from './session.ts';

export type ResultadoDeContenido<T extends object = object> =
  | ({ readonly ok: true } & T)
  | {
      readonly ok: false;
      readonly error: string;
      /** Código estable para la interfaz (p. ej. `SESSION`, `PROPOSAL_STALE`); sin detalles internos. */
      readonly codigo: string;
    };

const fallo = (error: string, codigo: string): { ok: false; error: string; codigo: string } => ({
  ok: false,
  error,
  codigo,
});

const NO_ENCONTRADO = 'No encontramos ese elemento. Recarga la página e inténtalo de nuevo.';

function registrarFallo(accion: string, error: unknown): void {
  // Solo el nombre del error: ni mensaje, ni traza, ni datos de la petición.
  console.error(`[contenido-actions] ${accion}`, error instanceof Error ? error.name : typeof error);
}

type Capacidad = 'deliverable:manage' | 'script:manage' | 'script:approve';

/**
 * Persona con acceso al contenido de ESA campaña y con la capacidad pedida, o el fallo ya traducido.
 * Cliente, analista, legal y otra organización reciben «no encontrado» (sin revelar que existe); el
 * personal de la agencia sin la capacidad (p. ej. el consultor al aprobar) recibe «tu rol no puede».
 */
async function personaConAcceso(
  campaignId: unknown,
  capacidad: Capacidad,
): Promise<{ readonly user: User; readonly campaignId: string } | ReturnType<typeof fallo>> {
  const user = await currentUser();
  if (user === undefined) return fallo('Tu sesión expiró. Inicia sesión de nuevo.', 'SESSION');
  if (typeof campaignId !== 'string' || !roleCan(user.role, 'deliverable:read')) {
    return fallo(NO_ENCONTRADO, 'RESOURCE_NOT_FOUND');
  }
  const campana = await getCampaign(user, campaignId);
  if (!campana.ok) return fallo(NO_ENCONTRADO, 'RESOURCE_NOT_FOUND');
  if (!roleCan(user.role, capacidad)) {
    return fallo(mensajeDeContenido({ code: 'FORBIDDEN_ROLE', message: '' }), 'FORBIDDEN_ROLE');
  }
  return { user, campaignId: campana.value.campaign.id };
}

const esFallo = (x: unknown): x is ReturnType<typeof fallo> =>
  typeof x === 'object' && x !== null && (x as { ok?: unknown }).ok === false;

/** Las páginas de contenido (todas) y el chat (la pestaña de pendientes muestra las propuestas). */
function revalidarContenido(campaignId: string): void {
  revalidatePath(`/campanas/${campaignId}/contenido`, 'layout');
  revalidatePath(`/campanas/${campaignId}/chat`);
}

/** Canal `ui` FIJO: no es un parámetro de ninguna acción. */
const CONTEXTO_UI = { origin: 'ui' } as const;

// ─────────────────────────── Entregables ───────────────────────────────────────

/**
 * Crea un entregable de una participación (CampaignInfluencer). La participación debe ser de ESTA
 * campaña. Idempotente por (participación, etiqueta normalizada): repetirla da `label_already_exists`.
 */
export async function crearDeliverableDeContenido(
  campaignId: string,
  participacionId: string,
  etiqueta: string,
  plataforma?: string,
  campaignProductId?: string,
): Promise<ResultadoDeContenido<{ readonly deliverableId: string; readonly participacionId: string }>> {
  try {
    const acceso = await personaConAcceso(campaignId, 'deliverable:manage');
    if (esFallo(acceso)) return acceso;
    const { user } = acceso;
    if (typeof participacionId !== 'string' || typeof etiqueta !== 'string') {
      return fallo('Escribe la etiqueta del entregable.', 'VALIDATION_FAILED');
    }
    const plataformaValida: SocialPlatform | undefined =
      plataforma === undefined || plataforma === ''
        ? undefined
        : isSocialPlatform(plataforma)
          ? plataforma
          : undefined;
    if (plataforma !== undefined && plataforma !== '' && plataformaValida === undefined) {
      return fallo('La plataforma no es válida.', 'VALIDATION_FAILED');
    }
    // La participación debe ser de ESTA campaña (el caso de uso la valida contra su propia campaña).
    const participacion = await obtenerCampaignInfluencer(user, participacionId);
    if (!participacion.ok || participacion.value.campaignInfluencer.campaignId !== acceso.campaignId) {
      return fallo(NO_ENCONTRADO, 'RESOURCE_NOT_FOUND');
    }
    const r = await crearEntregable(
      user,
      {
        campaignInfluencerId: participacionId,
        label: etiqueta,
        platform: plataformaValida,
        campaignProductId:
          campaignProductId === undefined || campaignProductId === '' ? undefined : campaignProductId,
      },
      CONTEXTO_UI,
    );
    if (!r.ok) return fallo(mensajeDeContenido(r.error), r.error.code);
    revalidarContenido(acceso.campaignId);
    return { ok: true, deliverableId: r.value.id, participacionId };
  } catch (error) {
    registrarFallo('crearDeliverableDeContenido', error);
    return fallo(MENSAJE_GENERICO, 'INTERNAL');
  }
}

// ─────────────────────────── Análisis y revisión ───────────────────────────────

/**
 * Solicita el análisis asistido de una versión contra el Brief aprobado vigente. `modo: 'ensure'` (por
 * defecto) reutiliza un análisis CURRENT con los mismos insumos; `'reanalyze'` es explícito y crea uno
 * nuevo. `claveDeIdempotencia` la genera el SERVIDOR al renderizar la página (un token por render): un
 * doble clic reutiliza el mismo análisis. La IA analiza y señala; nunca decide ni aprueba.
 */
export async function solicitarAnalisisDeContenido(
  campaignId: string,
  versionId: string,
  modo: 'ensure' | 'reanalyze',
  claveDeIdempotencia: string,
): Promise<
  ResultadoDeContenido<{
    readonly resultado: 'creado' | 'reutilizado' | 'repetido';
    readonly advertencias: readonly string[];
  }>
> {
  try {
    const acceso = await personaConAcceso(campaignId, 'script:manage');
    if (esFallo(acceso)) return acceso;
    if (typeof versionId !== 'string' || typeof claveDeIdempotencia !== 'string') {
      return fallo(NO_ENCONTRADO, 'RESOURCE_NOT_FOUND');
    }
    const r = await solicitarAnalisisDeGuion(
      acceso.user,
      versionId,
      {
        mode: modo === 'reanalyze' ? 'reanalyze' : 'ensure',
        idempotencyKey: claveDeIdempotencia,
        alcance: { campaignId: acceso.campaignId },
      },
      CONTEXTO_UI,
    );
    // Un análisis fallido deja su run `failed` (visible en la página): se revalida también el error.
    revalidarContenido(acceso.campaignId);
    if (!r.ok) return fallo(mensajeDeContenido(r.error), r.error.code);
    return {
      ok: true,
      resultado:
        r.value.outcome === 'created'
          ? 'creado'
          : r.value.outcome === 'reused_current'
            ? 'reutilizado'
            : 'repetido',
      advertencias: r.value.warnings,
    };
  } catch (error) {
    registrarFallo('solicitarAnalisisDeContenido', error);
    return fallo(MENSAJE_GENERICO, 'INTERNAL');
  }
}

/**
 * Registra la revisión HUMANA del guion contra el Brief aprobado vigente. Solo canal `ui` (el caso de uso
 * rechaza cualquier otro). `huellaVista` es la huella del Brief que la persona vio: si el Brief cambió
 * mientras tanto, se rechaza. Pasa la versión recibida a «en revisión». Idempotente por persona y Brief.
 */
export async function registrarRevisionHumanaDeContenido(
  campaignId: string,
  versionId: string,
  huellaVista: string,
  nota?: string,
): Promise<ResultadoDeContenido<{ readonly reutilizada: boolean }>> {
  try {
    const acceso = await personaConAcceso(campaignId, 'script:manage');
    if (esFallo(acceso)) return acceso;
    if (typeof versionId !== 'string' || typeof huellaVista !== 'string' || huellaVista === '') {
      return fallo(NO_ENCONTRADO, 'RESOURCE_NOT_FOUND');
    }
    const r = await registrarRevisionHumana(
      acceso.user,
      versionId,
      {
        huellaVista,
        ...(typeof nota === 'string' && nota.trim() !== '' ? { nota } : {}),
        alcance: { campaignId: acceso.campaignId },
      },
      CONTEXTO_UI,
    );
    if (!r.ok) return fallo(mensajeDeContenido(r.error), r.error.code);
    revalidarContenido(acceso.campaignId);
    return { ok: true, reutilizada: r.value.reused };
  } catch (error) {
    registrarFallo('registrarRevisionHumanaDeContenido', error);
    return fallo(MENSAJE_GENERICO, 'INTERNAL');
  }
}

// ─────────────────────────── Comentarios y cambios solicitados ─────────────────

/** Añade un comentario editorial de SmartPR a una versión abierta. Autor = la persona; origen `ui`. */
export async function anadirComentarioDeContenido(
  campaignId: string,
  versionId: string,
  texto: string,
): Promise<ResultadoDeContenido<{ readonly duplicado: boolean }>> {
  try {
    const acceso = await personaConAcceso(campaignId, 'script:manage');
    if (esFallo(acceso)) return acceso;
    if (typeof versionId !== 'string' || typeof texto !== 'string') {
      return fallo('Escribe el comentario.', 'VALIDATION_FAILED');
    }
    const r = await crearComentarioDeRevision(
      acceso.user,
      versionId,
      { kind: 'editorial', body: texto },
      CONTEXTO_UI,
      { campaignId: acceso.campaignId },
    );
    if (!r.ok) return fallo(mensajeDeContenido(r.error), r.error.code);
    revalidarContenido(acceso.campaignId);
    return { ok: true, duplicado: r.value.deduplicated };
  } catch (error) {
    registrarFallo('anadirComentarioDeContenido', error);
    return fallo(MENSAJE_GENERICO, 'INTERNAL');
  }
}

/**
 * Solicita cambios sobre una versión abierta: cada línea no vacía de `cambios` es un cambio pedido (de 1
 * a 20) y `nota` es un comentario editorial opcional. La versión queda en «cambios solicitados», estado
 * TERMINAL: reabrir es subir la versión siguiente. No es una aprobación.
 */
export async function solicitarCambiosDeContenido(
  campaignId: string,
  versionId: string,
  cambios: string,
  nota?: string,
): Promise<ResultadoDeContenido<{ readonly cantidad: number }>> {
  try {
    const acceso = await personaConAcceso(campaignId, 'script:manage');
    if (esFallo(acceso)) return acceso;
    if (typeof versionId !== 'string' || typeof cambios !== 'string') {
      return fallo('Escribe al menos un cambio.', 'VALIDATION_FAILED');
    }
    const items = cambios
      .split(/\r?\n/u)
      .map((linea) => linea.trim())
      .filter((linea) => linea !== '')
      .map((body) => ({ body }));
    if (items.length === 0) return fallo('Escribe al menos un cambio.', 'VALIDATION_FAILED');
    const r = await solicitarCambiosDeScript(
      acceso.user,
      versionId,
      {
        items,
        ...(typeof nota === 'string' && nota.trim() !== '' ? { nota } : {}),
      },
      CONTEXTO_UI,
      { campaignId: acceso.campaignId },
    );
    if (!r.ok) return fallo(mensajeDeContenido(r.error), r.error.code);
    revalidarContenido(acceso.campaignId);
    return { ok: true, cantidad: r.value.changeRequests.length };
  } catch (error) {
    registrarFallo('solicitarCambiosDeContenido', error);
    return fallo(MENSAJE_GENERICO, 'INTERNAL');
  }
}

// ─────────────────────────── Aprobación ────────────────────────────────────────

/**
 * Aprueba una versión de guion. Decisión HUMANA y crítica: solo `script:approve` (admin y director), con
 * canal `ui` fijado aquí y la huella (`huellaVista`) de la evaluación que la persona VIO en el diálogo.
 * Si algo relevante cambió entre lo mostrado y la escritura, el caso de uso responde `PROPOSAL_STALE`.
 * Es el MISMO caso de uso que ejecuta el handler HITL de las propuestas del chat.
 */
export async function aprobarVersionDeGuion(
  campaignId: string,
  versionId: string,
  huellaVista: string,
): Promise<ResultadoDeContenido<{ readonly version: number; readonly reemplazaA: number | null }>> {
  try {
    const acceso = await personaConAcceso(campaignId, 'script:approve');
    if (esFallo(acceso)) return acceso;
    if (typeof versionId !== 'string') return fallo(NO_ENCONTRADO, 'RESOURCE_NOT_FOUND');
    if (typeof huellaVista !== 'string' || huellaVista === '') {
      return fallo(
        'Falta la huella de lo que viste. Recarga la página y vuelve a abrir el diálogo de aprobación.',
        'VALIDATION_FAILED',
      );
    }
    const r = await aprobarScriptVersion(acceso.user, versionId, {
      huellaVista,
      origen: 'ui',
      alcance: { campaignId: acceso.campaignId },
    });
    // También si falla: una huella obsoleta o un estado cambiado deben verse al recargar.
    revalidarContenido(acceso.campaignId);
    if (!r.ok) return fallo(mensajeDeContenido(r.error), r.error.code);
    return { ok: true, version: r.value.version, reemplazaA: r.value.previousApproved?.version ?? null };
  } catch (error) {
    registrarFallo('aprobarVersionDeGuion', error);
    return fallo(MENSAJE_GENERICO, 'INTERNAL');
  }
}
