# Changelog

Formato basado en [Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/).

## [No publicado]

### Cierre de Sprint 5 — Ciclo completo del brief: de `internal_review` a `approved` · 15 de septiembre de 2026

Comentarios internos por campo, fechas estructuradas en el editor manual, aprobación interna con motivo, revisión y decisión del cliente, y versionado posterior a aprobación. Detalle completo en [D0-18](docs/product/D0-18-cierre-sprint5.md).

#### Añadido

- **E7-6 — comentarios internos por campo**, diferidos desde Sprint 4: crear, responder en hilo, resolver, reabrir, contador de conversaciones abiertas. Ancla a `(brief_version_id, field_key)`, no a la fila del campo, para sobrevivir a una versión hija. Nunca visibles para el rol `cliente` (`packages/db/src/comments.ts`, migración `007_comentarios_internos.sql`).
- **DEC-026 en el editor manual**: `corregirCampo` ahora exige el objeto `PrecisedDate` para campos de fecha — antes solo lo exigía el camino de preguntas locales. Control de fecha con precisión real, reutilizado del editor de preguntas (`ControlDeFecha.tsx`).
- **Ciclo de aprobación interna**: solicitar cambios internos con motivo obligatorio, reenviar, aprobar internamente — todo sobre las transiciones que el dominio ya declaraba desde Sprint 3/4 (`packages/db/src/client-review.ts`).
- **Revisión y decisión del cliente**: vista de solo lectura por sección con evidencia, sin costos ni información técnica (`VistaCliente.tsx`); el rol `cliente` puede solicitar cambios (señalando campos concretos) o aprobar, con dos permisos nuevos y acotados (`brief:request_client_changes`, `brief:register_client_decision`).
- **Versionado posterior a aprobación (DEC-027)**: `crearVersionHija` — candado de concurrencia atómico, copia de campos y evidencia como punto de partida, la versión anterior queda `superseded` e intacta, sus comentarios internos quedan asociados a la versión histórica.

#### Corregido

- `campaigns.visibility` nunca subía de `interna` a `tcl` en ningún flujo — el rol `cliente` no podía ver ninguna campaña real pese a que ADR-004 ya lo prometía. Ahora sube automáticamente al aprobar internamente (DEC-032).
- El trigger `claim_exige_evidencia()` (migración 004) no tenía la excepción de DEC-028 para campos críticos resueltos por pregunta local — bloqueaba cualquier aprobación real. Corregido en migración `008_claim_exige_evidencia_excepcion_manual.sql`.
- `listCampaigns` filtraba por la organización del actor incluso para el rol `cliente`, que es de otra organización por definición — la campaña nunca aparecía en su listado.

#### Corregido — auditoría de cierre · 16 de septiembre de 2026

- **CI nunca podía correr en un runner limpio**: `.github/workflows/ci.yml` levantaba el worker con `.venv/bin/python`, pero ningún paso creaba ese entorno virtual. Corregido a `python -m uvicorn`/`python -m pip install`, verificado en un contenedor recién creado sin `.venv` preexistente (DEC-035).
- **La inmutabilidad histórica desaparecía después de `superseded`**: los triggers de `brief_fields`/`field_comments` solo protegían `approved`; `evidence`, `local_questions` y `brief_field_revisions` nunca tuvieron protección propia. Migración `009_inmutabilidad_historica.sql` extiende la protección a `approved`/`superseded`/`cancelled` en las seis tablas, con 34 pruebas SQL directas nuevas (DEC-036).

### Cierre de Sprint 3 + Sprint 4 — Brief funcional de punta a punta · 26 de agosto de 2026

Épica E6 (preguntas locales) y E7 (editor estructurado), más lo que Sprint 3
dejó modelado sin conectar: la máquina de estados del dominio y el anclaje de
producto. Demo: crear campaña → cargar fuentes → extraer campos → revisar y
corregir → generar preguntas → responder vacíos → editar el brief → validarlo
→ enviarlo a revisión interna — con IA y también con `AI_ENABLED=false`.

#### Añadido

- **Ciclo de estados real** *(E8-1, conectado por fin)*: `transicionarBrief`
  (`packages/db/src/transitions.ts`) es el único punto que cambia
  `brief_versions.status` — nunca un `UPDATE` directo. Cubre
  `draft → processing → extraction_review → local_questions →
  extraction_review → internal_review`, con reintento desde
  `processing_failed` y auditoría en cada paso.
