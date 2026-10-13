> **Documento histórico** (anterior a V2): no describe el modelo vigente; ver docs/project/V2_CURRENT_STATE.md y DEC-042 a DEC-050.

# D0-19 · Cierre de Sprint 6 (Fase B + C) — Brief Workspace: contrato consolidado y completado guiado

## 1. Alcance de esta entrega

El pedido original de Sprint 6 (ver el prompt recibido) cubre siete fases: A (exploración), B (contrato del workspace), C (workspace interno de tres modos), D (server actions), E (exportación PDF/DOCX), F (compatibilidad de UI), G (pruebas) y documentación. **Esta entrega implementa las Fases A, B y C.1 (Completar), más las pruebas de integración correspondientes** — alcance acordado explícitamente con el usuario antes de empezar, dado el tamaño real del pedido completo:

> "Procede con Fase B+C primero. Implementa: 1. El contrato consolidado `obtenerBriefWorkspace()`... 2. La experiencia guiada de completado detrás de `BRIEF_WORKSPACE_V2`. 3. La conexión con las funciones existentes... 4. Las pruebas... 5. Una demo funcional... 6. Documentación... No implementes todavía: Exportación PDF/DOCX. Chat autónomo... Eliminación de rutas anteriores. Rediseño visual adicional. Sprint 6 completo. Push o PR."

Los modos "Revisar brief" (C.2) y "Actividad" (C.3) como pantallas propias, la Fase D como acciones nuevas más allá de las ya existentes, la Fase E (exportación) y la Fase G.Navegador (Playwright) **no se construyeron en esta entrega** — quedan como el incremento recomendado (§9).

## 2. Estado del repositorio

- **Hash inicial (antes de este incremento):** `2452283ad743be4baf520697ec226317b1c35d4` — dos commits de rediseño de UI por encima del cierre de Sprint 5 (`5b9a2cd`), ya en el repositorio antes de empezar Sprint 6. Se verificó con `git rev-parse HEAD` / `git log --oneline -15` / `git status --short` antes de tocar código, siguiendo la regla de precedencia del pedido: **no se hizo `reset` a `5b9a2cd`, no se reemplazó la UI existente**.
- **`git status` inicial:** limpio, salvo los mismos cuatro archivos sueltos preservados desde sesiones anteriores (`HANDOFF-nuevo-chat.md`, `TCL-sprint4-cierre.zip`, `TCL-sprint5-cierre.zip`, `docs/product/pantallas-y-animaciones.md`) — no se tocaron.
- **Migración más reciente al empezar:** `010_inmutabilidad_bypass_restringido.sql`. **No se creó ninguna migración nueva** — este incremento es de lectura y de una UI adicional, sin cambios de esquema.
- **Última decisión numerada al empezar:** `DEC-037`. Esta entrega añade `DEC-038` y `DEC-039`.
- **Conteo de pruebas al empezar:** 384 (80 dominio + 207 `packages/db` + 97 worker), según D0-18 §11.4.
- **Hash final:** ver `git log --oneline -10` al cierre de esta sesión (commits de esta entrega, sin `push`, sin repositorio remoto tocado, tal como se pidió).

## 3. Arquitectura implementada

### 3.1 — Contrato `BriefWorkspace` (Fase B)

`obtenerBriefWorkspace(actor, campaignId)` (`packages/db/src/brief-workspace.ts`) es la única función que ensambla el workspace. No ejecuta SQL propio contra campos, preguntas o comentarios — compone:

| Dato del contrato | Función de repositorio reutilizada |
|---|---|
| `campaign`, `products` | `getCampaign` |
| `version` | `versionesDelBrief` |
| `sections`, `progress` (campos) | `verCamposDeVersion` + `campoDelCatalogo` (dominio) |
| `tasks` | `listarPreguntas` (status `pendiente`) |
| `progress.commentsOpen` | `contarConversacionesAbiertas` — **nunca para el rol `cliente`** |
| `activity` | `listBriefActivity` (nueva, `packages/db/src/audit.ts`) |
| `allowedActions` | `allowedTransitions` (dominio) + `TEXTO_DEL_BOTON` (dominio) |
| `progress.evidencePending` | `requiresEvidence` (dominio, recién exportada) |

Contrato completo en `packages/domain/src/workspace.ts`:

```ts
interface BriefWorkspace {
  campaign: { id: string; name: string; status: string };
  version?: { id: string; number: number; status: BriefStatus; language: Language; editable: boolean };
  products: readonly WorkspaceProduct[];
  progress: { percentage; total; ready; decisionsPending; criticalPending; evidencePending; commentsOpen };
  sections: readonly WorkspaceSection[];
  tasks: readonly WorkspaceTask[];
  activity: readonly WorkspaceActivityItem[];
  allowedActions: readonly WorkspaceAllowedAction[];
  nextResponsibleRole?: Role;
}
```

Reglas verificadas por prueba (§5): los comentarios internos nunca se consultan para `cliente` (no solo se ocultan — ni siquiera se piden a la base); el progreso nunca cuenta un claim sin evidencia como completo; los campos por producto conservan su ancla (`campaignProductId`); organización y permisos se validan antes de devolver cualquier dato (delegado a `getCampaign`/`verCamposDeVersion`/etc., que ya lo hacían).

