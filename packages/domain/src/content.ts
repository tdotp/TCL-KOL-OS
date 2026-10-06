/**
 * Contenido: entregables y versiones de guion (V2 · Fase 7).
 *
 *   Deliverable    = una pieza de contenido de UNA participación (CampaignInfluencer;
 *                    nunca del Influencer: DEC-044). Sin fee, pago, envío, KPI,
 *                    acuerdo ni publicación: eso son fases posteriores.
 *   ScriptVersion  = una versión RECIBIDA e inmutable de un guion de ese entregable.
 *                    El contenido ES el archivo (`source_documents`); solo cambia su
 *                    estado de revisión.
 *
 * Aquí viven los tipos y las reglas puras (estados, transiciones, normalización de
 * la etiqueta, resolución de la participación, resumen derivado). La persistencia
 * y la autorización están en `packages/db`; la base repite las reglas de estado y
 * una prueba ejecuta la matriz contra Postgres para detectar si divergen.
 */

import { type Result, err, ok } from './errors';

// ─────────────────────────── Estados ───────────────────────────────────────────

export type DeliverableStatus = 'active' | 'archived';

export const DELIVERABLE_STATUSES: readonly DeliverableStatus[] = ['active', 'archived'] as const;

/**
 * Estado de revisión de una versión de guion.
 *
 *   received            recibida, sin revisar.
 *   in_review           en revisión (primer acto de revisión, o explícito).
 *   changes_requested   se pidieron cambios. TERMINAL: reabrir es registrar la versión N+1.
 *   approved            aprobada por una persona con `script:approve` (la vigente).
 *   superseded          reemplazada por una versión posterior aprobada.
 */
export type ScriptVersionStatus = 'received' | 'in_review' | 'changes_requested' | 'approved' | 'superseded';

export const SCRIPT_VERSION_STATUSES: readonly ScriptVersionStatus[] = [
  'received',
  'in_review',
  'changes_requested',
  'approved',
  'superseded',
] as const;

/**
 * Transiciones válidas (las mismas que impone el trigger de la migración 023).
 *
 *  · `superseded` NO es una acción: solo es el efecto interno de aprobar una versión
 *    MAYOR (received | in_review | approved → superseded). Las `changes_requested`
 *    nunca se reemplazan: conservan su resultado histórico.
 *  · NO existe changes_requested → in_review: se registra una versión nueva.
 *  · Aprobar solo desde `in_review` y solo por la persona con `script:approve`.
 */
export const SCRIPT_VERSION_TRANSITIONS: Readonly<
  Record<ScriptVersionStatus, readonly ScriptVersionStatus[]>
> = {
  received: ['in_review', 'changes_requested', 'superseded'],
  in_review: ['changes_requested', 'approved', 'superseded'],
  changes_requested: [],
  approved: ['superseded'],
  superseded: [],
};

export function isScriptVersionStatus(value: unknown): value is ScriptVersionStatus {
  return typeof value === 'string' && (SCRIPT_VERSION_STATUSES as readonly string[]).includes(value);
}

/** ¿Es válida la transición `from → to`? */
export function canTransitionScriptVersion(from: ScriptVersionStatus, to: ScriptVersionStatus): boolean {
  return SCRIPT_VERSION_TRANSITIONS[from].includes(to);
}

/** Estados que admiten comentarios de revisión y cambios solicitados. */
export const SCRIPT_VERSION_OPEN_STATUSES: readonly ScriptVersionStatus[] = [
  'received',
  'in_review',
] as const;

export function isOpenScriptVersion(status: ScriptVersionStatus): boolean {
  return SCRIPT_VERSION_OPEN_STATUSES.includes(status);
}

// ─────────────────────────── Entidades ─────────────────────────────────────────

