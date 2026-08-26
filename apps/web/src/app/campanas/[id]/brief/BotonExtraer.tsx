'use client';

import { useActionState } from 'react';
import { extraerBriefDeCampana } from '@/lib/actions';

/**
 * Dispara la extracción asistida.
 *
 * El estado de "trabajando" no es decoración: la llamada tarda unos doce
 * segundos, y sin una señal clara la gente vuelve a pulsar y se paga dos veces
 * la misma extracción.
 */
export function BotonExtraer({ campaignId }: { campaignId: string }) {
  const [estado, accion, pendiente] = useActionState(extraerBriefDeCampana, {});

  return (
    <form action={accion} className="card">
      <input type="hidden" name="campaignId" value={campaignId} />
      <h2>Extracción asistida</h2>
      <p className="sub">
        Lee las fuentes procesadas y propone campos del brief, cada uno con la cita que lo respalda. Nada se
        aprueba solo: lo que salga de aquí queda en borrador para que usted lo confirme.
      </p>

      <button type="submit" disabled={pendiente}>
        {pendiente ? 'Extrayendo…' : 'Extraer campos de las fuentes'}
      </button>

      {pendiente && (
        <p className="sub" style={{ marginTop: 8 }}>
          Suele tardar unos segundos. No cierre la pantalla.
        </p>
      )}
      {estado.error !== undefined && (
        <p className="error" style={{ marginTop: 8 }}>
          {estado.error}
        </p>
      )}
      {estado.ok !== undefined && (
        <p className="sub" style={{ marginTop: 8, color: 'var(--ok)' }}>
          {estado.ok}
        </p>
      )}
    </form>
  );
}
