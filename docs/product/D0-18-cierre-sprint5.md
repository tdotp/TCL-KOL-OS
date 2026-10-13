> **Documento histórico** (anterior a V2): no describe el modelo vigente; ver docs/project/V2_CURRENT_STATE.md y DEC-042 a DEC-050.

# D0-18 — Cierre de Sprint 5: ciclo completo del brief, de `internal_review` a `approved`

**Fecha:** 15–16 de septiembre de 2026, con corrección de cierre el 16 de septiembre de 2026. **Commit base:** `106f622cf6e168e99e24d82cb9bff04ce604cc55` (estado aprobado del cierre de Sprint 4, ver [D0-17](D0-17-cierre-sprint4.md)). **Commit de la entrega inicial de Sprint 5:** `03688f18b70e65968420c547d7ef4e79816516de`. **Commit correctivo** (esta versión del documento): ver §10 — corrige dos defectos de cierre encontrados en auditoría independiente del ZIP de la entrega inicial, sin ampliar alcance.

Formato de estado, sin excepción: **PASS** (implementado, probado, con evidencia real, sin condiciones pendientes) · **PARTIAL** (implementado con un corte de alcance explícito y documentado) · **FAIL** (no cumple, o diferido sin implementar) · **BLOCKED** (depende de algo fuera de mi control). No se usa `PASS` sin prueba y evidencia.

**Estado general: CERRADO**, con la corrección de auditoría incorporada. Los tres flujos pedidos — aprobación interna con motivo, revisión y decisión del cliente, y versionado posterior a aprobación — corren de punta a punta en la aplicación real, verificados con la suite automatizada (**364 pruebas** tras la corrección, ver §6) y con dos demostraciones manuales completas en el navegador (Demo C y Demo D). La entrega inicial encontró y corrigió seis defectos reales al ejercitar `approved` por primera vez en la vida del proyecto (§5); la auditoría de cierre encontró dos defectos más — uno en el workflow de CI, otro en la inmutabilidad histórica de la base tras `superseded` — ambos corregidos aquí, ver §10.

---

## 1. Resumen ejecutivo

El cierre de Sprint 4 dejaba el brief funcional hasta `internal_review`; el ciclo de aprobación (DEC-027) estaba documentado pero nunca implementado, y por eso nunca ejercitado. Este incremento:

- Conecta las transiciones `internal_review → internal_changes_requested → internal_review → client_review → client_changes_requested → internal_review → client_review → approved`, todas ya declaradas en el dominio desde Sprint 3/4 (`packages/domain/src/brief-states.ts`) pero sin ningún código que las invocara con datos reales.
- Añade fechas con precisión real (`PrecisedDate`, DEC-026) al editor manual — antes solo la extracción y las preguntas locales lo respetaban.
- Añade comentarios internos por campo (E7-6), diferidos desde Sprint 4.
- Añade la vista de solo lectura y decisión del cliente (ampliación de ADR-004), con permisos nuevos y acotados.
- Añade la creación de versión hija tras una aprobación (DEC-027), con candado de concurrencia.
- **Al ejercitar por primera vez estos caminos con datos reales** (no solo con datos en memoria de una prueba de dominio), aparecieron seis defectos reales, cada uno documentado en el decision-log (DEC-032 a DEC-034 y esta sección) y corregido antes de cerrar — el mismo patrón que Demo A de Sprint 4 ya había dejado como lección: *un camino nunca ejercitado no está probado, esté o no cubierto por una prueba en memoria*.
- **Una auditoría independiente posterior a la entrega inicial (`03688f1`) encontró dos defectos de cierre más**, ninguno de alcance nuevo: el workflow de CI nunca podía correr en un runner limpio (`.venv` referenciado sin crearse nunca), y la inmutabilidad histórica de la base desaparecía por completo después de `superseded` — justo el estado al que llega una versión `approved` al crear su hija (Fase E, este mismo incremento). Ambos corregidos, ver §10.

---

## 2. Matriz requisito → implementación → prueba → evidencia → estado

