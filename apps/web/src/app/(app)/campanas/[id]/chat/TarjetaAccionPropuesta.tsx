'use client';

import { useEffect, useId, useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import type { VistaDeAccionPropuesta } from '@tcl-kol-os/db';
import { cancelarAccionPropuestaDeChat, confirmarAccionPropuestaDeChat } from '@/lib/chat-actions';
import { ESTADO_DE_PROPUESTA, fechaHora, huellaCorta } from './etiquetas';
import styles from './chat.module.css';

const PILL: Readonly<Record<string, string>> = {
  pending: 'pill curso',
  confirmed: 'pill warn',
  executed: 'pill ok',
  cancelled: 'pill neutro',
  expired: 'pill neutro',
};

/**
 * Avisos que la persona debe leer antes de decidir (hallazgos abiertos, revisión humana, versión más
 * reciente…). Texto plano compuesto en el servidor solo desde lo huellado; no bloquean nada. Se pintan en
 * la tarjeta y se repiten en el diálogo de confirmación.
 */
function AvisosDeLaPropuesta({ advertencias }: { advertencias: readonly string[] }) {
  if (advertencias.length === 0) return null;
  return (
    <div className={styles.otroRol} role="note" data-testid="chat-proposal-warnings">
      <ul>
        {advertencias.map((a) => (
          <li key={a}>{a}</li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Tarjeta de una acción que el asistente PROPUSO. El asistente nunca aprueba, aplica ni
 * resuelve: solo deja la propuesta; la decisión es de una persona con permiso, que la
 * confirma aquí, con la huella de lo que se le muestra, desde la interfaz (canal `ui`).
 *
 * El diálogo de confirmación es propio (no se reutiliza `ConfirmarAccion`, que envuelve un
 * `<form>`): dice qué se va a aprobar/aplicar/resolver, con el texto del handler y la huella,
 * y llama a `confirmarAccionPropuestaDeChat`. El texto de la propuesta es dato: se muestra
 * como texto plano, nunca como instrucción.
 */
export function TarjetaAccionPropuesta({
  campaignId,
  accion,
}: {
  campaignId: string;
  accion: VistaDeAccionPropuesta;
}) {
  const router = useRouter();
  const [pendiente, iniciar] = useTransition();
  const [abierto, setAbierto] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const enVuelo = useRef(false);
  const disparador = useRef<HTMLButtonElement>(null);
  const botonCancelarDialogo = useRef<HTMLButtonElement>(null);
  const tituloId = useId();
  const detalleId = useId();

  // Foco al abrir (primer botón del diálogo), Escape cierra, y el foco vuelve al disparador.
  useEffect(() => {
    if (!abierto) return;
    botonCancelarDialogo.current?.focus();
    const alTeclear = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !enVuelo.current) setAbierto(false);
    };
    document.addEventListener('keydown', alTeclear);
    const retorno = disparador.current;
    return () => {
      document.removeEventListener('keydown', alTeclear);
      retorno?.focus();
    };
  }, [abierto]);

  const confirmar = () => {
    if (enVuelo.current) return; // doble clic: una sola confirmación
    enVuelo.current = true;
    setError(undefined);
    iniciar(async () => {
      try {
        const r = await confirmarAccionPropuestaDeChat(campaignId, accion.id, accion.payloadHash);
        if (r.ok) setAbierto(false);
        else setError(r.error);
        router.refresh();
      } finally {
        enVuelo.current = false;
      }
    });
  };

  const cancelarPropuesta = () => {
    if (enVuelo.current) return;
    enVuelo.current = true;
    setError(undefined);
    iniciar(async () => {
      try {
        const r = await cancelarAccionPropuestaDeChat(campaignId, accion.id);
        if (!r.ok) setError(r.error);
        router.refresh();
      } finally {
        enVuelo.current = false;
      }
    });
  };

  const abierta = accion.estado === 'pending' || accion.estado === 'confirmed';
  const puedeDecidir = accion.canConfirm || accion.canRetryExecute;
  const textoDelBoton = accion.canRetryExecute ? 'Reintentar la ejecución' : 'Revisar y confirmar';

  return (
    <section
      className={styles.propuesta}
      aria-label={`Acción propuesta: ${accion.titulo}`}
      data-testid="chat-proposal"
      data-estado={accion.estado}
      data-tipo={accion.tipo}
      data-obsoleta={accion.obsoleta ? 'true' : 'false'}
    >
      <div className={styles.propuestaCabecera}>
        <h3>{accion.titulo}</h3>
        <span className={PILL[accion.estado] ?? 'pill neutro'} data-testid="chat-proposal-estado">
          {accion.obsoleta && abierta ? 'Obsoleta' : (ESTADO_DE_PROPUESTA[accion.estado] ?? accion.estado)}
        </span>
      </div>

      <p className={styles.propuestaTexto} data-testid="chat-proposal-text">
        {accion.textoHumano}
      </p>
      {accion.detalle.length > 0 && (
        <ul className={styles.propuestaDetalle}>
          {accion.detalle.map((d) => (
            <li key={d}>{d}</li>
          ))}
        </ul>
      )}
      <AvisosDeLaPropuesta advertencias={accion.advertencias} />

      <div className={styles.propuestaMeta}>
        <span data-testid="chat-proposal-author">
          Propuesta por {accion.propuestaPor}
          {accion.propuestaPorElAsistente ? ' (a través del asistente)' : ''}
        </span>
        <span>Vence {fechaHora(accion.expiresAt)}</span>
        <span>
          Huella{' '}
          <code className={styles.huella} data-testid="chat-proposal-fingerprint">
            {huellaCorta(accion.payloadHash)}
          </code>
        </span>
      </div>

      {accion.obsoleta && abierta && (
        <p className={styles.otroRol} role="status" data-testid="chat-proposal-stale">
          Lo propuesto cambió después de proponerse, así que ya no se puede confirmar. Pídele al asistente que
          lo proponga de nuevo.
        </p>
      )}
      {!accion.obsoleta && accion.estado === 'pending' && !puedeDecidir && (
        <p className={styles.otroRol} data-testid="chat-proposal-other-role">
          Pendiente de {accion.quienConfirma}: tu rol no puede confirmarla.
        </p>
      )}
      {accion.estado === 'confirmed' && !accion.canRetryExecute && (
        <p className={styles.otroRol}>
          Ya está confirmada y falta ejecutarla; solo quien la confirmó puede hacerlo.
        </p>
      )}

      {abierta && (accion.canCancel || puedeDecidir) && (
        <div className={styles.propuestaAcciones}>
          {puedeDecidir && (
            <button
              ref={disparador}
              type="button"
              className="btn pri"
              onClick={() => {
                setError(undefined);
                setAbierto(true);
              }}
              disabled={pendiente}
              data-testid="chat-proposal-confirm"
            >
              {textoDelBoton}
            </button>
          )}
          {accion.canCancel && (
            <button
              type="button"
              className="btn"
              onClick={cancelarPropuesta}
              disabled={pendiente}
              data-testid="chat-proposal-cancel"
            >
              Cancelar propuesta
            </button>
          )}
        </div>
      )}

      {error !== undefined && !abierto && (
        <p className={styles.error} role="alert" data-testid="chat-proposal-error">
          {error}
        </p>
      )}

      {abierto && (
        <div
          className="confirm-backdrop"
          onClick={() => {
            if (!enVuelo.current) setAbierto(false);
          }}
        >
          <div
            className="confirm-dialog"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby={tituloId}
            aria-describedby={detalleId}
            data-testid="chat-proposal-dialog"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 id={tituloId}>
              {accion.canRetryExecute ? 'Reintentar la ejecución' : 'Confirmar esta acción'}
            </h3>
            <div id={detalleId}>
              <p className={styles.dialogoDetalle}>{accion.textoHumano}</p>
              <ul>
                {accion.detalle.map((d) => (
                  <li key={d}>{d}</li>
                ))}
                <li>Queda registrada a tu nombre, desde la interfaz.</li>
                <li>
                  Huella de lo propuesto:{' '}
                  <code className={styles.huella}>{huellaCorta(accion.payloadHash)}</code>
                </li>
              </ul>
              <AvisosDeLaPropuesta advertencias={accion.advertencias} />
            </div>
            {error !== undefined && (
              <p className={styles.error} role="alert" data-testid="chat-proposal-dialog-error">
                {error}
              </p>
            )}
            <div className="row">
              <button
                ref={botonCancelarDialogo}
                type="button"
                className="btn"
                onClick={() => setAbierto(false)}
                disabled={pendiente}
                data-testid="chat-proposal-dialog-cancel"
              >
                Cancelar
              </button>
              <button
                type="button"
                className="btn pri"
                onClick={confirmar}
                disabled={pendiente}
                data-testid="chat-proposal-dialog-confirm"
              >
                {pendiente ? 'Procesando…' : 'Sí, confirmar'}
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
