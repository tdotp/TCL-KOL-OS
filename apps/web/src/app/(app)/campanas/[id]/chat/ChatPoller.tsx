'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import styles from './chat.module.css';

const PRIMERA_ESPERA_MS = 1_500;
const ESPERA_MAXIMA_MS = 4_000;
const TOPE_TOTAL_MS = 5 * 60_000;

/**
 * Sondeo del estado del turno (sin streaming): mientras haya un run activo refresca los datos
 * del servidor con `router.refresh()` (no con una server action: se serializarían con el envío).
 * Empieza en ~1,5 s y sube con un backoff suave hasta ~4 s; se pausa con la pestaña oculta,
 * se detiene solo cuando el run termina (`activo` pasa a `false`) y se rinde a los 5 minutos
 * (el barrido del servidor cierra los runs huérfanos; la persona puede actualizar a mano).
 */
export function ChatPoller({ activo }: { activo: boolean }) {
  const router = useRouter();
  const [agotado, setAgotado] = useState(false);

  useEffect(() => {
    if (!activo) {
      setAgotado(false);
      return;
    }
    let cancelado = false;
    let espera = PRIMERA_ESPERA_MS;
    let temporizador: ReturnType<typeof setTimeout> | undefined;
    const inicio = Date.now();

    const programar = () => {
      temporizador = setTimeout(latido, espera);
    };
    const latido = () => {
      if (cancelado) return;
      if (typeof document !== 'undefined' && document.hidden) {
        programar(); // pestaña oculta: no se refresca, se vuelve a mirar luego
        return;
      }
      if (Date.now() - inicio > TOPE_TOTAL_MS) {
        setAgotado(true);
        return;
      }
      router.refresh();
      espera = Math.min(Math.round(espera * 1.25), ESPERA_MAXIMA_MS);
      programar();
    };
    const alVolver = () => {
      if (cancelado || document.hidden) return;
      clearTimeout(temporizador);
      espera = PRIMERA_ESPERA_MS;
      latido();
    };

    programar();
    document.addEventListener('visibilitychange', alVolver);
    return () => {
      cancelado = true;
      clearTimeout(temporizador);
      document.removeEventListener('visibilitychange', alVolver);
    };
  }, [activo, router]);

  if (!agotado) return null;
  return (
    <p className={styles.nota} role="status" data-testid="chat-poller-agotado">
      Dejamos de actualizar automáticamente.{' '}
      <button type="button" className="btn mini" onClick={() => router.refresh()}>
        Actualizar ahora
      </button>
    </p>
  );
}
