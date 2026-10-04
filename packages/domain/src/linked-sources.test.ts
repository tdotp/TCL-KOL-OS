/**
 * V2 · Fase 4 — enlaces de fuentes. Registrar una URL NO es descargarla: este
 * módulo es puro (sin red) y su política es estrecha a propósito.
 */

import { describe, expect, it } from 'vitest';
import { analizarEnlaceDeFuente, etiquetaDeProveedor } from './linked-sources';

const ID = '1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abcd';
const SHEET = `https://docs.google.com/spreadsheets/d/${ID}`;

function ok(url: string) {
  const r = analizarEnlaceDeFuente(url);
  if (!r.ok) throw new Error(`debía ser válida: ${url} → ${r.error.message}`);
  return r.value;
}

describe('enlaces admitidos', () => {
  it('Google Sheets: identifica proveedor, ID estable y forma canónica', () => {
    const e = ok(`${SHEET}/edit?usp=sharing`);
    expect(e).toMatchObject({ provider: 'google_sheets', externalId: ID, canonicalUrl: SHEET, metadata: {} });
    expect(e.originalUrl).toBe(`${SHEET}/edit?usp=sharing`);
    expect(etiquetaDeProveedor(e.provider)).toBe('Google Sheets');
  });

  it('la misma hoja con distintas formas de enlace tiene la misma URL canónica (deduplicable)', () => {
    const variantes = [
      SHEET,
      `${SHEET}/`,
      `${SHEET}/edit`,
      `${SHEET}/edit?usp=sharing`,
      `${SHEET}/view?utm_source=correo`,
      `https://docs.google.com/spreadsheets/u/0/d/${ID}/edit`,
      `  ${SHEET}/edit  `,
    ];
    expect(new Set(variantes.map((v) => ok(v).canonicalUrl))).toEqual(new Set([SHEET]));
  });

  it('NO fusiona recursos distintos: dos pestañas (gid) son enlaces distintos', () => {
    const a = ok(`${SHEET}/edit#gid=0`);
    const b = ok(`${SHEET}/edit?gid=123456`);
    const sinPestana = ok(`${SHEET}/edit`);
    expect(a.canonicalUrl).toBe(`${SHEET}#gid=0`);
    expect(b.canonicalUrl).toBe(`${SHEET}#gid=123456`);
    expect(new Set([a.canonicalUrl, b.canonicalUrl, sinPestana.canonicalUrl]).size).toBe(3);
    expect(b.metadata).toEqual({ gid: '123456' });
    // …pero el ID del libro es el mismo: la Fase 5 puede resolverlo sin llamadas.
    expect(new Set([a.externalId, b.externalId, sinPestana.externalId])).toEqual(new Set([ID]));
  });

  it('Docs, Slides y Drive', () => {
    expect(ok(`https://docs.google.com/document/d/${ID}/edit`).provider).toBe('google_docs');
    expect(ok(`https://docs.google.com/presentation/d/${ID}/edit`).provider).toBe('google_slides');
    expect(ok(`https://drive.google.com/file/d/${ID}/view?usp=sharing`).provider).toBe('google_drive_file');
    expect(ok(`https://drive.google.com/drive/folders/${ID}?usp=sharing`)).toMatchObject({
      provider: 'google_drive_folder',
      canonicalUrl: `https://drive.google.com/drive/folders/${ID}`,
    });
  });

  it('el host se compara sin distinguir mayúsculas', () => {
    expect(ok(`https://DOCS.GOOGLE.COM/spreadsheets/d/${ID}`).canonicalUrl).toBe(SHEET);
  });
});

