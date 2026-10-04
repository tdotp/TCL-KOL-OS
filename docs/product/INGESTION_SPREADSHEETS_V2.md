# Ingestión ampliada y fuentes enlazadas (V2 · Fase 4)

Base: `518e048`. Decisión: DEC-045. Migraciones: `017_estado_por_resolver.sql`, `018_fuentes_enlazadas_y_localizador.sql`.

> F4 le enseña al sistema qué es una hoja de cálculo y qué es una fuente enlazada. **No** se conecta a Google ni importa influencers: eso es la Fase 5.

## 1. Modelo de fuente

```
Source  (= source_documents: campaña · organización · visibilidad · confidencialidad · estado · tipo declarado)
├── origin = file   archivo subido        file_id · mime_type · size_bytes · hash        (como hasta ahora)
└── origin = link   enlace externo        external_provider · external_id · external_url · canonical_url
```

Una restricción CHECK (`source_documents_origen_coherente`) impone qué columnas existen en cada origen: un archivo sigue exigiendo hash/tamaño/MIME y un enlace no puede llevarlos. **Por qué no una entidad superior `sources`:** obligaría a migrar las FK de `evidence` (RESTRICT, con inmutabilidad), `source_fragments` y `processing_jobs`, y a duplicar la lógica de visibilidad y permisos, sin ningún beneficio hoy. La visibilidad de la Fase 1 (`resolverAlcanceDeFuentes`, `setSourceVisibility`) se aplica tal cual a archivos y enlaces: no hay un segundo sistema.

| Estado | Significado |
|---|---|
| `pendiente` / `procesando` / `procesado` / `fallido` | Archivos, como antes. |
| `por_resolver` (nuevo) | Solo enlaces: registrado, contenido sin resolver. **No hay job** (un trigger impide encolarlo). |

## 2. Original, representación normalizada y fragmentos

```
Source
├── original              siempre conservado (archivo en almacenamiento con SHA-256; o URL registrada)
├── fragmentos            contenido procesable, cada uno con su localizador de vuelta al original
└── estructura (source_representations)   manifiesto normalizado: lo que no cabe en una lista de fragmentos
```

La representación **nunca reemplaza** al original. `obtenerRepresentacionNormalizada(actor, sourceId)` entrega las tres cosas con el mismo alcance de lectura que el resto. Hoy solo las hojas de cálculo tienen `estructura`; el Markdown/PDF/PPTX/DOCX siguen siendo «original + fragmentos». Para XLSX la estructura es: hojas (nombre, estado visible/oculta), dimensión, fila de cabecera y cabeceras, filas, celdas, fórmulas, límites y notas de lo que no se hace. No se generan embeddings ni RAG nuevos.

## 3. Localizador (`SourceLocator`)

| `kind` | Campos | Ejemplo |
|---|---|---|
| `page` | `page`, `section?`, `line?` | PDF página 3 |
| `slide` | `slide`, `section?` | PPTX diapositiva 8 |
| `section` | `section`, `line?` | Markdown «El Reto › Audiencia» |
| `sheet` | `sheet` | hoja completa |
| `row` | `sheet`, `row` | fila 14 |
| `cell` | `sheet`, `cell`, `row`, `col` | B7 |
| `range` | `sheet`, `range`, `rowStart/rowEnd/colStart/colEnd` | B7:D9 |
| `region` | `page?`/`slide?`, `x`, `y`, `width`, `height` (0–1) | región visual futura |

Decisión: **una columna `jsonb`** (`locator`) en `source_fragments` y `evidence`, validada por `source_locator_valido()` (CHECK) y espejo `validarLocalizador()` en el dominio; una tabla de casos compartida prueba que ambas coinciden. Una estructura relacional por tipo obligaría a tocar cada punto de copia de evidencia por cada nuevo tipo; con jsonb, la región visual o un nuevo formato es una extensión del validador.

**Compatibilidad legacy.** Las columnas `page`, `slide`, `section`, `linea` **se conservan** y siguen siendo lo que escriben los parsers de PDF/PPTX/DOCX/MD (no se reescribieron). Un trigger deriva `locator` de ellas cuando no se informa (`slide` > `page` > `section`); la migración completó `locator` en los fragmentos existentes sin tocar sus columnas. La evidencia **histórica no se reescribe** (la de versiones aprobadas está congelada por la migración 009): su `locator` puede ser NULL y se deriva al leer (`COALESCE(locator, derivado)`). Regla nueva en la base: una evidencia que cita un fragmento hereda **siempre** su localizador, debe ser de la **misma fuente** y no puede contradecirlo. Los fragmentos de hoja de cálculo llenan además `section` con el nombre de la hoja, para degradar con gracia en lo que aún lee solo las columnas legacy.

