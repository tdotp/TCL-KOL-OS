import { expect, test } from '@playwright/test';
import { cargarActores, limpiarTodo, nuevaCampanaConBrief } from '../src/fixtures';
import { login } from '../src/login';
import { gotoConReintento } from '../src/nav';

test.describe('E2E-01 — feature flag apagado', () => {
  test('abrir /brief/workspace con BRIEF_WORKSPACE_V2=false reenvía limpio al editor anterior', async ({
    page,
  }) => {
    const { admin } = await cargarActores();
    const { campaignId } = await nuevaCampanaConBrief(admin, 'e2e-01-flag-apagado');

    await login(page, admin.email);
    await gotoConReintento(page, `/campanas/${campaignId}/brief/workspace?modo=revisar`);

    await expect(page).toHaveURL(new RegExp(`/campanas/${campaignId}/brief/editar$`));
    // Nunca un 404 ni una pantalla a medias — el editor de siempre carga completo.
    await expect(page.getByText('Brief workspace')).toBeVisible();
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();

    await limpiarTodo();
  });
});
