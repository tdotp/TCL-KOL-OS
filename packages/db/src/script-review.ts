/**
 * Revisión humana de guiones: comentarios SmartPR y cambios solicitados (V2 · Fase 7).
 *
 * Un comentario de revisión es la nota de UNA PERSONA de la agencia sobre una versión de guion
 * (`script_review_comments`, migración 023). No es un hallazgo de la IA ni un comentario del
 * Brief: entidad separada, append-only, sin estado ni resolución. Quien firma es siempre una
 * persona (la IA y el sistema no tienen columna donde firmar) y el modelo/tool NUNCA aporta
 * autor ni origen: el autor es el `actor` y el origen es el canal del `contexto` (`ui` por
 * defecto; `chat` cuando lo invoca una tool en nombre de la persona).
 *
 * El texto de un comentario nacido en el chat es una CITA EXACTA de un mensaje de la propia
 * persona (`role='user'`, misma organización y campaña): este módulo relee el mensaje y lo
 * comprueba, y el trigger de la base lo vuelve a imponer aunque este código tuviera un bug.
 *
 * Casos de uso:
 *  · `crearComentarioDeRevision`   comenta una versión abierta (received | in_review). El primer
 *                                  acto de revisión mueve `received → in_review` en la misma
 *                                  transacción. Idempotente por (versión, autor, mensaje, texto).
 *  · `solicitarCambiosDeScript`    UNA transacción: inserta los cambios pedidos como comentarios
 *                                  `change_request` (+ nota editorial opcional) y pasa la versión
 *                                  a `changes_requested` (TERMINAL: reabrir = V(N+1)). Los
 *                                  comentarios quedan colgados de ESA versión para siempre.
 *  · `listarComentariosDeRevision` lee los comentarios de una versión (sin ids de autor).
 *
 * Concurrencia: orden de bloqueo campaña (FOR SHARE) → entregable (`bloquearEntregable`, el
 * mutex común de F7) → versión FOR UPDATE. Comentar, pedir cambios y aprobar se serializan:
 * quien llega después ve el estado ya cambiado (`RESOURCE_CONFLICT{reason:'not_open'}`).
 *
 * Auditoría (misma transacción): `script_review_comment.create`, `script_version.request_changes`
 * (y `script_version.transition` si el comentario arranca la revisión). La metadata lleva solo
 * ids, tipo y LONGITUDES: nunca el texto del comentario ni de documentos.
 *
 * Autorización: crear y pedir cambios = `script:manage`; leer = `script:read` (el Operativo no
 * lee comentarios). Otra organización o cliente → `RESOURCE_NOT_FOUND`; sin la capacidad →
 * `FORBIDDEN_ROLE`. Un id mal formado es «no existe». Cerco de campaña opcional (`alcance`).
 */

import type pg from 'pg';
import {
  type Result,
  type ScriptVersionStatus,
  type SourceLocator,
  type User,
  authorizeInternalResource,
  err,
  isOpenScriptVersion,
  ok,
  validarLocalizador,
} from '@tcl-kol-os/domain';
import { recordAudit, sanitizeCorrelation } from './audit.ts';
import { type ContextoDeAuditoria, auditoriaDe, exigirPersona } from './audit-context.ts';
import { getPool } from './client.ts';
import {
  NO_ENCONTRADO_DE_CONTENIDO,
  bloquearEntregable,
  conReglasDeBase,
  esUuid,
  exigirCampanaYParticipacionActivas,
} from './deliverables.ts';
import { iniciarRevisionDeVersionEnTransaccion } from './script-versions.ts';
import { Abortar, transaccionConResultado } from './tx-result.ts';

// ─────────────────────────── Tipos públicos ────────────────────────────────────

export type TipoDeComentarioDeRevision = 'editorial' | 'change_request';

