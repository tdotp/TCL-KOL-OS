-- 021 · Chat / agente de Cuenta (V2 · Fase 6): modelo de datos.
--
-- Forward-only y aditiva. No modifica ninguna migración anterior ni reescribe
-- datos históricos: añade claves de referencia compuestas, un índice único
-- parcial en `proposed_actions` (D7), seis tablas nuevas y dos columnas
-- nullable en `ai_runs`. Requiere PostgreSQL >= 15 (`ON DELETE SET NULL (col)`).
--
--   chat_conversations ─┬─< chat_messages ─┬─< chat_message_attachments ─► source_documents
--                       │                  └─< chat_message_references ─► fuente / fragmento /
--                       │                                                snapshot / evidencia
--                       └─< agent_runs ─┬─< agent_tool_invocations ─► proposed_actions
--                                       └─< ai_runs (agent_run_id, columna nueva)
--
-- «Conversación» ya significa «hilo de comentarios del brief» (007): las tablas
-- nuevas llevan el prefijo `chat_` para no mezclar conceptos.
--
-- Principios impuestos AQUÍ (no solo en la aplicación):
--   · Aislamiento: toda fila lleva organization_id y campaign_id y los amarra con
--     claves compuestas (conversación → campaña, autor → usuario de la misma
--     organización, adjunto/cita → fuente de la misma organización Y campaña).
--   · Un mensaje es un hecho: append-only (UPDATE rechazado; DELETE solo con el
--     bypass restringido a bases `_test`, 009/010).
--   · Un solo run activo por conversación (índice único parcial): ni dos turnos
--     del agente a la vez ni un mensaje nuevo con un run en curso.
--   · Estados de run e invocación avanzan por transiciones válidas; los terminales
--     se congelan.
--   · Sin razonamiento interno del modelo: ninguna columna lo admite. El prompt
--     vive en código (versionado en `prompt_version`), no se persiste.
--   · El chat nunca lo habla un usuario `cliente` (autor/creador del chat).
--   · Sin trigger de validación sobre `audit_events` (D5): la correlación sigue
--     siendo genérica y sin FK; solo se indexa para reconstruir la traza.
--
-- Fuera de esta migración: Fase 7 (guiones, deliverables, findings), streaming,
-- resumen de conversación, compartir conversaciones (el esquema lo admite sin migrar).

-- ─────────────────────────── 1. Claves de referencia compuestas ────────────────

ALTER TABLE users
  ADD CONSTRAINT users_id_organization_key UNIQUE (id, organization_id);

ALTER TABLE proposed_actions
  ADD CONSTRAINT proposed_actions_id_organization_campaign_key UNIQUE (id, organization_id, campaign_id);

ALTER TABLE source_fragments
  ADD CONSTRAINT source_fragments_id_source_key UNIQUE (id, source_id);

ALTER TABLE evidence
  ADD CONSTRAINT evidence_id_source_key UNIQUE (id, source_id);

-- ─────────────────────────── 2. Una sola propuesta abierta por acción y recurso (D7)

-- `proponerAccion` ya reutilizaba/vencía la propuesta abierta, pero con FOR UPDATE
-- sobre un conjunto vacío dos propuestas simultáneas podían insertarse. El índice
-- cierra la carrera en la base.
--
-- La migración tolera datos existentes: si hubiera varias propuestas abiertas
-- (pending/confirmed) para el mismo (action_type, resource_id), se conserva UNA
-- —la `confirmed` si existe, si no la más reciente— y las demás se marcan
-- `expired` por la transición válida de 013 (el trigger la admite), dejando un
-- evento de auditoría `proposed_action.expire` con origen `system` y el motivo.
-- No se borra nada ni se toca el contenido de ninguna propuesta.
WITH abiertas AS (
  SELECT id,
         status,
         row_number() OVER (
           PARTITION BY action_type, resource_id
           ORDER BY (status = 'confirmed') DESC, created_at DESC, id DESC
         ) AS posicion
    FROM proposed_actions
   WHERE status IN ('pending', 'confirmed')
), vencidas AS (
  UPDATE proposed_actions p
     SET status = 'expired'
    FROM abiertas a
   WHERE p.id = a.id AND a.posicion > 1
  RETURNING p.id, p.organization_id, p.action_type, a.status AS estado_anterior
)
INSERT INTO audit_events (organization_id, actor_id, action, entity_type, entity_id, metadata, origin, correlation)
SELECT organization_id,
       NULL,
       'proposed_action.expire',
       'proposed_action',
       id,
       jsonb_build_object(
         'type', action_type,
         'estadoAnterior', estado_anterior,
         'motivo', 'migracion_021_propuesta_abierta_duplicada'
       ),
       'system',
       jsonb_build_object('proposedActionId', id::text)
  FROM vencidas;

CREATE UNIQUE INDEX proposed_actions_abierta_key
  ON proposed_actions (action_type, resource_id)
  WHERE status IN ('pending', 'confirmed');

-- ─────────────────────────── 3. Utilidad: el chat es de personal de la agencia ──

-- Regla estable (no duplica la matriz de permisos, que vive en el dominio): un
-- usuario `cliente`, o de una organización de tipo `cliente`, nunca crea una
-- conversación ni escribe en ella, ni siquiera por SQL directo.
CREATE OR REPLACE FUNCTION chat_exigir_personal_de_agencia(p_usuario uuid) RETURNS void AS $$
DECLARE
  rol  text;
  tipo text;
BEGIN
  SELECT u.role::text, o.type::text INTO rol, tipo
    FROM users u JOIN organizations o ON o.id = u.organization_id
   WHERE u.id = p_usuario;
  IF NOT FOUND OR rol = 'cliente' OR tipo = 'cliente' THEN
    RAISE EXCEPTION 'El chat del agente es del personal de la agencia: un usuario cliente no crea conversaciones ni mensajes.';
  END IF;
END;
$$ LANGUAGE plpgsql STABLE;

-- ─────────────────────────── 4. Conversaciones ─────────────────────────────────

