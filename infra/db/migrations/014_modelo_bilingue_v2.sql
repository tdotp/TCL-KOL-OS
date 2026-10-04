-- 014 · Modelo bilingüe V2 — una versión lógica, dos representaciones (V2 · Fase 2).
--
-- ─────────────────────────── Modelo anterior y problema
--
-- ES y EN eran filas distintas de `brief_versions` (`UNIQUE (brief_id, language,
-- version)`, `translation_of_id`), cada una con su propio estado, aprobación y
-- linaje: `ES = approved` con `EN = draft` era representable. Ningún código
-- creaba filas `en`, pero la estructura contradecía la regla V2:
--
--   Documento → Versión N → { ES, EN }      Estado único · Aprobación única
--
-- ─────────────────────────── Modelo V2 (aditivo)
--
-- La versión lógica ES ES la fila `brief_versions` de siempre: conserva su id,
-- su `status`, su `approved_at`, su linaje (`parent_version_id`) y todos sus
-- campos, evidencias, revisiones, preguntas y comentarios. Nada de eso se
-- duplica por idioma. Se añade:
--
--   brief_version_representations  — ES / EN como HIJAS de la versión lógica
--                                    (sin estado ni aprobación propios).
--   brief_field_translations       — valor localizado de un campo en una
--                                    representación traducida, con su origen y
--                                    la huella del valor de origen (staleness).
--   brief_legacy_language_links    — clasificación de las filas EN históricas.
--
-- El valor de un campo en el idioma original vive en `brief_fields.value`
-- (representación `original`); las traducciones apuntan a ese campo, así que
-- la evidencia que respalda el valor original respalda también la traducción.
--
-- ─────────────────────────── Datos legacy (nunca se reescriben)
--
-- No se borra ni se actualiza ninguna fila de `brief_versions` (las aprobadas
-- están congeladas por las migraciones 004/009/010). Las filas `en` históricas
-- se CLASIFICAN en `brief_legacy_language_links` por `brief_legacy_en_fold()`:
--
--   · folded   — mismo estado que su versión ES de origen, campos con
--                correspondencia exacta, un único EN por ES: se importa como
--                representación EN (`legacy_import`) con valores marcados
--                «sin verificar» (no se puede probar que estaban al día).
--   · conflict — estados distintos, campos sin correspondencia o varios EN
--                para el mismo ES. NO se reconcilia ni se elige un ganador:
--                los datos quedan intactos y la inconsistencia queda marcada
--                para intervención explícita.
--   · orphan   — sin versión ES de origen válida.
--
-- Forward-only: no modifica migraciones anteriores.

-- ─────────────────────────── Huella del valor (staleness)

CREATE OR REPLACE FUNCTION brief_value_hash(valor jsonb) RETURNS text AS $$
  SELECT encode(sha256(convert_to(valor::text, 'UTF8')), 'hex');
$$ LANGUAGE sql IMMUTABLE;

-- ─────────────────────────── Representaciones

CREATE TABLE brief_version_representations (
  id                           uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  brief_version_id             uuid NOT NULL REFERENCES brief_versions(id) ON DELETE CASCADE,
  language                     text NOT NULL,
  -- original: el idioma en que se redactó/extrajo; translation: derivada de otra
  -- representación de la MISMA versión; legacy_import: importada de una fila EN
  -- histórica.
  kind                         text NOT NULL,
  -- De qué representación proviene (obligatorio para toda traducción).
  source_representation_id     uuid REFERENCES brief_version_representations(id) ON DELETE CASCADE,
  -- Linaje entre versiones: la representación equivalente de la versión padre.
  copied_from_representation_id uuid REFERENCES brief_version_representations(id) ON DELETE SET NULL,
  legacy_version_id            uuid REFERENCES brief_versions(id) ON DELETE CASCADE,
  created_by                   uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at                   timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT brief_representations_idioma CHECK (language IN ('es', 'en')),
  CONSTRAINT brief_representations_tipo CHECK (kind IN ('original', 'translation', 'legacy_import')),
  CONSTRAINT brief_representations_unica UNIQUE (brief_version_id, language),
  CONSTRAINT brief_representations_origen CHECK (
    (kind = 'original' AND source_representation_id IS NULL)
    OR (kind IN ('translation', 'legacy_import')
        AND source_representation_id IS NOT NULL AND source_representation_id <> id)
  ),
  CONSTRAINT brief_representations_legacy CHECK ((kind = 'legacy_import') = (legacy_version_id IS NOT NULL))
);

