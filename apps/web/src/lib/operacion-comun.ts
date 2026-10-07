/**
 * Lo que comparten la capa web de Operación (V2 · Fase 8): las server actions
 * (`operacion-actions.ts`, que solo puede exportar funciones asíncronas), los loaders
 * (`operacion-server.ts`), el route handler de evidencia y las páginas/formularios.
 *
 * Sin lógica de negocio y sin dependencias de servidor (ni base de datos ni `next`): se puede importar
 * también desde componentes de cliente. Traduce códigos de error del dominio a mensajes en español para la
 * persona (nunca `details` internos, ids, rutas, trazas ni PII) y fija las capacidades que la interfaz
 * necesita para decidir qué mostrar (la autorización real sigue siendo la del caso de uso).
 */

import { type DomainErrorCode, type PiiField, type Role, roleCan } from '@tcl-kol-os/domain';
import { MENSAJE_GENERICO } from './operacion-cliente';

// Re-exportado para el servidor; los componentes de cliente importan de `operacion-cliente.ts`.
export {
  AVISO_NOTAS_SIN_PII,
  ESTADO_INICIAL,
  MENSAJE_GENERICO,
  type EstadoDeAccion,
} from './operacion-cliente';
export const MENSAJE_SESION = 'Tu sesión expiró. Inicia sesión de nuevo.';
export const MENSAJE_NO_ENCONTRADO = 'No encontramos ese elemento. Recarga la página e inténtalo de nuevo.';
export const MENSAJE_SIN_PERMISO = 'Tu rol no puede realizar esta acción.';
/** Choque de concurrencia (`stale_transition` / `stale_version`). */
export const MENSAJE_OTRA_PERSONA =
  'Otra persona cambió este registro; recarga la página e inténtalo de nuevo.';

// ─────────────────────────── Estado de una server action ───────────────────────

/** Resultado de `revelarPiiAction`: los valores existen SOLO en la respuesta de ese clic; no se guardan en el estado. */
export type ResultadoDeRevelacion =
  | { readonly ok: true; readonly message: string; readonly values: { readonly [K in PiiField]?: string } }
  | { readonly ok: false; readonly message: string; readonly code?: string };

// ─────────────────────────── Errores de dominio → texto ────────────────────────

export interface ErrorDeOperacion {
  readonly code: DomainErrorCode | string;
  readonly message: string;
  readonly details?: Readonly<Record<string, unknown>> | undefined;
}

