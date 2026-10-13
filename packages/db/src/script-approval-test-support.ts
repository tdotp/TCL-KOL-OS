/**
 * Apoyo de las pruebas de la APROBACIÓN de guiones (V2 · Fase 7 · W3a). Solo para pruebas: sintético.
 *
 *  · `crearEscenarioDeAprobacion`: contenido + Brief aprobado (rector), sin versiones.
 *  · `versionRevisada`: entregable nuevo + versión + revisión humana CURRENT ⇒ lista para aprobar.
 *  · `huellaDe` / `aprobarDirecto`: la huella que vería la persona y la aprobación directa con ella.
 *  · `proponerAprobacion`, `confirmarAprobacion`, `ejecutarAprobacion`: el camino HITL con personas reales.
 *  · `conDemora` / `conFalloEn`: ventanas deterministas y fallos inyectados por triggers de prueba, siempre
 *    acotados al recurso indicado (el resto de pruebas, en la misma base, no se ven afectadas).
 */

import type { ProposedAction, Result, User } from '@tcl-kol-os/domain';
import { getPool, query } from './client.ts';
import { adminPool } from './test-admin.ts';
import {
  ENV_CON_IA,
  type HallazgoDePrueba,
  claveNueva,
  clienteQueResponde,
  registrarGuionDePrueba,
} from './content-analysis-test-support.ts';
import { registrarRevisionHumana, solicitarAnalisisDeGuion } from './content-analysis.ts';
import { crearEntregable } from './deliverables.ts';
import { registrarVersionDeGuion } from './script-versions.ts';
import { confirmarAccion, ejecutarAccion, proponerAccion } from './proposed-actions.ts';
import { aprobarScriptVersion, evaluarAprobacionDeScript } from './script-approval.ts';
import {
  type BriefDePrueba,
  type EscenarioDeContenido,
  crearBriefAprobadoDePrueba,
  crearEscenarioDeContenido,
  crearFuenteDeGuionConTexto,
} from './test-utils.ts';

