-- 019 · Snapshots de fuentes enlazadas y sincronización controlada con Google
-- Sheets (V2 · Fase 5, parte 1).
--
-- Forward-only y aditiva. No modifica ninguna migración anterior ni reescribe un
-- solo dato histórico: las fuentes-archivo, sus fragmentos y la evidencia
-- existentes quedan exactamente como estaban.
--
-- ── Por qué snapshots ──────────────────────────────────────────────────────────
-- Un Google Sheet es MUTABLE. Si «la fuente» fuera solo su contenido actual, al
-- cambiar el Sheet se perdería qué contenido produjo una decisión histórica
-- (un influencer creado, un producto asignado, una evidencia citada). Por eso una
-- fuente enlazada acumula lecturas:
--
--   source_documents (origin = link)
--   ├── source_snapshots  N     lectura concreta, INMUTABLE, con su hash
--   │     ├── source_snapshot_rows   la rejilla (hoja → fila → celdas)
--   │     └── source_fragments       texto localizado (mismo contrato que XLSX)
--   └── current_snapshot_id          la última lectura completa y válida
--
-- Una sincronización nueva NUNCA toca un snapshot anterior: o crea uno nuevo, o
-- (si el contenido es idéntico) no crea nada. La evidencia que cita un fragmento
-- del snapshot 1 sigue apuntando al snapshot 1 aunque exista el 7.
--
-- Los archivos (origin = file) NO cambian: siguen sin snapshots, con su
-- reemplazo idempotente de siempre (E4-10).
--
-- ── Qué NO hay aquí ────────────────────────────────────────────────────────────
-- Credenciales (viven solo en el entorno del worker), tokens, ni ninguna URL con
-- secretos. La integración con Google vive en el worker; la base solo guarda el
-- resultado de la lectura y quién la pidió.

-- ─────────────────────────── Claves de referencia compuestas ───────────────────

-- Para amarrar snapshots, ejecuciones y planes a la MISMA organización y campaña
-- que su fuente, sin cruzar tenants ni campañas ni siquiera por SQL directo.
ALTER TABLE source_documents
  ADD CONSTRAINT source_documents_id_organization_key UNIQUE (id, organization_id),
  ADD CONSTRAINT source_documents_id_campaign_key UNIQUE (id, campaign_id);

-- ─────────────────────────── Snapshots ─────────────────────────────────────────

-- Un snapshot SOLO existe si la lectura terminó completa: se inserta, junto con
-- sus filas y fragmentos, en la misma transacción que lo vuelve `current`. Un
-- intento fallido no deja snapshot (queda en `source_sync_runs`), así que no hay
-- un snapshot «a medias» que pueda confundirse con el último válido.
CREATE TABLE source_snapshots (
  id                uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  source_id         uuid NOT NULL,
  organization_id   uuid NOT NULL,
  -- 1, 2, 3… por fuente. Es el orden de las lecturas, no un número de «versión»
  -- del contenido.
  sequence          integer NOT NULL,
  provider          text NOT NULL,
  fetched_at        timestamptz NOT NULL,
  -- SHA-256 del contenido CANONICALIZADO (hojas, filas y celdas; nunca la fecha
  -- de lectura ni la metadata). Es la autoridad de igualdad de contenido.
  content_hash      text NOT NULL,
  -- Versión del algoritmo de canonicalización: si cambiara, los hashes antiguos
  -- seguirían siendo interpretables.
  hash_version      text NOT NULL,
  -- Revisión que el proveedor declare, si la declara. Google Sheets v4 NO expone
  -- una revisión estable del contenido (haría falta la API de Drive con otro
  -- alcance): hoy es NULL y `content_hash` decide.
  external_revision text,
  -- Metadatos de la lectura (título del libro, pestañas con su gid).
  metadata          jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Manifiesto normalizado (mismo contrato que el de XLSX/CSV).
  structure         jsonb NOT NULL,
  generator         text NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT source_snapshots_source_fkey
    FOREIGN KEY (source_id, organization_id)
    REFERENCES source_documents (id, organization_id) ON DELETE CASCADE,
  CONSTRAINT source_snapshots_sequence_positiva CHECK (sequence >= 1),
  CONSTRAINT source_snapshots_hash_valido CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT source_snapshots_metadata_objeto CHECK (jsonb_typeof(metadata) = 'object'),
  CONSTRAINT source_snapshots_estructura_objeto CHECK (jsonb_typeof(structure) = 'object'),
  CONSTRAINT source_snapshots_sequence_key UNIQUE (source_id, sequence),
  CONSTRAINT source_snapshots_id_source_key UNIQUE (id, source_id),
  CONSTRAINT source_snapshots_id_organization_key UNIQUE (id, organization_id)
);

