import type { ChildProcess } from 'node:child_process';
import { expect, test } from '@playwright/test';
import { cargarActores, limpiarTodo, nuevaCampanaConBrief } from '../src/fixtures';
import {
  RESPUESTA_FAKE,
  abrirChat,
  arrancarWorkerDeModelo,
  detenerProceso,
  enviarMensaje,
  esperarRespuestas,
  esperarSinRunActivo,
  mensajesDe,
  runsDe,
} from '../src/chat';
import { login } from '../src/login';

/**
 * E2E-15b — worker caído (puerto 3014 → `AI_WORKER_URL` en 8012, donde no corre nadie): el run termina
 * `failed` con un código SANEADO y un botón de reintento; al levantar el worker, reintentar completa.
 * Este spec es el dueño del puerto 8012: arranca y apaga su propio worker.
 */
test.describe.configure({ mode: 'serial' });

let worker: ChildProcess | undefined;
test.afterAll(async () => {
  detenerProceso(worker);
  await limpiarTodo();
});

test('E2E-15b — con el worker caído el run falla con código sanitizado; reintentar con el worker arriba completa', async ({
  page,
}) => {
  test.setTimeout(180_000);
  // Precondición: de verdad no hay nadie escuchando en 8012.
  const vivo = await fetch('http://127.0.0.1:8012/health').then(
    () => true,
    () => false,
  );
  expect(vivo, 'el puerto 8012 debe estar libre al empezar').toBe(false);

  const { admin, consultor } = await cargarActores();
  const { campaignId } = await nuevaCampanaConBrief(admin, 'e2e-15b-worker-caido');
  await login(page, consultor.email);
  await abrirChat(page, campaignId);

  const texto = 'Pregunta mientras el worker está caído E2E-15b';
  await enviarMensaje(page, texto);

  // El cliente reintenta 2 veces (1 s / 3 s) y luego el run queda `failed`: se espera ese ESTADO, no un tiempo.
  const estado = page.locator('[data-testid="chat-run-status"][data-status="failed"]');
  await expect(estado).toBeVisible({ timeout: 60_000 });
  await expect(estado.getByTestId('chat-run-status-text')).toHaveText(/El modelo no respondió/);
  await expect(estado.getByTestId('chat-run-error-code')).toHaveText('Código: AGENT_MODEL_UNAVAILABLE');
  await expect(estado.getByTestId('chat-run-retry')).toBeVisible();
  // Nada técnico llega a la pantalla: ni URL del worker, ni errores de red.
  const visible = (await estado.textContent()) ?? '';
  expect(visible).not.toMatch(/8012|127\.0\.0\.1|localhost|ECONN|fetch|WORKER_UNREACHABLE|undici/i);
  // Un turno fallido no deja mensaje del asistente y el usuario conserva el suyo.
  await expect(page.locator('[data-testid="chat-message"][data-role="assistant"]')).toHaveCount(0);
  await expect(page.locator('[data-testid="chat-message"][data-role="user"]')).toHaveCount(1);

  let runs = await runsDe(campaignId);
  expect(runs).toHaveLength(1);
  expect(runs[0]).toMatchObject({ status: 'failed', attempt: 1, error_code: 'AGENT_MODEL_UNAVAILABLE' });
  expect(runs[0]!.error_message ?? '').not.toMatch(/8012|127\.0\.0\.1|localhost|ECONN/i);

  // Se levanta el worker REAL y se reintenta desde la interfaz.
  worker = await arrancarWorkerDeModelo(8012);
  await estado.getByTestId('chat-run-retry').click();
  await esperarRespuestas(page, 1, 60_000);
  await expect(
    page.locator('[data-testid="chat-message"][data-role="assistant"] [data-testid="chat-message-content"]'),
  ).toHaveText(RESPUESTA_FAKE);
  await esperarSinRunActivo(page);
  await expect(page.locator('[data-testid="chat-run-status"][data-status="failed"]')).toHaveCount(0);

  // Dos intentos del MISMO mensaje: el 1.º fallido, el 2.º completado; y un solo mensaje de usuario.
  runs = await runsDe(campaignId);
  expect(runs.map((r) => `${r.attempt}:${r.status}`)).toEqual(['1:failed', '2:completed']);
  const mensajes = await mensajesDe(campaignId);
  expect(mensajes.map((m) => m.role)).toEqual(['user', 'assistant']);
  expect(mensajes[0]!.content).toBe(texto);
  // La UI marca el intento anterior como no completado.
  await expect(page.getByTestId('chat-run-previous')).toBeVisible();
});