- **Anclaje de producto de extremo a extremo** *(DEC-023)*: el worker recibe
  el catálogo real de productos de la campaña; `persistirExtraccion` rechaza
  toda la extracción si algún `productoId` no pertenece a ella. P80 (3
  productos, reparto 60/20/10) ya no puede mezclar campos entre modelos.
- **Camino manual, sin IA** *(3.3 del pedido)*: `crearBriefManual` siembra las
  41 claves del catálogo único, funciona con `AI_ENABLED=false`.
- **Épica E6 — preguntas locales**: generación idempotente por campo
  ausente/en conflicto (`generarPreguntas`), respuesta con valor
  estructurado validado contra el tipo del catálogo (`responderPregunta`),
  descarte con justificación obligatoria (`descartarPregunta`), alcance por
  producto. UI-09 en `apps/web/src/app/campanas/[id]/preguntas/`.
- **Épica E7 — editor estructurado (UI-10)**: navegación por las 10 secciones
  de D0-05, selector de producto, campos con autoguardado al perder foco,
  confirmación explícita, evidencia inline, clave técnica en un `<details>`
  secundario. `apps/web/src/app/campanas/[id]/brief/editar/`.
- **Confirmar y corregir campos con control de concurrencia optimista**
  *(revisión entera, nunca "el último que escribe gana")*: cada
  `brief_fields` tiene `revision`, incrementada por trigger; un `UPDATE` con
  la revisión vieja se rechaza con `FIELD_REVISION_CONFLICT` en vez de
  aplicarse en silencio. El historial de cada cambio vive en
  `brief_field_revisions`, separado de `audit_events` *(DEC-024)*.
- **Catálogo único de 41 campos** *(corrección de diseño, DEC-021 llevada a
  la práctica)*: `docs/product/brief-schema/brief-catalog.json` reemplaza dos
  tablas derivadas por separado (TS y Python). `scripts/verificar-catalogo.mjs`
  compara ambas lecturas en CI.
- **Fechas con precisión real** *(DEC-026)*: `{tipo, fecha?, inicio?, fin?,
  textoOriginal}` en vez de un binario `found`/`not_found`; una precisión
  imprecisa en un campo crítico dispara una pregunta local pidiendo el día
  exacto.
- **Mandatorios vs. restricciones** *(DEC-025)*: corrección puntual del
  prompt — "único canal de venta: Alkosto" ya no compite con `mandatorios`.
- **Proveedor de IA falso, determinístico** (`AI_PROVIDER=fake`,
  `services/ai-worker/app/ai/fake_provider.py`): permite un recorrido
  end-to-end real por HTTP sin red ni costo. Exclusivo de pruebas
  automatizadas — nunca demos ni producción.
- **CI levanta Postgres de verdad, y de verdad corre en frío**: el job `web`
  nunca había tenido un servicio de base de datos. Migra y siembra
  `tclkolos_test` antes de las pruebas; Node subido a 22
  (`--experimental-strip-types` lo exige). Verificado dos veces contra una
  base Postgres efímera distinta cada vez, sin ningún dato acumulado.
- **110 pruebas de integración nuevas o reescritas** en `packages/db`
  (transiciones, preguntas locales, brief manual, aislamiento, excepción por
  producto, recorrido end-to-end con proveedor falso) y **61 de dominio**.

#### Corregido

- **`ejecutarYPersistir` intentaba transicionar `processing →
  extraction_review` con el actor humano**, transición restringida a
  `'system'` en el dominio. Fallaba con "El rol admin no puede ejecutar la
  transición". Corregido: esas dos transiciones siempre las ejecuta el
  sistema, nunca el usuario que disparó la extracción.
- **`brief_field_revisions` bloqueaba también el `DELETE`** en cascada al
  borrar una campaña completa — el trigger debía impedir solo `UPDATE`.
- **`app/__init__.py` faltante en el worker** rompía `mypy app` con "No
  parent module" — bug preexistente, no relacionado con este incremento,
  corregido porque bloqueaba un gate de CI obligatorio.

#### Incidente

- **INC-001**: una prueba de integración reescrita reutilizó y borró una
  versión real y no terminal del brief de P80 al operar sobre la campaña
  compartida del seed. Los documentos fuente siguieron intactos; los campos
  extraídos y su evidencia no son restaurables de forma idéntica — se
  regenera con el pipeline corregido. Detalle completo, causa raíz y
  contención en
  [`docs/incidents/INC-001-test-data-collision.md`](docs/incidents/INC-001-test-data-collision.md).
  A partir de este incidente, `packages/db` exige `TEST_DATABASE_URL`
  (una base separada, sufijo `_test` obligatorio) para cualquier prueba de
  integración, sin fallback hacia la base de desarrollo.

