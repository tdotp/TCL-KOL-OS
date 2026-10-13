> **Documento histórico** (anterior a V2): no describe el modelo vigente; ver docs/project/V2_CURRENT_STATE.md y DEC-042 a DEC-050.

# D0-07 — Matriz de roles y permisos

**Versión:** 1 · **Fecha:** 11 de agosto de 2026 · **Estado:** propuesta para validación
**Fuentes:** documento maestro §3 (usuarios, entornos y permisos), §3.4 (regla de separación), §12 (seguridad); `docs/decisions/decision-log.md` (DEC-003, DEC-011, DEC-012 / ADR-004).

---

## 1. Alcance real de construcción en MVP 1

Esta matriz modela el estado objetivo completo. **No todo se construye en MVP 1.** Según DEC-011, el piloto opera con un único usuario en rol Administrador; según DEC-012 y ADR-004, TCL recibe solo una vista de lectura.

| Rol | ¿Se modela en el sistema? | ¿Se construye e implementa en MVP 1? |
|---|---|---|
| Administrador (SmartPR) | Sí | **Sí** — es el rol del usuario piloto |
| Director / líder de cuenta (SmartPR) | Sí | No — incremento posterior |
| Consultor / PR Manager (SmartPR) | Sí | No — incremento posterior |
| Analista de datos (SmartPR) | Sí | No — incremento posterior |
| Legal / administrativo (SmartPR) | Sí | No — incremento posterior |
| Cliente TCL Colombia | Sí | **Parcial** — solo vista de estado + descarga (ADR-004) |
| TCL China | **No es usuario del sistema** | No aplica |

> El modelo de datos y el middleware de autorización deben soportar los cinco roles de agencia desde el diseño (Épica E2), aunque la interfaz solo exponga el rol Administrador durante el piloto. Esto evita rehacer el control de acceso al incorporar consultores reales.

---

## 2. Matriz de permisos por rol

Leyenda: **T** total · **E** escritura · **L** lectura · **—** sin acceso · **C** condicionado (ver notas)

| Recurso / acción | Admin | Director | Consultor | Analista | Legal | Cliente TCL |
|---|:--:|:--:|:--:|:--:|:--:|:--:|
| Crear campaña | T | E | E | — | — | — |
| Editar campaña | T | E | E | — | — | — |
| Archivar / cancelar campaña | T | E | — | — | — | — |
| Ver lista de campañas | T | L | L | L | C¹ | C² |
| Cargar y vincular fuentes | T | E | E | — | C¹ | — |
| Ver fuentes originales | T | L | L | L | C¹ | — |
| Lanzar procesamiento / reintento | T | E | E | — | — | — |
| Revisar extracción y confirmar campos | T | E | E | — | — | — |
| Responder preguntas locales | T | E | E | — | C¹ | — |
| Editar brief (borrador) | T | E | E | — | — | — |
| Comentar interno | T | E | E | E | E | — |
| Comentar visible para cliente | T | E | E | — | — | C³ |
| Solicitar revisión interna | T | E | E | — | — | — |
| Aprobar internamente | T | E | — | — | — | — |
| Aprobar como cliente | — | — | — | — | — | **Fuera del sistema**⁴ |
| Ver versiones y diferencias | T | L | L | L | C¹ | C² |
| Traducir ES/EN y editar traducción | T | E | E | — | — | — |
| Gestionar glosario | T | E | C⁵ | — | — | — |
| Exportar DOCX / PDF | T | E | E | L | C¹ | C² |
| Ver métricas y KPIs | T | L | L | T | — | — |
| Ver auditoría | T | L | — | L | C¹ | — |
| Ver ejecuciones de IA (costo, modelo, trazas) | T | L | — | L | — | — |
| Gestionar usuarios y roles | T | — | — | — | — | — |
| Gestionar catálogos, plantillas y prompts | T | C⁶ | — | — | — | — |
| Configurar integraciones (Drive, proveedor IA) | T | — | — | — | — | — |
| Activar / desactivar IA (feature flag) | T | — | — | — | — | — |

