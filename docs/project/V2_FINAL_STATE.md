# TCL KOL OS V2 — Estado final (cierre de la Fase 10)

> Resumen de cierre del roadmap V2 (fases 0–10). **No sustituye** al [workflow funcional](../product/TCL_KOL_OS_V2_WORKFLOW_FUNCIONAL.md) (qué hace cada actor) ni a [`V2_CURRENT_STATE`](V2_CURRENT_STATE.md) (entorno, gate, deudas detalladas); el detalle de cada área vive en su nota técnica y en el [registro de decisiones](../decisions/decision-log.md) (DEC-042…051).

| | |
|---|---|
| **Rama** | `v2` (nunca `main`) |
| **Tag de cierre** | `v2-f10-complete` (anotado: «TCL KOL OS V2 — phases 0 through 10 complete»); anteriores intactos: `v2-f9-complete` → `7d49c5a`, `v2-f8-complete` → `91e2aad`, `v2-f7-complete` → `a4a8dd5` |
| **`origin/main`** | `2452283`, intacto (lo publicado antes de V2; el merge y el despliegue son una decisión posterior) |
| **Última migración** | `033_endurecimiento_operacion.sql` (F10: **no introdujo migración**) |
| **Última decisión** | **DEC-051** — V2 Finalization / Cleanup Policy |

> **Qué sigue:** [`HANDOFF-Post-V2-Release-Readiness`](../handoffs/HANDOFF-Post-V2-Release-Readiness.md) (Release Readiness; sin merge ni deploy todavía).

## 1. Arquitectura final

Monorepo: `apps/web` (Next.js 15 + React 19), `apps/e2e` (Playwright), `packages/domain` (reglas puras), `packages/db` (Postgres: repositorios y casos de uso), `packages/agent` (registro de 42 tools y runtime del agente de Cuenta), `services/ai-worker` (Python/FastAPI: parsing, Google Sheets, extracción y llamadas de modelo sin estado ni BD).

- **El dominio y la base deciden** (permisos, tenant, estados, versionado, HITL, provenance, visibilidad); el runtime del agente solo orquesta; las **tools son adaptadores finos de casos de uso** (0 SQL, 0 `getPool`/`query(` en `tools/`; todo lo que reutilizan está clasificado en el manifiesto).
- **Aislamiento por organización y campaña** impuesto en la base (claves foráneas compuestas) y 404 uniforme; `audit_events` append-only con `origin = ui | chat | system`.
- **Historia no destructiva:** `ScriptVersion` inmutable, KPI objetivo ≠ medición (corrección = fila nueva), snapshots del Sheet inmutables, eventos operativos append-only, originales preservados por hash.
- **TCL (`cliente`)** solo lee la **proyección positiva del servidor** (`packages/domain/src/tcl-*.ts`, `packages/db/src/tcl-projection.ts`): DTO cerrados por allowlist, texto libre fail-closed, export ⊆ UI, sin agente ni escrituras.

## 2. Actores y fronteras

| Actor | Puede | No puede |
|---|---|---|
| **Cuenta** SmartPR (`admin`/`director`/`consultor`) | Construir y decidir: Brief, fuentes, influencers, contenido, aprobaciones humanas por `ui`; usar el agente de Cuenta | — (dentro de Cuenta, `pii:read` y `payment:report` solo los tiene `admin`) |
| **Operativo** SmartPR | Acuerdos, logística, seguimiento de facturación/pagos, KPIs reales, PII de entrega | Aprobar o revisar contenido, editar el Brief, usar el chat |
| **TCL** (`cliente`) | Leer `/tcl` y su export (solo lo aprobado, client-safe) | Escribir, ver finanzas, PII, borradores, hallazgos, comentarios, evidencia interna o procedencia |
| **Agente** | Proponer; leer proyecciones sin PII ni finanzas | Confirmar sus `ProposedAction`, ver PII, marcar pagos, decidir |
| **System** | Eventos de infraestructura (extracción, barridos) | Aprobar nada humano |

## 3. Dominio implementado

Brief bilingüe (una versión lógica, representaciones ES/EN, una aprobación) · `Influencer` y `CampaignInfluencer` · ingestión de fuentes (PDF/DOCX/XLSX/CSV, fuentes enlazadas, Google Sheet con snapshots) y evidencia con localizador · importación de influencers con plan y resolución humana · chat y agente de Cuenta (HITL con `proposed_actions`) · contenido (entregables, `ScriptVersion`, análisis y revisión contra el Brief, aprobación humana) · operación (acuerdos, logística, facturación y pagos como **seguimiento**, PII cifrada y separada, evidencia operativa) · KPIs (objetivo ≠ medición) · dashboard `/tcl` de solo lectura con export. Detalle: [`V2_CURRENT_STATE` §1](V2_CURRENT_STATE.md).

## 4. Qué cerró la Fase 10

Limpieza (legado sin enforcer o sin llamador, navegación única por capacidades), endurecimiento (login cerrado por defecto en producción, cabeceras globales, origen estricto, HEAD 405, cita de evidencia histórica, secreto de sesión), documentación y certificación. Lista completa en DEC-051.

## 5. Baseline de pruebas (gate canónico [`scripts/f10-verificacion.sh`](../../scripts/f10-verificacion.sh), base `tclkolos_test` recreada 001→033 + seed)

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

