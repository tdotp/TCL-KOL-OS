/**
 * Contrato de lectura consolidado del Brief Workspace (Sprint 6, Fase B).
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
 */

import type { Criticality, FieldStatus, Language, ProvenanceType, ReviewStatus, Role } from './types';
import type { BriefStatus } from './types';
import type { CampoValueType } from './brief-catalog';

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

export interface WorkspaceSectionField {
  readonly key: string;
  readonly label: string;
  readonly value: unknown;
  readonly status: FieldStatus;
  readonly reviewStatus: ReviewStatus;
  readonly provenanceType: ProvenanceType;
  readonly criticidad: Criticality;
  readonly campaignProductId?: string | undefined;
  readonly hasEvidence: boolean;
}

export interface WorkspaceSection {
  readonly id: string;
  readonly titulo: string;
  readonly total: number;
  readonly completos: number;
  readonly fields: readonly WorkspaceSectionField[];
}

export interface WorkspaceActivityItem {
  readonly id: string;
  readonly actorName: string | undefined;
  readonly action: string;
  readonly entityType: string;
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
        readonly language: Language;
        readonly editable: boolean;
      }
    | undefined;
  readonly products: readonly WorkspaceProduct[];
  readonly progress: WorkspaceProgress;
  readonly sections: readonly WorkspaceSection[];
  readonly tasks: readonly WorkspaceTask[];
  /**
   * Derivada de `audit_events` existentes (campaña, versión, campos,
   * preguntas, comentarios) — nunca una segunda fuente de auditoría.
   */
  readonly activity: readonly WorkspaceActivityItem[];
  readonly allowedActions: readonly WorkspaceAllowedAction[];
  /** A quién le toca mover la versión — puramente informativo, la UI arma la frase. */
  readonly nextResponsibleRole?: Role | undefined;
}
