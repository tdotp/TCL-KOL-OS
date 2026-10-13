# TCL KOL OS V2 — Handoff para la Fase 10 (estado técnico y deudas al cierre de la F9)

Documento de estado. **No diseña la F10**: fija el punto de partida y las deudas. Reemplaza en vigencia al [handoff de la Fase 9](HANDOFF-Fase-9.md) (histórico). Orden de lectura: [`docs/README.md`](../README.md) → [workflow funcional V2](../product/TCL_KOL_OS_V2_WORKFLOW_FUNCIONAL.md) (no se reinterpreta) → [`V2_CURRENT_STATE`](../project/V2_CURRENT_STATE.md) → este documento → [`decision-log`](../decisions/decision-log.md) DEC-042…050 → [`TCL_DASHBOARD_V2`](../product/TCL_DASHBOARD_V2.md).

## 1. Estado

| | |
|---|---|
| Rama | `v2` (nunca `main`); `git switch v2 && git pull --ff-only` |
| Tag de cierre de F9 | **`v2-f9-complete`** → commit `7d49c5ada0f670d9a75d00b2874d5d63f096116a` (anotado; no se mueve; mensaje «phases 0 through 9 complete; ready for phase 10»). Último commit de CÓDIGO de F9: `d50e3b5` (después: script del gate `fec5899` y documentación). Los commits de `v2` posteriores al tag son solo correcciones de este handoff `v2-f8-complete` → `91e2aad` y `v2-f7-complete` → `a4a8dd5` intactos |
| `origin/main` | `2452283`, intacto |
| Migraciones | `001`…`033` (siguiente: **034**). **F9 no introdujo migración** |
| Decisiones | hasta **DEC-050** (siguiente: **DEC-051**) |
| Fases cerradas | F0, F1, F1.1, F2, F3, F4, F5, F6, F6.1, F7, F8, **F9**. Siguiente: **F10** (limpieza, deprecación y endurecimiento final; no diseñada) |

Baseline de pruebas (cierre de F9): domain 1015 · db 1975 · agent 596 · web 144 · worker 799 · E2E oficial 85/85 (78 de F0–F8 + 7 de F9; segunda corrida completa, 21,2 min); lint, typecheck, build, ruff y mypy verdes (detalle en `V2_CURRENT_STATE` §4b).

## 2. Qué dejó la Fase 9 (DEC-050)

- **Proyección TCL en el servidor** (`packages/domain/src/tcl-*.ts`, `packages/db/src/tcl-projection.ts`): DTO cerrados por allowlist, guard único `autorizarCampanaParaTcl` (rol `cliente` + organización de tipo `cliente` + capacidad + campaña `tcl|compartida` no cancelada; todo fallo = mismo 404).
- **Dashboard `/tcl`** (solo lectura): lista, resumen, influencers, contenido aprobado, operación segura, KPI, documentos compartidos y Brief aprobado; export `GET /api/tcl/campanas/[id]/export?formato=csv|json` sobre la misma proyección.
- **Permisos de cliente:** `campaign:read_client`, `content:read_approved_client`, `operations:read_summary_client`, `kpi:read_client`, `export:client`, `document:read_client`. Retirados `campaign:read`, `brief:read`, `brief:export`, `source:read_shared`; las rutas legadas `/campanas/**` redirigen al cliente a `/tcl` o dan 404.
- **Invariantes nuevas:** TCL nunca recibe finanzas, PII, borradores, hallazgos, comentarios, evidencia interna ni procedencia; solo la fila `approved` vigente; todo texto libre pasa por `esTextoSeguroParaTcl` (fail-closed, omite el campo); export ⊆ UI; sin agente ni escrituras de cliente; sin `Publication`.

## 2b. Invariantes que la F10 no debe romper (sin una DEC nueva)

