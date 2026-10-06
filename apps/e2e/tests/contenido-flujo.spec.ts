import { expect, test } from '@playwright/test';
import {
  archivoDeGuion,
  contarComentarios,
  contarHallazgos,
  contarVersiones,
  escenarioDeContenido,
  esperarFuenteProcesada,
  limpiarContenido,
  revisionesDe,
  rutaDeContenido,
  subirGuionPorFormulario,
  textoDeGuion,
  versionDe,
  versionesDe,
} from '../src/contenido';
import { login } from '../src/login';
import { gotoConReintento } from '../src/nav';
import { query } from '@tcl-kol-os/db';

/**
 * E2E-17 — flujo de contenido de punta a punta, como el consultor: crear un entregable, subir el guion por
 * el route handler real, ver la fuente procesada, solicitar el análisis (IA falsa del worker real; el MODO va
 * en el texto del guion), ver los HALLAZGOS DEL BRIEF (CURRENT, «Analizado contra Brief V{n}») separados de
 * los COMENTARIOS DE SMARTPR, solicitar cambios (V1 «Cambios solicitados») y subir la V2: el historial
 * conserva la V1 con todo lo suyo y la última es la V2.
 */
test.describe.configure({ mode: 'serial' });
test.afterAll(async () => {
  await limpiarContenido();
});

