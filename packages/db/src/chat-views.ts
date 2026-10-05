/**
 * Lecturas de PRESENTACIÓN del chat de Cuenta (V2 · Fase 6, Wave 3).
 *
 * La interfaz del chat no consume las entidades del dominio ni las filas SQL: consume
 * estos DTO, pensados para mostrarse y NO para decidir nada.
 *
 *  · Todos los lectores reciben una PERSONA (`User`), devuelven `Result` y son
 *    owner-scoped (D3): una conversación la ve su creador. Otra organización, un
 *    cliente, un usuario inactivo u otra persona reciben `RESOURCE_NOT_FOUND`
 *    (la misma respuesta que un id inexistente). Sin `chat:read` → `FORBIDDEN_ROLE`.
 *  · Reutilizan las lecturas y la política existentes (`chatCargarMensajes`,
 *    `listarRunsDeConversacion`, `listSources` + `preparacionDeFuente`,
 *    `obtenerAccionPropuesta`, `puedeConfirmar/puedeEjecutar/puedeCancelar`,
 *    `handlerDe(...).verificarVigente`): aquí no hay reglas de negocio nuevas.
 *  · Lo que NUNCA sale hacia la interfaz: `external_url`/`canonical_url`, rutas de
 *    almacenamiento, hashes de archivo, argumentos y resultados crudos de las
 *    tools, el JSON del payload de las propuestas, el manifiesto de contexto, el
 *    proveedor/modelo del run ni nombres internos de herramientas. De una tool solo
 *    se lee una ETIQUETA en español que inyecta quien llama (`etiquetar`).
 *  · Ninguna de estas funciones crea ni modifica nada: un GET no crea conversaciones.
 */

import {
  type AgentRun,
  type AgentRunStatus,
  type ChatMessage,
  type ProposedAction,
  type ProposedActionStatus,
  type ProposedActionType,
  type Result,
  type Role,
  type ToolInvocationStatus,
  type ToolRiskClass,
  type User,
  AGENT_RUN_HEARTBEAT_TIMEOUT_MINUTES,
  AGENT_RUN_QUEUED_TIMEOUT_MINUTES,
  ROLES,
  describirLocalizador,
  err,
  ok,
  puedeCancelar,
  puedeConfirmar,
  puedeEjecutar,
  rolPuedeConfirmar,
  specDeAccion,
  validarLocalizador,
} from '@tcl-kol-os/domain';
import { assertCapability } from './authz.ts';
import { getPool } from './client.ts';
import {
  CHAT_NO_ENCONTRADO,
  chatCargarConversacionAutorizada,
  chatCargarMensajes,
  chatEstadoDeCampana,
} from './chat-conversations.ts';
import { listarRunsDeConversacion } from './agent-runs.ts';
import { preparacionDeFuente } from './agent-context.ts';
import { handlerDe } from './proposed-action-handlers.ts';
import { obtenerAccionPropuesta } from './proposed-actions.ts';
import { type SourceRow, listSources } from './sources.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Tope de texto de una etiqueta que puede incrustar contenido de un documento (no confiable). */
const MAX_ETIQUETA = 160;

function recortar(texto: string, max: number): string {
  return texto.length <= max ? texto : `${texto.slice(0, max - 1)}…`;
}

// ─────────────────────────── DTO ───────────────────────────────────────────────

export interface VistaDeConversacion {
  readonly id: string;
  readonly title: string | undefined;
  readonly status: 'active' | 'archived';
  readonly lastSeq: number;
  readonly createdAt: string;
  readonly lastMessageAt: string | undefined;
}

/** Estado de una fuente adjunta, en términos de la persona (no del pipeline). */
export type EstadoDeAdjunto =
  | 'en_cola'
  | 'procesando'
  | 'listo'
  | 'sin_texto'
  | 'fallido'
  | 'enlace_sin_leer'
  | 'restringido'
  | 'desconocido';

export const ETIQUETA_DE_ESTADO_DE_ADJUNTO: Readonly<Record<EstadoDeAdjunto, string>> = {
  en_cola: 'En cola',
  procesando: 'Procesando',
  listo: 'Lista para el asistente',
  sin_texto: 'Guardada, sin texto legible',
  fallido: 'Falló el procesamiento',
  enlace_sin_leer: 'Enlace registrado, aún sin leer',
  restringido: 'Restringida: el asistente no la lee',
  desconocido: 'Estado desconocido',
};

export interface VistaDeAdjunto {
  readonly sourceId: string;
  readonly nombre: string;
  readonly tipo: 'archivo' | 'enlace' | 'desconocido';
  readonly estado: EstadoDeAdjunto;
  readonly etiquetaDeEstado: string;
  /** `true` cuando el estado ya no va a cambiar solo (no hace falta seguir sondeando). */
  readonly terminal: boolean;
}

export interface VistaDeCita {
  readonly ordinal: number;
  readonly sourceId: string;
  /** Nombre de la fuente (archivo o título del enlace); nunca su URL. */
  readonly fuente: string;
  /** Ubicación legible («página 3», «hoja «Q4», rango B2:D9»…). Puede incrustar texto del documento. */
  readonly ubicacion: string | undefined;
  /** El fragmento citado sigue existiendo. */
  readonly conFragmento: boolean;
}

