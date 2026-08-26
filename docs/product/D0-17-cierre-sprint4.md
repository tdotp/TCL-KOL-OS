# D0-17 — Cierre de Sprint 3 + Sprint 4: brief funcional de punta a punta

**Fecha:** 26 de agosto de 2026, actualizado tras la **segunda** ronda de corrección posterior a la revisión del product owner. **Base:** commit `10788d9` (HANDOFF anterior). **Checkpoint técnico:** commit `516de31` — preserva lo construido, **no es el cierre definitivo**. **Alcance:** el pedido «Cierre real de Sprint 3 + Sprint 4 — brief funcional de punta a punta», aprobado por el product owner con los ajustes de la revisión de plan, el mandato de incidente INC-001, y dos rondas de corrección posteriores al checkpoint: la primera (reproducibilidad desde cero, E7-8, precisión del reporte) declaró CI en `PASS` sin haberlo demostrado — la corrida citada como «la receta de `ci.yml`» en realidad había dado `1 failed | 109 passed`, señalado correctamente por el product owner; la segunda corrige eso de raíz (`pipeline.test.ts` sin rutas personales, worker+consumidor reales en CI) y solo entonces declara CI en `PASS`, con el resultado literal en §6.

Formato de estado, sin excepción: **PASS** (implementado, probado, con evidencia real, sin condiciones pendientes) · **PASS_TESTED / BLOCKED_REAL_DEMO** (el código y las pruebas automatizadas lo prueban; la demostración con el dato real de producción sigue bloqueada por algo externo) · **PARTIAL** (implementado con un corte de alcance explícito y documentado) · **FAIL** (no cumple, o diferido sin implementar) · **BLOCKED_EXTERNAL_INPUT** (el código está listo; falta un insumo externo fuera de mi control).

**Estado general de este incremento: PARTIAL / BLOCKED — no cerrado.** Los puntos 1 a 5 de la corrección solicitada están resueltos y verificados (detalle abajo); el punto 6 (Demo A e INC-001B con P80 real) sigue `BLOCKED_EXTERNAL_INPUT`, a la espera de una clave de OpenRouter válida que el usuario actualizará solo en su `.env` local. Mientras el punto 6 no cierre, **este documento no declara Sprint 4 completo** y no se genera el ZIP de entrega.

---

## 1. Resumen ejecutivo

El HANDOFF previo declaraba Sprint 3 cerrado, pero la máquina de estados del dominio (12 estados, ~25 transiciones) nunca se invocaba fuera de su propio test, y la pantalla de extracción era de solo lectura. Este incremento conecta lo modelado y construye lo que faltaba:

- El ciclo de estados corre de verdad, con guardas reales y auditoría en cada paso.
- El anclaje de producto funciona de extremo a extremo (worker → repositorio → base) — **probado y demostrado con datos sintéticos multiproducto; sin demostrar todavía con el material real de P80** (ver 2.1 y §4).
- Existe un camino manual, funcional con `AI_ENABLED=false`, **demostrado end-to-end en este documento (Demo B)**.
- La Épica E6 (preguntas locales) tiene repositorio y UI reales. La E7 (editor) igual, **incluida ahora E7-8** (excepción por producto en un campo compartido), corregida tras el checkpoint — antes diferida silenciosamente, lo cual fue un error de reporte, no solo de alcance.
- Un incidente de datos de prueba (INC-001) se contuvo, se documentó con honestidad y se intentó regenerar — bloqueado por una causa externa (clave de OpenRouter inválida), no por código.
- **Primera ronda de corrección**: la suite de `packages/db` no era reproducible desde una base recién creada (tres archivos asumían datos acumulados); dos de esos tres (`extraction.test.ts`, `brief-rules.test.ts`) sí forman parte de este incremento y se corrigieron aquí. `ruff check .` sobre `services/ai-worker` tenía 116 errores reales, ahora en cero. E7-8 se implementó de verdad.
- **Segunda ronda de corrección**: la corrida citada como «la receta de `ci.yml`» en la primera ronda en realidad había fallado una prueba (`1 failed | 109 passed`) — `pipeline.test.ts` (Sprint 2) dependía de rutas de archivo de una máquina personal. Corregido con un fixture sintético versionado y worker+consumidor reales (`AI_PROVIDER=fake`) levantados por el propio `ci.yml`. Al levantarlos apareció un bug real, sin cobertura de `pytest`: un `ruff check --fix` de la primera ronda había roto la compatibilidad con Python 3.9 de los modelos Pydantic en `app/main.py`. Corregido. **Resultado final, verificado con la receta literal de `ci.yml` contra servicios efímeros recién creados: cero fallas** (§6).

