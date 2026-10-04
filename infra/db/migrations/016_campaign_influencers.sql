-- 016 · CampaignInfluencer + producto asignado (V2 · Fase 3, parte 2: participación).
--
--   campaign_influencers           su participación en UNA campaña (punto de anclaje)
--   campaign_influencer_products   qué productos de ESA campaña trabaja
--
-- Forward-only y aditiva. Solo añade dos restricciones UNIQUE (id + columna de
-- aislamiento) a `campaigns` y `campaign_products` para poder referenciarlas
-- con claves compuestas; no cambia ninguna fila ni columna existentes.
--
-- Principios impuestos AQUÍ (no solo en la aplicación):
--   · Aislamiento: la participación lleva `organization_id` y claves foráneas
--     compuestas hacia la campaña y el influencer: no se cruzan organizaciones.
--   · Un influencer participa una sola vez por campaña (UNIQUE).
--   · Un producto asignado pertenece a la MISMA campaña (clave compuesta).
--   · Retirar a alguien de una campaña es un estado (`retirado`), no un borrado;
--     FK RESTRICT y sin DELETE de la participación (bypass solo en `_test`).
--
-- Fuera de esta migración (fases posteriores): acuerdos, fee/canje, envíos,
-- facturación, pagos, entregables, guiones, KPIs. Colgarán de
-- `campaign_influencers`; no se anticipan columnas.

CREATE TYPE campaign_influencer_status AS ENUM ('activo', 'retirado');

-- ─────────────────────────── Claves de referencia compuestas ───────────────────

ALTER TABLE campaigns
  ADD CONSTRAINT campaigns_id_organization_key UNIQUE (id, organization_id);

ALTER TABLE campaign_products
  ADD CONSTRAINT campaign_products_id_campaign_key UNIQUE (id, campaign_id);

-- ─────────────────────────── Participación en una campaña ──────────────────────

-- El punto de anclaje de contenido, operación y performance. Sin columnas de
-- acuerdo, fechas editoriales, KPIs, etc.: eso son entidades futuras.
-- `status`: retirar a un influencer de la campaña conserva la fila y su
-- historia (lo que cuelgue de ella después); no se borra.
CREATE TABLE campaign_influencers (
  id               uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id  uuid NOT NULL,
  campaign_id      uuid NOT NULL,
  influencer_id    uuid NOT NULL,
  status           campaign_influencer_status NOT NULL DEFAULT 'activo',
  retired_at       timestamptz,
  created_by       uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),

  -- Campaña e influencer son de la misma organización: no se cruzan tenants.
  CONSTRAINT campaign_influencers_campaign_fkey
    FOREIGN KEY (campaign_id, organization_id)
    REFERENCES campaigns (id, organization_id) ON DELETE RESTRICT,
  CONSTRAINT campaign_influencers_influencer_fkey
    FOREIGN KEY (influencer_id, organization_id)
    REFERENCES influencers (id, organization_id) ON DELETE RESTRICT,
  -- Una persona, una participación por campaña (aunque publique en varias plataformas).
  CONSTRAINT campaign_influencers_unique UNIQUE (campaign_id, influencer_id),
  -- Para que las relaciones hijas amarren su campaña.
  CONSTRAINT campaign_influencers_id_campaign_key UNIQUE (id, campaign_id),
  CONSTRAINT campaign_influencers_retiro_coherente
    CHECK ((status = 'retirado') = (retired_at IS NOT NULL))
);

CREATE INDEX campaign_influencers_campaign_idx ON campaign_influencers (campaign_id, status);
CREATE INDEX campaign_influencers_influencer_idx ON campaign_influencers (influencer_id);

-- ─────────────────────────── Producto asignado ─────────────────────────────────

-- Reutiliza `campaign_products` (no hay catálogo paralelo ni texto libre). La
-- clave compuesta (campaign_product_id, campaign_id) + (campaign_influencer_id,
-- campaign_id) hace IMPOSIBLE asignar un producto de otra campaña.
CREATE TABLE campaign_influencer_products (
  id                      uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  campaign_id             uuid NOT NULL,
  campaign_influencer_id  uuid NOT NULL,
  campaign_product_id     uuid NOT NULL,
  created_by              uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at              timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT campaign_influencer_products_influencer_fkey
    FOREIGN KEY (campaign_influencer_id, campaign_id)
    REFERENCES campaign_influencers (id, campaign_id) ON DELETE RESTRICT,
  CONSTRAINT campaign_influencer_products_product_fkey
    FOREIGN KEY (campaign_product_id, campaign_id)
    REFERENCES campaign_products (id, campaign_id) ON DELETE RESTRICT,
  CONSTRAINT campaign_influencer_products_unique UNIQUE (campaign_influencer_id, campaign_product_id)
);

CREATE INDEX campaign_influencer_products_product_idx ON campaign_influencer_products (campaign_product_id);

-- ─────────────────────────── updated_at e identidad inmutable ────────────────

CREATE TRIGGER campaign_influencers_set_updated_at
  BEFORE UPDATE ON campaign_influencers FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE OR REPLACE FUNCTION campaign_influencers_identidad_inmutable() RETURNS trigger AS $$
BEGIN
  IF NEW.organization_id IS DISTINCT FROM OLD.organization_id
     OR NEW.campaign_id IS DISTINCT FROM OLD.campaign_id
     OR NEW.influencer_id IS DISTINCT FROM OLD.influencer_id
     OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'campaign_influencers: campaña, influencer y organización no se modifican.';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER campaign_influencers_identidad
  BEFORE UPDATE ON campaign_influencers FOR EACH ROW EXECUTE FUNCTION campaign_influencers_identidad_inmutable();

-- La asignación de producto no se edita: se asigna o se desasigna.
CREATE OR REPLACE FUNCTION campaign_influencer_products_sin_update() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'campaign_influencer_products no admite UPDATE: se desasigna y se vuelve a asignar.';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER campaign_influencer_products_no_update
  BEFORE UPDATE ON campaign_influencer_products FOR EACH ROW EXECUTE FUNCTION campaign_influencer_products_sin_update();

-- ─────────────────────────── Sin DELETE de la participación ───────────────────

-- Reutiliza `entidad_influencer_sin_delete()` (015). La asignación de producto SÍ
-- admite DELETE: es un vínculo, y la desasignación queda en `audit_events`.
CREATE TRIGGER campaign_influencers_sin_delete
  BEFORE DELETE ON campaign_influencers FOR EACH ROW EXECUTE FUNCTION entidad_influencer_sin_delete();
