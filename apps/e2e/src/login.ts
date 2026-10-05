import { createHmac } from 'node:crypto';
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

/** Secreto de sesión de prueba de los servidores del chat (el mismo de `playwright.config.ts`). */
const SESSION_SECRET_CHAT = 'e2e-session-secret-no-es-real-0123456789';

/**
 * Sesión para un usuario sembrado que el selector del login de desarrollo NO ofrece (p. ej. operativo).
 * Firma la cookie con el secreto de prueba de los servidores del chat, con el mismo formato que
 * `buildSessionValue` (`id.expira.firma`). Solo sirve contra los puertos del chat (3012–3014).
 */
export async function loginPorCookie(page: Page, userId: string): Promise<void> {
  const expira = Date.now() + 60 * 60 * 1000;
  const payload = `${userId}.${expira}`;
  const firma = createHmac('sha256', SESSION_SECRET_CHAT).update(payload).digest('base64url');
  await page.context().clearCookies();
  await page
    .context()
    .addCookies([{ name: 'tclkolos_session', value: `${payload}.${firma}`, domain: 'localhost', path: '/' }]);
}
