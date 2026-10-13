/**
 * Manifiesto de import-boundary (V2 · Fase 6, D15).
 *
 * CLASIFICA cada export de valor de `@tcl-kol-os/db` (lo que cuelga de
 * `packages/db/src/index.ts`) según lo que el agente puede hacer con él:
 *
 *   read-tool       lectura con alcance de actor: la usan las tools de solo lectura.
 *   write-tool      caso de uso con efecto, dentro de los permisos de la persona: la
 *                   usan las tools de escritura (siempre con `origin: 'chat'`).
 *   proposal-tool   `proponerAccion`: deja una propuesta pendiente; nunca ejecuta.
 *   runtime-only    la usa el runtime/executor (ciclo del run, claim de invocaciones,
 *                   releer al actor, ensamblar contexto…), nunca una tool.
 *   ui-only         pertenece a la UI, la infraestructura o a v1.1 diferido: el agente
 *                   no la usa (lecturas de chat de la UI, cancelar/reintentar runs,
 *                   publicar mensajes, funciones diferidas…).
 *   prohibited      el agente NO puede llamarla bajo ninguna circunstancia: decide por
 *                   la persona (aprobar, confirmar, ejecutar, visibilidad, archivar…),
 *                   evita la autorización (SQL directo, `recordAudit`, `getPool`) o
 *                   recibe la organización como parámetro en vez de un actor.
 *
 * Un export de db sin clasificar es `prohibited` por omisión: el test estático
 * (`manifest.test.ts`) FALLA hasta que alguien lo clasifique a conciencia. Por
 * eso un caso de uso nuevo nunca llega al agente por accidente.
 *
 * Nota sobre `transicionarBrief`: no es una función prohibida en bloque (la tool
 * `brief_request_internal_review` la usa), sino con el destino FIJADO en
 * `use-cases.ts` (`internal_review`). Llamarla con `approved` está prohibido y el
 * test lo comprueba sobre el código. Aprobar solo existe como propuesta que
 * confirma una persona en la interfaz.
 */

export type ClasificacionDeExport =
  'read-tool' | 'write-tool' | 'proposal-tool' | 'runtime-only' | 'ui-only' | 'prohibited';

export const CLASIFICACIONES: readonly ClasificacionDeExport[] = [
  'read-tool',
  'write-tool',
  'proposal-tool',
  'runtime-only',
  'ui-only',
  'prohibited',
] as const;

const R = 'read-tool' as const;
const W = 'write-tool' as const;
const P = 'proposal-tool' as const;
const RT = 'runtime-only' as const;
const UI = 'ui-only' as const;
const X = 'prohibited' as const;