export const valor = <T>(r: Result<T>): T => {
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message} ${JSON.stringify(r.error.details ?? {})}`);
  return r.value;
};
export const codigo = <T>(r: Result<T>): string | undefined => (r.ok ? undefined : r.error.code);
export const razon = <T>(r: Result<T>): unknown =>
  r.ok ? undefined : (r.error.details as { reason?: unknown } | undefined)?.reason;

export interface EscenarioDeAprobacion {
  readonly e: EscenarioDeContenido;
  readonly brief: BriefDePrueba;
}

export async function crearEscenarioDeAprobacion(nombre: string): Promise<EscenarioDeAprobacion> {
  const e = await crearEscenarioDeContenido(nombre);
  const brief = await crearBriefAprobadoDePrueba(e.campanaId, e.admin, {
    productos: [e.productos.p80, e.productos.pro],
    noEncontrados: ['objetivo.comportamiento_esperado'],
  });
  return { e, brief };
}

let secuencia = 0;

/** Entregable activo nuevo de Diego (uno por prueba: el estado de cada prueba es suyo). */
export async function entregableNuevo(e: EscenarioDeContenido, etiqueta = 'Aprobación'): Promise<string> {
  secuencia += 1;
  return valor(
    await crearEntregable(e.consultor, {
      campaignInfluencerId: e.participaciones.diego,
      label: `${etiqueta} ${secuencia} ${e.sufijo}`,
    }),
  ).id;
}

/** Una versión nueva (`received`) en el entregable (por defecto, de la participación de Diego). */
export async function versionNueva(
  e: EscenarioDeContenido,
  deliverableId: string,
  opciones: { readonly fragmentos?: readonly string[]; readonly participationId?: string } = {},
): Promise<string> {
  return (
    await registrarGuionDePrueba(
      e,
      deliverableId,
      opciones.participationId ?? e.participaciones.diego,
      e.consultor,
      opciones.fragmentos,
    )
  ).versionId;
}

/** Una fuente de guion procesada, SIN registrarla todavía (para controlar cuándo entra la versión). */
export async function fuenteDeGuionNueva(e: EscenarioDeContenido): Promise<string> {
  secuencia += 1;
  return crearFuenteDeGuionConTexto(e.campanaId, e.admin, `guion-aprobacion-${secuencia}`, [
    'Hola, hoy les muestro el P80 Pro: cámara de 200 MP para fotos de día y de noche.',
    'Ideal para fotografía profesional; no se pierdan esta oferta.',
  ]);
}

/** Registra una fuente ya creada como la versión siguiente del entregable (resultado crudo). */
export async function registrarFuente(e: EscenarioDeContenido, deliverableId: string, sourceId: string) {
  return registrarVersionDeGuion(e.consultor, {
    campaignId: e.campanaId,
    sourceId,
    participation: { participationId: e.participaciones.diego },
    deliverable: { id: deliverableId },
  });
}

/** Registra la revisión humana (CURRENT contra el Brief rector): la versión pasa a `in_review`. */
export async function revisarComoHumano(
  versionId: string,
  actor: User,
  nota?: string,
): Promise<{ readonly runId: string }> {
  const r = valor(await registrarRevisionHumana(actor, versionId, nota === undefined ? {} : { nota }));
  return { runId: r.run.id };
}

/** Análisis asistido (cliente guionado) con los hallazgos dados: CURRENT con N hallazgos. */
export async function revisarConIA(
  e: EscenarioDeContenido,
  versionId: string,
  hallazgos: readonly HallazgoDePrueba[],
): Promise<{ readonly runId: string }> {
  const r = valor(
    await solicitarAnalisisDeGuion(
      e.consultor,
      versionId,
      { mode: 'reanalyze', idempotencyKey: claveNueva('aprob') },
      undefined,
      { cliente: clienteQueResponde(hallazgos), env: ENV_CON_IA, esperar: async () => {} },
    ),
  );
  return { runId: r.run.id };
}

export interface VersionLista {
  readonly deliverableId: string;
  readonly versionId: string;
  readonly runId: string;
}

/**
 * Entregable nuevo (de Diego) + una versión + revisión humana de la consultora: lista para aprobar. Con
 * `destino`, usa un entregable ya existente de OTRA participación en vez de crear uno.
 */
export async function versionRevisada(
  e: EscenarioDeContenido,
  etiqueta?: string,
  destino?: { readonly deliverableId: string; readonly participationId: string },
): Promise<VersionLista> {
  const deliverableId = destino?.deliverableId ?? (await entregableNuevo(e, etiqueta));
  const versionId = await versionNueva(
    e,
    deliverableId,
    destino === undefined ? {} : { participationId: destino.participationId },
  );
  const { runId } = await revisarComoHumano(versionId, e.consultor);
  return { deliverableId, versionId, runId };
}

/** Otra versión del MISMO entregable, también revisada (`in_review`, con revisión CURRENT). */
export async function otraVersionRevisada(
  e: EscenarioDeContenido,
  deliverableId: string,
  revisor: User = e.consultor,
): Promise<{ readonly versionId: string; readonly runId: string }> {
  const versionId = await versionNueva(e, deliverableId);
  const { runId } = await revisarComoHumano(versionId, revisor);
  return { versionId, runId };
}

/** La evaluación (elegibilidad + huella) leída con el pool. */
export async function evaluar(versionId: string) {
  return valor(await evaluarAprobacionDeScript(getPool(), versionId));
}

export async function huellaDe(versionId: string): Promise<string> {
  return (await evaluar(versionId)).huella;
}

/** La aprobación directa de una persona desde la interfaz, con la huella que vería. */
export async function aprobarDirecto(actor: User, versionId: string) {
  return aprobarScriptVersion(actor, versionId, { huellaVista: await huellaDe(versionId) });
}

export async function estadoDeVersion(versionId: string): Promise<string> {
  return (
    await query<{ status: string }>(`SELECT status FROM script_versions WHERE id = $1`, [versionId])
  )[0]!.status;
}

export async function contarAuditoria(entityId: string, action: string): Promise<number> {
  return Number(
    (
      await query<{ n: string }>(
        `SELECT count(*)::text AS n FROM audit_events WHERE entity_id = $1 AND action = $2`,
        [entityId, action],
      )
    )[0]!.n,
  );
}

export async function aprobacionesDelEntregable(deliverableId: string): Promise<number> {
  return Number(
    (
      await query<{ n: string }>(
        `SELECT count(*)::text AS n FROM audit_events
          WHERE action = 'script_version.approve' AND metadata->>'deliverableId' = $1`,
        [deliverableId],
      )
    )[0]!.n,
  );
}

// ─────────────────────────── Camino HITL ───────────────────────────────────────

/** El agente (consultor, origen `chat`) propone aprobar la versión. */
export async function proponerAprobacion(
  e: EscenarioDeContenido,
  versionId: string,
  proponente: User = e.consultor,
): Promise<ProposedAction> {
  return valor(
    await proponerAccion(proponente, {
      type: 'script_version.approve',
      resourceId: versionId,
      origin: 'chat',
      campaignId: e.campanaId,
    }),
  );
}

export async function confirmarAprobacion(persona: User, accion: ProposedAction) {
  return confirmarAccion(persona, accion.id, { canal: 'ui', payloadHash: accion.payloadHash });
}

export async function ejecutarAprobacion(persona: User, accion: ProposedAction) {
  return ejecutarAccion(persona, accion.id, { canal: 'ui' });
}

export async function estadoDeAccion(id: string): Promise<string> {
  return (await query<{ status: string }>(`SELECT status FROM proposed_actions WHERE id = $1`, [id]))[0]!
    .status;
}

// ─────────────────────────── Fallos y demoras inyectados ───────────────────────

const FUNCION = 'test_inyeccion_aprobacion';

export type PuntoDeFallo =
  | 'marcar_executed'
  | 'auditoria_execute'
  | 'auditoria_aprobar'
  | 'auditoria_current_changed'
  | 'auditoria_supersede'
  | 'supersede'
  | 'aprobar_update'
  | 'bajada_visibilidad';

/**
 * Inyecta un fallo real de base de datos en un punto de la aprobación, SOLO para el recurso indicado:
 * `clave` es el id de la acción (marcar_executed, auditoria_execute), de la versión (auditoria_aprobar,
 * aprobar_update), del entregable (auditoria_current_changed, supersede) o de la fuente (bajada_visibilidad).
 */
export async function conFalloEn(punto: PuntoDeFallo, clave: string, fn: () => Promise<void>): Promise<void> {
  const pool = adminPool();
  await pool.query(`
    CREATE OR REPLACE FUNCTION ${FUNCION}() RETURNS trigger AS $$
    BEGIN
      IF TG_ARGV[0] = 'marcar_executed' THEN
        IF NEW.status = 'executed' AND NEW.id::text = TG_ARGV[1] THEN
          RAISE EXCEPTION 'fallo inyectado: marcar executed';
        END IF;
      ELSIF TG_ARGV[0] = 'auditoria_execute' THEN
        IF NEW.action = 'proposed_action.execute' AND NEW.entity_id::text = TG_ARGV[1] THEN
          RAISE EXCEPTION 'fallo inyectado: auditoría de ejecución';
        END IF;
      ELSIF TG_ARGV[0] = 'auditoria_aprobar' THEN
        IF NEW.action = 'script_version.approve' AND NEW.entity_id::text = TG_ARGV[1] THEN
          RAISE EXCEPTION 'fallo inyectado: auditoría de la aprobación';
        END IF;
      ELSIF TG_ARGV[0] = 'auditoria_current_changed' THEN
        IF NEW.action = 'deliverable.current_approved_changed' AND NEW.entity_id::text = TG_ARGV[1] THEN
          RAISE EXCEPTION 'fallo inyectado: auditoría del cambio de vigente';
        END IF;
      ELSIF TG_ARGV[0] = 'auditoria_supersede' THEN
        IF NEW.action = 'script_version.supersede' AND NEW.metadata->>'deliverableId' = TG_ARGV[1] THEN
          RAISE EXCEPTION 'fallo inyectado: auditoría del reemplazo';
        END IF;
      ELSIF TG_ARGV[0] = 'supersede' THEN
        IF NEW.status = 'superseded' AND NEW.deliverable_id::text = TG_ARGV[1] THEN
          RAISE EXCEPTION 'fallo inyectado: reemplazo de la versión anterior';
        END IF;
      ELSIF TG_ARGV[0] = 'aprobar_update' THEN
        IF NEW.status = 'approved' AND NEW.id::text = TG_ARGV[1] THEN
          RAISE EXCEPTION 'fallo inyectado: aprobar la versión';
        END IF;
      ELSIF TG_ARGV[0] = 'bajada_visibilidad' THEN
        IF NEW.visibility = 'interna' AND NEW.id::text = TG_ARGV[1] THEN
          RAISE EXCEPTION 'fallo inyectado: bajar la visibilidad de la fuente';
        END IF;
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql`);
  const tabla =
    punto === 'marcar_executed'
      ? 'proposed_actions'
      : punto === 'supersede' || punto === 'aprobar_update'
        ? 'script_versions'
        : punto === 'bajada_visibilidad'
          ? 'source_documents'
          : 'audit_events';
  const evento = tabla === 'audit_events' ? 'INSERT' : 'UPDATE';
  // Nombre que ordena DESPUÉS de los triggers del esquema (se dispara en último lugar).
  const trigger = `zz_${FUNCION}_${clave.replace(/-/g, '').slice(0, 12)}_${punto}`;
  await pool.query(
    `CREATE TRIGGER ${trigger} BEFORE ${evento} ON ${tabla}
       FOR EACH ROW EXECUTE FUNCTION ${FUNCION}('${punto}', '${clave}')`,
  );
  try {
    await fn();
  } finally {
    await pool.query(`DROP TRIGGER IF EXISTS ${trigger} ON ${tabla}`);
  }
}

const FUNCION_DEMORA = 'test_demora_aprobacion';

export type PuntoDeDemora =
  /** Auditoría de la aprobación: la transacción de aprobar retiene los bloqueos mientras espera. */
  | 'aprobar'
  /** Alta de una versión del entregable (retiene su mutex). */
  | 'alta_de_version'
  /** Comentario de revisión de la versión. */
  | 'comentario'
  /** Reemplazo del padre al crear la versión hija del Brief. */
  | 'brief_hijo';

/** Una demora (`pg_sleep`) en un punto concreto, para abrir una ventana de concurrencia determinista. */
export async function conDemora(
  punto: PuntoDeDemora,
  clave: string,
  segundos: number,
  fn: () => Promise<void>,
): Promise<void> {
  const pool = adminPool();
  await pool.query(`
    CREATE OR REPLACE FUNCTION ${FUNCION_DEMORA}() RETURNS trigger AS $$
    BEGIN
      IF TG_ARGV[0] = 'aprobar' THEN
        IF NEW.action = 'script_version.approve' AND NEW.entity_id::text = TG_ARGV[1] THEN
          PERFORM pg_sleep(${segundos});
        END IF;
      ELSIF TG_ARGV[0] = 'alta_de_version' THEN
        IF NEW.deliverable_id::text = TG_ARGV[1] THEN PERFORM pg_sleep(${segundos}); END IF;
      ELSIF TG_ARGV[0] = 'comentario' THEN
        IF NEW.script_version_id::text = TG_ARGV[1] THEN PERFORM pg_sleep(${segundos}); END IF;
      ELSIF TG_ARGV[0] = 'brief_hijo' THEN
        IF NEW.status = 'superseded' AND NEW.id::text = TG_ARGV[1] THEN PERFORM pg_sleep(${segundos}); END IF;
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql`);
  const tabla =
    punto === 'aprobar'
      ? 'audit_events'
      : punto === 'alta_de_version'
        ? 'script_versions'
        : punto === 'comentario'
          ? 'script_review_comments'
          : 'brief_versions';
  const evento = punto === 'brief_hijo' ? 'UPDATE' : 'INSERT';
  const trigger = `zz_${FUNCION_DEMORA}_${clave.replace(/-/g, '').slice(0, 12)}_${punto}`;
  await pool.query(
    `CREATE TRIGGER ${trigger} BEFORE ${evento} ON ${tabla}
       FOR EACH ROW EXECUTE FUNCTION ${FUNCION_DEMORA}('${punto}', '${clave}')`,
  );
  try {
    await fn();
  } finally {
    await pool.query(`DROP TRIGGER IF EXISTS ${trigger} ON ${tabla}`);
  }
}

/** Pausa corta para que una operación ya lanzada llegue a su bloqueo antes de lanzar la siguiente. */
export const esperar = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
