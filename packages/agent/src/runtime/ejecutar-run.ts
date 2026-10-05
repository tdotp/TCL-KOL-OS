/**
 * Bucle del agente: ejecuta UN run (un turno) de principio a fin (V2 · Fase 6).
 *
 * El runtime ORQUESTA; no decide reglas ni toca tablas:
 *   · estado del run, mensajes, ledger y contexto → casos de uso de `@tcl-kol-os/db`
 *     (todo vía `db-ports.ts`);
 *   · tools → `ToolRegistry` (nunca las ejecuta este módulo);
 *   · modelo → `ModelClient` (una llamada sin estado).
 *
 * Ciclo (cada vuelta = una llamada de modelo):
 *   releer actor (activo, misma organización, `chat:write`) → latido + cancelación →
 *   plazo → kill-switch → tools del rol ACTUAL → modelo → ledger → (respuesta final |
 *   tool calls secuenciales, máx. 4 por paso, con latido y relectura de actor por cada una).
 *
 * Salidas y su mapeo a los estados REALES de `agent_runs` (no hay `end_reason`):
 *   · completed     → `completed` (+ mensaje del asistente con citas validadas).
 *   · step_limit    → `completed` con un mensaje DETERMINÍSTICO generado sin otra llamada de
 *                     modelo ("Alcancé el límite de N pasos. Hecho: …"). No es un fallo: el
 *                     código `AGENT_STEP_LIMIT` solo viaja en `ResultadoDeRun`, no en la fila
 *                     (ver «cambios sugeridos» en el reporte).
 *   · timeout       → `failed` / `AGENT_RUN_TIMEOUT`.
 *   · cancelled     → `cancelled` (confirmada entre pasos o al publicar la respuesta).
 *   · error modelo  → `failed` / `AGENT_MODEL_UNAVAILABLE` | `AI_DISABLED` | `AGENT_CONTEXT_FAILED`.
 *   · persona sin acceso (inactiva / otra organización / sin `chat:write`) → `failed` / `FORBIDDEN_ROLE`.
 *   · excepción inesperada → `failed` / `AGENT_RUNTIME_ERROR` (sin detalle).
 * Todo camino termina el run; solo una caída del proceso lo deja `running` y lo cubre el
 * barrido de abandonados (`RUN_ABANDONED`).
 *
 * Invariantes: el modelo no recibe ids de organización ni de persona en los mensajes que
 * arma este módulo; los resultados de tools solo viven dentro del turno (nunca se
 * persisten como historial ni se reenvían en turnos posteriores); no se guarda ni se pide
 * razonamiento del modelo (se ignora todo lo que no sea el contrato `ModelTurnResponse`).
 */
import { createHash } from 'node:crypto';
import {
  type AgentRun,
  type AgentRunStatus,
  type ModelTier,
  type Result,
  type User,
  CHAT_CONFLICT_REASONS,
  CHAT_LIMITS,
  MODEL_TIERS,
  err,
  ok,
  roleCan,
  textosDelActor as textosDelActorDeDominio,
} from '@tcl-kol-os/domain';
import {
  type ModelClient,
  type ModelMessage,
  type ModelToolCall,
  type ModelTurnRequest,
  type ModelTurnResponse,
  type ToolExecution,
  type ToolRegistry,
  type ToolRunContext,
  ModelError,
} from '../contracts.ts';
import { type EnvReader, envDelProceso } from '../model/env.ts';
import { PROMPT_VERSION, construirMensajesIniciales } from '../prompts/agente-cuenta.ts';
import {
  type EjecucionRegistrada,
  citasSoloDeFuente,
  mensajeDeLimiteDePasos,
  procesarCitas,
} from './citas.ts';
import {
  type LimitesDelRun,
  MAX_CARACTERES_DE_RESULTADO,
  acotarLimites,
  iaActiva,
  limitesDesdeEnv,
  secretoDelNonce,
} from './config.ts';
import {
  type CitaDeRespuesta,
  type InformeDeEnsamblado,
  type LlamadaDeModelo,
  completarRun,
  confirmarCancelacionDeRun,
  ensamblarContexto,
  fallarRun,
  findUserById,
  iniciarRun,
  latidoRun,
  listarMensajes,
  obtenerMensaje,
  obtenerRun,
  registrarLlamadaDeModelo,
} from './db-ports.ts';
import { type FalloDeRun, FALLOS, falloDeContexto, falloDeModelo } from './errores.ts';

