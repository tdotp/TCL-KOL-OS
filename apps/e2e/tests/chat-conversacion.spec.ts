import { type Page, expect, test } from '@playwright/test';
import { cargarActores, limpiarTodo, nuevaCampanaConBrief } from '../src/fixtures';
import {
  RESPUESTA_FAKE,
  abrirChat,
  contarConversaciones,
  conversacionesDe,
  enviarMensaje,
  esperarRespuestas,
  esperarSinRunActivo,
  mensajesDe,
  runsDe,
} from '../src/chat';
import { login } from '../src/login';

/**
 * E2E-11 — conversación: servidor web real + worker real con el modelo falso determinista.
 * Cada test enciende su propia sesión; todos comparten UNA campaña desechable (serial) para poder
 * contar mensajes y conversaciones acumuladas.
 */
test.describe.configure({ mode: 'serial' });
test.afterAll(async () => {
  await limpiarTodo();
});

let campaignId = '';
let consultorId = '';
let directorId = '';

test.beforeAll(async () => {
  const { admin, consultor, director } = await cargarActores();
  ({ campaignId } = await nuevaCampanaConBrief(admin, 'e2e-11-conversacion'));
  consultorId = consultor.id;
  directorId = director.id;
});

const burbujasPropias = (page: Page) =>
  page.locator('[data-testid="chat-message"][data-role="user"] [data-testid="chat-message-content"]');

test('E2E-11a — abrir el chat (GET) nunca crea la conversación; se crea al enviar el primer mensaje', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const { consultor } = await cargarActores();
  expect(await contarConversaciones(campaignId)).toBe(0);

  await login(page, consultor.email);
  await abrirChat(page, campaignId);
  await page.reload();
  await expect(page.getByTestId('chat-empty')).toBeVisible();
  // Tras visitar (y recargar) la pantalla la base sigue igual: leer no escribe.
  expect(await contarConversaciones(campaignId)).toBe(0);
  expect(await mensajesDe(campaignId)).toHaveLength(0);
  expect(await runsDe(campaignId)).toHaveLength(0);

  const texto = 'Hola asistente, ¿puedes resumirme el estado de la campaña?';
  await enviarMensaje(page, texto);

  // Burbuja propia + respuesta del asistente (texto fijo del modelo falso).
  await expect(burbujasPropias(page).first()).toHaveText(texto);
  await esperarRespuestas(page, 1);
  await expect(
    page.locator('[data-testid="chat-message"][data-role="assistant"] [data-testid="chat-message-content"]'),
  ).toHaveText(RESPUESTA_FAKE);
  // Un turno completado no deja estado de run pendiente ni de error, y el composer vuelve a estar libre.
  await esperarSinRunActivo(page);
  await expect(page.locator('[data-testid="chat-run-status"][data-status="failed"]')).toHaveCount(0);
  await expect(page.getByTestId('chat-empty')).toHaveCount(0);

  // Orden y atribución en la base: user → assistant, de la misma conversación del consultor.
  const conversaciones = await conversacionesDe(campaignId);
  expect(conversaciones).toHaveLength(1);
  expect(conversaciones[0]!.created_by).toBe(consultorId);
  const mensajes = await mensajesDe(campaignId);
  expect(mensajes.map((m) => m.role)).toEqual(['user', 'assistant']);
  expect(mensajes[0]!.content).toBe(texto);
  expect(mensajes[1]!.content).toBe(RESPUESTA_FAKE);
  const runs = await runsDe(campaignId);
  expect(runs).toHaveLength(1);
  expect(runs[0]).toMatchObject({ status: 'completed', attempt: 1, user_id: consultorId });
});

