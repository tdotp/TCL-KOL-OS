/* eslint-disable no-control-regex --
   Sanear/neutralizar texto no confiable exige reconocer caracteres de control e invisibles a propósito. */
/**
 * Chat y agente de Cuenta (V2 · Fase 6): tipos, estados, límites y reglas puras.
 *
 *   Conversación → Mensaje → Run del agente → Invocación de tool → efecto
 *
 * El chat NO es una base paralela: produce estructura sobre los objetos reales
 * del dominio (campañas, fuentes, brief, influencers). Aquí viven solo los
 * contratos del propio chat; la persistencia está en `packages/db`
 * (migración 021) y las tools son adaptadores sobre casos de uso existentes.
 *
 * Invariantes que este módulo codifica (la base los impone también por su lado):
 *  · Una conversación es de su creador (owner-scoped); el chat es del personal de
 *    la agencia (nunca `cliente`).
 *  · Un mensaje es un hecho append-only con rol `user` | `assistant`. El prompt de
 *    sistema vive en código y el resultado de una tool en la invocación: ninguno
 *    es un mensaje.
 *  · A lo sumo un run activo por conversación; un run avanza por transiciones
 *    válidas y sus estados terminales no se reescriben.
 *  · Nada guarda razonamiento interno del modelo (chain-of-thought): ni columnas
 *    ni claves de JSON (`sanitizarJsonAcotado` las descarta).
 *  · El agente actúa COMO la persona (origen `chat`), nunca como `system`, y no
 *    aprueba, confirma ni ejecuta una acción crítica (HITL).
 *
 * Este módulo no usa criptografía: las huellas (SHA-256) las calcula la capa de
 * datos.
 */

import { type Result, err, ok } from './errors';
import type { ModelTier } from './ai-tasks';

// ─────────────────────────── Estados y vocabularios ────────────────────────────

export type ChatConversationStatus = 'active' | 'archived';

/** Solo `user` y `assistant`: `system` (prompt) y `tool` (resultados) no son mensajes. */
export type ChatMessageRole = 'user' | 'assistant';

export const CHAT_MESSAGE_ROLES: readonly ChatMessageRole[] = ['user', 'assistant'] as const;

/**
 *   queued → running → completed | failed | cancelled
 *   queued → failed | cancelled
 *
 * «Abandonado» no es un estado: es `failed` con el código `RUN_ABANDONED`.
 */
export type AgentRunStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

export const AGENT_RUN_STATUSES: readonly AgentRunStatus[] = [
  'queued',
  'running',
  'completed',
  'failed',
  'cancelled',
] as const;

/** Estados en los que el run ocupa «el único run activo» de la conversación. */
export const AGENT_RUN_ACTIVE_STATUSES: readonly AgentRunStatus[] = ['queued', 'running'] as const;

export const AGENT_RUN_TERMINAL_STATUSES: readonly AgentRunStatus[] = [
  'completed',
  'failed',
  'cancelled',
] as const;

const TRANSICIONES_DE_RUN: Readonly<Record<AgentRunStatus, readonly AgentRunStatus[]>> = {
  queued: ['running', 'failed', 'cancelled'],
  running: ['completed', 'failed', 'cancelled'],
  completed: [],
  failed: [],
  cancelled: [],
};

export function isRunActive(status: AgentRunStatus): boolean {
  return (AGENT_RUN_ACTIVE_STATUSES as readonly AgentRunStatus[]).includes(status);
}

export function isRunTerminal(status: AgentRunStatus): boolean {
  return (AGENT_RUN_TERMINAL_STATUSES as readonly AgentRunStatus[]).includes(status);
}

export function puedeTransicionarRun(desde: AgentRunStatus, hacia: AgentRunStatus): boolean {
  return TRANSICIONES_DE_RUN[desde].includes(hacia);
}

/** `running` → `succeeded` | `failed` | `cancelled`; los demás son terminales. */
export type ToolInvocationStatus = 'running' | 'succeeded' | 'failed' | 'cancelled';

export const TOOL_INVOCATION_STATUSES: readonly ToolInvocationStatus[] = [
  'running',
  'succeeded',
  'failed',
  'cancelled',
] as const;

export function puedeTransicionarInvocacion(
  desde: ToolInvocationStatus,
  hacia: ToolInvocationStatus,
): boolean {
  return desde === 'running' && hacia !== 'running';
}

