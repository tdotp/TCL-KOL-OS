# D0-11 — Backlog de MVP 1

**Versión:** 1 · **Fecha:** 11 de agosto de 2026 · **Estado:** propuesta para validación
**Fuentes:** documento maestro §24 (épicas E1–E13), §25 (plan de sprints), §15 (alcance de MVP 1), §27 (estándar de calidad); `docs/decisions/decision-log.md`.

---

## 1. Cómo leer este backlog

Cada historia es una **porción vertical demoable**: atraviesa interfaz, dominio y datos, y termina en algo que se puede mostrar. No hay historias de "crear la capa X" que no produzcan comportamiento observable.

| Campo | Significado |
|---|---|
| **ID** | `E<épica>-<n>` |
| **Prioridad** | `must` (sin esto no hay MVP 1) · `should` (se puede diferir con costo) · `could` (mejora, no requisito) |
| **Bloqueada por** | Historias que deben estar terminadas antes. Sin ciclos |
| **Aceptación** | Verificable por observación o por prueba, no por opinión |

**Total:** 13 épicas · 115 historias · 95 `must`, 20 `should`.

> Las 7 historias añadidas el 11 de agosto de 2026 corresponden a **DEC-016** (campañas multiproducto): E3-8, E3-9, E5-10, E6-7, E7-8, E7-9 y E10-8.

---

## 2. Épica E1 — Base del repositorio

> **Criterio de la épica (§24):** una persona nueva puede ejecutar el proyecto desde el README siguiendo pasos reproducibles.

| ID | Historia | Prio | Bloqueada por | Aceptación |
|---|---|:--:|---|---|
| E1-1 | Monorepo con `apps/web`, `services/ai-worker`, `packages/{domain,ui,config,evals}` | must | — | La estructura de §26 existe y cada paquete tiene su `package.json` o `pyproject.toml` |
| E1-2 | TypeScript en modo estricto en todos los paquetes TS | must | E1-1 | `tsc --noEmit` pasa sin errores con `strict: true` |
| E1-3 | Worker Python tipado con validación de esquemas | must | E1-1 | El worker arranca y valida su configuración al iniciar |
| E1-4 | Docker Compose levanta web, worker, Postgres y Redis | must | E1-1, E1-3 | `docker compose up` deja el sistema accesible en el navegador |
| E1-5 | `.env.example` documentado y sin secretos | must | E1-4 | Contiene toda variable requerida; `.env` está en `.gitignore` |
| E1-6 | Lint, format, test y build en un solo comando | must | E1-2 | `npm run check` corre los cuatro y falla si alguno falla |
| E1-7 | CI en pull requests | should | E1-6 | Un PR con test roto no se puede fusionar |
| E1-8 | Escaneo de dependencias e imagen Docker | should | E1-7 | El pipeline reporta vulnerabilidades conocidas |
| E1-9 | README con instalación reproducible | must | E1-4, E1-5 | Una persona ajena levanta el proyecto siguiendo solo el README |
| E1-10 | Regla de lint que impide que `packages/domain` importe de `apps/` o `services/` | should | E1-6 | Una importación prohibida falla el lint (ADR-008) |

---

## 3. Épica E2 — Identidad y autorización

> **Criterio (§24):** ningún usuario puede consultar IDs de otra organización aunque manipule URL o API.

| ID | Historia | Prio | Bloqueada por | Aceptación |
|---|---|:--:|---|---|
| E2-1 | Login OIDC con Google Workspace | must | E1-4 | Un usuario del dominio de SmartPR inicia sesión; uno ajeno es rechazado |
| E2-2 | Modelo de `Organization` y `User` con rol | must | E2-1 | Se crea el usuario piloto con rol `admin` |
| E2-3 | Middleware que resuelve organización en cada petición | must | E2-2 | Ninguna ruta de dominio es accesible sin organización resuelta |
| E2-4 | Políticas de acceso por recurso | must | E2-3 | Consultar un recurso de otra organización devuelve 404, no 403 (no revela existencia) |
| E2-5 | Separación de entorno Agencia / vista TCL | must | E2-4 | Un usuario `cliente` no ve borradores, comentarios internos ni fuentes |
| E2-6 | Pruebas negativas de acceso automatizadas | must | E2-4 | Suite que intenta IDOR y escalamiento horizontal, y falla si alguno tiene éxito |
| E2-7 | Cierre de sesión y expiración de token | should | E2-1 | Un token expirado obliga a reautenticar con mensaje legible |

