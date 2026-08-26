# INC-001 · Colisión de datos de prueba con una versión real de P80

**Fecha:** 25-26 de agosto de 2026. **Severidad:** alta (pérdida de datos derivados, no de fuente). **Estado:** cerrado — Gate A en `PASS` (contención), Gate B en `PASS` (regeneración real completada y verificada, ver §7).

## 1. Qué pasó

Durante la implementación de la Fase D del cierre de Sprint 4 (conectar `transition()` del dominio a `packages/db`), se reescribió `packages/db/src/extraction.ts` para que la creación de una versión del brief pasara por `obtenerOCrearVersionDeTrabajo` (DEC-024): la función que, mientras el estado de una versión no sea terminal ni `approved`, reutiliza la misma fila en vez de crear una nueva.

Al reescribir `packages/db/src/extraction.test.ts` para probar ese flujo, el helper de prueba `nuevaVersion()` llamó a esa misma función pasándole el `campaignId` de la campaña **compartida** del seed — «Lanzamiento línea P80» — en vez de crear una campaña propia y desechable (el patrón que sí seguía `brief-rules.test.ts` desde antes).

P80 ya tenía una versión de brief real, no terminal, de una extracción genuina hecha con OpenRouter en una sesión anterior. `obtenerOCrearVersionDeTrabajo` la encontró y la reutilizó — comportamiento correcto para producción, equivocado para una prueba que no sabía que esa versión no le pertenecía. Los distintos `it()` de `extraction.test.ts` escribieron datos sintéticos sobre esa versión real, y el `afterAll` de limpieza —que borra por id los que la propia prueba "creó"— incluía el id de esa versión reutilizada. `DELETE FROM brief_versions WHERE id = ANY($1)` la eliminó.

## 2. Qué se perdió

- Los `brief_fields` y `evidence` de esa extracción real: 41 campos con su estado, y las citas verificadas que los respaldaban.
- El registro quedó fuera de `ai_runs.brief_version_id` (columna `ON DELETE SET NULL`), pero el contenido de la extracción en sí — el `value`, el `status`, las citas — no es recuperable de la base: se perdió con la fila.

**No es restaurable de forma idéntica.** Regenerarlo exige una llamada nueva al modelo (`google/gemini-2.5-flash-lite` u otro configurado), y una llamada nueva puede producir una salida distinta a la original — no es una copia de seguridad que se restaura, es una extracción nueva. Nunca describir esto como "completamente reproducible".

## 3. Qué quedó intacto

- **Los dos documentos fuente reales** (`Brief P80 del cliente.docx`, `Brief P80.md`) siguen en `.storage/`, sin tocar.
- **`source_documents` y `source_fragments`** de esos dos documentos en la base de desarrollo (`tclkolos`): 2 fuentes, 14 fragmentos, `status='procesado'` — confirmado por consulta directa antes y después de la contención.
- **El historial de costo en `ai_runs`**: 5 corridas reales de `extraer_campos` contra P80 (13 y 16 de agosto, `google/gemini-2.5-flash-lite`, entre $0.0018 y $0.0039 cada una), con `brief_version_id` ahora en `NULL`.
- Ninguna otra campaña, organización ni usuario del seed resultó afectado.

## 4. Causa raíz

Dos fallas se combinaron:

1. **La prueba reutilizó una función de producción diseñada para reutilizar estado, sobre una campaña que la prueba no controlaba.** `obtenerOCrearVersionDeTrabajo` (DEC-024) hace exactamente lo que debe hacer: si hay una versión de trabajo, la reutiliza. El error no está en esa función — está en haberla apuntado a una campaña compartida en vez de una propia y desechable.
2. **No existía ningún candado que impidiera que las pruebas de `packages/db` corrieran contra la misma base de datos que usa la aplicación de desarrollo.** `vitest.config.ts` traía un valor por defecto (`DATABASE_URL ?? 'postgresql://.../tclkolos'`) que apuntaba silenciosamente a la base real si no se declaraba nada distinto. Ese valor por defecto es lo que hizo posible que el error del punto 1 tuviera consecuencias reales en vez de fallar contra una base vacía y desechable.

## 5. Por qué las pruebas alcanzaron datos compartidos

`packages/db` nunca tuvo una base de pruebas separada de la de desarrollo. Algunos archivos (`brief-rules.test.ts`) ya seguían la disciplina de crear su propia campaña desechable por convención — una buena práctica, pero no forzada por ninguna herramienta. `extraction.test.ts`, al reescribirse, no la siguió, y nada en la configuración de pruebas lo habría impedido: correr sin `TEST_DATABASE_URL` no daba error, daba la base real.

