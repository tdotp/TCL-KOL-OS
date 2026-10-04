/**
 * V2 · Fase 3 — reglas puras de identidad del influencer.
 *
 * La normalización del handle es la clave de identidad de una cuenta social:
 * si dos escrituras de la misma cuenta no coinciden, se duplica la persona; si
 * dos cuentas distintas coinciden, se fusionan dos personas. Por eso es una
 * regla única, determinística y probada.
 */

import { describe, expect, it } from 'vitest';
import {
  SOCIAL_PLATFORMS,
  normalizeDisplayName,
  normalizeHandle,
  normalizeProfileUrl,
  type SocialPlatform,
} from './influencers';

function handle(platform: SocialPlatform, raw: unknown) {
  const r = normalizeHandle(platform, raw);
  if (!r.ok) throw new Error(`no debía fallar: ${r.error.message}`);
  return r.value;
}

describe('normalizeHandle', () => {
  it('@Valentina, valentina y VALENTINA son la misma identidad', () => {
    const claves = ['@Valentina', 'valentina', 'VALENTINA', '  @valentina  '].map(
      (raw) => handle('instagram', raw).normalized,
    );
    expect(new Set(claves)).toEqual(new Set(['valentina']));
  });

  it('conserva cómo se escribió (sin @) para mostrarlo, y compara por la clave normalizada', () => {
    expect(handle('tiktok', '@Valentina.Rojas')).toEqual({
      handle: 'Valentina.Rojas',
      normalized: 'valentina.rojas',
    });
  });

  it('no toca los signos: punto, guion bajo y guion distinguen cuentas', () => {
    const a = handle('instagram', 'valentina.rojas').normalized;
    const b = handle('instagram', 'valentinarojas').normalized;
    const c = handle('instagram', 'valentina_rojas').normalized;
    const d = handle('instagram', 'valentina-rojas').normalized;
    expect(new Set([a, b, c, d]).size).toBe(4);
  });

  it('iguala variantes Unicode equivalentes (NFKC), p. ej. ancho completo', () => {
    expect(handle('instagram', 'ｖａｌｅｎｔｉｎａ').normalized).toBe('valentina');
  });

  it('es idempotente: normalizar la clave normalizada no la cambia', () => {
    for (const raw of ['@Valentina.Rojas', 'ÁLVARO_99', 'x-Y_z.1']) {
      const una = handle('youtube', raw).normalized;
      expect(handle('youtube', una).normalized).toBe(una);
    }
  });

  it('todas las plataformas admitidas hoy tratan el handle sin distinguir mayúsculas', () => {
    for (const plataforma of SOCIAL_PLATFORMS) {
      expect(handle(plataforma, 'AbC').normalized, plataforma).toBe('abc');
    }
  });

  it('acepta letras con acento y números', () => {
    expect(handle('instagram', '@Álvaro_99').normalized).toBe('álvaro_99');
  });

  it.each([
    ['vacío', ''],
    ['solo @', '@'],
    ['doble @', '@@valentina'],
    ['espacio interno', 'valen tina'],
    ['arroba interna', 'valen@tina'],
    ['barra', 'valentina/rojas'],
    ['URL pegada como handle', 'https://instagram.com/valentina'],
    ['carácter invisible', 'valen​tina'],
    ['salto de línea interno', 'valen\ntina'],
  ])('rechaza un handle inválido: %s', (_nombre, raw) => {
    const r = normalizeHandle('instagram', raw);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('VALIDATION_FAILED');
  });

  it('rechaza lo que no es texto, el handle demasiado largo y una plataforma desconocida', () => {
    expect(normalizeHandle('instagram', undefined).ok).toBe(false);
    expect(normalizeHandle('instagram', 42).ok).toBe(false);
    expect(normalizeHandle('instagram', 'a'.repeat(101)).ok).toBe(false);
    expect(normalizeHandle('instagram', 'a'.repeat(100)).ok).toBe(true);
    expect(normalizeHandle('myspace' as SocialPlatform, 'valentina').ok).toBe(false);
  });
});

describe('normalizeDisplayName', () => {
  it('recorta, colapsa espacios internos y conserva mayúsculas y acentos', () => {
    const r = normalizeDisplayName('  Valentina   Rojas \t');
    expect(r.ok && r.value).toBe('Valentina Rojas');
  });

  it('el nombre NO es clave de identidad: dos personas pueden llamarse igual', () => {
    const a = normalizeDisplayName('Valentina Rojas');
    const b = normalizeDisplayName('Valentina Rojas');
    expect(a.ok && b.ok && a.value === b.value).toBe(true);
  });

  it.each([
    ['vacío', ''],
    ['solo espacios', '   \n\t '],
    ['no es texto', undefined],
    ['demasiado largo', 'x'.repeat(201)],
    ['carácter de control', 'Vale\u0007ntina'],
  ])('rechaza: %s', (_nombre, raw) => {
    const r = normalizeDisplayName(raw);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('VALIDATION_FAILED');
  });
});

describe('normalizeProfileUrl', () => {
  it('es opcional: sin valor o vacío = sin URL', () => {
    for (const raw of [undefined, null, '', '   ']) {
      const r = normalizeProfileUrl(raw);
      expect(r.ok && r.value).toBeUndefined();
    }
  });

  it('acepta http(s) y rechaza otros esquemas o texto que no es URL', () => {
    expect(normalizeProfileUrl('https://instagram.com/valentina').ok).toBe(true);
    for (const raw of ['javascript:alert(1)', 'ftp://x.co/a', 'instagram.com/valentina', 'no es url']) {
      expect(normalizeProfileUrl(raw).ok, raw).toBe(false);
    }
  });
});
