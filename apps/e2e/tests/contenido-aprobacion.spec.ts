import { type Page, expect, test } from '@playwright/test';
import { aprobarScriptVersion } from '@tcl-kol-os/db';
import { crearBriefHijoDePrueba } from '@tcl-kol-os/db/test-utils';
import {
  TEXTO_SEMBRADO,
  aprobarComoPersona,
  archivoDeGuion,
  auditoriaDeEntidad,
  contarAuditoriaDeCampana,
  escenarioDeContenido,
  esperarFuenteProcesada,
  huellaDeAprobacion,
  limpiarContenido,
  registrarGuionSembrado,
  revisarComoHumano,
  revisionesDe,
  rutaDeContenido,
  estadoDeVersion,
  subirGuionPorFormulario,
  textoDeGuion,
  versionDe,
  versionesDe,
} from '../src/contenido';
import { login } from '../src/login';
import { gotoConReintento } from '../src/nav';

/**
 * E2E-18 — aprobación HUMANA de guiones por la interfaz. Aprobar es una decisión de dirección o
 * administración (`script:approve`), por el canal `ui` y con la huella de lo que se ve; la IA y el chat
 * nunca aprueban. Una revisión CURRENT contra el Brief aprobado vigente es el requisito (asistida o
 * humana); los hallazgos abiertos informan pero NO bloquean.
 */
test.describe.configure({ mode: 'serial' });
test.afterAll(async () => {
  await limpiarContenido();
});

const ID_DE_VERSION = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Acciones de servidor (Next) que la página dispara, para repetirlas «desde fuera» con otra sesión. */
function capturarAccionesDeServidor(page: Page): { id: string; cuerpo: string }[] {
  const capturadas: { id: string; cuerpo: string }[] = [];
  page.on('request', (r) => {
    const id = r.headers()['next-action'];
    if (r.method() === 'POST' && id !== undefined) capturadas.push({ id, cuerpo: r.postData() ?? '' });
  });
  return capturadas;
}

async function abrirEntregable(
  page: Page,
  campaignId: string,
  participacionId: string,
  deliverableId: string,
  version?: number,
): Promise<void> {
  const ruta = rutaDeContenido(campaignId, participacionId, deliverableId);
  await gotoConReintento(page, version === undefined ? ruta : `${ruta}?v=${version}`);
  await expect(page.getByTestId('contenido-deliverable-page')).toBeVisible();
}

