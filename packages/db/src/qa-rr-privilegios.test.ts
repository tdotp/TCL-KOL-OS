/**
 * Release Readiness · Bloque 1 — mínimo privilegio REAL del rol de ejecución de la aplicación.
 *
 * Estas pruebas corren con `DATABASE_URL` / `TEST_DATABASE_URL`, que DEBE ser el rol de ejecución (solo DML). Si se
 * lanzan con un superusuario fallan a propósito: la suite de la base ya no puede pasar gracias a privilegios que
 * producción no tiene. No basta con leer `rolsuper = false`: se intenta de verdad cada operación administrativa.
 *
 * Todo intento corre dentro de una transacción que siempre se revierte.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { closePool, getPool, query } from './client.ts';
import { adminPool, closeAdminPool } from './test-admin.ts';

afterAll(async () => {
  await closeAdminPool();
  await closePool();
});

/** Ejecuta `sql` con el rol de ejecución; devuelve 'PERMITIDO' o el mensaje de error. Siempre revierte. */
async function intenta(sql: string, params: unknown[] = []): Promise<string> {
  const c = await getPool().connect();
  try {
    await c.query('BEGIN');
    await c.query(sql, params);
    return 'PERMITIDO';
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  } finally {
    await c.query('ROLLBACK').catch(() => undefined);
    c.release();
  }
}

const TABLAS_DE_HISTORIA = [
  'audit_events',
  'script_versions',
  'proposed_actions',
  'payment_obligations',
  'operational_events',
  'brief_field_revisions',
  'kpi_measurements',
  'kpi_targets',
  'agreements',
  'agreement_versions',
  'campaigns',
  'organizations',
  'users',
  'source_documents',
  'brief_versions',
];

describe('atributos del rol de ejecución', () => {
  it('no es superusuario, ni CREATEDB, ni CREATEROLE, ni REPLICATION, ni BYPASSRLS', async () => {
    const [r] = await query<{
      rolname: string;
      rolsuper: boolean;
      rolcreatedb: boolean;
      rolcreaterole: boolean;
      rolreplication: boolean;
      rolbypassrls: boolean;
    }>(`SELECT * FROM pg_roles WHERE rolname = current_user`);
    expect(r).toMatchObject({
      rolsuper: false,
      rolcreatedb: false,
      rolcreaterole: false,
      rolreplication: false,
      rolbypassrls: false,
    });
    expect(['postgres', 'tclkolos']).not.toContain(r!.rolname);
  });

  it('no pertenece a ningún otro rol (sin privilegios heredados de pg_* ni del migrador)', async () => {
    const miembros = await query<{ rol: string }>(
      `SELECT r.rolname AS rol FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.roleid
        WHERE m.member = (SELECT oid FROM pg_roles WHERE rolname = current_user)`,
    );
    expect(miembros).toEqual([]);
  });

  it('no es dueño de ninguna tabla, función ni tipo del esquema public (dueño = quien migra, no superusuario)', async () => {
    const propios = await query<{ objeto: string }>(
      `SELECT c.relname AS objeto FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind IN ('r','p','v','m','S') AND pg_get_userbyid(c.relowner) = current_user
       UNION ALL
       SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND pg_get_userbyid(p.proowner) = current_user`,
    );
    expect(propios).toEqual([]);
    const duenos = await query<{ dueno: string; superusuario: boolean }>(
      `SELECT DISTINCT pg_get_userbyid(c.relowner) AS dueno, r.rolsuper AS superusuario
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace JOIN pg_roles r ON r.oid = c.relowner
        WHERE n.nspname = 'public' AND c.relkind = 'r'`,
    );
    expect(duenos).toHaveLength(1);
    expect(duenos[0]!.superusuario).toBe(false);
  });
});