`listBriefActivity` (nueva) reconstruye la pertenencia a una campaña desde `audit_events` — cuya `entity_id` es heterogéneo a propósito (campaña, versión, campo, pregunta o comentario, según la mutación) — en una sola consulta con CTEs, sin crear una tabla de auditoría paralela.

**Movido, sin cambiar comportamiento:** `ORDEN_DE_SECCIONES`, `TITULO_SECCION`, `ESTADO_EN_ESPANOL`, `TEXTO_DEL_BOTON` pasaron de `apps/web/src/lib/*` a `packages/domain/src/brief-presentation.ts` — `packages/db` no puede depender de `apps/web` (ADR-008) y el workspace necesita esas mismas etiquetas. `apps/web/src/lib/brief-sections.ts` y `brief-ui.ts` quedan como reexports, ningún import existente se rompió (confirmado por `tsc`/`eslint`/build).

### 3.2 — Workspace guiado (Fase C.1)

Ruta nueva `apps/web/src/app/(app)/campanas/[id]/brief/workspace/` (`page.tsx` + `WorkspaceGuiado.tsx`, cliente). Muestra una tarea a la vez, tomada de `workspace.tasks` (la cola real de `local_questions` pendientes — la misma que ya alimentaba `TablaPreguntas.tsx`). Cada respuesta o descarte invoca las mismas server actions que ya existían (`responderPreguntaLocal`, `descartarPreguntaLocal`, `apps/web/src/lib/actions.ts`) — se les añadió un `revalidatePath` adicional hacia la ruta nueva, ninguna lógica de mutación cambió. "Saltar por ahora" es estado de React únicamente, nunca toca el servidor.

`ControlDeRespuesta` se extrajo de `TablaPreguntas.tsx` a `apps/web/src/components/ControlDeRespuesta.tsx` para que ambas pantallas usen exactamente el mismo control por `valueType` (texto/número/fecha/enum/lista/lista de objetos) — nunca dos implementaciones que se puedan desincronizar.

Un claim (`criticidad: 'claim'`) nunca se ofrece para responder inline: la tarjeta explica que exige evidencia documental (§3.3 del pedido) y remite al editor, con la opción de marcarlo "no aplica" con justificación.

**Feature flag** `BRIEF_WORKSPACE_V2` (variable de entorno, sin tabla nueva): apagada, `/campanas/[id]/brief/workspace` reenvía a `/campanas/[id]/brief/editar` sin cambiar nada del flujo anterior, y el único enlace de entrada (en el overview de campaña) no se muestra. **Ninguna ruta ni componente anterior se retiró ni se modificó su comportamiento por defecto.**

## 4. Rutas y componentes

| Ruta / archivo | Estado |
|---|---|
| `apps/web/.../campanas/[id]/brief/workspace/page.tsx` | Nuevo |
| `apps/web/.../campanas/[id]/brief/workspace/WorkspaceGuiado.tsx` | Nuevo |
| `apps/web/src/components/ControlDeRespuesta.tsx` | Nuevo (extraído) |
| `apps/web/.../campanas/[id]/brief/editar/TablaPreguntas.tsx` | Modificado (usa el control compartido) |
| `apps/web/.../campanas/[id]/page.tsx` | Modificado (enlace condicional al workspace guiado) |
| `apps/web/src/lib/actions.ts` | Modificado (`revalidatePath` adicional en 2 funciones) |
| `apps/web/src/lib/brief-sections.ts`, `brief-ui.ts` | Modificado (reexport desde domain) |
| `packages/db/src/brief-workspace.ts` | Nuevo |
| `packages/db/src/brief-workspace.test.ts` | Nuevo |
| `packages/db/src/audit.ts` | Modificado (+ `listBriefActivity`) |
| `packages/db/src/extraction.ts` | Modificado (`versionesDelBrief` devuelve `language`) |
| `packages/db/src/index.ts` | Modificado (export del módulo nuevo) |
| `packages/domain/src/workspace.ts` | Nuevo |
| `packages/domain/src/brief-presentation.ts` | Nuevo |
| `packages/domain/src/brief-states.ts` | Modificado (`requiresEvidence` exportada, tipo reducido a `Pick<...>`) |
| `packages/domain/src/index.ts` | Modificado (export de los módulos nuevos) |
| Todas las rutas de `/brief/editar`, `/brief` (revisión), `/fuentes`, `/campanas` | **Sin cambios de comportamiento** |

## 5. Migraciones

**Ninguna.** Este incremento es de lectura (contrato compuesto) y de una superficie de UI adicional — no requirió cambios de esquema. `infra/db/migrations/010_inmutabilidad_bypass_restringido.sql` sigue siendo la más reciente.

## 6. Pruebas

