# Pantallas de TCL KOL OS — inventario y animaciones propuestas

**Fecha:** 26 de agosto de 2026. Inventario de las pantallas reales que existen hoy en `apps/web/src/app/` (Sprint 0-4), con una propuesta de microinteracciones/animaciones para cada una. Ninguna de las animaciones está implementada — es una propuesta de diseño para discutir, no un compromiso de alcance. El sistema no tiene hoy ninguna librería de animación instalada (ni Framer Motion, ni `tailwindcss-animate`); todo lo de abajo se puede lograr con CSS/transiciones nativas y, donde se note, un par de líneas de JS — no hace falta traer una dependencia nueva salvo que se decida lo contrario.

**Principio de diseño que ya rige el producto** y que las animaciones deben reforzar, no contradecir: *el sistema nunca inventa, y nunca esconde de dónde salió un dato.* Ninguna animación debe sugerir certeza donde hay incertidumbre (por ejemplo, un campo `not_found` no debe "aparecer" con la misma confianza visual que uno verificado), y ninguna debe ocultar una espera real detrás de un efecto — mejor mostrar el estado exacto (extrayendo, esperando el worker, guardando) que un spinner genérico.

---

## 1. `/login` — Inicio de sesión

**Qué es hoy:** formulario simple, correo + contraseña, sin gestión de sesión visible más allá del error.

**Animaciones propuestas:**
- Transición de foco en los campos: borde que pasa de gris a azul con `transition: border-color 150ms ease`, sin salto.
- Error de credenciales: el mensaje de error no aparece de golpe — un `shake` sutil (2-3px, 200ms) en el formulario más un fade-in del texto de error, para que se note sin sobresaltar.
- Botón "Entrar": estado de carga con el texto reemplazado por un spinner de 16px inline (no un modal ni overlay) mientras espera la respuesta del servidor.

---

## 2. `/` — Landing / redirección

**Qué es hoy:** punto de entrada que resuelve sesión y redirige a `/campanas` o `/login`.

**Animaciones propuestas:** ninguna necesaria — es una pantalla de tránsito, no debe demorar con un efecto. Si acaso, un skeleton mínimo (una barra gris pulsante) por si la resolución de sesión tarda más de ~300ms, para no mostrar una pantalla en blanco.

---

## 3. `/campanas` — Lista de campañas

**Qué es hoy:** tabla/lista de campañas de la organización, con acceso a "Nueva campaña".

**Animaciones propuestas:**
- Filas que entran con un fade + desplazamiento vertical de 4px, escalonado ~30ms entre fila y fila (`stagger`), solo en la carga inicial — nunca al re-renderizar tras una acción, para no hacer parpadear la lista en cada interacción.
- Hover de fila: cambio de fondo sutil (`background-color` transición 100ms), suficiente para indicar que es clicable sin parecer un botón.
- Si la lista está vacía: el estado vacío ("Aún no hay campañas") con un fade-in suave del ícono/texto en vez de aparecer abruptamente.

---

## 4. `/campanas/nueva` — Crear campaña

**Qué es hoy:** formulario mínimo (nombre, quizás selección de producto inicial).

**Animaciones propuestas:**
- Igual que login: foco con transición de borde, sin sorpresas.
- Al enviar con éxito: no un simple salto de página — un fade-out del formulario (150ms) antes de navegar a `/campanas/[id]`, para que la transición se sienta como una continuación, no un corte.
- Validación en vivo (si el nombre es obligatorio): el mensaje de error aparece con fade-in solo después de que el usuario sale del campo (`onBlur`), nunca mientras escribe — evita el parpadeo de "error, ya no hay error, error" en cada tecla.

---

## 5. `/campanas/[id]` — Detalle de campaña

**Qué es hoy:** resumen de la campaña — productos anclados, estado del brief, acceso a fuentes/brief/preguntas, contador de preguntas críticas pendientes.

