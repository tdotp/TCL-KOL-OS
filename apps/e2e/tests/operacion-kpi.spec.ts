import { type Page, expect, test } from '@playwright/test';
import type { EscenarioDeOperacion } from '@tcl-kol-os/db/test-utils';
import {
  dia,
  entrarComoOperativo,
  escenarioDeOperacion,
  limpiarOperacion,
  medicionesDe,
  rutaDeOperacion,
} from '../src/operacion';
import { login } from '../src/login';
import { gotoConReintento } from '../src/nav';

/**
 * E2E-25 — KPIs. El consultor fija el objetivo (Views 50.000); el operativo registra la medición (61.420) ⇒
 * «Cumplido» con su cumplimiento. El operativo no ve «Registrar objetivo» y el consultor no ve «Registrar medición».
 * Una corrección conserva la historia. Las métricas con unidades distintas (conteo vs. %) van en filas propias y
 * nunca se suman.
 */
test.describe.configure({ mode: 'serial' });
test.afterAll(async () => {
  await limpiarOperacion();
});

let op: EscenarioDeOperacion;
let campaignId = '';
let participacionId = '';

test.beforeAll(async () => {
  op = await escenarioDeOperacion('e2e-25-kpi');
  campaignId = op.campanaId;
  participacionId = op.participaciones.valentinaRios;
});

async function abrirDetalle(page: Page): Promise<void> {
  await gotoConReintento(page, rutaDeOperacion(campaignId, participacionId));
  await expect(page.getByTestId('operacion-detalle-page')).toBeVisible();
  await expect(page.getByTestId('seccion-kpi')).toBeVisible();
}

const fila = (page: Page, metrica: string) =>
  page.locator(`[data-testid="kpi-fila"][data-metrica="${metrica}"]`);

/** Compara ignorando el separador de miles de la configuración regional (`.`, espacio o espacio fino). */
const numeroComo = (digitos: string, decimales?: string): RegExp =>
  new RegExp(
    `^${digitos.replace(/(\d)(?=(\d{3})+$)/g, '$1[.\\s\\u00a0\\u202f]?')}${decimales === undefined ? '' : `,${decimales}`}$`,
  );

