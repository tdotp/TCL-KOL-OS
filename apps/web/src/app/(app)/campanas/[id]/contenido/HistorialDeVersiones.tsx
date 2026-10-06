import type { VistaDeVersionEnHistorial } from '@tcl-kol-os/db';
import { ESTADO_DE_VERSION, PILL_DE_VERSION, fecha } from './etiquetas';
import styles from './contenido.module.css';

/**
 * Historial V1…Vn de un entregable (la más nueva primero). Cada versión se conserva intacta: nunca se
 * sobrescribe. Insignias «Última» y «Aprobada vigente» / «Aprobada · reemplazada por Vn».
 */
export function HistorialDeVersiones({
  base,
  versiones,
  elegida,
}: {
  /** `/campanas/{id}/contenido/{participacionId}/{deliverableId}`. */
  base: string;
  versiones: readonly VistaDeVersionEnHistorial[];
  elegida: number | undefined;
}) {
  if (versiones.length === 0) {
    return (
      <p className={styles['vacio']} data-testid="contenido-historial-vacio">
        Todavía no hay versiones. Sube el primer guion para empezar.
      </p>
    );
  }
  return (
    <ol className={styles['historial']} aria-label="Versiones del guion" data-testid="contenido-historial">
      {versiones.map((v) => (
        <li key={v.id}>
          <a
            className={`${styles['version'] ?? ''} ${v.numero === elegida ? (styles['versionElegida'] ?? '') : ''}`}
            href={`${base}?v=${v.numero}`}
            aria-current={v.numero === elegida ? 'true' : undefined}
            data-testid="contenido-version"
            data-version={v.numero}
            data-estado={v.estado}
            data-es-ultima={String(v.esUltima)}
            data-es-aprobada-vigente={String(v.esAprobadaVigente)}
          >
            <span className={styles['versionTitulo']}>
              V{v.numero}
              <span className={PILL_DE_VERSION[v.estado] ?? 'pill neutro'}>
                {ESTADO_DE_VERSION[v.estado] ?? v.estado}
              </span>
            </span>
            <span className={styles['etiquetas']}>
              {v.esUltima && (
                <span className="pill curso" data-testid="contenido-badge-ultima">
                  Última
                </span>
              )}
              {v.esAprobadaVigente && (
                <span className="pill ok" data-testid="contenido-badge-vigente">
                  Aprobada vigente
                </span>
              )}
              {!v.esAprobadaVigente && v.aprobadaAlgunaVez && (
                <span className="pill neutro" data-testid="contenido-badge-reemplazada">
                  Aprobada · reemplazada por V{v.reemplazadaPor ?? '?'}
                </span>
              )}
              {!v.aprobadaAlgunaVez && v.reemplazadaPor !== undefined && (
                <span className="pill neutro" data-testid="contenido-badge-reemplazada">
                  Reemplazada por V{v.reemplazadaPor}
                </span>
              )}
            </span>
            <span className={styles['versionArchivo']}>
              {fecha(v.fecha)} · {v.archivo}
            </span>
          </a>
        </li>
      ))}
    </ol>
  );
}
