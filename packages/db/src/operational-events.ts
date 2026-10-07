/**
 * Eventos operativos (V2 · Fase 8, DEC-049): el MOTOR que mueve el estado de un envío, un documento de cobro
 * o una obligación de pago, y la lectura de su historial.
 *
 * Mecanismo (F8_FREEZE §3), siempre en UNA transacción del llamador (`aplicarEventoOperativo` no abre ni cierra
 * la transacción: así lo reutilizan los casos de uso de envíos, cobro/pago, evidencia y —W1d— el alta de la
 * obligación de pago desde el acuerdo):
 *
 *   1. bloquea el sujeto `FOR UPDATE` (el mutex; mismo patrón que `bloquearEntregable`);
 *   2. autoriza contra la organización DEL SUJETO (ajeno ⇒ `RESOURCE_NOT_FOUND`);
 *   3. idempotencia por (organización, `idempotencyKey`) + huella de la solicitud: el reintento idéntico
 *      devuelve el MISMO evento sin duplicar; la misma clave con otra huella ⇒ `RESOURCE_CONFLICT`
 *      `idempotency_key_reused`;
 *   4. control optimista: `expectedSeq` ≠ `row_seq` ⇒ `RESOURCE_CONFLICT` `stale_transition`;
 *   5. valida la solicitud con el dominio puro (arista del grafo, hechos exigidos);
 *   6. inserta el evento, la evidencia que lo acompaña y actualiza el sujeto (`status`, `row_seq + 1`,
 *      `last_event_id` y los atributos propios de la transición);
 *   7. audita con SOLO ids, estados, tipos, conteos y marcas: jamás montos, notas, referencias externas,
 *      nombres de archivo ni datos personales (allowlist de `audit.ts`).
 *
 * La base impone lo mismo con triggers (031): un UPDATE del estado sin evento falla, y un evento sin aplicar al
 * sujeto falla al cerrar la transacción. Solo una persona por la UI registra estado operativo: la IA, el chat y
 * el sistema se rechazan aquí y por el CHECK `origin = 'ui'`.
 *
 * Para crear un sujeto (el alta de la obligación de pago desde el acuerdo, W1d): se inserta la fila del sujeto
 * (nace con `row_seq = 0`) y se llama a `aplicarEventoOperativo` con `expectedSeq: 0` y el evento de creación
 * (`payment.applicability_set` con `toStatus` = estado inicial). En la creación la huella NO incluye el id del
 * sujeto (aún no existe en un reintento): el llamador debe poner la participación/acuerdo en `huellaExtra`.
 */

import { createHash } from 'node:crypto';
import type pg from 'pg';
import {
  type Action,
  type EvidenceKind,
  type OperationalEventType,
  type OperationalSubjectType,
  type Result,
  type User,
  authorizeInternalResource,
  err,
  esClaveDeIdempotenciaValida,
  isEvidenceKind,
  isOperationalSubjectType,
  ok,
  readActionForSubject,
  roleCan,
  roleMayRecordEvent,
  validateOperationalEventRequest,
} from '@tcl-kol-os/domain';
import { recordAudit } from './audit.ts';
import { type ContextoDeAuditoria, auditoriaDe } from './audit-context.ts';
import { query, transaction } from './client.ts';
import { NO_ENCONTRADO_DE_CONTENIDO, esUuid } from './deliverables.ts';
import { Abortar } from './tx-result.ts';

type Consultor = pg.Pool | pg.PoolClient;

// ─────────────────────────── Tablas y columnas de cada sujeto ──────────────────

const TABLA_DE_SUJETO: Readonly<Record<OperationalSubjectType, string>> = {
  shipment: 'shipments',
  billing_document: 'billing_documents',
  payment_obligation: 'payment_obligations',
};

const COLUMNA_DE_EVENTO: Readonly<Record<OperationalSubjectType, string>> = {
  shipment: 'shipment_id',
  billing_document: 'billing_document_id',
  payment_obligation: 'payment_obligation_id',
};

/** Atributos que una transición puede fijar junto con el estado (lista blanca por sujeto). */
const COLUMNAS_EXTRA: Readonly<Record<OperationalSubjectType, readonly string[]>> = {
  shipment: ['carrier', 'tracking_ref', 'cancel_reason'],
  billing_document: [],
  payment_obligation: [],
};

/** Acción de auditoría por tipo de evento (`audit.ts` reconoce estos prefijos como operativos). */
function accionDeAuditoria(eventType: OperationalEventType): string {
  return eventType === 'evidence.attached' ? 'ops_evidence.attached' : eventType;
}

