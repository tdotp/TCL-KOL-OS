-- 010 · Cierra tres huecos residuales de la migración 009, encontrados en una
-- segunda auditoría independiente sobre el commit `a9eefe4`.
--
-- Como en la 009 y la 008, esta migración no toca ninguna migración ya
-- aplicada — redefine funciones existentes con `CREATE OR REPLACE FUNCTION`
-- y añade los disparadores nuevos que hacían falta.
--
-- ─────────────────────── Hallazgo 1 — el bypass no estaba restringido a pruebas
--
-- `inmutabilidad_bypass_activo()` (migración 009) solo comprobaba la bandera
-- de sesión `tclkolos.permitir_borrado_historico`. Que hoy solo
-- `packages/db/src/test-utils.ts` la active es una convención de la
-- aplicación, no una restricción de la base de datos: cualquier conexión con
-- permiso para ejecutar SQL —desarrollo, staging o, en el peor caso,
-- producción— podía hacer `SET LOCAL tclkolos.permitir_borrado_historico =
-- 'on'` y desactivar los triggers de inmutabilidad para esa transacción.
--
-- Ahora la función exige, además de la bandera, que la base actual sea
-- inequívocamente una base de pruebas: su nombre debe terminar exactamente
-- en `_test` — la misma convención que ya exige INC-001A en
-- `packages/db/vitest.setup.ts` para `TEST_DATABASE_URL`. En cualquier base
-- cuyo nombre no termine en `_test` (desarrollo normal, staging, producción,
-- o cualquier otro nombre), la función devuelve `false` sin importar el
-- valor de la bandera de sesión — no hay forma de activar el bypass ahí, ni
-- siquiera manualmente.
CREATE OR REPLACE FUNCTION inmutabilidad_bypass_activo() RETURNS boolean AS $$
  SELECT COALESCE(current_setting('tclkolos.permitir_borrado_historico', true), '') = 'on'
     AND right(current_database(), 5) = '_test';
$$ LANGUAGE sql STABLE;

-- ─────────────────────── Hallazgo 2 — `brief_versions` admitía DELETE directo
--
-- La protección de `brief_versions` (migración 004, ampliada en la 009) solo
-- estaba conectada a `BEFORE UPDATE`. Nada impedía un
-- `DELETE FROM brief_versions WHERE id = ...` directo sobre una fila
-- `approved`, `superseded` o `cancelled` — que además arrastraría en cascada
-- todo su contenido histórico (`brief_fields`, `evidence`, etc.).
--
-- La misma pregunta aplica al borrar una campaña o un brief completos: la
-- cascada de Postgres (`brief_versions.brief_id ... ON DELETE CASCADE`)
-- dispara el trigger `BEFORE DELETE` de cada fila de `brief_versions` que va
-- a borrar, exactamente igual que un `DELETE` directo sobre esa fila — así
-- que un solo disparador aquí basta para cubrir los dos casos.
CREATE OR REPLACE FUNCTION version_terminal_no_admite_delete() RETURNS trigger AS $$
BEGIN
  IF inmutabilidad_bypass_activo() THEN RETURN OLD; END IF;

  IF OLD.status IN ('approved', 'superseded', 'cancelled') THEN
    RAISE EXCEPTION
      'La versión % está % — no admite DELETE directo (ADR-003 / Sprint 5 correctivo, hallazgo 2).',
      OLD.version, OLD.status;
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER brief_versions_terminal_sin_delete
  BEFORE DELETE ON brief_versions
  FOR EACH ROW EXECUTE FUNCTION version_terminal_no_admite_delete();

-- ─────────────────────── Hallazgo 3 — la fila histórica no estaba congelada del todo
--
-- `version_aprobada_inmutable()` (migración 004, ampliada en la 009) solo
-- comparaba `version`, `brief_id`, `language`, `parent_version_id` y
-- `approved_at`. Columnas como `organization_id`, `created_by`,
-- `translation_of_id` o `created_at` podían modificarse por `UPDATE` directo
-- sin que ningún disparador se diera cuenta.
--
-- Nueva regla, por estado:
--   * `superseded` / `cancelled`: cualquier `UPDATE` se rechaza, sin
--     excepción — incluso uno que no cambie ningún valor. Estos dos estados
--     son terminales y su fila ya no admite ninguna escritura.
--   * `approved`, sin cambio de estado: se rechaza cualquier `UPDATE`; una
--     versión aprobada tampoco se reescribe a sí misma.
--   * `approved → superseded` o `approved → cancelled` (la única transición
--     que un estado terminal admite, y la que usa `crearVersionHija`): se
--     permite, pero únicamente si `status` es la única columna que cambia.
--     Toda la demás identidad de la fila —id, brief, organización, versión,
--     idioma, relación padre, relación de traducción, creador, fechas—
--     debe permanecer exactamente igual.
CREATE OR REPLACE FUNCTION version_aprobada_inmutable() RETURNS trigger AS $$
BEGIN
  IF OLD.status IN ('superseded', 'cancelled') THEN
    RAISE EXCEPTION
      'La versión % está % — es un estado terminal, no admite ningún UPDATE (Sprint 5 correctivo, hallazgo 3).',
      OLD.version, OLD.status;
  ELSIF OLD.status = 'approved' THEN
    IF NEW.status = OLD.status THEN
      -- Una versión aprobada no se reescribe a sí misma, ni siquiera con un
      -- `UPDATE` que en los hechos no cambia ningún valor: mientras se
      -- mantenga `approved`, la única escritura legítima es la transición
      -- de estado que maneja el `ELSIF` de abajo.
      RAISE EXCEPTION
        'La versión % está aprobada — ningún valor puede cambiar sin transicionar de estado (ADR-003 / Sprint 5 correctivo, hallazgo 3).',
        OLD.version;
    ELSIF NEW.status IN ('superseded', 'cancelled') THEN
      IF (NEW.id, NEW.brief_id, NEW.organization_id, NEW.version, NEW.language,
          NEW.parent_version_id, NEW.translation_of_id, NEW.created_by, NEW.created_at,
          NEW.approved_at)
         IS DISTINCT FROM
         (OLD.id, OLD.brief_id, OLD.organization_id, OLD.version, OLD.language,
          OLD.parent_version_id, OLD.translation_of_id, OLD.created_by, OLD.created_at,
          OLD.approved_at) THEN
        RAISE EXCEPTION
          'La transición approved → % solo puede cambiar status; ningún otro valor puede cambiar (Sprint 5 correctivo, hallazgo 3).',
          NEW.status;
      END IF;
    ELSE
      RAISE EXCEPTION
        'La versión % está aprobada y no puede volver a % (ADR-003). Cree una versión nueva.',
        OLD.version, NEW.status;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- El trigger BEFORE UPDATE ya existe (migración 004) y ya apunta a esta
-- función — `CREATE OR REPLACE FUNCTION` es suficiente, no hace falta
-- recrearlo.