/** Máximo de cambios pedidos en una sola solicitud. */
export const MAX_CAMBIOS_POR_SOLICITUD = 20;
/** Longitud máxima de un comentario (la base lo impone también). */
export const MAX_LONGITUD_DE_COMENTARIO = 2000;

/** Un comentario, tal como se entrega hacia afuera (sin ids de autor). */
export interface ComentarioDeRevision {
  readonly id: string;
  readonly kind: TipoDeComentarioDeRevision;
  readonly createdAt: string;
  readonly body: string;
  readonly locator?: SourceLocator | undefined;
  readonly origin: 'ui' | 'chat';
  /** `self` si lo escribió quien consulta; `other` si lo escribió otra persona de la agencia. */
  readonly authorRelation: 'self' | 'other';
  /**
   * Nombre visible del autor (la UI de la agencia lo muestra: «quién pidió qué»). NO es un id:
   * una tool/proyección hacia el modelo puede omitirlo.
   */
  readonly authorDisplayName: string;
  /** El mensaje del chat del que se citó el texto (solo origen `chat`). */
  readonly chatMessageId?: string | undefined;
}

export interface NuevoComentarioDeRevision {
  readonly kind: TipoDeComentarioDeRevision;
  readonly body: string;
  /** Dónde del guion (contrato `SourceLocator`); opcional. */
  readonly locator?: unknown;
  /**
   * Origen `chat`: el mensaje de la persona del que `body` es subcadena EXACTA. Obligatorio con
   * origen `chat` y prohibido con origen `ui`.
   */
  readonly chatMessageId?: string | undefined;
}

export interface ResultadoDeComentario {
  readonly comment: ComentarioDeRevision;
  /** `true` si ya existía el mismo comentario (versión, autor, mensaje, texto): sin efecto ni auditoría. */
  readonly deduplicated: boolean;
  /** `true` si este comentario arrancó la revisión (`received → in_review`). */
  readonly startedReview: boolean;
}

/** Un cambio pedido (se guarda como comentario `change_request`). */
export interface CambioSolicitado {
  readonly body: string;
  readonly locator?: unknown;
  readonly chatMessageId?: string | undefined;
}

export interface SolicitarCambiosInput {
  /** De 1 a 20 cambios. */
  readonly items: readonly CambioSolicitado[];
  /**
   * Nota editorial opcional. Con origen `ui` basta un texto; con origen `chat` debe ser un objeto
   * con su `chatMessageId` (también es una cita exacta de un mensaje de la persona).
   */
  readonly nota?: string | CambioSolicitado | undefined;
}

export interface VersionConCambiosSolicitados {
  readonly id: string;
  readonly deliverableId: string;
  readonly version: number;
  /** Siempre `changes_requested` (terminal). */
  readonly status: 'changes_requested';
  /** El estado del que venía (`received` | `in_review`). */
  readonly previousStatus: ScriptVersionStatus;
  readonly updatedAt: string;
}

export interface ResultadoDeCambiosSolicitados {
  readonly version: VersionConCambiosSolicitados;
  /** Los `change_request` creados, en el orden pedido. */
  readonly changeRequests: readonly ComentarioDeRevision[];
  /** La nota editorial, si se envió. */
  readonly note?: ComentarioDeRevision | undefined;
}

export interface ListarComentariosOpciones {
  readonly kind?: TipoDeComentarioDeRevision | undefined;
  /** 1–200 (50 por defecto). */
  readonly limite?: number | undefined;
  readonly desde?: number | undefined;
}

export interface PaginaDeComentarios {
  /** Del más antiguo al más reciente. */
  readonly items: ComentarioDeRevision[];
  /** Total que cumple el filtro (no solo esta página). */
  readonly total: number;
  /** El `desde` de la página siguiente, o `null` si no hay más. */
  readonly nextOffset: number | null;
}

type Alcance = { readonly campaignId: string } | undefined;

// ─────────────────────────── Filas y utilidades ────────────────────────────────

