/**
 * Contrato de lectura consolidado del Brief Workspace (Sprint 6).
 *
 * Un único modelo estable para la interfaz — React nunca ensambla el dominio
 * a partir de varias llamadas sueltas. `packages/db` lo construye
 * (`obtenerBriefWorkspace`), componiendo funciones de repositorio que ya
 * existen; este archivo solo define la forma.
 *
 * Dos proyecciones separadas a propósito (nunca la misma con propiedades
 * ocultas por CSS): esta es la interna. La del cliente es
 * `CampoParaCliente`/`VistaCliente` (Fase D de Sprint 5) — comentarios,
 * procedencia, costo y modelo de IA no tienen ninguna forma de filtrarse
 * porque el tipo que llega al cliente nunca los declaró.
 *
 * Checkpoint 2 (Revisar brief + Actividad) extiende este mismo contrato en
 * vez de crear una proyección paralela — `sections` ya servía a
 * `WorkspaceGuiado`; ahora también lleva evidencia y nivel para que
 * "Revisar brief" no tenga que volver a consultar la base.
 */

import type { RepresentationSummary } from './representations';
import type { Criticality, FieldStatus, Language, ProvenanceType, ReviewStatus, Role } from './types';
import type { BriefStatus } from './types';
import type { CampoNivel, CampoValueType } from './brief-catalog';

/**
 * Producto de campaña, con el nombre legible que `CampaignProduct` (tipo de
 * dominio general, `types.ts`) deja fuera a propósito — la experiencia
 * guiada necesita decir "TCL C755", no solo un id. Extiende el dato de
 * negocio para la vista, nunca lo reemplaza.
 */
export interface WorkspaceProduct {
  readonly id: string;
  readonly model: string;
  readonly brand: string;
  readonly rol: string;
}

/** Una decisión pendiente — hoy siempre una `local_question` sin responder ni descartar. */
export interface WorkspaceTask {
  readonly questionId: string;
  readonly key: string;
  readonly label: string;
  readonly question: string;
  readonly reason: string;
  readonly criticidad: Criticality;
  readonly campaignProductId?: string | undefined;
  readonly valueType: CampoValueType;
  readonly valoresPermitidos?: readonly string[] | undefined;
  readonly requiereEvidencia: boolean;
}

export interface WorkspaceEvidence {
  readonly quote: string;
  readonly filename: string;
  readonly sourceId: string;
  readonly page?: number | undefined;
  readonly slide?: number | undefined;
  readonly section?: string | undefined;
  readonly linea?: number | undefined;
}

export interface WorkspaceSectionField {
  readonly key: string;
  readonly label: string;
  readonly value: unknown;
  readonly status: FieldStatus;
  readonly reviewStatus: ReviewStatus;
  readonly provenanceType: ProvenanceType;
  readonly criticidad: Criticality;
  readonly campaignProductId?: string | undefined;
  /** `producto` | `campana` | `compartido_con_excepcion` (DEC-016) — separa lo compartido de la excepción. */
  readonly nivel: CampoNivel;
  readonly hasEvidence: boolean;
  /** Cita, fuente y ubicación — se consulta bajo demanda en la UI, nunca precargada visualmente. */
  readonly evidence: readonly WorkspaceEvidence[];
}

export interface WorkspaceSection {
  readonly id: string;
  readonly titulo: string;
  readonly total: number;
  readonly completos: number;
  readonly fields: readonly WorkspaceSectionField[];
}

/**
 * Línea de actividad unificada — derivada de `audit_events`,
 * `brief_field_revisions` y `field_comments` existentes, nunca una tabla
 * nueva. `kind` distingue el origen porque cada uno ofrece atributos
 * distintos (una revisión de campo trae valor anterior/nuevo; un
 * comentario trae contenido y estado abierto/resuelto; un evento genérico
 * de auditoría solo trae el tipo y el actor).
 */
export interface WorkspaceActivityItem {
  readonly id: string;
  readonly kind: 'evento' | 'revision_campo' | 'comentario';
  readonly tipo: string;
  readonly detalle?: string | undefined;
  readonly actorName: string | undefined;
  readonly actorRole?: Role | undefined;
  readonly fieldKey?: string | undefined;
  readonly fieldLabel?: string | undefined;
  readonly valorAnterior?: unknown;
  readonly valorNuevo?: unknown;
  /** Solo para `kind: 'comentario'`. */
  readonly status?: 'abierto' | 'resuelto' | undefined;
  readonly createdAt: string;
}

/** Una transición que el dominio permite desde el estado actual — nunca reimplementada aquí. */
export interface WorkspaceAllowedAction {
  readonly to: BriefStatus;
  readonly label: string;
}

export interface WorkspaceProgress {
  readonly percentage: number;
  readonly total: number;
  readonly ready: number;
  /** Campos críticos o claim sin resolver — bloquean enviar a revisión interna. */
  readonly decisionsPending: number;
  readonly criticalPending: number;
  /** Claims con valor pero sin evidencia documental — nunca cuentan como completos. */
  readonly evidencePending: number;
  readonly commentsOpen: number;
}

export interface WorkspaceVersionSummary {
  readonly id: string;
  readonly number: number;
  readonly status: BriefStatus;
  readonly createdAt: string;
  readonly isCurrent: boolean;
}

/**
 * A quién le toca actuar y por qué, en una frase — se arma en el servidor a
 * partir de `allowedActions`/estado/contadores (§3.5 del pedido), para que
 * la UI nunca tenga que hardcodear una segunda matriz de transiciones.
 */
export interface WorkspaceResponsibility {
  readonly nextRole?: Role | undefined;
  readonly message: string;
}

export interface BriefWorkspace {
  readonly campaign: {
    readonly id: string;
    readonly name: string;
    readonly status: string;
  };
  /** `undefined` cuando la campaña todavía no tiene ninguna versión del brief. */
  readonly version?:
    | {
        readonly id: string;
        readonly number: number;
        readonly status: BriefStatus;
        /** Idioma original de la versión lógica. NO es identidad: ES y EN comparten estado y aprobación. */
        readonly language: Language;
        readonly editable: boolean;
        /**
         * Representaciones lingüísticas de la versión (V2 · Fase 2): ES / EN como
         * vistas de la MISMA versión, con su estado de sincronización.
         */
        readonly representations: readonly RepresentationSummary[];
      }
    | undefined;
  readonly products: readonly WorkspaceProduct[];
  readonly progress: WorkspaceProgress;
  readonly sections: readonly WorkspaceSection[];
  readonly tasks: readonly WorkspaceTask[];
  /**
   * Derivada de `audit_events`, `brief_field_revisions` y `field_comments`
   * existentes — nunca una segunda fuente de auditoría.
   */
  readonly activity: readonly WorkspaceActivityItem[];
  readonly allowedActions: readonly WorkspaceAllowedAction[];
  /** Otras versiones del mismo brief — para "esta versión fue reemplazada por la versión N". */
  readonly history: readonly WorkspaceVersionSummary[];
  readonly responsibility: WorkspaceResponsibility;
}
