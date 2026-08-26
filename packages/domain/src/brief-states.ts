/**
 * Máquina de estados del brief.
 *
 * Implementa la sección 7.3 del documento maestro y el diagrama de
 * `docs/product/D0-03-flujo-to-be.md` §4.
 *
 * Dos propiedades no negociables:
 *  1. `approved` es inmutable (ADR-003). Un cambio crea una versión nueva.
 *  2. Existe siempre un camino sin IA: desde `draft` se llega a `approved`
 *     sin pasar nunca por `processing` (§5, principio 9).
 *
 * Toda transición valida rol, estado actual y datos mínimos requeridos (§7.3).
 */

import type { BriefStatus, BriefField, BriefVersion, Role, User } from './types';
import { type DomainErrorPayload, type Result, err, ok } from './errors';
import { campoDelCatalogo } from './brief-catalog';

/** Quién ejecuta la transición. `'system'` es el worker, no una persona. */
export type Actor = User | 'system';

export interface TransitionContext {
  readonly version: BriefVersion;
  readonly actor: Actor;
  /** Preguntas locales sobre campos críticos que siguen sin responder ni descartar. */
  readonly pendingCriticalQuestions?: number | undefined;
  /** Preguntas locales de cualquier criticidad que siguen sin responder ni descartar. */
  readonly pendingQuestionsTotal?: number | undefined;
  /**
   * Claves de campos críticos sin valor `found` y sin una pregunta local
   * `descartada` que lo justifique. La calcula el llamador consultando
   * `local_questions` (Postgres) — el dominio no lo deriva solo, igual que ya
   * hace `pendingCriticalQuestions` (Sprint 4, corrección 1/2 del cierre).
   */
  readonly unresolvedCriticalFields?: readonly string[] | undefined;
}

type Guard = (ctx: TransitionContext) => DomainErrorPayload | null;

interface TransitionRule {
  readonly from: BriefStatus;
  readonly to: BriefStatus;
  /** `'system'` = solo el worker. Un array = roles humanos autorizados. */
  readonly roles: readonly Role[] | 'system';
  readonly guards: readonly Guard[];
  readonly description: string;
}

// ─────────────────────────── Guardas ───────────────────────────────────────────

/**
 * Campos que exigen evidencia documental cuando tienen valor.
 *
 * Un `claim` (afirmación verificable sobre el producto) la exige siempre, sin
 * excepción — un claim manual sin evidencia sigue bloqueando el avance
 * (DEC-028). Un campo `critico` no técnico respondido por pregunta local
 * (`provenanceType: 'manual_local'`) NO la exige: se sustenta con autor y
 * fecha, no con un fragmento documental. Un `critico` que la IA dice haber
 * *encontrado* en una fuente sí sigue exigiéndola — ahí "encontrado" es
 * exactamente el tipo de afirmación que el sistema nunca inventa.
 */
function requiresEvidence(field: BriefField): boolean {
  if (field.criticidad === 'claim') return true;
  return field.criticidad === 'critico' && field.provenanceType !== 'manual_local';
}

/**
 * §9.4: "si dos fuentes se contradicen, crear una pregunta de conflicto".
 * Un conflicto sin resolver en un campo crítico no puede avanzar a revisión.
 */
const guardNoUnresolvedConflicts: Guard = ({ version }) => {
  const conflicted = version.fields.filter((f) => f.status === 'conflict' && requiresEvidence(f));
  if (conflicted.length === 0) return null;
  return {
    code: 'BRIEF_UNRESOLVED_CONFLICT',
    message: `El brief tiene ${conflicted.length} campo(s) con contradicción entre fuentes sin resolver.`,
    details: { campos: conflicted.map((f) => f.key) },
  };
};

/**
 * §15: "claims y datos técnicos con evidencia: 100%".
 * Esta guarda es la que hace que ese umbral no dependa de la disciplina del usuario.
 */
const guardClaimsHaveEvidence: Guard = ({ version }) => {
  const unsupported = version.fields.filter(
    (f) => requiresEvidence(f) && f.status === 'found' && f.evidence.length === 0,
  );
  if (unsupported.length === 0) return null;
  return {
    code: 'BRIEF_MISSING_EVIDENCE',
    message: `El brief tiene ${unsupported.length} campo(s) crítico(s) o claim(s) sin evidencia.`,
    details: { campos: unsupported.map((f) => f.key) },
  };
};

