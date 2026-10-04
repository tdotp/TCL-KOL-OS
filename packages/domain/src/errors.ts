/**
 * Errores tipados del dominio.
 *
 * La sección 11.6 del documento maestro exige que los errores expuestos lleven
 * código, mensaje y `requestId`, y que NO revelen prompts de sistema, tokens,
 * rutas internas ni trazas sensibles.
 */

export type DomainErrorCode =
  | 'BRIEF_INVALID_TRANSITION'
  | 'BRIEF_VERSION_IMMUTABLE'
  | 'BRIEF_MISSING_EVIDENCE'
  | 'BRIEF_UNRESOLVED_CONFLICT'
  | 'BRIEF_MISSING_CRITICAL_FIELD'
  | 'BRIEF_PENDING_QUESTIONS'
  | 'TRANSLATION_MISSING_ORIGIN'
  /**
   * La extracción asistida no pudo completarse: el proveedor no respondió, o
   * respondió algo que no cumple el contrato (E5-3).
   *
   * Es un código aparte y no un error genérico porque el camino de salida es
   * distinto: no se reintenta a ciegas ni se bloquea el trabajo. El brief se
   * puede seguir llenando a mano —principio 9 de §5, la IA nunca es requisito—
   * y la interfaz necesita poder decirlo.
   */
  | 'AI_EXTRACTION_FAILED'
  | 'FORBIDDEN_ROLE'
  | 'RESOURCE_NOT_FOUND'
  /** Un campo del brief no cumple una regla de integridad (p. ej. de producto sin anclar). */
  | 'BRIEF_FIELD_INVALID'
  /**
   * Control de concurrencia optimista (Sprint 4, corrección 7 del cierre): el
   * guardado llegó con una `revision` que ya no coincide con la actual —
   * alguien más modificó el campo primero. Nunca se aplica "el último que
   * escribe gana" en silencio.
   */
  | 'FIELD_REVISION_CONFLICT'
  /**
   * Una acción crítica (p. ej. aprobar) llegó por un canal que no es una
   * persona actuando directamente, o sin confirmación humana válida (V2 ·
   * Fase 1D). Debe pasar por una acción propuesta confirmada por un humano.
   */
  | 'HUMAN_CONFIRMATION_REQUIRED'
  /** La acción propuesta no está en el estado que exige la operación. */
  | 'PROPOSAL_INVALID_STATE'
  | 'PROPOSAL_EXPIRED'
  /** El contenido cambió entre la propuesta y la confirmación/ejecución. */
  | 'PROPOSAL_STALE'
  /** Una traducción ya no corresponde al valor original vigente (V2 · Fase 2). */
  | 'TRANSLATION_STALE'
  /** Falta una representación lingüística requerida de la versión (V2 · Fase 2). */
  | 'REPRESENTATION_MISSING'
  /** La entrada no cumple una regla de formato o integridad (V2 · Fase 3). */
  | 'VALIDATION_FAILED'
  /**
   * La operación choca con el estado actual de un recurso: ya existe (duplicado),
   * o su estado no la admite (V2 · Fase 3). `details` indica cuál es el recurso.
   */
  | 'RESOURCE_CONFLICT';

export interface DomainErrorPayload {
  readonly code: DomainErrorCode;
  readonly message: string;
  readonly details?: Readonly<Record<string, unknown>> | undefined;
}

export class DomainError extends Error {
  readonly code: DomainErrorCode;
  readonly details: Readonly<Record<string, unknown>> | undefined;

  constructor(payload: DomainErrorPayload) {
    super(payload.message);
    this.name = 'DomainError';
    this.code = payload.code;
    this.details = payload.details;
  }

  /**
   * Serializa el error para respuesta de API.
   * `requestId` lo inyecta la capa HTTP, no el dominio.
   */
  toJSON(requestId: string): {
    error: { code: DomainErrorCode; message: string; requestId: string; details: Record<string, unknown> };
  } {
    return {
      error: {
        code: this.code,
        message: this.message,
        requestId,
        details: { ...(this.details ?? {}) },
      },
    };
  }
}

/** Resultado de una operación que puede fallar por reglas de negocio. */
export type Result<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: DomainError };

export function ok<T>(value: T): Result<T> {
  return { ok: true, value };
}

export function err<T>(payload: DomainErrorPayload): Result<T> {
  return { ok: false, error: new DomainError(payload) };
}
