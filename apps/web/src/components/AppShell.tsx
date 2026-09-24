'use client';

import { useEffect, useRef, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import type { User } from '@tcl-kol-os/domain';
import { cerrarSesion } from '@/lib/actions';

function iniciales(nombre: string): string {
  return nombre
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((p) => p[0] ?? '')
    .join('')
    .toUpperCase();
}

function IconoInicio() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M3 10.8 12 3l9 7.8v8.7a1.5 1.5 0 0 1-1.5 1.5h-5v-6h-5v6h-5A1.5 1.5 0 0 1 3 19.5z" />
    </svg>
  );
}

function IconoCampanas() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M3.5 7.5h6l1.7 2H20.5v9.2a1.8 1.8 0 0 1-1.8 1.8H5.3a1.8 1.8 0 0 1-1.8-1.8z" />
      <path d="M3.5 7.5V5.3A1.8 1.8 0 0 1 5.3 3.5h4.1l1.7 2h7.6a1.8 1.8 0 0 1 1.8 1.8v2.2" />
    </svg>
  );
}

function IconoBuscar() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="11" cy="11" r="6.5" />
      <path d="m16 16 4 4" />
    </svg>
  );
}

/** Shell persistente de la zona autenticada, con búsqueda real de campañas. */
export function AppShell({ user, children }: { user: User; children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [busqueda, setBusqueda] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const enInicio = pathname === '/';
  const enCampanas = pathname.startsWith('/campanas');

  useEffect(() => {
    const manejarAtajo = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        inputRef.current?.focus();
      }
    };
    window.addEventListener('keydown', manejarAtajo);
    return () => window.removeEventListener('keydown', manejarAtajo);
  }, []);

  return (
    <div className="shell">
      <header className="shell-topbar">
        <a className="shell-brand" href="/" aria-label="TCL KOL OS · Inicio">
          <div className="shell-brand-mark" aria-hidden="true">
            <span />
            <span />
          </div>
          <div>
            <div className="shell-brand-title">TCL KOL OS</div>
            <div className="shell-brand-sub">by SmartPR</div>
          </div>
        </a>

        <form
          className="shell-search"
          role="search"
          onSubmit={(event) => {
            event.preventDefault();
            const q = busqueda.trim();
            router.push(q === '' ? '/campanas' : `/campanas?q=${encodeURIComponent(q)}`);
          }}
        >
          <span className="shell-search-icon">
            <IconoBuscar />
          </span>
          <input
            ref={inputRef}
            value={busqueda}
            onChange={(event) => setBusqueda(event.target.value)}
            placeholder="Buscar campañas…"
            aria-label="Buscar campañas"
          />
          <button type="submit" className="shell-search-kbd" aria-label="Buscar">
            ⌘ K
          </button>
        </form>

        <div className="shell-user">
          <span className="shell-user-info">
            <strong>{user.name}</strong>
            <span>{user.role}</span>
          </span>
          <span className="shell-avatar">{iniciales(user.name)}</span>
          <form action={cerrarSesion}>
            <button className="shell-exit" type="submit" title="Cerrar sesión" aria-label="Cerrar sesión">
              ↗
            </button>
          </form>
        </div>
      </header>

      <aside className="shell-sidebar">
        <nav className="shell-nav" aria-label="Navegación principal">
          <a href="/" className={enInicio ? 'active' : undefined}>
            <span className="shell-nav-ico"><IconoInicio /></span>
            <span>Inicio</span>
          </a>
          <a href="/campanas" className={enCampanas ? 'active' : undefined}>
            <span className="shell-nav-ico"><IconoCampanas /></span>
            <span>Campañas</span>
          </a>
        </nav>

        <div className="shell-sidebar-foot">
          <span className="shell-sidebar-dot" />
          <strong>SmartPR</strong>
        </div>
      </aside>

      <main className="shell-main">{children}</main>
    </div>
  );
}
