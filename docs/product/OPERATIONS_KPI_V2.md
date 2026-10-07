# Operación y KPIs (V2 · Fase 8)

Decisión: DEC-049. Migraciones: `026_tipo_fuente_soporte_operativo.sql` … `032_kpis.sql`. Rutas web: `/campanas/[id]/operacion/**`. Agente: 6 tools nuevas (36 → 42).

> **Cuenta construye y decide. Operaciones ejecuta y registra. TCL observa.** Esta fase es de Operaciones: **registra** acuerdos, logística, documentos de cobro, pagos reportados y KPIs reales sobre los mismos influencers de la campaña. **Registrar un pago no es ejecutarlo**: TCL KOL OS no mueve dinero (DEC-014).

```
Influencer ──► CampaignInfluencer ─┬─► Agreement ──► versiones V1…Vn (inmutables) ──► compromisos de producto
                                   │        └─► payment_obligation (not_applicable | pending | reported_paid | cancelled)
                                   │                  └─► billing_documents (registrado → validado | rechazado | anulado)
                                   ├─► Shipment ──► shipment_items (producto de campaña)   · pii_record_id (referencia segura)
                                   ├─► KPI targets / measurements (opcional: Deliverable)
                                   └─► Deliverable / ScriptVersion (F7, solo lectura de estado)
 Todo cambio de estado de envío / documento / obligación = un operational_event (append-only) + evidencia (source soporte_operativo)
```

## 1. Modelo de datos

| Tabla (migr.) | Qué es | Reglas impuestas en la base |
|---|---|---|
| `agreements` (027) | Cabecera; `UNIQUE(campaign_influencer_id)`; `active\|cancelled` + motivo y quién | FKs compuestas org+campaña; sin DELETE/TRUNCATE; cada acuerdo exige versión 1 y su obligación al commit |
| `agreement_versions` (027) | Términos materiales inmutables: modo, monto, moneda, fechas, condiciones, motivo del cambio | CHECK barter ⇒ sin monto/moneda; fee/mixed ⇒ monto > 0 y moneda `^[A-Z]{3}$`; número por trigger bajo bloqueo; sin UPDATE |
| `agreement_product_commitments` (027) | Producto comprometido por versión | Solo barter/mixed (≥ 1); producto de la campaña; inmutable |
| `payment_obligations` (027) | Seguimiento de pago del acuerdo | Constraint diferido: barter ⇒ `not_applicable` (o `cancelled`); fee/mixed ⇒ distinto de `not_applicable`; sellos de `reported_paid` (quién, cuándo, `paid_on`, referencia externa) fijados desde el evento |
| `influencer_pii_records` (028) | Cédula, teléfono, dirección **cifrados** (bytea) por influencer | Append-only por versión; CHECK de envoltorio; blind index único por organización vigente; única mutación: marca de borrado |
| `shipments` / `shipment_items` (029) | Logística de una participación | Grafo de estados en trigger; `prepared` exige producto asignado (016) y, en barter/mixed, comprometido; `pii_record_id` del MISMO influencer; guard: no se desasigna un producto con compromiso o envío abierto |
| `billing_documents` (030) | Documento de cobro **registrado** con evidencia obligatoria | Un solo `validated` por obligación; número y archivo únicos entre vivos; datos registrados inmutables |
| `operational_events` / `operational_evidence` (031) | Hechos append-only y su evidencia | `origin='ui'`; `UNIQUE(org, idempotency_key)`; `UNIQUE(sujeto, subject_seq)`; una sola FK de sujeto; `last_event_id` debe coincidir (UPDATE directo de `status` falla); evidencia solo en la misma transacción que su evento |
| `source_documents.type='soporte_operativo'` (026/031) | Evidencia = Sources | Siempre `sensible`, interna, `file`, sin jobs ni fragmentos |
| `kpi_targets` / `kpi_measurements` (032) | Objetivo pactado ≠ resultado real | Objetivo: un vigente por ámbito+métrica+unidad (supersession); medición inmutable, corrección = fila nueva con motivo, una corrección por fila; campaña `activa` para objetivos, `activa\|archivada` para mediciones |

## 2. Máquinas de estado

