# D0-10 — Prototipo navegable

**Versión:** 1 · **Fecha:** 11 de agosto de 2026 · **Estado:** propuesta para validación
**Archivo:** [`D0-10-prototipo/index.html`](D0-10-prototipo/index.html)
**Fuentes:** documento maestro §7.2 (pantallas), §7.3 (estados), §23.1 (DoD: "el prototipo cubre UI-03 a UI-15"); D0-05 (esquema del brief), D0-11 (backlog), D0-12 (plan de pruebas).

---

## 1. Cómo abrirlo

Doble clic sobre `docs/product/D0-10-prototipo/index.html`. Se abre en cualquier navegador.

**Sin build, sin servidor, sin dependencias.** Un solo archivo HTML con navegación por hash (`#ui03`, `#ui10`, …), que se puede enviar por correo o abrir desde una memoria USB. Esa portabilidad es deliberada: un prototipo que requiere levantar un entorno no se revisa.

---

## 2. Cobertura — 13 de 13 pantallas exigidas

| ID | Pantalla | Propósito (§7.2) | Historia | Estado |
|---|---|---|---|:--:|
| UI-03 | Lista de campañas | Buscar, filtrar y crear campañas | E3-2 | ✅ |
| UI-04 | Nueva campaña | Capturar producto, mercado, responsables, fechas e idioma | E3-1 | ✅ |
| UI-05 | Detalle de campaña | Reunir fuentes, brief, versiones, actividad y estado | E3-3 | ✅ |
| UI-06 | Carga de fuentes | Cargar o vincular PPT, PDF, DOCX y ficha técnica | E4-1, E4-2 | ✅ |
| UI-07 | Estado de procesamiento | Cola, avance, fallas y reintento | E4-8, E4-9 | ✅ |
| UI-08 | Revisión de extracción | Confirmar campos, fuente y confianza | E5-7 | ✅ |
| UI-09 | Preguntas de vacíos | Completar información local faltante o contradictoria | E6-2 a E6-4 | ✅ |
| UI-10 | Editor de brief | Editar secciones estructuradas sin depender de IA | E7-1, E7-4 | ✅ |
| UI-11 | Evidencias | Abrir fuente, página o diapositiva asociada a un campo | E5-8 | ✅ |
| UI-12 | Comparador de versiones | Ver diferencias entre versiones | E8-3 | ✅ |
| UI-13 | Traducción ES/EN | Revisar versiones relacionadas y glosario | E9-2, E9-4 | ✅ |
| UI-14 | Aprobación | Solicitar revisión, comentar, aprobar o devolver | E8-4 a E8-7 | ✅ |
| UI-15 | Exportación | Generar DOCX/PDF desde plantilla aprobada | E10-2, E10-3 | ✅ |

**UI-01 (acceso), UI-02 (inicio), UI-16 (auditoría) y UI-17 (administración)** existen en §7.2 pero quedan fuera del prototipo: el DoD (§23.1) exige explícitamente **UI-03 a UI-15**, y las cuatro restantes son pantallas convencionales cuya forma no arriesga nada al diseñarse durante la construcción.

---

## 3. Qué NO es este prototipo

| No es | Es |
|---|---|
| Una propuesta visual o de marca | Un mapa de qué información aparece en cada pantalla y qué acciones existen |
| Software funcional | HTML estático: los botones no hacen nada |
| Wireframes genéricos | Contenido real del ejemplo de brief de D0-05 (campaña C755) |

**Los datos que se ven son los del ejemplo validado de D0-05.** El claim de 144Hz, el conflicto de brillo entre 1500 y 1300 nits, el `not_found` del presupuesto y el *one line* "Compara las specs, no los logos" son exactamente los del `brief.example.es.json` que pasa la validación de esquema. Esto permite verificar que el esquema y la interfaz hablan del mismo producto.

---

## 4. Las cinco decisiones que el prototipo hace visibles

El valor de un prototipo no está en mostrar pantallas bonitas, sino en hacer discutibles decisiones que en un documento pasan desapercibidas:

### 4.1 El modo manual no es una pantalla degradada (UI-10)

El editor se muestra **con la IA desactivada** y funciona completo. No hay una versión "con IA" y otra "sin IA": es la misma pantalla, y la asistencia aparece como campos ya poblados con su procedencia marcada. Esto hace tangible el principio 9 del §5 — si el fallback fuera una pantalla aparte, sería una promesa incumplida disfrazada.

