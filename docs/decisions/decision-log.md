# D0-16 — Registro de decisiones

Formato según sección 38 del documento maestro (`TCL_KOL_OS_DOCUMENTO_MAESTRO_EJECUCION.md`). Este archivo es la fuente de verdad de decisiones tomadas; se actualiza por incremento, nunca se reescribe una entrada ya aprobada.

---

## Decisiones de la sección 37 (DEC-001 a DEC-012)

Resueltas en sesión `/grill-me` del 10 de agosto de 2026. Estado: **aprobadas**.

### DEC-001 — Product owner y contraparte TCL

- **Decisión:** Gerardo Calambás (Gerencia del proyecto) es el product owner con autoridad total de decisión sobre TCL KOL OS. La contraparte formal en TCL Colombia queda pendiente de nombrar por parte del cliente, no bloquea el arranque de MVP 0.
- **Responsable de aprobación:** Gerardo Calambás.

### DEC-002 — Campañas para descubrimiento

- **Decisión:** Existe un histórico de ~2–3 meses de campañas disponible sin restricción de uso. La selección concreta de las 5–10 campañas para el análisis AS-IS (D0-02, D0-14) se hace durante la ejecución de MVP 0, no como prerrequisito.
- **Consecuencia:** D0-14 (línea base) queda bloqueado hasta recibir documentos/datos de campañas reales.

### DEC-003 — Matriz de aprobaciones SmartPR / TCL / China

- **Decisión:** El flujo real es: TCL China entrega material fuente (PPT) → SmartPR construye el brief internamente, cruzando ese material con lo que entrega el cliente (TCL Colombia), guiado por preguntas directas de la herramienta → el brief se envía al cliente (TCL Colombia) para su visto bueno. TCL China no participa como aprobador, solo como fuente.
- **Consecuencia:** El módulo de aprobación (Épica E8) modela un solo nivel de aprobación externa (cliente TCL Colombia), no una cadena multinivel con China.

### DEC-004 — Plantilla y materiales existentes

- **Decisión:** Sí existe estándar de materiales: ficha técnica y brief que entrega el cliente. El usuario aportó tres referencias de formato de brief (Brief Estratégico formato maestro, Brief de Campaña – Producto, one-pager "THE BRIEF") como insumo para D0-05.
- **Consecuencia:** D0-05 se construye como síntesis de los tres formatos, no partiendo de cero.

### DEC-005 — Propietario y estructura de Drive

- **Decisión:** El Google Drive de campañas es propiedad de SmartPR (agencia), no de TCL. No hay fricción de permisos cruzados entre organizaciones para el acceso base.

### DEC-006 — Autorización OAuth y scopes

- **Decisión:** SmartPR opera con Google Workspace corporativo de dominio propio. La integración usa una cuenta de servicio con delegación a nivel de dominio, restringida al Drive compartido de campañas — nunca las credenciales personales de un usuario.

### DEC-007 — Nube, región y ambientes

- **Decisión:** Desarrollo corre localmente (Docker Compose) en la máquina de trabajo. El servidor propio de la agencia ("BPS": ~16 GB RAM, ~100 GB almacenamiento, hoy subutilizado) se perfila como destino de staging/uso compartido cuando la UI/UX esté estable. No hay compromiso con un proveedor cloud gestionado en esta fase.
- **Riesgo aceptado:** No hay backup externo automatizado mientras todo corra localmente/en el servidor propio. El product owner acepta explícitamente este riesgo y lo revisará cuando exista UI/UX funcional con interacciones reales. Ver ADR-005.

### DEC-008 — Proveedor de IA y tratamiento de datos

- **Decisión:** No hay restricción de proveedor de IA. La mayoría de la información de producto ya es pública (mercados de China y Europa). El único dato con sensibilidad real son fechas de lanzamiento no anunciadas; para el piloto no se requiere una capa de protección adicional, pero se deja anotado como algo a escalar en fases posteriores. Los datos de pago a influencers (agencia de Brasil) están fuera de alcance de este proyecto.

### DEC-009 — Datos históricos utilizables / anonimización de fixtures

