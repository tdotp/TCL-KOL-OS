/**
 * Catálogo v1 de tools del agente de Cuenta (ARQUITECTURA-F6-CONGELADA §2).
 *
 *   14 READ · 8 WRITE · 3 CONFIRMATION_REQUIRED = 25 tools.
 *
 * PROHIBITED (no se registran): aprobar el brief, confirmar/ejecutar acciones propuestas,
 * pedir cambios internos, crear versiones hijas, cambiar la visibilidad de una fuente,
 * archivar/crear campañas, y retirar/reactivar/desasociar/actualizar influencers o
 * cuentas. Ver `manifest.ts`.
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
import {
  briefProposeApproval,
  proposedActionGet,
  sheetProposeApply,
  sheetProposeResolution,
} from './hitl.ts';
import {
  influencerGetOrigin,
  influencerGetParticipation,
  influencerListParticipants,
} from './influencers.ts';
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
  // WRITE
  campaignUpdateMetadata,
  sourceRegisterLink,
  briefExtract,
  briefGenerateQuestions,
  briefAnswerQuestion,
  briefRequestInternalReview,
  sheetSync,
  sheetPrepareImportPlan,
  // CONFIRMATION_REQUIRED
  briefProposeApproval,
  sheetProposeApply,
  sheetProposeResolution,
];
