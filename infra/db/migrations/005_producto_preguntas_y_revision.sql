-- 005 · Anclaje de producto verificable, preguntas locales completas, y
-- revisión persistida de cada campo del brief.
--
-- Cierra la brecha entre lo que la migración 004 ya modeló (columnas
-- `campaign_product_id`, tabla `local_questions`) y lo que ningún código de
-- aplicación usaba todavía (HANDOFF.md, Sprint 4). No toca ninguna de las
-- cuatro migraciones anteriores: donde hubo que corregir algo (la unicidad de
-- `brief_fields`), se reemplaza aquí, con su propia razón documentada.
--
-- Tres reglas nuevas se imponen en la base, no solo en la aplicación, por la
-- misma razón que ya aplicó la migración 004: un script puede saltarse
-- `packages/db`, nunca a la base.
--   · un `campaign_product_id` siempre pertenece a la campaña del recurso que
--     lo referencia (`brief_fields` y `local_questions`);
--   · `brief_fields.revision` se incrementa solo con un `UPDATE` real —es la
--     base del control de concurrencia optimista (corrección 7 del cierre);
--   · el historial de contenido de un campo (`brief_field_revisions`) es de
--     solo inserción, igual que `audit_events`.

-- ─────────────────────────── Anclaje de producto (DEC-023) ────────────────────

-- Antes: una sola fila por `(brief_version_id, key)`, sin importar el
-- producto. Eso hacía imposible que `marca_producto[].rtbs` tuviera un valor
-- distinto por cada modelo de una campaña como P80 (3 productos). Se
-- reemplaza por dos índices únicos parciales: uno para los campos de campaña
-- o compartidos (`campaign_product_id IS NULL`), otro para los campos de
-- producto (una fila por producto).
ALTER TABLE brief_fields DROP CONSTRAINT brief_fields_unico;

CREATE UNIQUE INDEX brief_fields_unica_campana
  ON brief_fields (brief_version_id, key) WHERE campaign_product_id IS NULL;
CREATE UNIQUE INDEX brief_fields_unica_producto
  ON brief_fields (brief_version_id, key, campaign_product_id) WHERE campaign_product_id IS NOT NULL;

-- Defensa en profundidad: `packages/db` ya valida que el producto devuelto
-- por el worker pertenezca a la campaña antes de persistir (Fase D del cierre
-- de Sprint 4), pero la base no depende de que ese código se ejecute siempre.
CREATE OR REPLACE FUNCTION brief_fields_producto_de_la_campana() RETURNS trigger AS $$
DECLARE
  campana_producto uuid;
  campana_version   uuid;
BEGIN
  IF NEW.campaign_product_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT campaign_id INTO campana_producto
    FROM campaign_products WHERE id = NEW.campaign_product_id;

  SELECT b.campaign_id INTO campana_version
    FROM brief_versions v JOIN briefs b ON b.id = v.brief_id
   WHERE v.id = NEW.brief_version_id;

  IF campana_producto IS NULL OR campana_producto <> campana_version THEN
    RAISE EXCEPTION
      'El producto % no pertenece a la campaña de esta versión del brief.',
      NEW.campaign_product_id;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER brief_fields_valida_producto
  BEFORE INSERT OR UPDATE ON brief_fields
  FOR EACH ROW EXECUTE FUNCTION brief_fields_producto_de_la_campana();

-- ─────────────────────────── Revisión persistida (corrección 2) ───────────────

-- Un evento de auditoría no basta para saber, tras recargar la página, qué
-- campo está pendiente de revisión, cuál se confirmó y cuál se corrigió: hace
-- falta un estado que se lea, no solo un registro que se busque.
ALTER TABLE brief_fields
  ADD COLUMN review_status text NOT NULL DEFAULT 'pending'
    CONSTRAINT brief_fields_review_status_valido
    CHECK (review_status IN ('pending', 'confirmed', 'corrected')),
  ADD COLUMN reviewed_by uuid REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN reviewed_at timestamptz,
  -- Control de concurrencia optimista (corrección 7): un entero es
  -- inequívoco para comparar en un `WHERE ... AND revision = $n`, a
  -- diferencia de un timestamp sujeto a precisión y formato.
  ADD COLUMN revision integer NOT NULL DEFAULT 1,
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();

CREATE OR REPLACE FUNCTION brief_fields_incrementar_revision() RETURNS trigger AS $$
BEGIN
  NEW.revision := OLD.revision + 1;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER brief_fields_revision
  BEFORE UPDATE ON brief_fields
  FOR EACH ROW EXECUTE FUNCTION brief_fields_incrementar_revision();

-- ─────────────────────────── Historial de contenido (corrección 5) ────────────