// ─────────────────────────── Tipos públicos ────────────────────────────────────

export interface SujetoOperativo {
  readonly tipo: OperationalSubjectType;
  readonly id: string;
}

/** Fila del sujeto ya BLOQUEADA (`FOR UPDATE`). */
export interface SujetoBloqueado {
  readonly tipo: OperationalSubjectType;
  readonly id: string;
  readonly organizationId: string;
  readonly campaignId: string;
  readonly status: string;
  readonly rowSeq: number;
}

/** Evidencia que acompaña al evento: una fuente `soporte_operativo` YA subida en esta transacción. */
export interface EvidenciaPorAdjuntar {
  readonly sourceDocumentId: string;
  readonly kind: EvidenceKind;
}

export interface AplicarEventoInput {
  readonly actor: User;
  readonly contexto?: ContextoDeAuditoria | undefined;
  /** Capacidad que el actor debe tener sobre la organización del sujeto (p. ej. `shipment:manage`). */
  readonly action: Action;
  readonly sujeto: SujetoOperativo;
  readonly eventType: OperationalEventType;
  /** Estado destino; `null`/omitido para notas y evidencia. */
  readonly toStatus?: string | null | undefined;
  /** `row_seq` que el llamador vio (0 para el evento de creación). */
  readonly expectedSeq: number;
  readonly idempotencyKey: string;
  readonly happenedOn?: string | null | undefined;
  readonly externalReference?: string | null | undefined;
  /** Interna: jamás a auditoría ni al agente. */
  readonly note?: string | null | undefined;
  /** Atributos del sujeto que fija la transición (solo columnas de `COLUMNAS_EXTRA`). */
  readonly cambios?: Readonly<Record<string, string | null>> | undefined;
  readonly evidencias?: readonly EvidenciaPorAdjuntar[] | undefined;
  /** Datos de la solicitud que no viajan en el evento pero identifican el intento (entran en la huella). */
  readonly huellaExtra?: unknown;
  /** Claves extra de auditoría (solo las permitidas por la allowlist: `count`, `itemCount`, ids…). */
  readonly auditoria?: Readonly<Record<string, unknown>> | undefined;
  /**
   * Reglas del caso de uso que dependen del estado vigente. Corre con el sujeto bloqueado, DESPUÉS de la
   * idempotencia y del control de `expectedSeq`, y ANTES de validar la arista y de escribir (por eso debe
   * ignorar los estados de origen que la arista ya rechaza). Lanza `Abortar` para rechazar.
   */
  readonly precondicion?:
    ((ctx: { client: pg.PoolClient; sujeto: SujetoBloqueado }) => Promise<void>) | undefined;
}

export interface EventoOperativo {
  readonly id: string;
  readonly subjectType: OperationalSubjectType;
  readonly subjectId: string;
  readonly campaignId: string;
  readonly eventType: OperationalEventType;
  readonly fromStatus: string | null;
  readonly toStatus: string | null;
  readonly subjectSeq: number;
  readonly occurredAt: string;
  readonly recordedAt: string;
  readonly recordedBy: string;
  readonly recordedByName: string | null;
  /** `YYYY-MM-DD` del hecho (envío, entrega, pago). */
  readonly happenedOn: string | null;
  /** Evidencia vigente (no retirada) adjunta al evento. */
  readonly evidenceCount: number;
  /** Solo con la capacidad de gestión del sujeto (ver `listarEventosOperativos`). */
  readonly externalReference?: string | null | undefined;
  readonly note?: string | null | undefined;
}

export interface ResultadoDeEvento {
  readonly evento: EventoOperativo;
  /** `true` si era un reintento idéntico: se devolvió el evento original sin escribir nada. */
  readonly repetido: boolean;
  /** Estado del sujeto TRAS el evento (o el vigente, en un reintento). */
  readonly sujeto: SujetoBloqueado;
}

// ─────────────────────────── Autorización de persona por la UI ─────────────────

/**
 * Solo una persona, por la interfaz, registra estado operativo. El `system` y cualquier valor que no sea un
 * usuario se rechazan (`FORBIDDEN_ROLE`); el canal `chat` exige la confirmación humana (`HUMAN_CONFIRMATION_REQUIRED`).
 */