const MOTIVOS_DE_CONFLICTO: Readonly<Record<string, string>> = {
  stale_transition: MENSAJE_OTRA_PERSONA,
  stale_version: MENSAJE_OTRA_PERSONA,
  concurrent_update:
    'Otra operación simultánea tocó el mismo registro. Recarga la página e inténtalo de nuevo.',
  idempotency_key_reused:
    'Esa solicitud ya se había enviado con otros datos. Recarga la página y vuelve a intentarlo.',
  invalid_transition: 'Ese registro ya no admite esa acción en su estado actual. Recarga la página.',
  campaign_not_active: 'La campaña no está activa: la operación es de solo lectura.',
  campaign_cancelled: 'La campaña está cancelada: no admite este registro.',
  campaign_or_participation_not_active:
    'La campaña o el influencer ya no están activos: la operación es de solo lectura.',
  participation_not_active:
    'El influencer está retirado de la campaña: su historia se conserva, pero no admite cambios.',
  // Acuerdo
  agreement_exists:
    'Esta participación ya tiene un acuerdo: registra una versión nueva en vez de crear otro.',
  agreement_cancelled: 'El acuerdo está cancelado: no admite cambios.',
  payment_reported:
    'El pago de este acuerdo ya fue reportado: no se puede cambiar el modo, el monto ni la moneda.',
  // Envíos
  preparation_failed:
    'El envío no se puede preparar: cada producto debe estar asignado al influencer y, si el acuerdo es de canje o mixto, comprometido en la versión vigente.',
  open_shipment: 'Hay un envío abierto: ciérralo o cancélalo antes de hacer este cambio.',
  // Documentos de cobro y pagos
  obligation_not_accepting_documents:
    'Solo se valida un documento de cobro de una obligación pendiente o con el pago ya reportado.',
  document_already_validated: 'Esa obligación ya tiene un documento de cobro validado.',
  document_number_in_use: 'Ya existe un documento de cobro registrado con ese número.',
  document_source_in_use: 'Ese archivo ya está registrado como otro documento de cobro.',
  live_documents: 'Hay documentos de cobro vivos: anúlalos o recházalos antes de cancelar la obligación.',
  payment_not_applicable: 'Este acuerdo es un canje puro: no genera pago, así que no hay nada que reportar.',
  payment_already_reported: 'El pago de este acuerdo ya fue reportado.',
  obligation_cancelled: 'La obligación de pago está cancelada.',
  payment_not_reported: 'Solo un pago ya reportado admite una nota de corrección.',
  // Evidencia
  evidence_already_attached: 'Ese archivo ya está adjunto a este registro.',
  hash_in_other_source:
    'Ese archivo ya existe en la campaña como otra fuente y no puede usarse como evidencia operativa.',
  already_retracted: 'Esa evidencia ya estaba retirada.',
  // PII
  pii_erased: 'Los datos personales de este registro fueron borrados.',
  duplicate_document:
    'Ese documento de identidad ya está registrado para otro influencer de la organización.',
  // KPI
  active_target_exists:
    'Ya hay un objetivo vigente para esa métrica y ámbito: reemplázalo en vez de crear otro.',
  already_superseded: 'Ese objetivo ya fue reemplazado: parte del vigente. Recarga la página.',
  target_retired: 'Ese objetivo fue retirado: fija uno nuevo sin reemplazo.',
  already_corrected: 'Esa medición ya fue corregida: corrige la versión vigente.',
  sheet_changed: 'El Sheet cambió desde que viste el KPI pactado. Recarga la página y vuelve a intentarlo.',
  // Reglas de la base (el texto original puede traer detalle interno: no se muestra)
  db_rule: 'La operación no cumple las reglas de operación vigentes. Recarga la página e inténtalo de nuevo.',
  duplicate: 'Ese registro ya existe.',
};

const RAZONES_DE_STALE: ReadonlySet<string> = new Set(['stale_transition', 'stale_version']);

function razonDe(error: ErrorDeOperacion): string | undefined {
  const razon = error.details?.['reason'];
  return typeof razon === 'string' ? razon : undefined;
}

/** Texto en español para la persona. Nunca devuelve `details`, ids, trazas ni nombres de variables de entorno. */
export function mensajeDeOperacion(error: ErrorDeOperacion): string {
  const razon = razonDe(error);
  switch (error.code) {
    case 'FORBIDDEN_ROLE':
      return MENSAJE_SIN_PERMISO;
    case 'RESOURCE_NOT_FOUND':
      return MENSAJE_NO_ENCONTRADO;
    case 'HUMAN_CONFIRMATION_REQUIRED':
      return 'Esta acción solo la hace una persona desde la interfaz: ni el chat ni el sistema pueden hacerla.';
    case 'RESOURCE_CONFLICT': {
      const conocido = razon === undefined ? undefined : MOTIVOS_DE_CONFLICTO[razon];
      if (conocido !== undefined) return conocido;
      return error.message === '' ? MENSAJE_GENERICO : error.message;
    }
    case 'VALIDATION_FAILED':
      if (razon === 'PII_NOT_CONFIGURED') {
        return 'El cifrado de datos personales no está configurado en este entorno: avisa a un administrador.';
      }
      if (razon === 'db_check') return 'Un valor no cumple las reglas de operación.';
      if (razon === 'db_reference') return 'Una referencia no existe o no pertenece a esta campaña.';
      return error.message === '' ? 'Revisa los datos del formulario.' : error.message;
    case 'UNSUPPORTED_SOURCE_FORMAT':
    case 'INVALID_SPREADSHEET':
    case 'SOURCE_ALREADY_EXISTS':
      return error.message === '' ? MENSAJE_GENERICO : error.message;
    default:
      return MENSAJE_GENERICO;
  }
}