export interface VistaDeMensaje {
  readonly id: string;
  readonly seq: number;
  readonly role: 'user' | 'assistant';
  /** Texto plano. La interfaz lo muestra tal cual: sin markdown, HTML, imágenes ni autoenlaces. */
  readonly content: string;
  readonly createdAt: string;
  readonly runId: string | undefined;
  readonly attachments: readonly VistaDeAdjunto[];
  readonly citations: readonly VistaDeCita[];
}

export interface VistaDeRun {
  readonly id: string;
  readonly userMessageId: string;
  readonly attempt: number;
  readonly status: AgentRunStatus;
  /** Código en MAYÚSCULAS ya sanitizado por el runtime (sin contenido). */
  readonly errorCode: string | undefined;
  /** Mensaje corto y fijo del runtime (sin contenido de documentos ni razonamiento). */
  readonly errorMessage: string | undefined;
  readonly queuedAt: string;
  readonly startedAt: string | undefined;
  readonly finishedAt: string | undefined;
  readonly cancelRequested: boolean;
  /** Activo pero sin latido más allá del plazo: lo cerrará el barrido de abandonados. */
  readonly stale: boolean;
  /** El run se puede cancelar (activo y sin cancelación pendiente). */
  readonly canCancel: boolean;
  /** El turno se puede reintentar (último intento, terminó mal y es el último mensaje). */
  readonly canRetry: boolean;
}

export interface VistaDeActividad {
  readonly id: string;
  readonly runId: string;
  readonly sequence: number;
  /** Etiqueta en español de la herramienta («Consultando el brief»). Nunca el nombre interno. */
  readonly etiqueta: string;
  readonly estado: 'en_curso' | 'completada' | 'fallida' | 'cancelada';
  readonly tipo: 'consulta' | 'cambio' | 'propuesta';
  readonly iniciada: string;
  readonly terminada: string | undefined;
}

export interface VistaDeAccionPropuesta {
  readonly id: string;
  readonly tipo: ProposedActionType;
  readonly titulo: string;
  /** Lo que se le muestra a la persona que confirma: qué se va a aprobar/aplicar/resolver. */
  readonly textoHumano: string;
  readonly detalle: readonly string[];
  /** Huella de lo propuesto (SHA-256 hex). Es la que se presenta al confirmar. */
  readonly payloadHash: string;
  /** Estado EFECTIVO: una propuesta pendiente/confirmada con el plazo vencido figura `expired`. */
  readonly estado: ProposedActionStatus;
  /** Lo propuesto cambió desde que se propuso (la huella ya no corresponde a lo vigente). */
  readonly obsoleta: boolean;
  readonly propuestaPor: string;
  readonly propuestaPorMi: boolean;
  /** `true` si la propuso el asistente (chat) en nombre de esa persona. */
  readonly propuestaPorElAsistente: boolean;
  /** Quién puede confirmarla, en lenguaje llano («Dirección o administración»). */
  readonly quienConfirma: string;
  readonly expiresAt: string;
  readonly createdAt: string;
  readonly confirmedAt: string | undefined;
  readonly executedAt: string | undefined;
  readonly cancelledAt: string | undefined;
  readonly canConfirm: boolean;
  /** Ya confirmada por esta persona pero sin ejecutar: se puede reintentar la ejecución. */
  readonly canRetryExecute: boolean;
  readonly canCancel: boolean;
  /** `true` si pertenece a una conversación de la persona (si no, es un pendiente de otra persona). */
  readonly esDeMiConversacion: boolean;
  /** Run del agente que la propuso (solo si es de una conversación propia): ubica la tarjeta en el hilo. */
  readonly runId: string | undefined;
}

export interface VistaDeChat {
  readonly conversation: VistaDeConversacion;
  readonly messages: readonly VistaDeMensaje[];
  readonly runs: readonly VistaDeRun[];
  readonly activity: readonly VistaDeActividad[];
  /** Propuestas ligadas a ESTA conversación. */
  readonly proposals: readonly VistaDeAccionPropuesta[];
  /** Propuestas pendientes de la campaña (de otras personas) que esta persona puede confirmar. */
  readonly pending: readonly VistaDeAccionPropuesta[];
}

// ─────────────────────────── Conversación ──────────────────────────────────────

function capacidadDeLectura(actor: User): Result<true> {
  const c = assertCapability(actor, 'chat:read');
  return c.ok ? c : err({ code: c.error.code, message: c.error.message });
}

/**
 * La conversación ACTIVA del actor en la campaña. Si, por una carrera al crearlas, hubiera más de
 * una, el desempate es determinista: la que ya tiene actividad (la más reciente) y, entre vacías,
 * la más antigua. NO crea: devuelve `null` si todavía no hay ninguna (la primera se crea al
 * enviar el primer mensaje).
 */
