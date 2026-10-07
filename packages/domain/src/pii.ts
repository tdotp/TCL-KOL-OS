/**
 * Datos personales del KOL (V2 · Fase 8, DEC-013/DEC-049): tipos y validaciones PURAS.
 *
 * NADA de cifrado aquí (AES-256-GCM vive en `packages/db/src/pii.ts` con `node:crypto`; la base nunca ve la
 * clave). Este módulo define qué campos existen, cómo se normalizan y validan ANTES de cifrar, la forma del
 * envoltorio que la base verifica (CHECK de la migración 028) y el resumen SIN valores.
 *
 *   · La PII (cédula, teléfono, dirección) es de la PERSONA (influencer), no de la participación.
 *   · Jamás en el agente, el índice vectorial, la auditoría en claro, `ai_runs`, logs ni errores.
 *   · `pii:read` es explícito y auditado (`pii.reveal` registra NOMBRES de campo, jamás valores).
 */

import { type Result, err, ok } from './errors';

// ─────────────────────────── Campos ────────────────────────────────────────────

export type PiiField = 'document_id' | 'phone' | 'address';

export const PII_FIELDS: readonly PiiField[] = ['document_id', 'phone', 'address'] as const;

export function isPiiField(value: unknown): value is PiiField {
  return typeof value === 'string' && (PII_FIELDS as readonly string[]).includes(value);
}

/** Columna cifrada (bytea) de cada campo en `influencer_pii_records`. */
export const PII_COLUMN_BY_FIELD: Readonly<Record<PiiField, string>> = {
  document_id: 'document_id_enc',
  phone: 'phone_enc',
  address: 'address_enc',
};

// ─────────────────────────── Envoltorio cifrado ────────────────────────────────

/** Versión de formato del envoltorio: primer byte de cada campo cifrado. */
export const PII_ENVELOPE_VERSION = 1;
/** AES-256-GCM: IV de 12 bytes y etiqueta de autenticación de 16. */
export const PII_IV_LENGTH = 12;
export const PII_TAG_LENGTH = 16;
/** Mínimo: versión (1) + IV (12) + etiqueta (16) = 29 (texto cifrado vacío). La base lo repite en un CHECK. */
export const PII_ENVELOPE_MIN_LENGTH = 1 + PII_IV_LENGTH + PII_TAG_LENGTH;
/** HMAC-SHA-256 de la cédula normalizada (índice ciego): 32 bytes. */
export const PII_BLIND_INDEX_LENGTH = 32;

/**
 * ¿Los bytes tienen la forma del envoltorio (versión 0x01 y longitud mínima)? Rechaza texto plano
 * accidental; NO descifra ni autentica (eso lo hace la capa con la clave).
 */
export function esEnvoltorioPiiValido(bytes: Uint8Array): boolean {
  return bytes.length >= PII_ENVELOPE_MIN_LENGTH && bytes[0] === PII_ENVELOPE_VERSION;
}

/** `key_id`: identificador (no secreto) de la clave de cifrado; la base lo valida con el mismo patrón. */
export function esKeyIdValido(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,64}$/u.test(value);
}

// ─────────────────────────── Normalización y validación ────────────────────────

const CONTROL = /[\p{Cc}\p{Cf}]/u;

function invalido<T>(field: string, message: string): Result<T> {
  return err({ code: 'VALIDATION_FAILED', message, details: { field } });
}

/**
 * Documento de identidad (cédula, CE, pasaporte): quita espacios, puntos, comas y guiones, pasa a
 * mayúsculas y exige 5–20 caracteres alfanuméricos con al menos un dígito. Es la forma que alimenta el
 * índice ciego (así «1.234.567-8» y «12345678» coinciden).
 */
export function normalizarDocumentoDeIdentidad(raw: unknown): Result<string> {
  if (typeof raw !== 'string') return invalido('documentId', 'El documento de identidad es obligatorio.');
  const limpio = raw
    .normalize('NFKC')
    .replace(/[\s.,-]/gu, '')
    .toUpperCase();
  if (!/^[A-Z0-9]{5,20}$/u.test(limpio) || !/\d/u.test(limpio)) {
    return invalido('documentId', 'El documento de identidad debe tener entre 5 y 20 letras o números.');
  }
  return ok(limpio);
}

/**
 * Teléfono: quita espacios, puntos, guiones y paréntesis; admite un `+` inicial; 7–15 dígitos (E.164).
 * Devuelve el `+` (si lo había) seguido de los dígitos.
 */
export function normalizarTelefono(raw: unknown): Result<string> {
  if (typeof raw !== 'string') return invalido('phone', 'El teléfono es obligatorio.');
  const limpio = raw.normalize('NFKC').replace(/[\s.()-]/gu, '');
  if (!/^\+?\d{7,15}$/u.test(limpio)) {
    return invalido('phone', 'El teléfono debe tener entre 7 y 15 dígitos (con + opcional al inicio).');
  }
  return ok(limpio);
}

