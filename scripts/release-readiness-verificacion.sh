#!/usr/bin/env bash
# Gate del Bloque 1 de Release Readiness (Prettier, cabeceras, Postgres con mínimo privilegio). Se corre en local.
#
# Requisitos: un Postgres con pgvector (p. ej. `docker run … pgvector/pgvector:pg16`) con el administrador de arranque,
# Chrome para el smoke de CSP y el venv del worker. El script CREA `tclkolos_test` desde cero (la borra si existe),
# la migra con el rol MIGRADOR, la siembra y corre las suites con el rol de EJECUCIÓN.
#
# Uso:  PSQL='docker exec -i <contenedor> psql' ADMIN_URL=postgresql://tclkolos:devpassword@localhost:5432 \
#       DB_HOST_PORT=5435 DB_MIGRATOR_PASSWORD=… DB_APP_PASSWORD=… scripts/release-readiness-verificacion.sh [logs]
# Resultado: <logs>/summary.txt con `paso exit=N` (0 = verde).
set -u
cd "$(dirname "$0")/.."
L="${1:-./.rr-verificacion}"; mkdir -p "$L"; L="$(cd "$L" && pwd)"; : > "$L/summary.txt"
: "${ADMIN_URL:?}" "${DB_MIGRATOR_PASSWORD:?}" "${DB_APP_PASSWORD:?}" "${DB_HOST_PORT:?puerto del Postgres visto desde el host}"
export PSQL="${PSQL:-psql}" ADMIN_URL DB_MIGRATOR_PASSWORD DB_APP_PASSWORD
MIG=tclkolos_migrator; APP=tclkolos_app; PW_M="$DB_MIGRATOR_PASSWORD"; PW_A="$DB_APP_PASSWORD"
HOST="localhost:$DB_HOST_PORT"
URL_APP="postgresql://$APP:$PW_A@$HOST"; URL_MIG="postgresql://$MIG:$PW_M@$HOST"
ADMIN_HOST_URL="${ADMIN_HOST_URL:-postgresql://tclkolos:devpassword@$HOST}"
step() { n=$1; shift; "$@" > "$L/$n.log" 2>&1; echo "$n exit=$?" >> "$L/summary.txt"; }

# RR_SOLO_SMOKE=1 omite todo lo anterior al smoke de `next start` (requiere la base de pruebas migrada y un `npm run build`).
fase_suites() {
  step prettier npm run format:check
  step prettier-css-yml npx prettier --check "**/*.{js,mjs,cjs,css,yml,yaml}"
  step lint npm run lint
  step typecheck npm run typecheck

  # Base de pruebas desde cero: bootstrap (dueño y rol) → migrar como MIGRADOR → sembrar como EJECUCIÓN.
  step db-recrear bash -c "$PSQL -X -q \"$ADMIN_URL/postgres\" -c 'DROP DATABASE IF EXISTS tclkolos_test WITH (FORCE)' && scripts/db-bootstrap.sh tclkolos_test --crear"
  step migrar env MIGRATION_DATABASE_URL="$URL_MIG/tclkolos_test" DATABASE_URL="$URL_APP/tclkolos_test" npm run migrate --workspace @tcl-kol-os/db
  step seed env DATABASE_URL="$URL_APP/tclkolos_test" npm run seed --workspace @tcl-kol-os/db
  export TEST_DATABASE_URL="$URL_APP/tclkolos_test" DATABASE_URL="$URL_APP/tclkolos_test" TEST_ADMIN_DATABASE_URL="$ADMIN_HOST_URL/tclkolos_test"

  step web bash -c 'cd apps/web && npx vitest run'
  step headers bash -c 'cd apps/web && npx vitest run security-headers.test.ts src/lib/qa-f10-web.test.ts'
  step db-privilegios bash -c 'cd packages/db && npx vitest run src/qa-rr-privilegios.test.ts'
  step db bash -c 'cd packages/db && npx vitest run'
  step domain bash -c 'cd packages/domain && npx vitest run'
  step agent bash -c 'cd packages/agent && npx vitest run'
  step build npm run build
}
export DATABASE_URL="$URL_APP/tclkolos_test"
[ -n "${RR_SOLO_SMOKE:-}" ] || fase_suites

# `next start` real (producción): matriz de cabeceras con curl y smoke de CSP con Chrome.
PUERTO=${RR_PUERTO:-3020}
export PII_ENCRYPTION_KEYS="rr-1:$(python3 -c 'import base64;print(base64.b64encode(b"\x11"*32).decode())')"
export PII_INDEX_KEY="$(python3 -c 'import base64;print(base64.b64encode(b"\x22"*32).decode())')"
( cd apps/web && NODE_ENV=production AUTH_PROVIDER=dev SESSION_SECRET=rr-smoke-secret-0123456789abcdef WORKER_URL=http://localhost:9 \
    HSTS_MAX_AGE=86400 npx next start --port "$PUERTO" > "$L/next-start.log" 2>&1 & echo $! > "$L/next.pid" )
for i in $(seq 1 30); do curl -sf "http://localhost:$PUERTO/api/health" >/dev/null && break; sleep 1; done
h() { curl -sI "$@" | tr -d '\r'; }
smoke_cabeceras() {
  local ok=0 u="http://localhost:$PUERTO"
  h "$u/login" | grep -qi '^content-security-policy: default-src .none.; script-src .self. .nonce-' || { echo "FALTA CSP"; ok=1; }
  h "$u/login" | grep -qi 'unsafe-eval' && { echo "CSP con unsafe-eval"; ok=1; }
  for c in x-content-type-options x-frame-options referrer-policy permissions-policy; do h "$u/api/health" | grep -qi "^$c:" || { echo "FALTA $c"; ok=1; }; done
  [ -z "$(h "$u/login" | grep -i '^strict-transport')" ] || { echo "HSTS en http://localhost"; ok=1; }
  [ -z "$(h -H 'X-Forwarded-Proto: https' "$u/login" | grep -i '^strict-transport')" ] || { echo "HSTS con Host localhost"; ok=1; }
  [ -z "$(h -H 'Host: tcl.smartpr.example' "$u/login" | grep -i '^strict-transport')" ] || { echo "HSTS sobre http"; ok=1; }
  [ "$(h -H 'Host: tcl.smartpr.example' -H 'X-Forwarded-Proto: https' "$u/login" | grep -i '^strict-transport')" = "strict-transport-security: max-age=86400" ] || { echo "HSTS esperado tras proxy https"; ok=1; }
  a=$(curl -s "$u/login" | grep -o '/_next/static/css/[a-z0-9]*\.css' | head -1)
  h "$u$a" | grep -qi '^x-content-type-options: nosniff' || { echo "estático sin nosniff"; ok=1; }
  return $ok
}
step next-start-cabeceras smoke_cabeceras
CAMP=$($PSQL -X -At "$ADMIN_URL/tclkolos_test" -c "select id from campaigns where name like 'Lanzamiento línea P80'")
step next-start-csp-chrome env BASE="http://localhost:$PUERTO" CAMPANA="$CAMP" node scripts/csp-smoke.mjs
kill "$(cat "$L/next.pid")" 2>/dev/null; pkill -f "next start --port $PUERTO" 2>/dev/null
step pytest bash -c 'cd services/ai-worker && .venv/bin/python -m pytest -q'
echo "FIN (revisar $L/summary.txt)" | tee -a "$L/summary.txt"