- **Decisión:** Se autoriza usar datos reales/antiguos sin anonimizar en esta primera etapa (no hay riesgo legal identificado). El modelo de datos debe conservar los campos de confidencialidad y visibilidad ya definidos en la sección 10.3/12.2 del documento maestro, de modo que la anonimización pueda activarse más adelante sin refactor mayor.

### DEC-010 — Formatos y tamaños soportados

- **Decisión:** Formatos soportados en MVP 1: PDF, PPTX, DOCX, PNG, JPG. Referencia de tamaño: documentos de texto ~4 MB; los PPT pueden pesar sustancialmente más por su estructura y deben soportarse sin bloquear la interfaz (Épica E4).

### DEC-011 — Usuarios piloto

- **Decisión:** El piloto inicial de MVP 1 opera con un único usuario (el product owner) en rol admin general con todos los permisos. Los roles de consultor, director, analista y legal se definen y prueban en un incremento posterior.

### DEC-012 — Alcance del acceso de TCL en MVP 1

- **Decisión:** TCL no tiene login de aprobación dentro de la plataforma en MVP 1; la aprobación sigue siendo gestión directa de los consultores con el cliente, fuera del sistema.
- **Excepción de alcance aprobada:** se autoriza una vista mínima de solo lectura para TCL — estado de campaña + descarga del brief/reporte aprobado — visible únicamente a partir del envío. Esto es una ampliación puntual sobre el "No incluye: métricas y dashboards avanzados" original de MVP 1 (sección 15); no incluye KPIs de desempeño ni comparación de metas, eso permanece en MVP 6. Ver ADR-004.
- **Responsable de aprobación:** Gerardo Calambás.

---

## ADRs técnicos

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

### ADR-004 — Excepción de alcance: vista de estado para TCL en MVP 1

- **Fecha:** 10 de agosto de 2026
- **Estado:** aprobada
- **Contexto:** el documento maestro excluye explícitamente "métricas y dashboards avanzados" de MVP 1 (sección 15). El product owner solicitó que TCL pueda ver estado y descargar reportes desde el piloto.
- **Decisión:** se agrega a MVP 1 una pantalla de solo lectura para TCL (estado de campaña + descarga de brief/reporte aprobado), sin KPIs ni comparación de metas.
- **Alternativas consideradas:** (1) no dar nada a TCL hasta MVP 6 — descartada, el product owner quiere algo tangible desde el piloto; (2) dashboard analítico completo — descartada, duplicaría trabajo de MVP 6 y no está en Épicas E1-E13.
- **Consecuencias:** requiere un endpoint de solo lectura adicional y una pantalla nueva no listada originalmente en 7.2; no afecta el modelo de datos (usa `Campaign.status` y `Export` ya definidos en sección 10.1).
- **Responsable de aprobación:** Gerardo Calambás.

### ADR-005 — Riesgo de backup aceptado en fase local

- **Fecha:** 10 de agosto de 2026
- **Estado:** aprobado como riesgo abierto, no como excepción permanente
- **Contexto:** la sección 12.1 exige backups automáticos y prueba de restauración incluso en producción. Durante el piloto, todo corre localmente o en el servidor propio de la agencia ("BPS"), sin backup externo gestionado.
- **Decisión:** se acepta el riesgo mientras el proyecto esté en fase local/UI-UX temprana. Se revisará cuando exista una versión funcional con interacciones reales de usuarios piloto.
- **Consecuencias:** pérdida de datos posible sin recuperación si falla el único servidor. Debe quedar visible como deuda técnica en cada entrega (sección 29 — "Riesgos o deuda técnica"), no resolverse silenciosamente ni olvidarse.
- **Responsable de aprobación:** Gerardo Calambás.

### ADR-006 — Payload CMS embebido en Next.js

- **Fecha:** 11 de agosto de 2026
- **Estado:** aprobada
- **Contexto:** Payload puede desplegarse como servicio independiente o embebido dentro de la aplicación Next.js. El documento maestro fija el stack (§8.1) pero no la topología.
- **Decisión:** Payload corre embebido en `apps/web`, compartiendo proceso y base de datos.
- **Alternativas consideradas:** servicio separado — descartada porque duplicaría la superficie de despliegue y de autenticación sin beneficio a la escala de un solo usuario piloto (DEC-011), y contradiría la decisión de monolito modular de ADR-001.
- **Consecuencias:** un solo proceso web que levantar en Docker Compose; el panel administrativo comparte sesión con la aplicación. Si en el futuro se requiere escalar el CMS por separado, la migración exige extraer también su capa de acceso a datos.
- **Responsable de aprobación:** Gerardo Calambás.