describe('enlaces rechazados', () => {
  const casos: ReadonlyArray<readonly [string, unknown, string]> = [
    ['vacío', '', 'empty'],
    ['solo espacios', '   ', 'empty'],
    ['no es texto', 42, 'not_text'],
    ['no es una URL', 'docs google com', 'invalid_characters'],
    ['sin esquema', `docs.google.com/spreadsheets/d/${ID}`, 'malformed'],
    ['http sin cifrar', `http://docs.google.com/spreadsheets/d/${ID}`, 'not_https'],
    ['javascript:', 'javascript:alert(1)', 'not_https'],
    ['file:', 'file:///etc/passwd', 'not_https'],
    ['data:', 'data:text/html;base64,PHNjcmlwdD4=', 'not_https'],
    ['ftp', `ftp://docs.google.com/spreadsheets/d/${ID}`, 'not_https'],
    ['credenciales en la URL', `https://user:pass@docs.google.com/spreadsheets/d/${ID}`, 'credentials'],
    // «docs.google.com» es aquí el usuario y el host real es evil.com: se rechaza por credenciales.
    ['usuario que imita el host', `https://docs.google.com@evil.com/spreadsheets/d/${ID}`, 'credentials'],
    ['puerto explícito', `https://docs.google.com:8443/spreadsheets/d/${ID}`, 'port'],
    ['otro proveedor', `https://example.com/spreadsheets/d/${ID}`, 'provider_not_allowed'],
    ['sufijo malicioso', `https://docs.google.com.evil.com/spreadsheets/d/${ID}`, 'provider_not_allowed'],
    ['prefijo malicioso', `https://evildocs.google.com/spreadsheets/d/${ID}`, 'provider_not_allowed'],
    ['host con punto final', `https://docs.google.com./spreadsheets/d/${ID}`, 'provider_not_allowed'],
    ['dominio google genérico', `https://www.google.com/spreadsheets/d/${ID}`, 'provider_not_allowed'],
    ['localhost', `https://localhost/spreadsheets/d/${ID}`, 'provider_not_allowed'],
    ['IP privada', `https://10.0.0.1/spreadsheets/d/${ID}`, 'provider_not_allowed'],
    ['IP de metadatos de nube', 'https://169.254.169.254/latest/meta-data', 'provider_not_allowed'],
    ['IPv6 literal', 'https://[::1]/spreadsheets/d/x', 'provider_not_allowed'],
    ['homógrafo Unicode', `https://dосs.google.com/spreadsheets/d/${ID}`, 'provider_not_allowed'],
    [
      'ruta de Google no reconocida',
      'https://docs.google.com/forms/d/e/abc/viewform',
      'unrecognized_resource',
    ],
    ['ID demasiado corto', 'https://docs.google.com/spreadsheets/d/abc', 'unrecognized_resource'],
    ['sin ID', 'https://docs.google.com/spreadsheets/', 'unrecognized_resource'],
    [
      'enlace publicado (no soportado)',
      'https://docs.google.com/spreadsheets/d/e/2PACX-abc/pubhtml',
      'unrecognized_resource',
    ],
    ['salto de línea interno', `${SHEET}\n/edit`, 'invalid_characters'],
  ];

  it.each(casos)('%s', (_nombre, entrada, motivo) => {
    const r = analizarEnlaceDeFuente(entrada);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('INVALID_SOURCE_URL');
      expect(r.error.details).toMatchObject({ reason: motivo });
    }
  });

  it('una URL excesivamente larga se rechaza', () => {
    const r = analizarEnlaceDeFuente(`${SHEET}/edit?x=${'a'.repeat(2100)}`);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.details).toMatchObject({ reason: 'too_long' });
  });

  it('el mensaje de error no devuelve la URL recibida (no se refleja contenido hostil)', () => {
    const r = analizarEnlaceDeFuente('https://evil.com/<script>alert(1)</script>');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(JSON.stringify(r.error)).not.toContain('<script>');
  });
});

describe('sin red', () => {
  it('analizar un enlace no hace ninguna petición', () => {
    const original = globalThis.fetch;
    let llamadas = 0;
    globalThis.fetch = (() => {
      llamadas += 1;
      throw new Error('no debe haber red');
    }) as typeof fetch;
    try {
      analizarEnlaceDeFuente(`${SHEET}/edit`);
      analizarEnlaceDeFuente('https://evil.com/x');
    } finally {
      globalThis.fetch = original;
    }
    expect(llamadas).toBe(0);
  });
});
