import { type Page, expect, test } from '@playwright/test';
import type { EscenarioDeOperacion } from '@tcl-kol-os/db/test-utils';
import {
  CENTINELA,
  CENTINELAS_PII,
  entrarComoOperativo,
  escenarioDeOperacion,
  limpiarOperacion,
  rutaDeOperacion,
  sembrarKpiDeViews,
  sembrarOperacionConCentinelas,
  type OperacionSembrada,
} from '../src/operacion';
import { login } from '../src/login';
import { gotoConReintento } from '../src/nav';

/**
 * E2E-26 — separación de roles y de datos. El consultor ve el acuerdo (sin montos), la logística (sin costo ni
 * dirección) y los KPI, y la sección de facturación/pagos y el bloque de datos de entrega NO existen en su DOM. El
 * director ve las finanzas pero no los datos personales. El operativo ve el bloque de datos de entrega: antes de
 * «Revelar datos» el DOM no contiene dirección, teléfono ni cédula; tras el clic sí; tras «Ocultar datos» no. Las
 * páginas de Operación no ofrecen al operativo ninguna acción de aprobar guion o Brief ni de revisión creativa.
 */
test.describe.configure({ mode: 'serial' });
test.afterAll(async () => {
  await limpiarOperacion();
});

let op: EscenarioDeOperacion;
let sembrado: OperacionSembrada;
let campaignId = '';
let participacionId = '';

test.beforeAll(async () => {
  op = await escenarioDeOperacion('e2e-26-roles-datos', { acuerdo: 'mixed', monto: `${CENTINELA.fee}.00` });
  campaignId = op.campanaId;
  participacionId = op.participaciones.valentinaRios;
  sembrado = await sembrarOperacionConCentinelas(op, { reportarPago: true });
  await sembrarKpiDeViews(op, participacionId);
});

async function abrirDetalle(page: Page): Promise<void> {
  await gotoConReintento(page, rutaDeOperacion(campaignId, participacionId));
  await expect(page.getByTestId('operacion-detalle-page')).toBeVisible();
}

/** Todo el DOM serializado (incluye atributos y la carga de datos que Next incrusta en la página). */
async function dom(page: Page): Promise<string> {
  return page.content();
}

function sinCentinelas(texto: string, centinelas: readonly string[], donde: string): void {
  for (const c of centinelas) expect(texto, `«${c}» no debe estar en ${donde}`).not.toContain(c);
}

test('E2E-26a — el consultor ve acuerdo (sin montos), logística (sin costo ni dirección) y KPI; no existen facturación ni datos de entrega', async ({
  page,
}) => {
  await login(page, op.consultor.email);
  await abrirDetalle(page);

  await expect(page.getByTestId('seccion-acuerdo')).toBeVisible();
  await expect(page.getByTestId('acuerdo-modo')).toHaveAttribute('data-valor', 'mixed');
  await expect(page.getByTestId('acuerdo-monto')).toHaveCount(0);
  await expect(page.getByTestId('seccion-logistica')).toBeVisible();
  await expect(page.getByTestId('envio')).toHaveCount(1);
  await expect(page.getByTestId('envio-estado')).toHaveText('Enviado');
  await expect(page.getByTestId('envio-costo')).toHaveCount(0);
  await expect(page.getByTestId('seccion-kpi')).toBeVisible();
  await expect(page.getByTestId('kpi-fila')).toHaveCount(1);
  await expect(page.getByTestId('kpi-estado')).toHaveAttribute('data-valor', 'cumplido');

  // Lo que NO existe en el DOM (no «oculto»: ausente).
  for (const id of [
    'seccion-facturacion-pagos',
    'seguimiento-pago',
    'documento-cobro',
    'form-reportar-pago',
    'bloque-datos-entrega',
    'datos-entrega-campos',
    'form-guardar-datos-personales',
    'form-registrar-medicion',
  ]) {
    await expect(page.getByTestId(id), id).toHaveCount(0);
  }
  await expect(page.getByRole('button', { name: 'Revelar datos' })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: /Datos de entrega|Facturación y pagos/ })).toHaveCount(0);

  const html = await dom(page);
  sinCentinelas(
    html,
    [
      ...CENTINELAS_PII,
      CENTINELA.fee,
      CENTINELA.costoDeEnvio,
      CENTINELA.referenciaDePago,
      CENTINELA.numeroDeDocumento,
      CENTINELA.archivoDeCobro,
      CENTINELA.notaInterna,
    ],
    'el DOM del consultor',
  );

  // La lista: sin estado ni filtro de pago, sin conteo de pagos.
  await gotoConReintento(page, rutaDeOperacion(campaignId));
  await expect(page.getByTestId('operacion-page')).toBeVisible();
  await expect(page.getByTestId('estado-pago')).toHaveCount(0);
  await expect(page.getByTestId('filtro-pago-pendiente')).toHaveCount(0);
  await expect(page.getByTestId('conteo-pago-pendiente')).toHaveCount(0);
  sinCentinelas(await dom(page), [CENTINELA.fee, ...CENTINELAS_PII], 'la lista del consultor');
});

