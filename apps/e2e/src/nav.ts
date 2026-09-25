import type { Page, Response } from '@playwright/test';

/**
 * `page.goto` con un reintento — solo para el servidor de desarrollo.
 *
 * Se observó, de forma reproducible corriendo la suite completa (nunca un
 * archivo aislado), que la PRIMERA vez que una ruta se compila bajo demanda
 * en `next dev` mientras esa misma petición sigue en vuelo, la conexión a
 * veces se aborta (`net::ERR_ABORTED`) en vez de simplemente esperar — un
 * problema conocido de compilación bajo demanda de `next dev`, no del
 * workspace ni de ninguna regla de dominio. Nunca ocurre en un segundo
 * intento, porque la ruta ya quedó compilada del primero.
 */
export async function gotoConReintento(page: Page, url: string): Promise<Response | null> {
  for (let intento = 1; intento <= 2; intento += 1) {
    try {
      return await page.goto(url);
    } catch (error) {
      if (intento === 2) throw error;
    }
  }
  return null;
}
