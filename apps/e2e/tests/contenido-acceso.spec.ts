import { type Page, expect, request as pwRequest, test } from '@playwright/test';
import { crearComentarioDeRevision, query } from '@tcl-kol-os/db';
import {
  TEXTO_SEMBRADO,
  aprobarComoPersona,
  archivoDeGuion,
  contarVersiones,
  escenarioDeContenido,
  limpiarContenido,
  registrarGuionSembrado,
  revisarComoHumano,
  rutaDeContenido,
  subirGuionPorApi,
  textoDeGuion,
  type EscenarioE2E,
} from '../src/contenido';
import { login, loginPorCookie } from '../src/login';
import { gotoConReintento } from '../src/nav';

/**
 * E2E-19 — acceso al contenido por rol. Cuenta (admin, director, consultor) ve todo; el Operativo, solo el
 * estado de cada pieza y la versión aprobada vigente (sin hallazgos, comentarios, formularios, historial,
 * aprobación ni enlaces a fuentes de guion) y no alcanza el archivo de un guion no aprobado por la ruta de
 * fuentes; el cliente TCL y el usuario de otra agencia reciben 404 en TODO; sin sesión se redirige al login.
 */
test.describe.configure({ mode: 'serial' });
test.afterAll(async () => {
  await limpiarContenido();
});

const BASE = 'http://localhost:3015';
const COMENTARIO_INTERNO = 'Comentario interno de SmartPR que el Operativo no debe ver.';

let s: EscenarioE2E;
/** V1 de Valentina: en revisión, NO aprobada, con un comentario interno. */
let sinAprobar: { versionId: string; fuenteId: string };
/** V1 de Diego: aprobada vigente. */
let aprobada: { versionId: string; fuenteId: string };
let nombreDeFuenteSinAprobar = '';

test.beforeAll(async () => {
  s = await escenarioDeContenido('e2e-19-acceso');
  const { e } = s;
  sinAprobar = await registrarGuionSembrado(
    s,
    s.valentina.deliverableId,
    s.valentina.participacionId,
    TEXTO_SEMBRADO,
  );
  await revisarComoHumano(sinAprobar.versionId, e.consultor);
  const c = await crearComentarioDeRevision(
    e.consultor,
    sinAprobar.versionId,
    { kind: 'editorial', body: COMENTARIO_INTERNO },
    { origin: 'ui' },
    { campaignId: s.campaignId },
  );
  if (!c.ok) throw new Error(`no se creó el comentario: ${c.error.code}`);

  aprobada = await registrarGuionSembrado(s, s.diego.deliverableId, s.diego.participacionId, TEXTO_SEMBRADO);
  await revisarComoHumano(aprobada.versionId, e.consultor);
  const ok = await aprobarComoPersona(e.director, aprobada.versionId);
  if (!ok.ok) throw new Error(`no se aprobó la versión sembrada: ${ok.error.code}`);

  const nombre = async (id: string) =>
    (await query<{ filename: string }>(`SELECT filename FROM source_documents WHERE id = $1`, [id]))[0]!
      .filename;
  nombreDeFuenteSinAprobar = await nombre(sinAprobar.fuenteId);
});

const RUTAS = (): string[] => [
  rutaDeContenido(s.campaignId),
  rutaDeContenido(s.campaignId, s.valentina.participacionId),
  rutaDeContenido(s.campaignId, s.valentina.participacionId, s.valentina.deliverableId),
  rutaDeContenido(s.campaignId, s.diego.participacionId, s.diego.deliverableId),
];

async function entrarComoOperativo(page: Page): Promise<void> {
  await loginPorCookie(page, s.e.operativo.id);
}

test('E2E-19a — admin, director y consultor ven el contenido completo, con enlace y formularios', async ({
  page,
}) => {
  for (const email of [s.e.admin.email, s.e.director.email, s.e.consultor.email]) {
    await login(page, email);
    await gotoConReintento(page, `/campanas/${s.campaignId}`);
    const enlace = page.getByTestId('contenido-nav-link');
    await expect(enlace, `enlace visible para ${email}`).toBeVisible();
    await expect(enlace).toHaveAttribute('href', `/campanas/${s.campaignId}/contenido`);

    await gotoConReintento(page, rutaDeContenido(s.campaignId));
    await expect(page.getByTestId('contenido-page')).toBeVisible();
    await expect(page.getByTestId('contenido-crear-form').first()).toBeVisible();

    await gotoConReintento(
      page,
      rutaDeContenido(s.campaignId, s.valentina.participacionId, s.valentina.deliverableId),
    );
    await expect(page.getByTestId('contenido-hallazgos')).toBeVisible();
    await expect(page.getByTestId('contenido-comentarios')).toContainText(COMENTARIO_INTERNO);
    await expect(page.getByTestId('contenido-subir-form')).toBeVisible();
    await expect(page.getByTestId('contenido-historial')).toBeVisible();
    await expect(page.getByTestId('contenido-archivo-link')).toBeVisible();
  }
});

