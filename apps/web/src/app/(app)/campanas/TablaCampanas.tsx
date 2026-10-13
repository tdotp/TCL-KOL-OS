'use client';

import { useMemo, useState } from 'react';
import { monogramaColor, monogramaIniciales } from '@/lib/monograma';

interface Campana {
  id: string;
  name: string;
  market: string;
  category: string | null;
  owner_name: string;
  start_date: string | Date | null;
  end_date: string | Date | null;
  status: string;
}

function fechaCorta(valor: string | Date | null): string {
  if (valor === null) return '—';
  return new Date(valor).toLocaleDateString('es-CO', { day: 'numeric', month: 'short', year: 'numeric' });
}

/** Filtros exclusivamente client-side sobre las campañas que el servidor ya autorizó. */
export function TablaCampanas({
  campanas,
  initialSearch = '',
}: {
  campanas: Campana[];
  initialSearch?: string;
}) {
  const [busqueda, setBusqueda] = useState(initialSearch);
  const [estado, setEstado] = useState('todos');

  const visibles = useMemo(() => {
    const q = busqueda.trim().toLowerCase();
    return campanas.filter((c) => {
      const coincideTexto =
        q === '' ||
        c.name.toLowerCase().includes(q) ||
        (c.category ?? '').toLowerCase().includes(q) ||
        c.owner_name.toLowerCase().includes(q) ||
        c.market.toLowerCase().includes(q);
      const coincideEstado = estado === 'todos' || c.status === estado;
      return coincideTexto && coincideEstado;
    });
  }, [campanas, busqueda, estado]);

  return (
    <>
      <div className="campaigns-toolbar">
        <label className="table-search">
          <span aria-hidden="true">⌕</span>
          <input
            placeholder="Buscar campañas…"
            value={busqueda}
            onChange={(e) => setBusqueda(e.target.value)}
            aria-label="Buscar campañas"
          />
        </label>
        <select value={estado} onChange={(e) => setEstado(e.target.value)} aria-label="Filtrar por estado">
          <option value="todos">Todos los estados</option>
          <option value="activa">Activas</option>
          <option value="archivada">Archivadas</option>
          <option value="cancelada">Canceladas</option>
        </select>
        <span className="table-count">
          {visibles.length} de {campanas.length}
        </span>
      </div>

      {visibles.length === 0 ? (
        <p className="vacio">Ninguna campaña coincide con los filtros.</p>
      ) : (
        <div className="table-shell">
          <table className="campaigns-table">
            <thead>
              <tr>
                <th>Campaña</th>
                <th>Mercado</th>
                <th>Fechas</th>
                <th>Responsable</th>
                <th>Estado</th>
                <th aria-label="Abrir" />
              </tr>
            </thead>
            <tbody>
              {visibles.map((c) => (
                <tr key={c.id}>
                  <td>
                    <a href={`/campanas/${c.id}`} className="campana-cell">
                      <span className={`monogram ${monogramaColor(c.id)}`}>{monogramaIniciales(c.name)}</span>
                      <span className="campaign-name-copy">
                        <strong>{c.name}</strong>
                        <span>{c.category ?? 'Sin categoría'}</span>
                      </span>
                    </a>
                  </td>
                  <td>{c.market}</td>
                  <td className="table-secondary">
                    {fechaCorta(c.start_date)}
                    <span className="date-arrow">→</span>
                    {fechaCorta(c.end_date)}
                  </td>
                  <td>{c.owner_name}</td>
                  <td>
                    <span className={`status-dot ${c.status === 'activa' ? 'ok' : ''}`}>{c.status}</span>
                  </td>
                  <td>
                    <a className="row-open" href={`/campanas/${c.id}`} aria-label={`Abrir ${c.name}`}>
                      →
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
