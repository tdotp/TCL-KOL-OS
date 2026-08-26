# D0-17 — Cierre de Sprint 3 + Sprint 4: brief funcional de punta a punta

**Fecha:** 26 de agosto de 2026, actualizado tras la ejecución real de Demo A y el cierre del Gate INC-001B. **Base:** commit `10788d9` (HANDOFF anterior). **Checkpoints técnicos:** `516de31` (preserva lo construido tras la revisión de plan), `b9b2768` (CI genuinamente verde, sin rutas personales ni clave de OpenRouter en la suite automatizada). **Alcance:** el pedido «Cierre real de Sprint 3 + Sprint 4 — brief funcional de punta a punta», aprobado por el product owner, más el mandato de incidente INC-001 y tres rondas de corrección posteriores al primer checkpoint: la primera (reproducibilidad desde cero, E7-8, precisión del reporte) declaró CI en `PASS` sin haberlo demostrado; la segunda lo corrigió de raíz y demostró CI limpia contra la receta literal de `ci.yml`; esta tercera ejecuta Demo A con la clave de OpenRouter ya renovada por el usuario, encuentra y corrige un defecto real de código durante la propia demo, y cierra el Gate INC-001B con evidencia verificada en base de datos.

Formato de estado, sin excepción: **PASS** (implementado, probado, con evidencia real, sin condiciones pendientes) · **PASS_TESTED / BLOCKED_REAL_DEMO** (el código y las pruebas automatizadas lo prueban; la demostración con el dato real de producción sigue bloqueada por algo externo) · **PARTIAL** (implementado con un corte de alcance explícito y documentado) · **FAIL** (no cumple, o diferido sin implementar) · **BLOCKED_EXTERNAL_INPUT** (el código está listo; falta un insumo externo fuera de mi control).

**Estado general de este incremento: CERRADO, con dos limitaciones documentadas y explícitas (no absolutas).** Demo A se ejecutó de punta a punta contra la aplicación real, con las fuentes originales de P80 y OpenRouter real: la versión 3 del brief llegó a `internal_review` con 51/51 campos encontrados revisados, 69/69 citas verificadas literalmente contra su fragmento fuente, los tres productos correctamente separados sin mezclar valores, una excepción por producto declarada y verificada desde la UI, y dos preguntas locales resueltas (una respondida, una descartada con justificación). El Gate INC-001B queda en `PASS`. Las dos limitaciones que siguen abiertas, ninguna bloqueante para este cierre: DEC-026 permanece `PARTIAL` (el editor manual de corrección todavía guarda fechas como texto plano, no como el objeto de precisión — ver §2.2) y E7-6 (comentarios internos) sigue `FAIL` por diseño, diferida desde la revisión de plan original.

---

## 1. Resumen ejecutivo

El HANDOFF previo declaraba Sprint 3 cerrado, pero la máquina de estados del dominio (12 estados, ~25 transiciones) nunca se invocaba fuera de su propio test, y la pantalla de extracción era de solo lectura. Este incremento conecta lo modelado, construye lo que faltaba, y lo demuestra con datos reales:

- El ciclo de estados corre de verdad, con guardas reales y auditoría en cada paso — demostrado tanto en Demo B (sin IA) como en Demo A (con IA, P80 real), incluyendo el manejo correcto de un fallo real (`processing_failed` cuando la clave de OpenRouter aún no era válida) y su recuperación (`reintentarExtraccion`).
- El anclaje de producto funciona de extremo a extremo (worker → repositorio → base) — **demostrado con datos sintéticos multiproducto y, ahora, con los tres productos reales de P80** (§4, §2.1).
- Existe un camino manual, funcional con `AI_ENABLED=false`, demostrado end-to-end (Demo B).
- La Épica E6 (preguntas locales) tiene repositorio y UI reales, ejercitada en ambas demos. La E7 (editor) igual, incluida E7-8 (excepción por producto en un campo compartido), demostrada tanto con datos sintéticos como en vivo sobre P80 (§4).
- El incidente de datos de prueba INC-001 se contuvo (Gate A) y se regeneró con éxito (Gate B): la extracción perdida no era restaurable de forma idéntica, así que se generó una extracción nueva con el pipeline corregido, verificada de punta a punta.
- **Primera ronda de corrección** (checkpoint `516de31`): reproducibilidad de `packages/db` desde una base recién creada, `ruff` genuinamente limpio (116→0 errores reales), E7-8 implementada.
- **Segunda ronda de corrección** (checkpoint `b9b2768`): la corrida citada como «la receta de `ci.yml`» en la primera ronda en realidad había fallado una prueba — corregido de raíz (fixture sintético versionado, worker+consumidor reales con `AI_PROVIDER=fake` en CI). Verificado con cero fallas contra servicios efímeros recién creados.
- **Tercera ronda — Demo A y cierre de INC-001B** (este documento): con la clave de OpenRouter ya renovada por el usuario en su `.env` local, se ejecutó la extracción real de P80. Durante la demo apareció un defecto de código real (no cosmético): corregir un campo ya extraído con `confidence` no nulo violaba la restricción `brief_fields_manual_sin_confianza` (error 500 real en la UI). Se corrigió en las 4 rutas afectadas, se añadieron 5 pruebas de regresión nuevas, y se volvió a correr toda la matriz de verificación antes de este cierre (§6).