-- `audit_events` (001) registra que un campo cambió, quién y cuándo, pero
-- nunca el contenido de negocio (es una regla general de esa tabla, no una
-- excepción para este caso). El valor anterior y el nuevo, y el motivo de una
-- corrección, viven aquí — separado, para que la auditoría general nunca se
-- vuelva una copia del brief.
CREATE TABLE brief_field_revisions (
  id                uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  brief_field_id    uuid NOT NULL REFERENCES brief_fields(id) ON DELETE CASCADE,
  brief_version_id  uuid NOT NULL REFERENCES brief_versions(id) ON DELETE CASCADE,
  accion            text NOT NULL
    CONSTRAINT brief_field_revisions_accion_valida
    CHECK (accion IN ('confirm', 'correct', 'resolve_conflict', 'apply_answer')),
  valor_anterior    jsonb,
  valor_nuevo       jsonb,
  motivo            text,
  actor_id          uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX brief_field_revisions_campo_idx ON brief_field_revisions (brief_field_id, created_at DESC);
CREATE INDEX brief_field_revisions_version_idx ON brief_field_revisions (brief_version_id);

-- Solo bloquea UPDATE, a diferencia de `audit_events` (que también bloquea
-- DELETE): `brief_field_revisions` sí tiene claves foráneas en cascada hacia
-- `brief_fields`/`brief_versions`, y `audit_events` no tiene ninguna. Bloquear
-- también DELETE volvería imposible borrar una campaña completa —el DELETE en
-- cascada dispara este mismo trigger fila por fila— sin lograr nada a cambio:
-- nada en la aplicación borra una revisión suelta mientras su campo sigue
-- vivo. Lo que hay que impedir es que alguien reescriba el historial, no que
-- desaparezca junto con todo lo demás cuando se borra la campaña dueña.
CREATE OR REPLACE FUNCTION brief_field_revisions_sin_edicion() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'brief_field_revisions no admite UPDATE: el historial no se reescribe (§10.3)';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER brief_field_revisions_no_update
  BEFORE UPDATE ON brief_field_revisions
  FOR EACH ROW EXECUTE FUNCTION brief_field_revisions_sin_edicion();

-- ─────────────────────────── Preguntas locales completas (E6) ─────────────────

-- Alcance por producto (§5.2 del cierre): una pregunta de campaña o
-- compartida se formula una sola vez; una específica, una vez por producto.
ALTER TABLE local_questions
  ADD COLUMN campaign_product_id uuid REFERENCES campaign_products(id) ON DELETE CASCADE,
  -- Valor estructurado a aplicar sobre `brief_fields.value` — separado de
  -- `answer` (texto: la justificación del descarte, o la explicación de la
  -- respuesta). Nunca se guarda un valor estructurado como texto libre
  -- (corrección 3 del cierre): "2026-11" no es un `PrecisedDate`.
  ADD COLUMN answer_value jsonb;

-- Idempotencia (§5.1): regenerar preguntas dos veces no duplica. La clave
-- canónica de una pregunta es la misma tripleta que identifica un campo.
CREATE UNIQUE INDEX local_questions_unica_campana
  ON local_questions (brief_version_id, key)
  WHERE campaign_product_id IS NULL AND brief_version_id IS NOT NULL;
CREATE UNIQUE INDEX local_questions_unica_producto
  ON local_questions (brief_version_id, key, campaign_product_id)
  WHERE campaign_product_id IS NOT NULL AND brief_version_id IS NOT NULL;

CREATE OR REPLACE FUNCTION local_questions_producto_de_la_campana() RETURNS trigger AS $$
DECLARE
  campana_producto uuid;
BEGIN
  IF NEW.campaign_product_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT campaign_id INTO campana_producto
    FROM campaign_products WHERE id = NEW.campaign_product_id;

  IF campana_producto IS NULL OR campana_producto <> NEW.campaign_id THEN
    RAISE EXCEPTION
      'El producto % no pertenece a la campaña de esta pregunta local.',
      NEW.campaign_product_id;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER local_questions_valida_producto
  BEFORE INSERT OR UPDATE ON local_questions
  FOR EACH ROW EXECUTE FUNCTION local_questions_producto_de_la_campana();

-- ─────────────────────────── Procedencia "pendiente" ───────────────────────────

-- `crearBriefManual` (Fase D del cierre) siembra las 41 claves del catálogo
-- antes de que nadie las toque. No son `extracted` (no vinieron de una
-- extracción) ni `manual_local` (nadie las respondió todavía) — hace falta un
-- valor honesto para ese estado inicial, porque la columna es NOT NULL.
ALTER TYPE provenance_type ADD VALUE 'pending';
