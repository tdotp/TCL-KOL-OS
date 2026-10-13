# TCL KOL OS — Handoff post-V2: Release Readiness

Documento canónico para continuar **después** de V2. No describe el producto (eso es el [workflow funcional](../product/TCL_KOL_OS_V2_WORKFLOW_FUNCIONAL.md)) ni repite el estado final ([`V2_FINAL_STATE`](../project/V2_FINAL_STATE.md)): fija qué leer, qué sigue y qué deuda está abierta. Un chat nuevo debe poder empezar solo con este archivo y lo que enlaza.

## 1. Estado oficial

| | |
|---|---|
| Roadmap V2 | **F0–F10 completas y certificadas** (veredicto F10: PASS_WITH_NOTES) |
| Rama | `v2` (`git switch v2 && git pull --ff-only`) |
| HEAD certificado | `1ec2185` (puede haber commits posteriores solo documentales; el tag no se mueve) |
| Tag de cierre | `v2-f10-complete` → `1ec2185` (anotado: «TCL KOL OS V2 — phases 0 through 10 complete») |
| Tags anteriores (intactos) | `v2-f7-complete` → `a4a8dd5` · `v2-f8-complete` → `91e2aad` · `v2-f9-complete` → `7d49c5a` |
| Última migración | `033_endurecimiento_operacion.sql` (F9 y F10 no introdujeron migración; siguiente: `034`) |
| Última decisión | **DEC-051** (siguiente: DEC-052) |
| `main` / `origin/main` | `2452283`, **intacto** (lo publicado antes de V2) |
| Merge a `main` | **NO realizado** |
| Deploy | **NO realizado** |

## 2. Qué está terminado (resumen; detalle en `V2_FINAL_STATE` y notas técnicas)

- **Cuenta** (admin/director/consultor): construye y decide; aprobaciones humanas por canal `ui`.
- **Operativo:** acuerdos, logística, seguimiento de facturación/pagos (tracking ≠ ejecución), KPIs reales, PII de entrega cifrada; sin autoridad creativa.
- **TCL (`cliente`):** dashboard `/tcl` y export solo lectura, sobre proyección positiva del servidor (0 finanzas, 0 PII, solo lo aprobado).
- **Agente / HITL:** agente de Cuenta con 42 tools (adaptadores finos de casos de uso); `proposed_actions` que solo confirma una persona por `ui`; el agente no ve PII ni decide.
- **Sources:** originales por hash, localizadores, XLSX/CSV, Google Sheet con snapshots inmutables; guarda de fragmentos históricos y cita de evidencia servible.
- **Brief** (bilingüe ES/EN, una versión lógica), **Influencer / CampaignInfluencer**, **Contenido** (guiones versionados, revisión contra el Brief, aprobación humana), **Operación**, **KPI** (objetivo ≠ medición).
- **F10 (DEC-051):** limpieza de legado sin enforcer, navegación única por capacidades, login de desarrollo cerrado por defecto en producción, cabeceras de seguridad básicas, origen estricto en subidas, HEAD 405 en el export, QA adversarial (0 P0/0 P1 abiertos) y mutaciones.

## 3. Deuda abierta

### 3.1 SECURITY / RELEASE BLOCKERS (bloquean producción)

- **Autenticación productiva / OIDC** sin implementar (en producción nadie inicia sesión salvo `AUTH_PROVIDER=dev`, que **no** debe usarse).
- **Gateway del worker sin autenticación** (`/extraccion`, `/modelo/*`).
- **Rol de BD de producción con mínimo privilegio:** retirar `SUPERUSER`, la propiedad de las tablas y la capacidad `TRUNCATE` sobre las tablas de historia (QA-F10-07/08; las garantías de inmutabilidad son triggers que un superusuario puede anular).
- **CSP completa** (`script-src` con nonces/hashes) pendiente (QA-F10-04).
- **HSTS** pendiente (y TLS en el proxy; el proxy debe conservar `Host`).
- **Secretos productivos** (`SESSION_SECRET` ≥ 16, `PII_ENCRYPTION_KEYS`, `PII_INDEX_KEY`, `AGENT_NONCE_SECRET`, claves de modelo y Google): gestión y rotación.
- **Smoke real del proveedor de modelo** (tool calling del chat y JSON mode del análisis; todo lo certificado usa proveedor falso).
- **Smoke real de Google** (Sheets/Drive con credenciales reales).
- **Staging con `next start`** (build de producción) y verificación de cabeceras.

### 3.2 TECHNICAL DEBT

