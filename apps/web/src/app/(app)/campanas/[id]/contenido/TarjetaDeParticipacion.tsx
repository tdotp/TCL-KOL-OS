import type { VistaDeParticipacionConContenido } from '@tcl-kol-os/db';
import { FormularioCrearDeliverable } from './FormularioCrearDeliverable';
import {
  ESTADO_DE_VERSION,
  ETIQUETA_DE_VIGENCIA,
  PILL_DE_RESUMEN,
  PILL_DE_VERSION,
  PILL_DE_VIGENCIA,
  RESUMEN_DE_ENTREGABLE,
  TIPO_DE_REVISION,
  etiquetaDePlataforma,
  fecha,
} from './etiquetas';
import styles from './contenido.module.css';

/**
 * Una participación (CampaignInfluencer) con sus entregables: estado derivado, última versión, aprobada
 * vigente y, solo para Cuenta, el estado de la revisión de la última versión. El Operativo recibe estos
 * mismos datos YA reducidos desde la consulta (sin revisión, hallazgos ni comentarios).
 */
export function TarjetaDeParticipacion({
  campaignId,
  participacion,
  puedeCrear,
  titulo,
}: {
  campaignId: string;
  participacion: VistaDeParticipacionConContenido;
  /** Rol con `deliverable:manage` y campaña activa. */
  puedeCrear: boolean;
  /** Si es la página de la propia participación, el nombre ya es el título de la página. */
  titulo: boolean;
}) {
  const base = `/campanas/${campaignId}/contenido/${participacion.participacionId}`;
  const retirada = participacion.estadoDeParticipacion === 'retirado';
  return (
    <section
      className={`card ${styles['participacion'] ?? ''}`}
      aria-label={`Contenido de ${participacion.influencerNombre}`}
      data-testid="contenido-participacion"
      data-participacion-id={participacion.participacionId}
      data-estado={participacion.estadoDeParticipacion}
    >
      <div className={styles['participacionCabecera']}>
        <div>
          {titulo && <div className="eyebrow">Influencer</div>}
          <h2 className="plain-heading">
            {titulo ? (
              <a href={base} style={{ color: 'inherit', textDecoration: 'none' }}>
                {participacion.influencerNombre}
              </a>
            ) : (
              participacion.influencerNombre
            )}
          </h2>
          <div className={styles['meta']}>
            {participacion.cuentas.length > 0 && <span>{participacion.cuentas.join(' · ')}</span>}
            {participacion.productos.length > 0 && (
              <span>Producto: {participacion.productos.join(', ')}</span>
            )}
          </div>
        </div>
        <div className={styles['etiquetas']}>
          {retirada && <span className="pill neutro">Retirado de la campaña</span>}
          <span className="pill neutro">
            {participacion.entregables.length}{' '}
            {participacion.entregables.length === 1 ? 'entregable' : 'entregables'}
          </span>
        </div>
      </div>

      {participacion.entregables.length === 0 ? (
        <p className={styles['vacio']} data-testid="contenido-participacion-vacia">
          Todavía no hay entregables para este influencer.
        </p>
      ) : (
        <ul className={styles['entregables']}>
          {participacion.entregables.map((e) => (
            <li
              key={e.id}
              className={styles['entregable']}
              data-testid="contenido-entregable"
              data-deliverable-id={e.id}
              data-resumen={e.resumen}
              data-estado={e.estado}
            >
              <div className={styles['entregableTitulo']}>
                <a href={`${base}/${e.id}`} data-testid="contenido-entregable-enlace">
                  {e.nombre}
                </a>
                <span className={styles['etiquetas']}>
                  {e.estado === 'archived' && <span className="pill neutro">Archivado</span>}
                  <span
                    className={PILL_DE_RESUMEN[e.resumen] ?? 'pill neutro'}
                    data-testid="contenido-entregable-resumen"
                  >
                    {RESUMEN_DE_ENTREGABLE[e.resumen] ?? e.resumen}
                  </span>
                </span>
              </div>
              <div className={styles['meta']}>
                {e.plataforma !== undefined && <span>{etiquetaDePlataforma(e.plataforma)}</span>}
                {e.ultimaVersion !== undefined && (
                  <span data-testid="contenido-entregable-ultima">
                    Última: V{e.ultimaVersion.numero} ·{' '}
                    <span className={PILL_DE_VERSION[e.ultimaVersion.estado] ?? 'pill neutro'}>
                      {ESTADO_DE_VERSION[e.ultimaVersion.estado] ?? e.ultimaVersion.estado}
                    </span>
                    {e.ultimaVersion.fecha === undefined ? '' : ` · ${fecha(e.ultimaVersion.fecha)}`}
                  </span>
                )}
                {e.aprobadaVigente !== undefined && (
                  <span data-testid="contenido-entregable-vigente">
                    Aprobada vigente: V{e.aprobadaVigente.numero} · {fecha(e.aprobadaVigente.fecha)} ·{' '}
                    {e.aprobadaVigente.archivo}
                  </span>
                )}
                {e.ultimaVersion === undefined && <span>Sin guion todavía</span>}
              </div>
              {e.revision !== undefined && e.ultimaVersion !== undefined && (
                <div
                  className={styles['etiquetas']}
                  data-testid="contenido-entregable-revision"
                  data-vigencia={e.revision.vigencia}
                >
                  <span className={PILL_DE_VIGENCIA[e.revision.vigencia] ?? 'pill neutro'}>
                    {ETIQUETA_DE_VIGENCIA[e.revision.vigencia] ?? e.revision.vigencia}
                  </span>
                  {e.revision.tipo !== null && (
                    <span className={styles['itemMeta']}>
                      {TIPO_DE_REVISION[e.revision.tipo]}
                      {e.revision.briefNumero === null ? '' : ` · Brief V${e.revision.briefNumero}`}
                    </span>
                  )}
                  {e.revision.totalDeHallazgos > 0 && (
                    <span className={styles['itemMeta']}>
                      {e.revision.totalDeHallazgos} hallazgo{e.revision.totalDeHallazgos === 1 ? '' : 's'} (
                      {e.revision.hallazgos.alta} alta · {e.revision.hallazgos.media} media ·{' '}
                      {e.revision.hallazgos.baja} baja)
                    </span>
                  )}
                  {e.revision.cambiosSolicitados > 0 && (
                    <span className="pill warn">
                      {e.revision.cambiosSolicitados} cambio{e.revision.cambiosSolicitados === 1 ? '' : 's'}{' '}
                      solicitado{e.revision.cambiosSolicitados === 1 ? '' : 's'}
                    </span>
                  )}
                  {e.revision.propuestaDeAprobacionPendiente && (
                    <span className="pill curso" data-testid="contenido-entregable-propuesta">
                      Propuesta de aprobación pendiente
                    </span>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {puedeCrear && !retirada && (
        <FormularioCrearDeliverable
          campaignId={campaignId}
          participacionId={participacion.participacionId}
          influencerNombre={participacion.influencerNombre}
        />
      )}
    </section>
  );
}