/**
 * Clase de riesgo de una tool (la fija el registro, nunca el modelo):
 *  · `read`                  solo lee.
 *  · `write`                 muta mediante un caso de uso con el permiso de la persona.
 *  · `confirmation_required` solo PROPONE una acción crítica; una persona la confirma por `ui`.
 *  · `unregistered`          el modelo pidió una tool que no existe (o prohibida): se deja la
 *                            traza del intento, no se ejecuta nada.
 */
export type ToolRiskClass = 'read' | 'write' | 'confirmation_required' | 'unregistered';

export const TOOL_RISK_CLASSES: readonly ToolRiskClass[] = [
  'read',
  'write',
  'confirmation_required',
  'unregistered',
] as const;

// ─────────────────────────── Límites y tiempos ─────────────────────────────────

/**
 * Límites del chat. Los de la base (CHECK de la migración 021) son los mismos: no
 * se pueden ampliar aquí sin una migración.
 */
export const CHAT_LIMITS = {
  tituloMax: 200,
  mensajeMax: 20_000,
  adjuntosPorMensaje: 10,
  referenciasPorMensaje: 50,
  clientMessageIdMin: 8,
  clientMessageIdMax: 128,
  toolArgsMaxBytes: 16_384,
  toolResultMaxBytes: 32_768,
  contextManifestMaxBytes: 32_768,
  errorMensajeMax: 500,
  errorCodigoMax: 64,
} as const;

/**
 * Un run activo sin latido durante este tiempo se da por abandonado (el proceso
 * que lo ejecutaba murió). Patrón `SYNC_ABANDONED` (019). El runtime debe llamar a
 * `latidoRun` al menos una vez por vuelta del modelo y por tool.
 */
export const AGENT_RUN_HEARTBEAT_TIMEOUT_MINUTES = 10;

/** Un run que sigue `queued` este tiempo nunca llegó a arrancar (el `after()` se perdió). */
export const AGENT_RUN_QUEUED_TIMEOUT_MINUTES = 5;

/** Código con el que el barrido cierra un run huérfano. */
export const RUN_ABANDONED = 'RUN_ABANDONED';

/** Código con el que se cierra una invocación de tool dejada abierta por un run huérfano. */
export const TOOL_ABANDONED = 'TOOL_ABANDONED';

/**
 * Razones (`details.reason`) con las que los casos de uso del chat devuelven
 * `RESOURCE_CONFLICT` o `VALIDATION_FAILED`. No hay códigos de error nuevos.
 */
export const CHAT_CONFLICT_REASONS = {
  runInProgress: 'run_in_progress',
  clientMessageIdReused: 'client_message_id_reused',
  conversationArchived: 'conversation_archived',
  campaignNotActive: 'campaign_not_active',
  attachmentScope: 'attachment_scope',
  runNotRetryable: 'run_not_retryable',
  messageNotLatest: 'message_not_latest',
  runNotRunning: 'run_not_running',
  runNotQueued: 'run_not_queued',
  runNotActive: 'run_not_active',
  cancelRequested: 'cancel_requested',
  toolsOpen: 'tools_open',
  referenceScope: 'reference_scope',
  toolAlreadyClaimed: 'tool_already_claimed',
} as const;

export type ChatConflictReason = (typeof CHAT_CONFLICT_REASONS)[keyof typeof CHAT_CONFLICT_REASONS];

// ─────────────────────────── Entidades ─────────────────────────────────────────

export interface ChatConversation {
  readonly id: string;
  readonly organizationId: string;
  readonly campaignId: string;
  readonly createdBy: string;
  readonly title: string | undefined;
  readonly status: ChatConversationStatus;
  /** Último `seq` de mensaje asignado (0 = conversación vacía). */
  readonly lastSeq: number;
  readonly lastMessageAt: string | undefined;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly archivedAt: string | undefined;
}

/** Una fuente adjunta a un mensaje de usuario (es un `Source`, no un blob del mensaje). */
export interface ChatMessageAttachment {
  readonly id: string;
  readonly sourceId: string;
  readonly position: number;
}

/**
 * Una cita de un mensaje del asistente. La fuente siempre existe; fragmento,
 * snapshot y evidencia son opcionales (el fragmento/evidencia pueden desaparecer al
 * reprocesar una fuente: la cita conserva fuente, localizador y huella).
 */
