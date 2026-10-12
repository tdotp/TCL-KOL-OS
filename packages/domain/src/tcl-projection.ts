/**
 * Proyección TCL (V2 · Fase 9, DEC-050): contrato CERRADO de lo que el dashboard de TCL puede ver.
 *
 *   dominio interno → PROYECCIÓN del servidor (lista blanca, campo por campo) → DTO cliente → UI y export
 *
 * TCL nunca recibe una entidad interna ni un read model interno «con menos campos». Cada DTO se construye
 * LITERAL, campo por campo, desde una ENTRADA PÚBLICA explícita (nunca `{...x}` + `delete`); lo que sobre en la
 * entrada no se copia. Cada campo responde «¿por qué lo necesita TCL?» (ver `docs/product/TCL_DASHBOARD_V2.md` §4).
 *
 * Este módulo es PURO: no consulta nada. Las consultas viven en `packages/db/src/tcl-projection.ts`, que arma las
 * entradas públicas y llama a estos constructores.
 *
 * Defensas (todas del lado del servidor; no se confía en visibilidad de fuente ni en filtros de UI):
 *   1. lista blanca de campos de cada DTO (`CLAVES_DE_DTO_TCL`) y de claves del catálogo del Brief;
 *   2. `esTextoSeguroParaTcl` sobre TODO texto libre: ante un hallazgo se OMITE el campo completo;
 *   3. estados internos colapsados a valores mínimos (`en_curso | finalizada`, `aprobado | pendiente`,
 *      `pendiente | en_curso | listo`, `cumplido | por_debajo | sin_medicion`);
 *   4. `asegurarProyeccionTcl`: ninguna clave de la salida es prohibida (comprobación por token).
 */

import { campoDelCatalogo } from './brief-catalog';
import { type KpiMetric, isKpiComparator, isKpiMetric, unidadDeMetrica } from './kpi-metrics';
import { type ProyeccionTclDeOperacion, clavesProhibidasEn } from './tcl-projection-operacion';
import { textoParaTcl } from './tcl-text-safety';

export { esTextoSeguroParaTcl, categoriasDeTextoInseguroParaTcl, textoParaTcl } from './tcl-text-safety';
export type { CategoriaDeTextoInseguro } from './tcl-text-safety';

// ─────────────────────────── Lista blanca de claves por DTO ────────────────────

/**
 * Claves EXACTAS de cada DTO. Una prueba compara las claves reales de cada objeto producido con esta lista:
 * añadir un campo a un DTO exige tocar esta lista (y, con ella, la revisión de seguridad).
 */
export const CLAVES_DE_DTO_TCL = {
  campanaLista: ['id', 'nombre', 'mercado', 'categoria', 'fechaInicio', 'fechaFin', 'estado'],
  campanaDetalle: [
    'id',
    'nombre',
    'mercado',
    'categoria',
    'fechaInicio',
    'fechaFin',
    'estado',
    'conteos',
    'productos',
  ],
  conteos: ['influencersActivos', 'guionesAprobados', 'guionesTotales', 'kpiCumplidos', 'kpiTotales'],
  producto: ['marca', 'modelo', 'categoria'],
  cuenta: ['plataforma', 'handle'],
  influencer: [
    'participacionId',
    'nombreVisible',
    'cuentas',
    'productos',
    'etapa',
    'productoRecibido',
    'guion',
    'kpis',
  ],
  guion: ['estado', 'aprobados', 'total'],
  kpi: [
    'metrica',
    'unidad',
    'comparador',
    'objetivo',
    'resultado',
    'cumplimiento',
    'estado',
    'plataforma',
    'fecha',
  ],
  kpiPorParticipacion: ['participacionId', 'nombreVisible', 'kpis'],
  contenido: ['participacionId', 'entregable', 'estado', 'aprobadoEl'],
  entregable: ['id', 'etiqueta', 'plataforma', 'producto'],
  operacion: [
    'participacionId',
    'nombreVisible',
    'etapa',
    'productoRecibido',
    'guion',
    'produccion',
    'publicacion',
  ],
  brief: ['version', 'aprobadoEl', 'idiomaOriginal', 'representaciones'],
  briefRepresentacion: ['idioma', 'campos'],
  briefCampo: ['clave', 'etiqueta', 'bloque', 'producto', 'texto', 'items'],
  briefProducto: ['marca', 'modelo'],
  documento: ['sourceId', 'titulo', 'tipo', 'idioma', 'fecha'],
  proyeccion: ['campana', 'influencers', 'contenido', 'brief', 'operacion', 'kpis', 'documentos'],
} as const satisfies Readonly<Record<string, readonly string[]>>;

