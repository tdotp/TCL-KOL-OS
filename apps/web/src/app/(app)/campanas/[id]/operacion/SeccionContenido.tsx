import type { DetalleDeContenido } from '@tcl-kol-os/db';
import { PILL_DE_RESUMEN, RESUMEN_DE_ENTREGABLE, etiquetaDePlataforma } from '../contenido/etiquetas';
import { ESTADO_DE_CONTENIDO, PILL_DE_CONTENIDO } from './etiquetas';
import styles from './operacion.module.css';

/**
 * Contenido de la participación: estado de guion y entregables, SOLO LECTURA. No hay aquí ninguna acción de
 * revisión ni de aprobación: eso vive en `/contenido`, a donde apunta el enlace.
 */
export function SeccionContenido({
  campaignId,
  participacionId,
  contenido,
}: {
  campaignId: string;
  participacionId: string;
  contenido: DetalleDeContenido;
}) {
  return (
    <section
      className={`card ${styles['seccion'] ?? ''}`}
      data-testid="seccion-contenido"
      aria-labelledby="titulo-contenido"
    >
      <div className={styles['seccionCabecera']}>
        <h2 id="titulo-contenido">Contenido</h2>
        <span
          className={PILL_DE_CONTENIDO[contenido.estado] ?? 'pill neutro'}
          data-testid="contenido-estado"
          data-valor={contenido.estado}
        >
          {ESTADO_DE_CONTENIDO[contenido.estado] ?? contenido.estado}
        </span>
      </div>
      {contenido.items.length === 0 ? (
        <p className={styles['vacio']} data-testid="contenido-vacio">
          Todavía no hay entregables para este influencer.
        </p>
      ) : (
        <ul className={styles['lista']} data-testid="contenido-entregables">
          {contenido.items.map((e) => (
            <li
              key={e.id}
              className={styles['item']}
              data-testid="contenido-entregable"
              data-estado={e.estado}
            >
              <div className={styles['itemCabecera']}>
                <strong>{e.etiqueta}</strong>
                <span className={PILL_DE_RESUMEN[e.resumen] ?? 'pill neutro'}>
                  {RESUMEN_DE_ENTREGABLE[e.resumen] ?? e.resumen}
                </span>
              </div>
              <div className={styles['itemMeta']}>
                {e.plataforma !== null ? `${etiquetaDePlataforma(e.plataforma) ?? e.plataforma} · ` : ''}
                {e.estado === 'archived' ? 'Archivado · ' : ''}
                {e.ultimaVersion !== null ? `Última: V${e.ultimaVersion.numero}` : 'Sin guion todavía'}
                {e.aprobadaVigente !== null ? ` · Aprobada vigente: V${e.aprobadaVigente.numero}` : ''}
              </div>
            </li>
          ))}
        </ul>
      )}
      <p className={styles['itemMeta']}>
        <a href={`/campanas/${campaignId}/contenido/${participacionId}`} data-testid="contenido-enlace">
          Ver guiones y entregables
        </a>
      </p>
    </section>
  );
}
