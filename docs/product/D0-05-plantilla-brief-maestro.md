# D0-05 — Plantilla de brief maestro

**Versión:** 2 · **Fecha:** 11 de agosto de 2026 · **Estado:** propuesta para validación
**Archivos:** [`brief-schema/brief.schema.json`](brief-schema/brief.schema.json) · [`brief.example.es.json`](brief-schema/brief.example.es.json) · [`brief.example.en.json`](brief-schema/brief.example.en.json)
**Fuentes:** documento maestro §9.4 (reglas anti-alucinación), §10.1 (`Brief`, `BriefVersion`, `BriefField`, `Evidence`), §7.3 (estados); cinco formatos reales aportados por el product owner (DEC-004, DEC-015).

**Cambios en la v2:** se distingue entre formatos de **entrada** (del cliente, variables) y formato de **salida** (propio de SmartPR, único) — corrección de encuadre registrada en DEC-015. Se incorpora el brief P80 como cuarto formato de entrada analizado.

---

## 1. El problema que resuelve

> **Corrección respecto a la versión 1 de este documento (DEC-015).** La v1 trataba los tres formatos de brief conocidos como fuentes equivalentes a fusionar. El encuadre correcto es otro: unos son **entradas** y otro es la **salida**. La distinción cambia cómo se lee todo el diseño.

El producto funciona así:

```
Material heterogéneo del cliente y de TCL China
        ↓
El sistema formula las preguntas del formato de SmartPR
        ↓
La IA busca las respuestas en el material, con evidencia
        ↓
Lo que no encuentra se pregunta a una persona
        ↓
Bajada en el formato propio de SmartPR
```

### 1.1 Formatos de entrada — variables, no controlados por SmartPR

| Formato | Origen | Qué aporta |
|---|---|---|
| **PPT de campaña global** | TCL China | Narrativa global, pilares de campaña, calendario, lineamientos de marca |
| **Ficha técnica** | TCL China / Colombia | Especificaciones citables como evidencia |
| **Brief Estratégico – Formato maestro** (DOCX) | TCL Colombia | Contexto, objetivo, target, tensión, mandatorios |
| **Brief P80 – Contenidos** (DOCX) | TCL Colombia, agosto 2026 | Reto, contexto competitivo, audiencia, insight, presupuesto, ficha comparativa |
| **"THE BRIEF"** (one-pager) | Cliente / agencia creativa | Insight condensado, *one line*, datos prácticos |

**Estos formatos no se replican, se leen.** Que hayan llegado cuatro estructuras distintas en pocos meses confirma que la variabilidad es la norma, no la excepción. El sistema no debe intentar normalizarlos: debe extraer de ellos lo que responde a sus propias preguntas.

### 1.2 Formato de salida — único y propio de SmartPR

El **"Brief de Campaña – Producto"** (10 secciones) es la propuesta vigente del formato de salida de la agencia:

`1. Producto · 2. Campaña · 3. Objetivo · 4. Audiencia objetivo · 5. Tiempo de ejecución · 6. Presupuesto · 7. Mensaje y beneficio principal · 8. Acción esperada · 9. KPI o resultado esperado · 10. Restricciones o lineamientos`

**Es una propuesta, no un contrato.** El product owner confirmó que admite cambios sin fricción. Por eso no se implementa como esquema rígido, sino como **plantilla de renderizado** sobre los bloques canónicos, versionada con `Export.templateVersion`. Cambiar el formato de salida no exige migrar datos.

### 1.3 La decisión de diseño

**Diez bloques canónicos, dos opcionales**, como estructura interna — ni un esquema por formato de entrada, ni el formato de salida como esquema.

Adoptar directamente las 10 secciones de SmartPR como esquema parecería lo simple, pero rompería tres cosas: no habría dónde guardar la tensión ni el insight que aportan los briefs estratégicos, no se podría distinguir un objetivo de negocio de uno de comunicación, y cualquier ajuste al formato de salida obligaría a migrar todos los briefs históricos.

---

## 2. Mapeo de entradas y salida a los bloques canónicos

### 2.1 Formatos de entrada → bloques canónicos

