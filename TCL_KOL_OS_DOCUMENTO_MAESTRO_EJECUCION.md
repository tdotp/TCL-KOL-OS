# TCL KOL OS

## Documento maestro de producto, ejecución, arquitectura y control de calidad

**Versión:** 2.0  
**Fecha:** 10 de agosto de 2026  
**Estado:** Base operativa para delegar MVP 0 y MVP 1  
**Responsable de producto y evaluación:** Gerencia del proyecto TCL KOL OS  
**Audiencia:** SmartPR, TCL Colombia, equipo de producto, agente de desarrollo, tecnología, seguridad, legal y operaciones  
**Moneda de referencia:** COP. Los valores son rangos preliminares de planeación, no cotizaciones contractuales.

---

## 0. Cómo utilizar este documento

Este archivo es la fuente de verdad para la construcción inicial de TCL KOL OS. Cumple cinco funciones:

1. Define el producto completo y sus límites.
2. Divide la visión en MVP acumulativos y verificables.
3. Especifica el trabajo que debe realizar el agente en MVP 0 y MVP 1.
4. Establece criterios técnicos, funcionales, de IA, seguridad y calidad.
5. Define el formato con el que se entregarán avances para evaluación de gerencia.

Cuando exista conflicto entre una conversación, una propuesta visual, un prototipo o una interpretación del agente, prevalece este documento hasta que se registre una decisión nueva en el apartado **Registro de decisiones**.

### Regla de cambio

Ningún cambio relevante de alcance debe implementarse silenciosamente. El agente debe registrar:

- decisión requerida;
- motivo;
- opciones consideradas;
- impacto en tiempo, costo, seguridad y arquitectura;
- recomendación;
- estado: pendiente, aprobada o rechazada.

---

# PARTE I — VISIÓN DEL PRODUCTO

## 1. Definición del producto

TCL KOL OS es una plataforma interna para coordinar campañas de influencers o KOL de TCL desde la recepción de la estrategia global hasta el cierre, medición y aprendizaje de cada campaña.

La plataforma conecta:

- campañas;
- briefs;
- fuentes globales y locales;
- productos TCL;
- KOL e influencers;
- documentos y aprobaciones;
- guiones y piezas de contenido;
- dispositivos entregados por canje o préstamo;
- publicaciones y métricas;
- evaluaciones, reportes y aprendizajes.

### 1.1 Propuesta de valor

TCL KOL OS debe reducir trabajo repetitivo, estandarizar criterios, anticipar riesgos y conservar trazabilidad. No busca retirar a la agencia del proceso; busca darle una mejor infraestructura operativa.

| Situación actual | Resultado esperado |
|---|---|
| Información distribuida en PPT, correo, WhatsApp y Drive | Cada campaña funciona como contenedor único con referencias a sus fuentes |
| Brief local construido manualmente | Brief bilingüe, estructurado, versionado y aprobado |
| Revisión dependiente de memoria y disponibilidad | Revisión asistida mediante rúbrica y evidencia |
| Poco control de fechas, responsables y dispositivos | Estados, SLA, alertas e inventario por colaboración |
| Reportes e histórico aislados | Datos comparables, scoring explicable y aprendizaje acumulado |

### 1.2 Lo que no es

- No es solo un dashboard.
- No es un chatbot genérico conectado a documentos.
- No reemplaza Google Drive, las redes sociales ni las herramientas de métricas.
- No aprueba briefs, guiones, videos ni publicaciones de forma autónoma.
- No es un ERP ni un sistema logístico completo.
- No es, en MVP 1, un portal para influencers.
- No promete medir datos que las plataformas externas no suministran legalmente.

### 1.3 Principio rector

> La IA asiste. Las decisiones y aprobaciones críticas permanecen bajo control humano.

---

## 2. Objetivos

### 2.1 Objetivo general

Reducir tiempos operativos, estandarizar procesos y mejorar la toma de decisiones en campañas KOL de TCL mediante una plataforma modular, bilingüe, trazable y asistida por IA.

### 2.2 Objetivos específicos

- Convertir materiales de China en un brief local consistente.
- Mantener una fuente única de verdad por campaña.
- Relacionar campañas, KOL, documentos, contenido y resultados.
- Reducir omisiones y errores en claims y especificaciones.
- Hacer visibles pendientes, responsables, fechas y riesgos.
- Conservar un histórico útil para futuras selecciones y decisiones.
- Permitir cambiar proveedores de IA sin reconstruir el producto.
- Separar la información interna de agencia de lo visible para TCL.

### 2.3 Indicadores globales

- tiempo desde recepción de fuentes hasta brief aprobado;
- porcentaje de campos completos;
- número de rondas de corrección;
- porcentaje de hallazgos con evidencia;
- tiempo de revisión por guion y video;
- entregas a tiempo;
- activos inmovilizados;
- costo de IA por tarea y campaña;
- campañas gestionadas en la plataforma;
- adopción y satisfacción de usuarios;
- tiempo de generación del reporte final.

---

## 3. Usuarios, entornos y permisos

### 3.1 Entorno Agencia

Es el espacio operativo. Debe incluir la información de trabajo, comentarios internos, fuentes, versiones, riesgos y tareas.

| Rol | Responsabilidad | Acceso base |
|---|---|---|
| Administrador | Usuarios, roles, integraciones, catálogos, auditoría | Total |
| Director o líder de cuenta | Campañas, briefs, aprobaciones internas, escalamiento | Alto |
| Consultor o PR Manager | Creación y seguimiento, fuentes, brief, comentarios | Operativo |
| Analista de datos | Métricas, validación, dashboards, reportes | Analítico |
| Legal o administrativo | Contratos, autorizaciones, facturas | Restringido por función |

### 3.2 Entorno TCL

Es un espacio de consulta, comentario, aprobación y evaluación. No debe exponer automáticamente toda la operación interna.

TCL podrá, según permisos:

- consultar campañas y estado general;
- revisar versiones habilitadas;
- comentar o aprobar entregables;
- consultar KPIs y reportes bilingües;
- acceder solo a documentos autorizados;
- evaluar campaña e influencer.

### 3.3 Entorno influencer

Es una evolución futura. No se construye en MVP 0 ni MVP 1. Durante las primeras fases, la agencia mantiene el contacto humano por los canales acordados y registra en la plataforma el resultado de esa interacción.

### 3.4 Regla de separación

Todo recurso debe tener al menos:

