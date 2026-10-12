'use client';

/** Error de `/tcl/**` (solo esta zona): mensaje genérico, sin detalles del fallo. */
export default function ErrorTcl({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="content content-wide">
      <div className="card empty-state" role="alert">
        <h1>No pudimos cargar esta pantalla</h1>
        <p>Ocurrió un problema inesperado. Inténtalo de nuevo en un momento.</p>
        <button type="button" className="btn" onClick={() => reset()}>
          Reintentar
        </button>
      </div>
    </div>
  );
}
