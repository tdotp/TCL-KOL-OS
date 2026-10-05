/**
 * Registro de handlers de las acciones propuestas (V2 · Fase 6, D6).
 *
 * Un solo sistema HITL (`proposed_actions`): `proposed-actions.ts` conserva el
 * ciclo propuesta → confirmación humana → ejecución única y su política de
 * canal/permiso/huella; lo que cambia de un TIPO de acción a otro vive aquí, en
 * un handler por tipo:
 *
 *   prepararPropuesta  valida el recurso y el alcance del actor y calcula el
 *                      PAYLOAD estructurado. La huella (`payload_hash`) cubre
 *                      exactamente ese payload, que es lo que se le muestra a la
 *                      persona; si el contenido cambia, la huella cambia.
 *   verificarVigente   comprueba, al CONFIRMAR y al EJECUTAR, que el recurso no
 *                      cambió desde la propuesta (`PROPOSAL_STALE` si cambió).
 *   ejecutar           llama al caso de uso existente con la PERSONA que
 *                      confirmó, origen `ui` y correlación a la acción. No hay
 *                      lógica de dominio duplicada: el handler solo delega.
 *
 * Permisos: cada tipo declara en el dominio (`PROPOSED_ACTION_SPECS`) qué
 * capacidad exige proponer y cuál confirmar/ejecutar.
 *
 * ── Garantía de ejecución (modo) ──────────────────────────────────────────────
 *
 *  · `atomic` (`brief.approve`): el cambio de dominio, la marca `executed` y la
 *    auditoría ocurren en UNA transacción (la del executor). Si algo falla, todo
 *    se revierte; nunca queda el dominio aplicado con la acción `confirmed`, ni
 *    `executed` sin dominio aplicado.
 *
 *  · `idempotent_external` (`influencer_import.*`): los casos de uso de la Fase 5
 *    abren sus PROPIAS transacciones (varias, por registro) sobre otras
 *    conexiones; no pueden unirse a la del executor. La garantía es MÁS DÉBIL y
 *    así está documentada (DEC-047): la ejecución única la da el bloqueo de la
 *    fila de la acción mientras dura la llamada, y la recuperación ante una caída
 *    a medias es por REINTENTO IDEMPOTENTE, no por rollback. Si el caso de uso se
 *    aplicó pero no se llegó a marcar `executed`, la acción queda `confirmed` y
 *    reintentar `ejecutarAccion` reconcilia sin duplicar (aplicar es idempotente;
 *    resolver deduplica por la correlación de la acción). Entre medias puede
 *    existir un efecto de dominio ya aplicado con la acción aún `confirmed`.
 *    Como retiene la conexión de la fila mientras el caso de uso pide otras del
 *    mismo pool, `ejecutarAccion` limita cuántas corren a la vez
 *    (`MAX_EJECUCIONES_EXTERNAS_SIMULTANEAS`) para no interbloquear el pool.
 */

import { createHash } from 'node:crypto';
import type pg from 'pg';
import {
  type ProposedActionType,
  type Result,
  type User,
  err,
  ok,
  transitionsFrom,
} from '@tcl-kol-os/domain';
import {
  applyInfluencerImport,
  leerDecisionDeImportacion,
  materialDePlan,
  materialDeRegistro,
  resolveImportRecord,
  validarAplicacionDePlan,
  validarResolucionDeRegistro,
} from './influencer-import.ts';
import { transicionarBriefEnTransaccion } from './transitions.ts';

// ─────────────────────────── Huellas ───────────────────────────────────────────

