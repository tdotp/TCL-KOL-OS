'use server';

/**
 * Server actions de ESCRITURA de Operación (V2 · Fase 8): acuerdos, envíos, documentos de cobro, pagos
 * (SEGUIMIENTO: nunca se ejecuta un pago), KPIs y datos personales.
 *
 * Adaptadores finos con el mismo patrón que `contenido-actions.ts`. Cada una:
 *  · resuelve a la PERSONA con `currentUser()` (releída de la base en cada llamada; jamás del formulario);
 *  · exige `operations:read` (cliente, analista y legal reciben «no encontrado») y la capacidad de su
 *    caso de uso (la repite el dominio: un botón oculto no es un control);
 *  · lee y valida el `FormData` (`operacion-formulario.ts`): ids uuid, enums cerrados, montos decimales,
 *    fechas ISO, `idempotencyKey` y `expectedSeq`/`expectedVersion` donde el caso de uso los pide;
 *  · llama al caso de uso con origen `ui` FIJO. Ninguna acepta organización, rol, origen ni el autor; la
 *    campaña que se revalida sale del recurso escrito, no del formulario;
 *  · devuelve un `EstadoDeAccion` serializable `{ ok, message, field?, code?, repeated? }` con mensajes en
 *    español, SIN `details` internos, ids ajenos ni PII; y hace `revalidatePath` de la operación.
 *
 * Firma común (apta para `useActionState`): `(previo: EstadoDeAccion, formData: FormData) => Promise<EstadoDeAccion>`.
 * La subida de archivos (documento de cobro, soporte de envío/pago) NO vive aquí: las server actions limitan
 * el cuerpo a 1 MB; la hace `POST /api/campanas/[id]/operacion/evidencia`.
 *
 * Las notas libres llevan el aviso `AVISO_NOTAS_SIN_PII` (de `operacion-comun.ts`): no se escriben datos
 * personales ahí. La PII se guarda con `guardarPiiAction` y se revela con `revelarPiiAction`, una acción
 * EXPLÍCITA por clic (nunca al renderizar) que audita (`pii.reveal`, solo nombres de campo).
 */

import { revalidatePath } from 'next/cache';
import {
  type ObjetivoRegistrado,
  type SugerenciaDeSheet,
  anularDocumento,
  cancelarAcuerdo,
  corregirMedicionKpi,
  crearAcuerdo,
  crearEnvio,
  guardarPii,
  obtenerCampaignInfluencer,
  obtenerKpiPactadoDelSheet,
  rechazarDocumento,
  registrarKpiObjetivo,
  registrarMedicionKpi,
  registrarNotaDeCorreccionDePago,
  registrarVersionDeAcuerdo,
  reportarPago,
  revelarPii,
  transicionarEnvio,
  validarDocumento,
} from '@tcl-kol-os/db';
import {
  type Action,
  type Result,
  type User,
  err,
  ok,
  roleCan,
  validarCamposARevelar,
} from '@tcl-kol-os/domain';
import {
  type EstadoDeAccion,
  type ResultadoDeRevelacion,
  MENSAJE_GENERICO,
  MENSAJE_NO_ENCONTRADO,
  MENSAJE_SESION,
  MENSAJE_SIN_PERMISO,
  campoDeOperacion,
  codigoDeOperacion,
  mensajeDeOperacion,
} from './operacion-comun.ts';
import {
  type Lectura,
  esUuidDeFormulario,
  leerCancelacionDeAcuerdo,
  leerCorreccionDeMedicion,
  leerCrearAcuerdo,
  leerCrearEnvio,
  leerMedicionDeKpi,
  leerNotaDeCorreccion,
  leerNuevaVersionDeAcuerdo,
  leerObjetivoDeKpi,
  leerPiiAGuardar,
  leerReporteDePago,
  leerTransicionDeDocumento,
  leerTransicionDeEnvio,
} from './operacion-formulario.ts';
import { currentUser } from './session.ts';

/** Origen `ui` FIJO en servidor: no es un parámetro de ninguna acción. */
const CONTEXTO_UI = { origin: 'ui' } as const;

const fallo = (message: string, code: string, field?: string): EstadoDeAccion => ({
  ok: false,
  message,
  code,
  ...(field !== undefined ? { field } : {}),
});