## 6. Contención — Gate INC-001A (PASS)

Ejecutado y verificado el 25 de agosto de 2026:

1. **`extraction.test.ts` reescrito**: crea su propia campaña desechable (`campanaDePrueba`, con dos productos propios) en `beforeAll`; la campaña compartida `campaignId` se usa **exclusivamente para leer** fragmentos reales ya procesados (nunca para escribir ni para crear versiones). La limpieza borra solo `campanaDePrueba` (cascada) y las versiones que la propia corrida registró.
2. **`isolation.test.ts`**: se encontró y corrigió una fuga menor preexistente — una prueba de auditoría creaba una campaña (`Campaña de prueba de auditoría {timestamp}`) sin limpiarla después. No tocaba datos compartidos, pero acumulaba residuo entre corridas; ahora se borra por id al final de su propio `it()`.
3. **Base de pruebas separada**: nueva base `tclkolos_test` (mismo servidor Postgres, mismas extensiones, migraciones 001-005 aplicadas, seed propio). `TEST_DATABASE_URL` en `.env`/`.env.example`.
4. **Candado en `packages/db/vitest.setup.ts`** (nuevo, `setupFiles`): exige `TEST_DATABASE_URL`; el nombre de la base debe terminar en `_test`; si falta o no cumple, la suite lanza un error y **no arranca ninguna prueba**. `vitest.config.ts` ya no trae ningún valor de `DATABASE_URL` por defecto — sin ese archivo de setup, no hay base a la que conectarse.
5. **Sin fallback silencioso**: el candado vive únicamente en la configuración de pruebas de `packages/db`. `packages/db/src/client.ts` no cambió — la aplicación normal (`apps/web`, el worker) sigue leyendo `DATABASE_URL` exactamente igual que antes, sin saber que `TEST_DATABASE_URL` existe.
6. **Prueba de regresión dedicada**: `packages/db/src/inc-001-aislamiento.test.ts` (nuevo). Crea una versión "centinela" (organización, campaña, brief, versión, campo y evidencia propios, con estado `extraction_review`, simulando datos reales preexistentes), ejecuta sobre una campaña **distinta y propia** las mismas operaciones que participaron en el incidente (`obtenerOCrearVersionDeTrabajo`, `crearBriefManual`, `confirmarCampo`, `transicionarBrief`), y verifica al final — por un hash del contenido observable (claves, valores, citas) — que la centinela sigue exactamente igual. 4/4 pruebas en verde.
7. **Doble corrida verificada** (`npm run test --workspace @tcl-kol-os/db` contra `tclkolos_test`, dos veces consecutivas): **81/81 pruebas en verde ambas veces**, mismo resultado. Snapshot de P80 en `tclkolos_test` (solo conteos e ids técnicos, nunca contenido) antes y después de las dos corridas: `fuentes=2, fragmentos=14, versiones=0` — sin cambio. Total de campañas en `tclkolos_test` antes y después: 3 — sin residuo. Total de `brief_versions` en toda la base tras las dos corridas: 0.
8. **Base de desarrollo real (`tclkolos`) verificada sin cambios**: P80 sigue con exactamente 1 versión, `status='approved'`, 41 campos — la misma que existía antes de iniciar la contención.

## 7. Regeneración — Gate INC-001B (PASS)

**Primer intento, 26 de agosto de 2026 (temprano): bloqueado por una causa externa.** Con el anclaje de producto, el ciclo de estados, la persistencia de campos/evidencia y el aislamiento de pruebas ya terminados, se verificó primero el material de partida en `tclkolos` (base de desarrollo real, nunca `tclkolos_test`):

- **Fuentes intactas:** `Brief P80 del cliente.docx` y `Brief P80.md`, `status='procesado'`, 7 fragmentos cada una (14 en total) — igual que en la contención (§6.7).
- **Productos intactos:** P80 Ultra (flagship, 60%), P80 Pro (secundario, 20%), P80 (entrada, 10%).
- **Único brief_version existente:** versión 2, `status='approved'`, 41 campos — anterior a este incidente, sin relación con la versión perdida.

Se disparó una extracción real **a través de la aplicación** (botón «Extraer campos de las fuentes» en `/campanas/{id}/brief`, nunca SQL manual — corrección 8 del plan aprobado), con el worker HTTP real (`AI_ENABLED=true`, `AI_PROVIDER=openrouter`) levantado vía `docker compose up -d worker`. La llamada real a OpenRouter falló con `AIError: La clave de OpenRouter no es válida o expiró.` (`services/ai-worker/app/ai/openrouter.py:125`).