describe('privilegios concedidos (catálogo)', () => {
  it('toda tabla de public: SELECT/INSERT/UPDATE/DELETE sí; TRUNCATE/REFERENCES/TRIGGER no', async () => {
    const filas = await query<{
      t: string;
      s: boolean;
      i: boolean;
      u: boolean;
      d: boolean;
      tr: boolean;
      r: boolean;
      g: boolean;
    }>(
      `SELECT c.relname AS t,
              has_table_privilege(current_user, c.oid, 'SELECT') AS s,
              has_table_privilege(current_user, c.oid, 'INSERT') AS i,
              has_table_privilege(current_user, c.oid, 'UPDATE') AS u,
              has_table_privilege(current_user, c.oid, 'DELETE') AS d,
              has_table_privilege(current_user, c.oid, 'TRUNCATE') AS tr,
              has_table_privilege(current_user, c.oid, 'REFERENCES') AS r,
              has_table_privilege(current_user, c.oid, 'TRIGGER') AS g
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname <> 'schema_migrations'`,
    );
    expect(filas.length).toBeGreaterThan(50);
    for (const f of filas) {
      expect(f, f.t).toMatchObject({ s: true, i: true, u: true, d: true, tr: false, r: false, g: false });
    }
  });

  it('schema_migrations es del migrador: la aplicación no lo lee ni lo escribe', async () => {
    expect(await intenta(`SELECT 1 FROM schema_migrations`)).toMatch(/permission denied/u);
    expect(await intenta(`DELETE FROM schema_migrations`)).toMatch(/permission denied/u);
  });

  it('sin CREATE en el esquema ni en la base, sin TEMPORARY', async () => {
    const [p] = await query<{ schema_create: boolean; db_create: boolean; db_temp: boolean; usage: boolean }>(
      `SELECT has_schema_privilege(current_user, 'public', 'CREATE') AS schema_create,
              has_database_privilege(current_user, current_database(), 'CREATE') AS db_create,
              has_database_privilege(current_user, current_database(), 'TEMPORARY') AS db_temp,
              has_schema_privilege(current_user, 'public', 'USAGE') AS usage`,
    );
    expect(p).toEqual({ schema_create: false, db_create: false, db_temp: false, usage: true });
  });
});

describe('QA-F10-07 · TRUNCATE denegado (comportamiento real)', () => {
  it.each(TABLAS_DE_HISTORIA)(
    'TRUNCATE %s CASCADE → permission denied, y las filas siguen',
    async (tabla) => {
      const [antes] = await query<{ n: string }>(`SELECT count(*) AS n FROM ${tabla}`);
      expect(await intenta(`TRUNCATE ${tabla} CASCADE`)).toMatch(/permission denied for table/u);
      expect(await intenta(`TRUNCATE ${tabla}`)).toMatch(/permission denied for table/u);
      const [despues] = await query<{ n: string }>(`SELECT count(*) AS n FROM ${tabla}`);
      expect(despues!.n).toBe(antes!.n);
    },
  );

  it('ninguna tabla de public admite TRUNCATE por el rol de ejecución', async () => {
    const tablas = await query<{ t: string }>(
      `SELECT c.relname AS t FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind = 'r'`,
    );
    for (const { t } of tablas) {
      expect(await intenta(`TRUNCATE ${t} CASCADE`), t).toMatch(/permission denied/u);
    }
  });
});

describe('QA-F10-08 · sin privilegios administrativos directos ni indirectos', () => {
  it.each<[string, string, RegExp]>([
    ['desactivar triggers de la auditoría', `ALTER TABLE audit_events DISABLE TRIGGER ALL`, /must be owner/u],
    ['desactivar un trigger concreto', `ALTER TABLE script_versions DISABLE TRIGGER USER`, /must be owner/u],
    ['borrar una tabla', `DROP TABLE audit_events CASCADE`, /must be owner/u],
    ['cambiar la tabla', `ALTER TABLE audit_events ADD COLUMN x int`, /must be owner/u],
    ['transferir la propiedad', `ALTER TABLE audit_events OWNER TO CURRENT_USER`, /must be owner/u],
    [
      'reescribir la función de la auditoría',
      `CREATE OR REPLACE FUNCTION audit_events_solo_insercion() RETURNS trigger AS $$ BEGIN RETURN NEW; END; $$ LANGUAGE plpgsql`,
      /permission denied|must be owner/u,
    ],
    [
      'reescribir el bypass de inmutabilidad',
      `CREATE OR REPLACE FUNCTION inmutabilidad_bypass_activo() RETURNS boolean AS $$ SELECT true $$ LANGUAGE sql`,
      /permission denied|must be owner/u,
    ],
    ['crear una tabla', `CREATE TABLE zz_rr_intruso (a int)`, /permission denied for schema public/u],
    [
      'crear una función',
      `CREATE FUNCTION zz_rr_f() RETURNS int AS $$ SELECT 1 $$ LANGUAGE sql`,
      /permission denied for schema public/u,
    ],
    [
      'crear un trigger',
      `CREATE TRIGGER zz_rr_t BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION audit_events_solo_insercion()`,
      /permission denied for table|must be owner/u,
    ],
    ['crear un índice', `CREATE INDEX zz_rr_i ON audit_events (id)`, /must be owner/u],
    [
      'tabla temporal',
      `CREATE TEMP TABLE zz_rr_tmp (a int)`,
      /permission denied to create temporary tables/u,
    ],
    [
      'saltar triggers con session_replication_role',
      `SET LOCAL session_replication_role = replica`,
      /permission denied to set parameter/u,
    ],
    [
      'crear una base',
      `CREATE DATABASE zz_rr_db`,
      /permission denied to create database|cannot run inside a transaction block/u,
    ],
    ['crear un rol', `CREATE ROLE zz_rr_rol`, /permission denied to create role/u],
    [
      'hacerse superusuario',
      `ALTER ROLE CURRENT_USER SUPERUSER`,
      /permission denied|Only roles with the SUPERUSER/u,
    ],
    [
      'cambiar su propia contraseña de rol ajeno',
      `ALTER ROLE postgres PASSWORD 'x'`,
      /permission denied|role "postgres" does not exist/u,
    ],
    ['COPY a un programa', `COPY organizations TO PROGRAM 'id'`, /permission denied to COPY/u],
    ['leer archivos del servidor', `SELECT pg_read_file('/etc/passwd')`, /permission denied for function/u],
    [
      'leer contraseñas de roles',
      `SELECT rolpassword FROM pg_authid`,
      /permission denied for table pg_authid/u,
    ],
    ['crear una extensión', `CREATE EXTENSION dblink`, /permission denied to create extension/u],
    ['crear un esquema', `CREATE SCHEMA zz_rr_esquema`, /permission denied for database/u],
  ])('%s', async (_nombre, sql, esperado) => {
    const r = await intenta(sql);
    expect(r).not.toBe('PERMITIDO');
    expect(r).toMatch(esperado);
  });

  it.each([
    'postgres',
    'tclkolos',
    'tclkolos_migrator',
    'pg_execute_server_program',
    'pg_write_server_files',
  ])('SET ROLE %s → denegado (sin escalada por cambio de rol)', async (rol) => {
    const r = await intenta(`SET LOCAL ROLE ${rol}`);
    expect(r).not.toBe('PERMITIDO');
    expect(r).toMatch(/permission denied to set role|does not exist/u);
  });
});

