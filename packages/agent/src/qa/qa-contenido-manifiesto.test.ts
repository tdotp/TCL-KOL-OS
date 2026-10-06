/**
 * QA adversarial · manifiesto de import-boundary en CONTENIDO (V2 · Fase 7, mutaciones M1–M3, M6 y afines).
 *
 * Cada `it` aplica UNA mutación a una COPIA del árbol (el código real no se toca) y afirma que el test estático
 * (`tools/manifest.test.ts`) la DETECTA: registrar una tool que aprueba, clasificar como escritura lo que decide
 * una persona, exportar a las tools una función prohibida, nombrar una función prohibida desde una tool o
 * cambiar el riesgo de la tool de propuesta.
 *
 * Importante: la copia parte del directorio de trabajo (`'arbol'`), no de `HEAD`, mientras el catálogo de
 * contenido no esté commiteado; tras el commit ambos coinciden.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { type Copia, correrManifiesto, crearCopia, limpiarMutaciones } from './testing/mutacion.ts';

afterAll(() => {
  limpiarMutaciones();
});

const TIEMPO = 180_000;

/**
 * ¿Detecta el test estático esta mutación POR LA RAZÓN ESPERADA? (`razon` debe aparecer en la salida del test
 * que falla: así un error de sintaxis de la mutación no cuenta como detección.)
 */
function detecta(mutar: (c: Copia) => void, razon: RegExp): boolean {
  const copia = crearCopia('arbol');
  mutar(copia);
  const r = correrManifiesto(copia);
  expect(r.salida, 'la salida del test estático debe mencionar la razón esperada').toMatch(razon);
  return r.detectado;
}

describe('línea base', () => {
  it(
    'la copia SIN mutar pasa el test estático (si no, las mutaciones de abajo no significarían nada)',
    () => {
      const copia = crearCopia('arbol');
      const r = correrManifiesto(copia);
      expect(r.detectado, r.salida.slice(-1500)).toBe(false);
    },
    TIEMPO,
  );
});

describe('M1 · registrar una tool que aprueba un guion', () => {
  it(
    'una tool `script_version_approve` que reutiliza aprobarScriptVersion debe detectarse (nombre de decisión, caso de uso prohibido, conteo)',
    () => {
      const mutante = [
        "import { CITA_DE_LA_PERSONA as CITA_MUTANTE, definirTool as definir } from './common.ts';",
        'const mutante = definir({',
        "  name: 'script_version_approve',",
        '  version: 1,',
        "  label: 'Aprobando',",
        "  description: 'mutante',",
        "  risk: 'write',",
        "  requiredAction: 'script:approve',",
        "  inputSchema: { type: 'object', properties: { evidenceQuote: CITA_MUTANTE }, additionalProperties: false },",
        "  campaignStatus: 'activa',",
        "  reuses: ['aprobarScriptVersion'],",
        "  reuseNote: 'mutante',",
        '  run: async () => { throw new Error("mutante"); },',
        '  project: () => ({ data: {}, stored: {} }),',
        '});',
        '(CATALOGO_V1 as unknown as unknown[]).push(mutante);',
      ].join('\n');
      expect(detecta((c) => c.anadir('tools/catalog/index.ts', mutante), /script_version_approve/)).toBe(
        true,
      );
    },
    TIEMPO,
  );

  it(
    'renombrar `script_propose_approval` a `script_approve` (aunque siga proponiendo) debe detectarse',
    () => {
      expect(
        detecta(
          (c) =>
            c.reemplazar(
              'tools/catalog/hitl.ts',
              "name: 'script_propose_approval'",
              "name: 'script_approve'",
            ),
          /script_approve/,
        ),
      ).toBe(true);
    },
    TIEMPO,
  );

  it(
    'una tool `deliverable_archive` (decisión de la persona) debe detectarse por el patrón de nombres',
    () => {
      expect(
        detecta(
          (c) =>
            c.reemplazar(
              'tools/catalog/entregables.ts',
              "name: 'deliverable_create'",
              "name: 'deliverable_archive'",
            ),
          /deliverable_archive/,
        ),
      ).toBe(true);
    },
    TIEMPO,
  );
});

describe('M2 · clasificar como escritura/lectura lo que decide una persona', () => {
  for (const funcion of [
    'aprobarScriptVersion',
    'aprobarScriptVersionEnTransaccion',
    'registrarRevisionHumana',
    'archivarEntregable',
    'reactivarEntregable',
  ]) {
    it(
      `${funcion}: X → W debe detectarse (lista de prohibidas)`,
      () => {
        expect(
          detecta(
            (c) => c.reemplazar('tools/manifest.ts', new RegExp(`${funcion}: X`), `${funcion}: W`),
            new RegExp(funcion),
          ),
        ).toBe(true);
      },
      TIEMPO,
    );
  }
});

describe('M3 · exportar a las tools una función prohibida de db', () => {
  for (const funcion of ['aprobarScriptVersion', 'registrarRevisionHumana', 'archivarEntregable']) {
    it(
      `use-cases.ts importando ${funcion} de db debe detectarse`,
      () => {
        expect(
          detecta(
            (c) =>
              c.anadir(
                'tools/use-cases.ts',
                `import { ${funcion} as ${funcion}Mutante } from '@tcl-kol-os/db';\nexport { ${funcion}Mutante };`,
              ),
            new RegExp(funcion),
          ),
        ).toBe(true);
      },
      TIEMPO,
    );
  }

  it(
    'una tool de contenido que NOMBRA registrarRevisionHumana en su código debe detectarse',
    () => {
      expect(
        detecta(
          (c) =>
            c.anadir('tools/catalog/revision.ts', 'const mutante = registrarRevisionHumana;\nvoid mutante;'),
          /registrarRevisionHumana/,
        ),
      ).toBe(true);
    },
    TIEMPO,
  );
});

describe('M6 · el riesgo de la tool de propuesta y los argumentos que el modelo no debe aportar', () => {
  it(
    '`script_propose_approval` declarada como escritura directa (riesgo `write`) debe detectarse (conteos del catálogo)',
    () => {
      expect(
        detecta((c) => {
          const antes = c.leer('tools/catalog/hitl.ts');
          const desde = antes.indexOf("name: 'script_propose_approval'");
          if (desde < 0) throw new Error('no se encontró la tool');
          c.escribir(
            'tools/catalog/hitl.ts',
            antes.slice(0, desde) +
              antes.slice(desde).replace("risk: 'confirmation_required'", "risk: 'write'"),
          );
        }, /script_propose_approval|tiene 19 READ/),
      ).toBe(true);
    },
    TIEMPO,
  );

  it(
    'una propiedad `status` (o `approved`, `authorId`…) en el esquema de una tool de contenido debe detectarse',
    () => {
      expect(
        detecta(
          (c) =>
            c.reemplazar(
              'tools/catalog/revision.ts',
              /quote: CITA_DEL_MENSAJE/,
              "quote: CITA_DEL_MENSAJE, status: { type: 'string' as const }",
            ),
          /review_comment_add\.status|script_request_changes\.status|no puede aportarla el modelo/,
        ),
      ).toBe(true);
    },
    TIEMPO,
  );
});
