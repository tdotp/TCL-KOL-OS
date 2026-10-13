# TCL KOL OS V2 — Estado técnico actual (cierre de la Fase 10 — V2 completa)

> Es un **estado técnico**, no un segundo workflow funcional. El workflow aprobado vive en
> [`docs/product/TCL_KOL_OS_V2_WORKFLOW_FUNCIONAL.md`](../product/TCL_KOL_OS_V2_WORKFLOW_FUNCIONAL.md) y no se reinterpreta aquí.

| | |
|---|---|
| **Fecha del checkpoint** | 12 de octubre de 2026 |
| **Rama de desarrollo** | `v2` (nunca `main`). V2 está completa (F0–F10); cualquier trabajo posterior parte de `git switch v2 && git pull --ff-only` |
| **Tag** | **`v2-f10-complete`** (cierre certificado de la F10 = V2 completa; commit exacto: `git rev-parse v2-f10-complete^{}`), `v2-f9-complete` → `7d49c5a`, `v2-f8-complete` → `91e2aad9c850f313dc25171cdf43ef3a0cdfba22`, `v2-f7-complete` → `a4a8dd5`. **Los tags no se mueven**; los commits de `v2` posteriores a un tag pueden ser solo documentación |
| **Último commit de CÓDIGO** | el de la F10 anterior al tag `v2-f10-complete` (`git log v2-f9-complete..v2-f10-complete`); baseline de F9: `d50e3b5`, de F8: `7afdab7` |
| **Baseline de código previo a V2** | `3dd9da2` (DEC-042) |
| **`origin/main`** | `2452283` («Rediseño v3»): lo que estaba publicado antes de V2. **No se toca** |
| **Última migración** | `033_endurecimiento_operacion.sql` (siguiente: **034**; **F9 y F10 no introdujeron migración**) |
| **Última decisión** | **DEC-051** (siguiente: **DEC-052**) |
| **Siguiente fase** | **Ninguna del roadmap V2.** Resumen de cierre: [`V2_FINAL_STATE`](V2_FINAL_STATE.md). Merge a `main` y despliegue son una decisión posterior |

## 1. Roadmap

| Fase | Contenido | Estado | Decisión / nota |
|---|---|---|---|
| 0 | Baseline limpio | ✅ | — |
| 1 · 1.1 | Contratos transversales: visibilidad, rol Operativo, auditoría con origen, HITL (atómico en 1.1) | ✅ | DEC-042 y D0 |
| 2 | Modelo bilingüe: una versión lógica, representaciones ES/EN | ✅ | DEC-043 · [`BILINGUAL_MODEL_V2`](../product/BILINGUAL_MODEL_V2.md) |
| 3 | `Influencer` (identidad) y `CampaignInfluencer` (participación) | ✅ | DEC-044 · [`INFLUENCER_MODEL_V2`](../product/INFLUENCER_MODEL_V2.md) |
| 4 | Ingestión ampliada: fuentes enlazadas, `SourceLocator`, XLSX/CSV | ✅ | DEC-045 · [`INGESTION_SPREADSHEETS_V2`](../product/INGESTION_SPREADSHEETS_V2.md) |
| 5 | Google Sheet de influencers: snapshots inmutables, esquema V1, importación con plan y resolución humana | ✅ | DEC-046 · [`GOOGLE_SHEETS_IMPORT_V2`](../product/GOOGLE_SHEETS_IMPORT_V2.md), [`INFLUENCER_SHEET_V1`](../product/INFLUENCER_SHEET_V1.md) |
| 6 · 6.1 | Chat y agente de Cuenta (runtime híbrido, 25 tools, HITL extendido) y endurecimiento en la base | ✅ | DEC-047 · [`CHAT_AGENT_V2`](../product/CHAT_AGENT_V2.md) |
| 7 | Contenido: entregables, guiones versionados, revisión contra el Brief, aprobación humana, 11 tools | ✅ | DEC-048 · [`CONTENT_V2`](../product/CONTENT_V2.md) |
| 8 | Operación + KPIs: acuerdos, logística, facturación/pagos como seguimiento, PII separada, KPIs, workspace de Operativo, 6 tools | ✅ | DEC-049 · [`OPERATIONS_KPI_V2`](../product/OPERATIONS_KPI_V2.md) |
| 9 | Dashboard TCL de solo lectura: proyección positiva en el servidor, capacidades de cliente, solo contenido aprobado, export con paridad | ✅ | DEC-050 · [`TCL_DASHBOARD_V2`](../product/TCL_DASHBOARD_V2.md) |
| 10 | Limpieza, deprecación y endurecimiento final: legado sin enforcer retirado, navegación única por capacidades, login cerrado por defecto en producción, cabeceras de seguridad, cita histórica de evidencia, QA y mutaciones | ✅ | DEC-051 · [`V2_FINAL_STATE`](V2_FINAL_STATE.md) |

