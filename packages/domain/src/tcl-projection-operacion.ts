/**
 * Contrato de la proyección de la operación para TCL (V2 · Fase 8 → Fase 9, DEC-049).
 *
 * SOLO CONTRATO: no hay ruta, acceso ni capacidad aquí. La Fase 9 (dashboard TCL) decidirá qué rol y qué ruta
 * la sirven (capacidad propia, espejo de `source:read_shared`; `kpi:read_client` sigue reservada y sin asignar).
 * Este módulo fija QUÉ forma tiene lo que TCL podría ver y, sobre todo, lo que NUNCA puede contener.
 *
 * Por participación: si el producto fue recibido (sí / no / parcial), el estado del guion aprobado, producción
 * y publicación (`desconocido` hasta que se defina su fuente) y los KPI `{metric, unit, target, actual,
 * achievement}`. Nada de dinero, acuerdo, facturación, pagos, costos de envío, tracking, notas, evidencia,
 * procedencia ni datos personales.
 *
 * Mecanismo: `proyectarOperacionParaTcl` construye el objeto SOLO a partir de campos de una entrada pública
 * explícita (lista blanca por construcción: nunca copia ni propaga claves de la entrada). Además, la salida se
 * verifica contra `CLAVES_PROHIBIDAS_TCL` en cualquier nivel de anidación.
 */

// ─────────────────────────── Claves prohibidas ─────────────────────────────────

/**
 * Términos que NINGUNA clave de la proyección puede contener (comparación sin mayúsculas ni separadores y por
 * subcadena: `shipping_cost`, `shippingCost` y `ShippingCOST` coinciden con `shipping` y con `cost`).
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
] as const;

const NORMALIZADAS: readonly string[] = CLAVES_PROHIBIDAS_TCL.map(normalizarClave);

function normalizarClave(clave: string): string {
  return clave.toLowerCase().replace(/[^a-z0-9]/gu, '');
}

/** ¿Esta clave contiene un término prohibido? */
export function esClaveProhibidaTcl(clave: string): boolean {
  const n = normalizarClave(clave);
  return NORMALIZADAS.some((p) => n.includes(p));
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

/** Dato cuya fuente aún no está definida (producción y publicación): se declara, no se inventa. */
export type Desconocido = 'desconocido';

export interface KpiParaTcl {
  readonly metric: string;
  readonly unit: string;
  readonly target: number;
  /** `null` sin medición. */
  readonly actual: number | null;
  /** Porcentaje de cumplimiento (`actual / target` ya calculado por KPI) o `null` si no es comparable. */
  readonly achievement: number | null;
}

export interface ProyeccionTclDeOperacion {
  readonly participacionId: string;
  /** Nombre visible del influencer (texto de una persona: NO CONFIABLE al renderizarlo). */
  readonly nombreVisible: string;
  readonly productoRecibido: ProductoRecibidoParaTcl;
  readonly guion: {
    readonly estado: EstadoDeGuionParaTcl;
    readonly aprobados: number;
    readonly total: number;
  };
  readonly produccion: Desconocido;
  readonly publicacion: Desconocido;
  readonly kpis: readonly KpiParaTcl[];
}

// ─────────────────────────── Entrada pública ───────────────────────────────────

/**
 * ÚNICA entrada aceptada: campos ya públicos. Quien la arme (Fase 9) es responsable de no incluir nada más;
 * aun si lo hiciera, la función solo lee los campos de esta lista.
 */
export interface EntradaPublicaDeOperacionParaTcl {
  readonly participacionId: string;
  readonly nombreVisible: string;
  /** Unidades comprometidas y entregadas del conjunto de productos de la participación. */
  readonly unidadesComprometidas: number;
  readonly unidadesEntregadas: number;
  /** Entregables activos y los que tienen un guion aprobado vigente. */
  readonly entregablesTotales: number;
  readonly entregablesConGuionAprobado: number;
  readonly kpis: ReadonlyArray<{
    readonly metric: string;
    readonly unit: string;
    readonly target: number;
    readonly actual: number | null;
    readonly achievement: number | null;
  }>;
}

function entero(valor: unknown): number {
  return typeof valor === 'number' && Number.isFinite(valor) && valor > 0 ? Math.trunc(valor) : 0;
}

function numeroOCero(valor: unknown): number {
  return typeof valor === 'number' && Number.isFinite(valor) ? valor : 0;
}

function numeroONulo(valor: unknown): number | null {
  return typeof valor === 'number' && Number.isFinite(valor) ? valor : null;
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
 * Construye la proyección SOLO con los campos de la entrada pública, uno por uno. Lo que sobre en la entrada
 * (aunque sea `fee`, `address` o cualquier otra clave) no se copia. Verifica además que la salida no tenga
 * ninguna clave prohibida: si alguien amplía el contrato con una clave así, esta función falla en vez de filtrar.
 */
export function proyectarOperacionParaTcl(
  entrada: EntradaPublicaDeOperacionParaTcl,
): ProyeccionTclDeOperacion {
  const total = entero(entrada.entregablesTotales);
  const aprobados = Math.min(entero(entrada.entregablesConGuionAprobado), total);
  const kpis: KpiParaTcl[] = (Array.isArray(entrada.kpis) ? entrada.kpis : []).map((k) => ({
    metric: String(k.metric),
    unit: String(k.unit),
    target: numeroOCero(k.target),
    actual: numeroONulo(k.actual),
    achievement: numeroONulo(k.achievement),
  }));
  const proyeccion: ProyeccionTclDeOperacion = {
    participacionId: String(entrada.participacionId),
    nombreVisible: String(entrada.nombreVisible),
    productoRecibido: derivarProductoRecibido(entrada.unidadesComprometidas, entrada.unidadesEntregadas),
    guion: { estado: derivarEstadoDeGuionParaTcl(total, aprobados), aprobados, total },
    produccion: 'desconocido',
    publicacion: 'desconocido',
    kpis,
  };
  const prohibidas = clavesProhibidasEn(proyeccion);
  if (prohibidas.length > 0) {
    throw new Error(`La proyección de TCL contiene claves prohibidas: ${prohibidas.join(', ')}`);
  }
  return proyeccion;
}
