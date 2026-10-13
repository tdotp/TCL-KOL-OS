# Google Sheet de influencers — snapshots, importación y resolución (V2 · Fase 5)

Base: `caf687d`. Decisión: DEC-046. Migraciones: `019_snapshots_fuentes_enlazadas.sql`, `020_importacion_influencers.sql`.
Contrato del Sheet para quien lo prepara: [`INFLUENCER_SHEET_V1.md`](INFLUENCER_SHEET_V1.md).

```
LinkedSource (origin=link, google_sheets)
  └─ syncGoogleSheetSource ──► job google_sheet_sync ──► worker ──► GoogleSheetsProvider ──► sheets.googleapis.com
                                                                        │
                                          Snapshot N (inmutable) ◄──────┘   hash canónico, rejilla, fragmentos
                                              │   current_snapshot_id (solo avanza)
                                              ▼
              validateInfluencerSheet (esquema V1) ─► Plan (ligado a UN snapshot) ─► Registros
                                              │
                         apply (Fase 3: crearInfluencer / agregarCuenta / asociarInfluencerACampana /
                                asociarProductoAInfluencer) ─► Binding + Efectos (procedencia)
                         resolveImportRecord (humano) ─► Resolución (append-only) ─► se aplica al registro
```

## 1. Frontera de red: LinkedSource ≠ fetch genérico

- La **única** salida de red hacia un proveedor externo es `services/ai-worker/app/google_sheets.py`.
  `packages/db` y `packages/domain` no hacen red (los tests de la Fase 4 siguen comprobándolo).
- Hosts permitidos: `sheets.googleapis.com` (API) y `oauth2.googleapis.com` (token de la cuenta de servicio). Nada más:
  `validar_url_de_api` exige `https`, host exacto, sin puerto ni credenciales y ruta `/v4/spreadsheets/`.
- La petición **se construye desde `external_id`**, ya validado (`^[A-Za-z0-9_-]{20,128}$`); **nunca** desde
  `external_url`. Un id con `/`, `?`, `@` o `.` no pasa el validador, así que no puede cambiar host ni ruta.
- Sin redirecciones (`allow_redirects=False`), tiempo máximo (10 s conexión / 60 s lectura), tamaño máximo de
  respuesta (64 MiB) y errores sanitizados (el cuerpo de error de Google nunca llega al mensaje).
- **El trigger de Fase 4 no se elimina: se estrecha.** `processing_jobs_solo_archivos` se sustituyó por
  `processing_jobs_tipo_coherente`: `source_ingest_file` solo para `origin = file`, `google_sheet_sync` solo para
  `origin = link` **y** `external_provider = google_sheets`. Cualquier otro enlace (Docs, Slides, Drive…) sigue sin poder
  encolar nada, y el tipo/fuente de un job no se reasigna.

## 2. Autenticación

**Cuenta de servicio (server-to-server), alcance `spreadsheets.readonly`.** Encaja con lo ya previsto por DEC-006 y
`.env.example` (`GOOGLE_SERVICE_ACCOUNT_KEY_PATH`), y no exige una arquitectura OAuth interactiva que el repositorio no
tiene. El Sheet se comparte con la cuenta de servicio como **lector**.

- La clave vive solo en un archivo **fuera del repositorio** cuya ruta llega por entorno. No está en Postgres, ni en
  `audit_events`, ni en logs ni en mensajes de error (las pruebas lo comprueban, incluso con una clave corrupta).
- La firma del JWT y el intercambio del token los hace la librería oficial **`google-auth`** (no hay criptografía
  manual). `requests` es su transporte. Son las únicas dependencias nuevas, fijadas en `requirements.txt` y usadas solo
  detrás de `google_sheets.py`.