export async function obtenerConversacionDeCampana(
  actor: User,
  campaignId: string,
): Promise<Result<VistaDeConversacion | null>> {
  const capacidad = capacidadDeLectura(actor);
  if (!capacidad.ok) return capacidad;
  if (actor.role === 'cliente' || !UUID.test(campaignId)) return err(CHAT_NO_ENCONTRADO);
  const estado = await chatEstadoDeCampana(getPool(), actor.organizationId, campaignId);
  if (estado === undefined) return err(CHAT_NO_ENCONTRADO);

  const { rows } = await getPool().query<{
    id: string;
    title: string | null;
    status: 'active' | 'archived';
    last_seq: string | number;
    created_at: Date;
    last_message_at: Date | null;
  }>(
    `SELECT id, title, status, last_seq, created_at, last_message_at
       FROM chat_conversations
      WHERE organization_id = $1 AND campaign_id = $2 AND created_by = $3 AND status = 'active'
      ORDER BY (last_seq > 0) DESC, last_message_at DESC NULLS LAST, created_at ASC, id ASC LIMIT 1`,
    [actor.organizationId, campaignId, actor.id],
  );
  const f = rows[0];
  if (f === undefined) return ok(null);
  return ok({
    id: f.id,
    title: f.title ?? undefined,
    status: f.status,
    lastSeq: Number(f.last_seq),
    createdAt: f.created_at.toISOString(),
    lastMessageAt: f.last_message_at?.toISOString(),
  });
}

// ─────────────────────────── Fuentes: adjuntos y citas ─────────────────────────

function estadoDeAdjuntoDe(fila: SourceRow): EstadoDeAdjunto {
  switch (preparacionDeFuente(fila)) {
    case 'ready':
      return 'listo';
    case 'ready_no_text':
      return 'sin_texto';
    case 'queued':
      return 'en_cola';
    case 'running':
      return 'procesando';
    case 'failed':
      return 'fallido';
    case 'link_unresolved':
    case 'link_syncing':
    case 'link_not_syncable':
      return 'enlace_sin_leer';
    case 'restricted':
      return 'restringido';
    case 'unknown':
      return 'desconocido';
  }
}

function vistaDeAdjunto(sourceId: string, fila: SourceRow | undefined): VistaDeAdjunto {
  if (fila === undefined) {
    return {
      sourceId,
      nombre: 'Fuente no disponible',
      tipo: 'desconocido',
      estado: 'desconocido',
      etiquetaDeEstado: ETIQUETA_DE_ESTADO_DE_ADJUNTO.desconocido,
      terminal: true,
    };
  }
  const estado = estadoDeAdjuntoDe(fila);
  return {
    sourceId,
    nombre: recortar(fila.filename, 200),
    tipo: fila.origin === 'link' ? 'enlace' : 'archivo',
    estado,
    etiquetaDeEstado: ETIQUETA_DE_ESTADO_DE_ADJUNTO[estado],
    terminal: estado !== 'en_cola' && estado !== 'procesando',
  };
}

/**
 * Estado de procesamiento de fuentes ya registradas (los chips del cuadro de texto).
 * Solo las de la campaña y con el alcance de lectura del actor; un id ajeno, de otra
 * campaña o inexistente se OMITE (no se distingue).
 */
export async function estadoDeAdjuntos(
  actor: User,
  campaignId: string,
  sourceIds: readonly string[],
): Promise<Result<VistaDeAdjunto[]>> {
  const capacidad = capacidadDeLectura(actor);
  if (!capacidad.ok) return capacidad;
  if (actor.role === 'cliente') return err(CHAT_NO_ENCONTRADO);
  const fuentes = await listSources(actor, campaignId);
  if (!fuentes.ok) return err({ code: fuentes.error.code, message: fuentes.error.message });
  const porId = new Map(fuentes.value.map((f) => [f.id, f]));
  const pedidos = [...new Set(sourceIds)].slice(0, 10);
  return ok(pedidos.filter((id) => porId.has(id)).map((id) => vistaDeAdjunto(id, porId.get(id))));
}

function vistaDeCita(
  r: ChatMessage['references'][number],
  fuentes: ReadonlyMap<string, SourceRow>,
): VistaDeCita {
  let ubicacion: string | undefined;
  if (r.locator !== undefined) {
    const valido = validarLocalizador(r.locator);
    if (valido.ok) ubicacion = recortar(describirLocalizador(valido.value), MAX_ETIQUETA);
  }
  return {
    ordinal: r.ordinal,
    sourceId: r.sourceId,
    fuente: recortar(fuentes.get(r.sourceId)?.filename ?? 'Fuente no disponible', 200),
    ubicacion,
    conFragmento: r.fragmentId !== undefined,
  };
}

// ─────────────────────────── Mensajes ──────────────────────────────────────────

export interface OpcionesDeMensajes {
  /** Máximo de mensajes (los ÚLTIMOS); por defecto 100, tope 200. */
  readonly limite?: number | undefined;
}

/** Mensajes de una conversación propia con adjuntos (estado vigente) y citas legibles. */
export async function obtenerMensajesDeChat(
  actor: User,
  conversationId: string,
  opciones: OpcionesDeMensajes = {},
): Promise<Result<VistaDeMensaje[]>> {
  const cargada = await chatCargarConversacionAutorizada(getPool(), actor, 'chat:read', conversationId);
  if (!cargada.ok) return err(cargada.error);
  const mensajes = await chatCargarMensajes(getPool(), conversationId, {
    ultimos: true,
    limite: opciones.limite ?? 100,
  });

  const fuentes = await listSources(actor, cargada.value.campaignId);
  const porId = new Map<string, SourceRow>((fuentes.ok ? fuentes.value : []).map((f) => [f.id, f]));

  return ok(
    mensajes.map((m): VistaDeMensaje => ({
      id: m.id,
      seq: m.seq,
      role: m.role,
      content: m.content,
      createdAt: m.createdAt,
      runId: m.agentRunId,
      attachments: m.attachments.map((a) => vistaDeAdjunto(a.sourceId, porId.get(a.sourceId))),
      citations: m.references.map((r) => vistaDeCita(r, porId)),
    })),
  );
}

