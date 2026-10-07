-- 027 · Acuerdos con el KOL y obligación de pago (V2 · Fase 8, DEC-049).
--
-- Forward-only y aditiva: una función de rol, tres funciones genéricas de historia y cuatro tablas
-- nuevas. No cambia ninguna fila, columna ni restricción existente.
--
--   campaign_influencers ─< agreements (UNIQUE por participación)
--                              ├─< agreement_versions ─< agreement_product_commitments
--                              └─< payment_obligations (UNIQUE por acuerdo)
--
-- Principios impuestos AQUÍ (no solo en la aplicación):
--   · Todo cuelga de `campaign_influencers` (DEC-044) con claves compuestas organización/campaña.
--     Sin columna de visibilidad ni acceso `cliente`.
--   · Los términos materiales del acuerdo son INMUTABLES: editar = versión N+1. La numeración la asigna
--     la base bajo `FOR UPDATE` del acuerdo (sin huecos ni duplicados).
--   · barter ⇒ sin monto ni moneda; fee/mixed ⇒ monto > 0 y moneda `^[A-Z]{3}$` (CHECK).
--   · Invariante DIFERIDO (se evalúa al cerrar la transacción): la versión vigente barter ⇒ obligación
--     `not_applicable` (o `cancelled`); fee/mixed ⇒ obligación distinta de `not_applicable`; barter/mixed ⇒
--     ≥ 1 compromiso de producto; todo acuerdo tiene versión y obligación; `current_version = max(version)`.
--   · Una versión con modo/monto/moneda distinto se rechaza si la obligación ya está `reported_paid`.
--   · PAYMENT TRACKING ≠ PAYMENT EXECUTION (DEC-014): aquí no hay dinero movido, bancos ni ledger; la
--     obligación solo registra que alguien externo reportó un pago.
--   · Roles cerrados en la base (`operaciones_exigir_rol`) con paridad contra `roleCan` del dominio.
--   · Sin DELETE ni TRUNCATE (solo el bypass de bases `_test`, `inmutabilidad_bypass_activo()`).
--
-- El resto de la máquina de estados de `payment_obligations` (grafo, evento que la mueve, sellos de
-- reporte) la añade la 031, junto con `operational_events`: `last_event_id` es aquí un uuid sin FK todavía.

-- ─────────────────────────── 1. Roles de operación ─────────────────────────────

-- manage_ops      = admin, director, operativo   (espeja agreement:manage / shipment:manage / billing:manage /
--                                                   ops_evidence:attach)
-- report_payment  = admin, operativo             (espeja payment:report)
-- pii             = admin, operativo             (espeja pii:read / pii:manage)
-- kpi_target      = admin, director, consultor   (espeja kpi:target_manage)
-- kpi_measure     = admin, director, operativo   (espeja kpi:measure)
-- Persona ACTIVA de una organización de agencia. La lista es cerrada: un rol nuevo no obtiene acceso por omisión.
CREATE OR REPLACE FUNCTION operaciones_exigir_rol(p_usuario uuid, p_capacidad text) RETURNS void AS $$
DECLARE
  rol         text;
  tipo        text;
  estado      text;
  permitidos  text[];
BEGIN
  permitidos := CASE p_capacidad
    WHEN 'manage_ops'     THEN ARRAY['admin', 'director', 'operativo']
    WHEN 'report_payment' THEN ARRAY['admin', 'operativo']
    WHEN 'pii'            THEN ARRAY['admin', 'operativo']
    WHEN 'kpi_target'     THEN ARRAY['admin', 'director', 'consultor']
    WHEN 'kpi_measure'    THEN ARRAY['admin', 'director', 'operativo']
    ELSE ARRAY[]::text[]
  END;
  SELECT u.role::text, o.type::text, u.status::text INTO rol, tipo, estado
    FROM users u JOIN organizations o ON o.id = u.organization_id
   WHERE u.id = p_usuario;
  IF NOT FOUND
     OR tipo   IS DISTINCT FROM 'agencia'
     OR estado IS DISTINCT FROM 'activo'
     OR NOT (rol = ANY (permitidos)) THEN
    RAISE EXCEPTION 'Este usuario no puede ejecutar «%» en la operación (personal activo de la agencia con el rol adecuado).', p_capacidad;
  END IF;
