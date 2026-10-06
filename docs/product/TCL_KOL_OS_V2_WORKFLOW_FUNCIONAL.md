# TCL KOL OS V2 — Workflow funcional por usuario

## Propósito

Este documento define el workflow funcional de TCL KOL OS V2 desde la perspectiva de sus tres tipos de usuario:

1. Usuario de Cuenta — SmartPR
2. Usuario Operativo — SmartPR
3. Cliente — TCL

Este documento describe únicamente qué hace cada usuario, qué puede ver, qué no puede ver y cómo se relacionan sus acciones dentro del mismo proyecto.

---

# 1. Usuario de Cuenta — SmartPR

## Rol principal

Es el usuario principal para la gestión de campaña, construcción del conocimiento del proyecto y gestión de contenido con apoyo del agente conversacional.

Su experiencia principal dentro del proyecto es el chat.

## 1.1. Creación del proyecto

El cliente siempre es TCL.

Al crear un proyecto, el usuario puede definir:

- Nombre del proyecto
- Nombre interno, cuando aplique

Las fechas del proyecto pueden registrarse de dos maneras:

- El usuario las indica de forma natural dentro del chat y el agente las interpreta.
- El usuario puede definirlas manualmente mediante una opción de fecha de inicio y fecha de finalización.

## 1.2. Entrada principal al proyecto

Una vez creado el proyecto, el usuario entra directamente a la conversación del proyecto.

Desde el chat puede:

- Adjuntar archivos.
- Compartir enlaces.
- Dar instrucciones.
- Aportar contexto.
- Responder preguntas del agente.
- Trabajar el brief.
- Gestionar información de influencers.
- Entregar guiones para revisión.
- Revisar versiones.
- Preparar aprobaciones.

La conversación es el centro de trabajo del usuario de Cuenta.

## 1.3. Ingreso y organización de documentación

El usuario puede entregar documentos como:

- PDF
- PowerPoint
- Word
- Excel
- Imágenes
- Enlaces a Google Sheets
- Otros archivos de campaña

El agente debe:

1. Conservar el archivo original.
2. Identificar qué tipo de documento es.
3. Asociarlo al proyecto correcto.
4. Clasificarlo dentro de la documentación del proyecto.
5. Generar una representación procesable para el sistema cuando sea necesario.
6. Extraer la información relevante.
7. Mantener la relación entre la información extraída y su fuente original.
8. Preguntar al usuario únicamente cuando exista una ambigüedad que no pueda resolverse con suficiente certeza.

El usuario no debería tener que clasificar manualmente cada documento, salvo en casos excepcionales.

## 1.4. Construcción del Brief

SmartPR cuenta con un template interno de Brief.

Ese template es la estructura obligatoria que debe respetar el Brief generado dentro del sistema.

El agente:

- Lee las fuentes disponibles.
- Intenta completar el template de Brief con la información encontrada.
- Identifica información faltante.
- Detecta contradicciones.
- Identifica campos que requieren confirmación.
- Hace preguntas al usuario de Cuenta dentro del chat.
- Actualiza el Brief a partir de las respuestas.
- Mantiene trazabilidad entre el contenido del Brief y las fuentes utilizadas.

El Brief se construye de forma colaborativa entre el agente y el usuario de Cuenta.

## 1.5. Idiomas

Todo documento generado dentro de TCL KOL OS debe poder visualizarse en:

- Español
- Inglés

Las dos versiones lingüísticas deben pertenecer al mismo documento y a la misma versión.

Ejemplo conceptual:

Documento: Brief de campaña  
Versión: 3  
Vistas:
- ES
- EN

No deben existir dos workflows separados, dos aprobaciones distintas ni dos documentos independientes para cada idioma.

Debe existir:

- Una sola entidad documental.
- Una sola versión.
- Un solo estado.
- Una sola aprobación.
- Dos representaciones lingüísticas.

En la interfaz, el usuario debe poder cambiar entre ES y EN dentro de la misma vista del documento.

## 1.6. Gestión de influencers

Los influencers de una campaña pueden definirse mediante un Google Sheet externo estructurado.

El usuario puede compartir el enlace dentro del chat e indicar que ese Sheet será la fuente de gestión de influencers de la campaña.

El Sheet debe cumplir una estructura definida por TCL KOL OS.

Puede contener, entre otros datos:

- Nombre del influencer.
- Identificador o handle.
- Plataforma.
- Producto asignado.
- Entregables.
- Tipo de acuerdo.
- Fee, canje o modalidad mixta.
- Fechas.
- KPIs pactados.
- Condiciones relevantes.

El sistema debe:

- Validar la estructura.
- Identificar influencers.
- Asociarlos con registros existentes cuando corresponda.
- Crear la relación del influencer con la campaña.
- Detectar ambigüedades.
- Pedir confirmación únicamente cuando sea necesario.

