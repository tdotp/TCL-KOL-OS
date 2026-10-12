/**
 * Contrato de la proyección de la operación para TCL (V2 · Fase 8 → Fase 9, DEC-049 / DEC-050).
 *
 * Fase 9: lo sirve el dashboard TCL (`packages/db/src/tcl-projection.ts`) al rol `cliente` con la capacidad
 * `operations:read_summary_client`. Este módulo fija QUÉ forma tiene lo que TCL ve de la operación y, sobre todo,
 * lo que NUNCA puede contener.
 *
 * Por participación: etapa (`pendiente | en_curso | listo`), si el producto fue recibido (sí / no / parcial),
 * el estado del guion aprobado y producción/publicación (`no_disponible`: no existe ese dominio; no se simula).
 * Los KPI viven en su propia proyección (`KpiTcl`), no aquí. Nada de dinero, acuerdo, modo de compensación,
 * facturación, pagos, costos de envío, tracking, notas, evidencia, procedencia ni datos personales.
 *
 * Mecanismo: `proyectarOperacionParaTcl` construye el objeto SOLO a partir de campos de una entrada pública
 * explícita (lista blanca por construcción: nunca copia ni propaga claves de la entrada). Además, la salida se
 * verifica contra `CLAVES_PROHIBIDAS_TCL` en cualquier nivel de anidación.
 *
 * Comprobación de claves (Fase 9): se hace por COINCIDENCIA DE TOKEN, no por subcadena. Una clave se divide en
 * tokens (camelCase, snake_case, kebab-case, espacios; sin acentos ni mayúsculas) y es prohibida si ALGÚN token
 * es un término prohibido (`shippingCost` → `shipping`, `cost`; `Tracking-Ref` → `tracking`). Así los nombres
 * legítimos no dan falsos positivos por subcadena (`documentos` no contiene el token `document`; `hashtag` no es
 * `hash`; `smartphone` no es `phone`; `preferencias` no es `reference`). Para claves pegadas en minúsculas
 * (`shippingcost`), un token largo que EMPIEZA o TERMINA con un término distintivo (≥ 5 letras) también cuenta,
 * salvo la lista corta `TOKENS_LEGITIMOS`. Es una defensa de último recurso: la protección real es que cada DTO
 * se construye campo por campo (nunca se copian claves de la entrada).
 */

import { esTextoSeguroParaTcl } from './tcl-text-safety';

// ─────────────────────────── Claves prohibidas ─────────────────────────────────

/**
 * Términos que NINGUNA clave de la proyección puede contener como TOKEN (ver la nota de cabecera):
 * `shipping_cost`, `shippingCost` y `ShippingCOST` coinciden con `shipping` y con `cost`.
 */
export const CLAVES_PROHIBIDAS_TCL: readonly string[] = [
  // dinero y facturación
  'fee',
  'amount',
  'currency',
  'price',
  'cost',
  'tarifa',
  'costo',
  'invoice',
  'billing',
  'factura',
  'cobro',
  'payment',
  'pago',
  'finance',
  'bank',
  'banco',
  // acuerdo
  'agreement',
  'acuerdo',
  'compensation',
  'barter',
  'canje',
  // logística interna y datos personales
  'shipping',
  'shipment',
  'envio',
  'tracking',
  'carrier',
  'transportadora',
  'address',
  'direccion',
  'phone',
  'telefono',
  'cedula',
  'email',
  'pii',
  // documentos, notas, evidencia y procedencia
  'document',
  'note',
  'nota',
  'evidence',
  'evidencia',
  'provenance',
  'procedencia',
  'filename',
  'hash',
  'locator',
  'idempotency',
  'reference',
  // plurales y variantes frecuentes (la comparación es por token exacto)
  'fees',
  'amounts',
  'prices',
  'costs',
  'costos',
  'invoices',
  'payments',
  'pagos',
  'facturas',
  'tarifas',
  'agreements',
  'acuerdos',
  'addresses',
  'phones',
  'emails',
  'documents',
  'notes',
  'notas',
  'references',
  'shipments',
  'envios',
  'cedulas',
] as const;

/**
 * Tokens que EMPIEZAN o TERMINAN con un término prohibido pero son legítimos. Solo se consulta en la
 * defensa de último recurso para claves pegadas (ver la nota de cabecera).
 */