export function exigirPersonaPorUi(actor: unknown, contexto: ContextoDeAuditoria | undefined): Result<User> {
  if (typeof actor !== 'object' || actor === null) {
    return err({
      code: 'FORBIDDEN_ROLE',
      message: 'Esta operación la ejecuta una persona autorizada, no el sistema.',
    });
  }
  const origen = contexto?.origin ?? 'ui';
  if (origen === 'chat') {
    return err({
      code: 'HUMAN_CONFIRMATION_REQUIRED',
      message:
        'La operación (envíos, cobro, pagos, evidencia) la registra una persona por la interfaz, no el chat.',
      details: { reason: 'operational_state_is_ui_only' },
    });
  }
  if (origen !== 'ui') {
    return err({
      code: 'FORBIDDEN_ROLE',
      message: 'Solo una persona, por la interfaz, registra estado operativo (la IA y el sistema no).',
      details: { reason: 'operational_state_is_ui_only' },
    });
  }
  return ok(actor as User);
}

/** Variante para dentro de una transacción: lanza `Abortar`. */
export function exigirPersonaPorUiOAbortar(actor: unknown, contexto: ContextoDeAuditoria | undefined): User {
  const r = exigirPersonaPorUi(actor, contexto);
  if (!r.ok) throw new Abortar({ code: r.error.code, message: r.error.message, details: r.error.details });
  return r.value;
}

/** `authorizeInternalResource` que lanza `Abortar`. */
export function autorizarOAbortar(actor: User, action: Action, organizationId: string): void {
  const r = authorizeInternalResource(actor, action, organizationId);
  if (!r.ok) throw new Abortar({ code: r.error.code, message: r.error.message, details: r.error.details });
}

// ─────────────────────────── Huella de la solicitud ────────────────────────────

function canonico(valor: unknown): unknown {
  if (Array.isArray(valor)) return valor.map(canonico);
  if (typeof valor === 'object' && valor !== null) {
    const salida: Record<string, unknown> = {};
    for (const clave of Object.keys(valor).sort()) {
      const v = (valor as Record<string, unknown>)[clave];
      if (v !== undefined) salida[clave] = canonico(v);
    }
    return salida;
  }
  return valor;
}

/** SHA-256 hex de un objeto con las claves ordenadas (estable ante el orden de propiedades). */
export function huellaDeSolicitud(partes: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(canonico(partes)))
    .digest('hex');
}

function textoONulo(valor: string | null | undefined): string | null {
  if (valor === undefined || valor === null) return null;
  const t = valor.trim();
  return t === '' ? null : t;
}

export interface PartesDeHuella {
  readonly sujeto: SujetoOperativo;
  readonly eventType: OperationalEventType;
  readonly toStatus?: string | null | undefined;
  readonly expectedSeq: number;
  readonly happenedOn?: string | null | undefined;
  readonly externalReference?: string | null | undefined;
  readonly note?: string | null | undefined;
  readonly cambios?: Readonly<Record<string, string | null>> | undefined;
  readonly evidencias?: readonly EvidenciaPorAdjuntar[] | undefined;
  readonly huellaExtra?: unknown;
}

/**
 * Huella de una solicitud de evento. En la CREACIÓN (`expectedSeq = 0`) no incluye el id del sujeto (en un
 * reintento aún no existe): la identidad la dan `huellaExtra` y el resto de la solicitud.
 */
export function calcularHuellaDeEvento(p: PartesDeHuella): string {
  const esCreacion = p.expectedSeq === 0;
  return huellaDeSolicitud({
    tipo: p.sujeto.tipo,
    sujeto: esCreacion ? null : p.sujeto.id,
    eventType: p.eventType,
    toStatus: p.toStatus ?? null,
    expectedSeq: p.expectedSeq,
    happenedOn: p.happenedOn ?? null,
    externalReference: textoONulo(p.externalReference),
    note: textoONulo(p.note),
    cambios: p.cambios ?? null,
    evidencias: [...(p.evidencias ?? [])]
      .map((e) => ({ sourceDocumentId: e.sourceDocumentId, kind: e.kind }))
      .sort((a, b) => a.sourceDocumentId.localeCompare(b.sourceDocumentId)),
    extra: p.huellaExtra ?? null,
  });
}

// ─────────────────────────── Lecturas internas ─────────────────────────────────