// ─────────────────────────── API ───────────────────────────────────────────────

export type SalidaDelRun = 'completed' | 'step_limit' | 'failed' | 'cancelled' | 'skipped' | 'lost';

export interface ResultadoDeRun {
  readonly runId: string;
  readonly salida: SalidaDelRun;
  /** Estado del run en `agent_runs` al terminar esta ejecución. */
  readonly status: AgentRunStatus;
  /** Código del cierre fallido (`failed`), o del motivo cuando `skipped`/`lost`. */
  readonly errorCode?: string | undefined;
  /** Vueltas del modelo realizadas. */
  readonly pasos: number;
  /** Tool calls que se entregaron al registro (ejecutadas o rechazadas por él). */
  readonly toolCalls: number;
  /** Mensaje del asistente publicado (`completed`). */
  readonly messageId?: string | undefined;
  /** Alias citados por el modelo que no existían en el registro (se descartaron). */
  readonly citasDescartadas: readonly string[];
  /** Incidencias no fatales (p. ej. un fallo al escribir el ledger). Solo códigos. */
  readonly advertencias: readonly string[];
}

export interface EventoDelRuntime {
  readonly nivel: 'info' | 'warn' | 'error';
  readonly evento: string;
  readonly runId: string;
  readonly [dato: string]: string | number | boolean | undefined;
}

export type RegistroDeEventos = (evento: EventoDelRuntime) => void;

/** Por defecto solo se registran errores inesperados, y solo metadatos (nunca contenido). */
const registroPorDefecto: RegistroDeEventos = (e) => {
  if (e.nivel === 'error') console.error(JSON.stringify({ ...e, origen: 'agent-runtime' }));
};

export interface DependenciasDelRuntime {
  readonly model: ModelClient;
  readonly registry: ToolRegistry;
  readonly env?: EnvReader | undefined;
  /** Reloj inyectable (plazo del run y fecha del contexto). */
  readonly now?: (() => Date) | undefined;
  /** Sobreescribe límites (respetando los topes duros). */
  readonly limites?: Partial<LimitesDelRun> | undefined;
  readonly registrar?: RegistroDeEventos | undefined;
}

// ─────────────────────────── Utilidades ────────────────────────────────────────

function sha256(texto: string): string {
  return createHash('sha256').update(texto, 'utf8').digest('hex');
}

const esTier = (valor: string): valor is ModelTier => (MODEL_TIERS as readonly string[]).includes(valor);

function acotarResultado(contenido: string): string {
  if (contenido.trim() === '') return '{"resultado":"sin contenido"}';
  if (contenido.length <= MAX_CARACTERES_DE_RESULTADO) return contenido;
  const marca = '…[resultado acotado por el runtime]';
  return contenido.slice(0, MAX_CARACTERES_DE_RESULTADO - marca.length) + marca;
}

const SIN_TAGS_DE_PENSAMIENTO = /<think>[\s\S]*?<\/think>/gi;

/** Texto final del asistente: sin bloques de razonamiento colados y dentro del límite del chat. */
function limpiarRespuestaFinal(texto: string): string {
  const limpio = texto.replace(SIN_TAGS_DE_PENSAMIENTO, '').trim();
  if (limpio.length <= CHAT_LIMITS.mensajeMax) return limpio;
  const marca = '…[respuesta recortada]';
  return limpio.slice(0, CHAT_LIMITS.mensajeMax - marca.length) + marca;
}

/** Defensa en profundidad: el cliente ya valida, pero el runtime no confía en un `ModelClient` ajeno. */
function respuestaEsValida(r: ModelTurnResponse): boolean {
  if (r.kind === 'final') {
    return typeof r.content === 'string' && r.content.trim() !== '' && r.toolCalls.length === 0;
  }
  if (r.kind !== 'tool_calls' || r.toolCalls.length === 0) return false;
  const ids = new Set<string>();
  for (const c of r.toolCalls) {
    if (typeof c.id !== 'string' || c.id === '' || typeof c.name !== 'string' || c.name === '') return false;
    if (ids.has(c.id)) return false;
    ids.add(c.id);
  }
  return true;
}

