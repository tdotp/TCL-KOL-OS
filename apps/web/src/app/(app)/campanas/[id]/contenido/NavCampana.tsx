import { type Role, roleCan } from '@tcl-kol-os/domain';

/**
 * Navegación de campaña de las páginas de Contenido y de Operación. La navegación de las demás páginas está
 * copiada a mano en cada una (no hay componente compartido); esta replica la misma con «Contenido» activo
 * (por defecto) o con «Operación» activo (`activa="operacion"`). «Operación» solo se ofrece con `operations:read`
 * (el cliente no la ve).
 */
export function NavCampana({
  campaignId,
  role,
  activa = 'contenido',
}: {
  campaignId: string;
  role: Role;
  activa?: 'contenido' | 'operacion';
}) {
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
        {...(activa === 'contenido' ? { className: 'active', 'aria-current': 'page' as const } : {})}
        href={`/campanas/${campaignId}/contenido`}
        data-testid="contenido-nav-link"
      >
        Contenido
      </a>
      {roleCan(role, 'operations:read') && (
        <a
          {...(activa === 'operacion' ? { className: 'active', 'aria-current': 'page' as const } : {})}
          href={`/campanas/${campaignId}/operacion`}
          data-testid="operacion-nav-link"
        >
          Operación
        </a>
      )}
    </nav>
  );
}
