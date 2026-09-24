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
 * Aquí solo se eligen los productos. El reparto de presupuesto NO se pide:
 * al crear la campaña ese dato todavía no existe —llega en el brief del
 * cliente— y pedirlo obligaría a inventarlo. Se extrae del brief cuando esté
 * (DEC-017).
 */
export function FormularioCampana({ productos }: { productos: readonly Producto[] }) {
  const [estado, accion, enviando] = useActionState(crearCampana, {});
  const [elegidos, setElegidos] = useState<string[]>([]);

  const alternar = (id: string) => {
    setElegidos((previos) => (previos.includes(id) ? previos.filter((p) => p !== id) : [...previos, id]));
  };

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
          El primero que selecciones queda como <strong>flagship</strong>.
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
                </tr>
              );
            })}
          </tbody>
        </table>
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
