import { type Page, expect, test } from '@playwright/test';
import { crearBriefAprobadoDePrueba, type EscenarioDeOperacion } from '@tcl-kol-os/db/test-utils';
import { query } from '@tcl-kol-os/db';
import {
  abrirChat,
  enviarMensaje,
  esperarRespuestas,
  esperarSinRunActivo,
  invocacionesDe,
  marcador,
  propuestasDe,
  runsDe,
} from '../src/chat';
import {
  TEXTO_SEMBRADO,
  estadoDeVersion,
  registrarGuionSembrado,
  revisarComoHumano,
  versionDe,
  type EscenarioE2E,
} from '../src/contenido';
import {
  CENTINELA,
  TODOS_LOS_CENTINELAS,
  contarEventosOperativos,
  escenarioDeOperacion,
  estadosDeEnvios,
  limpiarOperacion,
  obligacionesDe,
  sembrarKpiDeViews,
  sembrarOperacionConCentinelas,
} from '../src/operacion';
import { login } from '../src/login';

/**
 * E2E-28 — el agente de Cuenta frente a Operación (worker real, modelo falso). Como consultor, las tools de lectura
 * `operations_summary_list`, `operations_participation_status` y `kpi_scoreboard_get` devuelven estado logístico y
 * de KPI SIN fee, dirección, cédula, teléfono ni guía (ni en lo que ve la persona ni en lo que recibe el modelo, que
 * queda en `agent_tool_invocations.result`). El agente no puede registrar pagos ni entregas: «marca como pagado» no
 * tiene tool ni cambia ningún estado. La propuesta y la confirmación humana de la Fase 6/7 siguen intactas.
 */
test.describe.configure({ mode: 'serial' });
test.afterAll(async () => {
  await limpiarOperacion();
});

let op: EscenarioDeOperacion;
let campaignId = '';
let ci = '';

test.beforeAll(async () => {
  op = await escenarioDeOperacion('e2e-28-agente', { acuerdo: 'mixed', monto: `${CENTINELA.fee}.00` });
  campaignId = op.campanaId;
  ci = op.participaciones.valentinaRios;
  // Operación sembrada: enviada (NO entregada), documento validado, pago PENDIENTE; KPI cumplido.
  await sembrarOperacionConCentinelas(op, { reportarPago: false });
  await sembrarKpiDeViews(op, ci);
});

async function resultadoDe(tool: string): Promise<string> {
  const filas = await query<{ resultado: string | null; status: string }>(
    `SELECT result::text AS resultado, status FROM agent_tool_invocations
      WHERE campaign_id = $1 AND tool_name = $2 ORDER BY created_at DESC LIMIT 1`,
    [campaignId, tool],
  );
  expect(filas[0]?.status, `la tool ${tool} debe haber terminado bien`).toBe('succeeded');
  return filas[0]!.resultado ?? '';
}

function sinSensibles(texto: string, donde: string): void {
  for (const c of TODOS_LOS_CENTINELAS) expect(texto, `«${c}» no debe estar en ${donde}`).not.toContain(c);
  expect(texto, `un monto no debe estar en ${donde}`).not.toMatch(/7[.,]?654[.,]?321/);
}

async function textoVisible(page: Page): Promise<string> {
  return page.getByTestId('chat-thread').innerText();
}

async function estadoDePagoYEntrega() {
  return {
    obligaciones: (await obligacionesDe(campaignId)).map((o) => `${o.status}:${o.row_seq}`),
    envios: await estadosDeEnvios(campaignId),
    pagos: await contarEventosOperativos(campaignId, 'payment.reported'),
    entregas: await contarEventosOperativos(campaignId, 'shipment.delivered'),
  };
}

test('E2E-28a — las tools de lectura devuelven estado logístico y KPI, sin dinero ni datos personales', async ({
  page,
}) => {
  test.setTimeout(240_000);
  await login(page, op.consultor.email);
  await abrirChat(page, campaignId);

  // 1. Resumen operativo de la campaña.
  await enviarMensaje(page, `¿Cómo va la operación? ${marcador('operations_summary_list', {})}`);
  await esperarRespuestas(page, 1);
  await esperarSinRunActivo(page);
  const resumen = await resultadoDe('operations_summary_list');
  sinSensibles(resumen, 'el resultado de operations_summary_list');
  // Lo persistido de la invocación es solo su resumen (el contenido va al modelo, no a la base): 3 participaciones.
  expect(JSON.parse(resumen)).toMatchObject({ total: 3, returned: 3 });

  // 2. Estado de una participación (alias P… de la campaña).
  await enviarMensaje(
    page,
    `¿Y la de Valentina Ríos? ${marcador('operations_participation_status', { participationId: 'P1' })}`,
  );
  await esperarRespuestas(page, 2);
  await esperarSinRunActivo(page);
  const estado = await resultadoDe('operations_participation_status');
  sinSensibles(estado, 'el resultado de operations_participation_status');
  expect(JSON.parse(estado)).toBeTruthy();

  // 3. Marcador de KPIs.
  await enviarMensaje(
    page,
    `¿Cómo van los KPI? ${marcador('kpi_scoreboard_get', { participationId: 'P1' })}`,
  );
  await esperarRespuestas(page, 3);
  await esperarSinRunActivo(page);
  const kpi = await resultadoDe('kpi_scoreboard_get');
  sinSensibles(kpi, 'el resultado de kpi_scoreboard_get');
  expect(JSON.parse(kpi)).toBeTruthy();

  // Lo que ve la persona (hilo y actividad): sin ningún centinela ni JSON interno.
  sinSensibles(await textoVisible(page), 'la conversación visible');
  sinSensibles(await page.content(), 'el DOM del chat');

  const invocaciones = await invocacionesDe(campaignId);
  expect(invocaciones.map((i) => `${i.tool_name}:${i.risk_class}:${i.status}`)).toEqual([
    'operations_summary_list:read:succeeded',
    'operations_participation_status:read:succeeded',
    'kpi_scoreboard_get:read:succeeded',
  ]);
  expect((await runsDe(campaignId)).every((r) => r.status === 'completed')).toBe(true);
});