**Animaciones propuestas:**
- El contador de "preguntas críticas pendientes" (cuando es `> 0`): un pulso sutil (opacidad 100%→70%→100%, ~1.5s, una sola vez al cargar, no en bucle infinito) para llamar la atención sin ser una alarma permanente — un `badge` que respira una vez, no que parpadea para siempre.
- Las tarjetas de "Fuentes" / "Brief" / "Preguntas" (si son tarjetas de navegación): elevación sutil al hover (`box-shadow` que crece 100ms), consistente con que son puertas de entrada a otra pantalla.
- Si el brief todavía no existe (`draft` sin crear): el botón "Empezar el brief a mano" o "Extraer campos" con un leve énfasis (contorno con transición de color) para diferenciarlo de una acción secundaria.

---

## 6. `/campanas/[id]/fuentes` y `/campanas/[id]/fuentes/[sourceId]` — Fuentes documentales

**Qué es hoy:** carga de documentos (`FormularioFuente`), lista con estado de procesamiento (`pendiente` → `procesando` → `procesado`/`fallido`), y detalle de una fuente con sus fragmentos.

**Animaciones propuestas — esta es la pantalla donde más vale la pena invertir, porque el procesamiento es asíncrono de verdad:**
- **Barra de progreso real, no falsa**: mientras `status = 'procesando'`, un indicador que no promete un tiempo que no se conoce (nada de una barra que llega a 90% y se cuelga) — mejor un patrón indeterminado (rayas diagonales animadas, `background-position` en bucle) que comunique "está corriendo" sin fingir precisión.
- **Transición de estado con color + ícono, no solo texto**: `pendiente` (gris) → `procesando` (azul, con el patrón indeterminado de arriba) → `procesado` (verde, con un check que aparece con un pequeño "pop" — escala 0.8→1 en 150ms con easing `ease-out`) o `fallido` (rojo, sin pop — un estado de error no debe celebrarse visualmente).
- **Polling silencioso**: si la pantalla consulta el estado cada N segundos, la actualización del badge de estado debe ser un cross-fade (200ms) entre el estado viejo y el nuevo, nunca un salto brusco que se sienta como un refresh de página.
- **Fragmentos en el detalle de una fuente**: al expandir un fragmento para ver su texto completo, un `accordion` con altura animada (`max-height` transición 200ms) en vez de aparición instantánea.

---

## 7. `/campanas/[id]/brief` — Revisión de extracción (UI-08/UI-11)

**Qué es hoy:** la pantalla central del producto. Cabecera con el estado de la versión (`VERSIÓN N · ESTADO`), resumen (`N campo(s) con dato · N crítico(s) pendiente(s) · N conflicto(s) · N sin confirmar`), tabla de campos extraídos con acciones Confirmar/Corregir, botones de transición de estado ("Extraer campos", "Ir a las preguntas", "Enviar a revisión interna", "Reintentar extracción").

