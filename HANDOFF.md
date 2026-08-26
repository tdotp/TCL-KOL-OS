# Handoff — TCL KOL OS

Estado a **26 de agosto de 2026**. Base de este cierre: `10788d9`. Trae el cierre de
Sprint 3 + Sprint 4 (brief funcional de punta a punta) sin commitear todavía.

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
| **Sprint 4 — ciclo de estados real, anclaje de producto, Épica E6 (preguntas locales), E7 (editor)** | ✅ **con reservas — ver §5** |
| Ciclo de aprobación final, exportación, traducción, Drive/OIDC/OCR | ⬅️ **siguiente** |

**Pruebas al cierre de este incremento:** 61 dominio (vitest) · 101 integración
`packages/db` (vitest, contra Postgres real, dos corridas consecutivas
estables — INC-001A) · 97 worker (pytest) · verificación cruzada de catálogo
TS/Python en verde · `npm run lint` y `mypy app` limpios · `next build`
compila, incluidas las dos rutas nuevas (`/brief/editar`, `/preguntas`).

### Lo que cambia respecto al HANDOFF anterior

La versión previa de este archivo declaraba Sprint 3 cerrado y Sprint 4 como
"siguiente", pero verificar el código real mostró que era optimista en dos
frentes: la máquina de estados del dominio (12 estados, ~25 transiciones)
nunca se conectaba a nada fuera de su propio test, y la pantalla de
extracción era de solo lectura sin camino de confirmación, corrección, ni
manual. Este incremento cierra esa brecha:

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
| **Ciclo de aprobación final** (crear versión hija al editar una `approved`, marcar la anterior `superseded`) | DEC-027 lo documenta pero no lo implementa. Este incremento llega hasta `internal_review`. Protegido igual por ADR-003/triggers de inmutabilidad. |
| **E7-6 — comentarios internos en el editor** | Prioridad `should`, explícitamente diferida. El editor (E7/UI-10) cubre navegación por sección, selector de producto, edición con autoguardado, confirmación y evidencia inline. |
| **"Desenganchar producto" en un campo `compartido_con_excepcion`** | Crear una fila de excepción nueva para un producto (distinto de `corregirCampo`, que solo actualiza filas existentes) no tiene función de repositorio propia. El editor muestra estos campos como fila única compartida. |
| **Exportación, traducción, vista de cliente, CRM de influencers, métricas de campaña** | Excluidos por el alcance original de este incremento (§2 del pedido). |
| **CI ejecutando el worker real** | Ver §8 — tres archivos de prueba preexistentes (`brief-rules.test.ts`, `extraction.test.ts`, `search.test.ts`) necesitan una fuente ya procesada/indexada que ni el seed ni Postgres solos proveen. |

---

## 6. Lo que necesita decisión del product owner

| # | Asunto | Por qué importa |
|---|---|---|
| 1 | **¿Cuándo se acomete el ciclo de aprobación final?** | DEC-027 lo deja documentado; falta decidir si es el siguiente incremento o si hay algo más urgente primero. |
| 2 | **"Desenganchar producto" en campos compartidos** | ¿Vale la pena una función de repositorio dedicada, o el flujo real nunca necesita declarar una excepción sin partir de una corrección existente? |
| 3 | **CI sin worker real** | ¿Se justifica levantar el worker (con `AI_PROVIDER=fake`) dentro de CI para que las tres pruebas de §8 corran ahí, o se documentan como "solo local" de forma permanente? |

## 7. Bloqueos externos (no dependen del código)