| Bloque canónico | ¿Obligatorio? | Brief Estratégico | Brief P80 | THE BRIEF | PPT global / ficha técnica |
|---|:--:|---|---|---|---|
| `contexto` | Sí | 01. Contexto | El Contexto · El Reto | — | Contexto de lanzamiento |
| `objetivo` | Sí | 02. Objetivo | Objetivos (PR / KOL) | — | — |
| `target_audiencia` | Sí | 03. Target | Audiencia (primaria y secundaria) | WHO | — |
| `problema_insight` | **No** | 04. Problema · 05. Tensión | Desafío · Insight | INSIGHT · BEHAVIOR CHANGE | — |
| `marca_producto` | Sí | 06. Marca | La Visión · La Idea · Ficha técnica | — | Especificaciones · activos |
| `mandatorios` | Sí | 07. Mandatorios | Las Acciones (restricciones) | PRACTICAL STUFF (Must) | Lineamientos de marca |
| `mensaje_principal` | Sí | — | La Idea (taglines) · Pilares | ONE LINE BRIEF | Narrativa global |
| `accion_kpis` | Sí | 09. Criterio de éxito | Resultados esperados | WE WILL BE HAPPY IF | — |
| `entregable_creativo` | **No** | 08. Entregable · 10. Desafío | Las Acciones | PRACTICAL STUFF (Nice) | — |
| `practico` | Sí | 07. timing | Fecha · Hitos clave · Presupuesto | R1/R2/all-done · budget | Calendario global |

### 2.2 Bloques canónicos → formato de salida de SmartPR

| Sección del formato SmartPR | Se renderiza desde |
|---|---|
| 1. Producto | `marca_producto.nombre_producto` + `productId` |
| 2. Campaña | `meta.campaignId` + `contexto.situacion` |
| 3. Objetivo de la campaña | `objetivo.tipo` (Awareness / Consideration / Conversion / Loyalty) |
| 4. Audiencia objetivo | `target_audiencia.*` completo |
| 5. Tiempo de ejecución | `practico.fecha_inicio` · `practico.fecha_fin` |
| 6. Presupuesto | `practico.presupuesto` |
| 7. Mensaje y beneficio principal | `mensaje_principal.mensaje_clave` + `beneficio_diferencial` |
| 8. Acción esperada | `accion_kpis.accion_esperada` |
| 9. KPI o resultado esperado | `accion_kpis.kpis` |
| 10. Restricciones o lineamientos | `mandatorios[]` + `practico.restricciones` |

**Las 10 secciones se cubren íntegramente.** Los bloques que no aparecen en la salida (`problema_insight`, `entregable_creativo`, parte de `marca_producto`) no son sobrantes: sostienen el trabajo interno y las evidencias, y estarán disponibles si el formato de salida crece.

### 2.3 Las preguntas se derivan del formato de salida

Consecuencia directa de DEC-015: **el conjunto de preguntas locales no se inventa por campaña.** Cada campo del formato de SmartPR que no encuentre respuesta en el material se convierte en una pregunta dirigida. Esto convierte a `LocalQuestion` (Épica E6) en pieza central del producto, no en un mecanismo auxiliar.

Ejemplo real, tomado del brief P80: el campo `practico.presupuesto` existe y trae `USD 55,000`, pero el propio brief dice que *"la agencia debe proponer el monto necesario"* para la compra de equipos. Un campo poblado y otro explícitamente pendiente — la distinción entre `found` y `not_found` no es teórica.

### 2.4 Dos notas del mapeo

**Por qué `problema_insight` y `entregable_creativo` son opcionales:** un brief puramente operativo no contiene trabajo estratégico-creativo. Obligarlo a declarar una tensión produciría texto de relleno — exactamente lo que el sistema no debe generar. Cuando la fuente no los contiene, el bloque se marca `null` como decisión visible, no como olvido.

**`mensaje_principal.one_line` es obligatorio y ningún formato del cliente lo aporta.** Es correcto: el *one line* lo construye SmartPR. Llegará con `provenanceType: manual_local`, marcando dónde termina lo que entrega el cliente y dónde empieza el aporte de la agencia.

---

## 3. `BriefFieldValue` — el envoltorio de todo campo

Ningún campo del brief es un valor suelto. Todos se envuelven en la misma estructura, que traduce las reglas anti-alucinación de §9.4 a algo que una máquina puede verificar:

```json
{
  "value": "Panel QLED de 144Hz con Game Master.",
  "status": "found",
  "confidence": 0.94,
  "provenanceType": "extracted",
  "criticidad": "claim",
  "evidence": [
    {
      "sourceId": "src-ficha-tecnica-c755",
      "fragmentId": "frg-0014",
      "page": 2,
      "quote": "Native 144Hz VRR panel with Game Master 3.0",
      "relation": "soporta"
    }
  ]
}
```

