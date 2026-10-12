# TCL KOL OS V2 — Dashboard TCL de solo lectura (Fase 9, DEC-050)

> Nota técnica. Arquitectura **congelada** al inicio de la F9; se actualiza con lo realmente construido al cierre.

## 1. Principio

Cuenta construye y decide · Operativo ejecuta y registra · **TCL observa**.

```
dominio interno → PROYECCIÓN TCL del servidor (allowlist positiva, campo por campo)
                → DTO cliente → UI (/tcl) y export (CSV/JSON)
```

TCL nunca recibe una entidad interna ni un read model interno «con menos campos». Cada DTO se construye literal, campo por campo (sin `{...x}` + `delete`). Cada campo responde «¿por qué lo necesita TCL?».

## 2. Aislamiento del cliente (sin migración)

- El cliente V2 **es TCL**. Contrato vigente: rol `cliente` + `campaigns.visibility IN ('tcl','compartida')` + `status ≠ cancelada` + la organización del actor es de tipo `cliente` + capacidades específicas + guard único en servidor. Fallo ⇒ 404 idéntico (no existe / no visible / otra org).
- `campaigns` no lleva organización cliente: una campaña de **otra agencia** puesta en `tcl|compartida` es visible por contrato (esa visibilidad es la compartición explícita con TCL). Las `interna` de cualquier agencia están denegadas. Un `client_organization_id` sería multi-cliente genérico (fuera de alcance): **deuda declarada**, sin migración 034.
- Toda ruta por id verifica que la entidad pertenece a la campaña de la URL.

## 3. Permisos (solo `cliente`)

Nuevas: `campaign:read_client`, `content:read_approved_client`, `operations:read_summary_client`, `kpi:read_client` (ya reservada), `export:client`. Se añade `document:read_client`. Se **retiran** del cliente `campaign:read`, `brief:read`, `brief:export` y `source:read_shared` (los lectores legados de fuentes deniegan al cliente; la proyección usa su propio SQL con visibilidad) (cierran lecturas legadas de borradores y de `modelo/costoUsd`); las rutas legadas `/campanas/**` redirigen al cliente a `/tcl`. Ningún rol obtiene `pii:read`/`finance:read` por F9. Personal interno: 404 en `/tcl/**`.

## 4. Proyecciones (`packages/domain/src/tcl-projection.ts` tipos + puras; `packages/db/src/tcl-projection.ts` consultas)

| Proyección | Fuente | Campos permitidos |
|---|---|---|
| Lista de campañas | SQL explícita | id, nombre, mercado, categoría, fechas, estado `en_curso\|finalizada` |
| Detalle | ídem + productos | lo anterior + conteos (influencers activos, guiones aprobados/total, KPI cumplidos/total) + productos {marca, modelo, categoría}. Sin owner, presupuesto, confidencialidad, visibilidad |
| Influencers | participaciones activas (`cargarDatosOperativos`, secciones sin finanzas) | participacionId, nombre, cuentas {plataforma, handle}, productos, etapa, productoRecibido, guion, kpis. Sin influencerId, PII, acuerdo |
| Contenido aprobado | fila `approved` de `script_versions` ⨝ entregables activos | entregable {id, etiqueta, plataforma, producto}, `estado aprobado\|pendiente`, `aprobadoEl`. Todo estado no aprobado ⇒ `pendiente` sin más rastro |
| Brief | brief aprobado vigente (`obtenerRepresentacion`) | versión, aprobadoEl, idioma; solo claves estructuradas del catálogo por allowlist; sin evidencias, provenance, presupuesto |
| Resumen operativo | `derivarDeParticipacion` → `proyectarOperacionParaTcl` | etapa `pendiente\|en_curso\|listo`, productoRecibido `si\|no\|parcial`, guion {estado, aprobados, total}; producción/publicación `no_disponible`. Nunca acuerdo, modo, logística fina, dinero |
| KPI | `obtenerKpiDeParticipacion().public` | métrica, unidad, comparador, objetivo, resultado, cumplimiento, estado, fecha. `internal` y `other` nunca |
| Documentos | fuentes `tcl\|compartida`, no `soporte_operativo`, no guion no aprobado, no Sheet de influencers | sourceId, título, tipo, idioma, fecha. Sin hash, URLs, jobs, fragmentos |

Publicaciones: **no existe el dominio**; no se muestra ni se simula.

## 5. Defensa de fuga histórica (propia de la proyección)

1. Solo claves estructuradas del catálogo (allowlist); 2. `esTextoSeguroParaTcl` (dominio, puro) sobre **todo** texto libre: cifras/moneda, `fee|canje|barter|tarifa|honorarios|factura|cuenta de cobro|invoice|compensation`, emails, teléfonos, cédulas; ante hallazgo se **omite el campo completo**; 3. campos con evidencia cuyo fragmento sea ilegible por `fragment-scope` o provenga del Sheet de influencers se excluyen; 4. `clavesProhibidasEn` sobre la salida. No se confía en visibilidad de fuente ni en filtros de UI.

## 6. Export

`GET /api/tcl/campanas/[id]/export?formato=csv|json`: mismo guard, llama a la **misma** proyección y serializa solo sus campos (columnas ⊆ claves del DTO); CSV con BOM UTF-8, neutralización de fórmulas (`= + - @ \t \r`), `Content-Disposition` saneado, `nosniff`, `Cache-Control: private, no-store`. Ningún export lee tablas.

## 7. Rutas

`/tcl` (lista) · `/tcl/campanas/[id]` (resumen) · `/influencers` · `/contenido` · `/operacion` · `/kpi` · `/documentos` · `/brief`. `tcl/layout.tsx` = guard único. Server components; sin formularios; sin `loading/error` global. Un test estático impone que `app/(app)/tcl/**` solo importe de `@tcl-kol-os/db` la proyección TCL.

## 8. Fuera de alcance

Entidad Publication, escrituras de cliente, agente/tools/conversaciones TCL, PII, finanzas, rediseño general.
