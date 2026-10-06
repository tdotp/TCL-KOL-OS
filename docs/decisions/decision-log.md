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

### DEC-019 — OpenRouter como proveedor y niveles de modelo configurables

- **Fecha:** 12 de agosto de 2026
- **Estado:** **aprobada** — resuelve el pendiente abierto en DEC-008
- **Decisión:** el proveedor de IA es **OpenRouter**, con una sola clave. Los tres niveles de §9.2 —eficiente, equilibrado, avanzado— se configuran por variable de entorno; el modelo concreto de cada nivel **se decide midiendo contra el gold set**, no por opinión.
- **Por qué OpenRouter encaja con la arquitectura:**
  - API compatible con OpenAI, así que **un solo adaptador** cubre todos los modelos (criterio de E11-1).
  - Cubre **embeddings en el mismo endpoint**, de modo que el RAG de §9.3 no necesita un segundo proveedor. Era el hueco que más preocupaba.
  - Devuelve el **costo real por petición**, con lo que `AIRun.estimatedCost` deja de ser una estimación.
- **Privacidad (cierra el matiz de DEC-008):** cada petición declara `data_collection: "deny"`, que excluye a los proveedores que entrenan con los datos enviados. Se declara **en el código y por petición**, no solo como casilla de la cuenta: un ajuste de cuenta lo puede desmarcar alguien sin darse cuenta, una línea de código queda en el historial.
- **Sin modelos por defecto, a propósito:** las variables `AI_MODEL_*` nacen vacías. Un modelo que aparece porque nadie configuró nada acabaría en producción sin que nadie lo hubiera decidido, y su costo y su calidad serían una sorpresa. El router falla con un mensaje que dice exactamente qué falta.
- **Cómo se valida un nivel** (`scripts/validar_niveles.py`): se corren los casos del gold set contra los modelos candidatos y se compara exactitud, resistencia a inventar datos, latencia y costo real.

  El criterio de selección **no es el precio**: un modelo que falla GS-004 (inventa un dato ausente) o GS-005 (elige entre fuentes contradictorias) no sirve para el nivel eficiente por barato que sea, porque rompe la regla de §9.4 y ninguna rebaja compensa eso.
- **Alternativas consideradas:** (1) un proveedor directo —descartada: obligaría a un adaptador por proveedor y a negociar embeddings aparte; (2) modelos fijos en código —descartada: contradice E11-1 e impide medir; (3) modelos locales —descartada por ahora: el equipo corre en una máquina de trabajo, no hay GPU dedicada.
- **Consecuencia operativa:** la clave vive únicamente en el `.env` local, que está en `.gitignore`. Nunca se escribe en el repositorio ni se comparte por chat.
- **Niveles adoptados tras medir** (12 de agosto de 2026, evidencia en [D0-13 anexo](../product/D0-13-validacion-niveles.md)):

  | Nivel | Modelo | Aciertos | Costo |
  |---|---|:--:|---:|
  | eficiente | `google/gemini-2.5-flash-lite` | 3/4 | $0.00043 |
  | equilibrado | `anthropic/claude-haiku-4.5` | 4/4 | $0.00692 |
  | avanzado | `anthropic/claude-sonnet-5` | 4/4 | $0.02378 |
  | embeddings | `openai/text-embedding-3-small` | — | 1536 dim |

  Los siete modelos probados respetan `not_found` y resisten la inyección de prompt. La diferencia está en juzgar un claim sin respaldo, que solo los de Anthropic detectan — por eso el nivel equilibrado, que hace tareas de juicio, usa haiku.

  **El nivel avanzado no aporta con la evidencia actual**: sonnet-5 empata con haiku por 3,4 veces el costo. Se configura porque `resolver_ambiguedad` lo declara, pero conviene revisarlo cuando el gold set tenga casos más difíciles.
- **Responsable de aprobación:** Gerardo Calambás.

### DEC-020 — Ajuste de §9.2: el nivel lo decide la intervención real del modelo

- **Fecha:** 12 de agosto de 2026
- **Estado:** **aprobada** — modifica la tabla §9.2 del documento maestro
- **Origen:** observación del product owner. La medición de DEC-019 produjo un ranking de modelos, pero un ranking responde *"¿cuál es mejor?"* cuando la pregunta útil es *"¿cuánto modelo necesita cada tarea?"*.
- **Análisis:** se descompuso cada tarea en la parte determinista y la parte que realmente requiere modelo (evidencia completa en [D0-13 · intervención del modelo](../product/D0-13-intervencion-del-modelo.md)). Resultado: **la mayor parte del trabajo del brief no es una tarea de lenguaje**, sino estructura, mapeo y validación — lo que el §5 principio 4 ya exigía resolver con software determinístico.
- **Cambios sobre §9.2:**

  | Tarea | §9.2 original | DEC-020 | Por qué |
  |---|---|---|---|
  | `detectar_vacios` | equilibrado | **eficiente** | ~85% determinista: un campo obligatorio vacío es un vacío, no hace falta un modelo para saberlo |
  | `redactar_brief` | equilibrado | **eficiente** | ~75% determinista: el mapeo bloque → sección ya está definido en D0-05 §2.2. El modelo redacta, no decide |
  | `resolver_ambiguedad` | avanzado | **equilibrado** | La medición no encontró diferencia entre haiku y sonnet en el gold set actual |

  El nivel **avanzado queda declarado pero sin uso**, listo para cuando exista evidencia que lo justifique.

- **Principio que se establece — medir por MVP:** el costo total proyectado con volumen real muestra que **el 67% del gasto está en la revisión de guiones (MVP 2), no en el brief**. Del material real: 124 guiones en dos campañas, es decir **62 guiones por campaña frente a 1 brief**.

  La medición de DEC-019 se hizo sobre la tarea de **menor volumen de todo el sistema**, así que su conclusión —"el costo es irrelevante"— no se extiende automáticamente a las demás. Por eso: **cada MVP mide sus propios casos antes de elegir modelo.** El criterio se mantiene: no fabricar primero, latencia después, costo al final salvo que el volumen lo suba de categoría.

- **Proyección con 10 campañas/mes** (órdenes de magnitud, no presupuesto — el alcance de MVP 2–6 no está cerrado):

  | | gemini | haiku | sonnet |
  |---|---:|---:|---:|
  | MVP 1 · brief | $0.07 | $0.86 | $1.72 |
  | MVP 2 · guiones | $0.68 | $7.75 | $15.50 |
  | MVP 5 · perfiles | $0.19 | $2.10 | $4.20 |
  | MVP 6 · reportes | $0.07 | $0.80 | $1.60 |
  | **Total** | **$1.01** | **$11.51** | **$23.02** |

  MVP 7 (video) queda fuera del cuadro: se cobra por minuto de audio, no por token, y es el único que puede cambiar el orden de magnitud. §21 ya le pone una puerta de decisión económica.

- **Consecuencia para MVP 1:** la configuración de DEC-019 no cambia. Lo que cambia es el argumento: gemini-flash-lite se elige por **latencia** (2,5 s) y por no fabricar, no por los $0.07 mensuales.
- **Responsable de aprobación:** Gerardo Calambás.

---

### DEC-021 — Qué campos hacen que un brief esté completo

- **Fecha:** 13 de agosto de 2026
- **Estado:** **aprobada** — cierra el pendiente de [D0-05 §8](../product/D0-05-plantilla-brief-maestro.md), que vencía «antes de cerrar Épica E5»
- **Origen:** la extracción estructurada (E5-3/E5-4) necesita saber qué campos exigen evidencia y cuáles bloquean la aprobación **antes** de que exista la instancia del brief. El JSON Schema no lo dice, y no es un descuido: `criticidad` es un valor por instancia, porque el mismo campo puede ser crítico en una campaña e informativo en otra. Pero hace falta un valor por defecto.

- **Decisión:** se adopta como criticidad por defecto la asignación del ejemplo `brief.example.es.json`, aprobado junto con D0-05 en el gate de MVP 0. Son 41 campos extraíbles: **11 críticos, 5 claims, 25 informativos**.

  | Criticidad | Qué implica | Campos |
  |---|---|---|
  | `critico` | Sin dato, el brief no se puede aprobar; su ausencia genera una `LocalQuestion` (E6-1) | `contexto.situacion`, `objetivo.tipo`, `objetivo.negocio`, `target_audiencia.descripcion`, `marca_producto[].nombre_producto`, `mandatorios`, `mensaje_principal.one_line`, `accion_kpis.accion_esperada`, `practico.fecha_inicio`, `practico.fecha_fin`, `practico.restricciones` |
  | `claim` | Afirmación sobre el producto; exige evidencia siempre (§15, umbral del 100%) | `marca_producto[].beneficio_principal`, `marca_producto[].diferenciales`, `marca_producto[].rtbs`, `marca_producto[].especificaciones`, `mensaje_principal.beneficio_diferencial` |
  | `informativo` | Todo lo demás; no bloquea | (25 campos, valor implícito) |

- **Confirmación con material real:** la primera extracción sobre la campaña P80 dejó `contexto.situacion` y `objetivo.tipo` en `not_found`. Se consultó si eran de verdad críticos o si la exigencia estaba mal calibrada, y el product owner confirmó que **sí lo son**. La criticidad queda así.

