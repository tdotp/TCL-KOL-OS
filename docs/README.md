# Documentación de TCL KOL OS

> **Si vas a continuar el desarrollo de V2, lee en este orden.** La rama de trabajo es `v2` (no `main`).

## Leer primero (V2)

1. [Workflow funcional V2](product/TCL_KOL_OS_V2_WORKFLOW_FUNCIONAL.md) — qué hace cada usuario (Cuenta, Operativo, TCL), qué ve y qué no. Fuente funcional aprobada; no se reinterpreta.
2. [Estado técnico actual](project/V2_CURRENT_STATE.md) — rama, tag, migraciones, decisiones, roadmap, baseline de pruebas, entorno, deudas y reglas.
3. [Handoff de la Fase 8](handoffs/HANDOFF-Fase-8.md) — punto de partida de «Operación + KPIs»: invariantes congeladas, lo que dejó la F7 y la intención de la F8.
4. [Registro de decisiones](decisions/decision-log.md) — DEC-042 a DEC-048 gobiernan V2 (cliente de solo lectura, bilingüe, Influencer/CampaignInfluencer, fuentes y Sheets, chat y agente, contenido).
5. [Política de ejecución con agentes](project/AGENT_EXECUTION_POLICY.md) — subagentes, modelo/esfuerzo, QA adversarial, Git y la regla anti-duplicación.

## Notas técnicas por área (V2)

| Área | Documento | Decisión |
|---|---|---|
| Modelo bilingüe | [BILINGUAL_MODEL_V2](product/BILINGUAL_MODEL_V2.md) | DEC-043 |
| Cliente de solo lectura | [CLIENT_WORKFLOW_CORRECTION](product/CLIENT_WORKFLOW_CORRECTION.md) | DEC-042 |
| Influencer y participación | [INFLUENCER_MODEL_V2](product/INFLUENCER_MODEL_V2.md) | DEC-044 |
| Ingestión de hojas y fuentes enlazadas | [INGESTION_SPREADSHEETS_V2](product/INGESTION_SPREADSHEETS_V2.md) | DEC-045 |
| Contrato del Google Sheet de influencers | [INFLUENCER_SHEET_V1](product/INFLUENCER_SHEET_V1.md) | DEC-046 |
| Importación desde Google Sheets | [GOOGLE_SHEETS_IMPORT_V2](product/GOOGLE_SHEETS_IMPORT_V2.md) | DEC-046 |
| Chat y agente de Cuenta | [CHAT_AGENT_V2](product/CHAT_AGENT_V2.md) | DEC-047 |
| Contenido: entregables, guiones, revisión, aprobación | [CONTENT_V2](product/CONTENT_V2.md) | DEC-048 |

## Contexto y base (anteriores a V2; algunos describen el modelo previo)

- [Documento maestro de ejecución](../TCL_KOL_OS_DOCUMENTO_MAESTRO_EJECUCION.md) y [README del proyecto](../README.md) — visión, requisitos y cómo levantar el sistema (el estado del README es de Sprint 5: ver `V2_CURRENT_STATE`).
- Descubrimiento y diseño D0: [`product/D0-*`](product/), [arquitectura](architecture/D0-09-arquitectura.md), [modelo de datos](architecture/D0-08-modelo-datos.md), [seguridad y continuidad](security/D0-09-seguridad-continuidad.md). Los D0-03/07/08/12/18/19 describen el modelo **anterior** a V2 y quedan superados por las DEC-042 a 048.
- [`HANDOFF.md`](../HANDOFF.md) (24-sep) está **desactualizado** respecto de V2: histórico.
- Catálogo de campos del Brief: [`product/brief-schema/`](product/brief-schema/). Contrato del análisis de guiones (fixtures compartidos Node/Python): [`product/content-analysis/`](product/content-analysis/).
- Rediseño de UI (frontend, en paralelo): [`UI_REDESIGN_V3_HANDOFF`](product/UI_REDESIGN_V3_HANDOFF.md).
- Incidentes: [`incidents/`](incidents/).
