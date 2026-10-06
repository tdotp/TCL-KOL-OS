/**
 * Análisis de guion contra el Brief aprobado vigente (V2 · Fase 7) — núcleo PURO.
 *
 * Aquí no hay E/S: ni base de datos, ni red, ni worker. La capa de datos
 * (`packages/db/src/content-analysis.ts`) consulta y persiste; este módulo decide
 * QUÉ se le manda al modelo, CÓMO se le presenta, QUÉ se acepta de lo que
 * devuelve y CUÁNTA gravedad tiene cada observación.
 *
 * Reglas de oro (contrato F7, REPORTE B):
 *  1. Los hallazgos son DERIVADOS DEL BRIEF. El modelo no puede introducir
 *     requisitos nuevos: solo elige alias (`R#` requisitos del Brief, `F#`
 *     fragmentos del guion) y cita texto. Todo lo demás lo resuelve el código.
 *  2. Todo-o-nada. Una sola observación inválida (alias que no existe, cita que
 *     no está literalmente en el fragmento, categoría/base/estado incoherentes…)
 *     invalida TODA la respuesta: no se persiste ninguna observación parcial.
 *  3. El guion NUNCA se trunca: una «ausencia» sobre un guion recortado sería
 *     falsa. Si no cabe, error tipado. Los valores del Brief sí se recortan, con
 *     marcador visible y bandera `truncated`.
 *  4. Todo contenido de documentos y del Brief viaja dentro de sobres no
 *     confiables (`<<<NC:{nonce} …>>>`); ninguna instrucción dentro de un sobre
 *     tiene autoridad. Se reutilizan las primitivas de `agent-context.ts`.
 *  5. La severidad la deriva el código (`sev-1`); el modelo no la emite y nunca
 *     es un gate de aprobación.
 *  6. No se guarda razonamiento del modelo.
 */

import { createHash } from 'node:crypto';
import {
  type EntradaDePreparacion,
  type PreparacionDeFuente,
  derivarPreparacionDeFuente,
  envolverNoConfiable,
  neutralizarTexto,
  nonceValido,
  normalizarParaCita,
  recortarCampo,
  truncarTexto,
  verificarCitaLiteral,
  verificarSobres,
} from './agent-context';
import {
  ANALYSIS_PROMPT_VERSION,
  CONTEXT_VERSION,
  OUTPUT_SCHEMA_VERSION,
  SEVERITY_POLICY_VERSION,
  ANALYSIS_USER_HEADER,
  lineaFinalDeUsuarioDeAnalisis,
  renderizarSystemPromptDeAnalisis,
} from './content-analysis-prompt';
import { type Result, err, ok } from './errors';
import { type SourceLocator, describirLocalizador } from './source-locator';
import type { Criticality, FieldStatus } from './types';

// ─────────────────────────── 0. Constantes y vocabulario ───────────────────────

/** Versión de la allowlist de campos del Brief que se envían al modelo. */
export const BRIEF_ALLOWLIST_VERSION = 'brief-allow-1';

/** CTA = acción esperada de la campaña. NO existe un campo «CTA» aparte en el catálogo del Brief. */
export const CAMPO_CTA = 'accion_kpis.accion_esperada';

/**
 * Campos del Brief que pueden llegar al analizador (orden = orden de los alias).
 * NO entra: proyecto crudo, fuentes del Brief, comentarios, preguntas, actividad,
 * traducciones, otros guiones ni historial de chat. Los campos `marca_producto[].*`
 * solo entran para los productos en alcance.
 */
export const CAMPOS_PERMITIDOS_DEL_BRIEF: readonly string[] = [
  'mensaje_principal.one_line',
  'mensaje_principal.mensaje_clave',
  'mensaje_principal.beneficio_diferencial',
  'mensaje_principal.tono',
  CAMPO_CTA,
  'objetivo.comportamiento_esperado',
  'mandatorios',
  'practico.restricciones',
  'marca_producto[].nombre_producto',
  'marca_producto[].beneficio_principal',
  'marca_producto[].diferenciales',
  'marca_producto[].rtbs',
  'marca_producto[].especificaciones',
  'marca_producto[].activos_marca',
  'target_audiencia.descripcion',
  'entregable_creativo.entregables',
  'entregable_creativo.formatos',
  'entregable_creativo.canales',
];

/** Categorías cerradas de observación (el modelo no puede inventar otras). */
export const ANALYSIS_CATEGORIES = [
  'cta_missing',
  'key_message_incomplete',
  'requirement_not_covered',
  'claim_unsupported',
  'claim_contradicted',
  'restriction_violated',
  'brief_contradiction',
] as const;
export type AnalysisCategory = (typeof ANALYSIS_CATEGORIES)[number];

export const ANALYSIS_BASES = ['absence', 'partial', 'conflict'] as const;
export type AnalysisBasis = (typeof ANALYSIS_BASES)[number];

/** En v1 el modelo solo emite `unsupported`/`contradicted` (la base admite `supported` para el futuro). */
export const ANALYSIS_CLAIM_STATUSES = ['unsupported', 'contradicted'] as const;
export type AnalysisClaimStatus = (typeof ANALYSIS_CLAIM_STATUSES)[number];

export const ANALYSIS_SEVERITIES = ['baja', 'media', 'alta'] as const;
export type AnalysisSeverity = (typeof ANALYSIS_SEVERITIES)[number];

/** Presupuesto de caracteres del contexto (valores iniciales; el guion NUNCA se trunca). */
export interface PresupuestoDeAnalisis {
  /** Guion completo: si no cabe, error `part: 'script'` ANTES de crear un run. */
  readonly scriptChars: number;
  /** Suma de los valores del Brief enviados (tras recortar cada unidad). */
  readonly briefChars: number;
  /** Cada unidad del Brief; por encima se recorta con marcador y bandera `truncated`. */
  readonly unitChars: number;
  /** Datos de contexto (influencer, productos, entregable). */
  readonly contextChars: number;
  /** system + user. El worker admite 400 000. */
  readonly totalChars: number;
}

export const PRESUPUESTO_DE_ANALISIS: PresupuestoDeAnalisis = {
  scriptChars: 40_000,
  briefChars: 18_000,
  unitChars: 1_200,
  contextChars: 3_000,
  totalChars: 70_000,
};

/** Límites de la salida del modelo. Los de FORMA son idénticos en el worker (Pydantic). */
export const LIMITES_DE_SALIDA = {
  maxFindings: 25,
  // `[0-9]` y no `\d`: el `\d` de Pydantic (regex de Rust) es Unicode; el de JS, solo ASCII. Paridad exacta.
  idPattern: /^h[0-9]{1,2}$/,
  maxRefs: 4,
  maxQuotes: 3,
  /** Cota de FORMA de la descripción (la regla de negocio, 10–400, se aplica tras neutralizar). */
  descripcionFormaMax: 1_000,
  aliasMax: 32,
  citaFormaMax: 2_000,
  descripcionMin: 10,
  descripcionMax: 400,
  citaMin: 12,
  citaMax: 500,
  snippetMax: 300,
} as const;

export interface PoliticaDeAnalisis {
  readonly maxFindings: number;
  readonly severityPolicyVersion: string;
}

export const POLITICA_DE_ANALISIS: PoliticaDeAnalisis = {
  maxFindings: LIMITES_DE_SALIDA.maxFindings,
  severityPolicyVersion: SEVERITY_POLICY_VERSION,
};

export function sha256Hex(texto: string): string {
  return createHash('sha256').update(texto, 'utf8').digest('hex');
}

/** JSON con claves ordenadas (huellas estables). */
function jsonCanonico(valor: unknown): string {
  if (valor === null || typeof valor !== 'object') return JSON.stringify(valor) ?? 'null';
  if (Array.isArray(valor)) return `[${valor.map((v) => jsonCanonico(v)).join(',')}]`;
  const claves = Object.keys(valor as Record<string, unknown>).sort();
  return `{${claves
    .filter((k) => (valor as Record<string, unknown>)[k] !== undefined)
    .map((k) => `${JSON.stringify(k)}:${jsonCanonico((valor as Record<string, unknown>)[k])}`)
    .join(',')}}`;
}

// ─────────────────────────── 1. Kill-switch ────────────────────────────────────

export type LectorDeEntorno = (nombre: string) => string | undefined;

