/**
 * Subida de evidencia operativa (V2 · Fase 8).
 *
 *   POST /api/campanas/[id]/operacion/evidencia   multipart:
 *        archivo, tipo (documento_cobro | envio | pago), accion, idempotencyKey y los campos del caso de uso
 *
 *   tipo            accion         caso de uso                                  campos
 *   documento_cobro registrar      registrarDocumentoDeCobro                    participacionId, paymentObligationId,
 *                                                                              documentNumber, issuedOn, claimedAmount,
 *                                                                              claimedCurrency, [note]
 *   documento_cobro adjuntar       adjuntarEvidenciaOperativa (billing_document) participacionId, billingDocumentId,
 *                                                                              expectedSeq, [kind], [note]
 *   envio           transicionar   transicionarEnvio con evidencia              shipmentId, to, expectedSeq, [happenedOn,
 *                                                                              carrier, trackingRef, cancelReason, note,
 *                                                                              kind]
 *   envio           adjuntar       adjuntarEvidenciaOperativa (shipment)        shipmentId, expectedSeq, [kind], [note]
 *   pago            reportar       reportarPago con comprobante                 participacionId, paymentObligationId,
 *                                                                              expectedSeq, paidOn, externalReference,
 *                                                                              [note, kind]
 *   pago            adjuntar       adjuntarEvidenciaOperativa (payment_obligation) participacionId, paymentObligationId,
 *                                                                              expectedSeq, [kind], [note]
 *
 * ¿Por qué un route handler y no una server action? Next 15 limita el cuerpo de una server action a 1 MB: un
 * PDF o una foto de un soporte normal no cabe. Aquí el tope es EXPLÍCITO (`limiteDeAdjuntoBytes`, el mismo del
 * chat y de los guiones) y se comprueba con `Content-Length` ANTES de leer el cuerpo.
 *
 * Los imports de `lib/` son RELATIVOS (no `@/`) para poder probar la ruta con vitest sin configurar el alias
 * (`apps/web/src/lib/operacion-evidencia-route.test.ts`).
 *
 * Seguridad (no hay middleware: la ruta se protege sola):
 *  · comprobación de origen ESTRICTA (CSRF): `Sec-Fetch-Site` same-origin/none y `Origin` === `Host`; NO se
 *    confía en `x-forwarded-host` (deuda UI-09 de la ruta de guiones, cerrada aquí);
 *  · sesión (`currentUser`, releída de la base) y rol con `operations:read`; cliente, analista, legal, otra
 *    organización y campaña inexistente reciben el MISMO 404. Un rol con `operations:read` pero sin la
 *    capacidad del caso de uso recibe 403 (el caso de uso la vuelve a exigir);
 *  · el sujeto (obligación, documento, envío) se verifica contra ESTA campaña (y participación) ANTES de
 *    guardar un solo byte: un sujeto ajeno o de otra campaña es un 404 indistinguible;
 *  · el cliente no elige organización, origen (`ui` fijo), visibilidad ni tipo de fuente (el caso de uso crea
 *    `soporte_operativo` interno y sensible, sin indexar);
 *  · solo pdf, png, jpg, jpeg, xlsx, csv y docx: por extensión ANTES de leer el cuerpo y por el contenido real
 *    (firma de archivo) después;
 *  · respuestas JSON con mensajes de dominio en español: sin trazas, sin ids ajenos y sin NOMBRES DE ARCHIVO
 *    (ni el propio ni el de otra persona).
 */

import { revalidatePath } from 'next/cache';
import {
  adjuntarEvidenciaOperativa,
  getCampaign,
  obtenerEnvio,
  obtenerSeguimientoDePago,
  registrarDocumentoDeCobro,
  reportarPago,
  transicionarEnvio,
} from '@tcl-kol-os/db';
import { type User, quitarInvisiblesOBidi, roleCan, validarArchivo } from '@tcl-kol-os/domain';
import { limiteDeAdjuntoBytes } from '../../../../../../lib/chat-server.ts';
import {
  MENSAJE_GENERICO,
  MENSAJE_NO_ENCONTRADO,
  MENSAJE_SIN_PERMISO,
  mensajeDeOperacion,
} from '../../../../../../lib/operacion-comun.ts';
import {
  type EntradaDeEvidencia,
  MENSAJE_TIPO_DE_EVIDENCIA,
  MIMES_DE_EVIDENCIA,
  esUuidDeFormulario,
  extensionDeEvidenciaPermitida,
  leerEntradaDeEvidencia,
  origenPermitidoEstricto,
} from '../../../../../../lib/operacion-formulario.ts';
import { currentUser } from '../../../../../../lib/session.ts';