// ─────────────────────────── Runs ──────────────────────────────────────────────

function estaCaducado(run: AgentRun, ahora: Date): boolean {
  if (run.status === 'queued') {
    return new Date(run.queuedAt).getTime() < ahora.getTime() - AGENT_RUN_QUEUED_TIMEOUT_MINUTES * 60_000;
  }
  if (run.status === 'running') {
    const ref = run.heartbeatAt ?? run.startedAt ?? run.queuedAt;
    return new Date(ref).getTime() < ahora.getTime() - AGENT_RUN_HEARTBEAT_TIMEOUT_MINUTES * 60_000;
  }
  return false;
}

export interface OpcionesDeRuns {
  readonly limite?: number | undefined;
  /** Reloj inyectable (pruebas). */
  readonly ahora?: Date | undefined;
}

/**
 * Los runs recientes de una conversación propia (el más antiguo primero). `canRetry` y
 * `canCancel` los calcula `cargarVistaDeChat`, que conoce el último mensaje; aquí van
 * a `false` salvo `canCancel` (que depende solo del run).
 */
export async function obtenerRunsRecientes(
  actor: User,
  conversationId: string,
  opciones: OpcionesDeRuns = {},
): Promise<Result<VistaDeRun[]>> {
  const runs = await listarRunsDeConversacion(actor, conversationId, opciones.limite ?? 20);
  if (!runs.ok) return err(runs.error);
  const ahora = opciones.ahora ?? new Date();
  return ok(
    [...runs.value].reverse().map((r): VistaDeRun => ({
      id: r.id,
      userMessageId: r.userMessageId,
      attempt: r.attempt,
      status: r.status,
      errorCode: r.errorCode,
      errorMessage: r.errorMessage,
      queuedAt: r.queuedAt,
      startedAt: r.startedAt,
      finishedAt: r.finishedAt,
      cancelRequested: r.cancelRequestedAt !== undefined,
      stale: estaCaducado(r, ahora),
      canCancel: (r.status === 'queued' || r.status === 'running') && r.cancelRequestedAt === undefined,
      canRetry: false,
    })),
  );
}

// ─────────────────────────── Actividad de herramientas ─────────────────────────

const ETIQUETA_GENERICA_DE_TOOL = 'Usando una herramienta del asistente';

const ESTADO_DE_ACTIVIDAD: Readonly<Record<ToolInvocationStatus, VistaDeActividad['estado']>> = {
  running: 'en_curso',
  succeeded: 'completada',
  failed: 'fallida',
  cancelled: 'cancelada',
};

const TIPO_DE_ACTIVIDAD: Readonly<Record<ToolRiskClass, VistaDeActividad['tipo']>> = {
  read: 'consulta',
  write: 'cambio',
  confirmation_required: 'propuesta',
  unregistered: 'consulta',
};

export interface OpcionesDeActividad {
  /** Etiqueta en español de una tool por su nombre interno (p. ej. `registry.labelFor`). */
  readonly etiquetar?: ((toolName: string) => string | undefined) | undefined;
  /** Cuántos runs recientes se consideran (por defecto 20). */
  readonly limiteDeRuns?: number | undefined;
}

/**
 * Actividad de herramientas de los runs recientes, LEGIBLE: etiqueta en español y estado.
 * La consulta no selecciona argumentos, resultados, huellas ni ids de llamada; el nombre
 * interno de la tool solo se usa para pedir la etiqueta y nunca sale en el DTO.
 */
export async function listarActividadDeHerramientas(
  actor: User,
  conversationId: string,
  opciones: OpcionesDeActividad = {},
): Promise<Result<VistaDeActividad[]>> {
  const cargada = await chatCargarConversacionAutorizada(getPool(), actor, 'chat:read', conversationId);
  if (!cargada.ok) return err(cargada.error);
  const limite = Math.min(Math.max(Math.trunc(opciones.limiteDeRuns ?? 20), 1), 100);
  const { rows } = await getPool().query<{
    id: string;
    agent_run_id: string;
    sequence: number;
    tool_name: string;
    risk_class: ToolRiskClass;
    status: ToolInvocationStatus;
    started_at: Date;
    finished_at: Date | null;
  }>(
    `SELECT i.id, i.agent_run_id, i.sequence, i.tool_name, i.risk_class, i.status, i.started_at, i.finished_at
       FROM agent_tool_invocations i
       JOIN (
         SELECT id FROM agent_runs WHERE conversation_id = $1 ORDER BY queued_at DESC, attempt DESC LIMIT $2
       ) r ON r.id = i.agent_run_id
      ORDER BY i.started_at ASC, i.sequence ASC`,
    [conversationId, limite],
  );
  return ok(
    rows.map((f): VistaDeActividad => {
      const etiqueta = opciones.etiquetar?.(f.tool_name);
      return {
        id: f.id,
        runId: f.agent_run_id,
        sequence: f.sequence,
        etiqueta: etiqueta === undefined || etiqueta.trim() === '' ? ETIQUETA_GENERICA_DE_TOOL : etiqueta,
        estado: ESTADO_DE_ACTIVIDAD[f.status] ?? 'fallida',
        tipo: TIPO_DE_ACTIVIDAD[f.risk_class] ?? 'consulta',
        iniciada: f.started_at.toISOString(),
        terminada: f.finished_at?.toISOString(),
      };
    }),
  );
}

