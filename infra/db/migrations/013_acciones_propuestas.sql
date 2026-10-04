-- 013 · Acciones propuestas — human-in-the-loop verificable en servidor
-- (V2 · Fase 1D).
--
-- La IA puede proponer una acción crítica; solo una persona autorizada puede
-- confirmarla, y se ejecuta una sola vez:
--
--   pending → confirmed → executed
--   pending → cancelled | expired        confirmed → cancelled | expired
--
-- Las garantías no dependen de la aplicación: el contenido de la propuesta es
-- inmutable, los estados solo avanzan por las transiciones válidas, `executed`
-- / `cancelled` / `expired` son terminales y no hay DELETE (salvo el bypass
-- restringido a bases `_test` de la migración 010, usado solo por la limpieza
-- de pruebas).
CREATE TABLE proposed_actions (
  id                uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id   uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  campaign_id       uuid NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  action_type       text NOT NULL,
  resource_type     text NOT NULL,
  resource_id       uuid NOT NULL,
  payload           jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Huella (SHA-256) de tipo + recurso + payload: liga la confirmación a la
  -- propuesta original.
  payload_hash      text NOT NULL,
  status            text NOT NULL DEFAULT 'pending',
  -- NULL cuando la propuso el sistema sin una persona.
  proposed_by       uuid REFERENCES users(id) ON DELETE SET NULL,
  proposed_origin   text NOT NULL,
  correlation       jsonb,
  -- Opcional: solo esta persona puede confirmar.
  assigned_to       uuid REFERENCES users(id) ON DELETE SET NULL,
  confirmed_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  confirmed_at      timestamptz,
  executed_at       timestamptz,
  cancelled_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  cancelled_at      timestamptz,
  expires_at        timestamptz NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT proposed_actions_estado_valido
    CHECK (status IN ('pending', 'confirmed', 'executed', 'cancelled', 'expired')),
  CONSTRAINT proposed_actions_origen_valido CHECK (proposed_origin IN ('ui', 'chat', 'system')),
  CONSTRAINT proposed_actions_payload_objeto CHECK (jsonb_typeof(payload) = 'object'),
  CONSTRAINT proposed_actions_confirmada_con_persona
    CHECK (status NOT IN ('confirmed', 'executed') OR (confirmed_by IS NOT NULL AND confirmed_at IS NOT NULL)),
  CONSTRAINT proposed_actions_ejecutada_con_fecha
    CHECK (status <> 'executed' OR executed_at IS NOT NULL)
);

CREATE INDEX proposed_actions_campaign_idx ON proposed_actions (campaign_id, created_at DESC);
CREATE INDEX proposed_actions_recurso_idx ON proposed_actions (resource_type, resource_id);
CREATE INDEX proposed_actions_pendientes_idx ON proposed_actions (organization_id, expires_at)
  WHERE status IN ('pending', 'confirmed');

CREATE OR REPLACE FUNCTION proposed_actions_integridad() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF inmutabilidad_bypass_activo() THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'proposed_actions no admite DELETE: es parte del rastro de decisiones.';
  END IF;

  -- El contenido de la propuesta nunca cambia después de creada.
  IF NEW.id <> OLD.id
     OR NEW.organization_id <> OLD.organization_id
     OR NEW.campaign_id <> OLD.campaign_id
     OR NEW.action_type <> OLD.action_type
     OR NEW.resource_type <> OLD.resource_type
     OR NEW.resource_id <> OLD.resource_id
     OR NEW.payload <> OLD.payload
     OR NEW.payload_hash <> OLD.payload_hash
     OR NEW.proposed_origin <> OLD.proposed_origin
     OR NEW.proposed_by IS DISTINCT FROM OLD.proposed_by
     OR NEW.assigned_to IS DISTINCT FROM OLD.assigned_to
     OR NEW.correlation IS DISTINCT FROM OLD.correlation
     OR NEW.expires_at <> OLD.expires_at
     OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'El contenido de una acción propuesta es inmutable.';
  END IF;

  IF NEW.status = OLD.status THEN
    -- Sin cambio de estado no puede cambiar nada más.
    IF NEW.confirmed_by IS DISTINCT FROM OLD.confirmed_by
       OR NEW.confirmed_at IS DISTINCT FROM OLD.confirmed_at
       OR NEW.executed_at IS DISTINCT FROM OLD.executed_at
       OR NEW.cancelled_by IS DISTINCT FROM OLD.cancelled_by
       OR NEW.cancelled_at IS DISTINCT FROM OLD.cancelled_at THEN
      RAISE EXCEPTION 'Una acción propuesta solo cambia sus marcas al cambiar de estado.';
    END IF;
    RETURN NEW;
  END IF;

  IF NOT (
       (OLD.status = 'pending'   AND NEW.status IN ('confirmed', 'cancelled', 'expired'))
    OR (OLD.status = 'confirmed' AND NEW.status IN ('executed', 'cancelled', 'expired'))
  ) THEN
    RAISE EXCEPTION 'Transición de acción propuesta no válida: % → % (executed, cancelled y expired son terminales).',
      OLD.status, NEW.status;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER proposed_actions_integridad
  BEFORE UPDATE OR DELETE ON proposed_actions
  FOR EACH ROW EXECUTE FUNCTION proposed_actions_integridad();

COMMENT ON TABLE proposed_actions IS
  'Acciones críticas propuestas (por una persona, el chat o el sistema) que solo una persona '
  'autorizada confirma desde la interfaz. Ejecución única. Ver packages/domain/src/proposed-actions.ts.';
