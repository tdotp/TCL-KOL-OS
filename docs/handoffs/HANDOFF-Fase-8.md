# TCL KOL OS V2 — Handoff para la Fase 8 (Operación + KPIs)

Documento autosuficiente y compacto. **Reemplaza en vigencia** a los handoffs de chat anteriores (no versionados) y a `HANDOFF.md` (24-sep, anterior a V2: histórico). Léelo completo antes de tocar nada; después, el workflow funcional.

> **Estado: la Fase 8 NO se ha iniciado ni diseñado.** Este documento fija el punto de partida, las reglas y la intención, no la solución.

## 1. Cómo arrancar

```bash
git clone https://github.com/tdotp/TCL-KOL-OS.git && cd TCL-KOL-OS
git switch v2 && git pull --ff-only       # F8 se desarrolla en v2, NUNCA en main
git rev-parse HEAD; git describe --tags    # debe contener el tag v2-f7-complete
```

Orden de lectura: [`docs/README.md`](../README.md) → [workflow funcional V2](../product/TCL_KOL_OS_V2_WORKFLOW_FUNCIONAL.md) (**no se reinterpreta**; §2 y §3.6 son lo que toca la F8) → [`V2_CURRENT_STATE`](../project/V2_CURRENT_STATE.md) (estado técnico, entorno, baseline de pruebas, deudas) → este handoff → [`decision-log`](../decisions/decision-log.md) DEC-042…048 → notas técnicas ([bilingüe](../product/BILINGUAL_MODEL_V2.md), [influencer](../product/INFLUENCER_MODEL_V2.md), [ingestión](../product/INGESTION_SPREADSHEETS_V2.md), [Sheet V1](../product/INFLUENCER_SHEET_V1.md), [importación de Sheets](../product/GOOGLE_SHEETS_IMPORT_V2.md), [chat y agente](../product/CHAT_AGENT_V2.md), [contenido](../product/CONTENT_V2.md)) → [`AGENT_EXECUTION_POLICY`](../project/AGENT_EXECUTION_POLICY.md).

## 2. Estado

- Fases cerradas: **F0, F1, F1.1, F2, F3, F4, F5, F6, F6.1, F7**. Siguiente: **F8**; luego F9 (Dashboard TCL) y F10 (limpieza).
- Rama `v2`; tag `v2-f7-complete`; último commit de código de F7: `2e4b864`; baseline previo a V2: `3dd9da2`; `origin/main` (publicado antes de V2): `2452283`, intacto.
- Migraciones `001`…`025` (siguiente: **026**); decisiones hasta **DEC-048** (siguiente: **DEC-049**).
- Pruebas al cierre de F7: domain 678 · db 1490 · agent 505 · worker 769 · E2E 51/51; lint, typecheck, build, ruff y mypy verdes.

## 3. Arquitectura V2 en una página

Producto: plataforma interna de SmartPR (agencia) para coordinar campañas de influencers («KOL») de TCL (cliente, siempre TCL). **Cuenta construye y decide. Operaciones ejecuta y registra. TCL observa. El agente organiza, analiza y ejecuta tareas autorizadas, pero no sustituye la decisión humana.** Los tres trabajan sobre los mismos datos.

| Fase | Qué dejó | Referencia |
|---|---|---|
| F1 | Visibilidad (`interna`/`tcl`/`compartida`; `resolverAlcanceDeFuentes` es el único punto de decisión de lectura de fuentes), rol `operativo` (solo lecturas internas), auditoría con origen (`audit_events.origin`, `correlation`), HITL con `proposed_actions` (atómico) | DEC-042 y D0 |
| F2 | Documento = una versión lógica con representaciones ES/EN sin estado propio; aprobar congela ES, EN y provenance | DEC-043 |
| F3 | `Influencer` = identidad (cuentas por plataforma+handle normalizado, nunca por nombre); `CampaignInfluencer` = participación (UNIQUE campaña+influencer, `activo`/`retirado`, producto asignado → `campaign_products`) | DEC-044 |
| F4 | `source_documents` (origen `file`/`link`) es la entidad de fuente; originales preservados por hash; `SourceLocator` (`page/slide/section/sheet/row/cell/range/region`); XLSX/CSV; enlaces solo se registran | DEC-045 |
| F5 | Google Sheet de influencers: snapshots inmutables, esquema `TCL_KOL_OS_INFLUENCERS_V1`, plan de importación con matching determinístico, resolución humana append-only | DEC-046 |
| F6 | Chat por campaña, runtime híbrido (Node orquesta; el worker hace UNA llamada de modelo sin estado), 25 tools, HITL ampliado (`influencer_import.*`), contexto selectivo con sobres no confiables, grounding por cita literal | DEC-047 |
| F6.1 | Defensa en profundidad en la base (dueño de la conversación, rol con `chat:write`, propuesta nace `pending`) | DEC-047 |
| F7 | Contenido (ver §5) | DEC-048 |

