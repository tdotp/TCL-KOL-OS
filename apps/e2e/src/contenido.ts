/**
 * Helpers de los E2E de Contenido (V2 · Fase 7: guiones, revisión y aprobación humana).
 *
 * Igual que `fixtures.ts` y `chat.ts`: los datos se CREAN con las funciones de `packages/db` y sus
 * utilidades de prueba (`@tcl-kol-os/db/test-utils`), nunca con SQL de dominio propio; las consultas de
 * este archivo son SOLO LECTURAS de verificación sobre la base `_test` aislada (candado de
 * `candadoDeBaseDePrueba`). Todo es sintético (nunca P80 real ni `.env`/`.storage`).
 *
 * El análisis asistido se prueba con el proveedor falso del worker real (8011): el MODO se pide con
 * `[[fake:analisis <modo>]]` dentro del TEXTO DEL GUION (ver `services/ai-worker/app/ai/fake_analisis.py`).
 */
import { expect, type APIRequestContext, type Page } from '@playwright/test';
import {
  aprobarScriptVersion,
  obtenerEvaluacionDeAprobacion,
  query,
  registrarRevisionHumana,
  registrarVersionDeGuion,
} from '@tcl-kol-os/db';
import {
  type BriefDePrueba,
  type EscenarioDeContenido,
  crearBriefAprobadoDePrueba,
  crearEscenarioDeContenido,
  crearFuenteDeGuionConTexto,
  limpiarEscenarioDeContenido,
} from '@tcl-kol-os/db/test-utils';
import type { User } from '@tcl-kol-os/domain';
import { procesarColaDeDocumentos } from './chat';
import { candadoDeBaseDePrueba } from './fixtures';

// ─────────────────────────── Escenario ─────────────────────────────────────────

/** Modos válidos del análisis falso que usan estas pruebas (los inválidos se piden por su nombre). */
export type ModoDeAnalisis =
  'limpio' | 'por_defecto' | 'cta_ausente' | 'claim_sin_respaldo' | 'contradiccion' | 'intento_aprobar';

export interface EscenarioE2E {
  readonly e: EscenarioDeContenido;
  readonly campaignId: string;
  /** Brief aprobado vigente (`undefined` si el escenario se creó sin Brief). */
  readonly brief: BriefDePrueba | undefined;
  /** «Valentina Ríos» y su entregable «Reel principal» (sin versiones). */
  readonly valentina: { readonly participacionId: string; readonly deliverableId: string };
  /** «Diego Peña» y su entregable «Reel principal» (sin versiones). */
  readonly diego: { readonly participacionId: string; readonly deliverableId: string };
}

const escenarios: EscenarioDeContenido[] = [];

/**
 * Escenario de contenido desechable: campaña ACTIVA con tres influencers sintéticos («Valentina Ríos»,
 * «Valentina Gómez», «Diego Peña»), cuatro entregables y, salvo `conBrief:false`, un Brief APROBADO
 * (documento rector) con los campos que usa el análisis. Se limpia con `limpiarContenido`.
 */
export async function escenarioDeContenido(
  nombre: string,
  opciones: { readonly conBrief?: boolean } = {},
): Promise<EscenarioE2E> {
  candadoDeBaseDePrueba();
  const e = await crearEscenarioDeContenido(`E2E · ${nombre}`);
  escenarios.push(e);
  const brief =
    opciones.conBrief === false
      ? undefined
      : await crearBriefAprobadoDePrueba(e.campanaId, e.admin, {
          productos: [e.productos.p80, e.productos.pro],
          noEncontrados: ['objetivo.comportamiento_esperado'],
        });
  return {
    e,
    campaignId: e.campanaId,
    brief,
    valentina: { participacionId: e.participaciones.valentinaRios, deliverableId: e.entregables.reelRios },
    diego: { participacionId: e.participaciones.diego, deliverableId: e.entregables.reelDiego },
  };
}

/** Limpia todo lo creado por `escenarioDeContenido` en este proceso (campañas, versiones, influencers). */
export async function limpiarContenido(): Promise<void> {
  candadoDeBaseDePrueba();
  for (const e of escenarios.splice(0, escenarios.length)) await limpiarEscenarioDeContenido(e);
}

// ─────────────────────────── Guiones sintéticos ────────────────────────────────

let secuencia = 0;

