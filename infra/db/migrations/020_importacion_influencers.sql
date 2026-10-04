-- 020 · Importación de influencers desde un Google Sheet (V2 · Fase 5, parte 2).
--
-- Forward-only y aditiva. Cuelga de las migraciones 015/016 (Influencer,
-- CampaignInfluencer, producto asignado) y 019 (snapshots). No modifica ninguna
-- fila ni columna existentes.
--
--   Snapshot ─► Plan de importación ─► Registros ─► Resoluciones humanas
--                                                 ├► Binding clave-de-la-fuente → participación
--                                                 └► Efectos (procedencia)
--
-- Principios impuestos AQUÍ (no solo en la aplicación):
--   · Un plan está ligado a UN snapshot y su contenido no se recalcula ni se
--     reescribe: cambiar el Sheet produce otro snapshot y otro plan.
--   · Una decisión humana es un hecho append-only (quién, cuándo, qué, por qué).
--   · El binding clave-de-la-fuente → participación se persiste y es inmutable: una
--     sincronización posterior no vuelve a inferir una identidad ya resuelta.
--   · Todo lo que el plan crea o reutiliza queda enlazado a la fila/rango del
--     snapshot que lo originó (procedencia estructurada, no solo auditoría).
--   · Aislamiento: todas las tablas llevan organization_id y claves compuestas
--     hacia campaña, fuente, snapshot, influencer y producto de campaña. Un Sheet
--     de una organización no puede crear ni asociar nada de otra.
--
-- Fuera de esta migración: acuerdos, fee/canje, entregables y KPIs. Esos valores
-- viven en el snapshot (con su localizador) hasta sus fases; no hay columnas ni
-- JSON anticipados en `campaign_influencers`.
--
-- Reutiliza `inmutabilidad_bypass_activo()` (009/010): la única salida de los
-- DELETE protegidos es una base `_test` con la bandera de sesión.

-- ─────────────────────────── Plan de importación ───────────────────────────────

-- Estado de NEGOCIO de la importación (no el técnico de la sincronización):
--   schema_invalid   el Sheet no cumple el esquema; no se evaluó ningún registro
--   ready            nada bloquea: se puede aplicar
--   needs_resolution hay registros que esperan una decisión humana
--   applied          todo lo aplicable se aplicó y no queda nada pendiente
--   superseded       hay un plan más reciente para la misma fuente
CREATE TABLE influencer_import_plans (
  id               uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id  uuid NOT NULL,
  campaign_id      uuid NOT NULL,
  source_id        uuid NOT NULL,
  snapshot_id      uuid NOT NULL,
  -- Plan con el que se comparó este (detección de nuevo/cambiado/desaparecido).
  base_plan_id     uuid REFERENCES influencer_import_plans(id),
  schema_id        text NOT NULL,
  schema_version   integer,
  status           text NOT NULL,
  -- Informe de validación del esquema (errores y advertencias). Sin valores del Sheet.
  validation       jsonb NOT NULL,
  summary          jsonb NOT NULL,
  created_by       uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  correlation      jsonb,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT influencer_import_plans_campaign_fkey
    FOREIGN KEY (campaign_id, organization_id)
    REFERENCES campaigns (id, organization_id) ON DELETE RESTRICT,
  -- La fuente es de la misma organización Y de la misma campaña.
  CONSTRAINT influencer_import_plans_source_org_fkey
    FOREIGN KEY (source_id, organization_id)
    REFERENCES source_documents (id, organization_id) ON DELETE RESTRICT,
  CONSTRAINT influencer_import_plans_source_campaign_fkey
    FOREIGN KEY (source_id, campaign_id)
    REFERENCES source_documents (id, campaign_id) ON DELETE RESTRICT,
  -- El snapshot es de ESA fuente.
  CONSTRAINT influencer_import_plans_snapshot_fkey
    FOREIGN KEY (snapshot_id, source_id)
    REFERENCES source_snapshots (id, source_id) ON DELETE RESTRICT,
  CONSTRAINT influencer_import_plans_estado_valido
    CHECK (status IN ('schema_invalid', 'ready', 'needs_resolution', 'applied', 'superseded')),
  CONSTRAINT influencer_import_plans_validation_objeto CHECK (jsonb_typeof(validation) = 'object'),
  CONSTRAINT influencer_import_plans_summary_objeto CHECK (jsonb_typeof(summary) = 'object'),
  -- Un plan por snapshot: no se «recalcula» silenciosamente contra otro contenido.
  CONSTRAINT influencer_import_plans_snapshot_key UNIQUE (source_id, snapshot_id),
  CONSTRAINT influencer_import_plans_id_organization_key UNIQUE (id, organization_id),
  CONSTRAINT influencer_import_plans_id_campaign_key UNIQUE (id, campaign_id),
  CONSTRAINT influencer_import_plans_id_snapshot_key UNIQUE (id, snapshot_id)
);