function registrarFallo(accion: string, error: unknown): void {
  // Solo el nombre del error: ni mensaje, ni traza, ni datos de la petición (pueden ser PII).
  console.error(`[operacion-actions] ${accion}`, error instanceof Error ? error.name : typeof error);
}

/** La operación de la campaña (lista y detalle, todas las secciones). */
function revalidarOperacion(campaignId: string): void {
  revalidatePath(`/campanas/${campaignId}/operacion`, 'layout');
}

interface Especificacion<I, V> {
  readonly nombre: string;
  readonly capacidad: Action;
  readonly leer: (entrada: unknown) => Lectura<I>;
  readonly ejecutar: (user: User, entrada: I) => Promise<Result<V>>;
  readonly exito: (valor: V) => {
    readonly message: string;
    readonly campaignId: string;
    readonly repeated?: boolean;
  };
}

async function correr<I, V>(entrada: unknown, spec: Especificacion<I, V>): Promise<EstadoDeAccion> {
  try {
    const user = await currentUser();
    if (user === undefined) return fallo(MENSAJE_SESION, 'SESSION');
    // Cliente, analista y legal: «no encontrado», sin revelar que la sección existe.
    if (!roleCan(user.role, 'operations:read')) return fallo(MENSAJE_NO_ENCONTRADO, 'RESOURCE_NOT_FOUND');
    if (!roleCan(user.role, spec.capacidad)) return fallo(MENSAJE_SIN_PERMISO, 'FORBIDDEN_ROLE');

    const lectura = spec.leer(entrada);
    if (!lectura.ok) return fallo(lectura.message, 'VALIDATION_FAILED', lectura.field);

    const resultado = await spec.ejecutar(user, lectura.value);
    if (!resultado.ok) {
      const campo = campoDeOperacion(resultado.error);
      return fallo(mensajeDeOperacion(resultado.error), codigoDeOperacion(resultado.error), campo);
    }
    const exito = spec.exito(resultado.value);
    revalidarOperacion(exito.campaignId);
    return {
      ok: true,
      message: exito.message,
      ...(exito.repeated === true ? { repeated: true } : {}),
    };
  } catch (error) {
    registrarFallo(spec.nombre, error);
    return fallo(MENSAJE_GENERICO, 'INTERNAL');
  }
}

// ─────────────────────────── Acuerdos ──────────────────────────────────────────

/**
 * Crea el acuerdo de una participación (versión 1, compromisos de producto y obligación de pago).
 * Campos: `participacionId`, `idempotencyKey`, `compensationType` (fee|barter|mixed), `feeAmount`,
 * `feeCurrency` (fee/mixed), `startsOn`, `endsOn`, `conditions`, y filas repetidas `commitmentProductId` +
 * `commitmentQuantity` (barter/mixed ≥ 1).
 */
export async function crearAcuerdoAction(
  _previo: EstadoDeAccion,
  formData: FormData,
): Promise<EstadoDeAccion> {
  return correr(formData, {
    nombre: 'crearAcuerdoAction',
    capacidad: 'agreement:manage',
    leer: leerCrearAcuerdo,
    ejecutar: (user, entrada) => crearAcuerdo(user, entrada, CONTEXTO_UI),
    exito: (v) => ({
      message: v.repetido ? 'Ese acuerdo ya estaba registrado.' : 'Acuerdo registrado (versión 1).',
      campaignId: v.acuerdo.campaignId,
      repeated: v.repetido,
    }),
  });
}

/**
 * Registra una versión nueva del acuerdo (editar términos materiales = versión N+1).
 * Campos: `agreementId`, `expectedVersion` (la vigente que se vio), `changeReason`, `idempotencyKey` y los
 * mismos términos de `crearAcuerdoAction`.
 */
export async function registrarVersionDeAcuerdoAction(
  _previo: EstadoDeAccion,
  formData: FormData,
): Promise<EstadoDeAccion> {
  return correr(formData, {
    nombre: 'registrarVersionDeAcuerdoAction',
    capacidad: 'agreement:manage',
    leer: leerNuevaVersionDeAcuerdo,
    ejecutar: (user, e) => registrarVersionDeAcuerdo(user, e.agreementId, e.input, CONTEXTO_UI),
    exito: (v) => ({
      message: v.repetido
        ? 'Esa versión ya estaba registrada.'
        : `Versión ${v.acuerdo.currentVersion} del acuerdo registrada${
            v.obligacionAjustada ? '; la obligación de pago se ajustó al nuevo modo' : ''
          }.`,
      campaignId: v.acuerdo.campaignId,
      repeated: v.repetido,
    }),
  });
}

