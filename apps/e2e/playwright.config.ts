import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

/**
 * Los adjuntos del chat escriben archivos reales (`uploadSource`): se redirigen a un directorio
 * temporal propio de las pruebas para no tocar el `.storage` de desarrollo. Lo comparten los
 * servidores del chat, el worker y el proceso de Playwright.
 */
const STORAGE_LOCAL_PATH = join(tmpdir(), 'tcl-kol-os-e2e-chat-storage');
process.env['STORAGE_LOCAL_PATH'] = STORAGE_LOCAL_PATH;

/** Solo para iterar a mano: `E2E_REUSE_SERVERS=1` reutiliza servidores ya levantados (nunca en la corrida oficial). */
const reutilizar = process.env['E2E_REUSE_SERVERS'] === '1';

const ENV_BASE = {
  DATABASE_URL,
  AUTH_PROVIDER: 'dev',
  AI_PROVIDER: 'fake',
  AI_ENABLED: 'false',
};

/**
 * V2 · Fase 6, Wave 3 — Chat del agente de Cuenta.
 *
 * Tres servidores web más (misma base `_test`) y un worker real:
 *   · 3012 `chat`            IA encendida (`AI_ENABLED=true`, `AI_PROVIDER=fake`) apuntando al worker 8011.
 *   · 3013 `chat-ia-off`     `AI_ENABLED=false` (kill-switch): el chat se muestra pero no envía.
 *   · 3014 `chat-worker-caido` IA encendida pero con `AI_WORKER_URL` en 8012, donde NO arranca nadie:
 *     el spec levanta (y apaga) ese worker a mano para probar «cae → reintentar → completa».
 *   · 3015 `contenido` (V2 · Fase 7) IA encendida contra el mismo worker 8011.
 *   · 8011 worker `uvicorn app.main:app` (venv local del servicio) con el modelo falso
 *     determinista: es el proceso REAL de `POST /modelo/turno`, sin red ni clave.
 * Ninguno toca la base de desarrollo: `DATABASE_URL` es la de esta corrida (`_test`).
 */
const PUERTO_WORKER = '8011';
const PUERTO_WORKER_CAIDO = '8012';
/** Secreto de prueba del nonce de los sobres (≥16 caracteres; solo existe en estos servidores). */
const AGENT_NONCE_SECRET = 'e2e-agent-nonce-secret-no-es-real-0123456789';
/**
 * Secreto de sesión de PRUEBA de los servidores del chat. Permite a `src/login.ts` firmar la cookie de
 * un usuario sembrado que el selector del login de desarrollo no ofrece (operativo). Solo existe aquí.
 */
const SESSION_SECRET = 'e2e-session-secret-no-es-real-0123456789';

/** El worker resuelve el modelo por nivel (`AI_MODEL_<NIVEL>`); con `AI_PROVIDER=fake` el nombre es solo un rótulo. */
const MODELOS_FAKE = {
  AI_MODEL_EFICIENTE: 'fake/eficiente',
  AI_MODEL_EQUILIBRADO: 'fake/equilibrado',
  AI_MODEL_AVANZADO: 'fake/avanzado',
  AI_MODEL_EMBEDDINGS: 'fake/embeddings',
};