test('E2E-19b — el Operativo ve solo el estado y la aprobada vigente: sin hallazgos, comentarios, formularios, historial ni archivo', async ({
  page,
}) => {
  await entrarComoOperativo(page);

  // Lista: estado de cada pieza, sin formularios ni revisión.
  const lista = await gotoConReintento(page, rutaDeContenido(s.campaignId));
  expect(lista?.status()).toBe(200);
  await expect(page.getByTestId('contenido-page')).toBeVisible();
  await expect(page.getByTestId('contenido-crear-form')).toHaveCount(0);
  await expect(page.getByTestId('contenido-entregable-revision')).toHaveCount(0);
  await expect(page.getByTestId('contenido-sin-brief')).toHaveCount(0);
  await expect(page.getByTestId('contenido-brief-rector')).toHaveCount(0);

  // Pieza con guion SIN aprobar: estado, pero ni comentario, ni archivo, ni hallazgos.
  const sin = await gotoConReintento(
    page,
    rutaDeContenido(s.campaignId, s.valentina.participacionId, s.valentina.deliverableId),
  );
  expect(sin?.status()).toBe(200);
  await expect(page.getByTestId('contenido-estado-reducido')).toBeVisible();
  await expect(page.getByTestId('contenido-estado-ultima')).toContainText('V1');
  await expect(page.getByTestId('contenido-estado-ultima')).toContainText('En revisión');
  await expect(page.getByTestId('contenido-estado-vigente')).toHaveText('Ninguna todavía');
  for (const id of [
    'contenido-hallazgos',
    'contenido-comentarios',
    'contenido-historial',
    'contenido-subir-form',
    'contenido-acciones-comentario',
    'contenido-acciones-revision',
    'contenido-aprobacion-card',
    'contenido-aprobar',
    'contenido-archivo-link',
    'contenido-version-detalle',
    'contenido-chat-link',
  ]) {
    await expect(page.getByTestId(id), id).toHaveCount(0);
  }
  const cuerpoSin = await page.locator('body').innerText();
  expect(cuerpoSin).not.toContain(COMENTARIO_INTERNO);
  expect(cuerpoSin).not.toContain(nombreDeFuenteSinAprobar);
  await expect(page.locator(`a[href*="/fuentes/"]`)).toHaveCount(0);
  expect(await page.content()).not.toContain(sinAprobar.fuenteId);

  // Pieza con versión aprobada vigente: la ve (V1, fecha y nombre), sigue sin enlace de fuente ni historial.
  await gotoConReintento(page, rutaDeContenido(s.campaignId, s.diego.participacionId, s.diego.deliverableId));
  await expect(page.getByTestId('contenido-estado-vigente')).toContainText('V1');
  await expect(page.getByTestId('contenido-estado-ultima')).toContainText('Aprobada');
  await expect(page.getByTestId('contenido-historial')).toHaveCount(0);
  await expect(page.locator(`a[href*="/fuentes/"]`)).toHaveCount(0);
  expect(await page.content()).not.toContain(aprobada.fuenteId);

  // `?v=1` no abre el detalle de ninguna versión (sigue la vista de estado).
  await gotoConReintento(
    page,
    `${rutaDeContenido(s.campaignId, s.valentina.participacionId, s.valentina.deliverableId)}?v=1`,
  );
  await expect(page.getByTestId('contenido-version-detalle')).toHaveCount(0);
  await expect(page.getByTestId('contenido-comentarios')).toHaveCount(0);

  // Subir guiones por la API: negado y sin efecto.
  const antes = await contarVersiones(s.campaignId);
  const subida = await subirGuionPorApi(
    page.request,
    s.campaignId,
    s.valentina.participacionId,
    s.valentina.deliverableId,
    archivoDeGuion('intruso', textoDeGuion('limpio')),
  );
  expect(subida.status()).toBe(404);
  expect(await contarVersiones(s.campaignId)).toBe(antes);
});

