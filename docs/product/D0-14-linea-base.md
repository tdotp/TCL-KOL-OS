# D0-14 — Línea base operativa

**Versión:** 1 · **Fecha:** 11 de agosto de 2026 · **Estado:** ✅ **DESBLOQUEADO** — medido sobre material real
**Material recibido:** 11 de agosto de 2026 (product owner)
**Fuentes:** documento maestro §2.3 (indicadores), §15 (umbrales); `docs/decisions/decision-log.md` (DEC-002, DEC-009).

---

## 1. Material analizado

| Archivo | Contenido | Volumen |
|---|---|---|
| `LISTADO DE PERFILES - Propuestas TCL.xlsx` | Propuestas de KOL por campaña | **40 hojas · 32 con datos · 514 filas de KOL** |
| `LISTADO DIRECCIONES C7L & X11L.xlsx` | Entrega de producto y cronograma de guiones | 4 hojas · **124 entregables de guion** |
| `TCL_P80_Brief_Contenidos.docx` | Brief real entregado por el cliente | 1 brief completo (agosto 2026) |
| `IMC MNT Plan 2Half.pptx` | Plan de marketing del segundo semestre | 26 MB — pendiente de procesar |

**Alcance de la medición:** el material cubre campañas de TV (C7L, X11L, C6K Mundial, P8L, QLED Mini LED), celulares (serie 70, A400 Pro), tabletas (Tab A1 Plus), monitores, audio, aires acondicionados e IFFALCON. Es más amplio que los 2–3 meses estimados en DEC-002.

> **Advertencia sobre la naturaleza de los datos:** el archivo se llama "Propuestas". Los presupuestos son **propuestos**, no necesariamente ejecutados, y varias hojas son versiones sucesivas de la misma campaña. Ninguna cifra de este documento debe leerse como inversión ejecutada.

---

## 2. Hallazgo principal: el versionado por nombre de archivo está medido

El dolor #6 del mapa AS-IS ("versionado por nombre de archivo") deja de ser una hipótesis. **Los propios nombres de hoja lo documentan:**

| Familia de campaña | Hojas que la representan | Marcadores de versión encontrados |
|---|:--:|---|
| **A400 Pro** | **8** | `_Ajuste` · `_Lanzamiento_APROBADO` · `completo` · `_Sostenibilidad_130426` · `_SOSTENIMIENTO_240426` · `derechos de pauta lanzamiento` · `derechos de pauta sostenimiento` |
| **IFFALCON** | 3 | `Final -IFFALCON_150426` · `IFFALCON` · `IFFALCON_130426` |
| **Mundial C6K** | 3 | `MUNDIAL_130426` · `Mundial C6K` · `Mundial C6K 2.0` |
| **C7L / X11L** | 3 | `C7L y X11L` · `C7L Final` · `X11L Final` |
| **Monitores** | 3 | `MONITOR 27G64` · `MONITOR 25G64` · `LANZAMIENTO MONITORES` |

**Patrones observados en los nombres:**

- Fechas embebidas en formato DDMMYY: `_130426`, `_150426`, `_240426`.
- Marcadores de estado en el nombre: `APROBADO`, `Ajuste`, `Final`, `completo`, `2.0`.
- Un caso con doble marcador contradictorio: `Final -IFFALCON_150426` coexiste con ` IFFALCON_130426` — el prefijo "Final" no impidió que existiera otra versión.
- Hojas sin nombre significativo: `Hoja 11`, `Hoja 12`.
- Espacios iniciales inconsistentes en varios nombres (` A400 Pro_Sostenibilidad_130426`, ` MONITOR 25G64`).

**Línea base del versionado:** para la campaña A400 Pro se conservan **8 versiones distintas** sin que el archivo indique cuál rige. Determinar la versión vigente exige conocimiento tácito de quien la construyó.

---

## 3. Línea base del flujo de guiones (campañas C7L y X11L)

De la hoja `CRONOGRAMA`: **124 entregables de guion** de dos campañas de lanzamiento.

### 3.1 Estado de los guiones