interface FilaDeEvento {
  readonly id: string;
  readonly organization_id: string;
  readonly campaign_id: string;
  readonly subject_type: OperationalSubjectType;
  readonly shipment_id: string | null;
  readonly billing_document_id: string | null;
  readonly payment_obligation_id: string | null;
  readonly event_type: OperationalEventType;
  readonly from_status: string | null;
  readonly to_status: string | null;
  readonly subject_seq: number;
  readonly occurred_at: Date;
  readonly recorded_at: Date;
  readonly recorded_by: string;
  readonly recorded_by_name: string | null;
  readonly happened_on: string | null;
  readonly external_reference: string | null;
  readonly note: string | null;
  readonly evidence_count: number;
}

const SELECT_EVENTO = `
  SELECT e.id, e.organization_id, e.campaign_id, e.subject_type, e.shipment_id, e.billing_document_id,
         e.payment_obligation_id, e.event_type, e.from_status, e.to_status, e.subject_seq, e.occurred_at,
         e.recorded_at, e.recorded_by, u.name AS recorded_by_name, e.happened_on::text AS happened_on,
         e.external_reference, e.note,
         (SELECT count(*)::int FROM operational_evidence oe
           WHERE oe.event_id = e.id AND oe.retracted_at IS NULL) AS evidence_count
    FROM operational_events e
    JOIN users u ON u.id = e.recorded_by
`;

function sujetoIdDeFila(f: FilaDeEvento): string {
  return (f.shipment_id ?? f.billing_document_id ?? f.payment_obligation_id)!;
}

function comoEvento(f: FilaDeEvento, conDetalle: boolean): EventoOperativo {
  const base: EventoOperativo = {
    id: f.id,
    subjectType: f.subject_type,
    subjectId: sujetoIdDeFila(f),
    campaignId: f.campaign_id,
    eventType: f.event_type,
    fromStatus: f.from_status,
    toStatus: f.to_status,
    subjectSeq: f.subject_seq,
    occurredAt: f.occurred_at.toISOString(),
    recordedAt: f.recorded_at.toISOString(),
    recordedBy: f.recorded_by,
    recordedByName: f.recorded_by_name,
    happenedOn: f.happened_on,
    evidenceCount: f.evidence_count,
  };
  return conDetalle ? { ...base, externalReference: f.external_reference, note: f.note } : base;
}

async function cargarEvento(
  client: Consultor,
  eventoId: string,
  conDetalle: boolean,
): Promise<EventoOperativo> {
  const { rows } = await client.query<FilaDeEvento>(`${SELECT_EVENTO} WHERE e.id = $1`, [eventoId]);
  return comoEvento(rows[0]!, conDetalle);
}

/** Evento ya registrado con esa clave en la organización (o `undefined`). */
export async function buscarEventoPorClave(
  client: Consultor,
  organizationId: string,
  idempotencyKey: string,
): Promise<{ readonly id: string; readonly requestHash: string } | undefined> {
  const { rows } = await client.query<{ id: string; request_hash: string }>(
    `SELECT id, request_hash FROM operational_events WHERE organization_id = $1 AND idempotency_key = $2`,
    [organizationId, idempotencyKey],
  );
  const fila = rows[0];
  return fila === undefined ? undefined : { id: fila.id, requestHash: fila.request_hash };
}

/** Sujeto (y tipo) al que pertenece un evento ya registrado, y si lo pudo escribir quien consulta. */
export async function sujetoDeEvento(
  client: Consultor,
  eventoId: string,
): Promise<
  { tipo: OperationalSubjectType; id: string; organizationId: string; campaignId: string } | undefined
> {
  const { rows } = await client.query<FilaDeEvento>(`${SELECT_EVENTO} WHERE e.id = $1`, [eventoId]);
  const f = rows[0];
  if (f === undefined) return undefined;
  return {
    tipo: f.subject_type,
    id: sujetoIdDeFila(f),
    organizationId: f.organization_id,
    campaignId: f.campaign_id,
  };
}

/** Evento por id (con referencia y nota: lo ve quien lo acaba de escribir o lo reintenta). */
export async function cargarEventoOperativo(client: Consultor, eventoId: string): Promise<EventoOperativo> {
  return cargarEvento(client, eventoId, true);
}

/**
 * Pre-chequeo de idempotencia para casos de uso que CREAN su sujeto (envío, documento de cobro): si la clave ya
 * se usó con la MISMA huella devuelve el evento y el sujeto originales (reintento idéntico, nada que escribir);
 * con otra huella lanza `idempotency_key_reused`; sin uso previo devuelve `undefined`.
 */