END;
$$ LANGUAGE plpgsql STABLE;

-- ─────────────────────────── 2. Historia: sin DELETE, TRUNCATE ni UPDATE ───────

-- Genéricas: las reutilizan las migraciones 028–031. Solo el bypass de bases `_test` (010) las salta
-- (y únicamente DELETE/TRUNCATE: la historia que no admite UPDATE no lo admite tampoco en pruebas).
CREATE OR REPLACE FUNCTION operaciones_sin_delete() RETURNS trigger AS $$
BEGIN
  IF inmutabilidad_bypass_activo() THEN RETURN OLD; END IF;
  RAISE EXCEPTION '% no admite DELETE: la operación es historia (se cancela o se anula, no se borra).', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION operaciones_sin_truncate() RETURNS trigger AS $$
BEGIN
  IF inmutabilidad_bypass_activo() THEN RETURN NULL; END IF;
  RAISE EXCEPTION '% es historia de operación: no admite TRUNCATE.', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION operaciones_sin_update() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% es append-only: una fila registrada no se modifica.', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

-- ─────────────────────────── 3. Acuerdo (cabecera) ─────────────────────────────

CREATE TABLE agreements (
  id                      uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id         uuid NOT NULL,
  campaign_id             uuid NOT NULL,
  campaign_influencer_id  uuid NOT NULL,
  status                  text NOT NULL DEFAULT 'active',
  -- Contador de versiones (patrón `deliverables.last_version`): lo avanza el trigger de
  -- `agreement_versions`; invariante diferido `current_version = MAX(version)`.
  current_version         integer NOT NULL DEFAULT 0,
  cancelled_at            timestamptz,
  cancelled_by            uuid,
  cancel_reason           text,
  created_by              uuid NOT NULL,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT agreements_campaign_fkey
    FOREIGN KEY (campaign_id, organization_id)
    REFERENCES campaigns (id, organization_id) ON DELETE RESTRICT,
  -- La participación es de ESTA campaña (y, por transitividad, de esta organización).
  CONSTRAINT agreements_participacion_fkey
    FOREIGN KEY (campaign_influencer_id, campaign_id)
    REFERENCES campaign_influencers (id, campaign_id) ON DELETE RESTRICT,
  CONSTRAINT agreements_autor_fkey
    FOREIGN KEY (created_by, organization_id)
    REFERENCES users (id, organization_id) ON DELETE RESTRICT,
  CONSTRAINT agreements_cancelador_fkey
    FOREIGN KEY (cancelled_by, organization_id)
    REFERENCES users (id, organization_id) ON DELETE RESTRICT,
  -- Un acuerdo por participación (los cambios son versiones, no acuerdos nuevos).
  CONSTRAINT agreements_participacion_key UNIQUE (campaign_influencer_id),
  CONSTRAINT agreements_id_scope_key UNIQUE (id, organization_id, campaign_id),
  CONSTRAINT agreements_estado_valido CHECK (status IN ('active', 'cancelled')),
  CONSTRAINT agreements_version_valida CHECK (current_version >= 0),
  CONSTRAINT agreements_cancelacion_coherente CHECK (
    (status = 'cancelled') = (cancelled_at IS NOT NULL AND cancelled_by IS NOT NULL AND cancel_reason IS NOT NULL)
    AND (status = 'cancelled' OR (cancelled_at IS NULL AND cancelled_by IS NULL AND cancel_reason IS NULL))
  ),
  CONSTRAINT agreements_motivo_valido CHECK (
    cancel_reason IS NULL
    OR (cancel_reason = btrim(cancel_reason) AND cancel_reason <> '' AND char_length(cancel_reason) <= 500)
  )
);