**Lo que sí quedó demostrado en ese primer intento, y es una prueba positiva independiente del bloqueo:** el ciclo de estados manejó la falla exactamente como está diseñado. Se creó la versión de trabajo 3 (la 2 es terminal/`approved`, así que `obtenerOCrearVersionDeTrabajo` correctamente no la reutilizó), transicionó a `processing`, y al fallar la llamada real transicionó a `processing_failed` — sin persistir campos a medias, con los dos eventos de auditoría (`brief.transition`) registrados, y con el botón «Reintentar extracción» visible en la UI para esa versión.

**Segundo intento, mismo día: la clave de OpenRouter renovada por el usuario en su `.env` local (`docker compose up -d worker` / `docker compose up -d consumidor` para forzar la recarga — `docker restart` no releía el `.env`, lección operativa registrada aparte). Se pulsó «Reintentar extracción» sobre la misma versión 3 — no hizo falta recrear nada.**

**Resultado: extracción real completada.** `google/gemini-2.5-flash-lite`, `output_status: ok_con_descartes`, latencia `19504 ms`, costo `USD 0.005886`. Transición real `processing → extraction_review`. Verificado en `tclkolos` al terminar:

- **Los tres productos, sin mezclar**: 21 campos `marca_producto[].*` (7 claves × 3 productos), cada uno con su `campaign_product_id` real — ninguno `NULL`, ninguno con valores cruzados entre P80 / P80 Pro / P80 Ultra.
- **69 evidencias, 69/69 citas verificadas literalmente** contra el texto real de su `source_fragment` (misma normalización que usa el worker para aceptarlas: espacios colapsados, minúsculas).
- **51 campos con dato, 5 sin encontrar, 0 en conflicto.**
- Los 44 campos `found` que llegaron `sin confirmar` se confirmaron o corrigieron uno por uno desde la UI real de `/campanas/{id}/brief`, hasta 0 pendientes de revisión.
- Una excepción por producto declarada y verificada (E7-8, campo `mandatorios`, producto P80).
- 2 preguntas locales generadas (`practico.fecha_inicio`, `practico.fecha_fin`); una respondida con el objeto `PrecisedDate` correcto, una descartada con justificación real.
- Transición final real a `internal_review`, con todas las guardas del dominio evaluadas de verdad (`guardCriticalFieldsResolved`, `guardProductFieldsAnchored`, `guardAllFieldsReviewed`, `guardClaimsHaveEvidence`, `guardNoPendingQuestions`) — ninguna relajada.
- Confirmado que correr la suite de `packages/db` después no modificó esta extracción: las pruebas corren contra `tclkolos_test`, nunca contra `tclkolos` (candado de INC-001A, §6.3-6.5), y una relectura de `brief_versions`/`brief_fields` de P80 tras la corrida completa de CI mostró el mismo estado.

**Un defecto de código real apareció durante este proceso** (no en la extracción en sí, sino al corregir manualmente un campo ya extraído con `confidence` no nulo) — documentado, corregido, y re-verificado con toda la matriz de CI en [D0-17 §4 y §6.1](../product/D0-17-cierre-sprint4.md).

**Gate INC-001B: `PASS`.** Detalle completo del recorrido y de cada punto verificado en [D0-17 §4](../product/D0-17-cierre-sprint4.md).

## 8. Riesgo residual

- **La base de desarrollo real (`tclkolos`) sigue sin un candado equivalente contra escritura accidental desde fuera de la aplicación** — el candado de este incidente protege las pruebas automatizadas de `packages/db`, no un `psql` manual ni un script suelto. Sigue siendo responsabilidad de quien opera la base.
- **Se observaron ocho campañas residuales** (`Campaña de prueba de auditoría {timestamp}`) ya acumuladas en `tclkolos` de sesiones anteriores a este incidente, previas a la corrección del punto 6.2 — quedan ahí, sin tocar, porque limpiarlas no es parte de este incidente y borrar datos de la base de desarrollo sin pedirlo explícitamente sería exactamente el tipo de acción que este mismo informe advierte evitar.
- **Ninguna otra suite de `packages/domain` o del worker tenía este riesgo** — no tocan Postgres (`packages/domain`) o no tocan `brief_versions` (worker, pruebas unitarias sin red).
- **El patrón de aislamiento (campaña propia, limpieza por id, nunca por nombre) depende de que cada archivo de prueba nuevo lo siga** — el candado de `TEST_DATABASE_URL` limita el daño a la base de pruebas, no impide que una prueba mal escrita vuelva a tocar la campaña compartida del seed *dentro* de `tclkolos_test`. Es una reducción del radio de impacto, no una garantía estructural completa.
