# D0-18 — Cierre de Sprint 5: ciclo completo del brief, de `internal_review` a `approved`

**Fecha:** 15–16 de septiembre de 2026. **Commit base:** `106f622cf6e168e99e24d82cb9bff04ce604cc55` (estado aprobado del cierre de Sprint 4, ver [D0-17](D0-17-cierre-sprint4.md)). **Commit final:** ver entrega §9.

Formato de estado, sin excepción: **PASS** (implementado, probado, con evidencia real, sin condiciones pendientes) · **PARTIAL** (implementado con un corte de alcance explícito y documentado) · **FAIL** (no cumple, o diferido sin implementar) · **BLOCKED** (depende de algo fuera de mi control). No se usa `PASS` sin prueba y evidencia.

**Estado general: CERRADO.** Los tres flujos pedidos — aprobación interna con motivo, revisión y decisión del cliente, y versionado posterior a aprobación — corren de punta a punta en la aplicación real, verificados dos veces: con la suite automatizada (330 pruebas) y con dos demostraciones manuales completas en el navegador (Demo C y Demo D), durante las cuales se encontraron y corrigieron seis defectos reales que ninguna prueba anterior había ejercitado, porque ninguna transición había llegado nunca a `approved`.

---

## 1. Resumen ejecutivo

El cierre de Sprint 4 dejaba el brief funcional hasta `internal_review`; el ciclo de aprobación (DEC-027) estaba documentado pero nunca implementado, y por eso nunca ejercitado. Este incremento:

- Conecta las transiciones `internal_review → internal_changes_requested → internal_review → client_review → client_changes_requested → internal_review → client_review → approved`, todas ya declaradas en el dominio desde Sprint 3/4 (`packages/domain/src/brief-states.ts`) pero sin ningún código que las invocara con datos reales.
- Añade fechas con precisión real (`PrecisedDate`, DEC-026) al editor manual — antes solo la extracción y las preguntas locales lo respetaban.
- Añade comentarios internos por campo (E7-6), diferidos desde Sprint 4.
- Añade la vista de solo lectura y decisión del cliente (ampliación de ADR-004), con permisos nuevos y acotados.
- Añade la creación de versión hija tras una aprobación (DEC-027), con candado de concurrencia.
- **Al ejercitar por primera vez estos caminos con datos reales** (no solo con datos en memoria de una prueba de dominio), aparecieron seis defectos reales, cada uno documentado en el decision-log (DEC-032 a DEC-034 y esta sección) y corregido antes de cerrar — el mismo patrón que Demo A de Sprint 4 ya había dejado como lección: *un camino nunca ejercitado no está probado, esté o no cubierto por una prueba en memoria*.

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
| El resto de `packages/db` (sin cambios de comportamiento) | 12 archivos | 111 | **PASS** |
| **Total `packages/db`** | 16 archivos | **153** | **PASS** |
| `services/ai-worker` (sin tocar) | 9 archivos | 97 | **PASS** |
| **Total general** | — | **330** | **PASS** |

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
| Fase G — seguridad e integridad | **PASS** — ver requisito 13/14 de la matriz §2 |
| Fase H — pruebas obligatorias | **PASS** — 330 pruebas, ver §6 |
| Fase I — demos | **PASS** — Demo C y Demo D, ver §4 |
| Fase J — verificación final desde infraestructura limpia | **PARTIAL** — ver §8 |

---

## 8. Limitaciones y riesgos

- **Fase J no se corrió contra infraestructura recién creada por `ci.yml` en GitHub Actions dentro de esta sesión** — se corrió la receta completa (Postgres, Redis, worker+consumidor con `AI_PROVIDER=fake`, migrar, sembrar, lint, typecheck, las 330 pruebas, `next build`, `format:check`, verificación de catálogo) contra contenedores Docker locales, en un puerto alternativo (`5544`) porque el puerto 5432 por defecto estaba ocupado por un contenedor de otro proyecto en esta máquina — nunca tocado, para no interferir con trabajo ajeno. El `.env` del repositorio quedó restaurado a sus valores originales (`5432`) al cerrar. Recomendado antes de considerar esto `PASS` sin condición: una corrida real en el runner de GitHub Actions.
- **`practico.hitos` y el resto de campos `lista`/`enum`/`numero`/`lista_objetos` siguen sin control dedicado en el editor manual** (`CampoEditable.tsx`) — deuda preexistente desde antes de este incremento (D0-17 §2.4, E7-3 ya la marcaba `PARTIAL`), confirmada de nuevo al acotar la validación de Fase A (defecto 3, §5). No se resuelve aquí: el pedido de Sprint 5 solo pidió fechas.
- **La demo se ejecutó con un solo cliente (`marena@tcl.com`, TCL Colombia)** — `canAccessResource` para el rol `cliente` decide por `visibility`, no por `organization_id` (correcto para DEC-012, donde el cliente es de otra organización por definición); con más de una organización cliente en el futuro, dos organizaciones cliente distintas verían la misma campaña compartida como `tcl`. No es un defecto de este incremento — es el mismo modelo de una sola organización cliente que ya asumía DEC-011, documentado aquí para que no se redescubra por accidente.

---

## 9. Entrega

- **Commit base:** `106f622cf6e168e99e24d82cb9bff04ce604cc55`.
- **Commit final:** ver mensaje de cierre de esta sesión.
- **Migraciones nuevas:** `007_comentarios_internos.sql`, `008_claim_exige_evidencia_excepcion_manual.sql`.
- **Conteo exacto de pruebas:** 330 (80 dominio + 153 `packages/db` + 97 worker).
- **Demo C:** PASS, ver §4.
- **Demo D:** PASS, ver §4.
- **`git status` al cerrar:** limpio, salvo `TCL-sprint4-cierre.zip` y `docs/product/pantallas-y-animaciones.md` (preservados sin tocar, por instrucción explícita).
