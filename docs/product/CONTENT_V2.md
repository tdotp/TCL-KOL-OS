# Contenido: entregables, guiones, revisión y aprobación (V2 · Fase 7)

Decisión: DEC-048. Migraciones: `023_contenido_guiones.sql`, `024_analisis_de_contenido.sql`, `025_endurecimiento_contenido.sql`. Worker: `POST /modelo/analisis`. Rutas web: `/campanas/[id]/contenido/**`.

> **El agente organiza, relaciona, analiza y prepara; no aprueba.** La aprobación de un guion es una decisión humana por canal `ui`. Los hallazgos del análisis informan; no sustituyen esa decisión.

```
CampaignInfluencer ──► Deliverable ──► ScriptVersion V1, V2, V3…  (archivo = source_documents; nunca se sobrescribe)
                                          │
              Brief aprobado vigente (rector) ──► Revisión (ai_assisted | human) ──► Hallazgos del Brief
                                          │                                       (CURRENT | STALE, derivado)
              Comentarios SmartPR ◄── persona (ui | chat con cita exacta)         ≠ comentarios humanos
                                          ▼
   Aprobar: UI directa  ─┐
   Chat: propone ► tarjeta ► confirma una PERSONA (ui, huella) ─┴─► aprobarScriptVersion (UN caso de uso)
```

## 1. Modelo de datos

| Tabla (migración) | Qué es | Reglas impuestas en la base |
|---|---|---|
| `deliverables` (023) | Pieza comprometida de una participación | FKs compuestas (org, campaña, participación, producto); `UNIQUE (participación, label_key) WHERE active`; `last_version` = máx. versión (025); sin DELETE |
| `script_versions` (023, 025) | Una versión recibida (un archivo) | Número asignado por trigger bajo bloqueo del entregable; identidad y binding inmutables; `UNIQUE (source_document_id)` (025); fuente origen archivo e interna; una sola `approved` por entregable; aprobar exige rol, hash de fuente intacto, revisión y Brief citados (025); sin aprobar hacia atrás; `superseded` solo con sucesora aprobada (constraint diferido); sin DELETE ni TRUNCATE |
| `script_review_comments` (023) | Comentarios SmartPR y cambios solicitados | Autor persona obligatorio; `origin` ui\|chat; en chat el texto es subcadena EXACTA de un mensaje `user` del mismo autor; append-only |
| `content_analysis_runs` (024) | Revisión contra el Brief rector | `kind` ai_assisted\|human; Brief gobernante validado en la base (aprobado, misma campaña, nunca borrador); insumos inmutables; un run IA activo por versión; una revisión humana por (versión, Brief, persona) |
| `content_findings` + `content_finding_brief_refs` + `content_finding_script_refs` (024) | Hallazgos derivados del Brief, con provenance | Solo bajo un run `ai_assisted` en `running`; inmutables; sin estado ni autor humano; FK compuesta al campo del Brief de la versión gobernante |
| `ai_runs.content_analysis_run_id` (024) | Ledger por llamada de modelo | Una fila por llamada, también en fallos; nunca prompt ni respuesta |
| `source_documents` / `source_fragments` (023/025) | Guardas | Una fuente de guion no aprobado no se expone a TCL; original y fragmentos de un guion ya revisado no cambian |

**Estados de ScriptVersion:** `received → in_review → changes_requested | approved`; `superseded` solo al aprobar una versión mayor. `changes_requested` es terminal. El primer acto de revisión (análisis, revisión humana, comentario, cambios) pasa `received → in_review`.

**Latest ≠ aprobada vigente.** Última = mayor número. Vigente = la única `approved`. Una versión aprobada y luego reemplazada queda `superseded` con sus marcas de aprobación intactas.

## 2. Brief rector y vigencia

`obtenerBriefRector`: versión lógica `es`, `approved_at` no nulo, estado `approved|superseded`, la de mayor `approved_at`. Una hija en borrador no desplaza al padre. Sin rector: `BRIEF_NOT_APPROVED`. **No** se usa `obtenerBriefWorkspace` (devuelve la última versión de cualquier estado).

