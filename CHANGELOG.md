# Changelog

Formato basado en [Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/).

## [No publicado]

### Sprint 0 — Base del repositorio · 11 de agosto de 2026

Épica E1 del backlog de MVP 1 ([D0-11](docs/product/D0-11-backlog-mvp1.md)).

#### Añadido

- **Monorepo** con npm workspaces según la estructura de §26: `apps/web`, `services/ai-worker`, `packages/{domain,ui,config,evals}` *(E1-1)*.
- **`packages/domain`** — el corazón del sistema *(E1-2)*:
  - Máquina de estados del brief: 12 estados y 26 transiciones, cada una con rol y guardas *(E8-1 adelantada)*.
  - Cuatro guardas que impiden aprobar un claim sin evidencia, avanzar con un conflicto sin resolver, aprobar con preguntas críticas abiertas y crear una traducción huérfana.
  - RBAC por rol con aislamiento entre organizaciones.
  - Errores tipados con código, sin filtrar trazas internas *(§11.6)*.
- **45 pruebas** del dominio, con cobertura funcional del 100% en transiciones de estado, aislamiento entre organizaciones e inmutabilidad de versiones aprobadas *(E13-1, E13-2, E13-3)*.
- **Worker Python** con validación de configuración al arranque y 6 pruebas, incluida una que verifica que los logs no contienen credenciales *(E1-3, caso S-10)*.
- **Docker Compose** con web, worker, PostgreSQL + pgvector y Redis *(E1-4)*.
- **`.env.example`** documentado, sin secretos *(E1-5)*.
- **TypeScript en modo estricto** con `noUncheckedIndexedAccess` y `exactOptionalPropertyTypes` *(E1-2)*.
- **`npm run check`** — lint, typecheck, pruebas y build en un solo comando *(E1-6)*.
- **CI** con tres jobs: dominio y web, worker Python, dependencias y secretos *(E1-7, E1-8)*.
- **Regla de lint de ADR-008**: `packages/domain` no puede importar de `apps/` ni de `services/`. Verificada con un import prohibido real *(E1-10)*.
- **README** con instalación reproducible *(E1-9)*.
- Sondas `/api/health` y `/api/ready` en la aplicación web *(E12-4 adelantada)*.

#### Decisiones registradas

- **ADR-006** — Payload CMS embebido en Next.js, no como servicio separado.
- **ADR-007** — Redis no conserva estado de negocio.
- **ADR-008** — `packages/domain` sin dependencias hacia aplicaciones.
- **DEC-013** — Datos personales de KOL en entidad separada y cifrada, decidido antes de MVP 4.
- **DEC-014** — La compensación de KOL permanece fuera del alcance, en todas las fases.
- **DEC-015** — El brief maestro es un formato propio de SmartPR; los formatos del cliente son entradas.

#### Pendiente

- `docker compose up` sin verificar: Docker no está instalado en la máquina de desarrollo.
- Sin persistencia ni autenticación: llegan en el Sprint 1 (Épicas E2 y E3).
- Sin backup automático: riesgo aceptado en ADR-005.

---

### MVP 0 — Descubrimiento y diseño · 11 de agosto de 2026

Los 16 entregables D0-01 a D0-16. Gate aprobado por el product owner.

- 14 entregables completos, 2 parciales (D0-13 gold set al 57%, D0-14 línea base con 5 de 7 indicadores).
- Esquema del brief validado técnicamente: 6 casos prohibidos se rechazan por construcción.
- Prototipo navegable de 13 pantallas (UI-03 a UI-15).
- Backlog de 58 historias y plan de pruebas de 84 casos.