## 4. Hojas de cálculo (XLSX y CSV)

- **Aceptación:** XLSX por contenido real (directorio central del ZIP, no por extensión) y CSV por contenido de texto + extensión. **No** se acepta `.xls` binario ni libros con macros (`.xlsm`, `vbaProject.bin`): rechazo explícito con código (`UNSUPPORTED_SOURCE_FORMAT`, `INVALID_SPREADSHEET`) y mensaje accionable.
- **Parser:** `zipfile` + `xml.etree`, sin dependencias nuevas. Lee solo partes conocidas (`workbook`, relaciones, `sharedStrings`, `styles`, cada hoja); nada se extrae al disco.
- **Cabeceras:** la primera fila con ≥ 2 celdas, todas texto, y datos debajo. Las filas anteriores (títulos) se nombran por letra de columna. Duplicados se desambiguan («Fecha», «Fecha (2)»). Es una heurística declarada: queda en el manifiesto (`headerRow`, `headers`). Una hoja con varias tablas usa la cabecera de la primera.
- **Fragmentos:** filas **contiguas** empaquetadas hasta ~1.200 caracteres o 8 filas; un hueco corta el fragmento para que el rango sea exacto. Texto: `Hoja «Influencers» · filas 10–14` y, por fila, `Nombre: Valentina Rojas` (cabecera → valor). Localizador `range` (`A10:G14`); `metadata.filas` lista las filas reales. Una hoja de 10 000 filas son cientos de fragmentos, no uno.
- **Valores:** fechas (según el formato de número, calendario 1900/1904) → ISO 8601; números enteros tal cual y decimales a 15 cifras significativas (sin ruido binario); booleanos `TRUE`/`FALSE`; errores como texto; celdas vacías omitidas; espacios y saltos colapsados. Se guarda el **valor**, no el formato visual (0,047 no se convierte en 4,7 %).
- **Fórmulas:** nunca se evalúan: se lee el último valor calculado guardado; sin valor guardado la celda se omite y se cuenta (`formulasWithoutCachedValue`).
- **Hojas ocultas:** se procesan y se marcan (`oculta` en cada fragmento y `hiddenSheets` en el manifiesto); la visibilidad hacia TCL se decide por fuente, como siempre.
- **No se leen:** comentarios, imágenes, gráficos, vínculos externos ni formato.

## 5. Seguridad y límites

