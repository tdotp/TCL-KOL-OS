-- 025 · Endurecimiento de contenido (V2 · Fase 7): cierra los hallazgos de la QA adversarial de las
-- migraciones 023 y 024 (QA-F7-01a/01b/01c/02a/03a/G1).
--
-- Forward-only y aditiva: una restricción UNIQUE y cinco funciones/triggers NUEVOS. No cambia ninguna
-- columna ni fila, no reescribe ninguna función existente y no toca las migraciones 001–024. Los triggers
-- solo se evalúan sobre filas nuevas o sobre cambios posteriores (la restricción UNIQUE sí valida las filas
-- existentes: ver el punto 1).
--
--   1. Una fuente es versión de EXACTAMENTE un entregable          (QA-F7-01c · QA-F7-02a)
--   2. Los fragmentos de un guion procesado no se reescriben       (QA-F7-01a)
--   3. `deliverables.last_version` = MAX(version), sin huecos      (QA-F7-01b)
--   4. Aprobar exige revisión y Brief de la misma campaña          (QA-F7-03a)
--   5. La historia no se vacía con TRUNCATE … CASCADE              (QA-F7-G1)
--
-- Todos respetan `inmutabilidad_bypass_activo()` (solo bases `_test`) para que la limpieza de pruebas siga
-- funcionando exactamente como hasta ahora.

-- ─────────────────────── 1. Una fuente, un solo entregable ─────────────────────────

-- La deduplicación de `registrarVersionDeGuion` corría bajo el mutex del ENTREGABLE: dos registros
-- simultáneos (o un INSERT directo) de la MISMA fuente hacia entregables distintos dejaban a un archivo como
-- guion de dos personas. Un archivo ES una versión: una sola. La carrera se resuelve ahora en la base y el
-- caso de uso la traduce a `deduplicated`.
--
-- Si una base ya tuviera la misma fuente en dos versiones, esta restricción falla a propósito (no se elige
-- una por el usuario): hay que resolver el duplicado a mano antes de migrar.
ALTER TABLE script_versions
  ADD CONSTRAINT script_versions_fuente_unica_key UNIQUE (source_document_id);

-- ─────────────────────── 2. Fragmentos de un guion registrado ──────────────────────

-- La revisión de un guion (y los hallazgos, que citan `fragment_text_hash`) se hizo sobre el texto extraído
-- de su fuente. La 023 congeló el ORIGINAL (`source_documents`), pero el texto extraído seguía siendo
-- reescribible por SQL. Se congela cuando el texto ya es «el que se revisó»:
--   · la fuente está ligada a una versión de guion Y (su estado es `procesado` O ya tiene una revisión).
-- No se bloquea lo legítimo:
--   · mientras la fuente aún no está `procesado` (el worker ingiere después de registrar el guion, o
--     reprocesa una fuente `fallido` por `retrySource`): el worker borra e inserta sus fragmentos;
--   · el índice vectorial (`embedding`) lo calcula el worker DESPUÉS de procesar y no es contenido: su UPDATE
--     sigue permitido;
--   · fuentes NO ligadas a un guion y snapshots de Google Sheets (su trigger propio ya los protege; un guion
--     es siempre un archivo): no se evalúan.
-- INSERT queda fuera a propósito: una fuente `procesado` no se reingiere (retrySource lo rechaza) y el
-- INSERT del worker ocurre antes de pasar a `procesado`.
CREATE OR REPLACE FUNCTION source_fragments_guion_inmutable() RETURNS trigger AS $$
DECLARE
  fuente uuid;
BEGIN
  IF inmutabilidad_bypass_activo() THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    -- Solo el índice vectorial cambia: no es contenido.
    IF (NEW.id, NEW.source_id, NEW.snapshot_id, NEW.ordinal, NEW.page, NEW.slide, NEW.section, NEW.linea,
        NEW.locator, NEW.text, NEW.metadata, NEW.created_at)
       IS NOT DISTINCT FROM
       (OLD.id, OLD.source_id, OLD.snapshot_id, OLD.ordinal, OLD.page, OLD.slide, OLD.section, OLD.linea,
        OLD.locator, OLD.text, OLD.metadata, OLD.created_at) THEN
      RETURN NEW;
    END IF;
  END IF;

  fuente := OLD.source_id;
  IF EXISTS (
    SELECT 1
      FROM script_versions sv JOIN source_documents sd ON sd.id = sv.source_document_id
     WHERE sv.source_document_id = fuente
       AND (sd.status = 'procesado'
            OR EXISTS (SELECT 1 FROM content_analysis_runs r WHERE r.script_version_id = sv.id))
  ) THEN
    RAISE EXCEPTION 'Los fragmentos de la fuente de un guion registrado no se modifican ni se borran: la revisión se hizo sobre ese texto. Registre una versión nueva.';
  END IF;

  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER source_fragments_guion_inmutable
  BEFORE UPDATE OR DELETE ON source_fragments
  FOR EACH ROW EXECUTE FUNCTION source_fragments_guion_inmutable();

-- ─────────────────────── 3. last_version = MAX(version) ────────────────────────────