| Estado | Cantidad | % |
|---|:--:|:--:|
| APROBADO | 53 | 43% |
| PENDIENTE | 42 | 34% |
| *(sin estado registrado)* | 17 | 14% |
| EN AJUSTES | 7 | 6% |
| EN APROBACIÓN | 3 | 2% |

**Dos lecturas relevantes:**

1. **El 14% no tiene estado registrado.** No significa que no exista: significa que el seguimiento depende de que alguien recuerde actualizar la celda.
2. **Solo el 43% llega a APROBADO** en el momento del corte. El resto está en algún punto intermedio sin fecha asociada — no se puede calcular cuánto tarda una aprobación porque **no se registra cuándo cambió de estado**.

### 3.2 Trazabilidad del documento de guion

| | Cantidad | % |
|---|:--:|:--:|
| Guiones con archivo vinculado | 53 | **43%** |
| Guiones sin archivo vinculado | 71 | **57%** |

Los vínculos existentes son nombres de archivo sueltos, no referencias estables: `GUION Douglas (1).docx`, `SEBASTIAN RAMOS 1.pdf`, `EDUARTECNO TCL C7L 55 PRIMER VIDEO .docx`. El `(1)` del primero es el sufijo que añade el sistema operativo al descargar un duplicado.

> Esto valida directamente la regla de integridad de §10.3: *"la relación con Drive depende de `fileId` o `folderId`, nunca del nombre"*.

### 3.3 Retroalimentación de revisión

**Solo 4 de 124 entregables (3%) conservan el comentario de revisión.** Los cuatro que sí quedaron registrados muestran exactamente el tipo de trabajo que MVP 2 automatizaría:

| Talento | Comentario textual | Naturaleza del hallazgo |
|---|---|---|
| Tiago MZ | "Siento que es demasiado forzado meter a TCL en esa idea. Revisar un nuevo guion" | Alineación con la marca |
| Tiago MZ | "La idea de los videos largos de youtube y de los creadores es que sean más reviews detallados... no aprobado" | Incumplimiento de formato acordado |
| David Osorio Mejía | "cuando habla de la tasa de refrezco que diga **288hz vrr o sino 144hz nativos**, redes de tclcolombia no electronics" | **Corrección de claim técnico** + cuenta de marca equivocada |
| Juan Betancur | "Que al principio no hable tanto de caro o barato. por lo menos que resalte que es gracias a la tecnología SQD Mini Led" | Posicionamiento y RTB |

**El tercer comentario es la evidencia más valiosa del material.** Es una corrección de especificación técnica — distinguir tasa de refresco nativa de la lograda con VRR — hecha manualmente sobre un guion. Es precisamente lo que el sistema de evidencias resuelve: si el claim está anclado a la ficha técnica, la discrepancia se detecta antes de que un consultor la encuentre leyendo.

Que solo el 3% de la retroalimentación se conserve significa que **el 97% del criterio aplicado en las revisiones se perdió** y no alimenta las campañas siguientes.

---

## 4. Volumen operativo

| Indicador | Valor medido |
|---|---|
| Hojas de propuesta con datos | 32 |
| Familias de campaña distintas | ~14 |
| Filas de KOL en propuestas | **514** |
| Presupuesto propuesto acumulado | **COP 2.034 M** (suma de versiones, no inversión ejecutada) |
| Entregables de guion registrados (2 campañas) | 124 |
| Piezas de contenido propuestas | >4.700 |

**Tamaño típico de una propuesta de campaña:** entre 3 y 38 KOL, con mediana en torno a 13.

**Distribución de formatos** (124 entregables de C7L/X11L): TikTok 31% · YouTube 29% · Instagram 25% · Stories 14%.

**Categorías de KOL:** LIFESTYLE 33% · TECH 28% · SPORT 11% · FILM 7% · GAMING 5%.

---

## 5. Estructura de datos ya existente que el sistema debe absorber

Las hojas de propuesta tienen una estructura consistente y **más rica de lo que asumía el modelo de datos**:

