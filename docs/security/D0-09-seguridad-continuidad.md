# D0-09 (anexo) — Seguridad, privacidad y continuidad

**Versión:** 1 · **Fecha:** 11 de agosto de 2026 · **Estado:** propuesta para validación
**Documento principal:** [`../architecture/D0-09-arquitectura.md`](../architecture/D0-09-arquitectura.md)
**Fuentes:** documento maestro §12 (seguridad, privacidad y continuidad), §28 (plan de pruebas); `docs/decisions/decision-log.md` (DEC-005 a DEC-009, ADR-005).

> Este anexo existe separado del documento de arquitectura por una razón concreta: la Definition of Done (§23.1) exige que la arquitectura *"incluya seguridad, backups, observabilidad y fallback manual"*. Mencionarlos de pasada dentro de un diagrama no permite verificar nada. Aquí cada control tiene estado y responsable.

---

## 1. Controles mínimos (§12.1)

| # | Control | Estado en MVP 1 | Responsable | Cómo se verifica |
|---|---|---|---|---|
| 1 | Autenticación OIDC | 🟢 En diseño (Épica E2) | Agente | Login funcional con Google Workspace |
| 2 | RBAC por organización, rol, campaña, módulo y documento | 🟢 En diseño (Épica E2) | Agente | Pruebas negativas de permisos (§28) |
| 3 | TLS en tránsito | 🟡 **Pendiente** — hoy corre en `localhost` sin TLS | Product owner | Al desplegar en el servidor propio |
| 4 | Cifrado en reposo del proveedor | 🔴 **No aplica** — disco local sin cifrado gestionado | Product owner | Al migrar a infraestructura gestionada |
| 5 | Secretos fuera del repositorio | 🟢 En diseño (Épica E1) | Agente | `.env.example` sin valores reales; `.env` en `.gitignore` |
| 6 | Tokens OAuth cifrados | 🟢 En diseño | Agente | Token de la cuenta de servicio cifrado en BD, nunca en logs |
| 7 | Validación de tipo, tamaño y malware de archivos | 🟡 **Parcial** — tipo y tamaño sí; antivirus no | Agente | MIME contra lista de DEC-010; límite de tamaño configurable |
| 8 | URLs temporales para descargas sensibles | 🟢 En diseño (Épica E10) | Agente | Enlaces firmados con expiración |
| 9 | Auditoría de acceso, cambio, aprobación y exportación | 🟢 En diseño (Épica E12) | Agente | `AuditEvent` en toda mutación sensible |
| 10 | Backups automáticos y prueba de restauración | 🔴 **Riesgo aceptado** — ver §4 | Product owner | ADR-005 |
| 11 | Rate limits en login, carga y tareas de IA | 🟡 Diferido — un solo usuario piloto | Agente | Se activa al incorporar más usuarios |
| 12 | Protección CSRF/XSS/SSRF y validación de uploads | 🟢 En diseño | Agente | Pruebas de seguridad del §28 |
| 13 | Dependencias e imagen Docker escaneadas | 🟡 **Pendiente** — no hay CI configurado aún | Agente | Al montar CI (Épica E1) |
| 14 | Política de retención configurable | 🟡 Diferido | Product owner | Antes del piloto |
| 15 | Flag para desactivar IA y operar manualmente | 🟢 En diseño (Épica E11) | Agente | Con IA apagada, el brief se completa igual |

**Leyenda:** 🟢 implementado en diseño · 🟡 pendiente o parcial, con responsable · 🔴 riesgo aceptado explícitamente

### 1.1 Lectura honesta de esta tabla

Cinco controles no están cubiertos en MVP 1 (los marcados 🟡 en 3, 7, 13, 14 y 🔴 en 4, 10). **Ninguno es un descuido**: todos derivan de que el sistema corre localmente para un solo usuario durante el piloto (DEC-007, DEC-011).

Lo que sí importa: **ninguno puede olvidarse al pasar a producción.** Esta tabla es la lista de verificación de ese momento. Un sistema que salga a producción con los controles 3, 4 y 10 sin resolver estaría en incumplimiento del propio documento maestro.

---

## 2. Clasificación de la información (§12.2)