**Lo que queda abierto, documentado, no bloqueante:** DEC-026 sigue `PARTIAL` (fechas como texto plano en el editor manual de corrección, ver §2.2) y E7-6 sigue `FAIL` (diferida por diseño desde la revisión de plan original).

---

## 2. Matriz de requisitos

### 2.1 Requisitos funcionales (§3 del pedido)

| Requisito | Implementación | Prueba | Evidencia | Estado |
|---|---|---|---|---|
| 3.1 Confirmar/corregir/completar campos, con auditoría, sin sobrescribir procedencia en silencio | `packages/db/src/brief-fields.ts` (`confirmarCampo`, `corregirCampo`, `resolverConflicto`); revisión optimista por `revision`; historial en `brief_field_revisions`, nunca en `audit_events.metadata` | `brief-rules.test.ts`, uso real en Demo B (11 campos corregidos) | `field.correct` × 11 en la auditoría real de Demo B (§3 abajo); `FIELD_REVISION_CONFLICT` verificado en `CampoEditable.tsx` (auto-recarga) | **PASS** |
| 3.2 Anclaje real de producto — nunca mezclar campos entre productos | `campaign_products` real enviado al worker; `persistirExtraccion` rechaza `productoId` fuera de catálogo; índices únicos parciales por `campaign_product_id` | `test_extraction_producto.py`, `extraction.test.ts` (rechazo de producto inválido, con datos 100% sintéticos propios — §5), `exception-por-producto.test.ts` (9 pruebas, E7-8) | Probado con datos sintéticos multiproducto y **demostrado con la extracción real de P80** (Demo A, §4): 21 campos `marca_producto[].*` (7 claves × 3 productos), cada uno con su `campaign_product_id` real, sin ninguno `NULL` ni mezclado entre P80 / P80 Pro / P80 Ultra — verificado por consulta directa a `brief_fields` | **PASS** |
| 3.3 Camino de creación manual, funcional con `AI_ENABLED=false` | `packages/db/src/manual.ts` (`crearBriefManual`) — nunca llama al worker | `manual.test.ts` (3 pruebas) | **Demo B completa, real, en este documento** — campaña → brief manual → `internal_review`, cero llamadas a IA | **PASS** |
| 3.4 Máquina de estados del dominio conectada a transiciones reales, con guardas y auditoría | `packages/db/src/transitions.ts` (`transicionarBrief`) — único punto que cambia `brief_versions.status` | `transitions.test.ts` (6 pruebas) + ciclo completo en Demo B | 22 eventos de auditoría reales en Demo B, incl. dos `brief.transition` (a `processing_failed` en el intento fallido de P80, a `internal_review` en Demo B) | **PASS** |

### 2.2 Decisiones de producto (§4 del pedido)

