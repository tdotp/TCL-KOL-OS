/**
 * ÚNICA puerta del paquete `@tcl-kol-os/agent` hacia `@tcl-kol-os/db` (D15).
 *
 * Lista blanca explícita: aquí solo se importan funciones que `manifest.ts`
 * clasifica como `read-tool`, `write-tool`, `proposal-tool` o `runtime-only`. Ningún
 * otro archivo de `packages/agent/src` importa de db (lo comprueba
 * `manifest.test.ts`), y nada que el manifiesto marque `prohibited` aparece aquí.
 *
 * Las tools son adaptadores finos: todo lo que hacen lo hacen estos casos de uso, que
 * ya autorizan por actor y organización, auditan y aplican las reglas del dominio.
 *
 * Para el RUNTIME (`runtime/**`): también deben salir de este archivo las funciones
 * `runtime-only` (ciclo del run, claim de invocaciones, ensamblado de contexto…).
 */

import type { User } from '@tcl-kol-os/domain';
import {
  // ── lecturas ──
  buscarTextoEnFuentes,
  esLegibleParaIA,
  getCampaign,
  getImportPlan,
  getParticipationOrigin,
  getSource,
  getSyncRun,
  listSources,
  listarComentariosDeRevision,
  listarEntregablesDeCampana,
  listarHallazgos,
  listarInfluencersDeCampanaConConteo,
  listarPreguntas,
  listarVersionesDeEntregable,
  evaluarProntitudDeAnalisis,
  obtenerAccionPropuesta,
  obtenerBriefWorkspace,
  obtenerCampaignInfluencer,
  obtenerEntregable,
  obtenerRepresentacionNormalizada,
  obtenerRevisionVigente,
  obtenerVersionDeGuion,
  preparacionDeFuente,
  resumenesDeContenidoDeVersiones,
  validateInfluencerSheetSnapshot,
  versionesDelBrief,
  // ── escrituras (dentro de los permisos de la persona; siempre con origin 'chat') ──
  actualizarCampana,
  crearComentarioDeRevision,
  crearEntregable,
  extraerBrief,
  generarPreguntas,
  prepareInfluencerImport,
  registrarAdjuntoDeEnlace,
  registrarVersionDeGuion,
  reintentarExtraccion,
  responderPregunta,
  solicitarAnalisisDeGuion,
  solicitarCambiosDeScript,
  syncGoogleSheetSource,
  transicionarBrief,
  // ── propuestas HITL ──
  proponerAccion,
  // ── runtime / executor ──
  abandonarRunsCaducados,
  cerrarInvocacion,
  completarRun,
  confirmarCancelacionDeRun,
  costoDeRun,
  derivarNonce,
  ensamblarContexto,
  fallarRun,
  findUserById,
  hashDeTexto,
  iniciarRun,
  latidoRun,
  listarInvocacionesDeRun,
  listarMensajes,
  obtenerConversacion,
  obtenerMensaje,
  obtenerRun,
  reclamarInvocacion,
  registrarLlamadaDeModelo,
} from '@tcl-kol-os/db';
import type { ContextoDeAuditoria } from '@tcl-kol-os/db';

export {
  // lecturas
  buscarTextoEnFuentes,
  esLegibleParaIA,
  getCampaign,
  getImportPlan,
  getParticipationOrigin,
  getSource,
  getSyncRun,
  listSources,
  listarComentariosDeRevision,
  listarEntregablesDeCampana,
  listarHallazgos,
  listarInfluencersDeCampanaConConteo,
  listarPreguntas,
  listarVersionesDeEntregable,
  evaluarProntitudDeAnalisis,
  obtenerAccionPropuesta,
  obtenerBriefWorkspace,
  obtenerCampaignInfluencer,
  obtenerEntregable,
  obtenerRepresentacionNormalizada,
  obtenerRevisionVigente,
  obtenerVersionDeGuion,
  preparacionDeFuente,
  resumenesDeContenidoDeVersiones,
  validateInfluencerSheetSnapshot,
  versionesDelBrief,
  // escrituras
  actualizarCampana,
  crearComentarioDeRevision,
  crearEntregable,
  extraerBrief,
  generarPreguntas,
  prepareInfluencerImport,
  registrarAdjuntoDeEnlace,
  registrarVersionDeGuion,
  reintentarExtraccion,
  responderPregunta,
  solicitarAnalisisDeGuion,
  solicitarCambiosDeScript,
  syncGoogleSheetSource,
  // propuestas
  proponerAccion,
  // runtime / executor
  abandonarRunsCaducados,
  cerrarInvocacion,
  completarRun,
  confirmarCancelacionDeRun,
  costoDeRun,
  derivarNonce,
  ensamblarContexto,
  fallarRun,
  findUserById,
  hashDeTexto,
  iniciarRun,
  latidoRun,
  listarInvocacionesDeRun,
  listarMensajes,
  obtenerConversacion,
  obtenerMensaje,
  obtenerRun,
  reclamarInvocacion,
  registrarLlamadaDeModelo,
};

// ─────────────────────────── Tipos que cruzan la frontera ──────────────────────

export type {
  ActualizarCampanaInput,
  AdjuntoRegistrado,
  CampaignWithProducts,
  CampanaActualizada,
  ContextoDeAuditoria,
  CostoDeRun,
  ComentarioDeRevision,
  EntregableDeCuenta,
  HallazgoDeContenido,
  ImportDecision,
  ImportPlanDetail,
  ImportRecordView,
  LocalQuestionRow,
  PaginaDeComentarios,
  PaginaDeEntregables,
  PaginaDeHallazgos,
  PaginaDeParticipantes,
  PaginaDeVersiones,
  ParticipationOrigin,
  RegistroDeGuion,
  ResumenDeContenidoDeVersion,
  ResultadoDeCambiosSolicitados,
  ResultadoDeComentario,
  RevisionVigente,
  AnalisisSolicitado,
  ProntitudDeVersion,
  SourceRow,
  SyncRun,
  TextoHit,
  VersionDeGuionDetalle,
  VersionDelBrief,
} from '@tcl-kol-os/db';

// ─────────────────────────── Envolturas con destino FIJO ───────────────────────

/**
 * Pide pasar la versión del brief a revisión interna. El destino está FIJADO aquí:
 * la tool no elige el estado, y `approved` no se puede pedir por ningún camino (el
 * canal se declara `chat`, con el que el caso de uso rechaza además los destinos
 * críticos). Aprobar solo existe como propuesta que confirma una persona en la UI.
 */
export async function solicitarRevisionInternaDelBrief(
  actor: User,
  versionId: string,
  contexto: ContextoDeAuditoria,
) {
  return transicionarBrief(actor, versionId, 'internal_review', {
    origen: 'chat',
    correlation: contexto.correlation,
  });
}