test('E2E-25a — roles: el consultor fija objetivos pero no mide; el operativo mide pero no fija objetivos', async ({
  page,
}) => {
  await login(page, op.consultor.email);
  await abrirDetalle(page);
  await expect(page.getByTestId('form-registrar-objetivo')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Registrar objetivo' })).toBeVisible();
  await expect(page.getByTestId('form-registrar-medicion')).toHaveCount(0);
  await expect(page.getByTestId('form-corregir-medicion')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Registrar medición' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Corregir medición' })).toHaveCount(0);

  await entrarComoOperativo(page, op);
  await abrirDetalle(page);
  await expect(page.getByTestId('form-registrar-medicion')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Registrar medición' })).toBeVisible();
  await expect(page.getByTestId('form-registrar-objetivo')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Registrar objetivo' })).toHaveCount(0);
});

test('E2E-25b — objetivo 50.000 (consultor) y medición 61.420 (operativo) ⇒ «Cumplido» con su cumplimiento', async ({
  page,
}) => {
  await login(page, op.consultor.email);
  await abrirDetalle(page);
  await expect(page.getByTestId('kpi-sin-objetivos')).toBeVisible();
  const objetivo = page.getByTestId('form-registrar-objetivo');
  await objetivo.locator('select[name="metric"]').selectOption('views');
  await objetivo.getByLabel('Valor objetivo').fill('50000');
  await objetivo.getByRole('button', { name: 'Registrar objetivo' }).click();
  await expect(fila(page, 'views')).toHaveCount(1);
  await expect(fila(page, 'views').getByTestId('kpi-objetivo')).toHaveText(numeroComo('50000'));
  await expect(fila(page, 'views').getByTestId('kpi-real')).toHaveText('Sin datos');
  await expect(fila(page, 'views').getByTestId('kpi-estado')).toHaveAttribute('data-valor', 'sin_medicion');
  await expect(page.getByTestId('kpi-resumen')).toHaveAttribute('data-valor', 'sin_mediciones');

  await entrarComoOperativo(page, op);
  await abrirDetalle(page);
  const medicion = page.getByTestId('form-registrar-medicion');
  await medicion.locator('select[name="metric"]').selectOption('views');
  await medicion.getByLabel('Valor medido').fill('61420');
  await medicion.getByLabel('Fecha de la observación').fill(dia(1));
  await medicion.getByRole('button', { name: 'Registrar medición' }).click();

  const views = fila(page, 'views');
  await expect(views.getByTestId('kpi-real')).toHaveText(numeroComo('61420'));
  await expect(views.getByTestId('kpi-estado')).toHaveAttribute('data-valor', 'cumplido');
  await expect(views.getByTestId('kpi-estado')).toHaveText('Cumplido');
  // 61.420 / 50.000 = 122,84 %
  await expect(views.getByTestId('kpi-cumplimiento')).toHaveText(/^122,84\s%$/);
  await expect(page.getByTestId('kpi-resumen')).toHaveAttribute('data-valor', 'completo');
  expect((await medicionesDe(campaignId)).map((m) => `${m.metric}:${Number(m.value)}`)).toEqual([
    'views:61420',
  ]);
});

test('E2E-25c — métricas con unidades distintas van en filas propias y nunca se suman', async ({ page }) => {
  await login(page, op.consultor.email);
  await abrirDetalle(page);
  const objetivo = page.getByTestId('form-registrar-objetivo');
  await objetivo.locator('select[name="metric"]').selectOption('engagement_rate');
  await objetivo.getByLabel('Valor objetivo').fill('5');
  await objetivo.getByRole('button', { name: 'Registrar objetivo' }).click();
  await expect(page.getByTestId('kpi-fila')).toHaveCount(2);

  await entrarComoOperativo(page, op);
  await abrirDetalle(page);
  const medicion = page.getByTestId('form-registrar-medicion');
  await medicion.locator('select[name="metric"]').selectOption('engagement_rate');
  await medicion.getByLabel('Valor medido').fill('4.2');
  await medicion.getByLabel('Fecha de la observación').fill(dia(1));
  await medicion.getByRole('button', { name: 'Registrar medición' }).click();

  const tasa = fila(page, 'engagement_rate');
  await expect(tasa.getByTestId('kpi-real')).toHaveText('4,2');
  await expect(tasa.getByTestId('kpi-objetivo')).toHaveText('5');
  await expect(tasa.getByTestId('kpi-estado')).toHaveAttribute('data-valor', 'por_debajo');
  await expect(tasa.getByTestId('kpi-cumplimiento')).toHaveText(/^84\s%$/);
  // La fila de Views no cambió y no existe ninguna fila ni total con la suma de ambas.
  await expect(fila(page, 'views').getByTestId('kpi-real')).toHaveText(numeroComo('61420'));
  await expect(page.getByTestId('kpi-fila')).toHaveCount(2);
  const texto = (await page.getByTestId('seccion-kpi').innerText()).replace(/\s/g, '');
  expect(texto).not.toMatch(/61[.,]?424[,.]?2/); // 61.420 + 4,2
  expect(texto).not.toMatch(/55[.,]?000/); // 50.000 + 5
  // La métrica de tasa lleva su unidad (%), la de conteo la suya.
  await expect(tasa).toContainText('%');
  await expect(fila(page, 'views')).toContainText('conteo');
});

test('E2E-25d — una corrección conserva la historia: la medición original sigue en la base y la corrección se ve con su motivo', async ({
  page,
}) => {
  await entrarComoOperativo(page, op);
  await abrirDetalle(page);
  const corregir = page.getByTestId('form-corregir-medicion');
  const selector = corregir.locator('select[name="measurementId"]');
  const valor = await selector.locator('option', { hasText: 'Vistas' }).first().getAttribute('value');
  await selector.selectOption(valor!);
  await corregir.getByLabel('Valor correcto').fill('60000');
  await corregir
    .getByLabel('Motivo de la corrección')
    .fill('El primer conteo incluía una vista duplicada (E2E-25).');
  await corregir.getByRole('button', { name: 'Corregir medición' }).click();

  // La vigente es la corrección y sigue «Cumplido» (60.000 ≥ 50.000): cumplimiento 120 %.
  const views = fila(page, 'views');
  await expect(views.getByTestId('kpi-real')).toHaveText(numeroComo('60000'));
  await expect(views.getByTestId('kpi-estado')).toHaveAttribute('data-valor', 'cumplido');
  await expect(views.getByTestId('kpi-cumplimiento')).toHaveText(/^120\s%$/);

  // La historia: la medición original NO se borró ni se editó; la corrección la reemplaza y apunta a ella.
  const filas = (await medicionesDe(campaignId)).filter((m) => m.metric === 'views');
  expect(filas.map((m) => Number(m.value))).toEqual([61420, 60000]);
  expect(filas[0]!.supersedes_id).toBeNull();
  expect(filas[1]!.supersedes_id).toBe(filas[0]!.id);
  expect(filas[1]!.correction_reason).toContain('vista duplicada');

  // La interfaz muestra el historial de correcciones con su motivo y quién la hizo.
  await expect(page.getByTestId('kpi-correcciones')).toBeVisible();
  await expect(page.getByTestId('kpi-correccion')).toHaveCount(1);
  await expect(page.getByTestId('kpi-correccion')).toContainText('Vistas: corregida a');
  await expect(page.getByTestId('kpi-correccion')).toContainText(
    'Motivo: El primer conteo incluía una vista duplicada',
  );
});

test('E2E-25e — la interfaz marca la medición como corregida (valor, motivo y autor) y la original sigue en la base', async ({
  page,
}) => {
  await entrarComoOperativo(page, op);
  await abrirDetalle(page);
  const correccion = page.getByTestId('kpi-correccion');
  await expect(correccion).toHaveCount(1);
  await expect(correccion).toContainText('Vistas: corregida a');
  await expect(correccion).toContainText('Motivo: El primer conteo incluía una vista duplicada');
  await expect(correccion).toContainText('Usuario Operativo');
  // La UI muestra el valor ORIGINAL (61.420) como «valor anterior» y la historia se conserva en
  // `kpi_measurements` (original intacta y corrección que la reemplaza), verificado aquí.
  await expect(correccion).toContainText('valor anterior: 61.420');
  const filas = (await medicionesDe(campaignId)).filter((m) => m.metric === 'views');
  expect(filas).toHaveLength(2);
  expect(Number(filas[0]!.value)).toBe(61420);
  expect(filas[1]!.supersedes_id).toBe(filas[0]!.id);
});