/** Cancela el acuerdo (estado, nunca borrado). Campos: `agreementId`, `reason`, `idempotencyKey`. */
export async function cancelarAcuerdoAction(
  _previo: EstadoDeAccion,
  formData: FormData,
): Promise<EstadoDeAccion> {
  return correr(formData, {
    nombre: 'cancelarAcuerdoAction',
    capacidad: 'agreement:manage',
    leer: leerCancelacionDeAcuerdo,
    ejecutar: (user, e) => cancelarAcuerdo(user, e.agreementId, e.input, CONTEXTO_UI),
    exito: (v) => ({
      message: v.repetido ? 'Ese acuerdo ya estaba cancelado.' : 'Acuerdo cancelado.',
      campaignId: v.acuerdo.campaignId,
      repeated: v.repetido,
    }),
  });
}

// ─────────────────────────── Envíos ────────────────────────────────────────────

/**
 * Crea un envío `pending`. Campos: `participacionId`, `idempotencyKey`, filas repetidas `itemProductId` +
 * `itemQuantity` (≥ 1), `carrier`, `trackingRef`, `shippingCost` + `shippingCurrency` (solo `finance:read`),
 * `piiRecordId` (solo `pii:manage`), `note`.
 */
export async function crearEnvioAction(_previo: EstadoDeAccion, formData: FormData): Promise<EstadoDeAccion> {
  return correr(formData, {
    nombre: 'crearEnvioAction',
    capacidad: 'shipment:manage',
    leer: leerCrearEnvio,
    ejecutar: (user, entrada) => crearEnvio(user, entrada, CONTEXTO_UI),
    exito: (v) => ({
      message: v.repetido ? 'Ese envío ya estaba registrado.' : 'Envío registrado (pendiente).',
      campaignId: v.envio.campaignId,
      repeated: v.repetido,
    }),
  });
}

const VERBO_DE_ENVIO: Readonly<Record<string, string>> = {
  prepared: 'preparado',
  shipped: 'marcado como enviado',
  delivered: 'marcado como entregado',
  failed: 'marcado como fallido',
  returned: 'marcado como devuelto',
  cancelled: 'cancelado',
};

/**
 * Mueve un envío (sin soporte adjunto; con soporte va por el route handler de evidencia).
 * Campos: `shipmentId`, `to` (prepared|shipped|delivered|failed|returned|cancelled), `expectedSeq`,
 * `idempotencyKey`, `happenedOn` (obligatoria al enviar y al entregar), `carrier`/`trackingRef` (al enviar),
 * `cancelReason` (al cancelar), `note`.
 */
export async function transicionarEnvioAction(
  _previo: EstadoDeAccion,
  formData: FormData,
): Promise<EstadoDeAccion> {
  return correr(formData, {
    nombre: 'transicionarEnvioAction',
    capacidad: 'shipment:manage',
    leer: leerTransicionDeEnvio,
    ejecutar: (user, entrada) => transicionarEnvio(user, entrada, CONTEXTO_UI),
    exito: (v) => ({
      message: v.repetido
        ? 'Ese cambio ya estaba registrado.'
        : `Envío ${VERBO_DE_ENVIO[v.envio.status] ?? 'actualizado'}.`,
      campaignId: v.envio.campaignId,
      repeated: v.repetido,
    }),
  });
}

// ─────────────────────────── Documentos de cobro ───────────────────────────────

/** Validar ≠ pagar: solo registra que el documento es correcto. Campos: `billingDocumentId`, `expectedSeq`, `idempotencyKey`, `note`. */
export async function validarDocumentoAction(
  _previo: EstadoDeAccion,
  formData: FormData,
): Promise<EstadoDeAccion> {
  return correr(formData, {
    nombre: 'validarDocumentoAction',
    capacidad: 'billing:manage',
    leer: leerTransicionDeDocumento,
    ejecutar: (user, entrada) => validarDocumento(user, entrada, CONTEXTO_UI),
    exito: (v) => ({
      message: v.repetido
        ? 'Ese documento ya estaba validado.'
        : 'Documento de cobro validado (esto no registra ningún pago).',
      campaignId: v.documento.campaignId,
      repeated: v.repetido,
    }),
  });
}