CREATE INDEX agreements_campaign_idx ON agreements (campaign_id, status);

CREATE OR REPLACE FUNCTION agreements_integridad() RETURNS trigger AS $$
DECLARE
  c_estado   text;
  ci_estado  text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'active' OR NEW.current_version <> 0 OR NEW.cancelled_at IS NOT NULL THEN
      RAISE EXCEPTION 'Un acuerdo nace activo y sin versiones (la versión 1 se registra en la misma transacción).';
    END IF;
    PERFORM operaciones_exigir_rol(NEW.created_by, 'manage_ops');
    -- FOR SHARE: archivar la campaña o retirar a la persona espera a que este alta termine.
    SELECT status::text INTO c_estado  FROM campaigns WHERE id = NEW.campaign_id FOR SHARE;
    SELECT status::text INTO ci_estado FROM campaign_influencers WHERE id = NEW.campaign_influencer_id FOR SHARE;
    IF c_estado IS DISTINCT FROM 'activa' OR ci_estado IS DISTINCT FROM 'activo' THEN
      RAISE EXCEPTION 'La campaña debe estar activa y el influencer activo en ella para registrar un acuerdo.';
    END IF;
    RETURN NEW;
  END IF;

  -- UPDATE
  IF inmutabilidad_bypass_activo() THEN RETURN NEW; END IF;
  IF (NEW.id, NEW.organization_id, NEW.campaign_id, NEW.campaign_influencer_id, NEW.created_by, NEW.created_at)
     IS DISTINCT FROM
     (OLD.id, OLD.organization_id, OLD.campaign_id, OLD.campaign_influencer_id, OLD.created_by, OLD.created_at) THEN
    RAISE EXCEPTION 'La identidad de un acuerdo (campaña, participación, autor) no se modifica.';
  END IF;
  IF OLD.status = 'cancelled' THEN
    RAISE EXCEPTION 'Un acuerdo cancelado es histórico: no admite cambios.';
  END IF;
  IF NEW.current_version <> OLD.current_version AND NEW.current_version <> OLD.current_version + 1 THEN
    RAISE EXCEPTION 'current_version solo avanza de uno en uno, al registrar una versión.';
  END IF;
  IF NEW.status = 'cancelled' THEN
    -- Única transición: active → cancelled, por una persona con rol; el estado se conserva (no hay DELETE).
    PERFORM operaciones_exigir_rol(NEW.cancelled_by, 'manage_ops');
    IF NEW.current_version <> OLD.current_version THEN
      RAISE EXCEPTION 'Cancelar un acuerdo no registra versiones.';
    END IF;
    NEW.cancelled_at := now();
  ELSIF NEW.cancelled_at IS NOT NULL OR NEW.cancelled_by IS NOT NULL OR NEW.cancel_reason IS NOT NULL THEN
    RAISE EXCEPTION 'Las marcas de cancelación solo se fijan al cancelar.';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER agreements_integridad
  BEFORE INSERT OR UPDATE ON agreements
  FOR EACH ROW EXECUTE FUNCTION agreements_integridad();
CREATE TRIGGER agreements_set_updated_at
  BEFORE UPDATE ON agreements FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER agreements_sin_delete
  BEFORE DELETE ON agreements FOR EACH ROW EXECUTE FUNCTION operaciones_sin_delete();
CREATE TRIGGER agreements_sin_truncate
  BEFORE TRUNCATE ON agreements FOR EACH STATEMENT EXECUTE FUNCTION operaciones_sin_truncate();

-- ─────────────────────────── 4. Versiones del acuerdo (inmutables) ─────────────