/**
 * Kill-switch de IA. Semántica EXACTA de `ia_activa()` del worker
 * (`services/ai-worker/app/modelo_turno.py`) y de `iaActiva` del runtime del
 * agente (`packages/agent/src/runtime/config.ts`): sin definir = apagado; solo
 * `1`, `true` o `yes` (sin distinguir mayúsculas ni espacios) lo encienden.
 * Hay una prueba de paridad textual contra el código Python.
 */
export function iaActiva(env: LectorDeEntorno): boolean {
  return ['1', 'true', 'yes'].includes((env('AI_ENABLED') ?? 'false').trim().toLowerCase());
}

// ─────────────────────────── 2. Prontitud, vigencia ────────────────────────────

export type ProntitudDeAnalisis =
  | 'ready'
  | 'source_queued'
  | 'source_running'
  | 'source_failed'
  | 'source_no_text'
  | 'source_restricted'
  | 'source_unknown'
  | 'script_too_large'
  | 'no_governing_brief'
  | 'ai_disabled';

export const PRONTITUDES_DE_ANALISIS: readonly ProntitudDeAnalisis[] = [
  'ready',
  'source_queued',
  'source_running',
  'source_failed',
  'source_no_text',
  'source_restricted',
  'source_unknown',
  'script_too_large',
  'no_governing_brief',
  'ai_disabled',
] as const;

export interface EntradaDeProntitud {
  /** Resultado de `iaActiva(env)`. */
  readonly iaActiva: boolean;
  /** Existe un Brief rector (aprobado) para la campaña. */
  readonly hayBriefRector: boolean;
  /** Fila de la fuente del guion (misma política que el chat: `derivarPreparacionDeFuente`). */
  readonly fuente: EntradaDePreparacion;
  /** Caracteres del guion si ya se leyó. */
  readonly scriptChars?: number | undefined;
  readonly presupuesto?: Pick<PresupuestoDeAnalisis, 'scriptChars'> | undefined;
}

const PRONTITUD_DE_PREPARACION: Readonly<Record<PreparacionDeFuente, ProntitudDeAnalisis>> = {
  ready: 'ready',
  ready_no_text: 'source_no_text',
  queued: 'source_queued',
  running: 'source_running',
  failed: 'source_failed',
  restricted: 'source_restricted',
  // Un guion es siempre un archivo: los estados de enlace no deberían darse; si se dan, no es legible.
  link_unresolved: 'source_unknown',
  link_syncing: 'source_unknown',
  link_not_syncable: 'source_unknown',
  unknown: 'source_unknown',
};

/**
 * ¿Se puede analizar este guion AHORA? Determinista y sin gasto: cualquier valor
 * distinto de `ready` es un rechazo tipificado SIN run ni llamada al modelo.
 * Precedencia: IA apagada → sin Brief rector → fuente no lista → guion demasiado grande.
 */
export function evaluarProntitudDeAnalisis(e: EntradaDeProntitud): ProntitudDeAnalisis {
  if (!e.iaActiva) return 'ai_disabled';
  if (!e.hayBriefRector) return 'no_governing_brief';
  const prontitud = PRONTITUD_DE_PREPARACION[derivarPreparacionDeFuente(e.fuente)];
  if (prontitud !== 'ready') return prontitud;
  const tope = e.presupuesto?.scriptChars ?? PRESUPUESTO_DE_ANALISIS.scriptChars;
  if (e.scriptChars !== undefined && e.scriptChars > tope) return 'script_too_large';
  return 'ready';
}

/** Traduce una prontitud ≠ `ready` al error tipado del caso de uso (sin run, sin gasto). */
export function errorDeProntitudDeAnalisis(p: ProntitudDeAnalisis, scriptChars?: number): Result<true> {
  switch (p) {
    case 'ready':
      return ok(true);
    case 'ai_disabled':
      return err({
        code: 'AI_DISABLED',
        message: 'La IA está desactivada: el análisis asistido no está disponible.',
      });
    case 'no_governing_brief':
      return err({
        code: 'BRIEF_NOT_APPROVED',
        message: 'Todavía no existe un Brief aprobado para esta campaña.',
      });
    case 'script_too_large':
      return err({
        code: 'SCRIPT_CONTEXT_TOO_LARGE',
        message: 'El guion es demasiado largo para el análisis asistido; no se recorta nunca.',
        details: {
          part: 'script',
          limit: PRESUPUESTO_DE_ANALISIS.scriptChars,
          ...(scriptChars === undefined ? {} : { chars: scriptChars }),
        },
      });
    default:
      return err({
        code: 'SCRIPT_SOURCE_NOT_READY',
        message: 'El texto del guion todavía no está disponible para el análisis.',
        details: { reason: p },
      });
  }
}

export type VigenciaDeAnalisis =
  | { readonly status: 'current' }
  | { readonly status: 'stale'; readonly reason: 'brief_changed' }
  | { readonly status: 'no_governing_brief' };

/**
 * CURRENT si el Brief contra el que se analizó es el rector actual; STALE (sigue
 * legible) si el rector cambió; `no_governing_brief` si hoy no hay rector.
 * Se deriva en lectura: no hay columna `is_current`.
 */
export function vigenciaDelAnalisis(e: {
  readonly runGoverningBriefVersionId: string;
  readonly currentGoverningBriefVersionId: string | undefined;
}): VigenciaDeAnalisis {
  if (e.currentGoverningBriefVersionId === undefined) return { status: 'no_governing_brief' };
  return e.runGoverningBriefVersionId === e.currentGoverningBriefVersionId
    ? { status: 'current' }
    : { status: 'stale', reason: 'brief_changed' };
}

// ─────────────────────────── 3. Entradas y unidades de requisito ───────────────

/** Un campo del Brief tal como lo entrega el llamador (valor ORIGINAL de la versión gobernante). */
export interface BriefRequirementInput {
  /** Clave del catálogo (`mensaje_principal.one_line`, `marca_producto[].rtbs`…). */
  readonly campo: string;
  readonly etiqueta: string;
  readonly criticidad: Criticality;
  readonly status: FieldStatus;
  /** Valor tal cual: texto, lista de textos, lista de objetos con `descripcion`, o nulo. */
  readonly valor: unknown;
  /** Ítems ya separados (opcional): si falta y `valor` es un arreglo, se derivan de él. */
  readonly items?: readonly unknown[] | undefined;
  /** `campaign_product_id` si el valor es de un producto (o una excepción por producto). */
  readonly productoId?: string | undefined;
  readonly productoNombre?: string | undefined;
  /** Id de `brief_fields` (opaco para el dominio; la base lo usa para adjuntar evidencia). */
  readonly fieldId?: string | undefined;
}

export interface FragmentoDeGuionInput {
  readonly ordinal: number;
  readonly texto: string;
  readonly locator?: SourceLocator | undefined;
  /** Opaco (suave: los fragmentos son inestables ante un reproceso). */
  readonly fragmentId?: string | undefined;
}

export interface ProductoEnAlcance {
  readonly id: string;
  readonly nombre: string;
}

/** Unidad de requisito con alias `R#`: un campo escalar, o UN ítem de una lista. */
export interface RequisitoRegistrado {
  readonly alias: string;
  readonly campo: string;
  readonly etiqueta: string;
  readonly criticidad: Criticality;
  readonly status: FieldStatus;
  readonly productoId?: string | undefined;
  readonly productoNombre?: string | undefined;
  readonly fieldId?: string | undefined;
  /** Índice del ítem dentro de la lista (0-based). */
  readonly itemIndex?: number | undefined;
  /** Con valor definido (`found`/`manual` y no vacío). Un requisito no evaluable no se puede cubrir ni incumplir. */
  readonly evaluable: boolean;
  /** El valor se recortó por tamaño al enviarlo. */
  readonly truncated: boolean;
  /** Valor tal como se envió (ya recortado). Solo en memoria: no se persiste. */
  readonly texto: string;
}

export interface FragmentoRegistrado {
  readonly alias: string;
  readonly ordinal: number;
  readonly fragmentId?: string | undefined;
  readonly locator?: SourceLocator | undefined;
  readonly locatorLabel?: string | undefined;
  readonly texto: string;
  readonly textHash: string;
}

export interface OmisionesDelBrief {
  readonly notAllowlisted: number;
  readonly outOfScope: number;
}

const PREFIJO_PRODUCTO = 'marca_producto[].';

