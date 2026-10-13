#!/usr/bin/env bash
# Crea los roles de migración y de aplicación y sus privilegios en la base inicial (POSTGRES_DB).
# Se ejecuta UNA vez, al crear el volumen, como el administrador de arranque (POSTGRES_USER). Las bases adicionales
# (p. ej. `tclkolos_test`) y los volúmenes ya existentes se preparan con `scripts/db-bootstrap.sh`.
# Los SQL viven en infra/db/roles (montado en /db-roles): una sola fuente para el contenedor y para el script.
set -euo pipefail

: "${DB_MIGRATOR_PASSWORD:?DB_MIGRATOR_PASSWORD es obligatoria (ver .env.example)}"
: "${DB_APP_PASSWORD:?DB_APP_PASSWORD es obligatoria (ver .env.example)}"

VARS=(-v "migrator_user=${DB_MIGRATOR_USER:-tclkolos_migrator}" -v "migrator_password=${DB_MIGRATOR_PASSWORD}"
      -v "app_user=${DB_APP_USER:-tclkolos_app}" -v "app_password=${DB_APP_PASSWORD}")

psql -X -q "${VARS[@]}" --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" -f /db-roles/01-roles.sql
psql -X -q "${VARS[@]}" --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" -f /db-roles/02-base.sql