-- Términos MATERIALES de un acuerdo. `text + CHECK`, no ENUM (precedente 013/021/023).
--   barter  canje puro: sin monto ni moneda.
--   fee     tarifa en dinero: monto > 0 y moneda ISO de tres letras.
--   mixed   tarifa + producto (exige además ≥ 1 compromiso de producto).
CREATE TABLE agreement_versions (
  id                uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id   uuid NOT NULL,
  campaign_id       uuid NOT NULL,
  agreement_id      uuid NOT NULL,
  -- La asigna el trigger; el llamador no la fija (el valor que mande se ignora).
  version           integer NOT NULL DEFAULT 0,
  compensation_type text NOT NULL,
  fee_amount        numeric(14,2),
  fee_currency      char(3),
  starts_on         date,
  ends_on           date,
  conditions        text,
  change_reason     text,
  created_by        uuid NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT agreement_versions_acuerdo_fkey
    FOREIGN KEY (agreement_id, organization_id, campaign_id)
    REFERENCES agreements (id, organization_id, campaign_id) ON DELETE RESTRICT,
  CONSTRAINT agreement_versions_autor_fkey
    FOREIGN KEY (created_by, organization_id)
    REFERENCES users (id, organization_id) ON DELETE RESTRICT,
  CONSTRAINT agreement_versions_numero_key UNIQUE (agreement_id, version),
  CONSTRAINT agreement_versions_id_acuerdo_key UNIQUE (id, agreement_id),
  CONSTRAINT agreement_versions_id_scope_key UNIQUE (id, organization_id, campaign_id),
  CONSTRAINT agreement_versions_version_valida CHECK (version >= 1),
  CONSTRAINT agreement_versions_modo_valido CHECK (compensation_type IN ('fee', 'barter', 'mixed')),
  -- barter ⇒ sin monto ni moneda; fee/mixed ⇒ monto > 0 y moneda `^[A-Z]{3}$`.
  CONSTRAINT agreement_versions_monto_por_modo CHECK (
    (compensation_type = 'barter' AND fee_amount IS NULL AND fee_currency IS NULL)
    OR (compensation_type IN ('fee', 'mixed') AND fee_amount IS NOT NULL AND fee_amount > 0
        AND fee_currency IS NOT NULL AND fee_currency ~ '^[A-Z]{3}$')
  ),
  CONSTRAINT agreement_versions_vigencia_valida CHECK (starts_on IS NULL OR ends_on IS NULL OR ends_on >= starts_on),
  CONSTRAINT agreement_versions_condiciones_validas CHECK (
    conditions IS NULL OR (btrim(conditions) <> '' AND char_length(conditions) <= 4000)
  ),
  CONSTRAINT agreement_versions_motivo_valido CHECK (
    change_reason IS NULL OR (btrim(change_reason) <> '' AND char_length(change_reason) <= 1000)
  )
);

CREATE INDEX agreement_versions_campaign_idx ON agreement_versions (campaign_id);

CREATE OR REPLACE FUNCTION agreement_versions_integridad() RETURNS trigger AS $$
DECLARE
  a          agreements%ROWTYPE;
  prev       agreement_versions%ROWTYPE;
  o_estado   text;
  o_existe   boolean;
  c_estado   text;
  ci_estado  text;
