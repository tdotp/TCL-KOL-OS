import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Las pruebas de aislamiento golpean PostgreSQL real: se ejecutan en serie
    // para que el estado sembrado sea predecible.
    fileParallelism: false,
    // INC-001A: sin valor por defecto ni fallback hacia `DATABASE_URL`. La
    // validación y el candado viven en `vitest.setup.ts` — aquí no se declara
    // ninguna base, para que sea imposible caer en la de desarrollo por
    // omisión.
    setupFiles: ['./vitest.setup.ts'],
  },
});
