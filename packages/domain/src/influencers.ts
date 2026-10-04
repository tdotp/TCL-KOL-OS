/**
 * Influencer y CampaignInfluencer (V2 · Fase 3).
 *
 *   Influencer          = quién es la persona / el creador (identidad estable).
 *   InfluencerAccount   = una cuenta suya en una plataforma (identidad fuerte).
 *   CampaignInfluencer  = qué significa ese influencer dentro de UNA campaña.
 *
 * La identidad no lleva nada de una campaña concreta (fee, producto, fechas,
 * estado operativo…): eso cuelga de `CampaignInfluencer` o de entidades futuras
 * que lo referencien. Aquí viven los tipos y las reglas puras (normalización
 * de handles, validación de entrada); la persistencia está en `packages/db`.
 */

import { type Result, err, ok } from './errors';

// ─────────────────────────── Plataformas ───────────────────────────────────────

export type SocialPlatform = 'instagram' | 'tiktok' | 'youtube' | 'x' | 'facebook' | 'twitch';

export const SOCIAL_PLATFORMS: readonly SocialPlatform[] = [
  'instagram',
  'tiktok',
  'youtube',
  'x',
  'facebook',
  'twitch',
] as const;

export function isSocialPlatform(value: unknown): value is SocialPlatform {
  return typeof value === 'string' && (SOCIAL_PLATFORMS as readonly string[]).includes(value);
}

/**
 * Diferencias reales entre plataformas, en un solo sitio. Hoy todas las
 * plataformas admitidas tratan el handle sin distinguir mayúsculas. Si se añade
 * una que sí distinga (p. ej. identificadores de canal), se declara aquí y la
 * migración correspondiente relaja la restricción `lower()` de la base para
 * esa plataforma: no se «normaliza» a ciegas lo que la plataforma distingue.
 */
const POLITICA_DE_HANDLE: Readonly<Record<SocialPlatform, { readonly distingueMayusculas: boolean }>> = {
  instagram: { distingueMayusculas: false },
  tiktok: { distingueMayusculas: false },
  youtube: { distingueMayusculas: false },
  x: { distingueMayusculas: false },
  facebook: { distingueMayusculas: false },
  twitch: { distingueMayusculas: false },
};

// ─────────────────────────── Entidades ─────────────────────────────────────────

export type CampaignInfluencerStatus = 'activo' | 'retirado';

