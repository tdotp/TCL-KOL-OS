/**
 * Catálogo de tareas de IA y su nivel de modelo (Épica E11-6).
 *
 * Traduce la tabla §9.2 del documento maestro a algo ejecutable.
 *
 * El dominio conoce **tareas y niveles**, nunca nombres de modelo. Qué modelo
 * concreto responde a cada nivel es configuración, y se decide midiendo contra
 * el gold set (D0-13) — no por opinión ni por lo que esté de moda.
 *
 * Esa separación es lo que hace real el criterio de E11-1: cambiar de modelo o
 * de proveedor no toca una línea de lógica de negocio.
 */

/** Nivel de capacidad, no un modelo concreto. */
export type ModelTier = 'eficiente' | 'equilibrado' | 'avanzado';

export const MODEL_TIERS: readonly ModelTier[] = ['eficiente', 'equilibrado', 'avanzado'] as const;

/** Tareas de IA del sistema. Corresponden una a una con la tabla §9.2. */
export type AITask =
  | 'extraer_campos'
  | 'detectar_vacios'
  | 'traducir'
  | 'redactar_brief'
  | 'buscar_evidencia'
  | 'resolver_ambiguedad'
  | 'generar_embedding';

export interface AITaskSpec {
  readonly task: AITask;
  readonly tier: ModelTier;
  /** Qué revisa una persona antes de que el resultado cuente (§9.2, columna Control). */
  readonly control: string;
  /** Si la salida debe validarse contra el JSON Schema del brief. */
  readonly salidaEstructurada: boolean;
  /**
   * Si la tarea puede inventar contenido. Las que no —búsqueda y embeddings—
   * no necesitan las guardas anti-alucinación porque no generan texto.
   */
  readonly generativa: boolean;
}

const CATALOGO: Readonly<Record<AITask, AITaskSpec>> = {
  extraer_campos: {
    task: 'extraer_campos',
    tier: 'eficiente',
    control: 'El consultor confirma los campos críticos antes de avanzar.',
    salidaEstructurada: true,
    generativa: true,
  },
  detectar_vacios: {
    task: 'detectar_vacios',
    tier: 'equilibrado',
    control: 'Cada vacío se convierte en una pregunta que responde una persona.',
    salidaEstructurada: true,
    generativa: true,
  },
  traducir: {
    task: 'traducir',
    tier: 'eficiente',
    control: 'Revisión técnica con glosario de términos bloqueados.',
    salidaEstructurada: false,
    generativa: true,
  },
  redactar_brief: {
    task: 'redactar_brief',
    tier: 'equilibrado',
    control: 'Edición y aprobación humana; la IA nunca aprueba (ADR-002).',
    salidaEstructurada: true,
    generativa: true,
  },
  buscar_evidencia: {
    task: 'buscar_evidencia',
    // §9.2: "sin generación o eficiente". La búsqueda vectorial no inventa;
    // recupera fragmentos que ya existen.
    tier: 'eficiente',
    control: 'La evidencia queda visible y se puede abrir en su fuente.',
    salidaEstructurada: false,
    generativa: false,
  },
  resolver_ambiguedad: {
    task: 'resolver_ambiguedad',
    // §9.2: "avanzado solo si aporta". Es la única tarea que justifica el nivel
    // caro, y aun así nunca decide: propone.
    tier: 'avanzado',
    control: 'Nunca aprobación automática. Un conflicto lo resuelve una persona.',
    salidaEstructurada: true,
    generativa: true,
  },
  generar_embedding: {
    task: 'generar_embedding',
    tier: 'eficiente',
    control: 'No aplica: no produce texto para revisar.',
    salidaEstructurada: false,
    generativa: false,
  },
};

export function specFor(task: AITask): AITaskSpec {
  return CATALOGO[task];
}

export function tierFor(task: AITask): ModelTier {
  return CATALOGO[task].tier;
}

export function allTasks(): readonly AITaskSpec[] {
  return Object.values(CATALOGO);
}

/**
 * Tareas que exigen las guardas anti-alucinación de §9.4.
 *
 * Solo las generativas: una búsqueda vectorial devuelve fragmentos reales, no
 * puede fabricarlos.
 */
export function tareasGenerativas(): readonly AITask[] {
  return allTasks()
    .filter((s) => s.generativa)
    .map((s) => s.task);
}