### ADR-007 — Redis no conserva estado de negocio

- **Fecha:** 11 de agosto de 2026
- **Estado:** aprobada
- **Contexto:** Redis actúa como cola de tareas largas y caché (§8.1). Es tentador guardar en él estado intermedio del procesamiento de documentos.
- **Decisión:** Redis solo contiene trabajo en tránsito. Todo estado de negocio definitivo vive en PostgreSQL. Perder Redis significa perder trabajo encolado, nunca información.
- **Alternativas consideradas:** usar Redis como almacén de estado de jobs — descartada porque haría que una caída del contenedor produjera pérdida de datos irrecuperable, y porque contradice §8.2 del documento maestro.
- **Consecuencias:** todo job debe ser idempotente y reconstruible desde PostgreSQL (§27). Un worker reiniciado retoma sin duplicar efectos. Añade una escritura a base de datos por transición de job.
- **Responsable de aprobación:** Gerardo Calambás.

### ADR-008 — `packages/domain` sin dependencias hacia aplicaciones

- **Fecha:** 11 de agosto de 2026
- **Estado:** aprobada
- **Contexto:** las transiciones de estado del brief, las reglas de permiso y los esquemas son necesarios tanto en `apps/web` como en `services/ai-worker`. Sin una regla explícita, terminan duplicados en ambos.
- **Decisión:** `packages/domain` no importa nada de `apps/` ni de `services/`. La dependencia es unidireccional. Las transiciones y permisos tienen una sola implementación, que vive ahí.
- **Alternativas consideradas:** implementar validaciones en cada aplicación — descartada porque garantiza divergencia: una regla corregida en la interfaz y no en el worker produce estados inválidos persistidos.
- **Consecuencias:** hace verificable el estándar de §27 ("funciones de dominio separadas de controladores y componentes"). Exige disciplina en las importaciones, comprobable con una regla de lint. El worker en Python consume las reglas vía contratos de esquema, no importando código TypeScript.
- **Responsable de aprobación:** Gerardo Calambás.

---

## Decisiones surgidas del material real (11 de agosto de 2026)

El material operativo entregado por el product owner (ver [D0-14](../product/D0-14-linea-base.md)) contradijo dos supuestos registrados y aclaró un tercero. **Las tres quedaron resueltas el mismo día.**

### DEC-013 — Tratamiento de datos personales de KOL

- **Fecha:** 11 de agosto de 2026
- **Estado:** **aprobada**
- **Contexto:** D0-04 clasificó los documentos de identidad y datos personales como nivel *sensible/personal* y fuera de alcance, asumiendo que no entraban al proceso. El archivo `LISTADO DIRECCIONES C7L & X11L.xlsx` demuestra lo contrario: contiene ~13 cédulas, ~6 celulares y ~36 direcciones residenciales completas de personas identificadas por nombre.
- **Aclaración del product owner:** estos datos tienen **finalidad contable** — se usan para ejecutar los pagos y establecer a quién se le paga, además de entregar el producto físico. SmartPR ya gestiona el cumplimiento de Habeas Data como agencia, por lo que no hay un riesgo legal abierto.
- **Decisión:** los datos personales de KOL viven en una **entidad separada, cifrada a nivel de campo, excluida del índice vectorial y de `SourceFragment`**, con acceso restringido por rol. La separación se diseña **ahora**, aunque la funcionalidad que los usa (gestión de entregas) corresponda a MVP 4.
- **Alternativas consideradas:** (1) tratarlos como un campo más del perfil de KOL — descartada porque haría que cualquier consulta o exportación del perfil arrastrara datos personales; (2) diferir la decisión a MVP 4 — descartada por criterio explícito del product owner: separar datos ya cargados es sustancialmente más caro que diseñarlo separado desde el inicio.
- **Consecuencias:** el cifrado en reposo deja de ser diferible cuando llegue MVP 4 (control 4 del anexo de seguridad). La clasificación *sensible/personal* de §12.2 pasa a estar **dentro** del alcance operativo, no solo en teoría. Exige política de retención declarada antes de MVP 4.
- **Responsable de aprobación:** Gerardo Calambás.

