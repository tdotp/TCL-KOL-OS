# TCL KOL OS

Plataforma interna de SmartPR para coordinar campañas de influencers (KOL) de TCL, desde la recepción de la estrategia global hasta el cierre y medición de cada campaña.

**Estado:** MVP 1 · Sprint 2 completado (fuentes documentales procesándose en segundo plano)
**Documento rector:** [`TCL_KOL_OS_DOCUMENTO_MAESTRO_EJECUCION.md`](TCL_KOL_OS_DOCUMENTO_MAESTRO_EJECUCION.md)

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
| **Node.js** | ≥ 20 | Sí |
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

Es el corazón del sistema y lo único que está completo en el Sprint 0.

| Módulo | Contenido |
|---|---|
| `types.ts` | Entidades canónicas del modelo de datos (D0-08) |
| `brief-states.ts` | Máquina de estados: 12 estados, 25 transiciones, 4 guardas |
| `permissions.ts` | RBAC por rol y aislamiento entre organizaciones |
| `errors.ts` | Errores tipados con código, sin filtrar trazas internas |

**45 pruebas cubren las tres áreas que §27 exige al 100%:** transiciones de estado, aislamiento entre organizaciones e inmutabilidad de versiones aprobadas.

Cuatro guardas hacen que los umbrales del §15 no dependan de la disciplina de nadie:

| Guarda | Qué impide |
|---|---|
| `guardClaimsHaveEvidence` | Aprobar un claim sin fuente citada |
| `guardNoUnresolvedConflicts` | Avanzar con una contradicción entre fuentes sin resolver |
| `guardNoPendingCriticalQuestions` | Aprobar con preguntas críticas abiertas |
| `guardTranslationHasOrigin` | Crear una traducción huérfana |

---

## Configuración relevante

| Variable | Efecto |
|---|---|
| `AI_ENABLED` | `false` por defecto. Apagado, el sistema opera en **modo manual**: se crea, edita, versiona, aprueba y exporta un brief sin ninguna llamada a un modelo |
| `MAX_UPLOAD_MB` | Tamaño máximo de fuente. 50 MB por defecto |
| `AI_PROVIDER` | Obligatorio solo si `AI_ENABLED=true`. El adaptador aísla la elección |

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

**Sprint 3 — extracción** (Épicas E5 y E11): fragmentos con embeddings, extracción estructurada contra el esquema del brief, evidencia por campo y el harness de IA con sus adaptadores.

Demo esperada: un claim extraído que **abre su diapositiva de origen**.