| Suite | Antes | Ahora | Detalle |
|---|---|---|---|
| `packages/domain` | 80 | **80** | Sin pruebas nuevas — ninguna regla de negocio nueva; `requiresEvidence` solo cambió de visibilidad (`private` → `export`) y de tipo de parámetro (`BriefField` → `Pick<BriefField, 'criticidad' \| 'provenanceType'>`), cambio compatible hacia atrás, cubierto por las 45 pruebas existentes de `brief-states.test.ts` que ya lo ejercitan indirectamente. |
| `packages/db` | 207 | **219** | +12, `packages/db/src/brief-workspace.test.ts` — ver §6.1. |
| worker (`services/ai-worker`) | 97 | **no tocado, no re-ejecutado en esta sesión** | Cero cambios en `services/ai-worker`. Se documenta con honestidad en vez de reafirmar sin evidencia un número que no se volvió a correr. |

### 6.1 — Los 12 casos de `brief-workspace.test.ts`

Campaña propia y desechable en cada caso (INC-001A) — nunca P80, nunca el seed compartido:

1. Campaña sin brief → `version` `undefined`, listas vacías, progreso en cero.
2. Extracción parcial → `progress.total`/`ready`/`percentage` coinciden exactamente con lo que hay en la base (no con el catálogo completo, que solo aplica con productos).
3–4. Multiproducto → `products.length` correcto; un campo de nivel `producto` aparece una vez por producto, cada fila con su propio `campaignProductId`.
5. Preguntas críticas generadas → `criticalPending`/`decisionsPending` y `tasks` coinciden.
6. Claim con valor pero sin evidencia → cuenta en `evidencePending` aunque la corrección haya sido manual (`provenance_type = 'manual_local'`) — un claim exige evidencia sin excepción.
7–8. Responder / descartar una pregunta → sale de `tasks` en ambos casos.
9. Comentario abierto → `commentsOpen` sube; resuelto → vuelve a cero.
10–11. Rol consultor vs. director en `internal_review` → el consultor no ve la transición a `client_review` en `allowedActions`; el director sí — la misma `allowedTransitions` del dominio, sin reimplementar el permiso.
12. Cliente en `client_review` → ningún evento de tipo `field_comment` llega en `activity`, aunque exista uno real de por medio.
13. Aislamiento → un actor de otra organización recibe `RESOURCE_NOT_FOUND`, nunca el contenido.
14. Versión `approved` → `editable: false`, ninguna transición disponible salvo las de fin de vida.

## 7. Resultado de CI

**PASS — receta de CI reproducida en contenedor/entorno local; GitHub Actions real no ejecutado.** (No hay remoto configurado en este repositorio en el momento de esta entrega.)

| Paso | Resultado |
|---|---|
| `npm run typecheck` (3 workspaces) | **PASS** |
| `npx eslint apps/web/src packages/domain/src packages/db/src --max-warnings=0` | **PASS** |
| `npm run format:check` (archivos de esta entrega) | **PASS** tras `prettier --write` dirigido — ver nota |
| Postgres recién migrado desde cero (`_test`, extensiones + 10 migraciones + seed) | **PASS** |
| `packages/domain` — 80 pruebas | **PASS** |
| `packages/db` — 219 pruebas | **PASS** |
| `npm run build` (`apps/web`) | **PASS** — incluye la ruta nueva `/campanas/[id]/brief/workspace` |
| worker (`ruff`/`mypy`/`pytest`) | **No re-ejecutado** — cero cambios en `services/ai-worker` en esta entrega |

**Nota sobre `format:check`:** el repositorio ya tenía 20 archivos sin formatear con Prettier antes de empezar esta sesión (heredados de la integración de UI del commit `2452283`, ajena a Sprint 6). Se corrigió formato únicamente en los archivos que esta entrega creó o modificó — no se tocó el resto para no ensanchar el diff de un incremento ajeno.

## 8. Demos

### Demo E — Construcción guiada

**Ejecutada en vivo**, navegador contra `localhost:3000` con datos reales (campaña "Prueba E7-8 — excepción por producto", multiproducto): login → `/campanas/[id]` (enlace "Completar de forma guiada" visible solo con `BRIEF_WORKSPACE_V2=true`) → `/brief/workspace` → tarea mostrada como mensaje conversacional con motivo, criticidad y control de texto → respondida → progreso sube de 0% a 2%, contador de decisiones baja de 21 a 20, confirmación "Guardado: Descripción de la audiencia" → siguiente tarea automática, con un control distinto (`lista`) para el nuevo campo → "Saltar por ahora" reordena sin cambiar el contador. El tramo final ("revisar → enviar a revisión interna") usa el botón ya existente del editor, sin cambios — verificado programáticamente en `completarHastaInternalReview` dentro de tres de las 12 pruebas nuevas (llega a `internal_review` real contra Postgres).

Con `BRIEF_WORKSPACE_V2` sin definir, la misma URL reenvía a `/brief/editar` — verificado navegando directo a la ruta.

**PASS**, observado interactivamente. No se guardaron archivos de captura en este repositorio (sin herramienta de captura persistente en esta sesión) — la evidencia es el recorrido reproducible descrito arriba, con valores concretos (0%→2%, 21→20).

### Demo F — Aprobación y exportación

**BLOCKED / fuera de alcance de esta entrega.** La exportación PDF/DOCX es la Fase E del pedido completo, explícitamente diferida por el usuario ("No implementes todavía: Exportación PDF/DOCX"). El tramo de aprobación (director aprueba internamente → cliente aprueba) no cambió en este incremento y ya estaba cubierto por `client-review.test.ts` (Sprint 5) — reutilizado, no reverificado de nuevo aquí.