export type NombreDeDtoTcl = keyof typeof CLAVES_DE_DTO_TCL;

// ─────────────────────────── Estados client-safe ───────────────────────────────

/** `activa` → en curso; todo lo demás visible (`archivada`) → finalizada. `cancelada` nunca llega aquí. */
export type EstadoDeCampanaParaTcl = 'en_curso' | 'finalizada';

export function estadoDeCampanaParaTcl(estadoInterno: unknown): EstadoDeCampanaParaTcl {
  return estadoInterno === 'activa' ? 'en_curso' : 'finalizada';
}

/** Un guion está `aprobado` solo si hay una fila `approved`; todo lo demás es `pendiente` sin más rastro. */
export type EstadoDeContenidoParaTcl = 'aprobado' | 'pendiente';

export function estadoDeContenidoParaTcl(estadoInterno: unknown): EstadoDeContenidoParaTcl {
  return estadoInterno === 'approved' ? 'aprobado' : 'pendiente';
}

export type EstadoDeKpiParaTcl = 'cumplido' | 'por_debajo' | 'sin_medicion';

/** `no_comparable` y `sin_medicion` colapsan en `sin_medicion` (no se revela por qué no hay cifra). */
export function estadoDeKpiParaTcl(estadoInterno: unknown): EstadoDeKpiParaTcl {
  if (estadoInterno === 'cumplido') return 'cumplido';
  if (estadoInterno === 'por_debajo') return 'por_debajo';
  return 'sin_medicion';
}

// ─────────────────────────── Utilidades ────────────────────────────────────────

const FECHA = /^\d{4}-\d{2}-\d{2}$/u;

/** `YYYY-MM-DD` o `null` (acepta una marca de tiempo ISO y la reduce a su fecha). */
export function fechaParaTcl(valor: unknown): string | null {
  if (typeof valor !== 'string') return null;
  const dia = valor.length >= 10 ? valor.slice(0, 10) : valor;
  return FECHA.test(dia) ? dia : null;
}