BEGIN
  -- ORDEN DE BLOQUEOS (el mismo de las transiciones de la obligación, que bloquean la obligación y luego
  -- leen el acuerdo): obligación → acuerdo. Así dos transacciones concurrentes no se bloquean en cruz.
  -- FOR NO KEY UPDATE (como un UPDATE): reportar el pago o cambiar su aplicabilidad espera a que esta
  -- versión termine, y viceversa; con el pago ya reportado los términos económicos quedan fijos.
  SELECT status INTO o_estado FROM payment_obligations WHERE agreement_id = NEW.agreement_id FOR NO KEY UPDATE;
  o_existe := FOUND;
  -- Serializa la numeración y los cambios del acuerdo.
  SELECT * INTO a FROM agreements WHERE id = NEW.agreement_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'El acuerdo no existe.' USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF a.status <> 'active' THEN
    RAISE EXCEPTION 'El acuerdo está cancelado: no se registran versiones.';
  END IF;
  SELECT status::text INTO c_estado  FROM campaigns WHERE id = a.campaign_id FOR SHARE;
  SELECT status::text INTO ci_estado FROM campaign_influencers WHERE id = a.campaign_influencer_id FOR SHARE;
  IF c_estado IS DISTINCT FROM 'activa' OR ci_estado IS DISTINCT FROM 'activo' THEN
    RAISE EXCEPTION 'La campaña debe estar activa y el influencer activo en ella para registrar una versión del acuerdo.';
  END IF;
  PERFORM operaciones_exigir_rol(NEW.created_by, 'manage_ops');

  -- Con el pago ya reportado, los términos económicos (modo, monto, moneda) quedan fijos; sí pueden
  -- cambiar vigencia y condiciones.
  IF o_existe AND o_estado = 'reported_paid' THEN
    SELECT * INTO prev FROM agreement_versions WHERE agreement_id = a.id AND version = a.current_version;
    IF FOUND AND (NEW.compensation_type, NEW.fee_amount, NEW.fee_currency)
                 IS DISTINCT FROM (prev.compensation_type, prev.fee_amount, prev.fee_currency) THEN
      RAISE EXCEPTION 'El pago de este acuerdo ya fue reportado: no se cambia el modo, el monto ni la moneda.';
    END IF;
  END IF;

  NEW.version := a.current_version + 1;
  UPDATE agreements SET current_version = NEW.version WHERE id = a.id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER agreement_versions_integridad
  BEFORE INSERT ON agreement_versions
  FOR EACH ROW EXECUTE FUNCTION agreement_versions_integridad();
CREATE TRIGGER agreement_versions_sin_update
  BEFORE UPDATE ON agreement_versions FOR EACH ROW EXECUTE FUNCTION operaciones_sin_update();
CREATE TRIGGER agreement_versions_sin_delete
  BEFORE DELETE ON agreement_versions FOR EACH ROW EXECUTE FUNCTION operaciones_sin_delete();
CREATE TRIGGER agreement_versions_sin_truncate
  BEFORE TRUNCATE ON agreement_versions FOR EACH STATEMENT EXECUTE FUNCTION operaciones_sin_truncate();

-- ─────────────────────────── 5. Compromisos de producto por versión ────────────

-- Producto COMPROMETIDO en la versión (≠ asignado a la participación ≠ enviado ≠ entregado).
-- Inmutables. Solo se insertan en la MISMA transacción que su versión y mientras es la vigente: un
-- compromiso tardío cambiaría los términos de una versión ya registrada.
CREATE TABLE agreement_product_commitments (
  id                    uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id       uuid NOT NULL,
  campaign_id           uuid NOT NULL,
  agreement_version_id  uuid NOT NULL,
  campaign_product_id   uuid NOT NULL,
  quantity              integer NOT NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT agreement_product_commitments_version_fkey
    FOREIGN KEY (agreement_version_id, organization_id, campaign_id)
    REFERENCES agreement_versions (id, organization_id, campaign_id) ON DELETE RESTRICT,
  -- El producto es de ESTA campaña.
  CONSTRAINT agreement_product_commitments_producto_fkey
    FOREIGN KEY (campaign_product_id, campaign_id)
    REFERENCES campaign_products (id, campaign_id) ON DELETE RESTRICT,
  CONSTRAINT agreement_product_commitments_unico_key UNIQUE (agreement_version_id, campaign_product_id),
  CONSTRAINT agreement_product_commitments_cantidad_valida CHECK (quantity > 0 AND quantity <= 100000)
);

CREATE INDEX agreement_product_commitments_producto_idx ON agreement_product_commitments (campaign_product_id);

CREATE OR REPLACE FUNCTION agreement_product_commitments_integridad() RETURNS trigger AS $$
DECLARE
  v   agreement_versions%ROWTYPE;
  a   agreements%ROWTYPE;
