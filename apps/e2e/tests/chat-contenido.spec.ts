import { expect, test } from '@playwright/test';
import { confirmarAccion, ejecutarAccion } from '@tcl-kol-os/db';
import {
  abrirChat,
  conversacionesDe,
  enviarMensaje,
  esperarRespuestas,
  esperarSinRunActivo,
  invocacionesDe,
  marcador,
  mensajesDe,
  propuestasDe,
  runsDe,
} from '../src/chat';
import {
  auditoriaDeEntidad,
  contarAuditoriaDeCampana,
  escenarioDeContenido,
  estadoDeVersion,
  limpiarContenido,
  registrarGuionSembrado,
  revisionesDe,
  rutaDeContenido,
  versionDe,
} from '../src/contenido';
import { login } from '../src/login';
import { gotoConReintento } from '../src/nav';

/**
 * E2E-16 — aprobar un guion desde el chat: el asistente SOLO propone. El consultor (que prepara y propone)
 * pide «aprueba el guion de Valentina»; queda una propuesta `script_version.approve` pendiente, la versión
 * sigue SIN aprobar, y solo una persona con `script:approve` (director) la confirma desde la interfaz, con
 * la huella que ve. Auditoría `chat` → `ui` con correlación completa; repetir la confirmación no ejecuta
 * dos veces.
 */
test.describe.configure({ mode: 'serial' });
test.afterAll(async () => {
  await limpiarContenido();
});

const FRASE = 'aprueba el guion de Valentina';
const PEDIDO = `${FRASE} ${marcador('script_propose_approval', { versionId: 'V1', evidenceQuote: FRASE })}`;

