import { defineConfig } from '@playwright/test';

/**
 * Sprint 6, Checkpoint 2 — Playwright del Brief Workspace.
 *
 * Dos servidores, misma base de datos aislada (`_test`), para poder probar
 * `BRIEF_WORKSPACE_V2` en ambos estados dentro de la misma corrida sin
 * reiniciar nada a mano — E2E-01 corre contra el puerto con la bandera
 * apagada; el resto, contra el puerto con la bandera encendida. Ninguno de
 * los dos toca `DATABASE_URL` normal (desarrollo): siempre la variable
 * `E2E_DATABASE_URL`, que debe apuntar a una base "_test" (candado también
 * en tiempo de ejecución, `src/fixtures.ts`).
 */
const DATABASE_URL =
  process.env['E2E_DATABASE_URL'] ?? 'postgresql://tclkolos:devpassword@localhost:5439/tclkolos_test';

if (!/\/[A-Za-z0-9_-]*_test(?:\?.*)?$/.test(DATABASE_URL)) {
  throw new Error(
    `Sprint 6 E2E: E2E_DATABASE_URL debe apuntar a una base "_test" (INC-001A). Recibido: ${DATABASE_URL}`,
  );
}

// Las pruebas (`fixtures.ts`) llaman a `@tcl-kol-os/db` directamente desde
// el proceso de Playwright, no solo desde los `webServer` — necesita su
// propia `DATABASE_URL` en este proceso, además de la que se pasa a cada
// servidor más abajo.
process.env['DATABASE_URL'] = DATABASE_URL;

const ENV_BASE = {
  DATABASE_URL,
  AUTH_PROVIDER: 'dev',
  AI_PROVIDER: 'fake',
  AI_ENABLED: 'false',
};

export default defineConfig({
  testDir: './tests',
  timeout: 30_000,
  expect: { timeout: 8_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    channel: 'chrome',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'flag-off',
      testMatch: /flag-apagado\.spec\.ts$/,
      use: { baseURL: 'http://localhost:3010' },
    },
    {
      // Enumerado a propósito, no una exclusión por lookahead: un
      // `(?!flag-apagado).*` sin anclar al inicio de cada posición de
      // coincidencia deja pasar igual a `flag-apagado.spec.ts` (el motor
      // reintenta el patrón más adelante en el nombre) — se descubrió
      // corriendo la suite completa sin filtro, donde ese archivo terminó
      // ejecutándose dos veces, una por proyecto.
      name: 'flag-on',
      testMatch: /(workspace|roles-y-aislamiento)\.spec\.ts$/,
      use: { baseURL: 'http://localhost:3011' },
    },
  ],
  webServer: [
    {
      command: 'npm run dev --workspace=@tcl-kol-os/web',
      cwd: '../../',
      url: 'http://localhost:3010/login',
      env: { ...ENV_BASE, WEB_PORT: '3010', BRIEF_WORKSPACE_V2: 'false' },
      reuseExistingServer: false,
      timeout: 60_000,
      stdout: 'pipe',
      stderr: 'pipe',
    },
    {
      command: 'npm run dev --workspace=@tcl-kol-os/web',
      cwd: '../../',
      url: 'http://localhost:3011/login',
      env: { ...ENV_BASE, WEB_PORT: '3011', BRIEF_WORKSPACE_V2: 'true' },
      reuseExistingServer: false,
      timeout: 60_000,
      stdout: 'pipe',
      stderr: 'pipe',
    },
  ],
});
