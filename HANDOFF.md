# Handoff — TCL KOL OS

Estado a **16 de agosto de 2026**. Último commit: `58c3c31`. Árbol limpio.

Este archivo existe para que una sesión nueva pueda continuar sin releer el
historial. No repite lo que ya está en otros documentos: los enlaza.

---

## 1. Qué es esto

Plataforma interna de **SmartPR** para coordinar campañas de influencers/KOL de
**TCL Colombia**. El documento que manda es
[`TCL_KOL_OS_DOCUMENTO_MAESTRO_EJECUCION.md`](TCL_KOL_OS_DOCUMENTO_MAESTRO_EJECUCION.md)
(1380 líneas): visión, 8 MVPs, arquitectura y umbrales de calidad.

El product owner es **Gerardo Calambás**, y también es el único usuario del
piloto. Se trabaja **en español**: código, comentarios, commits, interfaz.

**Regla que define el producto:** el sistema nunca inventa. Un dato que no está
en las fuentes se declara `not_found` y se convierte en una pregunta; una
afirmación sin cita verificable no entra al brief. Todo lo demás es
consecuencia de eso.

---

## 2. Dónde vamos

| Fase | Estado |
|---|---|
| MVP 0 — descubrimiento (D0-01 … D0-16) | ✅ aprobado en su gate |
| Sprint 0 — repositorio, Docker, CI local | ✅ |
| Sprint 1 — identidad, campañas multiproducto, aislamiento | ✅ |
| Sprint 2 — fuentes documentales, cola, parsers | ✅ |
| Sprint 3 — índice vectorial, extracción con evidencia, UI-08/UI-11 | ✅ |
| **Sprint 4 — preguntas locales (Épica E6)** | ⬅️ **siguiente** |

**Pruebas al cierre:** 84 worker (pytest) · 62 integración + 45 dominio
(vitest) · `npm run lint` limpio · `next build` compila.

### Lo que ya funciona de punta a punta

Cargar un documento → parsearlo con su localizador → indexarlo → extraer campos
del brief con cita verificada → revisarlos en pantalla → abrir la fuente de cada
afirmación. Medido contra material real de la campaña **P80** (dos documentos,
14 fragmentos): **9 de 11 campos críticos**, **5 de 5 claims con evidencia
verificada**, ~$0.002 y ~10 s por extracción. Estable en 3 corridas idénticas.

---

## 3. Reglas de arquitectura que no se negocian

Están en [`docs/decisions/decision-log.md`](docs/decisions/decision-log.md),
que es **la única fuente de verdad** para decisiones. Nunca crear archivos ADR
paralelos. Las que más restringen el día a día:

| | Regla |
|---|---|
| **ADR-002** | La IA nunca aprueba. Toda extracción nace en `draft`. |
| **ADR-003** | Una versión aprobada es inmutable — en dominio **y** en trigger de base. |
| **ADR-007 / ADR-009** | Redis no guarda estado de negocio. La cola vive en PostgreSQL con `FOR UPDATE SKIP LOCKED`. |
| **ADR-008** | `packages/domain` no importa de `apps/` ni `services/`. El worker **no decide permisos**: recibe trabajo ya autorizado. |
| **§10.3 regla 7** | El filtro por organización y campaña va **dentro** de la consulta SQL, nunca después. |
| **§12.3** | Un documento `sensible` no entra al índice vectorial. |
| **§11.6** | Los logs y `ai_runs` no guardan prompts, texto ni PII. Solo hashes y metadatos. |

**El corte worker ↔ dominio**, que es el que más fácil se rompe: el worker es el
único que habla con el proveedor de IA (D0-09 §3); el dominio es el único que
decide permisos y persiste. Por eso `POST /extraccion` recibe **los fragmentos
en la petición** en vez de buscarlos por `campaignId`: así el worker nunca tiene
con qué filtrar mal.

---

## 4. Cómo levantarlo (y las trampas)

```bash
docker compose up -d db redis worker consumidor
npm run migrate --workspace @tcl-kol-os/db
npm run dev --workspace @tcl-kol-os/web
```

Cuatro cosas que cuestan una hora si no se saben:

1. **`docker compose up` sin `consumidor` deja la cola sin consumir.** El
   servicio `worker` atiende HTTP; el `consumidor` es el que procesa
   `processing_jobs`. Son dos procesos distintos sobre la misma imagen.
2. **No correr `worker.py` desde el venv local.** Ese intérprete no tiene
   `python-docx` ni `python-pptx`, así que marca los documentos como `fallido`
   sin que el código tenga nada malo. Va dentro del contenedor.
3. **`npm run check` corre `next build`, que pisa el `.next` del servidor de
   desarrollo.** Si la web queda en blanco: `rm -rf apps/web/.next` y reiniciar.
4. **Docker Desktop se cae solo en esta máquina.** Si algo falla con un mensaje
   vacío o raro, comprobar el daemon antes de depurar el código.

La clave de OpenRouter vive **solo** en `.env` (que está en `.gitignore`).
Nunca se pega en el chat ni se commitea. `AI_ENABLED=true` está puesto en el
`.env` local; `.env.example` mantiene `false`, que es lo correcto para un clon
nuevo.

---

## 5. Qué sigue: Sprint 4 — Épica E6, preguntas locales

