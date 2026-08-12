-- 002 · Fuentes documentales, fragmentos y cola de procesamiento.
--
-- Implementa `docs/architecture/D0-08-modelo-datos.md` §2.5 y §2.6, y la Épica
-- E4 del backlog.
--
-- Decisión de diseño (ADR-007): la cola vive en PostgreSQL, no en Redis.
-- Redis solo contiene trabajo en tránsito; si se pierde, no se pierde
-- información. Un job pendiente debe sobrevivir a la caída de la cola, y eso
-- solo se garantiza si su estado está en la base.

CREATE TYPE source_type AS ENUM (
  'ppt_global',      -- material de campaña de TCL China
  'ficha_tecnica',   -- especificaciones; respalda los claims
  'brief_cliente',   -- brief que entrega TCL Colombia
  'imagen',
  'otro'
);

CREATE TYPE source_status AS ENUM ('pendiente', 'procesando', 'procesado', 'fallido');
CREATE TYPE storage_provider AS ENUM ('local', 'drive', 's3');

-- ─────────────────────────── Documentos fuente ───────────────────────────────

CREATE TABLE source_documents (
  id                     uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  campaign_id            uuid NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  organization_id        uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  type                   source_type NOT NULL DEFAULT 'otro',
  filename               text NOT NULL,
  -- Referencia estable al archivo. §10.3, regla 5: NUNCA el nombre.
  -- Renombrar el archivo en Drive no puede romper la trazabilidad.
  file_id                text NOT NULL,
  storage_provider       storage_provider NOT NULL DEFAULT 'local',
  mime_type              text NOT NULL,
  size_bytes             bigint NOT NULL,
  -- SHA-256 del original. Detecta duplicados y cambios (E4-3).
  hash                   text NOT NULL,
  language               text,
  version                integer NOT NULL DEFAULT 1,
  status                 source_status NOT NULL DEFAULT 'pendiente',
  confidentiality_level  confidentiality_level NOT NULL DEFAULT 'interna',
  visibility             visibility_level NOT NULL DEFAULT 'interna',
  created_by             uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at             timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT source_documents_size_positivo CHECK (size_bytes > 0)
);

CREATE INDEX source_documents_campaign_idx ON source_documents (campaign_id);
CREATE INDEX source_documents_org_idx ON source_documents (organization_id);

-- El mismo archivo no se carga dos veces en la misma campaña.
CREATE UNIQUE INDEX source_documents_hash_campaign_key ON source_documents (campaign_id, hash);

-- ─────────────────────────── Fragmentos ──────────────────────────────────────

-- Cada fragmento sabe de qué página o diapositiva salió. Sin esa localización
-- no se puede citar una evidencia verificable (§9.3, §9.4).
CREATE TABLE source_fragments (
  id           uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  source_id    uuid NOT NULL REFERENCES source_documents(id) ON DELETE CASCADE,
  ordinal      integer NOT NULL,
  page         integer,
  slide        integer,
  section      text,
  text         text NOT NULL,
  metadata     jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Los embeddings llegan en el Sprint 3; la columna se crea ya para no
  -- migrar la tabla con datos dentro.
  embedding    vector(1536),
  created_at   timestamptz NOT NULL DEFAULT now(),

  -- Un fragmento sin ubicación no sirve como evidencia.
  CONSTRAINT source_fragments_localizado CHECK (page IS NOT NULL OR slide IS NOT NULL),
  -- Idempotencia (E4-10): reprocesar no duplica fragmentos.
  CONSTRAINT source_fragments_ordinal_key UNIQUE (source_id, ordinal)
);

CREATE INDEX source_fragments_source_idx ON source_fragments (source_id);

-- ─────────────────────────── Cola de procesamiento ───────────────────────────

CREATE TYPE job_status AS ENUM ('pendiente', 'ejecutando', 'completado', 'fallido');

CREATE TABLE processing_jobs (
  id             uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  source_id      uuid NOT NULL REFERENCES source_documents(id) ON DELETE CASCADE,
  status         job_status NOT NULL DEFAULT 'pendiente',
  intentos       integer NOT NULL DEFAULT 0,
  max_intentos   integer NOT NULL DEFAULT 3,
  -- Backoff: el job no se vuelve a tomar antes de esta hora (E4-10).
  disponible_en  timestamptz NOT NULL DEFAULT now(),
  error          text,
  started_at     timestamptz,
  finished_at    timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT processing_jobs_intentos_validos CHECK (intentos >= 0 AND intentos <= max_intentos + 1)
);

-- Índice del consumidor: los jobs tomables, en orden de llegada.
CREATE INDEX processing_jobs_tomables_idx
  ON processing_jobs (disponible_en, created_at)
  WHERE status = 'pendiente';

CREATE INDEX processing_jobs_source_idx ON processing_jobs (source_id);

-- Un documento no puede tener dos jobs activos a la vez: encolar dos veces el
-- mismo trabajo es el origen clásico de fragmentos duplicados.
CREATE UNIQUE INDEX processing_jobs_activo_key
  ON processing_jobs (source_id)
  WHERE status IN ('pendiente', 'ejecutando');
