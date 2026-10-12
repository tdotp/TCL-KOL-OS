/**
 * Helpers de los E2E del dashboard TCL (V2 · Fase 9, DEC-050).
 *
 * Igual que `operacion.ts` y `contenido.ts`: los datos se CREAN con los casos de uso de `packages/db` y sus
 * utilidades de prueba; las consultas de este archivo son SOLO LECTURAS de verificación sobre la base `_test`
 * aislada. Todo es sintético.
 *
 * Centinelas: a los de Operación (fee, factura, pago, PII…) se suman los de lo que TCL NO debe ver aunque esté
 * en la misma campaña: borrador de guion, guion rechazado, hallazgos, comentarios internos, fuente interna y
 * borrador del Brief.
 */
import { createHmac } from 'node:crypto';
import { request, type APIRequestContext } from '@playwright/test';
import {
  crearComentarioDeRevision,
  query,
  setSourceVisibility,
  solicitarCambiosDeScript,
} from '@tcl-kol-os/db';
import {
  crearBriefAprobadoDePrueba,
  crearBriefHijoDePrueba,
  crearFuenteDePrueba,
  type EscenarioDeOperacion,
} from '@tcl-kol-os/db/test-utils';
import { TEXTO_SEMBRADO, aprobarComoPersona, registrarGuionSembrado, revisarComoHumano } from './contenido';
import type { EscenarioE2E } from './contenido';
import { candadoDeBaseDePrueba } from './fixtures';
import {
  CENTINELA,
  TODOS_LOS_CENTINELAS,
  escenarioDeOperacion,
  sembrarKpiDeViews,
  sembrarOperacionConCentinelas,
  type OperacionSembrada,
} from './operacion';

/** Secreto de sesión de PRUEBA de los servidores del E2E (el mismo de `playwright.config.ts`). */
const SESSION_SECRET = 'e2e-session-secret-no-es-real-0123456789';

export const BASE_TCL = 'http://localhost:3017';

export const CENTINELA_TCL = {
  borradorDeGuion: 'SENT-BORRADOR-GUION-4412',
  guionRechazado: 'SENT-GUION-RECHAZADO-6634',
  hallazgo: 'SENT-HALLAZGO-7745',
  comentarioInterno: 'SENT-COMENTARIO-INTERNO-8856',
  fuenteInterna: 'SENT-FUENTE-INTERNA-9967',
  borradorDeBrief: 'SENT-BORRADOR-BRIEF-5523',
  presupuestoDeBrief: 'SENT-PRESUPUESTO-BRIEF-1178',
  feeEnBrief: 'SENT-FEE-EN-BRIEF-2289',
} as const;

/** Todo lo que no debe aparecer jamás en una respuesta al cliente. */
export const TODOS_LOS_CENTINELAS_TCL: readonly string[] = [
  ...TODOS_LOS_CENTINELAS,
  ...Object.values(CENTINELA_TCL),
];

/** Valores visibles a propósito (el Brief aprobado vigente y los títulos compartidos). */
export const VISIBLE_TCL = {
  tono: 'Tono aprobado cercano y aspiracional',
  oneLine: 'El P80 Pro lleva tu fotografía a otro nivel con su cámara de 200 MP.',
  documentoCompartido: 'ficha-tecnica-tcl-e2e.md',
} as const;

export interface EscenarioTcl {
  readonly op: EscenarioDeOperacion;
  readonly s: EscenarioE2E;
  readonly campaignId: string;
  readonly nombreDeCampana: string;
  readonly operacion: OperacionSembrada;
  /** Versiones sembradas por entregable. */
  readonly versiones: {
    /** V1 aprobada vigente + V2 borrador posterior (con centinela). */
    readonly aprobada: { readonly entregableId: string; readonly v1: string; readonly v2: string };
    /** Solo borrador recibido (con centinela). */
    readonly borrador: { readonly entregableId: string; readonly versionId: string };
    /** Cambios solicitados (rechazada) con hallazgo y comentario interno. */
    readonly rechazada: { readonly entregableId: string; readonly versionId: string };
  };
  readonly documentoCompartidoId: string;
  readonly documentoInternoId: string;
  readonly briefVersion: number;
}