CREATE INDEX influencer_import_plans_source_idx ON influencer_import_plans (source_id, created_at DESC);

-- ─────────────────────────── Registros del plan ────────────────────────────────

-- Un registro = una persona del Sheet (una clave estable), tal como se evaluó
-- contra ESTE snapshot. Inmutable: lo que cambia después (resoluciones, binding)
-- vive en sus propias tablas.
CREATE TABLE influencer_import_records (
  id                   uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  plan_id              uuid NOT NULL,
  organization_id      uuid NOT NULL,
  campaign_id          uuid NOT NULL,
  source_id            uuid NOT NULL,
  snapshot_id          uuid NOT NULL,
  -- Clave estable dentro de la fuente (INF-001…), o `__FILA_n` si la fila no la tiene.
  source_key           text NOT NULL,
  kind                 text NOT NULL,
  display_name         text,
  -- [{platform, handle, normalizedHandle, row}]
  accounts             jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- [{ref, normalizedRef, row}]
  product_refs         jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- Rangos del snapshot que componen el registro (contrato SourceLocator).
  locators             jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- Columnas FUTURAS con valor (solo nombres): los valores se quedan en el snapshot.
  future_fields        jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- Huella del contenido completo del registro, para detectar cambios entre snapshots.
  content_hash         text,
  change               text NOT NULL,
  change_detail        jsonb NOT NULL DEFAULT '{}'::jsonb,
  identity_outcome     text NOT NULL,
  identity_detail      jsonb NOT NULL DEFAULT '{}'::jsonb,
  participation_outcome text,
  product_outcomes     jsonb NOT NULL DEFAULT '[]'::jsonb,
  problems             jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at           timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT influencer_import_records_plan_org_fkey
    FOREIGN KEY (plan_id, organization_id)
    REFERENCES influencer_import_plans (id, organization_id) ON DELETE CASCADE,
  CONSTRAINT influencer_import_records_plan_campaign_fkey
    FOREIGN KEY (plan_id, campaign_id)
    REFERENCES influencer_import_plans (id, campaign_id) ON DELETE CASCADE,
  -- El registro lleva el snapshot de SU plan, y ese snapshot es de la fuente declarada.
  CONSTRAINT influencer_import_records_plan_snapshot_fkey
    FOREIGN KEY (plan_id, snapshot_id)
    REFERENCES influencer_import_plans (id, snapshot_id) ON DELETE CASCADE,
  CONSTRAINT influencer_import_records_snapshot_fkey
    FOREIGN KEY (snapshot_id, source_id)
    REFERENCES source_snapshots (id, source_id) ON DELETE RESTRICT,
  CONSTRAINT influencer_import_records_kind_valido CHECK (kind IN ('person', 'missing_from_source')),
  CONSTRAINT influencer_import_records_cambio_valido
    CHECK (change IN ('new', 'unchanged', 'changed', 'missing_from_source')),
  CONSTRAINT influencer_import_records_identidad_valida CHECK (identity_outcome IN (
    'matched_binding', 'matched_existing', 'create_new', 'ambiguous', 'conflict',
    'needs_resolution', 'invalid', 'missing_from_source')),
  CONSTRAINT influencer_import_records_participacion_valida
    CHECK (participation_outcome IS NULL OR participation_outcome IN ('associate', 'exists', 'retired')),
  CONSTRAINT influencer_import_records_json_valido CHECK (
    jsonb_typeof(accounts) = 'array' AND jsonb_typeof(product_refs) = 'array'
    AND jsonb_typeof(locators) = 'array' AND jsonb_typeof(future_fields) = 'array'
    AND jsonb_typeof(product_outcomes) = 'array' AND jsonb_typeof(problems) = 'array'
    AND jsonb_typeof(change_detail) = 'object' AND jsonb_typeof(identity_detail) = 'object'),
  CONSTRAINT influencer_import_records_clave_key UNIQUE (plan_id, source_key),
  CONSTRAINT influencer_import_records_id_organization_key UNIQUE (id, organization_id),
  CONSTRAINT influencer_import_records_id_campaign_key UNIQUE (id, campaign_id)
);