interface FilaDeComentario {
  readonly id: string;
  readonly kind: TipoDeComentarioDeRevision;
  readonly created_at: Date;
  readonly body: string;
  readonly locator: SourceLocator | null;
  readonly origin: 'ui' | 'chat';
  readonly author_id: string;
  readonly author_name: string;
  readonly chat_message_id: string | null;
}

const COLUMNAS_DE_COMENTARIO = `
  c.id, c.kind, c.created_at, c.body, c.locator, c.origin, c.author_id,
  u.name AS author_name, c.chat_message_id
`;

/** Orden estable: por fecha; el empate (misma transacción) por orden físico de inserción. */
const ORDEN_DE_COMENTARIOS = 'c.created_at, c.ctid';

function comoComentario(fila: FilaDeComentario, actor: User): ComentarioDeRevision {
  return {
    id: fila.id,
    kind: fila.kind,
    createdAt: fila.created_at.toISOString(),
    body: fila.body,
    ...(fila.locator === null ? {} : { locator: fila.locator }),
    origin: fila.origin,
    authorRelation: fila.author_id === actor.id ? 'self' : 'other',
    authorDisplayName: fila.author_name,
    ...(fila.chat_message_id === null ? {} : { chatMessageId: fila.chat_message_id }),
  };
}

function invalido(field: string, reason: string, message: string): Abortar {
  return new Abortar({ code: 'VALIDATION_FAILED', message, details: { field, reason } });
}

function longitud(texto: string): number {
  return Array.from(texto).length;
}

interface ComentarioNormalizado {
  readonly kind: TipoDeComentarioDeRevision;
  readonly body: string;
  readonly locator: SourceLocator | null;
  readonly chatMessageId: string | null;
}

/**
 * Valida y normaliza un comentario de entrada (forma, longitud, localizador, coherencia con el
 * origen). El texto se guarda sin espacios en los bordes (una subcadena recortada de un mensaje
 * sigue siendo subcadena del mensaje).
 */
function normalizarComentario(
  entrada: unknown,
  campo: string,
  origen: 'ui' | 'chat',
  kindFijo?: TipoDeComentarioDeRevision,
): ComentarioNormalizado {
  if (typeof entrada !== 'object' || entrada === null || Array.isArray(entrada)) {
    throw invalido(campo, 'invalid_shape', 'El comentario debe ser un objeto.');
  }
  const e = entrada as Record<string, unknown>;
  const kind = kindFijo ?? e['kind'];
  if (kind !== 'editorial' && kind !== 'change_request') {
    throw invalido(
      `${campo}.kind`,
      'invalid_kind',
      'El tipo de comentario debe ser editorial o change_request.',
    );
  }
  if (typeof e['body'] !== 'string') {
    throw invalido(`${campo}.body`, 'invalid_body', 'El texto del comentario es obligatorio.');
  }
  const body = e['body'].trim();
  if (body === '') throw invalido(`${campo}.body`, 'empty_body', 'El comentario no puede estar vacío.');
  if (body.includes('\u0000')) {
    throw invalido(`${campo}.body`, 'invalid_body', 'El comentario contiene caracteres no válidos.');
  }
  if (longitud(body) > MAX_LONGITUD_DE_COMENTARIO) {
    throw invalido(
      `${campo}.body`,
      'body_too_long',
      `El comentario no puede superar ${MAX_LONGITUD_DE_COMENTARIO} caracteres.`,
    );
  }

  let locator: SourceLocator | null = null;
  if (e['locator'] !== undefined && e['locator'] !== null) {
    const valido = validarLocalizador(e['locator']);
    if (!valido.ok) {
      throw invalido(`${campo}.locator`, 'invalid_locator', 'El localizador del comentario no es válido.');
    }
    locator = valido.value;
  }

  const chat = e['chatMessageId'];
  let chatMessageId: string | null = null;
  if (chat !== undefined && chat !== null) {
    if (!esUuid(chat)) {
      throw invalido(
        `${campo}.chatMessageId`,
        'chat_message_invalid',
        'El mensaje de chat citado no es válido.',
      );
    }
    chatMessageId = chat;
  }
  if (origen === 'chat' && chatMessageId === null) {
    throw invalido(
      `${campo}.chatMessageId`,
      'chat_message_required',
      'Un comentario nacido en el chat debe citar el mensaje de la persona del que proviene.',
    );
  }
  if (origen === 'ui' && chatMessageId !== null) {
    throw invalido(
      `${campo}.chatMessageId`,
      'chat_message_requires_chat_origin',
      'Solo un comentario con origen chat puede citar un mensaje del chat.',
    );
  }
  return { kind, body, locator, chatMessageId };
}

