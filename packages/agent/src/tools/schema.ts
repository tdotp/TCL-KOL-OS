/**
 * Validador de argumentos de tools, hecho en casa (V2 · Fase 6, D15 / sin dependencias).
 *
 * Implementa un subconjunto CERRADO de JSON Schema, suficiente para los argumentos
 * de las tools y nada más:
 *
 *   object   `properties`, `required`, `additionalProperties: false` (obligatorio)
 *   string   `minLength`, `maxLength`, `pattern`, `format: 'uuid' | 'date'`, `enum`
 *   integer / number   `minimum`, `maximum`
 *   boolean
 *   array    `items`, `minItems`, `maxItems`
 *   enum     lista cerrada de literales (string / number / boolean)
 *   {}       «JSON acotado»: cualquier valor JSON, con tope de profundidad y de tamaño.
 *            Es la única extensión; la usa `answerValue`, cuyo tipo depende del campo.
 *
 * Reglas de seguridad (los argumentos los escribe un modelo, es decir, NO son de fiar):
 *   · Una clave que no esté declarada se rechaza (`additionalProperties: false`), y las
 *     que nombran identidad, canal o ámbito (`actor`, `userId`, `organizationId`,
 *     `campaignId`, `origin`, `canal`, `assignedTo`, `status`…) se rechazan con una
 *     razón propia (`forbidden_key`): jamás las aporta el modelo.
 *   · `__proto__`, `constructor` y `prototype` se rechazan a cualquier profundidad.
 *   · Solo objetos planos; sin ciclos; sin NUL; tamaño total y profundidad acotados.
 *   · El resultado es una COPIA con solo las claves declaradas.
 */

// ─────────────────────────── Tipos del subconjunto ─────────────────────────────

interface Base {
  readonly description?: string;
}

export interface StringSchema extends Base {
  readonly type: 'string';
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly pattern?: string;
  readonly format?: 'uuid' | 'date';
  readonly enum?: readonly string[];
}

export interface NumberSchema extends Base {
  readonly type: 'integer' | 'number';
  readonly minimum?: number;
  readonly maximum?: number;
}

export interface BooleanSchema extends Base {
  readonly type: 'boolean';
}

export interface ArraySchema extends Base {
  readonly type: 'array';
  readonly items: JsonSchema;
  readonly minItems?: number;
  readonly maxItems?: number;
}

export interface ObjectSchema extends Base {
  readonly type: 'object';
  readonly properties: Readonly<Record<string, JsonSchema>>;
  readonly required?: readonly string[];
  readonly additionalProperties: false;
}

export interface EnumSchema extends Base {
  readonly enum: readonly (string | number | boolean)[];
}

/** «Cualquier JSON acotado»: solo descripción. */
export interface AnySchema extends Base {
  readonly type?: undefined;
  readonly enum?: undefined;
}

export type JsonSchema =
  StringSchema | NumberSchema | BooleanSchema | ArraySchema | ObjectSchema | EnumSchema | AnySchema;

// ─────────────────────────── Límites ───────────────────────────────────────────

/** Tamaño máximo (UTF-8) de los argumentos completos de una llamada. */
export const MAX_ARGS_BYTES = 16_384;
export const MAX_ARGS_DEPTH = 6;
const MAX_CLAVES_POR_OBJETO = 50;
const MAX_ELEMENTOS_POR_DEFECTO = 50;
const MAX_TEXTO_POR_DEFECTO = 4_000;
/** Un valor «JSON acotado» (`{}`) ocupa como mucho esto. */
const MAX_ANY_BYTES = 2_048;
const MAX_ANY_PROFUNDIDAD = 4;

/** Claves que el modelo NUNCA aporta: identidad, ámbito, canal y estado ya decididos por el servidor. */
export const CLAVES_PROHIBIDAS_DEL_MODELO: ReadonlySet<string> = new Set([
  'actor',
  'user',
  'userid',
  'user_id',
  'organization',
  'organizationid',
  'organization_id',
  'orgid',
  'campaign',
  'campaignid',
  'campaign_id',
  'conversationid',
  'messageid',
  'agentrunid',
  'toolinvocationid',
  'correlation',
  'origin',
  'origen',
  'canal',
  'channel',
  'assignedto',
  'assigned_to',
  'status',
  'role',
  'rol',
  'proposedby',
  'confirmedby',
  'decidedby',
  'createdby',
  'visibility',
  'confidentiality',
  'confidentialitylevel',
]);

