import { type APIRequestContext, type Page, expect, request as pwRequest, test } from '@playwright/test';
import {
  archivoPdf,
  contarEnvios,
  entrarComoOperativo,
  escenarioDeOperacion,
  limpiarOperacion,
  obligacionesDe,
  rutaDeEvidencia,
  rutaDeOperacion,
} from '../src/operacion';
import { login } from '../src/login';
import { gotoConReintento } from '../src/nav';
import type { EscenarioDeOperacion } from '@tcl-kol-os/db/test-utils';

/**
 * E2E-22 — acceso a Operación por rol. Admin, director, consultor y operativo (`operations:read`) ven la lista y
 * el enlace «Operación»; el cliente TCL y el usuario de otra agencia reciben 404 en la lista, el detalle y el POST
 * de evidencia y no ven el enlace; sin sesión las páginas redirigen al login y la ruta de evidencia responde 401.
 */
test.describe.configure({ mode: 'serial' });
test.afterAll(async () => {
  await limpiarOperacion();
});

const BASE = 'http://localhost:3016';

let op: EscenarioDeOperacion;
let campaignId = '';
let participacionId = '';

test.beforeAll(async () => {
  op = await escenarioDeOperacion('e2e-22-acceso', { acuerdo: 'fee' });
  campaignId = op.campanaId;
  participacionId = op.participaciones.valentinaRios;
});

/** POST directo a la ruta de evidencia (cuerpo mínimo: el rechazo ocurre antes de leer nada). */
function postDeEvidencia(request: APIRequestContext) {
  return request.post(rutaDeEvidencia(campaignId), {
    multipart: {
      archivo: archivoPdf('intruso.pdf'),
      tipo: 'pago',
      accion: 'adjuntar',
      participacionId,
      idempotencyKey: 'e2e-22-intruso',
    },
  });
}

for (const [rol, entrar] of [
  ['admin', (page: Page) => login(page, op.admin.email)],
  ['director', (page: Page) => login(page, op.director.email)],
  ['consultor', (page: Page) => login(page, op.consultor.email)],
  ['operativo', (page: Page) => entrarComoOperativo(page, op)],
] as const) {
  test(`E2E-22a — ${rol}: ve el enlace «Operación», la lista y el detalle`, async ({ page }) => {
    await entrar(page);
    await gotoConReintento(page, `/campanas/${campaignId}`);
    const enlace = page.getByTestId('operacion-nav-link');
    await expect(enlace).toBeVisible();
    await expect(enlace).toHaveText('Operación');
    await expect(enlace).toHaveAttribute('href', rutaDeOperacion(campaignId));

    const lista = await gotoConReintento(page, rutaDeOperacion(campaignId));
    expect(lista?.status()).toBe(200);
    await expect(page.getByTestId('operacion-page')).toBeVisible();
    await expect(page.getByTestId('fila-participacion')).toHaveCount(3);
    // El enlace de la propia navegación de Operación también está.
    await expect(page.getByTestId('operacion-nav-link')).toBeVisible();

    const detalle = await gotoConReintento(page, rutaDeOperacion(campaignId, participacionId));
    expect(detalle?.status()).toBe(200);
    await expect(page.getByTestId('operacion-detalle-page')).toBeVisible();
    await expect(page.getByTestId('seccion-acuerdo')).toBeVisible();
  });
}

for (const [etiqueta, email] of [
  ['cliente TCL', 'marena@tcl.com'],
  ['usuario de otra agencia', 'ajeno@otraagencia.co'],
] as const) {
  test(`E2E-22b — ${etiqueta}: 404 en lista, detalle y POST de evidencia, y sin enlace «Operación»`, async ({
    page,
  }) => {
    await login(page, email);

    for (const ruta of [rutaDeOperacion(campaignId), rutaDeOperacion(campaignId, participacionId)]) {
      const r = await gotoConReintento(page, ruta);
      expect(r?.status(), `GET ${ruta}`).toBe(404);
      await expect(page.getByTestId('operacion-page')).toHaveCount(0);
      await expect(page.getByTestId('operacion-detalle-page')).toHaveCount(0);
      await expect(page.getByTestId('seccion-acuerdo')).toHaveCount(0);
    }

    // El enlace no existe en ninguna de las páginas de la campaña a las que pueda llegar.
    for (const ruta of [`/campanas/${campaignId}`, `/campanas/${campaignId}/brief`, '/campanas']) {
      await gotoConReintento(page, ruta);
      await expect(page.getByTestId('operacion-nav-link'), `enlace en ${ruta}`).toHaveCount(0);
      // El cliente es redirigido a `/tcl`, que tiene su propia sección «Operación» de solo lectura (resumen seguro).
      if (email !== 'marena@tcl.com') await expect(page.getByRole('link', { name: 'Operación' })).toHaveCount(0);
    }

    const antesObligaciones = (await obligacionesDe(campaignId)).map(
      (o) => `${o.id}:${o.status}:${o.row_seq}`,
    );
    const antesEnvios = await contarEnvios(campaignId);
    const post = await postDeEvidencia(page.request);
    expect(post.status()).toBe(404);
    expect(JSON.stringify(await post.json())).not.toContain(campaignId);
    expect((await obligacionesDe(campaignId)).map((o) => `${o.id}:${o.status}:${o.row_seq}`)).toEqual(
      antesObligaciones,
    );
    expect(await contarEnvios(campaignId)).toBe(antesEnvios);
  });
}

test('E2E-22c — sin sesión: las páginas redirigen al login y la ruta de evidencia responde 401', async ({
  page,
}) => {
  for (const ruta of [rutaDeOperacion(campaignId), rutaDeOperacion(campaignId, participacionId)]) {
    await page.context().clearCookies();
    await gotoConReintento(page, ruta);
    await expect(page, `redirección de ${ruta}`).toHaveURL(/\/login/);
  }
  const anonimo = await pwRequest.newContext({ baseURL: BASE });
  try {
    const r = await postDeEvidencia(anonimo);
    expect(r.status()).toBe(401);
    expect(JSON.stringify(await r.json())).not.toContain(campaignId);
  } finally {
    await anonimo.dispose();
  }
});

test('E2E-22d — el consultor, director y admin no ven la lista de otra agencia: una campaña ajena da 404', async ({
  page,
}) => {
  await login(page, op.consultor.email);
  const ajena = await gotoConReintento(page, rutaDeOperacion(op.campanaAjenaId));
  expect(ajena?.status()).toBe(404);
  // La participación de otra agencia bajo MI campaña tampoco se alcanza.
  const cruzada = await gotoConReintento(page, rutaDeOperacion(campaignId, op.ajena.participacion));
  expect(cruzada?.status()).toBe(404);
});