/** Origen del comentario según el canal del contexto (nunca `system`: `exigirPersona` lo rechaza). */
function origenDe(contexto: ContextoDeAuditoria | undefined): 'ui' | 'chat' {
  return contexto?.origin === 'chat' ? 'chat' : 'ui';
}

/** La versión con su ubicación, o «no existe» (id mal formado, otro alcance o inexistente). */
interface UbicacionDeVersion {
  readonly id: string;
  readonly deliverable_id: string;
  readonly organization_id: string;
  readonly campaign_id: string;
}

async function ubicarVersion(versionId: unknown, alcance: Alcance): Promise<Result<UbicacionDeVersion>> {
  if (!esUuid(versionId)) return err(NO_ENCONTRADO_DE_CONTENIDO);
  const { rows } = await getPool().query<UbicacionDeVersion>(
    `SELECT id, deliverable_id, organization_id, campaign_id FROM script_versions WHERE id = $1`,
    [versionId],
  );
  const donde = rows[0];
  if (donde === undefined) return err(NO_ENCONTRADO_DE_CONTENIDO);
  if (alcance !== undefined && donde.campaign_id !== alcance.campaignId) {
    return err(NO_ENCONTRADO_DE_CONTENIDO);
  }
  return ok(donde);
}

interface VersionAbierta {
  readonly numero: number;
  readonly estado: ScriptVersionStatus;
}

/**
 * Dentro de la transacción: bloquea campaña (FOR SHARE) → entregable → versión y exige que la
 * versión esté abierta, el entregable activo y la campaña y la participación activas.
 */
async function abrirVersionParaRevisar(
  client: pg.PoolClient,
  donde: UbicacionDeVersion,
): Promise<VersionAbierta> {
  // Archivar la campaña espera a que este acto de revisión termine (como el alta de versiones).
  await client.query(`SELECT 1 FROM campaigns WHERE id = $1 FOR SHARE`, [donde.campaign_id]);
  const entregable = await bloquearEntregable(client, donde.deliverable_id);
  if (entregable === undefined) throw new Abortar(NO_ENCONTRADO_DE_CONTENIDO);
  const { rows } = await client.query<{ version: number; status: ScriptVersionStatus }>(
    `SELECT version, status FROM script_versions WHERE id = $1 FOR UPDATE`,
    [donde.id],
  );
  const v = rows[0];
  if (v === undefined) throw new Abortar(NO_ENCONTRADO_DE_CONTENIDO);
  if (!isOpenScriptVersion(v.status)) {
    throw new Abortar({
      code: 'RESOURCE_CONFLICT',
      message: `La versión ya no admite revisión: su estado es «${v.status}».`,
      details: { reason: 'not_open', status: v.status },
    });
  }
  if (entregable.status !== 'active') {
    throw new Abortar({
      code: 'RESOURCE_CONFLICT',
      message: 'El entregable está archivado: reactívelo para revisar sus versiones.',
      details: { reason: 'deliverable_archived', deliverableId: entregable.id },
    });
  }
  await exigirCampanaYParticipacionActivas(client, entregable);
  return { numero: v.version, estado: v.status };
}

