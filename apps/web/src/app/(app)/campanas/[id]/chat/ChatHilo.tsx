import type {
  VistaDeAccionPropuesta,
  VistaDeActividad,
  VistaDeAdjunto,
  VistaDeChat,
  VistaDeMensaje,
  VistaDeRun,
} from '@tcl-kol-os/db';
import { ActividadDeHerramientas } from './ActividadDeHerramientas';
import { AutoScroll } from './AutoScroll';
import { EstadoDeRun } from './EstadoDeRun';
import { TarjetaAccionPropuesta } from './TarjetaAccionPropuesta';
import { fechaHora } from './etiquetas';
import styles from './chat.module.css';

function agrupar<T, K>(items: readonly T[], clave: (t: T) => K | undefined): Map<K, T[]> {
  const mapa = new Map<K, T[]>();
  for (const i of items) {
    const k = clave(i);
    if (k === undefined) continue;
    const lista = mapa.get(k) ?? [];
    lista.push(i);
    mapa.set(k, lista);
  }
  return mapa;
}

function Adjuntos({ items }: { items: readonly VistaDeAdjunto[] }) {
  if (items.length === 0) return null;
  return (
    <ul
      className={styles.chips}
      aria-label="Archivos adjuntos"
      style={{ listStyle: 'none', padding: 0, margin: '6px 0 0' }}
    >
      {items.map((a) => (
        <li
          key={a.sourceId}
          className={styles.chip}
          data-testid="chat-message-attachment"
          data-estado={a.estado}
        >
          <span className={styles.chipNombre} title={a.nombre}>
            {a.nombre}
          </span>
          <span className={styles.chipEstado} data-estado={a.estado}>
            {a.etiquetaDeEstado}
          </span>
        </li>
      ))}
    </ul>
  );
}

/**
 * Un mensaje del hilo. TEXTO PLANO: el contenido se pinta como nodo de texto (React lo
 * escapa) con `white-space: pre-wrap`; no hay markdown, HTML, imágenes ni autoenlaces. Las
 * citas son referencias a fuentes de la campaña (enlaces internos), nunca URL externas.
 */
function Mensaje({ campaignId, m }: { campaignId: string; m: VistaDeMensaje }) {
  const propio = m.role === 'user';
  return (
    <article
      className={`${styles['mensaje'] ?? ''} ${propio ? (styles['usuario'] ?? '') : (styles['asistente'] ?? '')}`}
      data-testid="chat-message"
      data-role={m.role}
      data-seq={m.seq}
    >
      <div className={styles.meta}>
        <strong>{propio ? 'Tú' : 'Asistente'}</strong> · {fechaHora(m.createdAt)}
      </div>
      <div className={styles.burbuja}>
        <p className={styles.texto} data-testid="chat-message-content">
          {m.content}
        </p>
        <Adjuntos items={m.attachments} />
        {m.citations.length > 0 && (
          <details className={styles.citas} data-testid="chat-citations">
            <summary>Fuentes citadas ({m.citations.length})</summary>
            <ol>
              {m.citations.map((c) => (
                <li key={c.ordinal} data-testid="chat-citation" data-ordinal={c.ordinal}>
                  <a href={`/campanas/${campaignId}/fuentes/${c.sourceId}`}>{c.fuente}</a>
                  {c.ubicacion !== undefined ? ` · ${c.ubicacion}` : ''}
                </li>
              ))}
            </ol>
          </details>
        )}
      </div>
    </article>
  );
}

function etiquetaEnCurso(actividad: readonly VistaDeActividad[]): string | undefined {
  return [...actividad].reverse().find((a) => a.estado === 'en_curso')?.etiqueta;
}

/**
 * El hilo: mensajes en orden y, tras cada mensaje del usuario, lo que pasó en su turno
 * (actividad de herramientas plegada, respuesta, estado del run, acciones propuestas).
 */