BEGIN
  SELECT * INTO v FROM agreement_versions WHERE id = NEW.agreement_version_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'La versión del acuerdo no existe.' USING ERRCODE = 'foreign_key_violation';
  END IF;
  SELECT * INTO a FROM agreements WHERE id = v.agreement_id FOR SHARE;
  IF a.status <> 'active' THEN
    RAISE EXCEPTION 'El acuerdo está cancelado: no se registran compromisos.';
  END IF;
  IF a.current_version <> v.version OR v.created_at <> now() THEN
    RAISE EXCEPTION 'Los compromisos de producto se registran junto con su versión (en la misma transacción) y solo en la vigente.';
  END IF;
  IF v.compensation_type NOT IN ('barter', 'mixed') THEN
    RAISE EXCEPTION 'Solo los acuerdos de canje (barter) o mixtos comprometen producto.';
  END IF;
  -- Comprometer ≠ asignar, pero no se compromete lo que ni siquiera está asignado a la participación.
  -- FOR SHARE: desasignarlo espera a que este compromiso termine (y luego lo ve: ver 029).
  PERFORM 1 FROM campaign_influencer_products
   WHERE campaign_influencer_id = a.campaign_influencer_id AND campaign_product_id = NEW.campaign_product_id
     FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'El producto no está asignado a este influencer en la campaña: asígnelo antes de comprometerlo.';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER agreement_product_commitments_integridad
  BEFORE INSERT ON agreement_product_commitments
  FOR EACH ROW EXECUTE FUNCTION agreement_product_commitments_integridad();
CREATE TRIGGER agreement_product_commitments_sin_update
  BEFORE UPDATE ON agreement_product_commitments FOR EACH ROW EXECUTE FUNCTION operaciones_sin_update();
CREATE TRIGGER agreement_product_commitments_sin_delete
  BEFORE DELETE ON agreement_product_commitments FOR EACH ROW EXECUTE FUNCTION operaciones_sin_delete();
CREATE TRIGGER agreement_product_commitments_sin_truncate
  BEFORE TRUNCATE ON agreement_product_commitments FOR EACH STATEMENT EXECUTE FUNCTION operaciones_sin_truncate();

-- ─────────────────────────── 6. Obligación de pago (seguimiento) ───────────────

-- SEGUIMIENTO, no ejecución: registra que una persona con rol reportó que un tercero pagó (DEC-014).
--   not_applicable ↔ pending → reported_paid | cancelled ;  not_applicable → cancelled
-- `status`, `row_seq` y `last_event_id` solo cambian con un evento (`operational_events`, 031).
-- Sellos de reporte (`reported_*`, `paid_on`, `external_reference`): los fija la 031 desde el evento y
-- quedan inmutables; el CHECK de aquí exige que existan juntos y solo en `reported_paid`.
CREATE TABLE payment_obligations (
  id                            uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id               uuid NOT NULL,
  campaign_id                   uuid NOT NULL,
  agreement_id                  uuid NOT NULL,
  status                        text NOT NULL,
  -- Contador de eventos del sujeto: 0 solo mientras se crea (el evento de creación lo lleva a 1).
  row_seq                       integer NOT NULL DEFAULT 0,
  -- FK hacia `operational_events` en la 031 (DEFERRABLE).
  last_event_id                 uuid,
  reported_by                   uuid,
  reported_at                   timestamptz,
  paid_on                       date,
  external_reference            text,
  billing_validated_at_report   boolean,
  created_by                    uuid NOT NULL,
  created_at                    timestamptz NOT NULL DEFAULT now(),
  updated_at                    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT payment_obligations_acuerdo_fkey
    FOREIGN KEY (agreement_id, organization_id, campaign_id)
    REFERENCES agreements (id, organization_id, campaign_id) ON DELETE RESTRICT,
  CONSTRAINT payment_obligations_autor_fkey
    FOREIGN KEY (created_by, organization_id)
    REFERENCES users (id, organization_id) ON DELETE RESTRICT,
  CONSTRAINT payment_obligations_reportador_fkey
    FOREIGN KEY (reported_by, organization_id)
    REFERENCES users (id, organization_id) ON DELETE RESTRICT,
  CONSTRAINT payment_obligations_acuerdo_key UNIQUE (agreement_id),
  CONSTRAINT payment_obligations_id_scope_key UNIQUE (id, organization_id, campaign_id),
  CONSTRAINT payment_obligations_estado_valido
    CHECK (status IN ('not_applicable', 'pending', 'reported_paid', 'cancelled')),
  CONSTRAINT payment_obligations_seq_valido CHECK (row_seq >= 0 AND (row_seq = 0) = (last_event_id IS NULL)),
  -- reported_paid exige quién, cuándo, fecha de pago y referencia externa (y solo entonces existen).
  CONSTRAINT payment_obligations_reporte_completo CHECK (
    (status = 'reported_paid'
       AND reported_by IS NOT NULL AND reported_at IS NOT NULL AND paid_on IS NOT NULL
       AND external_reference IS NOT NULL AND billing_validated_at_report IS NOT NULL)
    OR
    (status <> 'reported_paid'
       AND reported_by IS NULL AND reported_at IS NULL AND paid_on IS NULL
       AND external_reference IS NULL AND billing_validated_at_report IS NULL)
  ),
  CONSTRAINT payment_obligations_referencia_valida CHECK (
    external_reference IS NULL
    OR (external_reference = btrim(external_reference) AND external_reference <> ''
        AND char_length(external_reference) <= 200)
  )
);