/**
 * Releer el mensaje citado y comprobar que lo escribió la propia persona (rol `user`, misma
 * organización y campaña) y que `body` es subcadena EXACTA. Todo fallo de identidad es el mismo
 * error (no revela si el mensaje existe ni de quién es).
 */
async function verificarCitaDeChat(
  client: pg.PoolClient,
  actor: User,
  donde: UbicacionDeVersion,
  campo: string,
  chatMessageId: string,
  body: string,
): Promise<void> {
  const { rows } = await client.query<{
    role: string;
    user_id: string;
    organization_id: string;
    campaign_id: string;
    contiene: boolean;
  }>(
    `SELECT role, user_id, organization_id, campaign_id, position($2 IN content) > 0 AS contiene
       FROM chat_messages WHERE id = $1`,
    [chatMessageId, body],
  );
  const m = rows[0];
  if (
    m === undefined ||
    m.role !== 'user' ||
    m.user_id !== actor.id ||
    m.organization_id !== donde.organization_id ||
    m.campaign_id !== donde.campaign_id
  ) {
    throw invalido(
      `${campo}.chatMessageId`,
      'chat_message_invalid',
      'El mensaje citado debe ser un mensaje escrito por la persona, en esta campaña.',
    );
  }
  if (!m.contiene) {
    throw invalido(
      `${campo}.body`,
      'quote_not_in_message',
      'El texto del comentario debe ser una cita exacta del mensaje de la persona.',
    );
  }
}

async function insertarComentario(
  client: pg.PoolClient,
  actor: User,
  donde: UbicacionDeVersion,
  c: ComentarioNormalizado,
  origen: 'ui' | 'chat',
  contexto: ContextoDeAuditoria | undefined,
): Promise<ComentarioDeRevision> {
  const correlacion = sanitizeCorrelation(contexto?.correlation);
  const { rows } = await conReglasDeBase(() =>
    client.query<{ id: string }>(
      `INSERT INTO script_review_comments
         (organization_id, campaign_id, script_version_id, author_id, kind, body, locator, origin,
          chat_message_id, correlation)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10::jsonb)
       RETURNING id`,
      [
        donde.organization_id,
        donde.campaign_id,
        donde.id,
        actor.id,
        c.kind,
        c.body,
        c.locator === null ? null : JSON.stringify(c.locator),
        origen,
        c.chatMessageId,
        correlacion === null ? null : JSON.stringify(correlacion),
      ],
    ),
  );
  return await leerComentario(client, actor, rows[0]!.id);
}

async function leerComentario(
  db: pg.Pool | pg.PoolClient,
  actor: User,
  id: string,
): Promise<ComentarioDeRevision> {
  const { rows } = await db.query<FilaDeComentario>(
    `SELECT ${COLUMNAS_DE_COMENTARIO}
       FROM script_review_comments c JOIN users u ON u.id = c.author_id
      WHERE c.id = $1`,
    [id],
  );
  return comoComentario(rows[0]!, actor);
}

const CONFLICTO_CONCURRENTE = {
  code: 'RESOURCE_CONFLICT',
  message: 'La versión cambió mientras se comentaba: reintente.',
  details: { reason: 'concurrent_update' },
} as const;

// ─────────────────────────── Crear un comentario ───────────────────────────────

/**
 * Comenta una versión de guion ABIERTA (received | in_review) como la persona que invoca.
 *
 *  · El autor es `actor` y el origen es el canal del `contexto` (`ui` por defecto, o `chat`);
 *    ninguno de los dos viene de la entrada. `system` jamás.
 *  · Origen `chat`: `chatMessageId` es obligatorio; se relee el mensaje (rol `user`, autor =
 *    `actor`, misma organización y campaña) y `body` debe ser subcadena EXACTA. Origen `ui`:
 *    `chatMessageId` está prohibido.
 *  · Si la versión está `received`, la mueve a `in_review` en la misma transacción (el comentario
 *    es el primer acto de revisión; audita `script_version.transition`).
 *  · Idempotente: el mismo comentario (versión, autor, tipo, mensaje, localizador y texto) devuelve
 *    el existente con `deduplicated: true`, sin efectos ni auditoría.
 *  · Versión cerrada → `RESOURCE_CONFLICT{reason:'not_open'}`; campaña o participación inactivas →
 *    `RESOURCE_CONFLICT`.
 *
 * Exige `script:manage`. Auditoría `script_review_comment.create` (solo ids, tipo y longitud).
 */
