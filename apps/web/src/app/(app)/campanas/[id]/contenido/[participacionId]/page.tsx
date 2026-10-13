import { notFound, redirect } from 'next/navigation';
import { esUuid, getCampaign, listarContenidoDeCampana } from '@tcl-kol-os/db';
import { roleCan } from '@tcl-kol-os/domain';
import { currentUser } from '@/lib/session';
import { desviarClienteDeRutaLegada } from '@/lib/tcl-guard';
import { NavCampana } from '@/components/NavCampana';
import { TarjetaDeParticipacion } from '../TarjetaDeParticipacion';
import styles from '../contenido.module.css';

export const dynamic = 'force-dynamic';

/**
 * Entregables de UNA participación (influencer en la campaña). Mismo guard que la lista: sesión →
 * campaña de SU organización → `deliverable:read`; cliente, analista, legal, otra organización o una
 * participación que no es de esta campaña reciben el mismo 404.
 */
export default async function ContenidoDeParticipacionPage({
  params,
}: {
  params: Promise<{ id: string; participacionId: string }>;
}) {
  const user = await currentUser();
  if (user === undefined) redirect('/login');
  // Cliente TCL: a su equivalente de `/tcl` (o 404) ANTES de cualquier cargador interno.
  desviarClienteDeRutaLegada(user, { tipo: 'oculta' });

  const { id, participacionId } = await params;
  // Un id que no es UUID es «no existe»: no llega a la base (getCampaign reventaría con 500).
  if (!esUuid(id)) notFound();
  const campana = await getCampaign(user, id);
  if (!campana.ok || !roleCan(user.role, 'deliverable:read')) notFound();
  const { campaign } = campana.value;

  const lista = await listarContenidoDeCampana(user, campaign.id, { participacionId });
  if (!lista.ok) notFound();
  const participacion = lista.value.participaciones.find((p) => p.participacionId === participacionId);
  if (participacion === undefined) notFound();

  const campanaActiva = campaign.status === 'activa';
  const puedeCrear =
    lista.value.proyeccion === 'cuenta' && campanaActiva && roleCan(user.role, 'deliverable:manage');

  return (
    <div className="content content-wide ui-enter" data-testid="contenido-participacion-page">
      <a className="back-link" href={`/campanas/${campaign.id}/contenido`}>
        ← Contenido de {campaign.name}
      </a>

      <NavCampana campaignId={campaign.id} role={user.role} activa="contenido" />

      <div className={styles['pagina']}>
        <header className={styles['cabecera']}>
          <div>
            <div className="eyebrow">Contenido · influencer</div>
            <h1>{participacion.influencerNombre}</h1>
          </div>
        </header>

        {!campanaActiva && (
          <div className="aviso" role="status" data-testid="contenido-campana-solo-lectura">
            <strong>Campaña {campaign.status}</strong>
            El contenido es de solo lectura.
          </div>
        )}

        {lista.value.limiteDeEntregables !== undefined && (
          <div className="aviso" role="status" data-testid="contenido-limite-de-entregables">
            <strong>
              Se muestran {lista.value.limiteDeEntregables.mostrados} de{' '}
              {lista.value.limiteDeEntregables.total} entregables
            </strong>
            Esta influencer supera el máximo que la lista carga de una vez.
          </div>
        )}

        <TarjetaDeParticipacion
          campaignId={campaign.id}
          participacion={participacion}
          puedeCrear={puedeCrear}
          titulo={false}
        />
      </div>
    </div>
  );
}
