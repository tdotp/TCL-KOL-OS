'use client';

import { useMemo, useState } from 'react';
import { monogramaColor, monogramaIniciales } from '@/lib/monograma';

interface Campana {
  id: string;
  name: string;
  category: string | null;
  owner_name: string;
  start_date: string | Date | null;
  end_date: string | Date | null;
  status: string;
}

/** UI-03 · Filtro por nombre/categoría/responsable — sobre los datos ya cargados, sin ida al servidor. */
export function TablaCampanas({ campanas }: { campanas: Campana[] }) {
  const [busqueda, setBusqueda] = useState('');

  const visibles = useMemo(() => {
    const q = busqueda.trim().toLowerCase();
    if (q === '') return campanas;
    return campanas.filter(
      (c) =>
        c.name.toLowerCase().includes(q) ||
        (c.category ?? '').toLowerCase().includes(q) ||
        c.owner_name.toLowerCase().includes(q),
    );
  }, [campanas, busqueda]);

  return (
    <>
      <div className="toolbar">
        <input
          className="input"
          placeholder="⌕  Buscar campañas…"
          value={busqueda}
          onChange={(e) => setBusqueda(e.target.value)}
        />
      </div>

      {visibles.length === 0 ? (
        <p className="vacio">Ninguna campaña coincide con “{busqueda}”.</p>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table>
            <thead>
              <tr>
                <th>Campaña</th>
                <th>Categoría</th>
                <th>Responsable</th>
                <th>Fechas</th>
                <th>Estado</th>
              </tr>
            </thead>
            <tbody>
              {visibles.map((c) => (
                <tr key={c.id}>
                  <td>
                    <a href={`/campanas/${c.id}`} className="campana-cell">
                      <span className={`monogram ${monogramaColor(c.id)}`}>{monogramaIniciales(c.name)}</span>
                      <strong>{c.name}</strong>
                    </a>
                  </td>
                  <td>{c.category ?? '—'}</td>
                  <td>{c.owner_name}</td>
                  <td style={{ color: 'var(--muted)', fontSize: 13 }}>
                    {c.start_date === null
                      ? '—'
                      : `${new Date(c.start_date).toLocaleDateString('es-CO')} → ${
                          c.end_date === null ? '…' : new Date(c.end_date).toLocaleDateString('es-CO')
                        }`}
                  </td>
                  <td>
                    <span className={`pill ${c.status === 'activa' ? 'ok' : 'neutro'}`}>{c.status}</span>
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