test('E2E-19c — el Operativo no alcanza el archivo de un guion no aprobado por la ruta de fuentes', async ({
  page,
}) => {
  await entrarComoOperativo(page);

  // La lista de fuentes no menciona el guion sin aprobar.
  await gotoConReintento(page, `/campanas/${s.campaignId}/fuentes`);
  expect(await page.locator('body').innerText()).not.toContain(nombreDeFuenteSinAprobar);

  // La ruta directa del texto extraído de ese guion: 404 (inexistente para él).
  const r = await gotoConReintento(page, `/campanas/${s.campaignId}/fuentes/${sinAprobar.fuenteId}`);
  expect(r?.status()).toBe(404);
  expect(await page.locator('body').innerText()).not.toContain('Texto sintético');
  expect(await page.locator('body').innerText()).not.toContain(nombreDeFuenteSinAprobar);

  // Contraste: el consultor SÍ abre esa misma ruta.
  await login(page, s.e.consultor.email);
  const c = await gotoConReintento(page, `/campanas/${s.campaignId}/fuentes/${sinAprobar.fuenteId}`);
  expect(c?.status()).toBe(200);
  await expect(page.locator('h1')).toContainText(nombreDeFuenteSinAprobar);
});

for (const [etiqueta, email] of [
  ['cliente TCL', 'marena@tcl.com'],
  ['usuario de otra agencia', 'ajeno@otraagencia.co'],
] as const) {
  test(`E2E-19d — ${etiqueta}: 404 en todas las rutas de contenido, en el route handler y sin enlace`, async ({
    page,
  }) => {
    await login(page, email);
    for (const ruta of RUTAS()) {
      const r = await gotoConReintento(page, ruta);
      expect(r?.status(), `GET ${ruta}`).toBe(404);
      await expect(page.getByTestId('contenido-page')).toHaveCount(0);
      expect(await page.locator('body').innerText()).not.toContain(COMENTARIO_INTERNO);
    }
    // Con `?v=` también.
    const conVersion = await gotoConReintento(
      page,
      `${rutaDeContenido(s.campaignId, s.valentina.participacionId, s.valentina.deliverableId)}?v=1`,
    );
    expect(conVersion?.status()).toBe(404);

    // Sin enlace en la campaña.
    await gotoConReintento(page, `/campanas/${s.campaignId}`);
    await expect(page.getByTestId('contenido-nav-link')).toHaveCount(0);

    // Route handler: 404 y sin efecto; el cuerpo no revela nada.
    const antes = await contarVersiones(s.campaignId);
    const post = await subirGuionPorApi(
      page.request,
      s.campaignId,
      s.valentina.participacionId,
      s.valentina.deliverableId,
      archivoDeGuion('intruso', textoDeGuion('limpio')),
    );
    expect(post.status()).toBe(404);
    expect(JSON.stringify(await post.json())).not.toContain(s.campaignId);
    expect(await contarVersiones(s.campaignId)).toBe(antes);
  });
}

test('E2E-19e — una participación o entregable que no corresponde da 404 incluso al consultor', async ({
  page,
}) => {
  await login(page, s.e.consultor.email);
  // Entregable de Valentina bajo la participación de Diego, y un id inexistente.
  const cruzada = await gotoConReintento(
    page,
    rutaDeContenido(s.campaignId, s.diego.participacionId, s.valentina.deliverableId),
  );
  expect(cruzada?.status()).toBe(404);
  const inexistente = await gotoConReintento(
    page,
    rutaDeContenido(s.campaignId, s.valentina.participacionId, '00000000-0000-4000-8000-000000000000'),
  );
  expect(inexistente?.status()).toBe(404);
  // Campaña de otra agencia con ids de ESTA campaña.
  const otraCampana = await gotoConReintento(
    page,
    rutaDeContenido(s.e.campanaAjenaId, s.valentina.participacionId, s.valentina.deliverableId),
  );
  expect(otraCampana?.status()).toBe(404);
});

test('E2E-19f — sin sesión: las páginas redirigen al login y el route handler responde 401', async ({
  page,
}) => {
  for (const ruta of RUTAS()) {
    await page.context().clearCookies();
    await gotoConReintento(page, ruta);
    await expect(page, `redirección de ${ruta}`).toHaveURL(/\/login/);
  }
  const anonimo = await pwRequest.newContext({ baseURL: BASE });
  try {
    const antes = await contarVersiones(s.campaignId);
    const r = await subirGuionPorApi(
      anonimo,
      s.campaignId,
      s.valentina.participacionId,
      s.valentina.deliverableId,
      archivoDeGuion('anonimo', textoDeGuion('limpio')),
    );
    expect(r.status()).toBe(401);
    expect(await contarVersiones(s.campaignId)).toBe(antes);
  } finally {
    await anonimo.dispose();
  }
});