/** Rechaza un documento registrado (terminal). Mismos campos que `validarDocumentoAction`; `note` lleva el motivo. */
export async function rechazarDocumentoAction(
  _previo: EstadoDeAccion,
  formData: FormData,
): Promise<EstadoDeAccion> {
  return correr(formData, {
    nombre: 'rechazarDocumentoAction',
    capacidad: 'billing:manage',
    leer: leerTransicionDeDocumento,
    ejecutar: (user, entrada) => rechazarDocumento(user, entrada, CONTEXTO_UI),
    exito: (v) => ({
      message: v.repetido ? 'Ese documento ya estaba rechazado.' : 'Documento de cobro rechazado.',
      campaignId: v.documento.campaignId,
      repeated: v.repetido,
    }),
  });
}

/** Anula un documento registrado o validado (terminal; un error se corrige anulando y registrando de nuevo). */
export async function anularDocumentoAction(
  _previo: EstadoDeAccion,
  formData: FormData,
): Promise<EstadoDeAccion> {
  return correr(formData, {
    nombre: 'anularDocumentoAction',
    capacidad: 'billing:manage',
    leer: leerTransicionDeDocumento,
    ejecutar: (user, entrada) => anularDocumento(user, entrada, CONTEXTO_UI),
    exito: (v) => ({
      message: v.repetido ? 'Ese documento ya estaba anulado.' : 'Documento de cobro anulado.',
      campaignId: v.documento.campaignId,
      repeated: v.repetido,
    }),
  });
}

// ─────────────────────────── Pagos (seguimiento) ───────────────────────────────

/**
 * Reporta que un tercero PAGÓ (sin soporte; con comprobante va por el route handler de evidencia). Solo
 * `payment:report` (admin, operativo). Campos: `paymentObligationId`, `expectedSeq`, `idempotencyKey`,
 * `paidOn` y `externalReference` (obligatorios), `note`. Reportar sin un documento validado NO se bloquea:
 * el mensaje lo avisa.
 */
export async function reportarPagoAction(
  _previo: EstadoDeAccion,
  formData: FormData,
): Promise<EstadoDeAccion> {
  return correr(formData, {
    nombre: 'reportarPagoAction',
    capacidad: 'payment:report',
    leer: leerReporteDePago,
    ejecutar: (user, entrada) => reportarPago(user, entrada, CONTEXTO_UI),
    exito: (v) => ({
      message: v.repetido
        ? 'Ese pago ya estaba reportado.'
        : `Pago reportado como realizado (esto es seguimiento: la plataforma no ejecuta pagos).${
            v.obligacion.billingValidatedAtReport === false
              ? ' Se reportó sin un documento de cobro validado.'
              : ''
          }`,
      campaignId: v.obligacion.campaignId,
      repeated: v.repetido,
    }),
  });
}

/**
 * Anota una corrección sobre un pago YA reportado (el sello original es inmutable). Solo `payment:report`.
 * Campos: `paymentObligationId`, `expectedSeq`, `idempotencyKey`, `note` (obligatoria: qué se corrige y por
 * qué), `externalReference`, `happenedOn`.
 */
export async function registrarNotaDeCorreccionDePagoAction(
  _previo: EstadoDeAccion,
  formData: FormData,
): Promise<EstadoDeAccion> {
  return correr(formData, {
    nombre: 'registrarNotaDeCorreccionDePagoAction',
    capacidad: 'payment:report',
    leer: leerNotaDeCorreccion,
    ejecutar: (user, entrada) => registrarNotaDeCorreccionDePago(user, entrada, CONTEXTO_UI),
    exito: (v) => ({
      message: v.repetido ? 'Esa nota ya estaba registrada.' : 'Nota de corrección registrada.',
      campaignId: v.obligacion.campaignId,
      repeated: v.repetido,
    }),
  });
}

// ─────────────────────────── KPIs ──────────────────────────────────────────────

/**
 * Fija un objetivo de KPI (o lo reemplaza con `supersedesId`). Campos: `participacionId`, `idempotencyKey`,
 * `metric`, `otherLabel` (solo `other`), `targetValue`, `comparator` (gte|lte), `deliverableId`, `platform`,
 * `periodStart`, `periodEnd`, `supersedesId`. Para registrarlo con la procedencia del Sheet: `usarSugerenciaDelSheet=1`
 * + `sheetTextHash` (la `textHash` que la persona vio): el SERVIDOR re-resuelve el Sheet y, si cambió, no
 * registra; la procedencia nunca llega del cliente.
 */
