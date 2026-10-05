# Chat y agente de Cuenta (V2 · Fase 6)

Decisión: DEC-047. Migraciones: `021_chat_agente.sql` y `022_endurecimiento_chat.sql` (hardening F6.1). Paquete nuevo: `packages/agent`. Endpoint nuevo del worker: `POST /modelo/turno`.

> **El chat no es una base paralela: produce estructura.** El agente actúa **en nombre de una persona autorizada** (`origin = 'chat'`), usa los casos de uso que ya existen y **no sustituye decisiones humanas**. Aprobar, confirmar y ejecutar una acción propuesta no existen como herramienta del agente.

```
Persona (Cuenta) ──► Conversation ──► Message (+ adjuntos → source_documents)
                                          │ admitirTurno (kill-switch, run en cola)
                                          ▼
                       AgentRun (queued → running → completed | failed | cancelled)
                         │  por cada paso:
                         │   relee actor + permisos ─► ensamblarContexto (selectivo, sobres no confiables)
                         │   ModelClient.turn ─────────► worker /modelo/turno ─► proveedor (UNA llamada, sin estado)
                         │   tool_calls ──► ToolRegistry.execute (pipeline de seguridad) ──► caso de uso existente
                         ▼
                 respuesta final + citas (alias validados) ──► completarRun
Acción crítica:  propone el agente (proponerAccion, origin chat)  ──►  tarjeta visible
                 ──► confirma una PERSONA por canal ui (payloadHash mostrado) ──► ejecuta en servidor (una vez)
```

## 1. Reparto de responsabilidades

| Capa | Hace | No hace |
|---|---|---|
| **Domain** (`chat.ts`, `agent-context.ts`, `proposed-actions.ts`) | Reglas puras: estados, límites, permisos `chat:*`, política de lectura para IA, sobres, citas, huellas | Nada de IO |
| **DB** (`chat-*`, `agent-runs`, `agent-tool-invocations`, `agent-context`, `proposed-action-handlers`) | Decide: autorización, tenant, invariantes, idempotencia, HITL, auditoría | No conoce el modelo |
| **Agent** (`packages/agent`) | Orquesta: bucle del run, registro de tools, validación de argumentos, grounding | No decide reglas ni toca SQL |
| **Worker** (`/modelo/turno`) | Una llamada de modelo sin estado; devuelve texto o tool calls | No ejecuta tools, no conoce actor/organización/campaña, no guarda razonamiento |
| **Web** | Transporte: server actions, route handler de adjuntos, polling | No decide permisos ni estados |

## 2. Modelo de datos (migración 021)

`chat_conversations` (**owner-scoped**: la ve su creador; por campaña y organización) · `chat_messages` (append-only, `seq` y huella asignados por la base) · `chat_message_attachments` (mensaje → `source_documents`, misma campaña) · `chat_message_references` (citas a fuente/fragmento/snapshot/locator) · `agent_runs` (un único run activo por conversación; `attempt`; latido; cancelación solicitada) · `agent_tool_invocations` (claim de idempotencia por run + llamada; **sin argumentos ni resultados crudos sin sanear; sin chain-of-thought**) · `ai_runs.agent_run_id/step_index` (ledger de costo por llamada de modelo) · índices de expresión sobre `audit_events.correlation` · UNIQUE parcial `proposed_actions_abierta_key` (cierra la carrera de `proponerAccion`).

Las FK compuestas (`organization_id`, `campaign_id`) impiden mezclar tenants o campañas; los triggers hacen inmutables los mensajes y derivan locator/snapshot/huella de cada cita desde el fragmento.

**Correlación** (`audit_events.correlation`, sin FK): `conversationId`, `messageId`, `agentRunId`, `toolInvocationId`, `proposedActionId`. `toolInvocationId` solo se acepta con origen `chat`. Permite reconstruir usuario → conversación → mensaje → run → tool → efecto (`chat-trace.ts`).

## 3. Permisos

Solo `chat:read` y `chat:write`, para `admin`, `director` y `consultor`. Operativo, cliente (TCL), analista y legal no tienen acceso (la ruta responde 404). **Las tools no tienen permisos propios:** heredan los del caso de uso que reutilizan; el registro exige además `chat:write` y relee al actor en **cada** paso y en cada llamada de tool (permiso revocado a mitad de un run → deja de ofrecerse y de ejecutarse).