### Demo G — Permisos

**PASS**, verificado de forma automatizada (más fuerte que un recorrido manual único, por ser reproducible): casos 10–13 de `brief-workspace.test.ts` — un actor `consultor` en `internal_review` no ve la transición que exige Dirección en `allowedActions`; un actor `director` sí; un actor `cliente` en `client_review` nunca recibe eventos `field_comment` en `activity`; un actor de otra organización recibe `RESOURCE_NOT_FOUND`. El dato de costo/modelo de IA nunca estuvo en el contrato para ningún rol — no es un campo que filtrar, nunca se declaró.

## 9. Limitaciones y próximo incremento recomendado

- **No implementado en esta entrega:** exportación PDF/DOCX (Fase E completa); "Revisar brief" y "Actividad" como pantallas del workspace (C.2/C.3 — el dato ya existe en el contrato, falta la UI); pruebas de navegador automatizadas (Playwright, Fase G); server actions nuevas más allá de las ya reutilizadas (Fase D no necesitó ninguna para el alcance de Completar).
- **Próximo incremento recomendado:** Fase C.2/C.3 (Revisar brief + Actividad, ya con datos listos en `BriefWorkspace.sections`/`.activity`) y Fase E (exportación), en ese orden — la exportación se beneficia de que el documento estructurado ya tenga una vista de revisión coherente antes de convertirla a PDF/DOCX.

## 10. Matriz de requisitos

| Requisito | Implementación | Prueba | Evidencia | Estado |
|---|---|---|---|---|
| Contrato `BriefWorkspace` consolidado | `packages/db/src/brief-workspace.ts` | 12 casos, `brief-workspace.test.ts` | §6.1 | **PASS** |
| Reutiliza reglas de dominio existentes, no las duplica | `allowedTransitions`, `requiresEvidence` (exportada) | Casos 6, 10–11 | §3.1, §6.1 | **PASS** |
| Comentarios internos nunca llegan al cliente | Filtro en `obtenerBriefWorkspace` + no-consulta | Caso 12 | §6.1 | **PASS** |
| Progreso no cuenta un claim sin evidencia | `requiresEvidence` en `evidencePending` | Caso 6 | §6.1 | **PASS** |
| Aislamiento multi-tenant | `getCampaign` (ya existente) | Caso 13 | §6.1 | **PASS** |
| Experiencia guiada de completado | `WorkspaceGuiado.tsx` | Demo E | §8 | **PASS** |
| Reutiliza server actions existentes para responder/descartar | `responderPreguntaLocal`/`descartarPreguntaLocal` | Demo E | §3.2, §8 | **PASS** |
| Un claim nunca se resuelve solo con texto | Tarjeta condicional en `WorkspaceGuiado` | Inspección manual + caso 6 (misma regla) | §3.2 | **PASS** |
| Feature flag `BRIEF_WORKSPACE_V2` | `page.tsx` (redirect si apagada) | Demo E (ambos estados) | §8 | **PASS** |
| Flujo anterior intacto con la bandera apagada | Sin cambios en `/brief/editar` | Build + Demo E | §7, §8 | **PASS** |
| Exportación PDF/DOCX | — | — | — | **BLOCKED** (fuera de alcance acordado) |
| Revisar brief / Actividad como pantallas | — | — | — | **PARTIAL** (dato listo en el contrato, sin UI) |
| Pruebas de navegador (Playwright) | — | — | — | **PARTIAL** (verificación manual interactiva, sin harness automatizado) |
| CI en runner real de GitHub Actions | — | — | — | **BLOCKED** (sin remoto configurado) |

## 11. Estrategia de commits

Tres commits recuperables (no seis — las fases D/E/G.navegador no se construyeron en esta entrega, así que no generan un commit propio):

1. Contrato y read model del workspace (`packages/domain`, `packages/db`, pruebas).
2. Experiencia guiada (`apps/web`: ruta nueva, componente compartido, `revalidatePath` adicional).
3. Documentación de cierre (`CHANGELOG.md`, `decision-log.md`, este documento).

Sin `push`, sin repositorio remoto tocado — no se pidió autorización explícita para eso en esta entrega.

---

## 12. Checkpoint 2 — Revisar brief, Actividad y Playwright

**Estado global de Sprint 6 tras este checkpoint: sigue `PARTIAL`.** Este checkpoint cierra C.2 (Revisar brief), C.3 (Actividad) y G.navegador (Playwright) sobre el núcleo de §1-§11 (hash `0dcbc69`) — la exportación PDF/DOCX (Fase E) sigue sin empezar, y sigue siendo la única razón por la que Sprint 6 no se declara completo.

### 12.1 — Alcance de este checkpoint

Pedido explícito del usuario (build sobre `0dcbc69`): tres modos navegables por URL en `/brief/workspace` (`?modo=completar|revisar|actividad`), "Revisar brief" como documento de solo lectura organizado por los diez bloques canónicos, "Actividad" como línea de tiempo legible derivada únicamente de registros existentes (nunca una tabla nueva), explicar quién debe actuar y por qué (no solo esconder un botón), aislamiento multi-tenant y de rol verificado, y Playwright como primer harness de navegador del repositorio con 9 casos obligatorios. Explícitamente fuera de alcance: exportación, chat autónomo, tabla de mensajes, escritura directa de campos por un agente, nueva máquina de estados, OIDC, Google Drive, OCR, traducción, retirar rutas anteriores, rediseño visual adicional, `push`/PR.

