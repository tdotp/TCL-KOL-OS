-- 029 · Envíos de producto (V2 · Fase 8, DEC-049).
--
-- Forward-only y aditiva: dos tablas nuevas, sus triggers y UNA guarda sobre una tabla existente
-- (`campaign_influencer_products`: un trigger BEFORE DELETE nuevo; no cambia filas, columnas ni
-- restricciones existentes).
--
--   campaign_influencers ─< shipments ─< shipment_items ─► campaign_products
--                              └─► influencer_pii_records (referencia segura; la dirección NO está aquí)
--
-- Principios impuestos AQUÍ (no solo en la aplicación):
--   · Un envío es la logística de UNA participación (clave compuesta org/campaña, patrón 016/023).
--   · La PII jamás está en el envío: solo `pii_record_id` (clave compuesta con la organización) y un
--     trigger exige que ese registro sea del MISMO influencer de la participación y no esté borrado.
--   · El costo del envío (`shipping_cost`/`shipping_currency`) es dato financiero interno (`finance:read`).
--   · Estados: pending → prepared → shipped → delivered; pending|prepared → cancelled; shipped → failed |
--     returned; delivered → returned. SOLO cambian con un evento humano (`operational_events`, 031):
--     `delivered` jamás se infiere de la asignación del producto. Reenviar = envío nuevo.
--   · En la transición a `prepared`: ≥ 1 ítem; cada ítem asignado a la participación en
--     `campaign_influencer_products`; y, si el acuerdo vigente es barter/mixed, comprometido en la versión
--     vigente. Producto asignado ≠ comprometido ≠ enviado ≠ entregado.
--   · Guarda sobre `campaign_influencer_products`: no se desasigna un producto comprometido en la versión
--     vigente de un acuerdo activo ni incluido en un envío abierto (pending|prepared|shipped).
--   · Sin DELETE ni TRUNCATE (solo el bypass de bases `_test`).

CREATE TABLE shipments (
  id                      uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id         uuid NOT NULL,
  campaign_id             uuid NOT NULL,
  campaign_influencer_id  uuid NOT NULL,
  status                  text NOT NULL DEFAULT 'pending',
  carrier                 text,
  tracking_ref            text,
  shipping_cost           numeric(14,2),
  shipping_currency       char(3),
  pii_record_id           uuid,
  cancel_reason           text,
  -- Contador de eventos del sujeto: 0 solo mientras se crea (el evento `shipment.created` lo lleva a 1).
  row_seq                 integer NOT NULL DEFAULT 0,
  -- FK hacia `operational_events` en la 031 (DEFERRABLE).
  last_event_id           uuid,
  created_by              uuid NOT NULL,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT shipments_campaign_fkey
    FOREIGN KEY (campaign_id, organization_id)
    REFERENCES campaigns (id, organization_id) ON DELETE RESTRICT,
  CONSTRAINT shipments_participacion_fkey
    FOREIGN KEY (campaign_influencer_id, campaign_id)
    REFERENCES campaign_influencers (id, campaign_id) ON DELETE RESTRICT,
  CONSTRAINT shipments_pii_fkey
    FOREIGN KEY (pii_record_id, organization_id)
    REFERENCES influencer_pii_records (id, organization_id) ON DELETE RESTRICT,
  CONSTRAINT shipments_autor_fkey
    FOREIGN KEY (created_by, organization_id)
    REFERENCES users (id, organization_id) ON DELETE RESTRICT,
  CONSTRAINT shipments_id_scope_key UNIQUE (id, organization_id, campaign_id),
  CONSTRAINT shipments_estado_valido
    CHECK (status IN ('pending', 'prepared', 'shipped', 'delivered', 'failed', 'returned', 'cancelled')),
  CONSTRAINT shipments_seq_valido CHECK (row_seq >= 0 AND (row_seq = 0) = (last_event_id IS NULL)),
  CONSTRAINT shipments_costo_valido CHECK (
    (shipping_cost IS NULL AND shipping_currency IS NULL)
    OR (shipping_cost IS NOT NULL AND shipping_cost >= 0
        AND shipping_currency IS NOT NULL AND shipping_currency ~ '^[A-Z]{3}$')
  ),
  CONSTRAINT shipments_transportadora_valida CHECK (
    carrier IS NULL OR (carrier = btrim(carrier) AND carrier <> '' AND char_length(carrier) <= 120
                        AND carrier !~ '[[:cntrl:]]')
  ),
  CONSTRAINT shipments_guia_valida CHECK (
    tracking_ref IS NULL OR (tracking_ref = btrim(tracking_ref) AND tracking_ref <> '' AND char_length(tracking_ref) <= 200
                             AND tracking_ref !~ '[[:cntrl:]]')
  ),
  -- Cancelado ⇔ motivo (y solo entonces).
  CONSTRAINT shipments_cancelacion_coherente CHECK (
    (status = 'cancelled') = (cancel_reason IS NOT NULL)
  ),
  CONSTRAINT shipments_motivo_valido CHECK (
    cancel_reason IS NULL
    OR (cancel_reason = btrim(cancel_reason) AND cancel_reason <> '' AND char_length(cancel_reason) <= 500)
  )
);

