> **Documento histórico** (anterior a V2): no describe el modelo vigente; ver docs/project/V2_CURRENT_STATE.md y DEC-042 a DEC-050.

# Handoff — TCL KOL OS

Estado a **16 de septiembre de 2026**. Base de este cierre: `106f622` (Sprint
4 + Demo A + Gate INC-001B, todo en `PASS` — ver
[D0-17](docs/product/D0-17-cierre-sprint4.md)). **Sprint 5 cerrado**: el ciclo
completo del brief corre de punta a punta — comentarios internos, fechas
estructuradas, aprobación interna, revisión y decisión del cliente,
versionado posterior a aprobación — verificado con 384 pruebas automatizadas
y dos demos reales en el navegador (Demo C, Demo D). Entregado en tres
commits: `03688f1` (entrega inicial), `a9eefe4` (primer correctivo — CI en
runner limpio + inmutabilidad tras `superseded`, DEC-035/DEC-036) y un
segundo commit correctivo sobre `a9eefe4` que cierra tres huecos residuales
de esa misma migración de inmutabilidad, encontrados en una segunda
auditoría independiente — el bypass no estaba restringido técnicamente a
bases de pruebas, `brief_versions` admitía `DELETE` directo, y la fila
histórica no quedaba congelada por completo (DEC-037). Detalle completo y
matriz de estado en [D0-18](docs/product/D0-18-cierre-sprint5.md) §11.

Este archivo existe para que una sesión nueva pueda continuar sin releer el
historial. No repite lo que ya está en otros documentos: los enlaza.

---

## 1. Qué es esto

Plataforma interna de **SmartPR** para coordinar campañas de influencers/KOL de
**TCL Colombia**. El documento que manda es
[`TCL_KOL_OS_DOCUMENTO_MAESTRO_EJECUCION.md`](TCL_KOL_OS_DOCUMENTO_MAESTRO_EJECUCION.md)
(1380 líneas): visión, 8 MVPs, arquitectura y umbrales de calidad.

El product owner es **Gerardo Calambás**, y también es el único usuario del
piloto. Se trabaja **en español**: código, comentarios, commits, interfaz.

**Regla que define el producto:** el sistema nunca inventa. Un dato que no está
en las fuentes se declara `not_found` y se convierte en una pregunta; una
afirmación sin cita verificable no entra al brief. Todo lo demás es
consecuencia de eso.

---

## 2. Dónde vamos

| Fase | Estado |
|---|---|
| MVP 0 — descubrimiento (D0-01 … D0-15) | ✅ aprobado en su gate |
| Sprint 0 — repositorio, Docker, CI local | ✅ |
| Sprint 1 — identidad, campañas multiproducto, aislamiento | ✅ |
| Sprint 2 — fuentes documentales, cola, parsers | ✅ |
| Sprint 3 — índice vectorial, extracción con evidencia, UI-08/UI-11 | ✅ |
| **Sprint 4 — ciclo de estados real, anclaje de producto, Épica E6 (preguntas locales), E7 (editor, incl. E7-8)** | ✅ **cerrado — ver D0-17** |
| Demo A + Gate INC-001B (P80 real) | ✅ **ejecutada y verificada — ver D0-17 §4** |
| **Sprint 5 — ciclo completo del brief: `internal_review → approved`, comentarios internos (E7-6), fechas estructuradas (DEC-026), versionado posterior a aprobación (DEC-027)** | ✅ **cerrado — ver D0-18** |
| Demo C (ciclo de aprobación) + Demo D (versión nueva) | ✅ **ejecutadas y verificadas — ver D0-18 §4** |
| Exportación, traducción, Drive/OIDC/OCR, CRM de influencers | ⬅️ siguiente incremento |

**Pruebas al cierre: 80 dominio (vitest) · 187 integración
`packages/db` (vitest, contra Postgres real, sin ningún dato acumulado,
incluidas 34 pruebas SQL directas de inmutabilidad histórica) · 97
worker (pytest) · `ruff check .` y `mypy app` limpios sobre todo
`services/ai-worker` · verificación cruzada de catálogo TS/Python en verde ·
`npm run lint`, `npm run typecheck` y `npm run format:check` limpios ·
`next build` compila, incluidas las rutas nuevas de Sprint 5. **La receta
literal de `ci.yml` corregida (Postgres + Redis + worker/consumidor con
`AI_PROVIDER=fake`, todos efímeros, `python -m uvicorn` sin `.venv`) se
reprodujo completa dentro de un contenedor Docker recién creado, sin ningún
`.venv` preexistente: cero fallas** — no es una corrida real de GitHub
Actions (no hay remoto configurado en esta sesión), es la misma receta
reproducida fielmente en un contenedor limpio. Detalle completo en
[D0-18](docs/product/D0-18-cierre-sprint5.md), especialmente §10.