const CLAVES_PELIGROSAS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type RazonDeIncidencia =
  | 'not_object'
  | 'too_large'
  | 'too_deep'
  | 'required'
  | 'unknown_key'
  | 'forbidden_key'
  | 'dangerous_key'
  | 'type'
  | 'format'
  | 'range'
  | 'enum'
  | 'length'
  | 'pattern'
  | 'items'
  | 'nul';

export interface IncidenciaDeEsquema {
  /** Ruta con puntos (`decision.kind`); vacía en la raíz. */
  readonly path: string;
  readonly reason: RazonDeIncidencia;
  readonly message: string;
}

export type ResultadoDeValidacion =
  | { readonly ok: true; readonly value: Record<string, unknown> }
  | { readonly ok: false; readonly issues: readonly IncidenciaDeEsquema[] };

// ─────────────────────────── Validación del propio esquema ─────────────────────

/**
 * Comprueba que un esquema está dentro del subconjunto cerrado. Lanza `Error` (es un
 * defecto de programación, no una entrada del modelo): todo objeto declara
 * `additionalProperties: false`, `required` ⊆ `properties`, ninguna propiedad se llama
 * como una clave prohibida y los patrones compilan.
 */
export function assertEsquemaCerrado(schema: JsonSchema, ruta = ''): void {
  if ('type' in schema && schema.type === 'object') {
    if (schema.additionalProperties !== false) {
      throw new Error(`Esquema «${ruta}»: un objeto debe declarar additionalProperties: false.`);
    }
    for (const [clave, hijo] of Object.entries(schema.properties)) {
      if (CLAVES_PROHIBIDAS_DEL_MODELO.has(clave.toLowerCase()) || CLAVES_PELIGROSAS.has(clave)) {
        throw new Error(`Esquema «${ruta}»: la propiedad «${clave}» no puede aportarla el modelo.`);
      }
      assertEsquemaCerrado(hijo, ruta === '' ? clave : `${ruta}.${clave}`);
    }
    for (const r of schema.required ?? []) {
      if (!Object.hasOwn(schema.properties, r)) {
        throw new Error(`Esquema «${ruta}»: «${r}» es obligatoria pero no está declarada.`);
      }
    }
    return;
  }
  if ('type' in schema && schema.type === 'array') {
    assertEsquemaCerrado(schema.items, `${ruta}[]`);
    return;
  }
  if ('type' in schema && schema.type === 'string' && schema.pattern !== undefined) {
    new RegExp(schema.pattern, 'u');
  }
}

// ─────────────────────────── Validación de argumentos ──────────────────────────

function esObjetoPlano(valor: unknown): valor is Record<string, unknown> {
  if (typeof valor !== 'object' || valor === null || Array.isArray(valor)) return false;
  const proto: unknown = Object.getPrototypeOf(valor);
  return proto === Object.prototype || proto === null;
}

function fechaIsoValida(valor: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(valor)) return false;
  const [anio, mes, dia] = valor.split('-').map(Number) as [number, number, number];
  const f = new Date(Date.UTC(anio, mes - 1, dia));
  return f.getUTCFullYear() === anio && f.getUTCMonth() === mes - 1 && f.getUTCDate() === dia;
}

function bytesUtf8(texto: string): number {
  return Buffer.byteLength(texto, 'utf8');
}

class Validador {
  readonly issues: IncidenciaDeEsquema[] = [];
  private readonly vistos = new WeakSet<object>();

  private falla(path: string, reason: RazonDeIncidencia, message: string): undefined {
    if (this.issues.length < 20) this.issues.push({ path, reason, message });
    return undefined;
  }

  private hijo(path: string, clave: string | number): string {
    return typeof clave === 'number' ? `${path}[${clave}]` : path === '' ? clave : `${path}.${clave}`;
  }

  valida(schema: JsonSchema, valor: unknown, path: string, profundidad: number): unknown {
    if (profundidad > MAX_ARGS_DEPTH) {
      return this.falla(path, 'too_deep', 'El valor está demasiado anidado.');
    }
    if ('type' in schema && schema.type !== undefined) {
      switch (schema.type) {
        case 'object':
          return this.objeto(schema, valor, path, profundidad);
        case 'array':
          return this.lista(schema, valor, path, profundidad);
        case 'string':
          return this.texto(schema, valor, path);
        case 'integer':
        case 'number':
          return this.numero(schema, valor, path);
        case 'boolean':
          if (typeof valor !== 'boolean') return this.falla(path, 'type', 'Debe ser verdadero o falso.');
          return valor;
      }
    }
    if ('enum' in schema && schema.enum !== undefined) {
      if (!(schema.enum as readonly unknown[]).includes(valor)) {
        return this.falla(path, 'enum', `Debe ser uno de: ${schema.enum.map(String).join(', ')}.`);
      }
      return valor;
    }
    return this.cualquiera(valor, path);
  }

