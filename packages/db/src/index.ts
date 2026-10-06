/**
 * @tcl-kol-os/db
 *
 * Acceso a datos. Aplica las políticas de `@tcl-kol-os/domain`; nunca las
 * redefine (ADR-008).
 */

export * from './client.ts';
export * from './audit.ts';
export * from './campaigns.ts';
export * from './users.ts';
export * from './storage.ts';
export * from './sources.ts';
export * from './search.ts';
export * from './extraction.ts';
export * from './brief-version.ts';
export * from './transitions.ts';
export * from './manual.ts';
export * from './brief-fields.ts';
export * from './local-questions.ts';
export * from './comments.ts';
export * from './client-review.ts';
export * from './versioning.ts';
export * from './proposed-actions.ts';
export * from './brief-representations.ts';
export * from './brief-workspace.ts';
export * from './influencers.ts';
export * from './campaign-influencers.ts';
export * from './source-sync.ts';
export * from './influencer-import.ts';
export {
  ensamblarContexto,
  derivarNonce,
  hashDeTexto,
  preparacionDeFuente,
  esLegibleParaIA,
  registrarAdjuntoDeArchivo,
  registrarAdjuntoDeEnlace,
} from './agent-context.ts';
export type {
  EntradaDeEnsamblado,
  ContextoEnsamblado,
  InformeDeEnsamblado,
  SeccionDeInforme,
  DegradacionDeContexto,
  MensajeDeVentana,
  Recuperacion,
  AdjuntoRegistrado,
} from './agent-context.ts';
export {
  crearConversacion,
  obtenerConversacion,
  listarConversaciones,
  archivarConversacion,
} from './chat-conversations.ts';
export type { CrearConversacionInput, ListarConversacionesOpciones } from './chat-conversations.ts';
export { publicarMensaje, listarMensajes, obtenerMensaje } from './chat-messages.ts';
export type { PublicarMensajeInput, MensajePublicado, ListarMensajesOpciones } from './chat-messages.ts';
export {
  obtenerRun,
  listarRunsDeConversacion,
  iniciarRun,
  latidoRun,
  cancelarRun,
  confirmarCancelacionDeRun,
  fallarRun,
  completarRun,
  reintentarRun,
  abandonarRunsCaducados,
  registrarLlamadaDeModelo,
  costoDeRun,
} from './agent-runs.ts';
export type {
  IniciarRunInput,
  LatidoDeRun,
  CancelacionDeRun,
  FallarRunInput,
  CitaDeRespuesta,
  CompletarRunInput,
  RunCompletado,
  LlamadaDeModelo,
  CostoDeRun,
  OpcionesDeBarrido,
} from './agent-runs.ts';
export {
  reclamarInvocacion,
  cerrarInvocacion,
  listarInvocacionesDeRun,
  obtenerInvocacion,
} from './agent-tool-invocations.ts';
export type {
  ReclamarInvocacionInput,
  InvocacionReclamada,
  CerrarInvocacionInput,
} from './agent-tool-invocations.ts';
export { trazaDeConversacion, trazaDeRun, trazaDeInvocacion, trazaDeAccionPropuesta } from './chat-trace.ts';
export type {
  TrazaDeConversacion,
  TrazaDeTurno,
  TrazaDeRun,
  TrazaDeInvocacion,
  TrazaCompletaDeInvocacion,
  EfectoDeAuditoria,
  OpcionesDeTraza,
} from './chat-trace.ts';
export {
  ETIQUETA_DE_ESTADO_DE_ADJUNTO,
  obtenerConversacionDeCampana,
  obtenerMensajesDeChat,
  obtenerRunsRecientes,
  listarActividadDeHerramientas,
  listarAccionesDeConversacion,
  listarAccionesPendientesDeCampana,
  obtenerAccionDeChat,
  estadoDeAdjuntos,
  cargarVistaDeChat,
} from './chat-views.ts';
export type {
  VistaDeConversacion,
  VistaDeAdjunto,
  VistaDeCita,
  VistaDeMensaje,
  VistaDeRun,
  VistaDeActividad,
  VistaDeAccionPropuesta,
  VistaDeChat,
  EstadoDeAdjunto,
  OpcionesDeMensajes,
  OpcionesDeRuns,
  OpcionesDeActividad,
  OpcionesDeVistaDeChat,
} from './chat-views.ts';
export { migrate } from './migrate.ts';
export {
  crearEntregable,
  actualizarEntregable,
  archivarEntregable,
  reactivarEntregable,
  obtenerEntregable,
  listarEntregablesDeCampana,
  bloquearEntregable,
} from './deliverables.ts';
export type {
  CrearEntregableInput,
  ActualizarEntregableInput,
  EntregableDeEstado,
  EntregableDeCuenta,
  EntregableProyectado,
  ListarEntregablesOpciones,
  OpcionesDeLecturaDeEntregable,
  PaginaDeEntregables,
  VersionResumida,
  VersionVigenteResumida,
} from './deliverables.ts';
export {
  registrarVersionDeGuion,
  listarVersionesDeEntregable,
  obtenerVersionDeGuion,
  obtenerVersionVigente,
  obtenerUltimaVersion,
  iniciarRevisionDeVersion,
  iniciarRevisionDeVersionEnTransaccion,
} from './script-versions.ts';
export type {
  RegistrarVersionDeGuionInput,
  RegistroDeGuion,
  CandidatoDeParticipacion,
  CandidatoDeEntregable,
  VersionDeGuionDetalle,
  OpcionesDeLecturaDeVersion,
  ListarVersionesOpciones,
  PaginaDeVersiones,
  RevisionIniciada,
} from './script-versions.ts';
