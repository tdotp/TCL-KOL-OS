#!/usr/bin/env bash
# Prepara UNA base de datos con el modelo de tres roles (administrador → migrador → aplicación).
# Idempotente: sirve para una base nueva, para una base `_test` y para «adoptar» una base creada antes de este modelo
# (cuyas tablas son del administrador). Repetirlo tras migrar es inocuo.
#
# Uso:
#   ADMIN_URL=postgresql://tclkolos:devpassword@localhost:5434 \
#   DB_MIGRATOR_PASSWORD=… DB_APP_PASSWORD=… \
#   scripts/db-bootstrap.sh <base> [--crear]
#
#   ADMIN_URL   URL del administrador de arranque SIN base (se le añade /<base>).
#   --crear     crea la base si no existe (y le instala las extensiones).
#   PSQL        comando de psql (por defecto `psql`). Sin psql en el PATH:
#                 PSQL='docker exec -i tclkolos-db psql' ADMIN_URL=postgresql://tclkolos:devpassword@localhost:5432
#               (la URL se resuelve DENTRO del contenedor, por eso el puerto interno).
#   DB_MIGRATOR_USER / DB_APP_USER   nombres de rol (por defecto tclkolos_migrator / tclkolos_app).
#
# Orden en una base nueva:  db-bootstrap.sh <base> --crear  →  npm run migrate (con la URL del migrador)  →  npm run seed.
set -euo pipefail
cd "$(dirname "$0")/.."

BASE="${1:?Uso: scripts/db-bootstrap.sh <base> [--crear]}"
CREAR="${2:-}"
: "${ADMIN_URL:?ADMIN_URL es obligatoria (URL del administrador, sin base)}"
: "${DB_MIGRATOR_PASSWORD:?DB_MIGRATOR_PASSWORD es obligatoria}"
: "${DB_APP_PASSWORD:?DB_APP_PASSWORD es obligatoria}"
case "$BASE" in *[!A-Za-z0-9_]*|"") echo "Nombre de base no válido: $BASE" >&2; exit 2 ;; esac
PSQL="${PSQL:-psql}"
VARS=(-v "migrator_user=${DB_MIGRATOR_USER:-tclkolos_migrator}" -v "migrator_password=${DB_MIGRATOR_PASSWORD}"
      -v "app_user=${DB_APP_USER:-tclkolos_app}" -v "app_password=${DB_APP_PASSWORD}")
run() { $PSQL -X -q -v ON_ERROR_STOP=1 "${VARS[@]}" "$ADMIN_URL/$1" -f - ; }

if [ "$CREAR" = "--crear" ]; then
  existe=$($PSQL -X -At "$ADMIN_URL/postgres" -c "SELECT 1 FROM pg_database WHERE datname = '$BASE'")
  if [ -z "$existe" ]; then
    $PSQL -X -q -v ON_ERROR_STOP=1 "$ADMIN_URL/postgres" -c "CREATE DATABASE $BASE"
    run "$BASE" < infra/db/init/01-extensions.sql
  fi
fi

run "$BASE" < infra/db/roles/01-roles.sql
run "$BASE" < infra/db/roles/02-base.sql
echo "Base '$BASE' preparada: dueño ${DB_MIGRATOR_USER:-tclkolos_migrator}, ejecución ${DB_APP_USER:-tclkolos_app} (solo DML)."