function indiceEnAllowlist(campo: string): number {
  return CAMPOS_PERMITIDOS_DEL_BRIEF.indexOf(campo);
}

function textoDeItem(item: unknown): string {
  if (typeof item === 'string') return item.trim();
  if (item !== null && typeof item === 'object') {
    const d = (item as { descripcion?: unknown }).descripcion;
    if (typeof d === 'string') return d.trim();
    return (JSON.stringify(item) ?? '').trim();
  }
  if (item === null || item === undefined) return '';
  return String(item).trim();
}

const TEXTO_SIN_VALOR = '(sin valor definido en el Brief)';

/**
 * Convierte los campos del Brief en UNIDADES de requisito con alias `R1…Rm`.
 *  · Solo campos de la allowlist; los de producto, solo para productos en alcance.
 *  · Una unidad por campo escalar y una por ítem en las listas.
 *  · `not_found`/`conflict`/vacío ⇒ unidad `evaluable: false`.
 *  · Cada valor se recorta a `unitChars` con marcador visible (`truncated`).
 *  · Orden determinista (allowlist → producto → orden de entrada): los mismos
 *    insumos dan los mismos alias y la misma huella, vengan como vengan de la base.
 */
export function construirUnidadesDeRequisito(
  requisitos: readonly BriefRequirementInput[],
  productosEnAlcance: readonly ProductoEnAlcance[],
  presupuesto: Pick<PresupuestoDeAnalisis, 'unitChars'> = PRESUPUESTO_DE_ANALISIS,
): { readonly unidades: readonly RequisitoRegistrado[]; readonly omitidos: OmisionesDelBrief } {
  const ordenDeProducto = new Map(productosEnAlcance.map((p, i) => [p.id, i]));
  const nombreDe = new Map(productosEnAlcance.map((p) => [p.id, p.nombre]));
  let notAllowlisted = 0;
  let outOfScope = 0;

  const filas: { readonly r: BriefRequirementInput; readonly orden: number }[] = [];
  for (const [orden, r] of requisitos.entries()) {
    if (indiceEnAllowlist(r.campo) < 0) {
      notAllowlisted += 1;
      continue;
    }
    const esDeProducto = r.campo.startsWith(PREFIJO_PRODUCTO);
    const enAlcance = r.productoId === undefined ? !esDeProducto : ordenDeProducto.has(r.productoId);
    if (!enAlcance) {
      outOfScope += 1;
      continue;
    }
    filas.push({ r, orden });
  }
  filas.sort(
    (a, b) =>
      indiceEnAllowlist(a.r.campo) - indiceEnAllowlist(b.r.campo) ||
      (a.r.productoId === undefined ? -1 : (ordenDeProducto.get(a.r.productoId) ?? 0)) -
        (b.r.productoId === undefined ? -1 : (ordenDeProducto.get(b.r.productoId) ?? 0)) ||
      a.orden - b.orden,
  );

  const unidades: RequisitoRegistrado[] = [];
  const agregar = (
    r: BriefRequirementInput,
    texto: string,
    evaluable: boolean,
    itemIndex: number | undefined,
  ): void => {
    const recortado = evaluable ? truncarTexto(texto, presupuesto.unitChars) : { texto, perdidos: 0 };
    unidades.push({
      alias: `R${unidades.length + 1}`,
      campo: r.campo,
      etiqueta: r.etiqueta,
      criticidad: r.criticidad,
      status: r.status,
      ...(r.productoId === undefined ? {} : { productoId: r.productoId }),
      ...(r.productoId === undefined
        ? {}
        : { productoNombre: r.productoNombre ?? nombreDe.get(r.productoId) ?? '' }),
      ...(r.fieldId === undefined ? {} : { fieldId: r.fieldId }),
      ...(itemIndex === undefined ? {} : { itemIndex }),
      evaluable,
      truncated: recortado.perdidos > 0,
      texto: recortado.texto,
    });
  };

  for (const { r } of filas) {
    const definido = r.status === 'found' || r.status === 'manual';
    const lista = r.items ?? (Array.isArray(r.valor) ? (r.valor as readonly unknown[]) : undefined);
    if (lista !== undefined) {
      const items = lista.map((it, i) => ({ texto: textoDeItem(it), i })).filter((x) => x.texto !== '');
      if (!definido || items.length === 0) {
        agregar(r, TEXTO_SIN_VALOR, false, undefined);
      } else {
        for (const it of items) agregar(r, it.texto, true, it.i);
      }
      continue;
    }
    const texto = typeof r.valor === 'string' ? r.valor.trim() : textoDeItem(r.valor);
    if (!definido || texto === '') agregar(r, TEXTO_SIN_VALOR, false, undefined);
    else agregar(r, texto, true, undefined);
  }
  return { unidades, omitidos: { notAllowlisted, outOfScope } };
}

/** Fragmentos del guion en orden de `ordinal`, con alias `F1…Fk`. Los fragmentos vacíos no se registran. */
export function construirFragmentosDeGuion(
  fragmentos: readonly FragmentoDeGuionInput[],
): Result<readonly FragmentoRegistrado[]> {
  const ordinales = new Set<number>();
  for (const f of fragmentos) {
    if (!Number.isInteger(f.ordinal) || f.ordinal < 0 || ordinales.has(f.ordinal)) {
      return err({
        code: 'VALIDATION_FAILED',
        message: 'Los fragmentos del guion tienen ordinales inválidos o repetidos.',
        details: { reason: 'bad_fragment_ordinals' },
      });
    }
    ordinales.add(f.ordinal);
  }
  const ordenados = [...fragmentos]
    .filter((f) => f.texto.trim() !== '')
    .sort((a, b) => a.ordinal - b.ordinal);
  return ok(
    ordenados.map((f, i) => ({
      alias: `F${i + 1}`,
      ordinal: f.ordinal,
      ...(f.fragmentId === undefined ? {} : { fragmentId: f.fragmentId }),
      ...(f.locator === undefined
        ? {}
        : { locator: f.locator, locatorLabel: describirLocalizador(f.locator) }),
      texto: f.texto,
      textHash: sha256Hex(f.texto),
    })),
  );
}

// ─────────────────────────── 4. Huella del Brief enviado ───────────────────────

/**
 * Huella de la proyección canónica del Brief REALMENTE enviada al modelo:
 * `[(campo, producto, ítem, criticidad, status, valor enviado)]` ordenado, más la
 * versión gobernante y la versión de contexto. Excluye traducciones, comentarios,
 * `review_status`, preguntas y actividad: cambiar solo eso no invalida un análisis.
 */
export function huellaDeProyeccionDeBrief(
  unidades: readonly RequisitoRegistrado[],
  briefVersionId: string,
): string {
  const filas = unidades
    .map(
      (u) =>
        [
          u.campo,
          u.productoId ?? '',
          u.itemIndex ?? -1,
          u.criticidad,
          u.status,
          u.evaluable ? u.texto : '',
        ] as const,
    )
    .sort((a, b) => {
      const ka = jsonCanonico(a);
      const kb = jsonCanonico(b);
      return ka < kb ? -1 : ka > kb ? 1 : 0;
    });
  return sha256Hex(
    jsonCanonico({
      contextVersion: CONTEXT_VERSION,
      allowlistVersion: BRIEF_ALLOWLIST_VERSION,
      briefVersionId,
      unidades: filas,
    }),
  );
}

// ─────────────────────────── 5. Contexto del analizador ────────────────────────

export interface DatosDeContextoDeAnalisis {
  readonly influencerNombre?: string | undefined;
  readonly entregable?: string | undefined;
}

export interface EntradaDeContextoDeAnalisis {
  /** Nonce de los sobres de ESTE run (HMAC del servidor; lo deriva la base). */
  readonly nonce: string;
  readonly briefVersion: {
    readonly id: string;
    readonly number: number;
    readonly approvedAt?: string | undefined;
  };
  readonly requisitos: readonly BriefRequirementInput[];
  readonly fragmentos: readonly FragmentoDeGuionInput[];
  readonly productosEnAlcance: readonly ProductoEnAlcance[];
  /** `assigned`: productos asignados al participante (DEC-044); `all_campaign`: no había asignados. */
  readonly productScope: 'assigned' | 'all_campaign';
  readonly datos?: DatosDeContextoDeAnalisis | undefined;
  readonly presupuesto?: Partial<PresupuestoDeAnalisis> | undefined;
}

