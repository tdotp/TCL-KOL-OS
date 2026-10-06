'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ReactNode } from 'react';
import styles from './contenido.module.css';

/**
 * Diálogo de confirmación accesible (alertdialog) de las decisiones de contenido: repite lo que se va a
 * hacer, con el texto exacto, antes de ejecutarlo. Foco inicial en «Cancelar», Tab y Shift+Tab circulan
 * DENTRO del diálogo (trampa de foco), Escape cierra (salvo en vuelo) y al cerrarse el foco vuelve al
 * disparador. Sin lógica de negocio: quien lo usa decide qué hace `onConfirmar`.
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
  const dialogo = useRef<HTMLDivElement>(null);
  // Refs: el efecto solo depende de `abierto` (un `onCancelar` nuevo en cada render no roba el foco).
  const pendienteRef = useRef(pendiente);
  pendienteRef.current = pendiente;
  const cancelarRef = useRef(onCancelar);
  cancelarRef.current = onCancelar;

  useEffect(() => {
    if (!abierto) return;
    // El elemento que abrió el diálogo: a él vuelve el foco al cerrarse (si sigue en la página).
    const disparador = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    botonCancelar.current?.focus();
    const alTeclear = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !pendienteRef.current) {
        cancelarRef.current();
        return;
      }
      if (e.key !== 'Tab') return;
      // Trampa de foco: solo los botones habilitados del diálogo; con todos deshabilitados (en vuelo) el
      // foco se queda en el propio diálogo.
      const raiz = dialogo.current;
      if (raiz === null) return;
      const enfocables = Array.from(raiz.querySelectorAll<HTMLElement>('button:not([disabled])'));
      const primero = enfocables[0];
      const ultimo = enfocables[enfocables.length - 1];
      if (primero === undefined || ultimo === undefined) {
        e.preventDefault();
        raiz.focus();
        return;
      }
      const actual = document.activeElement;
      if (!raiz.contains(actual)) {
        e.preventDefault();
        primero.focus();
      } else if (e.shiftKey && actual === primero) {
        e.preventDefault();
        ultimo.focus();
      } else if (!e.shiftKey && actual === ultimo) {
        e.preventDefault();
        primero.focus();
      }
    };
    document.addEventListener('keydown', alTeclear);
    return () => {
      document.removeEventListener('keydown', alTeclear);
      if (disparador !== null && disparador.isConnected && disparador !== document.body) {
        disparador.focus();
      }
    };
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
        ref={dialogo}
        tabIndex={-1}
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