// ─────────────────────────── Acciones propuestas ───────────────────────────────

const ROL_EN_ESPANOL: Readonly<Partial<Record<Role, string>>> = {
  admin: 'administración',
  director: 'dirección',
  consultor: 'consultoría',
};

/** Quién puede confirmar este tipo de acción, entre quienes usan el chat (admin/director/consultor). */
function quienConfirmaDe(type: string): string {
  const spec = specDeAccion(type);
  if (spec === undefined) return 'una persona con permiso';
  const roles = ROLES.filter((r) => ROL_EN_ESPANOL[r] !== undefined && rolPuedeConfirmar(r, spec)).map(
    (r) => ROL_EN_ESPANOL[r]!,
  );
  if (roles.length === 0) return 'una persona con permiso';
  const texto = roles.join(', ').replace(/, ([^,]*)$/, ' o $1');
  return texto.charAt(0).toUpperCase() + texto.slice(1);
}

function numero(valor: unknown): number | undefined {
  return typeof valor === 'number' && Number.isFinite(valor) ? valor : undefined;
}

function texto(valor: unknown, max = 200): string | undefined {
  return typeof valor === 'string' && valor.trim() !== '' ? recortar(valor.trim(), max) : undefined;
}

const ETIQUETA_DE_ESTADO_DE_REGISTRO: Readonly<Record<string, string>> = {
  actionable: 'listos para aplicar',
  blocked: 'bloqueados',
  invalid: 'con errores',
  review: 'por revisar',
  applied: 'ya aplicados',
  ignored: 'ignorados',
};

const ETIQUETA_DE_DECISION: Readonly<Record<string, string>> = {
  use_existing_influencer: 'usar un influencer que ya existe',
  create_new_influencer: 'crear un influencer nuevo',
  choose_product: 'elegir el producto del registro',
  ignore_record: 'ignorar el registro',
};

interface TextoHumano {
  readonly titulo: string;
  readonly texto: string;
  readonly detalle: readonly string[];
}

/**
 * Texto que se le muestra a la persona, compuesto SOLO con el payload ya huellado (lo que
 * confirma es exactamente lo que ve) y datos de lectura. Nunca se vuelca el JSON.
 */
function componerTexto(accion: ProposedAction, versionDeBrief: number | undefined): TextoHumano {
  const p = accion.payload;
  switch (accion.type) {
    case 'brief.approve':
      return {
        titulo: 'Aprobar el brief',
        texto:
          versionDeBrief === undefined
            ? 'Aprobará una versión del brief de esta campaña.'
            : `Aprobará la versión ${versionDeBrief} del brief de esta campaña.`,
        detalle: [
          'La versión queda aprobada internamente y deja de editarse.',
          'Es una decisión que solo toma una persona con permiso de aprobación.',
        ],
      };
    case 'influencer_import.apply': {
      const muestra = (p['muestra'] ?? {}) as Record<string, unknown>;
      const registros = numero(muestra['registros']);
      const porEstado = (muestra['porEstado'] ?? {}) as Record<string, unknown>;
      const bloqueantes = numero(muestra['bloqueantesAlPlanear']);
      const detalle: string[] = [];
      for (const [estado, etiqueta] of Object.entries(ETIQUETA_DE_ESTADO_DE_REGISTRO)) {
        const n = numero(porEstado[estado]);
        if (n !== undefined && n > 0) detalle.push(`${n} ${etiqueta}`);
      }
      if (bloqueantes !== undefined && bloqueantes > 0) {
        detalle.push(`${bloqueantes} problema(s) bloqueante(s) detectado(s) al planificar`);
      }
      return {
        titulo: 'Aplicar el plan de importación',
        texto:
          registros === undefined
            ? 'Aplicará el plan de importación del Sheet de influencers a esta campaña.'
            : `Aplicará el plan de importación del Sheet de influencers (${registros} registro(s)) a esta campaña.`,
        detalle: [
          'Crea o vincula influencers y sus participaciones en la campaña según el plan.',
          ...detalle,
        ],
      };
    }
    case 'influencer_import.resolve_record': {
      const muestra = (p['muestra'] ?? {}) as Record<string, unknown>;
      const decision = (p['decision'] ?? {}) as Record<string, unknown>;
      const kind = texto(decision['kind'], 60);
      const nombre = texto(muestra['displayName']) ?? texto(muestra['sourceKey']) ?? 'un registro del plan';
      const cuentas = Array.isArray(muestra['accounts'])
        ? (muestra['accounts'] as Record<string, unknown>[])
            .map((c) => `${texto(c['platform'], 30) ?? ''} ${texto(c['handle'], 60) ?? ''}`.trim())
            .filter((c) => c !== '')
            .slice(0, 5)
        : [];
      const detalle: string[] = [];
      if (cuentas.length > 0) detalle.push(`Cuentas del registro: ${cuentas.join(', ')}`);
      const motivo = texto(decision['reason'], 300);
      if (motivo !== undefined) detalle.push(`Motivo indicado: ${motivo}`);
      return {
        titulo: 'Resolver un registro del plan',
        texto: `Resolverá «${nombre}» con la decisión: ${(kind !== undefined ? ETIQUETA_DE_DECISION[kind] : undefined) ?? 'la decisión propuesta'}.`,
        detalle: ['La decisión queda registrada a nombre de quien la confirma.', ...detalle],
      };
    }
  }
}

