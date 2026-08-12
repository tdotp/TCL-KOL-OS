'use client';

import { useActionState, useState } from 'react';
import { crearCampana } from '@/lib/actions';

interface Producto {
  readonly id: string;
  readonly brand: string;
  readonly category: string;
  readonly model: string;
}

/**
 * Formulario de campaña multiproducto (DEC-016, historia E3-8).
 *
 * El reparto de presupuesto se muestra en vivo: si no suma 100%, se avisa sin
 * bloquear (historia E3-9). El brief P80 real declara 60/20/10 = 90%, y eso
 * puede ser deliberado — el sistema lo hace visible en vez de decidirlo.
 */
export function FormularioCampana({ productos }: { productos: readonly Producto[] }) {
  const [estado, accion, enviando] = useActionState(crearCampana, {});
  const [elegidos, setElegidos] = useState<string[]>([]);
  const [reparto, setReparto] = useState<Record<string, string>>({});

  const alternar = (id: string) => {
    setElegidos((previos) => (previos.includes(id) ? previos.filter((p) => p !== id) : [...previos, id]));
  };

  const suma = elegidos.reduce((acc, id) => acc + (Number(reparto[id]) || 0), 0);
  const repartoDeclarado = elegidos.some((id) => (reparto[id] ?? '') !== '');

  return (
    <form action={accion}>
      {estado.error !== undefined && (
        <div className="aviso error">
          <strong>No se pudo crear la campaña</strong>
          {estado.error}
        </div>
      )}

      <div className="card">
        <h2>Datos de la campaña</h2>
        <div className="fld">
          <label htmlFor="name">Nombre *</label>
          <input id="name" name="name" required placeholder="Lanzamiento línea P80" />
        </div>
        <div className="g2">
          <div className="fld">
            <label htmlFor="category">Categoría</label>
            <input id="category" name="category" placeholder="Smartphones" />
          </div>
          <div className="fld">
            <label htmlFor="market">Mercado</label>
            <input id="market" name="market" defaultValue="CO" />
          </div>
          <div className="fld">
            <label htmlFor="startDate">Fecha de inicio</label>
            <input id="startDate" name="startDate" type="date" />
          </div>
          <div className="fld">
            <label htmlFor="endDate">Fecha de fin</label>
            <input id="endDate" name="endDate" type="date" />
          </div>
        </div>
      </div>

      <div className="card">
        <h2>Productos ({elegidos.length})</h2>
        <p className="sub" style={{ marginBottom: 12 }}>
          El primero que selecciones queda como <strong>flagship</strong>. El reparto de presupuesto es
          opcional.
        </p>

        <table>
          <tbody>
            {productos.map((p) => {
              const activo = elegidos.includes(p.id);
              const orden = elegidos.indexOf(p.id);
              return (
                <tr key={p.id}>
                  <td style={{ width: 30 }}>
                    <input
                      type="checkbox"
                      name="productos"
                      value={p.id}
                      checked={activo}
                      onChange={() => alternar(p.id)}
                      aria-label={`Incluir ${p.brand} ${p.model}`}
                    />
                  </td>
                  <td>
                    <strong>{p.model}</strong>
                    <div style={{ color: 'var(--muted)', fontSize: 12.5 }}>
                      {p.brand} · {p.category}
                    </div>
                  </td>
                  <td style={{ width: 110 }}>
                    {activo && (
                      <span className={`pill ${orden === 0 ? 'info' : ''}`}>
                        {elegidos.length === 1 ? 'único' : orden === 0 ? 'flagship' : 'secundario'}
                      </span>
                    )}
                  </td>
                  <td style={{ width: 120 }}>
                    {activo && (
                      <input
                        name={`participacion_${p.id}`}
                        type="number"
                        min="0"
                        max="100"
                        step="1"
                        placeholder="% presup."
                        value={reparto[p.id] ?? ''}
                        onChange={(e) => setReparto((r) => ({ ...r, [p.id]: e.target.value }))}
                        style={{ padding: '5px 8px', fontSize: 13 }}
                      />
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>

        {repartoDeclarado && Math.abs(suma - 100) > 0.01 && (
          <div className="aviso" style={{ marginTop: 14, marginBottom: 0 }}>
            <strong>El reparto suma {suma}%, no 100%</strong>
            Puede ser deliberado. Se registra tal cual y queda visible en el detalle de la campaña.
          </div>
        )}
      </div>

      <div className="row">
        <button className="btn pri" type="submit" disabled={enviando || elegidos.length === 0}>
          {enviando ? 'Creando…' : 'Crear campaña'}
        </button>
        <a className="btn" href="/campanas">
          Cancelar
        </a>
      </div>
    </form>
  );
}