**QA adversarial independiente (20 ataques):** 0 P0, 0 P1 abiertos (el único P1, condicional — la cita literal de evidencia histórica, QA-F10-05 — se corrigió); P2/P3 diferidos, fijados como `it.fails` «abierto» en `qa-f10-*.test.ts`.

**Mutaciones (8 garantías críticas; mutar → prueba dirigida → detectar → restaurar):** tenant guard (envíos), allowlist financiera de TCL, allowlist PII de TCL, TCL sin escritura (permisos), frontera agente/HITL (`verificarHumanoConCapacidad`), Operativo sin autoridad creativa, inmutabilidad de `ScriptVersion` (en clon de BD) y guarda de fragmento histórico: **8/8 detectadas**, más una novena sobre el arreglo nuevo de la cita de evidencia (detectada). **Enmascaramiento declarado honestamente:** varias garantías tienen defensas independientes (p. ej. visibilidad: SQL + `isTclVisible`; rol: `role === 'cliente'` + `roleCan`; fuga histórica: guarda de fragmento + filtro del Sheet + cita servible); cada mutación se aplicó a la capa que la prueba dirigida cubre y se detectó, pero **no** se demuestra que la otra capa por sí sola baste; por eso no se retiró ninguna capa redundante (DEC-051 §2).

## 6. Prerrequisitos operativos (antes de cualquier despliegue)

1. **Autenticación:** OIDC (Google Workspace) **no está implementado**. En producción, sin `AUTH_PROVIDER=dev` explícito, nadie inicia sesión (cerrado por defecto). No pongas `AUTH_PROVIDER=dev` en producción.
2. **Secretos:** `SESSION_SECRET` (≥ 16 caracteres), `PII_ENCRYPTION_KEYS` y `PII_INDEX_KEY` (obligatorias fuera de bases `_test`), `AGENT_NONCE_SECRET` (≥ 16), claves del modelo. Nada de esto va en Git.
3. **Rol de base de datos de la aplicación:** **sin** `SUPERUSER`, sin propiedad de las tablas y sin `TRUNCATE` sobre las de historia (el compose de desarrollo usa un superusuario: no es un modelo de producción; QA-F10-07/08). Las garantías de inmutabilidad son triggers: dependen de que el rol no pueda desactivarlos.
4. **Proxy / TLS:** el proxy debe conservar la cabecera `Host` original (la comprobación de origen de las subidas es estricta y no confía en `x-forwarded-host`); terminar TLS y añadir HSTS (no está en la app).
5. **Worker:** el gateway del worker (`/extraccion`, `/modelo/*`) no tiene autenticación: debe quedar en red privada hasta añadir el secreto compartido.
6. **Cabeceras:** la CSP actual es mínima (solo `frame-ancestors`, `base-uri`, `object-src`, `form-action`); un `script-src` con nonces queda pendiente.
7. **Datos históricos:** auditar los Briefs extraídos antes del cierre de F8 en una base con datos reales (pudieron derivarse de fragmentos con `fee`/`canje`); los snapshots antiguos del Sheet siguen en la base (ilegibles por la aplicación) hasta un borrado explícito.
8. **Entorno de pruebas:** Docker con Postgres+pgvector (puerto 5434), venv Python del worker, Google Chrome para Playwright; `tclkolos_test` recién creada para el gate (ver `V2_CURRENT_STATE` §5).

## 7. Deuda conocida (no bloqueante)

- **Seguridad / operación:** OIDC; CSP con `script-src`/nonces y HSTS; `TRUNCATE` y rol superusuario (ver §6.3); autenticación del gateway del worker; límites de tasa por usuario y kill-switch por organización; cripto-borrado, retención y rotación de claves de PII; originales de evidencia sin cifrar en disco; lecturas de la proyección TCL sin transacción única; HEAD/export sin límite de uso por sujeto; `source:read` general del Operativo (y de `analista`/`legal`, sin usuarios) sobre fuentes subidas como archivo; filtro `confidentiality_level='sensible'` en `documentosDe`/`setSourceVisibility` (teórico).
- **Producto:** multi-cliente (`campaigns` sin organización cliente); entidad `Publication`; pagos parciales; sin entrada de producto para marcar documentos visibles a TCL; sin triage de hallazgos, descarga de originales ni visor; bilingüe F2 (traducción automática, EN obligatorio, resolución de `conflict/orphan`); STALE por cambio de alcance de producto solo se detecta al aprobar; cancelar un Brief aprobado no invalida guiones aprobados.
- **Pruebas / entorno:** bajo carga alta, E2E-27a puede fallar en `next dev` porque React/Next incrusta en el flight de depuración resultados crudos de `pg` (solo desarrollo; no ocurre con `next start`); repetir con la máquina en calma. El gate espera una `tclkolos_test` recién creada.
- **UX:** más de 200 comentarios/versiones se truncan; análisis síncrono sin sondeo; `BRIEF_WORKSPACE_V2` pendiente de decisión de producto; Prettier legacy en archivos de `apps/web` anteriores a V2.
- **Integraciones:** smoke real contra el proveedor de modelo no ejecutado (todo usa proveedor falso); KPI por CSV/Sheets/APIs sociales; sin streaming ni resumen de conversación.

## 8. Fuera de alcance de V2

`Publication`, multi-cliente genérico, Agent TCL, Agent Operativo completo, nuevas integraciones sociales, scraping, ejecución de pagos, banca, ERP/contabilidad, traducción automática, rediseño visual, despliegue y merge a `main`.
