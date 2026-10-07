import styles from './operacion.module.css';

/**
 * Insignia de estado de una sección: rótulo + píldora. `testid` fija el `data-testid` de la píldora
 * (`estado-acuerdo`, `estado-logistica`…) y `valor` el valor crudo del estado en `data-valor` (un enum
 * cerrado, nunca datos de una persona).
 */
export function Insignia({
  rotulo,
  testid,
  valor,
  texto,
  clase,
}: {
  rotulo: string;
  testid: string;
  valor: string;
  texto: string;
  clase: string;
}) {
  return (
    <span className={styles['insignia']}>
      <span className={styles['insigniaRotulo']}>{rotulo}</span>
      <span className={clase} data-testid={testid} data-valor={valor}>
        {texto}
      </span>
    </span>
  );
}