-- Owner-scoped (D3): la ve su creador. Sin columna `visibility`: el chat es siempre
-- interno. Compartir una conversación se añadirá sin migrar estas columnas.
CREATE TABLE chat_conversations (
  id               uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id  uuid NOT NULL,
  campaign_id      uuid NOT NULL,
  created_by       uuid NOT NULL,
  title            text,
  status           text NOT NULL DEFAULT 'active',
  -- Último `seq` asignado a un mensaje; lo avanza el trigger de mensajes.
  last_seq         bigint NOT NULL DEFAULT 0,
  last_message_at  timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  archived_at      timestamptz,

  CONSTRAINT chat_conversations_campaign_fkey
    FOREIGN KEY (campaign_id, organization_id)
    REFERENCES campaigns (id, organization_id) ON DELETE RESTRICT,
  -- El creador es de la misma organización que la campaña.
  CONSTRAINT chat_conversations_creador_fkey
    FOREIGN KEY (created_by, organization_id)
    REFERENCES users (id, organization_id) ON DELETE RESTRICT,
  CONSTRAINT chat_conversations_estado_valido CHECK (status IN ('active', 'archived')),
  CONSTRAINT chat_conversations_archivo_coherente CHECK ((status = 'archived') = (archived_at IS NOT NULL)),
  CONSTRAINT chat_conversations_titulo_acotado
    CHECK (title IS NULL OR (btrim(title) <> '' AND char_length(title) <= 200)),
  CONSTRAINT chat_conversations_seq_valida CHECK (last_seq >= 0),
  CONSTRAINT chat_conversations_id_scope_key UNIQUE (id, organization_id, campaign_id)
);

CREATE INDEX chat_conversations_lista_idx
  ON chat_conversations (campaign_id, created_by, status, updated_at DESC);
CREATE INDEX chat_conversations_org_idx ON chat_conversations (organization_id, created_by);

-- ─────────────────────────── 5. Ejecuciones del agente ─────────────────────────

-- Un run = UN turno del agente para UN mensaje de usuario (attempt N). Es el
-- registro durable (D9): el proceso que lo ejecuta puede caer; la fila queda y un
-- barrido lo cierra como `failed` con RUN_ABANDONED (patrón SYNC_ABANDONED, 019).
--
--   queued → running → completed | failed | cancelled
--   queued → failed | cancelled
CREATE TABLE agent_runs (
  id                   uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id      uuid NOT NULL,
  campaign_id          uuid NOT NULL,
  conversation_id      uuid NOT NULL,
  -- La FK compuesta hacia chat_messages se añade tras crear esa tabla (dependencia circular).
  user_message_id      uuid NOT NULL,
  -- La persona en cuyo nombre actúa el agente (nunca `system`).
  user_id              uuid NOT NULL,
  attempt              integer NOT NULL DEFAULT 1,
  status               text NOT NULL DEFAULT 'queued',
  -- Configuración al admitir el run; los valores reales por llamada viven en ai_runs.
  provider             text NOT NULL,
  model                text NOT NULL,
  tier                 text NOT NULL,
  prompt_version       text NOT NULL,
  context_version      text NOT NULL,
  -- Se fijan UNA vez al pasar a `running`: huella y manifiesto (solo ids y conteos,
  -- nunca texto de documentos) de lo que el modelo pudo ver.
  context_hash         text,
  context_manifest     jsonb,
  request_id           text,
  cancel_requested_at  timestamptz,
  heartbeat_at         timestamptz,
  queued_at            timestamptz NOT NULL DEFAULT now(),
  started_at           timestamptz,
  finished_at          timestamptz,
  error_code           text,
  error_message        text,

  CONSTRAINT agent_runs_conversation_fkey
    FOREIGN KEY (conversation_id, organization_id, campaign_id)
    REFERENCES chat_conversations (id, organization_id, campaign_id) ON DELETE RESTRICT,
  CONSTRAINT agent_runs_usuario_fkey
    FOREIGN KEY (user_id, organization_id)
    REFERENCES users (id, organization_id) ON DELETE RESTRICT,
  CONSTRAINT agent_runs_attempt_valido CHECK (attempt >= 1),
  CONSTRAINT agent_runs_estado_valido
    CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
  CONSTRAINT agent_runs_tier_valido CHECK (tier IN ('eficiente', 'equilibrado', 'avanzado')),
  CONSTRAINT agent_runs_configuracion_acotada CHECK (
    btrim(provider) <> '' AND char_length(provider) <= 100
    AND btrim(model) <> '' AND char_length(model) <= 200
    AND btrim(prompt_version) <> '' AND char_length(prompt_version) <= 100
    AND btrim(context_version) <> '' AND char_length(context_version) <= 100
    AND (request_id IS NULL OR char_length(request_id) <= 200)
  ),
  CONSTRAINT agent_runs_contexto_valido CHECK (
    (context_hash IS NULL) = (context_manifest IS NULL)
    AND (context_hash IS NULL OR context_hash ~ '^[0-9a-f]{64}$')
    AND (context_manifest IS NULL
         OR (jsonb_typeof(context_manifest) = 'object' AND octet_length(context_manifest::text) <= 32768))
  ),
  -- `running` y `completed` solo existen con el contexto fijado y la hora de inicio.
  CONSTRAINT agent_runs_inicio_coherente CHECK (
    (status <> 'queued' OR started_at IS NULL)
    AND (status NOT IN ('running', 'completed') OR (started_at IS NOT NULL AND context_hash IS NOT NULL))
  ),
  CONSTRAINT agent_runs_cierre_coherente CHECK ((status IN ('queued', 'running')) = (finished_at IS NULL)),
  -- `failed` ⇔ código de error; el mensaje es opcional, sanitizado y acotado.
  CONSTRAINT agent_runs_error_coherente CHECK (
    (status = 'failed') = (error_code IS NOT NULL)
    AND (error_code IS NULL OR error_code ~ '^[A-Z][A-Z0-9_]{1,63}$')
    AND (error_message IS NULL OR (error_code IS NOT NULL AND char_length(error_message) <= 500))
  ),
  CONSTRAINT agent_runs_mensaje_intento_key UNIQUE (user_message_id, attempt),
  CONSTRAINT agent_runs_id_conversation_key UNIQUE (id, conversation_id),
  CONSTRAINT agent_runs_id_scope_key UNIQUE (id, organization_id, campaign_id),
  CONSTRAINT agent_runs_id_organization_key UNIQUE (id, organization_id)
);