-- El contador lo avanza el trigger de `script_versions` (023), pero la 023 solo exigía «de uno en uno»: un
-- `UPDATE deliverables SET last_version = last_version + 1` dejaba un hueco y la lectura de «la última
-- versión» (`version = last_version`) dejaba de verla. Al CERRAR la transacción, el contador coincide con la
-- mayor versión real (o 0 sin versiones). Diferido: el alta de una versión avanza el contador y la inserta
-- en la misma transacción. Lee la fila VIGENTE (no NEW): una transacción puede avanzar el contador varias
-- veces y cada evento debe medirse contra el estado final.
CREATE OR REPLACE FUNCTION deliverables_last_version_coherente() RETURNS trigger AS $$
DECLARE
  contador integer;
  maxima   integer;
BEGIN
  IF inmutabilidad_bypass_activo() THEN RETURN NULL; END IF;
  SELECT last_version INTO contador FROM deliverables WHERE id = NEW.id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT COALESCE(max(version), 0) INTO maxima FROM script_versions WHERE deliverable_id = NEW.id;
  IF contador <> maxima THEN
    RAISE EXCEPTION 'deliverables.last_version (%) debe coincidir con la mayor versión registrada (%): solo avanza al registrar una versión.',
      contador, maxima;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER deliverables_last_version_coherente
  AFTER INSERT OR UPDATE OF last_version ON deliverables
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION deliverables_last_version_coherente();

-- ─────────────────────── 4. Aprobar exige revisión y Brief ─────────────────────────

-- La 023 dejaba la regla «aprobar exige una revisión CURRENT contra el Brief rector» solo en el caso de uso, y
-- la 024 validaba la revisión y el Brief únicamente si venían NO nulos: una versión podía pasar a `approved`
-- sin revisión (approved_analysis_id NULL) o con un Brief de otra campaña. Defensa en profundidad (no
-- sustituye al caso de uso, que además exige que la revisión sea CURRENT): al pasar a `approved`, la
-- revisión es de esta versión (la FK compuesta de la 024), terminó bien, es contra el Brief citado, y ese
-- Brief puede gobernar esta campaña (versión `es`, aprobada alguna vez, de la MISMA campaña y organización).
CREATE OR REPLACE FUNCTION script_versions_aprobacion_exigida() RETURNS trigger AS $$
DECLARE
  r content_analysis_runs%ROWTYPE;
BEGIN
  IF inmutabilidad_bypass_activo() THEN RETURN NEW; END IF;
  IF NEW.approved_analysis_id IS NULL OR NEW.approved_brief_version_id IS NULL THEN
    RAISE EXCEPTION 'Aprobar una versión de guion exige citar la revisión que la habilitó y el Brief aprobado contra el que se revisó.';
  END IF;
  IF NOT brief_gobernante_valido(NEW.approved_brief_version_id, NEW.campaign_id, NEW.organization_id) THEN
    RAISE EXCEPTION 'El Brief citado para aprobar no es un Brief aprobado de esta campaña.';
  END IF;
  SELECT * INTO r FROM content_analysis_runs WHERE id = NEW.approved_analysis_id;
  IF NOT FOUND
     OR r.script_version_id <> NEW.id
     OR r.status <> 'succeeded'
     OR r.governing_brief_version_id <> NEW.approved_brief_version_id THEN
    RAISE EXCEPTION 'La revisión citada para aprobar no es una revisión terminada de esta versión contra el Brief citado.';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER script_versions_aprobacion_exigida
  BEFORE UPDATE OF status ON script_versions
  FOR EACH ROW
  WHEN (NEW.status = 'approved' AND OLD.status IS DISTINCT FROM 'approved')
  EXECUTE FUNCTION script_versions_aprobacion_exigida();

-- ─────────────────────── 5. La historia no se vacía con TRUNCATE ───────────────────

-- TRUNCATE no pasa por los triggers de fila: con CASCADE y el permiso del propietario, la historia de
-- contenido se vaciaba sin dejar rastro. Un trigger de sentencia lo rechaza (también cuando llega por
-- CASCADE desde una tabla padre), salvo el bypass de limpieza de bases `_test`.
CREATE OR REPLACE FUNCTION contenido_sin_truncate() RETURNS trigger AS $$
BEGIN
  IF inmutabilidad_bypass_activo() THEN RETURN NULL; END IF;
  RAISE EXCEPTION '% es historia de contenido: no admite TRUNCATE.', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER deliverables_sin_truncate
  BEFORE TRUNCATE ON deliverables FOR EACH STATEMENT EXECUTE FUNCTION contenido_sin_truncate();
CREATE TRIGGER script_versions_sin_truncate
  BEFORE TRUNCATE ON script_versions FOR EACH STATEMENT EXECUTE FUNCTION contenido_sin_truncate();
CREATE TRIGGER script_review_comments_sin_truncate
  BEFORE TRUNCATE ON script_review_comments FOR EACH STATEMENT EXECUTE FUNCTION contenido_sin_truncate();
CREATE TRIGGER content_analysis_runs_sin_truncate
  BEFORE TRUNCATE ON content_analysis_runs FOR EACH STATEMENT EXECUTE FUNCTION contenido_sin_truncate();
CREATE TRIGGER content_findings_sin_truncate
  BEFORE TRUNCATE ON content_findings FOR EACH STATEMENT EXECUTE FUNCTION contenido_sin_truncate();
CREATE TRIGGER content_finding_brief_refs_sin_truncate
  BEFORE TRUNCATE ON content_finding_brief_refs FOR EACH STATEMENT EXECUTE FUNCTION contenido_sin_truncate();
CREATE TRIGGER content_finding_script_refs_sin_truncate
  BEFORE TRUNCATE ON content_finding_script_refs FOR EACH STATEMENT EXECUTE FUNCTION contenido_sin_truncate();