## 2. Arquitectura principal (resumen; el detalle está en las DEC y notas técnicas)

Monorepo: `apps/web` (Next.js 15 + React 19), `apps/e2e` (Playwright), `packages/domain` (reglas puras), `packages/db` (Postgres: repositorios y casos de uso), `packages/agent` (registro de tools y runtime del agente de Cuenta; 42 tools), `services/ai-worker` (Python/FastAPI: parsing, Google Sheets, extracción, endpoints de modelo `/modelo/turno` y `/modelo/analisis`). Idioma de UI y docs: español.

- **Actores:** Cuenta SmartPR (`admin`/`director`/`consultor`) construye y decide; Operativo SmartPR ejecuta y registra (F8: acuerdos, logística, seguimiento de facturación y pagos, KPIs reales, PII de entrega); TCL (`cliente`) observa en solo lectura el dashboard `/tcl` (F9): solo proyecciones del servidor con allowlist, sin finanzas ni PII.
- **Capas:** el dominio y la base DECIDEN (permisos, tenant, estados, versionado, HITL, provenance); el runtime del agente solo ORQUESTA; las tools son adaptadores finos de casos de uso; el worker hace llamadas de modelo sin estado y sin BD.
- **Aislamiento por organización** impuesto en la base con claves foráneas compuestas; `audit_events` append-only con `origin = ui | chat | system` y `correlation`.
- **Provenance:** `source_documents` es LA entidad de fuente (original preservado por hash), `SourceLocator`, evidencia que hereda el localizador, snapshots inmutables de Google Sheets.
- **Versionado:** Brief = una versión lógica con representaciones ES/EN (sin estado propio); ScriptVersion = entidad propia, nunca se sobrescribe.
- **HITL:** `proposed_actions` con un registro de handlers por tipo (`brief.approve`, `influencer_import.apply`, `influencer_import.resolve_record`, `script_version.approve`); confirma una persona por canal `ui` con la huella mostrada.
- **Operación (F8):** todo cambio de estado de envío, documento de cobro y obligación de pago entra por un `operational_events` append-only (idempotente, `expected_seq`, solo persona por `ui`); **payment tracking ≠ payment execution**; barter puro ⇒ pago `not_applicable`; PII cifrada y separada (AES-256-GCM en la aplicación); evidencia = `source_documents` tipo `soporte_operativo` (sensible, interna, sin extracción); KPI objetivo ≠ medición (inmutables, corrección = fila nueva). Detalle en [`OPERATIONS_KPI_V2`](../product/OPERATIONS_KPI_V2.md).
- **IA:** nunca es requisito ni decide. Todo texto de documentos va en sobres no confiables; las salidas del modelo se validan por código; un `ai_runs` por llamada.

## 3. Migraciones (forward-only; no se editan las aplicadas)

`001_core` · `002_sources` · `003_localizador_seccion` · `004_briefs` · `005_producto_preguntas_y_revision` · `006_excepcion_por_producto` · `007_comentarios_internos` · `008_claim_exige_evidencia_excepcion_manual` · `009_inmutabilidad_historica` · `010_inmutabilidad_bypass_restringido` · `011_rol_operativo` · `012_auditoria_con_origen` · `013_acciones_propuestas` · `014_modelo_bilingue_v2` · `015_influencers` · `016_campaign_influencers` · `017_estado_por_resolver` · `018_fuentes_enlazadas_y_localizador` · `019_snapshots_fuentes_enlazadas` · `020_importacion_influencers` · `021_chat_agente` · `022_endurecimiento_chat` · `023_contenido_guiones` · `024_analisis_de_contenido` · `025_endurecimiento_contenido` · `026_tipo_fuente_soporte_operativo` · `027_acuerdos` · `028_pii_kol` · `029_envios` · `030_facturacion_pagos` · `031_eventos_operativos` · `032_kpis` · `033_endurecimiento_operacion`.

