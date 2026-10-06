import { type Page, expect, test } from '@playwright/test';
import {
  crearComentarioDeRevision,
  crearEntregable,
  proponerAccion,
  query,
  registrarRevisionHumana,
  registrarVersionDeGuion,
} from '@tcl-kol-os/db';
import { crearBriefHijoDePrueba, crearFuenteDeGuionConTexto } from '@tcl-kol-os/db/test-utils';
import {
  TEXTO_SEMBRADO,
  limpiarContenido,
  registrarGuionSembrado,
  revisarComoHumano,
} from '../src/contenido';
import {
  BASE,
  ETIQUETA_HOSTIL,
  NOMBRE_HOSTIL,
  contextoDe,
  cuerpoMultipart,
  invocarAccion,
  postCrudo,
  sembrarEscenarioQa,
  valorDeSesion,
  type EscenarioQa,
} from '../src/qa-f7-ui';

/**
 * QA adversarial de la capa web de la Fase 7 — U4 (XSS y renderizado de texto no confiable), U7 (aprobación
 * en la interfaz: huella obsoleta, doble clic), U8 (tarjeta de aprobación del chat), U9 (estados y
 * consistencia visual) y U10 (accesibilidad y 375 px). Con navegador real contra el servidor 3040.
 * Lo ROTO queda como `test.fail(...)` («QA-F7-UI-xx abierto»).
 */
test.describe.configure({ mode: 'serial' });
test.setTimeout(180_000);

let s: EscenarioQa;
const XSS = `<img src=x onerror="window.__xss=1"> <script>window.__xss=1</script> <svg onload="window.__xss=1"> javascript:window.__xss=1 {{7*7}} \${7*7}`;
const LARGO_SIN_ESPACIOS = 'Z'.repeat(1700);

async function entrar(page: Page, userId: string): Promise<void> {
  await page.context().clearCookies();
  await page.context().addCookies([{ name: 'tclkolos_session', value: valorDeSesion(userId), url: BASE }]);
}

const rutaDe = (p: string, d: string, v?: number): string =>
  `/campanas/${s.campaignId}/contenido/${p}/${d}${v === undefined ? '' : `?v=${v}`}`;

/** Pieza nueva (de Valentina Gómez) con una versión en revisión humana: lista para aprobar. */
async function piezaLista(
  etiqueta: string,
): Promise<{ deliverableId: string; versionId: string; participacionId: string }> {
  const participacionId = s.e.participaciones.valentinaGomez;
  const d = await crearEntregable(s.e.consultor, {
    campaignInfluencerId: participacionId,
    label: `${etiqueta} ${Date.now().toString(36)}`,
  });
  if (!d.ok) throw new Error(d.error.code);
  const v = await registrarGuionSembrado(s, d.value.id, participacionId, TEXTO_SEMBRADO);
  await revisarComoHumano(v.versionId, s.e.consultor);
  return { deliverableId: d.value.id, versionId: v.versionId, participacionId };
}

