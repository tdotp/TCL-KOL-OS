# Dónde interviene el modelo, y cuánta precisión necesita cada tarea

**Fecha:** 12 de agosto de 2026 · **Complementa:** [D0-13 anexo — validación de niveles](D0-13-validacion-niveles.md)
**Origen:** observación del product owner — *"primero toca validar en qué tarea va a intervenir el modelo de lenguaje y qué nivel de precisión necesitamos"*.

---

## 1. Por qué este análisis va antes que la elección de modelo

La medición anterior comparó modelos contra el gold set y produjo un ranking. Pero un ranking responde *"¿cuál es mejor?"*, y la pregunta útil es otra: **¿cuánto modelo necesita realmente cada tarea?**

El §5 del documento maestro ya lo anticipa en su principio 4: *"reglas antes que IA: estados, permisos, fechas y cálculos se resuelven con software determinístico"*. Este documento lo aplica tarea por tarea.

El resultado cambia la conclusión: **la mayor parte del trabajo del brief no es una tarea de lenguaje.** Es estructura, mapeo y validación. El modelo hace una porción estrecha, y en varias tareas hace mucho menos de lo que parecía.

---

## 2. Descomposición de las siete tareas

Cada tarea se parte en tres: lo que resuelve el código sin modelo, lo que el modelo hace de verdad, y qué cuesta que se equivoque.

### 2.1 `extraer_campos`

| | |
|---|---|
| **Determinista** | Localizar fragmentos (ya lo hizo el parser), validar contra el JSON Schema, vincular evidencia a campo, rechazar salidas inválidas |
| **Trabajo real del modelo** | Mapear texto → campo del esquema, y decidir entre `found` / `not_found` / `conflict` |
| **Costo del error** | **Alto** si inventa un valor. **Bajo** si extrae de más: el consultor lo corrige |
| **Red de seguridad** | Esquema + `guardClaimsHaveEvidence` + confirmación humana de campos críticos |
| **Precisión necesaria** | **Alta en la decisión de estado**, media en el valor |

La decisión binaria —¿esto está o no está?— es lo único que importa de verdad. Y los siete modelos probados la respetan.

### 2.2 `detectar_vacios`

| | |
|---|---|
| **Determinista** | Qué campos son obligatorios (lo dice el esquema), cuáles están vacíos (comparación trivial), cuáles quedaron en `conflict` (ya lo calculó la extracción) |
| **Trabajo real del modelo** | Detectar contradicciones **semánticas** que la extracción no vio, y redactar la pregunta de forma que un consultor la entienda |
| **Costo del error** | **Bajo**. Un vacío no detectado aparece después; un vacío falso cuesta treinta segundos de un consultor |
| **Precisión necesaria** | **Baja** |

**Aquí está el hallazgo más útil:** esta tarea es casi enteramente determinista. Un campo obligatorio que está vacío es un vacío — no hace falta un modelo para saberlo. El modelo aporta en el margen: la contradicción sutil y la redacción de la pregunta.

### 2.3 `traducir`

| | |
|---|---|
| **Determinista** | Bloqueo de términos del glosario, preservación de la estructura, vínculo `translationOfId`, conservación literal de las evidencias |
| **Trabajo real del modelo** | Traducir prosa |
| **Costo del error** | **Medio**, y con revisión humana obligatoria |
| **Precisión necesaria** | **Media** |

Traducir es la tarea más "de lenguaje puro" de todas, y aun así el glosario resuelve la parte donde un error dolería: la terminología de producto.

### 2.4 `redactar_brief` — la "bajada"

| | |
|---|---|
| **Determinista** | La estructura completa, qué campo va en qué sección, la plantilla de salida, los datos ya extraídos y confirmados |
| **Trabajo real del modelo** | Convertir valores de campo en prosa legible |
| **Costo del error** | **Bajo**. El consultor edita antes de aprobar, y la IA nunca aprueba (ADR-002) |
| **Precisión necesaria** | **Baja** |

Coincide con lo que observó el product owner: **la bajada del brief es un proceso lógico estipulable**. El mapeo bloque → sección ya está definido en D0-05 §2.2. El modelo redacta, no decide.

### 2.5 `buscar_evidencia`

| | |
|---|---|
| **Determinista** | Búsqueda vectorial, filtrado obligatorio por organización, campaña, idioma y permiso |
| **Trabajo real del modelo** | **Ninguno.** No hay generación |
| **Costo del error** | Recuperar un fragmento poco relevante: el consultor lo ignora |
| **Precisión necesaria** | No aplica |

Solo consume embeddings. §9.2 ya lo decía: *"sin generación o eficiente"*.

### 2.6 `resolver_ambiguedad`

| | |
|---|---|
| **Determinista** | Detectar el conflicto — ya lo hizo la extracción marcando `conflict` |
| **Trabajo real del modelo** | Analizar cuál fuente es más autorizada y **explicar** el criterio |
| **Costo del error** | **Alto en apariencia, acotado en la práctica**: §9.2 prohíbe la aprobación automática. El modelo propone, una persona decide |
| **Precisión necesaria** | **Alta en el razonamiento**, nula en la decisión — porque no decide |