#### Decisiones

- **DEC-023 a DEC-029** — anclaje de producto por nivel, versión de trabajo
  reutilizada, mandatorios vs. restricciones, fechas con precisión,
  aprobaciones documentadas sin implementar, evidencia vs. `manual_local`,
  `CampaignProduct` en el dominio. Detalle en
  [decision-log.md](docs/decisions/decision-log.md).

#### Pendiente

- **Ciclo de aprobación final** (versión hija al editar una `approved`):
  documentado en DEC-027, no implementado — siguiente incremento.
- **E7-6** (comentarios internos en el editor): diferida, ver HANDOFF §5.
- **Fechas con precisión real (DEC-026) en el editor manual de corrección**:
  la capa de extracción y la de preguntas locales ya usan el objeto
  `PrecisedDate`; `corregirCampo` (editor manual) sigue guardando texto
  plano. Ver [D0-17 §2.2](docs/product/D0-17-cierre-sprint4.md).

### Corrección posterior al checkpoint (26 de agosto de 2026)

Tras revisión del product owner, tres puntos del reporte de cierre eran
incorrectos y se corrigieron en el mismo incremento (commit posterior al
checkpoint `516de31`):

- **E7-8** (excepción por producto en un campo `compartido_con_excepcion`)
  estaba dentro del alcance aprobado y se había reportado como diferida —
  implementada ahora de verdad: motivo obligatorio, persistencia (fila nueva
  anclada al producto, nunca toca la compartida), reversión, 9 pruebas y
  verificación en vivo en el navegador.
- **`extraction.test.ts` y `brief-rules.test.ts` se habían descrito como
  "preexistentes, sin tocar en esta sesión" cuando en realidad sí forman
  parte de este incremento** (se reescribieron en la Fase D del cierre
  original). La causa real de que fallaran en frío no era su antigüedad,
  sino que dependían de datos de otra campaña; corregido — siembran sus
  propios documentos y fragmentos sintéticos. `search.test.ts` (sí
  preexistente, Sprint 3) tenía el mismo problema con un fragmento indexado;
  corregido igual.
- `ruff check .` sobre `services/ai-worker` tenía 116 errores reales —
  corregidos de verdad, sin excluir archivos.
- Verificado con dos corridas completas, cada una contra una base Postgres
  efímera **distinta**: **110/110 pruebas de `packages/db` en verde ambas
  veces**, sin residuo.

### Segunda corrección posterior al checkpoint (26 de agosto de 2026)

La corrida citada arriba como "la receta de `ci.yml`" en realidad había dado
`1 failed | 109 passed` — declarar CI en `PASS` con ese resultado fue
apresurado, y el product owner lo señaló antes de aceptarlo como cierre:

- **`pipeline.test.ts` (Sprint 2) dependía de rutas de archivo de una máquina
  de desarrollo específica** (`/Users/.../Downloads/*.pptx`) — nunca corría
  en CI, se omitía en silencio. Corregido de raíz: `fixtures/pipeline/documento-de-prueba.pptx`,
  un PPTX sintético de 3 diapositivas, versionado, generado una vez con
  `python-pptx`.
- **`ci.yml` ahora levanta un worker y un consumidor reales** (`AI_PROVIDER=fake`,
  determinístico, sin red, sin costo) antes de las pruebas — nuevo servicio
  `redis` en el job `web`, instalación de las dependencias de
  `services/ai-worker`, arranque en segundo plano con espera activa de
  `/ready`.
- **Bug real encontrado al levantarlos, sin cobertura de `pytest`** (ningún
  test importa `app.main`): la corrección anterior de `ruff check .` había
  convertido `Optional[int]` en `int | None` dentro de los modelos Pydantic
  de `app/main.py`. Pydantic v2 evalúa esas anotaciones al definir la clase
  — a diferencia de una anotación de función normal, `from __future__ import
  annotations` no lo protege ahí — y esa sintaxis rompe en el Python 3.9
  mínimo declarado del proyecto. Corregido con `Optional[int]`, documentado
  en el código para que no se repita.