test('E2E-18a — el director aprueba con el diálogo y la huella; el consultor no ve el botón y una llamada directa se niega', async ({
  page,
  browser,
}) => {
  test.setTimeout(240_000);
  const s = await escenarioDeContenido('e2e-18a-aprobacion');
  const { e, campaignId } = s;
  const { participacionId, deliverableId } = s.valentina;

  // Sembrado: V1 revisada (revisión humana CURRENT) y V2 lista como blanco de la llamada directa.
  const v1 = await registrarGuionSembrado(s, deliverableId, participacionId, TEXTO_SEMBRADO);
  await revisarComoHumano(v1.versionId, e.consultor);
  expect(await estadoDeVersion(v1.versionId)).toBe('in_review');

  // ── 1. El consultor ve la revisión pero NO el botón; el servidor también lo niega ──
  await login(page, e.consultor.email);
  await abrirEntregable(page, campaignId, participacionId, deliverableId);
  await expect(page.getByTestId('contenido-aprobacion-card')).toBeVisible();
  await expect(page.getByTestId('contenido-aprobar')).toHaveCount(0);
  await expect(page.getByTestId('contenido-aprobacion-sin-permiso')).toBeVisible();
  const huellaV1 = await huellaDeAprobacion(e.director, v1.versionId);
  const directa = await aprobarScriptVersion(e.consultor, v1.versionId, {
    huellaVista: huellaV1,
    origen: 'ui',
  });
  expect(directa.ok).toBe(false);
  expect(directa.ok ? undefined : directa.error.code).toBe('FORBIDDEN_ROLE');
  expect(await estadoDeVersion(v1.versionId)).toBe('in_review');
  expect((await versionDe(deliverableId, 1)).approved_at).toBeNull();

  // ── 2. El director abre el diálogo: ve QUÉ aprueba, el Brief y la huella; cancelar no hace nada ──
  const acciones = capturarAccionesDeServidor(page);
  await login(page, e.director.email);
  await abrirEntregable(page, campaignId, participacionId, deliverableId);
  await expect(page.getByTestId('contenido-aprobacion')).toHaveAttribute('data-elegible', 'true');
  await page.getByTestId('contenido-aprobar').click();
  const dialogo = page.getByTestId('contenido-aprobar-dialogo');
  await expect(dialogo).toBeVisible();
  await expect(dialogo.getByTestId('contenido-aprobar-dialogo-que')).toContainText('Reel principal');
  await expect(dialogo.getByTestId('contenido-aprobar-dialogo-que')).toContainText('Valentina Ríos');
  await expect(dialogo.getByTestId('contenido-aprobar-dialogo-que')).toContainText('V1');
  await expect(dialogo.getByTestId('contenido-aprobar-dialogo-brief')).toContainText(
    `Brief V${s.brief!.version}`,
  );
  await expect(dialogo.getByTestId('contenido-aprobar-dialogo-hallazgos')).toContainText('ninguno');
  const huellaMostrada = (await dialogo.getByTestId('contenido-aprobar-huella').textContent()) ?? '';
  expect(huellaMostrada).toMatch(/^[0-9a-f]{8}$/);
  expect(huellaV1.startsWith(huellaMostrada)).toBe(true);
  await dialogo.getByTestId('contenido-aprobar-cancelar').click();
  await expect(page.getByTestId('contenido-aprobar-dialogo')).toHaveCount(0);
  expect(await estadoDeVersion(v1.versionId)).toBe('in_review');

  // ── 3. Confirma (doble clic): una sola aprobación, a nombre del director, canal ui ──
  await page.getByTestId('contenido-aprobar').click();
  await page.getByTestId('contenido-aprobar-confirmar').dblclick();
  await expect.poll(() => estadoDeVersion(v1.versionId), { timeout: 30_000 }).toBe('approved');
  await expect(page.getByTestId('contenido-version-estado')).toHaveText('Aprobada', { timeout: 30_000 });
  await expect(page.getByTestId('contenido-badge-vigente')).toBeVisible();
  await expect(page.getByTestId('contenido-aprobar')).toHaveCount(0);

  const aprobada = await versionDe(deliverableId, 1);
  expect(aprobada.approved_by).toBe(e.director.id);
  expect(aprobada.approved_at).not.toBeNull();
  expect(aprobada.approved_via_proposed_action_id).toBeNull(); // aprobación directa, no por propuesta
  const auditoria = await auditoriaDeEntidad(v1.versionId);
  const aprobaciones = auditoria.filter((a) => a.action === 'script_version.approve');
  expect(aprobaciones).toHaveLength(1);
  expect(aprobaciones[0]).toMatchObject({ origin: 'ui', actor_id: e.director.id });

  // ── 4. Repetir la acción de servidor «desde fuera»: negada al consultor, inocua para el director ──
  const accion = acciones.filter((a) => a.cuerpo.includes(v1.versionId)).at(-1);
  expect(accion, 'la página disparó la acción de aprobación').toBeDefined();
  expect(JSON.parse(accion!.cuerpo)).toEqual([campaignId, v1.versionId, huellaV1]);

  const v2 = await registrarGuionSembrado(s, deliverableId, participacionId, TEXTO_SEMBRADO);
  await revisarComoHumano(v2.versionId, e.consultor);
  const huellaV2 = await huellaDeAprobacion(e.director, v2.versionId);
  const ruta = rutaDeContenido(campaignId, participacionId, deliverableId);
  const repetir = async (ctx: Page, versionId: string, huella: string): Promise<string> => {
    const r = await ctx.request.post(ruta, {
      headers: {
        'Next-Action': accion!.id,
        'Content-Type': 'text/plain;charset=UTF-8',
        Accept: 'text/x-component',
      },
      data: JSON.stringify([campaignId, versionId, huella]),
    });
    return r.text();
  };

  // Consultor: misma acción, otra versión que SÍ se podría aprobar ⇒ negada y sin efecto.
  const contextoConsultor = await browser.newContext({
    baseURL: test.info().project.use.baseURL ?? 'http://localhost:3015',
  });
  try {
    const paginaConsultor = await contextoConsultor.newPage();
    await login(paginaConsultor, e.consultor.email);
    const respuesta = await repetir(paginaConsultor, v2.versionId, huellaV2);
    expect(respuesta).toContain('FORBIDDEN_ROLE');
    expect(respuesta).not.toContain('"ok":true');
  } finally {
    await contextoConsultor.close();
  }
  expect(await estadoDeVersion(v2.versionId)).toBe('in_review');

  // Director: repetir la aprobación de la V1 (ya aprobada) no ejecuta otra vez.
  const repeticion = await repetir(page, v1.versionId, huellaV1);
  expect(repeticion).not.toContain('"ok":true');
  expect(await contarAuditoriaDeCampana(campaignId, 'script_version.approve')).toBe(1);
  expect((await versionDe(deliverableId, 1)).approved_at).toBe(aprobada.approved_at);

  // Origen distinto de `ui` ⇒ rechazo humano obligatorio (la IA, el chat y el sistema no aprueban).
  const porChat = await aprobarScriptVersion(e.director, v2.versionId, {
    huellaVista: huellaV2,
    origen: 'chat',
  });
  expect(porChat.ok ? undefined : porChat.error.code).toBe('HUMAN_CONFIRMATION_REQUIRED');
  expect(await estadoDeVersion(v2.versionId)).toBe('in_review');
  expect(await contarAuditoriaDeCampana(campaignId, 'script_version.approve')).toBe(1);
});

