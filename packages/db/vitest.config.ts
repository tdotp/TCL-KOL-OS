import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Las pruebas de aislamiento golpean PostgreSQL real: se ejecutan en serie
    // para que el estado sembrado sea predecible.
    fileParallelism: false,
    env: {
      DATABASE_URL:
        process.env['DATABASE_URL'] ?? 'postgresql://tclkolos:devpassword@localhost:5432/tclkolos',
    },
  },
});