const ENV_CHAT = {
  ...ENV_BASE,
  BRIEF_WORKSPACE_V2: 'true',
  AGENT_NONCE_SECRET,
  SESSION_SECRET,
  STORAGE_LOCAL_PATH,
  // Tope de adjuntos del chat bajado a 1 MB para probar «archivo demasiado grande» sin archivos enormes.
  CHAT_ATTACHMENT_MAX_MB: '1',
  AI_ENABLED: 'true',
  AI_PROVIDER: 'fake',
  ...MODELOS_FAKE,
  // Un fallo del modelo debe verse rápido en la prueba (el cliente reintenta 2 veces con 1 s / 3 s).
  AGENT_MODEL_TIMEOUT_S: '20',
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
    {
      name: 'chat',
      // Compilación bajo demanda de `next dev` en la primera visita (ver nota en `src/nav.ts`): holgura de arranque.
      timeout: 120_000,
      testMatch: /chat-(acceso|conversacion|herramientas|hitl|adjuntos)\.spec\.ts$/,
      use: { baseURL: 'http://localhost:3012' },
    },
    {
      // V2 · Fase 7 — Contenido (guiones, revisión y aprobación). Mismo patrón que `chat`: IA falsa
      // determinista en el worker 8011. `chat-contenido` (E2E-16) también corre aquí: el servidor
      // del chat (3012) no es necesario, pero este puerto trae la misma configuración.
      name: 'contenido',
      // Compilación bajo demanda de `next dev` en la primera visita (ver nota en `src/nav.ts`): holgura de arranque.
      timeout: 120_000,
      testMatch: /(contenido-(flujo|aprobacion|acceso|sin-brief|inyeccion)|chat-contenido)\.spec\.ts$/,
      use: { baseURL: 'http://localhost:3015' },
    },
    {
      name: 'chat-ia-off',
      // Compilación bajo demanda de `next dev` en la primera visita (ver nota en `src/nav.ts`): holgura de arranque.
      timeout: 120_000,
      testMatch: /chat-ia-apagada\.spec\.ts$/,
      use: { baseURL: 'http://localhost:3013' },
    },
    {
      name: 'chat-worker-caido',
      // Compilación bajo demanda de `next dev` en la primera visita (ver nota en `src/nav.ts`): holgura de arranque.
      timeout: 120_000,
      testMatch: /chat-worker-caido\.spec\.ts$/,
      use: { baseURL: 'http://localhost:3014' },
    },
  ],
  webServer: [
    {
      command: 'npm run dev --workspace=@tcl-kol-os/web',
      cwd: '../../',
      url: 'http://localhost:3010/login',
      env: { ...ENV_BASE, WEB_PORT: '3010', BRIEF_WORKSPACE_V2: 'false' },
      reuseExistingServer: reutilizar,
      timeout: 600_000,
      stdout: 'pipe',
      stderr: 'pipe',
    },
    {
      command: 'npm run dev --workspace=@tcl-kol-os/web',
      cwd: '../../',
      url: 'http://localhost:3011/login',
      env: { ...ENV_BASE, WEB_PORT: '3011', BRIEF_WORKSPACE_V2: 'true' },
      reuseExistingServer: reutilizar,
      timeout: 600_000,
      stdout: 'pipe',
      stderr: 'pipe',
    },
    {
      // Worker real del servicio (venv local, Python 3.9). `REDIS_URL` es obligatoria para arrancar
      // pero este endpoint no la usa: apunta a un puerto sin nadie.
      command: `.venv/bin/python -m uvicorn app.main:app --host 127.0.0.1 --port ${PUERTO_WORKER}`,
      cwd: '../../services/ai-worker',
      url: `http://127.0.0.1:${PUERTO_WORKER}/health`,
      env: {
        DATABASE_URL,
        REDIS_URL: 'redis://127.0.0.1:6399',
        AI_ENABLED: 'true',
        AI_PROVIDER: 'fake',
        ...MODELOS_FAKE,
        STORAGE_LOCAL_PATH,
        ENVIRONMENT: 'development',
      },
      reuseExistingServer: reutilizar,
      timeout: 600_000,
      stdout: 'pipe',
      stderr: 'pipe',
    },
    {
      command: 'npm run dev --workspace=@tcl-kol-os/web',
      cwd: '../../',
      url: 'http://localhost:3012/login',
      env: { ...ENV_CHAT, WEB_PORT: '3012', AI_WORKER_URL: `http://127.0.0.1:${PUERTO_WORKER}` },
      reuseExistingServer: reutilizar,
      timeout: 600_000,
      stdout: 'pipe',
      stderr: 'pipe',
    },
    {
      command: 'npm run dev --workspace=@tcl-kol-os/web',
      cwd: '../../',
      url: 'http://localhost:3013/login',
      env: {
        ...ENV_CHAT,
        WEB_PORT: '3013',
        AI_ENABLED: 'false',
        AI_WORKER_URL: `http://127.0.0.1:${PUERTO_WORKER}`,
      },
      reuseExistingServer: reutilizar,
      timeout: 600_000,
      stdout: 'pipe',
      stderr: 'pipe',
    },
    {
      command: 'npm run dev --workspace=@tcl-kol-os/web',
      cwd: '../../',
      url: 'http://localhost:3014/login',
      env: { ...ENV_CHAT, WEB_PORT: '3014', AI_WORKER_URL: `http://127.0.0.1:${PUERTO_WORKER_CAIDO}` },
      reuseExistingServer: reutilizar,
      timeout: 600_000,
      stdout: 'pipe',
      stderr: 'pipe',
    },
    {
      // V2 · Fase 7 — proyecto `contenido`: IA encendida contra el worker real 8011 (modelo falso).
      command: 'npm run dev --workspace=@tcl-kol-os/web',
      cwd: '../../',
      url: 'http://localhost:3015/login',
      env: { ...ENV_CHAT, WEB_PORT: '3015', AI_WORKER_URL: `http://127.0.0.1:${PUERTO_WORKER}` },
      reuseExistingServer: reutilizar,
      timeout: 600_000,
      stdout: 'pipe',
      stderr: 'pipe',
    },
  ],
});