- `token_uri` de la clave debe ser exactamente `https://oauth2.googleapis.com/token`; otro destino se rechaza.
- Un 403 indica con quién compartir el Sheet (el correo de la cuenta de servicio **no** es un secreto).
- **Sin escritura:** ningún alcance de escritura existe en el módulo (hay una prueba que lo comprueba).
- Sin credenciales (entorno de CI/desarrollo): la sincronización falla de forma **determinista**
  (`GOOGLE_NOT_CONFIGURED`), sin reintentos.

**Pruebas sin Google real.** El proveedor se prueba con un transporte controlado. Para las pruebas de punta a punta con
el worker real existe `GOOGLE_SHEETS_FIXTURE_DIR`: sirve respuestas de la API desde archivos JSON **solo si la base se
llama `*_test` y `ENVIRONMENT` no es `production`**; en cualquier otra base la variable se ignora. Se ejercita el
proveedor completo (id, errores, conversión de celdas, hash) y solo se omite el salto HTTP. Un *smoke test* contra una
cuenta real no forma parte de la suite ni del CI (no se ejecutó).

## 3. Snapshots

| Tabla | Qué guarda |
|---|---|
| `source_snapshots` | Una lectura: `sequence` (1, 2, 3…), `fetched_at`, `content_hash` (SHA-256 canónico), `hash_version`, `external_revision`, metadatos (título, pestañas con `gid`), `structure` (manifiesto con el contrato de la Fase 4). |
| `source_snapshot_rows` | La rejilla: una fila por fila de la hoja, `cells` = `[{col, text, type}]`. Permite validar, reconstruir filas y comparar sin depender del texto de los fragmentos. |
| `source_fragments.snapshot_id` | Fragmentos con localizador `range` (mismo contrato que XLSX); `UNIQUE (snapshot_id, ordinal)`. |
| `source_sync_runs` | Estado **técnico** de cada sincronización y quién la pidió. |

**Un solo modelo tabular.** El worker convierte Google a `Hoja`/`Celda` (`app/parsers/tabular.py`) y reutiliza
`construir_resultado`: XLSX, CSV y Google Sheets convergen en la misma representación. Valores efectivos (nunca se
ejecutan fórmulas; se cuentan), fechas a ISO 8601, números con la misma conversión que XLSX.

**Archivos locales intactos.** Las fuentes `origin = file` conservan su modelo (sin snapshots, reemplazo idempotente al
reprocesar). Un trigger impone la coherencia: un enlace solo tiene fragmentos de snapshot; un archivo, ninguno.

### Snapshot vigente (`source_documents.current_snapshot_id`)

Se cambia con **un `UPDATE` atómico**, dentro de la misma transacción que inserta snapshot, filas y fragmentos
(`runner._insertar_snapshot`, con la fila de la fuente bloqueada). Además lo impone la base: el nuevo debe tener
fragmentos guardados y su `sequence` debe ser **mayor** que la del vigente (no se retrocede ni se deja la fuente sin
vigente). Si cualquier paso falla, no queda snapshot ni cambia el vigente: **un snapshot fallido nunca reemplaza al último
válido** (el fallo queda en `source_sync_runs` con su código).

### Inmutabilidad histórica

Triggers: ningún `UPDATE`/`DELETE` sobre `source_snapshots` ni `source_snapshot_rows`; los fragmentos de un snapshot no
se modifican ni se borran (única excepción: la columna `embedding`, que es derivada). El único bypass es el de siempre
(`inmutabilidad_bypass_activo()`: bandera de sesión **y** base `_test`), usado por la limpieza de pruebas. La evidencia
que cita un fragmento del snapshot 1 sigue apuntando a él aunque exista el 7 (prueba específica); `evidence.fragment_id`
no se desengancha porque ningún camino borra fragmentos de snapshot (a diferencia del reemplazo de archivos, que la
Fase 5 **no** reutiliza).

### Sincronización sin cambios

