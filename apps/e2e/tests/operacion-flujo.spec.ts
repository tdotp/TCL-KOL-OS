import { type Page, expect, test } from '@playwright/test';
import {
  archivoPdf,
  contarEnvios,
  contarEventosOperativos,
  contarVersionesDeAcuerdo,
  dia,
  entrarComoOperativo,
  escenarioDeOperacion,
  estadosDeEnvios,
  limpiarOperacion,
  obligacionesDe,
  rutaDeOperacion,
  tiposDeEventosOperativos,
} from '../src/operacion';
import { gotoConReintento } from '../src/nav';
import type { EscenarioDeOperacion } from '@tcl-kol-os/db/test-utils';

/**
 * E2E-23 — flujo del Operativo con un acuerdo MIXTO (fee + producto comprometido): crea el acuerdo, registra una
 * versión nueva con motivo, crea el envío y lo lleva pendiente → preparado → enviado → entregado; «entregado» por
 * producto consta SOLO tras el evento (asignar, comprometer o enviar no es entregar); registra un documento de cobro
 * con archivo, lo valida, reporta el pago (el sistema no ejecuta pagos) y un doble clic no duplica el hecho.
 */
test.describe.configure({ mode: 'serial' });
test.afterAll(async () => {
  await limpiarOperacion();
});

let op: EscenarioDeOperacion;
let campaignId = '';
let participacionId = '';

test.beforeAll(async () => {
  // Sin acuerdo inicial: el Operativo lo crea desde la interfaz.
  op = await escenarioDeOperacion('e2e-23-flujo');
  campaignId = op.campanaId;
  participacionId = op.participaciones.valentinaRios;
});

async function abrirDetalle(page: Page): Promise<void> {
  await gotoConReintento(page, rutaDeOperacion(campaignId, participacionId));
  await expect(page.getByTestId('operacion-detalle-page')).toBeVisible();
}

/** Cantidades comprometido/enviado/entregado de la primera fila de producto. */
async function cantidadesDeProducto(
  page: Page,
): Promise<{ comprometido: string; enviado: string; entregado: string }> {
  const celdas = page.getByTestId('logistica-producto').first().locator('td');
  await expect(celdas).toHaveCount(3);
  return {
    comprometido: ((await celdas.nth(0).textContent()) ?? '').trim(),
    enviado: ((await celdas.nth(1).textContent()) ?? '').trim(),
    entregado: ((await celdas.nth(2).textContent()) ?? '').trim(),
  };
}

test('E2E-23a — el Operativo crea el acuerdo mixto y registra una versión nueva con motivo', async ({
  page,
}) => {
  await entrarComoOperativo(page, op);
  await abrirDetalle(page);

  await expect(page.getByTestId('acuerdo-estado')).toHaveAttribute('data-valor', 'sin_acuerdo');
  await expect(page.getByTestId('acuerdo-vacio')).toBeVisible();

  const crear = page.getByTestId('form-crear-acuerdo');
  await crear.getByLabel('Modo de compensación').selectOption('mixed');
  await crear.getByLabel('Monto del fee').fill('1500000.00');
  await crear.getByLabel('Condiciones').fill('Dos publicaciones y un producto de cortesía (E2E-23).');
  await crear.locator('select[name="commitmentProductId"]').first().selectOption({ index: 1 });
  await crear.locator('input[name="commitmentQuantity"]').first().fill('2');
  await crear.getByRole('button', { name: 'Registrar acuerdo' }).click();
  await expect(page.getByTestId('form-crear-acuerdo-resultado').getByRole('status')).toBeVisible();

  await expect(page.getByTestId('acuerdo-estado')).toHaveAttribute('data-valor', 'active');
  await expect(page.getByTestId('acuerdo-modo')).toHaveAttribute('data-valor', 'mixed');
  await expect(page.getByTestId('acuerdo-version-vigente')).toHaveText('V1');
  await expect(page.getByTestId('acuerdo-monto')).toContainText('1500000');
  await expect(page.getByTestId('acuerdo-compromisos')).toContainText('× 2');
  expect(await contarVersionesDeAcuerdo(campaignId)).toBe(1);

  // Versión nueva: motivo obligatorio; el fee cambia y el historial conserva la V1.
  const nueva = page.getByTestId('form-nueva-version-acuerdo');
  await nueva.getByLabel('Monto del fee').fill('1600000.00');
  await nueva.getByLabel('Motivo del cambio').fill('Se amplía el fee por una pieza adicional (E2E-23).');
  await nueva.getByRole('button', { name: 'Registrar nueva versión' }).click();
  await expect(page.getByTestId('acuerdo-version-vigente')).toHaveText('V2');
  await expect(page.getByTestId('acuerdo-monto')).toContainText('1600000');
  await expect(page.getByTestId('acuerdo-version')).toHaveCount(2);
  await expect(page.getByTestId('acuerdo-historial')).toContainText('Motivo: Se amplía el fee');
  expect(await contarVersionesDeAcuerdo(campaignId)).toBe(2);
});

