/**
 * Subida de la versión de un guion (V2 · Fase 7).
 *
 *   POST /api/campanas/[id]/contenido/guiones   multipart:
 *        archivo, participacionId, y deliverableId (un entregable de esa participación)
 *                                  o etiqueta (coincidencia normalizada o entregable nuevo)
 *
 * Registra el archivo como FUENTE interna de la campaña (`registrarAdjuntoDeArchivo` →
 * `uploadSource`: la validación por contenido real, el tamaño, las macros y el duplicado por hash son
 * las del flujo de fuentes; un duplicado vincula la fuente existente) y la registra como la versión
 * SIGUIENTE del entregable (`registrarVersionDeGuion`, origen `ui`). Nunca sobrescribe: un guion nuevo
 * es una versión nueva.
 *
 * ¿Por qué un route handler y no una server action? Next 15 limita el cuerpo de una server action a 1 MB
 * (`serverActions.bodySizeLimit`): un guion en PDF o DOCX normal no cabe. Un route handler no tiene ese
 * tope; aquí se impone uno EXPLÍCITO (`limiteDeAdjuntoBytes`, el mismo del chat) comprobando
 * `Content-Length` ANTES de leer el cuerpo.
 *
 * Seguridad (no hay middleware: la ruta se protege sola):
 *  · sesión (`currentUser`, releída de la base) y rol con `script:manage` (admin, director, consultor);
 *    cliente, operativo, analista, legal y otra organización reciben el MISMO 404 que una campaña
 *    inexistente;
 *  · comprobación de origen (CSRF): `Sec-Fetch-Site` y `Origin` deben ser del propio sitio;
 *  · el cliente no elige organización, visibilidad (siempre `interna`), tipo ni origen (`ui`);
 *  · el DTO no incluye rutas de almacenamiento, hashes ni URL;
 *  · los errores son mensajes de dominio en español, sin trazas.
 */

import { revalidatePath } from 'next/cache';
import {
  comprobarDestinoDeGuion,
  getCampaign,
  obtenerEntregable,
  registrarAdjuntoDeArchivo,
  registrarVersionDeGuion,
} from '@tcl-kol-os/db';
import { quitarInvisiblesOBidi, roleCan } from '@tcl-kol-os/domain';
import { limiteDeAdjuntoBytes } from '@/lib/chat-server';
import { MENSAJE_GENERICO, mensajeDeContenido } from '@/lib/contenido-mensajes';
import { currentUser } from '@/lib/session';

export const dynamic = 'force-dynamic';

/** Holgura del cuerpo multipart sobre el archivo (límites de partes, nombre del campo). */
const HOLGURA_MULTIPART_BYTES = 64 * 1024;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function json(cuerpo: Record<string, unknown>, status = 200): Response {
  return Response.json(cuerpo, { status, headers: { 'Cache-Control': 'no-store' } });
}

const fallo = (codigo: string, mensaje: string, status: number, extra: Record<string, unknown> = {}) =>
  json({ ok: false, codigo, mensaje, ...extra }, status);

const NO_ENCONTRADO = (): Response => fallo('RESOURCE_NOT_FOUND', 'No encontramos ese elemento.', 404);

/**
 * CSRF: una petición de otro sitio no debe poder escribir con las cookies de la persona. Los
 * navegadores modernos mandan `Sec-Fetch-Site` y, en un POST, `Origin`. Sin ninguno de los dos
 * no es un navegador (curl, pruebas): no hay riesgo de CSRF, que exige un navegador de la víctima.
 */
function origenPermitido(request: Request): boolean {
  const sitio = request.headers.get('sec-fetch-site');
  if (sitio !== null && sitio !== 'same-origin' && sitio !== 'none') return false;
  const origen = request.headers.get('origin');
  if (origen === null) return true;
  let host: string;
  try {
    host = new URL(origen).host;
  } catch {
    return false;
  }
  const propios = [
    request.headers.get('host'),
    request.headers.get('x-forwarded-host')?.split(',')[0]?.trim(),
  ];
  return propios.some((p) => p !== null && p !== undefined && p !== '' && p === host);
}

