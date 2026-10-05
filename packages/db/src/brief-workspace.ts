/**
 * Contrato de lectura consolidado del Brief Workspace (Sprint 6).
 *
 * `obtenerBriefWorkspace` no ejecuta SQL propio contra campos, preguntas o
 * comentarios — compone funciones de repositorio que ya existen
 * (`getCampaign`, `versionesDelBrief`, `verCamposDeVersion`,
 * `listarPreguntas`, `contarConversacionesAbiertas`,
 * `listarComentariosDeVersion`, `listBriefFieldRevisions`,
 * `listBriefActivity`) y las reduce a la forma que `BriefWorkspace`
 * promete. Ninguna regla de negocio se reimplementa aquí:
 * `allowedTransitions` y `requiresEvidence` son las mismas funciones de
 * `packages/domain` que ya deciden si una transición real se acepta o se
 * rechaza; `mensajeResponsabilidad` arma la frase de "quién debe actuar"
 * sin inventar una segunda matriz de transiciones.
 *
 * Dos proyecciones separadas a propósito (Fase B, regla explícita): esta
 * función es la interna. Nunca se le pasa un actor `cliente` esperando que
 * "oculte" columnas — cuando el actor es `cliente`, los comentarios
 * internos ni siquiera se consultan (más abajo), así que no existe una
 * propiedad que filtrar por accidente. Si el cliente necesita su propia
 * proyección de este mismo dato, debe ser un tipo explícito nuevo, no este
 * con menos campos poblados.
 *
 * Checkpoint 2 (Revisar brief + Actividad) extiende esta misma función —
 * nunca crea una que compita con ella (§4 del pedido).
 */

import {
  type BriefStatus,
  type Criticality,
  type FieldStatus,
  type ProvenanceType,
  type RepresentationSummary,
  type ReviewStatus,
  type Role,
  type User,
  type BriefWorkspace,
  type Result,
  type WorkspaceActivityItem,
  type WorkspaceAllowedAction,
  type WorkspaceSection,
  type WorkspaceSectionField,
  type WorkspaceTask,
  type WorkspaceVersionSummary,
  ORDEN_DE_SECCIONES,
  TEXTO_DEL_BOTON,
  TITULO_SECCION,
  allowedTransitions,
  campoDelCatalogo,
  err,
  humanoDeEvento,
  humanoDeRevisionCampo,
  mensajeResponsabilidad,
  ok,
  requiresEvidence,
} from '@tcl-kol-os/domain';
import { getCampaign } from './campaigns.ts';
import { listBriefActivity } from './audit.ts';
import { contarConversacionesAbiertas, listarComentariosDeVersion } from './comments.ts';
import { listBriefFieldRevisions } from './brief-fields.ts';
import { listarPreguntas } from './local-questions.ts';
import { verCamposDeVersion, versionesDelBrief } from './extraction.ts';
import { getPool } from './client.ts';
import { obtenerVersionLogica } from './brief-representations.ts';

const ESTADOS_INMUTABLES = new Set<BriefStatus>(['approved', 'superseded', 'cancelled']);

/**
 * Acciones de `audit_events` que ya se cuentan con más detalle desde otra
 * fuente (`brief_field_revisions` para los campos, `field_comments` para
 * los comentarios) — se excluyen de la línea de auditoría genérica para no
 * mostrar el mismo hecho dos veces con menos contexto la segunda vez.
 */
const ACCIONES_CON_FUENTE_MAS_RICA = new Set([
  'field.confirm',
  'field.correct',
  'field.resolve_conflict',
  'field.declare_exception',
  'field.revert_exception',
  'comment.create',
  'comment.reply',
  'comment.resolve',
  'comment.reopen',
]);

/** A quién le toca mover la versión — puramente presentacional, nunca una regla de permisos. */
function siguienteResponsable(status: BriefStatus): Role | undefined {
  switch (status) {
    case 'internal_review':
    case 'client_review': // heredado: Dirección la cierra o la devuelve; el cliente nunca es responsable
      return 'director';
    case 'draft':
    case 'processing':
    case 'extraction_review':
    case 'local_questions':
    case 'internal_changes_requested':
    case 'client_changes_requested': // heredado: SmartPR aplica los cambios
    case 'processing_failed':
      return 'consultor';
    default:
      return undefined;
  }
}

export interface OpcionesDeBriefWorkspace {
  /**
   * `false` omite la línea de actividad (auditoría genérica, comentarios y
   * revisiones de campo): `activity` queda vacía y se ahorran 3 lecturas SIN
   * tope. Los conteos (`progress.commentsOpen`) se conservan. Por defecto `true`
   * (comportamiento de siempre). Lo usa el ensamblado de contexto del agente.
   */
  readonly incluirActividad?: boolean | undefined;
}