/** No se aprueba un brief con preguntas críticas abiertas. */
const guardNoPendingCriticalQuestions: Guard = ({ pendingCriticalQuestions }) => {
  const pending = pendingCriticalQuestions ?? 0;
  if (pending === 0) return null;
  return {
    code: 'BRIEF_PENDING_QUESTIONS',
    message: `Quedan ${pending} pregunta(s) sobre campos críticos sin responder ni descartar.`,
    details: { pendientes: pending },
  };
};

/** §10.3, regla 2: cada traducción apunta a su versión de origen. */
const guardTranslationHasOrigin: Guard = ({ version }) => {
  if (version.language === 'es') return null;
  if (version.translationOfId !== undefined && version.translationOfId !== '') return null;
  return {
    code: 'TRANSLATION_MISSING_ORIGIN',
    message: 'Una versión en inglés debe referenciar la versión en español de la que deriva.',
    details: { versionId: version.id, language: version.language },
  };
};

/**
 * Un campo crítico sin valor y sin una pregunta local descartada que lo
 * justifique no puede colarse a revisión interna (Sprint 4, sección 7 del
 * cierre). El llamador calcula la lista consultando `local_questions`.
 */
const guardCriticalFieldsResolved: Guard = ({ unresolvedCriticalFields }) => {
  const claves = unresolvedCriticalFields ?? [];
  if (claves.length === 0) return null;
  return {
    code: 'BRIEF_MISSING_CRITICAL_FIELD',
    message: `El brief tiene ${claves.length} campo(s) crítico(s) sin valor ni descarte justificado: ${claves.join(', ')}.`,
    details: { campos: claves },
  };
};

/**
 * Defensa en profundidad (DEC-023): un campo de nivel `producto` (p. ej.
 * `marca_producto[].rtbs`) nunca debería llegar sin `campaignProductId` — eso
 * ya lo impide `packages/db` al persistir — pero el dominio también lo
 * verifica antes de dejar avanzar el brief.
 */
const guardProductFieldsAnchored: Guard = ({ version }) => {
  const sinAnclar = version.fields.filter((f) => {
    const campo = campoDelCatalogo(f.key);
    return campo?.nivel === 'producto' && f.campaignProductId === undefined;
  });
  if (sinAnclar.length === 0) return null;
  return {
    code: 'BRIEF_FIELD_INVALID',
    message: `El brief tiene ${sinAnclar.length} campo(s) de producto sin un producto de campaña válido asociado.`,
    details: { campos: sinAnclar.map((f) => f.key) },
  };
};

/**
 * Un campo que la extracción encontró (`status: 'found'`) pero que nadie
 * confirmó ni corrigió todavía no puede pasar a revisión interna en silencio
 * (Sprint 4, corrección 2 del cierre: "no permitas pasar a internal_review si
 * los campos... siguen pendientes de revisión").
 */
const guardAllFieldsReviewed: Guard = ({ version }) => {
  const sinRevisar = version.fields.filter((f) => f.status === 'found' && f.reviewStatus === 'pending');
  if (sinRevisar.length === 0) return null;
  return {
    code: 'BRIEF_FIELD_INVALID',
    message: `El brief tiene ${sinRevisar.length} campo(s) encontrado(s) por la extracción que nadie confirmó ni corrigió todavía.`,
    details: { campos: sinRevisar.map((f) => f.key) },
  };
};

/**
 * `local_questions → extraction_review` solo se habilita cuando ya no queda
 * ninguna pregunta pendiente, de cualquier criticidad (Sprint 4, corrección 1
 * del cierre: "cuando todas estén respondidas o descartadas justificadamente,
 * permite" esta transición). Distinta de `guardNoPendingCriticalQuestions`,
 * que solo mira las críticas y solo se usa antes de aprobar.
 */
const guardNoPendingQuestions: Guard = ({ pendingQuestionsTotal }) => {
  const pending = pendingQuestionsTotal ?? 0;
  if (pending === 0) return null;
  return {
    code: 'BRIEF_PENDING_QUESTIONS',
    message: `Quedan ${pending} pregunta(s) local(es) sin responder ni descartar.`,
    details: { pendientes: pending },
  };
};

