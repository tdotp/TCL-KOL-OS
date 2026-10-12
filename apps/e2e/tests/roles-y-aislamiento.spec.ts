import { expect, test } from '@playwright/test';
import { crearComentario, query } from '@tcl-kol-os/db';
import {
  cargarActores,
  completarHastaInternalReview,
  limpiarTodo,
  nuevaCampanaConBrief,
} from '../src/fixtures';
import { login } from '../src/login';
import { gotoConReintento } from '../src/nav';

test.describe.configure({ mode: 'serial' });
test.afterAll(async () => {
  await limpiarTodo();
});

test('E2E-07 — consultor ve a quién le toca aprobar y no puede; director ve la acción permitida', async ({
  page,
}) => {
  const { admin, consultor, director } = await cargarActores();
  const { campaignId, versionId } = await nuevaCampanaConBrief(admin, 'e2e-07-roles');
  await completarHastaInternalReview(admin, campaignId, versionId);

  await login(page, consultor.email);
  await gotoConReintento(page, `/campanas/${campaignId}/brief/workspace`);
  await expect(page.locator('.workspace-responsibility')).toContainText(
    'Pendiente de aprobación por Dirección.',
  );
  // Consultor no es aprobador (APPROVER_ROLES = admin/director) — no debe
  // haber ningún enlace de acción en el banner, solo la explicación.
  await expect(page.locator('.workspace-responsibility a.btn')).toHaveCount(0);

  await login(page, director.email);
  await gotoConReintento(page, `/campanas/${campaignId}/brief/workspace`);
  await expect(page.locator('.workspace-responsibility')).toContainText(
    'Pendiente de aprobación por Dirección.',
  );
  const accion = page.locator('.workspace-responsibility a.btn');
  await expect(accion).toHaveCount(1);
  // Aprobar cierra el brief (solo SmartPR); ya no existe el paso intermedio de cliente.
  await expect(accion).toContainText('Aprobar');
  await expect(accion).not.toContainText('internamente');
  // La acción real vive en `/brief` (el formulario de transición existente)
  // — este workspace nunca reimplementa esa lógica, solo enlaza a ella.
  await expect(accion).toHaveAttribute('href', `/campanas/${campaignId}/brief`);
});

test('E2E-08 — cliente no accede al workspace interno ni recibe comentarios ni metadata de IA', async ({
  page,
}) => {
  const { admin, cliente } = await cargarActores();
  const { campaignId, versionId } = await nuevaCampanaConBrief(admin, 'e2e-08-cliente');

  const [campo] = await query<{ key: string }>(
    `SELECT key FROM brief_fields WHERE brief_version_id = $1 AND campaign_product_id IS NULL LIMIT 1`,
    [versionId],
  );
  const comentario = await crearComentario(admin, versionId, {
    fieldKey: campo!.key,
    content: 'COMENTARIO-INTERNO-E2E-08: nunca debe llegar al cliente.',
  });
  expect(comentario.ok).toBe(true);

  await login(page, cliente.email);
  await gotoConReintento(page, `/campanas/${campaignId}/brief/workspace?modo=actividad`);

  // Nunca el workspace interno: el cliente termina en su zona de solo lectura (`/tcl`; esta campaña es interna,
  // así que allí es un 404), jamás en el workspace ni en el Brief interno.
  await expect(page).toHaveURL(new RegExp(`/tcl/campanas/${campaignId}/brief$`));
  await expect(page).not.toHaveURL(/workspace/);
  await expect(page.getByRole('link', { name: 'Revisar brief' })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Actividad' })).toHaveCount(0);

  const cuerpo = await page.locator('body').innerText();
  expect(cuerpo).not.toContain('COMENTARIO-INTERNO-E2E-08');
  expect(cuerpo.toLowerCase()).not.toContain('ai_provider');
  expect(cuerpo.toLowerCase()).not.toContain('gpt-');
  expect(cuerpo.toLowerCase()).not.toContain('claude-');
});

test('E2E-09 — una organización no puede abrir el workspace de otra', async ({ page }) => {
  const { admin, ajeno } = await cargarActores();
  const { campaignId } = await nuevaCampanaConBrief(admin, 'e2e-09-aislamiento');

  await login(page, ajeno.email);
  const respuesta = await gotoConReintento(page, `/campanas/${campaignId}/brief/workspace?modo=revisar`);

  // `getCampaign` responde igual a "no existe" que a "es de otra
  // organización" (S-01: no revelar que el recurso existe) — un 404 real,
  // nunca el contenido del workspace.
  expect(respuesta?.status()).toBe(404);
  await expect(page.getByRole('heading', { name: 'Revisar brief' })).toHaveCount(0);
  const cuerpo = await page.locator('body').innerText();
  expect(cuerpo).not.toContain('e2e-09-aislamiento');
});
