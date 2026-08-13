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
  | 'RESOURCE_NOT_FOUND';

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