/** Un export de db → su clasificación. */
export const MANIFIESTO_DE_DB: Readonly<Record<string, ClasificacionDeExport>> = {
  // ── client.ts ── SQL directo: ninguna tool toca la base fuera de un caso de uso.
  getPool: X,
  closePool: UI,
  query: X,
  queryOne: X,
  transaction: X,

  // ── audit.ts ── el agente no escribe ni lee la auditoría por su cuenta.
  sanitizeCorrelation: UI,
  validarCorrelacion: UI,
  resolveOrigin: UI,
  sanitizeMetadata: UI,
  recordAudit: X,
  listAudit: X,
  actividadReciente: X,
  listBriefActivity: X,

  // ── campaigns.ts ──
  listCampaigns: UI, // el chat es de UNA campaña; listar las demás no es un caso de uso del agente
  getCampaign: R,
  comoProductoDeDominio: UI,
  avisoDeReparto: UI,
  createCampaign: X, // la conversación ya es de una campaña
  archiveCampaign: X, // irreversible
  actualizarCampana: W, // ÚNICO caso de uso nuevo de la fase (campaign_update_metadata)

  // ── users.ts ──
  findUserByEmail: X, // login
  findUserById: RT, // el executor relee al actor antes de cada tool
  listProducts: UI,

  // ── storage.ts ── sistema de archivos: nunca desde una tool.
  rutaBase: X,
  calcularHash: UI,
  extensionSegura: UI,
  guardarOriginal: X,
  rutaAbsoluta: X,
  leerOriginal: X,

  // ── sources.ts ──
  resolverAlcanceDeFuentes: UI,
  listSources: R,
  getSource: R,
  getFragments: UI, // sin tope ni política de lectura para IA: se usa obtenerRepresentacionNormalizada
  obtenerRepresentacionNormalizada: R,
  setSourceVisibility: X, // exponer a TCL es una decisión humana irreversible
  uploadSource: UI, // los adjuntos entran por la ruta HTTP del chat, no por una tool
  registerLinkedSource: W, // se usa vía registrarAdjuntoDeEnlace
  retrySource: UI, // diferido a v1.1

  // ── search.ts ──
  buscarEvidencia: X, // recibe la organización como parámetro, no un actor
  buscarEvidenciaComoActor: UI, // sin cliente TS de embeddings (diferido)
  estadoDelIndice: X,
  buscarTextoEnFuentes: R,

  // ── extraction.ts ──
  productosDeCampana: X,
  extraerCampos: X,
  persistirExtraccion: X,
  camposDeVersion: X,
  extraerBrief: W,
  reintentarExtraccion: W,
  versionesDelBrief: R,
  verCamposDeVersion: R,

  // ── brief-version.ts / manual.ts ──
  obtenerOCrearVersionDeTrabajo: X,
  cargarRepresentaciones: X,
  cargarVersion: X,
  crearBriefManual: UI, // diferido a v1.1

  // ── transitions.ts ──
  transicionarBrief: W, // SOLO con destino fijo `internal_review` (use-cases.ts); `approved` prohibido
  transicionarBriefEnTransaccion: X,
  motivoDeUltimaDevolucion: UI,

  // ── brief-fields.ts ── (confirmar/corregir campos: diferido a v1.1)
  confirmarCampo: UI,
  corregirCampo: UI,
  declararExcepcionProducto: UI,
  revertirExcepcionProducto: UI,
  resolverConflicto: UI, // permitiría satisfacer guardas de revisión: fuera de v1
  listBriefFieldRevisions: UI,

  // ── local-questions.ts ──
  generarPreguntas: W,
  listarPreguntas: R,
  responderPregunta: W,
  descartarPregunta: UI, // permitiría saltar guardas: fuera de v1

  // ── comments.ts ── (escribiría en nombre de la persona: diferido)
  listarComentarios: UI,
  listarComentariosDeVersion: UI,
  contarConversacionesAbiertas: UI,
  crearComentario: UI,
  resolverComentario: UI,
  reabrirComentario: UI,

  // ── client-review.ts / versioning.ts ── decisiones de revisor o irreversibles.
  solicitarCambiosInternos: X,
  aprobarBrief: X,
  crearVersionHija: X,

  // ── proposed-actions.ts ──
  huellaDeAccion: UI,
  proponerAccion: P, // el ÚNICO camino del agente hacia una decisión: dejar una propuesta pendiente
  confirmarAccion: X, // confirmar es de la persona, canal `ui`
  ejecutarAccion: X, // ejecutar es de la persona, canal `ui`
  cancelarAccion: UI,
  obtenerAccionPropuesta: R,
  obtenerAccionPropuestaComoActor: R,
  vencerAccionesCaducadas: UI,

  // ── brief-representations.ts ──
  obtenerVersionLogica: UI,
  obtenerRepresentacion: UI,
  registrarTraduccion: X, // acepta `system` y puede dejar traducciones desactualizadas que bloquean aprobar

  // ── brief-workspace.ts ──
  obtenerBriefWorkspace: R,

  // ── influencers.ts ── (identidad del influencer: v1 solo lee participaciones)
  auditoriaDe: UI,
  exigirPersona: UI,
  NO_ENCONTRADO: UI,
  SELECT_INFLUENCER: X, // SQL crudo
  SELECT_CUENTA: X,
  comoInfluencer: UI,
  comoCuenta: UI,
  cuentasDe: X, // recibe un cliente de BD, sin actor
  crearInfluencer: X,
  actualizarInfluencer: X,
  agregarCuenta: X,
  actualizarCuenta: X,
  obtenerInfluencer: UI, // diferido a v1.1 (influencer_get)
  listarInfluencers: UI,
  buscarInfluencerPorCuenta: UI,

  // ── campaign-influencers.ts ──
  asociarInfluencerACampana: X,
  retirarInfluencerDeCampana: X,
  reactivarInfluencerEnCampana: X,
  obtenerCampaignInfluencer: R,
  listarInfluencersDeCampana: UI, // se usa la variante con conteo
  listarInfluencersDeCampanaConConteo: R,
  asociarProductoAInfluencer: X,
  desasociarProducto: X,

  // ── source-sync.ts ──
  syncGoogleSheetSource: W,
  getSyncRun: R,
  listSyncRuns: UI,
  cargarRejillaDeSnapshot: X, // recibe un cliente de BD, sin actor

  // ── influencer-import.ts ──
  validateInfluencerSheetSnapshot: R,
  prepareInfluencerImport: W,
  getImportPlan: R,
  listImportPlans: UI,
  compareSheetSnapshots: UI,
  applyInfluencerImport: X, // aplicar es una propuesta que confirma una persona
  resolveImportRecord: X, // idem
  leerDecisionDeImportacion: UI,
  validarAplicacionDePlan: X, // internas del handler HITL (db)
  validarResolucionDeRegistro: X,
  materialDePlan: X,
  materialDeRegistro: X,
  getParticipationOrigin: R,

  // ── agent-context.ts ──
  ensamblarContexto: RT,
  derivarNonce: RT,
  hashDeTexto: RT,
  preparacionDeFuente: R,
  esLegibleParaIA: R,
  registrarAdjuntoDeArchivo: UI, // ruta HTTP de adjuntos
  registrarAdjuntoDeEnlace: W,

  // ── chat-conversations.ts / chat-messages.ts ──
  crearConversacion: UI,
  obtenerConversacion: RT,
  listarConversaciones: UI,
  archivarConversacion: UI,
  publicarMensaje: UI,
  listarMensajes: RT,
  obtenerMensaje: RT,

  // ── agent-runs.ts ──
  obtenerRun: RT,
  listarRunsDeConversacion: UI,
  iniciarRun: RT,
  latidoRun: RT,
  cancelarRun: UI,
  confirmarCancelacionDeRun: RT,
  fallarRun: RT,
  completarRun: RT,
  reintentarRun: UI,
  abandonarRunsCaducados: RT,
  registrarLlamadaDeModelo: RT,
  costoDeRun: RT,

  // ── agent-tool-invocations.ts ──
  reclamarInvocacion: RT, // el executor, nunca una tool
  cerrarInvocacion: RT,
  listarInvocacionesDeRun: RT,
  obtenerInvocacion: UI,

  // ── chat-trace.ts / migrate.ts ──
  trazaDeConversacion: UI,
  trazaDeRun: UI,
  trazaDeInvocacion: UI,
  trazaDeAccionPropuesta: UI,
  ETIQUETA_DE_ESTADO_DE_ADJUNTO: UI,
  obtenerConversacionDeCampana: UI,
  obtenerMensajesDeChat: UI,
  obtenerRunsRecientes: UI,
  listarActividadDeHerramientas: UI,
  listarAccionesDeConversacion: UI,
  listarAccionesPendientesDeCampana: UI,
  obtenerAccionDeChat: UI,
  estadoDeAdjuntos: UI,
  cargarVistaDeChat: UI,
  migrate: UI,

  // ── Fase 7 · deliverables.ts / script-versions.ts ── (contenido: entregables y guiones)
  // Lecturas con alcance de actor (el cerco de campaña lo pasa la tool en `alcance`).
  listarEntregablesDeCampana: R,
  obtenerEntregable: R,
  listarVersionesDeEntregable: R,
  obtenerVersionDeGuion: R,
  obtenerVersionVigente: R,
  obtenerUltimaVersion: R,
  // Escrituras dentro de los permisos de la persona (`deliverable_create`, `script_version_register`).
  crearEntregable: W,
  registrarVersionDeGuion: W,
  // Comprobación previa y sin efectos del destino de un guion (la usa la subida web antes de guardar bytes);
  // ninguna tool la necesita: `script_version_register` ya resuelve el destino dentro del registro.
  comprobarDestinoDeGuion: UI,
  // Utilidad de formato de ids (no es un caso de uso): la usa la capa web para validar ids de la URL.
  esUuid: UI,
  // Sin tool en F7: renombrar es de la UI; el primer acto de revisión lo hacen los casos de uso.
  actualizarEntregable: UI,
  iniciarRevisionDeVersion: UI,
  // Prohibidas: archivar/reactivar es decisión de la persona; el resto recibe un cliente de BD
  // (sin pasar por la transacción del caso de uso) o es el mutex interno.
  archivarEntregable: X,
  reactivarEntregable: X,
  iniciarRevisionDeVersionEnTransaccion: X, // recibe un cliente de BD
  bloquearEntregable: X, // mutex interno; SQL directo

  // ── Fase 7 · script-review.ts ── (comentarios SmartPR y cambios solicitados)
  // El autor es siempre la persona (nunca el modelo): `review_comment_add` y `script_request_changes`
  // fijan origen `chat` y `chatMessageId` desde el run; la base impone que el texto es cita exacta.
  crearComentarioDeRevision: W,
  solicitarCambiosDeScript: W,
  listarComentariosDeRevision: R,

  // ── Fase 7 · content-analysis.ts / content-analysis-client.ts ── (revisión del guion contra el Brief rector)
  // Lecturas con alcance de actor (script:read; el Operativo y el cliente no leen revisiones ni hallazgos).
  obtenerBriefRector: R,
  huellaDeBriefRector: R,
  evaluarProntitudDeAnalisis: R,
  obtenerRevisionVigente: R,
  listarRevisiones: R,
  listarHallazgos: R, // texto del modelo/guion/Brief: NO confiable (va en sobre)
  resumenesDeContenidoDeVersiones: R, // solo cifras y estados por versión (`deliverable_list` y la sección `content`)
  // Escritura dentro de los permisos de la persona (`content_analysis_request`, origen chat; idempotente).
  solicitarAnalisisDeGuion: W,
  // La revisión humana la registra UNA PERSONA por `ui`: ninguna tool puede (HUMAN_CONFIRMATION_REQUIRED).
  registrarRevisionHumana: X,
  // Constantes y cliente del worker: infraestructura/pruebas, no capacidades del agente.
  LIMITE_DE_ANALISIS_POR_VERSION: UI,
  PLAZO_DE_ANALISIS_MS: UI,
  crearClienteDeAnalisisHttp: UI,
  resolverUrlDelWorkerDeAnalisis: UI,
  ClienteDeAnalisisGuionado: UI,
  llamadaOk: UI,
  respuestaGuionada: UI,
  falloGuionado: UI,

  // ── Fase 7 · script-approval.ts ── (aprobar un guion es decisión humana: ui directa o HITL)
  // La evaluación (elegibilidad, snapshot, huella) recibe un `db` sin autorizar y revela el payload de la
  // aprobación: es de la UI y del handler; ninguna tool la usa. La lectura autorizada de la UI tampoco.
  evaluarAprobacionDeScript: UI,
  obtenerEvaluacionDeAprobacion: UI,
  // Prohibidas: aprobar solo existe como propuesta (`script_propose_approval` → `proponerAccion`) que una
  // persona confirma por la interfaz, o como aprobación directa de una persona desde la UI.
  aprobarScriptVersion: X,
  aprobarScriptVersionEnTransaccion: X,

  // ── Fase 7 · contenido-views.ts ── (lecturas de presentación SOLO para la UI de Contenido)
  // Componen casos de uso ya existentes y ramifican el DTO por rol dentro de la consulta; incluyen la
  // evaluación y la huella de aprobación y la propuesta pendiente: jamás una tool del agente.
  listarContenidoDeCampana: UI,
  obtenerDeliverableConVersiones: UI,

  // ── Fase 8 · operación y KPIs (DEC-049) ── PAYMENT TRACKING ≠ PAYMENT EXECUTION; el agente jamás ve ni mueve
  // dinero, pagos, envíos, evidencia ni PII. SOLO estos seis tienen puerta: los cinco `…ParaAgente`/KPI de
  // lectura cuyo DTO no tiene dinero ni PII por construcción (aunque el actor sea admin) y el ÚNICO write:
  // registrar un OBJETIVO de KPI (`kpi_target_register`, origen chat con `toolInvocationId`).
  obtenerResumenOperativoParaAgente: R, // operations_summary_list
  obtenerEstadoOperativoParaAgente: R, // operations_participation_status
  obtenerKpiDeParticipacion: R, // kpi_scoreboard_get (solo el bloque `public`; el `internal` se descarta en la tool)
  obtenerHistorialDeKpi: R, // kpi_history_get (solo el bloque `public`)
  obtenerKpiPactadoDelSheet: R, // sheet_kpi_pactado_get (sugerencia; el texto va en un sobre no confiable)
  registrarKpiObjetivo: W, // kpi_target_register (grounding por valor y métrica; jamás mediciones)

  // agreements.ts · términos materiales con fee/moneda: solo la UI de Operativo.
  crearAcuerdo: X,
  registrarVersionDeAcuerdo: X,
  cancelarAcuerdo: X,
  obtenerAcuerdo: X, // devuelve el fee
  listarVersionesDeAcuerdo: X,

  // shipments.ts · logística con costo, transportadora y guía; entregar es un hecho humano.
  crearEnvio: X,
  transicionarEnvio: X,
  listarEnviosDeParticipacion: X,
  obtenerEnvio: X,

  // billing-payment.ts · cuentas de cobro, validación y reporte de pago (payment tracking): nunca el agente.
  registrarDocumentoDeCobro: X,
  validarDocumento: X,
  rechazarDocumento: X,
  anularDocumento: X,
  reportarPago: X,
  cancelarObligacionDePago: X,
  registrarNotaDeCorreccionDePago: X,
  obtenerSeguimientoDePago: X,
  listarDocumentosDeCobro: X,

  // operational-events.ts · hechos que MUEVEN el estado (append-only, solo `ui`) y su mutex transaccional.
  aplicarEventoOperativo: X,
  listarEventosOperativos: X, // notas internas y referencias externas
  transaccionOperativa: X, // recibe el cliente de BD

  // ops-evidence.ts / ops-source-scope.ts · evidencia operativa (sensible, interna, sin job ni fragmentos).
  subirEvidenciaOperativa: X,
  adjuntarEvidenciaOperativa: X,
  retractarEvidencia: X,
  listarEvidenciaDeEvento: X,
  listarEvidenciaDeSujeto: X,
  SQL_FUENTE_SIN_EVIDENCIA_OPERATIVA: X, // SQL crudo
  esEvidenciaOperativa: UI, // predicado puro que ya aplica `esLegibleParaIA`

  // pii.ts · cédula, teléfono y dirección cifrados: ni guardar, ni revelar, ni siquiera el resumen.
  guardarPii: X,
  revelarPii: X,
  obtenerPiiResumen: X,

  // kpi-targets.ts / kpi-measurements.ts / kpi-views.ts · lo único del agente es FIJAR un objetivo; medir,
  // corregir y retirar son de una persona por la interfaz.
  retirarKpiObjetivo: X,
  registrarMedicionKpi: X,
  corregirMedicionKpi: X,
  obtenerResumenKpiDeCampana: UI, // la usa el read model de la lista de operación

  // operativo-views.ts · read models RICOS de la UI (con dinero y pagos según el rol): jamás al agente.
  obtenerResumenOperativoDeCampana: X,
  obtenerEstadoOperativoDeParticipacion: X,

  // tcl-projection.ts (Fase 9, DEC-050) · proyección de solo lectura del DASHBOARD TCL (rol `cliente`). No hay
  // agente para TCL ni tools de cliente: ninguna de estas funciones llega al agente de Cuenta, que además las
  // rechazaría por rol (el guard exige `cliente`, y el agente rechaza a `cliente` en `agent-context`).
  construirRepresentacionLocalizada: X, // núcleo SIN actor de `obtenerRepresentacion`: no autoriza; solo la proyección TCL
  resumirRepresentaciones: UI, // puro: resume el estado de sincronización de ES/EN
  listarCampanasParaTcl: X,
  obtenerDetalleTclDeCampana: X,
  obtenerInfluencersParaTcl: X,
  obtenerContenidoParaTcl: X,
  obtenerBriefParaTcl: X,
  obtenerOperacionParaTcl: X,
  obtenerKpisParaTcl: X,
  obtenerDocumentosParaTcl: X,
  obtenerProyeccionTclDeCampana: X,
  exportarCampanaParaTcl: X,

  // audit.ts (F8) · allowlist de metadata de eventos operativos: infraestructura.
  esAccionOperativa: UI,
  esAccionDeKpi: UI,
  PREFIJOS_OPERATIVOS: UI,
  sanitizeMetadataOperativa: UI,
};

/** Clasificación de un export (`prohibited` si no está clasificado). */
export function clasificacionDe(nombre: string): ClasificacionDeExport {
  return Object.hasOwn(MANIFIESTO_DE_DB, nombre) ? MANIFIESTO_DE_DB[nombre]! : 'prohibited';
}

/** Exports de db que el agente (use-cases.ts) puede importar. */
export const CLASIFICACIONES_IMPORTABLES: readonly ClasificacionDeExport[] = [
  'read-tool',
  'write-tool',
  'proposal-tool',
  'runtime-only',
] as const;

export function esImportablePorElAgente(nombre: string): boolean {
  return CLASIFICACIONES_IMPORTABLES.includes(clasificacionDe(nombre));
}

/** Los identificadores prohibidos: ningún archivo de `tools/` (salvo este manifiesto) los nombra. */
export function identificadoresProhibidos(): readonly string[] {
  return Object.entries(MANIFIESTO_DE_DB)
    .filter(([, c]) => c === 'prohibited')
    .map(([nombre]) => nombre);
}