**Notas**

1. **Legal / administrativo** accede solo a los recursos vinculados a su función (contratos, autorizaciones, facturas) y a las campañas donde tenga un expediente asignado. No accede al contenido creativo del brief. En MVP 1 este rol no tiene interfaz propia; el alcance real se define cuando se construya el módulo documental (MVP 3).
2. **Cliente TCL Colombia** solo ve campañas cuyo brief haya sido enviado (estado `client_review` o posterior) y únicamente las versiones marcadas como visibles para TCL. Nunca ve borradores, comentarios internos, fuentes originales, costos ni trazas de IA.
3. El cliente puede comentar sobre un entregable enviado, pero su comentario **no cambia el estado del brief**: no existe transición "cliente aprueba" dentro del sistema en MVP 1.
4. **La aprobación del cliente ocurre fuera de la plataforma** (correo, reunión), tal como opera hoy. El consultor registra el resultado manualmente. Decisión DEC-012 — es una decisión de negocio deliberada, no una limitación técnica.
5. El Consultor puede **proponer** términos de glosario; aprobarlos y bloquearlos corresponde al Administrador o al Director.
6. El Director gestiona plantillas de exportación y catálogos de producto, pero no prompts ni configuración de modelos, que son responsabilidad del Administrador.

---

## 3. TCL China — actor externo, no usuario

TCL China **no tiene cuenta, acceso ni visibilidad** en TCL KOL OS. Su participación en el proceso es unidireccional: entrega material fuente (PPT de campaña global, fichas técnicas) que SmartPR carga manualmente en la plataforma como `SourceDocument`.

Esto se documenta explícitamente porque el flujo de aprobación descrito inicialmente en el documento maestro (§37, DEC-003) dejaba abierta la posibilidad de una cadena de aprobación multinivel que incluyera a China. La entrevista de descubrimiento la descartó: **China es fuente, no aprobador**. El modelo de aprobación (Épica E8) implementa un solo nivel externo.

---

## 4. Regla de separación entre organizaciones

Todo recurso lleva obligatoriamente (§3.4 del maestro):

| Atributo | Propósito |
|---|---|
| `organizationId` | Organización propietaria del recurso |
| `campaignId` | Campaña a la que pertenece |
| `confidentialityLevel` | pública / interna / confidencial / sensible (§12.2) |
| `visibility` | interna / TCL / compartida |
| `createdBy` | Actor que lo creó |
| `createdAt` / `version` | Fecha y versión |

**Criterio de aceptación de la Épica E2:** ningún usuario puede consultar recursos de otra organización aunque manipule directamente la URL o llame a la API con un ID ajeno. Las pruebas negativas de permisos (§28, categoría Seguridad) verifican específicamente IDOR y escalamiento horizontal.

**Herencia en el índice vectorial:** los embeddings heredan organización, campaña, idioma, versión y permiso del documento origen (§10.3). Una búsqueda semántica nunca puede devolver un fragmento que el usuario no podría abrir directamente.

---

## 5. Cobertura de la Definition of Done

| Requisito (§23.1) | Estado |
|---|---|
| "Roles y permisos cubren Agencia y TCL" | Cubierto: cinco roles de agencia + cliente TCL + aclaración explícita de que TCL China no es usuario |
| Separación entre organizaciones definida | Cubierto en §4 de este documento, con criterio de aceptación verificable |

## 6. Pendientes de esta matriz

| Punto | Responsable | Cuándo se resuelve |
|---|---|---|
| Alcance fino del rol Legal (qué documentos exactamente) | Product owner | Al planificar MVP 3 (gestión documental) |
| Nombramiento de la contraparte formal en TCL Colombia | TCL / SmartPR | No bloquea MVP 1 (ver decision-log) |
| Si el Director puede o no revertir una aprobación interna | Product owner | Antes de cerrar Épica E8 |