interface FilaDeAccion {
  readonly id: string;
}

/** Nombres de las personas (de la organización) y número de versión de brief, en lote. */
async function datosAuxiliares(
  organizationId: string,
  acciones: readonly ProposedAction[],
): Promise<{ nombres: Map<string, string>; versiones: Map<string, number> }> {
  const personas = [...new Set(acciones.map((a) => a.proposedBy).filter((x): x is string => x !== null))];
  const versionIds = acciones.filter((a) => a.type === 'brief.approve').map((a) => a.resourceId);
  const nombres = new Map<string, string>();
  const versiones = new Map<string, number>();
  if (personas.length > 0) {
    const { rows } = await getPool().query<{ id: string; name: string }>(
      `SELECT id, name FROM users WHERE id = ANY($1::uuid[]) AND organization_id = $2`,
      [personas, organizationId],
    );
    for (const r of rows) nombres.set(r.id, r.name);
  }
  if (versionIds.length > 0) {
    const { rows } = await getPool().query<{ id: string; version: number }>(
      `SELECT v.id, v.version FROM brief_versions v
         JOIN briefs b ON b.id = v.brief_id
         JOIN campaigns c ON c.id = b.campaign_id
        WHERE v.id = ANY($1::uuid[]) AND c.organization_id = $2`,
      [versionIds, organizationId],
    );
    for (const r of rows) versiones.set(r.id, Number(r.version));
  }
  return { nombres, versiones };
}

/** `true` si la acción abierta ya no corresponde a lo vigente (el handler del tipo lo decide). */
async function esObsoleta(accion: ProposedAction): Promise<boolean> {
  if (accion.status !== 'pending' && accion.status !== 'confirmed') return false;
  const handler = handlerDe(accion.type);
  if (handler === undefined) return true;
  const r = await handler.verificarVigente(
    getPool(),
    {
      id: accion.id,
      organization_id: accion.organizationId,
      campaign_id: accion.campaignId,
      action_type: accion.type,
      resource_type: accion.resourceType,
      resource_id: accion.resourceId,
      payload: accion.payload,
      payload_hash: accion.payloadHash,
      proposed_by: accion.proposedBy,
      confirmed_by: accion.confirmedBy ?? null,
    },
    accion.status === 'pending' ? 'confirmar' : 'ejecutar',
  );
  return !r.ok && r.error.code === 'PROPOSAL_STALE';
}

async function construirVistas(
  actor: User,
  acciones: readonly ProposedAction[],
  propias: ReadonlySet<string>,
  runDeAccion: ReadonlyMap<string, string> = new Map(),
): Promise<VistaDeAccionPropuesta[]> {
  if (acciones.length === 0) return [];
  const { nombres, versiones } = await datosAuxiliares(actor.organizationId, acciones);
  const ahora = new Date();
  const vistas: VistaDeAccionPropuesta[] = [];
  for (const a of acciones) {
    const vencida =
      (a.status === 'pending' || a.status === 'confirmed') &&
      new Date(a.expiresAt).getTime() <= ahora.getTime();
    const estado: ProposedActionStatus = vencida ? 'expired' : a.status;
    const obsoleta = estado === 'pending' || estado === 'confirmed' ? await esObsoleta(a) : false;
    const texto = componerTexto(a, versiones.get(a.resourceId));
    const abierta = estado === 'pending' || estado === 'confirmed';
    const propuestaPorMi = a.proposedBy === actor.id;
    vistas.push({
      id: a.id,
      tipo: a.type,
      titulo: texto.titulo,
      textoHumano: texto.texto,
      detalle: texto.detalle,
      payloadHash: a.payloadHash,
      estado,
      obsoleta,
      propuestaPor: propuestaPorMi
        ? 'ti'
        : a.proposedBy === null
          ? 'el sistema'
          : (nombres.get(a.proposedBy) ?? 'otra persona'),
      propuestaPorMi,
      propuestaPorElAsistente: a.proposedOrigin === 'chat',
      quienConfirma: quienConfirmaDe(a.type),
      expiresAt: a.expiresAt,
      createdAt: a.createdAt,
      confirmedAt: a.confirmedAt,
      executedAt: a.executedAt,
      cancelledAt: a.cancelledAt,
      canConfirm: abierta && !obsoleta && estado === 'pending' && puedeConfirmar(actor, 'ui', a, ahora).ok,
      canRetryExecute:
        abierta && !obsoleta && estado === 'confirmed' && puedeEjecutar(actor, 'ui', a, ahora).ok,
      canCancel: abierta && puedeCancelar(actor, a).ok,
      esDeMiConversacion: propias.has(a.id),
      runId: runDeAccion.get(a.id),
    });
  }
  return vistas;
}