- **Agreement:** `active → cancelled`. Cambio material = versión N+1 (`expectedVersion`, motivo obligatorio). Con obligación `reported_paid`, un cambio de monto/moneda/modo se rechaza.
- **Shipment:** `pending → prepared → shipped → delivered`; `pending|prepared → cancelled`; `shipped → failed | returned`; `delivered → returned`. Terminales: cancelled, failed, returned. Reenviar = envío nuevo. `shipped/delivered` exigen fecha del hecho; `cancelled` exige motivo.
- **BillingDocument:** `registered → validated | rejected`; `registered|validated → voided`.
- **PaymentObligation:** `not_applicable ↔ pending` (solo por evento `payment.applicability_set` coherente con la versión vigente); `pending → reported_paid | cancelled`; `not_applicable → cancelled`. `reported_paid` terminal; la corrección es un evento `payment.correction_noted` sin cambio de estado.
- **Seguimiento de pago derivado** (no se guarda): `not_applicable | pending_document | document_received | pending_payment | reported_paid`.
- **Mecanismo común:** el caso de uso bloquea el sujeto, compara `expectedSeq` (si no coincide ⇒ `RESOURCE_CONFLICT` `stale_transition`), inserta el evento (idempotente: reintento idéntico devuelve el mismo evento; misma clave con otro contenido ⇒ conflicto) y actualiza `status`, `row_seq` y `last_event_id`.

## 3. PII (DEC-013)

AES-256-GCM en la aplicación (`packages/db/src/pii.ts`); AAD `registro|campo|llave`; `PII_ENCRYPTION_KEYS` (anillo, la primera cifra, las demás solo descifran) y `PII_INDEX_KEY` (HMAC de la cédula normalizada) por entorno; sin clave configurada falla (`PII_NOT_CONFIGURED`), nunca hay valor por defecto fuera de bases `_test`. `guardarPii` (pii:manage), `revelarPii` (pii:read; audita `pii.reveal` con **nombres** de campo), `obtenerPiiResumen` (solo qué campos existen). Nunca en CampaignInfluencer, Shipment, agente, índice vectorial ni auditoría. El texto libre (notas, motivos) lleva aviso de no escribir datos personales y no se audita ni llega al agente.

## 4. Permisos

| Capacidad | admin | director | consultor | operativo | cliente |
|---|:-:|:-:|:-:|:-:|:-:|
| `operations:read`, `agreement:read`, `shipment:read`, `kpi:read` (sin dinero ni PII) | ✓ | ✓ | ✓ | ✓ | – |
| `agreement:manage`, `shipment:manage`, `billing:manage`, `ops_evidence:attach` | ✓ | ✓ | – | ✓ | – |
| `finance:read` (fee, costos, facturas, pagos) | ✓ | ✓ | – | ✓ | – |
| `payment:report` | ✓ | – | – | ✓ | – |
| `pii:read` / `pii:manage` | ✓ | – | – | ✓ | – |
| `kpi:target_manage` | ✓ | ✓ | ✓ | – | – |
| `kpi:measure` | ✓ | ✓ | – | ✓ | – |

analista y legal no reciben nada nuevo. El Operativo **no** obtiene `script:*`, `brief:*`, `chat:*`, hallazgos ni razonamiento de IA. La base impone los roles (`operaciones_exigir_rol`) y una prueba de paridad la compara con `roleCan`.

## 5. Read models y frontera TCL

`obtenerResumenOperativoDeCampana` (lista, filtros, por lotes) y `obtenerEstadoOperativoDeParticipacion` (detalle) componen las secciones **acuerdo, logística, facturación/pagos, contenido, KPI** según la capacidad: una sección sin permiso **no se consulta y no existe en la respuesta**. `obtenerResumenOperativoParaAgente` / `obtenerEstadoOperativoParaAgente` devuelven un DTO sin dinero, facturación, pagos, costos, tracking ni PII por construcción. `ProyeccionTclDeOperacion` (dominio) es solo un **contrato** para la Fase 9, con `CLAVES_PROHIBIDAS_TCL` y una función pura que construye la salida solo desde una entrada pública; no tiene ruta ni acceso.

## 6. KPI

Catálogo cerrado en `packages/domain/src/kpi-metrics.ts` (views, reach, impressions, likes, comments, shares, saves, link_clicks → `count`; engagement_rate → `percent` en puntos; `other` con etiqueta, nunca comparable). `compararKpi` solo compara con métrica, unidad y ámbito compatibles (última observación vigente; `sin_medicion | no_comparable | por_debajo | cumplido`); nunca suma entre métricas ni entregables. El Sheet V1 solo conserva `kpi_objetivo` como **texto libre**: `obtenerKpiPactadoDelSheet` lo lee del snapshot **vigente** (nunca fee/canje) y lo ofrece como sugerencia con procedencia; una persona lo convierte en objetivo estructurado. Entrada manual en el MVP; CSV, Sheets y APIs externas diferidos.