Si el hash canónico de la lectura coincide con el del snapshot **vigente**, no se crea otro: la ejecución termina
`unchanged` apuntando al vigente y queda auditada (`source.sync_unchanged`). Se eligió esto frente a «registrar un
snapshot equivalente» para no acumular versiones históricas inútiles. Si el contenido vuelve a uno anterior (A → B → A)
se crea un snapshot nuevo (otra lectura, con su `fetched_at`) con el mismo hash que el primero.

El hash cubre pestañas (nombre, `gid`, estado) y, por fila, columna/tipo/texto; **excluye** título, orden de pestañas,
fecha de lectura y fórmulas. Google Sheets v4 **no expone una revisión estable del contenido** (haría falta la API de
Drive con otro alcance): `external_revision` queda `NULL` y el hash decide la igualdad.

### Concurrencia, reintentos y errores

- Como máximo **una** sincronización activa por fuente: índice parcial en `source_sync_runs` + el índice de job activo;
  la solicitud bloquea la fila de la fuente. Una ejecución activa sin avanzar 30 min se da por abandonada
  (`SYNC_ABANDONED`) para no bloquear la fuente si cayó el worker.
- Transitorios (timeout, red, 429, 5xx, 403 por cuota): backoff 1/5/15 min de la cola, respetando `Retry-After` (con
  techo de 15 min).
- Deterministas (clave inválida, 401, 403, 404, pestaña inexistente, libro vacío o fuera de límites): `failed` sin
  gastar reintentos.
- Estado de la fuente: si nunca tuvo snapshot y falla → `fallido`; si ya tenía uno, sigue `procesado`.
- **Fetch/ingest OK ≠ esquema de negocio válido.** Un Sheet leído correctamente pero con una columna faltante es un
  snapshot válido; el plan queda `schema_invalid`, no la integración.

## 4. Búsqueda y lecturas

Todo lector del «contenido de la fuente» usa el snapshot **vigente** (`fragment-scope.ts`): búsqueda vectorial y
textual, extracción, `getFragments`, `obtenerRepresentacionNormalizada` (que ahora devuelve también `snapshot`), el
recuento de la lista de fuentes y el índice de embeddings del worker. Los snapshots históricos ya NO tienen lector de
producción (F10 retiró `getSnapshotFragments`, `getSourceSnapshot` y `listSourceSnapshots`): su texto sigue en la base
(inmutable) pero ningún camino de la aplicación lo devuelve.

## 5. Plan de importación

`prepareInfluencerImport(actor, {campaignId, sourceId, snapshotId?})`:

1. Valida el esquema V1 sobre la rejilla del snapshot (`validateInfluencerSheet`, puro).
2. Evalúa cada registro con los hechos **actuales** del dominio (solo lectura).
3. Compara por clave estable con el plan anterior y señala las claves vinculadas que ya no aparecen.
4. Persiste plan y registros. **No muta Influencers ni participaciones.** Idempotente: un snapshot, un plan
   (`UNIQUE (source_id, snapshot_id)`); si cambia el Sheet hay otro snapshot y otro plan, y los pendientes anteriores
   quedan `superseded`.

Estados de negocio del plan: `schema_invalid · ready · needs_resolution · applied · superseded`. Por registro:
`actionable · blocked · invalid · review · applied · ignored`. El estado técnico (sincronización) vive aparte.

El plan guarda el informe de validación (sin valores del Sheet), el resumen y, por registro: ubicación (rangos del
snapshot), columnas futuras presentes (**solo nombres**), cambio (`new · unchanged · changed · missing_from_source`, con
qué cambió), identidad, participación y productos.

## 6. Matching determinístico

Orden: **binding previo → coincidencia exacta (plataforma + `normalizeHandle`) → crear → decisión humana.** Se usa
`buscarInfluencerPorCuenta` (Fase 3). Sin fuzzy, sin embeddings, sin IA, sin Levenshtein; el nombre **nunca** decide.