### DEC-014 — Compensación económica de KOL

- **Fecha:** 11 de agosto de 2026
- **Estado:** **aprobada** — confirma y precisa DEC-008
- **Contexto:** DEC-008 estableció que los datos de pago a influencers los maneja la agencia de Brasil y están fuera de alcance. El archivo de propuestas incluye `TOTAL BUDGET`, `Payment by Product` y `Payment in Cash` por cada KOL.
- **Decisión:** se confirma la separación. **SmartPR Colombia no toca nada del lado de Brasil.** El presupuesto propuesto por KOL que aparece en las hojas de propuesta es planeación propia de SmartPR; la ejecución del pago permanece íntegramente fuera del proyecto.
- **Consecuencias:** el modelo de datos puede alojar el presupuesto propuesto por colaboración cuando llegue MVP 5, clasificado como *confidencial*. Ninguna funcionalidad de pago, facturación o tesorería entra al alcance de TCL KOL OS en ninguna fase.
- **Responsable de aprobación:** Gerardo Calambás.

### DEC-015 — El brief maestro es un formato propio de SmartPR

- **Fecha:** 11 de agosto de 2026
- **Estado:** **aprobada** — corrige el encuadre de DEC-004
- **Contexto:** DEC-004 registró tres formatos de brief y D0-05 los trató como tres fuentes equivalentes a fusionar en un esquema canónico. La llegada de un cuarto formato real (`TCL_P80_Brief_Contenidos.docx`) obligó a revisar el encuadre.
- **Aclaración del product owner:** los formatos recibidos del cliente son **entradas de referencia**, no plantillas de salida. El producto funciona así: *el sistema formula una serie de preguntas; la IA revisa el material disponible (PPT de China, brief del cliente, fichas técnicas) contra esas preguntas; y produce una bajada en **el formato propio de SmartPR***.
- **Decisión:** se distinguen formalmente dos cosas que estaban mezcladas:
  - **Formatos de entrada** (variables, del cliente y de TCL China): Brief Estratégico, Brief P80, one-pager "THE BRIEF", PPT global, ficha técnica. El sistema los lee; no los replica.
  - **Formato de salida** (único, de SmartPR): el "Brief de Campaña – Producto" de 10 secciones es la **propuesta vigente** de ese formato, sujeta a cambios sin fricción.
- **Consecuencia sobre el diseño:** los diez bloques canónicos del esquema son la estructura interna; el formato de salida de SmartPR es una **plantilla de renderizado** sobre ellos, versionada mediante `Export.templateVersion` (D0-08 §2.11). Cambiar el formato de salida no exige cambiar el esquema ni migrar datos — que es precisamente la razón por la que se diseñó con bloques canónicos.
- **Consecuencia sobre las preguntas locales:** el conjunto de preguntas **se deriva de los campos del formato de SmartPR**, no se inventa por campaña. Esto convierte a `LocalQuestion` (Épica E6) en un componente central del producto, no en un mecanismo auxiliar de relleno de vacíos.
- **Responsable de aprobación:** Gerardo Calambás.

### DEC-016 — Campañas con varios productos

- **Fecha:** 11 de agosto de 2026
- **Estado:** **aprobada**
- **Contexto:** el modelo asumía un producto por campaña. El material real lo desmiente en tres formas distintas:
  1. **Línea con gamas** — el brief `TCL_P80_Brief_Contenidos.docx` es una campaña con tres productos (P80, P80 Pro, P80 Ultra), con reparto de presupuesto 60/20/10, prioridad Ultra > Pro > básico y competencia mapeada por modelo.
  2. **Productos complementarios** — `LANZAMIENTO MONITORES` (27G64 y 25G64), la hoja `C7L y X11L`, o un televisor con su barra de sonido.
  3. **Campañas de temporada** — `BLACK DAYS`, `Mothers`, y las que vienen (San Valentín, Amor y Amistad), que agrupan productos que pueden o no compartir narrativa.