function manifiestoDelContexto(
  informe: InformeDeEnsamblado,
  toolCatalogHash: string,
  limites: LimitesDelRun,
): Record<string, unknown> {
  return {
    assemblerVersion: informe.assemblerVersion,
    budgetVersion: informe.budgetVersion,
    policyVersion: informe.policyVersion,
    promptVersion: PROMPT_VERSION,
    toolCatalogHash,
    maxSteps: limites.maxSteps,
    totalChars: informe.totalChars,
    sections: informe.sections.map((s) => ({
      id: s.id,
      available: s.available,
      included: s.included,
      items: s.items,
      chars: s.chars,
      omissions: s.omissions.map((o) => ({ reason: o.reason, count: o.count })),
    })),
    degraded: informe.degraded.map((d) => ({ section: d.section, reason: d.reason, code: d.code })),
    registryRefs: informe.registryRefs,
  };
}

// ─────────────────────────── Ejecución ─────────────────────────────────────────

/**
 * Ejecuta el run `queued` de `actor` hasta dejarlo en un estado terminal.
 *
 * `actor` es la persona dueña del turno (la sesión que lo admitió): sirve para ubicar el
 * run y, en el peor caso (persona ya inactiva), para poder CERRARLO como fallido. Todo lo
 * demás se hace con la persona RELEÍDA de la base antes de cada vuelta y cada tool.
 *
 * Nunca lanza: una excepción inesperada cierra el run con `AGENT_RUNTIME_ERROR`.
 * Devuelve `err` solo si el run no existe o no es del actor.
 */
export async function ejecutarRun(
  actor: User,
  runId: string,
  deps: DependenciasDelRuntime,
): Promise<Result<ResultadoDeRun>> {
  const cargado = await obtenerRun(actor, runId);
  if (!cargado.ok) return cargado;
  const run = cargado.value;
  if (run.userId !== actor.id) return err({ code: 'RESOURCE_NOT_FOUND', message: 'El recurso no existe.' });

  const turno = new Turno(actor, run, deps);
  try {
    return ok(await turno.correr());
  } catch (error) {
    turno.registrar({
      nivel: 'error',
      evento: 'run.excepcion',
      runId,
      tipo: error instanceof Error ? error.name : typeof error,
    });
    return ok(await turno.cerrarFallido(FALLOS.errorDelRuntime));
  }
}

class Turno {
  private readonly env: EnvReader;
  private readonly now: () => Date;
  private readonly limites: LimitesDelRun;
  private readonly log: RegistroDeEventos;

  private actorDeCierre: User;
  private pasos = 0;
  private toolCalls = 0;
  private messageId: string | undefined;
  private readonly hechos: EjecucionRegistrada[] = [];
  private readonly advertencias: string[] = [];
  private citasDescartadas: string[] = [];

  constructor(
    private readonly actor0: User,
    private readonly run: AgentRun,
    private readonly deps: DependenciasDelRuntime,
  ) {
    this.env = deps.env ?? envDelProceso;
    this.now = deps.now ?? (() => new Date());
    this.limites = acotarLimites(limitesDesdeEnv(this.env), deps.limites);
    this.log = deps.registrar ?? registroPorDefecto;
    this.actorDeCierre = actor0;
  }

  registrar(evento: EventoDelRuntime): void {
    try {
      this.log(evento);
    } catch {
      // El registro de eventos jamás rompe el turno.
    }
  }

  // ── Resultados ──

  private resultado(
    salida: SalidaDelRun,
    status: AgentRunStatus,
    extra: { errorCode?: string | undefined } = {},
  ): ResultadoDeRun {
    const r: ResultadoDeRun = {
      runId: this.run.id,
      salida,
      status,
      errorCode: extra.errorCode,
      pasos: this.pasos,
      toolCalls: this.toolCalls,
      messageId: this.messageId,
      citasDescartadas: this.citasDescartadas,
      advertencias: this.advertencias,
    };
    this.registrar({
      nivel: salida === 'failed' ? 'warn' : 'info',
      evento: 'run.fin',
      runId: this.run.id,
      salida,
      status,
      errorCode: extra.errorCode,
      pasos: this.pasos,
      toolCalls: this.toolCalls,
    });
    return r;
  }

  /** Cierra el run como `failed`. Si ya estaba terminal (barrido, cancelación), lo informa como perdido. */
  async cerrarFallido(fallo: FalloDeRun): Promise<ResultadoDeRun> {
    const cerrado = await fallarRun(this.actorDeCierre, this.run.id, {
      errorCode: fallo.code,
      errorMessage: fallo.message,
    });
    if (cerrado.ok) return this.resultado('failed', 'failed', { errorCode: fallo.code });
    return this.resultado('lost', await this.estadoActual(), { errorCode: cerrado.error.code });
  }

