-- 004 · Briefs, campos, evidencias, preguntas locales y ejecuciones de IA.
--
-- Implementa D0-08 §2.7 a §2.12 y las Épicas E5, E6 y E11.
--
-- Dos reglas se imponen AQUÍ, en la base, además de en `packages/domain`:
--   · una versión aprobada no admite modificación de su contenido (ADR-003);
--   · un claim con valor debe citar evidencia (§15, umbral del 100%).
-- Una migración o un script pueden saltarse la capa de aplicación; no la base.

CREATE TYPE brief_status AS ENUM (
  'draft', 'processing', 'extraction_review', 'local_questions',
  'internal_review', 'internal_changes_requested',
  'client_review', 'client_changes_requested',
  'approved', 'superseded', 'cancelled', 'processing_failed'
);

CREATE TYPE field_status AS ENUM ('found', 'not_found', 'conflict', 'manual');
CREATE TYPE provenance_type AS ENUM ('extracted', 'inferred', 'manual_local', 'translated');
CREATE TYPE criticality AS ENUM ('informativo', 'critico', 'claim');
CREATE TYPE evidence_relation AS ENUM ('soporta', 'contradice', 'contexto');
CREATE TYPE question_status AS ENUM ('pendiente', 'respondida', 'descartada');

-- ─────────────────────────── Brief y versiones ───────────────────────────────

CREATE TABLE briefs (
  id           uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  campaign_id  uuid NOT NULL UNIQUE REFERENCES campaigns(id) ON DELETE CASCADE,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE brief_versions (
  id                  uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  brief_id            uuid NOT NULL REFERENCES briefs(id) ON DELETE CASCADE,
  organization_id     uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  version             integer NOT NULL,
  language            text NOT NULL DEFAULT 'es',
  parent_version_id   uuid REFERENCES brief_versions(id) ON DELETE SET NULL,
  translation_of_id   uuid REFERENCES brief_versions(id) ON DELETE SET NULL,
  status              brief_status NOT NULL DEFAULT 'draft',
  created_by          uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at          timestamptz NOT NULL DEFAULT now(),
  approved_at         timestamptz,

  CONSTRAINT brief_versions_unica UNIQUE (brief_id, language, version),
  CONSTRAINT brief_versions_idioma CHECK (language IN ('es', 'en')),
  -- §10.3, regla 2: toda traducción apunta a su versión de origen.
  CONSTRAINT brief_versions_traduccion_con_origen
    CHECK (language = 'es' OR translation_of_id IS NOT NULL)
);

CREATE INDEX brief_versions_brief_idx ON brief_versions (brief_id);
CREATE INDEX brief_versions_org_idx ON brief_versions (organization_id);

-- ─────────────────────────── Campos del brief ────────────────────────────────

CREATE TABLE brief_fields (
  id                   uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  brief_version_id     uuid NOT NULL REFERENCES brief_versions(id) ON DELETE CASCADE,
  -- Ruta canónica del esquema. En campañas multiproducto lleva el producto:
  -- `marca_producto[prd-p80-ultra].rtbs` (DEC-016).
  key                  text NOT NULL,
  campaign_product_id  uuid REFERENCES campaign_products(id) ON DELETE CASCADE,
  value                jsonb,
  status               field_status NOT NULL,
  confidence           numeric(4,3),
  provenance_type      provenance_type NOT NULL,
  criticidad           criticality NOT NULL DEFAULT 'informativo',
  created_at           timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT brief_fields_unico UNIQUE (brief_version_id, key),
  CONSTRAINT brief_fields_confianza_rango
    CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  -- §9.4: `not_found` nunca lleva valor. Hace estructuralmente imposible
  -- completar un dato ausente con conocimiento general del modelo.
  CONSTRAINT brief_fields_not_found_sin_valor
    CHECK (status <> 'not_found' OR value IS NULL),
  -- Un aporte manual no tiene confianza estimada: lo escribió una persona.
  CONSTRAINT brief_fields_manual_sin_confianza
    CHECK (provenance_type <> 'manual_local' OR confidence IS NULL)
);

CREATE INDEX brief_fields_version_idx ON brief_fields (brief_version_id);

-- ─────────────────────────── Evidencia ───────────────────────────────────────

CREATE TABLE evidence (
  id              uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  brief_field_id  uuid NOT NULL REFERENCES brief_fields(id) ON DELETE CASCADE,
  source_id       uuid NOT NULL REFERENCES source_documents(id) ON DELETE RESTRICT,
  fragment_id     uuid REFERENCES source_fragments(id) ON DELETE SET NULL,
  page            integer,
  slide           integer,
  section         text,
  linea           integer,
  -- Cita literal: permite verificar sin abrir el original.
  quote           text NOT NULL,
  relation        evidence_relation NOT NULL DEFAULT 'soporta',
  created_at      timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT evidence_cita_no_vacia CHECK (btrim(quote) <> '')
);

CREATE INDEX evidence_field_idx ON evidence (brief_field_id);
CREATE INDEX evidence_source_idx ON evidence (source_id);

-- §15: "claims y datos técnicos con evidencia: 100%".
--
-- La comprobación vive en un trigger diferido: los campos y sus evidencias se
-- insertan en la misma transacción, así que validar al vuelo fallaría siempre.
-- Diferido al COMMIT, comprueba el estado final.
CREATE OR REPLACE FUNCTION claim_exige_evidencia() RETURNS trigger AS $$
DECLARE
  sin_respaldo text;
BEGIN
  SELECT string_agg(f.key, ', ')
    INTO sin_respaldo
    FROM brief_fields f
    JOIN brief_versions v ON v.id = f.brief_version_id
   WHERE v.status = 'approved'
     AND f.criticidad IN ('critico', 'claim')
     AND f.status = 'found'
     AND NOT EXISTS (SELECT 1 FROM evidence e WHERE e.brief_field_id = f.id);

  IF sin_respaldo IS NOT NULL THEN
    RAISE EXCEPTION
      'No se puede aprobar: los campos (%) son claims sin evidencia (§15, umbral del 100%%)',
      sin_respaldo;
  END IF;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER brief_versions_claims_con_evidencia
  AFTER INSERT OR UPDATE ON brief_versions
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION claim_exige_evidencia();

-- ─────────────────────────── Inmutabilidad (ADR-003) ─────────────────────────

-- Una versión aprobada es inmutable. `superseded` y `cancelled` son las únicas
-- transiciones que admite; su contenido no se toca nunca.
CREATE OR REPLACE FUNCTION version_aprobada_inmutable() RETURNS trigger AS $$
BEGIN
  IF OLD.status = 'approved' THEN
    IF NEW.status NOT IN ('approved', 'superseded', 'cancelled') THEN
      RAISE EXCEPTION
        'La versión % está aprobada y no puede volver a % (ADR-003). Cree una versión nueva.',
        OLD.version, NEW.status;
    END IF;
    IF NEW.version <> OLD.version OR NEW.brief_id <> OLD.brief_id
       OR NEW.language <> OLD.language THEN
      RAISE EXCEPTION 'No se puede alterar la identidad de una versión aprobada (ADR-003).';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER brief_versions_inmutabilidad
  BEFORE UPDATE ON brief_versions
  FOR EACH ROW EXECUTE FUNCTION version_aprobada_inmutable();

-- Los campos de una versión aprobada tampoco se tocan.
CREATE OR REPLACE FUNCTION campos_de_version_aprobada_inmutables() RETURNS trigger AS $$
DECLARE
  estado brief_status;
  version_id uuid;
BEGIN
  version_id := COALESCE(NEW.brief_version_id, OLD.brief_version_id);
  SELECT status INTO estado FROM brief_versions WHERE id = version_id;

  IF estado = 'approved' THEN
    RAISE EXCEPTION
      'Los campos de una versión aprobada no admiten % (ADR-003). Cree una versión nueva.',
      TG_OP;
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER brief_fields_inmutabilidad
  BEFORE UPDATE OR DELETE ON brief_fields
  FOR EACH ROW EXECUTE FUNCTION campos_de_version_aprobada_inmutables();

-- ─────────────────────────── Preguntas locales (E6) ──────────────────────────

CREATE TABLE local_questions (
  id                uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  campaign_id       uuid NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  brief_version_id  uuid REFERENCES brief_versions(id) ON DELETE CASCADE,
  key               text NOT NULL,
  question          text NOT NULL,
  reason            text NOT NULL,
  criticidad        criticality NOT NULL DEFAULT 'informativo',
  status            question_status NOT NULL DEFAULT 'pendiente',
  answer            text,
  answered_by       uuid REFERENCES users(id) ON DELETE SET NULL,
  answered_at       timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),

  -- E6-4: descartar exige justificación. Un descarte sin motivo deja un vacío
  -- invisible en el brief.
  CONSTRAINT local_questions_descarte_justificado
    CHECK (status <> 'descartada' OR (answer IS NOT NULL AND btrim(answer) <> '')),
  CONSTRAINT local_questions_respuesta_con_autor
    CHECK (status = 'pendiente' OR answered_by IS NOT NULL)
);

