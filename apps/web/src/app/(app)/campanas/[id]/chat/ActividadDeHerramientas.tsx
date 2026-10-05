import type { VistaDeActividad } from '@tcl-kol-os/db';
import { ESTADO_DE_ACTIVIDAD } from './etiquetas';
import styles from './chat.module.css';

const PUNTO: Readonly<Record<VistaDeActividad['estado'], string>> = {
  en_curso: styles['puntoCurso'] ?? '',
  completada: styles['puntoOk'] ?? '',
  fallida: styles['puntoMal'] ?? '',
  cancelada: styles['puntoNeutro'] ?? '',
};

const TIPO: Readonly<Record<VistaDeActividad['tipo'], string>> = {
  consulta: 'consulta',
  cambio: 'cambio en la campaña',
  propuesta: 'propuesta para confirmar',
};

/**
 * Qué hizo el asistente en este turno, en lenguaje llano y plegado: una línea por herramienta
 * con su etiqueta en español y el resultado («listo», «no se pudo completar»…). Nunca muestra
 * nombres internos, argumentos, resultados en bruto ni razonamiento del modelo.
 */
export function ActividadDeHerramientas({ items }: { items: readonly VistaDeActividad[] }) {
  if (items.length === 0) return null;
  const enCurso = items.some((i) => i.estado === 'en_curso');
  return (
    <details className={styles['actividad']} data-testid="chat-activity" open={enCurso}>
      <summary>
        Actividad del asistente ({items.length} {items.length === 1 ? 'paso' : 'pasos'})
      </summary>
      <ul>
        {items.map((i) => (
          <li key={i.id} data-testid="chat-activity-item" data-estado={i.estado} data-tipo={i.tipo}>
            <span className={PUNTO[i.estado]} aria-hidden="true" />
            <span>
              {i.etiqueta} — {ESTADO_DE_ACTIVIDAD[i.estado] ?? i.estado}
              {i.tipo !== 'consulta' ? ` (${TIPO[i.tipo]})` : ''}
            </span>
          </li>
        ))}
      </ul>
    </details>
  );
}