export interface ChatMessageReference {
  readonly id: string;
  readonly ordinal: number;
  readonly sourceId: string;
  readonly fragmentId: string | undefined;
  readonly snapshotId: string | undefined;
  readonly evidenceId: string | undefined;
  /** `SourceLocator` copiado (jsonb); se valida en la base con `source_locator_valido`. */
  readonly locator: Readonly<Record<string, unknown>> | undefined;
  readonly fragmentTextSha256: string | undefined;
}

export interface ChatMessage {
  readonly id: string;
  readonly conversationId: string;
  readonly campaignId: string;
  readonly organizationId: string;
  readonly seq: number;
  readonly role: ChatMessageRole;
  /** Autor (user) o persona en cuyo nombre respondió el agente (assistant). */
  readonly userId: string;
  readonly content: string;
  readonly contentSha256: string;
  readonly clientMessageId: string | undefined;
  readonly agentRunId: string | undefined;
  readonly createdAt: string;
  readonly attachments: readonly ChatMessageAttachment[];
  readonly references: readonly ChatMessageReference[];
}

/** Configuración con la que se admite un run (la conoce el runtime, no la base). */
export interface AgentRunConfig {
  readonly provider: string;
  readonly model: string;
  readonly tier: ModelTier;
  readonly promptVersion: string;
  readonly contextVersion: string;
}

export interface AgentRun {
  readonly id: string;
  readonly organizationId: string;
  readonly campaignId: string;
  readonly conversationId: string;
  readonly userMessageId: string;
  readonly userId: string;
  readonly attempt: number;
  readonly status: AgentRunStatus;
  readonly provider: string;
  readonly model: string;
  readonly tier: ModelTier;
  readonly promptVersion: string;
  readonly contextVersion: string;
  readonly contextHash: string | undefined;
  /** Solo ids y conteos de lo que el modelo pudo ver; nunca texto de documentos. */
  readonly contextManifest: Readonly<Record<string, unknown>> | undefined;
  readonly requestId: string | undefined;
  readonly cancelRequestedAt: string | undefined;
  readonly heartbeatAt: string | undefined;
  readonly queuedAt: string;
  readonly startedAt: string | undefined;
  readonly finishedAt: string | undefined;
  readonly errorCode: string | undefined;
  readonly errorMessage: string | undefined;
}

export interface ToolInvocation {
  readonly id: string;
  readonly organizationId: string;
  readonly campaignId: string;
  readonly agentRunId: string;
  readonly sequence: number;
  readonly stepIndex: number;
  readonly toolCallId: string | undefined;
  readonly toolName: string;
  readonly riskClass: ToolRiskClass;
  /** Argumentos sanitizados y acotados (nunca razonamiento ni secretos). */
  readonly args: Readonly<Record<string, unknown>>;
  readonly argsSha256: string;
  readonly status: ToolInvocationStatus;
  /** Ids, conteos y referencias a efectos; nunca texto de documentos. */
  readonly result: Readonly<Record<string, unknown>> | undefined;
  readonly errorCode: string | undefined;
  readonly idempotencyKey: string;
  /** Solo en tools de confirmación requerida: la propuesta HITL que dejaron. */
  readonly proposedActionId: string | undefined;
  readonly startedAt: string;
  readonly finishedAt: string | undefined;
}

// ─────────────────────────── Validaciones de entrada ───────────────────────────

const VALIDACION = 'VALIDATION_FAILED' as const;

/** El contenido se conserva TAL CUAL (no se recorta): solo se valida su forma. */
export function validarContenidoMensaje(content: unknown): Result<string> {
  if (typeof content !== 'string' || content.trim() === '') {
    return err({
      code: VALIDACION,
      message: 'El mensaje no puede estar vacío.',
      details: { field: 'content' },
    });
  }
  if (content.length > CHAT_LIMITS.mensajeMax) {
    return err({
      code: VALIDACION,
      message: `El mensaje excede ${CHAT_LIMITS.mensajeMax} caracteres.`,
      details: { field: 'content', max: CHAT_LIMITS.mensajeMax },
    });
  }
  if (content.includes('\u0000')) {
    return err({
      code: VALIDACION,
      message: 'El mensaje contiene caracteres no válidos.',
      details: { field: 'content' },
    });
  }
  return ok(content);
}

const PATRON_CLIENT_MESSAGE_ID = /^[A-Za-z0-9_-]{8,128}$/;

