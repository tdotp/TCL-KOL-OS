-- Privilegios de UNA base (idempotente). Se ejecuta como el administrador, conectado a la base de destino, DESPUÉS de
-- crear las extensiones (infra/db/init/01-extensions.sql) y de crear los roles (01-roles.sql). Es seguro repetirlo:
-- también «adopta» una base creada antes de este modelo (tablas del administrador) y se repite tras cada migración.
--
-- Variables de psql: -v migrator_user=… -v app_user=…
--
--   · El MIGRADOR es dueño de la base, del esquema y de todos los objetos: solo él puede alterar tablas.
--   · La APLICACIÓN NO es dueña de nada. El dueño de una tabla puede `ALTER TABLE … DISABLE TRIGGER`, `TRUNCATE` y
--     `DROP`: las garantías de inmutabilidad (triggers) valen solo si el rol de ejecución no es dueño ni superusuario.
--   · La aplicación recibe SELECT/INSERT/UPDATE/DELETE sobre las tablas. Nada de TRUNCATE, REFERENCES, TRIGGER ni
--     CREATE. UPDATE/DELETE se conservan en todas las tablas a propósito: las funciones de trigger se ejecutan con
--     los privilegios de QUIEN ESCRIBE (ninguna es SECURITY DEFINER), así que estrechar por tabla a partir del código
--     de la aplicación rompería escrituras hechas por triggers; las tablas de historia las protegen sus triggers.
\set ON_ERROR_STOP on
SET client_min_messages = warning;

-- ── Base de datos ───────────────────────────────────────────────────────────────────────────────────────────────
SELECT format('ALTER DATABASE %I OWNER TO %I', current_database(), :'migrator_user') \gexec
SELECT format('REVOKE ALL ON DATABASE %I FROM PUBLIC', current_database()) \gexec
SELECT format('GRANT CONNECT ON DATABASE %I TO %I', current_database(), :'app_user') \gexec
-- Sin TEMPORARY para la aplicación (ninguna consulta crea tablas temporales): `REVOKE … FROM PUBLIC` ya lo quita.

-- ── Esquema public ──────────────────────────────────────────────────────────────────────────────────────────────
-- En PG ≥ 15 el esquema public pertenece a pg_database_owner (= el migrador, dueño de la base).
REVOKE ALL ON SCHEMA public FROM PUBLIC;
SELECT format('GRANT USAGE ON SCHEMA public TO %I', :'app_user') \gexec
-- La aplicación no puede crear objetos en public (sin CREATE).

-- ── Propiedad: todo objeto de usuario pasa al migrador (las extensiones conservan su dueño) ──────────────────────
-- psql no interpola variables dentro de $$…$$: el nombre del migrador viaja en un parámetro de sesión.
SELECT set_config('tclkolos.migrador', :'migrator_user', false) \gset

DO $$
DECLARE
  migrador text := current_setting('tclkolos.migrador');
  o record;
BEGIN
  FOR o IN
    SELECT c.oid, c.relkind, format('%I.%I', n.nspname, c.relname) AS nombre
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relkind IN ('r', 'p', 'v', 'm', 'S')
       AND pg_get_userbyid(c.relowner) <> migrador
       -- una secuencia de IDENTITY o SERIAL cambia de dueño con su tabla: se omite (ALTER SEQUENCE falla si es propia)
       AND NOT (c.relkind = 'S' AND EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = c.oid AND d.deptype IN ('i', 'a')))
       AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = c.oid AND d.deptype = 'e')
  LOOP
    EXECUTE format('ALTER %s %s OWNER TO %I',
      CASE o.relkind WHEN 'S' THEN 'SEQUENCE' WHEN 'v' THEN 'VIEW' WHEN 'm' THEN 'MATERIALIZED VIEW' ELSE 'TABLE' END,
      o.nombre, migrador);
  END LOOP;

  FOR o IN
    SELECT p.oid, format('%I.%I(%s)', n.nspname, p.proname, pg_get_function_identity_arguments(p.oid)) AS nombre,
           p.prokind
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND pg_get_userbyid(p.proowner) <> migrador
       AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e')
  LOOP
    EXECUTE format('ALTER %s %s OWNER TO %I',
      CASE o.prokind WHEN 'p' THEN 'PROCEDURE' ELSE 'FUNCTION' END, o.nombre, migrador);
  END LOOP;

  FOR o IN
    SELECT t.oid, format('%I.%I', n.nspname, t.typname) AS nombre
      FROM pg_type t
      JOIN pg_namespace n ON n.oid = t.typnamespace
     WHERE n.nspname = 'public'
       AND t.typtype IN ('e', 'd')
       AND pg_get_userbyid(t.typowner) <> migrador
       AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = t.oid AND d.deptype = 'e')
  LOOP
    EXECUTE format('ALTER TYPE %s OWNER TO %I', o.nombre, migrador);
  END LOOP;
END
$$;

-- ── Privilegios de la aplicación sobre las tablas existentes ────────────────────────────────────────────────────
SELECT format('REVOKE ALL ON ALL TABLES IN SCHEMA public FROM %I', :'app_user') \gexec
SELECT format('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO %I', :'app_user') \gexec
-- Las secuencias de IDENTITY no necesitan USAGE para INSERT; si en el futuro hay una SERIAL/SEQUENCE propia, se
-- concede en su migración. Ninguna se concede por comodidad.
SELECT format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM %I', :'app_user') \gexec

-- El registro de migraciones es del migrador: la aplicación no lo lee ni lo escribe. Se crea AQUÍ (misma definición que
-- `migrate.ts`, que usa IF NOT EXISTS) para que nazca sin los privilegios por defecto de las tablas futuras.
CREATE TABLE IF NOT EXISTS schema_migrations (
  version     text PRIMARY KEY,
  applied_at  timestamptz NOT NULL DEFAULT now()
);
SELECT format('ALTER TABLE schema_migrations OWNER TO %I', :'migrator_user') \gexec
SELECT format('REVOKE ALL ON schema_migrations FROM %I', :'app_user') \gexec

-- ── Tablas FUTURAS: lo que cree el migrador nace con el mismo DML para la aplicación (y sin nada más) ───────────
SELECT format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO %I',
               :'migrator_user', :'app_user') \gexec
-- EXECUTE sobre las funciones se deja en su valor por defecto (PUBLIC): los triggers llaman a funciones auxiliares
-- con los privilegios de quien escribe (p. ej. `inmutabilidad_bypass_activo()`), y quitarlo rompería escrituras.