export type ParteDelPresupuesto = 'script' | 'brief' | 'context' | 'total';

/** Qué se mandó, sin contenido: lo que se persiste como `context_manifest`. */
export interface ManifiestoDeContextoDeAnalisis {
  readonly contextVersion: string;
  readonly promptVersion: string;
  readonly outputSchemaVersion: string;
  readonly allowlistVersion: string;
  readonly briefVersionId: string;
  readonly productScope: 'assigned' | 'all_campaign';
  readonly requirements: readonly {
    readonly alias: string;
    readonly campo: string;
    readonly fieldId?: string | undefined;
    readonly itemIndex?: number | undefined;
    readonly productoId?: string | undefined;
    readonly evaluable: boolean;
    readonly truncated: boolean;
    readonly chars: number;
  }[];
  readonly fragments: readonly {
    readonly alias: string;
    readonly ordinal: number;
    readonly fragmentId?: string | undefined;
    readonly chars: number;
    readonly textHash: string;
  }[];
  readonly omitted: OmisionesDelBrief;
  readonly counts: {
    readonly requirements: number;
    readonly notEvaluable: number;
    readonly truncated: number;
    readonly fragments: number;
  };
  readonly budget: {
    readonly scriptChars: number;
    readonly briefChars: number;
    readonly contextChars: number;
    readonly contextTruncated: boolean;
    readonly totalChars: number;
    readonly limits: PresupuestoDeAnalisis;
  };
}

export interface ContextoDeAnalisis {
  readonly messages: readonly [
    { readonly role: 'system'; readonly content: string },
    { readonly role: 'user'; readonly content: string },
  ];
  readonly requisitos: readonly RequisitoRegistrado[];
  readonly fragmentos: readonly FragmentoRegistrado[];
  readonly manifest: ManifiestoDeContextoDeAnalisis;
  /** Huella del Brief enviado (`huellaDeProyeccionDeBrief`). */
  readonly briefFingerprint: string;
  readonly scriptChars: number;
  readonly scriptTextHash: string;
  /** sha256 de system + user (`ai_runs.input_hash`; nunca el prompt). */
  readonly inputHash: string;
}

function tooLarge(part: ParteDelPresupuesto, chars: number, limit: number): Result<never> {
  return err({
    code: 'SCRIPT_CONTEXT_TOO_LARGE',
    message:
      part === 'script'
        ? 'El guion es demasiado largo para el análisis asistido; no se recorta nunca.'
        : 'El contexto del análisis excede el presupuesto.',
    details: { part, chars, limit },
  });
}

function lineaDeFecha(approvedAt: string | undefined): string {
  const m = approvedAt === undefined ? null : /^(\d{4}-\d{2}-\d{2})/.exec(approvedAt);
  return m === null ? '' : `, aprobado el ${m[1]}`;
}

/**
 * Ensambla el contexto del analizador: mensajes `[system, user]` listos para el
 * worker, el registro de alias y el manifiesto sin contenido.
 *
 * Errores (todos ANTES de gastar nada): `SCRIPT_CONTEXT_TOO_LARGE{part}` si el
 * guion (40 000), los valores del Brief (18 000) o el total (70 000) no caben;
 * `VALIDATION_FAILED` si no hay requisitos ni guion que comparar o el nonce es inválido.
 */
export function construirContextoDeAnalisis(e: EntradaDeContextoDeAnalisis): Result<ContextoDeAnalisis> {
  const presupuesto: PresupuestoDeAnalisis = { ...PRESUPUESTO_DE_ANALISIS, ...(e.presupuesto ?? {}) };
  if (!nonceValido(e.nonce)) {
    return err({
      code: 'VALIDATION_FAILED',
      message: 'Nonce de sobres inválido.',
      details: { reason: 'bad_nonce' },
    });
  }

  const frag = construirFragmentosDeGuion(e.fragmentos);
  if (!frag.ok) return frag;
  const fragmentos = frag.value;
  if (fragmentos.length === 0) {
    return err({
      code: 'SCRIPT_SOURCE_NOT_READY',
      message: 'El guion no tiene texto que analizar.',
      details: { reason: 'source_no_text' },
    });
  }
  const scriptChars = fragmentos.reduce((s, f) => s + f.texto.length, 0);
  if (scriptChars > presupuesto.scriptChars) return tooLarge('script', scriptChars, presupuesto.scriptChars);

  const { unidades, omitidos } = construirUnidadesDeRequisito(
    e.requisitos,
    e.productosEnAlcance,
    presupuesto,
  );
  if (unidades.length === 0) {
    return err({
      code: 'VALIDATION_FAILED',
      message: 'El Brief no aporta ningún requisito analizable.',
      details: { reason: 'no_requirements' },
    });
  }
  const briefChars = unidades.reduce((s, u) => s + u.texto.length, 0);
  if (briefChars > presupuesto.briefChars) return tooLarge('brief', briefChars, presupuesto.briefChars);

  // Datos de contexto (influencer, productos, entregable): no confiables, acotados con marcador.
  const lineasDeDatos: string[] = [];
  if (e.datos?.influencerNombre !== undefined)
    lineasDeDatos.push(`Influencer: ${recortarCampo(e.datos.influencerNombre, 120)}`);
  if (e.productosEnAlcance.length > 0) {
    lineasDeDatos.push(
      `Producto(s): ${e.productosEnAlcance.map((p) => recortarCampo(p.nombre, 80)).join('; ')}`,
    );
  }
  if (e.datos?.entregable !== undefined)
    lineasDeDatos.push(`Entregable: ${recortarCampo(e.datos.entregable, 120)}`);
  const datos = truncarTexto(lineasDeDatos.join('\n'), presupuesto.contextChars);

  const sobres: string[] = [];
  for (const u of unidades) {
    sobres.push(
      envolverNoConfiable({
        nonce: e.nonce,
        kind: 'brief_requirement',
        ref: u.alias,
        meta: {
          key: u.campo,
          label: u.etiqueta,
          criticidad: u.criticidad,
          status: u.status,
          ...(u.productoNombre === undefined ? {} : { producto: u.productoNombre }),
          ...(u.itemIndex === undefined ? {} : { item: u.itemIndex + 1 }),
          ...(u.evaluable ? {} : { no_evaluable: true }),
          ...(u.truncated ? { truncated: true } : {}),
        },
        texto: u.texto,
      }),
    );
  }
  for (const f of fragmentos) {
    sobres.push(
      envolverNoConfiable({
        nonce: e.nonce,
        kind: 'script_fragment',
        ref: f.alias,
        meta: { ordinal: f.ordinal, ...(f.locatorLabel === undefined ? {} : { locator: f.locatorLabel }) },
        texto: f.texto,
      }),
    );
  }
  if (datos.texto !== '') {
    sobres.push(envolverNoConfiable({ nonce: e.nonce, kind: 'context_data', texto: datos.texto }));
  }

  const noEvaluables = unidades.filter((u) => !u.evaluable).length;
  const recortadas = unidades.filter((u) => u.truncated).length;
  const alcance =
    e.productScope === 'assigned'
      ? `productos asignados al participante (${e.productosEnAlcance.length})`
      : `todos los productos de la campaña (${e.productosEnAlcance.length}); el participante no tiene productos asignados`;
  const manifiestoConfiable = [
    ANALYSIS_USER_HEADER,
    `BRIEF aprobado: versión ${e.briefVersion.number}${lineaDeFecha(e.briefVersion.approvedAt)}. Alcance de producto: ${alcance}.`,
    `GUION: ${fragmentos.length} fragmento(s) (${fragmentos[0]!.alias}…${fragmentos[fragmentos.length - 1]!.alias}), ${scriptChars} caracteres, completo (nunca recortado).`,
    `REQUISITOS: ${unidades.length} unidad(es) (R1…R${unidades.length}); no evaluables: ${noEvaluables}; recortadas por tamaño: ${recortadas}.`,
  ].join('\n');

  const user = [
    manifiestoConfiable,
    '',
    sobres.join('\n'),
    '',
    lineaFinalDeUsuarioDeAnalisis(fragmentos.length, unidades.length),
  ].join('\n');
  const system = renderizarSystemPromptDeAnalisis(e.nonce);
  const totalChars = system.length + user.length;
  if (totalChars > presupuesto.totalChars) return tooLarge('total', totalChars, presupuesto.totalChars);

  // Autocomprobación de seguridad: la estructura de sobres del mensaje de usuario debe ser inviolada.
  const comprobacion = verificarSobres(user, e.nonce);
  if (!comprobacion.ok) {
    return err({
      code: 'VALIDATION_FAILED',
      message: 'El contexto del análisis no superó la verificación de sobres.',
      details: { reason: 'envelope_violation', violations: comprobacion.violaciones.length },
    });
  }

  const manifest: ManifiestoDeContextoDeAnalisis = {
    contextVersion: CONTEXT_VERSION,
    promptVersion: ANALYSIS_PROMPT_VERSION,
    outputSchemaVersion: OUTPUT_SCHEMA_VERSION,
    allowlistVersion: BRIEF_ALLOWLIST_VERSION,
    briefVersionId: e.briefVersion.id,
    productScope: e.productScope,
    requirements: unidades.map((u) => ({
      alias: u.alias,
      campo: u.campo,
      ...(u.fieldId === undefined ? {} : { fieldId: u.fieldId }),
      ...(u.itemIndex === undefined ? {} : { itemIndex: u.itemIndex }),
      ...(u.productoId === undefined ? {} : { productoId: u.productoId }),
      evaluable: u.evaluable,
      truncated: u.truncated,
      chars: u.texto.length,
    })),
    fragments: fragmentos.map((f) => ({
      alias: f.alias,
      ordinal: f.ordinal,
      ...(f.fragmentId === undefined ? {} : { fragmentId: f.fragmentId }),
      chars: f.texto.length,
      textHash: f.textHash,
    })),
    omitted: omitidos,
    counts: {
      requirements: unidades.length,
      notEvaluable: noEvaluables,
      truncated: recortadas,
      fragments: fragmentos.length,
    },
    budget: {
      scriptChars,
      briefChars,
      contextChars: datos.texto.length,
      contextTruncated: datos.perdidos > 0,
      totalChars,
      limits: presupuesto,
    },
  };

  return ok({
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    requisitos: unidades,
    fragmentos,
    manifest,
    briefFingerprint: huellaDeProyeccionDeBrief(unidades, e.briefVersion.id),
    scriptChars,
    scriptTextHash: sha256Hex(fragmentos.map((f) => f.texto).join('\n')),
    inputHash: sha256Hex(`${system}\n\u0000\n${user}`),
  });
}

