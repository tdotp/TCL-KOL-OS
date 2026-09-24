'use client';

import { useRef, useState } from 'react';

/**
 * Confirmación de acción irreversible (rediseño, artboard 1d) — reservada
 * para las cuatro acciones que de verdad no se pueden deshacer: archivar
 * campaña, aprobar internamente, aprobar como cliente, crear nueva versión.
 * Dice qué cambia, en concreto — nunca un "¿estás seguro?" genérico.
 *
 * Reemplaza el `<button type="submit">` dentro de un `<form action={...}>`
 * existente: intercepta el clic, muestra el diálogo, y solo si se confirma
 * dispara el envío real del formulario que ya lo envuelve. La acción de
 * servidor no cambia — esto es una capa de confirmación, no una redefinición
 * de la mutación.
 */
export function ConfirmarAccion({
  etiqueta,
  titulo,
  consecuencias,
  textoConfirmar,
  peligro = false,
  className,
  style,
}: {
  /** Texto del botón disparador (antes de confirmar). */
  etiqueta: string;
  /** Pregunta directa, en el momento del clic — nunca genérica. */
  titulo: string;
  /** Qué cambia en concreto, en una lista corta y verificable. */
  consecuencias: readonly string[];
  textoConfirmar: string;
  /** Solo la acción destructiva (archivar) usa el botón rojo. */
  peligro?: boolean;
  className?: string;
  style?: React.CSSProperties;
}) {
  const [abierto, setAbierto] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);

  return (
    <>
      <button
        type="button"
        className={className ?? 'btn pri'}
        style={style}
        onClick={() => setAbierto(true)}
        ref={btnRef}
      >
        {etiqueta}
      </button>

      {abierto && (
        <div className="confirm-backdrop" onClick={() => setAbierto(false)}>
          <div
            className="confirm-dialog"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="confirm-titulo"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 id="confirm-titulo">{titulo}</h3>
            <ul>
              {consecuencias.map((c) => (
                <li key={c}>{c}</li>
              ))}
            </ul>
            <div className="row">
              <button type="button" className="btn" onClick={() => setAbierto(false)}>
                Cancelar
              </button>
              <button
                type="button"
                className={`btn ${peligro ? 'peligro' : 'pri'}`}
                onClick={() => {
                  setAbierto(false);
                  btnRef.current?.form?.requestSubmit();
                }}
              >
                {textoConfirmar}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
