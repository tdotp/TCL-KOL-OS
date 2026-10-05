/**
 * Prueba estática: el runtime solo toca `@tcl-kol-os/db` por `db-ports.ts`, y esa lista
 * no incluye nada que apruebe, confirme o ejecute (HITL).
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const DIRS = ['runtime', 'model', 'prompts'].map((d) => join(import.meta.dirname, '..', d));

function fuentes(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((f) =>
    f.isDirectory()
      ? f.name === 'testing' // soportes de prueba: no son código de producción
        ? []
        : fuentes(join(dir, f.name))
      : f.name.endsWith('.ts') && !f.name.endsWith('.test.ts')
        ? [join(dir, f.name)]
        : [],
  );
}

describe('frontera del runtime', () => {
  const archivos = DIRS.flatMap(fuentes);

  it('solo db-ports.ts importa @tcl-kol-os/db', () => {
    const importan = archivos.filter((f) => /from '@tcl-kol-os\/db/.test(readFileSync(f, 'utf8')));
    expect(importan.map((f) => f.split('/').pop())).toEqual(['db-ports.ts']);
  });

  it('db-ports no expone aprobar/confirmar/ejecutar ni SQL', () => {
    const puertos = readFileSync(join(DIRS[0]!, 'db-ports.ts'), 'utf8');
    for (const prohibido of [
      'aprobarBrief',
      'transicionarBrief',
      'confirmarAccion',
      'ejecutarAccion',
      'cancelarAccion',
      'setSourceVisibility',
      'archiveCampaign',
      'recordAudit',
      'getPool',
      'query',
      'transaction',
    ]) {
      expect(puertos, prohibido).not.toMatch(new RegExp(`\\b${prohibido}\\b`));
    }
  });

  it('el runtime no escribe SQL', () => {
    for (const f of archivos) {
      expect(readFileSync(f, 'utf8'), f).not.toMatch(/\b(SELECT|INSERT INTO|UPDATE \w+ SET|DELETE FROM)\b/);
    }
  });
});