CREATE INDEX source_snapshots_source_idx ON source_snapshots (source_id, sequence DESC);

-- La rejilla del snapshot: una fila por fila de la hoja con datos. Es lo que
-- permite validar el esquema, reconstruir filas y comparar snapshots sin
-- depender del texto de los fragmentos. `cells` es una lista ordenada por
-- columna: [{"col": 3, "text": "valentina.rojas", "type": "texto"}, …].
CREATE TABLE source_snapshot_rows (
  snapshot_id  uuid NOT NULL REFERENCES source_snapshots(id) ON DELETE CASCADE,
  sheet        text NOT NULL,
  -- Identidad estable de la pestaña en Google (sheetId); el nombre puede cambiar.
  sheet_gid    bigint,
  row_number   integer NOT NULL,
  cells        jsonb NOT NULL,

  CONSTRAINT source_snapshot_rows_pkey PRIMARY KEY (snapshot_id, sheet, row_number),
  CONSTRAINT source_snapshot_rows_fila_positiva CHECK (row_number >= 1),
  CONSTRAINT source_snapshot_rows_celdas_lista CHECK (jsonb_typeof(cells) = 'array')
);

-- ─────────────────────────── Fuente → snapshot vigente ─────────────────────────

ALTER TABLE source_documents ADD COLUMN current_snapshot_id uuid;

-- El snapshot vigente es de ESTA fuente (clave compuesta).
ALTER TABLE source_documents
  ADD CONSTRAINT source_documents_current_snapshot_fkey
    FOREIGN KEY (current_snapshot_id, id)
    REFERENCES source_snapshots (id, source_id),
  -- Solo un enlace tiene snapshots.
  ADD CONSTRAINT source_documents_snapshot_solo_enlaces
    CHECK (current_snapshot_id IS NULL OR origin = 'link');

-- Cambiar el snapshot vigente es atómico (un UPDATE de una columna) y solo avanza:
--   · el nuevo debe tener fragmentos guardados (la lectura terminó completa);
--   · su sequence debe ser MAYOR que la del vigente (no se «vuelve» atrás);
--   · nunca se deja una fuente sin snapshot vigente una vez que lo tuvo.
CREATE OR REPLACE FUNCTION source_documents_snapshot_vigente_valido() RETURNS trigger AS $$
DECLARE
  seq_nuevo    integer;
  seq_vigente  integer;
BEGIN
  IF NEW.current_snapshot_id IS NOT DISTINCT FROM OLD.current_snapshot_id THEN
    RETURN NEW;
  END IF;
  IF NEW.current_snapshot_id IS NULL THEN
    RAISE EXCEPTION 'Una fuente que ya tuvo un snapshot vigente no puede quedarse sin él.';
  END IF;

  SELECT sequence INTO seq_nuevo FROM source_snapshots WHERE id = NEW.current_snapshot_id;
  IF NOT EXISTS (SELECT 1 FROM source_fragments WHERE snapshot_id = NEW.current_snapshot_id) THEN
    RAISE EXCEPTION 'El snapshot % no tiene fragmentos guardados: la lectura no está completa.',
      NEW.current_snapshot_id;
  END IF;
  IF OLD.current_snapshot_id IS NOT NULL THEN
    SELECT sequence INTO seq_vigente FROM source_snapshots WHERE id = OLD.current_snapshot_id;
    IF seq_nuevo <= seq_vigente THEN
      RAISE EXCEPTION 'El snapshot vigente solo avanza (actual %, propuesto %).', seq_vigente, seq_nuevo;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER source_documents_snapshot_vigente
  BEFORE UPDATE OF current_snapshot_id ON source_documents
  FOR EACH ROW EXECUTE FUNCTION source_documents_snapshot_vigente_valido();

