/**
 * Contrato de lectura de una versión lógica con sus representaciones
 * lingüísticas (V2 · Fase 2).
 *
 *   Brief → Versión lógica N → { ES, EN }      Estado único · Aprobación única
 *
 * Es el contrato que consumirán las pantallas (cambiar ES | EN dentro de la
 * misma vista, sin cambiar de versión ni de estado) y, más adelante, otros
 * documentos generados por la plataforma. No hay UI aquí: solo la forma de los
 * datos y las reglas puras.
 */

import type {
  BriefRepresentation,
  BriefStatus,
  Language,
  ProvenanceType,
  RepresentationKind,
  TranslationSyncState,
} from './types';

/** Resumen de sincronización de una representación completa. */
export type RepresentationSync = 'original' | 'current' | 'stale' | 'unverified' | 'incomplete';

/**
 * Estado agregado de una representación respecto del original:
 * `stale` (algo cambió después de traducir) manda sobre `unverified`
 * (histórico sin huella), y este sobre `incomplete` (faltan campos).
 */
export function resumirSincronizacion(r: BriefRepresentation): RepresentationSync {
  if (r.kind === 'original') return 'original';
  if (r.staleFieldKeys.length > 0) return 'stale';
  if (r.unverifiedFieldKeys.length > 0) return 'unverified';
  if (r.missingFieldKeys.length > 0) return 'incomplete';
  return 'current';
}

/** ¿La representación equivale exactamente al contenido original vigente? */
export function esEquivalenteAlOriginal(r: BriefRepresentation): boolean {
  const s = resumirSincronizacion(r);
  return s === 'original' || s === 'current';
}

export interface RepresentationSummary {
  readonly id: string;
  readonly language: Language;
  readonly kind: RepresentationKind;
  readonly sourceLanguage?: Language | undefined;
  readonly copiedFromRepresentationId?: string | undefined;
  readonly createdAt: string;
  readonly sync: RepresentationSync;
  /** Detalle por campo: solo para personal de SmartPR; nunca para el cliente. */
  readonly staleFieldKeys?: readonly string[] | undefined;
  readonly unverifiedFieldKeys?: readonly string[] | undefined;
  readonly missingFieldKeys?: readonly string[] | undefined;
}

/** Fila EN histórica clasificada por la migración 014 (solo personal de SmartPR). */
export interface LegacyLanguageLink {
  readonly enVersionId: string;
  readonly esVersionId?: string | undefined;
  readonly classification: 'folded' | 'conflict' | 'orphan';
  readonly reason: string;
  readonly detectedAt: string;
}

export interface LogicalBriefVersion {
  readonly id: string;
  readonly briefId: string;
  readonly campaignId: string;
  readonly version: number;
  /** Estado ÚNICO de la versión lógica, para todas sus representaciones. */
  readonly status: BriefStatus;
  readonly parentVersionId?: string | undefined;
  readonly approvedAt?: string | undefined;
  readonly createdAt: string;
  readonly originalLanguage: Language;
  readonly representations: Readonly<Partial<Record<Language, RepresentationSummary>>>;
  /** Inconsistencias históricas pendientes de intervención explícita. */
  readonly legacyLanguageLinks: readonly LegacyLanguageLink[];
}

export interface LocalizedField {
  readonly key: string;
  readonly campaignProductId: string | null;
  /** `undefined` si falta la traducción (sync `missing`). */
  readonly value: unknown;
  readonly status: string;
  /** Procedencia del valor en ESTA representación (translated, manual_local, extracted…). */
  readonly provenanceType: ProvenanceType;
  readonly sync: TranslationSyncState | 'original';
  /** Idioma/representación de la que deriva (solo traducciones). */
  readonly sourceLanguage?: Language | undefined;
  readonly translator?: 'ai' | 'human' | 'legacy' | undefined;
  /** Evidencia ORIGINAL que respalda el valor (compartida entre idiomas). */
  readonly evidencias: ReadonlyArray<{
    readonly quote: string;
    readonly filename: string;
    readonly page: number | null;
    readonly slide: number | null;
    readonly section: string | null;
  }>;
}

export interface LocalizedRepresentation {
  readonly versionId: string;
  readonly language: Language;
  readonly kind: RepresentationKind;
  readonly sync: RepresentationSync;
  readonly fields: readonly LocalizedField[];
}