  private async estadoActual(): Promise<AgentRunStatus> {
    const actual = await obtenerRun(this.actorDeCierre, this.run.id);
    return actual.ok ? actual.value.status : 'failed';
  }

  private async cerrarCancelado(actor: User): Promise<ResultadoDeRun> {
    const r = await confirmarCancelacionDeRun(actor, this.run.id);
    if (r.ok) return this.resultado('cancelled', 'cancelled');
    return this.resultado('lost', await this.estadoActual(), { errorCode: r.error.code });
  }

  // ── Persona vigente ──

  /** La persona RELEÍDA: activa, de la misma organización del run y con `chat:write`. */
  private async personaVigente(): Promise<User | undefined> {
    const fresco = await findUserById(this.actor0.id);
    if (
      fresco === undefined ||
      fresco.status !== 'activo' ||
      fresco.organizationId !== this.run.organizationId ||
      fresco.id !== this.run.userId
    ) {
      return undefined;
    }
    // `chat:write` lo exige también cada caso de uso de db; aquí se corta antes con un código claro.
    if (!roleCan(fresco.role, 'chat:write')) return undefined;
    this.actorDeCierre = fresco;
    return fresco;
  }

  // ── Punto de control: latido, cancelación, plazo, kill-switch ──

  private async puntoDeControl(actor: User, plazoMs: number): Promise<ResultadoDeRun | undefined> {
    const latido = await latidoRun(actor, this.run.id);
    if (!latido.ok) {
      // El run ya no está `running` (lo cerró el barrido, p. ej.) o la persona perdió el acceso.
      if (latido.error.details?.['reason'] === CHAT_CONFLICT_REASONS.runNotRunning) {
        return this.resultado('lost', await this.estadoActual(), { errorCode: latido.error.code });
      }
      return this.cerrarFallido(FALLOS.personaSinAcceso);
    }
    if (latido.value.cancelRequested) return this.cerrarCancelado(actor);
    if (this.now().getTime() >= plazoMs) return this.cerrarFallido(FALLOS.timeout);
    if (!iaActiva(this.env)) return this.cerrarFallido(FALLOS.iaApagada);
    return undefined;
  }

  // ── Ledger ──

  private async ledger(actor: User, llamada: LlamadaDeModelo): Promise<void> {
    const r = await registrarLlamadaDeModelo(actor, this.run.id, llamada);
    // Un fallo del ledger no tumba el turno, pero no se oculta.
    if (!r.ok) this.advertencias.push(`LEDGER_${r.error.code}`);
  }

  // ── Cuerpo del turno ──