Una migración nueva debe: ser aditiva, probarse **desde base vacía** (1→N + seed) y como **upgrade con datos** (md5 por tabla), y ejecutarse también sobre la base de pruebas. `ALTER TYPE … ADD VALUE` va en su propia migración.

## 4. Baseline de pruebas al cierre de la Fase 8 (certificado el 7 de octubre de 2026)

Certificado en local con el gate canónico [`scripts/f8-verificacion.sh`](../../scripts/f8-verificacion.sh) sobre una base `tclkolos_test` recién migrada (001→033) y sembrada, en el código `7afdab7`:

| Suite | Resultado |
|---|---|
| `packages/domain` | **823 / 823** (26 archivos) |
| `packages/agent` | **591 / 591** (51 archivos, incluye `src/qa/**` y el test estático de frontera D15) |
| `apps/web` (vitest) | **121 / 121** (5 archivos) |
| `packages/db` | **1885 / 1885** (101 archivos) |
| Worker Python (`pytest`) | **799 passed** |
| E2E Playwright (corrida oficial completa) | **78 / 78** (34 de F0–F6.1 + 17 de F7 + 27 de F8) en una corrida completa; en una segunda corrida completa dieron 75 y las 3 de `roles-y-aislamiento` (un timeout de 30 s en el arranque en frío de `/login`) pasaron 3/3 en dos repeticiones aisladas |
| `npm run lint` · `typecheck` · `build` · `ruff check app tests` · `mypy app` | verdes |
| Migraciones | 001→033 + seed desde cero: OK |
| Upgrade 025→033 con datos sembrados | md5 por tabla de las 47 tablas previas **idéntico** (`schema_migrations` se excluye: gana una fila por migración) |
| Prettier sobre lo tocado en F8 (137 archivos, sin la deuda heredada declarada) | verde |

**Mutaciones críticas** ([`scripts/f8-mutaciones.py`](../../scripts/f8-mutaciones.py)): de las 10 mutaciones **originales**, **9 se detectaron** directamente (tenant en envíos, claves prohibidas de TCL, secciones del agente sin finanzas, aplicabilidad del barter, grafo de envíos, inmutabilidad de KPI, Operativo con `script:approve`, idempotencia del evento, permiso `agreement:manage`). La **#7 original** (reportar pago con una capacidad más laxa) quedó **enmascarada** por una defensa independiente de la base (`operaciones_exigir_rol`); se sustituyó por una mutación **equivalente** sobre el límite actor/origen (`exigirPersonaPorUi` aceptando chat), que sí se detectó. **No es «10/10 originales».** No se repitieron en el cierre: los arreglos del cierre no tocan ninguno de los archivos que cubren.

**Seguridad histórica (cierre de F8):** los snapshots del Sheet de influencers anteriores a la lista blanca de columnas conservan `fee`, `canje`, `condiciones` y columnas desconocidas en el texto de sus fragmentos (inmutables, no se reescriben). Hasta el cierre ese texto salía por todos los lectores mientras el snapshot fuera el vigente; ahora son **ilegibles** para todo lector (guarda en `packages/db/src/fragment-scope.ts`: seguro por defecto) hasta re-sincronizar el Sheet. Pruebas: `packages/db/src/qa-f8-snapshots-historicos.test.ts` (11) y `packages/agent/src/qa/qa-f8-snapshots-historicos.test.ts` (7); con la guarda anulada fallan 9 y 3.

Pruebas con fallo **intermitente conocido bajo carga o en bases de pruebas acumuladas** (pasan aisladas o en una base fresca): `packages/agent/src/qa/qa-hitl.test.ts` (H2), `packages/db/src/qa-f7-estres.test.ts` y `qa-f7-alcance.test.ts` (C, timeout al escanear `audit_events`). El gate espera una `tclkolos_test` recién creada. Un E2E completo bajo carga alta puede dar timeouts de login (30 s) en el arranque en frío de `next dev`; repetir el archivo aislado con la máquina en calma.

## 4b. Cierre de la Fase 9 (Dashboard TCL, DEC-050)

Gate canónico [`scripts/f9-verificacion.sh`](../../scripts/f9-verificacion.sh) (sin pasos de migración: **F9 introdujo no schema migration**; no hay upgrade 033→033) sobre una `tclkolos_test` recién creada, migrada (001→033) y sembrada:

