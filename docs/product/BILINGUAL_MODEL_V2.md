# Modelo bilingüe V2 — una versión lógica, dos representaciones

Base: `a5ef81c`. Decisión: DEC-043. Migración: `014_modelo_bilingue_v2.sql`.

## 1. Modelo anterior y problema

`brief_versions` tenía una fila por idioma (`UNIQUE (brief_id, language, version)`, `translation_of_id`), cada una con **su propio** `status`, `approved_at` y `parent_version_id`. Era representable `ES = approved` con `EN = draft`, dos aprobaciones y dos linajes. Ningún código creaba filas `en`, pero la estructura contradecía la regla V2:

```
Documento → Versión N → { ES, EN }      Estado único · Aprobación única
```

## 2. Modelo V2

```
Brief
└── Versión lógica N            (= la fila brief_versions de siempre: id, version, status,
    │                             approved_at, parent_version_id, createdBy…)
    ├── Campos / evidencias / revisiones / preguntas / comentarios   (sin duplicar por idioma)
    └── Representaciones        (brief_version_representations, sin estado ni aprobación)
        ├── ES  kind=original
        └── EN  kind=translation | legacy_import
              └── brief_field_translations   valor localizado por campo
                    · provenance_type  translated | manual_local
                    · translator       ai | human | legacy
                    · source_value_hash  huella del valor ORIGINAL al traducir
```

**Por qué esta estructura (y no otra).** La versión lógica ya existe y ya concentra estado, aprobación, linaje, inmutabilidad en BD, auditoría, comentarios y preguntas; añadir el idioma como tabla hija es aditivo y no obliga a mover ni duplicar nada (alternativa «tabla de valores por campo e idioma» habría duplicado el valor original y roto la evidencia). El valor original permanece en `brief_fields.value`: la evidencia que lo respalda respalda también la traducción, sin copias. El patrón (versión lógica + representaciones + valores localizados) es reutilizable por futuros documentos generados, pero **no** se construyó nada para entidades inexistentes.

`ES`/`EN` están acotados por `CHECK`; añadir un idioma es una migración de una línea, no un cambio de arquitectura.

## 3. Invariantes (y dónde se imponen)

| Invariante | Imposición |
|---|---|
| Una sola versión lógica | Trigger: no se insertan filas `brief_versions` con `language <> 'es'` (bypass solo en bases `_test`). |
| Estado único / aprobación única | Las representaciones **no tienen** columnas de estado ni aprobación (test de esquema). La aprobación es `transicionarBrief → approved` sobre la versión lógica. |
| Linaje de la versión lógica | `parent_version_id` en `brief_versions`; congelado por los triggers 009/010. |
| Aprobada ⇒ ES y EN congeladas | Triggers sobre representaciones y traducciones: sin INSERT de traducciones, UPDATE ni DELETE en `approved/superseded/cancelled`. Los campos ya estaban congelados (009). |
| Traducción con origen verificable | `CHECK` + trigger: origen obligatorio, de la **misma versión** y de otro idioma; solo se traducen campos de esa versión; la representación original no admite valores localizados. Guardas de dominio `guardRepresentationsHaveOrigin` (+ `guardTranslationHasOrigin` conservada para el histórico). |
| El idioma no es identidad | `language` de la versión es el idioma original; la identidad es el id/número de la versión lógica. |

## 4. Staleness

La traducción guarda `source_value_hash = brief_value_hash(valor original)`. La vista `brief_translation_sync` (única definición) clasifica cada campo con valor:

- `current` — la huella coincide con el valor original vigente;
- `stale` — el valor original cambió después de traducir;
- `unverified` — traducción sin huella (histórica): no se puede probar que está al día;
- `missing` — sin traducción.

Se compara el **valor**, no la revisión: confirmar un campo no invalida su traducción. No se regenera nada automáticamente (no hay IA de traducción en esta fase).

## 5. Aprobación

Al aprobar (`internal_review → approved`, `client_review → approved` legacy) se exigen, además de las guardas de siempre: `guardRepresentationsHaveOrigin`, `guardRequiredRepresentations` (el original es requerido; el EN pasará a requerirse cuando exista generación de traducciones — `REQUIRED_REPRESENTATION_LANGUAGES`) y `guardTranslationsInSync` (ninguna traducción stale, sin verificar o incompleta). Si **no existe** representación EN todavía, se puede aprobar. DEC-042 y HITL (Fase 1: propuesta → confirmación humana → ejecución atómica) no cambian; la huella de la acción propuesta ahora incluye también las traducciones.

## 6. Versionado

`crearVersionHija` crea la versión N+1 con su representación original (por trigger), copia las traducciones **con su huella tal cual** (no se «blanquea» una traducción desactualizada o sin verificar) y deja el linaje por representación en `copied_from_representation_id`. El padre solo pasa a `superseded`; sus representaciones y traducciones no se tocan.

## 7. Estrategia legacy

Nada se borra ni se actualiza (las filas aprobadas están congeladas). `brief_legacy_en_fold()` — ejecutada en la migración y re-ejecutable — **clasifica** cada fila EN histórica en `brief_legacy_language_links`:

| Caso | Resultado |
|---|---|
| A. Solo ES | Intacta; recibe su representación ES original (backfill). |
| B. ES + EN con el mismo estado y campos con correspondencia exacta | `folded`: el EN se importa como representación `legacy_import` con traducciones `translator=legacy`, **sin huella** (`unverified`). La fila EN histórica se conserva. |
| C. Estados distintos, EN duplicados, campos EN sin pareja | `conflict`: **no se reconcilia ni se elige ganador**; datos intactos y marcados para intervención explícita. |
| EN sin ES de origen válido | `orphan`. |

Una fila EN histórica no es una versión lógica: no se puede transicionar, aprobar ni versionar por separado (`transition()` y `crearVersionHija` la rechazan). Las listas de versiones muestran solo versiones lógicas; las inconsistencias salen por `obtenerVersionLogica().legacyLanguageLinks` (solo personal de SmartPR).

## 8. Contratos de lectura/escritura

- `obtenerVersionLogica(actor, versionId)` → estado único + `representations.{es,en}` (+ sync) + inconsistencias legacy.
- `obtenerRepresentacion(actor, versionId, language)` → campos localizados con procedencia, estado de sincronización y la evidencia original compartida (respeta la visibilidad de Fase 1 para el cliente).
- `registrarTraduccion(actor | 'system', versionId, …)` → crea la representación la primera vez, guarda huella, historial (`brief_field_revisions.accion='translate'`) y auditoría con `origin`/`correlation` (Fase 1).
- `BriefWorkspace.version.representations` (adaptador de lectura; `language` se mantiene por compatibilidad como idioma original).

## 9. Auditoría

`brief.representation.create`, `brief.translation.set`, `brief.create_child_version` (con representaciones copiadas), `brief.transition` (aprobación) — todos por `recordAudit` con origen.

## 10. Riesgos conocidos

- Aprobar exige hoy solo ES (+ EN si existe y está al día). Hacer el EN obligatorio es un cambio de una constante cuando exista la generación de traducciones.
- La granularidad de traducción es por campo; valores estructurados (objetos/arrays) se traducen como un valor completo.
- Datos legacy con `conflict`/`orphan` requieren intervención humana explícita (no hay herramienta todavía).
- `brief_versions.language` y `translation_of_id` se conservan solo por lectura histórica.
- La migración de una base con filas EN reales no se ha probado contra producción (desconocida); sí con escenarios simulados A/B/C, duplicados y huérfanas.