export async function registrarKpiObjetivoAction(
  _previo: EstadoDeAccion,
  formData: FormData,
): Promise<EstadoDeAccion> {
  return correr(formData, {
    nombre: 'registrarKpiObjetivoAction',
    capacidad: 'kpi:target_manage',
    leer: leerObjetivoDeKpi,
    ejecutar: async (user, e): Promise<Result<ObjetivoRegistrado>> => {
      let sheetSuggestion: SugerenciaDeSheet | undefined;
      if (e.usarSugerenciaDelSheet) {
        const sugerida = await obtenerKpiPactadoDelSheet(user, e.campaignInfluencerId);
        if (!sugerida.ok) return sugerida;
        const pactado = sugerida.value;
        if (pactado === null || pactado.provenance.textHash !== e.sheetTextHash) {
          return err({
            code: 'RESOURCE_CONFLICT',
            message: 'El Sheet cambió desde que viste el KPI pactado.',
            details: { reason: 'sheet_changed' },
          });
        }
        sheetSuggestion = {
          snapshotId: pactado.provenance.snapshotId,
          locator: pactado.provenance.locator,
          textHash: pactado.provenance.textHash,
        };
      }
      return registrarKpiObjetivo(
        user,
        {
          campaignInfluencerId: e.campaignInfluencerId,
          ...(e.deliverableId !== undefined ? { deliverableId: e.deliverableId } : {}),
          metric: e.metric,
          ...(e.otherLabel !== undefined ? { otherLabel: e.otherLabel } : {}),
          targetValue: e.targetValue,
          comparator: e.comparator,
          ...(e.platform !== undefined ? { platform: e.platform } : {}),
          ...(e.periodStart !== undefined ? { periodStart: e.periodStart } : {}),
          ...(e.periodEnd !== undefined ? { periodEnd: e.periodEnd } : {}),
          ...(e.supersedesId !== undefined ? { supersedesId: e.supersedesId } : {}),
          idempotencyKey: e.idempotencyKey,
          ...(sheetSuggestion !== undefined ? { sheetSuggestion } : {}),
        },
        CONTEXTO_UI,
      );
    },
    exito: (v) => ({
      message: v.repetido
        ? 'Ese objetivo ya estaba registrado.'
        : v.objetivo.supersedesId !== null
          ? 'Objetivo de KPI reemplazado.'
          : 'Objetivo de KPI registrado.',
      campaignId: v.objetivo.campaignId,
      repeated: v.repetido,
    }),
  });
}

/**
 * Registra una medición real. Campos: `participacionId`, `idempotencyKey`, `metric`, `otherLabel`, `value`,
 * `observedAt` (`AAAA-MM-DD` o `AAAA-MM-DDTHH:mm`, UTC, no futuro), `deliverableId`, `platform`,
 * `periodStart`, `periodEnd`.
 */
export async function registrarMedicionKpiAction(
  _previo: EstadoDeAccion,
  formData: FormData,
): Promise<EstadoDeAccion> {
  return correr(formData, {
    nombre: 'registrarMedicionKpiAction',
    capacidad: 'kpi:measure',
    leer: leerMedicionDeKpi,
    ejecutar: (user, entrada) => registrarMedicionKpi(user, entrada, CONTEXTO_UI),
    exito: (v) => ({
      message: v.repetido ? 'Esa medición ya estaba registrada.' : 'Medición registrada.',
      campaignId: v.medicion.campaignId,
      repeated: v.repetido,
    }),
  });
}

/**
 * Corrige una medición (inserta una fila nueva con su motivo; la anterior queda intacta). Campos:
 * `measurementId`, `value`, `correctionReason`, `observedAt` (opcional), `idempotencyKey`.
 */
export async function corregirMedicionKpiAction(
  _previo: EstadoDeAccion,
  formData: FormData,
): Promise<EstadoDeAccion> {
  return correr(formData, {
    nombre: 'corregirMedicionKpiAction',
    capacidad: 'kpi:measure',
    leer: leerCorreccionDeMedicion,
    ejecutar: (user, e) => corregirMedicionKpi(user, e.measurementId, e.input, CONTEXTO_UI),
    exito: (v) => ({
      message: v.repetido ? 'Esa corrección ya estaba registrada.' : 'Corrección de la medición registrada.',
      campaignId: v.medicion.campaignId,
      repeated: v.repetido,
    }),
  });
}

