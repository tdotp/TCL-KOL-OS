import type { WorkspaceAllowedAction, WorkspaceResponsibility } from '@tcl-kol-os/domain';

const MODOS = [
  { id: 'completar', label: 'Completar' },
  { id: 'revisar', label: 'Revisar brief' },
  { id: 'actividad', label: 'Actividad' },
] as const;

export type ModoWorkspace = (typeof MODOS)[number]['id'];

/**
 * Navegación de los tres modos, siempre por URL (`?modo=...`) — nunca
 * estado de cliente. Sprint 6, Checkpoint 2 §3.1: "la URL debe poder
 * copiarse y recargarse". Componente de servidor: son enlaces reales, no
 * hace falta JavaScript para que funcionen.
 */
export function WorkspaceNav({ campaignId, modo }: { campaignId: string; modo: ModoWorkspace }) {
  return (
    <nav className="workspace-modo-tabs" aria-label="Modo del workspace">
      {MODOS.map((m) => (
        <a
          key={m.id}
          href={`/campanas/${campaignId}/brief/workspace?modo=${m.id}`}
          className={modo === m.id ? 'active' : undefined}
        >
          {m.label}
        </a>
      ))}
    </nav>
  );
}

/**
 * "No limitarse a esconder el botón" (§3.5) — la frase completa de quién
 * debe actuar y por qué, ya armada por `mensajeResponsabilidad` en el
 * servidor. Nunca una segunda matriz de transiciones aquí: si el actor
 * mismo puede actuar (`allowedActions` ya viene filtrado por
 * `allowedTransitions(status, actor)`, Checkpoint 1), se le ofrece un
 * enlace real a `/brief`, donde ya vive el formulario de transición —
 * este workspace no duplica esa lógica ni crea una segunda.
 */
export function BannerResponsabilidad({
  campaignId,
  responsibility,
  allowedActions,
}: {
  campaignId: string;
  responsibility: WorkspaceResponsibility;
  allowedActions: readonly WorkspaceAllowedAction[];
}) {
  return (
    <div className="workspace-responsibility">
      <span className="status-mark-dot" aria-hidden="true" />
      {responsibility.message}
      {allowedActions.map((accion) => (
        <a key={accion.to} className="btn pri" href={`/campanas/${campaignId}/brief`}>
          {accion.label}
        </a>
      ))}
    </div>
  );
}