---

## 4. Épica E3 — Campañas y productos

> **Criterio (§24):** crear, editar, archivar y consultar campaña con permisos y registro de cambios.

| ID | Historia | Prio | Bloqueada por | Aceptación |
|---|---|:--:|---|---|
| E3-1 | Crear campaña (UI-04) con producto, mercado, fechas, responsable e idioma | must | E2-3 | La campaña aparece en la lista tras crearla |
| E3-2 | Lista de campañas con búsqueda y filtro (UI-03) | must | E3-1 | Filtrar por estado y buscar por nombre devuelve resultados correctos |
| E3-3 | Detalle de campaña (UI-05) con fuentes, brief, versiones y actividad | must | E3-1 | Todo lo asociado a la campaña es alcanzable desde una sola pantalla |
| E3-4 | Editar y archivar campaña | must | E3-1 | Archivar la saca de la lista activa sin borrarla |
| E3-5 | Catálogo mínimo de producto | must | E3-1 | Se puede asociar un producto existente o crear uno nuevo |
| E3-6 | `AuditEvent` en toda mutación de campaña | must | E3-4 | Cada cambio queda registrado con actor y fecha |
| E3-7 | Inicio operativo (UI-02) con campañas recientes y errores | should | E3-2 | Muestra lo pendiente sin tener que buscar |
| E3-8 | **Varios productos por campaña** (DEC-016) | must | E3-5 | Se asocian N productos con `rol`, `prioridad` y `participacionPresupuesto`; un producto no se repite en la misma campaña |
| E3-9 | Aviso cuando el reparto de presupuesto no suma 100% | should | E3-8 | El caso real del P80 (60/20/10 = 90%) genera una advertencia visible, no un bloqueo |

---

## 5. Épica E4 — Fuentes documentales

> **Criterio (§24):** procesar los formatos acordados sin bloquear la interfaz y conservar el original.

| ID | Historia | Prio | Bloqueada por | Aceptación |
|---|---|:--:|---|---|
| E4-1 | Carga de archivo con validación de MIME y tamaño (UI-06) | must | E3-1 | PDF, PPTX, DOCX, PNG y JPG se aceptan; otros se rechazan con mensaje claro |
| E4-2 | Vinculación de archivo existente en Drive por `fileId` | must | E4-1 | Renombrar el archivo en Drive no rompe el vínculo |
| E4-3 | Cálculo y almacenamiento de hash SHA-256 | must | E4-1 | Subir el mismo archivo dos veces se detecta como duplicado |
| E4-4 | Encolado de procesamiento asíncrono | must | E4-1, E1-4 | La interfaz responde de inmediato; el trabajo ocurre en segundo plano |
| E4-5 | Parser PPTX con localización de diapositiva | must | E4-4 | Cada fragmento sabe de qué diapositiva salió |
| E4-6 | Parser PDF y DOCX con localización de página | must | E4-4 | Cada fragmento sabe de qué página salió |
| E4-7 | OCR sobre imágenes y PDF escaneado | should | E4-6 | Un PDF sin capa de texto produce fragmentos utilizables |
| E4-8 | Estado de procesamiento visible (UI-07) con cola, avance y falla | must | E4-4 | El usuario ve en qué va y qué falló |
| E4-9 | Reintento de procesamiento fallido | must | E4-8 | Un fallo transitorio se recupera sin volver a cargar el archivo |
| E4-10 | Jobs idempotentes con backoff y límite de reintentos | must | E4-4 | Un job duplicado no produce fragmentos duplicados (ADR-007) |
| E4-11 | Descarga o consulta del original desde la plataforma | must | E4-2 | El original siempre es alcanzable, procesado o no |

---

## 6. Épica E5 — Esquema y extracción del brief

> **Criterio (§24):** los campos críticos cumplen el umbral del gold set y cada claim tiene evidencia.