export async function crearComentarioDeRevision(
  actor: User,
  versionId: string,
  comentario: NuevoComentarioDeRevision,
  contexto?: ContextoDeAuditoria,
  alcance?: Alcance,
): Promise<Result<ResultadoDeComentario>> {
  const persona = exigirPersona(actor, contexto);
  if (!persona.ok) return persona;
  const ubicada = await ubicarVersion(versionId, alcance);
  if (!ubicada.ok) return ubicada;
  const donde = ubicada.value;
  const permitido = authorizeInternalResource(actor, 'script:manage', donde.organization_id);
  if (!permitido.ok) return permitido;

  const origen = origenDe(contexto);
  let c: ComentarioNormalizado;
  try {
    c = normalizarComentario(comentario, 'comment', origen);
  } catch (error) {
    if (error instanceof Abortar) return err(error.payload);
    throw error;
  }

  return transaccionConResultado(async (client): Promise<ResultadoDeComentario> => {
    const abierta = await abrirVersionParaRevisar(client, donde);

    // Idempotencia de dominio, bajo el mutex del entregable.
    const { rows: previos } = await client.query<{ id: string }>(
      `SELECT c.id FROM script_review_comments c
        WHERE c.script_version_id = $1 AND c.author_id = $2 AND c.kind = $3 AND c.body = $4
          AND c.chat_message_id IS NOT DISTINCT FROM $5::uuid
          AND c.locator IS NOT DISTINCT FROM $6::jsonb
        ORDER BY ${ORDEN_DE_COMENTARIOS} LIMIT 1`,
      [
        donde.id,
        actor.id,
        c.kind,
        c.body,
        c.chatMessageId,
        c.locator === null ? null : JSON.stringify(c.locator),
      ],
    );
    if (previos[0] !== undefined) {
      return {
        comment: await leerComentario(client, actor, previos[0].id),
        deduplicated: true,
        startedReview: false,
      };
    }

    if (c.chatMessageId !== null) {
      await verificarCitaDeChat(client, actor, donde, 'comment', c.chatMessageId, c.body);
    }

    // El primer acto de revisión arranca la revisión (received → in_review).
    let arranco = false;
    if (abierta.estado === 'received') {
      const r = await iniciarRevisionDeVersionEnTransaccion(client, actor, donde.id, contexto, alcance);
      if (!r.ok) throw new Abortar(r.error);
      arranco = r.value.changed;
    }

    const creado = await insertarComentario(client, actor, donde, c, origen, contexto);
    await recordAudit(
      client,
      auditoriaDe(actor, contexto, {
        action: 'script_review_comment.create',
        entityType: 'script_review_comment',
        entityId: creado.id,
        metadata: {
          campaignId: donde.campaign_id,
          deliverableId: donde.deliverable_id,
          scriptVersionId: donde.id,
          version: abierta.numero,
          kind: c.kind,
          length: longitud(c.body),
          hasLocator: c.locator !== null,
          ...(c.chatMessageId === null ? {} : { chatMessageId: c.chatMessageId }),
          startedReview: arranco,
        },
      }),
    );
    return { comment: creado, deduplicated: false, startedReview: arranco };
  }, CONFLICTO_CONCURRENTE);
}

// ─────────────────────────── Solicitar cambios ─────────────────────────────────

