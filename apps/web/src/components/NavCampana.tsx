import type { Role } from '@tcl-kol-os/domain';
import { enlacesDeCampana, type SeccionCampana } from '@/lib/nav-campana';

/**
 * Navegación ÚNICA de campaña (Resumen, Fuentes, Brief, Editar, Asistente, Contenido, Operación). Cada enlace
 * solo se muestra si el rol tiene el permiso correspondiente (`lib/nav-campana.ts`); la sección activa lleva
 * `aria-current="page"`. `conteoFuentes` añade el contador junto a «Fuentes» (página de resumen).
 */
export function NavCampana({
  campaignId,
  role,
  activa,
  conteoFuentes,
}: {
  campaignId: string;
  role: Role;
  activa: SeccionCampana;
  conteoFuentes?: number;
}) {
  return (
    <nav className="campaign-context-nav" aria-label="Secciones de campaña">
      {enlacesDeCampana(role).map((e) => (
        <a
          key={e.seccion}
          href={`/campanas/${campaignId}${e.ruta}`}
          {...(e.seccion === activa ? { className: 'active', 'aria-current': 'page' as const } : {})}
          {...(e.testid !== undefined ? { 'data-testid': e.testid } : {})}
        >
          {e.etiqueta}
          {e.seccion === 'fuentes' && conteoFuentes !== undefined && <span> {conteoFuentes}</span>}
        </a>
      ))}
    </nav>
  );
}
