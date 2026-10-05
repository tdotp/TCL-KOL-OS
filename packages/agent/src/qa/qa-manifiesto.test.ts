/**
 * QA adversarial · vector 4 (D15): ¿se puede burlar el test estático del manifiesto de import-boundary?
 *
 * Se aplican MUTACIONES a una copia de `packages/agent/src` + `packages/db/src` (el código real no se
 * toca) y se ejecuta allí `manifest.test.ts`. Estas mutaciones DEBEN ser detectadas (el test estático
 * falla). Las que logran burlarlo están en `qa-manifiesto.qa-red.test.ts`.
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

describe('D15 · control: la copia sin mutar pasa el test estático', () => {
  it(
    'baseline verde (si falla, las demás pruebas no significan nada)',
    () => {
      const copia = crearCopia();
      expect(correrManifiesto(copia).detectado).toBe(false);
    },
    TIEMPO,
  );
});

describe('D15 · mutaciones que el test estático DETECTA', () => {
  it(
    'un export NUEVO en db sin clasificar (función, const, alias, y vía `export *` de un archivo nuevo)',
    () => {
      expect(
        detecta((c) => c.anadir('db/index.ts', 'export async function aprobacionRapida(): Promise<void> {}')),
        'export function',
      ).toBe(true);
      expect(
        detecta((c) => c.anadir('db/index.ts', 'export const peligrosoNuevo = (): number => 1;')),
        'export const',
      ).toBe(true);
      expect(
        detecta((c) =>
          c.anadir(
            'db/index.ts',
            "export { aprobarBrief as aprobarSinConfirmar } from './client-review.ts';",
          ),
        ),
        'alias',
      ).toBe(true);
      expect(
        detecta((c) => {
          c.escribir('db/zzz-nuevo.ts', 'export function peligroNuevo(): void {}\n');
          c.anadir('db/index.ts', "export * from './zzz-nuevo.ts';");
        }),
        'export * de un archivo nuevo',
      ).toBe(true);
    },
    TIEMPO,
  );

  it(
    'una clasificación obsoleta (un export que db ya no tiene) también rompe el test',
    () => {
      expect(detecta((c) => c.reemplazar('db/index.ts', '  abandonarRunsCaducados,\n', ''))).toBe(true);
    },
    TIEMPO,
  );

  it(
    'importar db fuera de las puertas: import nombrado, ruta relativa a packages/db, import() literal, require() literal',
    () => {
      expect(
        detecta((c) =>
          c.anadir(
            'tools/catalog/campaign.ts',
            "import { aprobarBrief } from '@tcl-kol-os/db';\nvoid aprobarBrief;",
          ),
        ),
        'import nombrado en tools/catalog',
      ).toBe(true);
      expect(
        detecta((c) =>
          c.anadir(
            'runtime/ejecutar-run.ts',
            "import { confirmarAccion } from '@tcl-kol-os/db';\nvoid confirmarAccion;",
          ),
        ),
        'import nombrado en runtime',
      ).toBe(true);
      expect(
        detecta((c) =>
          c.anadir(
            'tools/catalog/campaign.ts',
            "import { aprobarBrief } from '../../../../db/src/index.ts';\nvoid aprobarBrief;",
          ),
        ),
        'ruta relativa a packages/db',
      ).toBe(true);
      expect(
        detecta((c) => c.anadir('runtime/citas.ts', "export const cargar = () => import('@tcl-kol-os/db');")),
        'import() literal',
      ).toBe(true);
      expect(
        detecta((c) =>
          c.anadir(
            'runtime/citas.ts',
            "declare const require: (x: string) => unknown;\nexport const cargar = () => require('@tcl-kol-os/db');",
          ),
        ),
        'require() literal',
      ).toBe(true);
      expect(
        detecta((c) => c.anadir('runtime/citas.ts', "export * from '@tcl-kol-os/db';")),
        'export * from db',
      ).toBe(true);
    },
    TIEMPO,
  );

  it(
    'use-cases.ts: importar una función PROHIBIDA, o llamar transicionarBrief con `approved`',
    () => {
      expect(
        detecta((c) =>
          c.reemplazar('tools/use-cases.ts', '  // ── lecturas ──', '  aprobarBrief,\n  // ── lecturas ──'),
        ),
        'aprobarBrief en la lista blanca',
      ).toBe(true);
      expect(
        detecta((c) =>
          c.reemplazar(
            'tools/use-cases.ts',
            "transicionarBrief(actor, versionId, 'internal_review'",
            "transicionarBrief(actor, versionId, 'approved'",
          ),
        ),
        'destino approved',
      ).toBe(true);
    },
    TIEMPO,
  );

  it(
    'catálogo: una tool que reutiliza un caso de uso prohibido, o una tool nueva de nombre prohibido',
    () => {
      expect(
        detecta((c) =>
          c.reemplazar(
            'tools/catalog/campaign.ts',
            "reuses: ['getCampaign']",
            "reuses: ['getCampaign', 'confirmarAccion']",
          ),
        ),
        'reuses prohibido',
      ).toBe(true);
      expect(
        detecta((c) =>
          c.reemplazar('tools/catalog/campaign.ts', "name: 'campaign_get'", "name: 'aprobar_brief'"),
        ),
        'nombre prohibido',
      ).toBe(true);
    },
    TIEMPO,
  );

  it(
    'SQL en tools/: getPool / query / transaction en un archivo del catálogo',
    () => {
      expect(
        detecta((c) =>
          c.anadir(
            'tools/catalog/campaign.ts',
            "export const sql = (db: { query: (s: string) => unknown }) => db.query('select 1');",
          ),
        ),
      ).toBe(true);
    },
    TIEMPO,
  );
});

describe('D15 · una re-exportación con alias en la puerta del runtime se detecta por el nombre ORIGINAL', () => {
  it(
    'db-ports.ts: `export { aprobarBrief as reintentarAprobacion } from db`',
    () => {
      expect(
        detecta((c) =>
          c.anadir(
            'runtime/db-ports.ts',
            "export { aprobarBrief as reintentarAprobacion } from '@tcl-kol-os/db';",
          ),
        ),
      ).toBe(true);
    },
    TIEMPO,
  );
});