### 12.2 — Estado del repositorio al empezar

- **Hash inicial:** `0dcbc691cf85eae5fdf93c3139517dac90877972` — verificado con `git rev-parse HEAD` / `git log --oneline -5` / `git status --short` antes de tocar código. `git status` mostraba únicamente los archivos sueltos preservados de siempre (`HANDOFF-nuevo-chat.md`, tres `TCL-sprint*-cierre.zip`, `docs/product/pantallas-y-animaciones.md`) — ninguno tocado en este checkpoint.
- **Migración más reciente:** `010_inmutabilidad_bypass_restringido.sql`. **Sin migraciones nuevas** — este checkpoint es de lectura adicional (`Revisar`/`Actividad`) y de una UI de solo lectura sobre datos que el contrato de Checkpoint 1 ya exponía o ya podía exponer con una extensión de la misma función.
- **Conteo de pruebas al empezar:** 80 dominio + 219 `packages/db` (§6, Checkpoint 1).

### 12.3 — Contrato extendido, sin una segunda función

`obtenerBriefWorkspace()` (`packages/db/src/brief-workspace.ts`) sigue siendo la única función que ensambla el workspace — se extendió, nunca se duplicó. Campos nuevos en `BriefWorkspace` (`packages/domain/src/workspace.ts`):

```ts
interface BriefWorkspace {
  // ...campaign, version, products, progress, sections, tasks (Checkpoint 1)...
  activity: readonly WorkspaceActivityItem[];      // ampliado: eventos + revisiones de campo + comentarios, fusionados
  allowedActions: readonly WorkspaceAllowedAction[];
  history: readonly WorkspaceVersionSummary[];      // nuevo — versiones de la campaña, marca cuál es la vigente
  responsibility: WorkspaceResponsibility;          // nuevo — reemplaza a `nextResponsibleRole`
}
```

- `WorkspaceSectionField` ganó `nivel` (`producto`/`campana`/`compartido_con_excepcion`) y `evidence` (cita, fuente, página/sección) — ya calculados en `packages/db`, la UI solo los muestra.
- `activity` fusiona tres fuentes sin inventar una tabla: `audit_events` (vía `listBriefActivity`, ya existente) para eventos genéricos, `brief_field_revisions` para cambios de campo con valor anterior/nuevo, `field_comments` para comentarios — con las seis acciones de campo y las cuatro de comentario **excluidas** de la fuente genérica (`ACCIONES_CON_FUENTE_MAS_RICA`) para no mostrar el mismo hecho dos veces con menos contexto.
- `responsibility.message` la arma `mensajeResponsabilidad()` (`packages/domain/src/brief-presentation.ts`, nueva) a partir del `status` y los contadores que el contrato ya calculaba — una sola fuente de verdad, nunca una segunda matriz de transiciones en `apps/web`.
- `humanoDeEvento()` y `humanoDeRevisionCampo()` (mismo archivo) traducen la `action` cruda de auditoría a una frase legible — si aparece una acción nueva que el mapa no conoce, se muestra igual (con puntos por espacios) en vez de ocultar el evento.

### 12.4 — "No limitarse a esconder el botón"

`allowedActions` ya existía desde Checkpoint 1 (`allowedTransitions(status, actor)` del dominio, sin cambios) pero no se renderizaba en ningún sitio del workspace nuevo. Este checkpoint lo conecta: `BannerResponsabilidad` (`WorkspaceNav.tsx`) muestra siempre la frase de `responsibility.message` y, cuando el actor mismo puede ejecutar una transición, un enlace real (`.btn.pri`, misma clase que el resto de la aplicación) hacia `/campanas/[id]/brief` — donde ya vive el formulario de transición real (`EditorBrief`/`brief/page.tsx`, sin cambios). El workspace nunca reimplementa la mutación ni una segunda regla de quién puede aprobar: solo decide, a partir del mismo dato que ya filtraba `allowedActions`, si ofrece el enlace o no. Un consultor en `internal_review` ve la frase pero ningún enlace; un director ve la misma frase y el enlace "Aprobar internamente" — verificado en E2E-07 (§12.7).

### 12.5 — Revisar brief (`RevisarBrief.tsx`, nuevo, servidor)

Documento de solo lectura por los diez bloques canónicos (`ORDEN_DE_SECCIONES`), con selector de producto para multiproducto (`?producto=`, URL copiable/recargable), fila compartida-vs-excepción deduplicada por campo (misma lógica de selección que `CampoEditable.tsx`, aquí solo de presentación), estado discreto por campo (confirmado/pendiente/manual/extraído/con evidencia/necesita evidencia/conflicto — `Badges`, usa `requiresEvidence` del dominio directamente, nunca reimplementado), evidencia en un `<details>` nativo (bajo demanda, sin JavaScript), campo vacío mostrado siempre como "pendiente" y nunca inventado, versión no editable (`approved`/`superseded`/`cancelled`) marcada con un aviso explícito de solo lectura. Sin edición masiva — Completar sigue siendo el único camino de resolución.

