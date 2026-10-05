'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import type { VistaDeRun } from '@tcl-kol-os/db';
import { cancelarRunDeChat, reintentarRunDeChat } from '@/lib/chat-actions';
import { codigoVisible, mensajeDeFalloDeRun } from './etiquetas';
import styles from './chat.module.css';

/**
 * Estado del turno más reciente que NO terminó bien (o que sigue en curso): en cola,
 * pensando, herramienta activa (por su etiqueta en español), cancelando, fallido (con código
 * sanitizado) o cancelado. Un turno completado no muestra nada (ya está la respuesta).
 * `aria-live="polite"` anuncia los cambios a lectores de pantalla sin robar el foco.
 */
export function EstadoDeRun({
  campaignId,
  run,
  etiquetaActiva,
}: {
  campaignId: string;
  run: VistaDeRun;
  /** Etiqueta de la herramienta en curso, si la hay. */
  etiquetaActiva: string | undefined;
}) {
  const router = useRouter();
  const [pendiente, iniciar] = useTransition();
  const [error, setError] = useState<string | undefined>(undefined);

  const activo = run.status === 'queued' || run.status === 'running';
  const codigo = codigoVisible(run.errorCode);

  const cancelar = () => {
    setError(undefined);
    iniciar(async () => {
      const r = await cancelarRunDeChat(campaignId, run.id);
      if (!r.ok) setError(r.error);
      router.refresh();
    });
  };
  const reintentar = () => {
    setError(undefined);
    iniciar(async () => {
      const r = await reintentarRunDeChat(campaignId, run.userMessageId);
      if (!r.ok) setError(r.error);
      router.refresh();
    });
  };

  let texto: string;
  if (run.status === 'queued') texto = run.cancelRequested ? 'Cancelando…' : 'En cola…';
  else if (run.status === 'running') {
    texto = run.cancelRequested
      ? 'Cancelando…'
      : etiquetaActiva !== undefined
        ? `${etiquetaActiva}…`
        : 'Pensando…';
  } else if (run.status === 'failed') texto = mensajeDeFalloDeRun(run.errorCode);
  else if (run.status === 'cancelled') texto = 'Turno cancelado.';
  else return null;

  return (
    <div
      className={styles.estado}
      role="status"
      aria-live="polite"
      data-testid="chat-run-status"
      data-status={run.status}
      data-stale={run.stale ? 'true' : 'false'}
    >
      {activo && <span className={styles.pulso} aria-hidden="true" />}
      <span data-testid="chat-run-status-text">{texto}</span>
      {activo && run.stale && (
        <span className={styles.estadoCodigo}>Parece detenido; se cerrará solo en unos minutos.</span>
      )}
      {run.status === 'failed' && codigo !== undefined && (
        <span className={styles.estadoCodigo} data-testid="chat-run-error-code">
          Código: {codigo}
        </span>
      )}
      {activo && run.canCancel && (
        <button
          type="button"
          className="btn mini"
          onClick={cancelar}
          disabled={pendiente}
          data-testid="chat-run-cancel"
        >
          Cancelar
        </button>
      )}
      {run.canRetry && (
        <button
          type="button"
          className="btn mini pri"
          onClick={reintentar}
          disabled={pendiente}
          data-testid="chat-run-retry"
        >
          Reintentar
        </button>
      )}
      {error !== undefined && (
        <p className={styles.error} role="alert" data-testid="chat-run-action-error">
          {error}
        </p>
      )}
    </div>
  );
}