/**
 * Texto de un guion sintético en Markdown (cada párrafo es un fragmento). El MODO del análisis falso va
 * dentro del primer párrafo. `extra` se agrega como último párrafo (p. ej. un texto hostil).
 */
export function textoDeGuion(modo: ModoDeAnalisis, extra?: string): string {
  secuencia += 1;
  return [
    `# Guion de prueba ${secuencia}`,
    '',
    `Hola a todos, hoy les muestro el nuevo P80 Pro con su cámara de 200 MP para fotos de día y de noche. [[fake:analisis ${modo}]]`,
    '',
    'Es perfecto para fotografía profesional y la batería dura todo el día; no se pierdan esta oferta.',
    ...(extra === undefined ? [] : ['', extra]),
    '',
  ].join('\n');
}

export interface ArchivoDeGuion {
  readonly name: string;
  readonly mimeType: string;
  readonly buffer: Buffer;
}

/** Archivo `.md` sintético listo para `setInputFiles` o para el multipart del route handler. */
export function archivoDeGuion(nombre: string, texto: string): ArchivoDeGuion {
  secuencia += 1;
  return {
    name: `${nombre}-${secuencia}.md`,
    mimeType: 'text/markdown',
    buffer: Buffer.from(texto, 'utf8'),
  };
}

/** Registra (como persona, origen `ui`) una versión NUEVA del entregable con un guion procesado en la base. */
export async function registrarGuionSembrado(
  s: EscenarioE2E,
  deliverableId: string,
  participacionId: string,
  texto: readonly string[],
  actor: User = s.e.consultor,
): Promise<{ versionId: string; fuenteId: string }> {
  candadoDeBaseDePrueba();
  secuencia += 1;
  const fuenteId = await crearFuenteDeGuionConTexto(
    s.campaignId,
    s.e.admin,
    `guion-sembrado-${secuencia}`,
    texto,
  );
  const r = await registrarVersionDeGuion(
    actor,
    {
      campaignId: s.campaignId,
      sourceId: fuenteId,
      participation: { participationId: participacionId },
      deliverable: { id: deliverableId },
    },
    { origin: 'ui' },
  );
  if (!r.ok || r.value.kind !== 'registered') {
    throw new Error(
      `Contenido E2E: no se registró la versión sembrada — ${r.ok ? r.value.kind : r.error.code}`,
    );
  }
  return { versionId: r.value.version.id, fuenteId };
}

/** Registra una fuente YA existente (p. ej. en cola o fallida) como la versión siguiente del entregable. */
export async function registrarFuenteComoVersion(
  s: EscenarioE2E,
  deliverableId: string,
  participacionId: string,
  sourceId: string,
  actor: User = s.e.consultor,
): Promise<string> {
  candadoDeBaseDePrueba();
  const r = await registrarVersionDeGuion(
    actor,
    {
      campaignId: s.campaignId,
      sourceId,
      participation: { participationId: participacionId },
      deliverable: { id: deliverableId },
    },
    { origin: 'ui' },
  );
  if (!r.ok || r.value.kind !== 'registered') {
    throw new Error(`Contenido E2E: no se registró la versión — ${r.ok ? r.value.kind : r.error.code}`);
  }
  return r.value.version.id;
}

/** Registra la revisión humana (CURRENT contra el Brief rector): la versión pasa a `in_review`. */
export async function revisarComoHumano(versionId: string, actor: User, nota?: string): Promise<void> {
  candadoDeBaseDePrueba();
  const r = await registrarRevisionHumana(actor, versionId, nota === undefined ? {} : { nota }, {
    origin: 'ui',
  });
  if (!r.ok) throw new Error(`Contenido E2E: no se registró la revisión humana — ${r.error.code}`);
}

/** La huella de aprobación que vería `actor` en el diálogo (evaluación vigente de la versión). */
export async function huellaDeAprobacion(actor: User, versionId: string): Promise<string> {
  candadoDeBaseDePrueba();
  const ev = await obtenerEvaluacionDeAprobacion(actor, versionId);
  if (!ev.ok) throw new Error(`Contenido E2E: no se pudo evaluar la aprobación — ${ev.error.code}`);
  return ev.value.huella;
}