| # | Decisión | Registrada en | Estado |
|---|---|---|---|
| DEC-023 | Anclaje de producto por nivel | decision-log.md | **PASS** |
| DEC-024 | Estrategia de «versión de trabajo» reutilizada | decision-log.md | **PASS** |
| DEC-025 | Mandatorios vs. restricciones | decision-log.md | **PASS** |
| DEC-026 | Fechas con precisión real | decision-log.md | **PARTIAL** — confirmado con dos evidencias independientes en Demo A: (1) la capa de extracción/preguntas locales **sí** produce el objeto `PrecisedDate` correcto — `practico.fecha_inicio` quedó `{"tipo":"exacta","fecha":"2026-09-15","textoOriginal":"2026-09-15"}` vía `responderPregunta`, y `practico.fecha_fin` quedó `{"tipo":"rango","inicio":"2026-10-01","fin":"2026-11-30","textoOriginal":"Octubre-Noviembre 2026"}` directo de la extracción del worker; (2) **el editor manual (`corregirCampo`, usado por `CampoEditable.tsx`) sigue sin pasar por ese objeto** — confirmado también en Demo B, donde `2026-09-01` se guardó como cadena plana. La decisión está tomada y aplicada en la capa de extracción/preguntas, no en la de corrección manual — ver E7-3 abajo |
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
- **Verificado también con datos reales de P80** (Demo A, §4, punto 9): excepción declarada sobre `mandatorios` para el producto P80 (entrada, `61b14b9a…`) — «Para P80 (entrada): priorizar canje sobre pauta paga, dado el presupuesto residual tras P80 Ultra y P80 Pro.», con motivo obligatorio registrado (`brief_field_revisions.accion = 'declare_exception'`). Confirmado en base de datos que P80 Pro y P80 Ultra conservan intacta la fila compartida (`campaign_product_id IS NULL`, los 4 mandatorios originales) — la excepción no la tocó.

### 2.5 Validación en `internal_review`

| Regla | Estado |
|---|---|
| Sin campos críticos sin resolver (`guardCriticalFieldsResolved`) | **PASS** — probado en `brief-states.test.ts`; demostrado en Demo B y en Demo A (0 críticos pendientes en P80 v3) |
| Sin campos de producto sin anclar (`guardProductFieldsAnchored`) | **PASS** — demostrado en Demo A: 21/21 campos `marca_producto[].*` con `campaign_product_id` real |
| Todo campo `found` revisado (`guardAllFieldsReviewed`) | **PASS** — demostrado en Demo B (11 críticos, todos `corrected`) y en Demo A: **51/51 campos `found` de P80 v3 confirmados o corregidos desde la UI real** (49 `confirmed`, 2 `corrected`), ninguno quedó `pending` |
| Claims con evidencia si `found` (`guardClaimsHaveEvidence`) | **PASS** — en Demo B los 5 claims quedaron `not_found` (descartados); en Demo A los claims `found` (`marca_producto[].*` con `criticidad: claim`) tienen evidencia real, verificada literalmente (§4, punto 5) |
| Sin preguntas pendientes (`guardNoPendingQuestions` para `local_questions→extraction_review`) | **PASS** — demostrado en Demo A: `local_questions → extraction_review` real tras resolver las 2 preguntas generadas |
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

## 4. Demo A — P80 real, con asistencia (PASS)

