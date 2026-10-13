-- Roles del clúster (idempotente). Se ejecuta como el administrador de arranque (superusuario del contenedor).
--
-- Modelo de tres roles (Release Readiness · Bloque 1; no es una migración: es infraestructura):
--
--   administrador   (POSTGRES_USER)  Solo arranque: crea roles, bases y extensiones. NINGUNA aplicación lo usa.
--   migrador        (DB_MIGRATOR_*)  Dueño de las tablas y de las funciones. Ejecuta `npm run migrate`. Sin SUPERUSER.
--   aplicación      (DB_APP_*)       Rol de ejecución de web, worker y consumidor. Solo DML. Ver 02-base.sql.
--
-- Variables de psql (obligatorias):  -v migrator_user=… -v migrator_password=… -v app_user=… -v app_password=…
-- Las contraseñas nunca viven en este repositorio: llegan por variables de entorno del despliegue.
\set ON_ERROR_STOP on

-- Atributos explícitos y mínimos: ningún rol de aplicación o de migración es superusuario ni puede crear roles,
-- bases, replicar u omitir RLS. Se crean si faltan y SIEMPRE se reafirman (corrige un rol creado a mano).
SELECT format(
  'CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS INHERIT',
  r) FROM (VALUES (:'migrator_user'), (:'app_user')) AS t(r)
 WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = t.r) \gexec

SELECT format(
  'ALTER ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS INHERIT PASSWORD %L',
  :'migrator_user', :'migrator_password') \gexec
SELECT format(
  'ALTER ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS INHERIT PASSWORD %L',
  :'app_user', :'app_password') \gexec

-- La aplicación no pertenece a ningún otro rol (ni al migrador, ni a pg_*): sin privilegios heredados.
SELECT format('REVOKE %I FROM %I', m.rolname, a.rolname)
  FROM pg_auth_members am
  JOIN pg_roles m ON m.oid = am.roleid
  JOIN pg_roles a ON a.oid = am.member
 WHERE a.rolname = :'app_user' \gexec