- **La clave de OpenRouter en `.env` ya no es válida** (`AIError: La clave de
  OpenRouter no es válida o expiró.`) — confirmado el 26 de agosto de 2026
  al intentar regenerar la extracción real de P80 (Gate INC-001B) y también
  visto antes en los logs del `consumidor` al indexar embeddings. **Esto
  bloquea la Demo A y el cierre de Gate INC-001B**, ambos con estado
  `BLOCKED_EXTERNAL_INPUT`. No es un bug: el ciclo de estados manejó la
  falla exactamente como debía (versión 3 de P80 quedó en
  `processing_failed`, con «Reintentar extracción» visible). En cuanto haya
  una clave válida, basta con abrir `/campanas/f9a857bf-.../brief` y pulsar
  «Reintentar extracción» — no hace falta recrear nada. Detalle completo en
  [INC-001 §7](docs/incidents/INC-001-test-data-collision.md#7-regeneración--gate-inc-001b).
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
   ningún servicio de base de datos: `packages/db` fallaba (o, antes de
   INC-001A, se arriesgaba a correr contra lo que hubiera en `DATABASE_URL`)
   en cada PR, sin que nadie lo notara porque nadie miraba ese paso en
   detalle. Corregido: `web` job ahora levanta `pgvector/pgvector:pg16`,
   migra y siembra `tclkolos_test` antes de las pruebas. **Aun así, tres
   archivos preexistentes (`brief-rules.test.ts`, `extraction.test.ts`,
   `search.test.ts`) siguen fallando en una base recién creada** porque
   asumen al menos una fuente ya procesada e indexada — algo que solo existe
   hoy por acumulación de uso real en una base de desarrollo, nunca por
   `npm run seed`. Verificado corriendo la suite completa contra un
   contenedor de Postgres efímero, igual al que usa CI: 55/101 pasan «en
   frío», el resto exige ese material. No se tocó esos tres archivos —
   quedan fuera de alcance de este incremento (§2) y registrados en la
   tabla de §5/§6.
9. **La imagen Docker del worker (`tcl-kol-os-worker:latest`) no trae
   `worker.py` — depende por completo del bind mount de
   `docker-compose.yml`.** Un contenedor de repuesto lanzado con `docker run`
   directo (para apuntar el consumidor a `tclkolos_test` durante la
   verificación de este cierre) falló hasta replicar exactamente esos tres
   montajes (`./services/ai-worker:/app`, `./docs/product/brief-schema:/esquema:ro`,
   `./.storage:/almacen`).

---

## 9. Mapa rápido del código

```
packages/domain/     Reglas puras. No importa de apps/ ni services/ (ADR-008)
  brief-states.ts      12 estados, ~25 transiciones, 9 guardas
  brief-catalog.ts     Catálogo único de 41 campos (lee brief-catalog.json)
  types.ts             BriefField, LocalQuestion, CampaignProduct, PrecisedDate...
  permissions.ts       Qué rol puede qué

packages/db/         Aplica la política del dominio; nunca la redefine
  brief-version.ts     obtenerOCrearVersionDeTrabajo (DEC-024)
  transitions.ts        transicionarBrief — único punto que cambia status
  brief-fields.ts        confirmarCampo/corregirCampo/resolverConflicto (revisión optimista)
  local-questions.ts    generarPreguntas/responderPregunta/descartarPregunta (E6)
  manual.ts              crearBriefManual — camino sin IA
  extraction.ts          Llama al worker, valida producto, persiste, transiciona

services/ai-worker/  Único que habla con el proveedor de IA
  brief_schema.py      Lee el catálogo único (antes: tabla propia)
  extraction.py         Anclaje de producto, mandatorios vs. restricciones, fechas con precisión
  ai/provider.py         Selección real/fake según AI_PROVIDER
  ai/fake_provider.py    Determinístico, solo pruebas — nunca demos ni producción

apps/web/            Next.js 15. Server actions en src/lib/actions.ts
  campanas/[id]/brief/editar/   E7/UI-10 — editor estructurado por sección
  campanas/[id]/preguntas/      E6/UI-09 — responder o descartar preguntas locales

infra/db/migrations/ 005_producto_preguntas_y_revision.sql — anclaje, revisión, brief_field_revisions
docs/product/brief-schema/brief-catalog.json   Fuente única de los 41 campos
```

**Documentos clave:** [decision-log](docs/decisions/decision-log.md) ·
[D0-05 brief maestro](docs/product/D0-05-plantilla-brief-maestro.md) ·
[D0-08 modelo de datos](docs/architecture/D0-08-modelo-datos.md) ·
[D0-11 backlog](docs/product/D0-11-backlog-mvp1.md) ·
[INC-001](docs/incidents/INC-001-test-data-collision.md) ·
[D0-17 — cierre de este incremento](docs/product/D0-17-cierre-sprint4.md)