- organización propietaria;
- campaña;
- nivel de confidencialidad;
- visibilidad: interna, TCL o compartida;
- actor que lo creó;
- fecha y versión.

---

## 4. Flujo operativo completo

La campaña avanza por ocho etapas:

1. **Crear:** registrar campaña, producto, fechas, responsables y fuentes.
2. **Aterrizar:** convertir materiales globales en brief local ES/EN.
3. **Asignar:** seleccionar KOL y definir modalidad.
4. **Gestionar:** controlar documentos, acuerdos y producto.
5. **Revisar:** revisar guion, contenido y correcciones.
6. **Publicar:** aprobar y registrar publicación.
7. **Medir:** cargar o integrar métricas y compararlas con metas.
8. **Cerrar:** evaluar, documentar aprendizajes y alimentar histórico.

### 4.1 Fuente única de verdad

El brief aprobado es la referencia oficial para mensajes, claims, restricciones, producto y entregables. Un brief aprobado no se sobrescribe: cualquier cambio crea una nueva versión y una nueva ronda de aprobación.

### 4.2 Estado por colaboración

Una campaña puede tener varios KOL. El estado debe vivir en la relación campaña–KOL, no solo en la campaña general.

Estados futuros sugeridos:

`propuesto → aprobación_pendiente → acuerdo_confirmado → documentos_pendientes → producto_programado → producto_entregado → guion_pendiente → guion_recibido → cambios_solicitados → guion_aprobado → grabación → video_recibido → video_en_revisión → video_aprobado → publicación_pendiente → publicado → kpis_en_medición → evaluación_pendiente → cerrado`

---

## 5. Principios no negociables

1. **HITL:** toda decisión crítica tiene aprobación humana.
2. **Trazabilidad:** cambios, fuentes, modelos y decisiones quedan registrados.
3. **Evidencia visible:** claims y hallazgos técnicos deben apuntar a una fuente.
4. **Reglas antes que IA:** estados, permisos, fechas y cálculos se resuelven con software determinístico.
5. **IA desacoplada:** el sistema no depende de un único modelo.
6. **Bilingüe desde el modelo:** ES y EN son versiones relacionadas, no copias sueltas.
7. **Integrar antes que duplicar:** Drive conserva los archivos si la política lo permite.
8. **Privacidad por diseño:** mínimo acceso, mínima retención y exclusión de datos innecesarios.
9. **Fallback manual:** una falla de IA no puede bloquear el trabajo humano.
10. **Construcción modular:** no se levanta toda la plataforma en un solo contrato o lanzamiento.

---

# PARTE II — PIEZAS DEL SISTEMA

## 6. Módulos funcionales

| Código | Módulo | Responsabilidad |
|---|---|---|
| A | Brief Intelligence | Crear el brief local bilingüe, estructurado, trazable y aprobado |
| B | Gestión documental | Organizar archivos, contratos, recursos, permisos y versiones |
| C | Gestión de influencers | Perfil, canales, relación, histórico, resultados y evaluación |
| D | Revisión inteligente | Comparar guiones y contenido contra brief, fuentes y rúbricas |
| E | Workflow y alertas | Estados, responsables, fechas, SLA, pendientes y avisos |
| F | Inventario y canjes | Productos, seriales, entregas, devoluciones y transferencias |
| G | Analítica | KPIs operativos y de desempeño |
| H | Reportes | Cierres, resúmenes mensuales y aprendizajes ES/EN |
| I | Administración | Usuarios, roles, catálogos, prompts, modelos, integraciones y auditoría |

## 7. Piezas de experiencia

### 7.1 Navegación base

- Inicio operativo
- Campañas
- Briefs
- Fuentes y documentos
- Influencers
- Colaboraciones
- Revisiones
- Inventario
- Métricas y reportes
- Alertas
- Administración

### 7.2 Pantallas necesarias para MVP 1

| ID | Pantalla | Propósito |
|---|---|---|
| UI-01 | Acceso | Iniciar sesión con identidad autorizada |
| UI-02 | Inicio | Ver campañas recientes, tareas y errores de procesamiento |
| UI-03 | Lista de campañas | Buscar, filtrar y crear campañas |
| UI-04 | Nueva campaña | Capturar producto, mercado, responsables, fechas e idioma |
| UI-05 | Detalle de campaña | Reunir fuentes, brief, versiones, actividad y estado |
| UI-06 | Carga de fuentes | Cargar o vincular PPT, PDF, DOCX y ficha técnica |
| UI-07 | Estado de procesamiento | Mostrar cola, avance, fallas y reintento |
| UI-08 | Revisión de extracción | Confirmar campos, fuente y confianza |
| UI-09 | Preguntas de vacíos | Completar información local faltante o contradictoria |
| UI-10 | Editor de brief | Editar secciones estructuradas sin depender de IA |
| UI-11 | Evidencias | Abrir fuente, página o diapositiva asociada a un campo |
| UI-12 | Comparador de versiones | Ver diferencias entre versiones |
| UI-13 | Traducción ES/EN | Revisar versiones relacionadas y glosario |
| UI-14 | Aprobación | Solicitar revisión, comentar, aprobar o devolver |
| UI-15 | Exportación | Generar DOCX/PDF desde plantilla aprobada |
| UI-16 | Auditoría | Ver actor, acción, fecha, versión, modelo y fuentes |
| UI-17 | Administración básica | Usuarios, roles, glosario, plantillas y configuración de modelos |

### 7.3 Estados del brief

`draft`, `processing`, `extraction_review`, `local_questions`, `internal_review`, `internal_changes_requested`, `client_review`, `client_changes_requested`, `approved`, `superseded`, `cancelled`, `processing_failed`.

Una transición debe validar rol, estado actual y datos mínimos requeridos.

---

# PARTE III — ARQUITECTURA TÉCNICA

## 8. Decisión de arquitectura para MVP 0 y MVP 1

La implementación inicial será un monolito modular con procesos asíncronos separados. No se utilizará Kubernetes ni una red de microservicios.

### 8.1 Stack base fijado