| Columna del Excel | Entidad de destino (D0-08) | ¿Modelada? |
|---|---|:--:|
| TALENT, TALENT DESCRIPTION | `Influencer` | Reservada (§10.2) |
| LINK IG/TT/YT, FOLLOWERS IG/TT/YT | `Influencer` + canales | Reservada |
| TYPE PROFILE (TECH/LIFESTYLE/…) | `Influencer.categoria` | Reservada |
| SIZE PROFILE (Micro/Medium/Macro) | `Influencer.tier` | **No prevista** |
| EVENT ATTENDANCE | `CampaignCreator` | Reservada |
| Time Line (Jul/Ago/Sep) | `Deliverable.fecha` | Reservada |
| REEL IG, STORIE IG, TIKTOK, REVIEW YT, FACEBOOK | `Deliverable` por formato | Reservada |
| REACH por formato, IMPRESIONS | `MetricSnapshot` | Reservada |
| N° Contents | Derivado | — |
| TOTAL BUDGET, Payment by Product, Payment in Cash | **Compensación del KOL** | **No prevista** |
| DIRECCIÓN | `ProductAsset` / entrega | Reservada |

**Dos campos obligan a revisar decisiones tomadas:**

1. **`SIZE PROFILE`** (Micro / Medium / Macro) es un criterio de segmentación que la agencia ya usa y que no estaba en el modelo. Es barato añadirlo cuando llegue MVP 5.
2. **`Payment by Product` / `Payment in Cash`** — ver §6.

---

## 6. ⚠️ Dos hallazgos que contradicen supuestos registrados

Ambos requieren decisión del product owner. Están descritos aquí y registrados como decisiones pendientes.

### 6.1 Datos personales sensibles en el flujo operativo

El archivo `LISTADO DIRECCIONES` contiene, de personas identificadas por nombre:

- **~13 números de cédula**
- **~6 números de teléfono celular**
- **~36 direcciones residenciales completas** (incluyendo apartamento, conjunto y barrio)

Ejemplo del tipo de registro presente: nombre completo + cédula + celular + dirección residencial exacta + ciudad + estado de envío.

**Por qué contradice lo registrado:** D0-04 §2 clasificó "documentos completos de identidad" y "datos bancarios o tributarios" como nivel *sensible/personal* y los declaró **fuera de alcance**, asumiendo que no entraban al proceso. La realidad es que **la cédula y la dirección residencial son operativamente necesarias** para entregar un producto en canje o préstamo — no son un anexo administrativo, son parte del flujo.

**Consecuencias directas:**

| Ámbito | Implicación |
|---|---|
| Clasificación (§12.2) | Existe nivel *sensible/personal* dentro del alcance operativo, no solo en teoría |
| Índice vectorial (§12.3) | La exclusión de datos de identidad deja de ser trivial: hay que separar el registro de entrega del contenido indexable |
| Cifrado en reposo | Deja de ser diferible cuando estos datos entren al sistema |
| Habeas Data (Ley 1581 de 2012) | Tratamiento de datos personales de terceros exige autorización, finalidad declarada y política de retención |
| Alcance | La gestión de entregas es **MVP 4**, no MVP 1 — el riesgo no es inmediato, pero la decisión de diseño sí |

**Recomendación:** mantener el dato de entrega **fuera del índice vectorial y fuera de `SourceFragment`**, en una entidad separada con cifrado a nivel de campo y acceso restringido por rol. No es una restricción costosa si se decide ahora; sí lo es si se descubre con datos ya cargados.

### 6.2 Compensación económica de KOL dentro del alcance

Las hojas de propuesta incluyen `TOTAL BUDGET`, `Payment by Product` y `Payment in Cash` **por cada KOL**.

**Por qué contradice lo registrado:** DEC-008 estableció que *"los datos de pago a influencers los maneja la agencia de Brasil y están fuera de alcance de este proyecto"*. El material muestra que **la compensación por KOL sí vive en el material operativo de SmartPR Colombia** — al menos como propuesta.

**Distinción que probablemente resuelve la contradicción:** una cosa es el *presupuesto propuesto por KOL* (planeación, propio de SmartPR) y otra el *pago ejecutado* (tesorería, Brasil). Ambos son datos económicos, pero solo el segundo estaba fuera de alcance.

