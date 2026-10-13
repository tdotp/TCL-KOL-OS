'use client';

import { useActionState, useMemo, useState } from 'react';
import { crearCampana } from '@/lib/actions';

interface Producto {
  readonly id: string;
  readonly brand: string;
  readonly category: string;
  readonly model: string;
}

export function FormularioCampana({ productos }: { productos: readonly Producto[] }) {
  const [estado, accion, enviando] = useActionState(crearCampana, {});
  const [elegidos, setElegidos] = useState<string[]>([]);
  const [nombre, setNombre] = useState('');
  const [categoria, setCategoria] = useState('');
  const [mercado, setMercado] = useState('CO');
  const [inicio, setInicio] = useState('');
  const [fin, setFin] = useState('');

  const alternar = (id: string) => {
    setElegidos((previos) => (previos.includes(id) ? previos.filter((p) => p !== id) : [...previos, id]));
  };

  const productosElegidos = useMemo(
    () =>
      elegidos.map((id) => productos.find((p) => p.id === id)).filter((p): p is Producto => p !== undefined),
    [elegidos, productos],
  );

  return (
    <form action={accion} className="create-layout">
      <div className="create-main">
        {estado.error !== undefined && (
          <div className="aviso error">
            <strong>No se pudo crear la campaña</strong>
            {estado.error}
          </div>
        )}

        <section className="card form-section">
          <div className="form-section-head">
            <div>
              <div className="eyebrow">01</div>
              <h2>Datos de la campaña</h2>
              <p>Nombre, mercado y fechas. Solo información que existe realmente en el dominio.</p>
            </div>
          </div>

          <div className="form-grid">
            <div className="fld form-span-2">
              <label htmlFor="name">Nombre *</label>
              <input
                id="name"
                name="name"
                required
                placeholder="Ej. Lanzamiento línea P80"
                value={nombre}
                onChange={(e) => setNombre(e.target.value)}
              />
            </div>
            <div className="fld">
              <label htmlFor="category">Categoría</label>
              <input
                id="category"
                name="category"
                placeholder="Ej. Smartphones"
                value={categoria}
                onChange={(e) => setCategoria(e.target.value)}
              />
            </div>
            <div className="fld">
              <label htmlFor="market">Mercado</label>
              <input id="market" name="market" value={mercado} onChange={(e) => setMercado(e.target.value)} />
            </div>
            <div className="fld">
              <label htmlFor="startDate">Fecha de inicio</label>
              <input
                id="startDate"
                name="startDate"
                type="date"
                value={inicio}
                onChange={(e) => setInicio(e.target.value)}
              />
            </div>
            <div className="fld">
              <label htmlFor="endDate">Fecha de fin</label>
              <input
                id="endDate"
                name="endDate"
                type="date"
                value={fin}
                onChange={(e) => setFin(e.target.value)}
              />
            </div>
          </div>
        </section>

        <section className="card form-section">
          <div className="form-section-head products-head">
            <div>
              <div className="eyebrow">02</div>
              <h2>Productos</h2>
              <p>
                El primero que selecciones queda como flagship. No usamos fotos: el producto se identifica por
                modelo y categoría.
              </p>
            </div>
            <span className="selection-counter">{elegidos.length} seleccionados</span>
          </div>

          <div className="product-selector">
            {productos.map((p) => {
              const activo = elegidos.includes(p.id);
              const orden = elegidos.indexOf(p.id);
              return (
                <label className={`product-option ${activo ? 'selected' : ''}`} key={p.id}>
                  <input
                    type="checkbox"
                    name="productos"
                    value={p.id}
                    checked={activo}
                    onChange={() => alternar(p.id)}
                    aria-label={`Incluir ${p.brand} ${p.model}`}
                  />
                  <span className="product-glyph" aria-hidden="true">
                    ▭
                  </span>
                  <span className="product-option-copy">
                    <strong>{p.model}</strong>
                    <span>
                      {p.brand} · {p.category}
                    </span>
                  </span>
                  {activo && (
                    <span className="product-role">
                      {elegidos.length === 1 ? 'único' : orden === 0 ? 'flagship' : 'secundario'}
                    </span>
                  )}
                </label>
              );
            })}
          </div>
        </section>

        <div className="form-actions-dock">
          <a className="btn" href="/campanas">
            Cancelar
          </a>
          <button className="btn pri" type="submit" disabled={enviando || elegidos.length === 0}>
            {enviando ? 'Creando…' : 'Crear campaña →'}
          </button>
        </div>
      </div>

      <aside className="create-side">
        <section className="card summary-card sticky-card">
          <div className="eyebrow">Resumen</div>
          <h3>Campaña</h3>
          <dl className="summary-list">
            <div>
              <dt>Nombre</dt>
              <dd>{nombre.trim() || '—'}</dd>
            </div>
            <div>
              <dt>Categoría</dt>
              <dd>{categoria.trim() || '—'}</dd>
            </div>
            <div>
              <dt>Mercado</dt>
              <dd>{mercado.trim() || '—'}</dd>
            </div>
            <div>
              <dt>Fechas</dt>
              <dd>{inicio || fin ? `${inicio || '…'} → ${fin || '…'}` : '—'}</dd>
            </div>
            <div>
              <dt>Productos</dt>
              <dd>
                {productosElegidos.length === 0 ? 'Ninguno' : `${productosElegidos.length} seleccionados`}
              </dd>
            </div>
          </dl>
          {productosElegidos.length > 0 && (
            <div className="summary-products">
              {productosElegidos.map((p, i) => (
                <div key={p.id}>
                  <span>{p.model}</span>
                  <small>{i === 0 && productosElegidos.length > 1 ? 'flagship' : p.category}</small>
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="card quiet-tip">
          <div className="tip-mark">i</div>
          <div>
            <strong>Menos datos, mejor.</strong>
            <p>
              Presupuesto, objetivos y mensajes llegan desde el brief cuando existan. No los inventamos al
              crear la campaña.
            </p>
          </div>
        </section>
      </aside>
    </form>
  );
}