CREATE INDEX shipments_campaign_idx ON shipments (campaign_id, status);
CREATE INDEX shipments_participacion_idx ON shipments (campaign_influencer_id, status);

CREATE OR REPLACE FUNCTION shipments_integridad() RETURNS trigger AS $$
DECLARE
  c_estado    text;
  ci_estado   text;
  ci_persona  uuid;
  pii         influencer_pii_records%ROWTYPE;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'pending' OR NEW.row_seq <> 0 OR NEW.last_event_id IS NOT NULL OR NEW.cancel_reason IS NOT NULL THEN
      RAISE EXCEPTION 'Un envío nace pendiente (pending) y sin eventos (row_seq = 0): su evento de creación lo lleva a 1.';
    END IF;
    PERFORM operaciones_exigir_rol(NEW.created_by, 'manage_ops');
    -- FOR SHARE: archivar la campaña o retirar a la persona espera a que este alta termine.
    SELECT status::text INTO c_estado  FROM campaigns WHERE id = NEW.campaign_id FOR SHARE;
    SELECT status::text, influencer_id INTO ci_estado, ci_persona
      FROM campaign_influencers WHERE id = NEW.campaign_influencer_id FOR SHARE;
    IF c_estado IS DISTINCT FROM 'activa' OR ci_estado IS DISTINCT FROM 'activo' THEN
      RAISE EXCEPTION 'La campaña debe estar activa y el influencer activo en ella para registrar un envío.';
    END IF;
  ELSE
    IF inmutabilidad_bypass_activo() THEN RETURN NEW; END IF;
    IF (NEW.id, NEW.organization_id, NEW.campaign_id, NEW.campaign_influencer_id, NEW.created_by, NEW.created_at)
       IS DISTINCT FROM
       (OLD.id, OLD.organization_id, OLD.campaign_id, OLD.campaign_influencer_id, OLD.created_by, OLD.created_at) THEN
      RAISE EXCEPTION 'La identidad de un envío (campaña, participación, autor) no se modifica.';
    END IF;
    -- Un envío terminal es histórico: no se editan sus datos (el estado ya lo impide la máquina de estados).
    IF OLD.status IN ('cancelled', 'failed', 'returned')
       AND (NEW.carrier, NEW.tracking_ref, NEW.shipping_cost, NEW.shipping_currency, NEW.pii_record_id)
           IS DISTINCT FROM
           (OLD.carrier, OLD.tracking_ref, OLD.shipping_cost, OLD.shipping_currency, OLD.pii_record_id) THEN
      RAISE EXCEPTION 'Un envío % es histórico: sus datos no se modifican.', OLD.status;
    END IF;
    IF NEW.pii_record_id IS NOT DISTINCT FROM OLD.pii_record_id THEN
      RETURN NEW;
    END IF;
    SELECT influencer_id INTO ci_persona FROM campaign_influencers WHERE id = NEW.campaign_influencer_id;
  END IF;

  -- La referencia de PII debe ser del MISMO influencer de la participación y seguir vigente (no borrada).
  IF NEW.pii_record_id IS NOT NULL THEN
    SELECT * INTO pii FROM influencer_pii_records WHERE id = NEW.pii_record_id FOR SHARE;
    IF NOT FOUND OR pii.influencer_id <> ci_persona OR pii.organization_id <> NEW.organization_id THEN
      RAISE EXCEPTION 'El registro de datos personales no pertenece al influencer de esta participación.';
    END IF;
    IF pii.erased_at IS NOT NULL THEN
      RAISE EXCEPTION 'El registro de datos personales fue borrado: no se vincula a un envío.';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER shipments_integridad
  BEFORE INSERT OR UPDATE ON shipments
  FOR EACH ROW EXECUTE FUNCTION shipments_integridad();
