/**
 * Tipos canónicos del dominio.
 *
 * Corresponden al modelo de datos de `docs/architecture/D0-08-modelo-datos.md`
 * y a la sección 10.1 del documento maestro.
 */

// ─────────────────────────── Organización y usuarios ───────────────────────────

export type OrganizationType = 'agencia' | 'cliente';

/**
 * Roles del sistema. Ver `docs/product/D0-07-matriz-roles-permisos.md`.
 *
 * En MVP 1 solo se construye `admin` (DEC-011), pero los seis se modelan desde
 * el inicio para no rehacer el control de acceso al incorporar consultores.
 */
export type Role = 'admin' | 'director' | 'consultor' | 'analista' | 'legal' | 'cliente';

export const ROLES: readonly Role[] = [
  'admin',
  'director',
  'consultor',
  'analista',
  'legal',
  'cliente',
] as const;

export interface Organization {
  readonly id: string;
  readonly name: string;
  readonly type: OrganizationType;
  readonly status: 'activa' | 'inactiva';
}

export interface User {
  readonly id: string;
  readonly email: string;
  readonly name: string;
  readonly organizationId: string;
  readonly role: Role;
  readonly status: 'activo' | 'inactivo';
}

// ─────────────────────────── Clasificación y visibilidad ───────────────────────

/** Niveles de la sección 12.2 del documento maestro. */
export type ConfidentialityLevel = 'publica' | 'interna' | 'confidencial' | 'sensible';

export type Visibility = 'interna' | 'tcl' | 'compartida';

/**
 * Campos que todo recurso consultable debe llevar (§3.4).
 * Son la base del aislamiento entre organizaciones.
 */
export interface ResourceScope {
  readonly organizationId: string;
  readonly campaignId?: string | undefined;
  readonly confidentialityLevel: ConfidentialityLevel;
  readonly visibility: Visibility;
  readonly createdBy: string;
}

// ─────────────────────────── Brief ─────────────────────────────────────────────

/** Los doce estados de la sección 7.3. */
export type BriefStatus =
  | 'draft'
  | 'processing'
  | 'extraction_review'
  | 'local_questions'
  | 'internal_review'
  | 'internal_changes_requested'
  | 'client_review'
  | 'client_changes_requested'
  | 'approved'
  | 'superseded'
  | 'cancelled'
  | 'processing_failed';

export type Language = 'es' | 'en';

/** Estado de un campo del brief. Ver D0-05 §3. */
export type FieldStatus = 'found' | 'not_found' | 'conflict' | 'manual';

/** Distingue hecho, inferencia y aporte local (§9.4). */
export type ProvenanceType = 'extracted' | 'inferred' | 'manual_local' | 'translated';

/**
 * Determina si un campo exige evidencia.
 * - `informativo`: no la exige.
 * - `critico`: campo obligatorio del brief.
 * - `claim`: afirmación verificable sobre el producto. Exige evidencia sin excepción.
 */
export type Criticality = 'informativo' | 'critico' | 'claim';

export interface Evidence {
  readonly sourceId: string;
  readonly fragmentId?: string | undefined;
  readonly page?: number | undefined;
  readonly slide?: number | undefined;
  /** Cita literal. Permite verificar sin abrir el original. */
  readonly quote: string;
  readonly relation: 'soporta' | 'contradice' | 'contexto';
}

export interface BriefField {
  readonly key: string;
  readonly value: unknown;
  readonly status: FieldStatus;
  readonly confidence?: number | undefined;
  readonly provenanceType: ProvenanceType;
  readonly criticidad: Criticality;
  readonly evidence: readonly Evidence[];
}

export interface BriefVersion {
  readonly id: string;
  readonly briefId: string;
  readonly version: number;
  readonly language: Language;
  readonly parentVersionId?: string | undefined;
  readonly translationOfId?: string | undefined;
  readonly status: BriefStatus;
  readonly fields: readonly BriefField[];
  readonly createdBy: string;
  readonly createdAt: string;
}

export interface LocalQuestion {
  readonly id: string;
  readonly campaignId: string;
  readonly key: string;
  readonly question: string;
  readonly reason: string;
  readonly status: 'pendiente' | 'respondida' | 'descartada';
  readonly answer?: string | undefined;
  readonly answeredBy?: string | undefined;
}
