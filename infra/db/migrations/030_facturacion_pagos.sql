-- 030 · Documentos de cobro REGISTRADOS (V2 · Fase 8, DEC-049).
--
-- Forward-only y aditiva: UNA tabla nueva y sus triggers. No cambia ninguna fila ni columna existente.
--
--   payment_obligations ─< billing_documents ─► source_documents (tipo `soporte_operativo`)
--
-- Una cuenta de cobro / factura REGISTRADA es un hecho con soporte: el archivo vive como fuente
-- (`source_documents`, 026) y el documento lo referencia con claves compuestas organización/campaña.
-- Registrar ≠ validar ≠ pagar (DEC-014): aquí NO se mueve dinero ni se calculan impuestos; `claimed_*`
-- es lo que el documento DICE cobrar.
--
-- Principios impuestos AQUÍ (no solo en la aplicación):
--   · `source_document_id` es OBLIGATORIO, de la misma organización y campaña (FK compuestas) y de tipo
--     `soporte_operativo`.
--   · Los datos registrados (número, fecha, monto, moneda, fuente, obligación) son INMUTABLES: un error se
--     corrige anulando (`voided`) y registrando de nuevo.
--   · Estados: registered → validated | rejected ; registered | validated → voided. Terminales: rejected,
--     voided. SOLO cambian con un evento humano (031). Sellos `validated_by/at` los fija la 031 desde el evento.
--   · A lo sumo UN documento `validated` por obligación (índice único parcial); un mismo número y un mismo
--     archivo no se registran dos veces mientras el documento esté vivo (registered | validated).
--   · Solo se registra contra una obligación `pending` o `reported_paid`.
--   · Sin DELETE ni TRUNCATE (solo el bypass de bases `_test`).

CREATE TABLE billing_documents (
  id                     uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id        uuid NOT NULL,
  campaign_id            uuid NOT NULL,
  payment_obligation_id  uuid NOT NULL,
  document_number        text NOT NULL,
  issued_on              date NOT NULL,
  claimed_amount         numeric(14,2) NOT NULL,
  claimed_currency       char(3) NOT NULL,
  source_document_id     uuid NOT NULL,
  status                 text NOT NULL DEFAULT 'registered',
  row_seq                integer NOT NULL DEFAULT 0,
  -- FK hacia `operational_events` en la 031 (DEFERRABLE).
  last_event_id          uuid,
  validated_by           uuid,
  validated_at           timestamptz,
  created_by             uuid NOT NULL,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT billing_documents_obligacion_fkey
    FOREIGN KEY (payment_obligation_id, organization_id, campaign_id)
    REFERENCES payment_obligations (id, organization_id, campaign_id) ON DELETE RESTRICT,
  -- La fuente es de la misma organización Y de la misma campaña (patrón 023).
  CONSTRAINT billing_documents_fuente_org_fkey
    FOREIGN KEY (source_document_id, organization_id)
    REFERENCES source_documents (id, organization_id) ON DELETE RESTRICT,
  CONSTRAINT billing_documents_fuente_campaign_fkey
    FOREIGN KEY (source_document_id, campaign_id)
    REFERENCES source_documents (id, campaign_id) ON DELETE RESTRICT,
  CONSTRAINT billing_documents_autor_fkey
    FOREIGN KEY (created_by, organization_id)
    REFERENCES users (id, organization_id) ON DELETE RESTRICT,
  CONSTRAINT billing_documents_validador_fkey
    FOREIGN KEY (validated_by, organization_id)
    REFERENCES users (id, organization_id) ON DELETE RESTRICT,
  CONSTRAINT billing_documents_id_scope_key UNIQUE (id, organization_id, campaign_id),
  CONSTRAINT billing_documents_estado_valido
    CHECK (status IN ('registered', 'validated', 'rejected', 'voided')),
  CONSTRAINT billing_documents_seq_valido CHECK (row_seq >= 0 AND (row_seq = 0) = (last_event_id IS NULL)),
  CONSTRAINT billing_documents_numero_valido CHECK (
    document_number = btrim(document_number) AND document_number <> ''
    AND char_length(document_number) <= 100 AND document_number !~ '[[:cntrl:]]'
  ),
  CONSTRAINT billing_documents_monto_valido CHECK (claimed_amount > 0),
  CONSTRAINT billing_documents_moneda_valida CHECK (claimed_currency ~ '^[A-Z]{3}$'),
  CONSTRAINT billing_documents_validacion_par CHECK ((validated_at IS NULL) = (validated_by IS NULL)),
  -- `validated` lleva sello; `registered` y `rejected` nunca lo tuvieron; `voided` lo conserva si lo tuvo.
  CONSTRAINT billing_documents_validado_coherente CHECK (
    (status <> 'validated' OR validated_at IS NOT NULL)
    AND (status NOT IN ('registered', 'rejected') OR validated_at IS NULL)
  )
);