-- ─────────────────────────── Fragmentos por snapshot ───────────────────────────

-- Los fragmentos de un enlace cuelgan de su snapshot (NULL = fuente-archivo,
-- como siempre). La clave compuesta garantiza que el snapshot sea de la misma
-- fuente que el fragmento.
ALTER TABLE source_fragments ADD COLUMN snapshot_id uuid;

ALTER TABLE source_fragments
  ADD CONSTRAINT source_fragments_snapshot_fkey
    FOREIGN KEY (snapshot_id, source_id)
    REFERENCES source_snapshots (id, source_id) ON DELETE CASCADE;

-- Antes: UNIQUE (source_id, ordinal) para todos. Ahora cada snapshot numera sus
-- fragmentos desde cero, y los archivos conservan su unicidad por fuente.
ALTER TABLE source_fragments DROP CONSTRAINT source_fragments_ordinal_key;
CREATE UNIQUE INDEX source_fragments_ordinal_archivo_key
  ON source_fragments (source_id, ordinal) WHERE snapshot_id IS NULL;
CREATE UNIQUE INDEX source_fragments_ordinal_snapshot_key
  ON source_fragments (snapshot_id, ordinal) WHERE snapshot_id IS NOT NULL;
CREATE INDEX source_fragments_snapshot_idx ON source_fragments (snapshot_id) WHERE snapshot_id IS NOT NULL;

-- Coherencia por origen: un enlace SOLO tiene fragmentos de snapshot; un archivo
-- nunca.
CREATE OR REPLACE FUNCTION source_fragments_origen_coherente() RETURNS trigger AS $$
DECLARE
  origen source_origin;
BEGIN
  SELECT origin INTO origen FROM source_documents WHERE id = NEW.source_id;
  IF origen = 'link' AND NEW.snapshot_id IS NULL THEN
    RAISE EXCEPTION 'Los fragmentos de una fuente enlazada pertenecen a un snapshot.';
  END IF;
  IF origen = 'file' AND NEW.snapshot_id IS NOT NULL THEN
    RAISE EXCEPTION 'Una fuente-archivo no tiene snapshots.';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER source_fragments_origen
  BEFORE INSERT ON source_fragments
  FOR EACH ROW EXECUTE FUNCTION source_fragments_origen_coherente();

-- ─────────────────────────── Inmutabilidad histórica ───────────────────────────

-- Reutiliza `inmutabilidad_bypass_activo()` (009/010): la única salida es una base
-- `_test` con la bandera de sesión, usada por la limpieza de las pruebas.

CREATE OR REPLACE FUNCTION source_snapshots_inmutable() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF inmutabilidad_bypass_activo() THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'Un snapshot no se borra: es la prueba de qué contenido produjo cada decisión.';
  END IF;
  RAISE EXCEPTION 'Un snapshot no se modifica: una nueva lectura crea otro snapshot.';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER source_snapshots_sin_cambios
  BEFORE UPDATE OR DELETE ON source_snapshots
  FOR EACH ROW EXECUTE FUNCTION source_snapshots_inmutable();

CREATE OR REPLACE FUNCTION source_snapshot_rows_inmutable() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF inmutabilidad_bypass_activo() THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'Las filas de un snapshot no se borran.';
  END IF;
  RAISE EXCEPTION 'Las filas de un snapshot no se modifican.';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER source_snapshot_rows_sin_cambios
  BEFORE UPDATE OR DELETE ON source_snapshot_rows
  FOR EACH ROW EXECUTE FUNCTION source_snapshot_rows_inmutable();