  async correr(): Promise<ResultadoDeRun> {
    const { run, deps, limites } = this;
    const inicio = this.now().getTime();
    const plazoMs = inicio + limites.deadlineMs;

    if (run.status !== 'queued') {
      return this.resultado('skipped', run.status, { errorCode: CHAT_CONFLICT_REASONS.runNotQueued });
    }
    if (!iaActiva(this.env)) return this.cerrarFallido(FALLOS.iaApagada);

    let actor = await this.personaVigente();
    if (actor === undefined) return this.cerrarFallido(FALLOS.personaSinAcceso);

    // ── Contexto ──
    const mensaje = await obtenerMensaje(actor, run.userMessageId);
    if (!mensaje.ok) return this.cerrarFallido(falloDeContexto(mensaje.error.code));
    const historial = await listarMensajes(actor, run.conversationId, { ultimos: true, limite: 100 });
    if (!historial.ok) return this.cerrarFallido(falloDeContexto(historial.error.code));
    const ventana = historial.value.map((m) => ({
      id: m.id,
      role: m.role === 'user' ? ('actor' as const) : ('asistente' as const),
      authorId: m.role === 'user' ? m.userId : undefined,
      texto: m.content,
    }));
    const nonceSecret = secretoDelNonce(this.env);
    if (nonceSecret === undefined) return this.cerrarFallido(falloDeContexto('NONCE_SECRET'));

    const contexto = await ensamblarContexto(actor, {
      conversationId: run.conversationId,
      messageId: run.userMessageId,
      runId: run.id,
      campaignId: run.campaignId,
      nonceSecret,
      mensajeActual: {
        texto: mensaje.value.content,
        adjuntos: mensaje.value.attachments.map((a) => ({ sourceId: a.sourceId })),
      },
      ventana,
      ahora: this.now(),
    });
    if (!contexto.ok) return this.cerrarFallido(falloDeContexto(contexto.error.code));
    const ctx = contexto.value;

    const iniciado = await iniciarRun(actor, run.id, {
      contextHash: ctx.informe.contextHash,
      contextManifest: manifiestoDelContexto(ctx.informe, deps.registry.catalogHash, limites),
    });
    if (!iniciado.ok) {
      // Otro ejecutor tomó el run o la persona lo canceló en cola: no hay nada más que hacer.
      if (iniciado.error.details?.['reason'] === CHAT_CONFLICT_REASONS.runNotQueued) {
        return this.resultado('skipped', await this.estadoActual(), { errorCode: iniciado.error.code });
      }
      return this.cerrarFallido(FALLOS.errorDelRuntime);
    }

    // Base del grounding (D11): los mensajes de la persona de ESTA conversación.
    const textosDelActor = textosDelActorDeDominio(ventana, actor.id);
    const referencias = ctx.registro;
    const mensajes: ModelMessage[] = construirMensajesIniciales(ctx.texto);
    const senalDelPlazo = AbortSignal.timeout(Math.max(plazoMs - this.now().getTime(), 1));

    // ── Vueltas ──
    for (let paso = 0; paso < limites.maxSteps; paso += 1) {
      const vigente = await this.personaVigente();
      if (vigente === undefined) return this.cerrarFallido(FALLOS.personaSinAcceso);
      actor = vigente;

      const parada = await this.puntoDeControl(actor, plazoMs);
      if (parada !== undefined) return parada;

      const tools = deps.registry.definitionsFor(actor);
      const peticion: ModelTurnRequest = {
        messages: mensajes,
        tools,
        toolChoice: 'auto',
        maxTokens: limites.maxTokens,
        timeoutMs: Math.max(Math.min(limites.modelTimeoutMs, plazoMs - this.now().getTime()), 1_000),
        correlation: { conversationId: run.conversationId, agentRunId: run.id, stepIndex: paso },
      };
      const inputHash = sha256(JSON.stringify({ messages: mensajes, tools }));

      let respuesta: ModelTurnResponse;
      this.pasos += 1;
      try {
        respuesta = await deps.model.turn(peticion, senalDelPlazo);
      } catch (error) {
        if (!(error instanceof ModelError)) throw error;
        await this.ledger(actor, {
          stepIndex: paso,
          tier: run.tier,
          provider: run.provider,
          model: run.model,
          promptVersion: PROMPT_VERSION,
          inputHash,
          outputStatus: 'error',
          error: error.code,
        });
        const vencido = this.now().getTime() >= plazoMs || senalDelPlazo.aborted;
        if (error.code === 'ABORTED' && vencido) return this.cerrarFallido(FALLOS.timeout);
        return this.cerrarFallido(falloDeModelo(error));
      }

      if (!respuestaEsValida(respuesta)) {
        await this.ledger(actor, {
          stepIndex: paso,
          tier: run.tier,
          provider: run.provider,
          model: run.model,
          promptVersion: PROMPT_VERSION,
          inputHash,
          outputStatus: 'error',
          error: 'MODEL_BAD_RESPONSE',
        });
        return this.cerrarFallido(FALLOS.respuestaInvalida);
      }

      const actorDeLlamada = actor;
      const registrarLlamada = (outputStatus: string): Promise<void> =>
        this.ledger(actorDeLlamada, {
          stepIndex: paso,
          tier: esTier(respuesta.tier) ? respuesta.tier : run.tier,
          provider: respuesta.provider.slice(0, 100),
          model: respuesta.model.slice(0, 200),
          promptVersion: PROMPT_VERSION,
          inputHash,
          outputStatus,
          latencyMs: respuesta.latencyMs,
          promptTokens: respuesta.usage.promptTokens,
          completionTokens: respuesta.usage.completionTokens,
          costUsd: respuesta.usage.costUsd ?? undefined,
          generationId: respuesta.generationId ?? undefined,
        });

      // ── Respuesta final ──
      if (respuesta.kind === 'final') {
        const limpio = limpiarRespuestaFinal(respuesta.content ?? '');
        if (limpio === '') {
          await registrarLlamada('error');
          return this.cerrarFallido(FALLOS.respuestaInvalida);
        }
        const citas = procesarCitas(limpio, referencias);
        this.citasDescartadas = [...citas.descartadas];
        await registrarLlamada(citas.descartadas.length === 0 ? 'ok' : 'ok_con_descartes');
        return this.publicar(
          actor,
          citas.texto.trim() === '' ? limpio : citas.texto,
          citas.referencias,
          'completed',
        );
      }

      // ── Tool calls ──
      await registrarLlamada('ok');
      mensajes.push({ role: 'assistant', content: null, toolCalls: respuesta.toolCalls });
      let indice = 0;
      for (const llamada of respuesta.toolCalls) {
        indice += 1;
        if (indice > limites.maxToolCallsPorPaso) {
          // Más de las permitidas: NO se ejecutan, pero cada llamada recibe su respuesta.
          mensajes.push(rechazoPorExceso(llamada, limites.maxToolCallsPorPaso));
          this.hechos.push({
            toolName: llamada.name,
            execution: { status: 'failed', riskClass: 'unregistered' },
          });
          continue;
        }
        const vigenteTool = await this.personaVigente();
        if (vigenteTool === undefined) return this.cerrarFallido(FALLOS.personaSinAcceso);
        actor = vigenteTool;
        const paradaTool = await this.puntoDeControl(actor, plazoMs);
        if (paradaTool !== undefined) return paradaTool;

        const contextoDeTool: ToolRunContext = {
          actor,
          campaignId: run.campaignId,
          conversationId: run.conversationId,
          messageId: run.userMessageId,
          agentRunId: run.id,
          stepIndex: paso,
          referencias,
          textosDelActor,
          signal: senalDelPlazo,
        };
        this.toolCalls += 1;
        const ejecucion: ToolExecution = await deps.registry.execute({
          context: contextoDeTool,
          call: { id: llamada.id, name: llamada.name, arguments: llamada.arguments },
        });
        this.hechos.push({ toolName: llamada.name, execution: ejecucion });
        mensajes.push({ role: 'tool', toolCallId: llamada.id, content: acotarResultado(ejecucion.content) });
      }
    }

    // ── Límite de pasos: mensaje determinístico, SIN otra llamada de modelo ──
    const vigenteFinal = (await this.personaVigente()) ?? this.actorDeCierre;
    const parada = await this.puntoDeControl(vigenteFinal, plazoMs);
    if (parada !== undefined) return parada;
    return this.publicar(
      vigenteFinal,
      mensajeDeLimiteDePasos(limites.maxSteps, this.hechos),
      [],
      'step_limit',
    );
  }

