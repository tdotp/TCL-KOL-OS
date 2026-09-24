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