// ─────────────────────────── 5b. Contrato con el worker (`POST /modelo/analisis`) ──

/** Parámetros fijos de la llamada (iniciales; el worker acota los mismos rangos). */
export const PARAMETROS_DE_LLAMADA_DE_ANALISIS = {
  maxFindings: LIMITES_DE_SALIDA.maxFindings,
  maxTokens: 6_000,
  /** Plazo total del worker (tope 120). El HTTP de Node debe esperar ~10 s más. */
  timeoutS: 90,
} as const;

/** Cuerpo EXACTO de `POST /modelo/analisis` (contrato estricto: `extra=forbid` en el worker). */
export interface PeticionDeAnalisis {
  readonly task: 'analizar_guion';
  readonly messages: readonly [
    { readonly role: 'system'; readonly content: string },
    { readonly role: 'user'; readonly content: string },
  ];
  readonly output_schema_version: typeof OUTPUT_SCHEMA_VERSION;
  readonly max_findings: number;
  readonly max_tokens: number;
  readonly timeout_s: number;
  readonly correlation?: { readonly analysis_run_id: string };
}

/** Arma el cuerpo de la petición al worker. `analysisRunId` es OPACO (solo correlaciona logs). */
export function construirPeticionDeAnalisis(
  contexto: Pick<ContextoDeAnalisis, 'messages'>,
  opciones: { readonly analysisRunId?: string | undefined } = {},
): PeticionDeAnalisis {
  return {
    task: 'analizar_guion',
    messages: contexto.messages,
    output_schema_version: OUTPUT_SCHEMA_VERSION,
    max_findings: PARAMETROS_DE_LLAMADA_DE_ANALISIS.maxFindings,
    max_tokens: PARAMETROS_DE_LLAMADA_DE_ANALISIS.maxTokens,
    timeout_s: PARAMETROS_DE_LLAMADA_DE_ANALISIS.timeoutS,
    ...(opciones.analysisRunId === undefined
      ? {}
      : { correlation: { analysis_run_id: opciones.analysisRunId } }),
  };
}

/** Llamada al proveedor tal como la informa el worker (en éxito y en error). Sin contenido. */
export interface LlamadaDelWorker {
  readonly usage: {
    readonly prompt_tokens: number;
    readonly completion_tokens: number;
    readonly total_tokens: number;
    readonly cost_usd: number | null;
  } | null;
  readonly latency_ms: number;
  readonly generation_id: string | null;
  /** `ok` | `json_invalido` | `forma_invalida` | `error` (ledger: ok → ok; error → error; resto → invalido). */
  readonly outcome: 'ok' | 'json_invalido' | 'forma_invalida' | 'error';
}

/** Código persistido en `content_analysis_runs.failure_code`. */
export type CodigoDeFalloDeAnalisis =
  | 'AI_DISABLED'
  | 'MODEL_TIMEOUT'
  | 'MODEL_RATE_LIMITED'
  | 'MODEL_UPSTREAM_ERROR'
  | 'MODEL_BAD_RESPONSE'
  | 'MODEL_CONTEXT_TOO_LARGE'
  | 'MODEL_NOT_CONFIGURED'
  | 'WORKER_UNREACHABLE'
  | 'ANALYSIS_INVALID_OUTPUT'
  | 'ANALYSIS_ABANDONED'
  | 'ANALYSIS_INTERNAL_ERROR';

const FALLOS_POR_CODIGO_DEL_WORKER: Readonly<Record<string, CodigoDeFalloDeAnalisis>> = {
  AI_DISABLED: 'AI_DISABLED',
  MODEL_TIMEOUT: 'MODEL_TIMEOUT',
  MODEL_RATE_LIMITED: 'MODEL_RATE_LIMITED',
  MODEL_UPSTREAM_ERROR: 'MODEL_UPSTREAM_ERROR',
  MODEL_BAD_RESPONSE: 'MODEL_BAD_RESPONSE',
  MODEL_CONTEXT_TOO_LARGE: 'MODEL_CONTEXT_TOO_LARGE',
  MODEL_NOT_CONFIGURED: 'MODEL_NOT_CONFIGURED',
  MODEL_OUTPUT_INVALID: 'ANALYSIS_INVALID_OUTPUT',
  // Un contrato mal armado por Node o un bug del worker: nada que reintentar.
  REQUEST_INVALID: 'ANALYSIS_INTERNAL_ERROR',
  INTERNAL_ERROR: 'ANALYSIS_INTERNAL_ERROR',
};

/** Traduce el `error.code` del worker (o `WORKER_UNREACHABLE` de Node) al código persistido. */
export function codigoDeFalloDeAnalisis(codigoDelWorker: string): CodigoDeFalloDeAnalisis {
  if (codigoDelWorker === 'WORKER_UNREACHABLE') return 'WORKER_UNREACHABLE';
  return FALLOS_POR_CODIGO_DEL_WORKER[codigoDelWorker] ?? 'ANALYSIS_INTERNAL_ERROR';
}

/**
 * Fallos que Node reintenta UNA vez (transporte). Una salida inválida (de forma o de
 * semántica) NUNCA se reintenta: el worker ya repitió una vez si el JSON venía roto.
 */
export function esFalloReintentablePorNode(codigo: CodigoDeFalloDeAnalisis): boolean {
  return (
    codigo === 'MODEL_RATE_LIMITED' ||
    codigo === 'MODEL_TIMEOUT' ||
    codigo === 'MODEL_UPSTREAM_ERROR' ||
    codigo === 'WORKER_UNREACHABLE'
  );
}

// ─────────────────────────── 6. Validación de la salida ────────────────────────

