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

/**
 * Estado de revisión humana de un campo (Sprint 4, corrección 2 del cierre).
 * Independiente de `FieldStatus`: un campo puede estar `found` (la IA lo
 * encontró) y seguir `pending` de revisión — nadie lo ha confirmado ni
 * corregido todavía. Persistido, no derivado en memoria: debe seguir siendo
 * visible tras recargar la página.
 */
export type ReviewStatus = 'pending' | 'confirmed' | 'corrected';

/** Precisión real de una fecha cuando la fuente no da un día exacto (DEC-026). */
export type DatePrecision = 'exacta' | 'mes' | 'rango' | 'aproximada' | 'pendiente_confirmar';

export interface PrecisedDate {
  readonly tipo: DatePrecision;
  readonly fecha?: string | undefined;
  readonly inicio?: string | undefined;
  readonly fin?: string | undefined;
  readonly textoOriginal?: string | undefined;
}

export interface BriefField {
  readonly id: string;
  readonly key: string;
  /** Producto al que se ancla el campo (DEC-016/DEC-023). `undefined` = de campaña o compartido. */
  readonly campaignProductId?: string | undefined;
  readonly value: unknown;
  readonly status: FieldStatus;
  readonly confidence?: number | undefined;
  readonly provenanceType: ProvenanceType;
  readonly criticidad: Criticality;
  readonly evidence: readonly Evidence[];
  readonly reviewStatus: ReviewStatus;
  readonly reviewedBy?: string | undefined;
  readonly reviewedAt?: string | undefined;
  /** Contador de control optimista (corrección 7). Se incrementa en cada `UPDATE`. */
  readonly revision: number;
}

/**
 * Historial de contenido de un campo (corrección 5 del cierre de Sprint 4).
 * Vive separado de `AuditEvent`: la auditoría general nunca guarda valores de
 * negocio, solo qué pasó y quién. Esta tabla sí guarda el contenido.
 */
export interface BriefFieldRevision {
  readonly id: string;
  readonly briefFieldId: string;
  readonly briefVersionId: string;
  readonly accion: 'confirm' | 'correct' | 'resolve_conflict' | 'apply_answer';
  readonly valorAnterior: unknown;
  readonly valorNuevo: unknown;
  readonly motivo?: string | undefined;
  readonly actorId?: string | undefined;
  readonly createdAt: string;
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
  readonly briefVersionId?: string | undefined;
  readonly key: string;
  /** Producto al que se ancla la pregunta (§5.2). `undefined` = de campaña o compartida. */
  readonly campaignProductId?: string | undefined;
  readonly question: string;
  readonly reason: string;
  readonly criticidad: Criticality;
  readonly status: 'pendiente' | 'respondida' | 'descartada';
  /**
   * Texto libre: la justificación del descarte, o una explicación de la
   * respuesta. Nunca el valor estructurado que se aplica al campo — ese vive
   * en `answerValue` (corrección 3 del cierre de Sprint 4).
   */
  readonly answer?: string | undefined;
  /** Valor estructurado a aplicar sobre `BriefField.value`. `undefined` si se descartó. */
  readonly answerValue?: unknown;
  readonly answeredBy?: string | undefined;
  readonly answeredAt?: string | undefined;
  readonly createdAt: string;
}

// ─────────────────────────── Campañas y productos ──────────────────────────────

export type CampaignProductRole = 'flagship' | 'secundario' | 'entrada' | 'unico';

/**
 * Producto de una campaña multiproducto (DEC-016). Tipo de negocio compartido:
 * vive en domain porque tanto `packages/db` como `apps/web` lo necesitan sin
 * reinterpretarlo (ADR-008). La forma de fila SQL (`snake_case`) sigue siendo
 * responsabilidad de `packages/db` — este tipo no la reemplaza, es lo que cruza
 * la frontera hacia la aplicación.
 */
export interface CampaignProduct {
  readonly id: string;
  readonly campaignId: string;
  readonly productId: string;
  readonly rol: CampaignProductRole;
  readonly prioridad: number;
  readonly participacionPresupuesto?: number | undefined;
}