CREATE TRIGGER shipments_set_updated_at
  BEFORE UPDATE ON shipments FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER shipments_sin_delete
  BEFORE DELETE ON shipments FOR EACH ROW EXECUTE FUNCTION operaciones_sin_delete();
CREATE TRIGGER shipments_sin_truncate
  BEFORE TRUNCATE ON shipments FOR EACH STATEMENT EXECUTE FUNCTION operaciones_sin_truncate();

-- ─────────────────────────── Ítems del envío ───────────────────────────────────

-- Producto y cantidad enviados. Se agregan mientras el envío está `pending`; después son historia.
CREATE TABLE shipment_items (
  id                   uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id      uuid NOT NULL,
  campaign_id          uuid NOT NULL,
  shipment_id          uuid NOT NULL,
  campaign_product_id  uuid NOT NULL,
  quantity             integer NOT NULL,
  created_by           uuid NOT NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT shipment_items_envio_fkey
    FOREIGN KEY (shipment_id, organization_id, campaign_id)
    REFERENCES shipments (id, organization_id, campaign_id) ON DELETE RESTRICT,
  -- El producto es de ESTA campaña.
  CONSTRAINT shipment_items_producto_fkey
    FOREIGN KEY (campaign_product_id, campaign_id)
    REFERENCES campaign_products (id, campaign_id) ON DELETE RESTRICT,
  CONSTRAINT shipment_items_autor_fkey
    FOREIGN KEY (created_by, organization_id)
    REFERENCES users (id, organization_id) ON DELETE RESTRICT,
  CONSTRAINT shipment_items_unico_key UNIQUE (shipment_id, campaign_product_id),
  CONSTRAINT shipment_items_cantidad_valida CHECK (quantity > 0 AND quantity <= 100000)
);

CREATE INDEX shipment_items_producto_idx ON shipment_items (campaign_product_id);

CREATE OR REPLACE FUNCTION shipment_items_integridad() RETURNS trigger AS $$
DECLARE
  s_estado  text;
BEGIN
  PERFORM operaciones_exigir_rol(NEW.created_by, 'manage_ops');
  -- FOR SHARE: pasar el envío a `prepared` espera a que este ítem termine (y luego lo ve).
  SELECT status INTO s_estado FROM shipments WHERE id = NEW.shipment_id FOR SHARE;
  IF s_estado IS DISTINCT FROM 'pending' THEN
    RAISE EXCEPTION 'Solo se agregan ítems a un envío pendiente (pending); este está «%». Cancele y cree un envío nuevo.',
      COALESCE(s_estado, 'inexistente');
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER shipment_items_integridad
  BEFORE INSERT ON shipment_items
  FOR EACH ROW EXECUTE FUNCTION shipment_items_integridad();
CREATE TRIGGER shipment_items_sin_update
  BEFORE UPDATE ON shipment_items FOR EACH ROW EXECUTE FUNCTION operaciones_sin_update();
CREATE TRIGGER shipment_items_sin_delete
  BEFORE DELETE ON shipment_items FOR EACH ROW EXECUTE FUNCTION operaciones_sin_delete();
CREATE TRIGGER shipment_items_sin_truncate
  BEFORE TRUNCATE ON shipment_items FOR EACH STATEMENT EXECUTE FUNCTION operaciones_sin_truncate();