| Atributo | Valores | Para qué existe |
|---|---|---|
| `status` | `found` · `not_found` · `conflict` · `manual` | Distingue el dato encontrado del ausente y del contradictorio. `not_found` es un resultado válido, no un error |
| `confidence` | 0–1 o `null` | Permite priorizar qué revisa primero la persona. `null` cuando el origen es manual (una persona no tiene "confianza estimada") |
| `provenanceType` | `extracted` · `inferred` · `manual_local` · `translated` | Cumple §9.4: "el texto generado debe distinguir hecho, inferencia y propuesta local" |
| `criticidad` | `informativo` · `critico` · `claim` | Determina si el campo exige evidencia |
| `evidence[]` | Lista de citas verificables | Cada una con archivo, ubicación y cita literal |

### Tres reglas que el esquema impone por construcción

1. **`criticidad: claim` o `critico` + `status: found` ⇒ al menos una evidencia.** Un claim sin fuente no es un campo mal documentado: es un documento inválido.
2. **`status: not_found` ⇒ `value` debe ser `null`.** Hace estructuralmente imposible completar un dato ausente con conocimiento general del modelo.
3. **`status: conflict` ⇒ al menos dos evidencias.** Un conflicto sin mostrar las dos fuentes que se contradicen no es accionable.

---

## 3 bis. Campañas con varios productos (DEC-016)

Una campaña puede cubrir varios productos. El material real lo muestra en tres formas: una línea con gamas (P80, P80 Pro, P80 Ultra), productos complementarios (televisor y barra de sonido, los monitores 27G64 y 25G64) y campañas de temporada que agrupan productos sin relación (Black Days, Día de la Madre, Amor y Amistad).

**No hay tres diseños. Hay una regla de tres niveles.**

| Nivel | Bloques | Comportamiento |
|---|---|---|
| **Campaña** | `contexto` · `objetivo` · `accion_kpis` · `practico` · `entregable_creativo` | Únicos y compartidos |
| **Producto** | `marca_producto` | Se repite: ficha técnica, precio, diferenciales y RTBs **siempre** difieren |
| **Compartido con excepción** | `target_audiencia` · `problema_insight` · `mensaje_principal` · `mandatorios` | Únicos por defecto; un producto puede declarar el suyo en `overrides` |

### Por qué esta partición

`contexto` y `practico` describen la **ocasión comercial**, no el producto: la temporada de Black Days y sus fechas son las mismas para el televisor y para el aire acondicionado. Permitir excepciones ahí invitaría a duplicar información que debe ser única.

`marca_producto`, en cambio, no admite compartirse nunca: dos productos con la misma ficha técnica serían el mismo producto.

Los cuatro del medio son los que varían según el caso, y por eso son los únicos overridables.

### No hay que clasificar la campaña

El esquema **no pide declarar un tipo** (línea / bundle / temporada). Esa decisión obligaría a acertar antes de tener el material y envejecería mal. La estructura se revela sola: si no hay `overrides`, todos los productos comparten; si los hay, ese producto se desengancha de ese bloque.

### Los tres casos, resueltos

| Caso | `productos` | `overrides` |
|---|:--:|---|
| Lanzamiento simple (C755) | 1, rol `unico` | ninguno |
| Línea con gamas (P80) | 3, roles `flagship` / `secundario` / `entrada` | uno: el P80 básico tiene audiencia propia |
| Temporada con productos sueltos | N, roles `secundario` | uno por producto: mensaje y audiencia propios |

### Cómo se ancla la evidencia

Cada bloque `marca_producto` lleva un `productId` obligatorio. Una especificación en una campaña de tres modelos **sin decir de cuál** no es un dato ambiguo: es un error esperando a salir publicado. Es exactamente lo que corrigieron a mano en el guion de David Osorio — *"cuando habla de la tasa de refresco que diga 288hz vrr o sino 144hz nativos"*.

### El reparto de presupuesto

`productos[].participacionPresupuesto` guarda la fracción por producto. El brief P80 declara 0.6 / 0.2 / 0.1 — que **suma 90%, no 100%**. El esquema no lo rechaza porque puede ser deliberado ("aprox"), pero es precisamente el tipo de hueco que el sistema debe convertir en pregunta al consultor en vez de dejarlo pasar.

---

## 4. Verificación ejecutada

El esquema no se entrega solo como propuesta: se validó técnicamente.