export interface Deliverable {
  readonly id: string;
  readonly organizationId: string;
  readonly campaignId: string;
  /** La participación (CampaignInfluencer) a la que pertenece. */
  readonly campaignInfluencerId: string;
  /** Informativa (puede faltar); NO forma parte de la clave. */
  readonly platform: string | undefined;
  readonly label: string;
  readonly labelKey: string;
  readonly campaignProductId: string | undefined;
  readonly status: DeliverableStatus;
  readonly archivedAt: string | undefined;
  /** Número de la última versión registrada (0 si aún no hay). */
  readonly lastVersion: number;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ScriptVersion {
  readonly id: string;
  readonly organizationId: string;
  readonly campaignId: string;
  readonly deliverableId: string;
  readonly version: number;
  readonly status: ScriptVersionStatus;
  readonly sourceDocumentId: string;
  readonly sourceFilename: string;
  readonly sourceHash: string;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly approvedBy: string | undefined;
  readonly approvedAt: string | undefined;
  readonly supersededByVersionId: string | undefined;
  readonly supersededAt: string | undefined;
}

// ─────────────────────────── Etiqueta del entregable ───────────────────────────

const MAX_ETIQUETA = 120;
const CARACTERES_DE_CONTROL = /[\p{Cc}\p{Cf}]/u;

export interface EtiquetaNormalizada {
  /** Como se escribió (espacios colapsados y recortados): lo que se muestra. */
  readonly label: string;
  /** Clave determinística de comparación (NFKC + minúsculas). */
  readonly key: string;
}

function etiquetaInvalida<T>(message: string): Result<T> {
  return err({ code: 'VALIDATION_FAILED', message, details: { field: 'label' } });
}

/**
 * Regla ÚNICA de la etiqueta de un entregable (determinística, sin fuzzy):
 *
 *   1. Los espacios (y saltos de línea) internos se colapsan a uno y se recortan los extremos.
 *   2. La clave es NFKC y minúsculas: «Reel principal» y «  REEL   principal » son el MISMO
 *      entregable. NO se plegan los acentos (`reel` y `réel` son etiquetas distintas).
 *   3. No puede quedar vacía, superar 120 caracteres ni llevar caracteres de control.
 *
 * Clave estable de un entregable activo: (participación, clave de la etiqueta).
 */
export function normalizarEtiquetaDeEntregable(raw: unknown): Result<EtiquetaNormalizada> {
  if (typeof raw !== 'string') return etiquetaInvalida('La etiqueta del entregable es obligatoria.');
  const label = raw.normalize('NFC').replace(/\s+/gu, ' ').trim();
  if (label === '') return etiquetaInvalida('La etiqueta del entregable no puede quedar vacía.');
  if (label.length > MAX_ETIQUETA) {
    return etiquetaInvalida(`La etiqueta no puede superar ${MAX_ETIQUETA} caracteres.`);
  }
  if (CARACTERES_DE_CONTROL.test(label)) {
    return etiquetaInvalida('La etiqueta contiene caracteres no válidos.');
  }
  const key = label.normalize('NFKC').replace(/\s+/gu, ' ').trim().toLowerCase();
  if (key === '' || key.length > MAX_ETIQUETA) {
    return etiquetaInvalida('La etiqueta del entregable no es válida.');
  }
  return ok({ label, key });
}

/** Distancia de edición (inserciones, borrados, sustituciones) acotada: corta al pasar de `max`. */
function distanciaDeEdicion(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let previa = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const actual = [i];
    let minimo = i;
    for (let j = 1; j <= b.length; j++) {
      const costo = a[i - 1] === b[j - 1] ? 0 : 1;
      const v = Math.min(previa[j]! + 1, actual[j - 1]! + 1, previa[j - 1]! + costo);
      actual.push(v);
      if (v < minimo) minimo = v;
    }
    if (minimo > max) return max + 1;
    previa = actual;
  }
  return previa[b.length]!;
}

/**
 * ¿Dos claves de etiqueta DISTINTAS se parecen lo bastante para pedir confirmación en vez de
 * crear un entregable nuevo? («reel» vs «reel principal», «Reel pricipal» vs «reel principal»).
 * Determinística: una contiene a la otra (la más corta con ≥3 caracteres) o difieren en ≤2
 * ediciones (ambas con ≥4). Iguales NO se parecen (son el mismo entregable) y las que solo
 * difieren en un número («Story 1» / «Story 2») tampoco: son piezas distintas.
 */
export function etiquetasParecidas(claveA: string, claveB: string): boolean {
  if (claveA === claveB) return false;
  // «Story 1» y «Story 2» son piezas distintas a propósito: solo difieren en el número.
  if (claveA.replace(/\d+/gu, '#') === claveB.replace(/\d+/gu, '#')) return false;
  const [corta, larga] = claveA.length <= claveB.length ? [claveA, claveB] : [claveB, claveA];
  if (corta.length >= 3 && larga.includes(corta)) return true;
  return corta.length >= 4 && distanciaDeEdicion(corta, larga, 2) <= 2;
}

// ─────────────────────────── Resolver la participación ─────────────────────────

/** Lo que hace falta saber de un participante para reconocerlo por su nombre. */
export interface ParticipanteReconocible {
  readonly id: string;
  readonly displayName: string;
  /** Handles de sus cuentas (con o sin `@`). */
  readonly handles: readonly string[];
  /** Productos que trabaja (para desambiguar); opcional. */
  readonly products?: readonly string[] | undefined;
}

export type RazonDeParticipacion = 'unique' | 'disambiguated' | 'ambiguous' | 'not_found';

export interface ResultadoDeParticipacion<P extends ParticipanteReconocible = ParticipanteReconocible> {
  /** Todos los que coinciden con la mención (antes de desambiguar). Vacío si ninguno. */
  readonly candidatos: readonly P[];
  /** Solo si hay UNA coincidencia inequívoca. Nunca «el primero». */
  readonly elegido: P | undefined;
  readonly razon: RazonDeParticipacion;
}