/**
 * Escenario completo: campaña visible para TCL con operación sembrada con centinelas (fee, factura, pago, PII),
 * KPI, Brief aprobado vigente (con campos inseguros) y un hijo en borrador, tres entregables en tres estados,
 * y dos fuentes (una compartida con TCL, una interna con nombre centinela). `otraCampanaId` (interna, de la misma
 * agencia) y `campanaAjenaId` (otra agencia) quedan SIN compartir.
 */
export async function sembrarEscenarioTcl(nombre: string): Promise<EscenarioTcl> {
  candadoDeBaseDePrueba();
  const op = await escenarioDeOperacion(nombre, { acuerdo: 'mixed', monto: `${CENTINELA.fee}.00` });
  const campaignId = op.campanaId;
  const operacion = await sembrarOperacionConCentinelas(op, { reportarPago: true });
  await sembrarKpiDeViews(op, op.participaciones.valentinaRios);

  await query(`UPDATE campaigns SET visibility = 'tcl' WHERE id = $1`, [campaignId]);
  const [fila] = await query<{ name: string }>(`SELECT name FROM campaigns WHERE id = $1`, [campaignId]);

  // Brief aprobado vigente + hijo en borrador (con otro tono) + campos inseguros que la proyección debe omitir.
  const brief = await crearBriefAprobadoDePrueba(campaignId, op.admin, {
    productos: [op.productos.p80, op.productos.pro],
    valores: {
      'mensaje_principal.tono': VISIBLE_TCL.tono,
      'objetivo.negocio': `Crecer las ventas; el fee del creador es de ${CENTINELA_TCL.feeEnBrief}`,
      'practico.presupuesto': CENTINELA_TCL.presupuestoDeBrief,
    },
  });
  await crearBriefHijoDePrueba(op.admin, brief.versionId, {
    cambios: { 'mensaje_principal.tono': CENTINELA_TCL.borradorDeBrief },
    aprobar: false,
  });

  const s: EscenarioE2E = {
    e: op,
    campaignId,
    brief: undefined,
    valentina: { participacionId: op.participaciones.valentinaRios, deliverableId: op.entregables.reelRios },
    diego: { participacionId: op.participaciones.diego, deliverableId: op.entregables.reelDiego },
  };
  const textoCon = (marca: string): string[] => [...TEXTO_SEMBRADO, `${marca} texto interno del guion.`];

  // Aprobada vigente (V1) y borrador posterior (V2).
  const v1 = await registrarGuionSembrado(
    s,
    op.entregables.reelRios,
    op.participaciones.valentinaRios,
    TEXTO_SEMBRADO,
  );
  await revisarComoHumano(v1.versionId, op.consultor);
  const aprobacion = await aprobarComoPersona(op.director, v1.versionId);
  if (!aprobacion.ok) throw new Error(`TCL E2E: no se aprobó el guion sembrado — ${aprobacion.error.code}`);
  const v2 = await registrarGuionSembrado(
    s,
    op.entregables.reelRios,
    op.participaciones.valentinaRios,
    textoCon(CENTINELA_TCL.borradorDeGuion),
  );

  // Solo borrador.
  const borrador = await registrarGuionSembrado(
    s,
    op.entregables.storyRios,
    op.participaciones.valentinaRios,
    textoCon(CENTINELA_TCL.borradorDeGuion),
  );

  // Rechazada: revisada, con comentario interno y cambios solicitados con hallazgo.
  const rechazada = await registrarGuionSembrado(
    s,
    op.entregables.reelGomez,
    op.participaciones.valentinaGomez,
    textoCon(CENTINELA_TCL.guionRechazado),
  );
  await revisarComoHumano(rechazada.versionId, op.consultor);
  const comentario = await crearComentarioDeRevision(
    op.consultor,
    rechazada.versionId,
    { kind: 'editorial', body: CENTINELA_TCL.comentarioInterno },
    { origin: 'ui' },
    { campaignId },
  );
  if (!comentario.ok) throw new Error(`TCL E2E: no se creó el comentario — ${comentario.error.code}`);
  const cambios = await solicitarCambiosDeScript(
    op.consultor,
    rechazada.versionId,
    { items: [{ body: CENTINELA_TCL.hallazgo }] },
    { origin: 'ui' },
    { campaignId },
  );
  if (!cambios.ok) throw new Error(`TCL E2E: no se solicitaron cambios — ${cambios.error.code}`);

  // Documentos: uno compartido a propósito y uno interno con nombre centinela.
  const compartido = await crearFuenteDePrueba(
    campaignId,
    op.admin,
    VISIBLE_TCL.documentoCompartido.replace(/\.md$/, ''),
  );
  const compartida = await setSourceVisibility(op.admin, compartido, 'tcl');
  if (!compartida.ok) throw new Error(`TCL E2E: no se compartió el documento — ${compartida.error.code}`);
  const interno = await crearFuenteDePrueba(campaignId, op.admin, CENTINELA_TCL.fuenteInterna);

  return {
    op,
    s,
    campaignId,
    nombreDeCampana: fila!.name,
    operacion,
    versiones: {
      aprobada: { entregableId: op.entregables.reelRios, v1: v1.versionId, v2: v2.versionId },
      borrador: { entregableId: op.entregables.storyRios, versionId: borrador.versionId },
      rechazada: { entregableId: op.entregables.reelGomez, versionId: rechazada.versionId },
    },
    documentoCompartidoId: compartido,
    documentoInternoId: interno,
    briefVersion: brief.version,
  };
}