CURRENT = último run `succeeded` de la versión cuyo Brief gobernante es el rector actual. STALE = solo hay revisiones contra otros briefs (siguen legibles). Se deriva en lectura. Al aprobar, además, se compara la huella de insumos (Brief y alcance de producto) guardada en el run contra la actual (`inputs_changed`).

## 3. Análisis asistido

- **Worker** `POST /modelo/analisis` (una llamada sin estado, JSON mode, sin BD, kill-switch `AI_ENABLED`, un reintento solo por JSON roto). Prompt versionado `analisis-guion-1`; esquema `analisis-guion-salida-1`.
- **Node** (db/domain): autoriza; arma el contexto selectivo (requisitos del Brief por una allowlist de campos y el guion completo; **nunca se trunca el guion**: si no cabe, `SCRIPT_CONTEXT_TOO_LARGE` antes de crear el run); todo texto de documentos va en sobres no confiables; valida la salida con un validador estricto **todo-o-nada**; persiste findings + refs + `ai_runs` + auditoría en UNA transacción. Salida inválida ⇒ run `failed`, cero hallazgos.
- **El modelo solo elige alias** `R#` (requisitos) y `F#` (fragmentos) y cita texto; el código resuelve ids, verifica citas literales, adjunta la evidencia y fuente original del Brief y **deriva la severidad** (`sev-1`). El modelo no puede introducir requisitos: «más juvenil» no es un hallazgo.
- Categorías: `cta_missing`, `key_message_incomplete`, `requirement_not_covered`, `claim_unsupported`, `claim_contradicted`, `restriction_violated`, `brief_contradiction` (matriz categoría↔basis↔claim_status↔refs↔citas). CTA = `accion_kpis.accion_esperada` (el catálogo del Brief no tiene campo CTA).
- Idempotencia por `idempotency_key` + `request_hash`; `ensure` reutiliza el run CURRENT con iguales insumos; `reanalyze` crea un run nuevo; tope de 10 por versión.
- **Revisión humana** (`registrarRevisionHumana`): solo canal ui, persona con `script:manage`; guarda actor, versión, Brief gobernante y huella. Habilita aprobar igual que una revisión IA (la IA nunca es requisito).

## 4. Aprobación y HITL

- Un solo caso de uso: `aprobarScriptVersion` / `aprobarScriptVersionEnTransaccion`. La UI directa lo llama con origen `ui` y la `huellaVista` que la persona vio; el handler `script_version.approve` (modo `atomic`) lo llama dentro de la transacción del executor tras la confirmación humana.
- **Bloqueos duros:** versión `in_review`; existe Brief rector; existe CURRENT REVIEW; campaña, participación y entregable activos; no aprobar hacia atrás. **No bloquean:** cero hallazgos, hallazgos abiertos, comentarios.
- **Huella:** `sha256(canónico(snapshot))` con {versión y fuente, entregable y cabeza, aprobada que reemplaza, Brief y su huella, revisión, hallazgos por severidad, comentarios, participación}. Se revalida al confirmar, al ejecutar y bajo bloqueo; cualquier cambio material ⇒ `PROPOSAL_STALE`.
- **Orden de bloqueo:** propuesta → entregable → versión → Brief gobernante `FOR SHARE`. Escritura: bajar a interna la fuente de la aprobada anterior; `superseded` de las menores; `approved` con `approved_by`, `approved_via_proposed_action_id`, `approved_analysis_id`, `approved_brief_version_id` y `approval_snapshot`.
- **Permisos:** `script:approve` = admin y director; `script:manage` (consultor incluido) crea, comenta, pide cambios, analiza y propone.
- La confirmación de una propuesta del chat sigue el camino F6 (canal `ui`, huella mostrada). La tarjeta muestra advertencias (revisión desactualizada, hallazgos abiertos, revisión humana no asistida, versión más reciente, «reemplaza a Vn»).

## 5. Permisos

| Capacidad | admin | director | consultor | operativo | cliente |
|---|:-:|:-:|:-:|:-:|:-:|
| `deliverable:read` | ✓ | ✓ | ✓ | ✓ (proyección de estado) | — |
| `deliverable:manage` | ✓ | ✓ | ✓ | — | — |
| `script:read` | ✓ | ✓ | ✓ | — | — |
| `script:manage` | ✓ | ✓ | ✓ | — | — |
| `script:approve` | ✓ | ✓ | — | — | — |

