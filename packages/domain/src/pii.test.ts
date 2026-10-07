import { describe, expect, it } from 'vitest';
import {
  PII_BLIND_INDEX_LENGTH,
  PII_COLUMN_BY_FIELD,
  PII_ENVELOPE_MIN_LENGTH,
  PII_ENVELOPE_VERSION,
  PII_FIELDS,
  camposPresentes,
  esEnvoltorioPiiValido,
  esKeyIdValido,
  isPiiField,
  normalizarDireccion,
  normalizarDocumentoDeIdentidad,
  normalizarTelefono,
  textoPodriaContenerPii,
  validarCamposARevelar,
  validarEntradaPii,
} from './pii';

describe('envoltorio cifrado', () => {
  it('versión 0x01 y longitud mínima 29; el texto plano no pasa', () => {
    expect(PII_ENVELOPE_MIN_LENGTH).toBe(29);
    expect(PII_BLIND_INDEX_LENGTH).toBe(32);
    const bueno = new Uint8Array(29);
    bueno[0] = PII_ENVELOPE_VERSION;
    expect(esEnvoltorioPiiValido(bueno)).toBe(true);
    expect(esEnvoltorioPiiValido(new Uint8Array(28).fill(1))).toBe(false);
    expect(esEnvoltorioPiiValido(new Uint8Array(40))).toBe(false);
    expect(esEnvoltorioPiiValido(new TextEncoder().encode('Calle 10 # 5-20, Bogotá, apto 301 torre 2'))).toBe(
      false,
    );
  });

  it('key_id con el patrón de la base', () => {
    expect(esKeyIdValido('k1')).toBe(true);
    expect(esKeyIdValido('pii-2026.10:a')).toBe(true);
    expect(esKeyIdValido('')).toBe(false);
    expect(esKeyIdValido('a b')).toBe(false);
    expect(esKeyIdValido('x'.repeat(65))).toBe(false);
  });
});

describe('normalización', () => {
  it('documento de identidad: separadores fuera, mayúsculas, 5–20', () => {
    expect(normalizarDocumentoDeIdentidad('1.234.567-8')).toEqual(
      expect.objectContaining({ ok: true, value: '12345678' }),
    );
    expect(normalizarDocumentoDeIdentidad(' ab 12345 ')).toEqual(
      expect.objectContaining({ ok: true, value: 'AB12345' }),
    );
    for (const malo of ['1234', 'ABCDEFGH', '12 34 5 $', '', null, 12345678, '1'.repeat(21)]) {
      expect(normalizarDocumentoDeIdentidad(malo).ok, String(malo)).toBe(false);
    }
  });

  it('teléfono: 7–15 dígitos con + opcional', () => {
    expect(normalizarTelefono('+57 (300) 123-4567')).toEqual(
      expect.objectContaining({ ok: true, value: '+573001234567' }),
    );
    expect(normalizarTelefono('3001234567').ok).toBe(true);
    for (const malo of ['123456', '+', 'abc1234567', '1234567890123456', '30012 34a67']) {
      expect(normalizarTelefono(malo).ok, malo).toBe(false);
    }
  });

  it('dirección: colapsa espacios, 5–300, sin controles', () => {
    expect(normalizarDireccion('  Calle   10 #5-20 ')).toEqual(
      expect.objectContaining({ ok: true, value: 'Calle 10 #5-20' }),
    );
    for (const mala of ['abc', '---- ----', 'x'.repeat(301), 'Calle\u0000 10 5', 7]) {
      expect(normalizarDireccion(mala).ok, String(mala)).toBe(false);
    }
  });

  it('validarEntradaPii: al menos un campo; los ausentes no se tocan', () => {
    expect(validarEntradaPii({}).ok).toBe(false);
    expect(validarEntradaPii({ documentId: '' }).ok).toBe(false);
    const r = validarEntradaPii({ phone: '300 123 4567', address: undefined });
    expect(r.ok && r.value).toEqual({ phone: '3001234567' });
    expect(validarEntradaPii({ documentId: '12' }).ok).toBe(false);
  });

  it('el error de validación no repite el valor recibido', () => {
    const r = validarEntradaPii({ documentId: '99$secreto' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(JSON.stringify(r.error)).not.toContain('secreto');
  });
});

describe('resumen y auditoría sin valores', () => {
  it('campos conocidos y su columna cifrada', () => {
    expect(PII_FIELDS).toEqual(['document_id', 'phone', 'address']);
    expect(PII_COLUMN_BY_FIELD.document_id).toBe('document_id_enc');
    expect(isPiiField('phone')).toBe(true);
    expect(isPiiField('email')).toBe(false);
    expect(camposPresentes({ hasDocumentId: true, hasPhone: false, hasAddress: true })).toEqual([
      'document_id',
      'address',
    ]);
  });

  it('campos a revelar: nombres válidos, sin repetidos, al menos uno', () => {
    expect(validarCamposARevelar([]).ok).toBe(false);
    expect(validarCamposARevelar(['phone', 'email']).ok).toBe(false);
    const r = validarCamposARevelar(['phone', 'phone', 'address']);
    expect(r.ok && r.value).toEqual(['phone', 'address']);
  });
});

describe('aviso de PII en texto libre', () => {
  it('detecta correo, teléfono, cédula y dirección típicos', () => {
    expect(textoPodriaContenerPii('escribir a ana@ejemplo.co')).toBe(true);
    expect(textoPodriaContenerPii('su celular es 300 123 4567')).toBe(true);
    expect(textoPodriaContenerPii('cc 1.234.567.890')).toBe(true);
    expect(textoPodriaContenerPii('Calle 10 # 5-20')).toBe(true);
    expect(textoPodriaContenerPii('Cra 7 No. 45')).toBe(true);
  });

  it('no alarma con notas operativas normales', () => {
    expect(textoPodriaContenerPii('Entregado en portería, sin novedad')).toBe(false);
    expect(textoPodriaContenerPii('Guía enviada por correo certificado')).toBe(false);
    expect(textoPodriaContenerPii('Dos cajas, 3 unidades')).toBe(false);
  });
});