## 4. Contexto del agente (selectivo)

No se vuelca el proyecto crudo. `ensamblarContexto` arma, con las lecturas existentes y el alcance del actor: persona (**solo rol, sin ids**), campaña, estado del Brief (resumen), fuentes **legibles para IA** (`fuenteLegibleParaIA` = procesada, con texto y no `sensible`), productos, participaciones (con límite) y estado del Sheet/importación. Presupuesto con truncado **explícito** (nunca silencioso; lo obligatorio que no cabe es un error). Sin RAG ni resumen de conversación en v1: la recuperación es bajo demanda mediante tools.

**Contenido no confiable.** Todo texto proveniente de documentos, notas PPTX, celdas de Sheets, nombres de archivos/hojas, títulos de enlaces y mensajes previos va dentro de un sobre `<<<NC:{nonce} …>>>` con prefijo `│` por línea y cierre `<<<FIN:{nonce}>>>`; el nonce es un HMAC por run, el sobre se autoverifica y el modelo recibe la instrucción de tratarlo como **dato sin autoridad**. Lo no confiable nunca va en el mensaje `system`.

**Grounding.** Una tool con efecto exige una cita literal (`evidenceQuote`) que aparezca en mensajes **del actor** de esta conversación (la URL de `source_register_link` debe aparecer literal). Nunca se fundamenta en el contenido de una fuente.

**Citas.** El modelo cita alias (`S1`, `F3`); el runtime los valida contra el registro del run (los inventados se descartan) y persiste `chat_message_references`.

## 5. Catálogo de tools v1 (25) y caso de uso que reutiliza

Pipeline por llamada (sin caché): reclama la invocación → existe → esquema cerrado (rechaza `actor/userId/organizationId/campaignId/origin/canal/assignedTo/status`) → actor releído (activo y misma organización) → campaña releída y verificada → capability → estado de campaña → grounding → cuota/presupuesto → caso de uso con `contexto = {origin:'chat', correlation}` → proyección acotada (≤ 16 KB, ≤ 50 filas, sin `external_url`) → cierra la invocación.

| Tool | Riesgo | Capability | Caso de uso reutilizado |
|---|---|---|---|
| `campaign_get` | read | campaign:read | `getCampaign` |
| `source_list` | read | source:read | `listSources` |
| `source_get` | read | source:read | `getSource` + `preparacionDeFuente` |
| `source_read_content` | read | source:read | `obtenerRepresentacionNormalizada` + política de lectura para IA |
| `source_search_text` | read | source:read | `buscarTextoEnFuentes` + política de lectura para IA |
| `brief_get_workspace` | read | brief:read | `obtenerBriefWorkspace` (`incluirActividad:false`) |
| `brief_list_questions` | read | brief:read | `listarPreguntas` |
| `proposed_action_get` | read | campaign:read | `obtenerAccionPropuesta` (con alcance de campaña) |
| `influencer_list_participants` | read | campaign_influencer:read + influencer:read | `listarInfluencersDeCampanaConConteo` |
| `influencer_get_participation` | read | ídem | `obtenerCampaignInfluencer` |
| `influencer_get_origin` | read | campaign_influencer:read + source:read | `getParticipationOrigin` |
| `sheet_get_sync_run` | read | source:read | `getSyncRun` |
| `sheet_validate` | read | source:read + influencer:read | `validateInfluencerSheetSnapshot` |
| `sheet_get_import_plan` | read | source:read + influencer:read + campaign_influencer:read | `getImportPlan` |
| `campaign_update_metadata` | write | campaign:update | **`actualizarCampana` (NUEVO)** |
| `source_register_link` | write | source:upload | `registrarAdjuntoDeEnlace` → `registerLinkedSource` |
| `brief_extract` (cuota 1/run) | write | brief:edit | `extraerBrief` / `reintentarExtraccion` |
| `brief_generate_questions` | write | question:create | `generarPreguntas` |
| `brief_answer_question` | write | question:answer | `responderPregunta` |
| `brief_request_internal_review` | write | brief:transition | `transicionarBrief` (destino fijo `internal_review`) |
| `sheet_sync` | write | source:process | `syncGoogleSheetSource` |
| `sheet_prepare_import_plan` | write | source:read + influencer:read + campaign_influencer:manage | `prepareInfluencerImport` |
| `brief_propose_approval` | confirmación | brief:request_review | `proponerAccion('brief.approve')` |
| `sheet_propose_apply` | confirmación | influencer:manage + campaign_influencer:manage | `proponerAccion('influencer_import.apply')` |
| `sheet_propose_resolution` | confirmación | ídem | `proponerAccion('influencer_import.resolve_record')` |