| # | Requisito | Implementación | Prueba | Evidencia | Estado |
|---|---|---|---|---|---|
| 1 | Comentarios internos en campos (E7-6) | `infra/db/migrations/007_comentarios_internos.sql`; `packages/db/src/comments.ts`; `PanelComentarios.tsx` | `comments.test.ts` (11) | Demo C: comentario creado y resuelto en vivo sobre `contexto.situacion`, ver §4 punto 3 | **PASS** |
| 2 | Fechas estructuradas en el editor manual (DEC-026) | `packages/domain/src/field-values.ts` (`validarValorEstructurado`, movida desde `local-questions.ts`); `packages/db/src/brief-fields.ts` (`validarSiEsFecha`, aplicada solo a `valueType:'fecha'` — ver defecto 3, §5); `apps/web/src/components/ControlDeFecha.tsx` (extraído de `TablaPreguntas.tsx`, reusado en `CampoEditable.tsx`) | `field-values.test.ts` (17); `brief-fields.test.ts` (2 nuevas) | Demo C: `practico.fecha_inicio`/`fecha_fin` fijadas con el control real en el navegador, ver §4 punto 2 | **PASS** |
| 3 | Solicitud de cambios internos, motivo obligatorio | `transicionarBrief` exige `motivo` para `→ internal_changes_requested`/`→ client_changes_requested`; `packages/db/src/client-review.ts` (`solicitarCambiosInternos`); `FormularioSolicitarCambiosInternos.tsx` | `client-review.test.ts` (parte de las 14) | Demo C: devuelto con motivo, motivo visible en el editor, ver §4 punto 6 | **PASS** |
| 4 | Aprobación interna (guardas del dominio, sin reimplementar) | `packages/db/src/client-review.ts` (`aprobarInternamente`); reusa `transicionarBrief`, nunca guardas nuevas en la UI/acción | `client-review.test.ts` | Demo C: aprobado internamente, `client_review` alcanzado, ver §4 punto 8 | **PASS** |
| 5 | Revisión del cliente: ver, navegar, ver evidencia | `apps/web/src/app/campanas/[id]/brief/VistaCliente.tsx` — componente separado de `TablaCampos`/`CampoEditable`, nunca recibe `confidence`/`provenanceType`/costo/modelo/clave técnica | — (UI) | Demo C: vista real como `marena@tcl.com`, ver §4 punto 9 | **PASS** |
| 6 | Solicitud de cambios del cliente, con campos señalados | `packages/db/src/client-review.ts` (`solicitarCambiosCliente`); valida que cada campo señalado exista en el catálogo | `client-review.test.ts` | Demo C: cliente señala `objetivo.negocio` con motivo, ver §4 punto 10 | **PASS** |
| 7 | Reingreso al ciclo interno tras cambios del cliente | Transición `client_changes_requested → internal_review` ya declarada en el dominio desde Sprint 4; el botón genérico "Enviar a revisión interna" la ejecuta sin código nuevo | `client-review.test.ts` | Demo C: corregido y reenviado, ver §4 punto 11 | **PASS** |
| 8 | Aprobación final del cliente; `approved_at` persistido | `packages/db/src/client-review.ts` (`aprobarComoCliente`) | `client-review.test.ts` | Demo C: `approved_at` verificado en base tras aprobar como cliente, ver §4 punto 12 | **PASS** |
| 9 | Inmutabilidad de una versión aprobada | Ya cubierta por ADR-003 (trigger de migración 004); verificada de nuevo con datos reales de este incremento | `versioning.test.ts`; `client-review.test.ts` | Demo C: intento de editar `contexto.situacion` tras aprobar rechazado por el servidor, ver §4 punto 13 | **PASS** |
| 10 | Creación de versión hija al editar una `approved` | `packages/db/src/versioning.ts` (`crearVersionHija`) — candado atómico `UPDATE ... WHERE status='approved'` (DEC-033) | `versioning.test.ts` (11) | Demo D: versión 2 creada, `parent_version_id` verificado en base, ver §4 punto 14 | **PASS** |
| 11 | Versión anterior `superseded`, intacta | Mismo `crearVersionHija`, misma transacción | `versioning.test.ts` | Demo D: versión 1 `superseded`, `contexto.situacion` sin cambios verificado en base, ver §4 punto 15 | **PASS** |
| 12 | Auditoría completa de todas las acciones | `recordAudit` en cada mutación (transición, comentario, versión hija) — ninguna ruta nueva se salta este paso | Cubierta en cada suite (`client-review.test.ts`, `versioning.test.ts`, `comments.test.ts`) | `audit_events` consultado directamente en §4 punto 14 | **PASS** |
| 13 | Seguridad: aislamiento entre organizaciones para las rutas nuevas | `transicionarBrief`, `listCampaigns`, `versionesDelBrief`, `verCamposDeVersion` corregidos para usar `canAccessResource` (visibilidad), no `organization_id` crudo, para el rol `cliente` (defecto 4, §5) | `isolation.test.ts` (17, sin cambios de comportamiento); `client-review.test.ts` (aislamiento del cliente antes de la aprobación interna) | — | **PASS** |
| 14 | Cliente sin acceso a comentarios internos, costos ni información técnica | `permissions.ts`: `cliente` nunca recibe `comment:*`; `VistaCliente.tsx` nunca recibe esos campos en sus props | `comments.test.ts` (2 casos); `permissions.test.ts` (3 casos nuevos) | — | **PASS** |

---

## 3. Migraciones