**Lo que NO se cierra hoy:** la Demo A con material real de P80 y la regeneración de esa extracción (Gate INC-001B) — ambas `BLOCKED_EXTERNAL_INPUT` por la clave de OpenRouter. Es el único punto pendiente; el resto de la corrección solicitada está resuelto y verificado.

---

## 2. Matriz de requisitos

### 2.1 Requisitos funcionales (§3 del pedido)

| Requisito | Implementación | Prueba | Evidencia | Estado |
|---|---|---|---|---|
| 3.1 Confirmar/corregir/completar campos, con auditoría, sin sobrescribir procedencia en silencio | `packages/db/src/brief-fields.ts` (`confirmarCampo`, `corregirCampo`, `resolverConflicto`); revisión optimista por `revision`; historial en `brief_field_revisions`, nunca en `audit_events.metadata` | `brief-rules.test.ts`, uso real en Demo B (11 campos corregidos) | `field.correct` × 11 en la auditoría real de Demo B (§3 abajo); `FIELD_REVISION_CONFLICT` verificado en `CampoEditable.tsx` (auto-recarga) | **PASS** |
| 3.2 Anclaje real de producto — nunca mezclar campos entre productos | `campaign_products` real enviado al worker; `persistirExtraccion` rechaza `productoId` fuera de catálogo; índices únicos parciales por `campaign_product_id` | `test_extraction_producto.py`, `extraction.test.ts` (rechazo de producto inválido, ahora con datos 100% sintéticos propios — §5), `exception-por-producto.test.ts` (9 pruebas, E7-8) | El mecanismo está probado con datos sintéticos multiproducto (2 y 3 productos) y demostrado en vivo en el navegador (E7-8, §2.4); **el anclaje de los 3 productos reales de P80 (60/20/10) está confirmado a nivel de catálogo (§4), pero no se ha vuelto a demostrar con una extracción real nueva** porque esa extracción sigue bloqueada por la clave de OpenRouter | **PASS_TESTED / BLOCKED_REAL_DEMO** |
| 3.3 Camino de creación manual, funcional con `AI_ENABLED=false` | `packages/db/src/manual.ts` (`crearBriefManual`) — nunca llama al worker | `manual.test.ts` (3 pruebas) | **Demo B completa, real, en este documento** — campaña → brief manual → `internal_review`, cero llamadas a IA | **PASS** |
| 3.4 Máquina de estados del dominio conectada a transiciones reales, con guardas y auditoría | `packages/db/src/transitions.ts` (`transicionarBrief`) — único punto que cambia `brief_versions.status` | `transitions.test.ts` (6 pruebas) + ciclo completo en Demo B | 22 eventos de auditoría reales en Demo B, incl. dos `brief.transition` (a `processing_failed` en el intento fallido de P80, a `internal_review` en Demo B) | **PASS** |

### 2.2 Decisiones de producto (§4 del pedido)

| # | Decisión | Registrada en | Estado |
|---|---|---|---|
| DEC-023 | Anclaje de producto por nivel | decision-log.md | **PASS** |
| DEC-024 | Estrategia de «versión de trabajo» reutilizada | decision-log.md | **PASS** |
| DEC-025 | Mandatorios vs. restricciones | decision-log.md | **PASS** |
| DEC-026 | Fechas con precisión real | decision-log.md | **PARTIAL** — el modelo de dominio (`PrecisedDate`) existe y `responderPregunta` lo valida; **pero el editor manual (`corregirCampo`, usado por `CampoEditable.tsx`) guarda `practico.fecha_inicio`/`fecha_fin` como texto plano, sin pasar por el objeto de precisión** — verificado en vivo en Demo B, donde `2026-09-01` se guardó como cadena, no como `{tipo, fecha, textoOriginal}`. La decisión está tomada y parcialmente aplicada, no completamente — ver E7-3 abajo |
| DEC-027 | Aprobaciones — documentación, sin implementar | decision-log.md | **PASS** (como decisión declarativa; el ciclo de aprobación en sí queda fuera de este incremento por diseño) |
| DEC-028 | Evidencia vs. `manual_local` | decision-log.md | **PASS** — demostrado en Demo B: 5 claims vacíos descartados con justificación, sin bloquear el avance |
| DEC-029 | `CampaignProduct` de negocio en `packages/domain` | decision-log.md | **PASS** |

