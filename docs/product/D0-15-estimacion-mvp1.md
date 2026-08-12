# D0-15 — Estimación de MVP 1

**Versión:** 1 · **Fecha:** 11 de agosto de 2026 · **Estado:** propuesta para validación
**Fuentes:** D0-11 (backlog: 58 historias), documento maestro §13 (rangos preliminares), §25 (sprints), §33 (equipo), §36 (riesgos); `docs/decisions/decision-log.md`.

---

## 1. Base de la estimación

Esta estimación se construye **desde el backlog real de D0-11**, no desde los rangos preliminares de §13 del documento maestro — que el propio documento califica de "no contractuales".

También difiere del supuesto original en un punto decisivo: §13 asumía un equipo humano de 5–7 personas durante 8–12 semanas con un presupuesto de COP 55–90 M. El contexto real (DEC-001, DEC-011) es distinto: **un agente de IA construyendo, con el product owner como única contraparte humana, sin presupuesto formal gestionado en esta fase**.

Estimar en pesos y FTE un trabajo que no se ejecuta así produciría un número inútil. Lo que sí es estimable y útil es **el tamaño del trabajo y las sesiones necesarias**.

---

## 2. Tamaño del trabajo

| Épica | Historias | `must` | Complejidad | Sesiones estimadas |
|---|:--:|:--:|---|:--:|
| E1 · Base del repositorio | 10 | 7 | Media — configuración, poca lógica | 2–3 |
| E2 · Identidad y autorización | 7 | 6 | **Alta** — el aislamiento debe ser correcto a la primera | 3–4 |
| E3 · Campañas y productos | 7 | 6 | Baja — CRUD con auditoría | 2–3 |
| E4 · Fuentes documentales | 11 | 10 | **Alta** — parsing de tres formatos con localización | 4–6 |
| E5 · Esquema y extracción | 9 | 9 | **Muy alta** — es el corazón del producto | 5–7 |
| E6 · Preguntas locales | 6 | 5 | Media | 2–3 |
| E7 · Editor de brief | 7 | 5 | **Alta** — mucha interfaz, autosave, validación en vivo | 4–5 |
| E8 · Versionado y aprobación | 9 | 8 | **Alta** — la inmutabilidad no admite errores | 3–5 |
| E9 · Traducción y glosario | 7 | 6 | Media | 3–4 |
| E10 · Exportación | 7 | 5 | Media — generación de DOCX/PDF | 3–4 |
| E11 · Harness y observabilidad | 10 | 8 | **Alta** — adaptadores, validación, costo | 4–5 |
| E12 · Auditoría y operación | 7 | 4 | Media | 2–3 |
| E13 · Calidad y accesibilidad | 11 | 8 | **Alta** — transversal, se acumula al final | 4–6 |
| **Total** | **58** | **87** ⁽*⁾ | — | **41–58** |

⁽*⁾ 44 `must`, 12 `should`, 2 `could`. La suma por épica incluye solapamiento de conteo entre prioridades.

**Una "sesión"** es un bloque de trabajo enfocado que termina en algo demostrable — aproximadamente lo que cabe entre dos revisiones del product owner.

---

## 3. Calendario

| Sprint | Foco | Sesiones | Entregable demostrable |
|---|---|:--:|---|
| 0 | Preparación | 2–3 | `docker compose up` levanta el sistema |
| 1 | Dominio y acceso | 5–7 | Login + campaña + acceso cruzado que falla |
| 2 | Fuentes | 4–6 | PPT real procesándose sin bloquear la pantalla |
| 3 | Extracción | 9–12 | Un claim que abre su diapositiva de origen |
| 4 | Construcción del brief | 6–8 | Brief completo **con la IA apagada** |
| 5 | Versiones y traducción | 6–9 | Editar una versión aprobada crea una nueva |
| 6 | Aprobación y exportación | 7–9 | DOCX de una versión aprobada |
| 7 | Endurecimiento y piloto | 6–9 | Suite en verde + evaluación del gold set |
| | **Total** | **45–63** | |

**En semanas calendario:** con sprints de dos semanas (§34) y ritmo sostenido, **16 semanas**. Con dedicación intensiva, **8–10 semanas**. El rango original de §13 (8–12 semanas) sigue siendo razonable — pero por razones distintas a las que lo motivaron.

**El cuello de botella no es la construcción, es la revisión.** Cada sprint cierra con demo, evidencia y decisiones (§25). Si las revisiones del product owner se espacian, el calendario se estira aunque el trabajo esté hecho.

---

## 4. Supuestos

Si alguno se rompe, la estimación deja de valer:

| # | Supuesto | Si se rompe |
|---|---|---|
| 1 | El product owner revisa cada sprint en días, no semanas | El calendario se estira proporcionalmente |
| 2 | Los PPT de TCL China tienen estructura razonablemente estable | E4 y E5 crecen 3–5 sesiones |
| 3 | El proveedor de IA se decide antes del Sprint 3 | E5 y E11 se bloquean |
| 4 | El material de campañas reales llega antes del Sprint 3 | El gold set no se puede poblar; E13-8 queda sin medir |
| 5 | Un solo idioma de origen (ES/EN, no chino) | E9 crece significativamente |
| 6 | No se añade alcance de MVP 2–7 | Cada adición desplaza el cierre |
| 7 | El entorno local soporta el procesamiento de PPT grandes | E4 requiere ajuste de recursos |
| 8 | Google Workspace permite la cuenta de servicio con delegación | E2 y E4-2 se bloquean hasta resolverlo |

