import { expect, test } from '@playwright/test';
import { listSources, query } from '@tcl-kol-os/db';
import { cargarActores, limpiarTodo, nuevaCampanaConBrief } from '../src/fixtures';
import {
  abrirChat,
  enviarMensaje,
  esperarRespuestas,
  esperarSinRunActivo,
  fuentesDe,
  mensajesDe,
  procesarColaDeDocumentos,
} from '../src/chat';
import { login } from '../src/login';
import { gotoConReintento } from '../src/nav';

/**
 * E2E-14 — adjuntos del chat: archivo por la ruta HTTP de adjuntos (no por una server action), chip con
 * estado, vínculo al enviar, duplicado por hash, tope de tamaño, tipo inválido y visibilidad interna.
 * El servidor del chat corre con `CHAT_ATTACHMENT_MAX_MB=1` (ver `playwright.config.ts`).
 */
test.describe.configure({ mode: 'serial' });
test.afterAll(async () => {
  await limpiarTodo();
});

let campaignId = '';
const CSV = (clave: string) =>
  Buffer.from(`tema,detalle\n${clave},contenido sintético de prueba\nmercado,Colombia\n`, 'utf8');

test.beforeAll(async () => {
  const { admin } = await cargarActores();
  ({ campaignId } = await nuevaCampanaConBrief(admin, 'e2e-14-adjuntos'));
});

async function adjuntosVinculados(): Promise<{ message_id: string; source_id: string }[]> {
  return query(
    `SELECT message_id, source_id FROM chat_message_attachments WHERE campaign_id = $1 ORDER BY created_at`,
    [campaignId],
  );
}

test('E2E-14a — subir un CSV por el composer: chip con estado, se procesa y se vincula al enviar', async ({
  page,
}) => {
  test.setTimeout(150_000);
  const { consultor } = await cargarActores();
  await login(page, consultor.email);
  await abrirChat(page, campaignId);

  await page.getByTestId('chat-attach-input').setInputFiles({
    name: 'brief-de-reunion.csv',
    mimeType: 'text/csv',
    buffer: CSV('lanzamiento-a'),
  });
  const chip = page.getByTestId('chat-attach-chip');
  await expect(chip).toHaveCount(1, { timeout: 30_000 });
  await expect(chip).toContainText('brief-de-reunion.csv');
  await expect(chip.getByTestId('chat-attach-chip-estado')).toBeVisible();
  // Recién subida: aún sin procesar (el consumidor de la cola corre aparte).
  await expect(chip).toHaveAttribute('data-estado', /en_cola|procesando|listo/);
  const fuentes = await fuentesDe(campaignId);
  expect(fuentes).toHaveLength(1);

  // El consumidor real de la cola la procesa y el chip se actualiza SOLO (sondeo del composer).
  await procesarColaDeDocumentos();
  await expect(chip).toHaveAttribute('data-estado', 'listo', { timeout: 20_000 });
  await expect(chip.getByTestId('chat-attach-chip-estado')).toHaveText('Lista para el asistente');

  // Al enviar, el adjunto se vincula al mensaje y el chip del composer se limpia.
  await enviarMensaje(page, 'Aquí tienes las notas de la reunión.');
  await esperarRespuestas(page, 1);
  await esperarSinRunActivo(page);
  await expect(page.getByTestId('chat-attach-chip')).toHaveCount(0);
  const adjunto = page.getByTestId('chat-message-attachment');
  await expect(adjunto).toHaveCount(1);
  await expect(adjunto).toContainText('brief-de-reunion.csv');
  await expect(adjunto).toHaveAttribute('data-estado', 'listo');

  const vinculos = await adjuntosVinculados();
  expect(vinculos).toHaveLength(1);
  expect(vinculos[0]!.source_id).toBe(fuentes[0]!.id);
  const mensajeUsuario = (await mensajesDe(campaignId)).find((m) => m.role === 'user')!;
  expect(vinculos[0]!.message_id).toBe(mensajeUsuario.id);

  // La fuente nace INTERNA (la petición no puede elegir visibilidad).
  expect(fuentes[0]!.visibility).toBe('interna');
});

test('E2E-14b — subir el MISMO archivo otra vez vincula la fuente existente, sin duplicarla', async ({
  page,
}) => {
  test.setTimeout(150_000);
  const { consultor } = await cargarActores();
  const antes = await fuentesDe(campaignId);
  expect(antes).toHaveLength(1);

  await login(page, consultor.email);
  await abrirChat(page, campaignId);
  await page.getByTestId('chat-attach-input').setInputFiles({
    name: 'otro-nombre-mismo-contenido.csv',
    mimeType: 'text/csv',
    buffer: CSV('lanzamiento-a'), // mismos bytes → mismo hash
  });
  await expect(page.getByTestId('chat-composer-aviso')).toContainText('ya estaba en la campaña');
  const chip = page.getByTestId('chat-attach-chip');
  await expect(chip).toHaveCount(1);
  // El chip es la fuente EXISTENTE (con su nombre original), ya procesada.
  await expect(chip).toContainText('brief-de-reunion.csv');
  await expect(chip).toHaveAttribute('data-estado', 'listo');
  expect(await fuentesDe(campaignId)).toHaveLength(1);

  await enviarMensaje(page, 'Te vuelvo a adjuntar el mismo archivo.');
  await esperarRespuestas(page, 2);
  await esperarSinRunActivo(page);
  const vinculos = await adjuntosVinculados();
  expect(vinculos).toHaveLength(2);
  expect(new Set(vinculos.map((v) => v.source_id)).size).toBe(1); // las dos menciones apuntan a UNA fuente
  expect(vinculos[0]!.message_id).not.toBe(vinculos[1]!.message_id);
  expect(await fuentesDe(campaignId)).toHaveLength(1);
});