| Suite | Resultado |
|---|---|
| `packages/domain` | **1015 / 1015** (base F8: 823) |
| `packages/db` | **1975 / 1975** (base: 1885) |
| `packages/agent` | **596 / 596** (base: 591) |
| `apps/web` (vitest) | **144 / 144** (base: 121) |
| Worker Python | **799 passed** |
| lint · typecheck · build · ruff · mypy | verdes |
| Prettier sobre lo tocado | verde (tras formatear `apps/e2e/tests/operacion-acceso.spec.ts`) |
| E2E oficial completo | **85 / 85** (78 de F0–F8 + 7 de F9) en la segunda corrida completa (21,2 min). La primera, con la máquina a carga ~14, falló 17 tests por timeouts de arranque en frío/chat (3,9 h) y no se certificó; no hubo fallos de aserción de seguridad |

**QA adversarial independiente** (20 ataques como cliente TCL, con barrido de más de 300 exports de `@tcl-kol-os/db`): 0 P0; 2 P1, 3 P2 y varios P3, **todos los P1/P2 corregidos** y fijados en `qa-f9-*.test.ts`. Detalle en DEC-050 y [`TCL_DASHBOARD_V2`](../product/TCL_DASHBOARD_V2.md) §9.

**Mutaciones críticas** (script efímero del cierre; patrón mutar → prueba dirigida → restaurar): las 10 áreas quedan detectadas (fuga financiera por secciones, claves PII, contenido solo aprobado, fuente interna, paridad del export, tipo de organización, denegación de escrituras). **Tres de las mutaciones originales sobrevivieron por enmascaramiento de defensas independientes** (visibilidad: SQL + `isTclVisible`; rol: `role==='cliente'` + `roleCan`; fuga histórica: guarda de fragmento histórico + filtro del Sheet) y se sustituyeron por mutaciones equivalentes que anulan ambas capas, que sí se detectan. No es «10/10 originales».

## 4c. Cierre de la Fase 10 (limpieza y endurecimiento final, DEC-051)

Gate canónico [`scripts/f10-verificacion.sh`](../../scripts/f10-verificacion.sh) sobre una `tclkolos_test` **recreada** (001→033 + seed). **F10 introdujo no schema migration** (no hay upgrade 033→034).

| Suite | Resultado |
|---|---|
| `packages/domain` | **1015 / 1015** |
| `packages/db` | **2103 / 2103** (base F9: 1975; +128 de `qa-f10-*`, −retirados con los lectores borrados) |
| `packages/agent` | **607 / 607** (base: 596) |
| `apps/web` (vitest) | **235 / 235** (base: 144) |
| Worker Python (`pytest`) | **799 passed** |
| lint · typecheck · build · ruff · mypy | verdes |
| Prettier sobre lo tocado desde `v2-f9-complete` | verde (un archivo de prueba se reformateó tras el gate y se re-verificó) |
| Migraciones | **ninguna nueva**: 001→033 + seed desde cero (base recreada para el gate) |
| E2E oficial completo (~20 min) | **85 / 85 efectivos.** Primera corrida completa: 80 verdes, 2 fallos y 3 sin ejecutar (seriales). Los 5 pasan aislados con la máquina en calma: E2E-07/08/09 (`roles-y-aislamiento`, `next dev`) y E2E-27a/b (`operacion-tcl`, también contra `next build` + `next start`). Causas de los 2 fallos: E2E-07, cierre de la sesión de Chrome («Protocol error … session closed», timeout de 30 s, carga de la máquina ~6); E2E-27a, el **flight de depuración de `next dev`** incrustó en el HTML de `/tcl/campanas/{id}` un resultado crudo de `pg` (id de envío y `tiene_pii: true`; sin PII ni finanzas) cuando una consulta tardó por la carga. Es la deuda de F9 («`next dev` serializa objetos de `pg` en el flight de RSC»), **solo de desarrollo**: con `next start` el flight no lo incluye y E2E-27a pasa en 5,8 s con centinelas operativos sembrados |

**QA adversarial independiente** (20 ataques; archivos `qa-f10-*.test.ts`): 0 P0, 0 P1 abiertos. Un P1 condicional (QA-F10-05: `evidence.quote` conservaba la cita literal de un snapshot histórico del Sheet y 4 lectores internos la devolvían) se corrigió con `sqlCitaDeEvidenciaServible`. P2/P3 corregidos: QA-F10-02 (la plantilla `.env.example` ya no activa `AUTH_PROVIDER=dev`), -03 (`SESSION_SECRET` ≥ 16 en producción), -09 (límite de `actividadReciente`). Diferidos con `it.fails` «abierto»: QA-F10-01, -04 (HSTS y `script-src`), -06, -07 (`TRUNCATE`), -08 (rol de BD superusuario).

