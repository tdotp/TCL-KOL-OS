/**
 * Textos y constantes de presentación del contenido (V2 · Fase 7). Sin lógica de negocio y sin imports de
 * runtime de los paquetes (también lo usan los componentes cliente).
 */

export const ESTADO_DE_VERSION: Readonly<Record<string, string>> = {
  received: 'Recibida',
  in_review: 'En revisión',
  changes_requested: 'Cambios solicitados',
  approved: 'Aprobada',
  superseded: 'Reemplazada',
};

export const PILL_DE_VERSION: Readonly<Record<string, string>> = {
  received: 'pill neutro',
  in_review: 'pill curso',
  changes_requested: 'pill warn',
  approved: 'pill ok',
  superseded: 'pill neutro',
};

export const RESUMEN_DE_ENTREGABLE: Readonly<Record<string, string>> = {
  sin_guion: 'Sin guion',
  en_curso: 'En curso',
  cambios_solicitados: 'Cambios solicitados',
  aprobado: 'Aprobado',
  aprobado_con_nueva_en_revision: 'Aprobado · nueva versión en revisión',
};

export const PILL_DE_RESUMEN: Readonly<Record<string, string>> = {
  sin_guion: 'pill neutro',
  en_curso: 'pill curso',
  cambios_solicitados: 'pill warn',
  aprobado: 'pill ok',
  aprobado_con_nueva_en_revision: 'pill ok',
};

export const ETIQUETA_DE_VIGENCIA: Readonly<Record<string, string>> = {
  current: 'CURRENT',
  stale: 'STALE',
  none: 'Sin revisión',
  failed: 'Análisis fallido',
  running: 'Análisis en curso',
};

export const PILL_DE_VIGENCIA: Readonly<Record<string, string>> = {
  current: 'pill ok',
  stale: 'pill warn',
  none: 'pill neutro',
  failed: 'pill bad',
  running: 'pill curso',
};

export const TIPO_DE_REVISION: Readonly<Record<string, string>> = {
  ai_assisted: 'Revisión asistida por IA',
  human: 'Revisión humana',
};

export const CATEGORIA_DE_HALLAZGO: Readonly<Record<string, string>> = {
  cta_missing: 'Falta la llamada a la acción',
  key_message_incomplete: 'Mensaje clave incompleto',
  requirement_not_covered: 'Requisito del Brief sin cubrir',
  claim_unsupported: 'Afirmación sin respaldo',
  claim_contradicted: 'Afirmación contradicha por el Brief',
  restriction_violated: 'Restricción incumplida',
  brief_contradiction: 'Contradice el Brief',
};

export const BASE_DE_HALLAZGO: Readonly<Record<string, string>> = {
  absence: 'Ausencia',
  partial: 'Cobertura parcial',
  conflict: 'Conflicto',
};

export const ESTADO_DE_AFIRMACION: Readonly<Record<string, string>> = {
  unsupported: 'sin respaldo',
  contradicted: 'contradicha',
  supported: 'respaldada',
};

export const PILL_DE_SEVERIDAD: Readonly<Record<string, string>> = {
  alta: 'pill bad',
  media: 'pill warn',
  baja: 'pill neutro',
};

export const CRITICIDAD: Readonly<Record<string, string>> = {
  critico: 'crítico',
  claim: 'claim',
  importante: 'importante',
  informativo: 'informativo',
};

export const RELACION_DE_EVIDENCIA: Readonly<Record<string, string>> = {
  soporta: 'respalda',
  contradice: 'contradice',
  contexto: 'contexto',
};

export const PLATAFORMAS: readonly { readonly valor: string; readonly etiqueta: string }[] = [
  { valor: 'instagram', etiqueta: 'Instagram' },
  { valor: 'tiktok', etiqueta: 'TikTok' },
  { valor: 'youtube', etiqueta: 'YouTube' },
  { valor: 'x', etiqueta: 'X' },
  { valor: 'facebook', etiqueta: 'Facebook' },
  { valor: 'twitch', etiqueta: 'Twitch' },
];

/** Por qué no se puede pedir el análisis asistido, en lenguaje llano (texto fijo). */
export const MOTIVO_DE_PRONTITUD: Readonly<Record<string, string>> = {
  ai_disabled: 'La IA está desactivada en este entorno: el análisis asistido no está disponible.',
  no_governing_brief:
    'Todavía no existe un Brief aprobado para usar como documento rector. Aprueba el Brief de la campaña para poder revisar guiones.',
  source_queued:
    'El archivo del guion está en cola de procesamiento: el análisis estará disponible al terminar.',
  source_running: 'El archivo del guion se está procesando: el análisis estará disponible al terminar.',
  source_failed:
    'Falló el procesamiento del archivo del guion. Puedes revisarlo manualmente o subir otra versión.',
  source_no_text: 'El archivo del guion no tiene texto legible. Puedes revisarlo manualmente.',
  source_restricted: 'El asistente no puede leer este archivo (restringido). Puedes revisarlo manualmente.',
  source_unknown: 'El estado del archivo del guion no permite analizarlo todavía.',
  script_too_large: 'El guion es demasiado largo para el análisis asistido. Puedes revisarlo manualmente.',
};

const FORMATO_FECHA = new Intl.DateTimeFormat('es-CO', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  timeZone: 'America/Bogota',
});

const FORMATO_FECHA_HORA = new Intl.DateTimeFormat('es-CO', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  timeZone: 'America/Bogota',
});

/** Fecha legible en hora de Colombia (determinista entre servidor y cliente). */
export function fecha(iso: string | undefined): string {
  if (iso === undefined) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : FORMATO_FECHA.format(d);
}

export function fechaHora(iso: string | undefined): string {
  if (iso === undefined) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : FORMATO_FECHA_HORA.format(d);
}

/** Primeros 8 caracteres de la huella (SHA-256) para mostrarla sin ruido. */
export function huellaCorta(huella: string): string {
  return huella.slice(0, 8);
}

/** «Reel principal · Instagram»: la etiqueta de un entregable con su plataforma informativa. */
export function etiquetaDePlataforma(valor: string | undefined): string | undefined {
  return valor === undefined ? undefined : (PLATAFORMAS.find((p) => p.valor === valor)?.etiqueta ?? valor);
}

/** Tamaño máximo de archivo que declara la interfaz (el servidor lo vuelve a imponer). */
export const ACEPTA_GUIONES = '.pdf,.pptx,.docx,.xlsx,.csv,.md,.png,.jpg,.jpeg';
