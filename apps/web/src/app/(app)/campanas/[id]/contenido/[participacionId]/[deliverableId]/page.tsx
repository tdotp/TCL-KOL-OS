import { notFound, redirect } from 'next/navigation';
import {
  type VistaDeDeliverableDeCuenta,
  type VistaDeDeliverableDeEstado,
  esUuid,
  getCampaign,
  obtenerDeliverableConVersiones,
} from '@tcl-kol-os/db';
import { roleCan } from '@tcl-kol-os/domain';
import { limiteDeAdjuntoBytes } from '@/lib/chat-server';
import { currentUser } from '@/lib/session';
import { BloqueDeAprobacion } from '../../BloqueDeAprobacion';
import { FormularioSubirVersion } from '../../FormularioSubirVersion';
import { FormulariosDeComentario } from '../../FormulariosDeComentario';
import { HistorialDeVersiones } from '../../HistorialDeVersiones';
import { NavCampana } from '../../NavCampana';
import { SeccionComentarios } from '../../SeccionComentarios';
import { SeccionDeRevision } from '../../SeccionDeRevision';
import { SeccionHallazgos } from '../../SeccionHallazgos';
import {
  ESTADO_DE_VERSION,
  PILL_DE_RESUMEN,
  PILL_DE_VERSION,
  RESUMEN_DE_ENTREGABLE,
  etiquetaDePlataforma,
  fecha,
  fechaHora,
} from '../../etiquetas';
import styles from '../../contenido.module.css';

export const dynamic = 'force-dynamic';

const ENTERO = /^[1-9][0-9]{0,5}$/u;

/**
 * Un entregable con su historial de versiones (`?v=n`, por defecto la última).
 *
 * Guard completo (no hay middleware): sesión → campaña de SU organización → `deliverable:read`.
 * Cliente, analista, legal, otra organización, una pieza que no es de esta campaña o participación, o una
 * versión inexistente reciben el mismo 404. La consulta ramifica el DTO por rol: Cuenta recibe todo
 * (historial, hallazgos del Brief y comentarios de SmartPR en secciones separadas, evaluación); el
 * Operativo, solo el estado. El control de aprobación solo se pinta para `script:approve`; el servidor
 * lo exige igual.
 */
export default async function ContenidoDeEntregablePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string; participacionId: string; deliverableId: string }>;
  searchParams: Promise<{ v?: string | string[] }>;
}) {
  const user = await currentUser();
  if (user === undefined) redirect('/login');

  const { id, participacionId, deliverableId } = await params;
  const { v } = await searchParams;
  // Un id que no es UUID es «no existe»: no llega a la base (getCampaign reventaría con 500).
  if (!esUuid(id)) notFound();
  const campana = await getCampaign(user, id);
  if (!campana.ok || !roleCan(user.role, 'deliverable:read')) notFound();
  const { campaign } = campana.value;

  let versionNumber: number | undefined;
  if (v !== undefined) {
    if (typeof v !== 'string' || !ENTERO.test(v)) notFound();
    versionNumber = Number(v);
  }

  const leida = await obtenerDeliverableConVersiones(user, deliverableId, {
    alcance: { campaignId: campaign.id },
    participacionId,
    versionNumber,
  });
  if (!leida.ok) notFound();
  const vista = leida.value;

  const base = `/campanas/${campaign.id}/contenido/${participacionId}/${deliverableId}`;
  const campanaActiva = campaign.status === 'activa';

  return (
    <div className="content content-wide ui-enter" data-testid="contenido-deliverable-page">
      <a className="back-link" href={`/campanas/${campaign.id}/contenido/${participacionId}`}>
        ← {vista.participacion.influencerNombre}
      </a>

      <NavCampana campaignId={campaign.id} role={user.role} />

      <div className={styles['pagina']}>
        <header className={styles['cabecera']}>
          <div>
            <div className="eyebrow">Entregable · {vista.participacion.influencerNombre}</div>
            <h1 data-testid="contenido-deliverable-nombre">{vista.nombre}</h1>
            <div className={styles['meta']} style={{ marginTop: 8 }}>
              {vista.plataforma !== undefined && <span>{etiquetaDePlataforma(vista.plataforma)}</span>}
              {vista.proyeccion === 'cuenta' && vista.producto !== undefined && (
                <span>Producto: {vista.producto}</span>
              )}
              {vista.estado === 'archived' && <span className="pill neutro">Archivado</span>}
              <span
                className={PILL_DE_RESUMEN[vista.resumen] ?? 'pill neutro'}
                data-testid="contenido-deliverable-resumen"
              >
                {RESUMEN_DE_ENTREGABLE[vista.resumen] ?? vista.resumen}
              </span>
            </div>
          </div>
          {vista.proyeccion === 'cuenta' && roleCan(user.role, 'chat:write') && (
            <a className="btn" href={`/campanas/${campaign.id}/chat`} data-testid="contenido-chat-link">
              Ver en el chat
            </a>
          )}
        </header>

        {!campanaActiva && (
          <div className="aviso" role="status" data-testid="contenido-campana-solo-lectura">
            <strong>Campaña {campaign.status}</strong>
            El contenido es de solo lectura: no se registran versiones, comentarios ni aprobaciones.
          </div>
        )}

        {vista.proyeccion === 'estado' ? (
          <VistaDeEstado vista={vista} />
        ) : (
          <VistaDeCuenta
            vista={vista}
            base={base}
            campaignId={campaign.id}
            participacionId={participacionId}
            deliverableId={deliverableId}
            campanaActiva={campanaActiva}
            maxMb={Math.floor(limiteDeAdjuntoBytes() / 1024 / 1024)}
          />
        )}
      </div>
    </div>
  );
}