CREATE INDEX influencer_import_records_source_key_idx ON influencer_import_records (source_id, source_key);

-- ─────────────────────────── Resoluciones humanas ──────────────────────────────

-- Una decisión humana sobre un registro ambiguo o bloqueado. Append-only. La vigente
-- es la más reciente por (registro, dimensión [, referencia de producto]).
--   identity  use_existing_influencer | create_new_influencer
--   product   choose_product (referencia del Sheet → producto de LA campaña)
--   ignore    ignore_record
CREATE TABLE influencer_import_resolutions (
  id                   uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id      uuid NOT NULL,
  campaign_id          uuid NOT NULL,
  record_id            uuid NOT NULL,
  dimension            text NOT NULL,
  decision             text NOT NULL,
  influencer_id        uuid,
  campaign_product_id  uuid,
  product_ref          text,
  decided_by           uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  reason               text,
  correlation          jsonb,
  created_at           timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT influencer_import_resolutions_record_org_fkey
    FOREIGN KEY (record_id, organization_id)
    REFERENCES influencer_import_records (id, organization_id) ON DELETE CASCADE,
  CONSTRAINT influencer_import_resolutions_record_campaign_fkey
    FOREIGN KEY (record_id, campaign_id)
    REFERENCES influencer_import_records (id, campaign_id) ON DELETE CASCADE,
  -- El Influencer elegido es de la misma organización.
  CONSTRAINT influencer_import_resolutions_influencer_fkey
    FOREIGN KEY (influencer_id, organization_id)
    REFERENCES influencers (id, organization_id) ON DELETE RESTRICT,
  -- El producto elegido es de LA campaña: uno de otra campaña es imposible.
  CONSTRAINT influencer_import_resolutions_product_fkey
    FOREIGN KEY (campaign_product_id, campaign_id)
    REFERENCES campaign_products (id, campaign_id) ON DELETE RESTRICT,
  CONSTRAINT influencer_import_resolutions_coherente CHECK (
    (dimension = 'identity' AND decision = 'use_existing_influencer'
       AND influencer_id IS NOT NULL AND campaign_product_id IS NULL AND product_ref IS NULL)
    OR (dimension = 'identity' AND decision = 'create_new_influencer'
       AND influencer_id IS NULL AND campaign_product_id IS NULL AND product_ref IS NULL)
    OR (dimension = 'product' AND decision = 'choose_product'
       AND influencer_id IS NULL AND campaign_product_id IS NOT NULL AND product_ref IS NOT NULL)
    OR (dimension = 'ignore' AND decision = 'ignore_record'
       AND influencer_id IS NULL AND campaign_product_id IS NULL AND product_ref IS NULL)
  ),
  CONSTRAINT influencer_import_resolutions_motivo_acotado CHECK (reason IS NULL OR char_length(reason) <= 500)
);

CREATE INDEX influencer_import_resolutions_record_idx
  ON influencer_import_resolutions (record_id, created_at DESC);

-- ─────────────────────────── Binding fuente → participación ────────────────────

