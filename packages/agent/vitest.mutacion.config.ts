import { defineConfig } from 'vitest/config';

/**
 * Configuración con la que `qa/testing/mutacion.ts` ejecuta la COPIA mutada de `tools/manifest.test.ts`
 * (`qa-tmp-mutacion/`): igual que `vitest.config.ts`, pero SIN excluir esas copias.
 */
export default defineConfig({
  test: {
    fileParallelism: false,
    setupFiles: ['./vitest.setup.ts'],
  },
});