/** Sin acentos, sin mayúsculas y con los espacios colapsados (solo para comparar). */
function plegar(texto: string): string {
  return texto
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/\s+/gu, ' ')
    .trim();
}

function palabras(texto: string): string[] {
  return plegar(texto)
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t !== '');
}

function sinArroba(handle: string): string {
  const p = plegar(handle);
  return p.startsWith('@') ? p.slice(1) : p;
}

/** ¿La mención identifica a este participante? (`@handle` exacto o todas sus palabras en el nombre). */
function coincideConMencion(mencion: string, p: ParticipanteReconocible): boolean {
  const plana = plegar(mencion);
  const sinAt = sinArroba(mencion);
  if (sinAt.length >= 2 && p.handles.some((h) => sinArroba(h) === sinAt)) return true;
  // Una mención con `@` solo identifica por handle (no por nombre).
  if (plana.startsWith('@')) return false;
  const buscadas = palabras(mencion);
  if (buscadas.length === 0) return false;
  const delNombre = new Set(palabras(p.displayName));
  return buscadas.every((t) => delNombre.has(t));
}

/** ¿La desambiguación (apellido, handle o producto) identifica a este participante? */
function coincideConDesambiguacion(texto: string, p: ParticipanteReconocible): boolean {
  const sinAt = sinArroba(texto);
  if (sinAt.length >= 2 && p.handles.some((h) => sinArroba(h) === sinAt)) return true;
  const buscadas = palabras(texto);
  if (buscadas.length === 0) return false;
  const conocidas = new Set([
    ...palabras(p.displayName),
    ...p.handles.flatMap((h) => palabras(h)),
    ...(p.products ?? []).flatMap((x) => palabras(x)),
  ]);
  return buscadas.every((t) => conocidas.has(t));
}

/**
 * Candidatos de participación para una mención («Valentina», «@valentina.rojas»).
 * PURA y sin fuzzy: ignora acentos y mayúsculas; reconoce las palabras del nombre
 * de presentación o un `@handle` exacto.
 *
 *  · 0 coincidencias   → `not_found`.
 *  · 1 coincidencia    → `unique`.
 *  · varias            → `ambiguous`, salvo que `disambiguation` (apellido, handle o producto)
 *                        deje EXACTAMENTE una → `disambiguated`.
 *
 * Nunca elige uno entre varios sin una desambiguación inequívoca.
 */
export function candidatosDeParticipacion<P extends ParticipanteReconocible>(
  mention: string,
  participantes: readonly P[],
  disambiguation?: string | undefined,
): ResultadoDeParticipacion<P> {
  if (typeof mention !== 'string' || plegar(mention).replace(/^@/, '').length < 2) {
    return { candidatos: [], elegido: undefined, razon: 'not_found' };
  }
  const candidatos = participantes.filter((p) => coincideConMencion(mention, p));
  if (candidatos.length === 0) return { candidatos, elegido: undefined, razon: 'not_found' };
  if (candidatos.length === 1) return { candidatos, elegido: candidatos[0], razon: 'unique' };
  if (typeof disambiguation === 'string' && plegar(disambiguation) !== '') {
    const acotados = candidatos.filter((p) => coincideConDesambiguacion(disambiguation, p));
    if (acotados.length === 1) return { candidatos, elegido: acotados[0], razon: 'disambiguated' };
  }
  return { candidatos, elegido: undefined, razon: 'ambiguous' };
}

// ─────────────────────────── Resumen derivado del entregable ───────────────────

/**
 * Estado agregado de un entregable. Se DERIVA de sus versiones: no se almacena.
 *
 *   sin_guion                        aún sin versiones.
 *   en_curso                         sin aprobada; la última sigue abierta (recibida o en revisión).
 *   cambios_solicitados              sin aprobada; la última tiene cambios solicitados.
 *   aprobado                         hay aprobada vigente y ninguna más nueva sigue abierta.
 *   aprobado_con_nueva_en_revision   hay aprobada vigente y una versión MÁS NUEVA aún está abierta.
 */
export type ResumenDeEntregable =
  'sin_guion' | 'en_curso' | 'cambios_solicitados' | 'aprobado' | 'aprobado_con_nueva_en_revision';

export interface VersionParaResumen {
  readonly version: number;
  readonly status: ScriptVersionStatus;
}

export function resumenDeEntregable(versiones: readonly VersionParaResumen[]): ResumenDeEntregable {
  if (versiones.length === 0) return 'sin_guion';
  const ultima = versiones.reduce((a, b) => (b.version > a.version ? b : a));
  const aprobada = versiones.find((v) => v.status === 'approved');
  if (aprobada !== undefined) {
    const nuevaAbierta = versiones.some((v) => v.version > aprobada.version && isOpenScriptVersion(v.status));
    return nuevaAbierta ? 'aprobado_con_nueva_en_revision' : 'aprobado';
  }
  return ultima.status === 'changes_requested' ? 'cambios_solicitados' : 'en_curso';
}