test('E2E-23b — envío pendiente → preparado → enviado → entregado: «entregado» solo tras el evento', async ({
  page,
}) => {
  await entrarComoOperativo(page, op);
  await abrirDetalle(page);

  // Producto asignado y comprometido, pero NADA enviado ni entregado todavía.
  await expect(page.getByTestId('logistica-estado')).toHaveAttribute('data-valor', 'sin_envio');
  expect(await cantidadesDeProducto(page)).toEqual({ comprometido: '2', enviado: '0', entregado: '0' });

  const crear = page.getByTestId('form-crear-envio');
  await crear.locator('select[name="itemProductId"]').first().selectOption({ index: 1 });
  await crear.locator('input[name="itemQuantity"]').first().fill('1');
  await crear.getByRole('button', { name: 'Crear envío' }).click();
  await expect(page.getByTestId('envio')).toHaveCount(1);
  const envio = page.getByTestId('envio').first();
  await expect(envio).toHaveAttribute('data-estado', 'pending');
  await expect(page.getByTestId('logistica-estado')).toHaveAttribute('data-valor', 'pendiente');
  expect(await cantidadesDeProducto(page)).toEqual({ comprometido: '2', enviado: '0', entregado: '0' });
  expect(await estadosDeEnvios(campaignId)).toEqual(['pending']);

  // Preparado.
  await envio.getByTestId('form-envio-preparado').getByRole('button', { name: 'Marcar preparado' }).click();
  await expect(envio).toHaveAttribute('data-estado', 'prepared');
  expect(await cantidadesDeProducto(page)).toEqual({ comprometido: '2', enviado: '0', entregado: '0' });

  // Enviado: transportadora y guía; sigue SIN entregar.
  const enviado = envio.getByTestId('form-envio-enviado');
  await enviado.getByLabel('Transportadora').fill('Servientrega E2E');
  await enviado.getByLabel('Guía (tracking)').fill('GUIA-E2E-23');
  await enviado.getByRole('button', { name: 'Marcar enviado' }).click();
  await expect(envio).toHaveAttribute('data-estado', 'shipped');
  await expect(page.getByTestId('envio-transportadora')).toHaveText('Servientrega E2E');
  await expect(page.getByTestId('envio-tracking')).toHaveText('GUIA-E2E-23');
  await expect(page.getByTestId('logistica-estado')).toHaveAttribute('data-valor', 'en_transito');
  const trasEnviar = await cantidadesDeProducto(page);
  expect(trasEnviar.entregado).toBe('0');
  expect(await contarEventosOperativos(campaignId, 'shipment.delivered')).toBe(0);

  // Entregado: solo ahora «entregado» por producto sube.
  await envio.getByTestId('form-envio-entregado').getByRole('button', { name: 'Marcar entregado' }).click();
  await expect(envio).toHaveAttribute('data-estado', 'delivered');
  await expect(page.getByTestId('logistica-estado')).toHaveAttribute('data-valor', 'entregado');
  const trasEntregar = await cantidadesDeProducto(page);
  expect(trasEntregar.entregado).toBe('1');
  expect(await contarEventosOperativos(campaignId, 'shipment.delivered')).toBe(1);
  expect(await estadosDeEnvios(campaignId)).toEqual(['delivered']);
  expect(await contarEnvios(campaignId)).toBe(1);

  // El historial del envío lista los cuatro hechos, en orden.
  await expect(page.getByTestId('envio-evento')).toHaveCount(4);
  expect(
    await page.getByTestId('envio-evento').evaluateAll((els) => els.map((e) => e.getAttribute('data-tipo'))),
  ).toEqual(
    expect.arrayContaining([
      'shipment.created',
      'shipment.prepared',
      'shipment.shipped',
      'shipment.delivered',
    ]),
  );
});

