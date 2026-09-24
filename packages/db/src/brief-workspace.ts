/**
 * Contrato de lectura consolidado del Brief Workspace (Sprint 6, Fase B).
 *
 * `obtenerBriefWorkspace` no ejecuta ni una sola consulta SQL propia contra
 * campos, preguntas o comentarios — compone funciones de repositorio que ya
 * existen (`getCampaign`, `versionesDelBrief`, `verCamposDeVersion`,
 * `listarPreguntas`, `contarConversacionesAbiertas`, `listBriefActivity`) y
 * las reduce a la forma que `BriefWorkspace` promete. Ninguna regla de
 * negocio se reimplementa aquí: `allowedTransitions` y `requiresEvidence`
 * son las mismas funciones de `packages/domain` que ya deciden si una
 * transición real se acepta o se rechaza.
 *
 * Dos proyecciones separadas a propósito (Fase B, regla explícita): esta
 * función es la interna. Nunca se le pasa un actor `cliente` esperando que
 * "oculte" columnas — cuando el actor es `cliente`, los comentarios
 * internos ni siquiera se consultan (más abajo), así que no existe una
 * propiedad que filtrar por accidente. Si el cliente necesita su propia
 * proyección de este mismo dato, debe ser un tipo explícito nuevo, no este
 * con menos campos poblados.
 */

import {
  type BriefStatus,
  type Criticality,
  type FieldStatus,
  type ProvenanceType,
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
  ORDEN_DE_SECCIONES,
  TEXTO_DEL_BOTON,
  TITULO_SECCION,
  allowedTransitions,
  campoDelCatalogo,
  err,
  ok,
  requiresEvidence,
} from '@tcl-kol-os/domain';
import { getCampaign } from './campaigns.ts';
import { listBriefActivity } from './audit.ts';
import { contarConversacionesAbiertas } from './comments.ts';
import { listarPreguntas } from './local-questions.ts';
import { verCamposDeVersion, versionesDelBrief } from './extraction.ts';
import { getPool } from './client.ts';

const ESTADOS_INMUTABLES = new Set<BriefStatus>(['approved', 'superseded', 'cancelled']);

/** A quién le toca mover la versión — puramente presentacional (Fase C.4), nunca una regla de permisos. */
function siguienteResponsable(status: BriefStatus): Role | undefined {
  switch (status) {
    case 'internal_review':
      return 'director';
    case 'client_review':
    case 'client_changes_requested':
      return 'cliente';
    case 'draft':
    case 'processing':
    case 'extraction_review':
    case 'local_questions':
    case 'internal_changes_requested':
    case 'processing_failed':
      return 'consultor';
    default:
      return undefined;
  }
}

export async function obtenerBriefWorkspace(
  actor: User,
  campaignId: string,
): Promise<Result<BriefWorkspace>> {
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

  // Actividad de la campaña: existe con o sin brief (crear/archivar campaña
  // ya genera eventos). Los eventos de comentarios internos se excluyen para
  // el rol `cliente` en el propio mapeo — nunca dejados para que la UI decida.
  const eventosCrudos = await listBriefActivity(
    getPool(),
    campania.value.campaign.organization_id,
    campaignId,
    30,
  );
  const activity: readonly WorkspaceActivityItem[] = eventosCrudos
    .filter((e) => actor.role !== 'cliente' || e.entity_type !== 'field_comment')
    .map((e) => ({
      id: e.id,
      actorName: e.actor_name ?? undefined,
      action: e.action,
      entityType: e.entity_type,
      createdAt: e.created_at.toISOString(),
    }));

  const versionesResultado = await versionesDelBrief(actor, campaignId);
  const ultima = versionesResultado.ok ? versionesResultado.value[0] : undefined;

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
      activity,
      allowedActions: [],
      nextResponsibleRole: undefined,
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

  // Los comentarios internos nunca llegan a un actor `cliente` — no tiene
  // `comment:internal` en `packages/domain/src/permissions.ts`, así que ni
  // se consultan (regla explícita de Fase B, no un filtro cosmético).
  let conteosComentarios: Record<string, number> = {};
  if (actor.role !== 'cliente') {
    const conteosResultado = await contarConversacionesAbiertas(actor, ultima.id);
    if (conteosResultado.ok) conteosComentarios = conteosResultado.value;
  }
  const commentsOpen = Object.values(conteosComentarios).reduce((acc, n) => acc + n, 0);

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
      hasEvidence: c.evidencias.length > 0,
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

  return ok({
    ...base,
    version: {
      id: ultima.id,
      number: ultima.version,
      status,
      language: ultima.language === 'en' ? 'en' : 'es',
      editable: !ESTADOS_INMUTABLES.has(status),
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
    nextResponsibleRole: siguienteResponsable(status),
  });
}
