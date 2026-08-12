# D0-01 — Resumen de descubrimiento

**Versión:** 2 (cerrada — pendiente de aprobación del gate) · **Fecha:** 11 de agosto de 2026
**Responsable de producto:** Gerardo Calambás (product owner, DEC-001)
**Fuentes:** `TCL_KOL_OS_DOCUMENTO_MAESTRO_EJECUCION.md`, `docs/decisions/decision-log.md`, tres formatos de brief aportados por el product owner.

---

## 1. Resumen ejecutivo

TCL KOL OS es una plataforma interna de SmartPR para coordinar campañas de influencers/KOL de TCL, desde la recepción del material global hasta el cierre y aprendizaje de cada campaña.

El descubrimiento confirmó que **el cuello de botella real está en la construcción del brief local**: convertir el material que envía TCL China, cruzado con el contexto que aporta TCL Colombia, en un documento rector consistente, versionado y con fuentes verificables. Todo lo demás del proceso depende de que ese documento exista y sea confiable.

Por eso MVP 1 se concentra exclusivamente en **Brief Intelligence** (etapas 1 y 2 del flujo de ocho etapas), y no en el resto de la plataforma. Las siete etapas restantes quedan diseñadas como referencia para que las decisiones de MVP 1 no las bloqueen, pero no se construyen.

**Estado del descubrimiento:** las doce decisiones que el documento maestro marcaba como bloqueantes (§37) están resueltas. Quedan dos gaps abiertos, ambos por falta de material operativo, ninguno bloqueante para iniciar la construcción.

---

## 2. Qué se hizo

| Actividad | Resultado |
|---|---|
| Lectura completa del documento maestro (§1–§40) | Base de todo el trabajo; es la fuente de verdad contractual |
| Sesión de entrevista estructurada con el product owner | 17 preguntas en 3 rondas; resolvió DEC-001 a DEC-012 |
| Recepción de tres formatos reales de brief | Insumo directo de D0-05, en lugar de diseñar el esquema desde cero |
| Registro de decisiones | `docs/decisions/decision-log.md` (D0-16) con 12 decisiones + 5 ADRs |
| Construcción de artefactos de descubrimiento | Este documento y los demás D0-* |

**Lo que no se hizo:** talleres presenciales con TCL, operaciones, legal y seguridad, ni revisión de 5–10 campañas reales, tal como contemplaba el alcance original de MVP 0 (§14). El product owner concentró la validación de negocio en sí mismo (DEC-001) y el material histórico aún no se ha entregado (DEC-002). Esto tiene una consecuencia concreta: **D0-14 está bloqueado y D0-02 es un borrador sin validar** (ver §6).

---

## 3. Decisiones clave

Las doce decisiones están documentadas con su justificación en **[`docs/decisions/decision-log.md`](../decisions/decision-log.md)**. No se repiten aquí. Las cinco que más condicionan la construcción:

| Decisión | Efecto sobre el producto |
|---|---|
| **DEC-003** — TCL China es fuente, no aprobador | El modelo de aprobación tiene un solo nivel externo, no una cadena multinivel |
| **DEC-011** — Piloto de un solo usuario, rol Admin | Los cinco roles de agencia se modelan, pero solo se construye Admin en MVP 1 |
| **DEC-012 / ADR-004** — TCL sin login de aprobación | La aprobación del cliente ocurre fuera del sistema; la plataforma registra el resultado. Se añade una vista de solo lectura como excepción de alcance aprobada |
| **DEC-007 / ADR-005** — Todo local por ahora | Sin nube gestionada ni backup externo; riesgo aceptado explícitamente y visible como deuda técnica |
| **DEC-008** — Sin restricción de proveedor de IA | La mayor parte del contenido de producto ya es público en China y Europa; solo las fechas de lanzamiento no anunciadas tienen sensibilidad, y no requieren capa adicional en el piloto |

---

## 4. Hallazgos del proceso actual

Detalle en **[D0-02 — Mapa AS-IS](D0-02-mapa-as-is.md)**.

> ⚠️ El mapa AS-IS es un **borrador construido a partir de la entrevista**, no de documentos operativos reales. Sus puntos de dolor son cualitativos; no hay tiempos ni tasas medidas.

Los diez dolores identificados se agrupan en tres causas raíz:

1. **No hay contenedor único.** La información de una campaña vive repartida entre PPT, correo, WhatsApp y Drive; reconstruir el contexto exige buscar en cuatro canales.
2. **No hay estructura persistente.** El brief se redacta sin plantilla, lo que hace que la completitud dependa de quién lo escriba y que los claims no citen su fuente.
3. **No hay trazabilidad.** El versionado ocurre por nombre de archivo, las correcciones viven en hilos de correo y las aprobaciones no dejan registro estructurado.

---

## 5. Alcance confirmado

Detalle en **[D0-03 — Flujo TO-BE](D0-03-flujo-to-be.md)**.

**MVP 1 construye:** creación de campaña, carga y procesamiento de fuentes, extracción estructurada con evidencia, preguntas locales, editor de brief con modo manual, versiones ES/EN vinculadas, glosario, aprobación interna, exportación DOCX/PDF, auditoría y observabilidad de IA.

**MVP 1 no construye:** CRM de influencers, revisión de guiones o video, dashboards analíticos, workflow logístico, inventario, integraciones de mensajería ni publicación en redes.

**Excepción de alcance aprobada (ADR-004):** una pantalla de solo lectura para TCL con estado de campaña y descarga del entregable aprobado. No incluye KPIs ni comparación de metas — eso permanece en MVP 6.

**Tres propiedades no negociables del diseño:**

- La IA nunca aprueba (ADR-002). Propone; una persona decide.
- Un brief aprobado es inmutable (ADR-003). Un cambio crea una versión nueva.
- Siempre existe un camino sin IA. Una caída del proveedor degrada la asistencia, no bloquea el trabajo.

---

## 6. Riesgos y gaps abiertos

| # | Gap / riesgo | Impacto | Estado |
|---|---|---|---|
| 1 | **D0-14 bloqueado** — sin línea base medida | El umbral de "≥ 40% de reducción de tiempo" (§15) no es verificable; no puede usarse como criterio de aceptación del piloto | Pendiente de material de 5–10 campañas reales |
| 2 | **D0-02 sin validar** — AS-IS construido solo desde la entrevista | El TO-BE hereda supuestos no verificados sobre el proceso real | Se resuelve con el mismo material del gap 1 |
| 3 | **Sin backup externo** (ADR-005) | Pérdida total del histórico si falla el equipo local | Riesgo aceptado explícitamente; se revisa cuando exista UI/UX funcional |
| 4 | **Validación de negocio concentrada en una persona** | Sin contraste de otros consultores, el diseño puede optimizar un flujo de trabajo individual y no el del equipo | Aceptado para el piloto; se contrasta al incorporar consultores reales |
| 5 | **Estructura de los PPT de China desconocida** | Si varía mucho entre campañas, la extracción no puede apoyarse en la posición y depende más del modelo | Se despeja al recibir documentos reales |
| 6 | **Contraparte formal en TCL Colombia sin nombrar** | Ninguno en MVP 1; el flujo interno de SmartPR no la requiere | No bloqueante (decision-log) |

**Los gaps 1 y 2 comparten causa y solución:** entregar material de campañas reales. Es la acción de mayor valor pendiente del product owner.

---

## 7. Estado de los entregables de MVP 0

| ID | Entregable | Archivo | Estado |
|---|---|---|---|
| D0-01 | Resumen de descubrimiento | `D0-01-resumen-descubrimiento.md` | 🟢 Completo |
| D0-02 | Mapa AS-IS | `D0-02-mapa-as-is.md` | 🟢 Validado parcialmente con material real |
| D0-03 | Flujo TO-BE | `D0-03-flujo-to-be.md` | 🟢 Completo |
| D0-04 | Inventario de documentos | `D0-04-inventario-documentos.md` | 🟢 Completo |
| D0-05 | Plantilla de brief maestro | `D0-05-plantilla-brief-maestro.md` | 🟢 Completo — esquema validado |
| D0-06 | Glosario bilingüe | `D0-06-glosario.csv` | 🟢 Completo — 50 términos |
| D0-07 | Matriz de roles y permisos | `D0-07-matriz-roles-permisos.md` | 🟢 Completo |
| D0-08 | Modelo de datos | `../architecture/D0-08-modelo-datos.md` | 🟢 Completo — 17 entidades |
| D0-09 | Arquitectura | `../architecture/D0-09-arquitectura.md` | 🟢 Completo + anexo de seguridad |
| D0-10 | Prototipo navegable | `D0-10-prototipo.md` | 🟢 Completo — 13 de 13 pantallas |
| D0-11 | Backlog MVP 1 | `D0-11-backlog-mvp1.md` | 🟢 Completo — 115 historias |
| D0-12 | Plan de pruebas | `D0-12-plan-pruebas.md` | 🟢 Completo — 84 casos |
| D0-13 | Gold set inicial | `D0-13-gold-set.md` | 🟡 **Parcial** — 4 de 7 casos |
| D0-14 | Línea base | `D0-14-linea-base.md` | 🟡 **Desbloqueado** — 5 de 7 indicadores medidos |
| D0-15 | Estimación MVP 1 | `D0-15-estimacion-mvp1.md` | 🟢 Completo |
| D0-16 | Registro de decisiones | `../decisions/decision-log.md` | 🟢 Completo — 12 decisiones + 8 ADRs |