### 2.3 Épica E6 — Preguntas locales

| Historia | Estado | Nota |
|---|---|---|
| E6-1 Generar preguntas por campo ausente/en conflicto | **PASS** | `generarPreguntas`; 5 preguntas generadas correctamente en Demo B (exactamente los 5 claims vacíos, ninguna de más ni de menos) |
| E6-2 Pantalla de preguntas (UI-09) con motivo visible | **PASS** | `/campanas/[id]/preguntas`; motivo («No se encontró en las fuentes cargadas») visible en cada tarjeta |
| E6-3 Responder con autor y fecha | **PASS** | Verificado en `local-questions.test.ts`; formulario real en `TablaPreguntas.tsx` |
| E6-4 Descartar exigiendo justificación | **PASS** | Demostrado 5 veces en Demo B; el `CHECK` de base es la última línea de defensa, la función la exige primero |
| E6-5 Respuesta como `manual_local`, distinguible de lo extraído | **PASS** | Columna «procedencia» visible en la tabla del brief |
| E6-6 Preguntas pendientes visibles en el detalle de campaña | **PARTIAL** | Contador existe en `campanas/[id]/page.tsx`; sin desglose por criticidad |
| E6-7 Preguntas según el alcance del campo (DEC-016) | **PASS** | `campaign_product_id` en `local_questions`; una pregunta por producto para campos de nivel `producto`, una sola para los de campaña |

### 2.4 Épica E7 — Editor de brief

| Historia | Estado | Nota |
|---|---|---|
| E7-1 Editor por secciones (UI-10) | **PASS** | 10 secciones D0-05, navegación con contador de pendientes — usado en vivo en Demo B |
| E7-2 Autosave con indicador de estado | **PARTIAL** | Autoguardado real al perder foco (`onBlur`); el indicador es textual («guardando…»/«guardado»), no un ícono de estado persistente |
| E7-3 Validación en vivo contra el esquema | **PARTIAL** | Válido para texto libre y enum (aceptado tal cual); **las fechas no pasan por el objeto `PrecisedDate` en el editor manual** — se guardan como texto plano validado solo en el camino de preguntas (`responderPregunta`), no en `corregirCampo`. Mismo hallazgo que DEC-026 (§2.2) |
| E7-4 Crear y completar un brief sin IA | **PASS** | Demo B completa |
| E7-5 Evidencias visibles en panel lateral | **PASS** | `CampoEditable.tsx`, expansible sin salir de pantalla |
| E7-6 Comentarios internos sobre campos | **FAIL** (diferida) | Ninguna pieza construida — prioridad `should`, corte de alcance explícito |
| E7-7 Protección contra edición concurrente | **PASS** | Revisión optimista (`FIELD_REVISION_CONFLICT`), no bloqueo pesimista |
| E7-8 Interruptor compartido/específico por producto | **PASS** — corregido tras el checkpoint | Estaba diferida sin implementar; declararla `FAIL` sin más habría sido correcto, pero el reporte original la llamó «corte de alcance explícito» cuando en realidad estaba dentro del pedido aprobado — un error de reporte, no solo de alcance, ya corregido. Implementación real: `declararExcepcionProducto`/`revertirExcepcionProducto` (`packages/db/src/brief-fields.ts`), migración 006 (nuevo valor `declare_exception`/`revert_exception` en `brief_field_revisions.accion`), permiso `field:declare_exception`, server actions `declararExcepcionDeCampo`/`revertirExcepcionDeCampo`, UI en `CampoEditable.tsx` (`ControlExcepcion`). Motivo obligatorio verificado (rechaza vacío); persistencia verificada (fila nueva anclada a `campaign_product_id`, no toca la compartida); revertir verificado (borra la fila, vuelve a la compartida) |
| E7-9 Selector de producto en el editor | **PASS** | `SelectorProducto.tsx` — ejercitado en vivo con 2 productos reales al probar E7-8 (capturas §2.4.1); también cubierto en `manual.test.ts`/`transitions.test.ts` |

#### 2.4.1 E7-8 — evidencia