-- A lo sumo un documento validado por obligación.
CREATE UNIQUE INDEX billing_documents_validado_key
  ON billing_documents (payment_obligation_id) WHERE status = 'validated';
-- El mismo número / el mismo archivo no se registran dos veces mientras el documento está vivo.
CREATE UNIQUE INDEX billing_documents_numero_vivo_key
  ON billing_documents (payment_obligation_id, document_number) WHERE status IN ('registered', 'validated');
CREATE UNIQUE INDEX billing_documents_fuente_viva_key
  ON billing_documents (source_document_id) WHERE status IN ('registered', 'validated');
CREATE INDEX billing_documents_obligacion_idx ON billing_documents (payment_obligation_id, status);
CREATE INDEX billing_documents_campaign_idx ON billing_documents (campaign_id, status);

CREATE OR REPLACE FUNCTION billing_documents_integridad() RETURNS trigger AS $$
DECLARE
  o         payment_obligations%ROWTYPE;
  s_tipo    text;
  c_estado  text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'registered' OR NEW.row_seq <> 0 OR NEW.last_event_id IS NOT NULL
       OR NEW.validated_by IS NOT NULL OR NEW.validated_at IS NOT NULL THEN
      RAISE EXCEPTION 'Un documento de cobro nace registrado (registered), sin eventos (row_seq = 0) y sin sello de validación.';
    END IF;
    PERFORM operaciones_exigir_rol(NEW.created_by, 'manage_ops');
    SELECT status::text INTO c_estado FROM campaigns WHERE id = NEW.campaign_id FOR SHARE;
    IF c_estado IS NULL OR c_estado = 'cancelada' THEN
      RAISE EXCEPTION 'La campaña está cancelada: no se registran documentos de cobro.';
    END IF;
    -- FOR SHARE: pasar la obligación a not_applicable/cancelled espera a que este registro termine.
    SELECT * INTO o FROM payment_obligations WHERE id = NEW.payment_obligation_id FOR SHARE;
    IF NOT FOUND OR o.status NOT IN ('pending', 'reported_paid') THEN
      RAISE EXCEPTION 'Solo se registra un documento de cobro contra una obligación de pago pendiente o ya reportada (estado actual: %).',
        COALESCE(o.status, 'inexistente');
    END IF;
    -- La evidencia es una fuente de soporte operativo (no un guion, un brief ni un enlace).
    SELECT type::text INTO s_tipo FROM source_documents WHERE id = NEW.source_document_id FOR SHARE;
    IF s_tipo IS DISTINCT FROM 'soporte_operativo' THEN
      RAISE EXCEPTION 'El soporte del documento de cobro debe ser una fuente de tipo soporte_operativo.';
    END IF;
    RETURN NEW;
  END IF;

  -- UPDATE
  IF inmutabilidad_bypass_activo() THEN RETURN NEW; END IF;
  IF (NEW.id, NEW.organization_id, NEW.campaign_id, NEW.payment_obligation_id, NEW.document_number,
      NEW.issued_on, NEW.claimed_amount, NEW.claimed_currency, NEW.source_document_id, NEW.created_by, NEW.created_at)
     IS DISTINCT FROM
     (OLD.id, OLD.organization_id, OLD.campaign_id, OLD.payment_obligation_id, OLD.document_number,
      OLD.issued_on, OLD.claimed_amount, OLD.claimed_currency, OLD.source_document_id, OLD.created_by, OLD.created_at) THEN
    RAISE EXCEPTION 'Un documento de cobro registrado no se edita: anúlelo (voided) y regístrelo de nuevo.';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER billing_documents_integridad
  BEFORE INSERT OR UPDATE ON billing_documents
  FOR EACH ROW EXECUTE FUNCTION billing_documents_integridad();
CREATE TRIGGER billing_documents_set_updated_at
  BEFORE UPDATE ON billing_documents FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER billing_documents_sin_delete
  BEFORE DELETE ON billing_documents FOR EACH ROW EXECUTE FUNCTION operaciones_sin_delete();
CREATE TRIGGER billing_documents_sin_truncate
  BEFORE TRUNCATE ON billing_documents FOR EACH STATEMENT EXECUTE FUNCTION operaciones_sin_truncate();
