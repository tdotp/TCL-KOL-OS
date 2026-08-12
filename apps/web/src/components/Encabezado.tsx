import type { User } from '@tcl-kol-os/domain';
import { cerrarSesion } from '@/lib/actions';

/**
 * Encabezado con la identidad activa.
 *
 * Mostrar siempre quién eres y de qué organización no es decorativo: en un
 * sistema cuyo criterio de aceptación es el aislamiento entre organizaciones,
 * confundir la sesión es el error más caro posible.
 */
export function Encabezado({ user }: { user: User }) {
  return (
    <header className="top">
      <span className="marca">TCL KOL OS</span>
      <nav>
        <a href="/">Inicio</a>
        <a href="/campanas">Campañas</a>
      </nav>
      <div className="quien">
        <span>
          {user.name} · <span className="pill info">{user.role}</span>
        </span>
        <form action={cerrarSesion}>
          <button className="btn" type="submit">
            Salir
          </button>
        </form>
      </div>
    </header>
  );
}