La relación del influencer con la campaña debe convertirse en el contexto central desde el cual se conectan contenido, operación y performance.

## 1.7. Gestión de guiones

Cuando el usuario entrega un guion, el agente debe trabajar dentro del contexto de:

- Proyecto.
- Influencer.
- Producto.
- Entregable.
- Brief vigente.
- Mensajes clave.
- CTA.
- Claims.
- Restricciones.
- Evidencias disponibles.

El Brief aprobado vigente funciona como documento rector.

El agente debe analizar el guion contra ese Brief y devolver observaciones.

Las observaciones pueden incluir, entre otras:

- CTA ausente.
- Mensaje clave incompleto.
- Claim sin suficiente respaldo.
- Restricción incumplida.
- Requisito del Brief no cubierto.

El usuario de Cuenta también puede añadir comentarios propios.

El sistema debe diferenciar entre:

- Hallazgos derivados del Brief.
- Comentarios añadidos por SmartPR.

## 1.8. Versionado de guiones

Los guiones deben versionarse.

Una nueva versión nunca sobrescribe la anterior.

Ejemplo:

Influencer: Valentina  
Entregable: Reel principal

- V1
- V2
- V3 — aprobada

Cada versión debe conservar como mínimo:

- Nombre del archivo.
- Número de versión.
- Influencer asociado.
- Entregable asociado.
- Fecha.
- Comentarios.
- Cambios solicitados.
- Estado.

La plataforma debe mantener el historial completo.

## 1.9. Aprobación

La IA nunca aprueba por sí sola.

La conversación puede detectar que el usuario manifiesta intención de aprobación, pero eso no debe ejecutar automáticamente el cambio de estado.

Ejemplo:

Usuario:  
“Listo, esto quedó aprobado.”

El sistema puede responder indicando que la versión está lista para aprobación y presentar un control físico de confirmación.

La aprobación requiere una acción explícita del usuario autorizado.

Ejemplo:

[Aprobar versión]

Solo después de esa confirmación la versión puede pasar a estado aprobado.

Este patrón debe aplicarse a decisiones críticas:

Conversación  
→ Intención detectada  
→ Acción visible  
→ Confirmación humana  
→ Cambio de estado

## 1.10. Qué puede ver el Usuario de Cuenta

Puede ver el contexto necesario para gestionar la campaña, incluyendo:

- Proyecto.
- Fuentes.
- Documentación de campaña.
- Brief.
- Productos.
- Influencers.
- Guiones.
- Versiones.
- Entregables.
- Comentarios de contenido.
- Evidencias.
- Estado general operativo del influencer.
- KPIs pactados.
- KPIs reales.
- Actividad relevante del proyecto.
- Documentos aprobados.
- Publicaciones.

## 1.11. Qué no debe hacer el Usuario de Cuenta

No debe:

- Delegar la aprobación final a la IA.
- Sobrescribir versiones históricas.
- Eliminar trazabilidad.
- Tener que clasificar manualmente cada documento salvo excepciones.
- Gestionar como tarea principal la operación financiera o administrativa del influencer.
- Cambiar información operativa restringida si su permiso no lo autoriza.
- Ejecutar aprobaciones críticas sin confirmación explícita.

---

# 2. Usuario Operativo — SmartPR

## Rol principal

Gestiona la relación operativa, documental y administrativa con los influencers.

Su experiencia principal no es el chat.

Su centro de trabajo es la gestión estructurada de los influencers de cada proyecto.

## 2.1. Acceso a influencers

El Usuario Operativo accede a los mismos influencers ya asociados al proyecto.

No crea una lista paralela ni duplica registros.

Cada influencer debe existir como una única relación dentro de la campaña.

Desde esa relación gestiona:

- Acuerdos.
- Producto.
- Envíos.
- Facturación.
- Pagos.
- Documentación.
- KPIs.
- Performance.

## 2.2. Gestión de acuerdos

Puede consultar y registrar:

- Tipo de acuerdo.
- Fee.
- Canje.
- Modalidad mixta.
- Entregables.
- Condiciones.
- Fechas.
- Cotizaciones.
- Órdenes de compra.
- Documentación asociada.

## 2.3. Gestión de producto

Puede gestionar:

- Producto asignado.
- Estado del envío.
- Fecha de envío.
- Transportadora.
- Número de tracking.
- Costo de envío.
- Guía de envío.
- Fecha de recepción.
- Devolución, cuando aplique.
- Soportes asociados.

Los estados pueden contemplar, por ejemplo:

- Pendiente.
- Enviado.
- Recibido.
- Devuelto.

## 2.4. Facturación y pagos

Cuando el acuerdo implique pago, puede gestionar:

- Cuenta de cobro pendiente.
- Cuenta de cobro recibida.
- Validación.
- Pago pendiente.
- Pago realizado.
- Comprobante de pago.