/** Ids de las propuestas ligadas a una conversación (por correlación o por la invocación que las dejó). */
async function idsDePropuestasDeConversacion(
  organizationId: string,
  campaignId: string,
  conversationId: string,
): Promise<string[]> {
  const { rows } = await getPool().query<FilaDeAccion>(
    `SELECT pa.id FROM proposed_actions pa
      WHERE pa.organization_id = $1 AND pa.campaign_id = $2
        AND (
          pa.correlation->>'conversationId' = $3::text
          OR EXISTS (
            SELECT 1 FROM agent_tool_invocations i
              JOIN agent_runs r ON r.id = i.agent_run_id
             WHERE i.proposed_action_id = pa.id AND r.conversation_id = $4::uuid
          )
        )
      ORDER BY pa.created_at DESC LIMIT 20`,
    [organizationId, campaignId, conversationId, conversationId],
  );
  return rows.map((r) => r.id);
}

/** Run de la conversación que dejó cada propuesta (por la invocación de la tool o, si no, por la correlación). */
async function runsDePropuestas(
  conversationId: string,
  actionIds: readonly string[],
): Promise<Map<string, string>> {
  const mapa = new Map<string, string>();
  if (actionIds.length === 0) return mapa;
  const { rows } = await getPool().query<{ action_id: string; run_id: string }>(
    `SELECT i.proposed_action_id AS action_id, i.agent_run_id AS run_id
       FROM agent_tool_invocations i
       JOIN agent_runs r ON r.id = i.agent_run_id
      WHERE r.conversation_id = $1 AND i.proposed_action_id = ANY($2::uuid[])
      ORDER BY i.started_at ASC`,
    [conversationId, actionIds],
  );
  for (const r of rows) if (!mapa.has(r.action_id)) mapa.set(r.action_id, r.run_id);
  const { rows: porCorrelacion } = await getPool().query<{ id: string; run_id: string }>(
    `SELECT pa.id, pa.correlation->>'agentRunId' AS run_id
       FROM proposed_actions pa
       JOIN agent_runs r ON r.id::text = pa.correlation->>'agentRunId'
      WHERE pa.id = ANY($1::uuid[]) AND r.conversation_id = $2`,
    [actionIds, conversationId],
  );
  for (const r of porCorrelacion) if (!mapa.has(r.id)) mapa.set(r.id, r.run_id);
  return mapa;
}

/** Lee propuestas por id con el MISMO alcance de `obtenerAccionPropuesta` (organización, campaña, rol). */
async function leerAcciones(
  actor: User,
  campaignId: string,
  ids: readonly string[],
): Promise<ProposedAction[]> {
  const lecturas = await Promise.all(ids.map((id) => obtenerAccionPropuesta(actor, id, { campaignId })));
  return lecturas.flatMap((r) => (r.ok ? [r.value] : []));
}

/** Propuestas ligadas a una conversación propia (todas las que el rol del actor puede ver). */
export async function listarAccionesDeConversacion(
  actor: User,
  conversationId: string,
): Promise<Result<VistaDeAccionPropuesta[]>> {
  const cargada = await chatCargarConversacionAutorizada(getPool(), actor, 'chat:read', conversationId);
  if (!cargada.ok) return err(cargada.error);
  const ids = await idsDePropuestasDeConversacion(
    actor.organizationId,
    cargada.value.campaignId,
    conversationId,
  );
  const acciones = await leerAcciones(actor, cargada.value.campaignId, ids);
  const runDeAccion = await runsDePropuestas(conversationId, ids);
  return ok(await construirVistas(actor, acciones, new Set(ids), runDeAccion));
}

/**
 * Propuestas ABIERTAS de la campaña que nacieron en un chat y que esta persona puede
 * confirmar (aunque no sean de su conversación: el director confirma lo que propone el
 * consultor). Solo roles con `chat:read`; el alcance de cada una lo da
 * `obtenerAccionPropuesta`.
 */
export async function listarAccionesPendientesDeCampana(
  actor: User,
  campaignId: string,
): Promise<Result<VistaDeAccionPropuesta[]>> {
  const capacidad = capacidadDeLectura(actor);
  if (!capacidad.ok) return capacidad;
  if (actor.role === 'cliente' || !UUID.test(campaignId)) return err(CHAT_NO_ENCONTRADO);
  const { rows } = await getPool().query<FilaDeAccion>(
    `SELECT id FROM proposed_actions
      WHERE organization_id = $1 AND campaign_id = $2 AND status IN ('pending', 'confirmed')
        AND proposed_origin = 'chat' AND expires_at > now()
      ORDER BY created_at DESC LIMIT 20`,
    [actor.organizationId, campaignId],
  );
  const acciones = await leerAcciones(
    actor,
    campaignId,
    rows.map((r) => r.id),
  );
  const vistas = await construirVistas(actor, acciones, new Set());
  return ok(vistas.filter((v) => v.canConfirm || v.canRetryExecute || v.canCancel));
}