**Mutaciones** (script efímero; 8 garantías + 1 del arreglo nuevo): todas detectadas; ver el detalle y el enmascaramiento declarado en [`V2_FINAL_STATE` §5](V2_FINAL_STATE.md).

**Verificación en producción (`next build` + `next start`, base clonada):** flight de RSC de `/tcl` sano (sin fechas ni objetos de `pg` sin serializar), 404 idéntico a internos y sin sesión, `/campanas` del cliente → 307 a `/tcl`, `HEAD` del export → 405, cabeceras de seguridad presentes, login cerrado sin `AUTH_PROVIDER` explícito.

## 5. Cómo ejecutar en local (lecciones del entorno)

```bash
# 1) Docker Desktop encendido. Postgres de TCL en el puerto 5434 (el 5432/5433 pueden ser de OTRO proyecto):
POSTGRES_PORT=5434 docker compose up -d db
# 2) Bases: `tclkolos` (desarrollo) y `tclkolos_test` (pruebas; el sufijo `_test` es OBLIGATORIO para
#    pruebas y E2E). Una base nueva necesita las extensiones antes de migrar:
docker exec tclkolos-db psql -U tclkolos -d <base> -f /docker-entrypoint-initdb.d/01-extensions.sql
DATABASE_URL=postgresql://tclkolos:devpassword@localhost:5434/<base> npm run migrate --workspace @tcl-kol-os/db
# 3) Pruebas (EXPORTA CADA VARIABLE POR SEPARADO; en zsh `export A=x B=$A` deja B vacío):
export DATABASE_URL=postgresql://tclkolos:devpassword@localhost:5434/tclkolos_test
export TEST_DATABASE_URL=postgresql://tclkolos:devpassword@localhost:5434/tclkolos_test
npm run seed --workspace @tcl-kol-os/db      # una base de pruebas sin sembrar hace fallar a packages/db
python fixtures/spreadsheets/generar_fixtures.py   # el .xlsx de prueba está en .gitignore (sin él fallan 3 pruebas)
npm run lint && npm run typecheck && npm run test && npm run build
(cd services/ai-worker && .venv/bin/ruff check app tests && .venv/bin/mypy app && .venv/bin/python -m pytest -q)
# 4) E2E (BD con sufijo _test; puertos 3010–3016 y worker 8011/8012; Google Chrome real; ~11 min completo):
(cd apps/e2e && E2E_DATABASE_URL=$TEST_DATABASE_URL npx playwright test)
# 5) Al terminar:  docker compose stop db
```

Trampas del gate (`scripts/f8-verificacion.sh`): necesita `psql` en el PATH (si solo hay Docker, un adaptador que ejecute `docker exec -i tclkolos-db psql -U tclkolos -d <base>` y traduzca la URL `postgresql://…/<base>`) y una `tclkolos_test` recién creada, migrada y sembrada (en una base acumulada fallan de forma intermitente pruebas que escanean tablas globales). Trampas generales: las pruebas de PII (F8) usan claves de prueba que `packages/db/vitest.setup.ts` y el E2E fijan SOLO si la base termina en `_test`; fuera de ahí `PII_ENCRYPTION_KEYS`/`PII_INDEX_KEY` son obligatorias y no hay valor por defecto; un E2E del proyecto `operacion` levanta el servidor 3016; `timeout` no existe en macOS y `sed -i` es BSD; el estado del shell no persiste entre llamadas y un `cd` desplaza el cwd (usa rutas absolutas); no uses `git stash`; una base sembrada rechaza `seed`; si añades una migración, migra también `tclkolos_test`; una migración aplicada no se edita (rehacerla en pruebas: `CREATE DATABASE … TEMPLATE`, sin conexiones activas a la plantilla); el bypass de inmutabilidad solo existe en bases `_test`; el worker local usa un venv de **Python 3.9** (escribe `Optional[...]` en modelos Pydantic y `(int, float)` en `isinstance`; necesita `google-auth` y `requests`); un E2E con worker real exige ese venv (pide `REDIS_URL` ficticio y `AI_MODEL_*` aunque el proveedor sea el falso); el modelo falso del chat solo responde a un marcador `[[fake:tool nombre {json plano}]]` en el último mensaje del usuario (una tool plana por turno) y el del análisis a `[[fake:analisis <modo>]]` dentro del texto del guion; los tests de `packages/agent/src/qa` que usan el harness de mutación copian el árbol de `HEAD` (`git archive`) salvo que se pida `'arbol'`.