-- «La clave INF-014 de ESTE Sheet es esta persona y esta participación.» Una vez
-- resuelta, una sincronización posterior NO vuelve a inferirla: el binding gana.
-- Conserva de dónde salió la decisión inicial (snapshot, registro y rangos).
CREATE TABLE influencer_source_bindings (
  id                      uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id         uuid NOT NULL,
  campaign_id             uuid NOT NULL,
  source_id               uuid NOT NULL,
  source_key              text NOT NULL,
  influencer_id           uuid NOT NULL,
  campaign_influencer_id  uuid NOT NULL,
  -- account_match: coincidió una cuenta existente · created: se creó la persona ·
  -- human_existing / human_new: lo decidió una persona.
  bound_via               text NOT NULL,
  origin_snapshot_id      uuid NOT NULL,
  origin_record_id        uuid NOT NULL,
  origin_locators         jsonb NOT NULL,
  bound_by                uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  correlation             jsonb,
  created_at              timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT influencer_source_bindings_campaign_fkey
    FOREIGN KEY (campaign_id, organization_id)
    REFERENCES campaigns (id, organization_id) ON DELETE RESTRICT,
  CONSTRAINT influencer_source_bindings_source_org_fkey
    FOREIGN KEY (source_id, organization_id)
    REFERENCES source_documents (id, organization_id) ON DELETE RESTRICT,
  CONSTRAINT influencer_source_bindings_source_campaign_fkey
    FOREIGN KEY (source_id, campaign_id)
    REFERENCES source_documents (id, campaign_id) ON DELETE RESTRICT,
  CONSTRAINT influencer_source_bindings_influencer_fkey
    FOREIGN KEY (influencer_id, organization_id)
    REFERENCES influencers (id, organization_id) ON DELETE RESTRICT,
  -- La participación es de ESTA campaña.
  CONSTRAINT influencer_source_bindings_participacion_fkey
    FOREIGN KEY (campaign_influencer_id, campaign_id)
    REFERENCES campaign_influencers (id, campaign_id) ON DELETE RESTRICT,
  CONSTRAINT influencer_source_bindings_snapshot_fkey
    FOREIGN KEY (origin_snapshot_id, source_id)
    REFERENCES source_snapshots (id, source_id) ON DELETE RESTRICT,
  CONSTRAINT influencer_source_bindings_registro_fkey
    FOREIGN KEY (origin_record_id, organization_id)
    REFERENCES influencer_import_records (id, organization_id) ON DELETE RESTRICT,
  CONSTRAINT influencer_source_bindings_via_valida
    CHECK (bound_via IN ('account_match', 'created', 'human_existing', 'human_new')),
  CONSTRAINT influencer_source_bindings_locators_lista CHECK (jsonb_typeof(origin_locators) = 'array'),
  -- Una clave, una persona; una participación, una clave (por fuente).
  CONSTRAINT influencer_source_bindings_clave_key UNIQUE (source_id, source_key),
  CONSTRAINT influencer_source_bindings_participacion_key UNIQUE (source_id, campaign_influencer_id)
);

CREATE INDEX influencer_source_bindings_participacion_idx ON influencer_source_bindings (campaign_influencer_id);

-- La participación y el influencer del binding deben ser de la MISMA persona.
CREATE OR REPLACE FUNCTION influencer_source_bindings_coherente() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM campaign_influencers
     WHERE id = NEW.campaign_influencer_id AND influencer_id = NEW.influencer_id
  ) THEN
    RAISE EXCEPTION 'El binding mezcla un influencer con la participación de otro.';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER influencer_source_bindings_persona
  BEFORE INSERT ON influencer_source_bindings
  FOR EACH ROW EXECUTE FUNCTION influencer_source_bindings_coherente();

-- ─────────────────────────── Efectos (procedencia) ─────────────────────────────

-- Qué creó o reutilizó cada registro. Responde «¿por qué existe este
-- CampaignInfluencer / esta asignación de producto?» → registro → plan → snapshot
-- → hoja y rango → fuente. `entity_id` es polimórfico (sin FK) a propósito: una
-- asignación de producto puede desasignarse después y su procedencia se conserva.
CREATE TABLE influencer_import_effects (
  id               uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id  uuid NOT NULL,
  campaign_id      uuid NOT NULL,
  record_id        uuid NOT NULL,
  entity_type      text NOT NULL,
  entity_id        uuid NOT NULL,
  -- created: lo creó este registro · existing: ya existía y se reutilizó.
  action           text NOT NULL,
  applied_by       uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at       timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT influencer_import_effects_record_fkey
    FOREIGN KEY (record_id, organization_id)
    REFERENCES influencer_import_records (id, organization_id) ON DELETE RESTRICT,
  CONSTRAINT influencer_import_effects_campaign_fkey
    FOREIGN KEY (campaign_id, organization_id)
    REFERENCES campaigns (id, organization_id) ON DELETE RESTRICT,
  CONSTRAINT influencer_import_effects_entidad_valida CHECK (
    entity_type IN ('influencer', 'influencer_account', 'campaign_influencer', 'campaign_influencer_product')),
  CONSTRAINT influencer_import_effects_accion_valida CHECK (action IN ('created', 'existing')),
  CONSTRAINT influencer_import_effects_unico UNIQUE (record_id, entity_type, entity_id)
);

