'use client';

export function SelectorProducto({
  productos,
  seleccionado,
  onSeleccionar,
}: {
  productos: { id: string; model: string; rol: string }[];
  seleccionado: string | undefined;
  onSeleccionar: (id: string) => void;
}) {
  if (productos.length <= 1) return null;

  return (
    <div className="row" style={{ gap: 6, marginBottom: 12, flexWrap: 'wrap' }}>
      {productos.map((p) => (
        <button
          key={p.id}
          type="button"
          onClick={() => onSeleccionar(p.id)}
          className={`pill ${seleccionado === p.id ? 'ok' : ''}`}
          style={{ cursor: 'pointer', border: 'none' }}
        >
          {p.model} {p.rol === 'flagship' && '★'}
        </button>
      ))}
    </div>
  );
}
