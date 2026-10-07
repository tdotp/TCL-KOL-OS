-- 033 · Endurecimiento de la operación (V2 · Fase 8, FIX-B tras el QA adversarial independiente).
--
-- Forward-only y aditiva: NO edita 001–032. Solo agrega restricciones CHECK sobre tablas nuevas de F8 y redefine
-- (CREATE OR REPLACE FUNCTION) cinco funciones de trigger ya existentes, más un trigger que cambia su condición.
-- Ningún dato válido preexistente puede fallar: lo que se endurece era un hueco que el QA demostró.
--
--   1. NaN: `numeric` acepta 'NaN' y `NaN > 0` es VERDADERO, así que `fee_amount > 0`, `claimed_amount > 0`,
--      `shipping_cost >= 0` y `value >= 0` lo dejaban pasar. Se agrega `<> 'NaN'` a las cinco columnas de dinero/KPI.
--   2. Envío (029 `shipments_integridad`): una vez `delivered`, `cancelled`, `failed` o `returned`, el envío es
--      historia: transportadora, guía, costo, moneda, referencia de PII y motivo ya no cambian por UPDATE (antes
--      `delivered` quedaba abierto y el motivo de cancelación no estaba protegido). El motivo, una vez fijado, es
--      inmutable. Un envío nuevo (o un cambio de referencia) solo enlaza la versión VIGENTE de PII del influencer.
--   3. Envío (029 `shipments_preparacion`): la revalidación «producto asignado y, en canje/mixto, comprometido en
--      la versión vigente» corre también al pasar a `shipped` (antes solo a `prepared`: una versión nueva del
--      acuerdo entre ambos pasos dejaba enviar un producto ya no comprometido).
--   4. Evento operativo (031 `operational_events_integridad`): «entregado» no se fecha antes que «enviado».
--   5. Evidencia (031 `source_documents_soporte_operativo_guarda`): `created_at` de una fuente `soporte_operativo`
--      es inmutable (era reescribible por UPDATE: la marca de tiempo de una evidencia no es evidencia).
--   6. KPI: la etiqueta de una métrica `other` se guarda normalizada NFKC (la aplicación ya lo hace); la base lo
--      exige para que dos escrituras equivalentes no convivan como objetivos vigentes del mismo ámbito.

-- ─────────────────────────── 1. NaN ────────────────────────────────────────────

ALTER TABLE agreement_versions
  ADD CONSTRAINT agreement_versions_fee_finito CHECK (fee_amount <> 'NaN'::numeric);
ALTER TABLE shipments
  ADD CONSTRAINT shipments_costo_finito CHECK (shipping_cost <> 'NaN'::numeric);
ALTER TABLE billing_documents
  ADD CONSTRAINT billing_documents_monto_finito CHECK (claimed_amount <> 'NaN'::numeric);
ALTER TABLE kpi_targets
  ADD CONSTRAINT kpi_targets_valor_finito CHECK (target_value <> 'NaN'::numeric);
ALTER TABLE kpi_measurements
  ADD CONSTRAINT kpi_measurements_valor_finito CHECK (value <> 'NaN'::numeric);

-- ─────────────────────────── 6. KPI: etiqueta NFKC ─────────────────────────────

ALTER TABLE kpi_targets
  ADD CONSTRAINT kpi_targets_etiqueta_nfkc CHECK (other_label IS NULL OR other_label = normalize(other_label, NFKC));

-- ─────────────────────────── 2. Envío: historia congelada y PII vigente ────────

CREATE OR REPLACE FUNCTION shipments_integridad() RETURNS trigger AS $$
DECLARE
  c_estado    text;
  ci_estado   text;
  ci_persona  uuid;
  pii         influencer_pii_records%ROWTYPE;
  pii_vigente integer;
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
    -- Un envío entregado, cancelado, fallido o devuelto es histórico: no se editan sus datos (el estado ya lo
    -- impide la máquina de estados). Un pasaje a esos estados parte de un estado abierto (OLD.status), así que la
    -- transición que fija el motivo o la guía sigue siendo posible.
    IF OLD.status IN ('delivered', 'cancelled', 'failed', 'returned')
       AND (NEW.carrier, NEW.tracking_ref, NEW.shipping_cost, NEW.shipping_currency, NEW.pii_record_id,
            NEW.cancel_reason)
           IS DISTINCT FROM
           (OLD.carrier, OLD.tracking_ref, OLD.shipping_cost, OLD.shipping_currency, OLD.pii_record_id,
            OLD.cancel_reason) THEN
      RAISE EXCEPTION 'Un envío % es histórico: sus datos no se modifican.', OLD.status;
    END IF;
    -- El motivo de cancelación, una vez fijado, no cambia.
    IF OLD.cancel_reason IS NOT NULL AND NEW.cancel_reason IS DISTINCT FROM OLD.cancel_reason THEN
      RAISE EXCEPTION 'El motivo de cancelación de un envío no se modifica.';
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
    -- Solo la versión VIGENTE: un envío nuevo no se ata a una dirección que ya fue reemplazada.
    SELECT max(version) INTO pii_vigente FROM influencer_pii_records WHERE influencer_id = pii.influencer_id;
    IF pii.version <> pii_vigente THEN
      RAISE EXCEPTION 'El registro de datos personales no es la versión vigente del influencer (versión % de %).',
        pii.version, pii_vigente;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ─────────────────────────── 3. Envío: revalidar al pasar a `shipped` ──────────

