import { expect, test } from '@playwright/test';
import { cargarActores, limpiarTodo, nuevaCampanaConBrief } from '../src/fixtures';
import { abrirChat, contarConversaciones, mensajesDe, runsDe } from '../src/chat';
import { login } from '../src/login';
import { gotoConReintento } from '../src/nav';

/**
 * E2E-15a — IA apagada (`AI_ENABLED=false`, puerto 3013): el chat se muestra pero no deja enviar, y no se
 * crea nada. (El kill-switch también se aplica en el servidor al admitir el turno: pruebas de `packages/agent`.)
 */
test.describe.configure({ mode: 'serial' });
test.afterAll(async () => {
  await limpiarTodo();
});

test('E2E-15a — con la IA apagada el chat muestra el aviso y no permite enviar ni adjuntar', async ({
  page,
}) => {
  test.setTimeout(90_000);
  const { admin, consultor, director } = await cargarActores();
  const { campaignId } = await nuevaCampanaConBrief(admin, 'e2e-15a-ia-apagada');

  for (const usuario of [consultor, director]) {
    await login(page, usuario.email);
    await abrirChat(page, campaignId);
    await expect(page.getByTestId('chat-ai-off')).toBeVisible();
    await expect(page.getByTestId('chat-ai-off')).toContainText('apagado');
    await expect(page.getByTestId('chat-ai-unconfigured')).toHaveCount(0);

    // No se puede escribir ni enviar ni adjuntar; el cuadro explica por qué.
    await expect(page.getByTestId('chat-input')).toBeDisabled();
    await expect(page.getByTestId('chat-input')).toHaveAttribute('placeholder', /desactivada/);
    await expect(page.getByTestId('chat-send')).toBeDisabled();
    await expect(page.getByTestId('chat-attach-input')).toBeDisabled();
    // Pero la pantalla sigue siendo navegable: hilo vacío y enlace de la campaña.
    await expect(page.getByTestId('chat-thread')).toBeVisible();
    await gotoConReintento(page, `/campanas/${campaignId}`);
    await expect(page.getByTestId('chat-nav-link')).toBeVisible();
  }

  // Nada se escribió: ni conversación, ni mensajes, ni runs.
  expect(await contarConversaciones(campaignId)).toBe(0);
  expect(await mensajesDe(campaignId)).toHaveLength(0);
  expect(await runsDe(campaignId)).toHaveLength(0);
});