| Riesgo | Medida |
|---|---|
| MIME spoofing | Tipo por contenido (firma ZIP + nombres del directorio central), no por extensión ni `Content-Type`. |
| Macros | Rechazo de `vbaProject.bin` y hojas de macros. |
| ZIP bomb | Antes de leer: tamaño descomprimido (≤ 150 MB), nº de entradas (≤ 5 000) y razón de compresión (≤ 200×); al leer: tope real por parte (el tamaño declarado puede mentir). Se comprueba al subir (TypeScript) y en el worker (Python), con los mismos valores. |
| XML hostil | Se rechaza `<!DOCTYPE`/`<!ENTITY` (billion laughs, XXE) antes de parsear. |
| Rutas | Se rechazan entradas con `..`, `/` inicial o `\`; nada se extrae. La extensión del archivo guardado se restringe a 1–10 alfanuméricos (`extensionSegura`): antes pasaba lo que viniera tras el último punto del nombre. |
| Libro enorme | Límites: 30 hojas, 20 000 filas con datos por hoja, 500 000 celdas con datos, 2 000 000 de celdas recorridas, 50 MB de carga (`MAX_UPLOAD_MB`). Lo que los excede se **rechaza entero**, no se trunca en silencio (evidencia incompleta que parece completa es peor que ninguna). |
| SSRF / URLs | Registrar ≠ descargar: no hay `fetch` en la ruta. Solo `https`, host **exacto** `docs.google.com` / `drive.google.com`, sin credenciales ni puerto; se rechazan IPs, `localhost`, sufijos y homógrafos. La auditoría guarda la URL canónica (un enlace de Drive puede traer `resourcekey`). |
| Contenido no confiable | Todo texto de una hoja es dato: nunca se interpreta como instrucción ni como fórmula (en CSV, `=1+1` es texto). |

**No hay sandbox nuevo:** el parser corre en el worker existente, sin red y sin ejecutar nada del archivo; los límites acotan memoria y tiempo. Un fallo determinista (libro inválido o fuera de límites) deja el job `fallido` de inmediato, sin gastar los reintentos con backoff; los fallos transitorios conservan el reintento 1/5/15 min.

## 6. Enlaces (sin red)

`registerLinkedSource(actor, { campaignId, url, title? })`: mismos permisos que cargar una fuente (`source:upload`); la campaña debe ser de la organización; `analizarEnlaceDeFuente` identifica proveedor (`google_sheets`, `google_docs`, `google_slides`, `google_drive_file`, `google_drive_folder`), `externalId` estable y URL canónica sin llamadas externas. Deduplicación por `UNIQUE (campaña, URL canónica)`: `/edit`, `?usp=sharing` o `/u/0/` dan el mismo enlace; **dos pestañas (`gid`) del mismo libro son enlaces distintos** (no se fusionan recursos distintos). Carrera: una sola gana (`SOURCE_ALREADY_EXISTS`). Auditoría `source.link_register` con origen `ui`. `retrySource` rechaza un enlace (no hay qué reprocesar).

## 7. Cambios en procesamiento, búsqueda y evidencia

- **`processing_jobs`:** sin cambios de esquema; solo archivos (trigger). El worker guarda fragmentos + estructura en la misma transacción (idempotente) y audita `source.ingest_completed` / `source.ingest_failed` con origen `system` y sin actor.
- **Búsqueda:** `buscarEvidencia` (vectorial) devuelve el `locator`; los fragmentos de hoja participan del mismo índice de embeddings (`indexar_documento` es agnóstico del formato). Nueva `buscarTextoEnFuentes`: coincidencia literal (sin IA) con el mismo alcance y visibilidad, que permite buscar «Valentina» y llegar a «hoja Influencers, rango A10:G14».
- **Evidencia:** `verCamposDeVersion` y el workspace devuelven `locator`; el worker de extracción recibe el localizador y cita «hoja «X», rango B7:D9».

## 8. Imágenes (qué pasa hoy)

PNG/JPEG se aceptan por firma, se guardan íntegros (hash) y quedan `procesado` de inmediato, **sin job, sin fragmentos y sin texto**; la carga avisa que falta OCR. No son buscables ni citables. La extracción visual **sigue pendiente**; el localizador `region` está definido y validado para cuando exista, pero ningún parser lo produce.

## 9. Puntos de extensión para la Fase 5

> **Resuelto en la Fase 5** (DEC-046): la resolución del enlace, los snapshots, el esquema del Sheet y la importación están en [`GOOGLE_SHEETS_IMPORT_V2.md`](GOOGLE_SHEETS_IMPORT_V2.md). Lo que sigue es la intención original de la Fase 4; no se levantó el trigger a ciegas, se estrechó a `google_sheet_sync` para `google_sheets`.

registrar Google Sheet (**hecho**: `registerLinkedSource`, `externalId`, `gid`) → resolver mediante una integración (levantar el trigger de jobs para `origin='link'` y escribir fragmentos con `locator` de hoja, mismo contrato que XLSX) → validar esquema sobre `estructura.sheets[].headers` → `normalizeHandle` → `buscarInfluencerPorCuenta` → crear/asociar. El manifiesto, el localizador y `por_resolver → procesado` ya existen.

## 10. Riesgos y deuda

- La detección de cabecera es una heurística (una hoja con varias tablas usa la primera cabecera).
- Se guarda el valor, no el formato (porcentajes, moneda y unidades se pierden); una celda con número formateado como texto conserva el texto.
- Un libro de > 20 000 filas con datos se rechaza (hay que dividirlo); el límite es una decisión de seguridad, ajustable.
- `.xls` binario, libros protegidos con contraseña y `.xlsm` no se soportan (mensaje explícito).
- CSV: delimitador por heurística de consistencia entre líneas; solo UTF-8; la hoja se llama «CSV» (el worker no conoce el nombre original).
- La evidencia citada desde un fragmento apunta al rango del fragmento (hasta 8 filas), no a la fila exacta.
- La interfaz solo ajustó tipos mínimos (columnas `mime_type`/`size_bytes` nullables, estado `por_resolver`) y el `accept` del selector de archivos; no hay UI de Excel, preview ni selector de hojas.