-- Exactamente una representación original por versión lógica.
CREATE UNIQUE INDEX brief_representations_original_unica
  ON brief_version_representations (brief_version_id) WHERE kind = 'original';
CREATE INDEX brief_representations_version_idx ON brief_version_representations (brief_version_id);

-- ─────────────────────────── Valores localizados por campo

CREATE TABLE brief_field_translations (
  id                 uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  brief_field_id     uuid NOT NULL REFERENCES brief_fields(id) ON DELETE CASCADE,
  representation_id  uuid NOT NULL REFERENCES brief_version_representations(id) ON DELETE CASCADE,
  value              jsonb NOT NULL,
  -- translated: la produjo un proceso de traducción; manual_local: la escribió
  -- una persona. (Reutiliza el enum de procedencia existente.)
  provenance_type    provenance_type NOT NULL DEFAULT 'translated',
  -- Quién produjo la traducción: ai | human | legacy.
  translator         text NOT NULL DEFAULT 'human',
  -- Huella (brief_value_hash) del valor ORIGINAL cuando se tradujo. Si el valor
  -- original cambia, la huella ya no coincide y la traducción queda `stale`.
  -- NULL = no verificable (importada de datos históricos).
  source_value_hash  text,
  -- Informativo: revisión del campo original al traducir.
  source_revision    integer,
  -- Campo EN histórico del que se importó (solo legacy_import).
  legacy_field_id    uuid REFERENCES brief_fields(id) ON DELETE SET NULL,
  translated_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT brief_field_translations_unica UNIQUE (brief_field_id, representation_id),
  CONSTRAINT brief_field_translations_procedencia CHECK (provenance_type IN ('translated', 'manual_local')),
  CONSTRAINT brief_field_translations_traductor CHECK (translator IN ('ai', 'human', 'legacy'))
);

CREATE INDEX brief_field_translations_representacion_idx ON brief_field_translations (representation_id);

-- ─────────────────────────── Estado de sincronización (una sola definición)

-- Por cada representación traducida y cada campo con valor del idioma original:
--   missing    — no hay traducción;
--   unverified — hay traducción pero no se puede probar que corresponde al valor
--                actual (datos históricos);
--   current    — la huella coincide con el valor original vigente;
--   stale      — el valor original cambió después de traducir.
CREATE VIEW brief_translation_sync AS
SELECT r.id                 AS representation_id,
       r.brief_version_id,
       r.language,
       f.id                 AS brief_field_id,
       f.key,
       f.campaign_product_id,
       CASE
         WHEN t.id IS NULL THEN 'missing'
         WHEN t.source_value_hash IS NULL THEN 'unverified'
         WHEN t.source_value_hash = brief_value_hash(f.value) THEN 'current'
         ELSE 'stale'
       END                  AS state
  FROM brief_version_representations r
  JOIN brief_fields f ON f.brief_version_id = r.brief_version_id
  LEFT JOIN brief_field_translations t
         ON t.brief_field_id = f.id AND t.representation_id = r.id
 WHERE r.kind <> 'original'
   AND f.value IS NOT NULL
   AND f.value <> 'null'::jsonb;

-- ─────────────────────────── Historial de contenido: traducciones

-- El historial de cambios de contenido (`brief_field_revisions`) también recoge
-- las traducciones, con el idioma al que corresponden. Filas históricas: 'es'.
ALTER TABLE brief_field_revisions ADD COLUMN language text NOT NULL DEFAULT 'es';
ALTER TABLE brief_field_revisions DROP CONSTRAINT brief_field_revisions_accion_valida;
ALTER TABLE brief_field_revisions
  ADD CONSTRAINT brief_field_revisions_accion_valida
  CHECK (accion IN ('confirm', 'correct', 'resolve_conflict', 'apply_answer',
                     'declare_exception', 'revert_exception', 'translate')),
  ADD CONSTRAINT brief_field_revisions_idioma CHECK (language IN ('es', 'en'));

-- ─────────────────────────── Clasificación de datos legacy

CREATE TABLE brief_legacy_language_links (
  en_version_id   uuid PRIMARY KEY REFERENCES brief_versions(id) ON DELETE CASCADE,
  es_version_id   uuid REFERENCES brief_versions(id) ON DELETE CASCADE,
  classification  text NOT NULL,
  reason          text NOT NULL,
  detected_at     timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT brief_legacy_links_clasificacion CHECK (classification IN ('folded', 'conflict', 'orphan'))
);