| Migración | Qué hace |
|---|---|
| `007_comentarios_internos.sql` | Tabla `field_comments` (E7-6): ancla a `(brief_version_id, field_key)`, no a `brief_fields.id`, para sobrevivir a una versión hija. Trigger de inmutabilidad igual al de `brief_fields` (ADR-003). |
| `008_claim_exige_evidencia_excepcion_manual.sql` | Corrige `claim_exige_evidencia()` (migración 004): le faltaba la excepción de DEC-028 (un campo `critico` no técnico resuelto por pregunta local, `provenance_type='manual_local'`, no exige evidencia documental). Defecto real, ver §5 punto 2. |
| `009_inmutabilidad_historica.sql` | Corrección de auditoría (§10). Cierra el hueco de inmutabilidad tras `superseded`/`cancelled`: `brief_fields`, `evidence` (nunca protegida), `local_questions` (nunca protegida), `brief_field_revisions` (solo `UPDATE` protegido) y `field_comments` ahora bloquean `INSERT`/`UPDATE`/`DELETE` directos en los tres estados cerrados, no solo `approved`. Incluye una bandera de bypass (`SET LOCAL tclkolos.permitir_borrado_historico`) acotada a una transacción, exclusiva de la limpieza de datos de prueba — nunca usada por la aplicación real. |
| `010_inmutabilidad_bypass_restringido.sql` | Segunda corrección de auditoría (§11). Restringe técnicamente el bypass de la 009 a bases cuyo nombre termine en `_test` (hallazgo 1); añade `BEFORE DELETE` sobre `brief_versions` en estados terminales, cubriendo también la cascada desde `briefs`/`campaigns` (hallazgo 2); y redefine `version_aprobada_inmutable()` para congelar la fila completa — ninguna columna aparte de `status` puede cambiar, ni siquiera con la versión `approved` (hallazgo 3). |

Ninguna migración modifica el pipeline de extracción ni el esquema del catálogo.

---

## 4. Demo C — ciclo de aprobación (ejecutada, real, en el navegador)

Campaña desechable «Sprint 5 · Demo C — ciclo de aprobación» (producto TCL C7L único), creada vía `/campanas/nueva`, contra la aplicación real (`npm run dev`, Postgres/Redis/worker reales en Docker, worker con `AI_PROVIDER=fake` — nunca usado para generar contenido del brief, solo para que el pipeline documental esté disponible; **el brief de esta demo se construyó 100% a mano**, sin ninguna llamada real a un proveedor de IA).

1. **Brief creado a mano** — `crearBriefManual`, 41 claves sembradas.
2. **Campo editado con autoguardado** — `contexto.situacion` corregido desde `CampoEditable.tsx`.
3. **Comentario interno añadido y resuelto** — «¿Esto viene confirmado por el cliente o es supuesto nuestro?» creado sobre `contexto.situacion`, resuelto por el mismo actor; verificado en pantalla: autor, fecha, estado `resuelto`, botón «Reabrir» disponible.
4. **Preguntas locales generadas y respondidas** — 14 preguntas (9 críticas, 5 claims); las 9 críticas respondidas con los controles reales de `TablaPreguntas.tsx` (texto, enum, lista, fecha con precisión — `practico.fecha_inicio` con `ControlDeFecha`, tipo `exacta`); las 5 claims descartadas con justificación (sin material fuente real, mismo criterio que Demo B de Sprint 4).
5. **Enviado a revisión interna** — `extraction_review`/`draft → internal_review` real, 0 críticos pendientes.
6. **Cambios internos solicitados con motivo** — «El objetivo de negocio queda genérico; pedir una meta numérica concreta.»; verificado: estado `internal_changes_requested`, motivo visible en el banner del editor.
7. **Corregido y reenviado** — mismo botón «Enviar a revisión interna» (genérico, sin código nuevo) lleva `internal_changes_requested → internal_review`.
8. **Aprobado internamente** — `internal_review → client_review`; verificado en base: `campaigns.visibility` subió de `interna` a `tcl` en la misma transacción (DEC-032).
9. **Revisión del cliente** — sesión iniciada como `marena@tcl.com` (`cliente`, TCL Colombia); la campaña ya aparece en su listado (antes de este incremento, nunca habría aparecido — ver defecto 4, §5); `VistaCliente.tsx` muestra los 11 campos `found` por sección, con evidencia cuando existe, sin ningún dato técnico.
10. **Cliente solicita cambios sobre un campo** — `objetivo.negocio` señalado con motivo «El objetivo de negocio quedó con texto duplicado/mal editado.» (un error real de tipeo del operador durante la demo, capturado honestamente en vez de limpiado en silencio — ver §5 punto 5); verificado: estado `client_changes_requested`, motivo y campo señalado visibles para el equipo interno.
11. **Corregido y reenviado al ciclo interno** — `objetivo.negocio` corregido; mismo botón «Enviar a revisión interna» lleva `client_changes_requested → internal_review`; aprobado internamente de nuevo, vuelve a `client_review`.
12. **Aprobación final del cliente** — botón «Aprobar» como `marena@tcl.com`; verificado en base: `status='approved'`, `approved_at` no nulo.
13. **Inmutabilidad verificada** — como `admin`, intento de editar `contexto.situacion` desde el editor: rechazado con «La versión 1 está en estado approved y no admite edición. Cree una versión nueva.»; valor en base confirmado sin cambios.

**Estado: PASS**, con evidencia de pantalla y de base de datos en cada paso.

## Demo D — nueva versión (ejecutada, real, a continuación de Demo C)