Los roles se imponen también en la base (`contenido_exigir_rol`), con prueba de paridad contra `roleCan`.

## 6. Tools del agente (25 → 36) y caso de uso que reutilizan

| Tool | Riesgo | Caso de uso |
|---|---|---|
| `deliverable_list` | lectura | `listarEntregablesDeCampana` + `resumenesDeContenidoDeVersiones` |
| `deliverable_get` | lectura | `obtenerEntregable` + `listarVersionesDeEntregable` |
| `script_version_get` | lectura | `obtenerVersionDeGuion` + `obtenerRevisionVigente` + `evaluarProntitudDeAnalisis` + `listarComentariosDeRevision` |
| `finding_list` | lectura | `obtenerVersionDeGuion` + `listarHallazgos` |
| `review_comment_list` | lectura | `obtenerVersionDeGuion` + `listarComentariosDeRevision` |
| `deliverable_create` | escritura | `crearEntregable` (+ `candidatosDeParticipacion`) |
| `script_version_register` | escritura | `registrarVersionDeGuion` |
| `content_analysis_request` | escritura | `solicitarAnalisisDeGuion` (`ensure`, 1 por run) |
| `review_comment_add` | escritura | `crearComentarioDeRevision` (la `quote` ES el comentario) |
| `script_request_changes` | escritura | `solicitarCambiosDeScript` (1 por run) |
| `script_propose_approval` | propuesta | `proponerAccion('script_version.approve')` |

**No existen** tools para aprobar, confirmar, ejecutar, registrar revisión humana, cambiar visibilidad ni archivar (manifiesto D15). El modelo nunca aporta organización, campaña, actor, origen, canal, autor, número de versión ni Brief. Alias nuevos E, V, H, C (un UUID da `RESOURCE_NOT_FOUND`). Cerco de campaña en el caso de uso y en la tool. Asociación de adjuntos: la mención del influencer y el nombre completo del archivo se verifican por código; con ambigüedad el caso de uso devuelve `needs_choice` sin efecto y el agente pregunta. Hallazgos, comentarios y texto de guion siempre en sobres no confiables. El contexto del agente incluye una sección `content` (≤ 20 ítems, sin texto de guion).

## 7. UI mínima

`/campanas/[id]/contenido` (por influencer → entregables), `…/[participacionId]` y `…/[participacionId]/[deliverableId]?v=n` (historial V1..Vn con «Última» y «Aprobada vigente / reemplazada por Vn»; HALLAZGOS DEL BRIEF y COMENTARIOS SMARTPR en cards separadas; acciones: solicitar análisis, registrar revisión humana, comentar, solicitar cambios, [Aprobar versión] con diálogo y huella). Subida por `POST /api/campanas/[id]/contenido/guiones`. Operativo: lectura reducida. Cliente y otra agencia: 404. La descarga de originales queda fuera (el enlace va a `/fuentes/[sourceId]`).

## 8. Auditoría

`deliverable.create|update|archive|unarchive`, `script_version.register|transition|request_changes|approve|supersede`, `script_analysis.request|complete|fail`, `script_review.human`, `script_review_comment.create`, `deliverable.current_approved_changed`, y los `proposed_action.*` existentes. Origen `ui` o `chat` para personas; `system` solo al completar o fallar un análisis y expirar propuestas. Metadata sin texto de documentos. La aprobación solo se audita con origen `ui` (la cadena conversación→run→tool se reconstruye por la propuesta).

## 9. Resultados de verificación