export interface Influencer {
  readonly id: string;
  readonly organizationId: string;
  readonly displayName: string;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface InfluencerAccount {
  readonly id: string;
  readonly influencerId: string;
  readonly organizationId: string;
  readonly platform: SocialPlatform;
  /** Como se escribió (sin `@` inicial). Solo presentación. */
  readonly handle: string;
  /** Clave de identidad: es lo que se compara. Ver `normalizeHandle`. */
  readonly normalizedHandle: string;
  readonly profileUrl?: string | undefined;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface InfluencerWithAccounts {
  readonly influencer: Influencer;
  readonly accounts: readonly InfluencerAccount[];
}

/** La participación de un influencer en una campaña. Punto de anclaje futuro. */
export interface CampaignInfluencer {
  readonly id: string;
  readonly organizationId: string;
  readonly campaignId: string;
  readonly influencerId: string;
  readonly status: CampaignInfluencerStatus;
  readonly retiredAt?: string | undefined;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * Producto de la campaña asignado a un influencer. Referencia al
 * `campaign_products` real (no a un texto): lo que se muestra de la relación
 * es solo lo que identifica el producto, sin el reparto de presupuesto.
 */
export interface AssignedProduct {
  readonly campaignProductId: string;
  readonly productId: string;
  readonly brand: string;
  readonly model: string;
  readonly category: string;
  readonly rol: string;
  readonly assignedAt: string;
}

export interface CampaignInfluencerDetail {
  readonly campaignInfluencer: CampaignInfluencer;
  readonly influencer: Influencer;
  readonly accounts: readonly InfluencerAccount[];
  readonly products: readonly AssignedProduct[];
}

// ─────────────────────────── Normalización y validación ────────────────────────

const MAX_NOMBRE = 200;
const MAX_HANDLE = 100;
const MAX_URL = 500;

/** Letras, números, punto, guion bajo y guion. Nada de espacios, `@` ni `/`. */
const HANDLE_VALIDO = /^[\p{L}\p{N}._-]+$/u;
const CARACTERES_DE_CONTROL = /[\p{Cc}\p{Cf}]/u;

export interface NormalizedHandle {
  /** Como se escribió, sin `@` inicial. */
  readonly handle: string;
  /** Clave determinística de comparación. */
  readonly normalized: string;
}

function invalido<T>(field: string, message: string): Result<T> {
  return err({ code: 'VALIDATION_FAILED', message, details: { field } });
}

/**
 * Nombre de presentación: se recortan los extremos y se colapsan los espacios
 * internos. NO es clave de identidad (dos personas pueden llamarse igual).
 */
export function normalizeDisplayName(raw: unknown): Result<string> {
  if (typeof raw !== 'string') return invalido('displayName', 'El nombre del influencer es obligatorio.');
  const limpio = raw.normalize('NFC').replace(/\s+/gu, ' ').trim();
  if (limpio === '') return invalido('displayName', 'El nombre del influencer no puede quedar vacío.');
  if (limpio.length > MAX_NOMBRE) {
    return invalido('displayName', `El nombre no puede superar ${MAX_NOMBRE} caracteres.`);
  }
  if (CARACTERES_DE_CONTROL.test(limpio)) {
    return invalido('displayName', 'El nombre contiene caracteres no válidos.');
  }
  return ok(limpio);
}

/**
 * Regla ÚNICA de normalización de un handle (determinística, sin fuzzy):
 *
 *   1. Unicode NFKC (las variantes de ancho completo se igualan a su forma base).
 *   2. Se recortan los extremos y se quita UN `@` inicial.
 *   3. Debe quedar texto compuesto solo por letras, números, `.`, `_` y `-`:
 *      sin espacios, sin `@` ni `/` internos, sin caracteres invisibles.
 *   4. Se pasa a minúsculas salvo que la plataforma distinga mayúsculas.
 *
 * NO se tocan los signos: `valentina.rojas` y `valentinarojas` son cuentas
 * distintas. Tampoco se extraen handles de URLs ni se «adivina» nada.
 */
export function normalizeHandle(platform: SocialPlatform, raw: unknown): Result<NormalizedHandle> {
  if (!isSocialPlatform(platform)) return invalido('platform', 'La plataforma no es válida.');
  if (typeof raw !== 'string') return invalido('handle', 'El handle es obligatorio.');

  let handle = raw.normalize('NFKC').trim();
  if (handle.startsWith('@')) handle = handle.slice(1);

  if (handle === '') return invalido('handle', 'El handle no puede quedar vacío.');
  if (handle.length > MAX_HANDLE) {
    return invalido('handle', `El handle no puede superar ${MAX_HANDLE} caracteres.`);
  }
  if (!HANDLE_VALIDO.test(handle)) {
    return invalido('handle', 'El handle solo admite letras, números, punto, guion bajo y guion.');
  }

  const normalized = POLITICA_DE_HANDLE[platform].distingueMayusculas ? handle : handle.toLowerCase();
  return ok({ handle, normalized });
}

/** URL de perfil opcional: solo http(s). Vacío o `null` = sin URL. */
export function normalizeProfileUrl(raw: unknown): Result<string | undefined> {
  if (raw === undefined || raw === null) return ok(undefined);
  if (typeof raw !== 'string') return invalido('profileUrl', 'La URL del perfil no es válida.');
  const limpia = raw.trim();
  if (limpia === '') return ok(undefined);
  if (limpia.length > MAX_URL) {
    return invalido('profileUrl', `La URL no puede superar ${MAX_URL} caracteres.`);
  }
  let url: URL;
  try {
    url = new URL(limpia);
  } catch {
    return invalido('profileUrl', 'La URL del perfil no es válida.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return invalido('profileUrl', 'La URL del perfil debe empezar por http:// o https://.');
  }
  return ok(limpia);
}