**Animaciones propuestas — la segunda pantalla donde más vale invertir:**
- **Badge de estado de la versión** (`draft`, `processing`, `extraction_review`, `local_questions`, `internal_review`, `processing_failed`, etc.): cross-fade de color+texto al cambiar (250ms), nunca un salto — el usuario acaba de causar esa transición con un clic, así que el cambio debe sentirse como consecuencia directa de su acción, no como un refresh.
- **Fila que se confirma o corrige**: verificado en esta misma sesión que, al confirmar un campo, la fila cambia de "sin confirmar" a "confirmado" y se reordena hacia el final de la tabla (las filas pendientes suben). Hoy ese reordenamiento es instantáneo; con animación, el movimiento de la fila hacia su nueva posición debería usar una transición de posición (técnica FLIP: First-Last-Invert-Play, ~200-300ms `ease-in-out`) para que el ojo siga la fila en vez de perderla y tener que rebuscarla. Es la animación de mayor impacto de toda la pantalla, porque se repite decenas de veces por sesión (en Demo A, 44 veces).
- **Contador del resumen** (`N sin confirmar`): al bajar de 44 a 43, etc., el número no debe saltar sin más — una transición de "cuentakilómetros" corta (~150ms, el dígito viejo sube y el nuevo entra desde abajo) refuerza que el sistema registró la acción.
- **Botón "Enviar a revisión interna"**: deshabilitado (visualmente apagado, sin animación) mientras haya críticos pendientes o campos sin revisar; al habilitarse (el usuario acaba de confirmar el último campo), un breve resplandor (`box-shadow` que crece y se desvanece, 400ms, una sola vez) señala "ya puedes continuar" sin necesidad de que el usuario busque el botón por su cuenta.
- **Evidencia ("ver N")**: al expandir una cita, el popover/tooltip con la cita literal debería entrar con fade + escala leve (0.95→1, 120ms) — rápido, porque se usa mucho y no debe sentirse pesado.
- **Error de concurrencia (`FIELD_REVISION_CONFLICT`)**: cuando otro usuario cambió el campo primero, la fila no debe simplemente fallar en silencio — un breve tinte de fondo en ámbar (fade-in 150ms, se mantiene ~2s, fade-out) sobre la fila afectada, con el mensaje "este campo cambió, recargando…", para que quede claro qué pasó y por qué se recargó.
- **Botón "Reintentar extracción"** (solo visible en `processing_failed`): sin animación de entrada especial, pero el estado de carga al pulsarlo debe verse igual que en `/fuentes` (patrón indeterminado), porque es la misma espera asíncrona de fondo.

---

## 8. `/campanas/[id]/brief/editar` — Editor estructurado (E7/UI-10)

**Qué es hoy:** navegación por las 10 secciones de D0-05 con contador de pendientes, selector de producto (para campos `compartido_con_excepcion`), campos editables con autoguardado al perder foco (`onBlur`), evidencia inline expansible, control de excepción por producto (E7-8), claves técnicas en un `<details>` secundario.

**Animaciones propuestas:**
- **Navegación entre secciones**: si el cambio de sección no recarga la página completa, un cross-fade breve (150ms) del contenido saliente/entrante evita el salto brusco; el ítem activo en la navegación lateral con una barra indicadora que se desliza (`transform: translateY`, 200ms) de una sección a otra en vez de simplemente cambiar de color.
- **Autoguardado (`onBlur`)** — esta es la interacción más frecuente de la pantalla y la que más se beneficia de una animación clara y honesta:
  - Al salir del campo: indicador textual que pasa de nada → «guardando…» (fade-in inmediato) → «guardado» (cross-fade, ~400ms después, cuando la respuesta del servidor realmente llegó — nunca antes) → el indicador se desvanece solo después de 1.5-2s.
  - Si falla el guardado: el indicador pasa a «no se pudo guardar» en rojo, y **se queda visible** (no se desvanece solo) hasta que el usuario reintente o corrija — un error de guardado no debe evaporarse solo porque pasó el tiempo.
  - Nota de diseño: el HANDOFF/D0-17 ya documentan que hoy el indicador es puramente textual (E7-2, `PARTIAL`); esta animación es la forma natural de completar esa historia sin necesitar un ícono nuevo.
- **Selector de producto**: al cambiar de producto, los campos de nivel `producto` y `compartido_con_excepcion` deben transicionar (cross-fade del valor, 200ms) en vez de recargar toda la sección — refuerza que es el mismo campo con datos que varían por producto, no una pantalla distinta.
- **Control de excepción por producto (E7-8)**: al declarar una excepción, la fila compartida se "divide" visualmente — una transición donde el valor compartido se desvanece y el nuevo valor específico del producto entra con un leve slide desde la izquierda (200ms), como metáfora de "esto se separó de lo compartido". Al revertir, la animación inversa (el valor específico se desvanece, vuelve a mostrarse el compartido).
- **Evidencia inline expansible**: igual criterio que en `/brief` — accordion con `max-height` animado, no aparición instantánea.
- **`<details>` de claves técnicas**: usar la animación nativa del elemento si el navegador la soporta, o una transición de altura equivalente — es contenido secundario, no merece una animación elaborada, solo que no "salte".