CREATE INDEX payment_obligations_campaign_idx ON payment_obligations (campaign_id, status);

CREATE OR REPLACE FUNCTION payment_obligations_alta() RETURNS trigger AS $$
DECLARE
  a         agreements%ROWTYPE;
  v         agreement_versions%ROWTYPE;
  esperado  text;
BEGIN
  IF NEW.row_seq <> 0 OR NEW.last_event_id IS NOT NULL THEN
    RAISE EXCEPTION 'Una obligación de pago nace sin eventos (row_seq = 0): su evento de creación la lleva a 1.';
  END IF;
  PERFORM operaciones_exigir_rol(NEW.created_by, 'manage_ops');
  SELECT * INTO a FROM agreements WHERE id = NEW.agreement_id FOR SHARE;
  IF NOT FOUND OR a.status <> 'active' OR a.current_version < 1 THEN
    RAISE EXCEPTION 'La obligación de pago exige un acuerdo activo con al menos una versión.';
  END IF;
  SELECT * INTO v FROM agreement_versions WHERE agreement_id = a.id AND version = a.current_version;
  -- Estado inicial coherente con la versión vigente: barter ⇒ not_applicable; fee/mixed ⇒ pending.
  esperado := CASE WHEN v.compensation_type = 'barter' THEN 'not_applicable' ELSE 'pending' END;
  IF NEW.status <> esperado THEN
    RAISE EXCEPTION 'Estado inicial de la obligación incoherente con el acuerdo vigente (%): barter ⇒ not_applicable; fee/mixed ⇒ pending.',
      v.compensation_type;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER payment_obligations_alta
  BEFORE INSERT ON payment_obligations
  FOR EACH ROW EXECUTE FUNCTION payment_obligations_alta();
CREATE TRIGGER payment_obligations_set_updated_at
  BEFORE UPDATE ON payment_obligations FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER payment_obligations_sin_delete
  BEFORE DELETE ON payment_obligations FOR EACH ROW EXECUTE FUNCTION operaciones_sin_delete();
CREATE TRIGGER payment_obligations_sin_truncate
  BEFORE TRUNCATE ON payment_obligations FOR EACH STATEMENT EXECUTE FUNCTION operaciones_sin_truncate();

-- ─────────────────────────── 7. Invariantes DIFERIDOS del acuerdo ──────────────