test('E2E-16 — el consultor propone aprobar el guion desde el chat; el director lo confirma por la interfaz', async ({
  page,
}) => {
  test.setTimeout(300_000);
  const s = await escenarioDeContenido('e2e-16-chat-contenido');
  const { e, campaignId } = s;
  const { participacionId, deliverableId } = s.valentina;

  // Sembrado: V1 de «Reel principal» de Valentina, analizada contra el Brief aprobado con UN hallazgo
  // abierto (el modo del análisis falso va en el texto del guion). Queda `in_review` con revisión CURRENT.
  const v1 = await registrarGuionSembrado(s, deliverableId, participacionId, [
    'Hola a todos, hoy les muestro el nuevo P80 Pro con su cámara de 200 MP para fotos de día y de noche. [[fake:analisis cta_ausente]]',
    'Es perfecto para fotografía profesional y la batería dura todo el día.',
  ]);
  await login(page, e.consultor.email);
  await gotoConReintento(page, rutaDeContenido(campaignId, participacionId, deliverableId));
  await page.getByTestId('contenido-solicitar-analisis').click();
  await expect(page.getByTestId('contenido-analisis-ok')).toBeVisible({ timeout: 90_000 });
  expect(await estadoDeVersion(v1.versionId)).toBe('in_review');
  expect((await revisionesDe(v1.versionId)).map((r) => `${r.kind}:${r.status}:${r.finding_count}`)).toEqual([
    'ai_assisted:succeeded:1',
  ]);

  // ── 1. El consultor pide aprobar el guion en el chat ──
  await abrirChat(page, campaignId);
  await enviarMensaje(page, PEDIDO);
  await esperarRespuestas(page, 1);
  await esperarSinRunActivo(page);

  const [run] = await runsDe(campaignId);
  expect(run).toMatchObject({ status: 'completed', user_id: e.consultor.id });
  const tarjeta = page.getByTestId('chat-thread').getByTestId('chat-proposal');
  await expect(tarjeta).toHaveCount(1);
  await expect(tarjeta).toHaveAttribute('data-tipo', 'script_version.approve');
  await expect(tarjeta).toHaveAttribute('data-estado', 'pending');
  await expect(tarjeta).toHaveAttribute('data-obsoleta', 'false');
  await expect(tarjeta.getByTestId('chat-proposal-author')).toContainText('a través del asistente');
  // Advertencias legibles: el guion tiene un hallazgo abierto (informa, no bloquea).
  await expect(tarjeta.getByTestId('chat-proposal-warnings')).toBeVisible();
  await expect(tarjeta.getByTestId('chat-proposal-warnings')).toContainText('hallazgo');
  await expect(tarjeta.getByTestId('chat-proposal-text')).toContainText('versión 1');
  await expect(tarjeta.getByTestId('chat-proposal-text')).toContainText('Reel principal');
  await expect(tarjeta.getByTestId('chat-proposal-text')).toContainText('Valentina Ríos');
  // El consultor NO ve botón de confirmar (la aprobación es de dirección o administración); sí puede cancelar la suya.
  await expect(tarjeta.getByTestId('chat-proposal-other-role')).toBeVisible();
  await expect(tarjeta.getByTestId('chat-proposal-confirm')).toHaveCount(0);
  await expect(tarjeta.getByTestId('chat-proposal-cancel')).toBeVisible();
  const huellaMostrada = (await tarjeta.getByTestId('chat-proposal-fingerprint').textContent()) ?? '';
  expect(huellaMostrada).toMatch(/^[0-9a-f]{8}$/);

  // ── 2. Base ANTES de la confirmación humana: la versión sigue sin aprobar ──
  const propuestas = await propuestasDe(campaignId);
  expect(propuestas).toHaveLength(1);
  const propuesta = propuestas[0]!;
  expect(propuesta).toMatchObject({
    action_type: 'script_version.approve',
    status: 'pending',
    proposed_origin: 'chat',
    proposed_by: e.consultor.id,
    confirmed_by: null,
    resource_id: v1.versionId,
  });
  expect(propuesta.payload_hash.startsWith(huellaMostrada)).toBe(true);
  expect(await estadoDeVersion(v1.versionId)).toBe('in_review');
  const antes = await versionDe(deliverableId, 1);
  expect(antes).toMatchObject({
    approved_at: null,
    approved_by: null,
    approved_via_proposed_action_id: null,
  });
  expect(await contarAuditoriaDeCampana(campaignId, 'script_version.approve')).toBe(0);

  // Correlación COMPLETA usuario → conversación → mensaje → run → herramienta.
  const invocaciones = await invocacionesDe(campaignId);
  const inv = invocaciones.find((i) => i.tool_name === 'script_propose_approval')!;
  expect(inv).toMatchObject({
    risk_class: 'confirmation_required',
    status: 'succeeded',
    proposed_action_id: propuesta.id,
  });
  // Una sola llamada, y ninguna herramienta de aprobar/confirmar existe ni se invocó.
  expect(
    invocaciones.filter(
      (i) => /approve|confirm|execute/.test(i.tool_name) && i.tool_name !== 'script_propose_approval',
    ),
  ).toEqual([]);
  const [conversacion] = await conversacionesDe(campaignId);
  const mensajeUsuario = (await mensajesDe(campaignId)).find((m) => m.role === 'user')!;
  expect(propuesta.correlation).toMatchObject({
    conversationId: conversacion!.id,
    toolInvocationId: inv.id,
    messageId: mensajeUsuario.id,
    agentRunId: run!.id,
  });
  const propone = (await auditoriaDeEntidad(v1.versionId, propuesta.id)).filter(
    (a) => a.action === 'proposed_action.propose',
  );
  expect(propone).toHaveLength(1);
  expect(propone[0]).toMatchObject({ origin: 'chat', actor_id: e.consultor.id, entity_id: propuesta.id });
  expect(propone[0]!.correlation).toMatchObject({
    conversationId: conversacion!.id,
    proposedActionId: propuesta.id,
  });

  // ── 3. El director la ve en pendientes y confirma con la huella mostrada (doble clic) ──
  await login(page, e.director.email);
  await abrirChat(page, campaignId);
  const panel = page.getByTestId('chat-pending-panel');
  await expect(panel).toBeVisible();
  const tarjetaDirector = panel.getByTestId('chat-proposal');
  await expect(tarjetaDirector).toHaveCount(1);
  await expect(tarjetaDirector).toHaveAttribute('data-tipo', 'script_version.approve');
  await expect(tarjetaDirector.getByTestId('chat-proposal-warnings')).toContainText('hallazgo');
  await expect(tarjetaDirector.getByTestId('chat-proposal-fingerprint')).toHaveText(huellaMostrada);
  await tarjetaDirector.getByTestId('chat-proposal-confirm').click();
  const dialogo = page.getByTestId('chat-proposal-dialog');
  await expect(dialogo).toBeVisible();
  // Cancelar el diálogo no hace nada.
  await dialogo.getByTestId('chat-proposal-dialog-cancel').click();
  await expect(page.getByTestId('chat-proposal-dialog')).toHaveCount(0);
  expect(await estadoDeVersion(v1.versionId)).toBe('in_review');
  await tarjetaDirector.getByTestId('chat-proposal-confirm').click();
  await page.getByTestId('chat-proposal-dialog-confirm').dblclick();

  await expect.poll(() => estadoDeVersion(v1.versionId), { timeout: 30_000 }).toBe('approved');
  await expect
    .poll(async () => (await propuestasDe(campaignId))[0]!.status, { timeout: 30_000 })
    .toBe('executed');
  await expect(page.getByTestId('chat-pending-panel')).toHaveCount(0, { timeout: 20_000 });

  // ── 4. Base y auditoría: chat → ui con correlación; una sola aprobación ──
  const aprobada = await versionDe(deliverableId, 1);
  expect(aprobada).toMatchObject({
    status: 'approved',
    approved_by: e.director.id,
    approved_via_proposed_action_id: propuesta.id,
  });
  expect(aprobada.approved_at).not.toBeNull();
  const [ejecutada] = await propuestasDe(campaignId);
  expect(ejecutada).toMatchObject({ status: 'executed', confirmed_by: e.director.id });

  const auditoria = await auditoriaDeEntidad(v1.versionId, propuesta.id);
  const acciones = auditoria.map((a) => `${a.action}:${a.origin}`);
  expect(acciones).toEqual(
    expect.arrayContaining([
      'proposed_action.propose:chat',
      'proposed_action.confirm:ui',
      'script_version.approve:ui',
      'proposed_action.execute:ui',
    ]),
  );
  expect(acciones.filter((a) => a.startsWith('proposed_action.confirm'))).toHaveLength(1);
  expect(acciones.filter((a) => a.startsWith('proposed_action.execute'))).toHaveLength(1);
  expect(acciones.filter((a) => a.startsWith('script_version.approve'))).toHaveLength(1);
  const indice = (accion: string) => auditoria.findIndex((a) => a.action === accion);
  expect(indice('proposed_action.propose')).toBeLessThan(indice('proposed_action.confirm'));
  expect(indice('proposed_action.confirm')).toBeLessThan(indice('proposed_action.execute'));
  const aprobacion = auditoria.find((a) => a.action === 'script_version.approve')!;
  expect(aprobacion).toMatchObject({ origin: 'ui', actor_id: e.director.id, entity_id: v1.versionId });
  expect(aprobacion.correlation).toMatchObject({ proposedActionId: propuesta.id });
  expect(auditoria.find((a) => a.action === 'proposed_action.confirm')).toMatchObject({
    origin: 'ui',
    actor_id: e.director.id,
  });
  // Ninguna acción de origen `chat` confirma, ejecuta ni aprueba.
  expect(auditoria.filter((a) => a.origin === 'chat' && a.action !== 'proposed_action.propose')).toEqual([]);

  // ── 5. Replay: confirmar o ejecutar otra vez (UI o base) no vuelve a aprobar ──
  const reconfirmar = await confirmarAccion(e.director, propuesta.id, {
    canal: 'ui',
    payloadHash: propuesta.payload_hash,
  });
  expect(reconfirmar.ok).toBe(false);
  const reejecutar = await ejecutarAccion(e.director, propuesta.id, { canal: 'ui' });
  // Ejecutar una ya ejecutada es idempotente o rechazada, pero jamás repite el efecto.
  void reejecutar;
  expect(await contarAuditoriaDeCampana(campaignId, 'script_version.approve')).toBe(1);
  expect((await versionDe(deliverableId, 1)).approved_at).toBe(aprobada.approved_at);

  // ── 6. El consultor ve su propuesta ejecutada, sin acciones ──
  await login(page, e.consultor.email);
  await abrirChat(page, campaignId);
  const final = page.getByTestId('chat-thread').getByTestId('chat-proposal');
  await expect(final).toHaveAttribute('data-estado', 'executed');
  await expect(final.getByTestId('chat-proposal-confirm')).toHaveCount(0);
  await expect(final.getByTestId('chat-proposal-cancel')).toHaveCount(0);
});
