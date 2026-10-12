import { SECCIONES_TCL, type SeccionTcl, rutaDeCampanaTcl } from '@/lib/tcl-rutas';

/** Navegación de secciones de una campaña en `/tcl`. La sección activa lleva `aria-current="page"`. */
export function NavTcl({ campaignId, activa }: { campaignId: string; activa: SeccionTcl }) {
  return (
    <nav className="campaign-context-nav" aria-label="Secciones de la campaña" data-testid="tcl-nav">
      {SECCIONES_TCL.map((s) => (
        <a
          key={s.id}
          href={rutaDeCampanaTcl(campaignId, s.id)}
          {...(s.id === activa ? { className: 'active', 'aria-current': 'page' as const } : {})}
        >
          {s.etiqueta}
        </a>
      ))}
    </nav>
  );
}