// ─────────────────────────── Datos personales ──────────────────────────────────

/**
 * Guarda datos personales del influencer de la participación como una versión nueva (cifrada, append-only).
 * Solo `pii:manage` (admin, operativo). Campos: `participacionId`, `documentId`, `phone`, `address` (al menos
 * uno; los ausentes se conservan). El estado devuelto NO incluye ningún valor.
 */
export async function guardarPiiAction(_previo: EstadoDeAccion, formData: FormData): Promise<EstadoDeAccion> {
  return correr(formData, {
    nombre: 'guardarPiiAction',
    capacidad: 'pii:manage',
    leer: leerPiiAGuardar,
    ejecutar: async (
      user,
      e,
    ): Promise<
      Result<{ readonly version: number; readonly replayed: boolean; readonly campaignId: string }>
    > => {
      // El influencer sale de la participación (no del formulario).
      const participacion = await obtenerCampaignInfluencer(user, e.participacionId);
      if (!participacion.ok) return participacion;
      const guardado = await guardarPii(
        user,
        {
          influencerId: participacion.value.campaignInfluencer.influencerId,
          ...(e.documentId !== undefined ? { documentId: e.documentId } : {}),
          ...(e.phone !== undefined ? { phone: e.phone } : {}),
          ...(e.address !== undefined ? { address: e.address } : {}),
        },
        CONTEXTO_UI,
      );
      if (!guardado.ok) return guardado;
      return ok({
        version: guardado.value.record.version,
        replayed: guardado.value.replayed,
        campaignId: participacion.value.campaignInfluencer.campaignId,
      });
    },
    exito: (v) => ({
      message: v.replayed
        ? 'Esos datos ya eran los vigentes: no se creó otra versión.'
        : `Datos personales guardados (versión ${v.version}).`,
      campaignId: v.campaignId,
      repeated: v.replayed,
    }),
  });
}

/**
 * REVELA (descifra) campos de un registro de datos personales. Acción EXPLÍCITA por clic: NUNCA se llama al
 * renderizar. Solo `pii:read` (admin, operativo); el caso de uso audita `pii.reveal` (nombres de campo, jamás
 * valores). Los valores viajan únicamente en esta respuesta; la interfaz no debe guardarlos más de lo
 * necesario. `piiRecordId` es el `recordId` de `PiiSummary`; `campos` ⊂ `document_id | phone | address`.
 */
export async function revelarPiiAction(
  piiRecordId: string,
  campos: readonly string[],
): Promise<ResultadoDeRevelacion> {
  try {
    const user = await currentUser();
    if (user === undefined) return { ok: false, message: MENSAJE_SESION, code: 'SESSION' };
    if (!roleCan(user.role, 'operations:read')) {
      return { ok: false, message: MENSAJE_NO_ENCONTRADO, code: 'RESOURCE_NOT_FOUND' };
    }
    if (!roleCan(user.role, 'pii:read')) {
      return { ok: false, message: MENSAJE_SIN_PERMISO, code: 'FORBIDDEN_ROLE' };
    }
    if (!esUuidDeFormulario(piiRecordId) || !Array.isArray(campos)) {
      return { ok: false, message: MENSAJE_NO_ENCONTRADO, code: 'RESOURCE_NOT_FOUND' };
    }
    const pedidos = validarCamposARevelar(campos);
    if (!pedidos.ok) {
      return { ok: false, message: mensajeDeOperacion(pedidos.error), code: 'VALIDATION_FAILED' };
    }
    const r = await revelarPii(user, piiRecordId.toLowerCase(), pedidos.value, CONTEXTO_UI);
    if (!r.ok) {
      return { ok: false, message: mensajeDeOperacion(r.error), code: codigoDeOperacion(r.error) };
    }
    return {
      ok: true,
      message: 'Datos personales revelados. Esta consulta quedó registrada.',
      values: { ...r.value.values },
    };
  } catch (error) {
    registrarFallo('revelarPiiAction', error);
    return { ok: false, message: MENSAJE_GENERICO, code: 'INTERNAL' };
  }
}