export const MIN_DIRECCION = 5;
export const MAX_DIRECCION = 300;

/** Dirección: colapsa espacios, 5–300 caracteres, sin caracteres de control, con al menos una letra o número. */
export function normalizarDireccion(raw: unknown): Result<string> {
  if (typeof raw !== 'string') return invalido('address', 'La dirección es obligatoria.');
  const limpio = raw.normalize('NFC').replace(/\s+/gu, ' ').trim();
  if (limpio.length < MIN_DIRECCION || limpio.length > MAX_DIRECCION) {
    return invalido(
      'address',
      `La dirección debe tener entre ${MIN_DIRECCION} y ${MAX_DIRECCION} caracteres.`,
    );
  }
  if (CONTROL.test(limpio) || !/[\p{L}\p{N}]/u.test(limpio)) {
    return invalido('address', 'La dirección contiene caracteres no válidos.');
  }
  return ok(limpio);
}

export interface PiiInput {
  readonly documentId?: unknown;
  readonly phone?: unknown;
  readonly address?: unknown;
}

export interface NormalizedPii {
  readonly documentId?: string;
  readonly phone?: string;
  readonly address?: string;
}

/**
 * Valida y normaliza lo que se va a GUARDAR (al menos un campo; los ausentes no se tocan). El resultado es lo
 * que se cifra; nunca debe registrarse, auditarse ni devolverse en errores.
 */
export function validarEntradaPii(input: PiiInput): Result<NormalizedPii> {
  const salida: { documentId?: string; phone?: string; address?: string } = {};
  const presente = (v: unknown): boolean => v !== undefined && v !== null && v !== '';
  if (presente(input.documentId)) {
    const r = normalizarDocumentoDeIdentidad(input.documentId);
    if (!r.ok) return r;
    salida.documentId = r.value;
  }
  if (presente(input.phone)) {
    const r = normalizarTelefono(input.phone);
    if (!r.ok) return r;
    salida.phone = r.value;
  }
  if (presente(input.address)) {
    const r = normalizarDireccion(input.address);
    if (!r.ok) return r;
    salida.address = r.value;
  }
  if (Object.keys(salida).length === 0) {
    return invalido('pii', 'Informe al menos un dato personal (documento, teléfono o dirección).');
  }
  return ok(salida);
}

// ─────────────────────────── Resumen y auditoría SIN valores ───────────────────

/**
 * Resumen de un registro de PII: qué campos EXISTEN y de qué versión, nunca sus valores.
 * Es lo único que ven los roles sin `pii:read` y lo único que viaja a lecturas generales.
 */
export interface PiiSummary {
  readonly recordId: string;
  readonly influencerId: string;
  readonly version: number;
  readonly hasDocumentId: boolean;
  readonly hasPhone: boolean;
  readonly hasAddress: boolean;
  readonly erased: boolean;
}

/** Campos presentes (por nombre) de un resumen: lo que `pii.reveal`/`pii.save` pueden auditar. */
export function camposPresentes(
  resumen: Pick<PiiSummary, 'hasDocumentId' | 'hasPhone' | 'hasAddress'>,
): readonly PiiField[] {
  const campos: PiiField[] = [];
  if (resumen.hasDocumentId) campos.push('document_id');
  if (resumen.hasPhone) campos.push('phone');
  if (resumen.hasAddress) campos.push('address');
  return campos;
}

/** Valida los NOMBRES de campo que se piden revelar (sin repetidos, al menos uno). */
export function validarCamposARevelar(campos: readonly unknown[]): Result<readonly PiiField[]> {
  if (campos.length === 0) return invalido('fields', 'Indique qué campos revelar.');
  const vistos = new Set<PiiField>();
  for (const campo of campos) {
    if (!isPiiField(campo)) return invalido('fields', 'Campo de datos personales no reconocido.');
    vistos.add(campo);
  }
  return ok([...vistos]);
}

// ─────────────────────────── Aviso en texto libre ──────────────────────────────

/**
 * ¿El texto libre PARECE llevar datos personales (correo, teléfono, cédula o dirección)? Heurística SOLO para
 * avisar en la UI («no escriba datos personales»); no bloquea ni garantiza nada.
 */
export function textoPodriaContenerPii(texto: string): boolean {
  if (/[^\s@]+@[^\s@]+\.[^\s@]+/u.test(texto)) return true;
  // Corridas de ≥ 7 dígitos (con separadores habituales): teléfono o cédula.
  if (/(?:\d[\s.-]?){7,}/u.test(texto)) return true;
  // Dirección colombiana típica: nomenclatura seguida de un número.
  if (
    /\b(?:calle|carrera|cra|cl|cll|kr|avenida|av|diagonal|diag|transversal|tv|apto|apartamento|torre|casa|barrio)\b\.?\s*#?\s*\d/iu.test(
      texto,
    )
  ) {
    return true;
  }
  return false;
}
