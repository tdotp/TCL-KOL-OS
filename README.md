# TCL KOL OS

Plataforma interna de SmartPR para coordinar campañas de influencers (KOL) de TCL, desde la recepción de la estrategia global hasta el cierre y medición de cada campaña.

**Estado:** MVP 1 · cierre de Sprint 5 (ciclo completo del brief: de `internal_review` a `approved` — comentarios internos, fechas estructuradas, aprobación interna, revisión y decisión del cliente, versionado posterior a aprobación)
**Documento rector:** [`TCL_KOL_OS_DOCUMENTO_MAESTRO_EJECUCION.md`](TCL_KOL_OS_DOCUMENTO_MAESTRO_EJECUCION.md)
**Estado de V2 y por dónde continuar (rama `v2`):** [`docs/README.md`](docs/README.md) — el estado de arriba es de Sprint 5; el actual está en [`docs/project/V2_CURRENT_STATE.md`](docs/project/V2_CURRENT_STATE.md)

---

## Qué hace

Convierte el material heterogéneo que llega de TCL China y de TCL Colombia en un **brief local bilingüe, versionado y con evidencia verificable**, en el formato propio de SmartPR.

```
Material del cliente + PPT de China (variable, no controlado)
        ↓
El sistema pregunta lo que el formato de SmartPR necesita
        ↓
La IA busca las respuestas en el material, citando su fuente
        ↓
Lo que no encuentra se pregunta a una persona
        ↓
Brief en el formato de SmartPR, ES y EN, con trazabilidad completa
```

**Tres reglas que el código impone, no sugiere:**

1. **La IA nunca aprueba.** Propone; una persona decide (ADR-002).
2. **Un brief aprobado es inmutable.** Un cambio crea una versión nueva (ADR-003).
3. **Siempre existe un camino sin IA.** Una caída del proveedor degrada la asistencia, nunca bloquea el trabajo.

---

## Requisitos

| Herramienta | Versión | ¿Obligatoria? |
|---|---|---|
| **Node.js** | ≥ 22.6 | Sí — `packages/db`'s `migrate`/`seed` usan `node --experimental-strip-types` |
| **npm** | ≥ 10 | Sí |
| **Docker Desktop** | >= 29 | Para levantar el sistema completo |
| **Python** | ≥ 3.9 local · 3.11 en contenedor | Solo para trabajar el worker sin Docker |

---

## Puesta en marcha

### 1. Configuración

```bash
cp .env.example .env
```

Los valores por defecto sirven para desarrollo local. **`.env` nunca se sube al repositorio.**

### 2. Dependencias

```bash
npm install
```

### 3. Verificación

```bash
npm run check
```

Ejecuta lint, typecheck, pruebas y build. Si esto pasa, el entorno está bien.

### 4. Levantar el sistema

Con Docker — todo el sistema:

```bash
docker compose up
```

| Servicio | URL |
|---|---|
| Aplicación web | <http://localhost:3000> |
| Worker (API) | <http://localhost:8000/health> |
| PostgreSQL + pgvector | `localhost:5432` |
| Redis | `localhost:6379` |

Sin Docker — solo la aplicación web:

```bash
npm run dev
```

---

## Comandos

| Comando | Qué hace |
|---|---|
| `npm run check` | Lint + typecheck + pruebas + build. **El que importa.** |
| `npm run dev` | Servidor de desarrollo de la aplicación web |
| `npm test` | Pruebas de todos los paquetes |
| `npm run lint` | ESLint, incluida la regla de frontera de ADR-008 |
| `npm run typecheck` | TypeScript en modo estricto |
| `npm run format` | Prettier sobre todo el repositorio |

Pruebas del worker Python:

```bash
cd services/ai-worker && python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
cd services/ai-worker && PYTHONPATH=. .venv/bin/python -m pytest tests/ -q
```

---

## Estructura

```
apps/web/                Portal de agencia, vista de TCL, API de dominio (Next.js)
services/ai-worker/      Parsing, OCR, extracción, RAG, traducción (Python + FastAPI)
packages/
  domain/                Tipos, estados, permisos y reglas de negocio
  ui/                    Componentes compartidos
  config/                Configuración compartida
  evals/                 Gold set y métricas de IA
infra/db/init/           Extensiones de PostgreSQL
docs/                    Entregables de MVP 0, arquitectura y decisiones
fixtures/anonymized/     Casos de prueba del gold set
```

