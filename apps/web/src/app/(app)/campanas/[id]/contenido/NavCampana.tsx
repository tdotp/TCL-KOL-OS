import { type Role, roleCan } from '@tcl-kol-os/domain';

/**
 * Navegación de campaña de las páginas de Contenido. La navegación de las demás páginas está copiada a
 * mano en cada una (no hay componente compartido); esta replica la misma con «Contenido» activo.
 */
export function NavCampana({ campaignId, role }: { campaignId: string; role: Role }) {
  return (
    <nav className="campaign-context-nav" aria-label="Secciones de campaña">
      <a href={`/campanas/${campaignId}`}>Resumen</a>
      <a href={`/campanas/${campaignId}/fuentes`}>Fuentes</a>
      <a href={`/campanas/${campaignId}/brief`}>Brief</a>
      {role !== 'cliente' && <a href={`/campanas/${campaignId}/brief/editar`}>Editar</a>}
      {roleCan(role, 'chat:write') && (
        <a href={`/campanas/${campaignId}/chat`} data-testid="chat-nav-link">
          Asistente
        </a>
      )}
      <a
        className="active"
        href={`/campanas/${campaignId}/contenido`}
        aria-current="page"
        data-testid="contenido-nav-link"
      >
        Contenido
      </a>
    </nav>
  );
}