- **QA adversarial del backend** (subagente independiente; 16 vectores + A–I): 0 P0, 0 P1; 2 P2 y 9 P3 corregidos en la 025 (misma fuente en dos entregables, `script_request_changes` sin cuota, fragmentos mutables, hueco de `last_version`, aprobación sin revisión por SQL, STALE por alcance de producto, nombre de archivo débil, UUID en errores, relleno Unicode, TRUNCATE). 217 pruebas de regresión.
- **Mutaciones** (cada una rompe al menos una prueba y se restauró): aprobar acepta origen chat/system; handler sin huella o con confirmCapability débil; huella sin revisión/cabeza/reemplazo; sin revalidación bajo bloqueo; sin `bloquearEntregable`; sin `FOR SHARE` del Brief; hallazgos abiertos como bloqueo; no exigir revisión ni Brief rector; cerco de campaña; grounding de comentarios; aprobación desde tool; validador que acepta citas/alias inexistentes; persistencia parcial; rector con borradores; `ensure` que ignora vigencia; UNIQUE de fuente; cuota; triggers de fragmentos y de `last_version`.
- **QA adversarial de la capa web** (subagente independiente; U1–U12: rutas forzadas, server actions, route handler de subida, XSS, fuga por DTO, cabeceras, accesibilidad y abuso): 0 P0 y 0 P1; 1 P2 y 5 P3 corregidos (truncamiento silencioso a 200 entregables, fuente suelta tras una subida fallida, caracteres bidi, id no UUID, foco del diálogo) y 55 pruebas de regresión. Quedan como deuda declarada UI-03/UI-04 (más de 200 comentarios o versiones), UI-08 (cabeceras de seguridad globales) y UI-09 (`x-forwarded-host`), con su prueba marcada como abierta.
- **Mutaciones del agente principal** (10, sobre el árbol limpio y restauradas): overwrite de versiones, unique/guard de versión, Brief más reciente en vez del aprobado, sin chequeo STALE, aprobación por IA/chat/system, hallazgos abiertos como bloqueo, referencia inexistente, capacidad de lectura débil, sin cerco de campaña y aprobación desde una tool. Todas rompen pruebas.
- **E2E** (Playwright, servidor real y worker con proveedor falso): E2E-16 a E2E-21 (17 pruebas). Corrida oficial completa: **51/51** (34 de F0–F6.1 más 17 de F7), 10,6 min.
- **Suites:** domain 678, db 1490, agent 505, worker 769; lint, typecheck, build, ruff y mypy verdes.
- **Migraciones:** desde cero 1→25 + seed; upgrade 022→024 (con datos de F6) y 024→025 (con datos de contenido): md5 idéntico por tabla.

## 10. Deuda y riesgos declarados

- Texto pegado en el chat como guion: fuera del MVP (exige arquitectura documental); el guion entra como adjunto/source.
- Descarga de originales y visor: fuera de F7; la nav de Fuentes no incluye «Contenido» (archivo con deuda de Prettier de V1).
- Triage/resolución de hallazgos: sin implementar (los hallazgos son inmutables).
- STALE por cambio de alcance de producto solo se detecta al aprobar; las listas lo derivan por Brief.
- Análisis síncrono (hasta ~100 s); la página no sondea.
- Smoke real contra el proveedor no ejecutado; el modelo real podría tener tasa alta de salidas inválidas por el modo todo-o-nada.
- Sesgo de automatización: un guion con inyección que provoque «sin hallazgos» produce una tarjeta sin hallazgos; la decisión sigue siendo humana.
- Cancelar un Brief aprobado no invalida los guiones aprobados contra él.
- El Operativo conserva `source:read` general (se excluyen los guiones no aprobados); `audit:read` puede ver nombres de archivo.
- El bypass de inmutabilidad existe solo en bases `_test`; `TRUNCATE` queda bloqueado fuera de ellas.
- Fallo intermitente conocido bajo carga: `packages/agent/src/qa/qa-hitl.test.ts` (H2) y `qa-f7-estres.test.ts`.

## 11. Contratos listos para F8 y F9

- **F8 (Operación):** colgar acuerdos, envíos, pagos y KPIs de `campaign_influencers` y, cuando aplique, de `deliverables` (id estable, clave `(participación, etiqueta)`); el estado del guion/contenido para Operativo ya sale de `deliverable:read` (proyección de estado).
- **F9 (Dashboard TCL):** proyección propia, con capacidad aparte (espejo de `source:read_shared`), que lea solo la fila `approved` de cada entregable (índice único parcial) y su estado; nunca borradores, rechazadas, hallazgos, comentarios ni internals de IA. Exponer la fuente de la aprobada vigente a TCL sigue siendo una decisión humana explícita.