-- Al CERRAR la transacción (el alta del acuerdo, su versión, sus compromisos y su obligación ocurren
-- juntos, en cualquier orden). Lee el estado FINAL, no la fila que disparó el evento.
CREATE OR REPLACE FUNCTION acuerdos_invariantes_diferidos() RETURNS trigger AS $$
DECLARE
  v_acuerdo  uuid;
  a          agreements%ROWTYPE;
  av         agreement_versions%ROWTYPE;
  o_estado   text;
  maxima     integer;
BEGIN
  IF inmutabilidad_bypass_activo() THEN RETURN NULL; END IF;
  -- Un `CASE` con campos de `NEW` falla: plpgsql resuelve los campos de todas las ramas.
  IF TG_TABLE_NAME = 'agreements' THEN
    v_acuerdo := NEW.id;
  ELSIF TG_TABLE_NAME = 'agreement_versions' THEN
    v_acuerdo := NEW.agreement_id;
  ELSIF TG_TABLE_NAME = 'payment_obligations' THEN
    v_acuerdo := NEW.agreement_id;
  ELSE
    SELECT agreement_id INTO v_acuerdo FROM agreement_versions WHERE id = NEW.agreement_version_id;
  END IF;
  SELECT * INTO a FROM agreements WHERE id = v_acuerdo;
  IF NOT FOUND THEN RETURN NULL; END IF;

  SELECT COALESCE(max(version), 0) INTO maxima FROM agreement_versions WHERE agreement_id = a.id;
  IF a.current_version <> maxima THEN
    RAISE EXCEPTION 'agreements.current_version (%) debe coincidir con la mayor versión registrada (%): solo avanza al registrar una versión.',
      a.current_version, maxima;
  END IF;
  IF a.current_version = 0 THEN
    RAISE EXCEPTION 'Un acuerdo exige su versión 1.';
  END IF;
  -- Un acuerdo cancelado ya no se rige por la obligación ni los compromisos.
  IF a.status = 'cancelled' THEN RETURN NULL; END IF;

  SELECT * INTO av FROM agreement_versions WHERE agreement_id = a.id AND version = a.current_version;
  SELECT status INTO o_estado FROM payment_obligations WHERE agreement_id = a.id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Todo acuerdo exige su obligación de pago (not_applicable si es canje puro).';
  END IF;

  IF av.compensation_type = 'barter' AND o_estado NOT IN ('not_applicable', 'cancelled') THEN
    RAISE EXCEPTION 'Un acuerdo de canje (barter) no tiene pago: la obligación debe ser not_applicable (o cancelled), no %.', o_estado;
  END IF;
  IF av.compensation_type IN ('fee', 'mixed') AND o_estado = 'not_applicable' THEN
    RAISE EXCEPTION 'Un acuerdo con tarifa (%) exige una obligación de pago distinta de not_applicable.', av.compensation_type;
  END IF;
  IF av.compensation_type IN ('barter', 'mixed') AND NOT EXISTS (
    SELECT 1 FROM agreement_product_commitments WHERE agreement_version_id = av.id
  ) THEN
    RAISE EXCEPTION 'Un acuerdo de canje o mixto exige al menos un compromiso de producto en la versión vigente.';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER agreements_invariantes_diferidos
  AFTER INSERT OR UPDATE OF current_version, status ON agreements
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION acuerdos_invariantes_diferidos();
CREATE CONSTRAINT TRIGGER agreement_versions_invariantes_diferidos
  AFTER INSERT ON agreement_versions
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION acuerdos_invariantes_diferidos();
CREATE CONSTRAINT TRIGGER agreement_product_commitments_invariantes_diferidos
  AFTER INSERT ON agreement_product_commitments
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION acuerdos_invariantes_diferidos();
CREATE CONSTRAINT TRIGGER payment_obligations_invariantes_diferidos
  AFTER INSERT OR UPDATE OF status ON payment_obligations
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION acuerdos_invariantes_diferidos();
