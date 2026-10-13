/**
 * Ejecutor de migraciones.
 *
 * Migraciones versionadas y aplicadas en orden, registradas en `schema_migrations`
 * (§27: migraciones versionadas). Cada archivo corre dentro de una transacción:
 * una migración a medias no existe.
 *
 *   npm run migrate --workspace @tcl-kol-os/db
 *
 * Rol: `MIGRATION_DATABASE_URL` (migrador) si está definida; si no, `DATABASE_URL`.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { closePool, getPool, query } from './client.ts';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../../infra/db/migrations');

async function ensureMigrationsTable(): Promise<void> {
  await query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version     text PRIMARY KEY,
      applied_at  timestamptz NOT NULL DEFAULT now()
    )
  `);
}

async function appliedVersions(): Promise<Set<string>> {
  const rows = await query<{ version: string }>('SELECT version FROM schema_migrations');
  return new Set(rows.map((r) => r.version));
}

export async function migrate(): Promise<{ applied: string[]; skipped: string[] }> {
  await ensureMigrationsTable();
  const already = await appliedVersions();

  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  const applied: string[] = [];
  const skipped: string[] = [];
  const pool = getPool();

  for (const file of files) {
    const version = file.replace(/\.sql$/, '');
    if (already.has(version)) {
      skipped.push(version);
      continue;
    }

    const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [version]);
      await client.query('COMMIT');
      applied.push(version);
    } catch (error) {
      await client.query('ROLLBACK');
      throw new Error(`La migración ${version} falló y se revirtió: ${(error as Error).message}`);
    } finally {
      client.release();
    }
  }

  return { applied, skipped };
}

const isMain = process.argv[1] !== undefined && process.argv[1].endsWith('migrate.ts');
if (isMain) {
  // Release Readiness · Bloque 1: las migraciones las ejecuta el rol MIGRADOR (dueño del esquema, sin SUPERUSER), no el
  // rol de la aplicación (solo DML). `MIGRATION_DATABASE_URL` lo señala; sin ella se usa `DATABASE_URL` (compatibilidad).
  const urlDelMigrador = process.env['MIGRATION_DATABASE_URL']?.trim();
  if (urlDelMigrador) process.env['DATABASE_URL'] = urlDelMigrador;
  try {
    const { applied, skipped } = await migrate();
    for (const v of skipped) console.log(`  = ${v} (ya aplicada)`);
    for (const v of applied) console.log(`  + ${v} aplicada`);
    console.log(
      applied.length === 0 ? 'Base de datos al día.' : `${applied.length} migración(es) aplicada(s).`,
    );
  } catch (error) {
    console.error(`Error: ${(error as Error).message}`);
    process.exitCode = 1;
  } finally {
    await closePool();
  }
}