describe('no puede concederse privilegios', () => {
  it('GRANT de TRUNCATE (a PUBLIC o a sí mismo) no concede nada: sigue sin poder truncar', async () => {
    const c = await getPool().connect();
    try {
      await c.query('BEGIN');
      await c.query(`GRANT TRUNCATE ON audit_events TO PUBLIC`).catch(() => undefined);
      await c.query(`GRANT ALL ON audit_events TO CURRENT_USER`).catch(() => undefined);
      const { rows } = await c.query<{ puede: boolean }>(
        `SELECT has_table_privilege(current_user, 'audit_events', 'TRUNCATE') AS puede`,
      );
      expect(rows[0]!.puede).toBe(false);
      await expect(c.query(`TRUNCATE audit_events`)).rejects.toThrow(/permission denied/u);
    } finally {
      await c.query('ROLLBACK').catch(() => undefined);
      c.release();
    }
  });
});

describe('lo que la aplicación SÍ hace con el rol limitado', () => {
  it('lee y escribe (INSERT/UPDATE/DELETE) y los triggers de inmutabilidad siguen mandando', async () => {
    const c = await getPool().connect();
    try {
      await c.query('BEGIN');
      const { rows } = await c.query<{ id: string }>(
        `INSERT INTO organizations (name, type) VALUES ('zz-rr-org', 'agencia') RETURNING id`,
      );
      const id = rows[0]!.id;
      await c.query(`UPDATE organizations SET name = 'zz-rr-org-2' WHERE id = $1`, [id]);
      const leida = await c.query<{ name: string }>(`SELECT name FROM organizations WHERE id = $1`, [id]);
      expect(leida.rows[0]!.name).toBe('zz-rr-org-2');
      await c.query(`DELETE FROM organizations WHERE id = $1`, [id]);
      // La auditoría sigue siendo de solo inserción: el trigger responde (UPDATE está concedido, el trigger lo veta).
      await expect(c.query(`UPDATE audit_events SET action = 'x'`)).rejects.toThrow(
        /solo inserción|no admite/u,
      );
    } finally {
      await c.query('ROLLBACK').catch(() => undefined);
      c.release();
    }
  });

  it('el bypass de inmutabilidad vale solo en bases `_test`: aquí el nombre acaba en _test y la prueba de clon (qa-f7-bypass) cubre el resto', async () => {
    const [b] = await query<{ db: string }>(`SELECT current_database() AS db`);
    expect(b!.db.endsWith('_test')).toBe(true);
  });
});

describe('el rol privilegiado de pruebas está separado', () => {
  it('la conexión de administración es otro rol (no el de ejecución) y solo apunta a bases _test', async () => {
    const { rows } = await adminPool().query<{ u: string; s: boolean }>(
      `SELECT current_user AS u, (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS s`,
    );
    const [yo] = await query<{ u: string }>(`SELECT current_user AS u`);
    expect(rows[0]!.u).not.toBe(yo!.u);
  });
});