-- Como máximo UN run activo por conversación (patrón 019 `source_sync_runs_activa_key`).
CREATE UNIQUE INDEX agent_runs_activo_key
  ON agent_runs (conversation_id) WHERE status IN ('queued', 'running');
-- Un mensaje de usuario tiene a lo sumo UNA respuesta completada.
CREATE UNIQUE INDEX agent_runs_completado_key
  ON agent_runs (user_message_id) WHERE status = 'completed';
CREATE INDEX agent_runs_conversation_idx ON agent_runs (conversation_id, queued_at DESC);
CREATE INDEX agent_runs_activos_idx ON agent_runs (organization_id, queued_at)
  WHERE status IN ('queued', 'running');

-- ─────────────────────────── 6. Mensajes ───────────────────────────────────────

-- Solo `user` y `assistant`. El prompt de sistema vive en código y el resultado de
-- una tool en `agent_tool_invocations`; ninguno es un mensaje. El mensaje del
-- asistente se escribe UNA vez, al terminar el run; si el run falla no hay mensaje
-- (el estado y el código de error viven en `agent_runs`).
CREATE TABLE chat_messages (
  id                 uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id    uuid NOT NULL,
  campaign_id        uuid NOT NULL,
  conversation_id    uuid NOT NULL,
  -- Orden estable dentro de la conversación: lo asigna el trigger, no el llamador.
  seq                bigint NOT NULL,
  role               text NOT NULL,
  -- Autor (user) o persona en cuyo nombre respondió el agente (assistant).
  user_id            uuid NOT NULL,
  content            text NOT NULL,
  -- SHA-256 del contenido (UTF-8): lo calcula el trigger; sirve para detectar la
  -- reutilización de una clave de idempotencia con otro contenido.
  content_sha256     text NOT NULL,
  -- Clave de idempotencia del cliente (solo mensajes de usuario).
  client_message_id  text,
  -- El run que produjo la respuesta (solo mensajes del asistente).
  agent_run_id       uuid,
  created_at         timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT chat_messages_conversation_fkey
    FOREIGN KEY (conversation_id, organization_id, campaign_id)
    REFERENCES chat_conversations (id, organization_id, campaign_id) ON DELETE RESTRICT,
  CONSTRAINT chat_messages_usuario_fkey
    FOREIGN KEY (user_id, organization_id)
    REFERENCES users (id, organization_id) ON DELETE RESTRICT,
  -- El run es de ESTA conversación.
  CONSTRAINT chat_messages_run_fkey
    FOREIGN KEY (agent_run_id, conversation_id)
    REFERENCES agent_runs (id, conversation_id) ON DELETE RESTRICT,
  CONSTRAINT chat_messages_rol_valido CHECK (role IN ('user', 'assistant')),
  CONSTRAINT chat_messages_contenido_acotado
    CHECK (btrim(content) <> '' AND char_length(content) <= 20000),
  CONSTRAINT chat_messages_hash_valido CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT chat_messages_clave_valida
    CHECK (client_message_id IS NULL OR client_message_id ~ '^[A-Za-z0-9_-]{8,128}$'),
  CONSTRAINT chat_messages_rol_coherente CHECK (
    (role = 'user' AND client_message_id IS NOT NULL AND agent_run_id IS NULL)
    OR (role = 'assistant' AND client_message_id IS NULL AND agent_run_id IS NOT NULL)
  ),
  CONSTRAINT chat_messages_seq_key UNIQUE (conversation_id, seq),
  -- Idempotencia: la misma clave no crea dos mensajes en la conversación.
  CONSTRAINT chat_messages_cliente_key UNIQUE (conversation_id, client_message_id),
  -- Un run produce a lo sumo UN mensaje del asistente.
  CONSTRAINT chat_messages_run_key UNIQUE (agent_run_id),
  CONSTRAINT chat_messages_id_conversation_key UNIQUE (id, conversation_id)
);

CREATE INDEX chat_messages_user_idx ON chat_messages (user_id);

-- Cierra el ciclo: el run cuelga de un mensaje de usuario de SU conversación.
ALTER TABLE agent_runs
  ADD CONSTRAINT agent_runs_mensaje_fkey
    FOREIGN KEY (user_message_id, conversation_id)
    REFERENCES chat_messages (id, conversation_id) ON DELETE RESTRICT;

-- ─────────────────────────── 7. Adjuntos y citas ───────────────────────────────

-- Un adjunto es una fuente (`source_documents`) ya registrada por el flujo de fuentes
-- (archivo o enlace): NO hay un blob paralelo del mensaje. La fuente es de la misma
-- organización Y de la misma campaña que la conversación (dos FK compuestas).
CREATE TABLE chat_message_attachments (
  id               uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id  uuid NOT NULL,
  campaign_id      uuid NOT NULL,
  conversation_id  uuid NOT NULL,
  message_id       uuid NOT NULL,
  source_id        uuid NOT NULL,
  position         integer NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT chat_message_attachments_conversation_fkey
    FOREIGN KEY (conversation_id, organization_id, campaign_id)
    REFERENCES chat_conversations (id, organization_id, campaign_id) ON DELETE RESTRICT,
  CONSTRAINT chat_message_attachments_message_fkey
    FOREIGN KEY (message_id, conversation_id)
    REFERENCES chat_messages (id, conversation_id) ON DELETE RESTRICT,
  CONSTRAINT chat_message_attachments_source_org_fkey
    FOREIGN KEY (source_id, organization_id)
    REFERENCES source_documents (id, organization_id) ON DELETE RESTRICT,
  CONSTRAINT chat_message_attachments_source_campaign_fkey
    FOREIGN KEY (source_id, campaign_id)
    REFERENCES source_documents (id, campaign_id) ON DELETE RESTRICT,
  CONSTRAINT chat_message_attachments_posicion_valida CHECK (position BETWEEN 1 AND 10),
  CONSTRAINT chat_message_attachments_fuente_key UNIQUE (message_id, source_id),
  CONSTRAINT chat_message_attachments_posicion_key UNIQUE (message_id, position)
);