CREATE INDEX local_questions_campana_idx ON local_questions (campaign_id, status);

-- ─────────────────────────── Ejecuciones de IA (E11-7) ───────────────────────

-- §10.3, regla 6: `AIRun` no reemplaza a `AuditEvent`. Responden preguntas
-- distintas — qué hizo el modelo y cuánto costó, frente a qué hizo una persona.
CREATE TABLE ai_runs (
  id                uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id   uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  campaign_id       uuid REFERENCES campaigns(id) ON DELETE SET NULL,
  brief_version_id  uuid REFERENCES brief_versions(id) ON DELETE SET NULL,
  task              text NOT NULL,
  tier              text NOT NULL,
  provider          text NOT NULL DEFAULT 'openrouter',
  model             text NOT NULL,
  prompt_version    text NOT NULL,
  -- Hash de la entrada, no la entrada: detecta reejecuciones idénticas sin
  -- guardar el contenido (§11.6, caso S-10).
  input_hash        text NOT NULL,
  output_status     text NOT NULL,
  latency_ms        integer,
  prompt_tokens     integer,
  completion_tokens integer,
  -- Costo REAL devuelto por OpenRouter, no una estimación nuestra (DEC-019).
  cost_usd          numeric(10,6),
  generation_id     text,
  error             text,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ai_runs_org_idx ON ai_runs (organization_id, created_at DESC);
CREATE INDEX ai_runs_campana_idx ON ai_runs (campaign_id);
CREATE INDEX ai_runs_modelo_idx ON ai_runs (model, task);

COMMENT ON TABLE ai_runs IS
  'Observabilidad de IA: qué modelo, con qué costo y sobre qué fuentes. '
  'Nunca contiene el prompt ni la respuesta: solo hashes y metadatos (§11.6).';