  private objeto(schema: ObjectSchema, valor: unknown, path: string, profundidad: number): unknown {
    if (!esObjetoPlano(valor)) return this.falla(path, 'not_object', 'Debe ser un objeto.');
    if (this.vistos.has(valor)) return this.falla(path, 'type', 'El valor tiene referencias circulares.');
    this.vistos.add(valor);
    try {
      const claves = Object.keys(valor);
      if (claves.length > MAX_CLAVES_POR_OBJETO) {
        return this.falla(path, 'too_large', 'El objeto tiene demasiadas claves.');
      }
      for (const clave of claves) {
        if (CLAVES_PELIGROSAS.has(clave)) {
          this.falla(this.hijo(path, clave), 'dangerous_key', 'Clave no permitida.');
        } else if (CLAVES_PROHIBIDAS_DEL_MODELO.has(clave.toLowerCase())) {
          this.falla(
            this.hijo(path, clave),
            'forbidden_key',
            'Esta clave la fija el servidor (identidad, campaña, canal o estado); no se acepta como argumento.',
          );
        } else if (!Object.hasOwn(schema.properties, clave)) {
          this.falla(this.hijo(path, clave), 'unknown_key', 'Argumento no reconocido.');
        }
      }
      for (const r of schema.required ?? []) {
        if (!Object.hasOwn(valor, r) || valor[r] === undefined) {
          this.falla(this.hijo(path, r), 'required', 'Falta este argumento obligatorio.');
        }
      }
      const salida: Record<string, unknown> = {};
      for (const [clave, hijoSchema] of Object.entries(schema.properties)) {
        if (!Object.hasOwn(valor, clave) || valor[clave] === undefined) continue;
        const v = this.valida(hijoSchema, valor[clave], this.hijo(path, clave), profundidad + 1);
        if (v !== undefined) salida[clave] = v;
      }
      return salida;
    } finally {
      this.vistos.delete(valor);
    }
  }

  private lista(schema: ArraySchema, valor: unknown, path: string, profundidad: number): unknown {
    if (!Array.isArray(valor)) return this.falla(path, 'type', 'Debe ser una lista.');
    const min = schema.minItems ?? 0;
    const max = schema.maxItems ?? MAX_ELEMENTOS_POR_DEFECTO;
    if (valor.length < min || valor.length > max) {
      return this.falla(path, 'items', `La lista debe tener entre ${min} y ${max} elementos.`);
    }
    const salida: unknown[] = [];
    for (const [i, e] of valor.entries()) {
      const v = this.valida(schema.items, e, this.hijo(path, i), profundidad + 1);
      if (v !== undefined) salida.push(v);
    }
    return salida;
  }

  private texto(schema: StringSchema, valor: unknown, path: string): unknown {
    if (typeof valor !== 'string') return this.falla(path, 'type', 'Debe ser un texto.');
    if (valor.includes('\u0000')) return this.falla(path, 'nul', 'El texto contiene caracteres no válidos.');
    const min = schema.minLength ?? 0;
    const max = schema.maxLength ?? MAX_TEXTO_POR_DEFECTO;
    if (valor.length < min || valor.length > max) {
      return this.falla(path, 'length', `El texto debe tener entre ${min} y ${max} caracteres.`);
    }
    if (schema.enum !== undefined && !schema.enum.includes(valor)) {
      return this.falla(path, 'enum', `Debe ser uno de: ${schema.enum.join(', ')}.`);
    }
    if (schema.format === 'uuid' && !UUID.test(valor)) {
      return this.falla(path, 'format', 'Debe ser un identificador (UUID) válido.');
    }
    if (schema.format === 'date' && !fechaIsoValida(valor)) {
      return this.falla(path, 'format', 'Debe ser una fecha real con formato AAAA-MM-DD.');
    }
    if (schema.pattern !== undefined && !new RegExp(schema.pattern, 'u').test(valor)) {
      return this.falla(path, 'pattern', 'El texto no tiene el formato esperado.');
    }
    return valor;
  }

  private numero(schema: NumberSchema, valor: unknown, path: string): unknown {
    if (typeof valor !== 'number' || !Number.isFinite(valor)) {
      return this.falla(path, 'type', 'Debe ser un número.');
    }
    if (schema.type === 'integer' && !Number.isSafeInteger(valor)) {
      return this.falla(path, 'type', 'Debe ser un número entero.');
    }
    if (
      (schema.minimum !== undefined && valor < schema.minimum) ||
      (schema.maximum !== undefined && valor > schema.maximum)
    ) {
      return this.falla(
        path,
        'range',
        `Debe estar entre ${schema.minimum ?? '-∞'} y ${schema.maximum ?? '∞'}.`,
      );
    }
    return valor;
  }