COMMENT ON TABLE brief_legacy_language_links IS
  'Clasificación de versiones EN anteriores a V2. folded = importada como representación; '
  'conflict/orphan = inconsistencia que requiere intervención explícita (no se reconcilia en silencio).';

-- ─────────────────────────── Backfill: representación ES de cada versión

INSERT INTO brief_version_representations (brief_version_id, language, kind, created_by, created_at)
SELECT v.id, 'es', 'original', v.created_by, v.created_at
  FROM brief_versions v
 WHERE v.language = 'es'
ON CONFLICT (brief_version_id, language) DO NOTHING;

-- ─────────────────────────── Clasificar / importar las versiones EN históricas

CREATE OR REPLACE FUNCTION brief_legacy_en_fold() RETURNS TABLE (en_version_id uuid, classification text) AS $$
DECLARE
  en_row        record;
  es_row        record;
  motivo        text;
  clase         text;
  rep_es        uuid;
  rep_en        uuid;
  sin_pareja    integer;
  hermanos      integer;
BEGIN
  FOR en_row IN
    SELECT v.* FROM brief_versions v
     WHERE v.language <> 'es'
       AND NOT EXISTS (SELECT 1 FROM brief_legacy_language_links l WHERE l.en_version_id = v.id)
     ORDER BY v.created_at, v.id
  LOOP
    clase := 'folded';
    motivo := 'mismo estado que su versión ES y campos con correspondencia exacta';

    SELECT v.* INTO es_row FROM brief_versions v WHERE v.id = en_row.translation_of_id;

    IF NOT FOUND OR es_row.language <> 'es' OR es_row.brief_id <> en_row.brief_id THEN
      clase := 'orphan';
      motivo := 'sin versión ES de origen válida (translation_of_id ausente o inconsistente)';
    ELSE
      SELECT count(*) INTO hermanos FROM brief_versions v
       WHERE v.language <> 'es' AND v.translation_of_id = es_row.id;
      SELECT count(*) INTO sin_pareja
        FROM brief_fields ef
       WHERE ef.brief_version_id = en_row.id
         AND NOT EXISTS (
           SELECT 1 FROM brief_fields sf
            WHERE sf.brief_version_id = es_row.id AND sf.key = ef.key
              AND sf.campaign_product_id IS NOT DISTINCT FROM ef.campaign_product_id);

      IF es_row.status <> en_row.status THEN
        clase := 'conflict';
        motivo := format('estados históricos distintos: ES=%s, EN=%s (no se reconcilia en silencio)',
                         es_row.status, en_row.status);
      ELSIF hermanos > 1 THEN
        clase := 'conflict';
        motivo := format('%s versiones EN históricas apuntan a la misma versión ES', hermanos);
      ELSIF sin_pareja > 0 THEN
        clase := 'conflict';
        motivo := format('%s campo(s) EN sin campo ES correspondiente', sin_pareja);
      END IF;
    END IF;

    IF clase = 'folded' THEN
      SELECT r.id INTO rep_es FROM brief_version_representations r
       WHERE r.brief_version_id = es_row.id AND r.language = 'es';
      IF rep_es IS NULL THEN
        INSERT INTO brief_version_representations (brief_version_id, language, kind, created_by, created_at)
        VALUES (es_row.id, 'es', 'original', es_row.created_by, es_row.created_at)
        RETURNING id INTO rep_es;
      END IF;

      INSERT INTO brief_version_representations
        (brief_version_id, language, kind, source_representation_id, legacy_version_id, created_by, created_at)
      VALUES (es_row.id, en_row.language, 'legacy_import', rep_es, en_row.id, en_row.created_by, en_row.created_at)
      RETURNING id INTO rep_en;

      INSERT INTO brief_field_translations
        (brief_field_id, representation_id, value, provenance_type, translator,
         source_value_hash, legacy_field_id, translated_by, created_at, updated_at)
      SELECT sf.id, rep_en, ef.value,
             CASE WHEN ef.provenance_type = 'manual_local' THEN 'manual_local'::provenance_type
                  ELSE 'translated'::provenance_type END,
             'legacy', NULL, ef.id, en_row.created_by, ef.created_at, ef.updated_at
        FROM brief_fields ef
        JOIN brief_fields sf
          ON sf.brief_version_id = es_row.id AND sf.key = ef.key
         AND sf.campaign_product_id IS NOT DISTINCT FROM ef.campaign_product_id
       WHERE ef.brief_version_id = en_row.id AND ef.value IS NOT NULL AND ef.value <> 'null'::jsonb;
    END IF;

    INSERT INTO brief_legacy_language_links (en_version_id, es_version_id, classification, reason)
    VALUES (en_row.id, CASE WHEN clase = 'orphan' THEN NULL ELSE es_row.id END, clase, motivo);

    en_version_id := en_row.id;
    classification := clase;
    RETURN NEXT;
  END LOOP;