| ID | Historia | Prio | Bloqueada por | Aceptación |
|---|---|:--:|---|---|
| E5-1 | Implementar el JSON Schema de D0-05 en `packages/domain` | must | E1-1 | Los dos ejemplos de D0-05 validan desde el código |
| E5-2 | Fragmentación y embeddings con filtro por organización y campaña | must | E4-5, E4-6 | Una búsqueda nunca devuelve fragmentos de otra campaña |
| E5-3 | Extracción estructurada contra el esquema | must | E5-1, E5-2 | La salida inválida no se persiste como versión aprobable |
| E5-4 | Confianza por campo y marca `not_found` | must | E5-3 | Un dato ausente se devuelve como `not_found`, nunca inventado |
| E5-5 | Detección de contradicción entre fuentes → `conflict` | must | E5-3 | Dos fuentes con valores distintos producen `conflict` con ambas evidencias |
| E5-6 | Vinculación de evidencia a campo con cita literal | must | E5-3 | Cada claim abre su fuente, página y cita |
| E5-7 | Revisión de extracción (UI-08) con confirmación de campos críticos | must | E5-4 | El consultor confirma o corrige antes de avanzar |
| E5-8 | Pantalla de evidencias (UI-11) que abre fuente, página y fragmento | must | E5-6 | Un clic en un claim muestra de dónde salió |
| E5-9 | Bloqueo de aprobación si un claim carece de evidencia | must | E5-6 | La transición a `approved` falla y explica por qué |
| E5-10 | **Claims anclados a producto** (DEC-016) | must | E5-6, E3-8 | En una campaña multiproducto, una especificación sin `productId` no se persiste; la clave del campo incluye el producto |

---

## 7. Épica E6 — Preguntas locales

> **Estado (26 de agosto de 2026):** E6-1 a E6-5 y E6-7 implementadas y probadas —
> ver el cierre de Sprint 3+4 en [HANDOFF.md](../../HANDOFF.md) y
> [D0-17](D0-17-cierre-sprint4.md). E6-6 (preguntas pendientes visibles en el
> detalle de campaña) cubierta parcialmente: el contador existe en
> `campanas/[id]/page.tsx`, sin el desglose por criticidad que sugiere la
> historia.

> **Criterio (§24):** toda pregunta puede resolverse, descartarse justificadamente o quedar visible como pendiente.

| ID | Historia | Prio | Bloqueada por | Aceptación |
|---|---|:--:|---|---|
| E6-1 | Generar preguntas por campo ausente o contradictorio | must | E5-4, E5-5 | Un `not_found` en campo crítico genera pregunta |
| E6-2 | Pantalla de preguntas (UI-09) con motivo visible | must | E6-1 | Cada pregunta explica por qué se generó |
| E6-3 | Responder pregunta con registro de autor y fecha | must | E6-2 | La respuesta queda atribuida |
| E6-4 | Descartar pregunta exigiendo justificación | must | E6-2 | No se puede descartar sin escribir el motivo |
| E6-5 | La respuesta alimenta una nueva versión sin mezclarse con lo extraído | must | E6-3 | El campo queda con `provenanceType: manual_local`, distinguible de lo extraído |
| E6-6 | Preguntas pendientes visibles en el detalle de campaña | should | E6-2 | No se puede aprobar ignorando preguntas críticas sin verlas |
| E6-7 | **Preguntas según el alcance del campo** (DEC-016) | must | E6-1, E3-8 | Un campo compartido se pregunta una vez; uno desenganchado, una vez por producto. Nunca la misma pregunta repetida N veces |

---

## 8. Épica E7 — Editor de brief

> **Estado (26 de agosto de 2026):** **parcial.** E7-1, E7-3 (validación contra
> el tipo del catálogo antes de guardar), E7-4, E7-5 y E7-9 implementadas.
> E7-2 cubierta como autoguardado al perder foco, no como indicador de
> guardado en curso. **E7-7 (protección contra edición concurrente) sí
> implementada** — vía `revision` optimista (`FIELD_REVISION_CONFLICT`), no
> vía bloqueo de edición. **E7-6 (comentarios internos) y E7-8 diferidas**:
> E7-6 no tiene ninguna pieza construida; el editor muestra los campos
> `compartido_con_excepcion` como fila única compartida; crear una excepción
> por producto («desenganchar») no tiene función de repositorio propia
> todavía. Detalle en [HANDOFF.md](../../HANDOFF.md) §5 y [D0-17](D0-17-cierre-sprint4.md).

> **Criterio (§24):** una falla del worker no impide completar y guardar el brief manualmente.