**Único caso de uso nuevo:** `actualizarCampana` (nombre y fechas): no existía ninguna edición de campaña y el workflow V2 exige fijar fechas desde el chat; la capability `campaign:update` estaba concedida sin uso.

**Prohibidas (no se registran; test de manifiesto):** `aprobarBrief`, `transicionarBrief → approved`, `confirmarAccion`, `ejecutarAccion`, `solicitarCambiosInternos`, `crearVersionHija`, `setSourceVisibility`, `archiveCampaign`, `createCampaign`, `applyInfluencerImport`, `resolveImportRecord`, retirar/reactivar/desasociar/actualizar influencer o cuenta, `recordAudit`, `getPool`.

**Frontera D15.** `packages/agent` solo importa de `@tcl-kol-os/db` por dos puertas: `tools/use-cases.ts` (lista blanca para tools) y `runtime/db-ports.ts` (lista cerrada para el runtime). `manifest.ts` clasifica **cada** export de db (read / write / propuesta / solo runtime / solo UI / prohibido); un test estático falla si aparece un export nuevo sin clasificar, si otro archivo importa de db o si una tool referencia un identificador prohibido.

## 6. HITL (sin segundo sistema)

`proposed_actions` sigue siendo el único mecanismo. `ProposedActionType` ahora es `brief.approve` · `influencer_import.apply` · `influencer_import.resolve_record`, resueltos por un **registro de handlers** (propone/confirma/ejecuta, payload y huella, vigencia, ejecución).

| | `brief.approve` | `influencer_import.*` |
|---|---|---|
| Propone | `brief:request_review` (persona por chat, o system) | `influencer:manage` + `campaign_influencer:manage`; solo persona |
| Confirma y ejecuta | `brief:approve_internal` (admin/director), persona, canal `ui`; solo quien confirmó ejecuta | `influencer:manage` + `campaign_influencer:manage`, persona, canal `ui` |
| Atomicidad | **`atomic`**: dominio + `executed` + auditoría en una transacción | **`idempotent_external`** (ver abajo) |

`applyInfluencerImport` y `resolveImportRecord` **rechazan `origin = 'chat'`** (`HUMAN_CONFIRMATION_REQUIRED`); el executor de una acción confirmada los llama con origen `ui` + `correlation.proposedActionId`.

**Garantía `idempotent_external` (más débil, documentada).** Los casos de uso de la Fase 5 abren sus propias transacciones. La ejecución única la da el bloqueo de la fila de la acción mientras dura la llamada; la recuperación es por reintento idempotente, no por rollback: si el dominio se aplicó y falló el `UPDATE executed`, la acción queda `confirmed` y reintentar `ejecutarAccion` reconcilia sin duplicar. `executed` significa que el caso de uso corrió; puede haber registros bloqueados pendientes (detalle en la auditoría `proposed_action.execute`).

**Carrera de `proponerAccion` (cerrada).** Bloqueo consultivo por (tipo, recurso) + vencer caducadas + reintento ante 23505 del índice único parcial `proposed_actions_abierta_key`.

**Camino humano (nuevo).** En la UI: tarjeta de propuesta con texto del handler y huella → diálogo de confirmación → `confirmarAccionPropuestaDeChat` (canal `ui` **fijo en servidor**, huella mostrada comparada con la vigente → `PROPOSAL_STALE`) → `ejecutarAccion`. Quien propone (consultor) no puede confirmar un `brief.approve`; el director lo ve en el panel de pendientes de la campaña aunque no vea la conversación.