### Lo que cambia respecto al HANDOFF anterior

Sprint 5 implementó el ciclo de aprobación completo que DEC-027 dejaba
documentado sin código desde Sprint 4. Al ejercitarlo por primera vez con
datos reales —nunca antes ninguna transición había llegado a `approved`—
aparecieron seis defectos reales que ninguna prueba en memoria había
detectado, todos corregidos antes de cerrar (detalle completo en D0-18 §5):
un trigger de base sin una excepción que el dominio ya aplicaba (DEC-028),
una validación nueva demasiado amplia que bloqueaba campos sin control
propio en el editor, dos rutas de consulta que filtraban por la organización
del actor cuando el actor era el rol `cliente` (que es de otra organización
por definición), y una acción que redirigía a una ruta que nunca se
construyó. El detalle de qué se cerró en Sprint 4 (el estado sobre el que
se construyó Sprint 5) sigue siendo válido tal cual está más abajo:

- El ciclo de estados corre de verdad: `draft → processing → extraction_review
  → local_questions → extraction_review → internal_review`, con reintento
  desde `processing_failed`, guardas reales por rol y por contenido, y
  auditoría en cada transición. Nunca hay un `UPDATE brief_versions SET
  status=...` directo — todo pasa por `transicionarBrief` (dominio).
- El anclaje de producto (`campaign_product_id`) funciona de extremo a
  extremo: el worker recibe el catálogo real de productos de la campaña, el
  repositorio rechaza toda la extracción si un `productoId` no pertenece a
  ella, y P80 (3 productos, 60/20/10) nunca mezcla campos entre modelos.
- Existe un camino de brief **manual**, funcional incluso con
  `AI_ENABLED=false`: siembra las 41 claves del catálogo único y se completa
  campo por campo desde el editor.
- La Épica E6 (preguntas locales) tiene repositorio y UI reales:
  generación idempotente, respuesta con valor estructurado, descarte con
  justificación obligatoria, alcance por producto.
- Cada campo tiene control de concurrencia optimista (`revision`) y un
  historial propio (`brief_field_revisions`) — confirmar, corregir y
  resolver un conflicto quedan trazados sin usar `audit_events.metadata`
  como bitácora de contenido.
- **E7-8** (excepción por producto en un campo `compartido_con_excepcion`,
  DEC-016): declararla exige motivo, crea una fila nueva anclada a un
  producto sin tocar la compartida, y se puede revertir. Verificado con 9
  pruebas y en vivo en el navegador (dos productos, uno con excepción, otro
  sin ella, viendo cada uno lo que le corresponde).

---

## 3. Reglas de arquitectura que no se negocian

Están en [`docs/decisions/decision-log.md`](docs/decisions/decision-log.md),
que es **la única fuente de verdad** para decisiones. Nunca crear archivos ADR
paralelos. Las que más restringen el día a día:

| | Regla |
|---|---|
| **ADR-002** | La IA nunca aprueba. Toda extracción nace en `draft`. |
| **ADR-003** | Una versión aprobada es inmutable — en dominio **y** en trigger de base. |
| **ADR-007 / ADR-009** | Redis no guarda estado de negocio. La cola vive en PostgreSQL con `FOR UPDATE SKIP LOCKED`. |
| **ADR-008** | `packages/domain` no importa de `apps/` ni `services/`. El worker **no decide permisos**: recibe trabajo ya autorizado. |
| **§10.3 regla 7** | El filtro por organización y campaña va **dentro** de la consulta SQL, nunca después. |
| **§12.3** | Un documento `sensible` no entra al índice vectorial. |
| **§11.6** | Los logs y `ai_runs` no guardan prompts, texto ni PII. Solo hashes y metadatos. |
| **DEC-023 a DEC-029** | Cierre de este incremento: anclaje de producto por nivel, versión de trabajo reutilizada, mandatorios vs. restricciones, fechas con precisión, aprobaciones solo documentadas (no implementadas), evidencia vs. `manual_local`, `CampaignProduct` en el dominio. Detalle en el decision-log. |