/** Clave de idempotencia del cliente: la genera la interfaz (p. ej. un UUID) por cada envío. */
export function validarClientMessageId(valor: unknown): Result<string> {
  if (typeof valor !== 'string' || !PATRON_CLIENT_MESSAGE_ID.test(valor)) {
    return err({
      code: VALIDACION,
      message: 'La clave del mensaje no es válida (8 a 128 caracteres: letras, números, guion y guion bajo).',
      details: { field: 'clientMessageId' },
    });
  }
  return ok(valor);
}

/** Título opcional: vacío → sin título. */
export function validarTituloConversacion(titulo: unknown): Result<string | undefined> {
  if (titulo === undefined || titulo === null) return ok(undefined);
  if (typeof titulo !== 'string') {
    return err({ code: VALIDACION, message: 'El título no es válido.', details: { field: 'title' } });
  }
  const limpio = titulo.trim();
  if (limpio === '') return ok(undefined);
  if (limpio.length > CHAT_LIMITS.tituloMax) {
    return err({
      code: VALIDACION,
      message: `El título excede ${CHAT_LIMITS.tituloMax} caracteres.`,
      details: { field: 'title', max: CHAT_LIMITS.tituloMax },
    });
  }
  return ok(limpio);
}

/** Lista de fuentes adjuntas: sin repetidos y hasta el máximo por mensaje. */
export function validarAdjuntos(sourceIds: unknown): Result<readonly string[]> {
  if (sourceIds === undefined || sourceIds === null) return ok([]);
  if (!Array.isArray(sourceIds) || sourceIds.some((id) => typeof id !== 'string' || id === '')) {
    return err({
      code: VALIDACION,
      message: 'Los adjuntos no son válidos.',
      details: { field: 'sourceIds' },
    });
  }
  const ids = sourceIds as string[];
  if (new Set(ids).size !== ids.length) {
    return err({ code: VALIDACION, message: 'Hay adjuntos repetidos.', details: { field: 'sourceIds' } });
  }
  if (ids.length > CHAT_LIMITS.adjuntosPorMensaje) {
    return err({
      code: VALIDACION,
      message: `Un mensaje admite hasta ${CHAT_LIMITS.adjuntosPorMensaje} adjuntos.`,
      details: { field: 'sourceIds', max: CHAT_LIMITS.adjuntosPorMensaje },
    });
  }
  return ok([...ids]);
}

const NIVELES: readonly ModelTier[] = ['eficiente', 'equilibrado', 'avanzado'];

/** Configuración con la que se admite un run: toda cadena no vacía y acotada, y un nivel válido. */
export function validarConfiguracionDeRun(config: unknown): Result<AgentRunConfig> {
  const c = (typeof config === 'object' && config !== null ? config : {}) as Record<string, unknown>;
  const texto = (v: unknown, max: number): v is string =>
    typeof v === 'string' && v.trim() !== '' && v.length <= max;
  if (
    !texto(c['provider'], 100) ||
    !texto(c['model'], 200) ||
    !texto(c['promptVersion'], 100) ||
    !texto(c['contextVersion'], 100) ||
    typeof c['tier'] !== 'string' ||
    !(NIVELES as readonly string[]).includes(c['tier'])
  ) {
    return err({
      code: VALIDACION,
      message:
        'La configuración del run no es válida (provider, model, tier, promptVersion, contextVersion).',
      details: { field: 'runConfig' },
    });
  }
  return ok({
    provider: c['provider'] as string,
    model: c['model'] as string,
    tier: c['tier'] as ModelTier,
    promptVersion: c['promptVersion'] as string,
    contextVersion: c['contextVersion'] as string,
  });
}

const PATRON_CODIGO_DE_ERROR = /^[A-Z][A-Z0-9_]{1,63}$/;

/** Los códigos de error de un run/tool son identificadores en mayúsculas, no texto libre. */
export function esCodigoDeErrorValido(codigo: unknown): codigo is string {
  return typeof codigo === 'string' && PATRON_CODIGO_DE_ERROR.test(codigo);
}

/**
 * Mensaje de error de un run, apto para persistir: una línea, sin saltos, acotado.
 * (Quien lo escribe es responsable de no incluir contenido de documentos.)
 */
export function sanitizarMensajeDeError(mensaje: unknown): string | undefined {
  if (typeof mensaje !== 'string') return undefined;
  const limpio = mensaje.replace(/[\u0000-\u001f\u007f\s]+/g, ' ').trim();
  if (limpio === '') return undefined;
  return limpio.length > CHAT_LIMITS.errorMensajeMax
    ? `${limpio.slice(0, CHAT_LIMITS.errorMensajeMax - 1)}…`
    : limpio;
}