test('E2E-26b — el director ve las finanzas (fee, costo, pago) pero NO los datos personales', async ({
  page,
}) => {
  await login(page, op.director.email);
  await abrirDetalle(page);

  await expect(page.getByTestId('acuerdo-monto')).toContainText(CENTINELA.fee);
  await expect(page.getByTestId('envio-costo')).toContainText(CENTINELA.costoDeEnvio);
  await expect(page.getByTestId('seccion-facturacion-pagos')).toBeVisible();
  await expect(page.getByTestId('seguimiento-pago')).toHaveAttribute('data-valor', 'reported_paid');
  await expect(page.getByTestId('pago-referencia')).toHaveText(CENTINELA.referenciaDePago);
  await expect(page.getByTestId('documento-cobro')).toContainText(CENTINELA.numeroDeDocumento);

  // Datos de entrega: ni el bloque ni los valores; tampoco puede reportar pagos (no es de su rol).
  await expect(page.getByTestId('bloque-datos-entrega')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Revelar datos' })).toHaveCount(0);
  await expect(page.getByTestId('form-guardar-datos-personales')).toHaveCount(0);
  await expect(page.getByTestId('form-reportar-pago')).toHaveCount(0);
  sinCentinelas(await dom(page), CENTINELAS_PII, 'el DOM del director');

  await gotoConReintento(page, rutaDeOperacion(campaignId));
  await expect(page.getByTestId('estado-pago').first()).toBeVisible();
  sinCentinelas(await dom(page), CENTINELAS_PII, 'la lista del director');
});

test('E2E-26c — el operativo: los datos de entrega no están en el DOM hasta «Revelar datos» y se van con «Ocultar datos»', async ({
  page,
}) => {
  await entrarComoOperativo(page, op);
  await abrirDetalle(page);

  const bloque = page.getByTestId('bloque-datos-entrega');
  await expect(bloque).toBeVisible();
  // Se sabe QUÉ campos existen, no su valor.
  for (const campo of ['document_id', 'phone', 'address']) {
    await expect(page.getByTestId(`pii-campo-${campo}`)).toContainText('guardado');
    await expect(page.getByTestId(`pii-valor-${campo}`)).toHaveCount(0);
  }
  sinCentinelas(await dom(page), CENTINELAS_PII, 'el DOM del operativo antes de revelar');
  sinCentinelas(await bloque.innerText(), CENTINELAS_PII, 'el texto del bloque antes de revelar');

  // Revelar.
  await page.getByRole('button', { name: 'Revelar datos' }).click();
  await expect(page.getByTestId('pii-valor-address')).toHaveText(CENTINELA.direccion);
  await expect(page.getByTestId('pii-valor-phone')).toHaveText(CENTINELA.telefono);
  await expect(page.getByTestId('pii-valor-document_id')).toHaveText(CENTINELA.cedula);
  await expect(page.getByTestId('revelar-datos-resultado')).toBeVisible();
  const revelado = await dom(page);
  for (const c of CENTINELAS_PII) expect(revelado).toContain(c);
  // Los valores no se quedan en la URL ni en el almacenamiento del navegador.
  expect(page.url()).not.toContain(CENTINELA.cedula);
  const almacenado = await page.evaluate(
    () => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }),
  );
  sinCentinelas(almacenado, CENTINELAS_PII, 'el almacenamiento del navegador');

  // Ocultar: desaparecen del DOM.
  await page.getByRole('button', { name: 'Ocultar datos' }).click();
  await expect(page.getByTestId('pii-valor-address')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Revelar datos' })).toBeVisible();
  sinCentinelas(await dom(page), CENTINELAS_PII, 'el DOM del operativo tras ocultar');

  // Recargar tampoco los trae de vuelta.
  await page.reload();
  await expect(page.getByTestId('bloque-datos-entrega')).toBeVisible();
  sinCentinelas(await dom(page), CENTINELAS_PII, 'el DOM del operativo tras recargar');
  expect(sembrado.piiRecordId).not.toBe('');
});

test('E2E-26d — las páginas de Operación no ofrecen al operativo aprobar guiones/Brief ni revisión creativa', async ({
  page,
}) => {
  await entrarComoOperativo(page, op);
  for (const ruta of [rutaDeOperacion(campaignId), rutaDeOperacion(campaignId, participacionId)]) {
    await gotoConReintento(page, ruta);
    await expect(
      page.getByTestId('operacion-page').or(page.getByTestId('operacion-detalle-page')),
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: /aprobar|solicitar cambios|revisi[oó]n|an[aá]lisis|comentar/i }),
      `botones creativos en ${ruta}`,
    ).toHaveCount(0);
    for (const id of [
      'contenido-aprobar',
      'contenido-aprobacion-card',
      'contenido-solicitar-analisis',
      'contenido-acciones-revision',
      'contenido-acciones-comentario',
      'contenido-subir-form',
      'brief-aprobar',
    ]) {
      await expect(page.getByTestId(id), `${id} en ${ruta}`).toHaveCount(0);
    }
  }
  // La sección de contenido es de solo lectura: solo un enlace a Contenido, sin formularios.
  await abrirDetalle(page);
  await expect(page.getByTestId('seccion-contenido')).toBeVisible();
  await expect(page.getByTestId('seccion-contenido').locator('form, button')).toHaveCount(0);
});