test('E2E-23c — documento de cobro con archivo, validación y pago reportado (sin duplicar con doble clic)', async ({
  page,
}) => {
  await entrarComoOperativo(page, op);
  await abrirDetalle(page);

  await expect(page.getByTestId('seguimiento-pago')).toHaveAttribute('data-valor', 'pending_document');
  await expect(page.getByTestId('documentos-vacio')).toBeVisible();

  // Registrar el documento de cobro con su archivo (sube por la ruta de evidencia).
  const registrar = page.getByTestId('form-registrar-documento');
  await registrar.getByLabel('Número del documento').fill('CC-E2E-23-001');
  await registrar.getByLabel('Fecha de emisión').fill(dia(1));
  await registrar.getByLabel('Monto que cobra el documento').fill('1600000.00');
  await registrar.getByLabel('Moneda (3 letras)').fill('COP');
  await registrar.locator('input[type="file"]').setInputFiles(archivoPdf('cuenta-cobro-e2e-23.pdf'));
  await registrar.getByRole('button', { name: 'Registrar documento de cobro' }).click();
  await expect(page.getByTestId('documento-cobro')).toHaveCount(1);
  const documento = page.getByTestId('documento-cobro').first();
  await expect(documento).toHaveAttribute('data-estado', 'registered');
  await expect(documento).toContainText('CC-E2E-23-001');
  await expect(documento).toContainText('cuenta-cobro-e2e-23.pdf');
  await expect(page.getByTestId('seguimiento-pago')).toHaveAttribute('data-valor', 'document_received');
  expect(await contarEventosOperativos(campaignId, 'billing.registered')).toBe(1);

  // Validar.
  await documento
    .getByTestId('form-validar-documento')
    .getByRole('button', { name: 'Validar documento' })
    .click();
  await expect(documento).toHaveAttribute('data-estado', 'validated');
  await expect(page.getByTestId('seguimiento-pago')).toHaveAttribute('data-valor', 'pending_payment');
  expect(await contarEventosOperativos(campaignId, 'billing.validated')).toBe(1);

  // Reportar el pago: aviso «el sistema no ejecuta pagos» visible ANTES de enviar.
  const reportar = page.getByTestId('form-reportar-pago');
  await expect(page.getByTestId('aviso-pago-solo-registro')).toBeVisible();
  await expect(page.getByTestId('aviso-pago-solo-registro')).toContainText('el sistema no ejecuta pagos');
  await expect(page.getByTestId('aviso-sin-documento-validado')).toHaveCount(0);
  await reportar.getByLabel('Fecha del pago').fill(dia(1));
  await reportar.getByLabel('Referencia externa del pago').fill('REF-E2E-23-0001');
  // Doble clic (dos envíos casi simultáneos): un solo hecho.
  await reportar.getByRole('button', { name: 'Reportar pago' }).dblclick();

  await expect(page.getByTestId('seguimiento-pago')).toHaveAttribute('data-valor', 'reported_paid');
  await expect(page.getByTestId('seguimiento-pago')).toHaveText('Pago reportado');
  await expect(page.getByTestId('pago-referencia')).toHaveText('REF-E2E-23-0001');
  await expect(page.getByTestId('form-reportar-pago')).toHaveCount(0);

  expect(await contarEventosOperativos(campaignId, 'payment.reported')).toBe(1);
  const obligaciones = await obligacionesDe(campaignId);
  expect(obligaciones).toHaveLength(1);
  expect(obligaciones[0]!.status).toBe('reported_paid');

  // Recargar no cambia nada; la historia completa quedó en eventos humanos, sin duplicados.
  await page.reload();
  await expect(page.getByTestId('seguimiento-pago')).toHaveAttribute('data-valor', 'reported_paid');
  expect(await contarEventosOperativos(campaignId, 'payment.reported')).toBe(1);
  const tipos = await tiposDeEventosOperativos(campaignId);
  expect(tipos.filter((t) => t === 'billing.registered')).toHaveLength(1);
  expect(tipos.filter((t) => t === 'billing.validated')).toHaveLength(1);
  expect(tipos.filter((t) => t === 'shipment.created')).toHaveLength(1);
});