/** Aprobación directa de una persona desde la interfaz (canal `ui`) con la huella que vería. Solo para sembrar. */
export async function aprobarComoPersona(actor: User, versionId: string) {
  return aprobarScriptVersion(actor, versionId, {
    huellaVista: await huellaDeAprobacion(actor, versionId),
    origen: 'ui',
  });
}

/** Texto sintético estándar de un guion sembrado (sin marcador de modo: el análisis sería `limpio`). */
export const TEXTO_SEMBRADO: readonly string[] = [
  'Hola a todos, hoy les muestro el nuevo P80 Pro con su cámara de 200 MP para fotos de día y de noche.',
  'Es perfecto para fotografía profesional y la batería dura todo el día; no se pierdan esta oferta.',
];

// ─────────────────────────── Navegación y subida ───────────────────────────────

export function rutaDeContenido(
  campaignId: string,
  participacionId?: string,
  deliverableId?: string,
): string {
  const base = `/campanas/${campaignId}/contenido`;
  if (participacionId === undefined) return base;
  return deliverableId === undefined
    ? `${base}/${participacionId}`
    : `${base}/${participacionId}/${deliverableId}`;
}

/** POST directo al route handler de subida (con la sesión de `request`). */
export async function subirGuionPorApi(
  request: APIRequestContext,
  campaignId: string,
  participacionId: string,
  deliverableId: string,
  archivo: ArchivoDeGuion,
) {
  return request.post(`/api/campanas/${campaignId}/contenido/guiones`, {
    multipart: { archivo, participacionId, deliverableId },
  });
}

/**
 * Sube un guion por el formulario de la página del entregable (el que usa la persona) y espera a que la
 * página navegue a la versión creada (`?v=n`).
 */
export async function subirGuionPorFormulario(page: Page, archivo: ArchivoDeGuion): Promise<void> {
  // `next dev` hidrata tarde: si el clic llega ANTES de que React enganche el formulario, el navegador lo
  // envía de forma nativa (GET con `?archivo=…`, sin subir nada). Es una carrera del servidor de desarrollo,
  // no de la aplicación: se detecta ese envío nativo y se reintenta con la página ya hidratada.
  for (let intento = 1; intento <= 3; intento += 1) {
    await page.getByTestId('contenido-subir-archivo').setInputFiles(archivo);
    await page.getByTestId('contenido-subir-submit').click();
    try {
      await expect(page).toHaveURL(/\?v=\d+$/, { timeout: intento === 3 ? 30_000 : 8_000 });
      return;
    } catch (error) {
      if (intento === 3 || !page.url().includes('archivo=')) throw error;
      await page.goto(page.url().split('?')[0]!);
    }
  }
}

/**
 * Espera (por observación de la base, con el consumidor real de la cola documental) a que la fuente esté
 * `procesado`. Sin sleeps fijos: cada intento corre `worker.py --once` y vuelve a mirar la base.
 */
export async function esperarFuenteProcesada(sourceId: string, timeoutMs = 90_000): Promise<void> {
  candadoDeBaseDePrueba();
  await expect
    .poll(
      async () => {
        const [fila] = await query<{ status: string }>(
          `SELECT status::text AS status FROM source_documents WHERE id = $1`,
          [sourceId],
        );
        if (fila?.status === 'procesado') return 'procesado';
        if (fila?.status === 'fallido') return 'fallido';
        await procesarColaDeDocumentos();
        return fila?.status ?? 'sin-fuente';
      },
      { timeout: timeoutMs, intervals: [500, 1_000, 2_000] },
    )
    .toBe('procesado');
}

// ─────────────────────────── Lecturas de verificación en BD ────────────────────

export interface FilaDeVersion {
  readonly id: string;
  readonly version: number;
  readonly status: string;
  readonly source_document_id: string;
  readonly approved_by: string | null;
  readonly approved_at: string | null;
  readonly approved_via_proposed_action_id: string | null;
  readonly superseded_by_version_id: string | null;
}

export async function versionesDe(deliverableId: string): Promise<FilaDeVersion[]> {
  candadoDeBaseDePrueba();
  return query<FilaDeVersion>(
    `SELECT id, version, status, source_document_id, approved_by, approved_at::text AS approved_at,
            approved_via_proposed_action_id, superseded_by_version_id
       FROM script_versions WHERE deliverable_id = $1 ORDER BY version`,
    [deliverableId],
  );
}