14. **Nueva revisión creada** — botón «Crear nueva revisión» sobre la versión `approved`; verificado en base: versión 2, `status='draft'`, `parent_version_id` apuntando exactamente al `id` de la versión 1; versión 1 pasó a `status='superseded'`, `approved_at` sin cambios. Auditoría verificada: `brief.create_child_version` (entidad = versión 2, metadata con `parentVersionId`) y `brief.superseded` (entidad = versión 1).
15. **Modificación en la hija, versión anterior intacta** — `contexto.situacion` corregido en la versión 2; verificado en base que la versión 1 conserva el valor exacto anterior.
16. **Ambas consultables desde el historial** — tabla «Versiones anteriores» en `/campanas/{id}/brief` muestra la versión 1 con estado «reemplazado».

**Estado: PASS.**

**Evidencia:** cada paso de las dos demos quedó capturado como texto completo de pantalla (`get_page_text`) y verificado por consulta directa a la base de datos, ambos transcritos en la sesión de trabajo — es la evidencia primaria, más fuerte que una imagen porque prueba el estado real, no solo el renderizado. Además se capturaron y mostraron en pantalla, dentro de esa misma sesión, capturas de los estados finales clave (brief `aprobado` con el botón «Crear nueva revisión», y la vista del cliente sobre esa misma versión) — no se exportaron como archivos de imagen al repositorio porque la herramienta de navegador de esta sesión no ofrece una ruta de exportación a disco; quedan como parte del historial de esa conversación, ubicación identificable para quien tenga acceso a ella. Si se necesitan como archivos independientes, se pueden volver a capturar y exportar en una sesión futura.

---

## 5. Defectos reales encontrados durante Demo C/D (no en la suite automatizada) y corregidos

Ninguno de estos seis puntos lo encontró una prueba en memoria — los seis solo aparecieron al ejercitar los caminos nuevos con la aplicación real, exactamente el patrón que ya dejó documentado Sprint 4 (D0-17 §8, punto 12).

1. **Migración 007 no se había aplicado a la base de desarrollo**, solo a la de pruebas — error real `relation "field_comments" does not exist` al abrir el editor por primera vez tras el despliegue local. Corregido ejecutando `migrate` contra ambas bases; documentado como recordatorio operativo, no como defecto de código.
2. **El trigger `claim_exige_evidencia()` (migración 004) no tenía la excepción de DEC-028** — bloqueaba `client_review → approved` para cualquier crítico resuelto por pregunta local. Corregido en migración 008; ver DEC-034.
3. **La validación de `PrecisedDate` aplicada de forma universal en `corregirCampo` bloqueaba campos `lista`/`enum`/`numero`** que solo tienen un `<input>` de texto plano en el editor (sin control propio, a diferencia de `TablaPreguntas.tsx`) — error real `«Hitos» espera una lista de textos.` sin ninguna forma de satisfacerlo desde esa pantalla. Corregido acotando la validación a `valueType:'fecha'` exclusivamente (`validarSiEsFecha`), que es el alcance real que pidió la Fase A — los demás tipos siguen sin validación estructural en el editor manual, igual que antes de este incremento (deuda preexistente, no nueva).
4. **`listCampaigns` filtraba por `organization_id` del actor incluso para el rol `cliente`** — como el cliente es de otra organización por definición (DEC-012), la campaña nunca aparecía en su listado aunque su visibilidad ya fuera `tcl`. El mismo patrón ya se había corregido en `transicionarBrief`/`versionesDelBrief`/`verCamposDeVersion` durante la implementación, pero `listCampaigns` se pasó por alto hasta que la demo lo reveló. Corregido; prueba de regresión añadida en `client-review.test.ts`.
5. **Error de tipeo del operador durante la demo** (no defecto de código): al corregir `objetivo.negocio` con automatización de navegador, una selección de texto incompleta dejó el valor anterior y el nuevo concatenados. Se documenta con honestidad en vez de limpiarse en silencio (§4 punto 10) porque terminó demostrando, sin buscarlo, el flujo real de "cliente señala un campo con problema".
6. **Las acciones `aprobarComoClienteDeCampana`/`solicitarCambiosClienteDeCampana` redirigían a `/cliente/campanas/{id}`**, una ruta que nunca se construyó — quedó de un diseño inicial (árbol de rutas separado para el cliente) abandonado a favor de una rama dentro de la misma `/campanas/{id}/brief` (más simple, reutiliza navegación y permisos existentes, Fase F: "reutilizar rutas existentes"). La mutación en base sí ocurría — el 404 era solo de redirección — pero igual es un defecto real de UX, encontrado al aprobar como cliente en la demo. Corregido: ambas acciones redirigen a `/campanas/{id}/brief`. Se corrigió además un mensaje engañoso en `VistaCliente.tsx` («todavía no fue enviado a revisión») que se mostraba también en estado `client_changes_requested`, donde en realidad sí se había enviado y el cliente ya había decidido.

Todos los seis quedan con prueba de regresión donde aplica (defectos 2, 3, 4) o con corrección verificada manualmente y re-confirmada por la suite completa (defectos 1, 5, 6, ninguno de los cuales tiene una forma natural de expresarse como prueba unitaria — son de infraestructura local, de datos de demo, y de UI respectivamente).