| Capa | Selección | Uso |
|---|---|---|
| Aplicación web | Next.js + React + TypeScript | Portal Agencia y portal TCL |
| Núcleo de contenido y dominio | Payload CMS sobre Next.js | Colecciones, control de acceso, drafts, versiones y administración |
| Base de datos | PostgreSQL administrado | Dominio, auditoría, configuraciones y estados |
| Búsqueda semántica | pgvector | Embeddings filtrados por campaña, idioma y versión |
| Worker documental/IA | Python + FastAPI interno | Parsing, OCR, extracción, embeddings, traducción y exportación |
| Cola y caché | Redis + worker queue | Tareas largas, reintentos y control de concurrencia |
| Archivos originales | Google Drive, sujeto a aprobación | Repositorio principal y fuente de archivos |
| Storage auxiliar | S3 compatible administrado | Temporales, previews, exportaciones y derivados |
| Identidad | OIDC; Google Workspace inicialmente o Keycloak si se requiere | SSO, roles y separación por organización |
| Observabilidad | Logs estructurados + Sentry/OpenTelemetry | Errores, trazas, costo y latencia |
| Entrega | Docker Compose + CI/CD | Entornos reproducibles y despliegue controlado |

### 8.2 Justificación de la composición

- Payload acelera el modelo de dominio, versiones, permisos y panel interno.
- Next.js permite una experiencia propia para agencia y TCL.
- Python se reserva para el ecosistema documental e IA.
- PostgreSQL es la fuente de verdad; la cola no conserva estado de negocio definitivo.
- Drive guarda archivos; la aplicación guarda IDs, permisos, metadatos y relaciones.
- El proveedor de IA se conecta detrás de adaptadores del harness.

### 8.3 Límites de módulos

```text
apps/web
  portal agencia
  portal TCL
  admin
  API de dominio

services/ai-worker
  parsing
  OCR
  extracción
  RAG
  traducción
  exportación

packages/domain
  tipos
  estados
  permisos
  esquemas
  eventos

packages/ui
  componentes compartidos

packages/evals
  gold set
  métricas
  pruebas de prompts/modelos
```

### 8.4 Entornos

| Entorno | Uso | Datos |
|---|---|---|
| Desarrollo | Trabajo técnico | Ficticios o anonimizados |
| Staging/QA | Integración, demos y aceptación | Copias controladas y anonimizadas |
| Producción | Operación real | Datos reales, backups y controles completos |

MVP 1 debe poder ejecutarse localmente con Docker Compose y desplegarse en staging mediante un procedimiento documentado.

---

## 9. Arquitectura de IA

### 9.1 Flujo del harness

1. El usuario inicia una tarea.
2. El sistema valida identidad, permiso, campaña y estado.
3. El harness clasifica la tarea.
4. Recupera contexto mediante tools y RAG.
5. El router selecciona modelo según riesgo y complejidad.
6. La salida se valida contra un esquema.
7. Un humano revisa, edita, acepta o rechaza.
8. Se registra entrada, salida, modelo, costo, fuentes, versión y decisión.

### 9.2 Capacidades por tarea

| Tarea | Método | Nivel de modelo | Control |
|---|---|---|---|
| Extraer campos | Parser + esquema + modelo eficiente | Eficiente | Confirmación de críticos |
| Detectar vacíos | Reglas + análisis semántico | Equilibrado | Consultor responde |
| Traducir ES/EN | Modelo multilingüe + glosario | Eficiente | Revisión técnica |
| Redactar brief | Datos estructurados + plantilla | Equilibrado | Edición y aprobación |
| Encontrar evidencia | Filtro + búsqueda textual/vectorial | Sin generación o eficiente | Evidencia visible |
| Resolver ambigüedad | Análisis con fuentes | Avanzado solo si aporta | Nunca aprobación automática |

### 9.3 RAG

1. Conservar original y hash del archivo.
2. Extraer texto, tablas, notas y metadatos.
3. Aplicar OCR solo cuando sea necesario.
4. Crear fragmentos con página/diapositiva, sección, idioma, producto y versión.
5. Crear embeddings.
6. Filtrar obligatoriamente por organización, campaña, producto, idioma, versión y permiso.
7. Recuperar fragmentos relevantes.
8. Exigir `evidence[]` en claims y datos técnicos.
9. Registrar fragmentos usados.

### 9.4 Reglas anti-alucinación

- Si un dato crítico no aparece, devolver `not_found`; no completarlo por conocimiento general.
- Si dos fuentes se contradicen, crear una pregunta de conflicto.
- Una evidencia debe incluir archivo, versión, página o diapositiva y fragmento.
- Claims, nits, medidas, compatibilidades, precios, fechas y restricciones requieren evidencia.
- El texto generado debe distinguir hecho, inferencia y propuesta local.
- La salida inválida no se persiste como versión aprobable.

### 9.5 Tools iniciales

- `create_campaign`
- `attach_source`
- `get_campaign_sources`
- `extract_source`
- `get_brief_version`
- `search_evidence`
- `save_brief_version`
- `link_translation`
- `request_approval`
- `record_decision`
- `export_brief`
- `get_ai_run`

MCP es opcional. Para MVP 1 se prefieren APIs internas simples; MCP se añade cuando exista una necesidad real de exponer las tools a varios agentes o clientes.

---

## 10. Modelo de datos canónico

### 10.1 Entidades de MVP 1

| Entidad | Campos mínimos |
|---|---|
| Organization | id, name, type, status |
| User | id, email, name, organizationId, role, status |
| Campaign | id, organizationId, name, market, category, productId, ownerId, startDate, endDate, status |
| Product | id, brand, category, model, market, metadata |
| SourceDocument | id, campaignId, type, fileId, storageProvider, mimeType, hash, language, version, status, visibility |
| SourceFragment | id, sourceId, page, slide, section, text, metadata, embedding |
| Brief | id, campaignId, currentVersionId, status |
| BriefVersion | id, briefId, version, language, parentVersionId, translationOfId, content, status, createdBy |
| BriefField | id, briefVersionId, key, value, status, confidence, provenanceType |
| Evidence | id, briefFieldId, sourceId, fragmentId, page, quote, relation |
| LocalQuestion | id, campaignId, key, question, reason, status, answer, answeredBy |
| Approval | id, entityType, entityId, stage, status, requestedBy, decidedBy, comment, decidedAt |
| Comment | id, entityType, entityId, visibility, authorId, body, createdAt |
| GlossaryTerm | id, sourceLanguage, targetLanguage, sourceTerm, approvedTranslation, productId, status |
| Export | id, briefVersionId, format, templateVersion, fileId, createdBy |
| AuditEvent | id, organizationId, actorId, action, entityType, entityId, metadata, createdAt |
| AIRun | id, task, campaignId, provider, model, promptVersion, inputHash, outputStatus, latency, tokenUsage, estimatedCost, evidenceIds |

### 10.2 Entidades preparadas para evolución

No requieren interfaz completa en MVP 1, pero el diseño no debe bloquearlas:

- Influencer
- MediaOutlet
- Journalist
- CampaignCreator
- Deliverable
- ScriptVersion
- ContentAsset
- ContractDocument
- ProductAsset
- Publication
- MetricDefinition
- MetricSnapshot
- Evaluation
- Task
- Alert

### 10.3 Reglas de integridad

- No sobrescribir una versión aprobada.
- Cada traducción apunta a su versión de origen.
- Toda aprobación registra actor y fecha.
- Cada mutación sensible genera AuditEvent.
- La relación con Drive depende de `fileId` o `folderId`, nunca del nombre.
- `AIRun` no reemplaza `AuditEvent`; ambos cumplen funciones distintas.
- Los embeddings heredan permisos y alcance del documento de origen.

---

## 11. Contratos de API mínimos

Los nombres definitivos pueden variar, pero la capacidad debe existir.

### 11.1 Campañas

- `POST /api/campaigns`
- `GET /api/campaigns`
- `GET /api/campaigns/:id`
- `PATCH /api/campaigns/:id`

### 11.2 Fuentes

- `POST /api/campaigns/:id/sources`
- `GET /api/campaigns/:id/sources`
- `POST /api/sources/:id/process`
- `GET /api/sources/:id/status`
- `GET /api/sources/:id/fragments`

### 11.3 Briefs

- `POST /api/campaigns/:id/briefs`
- `GET /api/briefs/:id`
- `POST /api/briefs/:id/versions`
- `GET /api/briefs/:id/versions`
- `GET /api/brief-versions/:id/diff/:otherId`
- `POST /api/brief-versions/:id/translate`
- `POST /api/brief-versions/:id/submit`
- `POST /api/brief-versions/:id/approve`
- `POST /api/brief-versions/:id/request-changes`
- `POST /api/brief-versions/:id/export`

### 11.4 Evidencias y preguntas

- `GET /api/brief-versions/:id/evidence`
- `GET /api/campaigns/:id/questions`
- `PATCH /api/questions/:id`

### 11.5 Operación

- `GET /api/audit`
- `GET /api/ai-runs`
- `POST /api/ai-runs/:id/retry`
- `GET /api/health`
- `GET /api/ready`

### 11.6 Respuestas y errores

Toda API debe usar respuestas tipadas. Los errores deben incluir:

```json
{
  "error": {
    "code": "BRIEF_INVALID_TRANSITION",
    "message": "The brief cannot move from approved to draft.",
    "requestId": "...",
    "details": {}
  }
}
```

No se deben exponer prompts de sistema, tokens, rutas internas ni trazas sensibles al frontend.

---

## 12. Seguridad, privacidad y continuidad

### 12.1 Controles mínimos

- autenticación OIDC;
- RBAC por organización, rol, campaña, módulo y documento;
- TLS en tránsito y cifrado del proveedor en reposo;
- secretos fuera del repositorio;
- tokens OAuth cifrados;
- validación de tipo, tamaño y malware de archivos;
- URLs temporales para descargas sensibles;
- auditoría de acceso, cambio, aprobación y exportación;
- backups automáticos y prueba de restauración;
- rate limits en login, carga y tareas de IA;
- protección CSRF/XSS/SSRF y validación de uploads;
- dependencia e imagen Docker escaneadas;
- política de retención configurable;
- botón o flag para desactivar IA y operar manualmente.

### 12.2 Clasificación

| Nivel | Ejemplos | Tratamiento |
|---|---|---|
| Pública | Publicaciones y enlaces públicos | Acceso según rol |
| Interna | Brief, cronograma y recursos no publicados | Agencia y TCL autorizado |
| Confidencial | Estrategia, presupuesto, contrato y resultados | Acceso restringido y exportación controlada |
| Sensible/personal | Identidad, datos bancarios o tributarios | Minimización, cifrado, retención y acceso excepcional |

### 12.3 Exclusiones del índice vectorial

No indexar por defecto:

- documentos completos de identidad;
- datos bancarios o tributarios;
- contratos completos si solo se requiere su estado;
- videos completos;
- archivos de campañas no relacionadas;
- cualquier material cuyo permiso no pueda verificarse.

### 12.4 Continuidad

La aplicación debe permitir:

- crear y editar el brief sin IA;
- volver a intentar un procesamiento fallido;
- descargar o consultar el original;
- restaurar base de datos mediante procedimiento probado;
- identificar cuándo Drive, storage o IA no están disponibles;
- no perder una edición en curso por una tarea asíncrona fallida.

---

# PARTE IV — ROADMAP COMPLETO

## 13. Resumen de MVP

| MVP | Nombre | Resultado | Duración preliminar | Inversión preliminar |
|---|---|---|---:|---:|
| 0 | Descubrimiento y diseño | Producto validado y construible | 3–4 semanas | COP 8–15 M |
| 1 | Brief Intelligence | Brief ES/EN trazable y aprobado | 8–12 semanas | COP 55–90 M |
| 2 | Revisión de guiones | Revisión estandarizada con evidencia | 5–8 semanas | COP 30–55 M |
| 3 | Gestión documental | Drive, permisos y expedientes | 6–9 semanas | COP 35–65 M |
| 4 | Workflow, alertas e inventario | Control de tiempos y dispositivos | 8–12 semanas | COP 50–90 M |
| 5 | Perfiles y scoring | Histórico y evaluación explicable | 6–9 semanas | COP 35–65 M |
| 6 | Analítica y reportes | KPIs, dashboards y cierres ES/EN | 8–12 semanas | COP 45–95 M |
| 7 | Análisis de video | Validación técnica y narrativa asistida | 10–16 semanas | COP 70–180 M |

Las fases reutilizan infraestructura. La suma directa no equivale al precio contractual final.

---

## 14. MVP 0 — Descubrimiento y diseño

### Objetivo

Convertir la visión en especificaciones validadas, estimables y construibles.

### Incluye

- talleres con agencia, TCL, operaciones, legal, tecnología y seguridad;
- revisión de 5–10 campañas reales;
- mapa AS-IS y flujo TO-BE;
- inventario de roles, sistemas, documentos, datos y excepciones;
- plantilla de brief maestro y glosario bilingüe;
- modelo de datos;
- matriz de permisos y RACI;
- arquitectura de software e IA;
- prototipo navegable de pantallas críticas;
- backlog priorizado;
- criterios de aceptación y plan de pruebas;
- línea base operativa;
- estimación cerrada de MVP 1.

### No incluye