/** Marca de tiempo ISO válida o `null`. */
function instanteParaTcl(valor: unknown): string | null {
  if (typeof valor !== 'string') return null;
  const t = Date.parse(valor);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

function enteroNoNegativo(valor: unknown): number {
  return typeof valor === 'number' && Number.isFinite(valor) && valor > 0 ? Math.trunc(valor) : 0;
}

function numeroONulo(valor: unknown): number | null {
  return typeof valor === 'number' && Number.isFinite(valor) ? valor : null;
}

// ─────────────────────────── Producto ──────────────────────────────────────────

export interface ProductoTcl {
  /** Marca y modelo son texto del catálogo; `null` si no pasan la política de texto seguro. */
  readonly marca: string | null;
  readonly modelo: string | null;
  readonly categoria: string | null;
}

export interface EntradaDeProductoParaTcl {
  readonly marca: unknown;
  readonly modelo: unknown;
  readonly categoria: unknown;
}

export function proyectarProductoParaTcl(e: EntradaDeProductoParaTcl): ProductoTcl {
  return {
    marca: textoParaTcl(e.marca, 120),
    modelo: textoParaTcl(e.modelo, 120),
    categoria: textoParaTcl(e.categoria, 120),
  };
}

// ─────────────────────────── Campaña (lista y detalle) ─────────────────────────

/** Lista de campañas. Sin owner, presupuesto, confidencialidad ni visibilidad. */
export interface CampanaListaTcl {
  readonly id: string;
  readonly nombre: string | null;
  readonly mercado: string | null;
  readonly categoria: string | null;
  readonly fechaInicio: string | null;
  readonly fechaFin: string | null;
  readonly estado: EstadoDeCampanaParaTcl;
}

export interface EntradaDeCampanaParaTcl {
  readonly id: string;
  readonly nombre: unknown;
  readonly mercado: unknown;
  readonly categoria: unknown;
  readonly fechaInicio: unknown;
  readonly fechaFin: unknown;
  /** Estado interno de la campaña (`activa`, `archivada`…): se colapsa. */
  readonly estadoInterno: unknown;
}

export function proyectarCampanaListaParaTcl(e: EntradaDeCampanaParaTcl): CampanaListaTcl {
  return {
    id: String(e.id),
    nombre: textoParaTcl(e.nombre, 200),
    mercado: textoParaTcl(e.mercado, 80),
    categoria: textoParaTcl(e.categoria, 120),
    fechaInicio: fechaParaTcl(e.fechaInicio),
    fechaFin: fechaParaTcl(e.fechaFin),
    estado: estadoDeCampanaParaTcl(e.estadoInterno),
  };
}

export interface ConteosDeCampanaTcl {
  readonly influencersActivos: number;
  readonly guionesAprobados: number;
  readonly guionesTotales: number;
  readonly kpiCumplidos: number;
  readonly kpiTotales: number;
}

/** Detalle: lo de la lista + conteos + productos. Sin owner, presupuesto, confidencialidad ni visibilidad. */
export interface CampanaDetalleTcl {
  readonly id: string;
  readonly nombre: string | null;
  readonly mercado: string | null;
  readonly categoria: string | null;
  readonly fechaInicio: string | null;
  readonly fechaFin: string | null;
  readonly estado: EstadoDeCampanaParaTcl;
  readonly conteos: ConteosDeCampanaTcl;
  readonly productos: readonly ProductoTcl[];
}

export interface EntradaDeDetalleDeCampanaParaTcl extends EntradaDeCampanaParaTcl {
  readonly influencersActivos: number;
  readonly guionesAprobados: number;
  readonly guionesTotales: number;
  readonly kpiCumplidos: number;
  readonly kpiTotales: number;
  readonly productos: readonly EntradaDeProductoParaTcl[];
}

export function proyectarCampanaDetalleParaTcl(e: EntradaDeDetalleDeCampanaParaTcl): CampanaDetalleTcl {
  const guionesTotales = enteroNoNegativo(e.guionesTotales);
  const kpiTotales = enteroNoNegativo(e.kpiTotales);
  return {
    id: String(e.id),
    nombre: textoParaTcl(e.nombre, 200),
    mercado: textoParaTcl(e.mercado, 80),
    categoria: textoParaTcl(e.categoria, 120),
    fechaInicio: fechaParaTcl(e.fechaInicio),
    fechaFin: fechaParaTcl(e.fechaFin),
    estado: estadoDeCampanaParaTcl(e.estadoInterno),
    conteos: {
      influencersActivos: enteroNoNegativo(e.influencersActivos),
      guionesAprobados: Math.min(enteroNoNegativo(e.guionesAprobados), guionesTotales),
      guionesTotales,
      kpiCumplidos: Math.min(enteroNoNegativo(e.kpiCumplidos), kpiTotales),
      kpiTotales,
    },
    productos: (Array.isArray(e.productos) ? e.productos : []).map(proyectarProductoParaTcl),
  };
}

// ─────────────────────────── KPI ───────────────────────────────────────────────

export type MetricaDeKpiParaTcl = Exclude<KpiMetric, 'other'>;

export interface KpiTcl {
  readonly metrica: MetricaDeKpiParaTcl;
  readonly unidad: 'count' | 'percent';
  readonly comparador: 'gte' | 'lte';
  readonly objetivo: number;
  /** `null` sin medición comparable. */
  readonly resultado: number | null;
  /** Porcentaje de cumplimiento (actual / objetivo · 100) o `null`. */
  readonly cumplimiento: number | null;
  readonly estado: EstadoDeKpiParaTcl;
  /** Plataforma del ámbito del KPI (`instagram`, `tiktok`…) o `null` = participación entera. */
  readonly plataforma: string | null;
  /** Fecha (`YYYY-MM-DD`) de la medición comparada. */
  readonly fecha: string | null;
}

/** Entrada: el bloque `public` de `obtenerKpiDeParticipacion` (lo ÚNICO apto; `internal` nunca llega aquí). */
export interface EntradaDeKpiParaTcl {
  readonly metric: unknown;
  readonly unit: unknown;
  readonly comparator: unknown;
  readonly target: unknown;
  readonly actual: unknown;
  readonly achievement: unknown;
  readonly estado: unknown;
  readonly platform: unknown;
  readonly observedAt: unknown;
}

/**
 * KPI para TCL, o `null` si no debe salir: la métrica `other` (su etiqueta es texto libre y nunca se compara), una
 * métrica fuera del catálogo, una unidad distinta de la del catálogo (incompatible) o un objetivo no numérico.
 * Sin medición comparable el resultado y el cumplimiento son `null` (no se revela por qué).
 */
export function proyectarKpiParaTcl(e: EntradaDeKpiParaTcl): KpiTcl | null {
  if (!isKpiMetric(e.metric) || e.metric === 'other') return null;
  const unidad = unidadDeMetrica(e.metric);
  if (e.unit !== unidad || unidad === 'other') return null;
  if (!isKpiComparator(e.comparator)) return null;
  const objetivo = numeroONulo(e.target);
  if (objetivo === null) return null;
  const estadoInterno = estadoDeKpiParaTcl(e.estado);
  const resultado = numeroONulo(e.actual);
  const conCifras = estadoInterno !== 'sin_medicion' && resultado !== null;
  const plataforma = typeof e.platform === 'string' && /^[a-z]{1,20}$/u.test(e.platform) ? e.platform : null;
  return {
    metrica: e.metric,
    unidad,
    comparador: e.comparator,
    objetivo,
    resultado: conCifras ? resultado : null,
    cumplimiento: conCifras ? numeroONulo(e.achievement) : null,
    estado: conCifras ? estadoInterno : 'sin_medicion',
    plataforma,
    fecha: conCifras ? fechaParaTcl(e.observedAt) : null,
  };
}

export interface KpiPorParticipacionTcl {
  readonly participacionId: string;
  readonly nombreVisible: string | null;
  readonly kpis: readonly KpiTcl[];
}

// ─────────────────────────── Influencers ───────────────────────────────────────

export interface CuentaTcl {
  /** Plataforma social (enumeración cerrada: `instagram`, `tiktok`…). */
  readonly plataforma: string;
  /** Handle público de la cuenta; `null` si no pasa la política de texto seguro. */
  readonly handle: string | null;
}

/** Influencer de la campaña. Sin `influencerId`, PII, acuerdo ni dinero. */
export interface InfluencerTcl {
  readonly participacionId: string;
  readonly nombreVisible: string | null;
  readonly cuentas: readonly CuentaTcl[];
  readonly productos: readonly ProductoTcl[];
  readonly etapa: ProyeccionTclDeOperacion['etapa'];
  readonly productoRecibido: ProyeccionTclDeOperacion['productoRecibido'];
  readonly guion: ProyeccionTclDeOperacion['guion'];
  readonly kpis: readonly KpiTcl[];
}

export interface EntradaDeInfluencerParaTcl {
  readonly operacion: ProyeccionTclDeOperacion;
  readonly cuentas: ReadonlyArray<{ readonly plataforma: unknown; readonly handle: unknown }>;
  readonly productos: readonly EntradaDeProductoParaTcl[];
  readonly kpis: readonly KpiTcl[];
}

const PLATAFORMA = /^[a-z]{1,20}$/u;

/** Se construye a partir de la MISMA proyección operativa (no recalcula etapa, producto ni guion). */
export function proyectarInfluencerParaTcl(e: EntradaDeInfluencerParaTcl): InfluencerTcl {
  const op = e.operacion;
  return {
    participacionId: op.participacionId,
    nombreVisible: op.nombreVisible,
    cuentas: (Array.isArray(e.cuentas) ? e.cuentas : [])
      .filter((c) => typeof c.plataforma === 'string' && PLATAFORMA.test(c.plataforma))
      .map((c) => ({ plataforma: String(c.plataforma), handle: textoParaTcl(c.handle, 100) })),
    productos: (Array.isArray(e.productos) ? e.productos : []).map(proyectarProductoParaTcl),
    etapa: op.etapa,
    productoRecibido: op.productoRecibido,
    guion: { estado: op.guion.estado, aprobados: op.guion.aprobados, total: op.guion.total },
    kpis: e.kpis.map((k) => ({
      metrica: k.metrica,
      unidad: k.unidad,
      comparador: k.comparador,
      objetivo: k.objetivo,
      resultado: k.resultado,
      cumplimiento: k.cumplimiento,
      estado: k.estado,
      plataforma: k.plataforma,
      fecha: k.fecha,
    })),
  };
}

// ─────────────────────────── Contenido aprobado ────────────────────────────────

export interface EntregableTcl {
  readonly id: string;
  readonly etiqueta: string | null;
  readonly plataforma: string | null;
  readonly producto: ProductoTcl | null;
}

/**
 * Entregable y estado de su guion. Solo existe el estado `aprobado` (fila `approved` vigente) o `pendiente`:
 * borradores, en revisión, con cambios solicitados y reemplazados NO se distinguen ni dejan rastro. Sin
 * versión, texto, hallazgos, comentarios ni análisis.
 */
export interface ContenidoAprobadoTcl {
  readonly participacionId: string;
  readonly entregable: EntregableTcl;
  readonly estado: EstadoDeContenidoParaTcl;
  readonly aprobadoEl: string | null;
}

export interface EntradaDeContenidoParaTcl {
  readonly participacionId: string;
  readonly entregableId: string;
  readonly etiqueta: unknown;
  readonly plataforma: unknown;
  readonly producto: EntradaDeProductoParaTcl | null;
  /** Estado de la versión APROBADA del entregable (`approved`) o `null` si no hay ninguna fila aprobada. */
  readonly estadoDeLaVersionAprobada: unknown;
  readonly aprobadoEl: unknown;
}

export function proyectarContenidoParaTcl(e: EntradaDeContenidoParaTcl): ContenidoAprobadoTcl {
  const estado = estadoDeContenidoParaTcl(e.estadoDeLaVersionAprobada);
  return {
    participacionId: String(e.participacionId),
    entregable: {
      id: String(e.entregableId),
      etiqueta: textoParaTcl(e.etiqueta, 120),
      plataforma: typeof e.plataforma === 'string' && PLATAFORMA.test(e.plataforma) ? e.plataforma : null,
      producto: e.producto === null ? null : proyectarProductoParaTcl(e.producto),
    },
    estado,
    aprobadoEl: estado === 'aprobado' ? instanteParaTcl(e.aprobadoEl) : null,
  };
}

// ─────────────────────────── Brief ─────────────────────────────────────────────

/**
 * Claves del catálogo del Brief que TCL puede ver (lista blanca). Revisada contra `brief-catalog.json`:
 *   · EXCLUIDAS: `practico.presupuesto` (dinero), `practico.fecha_inicio` y `practico.fecha_fin` (son objetos con
 *     precisión de fecha: las fechas de la campaña ya salen en su propio DTO).
 *   · Una prueba exige que lista blanca ∪ exclusiones = catálogo completo, sin solapes: una clave nueva del
 *     catálogo NO sale a TCL hasta que alguien la clasifique aquí.
 */
export const CLAVES_DE_BRIEF_PARA_TCL: readonly string[] = [
  'contexto.situacion',
  'contexto.categoria',
  'contexto.contexto_global',
  'objetivo.tipo',
  'objetivo.negocio',
  'objetivo.marca_comunicacion',
  'objetivo.comportamiento_esperado',
  'target_audiencia.descripcion',
  'target_audiencia.rango_edad',
  'target_audiencia.ubicacion',
  'target_audiencia.comportamiento',
  'target_audiencia.relacion_categoria',
  'problema_insight.problema',
  'problema_insight.tension',
  'problema_insight.insight',
  'problema_insight.cambio_comportamiento',
  'marca_producto[].nombre_producto',
  'marca_producto[].rol_marca',
  'marca_producto[].beneficio_principal',
  'marca_producto[].diferenciales',
  'marca_producto[].rtbs',
  'marca_producto[].especificaciones',
  'marca_producto[].activos_marca',
  'mandatorios',
  'mensaje_principal.one_line',
  'mensaje_principal.mensaje_clave',
  'mensaje_principal.beneficio_diferencial',
  'mensaje_principal.tono',
  'accion_kpis.accion_esperada',
  'accion_kpis.criterio_exito',
  'accion_kpis.kpis',
  'entregable_creativo.entregables',
  'entregable_creativo.canales',
  'entregable_creativo.formatos',
  'entregable_creativo.alcance',
  'entregable_creativo.desafio_creativo',
  'practico.hitos',
  'practico.restricciones',
];

export const CLAVES_DE_BRIEF_EXCLUIDAS_PARA_TCL: readonly string[] = [
  'practico.presupuesto',
  'practico.fecha_inicio',
  'practico.fecha_fin',
];

const BRIEF_PERMITIDAS: ReadonlySet<string> = new Set(CLAVES_DE_BRIEF_PARA_TCL);

export type IdiomaDeBriefParaTcl = 'es' | 'en';

export interface BriefProductoTcl {
  readonly marca: string | null;
  readonly modelo: string | null;
}

/** Un campo del Brief aprobado. Exactamente uno de `texto` / `items` no es `null`. Sin evidencia ni procedencia. */
export interface BriefCampoTcl {
  readonly clave: string;
  /** Etiqueta del catálogo (texto estático del producto, no del brief). */
  readonly etiqueta: string;
  /** Bloque canónico del catálogo (`contexto`, `objetivo`…). */
  readonly bloque: string;
  /** Producto al que aplica (campos de nivel producto o excepciones por producto); `null` = toda la campaña. */
  readonly producto: BriefProductoTcl | null;
  readonly texto: string | null;
  readonly items: readonly string[] | null;
}

export interface BriefRepresentacionTcl {
  readonly idioma: IdiomaDeBriefParaTcl;
  readonly campos: readonly BriefCampoTcl[];
}

export interface BriefTcl {
  readonly version: number;
  readonly aprobadoEl: string | null;
  readonly idiomaOriginal: 'es';
  readonly representaciones: readonly BriefRepresentacionTcl[];
}

export interface EntradaDeCampoDeBriefParaTcl {
  readonly key: string;
  readonly producto: { readonly marca: unknown; readonly modelo: unknown } | null;
  readonly value: unknown;
}

export interface EntradaDeBriefParaTcl {
  readonly version: number;
  readonly aprobadoEl: unknown;
  readonly representaciones: ReadonlyArray<{
    readonly idioma: IdiomaDeBriefParaTcl;
    readonly campos: readonly EntradaDeCampoDeBriefParaTcl[];
  }>;
}

const MAXIMO_DE_ITEMS = 60;
const LARGO_MAXIMO_DE_TEXTO_DE_BRIEF = 4000;

function textoDeBrief(valor: unknown): string | null {
  return textoParaTcl(valor, LARGO_MAXIMO_DE_TEXTO_DE_BRIEF);
}

/**
 * Convierte el valor de un campo del Brief en `{texto}` o `{items}`. Acepta texto, lista de textos y la lista de
 * mandatorios (`{categoria, descripcion}`). Cualquier otra forma (fechas, números, objetos inesperados) y
 * CUALQUIER texto inseguro ⇒ `null`: el campo completo se omite.
 */
export function valorDeBriefParaTcl(
  valor: unknown,
):
  | { readonly texto: string; readonly items: null }
  | { readonly texto: null; readonly items: readonly string[] }
  | null {
  if (typeof valor === 'string') {
    const t = textoDeBrief(valor);
    return t === null ? null : { texto: t, items: null };
  }
  if (!Array.isArray(valor) || valor.length === 0 || valor.length > MAXIMO_DE_ITEMS) return null;
  const items: string[] = [];
  for (const elemento of valor as unknown[]) {
    let texto: string | null;
    if (typeof elemento === 'string') {
      texto = textoDeBrief(elemento);
    } else if (typeof elemento === 'object' && elemento !== null) {
      const o = elemento as { categoria?: unknown; descripcion?: unknown };
      const categoria = textoParaTcl(o.categoria, 40);
      const descripcion = textoDeBrief(o.descripcion);
      texto = categoria === null || descripcion === null ? null : `${categoria}: ${descripcion}`;
    } else {
      texto = null;
    }
    if (texto === null) return null; // un elemento inseguro o ilegible omite el campo completo
    items.push(texto);
  }
  return { texto: null, items };
}

export function proyectarBriefParaTcl(e: EntradaDeBriefParaTcl): BriefTcl {
  return {
    version: enteroNoNegativo(e.version),
    aprobadoEl: instanteParaTcl(e.aprobadoEl),
    idiomaOriginal: 'es',
    representaciones: e.representaciones.map((r) => ({
      idioma: r.idioma === 'en' ? 'en' : 'es',
      campos: r.campos.flatMap((c): BriefCampoTcl[] => {
        if (!BRIEF_PERMITIDAS.has(c.key)) return [];
        const catalogo = campoDelCatalogo(c.key);
        if (catalogo === undefined) return [];
        const valor = valorDeBriefParaTcl(c.value);
        if (valor === null) return [];
        return [
          {
            clave: c.key,
            etiqueta: catalogo.label,
            bloque: catalogo.section,
            producto:
              c.producto === null
                ? null
                : {
                    marca: textoParaTcl(c.producto.marca, 120),
                    modelo: textoParaTcl(c.producto.modelo, 120),
                  },
            texto: valor.texto,
            items: valor.items,
          },
        ];
      }),
    })),
  };
}

// ─────────────────────────── Documentos ────────────────────────────────────────

/** Tipos de fuente visibles para TCL (la evidencia operativa `soporte_operativo` jamás). */
export const TIPOS_DE_DOCUMENTO_PARA_TCL = [
  'ppt_global',
  'ficha_tecnica',
  'brief_cliente',
  'imagen',
  'otro',
] as const;

export type TipoDeDocumentoParaTcl = (typeof TIPOS_DE_DOCUMENTO_PARA_TCL)[number];

/** Fuente compartida con TCL a propósito. Sin hash, URLs, jobs, fragmentos, tamaño ni confidencialidad. */
export interface DocumentoTcl {
  readonly sourceId: string;
  /** Título (nombre de archivo o título del enlace); `null` si no pasa la política de texto seguro. */
  readonly titulo: string | null;
  readonly tipo: TipoDeDocumentoParaTcl;
  readonly idioma: 'es' | 'en' | null;
  readonly fecha: string | null;
}

export interface EntradaDeDocumentoParaTcl {
  readonly sourceId: string;
  readonly titulo: unknown;
  readonly tipo: unknown;
  readonly idioma: unknown;
  readonly fecha: unknown;
}

export function proyectarDocumentoParaTcl(e: EntradaDeDocumentoParaTcl): DocumentoTcl {
  const tipo = (TIPOS_DE_DOCUMENTO_PARA_TCL as readonly unknown[]).includes(e.tipo)
    ? (e.tipo as TipoDeDocumentoParaTcl)
    : 'otro';
  const idioma = typeof e.idioma === 'string' ? e.idioma.toLowerCase().slice(0, 2) : null;
  return {
    sourceId: String(e.sourceId),
    titulo: textoParaTcl(e.titulo, 255),
    tipo,
    idioma: idioma === 'es' || idioma === 'en' ? idioma : null,
    fecha: fechaParaTcl(e.fecha),
  };
}

// ─────────────────────────── Proyección completa ───────────────────────────────

/**
 * Todo lo que TCL ve de UNA campaña. Es lo que sirven la interfaz y el export (JSON/CSV): el export serializa
 * exactamente esta estructura, no vuelve a consultar nada.
 */
export interface ProyeccionTclDeCampana {
  readonly campana: CampanaDetalleTcl;
  readonly influencers: readonly InfluencerTcl[];
  readonly contenido: readonly ContenidoAprobadoTcl[];
  /** `null` si la campaña aún no tiene un Brief aprobado (o ninguno es servible). */
  readonly brief: BriefTcl | null;
  readonly operacion: readonly ProyeccionTclDeOperacion[];
  readonly kpis: readonly KpiPorParticipacionTcl[];
  readonly documentos: readonly DocumentoTcl[];
}

/**
 * Comprobación final: ninguna clave de la salida (en ningún nivel) es prohibida. Falla en vez de filtrar: si
 * alguien añade a un DTO una clave como `fee` o `payment`, el servidor se niega a servir la proyección.
 */
export function asegurarProyeccionTcl<T>(valor: T): T {
  const prohibidas = clavesProhibidasEn(valor);
  if (prohibidas.length > 0) {
    throw new Error(`La proyección de TCL contiene claves prohibidas: ${prohibidas.join(', ')}`);
  }
  return valor;
}