/** Nombre de archivo sin ruta, controles, invisibles ni bidi (RLO, ZWSP…: criterio único del dominio). */
function nombreSeguro(nombre: string): string {
  const base = nombre.split(/[\\/]/).pop() ?? '';
  // eslint-disable-next-line no-control-regex
  const limpio = quitarInvisiblesOBidi(base.replace(/[\u0000-\u001f\u007f]/g, '')).trim();
  return (limpio === '' ? 'archivo' : limpio).slice(0, 200);
}

function estadoHttpDe(codigo: string): number {
  switch (codigo) {
    case 'FORBIDDEN_ROLE':
      return 403;
    case 'RESOURCE_NOT_FOUND':
      return 404;
    case 'RESOURCE_CONFLICT':
    case 'SOURCE_ALREADY_EXISTS':
      return 409;
    default:
      return 422;
  }
}

/** 409 NEEDS_CHOICE: falta una elección humana (entregable parecido o ambiguo); sin efecto sobre nada. */
function respuestaDeEleccion(r: {
  readonly reason: string;
  readonly candidates: readonly object[];
}): Response {
  const candidatos = r.candidates.flatMap((c) =>
    'label' in c && 'id' in c ? [{ id: String(c.id), nombre: String(c.label) }] : [],
  );
  return fallo(
    'NEEDS_CHOICE',
    r.reason === 'deliverable_ambiguous'
      ? 'Ya hay un entregable parecido: elige uno de la lista en vez de crear uno nuevo.'
      : 'Elige el entregable al que pertenece el guion.',
    409,
    { razon: r.reason, candidatos },
  );
}

function texto(valor: FormDataEntryValue | null): string | undefined {
  return typeof valor === 'string' && valor.trim() !== '' ? valor.trim() : undefined;
}