- software productivo;
- integraciones definitivas;
- automatizaciones para usuarios finales;
- migración histórica masiva.

### Criterio de salida

TCL y agencia aprueban flujo, roles, brief maestro, arquitectura y alcance contractual de MVP 1. Los riesgos abiertos tienen responsable y fecha.

---

## 15. MVP 1 — Brief Intelligence

### Objetivo

Reducir el tiempo entre la recepción de información global y la aprobación del brief local.

### Incluye

- login y roles básicos;
- campañas;
- fuentes PPT, PDF, DOCX y fichas técnicas;
- procesamiento asíncrono;
- extracción estructurada;
- detección de vacíos y contradicciones;
- preguntas para completar contexto local;
- editor estructurado;
- brief ES y EN vinculados;
- glosario técnico;
- evidencias por claim o campo crítico;
- versiones, comentarios y aprobaciones;
- exportación DOCX/PDF;
- auditoría;
- observabilidad de tareas de IA;
- modo manual y reintentos.

### No incluye

- CRM completo de influencers;
- revisión de guiones o video;
- métricas y dashboards avanzados;
- workflow logístico;
- inventario;
- WhatsApp automático;
- publicación en redes.

### Umbrales preliminares

- campos críticos correctamente extraídos: ≥ 95% en formatos soportados;
- claims y datos técnicos con evidencia: 100%;
- reducción de tiempo de brief: ≥ 40% frente a línea base;
- briefs rehechos por error del sistema: < 5%;
- satisfacción del piloto: ≥ 4/5;
- cero acceso cruzado entre organizaciones en pruebas;
- 100% de aprobaciones y cambios sensibles auditados.

---

## 16. MVP 2 — Revisión inteligente de guiones

Incluye registro básico de KOL, carga o pegado de guion, rúbrica configurable, validación de mensajes, claims, especificaciones, tono y restricciones, hallazgos por severidad, evidencia, comentarios editables, comparación de versiones, aprobación y salida bilingüe.

No incluye WhatsApp, firma, video, logística ni KPIs.

Puerta de decisión: demostrar ahorro de tiempo sin degradar calidad ni presentar opiniones sin evidencia.

## 17. MVP 3 — Gestión documental y Drive

Incluye OAuth, estructura canónica, explorador, metadatos, visibilidad, checklist, integridad de vínculos, búsqueda autorizada, versiones y auditoría.

No incluye firma electrónica avanzada, repositorio legal certificado ni migración completa del Drive histórico.

Puerta de decisión: Drive debe operar con scopes, permisos, integridad y propiedad de datos aceptables.

## 18. MVP 4 — Workflow, alertas e inventario

Incluye estados, SLA, responsables, home operativo, alertas, productos, seriales, modalidad, entrega, devolución, historial e indicadores por etapa.

No incluye integración con transportadoras, WhatsApp automático ni ERP completo.

Puerta de decisión: las alertas deben modificar el comportamiento operativo sin generar fatiga.

## 19. MVP 5 — Perfiles y scoring

Incluye ficha 360, canales, audiencias, afinidad, histórico, desempeño, evaluación de agencia y TCL, dimensiones explicables, comparación y reglas de vigencia.

Puede ampliarse posteriormente al CRM de periodistas y medios: periodista relacionado con medio y temas; medio con clasificación TIR variable por cliente; KOL con contenido, audiencia y métricas.

No incluye scraping masivo, predicción garantizada ni contratación automática.

Puerta de decisión: debe existir histórico suficiente y el score debe mostrar composición, fecha, faltantes y contexto.

## 20. MVP 6 — Analítica y reportes

Incluye dashboard de agencia y TCL, carga manual/CSV, conectores disponibles, KPIs por entidad, meta versus resultado, presupuesto, PR e influencer marketing diferenciados, reporte mensual y cierre ES/EN.

Superset puede incorporarse mediante vistas de solo lectura o data mart; nunca con acceso indiscriminado a tablas sensibles.

No incluye APIs no autorizadas, atribución avanzada sin datos ni tiempo real no soportado por la fuente.

## 21. MVP 7 — Análisis asistido de video

Incluye video, extracción de audio, transcripción, OCR, duración, orientación, resolución, audio básico, comparación con guion, timestamps, checklist de producto/logos/claims, versiones y piloto creativo.

No incluye edición automática, garantía de calidad creativa, moderación legal completa ni sentimiento como verdad definitiva.

Puerta de decisión: el ahorro medido debe superar costo, fricción, falsos positivos y riesgo de privacidad.

---

# PARTE V — ENCARGO DEL AGENTE: MVP 0 Y MVP 1

## 22. Mandato

El agente debe ejecutar MVP 0 y, una vez aprobada su puerta de decisión, construir MVP 1. No tiene autorización para ampliar alcance hacia MVP 2–7 sin una decisión registrada.

### 22.1 Regla de secuencia

1. Completar descubrimiento documental disponible.
2. Crear lista de información faltante.
3. Producir artefactos de MVP 0.
4. Presentar gate de aprobación.
5. Congelar alcance de MVP 1.
6. Construir por incrementos demostrables.
7. Ejecutar piloto y medir.

Si no están disponibles usuarios o documentos reales, el agente debe usar casos anonimizados/ficticios y marcar la validación de negocio como pendiente. No puede declarar MVP 0 aprobado por sí mismo.

---

## 23. Entregables obligatorios de MVP 0

| Código | Entregable | Formato mínimo |
|---|---|---|
| D0-01 | Resumen de descubrimiento | Markdown |
| D0-02 | Mapa AS-IS | Mermaid/BPMN + explicación |
| D0-03 | Flujo TO-BE | Mermaid/BPMN + estados y actores |
| D0-04 | Inventario de documentos | Tabla con origen, formato, dueño, sensibilidad y uso |
| D0-05 | Plantilla de brief maestro | JSON Schema + ejemplo ES/EN |
| D0-06 | Glosario bilingüe inicial | CSV/JSON versionado |
| D0-07 | Matriz de roles y permisos | Markdown/CSV |
| D0-08 | Modelo de datos | ERD + diccionario de datos |
| D0-09 | Arquitectura | Diagrama C4 o equivalente + ADR |
| D0-10 | Prototipo | Flujo navegable de pantallas críticas |
| D0-11 | Backlog | Épicas, historias, aceptación, prioridad y dependencias |
| D0-12 | Plan de pruebas | Funcional, seguridad, IA, accesibilidad y recuperación |
| D0-13 | Gold set inicial | Casos anonimizados con respuesta humana esperada |
| D0-14 | Línea base | Tiempo, errores y rondas de al menos cinco campañas |
| D0-15 | Estimación MVP 1 | Equipo, semanas, supuestos, riesgos y exclusiones |
| D0-16 | Registro de decisiones | ADR/decision log |