/** Código estable para la interfaz: `STALE` unifica los dos choques de concurrencia. */
export function codigoDeOperacion(error: ErrorDeOperacion): string {
  const razon = razonDe(error);
  if (error.code === 'RESOURCE_CONFLICT' && razon !== undefined && RAZONES_DE_STALE.has(razon))
    return 'STALE';
  return String(error.code);
}

const CAMPO_DE_BASE: Readonly<Record<string, string>> = { amount: 'feeAmount', currency: 'feeCurrency' };
const FORMA_DE_CAMPO = /^[A-Za-z][A-Za-z0-9_]{0,40}$/u;

/** Campo del formulario al que apunta un error de validación (si el dominio lo indica). */
export function campoDeOperacion(error: ErrorDeOperacion): string | undefined {
  const campo = error.details?.['field'];
  if (typeof campo !== 'string' || !FORMA_DE_CAMPO.test(campo)) return undefined;
  return CAMPO_DE_BASE[campo] ?? campo;
}

// ─────────────────────────── Capacidades para la interfaz ──────────────────────

/**
 * Qué puede ver y hacer un rol en Operación. Sirve para decidir qué secciones y botones mostrar; la
 * autorización de verdad la hace cada caso de uso (un botón oculto no es un control).
 */
export interface PermisosDeOperacion {
  readonly verOperacion: boolean;
  readonly verAcuerdo: boolean;
  readonly gestionarAcuerdo: boolean;
  /** Fee, costo de envío, documentos de cobro y seguimiento de pago. */
  readonly verFinanzas: boolean;
  readonly verEnvios: boolean;
  readonly gestionarEnvios: boolean;
  /** Registrar, validar, rechazar y anular documentos de cobro; cancelar la obligación. */
  readonly gestionarFacturacion: boolean;
  readonly reportarPago: boolean;
  /** Ver QUÉ campos de PII existen (no sus valores). */
  readonly verPiiResumen: boolean;
  /** Revelar valores (acción explícita, auditada). */
  readonly revelarPii: boolean;
  readonly gestionarPii: boolean;
  readonly adjuntarEvidencia: boolean;
  readonly verContenido: boolean;
  readonly verKpi: boolean;
  /** Fijar, reemplazar y retirar objetivos; ver el KPI pactado en el Sheet. */
  readonly gestionarObjetivosKpi: boolean;
  readonly medirKpi: boolean;
}

export function permisosDeOperacion(role: Role): PermisosDeOperacion {
  return {
    verOperacion: roleCan(role, 'operations:read'),
    verAcuerdo: roleCan(role, 'agreement:read'),
    gestionarAcuerdo: roleCan(role, 'agreement:manage'),
    verFinanzas: roleCan(role, 'finance:read'),
    verEnvios: roleCan(role, 'shipment:read'),
    gestionarEnvios: roleCan(role, 'shipment:manage'),
    gestionarFacturacion: roleCan(role, 'billing:manage'),
    reportarPago: roleCan(role, 'payment:report'),
    verPiiResumen: roleCan(role, 'pii:read') || roleCan(role, 'pii:manage'),
    revelarPii: roleCan(role, 'pii:read'),
    gestionarPii: roleCan(role, 'pii:manage'),
    adjuntarEvidencia: roleCan(role, 'ops_evidence:attach'),
    verContenido: roleCan(role, 'deliverable:read'),
    verKpi: roleCan(role, 'kpi:read'),
    gestionarObjetivosKpi: roleCan(role, 'kpi:target_manage'),
    medirKpi: roleCan(role, 'kpi:measure'),
  };
}