**14 completos · 2 parciales · 0 bloqueados.**

---

## 7 bis. Gate de MVP 0 — aprobado

| | |
|---|---|
| **Decisión** | **Aprobado** |
| **Fecha** | 11 de agosto de 2026 |
| **Aprobado por** | Gerardo Calambás (product owner, DEC-001) |
| **Alcance** | Los 16 entregables de MVP 0. Se autoriza congelar el alcance de MVP 1 e iniciar la construcción (§22.1, paso 5) |

**Condiciones declaradas al momento de la aprobación** — el gate se aprueba conociéndolas, no ignorándolas:

1. **Backups no cubiertos** (punto 5 del DoD). Riesgo aceptado en ADR-005, con disparadores definidos.
2. **Tiempo de ciclo del brief sin medir.** El umbral de "≥ 40% de reducción" (§15) no es verificable con los datos actuales; ver D0-14 §8 para la alternativa recomendada.
3. **Tres decisiones abiertas surgidas del material real** (DEC-013 datos personales, DEC-014 compensación de KOL, DEC-015 cuarto formato de brief). Ninguna bloquea MVP 1; las tres afectan fases posteriores.

> El material operativo llegó el mismo día de la aprobación y desbloqueó D0-14. Su análisis está en [D0-14](D0-14-linea-base.md) y no altera el alcance aprobado de MVP 1.

---

## 8. Evaluación contra la Definition of Done (§23.1)

| # | Requisito | Estado |
|---|---|:--:|
| 1 | Los entregables D0-01 a D0-16 existen y son legibles | ✅ |
| 2 | Sin campos críticos de arquitectura como "por decidir" sin responsable | ✅ |
| 3 | El brief maestro tiene esquema validable | ✅ |
| 4 | Roles y permisos cubren Agencia y TCL | ✅ |
| 5 | La arquitectura incluye seguridad, backups, observabilidad y fallback manual | ⚠️ |
| 6 | El prototipo cubre UI-03 a UI-15 | ✅ |
| 7 | El backlog de MVP 1 tiene dependencias y criterios verificables | ✅ |
| 8 | Los riesgos críticos tienen mitigación y propietario | ✅ |
| 9 | Agencia y TCL registran aprobación o cambios solicitados | ⏳ |

**Sobre el punto 5:** los backups no están cubiertos. No es una omisión — es el riesgo aceptado explícitamente en ADR-005, con disparadores definidos y mitigación planificada. Debe declararse así al presentar el gate, no marcarse como cumplido.

**Sobre el punto 9:** es lo único que falta y **no puede hacerlo el agente**. Requiere la decisión del product owner.

---

## 9. Próximos pasos

1. **Product owner — revisar y decidir el gate de MVP 0.** Aprobar, aprobar con observaciones, o solicitar cambios.
2. **Product owner — entregar material de 5–10 campañas cerradas.** Es la acción de mayor valor pendiente: desbloquea D0-14, valida D0-02 y completa D0-13 de una sola vez.
3. **Product owner — resolver las cuatro decisiones que condicionan sprints tempranos:** varios productos por campaña (Sprint 1), proveedor de IA (Sprint 3), definición de "brief completo" (Sprint 3), reversión de aprobación interna (Sprint 5).
4. **Agente — al aprobarse el gate:** congelar el alcance de MVP 1 y arrancar el Sprint 0 según D0-15.

> **El gate de MVP 0 no puede declararlo el agente por sí solo** (§22.1). Este documento presenta el trabajo terminado y sus huecos declarados; la decisión es humana.
