#!/usr/bin/env bash
# Verificación final de la Fase 9 (gate completo). Se corre UNA vez, en local, antes de etiquetar `v2-f9-complete`.
#
# Requisitos: Postgres con pgvector y las extensiones de `infra/db/init/01-extensions.sql`, una base `tclkolos_test`
# ya migrada y sembrada, el venv del worker (Python 3.11+) y Chrome/Chromium para Playwright.
#
# Uso:  DB_BASE=postgresql://tclkolos:devpassword@localhost:5432 PY=services/ai-worker/.venv/bin/python \
#         scripts/f9-verificacion.sh [directorio-de-logs]
# Resultado: <logs>/summary.txt con `paso exit=N` (0 = verde) y las comprobaciones de migración. No modifica `tclkolos`.
set -u
cd "$(dirname "$0")/.."
L="${1:-./.f9-verificacion}"; mkdir -p "$L"; : > "$L/summary.txt"
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

# F9 no introdujo migraciones: no hay prueba de migraciones desde cero ni upgrade.
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
git diff --name-only 213a986 HEAD -- '*.ts' '*.tsx' '*.json' '*.md' | grep -vxF "$LEGACY" | xargs -r ls 2>/dev/null > "$L/tocados.txt"
step prettier bash -c "xargs npx prettier --check < '$L/tocados.txt'"
step e2e bash -c 'cd apps/e2e && npx playwright test'
echo "FIN (revisar $L/summary.txt)" | tee -a "$L/summary.txt"