**El corte worker ↔ dominio**, que es el que más fácil se rompe: el worker es el
único que habla con el proveedor de IA (D0-09 §3); el dominio es el único que
decide permisos y persiste. Por eso `POST /extraccion` recibe **los fragmentos
y el catálogo de productos en la petición** en vez de buscarlos por
`campaignId`: así el worker nunca tiene con qué filtrar mal ni con qué
inventar un producto que no existe.

**Catálogo único de campos:** antes de este incremento, `services/ai-worker`
derivaba su propia tabla de criticidad y `packages/domain` no tenía ninguna.
Ahora ambos leen el mismo archivo,
[`docs/product/brief-schema/brief-catalog.json`](docs/product/brief-schema/brief-catalog.json)
(41 claves, DEC-021) — `packages/domain/src/brief-catalog.ts` de un lado,
`services/ai-worker/app/brief_schema.py` del otro. `scripts/verificar-catalogo.mjs`
compara ambas lecturas y falla la build si divergen.

---

## 4. Cómo levantarlo (y las trampas)

```bash
docker compose up -d db redis worker consumidor
npm run migrate --workspace @tcl-kol-os/db
npm run dev --workspace @tcl-kol-os/web
```

Para correr `npm test --workspace @tcl-kol-os/db` (pruebas de integración) hace
falta además una base **separada**, exigida por INC-001A (§8.7):

```bash
docker exec tclkolos-db psql -U tclkolos -d postgres -c "CREATE DATABASE tclkolos_test"
docker exec tclkolos-db psql -U tclkolos -d tclkolos_test -f /docker-entrypoint-initdb.d/01-extensions.sql
DATABASE_URL=postgresql://tclkolos:devpassword@localhost:5432/tclkolos_test npm run migrate --workspace @tcl-kol-os/db
DATABASE_URL=postgresql://tclkolos:devpassword@localhost:5432/tclkolos_test npm run seed --workspace @tcl-kol-os/db
```

`TEST_DATABASE_URL` en `.env`/`.env.example` ya apunta ahí. `packages/db/vitest.setup.ts`
se niega a arrancar si esa variable falta o si el nombre de la base no termina
en `_test` — no hay fallback silencioso hacia la base de desarrollo.

Siete cosas que cuestan tiempo si no se saben:

1. **`docker compose up` sin `consumidor` deja la cola sin consumir.** El
   servicio `worker` atiende HTTP; el `consumidor` es el que procesa
   `processing_jobs`. Son dos procesos distintos sobre la misma imagen.
2. **No correr `worker.py` desde el venv local.** Ese intérprete no tiene
   `python-docx` ni `python-pptx`, así que marca los documentos como `fallido`
   sin que el código tenga nada malo. Va dentro del contenedor.
3. **`npm run check` corre `next build`, que pisa el `.next` del servidor de
   desarrollo.** Si la web queda en blanco: `rm -rf apps/web/.next` y reiniciar.
4. **Docker Desktop se cae solo en esta máquina.** Si algo falla con un mensaje
   vacío o raro, comprobar el daemon antes de depurar el código.
5. **El `consumidor` de `docker-compose.yml` monta `./services/ai-worker` en
   vivo (`volumes: - ./services/ai-worker:/app`)** — no reconstruye la imagen
   para tomar cambios de código. Si se levanta un consumidor "de repuesto"
   fuera de compose (por ejemplo para apuntarlo a `tclkolos_test`), hay que
   replicar ese mismo montaje o falla con `worker.py` no encontrado.
6. **Un `processing_jobs` con `intentos > max_intentos` bloquea al
   consumidor entero**, no solo esa fila: la próxima vez que intenta tomar
   trabajo revienta con `CheckViolation` y no procesa nada más. Si el
   consumidor deja de avanzar, revisar primero si hay una fila atascada.
7. **`packages/db`'s `migrate`/`seed` corren con `node --experimental-strip-types`**,
   que exige Node ≥ 22.6. El `engines` del repo dice `>=20`; en la práctica,
   cualquier paso que invoque esos scripts necesita 22+. CI ya quedó en 22
   (§8, hallazgo nuevo).