- **9 pruebas automatizadas** en `packages/db/src/exception-por-producto.test.ts`: exige motivo, rechaza un campo que no es `compartido_con_excepcion`, rechaza un producto ajeno a la campaña, crea la fila anclada sin tocar la compartida, dos productos con excepciones independientes, corregir una excepción existente (no duplica), conflicto de revisión (concurrencia optimista), revertir borra la fila, revertir un campo que no es excepción se rechaza.
- **Verificado en vivo en el navegador** (campaña de 2 productos, C7L y P80, sobre el campo `mandatorios`): declarar la excepción en C7L con motivo → la fila de C7L cambia a «excepción declarada para este producto»; se cambia el selector a P80 → sigue viendo la fila compartida, vacía, con la opción de declarar su propia excepción (aislamiento confirmado); se vuelve a C7L y se revierte → vuelve a mostrar la fila compartida.

### 2.5 Validación en `internal_review`

| Regla | Estado |
|---|---|
| Sin campos críticos sin resolver (`guardCriticalFieldsResolved`) | **PASS** — probado en `brief-states.test.ts`, demostrado en Demo B |
| Sin campos de producto sin anclar (`guardProductFieldsAnchored`) | **PASS** |
| Todo campo `found` revisado (`guardAllFieldsReviewed`) | **PASS** — demostrado: los 11 campos críticos de Demo B llegaron a `internal_review` con `review_status='corrected'`, ninguno `pending` |
| Claims con evidencia si `found` (`guardClaimsHaveEvidence`) | **PASS** — en Demo B los 5 claims quedaron `not_found` (descartados), por lo que la guarda no se disparó; cubierto además por `brief-states.test.ts` con un claim `found` sin evidencia real |
| Sin preguntas pendientes (`guardNoPendingQuestions` para `local_questions→extraction_review`) | **PASS** |
| Sin preguntas críticas pendientes (`guardNoPendingCriticalQuestions`) | **PASS** |

---

## 3. Demo B — brief completo sin IA (ejecutada, real)

**Definición de «brief completo» usada** (no basta llenar dos campos): los 11 campos críticos con valor `found` y revisados; los 5 claims sin evidencia real quedan `not_found` y se descartan con justificación (nunca se inventa una evidencia); ningún campo de producto (`marca_producto.*`) sin `campaign_product_id`; cero preguntas críticas pendientes; validación contra `brief-catalog.json` — resultado: transición real a `internal_review`.

**Recorrido ejecutado en el navegador, contra la aplicación real corriendo con Docker (`web`, `db`), sin ningún proveedor de IA involucrado:**

1. Campaña nueva («Demo B — brief sin IA», producto TCL P80 único) creada vía `/campanas/nueva`.
2. «Empezar el brief a mano» → `crearBriefManual` sembró las 41 claves del catálogo, `status='draft'`.
3. Editor (`/brief/editar`): los 11 campos críticos completados uno por uno, cada uno con autoguardado real al perder foco. Los 5 claims (`beneficio_principal`, `diferenciales`, `especificaciones`, `rtbs`, `beneficio_diferencial`) se dejaron sin llenar — a propósito, porque un claim manual sin evidencia real violaría la regla del sistema, no por omisión.
4. «Generar preguntas de lo que falte» → exactamente 5 preguntas, una por cada claim vacío. Ninguna para los críticos (ya resueltos) ni para los 25 campos informativos (no las generan).
5. Las 5 preguntas descartadas una por una, cada una con justificación explícita («Brief sintético de demostración: sin material fuente real que respalde un claim verificable»), registrando autor y fecha.
6. «Enviar a revisión interna» → transición real `draft → internal_review`, sin error, sin bloqueo.

**Verificado directamente en la base de datos real (`tclkolos`) al terminar:**

```
status = internal_review · version = 1
campos found = 11 · campos found sin revisar = 0
preguntas pendientes = 0 · preguntas descartadas = 5
```

**Auditoría completa (22 eventos, cronológicos, sin huecos):** `campaign.create` → `brief.manual_create` → 11× `field.correct` → `question.generate` → 5× `question.discard` → `brief.transition`.

Esta demo también demuestra, sin haberlo buscado, la regla central del README («siempre existe un camino sin IA»): se ejecutó inmediatamente después de que la Demo A real fallara por una clave de OpenRouter inválida — el sistema absorbió esa caída sin bloquear el trabajo.

---

## 4. Demo A — P80 real, con asistencia (BLOCKED_EXTERNAL_INPUT)

**Intentada el 26 de agosto de 2026, a través de la aplicación real — nunca por SQL manual.** Verificación previa contra `tclkolos` (base de desarrollo):

