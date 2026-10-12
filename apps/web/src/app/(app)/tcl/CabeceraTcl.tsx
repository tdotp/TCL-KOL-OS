import type { CampanaDetalleTcl } from '@tcl-kol-os/domain';
import { monogramaColor, monogramaIniciales } from '@/lib/monograma';
import { type SeccionTcl, RUTA_TCL } from '@/lib/tcl-rutas';
import { ETIQUETA_DE_ESTADO_DE_CAMPANA, formatearRango } from '@/lib/tcl-ui';
import { NavTcl } from './NavTcl';

/**
 * Cabecera común de las pantallas de una campaña: nombre, mercado, estado en texto y navegación de secciones.
 * El `<h1>` de cada página es el título de la sección; el nombre de la campaña va como contexto.
 */
export function CabeceraTcl({
  campana,
  activa,
  titulo,
  descripcion,
}: {
  campana: CampanaDetalleTcl;
  activa: SeccionTcl;
  titulo: string;
  descripcion?: string;
}) {
  const nombre = campana.nombre ?? 'Campaña';
  return (
    <>
      <a className="back-link" href={RUTA_TCL}>
        ← Campañas
      </a>
      <header className="campaign-header compact-campaign-header">
        <span className={`monogram lg ${monogramaColor(campana.id)}`} aria-hidden="true">
          {monogramaIniciales(nombre)}
        </span>
        <div className="campaign-heading-copy">
          <div className="campaign-kickers">
            <span className={`status-dot ${campana.estado === 'en_curso' ? 'ok' : ''}`}>
              {ETIQUETA_DE_ESTADO_DE_CAMPANA[campana.estado]}
            </span>
          </div>
          <div className="eyebrow">{nombre}</div>
          <h1>{titulo}</h1>
          <p>
            {[campana.mercado, campana.categoria].filter((t): t is string => t !== null).join(' · ') ||
              'Sin mercado ni categoría'}
            {' · '}
            {formatearRango(campana.fechaInicio, campana.fechaFin)}
          </p>
          {descripcion === undefined ? null : <p className="sub">{descripcion}</p>}
        </div>
      </header>
      <NavTcl campaignId={campana.id} activa={activa} />
    </>
  );
}

/** Estado vacío con texto claro (sin botones). */
export function VacioTcl({ titulo, texto }: { titulo: string; texto: string }) {
  return (
    <div className="card empty-state compact-empty" data-testid="tcl-vacio">
      <h2>{titulo}</h2>
      <p>{texto}</p>
    </div>
  );
}

export function PildoraTcl({
  tono,
  children,
}: {
  tono: 'ok' | 'warn' | 'neutro' | 'info';
  children: string;
}) {
  return <span className={`pill ${tono}`}>{children}</span>;
}