### 12.6 — Actividad (`Actividad.tsx`, nuevo, cliente)

Línea de tiempo unificada a partir de `workspace.activity` (ya fusionada en el servidor, §12.3): tipo de evento legible, actor, fecha, campo/sección afectado, motivo, valor anterior→nuevo (tachado) cuando aplica, estado abierto/resuelto para comentarios. Filtros locales (Todo/Comentarios/Cambios/Aprobaciones) — sin ida al servidor, el dato ya vino completo. Nunca JSON crudo como experiencia principal.

### 12.7 — Playwright — primer harness de navegador del repositorio

No existía ningún harness de pruebas de navegador antes de este checkpoint. Se creó el workspace `apps/e2e` (`@tcl-kol-os/e2e`, npm workspace nuevo, `@playwright/test` vía `channel: 'chrome'` — Google Chrome real instalado en la máquina, no el binario que descarga Playwright), con base de datos aislada `_test` (INC-001A, candado propio en `src/fixtures.ts` además del de `packages/db`), `AI_PROVIDER=fake`, dos servidores Next (`playwright.config.ts`: puerto 3010 con `BRIEF_WORKSPACE_V2=false`, puerto 3011 con la bandera encendida) y dos proyectos enrutados por nombre de archivo — nunca P80, nunca datos reales de cliente, cada prueba crea su propia campaña desechable y la limpia en `afterAll` (`limpiarTodo`, nunca cierra el pool compartido entre archivos).

**Los 9 casos obligatorios, todos implementados y en verde:**

| Caso | Archivo | Verifica |
|---|---|---|
| E2E-01 | `flag-apagado.spec.ts` | Bandera apagada → `/brief/workspace` reenvía limpio a `/brief/editar`, que carga completo |
| E2E-02 | `workspace.spec.ts` | Bandera encendida → los tres modos (Completar/Revisar brief/Actividad) visibles, modo por defecto Completar |
| E2E-03 | `workspace.spec.ts` | Responder una tarea crítica real → progreso y pregunta cambian (esperado con un `expect` que reintenta, no una lectura puntual — la revalidación del servidor llega en un segundo round-trip) |
| E2E-04 | `workspace.spec.ts` | Saltar reordena solo en el navegador — una recarga completa vuelve a mostrar la tarea original, prueba de que no escribió nada en el servidor |
| E2E-05 | `workspace.spec.ts` | Revisar brief: navega secciones, cambia de producto por URL, ninguna clave técnica cruda visible como título |
| E2E-06 | `workspace.spec.ts` | Actividad: comentario sintético real visible con actor y fecha, filtro por tipo funciona |
| E2E-07 | `roles-y-aislamiento.spec.ts` | Consultor en `internal_review` ve la frase de responsabilidad sin enlace de acción; director ve la misma frase con el enlace "Aprobar internamente" hacia `/brief` |
| E2E-08 | `roles-y-aislamiento.spec.ts` | Cliente nunca llega al workspace interno (redirect a `/brief`, verificado incluso hasta 404 por aislamiento de visibilidad); ningún comentario interno ni metadata de IA en la respuesta |
| E2E-09 | `roles-y-aislamiento.spec.ts` | Un actor de otra organización recibe 404 real (nunca el contenido) al intentar abrir el workspace de una campaña ajena |

**Problemas reales descubiertos y corregidos únicamente por correr la suite de punta a punta** (nunca simulados, todos reproducidos antes del arreglo):

1. `apps/e2e` no declaraba `"type": "module"` → Node/Playwright no podían resolver `import.meta.url` (usado en `brief-catalog.ts`, `migrate.ts`, `storage.ts` para ubicar archivos junto al módulo) al cargar `@tcl-kol-os/db`/`@tcl-kol-os/domain` desde `node_modules`. Arreglado añadiendo `"type": "module"` a `apps/e2e/package.json`.
2. `playwright.config.ts` validaba `E2E_DATABASE_URL` pero nunca la exponía como `DATABASE_URL` al propio proceso de Playwright (solo a los `webServer` hijos) — las funciones de `fixtures.ts` fallaban con "DATABASE_URL debe apuntar a una base `_test`". Arreglado exportándola también al proceso principal.
3. El `testMatch` del proyecto `flag-on` usaba una negación por *lookahead* sin anclar (`/(?!flag-apagado).*\.spec\.ts/`) — el motor de expresiones regulares reintenta la coincidencia en posiciones posteriores del nombre de archivo, así que `flag-apagado.spec.ts` igual calzaba y la prueba de bandera apagada corría dos veces, una por proyecto. Solo se detectó corriendo la suite completa sin filtro (cada archivo por separado nunca lo expone). Arreglado enumerando los archivos del proyecto `flag-on` explícitamente en vez de negar.
4. Compilación bajo demanda de `next dev`: la primera vez que una ruta se pide en un servidor "frío" (justo al empezar un archivo `.spec.ts` nuevo, con el servidor aún compilando `/campanas` o `/brief` por primera vez), la petición en vuelo a veces se aborta (`net::ERR_ABORTED`) o el login redirige de vuelta a `/login` en vez de a `/campanas` — un problema conocido de `next dev`, nunca de las rutas ni de ninguna regla de dominio (nunca ocurre en un archivo aislado, ni en un segundo intento del mismo archivo). Arreglado con un reintento acotado (una sola vez) en `login()` y en un `gotoConReintento()` compartido (`src/nav.ts`) para toda navegación directa — nunca en las aserciones de negocio, solo en la navegación.

