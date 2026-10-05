/**
 * Conexión a PostgreSQL.
 *
 * Un solo pool por proceso. La configuración viene del entorno; no hay valores
 * por defecto que apunten a una base real (§27).
 */

import pg from 'pg';

const { Pool } = pg;

let pool: pg.Pool | undefined;

export function getPool(): pg.Pool {
  if (pool !== undefined) return pool;

  const connectionString = process.env['DATABASE_URL'];
  if (connectionString === undefined || connectionString.trim() === '') {
    throw new Error('Falta DATABASE_URL. Consulte .env.example en la raíz del repositorio.');
  }

  // Sin `connectionTimeoutMillis` un pool agotado deja las peticiones colgadas para siempre; con él falla limpio
  // (y el resultado es un error, no un cuelgue). 30 s sobra para una espera normal de turno.
  pool = new Pool({ connectionString, max: 10, connectionTimeoutMillis: 30_000 });
  return pool;
}

export async function closePool(): Promise<void> {
  if (pool !== undefined) {
    await pool.end();
    pool = undefined;
  }
}

/** Ejecuta una consulta y devuelve las filas tipadas. */
export async function query<T extends pg.QueryResultRow>(
  text: string,
  params: readonly unknown[] = [],
): Promise<T[]> {
  const result = await getPool().query<T>(text, params as unknown[]);
  return result.rows;
}

/** Ejecuta una consulta que devuelve como mucho una fila. */
export async function queryOne<T extends pg.QueryResultRow>(
  text: string,
  params: readonly unknown[] = [],
): Promise<T | undefined> {
  const rows = await query<T>(text, params);
  return rows[0];
}

/**
 * Ejecuta varias operaciones en una transacción.
 *
 * Se usa para que una mutación y su `AuditEvent` sean atómicos: si el registro
 * de auditoría falla, la mutación se deshace (§10.3, regla 4).
 */
export async function transaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
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
