import { type Page, expect, request as pwRequest, test } from '@playwright/test';
import { cargarActores, limpiarTodo, nuevaCampanaConBrief } from '../src/fixtures';
import { EMAILS, abrirChat, fuentesDe, usuarioPorEmail } from '../src/chat';
import { login, loginPorCookie } from '../src/login';
import { gotoConReintento } from '../src/nav';

test.describe.configure({ mode: 'serial' });
test.afterAll(async () => {
  await limpiarTodo();
});

const BASE = 'http://localhost:3012';
const ARCHIVO = { name: 'nota.csv', mimeType: 'text/csv', buffer: Buffer.from('a,b\n1,2\n', 'utf8') };

let campaignId = '';

/** El selector del login de desarrollo no ofrece al operativo: se entra con la cookie firmada de prueba. */
async function entrar(page: Page, email: string): Promise<void> {
  if (email === EMAILS.operativo) await loginPorCookie(page, (await usuarioPorEmail(email)).id);
  else await login(page, email);
}

test.beforeAll(async () => {
  const { admin } = await cargarActores();
  ({ campaignId } = await nuevaCampanaConBrief(admin, 'e2e-10-acceso'));
});

test('E2E-10a — admin, director y consultor ven el enlace del asistente y la página del chat', async ({
  page,
}) => {
  for (const email of [EMAILS.admin, EMAILS.director, EMAILS.consultor]) {
    await login(page, email);
    await gotoConReintento(page, `/campanas/${campaignId}`);
    const enlace = page.getByTestId('chat-nav-link');
    await expect(enlace, `enlace visible para ${email}`).toBeVisible();
    await expect(enlace).toHaveAttribute('href', `/campanas/${campaignId}/chat`);

    await abrirChat(page, campaignId);
    // Sin conversación todavía: el hilo está vacío y el composer disponible (IA encendida en este puerto).
    await expect(page.getByTestId('chat-thread')).toBeVisible();
    await expect(page.getByTestId('chat-empty')).toBeVisible();
    await expect(page.getByTestId('chat-composer')).toBeVisible();
    await expect(page.getByTestId('chat-ai-off')).toHaveCount(0);
    await expect(page.getByTestId('chat-ai-unconfigured')).toHaveCount(0);
  }
});

for (const [etiqueta, email] of [
  ['cliente', EMAILS.cliente],
  ['operativo', EMAILS.operativo],
  ['usuario de otra agencia', EMAILS.ajeno],
] as const) {
  test(`E2E-10b — ${etiqueta}: 404 en el chat y sin enlace`, async ({ page }) => {
    await entrar(page, email);
    const respuesta = await gotoConReintento(page, `/campanas/${campaignId}/chat`);
    expect(respuesta?.status()).toBe(404);
    await expect(page.getByTestId('chat-page')).toHaveCount(0);
    await expect(page.getByTestId('chat-composer')).toHaveCount(0);

    // El enlace tampoco existe (la campaña puede ser 404 para ese rol; en cualquier caso, nunca el enlace).
    await gotoConReintento(page, `/campanas/${campaignId}`);
    await expect(page.getByTestId('chat-nav-link')).toHaveCount(0);
  });
}

test('E2E-10c — API de adjuntos: cliente, operativo y otra agencia → 404; sin sesión → 401', async ({
  page,
}) => {
  for (const email of [EMAILS.cliente, EMAILS.operativo, EMAILS.ajeno]) {
    await entrar(page, email);
    const url = `/api/campanas/${campaignId}/chat/adjuntos`;
    const get = await page.request.get(`${url}?ids=${'0'.repeat(8)}-0000-0000-0000-${'0'.repeat(12)}`);
    expect(get.status(), `GET como ${email}`).toBe(404);
    const post = await page.request.post(url, { multipart: { archivo: ARCHIVO } });
    expect(post.status(), `POST como ${email}`).toBe(404);
    // El cuerpo no revela nada del recurso.
    expect(JSON.stringify(await post.json())).not.toContain(campaignId);
  }

  const anonimo = await pwRequest.newContext({ baseURL: BASE });
  try {
    const url = `/api/campanas/${campaignId}/chat/adjuntos`;
    expect((await anonimo.get(`${url}?ids=x`)).status()).toBe(401);
    expect((await anonimo.post(url, { multipart: { archivo: ARCHIVO } })).status()).toBe(401);
  } finally {
    await anonimo.dispose();
  }
});

test('E2E-10d — POST de adjuntos con Origin ajeno o Sec-Fetch-Site cruzado → 403, aunque haya sesión válida', async ({
  page,
}) => {
  await login(page, EMAILS.consultor);
  const url = `/api/campanas/${campaignId}/chat/adjuntos`;

  const origenAjeno = await page.request.post(url, {
    multipart: { archivo: ARCHIVO },
    headers: { Origin: 'https://sitio-malicioso.example' },
  });
  expect(origenAjeno.status()).toBe(403);

  const sitioCruzado = await page.request.post(url, {
    multipart: { archivo: ARCHIVO },
    headers: { 'Sec-Fetch-Site': 'cross-site' },
  });
  expect(sitioCruzado.status()).toBe(403);

  // Sin sesión y con Origin ajeno: también 403 (el origen se comprueba antes que la sesión).
  const anonimo = await pwRequest.newContext({ baseURL: BASE });
  try {
    const r = await anonimo.post(url, {
      multipart: { archivo: ARCHIVO },
      headers: { Origin: 'https://sitio-malicioso.example' },
    });
    expect(r.status()).toBe(403);
  } finally {
    await anonimo.dispose();
  }

  // Y no quedó ninguna fuente nueva por esos intentos.
  expect(await fuentesDe(campaignId)).toHaveLength(0);
});