## 4. Invariantes congeladas (no se reabren sin una DEC nueva)

1. **TCL es de solo lectura.** No aprueba, rechaza, pide cambios ni cambia estados; la comunicación de cambios ocurre fuera del producto. No ve borradores, versiones rechazadas, comentarios internos, hallazgos, conversaciones, prompts, `ai_runs`, fees, cuentas de cobro, pagos ni costos internos (workflow §3.5–3.6). Hasta la F9 el cliente no recibe capacidades nuevas.
2. **La IA nunca aprueba ni decide**, ni el chat ni `system`. Todo cambio crítico: conversación → intención → acción visible → **confirmación humana por canal `ui` con la huella mostrada** → cambio de estado, para una persona autorizada. La IA no es requisito: siempre hay camino sin IA.
3. **Aislamiento por organización y campaña** impuesto en la base (claves foráneas compuestas, triggers). Lo ajeno responde `RESOURCE_NOT_FOUND`, sin distinguir «no existe» de «no autorizado».
4. **El chat produce estructura**, no es una base paralela: lo que se hace por chat alimenta objetos del sistema.
5. **Tools = adaptadores finos de casos de uso existentes.** Sin SQL directo ni lógica de dominio duplicada (ver política anti-duplicación). El modelo nunca aporta organización, campaña, actor, origen ni canal.
6. **Los archivos originales se conservan** (por hash); toda extracción mantiene su **provenance** hasta la fuente.
7. **Versionado obligatorio**: lo sujeto a revisión no se sobrescribe; historial completo.
8. **Bilingüismo como propiedad del documento** generado por la plataforma (una entidad, una versión, un estado, una aprobación, dos representaciones). Un documento recibido se conserva en su idioma original.
9. **`Influencer` ≠ `CampaignInfluencer`**: la participación es el contexto central de contenido, operación y performance.
10. **Hallazgos ≠ revisión humana ≠ decisión de aprobar.** Los hallazgos derivan del Brief y son informativos (no aprueban ni bloquean); los comentarios SmartPR los escribe una persona; la aprobación es de una persona con `script:approve`.
11. **Un dato existe una sola vez**; nada de copias por tipo de usuario.
12. **Todo texto de documentos, hojas, nombres y títulos es dato no confiable**, nunca instrucción; las salidas del modelo se validan por código.
13. **Migraciones forward-only y aditivas**; las aplicadas no se editan.

## 5. Fase 7 final (contenido) — lo que F8 puede reutilizar

- **`Deliverable`** (`deliverables`): pieza de una participación (`campaign_influencers`), etiqueta normalizada única entre activos, `platform` opcional, producto opcional (`campaign_products`), `active|archived`. Sin fee/pago/envío/KPI/acuerdo/publicación.
- **`ScriptVersion`** (`script_versions`): un archivo recibido (`source_documents`, interno, una fuente = una versión), número asignado por la base, nunca se sobrescribe. Estados `received → in_review → changes_requested | approved`, más `superseded`.
- **Aprobada vigente** = la única fila `approved` del entregable (índice único parcial); al aprobar una mayor, la anterior pasa a `superseded` con sus marcas de aprobación intactas. **Latest ≠ aprobada vigente.**
- **Revisión vigente (CURRENT REVIEW)** (`content_analysis_runs`): `ai_assisted` (worker `POST /modelo/analisis`, validador todo-o-nada) o `human` (solo `ui`), ligada a la versión exacta y al **Brief rector** (`obtenerBriefRector`: aprobado vigente, nunca borrador). CURRENT/STALE se deriva al leer. Aprobar la exige; **no** exige cero hallazgos y los hallazgos abiertos no bloquean.
- **Hallazgos** (`content_findings` + refs al requisito del Brief y a la cita del guion): inmutables, sin estado. **Comentarios SmartPR** (`script_review_comments`) y **cambios solicitados**: otra tabla, autor persona, `ui`/`chat` con cita exacta del mensaje.
- **Aprobación:** un solo caso de uso `aprobarScriptVersion` (botón directo y handler HITL `script_version.approve`, atómico), huella obligatoria, revalidada al confirmar, ejecutar y bajo bloqueo.
- **Permisos:** `deliverable:read|manage`, `script:read|manage|approve` (`script:approve` = admin y director). El Operativo solo `deliverable:read` (proyección de estado, sin contenido); el cliente nada.
- **Tools F7 (11; total 36):** `deliverable_list`, `deliverable_get`, `script_version_get`, `finding_list`, `review_comment_list`, `deliverable_create`, `script_version_register`, `content_analysis_request`, `review_comment_add`, `script_request_changes`, `script_propose_approval`. No existen tools para aprobar, confirmar, revisión humana, visibilidad ni archivar. Tabla tool → caso de uso en [`CONTENT_V2`](../product/CONTENT_V2.md) §6.
- **UI:** `/campanas/[id]/contenido/**` (historial, hallazgos del Brief y comentarios SmartPR en secciones separadas, [Aprobar versión] con diálogo y huella); Operativo vista reducida; cliente 404.
- **Estado de contenido para Operativo/TCL:** la proyección de estado ya sale de `deliverable:read`; la proyección de TCL (F9) debe leer solo la fila `approved`.