CREATE INDEX chat_message_attachments_source_idx ON chat_message_attachments (source_id);

-- Una cita de un mensaje del asistente a lo que lo respalda. Provenance estructurada:
-- fuente (siempre), y opcionalmente fragmento, snapshot, evidencia y localizador. Se
-- guarda el localizador copiado y la huella del texto del fragmento, NO el texto.
--
-- `fragment_id` y `evidence_id` son `ON DELETE SET NULL (col)`: el worker borra y
-- recrea los fragmentos de un archivo al reprocesarlo y la extracción reemplaza la
-- evidencia; la cita sobrevive con su fuente, su localizador y su huella.
CREATE TABLE chat_message_references (
  id                    uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id       uuid NOT NULL,
  campaign_id           uuid NOT NULL,
  conversation_id       uuid NOT NULL,
  message_id            uuid NOT NULL,
  ordinal               integer NOT NULL,
  source_id             uuid NOT NULL,
  fragment_id           uuid,
  snapshot_id           uuid,
  evidence_id           uuid,
  locator               jsonb,
  fragment_text_sha256  text,
  created_at            timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT chat_message_references_conversation_fkey
    FOREIGN KEY (conversation_id, organization_id, campaign_id)
    REFERENCES chat_conversations (id, organization_id, campaign_id) ON DELETE RESTRICT,
  CONSTRAINT chat_message_references_message_fkey
    FOREIGN KEY (message_id, conversation_id)
    REFERENCES chat_messages (id, conversation_id) ON DELETE RESTRICT,
  CONSTRAINT chat_message_references_source_org_fkey
    FOREIGN KEY (source_id, organization_id)
    REFERENCES source_documents (id, organization_id) ON DELETE RESTRICT,
  CONSTRAINT chat_message_references_source_campaign_fkey
    FOREIGN KEY (source_id, campaign_id)
    REFERENCES source_documents (id, campaign_id) ON DELETE RESTRICT,
  -- El fragmento / el snapshot / la evidencia son de ESA fuente.
  CONSTRAINT chat_message_references_fragment_fkey
    FOREIGN KEY (fragment_id, source_id)
    REFERENCES source_fragments (id, source_id) ON DELETE SET NULL (fragment_id),
  CONSTRAINT chat_message_references_snapshot_fkey
    FOREIGN KEY (snapshot_id, source_id)
    REFERENCES source_snapshots (id, source_id) ON DELETE RESTRICT,
  CONSTRAINT chat_message_references_evidence_fkey
    FOREIGN KEY (evidence_id, source_id)
    REFERENCES evidence (id, source_id) ON DELETE SET NULL (evidence_id),
  CONSTRAINT chat_message_references_ordinal_valido CHECK (ordinal BETWEEN 1 AND 50),
  CONSTRAINT chat_message_references_locator_valido
    CHECK (locator IS NULL OR source_locator_valido(locator)),
  CONSTRAINT chat_message_references_hash_valido
    CHECK (fragment_text_sha256 IS NULL OR fragment_text_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT chat_message_references_ordinal_key UNIQUE (message_id, ordinal)
);

CREATE INDEX chat_message_references_source_idx ON chat_message_references (source_id);
CREATE INDEX chat_message_references_fragment_idx ON chat_message_references (fragment_id)
  WHERE fragment_id IS NOT NULL;

-- ─────────────────────────── 8. Invocaciones de tools ──────────────────────────

-- Una fila por cada llamada de tool de un run. Es el CLAIM de idempotencia (UNIQUE
-- (agent_run_id, idempotency_key)): el caso de uso que ejecuta la tool abre su
-- propia transacción, así que efecto y cierre de la invocación no son atómicos; si
-- el proceso cae en medio, `audit_events.correlation->>'toolInvocationId'` dice si
-- hubo efecto y la clave impide ejecutarlo dos veces.
--
-- `args` y `result` están sanitizados y acotados: ids, conteos, referencias a
-- efectos. Nunca texto de documentos ni razonamiento del modelo.
CREATE TABLE agent_tool_invocations (
  id                  uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id     uuid NOT NULL,
  campaign_id         uuid NOT NULL,
  agent_run_id        uuid NOT NULL,
  -- Orden de la invocación dentro del run (1, 2, 3…) y vuelta del modelo que la pidió.
  sequence            integer NOT NULL,
  step_index          integer NOT NULL DEFAULT 0,
  -- Id de la llamada que devolvió el proveedor, si lo hay.
  tool_call_id        text,
  tool_name           text NOT NULL,
  risk_class          text NOT NULL,
  args                jsonb NOT NULL DEFAULT '{}'::jsonb,
  args_sha256         text NOT NULL,
  status              text NOT NULL DEFAULT 'running',
  result              jsonb,
  error_code          text,
  idempotency_key     text NOT NULL,
  -- Solo las tools de confirmación requerida: la propuesta que dejaron.
  proposed_action_id  uuid,
  started_at          timestamptz NOT NULL DEFAULT now(),
  finished_at         timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT agent_tool_invocations_run_fkey
    FOREIGN KEY (agent_run_id, organization_id, campaign_id)
    REFERENCES agent_runs (id, organization_id, campaign_id) ON DELETE RESTRICT,
  CONSTRAINT agent_tool_invocations_propuesta_fkey
    FOREIGN KEY (proposed_action_id, organization_id, campaign_id)
    REFERENCES proposed_actions (id, organization_id, campaign_id) ON DELETE RESTRICT,
  CONSTRAINT agent_tool_invocations_secuencia_valida CHECK (sequence >= 1 AND step_index >= 0),
  CONSTRAINT agent_tool_invocations_riesgo_valido
    CHECK (risk_class IN ('read', 'write', 'confirmation_required', 'unregistered')),
  CONSTRAINT agent_tool_invocations_estado_valido
    CHECK (status IN ('running', 'succeeded', 'failed', 'cancelled')),
  CONSTRAINT agent_tool_invocations_texto_acotado CHECK (
    btrim(tool_name) <> '' AND char_length(tool_name) <= 100
    AND (tool_call_id IS NULL OR (btrim(tool_call_id) <> '' AND char_length(tool_call_id) <= 200))
    AND btrim(idempotency_key) <> '' AND char_length(idempotency_key) <= 200
  ),
  CONSTRAINT agent_tool_invocations_args_acotados
    CHECK (jsonb_typeof(args) = 'object' AND octet_length(args::text) <= 16384),
  CONSTRAINT agent_tool_invocations_hash_valido CHECK (args_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT agent_tool_invocations_resultado_acotado CHECK (
    result IS NULL
    OR (status = 'succeeded' AND jsonb_typeof(result) = 'object' AND octet_length(result::text) <= 32768)
  ),
  CONSTRAINT agent_tool_invocations_cierre_coherente CHECK ((status = 'running') = (finished_at IS NULL)),
  CONSTRAINT agent_tool_invocations_error_coherente CHECK (
    (status = 'failed') = (error_code IS NOT NULL)
    AND (error_code IS NULL OR (error_code ~ '^[A-Z][A-Z0-9_]{1,99}$'))
  ),
  CONSTRAINT agent_tool_invocations_propuesta_coherente
    CHECK (proposed_action_id IS NULL OR (risk_class = 'confirmation_required' AND status = 'succeeded')),
  CONSTRAINT agent_tool_invocations_secuencia_key UNIQUE (agent_run_id, sequence),
  CONSTRAINT agent_tool_invocations_clave_key UNIQUE (agent_run_id, idempotency_key),
  CONSTRAINT agent_tool_invocations_id_run_key UNIQUE (id, agent_run_id)
);

CREATE UNIQUE INDEX agent_tool_invocations_llamada_key
  ON agent_tool_invocations (agent_run_id, tool_call_id) WHERE tool_call_id IS NOT NULL;
CREATE INDEX agent_tool_invocations_propuesta_idx
  ON agent_tool_invocations (proposed_action_id) WHERE proposed_action_id IS NOT NULL;
CREATE INDEX agent_tool_invocations_tool_idx
  ON agent_tool_invocations (organization_id, tool_name, created_at DESC);
CREATE INDEX agent_tool_invocations_abiertas_idx
  ON agent_tool_invocations (agent_run_id) WHERE status = 'running';

-- ─────────────────────────── 9. ai_runs: costo por llamada del turno ───────────

-- `ai_runs` sigue siendo el registro posterior de UNA llamada al proveedor (también
-- lo escribe el worker de Python: la columna nueva es nullable y su INSERT no
-- cambia). Un turno del agente = N llamadas = N filas con el mismo `agent_run_id`;
-- el costo del turno es SUM(cost_usd) por run.
ALTER TABLE ai_runs
  ADD COLUMN agent_run_id uuid,
  ADD COLUMN step_index   integer;

ALTER TABLE ai_runs
  ADD CONSTRAINT ai_runs_agent_run_fkey
    FOREIGN KEY (agent_run_id, organization_id)
    REFERENCES agent_runs (id, organization_id) ON DELETE SET NULL (agent_run_id),
  -- `step_index` no exige `agent_run_id`: al borrar un run (solo posible en bases `_test`) la FK
  -- deja `agent_run_id` en NULL y la llamada conserva su vuelta.
  ADD CONSTRAINT ai_runs_step_valido CHECK (step_index IS NULL OR step_index >= 0);

CREATE INDEX ai_runs_agent_run_idx ON ai_runs (agent_run_id) WHERE agent_run_id IS NOT NULL;

-- La llamada es de la MISMA campaña que su run (cuando ambos la declaran).
CREATE OR REPLACE FUNCTION ai_runs_agent_run_coherente() RETURNS trigger AS $$
DECLARE
  campana uuid;
BEGIN
  IF NEW.agent_run_id IS NULL THEN RETURN NEW; END IF;
  SELECT campaign_id INTO campana FROM agent_runs WHERE id = NEW.agent_run_id;
  IF NEW.campaign_id IS NOT NULL AND campana IS NOT NULL AND NEW.campaign_id <> campana THEN
    RAISE EXCEPTION 'La llamada de IA declara una campaña distinta de la del run del agente.';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER ai_runs_agent_run
  BEFORE INSERT OR UPDATE OF agent_run_id, campaign_id ON ai_runs
  FOR EACH ROW EXECUTE FUNCTION ai_runs_agent_run_coherente();

-- ─────────────────────────── 10. Índices de la traza de auditoría ──────────────

-- La correlación es jsonb genérico y sin FK (012, D5): estos índices parciales de
-- expresión permiten reconstruir usuario → conversación → mensaje → run → tool →
-- efecto sin escanear `audit_events`. No hay trigger de validación: las pruebas y
-- los casos de uso históricos escriben ids que no son UUID.
CREATE INDEX audit_events_conversation_idx
  ON audit_events (organization_id, (correlation->>'conversationId'))
  WHERE correlation->>'conversationId' IS NOT NULL;
CREATE INDEX audit_events_message_idx
  ON audit_events (organization_id, (correlation->>'messageId'))
  WHERE correlation->>'messageId' IS NOT NULL;
CREATE INDEX audit_events_agent_run_idx
  ON audit_events (organization_id, (correlation->>'agentRunId'))
  WHERE correlation->>'agentRunId' IS NOT NULL;
CREATE INDEX audit_events_tool_invocation_idx
  ON audit_events (organization_id, (correlation->>'toolInvocationId'))
  WHERE correlation->>'toolInvocationId' IS NOT NULL;

-- ─────────────────────────── 11. Triggers: conversaciones ──────────────────────

CREATE OR REPLACE FUNCTION chat_conversaciones_integridad() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF inmutabilidad_bypass_activo() THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'Una conversación del chat no se borra.';
  END IF;

  IF TG_OP = 'INSERT' THEN
    PERFORM chat_exigir_personal_de_agencia(NEW.created_by);
    IF NEW.last_seq <> 0 OR NEW.status <> 'active' THEN
      RAISE EXCEPTION 'Una conversación nace vacía y activa.';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
     OR NEW.campaign_id IS DISTINCT FROM OLD.campaign_id
     OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'La identidad de una conversación no se modifica.';
  END IF;
  IF OLD.status = 'archived' THEN
    RAISE EXCEPTION 'Una conversación archivada no se modifica.';
  END IF;
  -- Solo el trigger de mensajes avanza `last_seq`, de uno en uno.
  IF NEW.last_seq <> OLD.last_seq AND NEW.last_seq <> OLD.last_seq + 1 THEN
    RAISE EXCEPTION 'last_seq solo avanza de uno en uno al registrar un mensaje.';
  END IF;
  IF NEW.status = 'archived' AND EXISTS (
    SELECT 1 FROM agent_runs WHERE conversation_id = NEW.id AND status IN ('queued', 'running')
  ) THEN
    RAISE EXCEPTION 'No se archiva una conversación con un run del agente activo.';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER chat_conversaciones_integridad
  BEFORE INSERT OR UPDATE OR DELETE ON chat_conversations
  FOR EACH ROW EXECUTE FUNCTION chat_conversaciones_integridad();

-- ─────────────────────────── 12. Triggers: mensajes ────────────────────────────

CREATE OR REPLACE FUNCTION chat_mensajes_preparar() RETURNS trigger AS $$
DECLARE
  estado_conv text;
  run         agent_runs%ROWTYPE;
BEGIN
  -- Bloquea la conversación: serializa mensajes y runs de esa conversación.
  SELECT status INTO estado_conv FROM chat_conversations WHERE id = NEW.conversation_id FOR UPDATE;
  IF estado_conv IS DISTINCT FROM 'active' THEN
    RAISE EXCEPTION 'No se escribe en una conversación archivada.';
  END IF;
  PERFORM chat_exigir_personal_de_agencia(NEW.user_id);

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

CREATE TRIGGER chat_mensajes_preparar
  BEFORE INSERT ON chat_messages
  FOR EACH ROW EXECUTE FUNCTION chat_mensajes_preparar();

CREATE OR REPLACE FUNCTION chat_historico_inmutable() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF inmutabilidad_bypass_activo() THEN RETURN OLD; END IF;
    RAISE EXCEPTION '% es histórico y no se borra.', TG_TABLE_NAME;
  END IF;
  RAISE EXCEPTION '% es histórico y no se modifica.', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER chat_messages_sin_cambios
  BEFORE UPDATE OR DELETE ON chat_messages
  FOR EACH ROW EXECUTE FUNCTION chat_historico_inmutable();
CREATE TRIGGER chat_message_attachments_sin_cambios
  BEFORE UPDATE OR DELETE ON chat_message_attachments
  FOR EACH ROW EXECUTE FUNCTION chat_historico_inmutable();

-- ─────────────────────────── 13. Triggers: adjuntos y citas ────────────────────

-- Un adjunto solo existe en el INSERT del mensaje de usuario (misma transacción):
-- no se «agrega» un adjunto a un mensaje antiguo.
CREATE OR REPLACE FUNCTION chat_adjuntos_misma_transaccion() RETURNS trigger AS $$
DECLARE
  rol_mensaje text;
  creado      timestamptz;
BEGIN
  SELECT role, created_at INTO rol_mensaje, creado FROM chat_messages WHERE id = NEW.message_id;
  IF rol_mensaje IS DISTINCT FROM 'user' THEN
    RAISE EXCEPTION 'Solo un mensaje de usuario lleva adjuntos.';
  END IF;
  IF creado <> now() THEN
    RAISE EXCEPTION 'Un adjunto solo se registra al crear el mensaje: no se agrega a un mensaje anterior.';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER chat_message_attachments_misma_transaccion
  BEFORE INSERT ON chat_message_attachments
  FOR EACH ROW EXECUTE FUNCTION chat_adjuntos_misma_transaccion();

-- Una cita solo cuelga de un mensaje del asistente, en su misma transacción, y su
-- snapshot, localizador y huella se DERIVAN del fragmento (no se confía en el llamador).
CREATE OR REPLACE FUNCTION chat_referencias_coherentes() RETURNS trigger AS $$
DECLARE
  rol_mensaje   text;
  creado        timestamptz;
  frag_snapshot uuid;
  frag_locator  jsonb;
  frag_hash     text;
  evid_fragment uuid;
BEGIN
  SELECT role, created_at INTO rol_mensaje, creado FROM chat_messages WHERE id = NEW.message_id;
  IF rol_mensaje IS DISTINCT FROM 'assistant' THEN
    RAISE EXCEPTION 'Solo un mensaje del asistente lleva citas.';
  END IF;
  IF creado <> now() THEN
    RAISE EXCEPTION 'Una cita solo se registra al crear el mensaje: no se agrega a un mensaje anterior.';
  END IF;

  IF NEW.fragment_id IS NOT NULL THEN
    SELECT f.snapshot_id, f.locator, encode(sha256(convert_to(f.text, 'UTF8')), 'hex')
      INTO frag_snapshot, frag_locator, frag_hash
      FROM source_fragments f WHERE f.id = NEW.fragment_id AND f.source_id = NEW.source_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'La cita apunta a un fragmento que no existe o es de otra fuente.';
    END IF;
    IF NEW.snapshot_id IS NOT NULL AND NEW.snapshot_id IS DISTINCT FROM frag_snapshot THEN
      RAISE EXCEPTION 'El snapshot de la cita no coincide con el de su fragmento.';
    END IF;
    IF NEW.locator IS NOT NULL AND NEW.locator IS DISTINCT FROM frag_locator THEN
      RAISE EXCEPTION 'El localizador de la cita no coincide con el de su fragmento.';
    END IF;
    IF NEW.fragment_text_sha256 IS NOT NULL AND NEW.fragment_text_sha256 <> frag_hash THEN
      RAISE EXCEPTION 'La huella de la cita no coincide con el texto de su fragmento.';
    END IF;
    NEW.snapshot_id := frag_snapshot;
    NEW.locator := frag_locator;
    NEW.fragment_text_sha256 := frag_hash;
  ELSIF NEW.fragment_text_sha256 IS NOT NULL THEN
    RAISE EXCEPTION 'No hay huella de fragmento sin fragmento citado.';
  END IF;

  IF NEW.evidence_id IS NOT NULL AND NEW.fragment_id IS NOT NULL THEN
    SELECT fragment_id INTO evid_fragment FROM evidence WHERE id = NEW.evidence_id;
    IF evid_fragment IS NOT NULL AND evid_fragment <> NEW.fragment_id THEN
      RAISE EXCEPTION 'La evidencia citada corresponde a otro fragmento.';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER chat_message_references_coherentes
  BEFORE INSERT ON chat_message_references
  FOR EACH ROW EXECUTE FUNCTION chat_referencias_coherentes();

-- La cita no se reescribe. Única excepción: las acciones `ON DELETE SET NULL` de las
-- FK de fragmento y evidencia (el fragmento/evidencia se reemplaza; la cita conserva
-- fuente, localizador y huella).
CREATE OR REPLACE FUNCTION chat_referencias_inmutables() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF inmutabilidad_bypass_activo() THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'Una cita del chat es histórica y no se borra.';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
     OR NEW.campaign_id IS DISTINCT FROM OLD.campaign_id
     OR NEW.conversation_id IS DISTINCT FROM OLD.conversation_id
     OR NEW.message_id IS DISTINCT FROM OLD.message_id
     OR NEW.ordinal IS DISTINCT FROM OLD.ordinal
     OR NEW.source_id IS DISTINCT FROM OLD.source_id
     OR NEW.snapshot_id IS DISTINCT FROM OLD.snapshot_id
     OR NEW.locator IS DISTINCT FROM OLD.locator
     OR NEW.fragment_text_sha256 IS DISTINCT FROM OLD.fragment_text_sha256
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR (NEW.fragment_id IS NOT NULL AND NEW.fragment_id IS DISTINCT FROM OLD.fragment_id)
     OR (NEW.evidence_id IS NOT NULL AND NEW.evidence_id IS DISTINCT FROM OLD.evidence_id) THEN
    RAISE EXCEPTION 'Una cita del chat es histórica: solo pierde su fragmento o evidencia si estos se reemplazan.';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER chat_message_references_sin_cambios
  BEFORE UPDATE OR DELETE ON chat_message_references
  FOR EACH ROW EXECUTE FUNCTION chat_referencias_inmutables();

-- ─────────────────────────── 14. Triggers: runs ────────────────────────────────

CREATE OR REPLACE FUNCTION agent_runs_integridad() RETURNS trigger AS $$
DECLARE
  msg_rol       text;
  msg_conv      uuid;
  msg_user      uuid;
  estado_conv   text;
  max_intento   integer;
  estado_previo text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF inmutabilidad_bypass_activo() THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'Un run del agente es histórico y no se borra.';
  END IF;

  IF TG_OP = 'INSERT' THEN
    PERFORM chat_exigir_personal_de_agencia(NEW.user_id);
    IF NEW.status <> 'queued' THEN
      RAISE EXCEPTION 'Un run nace en cola (queued).';
    END IF;
    SELECT status INTO estado_conv FROM chat_conversations WHERE id = NEW.conversation_id;
    IF estado_conv IS DISTINCT FROM 'active' THEN
      RAISE EXCEPTION 'No se lanza un run en una conversación archivada.';
    END IF;
    SELECT role, conversation_id, user_id INTO msg_rol, msg_conv, msg_user
      FROM chat_messages WHERE id = NEW.user_message_id;
    IF NOT FOUND OR msg_rol <> 'user' OR msg_conv <> NEW.conversation_id OR msg_user <> NEW.user_id THEN
      RAISE EXCEPTION 'El run debe colgar de un mensaje de usuario de su conversación, de la misma persona.';
    END IF;
    -- Intentos consecutivos; solo se reintenta tras un intento fallido o cancelado.
    SELECT max(attempt) INTO max_intento FROM agent_runs WHERE user_message_id = NEW.user_message_id;
    IF NEW.attempt <> COALESCE(max_intento, 0) + 1 THEN
      RAISE EXCEPTION 'Los intentos de un run son consecutivos (esperado %).', COALESCE(max_intento, 0) + 1;
    END IF;
    IF max_intento IS NOT NULL THEN
      SELECT status INTO estado_previo FROM agent_runs
       WHERE user_message_id = NEW.user_message_id AND attempt = max_intento;
      IF estado_previo NOT IN ('failed', 'cancelled') THEN
        RAISE EXCEPTION 'Solo se reintenta un run fallido o cancelado (el anterior está %).', estado_previo;
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  -- UPDATE
  IF OLD.status IN ('completed', 'failed', 'cancelled') THEN
    RAISE EXCEPTION 'El run ya terminó (%): no se modifica.', OLD.status;
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
     OR NEW.campaign_id IS DISTINCT FROM OLD.campaign_id
     OR NEW.conversation_id IS DISTINCT FROM OLD.conversation_id
     OR NEW.user_message_id IS DISTINCT FROM OLD.user_message_id
     OR NEW.user_id IS DISTINCT FROM OLD.user_id
     OR NEW.attempt IS DISTINCT FROM OLD.attempt
     OR NEW.provider IS DISTINCT FROM OLD.provider
     OR NEW.model IS DISTINCT FROM OLD.model
     OR NEW.tier IS DISTINCT FROM OLD.tier
     OR NEW.prompt_version IS DISTINCT FROM OLD.prompt_version
     OR NEW.context_version IS DISTINCT FROM OLD.context_version
     OR NEW.queued_at IS DISTINCT FROM OLD.queued_at THEN
    RAISE EXCEPTION 'La identidad de un run del agente no se modifica.';
  END IF;
  -- Lo que se fija una vez, no se reescribe.
  IF (OLD.context_hash IS NOT NULL AND NEW.context_hash IS DISTINCT FROM OLD.context_hash)
     OR (OLD.context_manifest IS NOT NULL AND NEW.context_manifest IS DISTINCT FROM OLD.context_manifest)
     OR (OLD.started_at IS NOT NULL AND NEW.started_at IS DISTINCT FROM OLD.started_at)
     OR (OLD.cancel_requested_at IS NOT NULL AND NEW.cancel_requested_at IS DISTINCT FROM OLD.cancel_requested_at)
     OR (OLD.request_id IS NOT NULL AND NEW.request_id IS DISTINCT FROM OLD.request_id) THEN
    RAISE EXCEPTION 'El contexto, el inicio, la solicitud de cancelación y el request_id se fijan una sola vez.';
  END IF;

  IF NEW.status <> OLD.status THEN
    IF NOT (
         (OLD.status = 'queued'  AND NEW.status IN ('running', 'failed', 'cancelled'))
      OR (OLD.status = 'running' AND NEW.status IN ('completed', 'failed', 'cancelled'))
    ) THEN
      RAISE EXCEPTION 'Transición de run no válida: % → %.', OLD.status, NEW.status;
    END IF;
    IF NEW.status = 'completed' AND NOT EXISTS (
      SELECT 1 FROM chat_messages WHERE agent_run_id = NEW.id AND role = 'assistant'
    ) THEN
      RAISE EXCEPTION 'Un run solo se completa con su mensaje del asistente.';
    END IF;
    IF NEW.status IN ('completed', 'failed', 'cancelled') AND EXISTS (
      SELECT 1 FROM agent_tool_invocations WHERE agent_run_id = NEW.id AND status = 'running'
    ) THEN
      RAISE EXCEPTION 'Un run no termina con invocaciones de tools abiertas: ciérrelas primero.';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER agent_runs_integridad
  BEFORE INSERT OR UPDATE OR DELETE ON agent_runs
  FOR EACH ROW EXECUTE FUNCTION agent_runs_integridad();

-- ─────────────────────────── 15. Triggers: invocaciones de tools ───────────────

CREATE OR REPLACE FUNCTION agent_tool_invocations_integridad() RETURNS trigger AS $$
DECLARE
  estado_run text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF inmutabilidad_bypass_activo() THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'Una invocación de tool es histórica y no se borra.';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'running' THEN
      RAISE EXCEPTION 'Una invocación de tool nace en ejecución (running).';
    END IF;
    SELECT status INTO estado_run FROM agent_runs WHERE id = NEW.agent_run_id;
    IF estado_run IS DISTINCT FROM 'running' THEN
      RAISE EXCEPTION 'Solo un run en ejecución abre invocaciones de tools.';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.status <> 'running' THEN
    RAISE EXCEPTION 'La invocación ya terminó (%): no se modifica.', OLD.status;
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
     OR NEW.campaign_id IS DISTINCT FROM OLD.campaign_id
     OR NEW.agent_run_id IS DISTINCT FROM OLD.agent_run_id
     OR NEW.sequence IS DISTINCT FROM OLD.sequence
     OR NEW.step_index IS DISTINCT FROM OLD.step_index
     OR NEW.tool_call_id IS DISTINCT FROM OLD.tool_call_id
     OR NEW.tool_name IS DISTINCT FROM OLD.tool_name
     OR NEW.risk_class IS DISTINCT FROM OLD.risk_class
     OR NEW.args IS DISTINCT FROM OLD.args
     OR NEW.args_sha256 IS DISTINCT FROM OLD.args_sha256
     OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
     OR NEW.started_at IS DISTINCT FROM OLD.started_at
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'La identidad de una invocación de tool no se modifica: solo se cierra.';
  END IF;
  IF NEW.status = 'running' THEN
    RAISE EXCEPTION 'Una invocación en ejecución solo cambia al cerrarse (succeeded, failed o cancelled).';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER agent_tool_invocations_integridad
  BEFORE INSERT OR UPDATE OR DELETE ON agent_tool_invocations
  FOR EACH ROW EXECUTE FUNCTION agent_tool_invocations_integridad();

-- ─────────────────────────── 16. Documentación ─────────────────────────────────

COMMENT ON TABLE chat_conversations IS
  'Conversación del chat de una campaña (owner-scoped: la ve su creador). Solo personal de la agencia.';
COMMENT ON TABLE chat_messages IS
  'Mensajes del chat (user | assistant), append-only, con seq asignado por trigger e idempotencia por client_message_id. '
  'Sin razonamiento interno del modelo.';
COMMENT ON TABLE chat_message_attachments IS
  'Fuente (source_documents, misma organización y campaña) adjunta a un mensaje de usuario. Sin blob paralelo.';
COMMENT ON TABLE chat_message_references IS
  'Cita estructurada de un mensaje del asistente a fuente/fragmento/snapshot/evidencia, con localizador y huella del texto.';
COMMENT ON TABLE agent_runs IS
  'Un turno del agente para un mensaje de usuario (attempt N). Fila durable; a lo sumo un run activo por conversación.';
COMMENT ON TABLE agent_tool_invocations IS
  'Llamada de tool dentro de un run: claim de idempotencia, argumentos y resultado sanitizados y acotados, enlace a la propuesta HITL.';
COMMENT ON COLUMN ai_runs.agent_run_id IS
  'Run del agente al que pertenece esta llamada al proveedor (NULL para extracción y otras tareas).';