test('E2E-11b — reenvío idempotente: si la respuesta del envío se pierde, reintentar la misma redacción no duplica', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const { consultor } = await cargarActores();
  await login(page, consultor.email);
  await abrirChat(page, campaignId);
  await esperarRespuestas(page, 1);

  const antesMensajes = (await mensajesDe(campaignId)).length;
  const antesRuns = (await runsDe(campaignId)).length;

  // La PRIMERA server action llega al servidor (el mensaje se persiste) pero el navegador no recibe la
  // respuesta: es el caso real de «se cayó la conexión justo después de enviar».
  let perdidos = 0;
  await page.route(/\/campanas\/[^/]+\/chat$/, async (route) => {
    const request = route.request();
    if (request.method() === 'POST' && request.headers()['next-action'] !== undefined && perdidos === 0) {
      perdidos += 1;
      await route.fetch();
      await route.abort('failed');
      return;
    }
    await route.continue();
  });

  const texto = 'Mensaje de la prueba de idempotencia E2E-11b';
  await page.getByTestId('chat-input').fill(texto);
  await page.getByTestId('chat-send').click();
  await expect(page.getByTestId('chat-composer-error')).toBeVisible({ timeout: 20_000 });
  // La redacción NO se pierde: sigue en el cuadro para reenviarla tal cual.
  await expect(page.getByTestId('chat-input')).toHaveValue(texto);
  expect(perdidos).toBe(1);

  await page.getByTestId('chat-send').click();
  await expect(page.getByTestId('chat-input')).toHaveValue('', { timeout: 20_000 });
  await esperarRespuestas(page, 2);
  await esperarSinRunActivo(page);

  // Exactamente UN mensaje de usuario con esa redacción y UN run para él (no dos).
  const mensajes = await mensajesDe(campaignId);
  expect(mensajes.filter((m) => m.role === 'user' && m.content === texto)).toHaveLength(1);
  expect(mensajes).toHaveLength(antesMensajes + 2);
  expect(await runsDe(campaignId)).toHaveLength(antesRuns + 1);
  await expect(burbujasPropias(page).filter({ hasText: texto })).toHaveCount(1);
});

test('E2E-11c — texto plano: HTML y markdown del usuario se muestran literales, sin ejecutarse', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const { consultor } = await cargarActores();
  await login(page, consultor.email);
  await abrirChat(page, campaignId);
  const respuestasAntes = await page.locator('[data-testid="chat-message"][data-role="assistant"]').count();

  const texto =
    '<img src=x onerror="window.__xss_e2e=1"> **negrita** _cursiva_ <b>b</b> [enlace](https://x.test)';
  await enviarMensaje(page, texto);
  await esperarRespuestas(page, respuestasAntes + 1);
  await esperarSinRunActivo(page);

  const burbuja = burbujasPropias(page).filter({ hasText: '**negrita**' });
  await expect(burbuja).toHaveCount(1);
  // El texto aparece tal cual (literal)…
  await expect(burbuja).toHaveText(texto);
  // …y no se creó ningún elemento a partir de él.
  await expect(page.locator('[data-testid="chat-thread"] img')).toHaveCount(0);
  await expect(burbuja.locator('img, b, strong, em, a')).toHaveCount(0);
  await expect(page.getByTestId('chat-thread').locator('a[href="https://x.test"]')).toHaveCount(0);
  expect(
    await page.evaluate(() => (window as unknown as Record<string, unknown>)['__xss_e2e']),
  ).toBeUndefined();
});

test('E2E-11d — conversación owner-scoped: el director no ve la del consultor, y viceversa', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const { director, consultor } = await cargarActores();
  const antes = await mensajesDe(campaignId);
  const textoDelConsultor = antes.find((m) => m.role === 'user')!.content;
  expect(antes.length).toBeGreaterThan(0);

  await login(page, director.email);
  await abrirChat(page, campaignId);
  // Misma organización y misma campaña, pero NO su conversación: hilo vacío y nada del consultor.
  await expect(page.getByTestId('chat-empty')).toBeVisible();
  await expect(page.getByTestId('chat-message')).toHaveCount(0);
  await expect(page.getByTestId('chat-thread')).not.toContainText(textoDelConsultor);
  // Visitar no crea una conversación para el director.
  expect((await conversacionesDe(campaignId)).filter((c) => c.created_by === directorId)).toHaveLength(0);

  // El director escribe lo suyo: tiene su propia conversación aparte.
  const textoDelDirector = 'Consulta privada del director E2E-11d';
  await enviarMensaje(page, textoDelDirector);
  await esperarRespuestas(page, 1);
  await esperarSinRunActivo(page);
  await expect(burbujasPropias(page)).toHaveCount(1);
  await expect(page.getByTestId('chat-thread')).not.toContainText(textoDelConsultor);

  const conversaciones = await conversacionesDe(campaignId);
  expect(conversaciones.map((c) => c.created_by).sort()).toEqual([consultorId, directorId].sort());

  // El consultor sigue viendo lo suyo y no lo del director.
  await login(page, consultor.email);
  await abrirChat(page, campaignId);
  await expect(page.getByTestId('chat-thread')).toContainText(textoDelConsultor);
  await expect(page.getByTestId('chat-thread')).not.toContainText(textoDelDirector);
});