/**
 * Clave de idempotencia de una invocación de tool dentro de un run. Prefiere el id
 * de llamada del proveedor; si no lo hay, vuelta + tool + huella de los argumentos.
 * Misma clave ⇒ misma invocación (no se ejecuta dos veces).
 */
export function claveDeInvocacion(entrada: {
  readonly stepIndex: number;
  readonly toolName: string;
  readonly toolCallId?: string | undefined;
  readonly argsSha256: string;
}): string {
  const base =
    entrada.toolCallId !== undefined && entrada.toolCallId !== ''
      ? `call:${entrada.toolCallId}`
      : `args:${entrada.toolName}:${entrada.argsSha256.slice(0, 32)}`;
  return `s${entrada.stepIndex}:${base}`.slice(0, 200);
}

// ─────────────────────────── Sanitización de JSON ──────────────────────────────

/** Valor JSON ya limpio. */
export type JsonLimpio =
  null | boolean | number | string | readonly JsonLimpio[] | { readonly [clave: string]: JsonLimpio };

/**
 * Letras de otros alfabetos que se confunden a simple vista con una latina (homoglifos cirílicos, griegos y
 * variantes latinas): `rеasoning` con «е» cirílica debe leerse como `reasoning`. No pretende ser la tabla
 * completa de «confusables» de Unicode: cubre las que sirven para disfrazar una clave en inglés o español.
 */
const HOMOGLIFOS: Readonly<Record<string, string>> = {
  // cirílico
  а: 'a',
  в: 'b',
  с: 'c',
  ԁ: 'd',
  е: 'e',
  ё: 'e',
  һ: 'h',
  н: 'h',
  і: 'i',
  ї: 'i',
  ј: 'j',
  к: 'k',
  ӏ: 'l',
  м: 'm',
  о: 'o',
  р: 'p',
  ԛ: 'q',
  ѕ: 's',
  т: 't',
  ѵ: 'v',
  ԝ: 'w',
  х: 'x',
  у: 'y',
  // griego
  α: 'a',
  β: 'b',
  γ: 'y',
  ε: 'e',
  ζ: 'z',
  η: 'n',
  ι: 'i',
  κ: 'k',
  μ: 'u',
  ν: 'v',
  ο: 'o',
  ρ: 'p',
  σ: 'o',
  τ: 't',
  υ: 'u',
  χ: 'x',
  ω: 'w',
  // latinas especiales
  ı: 'i',
  ſ: 's',
  ƒ: 'f',
  ɡ: 'g',
  ɑ: 'a',
  ɩ: 'i',
  ɋ: 'q',
  ø: 'o',
  đ: 'd',
  ł: 'l',
  ß: 'ss',
  æ: 'ae',
  œ: 'oe',
};

/**
 * Forma comparable de una clave: NFKC (ancho completo, ligaduras, matemáticas), sin acentos ni marcas
 * combinantes, en minúsculas, con los homoglifos mapeados a su letra latina y SIN separadores ni invisibles.
 */
function normalizarClave(clave: string): string {
  const base = clave
    .normalize('NFKC')
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase();
  let latina = '';
  for (const c of base) latina += HOMOGLIFOS[c] ?? c;
  return latina.replace(/[^a-z0-9]/g, '');
}

/** Claves que nunca se guardan (secretos y datos personales sensibles): el valor se redacta. */
const CLAVES_SENSIBLES: ReadonlySet<string> = new Set([
  'password',
  'passwd',
  'pwd',
  'pass',
  'contrasena',
  'token',
  'accesstoken',
  'refreshtoken',
  'idtoken',
  'authtoken',
  'bearertoken',
  'sessiontoken',
  'apikey',
  'apitoken',
  'secret',
  'secretkey',
  'clientsecret',
  'privatekey',
  'accesskey',
  'authorization',
  'cookie',
  'setcookie',
  'cedula',
  'telefono',
  'direccion',
]);

/** Fragmentos que delatan una clave de secreto aunque lleve prefijos o sufijos (`openai_api_key`, `dbPassword`). */
const FRAGMENTOS_SENSIBLES: readonly string[] = [
  'password',
  'passwd',
  'contrasena',
  'secret',
  'apikey',
  'privatekey',
  'authorization',
  'credential',
  'credencial',
];

function esClaveSensible(norma: string): boolean {
  return CLAVES_SENSIBLES.has(norma) || FRAGMENTOS_SENSIBLES.some((f) => norma.includes(f));
}