Datos sintéticos sembrados: usuarios `gerardo@smartpr.co` (admin), `director@smartpr.co`, `consultor@smartpr.co`, `operativo@smartpr.co`, `marena@tcl.com` (cliente), `ajeno@otraagencia.co` (otra agencia); organizaciones SmartPR, TCL Colombia, Agencia Ajena; campañas «Lanzamiento línea P80», «Lanzamiento C7L» y «Campaña confidencial de otra agencia»; productos P80, P80 Pro, P80 Ultra, C7L, X11L, Soundbar S64. Fixtures de pruebas en `@tcl-kol-os/db/test-utils` (`crearEscenarioDeChat`, `crearEscenarioDeContenido`, `crearBriefAprobadoDePrueba`, …). Nunca se usan campañas reales ni `.env`/`.storage/` en pruebas.

## 6. Deudas conocidas (heredadas, F8–F10; resumen final en [`V2_FINAL_STATE` §7](V2_FINAL_STATE.md))

- **F8 (operación):** cripto-borrado y política de retención de PII (DEC-013) sin implementar; rotación de claves sin procedimiento; originales de evidencia sin cifrar en almacenamiento (mitigado: `sensible`, internos, sin extracción); snapshots del Sheet creados antes de la corrección del P0 conservan `fee/canje/condiciones` en el texto de sus fragmentos (inmutables): ya NO se leen por ningún camino (ver §4), pero siguen en la base; para recuperar el texto hay que re-sincronizar el Sheet, y quien necesite borrarlos físicamente debe hacerlo con un procedimiento explícito; los Briefs extraídos ANTES del P0 podrían contener texto derivado de esos fragmentos (auditarlos en una base con datos reales); pagos en cuotas/parciales no modelados; un acuerdo cancelado bloquea uno nuevo en la participación; idempotencia de versiones de acuerdo y de guardado de PII por contenido; KPI por CSV/Sheets/APIs sociales diferidos; sin topes por sujeto de eventos, documentos y mediciones; sin `retractarEvidencia` en la UI ni descarga de originales; oráculo por hash en `uploadSource`; archivos huérfanos en disco si una transacción aborta; `kpi_target_register` con grounding conservador.

- **F9 (dashboard TCL):** sin multi-cliente (`campaigns` no lleva organización cliente; una campaña de otra agencia en `tcl|compartida` es visible para la organización cliente TCL por contrato); sin entidad `Publication` (producción/publicación = «no disponible»); el filtro de texto libre del Brief es una heurística fail-closed (puede omitir texto legítimo; no sustituye la auditoría de Briefs extraídos antes del P0); canal lateral aceptado: «producto recibido: parcial» implica compromiso mayor que lo entregado; las secciones de la proyección se leen sin transacción única (sin snapshot entre UI y export); el flight de RSC se verificó con `next start` en F10 (sano); las cabeceras globales, HEAD 405, `source:read_shared` y `listOrganizations` se resolvieron en F10 (DEC-051); `listProducts()` sigue sin actor (catálogo global sin PII ni finanzas, ahora detrás de `campaign:create`); el cliente ya no tiene `campaign:read` ni `brief:read` (las pantallas legadas redirigen a `/tcl`).

- **F10 (diferido, no bloqueante):** CSP con `script-src`/nonces y HSTS; `TRUNCATE` permitido al rol de la aplicación sobre tablas de historia y rol de BD superusuario en el compose de desarrollo (el despliegue debe usar un rol sin `SUPERUSER`; QA-F10-07/08); `documentosDe`/`setSourceVisibility` sin filtrar `confidentiality_level='sensible'` (teórico); OIDC real; `source:read` general del Operativo sobre fuentes subidas como archivo; ausencia de entrada de producto para marcar documentos visibles a TCL; `BRIEF_WORKSPACE_V2` pendiente de decisión de producto; sin llamador `registrarTraduccion`/`resolverConflictoDeBrief` (bilingüe F2).