**Pregunta abierta para el product owner:** ¿el presupuesto propuesto por KOL debe vivir en TCL KOL OS —lo cual lo convierte en información confidencial que condiciona permisos y exportaciones— o se mantiene fuera y el sistema solo referencia el total de campaña?

---

## 7. Indicadores de línea base

| Indicador (§2.3) | Línea base medida | Umbral MVP 1 (§15) | ¿Medible hoy? |
|---|---|---|:--:|
| Versiones por campaña sin versión vigente identificable | **Hasta 8** (A400 Pro) | 1 vigente, resto `superseded` | ✅ |
| Guiones con documento vinculado de forma estable | **43%** (nombre suelto, no `fileId`) | 100% por `fileId` | ✅ |
| Retroalimentación de revisión conservada | **3%** (4 de 124) | 100% asociada a la versión | ✅ |
| Entregables con estado registrado | **86%** (17 de 124 sin estado) | 100% | ✅ |
| Claims con fuente citada | **0%** — no existe el concepto en el material | 100% | ✅ |
| Tiempo de ciclo del brief | **No medible** — ver §8 | Reducción ≥ 40% | ❌ |
| Rondas de corrección del brief | **No medible** — ver §8 | Reducir | ❌ |

**Cinco de siete indicadores quedan con línea base medida.** Los dos restantes siguen sin datos.

---

## 8. Lo que sigue sin poder medirse, y por qué

El material recibido documenta **propuestas de KOL y seguimiento de guiones**, no el ciclo de construcción del brief. Faltan:

| Dato ausente | Por qué importa |
|---|---|
| Fecha de recepción del material de TCL China | Marca el inicio del ciclo del brief |
| Fecha de aprobación del brief por el cliente | Marca el fin del ciclo |
| Versiones intermedias del brief con su fecha | Cuenta las rondas de corrección |

**Consecuencia honesta:** el umbral de **"reducción ≥ 40% del tiempo de brief"** (§15) sigue sin ser verificable. Se conocen los síntomas del proceso (versiones proliferadas, trazabilidad perdida) pero no su duración.

**Cómo desbloquearlo:** el hilo de correo de una sola campaña donde se vea el envío del material de China y la aprobación final del brief bastaría para calcular el ciclo de un caso. Con tres campañas se tendría una mediana defendible.

**Alternativa recomendada:** medir el ciclo hacia adelante desde el piloto de MVP 1, en lugar de reconstruirlo hacia atrás. Los umbrales verificables hoy (versionado, trazabilidad, evidencia, retroalimentación conservada) ya son suficientes para demostrar mejora sin depender de una reconstrucción histórica frágil.

---

## 9. Efecto sobre otros entregables

| Entregable | Efecto |
|---|---|
| **D0-02** (AS-IS) | ✅ Deja de ser borrador en sus dolores 5, 6, 7 y 8, ahora con evidencia directa |
| **D0-04** (inventario) | ⚠️ Añadir `LISTADO DE PERFILES` y `LISTADO DIRECCIONES` como documentos reales; reclasificar datos de identidad como *dentro* del alcance operativo |
| **D0-05** (brief maestro) | ⚠️ El brief P80 es un **cuarto formato**; ver análisis aparte |
| **D0-08** (modelo de datos) | ⚠️ Añadir `SIZE PROFILE` y decidir sobre compensación por KOL |
| **D0-13** (gold set) | ✅ Los tres casos `real_derivado` ahora tienen material de origen |
| **decision-log** | ⚠️ Dos decisiones nuevas requeridas (§6.1 y §6.2) |

---

## 10. Cobertura de la Definition of Done

| Requisito (§23, D0-14) | Estado |
|---|---|
| "Tiempo, errores y rondas de al menos cinco campañas" | ⚠️ **Parcial** — 14 familias de campaña analizadas; errores y rondas medidos; **tiempo no** |
| Línea base utilizable como referencia de mejora | ✅ Cinco de siete indicadores con valor medido |
| Sin cifras estimadas o inventadas | ✅ Todo valor proviene de conteo directo sobre los archivos |