CREATE INDEX influencer_import_effects_entidad_idx ON influencer_import_effects (entity_type, entity_id);

-- ─────────────────────────── Inmutabilidad ─────────────────────────────────────

-- Hechos históricos: el contenido de un plan, sus registros, las decisiones, los
-- bindings y los efectos no se reescriben ni se borran. Solo el `status` del plan
-- evoluciona (ready ⇄ needs_resolution → applied | superseded).
CREATE OR REPLACE FUNCTION influencer_import_historico_inmutable() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF inmutabilidad_bypass_activo() THEN RETURN OLD; END IF;
    RAISE EXCEPTION '% es histórico y no se borra.', TG_TABLE_NAME;
  END IF;
  RAISE EXCEPTION '% es histórico y no se modifica.', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER influencer_import_records_sin_cambios
  BEFORE UPDATE OR DELETE ON influencer_import_records
  FOR EACH ROW EXECUTE FUNCTION influencer_import_historico_inmutable();
CREATE TRIGGER influencer_import_resolutions_sin_cambios
  BEFORE UPDATE OR DELETE ON influencer_import_resolutions
  FOR EACH ROW EXECUTE FUNCTION influencer_import_historico_inmutable();
CREATE TRIGGER influencer_source_bindings_sin_cambios
  BEFORE UPDATE OR DELETE ON influencer_source_bindings
  FOR EACH ROW EXECUTE FUNCTION influencer_import_historico_inmutable();
CREATE TRIGGER influencer_import_effects_sin_cambios
  BEFORE UPDATE OR DELETE ON influencer_import_effects
  FOR EACH ROW EXECUTE FUNCTION influencer_import_historico_inmutable();

CREATE OR REPLACE FUNCTION influencer_import_plans_solo_estado() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF inmutabilidad_bypass_activo() THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'Un plan de importación es histórico y no se borra.';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
     OR NEW.campaign_id IS DISTINCT FROM OLD.campaign_id
     OR NEW.source_id IS DISTINCT FROM OLD.source_id
     OR NEW.snapshot_id IS DISTINCT FROM OLD.snapshot_id
     OR NEW.base_plan_id IS DISTINCT FROM OLD.base_plan_id
     OR NEW.schema_id IS DISTINCT FROM OLD.schema_id
     OR NEW.schema_version IS DISTINCT FROM OLD.schema_version
     OR NEW.validation IS DISTINCT FROM OLD.validation
     OR NEW.summary IS DISTINCT FROM OLD.summary
     OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.correlation IS DISTINCT FROM OLD.correlation
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'Un plan de importación solo cambia de estado: su contenido está ligado a su snapshot.';
  END IF;
  -- Un plan sin esquema válido no tiene nada que aplicar; un plan reemplazado es terminal.
  IF OLD.status = 'superseded' AND NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'Un plan reemplazado no vuelve a otro estado.';
  END IF;
  IF OLD.status = 'schema_invalid' AND NEW.status NOT IN ('schema_invalid', 'superseded') THEN
    RAISE EXCEPTION 'Un plan con esquema inválido no se aplica.';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER influencer_import_plans_solo_estado
  BEFORE UPDATE OR DELETE ON influencer_import_plans
  FOR EACH ROW EXECUTE FUNCTION influencer_import_plans_solo_estado();

COMMENT ON TABLE influencer_source_bindings IS
  'Clave estable de una fuente → persona y participación. Gana sobre re-inferir identidad en sincronizaciones posteriores.';
COMMENT ON TABLE influencer_import_effects IS
  'Procedencia: qué creó o reutilizó cada registro del plan (→ snapshot → hoja/rango).';
