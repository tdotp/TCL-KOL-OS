-- 022 · Endurecimiento del chat (V2 · Fase 6.1): defensa en profundidad en la base.
--
-- Cierra QA-10, QA-11 y QA-12 del QA adversarial de la Fase 6. Forward-only y
-- aditiva: solo reemplaza funciones de trigger (CREATE OR REPLACE) y amplía un
-- trigger de INSERT. NO cambia tablas, columnas, índices ni datos, y los triggers
-- solo se evalúan sobre filas NUEVAS: las conversaciones, mensajes y propuestas
-- que ya existen no se revalidan ni se reescriben. Los casos de uso, el runtime,
-- las tools y la UI no cambian de comportamiento: estas reglas ya se aplicaban en
-- la capa de aplicación; ahora además las impone la base ante SQL directo.
--
--   QA-10 · Owner-scope de mensajes: solo la persona dueña de la conversación
--           (`chat_conversations.created_by`) escribe en ella. El asistente
--           responde en nombre de esa misma persona (el run es suyo).
--   QA-11 · Rol autorizado del dueño: crear una conversación, escribir en ella o
--           lanzar un run exige una persona de una organización de agencia con un
--           rol que tiene `chat:write`: admin, director o consultor. Antes solo se
--           excluía al `cliente`. La lista espeja la matriz de permisos del dominio
--           (packages/domain/src/permissions.ts); una prueba de paridad en
--           packages/db detecta si divergen.
--   QA-12 · Una acción propuesta NACE `pending`: sin confirmación, ejecución ni
--           cancelación. Los demás estados (confirmed, executed, cancelled, expired)
--           solo se alcanzan por UPDATE, con las transiciones ya validadas en 013.
--           (agent_runs, agent_tool_invocations y chat_conversations ya impedían
--           nacer en un estado distinto del inicial desde la 021.)

-- ─────────────────────────── QA-11 · rol autorizado del dueño ───────────────────

-- Misma firma y mismo uso que en la 021 (conversaciones, mensajes y runs).
CREATE OR REPLACE FUNCTION chat_exigir_personal_de_agencia(p_usuario uuid) RETURNS void AS $$
DECLARE
  rol  text;
  tipo text;
BEGIN
  SELECT u.role::text, o.type::text INTO rol, tipo
    FROM users u JOIN organizations o ON o.id = u.organization_id
   WHERE u.id = p_usuario;
  IF NOT FOUND
     OR tipo IS DISTINCT FROM 'agencia'
     OR rol NOT IN ('admin', 'director', 'consultor') THEN
    RAISE EXCEPTION 'El chat del agente es del personal de la agencia con acceso al chat (admin, director o consultor): este usuario no crea conversaciones, mensajes ni runs.';
  END IF;
END;
$$ LANGUAGE plpgsql STABLE;

-- ─────────────────────────── QA-10 · owner-scope de mensajes ────────────────────

CREATE OR REPLACE FUNCTION chat_mensajes_preparar() RETURNS trigger AS $$
DECLARE
  estado_conv text;
  dueno       uuid;
  run         agent_runs%ROWTYPE;
BEGIN
  -- Bloquea la conversación: serializa mensajes y runs de esa conversación.
  SELECT status, created_by INTO estado_conv, dueno
    FROM chat_conversations WHERE id = NEW.conversation_id FOR UPDATE;
  IF estado_conv IS DISTINCT FROM 'active' THEN
    RAISE EXCEPTION 'No se escribe en una conversación archivada.';
  END IF;
  PERFORM chat_exigir_personal_de_agencia(NEW.user_id);
  IF NEW.user_id IS DISTINCT FROM dueno THEN
    RAISE EXCEPTION 'La conversación es personal: solo la persona que la creó escribe en ella.';
  END IF;

  IF NEW.role = 'user' THEN
    IF EXISTS (
      SELECT 1 FROM agent_runs
       WHERE conversation_id = NEW.conversation_id AND status IN ('queued', 'running')
    ) THEN
      RAISE EXCEPTION 'La conversación tiene un run del agente activo: no admite otro mensaje hasta que termine.';
    END IF;
  ELSIF NEW.role = 'assistant' THEN
    SELECT * INTO run FROM agent_runs WHERE id = NEW.agent_run_id;
    IF NOT FOUND OR run.status <> 'running' OR run.conversation_id <> NEW.conversation_id THEN
      RAISE EXCEPTION 'El mensaje del asistente solo se escribe para un run en ejecución de esta conversación.';
    END IF;
    IF run.user_id <> NEW.user_id THEN
      RAISE EXCEPTION 'El asistente responde en nombre de la persona que lanzó el run.';
    END IF;
  ELSE
    RAISE EXCEPTION 'Un mensaje del chat es de un usuario o del asistente (rol «%» no válido).', NEW.role;
  END IF;

  NEW.created_at := now();
  NEW.content_sha256 := encode(sha256(convert_to(NEW.content, 'UTF8')), 'hex');
  UPDATE chat_conversations
     SET last_seq = last_seq + 1, last_message_at = now()
   WHERE id = NEW.conversation_id
  RETURNING last_seq INTO NEW.seq;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ─────────────────────────── QA-12 · una propuesta nace pending ─────────────────

-- Idéntica a la función de la 013 salvo la rama de INSERT.
CREATE OR REPLACE FUNCTION proposed_actions_integridad() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'pending'
       OR NEW.confirmed_by IS NOT NULL OR NEW.confirmed_at IS NOT NULL
       OR NEW.executed_at  IS NOT NULL
       OR NEW.cancelled_by IS NOT NULL OR NEW.cancelled_at IS NOT NULL THEN
      RAISE EXCEPTION 'Una acción propuesta nace pendiente (pending), sin confirmación, ejecución ni cancelación: los demás estados solo se alcanzan por transición.';
    END IF;
    RETURN NEW;
  END IF;

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

DROP TRIGGER IF EXISTS proposed_actions_integridad ON proposed_actions;
CREATE TRIGGER proposed_actions_integridad
  BEFORE INSERT OR UPDATE OR DELETE ON proposed_actions
  FOR EACH ROW EXECUTE FUNCTION proposed_actions_integridad();
