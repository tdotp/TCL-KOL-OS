#!/usr/bin/env bash
# Verificación final de la Fase 8 (gate completo). Se corre UNA vez, en local, antes de etiquetar `v2-f8-complete`.
#
# Requisitos: Postgres con pgvector y las extensiones de `infra/db/init/01-extensions.sql`, una base `tclkolos_test`
# ya migrada y sembrada, el venv del worker (Python 3.11+) y Chrome/Chromium para Playwright.
#
# Uso:  DB_BASE=postgresql://tclkolos:devpassword@localhost:5432 PY=services/ai-worker/.venv/bin/python \
#         scripts/f8-verificacion.sh [directorio-de-logs]
# Resultado: <logs>/summary.txt con `paso exit=N` (0 = verde) y las comprobaciones de migración. No modifica `tclkolos`.
set -u
cd "$(dirname "$0")/.."
L="${1:-./.f8-verificacion}"; mkdir -p "$L"; : > "$L/summary.txt"
B="${DB_BASE:-postgresql://tclkolos:devpassword@localhost:5432}"
PY="${PY:-services/ai-worker/.venv/bin/python}"
# El intérprete se usa tras `cd services/ai-worker`: una ruta relativa dejaría de existir ahí (exit 127).
case "$PY" in /*) ;; *) PY="$PWD/$PY" ;; esac
export PGPASSWORD="${PGPASSWORD:-devpassword}"
export DATABASE_URL="$B/tclkolos_test" TEST_DATABASE_URL="$B/tclkolos_test" E2E_DATABASE_URL="$B/tclkolos_test"
step() { n=$1; shift; "$@" > "$L/$n.log" 2>&1; echo "$n exit=$?" >> "$L/summary.txt"; }

step lint npm run lint
step typecheck npm run typecheck
step domain bash -c 'cd packages/domain && npx vitest run'
step agent bash -c 'cd packages/agent && npx vitest run'
step web bash -c 'cd apps/web && npx vitest run'
step db bash -c 'cd packages/db && npx vitest run'
step ruff bash -c "cd services/ai-worker && $PY -m ruff check app tests"
step mypy bash -c "cd services/ai-worker && $PY -m mypy app"
step pytest bash -c "cd services/ai-worker && $PY -m pytest -q"
step build npm run build

# --- Migraciones desde cero (001→latest) + seed
psql "$B/postgres" -c "DROP DATABASE IF EXISTS tmp_zero_test" -c "CREATE DATABASE tmp_zero_test" > "$L/zero.log" 2>&1
psql "$B/tmp_zero_test" -f infra/db/init/01-extensions.sql >> "$L/zero.log" 2>&1
DATABASE_URL="$B/tmp_zero_test" npm run migrate --workspace @tcl-kol-os/db >> "$L/zero.log" 2>&1; echo "zero-migrate exit=$?" >> "$L/summary.txt"
DATABASE_URL="$B/tmp_zero_test" npm run seed --workspace @tcl-kol-os/db >> "$L/zero.log" 2>&1; echo "zero-seed exit=$?" >> "$L/summary.txt"
psql "$B/postgres" -c "DROP DATABASE tmp_zero_test" >> "$L/zero.log" 2>&1

# --- Upgrade 025→latest con datos sembrados: el md5 por tabla de las tablas PREVIAS debe ser idéntico
psql "$B/postgres" -c "DROP DATABASE IF EXISTS tmp_upg_test" -c "CREATE DATABASE tmp_upg_test" > "$L/upg.log" 2>&1
psql "$B/tmp_upg_test" -f infra/db/init/01-extensions.sql >> "$L/upg.log" 2>&1
psql "$B/tmp_upg_test" -c "CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())" >> "$L/upg.log" 2>&1
for f in $(ls infra/db/migrations | sort | head -25); do
  psql -v ON_ERROR_STOP=1 "$B/tmp_upg_test" -f "infra/db/migrations/$f" >> "$L/upg.log" 2>&1 || echo "upg-apply-$f FAIL" >> "$L/summary.txt"
  psql "$B/tmp_upg_test" -c "INSERT INTO schema_migrations(version) VALUES ('${f%.sql}') ON CONFLICT DO NOTHING" >> "$L/upg.log" 2>&1
done
DATABASE_URL="$B/tmp_upg_test" npm run seed --workspace @tcl-kol-os/db >> "$L/upg.log" 2>&1; echo "upg-seed exit=$?" >> "$L/summary.txt"
HASHQ="SELECT table_name, (xpath('/row/h/text()', query_to_xml(format('select md5(coalesce(string_agg(t::text, '''' order by t::text),'''')) as h from %I t', table_name), false, true, '')))[1]::text FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE' ORDER BY 1"
psql "$B/tmp_upg_test" -At -c "$HASHQ" > "$L/upg-before.txt" 2>&1
DATABASE_URL="$B/tmp_upg_test" npm run migrate --workspace @tcl-kol-os/db >> "$L/upg.log" 2>&1; echo "upg-migrate exit=$?" >> "$L/summary.txt"
psql "$B/tmp_upg_test" -At -c "$HASHQ" > "$L/upg-after.txt" 2>&1
# `schema_migrations` es el libro de migraciones: gana una fila por cada migración nueva, así que cambia POR DISEÑO
# y no se compara (las demás tablas previas deben quedar idénticas).
join -t'|' <(sort "$L/upg-before.txt") <(sort "$L/upg-after.txt") | awk -F'|' '$1!="schema_migrations" && $2!=$3' > "$L/upg-diff.txt"
echo "upg-tablas-previas=$(wc -l < "$L/upg-before.txt") cambiadas=$(wc -l < "$L/upg-diff.txt") (esperado: cambiadas=0)" >> "$L/summary.txt"
psql "$B/postgres" -c "DROP DATABASE tmp_upg_test" >> "$L/upg.log" 2>&1

# --- Prettier sobre lo tocado en F8 y E2E oficial completo (~20 min)
# Deuda heredada de Prettier (17 archivos anteriores a V2; NO se reformatean hasta cerrar el rediseño frontend):
LEGACY='apps/web/src/app/(app)/campanas/TablaCampanas.tsx
apps/web/src/app/(app)/campanas/[id]/brief/editar/AlertaPreguntasCriticas.tsx
apps/web/src/app/(app)/campanas/[id]/brief/editar/EditorBrief.tsx
apps/web/src/app/(app)/campanas/[id]/brief/editar/NavegacionSecciones.tsx
apps/web/src/app/(app)/campanas/[id]/brief/editar/PanelComentarios.tsx
apps/web/src/app/(app)/campanas/[id]/brief/editar/page.tsx
apps/web/src/app/(app)/campanas/[id]/fuentes/FormularioFuente.tsx
apps/web/src/app/(app)/campanas/[id]/fuentes/TablaFuentes.tsx
apps/web/src/app/(app)/campanas/[id]/fuentes/page.tsx
apps/web/src/app/(app)/campanas/nueva/FormularioCampana.tsx
apps/web/src/app/(app)/campanas/nueva/page.tsx
apps/web/src/app/(app)/campanas/page.tsx
apps/web/src/app/(app)/page.tsx
apps/web/src/app/globals.css
apps/web/src/app/login/page.tsx
apps/web/src/components/AppShell.tsx
docker-compose.yml'
git diff --name-only a4a8dd5 HEAD -- '*.ts' '*.tsx' '*.json' '*.md' | grep -vxF "$LEGACY" | xargs -r ls 2>/dev/null > "$L/tocados.txt"
step prettier bash -c "xargs npx prettier --check < '$L/tocados.txt'"
step e2e bash -c 'cd apps/e2e && npx playwright test'
echo "FIN (revisar $L/summary.txt)" | tee -a "$L/summary.txt"