/** Operativo: solo el estado de la pieza (la consulta ya le entregó el DTO reducido). */
function VistaDeEstado({ vista }: { vista: VistaDeDeliverableDeEstado }) {
  return (
    <section className="card" data-testid="contenido-estado-reducido" aria-label="Estado de la pieza">
      <div className="eyebrow">Estado de la pieza</div>
      <dl className={styles['datos']}>
        <div>
          <dt>Última versión</dt>
          <dd data-testid="contenido-estado-ultima">
            {vista.ultima === null ? (
              'Sin guion todavía'
            ) : (
              <>
                V{vista.ultima.numero} ·{' '}
                <span className={PILL_DE_VERSION[vista.ultima.estado] ?? 'pill neutro'}>
                  {ESTADO_DE_VERSION[vista.ultima.estado] ?? vista.ultima.estado}
                </span>
              </>
            )}
          </dd>
        </div>
        <div>
          <dt>Versión aprobada vigente</dt>
          <dd data-testid="contenido-estado-vigente">
            {vista.aprobadaVigente === null
              ? 'Ninguna todavía'
              : `V${vista.aprobadaVigente.numero} · ${fecha(vista.aprobadaVigente.fecha)} · ${vista.aprobadaVigente.archivo}`}
          </dd>
        </div>
      </dl>
    </section>
  );
}

