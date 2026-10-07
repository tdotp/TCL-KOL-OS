import { expect, test } from '@playwright/test';
import { crearAcuerdoDePrueba, type EscenarioDeOperacion } from '@tcl-kol-os/db/test-utils';
import {
  entrarComoOperativo,
  escenarioDeOperacion,
  limpiarOperacion,
  obligacionesDe,
  rutaDeOperacion,
} from '../src/operacion';
import { gotoConReintento } from '../src/nav';

/**
 * E2E-24 — canje puro (barter): el detalle muestra «No aplica (canje)», NO hay formulario de pago ni documentos
 * de cobro, la lista muestra el pago como «No aplica» y el filtro «pago pendiente» no lo incluye (sí incluye a un
 * influencer con acuerdo fee, como contraste).
 */
test.describe.configure({ mode: 'serial' });
test.afterAll(async () => {
  await limpiarOperacion();
});

let op: EscenarioDeOperacion;
let campaignId = '';
let canje = '';
let fee = '';

test.beforeAll(async () => {
  op = await escenarioDeOperacion('e2e-24-canje', { acuerdo: 'barter' });
  campaignId = op.campanaId;
  canje = op.participaciones.valentinaRios;
  fee = op.participaciones.diego;
  // Contraste: Diego con un acuerdo fee (queda con pago pendiente).
  await crearAcuerdoDePrueba(op.admin, { campaignInfluencerId: fee, mode: 'fee', amount: '900000.00' });
});

test('E2E-24a — el detalle del canje no tiene pago ni documentos de cobro', async ({ page }) => {
  await entrarComoOperativo(page, op);
  await gotoConReintento(page, rutaDeOperacion(campaignId, canje));
  await expect(page.getByTestId('operacion-detalle-page')).toBeVisible();

  await expect(page.getByTestId('acuerdo-modo')).toHaveAttribute('data-valor', 'barter');
  await expect(page.getByTestId('seccion-acuerdo').getByTestId('pago-no-aplica')).toHaveText(
    'Pago: no aplica',
  );
  await expect(page.getByTestId('acuerdo-monto')).toHaveCount(0);

  const facturacion = page.getByTestId('seccion-facturacion-pagos');
  await expect(facturacion).toBeVisible();
  await expect(page.getByTestId('pago-no-aplica-canje')).toHaveText('No aplica (canje)');
  await expect(page.getByTestId('seguimiento-pago')).toHaveAttribute('data-valor', 'not_applicable');
  for (const id of [
    'form-reportar-pago',
    'form-registrar-documento',
    'form-validar-documento',
    'form-pago-evidencia',
    'form-correccion-pago',
    'documentos-lista',
    'documentos-vacio',
    'pago-reportado',
  ]) {
    await expect(page.getByTestId(id), id).toHaveCount(0);
  }
  await expect(page.getByRole('button', { name: /Reportar pago|Registrar documento de cobro/ })).toHaveCount(
    0,
  );
  expect((await obligacionesDe(campaignId)).map((o) => o.status).sort()).toEqual([
    'not_applicable',
    'pending',
  ]);
});

test('E2E-24b — la lista muestra «No aplica» y el filtro «pago pendiente» no incluye el canje', async ({
  page,
}) => {
  await entrarComoOperativo(page, op);
  await gotoConReintento(page, rutaDeOperacion(campaignId));
  const filaCanje = page.locator(`[data-testid="fila-participacion"][data-participacion-id="${canje}"]`);
  await expect(filaCanje.getByTestId('estado-pago')).toHaveAttribute('data-valor', 'not_applicable');
  await expect(filaCanje.getByTestId('estado-pago')).toContainText('No aplica');

  await gotoConReintento(page, `${rutaDeOperacion(campaignId)}?pagoPendiente=1`);
  await expect(page.getByTestId('filtro-pago-pendiente')).toHaveAttribute('aria-current', 'true');
  await expect(
    page.locator(`[data-testid="fila-participacion"][data-participacion-id="${canje}"]`),
  ).toHaveCount(0);
  await expect(
    page.locator(`[data-testid="fila-participacion"][data-participacion-id="${fee}"]`),
  ).toHaveCount(1);
  // El conteo de «pago pendiente» cuenta al de fee, no al canje.
  await expect(page.getByTestId('conteo-pago-pendiente')).toHaveText('1');
});