```
✅ El schema compila correctamente (JSON Schema 2020-12)
✅ brief.example.es.json           — instancia válida (1 producto)
✅ brief.example.en.json           — instancia válida (1 producto)
✅ brief.example.multiproducto.json — instancia válida (3 productos)

--- Pruebas negativas: reglas anti-alucinación (§9.4) ---
✅ "claim con valor pero SIN evidencia" rechazado
✅ "not_found CON valor (dato inventado)" rechazado
✅ "conflict con UNA sola evidencia" rechazado
✅ "versión EN sin translationOfId" rechazado
✅ "campo crítico faltante (mensaje_principal.one_line)" rechazado
✅ "status fuera del enum permitido" rechazado

--- Pruebas negativas: campañas multiproducto (DEC-016) ---
✅ "campaña sin ningún producto" rechazado
✅ "bloque marca_producto sin productId que lo ancle" rechazado
✅ "marca_producto vacío" rechazado
✅ "override sobre un bloque NO overridable (contexto)" rechazado
✅ "override sin productId" rechazado
✅ "override vacío (declara excepción sin decir qué cambia)" rechazado
✅ "participación de presupuesto fuera de rango (1.5)" rechazado
✅ "rol de producto inválido" rechazado
✅ "prioridad cero" rechazado
```

Las pruebas negativas importan más que las positivas: demuestran que las reglas **no dependen de que el modelo se comporte bien**. Un brief con un claim sin evidencia, o con una excepción declarada sobre un bloque que debe ser compartido, no llega a persistirse como versión aprobable — no pasa la validación.

El ejemplo multiproducto es el brief P80 real, con sus tres modelos, sus precios, su reparto de presupuesto y una excepción de audiencia para el modelo de entrada.

Para reproducir la validación:

```bash
npx ajv-cli validate -s docs/product/brief-schema/brief.schema.json -d "docs/product/brief-schema/brief.example.*.json" --spec=draft2020
```

---

## 5. Relación ES ↔ EN

**Una sola estructura, dos instancias.** No hay un esquema en español y otro en inglés: ambos ejemplos validan contra el mismo archivo.

| | ES | EN |
|---|---|---|
| `meta.language` | `es` | `en` |
| `meta.translationOfId` | `null` | ID de la versión ES de origen |
| `provenanceType` de los campos | `extracted` / `manual_local` | `translated` |
| Claves del JSON | En español | **También en español** |

**Las claves permanecen en español en ambos idiomas.** Traducir las claves crearía dos formas de nombrar el mismo campo y rompería toda consulta que cruce idiomas. Lo que se traduce es el contenido, no la estructura.

El esquema obliga: si `language` es `en`, `translationOfId` **debe** apuntar a una versión existente (regla de integridad §10.3). Una traducción huérfana no valida.

**Las evidencias no se traducen.** Una cita conserva el texto literal de su fuente — traducirla la invalidaría como evidencia verificable. Por eso el ejemplo en inglés cita fragmentos en español cuando la fuente estaba en español.

---

## 6. Correspondencia con el modelo de datos

| Elemento del esquema | Entidad (D0-08) |
|---|---|
| Documento completo | `BriefVersion.content` (jsonb) |
| `meta.*` | Columnas de `BriefVersion` |
| Cada campo hoja | Una fila de `BriefField` (`key` = ruta canónica, ej. `marca_producto.rtbs`) |
| Cada `evidence[]` | Filas de `Evidence` ligadas a ese `BriefField` |
| `status: conflict` o `not_found` en campo crítico | Dispara una `LocalQuestion` |

El contenido se guarda dos veces con propósitos distintos: como `jsonb` para leer y exportar el brief completo de una sola vez, y descompuesto en `BriefField` para consultar, filtrar y auditar campo por campo. La fuente de verdad es `BriefField`; el `jsonb` se regenera desde ahí.

---

## 7. Cobertura de la Definition of Done

| Requisito (§23.1) | Estado |
|---|---|
| "El brief maestro tiene esquema validable" | ✅ JSON Schema 2020-12, compilado y probado con casos positivos y negativos |
| Ejemplo ES/EN | ✅ Dos instancias completas y válidas de la misma campaña |
| Soporta evidencia por claim | ✅ Obligatoria por construcción, no por convención |
| Soporta `not_found` | ✅ Con valor nulo forzado |

## 8. Pendientes

| Punto | Impacto | Cuándo se resuelve |
|---|---|---|
| Validar la cobertura de bloques contra briefs reales | Alto — el mapeo se construyó desde tres plantillas, no desde briefs diligenciados | Al recibir material para D0-14 |
| ~~¿Qué campos exactos son obligatorios para aprobar?~~ | **Resuelto** — [DEC-021](../decisions/decision-log.md): 11 críticos, 5 claims, 25 informativos. Confirmado contra la campaña P80 | 13 de agosto de 2026 |
| ¿`presupuesto` debe tener confidencialidad propia? | Medio — hoy hereda la del recurso | Antes del piloto |
| Versionado del propio esquema | Bajo — `templateVersion` ya existe en `meta` | Al primer cambio del esquema |