| ID | Historia | Prio | Bloqueada por | Aceptación |
|---|---|:--:|---|---|
| E7-1 | Editor por secciones estructuradas (UI-10) | must | E5-1 | Los diez bloques canónicos de D0-05 son editables |
| E7-2 | Autosave con indicador de estado de guardado | must | E7-1 | Una recarga accidental no pierde el trabajo |
| E7-3 | Validación de campos en vivo contra el esquema | must | E7-1 | Un valor inválido se señala antes de guardar |
| E7-4 | **Crear y completar un brief sin IA** | must | E7-1 | Con el flag de IA apagado, el flujo completo funciona |
| E7-5 | Evidencias visibles en panel lateral | must | E5-8, E7-1 | Al editar un claim se ve su respaldo sin cambiar de pantalla |
| E7-6 | Comentarios internos sobre campos | should | E7-1 | Un comentario queda asociado al campo y al autor |
| E7-7 | Protección contra edición concurrente | should | E7-2 | Dos pestañas editando no se sobrescriben en silencio |
| E7-8 | **Interruptor compartido / específico por producto** (DEC-016) | must | E7-1, E3-8 | En los cuatro bloques overridables, editar el compartido cambia todos los productos; declarar excepción desengancha solo uno y exige motivo |
| E7-9 | Selector de producto en el editor | must | E7-8 | Se alterna entre productos sin salir del brief; los bloques de campaña se ven iguales en todos |

---

## 9. Épica E8 — Versionado y aprobación

> **Estado (26 de agosto de 2026):** E8-1 conectada de verdad este incremento
> — antes existía en `packages/domain` pero ningún código la invocaba fuera
> de su propio test; ahora `transicionarBrief` (`packages/db`) es el único
> punto que cambia `brief_versions.status`. E8-4 cubierta hasta
> `internal_review` (UI-14 como botón condicionado por `allowedTransitions`,
> no como pantalla dedicada). **E8-2, E8-3, E8-5 a E8-9 sin implementar** —
> el ciclo de aprobación final queda para el siguiente incremento (DEC-027).

> **Criterio (§24):** no se puede editar una versión aprobada; una modificación crea una versión nueva.

| ID | Historia | Prio | Bloqueada por | Aceptación |
|---|---|:--:|---|---|
| E8-1 | Máquina de estados del brief en `packages/domain` | must | E1-1 | Toda transición valida rol, estado actual y datos mínimos |
| E8-2 | Versionado inmutable con `parentVersionId` | must | E8-1 | Una versión `approved` no admite `UPDATE` — bloqueado también en base de datos |
| E8-3 | Comparador de versiones (UI-12) | must | E8-2 | Las diferencias entre dos versiones son visibles campo por campo |
| E8-4 | Solicitud de revisión interna (UI-14) | must | E8-1 | El estado pasa a `internal_review` con actor registrado |
| E8-5 | Cambios solicitados con comentario obligatorio | must | E8-4 | Devolver exige explicar qué cambiar |
| E8-6 | Aprobación interna con registro de actor y fecha | must | E8-4 | Queda constancia de quién aprobó qué versión |
| E8-7 | Registro manual de la aprobación del cliente | must | E8-6 | El consultor registra el resultado externo (DEC-012) |
| E8-8 | Marcado automático como `superseded` | must | E8-2 | Crear una versión nueva marca la anterior, sin borrarla |
| E8-9 | Comentarios con visibilidad interna / cliente | should | E7-6 | Un comentario interno nunca es visible para TCL |

---

## 10. Épica E9 — Traducción y glosario

> **Criterio (§24):** la traducción registra versión de origen y permite corregir términos sin romper la relación.

| ID | Historia | Prio | Bloqueada por | Aceptación |
|---|---|:--:|---|---|
| E9-1 | Generar versión EN vinculada por `translationOfId` | must | E8-2 | Una versión EN sin origen no se puede crear |
| E9-2 | Pantalla de traducción ES/EN lado a lado (UI-13) | must | E9-1 | Ambas versiones se revisan simultáneamente |
| E9-3 | Glosario por producto con estado de término | must | E3-5 | Se pueden proponer y aprobar términos |
| E9-4 | Bloqueo de términos aprobados en la traducción | must | E9-3, E9-1 | Un término aprobado no se traduce de otra forma |
| E9-5 | Edición manual de la traducción sin romper el vínculo | must | E9-1 | Corregir el texto EN mantiene `translationOfId` |
| E9-6 | Diff de la traducción respecto a su origen | should | E9-2 | Se detecta cuándo ES cambió y EN quedó desactualizado |
| E9-7 | Las evidencias no se traducen | must | E9-1 | Una cita conserva el texto literal de su fuente |

---

## 11. Épica E10 — Exportación

> **Criterio (§24):** la exportación representa exactamente el contenido aprobado y declara idioma, campaña y versión.