/**
 * Pide cambios sobre una versión ABIERTA: UNA transacción que inserta los cambios como
 * comentarios `change_request` (+ una nota `editorial` opcional) y deja la versión en
 * `changes_requested`, estado TERMINAL (la versión no cambia en nada más; reabrir es registrar
 * la V(N+1), que NO copia ni borra estos comentarios).
 *
 *  · 1 a 20 cambios. Mismas reglas de autor, origen y cita que `crearComentarioDeRevision`
 *    (cada cambio, y la nota, con origen `chat` son citas exactas de un mensaje de la persona).
 *  · Versión que ya no está abierta (p. ej. otra persona pidió cambios o la aprobó antes) →
 *    `RESOURCE_CONFLICT{reason:'not_open'}`: de dos solicitudes simultáneas gana una.
 *  · Cualquier fallo deshace todo: ni comentarios ni cambio de estado.
 *
 * Exige `script:manage`; ui o chat (no es una decisión crítica). Auditoría
 * `script_version.request_changes` (cifras, longitudes e ids; nunca el texto).
 */
export async function solicitarCambiosDeScript(
  actor: User,
  versionId: string,
  input: SolicitarCambiosInput,
  contexto?: ContextoDeAuditoria,
  alcance?: Alcance,
): Promise<Result<ResultadoDeCambiosSolicitados>> {
  const persona = exigirPersona(actor, contexto);
  if (!persona.ok) return persona;
  const ubicada = await ubicarVersion(versionId, alcance);
  if (!ubicada.ok) return ubicada;
  const donde = ubicada.value;
  const permitido = authorizeInternalResource(actor, 'script:manage', donde.organization_id);
  if (!permitido.ok) return permitido;

  const origen = origenDe(contexto);
  let cambios: ComentarioNormalizado[];
  let nota: ComentarioNormalizado | undefined;
  try {
    if (typeof input !== 'object' || input === null || !Array.isArray(input.items)) {
      throw invalido('items', 'invalid_shape', 'Indique los cambios solicitados.');
    }
    if (input.items.length < 1 || input.items.length > MAX_CAMBIOS_POR_SOLICITUD) {
      throw invalido(
        'items',
        'invalid_count',
        `Indique entre 1 y ${MAX_CAMBIOS_POR_SOLICITUD} cambios solicitados.`,
      );
    }
    cambios = input.items.map((item, i) =>
      normalizarComentario(item, `items[${i}]`, origen, 'change_request'),
    );
    if (input.nota !== undefined && input.nota !== null) {
      const cruda = typeof input.nota === 'string' ? { body: input.nota } : input.nota;
      nota = normalizarComentario(cruda, 'nota', origen, 'editorial');
    }
  } catch (error) {
    if (error instanceof Abortar) return err(error.payload);
    throw error;
  }

  return transaccionConResultado(
    async (client): Promise<ResultadoDeCambiosSolicitados> => {
      const abierta = await abrirVersionParaRevisar(client, donde);

      // Las citas del chat se verifican ANTES de escribir nada.
      for (const [i, c] of cambios.entries()) {
        if (c.chatMessageId !== null) {
          await verificarCitaDeChat(client, actor, donde, `items[${i}]`, c.chatMessageId, c.body);
        }
      }
      if (nota?.chatMessageId != null) {
        await verificarCitaDeChat(client, actor, donde, 'nota', nota.chatMessageId, nota.body);
      }

      // Primero los comentarios (el trigger exige versión abierta), luego el estado.
      const creados: ComentarioDeRevision[] = [];
      for (const c of cambios) {
        creados.push(await insertarComentario(client, actor, donde, c, origen, contexto));
      }
      const notaCreada =
        nota === undefined
          ? undefined
          : await insertarComentario(client, actor, donde, nota, origen, contexto);

      const version = await conReglasDeBase(async () => {
        const { rows } = await client.query<{ updated_at: Date }>(
          `UPDATE script_versions SET status = 'changes_requested' WHERE id = $1 RETURNING updated_at`,
          [donde.id],
        );
        return rows[0]!;
      });

      await recordAudit(
        client,
        auditoriaDe(actor, contexto, {
          action: 'script_version.request_changes',
          entityType: 'script_version',
          entityId: donde.id,
          metadata: {
            campaignId: donde.campaign_id,
            deliverableId: donde.deliverable_id,
            version: abierta.numero,
            from: abierta.estado,
            to: 'changes_requested',
            itemCount: cambios.length,
            itemLengths: cambios.map((c) => longitud(c.body)),
            hasNote: nota !== undefined,
            ...(nota === undefined ? {} : { noteLength: longitud(nota.body) }),
            commentIds: creados.map((c) => c.id),
            ...(notaCreada === undefined ? {} : { noteCommentId: notaCreada.id }),
          },
        }),
      );

      return {
        version: {
          id: donde.id,
          deliverableId: donde.deliverable_id,
          version: abierta.numero,
          status: 'changes_requested',
          previousStatus: abierta.estado,
          updatedAt: version.updated_at.toISOString(),
        },
        changeRequests: creados,
        ...(notaCreada === undefined ? {} : { note: notaCreada }),
      };
    },
    {
      code: 'RESOURCE_CONFLICT',
      message: 'La versión cambió mientras se solicitaban los cambios: reintente.',
      details: { reason: 'concurrent_update' },
    },
  );
}