test('E2E-17 — crear entregable, subir guion, analizar, comentar, pedir cambios y subir la V2', async ({
  page,
}) => {
  test.setTimeout(240_000);
  const s = await escenarioDeContenido('e2e-17-flujo');
  const { campaignId, e } = s;
  const participacionId = s.valentina.participacionId;
  await login(page, e.consultor.email);

  // ── 1. Crear un entregable nuevo desde la página de la participación ──
  await gotoConReintento(page, rutaDeContenido(campaignId, participacionId));
  await expect(page.getByTestId('contenido-participacion-page')).toBeVisible();
  await page.getByTestId('contenido-crear-etiqueta').fill('Story de cuenta regresiva');
  await page.getByTestId('contenido-crear-submit').click();
  await expect(page.getByTestId('contenido-crear-ok')).toBeVisible({ timeout: 30_000 });
  const [creado] = await query<{ id: string; label: string }>(
    `SELECT id, label FROM deliverables WHERE campaign_influencer_id = $1 AND label = $2`,
    [participacionId, 'Story de cuenta regresiva'],
  );
  expect(creado).toBeDefined();
  const deliverableId = creado!.id;
  expect(await versionesDe(deliverableId)).toHaveLength(0);

  await gotoConReintento(page, rutaDeContenido(campaignId, participacionId));
  await page
    .locator(`[data-testid="contenido-entregable"][data-deliverable-id="${deliverableId}"]`)
    .getByTestId('contenido-entregable-enlace')
    .click();
  await expect(page.getByTestId('contenido-deliverable-nombre')).toHaveText('Story de cuenta regresiva');
  await expect(page.getByTestId('contenido-sin-versiones')).toBeVisible();
  await expect(page.getByTestId('contenido-historial-vacio')).toBeVisible();

  // ── 2. Subir el guion V1 por el formulario (route handler real) ──
  const v1 = archivoDeGuion('guion-v1', textoDeGuion('claim_sin_respaldo'));
  await subirGuionPorFormulario(page, v1);
  const version1 = await versionDe(deliverableId, 1);
  expect(version1.status).toBe('received');
  await expect(page.getByTestId('contenido-version-detalle')).toHaveAttribute('data-version', '1');
  await expect(page.getByTestId('contenido-archivo-link')).toContainText(v1.name);
  await expect(page.getByTestId('contenido-archivo-link')).toHaveAttribute(
    'href',
    `/campanas/${campaignId}/fuentes/${version1.source_document_id}`,
  );

  // La fuente aún no está procesada: estado explícito y análisis deshabilitado, sin intentar nada.
  await expect(page.getByTestId('contenido-archivo-estado')).not.toHaveAttribute('data-estado', 'listo');
  await expect(page.getByTestId('contenido-solicitar-analisis')).toBeDisabled();
  await expect(page.getByTestId('contenido-analisis-motivo')).toBeVisible();
  expect(await revisionesDe(version1.id)).toHaveLength(0);

  // ── 3. El consumidor real de la cola procesa el Markdown: la fuente queda procesada ──
  await esperarFuenteProcesada(version1.source_document_id);
  await page.reload();
  await expect(page.getByTestId('contenido-archivo-estado')).toHaveAttribute('data-estado', 'listo');
  await expect(page.getByTestId('contenido-archivo-procesando')).toHaveCount(0);
  await expect(page.getByTestId('contenido-solicitar-analisis')).toBeEnabled();
  // Sin análisis todavía: la sección de hallazgos lo dice y no hay ninguno.
  await expect(page.getByTestId('contenido-hallazgos-vacio')).toBeVisible();
  await expect(page.getByTestId('contenido-hallazgo')).toHaveCount(0);

  // ── 4. Solicitar el análisis: hallazgos del Brief, CURRENT, «Analizado contra Brief V{n}» ──
  await page.getByTestId('contenido-solicitar-analisis').click();
  await expect(page.getByTestId('contenido-analisis-ok')).toBeVisible({ timeout: 90_000 });
  await page.reload();
  const hallazgos = page.getByTestId('contenido-hallazgos');
  await expect(hallazgos).toHaveAttribute('data-origen', 'brief');
  await expect(hallazgos.getByTestId('contenido-hallazgo')).toHaveCount(1);
  await expect(hallazgos.getByTestId('contenido-hallazgo')).toHaveAttribute('data-origen', 'brief');
  await expect(hallazgos.getByTestId('contenido-hallazgo')).toHaveAttribute(
    'data-categoria',
    'claim_unsupported',
  );
  await expect(hallazgos.getByTestId('contenido-hallazgos-vigencia')).toHaveText('CURRENT');
  await expect(hallazgos.getByTestId('contenido-hallazgos-brief')).toHaveText(
    `Analizado contra Brief V${s.brief!.version}`,
  );
  await expect(page.getByTestId('contenido-revision')).toHaveAttribute('data-vigencia', 'current');
  await expect(page.getByTestId('contenido-version-estado')).toHaveText('En revisión');
  const descripcion = (await hallazgos.getByTestId('contenido-hallazgo-descripcion').textContent()) ?? '';
  expect(descripcion.length).toBeGreaterThan(10);

  // Base: una revisión asistida CURRENT con un hallazgo; la versión pasó a `in_review` y NO se aprobó nada.
  const [revision] = await revisionesDe(version1.id);
  expect(revision).toMatchObject({
    kind: 'ai_assisted',
    status: 'succeeded',
    finding_count: 1,
    governing_brief_number: s.brief!.version,
  });
  expect(await contarHallazgos(version1.id)).toBe(1);
  expect((await versionDe(deliverableId, 1)).status).toBe('in_review');
  expect((await versionDe(deliverableId, 1)).approved_at).toBeNull();

  // ── 5. Un COMENTARIO de SmartPR aparece SOLO en su sección; los hallazgos, solo en la suya ──
  const comentario = 'Reforzar el gancho de los primeros tres segundos del reel.';
  await page.getByTestId('contenido-comentario-texto').fill(comentario);
  await page.getByTestId('contenido-comentario-enviar').click();
  const comentarios = page.getByTestId('contenido-comentarios');
  await expect(comentarios.getByTestId('contenido-comentario')).toHaveCount(1, { timeout: 30_000 });
  await expect(comentarios).toHaveAttribute('data-origen', 'smartpr');
  await expect(comentarios.getByTestId('contenido-comentario')).toHaveAttribute('data-origen', 'smartpr');
  await expect(
    comentarios.getByTestId('contenido-comentario').getByTestId('contenido-comentario-texto-pintado'),
  ).toHaveText(comentario);
  await expect(comentarios.getByTestId('contenido-comentario-autor')).toHaveText(e.consultor.name);
  await expect(comentarios.getByTestId('contenido-comentario-canal')).toHaveText('Desde la interfaz');
  // Separación: el comentario no está en la sección del Brief ni el hallazgo en la de SmartPR.
  await expect(hallazgos).not.toContainText(comentario);
  await expect(comentarios).not.toContainText(descripcion);
  await expect(hallazgos.locator('[data-origen="smartpr"]')).toHaveCount(0);
  await expect(comentarios.locator('[data-origen="brief"]')).toHaveCount(0);
  await expect(page.getByTestId('contenido-hallazgo')).toHaveCount(1);
  expect(await contarComentarios(version1.id, 'editorial')).toBe(1);
  expect(await contarHallazgos(version1.id)).toBe(1);

  // ── 6. Solicitar cambios (con diálogo): la V1 queda «Cambios solicitados» (estado terminal) ──
  await page
    .getByTestId('contenido-cambios-texto')
    .fill('Añadir la mención del hashtag oficial\nCerrar con la invitación a la tienda');
  await page.getByTestId('contenido-cambios-enviar').click();
  await expect(page.getByTestId('contenido-cambios-dialogo')).toBeVisible();
  await page.getByTestId('contenido-cambios-confirmar').click();
  await expect(page.getByTestId('contenido-version-estado')).toHaveText('Cambios solicitados', {
    timeout: 30_000,
  });
  await expect(page.getByTestId('contenido-cambio-solicitado')).toHaveCount(2);
  await expect(page.getByTestId('contenido-cambios-solicitados')).toBeVisible();
  // La versión cerrada ya no ofrece comentar ni pedir más cambios.
  await expect(page.getByTestId('contenido-acciones-comentario')).toHaveCount(0);
  expect((await versionDe(deliverableId, 1)).status).toBe('changes_requested');
  expect(await contarComentarios(version1.id, 'change_request')).toBe(2);
  expect((await versionDe(deliverableId, 1)).approved_at).toBeNull();

  // ── 7. Subir la V2: el historial conserva la V1 con sus comentarios; «Última» = V2 ──
  const v2 = archivoDeGuion('guion-v2', textoDeGuion('limpio'));
  await subirGuionPorFormulario(page, v2);
  await expect(page).toHaveURL(/\?v=2$/);
  expect(await contarVersiones(campaignId)).toBe(2);
  const versiones = await versionesDe(deliverableId);
  expect(versiones.map((v) => `${v.version}:${v.status}`)).toEqual(['1:changes_requested', '2:received']);
  // Se conservaron la fuente y el estado de la V1 (nunca se sobrescribe).
  expect(versiones[0]!.source_document_id).toBe(version1.source_document_id);

  const historial = page.getByTestId('contenido-historial');
  await expect(historial.getByTestId('contenido-version')).toHaveCount(2);
  const filaV2 = historial.locator('[data-testid="contenido-version"][data-version="2"]');
  const filaV1 = historial.locator('[data-testid="contenido-version"][data-version="1"]');
  await expect(filaV2).toHaveAttribute('data-es-ultima', 'true');
  await expect(filaV1).toHaveAttribute('data-es-ultima', 'false');
  await expect(filaV1).toHaveAttribute('data-estado', 'changes_requested');
  await expect(filaV2.getByTestId('contenido-badge-ultima')).toHaveText('Última');
  await expect(historial.getByTestId('contenido-badge-vigente')).toHaveCount(0); // nada aprobado

  // La V2 es una versión nueva: sin hallazgos ni comentarios de la V1.
  await expect(page.getByTestId('contenido-version-detalle')).toHaveAttribute('data-version', '2');
  await expect(page.getByTestId('contenido-hallazgo')).toHaveCount(0);
  await expect(page.getByTestId('contenido-comentario')).toHaveCount(0);
  await expect(page.getByTestId('contenido-cambio-solicitado')).toHaveCount(0);

  // La página SIN `?v=` abre la última (V2).
  await gotoConReintento(page, rutaDeContenido(campaignId, participacionId, deliverableId));
  await expect(page.getByTestId('contenido-version-detalle')).toHaveAttribute('data-version', '2');

  // La V1 sigue intacta con todo lo suyo.
  await filaV1.click();
  await expect(page).toHaveURL(/\?v=1$/);
  await expect(page.getByTestId('contenido-version-estado')).toHaveText('Cambios solicitados');
  await expect(page.getByTestId('contenido-hallazgos').getByTestId('contenido-hallazgo')).toHaveCount(1);
  await expect(page.getByTestId('contenido-comentarios').getByTestId('contenido-comentario')).toHaveCount(1);
  await expect(
    page.getByTestId('contenido-comentario').getByTestId('contenido-comentario-texto-pintado'),
  ).toHaveText(comentario);
  await expect(page.getByTestId('contenido-cambio-solicitado')).toHaveCount(2);

  // ── 8. El MISMO archivo otra vez no crea una versión nueva ──
  await filaV2.click();
  await expect(page.getByTestId('contenido-version-detalle')).toHaveAttribute('data-version', '2');
  await page.getByTestId('contenido-subir-archivo').setInputFiles({ ...v2, name: 'mismo-contenido.md' });
  await page.getByTestId('contenido-subir-submit').click();
  await expect(page.getByTestId('contenido-subir-aviso')).toContainText(
    'ya estaba registrado como la versión V2',
  );
  expect(await contarVersiones(campaignId)).toBe(2);
});