**El supuesto 4 es el más frágil**, porque depende de una acción pendiente desde el inicio del proyecto y ya bloquea D0-13 y D0-14.

---

## 5. Riesgos con impacto en el calendario

| Riesgo | Prob. | Impacto | Mitigación |
|---|:--:|:--:|---|
| Documentos fuente más variables de lo esperado | **Alta** | Alto | Gold set temprano; fallback manual siempre disponible |
| Extracción no alcanza el 95% en campos críticos | Media | **Alto** | El modo manual permite operar igual; el umbral se renegocia con datos, no con opinión |
| Calidad de traducción insuficiente | Media | Medio | Glosario bloqueado + revisión humana obligatoria |
| Costo de IA superior a lo previsto | Media | Medio | Router por nivel de modelo; `AIRun` hace visible el costo desde el día uno |
| Generación de DOCX/PDF más compleja de lo estimado | Media | Medio | Plantilla versionada; empezar simple |
| Accesibilidad WCAG AA descubierta tarde | **Alta** | Medio | Incorporar desde E7, no dejarla para E13 |
| Revisiones espaciadas del product owner | Media | **Alto** | Demos cortas y frecuentes en vez de grandes hitos |
| Pérdida de datos por falta de backup | Baja | **Muy alto** | ADR-005 — riesgo aceptado; `pg_dump` manual como mitigación mínima |

**El riesgo de accesibilidad se marca como probabilidad alta deliberadamente:** es el que más se subestima, porque retrofitear WCAG sobre un editor ya construido cuesta varias veces más que construirlo accesible.

---

## 6. Exclusiones

Todo lo de §15 más lo confirmado en el descubrimiento. **Ninguno entra sin decisión registrada nueva:**

CRM de influencers · revisión de guiones · análisis de video · métricas y dashboards analíticos · workflow logístico · inventario y canjes · scoring de influencers · WhatsApp automático · publicación en redes · firma electrónica · migración histórica masiva de Drive · login de aprobación para TCL · portal de influencers · soporte de idiomas más allá de ES/EN.

**Única excepción ya aprobada (ADR-004):** vista de solo lectura para TCL con estado y descarga. Ya está dentro de las 58 historias, no añade alcance.

---

## 7. Qué se necesita del product owner

El trabajo que no puede hacer el agente, ordenado por urgencia:

| # | Qué | Cuándo | Bloquea |
|---|---|---|---|
| 1 | Material de 5–10 campañas reales | **Ya** | D0-13, D0-14, supuesto 4 |
| 2 | Decidir proveedor de IA | Antes del Sprint 3 | E5, E11 |
| 3 | Definir qué campos hacen un brief "completo" | Antes del Sprint 3 | E5-9 |
| 4 | Confirmar si una campaña puede tener varios productos | Antes del Sprint 1 | E3-5 |
| 5 | Confirmar si se puede revertir una aprobación interna | Antes del Sprint 5 | E8-6 |
| 6 | Habilitar la cuenta de servicio de Google Workspace | Antes del Sprint 2 | E4-2 |
| 7 | Revisar cada demo de sprint | Cada 2 semanas | Todo el calendario |
| 8 | Responder el gold set campo por campo (2–3 h) | Antes del Sprint 3 | E13-8 |

---

## 8. Comparación con la estimación preliminar

| | §13 (preliminar) | Esta estimación |
|---|---|---|
| Duración | 8–12 semanas | 8–16 semanas según ritmo de revisión |
| Inversión | COP 55–90 M | No aplica en esta fase (DEC-001) |
| Equipo | 5–7 personas | Agente + product owner |
| Base | Rangos de referencia | 58 historias con criterios de aceptación |
| Alcance | Épicas E1–E13 | Igual, sin cambios |

**El rango de duración coincide por casualidad, no por acuerdo.** La estimación preliminar suponía un equipo humano completo; esta supone un agente con revisión humana. Que ambos den un número similar no valida ninguno — solo indica que el tamaño del trabajo es consistente con lo previsto.

---

## 9. Cobertura de la Definition of Done

| Requisito (§23, D0-15) | Estado |
|---|---|
| Equipo | ✅ §8 — quién hace qué, incluido lo que solo puede hacer el product owner |
| Semanas | ✅ §3 — por sprint, con rango |
| Supuestos | ✅ §4 — ocho, con consecuencia si se rompen |
| Riesgos | ✅ §5 — ocho, con probabilidad, impacto y mitigación |
| Exclusiones | ✅ §6 — explícitas |

## 10. Cuándo revisar esta estimación

| Momento | Por qué |
|---|---|
| Al recibir el material de campañas reales | Confirma o rompe los supuestos 2 y 4 |
| Al cerrar el Sprint 2 | El parsing real revela si E4 estaba bien dimensionada |
| Al cerrar el Sprint 3 | La extracción es el mayor riesgo; después de ella la incertidumbre baja mucho |
| Si se aprueba cualquier ampliación de alcance | Por definición |
