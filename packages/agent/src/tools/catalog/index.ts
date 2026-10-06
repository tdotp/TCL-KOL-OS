/**
 * Catálogo v1 de tools del agente de Cuenta (ARQUITECTURA-F6-CONGELADA §2).
 *
 *   19 READ · 13 WRITE · 4 CONFIRMATION_REQUIRED = 36 tools (25 de la Fase 6 + 11 de la Fase 7).
 *
 * PROHIBITED (no se registran): aprobar el brief, confirmar/ejecutar acciones propuestas,
 * pedir cambios internos, crear versiones hijas, cambiar la visibilidad de una fuente,
 * archivar/crear campañas, retirar/reactivar/desasociar/actualizar influencers o
 * cuentas, y —Fase 7— aprobar o confirmar un guion, registrar la revisión humana,
 * archivar/reactivar un entregable y resolver hallazgos. Ver `manifest.ts`.
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
  // CONFIRMATION_REQUIRED
  briefProposeApproval,
  sheetProposeApply,
  sheetProposeResolution,
  // CONFIRMATION_REQUIRED (Fase 7: contenido)
  scriptProposeApproval,
];
