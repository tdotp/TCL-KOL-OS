'use client';

import { useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { anadirComentarioDeContenido, solicitarCambiosDeContenido } from '@/lib/contenido-actions';
import { DialogoDeConfirmacion } from './DialogoDeConfirmacion';
import styles from './contenido.module.css';

/**
 * Comentario editorial y cambios solicitados de SmartPR sobre una versión abierta. Son notas de una
 * PERSONA (el autor es la sesión; el canal, `ui`): no son hallazgos del análisis. Pedir cambios cierra la
 * versión (estado terminal): reabrir es subir la versión siguiente; por eso pide confirmación.
 */
export function FormulariosDeComentario({
  campaignId,
  versionId,
  numeroDeVersion,
}: {
  campaignId: string;
  versionId: string;
  numeroDeVersion: number;
}) {
  const router = useRouter();
  const [pendiente, iniciar] = useTransition();
  const enVuelo = useRef(false);

  // Comentario editorial
  const [texto, setTexto] = useState('');
  const [errorDeComentario, setErrorDeComentario] = useState<string | undefined>(undefined);

  // Cambios solicitados (con confirmación)
  const [cambios, setCambios] = useState('');
  const [nota, setNota] = useState('');
  const [dialogo, setDialogo] = useState(false);
  const [errorDeCambios, setErrorDeCambios] = useState<string | undefined>(undefined);

  const comentar = (e: React.FormEvent) => {
    e.preventDefault();
    if (enVuelo.current || texto.trim() === '') return;
    enVuelo.current = true;
    setErrorDeComentario(undefined);
    iniciar(async () => {
      try {
        const r = await anadirComentarioDeContenido(campaignId, versionId, texto);
        if (r.ok) setTexto('');
        else setErrorDeComentario(r.error);
        router.refresh();
      } finally {
        enVuelo.current = false;
      }
    });
  };

  const pedirCambios = () => {
    if (enVuelo.current) return;
    enVuelo.current = true;
    setErrorDeCambios(undefined);
    iniciar(async () => {
      try {
        const r = await solicitarCambiosDeContenido(
          campaignId,
          versionId,
          cambios,
          nota.trim() === '' ? undefined : nota,
        );
        if (r.ok) {
          setDialogo(false);
          setCambios('');
          setNota('');
        } else {
          setErrorDeCambios(r.error);
        }
        router.refresh();
      } finally {
        enVuelo.current = false;
      }
    });
  };

  const lineas = cambios
    .split(/\r?\n/u)
    .map((l) => l.trim())
    .filter((l) => l !== '').length;

  return (
    <div className={styles['formulario']} data-testid="contenido-formularios-comentario">
      <form className={styles['formulario']} onSubmit={comentar} data-testid="contenido-comentario-form">
        <label>
          Añadir un comentario a la V{numeroDeVersion}
          <textarea
            value={texto}
            onChange={(e) => setTexto(e.target.value)}
            maxLength={2000}
            rows={3}
            placeholder="Una observación editorial para el equipo"
            data-testid="contenido-comentario-texto"
          />
        </label>
        {errorDeComentario !== undefined && (
          <p className={styles['error']} role="alert" data-testid="contenido-comentario-error">
            {errorDeComentario}
          </p>
        )}
        <div className={styles['acciones']}>
          <button
            type="submit"
            className="btn"
            disabled={pendiente || texto.trim() === ''}
            data-testid="contenido-comentario-enviar"
          >
            Añadir comentario
          </button>
        </div>
      </form>

      <form
        className={styles['formulario']}
        onSubmit={(e) => {
          e.preventDefault();
          if (lineas > 0) {
            setErrorDeCambios(undefined);
            setDialogo(true);
          }
        }}
        data-testid="contenido-cambios-form"
      >
        <label>
          Solicitar cambios (uno por línea)
          <textarea
            value={cambios}
            onChange={(e) => setCambios(e.target.value)}
            rows={3}
            placeholder={'Añadir la mención del hashtag\nCerrar con la invitación a la tienda'}
            data-testid="contenido-cambios-texto"
          />
        </label>
        <label>
          Nota (opcional)
          <textarea
            value={nota}
            onChange={(e) => setNota(e.target.value)}
            maxLength={2000}
            rows={2}
            data-testid="contenido-cambios-nota"
          />
        </label>
        <div className={styles['acciones']}>
          <button
            type="submit"
            className="btn"
            disabled={pendiente || lineas === 0}
            data-testid="contenido-cambios-enviar"
          >
            Solicitar cambios
          </button>
        </div>
      </form>

      <DialogoDeConfirmacion
        abierto={dialogo}
        titulo={`Solicitar cambios sobre la V${numeroDeVersion}`}
        textoConfirmar="Sí, solicitar cambios"
        pendiente={pendiente}
        error={errorDeCambios}
        onConfirmar={pedirCambios}
        onCancelar={() => setDialogo(false)}
        idDePrueba="contenido-cambios"
      >
        <ul className={styles['dialogoLista']}>
          <li>
            Se registran {lineas} cambio{lineas === 1 ? '' : 's'} pedido{lineas === 1 ? '' : 's'} a tu nombre,
            desde la interfaz.
          </li>
          <li>
            La V{numeroDeVersion} queda en «Cambios solicitados»: es un estado final. Para reabrir el trabajo
            se sube la versión siguiente del guion.
          </li>
          <li>No es una aprobación ni rechaza nada más.</li>
        </ul>
      </DialogoDeConfirmacion>
    </div>
  );
}