| ID | Historia | Prio | Bloqueada por | Aceptación |
|---|---|:--:|---|---|
| E10-1 | Plantilla de exportación versionada | must | E5-1 | `templateVersion` queda registrado en cada export |
| E10-2 | Exportar a DOCX (UI-15) | must | E10-1, E8-6 | El archivo contiene exactamente la versión aprobada |
| E10-3 | Exportar a PDF | must | E10-1 | Mismo contenido que el DOCX |
| E10-4 | Portada y secciones configurables | should | E10-2 | Se puede incluir o excluir secciones sin editar código |
| E10-5 | Metadatos de versión, idioma y campaña en el archivo | must | E10-2 | Abrir el archivo permite saber a qué versión corresponde |
| E10-6 | Almacenamiento del export y registro en auditoría | must | E10-2 | Cada exportación queda registrada con actor |
| E10-7 | Descarga con URL firmada y expiración | should | E10-6 | Un enlace vencido deja de servir el archivo |
| E10-8 | **Exportación multiproducto con tabla comparativa** (DEC-016) | must | E10-2, E3-8 | Un documento: secciones compartidas una vez, sección por producto, y tabla comparativa de ficha técnica y precios — el formato que ya usa el brief P80 |

---

## 12. Épica E11 — Harness y observabilidad de IA

> **Criterio (§24):** cambiar un adaptador no exige modificar la lógica del dominio; una tarea puede desactivarse.

| ID | Historia | Prio | Bloqueada por | Aceptación |
|---|---|:--:|---|---|
| E11-1 | Puertos e interfaz de proveedor en `packages/domain` | must | E1-1 | El dominio no importa el SDK de ningún proveedor |
| E11-2 | Adaptador del primer proveedor | must | E11-1 | Las tareas de IA funcionan de punta a punta |
| E11-3 | Segundo adaptador (aunque sea local o simulado) | must | E11-2 | Cambiar de adaptador no modifica código de dominio — **prueba real del criterio** |
| E11-4 | Prompts versionados | must | E11-2 | `promptVersion` se registra en cada `AIRun` |
| E11-5 | Validación de salida contra esquema | must | E5-1, E11-2 | Una salida inválida no se persiste |
| E11-6 | Router mínimo por tarea y riesgo | should | E11-2 | Cada tarea usa el nivel de modelo definido en §9.2 |
| E11-7 | Registro de `AIRun` con costo, tokens, latencia y estado | must | E11-2 | Se puede consultar cuánto costó procesar una campaña |
| E11-8 | Reintentos controlados con límite | must | E11-2 | Un fallo del proveedor no genera un bucle de reintentos |
| E11-9 | **Feature flag de IA** | must | E11-2 | Apagarlo deja el sistema operable manualmente |
| E11-10 | Logs sin prompts, tokens ni PII | must | E11-7 | Una revisión de logs no encuentra contenido sensible |

---

## 13. Épica E12 — Auditoría y operación

> **Criterio (§24):** se puede reconstruir quién cambió, procesó, exportó o aprobó un brief y con qué versión.

| ID | Historia | Prio | Bloqueada por | Aceptación |
|---|---|:--:|---|---|
| E12-1 | `AuditEvent` en toda mutación sensible | must | E2-3 | Ninguna acción sensible ocurre sin registro |
| E12-2 | Pantalla de auditoría filtrable (UI-16) | must | E12-1 | Se filtra por actor, entidad, acción y fecha |
| E12-3 | Errores con `requestId` correlacionable | must | E1-4 | Un error en pantalla se puede rastrear en los logs |
| E12-4 | `GET /api/health` y `GET /api/ready` | must | E1-4 | Reportan estado de base de datos, Redis, Drive y proveedor de IA |
| E12-5 | Procedimiento de backup y restauración documentado | should | E1-4 | Existe un runbook, aunque el backup automático esté diferido (ADR-005) |
| E12-6 | Administración básica (UI-17): usuarios, glosario, plantillas | should | E2-2, E9-3 | El admin configura sin tocar la base de datos |
| E12-7 | Consulta de ejecuciones de IA con costo | should | E11-7 | Se ve el costo acumulado por campaña |

---

## 14. Épica E13 — Calidad y accesibilidad

> **Criterio (§24):** CI bloquea regresiones críticas y genera reporte de pruebas.

