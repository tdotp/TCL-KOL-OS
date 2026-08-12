# Cómo trabajar en este repositorio

## Antes de empezar

1. Lee [`TCL_KOL_OS_DOCUMENTO_MAESTRO_EJECUCION.md`](TCL_KOL_OS_DOCUMENTO_MAESTRO_EJECUCION.md) — es la fuente de verdad.
2. Revisa [`docs/decisions/decision-log.md`](docs/decisions/decision-log.md) — evita reabrir decisiones ya cerradas.
3. Ubica tu trabajo en [`docs/product/D0-11-backlog-mvp1.md`](docs/product/D0-11-backlog-mvp1.md).

## Antes de cada commit

```bash
npm run check
```

Lint, typecheck, pruebas y build. Si falla, no está listo.

## Reglas no negociables

Estas no son preferencias de estilo. Cada una sostiene una promesa del producto:

| Regla | Por qué |
|---|---|
| **La IA nunca aprueba** | ADR-002. Propone; una persona decide |
| **Una versión aprobada es inmutable** | ADR-003. Un cambio crea una versión nueva |
| **Siempre existe un camino sin IA** | §5, principio 9. Una falla degrada la asistencia, no bloquea el trabajo |
| **`packages/domain` no importa de `apps/` ni `services/`** | ADR-008. Impuesto por lint |
| **Ninguna credencial en Git** | §27. `.env` está en `.gitignore` |
| **Los logs no llevan prompts, tokens ni PII** | §11.6, caso S-10 |
| **Un claim sin evidencia no llega a `approved`** | §15. Impuesto por guarda, no por advertencia |

## Dónde va cada cosa

| Si estás escribiendo… | Va en |
|---|---|
| Una transición de estado o una regla de permiso | `packages/domain` — **una sola implementación** |
| Parsing, OCR, extracción o embeddings | `services/ai-worker` |
| Interfaz o rutas de API | `apps/web` |
| Un caso de prueba de IA | `fixtures/anonymized/D0-13-gold-set/` |

Si dudas entre `apps/web` y `packages/domain`: si es una **regla**, va en el dominio. Si es **cómo se muestra o se expone**, va en la app.

## Pruebas

Cobertura funcional del **100%** exigida en siete áreas (§27):

transiciones de aprobación · aislamiento entre organizaciones · inmutabilidad de versiones aprobadas · relación evidencia–campo · validación de archivos · fallback manual · cálculo de métricas de evaluación

Cada prueba nueva de una regla de negocio debe referenciar su caso de [`D0-12`](docs/product/D0-12-plan-pruebas.md) en un comentario.

## Decisiones

Si tomas una decisión difícil de revertir, añade un ADR a [`docs/decisions/decision-log.md`](docs/decisions/decision-log.md) con el formato de §38: Fecha · Estado · Contexto · Decisión · Alternativas · Consecuencias · Responsable.

**No crees archivos de ADR aparte.** Hay un solo registro de decisiones.

## Alcance

El agente **no tiene autorización** para ampliar el alcance hacia MVP 2–7 sin una decisión registrada (§22). Si algo parece necesario y no está en el backlog, regístralo como decisión pendiente antes de construirlo.

## Commits

Mensaje en imperativo y en español, referenciando la historia:

```
E5-3 · Extracción estructurada contra el esquema del brief

Implementa la validación de salida contra JSON Schema. Una salida
inválida no se persiste como versión aprobable (§9.4).
```
