import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig } from '@playwright/test';

/**
 * QA adversarial de la capa web de la Fase 7 (U1–U12): configuración PROPIA, aparte de
 * `playwright.config.ts` (que no se toca). Levanta (o reutiliza) su propio servidor web en 3040 y su worker
 * de IA falso en 8021, para no pisar los puertos 3010–3015 / 8011–8012 del E2E oficial.
 *
 *   E2E_DATABASE_URL=postgresql://…/<base>_test npx playwright test -c playwright.qa-f7-ui.config.ts
 *
 * La base DEBE terminar en `_test` (mismo candado que el E2E oficial). Datos siempre sintéticos.
 */
const DATABASE_URL =
  process.env['E2E_DATABASE_URL'] ?? 'postgresql://tclkolos:devpassword@localhost:5434/tclkolos_test';
if (!/\/[A-Za-z0-9_-]*_test(?:\?.*)?$/.test(DATABASE_URL)) {
  throw new Error(`QA F7 UI: E2E_DATABASE_URL debe apuntar a una base "_test". Recibido: ${DATABASE_URL}`);
}
process.env['DATABASE_URL'] = DATABASE_URL;

const STORAGE_LOCAL_PATH = join(tmpdir(), 'tcl-kol-os-qaui-storage');
process.env['STORAGE_LOCAL_PATH'] = STORAGE_LOCAL_PATH;

const PUERTO_WEB = '3040';
const PUERTO_WORKER = '8021';
const SESSION_SECRET = 'qaui-session-secret-no-es-real-0123456789';
const AGENT_NONCE_SECRET = 'qaui-agent-nonce-secret-no-es-real-0123456789';
const MODELOS_FAKE = {
  AI_MODEL_EFICIENTE: 'fake/eficiente',
  AI_MODEL_EQUILIBRADO: 'fake/equilibrado',
  AI_MODEL_AVANZADO: 'fake/avanzado',
  AI_MODEL_EMBEDDINGS: 'fake/embeddings',
};

export default defineConfig({
  testDir: './tests',
  testMatch: /qa-f7-ui-.*\.spec\.ts$/,
  timeout: 120_000,
  expect: { timeout: 8_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    channel: 'chrome',
    baseURL: `http://localhost:${PUERTO_WEB}`,
    screenshot: 'only-on-failure',
    trace: 'off',
  },
  webServer: [
    {
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
      reuseExistingServer: true,
      timeout: 600_000,
      stdout: 'pipe',
      stderr: 'pipe',
    },
    {
      command: 'npm run dev --workspace=@tcl-kol-os/web',
      cwd: '../../',
      url: `http://localhost:${PUERTO_WEB}/login`,
      env: {
        DATABASE_URL,
        AUTH_PROVIDER: 'dev',
        BRIEF_WORKSPACE_V2: 'true',
        AGENT_NONCE_SECRET,
        SESSION_SECRET,
        STORAGE_LOCAL_PATH,
        CHAT_ATTACHMENT_MAX_MB: '1',
        AI_ENABLED: 'true',
        AI_PROVIDER: 'fake',
        ...MODELOS_FAKE,
        AGENT_MODEL_TIMEOUT_S: '20',
        WEB_PORT: PUERTO_WEB,
        AI_WORKER_URL: `http://127.0.0.1:${PUERTO_WORKER}`,
      },
      reuseExistingServer: true,
      timeout: 600_000,
      stdout: 'pipe',
      stderr: 'pipe',
    },
  ],
});
