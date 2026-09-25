import type { Page } from '@playwright/test';

/**
 * Mismo flujo de acceso real (`AUTH_PROVIDER=dev`) que usa la aplicación —
 * nunca un atajo que salte la sesión real.
 *
 * Reintenta una vez: se observó, solo cuando `/campanas` se compila por
 * primera vez en el servidor de desarrollo justo durante el primer login de
 * un archivo `.spec.ts` (webpack on-demand, no algo de producción), que
 * `currentUser()` puede fallar esa única vez y la página vuelve a `/login`
 * en vez de seguir a `/campanas` — nunca ocurrió en un segundo intento, ni
 * ocurre nunca una vez la ruta ya está compilada (el resto de las pruebas
 * de un mismo archivo no lo necesitan).
 */
export async function login(page: Page, email: string): Promise<void> {
  for (let intento = 1; intento <= 2; intento += 1) {
    await page.goto('/login');
    await page.selectOption('#email', { value: email });
    await page.getByRole('button', { name: /Entrar/ }).click();
    try {
      await page.waitForURL((u) => u.pathname !== '/login', { timeout: 15_000 });
      return;
    } catch (error) {
      if (intento === 2) throw error;
    }
  }
}
