import { notFound, redirect } from 'next/navigation';
import { esUuid, getCampaign, listarContenidoDeCampana } from '@tcl-kol-os/db';
import { roleCan } from '@tcl-kol-os/domain';
import { currentUser } from '@/lib/session';
import { desviarClienteDeRutaLegada } from '@/lib/tcl-guard';
import { NavCampana } from './NavCampana';
import { TarjetaDeParticipacion } from './TarjetaDeParticipacion';
import styles from './contenido.module.css';

export const dynamic = 'force-dynamic';

/**
 * Contenido de una campaña: por influencer (participación), sus entregables con estado y revisión.
 *
 * Guard completo (no hay middleware: cada página se protege sola): sesión → campaña de SU organización →
 * rol con `deliverable:read`. Cliente, analista, legal y otra organización reciben el mismo 404, sin
 * revelar que la ruta existe. Cuenta (admin, director, consultor) ve el detalle y puede crear entregables
 * con la campaña activa; el Operativo ve solo el estado (la consulta ya le entrega el DTO reducido).
 */
export default async function ContenidoDeCampanaPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await currentUser();
  if (user === undefined) redirect('/login');
  // Cliente TCL: a su equivalente de `/tcl` (o 404) ANTES de cualquier cargador interno.
  desviarClienteDeRutaLegada(user, { tipo: 'oculta' });

  const { id } = await params;
  // Un id que no es UUID es «no existe»: no llega a la base (getCampaign reventaría con 500).
  if (!esUuid(id)) notFound();
  const campana = await getCampaign(user, id);
  if (!campana.ok || !roleCan(user.role, 'deliverable:read')) notFound();
  const { campaign } = campana.value;

  const lista = await listarContenidoDeCampana(user, campaign.id);
  if (!lista.ok) notFound();
  const vista = lista.value;
  const esCuenta = vista.proyeccion === 'cuenta';
  const campanaActiva = campaign.status === 'activa';
  const puedeCrear = esCuenta && campanaActiva && roleCan(user.role, 'deliverable:manage');

  return (
    <div className="content content-wide ui-enter" data-testid="contenido-page">
      <a className="back-link" href={`/campanas/${campaign.id}`}>
        ← {campaign.name}
      </a>

      <NavCampana campaignId={campaign.id} role={user.role} />

      <div className={styles['pagina']}>
        <header className={styles['cabecera']}>
          <div>
            <div className="eyebrow">Contenido</div>
            <h1>Guiones y entregables de {campaign.name}</h1>
            <p className={styles['nota']}>
              {esCuenta
                ? 'Cada influencer tiene sus entregables; cada entregable acumula las versiones del guion (nunca se sobrescribe una) y se revisa contra el Brief aprobado vigente. Aprobar es una decisión humana de dirección o administración.'
                : 'Estado de las piezas de contenido de cada influencer: la última versión y la versión aprobada vigente.'}
            </p>
          </div>
          <div className={styles['meta']} data-testid="contenido-totales">
            <span className="pill neutro">
              {vista.totales.entregablesActivos}{' '}
              {vista.totales.entregablesActivos === 1 ? 'entregable activo' : 'entregables activos'}
            </span>
          </div>
        </header>

        {!campanaActiva && (
          <div className="aviso" role="status" data-testid="contenido-campana-solo-lectura">
            <strong>Campaña {campaign.status}</strong>
            El contenido es de solo lectura: no se crean entregables ni se registran versiones.
          </div>
        )}
        {vista.limiteDeEntregables !== undefined && (
          <div className="aviso" role="status" data-testid="contenido-limite-de-entregables">
            <strong>
              Se muestran {vista.limiteDeEntregables.mostrados} de {vista.limiteDeEntregables.total}{' '}
              entregables
            </strong>
            La campaña supera el máximo que esta lista carga de una vez; los totales de arriba son los reales.
            Entra a cada influencer para ver el resto.
          </div>
        )}
        {esCuenta && vista.briefRector === null && (
          <div className="aviso" role="status" data-testid="contenido-sin-brief">
            <strong>Todavía no existe un Brief aprobado para usar como documento rector</strong>
            Puedes subir guiones y comentarlos, pero no revisarlos contra el Brief ni aprobarlos hasta que el
            Brief de la campaña esté aprobado.
          </div>
        )}
        {esCuenta && vista.briefRector !== null && vista.briefRector !== undefined && (
          <p className={styles['nota']} data-testid="contenido-brief-rector">
            Documento rector: Brief V{vista.briefRector.numero} (aprobado).
          </p>
        )}

        {vista.participaciones.length === 0 ? (
          <section className="card empty-state compact-empty" data-testid="contenido-sin-participaciones">
            <div className="empty-state-mark">C</div>
            <h2>Todavía no hay influencers en esta campaña</h2>
            <p>El contenido se organiza por participación: asocia influencers a la campaña para empezar.</p>
          </section>
        ) : (
          vista.participaciones.map((p) => (
            <TarjetaDeParticipacion
              key={p.participacionId}
              campaignId={campaign.id}
              participacion={p}
              puedeCrear={puedeCrear}
              titulo
            />
          ))
        )}
      </div>
    </div>
  );
}