export function canonico(valor: unknown): string {
  if (Array.isArray(valor)) return `[${valor.map(canonico).join(',')}]`;
  if (valor !== null && typeof valor === 'object') {
    const claves = Object.keys(valor as Record<string, unknown>).sort();
    return `{${claves
      .map((k) => `${JSON.stringify(k)}:${canonico((valor as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(valor) ?? 'null';
}

export function sha256(texto: string): string {
  return createHash('sha256').update(texto).digest('hex');
}

const huella = (valor: unknown): string => sha256(canonico(valor));

// ─────────────────────────── Cupo de ejecuciones externas ──────────────────────

/**
 * Máximo de ejecuciones `idempotent_external` SIMULTÁNEAS por proceso.
 *
 * Una ejecución de este modo retiene la conexión de la transacción que bloquea la fila de la acción y, mientras
 * tanto, el caso de uso de la Fase 5 pide otras del MISMO pool (el bloqueo del plan, la transacción de cada
 * registro, lecturas): hasta 4 conexiones por ejecución. Con el pool en 10 y sin tope, 10 ejecuciones
 * simultáneas retienen una conexión cada una esperando otra y el pool se interbloquea (también para el resto
 * del servicio; QA-26). El cupo se toma ANTES de abrir la transacción, así que quien espera no retiene nada:
 * 2 ejecuciones × 4 conexiones = 8, y quedan 2 para el chat, los runs y las lecturas. La garantía (ejecución
 * única por bloqueo de fila; recuperación por reintento idempotente) no cambia: solo se serializa el acceso.
 */
export const MAX_EJECUCIONES_EXTERNAS_SIMULTANEAS = 2;

let ejecucionesExternasActivas = 0;
const colaDeEjecucionesExternas: Array<() => void> = [];

async function tomarCupoExterno(): Promise<void> {
  if (ejecucionesExternasActivas < MAX_EJECUCIONES_EXTERNAS_SIMULTANEAS) {
    ejecucionesExternasActivas += 1;
    return;
  }
  // El cupo pasa de mano en mano (sin liberar y retomar): el contador no cambia al despertar al siguiente.
  await new Promise<void>((resolve) => colaDeEjecucionesExternas.push(resolve));
}

function soltarCupoExterno(): void {
  const siguiente = colaDeEjecucionesExternas.shift();
  if (siguiente !== undefined) siguiente();
  else ejecucionesExternasActivas -= 1;
}

/** Corre `fn` dentro del cupo de ejecuciones externas (FIFO). */
export async function conCupoDeEjecucionExterna<T>(fn: () => Promise<T>): Promise<T> {
  await tomarCupoExterno();
  try {
    return await fn();
  } finally {
    soltarCupoExterno();
  }
}

// ─────────────────────────── Contrato del handler ──────────────────────────────

export type Ejecutor = pg.Pool | pg.PoolClient;

/** Garantía de ejecución del tipo (ver el encabezado). */
export type ModoDeEjecucion = 'atomic' | 'idempotent_external';

/** Momento en que se comprueba que el recurso sigue vigente. */
export type FaseDeVerificacion = 'confirmar' | 'ejecutar';

/** Lo que un handler necesita de la fila persistida de la acción. */
export interface AccionPersistida {
  readonly id: string;
  readonly organization_id: string;
  readonly campaign_id: string;
  readonly action_type: string;
  readonly resource_type: string;
  readonly resource_id: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly payload_hash: string;
  readonly proposed_by: string | null;
  readonly confirmed_by: string | null;
}

export interface PropuestaPreparada {
  readonly organizationId: string;
  readonly campaignId: string;
  /** Contenido estructurado que se le muestra a la persona; la huella lo cubre. */
  readonly payload: Record<string, unknown>;
}

/** Resumen de lo ejecutado (cifras, sin contenido de usuario) para la auditoría. */
export type ResumenDeEjecucion = Readonly<Record<string, unknown>>;

export interface HandlerDeAccion {
  readonly type: ProposedActionType;
  readonly modo: ModoDeEjecucion;
  /**
   * Valida el recurso y el alcance y calcula el payload. `parametros` es entrada
   * NO confiable (p. ej. la decisión que formaliza el agente): se valida aquí.
   * El control de capacidad por rol ya lo hizo `puedeProponer` (política del
   * dominio); aquí se aplica el alcance (organización, campaña, estado).
   */
  prepararPropuesta(
    db: Ejecutor,
    actor: User | 'system',
    resourceId: string,
    parametros: Readonly<Record<string, unknown>> | undefined,
  ): Promise<Result<PropuestaPreparada>>;
  verificarVigente(db: Ejecutor, accion: AccionPersistida, fase: FaseDeVerificacion): Promise<Result<true>>;
  /**
   * Ejecuta con la persona que confirmó (permiso vigente), origen `ui` y la
   * correlación de la acción. Corre con `client` dentro de la transacción del
   * executor, que ya bloqueó la fila de la acción.
   */
  ejecutar(
    client: pg.PoolClient,
    humano: User,
    accion: AccionPersistida,
  ): Promise<Result<ResumenDeEjecucion | undefined>>;
}

const NO_ENCONTRADO = {
  code: 'RESOURCE_NOT_FOUND',
  message: 'El recurso no existe o no está disponible.',
} as const;

const OBSOLETA = (message: string): Result<never> => err({ code: 'PROPOSAL_STALE', message });

const EJECUCION_HUMANA = (accionId: string) =>
  ({ origin: 'ui', correlation: { proposedActionId: accionId } }) as const;

// ─────────────────────────── brief.approve ─────────────────────────────────────

interface VersionDeBrief {
  readonly status: string;
  readonly campaignId: string;
  readonly organizationId: string;
}

async function cargarVersionDeBrief(db: Ejecutor, versionId: string): Promise<VersionDeBrief | undefined> {
  const { rows } = await db.query<{ status: string; campaign_id: string; organization_id: string }>(
    `SELECT v.status::text AS status, b.campaign_id, c.organization_id
       FROM brief_versions v
       JOIN briefs b ON b.id = v.brief_id
       JOIN campaigns c ON c.id = b.campaign_id
      WHERE v.id = $1`,
    [versionId],
  );
  const fila = rows[0];
  return fila === undefined
    ? undefined
    : { status: fila.status, campaignId: fila.campaign_id, organizationId: fila.organization_id };
}

/**
 * Huella del CONTENIDO de la versión del brief (campos, valores, revisiones).
 * Si cambia entre la propuesta y la confirmación, quien confirma estaría
 * aprobando algo distinto de lo que se le propuso.
 */
async function huellaDeContenidoDeVersion(db: Ejecutor, versionId: string): Promise<string> {
  const { rows: campos } = await db.query<{
    k: string;
    p: string | null;
    r: number;
    v: string;
    s: string;
  }>(
    `SELECT key AS k, campaign_product_id::text AS p, revision AS r, md5(value::text) AS v, status::text AS s
       FROM brief_fields WHERE brief_version_id = $1 ORDER BY key, campaign_product_id NULLS FIRST`,
    [versionId],
  );
  // V2 · Fase 2: también las representaciones. Quien confirma aprueba la
  // versión lógica completa (ES y EN); si una traducción cambia entre la
  // propuesta y la confirmación, la huella ya no coincide.
  const { rows: traducciones } = await db.query<{
    k: string;
    p: string | null;
    l: string;
    v: string;
    h: string | null;
  }>(
    `SELECT f.key AS k, f.campaign_product_id::text AS p, r.language AS l,
            md5(t.value::text) AS v, t.source_value_hash AS h
       FROM brief_field_translations t
       JOIN brief_fields f ON f.id = t.brief_field_id
       JOIN brief_version_representations r ON r.id = t.representation_id
      WHERE f.brief_version_id = $1 ORDER BY f.key, f.campaign_product_id NULLS FIRST, r.language`,
    [versionId],
  );
  return huella({ campos, traducciones });
}

const briefApprove: HandlerDeAccion = {
  type: 'brief.approve',
  modo: 'atomic',

  async prepararPropuesta(db, actor, resourceId) {
    const version = await cargarVersionDeBrief(db, resourceId);
    if (version === undefined || (actor !== 'system' && actor.organizationId !== version.organizationId)) {
      return err(NO_ENCONTRADO);
    }
    // Falla pronto lo que nunca podría ejecutarse: no se propone aprobar una
    // versión que no admite la transición.
    if (!transitionsFrom(version.status as never).some((t) => t.to === 'approved')) {
      return err({
        code: 'BRIEF_INVALID_TRANSITION',
        message: `Una versión en estado ${version.status} no se puede aprobar.`,
        details: { status: version.status },
      });
    }
    return ok({
      organizationId: version.organizationId,
      campaignId: version.campaignId,
      payload: {
        versionId: resourceId,
        contentFingerprint: await huellaDeContenidoDeVersion(db, resourceId),
      },
    });
  },

  async verificarVigente(db, accion) {
    const actual = await huellaDeContenidoDeVersion(db, accion.resource_id);
    if (actual !== accion.payload['contentFingerprint']) {
      return OBSOLETA('El brief cambió después de proponerse la aprobación. Hay que proponerla de nuevo.');
    }
    return ok(true);
  },

  async ejecutar(client, humano, accion) {
    // La misma aprobación humana directa que ya existía, con origen `ui` (una
    // persona la está ejecutando) y correlación a la propuesta. Corre DENTRO de
    // la transacción del executor (misma conexión): el cambio de dominio, la
    // marca `executed` y la auditoría se confirman juntos o no se confirman.
    const r = await transicionarBriefEnTransaccion(client, humano, accion.resource_id, 'approved', {
      origen: 'ui',
      correlation: { proposedActionId: accion.id },
    });
    return r.ok ? ok(undefined) : err(r.error);
  },
};

// ─────────────────────────── influencer_import.* ───────────────────────────────

const soloPersonas = (): Result<never> =>
  err({
    code: 'FORBIDDEN_ROLE',
    message: 'Una acción de importación la propone una persona (o el agente en su nombre), no el sistema.',
  });

/** Plan ya no admite nada: reemplazado por uno nuevo, o sin esquema válido. */
function planCerrado(estado: string): boolean {
  return estado === 'superseded' || estado === 'schema_invalid';
}

const importApply: HandlerDeAccion = {
  type: 'influencer_import.apply',
  modo: 'idempotent_external',

  async prepararPropuesta(db, actor, resourceId) {
    if (actor === 'system') return soloPersonas();
    // Las mismas reglas que aplicarlo (permiso, organización, campaña activa, plan aplicable).
    const alcance = await validarAplicacionDePlan(actor, resourceId);
    if (!alcance.ok) return alcance;
    const material = await materialDePlan(db, resourceId);
    if (material === undefined) return err(NO_ENCONTRADO);
    return ok({
      organizationId: alcance.value.organizationId,
      campaignId: alcance.value.campaignId,
      payload: {
        planId: material.planId,
        snapshotId: material.snapshotId,
        snapshotContentHash: material.snapshotContentHash,
        // Contenido inmutable del plan + resoluciones humanas existentes.
        planFingerprint: huella(material.estable),
        // Estado actual (qué está aplicado/bloqueado/vinculado): se exige al confirmar.
        stateFingerprint: huella(material.vivo),
        muestra: material.muestra,
      },
    });
  },

  async verificarVigente(db, accion, fase) {
    const material = await materialDePlan(db, accion.resource_id);
    if (material === undefined) return err(NO_ENCONTRADO);
    if (accion.payload['planId'] !== accion.resource_id) {
      return OBSOLETA('La acción propuesta no corresponde a este plan.');
    }
    if (planCerrado(material.planStatus)) {
      return OBSOLETA(
        'El plan fue reemplazado o ya no cumple el esquema. Hay que proponer aplicar el plan vigente.',
      );
    }
    if (huella(material.estable) !== accion.payload['planFingerprint']) {
      return OBSOLETA(
        'El plan o las decisiones sobre sus registros cambiaron después de proponerse. Hay que proponerlo de nuevo.',
      );
    }
    if (
      fase === 'confirmar' &&
      (huella(material.vivo) !== accion.payload['stateFingerprint'] ||
        canonico(material.muestra) !== canonico(accion.payload['muestra']))
    ) {
      return OBSOLETA(
        'El estado de la importación cambió después de proponerse aplicar el plan. Hay que proponerlo de nuevo.',
      );
    }
    return ok(true);
  },

  async ejecutar(_client, humano, accion) {
    // Origen `ui` + correlación a la acción: lo único que puede aplicar un plan
    // (`applyInfluencerImport` rechaza `chat`). Idempotente: reintentarlo no duplica.
    const r = await applyInfluencerImport(humano, accion.resource_id, EJECUCION_HUMANA(accion.id));
    if (!r.ok) return err(r.error);
    const cuenta = (estado: string) => r.value.records.filter((x) => x.status === estado).length;
    return ok({
      planStatus: r.value.planStatus,
      applied: cuenta('applied'),
      unchanged: cuenta('unchanged'),
      blocked: cuenta('blocked'),
    });
  },
};

const importResolveRecord: HandlerDeAccion = {
  type: 'influencer_import.resolve_record',
  modo: 'idempotent_external',

  async prepararPropuesta(db, actor, resourceId, parametros) {
    if (actor === 'system') return soloPersonas();
    const claves = Object.keys(parametros ?? {});
    if (parametros === undefined || claves.length !== 1 || claves[0] !== 'decision') {
      return err({
        code: 'VALIDATION_FAILED',
        message: 'Proponer resolver un registro exige exactamente la decisión.',
        details: { field: 'decision' },
      });
    }
    const decision = leerDecisionDeImportacion(parametros['decision']);
    if (!decision.ok) return decision;
    // Las mismas reglas que resolverlo (permiso, organización, campaña activa, plan vigente, regla de la decisión).
    const alcance = await validarResolucionDeRegistro(actor, resourceId, decision.value);
    if (!alcance.ok) return alcance;
    const material = await materialDeRegistro(db, resourceId);
    if (material === undefined) return err(NO_ENCONTRADO);
    return ok({
      organizationId: alcance.value.organizationId,
      campaignId: alcance.value.campaignId,
      payload: {
        planId: alcance.value.planId,
        recordId: resourceId,
        decision: decision.value,
        // Contenido inmutable del registro + resoluciones humanas existentes.
        recordFingerprint: huella(material.estable),
        // Estado actual del registro: se exige al confirmar.
        stateFingerprint: huella(material.vivo),
        muestra: material.muestra,
      },
    });
  },

  async verificarVigente(db, accion, fase) {
    // Se excluyen las resoluciones que dejó ESTA acción: un reintento de su
    // ejecución a medias no se invalida a sí mismo.
    const material = await materialDeRegistro(db, accion.resource_id, accion.id);
    if (material === undefined) return err(NO_ENCONTRADO);
    if (accion.payload['recordId'] !== accion.resource_id || accion.payload['planId'] !== material.planId) {
      return OBSOLETA('La acción propuesta no corresponde a este registro.');
    }
    if (planCerrado(material.planStatus)) {
      return OBSOLETA(
        'El plan fue reemplazado o ya no cumple el esquema. La decisión hay que proponerla sobre el plan vigente.',
      );
    }
    if (huella(material.estable) !== accion.payload['recordFingerprint']) {
      return OBSOLETA(
        'El registro o las decisiones sobre él cambiaron después de proponerse. Hay que proponerlo de nuevo.',
      );
    }
    if (
      fase === 'confirmar' &&
      (huella(material.vivo) !== accion.payload['stateFingerprint'] ||
        canonico(material.muestra) !== canonico(accion.payload['muestra']))
    ) {
      return OBSOLETA(
        'El estado del registro cambió después de proponerse la decisión. Hay que proponerla de nuevo.',
      );
    }
    return ok(true);
  },

  async ejecutar(_client, humano, accion) {
    const decision = leerDecisionDeImportacion(accion.payload['decision']);
    if (!decision.ok) return err(decision.error);
    // Origen `ui` + correlación a la acción: `resolveImportRecord` rechaza `chat`
    // y deduplica por la correlación (un reintento no repite la resolución).
    const r = await resolveImportRecord(
      humano,
      accion.resource_id,
      decision.value,
      EJECUCION_HUMANA(accion.id),
    );
    if (!r.ok) return err(r.error);
    return ok({
      decision: decision.value.kind,
      resolutionId: r.value.resolution.id,
      recordStatus: r.value.result?.status ?? null,
      planStatus: r.value.planStatus,
    });
  },
};

// ─────────────────────────── Registro ──────────────────────────────────────────

/**
 * Un handler por tipo de acción. `Record<ProposedActionType, …>` obliga a que
 * añadir un tipo al dominio (`PROPOSED_ACTION_SPECS`) añada su handler aquí.
 */
export const HANDLERS: Readonly<Record<ProposedActionType, HandlerDeAccion>> = {
  'brief.approve': briefApprove,
  'influencer_import.apply': importApply,
  'influencer_import.resolve_record': importResolveRecord,
};

export function handlerDe(type: string): HandlerDeAccion | undefined {
  return Object.hasOwn(HANDLERS, type) ? HANDLERS[type as ProposedActionType] : undefined;
}