## 7. Run, errores y operación

- **Run durable = fila Postgres.** Admisión atómica (mensaje + run `queued`; `UNIQUE(conversation_id, client_message_id)`; un único run activo por conversación). La ejecución se dispara con `after()` tras persistir; el latido por vuelta y por tool; el barrido perezoso cierra abandonados (`RUN_ABANDONED`: 5 min en cola, 10 min sin latido) y el usuario reintenta (`attempt + 1`). Sin auto-reencolado.
- **Salidas limpias:** `completed` · límite de pasos (mensaje determinístico, sin otra llamada de modelo) · `failed` (`AGENT_RUN_TIMEOUT`, `AGENT_MODEL_UNAVAILABLE`, `AI_DISABLED`, `FORBIDDEN_ROLE`, `AGENT_CONTEXT_FAILED`, `AGENT_RUNTIME_ERROR`) · `cancelled`.
- **Límites por defecto:** 8 pasos (tope duro 15), 4 tool calls por paso, plazo 180 s, 45 s por llamada de modelo (+10 s HTTP), resultado de tool ≤ 16 KB, 25 lecturas y 10 efectos por run, `brief_extract` 1 por run.
- **Kill-switch:** `AI_ENABLED` se aplica en la admisión, antes de cada paso y en el endpoint del worker. **No** se cambió el comportamiento actual de la extracción (`/extraccion` sigue sin comprobarlo; deuda declarada).
- **Worker:** `POST /modelo/turno` estricto (`extra=forbid`), una llamada, sin ejecutar tools, sin persistir ni loguear contenido, sin chain-of-thought; errores tipificados (`AI_DISABLED`, `MODEL_TIMEOUT`, `MODEL_RATE_LIMITED`, `MODEL_UPSTREAM_ERROR`, `MODEL_BAD_RESPONSE`, `MODEL_CONTEXT_TOO_LARGE`, `MODEL_NOT_CONFIGURED`, `REQUEST_INVALID`, `INTERNAL_ERROR`). El cliente Node lee `AI_WORKER_URL ?? WORKER_URL` (corrige el desajuste previo) y reintenta solo errores `retryable` (2 reintentos, 1 s/3 s con jitter).
- **Adjuntos:** `POST /api/campanas/[id]/chat/adjuntos` (route handler: el límite de 1 MB de las server actions de Next 15 no aplica) → `registrarAdjuntoDeArchivo` → `uploadSource`; visibilidad `interna`; duplicado por hash vincula la fuente existente; enlaces: tool `source_register_link`.

## 8. Variables de entorno

`AI_ENABLED` · `AI_WORKER_URL`/`WORKER_URL` · `AI_PROVIDER` · `AI_MODEL_EQUILIBRADO` · `AGENT_NONCE_SECRET` (cae a `SESSION_SECRET`; obligatorio en producción) · `AGENT_MAX_TOOL_STEPS` · `AGENT_RUN_DEADLINE_S` · `AGENT_MODEL_TIMEOUT_S` · `AGENT_MAX_TOKENS` · `CHAT_ATTACHMENT_MAX_MB`. Documentadas en `.env.example`; el servicio `web` de `docker-compose.yml` las recibe.

## 9. Deuda y riesgos declarados

- Gateway del worker **sin autenticación** (secreto compartido pendiente).
- `after()` no es durable: cubierto por el barrido perezoso; la cancelación de un run en ejecución se ve en el siguiente latido.
- Sin streaming (polling), sin resumen de conversación, sin búsqueda semántica en tools, sin kill-switch por organización (`ai_settings`).
- `influencer_import.*` con garantía `idempotent_external`.
- Smoke real contra el proveedor **no ejecutado** (sin clave): `require_parameters:true`/`tool_choice`/`parallel_tool_calls:false` no verificados contra OpenRouter. Si el modelo `equilibrado` no soporta tools, llegaría como `MODEL_UPSTREAM_ERROR`.
- `/extraccion` sin kill-switch; `ai_runs.provider` por extracción sigue fijo en `openrouter`.
- Diferidos a v1.1: `brief_confirm_field`, `brief_correct_field`, `brief_create_manual`, `source_retry`, búsqueda semántica, comentarios, traducciones, listados de snapshots/compare.
- Sin límite de tasa por usuario en el envío de mensajes.
- La lista de roles con acceso al chat existe en dos sitios (matriz de permisos del dominio y trigger de la 022); una prueba de paridad en `chat-endurecimiento.test.ts` falla si divergen.

