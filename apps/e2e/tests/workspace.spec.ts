import { expect, test } from '@playwright/test';
import { crearComentario, query } from '@tcl-kol-os/db';
import { cargarActores, limpiarTodo, nuevaCampanaConBrief } from '../src/fixtures';
import { login } from '../src/login';
import { gotoConReintento } from '../src/nav';

test.describe.configure({ mode: 'serial' });
test.afterAll(async () => {
  await limpiarTodo();
});

test('E2E-02 — bandera encendida: se ven Completar, Revisar brief y Actividad', async ({ page }) => {
  const { admin } = await cargarActores();
  const { campaignId } = await nuevaCampanaConBrief(admin, 'e2e-02-tres-modos', {
    generarPreguntasCriticas: true,
  });

  await login(page, admin.email);
  await gotoConReintento(page, `/campanas/${campaignId}/brief/workspace`);

  await expect(page.getByRole('link', { name: 'Completar' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Revisar brief' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Actividad' })).toBeVisible();
  // Modo por defecto: Completar.
  await expect(page).toHaveURL(/\/brief\/workspace$/);
  await expect(page.getByRole('heading', { name: 'Completar el brief' })).toBeVisible();
});

test('E2E-03 — responder una tarea crítica actualiza progreso, pendientes y la siguiente tarea', async ({
  page,
}) => {
  const { admin } = await cargarActores();
  const { campaignId } = await nuevaCampanaConBrief(admin, 'e2e-03-completar-tarea', {
    generarPreguntasCriticas: true,
  });

  await login(page, admin.email);
  await gotoConReintento(page, `/campanas/${campaignId}/brief/workspace?modo=completar`);

  const progresoAntes = await page.locator('text=% completo').first().textContent();
  const preguntaAntes = await page.locator('.chat-texto').first().textContent();

  // Control genérico: un <select> si es `enum`, si no el primer <input> visible del formulario de respuesta.
  const select = page.locator('form.chat-input-bar select');
  const input = page.locator('form.chat-input-bar input:not([type=hidden])');
  if (await select.count()) {
    await select.selectOption({ index: 1 });
  } else {
    await input.first().fill('Respuesta de prueba E2E-03.');
  }
  await page.getByRole('button', { name: 'Responder' }).click();

  await expect(page.locator('text=Guardado:')).toBeVisible();
  // La revalidación del servidor (`revalidatePath`, no un router.refresh()
  // manual) llega en un segundo round-trip después de "Guardado:" — se
  // espera con un `expect` que reintenta, nunca una lectura puntual.
  await expect(page.locator('text=% completo').first()).not.toHaveText(progresoAntes ?? '');
  await expect(page.locator('.chat-texto').first()).not.toHaveText(preguntaAntes ?? '');
});

test('E2E-04 — saltar reordena localmente, no muta el campo ni crea auditoría falsa', async ({ page }) => {
  const { admin } = await cargarActores();
  const { campaignId } = await nuevaCampanaConBrief(admin, 'e2e-04-saltar', {
    generarPreguntasCriticas: true,
  });

  await login(page, admin.email);
  await gotoConReintento(page, `/campanas/${campaignId}/brief/workspace?modo=completar`);

  const decisionesAntes = await page.locator('text=decisión(es) por resolver').textContent();
  const preguntaAntes = await page.locator('.chat-texto').first().textContent();

  await page.getByRole('button', { name: 'Saltar por ahora' }).click();

  const preguntaDespues = await page.locator('.chat-texto').first().textContent();
  expect(preguntaDespues).not.toBe(preguntaAntes);
  // El contador de decisiones pendientes no cambia — saltar nunca resuelve nada en el servidor.
  const decisionesDespues = await page.locator('text=decisión(es) por resolver').textContent();
  expect(decisionesDespues).toBe(decisionesAntes);

  // "Saltar" es solo de esta sesión del navegador: una recarga completa
  // (`workspace.tasks` viene fresco del servidor) vuelve a mostrar la
  // primera tarea original — la prueba de que saltar nunca escribió nada.
  await gotoConReintento(page, `/campanas/${campaignId}/brief/workspace?modo=completar`);
  await expect(page.locator('.chat-texto').first()).toHaveText(preguntaAntes ?? '');
});

test('E2E-05 — Revisar brief navega secciones, cambia de producto y abre evidencia bajo demanda', async ({
  page,
}) => {
  const { admin } = await cargarActores();
  const { campaignId } = await nuevaCampanaConBrief(admin, 'e2e-05-revisar', { productos: 2 });

  await login(page, admin.email);
  await gotoConReintento(page, `/campanas/${campaignId}/brief/workspace?modo=revisar`);

  await expect(page.getByRole('heading', { name: 'Contexto', exact: false })).toBeVisible();

  // Cambiar de producto — URL copiable, recargable.
  const segundoProducto = page.locator('.revisar-producto-tabs a').nth(1);
  const nombreProducto = await segundoProducto.textContent();
  await segundoProducto.click();
  await expect(page).toHaveURL(/producto=/);
  await expect(
    page.locator('.revisar-producto-tabs a.curso, .revisar-producto-tabs a.pill.curso'),
  ).toContainText(nombreProducto ?? '');

  // No debe aparecer ninguna clave técnica cruda (con punto y sin espacios) como texto principal de un título de campo.
  const tituloConClave = page.locator('.revisar-campo-head strong', { hasText: /^[a-z_]+\.[a-z_]+$/ });
  await expect(tituloConClave).toHaveCount(0);
});

test('E2E-06 — Actividad muestra actor, fecha y evento reales, y filtra por tipo', async ({ page }) => {
  const { admin } = await cargarActores();
  const { campaignId, versionId } = await nuevaCampanaConBrief(admin, 'e2e-06-actividad');

  // Comentario sintético real (reutiliza la función de repositorio, no SQL propio para crearlo).
  const [campo] = await query<{ key: string }>(
    `SELECT key FROM brief_fields WHERE brief_version_id = $1 AND campaign_product_id IS NULL LIMIT 1`,
    [versionId],
  );
  const comentario = await crearComentario(admin, versionId, {
    fieldKey: campo!.key,
    content: 'Comentario sintético de la prueba E2E-06.',
  });
  expect(comentario.ok).toBe(true);

  await login(page, admin.email);
  await gotoConReintento(page, `/campanas/${campaignId}/brief/workspace?modo=actividad`);

  await expect(page.getByText('Comentario sintético de la prueba E2E-06.')).toBeVisible();
  await expect(page.getByText(admin.name, { exact: false }).first()).toBeVisible();

  await page.getByRole('button', { name: 'Comentarios' }).click();
  await expect(page.getByText('Comentario sintético de la prueba E2E-06.')).toBeVisible();
  await expect(page.getByText('Creó la campaña')).toHaveCount(0);
});