/** Razones de invalidez: códigos fijos, SIN contenido del modelo (van a `failure_detail`). */
export type CodigoDeInvalidez =
  | 'not_object'
  | 'schema_version_mismatch'
  | 'unknown_field'
  | 'too_many_findings'
  | 'bad_shape'
  | 'bad_enum'
  | 'bad_description'
  | 'duplicate_id'
  | 'too_many_refs'
  | 'duplicate_ref'
  | 'missing_brief_ref'
  | 'unknown_requirement_alias'
  | 'requirement_not_evaluable'
  | 'too_many_quotes'
  | 'missing_script_quote'
  | 'unexpected_script_quote'
  | 'unknown_fragment_alias'
  | 'quote_too_short'
  | 'quote_too_long'
  | 'quote_trivial'
  | 'quote_not_in_fragment'
  | 'basis_category_mismatch'
  | 'claim_status_mismatch'
  | 'cta_not_defined_in_brief'
  | 'ref_kind_not_allowed_for_category';

export interface RazonDeInvalidez {
  readonly code: CodigoDeInvalidez;
  /** Id del hallazgo (`h3`) si es legible; nunca texto libre del modelo. */
  readonly findingId?: string | undefined;
  /** Ruta fija (`findings[2].brief_refs[0]`): jamás el nombre de una clave del modelo. */
  readonly field: string;
}

/** Tope de razones que se conservan en `failure_detail`. */
export const MAX_RAZONES_DE_INVALIDEZ = 50;

export interface CitaCruda {
  readonly fragment: string;
  readonly quote: string;
}

export interface HallazgoCrudo {
  readonly id: string;
  readonly category: AnalysisCategory;
  readonly basis: AnalysisBasis;
  readonly claim_status: AnalysisClaimStatus | null;
  readonly description: string;
  readonly brief_refs: readonly string[];
  readonly script_quotes: readonly CitaCruda[];
}

export interface SalidaCruda {
  readonly schema_version: string;
  readonly findings: readonly HallazgoCrudo[];
}

/** Longitud en puntos de código (no unidades UTF-16): lo que cuenta Pydantic, para que ambas formas coincidan. */
function largoEnPuntos(texto: string): number {
  return Array.from(texto).length;
}