/**
 * UNA propuesta para actuar sobre ella desde el chat (confirmar / cancelar). Debe ser de
 * ESTA campaña, de la organización del actor, ligada a una conversación de chat de la
 * campaña y: del actor (su conversación) o confirmable por su rol según el handler.
 * Cualquier otro caso es `RESOURCE_NOT_FOUND` (no se revela que existe).
 */
export async function obtenerAccionDeChat(
  actor: User,
  campaignId: string,
  actionId: string,
): Promise<Result<VistaDeAccionPropuesta>> {
  const capacidad = capacidadDeLectura(actor);
  if (!capacidad.ok) return capacidad;
  if (actor.role === 'cliente' || !UUID.test(campaignId) || !UUID.test(actionId)) {
    return err(CHAT_NO_ENCONTRADO);
  }
  const leida = await obtenerAccionPropuesta(actor, actionId, { campaignId });
  if (!leida.ok) return err(CHAT_NO_ENCONTRADO);

  const { rows } = await getPool().query<{ created_by: string }>(
    `SELECT c.created_by
       FROM chat_conversations c
      WHERE c.organization_id = $1 AND c.campaign_id = $2
        AND (
          c.id::text = (SELECT correlation->>'conversationId' FROM proposed_actions WHERE id = $3)
          OR EXISTS (
            SELECT 1 FROM agent_tool_invocations i JOIN agent_runs r ON r.id = i.agent_run_id
             WHERE i.proposed_action_id = $3 AND r.conversation_id = c.id
          )
        )`,
    [actor.organizationId, campaignId, actionId],
  );
  const esMia = rows.some((r) => r.created_by === actor.id);
  const spec = specDeAccion(leida.value.type);
  const confirmable = spec !== undefined && rolPuedeConfirmar(actor.role, spec);
  if (rows.length === 0 || (!esMia && !confirmable)) return err(CHAT_NO_ENCONTRADO);

  const [vista] = await construirVistas(actor, [leida.value], esMia ? new Set([actionId]) : new Set());
  return vista === undefined ? err(CHAT_NO_ENCONTRADO) : ok(vista);
}

// ─────────────────────────── Vista completa ────────────────────────────────────

export interface OpcionesDeVistaDeChat extends OpcionesDeActividad, OpcionesDeMensajes {
  readonly ahora?: Date | undefined;
}

/**
 * Todo lo que necesita la pantalla del chat, en paralelo. `canRetry` de un run: es el
 * último intento de un mensaje que es el último de la conversación y terminó `failed` o
 * `cancelled` (misma condición que exige `reintentarRun`).
 */
export async function cargarVistaDeChat(
  actor: User,
  conversationId: string,
  opciones: OpcionesDeVistaDeChat = {},
): Promise<Result<VistaDeChat>> {
  const cargada = await chatCargarConversacionAutorizada(getPool(), actor, 'chat:read', conversationId);
  if (!cargada.ok) return err(cargada.error);
  const conv = cargada.value;

  const [mensajes, runs, actividad, propuestas, pendientes] = await Promise.all([
    obtenerMensajesDeChat(actor, conversationId, { limite: opciones.limite }),
    obtenerRunsRecientes(actor, conversationId, { ahora: opciones.ahora }),
    listarActividadDeHerramientas(actor, conversationId, { etiquetar: opciones.etiquetar }),
    listarAccionesDeConversacion(actor, conversationId),
    listarAccionesPendientesDeCampana(actor, conv.campaignId),
  ]);
  if (!mensajes.ok) return err(mensajes.error);
  if (!runs.ok) return err(runs.error);
  if (!actividad.ok) return err(actividad.error);
  if (!propuestas.ok) return err(propuestas.error);

  const ultimoMensaje = [...mensajes.value].reverse().find((m) => m.role === 'user');
  const ultimoIntento = new Map<string, number>();
  for (const r of runs.value) {
    ultimoIntento.set(r.userMessageId, Math.max(ultimoIntento.get(r.userMessageId) ?? 0, r.attempt));
  }
  const hayActivo = runs.value.some((r) => r.status === 'queued' || r.status === 'running');
  const runsConReintento = runs.value.map((r): VistaDeRun => ({
    ...r,
    canRetry:
      !hayActivo &&
      (r.status === 'failed' || r.status === 'cancelled') &&
      ultimoMensaje !== undefined &&
      r.userMessageId === ultimoMensaje.id &&
      ultimoMensaje.seq === conv.lastSeq &&
      ultimoIntento.get(r.userMessageId) === r.attempt,
  }));

  const idsPropios = new Set(propuestas.value.map((p) => p.id));
  return ok({
    conversation: {
      id: conv.id,
      title: conv.title,
      status: conv.status,
      lastSeq: conv.lastSeq,
      createdAt: conv.createdAt,
      lastMessageAt: conv.lastMessageAt,
    },
    messages: mensajes.value,
    runs: runsConReintento,
    activity: actividad.value,
    proposals: propuestas.value,
    pending: pendientes.ok ? pendientes.value.filter((p) => !idsPropios.has(p.id)) : [],
  });
}