### La regla de dependencia

`apps/web` y `services/ai-worker` dependen de `packages/domain`. **`packages/domain` no depende de ninguno de los dos** (ADR-008).

Las transiciones de estado y las reglas de permiso tienen **una sola implementación**, y vive en el dominio. Una regla corregida en la interfaz pero olvidada en el worker produciría estados inválidos persistidos — por eso la frontera está impuesta por lint, no por convención:

```bash
npm run lint   # falla si packages/domain importa de apps/ o services/
```

---

## El paquete de dominio

Es el corazón del sistema: reglas puras, sin I/O, que `packages/db` aplica y `apps/web`/`services/ai-worker` nunca reimplementan.

| Módulo | Contenido |
|---|---|
| `types.ts` | Entidades canónicas del modelo de datos (D0-08) |
| `brief-states.ts` | Máquina de estados: 12 estados, ~25 transiciones, 9 guardas |
| `brief-catalog.ts` | Catálogo único de los 41 campos del brief (DEC-021), compartido con el worker Python |
| `permissions.ts` | RBAC por rol y aislamiento entre organizaciones |
| `errors.ts` | Errores tipados con código, sin filtrar trazas internas |

**61 pruebas de dominio** cubren transiciones de estado, aislamiento entre organizaciones e inmutabilidad de versiones aprobadas (§27).

Nueve guardas hacen que los umbrales del §15 no dependan de la disciplina de nadie:

| Guarda | Qué impide |
|---|---|
| `guardClaimsHaveEvidence` | Aprobar un claim sin fuente citada |
| `guardNoUnresolvedConflicts` | Avanzar con una contradicción entre fuentes sin resolver |
| `guardNoPendingCriticalQuestions` | Aprobar con preguntas críticas abiertas |
| `guardTranslationHasOrigin` | Crear una traducción huérfana |
| `guardCriticalFieldsResolved` | Pasar a revisión interna con campos críticos sin resolver |
| `guardProductFieldsAnchored` | Pasar a revisión interna con un campo de producto sin `campaign_product_id` |
| `guardAllFieldsReviewed` | Pasar a revisión interna con un campo extraído que nadie confirmó ni corrigió |
| `guardNoPendingQuestions` | Volver de `local_questions` con alguna pregunta sin responder ni descartar |

---

## Pruebas de integración (`packages/db`)

Corren contra Postgres real — nunca contra mocks. Necesitan una base **separada** de la de desarrollo, exigida por el candado de [INC-001](docs/incidents/INC-001-test-data-collision.md):

```bash
docker exec tclkolos-db psql -U tclkolos -d postgres -c "CREATE DATABASE tclkolos_test"
docker exec tclkolos-db psql -U tclkolos -d tclkolos_test -f /docker-entrypoint-initdb.d/01-extensions.sql
DATABASE_URL=postgresql://tclkolos:devpassword@localhost:5432/tclkolos_test npm run migrate --workspace @tcl-kol-os/db
DATABASE_URL=postgresql://tclkolos:devpassword@localhost:5432/tclkolos_test npm run seed --workspace @tcl-kol-os/db
```

`TEST_DATABASE_URL` (ya en `.env.example`) debe apuntar ahí, con el nombre
terminado en `_test`. `packages/db/vitest.setup.ts` se niega a arrancar si
falta o si el nombre no cumple esa convención — no hay fallback silencioso
hacia la base de desarrollo.

```bash
TEST_DATABASE_URL=postgresql://tclkolos:devpassword@localhost:5432/tclkolos_test npm test --workspace @tcl-kol-os/db
```

`AI_PROVIDER=fake` (`services/ai-worker/app/ai/fake_provider.py`) es un
proveedor determinístico, sin red ni costo, **exclusivo de pruebas
automatizadas**. Nunca se usa en demos ni en producción; solo lo detecta el
recorrido end-to-end (`end-to-end.test.ts`) cuando hay un worker levantado
con esa variable, y se omite en silencio si no lo hay.

---

## Configuración relevante

