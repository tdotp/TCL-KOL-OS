'use client';

import { useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { crearDeliverableDeContenido } from '@/lib/contenido-actions';
import { PLATAFORMAS } from './etiquetas';
import styles from './contenido.module.css';

/**
 * Crea un entregable de UNA participación (CampaignInfluencer). El canal y el autor los fija el
 * servidor; aquí solo se escribe la etiqueta y, opcionalmente, la plataforma (informativa).
 */
export function FormularioCrearDeliverable({
  campaignId,
  participacionId,
  influencerNombre,
}: {
  campaignId: string;
  participacionId: string;
  influencerNombre: string;
}) {
  const router = useRouter();
  const [pendiente, iniciar] = useTransition();
  const [error, setError] = useState<string | undefined>(undefined);
  const [creado, setCreado] = useState(false);
  const enVuelo = useRef(false);
  const formulario = useRef<HTMLFormElement>(null);

  const enviar = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (enVuelo.current) return; // doble clic: un solo alta
    const datos = new FormData(e.currentTarget);
    const etiqueta = String(datos.get('etiqueta') ?? '');
    const plataforma = String(datos.get('plataforma') ?? '');
    enVuelo.current = true;
    setError(undefined);
    setCreado(false);
    iniciar(async () => {
      try {
        const r = await crearDeliverableDeContenido(
          campaignId,
          participacionId,
          etiqueta,
          plataforma === '' ? undefined : plataforma,
        );
        if (r.ok) {
          formulario.current?.reset();
          setCreado(true);
        } else {
          setError(r.error);
        }
        router.refresh();
      } finally {
        enVuelo.current = false;
      }
    });
  };

  return (
    <form
      ref={formulario}
      className={styles['formularioEnLinea']}
      onSubmit={enviar}
      data-testid="contenido-crear-form"
      aria-label={`Crear entregable de ${influencerNombre}`}
    >
      <label>
        Nuevo entregable
        <input
          type="text"
          name="etiqueta"
          required
          maxLength={120}
          placeholder="Ej. Reel de lanzamiento"
          data-testid="contenido-crear-etiqueta"
        />
      </label>
      <label>
        Plataforma (opcional)
        <select name="plataforma" defaultValue="" data-testid="contenido-crear-plataforma">
          <option value="">Sin indicar</option>
          {PLATAFORMAS.map((p) => (
            <option key={p.valor} value={p.valor}>
              {p.etiqueta}
            </option>
          ))}
        </select>
      </label>
      <button type="submit" className="btn pri" disabled={pendiente} data-testid="contenido-crear-submit">
        {pendiente ? 'Creando…' : 'Crear entregable'}
      </button>
      {error !== undefined && (
        <p
          className={styles['error']}
          role="alert"
          data-testid="contenido-crear-error"
          style={{ flexBasis: '100%' }}
        >
          {error}
        </p>
      )}
      {creado && error === undefined && (
        <p
          className={styles['exito']}
          role="status"
          data-testid="contenido-crear-ok"
          style={{ flexBasis: '100%' }}
        >
          Entregable creado.
        </p>
      )}
    </form>
  );
}
