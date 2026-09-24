'use client';

export function NavegacionSecciones({
  secciones,
  activa,
  onSeleccionar,
}: {
  secciones: { id: string; titulo: string; pendientes: number }[];
  activa: string;
  onSeleccionar: (id: string) => void;
}) {
  return (
    <nav className="section-nav">
      {secciones.map((s, i) => (
        <button
          key={s.id}
          type="button"
          onClick={() => onSeleccionar(s.id)}
          className={activa === s.id ? 'active' : undefined}
        >
          <span className="section-number">{i + 1}</span>
          <span>
            <b>{s.titulo}</b>
            <span className="detalle">{s.pendientes > 0 ? `${s.pendientes} pendiente(s)` : 'completa'}</span>
          </span>
        </button>
      ))}
    </nav>
  );
}
