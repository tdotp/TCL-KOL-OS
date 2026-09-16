-- 008 · El trigger de "claims con evidencia" le faltaba la excepción de DEC-028.
--
-- Defecto real, encontrado en Sprint 5 al ejercitar por primera vez en toda
-- la vida del proyecto la transición `client_review → approved`
-- (`aprobarComoCliente`) — DEC-027 dejó el ciclo de aprobación final
-- documentado pero sin implementar hasta este incremento, así que ningún
-- test ni demo anterior había tocado nunca este trigger con un brief real.
--
-- `claim_exige_evidencia()` (migración 004) exige evidencia para TODO campo
-- `criticidad IN ('critico', 'claim')` con `status = 'found'` — pero DEC-028
-- (cierre de Sprint 4) ya estableció que un campo `critico` (no `claim`)
-- resuelto por pregunta local se sustenta con `provenance_type =
-- 'manual_local'`, autor y fecha, SIN evidencia documental. El dominio
-- (`requiresEvidence()`, `packages/domain/src/brief-states.ts`) ya aplica esa
-- excepción — el trigger de base, que es la última línea de defensa, no la
-- tenía. Cualquier brief con críticos resueltos por pregunta local (el
-- camino normal para un campo como `practico.fecha_inicio` cuando la fuente
-- no lo trae) revienta al intentar aprobarlo, con o sin cliente de por
-- medio.
--
-- La condición queda idéntica a `requiresEvidence()`: un `claim` la exige
-- siempre; un `critico` la exige salvo que su procedencia sea
-- `manual_local`.

CREATE OR REPLACE FUNCTION claim_exige_evidencia() RETURNS trigger AS $$
DECLARE
  sin_respaldo text;
BEGIN
  SELECT string_agg(f.key, ', ')
    INTO sin_respaldo
    FROM brief_fields f
    JOIN brief_versions v ON v.id = f.brief_version_id
   WHERE v.status = 'approved'
     AND f.status = 'found'
     AND (
       f.criticidad = 'claim'
       OR (f.criticidad = 'critico' AND f.provenance_type <> 'manual_local')
     )
     AND NOT EXISTS (SELECT 1 FROM evidence e WHERE e.brief_field_id = f.id);

  IF sin_respaldo IS NOT NULL THEN
    RAISE EXCEPTION
      'No se puede aprobar: los campos (%) son claims sin evidencia (§15, umbral del 100%%)',
      sin_respaldo;
  END IF;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