export async function buscarReintentoDeCreacion(
  client: Consultor,
  organizationId: string,
  idempotencyKey: string,
  huella: string,
): Promise<{ readonly eventoId: string; readonly sujeto: SujetoOperativo } | undefined> {
  const previo = await buscarEventoPorClave(client, organizationId, idempotencyKey);
  if (previo === undefined) return undefined;
  if (previo.requestHash !== huella) {
    throw conflicto('Esa clave de idempotencia ya se usó con otra solicitud.', {
      reason: 'idempotency_key_reused',
    });
  }
  const sujeto = await sujetoDeEvento(client, previo.id);
  if (sujeto === undefined) return undefined;
  return { eventoId: previo.id, sujeto: { tipo: sujeto.tipo, id: sujeto.id } };
}

const SQL_BLOQUEO: Readonly<Record<OperationalSubjectType, string>> = {
  shipment: `SELECT id, organization_id, campaign_id, status, row_seq FROM shipments WHERE id = $1 FOR UPDATE`,
  billing_document: `SELECT id, organization_id, campaign_id, status, row_seq FROM billing_documents WHERE id = $1 FOR UPDATE`,
  payment_obligation: `SELECT id, organization_id, campaign_id, status, row_seq FROM payment_obligations WHERE id = $1 FOR UPDATE`,
};

/** Bloquea el sujeto (`FOR UPDATE`) y devuelve su estado, o `undefined` si no existe. El mutex de los eventos. */
export async function bloquearSujetoOperativo(
  client: pg.PoolClient,
  sujeto: SujetoOperativo,
): Promise<SujetoBloqueado | undefined> {
  if (!isOperationalSubjectType(sujeto.tipo) || !esUuid(sujeto.id)) return undefined;
  const { rows } = await client.query<{
    id: string;
    organization_id: string;
    campaign_id: string;
    status: string;
    row_seq: number;
  }>(SQL_BLOQUEO[sujeto.tipo], [sujeto.id]);
  const f = rows[0];
  if (f === undefined) return undefined;
  return {
    tipo: sujeto.tipo,
    id: f.id,
    organizationId: f.organization_id,
    campaignId: f.campaign_id,
    status: f.status,
    rowSeq: f.row_seq,
  };
}

// ─────────────────────────── El motor ──────────────────────────────────────────

function conflicto(message: string, details: Record<string, unknown>): Abortar {
  return new Abortar({ code: 'RESOURCE_CONFLICT', message, details });
}

/**
 * La creación de un sujeto perdió la carrera de idempotencia: otra transacción con la MISMA clave y solicitud ya
 * confirmó el evento mientras ésta insertaba su sujeto (que sigue en `row_seq = 0`). Esta transacción no puede
 * cerrar (su sujeto quedaría sin evento): se revierte entera y `transaccionOperativa` la reintenta, de modo que
 * encuentre el evento de la ganadora y devuelva el reintento idéntico (`repetido = true`).
 */
export class CreacionPerdida extends Error {
  readonly eventoId: string;
  constructor(eventoId: string) {
    super('La creación perdió la carrera de idempotencia: el evento ya fue confirmado por otra solicitud.');
    this.name = 'CreacionPerdida';
    this.eventoId = eventoId;
  }
}

/**
 * Aplica UN evento operativo a su sujeto dentro de la transacción abierta del llamador. Lanza `Abortar` con el
 * error de dominio (el llamador la envuelve con `transaccionOperativa`). Ver el encabezado del módulo.
 */
