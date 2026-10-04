-- 015 · Influencer + cuentas por plataforma (V2 · Fase 3, parte 1: identidad).
--
--   influencers            identidad estable de la persona/creador
--   influencer_accounts    sus cuentas por plataforma (identidad fuerte)
--
-- La participación en una campaña y el producto asignado están en la 016.
--
-- Forward-only y aditiva: no toca filas ni columnas existentes.
--
-- Principios impuestos AQUÍ (no solo en la aplicación):
--   · Aislamiento: la cuenta lleva `organization_id` y una clave foránea
--     compuesta con su influencer; no se cruzan organizaciones.
--   · Una misma cuenta social no se registra dos veces por organización.
--   · Nada de cascadas destructivas: FK RESTRICT y sin DELETE de entidades
--     (salvo el bypass de bases `_test`, migración 010).

-- ─────────────────────────── Tipos ────────────────────────────────────────────

CREATE TYPE social_platform AS ENUM ('instagram', 'tiktok', 'youtube', 'x', 'facebook', 'twitch');

-- ─────────────────────────── Influencer ───────────────────────────────────────

-- Pertenece a la organización (agencia) que lo gestiona. NO es único por
-- nombre: dos personas pueden llamarse igual; la identidad fuerte está en las
-- cuentas.
CREATE TABLE influencers (
  id               uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id  uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  display_name     text NOT NULL,
  created_by       uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT influencers_id_organization_key UNIQUE (id, organization_id),
  CONSTRAINT influencers_nombre_valido
    CHECK (display_name = btrim(display_name) AND display_name <> '' AND char_length(display_name) <= 200)
);

CREATE INDEX influencers_org_nombre_idx ON influencers (organization_id, display_name);

-- ─────────────────────────── Cuentas por plataforma ───────────────────────────

-- Un influencer puede tener varias cuentas (Instagram, TikTok, YouTube…).
-- `normalized_handle` es la clave de identidad (la calcula `normalizeHandle`
-- en `packages/domain`; la base solo vigila que llegue normalizada).
CREATE TABLE influencer_accounts (
  id                 uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  influencer_id      uuid NOT NULL,
  organization_id    uuid NOT NULL,
  platform           social_platform NOT NULL,
  handle             text NOT NULL,
  normalized_handle  text NOT NULL,
  profile_url        text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),

  -- La cuenta es de la misma organización que su influencer.
  CONSTRAINT influencer_accounts_influencer_fkey
    FOREIGN KEY (influencer_id, organization_id)
    REFERENCES influencers (id, organization_id) ON DELETE RESTRICT,
  -- Misma cuenta social, una sola vez por organización.
  CONSTRAINT influencer_accounts_identity_key UNIQUE (organization_id, platform, normalized_handle),
  CONSTRAINT influencer_accounts_handle_valido
    CHECK (handle <> '' AND char_length(handle) <= 100 AND handle !~ '[@/[:space:]]'),
  -- Las plataformas admitidas hoy no distinguen mayúsculas: el handle de
  -- identidad llega en minúsculas y sin `@`. (Si una plataforma futura sí las
  -- distingue, su migración ajusta esta restricción.)
  CONSTRAINT influencer_accounts_normalizado_valido
    CHECK (normalized_handle <> ''
           AND normalized_handle !~ '[@/[:space:]]'
           AND normalized_handle = lower(normalized_handle)),
  CONSTRAINT influencer_accounts_url_valida
    CHECK (profile_url IS NULL OR (profile_url ~* '^https?://' AND char_length(profile_url) <= 500))
);

CREATE INDEX influencer_accounts_influencer_idx ON influencer_accounts (influencer_id);

-- ─────────────────────────── updated_at ───────────────────────────────────────

CREATE TRIGGER influencers_set_updated_at
  BEFORE UPDATE ON influencers FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER influencer_accounts_set_updated_at
  BEFORE UPDATE ON influencer_accounts FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ─────────────────────────── Identidad inmutable ──────────────────────────────

-- A quién pertenece una fila no cambia: una cuenta no «se muda» a otro
-- influencer (unir identidades es una decisión explícita de fases posteriores).
CREATE OR REPLACE FUNCTION influencers_identidad_inmutable() RETURNS trigger AS $$
BEGIN
  IF NEW.organization_id IS DISTINCT FROM OLD.organization_id
     OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'influencers: organización, creador y fecha de creación no se modifican.';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER influencers_identidad
  BEFORE UPDATE ON influencers FOR EACH ROW EXECUTE FUNCTION influencers_identidad_inmutable();

CREATE OR REPLACE FUNCTION influencer_accounts_identidad_inmutable() RETURNS trigger AS $$
BEGIN
  IF NEW.influencer_id IS DISTINCT FROM OLD.influencer_id
     OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
     OR NEW.platform IS DISTINCT FROM OLD.platform
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'influencer_accounts: influencer, organización y plataforma no se modifican.';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER influencer_accounts_identidad
  BEFORE UPDATE ON influencer_accounts FOR EACH ROW EXECUTE FUNCTION influencer_accounts_identidad_inmutable();

-- ─────────────────────────── Sin DELETE de entidades ──────────────────────────

-- Un influencer y sus cuentas son historia: no se borran. La única salida es el
-- bypass restringido a bases `_test` (migración 010), usado por la limpieza de
-- pruebas. La función es genérica: la 016 la reutiliza para la participación.
CREATE OR REPLACE FUNCTION entidad_influencer_sin_delete() RETURNS trigger AS $$
BEGIN
  IF inmutabilidad_bypass_activo() THEN RETURN OLD; END IF;
  RAISE EXCEPTION '% no admite DELETE: se conserva la historia.', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER influencers_sin_delete
  BEFORE DELETE ON influencers FOR EACH ROW EXECUTE FUNCTION entidad_influencer_sin_delete();
CREATE TRIGGER influencer_accounts_sin_delete
  BEFORE DELETE ON influencer_accounts FOR EACH ROW EXECUTE FUNCTION entidad_influencer_sin_delete();
