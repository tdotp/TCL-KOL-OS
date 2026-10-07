# TCL KOL OS V2 — Handoff para la Fase 9 (Dashboard TCL, solo lectura)

Documento autosuficiente. **Reemplaza en vigencia** al [handoff de la Fase 8](HANDOFF-Fase-8.md) (histórico) y a `HANDOFF.md` (24-sep, anterior a V2). Léelo completo antes de tocar nada; después, el workflow funcional.

> **Estado: la Fase 9 NO se ha iniciado ni diseñado.** Este documento fija el punto de partida, las invariantes y los contratos que deja la F8. La F9 se retoma **desde una sesión local** de Claude Code sobre el repositorio; nada de lo que sigue depende de un entorno cloud.

## 1. Cómo arrancar (local)

```bash
git clone https://github.com/tdotp/TCL-KOL-OS.git && cd TCL-KOL-OS   # o, en un clon existente:
git switch v2 && git pull --ff-only                                    # F9 se desarrolla en v2, NUNCA en main
git rev-parse HEAD; git log --oneline -3                               # el tag v2-f8-complete marca el cierre certificado de la F8; el último commit de código es 7afdab7
```

Orden de lectura: [`docs/README.md`](../README.md) → [workflow funcional V2](../product/TCL_KOL_OS_V2_WORKFLOW_FUNCIONAL.md) (**no se reinterpreta**; §3 «Cliente — TCL» es lo que toca la F9) → [`V2_CURRENT_STATE`](../project/V2_CURRENT_STATE.md) (estado técnico, entorno local, baseline de pruebas, deudas) → este handoff → [`decision-log`](../decisions/decision-log.md) DEC-042…049 → notas técnicas ([operación y KPIs](../product/OPERATIONS_KPI_V2.md), [contenido](../product/CONTENT_V2.md), [chat y agente](../product/CHAT_AGENT_V2.md), [influencer](../product/INFLUENCER_MODEL_V2.md), [bilingüe](../product/BILINGUAL_MODEL_V2.md), [ingestión](../product/INGESTION_SPREADSHEETS_V2.md), [Sheet V1](../product/INFLUENCER_SHEET_V1.md), [importación de Sheets](../product/GOOGLE_SHEETS_IMPORT_V2.md)) → [`AGENT_EXECUTION_POLICY`](../project/AGENT_EXECUTION_POLICY.md).

## 2. Estado

| | |
|---|---|
| Rama | `v2` (nunca `main`) |
| HEAD de cierre de F8 | el HEAD de `v2` que contiene este documento, etiquetado **`v2-f8-complete`** (gate completo certificado el 7-oct-2026; ver §2b) |
| Último commit de CÓDIGO de F8 | `7afdab7` (los posteriores son solo herramientas y documentación) |
| HEAD inicial de F8 | `a4a8dd5` (tag `v2-f7-complete`, intacto) |
| `origin/main` | `2452283` («Rediseño v3»), publicado antes de V2, **intacto** |
| Migraciones | `001`…`033` (siguiente: **034**) |
| Decisiones | hasta **DEC-049** (siguiente: **DEC-050**) |
| Fases cerradas | **F0, F1, F1.1, F2, F3, F4, F5, F6, F6.1, F7, F8**. Siguiente: **F9**; luego F10 (limpieza) |

Baseline de pruebas certificado (detalle en `V2_CURRENT_STATE` §4): domain 823 · agent 591 · web 121 · db 1885 · worker 799 · E2E oficial 78/78; lint, typecheck, build, ruff y mypy verdes; migraciones 001→033 + seed y upgrade 025→033 (md5 idéntico).

### 2b. Certificación de la F8 (completada)

