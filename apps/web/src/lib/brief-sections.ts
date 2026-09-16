/**
 * Los diez bloques canónicos de D0-05 §2.1, en el orden en que se navegan.
 * Compartido entre el editor interno (E7/UI-10) y la vista de solo lectura
 * del cliente (Fase D, Sprint 5) — la misma agrupación en ambos lados.
 */
export const ORDEN_DE_SECCIONES = [
  'contexto',
  'objetivo',
  'target_audiencia',
  'problema_insight',
  'marca_producto',
  'mandatorios',
  'mensaje_principal',
  'accion_kpis',
  'entregable_creativo',
  'practico',
];

export const TITULO_SECCION: Record<string, string> = {
  contexto: 'Contexto',
  objetivo: 'Objetivo',
  target_audiencia: 'Audiencia objetivo',
  problema_insight: 'Problema e insight',
  marca_producto: 'Marca y producto',
  mandatorios: 'Mandatorios',
  mensaje_principal: 'Mensaje principal',
  accion_kpis: 'Acción y KPIs',
  entregable_creativo: 'Entregable creativo',
  practico: 'Datos prácticos',
};