- **Corrección posterior — por qué salían `not_found`:** al revisar la fuente se comprobó que **el brief sí traía los dos datos**. «El Reto › Desafío» y «El Reto › El Contexto» son exactamente `contexto.situacion`, y la extracción los había archivado bajo `practico.restricciones`. No era material faltante: era un defecto de extracción disfrazado de dato ausente, que es el peor modo de fallar porque genera preguntas al cliente por algo que él ya respondió. Las causas y su arreglo quedan en [DEC-022](#dec-022--el-prompt-de-extracción-debe-describir-lo-que-pide). La lección que deja para este registro: **un `not_found` no prueba que el dato no exista mientras no se haya mirado la fuente.**

- **Dónde vive:** una sola tabla, `CRITICIDAD_POR_DEFECTO` en `services/ai-worker/app/brief_schema.py`. La *forma* del brief se sigue leyendo del JSON Schema de D0-05 —nunca se copia—; solo la criticidad se declara aparte, porque el esquema no la tiene. Una prueba verifica que toda clave de la tabla exista en el esquema, para que no se desvíen.

- **Por qué por defecto y no fijo:** `criticidad` sigue siendo una columna por campo en `brief_fields`. Una campaña puede subir o bajar la exigencia de un campo concreto; lo que fija esta decisión es con qué valor empieza. Cambiarlo es editar una lista, no perseguir criterios repartidos por el código.

- **Responsable de aprobación:** Gerardo Calambás.

---

### DEC-022 — El prompt de extracción debe describir lo que pide

- **Fecha:** 16 de agosto de 2026
- **Estado:** **aprobada** — corrige la implementación de E5-3, no el diseño
- **Origen:** un `not_found` que parecía dato faltante y era un defecto de extracción. Al revisar la fuente, el brief P80 **sí** traía `contexto.situacion` («El Reto › Desafío») y permitía deducir `objetivo.tipo`. El sistema iba a preguntarle al cliente por algo que ya había respondido.

- **Las cuatro causas, todas de implementación:**

  | # | Falla | Efecto medido |
  |---|---|---|
  | 1 | La descripción de cada campo se leía **después** de resolver el `$ref`. En JSON Schema vive como hermana del `$ref`, en la propiedad concreta, así que se perdía | Los 41 campos llegaban al prompt como claves con puntos y nada más. `contexto.situacion` no dice qué se busca; el modelo lo archivó donde el nombre sonaba parecido |
  | 2 | Solo 4 de 41 campos tenían descripción en el esquema | Se escribieron las 37 restantes, ancladas al vocabulario real de cada formato de cliente (D0-05 §2.1) |
  | 3 | `objetivo.tipo` es un enum y el prompt no nombraba sus valores | Un campo inadivinable. Además, un texto libre habría pasado la extracción para reventar después contra el esquema |
  | 4 | **15 de 41 campos no son texto** —11 listas, 2 fechas ISO, 1 enum, 1 lista de objetos— y el contrato solo producía cadenas | Varios campos daban `found` con valores que el esquema habría rechazado al ensamblar el brief. No se veía porque nada ensambla el documento todavía |

- **Un hueco de fondo que esto destapó:** verificar que la cita existe **no** verifica que el valor se desprenda de ella. El modelo devolvió `practico.fecha_fin = 2026-11-30` citando *«Sostenimiento: Octubre-Noviembre 2026»* — cita literal, verificable, y un día que nadie escribió. Para texto libre esto no se decide sin juicio; para una fecha sí, y ahora se comprueba que el día aparezca en alguna cita. El resto de formas queda como riesgo conocido.

- **Resultado sobre el mismo material, estable en 3 corridas:**

  | | Antes | Después |
  |---|---:|---:|
  | Críticos encontrados | 9/11 *(varios con valores inválidos)* | **9/11** *(todos válidos contra el esquema)* |
  | Claims con evidencia verificada | 4/5 | **5/5** |
  | Fechas en formato ISO | 0 | 1 de 2 (la otra no existe en la fuente) |
  | Listas con la forma correcta | 0 de 11 | 11 de 11 |

  El conteo de críticos no sube, y esa es la lectura honesta: **antes estaba inflado.** Lo que cambió es que ahora cada `found` es defendible.

- **Los dos críticos que siguen sin dato son legítimos:** `practico.fecha_fin` —la fuente da «Octubre-Noviembre 2026», un rango, y el día exacto lo fija una persona— y `practico.restricciones`, cuyo contenido el modelo asigna a `mandatorios`. Este segundo es una **ambigüedad de producto**, no un defecto: los dos campos compiten por el mismo material y el esquema no dice cuál manda. Queda para decidir antes de cerrar E6.

- **Fiabilidad del proveedor:** medido sobre una decena de llamadas idénticas, **2 volvieron con el JSON partido o vacío y `finish_reason: stop`** — OpenRouter enrutando a un upstream que devolvió un payload incompleto. Se añadió **un** reintento. Sin él, la herramienta «a veces no funciona», que es la peor forma de fallar.

- **Responsable de aprobación:** Gerardo Calambás.

---

## Cierre de Sprint 3 + Sprint 4 (DEC-023 a DEC-029)

Resueltas durante el incremento «Brief funcional de punta a punta» — el ciclo de estados,
el anclaje de producto y las preguntas locales (Épica E6) pasan de modeladas a conectadas.
Aprobadas por el product owner en revisión de plan, 25 de agosto de 2026.

### DEC-023 — Anclaje de producto por nivel

- **Fecha:** 25 de agosto de 2026
- **Estado:** **aprobada**
- **Origen:** `brief_fields.campaign_product_id` existe desde la migración 004, pero ningún código lo usaba — el anclaje de campos a producto en una campaña multiproducto (P80: 60/20/10) no estaba implementado en ningún punto del pipeline, ni siquiera en el prompt del worker.
- **Decisión:** aterriza la regla de tres niveles de [DEC-016](#dec-016--campañas-con-varios-productos) en una columna real: `campaign_product_id` es siempre `NULL` en los campos «siempre de campaña»; nunca `NULL` en `marca_producto.*` (una fila por producto); y `NULL` por defecto en «compartido con excepción», con una fila adicional por producto que declara su excepción puntual. Sin prefijo `overrides.` en la clave — la nulabilidad ya distingue compartido de específico.
- **Dónde vive:** índices únicos parciales y el trigger de validación en `infra/db/migrations/005_producto_preguntas_y_revision.sql`; el nivel de cada campo en `docs/product/brief-schema/brief-catalog.json` (`nivel`); la validación de `productoId` contra el catálogo real de la campaña en `packages/db/src/extraction.ts` (`persistirExtraccion`) — rechaza toda la extracción si un producto no pertenece a la campaña, nunca mezcla campos entre P80/P80 Pro/P80 Ultra.
- **Responsable de aprobación:** Gerardo Calambás.

### DEC-024 — Estrategia de «versión de trabajo»

- **Fecha:** 25 de agosto de 2026
- **Estado:** **aprobada**
- **Decisión:** mientras un `brief_version` no esté en estado terminal ni `approved`, la misma fila se reutiliza. Confirmar un campo, corregirlo, responder una pregunta o resolver un conflicto son `UPDATE` sobre `brief_fields`, nunca una versión nueva. El detalle de cada cambio (valor anterior, valor nuevo, motivo) no vive en `audit_events.metadata` — vive en la tabla `brief_field_revisions`, dedicada; `audit_events` conserva su naturaleza de auditoría general (identificadores, tipo de acción, metadatos mínimos) y nunca se vuelve copia del contenido del brief.
- **Dónde vive:** `packages/db/src/brief-version.ts` (`obtenerOCrearVersionDeTrabajo`), `packages/db/src/brief-fields.ts` (`confirmarCampo`/`corregirCampo`/`resolverConflicto`, cada una escribiendo su fila en `brief_field_revisions` dentro de la misma transacción).
- **Responsable de aprobación:** Gerardo Calambás.

### DEC-025 — Mandatorios vs. restricciones

- **Fecha:** 25 de agosto de 2026
- **Estado:** **aprobada** — corrección puntual del prompt de extracción, no una optimización general (fuera del alcance de este incremento)
- **Origen:** `practico.restricciones` competía con `mandatorios` por el mismo material fuente (ambigüedad ya señalada en [DEC-022](#dec-022--el-prompt-de-extracción-debe-describir-lo-que-pide)); un caso real («único canal de venta: Alkosto») se archivaba en el campo equivocado.
- **Decisión:** `mandatorios` son elementos que deben aparecer o ejecutarse; `practico.restricciones` son límites, prohibiciones o condiciones. «Único canal de venta: Alkosto» es una restricción, no un mandatorio.
- **Dónde vive:** instrucción explícita en `services/ai-worker/app/extraction.py` (`_instrucciones()`); prueba dedicada en `tests/test_extraction_mandatorios_restricciones.py`.
- **Responsable de aprobación:** Gerardo Calambás.

### DEC-026 — Fechas con precisión real

- **Fecha:** 25 de agosto de 2026
- **Estado:** **aprobada**
- **Origen:** el binario `found`/`not_found` fuerza a elegir entre inventar un día que la fuente no da o descartar una fecha que sí está, aunque imprecisa (rango o mes) — el caso real de [DEC-022](#dec-022--el-prompt-de-extracción-debe-describir-lo-que-pide) («Sostenimiento: Octubre-Noviembre 2026»).
- **Decisión:** `value` de `practico.fecha_inicio`/`fecha_fin` pasa a un objeto con precisión: `{tipo: 'exacta'|'mes'|'rango'|'aproximada'|'pendiente_confirmar', fecha?, inicio?, fin?, textoOriginal}`. Una precisión distinta de `exacta` en un campo crítico queda `status: 'found'` (hay valor, aunque impreciso) y además dispara una pregunta local pidiendo el día exacto. La fecha debe estar respaldada por una cita real — nunca inferida.
- **Dónde vive:** `PrecisedDate`/`DatePrecision` en `packages/domain/src/types.ts`; `_precisar_fecha()`/`_fecha_respaldada_por_citas()` en `services/ai-worker/app/extraction.py`.
- **Responsable de aprobación:** Gerardo Calambás.

### DEC-027 — Aprobaciones: documentación sin implementar

- **Fecha:** 25 de agosto de 2026
- **Estado:** **aprobada** — declarativa, no cambia código
- **Decisión:** una aprobación no se revierte editando la misma versión; cualquier cambio posterior a `approved` crea una versión hija, y la anterior queda `superseded`, nunca se reescribe. Ya protegido por ADR-003 (inmutabilidad) en el dominio y en triggers de base de datos. Este incremento llega hasta `internal_review`; el ciclo de aprobación final (creación de la versión hija, flujo de `superseded`) queda como siguiente incremento — no implementado aquí.
- **Responsable de aprobación:** Gerardo Calambás.

### DEC-028 — Evidencia vs. `manual_local`

- **Fecha:** 25 de agosto de 2026
- **Estado:** **aprobada**
- **Decisión:** un claim o un dato técnico verificable exige evidencia documental siempre. Un campo crítico no técnico respondido por pregunta local se sustenta con `provenance_type = 'manual_local'` más autor y fecha, sin exigir fragmento documental — la guarda `guardClaimsHaveEvidence` solo actúa sobre claims con `status: 'found'`. Un claim vacío (`not_found`) no bloquea nada por sí solo; si no aplica a la campaña, se descarta con justificación por el mismo mecanismo de preguntas locales que un campo crítico — no existe un mecanismo aparte de «marcar como no aplicable».
- **Dónde vive:** `requiresEvidence()` en `packages/domain/src/brief-states.ts`; descarte con justificación obligatoria en `packages/db/src/local-questions.ts` (`descartarPregunta`).
- **Responsable de aprobación:** Gerardo Calambás.

### DEC-029 — `CampaignProduct` de negocio vive en `packages/domain`

- **Fecha:** 25 de agosto de 2026
- **Estado:** **aprobada**
- **Origen:** el tipo de negocio que cruza hacia `apps/web` para representar un producto dentro de una campaña no existía en el dominio.
- **Decisión:** se añade `CampaignProduct` a `packages/domain/src/types.ts`. Esto **no** elimina `CampaignProductRow` de `packages/db` — la forma de fila SQL (`snake_case`) se queda donde está, porque un tipo de persistencia específico dentro de `packages/db` no viola ADR-008 (lo prohibido es que el *dominio* importe de aplicaciones o servicios, no que la capa de persistencia tenga sus propias formas de fila). Lo que cruza hacia `apps/web` es únicamente el tipo de negocio compartido.
- **Dónde vive:** `packages/db/src/campaigns.ts` (`comoProductoDeDominio`, mapeo explícito fila→dominio en la frontera).
- **Responsable de aprobación:** Gerardo Calambás.

---

## Cierre de Sprint 5 (DEC-030 a DEC-033)

Resueltas durante el incremento «Ciclo completo del brief: de `internal_review`
a `approved`, comentarios internos, fechas estructuradas y versionado
posterior a aprobación». 15 de septiembre de 2026.

### DEC-030 — Permisos exactos del rol `cliente` para decidir sobre su brief

- **Fecha:** 15 de septiembre de 2026
- **Estado:** **aprobada**
- **Origen:** DEC-012/ADR-004 solo autorizaban una vista de solo lectura para
  TCL; este incremento pide que el cliente pueda solicitar cambios y aprobar
  desde la aplicación, no solo por fuera de ella.
- **Decisión:** el rol `cliente` recibe exactamente dos permisos nuevos —
  `brief:request_client_changes` y `brief:register_client_decision` (esta
  segunda ya existía, reservada para que el personal registrara la decisión
  del cliente por él; ahora también la ejerce el propio cliente). **Nunca**
  recibe `brief:transition` genérico, ni ningún `comment:*` — los
  comentarios internos, abiertos o resueltos, no son del cliente en ninguna
  circunstancia; esa distinción no se relaja ni siquiera para un comentario
  ya resuelto, por decisión explícita del product owner.
- **Dónde vive:** `packages/domain/src/permissions.ts` (rol `cliente`);
  `packages/db/src/transitions.ts` (`accionParaDestino` — qué acción exige
  cada `to`, en vez de un único `brief:transition` para todos); las dos
  reglas de transición `client_review → client_changes_requested` y
  `client_review → approved` en `packages/domain/src/brief-states.ts` ahora
  incluyen `'cliente'` en sus roles autorizados, además de `EDITORIAL_ROLES`
  (el personal conserva la vía de registrar la decisión en su nombre,
  DEC-012 original).
- **Responsable de aprobación:** Gerardo Calambás.

### DEC-031 — Comentarios internos: tabla propia, ligados a la clave del campo

- **Fecha:** 15 de septiembre de 2026
- **Estado:** **aprobada**
- **Decisión:** E7-6 se implementa en `field_comments` (migración 007),
  anclada a `(brief_version_id, field_key)` — nunca a `brief_fields.id` — para
  que la conversación sobreviva aunque la fila cambie (una excepción por
  producto declarada después, o una versión hija que copia el campo con un
  `id` nuevo). Igual que `brief_fields`/ADR-003: una versión `approved`
  conserva sus comentarios para consulta, pero no admite contenido nuevo ni
  alterado (trigger `field_comments_inmutabilidad`, mismo patrón que
  `campos_de_version_aprobada_inmutables`).
- **Consecuencia sobre Fase E:** al crear una versión hija, los comentarios
  de la versión padre **no se copian** — quedan asociados a la versión
  histórica, ya `superseded`, nunca como conversación activa de la hija
  (así lo pide explícitamente el punto 6 de la Fase E del pedido).
- **Dónde vive:** `infra/db/migrations/007_comentarios_internos.sql`;
  `packages/db/src/comments.ts`.
- **Responsable de aprobación:** Gerardo Calambás.

### DEC-032 — La visibilidad de una campaña para TCL sube sola al enviarla a revisión del cliente

- **Fecha:** 15 de septiembre de 2026
- **Estado:** **aprobada** — corrige un vacío real de ADR-004, no una
  optimización de alcance
- **Origen:** al auditar el código antes de este incremento se encontró que
  `campaigns.visibility` nace `interna` por defecto (migración 001) y
  **ningún código en todo el repositorio la cambiaba jamás** — ni acción de
  servidor, ni transición, nada. Consecuencia práctica: el rol `cliente`
  nunca podía ver ninguna campaña real, en ningún estado, pese a que
  ADR-004 (10 de agosto de 2026) ya prometía "una vista mínima de solo
  lectura para TCL... visible únicamente a partir del envío". La vista
  existía en la promesa, pero el envío que debía activarla nunca ocurría.
- **Decisión:** `transicionarBrief` sube `campaigns.visibility` de `interna`
  a `tcl` automáticamente, dentro de la misma transacción, exactamente
  cuando la transición es `→ client_review` — ese es "el envío" que dice
  ADR-004. Solo sube el nivel: una campaña que ya es `tcl` o `compartida` no
  se toca, y nada la baja de vuelta a `interna` en ningún flujo (ni al
  solicitar cambios, ni al devolver a revisión interna) — una vez que TCL
  vio la campaña, sigue viéndola.
- **Dónde vive:** `packages/db/src/transitions.ts` (`transicionarBrief`).
- **Responsable de aprobación:** Gerardo Calambás.

### DEC-033 — Candado de concurrencia para la versión hija: un `UPDATE` condicional, no un `SELECT` + `INSERT`

- **Fecha:** 15 de septiembre de 2026
- **Estado:** **aprobada**
- **Origen:** DEC-027 exige que dos solicitudes simultáneas de "crear nueva
  revisión" sobre el mismo brief `approved` nunca produzcan dos versiones
  hijas.
- **Decisión:** `crearVersionHija` no comprueba primero el estado y luego
  inserta — hace `UPDATE brief_versions SET status = 'superseded' WHERE id =
  $1 AND status = 'approved'` como primer paso de la transacción. Solo una
  de dos peticiones concurrentes puede ganar esa fila; la segunda ve `0`
  filas afectadas (el estado ya cambió) y se rechaza ahí mismo, antes de
  crear nada. Mismo principio que ya usa la revisión optimista de
  `confirmarCampo`/`corregirCampo` (`UPDATE ... WHERE revision = $x`) —
  un `UPDATE` condicional como candado, no una comprobación separada que deja
  una ventana de carrera entre leer y escribir.
- **Dónde vive:** `packages/db/src/versioning.ts` (`crearVersionHija`).
- **Responsable de aprobación:** Gerardo Calambás.

### DEC-034 — El trigger de "claims con evidencia" no tenía la excepción de DEC-028 (defecto real, encontrado al ejercitar `approved` por primera vez)

- **Fecha:** 15 de septiembre de 2026
- **Estado:** **aprobada** — corrección de un defecto real, no una decisión de diseño nueva
- **Origen:** al correr por primera vez en toda la vida del proyecto la
  transición `client_review → approved` (este incremento implementa
  `aprobarComoCliente`; DEC-027 había dejado el ciclo de aprobación final
  documentado pero nunca ejecutado), la prueba `client-review.test.ts` falló
  con `No se puede aprobar: los campos (...) son claims sin evidencia`. Los
  campos listados eran críticos resueltos por pregunta local
  (`provenance_type = 'manual_local'`), no claims — exactamente el caso que
  DEC-028 (cierre de Sprint 4) exime de evidencia documental.
- **Causa:** `claim_exige_evidencia()` (trigger diferido, migración 004)
  exigía evidencia para todo campo `criticidad IN ('critico', 'claim')` con
  `status = 'found'`, sin la excepción de `manual_local` que
  `requiresEvidence()` (`packages/domain/src/brief-states.ts`, la guarda
  equivalente en el dominio) sí aplica desde DEC-028. La guarda del dominio
  nunca lo detectó porque las pruebas de dominio son puramente en memoria; el
  trigger de base es la última línea de defensa, y hasta este incremento
  nada había llegado a `approved` con datos reales para ejercitarlo.
- **Decisión:** se corrige el trigger para que la condición sea idéntica a
  `requiresEvidence()`: un `claim` exige evidencia siempre; un `critico`
  la exige salvo que su procedencia sea `manual_local`.
- **Dónde vive:** `infra/db/migrations/008_claim_exige_evidencia_excepcion_manual.sql`.
- **Responsable de aprobación:** Gerardo Calambás.

### DEC-035 — CI nunca podía correr en un runner limpio (`.venv` referenciado sin crearse)

- **Fecha:** 16 de septiembre de 2026
- **Estado:** **aprobada** — corrección de un defecto real, encontrada en auditoría independiente del ZIP de Sprint 5
- **Origen:** `.github/workflows/ci.yml` levantaba el worker con `.venv/bin/python -m uvicorn app.main:app ...`, pero ningún paso anterior del workflow crea ese entorno virtual — `pip install -r requirements.txt` instala en el intérprete que `actions/setup-python` ya deja configurado. En cualquier checkout limpio (todo runner real de GitHub Actions, por definición), `.venv` nunca existe: ese paso habría fallado en cada corrida. Ninguna verificación anterior de este proyecto lo detectó porque todas se apoyaron en la imagen Docker del worker (`services/ai-worker/Dockerfile`), que instala e invoca `uvicorn` directo — un camino de código distinto al que `ci.yml` de verdad ejecuta.
- **Decisión:** el workflow usa `python -m uvicorn` (el intérprete que ya está configurado, sin ruta fija a un entorno que no existe) y `python -m pip install -r requirements.txt` en los tres pasos de instalación, para eliminar la ambigüedad entre `pip` y `python -m pip`.
- **Verificación:** reproducida la receta literal de `ci.yml` dentro de un contenedor recién creado, Python 3.11, sin ningún `.venv` preexistente — confirmado explícitamente que `.venv/bin/python` no existe ahí (el fallo exacto que habría dado el workflow original) y que el comando corregido sí levanta el worker. No se ejecutó dentro de un runner real de GitHub Actions en esta sesión (no hay remoto configurado); ver D0-18 §8 y §10.3.
- **Dónde vive:** `.github/workflows/ci.yml`.
- **Responsable de aprobación:** Gerardo Calambás.

### DEC-036 — La inmutabilidad histórica de la base desaparecía después de `superseded`

- **Fecha:** 16 de septiembre de 2026
- **Estado:** **aprobada** — corrección de un defecto real, encontrada en auditoría independiente del ZIP de Sprint 5
- **Origen:** `campos_de_version_aprobada_inmutables()` (migración 004) y `comentarios_de_version_aprobada_inmutables()` (migración 007) solo bloqueaban `UPDATE`/`DELETE` mientras la versión dueña estaba `approved`. Al crear una versión hija (`crearVersionHija`, Fase E de Sprint 5), la versión padre pasa a `superseded` — y ahí la protección desaparecía por completo: nada en la base impedía un `UPDATE`, `DELETE` o `INSERT` directo sobre el contenido de una versión ya reemplazada. `evidence`, `local_questions` y `brief_field_revisions` nunca habían tenido ninguna protección propia, ni siquiera para `approved`.
- **Decisión:** migración `009_inmutabilidad_historica.sql` (nunca modifica una migración ya aplicada; redefine funciones existentes con `CREATE OR REPLACE FUNCTION`, igual que la 008). Extiende la protección a `approved`, `superseded` y `cancelled` por igual, en `brief_fields`, `evidence` (trigger nuevo), `local_questions` (trigger nuevo), `brief_field_revisions` (protección de `INSERT`/`DELETE` añadida al `UPDATE` que ya bloqueaba sin condición) y `field_comments`. `brief_versions` gana la regla explícita: un estado terminal (`superseded`/`cancelled`) nunca vuelve a ningún otro estado por SQL directo — `approved → superseded` sigue siendo la única transición que un estado cerrado admite, y solo para crear la versión hija.
- **Un matiz que surgió al implementarlo:** un primer diseño asumía que la limpieza de campañas de prueba (`DELETE FROM campaigns`) seguiría funcionando sola porque la cascada borraría primero `brief_versions`, dejando el disparador sin nada que proteger. Es falso en general — verificado contra Postgres real, `local_questions` tiene FK directa a `campaigns` (además de a `brief_version_id`), así que su cascada puede dispararse mientras `brief_versions` todavía existe. Se resolvió con una bandera de bypass (`SET LOCAL tclkolos.permitir_borrado_historico`) acotada a una única transacción, exclusiva de `packages/db/src/test-utils.ts` (`eliminarCampanaDePrueba`) — nunca usada por ninguna ruta de la aplicación real.
- **Dónde vive:** `infra/db/migrations/009_inmutabilidad_historica.sql`; `packages/db/src/test-utils.ts`; pruebas en `packages/db/src/immutability.test.ts` (34 casos, SQL directo, repetidos en `approved` y en `superseded`).
- **Responsable de aprobación:** Gerardo Calambás.

### DEC-037 — El bypass de inmutabilidad no estaba restringido a bases de pruebas, `brief_versions` admitía `DELETE` directo y la fila histórica no quedaba congelada del todo

- **Fecha:** 16 de septiembre de 2026 (tarde)
- **Estado:** **aprobada** — corrección de tres defectos reales, encontrados en una segunda auditoría independiente sobre el commit `a9eefe4` (el del correctivo de DEC-035/DEC-036)
- **Origen (hallazgo 1):** `inmutabilidad_bypass_activo()` (migración 009) solo comprobaba la bandera de sesión `tclkolos.permitir_borrado_historico`. Que solo `packages/db/src/test-utils.ts` la activara era una convención de la aplicación, no una restricción de la base — cualquier conexión con permiso para ejecutar SQL podía activarla en cualquier entorno, incluida producción.
- **Origen (hallazgo 2):** la protección de `brief_versions` solo estaba conectada a `BEFORE UPDATE`. Un `DELETE FROM brief_versions` directo sobre una fila `approved`/`superseded`/`cancelled` no tenía ningún obstáculo, y arrastraría en cascada todo su contenido histórico — lo mismo si el `DELETE` llegaba en cascada desde borrar una campaña o un brief.
- **Origen (hallazgo 3):** `version_aprobada_inmutable()` solo comparaba `version`, `brief_id`, `language`, `parent_version_id` y `approved_at` — `organization_id`, `created_by`, `translation_of_id` y `created_at` podían modificarse por `UPDATE` directo sin que ningún disparador lo notara.
- **Decisión:** migración `010_inmutabilidad_bypass_restringido.sql` (nunca modifica una migración ya aplicada). (1) `inmutabilidad_bypass_activo()` ahora exige además que el nombre de la base termine en `_test`, la misma convención de INC-001A — en cualquier otra base la función devuelve `false` aunque la bandera esté activa. (2) Nuevo disparador `BEFORE DELETE` sobre `brief_versions` que rechaza cualquier `DELETE` en un estado terminal, salvo con el bypass activo — cubre tanto el `DELETE` directo como la cascada desde `briefs`/`campaigns`. (3) `version_aprobada_inmutable()` redefinida: `superseded`/`cancelled` rechazan cualquier `UPDATE` sin excepción; `approved` sin cambio de estado también rechaza cualquier `UPDATE`; `approved → superseded`/`cancelled` se permite solo si `status` es la única columna que cambia.
- **Un matiz que surgió al verificarlo:** dos suites (`brief-rules.test.ts`, `end-to-end.test.ts`) hacían un `DELETE FROM brief_versions` aparte en su limpieza, fuera de la transacción con bypass — redundante desde que `eliminarCampanaDePrueba` ya borra `briefs` primero, arrastrando `brief_versions` en cascada dentro de esa misma transacción. Se quitaron esas dos líneas sueltas.
- **Dónde vive:** `infra/db/migrations/010_inmutabilidad_bypass_restringido.sql`; `packages/db/src/test-utils.ts` (comentario actualizado); pruebas en `packages/db/src/immutability.test.ts` (20 casos nuevos).
- **Responsable de aprobación:** Gerardo Calambás.

### DEC-038 — `BriefWorkspace` como único contrato de lectura del workspace, nunca ensamblado en React

- **Fecha:** 24 de septiembre de 2026
- **Estado:** **aprobada** — Sprint 6, Fase B
- **Origen:** la interfaz del brief exponía directamente los 41 campos, las claves técnicas, los doce estados internos y varias rutas distintas para lo mismo — no porque faltara lógica de dominio (ya existía completa desde Sprint 5), sino porque cada pantalla la volvía a ensamblar a mano con sus propias llamadas sueltas a `verCamposDeVersion`, `listarPreguntas`, `contarConversacionesAbiertas`, etc.
- **Decisión:** `obtenerBriefWorkspace(actor, campaignId)` (`packages/db/src/brief-workspace.ts`) es la única función que compone esas llamadas y las reduce a un modelo estable (`BriefWorkspace`, `packages/domain/src/workspace.ts`): progreso, secciones, tareas pendientes, actividad derivada de `audit_events` y acciones permitidas. No ejecuta SQL propio contra campos/preguntas/comentarios y no reimplementa ninguna guarda — `allowedTransitions` y `requiresEvidence` (recién exportada, antes privada en `brief-states.ts`) son las mismas del dominio real. `ORDEN_DE_SECCIONES`, `TITULO_SECCION`, `ESTADO_EN_ESPANOL` y `TEXTO_DEL_BOTON` se movieron de `apps/web/src/lib/*` a `packages/domain/src/brief-presentation.ts` (con reexport desde `apps/web` para no romper imports existentes) porque `packages/db` no puede depender de `apps/web` (ADR-008).
- **Dos proyecciones a propósito:** este contrato es el interno. Cuando el actor es `cliente`, los comentarios internos ni siquiera se consultan (nunca una propiedad presente que se "esconde" en la UI) — si el cliente necesitara su propia proyección de este mismo dato en el futuro, debe ser un tipo explícito nuevo, nunca este con menos campos poblados.
- **Verificación:** 12 pruebas de integración nuevas (`packages/db/src/brief-workspace.test.ts`) — sin brief, extracción parcial, multiproducto, campo por producto, críticos pendientes, claim sin evidencia, pregunta respondida/descartada, comentario abierto/resuelto, consultor sin `approve_internal` vs. director con él, cliente sin comentarios internos, aislamiento entre organizaciones, versión aprobada inmutable. 80 dominio + 219 `packages/db` en verde.
- **Dónde vive:** `packages/domain/src/workspace.ts`, `packages/domain/src/brief-presentation.ts`, `packages/db/src/brief-workspace.ts`, `packages/db/src/brief-workspace.test.ts`.
- **Responsable de aprobación:** Gerardo Calambás.

### DEC-039 — El workspace guiado resuelve la cola de `local_questions` existente; "saltar" nunca toca el servidor

- **Fecha:** 24 de septiembre de 2026
- **Estado:** **aprobada** — Sprint 6, Fase C
- **Origen:** el pedido de este incremento es que la conversación construya el brief, sin introducir todavía un agente autónomo ni una tabla de mensajes genérica — la cola de trabajo debía ser la que ya existe, no una nueva.
- **Decisión:** `WorkspaceGuiado.tsx` (`apps/web/.../brief/workspace/`) muestra una tarea a la vez tomada de `workspace.tasks` — que no es más que `local_questions` pendientes, ya generadas por `generarPreguntas` (Sprint 4). Responder o descartar llama exactamente a las mismas server actions que ya alimentaban `TablaPreguntas.tsx` (`responderPreguntaLocal`, `descartarPreguntaLocal`) — ninguna acción nueva escribe en la base. Un claim (`criticidad: 'claim'`) nunca se ofrece para responder inline: siempre exige evidencia documental (§3.3, sin excepción aunque la respuesta venga de una persona), así que la tarea remite al editor en vez de fingir que un texto libre la resuelve. "Saltar por ahora" es estado del navegador únicamente (reordena qué se muestra primero dentro de esta sesión) — nunca persiste, nunca es una acción de dominio.
- **Feature flag:** toda la superficie vive detrás de `BRIEF_WORKSPACE_V2` (env var, sin tabla nueva). Apagada (por defecto), `/campanas/[id]/brief/workspace` reenvía a `/brief/editar` sin cambiar nada del flujo anterior; el enlace de entrada en el overview de campaña tampoco aparece. Ninguna ruta ni componente anterior se retiró.
- **Verificación:** recorrido completo en vivo contra datos reales (login → overview de campaña → workspace guiado → responder una pregunta crítica de texto → progreso y contador se actualizan → "saltar" reordena sin tocar el servidor → siguiente pregunta con un control distinto, `ControlDeRespuesta` extraído a componente compartido). Con la bandera apagada, la misma URL reenvía limpio a `/brief/editar` — confirmado navegando directo a la ruta.
- **Dónde vive:** `apps/web/src/app/(app)/campanas/[id]/brief/workspace/page.tsx`, `WorkspaceGuiado.tsx`; `apps/web/src/components/ControlDeRespuesta.tsx` (extraído de `TablaPreguntas.tsx`).
- **Responsable de aprobación:** Gerardo Calambás.

### DEC-040 — Actividad se fusiona de tres fuentes existentes, nunca una tabla nueva; la responsabilidad se explica en vez de solo esconder el botón

- **Fecha:** 24 de septiembre de 2026
- **Estado:** **aprobada** — Sprint 6, Checkpoint 2
- **Origen:** el pedido de este checkpoint es explícito: "Actividad" debe derivarse únicamente de registros ya existentes (`audit_events`, `field_comments`, `brief_field_revisions`, transiciones de versión, cambios y aprobaciones) — nunca una tabla de mensajes o de actividad nueva. Y el workspace debe explicar a quién le toca actuar y por qué, "no limitarse a esconder el botón" y "no hardcodear una segunda matriz de transiciones en la UI".
- **Decisión (actividad):** `obtenerBriefWorkspace` fusiona tres fuentes en el servidor: `audit_events` (vía `listBriefActivity`, ya existente) para eventos genéricos, `brief_field_revisions` para cambios de campo con valor anterior/nuevo, `field_comments` para comentarios — con las seis acciones de campo y las cuatro de comentario excluidas de la fuente genérica (`ACCIONES_CON_FUENTE_MAS_RICA`, `packages/db/src/brief-workspace.ts`) para no mostrar el mismo hecho dos veces con menos contexto la segunda vez. La traducción de `action` cruda a frase legible vive en un solo lugar (`humanoDeEvento`, `packages/domain/src/brief-presentation.ts`) — si aparece una acción nueva que el mapa no conoce, se muestra igual en vez de ocultar el evento.
- **Decisión (responsabilidad):** `mensajeResponsabilidad()` (mismo archivo) arma la frase de quién debe actuar a partir del `status` y los contadores que el contrato ya calculaba — nunca una segunda fuente de verdad. `allowedActions` (ya existente desde Fase B, `allowedTransitions` del dominio sin cambios) se conecta por primera vez a la UI: `BannerResponsabilidad` ofrece un enlace real hacia el formulario de transición existente en `/brief` solo cuando el actor mismo puede ejecutar esa transición — el workspace nunca reimplementa la mutación ni decide por su cuenta quién puede aprobar, solo decide si muestra el enlace con el mismo dato que ya filtraba `allowedActions`.
- **Un matiz que surgió al implementarlo:** la rama `superseded` de `mensajeResponsabilidad` es alcanzable en teoría pero nunca en la práctica desde `obtenerBriefWorkspace()` real — `versionesDelBrief()[0]` siempre devuelve la versión de mayor número, y una versión reemplazada por construcción tiene un número menor que su hija. Se probó como prueba unitaria pura de dominio (honesta sobre lo que realmente cubre), no como una prueba de integración que fingiera alcanzar ese estado.
- **Verificación:** 17 pruebas de dominio nuevas (`brief-presentation.test.ts`, una por rama de estado más el límite singular/plural que atrapó un error real de tildes), 8 pruebas de integración nuevas (`brief-workspace.test.ts`, 20 en total), y los casos E2E-06 (actividad) y E2E-07 (consultor sin enlace de acción, director con él) de Playwright.
- **Dónde vive:** `packages/domain/src/brief-presentation.ts`, `packages/db/src/brief-workspace.ts`, `packages/db/src/brief-fields.ts` (`listBriefFieldRevisions`), `packages/db/src/comments.ts` (`listarComentariosDeVersion`), `apps/web/.../brief/workspace/Actividad.tsx`, `WorkspaceNav.tsx`.
- **Responsable de aprobación:** Gerardo Calambás.

### DEC-041 — Playwright como primer harness de navegador del repositorio, base `_test` aislada y dos servidores por bandera

- **Fecha:** 24 de septiembre de 2026
- **Estado:** **aprobada** — Sprint 6, Checkpoint 2
- **Origen:** ningún checkpoint anterior tenía pruebas de navegador automatizadas — la verificación de UI dependía de un recorrido manual único, no reproducible ni repetible en CI. El pedido exigía 9 casos obligatorios cubriendo los tres modos, roles, cliente y aislamiento multi-tenant, sin tocar nunca P80 ni datos reales.
- **Decisión:** `apps/e2e` (`@tcl-kol-os/e2e`), npm workspace nuevo, `@playwright/test` vía `channel: 'chrome'` (Google Chrome real ya instalado, no el binario que Playwright descarga aparte). `playwright.config.ts` valida `E2E_DATABASE_URL` contra el mismo patrón `_test` que `TEST_DATABASE_URL` (INC-001A) y levanta dos servidores Next (`webServer`), uno por cada valor de `BRIEF_WORKSPACE_V2`, enrutados a dos `projects` por nombre de archivo de prueba. Cada prueba crea su propia campaña desechable (`src/fixtures.ts`, mismas funciones de repositorio que ya usan las pruebas de integración, nunca SQL propio para crearlas) y la limpia en `afterAll` — `limpiarTodo()` deliberadamente no cierra el pool de conexiones compartido entre archivos de un mismo proceso de Playwright.
- **Cuatro problemas reales, descubiertos únicamente corriendo la suite completa** (nunca en un archivo aislado): falta de `"type": "module"` en `apps/e2e/package.json` rompía la resolución de `import.meta.url` al cargar `@tcl-kol-os/db`/`@tcl-kol-os/domain`; `E2E_DATABASE_URL` nunca se exponía como `DATABASE_URL` al proceso de Playwright mismo (solo a los servidores hijos); el `testMatch` del proyecto `flag-on` usaba una negación por *lookahead* sin anclar que igual dejaba pasar `flag-apagado.spec.ts` (el motor de regex reintenta en posiciones posteriores del nombre); y la compilación bajo demanda de `next dev` a veces aborta una petición en vuelo o hace que un login redirija de vuelta a `/login` la primera vez que una ruta se pide en un servidor frío. Las tres primeras se corrigieron en la configuración; la cuarta con un reintento acotado (una vez) en la navegación, nunca en las aserciones de negocio.
- **Verificación:** los 9 casos obligatorios en verde, estables en tres corridas completas (dos contra la base ya usada por `packages/db`, una contra una base recién migrada y sembrada desde cero).
- **Dónde vive:** `apps/e2e/` completo (`playwright.config.ts`, `src/fixtures.ts`, `src/login.ts`, `src/nav.ts`, `tests/*.spec.ts`); `packages/db/package.json` (subpath export `./test-utils` añadido, sin ampliar el barrel principal con una función de borrado que solo debe llegar a pruebas).
- **Responsable de aprobación:** Gerardo Calambás.

### DEC-042 — El cliente es de solo lectura: SmartPR revisa y cierra el brief; `client_review` y `client_changes_requested` pasan a legacy

- **Fecha:** 3 de octubre de 2026
- **Estado:** **aprobada** — corrección del workflow cliente
- **Origen:** el modelo de Sprint 5 (Fase D) permitía que el cliente aprobara o pidiera cambios dentro del sistema. Contradice el workflow real: SmartPR opera y decide; el cliente solo consulta (tendrá más adelante un dashboard de solo lectura); la IA analiza y propone, nunca aprueba.
- **Decisión:** (1) `internal_review → approved` (solo admin/director) reemplaza a `internal_review → client_review → approved`. (2) Ninguna transición entra a `client_review` ni a `client_changes_requested`; siguen en el enum y en `BriefStatus` como estados legacy para leer datos persistidos, con salida siempre abierta a roles internos (`client_review → approved | internal_review`, `client_changes_requested → internal_review`, cancelación). (3) El rol `cliente` queda con `campaign:read`, `brief:read` y `brief:export`; se eliminan `brief:request_client_changes` y `brief:register_client_decision`. (4) El consultor ya no cierra briefs. (5) `campaigns.visibility` sube a `tcl` al aprobar, no al enviar a revisión del cliente. Supersede lo decidido en Sprint 5 Fase D sobre la decisión del cliente (DEC-030) y el momento de la subida de visibilidad (DEC-032).
- **Sin migración:** el enum de Postgres no cambia; no se reescribe historial (`audit_events` conserva los motivos de devoluciones previas del cliente).
- **Fuera de alcance:** dashboard de cliente, influencers, guiones, entregables; stepper de UI («Revisión cliente»), que se corrige en el rediseño frontend; actualización de documentos históricos (D0-03, D0-07, D0-12, D0-18, HANDOFF), que describen el modelo anterior y quedan superados por esta decisión.
- **Dónde vive:** `packages/domain/src/brief-states.ts`, `permissions.ts`, `brief-presentation.ts`; `packages/db/src/transitions.ts`, `client-review.ts`, `brief-workspace.ts`; `apps/web/.../brief/VistaCliente.tsx`, `page.tsx`, `apps/web/src/lib/actions.ts`; detalle en `docs/product/CLIENT_WORKFLOW_CORRECTION.md`.
- **Responsable de aprobación:** Gerardo Calambás.

### DEC-043 — Modelo bilingüe V2: una versión lógica con representaciones ES/EN

- **Fecha:** 4 de octubre de 2026
- **Estado:** **aprobada** — V2 · Fase 2
- **Origen:** la regla funcional V2 («una entidad, una versión, un estado, una aprobación, dos representaciones») contradecía el modelo previo, donde ES y EN eran filas de `brief_versions` con estado, aprobación y linaje propios.
- **Decisión:** la versión lógica es la fila `brief_versions` existente (estado, aprobación, linaje, inmutabilidad, comentarios, preguntas y evidencia sin duplicar). ES y EN son `brief_version_representations` hijas, sin estado propio; los valores localizados viven en `brief_field_translations` con origen verificable, procedencia y huella del valor original (staleness por valor, vista `brief_translation_sync`). La aprobación exige origen verificable y traducciones al día; la congelación al aprobar vale para ambas representaciones y se impone en la base de datos. Las versiones EN históricas no se reescriben: se clasifican (`folded` / `conflict` / `orphan`) sin reconciliar estados en silencio. Supersede lo dicho sobre traducciones como versiones separadas en el documento maestro §10.3 regla 2 y D0-08.
- **Migración:** `014_modelo_bilingue_v2.sql` (forward-only, aditiva). Sin cambios en HITL (DEC de Fase 1) ni en DEC-042.
- **Fuera de alcance:** IA de traducción, UI ES|EN, exportación, hacer el EN obligatorio para aprobar.
- **Dónde vive:** `infra/db/migrations/014_modelo_bilingue_v2.sql`; `packages/domain/src/representations.ts`, `brief-states.ts`; `packages/db/src/brief-representations.ts`, `versioning.ts`, `brief-version.ts`; detalle en `docs/product/BILINGUAL_MODEL_V2.md`.
- **Responsable de aprobación:** Gerardo Calambás.

### DEC-044 — Influencer (identidad) y CampaignInfluencer (participación): entidades separadas, aislamiento y producto impuestos en la base

- **Fecha:** 4 de octubre de 2026
- **Estado:** **aprobada** — V2 · Fase 3
- **Origen:** el workflow V2 exige que «la relación del influencer con la campaña» sea el contexto central de contenido, operación y performance, y que una persona no se duplique por trabajar en varias plataformas o campañas. No existía ninguna entidad equivalente en el código (D0-08 §5 solo las reservaba: `Influencer`, `CampaignCreator`).
- **Decisión:** (1) `Influencer` es la identidad estable, propiedad de una organización (agencia); no lleva nada de campaña. (2) Sus cuentas viven en `influencer_accounts` (plataforma + handle); la identidad fuerte es `UNIQUE (organización, plataforma, handle normalizado)` con una única regla de normalización determinística (`normalizeHandle`, sin fuzzy); el nombre nunca es clave. (3) `CampaignInfluencer` es la participación, con `UNIQUE (campaña, influencer)` y un estado mínimo `activo | retirado` (retirar conserva la fila; no hay borrado). (4) El producto asignado referencia `campaign_products` (no catálogo ni texto) mediante claves compuestas que hacen imposible asignar un producto de otra campaña. (5) El aislamiento por organización se impone con claves foráneas compuestas, no solo en la aplicación. (6) Permisos: `influencer:read|manage` y `campaign_influencer:read|manage` para admin/director/consultor; el Operativo solo lee; el cliente y el sistema no obtienen nada nuevo. (7) Sin campo de origen: `audit_events.origin` ya registra quién y por qué canal. (8) Sin HITL: no son decisiones críticas.
- **Migraciones:** `015_influencers.sql` (identidad y cuentas) y `016_campaign_influencers.sql` (participación y producto asignado), forward-only y aditivas. Solo añaden dos `UNIQUE` (id + columna de aislamiento) a `campaigns` y `campaign_products` para poder referenciarlas con claves compuestas.
- **Fuera de alcance:** Google Sheets, matching, Excel, chat, acuerdos/fee/canje, entregables, guiones, envíos, facturación, pagos, KPIs, dashboard TCL, UI.
- **Dónde vive:** `infra/db/migrations/015_influencers.sql`, `016_campaign_influencers.sql`; `packages/domain/src/influencers.ts`, `permissions.ts`; `packages/db/src/influencers.ts`, `campaign-influencers.ts`, `tx-result.ts`; detalle en `docs/product/INFLUENCER_MODEL_V2.md`.
- **Responsable de aprobación:** Gerardo Calambás.

### DEC-045 — Fuentes enlazadas, localizador generalizado y hojas de cálculo (ingestión ampliada)

- **Fecha:** 4 de octubre de 2026
- **Estado:** **aprobada** — V2 · Fase 4
- **Origen:** el workflow V2 recibe documentos por chat (incluidos Excel y enlaces a Google Sheets) y exige conservar siempre el original y mantener la trazabilidad contenido↔fuente. El modelo anterior suponía que toda fuente es un archivo con página o diapositiva: no podía representar un enlace ni una celda, y rechazaba `.xlsx` explícitamente.
- **Decisión:** (1) `source_documents` sigue siendo LA entidad de fuente, con un discriminador `origin` (`file` | `link`) y restricciones CHECK que imponen qué columnas lleva cada origen; se descartó una entidad superior `sources` (obligaba a migrar FK de evidencia, trabajos y fragmentos, con inmutabilidad, y a duplicar visibilidad y permisos). (2) Una fuente enlazada solo se REGISTRA: sin red, sin descarga, sin OAuth; proveedor y URL canónica se identifican de forma pura y estrecha (https, host exacto de Google, sin credenciales, `gid` preservado) y nace `por_resolver`, sin job. (3) El contrato de ubicación es `SourceLocator` (`page | slide | section | sheet | row | cell | range | region`), `jsonb` validado en la base (`source_locator_valido`) y espejo en dominio; las columnas `page/slide/section/linea` se conservan y un trigger deriva el localizador de ellas (nada histórico se reescribe; la evidencia congelada no se toca). (4) La evidencia que cita un fragmento hereda SIEMPRE su localizador y debe ser de la misma fuente (trigger). (5) `.xlsx` y `.csv` se procesan en el worker sin dependencias nuevas (`zipfile` + `xml.etree`), sin evaluar fórmulas ni ejecutar macros, con límites y rechazo (no truncado silencioso); un fragmento = filas contiguas con pares «cabecera: valor» y rango A1. (6) La representación normalizada es: original (siempre) + fragmentos localizados + estructura (`source_representations`, hoy el manifiesto del libro). (7) Un fallo determinista de ingestión (libro inválido) deja el job `fallido` sin reintentos; la ingestión completada/fallida se audita con origen `system`. Supersede la regla de DEC-010 que mandaba el Excel a «excepción manual».
- **Migraciones:** `017_estado_por_resolver.sql`, `018_fuentes_enlazadas_y_localizador.sql` (forward-only, aditivas).
- **Fuera de alcance:** Google Sheets (OAuth/API/lectura/sincronización), validación de columnas, importación y matching de influencers (Fase 5), OCR/visión, `.xls` binario, previews, UI.
- **Dónde vive:** `infra/db/migrations/017…018`; `packages/domain/src/source-locator.ts`, `linked-sources.ts`, `file-validation.ts`; `packages/db/src/sources.ts`, `locators.ts`, `search.ts`, `storage.ts`; `services/ai-worker/app/parsers/{xlsx_parser,csv_parser,tabular}.py`, `runner.py`, `validation.py`; detalle en `docs/product/INGESTION_SPREADSHEETS_V2.md`.
- **Responsable de aprobación:** Gerardo Calambás.

### DEC-046 — Google Sheet de influencers: snapshots inmutables, esquema V1, importación con plan y resolución humana

- **Fecha:** 4 de octubre de 2026
- **Estado:** **aprobada** — V2 · Fase 5
- **Origen:** el workflow V2 define los influencers de una campaña mediante un Google Sheet estructurado que el sistema valida, asocia con registros existentes y convierte en la relación influencer–campaña, pidiendo confirmación solo ante ambigüedad. Un Sheet es mutable: leerlo «tal como está hoy» perdería qué contenido originó cada decisión histórica. La Fase 4 dejó el enlace registrado (`por_resolver`), sin resolverlo.
- **Decisión:** (1) **LinkedSource ≠ fetch genérico.** La resolución es una integración explícita con Google Sheets en el worker: cuenta de servicio de solo lectura (`spreadsheets.readonly`, `google-auth` oficial), hosts fijos, destino construido desde `external_id` validado y nunca desde la URL, tiempo/tamaño acotados, errores sanitizados, credenciales solo en un archivo fuera del repo. El trigger que impedía jobs sobre enlaces se **estrecha**, no se elimina: `google_sheet_sync` solo para `google_sheets`. (2) **Snapshots inmutables** (`source_snapshots`, filas, fragmentos con el mismo contrato tabular de la Fase 4): cada lectura distinta crea uno; la idéntica no (hash canónico); una fallida nunca toca el vigente; `current_snapshot_id` cambia atómicamente solo después de guardar la lectura completa y solo avanza; la evidencia histórica sigue resolviendo a su snapshot. Los archivos conservan su modelo. (3) **Esquema `TCL_KOL_OS_INFLUENCERS_V1`**, versionado y verificable por máquina (marcador en A1, cabeceras canónicas, una fila = una cuenta, `clave_influencer` estable como identidad dentro de la fuente; el nombre nunca agrupa). Las columnas de acuerdo/fee/entregables/KPI se validan y se **conservan** en el snapshot; no se materializan ni se vuelcan a `CampaignInfluencer`. (4) **Plan de importación** ligado a un snapshot (no se recalcula), con matching **solo determinístico** (binding > cuenta exacta > crear > humano; sin fuzzy ni IA), producto contra `campaign_products`, y estado de negocio separado del técnico. (5) **Aplicar** con los casos de uso de la Fase 3 a nombre de la persona que importa (`created_by NOT NULL` intacto; el sistema no muta), idempotente y sin retirar, reemplazar ni desasignar nada por ausencia o cambio. (6) **Resolución humana** append-only y auditada (elegir persona, crear, elegir producto, ignorar), con **binding** estable que gana en sincronizaciones posteriores y **procedencia** estructurada (participación → snapshot → hoja y rango). (7) Sin `ProposedAction` para importar (no es una aprobación crítica); HITL intacto. (8) **Campaña archivada o cancelada:** lee, sincroniza, compara y planea; no materializa ni resuelve (decisión que dejó pendiente la Fase 3).
- **Migraciones:** `019_snapshots_fuentes_enlazadas.sql`, `020_importacion_influencers.sql` (forward-only, aditivas; probadas desde base vacía y como actualización de una copia de datos reales).
- **Dependencias nuevas (worker):** `google-auth`, `requests` — oficiales y mantenidas, necesarias para firmar el JWT de la cuenta de servicio sin criptografía manual; solo detrás de `google_sheets.py`.
- **Fuera de alcance:** UI, chat, sincronización programada/autónoma (exige decidir un actor de servicio), OAuth interactivo, escritura en Google, Drive general, Agreements/Deliverables/KPIs/pagos, fuzzy matching, baja o fusión de cuentas y personas, *smoke test* contra Google real.
- **Dónde vive:** `infra/db/migrations/019…020`; `services/ai-worker/app/google_sheets.py`, `runner.py`; `packages/domain/src/source-snapshots.ts`, `influencer-sheet.ts`, `influencer-import.ts`; `packages/db/src/source-sync.ts`, `influencer-import.ts`, `fragment-scope.ts`; detalle en `docs/product/GOOGLE_SHEETS_IMPORT_V2.md` y contrato del Sheet en `docs/product/INFLUENCER_SHEET_V1.md`.
- **Responsable de aprobación:** Gerardo Calambás.

### DEC-047 — Chat y agente de Cuenta: runtime híbrido, tools como adaptadores de casos de uso y HITL extendido

- **Fecha:** 5 de octubre de 2026
- **Estado:** **aprobada** — V2 · Fase 6
- **Origen:** el workflow V2 hace del chat la superficie principal de Cuenta: el agente convierte conversación en estructura, pero «la IA nunca aprueba» y una acción crítica exige intención → acción visible → confirmación humana → cambio de estado. El repositorio no tenía conversación, mensajes, runs, tools ni un camino humano para confirmar una acción propuesta.
- **Decisión:** (1) **Runtime híbrido.** Node (`packages/agent`) orquesta el bucle y ejecuta las tools **como la persona** (`origin = 'chat'`); el worker Python hace **una** llamada de modelo sin estado (`POST /modelo/turno`, tool calling estructurado, sin ejecutar tools, sin guardar razonamiento). No se enmienda D0-09 §3.1: la web no llama al proveedor. (2) **El chat produce estructura, no es una base paralela.** Migración 021: conversaciones owner-scoped, mensajes append-only, adjuntos que apuntan a `source_documents` (sin sistema documental paralelo), referencias a fuente/fragmento/snapshot, `agent_runs` (un run activo por conversación), `agent_tool_invocations` (claim de idempotencia), `ai_runs` con `agent_run_id`/`step_index`. (3) **Permisos nuevos solo `chat:read`/`chat:write`** (admin, director, consultor); las tools heredan los del caso de uso, y el registro relee al actor en **cada** paso. (4) **Tools = adaptadores finos** sobre casos de uso existentes (25: 14 lectura, 8 escritura, 3 que solo proponen). Único caso de uso nuevo: `actualizarCampana`. Prohibidas y verificadas por un manifiesto estático (D15): aprobar, confirmar/ejecutar acciones, cambiar visibilidad, archivar/crear campañas, retirar influencers, auditar o abrir el pool. (5) **HITL extendido sin segundo sistema:** `ProposedActionType` += `influencer_import.apply` y `influencer_import.resolve_record` mediante un registro de handlers; `applyInfluencerImport` y `resolveImportRecord` rechazan `origin = 'chat'`; la confirmación es siempre una persona por canal `ui` con la huella mostrada. `brief.approve` conserva su atomicidad; los nuevos usan el modo **`idempotent_external`** (ejecución única por bloqueo de fila, recuperación por reintento idempotente, no por rollback; `executed` = el caso de uso corrió, puede haber registros bloqueados pendientes) y un cupo de 2 ejecuciones simultáneas por proceso para no agotar el pool. (6) **Carrera de `proponerAccion` cerrada:** índice único parcial sobre propuestas abiertas + bloqueo consultivo + reintento ante 23505. (7) **Contenido no confiable:** todo texto de documentos, notas PPTX, celdas de Sheets, nombres y títulos va en sobres con nonce HMAC por run; `fuenteLegibleParaIA` = procesada, con texto y no `sensible`; las tools con efecto exigen una **cita literal** de un mensaje de la persona (nunca de una fuente) y los valores de respuesta se contrastan con lo que la persona escribió. (8) **Run durable = fila Postgres**, `after()` + barrido perezoso, polling (sin streaming); kill-switch `AI_ENABLED` en admisión, por paso y en el worker; sin kill-switch por organización (deuda). (9) **Corrección previa:** el cliente Node lee `AI_WORKER_URL ?? WORKER_URL` (el desajuste `WORKER_URL`/`AI_WORKER_URL` era un defecto real).
- **Tabla tool → caso de uso reutilizado:** en `docs/product/CHAT_AGENT_V2.md` §5.
- **Migración:** `021_chat_agente.sql` (forward-only, aditiva; probada desde base vacía y como actualización de una copia con datos y con propuestas abiertas duplicadas: 34 de 34 tablas existentes con md5 idéntico).
- **Verificación:** QA adversarial por un subagente que no implementó (12 vectores): 0 P0 y 0 P1; 7 P2 y 14 P3 hallados, todos corregidos (los 3 P3 de defensa en profundidad en F6.1, migración 022); mutaciones sobre las garantías críticas (confirmar/ejecutar por chat, aprobar desde chat, importar desde chat, auditoría de tools, capacidad base de tools) rompen pruebas.
- **Deuda declarada:** gateway del worker sin autenticación; `after()` no durable (cubierto por barrido); sin streaming, resumen de conversación ni búsqueda semántica en tools; sin kill-switch por organización; `/extraccion` sin kill-switch; `influencer_import.*` con garantía más débil; sin límite de tasa por usuario; smoke real contra el proveedor no ejecutado (sin clave; `tool_choice`/`require_parameters` sin verificar contra OpenRouter); contador de repeticiones de lectura en memoria del proceso.
- **Hardening F6.1 (migración `022_endurecimiento_chat.sql`):** cierra QA-10/11/12 **en la base**, sin cambiar comportamiento funcional: (a) solo la persona dueña de una conversación escribe en ella; (b) el dueño, el autor de mensajes y quien lanza un run deben ser admin, director o consultor de una agencia (antes solo se excluía al `cliente`; una prueba de paridad con `roleCan(rol, 'chat:write')` detecta divergencias con el dominio); (c) una acción propuesta nace `pending`, sin marcas de confirmación/ejecución/cancelación, y los demás estados solo se alcanzan por transición. Solo reemplaza funciones de trigger: no toca tablas ni datos, y las filas existentes no se revalidan (upgrade 021→022 con datos: 40 de 40 tablas con md5 y conteos idénticos).
- **Fuera de alcance:** guiones, versiones de contenido y hallazgos (Fase 7), agente Operativo, memoria larga, workflows autónomos, fuzzy matching, traducción automática, UI V2 final, limpieza legacy.
- **Dónde vive:** `infra/db/migrations/021…022`; `packages/domain/src/{chat,agent-context,proposed-actions}.ts`; `packages/db/src/{chat-*,agent-*,proposed-action-handlers,audit-context}.ts`; `packages/agent`; `services/ai-worker/app/modelo_turno.py`; `apps/web/src/{lib/chat-*,app/(app)/campanas/[id]/chat,app/api/campanas/[id]/chat/adjuntos}`; detalle en `docs/product/CHAT_AGENT_V2.md`.
- **Responsable de aprobación:** Gerardo Calambás.

### DEC-048 — Contenido: Deliverable, ScriptVersion versionada sin sobrescritura, revisión contra el Brief aprobado vigente y aprobación humana

- **Fecha:** 6 de octubre de 2026
- **Estado:** **aprobada** — V2 · Fase 7
- **Origen:** el workflow V2 exige que Cuenta entregue guiones, que el agente los analice contra el **Brief aprobado vigente**, que cada versión se conserve sin sobrescribir y que la aprobación sea una decisión humana explícita («la IA nunca aprueba»). No existía ninguna entidad de contenido: ni entregable, ni guion, ni hallazgo, ni comentario de revisión.
- **Decisión:** (1) **Deliverable ≠ CampaignInfluencer.** El entregable cuelga de la participación (`campaign_influencers`), con claves foráneas compuestas que imponen organización y campaña en la base; `platform` es informativa y opcional; clave estable `UNIQUE (participación, etiqueta normalizada)` entre activos. Sin tipo, sin fee/pago/envío/KPI/publicación y sin JSON de listas: todo lo futuro cuelga de entidades explícitas. (2) **ScriptVersion es una entidad propia** (no reutiliza `brief_versions`): una versión es un archivo recibido (`source_documents`, origen archivo, visibilidad interna), con número asignado por la base bajo bloqueo del entregable, hash y nombre derivados de la fuente, e inmutable en identidad y contenido. Una fuente es versión de exactamente un entregable (UNIQUE en la 025). (3) **Estados:** `received → in_review → changes_requested | approved`, más `superseded`. `changes_requested` es terminal (reabrir = V(N+1)); `superseded` solo como efecto interno de aprobar una versión mayor. (4) **Latest ≠ aprobada vigente.** La vigente es la ÚNICA fila `approved` del entregable (índice único parcial); al aprobar una versión mayor la anterior pasa a `superseded` conservando intactas `approved_at/by/via/snapshot` (el hecho «V3 fue aprobada» no se destruye). No hay puntero en el entregable ni segundo registro de decisiones: el ledger es `audit_events`. Aprobar hacia atrás está prohibido. (5) **Brief rector** (lector nuevo `obtenerBriefRector`): la versión lógica `es` con `approved_at` de mayor fecha en estado `approved|superseded`; una hija en borrador NO desplaza al padre aprobado; sin rector no hay análisis (`BRIEF_NOT_APPROVED`), jamás se usa un borrador. (6) **Revisión (`content_analysis_runs`) de dos tipos:** `ai_assisted` (worker `POST /modelo/analisis`, una llamada sin estado; Node arma el contexto con sobres no confiables, valida la salida con un validador estricto TODO-O-NADA —alias y citas literales verificados por código, el modelo no emite severidad ni ids— y persiste en una sola transacción) y `human` (la registra solo una persona por canal ui). Cada revisión queda ligada a la ScriptVersion exacta y al Brief gobernante exacto (con huella); la vigencia CURRENT/STALE se DERIVA (no se guarda): aprobar un Brief nuevo vuelve STALE la revisión anterior sin reescribirla. Idempotencia por clave + hash; reanálisis explícito = run nuevo; un `ai_runs` por llamada, también en fallos. (7) **Hallazgos ≠ comentarios.** Los findings (derivados del Brief; categorías cerradas; con referencia al requisito del Brief y su evidencia/fuente original y a la cita literal del guion con localizador y hash) no tienen estado ni autor humano. Los comentarios SmartPR y las solicitudes de cambio son otra tabla: autor persona obligatorio, origen ui|chat; en chat el texto es una cita exacta del mensaje en curso, impuesto también por trigger. Las sugerencias editoriales de la IA nunca se guardan solas. (8) **Aprobación.** Un solo caso de uso (`aprobarScriptVersion`) para el botón directo y para el handler HITL `script_version.approve` (modo `atomic`); `huellaVista` obligatoria; origen ≠ ui ⇒ `HUMAN_CONFIRMATION_REQUIRED`. Exige una **CURRENT REVIEW** (IA o humana) contra el Brief rector; **cero hallazgos NO es requisito y los hallazgos abiertos NO bloquean** (el humano decide; la tarjeta los muestra y se audita el snapshot aprobado). Aprueban solo admin y director (`script:approve`, como `brief:approve_internal`); el consultor prepara y propone (`script:manage`). Huella = snapshot {versión, entregable y cabeza, aprobada que reemplaza, Brief y su huella, revisión, hallazgos por severidad, comentarios, participación}; se revalida al confirmar, al ejecutar y bajo bloqueo (`PROPOSAL_STALE`); orden de bloqueo PA → entregable → versión → Brief `FOR SHARE`. (9) **Agente:** 11 tools nuevas (36 en total), todas adaptadores de casos de uso; NO existen tools para aprobar, confirmar/ejecutar, registrar revisión humana, cambiar visibilidad ni archivar. Alias E/V/H/C (UUID rechazado), cerco de campaña en el caso de uso y en la tool, asociación de adjuntos inequívoca (`needs_choice` ante dos Valentinas), sección de contexto `content` sin texto de guion y prompt `agente-cuenta-3`. (10) **Visibilidad:** la fuente de un guion es interna; la base impide exponer a TCL la fuente de una versión no aprobada y proteger el original y sus fragmentos; las fuentes de guion se excluyen de la extracción del Brief; el Operativo solo ve estado y la aprobada vigente (sin hallazgos, comentarios ni archivos no aprobados); el cliente no recibe capacidades hasta la Fase 9.
- **Migraciones:** `023_contenido_guiones.sql`, `024_analisis_de_contenido.sql`, `025_endurecimiento_contenido.sql` (forward-only, aditivas; upgrade 022→024 y 024→025 con datos y md5 idéntico por tabla; desde cero 1→25 + seed).
- **Contradicciones resueltas:** el handoff indicaba `obtenerBriefWorkspace` para el Brief vigente (devuelve la última versión de cualquier estado: no sirve); «la IA nunca es requisito» vs «aprobar exige análisis» se resolvió por decisión de producto generalizando a una CURRENT REVIEW que puede ser humana; el catálogo del Brief no tiene campo CTA (se usa `accion_kpis.accion_esperada`).
- **Verificación:** QA adversarial independiente del backend (16 vectores + A–I): 0 P0 y 0 P1; 2 P2 y 9 P3 corregidos en la 025 con sus pruebas de regresión. Mutaciones sobre las garantías críticas (aprobar desde chat/system, handler sin huella, huella sin revisión/cabeza/reemplazo, sin revalidación bajo bloqueo, sin bloqueo del entregable, hallazgos como bloqueo, sin cerco de campaña, aprobación desde tool, etc.) rompen pruebas.
- **Deuda declarada:** texto pegado en el chat como guion (MVP exige adjunto); descarga de originales; triage/resolución de hallazgos; bridge desde la columna `entregables` del Sheet (texto libre); STALE por cambio de alcance de producto solo se detecta al aprobar; smoke real del análisis contra el proveedor no ejecutado; análisis síncrono (hasta ~100 s); la nav de Fuentes no tiene «Contenido» (archivo en la deuda de Prettier de V1); cancelar un Brief aprobado no invalida guiones ya aprobados; el Operativo conserva `source:read` (excluidos los guiones no aprobados).
- **Fuera de alcance:** acuerdos, fee/canje, envíos, facturación, pagos, KPIs, publicación y performance (Fase 8); dashboard TCL (Fase 9); traducción automática; agente Operativo; limpieza legacy.
- **Dónde vive:** `infra/db/migrations/023…025`; `packages/domain/src/{content,content-analysis,content-analysis-prompt,permissions,proposed-actions}.ts`; `packages/db/src/{deliverables,script-versions,script-review,content-analysis,content-analysis-client,script-approval,contenido-views}.ts` y `proposed-action-handlers.ts`; `packages/agent/src/tools/catalog/{entregables,guiones,revision,hitl}.ts`; `services/ai-worker/app/{modelo_analisis,ai/fake_analisis}.py`; `apps/web/src/app/(app)/campanas/[id]/contenido`, `apps/web/src/lib/contenido-*.ts`; detalle en `docs/product/CONTENT_V2.md`.
- **Responsable de aprobación:** Gerardo Calambás.

---

## Decisiones pendientes que no bloquean MVP 0

Quedan abiertas y sin efecto sobre el arranque, se resuelven durante la ejecución:

| Punto | Motivo por el que no bloquea |
|---|---|
| Contraparte formal en TCL Colombia | El flujo interno de SmartPR puede documentarse y prototiparse sin ese nombramiento. |
| Selección final de 5–10 campañas para D0-02/D0-14 | Se define con documentos reales que el usuario aportará durante la ejecución. |
| Migración de datos a backup externo | Aceptada como riesgo (ADR-005), se revisa en un incremento posterior. |
