/**
 * V2 · Fase 5 — los ejemplos publicados del Sheet V1 (`fixtures/influencer-sheet`)
 * se validan con el validador real: la especificación no puede divergir del código.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { type SnapshotGrid, validateInfluencerSheet } from '@tcl-kol-os/domain';

const DIRECTORIO = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'fixtures',
  'influencer-sheet',
);

/** CSV sencillo (sin comillas) → rejilla de snapshot de una pestaña. */
function rejillaDe(archivo: string): SnapshotGrid {
  const filas = readFileSync(join(DIRECTORIO, archivo), 'utf-8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => l.split(','));
  return {
    sheets: [
      {
        name: 'Influencers',
        gid: 1,
        state: 'visible',
        rows: filas.map((celdas, i) => ({
          row: i + 1,
          cells: celdas.flatMap((texto, c) =>
            texto === '' ? [] : [{ col: c + 1, text: texto, type: 'texto' }],
          ),
        })),
      },
    ],
  };
}

const validar = (archivo: string) => validateInfluencerSheet(rejillaDe(archivo));

describe('ejemplos del esquema TCL_KOL_OS_INFLUENCERS_V1', () => {
  it('valido-minimo.csv: 2 personas, sin problemas', () => {
    const v = validar('valido-minimo.csv');
    expect(v.status).toBe('valid');
    expect(v.errors).toEqual([]);
    expect(v.warnings).toEqual([]);
    expect(v.records.map((r) => [r.sourceKey, r.problems.length])).toEqual([
      ['INF-001', 0],
      ['INF-002', 0],
    ]);
  });

  it('valido-completo.csv: una persona con dos cuentas, dos homónimas separadas, futuros conservados', () => {
    const v = validar('valido-completo.csv');
    expect(v.status).toBe('valid');
    expect(v.errors).toEqual([]);
    expect(v.records.every((r) => r.problems.length === 0)).toBe(true);
    expect(v.records.map((r) => [r.sourceKey, r.accounts.length])).toEqual([
      ['INF-001', 2],
      ['INF-002', 1],
      ['INF-003', 1],
      ['INF-004', 1],
    ]);
    // Dos «María García» con claves distintas: dos personas.
    expect(v.records.filter((r) => r.displayName === 'María García')).toHaveLength(2);
    const valentina = v.records[0]!;
    expect(valentina.futureValues.map((f) => f.column)).toEqual(
      expect.arrayContaining([
        'entregables',
        'tipo_acuerdo',
        'fee',
        'canje',
        'fecha_inicio',
        'fecha_fin',
        'kpi_objetivo',
        'condiciones',
      ]),
    );
  });

  it.each([
    ['invalido-sin-marcador.csv', 'MARKER_MISSING'],
    ['invalido-version-desconocida.csv', 'MARKER_UNSUPPORTED_VERSION'],
    ['invalido-falta-columna.csv', 'HEADER_REQUIRED_MISSING'],
  ])('%s → Sheet inválido (%s) y sin registros', (archivo, codigo) => {
    const v = validar(archivo);
    expect(v.status).toBe('invalid');
    expect(v.errors.map((e) => e.code)).toEqual([codigo]);
    expect(v.records).toEqual([]);
  });

  it('invalido-registros.csv: el Sheet es válido y cada registro roto lo es por su motivo', () => {
    const v = validar('invalido-registros.csv');
    expect(v.status).toBe('valid');
    const motivos = Object.fromEntries(v.records.map((r) => [r.sourceKey, r.problems.map((p) => p.code)]));
    expect(motivos['INF-002']).toContain('ROW_PLATFORM_UNSUPPORTED');
    expect(motivos['INF-003']).toContain('ROW_HANDLE_INVALID');
    expect(motivos['INF-004']).toContain('FUTURE_FIELD_INVALID');
    expect(motivos['INF-005']).toContain('FUTURE_FIELD_INVALID');
    // La misma cuenta bajo dos claves invalida a las dos.
    expect(motivos['INF-001']).toContain('ACCOUNT_IN_TWO_KEYS');
    expect(motivos['INF-006']).toContain('ACCOUNT_IN_TWO_KEYS');
    // Una fila sin clave es su propio registro inválido.
    expect(motivos['__FILA_9']).toContain('ROW_KEY_MISSING');
  });
});
