import { notFound, redirect } from 'next/navigation';
import { barrerYReintentar } from '@tcl-kol-os/agent';
import {
  type VistaDeChat,
  cargarVistaDeChat,
  getCampaign,
  listarAccionesPendientesDeCampana,
  obtenerConversacionDeCampana,
} from '@tcl-kol-os/db';
import { roleCan } from '@tcl-kol-os/domain';
import { currentUser } from '@/lib/session';
import { estadoDelAsistente, etiquetaDeTool, limiteDeAdjuntoBytes } from '@/lib/chat-server';
import { ChatComposer } from './ChatComposer';
import { ChatHilo } from './ChatHilo';
import { ChatPoller } from './ChatPoller';
import { TarjetaAccionPropuesta } from './TarjetaAccionPropuesta';
import styles from './chat.module.css';

export const dynamic = 'force-dynamic';

/**
 * Chat del agente de Cuenta de una campaña.
 *
 * Guard completo (no hay middleware: cada página se protege sola): sesión → campaña de SU
 * organización → rol con `chat:write` (admin, director, consultor). Cliente, operativo,
 * analista, legal u otra organización reciben el mismo 404, sin revelar que la ruta existe.
 * Sin flag nuevo (D10): con la IA apagada se muestra el estado y no se puede enviar.
 *
 * La lectura NO escribe nada: la conversación se crea al enviar el primer mensaje. Lo único
 * que escribe una lectura es el barrido de runs abandonados (mantenimiento de sistema), y solo
 * cuando hay un run activo sin latido.
 */
export default async function ChatDeCampanaPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await currentUser();
  if (user === undefined) redirect('/login');

  const { id } = await params;
  const campana = await getCampaign(user, id);
  if (!campana.ok || !roleCan(user.role, 'chat:write')) notFound();
  const { campaign } = campana.value;

  const conversacion = await obtenerConversacionDeCampana(user, campaign.id);
  if (!conversacion.ok) notFound();

  const opciones = { etiquetar: etiquetaDeTool };
  let vista: VistaDeChat | null = null;
  if (conversacion.value !== null) {
    let cargada = await cargarVistaDeChat(user, conversacion.value.id, opciones);
    // Barrido perezoso (D9): un run activo sin latido se cierra como `RUN_ABANDONED` y se
    // puede reintentar; no hay otro proceso que lo haga.
    if (cargada.ok && cargada.value.runs.some((r) => r.stale)) {
      await barrerYReintentar(user);
      cargada = await cargarVistaDeChat(user, conversacion.value.id, opciones);
    }
    if (!cargada.ok) notFound();
    vista = cargada.value;
  }

  // Sin conversación propia también puede haber pendientes de otras personas que confirmar.
  const pendientes =
    vista !== null
      ? vista.pending
      : await listarAccionesPendientesDeCampana(user, campaign.id).then((r) => (r.ok ? r.value : []));

  const estado = estadoDelAsistente();
  const campanaActiva = campaign.status === 'activa';
  const bloqueado = estado !== 'activo' || !campanaActiva;
  const motivoDeBloqueo = !campanaActiva
    ? 'La campaña no está activa: el chat es de solo lectura.'
    : estado === 'ia_apagada'
      ? 'La IA está desactivada en este entorno.'
      : estado === 'sin_configurar'
        ? 'El asistente no está configurado en este entorno.'
        : undefined;

  const turnoActivo = vista?.runs.some((r) => r.status === 'queued' || r.status === 'running') ?? false;
  const adjuntosEnProceso = vista?.messages.some((m) => m.attachments.some((a) => !a.terminal)) ?? false;
  const maxAdjuntoMb = Math.floor(limiteDeAdjuntoBytes() / 1024 / 1024);

  return (
    <div className="content content-wide ui-enter" data-testid="chat-page">
      <a className="back-link" href={`/campanas/${campaign.id}`}>
        ← {campaign.name}
      </a>

      <nav className="campaign-context-nav" aria-label="Secciones de campaña">
        <a href={`/campanas/${campaign.id}`}>Resumen</a>
        <a href={`/campanas/${campaign.id}/fuentes`}>Fuentes</a>
        <a href={`/campanas/${campaign.id}/brief`}>Brief</a>
        <a href={`/campanas/${campaign.id}/brief/editar`}>Editar</a>
        <a className="active" href={`/campanas/${campaign.id}/chat`} aria-current="page">
          Asistente
        </a>
        {roleCan(user.role, 'deliverable:read') && (
          <a href={`/campanas/${campaign.id}/contenido`} data-testid="contenido-nav-link">
            Contenido
          </a>
        )}
      </nav>

      <div className={styles['pagina']}>
        <header className={styles['cabecera']}>
          <div>
            <div className="eyebrow">Asistente de Cuenta</div>
            <h1>Conversar sobre {campaign.name}</h1>
            <p className={styles['nota']}>
              Consulta el brief, las fuentes y los influencers de la campaña, y pide cambios en lenguaje
              natural. El asistente actúa con tus permisos y deja registro de lo que hace; lo irreversible
              (aprobar el brief, aplicar una importación) solo ocurre cuando una persona con permiso lo
              confirma en pantalla.
            </p>
          </div>
        </header>

        {estado === 'ia_apagada' && (
          <div className="aviso" role="status" data-testid="chat-ai-off">
            <strong>El asistente está apagado</strong>
            La IA está desactivada en este entorno. Puedes revisar la conversación, pero el asistente no
            responderá hasta que se active.
          </div>
        )}
        {estado === 'sin_configurar' && (
          <div className="aviso error" role="status" data-testid="chat-ai-unconfigured">
            <strong>El asistente no está configurado</strong>
            Falta un secreto de servidor para ejecutarlo. Avisa a quien administra la plataforma.
          </div>
        )}
        {!campanaActiva && (
          <div className="aviso" role="status" data-testid="chat-campaign-readonly">
            <strong>Campaña {campaign.status}</strong>
            El chat es de solo lectura.
          </div>
        )}

        {pendientes.length > 0 && (
          <section
            className={`card ${styles['pendientes'] ?? ''}`}
            aria-labelledby="chat-pendientes"
            data-testid="chat-pending-panel"
          >
            <h2 id="chat-pendientes">Pendientes de confirmar en esta campaña</h2>
            {pendientes.map((p) => (
              <TarjetaAccionPropuesta key={p.id} campaignId={campaign.id} accion={p} />
            ))}
          </section>
        )}

        <section className={`card ${styles['panel'] ?? ''}`} aria-label="Chat con el asistente">
          <ChatHilo campaignId={campaign.id} vista={vista} />
          <ChatPoller activo={turnoActivo || adjuntosEnProceso} />
          <ChatComposer
            campaignId={campaign.id}
            bloqueado={bloqueado}
            motivoDeBloqueo={motivoDeBloqueo}
            turnoActivo={turnoActivo}
            maxAdjuntoMb={maxAdjuntoMb}
          />
        </section>
      </div>
    </div>
  );
}