const TOKENS_LEGITIMOS: ReadonlySet<string> = new Set([
  'documento',
  'documentos',
  'preference',
  'preferences',
  'preferencia',
  'preferencias',
  'smartphone',
  'smartphones',
  'telephone',
  'headphones',
  'hashtag',
  'hashtags',
  'notebook',
  'notebooks',
  'notification',
  'notifications',
  'notificacion',
  'notificaciones',
]);

/** Términos de al menos 5 letras: solo estos activan la comprobación de prefijo/sufijo de claves pegadas. */
const DISTINTIVOS: readonly string[] = CLAVES_PROHIBIDAS_TCL.filter((t) => t.length >= 5);

function quitarAcentos(texto: string): string {
  return texto.normalize('NFD').replace(/\p{M}/gu, '');
}

/** `claimedAmount` → [`claimed`, `amount`]; `Tracking-Ref` → [`tracking`, `ref`]; sin acentos y en minúsculas. */
function tokensDeClave(clave: string): string[] {
  return quitarAcentos(clave)
    .replace(/([a-z0-9])([A-Z])/gu, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/gu, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .filter((t) => t !== '');
}

const PROHIBIDAS: ReadonlySet<string> = new Set(CLAVES_PROHIBIDAS_TCL);

/** ¿Esta clave contiene un término prohibido como token (o como prefijo/sufijo de un token pegado)? */
export function esClaveProhibidaTcl(clave: string): boolean {
  return tokensDeClave(clave).some((t) => {
    if (PROHIBIDAS.has(t)) return true;
    if (t.length < 6 || TOKENS_LEGITIMOS.has(t)) return false;
    return DISTINTIVOS.some((p) => t.length > p.length && (t.startsWith(p) || t.endsWith(p)));
  });
}

/**
 * Rutas (`a.b[0].c`) de todas las claves prohibidas en cualquier nivel de un valor (objetos y arreglos).
 * Lista vacía ⇒ el valor es seguro para TCL en cuanto a nombres de clave.
 */
export function clavesProhibidasEn(valor: unknown, ruta = ''): string[] {
  const halladas: string[] = [];
  if (Array.isArray(valor)) {
    valor.forEach((v, i) => halladas.push(...clavesProhibidasEn(v, `${ruta}[${i}]`)));
    return halladas;
  }
  if (typeof valor === 'object' && valor !== null) {
    for (const [clave, v] of Object.entries(valor)) {
      const camino = ruta === '' ? clave : `${ruta}.${clave}`;
      if (esClaveProhibidaTcl(clave)) halladas.push(camino);
      halladas.push(...clavesProhibidasEn(v, camino));
    }
  }
  return halladas;
}

// ─────────────────────────── Contrato de salida ────────────────────────────────

export type ProductoRecibidoParaTcl = 'si' | 'no' | 'parcial';

export type EstadoDeGuionParaTcl = 'sin_entregables' | 'pendiente' | 'parcial' | 'aprobado';

/** Etapa de la participación para TCL: TRES valores; todo estado interno colapsa a uno de ellos. */
export type EtapaParaTcl = 'pendiente' | 'en_curso' | 'listo';

/** Dominio que aún no existe (producción y publicación): se declara, no se inventa ni se simula. */
export type NoDisponible = 'no_disponible';

export interface ProyeccionTclDeOperacion {
  readonly participacionId: string;
  /** Nombre visible del influencer (texto de una persona: NO CONFIABLE al renderizarlo). `null` si no es seguro. */
  readonly nombreVisible: string | null;
  readonly etapa: EtapaParaTcl;
  readonly productoRecibido: ProductoRecibidoParaTcl;
  readonly guion: {
    readonly estado: EstadoDeGuionParaTcl;
    readonly aprobados: number;
    readonly total: number;
  };
  readonly produccion: NoDisponible;
  readonly publicacion: NoDisponible;
}

// ─────────────────────────── Entrada pública ───────────────────────────────────

/**
 * ÚNICA entrada aceptada: campos ya públicos. Quien la arme es responsable de no incluir nada más; aun si lo
 * hiciera, la función solo lee los campos de esta lista.
 */
export interface EntradaPublicaDeOperacionParaTcl {
  readonly participacionId: string;
  readonly nombreVisible: string;
  /** Unidades comprometidas y entregadas del conjunto de productos de la participación. */
  readonly unidadesComprometidas: number;
  readonly unidadesEntregadas: number;
  /** ¿Hay algún envío abierto (pendiente, preparado o en tránsito)? Solo alimenta la etapa; no sale. */
  readonly hayEnvioAbierto: boolean;
  /** Entregables activos y los que tienen un guion aprobado vigente. */
  readonly entregablesTotales: number;
  readonly entregablesConGuionAprobado: number;
}

function entero(valor: unknown): number {
  return typeof valor === 'number' && Number.isFinite(valor) && valor > 0 ? Math.trunc(valor) : 0;
}

/** sí = llegó todo lo comprometido (o algo sin compromiso); parcial = llegó algo; no = nada entregado. */
export function derivarProductoRecibido(comprometidas: number, entregadas: number): ProductoRecibidoParaTcl {
  const c = entero(comprometidas);
  const e = entero(entregadas);
  if (e === 0) return 'no';
  return c > 0 && e < c ? 'parcial' : 'si';
}

export function derivarEstadoDeGuionParaTcl(total: number, aprobados: number): EstadoDeGuionParaTcl {
  const t = entero(total);
  const a = Math.min(entero(aprobados), t);
  if (t === 0) return 'sin_entregables';
  if (a === 0) return 'pendiente';
  return a === t ? 'aprobado' : 'parcial';
}

/**
 * Etapa para TCL (tres valores). `listo`: el guion está aprobado en todos los entregables Y el producto llegó
 * (o no hay producto que enviar). `pendiente`: nada ha avanzado (sin guion aprobado, sin envío abierto ni
 * producto recibido). Todo lo demás: `en_curso`. Solo mira banderas públicas; el detalle de logística o de
 * contenido interno no influye ni sale.
 */
export function derivarEtapaParaTcl(entrada: {
  readonly unidadesComprometidas: number;
  readonly unidadesEntregadas: number;
  readonly hayEnvioAbierto: boolean;
  readonly entregablesTotales: number;
  readonly entregablesConGuionAprobado: number;
}): EtapaParaTcl {
  const comprometidas = entero(entrada.unidadesComprometidas);
  const entregadas = entero(entrada.unidadesEntregadas);
  const guion = derivarEstadoDeGuionParaTcl(entrada.entregablesTotales, entrada.entregablesConGuionAprobado);
  const productoResuelto =
    (comprometidas === 0 && entregadas === 0) || derivarProductoRecibido(comprometidas, entregadas) === 'si';
  if (guion === 'aprobado' && productoResuelto) return 'listo';
  const sinAvance =
    (guion === 'sin_entregables' || guion === 'pendiente') &&
    entregadas === 0 &&
    entrada.hayEnvioAbierto !== true;
  return sinAvance ? 'pendiente' : 'en_curso';
}

/** Hasta este largo un nombre se considera un nombre; más largo, no es un nombre (se omite). */
const LARGO_MAXIMO_DE_NOMBRE = 200;

/**
 * Construye la proyección SOLO con los campos de la entrada pública, uno por uno. Lo que sobre en la entrada
 * (aunque sea `fee`, `address` o cualquier otra clave) no se copia. El nombre visible pasa por la política de
 * texto seguro de TCL (si no es seguro, el campo completo se omite: `null`). Verifica además que la salida no
 * tenga ninguna clave prohibida: si alguien amplía el contrato con una clave así, esta función falla en vez de filtrar.
 */
export function proyectarOperacionParaTcl(
  entrada: EntradaPublicaDeOperacionParaTcl,
): ProyeccionTclDeOperacion {
  const total = entero(entrada.entregablesTotales);
  const aprobados = Math.min(entero(entrada.entregablesConGuionAprobado), total);
  const nombre = typeof entrada.nombreVisible === 'string' ? entrada.nombreVisible.trim() : '';
  const proyeccion: ProyeccionTclDeOperacion = {
    participacionId: String(entrada.participacionId),
    nombreVisible:
      nombre !== '' && nombre.length <= LARGO_MAXIMO_DE_NOMBRE && esTextoSeguroParaTcl(nombre)
        ? nombre
        : null,
    etapa: derivarEtapaParaTcl(entrada),
    productoRecibido: derivarProductoRecibido(entrada.unidadesComprometidas, entrada.unidadesEntregadas),
    guion: { estado: derivarEstadoDeGuionParaTcl(total, aprobados), aprobados, total },
    produccion: 'no_disponible',
    publicacion: 'no_disponible',
  };
  const prohibidas = clavesProhibidasEn(proyeccion);
  if (prohibidas.length > 0) {
    throw new Error(`La proyección de TCL contiene claves prohibidas: ${prohibidas.join(', ')}`);
  }
  return proyeccion;
}