export async function aplicarEventoOperativo(
  client: pg.PoolClient,
  input: AplicarEventoInput,
): Promise<ResultadoDeEvento> {
  const actor = exigirPersonaPorUiOAbortar(input.actor, input.contexto);
  if (!esClaveDeIdempotenciaValida(input.idempotencyKey)) {
    throw new Abortar({
      code: 'VALIDATION_FAILED',
      message:
        'La clave de idempotencia es obligatoria (hasta 200 caracteres, sin espacios en los extremos).',
      details: { field: 'idempotencyKey' },
    });
  }
  if (!Number.isInteger(input.expectedSeq) || input.expectedSeq < 0) {
    throw new Abortar({
      code: 'VALIDATION_FAILED',
      message: 'expectedSeq debe ser un entero mayor o igual a cero.',
      details: { field: 'expectedSeq' },
    });
  }

  const sujeto = await bloquearSujetoOperativo(client, input.sujeto);
  if (sujeto === undefined) throw new Abortar(NO_ENCONTRADO_DE_CONTENIDO);
  autorizarOAbortar(actor, input.action, sujeto.organizationId);
  if (!roleMayRecordEvent(actor.role, input.eventType)) {
    throw new Abortar({
      code: 'FORBIDDEN_ROLE',
      message: `El rol ${actor.role} no puede registrar el evento ${input.eventType}.`,
      details: { eventType: input.eventType, role: actor.role },
    });
  }
  const evidencias = [...(input.evidencias ?? [])];
  if (evidencias.length > 0) autorizarOAbortar(actor, 'ops_evidence:attach', sujeto.organizationId);

  // Idempotencia ANTES del control de secuencia: un reintento tras el éxito devuelve el mismo evento.
  const huella = calcularHuellaDeEvento({ ...input, evidencias });
  const previo = await buscarEventoPorClave(client, sujeto.organizationId, input.idempotencyKey);
  if (previo !== undefined) {
    if (previo.requestHash !== huella) {
      throw conflicto('Esa clave de idempotencia ya se usó con otra solicitud.', {
        reason: 'idempotency_key_reused',
      });
    }
    // El sujeto que acabamos de insertar (aún sin eventos) no es el del reintento: la ganadora ya confirmó.
    if (input.expectedSeq === 0 && sujeto.rowSeq === 0) throw new CreacionPerdida(previo.id);
    return { evento: await cargarEvento(client, previo.id, true), repetido: true, sujeto };
  }

  if (input.expectedSeq !== sujeto.rowSeq) {
    throw conflicto('El registro cambió mientras lo editaba: recargue e inténtelo de nuevo.', {
      reason: 'stale_transition',
      expectedSeq: input.expectedSeq,
      currentSeq: sujeto.rowSeq,
    });
  }

  const { rows: campana } = await client.query<{ status: string }>(
    `SELECT status::text AS status FROM campaigns WHERE id = $1`,
    [sujeto.campaignId],
  );
  if (campana[0]?.status === 'cancelada') {
    throw conflicto('La campaña está cancelada: no se registran eventos operativos.', {
      reason: 'campaign_not_active',
    });
  }

  // Reglas del caso de uso (mensajes accionables) antes de la validación genérica de la arista.
  if (input.precondicion !== undefined) await input.precondicion({ client, sujeto });

  const toStatus = input.toStatus ?? null;
  const fromStatus = toStatus === null || sujeto.rowSeq === 0 ? null : sujeto.status;
  const validado = validateOperationalEventRequest(
    {
      eventType: input.eventType,
      subjectType: sujeto.tipo,
      fromStatus,
      toStatus,
      idempotencyKey: input.idempotencyKey,
      origin: 'ui',
      externalReference: input.externalReference,
      happenedOn: input.happenedOn,
      note: input.note,
    },
    new Date(),
  );
  if (!validado.ok) {
    throw new Abortar({
      code: validado.error.code,
      message: validado.error.message,
      details: validado.error.details,
    });
  }
  const hechos = validado.value;
  if (hechos.eventType === 'evidence.attached' && evidencias.length === 0) {
    throw new Abortar({
      code: 'VALIDATION_FAILED',
      message: 'Un evento de evidencia exige al menos un archivo de soporte.',
      details: { field: 'evidencias' },
    });
  }
  const vistas = new Set<string>();
  for (const e of evidencias) {
    if (!esUuid(e.sourceDocumentId) || !isEvidenceKind(e.kind) || vistas.has(e.sourceDocumentId)) {
      throw new Abortar({
        code: 'VALIDATION_FAILED',
        message: 'La evidencia es inválida (fuente o tipo de soporte no reconocidos, o repetida).',
        details: { field: 'evidencias' },
      });
    }
    vistas.add(e.sourceDocumentId);
  }

  // ── Escritura: evento → evidencia → sujeto → auditoría ──
  const fk = COLUMNA_DE_EVENTO[sujeto.tipo];
  const { rows: creado } = await client.query<{ id: string }>(
    `INSERT INTO operational_events
       (organization_id, campaign_id, subject_type, ${fk}, event_type, from_status, to_status, subject_seq,
        recorded_by, origin, idempotency_key, request_hash, external_reference, happened_on, note)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'ui', $10, $11, $12, $13, $14)
     RETURNING id`,
    [
      sujeto.organizationId,
      sujeto.campaignId,
      sujeto.tipo,
      sujeto.id,
      hechos.eventType,
      hechos.fromStatus,
      hechos.toStatus,
      sujeto.rowSeq + 1,
      actor.id,
      input.idempotencyKey,
      huella,
      hechos.externalReference,
      hechos.happenedOn,
      hechos.note,
    ],
  );
  const eventoId = creado[0]!.id;

  for (const e of evidencias) {
    await client.query(
      `INSERT INTO operational_evidence (organization_id, campaign_id, event_id, source_document_id, kind, attached_by)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [sujeto.organizationId, sujeto.campaignId, eventoId, e.sourceDocumentId, e.kind, actor.id],
    );
  }

  const tabla = TABLA_DE_SUJETO[sujeto.tipo];
  const permitidas = COLUMNAS_EXTRA[sujeto.tipo];
  const sets: string[] = [];
  const valores: unknown[] = [sujeto.id, eventoId];
  if (hechos.toStatus !== null) {
    valores.push(hechos.toStatus);
    sets.push(`status = $${valores.length}`);
  }
  for (const [columna, valor] of Object.entries(input.cambios ?? {})) {
    if (!permitidas.includes(columna)) {
      throw new Error(`aplicarEventoOperativo: la columna «${columna}» no es modificable en ${tabla}.`);
    }
    valores.push(valor);
    sets.push(`${columna} = $${valores.length}`);
  }
  const nuevoEstado = hechos.toStatus ?? sujeto.status;
  await client.query(
    `UPDATE ${tabla} SET row_seq = row_seq + 1, last_event_id = $2${sets.length > 0 ? ', ' : ''}${sets.join(', ')}
      WHERE id = $1`,
    valores,
  );

  await recordAudit(
    client,
    auditoriaDe(actor, input.contexto, {
      action: accionDeAuditoria(hechos.eventType),
      entityType: sujeto.tipo,
      entityId: sujeto.id,
      metadata: {
        eventId: eventoId,
        campaignId: sujeto.campaignId,
        subjectType: sujeto.tipo,
        eventType: hechos.eventType,
        fromStatus: hechos.fromStatus,
        toStatus: hechos.toStatus,
        seq: sujeto.rowSeq + 1,
        hasEvidence: evidencias.length > 0,
        evidenceCount: evidencias.length,
        ...input.auditoria,
      },
    }),
  );

  return {
    evento: await cargarEvento(client, eventoId, true),
    repetido: false,
    sujeto: { ...sujeto, status: nuevoEstado, rowSeq: sujeto.rowSeq + 1 },
  };
}

// ─────────────────────────── Transacción con traducción de errores ─────────────

const CONSTRAINT_DE_IDEMPOTENCIA = 'operational_events_idempotencia_key';

interface ErrorDePg {
  readonly code?: unknown;
  readonly constraint?: unknown;
  readonly message?: unknown;
}

const CONFLICTOS_DE_UNICIDAD: Readonly<Record<string, { reason: string; message: string }>> = {
  billing_documents_numero_vivo_key: {
    reason: 'document_number_in_use',
    message: 'Ya hay un documento de cobro vivo con ese número en la obligación.',
  },
  billing_documents_fuente_viva_key: {
    reason: 'document_source_in_use',
    message: 'Ese archivo ya respalda otro documento de cobro vivo.',
  },
  billing_documents_validado_key: {
    reason: 'document_already_validated',
    message: 'La obligación ya tiene un documento de cobro validado.',
  },
  operational_evidence_unica_key: {
    reason: 'evidence_already_attached',
    message: 'Ese archivo ya está adjunto a este evento.',
  },
};

/** Traduce un rechazo de la base (incluidos los diferidos al COMMIT) a un error de dominio, o lo relanza. */
function errorDeBaseComoPayload(error: unknown): Abortar | undefined {
  const e = (typeof error === 'object' && error !== null ? error : {}) as ErrorDePg;
  const mensaje = typeof e.message === 'string' ? e.message : 'La base rechazó la operación.';
  if (e.code === 'P0001') {
    return conflicto(mensaje, { reason: 'db_rule' });
  }
  if (e.code === '23514') {
    return new Abortar({
      code: 'VALIDATION_FAILED',
      message: 'Un valor no cumple las reglas de la base.',
      details: { reason: 'db_check' },
    });
  }
  if (e.code === '23505') {
    const conocido = typeof e.constraint === 'string' ? CONFLICTOS_DE_UNICIDAD[e.constraint] : undefined;
    return conflicto(conocido?.message ?? 'El registro ya existe.', {
      reason: conocido?.reason ?? 'duplicate',
    });
  }
  if (e.code === '23503') {
    return new Abortar({
      code: 'VALIDATION_FAILED',
      message: 'Una referencia no existe o no pertenece a esta campaña.',
      details: { reason: 'db_reference' },
    });
  }
  if (e.code === '40001' || e.code === '40P01') {
    return conflicto('Otra operación simultánea tocó el mismo registro: inténtelo de nuevo.', {
      reason: 'concurrent_update',
    });
  }
  return undefined;
}

function esChoqueDeIdempotencia(error: unknown): boolean {
  const e = (typeof error === 'object' && error !== null ? error : {}) as ErrorDePg;
  return e.code === '23505' && e.constraint === CONSTRAINT_DE_IDEMPOTENCIA;
}

/**
 * Transacción de un caso de uso operativo, con `Result`. Traduce `Abortar`, los rechazos de la base (también
 * los diferidos que fallan en el COMMIT) y UNA carrera de idempotencia: dos solicitudes simultáneas con la
 * misma clave que CREAN su sujeto chocan en `UNIQUE(organización, clave)` (o, si la ganadora confirmó antes del
 * INSERT del evento, la perdedora lo ve en `aplicarEventoOperativo` ⇒ `CreacionPerdida`); en ambos casos la
 * perdedora se REVIERTE entera y se reintenta una vez: entonces encuentra el evento de la ganadora (reintento
 * idéntico ⇒ el mismo evento, `repetido = true`, sin sujeto huérfano).
 */
export async function transaccionOperativa<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<Result<T>> {
  for (let intento = 0; ; intento++) {
    try {
      return ok(await transaction(fn));
    } catch (error) {
      if (error instanceof Abortar) return err(error.payload);
      if (error instanceof CreacionPerdida) {
        if (intento === 0) continue; // revertida: la segunda vuelta encuentra el evento de la ganadora
        return err(
          conflicto('Otra operación simultánea tocó el mismo registro: inténtelo de nuevo.', {
            reason: 'concurrent_update',
          }).payload,
        );
      }
      if (esChoqueDeIdempotencia(error) && intento === 0) continue;
      const traducido = errorDeBaseComoPayload(error);
      if (traducido !== undefined) return err(traducido.payload);
      throw error;
    }
  }
}

// ─────────────────────────── Historial ─────────────────────────────────────────

export interface ConsultaDeHistorial {
  readonly subjectType: OperationalSubjectType;
  readonly subjectId: string;
}

/** Acción que habilita ver `externalReference` y `note` de los eventos de un sujeto. */
function accionDeDetalle(tipo: OperationalSubjectType): Action {
  return tipo === 'shipment' ? 'shipment:manage' : 'finance:read';
}

/**
 * Historial de eventos de un sujeto, en orden. Capacidad: envío ⇒ `shipment:read`; documento/obligación ⇒
 * `finance:read`. La referencia externa y la nota (internas) solo las ve quien gestiona el sujeto. Ajeno ⇒
 * `RESOURCE_NOT_FOUND`.
 */
export async function listarEventosOperativos(
  actor: User,
  consulta: ConsultaDeHistorial,
): Promise<Result<EventoOperativo[]>> {
  if (typeof actor !== 'object' || actor === null) {
    return err({ code: 'FORBIDDEN_ROLE', message: 'Esta consulta la hace una persona autorizada.' });
  }
  if (!isOperationalSubjectType(consulta.subjectType) || !esUuid(consulta.subjectId)) {
    return err(NO_ENCONTRADO_DE_CONTENIDO);
  }
  const tabla = TABLA_DE_SUJETO[consulta.subjectType];
  const rows = await query<{ organization_id: string }>(
    `SELECT organization_id FROM ${tabla} WHERE id = $1`,
    [consulta.subjectId],
  );
  const propietaria = rows[0];
  if (propietaria === undefined) return err(NO_ENCONTRADO_DE_CONTENIDO);
  const permitido = authorizeInternalResource(
    actor,
    readActionForSubject(consulta.subjectType),
    propietaria.organization_id,
  );
  if (!permitido.ok) return permitido;

  const conDetalle = roleCan(actor.role, accionDeDetalle(consulta.subjectType));
  const fk = COLUMNA_DE_EVENTO[consulta.subjectType];
  const filas = await query<FilaDeEvento>(`${SELECT_EVENTO} WHERE e.${fk} = $1 ORDER BY e.subject_seq`, [
    consulta.subjectId,
  ]);
  return ok(filas.map((f) => comoEvento(f, conDetalle)));
}
