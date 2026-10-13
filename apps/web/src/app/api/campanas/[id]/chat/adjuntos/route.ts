/**
 * Adjuntos del chat (V2 · Fase 6, D14).
 *
 *   POST /api/campanas/[id]/chat/adjuntos   multipart `archivo`  → registra una FUENTE de la campaña
 *   GET  /api/campanas/[id]/chat/adjuntos?ids=a,b                → estado de procesamiento (chips)
 *
 * ¿Por qué un route handler y no una server action? Next 15 limita el cuerpo de una server action
 * a 1 MB por defecto (`serverActions.bodySizeLimit`, `action-handler.js`): un PDF o PPTX normal no
 * cabe. Un route handler no tiene ese tope; aquí se impone uno EXPLÍCITO (`limiteDeAdjuntoBytes`,
 * 25 MB por defecto, nunca más que `MAX_UPLOAD_MB`) comprobando `Content-Length` ANTES de leer el
 * cuerpo. La validación del archivo (tipo por contenido real, tamaño, macros, duplicado por hash)
 * es la del flujo de fuentes (`uploadSource` vía `registrarAdjuntoDeArchivo`): no se duplica aquí.
 *
 * Seguridad (no hay middleware: la ruta se protege sola):
 *  · sesión (`currentUser`, releída de la base) y rol con `chat:write`; cliente, operativo,
 *    analista, legal y otra organización reciben el MISMO 404 que una campaña inexistente;
 *  · comprobación de origen (CSRF) estricta (`lib/origen.ts`): `Sec-Fetch-Site` y `Origin` deben ser del
 *    propio sitio y NO se confía en `x-forwarded-host`;
 *  · el cliente no elige organización, visibilidad (siempre `interna`), tipo ni origen (`ui`);
 *  · el DTO no incluye rutas de almacenamiento, hashes ni URL: solo id, nombre y estado;
 *  · los errores son mensajes de dominio en español, sin trazas.
 */

import {
  estadoDeAdjuntos,
  getCampaign,
  registrarAdjuntoDeArchivo,
  type VistaDeAdjunto,
} from '@tcl-kol-os/db';
import { roleCan } from '@tcl-kol-os/domain';
import { limiteDeAdjuntoBytes } from '../../../../../../lib/chat-server.ts';
import { origenPermitidoEstricto } from '../../../../../../lib/origen.ts';
import { currentUser } from '../../../../../../lib/session.ts';

export const dynamic = 'force-dynamic';

/** Holgura del cuerpo multipart sobre el archivo (límites de partes, nombre del campo). */
const HOLGURA_MULTIPART_BYTES = 64 * 1024;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function json(cuerpo: Record<string, unknown>, status = 200): Response {
  return Response.json(cuerpo, { status, headers: { 'Cache-Control': 'no-store' } });
}

const NO_ENCONTRADO = (): Response => json({ error: 'No encontramos ese elemento.' }, 404);

/** Nombre de archivo sin ruta ni caracteres de control, acotado. */
function nombreSeguro(nombre: string): string {
  const base = nombre.split(/[\\/]/).pop() ?? '';
  // eslint-disable-next-line no-control-regex
  const limpio = base.replace(/[\u0000-\u001f\u007f]/g, '').trim();
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

/** Persona con acceso al chat de la campaña, o la respuesta de error ya lista. */
async function acceso(id: string) {
  const user = await currentUser();
  if (user === undefined)
    return { respuesta: json({ error: 'Tu sesión expiró. Inicia sesión de nuevo.' }, 401) };
  // Sin chat:write o campaña ajena/inexistente: el mismo 404 (no se revela que existe).
  if (!roleCan(user.role, 'chat:write') || !UUID.test(id)) return { respuesta: NO_ENCONTRADO() };
  const campana = await getCampaign(user, id);
  if (!campana.ok) return { respuesta: NO_ENCONTRADO() };
  return { user, campaignId: campana.value.campaign.id };
}

export async function POST(
  request: Request,
  contexto: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    if (!origenPermitidoEstricto(request)) return json({ error: 'Petición no permitida.' }, 403);
    const { id } = await contexto.params;
    const a = await acceso(id);
    if ('respuesta' in a) return a.respuesta;

    // Tope de tamaño explícito, ANTES de leer el cuerpo.
    const maximo = limiteDeAdjuntoBytes();
    const largo = Number(request.headers.get('content-length'));
    if (!Number.isFinite(largo) || largo <= 0) {
      return json({ error: 'No se pudo determinar el tamaño del archivo.' }, 411);
    }
    if (largo > maximo + HOLGURA_MULTIPART_BYTES) {
      return json(
        {
          error: `El archivo supera el límite de ${Math.floor(maximo / 1024 / 1024)} MB para adjuntar en el chat.`,
        },
        413,
      );
    }

    let formulario: FormData;
    try {
      formulario = await request.formData();
    } catch {
      return json({ error: 'La petición no es válida.' }, 400);
    }
    const archivo = formulario.get('archivo');
    if (!(archivo instanceof File) || archivo.size === 0) {
      return json({ error: 'Selecciona un archivo.' }, 422);
    }
    if (archivo.size > maximo) {
      return json(
        {
          error: `El archivo supera el límite de ${Math.floor(maximo / 1024 / 1024)} MB para adjuntar en el chat.`,
        },
        413,
      );
    }

    const contenido = new Uint8Array(await archivo.arrayBuffer());
    // Origen `ui` por omisión: una persona sube el archivo desde la interfaz. Tipo `otro` y visibilidad
    // `interna` (el valor por defecto de la fuente): no los decide la petición. Un duplicado por hash
    // vincula la fuente existente en vez de rechazarse.
    const registrado = await registrarAdjuntoDeArchivo(a.user, {
      campaignId: a.campaignId,
      filename: nombreSeguro(archivo.name),
      contenido,
      tipoDeclarado: archivo.type === '' ? undefined : archivo.type,
      type: 'otro',
    });
    if (!registrado.ok) {
      return json({ error: registrado.error.message }, estadoHttpDe(registrado.error.code));
    }

    const vista = await estadoDeAdjuntos(a.user, a.campaignId, [registrado.value.sourceId]);
    const adjunto: VistaDeAdjunto | undefined = vista.ok ? vista.value[0] : undefined;
    if (adjunto === undefined) return json({ error: 'No se pudo registrar el adjunto.' }, 500);
    return json({
      adjunto,
      duplicado: registrado.value.deduplicated,
      ...(registrado.value.aviso !== undefined && registrado.value.aviso !== ''
        ? { aviso: registrado.value.aviso }
        : {}),
    });
  } catch (error) {
    console.error('[chat-adjuntos] POST', error instanceof Error ? error.name : typeof error);
    return json({ error: 'Ocurrió un error inesperado. Inténtalo de nuevo.' }, 500);
  }
}

export async function GET(
  request: Request,
  contexto: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const { id } = await contexto.params;
    const a = await acceso(id);
    if ('respuesta' in a) return a.respuesta;

    const ids = (new URL(request.url).searchParams.get('ids') ?? '')
      .split(',')
      .map((x) => x.trim())
      .filter((x) => UUID.test(x))
      .slice(0, 10);
    if (ids.length === 0) return json({ adjuntos: [] });
    const vista = await estadoDeAdjuntos(a.user, a.campaignId, ids);
    if (!vista.ok) return NO_ENCONTRADO();
    return json({ adjuntos: vista.value });
  } catch (error) {
    console.error('[chat-adjuntos] GET', error instanceof Error ? error.name : typeof error);
    return json({ error: 'Ocurrió un error inesperado.' }, 500);
  }
}