---

## 6. Pruebas — conteo exacto

| Área | Archivo(s) nuevos o con casos nuevos | Pruebas | Resultado |
|---|---|---|---|
| Validación estructurada (`PrecisedDate`, DEC-026) | `packages/domain/src/field-values.test.ts` (nuevo) | 17 | **PASS** |
| Cobertura de transiciones, incluida la autorización del cliente | `packages/domain/src/brief-states.test.ts` (1 caso reescrito) | 45 | **PASS** |
| Permisos del rol `cliente` | `packages/domain/src/permissions.test.ts` (3 casos nuevos, 2 reescritos) | 18 | **PASS** |
| **Total `packages/domain`** | 3 archivos | **80** | **PASS** |
| Ciclo de aprobación (Fases C y D) | `packages/db/src/client-review.test.ts` (nuevo) | 14 | **PASS** |
| Versionado posterior a aprobación (Fase E) | `packages/db/src/versioning.ts` (nuevo) | 11 | **PASS** |
| Comentarios internos (Fase B) | `packages/db/src/comments.test.ts` (nuevo) | 11 | **PASS** |
| Fechas en el editor manual, regresión Demo A/B | `packages/db/src/brief-fields.test.ts` (2 casos nuevos) | 6 | **PASS** |
| **Inmutabilidad histórica tras `superseded`/`cancelled` (corrección de auditoría, §10)** | `packages/db/src/immutability.test.ts` (nuevo) — SQL directo contra `brief_fields`, `evidence`, `field_comments`, `local_questions`, `brief_field_revisions` y `brief_versions`, repetido en `approved` y en `superseded` | 34 | **PASS** |
| **Bypass restringido a `_test`, `DELETE` de `brief_versions` y congelamiento total de la fila (segunda corrección de auditoría, §11)** | `packages/db/src/immutability.test.ts` (20 casos añadidos a los 34 anteriores) | 20 | **PASS** |
| El resto de `packages/db` (sin cambios de comportamiento) | 12 archivos | 111 | **PASS** |
| **Total `packages/db`** | 17 archivos | **207** | **PASS** |
| `services/ai-worker` (sin tocar) | 9 archivos | 97 | **PASS** |
| **Total general** | — | **384** | **PASS** |

Catálogo TS/Python: coincide (41 claves). `ruff check .`: limpio. `mypy app`: limpio. `next build`: compila las 13 rutas, incluida `VistaCliente`/`PanelComentarios`. `npm run lint`: limpio (`--max-warnings=0`). `npm run format:check`: limpio.

---

## 7. Historias terminadas y parciales

| Historia | Estado |
|---|---|
| Fase A — fechas estructuradas en el editor manual (DEC-026) | **PASS**, acotada a `valueType:'fecha'` (ver defecto 3, §5) |
| Fase B — comentarios internos (E7-6) | **PASS** |
| Fase C — revisión y aprobación interna | **PASS** |
| Fase D — revisión y decisión del cliente | **PASS** |
| Fase E — versionado posterior a aprobación (DEC-027) | **PASS** |
| Fase F — interfaz (reutiliza diseño existente, sin rediseño) | **PASS** |
| Fase G — seguridad e integridad | **PASS** — ver requisito 13/14 de la matriz §2, más la inmutabilidad histórica de §10 |
| Fase H — pruebas obligatorias | **PASS** — 384 pruebas, ver §6 |
| Fase I — demos | **PASS** — Demo C y Demo D, ver §4 |
| Fase J — verificación final desde infraestructura limpia | **PASS** — receta de CI reproducida en contenedor limpio, ver §10.3 y §11.4. No se ejecutó dentro de GitHub Actions real — ver la precisión exacta en §8 |

---

## 8. Limitaciones y riesgos

- **Fase J se corrió completa contra un contenedor recién creado sin `.venv` preexistente, reproduciendo literalmente los comandos de `ci.yml`** (ver §10.3) — pero **no dentro de un runner real de GitHub Actions**: este repositorio no tiene un remoto de GitHub configurado en esta sesión, y crear uno y hacerle push exige autorización explícita que no se pidió en este incremento. La reproducción en contenedor limpio usa exactamente los mismos comandos, la misma versión de Python (3.11) y Node (22), y verifica en particular el defecto exacto reportado (`python -m uvicorn` sin `.venv`) — pero sigue siendo una simulación, no la ejecución real de Actions. Queda como comprobación operativa pendiente para cuando exista un remoto.
- **`practico.hitos` y el resto de campos `lista`/`enum`/`numero`/`lista_objetos` siguen sin control dedicado en el editor manual** (`CampoEditable.tsx`) — deuda preexistente desde antes de este incremento (D0-17 §2.4, E7-3 ya la marcaba `PARTIAL`), confirmada de nuevo al acotar la validación de Fase A (defecto 3, §5). No se resuelve aquí: el pedido de Sprint 5 solo pidió fechas.
- **La demo se ejecutó con un solo cliente (`marena@tcl.com`, TCL Colombia)** — `canAccessResource` para el rol `cliente` decide por `visibility`, no por `organization_id` (correcto para DEC-012, donde el cliente es de otra organización por definición); con más de una organización cliente en el futuro, dos organizaciones cliente distintas verían la misma campaña compartida como `tcl`. No es un defecto de este incremento — es el mismo modelo de una sola organización cliente que ya asumía DEC-011, documentado aquí para que no se redescubra por accidente.

