# Release Readiness · Bloque 1 — endurecimiento de cabeceras y de la base de datos

Nota técnica corta (no es una fase ni una DEC nueva). Rama `release-readiness`, partida de `ae72f14`. **No introdujo ninguna migración de esquema** (última: `033`; las migraciones 001–033 no se tocaron) y no cambia contratos funcionales de V2.

## 1. Prettier

La deuda heredada eran 12 archivos (10 TS/TSX de `apps/web`, `globals.css`, `docker-compose.yml`). Se formatearon sin exclusiones: `npm run format:check` y Prettier sobre `ts,tsx,js,mjs,cjs,json,css,yml,yaml` quedan en verde. Verificado como sintáctico: `globals.css` por comparación de AST de postcss (único cambio de valor: `.2` → `0.2`) y el resto por compilación de TypeScript más lint, typecheck y los tests de `apps/web`. Los scripts históricos de gate (`f8/f9/f10-verificacion.sh`) conservan su lista `LEGACY` como registro de lo que eran esos gates; el gate de este bloque no excluye nada.

## 2. Cabeceras de seguridad

Un solo mecanismo por cabecera:

| Cabecera | Dónde | Cuándo |
|---|---|---|
| `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, `Permissions-Policy` | `next.config.mjs` (`CABECERAS_ESTATICAS`) | Todas las rutas, también `/_next/static` |
| `Content-Security-Policy` | `src/middleware.ts` | Toda ruta salvo `/_next/static`, `/_next/image`, `favicon.ico`; **nonce nuevo por respuesta** |
| `Strict-Transport-Security` | `src/middleware.ts` | Solo producción, solo HTTPS, nunca localhost |

El middleware **solo fija cabeceras**: no autoriza, no redirige ni lee sesión (la autorización sigue en páginas y casos de uso; el test `qa-f10-web` lo impone). Todo vive en `apps/web/security-headers.mjs` (puro, probado).

**CSP de producción** (derivada de lo que la app usa de verdad: sin `<img>`, sin fuentes ni scripts externos, `fetch` solo a `/api` propio, fuente Inter autoalojada por `next/font`):

```
default-src 'none'; script-src 'self' 'nonce-<por respuesta>'; style-src 'self' 'sha256-…404 de Next';
style-src-attr 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-src 'none';
worker-src 'none'; manifest-src 'none'; media-src 'none'; frame-ancestors 'none'; base-uri 'self';
object-src 'none'; form-action 'self'   [+ upgrade-insecure-requests solo bajo HTTPS]
```

- Sin `unsafe-eval`, sin `unsafe-inline` en scripts, sin comodines ni hosts externos. Next (App Router) lee el nonce de la CSP de la **petición** y lo aplica a sus scripts en línea (flight de RSC) y a sus chunks; por eso el layout raíz es `force-dynamic` (una página prerrenderizada no puede llevar nonce; ya lo eran todas salvo `/_not-found`).
- Excepciones declaradas, ambas acotadas: `style-src-attr 'unsafe-inline'` (hay cientos de `style={{…}}` renderizados por el servidor; los atributos no admiten nonce, y no ejecuta código) y un **hash** en `style-src` para el `<style>` de la 404 predeterminada de Next; un test lee el archivo real de `node_modules/next` y falla si el hash deja de coincidir tras actualizar Next.
- **Desarrollo**: solo `frame-ancestors/base-uri/object-src/form-action` (la CSP «mínima» de F10), porque `next dev` necesita `eval`, scripts en línea sin nonce y WebSocket del HMR. Producción no se debilita por `next dev`.

**HSTS** — `HSTS_MAX_AGE` (segundos; por defecto 15 552 000 = 180 días; `0` lo apaga), `HSTS_INCLUDE_SUBDOMAINS` y `HSTS_PRELOAD` (opt-in; `preload` exige includeSubDomains y ≥ 1 año). Se emite si: `NODE_ENV=production` **y** la respuesta es HTTPS (`https:` o `X-Forwarded-Proto: https` del proxy) **y** la cabecera `Host` no es bucle local (`localhost`, `*.localhost`, `127.0.0.0/8`, `::1`) o falta. Un valor inválido impide **arrancar** (`next.config.mjs` lo valida), no da 500 por petición. `nextUrl.hostname` no se usa: `next start` lo construye con su propio host de escucha. El proxy debe conservar `Host` y poner `X-Forwarded-Proto`; si un cliente inventa esa cabecera por HTTP plano, el navegador ignora HSTS recibido por un transporte inseguro (RFC 6797 §8.1).

Cierra QA-F10-04 (la prueba `it.fails` pasó a ser una prueba normal). **Pendiente fuera de este bloque:** verificar TLS/HSTS reales en staging (el proxy aún no existe) y decidir cuándo subir `max-age` / `includeSubDomains` / `preload`.

## 3. Postgres: mínimo privilegio

Tres roles, sin tocar migraciones (todo es infraestructura en `infra/db/roles/`, `infra/db/init/02-roles.sh`, `scripts/db-bootstrap.sh`):

| Rol | Atributos | Qué puede |
|---|---|---|
| Administrador de arranque (`POSTGRES_USER`) | superusuario del contenedor | Crear roles, bases y extensiones. **Ninguna aplicación lo usa.** |
| Migrador (`tclkolos_migrator`) | `NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS` | Dueño de la base y de **todas** las tablas y funciones; ejecuta `npm run migrate` (`MIGRATION_DATABASE_URL`). |
| Ejecución (`tclkolos_app`) | los mismos atributos, sin pertenencia a otros roles | `CONNECT`; `USAGE` en `public`; `SELECT/INSERT/UPDATE/DELETE` en las tablas. Nada más. |

Lo que el rol de ejecución **no** tiene, y por qué importa: no es dueño de nada (el dueño puede `ALTER TABLE … DISABLE TRIGGER`, `TRUNCATE` y `DROP`: las garantías de inmutabilidad son triggers y solo valen si el rol de ejecución ni es dueño ni es superusuario), sin `TRUNCATE`/`REFERENCES`/`TRIGGER`, sin `CREATE` en `public` ni en la base, sin `TEMPORARY`, sin acceso a `schema_migrations`, sin `SET session_replication_role`, `COPY PROGRAM`, `pg_read_file`, `CREATE EXTENSION`, `SET ROLE`. Las extensiones las crea el administrador (`01-extensions.sql`).

**Por qué `UPDATE/DELETE` se mantienen en todas las tablas:** ninguna función de trigger es `SECURITY DEFINER`, así que los triggers escriben con los privilegios de quien escribe; estrechar por tabla a partir del código de la aplicación rompería escrituras hechas por triggers. Las tablas de historia siguen protegidas por sus triggers (y ahora esos triggers no se pueden desactivar). Estrechar por tabla es trabajo futuro que exige auditar cada función de trigger.

Mecánica: `infra/db/roles/01-roles.sql` (roles; idempotente) y `02-base.sql` (por base: dueño, `REVOKE … FROM PUBLIC`, propiedad de objetos existentes → migrador, grants, `ALTER DEFAULT PRIVILEGES` para tablas futuras). Es idempotente y **adopta** una base creada antes del modelo. En Docker lo ejecuta `02-roles.sh` al crear el volumen; en un volumen existente o en bases adicionales (`tclkolos_test`): `scripts/db-bootstrap.sh <base> [--crear]`. Nunca hay contraseñas reales en el repositorio: llegan por entorno (`.env.example` solo trae placeholders de desarrollo).

**TRUNCATE** — no existe en código de producción ni de pruebas (`TRUNCATE` solo aparece en triggers que lo rechazan y en pruebas que prueban ese rechazo). La limpieza de las pruebas usa `DELETE` con el bypass de bases `_test`, que el rol de ejecución sí puede (privilegio DML), y que la migración 010 limita a bases cuyo nombre acaba en `_test`.

**Pruebas:** `packages/db` corre completa con el rol de ejecución. Las pocas operaciones que necesitan privilegio de verdad (inyectar fallos con triggers temporales, `DISABLE TRIGGER`, `CREATE DATABASE` del clon de `qa-f7-bypass`, comprobar la capa de triggers de `TRUNCATE` por debajo de los privilegios) usan `src/test-admin.ts` (`TEST_ADMIN_DATABASE_URL`, solo bases `_test`). `qa-rr-privilegios.test.ts` ejecuta cada operación administrativa y prueba que falla; con un superusuario **falla a propósito** (la suite no puede pasar por privilegios que producción no tiene). QA-F10-07 y QA-F10-08 pasaron de `it.fails` a pruebas normales.

## 4. Deuda detectada y NO implementada (clasificada)

- **No-bloqueante:** el `<style>` de la 404 de Next depende de un hash (la prueba avisa al actualizar Next); `style-src-attr 'unsafe-inline'` hasta que desaparezcan los `style={{}}` del servidor; `Cross-Origin-Opener-Policy`/`Cross-Origin-Resource-Policy` no se añadieron (fuera del alcance); estrechamiento de DML por tabla (§3).
- **Siguen siendo bloqueantes de producción (bloques siguientes):** autenticación del gateway del worker, OIDC, secretos productivos, harness de smoke de producción, smokes reales de proveedor y Google, staging/UAT, rotación de claves y cripto-borrado de PII.
- **Operación:** quien tenga un volumen de desarrollo anterior debe ejecutar `scripts/db-bootstrap.sh <base>` para adoptarlo y cambiar `DATABASE_URL` al rol de ejecución; el worker (Python) y el consumidor usan ya ese rol en `docker-compose.yml`.