| Nivel | Qué incluye en este proyecto | Tratamiento |
|---|---|---|
| **Pública** | Especificaciones de productos ya lanzados en China y Europa | Acceso según rol |
| **Interna** | Brief, cronograma, fuentes, recursos no publicados | Agencia y TCL autorizado |
| **Confidencial** | Estrategia, presupuesto, contratos, resultados | Acceso restringido y exportación controlada |
| **Sensible / personal** | Identidad, datos bancarios o tributarios | Minimización, cifrado, retención acotada, acceso excepcional |

### 2.1 Matiz específico de este proyecto (DEC-008)

La mayor parte del contenido de producto **ya es público** antes de llegar a Colombia, porque los productos existen en los mercados chino y europeo. Esto reduce sustancialmente la superficie de riesgo frente a un proyecto de lanzamiento mundial.

Dos excepciones que sí importan:

1. **Fechas de lanzamiento no anunciadas.** Es el único dato del brief con sensibilidad real. Para el piloto no se aplica una capa adicional de protección; queda anotado para escalar. La restricción operativa ya está capturada en el ejemplo de brief: *"No usar la fecha de lanzamiento global sin confirmación de TCL Colombia"*.
2. **Remuneración de influencers.** La gestiona la agencia de Brasil y **está fuera del alcance de este proyecto**. No entra al sistema, no se modela y no se indexa.

---

## 3. Exclusiones del índice vectorial (§12.3)

No se indexan por defecto, sin excepción:

| Excluido | Motivo |
|---|---|
| Documentos completos de identidad | Datos personales sin propósito de búsqueda |
| Datos bancarios o tributarios | Fuera de alcance del proyecto |
| Contratos completos, si solo se requiere su estado | Minimización: indexar el estado, no el clausulado |
| Videos completos | Costo desproporcionado frente al beneficio (entra en MVP 7 con criterio propio) |
| Archivos de campañas no relacionadas | Rompe el aislamiento por campaña |
| Material cuyo permiso no pueda verificarse | Si no se puede verificar, no se indexa |

**Regla de herencia:** los embeddings heredan organización, campaña, idioma, versión y permiso del documento origen (§10.3, regla 7). El filtrado se aplica **dentro de la consulta vectorial**, no como post-filtro sobre los resultados — un post-filtro deja rastro del contenido en la puntuación de similitud.

---

## 4. Continuidad y el riesgo de backup

### 4.1 Requisitos de continuidad (§12.4)

La aplicación debe permitir:

| Requisito | Estado | Cómo se cumple |
|---|---|---|
| Crear y editar el brief sin IA | 🟢 | Feature flag + editor manual (Épicas E7, E11) |
| Reintentar un procesamiento fallido | 🟢 | Estado `processing_failed` → reintento (Épica E4) |
| Descargar o consultar el original | 🟢 | El original se conserva íntegro en Drive |
| Restaurar base de datos con procedimiento probado | 🔴 | **No cubierto** — ver §4.2 |
| Identificar cuándo Drive, storage o IA no están disponibles | 🟢 | `GET /api/health` + estado por integración |
| No perder una edición en curso por una tarea asíncrona fallida | 🟢 | Autosave + separación entre edición y jobs (Épica E7) |

### 4.2 ADR-005 — riesgo de backup, en detalle

**Situación actual:** el sistema corre en la máquina local del product owner. No hay backup automático, ni copia externa, ni procedimiento de restauración probado.

**Qué se perdería si falla el equipo:** todas las campañas registradas, todos los briefs y sus versiones aprobadas, el histórico de auditoría y los embeddings. Los archivos originales **sobrevivirían** en Google Drive — que es la razón por la que el diseño insiste en que Drive conserve los originales y la aplicación solo guarde `fileId`.

**Alcance real del daño:** se perdería el trabajo de estructuración, no el material fuente. Reconstruirlo exigiría reprocesar todos los documentos y rehacer manualmente las respuestas a preguntas locales y las decisiones de aprobación.

**Por qué se acepta:** durante la fase de UI/UX temprana el valor de lo almacenado es bajo y el costo de operar infraestructura de backup no se justifica. El product owner lo aceptó explícitamente.

