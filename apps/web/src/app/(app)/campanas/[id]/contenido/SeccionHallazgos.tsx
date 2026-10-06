import type { VistaDeHallazgoDelBrief, VistaDeRevisionDeVersion } from '@tcl-kol-os/db';
import {
  BASE_DE_HALLAZGO,
  CATEGORIA_DE_HALLAZGO,
  CRITICIDAD,
  ESTADO_DE_AFIRMACION,
  ETIQUETA_DE_VIGENCIA,
  PILL_DE_SEVERIDAD,
  PILL_DE_VIGENCIA,
  RELACION_DE_EVIDENCIA,
  TIPO_DE_REVISION,
  fecha,
} from './etiquetas';
import styles from './contenido.module.css';

/**
 * HALLAZGOS DEL BRIEF: observaciones del análisis asistido contra el Brief aprobado. Son DERIVADAS (no
 * las escribió una persona) y NO son comentarios: van en su propia sección, con su propio origen
 * (`data-origen="brief"`). Informan; no bloquean ni aprueban. Todo texto (descripción, citas, valores del
 * Brief) es no confiable: se pinta como texto plano, nunca como HTML.
 */
export function SeccionHallazgos({
  campaignId,
  revision,
  hallazgos,
}: {
  campaignId: string;
  revision: VistaDeRevisionDeVersion;
  hallazgos: readonly VistaDeHallazgoDelBrief[];
}) {
  const asistida = revision.tipo === 'ai_assisted';
  return (
    <section
      className={`card ${styles['seccionBrief'] ?? ''}`}
      aria-labelledby="contenido-hallazgos-titulo"
      data-testid="contenido-hallazgos"
      data-origen="brief"
      data-vigencia={revision.vigencia}
    >
      <div className={styles['seccionCabecera']}>
        <div>
          <div className="eyebrow">Brief · automático</div>
          <h2 id="contenido-hallazgos-titulo" className="plain-heading">
            Hallazgos del Brief
          </h2>
          <p className={styles['nota']} style={{ margin: '4px 0 0' }}>
            Observaciones derivadas del análisis asistido: no las escribió una persona y no aprueban ni
            bloquean nada.
          </p>
        </div>
        <div className={styles['etiquetas']}>
          {asistida && revision.briefAnalizado !== null && (
            <span className="pill neutro" data-testid="contenido-hallazgos-brief">
              Analizado contra Brief V{revision.briefAnalizado.numero}
            </span>
          )}
          {asistida && (
            <span
              className={PILL_DE_VIGENCIA[revision.vigencia] ?? 'pill neutro'}
              data-testid="contenido-hallazgos-vigencia"
            >
              {ETIQUETA_DE_VIGENCIA[revision.vigencia] ?? revision.vigencia}
              {revision.vigencia === 'stale' && revision.briefVigente !== null
                ? ` · el Brief vigente es V${revision.briefVigente.numero}`
                : ''}
            </span>
          )}
        </div>
      </div>

      {revision.tipo === 'human' && (
        <p className={styles['vacio']} data-testid="contenido-hallazgos-humana">
          La revisión vigente es humana ({TIPO_DE_REVISION['human']}): no genera hallazgos. Puedes solicitar
          un análisis asistido para obtener observaciones.
        </p>
      )}
      {revision.tipo === null && (
        <p className={styles['vacio']} data-testid="contenido-hallazgos-vacio">
          Todavía no hay un análisis de esta versión contra el Brief.
        </p>
      )}
      {asistida && hallazgos.length === 0 && (
        <p className={styles['vacio']} data-testid="contenido-hallazgos-ninguno">
          El análisis no encontró observaciones
          {revision.fecha === undefined ? '' : ` (${fecha(revision.fecha)})`}.
        </p>
      )}

      {hallazgos.length > 0 && (
        <ul className={styles['lista']}>
          {hallazgos.map((h) => (
            <li
              key={h.id}
              className={`${styles['item'] ?? ''} ${styles['itemBrief'] ?? ''}`}
              data-testid="contenido-hallazgo"
              data-origen={h.origen}
              data-severidad={h.severidad}
              data-categoria={h.categoria}
            >
              <div className={styles['itemCabecera']}>
                <span className={PILL_DE_SEVERIDAD[h.severidad] ?? 'pill neutro'}>
                  Severidad {h.severidad}
                </span>
                <strong>{CATEGORIA_DE_HALLAZGO[h.categoria] ?? h.categoria}</strong>
                <span className={styles['itemMeta']}>
                  {BASE_DE_HALLAZGO[h.base] ?? h.base}
                  {h.estadoDeLaAfirmacion === undefined
                    ? ''
                    : ` · ${ESTADO_DE_AFIRMACION[h.estadoDeLaAfirmacion] ?? h.estadoDeLaAfirmacion}`}
                </span>
              </div>
              <p
                className={styles['texto']}
                style={{ margin: 0 }}
                data-testid="contenido-hallazgo-descripcion"
              >
                {h.descripcion}
              </p>

              {h.requisitosDelBrief.length > 0 && (
                <ul className={styles['referencias']} aria-label="Requisitos del Brief a los que se refiere">
                  {h.requisitosDelBrief.map((r) => (
                    <li
                      key={`${r.claveDelCampo}-${r.elemento ?? ''}-${r.valor}`}
                      className={styles['referencia']}
                      data-testid="contenido-hallazgo-requisito"
                    >
                      <span className={styles['referenciaTitulo']}>
                        Requisito del Brief · {r.etiquetaDelCampo}
                        {r.elemento === undefined ? '' : ` (elemento ${r.elemento + 1})`} ·{' '}
                        {CRITICIDAD[r.criticidad] ?? r.criticidad}
                      </span>
                      <span className={styles['texto']}>{r.valor}</span>
                      {r.evidencias.map((e) => (
                        <span
                          key={`${e.sourceId}-${e.cita}`}
                          className={styles['texto']}
                          data-testid="contenido-hallazgo-evidencia"
                        >
                          Evidencia ({RELACION_DE_EVIDENCIA[e.relacion] ?? e.relacion}): <q>{e.cita}</q> —{' '}
                          <a href={`/campanas/${campaignId}/fuentes/${e.sourceId}`}>{e.archivo}</a>
                          {e.localizador === undefined ? '' : `, ${e.localizador}`}
                        </span>
                      ))}
                    </li>
                  ))}
                </ul>
              )}

              {h.citasDelGuion.length > 0 && (
                <ul className={styles['referencias']} aria-label="Citas del guion">
                  {h.citasDelGuion.map((c) => (
                    <li
                      key={`${c.sourceId}-${c.fragmento}-${c.cita}`}
                      className={styles['referencia']}
                      data-testid="contenido-hallazgo-cita"
                    >
                      <span className={styles['referenciaTitulo']}>
                        Cita del guion{c.localizador === undefined ? '' : ` · ${c.localizador}`}
                      </span>
                      <blockquote className={`${styles['cita'] ?? ''} ${styles['texto'] ?? ''}`}>
                        {c.cita}
                      </blockquote>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
