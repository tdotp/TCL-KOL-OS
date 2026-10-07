/**
 * La evidencia operativa NO es material de lectura general (V2 · Fase 8, DEC-049).
 *
 * Una fuente `type = 'soporte_operativo'` (guía de envío, cuenta de cobro, comprobante, cotización) es
 * evidencia sensible de la operación: la migración 031 impone que no tenga procesamiento, fragmentos ni
 * visibilidad hacia TCL. Aquí, la regla de la APLICACIÓN (como `script-scope.ts`): NINGÚN rol la ve por los
 * listados y lecturas de fuentes, la búsqueda (vectorial y textual), la extracción, el contexto del agente
 * ni los adjuntos del chat. Solo los casos de uso de evidencia operativa (con la capacidad de su tipo de
 * evento) la exponen, consultando `operational_evidence` directamente.
 *
 * Un solo sitio para la regla. Alias `s` = source_documents.
 */

export const TIPO_SOPORTE_OPERATIVO = 'soporte_operativo';

/** Excluye la evidencia operativa de toda consulta que sirva «las fuentes de la campaña». */
export const SQL_FUENTE_SIN_EVIDENCIA_OPERATIVA = `(s.type::text <> '${TIPO_SOPORTE_OPERATIVO}')`;

/** Variante sin alias, para consultas directas sobre `source_documents`. */
export const SQL_FUENTE_SIN_EVIDENCIA_OPERATIVA_SIN_ALIAS = `(source_documents.type::text <> '${TIPO_SOPORTE_OPERATIVO}')`;

export function esEvidenciaOperativa(tipo: string): boolean {
  return tipo === TIPO_SOPORTE_OPERATIVO;
}
