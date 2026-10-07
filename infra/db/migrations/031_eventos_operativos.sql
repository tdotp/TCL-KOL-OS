-- 031 · Eventos operativos, evidencia y máquinas de estado (V2 · Fase 8, DEC-049).
--
-- Forward-only y aditiva: dos tablas nuevas, FKs y triggers sobre las tablas F8 de 027/029/030 y tres
-- triggers de guarda sobre `source_documents`, `processing_jobs` y `source_fragments` (triggers NUEVOS;
-- no cambian filas, columnas ni restricciones existentes, y solo se evalúan sobre filas nuevas o sobre
-- fuentes de tipo `soporte_operativo`, que antes de la 026 no existían: ningún dato preexistente puede fallar).
--
--   shipments ┐
--   billing_documents ├─< operational_events ─< operational_evidence ─► source_documents (soporte_operativo)
--   payment_obligations ┘        ▲
--              └── last_event_id ┘   (FK DEFERRABLE: resuelve la dependencia circular sujeto ↔ evento)
--
-- MECANISMO (F8_FREEZE §3): el caso de uso, en UNA transacción, bloquea el sujeto FOR UPDATE, compara
-- `expected_seq`, inserta el evento (idempotente por `idempotency_key`) y actualiza `status`, `row_seq + 1`
-- y `last_event_id` del sujeto. La base impone que SOLO así cambie `status`: el trigger BEFORE UPDATE de
-- cada tabla de estado valida el grafo y exige que `NEW.last_event_id` sea un evento del MISMO sujeto con
-- `to_status = NEW.status`, `from_status = OLD.status` y `subject_seq = NEW.row_seq`. Un UPDATE directo de
-- `status` sin evento falla. Creación: el sujeto nace con `row_seq = 0` y su evento de creación
-- (`shipment.created` | `billing.registered` | `payment.applicability_set`, `from_status` NULL) lo lleva a 1;
-- un trigger diferido rechaza cualquier sujeto o evento que quede sin aplicar al cerrar la transacción.
-- Las notas/evidencias (`to_status` NULL) también avanzan `row_seq` (cada evento tiene su `subject_seq`).
--
-- Principios impuestos AQUÍ (no solo en la aplicación):
--   · `operational_events` es APPEND-ONLY (sin UPDATE/DELETE/TRUNCATE), `origin = 'ui'` (CHECK: la IA, el
--     sistema y el chat no registran estado operativo), UNIQUE(org, idempotency_key), UNIQUE por sujeto
--     (sujeto, subject_seq), exactamente UNA FK de sujeto según `subject_type`, `event_type` en lista
--     cerrada, `recorded_by` obligatorio con rol vigente (payment.reported ⇒ report_payment; resto ⇒
--     manage_ops). La arista (tipo de evento, desde, hacia) es la ÚNICA definición del grafo de estados.
--   · `operational_evidence`: la evidencia es una FUENTE (`soporte_operativo`), misma organización y campaña;
--     solo se adjunta en la misma transacción que su evento; se «retira» con una marca, nunca con DELETE.
--   · Fuentes `soporte_operativo`: sin processing_jobs, sin fragmentos, visibilidad siempre `interna`,
--     `confidentiality_level = 'sensible'`, origen `file`, estado `procesado`, original inmutable.
--   · `note` es interna: jamás va a auditoría ni al agente (la UI avisa «no escriba datos personales»).

-- ─────────────────────────── 1. El grafo: aristas por tipo de evento ────────────

-- Fuente única de los grafos de estado (`packages/domain/src/{shipments,billing-payment,operational-events}.ts`
-- la espeja; una prueba de paridad ejecuta la matriz contra esta función).
CREATE OR REPLACE FUNCTION operaciones_arista_valida(p_tipo text, p_desde text, p_hacia text) RETURNS boolean AS $$
  SELECT EXISTS (
    SELECT 1
      FROM (VALUES
        ('shipment.created',            NULL::text,       'pending'),
        ('shipment.prepared',           'pending',        'prepared'),
        ('shipment.shipped',            'prepared',       'shipped'),
        ('shipment.delivered',          'shipped',        'delivered'),
        ('shipment.failed',             'shipped',        'failed'),
        ('shipment.returned',           'shipped',        'returned'),
        ('shipment.returned',           'delivered',      'returned'),
        ('shipment.cancelled',          'pending',        'cancelled'),
        ('shipment.cancelled',          'prepared',       'cancelled'),
        ('billing.registered',          NULL,             'registered'),
        ('billing.validated',           'registered',     'validated'),
        ('billing.rejected',            'registered',     'rejected'),
        ('billing.voided',              'registered',     'voided'),
        ('billing.voided',              'validated',      'voided'),
        ('payment.applicability_set',   NULL,             'not_applicable'),
        ('payment.applicability_set',   NULL,             'pending'),
        ('payment.applicability_set',   'not_applicable', 'pending'),
        ('payment.applicability_set',   'pending',        'not_applicable'),
        ('payment.reported',            'pending',        'reported_paid'),
        ('payment.cancelled',           'pending',        'cancelled'),
        ('payment.cancelled',           'not_applicable', 'cancelled')
      ) AS a(tipo, desde, hacia)
     WHERE a.tipo = p_tipo
       AND a.desde IS NOT DISTINCT FROM p_desde
       AND a.hacia = p_hacia
  );