## 6. Deudas conocidas (lista completa en `V2_CURRENT_STATE` §6)

Smoke real contra el proveedor de modelo no ejecutado · gateway del worker sin autenticación · sin límite de tasa por usuario · sin kill-switch por organización · Prettier legacy (17 archivos; no reformatear) · F5: la importación/aplicación no es una transacción global (`idempotent_external`) · F7 UI: listas truncadas sobre 200 comentarios/versiones · sin cabeceras de seguridad globales · `x-forwarded-host` en la comprobación de origen de la subida · sesgo de automatización con «sin hallazgos» por inyección · sin texto pegado como guion · sin descarga de originales · sin triage de hallazgos · el análisis es síncrono.

## 7. Fase 8 — SOLO intención (no es un diseño)

**Operación + KPIs** (workflow §2 y §4): lo que el Operativo gestiona sobre los **mismos** influencers de la campaña, sin listas paralelas. Candidatos a decidir en el preflight de F8 (preguntas abiertas, no respuestas):

- **Acuerdos** (`Agreement`): tipo (fee, canje, mixto), entregables pactados, condiciones, fechas, cotizaciones, órdenes de compra.
- **Términos comerciales:** fee / canje / mixto; etapas financieras no aplicables en canje puro (no deben quedar «pendientes»).
- **Logística de producto** (`Shipment`): estados pendiente/enviado/recibido/devuelto, transportadora, tracking, costos, guía, recepción, devolución, soportes.
- **Facturación y pagos** (`Invoice`/`Payment`): cuenta de cobro pendiente/recibida, validación, pago pendiente/realizado, comprobante.
- **Eventos operativos** (`OperationalEvent`): documentos ligados al evento al que pertenecen (p. ej. «Producto enviado» + guía), sin borrar historia sin trazabilidad.
- **KPIs:** objetivos pactados (ya conservados en el snapshot del Sheet) y resultados reales (MVP: entrada manual y carga Excel/CSV; después, integraciones); comparación objetivo vs. real con estado.

Todo debe colgar de los objetos correctos (`campaign_influencers` y, cuando aplique, `deliverables`), con permisos separados de los creativos (el Operativo no revisa ni aprueba guiones; Cuenta no gestiona pagos como tarea principal), auditoría con origen y provenance. **Nada de F9** (dashboard TCL) ni del agente Operativo (post-MVP). La visibilidad de lo financiero hacia TCL es «no visible» (workflow §3.6).

## 8. Reglas para el agente que retome

1. Verifica el repo antes de asumir (HEAD, rama `v2`, `git status`); la documentación histórica está desactualizada.
2. **Preflight primero**: inventario de qué reutilizar (versionado F2, HITL F6, adjuntos del chat, contexto del agente, visibilidad, `CampaignInfluencer`, `Deliverable`), búsqueda de modelos equivalentes, y recién entonces proponer entidades; congelar la arquitectura antes de implementar.
3. Sigue [`AGENT_EXECUTION_POLICY`](../project/AGENT_EXECUTION_POLICY.md): subagentes Sonnet 5.5, esfuerzo Alto para dominio/migraciones/seguridad/concurrencia/HITL/IA/integración/QA, Medio solo para tareas mecánicas, QA adversarial independiente, el principal controla Git.
4. No hagas push, merge ni PR sin instrucción explícita; **nunca a `main`**. No `--force`, no `git stash`.
5. No toques los archivos sueltos sin trackear del directorio de trabajo local (handoffs antiguos, ZIPs y notas de UI): no son parte del repo.
6. Cierra con DEC-049, nota técnica, actualización de `V2_CURRENT_STATE` y reporte (HEAD inicial/final, commits, pruebas, riesgos, qué NO se hizo); **detente y espera revisión** antes de F9.
