-- 007 · Comentarios internos por campo (E7-6, Sprint 5 Fase B).
--
-- Diferida desde el cierre de Sprint 4 (D0-17 §2.4, "FAIL — diferida por
-- diseño"). Los permisos `comment:internal`/`comment:client_visible` ya
-- existían en `packages/domain/src/permissions.ts` desde antes, sin tabla —
-- esta migración es esa tabla.
--
-- `field_key` (no un FK a `brief_fields.id`) para que la conversación
-- sobreviva aunque el campo cambie de fila — p. ej. al declarar una
-- excepción por producto (E7-8) o al crear una versión hija (Fase E): el
-- comentario sigue anclado a `(brief_version_id, field_key)`, no a una fila
-- de `brief_fields` que puede dejar de existir.
--
-- El rol `cliente` nunca tiene `comment:internal` ni `comment:client_visible`
-- asignado en `packages/domain/src/permissions.ts` (decisión del product
-- owner, Sprint 5): ninguna consulta de `apps/web` construida para el
-- cliente puede tocar esta tabla sin violar esa capacidad primero.

CREATE TABLE field_comments (
  id                    uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id       uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  brief_version_id      uuid NOT NULL REFERENCES brief_versions(id) ON DELETE CASCADE,
  field_key             text NOT NULL,
  campaign_product_id   uuid REFERENCES campaign_products(id) ON DELETE CASCADE,
  -- Una respuesta en el mismo hilo. NULL = comentario raíz.
  parent_comment_id     uuid REFERENCES field_comments(id) ON DELETE CASCADE,
  author_id             uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  content                text NOT NULL,
  status                text NOT NULL DEFAULT 'abierto',
  resolved_by           uuid REFERENCES users(id) ON DELETE SET NULL,
  resolved_at           timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT field_comments_contenido_no_vacio CHECK (btrim(content) <> ''),
  CONSTRAINT field_comments_estado_valido CHECK (status IN ('abierto', 'resuelto')),
  CONSTRAINT field_comments_resuelto_con_autor
    CHECK (status = 'abierto' OR (resolved_by IS NOT NULL AND resolved_at IS NOT NULL))
);

CREATE INDEX field_comments_version_campo_idx ON field_comments (brief_version_id, field_key);
CREATE INDEX field_comments_hilo_idx ON field_comments (parent_comment_id);
CREATE INDEX field_comments_org_idx ON field_comments (organization_id);

COMMENT ON TABLE field_comments IS
  'Conversaciones internas por campo (E7-6). Nunca visibles para el rol '
  'cliente — ver comment:internal en packages/domain/src/permissions.ts.';

-- Como brief_fields (ADR-003): una vez aprobada la versión, la conversación
-- se conserva para consulta pero no admite contenido nuevo ni alterado.
CREATE OR REPLACE FUNCTION comentarios_de_version_aprobada_inmutables() RETURNS trigger AS $$
DECLARE
  estado brief_status;
  version_id uuid;
BEGIN
  version_id := COALESCE(NEW.brief_version_id, OLD.brief_version_id);
  SELECT status INTO estado FROM brief_versions WHERE id = version_id;

  IF estado = 'approved' THEN
    RAISE EXCEPTION
      'Los comentarios de una versión aprobada no admiten % (ADR-003).', TG_OP;
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER field_comments_inmutabilidad
  BEFORE UPDATE OR DELETE ON field_comments
  FOR EACH ROW EXECUTE FUNCTION comentarios_de_version_aprobada_inmutables();

CREATE TRIGGER field_comments_inmutabilidad_insert
  BEFORE INSERT ON field_comments
  FOR EACH ROW EXECUTE FUNCTION comentarios_de_version_aprobada_inmutables();