// ─────────────────────────── Reglas de transición ──────────────────────────────

const EDITORIAL_ROLES: readonly Role[] = ['admin', 'director', 'consultor'];
const APPROVER_ROLES: readonly Role[] = ['admin', 'director'];

/** Estados desde los que se puede cancelar una campaña. */
const CANCELLABLE: readonly BriefStatus[] = [
  'draft',
  'processing',
  'processing_failed',
  'extraction_review',
  'local_questions',
  'internal_review',
  'internal_changes_requested',
  'client_review',
  'client_changes_requested',
];

export const TRANSITIONS: readonly TransitionRule[] = [
  // ── Procesamiento de fuentes ──
  {
    from: 'draft',
    to: 'processing',
    roles: EDITORIAL_ROLES,
    guards: [],
    description: 'Se lanza el procesamiento de las fuentes cargadas.',
  },
  {
    from: 'processing',
    to: 'extraction_review',
    roles: 'system',
    guards: [],
    description: 'La extracción terminó correctamente.',
  },
  {
    from: 'processing',
    to: 'processing_failed',
    roles: 'system',
    guards: [],
    description: 'El worker falló al procesar alguna fuente.',
  },
  {
    from: 'processing_failed',
    to: 'processing',
    roles: EDITORIAL_ROLES,
    guards: [],
    description: 'Reintento del procesamiento fallido.',
  },
  {
    from: 'processing_failed',
    to: 'draft',
    roles: EDITORIAL_ROLES,
    guards: [],
    description: 'Se abandona el procesamiento y se continúa en modo manual.',
  },

  // ── Revisión de extracción y vacíos ──
  {
    from: 'extraction_review',
    to: 'local_questions',
    roles: EDITORIAL_ROLES,
    guards: [],
    description: 'Se detectaron vacíos o contradicciones que requieren respuesta humana.',
  },
  {
    from: 'local_questions',
    to: 'extraction_review',
    roles: EDITORIAL_ROLES,
    guards: [guardNoPendingQuestions],
    description: 'Las preguntas locales fueron respondidas o descartadas con justificación.',
  },

  // ── Camino a revisión interna ──
  {
    from: 'extraction_review',
    to: 'internal_review',
    roles: EDITORIAL_ROLES,
    guards: [
      guardNoUnresolvedConflicts,
      guardClaimsHaveEvidence,
      guardNoPendingCriticalQuestions,
      guardCriticalFieldsResolved,
      guardProductFieldsAnchored,
      guardAllFieldsReviewed,
      guardTranslationHasOrigin,
    ],
    description: 'El consultor solicita revisión interna.',
  },
  {
    // MODO MANUAL: llegar a revisión sin haber pasado nunca por `processing`.
    // Es la transición que hace real el principio de fallback (§5, principio 9).
    from: 'draft',
    to: 'internal_review',
    roles: EDITORIAL_ROLES,
    guards: [
      guardNoUnresolvedConflicts,
      guardClaimsHaveEvidence,
      guardNoPendingCriticalQuestions,
      guardCriticalFieldsResolved,
      guardProductFieldsAnchored,
      guardAllFieldsReviewed,
      guardTranslationHasOrigin,
    ],
    description: 'Brief completado manualmente, sin asistencia de IA.',
  },

  // ── Revisión interna ──
  {
    from: 'internal_review',
    to: 'internal_changes_requested',
    roles: APPROVER_ROLES,
    guards: [],
    description: 'El revisor devuelve el brief con cambios solicitados.',
  },
  {
    from: 'internal_changes_requested',
    to: 'internal_review',
    roles: EDITORIAL_ROLES,
    guards: [guardNoUnresolvedConflicts],
    description: 'Los cambios solicitados fueron aplicados.',
  },
  {
    from: 'internal_review',
    to: 'client_review',
    roles: APPROVER_ROLES,
    guards: [guardNoUnresolvedConflicts, guardClaimsHaveEvidence],
    description: 'Aprobado internamente y enviado al cliente.',
  },

  // ── Revisión del cliente (ocurre fuera del sistema; aquí se registra) ──
  {
    from: 'client_review',
    to: 'client_changes_requested',
    roles: EDITORIAL_ROLES,
    guards: [],
    description: 'Se registra que el cliente devolvió el brief con cambios.',
  },
  {
    from: 'client_changes_requested',
    to: 'internal_review',
    roles: EDITORIAL_ROLES,
    guards: [guardNoUnresolvedConflicts],
    description: 'Nueva versión lista tras los cambios del cliente.',
  },
  {
    from: 'client_review',
    to: 'approved',
    roles: EDITORIAL_ROLES,
    guards: [
      guardNoUnresolvedConflicts,
      guardClaimsHaveEvidence,
      guardNoPendingCriticalQuestions,
      guardTranslationHasOrigin,
    ],
    description: 'Se registra la aprobación del cliente (DEC-012: ocurre fuera del sistema).',
  },

  // ── Fin de vida ──
  {
    from: 'approved',
    to: 'superseded',
    roles: EDITORIAL_ROLES,
    guards: [],
    description: 'Una versión nueva reemplaza a esta. La versión aprobada se conserva.',
  },
  ...CANCELLABLE.map((from): TransitionRule => ({
    from,
    to: 'cancelled',
    roles: APPROVER_ROLES,
    guards: [],
    description: 'La campaña fue cancelada.',
  })),
] as const;