function esObjeto(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function idLegible(v: unknown): string | undefined {
  return typeof v === 'string' && LIMITES_DE_SALIDA.idPattern.test(v) ? v : undefined;
}

const CLAVES_DE_HALLAZGO = [
  'id',
  'category',
  'basis',
  'claim_status',
  'description',
  'brief_refs',
  'script_quotes',
];
const CLAVES_DE_CITA = ['fragment', 'quote'];

/**
 * Validación de FORMA de la salida del modelo (primer paso de `validarSalidaDeAnalisis`).
 * Es el espejo exacto del modelo Pydantic del worker (`modelo_analisis.SalidaAnalisis`):
 * ambos ejecutan los mismos casos de `analysis-output.fixtures.json`.
 *
 * Estricta: objeto con exactamente `schema_version` y `findings`; sin campos
 * desconocidos; tipos exactos (sin coerción); enums cerrados; cotas de tamaño.
 */
export function validarFormaDeSalida(
  cruda: unknown,
  opciones: { readonly maxFindings?: number | undefined } = {},
):
  | { readonly ok: true; readonly salida: SalidaCruda }
  | { readonly ok: false; readonly razones: readonly RazonDeInvalidez[] } {
  const maxFindings = opciones.maxFindings ?? LIMITES_DE_SALIDA.maxFindings;
  const razones: RazonDeInvalidez[] = [];
  const falla = (code: CodigoDeInvalidez, field: string, findingId?: string): void => {
    if (razones.length < MAX_RAZONES_DE_INVALIDEZ)
      razones.push({ code, field, ...(findingId === undefined ? {} : { findingId }) });
  };

  if (!esObjeto(cruda)) return { ok: false, razones: [{ code: 'not_object', field: '$' }] };
  if (Object.keys(cruda).some((k) => k !== 'schema_version' && k !== 'findings')) falla('unknown_field', '$');
  if (cruda['schema_version'] !== OUTPUT_SCHEMA_VERSION) falla('schema_version_mismatch', 'schema_version');
  const lista = cruda['findings'];
  if (!Array.isArray(lista)) {
    falla('bad_shape', 'findings');
    return { ok: false, razones };
  }
  if (lista.length > maxFindings) falla('too_many_findings', 'findings');

  const hallazgos: HallazgoCrudo[] = [];
  for (const [i, h] of lista.entries()) {
    const ruta = `findings[${i}]`;
    if (!esObjeto(h)) {
      falla('bad_shape', ruta);
      continue;
    }
    const fid = idLegible(h['id']);
    const antes = razones.length;
    if (Object.keys(h).some((k) => !CLAVES_DE_HALLAZGO.includes(k))) falla('unknown_field', ruta, fid);
    if (fid === undefined) falla('bad_shape', `${ruta}.id`);
    if (
      typeof h['category'] !== 'string' ||
      !(ANALYSIS_CATEGORIES as readonly string[]).includes(h['category'])
    ) {
      falla('bad_enum', `${ruta}.category`, fid);
    }
    if (typeof h['basis'] !== 'string' || !(ANALYSIS_BASES as readonly string[]).includes(h['basis'])) {
      falla('bad_enum', `${ruta}.basis`, fid);
    }
    const cs = h['claim_status'];
    if (
      cs !== undefined &&
      cs !== null &&
      (typeof cs !== 'string' || !(ANALYSIS_CLAIM_STATUSES as readonly string[]).includes(cs))
    ) {
      falla('bad_enum', `${ruta}.claim_status`, fid);
    }
    if (
      typeof h['description'] !== 'string' ||
      largoEnPuntos(h['description']) > LIMITES_DE_SALIDA.descripcionFormaMax
    ) {
      falla(
        typeof h['description'] === 'string' ? 'bad_description' : 'bad_shape',
        `${ruta}.description`,
        fid,
      );
    }

    const refs = h['brief_refs'];
    if (
      !Array.isArray(refs) ||
      refs.some((r) => typeof r !== 'string' || largoEnPuntos(r) > LIMITES_DE_SALIDA.aliasMax)
    ) {
      falla('bad_shape', `${ruta}.brief_refs`, fid);
    } else if (refs.length > LIMITES_DE_SALIDA.maxRefs) {
      falla('too_many_refs', `${ruta}.brief_refs`, fid);
    }

    const citas = h['script_quotes'];
    if (citas !== undefined) {
      if (!Array.isArray(citas)) {
        falla('bad_shape', `${ruta}.script_quotes`, fid);
      } else {
        if (citas.length > LIMITES_DE_SALIDA.maxQuotes)
          falla('too_many_quotes', `${ruta}.script_quotes`, fid);
        for (const [j, c] of citas.entries()) {
          const rc = `${ruta}.script_quotes[${j}]`;
          if (!esObjeto(c)) {
            falla('bad_shape', rc, fid);
            continue;
          }
          if (Object.keys(c).some((k) => !CLAVES_DE_CITA.includes(k))) falla('unknown_field', rc, fid);
          if (
            typeof c['fragment'] !== 'string' ||
            largoEnPuntos(c['fragment']) > LIMITES_DE_SALIDA.aliasMax
          ) {
            falla('bad_shape', `${rc}.fragment`, fid);
          }
          if (typeof c['quote'] !== 'string' || largoEnPuntos(c['quote']) > LIMITES_DE_SALIDA.citaFormaMax) {
            falla('bad_shape', `${rc}.quote`, fid);
          }
        }
      }
    }
    if (razones.length === antes) {
      hallazgos.push({
        id: h['id'] as string,
        category: h['category'] as AnalysisCategory,
        basis: h['basis'] as AnalysisBasis,
        claim_status: (cs ?? null) as AnalysisClaimStatus | null,
        description: h['description'] as string,
        brief_refs: refs as readonly string[],
        script_quotes: (citas ?? []) as readonly CitaCruda[],
      });
    }
  }
  if (razones.length > 0) return { ok: false, razones };
  return { ok: true, salida: { schema_version: cruda['schema_version'] as string, findings: hallazgos } };
}

// --- Matriz categoría ↔ base ↔ estado del claim ↔ citas -------------------------

interface ReglaDeCategoria {
  readonly basis: AnalysisBasis;
  readonly claimStatus: AnalysisClaimStatus | null;
  /** `none`: la ausencia no lleva cita; `required`: ≥1 cita literal. */
  readonly citas: 'none' | 'required';
}

export const MATRIZ_DE_CATEGORIAS: Readonly<Record<AnalysisCategory, ReglaDeCategoria>> = {
  cta_missing: { basis: 'absence', claimStatus: null, citas: 'none' },
  key_message_incomplete: { basis: 'partial', claimStatus: null, citas: 'required' },
  requirement_not_covered: { basis: 'absence', claimStatus: null, citas: 'none' },
  claim_unsupported: { basis: 'absence', claimStatus: 'unsupported', citas: 'required' },
  claim_contradicted: { basis: 'conflict', claimStatus: 'contradicted', citas: 'required' },
  restriction_violated: { basis: 'conflict', claimStatus: null, citas: 'required' },
  brief_contradiction: { basis: 'conflict', claimStatus: null, citas: 'required' },
};

const CAMPOS_DE_MENSAJE_CLAVE: readonly string[] = [
  'mensaje_principal.one_line',
  'mensaje_principal.mensaje_clave',
  'mensaje_principal.beneficio_diferencial',
];
const CAMPOS_DE_RESTRICCION: readonly string[] = ['practico.restricciones', 'mandatorios'];

// --- Severidad derivada (política sev-1) ------------------------------------------

const SEVERIDAD_BASE: Readonly<Record<AnalysisCategory, AnalysisSeverity>> = {
  restriction_violated: 'alta',
  claim_contradicted: 'alta',
  brief_contradiction: 'media',
  cta_missing: 'media',
  requirement_not_covered: 'media',
  claim_unsupported: 'media',
  key_message_incomplete: 'baja',
};

const RANGO_DE_SEVERIDAD: Readonly<Record<AnalysisSeverity, number>> = { baja: 0, media: 1, alta: 2 };

/**
 * Severidad `sev-1`: la base la fija la categoría y sube un nivel (tope `alta`) si
 * alguna unidad citada es `critico` o `claim` en el Brief. La deriva el código;
 * el modelo no la emite. NUNCA es un gate de aprobación.
 */
export function derivarSeveridad(
  categoria: AnalysisCategory,
  unidadesCitadas: readonly Pick<RequisitoRegistrado, 'criticidad'>[],
): AnalysisSeverity {
  const base = SEVERIDAD_BASE[categoria];
  const sube = unidadesCitadas.some((u) => u.criticidad === 'critico' || u.criticidad === 'claim');
  if (!sube) return base;
  return ANALYSIS_SEVERITIES[Math.min(RANGO_DE_SEVERIDAD[base] + 1, 2)]!;
}

// --- Salida validada y enriquecida --------------------------------------------------

export interface ReferenciaDeBrief {
  readonly alias: string;
  readonly campo: string;
  readonly etiqueta: string;
  readonly criticidad: Criticality;
  readonly status: FieldStatus;
  readonly fieldId?: string | undefined;
  readonly productoId?: string | undefined;
  readonly itemIndex?: number | undefined;
  /** Valor del requisito tal como se envió, en una línea (≤300). La evidencia/fuente original la adjunta la base. */
  readonly valueSnippet: string;
}

export interface ReferenciaDeGuion {
  readonly alias: string;
  readonly ordinal: number;
  readonly fragmentId?: string | undefined;
  readonly locator?: SourceLocator | undefined;
  /** Cita neutralizada tal como la devolvió el modelo (verificada literal contra el fragmento). */
  readonly quote: string;
  /** sha256 de la cita normalizada (`normalizarParaCita`). */
  readonly quoteSha256: string;
  /** sha256 del texto del fragmento en el momento del análisis. */
  readonly fragmentTextHash: string;
}

export interface HallazgoValidado {
  /** 1-based, tras ordenar (severidad desc, luego posición del modelo). */
  readonly ordinal: number;
  /** Posición (0-based) en la respuesta del modelo. */
  readonly modelPosition: number;
  readonly modelId: string;
  readonly category: AnalysisCategory;
  readonly basis: AnalysisBasis;
  readonly claimStatus: AnalysisClaimStatus | null;
  readonly severity: AnalysisSeverity;
  /** Español, neutralizada, una línea, 10–400 caracteres. */
  readonly description: string;
  readonly briefRefs: readonly ReferenciaDeBrief[];
  readonly scriptRefs: readonly ReferenciaDeGuion[];
}

export interface AnalisisValidado {
  readonly schemaVersion: string;
  readonly severityPolicyVersion: string;
  readonly findings: readonly HallazgoValidado[];
  /** Observaciones del modelo antes de deduplicar. */
  readonly modelFindingCount: number;
  /** Duplicados colapsados (no invalidan). */
  readonly duplicatesCollapsed: number;
}

export interface ContextoDeValidacion {
  readonly requisitos: readonly RequisitoRegistrado[];
  readonly fragmentos: readonly FragmentoRegistrado[];
  /** Ids de los productos en alcance (un claim de producto fuera de alcance no vale). */
  readonly productosEnAlcance: readonly string[];
  readonly politica?: PoliticaDeAnalisis | undefined;
}

function cotaPalabras(citaNormalizada: string): boolean {
  return (
    /\p{L}/u.test(citaNormalizada) &&
    citaNormalizada.split(' ').filter((p) => /[\p{L}\p{N}]/u.test(p)).length >= 2
  );
}

/**
 * Valida de forma ESTRICTA y TODO-O-NADA la salida cruda (ya parseada) del
 * modelo contra los requisitos y fragmentos que realmente se le enviaron.
 *
 * Éxito: observaciones deduplicadas, con referencias enriquecidas por código
 * (Brief: campo/ítem/valor enviado; guion: ordinal, localizador, cita con hash),
 * severidad `sev-1` derivada y orden estable. Fallo: `AI_ANALYSIS_FAILED` con
 * `details.failureCode = 'ANALYSIS_INVALID_OUTPUT'` y TODAS las razones (sin
 * contenido), sin observaciones parciales.
 */
export function validarSalidaDeAnalisis(cruda: unknown, ctx: ContextoDeValidacion): Result<AnalisisValidado> {
  const politica = ctx.politica ?? POLITICA_DE_ANALISIS;
  const razones: RazonDeInvalidez[] = [];
  const fallo = (rs: readonly RazonDeInvalidez[]): Result<AnalisisValidado> =>
    err({
      code: 'AI_ANALYSIS_FAILED',
      message: 'El análisis no pudo completarse: la respuesta del modelo no cumple el contrato.',
      details: {
        failureCode: 'ANALYSIS_INVALID_OUTPUT',
        reasonCount: rs.length,
        reasons: rs.slice(0, MAX_RAZONES_DE_INVALIDEZ).map((r) => ({
          code: r.code,
          field: r.field,
          ...(r.findingId === undefined ? {} : { findingId: r.findingId }),
        })),
      },
    });

  const forma = validarFormaDeSalida(cruda, { maxFindings: politica.maxFindings });
  if (!forma.ok) return fallo(forma.razones);

  const porAliasDeRequisito = new Map(ctx.requisitos.map((r) => [r.alias.toUpperCase(), r]));
  const porAliasDeFragmento = new Map(ctx.fragmentos.map((f) => [f.alias.toUpperCase(), f]));
  const enAlcance = new Set(ctx.productosEnAlcance);
  const hayCtaDefinida = ctx.requisitos.some((r) => r.campo === CAMPO_CTA && r.evaluable);
  const idsVistos = new Set<string>();

  interface Candidato {
    readonly posicion: number;
    readonly crudo: HallazgoCrudo;
    readonly descripcion: string;
    readonly unidades: readonly RequisitoRegistrado[];
    readonly citas: readonly {
      readonly fragmento: FragmentoRegistrado;
      readonly quote: string;
      readonly normalizada: string;
    }[];
  }
  const candidatos: Candidato[] = [];

  for (const [pos, h] of forma.salida.findings.entries()) {
    const ruta = `findings[${pos}]`;
    const falla = (code: CodigoDeInvalidez, field: string): void => {
      razones.push({ code, field, findingId: h.id });
    };
    const antes = razones.length;

    if (idsVistos.has(h.id)) falla('duplicate_id', `${ruta}.id`);
    idsVistos.add(h.id);

    const regla = MATRIZ_DE_CATEGORIAS[h.category];
    if (h.basis !== regla.basis) falla('basis_category_mismatch', `${ruta}.basis`);
    if (h.claim_status !== regla.claimStatus) falla('claim_status_mismatch', `${ruta}.claim_status`);

    const descripcion = neutralizarTexto(h.description).replace(/\s+/gu, ' ').trim();
    // Mínimo de CONTENIDO, no de longitud: los «rellenos» Unicode que se ven en blanco (Hangul filler U+3164,
    // U+115F/U+1160/U+FFA0, braille en blanco U+2800, CGJ U+034F, U+17B4/U+17B5…) no son letras ni dígitos
    // (QA-F7-13a): una descripción hecha de ellos no es un hallazgo.
    const letrasODigitos = (descripcion.match(/[\p{L}\p{N}]/gu) ?? []).length;
    if (
      descripcion.length < LIMITES_DE_SALIDA.descripcionMin ||
      descripcion.length > LIMITES_DE_SALIDA.descripcionMax ||
      letrasODigitos < LIMITES_DE_SALIDA.descripcionMin
    ) {
      falla('bad_description', `${ruta}.description`);
    }

    // Requisitos citados.
    const unidades: RequisitoRegistrado[] = [];
    const aliasVistos = new Set<string>();
    if (h.brief_refs.length === 0) falla('missing_brief_ref', `${ruta}.brief_refs`);
    for (const [j, alias] of h.brief_refs.entries()) {
      const campo = `${ruta}.brief_refs[${j}]`;
      const clave = alias.trim().toUpperCase();
      const u = porAliasDeRequisito.get(clave);
      if (u === undefined) {
        falla('unknown_requirement_alias', campo);
        continue;
      }
      if (aliasVistos.has(u.alias)) {
        falla('duplicate_ref', campo);
        continue;
      }
      aliasVistos.add(u.alias);
      unidades.push(u);
      if (u.productoId !== undefined && !enAlcance.has(u.productoId)) {
        falla('ref_kind_not_allowed_for_category', campo);
      }
      // Un requisito sin valor no se puede cubrir ni incumplir. Salvo: claim_unsupported (el Brief no respalda
      // la afirmación: admite un claim sin valor) y la CTA no definida, que tiene su razón propia.
      const exento =
        (h.category === 'claim_unsupported' && u.criticidad === 'claim') ||
        (h.category === 'cta_missing' && u.campo === CAMPO_CTA);
      if (!u.evaluable && !exento) falla('requirement_not_evaluable', campo);
    }

    // Reglas por categoría sobre los requisitos citados.
    const resueltas = unidades;
    switch (h.category) {
      case 'cta_missing': {
        const cita = resueltas.filter((u) => u.campo === CAMPO_CTA);
        if (!hayCtaDefinida || (cita.length > 0 && !cita.some((u) => u.evaluable))) {
          falla('cta_not_defined_in_brief', `${ruta}.brief_refs`);
        } else if (cita.length === 0 && resueltas.length > 0) {
          falla('ref_kind_not_allowed_for_category', `${ruta}.brief_refs`);
        }
        break;
      }
      case 'key_message_incomplete':
        if (resueltas.some((u) => !CAMPOS_DE_MENSAJE_CLAVE.includes(u.campo))) {
          falla('ref_kind_not_allowed_for_category', `${ruta}.brief_refs`);
        }
        break;
      case 'claim_unsupported':
      case 'claim_contradicted':
        if (resueltas.length > 0 && !resueltas.some((u) => u.criticidad === 'claim')) {
          falla('ref_kind_not_allowed_for_category', `${ruta}.brief_refs`);
        }
        break;
      case 'restriction_violated':
        if (resueltas.length > 0 && !resueltas.some((u) => CAMPOS_DE_RESTRICCION.includes(u.campo))) {
          falla('ref_kind_not_allowed_for_category', `${ruta}.brief_refs`);
        }
        break;
      case 'brief_contradiction':
        if (resueltas.length > 0 && !resueltas.some((u) => u.criticidad !== 'claim')) {
          falla('ref_kind_not_allowed_for_category', `${ruta}.brief_refs`);
        }
        break;
      case 'requirement_not_covered':
        break;
    }

    // Citas del guion.
    const citas: { fragmento: FragmentoRegistrado; quote: string; normalizada: string }[] = [];
    if (regla.citas === 'none' && h.script_quotes.length > 0)
      falla('unexpected_script_quote', `${ruta}.script_quotes`);
    if (regla.citas === 'required' && h.script_quotes.length === 0)
      falla('missing_script_quote', `${ruta}.script_quotes`);
    for (const [j, c] of h.script_quotes.entries()) {
      const campo = `${ruta}.script_quotes[${j}]`;
      const f = porAliasDeFragmento.get(c.fragment.trim().toUpperCase());
      if (f === undefined) {
        falla('unknown_fragment_alias', `${campo}.fragment`);
        continue;
      }
      const normalizada = normalizarParaCita(c.quote);
      const r = verificarCitaLiteral(c.quote, [f.texto], {
        minChars: LIMITES_DE_SALIDA.citaMin,
        maxChars: LIMITES_DE_SALIDA.citaMax,
      });
      if (!r.ok) {
        if (r.motivo === 'vacia' || r.motivo === 'muy_corta') falla('quote_too_short', `${campo}.quote`);
        else if (r.motivo === 'muy_larga') falla('quote_too_long', `${campo}.quote`);
        else if (!cotaPalabras(normalizada)) falla('quote_trivial', `${campo}.quote`);
        else falla('quote_not_in_fragment', `${campo}.quote`);
        continue;
      }
      if (!cotaPalabras(normalizada)) {
        falla('quote_trivial', `${campo}.quote`);
        continue;
      }
      if (!citas.some((x) => x.fragmento.alias === f.alias && x.normalizada === normalizada)) {
        citas.push({
          fragmento: f,
          quote: neutralizarTexto(c.quote).replace(/\s+/gu, ' ').trim(),
          normalizada,
        });
      }
    }

    if (razones.length === antes) {
      candidatos.push({ posicion: pos, crudo: h, descripcion, unidades, citas });
    }
  }

  if (razones.length > 0) return fallo(razones);

  // Deduplicar por (categoría, requisitos, citas): colapsa, no invalida.
  const vistos = new Set<string>();
  const unicos: Candidato[] = [];
  for (const c of candidatos) {
    const clave = jsonCanonico([
      c.crudo.category,
      c.unidades.map((u) => u.alias).sort(),
      c.citas.map((q) => `${q.fragmento.alias}:${q.normalizada}`).sort(),
    ]);
    if (vistos.has(clave)) continue;
    vistos.add(clave);
    unicos.push(c);
  }

  const conSeveridad = unicos.map((c) => ({ c, severidad: derivarSeveridad(c.crudo.category, c.unidades) }));
  conSeveridad.sort(
    (a, b) =>
      RANGO_DE_SEVERIDAD[b.severidad] - RANGO_DE_SEVERIDAD[a.severidad] || a.c.posicion - b.c.posicion,
  );

  const findings: HallazgoValidado[] = conSeveridad.map(({ c, severidad }, i) => ({
    ordinal: i + 1,
    modelPosition: c.posicion,
    modelId: c.crudo.id,
    category: c.crudo.category,
    basis: c.crudo.basis,
    claimStatus: c.crudo.claim_status,
    severity: severidad,
    description: c.descripcion,
    briefRefs: c.unidades.map((u) => ({
      alias: u.alias,
      campo: u.campo,
      etiqueta: u.etiqueta,
      criticidad: u.criticidad,
      status: u.status,
      ...(u.fieldId === undefined ? {} : { fieldId: u.fieldId }),
      ...(u.productoId === undefined ? {} : { productoId: u.productoId }),
      ...(u.itemIndex === undefined ? {} : { itemIndex: u.itemIndex }),
      valueSnippet: u.evaluable ? recortarCampo(u.texto, LIMITES_DE_SALIDA.snippetMax) : '',
    })),
    scriptRefs: c.citas.map((q) => ({
      alias: q.fragmento.alias,
      ordinal: q.fragmento.ordinal,
      ...(q.fragmento.fragmentId === undefined ? {} : { fragmentId: q.fragmento.fragmentId }),
      ...(q.fragmento.locator === undefined ? {} : { locator: q.fragmento.locator }),
      quote: q.quote,
      quoteSha256: sha256Hex(q.normalizada),
      fragmentTextHash: q.fragmento.textHash,
    })),
  }));

  return ok({
    schemaVersion: forma.salida.schema_version,
    severityPolicyVersion: politica.severityPolicyVersion,
    findings,
    modelFindingCount: forma.salida.findings.length,
    duplicatesCollapsed: candidatos.length - unicos.length,
  });
}