export function ChatHilo({ campaignId, vista }: { campaignId: string; vista: VistaDeChat | null }) {
  if (vista === null || vista.messages.length === 0) {
    return (
      <div
        className={styles.hilo}
        role="log"
        aria-label="Conversación con el asistente"
        tabIndex={0}
        data-testid="chat-thread"
      >
        <div className={styles.vacio} data-testid="chat-empty">
          <strong>Empieza una conversación</strong>
          Pídele que revise el brief, busque algo en las fuentes, o prepare un cambio. Todo lo que modifique
          la campaña lo verás aquí, y lo irreversible solo se aplica cuando lo confirmas tú.
        </div>
      </div>
    );
  }

  const runsPorMensaje = agrupar<VistaDeRun, string>(vista.runs, (r) => r.userMessageId);
  const actividadPorRun = agrupar<VistaDeActividad, string>(vista.activity, (a) => a.runId);
  const propuestasPorRun = agrupar<VistaDeAccionPropuesta, string>(vista.proposals, (p) => p.runId);
  const asistentePorRun = new Map<string, VistaDeMensaje>(
    vista.messages.filter((m) => m.role === 'assistant' && m.runId !== undefined).map((m) => [m.runId!, m]),
  );
  const ultimoRun = vista.runs.at(-1);

  const yaMostrados = new Set<string>(); // asistente y propuestas pintados dentro de su turno
  const propuestasMostradas = new Set<string>();
  const bloques: React.ReactNode[] = [];

  for (const m of vista.messages) {
    if (m.role === 'assistant') {
      if (!yaMostrados.has(m.id)) bloques.push(<Mensaje key={m.id} campaignId={campaignId} m={m} />);
      continue;
    }
    bloques.push(<Mensaje key={m.id} campaignId={campaignId} m={m} />);
    for (const run of runsPorMensaje.get(m.id) ?? []) {
      const actividad = actividadPorRun.get(run.id) ?? [];
      bloques.push(<ActividadDeHerramientas key={`act-${run.id}`} items={actividad} />);

      const respuesta = asistentePorRun.get(run.id);
      if (respuesta !== undefined) {
        yaMostrados.add(respuesta.id);
        bloques.push(<Mensaje key={respuesta.id} campaignId={campaignId} m={respuesta} />);
      }

      const esElUltimo = ultimoRun !== undefined && run.id === ultimoRun.id;
      if (run.status !== 'completed') {
        if (esElUltimo) {
          bloques.push(
            <EstadoDeRun
              key={`est-${run.id}`}
              campaignId={campaignId}
              run={run}
              etiquetaActiva={etiquetaEnCurso(actividad)}
            />,
          );
        } else {
          bloques.push(
            <p key={`ant-${run.id}`} className={styles.nota} data-testid="chat-run-previous">
              El intento {run.attempt} no se completó; se volvió a intentar.
            </p>,
          );
        }
      }

      for (const p of propuestasPorRun.get(run.id) ?? []) {
        propuestasMostradas.add(p.id);
        bloques.push(<TarjetaAccionPropuesta key={`prop-${p.id}`} campaignId={campaignId} accion={p} />);
      }
    }
  }

  // Propuestas de la conversación cuyo turno ya no está en la ventana mostrada.
  for (const p of vista.proposals) {
    if (!propuestasMostradas.has(p.id)) {
      bloques.push(<TarjetaAccionPropuesta key={`prop-${p.id}`} campaignId={campaignId} accion={p} />);
    }
  }

  const clave = `${vista.messages.at(-1)?.id ?? ''}|${ultimoRun?.id ?? ''}:${ultimoRun?.status ?? ''}|${vista.activity.length}|${vista.proposals.map((p) => p.estado).join('')}`;

  return (
    <div
      className={styles.hilo}
      role="log"
      aria-label="Conversación con el asistente"
      tabIndex={0}
      data-testid="chat-thread"
    >
      {bloques}
      <AutoScroll clave={clave} />
    </div>
  );
}