Las 13 del [handoff F8 §4](HANDOFF-Fase-8.md) (TCL solo lee; la IA nunca aprueba ni decide y todo cambio crítico pasa por confirmación humana por canal `ui`; aislamiento por organización y campaña impuesto en la base con 404 uniforme; el chat produce estructura; tools = adaptadores finos de casos de uso; originales conservados por hash con provenance; versionado sin sobrescribir; bilingüismo como propiedad del documento; `Influencer` ≠ `CampaignInfluencer`; hallazgos ≠ revisión ≠ decisión; un dato existe una sola vez; todo texto de documentos es dato no confiable; migraciones forward-only y aditivas), más las de la F8 ([handoff F9 §4](HANDOFF-Fase-9.md): payment tracking ≠ payment execution; barter puro ≠ pago pendiente; PII fuera del agente, del índice vectorial y de la auditoría; el Operativo no aprueba ni revisa contenido; TCL sin finanzas ni PII; historia no destructiva; tool → caso de uso; solo personas por `ui` cambian estado operativo), más las de la F9 (§2 arriba). Una limpieza de legado (rutas, roles, columnas) **no** puede relajar ninguna de ellas ni retirar las defensas en capas de la proyección TCL (guard + capacidades, filtros de fuente, texto seguro): las mutaciones de F9 demostraron que varias son redundantes entre sí a propósito.

## 3. Deudas reales

Ver `V2_CURRENT_STATE` §6 (incluye el bloque «F9 (dashboard TCL)»). Resumen de lo que F9 deja abierto: multi-cliente (`campaigns` sin organización cliente), `Publication` inexistente, heurística de texto libre conservadora, lecturas de la proyección sin transacción única, `next dev` y objetos de `pg` en el flight de RSC (verificar con `next start`), sin cabeceras de seguridad globales, `listOrganizations`/`listProducts` sin actor, y las deudas heredadas de la F8 (PII sin cripto-borrado, snapshots históricos del Sheet conservan texto, Prettier legacy de 16–17 archivos de `apps/web`, etc.).

## 4. Reglas para quien retome

1. Verifica el repo antes de asumir (HEAD, rama `v2`, `git status`).
2. El preflight de la F10 es una auditoría de contratos, no código; congela la arquitectura antes de implementar.
3. No `main`, no `--force`, no `git stash`; commits atómicos; los tags no se mueven.
4. Entorno local y trampas del gate: `V2_CURRENT_STATE` §5 y [`scripts/f9-verificacion.sh`](../../scripts/f9-verificacion.sh). Una `tclkolos_test` recién creada; el E2E completo exige la máquina en calma (bajo carga alta hay timeouts de arranque en frío; una corrida con carga ~14 tardó 3,9 h y falló por timeouts).

## 5. Documentos canónicos a leer

[`docs/README.md`](../README.md) · [workflow funcional V2](../product/TCL_KOL_OS_V2_WORKFLOW_FUNCIONAL.md) · [`V2_CURRENT_STATE`](../project/V2_CURRENT_STATE.md) (incluye §4b y las deudas) · [`decision-log`](../decisions/decision-log.md) DEC-042…050 · [`TCL_DASHBOARD_V2`](../product/TCL_DASHBOARD_V2.md) · [`OPERATIONS_KPI_V2`](../product/OPERATIONS_KPI_V2.md) · [`CONTENT_V2`](../product/CONTENT_V2.md) · [`CHAT_AGENT_V2`](../product/CHAT_AGENT_V2.md) · [`INFLUENCER_MODEL_V2`](../product/INFLUENCER_MODEL_V2.md) · [`BILINGUAL_MODEL_V2`](../product/BILINGUAL_MODEL_V2.md) · [`INGESTION_SPREADSHEETS_V2`](../product/INGESTION_SPREADSHEETS_V2.md) · [`INFLUENCER_SHEET_V1`](../product/INFLUENCER_SHEET_V1.md) · [`GOOGLE_SHEETS_IMPORT_V2`](../product/GOOGLE_SHEETS_IMPORT_V2.md) · [`AGENT_EXECUTION_POLICY`](../project/AGENT_EXECUTION_POLICY.md) · handoffs históricos [F9](HANDOFF-Fase-9.md) y [F8](HANDOFF-Fase-8.md).