export async function versionDe(deliverableId: string, numero: number): Promise<FilaDeVersion> {
  const fila = (await versionesDe(deliverableId)).find((v) => v.version === numero);
  if (fila === undefined) throw new Error(`Contenido E2E: no existe la V${numero} del entregable.`);
  return fila;
}

export async function estadoDeVersion(versionId: string): Promise<string> {
  candadoDeBaseDePrueba();
  const [fila] = await query<{ status: string }>(`SELECT status FROM script_versions WHERE id = $1`, [
    versionId,
  ]);
  return fila!.status;
}

export interface FilaDeRevision {
  readonly id: string;
  readonly kind: string;
  readonly status: string;
  readonly finding_count: number;
  readonly governing_brief_number: number;
  readonly failure_code: string | null;
  readonly created_by: string;
}

export async function revisionesDe(versionId: string): Promise<FilaDeRevision[]> {
  candadoDeBaseDePrueba();
  return query<FilaDeRevision>(
    `SELECT id, kind, status, finding_count, governing_brief_number, failure_code, created_by
       FROM content_analysis_runs WHERE script_version_id = $1 ORDER BY created_at, id`,
    [versionId],
  );
}

export async function contarHallazgos(versionId: string): Promise<number> {
  candadoDeBaseDePrueba();
  const [fila] = await query<{ n: number }>(
    `SELECT count(*)::int AS n FROM content_findings
      WHERE analysis_run_id IN (SELECT id FROM content_analysis_runs WHERE script_version_id = $1)`,
    [versionId],
  );
  return fila!.n;
}

export async function contarComentarios(versionId: string, tipo?: 'editorial' | 'change_request') {
  candadoDeBaseDePrueba();
  const [fila] = await query<{ n: number }>(
    `SELECT count(*)::int AS n FROM script_review_comments
      WHERE script_version_id = $1 AND ($2::text IS NULL OR kind = $2)`,
    [versionId, tipo ?? null],
  );
  return fila!.n;
}

export async function contarPropuestas(campaignId: string): Promise<number> {
  candadoDeBaseDePrueba();
  const [fila] = await query<{ n: number }>(
    `SELECT count(*)::int AS n FROM proposed_actions WHERE campaign_id = $1`,
    [campaignId],
  );
  return fila!.n;
}

export async function contarVersiones(campaignId: string): Promise<number> {
  candadoDeBaseDePrueba();
  const [fila] = await query<{ n: number }>(
    `SELECT count(*)::int AS n FROM script_versions WHERE campaign_id = $1`,
    [campaignId],
  );
  return fila!.n;
}

export interface EventoDeAuditoria {
  readonly action: string;
  readonly origin: string | null;
  readonly actor_id: string | null;
  readonly entity_type: string;
  readonly entity_id: string | null;
  readonly correlation: Record<string, string> | null;
  readonly metadata: Record<string, unknown>;
}

/** Auditoría de una entidad (o de lo correlacionado con una propuesta), en orden cronológico. */
export async function auditoriaDeEntidad(
  entityId: string,
  proposedActionId?: string,
): Promise<EventoDeAuditoria[]> {
  candadoDeBaseDePrueba();
  return query<EventoDeAuditoria>(
    `SELECT action, origin, actor_id, entity_type, entity_id, correlation, metadata
       FROM audit_events
      WHERE entity_id = $1::uuid
         OR ($2::text IS NOT NULL AND (entity_id = $2::uuid OR correlation->>'proposedActionId' = $2::text))
      ORDER BY created_at, id`,
    [entityId, proposedActionId ?? null],
  );
}

/** Cuántos eventos de auditoría de la campaña tienen esa acción. */
export async function contarAuditoriaDeCampana(campaignId: string, accion: string): Promise<number> {
  candadoDeBaseDePrueba();
  const [fila] = await query<{ n: number }>(
    `SELECT count(*)::int AS n FROM audit_events
      WHERE action = $2
        AND (entity_id IN (SELECT id FROM script_versions WHERE campaign_id = $1)
          OR entity_id IN (SELECT id FROM deliverables WHERE campaign_id = $1)
          OR entity_id IN (SELECT id FROM content_analysis_runs WHERE campaign_id = $1)
          OR entity_id IN (SELECT id FROM proposed_actions WHERE campaign_id = $1))`,
    [campaignId, accion],
  );
  return fila!.n;
}