test('E2E-18b — un Brief nuevo deja la revisión STALE y bloquea aprobar hasta reanalizar o registrar la revisión humana', async ({
  page,
}) => {
  test.setTimeout(240_000);
  const s = await escenarioDeContenido('e2e-18b-stale');
  const { e, campaignId } = s;

  // Dos versiones revisadas contra el Brief V{n}: Valentina (se rehará a mano) y Diego (se reanalizará).
  const vVal = await registrarGuionSembrado(
    s,
    s.valentina.deliverableId,
    s.valentina.participacionId,
    TEXTO_SEMBRADO,
  );
  await revisarComoHumano(vVal.versionId, e.consultor);
  const vDie = await registrarGuionSembrado(
    s,
    s.diego.deliverableId,
    s.diego.participacionId,
    TEXTO_SEMBRADO,
  );
  await revisarComoHumano(vDie.versionId, e.consultor);

  await login(page, e.director.email);
  await abrirEntregable(page, campaignId, s.valentina.participacionId, s.valentina.deliverableId);
  await expect(page.getByTestId('contenido-aprobacion')).toHaveAttribute('data-elegible', 'true');
  await expect(page.getByTestId('contenido-aprobar')).toBeVisible();
  await expect(page.getByTestId('contenido-revision')).toHaveAttribute('data-vigencia', 'current');

  // ── 1. Se aprueba un Brief hijo: el rector pasa a ser la hija y las revisiones quedan STALE ──
  const hijo = await crearBriefHijoDePrueba(e.admin, s.brief!.versionId, {
    cambios: {
      'mensaje_principal.one_line': 'Mensaje principal actualizado: la cámara de 200 MP del P80 Pro.',
    },
  });
  expect(hijo.version).toBeGreaterThan(s.brief!.version);

  await abrirEntregable(page, campaignId, s.valentina.participacionId, s.valentina.deliverableId);
  await expect(page.getByTestId('contenido-revision')).toHaveAttribute('data-vigencia', 'stale');
  await expect(page.getByTestId('contenido-revision-stale')).toContainText(`Brief V${s.brief!.version}`);
  await expect(page.getByTestId('contenido-revision-brief-vigente')).toHaveText(`Brief V${hijo.version}`);
  await expect(page.getByTestId('contenido-aprobacion')).toHaveAttribute('data-elegible', 'false');
  await expect(page.getByTestId('contenido-aprobacion-bloqueos')).toContainText('Brief anterior');
  await expect(page.getByTestId('contenido-aprobar')).toHaveCount(0);

  // El servidor lo bloquea igual: SCRIPT_REVIEW_REQUIRED / stale (aunque la huella sea la de ahora).
  const bloqueada = await aprobarScriptVersion(e.director, vVal.versionId, {
    huellaVista: await huellaDeAprobacion(e.director, vVal.versionId),
    origen: 'ui',
  });
  expect(bloqueada.ok ? undefined : bloqueada.error.code).toBe('SCRIPT_REVIEW_REQUIRED');
  expect(
    bloqueada.ok ? undefined : (bloqueada.error.details as { reason?: string } | undefined)?.reason,
  ).toBe('stale');
  expect(await estadoDeVersion(vVal.versionId)).toBe('in_review');

  // ── 2. Revisión HUMANA (checkbox) del consultor contra el Brief vigente: vuelve a habilitar ──
  await login(page, e.consultor.email);
  await abrirEntregable(page, campaignId, s.valentina.participacionId, s.valentina.deliverableId);
  await page.getByTestId('contenido-revision-humana-abrir').click();
  await expect(page.getByTestId('contenido-revision-humana-confirmar')).toBeDisabled(); // sin marcar no se envía
  await page.getByTestId('contenido-revision-humana-checkbox').check();
  await page.getByTestId('contenido-revision-humana-nota').fill('Revisado contra el Brief actualizado.');
  await page.getByTestId('contenido-revision-humana-confirmar').click();
  await expect(page.getByTestId('contenido-revision')).toHaveAttribute('data-vigencia', 'current', {
    timeout: 30_000,
  });
  await expect(page.getByTestId('contenido-revision-tipo')).toHaveText('Revisión humana');
  await expect(page.getByTestId('contenido-revision-brief')).toHaveText(`Brief V${hijo.version}`);
  const humanas = (await revisionesDe(vVal.versionId)).filter((r) => r.kind === 'human');
  expect(humanas.map((r) => r.governing_brief_number)).toEqual([s.brief!.version, hijo.version]);
  expect(humanas.at(-1)!.created_by).toBe(e.consultor.id);

  await login(page, e.director.email);
  await abrirEntregable(page, campaignId, s.valentina.participacionId, s.valentina.deliverableId);
  await expect(page.getByTestId('contenido-aprobacion')).toHaveAttribute('data-elegible', 'true');
  await page.getByTestId('contenido-aprobar').click();
  await expect(page.getByTestId('contenido-aprobar-dialogo-brief')).toContainText(`Brief V${hijo.version}`);
  await page.getByTestId('contenido-aprobar-confirmar').click();
  await expect.poll(() => estadoDeVersion(vVal.versionId), { timeout: 30_000 }).toBe('approved');

  // ── 3. La otra versión: STALE → REANALIZAR contra el Brief vigente (IA falsa) → CURRENT → elegible ──
  await abrirEntregable(page, campaignId, s.diego.participacionId, s.diego.deliverableId);
  await expect(page.getByTestId('contenido-revision')).toHaveAttribute('data-vigencia', 'stale');
  await expect(page.getByTestId('contenido-aprobar')).toHaveCount(0);
  await login(page, e.consultor.email);
  await abrirEntregable(page, campaignId, s.diego.participacionId, s.diego.deliverableId);
  await page.getByTestId('contenido-solicitar-analisis').click();
  await expect(page.getByTestId('contenido-analisis-ok')).toBeVisible({ timeout: 90_000 });
  await expect(page.getByTestId('contenido-revision')).toHaveAttribute('data-vigencia', 'current', {
    timeout: 30_000,
  });
  await expect(page.getByTestId('contenido-revision-tipo')).toHaveText('Revisión asistida por IA');
  await expect(page.getByTestId('contenido-revision-brief')).toHaveText(`Brief V${hijo.version}`);
  await login(page, e.director.email);
  await abrirEntregable(page, campaignId, s.diego.participacionId, s.diego.deliverableId);
  await expect(page.getByTestId('contenido-aprobacion')).toHaveAttribute('data-elegible', 'true');
  await expect(page.getByTestId('contenido-aprobar')).toBeVisible();
  // El análisis NO aprobó nada: la versión sigue en revisión hasta que lo decida una persona.
  expect(await estadoDeVersion(vDie.versionId)).toBe('in_review');
});

