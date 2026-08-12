# D0-04 — Inventario de documentos

**Versión:** 1 · **Fecha:** 11 de agosto de 2026 · **Estado:** propuesta para validación
**Fuentes:** documento maestro §10.1 (`SourceDocument`), §12.2 (clasificación), §8.1 (almacenamiento); `docs/decisions/decision-log.md` (DEC-004, DEC-005, DEC-008, DEC-010).

---

## 1. Documentos que entran al sistema en MVP 1

| # | Documento | Origen | Formato | Dueño | Sensibilidad | Uso en TCL KOL OS | ¿Se indexa? |
|---|---|---|---|---|---|---|---|
| 1 | PPT de campaña global | TCL China | PPTX (a veces PDF) | TCL China | Interna | Fuente primaria del brief local. Se extraen mensajes, claims, target global, calendario y lineamientos de marca. | Sí |
| 2 | Ficha técnica de producto | TCL China / TCL Colombia | PDF, DOCX | TCL | Interna | Fuente de verdad de especificaciones, medidas y compatibilidades. Respalda todo claim técnico como evidencia. | Sí |
| 3 | Brief del cliente (Brief Estratégico) | TCL Colombia | DOCX | TCL Colombia | Interna | Aporta contexto local, objetivo de negocio, tensión y mandatorios. Se cruza con el material de China. | Sí |
| 4 | Brief de campaña – producto | TCL Colombia | DOCX, texto | TCL Colombia | Interna | Variante operativa del anterior: fechas, presupuesto, KPI y restricciones de ejecución. | Sí |
| 5 | One-pager "THE BRIEF" | TCL Colombia / agencia creativa | PPTX, imagen (PNG/JPG) | Variable | Interna | Versión condensada tipo insight. Aporta *one line brief*, comportamiento esperado y datos prácticos (rondas, presupuesto). | Sí (OCR si es imagen) |
| 6 | Imágenes de referencia de producto | TCL China | PNG, JPG | TCL China | Interna | Apoyo visual del brief. No aportan texto extraíble salvo OCR de placas o especificaciones. | Solo si contiene texto relevante |

**Formatos soportados en MVP 1 (DEC-010):** PDF, PPTX, DOCX, PNG, JPG.
**Tamaños de referencia:** documentos de texto ~4 MB; los PPT pueden superarlo ampliamente y deben procesarse de forma asíncrona sin bloquear la interfaz (Épica E4).
**Cualquier otro formato** (XLSX, Keynote, enlaces a video) se trata como excepción de carga manual: se conserva el original y se registra, pero no se procesa automáticamente.

---

## 2. Documentos del ecosistema fuera de alcance de MVP 1

Se inventarían porque existen en el proceso real y condicionan fases posteriores, pero **no se cargan ni procesan en MVP 1**.

| # | Documento | Origen | Formato | Sensibilidad | Fase donde entra | Nota |
|---|---|---|---|---|---|---|
| 7 | Contrato / acuerdo con KOL | SmartPR ↔ KOL | PDF | **Confidencial** | MVP 3 | Corresponde a la entidad futura `ContractDocument`. |
| 8 | Autorización de uso de imagen | KOL | PDF | **Confidencial** | MVP 3 | Requisito legal previo a publicación. |
| 9 | Datos bancarios / tributarios de KOL | KOL | PDF | **Sensible / personal** | No definida | **Nunca se indexa** (§12.3). Además, la remuneración a influencers la gestiona la agencia de Brasil y está fuera de alcance de este proyecto (DEC-008). |
| 10 | Guion de contenido | KOL / SmartPR | DOCX, texto | Interna | MVP 2 | Se revisará contra el brief aprobado. |
| 11 | Video / pieza de contenido | KOL | MP4 y similares | Interna | MVP 7 | **Nunca se indexa completo** (§12.3). |
| 12 | Reporte de cierre de campaña | SmartPR | PPTX, PDF | Confidencial | MVP 6 | Insumo futuro de D0-14 (línea base) y del histórico de aprendizajes. |
| 13 | Remisión de entrega de producto (canje) | SmartPR / logística | PDF, foto | Interna | MVP 4 | Evidencia de entrega de dispositivo. |

