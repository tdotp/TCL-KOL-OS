-- 001 · Núcleo del dominio: organizaciones, usuarios, productos, campañas y auditoría.
--
-- Implementa `docs/architecture/D0-08-modelo-datos.md` (entidades 2.1 a 2.4 bis y 2.12)
-- y la regla de separación de la sección 3.4 del documento maestro.
--
-- Las reglas de integridad se imponen AQUÍ además de en `packages/domain`: una
-- migración o un script pueden saltarse la capa de aplicación, no la base.

-- ─────────────────────────── Tipos ────────────────────────────────────────────

CREATE TYPE organization_type AS ENUM ('agencia', 'cliente');
CREATE TYPE entity_status AS ENUM ('activa', 'inactiva');
CREATE TYPE user_role AS ENUM ('admin', 'director', 'consultor', 'analista', 'legal', 'cliente');
CREATE TYPE user_status AS ENUM ('activo', 'inactivo');
CREATE TYPE campaign_status AS ENUM ('activa', 'archivada', 'cancelada');
CREATE TYPE confidentiality_level AS ENUM ('publica', 'interna', 'confidencial', 'sensible');
CREATE TYPE visibility_level AS ENUM ('interna', 'tcl', 'compartida');
-- DEC-016: papel del producto dentro de una campaña concreta.
CREATE TYPE campaign_product_role AS ENUM ('flagship', 'secundario', 'entrada', 'unico');

-- ─────────────────────────── Organizaciones y usuarios ────────────────────────

CREATE TABLE organizations (
  id          uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  name        text NOT NULL,
  type        organization_type NOT NULL,
  status      entity_status NOT NULL DEFAULT 'activa',
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id               uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  email            citext,
  name             text NOT NULL,
  organization_id  uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  role             user_role NOT NULL,
  status           user_status NOT NULL DEFAULT 'activo',
  created_at       timestamptz NOT NULL DEFAULT now()
);

-- El correo es único en todo el sistema: un mismo buzón no pertenece a dos
-- organizaciones, porque eso rompería el aislamiento desde el login.
CREATE UNIQUE INDEX users_email_key ON users (email);
CREATE INDEX users_org_idx ON users (organization_id);

-- ─────────────────────────── Productos ────────────────────────────────────────

CREATE TABLE products (
  id          uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  brand       text NOT NULL DEFAULT 'TCL',
  category    text NOT NULL,
  model       text NOT NULL,
  market      text,
  metadata    jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX products_brand_model_key ON products (brand, model);

-- ─────────────────────────── Campañas ─────────────────────────────────────────

CREATE TABLE campaigns (
  id                     uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id        uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  name                   text NOT NULL,
  market                 text NOT NULL DEFAULT 'CO',
  category               text,
  owner_id               uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  start_date             date,
  end_date               date,
  status                 campaign_status NOT NULL DEFAULT 'activa',
  confidentiality_level  confidentiality_level NOT NULL DEFAULT 'interna',
  visibility             visibility_level NOT NULL DEFAULT 'interna',
  created_by             uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT campaigns_dates_ordered CHECK (end_date IS NULL OR start_date IS NULL OR end_date >= start_date)
);

CREATE INDEX campaigns_org_idx ON campaigns (organization_id);
CREATE INDEX campaigns_status_idx ON campaigns (organization_id, status);

-- ─────────────────────────── Campaña ↔ producto (DEC-016) ─────────────────────

-- Una campaña admite varios productos. El rol, la prioridad y el reparto de
-- presupuesto pertenecen a la RELACIÓN, no al producto: el mismo P80 Ultra puede
-- ser flagship en su lanzamiento y secundario en una campaña de temporada.
CREATE TABLE campaign_products (
  id                        uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  campaign_id               uuid NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  product_id                uuid NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  rol                       campaign_product_role NOT NULL DEFAULT 'unico',
  prioridad                 integer NOT NULL DEFAULT 1,
  participacion_presupuesto numeric(4,3),
  created_at                timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT campaign_products_unique UNIQUE (campaign_id, product_id),
  CONSTRAINT campaign_products_prioridad_positiva CHECK (prioridad >= 1),
  CONSTRAINT campaign_products_participacion_rango
    CHECK (participacion_presupuesto IS NULL
           OR (participacion_presupuesto >= 0 AND participacion_presupuesto <= 1))
);

CREATE INDEX campaign_products_campaign_idx ON campaign_products (campaign_id);

-- ─────────────────────────── Auditoría ────────────────────────────────────────

-- §10.3, regla 4: cada mutación sensible genera un AuditEvent.
-- La tabla es de solo inserción: sin UPDATE ni DELETE (ver trigger más abajo).
CREATE TABLE audit_events (
  id               uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id  uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  actor_id         uuid REFERENCES users(id) ON DELETE SET NULL,
  action           text NOT NULL,
  entity_type      text NOT NULL,
  entity_id        uuid,
  metadata         jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX audit_events_org_idx ON audit_events (organization_id, created_at DESC);
CREATE INDEX audit_events_entity_idx ON audit_events (entity_type, entity_id);

-- Un registro de auditoría que se puede editar no es auditoría.
CREATE OR REPLACE FUNCTION audit_events_solo_insercion() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_events es de solo inserción: no admite % (regla §10.3)', TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_events_no_update
  BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION audit_events_solo_insercion();

-- ─────────────────────────── updated_at automático ────────────────────────────

CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER campaigns_set_updated_at
  BEFORE UPDATE ON campaigns
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
