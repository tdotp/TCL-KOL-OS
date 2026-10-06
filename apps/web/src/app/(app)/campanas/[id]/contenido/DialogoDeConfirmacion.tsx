'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ReactNode } from 'react';
import styles from './contenido.module.css';

/**
 * Diálogo de confirmación accesible (alertdialog) de las decisiones de contenido: repite lo que se va a
 * hacer, con el texto exacto, antes de ejecutarlo. Foco inicial en «Cancelar», Escape cierra (salvo en
 * vuelo) y el foco vuelve al disparador. Sin lógica de negocio: quien lo usa decide qué hace `onConfirmar`.
 */
export function DialogoDeConfirmacion({
  abierto,
  titulo,
  textoConfirmar,
  pendiente,
  error,
  onConfirmar,
  onCancelar,
  idDePrueba,
  children,
}: {
  abierto: boolean;
  titulo: string;
  textoConfirmar: string;
  pendiente: boolean;
  error: string | undefined;
  onConfirmar: () => void;
  onCancelar: () => void;
  /** Prefijo de los `data-testid` (`<prefijo>-dialogo`, `-confirmar`, `-cancelar`, `-error`). */
  idDePrueba: string;
  children: ReactNode;
}) {
  const [montado, setMontado] = useState(false);
  useEffect(() => setMontado(true), []);
  const tituloId = useId();
  const detalleId = useId();
  const botonCancelar = useRef<HTMLButtonElement>(null);
  // Refs: el efecto solo depende de `abierto` (un `onCancelar` nuevo en cada render no roba el foco).
  const pendienteRef = useRef(pendiente);
  pendienteRef.current = pendiente;
  const cancelarRef = useRef(onCancelar);
  cancelarRef.current = onCancelar;

  useEffect(() => {
    if (!abierto) return;
    botonCancelar.current?.focus();
    const alTeclear = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !pendienteRef.current) cancelarRef.current();
    };
    document.addEventListener('keydown', alTeclear);
    return () => document.removeEventListener('keydown', alTeclear);
  }, [abierto]);

  // En el `body`: `.ui-enter` deja un `transform` en la página y un `position: fixed` dentro de ella ya no
  // se centra en la ventana sino en toda la página (el diálogo quedaría lejos de lo que ve la persona).
  if (!abierto || !montado) return null;
  return createPortal(
    <div
      className="confirm-backdrop"
      onClick={() => {
        if (!pendiente) onCancelar();
      }}
    >
      <div
        className={`confirm-dialog ${styles['dialogoAncho'] ?? ''}`}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={tituloId}
        aria-describedby={detalleId}
        data-testid={`${idDePrueba}-dialogo`}
        onClick={(e) => e.stopPropagation()}
      >
        <h3 id={tituloId}>{titulo}</h3>
        <div id={detalleId}>{children}</div>
        {error !== undefined && (
          <p className={styles['error']} role="alert" data-testid={`${idDePrueba}-error`}>
            {error}
          </p>
        )}
        <div className="row">
          <button
            ref={botonCancelar}
            type="button"
            className="btn"
            onClick={onCancelar}
            disabled={pendiente}
            data-testid={`${idDePrueba}-cancelar`}
          >
            Cancelar
          </button>
          <button
            type="button"
            className="btn pri"
            onClick={onConfirmar}
            disabled={pendiente}
            data-testid={`${idDePrueba}-confirmar`}
          >
            {pendiente ? 'Procesando…' : textoConfirmar}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