-- ─────────────────────────── Preparar: reglas de producto ──────────────────────

-- Solo al ENTRAR en `prepared` (la validez de la transición misma la impone la 031).
CREATE OR REPLACE FUNCTION shipments_preparacion() RETURNS trigger AS $$
DECLARE
  a       agreements%ROWTYPE;
  av      agreement_versions%ROWTYPE;
  item    shipment_items%ROWTYPE;
  n_items integer := 0;
BEGIN
  IF inmutabilidad_bypass_activo() THEN RETURN NEW; END IF;
  SELECT * INTO a FROM agreements
   WHERE campaign_influencer_id = NEW.campaign_influencer_id AND status = 'active';
  IF FOUND AND a.current_version >= 1 THEN
    SELECT * INTO av FROM agreement_versions WHERE agreement_id = a.id AND version = a.current_version;
  END IF;

  FOR item IN SELECT * FROM shipment_items WHERE shipment_id = NEW.id LOOP
    n_items := n_items + 1;
    -- FOR SHARE: desasignar el producto espera a que este envío termine de prepararse.
    PERFORM 1 FROM campaign_influencer_products
     WHERE campaign_influencer_id = NEW.campaign_influencer_id AND campaign_product_id = item.campaign_product_id
       FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Un ítem del envío no está asignado a esta participación: asigne el producto antes de preparar el envío.';
    END IF;
    IF av.id IS NOT NULL AND av.compensation_type IN ('barter', 'mixed') AND NOT EXISTS (
      SELECT 1 FROM agreement_product_commitments
       WHERE agreement_version_id = av.id AND campaign_product_id = item.campaign_product_id
    ) THEN
      RAISE EXCEPTION 'Un ítem del envío no está comprometido en la versión vigente del acuerdo (%): agréguelo al acuerdo antes de enviarlo.',
        av.compensation_type;
    END IF;
  END LOOP;
  IF n_items = 0 THEN
    RAISE EXCEPTION 'Un envío sin ítems no se prepara.';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER shipments_preparacion
  BEFORE UPDATE OF status ON shipments
  FOR EACH ROW
  WHEN (NEW.status = 'prepared' AND OLD.status IS DISTINCT FROM 'prepared')
  EXECUTE FUNCTION shipments_preparacion();

-- ─────────────────────────── Guarda sobre `campaign_influencer_products` ───────

-- La desasignación (DELETE) sigue siendo legítima (016), salvo que el producto esté comprometido en la
-- versión vigente de un acuerdo activo de esa participación o en un envío abierto. (El bypass de bases
-- `_test` salta la guarda: la limpieza de pruebas.)
CREATE OR REPLACE FUNCTION campaign_influencer_products_guarda_delete() RETURNS trigger AS $$
BEGIN
  IF inmutabilidad_bypass_activo() THEN RETURN OLD; END IF;
  IF EXISTS (
    SELECT 1
      FROM agreement_product_commitments pc
      JOIN agreement_versions v ON v.id = pc.agreement_version_id
      JOIN agreements a ON a.id = v.agreement_id AND a.current_version = v.version AND a.status = 'active'
     WHERE a.campaign_influencer_id = OLD.campaign_influencer_id
       AND pc.campaign_product_id = OLD.campaign_product_id
  ) THEN
    RAISE EXCEPTION 'El producto está comprometido en el acuerdo vigente de esta participación: no se desasigna.';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM shipment_items si
      JOIN shipments s ON s.id = si.shipment_id
     WHERE s.campaign_influencer_id = OLD.campaign_influencer_id
       AND si.campaign_product_id = OLD.campaign_product_id
       AND s.status IN ('pending', 'prepared', 'shipped')
  ) THEN
    RAISE EXCEPTION 'El producto está en un envío abierto (pending, prepared o shipped) de esta participación: no se desasigna.';
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER campaign_influencer_products_guarda_delete
  BEFORE DELETE ON campaign_influencer_products
  FOR EACH ROW EXECUTE FUNCTION campaign_influencer_products_guarda_delete();
