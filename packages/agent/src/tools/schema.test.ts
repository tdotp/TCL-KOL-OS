import { describe, expect, it } from 'vitest';
import { type ObjectSchema, assertEsquemaCerrado, validarArgumentos } from './schema.ts';

const esquema: ObjectSchema = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    nombre: { type: 'string', minLength: 2, maxLength: 10 },
    n: { type: 'integer', minimum: 1, maximum: 5 },
    x: { type: 'number' },
    ok: { type: 'boolean' },
    modo: { type: 'string', enum: ['a', 'b'] },
    fecha: { type: 'string', format: 'date' },
    codigo: { type: 'string', pattern: '^[A-Z]{3}$' },
    lista: { type: 'array', items: { type: 'string', maxLength: 3 }, maxItems: 2 },
    sub: {
      type: 'object',
      properties: { k: { type: 'string' } },
      required: ['k'],
      additionalProperties: false,
    },
    libre: { description: 'cualquier JSON' },
  },
  required: ['nombre'],
  additionalProperties: false,
};

const razones = (v: unknown) => {
  const r = validarArgumentos(esquema, v);
  return r.ok ? [] : r.issues.map((i) => `${i.path}:${i.reason}`);
};

describe('validarArgumentos', () => {
  it('acepta un objeto válido y devuelve una copia limpia', () => {
    const entrada = { nombre: 'ab', n: 3, lista: ['x'], sub: { k: 'v' }, libre: { a: [1, { b: 2 }] } };
    const r = validarArgumentos(esquema, entrada);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value).toEqual(entrada);
      expect(r.value).not.toBe(entrada);
    }
  });

  it('exige lo obligatorio y rechaza tipos, rangos, enum, uuid, fecha y patrón', () => {
    expect(razones({})).toContain('nombre:required');
    expect(razones({ nombre: 5 })).toContain('nombre:type');
    expect(razones({ nombre: 'a' })).toContain('nombre:length');
    expect(razones({ nombre: 'abcdefghijk' })).toContain('nombre:length');
    expect(razones({ nombre: 'ab', n: 6 })).toContain('n:range');
    expect(razones({ nombre: 'ab', n: 1.5 })).toContain('n:type');
    expect(razones({ nombre: 'ab', x: Number.NaN })).toContain('x:type');
    expect(razones({ nombre: 'ab', modo: 'c' })).toContain('modo:enum');
    expect(razones({ nombre: 'ab', id: 'no-uuid' })).toContain('id:format');
    expect(razones({ nombre: 'ab', fecha: '2026-02-30' })).toContain('fecha:format');
    expect(razones({ nombre: 'ab', codigo: 'abc' })).toContain('codigo:pattern');
    expect(razones({ nombre: 'ab', lista: ['a', 'b', 'c'] })).toContain('lista:items');
    expect(razones({ nombre: 'ab', lista: ['abcd'] })).toContain('lista[0]:length');
    expect(razones({ nombre: 'ab', ok: 'si' })).toContain('ok:type');
    expect(razones({ nombre: 'ab', sub: {} })).toContain('sub.k:required');
    expect(razones({ nombre: 'ab\u0000' })).toContain('nombre:nul');
  });

  it('rechaza claves desconocidas y las que fijaría el servidor (identidad, campaña, canal, estado)', () => {
    expect(razones({ nombre: 'ab', otra: 1 })).toContain('otra:unknown_key');
    for (const k of [
      'actor',
      'userId',
      'organizationId',
      'campaignId',
      'origin',
      'canal',
      'assignedTo',
      'status',
      'ORIGIN',
    ]) {
      expect(razones({ nombre: 'ab', [k]: 'x' })).toContain(`${k}:forbidden_key`);
    }
    // también anidadas
    expect(razones({ nombre: 'ab', sub: { k: 'v', campaignId: 'x' } })).toContain(
      'sub.campaignId:forbidden_key',
    );
  });

  it('rechaza __proto__, constructor y prototype a cualquier profundidad, incluso en JSON libre', () => {
    const conProto = JSON.parse('{"nombre":"ab","__proto__":{"x":1}}');
    expect(razones(conProto)).toContain('__proto__:dangerous_key');
    expect(razones({ nombre: 'ab', constructor: 1 })).toContain('constructor:dangerous_key');
    expect(razones({ nombre: 'ab', prototype: 1 })).toContain('prototype:dangerous_key');
    expect(razones({ nombre: 'ab', libre: JSON.parse('{"a":{"__proto__":1}}') })).toContain(
      'libre.a.__proto__:dangerous_key',
    );
    // sin contaminación del prototipo
    expect(({} as Record<string, unknown>)['x']).toBeUndefined();
  });

  it('solo objetos planos; sin ciclos; con tope de tamaño y profundidad', () => {
    expect(validarArgumentos(esquema, 'texto').ok).toBe(false);
    expect(validarArgumentos(esquema, null).ok).toBe(false);
    expect(validarArgumentos(esquema, []).ok).toBe(false);
    expect(validarArgumentos(esquema, new Date()).ok).toBe(false);
    const ciclo: Record<string, unknown> = { nombre: 'ab' };
    ciclo['libre'] = ciclo;
    expect(validarArgumentos(esquema, ciclo).ok).toBe(false);
    expect(razones({ nombre: 'ab', libre: 'x'.repeat(20_000) })).toContain(':too_large');
    expect(razones({ nombre: 'ab', libre: { a: { b: { c: { d: { e: 1 } } } } } })).toContain(
      'libre.a.b.c.d:too_deep',
    );
    expect(razones({ nombre: 'ab', libre: 'x'.repeat(3000) })).toContain('libre:too_large');
  });
});

describe('assertEsquemaCerrado', () => {
  it('exige additionalProperties:false, required declarados y sin claves del servidor', () => {
    expect(() => assertEsquemaCerrado(esquema)).not.toThrow();
    expect(() =>
      assertEsquemaCerrado({ type: 'object', properties: {} } as unknown as ObjectSchema),
    ).toThrow();
    expect(() =>
      assertEsquemaCerrado({
        type: 'object',
        properties: { a: { type: 'string' } },
        required: ['b'],
        additionalProperties: false,
      }),
    ).toThrow();
    expect(() =>
      assertEsquemaCerrado({
        type: 'object',
        properties: { campaignId: { type: 'string' } },
        additionalProperties: false,
      }),
    ).toThrow();
  });
});
