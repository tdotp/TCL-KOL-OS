'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { reintentarFuente } from '@/lib/actions';

interface Fuente {
  readonly id: string;
  readonly filename: string;
  /** `null` en una fuente enlazada (V2 · Fase 4). */
  readonly mime_type: string | null;
  readonly size_bytes: string | null;
  readonly status: 'pendiente' | 'por_resolver' | 'procesando' | 'procesado' | 'fallido';
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
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'XLSX',
  'text/csv': 'CSV',
  'image/png': 'PNG',
  'image/jpeg': 'JPG',
};

const ESTADO: Record<string, { texto: string; clase: string }> = {
  pendiente: { texto: 'en cola', clase: '' },
  por_resolver: { texto: 'por resolver', clase: '' },
  procesando: { texto: 'procesando', clase: 'processing' },
  procesado: { texto: 'procesado', clase: 'ok' },
  fallido: { texto: 'fallido', clase: 'bad' },
};

export function TablaFuentes({ campaignId, fuentes }: { campaignId: string; fuentes: readonly Fuente[] }) {
  const router = useRouter();
  const [busqueda, setBusqueda] = useState('');
  const hayTrabajo = fuentes.some((f) => f.status === 'pendiente' || f.status === 'procesando');

  const visibles = useMemo(() => {
    const q = busqueda.trim().toLowerCase();
    if (q === '') return fuentes;
    return fuentes.filter(
      (f) =>
        f.filename.toLowerCase().includes(q) ||
        (ETIQUETA_TIPO[f.mime_type ?? ''] ?? f.mime_type ?? 'enlace').toLowerCase().includes(q),
    );
  }, [fuentes, busqueda]);

  useEffect(() => {
    if (!hayTrabajo) return;
    const t = setInterval(() => router.refresh(), 2000);
    return () => clearInterval(t);
  }, [hayTrabajo, router]);

  return (
    <section className="card sources-table-card">
      <div className="sources-table-head">
        <div>
          <div className="eyebrow">Biblioteca</div>
          <h2 className="plain-heading">
            Archivos <span className="heading-count">{fuentes.length}</span>
          </h2>
        </div>
        <div className="sources-table-tools">
          <label className="table-search compact-search">
            <span>⌕</span>
            <input
              value={busqueda}
              onChange={(e) => setBusqueda(e.target.value)}
              placeholder="Buscar archivo…"
            />
          </label>
          {hayTrabajo && (
            <span className="processing-note">
              <i />
              actualizando
            </span>
          )}
        </div>
      </div>

      {fuentes.length === 0 ? (
        <div className="empty-state compact-empty">
          <div className="empty-file-icon">▤</div>
          <h3>No hay fuentes todavía</h3>
          <p>Los archivos que cargues aparecerán aquí con su estado de procesamiento.</p>
        </div>
      ) : visibles.length === 0 ? (
        <p className="vacio">No hay archivos que coincidan con “{busqueda}”.</p>
      ) : (
        <div className="table-shell source-table-shell">
          <table className="sources-table">
            <thead>
              <tr>
                <th>Archivo</th>
                <th>Tipo</th>
                <th>Tamaño</th>
                <th>Estado</th>
                <th>Fragmentos</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {visibles.map((f) => {
                const estado = ESTADO[f.status] ?? { texto: f.status, clase: '' };
                const mb = Math.round((Number(f.size_bytes ?? 0) / 1024 / 1024) * 10) / 10;
                return (
                  <tr key={f.id}>
                    <td>
                      <div className="file-name-cell">
                        <span className="file-neutral-icon">▤</span>
                        <div>
                          {f.status === 'procesado' && f.fragmentos > 0 ? (
                            <a href={`/campanas/${campaignId}/fuentes/${f.id}`}>{f.filename}</a>
                          ) : (
                            <strong>{f.filename}</strong>
                          )}
                          {f.job_error !== null && (
                            <span className={`file-error ${f.status === 'fallido' ? 'fatal' : ''}`}>
                              {f.status === 'pendiente'
                                ? `Reintentando · intento ${f.job_intentos ?? 0}: `
                                : ''}
                              {f.job_error}
                            </span>
                          )}
                        </div>
                      </div>
                    </td>
                    <td className="table-secondary">
                      {ETIQUETA_TIPO[f.mime_type ?? ''] ?? f.mime_type ?? 'enlace'}
                    </td>
                    <td className="table-secondary">{f.size_bytes === null ? '—' : `${mb} MB`}</td>
                    <td>
                      <span className={`source-status ${estado.clase}`}>
                        <i />
                        {estado.texto}
                      </span>
                    </td>
                    <td className="table-secondary">{f.fragmentos > 0 ? f.fragmentos : '—'}</td>
                    <td>
                      {f.status === 'fallido' && (
                        <form action={reintentarFuente}>
                          <input type="hidden" name="sourceId" value={f.id} />
                          <input type="hidden" name="campaignId" value={campaignId} />
                          <button className="btn mini" type="submit">
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
      )}
    </section>
  );
}
