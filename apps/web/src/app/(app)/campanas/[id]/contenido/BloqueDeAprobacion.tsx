'use client';

import { useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import type { VistaDeEvaluacionDeAprobacion } from '@tcl-kol-os/db';
import { aprobarVersionDeGuion } from '@/lib/contenido-actions';
import { DialogoDeConfirmacion } from './DialogoDeConfirmacion';
import { TIPO_DE_REVISION, fecha, huellaCorta } from './etiquetas';
import styles from './contenido.module.css';

/**
 * Aprobar una versión de guion: decisión HUMANA y crítica. El botón existe SOLO para quien tiene
 * `script:approve` (el servidor también lo exige) y solo si la evaluación dice que es elegible. El diálogo
 * repite lo que la persona va a aprobar —Brief gobernante, revisión, hallazgos abiertos, advertencias,
 * qué versión reemplaza— y devuelve la huella de ESA evaluación (`huellaVista`): si algo cambió, el
 * servidor responde `PROPOSAL_STALE` y no aprueba. Los hallazgos no bloquean: informan.
 */
export function BloqueDeAprobacion({
  campaignId,
  versionId,
  numeroDeVersion,
  entregable,
  influencer,
  evaluacion,
  /** El rol tiene `script:approve` (admin, director). Sin él no hay controles de aprobación. */
  puedeAprobar,
  /** La campaña está activa (si no, solo lectura). */
  campanaActiva,
}: {
  campaignId: string;
  versionId: string;
  numeroDeVersion: number;
  /** Nombre del entregable y del influencer: el diálogo dice QUÉ se aprueba, de quién. */
  entregable: string;
  influencer: string;
  evaluacion: VistaDeEvaluacionDeAprobacion;
  puedeAprobar: boolean;
  campanaActiva: boolean;
}) {
  const router = useRouter();
  const [pendiente, iniciar] = useTransition();
  const [abierto, setAbierto] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const enVuelo = useRef(false);

  const aprobar = () => {
    if (enVuelo.current) return; // doble clic: una sola aprobación
    enVuelo.current = true;
    setError(undefined);
    iniciar(async () => {
      try {
        // La huella es la de la evaluación que ESTA persona vio al abrir el diálogo.
        const r = await aprobarVersionDeGuion(campaignId, versionId, evaluacion.huella);
        if (r.ok) setAbierto(false);
        else setError(r.error);
        router.refresh();
      } finally {
        enVuelo.current = false;
      }
    });
  };

  const h = evaluacion.hallazgosAbiertos;
  return (
    <div
      className={styles['formulario']}
      data-testid="contenido-aprobacion"
      data-elegible={String(evaluacion.elegible)}
    >
      {!evaluacion.elegible && (
        <div className="aviso" role="status" data-testid="contenido-aprobacion-bloqueos">
          <strong>Todavía no se puede aprobar</strong>
          <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
            {evaluacion.bloqueos.map((b) => (
              <li key={`${b.codigo}-${b.razon ?? ''}-${b.mensaje}`}>{b.mensaje}</li>
            ))}
          </ul>
        </div>
      )}

      {evaluacion.elegible && (
        <dl className={styles['datos']}>
          <div>
            <dt>Brief gobernante</dt>
            <dd data-testid="contenido-aprobacion-brief">
              {evaluacion.briefGobernante === null ? '—' : `Brief V${evaluacion.briefGobernante.numero}`}
            </dd>
          </div>
          <div>
            <dt>Revisión</dt>
            <dd>
              {evaluacion.revision === null ? '—' : TIPO_DE_REVISION[evaluacion.revision.tipo]}
              {evaluacion.revision?.fecha != null ? ` · ${fecha(evaluacion.revision.fecha)}` : ''}
            </dd>
          </div>
          <div>
            <dt>Hallazgos abiertos</dt>
            <dd>
              {h.total === 0 ? 'Ninguno' : `${h.total} (${h.alta} alta, ${h.media} media, ${h.baja} baja)`}
            </dd>
          </div>
          <div>
            <dt>Comentarios</dt>
            <dd>{evaluacion.comentarios}</dd>
          </div>
        </dl>
      )}

      {evaluacion.elegible && evaluacion.advertencias.length > 0 && (
        <ul className={styles['dialogoAvisos']} data-testid="contenido-aprobacion-advertencias">
          {evaluacion.advertencias.map((a) => (
            <li key={a}>{a}</li>
          ))}
        </ul>
      )}

      {puedeAprobar && campanaActiva && evaluacion.elegible && (
        <div className={styles['acciones']}>
          <button
            type="button"
            className="btn pri"
            onClick={() => {
              setError(undefined);
              setAbierto(true);
            }}
            disabled={pendiente}
            data-testid="contenido-aprobar"
          >
            Aprobar versión
          </button>
        </div>
      )}
      {!puedeAprobar && (
        <p className={styles['nota']} style={{ margin: 0 }} data-testid="contenido-aprobacion-sin-permiso">
          La aprobación de un guion la toma dirección o administración. Puedes preparar la revisión y pedirle
          al asistente que la proponga.
        </p>
      )}
      {error !== undefined && !abierto && (
        <p className={styles['error']} role="alert" data-testid="contenido-aprobar-error">
          {error}
        </p>
      )}

      <DialogoDeConfirmacion
        abierto={abierto}
        titulo={`Aprobar la versión V${numeroDeVersion}`}
        textoConfirmar="Sí, aprobar"
        pendiente={pendiente}
        error={error}
        onConfirmar={aprobar}
        onCancelar={() => setAbierto(false)}
        idDePrueba="contenido-aprobar"
      >
        <ul className={styles['dialogoLista']}>
          <li data-testid="contenido-aprobar-dialogo-que">
            Guion «{entregable}» de {influencer}, versión V{numeroDeVersion}.
          </li>
          <li data-testid="contenido-aprobar-dialogo-brief">
            Brief gobernante:{' '}
            {evaluacion.briefGobernante === null ? '—' : `Brief V${evaluacion.briefGobernante.numero}`}
          </li>
          <li>
            Revisión: {evaluacion.revision === null ? '—' : TIPO_DE_REVISION[evaluacion.revision.tipo]}
            {evaluacion.revision?.fecha != null ? `, ${fecha(evaluacion.revision.fecha)}` : ''}
          </li>
          <li data-testid="contenido-aprobar-dialogo-hallazgos">
            Hallazgos abiertos:{' '}
            {h.total === 0 ? 'ninguno' : `${h.total} (${h.alta} alta, ${h.media} media, ${h.baja} baja)`}
          </li>
          <li>Comentarios de revisión: {evaluacion.comentarios}</li>
          {evaluacion.reemplaza !== null && (
            <li data-testid="contenido-aprobar-dialogo-reemplaza">
              Reemplaza a la versión V{evaluacion.reemplaza.numero}, que seguirá en el historial.
            </li>
          )}
          <li>Queda registrada a tu nombre, desde la interfaz. La versión no se expone a TCL.</li>
          <li>
            Huella de lo que ves:{' '}
            <code className={styles['huella']} data-testid="contenido-aprobar-huella">
              {huellaCorta(evaluacion.huella)}
            </code>
          </li>
        </ul>
        {evaluacion.advertencias.length > 0 && (
          <ul className={styles['dialogoAvisos']} data-testid="contenido-aprobar-dialogo-advertencias">
            {evaluacion.advertencias.map((a) => (
              <li key={a}>{a}</li>
            ))}
          </ul>
        )}
      </DialogoDeConfirmacion>
    </div>
  );
}