Cuando el acuerdo sea exclusivamente por canje, las etapas financieras que no correspondan deben marcarse como no aplicables y no permanecer como pendientes.

## 2.5. Documentación operativa

Puede adjuntar y consultar documentos como:

- Cotizaciones.
- Órdenes de compra.
- Cuentas de cobro.
- Comprobantes de pago.
- Guías de envío.
- Contratos.
- Acuerdos.
- Soportes administrativos.

Los documentos deben relacionarse con el evento o proceso operativo al que pertenecen.

Ejemplo:

Evento: Producto enviado  
Soporte: guia-transporte.pdf

## 2.6. KPIs y performance

El Usuario Operativo puede consultar los KPIs pactados originalmente para cada influencer.

Posteriormente puede alimentar los KPIs reales.

Formas de ingreso previstas:

### MVP inicial
- Entrada manual.
- Carga mediante Excel o CSV.

### Evolución posterior
- Sincronización con Google Sheets.
- Integraciones con fuentes externas.
- Otras automatizaciones.

El sistema debe poder comparar:

- KPI objetivo.
- KPI real.

Y mostrar el estado correspondiente.

Ejemplo:

Views  
Objetivo: 50.000  
Resultado: 61.420  
Estado: Cumplido

## 2.7. Qué puede ver el Usuario Operativo

Puede ver:

- Proyecto.
- Influencers.
- Productos asignados.
- Entregables pactados.
- Fechas principales.
- Tipo de acuerdo.
- Fee, canje o modalidad mixta.
- Cotizaciones.
- Órdenes de compra.
- Estado de envío.
- Guías.
- Recepción.
- Devolución.
- Facturación.
- Pagos.
- Comprobantes.
- KPIs pactados.
- KPIs reales.
- Estado general del contenido.
- Estado del guion.
- Estado de publicación.
- Documentos aprobados necesarios para su gestión.

## 2.8. Qué no debe hacer el Usuario Operativo

No debe:

- Modificar el Brief.
- Aprobar el Brief.
- Revisar o editar guiones como responsable creativo.
- Modificar mensajes clave.
- Administrar el agente de contenido como experiencia principal.
- Aprobar versiones creativas si no tiene ese permiso.
- Ver razonamiento interno de IA.
- Reemplazar versiones aprobadas.
- Borrar documentación o eventos históricos sin trazabilidad.

## 2.9. Agente operativo

Un agente conversacional específico para operaciones no forma parte del MVP inicial.

En una versión posterior podría responder consultas como:

- ¿Qué influencers todavía no han recibido producto?
- ¿Quiénes tienen cuenta de cobro pendiente?
- ¿Qué pagos siguen abiertos?
- ¿Qué entregables están vencidos?

En el MVP inicial, navegación estructurada, estados, búsqueda y filtros son suficientes.

---

# 3. Cliente — TCL

## Rol principal

El cliente supervisa la campaña.

No opera el sistema y no participa en decisiones internas.

Su experiencia principal es un dashboard de solo lectura.

## 3.1. Acceso general

El cliente puede:

- Entrar al sistema.
- Seleccionar una campaña.
- Consultar el estado general.
- Ver influencers.
- Consultar hitos.
- Ver documentos compartidos.
- Consultar guiones aprobados.
- Ver publicaciones.
- Consultar KPIs.
- Exportar información permitida.

No modifica el workflow.

## 3.2. Vista general de campaña

El cliente puede ver información como:

- Número total de influencers.
- Guiones aprobados.
- Influencers en producción.
- Contenidos publicados.
- Avance general.
- Estado de campaña.
- KPIs generales.
- Hitos principales.

Ejemplo:

18 influencers  
14 guiones aprobados  
7 en producción  
5 publicados  
72% de avance

## 3.3. Vista por influencer

Puede consultar información como:

- Influencer.
- Producto.
- Estado del producto.
- Estado del guion.
- Estado de producción.
- Estado de publicación.
- Entregables.
- KPIs.
- Resultados.
- Guion aprobado.
- Publicaciones finales.

Ejemplo:

Influencer: Valentina Rojas  
Producto: TCL C7K  
Producto recibido: Sí  
Guion: Aprobado  
Producción: En curso  
Publicación: Pendiente

## 3.4. KPIs

El cliente debe ver KPIs como:

- Objetivo.
- Resultado.
- Cumplimiento.

Ejemplo:

Views  
Resultado: 61.420  
Objetivo: 50.000

Reach  
Resultado: 41.280  
Objetivo: 35.000

Engagement  
Resultado: 4,7%  
Objetivo: 4%

## 3.5. Documentación visible para TCL

El cliente puede consultar documentación que:

- Haya sido entregada originalmente por TCL.
- SmartPR haya decidido exponer.
- Sea parte de los entregables aprobados de campaña.