test('E2E-14c — archivo por encima del tope: error claro en la UI y 413 en la ruta; no se crea la fuente', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const { consultor } = await cargarActores();
  const antes = await fuentesDe(campaignId);
  await login(page, consultor.email);
  await abrirChat(page, campaignId);

  const grande = Buffer.alloc(2 * 1024 * 1024 + 1024, 'a'); // 2 MB: el tope del servidor de prueba es 1 MB
  await page
    .getByTestId('chat-attach-input')
    .setInputFiles({ name: 'enorme.csv', mimeType: 'text/csv', buffer: grande });
  await expect(page.getByTestId('chat-composer-error')).toContainText('pesa más de 1 MB');
  await expect(page.getByTestId('chat-attach-chip')).toHaveCount(0);

  // La UI no es la defensa: la ruta también lo rechaza antes de leer el cuerpo.
  const r = await page.request.post(`/api/campanas/${campaignId}/chat/adjuntos`, {
    multipart: { archivo: { name: 'enorme.csv', mimeType: 'text/csv', buffer: grande } },
  });
  expect(r.status()).toBe(413);
  expect(((await r.json()) as { error: string }).error).toContain('límite');
  expect(await fuentesDe(campaignId)).toHaveLength(antes.length);
});

test('E2E-14d — tipo inválido: error de dominio y ninguna fuente nueva', async ({ page }) => {
  test.setTimeout(120_000);
  const { consultor } = await cargarActores();
  const antes = await fuentesDe(campaignId);
  await login(page, consultor.email);
  await abrirChat(page, campaignId);

  // Un ejecutable disfrazado de documento: el tipo se valida por el CONTENIDO real, no por la extensión.
  await page.getByTestId('chat-attach-input').setInputFiles({
    name: 'programa.exe',
    mimeType: 'application/octet-stream',
    buffer: Buffer.concat([Buffer.from('MZ'), Buffer.alloc(512, 0x90)]),
  });
  await expect(page.getByTestId('chat-composer-error')).toBeVisible({ timeout: 20_000 });
  expect(((await page.getByTestId('chat-composer-error').textContent()) ?? '').length).toBeGreaterThan(10);
  await expect(page.getByTestId('chat-attach-chip')).toHaveCount(0);

  // Y por la ruta: 422 (validación), nunca un 500 ni una traza.
  const falsoPdf = await page.request.post(`/api/campanas/${campaignId}/chat/adjuntos`, {
    multipart: {
      archivo: {
        name: 'falso.pdf',
        mimeType: 'application/pdf',
        buffer: Buffer.from('esto no es un PDF real', 'utf8'),
      },
    },
  });
  expect(falsoPdf.status()).toBe(422);
  const cuerpo = JSON.stringify(await falsoPdf.json());
  expect(cuerpo).not.toMatch(/at \w+|node_modules|stack/i);

  // Sin campo `archivo`: 422 también.
  const vacio = await page.request.post(`/api/campanas/${campaignId}/chat/adjuntos`, {
    multipart: { otro: 'x' },
  });
  expect(vacio.status()).toBe(422);
  expect(await fuentesDe(campaignId)).toHaveLength(antes.length);
});

test('E2E-14e — la fuente adjuntada es interna: el cliente TCL no la ve', async ({ page }) => {
  test.setTimeout(120_000);
  const { cliente } = await cargarActores();
  const fuentes = await fuentesDe(campaignId);
  expect(fuentes.length).toBeGreaterThan(0);
  for (const f of fuentes) expect(f.visibility).toBe('interna');

  // Se comparte la campaña con TCL (como ocurre al aprobar el brief) para que la pregunta sea significativa:
  // la campaña es visible para el cliente, y aun así la fuente interna no.
  await query(`UPDATE campaigns SET visibility = 'tcl' WHERE id = $1`, [campaignId]);

  const lectura = await listSources(cliente, campaignId);
  if (lectura.ok) expect(lectura.value.map((s) => s.filename)).not.toContain('brief-de-reunion.csv');

  await login(page, cliente.email);
  for (const ruta of [`/campanas/${campaignId}`, `/campanas/${campaignId}/fuentes`]) {
    await gotoConReintento(page, ruta);
    const cuerpo = await page.locator('body').innerText();
    expect(cuerpo, `cuerpo de ${ruta}`).not.toContain('brief-de-reunion.csv');
  }
  // El chat sigue cerrado para el cliente, aunque la campaña sea visible.
  const chat = await gotoConReintento(page, `/campanas/${campaignId}/chat`);
  expect(chat?.status()).toBe(404);
  const api = await page.request.get(`/api/campanas/${campaignId}/chat/adjuntos?ids=${fuentes[0]!.id}`);
  expect(api.status()).toBe(404);
});
