export function AlertaPreguntasCriticas({ campaignId, cantidad }: { campaignId: string; cantidad: number }) {
  if (cantidad === 0) return null;
  return (
    <div className="aviso error" style={{ marginBottom: 16 }}>
      <strong>{cantidad} pregunta(s) crítica(s) sin responder</strong>
      <p style={{ margin: '4px 0 0' }}>
        El brief no puede pasar a revisión interna mientras queden preguntas críticas pendientes.{' '}
        <a href={`/campanas/${campaignId}/brief/editar?panel=preguntas&status=pendiente`}>Responderlas ahora →</a>
      </p>
    </div>
  );
}