Ejemplos:

- Brief original enviado por TCL.
- Presentación de producto.
- Presentación proveniente de China.
- Otras fuentes entregadas por TCL.
- Brief final aprobado.
- Otros documentos finales definidos como compartidos.

Los documentos compartidos deben conservar sus vistas en Español e Inglés cuando el sistema los genere.

## 3.6. Documentación no visible para TCL

El cliente no debe ver:

- Fees de influencers.
- Cuentas de cobro.
- Comprobantes de pago.
- Costos internos.
- Órdenes de compra internas.
- Costos de envío.
- Documentación administrativa privada.
- Conversaciones internas.
- Prompts.
- Análisis internos de IA.
- Comentarios internos de SmartPR.
- Versiones rechazadas.
- Borradores.
- Notas internas.
- Historial técnico completo.
- Razonamiento interno del sistema.

## 3.7. Acciones que el cliente no puede ejecutar

El cliente no puede:

- Aprobar.
- Rechazar.
- Solicitar cambios dentro del sistema.
- Cambiar estados.
- Editar el Brief.
- Modificar KPIs.
- Modificar acuerdos.
- Cargar documentación operativa interna.
- Gestionar pagos.
- Gestionar envíos.
- Alterar versiones de contenido.
- Introducir comentarios operativos en el workflow interno.

Si el cliente desea solicitar un cambio, la comunicación ocurre por fuera del producto con el responsable de cuenta de SmartPR.

SmartPR incorpora posteriormente esa información al sistema.

---

# 4. Relación entre los tres usuarios

Los tres usuarios trabajan sobre los mismos datos del proyecto.

No deben existir registros duplicados por tipo de usuario.

Ejemplo:

## Usuario de Cuenta

Ve:

Influencer: Juan  
Guion V2  
2 cambios pendientes

## Usuario Operativo

Ve:

Influencer: Juan  
Producto recibido  
Cuenta de cobro pendiente  
Pago pendiente

## Cliente

Ve:

Influencer: Juan  
Producto recibido  
Guion en ajustes  
Publicación pendiente

Los tres están consultando distintos aspectos de la misma relación del influencer con la campaña.

---

# 5. Workflow general V2

## Usuario de Cuenta

Crear proyecto  
→ Abrir chat  
→ Adjuntar fuentes y compartir links  
→ El agente identifica, organiza y procesa  
→ Construcción del Brief mediante template SmartPR  
→ Preguntas y respuestas  
→ Brief ES / EN  
→ Validación humana  
→ Asociación del Google Sheet de influencers  
→ Gestión de influencers  
→ Recepción de guiones  
→ Análisis contra Brief  
→ Ajustes  
→ Versionado  
→ Confirmación física  
→ Aprobación

## Usuario Operativo

Influencers ya definidos  
→ Acuerdos  
→ Producto  
→ Envíos  
→ Documentación administrativa  
→ Facturación  
→ Pagos  
→ Publicación  
→ KPIs reales  
→ Performance

## Cliente — TCL

Dashboard read-only  
→ Avance general  
→ Influencers  
→ Estado de producto  
→ Guion aprobado  
→ Producción  
→ Publicación  
→ KPIs  
→ Documentos compartidos

---

# 6. Reglas funcionales de V2

## 6.1. Un dato existe una sola vez

Las diferentes experiencias consumen la misma entidad y el mismo dato.

No se crean copias independientes para Cuenta, Operaciones y Cliente.

## 6.2. El chat genera estructura

La conversación no debe convertirse en información aislada.

Las acciones realizadas desde el chat deben alimentar objetos estructurados del sistema.

## 6.3. Los archivos originales se conservan

El sistema puede generar representaciones procesables para IA, pero el archivo original debe permanecer disponible.

## 6.4. Versionado obligatorio

Briefs, guiones y otros documentos sujetos a revisión no deben sobrescribirse.

Las versiones anteriores deben conservarse.

## 6.5. Bilingüismo como propiedad del documento

Los documentos generados por la plataforma deben existir como una única entidad con vistas ES y EN.

## 6.6. Human-in-the-loop

El agente puede:

- Organizar.
- Extraer.
- Analizar.
- Proponer.
- Preparar acciones.
- Ejecutar tareas autorizadas.

El agente no sustituye las decisiones humanas críticas.

Las aprobaciones requieren confirmación explícita.

## 6.7. El cliente observa

TCL utiliza el sistema para supervisar campaña, documentos compartidos, contenido aprobado, publicaciones y resultados.

No participa en el workflow operativo interno.

---

# 7. Principio general

**Cuenta construye y decide.**  
**Operaciones ejecuta y registra.**  
**TCL observa.**  
**El agente organiza, analiza y ejecuta tareas autorizadas, pero no sustituye la decisión humana.**