La clave de OpenRouter vive **solo** en `.env` (que está en `.gitignore`).
Nunca se pega en el chat ni se commitea. `AI_ENABLED=true` está puesto en el
`.env` local; `.env.example` mantiene `false`, que es lo correcto para un clon
nuevo. **`AI_PROVIDER=fake` es exclusivo de pruebas automatizadas** (
`services/ai-worker/app/ai/fake_provider.py`) — determinístico, sin red, sin
costo. Nunca se usa en Demo A ni en producción; los tests que lo necesitan
(`end-to-end.test.ts`) lo detectan por HTTP y se omiten en silencio si no hay
un worker con esa variable activa.

---

## 5. Qué queda deliberadamente fuera de este incremento

No son olvidos — son cortes de alcance explícitos, documentados para que la
próxima sesión no los redescubra por accidente:

| Qué | Por qué queda fuera |
|---|---|
| **Exportación, traducción, CRM de influencers, métricas de campaña, OCR, Google Drive, OIDC** | Excluidos por el alcance original de Sprint 5 (fuera del pedido explícitamente). |
| **Control dedicado para campos `lista`/`enum`/`numero`/`lista_objetos` en el editor manual** | Sigue siendo un `<input>` de texto plano sin validación estructural, deuda ya marcada `PARTIAL` desde el cierre de Sprint 4 (E7-3) — confirmada de nuevo al acotar a propósito la validación de `PrecisedDate` en Sprint 5 a `valueType:'fecha'` (D0-18 §5, defecto 3), para no bloquear esos campos sin ofrecer un control para satisfacerlos. |
| **Verificación de Fase J contra el runner real de GitHub Actions** | Se reprodujo la receta literal de `ci.yml` (ya corregida) dentro de un contenedor recién creado, sin `.venv` preexistente — ver D0-18 §10.3; no dentro de GitHub Actions, porque este repositorio no tiene remoto configurado en esta sesión y crear uno exige autorización de push que no se pidió. |
| **Más de una organización cliente** | El modelo actual (`canAccessResource` para `cliente` decide por `visibility`, no por organización) asume una sola organización cliente, igual que ya asumía DEC-011. Documentado en D0-18 §8 para que no se redescubra por accidente si en el futuro hay más de un cliente. |

---

## 6. Lo que necesita decisión del product owner

Ninguna decisión de producto pendiente y sin resolver al cierre de este
incremento — las que existían (ciclo de aprobación final, fechas con
precisión en el editor manual) quedaron implementadas. Las nuevas
decisiones tomadas en el camino están en el decision-log, DEC-030 a
DEC-034.

## 7. Bloqueos externos (no dependen del código)

- **Material real de más campañas** — desbloquea los casos `real_derivado` del
  gold set (D0-13) y completa D0-14.
- **Tiempo de ciclo del brief** sigue sin medir (D0-14 §8).
- **Credenciales OIDC** de Google Workspace, y de **Google Drive** (E4-2).
- **OCR** para PNG/JPG (E4-7).

---

## 8. Errores en los que ya caí — para no repetirlos

Están documentados porque cada uno costó tiempo y ninguno era obvio:

1. **Afirmé que el cliente no había mandado dos campos** basándome en la salida
   de la extracción, sin abrir la fuente. Era falso: el dato estaba y la
   extracción lo archivaba en otro campo (DEC-022). **Un `not_found` no prueba
   que el dato no exista mientras nadie haya mirado la fuente.**
2. **Verificar que una cita existe no verifica que el valor se desprenda de
   ella.** El modelo devolvió `2026-11-30` citando «Octubre-Noviembre 2026»:
   cita literal y verificable, día inventado. Para fechas ya se comprueba
   (DEC-026); para texto libre **sigue abierto**.
3. **Una prueba de aislamiento que pasa no prueba nada** si también pasaría con
   el error. Se rompió el filtro a propósito para confirmar que la prueba lo
   detecta. Repetir esa disciplina.
4. **Contar directorios con `parents[3]` se rompe en Docker.** Pasó dos veces,
   en `brief_schema.py` y en `runner.py`. Por eso `brief-catalog.ts` y
   `brief_schema.py` cargan el catálogo por variable de entorno
   (`BRIEF_CATALOG_PATH`) con búsqueda hacia arriba, nunca contando niveles.
5. **Un evaluador que busca una palabra en la salida da falsos positivos.** Casi
   reporté que unos modelos obedecían una inyección de prompt cuando solo
   estaban extrayendo el texto correctamente.
6. **De cada diez llamadas al proveedor, ~2 vuelven con JSON partido y
   `finish_reason: stop`.** Hay un reintento; no confundirlo con `max_tokens`.