La F8 se certificó el 7 de octubre de 2026 en local con [`scripts/f8-verificacion.sh`](../../scripts/f8-verificacion.sh) (todos los pasos, con logs y `summary.txt`) y se etiquetó `v2-f8-complete` (no se movió `v2-f7-complete`). Resultados y mutaciones (9 de 10 originales detectadas; la #7 original enmascarada por una defensa de la base y sustituida por una equivalente detectada; ver [`scripts/f8-mutaciones.py`](../../scripts/f8-mutaciones.py)): `V2_CURRENT_STATE` §4. Para repetirlo: `psql` en el PATH (o un adaptador a `docker exec`), una `tclkolos_test` recién migrada y sembrada, el venv del worker y Chrome para Playwright; `DB_BASE=postgresql://tclkolos:devpassword@localhost:5434 scripts/f8-verificacion.sh <directorio-de-logs>`.

El cierre encontró y corrigió un **bloqueante de seguridad**: el texto de los fragmentos de snapshots del Sheet anteriores a la lista blanca (con `fee`, `canje`, `condiciones` y columnas desconocidas) se leía por la búsqueda, la lectura de fuentes, el agente, TCL y el insumo del Brief mientras el snapshot fuera el vigente. Ahora esos fragmentos no se leen por ningún camino hasta re-sincronizar el Sheet (`V2_CURRENT_STATE` §4).

## 3. Qué dejó la Fase 8 (Operación + KPIs, DEC-049)

Todo cuelga de `campaign_influencers` (nunca una identidad paralela). Detalle y tablas en [`OPERATIONS_KPI_V2`](../product/OPERATIONS_KPI_V2.md).

- **Agreement** (`agreements` + `agreement_versions` + `agreement_product_commitments`): una por participación; modo `fee | barter | mixed`; términos materiales inmutables, un cambio es una versión N+1 con motivo; compromisos de producto por versión (≠ asignación ≠ envío ≠ entrega).
- **fee/barter/mixed:** barter ⇒ sin monto ni moneda; fee/mixed ⇒ monto > 0 y moneda ISO. **Barter puro ⇒ obligación de pago `not_applicable`** (constraint diferido en la base).
- **Shipment / OperationalEvent:** `pending → prepared → shipped → delivered` (+ `failed | returned | cancelled`). Todo cambio de estado de envío, documento y obligación entra por un `operational_events` append-only (idempotente, `expected_seq`, `origin='ui'`); un UPDATE directo de `status` falla.
- **Facturación y pago como SEGUIMIENTO:** `billing_documents` (registrado → validado | rechazado | anulado) y `payment_obligations` (`not_applicable | pending | reported_paid | cancelled`). **Payment tracking ≠ payment execution**: `reported_paid` = una persona con `payment:report` (admin, operativo), por `ui`, registró fecha, referencia externa y evidencia. Nada ejecuta dinero.
- **Evidencia = Sources:** `source_type='soporte_operativo'`, siempre `sensible`, interna, sin jobs ni fragmentos; excluida de listados, búsqueda, extracción, agente y adjuntos del chat.
- **PII (DEC-013):** `influencer_pii_records` (por persona) cifrada AES-256-GCM en la aplicación (claves `PII_ENCRYPTION_KEYS` / `PII_INDEX_KEY`), append-only; el envío solo guarda `pii_record_id`; `pii:read`/`pii:manage` solo admin y operativo; cada revelación se audita sin valores.
- **KPI:** `kpi_targets` (objetivo pactado, supersession) ≠ `kpi_measurements` (inmutables; corrección = fila nueva con motivo). Catálogo cerrado de métricas con unidad; comparación solo con métrica+unidad+ámbito compatibles. El `kpi_objetivo` del Sheet es sugerencia con procedencia.
- **Operativo workspace:** `/campanas/[id]/operacion` y `/campanas/[id]/operacion/[participacionId]` (acuerdo, logística, facturación/pagos, contenido, KPIs); las secciones sin capacidad no existen en la respuesta ni en el DOM.
- **Permisos:** `operations:read`, `agreement:read|manage`, `finance:read`, `shipment:read|manage`, `billing:manage`, `payment:report`, `pii:read|manage`, `ops_evidence:attach`, `kpi:read|target_manage|measure`. El Operativo no obtiene `script:*`, `brief:*`, `chat:*` ni hallazgos; cliente, analista y legal nada.
- **Agente de Cuenta (36 → 42 tools):** `operations_summary_list`, `operations_participation_status`, `kpi_scoreboard_get`, `kpi_history_get`, `sheet_kpi_pactado_get` (lectura) y `kpi_target_register` (única escritura). DTO sin dinero, pagos ni PII por construcción. Prompt `agente-cuenta-4`. El worker admite 64 tools (`MAX_TOOLS`).
- **Read models:** `obtenerResumenOperativoDeCampana`, `obtenerEstadoOperativoDeParticipacion` (por capacidad), variantes `…ParaAgente`, `obtenerKpiDeParticipacion` (bloques `public`/`internal`), `obtenerHistorialDeKpi`, `obtenerResumenKpiDeCampana`.

## 4. Invariantes congeladas (no se reabren sin una DEC nueva)

Las 13 del [handoff F8 §4](HANDOFF-Fase-8.md) siguen vigentes (TCL solo lee; la IA nunca aprueba; aislamiento por organización y campaña; el chat produce estructura; tool → caso de uso; originales conservados; versionado; bilingüismo; Influencer ≠ CampaignInfluencer; hallazgos ≠ revisión ≠ decisión; un dato existe una sola vez; contenido no confiable; migraciones forward-only). La F8 añade:

1. **Payment tracking ≠ payment execution** (DEC-014 precisada por DEC-049): el sistema no ejecuta pagos ni mueve dinero.
2. **Barter puro ≠ pago pendiente**: obligación `not_applicable`, sin documentos ni reporte posibles.
3. **La PII queda fuera del agente, del índice vectorial, de la auditoría y de CampaignInfluencer/Shipment**; solo por `pii:read` explícito, por acción humana en la UI.
4. **El Operativo no aprueba ni revisa contenido** ni administra el agente.
5. **TCL no ve información financiera ni PII**: fee, términos monetarios, facturas, pagos, costos internos y de envío, direcciones, notas y evidencia interna.
6. **Historia no destructiva**: versiones de acuerdo, eventos, mediciones y PII son append-only; corregir = nueva fila.
7. **Tool → caso de uso**; ninguna tool de operación escribe estado operativo (solo `kpi_target_register`).
8. **Solo personas por canal `ui`** cambian estado operativo; chat/sistema/IA jamás.

## 5. Migraciones de la F8

| Migración | Introduce |
|---|---|
| `026_tipo_fuente_soporte_operativo` | `source_type = soporte_operativo` |
| `027_acuerdos` | agreements, versiones, compromisos de producto, payment_obligations, `operaciones_exigir_rol` |
| `028_pii_kol` | `influencer_pii_records` cifrada, blind index |
| `029_envios` | shipments, items, guard de producto asignado |
| `030_facturacion_pagos` | billing_documents |
| `031_eventos_operativos` | operational_events, operational_evidence, triggers de estado, guards de fuentes |
| `032_kpis` | kpi_targets, kpi_measurements |
| `033_endurecimiento_operacion` | congela historia de envíos, rechaza NaN, revalida producto en `shipped`, PII vigente, `created_at` de evidencia |

## 6. Contratos listos para la F9 (solo intención; NO se diseñó ni implementó nada)

**F9 = dashboard / proyección read-only para TCL** (workflow §3). Punto de partida disponible:

- `packages/domain/src/tcl-projection-operacion.ts`: tipo `ProyeccionTclDeOperacion`, `CLAVES_PROHIBIDAS_TCL` y `proyectarOperacionParaTcl(entrada)` (construye la salida solo desde una entrada pública; hay prueba de que ninguna clave prohibida llega a la salida). Sin ruta ni acceso hoy.
- `obtenerKpiDeParticipacion().public` es el único bloque de KPI apto para TCL; `internal` (actor, motivo, procedencia) nunca sale. Capacidad reservada y sin asignar: `kpi:read_client`.
- Estado de contenido: leer **solo** la fila `approved` de cada entregable (índice único parcial, F7) y su estado; nunca borradores, versiones rechazadas, hallazgos, comentarios ni internals de IA. Exponer la **fuente** de un guion aprobado a TCL sigue siendo una decisión humana explícita.
- Estado del producto para TCL («producto recibido sí/no/parcial»): derivable de envíos `delivered` vs compromisos; **nunca** transportadora, tracking, costo ni dirección.
- Para el cliente, el filtrado se hace **en el servidor, por capacidad nueva y proyección propia** (espejo de `source:read_shared`); las secciones sin permiso no se consultan. Los read models operativos actuales **no** se reutilizan con menos campos: se construye un tipo explícito nuevo.
- Hoy el cliente TCL tiene solo `campaign:read`, `source:read_shared`, `brief:read`, `brief:export` y recibe 404 en contenido y operación.

## 7. Deuda conocida (solo pendientes reales)

- **PII:** cripto-borrado (`erased_at`) y política de retención (exigida por DEC-013) sin implementar; sin procedimiento documentado de rotación de claves; los originales de evidencia en almacenamiento no están cifrados (mitigado: `sensible`, internos, sin extracción).
- **Snapshots antiguos del Sheet:** conservan `fee/canje/condiciones` en el texto de sus fragmentos (inmutables), pero ninguna lectura los devuelve (guarda en `fragment-scope.ts`); para recuperar el texto hay que re-sincronizar el Sheet, y su borrado físico, si se quiere, exige un procedimiento explícito (no hay migración que lo haga). Los Briefs extraídos antes del P0 podrían contener texto derivado: auditarlos en una base con datos reales.
- Pagos en cuotas o parciales no modelados (una obligación = un reporte); un acuerdo cancelado bloquea uno nuevo en la misma participación (decisión de diseño a revisar); la idempotencia de versiones de acuerdo y de guardado de PII es por contenido (sin columna de clave).
- KPI: CSV, sincronización con hojas de resultados e integraciones sociales diferidos; columnas de procedencia de mediciones nulas; sin tope de eventos/documentos/mediciones por sujeto; el grounding de `kpi_target_register` es conservador (rechaza frases ambiguas).
- UI: sin `retractarEvidencia`, sin descarga de originales; el nav muestra «Editar» al Operativo (el servidor lo niega); verificación visual solo por E2E (no hay pruebas de render de componentes).
- Oráculo por hash en `uploadSource` (confirma que existe una evidencia con esos bytes); archivos huérfanos en disco si una transacción aborta; el rol de aplicación es superusuario en desarrollo.
- Heredadas (ver `V2_CURRENT_STATE` §6): smoke real contra el proveedor de modelo y contra Google sin ejecutar, gateway del worker sin autenticación, sin límite de tasa por usuario, sin kill-switch por organización, Prettier legacy (17 archivos; no reformatear), sin cabeceras de seguridad globales, `x-forwarded-host` en la subida de guiones.

## 8. Notas históricas de la F8 (entorno de verificación)

La F8 se implementó y certificó en una VM cloud efímera; **no es un requisito de la F9**. Diferencias que afectaron las pruebas y que no se versionan: Postgres 16 del sistema con `postgresql-16-pgvector` en lugar de Docker; venv de Python 3.11 para el worker; un symlink local a Chromium para el `channel: 'chrome'` de Playwright; el fixture `fixtures/spreadsheets/campana-influencers.xlsx` está en `.gitignore` y se genera con `python fixtures/spreadsheets/generar_fixtures.py` antes de correr `packages/db` (sin él fallan 3 pruebas de `spreadsheet-ingestion`); una base sembrada es necesaria antes de las pruebas de db (`npm run seed`). Las pruebas de PII usan claves de prueba solo si la base termina en `_test`.

## 9. Reglas para el agente que retome

1. Verifica el repo antes de asumir (HEAD, rama `v2`, `git status`); la documentación histórica está desactualizada.
2. **Preflight primero** (política de agentes §3): inventario de lo reutilizable (proyección de contenido aprobado F7, read models F8, `source:read_shared`), búsqueda de modelos equivalentes y recién entonces proponer; congelar la arquitectura antes de implementar. No reinterpretes el workflow §3.
3. Sigue [`AGENT_EXECUTION_POLICY`](../project/AGENT_EXECUTION_POLICY.md) (subagentes con esfuerzo alto para dominio/seguridad/QA, QA adversarial independiente, el principal controla Git).
4. No hagas push, merge ni PR sin instrucción explícita; **nunca a `main`**; no `--force`; no `git stash`.
5. Cierra con DEC-050, nota técnica, actualización de `V2_CURRENT_STATE` y reporte; **detente y espera revisión** antes de la F10.
