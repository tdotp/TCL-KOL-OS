/**
 * Catálogo v1 de tools del agente de Cuenta (ARQUITECTURA-F6-CONGELADA §2).
 *
 *   24 READ · 14 WRITE · 4 CONFIRMATION_REQUIRED = 42 tools (25 de la Fase 6 + 11 de la Fase 7 + 6 de la Fase 8).
 *
 * PROHIBITED (no se registran): aprobar el brief, confirmar/ejecutar acciones propuestas,
 * pedir cambios internos, crear versiones hijas, cambiar la visibilidad de una fuente,
 * archivar/crear campañas, retirar/reactivar/desasociar/actualizar influencers o
 * cuentas, y —Fase 7— aprobar o confirmar un guion, registrar la revisión humana,
 * archivar/reactivar un entregable y resolver hallazgos, y —Fase 8— todo lo que toque
 * acuerdos, envíos, facturación, pagos, eventos, evidencia, PII y mediciones de KPI
 * (el agente solo LEE estado operativo sin dinero ni PII y fija OBJETIVOS de KPI). Ver `manifest.ts`.
 */

import type { AnyToolDefinition } from '../types.ts';
import {
  briefAnswerQuestion,
  briefExtract,
  briefGenerateQuestions,
  briefGetWorkspace,
  briefListQuestions,
  briefRequestInternalReview,
} from './brief.ts';
import { campaignGet, campaignUpdateMetadata } from './campaign.ts';
import { deliverableCreate, deliverableGet, deliverableList } from './entregables.ts';
import { contentAnalysisRequest, scriptVersionGet, scriptVersionRegister } from './guiones.ts';
import {
  briefProposeApproval,
  proposedActionGet,
  scriptProposeApproval,
  sheetProposeApply,
  sheetProposeResolution,
} from './hitl.ts';
import {
  influencerGetOrigin,
  influencerGetParticipation,
  influencerListParticipants,
} from './influencers.ts';
import {
  kpiHistoryGet,
  kpiScoreboardGet,
  kpiTargetRegister,
  operationsParticipationStatus,
  operationsSummaryList,
  sheetKpiPactadoGet,
} from './operacion.ts';
import { findingList, reviewCommentAdd, reviewCommentList, scriptRequestChanges } from './revision.ts';
import {
  sheetGetImportPlan,
  sheetGetSyncRun,
  sheetPrepareImportPlan,
  sheetSync,
  sheetValidate,
} from './sheets.ts';
import { sourceGet, sourceList, sourceReadContent, sourceRegisterLink, sourceSearchText } from './sources.ts';

export const CATALOGO_V1: readonly AnyToolDefinition[] = [
  // READ
  campaignGet,
  sourceList,
  sourceGet,
  sourceReadContent,
  sourceSearchText,
  briefGetWorkspace,
  briefListQuestions,
  proposedActionGet,
  influencerListParticipants,
  influencerGetParticipation,
  influencerGetOrigin,
  sheetGetSyncRun,
  sheetValidate,
  sheetGetImportPlan,
  // READ (Fase 7: contenido)
  deliverableList,
  deliverableGet,
  scriptVersionGet,
  findingList,
  reviewCommentList,
  // READ (Fase 8: operación y KPIs; sin dinero ni PII)
  operationsSummaryList,
  operationsParticipationStatus,
  kpiScoreboardGet,
  kpiHistoryGet,
  sheetKpiPactadoGet,
  // WRITE
  campaignUpdateMetadata,
  sourceRegisterLink,
  briefExtract,
  briefGenerateQuestions,
  briefAnswerQuestion,
  briefRequestInternalReview,
  sheetSync,
  sheetPrepareImportPlan,
  // WRITE (Fase 7: contenido)
  deliverableCreate,
  scriptVersionRegister,
  contentAnalysisRequest,
  reviewCommentAdd,
  scriptRequestChanges,
  // WRITE (Fase 8: único write de operación; solo OBJETIVOS de KPI)
  kpiTargetRegister,
  // CONFIRMATION_REQUIRED
  briefProposeApproval,
  sheetProposeApply,
  sheetProposeResolution,
  // CONFIRMATION_REQUIRED (Fase 7: contenido)
  scriptProposeApproval,
];