- **Smoke real contra el proveedor de modelo NO ejecutado** (tool calling del chat con `tool_choice`/`require_parameters` y `/modelo/analisis` con JSON mode): todo lo cubierto usa proveedor falso. Con el modo todo-o-nada del análisis, un modelo real podría dar tasa alta de salidas inválidas.
- **Gateway del worker sin autenticación** (secreto compartido pendiente). `after()` no es durable (cubierto por un barrido perezoso). Sin límite de tasa por usuario, sin kill-switch por organización, `/extraccion` sin kill-switch (`AI_ENABLED` solo aplica al chat y a los endpoints de modelo). Sin streaming ni resumen de conversación.
- **Prettier legacy: 17 archivos** de `apps/web`, `globals.css` y `docker-compose.yml` anteriores a V2 o tocados en F6; **no reformatear** hasta cerrar el rediseño frontend. Todo archivo que se toque debe pasar Prettier.
- **F5:** `applyInfluencerImport`/`resolveImportRecord` no son una sola transacción global (garantía `idempotent_external`, ejecuciones externas acotadas por proceso).
- **F7 UI:** más de 200 comentarios o versiones se truncan (QA-F7-UI-03/04, con prueba marcada como abierta); cabeceras globales y origen estricto resueltos en F10; pendientes `script-src`/nonces y HSTS (QA-F10-04).
- **F7 producto:** sin texto pegado en el chat como guion (el guion entra como adjunto); sin descarga de originales ni visor; sin triage ni resolución de hallazgos; el análisis es síncrono (hasta ~100 s) y la página no sondea; STALE por cambio de alcance de producto solo se detecta al aprobar.
- **Sesgo de automatización:** un guion con inyección que provoque «sin hallazgos» produce una tarjeta sin hallazgos; la decisión sigue siendo humana (los hallazgos informan, no aprueban ni bloquean).
- Cancelar un Brief aprobado no invalida los guiones ya aprobados contra él. El Operativo conserva `source:read` general (se excluyen los guiones no aprobados); `audit:read` puede ver nombres de archivo.
- EN no obligatorio para aprobar; legado bilingüe `conflict/orphan` sin herramienta de resolución; columnas y estados legacy del Brief (`client_review`, `client_changes_requested`, `brief_versions.language`/`translation_of_id`) siguen en el esquema.
- Permisos mayormente rol→acción (sin permisos por entidad/campaña/campo); `confidentiality_level` y roles `analista`/`legal` (latentes, sin usuarios ni UI) sin revisar; `comment:client_visible` se retiró en F10; la UI muestra los controles según la capacidad del rol (F10) y el stepper dice «Revisión interna».
- Documentos históricos (`HANDOFF.md` del 24-sep y D0-03/07/08/12/18/19 describen el modelo previo a V2; llevan banner «histórico» desde F10); `packages/db/src/influencer-import.ts` (~2 000 líneas) candidato a dividirse.

## 7. Reglas de desarrollo (vigentes para F8 en adelante)

1. **Cada fase empieza con un preflight/auditoría de contratos, no con código**; se congela la arquitectura antes de lanzar implementadores.
2. **Reglas congeladas** (ver [`HANDOFF-Fase-8`](../handoffs/HANDOFF-Fase-8.md) §4): TCL solo lee; la IA nunca aprueba; HITL; aislamiento por organización; el chat produce estructura; un dato existe una sola vez.
3. **Anti-duplicación:** tool → caso de uso existente; runtime → orquestación; dominio/base → reglas. Prohibido duplicar permisos, tenant checks, máquinas de estado, HITL, versionado, matching, provenance, visibilidad o aprobación.
4. **Migraciones:** forward-only y aditivas; no se tocan las aplicadas; prueba desde cero y upgrade con datos.
5. **Ejecución con subagentes:** ver [`AGENT_EXECUTION_POLICY`](AGENT_EXECUTION_POLICY.md).
6. **Git:** commits atómicos (la línea `Co-Authored-By` del sistema al final del mensaje); desarrollo en la rama `v2`; **no se hace push ni merge a `main`** sin instrucción explícita; no `--force`; no `git stash`.
7. **Seguridad:** nada de credenciales, `.env`, claves de Google u OpenRouter, `.storage/` ni datos reales en Git ni en pruebas.
8. Al cerrar una fase: reporte con HEAD inicial/final, commits, cifras exactas de pruebas, riesgos y qué NO se hizo; DEC nueva y nota técnica; el estado de este archivo se actualiza.
