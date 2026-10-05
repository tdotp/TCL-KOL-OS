/**
 * QA adversarial · vector 4 (D15): MUTACIONES que BURLAN el test estático de import-boundary
 * (`tools/manifest.test.ts`). Cada `it` afirma que el test estático DEBERÍA detectar la mutación;
 * hoy NO la detecta (la prueba falla). Se aplican a una copia del árbol commiteado; el código real
 * no se toca. Ver el reporte (hallazgos QA-13…QA-16).
 */
import { afterAll, describe, expect, it } from 'vitest';
import { type Copia, correrManifiesto, crearCopia, limpiarMutaciones } from './testing/mutacion.ts';

afterAll(() => {
  limpiarMutaciones();
});

const TIEMPO = 180_000;

function detecta(mutar: (c: Copia) => void): boolean {
  const copia = crearCopia();
  mutar(copia);
  return correrManifiesto(copia).detectado;
}

describe('QA-13 · import de db por ruta del enlace simbólico del workspace (node_modules/@tcl-kol-os/db)', () => {
  it(
    'importar db (aquí una lectura inocua, para aislar la regla de puertas) por `…/node_modules/@tcl-kol-os/db/src/index.ts` desde una tool debería detectarse',
    () => {
      const subir = '../'.repeat(8);
      expect(
        detecta((c) =>
          c.anadir(
            'tools/catalog/campaign.ts',
            `import { getCampaign } from '${subir}node_modules/@tcl-kol-os/db/src/index.ts';\nvoid getCampaign;`,
          ),
        ),
      ).toBe(true);
    },
    TIEMPO,
  );
});

describe('QA-14 · `export * from db` en la puerta del runtime vuelve importable TODO desde runtime/**', () => {
  it(
    'db-ports.ts con `export *` + un archivo del runtime que importa confirmarAccion de ./db-ports.ts debería detectarse',
    () => {
      expect(
        detecta((c) => {
          c.anadir('runtime/db-ports.ts', "export * from '@tcl-kol-os/db';");
          c.anadir(
            'runtime/ejecutar-run.ts',
            "import { confirmarAccion } from './db-ports.ts';\nvoid confirmarAccion;",
          );
        }),
      ).toBe(true);
    },
    TIEMPO,
  );
});

describe('QA-15 · acceso por nombre calculado / require indirecto / import() no literal', () => {
  it(
    'import * + acceso computado a una función prohibida en use-cases.ts debería detectarse',
    () => {
      expect(
        detecta((c) =>
          c.anadir(
            'tools/use-cases.ts',
            "import * as todoDb from '@tcl-kol-os/db';\nexport const sorpresa = (todoDb as unknown as Record<string, unknown>)['aprobar' + 'Brief'];",
          ),
        ),
      ).toBe(true);
    },
    TIEMPO,
  );

  it(
    'createRequire con alias (`const req = createRequire(...); req("@tcl-kol-os/db")`) debería detectarse',
    () => {
      expect(
        detecta((c) =>
          c.anadir(
            'runtime/citas.ts',
            "import { createRequire } from 'node:module';\nconst req = createRequire(import.meta.url);\nexport const dbCrudo = req('@tcl-kol-os/db') as Record<string, unknown>;",
          ),
        ),
      ).toBe(true);
    },
    TIEMPO,
  );

  it(
    'import() con especificador no literal debería detectarse',
    () => {
      expect(
        detecta((c) =>
          c.anadir(
            'runtime/citas.ts',
            "export const cargarDb = () => import(['@tcl-kol-os', 'db'].join('/'));",
          ),
        ),
      ).toBe(true);
    },
    TIEMPO,
  );
});