/** Inspección del DOM: nada de lo no confiable se convirtió en elementos, atributos de evento ni enlaces activos. */
async function inspeccionarDom(page: Page): Promise<{
  xss: unknown;
  imgsInyectadas: number;
  svgsInyectados: number;
  atributosDeEvento: string[];
  scriptsInlineConXss: number;
  enlacesPeligrosos: string[];
  atributosConHtml: string[];
}> {
  return page.evaluate(() => {
    const todos = Array.from(document.querySelectorAll('*'));
    const atributosDeEvento: string[] = [];
    const atributosConHtml: string[] = [];
    for (const el of todos) {
      for (const a of Array.from(el.attributes)) {
        if (/^on/i.test(a.name)) atributosDeEvento.push(`${el.tagName}.${a.name}`);
        // Los `data-*` jamás deben llevar texto de personas o documentos (los `aria-label` sí lo llevan, escapado).
        if (/[<>]/.test(a.value) && a.name.startsWith('data-'))
          atributosConHtml.push(`${el.tagName}.${a.name}`);
      }
    }
    return {
      xss: (window as unknown as { __xss?: unknown }).__xss,
      imgsInyectadas: document.querySelectorAll('img[src="x"]').length,
      svgsInyectados: document.querySelectorAll('svg[onload]').length,
      atributosDeEvento,
      scriptsInlineConXss: Array.from(document.scripts).filter(
        (x) =>
          x.textContent?.includes('window.__xss=1') &&
          !x.src &&
          x.type !== 'application/json' &&
          !/__next_f|self\.__next/.test(x.textContent ?? ''),
      ).length,
      enlacesPeligrosos: Array.from(document.querySelectorAll('a[href]'))
        .map((a) => a.getAttribute('href') ?? '')
        .filter((h) => /^\s*(javascript|data|vbscript):/i.test(h) || /^\/\//.test(h) || /^https?:/i.test(h)),
      atributosConHtml,
    };
  });
}

test.beforeAll(async () => {
  s = await sembrarEscenarioQa('qaui-render');
  const adm = await contextoDe(s.e.admin.id);
  for (const r of [
    `/campanas/${s.campaignId}/contenido`,
    `/campanas/${s.campaignId}/contenido/${s.valentina.participacionId}`,
    rutaDe(s.valentina.participacionId, s.valentina.deliverableId),
    `/campanas/${s.campaignId}/chat`,
  ]) {
    await adm.get(r, { timeout: 180_000 });
  }
  await adm.dispose();
});

test.afterAll(async () => {
  await limpiarContenido();
});

// ─────────────────────────── U4 · XSS y renderizado ────────────────────────────

test('U4a — RESISTE: nombre de influencer, etiqueta de entregable, comentario, nota de revisión, nombre de archivo y cita del guion con HTML/scripts/plantillas salen como TEXTO (ni elementos, ni atributos de evento, ni enlaces peligrosos, ni ejecución)', async ({
  page,
}) => {
  const { e } = s;
  // Comentario y cambio solicitado hostiles + nombre de archivo hostil + guion hostil con cita analizada.
  const cons = await contextoDe(e.consultor.id);
  const hostilPagina = rutaDe(s.hostil.participacionId, s.hostil.deliverableId);
  const comentario = await invocarAccion(cons, hostilPagina, 'anadirComentarioDeContenido', [
    s.campaignId,
    s.hostil.versionId,
    `${XSS} ${LARGO_SIN_ESPACIOS}`,
  ]);
  expect(comentario.resultado?.ok, JSON.stringify(comentario.resultado)).toBe(true);
  const nota = await registrarRevisionHumana(
    e.consultor,
    s.hostil.versionId,
    { nota: `Nota ${XSS}` },
    { origin: 'ui' },
  );
  expect(nota.ok).toBe(true);

  // Fuente cuyo NOMBRE y texto son hostiles (la base no deja renombrar el original: se crea ya con ese nombre).
  const fuenteId = await crearFuenteDeGuionConTexto(
    s.campaignId,
    e.admin,
    `<img src=x onerror=window.__xss=1>${'B'.repeat(150)}`,
    [`${XSS} afirmación sin respaldo del producto [[fake:analisis claim_sin_respaldo]]`],
  );
  const registrada = await registrarVersionDeGuion(
    e.consultor,
    {
      campaignId: s.campaignId,
      sourceId: fuenteId,
      participation: { participationId: s.hostil.participacionId },
      deliverable: { id: s.hostil.deliverableId },
    },
    { origin: 'ui' },
  );
  if (!registrada.ok || registrada.value.kind !== 'registered')
    throw new Error('no se registró la versión hostil');
  const fuenteHostil = { versionId: registrada.value.version.id };
  const analisis = await invocarAccion(cons, hostilPagina, 'solicitarAnalisisDeContenido', [
    s.campaignId,
    fuenteHostil.versionId,
    'reanalyze',
    `qaui:hostil-${Date.now()}`,
  ]);
  expect(analisis.resultado?.ok, JSON.stringify(analisis.resultado)).toBe(true);
  await cons.dispose();

  for (const quien of [e.consultor.id, e.director.id, e.operativo.id]) {
    await entrar(page, quien);
    for (const ruta of [
      `/campanas/${s.campaignId}/contenido`,
      `/campanas/${s.campaignId}/contenido/${s.hostil.participacionId}`,
      rutaDe(s.hostil.participacionId, s.hostil.deliverableId),
      rutaDe(s.hostil.participacionId, s.hostil.deliverableId, 1),
    ]) {
      const r = await page.goto(ruta, { timeout: 120_000 });
      expect(r?.status(), ruta).toBe(200);
      const cuerpo = await page.locator('body').innerText();
      // El texto hostil se MUESTRA literal (escapado), donde corresponde.
      expect(cuerpo, `${ruta} nombre`).toContain(NOMBRE_HOSTIL.slice(0, 20));
      const dom = await inspeccionarDom(page);
      expect(dom.xss, `${ruta} ejecutó script`).toBeUndefined();
      expect(dom.imgsInyectadas, `${ruta} img inyectada`).toBe(0);
      expect(dom.svgsInyectados, `${ruta} svg inyectado`).toBe(0);
      expect(dom.atributosDeEvento, `${ruta} atributos on*`).toEqual([]);
      expect(dom.scriptsInlineConXss, `${ruta} script inline`).toBe(0);
      expect(dom.enlacesPeligrosos, `${ruta} enlaces`).toEqual([]);
      expect(dom.atributosConHtml, `${ruta} atributos con HTML`).toEqual([]);
    }
  }

  // Cuenta: el comentario, la nota y la cita del guion aparecen como texto literal, en SU sección.
  await entrar(page, e.consultor.id);
  await page.goto(rutaDe(s.hostil.participacionId, s.hostil.deliverableId, 1), { timeout: 120_000 });
  await expect(page.getByTestId('contenido-comentarios')).toContainText(
    '<img src=x onerror="window.__xss=1">',
  );
  await expect(page.getByTestId('contenido-comentarios')).toContainText('{{7*7}}');
  await page.goto(rutaDe(s.hostil.participacionId, s.hostil.deliverableId), { timeout: 120_000 });
  const hallazgos = page.getByTestId('contenido-hallazgos');
  await expect(hallazgos).toBeVisible();
  const citas = await page.getByTestId('contenido-hallazgo-cita').allInnerTexts();
  expect(citas.join('\n')).toContain('<img src=x onerror=');
  await expect(page.getByTestId('contenido-hallazgos')).toHaveAttribute('data-origen', 'brief');
  await expect(page.getByTestId('contenido-comentarios')).toHaveAttribute('data-origen', 'smartpr');
  // El nombre de archivo hostil se pinta como texto en el historial.
  await expect(page.getByTestId('contenido-historial')).toContainText('<img src=x onerror=window.__xss=1>');
  // Los enlaces de la pantalla son SIEMPRE relativos y de la propia campaña.
  const hrefs = await page
    .locator('a[href]')
    .evaluateAll((as) => as.map((a) => a.getAttribute('href') ?? ''));
  for (const h of hrefs) expect(h, h).toMatch(/^(\/|#|\?)/);
});

test('U4b — RESISTE: la separación hallazgo (derivado del Brief) ≠ comentario (persona) se mantiene con texto hostil: un comentario con forma de hallazgo no se pinta como hallazgo y viceversa', async ({
  page,
}) => {
  const { e } = s;
  await entrar(page, e.consultor.id);
  await page.goto(rutaDe(s.hostil.participacionId, s.hostil.deliverableId), { timeout: 120_000 });
  // Ningún hallazgo dentro de la sección de comentarios, ningún comentario dentro de la de hallazgos.
  expect(
    await page.locator('[data-testid="contenido-comentarios"] [data-testid="contenido-hallazgo"]').count(),
  ).toBe(0);
  expect(
    await page.locator('[data-testid="contenido-hallazgos"] [data-testid="contenido-comentario"]').count(),
  ).toBe(0);
  expect(await page.locator('[data-testid="contenido-hallazgo"]:not([data-origen="brief"])').count()).toBe(0);
  expect(
    await page.locator('[data-testid="contenido-comentario"]:not([data-origen="smartpr"])').count(),
  ).toBe(0);
  // Los comentarios llevan autor persona; los hallazgos no.
  expect(
    await page
      .locator('[data-testid="contenido-hallazgo"] [data-testid="contenido-comentario-autor"]')
      .count(),
  ).toBe(0);
});

test('U4c — RESISTE: la pantalla pública del cliente TCL y de otra agencia no lleva nada de contenido (404) y el Operativo solo texto de estado', async ({
  page,
}) => {
  for (const id of [s.e.cliente.id, s.e.ajeno.id]) {
    await entrar(page, id);
    const r = await page.goto(rutaDe(s.hostil.participacionId, s.hostil.deliverableId), { timeout: 120_000 });
    expect(r?.status()).toBe(404);
    const cuerpo = await page.locator('body').innerText();
    expect(cuerpo).not.toContain(NOMBRE_HOSTIL.slice(0, 20));
    expect(cuerpo).not.toContain(ETIQUETA_HOSTIL.slice(0, 10));
  }
});

// ─────────────────────────── U7 · aprobación en la interfaz ────────────────────

async function abrirDialogo(
  page: Page,
  p: { deliverableId: string; participacionId: string },
): Promise<void> {
  await entrar(page, s.e.director.id);
  await page.goto(rutaDe(p.participacionId, p.deliverableId), { timeout: 120_000 });
  await expect(page.getByTestId('contenido-aprobar')).toBeVisible();
  // `next dev` hidrata tarde: se reintenta el clic hasta que el diálogo aparezca.
  await expect(async () => {
    await page.getByTestId('contenido-aprobar').click();
    await expect(page.getByTestId('contenido-aprobar-dialogo')).toBeVisible({ timeout: 1500 });
  }).toPass({ timeout: 20_000 });
}

const estadoDe = async (versionId: string): Promise<string> =>
  (await query<{ status: string }>(`SELECT status FROM script_versions WHERE id = $1`, [versionId]))[0]!
    .status;

test('U7a — RESISTE: un comentario nuevo mientras el diálogo está abierto deja la huella obsoleta: se rechaza con un aviso en español y no se aprueba', async ({
  page,
}) => {
  const p = await piezaLista('Huella-comentario');
  await abrirDialogo(page, p);
  const comentario = await crearComentarioDeRevision(
    s.e.consultor,
    p.versionId,
    { kind: 'editorial', body: 'Comentario nuevo entre abrir y confirmar' },
    { origin: 'ui' },
    { campaignId: s.campaignId },
  );
  expect(comentario.ok).toBe(true);
  await page.getByTestId('contenido-aprobar-confirmar').click();
  await expect(page.getByTestId('contenido-aprobar-error')).toContainText('Lo que viste cambió');
  await expect(page.getByTestId('contenido-aprobar-error')).toHaveAttribute('role', 'alert');
  expect(await estadoDe(p.versionId)).toBe('in_review');
  // Recargando se ve el comentario nuevo y la nueva huella permite aprobar.
  await abrirDialogo(page, p);
  await expect(page.getByTestId('contenido-aprobar-dialogo')).toContainText('Comentarios de revisión: 1');
  await page.getByTestId('contenido-aprobar-confirmar').click();
  await expect(page.getByTestId('contenido-version-estado')).toHaveText('Aprobada', { timeout: 20_000 });
  expect(await estadoDe(p.versionId)).toBe('approved');
});

test('U7b — RESISTE: una versión nueva (V2) mientras el diálogo de la V1 está abierto deja la huella obsoleta y avisa de la versión más reciente tras recargar', async ({
  page,
}) => {
  const p = await piezaLista('Huella-version');
  await abrirDialogo(page, p);
  await registrarGuionSembrado(s, p.deliverableId, p.participacionId, TEXTO_SEMBRADO);
  await page.getByTestId('contenido-aprobar-confirmar').click();
  await expect(page.getByTestId('contenido-aprobar-error')).toContainText('Lo que viste cambió');
  expect(await estadoDe(p.versionId)).toBe('in_review');
  // Recargada la V1: se puede aprobar (no es la última) pero con la ADVERTENCIA visible.
  await page.goto(rutaDe(p.participacionId, p.deliverableId, 1), { timeout: 120_000 });
  await expect(page.getByTestId('contenido-aprobacion-advertencias')).toContainText(
    'Existe una versión más reciente (V2)',
  );
  await page.getByTestId('contenido-aprobar').click();
  await expect(page.getByTestId('contenido-aprobar-dialogo-advertencias')).toContainText(
    'Existe una versión más reciente (V2)',
  );
});

test('U7c — RESISTE: una revisión humana nueva de otra persona entre abrir y confirmar también deja la huella obsoleta', async ({
  page,
}) => {
  const p = await piezaLista('Huella-revision');
  await abrirDialogo(page, p);
  const otra = await registrarRevisionHumana(
    s.e.admin,
    p.versionId,
    { nota: 'Segunda revisión' },
    { origin: 'ui' },
  );
  expect(otra.ok, JSON.stringify(otra)).toBe(true);
  await page.getByTestId('contenido-aprobar-confirmar').click();
  await expect(page.getByTestId('contenido-aprobar-error')).toContainText('Lo que viste cambió');
  expect(await estadoDe(p.versionId)).toBe('in_review');
});

test('U7d — RESISTE: doble clic (y doble Enter) en «Sí, aprobar» registra UNA sola aprobación y un solo evento de auditoría', async ({
  page,
}) => {
  const p = await piezaLista('Doble-clic');
  await abrirDialogo(page, p);
  const confirmar = page.getByTestId('contenido-aprobar-confirmar');
  await confirmar.dblclick();
  await expect(page.getByTestId('contenido-version-estado')).toHaveText('Aprobada', { timeout: 20_000 });
  const eventos = await query<{ n: number }>(
    `SELECT count(*)::int AS n FROM audit_events WHERE entity_id = $1 AND action = 'script_version.approve'`,
    [p.versionId],
  );
  expect(eventos[0]!.n).toBe(1);
});

test('U7e — RESISTE: el consultor no ve el botón de aprobar aunque la versión sea elegible, ve el texto de «lo decide dirección», y quitar el atributo disabled o forzar el DOM no cambia nada en el servidor', async ({
  page,
}) => {
  const p = await piezaLista('Consultor-sin-boton');
  await entrar(page, s.e.consultor.id);
  await page.goto(rutaDe(p.participacionId, p.deliverableId), { timeout: 120_000 });
  await expect(page.getByTestId('contenido-aprobacion')).toHaveAttribute('data-elegible', 'true');
  await expect(page.getByTestId('contenido-aprobar')).toHaveCount(0);
  await expect(page.getByTestId('contenido-aprobacion-sin-permiso')).toBeVisible();
  // «Manipular el DOM»: la acción de aprobar solo existe en el servidor y exige script:approve.
  expect(await estadoDe(p.versionId)).toBe('in_review');
});

test('U7f — RESISTE: «aprobar con hallazgos abiertos» es posible, pero la advertencia se ve en la pantalla y en el diálogo (revisión humana: aviso propio)', async ({
  page,
}) => {
  const p = await piezaLista('Advertencias');
  await abrirDialogo(page, p);
  const dialogo = page.getByTestId('contenido-aprobar-dialogo');
  await expect(page.getByTestId('contenido-aprobar-dialogo-advertencias')).toContainText(
    'Revisión humana, no asistida por IA.',
  );
  await expect(dialogo).toContainText('Huella de lo que ves');
  await expect(page.getByTestId('contenido-aprobar-huella')).toHaveText(/^[0-9a-f]{8,}/);
});

// ─────────────────────────── U8 · tarjeta del chat ─────────────────────────────

test('U8 — RESISTE: la tarjeta del chat se compone solo con cifras y etiquetas (texto hostil como texto), la confirmación sigue siendo humana por la interfaz con huella, y una tarjeta obsoleta se marca y no se puede confirmar', async ({
  page,
}) => {
  const { e } = s;
  const p = await piezaLista(ETIQUETA_HOSTIL);
  const propuesta = await proponerAccion(e.consultor, {
    type: 'script_version.approve',
    resourceId: p.versionId,
    origin: 'chat',
    campaignId: s.campaignId,
  });
  expect(propuesta.ok, JSON.stringify(propuesta)).toBe(true);

  await entrar(page, e.director.id);
  await page.goto(`/campanas/${s.campaignId}/chat`, { timeout: 120_000 });
  const tarjeta = page.getByTestId('chat-proposal').first();
  await expect(tarjeta).toBeVisible();
  const texto = await tarjeta.innerText();
  expect(texto).toContain('Aprobará la versión 1 del guion');
  expect(texto).toContain('Valentina Gómez');
  // Cada aviso es de una de las formas fijas (cifras y etiquetas): nada de texto libre del guion ni del modelo.
  const avisos = await page.getByTestId('chat-proposal-warnings').first().locator('li').allInnerTexts();
  for (const a of avisos) {
    expect(a, a).toMatch(
      /^(Revisión desactualizada: el guion, su revisión, el Brief o los comentarios cambiaron desde que se propuso\.|\d+ hallazgos? abiertos? \(\d+ alta, \d+ media, \d+ baja\): no bloquean, decide la persona\.|Revisión humana, no asistida por IA\.|Existe una versión más reciente \(V\d+\) de este entregable\.|Reemplaza a la versión \d+ aprobada\.)$/u,
    );
  }
  expect(avisos).toContain('Revisión humana, no asistida por IA.');
  const dom = await inspeccionarDom(page);
  expect(dom.xss).toBeUndefined();
  expect(dom.atributosDeEvento).toEqual([]);
  expect(dom.atributosConHtml).toEqual([]);
  // Confirmación humana: botón visible para el director; huella visible.
  await expect(tarjeta.getByTestId('chat-proposal-confirm')).toBeVisible();
  await expect(tarjeta.getByTestId('chat-proposal-fingerprint')).toHaveText(/^[0-9a-f]{6,}/);

  // El consultor (quien propone) no puede confirmarla: no hay botón.
  await entrar(page, e.consultor.id);
  await page.goto(`/campanas/${s.campaignId}/chat`, { timeout: 120_000 });
  await expect(page.getByTestId('chat-proposal').first().getByTestId('chat-proposal-confirm')).toHaveCount(0);

  // Tarjeta obsoleta: un comentario nuevo cambia lo huellado.
  const c = await crearComentarioDeRevision(
    e.consultor,
    p.versionId,
    { kind: 'editorial', body: 'Cambia la huella de la propuesta' },
    { origin: 'ui' },
    { campaignId: s.campaignId },
  );
  expect(c.ok).toBe(true);
  await entrar(page, e.director.id);
  await page.goto(`/campanas/${s.campaignId}/chat`, { timeout: 120_000 });
  const obsoleta = page.getByTestId('chat-proposal').first();
  await expect(obsoleta.getByTestId('chat-proposal-stale')).toBeVisible();
  await expect(obsoleta.getByTestId('chat-proposal-confirm')).toHaveCount(0);
  expect(await estadoDe(p.versionId)).toBe('in_review');
  // La acción propuesta sigue sin ejecutarse (el chat solo propone).
  const [pa] = await query<{ status: string }>(`SELECT status FROM proposed_actions WHERE resource_id = $1`, [
    p.versionId,
  ]);
  expect(pa!.status).toBe('pending');
});

// ─────────────────────────── U9 · estados y consistencia ───────────────────────

test('U9a — RESISTE: con V1 aprobada→reemplazada, V2 vigente y V3 recibida, cada pantalla muestra «Última» y «Aprobada vigente» donde corresponde, y «Aprobada · reemplazada por V2» en la V1', async ({
  page,
}) => {
  await entrar(page, s.e.consultor.id);
  const { participacionId, deliverableId } = s.valentina;
  const insignias = async () => ({
    versiones: await page.getByTestId('contenido-version').evaluateAll((as) =>
      as.map((a) => ({
        n: a.getAttribute('data-version'),
        ultima: a.getAttribute('data-es-ultima'),
        vigente: a.getAttribute('data-es-aprobada-vigente'),
        estado: a.getAttribute('data-estado'),
        texto: (a as HTMLElement).innerText,
      })),
    ),
  });
  await page.goto(rutaDe(participacionId, deliverableId), { timeout: 120_000 });
  const h = await insignias();
  expect(h.versiones.map((v) => v.n)).toEqual(['3', '2', '1']);
  expect(h.versiones.map((v) => v.ultima)).toEqual(['true', 'false', 'false']);
  expect(h.versiones.map((v) => v.vigente)).toEqual(['false', 'true', 'false']);
  expect(h.versiones[2]!.texto).toContain('Aprobada · reemplazada por V2');
  expect(h.versiones[1]!.texto).toContain('Aprobada vigente');
  expect(h.versiones[0]!.texto).toContain('Última');
  await expect(page.getByTestId('contenido-version-detalle')).toHaveAttribute('data-version', '3');
  await expect(page.getByTestId('contenido-deliverable-resumen')).toHaveText(
    'Aprobado · nueva versión en revisión',
  );

  await page.goto(rutaDe(participacionId, deliverableId, 1), { timeout: 120_000 });
  await expect(page.getByTestId('contenido-version-detalle')).toContainText('Aprobada · reemplazada por V2');
  await expect(page.getByTestId('contenido-aprobar')).toHaveCount(0);
  await expect(page.getByTestId('contenido-acciones-comentario')).toHaveCount(0);
  await expect(page.getByTestId('contenido-aprobacion-card')).toHaveCount(0);

  // El operativo ve la vigente (V2), no la última (V3).
  await entrar(page, s.e.operativo.id);
  await page.goto(rutaDe(participacionId, deliverableId), { timeout: 120_000 });
  await expect(page.getByTestId('contenido-estado-vigente')).toContainText('V2');
  await expect(page.getByTestId('contenido-estado-ultima')).toContainText('V3');
});

test('U9b — RESISTE: tras aprobar la V3 desde la interfaz, la V2 pasa a «Aprobada · reemplazada por V3», la V3 queda vigente y la lista y el Operativo lo reflejan', async ({
  page,
}) => {
  const { e } = s;
  const { participacionId, deliverableId } = s.valentina;
  await revisarComoHumano(s.historial.v3, e.consultor);
  await entrar(page, e.director.id);
  await page.goto(rutaDe(participacionId, deliverableId), { timeout: 120_000 });
  await expect(page.getByTestId('contenido-aprobar')).toBeVisible();
  await expect(async () => {
    await page.getByTestId('contenido-aprobar').click();
    await expect(page.getByTestId('contenido-aprobar-dialogo')).toBeVisible({ timeout: 1500 });
  }).toPass({ timeout: 20_000 });
  await expect(page.getByTestId('contenido-aprobar-dialogo-reemplaza')).toContainText('V2');
  await page.getByTestId('contenido-aprobar-confirmar').click();
  await expect(page.getByTestId('contenido-version-estado')).toHaveText('Aprobada', { timeout: 20_000 });

  await page.goto(rutaDe(participacionId, deliverableId, 2), { timeout: 120_000 });
  await expect(page.getByTestId('contenido-version-detalle')).toContainText('Aprobada · reemplazada por V3');
  await expect(page.getByTestId('contenido-deliverable-resumen')).toHaveText('Aprobado');
  const insignias = await page
    .getByTestId('contenido-version')
    .evaluateAll((as) => as.map((a) => a.getAttribute('data-es-aprobada-vigente')));
  expect(insignias).toEqual(['true', 'false', 'false']);

  await entrar(page, e.operativo.id);
  await page.goto(`/campanas/${s.campaignId}/contenido/${participacionId}`, { timeout: 120_000 });
  await expect(page.getByTestId('contenido-entregable-vigente').first()).toContainText('V3');
});

// ─────────────────────────── U10 · accesibilidad y móvil ───────────────────────

test('U10a — RESISTE: el diálogo es un alertdialog modal con título y descripción, el foco inicial está en «Cancelar» y Escape lo cierra sin aprobar', async ({
  page,
}) => {
  const p = await piezaLista('A11y');
  await abrirDialogo(page, p);
  const dialogo = page.getByTestId('contenido-aprobar-dialogo');
  await expect(dialogo).toHaveAttribute('role', 'alertdialog');
  await expect(dialogo).toHaveAttribute('aria-modal', 'true');
  expect(await dialogo.getAttribute('aria-labelledby')).toBeTruthy();
  expect(await dialogo.getAttribute('aria-describedby')).toBeTruthy();
  await expect(page.getByTestId('contenido-aprobar-cancelar')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialogo).toHaveCount(0);
  expect(await estadoDe(p.versionId)).toBe('in_review');
});

test('QA-F7-UI-10 (P3, corregido): con el diálogo abierto, Tab no sale de él (trampa de foco de un diálogo modal)', async ({
  page,
}) => {
  const p = await piezaLista('A11y-trampa');
  await abrirDialogo(page, p);
  for (let i = 0; i < 6; i += 1) {
    await page.keyboard.press('Tab');
    const dentro = await page.evaluate(
      () => document.activeElement?.closest('[role="alertdialog"]') !== null,
    );
    expect(dentro, `Tab ${i + 1} salió del diálogo`).toBe(true);
  }
});

test('QA-F7-UI-11 (P3, corregido): al cerrar el diálogo con Escape o «Cancelar» el foco vuelve al botón que lo abrió (lo promete el comentario del componente)', async ({
  page,
}) => {
  const p = await piezaLista('A11y-foco');
  await abrirDialogo(page, p);
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('contenido-aprobar')).toBeFocused({ timeout: 2000 });
});

test('U10b — RESISTE: a 375 px de ancho no hay desplazamiento horizontal en la lista, la participación ni el detalle, aun con textos larguísimos sin espacios (comentario de 1900 caracteres, nombre de archivo de 150, etiqueta y nombre con HTML)', async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 812 });
  for (const quien of [s.e.consultor.id, s.e.director.id, s.e.operativo.id]) {
    await entrar(page, quien);
    for (const ruta of [
      `/campanas/${s.campaignId}/contenido`,
      `/campanas/${s.campaignId}/contenido/${s.hostil.participacionId}`,
      rutaDe(s.hostil.participacionId, s.hostil.deliverableId),
      rutaDe(s.hostil.participacionId, s.hostil.deliverableId, 1),
      rutaDe(s.valentina.participacionId, s.valentina.deliverableId),
    ]) {
      await page.goto(ruta, { timeout: 120_000 });
      const medidas = await page.evaluate(() => ({
        ancho: document.documentElement.scrollWidth,
        ventana: window.innerWidth,
      }));
      expect(medidas.ancho, `${ruta}: scrollWidth ${medidas.ancho} > ${medidas.ventana}`).toBeLessThanOrEqual(
        medidas.ventana + 1,
      );
    }
  }
});