### 23.1 Definition of Done de MVP 0

- Los entregables D0-01 a D0-16 existen y son legibles.
- No hay campos críticos de arquitectura definidos únicamente como “por decidir” sin responsable.
- El brief maestro tiene esquema validable.
- Roles y permisos cubren Agencia y TCL.
- La arquitectura incluye seguridad, backups, observabilidad y fallback manual.
- El prototipo cubre UI-03 a UI-15.
- El backlog de MVP 1 tiene dependencias y criterios verificables.
- Los riesgos críticos tienen mitigación y propietario.
- Agencia y TCL registran aprobación o cambios solicitados.

---

## 24. Backlog técnico obligatorio de MVP 1

### Épica E1 — Base del repositorio

- monorepo documentado;
- TypeScript estricto;
- worker Python tipado;
- Docker Compose;
- `.env.example` sin secretos;
- lint, format, test y build;
- CI para pull requests;
- ADR de stack y despliegue.

**Aceptación:** una persona nueva puede ejecutar el proyecto desde README siguiendo pasos reproducibles.

### Épica E2 — Identidad y autorización

- OIDC;
- usuarios y organizaciones;
- roles;
- separación Agencia/TCL;
- middleware y políticas por recurso;
- pruebas de acceso negativo.

**Aceptación:** ningún usuario puede consultar IDs de otra organización aunque manipule URL o API.

### Épica E3 — Campañas y productos

- CRUD de campaña;
- catálogo mínimo de producto;
- responsables;
- fechas e idiomas;
- estados;
- auditoría.

**Aceptación:** crear, editar, archivar y consultar campaña con permisos y registro de cambios.

### Épica E4 — Fuentes documentales

- upload/vínculo;
- validación MIME/tamaño;
- hash;
- metadatos;
- almacenamiento original;
- procesamiento asíncrono;
- estado, reintento y error legible;
- extracción con localización de página/diapositiva.

**Aceptación:** procesar los formatos acordados sin bloquear la interfaz y conservar el original.

### Épica E5 — Esquema y extracción del brief

- JSON Schema de brief;
- mapeo de campos;
- extracción estructurada;
- confianza y `not_found`;
- conflictos;
- evidencias;
- revisión humana de campos.

**Aceptación:** los campos críticos cumplen el umbral del gold set y cada claim tiene evidencia.

### Épica E6 — Preguntas locales

- generar preguntas por campos ausentes o contradictorios;
- responder manualmente;
- registrar autor y fecha;
- usar la respuesta en nueva versión;
- no mezclar inferencia con dato confirmado.

**Aceptación:** toda pregunta puede resolverse, descartarse justificadamente o quedar visible como pendiente.

### Épica E7 — Editor de brief

- secciones estructuradas;
- autosave seguro;
- validación de campos;
- edición sin IA;
- comentarios;
- evidencias laterales;
- estado de guardado.

**Aceptación:** una falla del worker no impide completar y guardar el brief manualmente.

### Épica E8 — Versionado y aprobación

- drafts;
- versionado inmutable;
- diferencias;
- comentarios internos/cliente;
- solicitud de revisión;
- cambios solicitados;
- aprobación;
- superseded.

**Aceptación:** no se puede editar una versión aprobada; una modificación crea una versión nueva.

### Épica E9 — Traducción y glosario

- ES/EN vinculados;
- glosario por producto;
- bloqueo de términos aprobados;
- revisión humana;
- diff respecto al origen.

**Aceptación:** la traducción registra versión de origen y permite corregir términos sin romper la relación.

### Épica E10 — Exportación

- plantilla versionada;
- DOCX y PDF;
- portada y secciones configurables;
- metadatos de versión;
- almacenamiento y auditoría.

**Aceptación:** la exportación representa exactamente el contenido aprobado y declara idioma, campaña y versión.

### Épica E11 — Harness y observabilidad de IA

- adaptador de proveedores;
- prompt versionado;
- schemas;
- router mínimo;
- costo, tokens, latencia y estado;
- reintentos controlados;
- logs sin contenido sensible;
- feature flag de IA.

**Aceptación:** cambiar un adaptador no exige modificar la lógica del dominio; una tarea puede desactivarse.

### Épica E12 — Auditoría y operación

- AuditEvent;
- lista filtrable;
- errores y request ID;
- health/readiness;
- backups;
- restauración documentada;
- alertas de fallos críticos.

**Aceptación:** se puede reconstruir quién cambió, procesó, exportó o aprobó un brief y con qué versión.

### Épica E13 — Calidad y accesibilidad

- unit tests;
- integración;
- end-to-end;
- evaluación de IA;
- pruebas de permisos;
- WCAG 2.1 AA en flujos críticos;
- responsive desktop/tablet;
- performance básico.

**Aceptación:** CI bloquea regresiones críticas y genera reporte de pruebas.

---

## 25. Plan de construcción sugerido para el agente

### Sprint 0 — Preparación

- repositorio, convenciones, CI, Docker, ADR;
- esquema inicial;
- mock de identidad;
- casos de prueba y fixtures.

### Sprint 1 — Dominio y acceso

- organizaciones, usuarios, roles;
- campañas y productos;
- auditoría base;
- navegación inicial.

### Sprint 2 — Fuentes

- carga, storage, validación;
- jobs;
- parser PPT/PDF/DOCX;
- estado y reintento.

### Sprint 3 — Extracción

- esquema del brief;
- fragmentos, embeddings y evidencia;
- extracción estructurada;
- revisión de campos.

### Sprint 4 — Construcción del brief

- preguntas locales;
- editor;
- guardado;
- modo manual;
- evidencias.

### Sprint 5 — Versiones y traducción

- estados;
- versiones y diff;
- ES/EN;
- glosario.

### Sprint 6 — Aprobación y exportación

- flujo Agencia/TCL;
- comentarios;
- aprobación;
- DOCX/PDF.

### Sprint 7 — Endurecimiento y piloto

- permisos;
- auditoría;
- restauración;
- observabilidad;
- gold set;
- pruebas de usuario;
- medición de línea base versus piloto.

Cada sprint termina con demo, evidencia de pruebas, decisiones nuevas y lista de riesgos. Un sprint no se considera terminado únicamente porque el código compile.