## 10. Resultados de QA adversarial y mutaciones

**QA adversarial** (subagente que no implementó; 12 vectores sobre datos y roles reales, runtime y registro reales, worker real con Google simulado): **0 P0 y 0 P1**. Ningún ataque rompió el aislamiento por organización o campaña, el HITL (ni el chat, ni `system`, ni el agente aprueban, confirman o ejecutan), los permisos ni la provenance.

| Sev | Hallazgo | Estado |
|---|---|---|
| P2 | QA-01 fechas de `campaign_update_metadata` sin grounding | corregido (grounding de fechas) |
| P2 | QA-02 `answerValue` sin contraste con lo que dijo la persona | corregido (contraste por tipo de campo) |
| P2 | QA-04 nombre de adjunto `sensible` llegaba al modelo | corregido |
| P2 | QA-09 mensajes de 8 001–20 000 caracteres imposibles de responder | corregido (presupuesto = límite de admisión) |
| P2 | QA-24 celdas del Sheet fuera del sobre en `sheet_get_import_plan` | corregido (solo códigos; texto dentro del sobre) |
| P2 | QA-26 interbloqueo del pool con ejecuciones HITL de importación simultáneas | corregido (cupo de 2 + `connectionTimeoutMillis`) |
| P2 | QA-14 test estático D15 ignoraba `export *` | corregido (test endurecido, 19 → 31 pruebas) |
| P3 | QA-03, 05, 06, 07, 08, 13, 15, 17–23, 25 (replay de lecturas, NUL/ids largos, ledger fuera de rango, `<think>` sin cerrar, sanitización con homoglifos, `__proto__`, texto libre de campaña fuera de sobre, worker: cuerpo chunked, `1e999`, NaN, log, recursión) | corregidos, con prueba de regresión |
| P3 | QA-10/11/12 owner-scope, rol del dueño e INSERT de estados terminales solo en casos de uso, no en triggers | **corregido en F6.1** (migración 022): triggers de dueño, rol con `chat:write` y estado inicial `pending`; probado por SQL directo y por mutación |

Las pruebas de QA quedaron como regresión: 118 en `packages/agent/src/qa`, 20 en db (`qa-chat-*`) más 12 de `chat-endurecimiento.test.ts` (F6.1), 46 en el worker (`test_qa_modelo_turno.py`). Cuidado: el harness de mutación del manifiesto copia `HEAD`.

**Mutaciones del agente principal** (se rompió la regla, las pruebas fallaron, se restauró y se verificó): confirmar/ejecutar aceptan canal `chat` (3 fallos), `transicionarBrief → approved` acepta origen `chat` (2), `applyInfluencerImport`/`resolveImportRecord` aceptan origen `chat` (3), las tools auditan como `ui` (7), la capacidad base de las tools deja de exigir `chat:write` (2). Los implementadores comprobaron además: no releer el actor, no limitar pasos, más de 4 tool calls, resultados crudos en el historial, alias no registrados, cerco de campaña, filtro de legibilidad para IA, grounding, claim de idempotencia, tool prohibida registrada, prefijo `│` del sobre, neutralización del nonce, índice de un run activo, trigger de citas e índice de propuestas abiertas.

**E2E** (Playwright contra servidor real y worker con proveedor falso): E2E-10 a E2E-15 (acceso y roles, conversación, herramientas e inyección documental, HITL de punta a punta con auditoría `chat` → `ui`, adjuntos, IA apagada, worker caído) más los 9 previos.

Observaciones aceptadas sin corrección: quien confirma no tiene por qué ser quien propuso (una importación la confirma quien tenga `influencer:manage` y `campaign_influencer:manage`); el grounding acredita una cita de la persona, no su intención; los reintentos del cliente de modelo repiten llamadas pagadas (máx. 3 por vuelta).