- **Resultado, verificado con la receta literal de `ci.yml` contra servicios
  efímeros recién creados: cero fallas.** Única omisión, documentada:
  `extraction.test.ts › extracción contra el modelo real` (exige un
  proveedor real, no el falso) — su camino crítico lo cubre
  `end-to-end.test.ts`, que sí corre y pasa. Detalle completo en
  [D0-17 §6](docs/product/D0-17-cierre-sprint4.md#6-ci-y-reproducibilidad-desde-cero).

### Demo A y cierre del Gate INC-001B (26 de agosto de 2026)

Con la clave de OpenRouter ya renovada por el usuario en su `.env` local, se
ejecutó la extracción real de P80 de punta a punta contra la aplicación real.

#### Añadido

- **5 pruebas de regresión nuevas** (`brief-fields.test.ts`, 4 casos; 1 caso
  nuevo en `local-questions.test.ts`) que simulan un campo con `confidence`
  real antes de corregirlo/confirmarlo — el caso que ningún test anterior
  cubría, porque `crearBriefManual` siempre siembra `confidence: NULL`.

#### Corregido

- **Corregir, resolver un conflicto, declarar una excepción por producto o
  responder una pregunta local sobre un campo ya extraído con `confidence`
  no nulo violaba `brief_fields_manual_sin_confianza`** (error 500 real,
  encontrado en vivo durante Demo A al corregir un campo real de P80).
  `corregirCampo`, `resolverConflicto`, `declararExcepcionProducto` (rama de
  fila existente) y `responderPregunta` cambiaban `provenance_type` a
  `manual_local` sin poner `confidence = NULL` a la vez. Corregido en las 4
  rutas. Detalle en [D0-17 §4](docs/product/D0-17-cierre-sprint4.md).

#### Demo A — P80 real (PASS)

Extracción real vía OpenRouter (`google/gemini-2.5-flash-lite`, `USD
0.005886`, `19504 ms`, `ok_con_descartes`): 51 campos con dato, 5 sin
encontrar, 0 en conflicto, 69/69 citas verificadas literalmente contra su
fragmento fuente, 3 productos correctamente anclados sin mezclar valores (21
campos `marca_producto[].*`), una excepción por producto declarada y
verificada desde la UI (E7-8, campo `mandatorios`, producto P80), 2 preguntas
locales generadas y resueltas (una respondida con el objeto `PrecisedDate`
correcto, una descartada con justificación), los 44 campos `found` restantes
confirmados o corregidos desde la UI real hasta 0 pendientes de revisión, y
transición real `local_questions → extraction_review → internal_review` sin
relajar ninguna guarda. Detalle completo, incluida la re-verificación total
de CI tras el fix, en [D0-17 §4 y §6.1](docs/product/D0-17-cierre-sprint4.md).

#### Incidente

- **Gate INC-001B: `PASS`.** La extracción perdida en INC-001 no era
  restaurable de forma idéntica; se generó una extracción nueva con el
  pipeline corregido, verificada de punta a punta. Detalle en
  [INC-001 §7](docs/incidents/INC-001-test-data-collision.md#7-regeneración--gate-inc-001b).

---

### Sprint 2 — Fuentes documentales · 12 de agosto de 2026

Épica E4. Demo: cargar un PPT real y verlo procesarse **sin bloquear la interfaz**.

#### Verificado con material real

```
25.0 MB · la carga responde en 88 ms · 42 fragmentos · 30 diapositivas
```

El parseo tarda ~6 s, pero ocurre en el worker. La interfaz devuelve el control en 88 ms.

#### Añadido

- **Parsers con localización** *(E4-5, E4-6)*: PPTX por diapositiva —incluidas tablas, formas agrupadas y notas del presentador—, PDF y DOCX por página. Un `Fragment` sin página ni diapositiva **no se puede construir**: sin ubicación no hay evidencia citable (§9.4).
- **Validación por contenido real** *(E4-1, caso S-05)*: se leen los primeros bytes, no la extensión ni el `Content-Type`. Un ejecutable renombrado a `.pdf` se rechaza. Los OOXML se distinguen entre sí por su contenido interno, porque todos son ZIP.
- **Hash SHA-256 y detección de duplicados** *(E4-3)*: el mismo contenido con otro nombre se detecta y el mensaje nombra el archivo original.
- **Cola en PostgreSQL** con `FOR UPDATE SKIP LOCKED` *(ADR-009)*, reintentos con backoff 1/5/15 min y límite de intentos *(E4-9, E4-10)*.
- **Idempotencia**: reprocesar borra los fragmentos previos en la misma transacción que inserta los nuevos. Un índice parcial impide dos jobs activos por documento.
- **UI-06 y UI-07**: carga de fuentes y estado de procesamiento que se refresca solo mientras hay trabajo — la prueba visible de que la página sigue viva.
- **Worker resiliente** *(casos R-02, R-04)*: si la base desaparece, reconecta con backoff en lugar de morir o quedarse mudo.
- **21 pruebas nuevas** del worker (parsers y validación) y **13** de carga contra base real.

#### Corregido

Tres fallos encontrados al probar de verdad, ninguno visible en los tests unitarios:

- **La ruta de almacenamiento se resolvía contra `process.cwd()`**, así que el mismo archivo caía en directorios distintos según quién lo guardara y el worker no lo encontraba. Ahora se ancla a la raíz del monorepo.
- **El worker recibía la referencia relativa del archivo** y la usaba como ruta absoluta.
- **El sondeo dejaba una transacción abierta** cuando no había trabajo. La conexión quedaba `idle in transaction`, reteniendo el snapshot inicial: el worker arrancaba bien y **no volvía a ver ningún job**. Falla silenciosa, la peor clase.

#### Decisiones

- **DEC-017** — El reparto de presupuesto sale del alta de campaña: es un dato del brief del cliente, no de la configuración. Se conserva en el modelo; cambia quién lo aporta y cuándo.
- **ADR-009** — La cola vive en PostgreSQL, no en Redis (coherente con ADR-007).

#### Markdown como formato preferido (DEC-018)

Los briefs viven en Google Docs, que exporta a Markdown de forma nativa. Eso evita el problema de fondo del DOCX: un documento de texto no tiene páginas hasta renderizarse, así que citar "página 3" es fabricar una precisión que no existe.

```
DOCX antes:  «página 1»                                    ← inventado
Markdown:    «Brief P80 › El Reto › Desafío», línea 12     ← exacto y estable
```

- Parser de Markdown con ruta de encabezados y número de línea; ignora `#` dentro de bloques de código.
- La **sección** pasa a ser un localizador válido: la restricción de base exige *algún* localizador, no una página.
- El DOCX deja de numerar páginas y cita por encabezado; los saltos quedan como metadato.
- El texto plano no tiene firma de bytes, así que solo se acepta como Markdown si además la extensión lo declara. El principio se mantiene: **el contenido solo puede restringir, nunca ampliar**. Un script renombrado a `.pptx` sigue rechazándose.

#### Pendiente

- OCR de imágenes y PDF escaneado *(E4-7)*.
- Google Drive *(E4-2)*: la interfaz de almacenamiento está lista, faltan las credenciales. Al conectarla, un Google Doc podrá exportarse a Markdown **sin descargarlo**.

---

### Sprint 1 — Dominio y acceso · 11 de agosto de 2026

Épicas E2 (identidad y autorización) y E3 (campañas y productos).

#### Añadido

- **`packages/db`** — acceso a datos que *aplica* las políticas de `packages/domain` sin redefinirlas (ADR-008).
- **Migraciones versionadas** (`infra/db/migrations/`) con ejecutor transaccional: una migración a medias no existe. Tablas: organizaciones, usuarios, productos, campañas, `campaign_products` y auditoría.
- **`campaign_products`** — la relación campaña↔producto de DEC-016, con `rol`, `prioridad` y `participacion_presupuesto`, y restricción de unicidad por par.
- **Auditoría de solo inserción**: un trigger impide `UPDATE` y `DELETE` sobre `audit_events`. Un registro que se puede editar no es auditoría.
- **Sesión con proveedor conmutable** *(E2-1)*: `AUTH_PROVIDER=dev` para desarrollo, `oidc` para Google Workspace. En ambos casos el usuario debe existir previamente en la base — autenticarse verifica quién eres, no concede acceso.
- **Cookie firmada** con HMAC y comparación en tiempo constante; un usuario desactivado pierde acceso sin esperar a que expire.
- **Pantallas UI-01 a UI-05**: acceso, inicio operativo, lista de campañas, nueva campaña multiproducto y detalle *(E3-1 a E3-3)*.
- **Aviso de reparto de presupuesto** *(E3-9)*: en vivo al crear y en el detalle. El caso real del P80 (60/20/10 = 90%) queda visible sin bloquear.
- **17 pruebas de integración contra PostgreSQL real** *(E2-6)*, incluidas las de IDOR, escalamiento de rol e inmutabilidad de la auditoría.
- **Seed** con tres organizaciones: sin una segunda organización no se puede demostrar el aislamiento.

#### Corregido

- Para **crear** o **listar** no hay recurso cuya existencia proteger, así que la respuesta correcta es `FORBIDDEN_ROLE`, no `RESOURCE_NOT_FOUND`. Lo detectó una prueba de integración; el código estaba mal, no la expectativa.
- `NODE_ENV` deja de declararse en `.env`: Next.js lo fija por comando y declararlo manualmente rompía el build de producción.

#### Verificado en el navegador

Abrir por URL una campaña de otra organización devuelve **404**, idéntico a una campaña inexistente. La campaña del P80 muestra sus tres productos con rol y prioridad, y el aviso de que el reparto suma 90%.

#### Pendiente

- OIDC real: el adaptador está listo, faltan las credenciales de Google Workspace.
- Sin backup automático: riesgo aceptado en ADR-005.

---

### Sprint 0 — Base del repositorio · 11 de agosto de 2026

Épica E1 del backlog de MVP 1 ([D0-11](docs/product/D0-11-backlog-mvp1.md)).

#### Añadido

- **Monorepo** con npm workspaces según la estructura de §26: `apps/web`, `services/ai-worker`, `packages/{domain,ui,config,evals}` *(E1-1)*.
- **`packages/domain`** — el corazón del sistema *(E1-2)*:
  - Máquina de estados del brief: 12 estados y 25 transiciones, cada una con rol y guardas *(E8-1 adelantada)*.
  - Cuatro guardas que impiden aprobar un claim sin evidencia, avanzar con un conflicto sin resolver, aprobar con preguntas críticas abiertas y crear una traducción huérfana.
  - RBAC por rol con aislamiento entre organizaciones.
  - Errores tipados con código, sin filtrar trazas internas *(§11.6)*.
- **45 pruebas** del dominio, con cobertura funcional del 100% en transiciones de estado, aislamiento entre organizaciones e inmutabilidad de versiones aprobadas *(E13-1, E13-2, E13-3)*.
- **Worker Python** con validación de configuración al arranque y 6 pruebas, incluida una que verifica que los logs no contienen credenciales *(E1-3, caso S-10)*.
- **Docker Compose** con web, worker, PostgreSQL + pgvector y Redis, verificado de punta a punta *(E1-4)*.
- **`.env.example`** documentado, sin secretos *(E1-5)*.
- **TypeScript en modo estricto** con `noUncheckedIndexedAccess` y `exactOptionalPropertyTypes` *(E1-2)*.
- **`npm run check`** — lint, typecheck, pruebas y build en un solo comando *(E1-6)*.
- **CI** con tres jobs: dominio y web, worker Python, dependencias y secretos *(E1-7, E1-8)*.
- **Regla de lint de ADR-008**: `packages/domain` no puede importar de `apps/` ni de `services/`. Verificada con un import prohibido real *(E1-10)*.
- **README** con instalación reproducible *(E1-9)*.
- Sondas `/api/health` y `/api/ready` en la aplicación web *(E12-4 adelantada)*.

#### Decisiones registradas

- **ADR-006** — Payload CMS embebido en Next.js, no como servicio separado.
- **ADR-007** — Redis no conserva estado de negocio.
- **ADR-008** — `packages/domain` sin dependencias hacia aplicaciones.
- **DEC-013** — Datos personales de KOL en entidad separada y cifrada, decidido antes de MVP 4.
- **DEC-014** — La compensación de KOL permanece fuera del alcance, en todas las fases.
- **DEC-015** — El brief maestro es un formato propio de SmartPR; los formatos del cliente son entradas.

#### Pendiente

- Sin persistencia ni autenticación: llegan en el Sprint 1 (Épicas E2 y E3).
- Sin backup automático: riesgo aceptado en ADR-005.

---

### MVP 0 — Descubrimiento y diseño · 11 de agosto de 2026

Los 16 entregables D0-01 a D0-16. Gate aprobado por el product owner.

- 14 entregables completos, 2 parciales (D0-13 gold set al 57%, D0-14 línea base con 5 de 7 indicadores).
- Esquema del brief validado técnicamente: 6 casos prohibidos se rechazan por construcción.
- Prototipo navegable de 13 pantallas (UI-03 a UI-15).
- Backlog de 115 historias y plan de pruebas de 84 casos.