Es la pieza central del producto, no un mecanismo auxiliar: por DEC-015, cada
campo del formato de SmartPR que no encuentre respuesta se convierte en una
pregunta dirigida al cliente.

| Historia | Qué es |
|---|---|
| **E6-1** | Generar preguntas por campo ausente o en conflicto |
| **E6-2** | UI-09, con el motivo visible en cada pregunta |
| **E6-3** | Responder con autor y fecha |
| **E6-4** | Descartar exigiendo justificación *(la base ya lo impone)* |
| **E6-5** | La respuesta entra como `manual_local`, distinguible de lo extraído |
| **E6-7** | Preguntas según el alcance del campo (DEC-016, campaña vs producto) |

La tabla `local_questions` ya existe (migración 004) con sus dos restricciones
probadas: no se descarta sin justificación, no se responde sin autor.

**Aviso de diseño para UI-09:** con la criticidad de DEC-021, toda campaña va a
generar preguntas desde el primer día. Eso es el comportamiento correcto, no un
fallo — la pantalla no debe presentarlas como si algo hubiera salido mal.

---

## 6. Lo que necesita decisión del product owner

| # | Asunto | Por qué importa |
|---|---|---|
| 1 | **`practico.restricciones` vs `mandatorios`** | Compiten por el mismo contenido («Único canal de venta: Alkosto») y el esquema no dice cuál manda. Hoy el modelo lo pone en `mandatorios` y `restricciones` queda vacío. Decidir antes de cerrar E6. |
| 2 | **`practico.fecha_fin` es crítico y exige fecha exacta** | Las fuentes dan rangos («Octubre-Noviembre 2026»). O el campo admite imprecisión, o cada campaña arranca con esa pregunta. |
| 3 | **¿La aprobación interna se puede revertir?** | Abierta desde el diseño de estados. Necesaria antes del Sprint 5. |

## 7. Bloqueos externos (no dependen del código)

- **Material real de más campañas** — desbloquea los 3 casos `real_derivado` del
  gold set (D0-13 al 57%) y completa D0-14. Es lo único que permite saber si la
  partición en tres niveles de modelo sobra o si el gold set aún no discrimina.
- **Tiempo de ciclo del brief** sigue sin medir (D0-14 §8).
- **Credenciales OIDC** de Google Workspace, y de **Google Drive** (E4-2).
- **OCR** para PNG/JPG (E4-7).

---

## 8. Errores en los que ya caí — para no repetirlos

Están documentados porque cada uno costó tiempo y ninguno era obvio:

1. **Afirmé que el cliente no había mandado dos campos** basándome en la salida
   de la extracción, sin abrir la fuente. Era falso: el dato estaba y la
   extracción lo archivaba en otro campo (DEC-022). **Un `not_found` no prueba
   que el dato no exista mientras nadie haya mirado la fuente.**
2. **Verificar que una cita existe no verifica que el valor se desprenda de
   ella.** El modelo devolvió `2026-11-30` citando «Octubre-Noviembre 2026»:
   cita literal y verificable, día inventado. Para fechas ya se comprueba; para
   texto libre **sigue abierto**.
3. **Una prueba de aislamiento que pasa no prueba nada** si también pasaría con
   el error. Se rompió el filtro a propósito para confirmar que la prueba lo
   detecta. Repetir esa disciplina.
4. **Contar directorios con `parents[3]` se rompe en Docker.** Pasó dos veces,
   en `brief_schema.py` y en `runner.py`.
5. **Un evaluador que busca una palabra en la salida da falsos positivos.** Casi
   reporté que unos modelos obedecían una inyección de prompt cuando solo
   estaban extrayendo el texto correctamente.
6. **De cada diez llamadas al proveedor, ~2 vuelven con JSON partido y
   `finish_reason: stop`.** Hay un reintento; no confundirlo con `max_tokens`.

---

## 9. Mapa rápido del código

```
packages/domain/     Reglas puras. No importa de apps/ ni services/ (ADR-008)
  brief-states.ts      12 estados, 25 transiciones, 4 guardas
  ai-tasks.ts          Tareas → nivel de modelo. Nunca nombres de modelo
  permissions.ts       Qué rol puede qué

packages/db/         Aplica la política del dominio; nunca la redefine
  authz.ts             assertCapability, en un solo sitio
  search.ts            Búsqueda vectorial con el filtro DENTRO de la consulta
  extraction.ts        Llama al worker, valida y persiste; escribe el AIRun

services/ai-worker/  Único que habla con el proveedor de IA
  brief_schema.py      Catálogo de campos leído de D0-05 + criticidad (DEC-021)
  extraction.py        Extracción y verificación literal de citas
  embeddings.py        Indexación; excluye lo sensible (§12.3)
  ai/router.py         Tarea → nivel → modelo configurado

apps/web/            Next.js 15. Server actions en src/lib/actions.ts
infra/db/migrations/ 004_briefs.sql lleva las reglas §9.4 a la base
```

**Documentos clave:** [decision-log](docs/decisions/decision-log.md) ·
[D0-05 brief maestro](docs/product/D0-05-plantilla-brief-maestro.md) ·
[D0-08 modelo de datos](docs/architecture/D0-08-modelo-datos.md) ·
[D0-11 backlog](docs/product/D0-11-backlog-mvp1.md)