---

## 9. Entrega

- **Commit base:** `106f622cf6e168e99e24d82cb9bff04ce604cc55`.
- **Commit de la entrega inicial de Sprint 5:** `03688f18b70e65968420c547d7ef4e79816516de`.
- **Commit del primer correctivo:** `a9eefe400790ed229f9009caeb76e5fbbf407960` (CI en runner limpio + migración 009).
- **Commit del segundo correctivo (esta versión):** ver el hash reportado en el resumen de entrega de esta corrección — un commit nuevo sobre `a9eefe4`, nunca un `--amend`; ver §11.
- **Migraciones nuevas:** `007_comentarios_internos.sql`, `008_claim_exige_evidencia_excepcion_manual.sql`, `009_inmutabilidad_historica.sql`, `010_inmutabilidad_bypass_restringido.sql`.
- **Conteo exacto de pruebas:** 384 (80 dominio + 207 `packages/db`, incluidas las 34 de la primera corrección de inmutabilidad y las 20 de la segunda + 97 worker).
- **Demo C:** PASS, ver §4.
- **Demo D:** PASS, ver §4.
- **`git status` al cerrar:** limpio, salvo `TCL-sprint4-cierre.zip`, `TCL-sprint5-cierre.zip`, `docs/product/pantallas-y-animaciones.md` y `HANDOFF-nuevo-chat.md` (preservados sin tocar, por instrucción explícita).

---

## 10. Corrección de auditoría (16 de septiembre de 2026)

Una auditoría independiente del ZIP de la entrega inicial (`03688f1`) encontró dos defectos de cierre reales, ninguno de alcance nuevo — ambos corregidos aquí, sin tocar ninguna migración ya aplicada ni ampliar lo que pidió Sprint 5.

### 10.1 — CI nunca podía correr en un runner limpio

`.github/workflows/ci.yml` levantaba el worker con `.venv/bin/python -m uvicorn app.main:app ...`, pero ningún paso anterior del workflow crea un entorno virtual — `pip install -r requirements.txt` instala en el intérprete que `actions/setup-python` ya deja configurado. En cualquier checkout limpio (que es, por definición, todo runner de GitHub Actions), `.venv` nunca existe: ese paso habría fallado con "no such file or directory" en cada corrida real. Ninguna verificación anterior de este proyecto (ni la de Sprint 4, ni la primera de Sprint 5) lo detectó porque todas se apoyaron en la imagen Docker del worker (`services/ai-worker/Dockerfile`), que instala e invoca `uvicorn` directo, sin pasar nunca por `.venv` — un camino de código distinto al que `ci.yml` realmente ejecuta.

**Corrección:** `python -m uvicorn app.main:app ...` (el intérprete que ya está configurado, sin ruta fija a un entorno que no existe) y `python -m pip install -r requirements.txt` en los tres pasos de instalación del workflow, para eliminar la ambigüedad entre `pip` y `python -m pip`.

**Verificación:** ver §10.3 — reproducido en un contenedor recién creado, con Python 3.11 y sin ningún `.venv` preexistente; el arranque del worker con el comando corregido funciona; se confirmó además, de forma explícita, que `.venv/bin/python` no existe en ese contenedor (el fallo exacto que habría dado el workflow original).

### 10.2 — La inmutabilidad histórica desaparecía después de `superseded`

`campos_de_version_aprobada_inmutables()` (migración 004) y `comentarios_de_version_aprobada_inmutables()` (migración 007) solo bloqueaban `UPDATE`/`DELETE` mientras la versión dueña estaba `approved`. Al crear una versión hija (`crearVersionHija`, Fase E de este mismo incremento), la versión padre pasa a `superseded` — y en ese momento la protección desaparecía por completo: nada en la base impedía un `UPDATE`, `DELETE` o `INSERT` directo sobre el contenido de una versión ya reemplazada. `evidence`, `local_questions` y `brief_field_revisions` nunca habían tenido ninguna protección propia, ni siquiera para `approved`.

**Corrección:** migración `009_inmutabilidad_historica.sql` (`CREATE OR REPLACE FUNCTION` sobre las funciones existentes, nunca modifica una migración ya aplicada). Extiende la protección a `approved`, `superseded` y `cancelled` por igual, en `brief_fields`, `evidence` (trigger nuevo), `local_questions` (trigger nuevo), `brief_field_revisions` (protección de `INSERT`/`DELETE`, además del `UPDATE` que ya bloqueaba sin condición) y `field_comments`. `brief_versions` gana además la regla explícita: un estado terminal (`superseded`/`cancelled`) nunca vuelve a ningún otro estado por SQL directo — `approved → superseded` sigue siendo la única transición que un estado ya cerrado admite, y solo para crear la versión hija.