### 4.2 El conflicto bloquea, no advierte (UI-14)

El botón "Aprobar internamente" aparece **deshabilitado** porque hay un campo en `conflict`. Es la traducción visual de la historia E5-9 y del caso F-16. Un diseño que solo mostrara una advertencia amarilla dejaría al umbral de "100% de claims con evidencia" dependiendo de la disciplina del usuario.

### 4.3 La aprobación del cliente es un registro, no un flujo (UI-14)

La sección "Aprobación del cliente" es un formulario para **anotar lo que pasó afuera** (resultado, fecha, constancia), no un flujo de aprobación. Refleja DEC-012 con precisión: TCL no aprueba dentro del sistema.

### 4.4 La procedencia de cada campo es visible (UI-10)

Cada campo del editor lleva una etiqueta: `extraído`, `manual`, `claim`, `conflicto sin resolver`. Cumple §9.4 — *"el texto generado debe distinguir hecho, inferencia y propuesta local"* — en el lugar donde importa, que es mientras alguien edita.

### 4.5 La etapa "Aterrizar" está sola (UI-05)

El diagrama de ocho etapas aparece con solo una activa y las demás en gris. Hace visible, cada vez que alguien abre una campaña, que MVP 1 construye una etapa de ocho — la defensa más simple contra la expansión de alcance.

---

## 5. Trazabilidad hacia el backlog y las pruebas

Cada pantalla cita las historias de D0-11 que la implementan y, donde aplica, los casos de D0-12 que la verifican:

| Elemento visible | Historia | Caso de prueba |
|---|---|---|
| Aviso de aislamiento en la lista | E2-4 | S-01 |
| Rechazo de MIME falsificado | E4-1 | S-05 |
| Rechazo de URL interna | E4-2 | S-08 |
| `not_found` sin valor | E5-4 | F-15, GS-004 |
| Conflicto con dos evidencias | E5-5 | F-17, GS-005 |
| Aprobación bloqueada por claim sin evidencia | E5-9 | F-16, GS-006 |
| Descarte de pregunta con justificación | E6-4 | F-19 |
| Versión reemplazada, no borrada | E8-8 | F-30 |
| Término de glosario bloqueado | E9-4 | F-34 |
| Evidencia sin traducir en versión EN | E9-7 | F-36 |
| Metadatos en el archivo exportado | E10-5 | F-39 |

Un cambio en el prototipo que rompa cualquiera de estas relaciones es una señal de que se está cambiando el producto, no la interfaz.

---

## 6. Verificación ejecutada

Se abrió el archivo en un navegador y se comprobó por inspección del DOM:

```
✅ 13 pantallas presentes (ui03 … ui15)
✅ Navegación por hash funcional — cambiar #ui10 activa la pantalla y su enlace
✅ Todas las pantallas tienen título, contenido y al menos un aviso contextual
✅ Diseño adaptable: por debajo de 900 px la navegación pasa a una columna
✅ Tema claro y oscuro según la preferencia del sistema
```

---

## 7. Cobertura de la Definition of Done

| Requisito (§23.1) | Estado |
|---|---|
| "El prototipo cubre UI-03 a UI-15" | ✅ 13 de 13 |
| Flujo navegable | ✅ Navegación por hash entre todas las pantallas |
| Refleja los estados reales del brief | ✅ Estados de §7.3, no genéricos |
| Usa los campos reales del esquema | ✅ Datos del ejemplo validado de D0-05 |

## 8. Pendientes

| Punto | Impacto | Cuándo |
|---|---|---|
| Validar el prototipo con un consultor distinto al product owner | Medio — el diseño puede estar optimizado para un solo flujo de trabajo | Al incorporar consultores reales |
| Revisión de accesibilidad sobre la interfaz definitiva | Alto — WCAG 2.1 AA es requisito de E13-9, y retrofitearlo cuesta varias veces más | Desde el Sprint 4, no al final |
| Diseño visual y de marca | Bajo — este prototipo es estructural, no visual | Cuando exista una decisión de identidad |
| UI-01, UI-02, UI-16, UI-17 | Bajo — fuera del alcance exigido por el DoD | Durante la construcción |
