/**
 * Candado de base de pruebas (INC-001A).
 *
 * El 25 de agosto de 2026, una suite de pruebas reescrita reutilizó (vía
 * `obtenerOCrearVersionDeTrabajo`, DEC-024) y luego borró en su limpieza una
 * versión real y no terminal del brief de P80 — de una extracción genuina
 * hecha en una sesión anterior — porque las pruebas corrían contra la MISMA
 * base de desarrollo que usa la aplicación normal. Ver
 * `docs/incidents/INC-001-test-data-collision.md`.
 *
 * Este archivo se ejecuta antes de cada archivo de prueba (`setupFiles`) y
 * es la única puerta: exige `TEST_DATABASE_URL`, verifica que su nombre de
 * base sea explícitamente de pruebas, y solo entonces lo usa como
 * `DATABASE_URL` para esa corrida. Sin fallback silencioso hacia
 * `DATABASE_URL` — si `TEST_DATABASE_URL` falta o el nombre no cuadra, la
 * suite se niega a arrancar.
 *
 * Este candado vive únicamente aquí, en la configuración de pruebas de
 * `packages/db`. `packages/db/src/client.ts` no cambia: la aplicación normal
 * (`apps/web`, el worker) sigue leyendo `DATABASE_URL` tal cual, sin saber
 * que `TEST_DATABASE_URL` existe.
 */

/** El nombre de la base debe declarar explícitamente que es de pruebas. */
const PATRON_BASE_DE_PRUEBAS = /\/[A-Za-z0-9_-]*_test(?:\?.*)?$/;

function nombreDeBase(url: string): string {
  try {
    return new URL(url).pathname.replace(/^\//, '');
  } catch {
    return '';
  }
}

const testUrl = process.env['TEST_DATABASE_URL']?.trim();

if (!testUrl) {
  throw new Error(
    'INC-001A: falta TEST_DATABASE_URL. Las pruebas de packages/db nunca corren contra ' +
      'DATABASE_URL (la base de desarrollo normal) — defina TEST_DATABASE_URL apuntando a ' +
      'una base cuyo nombre termine en "_test" (ver .env.example).',
  );
}

if (!PATRON_BASE_DE_PRUEBAS.test(testUrl)) {
  throw new Error(
    `INC-001A: TEST_DATABASE_URL apunta a una base llamada "${nombreDeBase(testUrl)}", que no ` +
      'parece una base de pruebas (debe terminar en "_test"). Se rechaza para no arriesgar ' +
      'correr las pruebas contra una base real por error.',
  );
}

// A partir de aquí, y solo para este proceso de prueba, `DATABASE_URL` es
// `TEST_DATABASE_URL`. `client.ts` lo lee tal cual, sin saber la diferencia.
process.env['DATABASE_URL'] = testUrl;