Un primer diseño asumía que la limpieza de campañas de prueba (`DELETE FROM campaigns`, usada en el `afterAll` de toda la suite) seguiría funcionando sola porque la cascada borraría primero `brief_versions` y, con la fila padre ya inexistente, el disparador no encontraría nada que proteger. **Es falso en general**, verificado contra Postgres real: `local_questions` tiene FK directa a `campaigns` (además de a `brief_version_id`), así que su cascada puede dispararse mientras `brief_versions` todavía existe. La solución: una bandera de bypass (`SET LOCAL tclkolos.permitir_borrado_historico = 'on'`), acotada a una única transacción, que solo usa `packages/db/src/test-utils.ts` (`eliminarCampanaDePrueba`) — nunca ninguna ruta de la aplicación real. Verificado en los dos sentidos: sin la bandera, la limpieza se bloquea igual que cualquier otro intento directo; con ella, procede, y al cerrar la transacción la bandera se revierte sola.

**Pruebas:** `packages/db/src/immutability.test.ts` (34 casos nuevos) — SQL directo contra `brief_fields`, `evidence`, `field_comments`, `local_questions` y `brief_field_revisions`, cada bloque de aserciones repetido dos veces sobre la misma fila: una vez con la versión `approved`, otra después de convertirla en `superseded`. Incluye además: que `cancelled` tampoco admite volver a otro estado; que la bandera de bypass no se escapa de su transacción; y que `crearVersionHija` (el flujo legítimo) sigue funcionando sin que el nuevo trigger lo bloquee — confirmado también por los 11 casos, ya existentes, de `versioning.test.ts`, que se repitieron después de aplicar la migración 009 y siguen en verde.

### 10.3 — Verificación final: contenedor limpio, sin `.venv` preexistente

Reproducida la receta literal de `ci.yml` (job `web` y job `worker`) dentro de un contenedor Docker construido para esta verificación — `node:22-bookworm` con Python 3.11 instalado aparte (sin el marcador `EXTERNALLY-MANAGED` de Debian, que no existe en el Python que `actions/setup-python` instala realmente; quitarlo hace que el contenedor se comporte como el runner real en ese único aspecto, sin cambiar ningún comando del workflow), Postgres (`pgvector/pgvector:pg16`) y Redis (`redis:7-alpine`) recién creados en red propia, y una copia limpia del árbol de trabajo (sin `node_modules`, sin `.venv`, sin `.next`, sin `.git`).

| Paso | Resultado |
|---|---|
| `npm ci` | **PASS** |
| `npm run lint` | **PASS** |
| `npm run typecheck` | **PASS** (3 workspaces) |
| Extensiones de Postgres + `migrate` (9 migraciones, incluida la 009) + `seed` | **PASS** |
| Instalar dependencias del worker (`python -m pip install -r requirements.txt`) | **PASS** — sin `.venv`, confirmado que no existe |
| Levantar worker + consumidor (`python -m uvicorn app.main:app ...`, `AI_PROVIDER=fake`) | **PASS** — `/ready` responde; **este es el paso que fallaba antes de la corrección** |
| `npm test` (dominio + `packages/db`) | **PASS** — 80 + 187 = 267 |
| `npm run build` | **PASS** |
| `npm run format:check` | **PASS** |
| Catálogo TS/Python | **PASS** — coincide |
| `ruff check .` / `mypy app` / `pytest` (job `worker`) | **PASS** — 97/97 |

**PASS — receta de CI reproducida en contenedor limpio.** No se afirma que GitHub Actions se haya ejecutado realmente — ver la precisión en §8.

---

## 11. Segunda corrección de auditoría (16 de septiembre de 2026, tarde) — tres huecos residuales de la migración 009

Una segunda auditoría independiente, ya sobre el commit `a9eefe4` (el del primer correctivo), encontró tres huecos residuales en la migración 009 — ninguno de alcance nuevo, los tres corregidos en `010_inmutabilidad_bypass_restringido.sql` sin tocar ninguna migración ya aplicada.

### 11.1 — El bypass no estaba restringido técnicamente a pruebas (hallazgo 1)

`inmutabilidad_bypass_activo()` (migración 009) solo comprobaba la bandera de sesión `tclkolos.permitir_borrado_historico`. Que hoy solo `packages/db/src/test-utils.ts` la active era una convención de la aplicación, no una restricción de la base: cualquier conexión con permiso para ejecutar SQL —desarrollo, staging o, en el peor caso, producción— podía hacer `SET LOCAL tclkolos.permitir_borrado_historico = 'on'` y desactivar los triggers de inmutabilidad para esa transacción.