| Caso | Resultado |
|---|---|
| A. binding previo | `matched_binding` (se valida que nada lo contradiga) |
| B. una sola persona dueña de las cuentas | `matched_existing` (+ cuentas nuevas aditivas) |
| C. ninguna cuenta existe | `create_new` |
| D. cuentas de personas distintas | `ambiguous` |
| E. cuenta de otra persona / persona ya vinculada a otra clave | `conflict` |
| F. nombre parecido | **no cuenta** |
| cuenta nueva en plataforma ya ocupada | `needs_resolution` (`account_change`) |
| participación retirada | `needs_resolution` (`participation_retired`); no se reactiva sola |

Producto: se compara el `model` normalizado con los `campaign_products` **de la campaña** (misma regla en toda la
base). Uno → `assign`; ninguno → `unresolved`; varios → `ambiguous`; ya asignado → `unchanged`; el influencer trabaja
un producto que el Sheet no declara → `product_change` (nunca reemplaza: se **añade** por decisión humana). Un producto
de otra campaña no está entre las opciones y la base lo impide (FK compuesta).

## 7. Aplicar y resolver

`applyInfluencerImport(actor, planId)`: por registro, con el estado **actual** (la decisión de aplicar nunca se toma con
el estado viejo del plan), usa los casos de uso de la Fase 3 **a nombre de la persona que importa**:
`created_by` humano y su correlación; `system` no muta (`created_by NOT NULL` no se relaja). Cada caso de uso es atómico;
el binding, los efectos y la auditoría del registro se confirman juntos después, y reaplicar reanuda sin duplicar (lo
creado se reconoce por coincidencia exacta). El plan se bloquea mientras se aplica: dos aplicaciones simultáneas se
serializan.

`resolveImportRecord(actor, recordId, decision)`: `use_existing_influencer`, `create_new_influencer`, `choose_product`
(referencia del Sheet → producto de la campaña) o `ignore_record`. Solo personas con `influencer:manage` +
`campaign_influencer:manage`; la decisión es un hecho append-only (quién, cuándo, qué, por qué), se audita y se
**materializa de inmediato** sobre ese registro (creando el binding). Validaciones: no se mueve una cuenta que es de otra
persona, no se reasigna una clave vinculada, no se duplica una persona que ya existe, y el producto debe ser de la campaña.
Para un cambio de cuenta, la persona confirma «usar a este mismo influencer» y la cuenta nueva se **añade** (la anterior
no se borra: no existe baja de cuentas).

**Sin `ProposedAction`.** Importar o asociar a una persona iniciada por Cuenta no equivale a aprobar un brief. No se creó
un segundo HITL; tampoco se debilitó el existente: nada de lo que `system`/`chat` hace puede resolver una ambigüedad. Si
una acción futura fuera realmente crítica (p. ej. retirar masivamente), debe reutilizar `proposed_actions`.

### Qué nunca ocurre solo
Retirar un `CampaignInfluencer` porque desaparece del Sheet; desasignar un producto; reemplazar un producto; pisar el
nombre global del Influencer; mover una cuenta; reactivar una participación; fusionar personas.

## 8. Binding y procedencia

`influencer_source_bindings`: `(fuente, clave)` → `(influencer, campaign_influencer)`, con `bound_via`
(`account_match · created · human_existing · human_new`), el snapshot y registro de origen y sus rangos. Inmutable;
`UNIQUE` por clave y por participación; el trigger impide mezclar un influencer con la participación de otro.
`influencer_import_effects` enlaza cada entidad que el registro creó o reutilizó (influencer, cuenta, participación,
asignación de producto).

`getParticipationOrigin(actor, campaignInfluencerId)` responde «¿por qué existe este CampaignInfluencer?»:
participación → binding → registro → plan → snapshot N → hoja y rango (`Influencers!A3:E3`) → fuente; y lo mismo para
cada producto asignado. No depende de reconstruirlo desde `audit_events`.

## 9. Campañas cerradas (decisión que dejó pendiente la Fase 3)