---

## 9. `/campanas/[id]/preguntas` — Preguntas locales (E6/UI-09)

**Qué es hoy:** filtros por estado/producto, tarjetas de pregunta con motivo visible, formulario de respuesta que cambia de control según el `valueType` del catálogo (texto/lista/enum/fecha con precisión/número), descarte con justificación obligatoria, botón "Volver al brief".

**Animaciones propuestas:**
- **Tarjeta que se resuelve (responde o descarta)**: sale de la lista de pendientes con un fade-out + colapso de altura (200ms) en vez de desaparecer de golpe — el hueco que deja se cierra suavemente, no de un salto, para que las tarjetas de abajo no "salten" hacia arriba sin transición.
- **Cambio de control según `valueType`**: si el usuario cambia de campo (o el formulario se re-renderiza al cargar una pregunta de fecha vs. una de texto libre), el control debe entrar con un fade breve (100ms) — es un cambio de tipo de input, no de contenido, así que la animación debe ser casi imperceptible, solo evitar el parpadeo blanco.
- **Justificación de descarte obligatoria**: si el usuario intenta descartar sin escribir nada, el `textarea` correspondiente con el mismo `shake` sutil que el error de login (2-3px, 200ms) — consistencia entre ambos flujos de "falta un dato obligatorio".
- **Botón "Volver al brief"**: visible solo cuando `guardNoPendingQuestions` lo permite (0 pendientes) — al aparecer por primera vez (la última pregunta se acaba de resolver), el mismo resplandor breve que en `/brief` para "Enviar a revisión interna", por la misma razón: señalar que una acción que antes no existía ahora sí.
- **Contador de pendientes en los filtros**: mismo criterio de "cuentakilómetros" corto que en `/brief`.

---

## 10. Componentes transversales (aparecen en más de una pantalla)

- **Navegación superior** (`Inicio`, `Campañas`, usuario, `Salir`): sin animación más allá de un hover sutil en los enlaces — es infraestructura, no debe competir por atención.
- **Badges de estado** (`brief_status`, `review_status`, `provenance_type`, criticidad): un mismo sistema de color + transición de 150-250ms en cross-fade, reutilizado en todas las pantallas donde aparecen (`/brief`, `/brief/editar`, `/preguntas`, `/campanas/[id]`) — la consistencia entre pantallas importa más que el efecto en sí.
- **Mensajes de error de servidor** (cualquier `error.message` de una server action, mostrado tal cual por ADR-008): fade-in + el mismo `shake` sutil que los demás errores de validación, para que el usuario aprenda un único lenguaje visual de "algo falló" en toda la aplicación.
- **Confirmaciones de acción irreversible** (si en el futuro se agregan — hoy no hay ninguna: todo pasa por revisión, nada se borra directo): si se agregan, deberían usar un modal con fade+scale de entrada (150ms) y nunca autocerrarse — una acción irreversible no debe poder confirmarse por accidente porque el modal desapareció solo.

---

## Notas de implementación (si se decide avanzar)

- **Respetar `prefers-reduced-motion`**: cualquier animación de las de arriba debe desactivarse (o reducirse a un cross-fade instantáneo) cuando el sistema operativo del usuario pide movimiento reducido — una línea de CSS (`@media (prefers-reduced-motion: reduce)`) cubre todos los casos de una vez.
- **Ninguna animación debe agregar latencia percibida a una acción real**: el patrón general de este documento es "la animación comunica un estado real que ya existe" (guardando, procesando, guardado, error), nunca "la animación reemplaza la espera real con un efecto que hace parecer más rápido algo que no lo es".
- **La animación de mayor prioridad si solo se puede hacer una**: el reordenamiento FLIP de filas en `/brief` (§7) — es la que más se repite por sesión y la que hoy más se nota su ausencia (44 saltos instantáneos en Demo A).