**Corrección:** `inmutabilidad_bypass_activo()` ahora exige, además de la bandera, que el nombre de la base actual termine exactamente en `_test` — la misma convención que INC-001A ya exige en `packages/db/vitest.setup.ts` para `TEST_DATABASE_URL`. En cualquier base cuyo nombre no termine en `_test` (desarrollo, staging, producción, o cualquier otro nombre), la función devuelve `false` sin importar el valor de la bandera — no hay forma de activar el bypass ahí, ni siquiera manualmente.

### 11.2 — `brief_versions` seguía admitiendo `DELETE` directo (hallazgo 2)

La protección de `brief_versions` (migración 004, ampliada en la 009) solo estaba conectada a `BEFORE UPDATE`. Nada impedía un `DELETE FROM brief_versions WHERE id = ...` directo sobre una fila `approved`, `superseded` o `cancelled` —que además arrastraría en cascada todo su contenido histórico—, ni tampoco borrar una campaña o un brief completos si eso terminaba arrastrando versiones históricas por la cascada de Postgres.

**Corrección:** nuevo disparador `BEFORE DELETE` (`version_terminal_no_admite_delete`) sobre `brief_versions`, que rechaza cualquier `DELETE` mientras el estado sea `approved`, `superseded` o `cancelled` — salvo con el bypass activo (y ahora acotado a `_test`, §11.1). Como un disparador de fila se dispara igual para las filas que Postgres borra por cascada, esta única protección cubre tanto el `DELETE` directo como el borrado en cascada de una campaña o un brief.

### 11.3 — La fila histórica no estaba congelada del todo (hallazgo 3)

`version_aprobada_inmutable()` solo comparaba `version`, `brief_id`, `language`, `parent_version_id` y `approved_at`. Columnas como `organization_id`, `created_by`, `translation_of_id` o `created_at` podían modificarse por `UPDATE` directo sin que ningún disparador se diera cuenta.

**Corrección:** la función redefinida distingue tres casos. `superseded`/`cancelled`: cualquier `UPDATE` se rechaza sin excepción, incluso uno que no cambie ningún valor — son estados terminales, su fila ya no admite ninguna escritura. `approved`, sin cambio de estado: también se rechaza cualquier `UPDATE` — una versión aprobada no se reescribe a sí misma. `approved → superseded` (la única transición que usa `crearVersionHija`) o `approved → cancelled` (el único otro destino que un estado terminal admite a nivel de base, aunque el dominio actual —`packages/domain/src/brief-states.ts`, lista `CANCELLABLE`— no enruta esa transición específica hoy): se permite, pero únicamente si `status` es la única columna que cambia; toda la demás identidad de la fila debe permanecer exactamente igual.

Al escribir la verificación, esta corrección expuso dos usos de `eliminarCampanaDePrueba` que hacían un `DELETE FROM brief_versions` aparte, fuera de la transacción con bypass (`packages/db/src/brief-rules.test.ts` y `packages/db/src/end-to-end.test.ts`, ambos con un comentario que databa de antes de que la 009 resolviera el orden de la cascada) — redundante desde que `eliminarCampanaDePrueba` ya borra `briefs` primero, arrastrando `brief_versions` en cascada dentro de la misma transacción con bypass. Se quitaron esas dos líneas; ambas suites verificadas en verde con el disparador nuevo activo.

### 11.4 — Verificación final: contenedor limpio, sin `.venv` preexistente

Misma receta que §10.3, repetida completa desde cero: `node:22-bookworm` con Python 3.11 del sistema (símbolo `python` enlazado a `python3`, dependencias del worker instaladas con `--break-system-packages` porque el Python de Debian bookworm bloquea `pip install` fuera de un entorno virtual por PEP 668 — el Python que `actions/setup-python` instala en un runner real no tiene ese bloqueo; se documenta la diferencia con honestidad, no se oculta), Postgres (`pgvector/pgvector:pg16`) y Redis (`redis:7-alpine`) recién creados en red Docker propia, y una copia limpia del árbol de trabajo (sin `node_modules`, sin `.venv`, sin `.next`).

| Paso | Resultado |
|---|---|
| `npm ci` | **PASS** |
| `npm run lint` | **PASS** |
| `npm run typecheck` | **PASS** (3 workspaces) |
| Extensiones de Postgres + `migrate` (10 migraciones, incluida la 010) + `seed` | **PASS** |
| Instalar dependencias del worker (`python -m pip install -r requirements.txt`) | **PASS** — sin `.venv`, confirmado que no existe |
| Levantar worker + consumidor (`python -m uvicorn app.main:app ...`, `AI_PROVIDER=fake`) | **PASS** — `/ready` responde |
| `npm test` (dominio + `packages/db`) | **PASS** — 80 + 207 = 287 |
| `npm run build` | **PASS** |
| `npm run format:check` | **PASS** (tras `prettier --write` sobre `immutability.test.ts`, reformateado y reverificado) |
| Catálogo TS/Python | **PASS** — 41 claves, coincide |
| `ruff check .` / `mypy app` / `pytest` (job `worker`) | **PASS** — 97/97 |

**PASS — receta de CI reproducida en contenedor limpio.** No se afirma que GitHub Actions se haya ejecutado realmente — ver la precisión en §8.