## 7. Tools del agente (36 → 42) y caso de uso que reutilizan

| Tool | Riesgo | Caso de uso |
|---|---|---|
| `operations_summary_list` | lectura | `obtenerResumenOperativoParaAgente` |
| `operations_participation_status` | lectura | `obtenerEstadoOperativoParaAgente` |
| `kpi_scoreboard_get` | lectura | `obtenerKpiDeParticipacion` (solo bloque público) |
| `kpi_history_get` | lectura | `obtenerHistorialDeKpi` (solo bloque público; alias K y M) |
| `sheet_kpi_pactado_get` | lectura | `obtenerKpiPactadoDelSheet` (texto en sobre no confiable) |
| `kpi_target_register` | escritura | `registrarKpiObjetivo` (cita literal con valor y métrica; origen chat; cuota 3/run) |

**No existen** tools de acuerdos, envíos, facturación, pagos, evidencia, PII, mediciones ni correcciones. El manifiesto D15 clasifica cada export de F8; un test estático falla si una tool referencia uno prohibido. Prompt `agente-cuenta-4`. El worker admite hasta 64 tools por turno (`MAX_TOOLS`; era 40).

## 8. UI (mínima)

`/campanas/[id]/operacion` (lista con filtros por estado) y `/campanas/[id]/operacion/[participacionId]` (cinco secciones). Formularios con `idempotencyKey` y `expectedSeq/expectedVersion`; los datos personales solo aparecen tras «Revelar datos» (acción explícita, auditada, se ocultan a los 60 s). Subida de evidencia por `POST /api/campanas/[id]/operacion/evidencia` con comprobación estricta Origin===Host. Cliente y otras agencias: 404. Los componentes de cliente importan de `lib/operacion-cliente.ts` y del subpath `@tcl-kol-os/domain/operational-events` (el barril del dominio arrastra `node:crypto`).

## 9. Auditoría

Acciones `agreement.*`, `shipment.*`, `billing.*`, `payment.*`, `pii.*`, `ops_evidence.*`, `operational_event.*` y `kpi_target.* / kpi_measurement.*`, con origen y correlación. Las operativas y de PII pasan por una **allowlist** (ids, estados, versiones, conteos, nombres de campo; lo demás se redacta): jamás montos, notas, referencias, nombres de archivo ni valores de PII. Las mediciones KPI no son eventos operativos: son hechos inmutables en su propia tabla, auditados aparte.

## 10. Verificación

Se completa al cierre con las cifras del gate final, el QA adversarial y las mutaciones (ver el reporte de la fase).

## 11. Deuda y riesgos declarados

- **Cripto-borrado y política de retención de PII** (DEC-013) sin implementar; los originales de evidencia en almacenamiento **no** están cifrados (mitigado: `sensible`, internos, sin extracción, lectura restringida); rotación de claves sin procedimiento documentado.
- Pagos en cuotas/parciales: una obligación = un reporte. Sin tabla de cuotas.
- La idempotencia de nuevas versiones de acuerdo y de guardado de PII es por contenido (sin columna de clave en la base).
- CSV de KPIs, sincronización con Sheets de resultados e integraciones sociales: diferidos; columnas de procedencia de mediciones nulas.
- No hay `retractarEvidencia` en la UI; sin descarga de originales.
- El nav muestra «Editar» (`/brief/editar`) al Operativo aunque el servidor lo niega (deuda heredada de la UI V2 sin integrar).
- Heredadas: gateway del worker sin autenticación, sin límite de tasa por usuario, sin kill-switch por organización, smoke real contra el proveedor y contra Google no ejecutado.

## 12. Contratos listos para la Fase 9

- `ProyeccionTclDeOperacion` + `CLAVES_PROHIBIDAS_TCL` (dominio): lista blanca de lo que TCL podría ver (producto recibido sí/no/parcial, guion aprobado, KPIs objetivo/resultado/cumplimiento); capacidad aparte (`kpi:read_client` reservada, sin asignar).
- `obtenerKpiDeParticipacion().public` es el único bloque apto; `internal` (actor, motivo, procedencia) nunca sale.
- Estado de contenido: leer solo la fila `approved` de cada entregable (F7). Nada financiero, de PII, de costos ni de evidencia llega a TCL; el filtro se hace en el servidor y las secciones sin capacidad ni se consultan.