**La única tarea que justifica capacidad de razonamiento.** Y aun aquí, el peor caso es una recomendación pobre que un consultor descarta.

### 2.7 `generar_embedding`

Sin juicio. Solo importa que el modelo de embeddings sea consistente consigo mismo entre ejecuciones.

---

## 3. El cuadro completo

| Tarea | Trabajo determinista | Precisión necesaria | Nivel justificado |
|---|:--:|:--:|---|
| `buscar_evidencia` | ~100% | — | sin modelo generativo |
| `detectar_vacios` | ~85% | Baja | **eficiente** |
| `redactar_brief` | ~75% | Baja | **eficiente** |
| `traducir` | ~40% | Media | **eficiente** |
| `extraer_campos` | ~50% | Alta *en el estado* | **eficiente** + guarda |
| `resolver_ambiguedad` | ~20% | Alta | **equilibrado o avanzado** |

**Seis de siete tareas se atienden con el nivel eficiente.** El §9.2 asignaba `detectar_vacios` y `redactar_brief` al nivel equilibrado; medido contra lo que el modelo hace de verdad en cada una, no lo necesitan.

---

## 4. Costo-beneficio con volumen real

Medido sobre el material ya procesado: un PPT de campaña produce **42 fragmentos** y un brief en Markdown **7**. Con el esquema y las instrucciones, una extracción completa ronda los **6 500 tokens de entrada** y unos 3 000 de salida.

### Costo por campaña completa

Una campaña ejecuta: 1 extracción, 1 detección de vacíos, 1 redacción, 1 traducción, más búsquedas de evidencia.

| Configuración | Costo por campaña | 10 campañas/mes | 50 campañas/mes |
|---|---:|---:|---:|
| Todo con `gemini-2.5-flash-lite` | ~$0.006 | $0.06 | $0.30 |
| §9.2 original (mixto haiku) | ~$0.055 | $0.55 | $2.75 |
| Todo con `claude-haiku-4.5` | ~$0.092 | $0.92 | $4.60 |
| Todo con `claude-sonnet-5` | ~$0.317 | $3.17 | $15.85 |

### La conclusión incómoda

**A este volumen, el costo es irrelevante.** La diferencia entre la opción más barata y la más cara es de **$15 al mes** con 50 campañas — menos que una hora de trabajo de un consultor.

Optimizar por precio aquí sería optimizar la variable equivocada. Lo que sí importa:

| Criterio | Peso real |
|---|---|
| **No fabricar** | Decisivo. Es binario, no un gradiente |
| **Latencia** | Alto. 28 s frente a 2,5 s cambia si la herramienta se siente viva |
| **Consistencia entre ejecuciones** | Alto. Sin ella el gold set no puede medir regresiones |
| **Costo** | **Bajo a este volumen** |

---

## 5. Configuración recomendada, revisada

| Nivel | Modelo | Tareas | Razón |
|---|---|---|---|
| **eficiente** | `google/gemini-2.5-flash-lite` | extraer, detectar vacíos, traducir, redactar, buscar evidencia | 2,5 s de latencia; el 75% del trabajo de estas tareas ya lo hace el código |
| **equilibrado** | `anthropic/claude-haiku-4.5` | resolver ambigüedad | Único de bajo costo que juzga un claim sin respaldo (GS-006) |
| **avanzado** | — sin uso — | ninguna por ahora | Sonnet-5 empata con haiku por 3,4× el costo |

### Qué cambia respecto a §9.2

`detectar_vacios` y `redactar_brief` **bajan** de equilibrado a eficiente. No es un recorte de calidad: es reconocer que en esas tareas el modelo hace poco, y lo que hace lo revisa una persona antes de que cuente.

`resolver_ambiguedad` **baja** de avanzado a equilibrado, porque la medición no encontró diferencia entre haiku y sonnet en este gold set. El nivel avanzado queda declarado pero sin uso, listo para cuando haya evidencia que lo justifique.

**Esto es un cambio sobre el documento maestro y requiere aprobación** (regla de cambio, §0).

---

## 6. La pregunta que este análisis deja abierta

El nivel intermedio queda casi vacío: seis tareas en eficiente, una en equilibrado, ninguna en avanzado.

Puede significar dos cosas, y todavía no se puede distinguir:

1. **Que la partición en tres niveles sobra** para este producto, porque el diseño determinista absorbe la complejidad.
2. **Que el gold set aún no discrimina lo suficiente.** Cuatro casos sintéticos miden límites, no matices. Los tres casos `real_derivado` siguen pendientes de material real.

La forma de resolverlo es la de siempre: **medir con casos reales**. Es la misma acción pendiente que desbloquea D0-14 y completa D0-13.

Mientras tanto, la configuración recomendada es la más barata que no fabrica y es rápida — y cambiarla cuesta una variable de entorno.