| ID | Historia | Prio | Bloqueada por | Aceptación |
|---|---|:--:|---|---|
| E13-1 | Tests unitarios de transiciones de estado | must | E8-1 | **100% de las transiciones** cubiertas (§27) |
| E13-2 | Tests de aislamiento entre organizaciones | must | E2-6 | Cobertura funcional completa del acceso cruzado |
| E13-3 | Tests de inmutabilidad de versiones aprobadas | must | E8-2 | Intentar modificar una versión aprobada falla en la prueba |
| E13-4 | Tests de la relación evidencia–campo | must | E5-6 | Un claim sin evidencia no pasa la validación |
| E13-5 | Tests de validación de archivos | must | E4-1 | MIME falsificado y tamaño excesivo se rechazan |
| E13-6 | Test del fallback manual | must | E7-4 | Con IA apagada, el flujo completo pasa |
| E13-7 | Tests de integración del flujo completo | must | E10-2 | De crear campaña a exportar brief aprobado, en una sola prueba |
| E13-8 | Evaluación contra el gold set (D0-13) | must | E5-3 | Se mide exactitud y groundedness; una regresión es visible |
| E13-9 | WCAG 2.1 AA en flujos críticos | must | E7-1 | Teclado, foco visible, etiquetas, contraste y lector de pantalla |
| E13-10 | Responsive desktop y tablet | should | E7-1 | El editor es usable en tablet |
| E13-11 | Reporte de pruebas generado por CI | should | E1-7 | Cada PR produce un reporte consultable |

---

## 15. Secuencia recomendada

Sprints de §25, con las historias asignadas. Cada sprint cierra con demo, evidencia de pruebas y decisiones nuevas — no basta con que compile (§25).

| Sprint | Foco | Historias | Demo esperada |
|---|---|---|---|
| **0** | Preparación | E1-1 a E1-10 | El proyecto levanta con `docker compose up` desde cero |
| **1** | Dominio y acceso | E2-1 a E2-7, E3-1 a E3-7 | Login, crear campaña, intentar acceso cruzado y ver que falla |
| **2** | Fuentes | E4-1 a E4-11 | Cargar un PPT real y verlo procesarse sin bloquear la pantalla |
| **3** | Extracción | E5-1 a E5-9, E11-1 a E11-5 | Un claim extraído que abre su diapositiva de origen |
| **4** | Construcción del brief | E6-1 a E6-6, E7-1 a E7-7 | Completar un brief **con la IA apagada** |
| **5** | Versiones y traducción | E8-1 a E8-9, E9-1 a E9-7 | Intentar editar una versión aprobada y ver que se crea una nueva |
| **6** | Aprobación y exportación | E10-1 a E10-7, E11-6 a E11-10 | Exportar el DOCX de una versión aprobada |
| **7** | Endurecimiento y piloto | E12-1 a E12-7, E13-1 a E13-11 | Suite de pruebas en verde y evaluación del gold set |

**Dos demos son las que realmente prueban el diseño:** la del Sprint 4 (funcionar sin IA) y la del Sprint 5 (inmutabilidad). Si esas dos fallan, el problema es arquitectónico, no de implementación.

---

## 16. Fuera de alcance

Confirmado en §15 y en `decision-log.md`. Ninguno de estos puntos entra a MVP 1 sin una decisión registrada nueva:

CRM de influencers · revisión de guiones o video · métricas y dashboards analíticos · workflow logístico · inventario y canjes · WhatsApp automático · publicación en redes · login de aprobación para TCL · scoring · firma electrónica · migración histórica masiva de Drive.

**Única excepción aprobada (ADR-004):** pantalla de solo lectura para TCL con estado y descarga del entregable. Corresponde a las historias E2-5 y E10-6, ya incluidas.

---

## 17. Cobertura de la Definition of Done

| Requisito (§23.1) | Estado |
|---|---|
| Backlog con épicas, historias, aceptación, prioridad y dependencias | ✅ 115 historias en 13 épicas |
| Dependencias verificables y sin ciclos | ✅ Toda dependencia apunta a una historia previa |
| Criterios de aceptación verificables | ✅ Redactados como observación o prueba, no como opinión |

## 18. Pendientes que afectan al backlog

| Punto | Historia afectada | Responsable | Cuándo |
|---|---|---|---|
| ~~¿Una campaña puede tener más de un producto?~~ | E3-5 | **Resuelto en DEC-016** | 11 ago 2026 |
| ¿Se puede revertir una aprobación interna? | E8-6 | Product owner | Antes del Sprint 5 |
| ¿Qué campos hacen un brief "completo" para aprobar? | E5-9 | Product owner | Antes del Sprint 3 |
| Proveedor de IA concreto | E11-2 | Product owner | Antes del Sprint 3 |