**Cuándo deja de ser aceptable — tres disparadores, cualquiera basta:**

1. Que entre al sistema la primera campaña real con brief aprobado que se vaya a usar operativamente.
2. Que se incorpore un segundo usuario.
3. Que el sistema se mueva al servidor propio de la agencia.

**Mitigación mínima cuando llegue ese momento:** `pg_dump` diario cifrado hacia almacenamiento externo S3-compatible, más una prueba de restauración documentada. Es barato y elimina el riesgo por completo.

**Mitigación disponible hoy, sin costo:** un `pg_dump` manual antes de cada sesión de trabajo significativa. No es automatización, pero convierte una pérdida total en una pérdida de una sesión.

---

## 5. Pruebas de seguridad exigidas (§28)

Estas pruebas son obligatorias y se detallan como casos ejecutables en D0-12:

| Prueba | Qué verifica |
|---|---|
| Acceso horizontal entre organizaciones | Un usuario de una organización no accede a recursos de otra |
| Escalamiento de rol | Un consultor no ejecuta acciones de administrador |
| IDOR | Manipular un ID en la URL o la API no expone recursos ajenos |
| Upload malicioso | Un archivo con MIME falsificado se rechaza |
| Tamaño excesivo | Un archivo sobredimensionado no tumba el worker |
| SSRF mediante URLs | Vincular una URL interna no permite alcanzar servicios del host |
| Expiración y revocación de OAuth | Un token revocado deja de funcionar y el error es legible |
| Filtración de secretos y PII en logs | Ningún log contiene tokens, prompts ni datos personales |
| Permisos heredados de Drive | Un documento sin permiso verificable no se indexa |
| Descarga con enlace vencido | Una URL firmada expirada deja de servir el archivo |

**La prueba que más importa** es la primera. El criterio de aceptación de la Épica E2 es tajante: *"ningún usuario puede consultar IDs de otra organización aunque manipule URL o API"*. Y la rúbrica de gerencia (§31) establece que un fallo de acceso cruzado **invalida la nota global** hasta ser corregido — no resta puntos, invalida.

---

## 6. Privacidad por diseño

| Principio (§5, §12) | Aplicación concreta |
|---|---|
| Mínimo acceso | RBAC por recurso; el cliente TCL ve estado y entregable, nada más |
| Mínima retención | Política configurable; `AIRun` no conserva el contenido del prompt |
| Exclusión de datos innecesarios | La remuneración de influencers no entra al sistema |
| Separación por organización | `organizationId` obligatorio en todo recurso |
| Trazabilidad sin exceso | `AuditEvent` guarda qué cambió, no necesariamente el contenido íntegro |

**Sobre logs y contenido sensible:** `AIRun` registra hashes, metadatos, costo y latencia — **no** el texto del prompt ni la respuesta completa. Esto cumple simultáneamente el requisito de observabilidad (§2.3) y el de no filtrar contenido sensible (Épica E11).

---

## 7. Cobertura de la Definition of Done

| Requisito (§23.1) | Estado |
|---|---|
| "La arquitectura incluye seguridad" | ✅ 15 controles con estado y responsable |
| "...backups" | ⚠️ Riesgo aceptado (ADR-005) con disparadores y mitigación definidos — no omitido |
| "...observabilidad" | ✅ Documento principal §8 |
| "...fallback manual" | ✅ §4.1, verificable con el feature flag de IA |
| Riesgos críticos con mitigación y propietario | ✅ §4.2 y tabla de §1 |

## 8. Lo que este anexo deja explícitamente abierto

| # | Punto | Responsable | Cuándo |
|---|---|---|---|
| 1 | TLS y cifrado en reposo | Product owner | Al desplegar fuera de local |
| 2 | Escaneo de dependencias e imagen Docker | Agente | Al montar CI (Épica E1) |
| 3 | Antivirus en uploads | Product owner | Antes de producción |
| 4 | Política de retención concreta | Product owner | Antes del piloto |
| 5 | Backup externo | Product owner | Al primer disparador de §4.2 |

Ninguno bloquea la construcción de MVP 1. **Todos bloquean el paso a producción.**