-- Los fragmentos de un snapshot no se reescriben ni se borran. Única excepción:
-- el índice vectorial (`embedding`) se calcula DESPUÉS de guardar el snapshot y
-- no es contenido (es derivable). Los fragmentos de archivos mantienen su
-- comportamiento de siempre (reemplazo idempotente al reprocesar).
CREATE OR REPLACE FUNCTION source_fragments_snapshot_inmutable() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.snapshot_id IS NULL OR inmutabilidad_bypass_activo() THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'Los fragmentos de un snapshot no se borran.';
  END IF;

  IF OLD.snapshot_id IS NULL AND NEW.snapshot_id IS NULL THEN RETURN NEW; END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.source_id IS DISTINCT FROM OLD.source_id
     OR NEW.snapshot_id IS DISTINCT FROM OLD.snapshot_id
     OR NEW.ordinal IS DISTINCT FROM OLD.ordinal
     OR NEW.page IS DISTINCT FROM OLD.page
     OR NEW.slide IS DISTINCT FROM OLD.slide
     OR NEW.section IS DISTINCT FROM OLD.section
     OR NEW.linea IS DISTINCT FROM OLD.linea
     OR NEW.locator IS DISTINCT FROM OLD.locator
     OR NEW.text IS DISTINCT FROM OLD.text
     OR NEW.metadata IS DISTINCT FROM OLD.metadata
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'Los fragmentos de un snapshot no se modifican (solo su índice vectorial).';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER source_fragments_snapshot_sin_cambios
  BEFORE UPDATE OR DELETE ON source_fragments
  FOR EACH ROW EXECUTE FUNCTION source_fragments_snapshot_inmutable();

-- ─────────────────────────── Jobs: tipo controlado ─────────────────────────────

-- Hasta ahora un trigger impedía CUALQUIER job sobre una fuente enlazada
-- (`processing_jobs_solo_archivos`, 018). No se elimina «para que el worker haga
-- fetch de lo que haya en external_url»: se sustituye por una regla que admite
-- ÚNICAMENTE el par (tipo de job, proveedor) autorizado:
--
--   source_ingest_file   →  fuente con origin = file          (como siempre)
--   google_sheet_sync    →  fuente con origin = link Y external_provider = google_sheets
--
-- Cualquier otro enlace (Docs, Slides, Drive…) sigue sin poder encolar nada.
ALTER TABLE processing_jobs
  ADD COLUMN kind text NOT NULL DEFAULT 'source_ingest_file',
  ADD CONSTRAINT processing_jobs_kind_valido
    CHECK (kind IN ('source_ingest_file', 'google_sheet_sync'));

DROP TRIGGER processing_jobs_solo_archivos ON processing_jobs;
DROP FUNCTION processing_jobs_solo_archivos();

CREATE OR REPLACE FUNCTION processing_jobs_tipo_coherente() RETURNS trigger AS $$
DECLARE
  origen   source_origin;
  proveedor text;
BEGIN
  SELECT origin, external_provider INTO origen, proveedor
    FROM source_documents WHERE id = NEW.source_id;

  IF NEW.kind = 'source_ingest_file' AND origen = 'file' THEN
    RETURN NEW;
  END IF;
  IF NEW.kind = 'google_sheet_sync' AND origen = 'link' AND proveedor = 'google_sheets' THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION
    'No hay procesamiento «%» para esta fuente: las fuentes enlazadas solo se sincronizan mediante una integración autorizada (Google Sheets) y los archivos se ingieren como siempre.',
    NEW.kind;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER processing_jobs_tipo_coherente
  BEFORE INSERT OR UPDATE OF kind, source_id ON processing_jobs
  FOR EACH ROW EXECUTE FUNCTION processing_jobs_tipo_coherente();

-- ─────────────────────────── Ejecuciones de sincronización ─────────────────────