7. **Una prueba de integración reescrita reutilizó (y luego borró) una
   versión real y no terminal del brief de P80** al llamar a
   `obtenerOCrearVersionDeTrabajo` (DEC-024) sobre la campaña compartida del
   seed en vez de una propia. Se perdieron los campos y la evidencia de una
   extracción real; los documentos fuente y sus fragmentos procesados
   siguieron intactos. Ver
   [`docs/incidents/INC-001-test-data-collision.md`](docs/incidents/INC-001-test-data-collision.md)
   para la causa raíz completa y la contención — no fue "un glitch", fue un
   hallazgo real de aislamiento de pruebas, y ahora `packages/db` exige una
   base de pruebas separada (`TEST_DATABASE_URL`) que se niega a arrancar
   contra la base de desarrollo. **Regeneración de la extracción real de
   P80 (Gate INC-001B): pendiente** — ver el propio documento del incidente
   para el estado exacto.
8. **CI nunca tuvo Postgres.** El job `web` corría `npm test` en la raíz sin
   ningún servicio de base de datos. Corregido: `web` job ahora levanta
   `pgvector/pgvector:pg16`, migra y siembra `tclkolos_test` antes de las
   pruebas. **Primer reporte de este arreglo se declaró apresuradamente
   "corregido" sin haber corrido la suite contra una base realmente
   recién creada** — al hacerlo, tres archivos fallaban («55/101 en frío»):
   `extraction.test.ts` y `brief-rules.test.ts` leían fragmentos o una
   fuente de una campaña ajena a la prueba (**y estos dos sí son de este
   incremento — decir que eran "preexistentes, sin tocar" fue un error de
   reporte, no solo de alcance**); `search.test.ts` (sí preexistente,
   Sprint 3) necesitaba un fragmento ya indexado por un worker real. Los
   tres se corrigieron: cada uno siembra ahora sus propios documentos y
   fragmentos sintéticos dentro de su propia campaña desechable. Verificado
   dos veces, cada vez contra un contenedor Postgres efímero **distinto**,
   recién migrado y sembrado: **110/110 ambas corridas**, sin residuo.
   Detalle completo en
   [D0-17 §6](docs/product/D0-17-cierre-sprint4.md#6-ci-y-reproducibilidad-desde-cero).
9. **`ruff check .` sobre `services/ai-worker` también se declaró
   "preexistente, sin tocar" cuando dos de los archivos con más errores sí
   se habían modificado esta sesión (`openrouter.py`, `embeddings.py`,
   `extraction.py`).** Se corrigieron los 116 errores reales en vez de
   excluir archivos o relajar reglas: renombrar dos excepciones con sufijo
   `Error` (N818), dos `# noqa: S310` justificados sobre `urllib` (uso
   deliberado de la librería estándar, sin URL variable), un
   `try/except/pass` reemplazado por `contextlib.suppress`, el resto
   mecánico (`ruff check --fix`, seguro porque todo el paquete ya usa
   `from __future__ import annotations`). `ruff check .` queda limpio de
   verdad — no hay ninguna exclusión nueva en `pyproject.toml`.
10. **La imagen Docker del worker (`tcl-kol-os-worker:latest`) no trae
   `worker.py` — depende por completo del bind mount de
   `docker-compose.yml`.** Un contenedor de repuesto lanzado con `docker run`
   directo (usado varias veces durante la verificación de este cierre, para
   apuntar un worker+consumidor con `AI_PROVIDER=fake` a una base efímera)
   falló hasta replicar exactamente esos tres montajes
   (`./services/ai-worker:/app`, `./docs/product/brief-schema:/esquema:ro`,
   `./.storage:/almacen`) y las variables `AI_MODEL_*` — sin ellas, el
   proveedor falso igual falla con "No hay modelo configurado para el nivel
   'eficiente'", porque `ai/router.py` resuelve el nombre del modelo antes
   de decidir si la llamada real ocurre o no.
11. **Un `PASS` declarado sin la corrida que lo prueba no es un `PASS`.**
   El primer reporte de "CI corregido" (punto 8) citaba «la receta literal
   de `ci.yml`» pero esa corrida específica había dado `1 failed | 109
   passed` — el product owner lo señaló antes de que se declarara cerrado.
   La falla era `pipeline.test.ts` (Sprint 2) dependiendo de rutas de
   `/Users/.../Downloads/...` de esta máquina. Corregida de raíz, no
   explicada como excepción: fixture sintético versionado
   (`fixtures/pipeline/documento-de-prueba.pptx`) y worker+consumidor reales
   (`AI_PROVIDER=fake`) ahora levantados por el propio `ci.yml`. Al
   levantarlos apareció además un bug real sin cobertura de `pytest` —
   ningún test importa `app.main`, así que nada detectó que el `ruff --fix`
   del punto 9 había convertido `Optional[int]` en `int | None` dentro de
   los `pydantic.BaseModel` de `app/main.py`. A diferencia de una anotación
   de función normal, Pydantic v2 evalúa las anotaciones de un `BaseModel`
   al definir la clase — `from __future__ import annotations` no protege
   eso — y esa sintaxis revienta en el Python 3.9 mínimo declarado del
   proyecto. Corregido con `Optional[int]` de vuelta en esos cuatro campos,
   documentado en el propio código. **Resultado verificado con la receta
   literal de `ci.yml` contra servicios efímeros recién creados: cero
   fallas.** Detalle completo en
   [D0-17 §6](docs/product/D0-17-cierre-sprint4.md#6-ci-y-reproducibilidad-desde-cero).
12. **Corregir un campo ya extraído con `confidence` no nulo rompía una
    restricción de base real (`brief_fields_manual_sin_confianza`), y ningún
    test lo detectó antes de Demo A.** `corregirCampo`, `resolverConflicto`,
    `declararExcepcionProducto` (rama de fila existente) y `responderPregunta`
    cambiaban `provenance_type` a `manual_local` sin poner `confidence =
    NULL` — la migración 004 exige que un campo `manual_local` nunca lleve
    una confianza estimada por IA. Ninguna prueba anterior lo cubría porque
    `crearBriefManual` siempre siembra `confidence: NULL`; **la única forma
    de encontrarlo era corregir un campo realmente extraído**, que es
    exactamente lo que hizo Demo A (error 500 real en la UI). Corregido en
    las 4 rutas, 5 pruebas de regresión nuevas, toda la matriz de CI vuelta a
    correr antes de cerrar. Detalle en
    [D0-17 §4 y §6.1](docs/product/D0-17-cierre-sprint4.md#6-ci-y-reproducibilidad-desde-cero).
    **Lección:** un helper de prueba que siembra datos "limpios" por defecto
    (aquí, `confidence` siempre `NULL`) puede esconder un defecto entero de
    una rama de código que solo se activa con datos "sucios" reales — vale
    la pena, para cualquier módulo que combine dos o más campos derivados
    entre sí, tener al menos una prueba que simule el estado real más
    cercano a producción, no solo el estado inicial que siembra el propio
    helper de pruebas.
13. **`client_review → approved` nunca se había ejecutado en toda la vida del
    proyecto** hasta Sprint 5 (DEC-027 quedaba documentado, no implementado).
    Al ejercitarlo por primera vez con datos reales aparecieron seis
    defectos que ninguna prueba en memoria había detectado — mismo patrón
    exacto que el punto 12: **un camino nunca ejercitado no está probado,
    esté o no "cubierto" por una prueba que corre en memoria contra datos
    de mentira.** El más costoso: un trigger de base (`claim_exige_evidencia`,
    migración 004) le faltaba la excepción de DEC-028 que el dominio ya
    aplicaba desde Sprint 4 — nadie lo había notado porque nada había
    llegado nunca a `approved` con un campo crítico resuelto por pregunta
    local. Detalle completo de los seis defectos en
    [D0-18 §5](docs/product/D0-18-cierre-sprint5.md).
14. **Validar de más rompe tanto como validar de menos.** Al exigir
    `PrecisedDate` en `corregirCampo` para cumplir DEC-026, la primera
    versión lo aplicó a todos los `valueType`, no solo `fecha` — bloqueó de
    inmediato cualquier corrección de un campo `lista` (`practico.hitos`)
    desde el editor manual, que solo tiene un `<input>` de texto plano y
    ningún control para satisfacer esa forma. Se encontró probando el
    editor en vivo, no con una prueba automatizada — ninguna prueba
    existente tocaba un campo `lista` a través de `corregirCampo`. Corregido
    acotando la validación exactamente al alcance que pidió Sprint 5.
15. **Un `PASS` de "verifiqué contra la receta de `ci.yml`" no es lo mismo
    que haber ejecutado los comandos que `ci.yml` realmente tiene.** La
    verificación de Fase J de la entrega inicial de Sprint 5 usó Docker
    Compose (`docker compose up --build worker`), que construye el worker
    con su `Dockerfile` — un camino de instalación distinto al que
    `ci.yml` ejecuta paso a paso. Por eso nunca se notó que
    `.venv/bin/python -m uvicorn` en el workflow referenciaba un entorno
    que ningún paso anterior crea: en un checkout limpio (cualquier runner
    real), ese comando falla siempre. Lo encontró una auditoría
    independiente del ZIP, no esta sesión. **Lección:** "correr la receta
    de CI" significa ejecutar los comandos exactos del archivo YAML, no
    una ruta equivalente que da el mismo resultado final por otro camino
    — sobre todo cuando ese otro camino (aquí, el `Dockerfile`) fue escrito
    por una razón distinta (producción/desarrollo local) y puede divergir
    del workflow sin que nadie lo note. Corregido y re-verificado en un
    contenedor sin `.venv` preexistente — detalle en
    [D0-18 §10](docs/product/D0-18-cierre-sprint5.md).
16. **Inmutabilidad sin repetir el escenario completo del ciclo de vida no
    prueba lo que promete.** Los triggers de `brief_fields`/`field_comments`
    llevaban desde Sprint 4/5 bloqueando `approved` correctamente, y todas
    las pruebas que existían lo confirmaban — pero ninguna prueba había
    llevado nunca una versión hasta `superseded` y luego intentado tocar su
    contenido, así que nadie notó que la protección desaparecía justo ahí.
    `evidence`/`local_questions`/`brief_field_revisions` tampoco habían
    tenido nunca protección propia. Corregido en migración 009, con 34
    pruebas SQL directas que repiten cada aserción en los dos estados
    (`approved` y `superseded`) — el patrón a seguir de ahora en adelante
    para cualquier regla de inmutabilidad nueva: probarla en TODOS los
    estados que se supone que cubre, no solo en el primero que se piensa.

---

## 9. Mapa rápido del código

```
packages/domain/     Reglas puras. No importa de apps/ ni services/ (ADR-008)
  brief-states.ts      12 estados, ~25 transiciones, 9 guardas — incluidas
                        las dos que ahora también autorizan al rol `cliente`
  brief-catalog.ts     Catálogo único de 41 campos (lee brief-catalog.json)
  field-values.ts       validarValorEstructurado — validación por valueType (Sprint 5)
  types.ts             BriefField, LocalQuestion, CampaignProduct, PrecisedDate...
  permissions.ts       Qué rol puede qué — cliente ahora con dos acciones más

packages/db/         Aplica la política del dominio; nunca la redefine
  brief-version.ts     obtenerOCrearVersionDeTrabajo (DEC-024)
  transitions.ts        transicionarBrief — único punto que cambia status;
                          accionParaDestino mapea to→Action; sube visibility (DEC-032)
  brief-fields.ts        confirmarCampo/corregirCampo/resolverConflicto (revisión optimista);
                          validarSiEsFecha acota DEC-026 a valueType:'fecha'
  local-questions.ts    generarPreguntas/responderPregunta/descartarPregunta (E6)
  manual.ts              crearBriefManual — camino sin IA
  extraction.ts          Llama al worker, valida producto, persiste, transiciona
  client-review.ts       (Sprint 5) solicitarCambiosInternos/aprobarInternamente/
                          solicitarCambiosCliente/aprobarComoCliente
  versioning.ts           (Sprint 5) crearVersionHija — candado atómico (DEC-033)
  comments.ts             (Sprint 5) comentarios internos por campo (E7-6)
  test-utils.ts           (Sprint 5, correctivo) eliminarCampanaDePrueba — única
                            función que activa el bypass de inmutabilidad (DEC-036),
                            solo para limpieza de pruebas, nunca la app real

services/ai-worker/  Único que habla con el proveedor de IA — sin cambios en Sprint 5
  brief_schema.py      Lee el catálogo único (antes: tabla propia)
  extraction.py         Anclaje de producto, mandatorios vs. restricciones, fechas con precisión
  ai/provider.py         Selección real/fake según AI_PROVIDER
  ai/fake_provider.py    Determinístico, solo pruebas — nunca demos ni producción

apps/web/            Next.js 15. Server actions en src/lib/actions.ts
  campanas/[id]/brief/              UI-08/UI-11 — extracción, tabla de campos;
                                     rama VistaCliente.tsx para el rol cliente (Sprint 5)
  campanas/[id]/brief/editar/       E7/UI-10 — editor por sección; PanelComentarios.tsx (Sprint 5)
  campanas/[id]/preguntas/          E6/UI-09 — responder o descartar preguntas locales
  components/ControlDeFecha.tsx     (Sprint 5) control de PrecisedDate, compartido

infra/db/migrations/ 005_producto_preguntas_y_revision.sql — anclaje, revisión, brief_field_revisions
                      007_comentarios_internos.sql — field_comments (Sprint 5)
                      008_claim_exige_evidencia_excepcion_manual.sql — excepción DEC-028 (Sprint 5)
                      009_inmutabilidad_historica.sql — protección tras superseded/
                        cancelled en las seis tablas (Sprint 5, correctivo — DEC-036)
                      010_inmutabilidad_bypass_restringido.sql — bypass acotado a
                        bases "_test", DELETE de brief_versions bloqueado, fila
                        histórica congelada por completo (Sprint 5, segundo
                        correctivo — DEC-037)
docs/product/brief-schema/brief-catalog.json   Fuente única de los 41 campos
```

**Documentos clave:** [decision-log](docs/decisions/decision-log.md) ·
[D0-05 brief maestro](docs/product/D0-05-plantilla-brief-maestro.md) ·
[D0-08 modelo de datos](docs/architecture/D0-08-modelo-datos.md) ·
[D0-11 backlog](docs/product/D0-11-backlog-mvp1.md) ·
[INC-001](docs/incidents/INC-001-test-data-collision.md) ·
[D0-17 — cierre de Sprint 4](docs/product/D0-17-cierre-sprint4.md) ·
[D0-18 — cierre de Sprint 5](docs/product/D0-18-cierre-sprint5.md) ·
[D0-19 — cierre de Sprint 6 (Fase B+C, Checkpoint 2)](docs/product/D0-19-cierre-sprint6.md)

## Sprint 6 — Brief Workspace (`PARTIAL`: falta exportación)

Encima del rediseño de UI que ya estaba en el repo (`AppShell`, workspace de
3 columnas del editor, etc.), Sprint 6 añade un **contrato de lectura único**
del brief, tres modos de workspace (Completar/Revisar brief/Actividad) y el
primer harness de Playwright del repositorio, sin tocar dominio, migraciones
ni el flujo anterior. Detalle completo en
[D0-19](docs/product/D0-19-cierre-sprint6.md) — Fase B+C en §1-11, Checkpoint 2
en §12; resumen rápido:

- `obtenerBriefWorkspace(actor, campaignId)` (`packages/db/src/brief-workspace.ts`)
  — un único modelo (`BriefWorkspace`, `packages/domain/src/workspace.ts`) que
  compone `getCampaign`/`verCamposDeVersion`/`listarPreguntas`/
  `contarConversacionesAbiertas`/`allowedTransitions`, nunca SQL propio. Nunca
  una segunda función que compita con esta — Checkpoint 2 la extendió, no la
  duplicó.
- `/campanas/[id]/brief/workspace?modo=completar|revisar|actividad` — tres
  modos navegables por URL, detrás de la variable de entorno
  `BRIEF_WORKSPACE_V2` (`true` la activa; apagada o ausente, reenvía a
  `/brief/editar` de siempre). **Completar**: una tarea a la vez, con las
  mismas server actions de `TablaPreguntas.tsx`. **Revisar brief**: el brief
  como documento de solo lectura por los diez bloques canónicos, con
  evidencia bajo demanda. **Actividad**: línea de tiempo real (comentarios,
  cambios de campo, aprobaciones) fusionada de registros existentes, nunca
  una tabla nueva. Un banner explica siempre quién debe actuar y por qué, con
  un enlace real a la acción cuando el actor mismo puede ejecutarla —
  "no limitarse a esconder el botón".
- `apps/e2e` (`@tcl-kol-os/e2e`) — Playwright, base `_test` aislada, 9 casos
  obligatorios (flag, tres modos, responder/saltar, roles, cliente,
  aislamiento multi-tenant), todos en verde.
- **Pendiente para el siguiente incremento:** exportación PDF/DOCX (Fase E) —
  única razón por la que Sprint 6 sigue `PARTIAL`.