**Ejecutada el 26 de agosto de 2026, a través de la aplicación real — nunca por SQL manual.** El primer intento (mismo día, más temprano) falló por una clave de OpenRouter inválida y quedó documentado en [INC-001 §7](../incidents/INC-001-test-data-collision.md#7-regeneración--gate-inc-001b) como prueba positiva del manejo de fallas (`processing → processing_failed`, sin persistir campos a medias). Con la clave ya renovada por el usuario en su `.env` local, se pulsó «Reintentar extracción» sobre la misma versión de trabajo 3 — sin recrear nada — y la extracción corrió de verdad contra OpenRouter.

**1. Fuentes intactas** — confirmado antes de reintentar: `Brief P80 del cliente.docx` y `Brief P80.md`, `status='procesado'`, 14 fragmentos, ambos aún asociados a P80.

**2. Extracción real vía OpenRouter** — `transicionarBrief` llevó la versión 3 de `processing_failed` a `processing`, la llamada real completó, y transicionó a `extraction_review`. Modelo `google/gemini-2.5-flash-lite`, `output_status: ok_con_descartes` (8 descartes legítimos basados en cita, ninguno fabricado), latencia `19504 ms`, costo `USD 0.005886`, `5811` tokens de prompt / `13261` de salida — un único registro en `ai_runs`, sin exponer nunca el payload crudo del proveedor.

**3. Versión de trabajo reutilizada correctamente (DEC-024)** — la versión 2 (`approved`, terminal) nunca se tocó; `obtenerOCrearVersionDeTrabajo` reutilizó la versión 3 ya creada en el intento fallido, tal como diseña DEC-024.

**4. Los tres productos, sin mezclar** — verificado por consulta directa: 21 campos `marca_producto[].*` (7 claves × 3 productos: P80 Ultra `9ed9afd3…`, P80 Pro `4e3d673d…`, P80 `61b14b9a…`), cada uno con su `campaign_product_id` real, ninguno `NULL` y ninguno compartiendo valor entre productos donde no correspondía (p. ej. `nombre_producto` distinto por fila: «TCL P80», «TCL P80 Pro», «TCL P80 Ultra»).

**5. Citas verificadas literalmente** — las 69 filas de `evidence` de esta versión comparadas contra el texto real de su `source_fragment` (normalizando espacios/mayúsculas, la misma normalización que usa `extraction.py:_normalizar()` para aceptar la cita en primer lugar): **69/69 coinciden**, ninguna inventada.

**6. Mandatorios vs. restricciones (DEC-025)** — clasificación correcta en general (`mandatorios`: 4 elementos — canal, capacidad de CTA, prioridad de presupuesto por producto, exclusividad de marca; `practico.restricciones`: 2 elementos — canal único, exclusividad de marca). **Hallazgo, no defecto**: 2 de los 4 mandatorios («único canal de venta: Alkosto y Ktronix» y «KOLs no comprometidos con Samsung») aparecen también, literalmente, en `restricciones`. Es una superposición de contenido legítima — ambos elementos son simultáneamente «algo que debe cumplirse» y «un límite que lo acota» — no una confusión del modelo entre las dos categorías; DEC-025 no exige que sean mutuamente excluyentes en el límite. Se deja documentado como comportamiento observado del prompt, fuera del alcance de este cierre (no es una optimización de prompt pedida).

**7. Precisión de fechas (DEC-026)** — `practico.fecha_inicio` no vino en la extracción (`not_found`, crítico) y disparó una pregunta local; respondida vía `responderPregunta` con `{"tipo":"exacta","fecha":"2026-09-15","textoOriginal":"2026-09-15"}` — el objeto de precisión correcto, `provenance_type: manual_local`, `confidence: NULL`. `practico.fecha_fin` sí vino de la extracción, ya como objeto de precisión: `{"tipo":"rango","inicio":"2026-10-01","fin":"2026-11-30","textoOriginal":"Octubre-Noviembre 2026"}`. **Confirma el hallazgo de DEC-026 (§2.2) con más precisión que antes**: la capa de extracción y la de preguntas locales manejan `PrecisedDate` correctamente; solo el editor manual de corrección (`corregirCampo`) sigue sin ese objeto — no se tocó ninguna fecha por ese camino en esta demo, así que no se repitió el defecto de Demo B aquí.

**8. Confirmación/corrección desde la UI real** — 44 campos `found` en `sin confirmar` al llegar a `extraction_review` (0 críticos pendientes, 0 conflictos) se revisaron uno por uno con el botón «Confirmar» de la tabla real (`/campanas/{id}/brief`), cada clic un `UPDATE` real con `revisionEsperada` correcto: **49 quedaron `confirmed`, 2 `corrected`** (ya corregidos antes en la sesión: `mandatorios` de P80 vía excepción, `marca_producto[].rol_marca` de P80 Ultra). Verificado en base: `49 confirmed + 2 corrected = 51 found`, `0 pending` sobre campos `found`.

**Defecto real encontrado y corregido durante este paso** (no cosmético): al corregir manualmente un campo que el worker ya había extraído con `confidence` no nulo, la aplicación devolvía un error 500 real — `corregirCampo`, `resolverConflicto` y `declararExcepcionProducto` (rama de fila existente) ponían `provenance_type = 'manual_local'` sin poner `confidence = NULL`, violando el `CHECK` `brief_fields_manual_sin_confianza` de la migración 004. Se encontró la misma falta en `responderPregunta` (`local-questions.ts`) por inspección directa, antes de que se manifestara en la demo. Corregido en las 4 rutas; 5 pruebas de regresión nuevas (`brief-fields.test.ts`, 4 casos nuevos; 1 caso nuevo en `local-questions.test.ts`) simulan exactamente el caso que ningún test anterior cubría — un campo con `confidence` real, no el `NULL` que siembra `crearBriefManual`. Detalle de la corrección y la re-verificación completa de CI en §6.

**9. Excepción por producto declarada y verificada (E7-8)** — sobre el campo compartido `mandatorios`, se declaró una excepción para P80 (entrada, `61b14b9a…`): «Para P80 (entrada): priorizar canje sobre pauta paga, dado el presupuesto residual tras P80 Ultra y P80 Pro.», con motivo obligatorio. Verificado en base: la fila compartida (`campaign_product_id IS NULL`) conserva sus 4 mandatorios originales sin tocar; P80 Pro y P80 Ultra siguen viendo esa fila compartida; solo P80 tiene su propia fila, `provenance_type: manual_local`, `review_status: corrected`. Registrado en `brief_field_revisions` con `accion = 'declare_exception'` y el motivo completo.

**10-11. Preguntas locales generadas y resueltas** — `generarPreguntas` creó exactamente 2 preguntas (`practico.fecha_inicio`, crítico `not_found`; `practico.fecha_fin`, crítico con precisión distinta de exacta), y la transición `extraction_review → local_questions` ocurrió automáticamente al haber ≥1 pregunta, tal como diseña la Fase D. `practico.fecha_inicio` se respondió (ver punto 7); `practico.fecha_fin` se descartó con justificación real: «El cliente aún no confirma el día exacto de cierre; el rango (Octubre-Noviembre 2026) es suficiente para planear.» — verificado en `local_questions`: `status='respondida'`/`'descartada'`, autor y fecha registrados en ambas, `answer_value` solo en la respondida (nunca en el descarte, tal como exige la corrección 3 del plan).

**12. Transición a `internal_review`** — con 0 preguntas pendientes, «Volver al brief» ejecutó `local_questions → extraction_review` real (guardada por `guardNoPendingQuestions`); con 0 críticos pendientes, 0 conflictos y 0 campos `found` sin revisar, «Enviar a revisión interna» ejecutó `extraction_review → internal_review` real. **Ninguna guarda se relajó ni se sorteó** — los 5 campos `not_found` restantes (`contexto.contexto_global`, `marca_producto[].activos_marca` × 3, `problema_insight.tension`) no bloquean `guardAllFieldsReviewed` porque esa guarda solo exige revisión sobre campos `found`, por diseño (Fase A).

**13. Verificación final en base de datos** — `brief_versions`: versión 3, `status = 'internal_review'`. `brief_fields`: 49 `confirmed` + 2 `corrected` (found) + 5 `pending` (not_found, correcto). `campaign_products`: 3, correctamente anclados. `evidence`: 69, 69/69 verificadas literalmente. `local_questions`: 2, ambas resueltas. `ai_runs`: 1 fila, ver punto 2. `audit_events`: cadena completa y sin huecos — `brief.transition` (`draft→processing`, `processing→processing_failed`, `processing_failed→processing`, `processing→extraction_review`, `extraction_review→local_questions`, `local_questions→extraction_review`, `extraction_review→internal_review`), más `question.generate`.

**14. Modelo, costo, duración, resultado** — ver punto 2. `output_status: ok_con_descartes`: 51 campos `found` en total (48 con `provenance_type: extracted` directo del modelo, 3 con `provenance_type: manual_local` — la excepción de `mandatorios` para P80, la corrección de `rol_marca` de P80 Ultra, y `fecha_inicio` respondida por pregunta local), 5 `not_found`, 0 `conflict`, 8 descartes de cita explicados por el propio worker.

**15. Capturas** — capturadas en sesión (estado `internal_review` final de la tabla de campos, con 0 sin confirmar / 0 críticos / 0 conflictos); no se incluyen como binarios en el `git archive` de §8 (que solo contiene archivos versionados) — quedan como evidencia de la sesión, no como parte del repositorio.

**Estado: PASS.** Gate INC-001B: **PASS** — cerrado, ver [INC-001 §7](../incidents/INC-001-test-data-collision.md#7-regeneración--gate-inc-001b) actualizado.

---

## 5. Pruebas — mapa por área (no por número; ver nota)

> Nota: el pedido original numeraba 20 pruebas mandatorias más una de integración completa. Este documento no reproduce esa numeración de memoria para evitar atribuir un número exacto a una prueba que podría no corresponder — en su lugar, mapea cada área exigida a su archivo y cuenta real, verificable ejecutando la suite.

| Área | Archivo(s) | Pruebas | Resultado |
|---|---|---|---|
| Dominio: guardas, transiciones, permisos | `packages/domain/src/*.test.ts` | 61 | **PASS** |
| Anclaje de producto, rechazo de producto inválido | `extraction.test.ts` (`packages/db`) | 11 | **PASS** — reescrito tras el checkpoint: ya no lee fragmentos de una campaña compartida, siembra los suyos propios (§6) |
| Excepción por producto (E7-8) | `exception-por-producto.test.ts` | 9 | **PASS** — nuevo, ver §2.4.1 |
| Transiciones reales, conflicto de revisión | `transitions.test.ts` | 6 | **PASS** |
| Preguntas locales: idempotencia, alcance, descarte | `local-questions.test.ts` | 10 | **PASS** — +1 tras Demo A: regresión del bug de `confidence`/`provenance_type` en `responderPregunta` |
| Brief manual, claim vacío no bloquea | `manual.test.ts` | 3 | **PASS** |
| Aislamiento entre organizaciones | `isolation.test.ts` | 17 | **PASS** |
| Migración 005/006: índices, trigger, revisión | `brief-rules.test.ts` | 24 | **PASS** — corregido tras el checkpoint: ya no depende de una fuente ya cargada en otra campaña, siembra la suya (§6); se corrigió además un orden de borrado en cascada que solo se manifestaba con la fuente propia |
| Regresión INC-001 (centinela intacto) | `inc-001-aislamiento.test.ts` | 4 | **PASS** |
| Recorrido HTTP real con proveedor falso + camino 100% manual | `end-to-end.test.ts` | 2 | **PASS** |
| Confirmar/corregir/resolver conflicto sobre un campo con `confidence` real (regresión Demo A) | `brief-fields.test.ts` (nuevo) | 4 | **PASS** — nuevo tras el defecto real encontrado en Demo A (§4, punto 8) |
| Fuentes, búsqueda semántica | `sources.test.ts`, `search.test.ts` | 23 | **PASS** — `search.test.ts` corregido tras el checkpoint: ya no depende de un fragmento indexado previamente, planta los suyos (§6) |
| Pipeline documental (E4) | `pipeline.test.ts` | 2 | **PASS** — corregido tras la revisión del product owner: ya no depende de rutas personales, usa `fixtures/pipeline/documento-de-prueba.pptx` (versionado); pasa con el worker+consumidor reales que ahora levanta `ci.yml` (§6) |
| Worker: esquema, extracción, producto, fechas, mandatorios/restricciones, proveedor falso | `services/ai-worker/tests/*.py` | 97 | **PASS** |
| Catálogo único TS/Python | `scripts/verificar-catalogo.mjs` | 1 verificación | **PASS** — 41 claves idénticas, misma criticidad y nivel |
| **Total `packages/db`** | 13 archivos | **115** | **PASS, cero fallas, cero omisiones sin explicar** — verificado contra la receta literal de `ci.yml` (Postgres + Redis + worker/consumidor fake efímeros), reproducido varias veces sin residuo, y **re-verificado íntegro después del defecto de `confidence`/`provenance_type` encontrado y corregido en Demo A** (§6) |
| **Total general** (dominio + db + worker) | — | **273** | — |

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

### 6.1 Tercera re-verificación — tras el defecto real encontrado en Demo A

Demo A (§4, punto 8) encontró un defecto de código real durante el uso genuino de la aplicación: corregir un campo ya extraído con `confidence` no nulo violaba `brief_fields_manual_sin_confianza` (error 500 real). Corregido en `corregirCampo`, `resolverConflicto`, `declararExcepcionProducto` (rama existente) y `responderPregunta` — cada `UPDATE` que cambia `provenance_type` a `manual_local` ahora también pone `confidence = NULL`. Por instrucción explícita del product owner («si la extracción revela un defecto de código, corrígelo y vuelve a ejecutar toda la CI antes de cerrar»), se repitió la matriz completa, no solo las pruebas nuevas:

| Paso | Resultado |
|---|---|
| `npm run lint` (ESLint, `--max-warnings=0`) | **PASS** — 0 errores, 0 warnings |
| `npm run typecheck` (3 workspaces) | **PASS** — limpio en `web`, `db`, `domain` |
| `ruff check .` (`services/ai-worker`) | **PASS** — «All checks passed» |
| `pytest` (`services/ai-worker`) | **PASS** — **97/97** |
| `vitest run` (`packages/domain`) | **PASS** — **61/61** |
| `vitest run` (`packages/db`) | **PASS** — **115/115** (110 previos + 4 de `brief-fields.test.ts` nuevo + 1 nuevo en `local-questions.test.ts`), incluidas las 5 pruebas de regresión que simulan exactamente el caso que ningún test anterior cubría: un campo con `confidence` real, no el `NULL` que siembra `crearBriefManual` |
| `next build` | **PASS** — compila limpio, todas las rutas generadas |

**Nota sobre `pipeline.test.ts` en esta corrida local puntual:** al ejecutar `npm test` de forma ad hoc contra los contenedores Docker persistentes de desarrollo, esa prueba falló una vez porque el `consumidor` persistente apunta a `tclkolos` (la base de desarrollo), no a `tclkolos_test` (donde la prueba inserta el documento) — un desajuste de infraestructura local, no una regresión de código. Verificado de forma aislada: deteniendo el `consumidor` de desarrollo y levantando un worker+consumidor efímero con `AI_PROVIDER=fake` apuntado a `tclkolos_test` — exactamente la topología que usa `ci.yml` — la prueba **pasa 2/2**. `ci.yml` en GitHub Actions no tiene este problema porque siempre levanta su propio worker+consumidor efímero contra el único Postgres del job (§6, tabla de arriba) — este matiz es exclusivo de correr `npm test` a mano contra los contenedores de desarrollo de esta máquina.

**Precisión sobre qué acciones de Demo A ejercitaron realmente la corrección**: `confirmarCampo` (usado en los 49 clics «Confirmar») nunca tocó `provenance_type` ni `confidence` — nunca tuvo el bug. Las tres acciones que sí lo ejercitaron en vivo, después de aplicado el fix, fueron `corregirCampo` (corrección de `rol_marca` de P80 Ultra), `declararExcepcionProducto` (excepción de `mandatorios` para P80) y `responderPregunta` (respuesta de `fecha_inicio`) — las tres sobre campos que ya tenían `confidence` no nulo por venir de la extracción real, y las tres completaron sin error 500, consistente con el fix y con las 5 pruebas de regresión nuevas.

---

## 7. Documentación

| Documento | Estado |
|---|---|
| `HANDOFF.md` | **PASS** — reescrito con el resultado real de Demo A y el cierre de INC-001B |
| `CHANGELOG.md` | **PASS** — entrada nueva de este cierre |
| `docs/decisions/decision-log.md` | **PASS** — DEC-023 a DEC-029 |
| `docs/product/D0-11-backlog-mvp1.md` | **PASS** — anotaciones de estado en E6, E7, E8 (sin restructurar el documento completo) |
| `README.md` | **PASS** — `TEST_DATABASE_URL`, `AI_PROVIDER=fake`, requisito de Node, estado del proyecto |
| `docs/incidents/INC-001-test-data-collision.md` | **PASS** — Gate A y Gate B cerrados |
| Este documento (D0-17) | **PASS** |

---

## 8. Higiene de entrega

| Punto | Estado |
|---|---|
| `.env` fuera del historial de git | **PASS** — confirmado, no versionado |
| `.storage/`, `node_modules`, `.next`, `fixtures/real/` excluidos | **PASS** — ya cubierto por `.gitignore` existente |
| Ningún archivo de esta sesión expone la clave de OpenRouter ni la respuesta cruda de un proveedor | **PASS** — verificado en `HANDOFF.md`, `INC-001-...md`, este documento: solo se cita el mensaje de error o métricas (costo, latencia, conteo de campos), nunca la clave ni el payload del modelo |
| `git status` limpio al momento de generar el ZIP | **PASS** — ver commit de cierre |
| `TCL-sprint4-cierre.zip` vía `git archive` | **PASS** — generado solo con archivos versionados |

---

## 9. Cierre

Los tres checkpoints — `516de31` (reproducibilidad, E7-8), `b9b2768` (CI genuinamente verde) y el commit de cierre definitivo que preserva este documento — completan la corrección solicitada por el product owner de punta a punta: los puntos 1 a 5 (reproducibilidad desde cero, CI y `ruff` genuinamente limpios, E7-8 implementada, matriz corregida, doble corrida limpia) y el punto 6 (Demo A real con P80, Gate INC-001B cerrado). Pendiente, explícitamente no bloqueante para este cierre — deliberado, no un descuido: el ciclo de aprobación final (DEC-027, documentado, fuera de alcance de este incremento por diseño), fechas con precisión real en el editor manual de corrección (DEC-026 §2.2), y E7-6 (comentarios internos, diferida desde la revisión de plan original).