END;
$$ LANGUAGE plpgsql;

-- Se ejecuta ahora, ANTES de crear los disparadores de inmutabilidad de las
-- tablas nuevas: así puede importar también sobre versiones ya aprobadas.
SELECT * FROM brief_legacy_en_fold();

-- ─────────────────────────── Integridad (en la base, no solo en la aplicación)

CREATE OR REPLACE FUNCTION brief_version_es_terminal(version_id uuid) RETURNS boolean AS $$
  SELECT COALESCE((SELECT status IN ('approved', 'superseded', 'cancelled')
                     FROM brief_versions WHERE id = version_id), false);
$$ LANGUAGE sql STABLE;

-- Una versión lógica nace SIEMPRE en el idioma original (es): no se crean más
-- versiones independientes por idioma. Las filas EN históricas se conservan.
CREATE OR REPLACE FUNCTION brief_versions_solo_idioma_original() RETURNS trigger AS $$
BEGIN
  IF NEW.language <> 'es' AND NOT inmutabilidad_bypass_activo() THEN
    RAISE EXCEPTION
      'No se crean versiones independientes por idioma (V2): el inglés es una representación de la versión lógica (brief_version_representations).';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER brief_versions_solo_idioma_original
  BEFORE INSERT ON brief_versions
  FOR EACH ROW EXECUTE FUNCTION brief_versions_solo_idioma_original();

-- Toda versión lógica nueva tiene su representación original.
CREATE OR REPLACE FUNCTION brief_versions_crea_representacion_original() RETURNS trigger AS $$
BEGIN
  IF NEW.language = 'es' THEN
    INSERT INTO brief_version_representations (brief_version_id, language, kind, created_by)
    VALUES (NEW.id, 'es', 'original', NEW.created_by)
    ON CONFLICT (brief_version_id, language) DO NOTHING;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER brief_versions_representacion_original
  AFTER INSERT ON brief_versions
  FOR EACH ROW EXECUTE FUNCTION brief_versions_crea_representacion_original();

-- Representaciones: origen verificable, misma versión, congeladas al aprobar.
CREATE OR REPLACE FUNCTION brief_representations_integridad() RETURNS trigger AS $$
DECLARE
  origen   record;
  copia    record;
  version  uuid;