export const dynamic = 'force-dynamic';

/** Holgura del cuerpo multipart sobre el archivo (límites de partes, nombre del campo). */
const HOLGURA_MULTIPART_BYTES = 64 * 1024;

const CONTEXTO_UI = { origin: 'ui' } as const;

function json(cuerpo: Record<string, unknown>, status = 200): Response {
  return Response.json(cuerpo, { status, headers: { 'Cache-Control': 'no-store' } });
}

const fallo = (codigo: string, mensaje: string, status: number, extra: Record<string, unknown> = {}) =>
  json({ ok: false, codigo, mensaje, ...extra }, status);

const NO_ENCONTRADO = (): Response => fallo('RESOURCE_NOT_FOUND', MENSAJE_NO_ENCONTRADO, 404);

/** Nombre de archivo sin ruta, controles, invisibles ni bidi (RLO, ZWSP…: criterio único del dominio). */
function nombreSeguro(nombre: string): string {
  const base = nombre.split(/[\\/]/u).pop() ?? '';
  // eslint-disable-next-line no-control-regex
  const limpio = quitarInvisiblesOBidi(base.replace(/[\u0000-\u001f\u007f]/gu, '')).trim();
  return (limpio === '' ? 'archivo' : limpio).slice(0, 200);
}

function estadoHttpDe(codigo: string): number {
  switch (codigo) {
    case 'FORBIDDEN_ROLE':
    case 'HUMAN_CONFIRMATION_REQUIRED':
      return 403;
    case 'RESOURCE_NOT_FOUND':
      return 404;
    case 'RESOURCE_CONFLICT':
    case 'SOURCE_ALREADY_EXISTS':
      return 409;
    case 'UNSUPPORTED_SOURCE_FORMAT':
      return 415;
    default:
      return 422;
  }
}

function falloDeDominio(error: {
  readonly code: string;
  readonly message: string;
  readonly details?: Readonly<Record<string, unknown>> | undefined;
}): Response {
  return fallo(error.code, mensajeDeOperacion(error), estadoHttpDe(error.code));
}

/** Un error de dominio previo a escribir: «no existe» y «no autorizado» no se distinguen para el recurso. */
function falloDePreComprobacion(error: {
  readonly code: string;
  readonly message: string;
  readonly details?: Readonly<Record<string, unknown>> | undefined;
}): Response {
  return error.code === 'FORBIDDEN_ROLE'
    ? fallo('FORBIDDEN_ROLE', MENSAJE_SIN_PERMISO, 403)
    : NO_ENCONTRADO();
}

/**
 * Comprueba que el sujeto de la subida pertenece a ESTA campaña (y participación) y devuelve la respuesta de
 * error si no. No guarda nada.
 */
async function comprobarSujeto(
  user: User,
  campaignId: string,
  entrada: EntradaDeEvidencia,
): Promise<Response | undefined> {
  if (entrada.tipo === 'envio') {
    const envio = await obtenerEnvio(user, entrada.shipmentId);
    if (!envio.ok) return falloDePreComprobacion(envio.error);
    return envio.value.campaignId === campaignId ? undefined : NO_ENCONTRADO();
  }
  const seguimiento = await obtenerSeguimientoDePago(user, entrada.participacionId);
  if (!seguimiento.ok) return falloDePreComprobacion(seguimiento.error);
  const s = seguimiento.value;
  if (s === null || s.obligation.campaignId !== campaignId) return NO_ENCONTRADO();
  if (entrada.tipo === 'pago' || entrada.accion === 'registrar') {
    return s.obligation.id === entrada.paymentObligationId ? undefined : NO_ENCONTRADO();
  }
  return s.documents.some((d) => d.id === entrada.billingDocumentId) ? undefined : NO_ENCONTRADO();
}

