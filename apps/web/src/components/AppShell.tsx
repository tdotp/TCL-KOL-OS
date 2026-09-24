'use client';

import { usePathname } from 'next/navigation';
import type { User } from '@tcl-kol-os/domain';
import { cerrarSesion } from '@/lib/actions';

function iniciales(nombre: string): string {
  const partes = nombre.trim().split(/\s+/);
  return partes
    .slice(0, 2)
    .map((p) => p[0] ?? '')
    .join('')
    .toUpperCase();
}

/**
 * Shell persistente de la zona autenticada (topbar + sidebar), montado una
 * sola vez desde `app/(app)/layout.tsx` — reemplaza el `<Encabezado>` que
 * antes se repetía en cada página.
 *
 * El sidebar solo lista rutas reales de primer nivel: Inicio y Campañas.
 * Fuentes/Brief/Preguntas/Review son navegación contextual de una campaña,
 * no secciones globales — no existen como tales en el producto real, así que
 * no aparecen aquí aunque el mockup de referencia las liste.
 */
export function AppShell({ user, children }: { user: User; children: React.ReactNode }) {
  const pathname = usePathname();
  const enInicio = pathname === '/';
  const enCampanas = pathname.startsWith('/campanas');

  return (
    <div className="shell">
      <header className="shell-topbar">
        <div className="shell-brand">
          <div className="shell-brand-mark">
            <span />
            <span />
          </div>
          <div>
            <div className="shell-brand-title">TCL KOL OS</div>
            <div className="shell-brand-sub">by SmartPR</div>
          </div>
        </div>
        <div className="shell-user">
          <span className="shell-user-info">
            <strong>{user.name}</strong>
            <span className="pill info">{user.role}</span>
          </span>
          <span className="shell-avatar">{iniciales(user.name)}</span>
          <form action={cerrarSesion}>
            <button className="btn" type="submit">
              Salir
            </button>
          </form>
        </div>
      </header>

      <aside className="shell-sidebar">
        <nav className="shell-nav">
          <a href="/" className={enInicio ? 'active' : undefined}>
            <span className="shell-nav-ico">⌂</span>
            <span>Inicio</span>
          </a>
          <a href="/campanas" className={enCampanas ? 'active' : undefined}>
            <span className="shell-nav-ico">▤</span>
            <span>Campañas</span>
          </a>
        </nav>
      </aside>

      <main className="shell-main">{children}</main>
    </div>
  );
}
