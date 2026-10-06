import { notFound, redirect } from 'next/navigation';
import { getCampaign, listarContenidoDeCampana } from '@tcl-kol-os/db';
import { roleCan } from '@tcl-kol-os/domain';
import { currentUser } from '@/lib/session';
import { NavCampana } from '../NavCampana';
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

  const { id, participacionId } = await params;
  const campana = await getCampaign(user, id);
  if (!campana.ok || !roleCan(user.role, 'deliverable:read')) notFound();
  const { campaign } = campana.value;

  const lista = await listarContenidoDeCampana(user, campaign.id);
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

      <NavCampana campaignId={campaign.id} role={user.role} />

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