/** Estados desde los que no sale ninguna transición hacia adelante. */
export const TERMINAL_STATES: readonly BriefStatus[] = ['superseded', 'cancelled'];

/**
 * Un brief aprobado no admite edición de su contenido (ADR-003).
 * Solo puede pasar a `superseded` cuando una versión nueva lo reemplaza.
 */
export function isImmutable(status: BriefStatus): boolean {
  return status === 'approved' || status === 'superseded' || status === 'cancelled';
}

// ─────────────────────────── API pública ───────────────────────────────────────

function actorRole(actor: Actor): Role | 'system' {
  return actor === 'system' ? 'system' : actor.role;
}

function ruleAllowsActor(rule: TransitionRule, actor: Actor): boolean {
  const role = actorRole(actor);
  if (rule.roles === 'system') return role === 'system';
  if (role === 'system') return false;
  return rule.roles.includes(role);
}

/** Transiciones existentes desde un estado, sin considerar rol ni guardas. */
export function transitionsFrom(from: BriefStatus): readonly TransitionRule[] {
  return TRANSITIONS.filter((t) => t.from === from);
}

/** Transiciones que un actor concreto puede intentar desde un estado. */
export function allowedTransitions(from: BriefStatus, actor: Actor): readonly BriefStatus[] {
  return TRANSITIONS.filter((t) => t.from === from && ruleAllowsActor(t, actor)).map((t) => t.to);
}

/**
 * Valida una transición completa: existencia, rol y datos mínimos.
 *
 * Devuelve el nuevo estado o un error tipado. No muta nada: la persistencia
 * es responsabilidad de la capa que lo invoca.
 */
export function transition(ctx: TransitionContext, to: BriefStatus): Result<BriefStatus> {
  const from = ctx.version.status;

  const rule = TRANSITIONS.find((t) => t.from === from && t.to === to);
  if (rule === undefined) {
    return err({
      code: 'BRIEF_INVALID_TRANSITION',
      message: `El brief no puede pasar de ${from} a ${to}.`,
      details: { from, to, permitidas: transitionsFrom(from).map((t) => t.to) },
    });
  }

  if (!ruleAllowsActor(rule, ctx.actor)) {
    return err({
      code: 'FORBIDDEN_ROLE',
      message: `El rol ${String(actorRole(ctx.actor))} no puede ejecutar la transición ${from} → ${to}.`,
      details: { from, to, rolesPermitidos: rule.roles },
    });
  }

  for (const guard of rule.guards) {
    const failure = guard(ctx);
    if (failure !== null) return err(failure);
  }

  return ok(to);
}

/**
 * Comprueba que una versión admite edición de contenido.
 * Editar una versión aprobada no es una transición: exige crear una versión nueva.
 */
export function assertEditable(version: BriefVersion): Result<BriefVersion> {
  if (isImmutable(version.status)) {
    return err({
      code: 'BRIEF_VERSION_IMMUTABLE',
      message: `La versión ${version.version} está en estado ${version.status} y no admite edición. Cree una versión nueva.`,
      details: { versionId: version.id, status: version.status },
    });
  }
  return ok(version);
}