- Fuentes intactas: `Brief P80 del cliente.docx` y `Brief P80.md`, `status='procesado'`, 14 fragmentos en total.
- 3 productos anclados: P80 Ultra (flagship, 60%), P80 Pro (secundario, 20%), P80 (entrada, 10%).
- Único `brief_version` existente: versión 2, `approved`, anterior a este incidente.

Se disparó una extracción real desde `/campanas/{id}/brief` con el worker HTTP real (`AI_ENABLED=true`, `AI_PROVIDER=openrouter`). **Falló**: `AIError: La clave de OpenRouter no es válida o expiró.` — la misma causa ya observada antes en los logs del `consumidor` al indexar embeddings.

**Lo que sí queda demostrado, de forma independiente del bloqueo:** el ciclo de estados manejó la falla exactamente como está diseñado — versión de trabajo 3 creada (la 2 es terminal, correctamente no reutilizada), transición a `processing`, y al fallar la llamada real, transición a `processing_failed`, sin persistir campos a medias, con «Reintentar extracción» visible en la UI y los dos eventos de auditoría correspondientes. No es una simulación — es el mismo camino que seguiría cualquier corrida real.

**Estado:** `BLOCKED_EXTERNAL_INPUT`. Pendiente: una clave de OpenRouter válida. En cuanto exista, basta pulsar «Reintentar extracción» sobre la versión 3 ya creada — no hace falta recrear nada. Detalle completo en [INC-001 §7](../incidents/INC-001-test-data-collision.md#7-regeneración--gate-inc-001b).

**Gate INC-001B**: mismo estado — intentado, bloqueado por la misma causa, no cerrado.

---

## 5. Pruebas — mapa por área (no por número; ver nota)

> Nota: el pedido original numeraba 20 pruebas mandatorias más una de integración completa. Este documento no reproduce esa numeración de memoria para evitar atribuir un número exacto a una prueba que podría no corresponder — en su lugar, mapea cada área exigida a su archivo y cuenta real, verificable ejecutando la suite.

| Área | Archivo(s) | Pruebas | Resultado |
|---|---|---|---|
| Dominio: guardas, transiciones, permisos | `packages/domain/src/*.test.ts` | 61 | **PASS** |
| Anclaje de producto, rechazo de producto inválido | `extraction.test.ts` (`packages/db`) | 11 | **PASS** — reescrito tras el checkpoint: ya no lee fragmentos de una campaña compartida, siembra los suyos propios (§6) |
| Excepción por producto (E7-8) | `exception-por-producto.test.ts` | 9 | **PASS** — nuevo, ver §2.4.1 |
| Transiciones reales, conflicto de revisión | `transitions.test.ts` | 6 | **PASS** |
| Preguntas locales: idempotencia, alcance, descarte | `local-questions.test.ts` | 9 | **PASS** |
| Brief manual, claim vacío no bloquea | `manual.test.ts` | 3 | **PASS** |
| Aislamiento entre organizaciones | `isolation.test.ts` | 17 | **PASS** |
| Migración 005/006: índices, trigger, revisión | `brief-rules.test.ts` | 24 | **PASS** — corregido tras el checkpoint: ya no depende de una fuente ya cargada en otra campaña, siembra la suya (§6); se corrigió además un orden de borrado en cascada que solo se manifestaba con la fuente propia |
| Regresión INC-001 (centinela intacto) | `inc-001-aislamiento.test.ts` | 4 | **PASS** |
| Recorrido HTTP real con proveedor falso + camino 100% manual | `end-to-end.test.ts` | 2 | **PASS** |
| Fuentes, búsqueda semántica | `sources.test.ts`, `search.test.ts` | 23 | **PASS** — `search.test.ts` corregido tras el checkpoint: ya no depende de un fragmento indexado previamente, planta los suyos (§6) |
| Pipeline documental (E4) | `pipeline.test.ts` | 2 | **PASS** — corregido tras la revisión del product owner: ya no depende de rutas personales, usa `fixtures/pipeline/documento-de-prueba.pptx` (versionado); pasa con el worker+consumidor reales que ahora levanta `ci.yml` (§6) |
| Worker: esquema, extracción, producto, fechas, mandatorios/restricciones, proveedor falso | `services/ai-worker/tests/*.py` | 97 | **PASS** |
| Catálogo único TS/Python | `scripts/verificar-catalogo.mjs` | 1 verificación | **PASS** — 41 claves idénticas, misma criticidad y nivel |
| **Total `packages/db`** | 12 archivos | **110** | **PASS, cero fallas, cero omisiones sin explicar** — verificado contra la receta literal de `ci.yml` (Postgres + Redis + worker/consumidor fake efímeros), reproducido varias veces sin residuo (§6) |
| **Total general** (dominio + db + worker) | — | **268** | — |

---

## 6. CI y reproducibilidad desde cero

Esta sección tuvo dos versiones incorrectas antes de esta. La primera declaraba la suite «55 de 101 en verde en frío» y atribuía las tres fallas a archivos «no tocados en esta sesión» — falso para dos de los tres (`extraction.test.ts` y `brief-rules.test.ts` sí se reescribieron en este incremento). La segunda corrigió eso pero declaró CI en `PASS` con una corrida que en realidad había dado **`1 failed | 109 passed`** — un `PASS` no demostrado, señalado correctamente por el product owner. Esta versión solo declara `PASS` donde hay una corrida real, completa, con cero fallas, reproducida.

**Causa de la única falla que quedaba:** `pipeline.test.ts` (Sprint 2) tenía una rama que buscaba archivos en `/Users/gerardocalambasposada/Downloads/...` — rutas de una máquina de desarrollo concreta, que nunca existen en un runner de CI. La prueba se omitía en silencio en cualquier otra máquina, y en la mía intentaba correr de verdad sin que hubiera un `consumidor` apuntando a la base de la prueba, agotando el tiempo de espera. Corregido de raíz, no explicado ni excluido:

- **Fixture sintético versionado**: `fixtures/pipeline/documento-de-prueba.pptx` (generado una vez con `python-pptx`, 3 diapositivas con texto real, 30 KB), commiteado. `pipeline.test.ts` ya no referencia ninguna ruta personal — verificado que el parser real del worker lo procesa correctamente (3 fragmentos, uno por diapositiva, con su número de diapositiva).
- **Worker + consumidor reales en CI**, con `AI_PROVIDER=fake` (`ci.yml`, job `web`): se añadió el servicio `redis`, se instalan las dependencias de `services/ai-worker` y se levantan `uvicorn` (HTTP) y `worker.py` (consumidor) en segundo plano antes de las pruebas, apuntados a la misma base Postgres de la prueba. El parseo de documentos no depende de `AI_ENABLED`/`AI_PROVIDER` — nunca hace falta una clave real.
- **Bug real descubierto al levantar el worker así**: un `ruff check --fix` de la corrección anterior había convertido `Optional[int]` en `int | None` dentro de los modelos `pydantic.BaseModel` de `app/main.py`. A diferencia de una anotación de función normal, Pydantic v2 evalúa las anotaciones de un `BaseModel` en el momento de definir la clase — `from __future__ import annotations` no lo protege ahí — y esa sintaxis revienta en el Python 3.9 declarado como mínimo del proyecto (`requires-python = ">=3.9"`). Nada en la suite de `pytest` lo detectaba porque **ningún test importa `app.main`**. Corregido: `Optional[int]` de vuelta en esos cuatro campos, con `# noqa: UP007` y una nota en el propio código explicando por qué, para que no se repita.

| Punto | Estado | Detalle |
|---|---|---|
| Postgres real en el job `web` | **PASS** | Servicio `pgvector/pgvector:pg16`, migración y siembra de `tclkolos_test` antes de las pruebas |
| Redis + worker + consumidor reales en el job `web` | **PASS** (nuevo) | `AI_PROVIDER=fake`, levantados en segundo plano antes de las pruebas, con espera activa de `/ready` |
| Node en versión compatible con `--experimental-strip-types` | **PASS** | Subido de 20 a 22 en `ci.yml` y en `package.json` (`engines`) |
| Verificación de catálogo TS/Python en CI | **PASS** | Paso en el job `worker` |
| `ruff check .` sobre todo `services/ai-worker` | **PASS** | Los 116 errores originales se corrigieron sin excluir archivos ni relajar reglas. El propio proceso de corrección introdujo el bug de Pydantic descrito arriba, encontrado al verificar la CI limpia (no por una prueba automatizada) y corregido con una excepción puntual y documentada en el código, no revirtiendo la corrección completa |
| `mypy app` | **PASS** | Limpio |
| `pipeline.test.ts` sin rutas personales | **PASS** (corregido, no solo explicado) | Fixture sintético versionado; ver arriba |
| **Suite `packages/db` completa, sin ninguna omisión no documentada** | **PASS** | **`110/110`, cero fallas, cero omisiones sin explicar** |
| Única omisión, documentada | — | `extraction.test.ts › extracción contra el modelo real` se omite porque `/ready` reporta `ai_provider: "fake"` — esa prueba mide un costo real, que el proveedor falso no produce a propósito. Su camino crítico (extracción real por HTTP, verificación de evidencia, anclaje de producto, transición a `internal_review`) lo cubre `end-to-end.test.ts`, que sí corre con el proveedor falso y **pasa** |
| **Resultado literal de la receta de `ci.yml`** (Postgres + Redis + worker/consumidor fake + migrar + sembrar + `npm run lint` + `npm run typecheck` + `npm test` + `npm run build` + `npm run format:check`, contra servicios efímeros recién creados) | **PASS** | `packages/db`: **110 passed (110)**. `packages/domain`: **61 passed (61)**. `ruff check .`: **All checks passed**. `mypy app`: **Success: no issues found in 20 source files**. `pytest`: **97 passed**. Catálogo TS/Python: coincide. `next build`: compila. `prettier --check`: **All matched files use Prettier code style** (arreglado de paso: 26 archivos tenían desvíos de formato, incluidos varios de este mismo incremento — `npm run format:check` nunca se había corrido como parte de esta verificación hasta ahora) |

---

## 7. Documentación

| Documento | Estado |
|---|---|
| `HANDOFF.md` | **PASS** — reescrito con el estado real, incl. el bloqueo de la clave de OpenRouter |
| `CHANGELOG.md` | **PASS** — entrada nueva de este cierre |
| `docs/decisions/decision-log.md` | **PASS** — DEC-023 a DEC-029 |
| `docs/product/D0-11-backlog-mvp1.md` | **PASS** — anotaciones de estado en E6, E7, E8 (sin restructurar el documento completo) |
| `README.md` | **PASS** — `TEST_DATABASE_URL`, `AI_PROVIDER=fake`, requisito de Node, estado del proyecto |
| `docs/incidents/INC-001-test-data-collision.md` | **PASS** — Gate A cerrado, Gate B intentado y documentado como bloqueado |
| Este documento (D0-17) | **PASS** |

---

## 8. Higiene de entrega

| Punto | Estado |
|---|---|
| `.env` fuera del historial de git | **PASS** — confirmado, no versionado |
| `.storage/`, `node_modules`, `.next`, `fixtures/real/` excluidos | **PASS** — ya cubierto por `.gitignore` existente |
| Ningún archivo de esta sesión expone la clave de OpenRouter ni la respuesta cruda de un proveedor | **PASS** — verificado en `HANDOFF.md`, `INC-001-...md`, este documento: solo se cita el mensaje de error, nunca la clave ni el payload |
| `git status` limpio al momento de generar el ZIP | Pendiente de ejecutar — ver §9 |
| `TCL-sprint4-cierre.zip` vía `git archive` | Pendiente — ver §9 |

---

## 9. Siguiente paso inmediato

**Checkpoint técnico preservado en el commit `516de31`** — no es el cierre definitivo; los puntos 1 a 5 de la corrección posterior a ese checkpoint ya están resueltos y verificados en este documento (reproducibilidad desde cero, CI y `ruff` genuinamente limpios, E7-8 implementada, matriz corregida, doble corrida limpia). Falta solo el punto 6:

1. **El usuario actualiza la clave de OpenRouter, solo en su `.env` local** — no se solicita ni se copia por chat.
2. Con la clave renovada: ejecutar Demo A (extracción real de P80, tres productos correctamente separados, citas verificadas, una excepción por producto declarada desde la UI, preguntas locales, transición a `internal_review`) y cerrar Gate INC-001B, con evidencia y capturas.
3. Solo entonces: confirmar `git status` limpio, generar `TCL-sprint4-cierre.zip` con `git archive --format=zip HEAD -o TCL-sprint4-cierre.zip`, y declarar Sprint 4 cerrado.
4. Pendiente, no bloqueante para el cierre: decidir sobre las preguntas abiertas de `HANDOFF.md` §6 (ciclo de aprobación final, fechas con precisión real en el editor manual — DEC-026 §2.2 —, CI sin worker real para `pipeline.test.ts`).