-- La función (029) ya revisa ítems asignados y comprometidos; solo cambia CUÁNDO se dispara.
DROP TRIGGER IF EXISTS shipments_preparacion ON shipments;
CREATE TRIGGER shipments_preparacion
  BEFORE UPDATE OF status ON shipments
  FOR EACH ROW
  WHEN (NEW.status IN ('prepared', 'shipped') AND OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION shipments_preparacion();

-- ─────────────────────────── 4. Evento: entregado no antes que enviado ─────────

CREATE OR REPLACE FUNCTION operational_events_integridad() RETURNS trigger AS $$
DECLARE
  s_status  text;
  s_seq     integer;
  v_enviado date;
BEGIN
  -- Bloquea el sujeto (reentrante con el FOR UPDATE del caso de uso) y lee su estado vigente.
  IF NEW.subject_type = 'shipment' THEN
    SELECT status, row_seq INTO s_status, s_seq FROM shipments WHERE id = NEW.shipment_id FOR UPDATE;
  ELSIF NEW.subject_type = 'billing_document' THEN
    SELECT status, row_seq INTO s_status, s_seq FROM billing_documents WHERE id = NEW.billing_document_id FOR UPDATE;
  ELSE
    SELECT status, row_seq INTO s_status, s_seq FROM payment_obligations WHERE id = NEW.payment_obligation_id FOR UPDATE;
  END IF;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'El sujeto del evento no existe.' USING ERRCODE = 'foreign_key_violation';
  END IF;

  IF NEW.subject_seq <> s_seq + 1 THEN
    RAISE EXCEPTION 'El evento llega con subject_seq % pero el sujeto va en %: la secuencia no tiene huecos ni repeticiones.',
      NEW.subject_seq, s_seq;
  END IF;
  IF NEW.to_status IS NOT NULL THEN
    IF NEW.from_status IS NULL THEN
      -- Creación: el sujeto aún no tiene eventos y nació en ese estado.
      IF s_seq <> 0 OR s_status <> NEW.to_status THEN
        RAISE EXCEPTION 'El evento de creación no coincide con el estado inicial del sujeto.';
      END IF;
    ELSIF s_status <> NEW.from_status THEN
      RAISE EXCEPTION 'El estado de origen del evento (%) no es el estado vigente del sujeto (%).', NEW.from_status, s_status;
    END IF;
  ELSIF NEW.event_type = 'payment.correction_noted' AND s_status <> 'reported_paid' THEN
    RAISE EXCEPTION 'Solo un pago ya reportado admite una corrección anotada.';
  END IF;

  -- Rol vigente de quien registra: reportar el pago exige report_payment; el resto, manage_ops.
  PERFORM operaciones_exigir_rol(
    NEW.recorded_by,
    CASE WHEN NEW.event_type = 'payment.reported' THEN 'report_payment' ELSE 'manage_ops' END
  );

  IF NEW.happened_on IS NOT NULL AND NEW.happened_on > current_date + 1 THEN
    RAISE EXCEPTION 'La fecha del hecho no puede estar en el futuro.';
  END IF;
  -- «Entregado» no se fecha antes que «enviado» (el envío se marca una sola vez: prepared → shipped).
  IF NEW.event_type = 'shipment.delivered' AND NEW.happened_on IS NOT NULL THEN
    SELECT happened_on INTO v_enviado
      FROM operational_events
     WHERE shipment_id = NEW.shipment_id AND event_type = 'shipment.shipped';
    IF v_enviado IS NOT NULL AND NEW.happened_on < v_enviado THEN
      RAISE EXCEPTION 'La entrega (%) no puede fecharse antes del envío (%).', NEW.happened_on, v_enviado;
    END IF;
  END IF;
  NEW.recorded_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ─────────────────────────── 5. Evidencia: la marca de tiempo no se reescribe ──

CREATE OR REPLACE FUNCTION source_documents_soporte_operativo_guarda() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    -- El tipo es de nacimiento: ni se vuelve soporte operativo ni deja de serlo.
    IF OLD.type IS DISTINCT FROM NEW.type
       AND (OLD.type = 'soporte_operativo' OR NEW.type = 'soporte_operativo') THEN
      RAISE EXCEPTION 'El tipo soporte_operativo se fija al crear la fuente y no cambia.';
    END IF;
    -- El original de una evidencia no cambia (ni su marca de creación).
    IF OLD.type = 'soporte_operativo'
       AND (NEW.hash, NEW.filename, NEW.file_id, NEW.mime_type, NEW.size_bytes, NEW.campaign_id,
            NEW.organization_id, NEW.origin, NEW.storage_provider, NEW.created_at)
           IS DISTINCT FROM
           (OLD.hash, OLD.filename, OLD.file_id, OLD.mime_type, OLD.size_bytes, OLD.campaign_id,
            OLD.organization_id, OLD.origin, OLD.storage_provider, OLD.created_at) THEN
      RAISE EXCEPTION 'El original de una evidencia operativa no cambia.';
    END IF;
  END IF;
  IF NEW.type = 'soporte_operativo' THEN
    IF NEW.origin <> 'file' THEN
      RAISE EXCEPTION 'La evidencia operativa es un archivo, no un enlace.';
    END IF;
    IF NEW.visibility <> 'interna' THEN
      RAISE EXCEPTION 'La evidencia operativa es siempre interna: no se expone a TCL.';
    END IF;
    IF NEW.confidentiality_level <> 'sensible' THEN
      RAISE EXCEPTION 'La evidencia operativa es siempre de confidencialidad sensible.';
    END IF;
    IF NEW.status <> 'procesado' THEN
      RAISE EXCEPTION 'La evidencia operativa no se procesa: nace en estado procesado.';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