---

## 26. Estructura mínima del repositorio

```text
/
├── apps/
│   └── web/
├── services/
│   └── ai-worker/
├── packages/
│   ├── domain/
│   ├── ui/
│   ├── config/
│   └── evals/
├── docs/
│   ├── architecture/
│   ├── decisions/
│   ├── product/
│   ├── security/
│   ├── api/
│   └── runbooks/
├── fixtures/
│   └── anonymized/
├── tests/
├── docker-compose.yml
├── .env.example
├── README.md
├── CONTRIBUTING.md
└── CHANGELOG.md
```

### Documentación técnica obligatoria en el repositorio

- instalación local;
- variables de entorno;
- arquitectura;
- modelo de datos;
- API;
- estados del brief;
- roles y permisos;
- proveedor de IA y cambio de adaptador;
- procesamiento documental;
- backup y restauración;
- despliegue;
- manejo de incidentes;
- evaluación del gold set;
- limitaciones conocidas.

---

## 27. Estándar de calidad de código

- tipado estricto;
- migraciones versionadas;
- ninguna credencial en Git;
- dependencias fijadas y revisadas;
- funciones de dominio separadas de controladores y componentes;
- idempotencia en jobs;
- reintentos con backoff y límite;
- timeouts en servicios externos;
- logs estructurados con request ID;
- errores de usuario diferentes de errores internos;
- fixtures anonimizados;
- pruebas de cada transición de estado;
- pruebas negativas de permisos;
- comentarios solo cuando expliquen una decisión no obvia;
- ADR para decisiones difíciles de revertir.

### Cobertura orientativa

No se persigue un porcentaje vacío. Se exige 100% de cobertura funcional sobre:

- transiciones de aprobación;
- aislamiento entre organizaciones;
- inmutabilidad de versiones aprobadas;
- relación evidencia–campo;
- validación de archivos;
- fallback manual;
- cálculo de métricas de evaluación.

---

## 28. Plan de pruebas

### Funcionales

- crear campaña;
- cargar cada formato soportado;
- procesar y reintentar;
- revisar extracción;
- responder vacíos;
- editar brief;
- traducir;
- solicitar cambios;
- aprobar;
- crear nueva versión;
- exportar.

### Seguridad

- acceso horizontal entre organizaciones;
- escalamiento de rol;
- IDOR;
- upload malicioso;
- tamaño excesivo;
- SSRF mediante URLs;
- expiración/revocación OAuth;
- filtración de secretos y PII en logs;
- permisos heredados de Drive;
- descarga con enlace vencido.

### IA

- exactitud de extracción;
- cobertura;
- groundedness;
- falsos positivos;
- consistencia;
- latencia;
- costo;
- tasa de aceptación humana;
- regresión entre prompt/modelo;
- documentos adversariales y prompt injection.

### Resiliencia

- caída del proveedor de IA;
- caída de Drive;
- job duplicado;
- worker reiniciado;
- timeout;
- archivo corrupto;
- restauración de backup;
- edición concurrente.

### UX y accesibilidad

- teclado;
- foco visible;
- etiquetas y errores;
- contraste;
- lector de pantalla en flujos críticos;
- responsive;
- prevención de pérdida de trabajo;
- claridad de estado de IA y aprobación.

---

# PARTE VI — EVALUACIÓN DE AVANCES

## 29. Formato de entrega de cada avance

Cada entrega del agente debe incluir:

```markdown
# Entrega [número] — [nombre]

## Alcance comprometido
## Alcance completado
## Lo que no se completó
## Demo o capturas
## Enlace o commit exacto
## Cómo ejecutar
## Migraciones incluidas
## Pruebas ejecutadas y resultados
## Evidencia de criterios de aceptación
## Riesgos o deuda técnica
## Decisiones requeridas
## Cambios respecto al documento maestro
## Siguiente incremento propuesto
```

No se aceptan descripciones como “ya funciona” sin pasos reproducibles y evidencia.

## 30. Paquete que Tato enviará a gerencia para evaluación

Para revisar cada avance se debe compartir, idealmente en un ZIP o repositorio:

- código;
- README;
- archivo `.env.example`;
- commit o versión;
- instrucciones de ejecución;
- capturas o video corto del flujo;
- credenciales de demo no sensibles, si aplican;
- reporte de pruebas;
- backlog actualizado;
- decisiones abiertas;
- lista de bugs conocidos;
- documentos o fixtures usados, anonimizados.

Si solo se comparte una captura, la evaluación será visual y parcial. Para evaluación técnica completa se necesita el repositorio o un paquete ejecutable.

## 31. Rúbrica de evaluación de gerencia

| Dimensión | Peso | Pregunta |
|---|---:|---|
| Alcance | 15% | ¿Construye exactamente lo acordado? |
| Flujo de negocio | 15% | ¿Representa el proceso real y sus excepciones? |
| Calidad técnica | 15% | ¿Es mantenible, tipado, probado y documentado? |
| Seguridad y permisos | 15% | ¿Separa organizaciones y protege datos? |
| Trazabilidad | 10% | ¿Se puede reconstruir fuente, versión y decisión? |
| Calidad de IA | 10% | ¿La salida es medible, evidenciada y corregible? |
| UX y accesibilidad | 10% | ¿El equipo puede operar sin fricción innecesaria? |
| Operación | 5% | ¿Hay logs, backups, reintentos y runbooks? |
| Documentación | 5% | ¿Otra persona puede continuar el trabajo? |

### Resultado

- **90–100:** aprobado para piloto.
- **75–89:** aprobado con correcciones menores.
- **60–74:** requiere correcciones antes de continuar.
- **< 60:** no aprobado; revisar alcance o implementación.

Un fallo crítico de seguridad, pérdida de datos, acceso cruzado o aprobación autónoma invalida la nota global hasta ser corregido.

## 32. Checklist rápido de revisión

- [ ] El proyecto arranca con las instrucciones entregadas.
- [ ] Las migraciones funcionan desde una base limpia.
- [ ] Agencia y TCL ven información distinta según permiso.
- [ ] Un documento se procesa sin bloquear la interfaz.
- [ ] Los errores permiten reintento.
- [ ] Un claim abre su evidencia.
- [ ] Los campos faltantes no son inventados.
- [ ] El brief puede completarse sin IA.
- [ ] ES y EN están vinculados.
- [ ] Una versión aprobada es inmutable.
- [ ] La exportación coincide con la versión aprobada.
- [ ] La auditoría registra actores y acciones.
- [ ] Los logs no contienen secretos ni PII innecesaria.
- [ ] Las pruebas de permisos fallan cuando deben fallar.
- [ ] Existe backup y procedimiento de restauración.