- **Decisión:** una campaña admite varios productos, gobernados por una **regla de tres niveles** sobre los bloques canónicos del brief:

  | Nivel | Bloques | Comportamiento |
  |---|---|---|
  | Siempre de campaña | `contexto` · `objetivo` · `accion_kpis` · `practico` · `entregable_creativo` | Únicos, compartidos |
  | Siempre por producto | `marca_producto` | Se repite, uno por producto |
  | Compartido con excepción | `target_audiencia` · `problema_insight` · `mensaje_principal` · `mandatorios` | Únicos por defecto; un producto puede declarar el suyo |

- **Alternativas consideradas:**
  - *Tratar cada producto como una campaña aparte* — descartada: triplicaría contexto, objetivo, audiencia e insight, y contradice el material (el brief P80 es un solo documento para tres productos).
  - *Clasificar la campaña por tipo al crearla (línea / bundle / temporada)* — descartada: obliga a acertar la clasificación antes de tener el material, y envejece mal. La estructura se revela sola según existan o no excepciones.
  - *Hacer todos los bloques overridables* — descartada: `contexto` y `practico` son de la ocasión comercial, no del producto. Permitir excepciones ahí invita a duplicar información que debe ser única.
- **Consecuencias:**
  - Nueva relación `CampaignProduct` con `rol` (flagship / secundario / entrada), `prioridad` y `participacionPresupuesto`.
  - En el esquema, `marca_producto` pasa de objeto a arreglo, y aparece un `overrides[]` opcional por producto.
  - Las claves de campo quedan ancladas al producto: `marca_producto[prd-x].especificaciones`. Sin esto, una especificación en una campaña de tres modelos es ambigua — el tipo de error que ya corrigieron a mano en el guion de David Osorio ("288hz vrr o sino 144hz nativos").
  - La exportación produce un documento con secciones compartidas, secciones por producto y **tabla comparativa** — el formato que el propio brief P80 ya usa en "FICHA TÉCNICA Y PRECIOS".
  - Las preguntas locales siguen la misma regla: una vez si el campo es compartido, una por producto si está desenganchado.
  - Impacto estimado: 3–5 sesiones adicionales sobre D0-15, repartidas entre las épicas E3, E5, E7 y E10.
- **Responsable de aprobación:** Gerardo Calambás.

### DEC-017 — El reparto de presupuesto no se captura al crear la campaña

- **Fecha:** 12 de agosto de 2026
- **Estado:** **aprobada** — matiza DEC-016
- **Contexto:** DEC-016 modeló `participacionPresupuesto` por producto, y el formulario de alta de campaña pedía ese porcentaje al seleccionar cada producto. Al usarlo, el product owner observó que el campo no aporta en ese momento: *"si son múltiples productos, seleccionarlos y ya. No hay que definir porcentajes de variación porque el esfuerzo sería el mismo"*.
- **Decisión:** el formulario de campaña **solo selecciona productos**. El reparto de presupuesto se retira de la interfaz de alta.
- **Por qué es correcto y no una simplificación:** el reparto es un dato **del brief del cliente**, no de la configuración de la campaña. En el brief P80 viene declarado por TCL (60/20/10); en el alta de campaña alguien tendría que inventarlo o copiarlo a mano antes de tener el documento. Pedir un dato antes de que exista su fuente produce exactamente el tipo de contenido que el sistema no debe generar.
- **Qué se conserva:** la columna `campaign_products.participacion_presupuesto` y el campo `productos[].participacionPresupuesto` del esquema del brief. El dato sigue siendo real y sigue estando modelado; cambia **quién lo aporta y cuándo**: se extraerá del brief con su evidencia, en lugar de teclearse.
- **Consecuencias:** la historia E3-9 (aviso de reparto que no suma 100%) se mantiene, pero se traslada del alta de campaña al brief. El aviso del detalle de campaña sigue funcionando con datos ya cargados.
- **Responsable de aprobación:** Gerardo Calambás.

### ADR-009 — La cola de procesamiento vive en PostgreSQL, no en Redis