function VistaDeCuenta({
  vista,
  base,
  campaignId,
  participacionId,
  deliverableId,
  campanaActiva,
  maxMb,
}: {
  vista: VistaDeDeliverableDeCuenta;
  base: string;
  campaignId: string;
  participacionId: string;
  deliverableId: string;
  campanaActiva: boolean;
  maxMb: number;
}) {
  const v = vista.version;
  const puedeGestionar =
    vista.permisos.gestionar &&
    campanaActiva &&
    vista.estado === 'active' &&
    vista.participacion.estado === 'activo';

  return (
    <div className={styles['detalle']}>
      <aside className={styles['principal']} aria-label="Versiones del guion">
        <section className="card" data-testid="contenido-historial-card">
          <div className="eyebrow">Historial</div>
          <h2 className="plain-heading" style={{ marginBottom: 10 }}>
            Versiones
          </h2>
          <HistorialDeVersiones base={base} versiones={vista.versiones} elegida={v?.numero} />
        </section>
        {puedeGestionar && (
          <section className="card">
            <FormularioSubirVersion
              campaignId={campaignId}
              participacionId={participacionId}
              deliverableId={deliverableId}
              maxMb={maxMb}
            />
          </section>
        )}
      </aside>

      <div className={styles['principal']}>
        {v === null ? (
          <section className="card empty-state compact-empty" data-testid="contenido-sin-versiones">
            <div className="empty-state-mark">G</div>
            <h2>Todavía no hay versiones de este guion</h2>
            <p>Sube el primer archivo del guion desde el panel «Versiones».</p>
          </section>
        ) : (
          <>
            <section
              className="card"
              aria-labelledby="contenido-version-titulo"
              data-testid="contenido-version-detalle"
              data-version={v.numero}
              data-estado={v.estado}
            >
              <div className={styles['seccionCabecera']}>
                <div>
                  <div className="eyebrow">Versión elegida</div>
                  <h2 id="contenido-version-titulo" className="plain-heading">
                    V{v.numero}
                  </h2>
                </div>
                <div className={styles['etiquetas']}>
                  <span
                    className={PILL_DE_VERSION[v.estado] ?? 'pill neutro'}
                    data-testid="contenido-version-estado"
                  >
                    {ESTADO_DE_VERSION[v.estado] ?? v.estado}
                  </span>
                  {v.esUltima && <span className="pill curso">Última</span>}
                  {v.esAprobadaVigente && <span className="pill ok">Aprobada vigente</span>}
                  {!v.esAprobadaVigente && v.aprobadaAlgunaVez && (
                    <span className="pill neutro">Aprobada · reemplazada por V{v.reemplazadaPor ?? '?'}</span>
                  )}
                  {!v.aprobadaAlgunaVez && v.reemplazadaPor !== undefined && (
                    <span className="pill neutro">Reemplazada por V{v.reemplazadaPor}</span>
                  )}
                </div>
              </div>
              <dl className={styles['datos']}>
                <div>
                  <dt>Recibida</dt>
                  <dd>{fechaHora(v.fecha)}</dd>
                </div>
                <div>
                  <dt>Subida por</dt>
                  <dd>{v.creadaPor}</dd>
                </div>
                {v.archivo !== undefined && (
                  <div data-testid="contenido-archivo">
                    <dt>Archivo</dt>
                    <dd>
                      <a
                        href={`/campanas/${campaignId}/fuentes/${v.archivo.sourceId}`}
                        data-testid="contenido-archivo-link"
                      >
                        {v.archivo.nombre}
                      </a>
                      <br />
                      <span
                        className={styles['itemMeta']}
                        data-testid="contenido-archivo-estado"
                        data-estado={v.archivo.estado}
                      >
                        {v.archivo.etiquetaDeEstado}
                      </span>
                    </dd>
                  </div>
                )}
                {v.aprobadaEn !== undefined && (
                  <div>
                    <dt>Aprobada</dt>
                    <dd>
                      {fechaHora(v.aprobadaEn)}
                      {v.aprobadaPor === undefined ? '' : ` · ${v.aprobadaPor}`}
                    </dd>
                  </div>
                )}
              </dl>
              {v.archivo !== undefined && !v.archivo.terminal && (
                <p className={styles['nota']} data-testid="contenido-archivo-procesando">
                  El archivo todavía se está procesando: el texto estará disponible para el análisis cuando
                  termine. Recarga la página para ver el estado.
                </p>
              )}
              <p className={styles['nota']} style={{ fontSize: 12 }}>
                El enlace muestra el texto extraído del archivo en las fuentes de la campaña. La descarga del
                original no está disponible todavía.
              </p>
            </section>

            <SeccionDeRevision
              campaignId={campaignId}
              version={v}
              puedeGestionar={puedeGestionar}
              briefVigenteNumero={vista.briefVigente?.numero}
            />

            <SeccionHallazgos campaignId={campaignId} revision={v.revision} hallazgos={v.hallazgosDelBrief} />

            <SeccionComentarios
              campaignId={campaignId}
              comentarios={v.comentarios}
              cambiosSolicitados={v.cambiosSolicitados}
            />

            {puedeGestionar && v.abierta && (
              <section className="card" data-testid="contenido-acciones-comentario">
                <div className="eyebrow">SmartPR</div>
                <h2 className="plain-heading" style={{ marginBottom: 10 }}>
                  Comentar o pedir cambios
                </h2>
                <FormulariosDeComentario
                  campaignId={campaignId}
                  versionId={v.id}
                  numeroDeVersion={v.numero}
                />
              </section>
            )}

            {v.evaluacion !== null && (
              <section
                className="card"
                aria-labelledby="contenido-aprobacion-titulo"
                data-testid="contenido-aprobacion-card"
              >
                <div className="eyebrow">Decisión humana</div>
                <h2 id="contenido-aprobacion-titulo" className="plain-heading" style={{ marginBottom: 10 }}>
                  Aprobación de la V{v.numero}
                </h2>

                {v.propuestaDeAprobacion.hay && (
                  <div className="aviso" role="status" data-testid="contenido-propuesta">
                    <strong>Hay una propuesta de aprobación pendiente</strong>
                    {v.propuestaDeAprobacion.vista === undefined ? (
                      <>El asistente propuso aprobar esta versión.</>
                    ) : (
                      <span className={styles['texto']} data-testid="contenido-propuesta-texto">
                        {v.propuestaDeAprobacion.vista.textoHumano}
                      </span>
                    )}{' '}
                    Se confirma desde el chat, con su huella:{' '}
                    <a href={`/campanas/${campaignId}/chat`} data-testid="contenido-propuesta-enlace">
                      abrir el chat
                    </a>
                    . Proponer no cambia el estado de la versión.
                  </div>
                )}

                <BloqueDeAprobacion
                  campaignId={campaignId}
                  versionId={v.id}
                  numeroDeVersion={v.numero}
                  entregable={vista.nombre}
                  influencer={vista.participacion.influencerNombre}
                  evaluacion={v.evaluacion}
                  puedeAprobar={vista.permisos.aprobar}
                  campanaActiva={campanaActiva}
                />
              </section>
            )}
          </>
        )}
      </div>
    </div>
  );
}