| Variable | Efecto |
|---|---|
| `AI_ENABLED` | `false` por defecto. Apagado, el sistema opera en **modo manual**: se crea, edita, versiona, aprueba y exporta un brief sin ninguna llamada a un modelo |
| `MAX_UPLOAD_MB` | Tamaño máximo de fuente. 50 MB por defecto |
| `AI_PROVIDER` | Obligatorio solo si `AI_ENABLED=true`. El adaptador aísla la elección. `fake` es un valor especial, determinístico y sin red — exclusivo de pruebas automatizadas, nunca de demos ni producción |
| `TEST_DATABASE_URL` | Base separada para `packages/db`'s pruebas de integración. Nombre debe terminar en `_test`; sin fallback hacia `DATABASE_URL` |
| `BRIEF_WORKSPACE_V2` | `false`/ausente por defecto. En `true`, activa `/campanas/[id]/brief/workspace` (Sprint 6) — tres modos (Completar/Revisar brief/Actividad) sobre el mismo dominio. Apagada, esa ruta reenvía a `/brief/editar` sin cambiar nada del flujo anterior |
| `E2E_DATABASE_URL` | Base `_test` aislada para `apps/e2e` (Playwright, Sprint 6 Checkpoint 2). Mismo candado que `TEST_DATABASE_URL`: el nombre debe terminar en `_test` |

Todas las variables están documentadas en [`.env.example`](.env.example).

---

## Documentación

| Tema | Documento |
|---|---|
| Decisiones tomadas y por qué | [`docs/decisions/decision-log.md`](docs/decisions/decision-log.md) |
| Arquitectura y diagramas C4 | [`docs/architecture/D0-09-arquitectura.md`](docs/architecture/D0-09-arquitectura.md) |
| Seguridad y continuidad | [`docs/security/D0-09-seguridad-continuidad.md`](docs/security/D0-09-seguridad-continuidad.md) |
| Modelo de datos | [`docs/architecture/D0-08-modelo-datos.md`](docs/architecture/D0-08-modelo-datos.md) |
| Esquema del brief | [`docs/product/D0-05-plantilla-brief-maestro.md`](docs/product/D0-05-plantilla-brief-maestro.md) |
| Backlog de MVP 1 | [`docs/product/D0-11-backlog-mvp1.md`](docs/product/D0-11-backlog-mvp1.md) |
| Plan de pruebas | [`docs/product/D0-12-plan-pruebas.md`](docs/product/D0-12-plan-pruebas.md) |
| Roles y permisos | [`docs/product/D0-07-matriz-roles-permisos.md`](docs/product/D0-07-matriz-roles-permisos.md) |
| Prototipo navegable | [`docs/product/D0-10-prototipo/index.html`](docs/product/D0-10-prototipo/index.html) |
| Estado del proyecto para retomar sesión | [`HANDOFF.md`](HANDOFF.md) |
| Cierre de Sprint 6 — Fase B+C + Checkpoint 2 (Brief Workspace: contrato, tres modos, Playwright) | [`docs/product/D0-19-cierre-sprint6.md`](docs/product/D0-19-cierre-sprint6.md) |
| Cierre de Sprint 5 (matriz de requisitos, ciclo de aprobación) | [`docs/product/D0-18-cierre-sprint5.md`](docs/product/D0-18-cierre-sprint5.md) |
| Cierre de Sprint 4 (brief hasta `internal_review`) | [`docs/product/D0-17-cierre-sprint4.md`](docs/product/D0-17-cierre-sprint4.md) |
| Incidente de datos de prueba (INC-001) | [`docs/incidents/INC-001-test-data-collision.md`](docs/incidents/INC-001-test-data-collision.md) |

---

## Limitaciones conocidas

| Limitación | Detalle |
|---|---|
| **Sin backup automático** | Riesgo aceptado en ADR-005 mientras el sistema corra en local. Mitigación mínima: `pg_dump` manual antes de cada sesión |
| **OIDC no conectado** | El adaptador está listo; faltan las credenciales de Google Workspace. En desarrollo se usa `AUTH_PROVIDER=dev` |
| **Google Drive no conectado** | La interfaz de almacenamiento está lista; en desarrollo los originales van al sistema de archivos |
| **Sin OCR** | Las imágenes y los PDF escaneados se conservan pero no se extraen (E4-7) |
| **Tiempo de ciclo del brief sin línea base** | Ver [`D0-14`](docs/product/D0-14-linea-base.md) §8 |

---

## Siguiente incremento

Exportación, traducción, OCR, Google Drive, OIDC y CRM de influencers — ver [`HANDOFF.md`](HANDOFF.md) §5 para el corte exacto de alcance. El ciclo de aprobación completo (DEC-027) ya está implementado — ver [`D0-18`](docs/product/D0-18-cierre-sprint5.md).