// ─────────────────────────── Listar comentarios ────────────────────────────────

/**
 * Los comentarios de una versión (cualquier estado de la versión: los de una versión cerrada
 * siguen legibles), del más antiguo al más reciente, paginados. Exige `script:read`: el Operativo
 * y el cliente no leen comentarios. No expone ids de autor: solo `authorRelation` y el nombre
 * visible (`authorDisplayName`).
 */
export async function listarComentariosDeRevision(
  actor: User,
  versionId: string,
  opciones: ListarComentariosOpciones = {},
  alcance?: Alcance,
): Promise<Result<PaginaDeComentarios>> {
  const ubicada = await ubicarVersion(versionId, alcance);
  if (!ubicada.ok) return ubicada;
  const permitido = authorizeInternalResource(actor, 'script:read', ubicada.value.organization_id);
  if (!permitido.ok) return permitido;

  const kind = opciones.kind;
  if (kind !== undefined && kind !== 'editorial' && kind !== 'change_request') {
    return err({
      code: 'VALIDATION_FAILED',
      message: 'El tipo de comentario debe ser editorial o change_request.',
      details: { field: 'kind', reason: 'invalid_kind' },
    });
  }
  const limiteCrudo = Number(opciones.limite ?? 50);
  const desdeCrudo = Number(opciones.desde ?? 0);
  const limite = Number.isFinite(limiteCrudo) ? Math.min(Math.max(Math.trunc(limiteCrudo), 1), 200) : 50;
  const desde = Number.isFinite(desdeCrudo) ? Math.max(Math.trunc(desdeCrudo), 0) : 0;

  const filtro = kind === undefined ? '' : 'AND c.kind = $2';
  const parametros: unknown[] = kind === undefined ? [versionId] : [versionId, kind];
  const { rows: totales } = await getPool().query<{ n: string }>(
    `SELECT count(*)::text AS n FROM script_review_comments c WHERE c.script_version_id = $1 ${filtro}`,
    parametros,
  );
  const total = Number(totales[0]!.n);
  const { rows } = await getPool().query<FilaDeComentario>(
    `SELECT ${COLUMNAS_DE_COMENTARIO}
       FROM script_review_comments c JOIN users u ON u.id = c.author_id
      WHERE c.script_version_id = $1 ${filtro}
      ORDER BY ${ORDEN_DE_COMENTARIOS}
      LIMIT ${limite} OFFSET ${desde}`,
    parametros,
  );
  const items = rows.map((r) => comoComentario(r, actor));
  return ok({ items, total, nextOffset: desde + items.length < total ? desde + items.length : null });
}