Confirmado estable: la suite completa (9/9) corrió en verde en **dos corridas consecutivas** contra la base ya usada por `packages/db`, y una tercera vez contra una base recién migrada y sembrada desde cero (§12.8) — sin ninguna de las cuatro fallas anteriores reapareciendo.

### 12.8 — Pruebas de integración extendidas (`packages/db`)

`brief-workspace.test.ts` pasó de 12 a **20 casos** (+8, todos nuevos de este checkpoint, ninguno duplicado para inflar el conteo): orden de secciones (subsecuencia contra `ORDEN_DE_SECCIONES`), `nivel` correcto para un campo de campaña vs. uno por producto, declarar una excepción por producto y verla como `compartido_con_excepcion`, evidencia con cita/fuente/sección visible en el contrato, una corrección de campo aparece en `activity` como `revision_campo` con valor anterior/nuevo (y se verifica que NO exista además un evento genérico duplicado para la misma acción), un comentario aparece en `activity` con contenido real y transición abierto→resuelto, `activity` ordenada de la más reciente a la más antigua, `history` marca correctamente `isCurrent`/versión reemplazada tras `crearVersionHija`.

Dos correcciones descubiertas al escribir estos casos (nunca cambios de regla de dominio — ambas eran suposiciones incorrectas de la prueba, no defectos del código):
- Una campaña sin productos nunca recibe filas de nivel `producto` (`crearBriefManual` recorre `campaign_products`, vacío) — `progress.total` se comparó contra un conteo real de filas, no contra el largo del catálogo completo.
- El campo de claim usado para probar criticidad (`marca_producto[].beneficio_principal`) también es de nivel `producto` — la prueba empezó agregando un producto antes de crear el brief.

**`mensajeResponsabilidad()` — 17 pruebas nuevas en `packages/domain`** (`brief-presentation.test.ts`, nuevo): una por cada rama de estado, más el límite singular/plural que atrapó un error real de tildes ("decisiónes" → "decisiones", corregido antes de cualquier commit). La rama `superseded` se probó como prueba unitaria pura de dominio, no de integración: es alcanzable en teoría pero nunca en la práctica desde `obtenerBriefWorkspace()` real, porque `versionesDelBrief()[0]` siempre devuelve la versión de mayor número, y una versión reemplazada por construcción tiene un número menor que su hija — escribir una prueba de integración que simulara ese estado habría sido engañosa.

### 12.9 — Seguridad y aislamiento (verificado, no solo revisado)

- **Cliente nunca accede al workspace interno:** `page.tsx` redirige antes de cargar cualquier dato (`if (user.role === 'cliente') redirect(...)`) — nunca "renderiza y luego oculta". Verificado en E2E-08.
- **Multi-tenant:** `getCampaign` (sin cambios, ya existente) responde igual a "no existe" que a "es de otra organización" (S-01, evita revelar que el recurso existe) — un 404 real, nunca contenido parcial. Verificado en E2E-09.
- **Sin metadata de IA ni comentarios internos para cliente:** nunca estuvieron en la proyección que llega a un actor `cliente` (Checkpoint 1, §3.1 del documento original) — este checkpoint solo añadió una verificación de navegador adicional (E2E-08) sobre una garantía que ya existía a nivel de contrato.

### 12.10 — Resultado de CI (Checkpoint 2)

**PASS — receta reproducida localmente; GitHub Actions real no ejecutado** (sin remoto configurado, igual que en Checkpoint 1).

| Paso | Resultado |
|---|---|
| `npm run format:check` | **PASS** tras `prettier --write` dirigido a los archivos de este checkpoint únicamente (18 archivos preexistentes siguen sin formatear, heredados de antes de Sprint 6 — no se tocaron, mismo criterio que Checkpoint 1) |
| `npm run lint` (`eslint . --max-warnings=0`) | **PASS** |
| `npm run typecheck` (4 workspaces: `domain`, `db`, `web`, `e2e`) | **PASS** |
| `packages/domain` — 97 pruebas (80 + 17 nuevas) | **PASS** |
| Postgres recién migrado desde cero (`_test`, extensiones + 10 migraciones + seed) | **PASS** |
| `packages/db` — 227 pruebas (219 + 8 nuevas), contra la base recién migrada | **PASS** |
| Playwright — 9/9 casos obligatorios, contra la base recién migrada | **PASS**, estable en 3 corridas |
| `npm run build` (`apps/web`) | **PASS** |
| worker (`services/ai-worker`) | **No tocado, no re-ejecutado** — cero cambios en este checkpoint |

**Conteo global si se suman todas las suites realmente ejecutadas en esta entrega:** 97 dominio + 227 `packages/db` + 9 Playwright = **333 pruebas automatizadas en verde**. (No se sumó el worker: no se volvió a correr, cero cambios.)

