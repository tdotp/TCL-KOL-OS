-- 009 · Cierra el hueco de inmutabilidad tras `superseded`/`cancelled`.
--
-- Defecto real de cierre, encontrado en auditoría independiente del ZIP de
-- Sprint 5: `campos_de_version_aprobada_inmutables()` (migración 004) y
-- `comentarios_de_version_aprobada_inmutables()` (migración 007) solo
-- bloqueaban cuando la versión dueña estaba `approved`. Al crear una versión
-- hija (`crearVersionHija`, Fase E), la versión padre pasa a `superseded` —
-- y en ese momento la protección SQL desaparecía por completo: nada en la
-- base impedía un `UPDATE`/`DELETE`/`INSERT` directo sobre el contenido de
-- una versión ya reemplazada. `evidence`, `local_questions` y
-- `brief_field_revisions` nunca tuvieron ninguna protección, ni siquiera
-- para `approved`.
--
-- Esta migración no toca ninguna migración ya aplicada — redefine funciones
-- existentes con `CREATE OR REPLACE FUNCTION` (mismo patrón que la 008) y
-- añade disparadores nuevos donde hacía falta.
--
-- ─────────────────────────── Sobre la limpieza de datos de prueba ─────────────
--
-- Un primer diseño asumía que un `DELETE FROM campaigns` (usado en el
-- `afterAll` de toda la suite, incluso sobre campañas con versiones
-- `approved`/`superseded`) seguiría funcionando solo porque la cascada
-- borraría primero `brief_versions` y luego, con la fila padre ya
-- inexistente, el `SELECT status FROM brief_versions` de cada disparador
-- devolvería `NULL` sin bloquear nada. **Es falso en general**: verificado
-- contra Postgres real, `local_questions` tiene FK directa a `campaigns`
-- (además de a `brief_version_id`), así que su cascada puede dispararse
-- mientras `brief_versions` todavía existe — y entonces SÍ bloqueaba la
-- limpieza legítima de una campaña de prueba.
--
-- La solución no es debilitar la protección — es darle a la limpieza
-- administrativa/de pruebas una salida explícita y acotada a la transacción:
-- `SET LOCAL tclkolos.permitir_borrado_historico = 'on'` antes del `DELETE`.
-- `SET LOCAL` se revierte solo al terminar la transacción — nunca puede
-- quedar "encendido" por accidente para otra conexión ni otra consulta.
-- Ninguna función de `packages/db` usada por la aplicación real la
-- establece; solo `packages/db/src/test-utils.ts`
-- (`eliminarCampanaDePrueba`), usada exclusivamente por `afterAll` en
-- pruebas. Verificado con pruebas SQL directas en los dos sentidos —
-- bloquea lo directo sin la bandera, permite la limpieza con ella — en
-- `packages/db/src/immutability.test.ts`.

CREATE OR REPLACE FUNCTION inmutabilidad_bypass_activo() RETURNS boolean AS $$
  SELECT COALESCE(current_setting('tclkolos.permitir_borrado_historico', true), '') = 'on';
$$ LANGUAGE sql STABLE;

-- ─────────────────────────── brief_versions: estados terminales ───────────────

CREATE OR REPLACE FUNCTION version_aprobada_inmutable() RETURNS trigger AS $$
BEGIN
  IF OLD.status = 'approved' THEN
    IF NEW.status NOT IN ('approved', 'superseded', 'cancelled') THEN
      RAISE EXCEPTION
        'La versión % está aprobada y no puede volver a % (ADR-003). Cree una versión nueva.',
        OLD.version, NEW.status;
    END IF;
    IF NEW.version <> OLD.version OR NEW.brief_id <> OLD.brief_id
       OR NEW.language <> OLD.language THEN
      RAISE EXCEPTION 'No se puede alterar la identidad de una versión aprobada (ADR-003).';
    END IF;
  ELSIF OLD.status IN ('superseded', 'cancelled') THEN
    -- Sprint 5 correctivo: un estado terminal no vuelve a ningún otro
    -- estado por SQL directo.
    IF NEW.status <> OLD.status THEN
      RAISE EXCEPTION
        'La versión % está % — es un estado terminal, no admite ningún cambio de estado.',
        OLD.version, OLD.status;
    END IF;
    IF NEW.version <> OLD.version OR NEW.brief_id <> OLD.brief_id
       OR NEW.language <> OLD.language
       OR NEW.parent_version_id IS DISTINCT FROM OLD.parent_version_id
       OR NEW.approved_at IS DISTINCT FROM OLD.approved_at THEN
      RAISE EXCEPTION 'No se puede alterar la identidad de una versión % (Sprint 5 correctivo).', OLD.status;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- El trigger ya existe (migración 004) y ya apunta a esta función — no hace
-- falta recrearlo, `CREATE OR REPLACE FUNCTION` es suficiente. Nunca
-- necesita la bandera de bypass: nada en la limpieza de pruebas hace
-- `UPDATE` sobre `brief_versions`, solo `DELETE` en cascada.

-- ─────────────────────────── brief_fields: approved + superseded + cancelled ──

CREATE OR REPLACE FUNCTION campos_de_version_aprobada_inmutables() RETURNS trigger AS $$
DECLARE
  estado brief_status;
  version_id uuid;