export async function POST(
  request: Request,
  contexto: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    if (!origenPermitido(request)) return fallo('FORBIDDEN', 'Petición no permitida.', 403);
    const { id } = await contexto.params;

    const user = await currentUser();
    if (user === undefined) {
      return fallo('SESSION', 'Tu sesión expiró. Inicia sesión de nuevo.', 401);
    }
    // Sin `script:manage` o campaña ajena/inexistente: el mismo 404 (no se revela que existe).
    if (!roleCan(user.role, 'script:manage') || !UUID.test(id)) return NO_ENCONTRADO();
    const campana = await getCampaign(user, id);
    if (!campana.ok) return NO_ENCONTRADO();
    const campaignId = campana.value.campaign.id;
    if (campana.value.campaign.status !== 'activa') {
      return fallo(
        'RESOURCE_CONFLICT',
        mensajeDeContenido({
          code: 'RESOURCE_CONFLICT',
          message: '',
          details: { reason: 'campaign_not_active' },
        }),
        409,
      );
    }

    // Tope de tamaño explícito, ANTES de leer el cuerpo.
    const maximo = limiteDeAdjuntoBytes();
    const mb = Math.floor(maximo / 1024 / 1024);
    const largo = Number(request.headers.get('content-length'));
    if (!Number.isFinite(largo) || largo <= 0) {
      return fallo('LENGTH_REQUIRED', 'No se pudo determinar el tamaño del archivo.', 411);
    }
    if (largo > maximo + HOLGURA_MULTIPART_BYTES) {
      return fallo('PAYLOAD_TOO_LARGE', `El archivo supera el límite de ${mb} MB.`, 413);
    }

    let formulario: FormData;
    try {
      formulario = await request.formData();
    } catch {
      return fallo('VALIDATION_FAILED', 'La petición no es válida.', 400);
    }
    const archivo = formulario.get('archivo');
    if (!(archivo instanceof File) || archivo.size === 0) {
      return fallo('VALIDATION_FAILED', 'Selecciona un archivo.', 422);
    }
    if (archivo.size > maximo) {
      return fallo('PAYLOAD_TOO_LARGE', `El archivo supera el límite de ${mb} MB.`, 413);
    }

    const participacionId = texto(formulario.get('participacionId'));
    const deliverableId = texto(formulario.get('deliverableId'));
    const etiqueta = texto(formulario.get('etiqueta'));
    if (participacionId === undefined || !UUID.test(participacionId)) {
      return fallo('VALIDATION_FAILED', 'Indica a qué participación pertenece el guion.', 422);
    }
    if (deliverableId !== undefined && !UUID.test(deliverableId)) return NO_ENCONTRADO();
    if (deliverableId === undefined && etiqueta === undefined) {
      return fallo('VALIDATION_FAILED', 'Indica el entregable al que pertenece el guion.', 422);
    }

    // Comprobación previa (antes de guardar bytes): el entregable existe en ESTA campaña y participación y
    // está activo; así un guion destinado a un entregable inexistente no deja una fuente huérfana.
    if (deliverableId !== undefined) {
      const entregable = await obtenerEntregable(user, deliverableId, { alcance: { campaignId } });
      if (!entregable.ok || entregable.value.projection !== 'cuenta') return NO_ENCONTRADO();
      const e = entregable.value.deliverable;
      if (e.campaignInfluencerId !== participacionId) return NO_ENCONTRADO();
      if (e.status !== 'active') {
        return fallo(
          'RESOURCE_CONFLICT',
          mensajeDeContenido({
            code: 'RESOURCE_CONFLICT',
            message: '',
            details: { reason: 'deliverable_archived' },
          }),
          409,
        );
      }
    }

    // Misma resolución que el registro (participación de ESTA campaña y activa, etiqueta válida, entregable
    // inequívoco), SIN guardar nada: un destino inválido o ambiguo no deja una fuente suelta (QA-F7-UI-06).
    const destino = await comprobarDestinoDeGuion(
      user,
      {
        campaignId,
        participation: { participationId: participacionId },
        deliverable: deliverableId !== undefined ? { id: deliverableId } : { label: etiqueta! },
      },
      { origin: 'ui' },
    );
    if (!destino.ok) {
      return fallo(destino.error.code, mensajeDeContenido(destino.error), estadoHttpDe(destino.error.code));
    }
    if (destino.value.kind === 'needs_choice') return respuestaDeEleccion(destino.value);

    const contenido = new Uint8Array(await archivo.arrayBuffer());
    // Origen `ui`; tipo `otro` y visibilidad `interna` (por defecto de la fuente): no los decide la
    // petición. Un duplicado por hash vincula la fuente existente en vez de rechazarse.
    const registrado = await registrarAdjuntoDeArchivo(
      user,
      {
        campaignId,
        filename: nombreSeguro(archivo.name),
        contenido,
        tipoDeclarado: archivo.type === '' ? undefined : archivo.type,
        type: 'otro',
      },
      { origin: 'ui' },
    );
    if (!registrado.ok) {
      return fallo(
        registrado.error.code,
        mensajeDeContenido(registrado.error),
        estadoHttpDe(registrado.error.code),
      );
    }

    const version = await registrarVersionDeGuion(
      user,
      {
        campaignId,
        sourceId: registrado.value.sourceId,
        participation: { participationId: participacionId },
        deliverable: deliverableId !== undefined ? { id: deliverableId } : { label: etiqueta! },
      },
      { origin: 'ui' },
    );
    if (!version.ok) {
      return fallo(version.error.code, mensajeDeContenido(version.error), estadoHttpDe(version.error.code));
    }

    const r = version.value;
    if (r.kind === 'needs_choice') {
      // Solo por una carrera (el destino cambió entre la comprobación y el registro): sin efecto sobre
      // las versiones; la fuente guardada queda ligada por hash y un reenvío del mismo archivo la reutiliza.
      return respuestaDeEleccion(r);
    }

    revalidatePath(`/campanas/${campaignId}/contenido`, 'layout');
    revalidatePath(`/campanas/${campaignId}/chat`);
    return json({
      ok: true,
      resultado: r.kind === 'registered' ? 'registrada' : 'ya_registrada',
      archivoDuplicado: registrado.value.deduplicated,
      entregableCreado: r.kind === 'registered' ? r.createdDeliverable : false,
      deliverableId: r.deliverable.id,
      participacionId: r.deliverable.campaignInfluencerId,
      version: r.version.version,
      estadoDeLaFuente: r.sourceState,
      ...(registrado.value.aviso !== undefined && registrado.value.aviso !== ''
        ? { aviso: registrado.value.aviso }
        : {}),
    });
  } catch (error) {
    console.error('[contenido-guiones] POST', error instanceof Error ? error.name : typeof error);
    return fallo('INTERNAL', MENSAJE_GENERICO, 500);
  }
}