$$ LANGUAGE sql IMMUTABLE;

-- ─────────────────────────── 2. Eventos operativos ─────────────────────────────

CREATE TABLE operational_events (
  id                      uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id         uuid NOT NULL,
  campaign_id             uuid NOT NULL,
  subject_type            text NOT NULL,
  -- Exactamente UNA según `subject_type`.
  shipment_id             uuid,
  billing_document_id     uuid,
  payment_obligation_id   uuid,
  event_type              text NOT NULL,
  from_status             text,
  -- NULL = nota/evidencia (no cambia el estado del sujeto).
  to_status               text,
  -- Posición del evento en la historia del sujeto (1 = creación): la lleva el sujeto en `row_seq`.
  subject_seq             integer NOT NULL,
  occurred_at             timestamptz NOT NULL DEFAULT now(),
  -- La fija el trigger (hora de la transacción): no se declara.
  recorded_at             timestamptz NOT NULL DEFAULT now(),
  recorded_by             uuid NOT NULL,
  origin                  text NOT NULL DEFAULT 'ui',
  idempotency_key         text NOT NULL,
  -- Huella (SHA-256 hex) de la solicitud: la misma clave con otra huella es un conflicto.
  request_hash            text NOT NULL,
  external_reference      text,
  happened_on             date,
  -- INTERNA: jamás a auditoría ni al agente.
  note                    text,

  CONSTRAINT operational_events_campaign_fkey
    FOREIGN KEY (campaign_id, organization_id)
    REFERENCES campaigns (id, organization_id) ON DELETE RESTRICT,
  CONSTRAINT operational_events_envio_fkey
    FOREIGN KEY (shipment_id, organization_id, campaign_id)
    REFERENCES shipments (id, organization_id, campaign_id) ON DELETE RESTRICT,
  CONSTRAINT operational_events_documento_fkey
    FOREIGN KEY (billing_document_id, organization_id, campaign_id)
    REFERENCES billing_documents (id, organization_id, campaign_id) ON DELETE RESTRICT,
  CONSTRAINT operational_events_obligacion_fkey
    FOREIGN KEY (payment_obligation_id, organization_id, campaign_id)
    REFERENCES payment_obligations (id, organization_id, campaign_id) ON DELETE RESTRICT,
  CONSTRAINT operational_events_autor_fkey
    FOREIGN KEY (recorded_by, organization_id)
    REFERENCES users (id, organization_id) ON DELETE RESTRICT,
  CONSTRAINT operational_events_idempotencia_key UNIQUE (organization_id, idempotency_key),
  CONSTRAINT operational_events_envio_seq_key UNIQUE (shipment_id, subject_seq),
  CONSTRAINT operational_events_documento_seq_key UNIQUE (billing_document_id, subject_seq),
  CONSTRAINT operational_events_obligacion_seq_key UNIQUE (payment_obligation_id, subject_seq),
  CONSTRAINT operational_events_id_scope_key UNIQUE (id, organization_id, campaign_id),
  -- Solo una persona por la UI: la IA, el sistema y el chat no registran estado operativo.
  CONSTRAINT operational_events_origen_ui CHECK (origin = 'ui'),
  CONSTRAINT operational_events_sujeto_valido
    CHECK (subject_type IN ('shipment', 'billing_document', 'payment_obligation')),
  -- Exactamente UNA FK de sujeto, la del tipo.
  CONSTRAINT operational_events_sujeto_unico CHECK (
    (subject_type = 'shipment'
       AND shipment_id IS NOT NULL AND billing_document_id IS NULL AND payment_obligation_id IS NULL)
    OR (subject_type = 'billing_document'
       AND billing_document_id IS NOT NULL AND shipment_id IS NULL AND payment_obligation_id IS NULL)
    OR (subject_type = 'payment_obligation'
       AND payment_obligation_id IS NOT NULL AND shipment_id IS NULL AND billing_document_id IS NULL)
  ),
  -- Lista CERRADA de tipos de evento.
  CONSTRAINT operational_events_tipo_valido CHECK (event_type IN (
    'shipment.created', 'shipment.prepared', 'shipment.shipped', 'shipment.delivered',
    'shipment.failed', 'shipment.returned', 'shipment.cancelled',
    'billing.registered', 'billing.validated', 'billing.rejected', 'billing.voided',
    'payment.applicability_set', 'payment.reported', 'payment.cancelled', 'payment.correction_noted',
    'evidence.attached'
  )),
  -- El tipo de evento es del sujeto (la evidencia puede colgar de cualquiera).
  CONSTRAINT operational_events_tipo_sujeto CHECK (
    (event_type LIKE 'shipment.%' AND subject_type = 'shipment')
    OR (event_type LIKE 'billing.%' AND subject_type = 'billing_document')
    OR (event_type LIKE 'payment.%' AND subject_type = 'payment_obligation')
    OR event_type = 'evidence.attached'
  ),
  -- Solo las notas (corrección de pago, evidencia) carecen de estado destino; y entonces tampoco de origen.
  CONSTRAINT operational_events_nota_coherente CHECK (
    (to_status IS NULL) = (event_type IN ('payment.correction_noted', 'evidence.attached'))
    AND (to_status IS NOT NULL OR from_status IS NULL)
  ),
  -- Estados del dominio del sujeto.
  CONSTRAINT operational_events_estados_validos CHECK (
    (subject_type = 'shipment'
       AND (from_status IS NULL OR from_status IN ('pending', 'prepared', 'shipped', 'delivered', 'failed', 'returned', 'cancelled'))
       AND (to_status   IS NULL OR to_status   IN ('pending', 'prepared', 'shipped', 'delivered', 'failed', 'returned', 'cancelled')))
    OR (subject_type = 'billing_document'
       AND (from_status IS NULL OR from_status IN ('registered', 'validated', 'rejected', 'voided'))
       AND (to_status   IS NULL OR to_status   IN ('registered', 'validated', 'rejected', 'voided')))
    OR (subject_type = 'payment_obligation'
       AND (from_status IS NULL OR from_status IN ('not_applicable', 'pending', 'reported_paid', 'cancelled'))
       AND (to_status   IS NULL OR to_status   IN ('not_applicable', 'pending', 'reported_paid', 'cancelled')))
  ),
  -- El grafo: la arista (tipo, desde, hacia) existe.
  CONSTRAINT operational_events_arista_valida CHECK (
    to_status IS NULL OR operaciones_arista_valida(event_type, from_status, to_status)
  ),
  -- El primer evento del sujeto (seq 1) es su creación (sin estado de origen); ningún otro lo es.
  CONSTRAINT operational_events_seq_valido CHECK (
    subject_seq >= 1 AND ((subject_seq = 1) = (from_status IS NULL AND to_status IS NOT NULL))
  ),
  -- Hechos que sostienen el sello: cuándo se envió/entregó/pagó y la referencia externa del pago.
  CONSTRAINT operational_events_hechos_requeridos CHECK (
    (event_type NOT IN ('shipment.shipped', 'shipment.delivered', 'payment.reported') OR happened_on IS NOT NULL)
    AND (event_type <> 'payment.reported' OR external_reference IS NOT NULL)
  ),
  CONSTRAINT operational_events_clave_valida CHECK (
    idempotency_key = btrim(idempotency_key) AND idempotency_key <> ''
    AND char_length(idempotency_key) <= 200 AND idempotency_key !~ '[[:cntrl:]]'
  ),
  CONSTRAINT operational_events_huella_valida CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT operational_events_referencia_valida CHECK (
    external_reference IS NULL
    OR (external_reference = btrim(external_reference) AND external_reference <> ''
        AND char_length(external_reference) <= 200)
  ),
  CONSTRAINT operational_events_nota_valida CHECK (
    note IS NULL OR (btrim(note) <> '' AND char_length(note) <= 2000)
  )
);