export async function obtenerBriefWorkspace(
  actor: User,
  campaignId: string,
  opciones: OpcionesDeBriefWorkspace = {},
): Promise<Result<BriefWorkspace>> {
  const incluirActividad = opciones.incluirActividad !== false;
  const campania = await getCampaign(actor, campaignId);
  if (!campania.ok) return err({ code: campania.error.code, message: campania.error.message });

  const products = campania.value.productos.map((p) => ({
    id: p.id,
    model: p.model,
    brand: p.brand,
    rol: p.rol,
  }));

  const base = {
    campaign: {
      id: campania.value.campaign.id,
      name: campania.value.campaign.name,
      status: campania.value.campaign.status,
    },
    products,
  };

  // Eventos genéricos de auditoría: existen con o sin brief (crear/archivar
  // campaña ya genera eventos). Se excluyen los tipos que tienen una fuente
  // más rica más abajo (campos, comentarios) — nunca se filtran por
  // organización aparte: `listBriefActivity` ya solo trae lo de esta
  // campaña.
  const eventosCrudos = incluirActividad
    ? await listBriefActivity(getPool(), campania.value.campaign.organization_id, campaignId, 40)
    : [];
  const eventosGenericos: WorkspaceActivityItem[] = eventosCrudos
    .filter((e) => !ACCIONES_CON_FUENTE_MAS_RICA.has(e.action))
    .filter((e) => actor.role !== 'cliente' || e.entity_type !== 'field_comment')
    .map((e) => {
      const humano = humanoDeEvento(e.action, e.metadata);
      return {
        id: e.id,
        kind: 'evento',
        tipo: humano.tipo,
        detalle: humano.detalle,
        actorName: e.actor_name ?? undefined,
        createdAt: e.created_at.toISOString(),
      };
    });

  const versionesResultado = await versionesDelBrief(actor, campaignId);
  const versiones = versionesResultado.ok ? versionesResultado.value : [];
  const ultima = versiones[0];

  if (ultima === undefined) {
    return ok({
      ...base,
      version: undefined,
      progress: {
        percentage: 0,
        total: 0,
        ready: 0,
        decisionsPending: 0,
        criticalPending: 0,
        evidencePending: 0,
        commentsOpen: 0,
      },
      sections: [],
      tasks: [],
      activity: eventosGenericos,
      allowedActions: [],
      history: [],
      responsibility: { nextRole: undefined, message: 'Todavía no hay ninguna versión del brief.' },
    });
  }

  const status = ultima.status as BriefStatus;

  const camposResultado = await verCamposDeVersion(actor, ultima.id);
  if (!camposResultado.ok) {
    return err({ code: camposResultado.error.code, message: camposResultado.error.message });
  }
  const campos = camposResultado.value;

  const preguntasResultado = await listarPreguntas(actor, campaignId, { status: 'pendiente' });
  const preguntas = preguntasResultado.ok ? preguntasResultado.value : [];

  // Los comentarios internos y el historial de campo nunca llegan a un
  // actor `cliente` — el primero porque no tiene `comment:internal`
  // (regla explícita de Fase B); el segundo porque expone procedencia y
  // quién corrigió qué, información interna que `VistaCliente` tampoco
  // muestra (Fase D de Sprint 5). Ninguno de los dos se consulta siquiera.
  let conteosComentarios: Record<string, number> = {};
  let comentariosActividad: WorkspaceActivityItem[] = [];
  let revisionesActividad: WorkspaceActivityItem[] = [];
  if (actor.role !== 'cliente') {
    const [conteosResultado, comentariosResultado, revisionesResultado] = await Promise.all([
      contarConversacionesAbiertas(actor, ultima.id),
      incluirActividad ? listarComentariosDeVersion(actor, ultima.id) : Promise.resolve(undefined),
      incluirActividad ? listBriefFieldRevisions(actor, ultima.id) : Promise.resolve(undefined),
    ]);
    if (conteosResultado.ok) conteosComentarios = conteosResultado.value;

    if (comentariosResultado?.ok) {
      comentariosActividad = comentariosResultado.value.map((c) => {
        const catalogo = campoDelCatalogo(c.fieldKey);
        return {
          id: c.id,
          kind: 'comentario',
          tipo: c.parentCommentId === undefined ? 'Comentario' : 'Respuesta a un comentario',
          detalle: c.content,
          actorName: c.authorName,
          fieldKey: c.fieldKey,
          fieldLabel: catalogo?.label ?? c.fieldKey,
          status: c.status,
          createdAt: c.createdAt,
        };
      });
    }

    if (revisionesResultado?.ok) {
      revisionesActividad = revisionesResultado.value.map((r) => {
        const catalogo = campoDelCatalogo(r.fieldKey);
        return {
          id: r.id,
          kind: 'revision_campo',
          tipo: humanoDeRevisionCampo(r.accion),
          detalle: r.motivo ?? undefined,
          actorName: r.actorName ?? undefined,
          fieldKey: r.fieldKey,
          fieldLabel: catalogo?.label ?? r.fieldKey,
          valorAnterior: r.valorAnterior,
          valorNuevo: r.valorNuevo,
          createdAt: r.createdAt.toISOString(),
        };
      });
    }
  }
  const commentsOpen = Object.values(conteosComentarios).reduce((acc, n) => acc + n, 0);

  const activity: readonly WorkspaceActivityItem[] = [
    ...eventosGenericos,
    ...comentariosActividad,
    ...revisionesActividad,
  ].sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));

  const total = campos.length;
  const ready = campos.filter((c) => c.status === 'found').length;
  const criticalPending = campos.filter((c) => c.criticidad === 'critico' && c.status !== 'found').length;
  const evidencePending = campos.filter(
    (c) =>
      c.status === 'found' &&
      c.evidencias.length === 0 &&
      requiresEvidence({
        criticidad: c.criticidad as Criticality,
        provenanceType: c.provenanceType as ProvenanceType,
      }),
  ).length;
  const decisionsPending = preguntas.length;

  const seccionesMap = new Map<
    string,
    { total: number; completos: number; fields: WorkspaceSectionField[] }
  >();
  for (const c of campos) {
    const catalogo = campoDelCatalogo(c.key);
    const seccionId = catalogo?.section ?? 'practico';
    const entrada = seccionesMap.get(seccionId) ?? { total: 0, completos: 0, fields: [] };
    entrada.total += 1;
    if (c.status === 'found') entrada.completos += 1;
    entrada.fields.push({
      key: c.key,
      label: catalogo?.label ?? c.key,
      value: c.value,
      status: c.status as FieldStatus,
      reviewStatus: c.reviewStatus as ReviewStatus,
      provenanceType: c.provenanceType as ProvenanceType,
      criticidad: c.criticidad as Criticality,
      campaignProductId: c.campaignProductId ?? undefined,
      nivel: catalogo?.nivel ?? 'campana',
      hasEvidence: c.evidencias.length > 0,
      evidence: c.evidencias.map((e) => ({
        quote: e.quote,
        filename: e.filename,
        sourceId: e.sourceId,
        page: e.page ?? undefined,
        slide: e.slide ?? undefined,
        section: e.section ?? undefined,
        linea: e.linea ?? undefined,
        locator: e.locator ?? undefined,
      })),
    });
    seccionesMap.set(seccionId, entrada);
  }
  const sections: readonly WorkspaceSection[] = ORDEN_DE_SECCIONES.filter((id) => seccionesMap.has(id)).map(
    (id) => {
      const entrada = seccionesMap.get(id)!;
      return {
        id,
        titulo: TITULO_SECCION[id] ?? id,
        total: entrada.total,
        completos: entrada.completos,
        fields: entrada.fields,
      };
    },
  );

  const tasks: readonly WorkspaceTask[] = preguntas.map((p) => {
    const catalogo = campoDelCatalogo(p.key);
    return {
      questionId: p.id,
      key: p.key,
      label: p.label,
      question: p.question,
      reason: p.reason,
      criticidad: p.criticidad as Criticality,
      campaignProductId: p.campaignProductId ?? undefined,
      valueType: catalogo?.valueType ?? 'texto',
      valoresPermitidos: catalogo?.valoresPermitidos,
      // Un claim siempre exige evidencia documental, sin excepción (§3.3) —
      // una pregunta local nunca puede "resolverlo" solo con la respuesta.
      requiereEvidencia: catalogo?.criticidad === 'claim',
    };
  });

  const transicionesPosibles = allowedTransitions(status, actor).filter((t) => t !== 'cancelled');
  const allowedActions: readonly WorkspaceAllowedAction[] = transicionesPosibles.reduce<
    WorkspaceAllowedAction[]
  >((acc, to) => {
    const label = TEXTO_DEL_BOTON[to];
    if (label !== undefined) acc.push({ to, label });
    return acc;
  }, []);

  const history: readonly WorkspaceVersionSummary[] = versiones.map((v) => ({
    id: v.id,
    number: v.version,
    status: v.status as BriefStatus,
    createdAt: v.createdAt.toISOString(),
    isCurrent: v.id === ultima.id,
  }));
  const siguienteVersion = versiones.find((v) => v.version === ultima.version + 1);

  const logica = await obtenerVersionLogica(actor, ultima.id);
  const representations = logica.ok
    ? (Object.values(logica.value.representations) as RepresentationSummary[])
    : [];

  return ok({
    ...base,
    version: {
      id: ultima.id,
      number: ultima.version,
      status,
      language: ultima.language === 'en' ? 'en' : 'es',
      editable: !ESTADOS_INMUTABLES.has(status),
      representations,
    },
    progress: {
      percentage: total === 0 ? 0 : Math.round((ready / total) * 100),
      total,
      ready,
      decisionsPending,
      criticalPending,
      evidencePending,
      commentsOpen,
    },
    sections,
    tasks,
    activity,
    allowedActions,
    history,
    responsibility: {
      nextRole: siguienteResponsable(status),
      message: mensajeResponsabilidad({
        status,
        criticalPending,
        decisionsPending,
        siguienteVersionNumero: siguienteVersion?.version,
      }),
    },
  });
}
