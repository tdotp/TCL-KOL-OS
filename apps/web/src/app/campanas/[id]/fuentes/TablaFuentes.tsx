'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { reintentarFuente } from '@/lib/actions';

interface Fuente {
  readonly id: string;
  readonly filename: string;
  readonly mime_type: string;
  readonly size_bytes: string;
  readonly status: 'pendiente' | 'procesando' | 'procesado' | 'fallido';
  readonly fragmentos: number;
  readonly job_status: string | null;
  readonly job_intentos: number | null;
  readonly job_error: string | null;
}

const ETIQUETA_TIPO: Record<string, string> = {
  'text/markdown': 'MD',
  'application/pdf': 'PDF',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'PPTX',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'DOCX',
  'image/png': 'PNG',
  'image/jpeg': 'JPG',
};

const ESTADO: Record<string, { texto: string; clase: string }> = {
  pendiente: { texto: 'en cola', clase: '' },
  procesando: { texto: 'procesando', clase: 'info' },
  procesado: { texto: 'procesado', clase: 'ok' },
  fallido: { texto: 'fallido', clase: 'bad' },
};

/**
 * UI-07 · Estado de procesamiento.
 *
 * Se refresca sola mientras haya trabajo pendiente. Es la prueba visible de que
 * el procesamiento no bloquea: la página está viva y navegable mientras el
 * worker trabaja.
 */
export function TablaFuentes({ campaignId, fuentes }: { campaignId: string; fuentes: readonly Fuente[] }) {
  const router = useRouter();
  const hayTrabajo = fuentes.some((f) => f.status === 'pendiente' || f.status === 'procesando');

  useEffect(() => {
    if (!hayTrabajo) return;
    const t = setInterval(() => router.refresh(), 2000);
    return () => clearInterval(t);
  }, [hayTrabajo, router]);

  if (fuentes.length === 0) {
    return (
      <div className="card">
        <h2>Fuentes cargadas</h2>
        <p className="vacio">Todavía no hay fuentes en esta campaña.</p>
      </div>
    );
  }

  return (
    <div className="card">
      <div className="row" style={{ justifyContent: 'space-between', marginBottom: 12 }}>
        <h2 style={{ margin: 0 }}>Fuentes cargadas ({fuentes.length})</h2>
        {hayTrabajo && <span className="pill info">actualizando cada 2 s…</span>}
      </div>

      <table>
        <thead>
          <tr>
            <th>Archivo</th>
            <th>Tipo</th>
            <th>Tamaño</th>
            <th>Estado</th>
            <th>Fragmentos</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {fuentes.map((f) => {
            const estado = ESTADO[f.status] ?? { texto: f.status, clase: '' };
            const mb = Math.round((Number(f.size_bytes) / 1024 / 1024) * 10) / 10;
            return (
              <tr key={f.id}>
                <td>
                  {f.status === 'procesado' && f.fragmentos > 0 ? (
                    <a href={`/campanas/${campaignId}/fuentes/${f.id}`} style={{ fontWeight: 600 }}>
                      {f.filename}
                    </a>
                  ) : (
                    <strong>{f.filename}</strong>
                  )}
                  {f.job_error !== null && f.status === 'fallido' && (
                    <div style={{ color: 'var(--bad)', fontSize: 12.5, marginTop: 4 }}>{f.job_error}</div>
                  )}
                  {f.job_error !== null && f.status === 'pendiente' && (
                    <div style={{ color: 'var(--warn)', fontSize: 12.5, marginTop: 4 }}>
                      Reintentando · intento {f.job_intentos ?? 0}: {f.job_error}
                    </div>
                  )}
                </td>
                <td>
                  <span className="pill">{ETIQUETA_TIPO[f.mime_type] ?? f.mime_type}</span>
                </td>
                <td style={{ color: 'var(--muted)' }}>{mb} MB</td>
                <td>
                  <span className={`pill ${estado.clase}`}>{estado.texto}</span>
                </td>
                <td>{f.fragmentos > 0 ? f.fragmentos : '—'}</td>
                <td>
                  {f.status === 'fallido' && (
                    <form action={reintentarFuente}>
                      <input type="hidden" name="sourceId" value={f.id} />
                      <input type="hidden" name="campaignId" value={campaignId} />
                      <button className="btn" type="submit" style={{ padding: '4px 10px', fontSize: 12.5 }}>
                        Reintentar
                      </button>
                    </form>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