### 12.11 — Demos y evidencia visual

Recorrido interactivo completo contra una base de datos aislada, recién migrada y sembrada (nunca `tclkolos`/P80, nunca los contenedores de desarrollo habituales): campaña sintética "Demo Checkpoint 2 — Workspace guiado" (multiproducto: P80 + Soundbar S64) creada desde la UI real (`/campanas/nueva`), brief a mano, preguntas generadas, una respondida en vivo desde el modo Completar.

- **Completar:** banner de responsabilidad ("Tienes 12 decisiones críticas pendientes.") con el enlace real "Enviar a revisión interna" (visible porque el actor, `admin`, sí puede ejecutar esa transición); progreso, cola de tareas y control de respuesta funcionando igual que en Checkpoint 1.
- **Revisar brief:** documento por secciones canónicas, pills de producto (P80 / Soundbar S64) que cambian la URL (`?producto=`), estado "pendiente" explícito y nunca inventado para cada campo sin dato.
- **Actividad:** línea de tiempo real (crear campaña → iniciar brief a mano → generar preguntas → responder una → aplicar la respuesta), con actor, fecha exacta y filtros Todo/Comentarios/Cambios/Aprobaciones.

**PASS**, observado interactivamente sobre datos sintéticos. Capturas no incluidas en el repositorio (mismo criterio que Checkpoint 1: sin herramienta de captura persistente configurada para archivos de este repositorio) — evidencia reproducible mediante los mismos pasos, o mediante los 9 casos de Playwright que ejercitan exactamente estas pantallas de forma automatizada y determinística.

### 12.12 — Limitaciones

- **Exportación PDF/DOCX (Fase E):** no empezada, explícitamente excluida de este checkpoint. Sprint 6 permanece `PARTIAL` por esta razón únicamente.
- **`next dev` bajo carga sostenida:** la suite de Playwright necesitó dos mitigaciones de reintento (§12.7, puntos 3-4) por comportamiento del servidor de desarrollo, no del código de producto — no aplican a un build de producción ni deberían ser necesarias contra un entorno de staging real.
- **Sin capturas de pantalla versionadas:** igual que en Checkpoint 1, la evidencia visual es el recorrido reproducible y la suite automatizada, no archivos de imagen en el repositorio.

### 12.13 — Matriz de requisitos (Checkpoint 2)

| Requisito | Implementación | Prueba | Evidencia | Estado |
|---|---|---|---|---|
| Tres modos navegables por URL, `modo` inválido → `completar` | `page.tsx` | E2E-02 | §12.7 | **PASS** |
| Completar preservado sin cambios de comportamiento | `WorkspaceGuiado.tsx` (solo el pie de página cambió de fuente) | E2E-03, E2E-04 | §12.7 | **PASS** |
| Revisar brief: documento de solo lectura, 10 secciones canónicas | `RevisarBrief.tsx` | E2E-05 | §12.5, §12.7 | **PASS** |
| Estado discreto por campo, nunca inventar un valor vacío | `Badges` (`requiresEvidence` del dominio) | E2E-05 | §12.5 | **PASS** |
| Evidencia bajo demanda | `<details>` nativo | E2E-05 | §12.5 | **PASS** |
| Actividad derivada solo de registros reales, nunca tabla nueva | `activity` fusionado en `obtenerBriefWorkspace` | E2E-06, casos 17-20 de `brief-workspace.test.ts` | §12.3, §12.8 | **PASS** |
| "No limitarse a esconder el botón" | `BannerResponsabilidad` + `allowedActions` | E2E-07 | §12.4 | **PASS** |
| Cliente nunca accede al workspace interno | Redirect antes de cargar datos | E2E-08 | §12.9 | **PASS** |
| Aislamiento multi-tenant | `getCampaign` (ya existente) | E2E-09 | §12.9 | **PASS** |
| Playwright — 9 casos obligatorios | `apps/e2e/` | §12.7 | §12.7, §12.10 | **PASS** |
| Nunca una segunda función que compita con `obtenerBriefWorkspace()` | Una sola función extendida | — | §12.3 | **PASS** |
| Exportación PDF/DOCX | — | — | — | **BLOCKED** (fuera de alcance) |
| CI en runner real de GitHub Actions | — | — | — | **BLOCKED** (sin remoto configurado) |

### 12.14 — Estrategia de commits (Checkpoint 2)

Cinco commits recuperables:

1. Extensión del contrato/proyección (`packages/domain`, `packages/db`, pruebas de dominio y de integración).
2. Modo Revisar brief (`RevisarBrief.tsx`, `WorkspaceNav.tsx`, cambios en `page.tsx`).
3. Modo Actividad + responsabilidad (`Actividad.tsx`, banner con acción real).
4. Playwright (`apps/e2e/` completo) + los cuatro arreglos descubiertos corriendo la suite (§12.7).
5. Documentación de cierre de este checkpoint (este documento, `CHANGELOG.md`, `HANDOFF.md`, `README.md`).

Sin `push`, sin repositorio remoto tocado, sin auto-iniciar el siguiente checkpoint (exportación) — tal como se pidió.