---

## 3. Documentos que produce el sistema

| Documento | Generado por | Formato | Visibilidad | Nota |
|---|---|---|---|---|
| Brief local ES | TCL KOL OS | DOCX, PDF | Interna → TCL al enviarse | Exportado desde plantilla versionada (Épica E10) |
| Brief local EN | TCL KOL OS | DOCX, PDF | Interna → TCL al enviarse | Vinculado a la versión ES de origen |
| Reporte de auditoría | TCL KOL OS | Consulta en pantalla, exportable | Interna | Quién cambió, aprobó o exportó qué |

La exportación debe representar **exactamente** el contenido de la versión aprobada y declarar idioma, campaña y versión en el propio archivo (§24, Épica E10).

---

## 4. Dónde viven los archivos

Según DEC-005, el Google Drive de campañas es propiedad de **SmartPR**, no de TCL. No hay dependencia de permisos que el cliente pueda revocar.

| Tipo | Ubicación | Justificación |
|---|---|---|
| Archivo original | Google Drive de SmartPR | Repositorio principal; la plataforma guarda `fileId`, no el archivo (§8.1) |
| Derivados (previews, texto extraído, exportaciones) | Storage S3-compatible | Regenerables; no son fuente de verdad |
| Metadatos, hash, fragmentos y embeddings | PostgreSQL + pgvector | Fuente de verdad del dominio |

**Regla de integridad (§10.3):** el vínculo con Drive se establece por `fileId` o `folderId`, **nunca por nombre de archivo** — renombrar en Drive no puede romper la trazabilidad.

**Autenticación (DEC-006):** cuenta de servicio con delegación a nivel de dominio del Google Workspace de SmartPR, restringida al Drive de campañas. No se usan credenciales personales de ningún usuario.

---

## 5. Clasificación aplicada (§12.2)

| Nivel | Documentos de este inventario | Tratamiento |
|---|---|---|
| Pública | Especificaciones de producto ya lanzado en mercados de China y Europa | Acceso según rol |
| Interna | 1–6, 10, 11, 13 y los briefs generados | Agencia y TCL autorizado |
| Confidencial | 7, 8, 12 | Acceso restringido y exportación controlada |
| Sensible / personal | 9 | Fuera de alcance del proyecto; nunca se indexa |

**Matiz registrado en DEC-008:** la mayor parte de la información de producto ya es pública porque los productos existen en los mercados chino y europeo antes de llegar a Colombia. El único dato con sensibilidad real son **fechas de lanzamiento no anunciadas**. Para el piloto no se aplica una capa adicional de protección; queda anotado para escalar en fases posteriores.

**Anonimización (DEC-009):** se autoriza usar datos reales sin anonimizar en esta etapa. El modelo de datos conserva `confidentialityLevel` y `visibility` en todo recurso para poder activar anonimización más adelante sin refactor mayor.

---

## 6. Exclusiones obligatorias del índice vectorial (§12.3)

No se indexan por defecto, sin excepción:

- documentos completos de identidad;
- datos bancarios o tributarios;
- contratos completos si solo se requiere conocer su estado;
- videos completos;
- archivos de campañas no relacionadas;
- cualquier material cuyo permiso no pueda verificarse.

---

## 7. Pendientes

| Punto | Impacto | Cuándo se resuelve |
|---|---|---|
| Confirmar si los PPT de China llegan con estructura estable entre campañas | Alto — determina si la extracción puede apoyarse en posición además de en contenido | Al recibir los documentos reales para D0-14 |
| Tamaño máximo real de los PPT de China | Medio — define límites de carga y timeouts del worker | Al recibir los documentos reales |
| Si existe versión en chino de algún material fuente | Medio — afectaría el alcance de traducción (hoy solo ES/EN) | Al recibir los documentos reales |