- PII: retención y cripto-borrado sin implementar; rotación de claves sin procedimiento; originales de evidencia sin cifrar en disco.
- Lecturas de la proyección TCL sin transacción única (sin snapshot entre UI y export).
- RSC: `next dev` incrusta en el flight de depuración resultados crudos de `pg` (solo desarrollo; con `next start` no ocurre; puede hacer fallar E2E-27a bajo carga).
- Deuda bilingüe F2 (EN no obligatorio, `conflict/orphan` sin resolución, columnas legadas, `registrarTraduccion` sin llamador).
- `BRIEF_WORKSPACE_V2` pendiente de decisión (conservada como rollback).
- Análisis de contenido síncrono (~100 s) sin sondeo; más de 200 comentarios/versiones se truncan.
- Prettier legacy en archivos de `apps/web` anteriores a V2.
- `documentosDe` / `setSourceVisibility` sin filtro `confidentiality_level='sensible'` (QA-F10-01, teórico).
- Defensa SQL de `proposed_actions`: el trigger valida la transición pending→confirmed pero no quién la hace (QA-F10-06; ninguna tool tiene SQL).
- `source:read` general del Operativo (y de `analista`/`legal`, sin usuarios) sobre fuentes subidas como archivo.
- Sin límites por sujeto (eventos, documentos, mediciones) ni límite de tasa por usuario; `after()` no durable (cubierto por barrido perezoso).

### 3.3 PRODUCT BACKLOG (no es deuda técnica)

Multi-cliente (`campaigns` sin organización cliente) · entidad `Publication` · pagos parciales/en cuotas · Agent TCL · Agent Operativo completo · integraciones sociales y KPI por CSV/Sheets/APIs · traducción automática como feature · UI para marcar documentos visibles a TCL · scraping · triage de hallazgos, descarga/visor de originales.

## 4. Orden recomendado post-V2

1. Security headers / release config (CSP completa, HSTS, configuración de producción).
2. DB least privilege (rol sin superuser ni `TRUNCATE`; propiedad de tablas).
3. Worker gateway auth (secreto compartido y red privada).
4. Google OAuth / OIDC.
5. Production smoke harness (`next build` + `next start`, E2E de seguridad contra producción).
6. Provider smokes reales (modelo y Google).
7. Staging.
8. UAT.
9. GO / NO-GO.
10. Merge controlado a `main`.
11. Producción.

Nada de esto está implementado; son decisiones y trabajo de un bloque nuevo.

## 5. Primer bloque recomendado

Trabajar en una **rama nueva a partir de `v2-f10-complete`** (p. ej. `release-readiness` o `hardening/post-v2`), **no** sobre `v2` ni sobre `main`. No existe todavía: créala al empezar. Empieza por el punto 1 y 2 del orden anterior; cada punto con su propia prueba y, si toca esquema, una migración `034` aditiva probada desde cero y como upgrade con datos.

## 6. NO PROD hasta completar como mínimo

Auth productiva · worker auth · DB least privilege · secretos · staging · `next start` · smoke de proveedor de modelo · smoke de Google · backups · rollback · verificación de cabeceras (CSP, HSTS, `X-Frame-Options`, `nosniff`, `Referrer-Policy`).

## 7. Qué leer (en este orden)

1. [`V2_FINAL_STATE`](../project/V2_FINAL_STATE.md) — estado final, actores, prerrequisitos operativos, deuda.
2. [`V2_CURRENT_STATE`](../project/V2_CURRENT_STATE.md) — entorno local, gate, trampas, deudas detalladas, reglas de desarrollo.
3. Este handoff.
4. [Workflow funcional V2](../product/TCL_KOL_OS_V2_WORKFLOW_FUNCIONAL.md) — no se reinterpreta.
5. [Registro de decisiones](../decisions/decision-log.md) — DEC-042…051, en especial **DEC-051**.
6. Notas técnicas: [`TCL_DASHBOARD_V2`](../product/TCL_DASHBOARD_V2.md) · [`OPERATIONS_KPI_V2`](../product/OPERATIONS_KPI_V2.md) · [`CONTENT_V2`](../product/CONTENT_V2.md) · [`CHAT_AGENT_V2`](../product/CHAT_AGENT_V2.md).
7. Política de ejecución con agentes: [`AGENT_EXECUTION_POLICY`](../project/AGENT_EXECUTION_POLICY.md).

## 8. Reglas para quien retome

1. Verifica el repo antes de asumir (rama, HEAD, `git status`, tag `v2-f10-complete` en `1ec2185`).
2. No `main` hasta GO/NO-GO; no `--force`; no `git stash`; los tags `v2-f7/f8/f9/f10-complete` no se mueven; commits atómicos.
3. Las invariantes de DEC-042…051 siguen vigentes (TCL solo lee sin finanzas ni PII; la IA nunca aprueba ni confirma; tenant en la base; tool → caso de uso; historia no destructiva; migraciones forward-only). Retirar una defensa «redundante» de la proyección TCL o del guard de fragmentos exige una DEC nueva.
4. Entorno local y trampas del gate: `V2_CURRENT_STATE` §5 y [`scripts/f10-verificacion.sh`](../../scripts/f10-verificacion.sh) (base `tclkolos_test` recién creada; el E2E completo exige la máquina en calma).
5. Archivos sin versionar de la raíz del repo (`HANDOFF-nuevo-chat*.md`, `*.zip`) son restos de sesiones anteriores: no forman parte de V2.
