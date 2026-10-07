import { expect, test } from '@playwright/test';
import type { EscenarioDeOperacion } from '@tcl-kol-os/db/test-utils';
import {
  CENTINELA,
  TODOS_LOS_CENTINELAS,
  archivoPdf,
  escenarioDeOperacion,
  limpiarOperacion,
  rutaDeEvidencia,
  rutaDeOperacion,
  sembrarKpiDeViews,
  sembrarOperacionConCentinelas,
  type OperacionSembrada,
} from '../src/operacion';
import { login } from '../src/login';
import { gotoConReintento } from '../src/nav';

/**
 * E2E-27 — el cliente TCL no recibe NADA operativo. Con una operación sembrada con centinelas (fee, dirección,
 * cédula, teléfono, guía, referencia de pago, nombre de archivo de evidencia, nota interna), recorre las rutas de
 * campaña y Brief que SÍ puede abrir: ni el HTML ni las respuestas crudas contienen un centinela. La ruta de
 * Operación (lista y detalle) y la de evidencia dan 404.
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
  op = await escenarioDeOperacion('e2e-27-tcl', { acuerdo: 'mixed', monto: `${CENTINELA.fee}.00` });
  campaignId = op.campanaId;
  participacionId = op.participaciones.valentinaRios;
  sembrado = await sembrarOperacionConCentinelas(op, { reportarPago: true });
  await sembrarKpiDeViews(op, participacionId);
});

function sinCentinelas(texto: string, donde: string): void {
  for (const c of TODOS_LOS_CENTINELAS) expect(texto, `«${c}» no debe estar en ${donde}`).not.toContain(c);
  // Tampoco los identificadores internos de lo operativo.
  for (const id of [sembrado.envioId, sembrado.obligacionId, sembrado.documentoId, sembrado.piiRecordId]) {
    expect(texto, `un id operativo no debe estar en ${donde}`).not.toContain(id);
  }
}

test('E2E-27a — las rutas de campaña y Brief que el cliente TCL puede abrir no contienen ningún centinela', async ({
  page,
}) => {
  await login(page, 'marena@tcl.com');

  const rutas = [
    '/campanas',
    `/campanas/${campaignId}`,
    `/campanas/${campaignId}/brief`,
    `/campanas/${campaignId}/fuentes`,
    `/campanas/${campaignId}/contenido`,
    `/campanas/${campaignId}/chat`,
  ];
  const abiertas: string[] = [];
  for (const ruta of rutas) {
    const respuesta = await gotoConReintento(page, ruta);
    const estado = respuesta?.status() ?? 0;
    // DOM renderizado (incluye la carga de datos incrustada por Next) y respuesta cruda del servidor.
    sinCentinelas(await page.content(), `el DOM de ${ruta} (HTTP ${estado})`);
    const cruda = await page.request.get(ruta);
    sinCentinelas(await cruda.text(), `la respuesta cruda de ${ruta} (HTTP ${cruda.status()})`);
    for (const [nombre, valor] of Object.entries(cruda.headers())) {
      sinCentinelas(`${nombre}: ${valor}`, `las cabeceras de ${ruta}`);
    }
    if (estado === 200) abiertas.push(ruta);
    // En ninguna hay enlace ni sección de Operación.
    await expect(page.getByTestId('operacion-nav-link'), `enlace en ${ruta}`).toHaveCount(0);
    await expect(page.getByTestId('seccion-facturacion-pagos')).toHaveCount(0);
    await expect(page.getByTestId('bloque-datos-entrega')).toHaveCount(0);
  }
  // Al menos la lista de campañas se abre: el recorrido no es vacío.
  expect(abiertas.length, `rutas abiertas: ${abiertas.join(', ')}`).toBeGreaterThan(0);
});

test('E2E-27b — la lista y el detalle de Operación y la ruta de evidencia dan 404 al cliente, sin filtrar nada', async ({
  page,
}) => {
  await login(page, 'marena@tcl.com');
  for (const ruta of [rutaDeOperacion(campaignId), rutaDeOperacion(campaignId, participacionId)]) {
    const r = await gotoConReintento(page, ruta);
    expect(r?.status(), `GET ${ruta}`).toBe(404);
    sinCentinelas(await page.content(), `el 404 de ${ruta}`);
    const cruda = await page.request.get(ruta);
    expect(cruda.status()).toBe(404);
    sinCentinelas(await cruda.text(), `el 404 crudo de ${ruta}`);
  }

  // Evidencia: POST con cada tipo de sujeto sembrado ⇒ el mismo 404, sin eco de nombres ni ids.
  for (const cuerpo of [
    { tipo: 'envio', accion: 'adjuntar', shipmentId: sembrado.envioId, expectedSeq: '1' },
    {
      tipo: 'pago',
      accion: 'adjuntar',
      participacionId,
      paymentObligationId: sembrado.obligacionId,
      expectedSeq: '1',
    },
    {
      tipo: 'documento_cobro',
      accion: 'adjuntar',
      participacionId,
      billingDocumentId: sembrado.documentoId,
      expectedSeq: '1',
    },
  ]) {
    const r = await page.request.post(rutaDeEvidencia(campaignId), {
      multipart: { archivo: archivoPdf('intruso-tcl.pdf'), idempotencyKey: 'e2e-27-intruso', ...cuerpo },
    });
    expect(r.status(), `POST evidencia ${cuerpo.tipo}`).toBe(404);
    const texto = await r.text();
    sinCentinelas(texto, `la respuesta del POST de evidencia (${cuerpo.tipo})`);
    expect(texto).not.toContain('intruso-tcl.pdf');
    expect(texto).not.toContain(campaignId);
  }
  // GET sobre la ruta de evidencia (no existe como lectura): tampoco entrega nada.
  const lectura = await page.request.get(rutaDeEvidencia(campaignId));
  expect([404, 405]).toContain(lectura.status());
  sinCentinelas(await lectura.text(), 'la lectura de la ruta de evidencia');
});
