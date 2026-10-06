import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Las COPIAS de las pruebas de mutación (`qa/testing/mutacion.ts`) viven en `qa-tmp-mutacion/`: no se descubren
    // como pruebas propias (otro proceso puede tener copias a medias); el harness las ejecuta con
    // `vitest.mutacion.config.ts`.
    exclude: [...configDefaults.exclude, '**/qa-tmp-mutacion/**'],
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