BEGIN
  IF inmutabilidad_bypass_activo() THEN RETURN COALESCE(NEW, OLD); END IF;

  version := COALESCE(NEW.brief_version_id, OLD.brief_version_id);

  IF TG_OP = 'DELETE' THEN
    IF brief_version_es_terminal(version) THEN
      RAISE EXCEPTION 'Las representaciones de una versión aprobada o cerrada no admiten DELETE (V2).';
    END IF;
    RETURN OLD;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF brief_version_es_terminal(version) THEN
      RAISE EXCEPTION 'Las representaciones de una versión aprobada o cerrada no admiten UPDATE (V2).';
    END IF;
    IF NEW.brief_version_id <> OLD.brief_version_id OR NEW.language <> OLD.language
       OR NEW.kind <> OLD.kind
       OR NEW.source_representation_id IS DISTINCT FROM OLD.source_representation_id
       OR NEW.legacy_version_id IS DISTINCT FROM OLD.legacy_version_id
       OR NEW.created_at <> OLD.created_at THEN
      RAISE EXCEPTION 'La identidad y el origen de una representación son inmutables (V2).';
    END IF;
    IF OLD.copied_from_representation_id IS NOT NULL
       AND NEW.copied_from_representation_id IS DISTINCT FROM OLD.copied_from_representation_id THEN
      RAISE EXCEPTION 'El linaje entre versiones de una representación es inmutable (V2).';
    END IF;
  END IF;

  -- La representación ORIGINAL forma parte del nacimiento de la versión lógica
  -- (también si una prueba o una carga la crea ya cerrada); lo que no se admite
  -- es AÑADIR traducciones a una versión aprobada o cerrada.
  IF TG_OP = 'INSERT' AND NEW.kind <> 'original' AND brief_version_es_terminal(version) THEN
    RAISE EXCEPTION 'No se añaden traducciones a una versión aprobada o cerrada (V2).';
  END IF;

  IF NEW.source_representation_id IS NOT NULL THEN
    SELECT brief_version_id, language INTO origen
      FROM brief_version_representations WHERE id = NEW.source_representation_id;
    IF NOT FOUND OR origen.brief_version_id <> NEW.brief_version_id THEN
      RAISE EXCEPTION 'El origen de una traducción debe ser otra representación de la MISMA versión (V2).';
    END IF;
    IF origen.language = NEW.language THEN
      RAISE EXCEPTION 'Una traducción no puede tener como origen una representación del mismo idioma (V2).';
    END IF;
  END IF;

  IF NEW.copied_from_representation_id IS NOT NULL THEN
    SELECT r.language, bv.brief_id INTO copia
      FROM brief_version_representations r
      JOIN brief_versions bv ON bv.id = r.brief_version_id
     WHERE r.id = NEW.copied_from_representation_id;
    IF NOT FOUND
       OR copia.language <> NEW.language
       OR copia.brief_id <> (SELECT brief_id FROM brief_versions WHERE id = NEW.brief_version_id) THEN
      RAISE EXCEPTION 'El linaje entre versiones debe apuntar a la misma representación (idioma) del mismo brief (V2).';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER brief_representations_integridad
  BEFORE INSERT OR UPDATE OR DELETE ON brief_version_representations
  FOR EACH ROW EXECUTE FUNCTION brief_representations_integridad();

-- Valores localizados: del campo de la MISMA versión, solo en traducciones,
-- congelados al aprobar.
CREATE OR REPLACE FUNCTION brief_field_translations_integridad() RETURNS trigger AS $$
DECLARE
  rep   record;
  campo uuid;
  version_campo uuid;
  version_rep uuid;
BEGIN
  IF inmutabilidad_bypass_activo() THEN RETURN COALESCE(NEW, OLD); END IF;

  IF TG_OP = 'DELETE' THEN
    SELECT brief_version_id INTO version_rep FROM brief_version_representations WHERE id = OLD.representation_id;
    IF version_rep IS NOT NULL AND brief_version_es_terminal(version_rep) THEN
      RAISE EXCEPTION 'Las traducciones de una versión aprobada o cerrada no admiten DELETE (V2).';
    END IF;
    RETURN OLD;
  END IF;

  SELECT brief_version_id, kind INTO rep FROM brief_version_representations WHERE id = NEW.representation_id;
  SELECT brief_version_id INTO version_campo FROM brief_fields WHERE id = NEW.brief_field_id;

  IF rep.kind = 'original' THEN
    RAISE EXCEPTION 'La representación original vive en brief_fields; no admite valores localizados (V2).';
  END IF;
  IF version_campo IS DISTINCT FROM rep.brief_version_id THEN
    RAISE EXCEPTION 'La traducción debe corresponder a un campo de la MISMA versión que su representación (origen incorrecto, V2).';
  END IF;
  IF brief_version_es_terminal(rep.brief_version_id) THEN
    RAISE EXCEPTION 'Las traducciones de una versión aprobada o cerrada son inmutables (V2). Cree una versión nueva.';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF NEW.brief_field_id <> OLD.brief_field_id OR NEW.representation_id <> OLD.representation_id
       OR NEW.created_at <> OLD.created_at THEN
      RAISE EXCEPTION 'La identidad de una traducción es inmutable (V2).';
    END IF;
    NEW.updated_at := now();
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER brief_field_translations_integridad
  BEFORE INSERT OR UPDATE OR DELETE ON brief_field_translations
  FOR EACH ROW EXECUTE FUNCTION brief_field_translations_integridad();

COMMENT ON TABLE brief_version_representations IS
  'ES/EN como representaciones HIJAS de una versión lógica del brief (V2). Sin estado ni aprobación propios.';
COMMENT ON TABLE brief_field_translations IS
  'Valor localizado de un campo en una representación traducida, con origen y huella del valor original.';
