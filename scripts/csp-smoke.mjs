/* global window, document -- se ejecutan dentro del navegador (page.evaluate / addInitScript) */
// Smoke de la CSP de producción con Chrome real: recorre las rutas principales con cada rol y falla si el navegador
// reporta una violación (`securitypolicyviolation`) o si falta la cabecera. Requiere `next start` con AUTH_PROVIDER=dev
// (solo para este smoke local) y una base sembrada.
//
//   BASE=http://localhost:3020 CAMPANA=<id de campaña> node scripts/csp-smoke.mjs
//
// Release Readiness · Bloque 1. No sustituye al harness de producción de un bloque posterior (E2E de seguridad completos).
import { chromium } from 'playwright-core';

const BASE = process.env.BASE ?? 'http://localhost:3020';
const CAMPANA = process.env.CAMPANA;
if (!CAMPANA) throw new Error('Falta CAMPANA (id de una campaña sembrada).');

const browser = await chromium.launch({ channel: 'chrome' });
let fallos = 0;

async function recorrer(usuario, rutas) {
  const page = await (await browser.newContext()).newPage();
  await page.addInitScript(() => {
    window.__csp = [];
    document.addEventListener('securitypolicyviolation', (e) =>
      window.__csp.push(`${e.violatedDirective} :: ${e.blockedURI} :: ${(e.sample ?? '').slice(0, 80)}`),
    );
  });
  await page.goto(`${BASE}/login`);
  await page.selectOption('#email', usuario);
  await page.click('button[type=submit]');
  await page.waitForLoadState('networkidle');
  for (const ruta of rutas) {
    const resp = await page.goto(`${BASE}${ruta}`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(300);
    const violaciones = await page.evaluate(() => window.__csp.splice(0));
    const csp = resp?.headers()['content-security-policy'] ?? '';
    const ok = violaciones.length === 0 && /script-src 'self' 'nonce-/.test(csp) && !/unsafe-eval/.test(csp);
    if (!ok) fallos += 1;
    console.log(
      `${ok ? 'OK  ' : 'FAIL'} ${usuario.padEnd(20)} ${String(resp?.status()).padEnd(4)} ${ruta}`,
      violaciones,
    );
  }
}

await recorrer('gerardo@smartpr.co', [
  '/campanas',
  '/campanas/nueva',
  `/campanas/${CAMPANA}`,
  `/campanas/${CAMPANA}/brief`,
  `/campanas/${CAMPANA}/brief/editar`,
  `/campanas/${CAMPANA}/fuentes`,
  `/campanas/${CAMPANA}/chat`,
  `/campanas/${CAMPANA}/contenido`,
  `/campanas/${CAMPANA}/operacion`,
  '/ruta-que-no-existe',
  '/login',
]);
await recorrer('marena@tcl.com', ['/tcl', `/tcl/campanas/${CAMPANA}`]);
await browser.close();
if (fallos > 0) {
  console.error(`${fallos} ruta(s) con violación de CSP o sin cabecera.`);
  process.exit(1);
}
console.log('CSP de producción: 0 violaciones.');