/**
 * Claves de razonamiento interno del modelo: se DESCARTAN por completo. Nada de
 * chain-of-thought en args, resultados ni manifiestos (invariante del chat).
 */
const CLAVES_DE_RAZONAMIENTO: ReadonlySet<string> = new Set([
  'reasoning',
  'reasoningcontent',
  'reasoningdetails',
  'thinking',
  'thought',
  'thoughts',
  'chainofthought',
  'cot',
  'scratchpad',
  'internalmonologue',
  'razonamiento',
  'razonamientos',
  'pensamiento',
  'pensamientos',
  'cadenadepensamiento',
  'cadenadepensamientos',
  'cadenaderazonamiento',
  'monologointerno',
  'reflexion',
]);

/** Fragmentos que delatan razonamiento aunque la clave lleve más texto (`reasoning_summary`, `razonamientoInterno`). */
const FRAGMENTOS_DE_RAZONAMIENTO: readonly string[] = [
  'reasoning',
  'razonamiento',
  'thinking',
  'pensamiento',
  'chainofthought',
  'cadenadepensamiento',
  'scratchpad',
  'monologo',
  'monologue',
  'internalthought',
];

function esClaveDeRazonamiento(norma: string): boolean {
  return CLAVES_DE_RAZONAMIENTO.has(norma) || FRAGMENTOS_DE_RAZONAMIENTO.some((f) => norma.includes(f));
}

/**
 * Secretos que viajan DENTRO de un valor (cabeceras pegadas, claves de API, JWT, claves privadas): se
 * redacta solo el tramo, no el texto entero. Conservador a propósito: patrones con formato reconocible.
 */