---

# PARTE VII — OPERACIÓN DEL PROYECTO

## 33. Equipo recomendado

| Rol | Dedicación de referencia |
|---|---:|
| Product owner / líder de negocio | 0,5–1 FTE |
| Product designer UX/UI | 0,5–1 FTE |
| Tech lead / backend | 1 FTE |
| Frontend engineer | 1 FTE |
| AI/data engineer | 0,5–1 FTE |
| QA | 0,5 FTE |
| DevOps/security | 0,2–0,4 FTE |
| Expertos de negocio | Participación puntual |

El agente puede cubrir varias funciones durante el prototipo, pero no puede autoaprobar decisiones de negocio, seguridad o aceptación.

## 34. Cadencia

- sprint de dos semanas;
- demo al cierre;
- refinamiento semanal;
- decisión log actualizado;
- pruebas con documentos reales anonimizados;
- revisión de calidad y costo de IA;
- piloto con 2–3 consultores;
- escalamiento solo después de medir.

## 35. Costos operativos preliminares

| Escenario | Rango mensual |
|---|---:|
| MVP austero | COP 0,4–1,2 M |
| Producción administrada | COP 1,5–4 M |
| Corporativo | COP 6–16 M+ |
| Soporte y mejora continua | COP 3–10 M |

No incluye licencias de Meltwater, firma, WhatsApp Business, plataformas de influencer marketing ni proveedores externos no definidos.

## 36. Riesgos principales

| Riesgo | Mitigación |
|---|---|
| Alcance excesivo | MVP, exclusiones y gates |
| Documentos variables | Formatos soportados, gold set y fallback |
| Fuentes incorrectas | prioridad, versión y aprobación |
| Alucinación | schemas, evidencia, `not_found` y RAG filtrado |
| Drive y OAuth | scopes mínimos y validación en MVP 0 |
| Baja adopción | diseño con usuarios y medición de carga |
| Dependencia de proveedor | harness y adaptadores |
| Costos variables | routing, límites y observabilidad |
| Datos sensibles | clasificación, minimización y RBAC |
| Scoring sesgado | dimensiones visibles y datos faltantes |
| Alert fatigue | severidad, digest y métricas de utilidad |
| Video costoso | piloto limitado y gate económico |

---

## 37. Decisiones pendientes que bloquean o condicionan MVP 1

| ID | Decisión | Responsable sugerido | Estado |
|---|---|---|---|
| DEC-001 | Nombrar product owner y contraparte TCL | SmartPR/TCL | Pendiente |
| DEC-002 | Elegir 5–10 campañas para descubrimiento | Operaciones | Pendiente |
| DEC-003 | Definir aprobaciones SmartPR/TCL/China | Negocio | Pendiente |
| DEC-004 | Definir plantilla final del brief | Agencia/TCL | Pendiente |
| DEC-005 | Definir propietario y estructura de Drive | TCL/SmartPR TI | Pendiente |
| DEC-006 | Autorizar OAuth y scopes | Seguridad/TI | Pendiente |
| DEC-007 | Definir nube, región y ambientes | Tecnología/seguridad | Pendiente |
| DEC-008 | Aprobar proveedor de IA y tratamiento de datos | Legal/seguridad | Pendiente |
| DEC-009 | Definir datos históricos utilizables | Legal/operaciones | Pendiente |
| DEC-010 | Definir formatos y tamaños soportados | Producto/tecnología | Pendiente |
| DEC-011 | Definir usuarios piloto | Product owner | Pendiente |
| DEC-012 | Definir si TCL aprueba dentro del MVP 1 | Negocio | Pendiente |

Estas decisiones no impiden crear la base técnica, pero sí impiden declarar MVP 1 listo para producción.

---

## 38. Registro de decisiones

Usar el siguiente formato:

```markdown
### ADR-XXX — Título

- Fecha:
- Estado: propuesta / aprobada / rechazada / reemplazada
- Contexto:
- Decisión:
- Alternativas:
- Consecuencias:
- Responsable de aprobación:
```

### ADR-001 — Arquitectura inicial

- **Fecha:** 10 de agosto de 2026
- **Estado:** propuesta base para validación en MVP 0
- **Decisión:** Next.js + Payload + PostgreSQL como núcleo; worker Python para documentos e IA; Redis para tareas; Drive sujeto a OAuth; S3 compatible para temporales.
- **Consecuencia:** velocidad de construcción sin acoplar dominio, IA y almacenamiento; se evita microservicios y Kubernetes en MVP 1.

### ADR-002 — Control de decisiones

- **Fecha:** 10 de agosto de 2026
- **Estado:** aprobado como principio de producto
- **Decisión:** la IA no aprueba briefs, guiones, videos, publicaciones ni evaluaciones finales.

### ADR-003 — Versionado

- **Fecha:** 10 de agosto de 2026
- **Estado:** aprobado como principio de datos
- **Decisión:** briefs aprobados son inmutables; cualquier cambio crea versión y aprobación nuevas.

---

## 39. Instrucción lista para entregar al agente

> Construye TCL KOL OS siguiendo `TCL_KOL_OS_DOCUMENTO_MAESTRO_EJECUCION.md`. Ejecuta primero MVP 0 y entrega D0-01 a D0-16. No declares aprobado el descubrimiento sin validación humana. Después del gate, construye únicamente MVP 1 mediante las épicas E1–E13. Conserva trazabilidad, aislamiento entre organizaciones, versionado inmutable, evidencia para claims, modo manual y arquitectura desacoplada de proveedores de IA. Cada avance debe incluir alcance, commit, instrucciones, pruebas, evidencia de aceptación, riesgos, decisiones abiertas y cambios respecto al documento maestro. No avances a MVP 2–7 ni agregues integraciones no autorizadas.

---

## 40. Próximo paso operativo

1. Entregar este documento al agente.
2. Recibir de su parte un plan de MVP 0, preguntas bloqueantes y propuesta de repositorio.
3. Revisar que no haya expansión de alcance.
4. Ejecutar y aprobar MVP 0.
5. Congelar el contrato funcional de MVP 1.
6. Construir, demostrar y evaluar incremento por incremento.
7. Enviar cada avance a gerencia usando el paquete del apartado 30.

---

**Fin del documento maestro.**