export async function POST(
  request: Request,
  contexto: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    if (!origenPermitidoEstricto(request)) return fallo('FORBIDDEN', 'Petición no permitida.', 403);
    const { id } = await contexto.params;

    const user = await currentUser();
    if (user === undefined) return fallo('SESSION', 'Tu sesión expiró. Inicia sesión de nuevo.', 401);
    // Sin `operations:read` o campaña ajena/inexistente: el mismo 404 (no se revela que existe).
    if (!roleCan(user.role, 'operations:read') || !esUuidDeFormulario(id)) return NO_ENCONTRADO();
    const campana = await getCampaign(user, id);
    if (!campana.ok) return NO_ENCONTRADO();
    const campaignId = campana.value.campaign.id;

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
      return fallo('VALIDATION_FAILED', 'Selecciona un archivo.', 422, { campo: 'archivo' });
    }
    if (archivo.size > maximo) {
      return fallo('PAYLOAD_TOO_LARGE', `El archivo supera el límite de ${mb} MB.`, 413);
    }
    const nombre = nombreSeguro(archivo.name);
    if (!extensionDeEvidenciaPermitida(nombre)) {
      return fallo('UNSUPPORTED_SOURCE_FORMAT', MENSAJE_TIPO_DE_EVIDENCIA, 415, { campo: 'archivo' });
    }

    const lectura = leerEntradaDeEvidencia(formulario);
    if (!lectura.ok) return fallo('VALIDATION_FAILED', lectura.message, 422, { campo: lectura.field });
    const entrada = lectura.value;

    // El sujeto es de ESTA campaña: antes de guardar un solo byte.
    const rechazo = await comprobarSujeto(user, campaignId, entrada);
    if (rechazo !== undefined) return rechazo;

    const bytes = new Uint8Array(await archivo.arrayBuffer());
    const tipoDeclarado = archivo.type === '' ? undefined : archivo.type;
    // Tipo REAL por el contenido: una extensión permitida con otro contenido (o un .md/.pptx) se rechaza.
    const validacion = validarArchivo(bytes, bytes.byteLength, maximo, tipoDeclarado, nombre);
    if (!validacion.valido) {
      return fallo(
        validacion.codigo ?? 'VALIDATION_FAILED',
        validacion.motivo ?? 'El archivo no es válido.',
        estadoHttpDe(validacion.codigo ?? 'VALIDATION_FAILED'),
        { campo: 'archivo' },
      );
    }
    if (validacion.mimeType === undefined || !MIMES_DE_EVIDENCIA.includes(validacion.mimeType)) {
      return fallo('UNSUPPORTED_SOURCE_FORMAT', MENSAJE_TIPO_DE_EVIDENCIA, 415, { campo: 'archivo' });
    }
    const archivoDeEvidencia = { filename: nombre, contenido: bytes, tipoDeclarado };

    let respuesta: Record<string, unknown>;
    switch (entrada.tipo) {
      case 'documento_cobro': {
        if (entrada.accion === 'registrar') {
          const r = await registrarDocumentoDeCobro(
            user,
            {
              paymentObligationId: entrada.paymentObligationId,
              documentNumber: entrada.documentNumber,
              issuedOn: entrada.issuedOn,
              claimedAmount: entrada.claimedAmount,
              claimedCurrency: entrada.claimedCurrency,
              archivo: archivoDeEvidencia,
              idempotencyKey: entrada.idempotencyKey,
              ...(entrada.note !== undefined ? { note: entrada.note } : {}),
            },
            CONTEXTO_UI,
          );
          if (!r.ok) return falloDeDominio(r.error);
          respuesta = {
            repetido: r.value.repetido,
            documentoId: r.value.documento.id,
            estado: r.value.documento.status,
            rowSeq: r.value.documento.rowSeq,
          };
        } else {
          const r = await adjuntarEvidenciaOperativa(
            user,
            {
              subjectType: 'billing_document',
              subjectId: entrada.billingDocumentId,
              expectedSeq: entrada.expectedSeq,
              idempotencyKey: entrada.idempotencyKey,
              kind: entrada.kind,
              archivo: archivoDeEvidencia,
              ...(entrada.note !== undefined ? { note: entrada.note } : {}),
            },
            CONTEXTO_UI,
          );
          if (!r.ok) return falloDeDominio(r.error);
          respuesta = resumenDeEvento(r);
        }
        break;
      }
      case 'envio': {
        if (entrada.accion === 'transicionar') {
          const r = await transicionarEnvio(
            user,
            {
              shipmentId: entrada.shipmentId,
              to: entrada.to,
              expectedSeq: entrada.expectedSeq,
              idempotencyKey: entrada.idempotencyKey,
              ...(entrada.happenedOn !== undefined ? { happenedOn: entrada.happenedOn } : {}),
              ...(entrada.carrier !== undefined ? { carrier: entrada.carrier } : {}),
              ...(entrada.trackingRef !== undefined ? { trackingRef: entrada.trackingRef } : {}),
              ...(entrada.cancelReason !== undefined ? { cancelReason: entrada.cancelReason } : {}),
              ...(entrada.note !== undefined ? { note: entrada.note } : {}),
              evidencia: { archivo: archivoDeEvidencia, kind: entrada.kind },
            },
            CONTEXTO_UI,
          );
          if (!r.ok) return falloDeDominio(r.error);
          respuesta = {
            repetido: r.value.repetido,
            estado: r.value.envio.status,
            rowSeq: r.value.envio.rowSeq,
          };
        } else {
          const r = await adjuntarEvidenciaOperativa(
            user,
            {
              subjectType: 'shipment',
              subjectId: entrada.shipmentId,
              expectedSeq: entrada.expectedSeq,
              idempotencyKey: entrada.idempotencyKey,
              kind: entrada.kind,
              archivo: archivoDeEvidencia,
              ...(entrada.note !== undefined ? { note: entrada.note } : {}),
            },
            CONTEXTO_UI,
          );
          if (!r.ok) return falloDeDominio(r.error);
          respuesta = resumenDeEvento(r);
        }
        break;
      }
      case 'pago': {
        if (entrada.accion === 'reportar') {
          const r = await reportarPago(
            user,
            {
              paymentObligationId: entrada.paymentObligationId,
              expectedSeq: entrada.expectedSeq,
              idempotencyKey: entrada.idempotencyKey,
              paidOn: entrada.paidOn,
              externalReference: entrada.externalReference,
              ...(entrada.note !== undefined ? { note: entrada.note } : {}),
              evidencia: { archivo: archivoDeEvidencia, kind: entrada.kind },
            },
            CONTEXTO_UI,
          );
          if (!r.ok) return falloDeDominio(r.error);
          respuesta = {
            repetido: r.value.repetido,
            estado: r.value.obligacion.status,
            rowSeq: r.value.obligacion.rowSeq,
            sinDocumentoValidado: r.value.obligacion.billingValidatedAtReport === false,
          };
        } else {
          const r = await adjuntarEvidenciaOperativa(
            user,
            {
              subjectType: 'payment_obligation',
              subjectId: entrada.paymentObligationId,
              expectedSeq: entrada.expectedSeq,
              idempotencyKey: entrada.idempotencyKey,
              kind: entrada.kind,
              archivo: archivoDeEvidencia,
              ...(entrada.note !== undefined ? { note: entrada.note } : {}),
            },
            CONTEXTO_UI,
          );
          if (!r.ok) return falloDeDominio(r.error);
          respuesta = resumenDeEvento(r);
        }
        break;
      }
    }

    revalidatePath(`/campanas/${campaignId}/operacion`, 'layout');
    return json({ ok: true, tipo: entrada.tipo, accion: entrada.accion, ...respuesta });
  } catch (error) {
    console.error('[operacion-evidencia] POST', error instanceof Error ? error.name : typeof error);
    return fallo('INTERNAL', MENSAJE_GENERICO, 500);
  }
}

/** Estado y contador del sujeto tras adjuntar evidencia (sin ids de fuente ni nombres de archivo). */
function resumenDeEvento(r: {
  readonly value: {
    readonly repetido: boolean;
    readonly sujeto: { readonly status: string; readonly rowSeq: number };
  };
}): Record<string, unknown> {
  return { repetido: r.value.repetido, estado: r.value.sujeto.status, rowSeq: r.value.sujeto.rowSeq };
}