const PATRONES_DE_SECRETO_EN_VALOR: readonly RegExp[] = [
  /(?:api[_-]?key|secret|password|passwd|pwd|access[_-]?token|refresh[_-]?token|client[_-]?secret|authorization)\s*[:=]\s*(?:bearer\s+)?["']?[^\s"',;]{4,}/gi,
  /\bbearer\s+[A-Za-z0-9._~+/=-]{12,}/gi,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  /\b[sr]k_(?:live|test)_[A-Za-z0-9]{10,}/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{30,}/g,
  /\bxox[abpr]-[A-Za-z0-9-]{10,}/g,
  /\bAIza[0-9A-Za-z_-]{30,}/g,
];

const REDACTADO = '[redactado]';

/** Redacta los secretos con formato reconocible dentro de un texto. */
export function redactarSecretosEnTexto(texto: string): string {
  let r = texto;
  for (const patron of PATRONES_DE_SECRETO_EN_VALOR) r = r.replace(patron, REDACTADO);
  return r;
}

export interface OpcionesDeSaneamiento {
  /** Tope de bytes del JSON resultante (con el formato de `jsonb::text` de Postgres). */
  readonly maxBytes: number;
  readonly maxProfundidad?: number;
  readonly maxClavesPorObjeto?: number;
  readonly maxElementosPorLista?: number;
  readonly maxTexto?: number;
}

export interface JsonSaneado {
  readonly valor: { readonly [clave: string]: JsonLimpio };
  /** Se recortó, descartó o sustituyó algo (límites, claves de razonamiento, tamaño). */
  readonly alterado: boolean;
  /** Tamaño del resultado con el formato de `jsonb::text` (la medida que aplica la base). */
  readonly bytes: number;
}

/** Longitud UTF-8 de una cadena, sin depender de `TextEncoder` ni de Node. */
function longitudUtf8(texto: string): number {
  let bytes = 0;
  for (let i = 0; i < texto.length; i += 1) {
    const c = texto.charCodeAt(i);
    if (c < 0x80) bytes += 1;
    else if (c < 0x800) bytes += 2;
    else if (c >= 0xd800 && c <= 0xdbff) {
      bytes += 4;
      i += 1;
    } else bytes += 3;
  }
  return bytes;
}

/** Serialización con el formato de `jsonb::text` (`", "` y `": "`), para medir como la base. */
function serializarComoJsonb(valor: JsonLimpio): string {
  if (valor === null || typeof valor !== 'object') return JSON.stringify(valor);
  if (Array.isArray(valor))
    return `[${(valor as readonly JsonLimpio[]).map(serializarComoJsonb).join(', ')}]`;
  const objeto = valor as { readonly [clave: string]: JsonLimpio };
  return `{${Object.keys(objeto)
    .map((k) => `${JSON.stringify(k)}: ${serializarComoJsonb(objeto[k] as JsonLimpio)}`)
    .join(', ')}}`;
}

/** Medida (bytes UTF-8) de un valor ya limpio con el formato de `jsonb::text`. */
export function bytesComoJsonb(valor: JsonLimpio): number {
  return longitudUtf8(serializarComoJsonb(valor));
}

/**
 * Sanitizador PROFUNDO y acotado para `args`, `result` y `context_manifest`.
 * (`sanitizeMetadata` de la auditoría es superficial: no sirve aquí.)
 *
 *  · Descarta claves de razonamiento y redacta secretos a cualquier profundidad.
 *  · Solo JSON: `undefined`/funciones/símbolos se omiten, `bigint` y fechas pasan a
 *    texto, números no finitos a `null`, ciclos y profundidad excesiva a `"[omitido]"`.
 *  · Recorta textos, listas y objetos largos y quita el carácter NUL (no cabe en jsonb).
 *  · Si aun así supera `maxBytes`, sustituye el contenido por un marcador mínimo.
 */
export function sanitizarJsonAcotado(entrada: unknown, opciones: OpcionesDeSaneamiento): JsonSaneado {
  const maxProfundidad = opciones.maxProfundidad ?? 6;
  const maxClaves = opciones.maxClavesPorObjeto ?? 100;
  const maxElementos = opciones.maxElementosPorLista ?? 100;
  const maxTexto = opciones.maxTexto ?? 2_000;
  let alterado = false;
  const vistos = new WeakSet<object>();

  const limpiar = (valor: unknown, profundidad: number): JsonLimpio | undefined => {
    if (valor === null) return null;
    switch (typeof valor) {
      case 'undefined':
      case 'function':
      case 'symbol':
        return undefined;
      case 'boolean':
        return valor;
      case 'number':
        if (Number.isFinite(valor)) return valor;
        alterado = true;
        return null;
      case 'bigint':
        alterado = true;
        return valor.toString();
      case 'string': {
        const sinNul = valor.includes('\u0000') ? valor.replace(/\u0000/g, '') : valor;
        if (sinNul !== valor) alterado = true;
        // Los secretos se redactan ANTES de recortar: un recorte no puede dejar la mitad de uno.
        const sinSecretos = redactarSecretosEnTexto(sinNul);
        if (sinSecretos !== sinNul) alterado = true;
        if (sinSecretos.length > maxTexto) {
          alterado = true;
          return `${sinSecretos.slice(0, maxTexto - 1)}…`;
        }
        return sinSecretos;
      }
      default:
        break;
    }
    if (valor instanceof Date) {
      alterado = true;
      return Number.isNaN(valor.getTime()) ? null : valor.toISOString();
    }
    const objeto = valor as object;
    if (profundidad >= maxProfundidad || vistos.has(objeto)) {
      alterado = true;
      return '[omitido]';
    }
    vistos.add(objeto);
    try {
      if (Array.isArray(objeto)) {
        const lista: JsonLimpio[] = [];
        for (const elemento of objeto) {
          if (lista.length >= maxElementos) {
            alterado = true;
            break;
          }
          lista.push(limpiar(elemento, profundidad + 1) ?? null);
        }
        return lista;
      }
      const resultado: Record<string, JsonLimpio> = {};
      let claves = 0;
      for (const [clave, v] of Object.entries(objeto as Record<string, unknown>)) {
        const norma = normalizarClave(clave);
        if (esClaveDeRazonamiento(norma)) {
          alterado = true;
          continue;
        }
        if (claves >= maxClaves) {
          alterado = true;
          break;
        }
        const claveLimpia = clave.replace(/\u0000/g, '').slice(0, 200);
        // Una clave propia `__proto__` (JSON.parse la crea) cambiaría el prototipo del resultado al asignarla.
        if (claveLimpia === '__proto__') {
          alterado = true;
          continue;
        }
        if (esClaveSensible(norma)) {
          resultado[claveLimpia] = '[redactado]';
          alterado = true;
          claves += 1;
          continue;
        }
        const limpio = limpiar(v, profundidad + 1);
        if (limpio === undefined) continue;
        resultado[claveLimpia] = limpio;
        claves += 1;
      }
      return resultado;
    } finally {
      vistos.delete(objeto);
    }
  };

  const raiz = limpiar(entrada, 0);
  const objeto: { readonly [clave: string]: JsonLimpio } =
    raiz !== undefined && raiz !== null && typeof raiz === 'object' && !Array.isArray(raiz)
      ? (raiz as { readonly [clave: string]: JsonLimpio })
      : {};
  if (objeto !== raiz) alterado = true;

  let bytes = bytesComoJsonb(objeto);
  if (bytes <= opciones.maxBytes) return { valor: objeto, alterado, bytes };

  const marcador: { readonly [clave: string]: JsonLimpio } = { _truncado: true, _bytesOriginales: bytes };
  bytes = bytesComoJsonb(marcador);
  return { valor: marcador, alterado: true, bytes };
}

/** Atajo: argumentos de una tool (≤ 16 KB). */
export function sanitizarArgsDeTool(args: unknown): JsonSaneado {
  return sanitizarJsonAcotado(args, { maxBytes: CHAT_LIMITS.toolArgsMaxBytes });
}

/** Atajo: resultado de una tool (≤ 32 KB). */
export function sanitizarResultadoDeTool(resultado: unknown): JsonSaneado {
  return sanitizarJsonAcotado(resultado, { maxBytes: CHAT_LIMITS.toolResultMaxBytes });
}

/** Atajo: manifiesto de contexto de un run (≤ 32 KB; solo ids y conteos). */
export function sanitizarManifiestoDeContexto(manifiesto: unknown): JsonSaneado {
  return sanitizarJsonAcotado(manifiesto, { maxBytes: CHAT_LIMITS.contextManifestMaxBytes });
}

// ─────────────────────────── Cifras del proveedor (ledger `ai_runs`) ────────────

/** Máximo de un `integer` de Postgres. */
export const INT4_MAX = 2_147_483_647;
/** Máximo de `cost_usd numeric(10,6)`. */
export const COSTO_USD_MAX = 9_999.999999;

export interface CifrasDeLlamada {
  readonly latencyMs?: number | undefined;
  readonly promptTokens?: number | undefined;
  readonly completionTokens?: number | undefined;
  readonly costUsd?: number | undefined;
}

export interface CifrasNormalizadas {
  readonly latencyMs: number | null;
  readonly promptTokens: number | null;
  readonly completionTokens: number | null;
  readonly costUsd: number | null;
  /** Nombres de las cifras que hubo que acotar o descartar (vacío = el proveedor las informó bien). */
  readonly anomalias: readonly string[];
}

function enteroNoNegativo(valor: number | undefined, nombre: string, anomalias: string[]): number | null {
  if (valor === undefined || valor === null) return null;
  if (typeof valor !== 'number' || !Number.isFinite(valor) || valor < 0) {
    anomalias.push(nombre);
    return null;
  }
  const entero = Math.round(valor);
  if (entero > INT4_MAX) {
    anomalias.push(nombre);
    return INT4_MAX;
  }
  if (entero !== valor) anomalias.push(nombre);
  return entero;
}

/**
 * Cifras del proveedor aptas para `ai_runs` (columnas `integer` y `numeric(10,6)`): enteros no negativos
 * dentro de rango y un costo con 6 decimales como máximo `COSTO_USD_MAX`. Lo inválido (NaN, infinito,
 * negativo, de otro tipo) se descarta (`null`) y lo desmedido se acota; ambos casos quedan listados en
 * `anomalias`. Una cifra rara del proveedor nunca debe impedir registrar la llamada.
 */
export function normalizarCifrasDeLlamada(cifras: CifrasDeLlamada): CifrasNormalizadas {
  const anomalias: string[] = [];
  const latencyMs = enteroNoNegativo(cifras.latencyMs, 'latency_ms', anomalias);
  const promptTokens = enteroNoNegativo(cifras.promptTokens, 'prompt_tokens', anomalias);
  const completionTokens = enteroNoNegativo(cifras.completionTokens, 'completion_tokens', anomalias);
  let costUsd: number | null = null;
  const c = cifras.costUsd;
  if (c !== undefined && c !== null) {
    if (typeof c !== 'number' || !Number.isFinite(c) || c < 0) {
      anomalias.push('cost_usd');
    } else if (c > COSTO_USD_MAX) {
      anomalias.push('cost_usd');
      costUsd = COSTO_USD_MAX;
    } else {
      costUsd = Math.round(c * 1_000_000) / 1_000_000;
    }
  }
  return { latencyMs, promptTokens, completionTokens, costUsd, anomalias };
}