test('E2E-28b — el agente no puede registrar pagos ni entregas: «marca como pagado» no cambia ningún estado', async ({
  page,
}) => {
  test.setTimeout(240_000);
  const antes = await estadoDePagoYEntrega();
  expect(antes.pagos).toBe(0);
  expect(antes.entregas).toBe(0);
  expect(antes.envios).toEqual(['shipped']);
  expect(antes.obligaciones[0]).toMatch(/^pending:/);
  const invocacionesPrevias = (await invocacionesDe(campaignId)).length;

  await login(page, op.consultor.email);
  await abrirChat(page, campaignId);
  const respuestasPrevias = await page.locator('[data-testid="chat-message"][data-role="assistant"]').count();

  // Tools que NO existen (el modelo falso solo emite las declaradas): no hay llamada ni efecto.
  const pedidos = [
    `Marca como pagado el fee de Valentina. ${marcador('payment_report', { participationId: 'P1', paidOn: '2026-10-01', externalReference: 'REF-AGENTE' })}`,
    `Marca como entregado el envío. ${marcador('shipment_mark_delivered', { participationId: 'P1' })}`,
    `Registra la medición de views: 99999. ${marcador('kpi_measurement_register', { participationId: 'P1', value: 99999 })}`,
  ];
  let esperadas = respuestasPrevias;
  for (const pedido of pedidos) {
    await enviarMensaje(page, pedido);
    esperadas += 1;
    await esperarRespuestas(page, esperadas);
    await esperarSinRunActivo(page);
  }

  expect(await invocacionesDe(campaignId)).toHaveLength(invocacionesPrevias);
  expect(await estadoDePagoYEntrega()).toEqual(antes);
  const mediciones = await query<{ n: number }>(
    `SELECT count(*)::int AS n FROM kpi_measurements WHERE campaign_id = $1`,
    [campaignId],
  );
  expect(mediciones[0]!.n).toBe(1);
  sinSensibles(await textoVisible(page), 'la conversación visible');
});

test('E2E-28c — la propuesta y la confirmación humana de aprobar un guion siguen intactas', async ({
  page,
}) => {
  test.setTimeout(300_000);
  // El escenario de operación ES un escenario de contenido: se le agrega Brief aprobado y un guion en revisión.
  const brief = await crearBriefAprobadoDePrueba(op.campanaId, op.admin, {
    productos: [op.productos.p80, op.productos.pro],
    noEncontrados: ['objetivo.comportamiento_esperado'],
  });
  const s: EscenarioE2E = {
    e: op,
    campaignId,
    brief,
    valentina: { participacionId: ci, deliverableId: op.entregables.reelRios },
    diego: { participacionId: op.participaciones.diego, deliverableId: op.entregables.reelDiego },
  };
  const v1 = await registrarGuionSembrado(s, s.valentina.deliverableId, ci, TEXTO_SEMBRADO);
  await revisarComoHumano(v1.versionId, op.consultor);
  const propuestasPrevias = (await propuestasDe(campaignId)).length;

  const FRASE = 'aprueba el guion de Valentina';
  await login(page, op.consultor.email);
  await abrirChat(page, campaignId);
  const previas = await page.locator('[data-testid="chat-message"][data-role="assistant"]').count();
  await enviarMensaje(
    page,
    `${FRASE} ${marcador('script_propose_approval', { versionId: 'V1', evidenceQuote: FRASE })}`,
  );
  await esperarRespuestas(page, previas + 1);
  await esperarSinRunActivo(page);

  // El asistente SOLO propone: la versión sigue sin aprobar y la propuesta queda pendiente.
  const tarjeta = page.getByTestId('chat-thread').getByTestId('chat-proposal');
  await expect(tarjeta).toHaveCount(1);
  await expect(tarjeta).toHaveAttribute('data-tipo', 'script_version.approve');
  await expect(tarjeta).toHaveAttribute('data-estado', 'pending');
  await expect(tarjeta.getByTestId('chat-proposal-confirm')).toHaveCount(0);
  const propuestas = await propuestasDe(campaignId);
  expect(propuestas).toHaveLength(propuestasPrevias + 1);
  const propuesta = propuestas.at(-1)!;
  expect(propuesta).toMatchObject({
    action_type: 'script_version.approve',
    status: 'pending',
    proposed_origin: 'chat',
    confirmed_by: null,
  });
  expect(await estadoDeVersion(v1.versionId)).toBe('in_review');

  // El director confirma desde la interfaz (doble clic: una sola aprobación).
  await login(page, op.director.email);
  await abrirChat(page, campaignId);
  const panel = page.getByTestId('chat-pending-panel');
  await expect(panel).toBeVisible();
  await panel.getByTestId('chat-proposal').getByTestId('chat-proposal-confirm').click();
  await page.getByTestId('chat-proposal-dialog-confirm').dblclick();
  await expect.poll(() => estadoDeVersion(v1.versionId), { timeout: 30_000 }).toBe('approved');
  await expect
    .poll(async () => (await propuestasDe(campaignId)).at(-1)!.status, { timeout: 30_000 })
    .toBe('executed');
  const aprobada = await versionDe(s.valentina.deliverableId, 1);
  expect(aprobada).toMatchObject({ status: 'approved', approved_by: op.director.id });
  expect(aprobada.approved_via_proposed_action_id).toBe(propuesta.id);
});
