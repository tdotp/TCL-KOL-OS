import { randomUUID } from 'node:crypto';
import type { VistaDeVersionElegida } from '@tcl-kol-os/db';
import { AccionesDeRevision } from './AccionesDeRevision';
import {
  ETIQUETA_DE_VIGENCIA,
  MOTIVO_DE_PRONTITUD,
  PILL_DE_VIGENCIA,
  TIPO_DE_REVISION,
  fecha,
  fechaHora,
} from './etiquetas';
import styles from './contenido.module.css';

/**
 * Estado de la REVISIÓN de la versión contra el Brief aprobado vigente (CURRENT / STALE / fallida) y las
 * acciones de revisión (solo Cuenta, solo versión abierta, solo campaña activa). Aprobar necesita una
 * revisión CURRENT: asistida por IA o humana, indistintamente.
 */
export function SeccionDeRevision({
  campaignId,
  version,
  puedeGestionar,
  briefVigenteNumero,
}: {
  campaignId: string;
  version: VistaDeVersionElegida;
  /** Rol con `script:manage` y campaña activa. */
  puedeGestionar: boolean;
  briefVigenteNumero: number | undefined;
}) {
  const r = version.revision;
  const mostrarAcciones = puedeGestionar && version.abierta;
  return (
    <section
      className="card"
      aria-labelledby="contenido-revision-titulo"
      data-testid="contenido-revision"
      data-vigencia={r.vigencia}
      data-tipo={r.tipo ?? 'ninguna'}
    >
      <div className={styles['seccionCabecera']}>
        <div>
          <div className="eyebrow">Revisión contra el Brief</div>
          <h2 id="contenido-revision-titulo" className="plain-heading">
            Estado de la revisión
          </h2>
        </div>
        <span
          className={PILL_DE_VIGENCIA[r.vigencia] ?? 'pill neutro'}
          data-testid="contenido-revision-vigencia"
        >
          {ETIQUETA_DE_VIGENCIA[r.vigencia] ?? r.vigencia}
        </span>
      </div>

      {r.tipo === null ? (
        <p className={styles['vacio']} data-testid="contenido-revision-ninguna">
          {r.briefVigente === null
            ? 'Todavía no existe un Brief aprobado para usar como documento rector.'
            : 'Esta versión todavía no se ha revisado contra el Brief aprobado vigente.'}
        </p>
      ) : (
        <dl className={styles['datos']}>
          <div>
            <dt>Tipo</dt>
            <dd data-testid="contenido-revision-tipo">{TIPO_DE_REVISION[r.tipo]}</dd>
          </div>
          <div>
            <dt>Revisada contra</dt>
            <dd data-testid="contenido-revision-brief">
              {r.briefAnalizado === null ? '—' : `Brief V${r.briefAnalizado.numero}`}
            </dd>
          </div>
          <div>
            <dt>Brief vigente</dt>
            <dd data-testid="contenido-revision-brief-vigente">
              {r.briefVigente === null ? '—' : `Brief V${r.briefVigente.numero}`}
            </dd>
          </div>
          <div>
            <dt>Fecha</dt>
            <dd>{fechaHora(r.fecha)}</dd>
          </div>
          {r.tipo === 'human' && (
            <div>
              <dt>Registrada por</dt>
              <dd data-testid="contenido-revision-autor">{r.autor ?? 'Persona de la agencia'}</dd>
            </div>
          )}
          {r.tipo === 'ai_assisted' && (
            <div>
              <dt>Hallazgos</dt>
              <dd>
                {r.totalDeHallazgos === 0
                  ? 'Ninguno'
                  : `${r.totalDeHallazgos} (${r.hallazgosPorSeveridad.alta} alta, ${r.hallazgosPorSeveridad.media} media, ${r.hallazgosPorSeveridad.baja} baja)`}
              </dd>
            </div>
          )}
        </dl>
      )}
      {r.tipo === 'human' && r.nota !== undefined && (
        <p className={styles['texto']} style={{ margin: '10px 0 0' }} data-testid="contenido-revision-nota">
          Nota de la revisión: {r.nota}
        </p>
      )}

      {r.vigencia === 'stale' && (
        <div
          className="aviso"
          role="status"
          style={{ marginTop: 12, marginBottom: 0 }}
          data-testid="contenido-revision-stale"
        >
          <strong>Revisión desactualizada</strong>
          Se hizo contra el Brief V{r.briefAnalizado?.numero ?? '?'} y el Brief aprobado vigente es hoy V
          {r.briefVigente?.numero ?? '?'}. Sigue visible, pero para aprobar hay que revisar el guion de nuevo
          contra el Brief vigente.
        </div>
      )}
      {r.ultimoIntento !== undefined && r.ultimoIntento.estado === 'failed' && (
        <div
          className="aviso error"
          role="status"
          style={{ marginTop: 12, marginBottom: 0 }}
          data-testid="contenido-revision-fallo"
        >
          <strong>El último análisis no se pudo completar</strong>
          {fecha(r.ultimoIntento.fecha)}. La IA nunca es requisito: puedes revisar el guion manualmente o
          reintentar el análisis.
        </div>
      )}
      {r.ultimoIntento !== undefined &&
        (r.ultimoIntento.estado === 'running' || r.ultimoIntento.estado === 'queued') && (
          <div
            className="aviso"
            role="status"
            style={{ marginTop: 12, marginBottom: 0 }}
            data-testid="contenido-revision-en-curso"
          >
            <strong>Hay un análisis en curso</strong>
            Recarga la página en unos segundos para ver el resultado.
          </div>
        )}
      {r.vigencia === 'failed' && r.ultimoIntento === undefined && (
        <div
          className="aviso error"
          role="status"
          style={{ marginTop: 12, marginBottom: 0 }}
          data-testid="contenido-revision-fallo"
        >
          <strong>El análisis no se pudo completar</strong>
          La IA nunca es requisito: puedes revisar el guion manualmente.
        </div>
      )}

      {mostrarAcciones && (
        <div style={{ marginTop: 14 }}>
          <AccionesDeRevision
            campaignId={campaignId}
            versionId={version.id}
            numeroDeVersion={version.numero}
            hayRevision={r.tipo === 'ai_assisted' && r.vigencia === 'current'}
            prontitud={r.prontitud}
            briefVigenteNumero={briefVigenteNumero}
            huellaDelBrief={r.huellaDelBrief}
            claveDeIdempotencia={`ui:${randomUUID()}`}
          />
        </div>
      )}
      {!mostrarAcciones && version.abierta && r.prontitud !== undefined && r.prontitud !== 'ready' && (
        <p className={styles['nota']} data-testid="contenido-analisis-motivo-lectura">
          {MOTIVO_DE_PRONTITUD[r.prontitud]}
        </p>
      )}
    </section>
  );
}