test('E2E-18c — aprobar la V2 reemplaza a la V1 sin borrar su historia; los hallazgos abiertos no bloquean', async ({
  page,
}) => {
  test.setTimeout(300_000);
  const s = await escenarioDeContenido('e2e-18c-reemplazo');
  const { e, campaignId } = s;
  const { participacionId, deliverableId } = s.valentina;

  // V1 aprobada (sembrada por el caso de uso real, a nombre del director, canal ui).
  const v1 = await registrarGuionSembrado(s, deliverableId, participacionId, TEXTO_SEMBRADO);
  await revisarComoHumano(v1.versionId, e.consultor);
  const aprobadaV1 = await aprobarComoPersona(e.director, v1.versionId);
  expect(aprobadaV1.ok).toBe(true);
  const v1Antes = await versionDe(deliverableId, 1);
  expect(v1Antes.status).toBe('approved');

  // V2 por la interfaz con un análisis que deja UN hallazgo abierto (CTA ausente).
  await login(page, e.consultor.email);
  await abrirEntregable(page, campaignId, participacionId, deliverableId);
  await subirGuionPorFormulario(page, archivoDeGuion('guion-v2', textoDeGuion('cta_ausente')));
  const v2 = await versionDe(deliverableId, 2);
  await esperarFuenteProcesada(v2.source_document_id);
  await page.reload();
  await page.getByTestId('contenido-solicitar-analisis').click();
  await expect(page.getByTestId('contenido-analisis-ok')).toBeVisible({ timeout: 90_000 });
  await expect(page.getByTestId('contenido-hallazgos').getByTestId('contenido-hallazgo')).toHaveCount(1, {
    timeout: 30_000,
  });
  expect(await estadoDeVersion(v2.id)).toBe('in_review');

  // ── El director aprueba la V2 CON un hallazgo abierto: informa, pero no bloquea ──
  await login(page, e.director.email);
  await abrirEntregable(page, campaignId, participacionId, deliverableId, 2);
  await expect(page.getByTestId('contenido-aprobacion')).toHaveAttribute('data-elegible', 'true');
  await expect(page.getByTestId('contenido-aprobacion-advertencias')).toContainText('hallazgo');
  await page.getByTestId('contenido-aprobar').click();
  await expect(page.getByTestId('contenido-aprobar-dialogo-hallazgos')).toContainText('1 (');
  await expect(page.getByTestId('contenido-aprobar-dialogo-reemplaza')).toContainText('V1');
  await expect(page.getByTestId('contenido-aprobar-dialogo-advertencias')).toBeVisible();
  await page.getByTestId('contenido-aprobar-confirmar').click();
  await expect.poll(() => estadoDeVersion(v2.id), { timeout: 30_000 }).toBe('approved');

  // ── Base: la V2 es la ÚNICA aprobada; la V1 quedó reemplazada, con su historia congelada ──
  const versiones = await versionesDe(deliverableId);
  expect(versiones.map((v) => `${v.version}:${v.status}`)).toEqual(['1:superseded', '2:approved']);
  const v1Despues = versiones[0]!;
  expect(v1Despues.approved_at).toBe(v1Antes.approved_at);
  expect(v1Despues.approved_by).toBe(v1Antes.approved_by);
  expect(v1Despues.superseded_by_version_id).toBe(v2.id);
  expect(versiones[1]!.approved_by).toBe(e.director.id);
  expect(versiones[0]!.id).toMatch(ID_DE_VERSION);
  expect((await revisionesDe(v1.versionId)).map((r) => r.kind)).toEqual(['human']); // su revisión sigue
  const auditoriaV2 = await auditoriaDeEntidad(v2.id);
  expect(auditoriaV2.find((a) => a.action === 'script_version.approve')).toMatchObject({
    origin: 'ui',
    actor_id: e.director.id,
  });
  expect(await contarAuditoriaDeCampana(campaignId, 'script_version.approve')).toBe(2);

  // ── UI: V2 «Aprobada vigente»; V1 «Aprobada · reemplazada por V2» y su historia intacta ──
  await abrirEntregable(page, campaignId, participacionId, deliverableId, 2);
  await expect(page.getByTestId('contenido-version-estado')).toHaveText('Aprobada');
  const historial = page.getByTestId('contenido-historial');
  const filaV2 = historial.locator('[data-testid="contenido-version"][data-version="2"]');
  const filaV1 = historial.locator('[data-testid="contenido-version"][data-version="1"]');
  await expect(filaV2).toHaveAttribute('data-es-aprobada-vigente', 'true');
  await expect(filaV2.getByTestId('contenido-badge-vigente')).toHaveText('Aprobada vigente');
  await expect(filaV1).toHaveAttribute('data-es-aprobada-vigente', 'false');
  await expect(filaV1.getByTestId('contenido-badge-reemplazada')).toHaveText('Aprobada · reemplazada por V2');
  await expect(historial.getByTestId('contenido-badge-vigente')).toHaveCount(1);
  await filaV1.click();
  await expect(page).toHaveURL(/\?v=1$/);
  await expect(page.getByTestId('contenido-version-estado')).toHaveText('Reemplazada');
  await expect(page.getByTestId('contenido-revision-tipo')).toHaveText('Revisión humana');
  await expect(page.getByTestId('contenido-aprobar')).toHaveCount(0);

  // No se aprueba hacia atrás: la V1 ya no es aprobable.
  const haciaAtras = await aprobarScriptVersion(e.director, v1.versionId, {
    huellaVista: aprobadaV1.ok ? aprobadaV1.value.fingerprint : '',
    origen: 'ui',
  });
  expect(haciaAtras.ok).toBe(false);
  expect((await versionDe(deliverableId, 2)).status).toBe('approved');
});