`campaigns.status` real: `activa | archivada | cancelada`. En una campaña **no activa**: se puede sincronizar (leer y
conservar snapshots), comparar, planear y consultar; **no** se puede aplicar un plan ni resolver un registro
(`RESOURCE_CONFLICT`, `reason = campaign_not_active`). La guarda vive en la importación; los casos de uso de la Fase 3 no
se modificaron, así que asociar a mano en una campaña cerrada sigue permitido (decisión de esa fase, intacta).

## 10. Permisos y aislamiento

| Rol | Sincronizar | Leer snapshots / ejecuciones / plan / procedencia | Preparar plan | Aplicar / resolver |
|---|---|---|---|---|
| admin · director · consultor | sí (`source:process`) | sí | sí | sí |
| operativo | no | **sí** (`source:read`, `influencer:read`, `campaign_influencer:read`) | no | no |
| analista · legal | no | snapshots y ejecuciones sí (`source:read`, como cualquier fuente interna); plan y procedencia **no** (sin `influencer:read`) | no | no |
| cliente | no | **no**: nunca ve snapshots, ejecuciones, planes ni matching, ni siquiera de una campaña visible | no | no |
| `system` | no pide ni decide | — | no | **no** |

No se añadió ninguna acción nueva a la matriz de permisos. Aislamiento: todas las tablas llevan `organization_id` y
claves compuestas hacia campaña, fuente, snapshot, influencer y producto de campaña; un recurso ajeno responde
`RESOURCE_NOT_FOUND`. Probado por API y por SQL directo.

## 11. Auditoría

`source.sync_request` · `source.sync_snapshot_created` · `source.sync_unchanged` · `source.sync_failed` (el worker, con
origen `system`, registra `initiatedBy`) · `influencer_import.schema_validate` · `influencer_import.plan_create` ·
`influencer_import.record_apply` · `influencer_import.record_resolve` · `influencer_import.apply`, más los eventos de la
Fase 3 (`influencer.create`, `campaign_influencer.associate`, `…product_assign`) con origen y correlación. Nunca llevan
credenciales, tokens ni URLs originales (solo `externalId` y rangos).

## 12. API reutilizable (sin HTTP ni UI)

`syncGoogleSheetSource` · `getSyncRun` · `listSyncRuns` ·
`validateInfluencerSheetSnapshot` · `prepareInfluencerImport` · `getImportPlan` ·
`listImportPlans` · `applyInfluencerImport` · `resolveImportRecord` · `compareSheetSnapshots` ·
`getParticipationOrigin`. Ninguna depende de `FormData`: el chat de la Fase 6 las llamará tal cual.

## 13. Riesgos y deuda

- **Sin *smoke test* contra Google real** (no hay credenciales en este entorno): lo cubierto es el proveedor completo
  con transporte controlado. Falta validar en vivo permisos de la cuenta de servicio, cuotas y el comportamiento real
  de `includeGridData`/`fields` con libros grandes.
- `includeGridData` descarga la rejilla completa (hasta 64 MiB de JSON); libros mayores se rechazan (no se truncan).
- Sin sincronización programada ni autónoma: exige decidir un actor de servicio (por eso no se relajó `created_by`).
- Sin baja de cuentas ni fusión de personas: un handle que cambió solo se **añade**.
- `aplicarRegistro` no es una única transacción (los casos de uso de la Fase 3 son atómicos por separado): si el proceso
  muere a mitad, reaplicar completa el registro sin duplicar, pero la procedencia de lo ya creado puede quedar como
  `existing` en vez de `created`.
- Los planes se calculan con el estado del dominio al planear; al aplicar se re-evalúa. Un registro que cambió de
  clasificación entre ambos momentos no avanza si ahora es ambiguo/conflicto.
- Python 3.9 de desarrollo emite avisos de fin de vida de `google-auth`; el contenedor usa 3.11.
- Una fila con `__FILA_n` (sin clave) es siempre inválida: no hay forma de vincularla.
- Documentos históricos (`HANDOFF.md`, D0-08…) siguen sin reflejar V2.