CREATE INDEX operational_events_campaign_idx ON operational_events (campaign_id, recorded_at);

-- Resuelve la dependencia circular sujeto ↔ evento: el sujeto apunta a su último evento. DEFERRABLE
-- INITIALLY DEFERRED (el evento se inserta antes de que el sujeto lo referencie, y la limpieza de pruebas
-- borra ambos en una transacción). NO ACTION a propósito.
ALTER TABLE shipments
  ADD CONSTRAINT shipments_last_event_fkey
  FOREIGN KEY (last_event_id, organization_id, campaign_id)
  REFERENCES operational_events (id, organization_id, campaign_id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE billing_documents
  ADD CONSTRAINT billing_documents_last_event_fkey
  FOREIGN KEY (last_event_id, organization_id, campaign_id)
  REFERENCES operational_events (id, organization_id, campaign_id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE payment_obligations
  ADD CONSTRAINT payment_obligations_last_event_fkey
  FOREIGN KEY (last_event_id, organization_id, campaign_id)
  REFERENCES operational_events (id, organization_id, campaign_id) DEFERRABLE INITIALLY DEFERRED;

CREATE OR REPLACE FUNCTION operational_events_integridad() RETURNS trigger AS $$
DECLARE
  s_status  text;
  s_seq     integer;
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
  NEW.recorded_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER operational_events_integridad
  BEFORE INSERT ON operational_events
  FOR EACH ROW EXECUTE FUNCTION operational_events_integridad();
CREATE TRIGGER operational_events_sin_update
  BEFORE UPDATE ON operational_events FOR EACH ROW EXECUTE FUNCTION operaciones_sin_update();
CREATE TRIGGER operational_events_sin_delete
  BEFORE DELETE ON operational_events FOR EACH ROW EXECUTE FUNCTION operaciones_sin_delete();
CREATE TRIGGER operational_events_sin_truncate
  BEFORE TRUNCATE ON operational_events FOR EACH STATEMENT EXECUTE FUNCTION operaciones_sin_truncate();

-- ─────────────────────────── 3. Evidencia operativa ────────────────────────────

CREATE TABLE operational_evidence (
  id                  uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id     uuid NOT NULL,
  campaign_id         uuid NOT NULL,
  event_id            uuid NOT NULL,
  source_document_id  uuid NOT NULL,
  kind                text NOT NULL,
  attached_by         uuid NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  -- Retirar = marca (única mutación); el vínculo y la fuente se conservan.
  retracted_at        timestamptz,
  retracted_by        uuid,

  CONSTRAINT operational_evidence_evento_fkey
    FOREIGN KEY (event_id, organization_id, campaign_id)
    REFERENCES operational_events (id, organization_id, campaign_id) ON DELETE RESTRICT,
  -- La fuente es de la misma organización Y de la misma campaña (patrón 023).
  CONSTRAINT operational_evidence_fuente_org_fkey
    FOREIGN KEY (source_document_id, organization_id)
    REFERENCES source_documents (id, organization_id) ON DELETE RESTRICT,
  CONSTRAINT operational_evidence_fuente_campaign_fkey
    FOREIGN KEY (source_document_id, campaign_id)
    REFERENCES source_documents (id, campaign_id) ON DELETE RESTRICT,
  CONSTRAINT operational_evidence_autor_fkey
    FOREIGN KEY (attached_by, organization_id)
    REFERENCES users (id, organization_id) ON DELETE RESTRICT,
  CONSTRAINT operational_evidence_retiro_fkey
    FOREIGN KEY (retracted_by, organization_id)
    REFERENCES users (id, organization_id) ON DELETE RESTRICT,
  CONSTRAINT operational_evidence_unica_key UNIQUE (event_id, source_document_id),
  CONSTRAINT operational_evidence_tipo_valido
    CHECK (kind IN ('guia', 'cotizacion', 'orden_compra', 'cuenta_cobro', 'comprobante', 'soporte', 'otro')),
  CONSTRAINT operational_evidence_retiro_par CHECK ((retracted_at IS NULL) = (retracted_by IS NULL))
);

CREATE INDEX operational_evidence_fuente_idx ON operational_evidence (source_document_id);
CREATE INDEX operational_evidence_campaign_idx ON operational_evidence (campaign_id);

CREATE OR REPLACE FUNCTION operational_evidence_integridad() RETURNS trigger AS $$
DECLARE
  ev        operational_events%ROWTYPE;
  s_tipo    text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.retracted_at IS NOT NULL OR NEW.retracted_by IS NOT NULL THEN
      RAISE EXCEPTION 'La evidencia nace vigente (sin marca de retiro).';
    END IF;
    PERFORM operaciones_exigir_rol(NEW.attached_by, 'manage_ops');
    SELECT * INTO ev FROM operational_events WHERE id = NEW.event_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'El evento no existe.' USING ERRCODE = 'foreign_key_violation';
    END IF;
    -- Evento y evidencia son UN hecho: se adjuntan en la misma transacción (recorded_at = hora de la
    -- transacción). Adjuntar después es un evento `evidence.attached` nuevo.
    IF ev.recorded_at <> now() THEN
      RAISE EXCEPTION 'La evidencia se adjunta en la misma transacción que su evento; para añadir soporte después, registre un evento evidence.attached.';
    END IF;
    SELECT type::text INTO s_tipo FROM source_documents WHERE id = NEW.source_document_id FOR SHARE;
    IF s_tipo IS DISTINCT FROM 'soporte_operativo' THEN
      RAISE EXCEPTION 'La evidencia operativa debe ser una fuente de tipo soporte_operativo.';
    END IF;
    RETURN NEW;
  END IF;

  -- UPDATE: única mutación = marca de retiro, una sola vez, por una persona con rol.
  IF OLD.retracted_at IS NOT NULL THEN
    RAISE EXCEPTION 'La evidencia ya fue retirada: no admite cambios.';
  END IF;
  IF NEW.retracted_at IS NULL THEN
    RAISE EXCEPTION 'operational_evidence solo admite la marca de retiro (retracted_at/retracted_by).';
  END IF;
  IF (NEW.id, NEW.organization_id, NEW.campaign_id, NEW.event_id, NEW.source_document_id, NEW.kind,
      NEW.attached_by, NEW.created_at)
     IS DISTINCT FROM
     (OLD.id, OLD.organization_id, OLD.campaign_id, OLD.event_id, OLD.source_document_id, OLD.kind,
      OLD.attached_by, OLD.created_at) THEN
    RAISE EXCEPTION 'Retirar la evidencia solo fija retracted_at y retracted_by.';
  END IF;
  PERFORM operaciones_exigir_rol(NEW.retracted_by, 'manage_ops');
  NEW.retracted_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER operational_evidence_integridad
  BEFORE INSERT OR UPDATE ON operational_evidence
  FOR EACH ROW EXECUTE FUNCTION operational_evidence_integridad();
CREATE TRIGGER operational_evidence_sin_delete
  BEFORE DELETE ON operational_evidence FOR EACH ROW EXECUTE FUNCTION operaciones_sin_delete();
CREATE TRIGGER operational_evidence_sin_truncate
  BEFORE TRUNCATE ON operational_evidence FOR EACH STATEMENT EXECUTE FUNCTION operaciones_sin_truncate();

-- ─────────────────────────── 4. Máquina de estados de los sujetos ──────────────

-- Genérica: TG_ARGV[0] = 'shipment' | 'billing_document' | 'payment_obligation'. Las tres tablas llevan
-- `status`, `row_seq` y `last_event_id`. Se nombra `*_estado_evento` para dispararse antes que las reglas
-- propias de cada tabla (orden alfabético de triggers).
CREATE OR REPLACE FUNCTION operaciones_sujeto_actualiza() RETURNS trigger AS $$
DECLARE
  v_tipo     text := TG_ARGV[0];
  ev         operational_events%ROWTYPE;
  v_sujeto   uuid;
BEGIN
  IF inmutabilidad_bypass_activo() THEN RETURN NEW; END IF;

  IF NEW.row_seq = OLD.row_seq THEN
    -- Edición de atributos: el estado y su evento NO se tocan.
    IF NEW.status IS DISTINCT FROM OLD.status OR NEW.last_event_id IS DISTINCT FROM OLD.last_event_id THEN
      RAISE EXCEPTION 'El estado de % solo cambia con un evento operativo (row_seq + 1 y last_event_id).', TG_TABLE_NAME;
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.row_seq <> OLD.row_seq + 1 THEN
    RAISE EXCEPTION 'row_seq de % solo avanza de uno en uno (de % a %).', TG_TABLE_NAME, OLD.row_seq, NEW.row_seq;
  END IF;
  SELECT * INTO ev FROM operational_events WHERE id = NEW.last_event_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'last_event_id de % debe citar el evento operativo que lo mueve.', TG_TABLE_NAME;
  END IF;
  v_sujeto := CASE v_tipo
    WHEN 'shipment'           THEN ev.shipment_id
    WHEN 'billing_document'   THEN ev.billing_document_id
    WHEN 'payment_obligation' THEN ev.payment_obligation_id
  END;
  IF ev.subject_type <> v_tipo OR v_sujeto IS DISTINCT FROM NEW.id OR ev.subject_seq <> NEW.row_seq THEN
    RAISE EXCEPTION 'El evento citado no es el evento % de este sujeto.', NEW.row_seq;
  END IF;

  IF OLD.row_seq = 0 THEN
    -- Creación: el estado no cambia; el evento declara el estado inicial.
    IF NEW.status IS DISTINCT FROM OLD.status OR OLD.last_event_id IS NOT NULL
       OR ev.from_status IS NOT NULL OR ev.to_status IS DISTINCT FROM NEW.status
       OR NOT operaciones_arista_valida(ev.event_type, NULL, NEW.status) THEN
      RAISE EXCEPTION 'El primer evento de % debe ser su evento de creación, con el estado inicial.', TG_TABLE_NAME;
    END IF;
  ELSIF NEW.status IS DISTINCT FROM OLD.status THEN
    IF ev.from_status IS DISTINCT FROM OLD.status OR ev.to_status IS DISTINCT FROM NEW.status
       OR NOT operaciones_arista_valida(ev.event_type, OLD.status, NEW.status) THEN
      RAISE EXCEPTION 'Transición no válida en %: % → % (evento %).', TG_TABLE_NAME, OLD.status, NEW.status, ev.event_type;
    END IF;
  ELSIF ev.to_status IS NOT NULL THEN
    RAISE EXCEPTION 'Un evento que cambia el estado (%) exige el cambio de estado en %.', ev.event_type, TG_TABLE_NAME;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER shipments_estado_evento
  BEFORE UPDATE ON shipments
  FOR EACH ROW EXECUTE FUNCTION operaciones_sujeto_actualiza('shipment');
CREATE TRIGGER billing_documents_estado_evento
  BEFORE UPDATE ON billing_documents
  FOR EACH ROW EXECUTE FUNCTION operaciones_sujeto_actualiza('billing_document');
CREATE TRIGGER payment_obligations_estado_evento
  BEFORE UPDATE ON payment_obligations
  FOR EACH ROW EXECUTE FUNCTION operaciones_sujeto_actualiza('payment_obligation');

-- Al CERRAR la transacción: todo sujeto nacido quedó creado (row_seq ≥ 1) y todo evento insertado quedó
-- aplicado al sujeto (subject.row_seq ≥ subject_seq); la evidencia de un `evidence.attached` existe.
CREATE OR REPLACE FUNCTION operaciones_sujeto_creado() RETURNS trigger AS $$
DECLARE
  v_seq  integer;
BEGIN
  IF inmutabilidad_bypass_activo() THEN RETURN NULL; END IF;
  EXECUTE format('SELECT row_seq FROM %I WHERE id = $1', TG_TABLE_NAME) INTO v_seq USING NEW.id;
  IF v_seq IS NOT NULL AND v_seq < 1 THEN
    RAISE EXCEPTION '% se crea junto con su evento de creación (row_seq debe ser ≥ 1 al cerrar la transacción).', TG_TABLE_NAME;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER shipments_creado
  AFTER INSERT ON shipments DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION operaciones_sujeto_creado();
CREATE CONSTRAINT TRIGGER billing_documents_creado
  AFTER INSERT ON billing_documents DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION operaciones_sujeto_creado();
CREATE CONSTRAINT TRIGGER payment_obligations_creado
  AFTER INSERT ON payment_obligations DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION operaciones_sujeto_creado();

CREATE OR REPLACE FUNCTION operational_events_aplicado() RETURNS trigger AS $$
DECLARE
  v_seq  integer;
BEGIN
  IF inmutabilidad_bypass_activo() THEN RETURN NULL; END IF;
  IF NEW.subject_type = 'shipment' THEN
    SELECT row_seq INTO v_seq FROM shipments WHERE id = NEW.shipment_id;
  ELSIF NEW.subject_type = 'billing_document' THEN
    SELECT row_seq INTO v_seq FROM billing_documents WHERE id = NEW.billing_document_id;
  ELSE
    SELECT row_seq INTO v_seq FROM payment_obligations WHERE id = NEW.payment_obligation_id;
  END IF;
  IF v_seq IS NULL OR v_seq < NEW.subject_seq THEN
    RAISE EXCEPTION 'El evento % no se aplicó a su sujeto: el sujeto debe avanzar row_seq y last_event_id en la misma transacción.', NEW.event_type;
  END IF;
  IF NEW.event_type = 'evidence.attached' AND NOT EXISTS (
    SELECT 1 FROM operational_evidence WHERE event_id = NEW.id
  ) THEN
    RAISE EXCEPTION 'Un evento evidence.attached exige su evidencia (fuente de soporte operativo).';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER operational_events_aplicado
  AFTER INSERT ON operational_events DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION operational_events_aplicado();

-- ─────────────────────────── 5. Reglas propias de cada sujeto ──────────────────

-- Obligación de pago: coherencia con el acuerdo vigente, documentos vivos y sello de reporte.
CREATE OR REPLACE FUNCTION payment_obligations_reglas() RETURNS trigger AS $$
DECLARE
  ev       operational_events%ROWTYPE;
  a        agreements%ROWTYPE;
  av       agreement_versions%ROWTYPE;
  vivos    integer;
BEGIN
  IF inmutabilidad_bypass_activo() THEN RETURN NEW; END IF;
  IF (NEW.id, NEW.organization_id, NEW.campaign_id, NEW.agreement_id, NEW.created_by, NEW.created_at)
     IS DISTINCT FROM
     (OLD.id, OLD.organization_id, OLD.campaign_id, OLD.agreement_id, OLD.created_by, OLD.created_at) THEN
    RAISE EXCEPTION 'La identidad de una obligación de pago (campaña, acuerdo, autor) no se modifica.';
  END IF;
  -- Reportada = sellada e inmutable (la corrección es un evento payment.correction_noted).
  IF OLD.status = 'reported_paid'
     AND (NEW.reported_by, NEW.reported_at, NEW.paid_on, NEW.external_reference, NEW.billing_validated_at_report)
         IS DISTINCT FROM
         (OLD.reported_by, OLD.reported_at, OLD.paid_on, OLD.external_reference, OLD.billing_validated_at_report) THEN
    RAISE EXCEPTION 'Un pago reportado está sellado: no se modifica (use payment.correction_noted).';
  END IF;
  IF NEW.status IS NOT DISTINCT FROM OLD.status THEN RETURN NEW; END IF;

  SELECT * INTO ev FROM operational_events WHERE id = NEW.last_event_id;
  SELECT * INTO a FROM agreements WHERE id = NEW.agreement_id FOR SHARE;
  IF a.current_version >= 1 THEN
    SELECT * INTO av FROM agreement_versions WHERE agreement_id = a.id AND version = a.current_version;
  END IF;
  SELECT count(*) INTO vivos FROM billing_documents
   WHERE payment_obligation_id = NEW.id AND status IN ('registered', 'validated');

  IF NEW.status = 'pending' THEN
    IF a.status <> 'active' OR (av.compensation_type IS NULL OR av.compensation_type NOT IN ('fee', 'mixed')) THEN
      RAISE EXCEPTION 'La obligación solo pasa a pending con un acuerdo activo cuya versión vigente tenga tarifa (fee o mixed).';
    END IF;
  ELSIF NEW.status = 'not_applicable' THEN
    IF a.status <> 'active' OR av.compensation_type IS DISTINCT FROM 'barter' THEN
      RAISE EXCEPTION 'La obligación solo pasa a not_applicable con un acuerdo activo cuya versión vigente sea canje puro (barter).';
    END IF;
    IF vivos > 0 THEN
      RAISE EXCEPTION 'La obligación tiene % documento(s) de cobro vivos (registered o validated): anúlelos o recházelos antes de marcarla not_applicable.', vivos;
    END IF;
  ELSIF NEW.status = 'cancelled' THEN
    IF vivos > 0 THEN
      RAISE EXCEPTION 'La obligación tiene % documento(s) de cobro vivos (registered o validated): anúlelos o recházelos antes de cancelarla.', vivos;
    END IF;
  ELSIF NEW.status = 'reported_paid' THEN
    IF a.status <> 'active' OR (av.compensation_type IS NULL OR av.compensation_type NOT IN ('fee', 'mixed')) THEN
      RAISE EXCEPTION 'Solo se reporta el pago de un acuerdo activo con tarifa (fee o mixed).';
    END IF;
    -- Sellos: los fija la base desde el evento (quien lo registró, cuándo, fecha de pago y referencia).
    -- Reportar sin documento validado NO se bloquea: queda `billing_validated_at_report = false`.
    NEW.reported_by := ev.recorded_by;
    NEW.reported_at := ev.recorded_at;
    NEW.paid_on := ev.happened_on;
    NEW.external_reference := ev.external_reference;
    NEW.billing_validated_at_report := EXISTS (
      SELECT 1 FROM billing_documents WHERE payment_obligation_id = NEW.id AND status = 'validated'
    );
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER payment_obligations_reglas
  BEFORE UPDATE ON payment_obligations
  FOR EACH ROW EXECUTE FUNCTION payment_obligations_reglas();

-- Documento de cobro: el sello de validación sale del evento.
CREATE OR REPLACE FUNCTION billing_documents_reglas() RETURNS trigger AS $$
DECLARE
  ev   operational_events%ROWTYPE;
  o    payment_obligations%ROWTYPE;
BEGIN
  IF inmutabilidad_bypass_activo() THEN RETURN NEW; END IF;
  IF NEW.status IS NOT DISTINCT FROM OLD.status THEN
    IF (NEW.validated_by, NEW.validated_at) IS DISTINCT FROM (OLD.validated_by, OLD.validated_at) THEN
      RAISE EXCEPTION 'El sello de validación solo se fija al validar.';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.status = 'validated' THEN
    SELECT * INTO ev FROM operational_events WHERE id = NEW.last_event_id;
    SELECT * INTO o FROM payment_obligations WHERE id = NEW.payment_obligation_id FOR SHARE;
    IF o.status NOT IN ('pending', 'reported_paid') THEN
      RAISE EXCEPTION 'Solo se valida un documento de cobro de una obligación pendiente o ya reportada (estado actual: %).', o.status;
    END IF;
    NEW.validated_by := ev.recorded_by;
    NEW.validated_at := ev.recorded_at;
  ELSIF (NEW.validated_by, NEW.validated_at) IS DISTINCT FROM (OLD.validated_by, OLD.validated_at) THEN
    RAISE EXCEPTION 'El sello de validación solo se fija al validar y no se modifica después.';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER billing_documents_reglas
  BEFORE UPDATE ON billing_documents
  FOR EACH ROW EXECUTE FUNCTION billing_documents_reglas();

-- ─────────────────────────── 6. Fuentes `soporte_operativo` ────────────────────

-- La evidencia operativa es una fuente sensible, interna y SIN procesamiento: no se encola, no se
-- fragmenta, no se indexa, no se comparte con TCL. (El resto —`excluirEvidenciaOperativa` en listados,
-- búsqueda y agente— lo impone la aplicación.)
CREATE OR REPLACE FUNCTION source_documents_soporte_operativo_guarda() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    -- El tipo es de nacimiento: ni se vuelve soporte operativo ni deja de serlo.
    IF OLD.type IS DISTINCT FROM NEW.type
       AND (OLD.type = 'soporte_operativo' OR NEW.type = 'soporte_operativo') THEN
      RAISE EXCEPTION 'El tipo soporte_operativo se fija al crear la fuente y no cambia.';
    END IF;
    -- El original de una evidencia no cambia.
    IF OLD.type = 'soporte_operativo'
       AND (NEW.hash, NEW.filename, NEW.file_id, NEW.mime_type, NEW.size_bytes, NEW.campaign_id,
            NEW.organization_id, NEW.origin, NEW.storage_provider)
           IS DISTINCT FROM
           (OLD.hash, OLD.filename, OLD.file_id, OLD.mime_type, OLD.size_bytes, OLD.campaign_id,
            OLD.organization_id, OLD.origin, OLD.storage_provider) THEN
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

CREATE TRIGGER source_documents_soporte_operativo_guarda
  BEFORE INSERT OR UPDATE ON source_documents
  FOR EACH ROW EXECUTE FUNCTION source_documents_soporte_operativo_guarda();

CREATE OR REPLACE FUNCTION soporte_operativo_sin_procesamiento() RETURNS trigger AS $$
DECLARE
  v_fuente  uuid := NEW.source_id;
BEGIN
  IF EXISTS (SELECT 1 FROM source_documents WHERE id = v_fuente AND type = 'soporte_operativo') THEN
    RAISE EXCEPTION 'La evidencia operativa no se procesa: sin trabajos de procesamiento ni fragmentos.';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER processing_jobs_sin_soporte_operativo
  BEFORE INSERT ON processing_jobs
  FOR EACH ROW EXECUTE FUNCTION soporte_operativo_sin_procesamiento();
CREATE TRIGGER source_fragments_sin_soporte_operativo
  BEFORE INSERT ON source_fragments
  FOR EACH ROW EXECUTE FUNCTION soporte_operativo_sin_procesamiento();