// ─────────────────────────── Verificación de escrituras (solo lecturas) ────────

/** Huella de lo que una escritura del cliente podría alterar: debe ser idéntica antes y después de sus intentos. */
export async function huellaDeEscrituras(campaignId: string, clienteId: string): Promise<string> {
  candadoDeBaseDePrueba();
  const [f] = await query<Record<string, number>>(
    `SELECT
       (SELECT count(*)::int FROM script_versions WHERE campaign_id = $1) AS versiones,
       (SELECT count(*)::int FROM deliverables WHERE campaign_id = $1) AS entregables,
       (SELECT count(*)::int FROM source_documents WHERE campaign_id = $1) AS fuentes,
       (SELECT count(*)::int FROM campaign_influencers WHERE campaign_id = $1) AS participaciones,
       (SELECT count(*)::int FROM proposed_actions WHERE campaign_id = $1) AS propuestas,
       (SELECT count(*)::int FROM script_versions WHERE campaign_id = $1 AND status = 'approved') AS aprobadas,
       (SELECT count(*)::int FROM audit_events WHERE actor_id = $2) AS auditoria_del_cliente`,
    [campaignId, clienteId],
  );
  return JSON.stringify(f);
}

// ─────────────────────────── Contexto HTTP del cliente ─────────────────────────

/** Contexto HTTP (sin seguir redirecciones) con la sesión de `userId`; sin `userId`, anónimo. */
export async function contextoHttp(userId?: string): Promise<APIRequestContext> {
  const expira = Date.now() + 60 * 60 * 1000;
  const payload = `${userId ?? ''}.${expira}`;
  const firma = createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
  return request.newContext({
    baseURL: BASE_TCL,
    maxRedirects: 0,
    extraHTTPHeaders: userId === undefined ? {} : { cookie: `tclkolos_session=${payload}.${firma}` },
  });
}

// ─────────────────────────── CSV mínimo ────────────────────────────────────────

/** Parser CSV (RFC 4180, comillas dobles) suficiente para el export de TCL. Quita el BOM. */
export function parsearCsv(texto: string): string[][] {
  const t = texto.replace(/^\uFEFF/u, '');
  const filas: string[][] = [];
  let fila: string[] = [];
  let campo = '';
  let comillas = false;
  for (let i = 0; i < t.length; i += 1) {
    const c = t[i]!;
    if (comillas) {
      if (c === '"' && t[i + 1] === '"') {
        campo += '"';
        i += 1;
      } else if (c === '"') comillas = false;
      else campo += c;
    } else if (c === '"') comillas = true;
    else if (c === ',') {
      fila.push(campo);
      campo = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && t[i + 1] === '\n') i += 1;
      fila.push(campo);
      campo = '';
      if (fila.some((x) => x !== '') || fila.length > 1) filas.push(fila);
      fila = [];
    } else campo += c;
  }
  if (campo !== '' || fila.length > 0) {
    fila.push(campo);
    filas.push(fila);
  }
  return filas;
}