  /** `completarRun` con respaldo si una cita apunta a un fragmento que ya no existe. */
  private async publicar(
    actor: User,
    contenido: string,
    citas: readonly CitaDeRespuesta[],
    salida: 'completed' | 'step_limit',
  ): Promise<ResultadoDeRun> {
    const intentos: (readonly CitaDeRespuesta[])[] = [citas];
    if (citas.length > 0) intentos.push(citasSoloDeFuente(citas), []);

    for (const [i, referencias] of intentos.entries()) {
      const r = await completarRun(actor, this.run.id, { content: contenido, references: referencias });
      if (r.ok) {
        this.messageId = r.value.message.id;
        return this.resultado(salida, 'completed');
      }
      const motivo = r.error.details?.['reason'];
      if (motivo === CHAT_CONFLICT_REASONS.cancelRequested) return this.cerrarCancelado(actor);
      if (motivo === CHAT_CONFLICT_REASONS.runNotRunning) {
        return this.resultado('lost', await this.estadoActual(), { errorCode: r.error.code });
      }
      if (motivo === CHAT_CONFLICT_REASONS.referenceScope && i < intentos.length - 1) {
        this.advertencias.push(i === 0 ? 'CITAS_REDUCIDAS_A_FUENTE' : 'CITAS_OMITIDAS');
        continue;
      }
      return this.cerrarFallido(FALLOS.errorDelRuntime);
    }
    return this.cerrarFallido(FALLOS.errorDelRuntime);
  }
}

function rechazoPorExceso(llamada: ModelToolCall, max: number): ModelMessage {
  return {
    role: 'tool',
    toolCallId: llamada.id,
    content: JSON.stringify({
      error: {
        code: 'AGENT_INVALID_TOOL_CALL',
        message: `Demasiadas llamadas en un paso: solo se ejecutan ${max}. Esta no se ejecutó.`,
      },
    }),
  };
}