BEGIN
  IF inmutabilidad_bypass_activo() THEN RETURN COALESCE(NEW, OLD); END IF;

  version_id := COALESCE(NEW.brief_version_id, OLD.brief_version_id);
  SELECT status INTO estado FROM brief_versions WHERE id = version_id;

  IF estado IN ('approved', 'superseded', 'cancelled') THEN
    RAISE EXCEPTION
      'Los campos de una versión % no admiten % (ADR-003 / Sprint 5 correctivo). Cree una versión nueva.',
      estado, TG_OP;
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

-- La migración 004 solo protegía UPDATE/DELETE. INSERT directo (crear una
-- fila nueva a mano sobre una versión ya cerrada) nunca estuvo cubierto.
CREATE TRIGGER brief_fields_inmutabilidad_insert
  BEFORE INSERT ON brief_fields
  FOR EACH ROW EXECUTE FUNCTION campos_de_version_aprobada_inmutables();

-- ─────────────────────────── evidence: nunca tuvo protección propia ───────────

CREATE OR REPLACE FUNCTION evidencia_de_version_aprobada_inmutable() RETURNS trigger AS $$
DECLARE
  estado brief_status;
  campo_id uuid;
BEGIN
  IF inmutabilidad_bypass_activo() THEN RETURN COALESCE(NEW, OLD); END IF;

  campo_id := COALESCE(NEW.brief_field_id, OLD.brief_field_id);
  SELECT bv.status INTO estado
    FROM brief_fields bf JOIN brief_versions bv ON bv.id = bf.brief_version_id
   WHERE bf.id = campo_id;

  IF estado IN ('approved', 'superseded', 'cancelled') THEN
    RAISE EXCEPTION
      'La evidencia de un campo de una versión % no admite % (Sprint 5 correctivo). Cree una versión nueva.',
      estado, TG_OP;
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER evidence_inmutabilidad
  BEFORE INSERT OR UPDATE OR DELETE ON evidence
  FOR EACH ROW EXECUTE FUNCTION evidencia_de_version_aprobada_inmutable();

-- ─────────────────────────── local_questions: nunca tuvo protección propia ────

CREATE OR REPLACE FUNCTION preguntas_de_version_aprobada_inmutables() RETURNS trigger AS $$
DECLARE
  estado brief_status;
  version_id uuid;
BEGIN
  IF inmutabilidad_bypass_activo() THEN RETURN COALESCE(NEW, OLD); END IF;

  version_id := COALESCE(NEW.brief_version_id, OLD.brief_version_id);
  -- `brief_version_id` es nullable (una pregunta puede nacer antes de que
  -- exista versión) — sin versión, no hay nada que proteger todavía.
  IF version_id IS NULL THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  SELECT status INTO estado FROM brief_versions WHERE id = version_id;

  IF estado IN ('approved', 'superseded', 'cancelled') THEN
    RAISE EXCEPTION
      'Las preguntas locales de una versión % no admiten % (Sprint 5 correctivo). Cree una versión nueva.',
      estado, TG_OP;
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER local_questions_inmutabilidad
  BEFORE INSERT OR UPDATE OR DELETE ON local_questions
  FOR EACH ROW EXECUTE FUNCTION preguntas_de_version_aprobada_inmutables();

-- ─────────────────────────── brief_field_revisions: historial reforzado ───────

-- La migración 005 ya bloquea todo UPDATE, sin condición (es historial, no
-- se reescribe nunca, apruebe lo que apruebe — y esa parte no necesita la
-- bandera de bypass, la limpieza de pruebas nunca actualiza historial). Lo
-- que le faltaba: permitir borrar o insertar filas de historial una vez la
-- versión está cerrada — defensa en profundidad, aunque la aplicación nunca
-- llegue a intentarlo (la protección de `brief_fields` ya lo impide antes).
CREATE OR REPLACE FUNCTION revisiones_de_version_aprobada_inmutables() RETURNS trigger AS $$
DECLARE
  estado brief_status;
  version_id uuid;
BEGIN
  IF inmutabilidad_bypass_activo() THEN RETURN COALESCE(NEW, OLD); END IF;

  version_id := COALESCE(NEW.brief_version_id, OLD.brief_version_id);
  SELECT status INTO estado FROM brief_versions WHERE id = version_id;

  IF estado IN ('approved', 'superseded', 'cancelled') THEN
    RAISE EXCEPTION
      'El historial de revisiones de una versión % no admite % (Sprint 5 correctivo).',
      estado, TG_OP;
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER brief_field_revisions_inmutabilidad_extra
  BEFORE INSERT OR DELETE ON brief_field_revisions
  FOR EACH ROW EXECUTE FUNCTION revisiones_de_version_aprobada_inmutables();

-- ─────────────────────────── field_comments: approved + superseded + cancelled

-- La migración 007 ya cablea dos triggers (INSERT y UPDATE/DELETE) a esta
-- función — solo hace falta ampliar qué estados protege y añadir la
-- bandera de bypass.
CREATE OR REPLACE FUNCTION comentarios_de_version_aprobada_inmutables() RETURNS trigger AS $$
DECLARE
  estado brief_status;
  version_id uuid;
BEGIN
  IF inmutabilidad_bypass_activo() THEN RETURN COALESCE(NEW, OLD); END IF;

  version_id := COALESCE(NEW.brief_version_id, OLD.brief_version_id);
  SELECT status INTO estado FROM brief_versions WHERE id = version_id;

  IF estado IN ('approved', 'superseded', 'cancelled') THEN
    RAISE EXCEPTION
      'Los comentarios de una versión % no admiten % (ADR-003 / Sprint 5 correctivo).', estado, TG_OP;
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;
