import type { VistaDeComentarioSmartPR } from '@tcl-kol-os/db';
import { fechaHora } from './etiquetas';
import styles from './contenido.module.css';

function Comentario({
  c,
  campaignId,
  testId,
}: {
  c: VistaDeComentarioSmartPR;
  campaignId: string;
  testId: string;
}) {
  return (
    <li
      className={`${styles['item'] ?? ''} ${styles['itemSmartPR'] ?? ''}`}
      data-testid={testId}
      data-origen={c.origen}
      data-tipo={c.tipo}
      data-canal={c.canal}
    >
      <div className={styles['itemCabecera']}>
        <strong data-testid="contenido-comentario-autor">{c.autor}</strong>
        {c.esMio && <span className="pill neutro">Tú</span>}
        <span className={styles['itemMeta']}>{fechaHora(c.fecha)}</span>
        <span className="pill neutro" data-testid="contenido-comentario-canal">
          {c.canal === 'chat' ? 'Desde el chat' : 'Desde la interfaz'}
        </span>
        {c.canal === 'chat' && c.mensajeDeChatId !== undefined && (
          <a
            href={`/campanas/${campaignId}/chat#mensaje-${c.mensajeDeChatId}`}
            data-testid="contenido-comentario-chat-link"
          >
            Ver el mensaje en el chat
          </a>
        )}
      </div>
      <p className={styles['texto']} style={{ margin: 0 }} data-testid="contenido-comentario-texto-pintado">
        {c.texto}
      </p>
      {c.localizador !== undefined && <span className={styles['itemMeta']}>Ubicación: {c.localizador}</span>}
    </li>
  );
}

/**
 * COMENTARIOS DE SMARTPR: notas escritas por PERSONAS de la agencia (autor visible), sobre esta versión.
 * Van aparte de los hallazgos del Brief (`data-origen="smartpr"`): un hallazgo derivado no puede pasar por
 * un comentario humano. Los cambios solicitados son comentarios de tipo «cambio solicitado».
 */
export function SeccionComentarios({
  campaignId,
  comentarios,
  cambiosSolicitados,
}: {
  campaignId: string;
  comentarios: readonly VistaDeComentarioSmartPR[];
  cambiosSolicitados: readonly VistaDeComentarioSmartPR[];
}) {
  return (
    <section
      className={`card ${styles['seccionSmartPR'] ?? ''}`}
      aria-labelledby="contenido-comentarios-titulo"
      data-testid="contenido-comentarios"
      data-origen="smartpr"
    >
      <div className={styles['seccionCabecera']}>
        <div>
          <div className="eyebrow">SmartPR · persona</div>
          <h2 id="contenido-comentarios-titulo" className="plain-heading">
            Comentarios de SmartPR
          </h2>
          <p className={styles['nota']} style={{ margin: '4px 0 0' }}>
            Notas del equipo sobre esta versión. Cada una tiene su autor.
          </p>
        </div>
      </div>

      {comentarios.length === 0 && cambiosSolicitados.length === 0 && (
        <p className={styles['vacio']} data-testid="contenido-comentarios-vacio">
          Todavía no hay comentarios de SmartPR sobre esta versión.
        </p>
      )}

      {comentarios.length > 0 && (
        <ul className={styles['lista']}>
          {comentarios.map((c) => (
            <Comentario key={c.id} c={c} campaignId={campaignId} testId="contenido-comentario" />
          ))}
        </ul>
      )}

      {cambiosSolicitados.length > 0 && (
        <div data-testid="contenido-cambios-solicitados">
          <h3 className={styles['subtitulo']}>Cambios solicitados</h3>
          <ul className={styles['lista']}>
            {cambiosSolicitados.map((c) => (
              <Comentario key={c.id} c={c} campaignId={campaignId} testId="contenido-cambio-solicitado" />
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