  /** «JSON acotado»: cualquier valor JSON sin claves peligrosas, poco profundo y pequeño. */
  private cualquiera(valor: unknown, path: string): unknown {
    const limpio = this.limpiarCualquiera(valor, path, 0);
    if (limpio === undefined) return undefined;
    let json: string;
    try {
      json = JSON.stringify(limpio);
    } catch {
      return this.falla(path, 'type', 'El valor no es JSON.');
    }
    if (bytesUtf8(json) > MAX_ANY_BYTES) {
      return this.falla(path, 'too_large', `El valor excede ${MAX_ANY_BYTES} bytes.`);
    }
    return limpio;
  }

  private limpiarCualquiera(valor: unknown, path: string, profundidad: number): unknown {
    if (valor === null || typeof valor === 'boolean') return valor;
    if (typeof valor === 'number') {
      return Number.isFinite(valor) ? valor : this.falla(path, 'type', 'Número no válido.');
    }
    if (typeof valor === 'string') {
      return valor.includes('\u0000') ? this.falla(path, 'nul', 'Texto no válido.') : valor;
    }
    if (profundidad >= MAX_ANY_PROFUNDIDAD) return this.falla(path, 'too_deep', 'Demasiado anidado.');
    if (Array.isArray(valor)) {
      if (valor.length > MAX_ELEMENTOS_POR_DEFECTO)
        return this.falla(path, 'items', 'Lista demasiado larga.');
      const salida: unknown[] = [];
      for (const [i, e] of valor.entries()) {
        const v = this.limpiarCualquiera(e, this.hijo(path, i), profundidad + 1);
        if (v === undefined) return undefined;
        salida.push(v);
      }
      return salida;
    }
    if (!esObjetoPlano(valor)) return this.falla(path, 'type', 'Solo se admite JSON.');
    if (this.vistos.has(valor)) return this.falla(path, 'type', 'Referencia circular.');
    this.vistos.add(valor);
    try {
      const claves = Object.keys(valor);
      if (claves.length > MAX_CLAVES_POR_OBJETO) return this.falla(path, 'too_large', 'Demasiadas claves.');
      const salida: Record<string, unknown> = {};
      for (const clave of claves) {
        if (CLAVES_PELIGROSAS.has(clave)) {
          return this.falla(this.hijo(path, clave), 'dangerous_key', 'Clave no permitida.');
        }
        const v = this.limpiarCualquiera(valor[clave], this.hijo(path, clave), profundidad + 1);
        if (v === undefined) {
          if (valor[clave] === undefined) continue;
          return undefined;
        }
        salida[clave] = v;
      }
      return salida;
    } finally {
      this.vistos.delete(valor);
    }
  }
}

/**
 * Valida los argumentos de una llamada contra el esquema (objeto raíz cerrado).
 * Nunca lanza: devuelve las incidencias. El valor devuelto es una copia limpia.
 */
export function validarArgumentos(schema: ObjectSchema, valor: unknown): ResultadoDeValidacion {
  if (!esObjetoPlano(valor)) {
    return {
      ok: false,
      issues: [{ path: '', reason: 'not_object', message: 'Los argumentos deben ser un objeto.' }],
    };
  }
  let json: string;
  try {
    json = JSON.stringify(valor);
  } catch {
    return { ok: false, issues: [{ path: '', reason: 'type', message: 'Los argumentos no son JSON.' }] };
  }
  if (bytesUtf8(json) > MAX_ARGS_BYTES) {
    return {
      ok: false,
      issues: [{ path: '', reason: 'too_large', message: `Los argumentos exceden ${MAX_ARGS_BYTES} bytes.` }],
    };
  }
  const validador = new Validador();
  const limpio = validador.valida(schema, valor, '', 0);
  if (validador.issues.length > 0 || limpio === undefined) {
    return { ok: false, issues: validador.issues };
  }
  return { ok: true, value: limpio as Record<string, unknown> };
}

/** Texto breve y seguro con las incidencias (para el mensaje al modelo; sin valores recibidos). */
export function describirIncidencias(issues: readonly IncidenciaDeEsquema[]): string {
  return issues
    .slice(0, 5)
    .map((i) => `${i.path === '' ? '(raíz)' : i.path}: ${i.message}`)
    .join(' · ');
}