-- Estado TÉCNICO de una sincronización (no el de negocio de la importación):
--   queued → running → completed (snapshot nuevo) | unchanged (mismo contenido) | failed
-- Un fallo queda aquí con su código sanitizado; NUNCA toca el snapshot vigente.
-- `initiated_by` es siempre una persona: el worker lee Google, pero no finge ser
-- quien decidió importar.
CREATE TABLE source_sync_runs (
  id               uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id  uuid NOT NULL,
  source_id        uuid NOT NULL,
  job_id           uuid NOT NULL UNIQUE REFERENCES processing_jobs(id) ON DELETE CASCADE,
  status           text NOT NULL DEFAULT 'queued',
  initiated_by     uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  correlation      jsonb,
  -- completed: el snapshot creado · unchanged: el vigente con el que coincidió.
  snapshot_id      uuid,
  error_code       text,
  error_message    text,
  requested_at     timestamptz NOT NULL DEFAULT now(),
  started_at       timestamptz,
  finished_at      timestamptz,

  CONSTRAINT source_sync_runs_source_fkey
    FOREIGN KEY (source_id, organization_id)
    REFERENCES source_documents (id, organization_id) ON DELETE CASCADE,
  CONSTRAINT source_sync_runs_snapshot_fkey
    FOREIGN KEY (snapshot_id, source_id)
    REFERENCES source_snapshots (id, source_id),
  CONSTRAINT source_sync_runs_estado_valido
    CHECK (status IN ('queued', 'running', 'completed', 'unchanged', 'failed')),
  CONSTRAINT source_sync_runs_resultado_coherente CHECK (
    (status IN ('completed', 'unchanged') AND snapshot_id IS NOT NULL AND error_code IS NULL)
    OR (status = 'failed' AND error_code IS NOT NULL AND snapshot_id IS NULL)
    OR (status IN ('queued', 'running') AND snapshot_id IS NULL AND error_code IS NULL)
  ),
  CONSTRAINT source_sync_runs_cierre_coherente CHECK (
    (status IN ('queued', 'running')) = (finished_at IS NULL)
  )
);

CREATE INDEX source_sync_runs_source_idx ON source_sync_runs (source_id, requested_at DESC);

-- Como máximo UNA sincronización activa por fuente (el job activo ya lo impone
-- `processing_jobs_activo_key`; esto lo hace explícito en la propia ejecución).
CREATE UNIQUE INDEX source_sync_runs_activa_key
  ON source_sync_runs (source_id) WHERE status IN ('queued', 'running');

-- La ejecución solo puede colgar de un job de sincronización de la MISMA fuente.
CREATE OR REPLACE FUNCTION source_sync_runs_job_coherente() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM processing_jobs
     WHERE id = NEW.job_id AND source_id = NEW.source_id AND kind = 'google_sheet_sync'
  ) THEN
    RAISE EXCEPTION 'La ejecución de sincronización debe colgar de un job google_sheet_sync de la misma fuente.';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER source_sync_runs_job
  BEFORE INSERT ON source_sync_runs
  FOR EACH ROW EXECUTE FUNCTION source_sync_runs_job_coherente();

-- Los estados terminales no se reescriben; la identidad de la ejecución nunca.
CREATE OR REPLACE FUNCTION source_sync_runs_inmutable() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF inmutabilidad_bypass_activo() THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'Una ejecución de sincronización no se borra.';
  END IF;

  IF OLD.status IN ('completed', 'unchanged', 'failed') THEN
    RAISE EXCEPTION 'La ejecución de sincronización ya terminó (%): no se modifica.', OLD.status;
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
     OR NEW.source_id IS DISTINCT FROM OLD.source_id
     OR NEW.job_id IS DISTINCT FROM OLD.job_id
     OR NEW.initiated_by IS DISTINCT FROM OLD.initiated_by
     OR NEW.correlation IS DISTINCT FROM OLD.correlation
     OR NEW.requested_at IS DISTINCT FROM OLD.requested_at THEN
    RAISE EXCEPTION 'La identidad de una ejecución de sincronización no se modifica.';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER source_sync_runs_sin_cambios
  BEFORE UPDATE OR DELETE ON source_sync_runs
  FOR EACH ROW EXECUTE FUNCTION source_sync_runs_inmutable();

COMMENT ON TABLE source_snapshots IS
  'Lectura inmutable de una fuente enlazada mutable (Google Sheet). Nace completa o no nace.';
COMMENT ON TABLE source_sync_runs IS
  'Estado técnico de una sincronización (quién la pidió, qué produjo o por qué falló). No es el estado de negocio de la importación.';