- **Fecha:** 12 de agosto de 2026
- **Estado:** aprobada
- **Contexto:** la Épica E4 exige procesamiento asíncrono con reintentos e idempotencia. La opción evidente era Redis, que ya está en el stack (§8.1).
- **Decisión:** el estado de los jobs vive en la tabla `processing_jobs`. Los workers toman trabajo con `SELECT … FOR UPDATE SKIP LOCKED`.
- **Por qué:** ADR-007 establece que Redis solo contiene trabajo en tránsito y que perderlo no puede perder información. Un documento cargado y pendiente de procesar **es** información de negocio: si Redis se reinicia, ese trabajo no puede desaparecer. `SKIP LOCKED` da exclusión mutua entre varios workers sin broker.
- **Alternativas consideradas:** (1) Redis como cola con estado — descartada por contradecir ADR-007; (2) Redis como cola + PostgreSQL como respaldo — descartada por mantener dos fuentes de verdad para lo mismo.
- **Consecuencias:** el sondeo añade latencia (1–2 s) frente a una notificación push. Es aceptable: el procesamiento de un PPT tarda segundos, no milisegundos. Si la latencia llega a importar, Redis puede añadirse como señal de despertar sin mover el estado.
- **Responsable de aprobación:** Gerardo Calambás.

### DEC-018 — Markdown como formato preferido y la sección como localizador

- **Fecha:** 12 de agosto de 2026
- **Estado:** **aprobada**
- **Contexto:** el parser de DOCX numeraba páginas contando saltos explícitos. Al revisarlo, el product owner señaló que los briefs viven en **Google Docs**, que exporta a Markdown de forma nativa.
- **El problema de fondo no era el formato, era el localizador.** Un DOCX no tiene páginas hasta que se renderiza: Word las calcula al mostrarlo. Citar "página 3" en un documento de texto es fabricar una precisión que no existe, y una evidencia que no se puede verificar no sirve para nada (§9.4).
- **Decisión, en tres partes:**
  1. **Markdown es el formato preferido** para los briefs de SmartPR. Se exporta desde Google Docs con *Archivo → Descargar → Markdown*.
  2. **La sección es un localizador válido.** La restricción de base pasa de exigir página o diapositiva a exigir *algún* localizador. Se añade la columna `linea` para formatos de texto.
  3. **El DOCX deja de numerar páginas** y cita por ruta de encabezados. Los saltos se conservan como metadato informativo.
- **Qué localiza cada formato, según lo que ofrece de verdad:**

  | Formato | Localizador | Por qué |
  |---|---|---|
  | PPTX | diapositiva | Discreta y estable |
  | PDF | página | Está impresa en el archivo |
  | Markdown | ruta de encabezados + línea | Exacto y estable |
  | DOCX | sección | No tiene páginas hasta renderizar |

- **Un matiz de seguridad que surgió al implementarlo:** el texto plano no tiene firma de bytes, así que por contenido es imposible distinguir un Markdown de un script. Se resolvió manteniendo el principio: **el contenido solo puede restringir, nunca ampliar**. Un archivo con firma de PDF es PDF aunque se llame `.md`; un texto sin firma solo se acepta si además dice llamarse `.md`. Un script renombrado a `.pptx` sigue rechazándose (caso S-05).
- **Beneficio que llega gratis:** al ser texto plano, las versiones del brief se comparan línea a línea, lo que simplifica el comparador de versiones (Épica E8-3).
- **Consecuencia para Drive (DEC-006):** cuando se conecte la API, un Google Doc podrá exportarse a Markdown **sin descargarlo**. Vincular el documento bastaría.
- **Responsable de aprobación:** Gerardo Calambás.

---

## Decisiones pendientes que no bloquean MVP 0

Quedan abiertas y sin efecto sobre el arranque, se resuelven durante la ejecución:

| Punto | Motivo por el que no bloquea |
|---|---|
| Contraparte formal en TCL Colombia | El flujo interno de SmartPR puede documentarse y prototiparse sin ese nombramiento. |
| Selección final de 5–10 campañas para D0-02/D0-14 | Se define con documentos reales que el usuario aportará durante la ejecución. |
| Migración de datos a backup externo | Aceptada como riesgo (ADR-005), se revisa en un incremento posterior. |