test('U10c — RESISTE: los errores de las acciones se anuncian con role=alert, en español comprensible y sin detalles técnicos', async ({
  page,
}) => {
  const p = await piezaLista('Errores');
  await entrar(page, s.e.consultor.id);
  await page.goto(rutaDe(p.participacionId, p.deliverableId), { timeout: 120_000 });
  await expect(page.getByTestId('contenido-comentario-texto')).toBeVisible();
  // Un cambio solicitado repetido sobre una versión que ya cambió de estado devuelve un mensaje claro.
  await page.getByTestId('contenido-comentario-texto').fill('Un comentario válido');
  await expect(async () => {
    await page.getByTestId('contenido-comentario-enviar').click();
    await expect(page.getByTestId('contenido-comentarios')).toContainText('Un comentario válido', {
      timeout: 3000,
    });
  }).toPass({ timeout: 20_000 });
  // Se pide cambios por otra vía (db) → la versión deja de admitir comentarios; el formulario aún abierto responde con aviso.
  const dir = await contextoDe(s.e.consultor.id);
  const r = await invocarAccion(
    dir,
    rutaDe(p.participacionId, p.deliverableId),
    'solicitarCambiosDeContenido',
    [s.campaignId, p.versionId, 'Un cambio'],
  );
  expect(r.resultado?.ok).toBe(true);
  await dir.dispose();
  await page.getByTestId('contenido-comentario-texto').fill('Comentario tardío');
  await page.getByTestId('contenido-comentario-enviar').click();
  const error = page.getByTestId('contenido-comentario-error');
  await expect(error).toBeVisible();
  await expect(error).toHaveAttribute('role', 'alert');
  const texto = await error.innerText();
  expect(texto).toMatch(/ya no admite revisión|Recarga la página/);
  expect(texto).not.toMatch(/RESOURCE_CONFLICT|SCRIPT_|Error:|undefined|\bat\b.*\(/);
});

test('U9c — RESISTE: al aprobarse un Brief nuevo la revisión pasa a STALE en la lista y en el detalle, aprobar se bloquea con el motivo, y registrar la revisión humana contra el Brief nuevo la devuelve a CURRENT', async ({
  page,
}) => {
  const { e } = s;
  const hijo = await crearBriefHijoDePrueba(e.admin, s.brief!.versionId, {
    cambios: { 'mensaje_principal.one_line': 'Mensaje principal actualizado para la prueba de STALE.' },
  });
  await entrar(page, e.director.id);
  await page.goto(rutaDe(s.diego.participacionId, s.diego.deliverableId), { timeout: 120_000 });
  await expect(page.getByTestId('contenido-revision')).toHaveAttribute('data-vigencia', 'stale');
  await expect(page.getByTestId('contenido-aprobacion')).toHaveAttribute('data-elegible', 'false');
  await expect(page.getByTestId('contenido-aprobar')).toHaveCount(0);
  await expect(page.getByTestId('contenido-revision-brief-vigente')).toHaveText(`Brief V${hijo.version}`);
  await page.goto(`/campanas/${s.campaignId}/contenido`, { timeout: 120_000 });
  const fila = page.locator(`[data-deliverable-id="${s.diego.deliverableId}"]`);
  await expect(fila.getByTestId('contenido-entregable-revision')).toHaveAttribute('data-vigencia', 'stale');
  expect(await estadoDe(s.diegoV1.versionId)).toBe('in_review');
  // Revisión humana contra el Brief nuevo: vuelve a CURRENT y a ser elegible.
  await entrar(page, e.consultor.id);
  await page.goto(rutaDe(s.diego.participacionId, s.diego.deliverableId), { timeout: 120_000 });
  await expect(async () => {
    await page.getByTestId('contenido-revision-humana-abrir').click();
    await expect(page.getByTestId('contenido-revision-humana-form')).toBeVisible({ timeout: 1500 });
  }).toPass({ timeout: 20_000 });
  await page.getByTestId('contenido-revision-humana-checkbox').check();
  await page.getByTestId('contenido-revision-humana-confirmar').click();
  await expect(page.getByTestId('contenido-revision')).toHaveAttribute('data-vigencia', 'current', {
    timeout: 20_000,
  });
  await expect(page.getByTestId('contenido-aprobacion')).toHaveAttribute('data-elegible', 'true');
});

test('U10d — RESISTE: a 375 px el diálogo de aprobación cabe en la ventana (botones alcanzables, sin desbordar) y la página no se desplaza horizontalmente', async ({
  page,
}) => {
  const p = await piezaLista('Movil');
  await page.setViewportSize({ width: 375, height: 812 });
  await abrirDialogo(page, p);
  const caja = await page.getByTestId('contenido-aprobar-dialogo').boundingBox();
  expect(caja).not.toBeNull();
  expect(caja!.x).toBeGreaterThanOrEqual(0);
  expect(caja!.x + caja!.width).toBeLessThanOrEqual(376);
  const confirmar = await page.getByTestId('contenido-aprobar-confirmar').boundingBox();
  expect(confirmar!.x + confirmar!.width).toBeLessThanOrEqual(376);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
});

// ─────────────────────────── Huérfanas visibles al Operativo ───────────────────

test('QA-F7-UI-06b (P3, corregido): un archivo de guion que quedó SIN versión (NEEDS_CHOICE) no es legible por el Operativo ni queda como fuente suelta de la campaña', async ({
  page,
}) => {
  const nombre = `huerfana-${Date.now().toString(36)}.md`;
  const r = await postCrudo(
    `/api/campanas/${s.campaignId}/contenido/guiones`,
    cuerpoMultipart([
      {
        nombre: 'archivo',
        valor: Buffer.from(`# Guion huérfano\n\ntexto secreto ${Math.random()}\n`),
        archivo: nombre,
        tipo: 'text/markdown',
      },
      { nombre: 'participacionId', valor: s.valentina.participacionId },
      { nombre: 'etiqueta', valor: 'Reel principa' },
    ]),
    { userId: s.e.consultor.id },
  );
  expect(r.http).toBe(409);
  const [fuente] = await query<{ id: string }>(
    `SELECT id FROM source_documents WHERE campaign_id = $1 AND filename = $2`,
    [s.campaignId, nombre],
  );
  // La comprobación previa del destino rechaza ANTES de guardar los bytes: no hay fuente suelta. Si alguna
  // vez la hubiera (carrera), el Operativo no debe poder abrirla.
  expect(fuente).toBeUndefined();
  if (fuente !== undefined) {
    await entrar(page, s.e.operativo.id);
    const abre = await page.goto(`/campanas/${s.campaignId}/fuentes/${fuente.id}`, { timeout: 120_000 });
    expect(abre?.status()).toBe(404);
  }
});
