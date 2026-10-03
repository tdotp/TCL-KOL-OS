# Corrección del workflow cliente (cliente read-only)

Base: `fc6a09c`. Sin migraciones de base de datos. Sin cambios visuales de diseño.

## 1. Workflow anterior

```
internal_review ──(admin/director)──▶ client_review
client_review ──(cliente, o consultor "en su nombre")──▶ approved
client_review ──(cliente, o consultor "en su nombre")──▶ client_changes_requested ──▶ internal_review
```

El rol `cliente` tenía `brief:request_client_changes` y `brief:register_client_decision`, `VistaCliente` mostraba los botones «Aprobar» y «Solicitar cambios», y `packages/db/src/client-review.ts` exportaba `aprobarComoCliente` / `solicitarCambiosCliente`.

## 2. Contradicción

SmartPR opera el sistema y decide. El cliente no aprueba briefs, no pide cambios y no modifica estados operativos; tendrá más adelante un dashboard de solo lectura. La IA tampoco aprueba: analiza y propone. El workflow anterior ponía la decisión final en manos del cliente, y permitía que un consultor «registrara» esa decisión en nombre del cliente.

## 3. Workflow corregido

```
internal_review ──(admin/director)──▶ approved          (cierre por SmartPR, congela la versión)
internal_review ──(admin/director)──▶ internal_changes_requested ──(consultor+)──▶ internal_review
```

- `internal_review → approved` reúne las guardas que antes se repartían entre `→ client_review` y `client_review → approved`: sin conflictos sin resolver, claims con evidencia, sin preguntas críticas pendientes, traducción con origen.
- Solo `admin` y `director` aprueban. El `consultor` ya no puede cerrar un brief (antes podía «registrar la decisión del cliente»).
- Al aprobar, `campaigns.visibility` sube de `interna` a `tcl` (antes ocurría al enviar a revisión del cliente), de modo que el cliente puede **leer** la campaña aprobada. Nunca baja la visibilidad.

## 4. Estados legacy

`client_review` y `client_changes_requested` **siguen en el enum de Postgres y en `BriefStatus`**: pueden existir filas persistidas. No se borran, no se migran datos, no se reescribe el historial (`audit_events` conserva los motivos de devoluciones del cliente y `motivoDeUltimaDevolucion` los sigue leyendo).

| Regla | Detalle |
| --- | --- |
| Nada entra | Ninguna transición tiene `client_review` o `client_changes_requested` como destino. Test: «ninguna transición entra a los estados legacy». |
| Siguen leyéndose | `ESTADO_EN_ESPANOL` las etiqueta «(heredado)»; la vista del cliente sigue mostrando versiones en esos estados. |
| Siempre tienen salida | `client_review → approved` (admin/director, mismas guardas), `client_review → internal_review` (admin/director), `client_changes_requested → internal_review` (consultor en adelante), y `→ cancelled` (admin/director) como antes. Ninguna campaña queda bloqueada. |
| Cliente excluido | El rol `cliente` no aparece en ninguna regla. |
| Exportado | `LEGACY_CLIENT_STATES` e `isLegacyClientState()` en `packages/domain/src/brief-states.ts`. |

Ruta segura para una versión legacy: Dirección la **aprueba** directamente, o la **devuelve** a `internal_review` y sigue el flujo vigente. No se reconcilia nada en silencio.

## 5. Permisos

- `cliente`: `campaign:read`, `brief:read`, `brief:export`. Se eliminaron `brief:request_client_changes` y `brief:register_client_decision` (del tipo `Action` y de todos los roles).
- `accionParaDestino` (`packages/db/src/transitions.ts`): `approved` e `internal_changes_requested` exigen `brief:approve_internal` (admin/director); el resto, `brief:transition`. El dominio (`ruleAllowsActor`) vuelve a verificar el rol: defensa en dos capas.
- El actor `'system'` (worker/IA) no puede ejecutar `→ approved` (test).

## 6. Transiciones (resumen de cambios)

| Transición | Antes | Ahora |
| --- | --- | --- |
| `internal_review → client_review` | admin/director | **eliminada** |
| `client_review → client_changes_requested` | editorial + cliente | **eliminada** |
| `client_review → approved` | editorial + cliente | admin/director (solo legacy) |
| `client_review → internal_review` | — | admin/director (solo legacy) |
| `internal_review → approved` | — | **nueva**, admin/director |
| `client_changes_requested → internal_review` | editorial | igual (solo legacy) |

## 7. Decisiones tomadas

1. Conservar el enum y los estados como legacy en lugar de migrar o borrar (sin riesgo para lecturas históricas; sin migración).
2. Aprobar es exclusivo de admin/director; el consultor propone y corrige.
3. La visibilidad hacia el cliente se mueve de «envío a revisión» a «aprobación».
4. Se eliminaron `aprobarComoCliente` y `solicitarCambiosCliente`; `aprobarInternamente` se renombró a `aprobarBrief` (su semántica cambió: ahora cierra el brief) y la server action `aprobarInternamenteDeCampana` a `aprobarBriefDeCampana`. El archivo `client-review.ts` conserva su nombre para no romper imports.
5. `siguienteResponsable` (workspace) ya nunca devuelve `cliente`: `client_review` → director, `client_changes_requested` → consultor.
6. En `VistaCliente` solo se retiraron los controles de decisión; el resto de la vista no cambió.

## 8. Fuera de alcance (no se hizo)

- Dashboard de solo lectura del cliente, influencers, guiones, entregables, `ContentVersion`, análisis IA, timeline nuevo, previews.
- Migración o limpieza de filas legacy; quitar los valores del enum.
- El stepper (`apps/web/src/lib/brief-ui.ts`, `ETAPAS`) conserva la etapa «Revisión cliente»: es presentación y se corrige con el rediseño de UI. Ninguna versión nueva la alcanza.
- Documentos históricos (`D0-03`, `D0-07`, `D0-12`, `D0-18`, `decision-log`, `HANDOFF.md`, documento maestro) describen el modelo anterior y **no** se editaron; esta nota los supersede. La decisión quedó registrada como DEC-042 en el decision-log; D0-07 y el resto se actualizarán cuando el usuario lo pida.
- Playwright: solo E2E-07 se ajustó (el botón del director ahora dice «Aprobar», ya no «Aprobar internamente»). Los 9 casos pasan.
