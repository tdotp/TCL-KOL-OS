/**
 * Conexión PRIVILEGIADA solo para pruebas (Release Readiness · Bloque 1).
 *
 * El rol de ejecución de la aplicación (`DATABASE_URL` / `TEST_DATABASE_URL`) ya no es superusuario ni dueño de las
 * tablas: no puede crear funciones ni triggers, ni `ALTER TABLE … DISABLE TRIGGER`, ni `TRUNCATE`, ni
 * `SET session_replication_role`. Algunas pruebas necesitan justo eso para INYECTAR FALLOS (un trigger que revienta a
 * mitad de una transacción) o para probar la capa de triggers por debajo de la de privilegios. Esas operaciones usan
 * este pool, que el código de producción nunca importa. Todo lo demás (el código bajo prueba y su SQL) usa el rol de
 * ejecución: así las pruebas no pasan gracias a privilegios que producción no tiene.
 *
 * `TEST_ADMIN_DATABASE_URL`: administrador de arranque (o dueño) de la MISMA base `_test`. Sin ella se usa
 * `DATABASE_URL` (compatibilidad con configuraciones antiguas donde ese rol era superusuario).
 */
import pg from 'pg';

const PATRON_BASE_DE_PRUEBAS = /\/[A-Za-z0-9_-]*_test(?:\?.*)?$/;

let pool: pg.Pool | undefined;

/** Pool de la conexión privilegiada de pruebas. Mismo candado INC-001A: solo bases `_test`. */
export function adminPool(): pg.Pool {
  if (pool !== undefined) return pool;
  const url = (process.env['TEST_ADMIN_DATABASE_URL'] ?? process.env['DATABASE_URL'] ?? '').trim();
  if (!PATRON_BASE_DE_PRUEBAS.test(url)) {
    throw new Error('test-admin: la conexión privilegiada solo puede apuntar a una base "_test" (INC-001A).');
  }
  pool = new pg.Pool({ connectionString: url, max: 4, idleTimeoutMillis: 2_000, allowExitOnIdle: true });
  return pool;
}

export async function closeAdminPool(): Promise<void> {
  if (pool !== undefined) {
    await pool.end();
    pool = undefined;
  }
}

/** Una conexión privilegiada dentro de una transacción (misma forma que `transaction` de `client.ts`). */
export async function adminTransaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await adminPool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
