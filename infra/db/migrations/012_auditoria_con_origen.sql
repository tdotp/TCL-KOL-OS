-- 012 · Auditoría con origen (V2 · Fase 1C).
--
-- `audit_events` se conserva como único registro de auditoría. Se le añaden,
-- de forma aditiva y compatible hacia atrás:
--
--   · `origin`      — canal desde el que ocurrió la acción: 'ui' (persona en la
--                     interfaz), 'chat' (agente conversacional) o 'system'
--                     (worker / proceso automático).
--   · `correlation` — referencia opcional y genérica al contexto que la originó
--                     (conversación, mensaje, ejecución del agente, acción
--                     propuesta). Sin FK a propósito: esas entidades todavía no
--                     existen y no se inventan aquí.
--
-- Los eventos históricos NO se reescriben (la tabla es de solo inserción):
-- conservan `origin` y `correlation` en NULL, que significa «anterior a V2,
-- origen no registrado». Todo evento nuevo lo escribe `recordAudit` con un
-- origen explícito.
ALTER TABLE audit_events
  ADD COLUMN origin      text,
  ADD COLUMN correlation jsonb;

ALTER TABLE audit_events
  ADD CONSTRAINT audit_events_origin_valido
    CHECK (origin IS NULL OR origin IN ('ui', 'chat', 'system')),
  ADD CONSTRAINT audit_events_correlation_objeto
    CHECK (correlation IS NULL OR jsonb_typeof(correlation) = 'object');

COMMENT ON COLUMN audit_events.origin IS
  'Canal de la acción: ui | chat | system. NULL = evento anterior a V2 (origen no registrado).';
COMMENT ON COLUMN audit_events.correlation IS
  'Correlación opcional (conversationId, messageId, agentRunId, proposedActionId). Sin FK.';
