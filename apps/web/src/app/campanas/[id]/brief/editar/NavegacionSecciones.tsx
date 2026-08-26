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
    <nav className="row" style={{ gap: 6, marginBottom: 16, flexWrap: 'wrap' }}>
      {secciones.map((s) => (
        <button
          key={s.id}
          type="button"
          onClick={() => onSeleccionar(s.id)}
          className={`pill ${activa === s.id ? 'ok' : s.pendientes > 0 ? 'warn' : ''}`}
          style={{ cursor: 'pointer', border: 'none' }}
        >
          {s.titulo}
          {s.pendientes > 0 && ` (${s.pendientes})`}
        </button>
      ))}
    </nav>
  );
}
