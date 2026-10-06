-- 023 · Contenido (V2 · Fase 7): entregables, versiones de guion y comentarios de revisión.
--
-- Forward-only y aditiva: añade una función de rol, cuatro funciones/triggers y
-- tres tablas nuevas, y un trigger de guarda sobre `source_documents`. No cambia
-- ninguna fila, columna ni restricción existente, y los triggers solo se evalúan
-- sobre filas NUEVAS o sobre cambios de las fuentes que ya respaldan un guion:
-- ningún dato preexistente puede fallar.
--
--   campaign_influencers ─< deliverables ─< script_versions ─< script_review_comments
--                                              │  └─► source_documents (el guion ES el archivo)
--                                              └─► proposed_actions (aprobación vía HITL)
--
-- Principios impuestos AQUÍ (no solo en la aplicación):
--   · Aislamiento: toda fila lleva organization_id y campaign_id y los amarra con
--     claves compuestas (participación, producto, fuente, autor, aprobador, acción).
--   · Un guion recibido es un hecho: su identidad, su fuente y su hash no cambian;
--     solo cambia su estado de revisión por transiciones válidas.
--   · Una sola versión aprobada vigente por entregable (índice único parcial); al
--     aprobar una más nueva, la anterior pasa a `superseded` conservando sus marcas
--     de aprobación. No se aprueba hacia atrás.
--   · La numeración de versiones la asigna la base (contador en el entregable,
--     serializado con FOR UPDATE): sin huecos ni duplicados.
--   · Roles: la lista cerrada de `contenido_exigir_rol` espeja `roleCan` del
--     dominio (script:manage / script:approve); una prueba de paridad vigila que
--     no diverjan.
--   · Un guion no aprobado no se expone a TCL: el trigger de `source_documents`
--     prohíbe la visibilidad tcl/compartida de su fuente, y el original de una
--     fuente enlazada a un guion no cambia.
--   · Sin fee, pago, envío, KPI, acuerdo ni publicación: eso es de fases posteriores.
--
-- Fuera de esta migración (024): análisis, hallazgos y su FK
-- `script_versions.approved_analysis_id → content_analysis_runs(id)`. Aquí
-- `approved_analysis_id` es un uuid sin FK todavía.
--
-- La revisión CURRENT para aprobar NO se exige en la base (depende de tablas de la
-- 024): vive en el caso de uso de aprobación. La base sí exige: estado in_review,
-- aprobador con rol, hash de la fuente intacto, entregable/participación/campaña
-- activos, monotonía y, si viene de una acción propuesta, que sea la correcta.

-- ─────────────────────────── 1. Roles de contenido ─────────────────────────────

-- manage  = admin, director, consultor  (espeja `script:manage` / `deliverable:manage`)
-- approve = admin, director             (espeja `script:approve`, DEC-042)
-- Persona de una organización de agencia y activa. La lista es cerrada: un rol
-- nuevo no obtiene acceso por omisión.
CREATE OR REPLACE FUNCTION contenido_exigir_rol(p_usuario uuid, p_capacidad text) RETURNS void AS $$
DECLARE
  rol         text;
  tipo        text;
  estado      text;
  permitidos  text[];
BEGIN
  permitidos := CASE p_capacidad
    WHEN 'manage'  THEN ARRAY['admin', 'director', 'consultor']
    WHEN 'approve' THEN ARRAY['admin', 'director']
    ELSE ARRAY[]::text[]
  END;
  SELECT u.role::text, o.type::text, u.status::text INTO rol, tipo, estado
    FROM users u JOIN organizations o ON o.id = u.organization_id
   WHERE u.id = p_usuario;
  IF NOT FOUND
     OR tipo   IS DISTINCT FROM 'agencia'
     OR estado IS DISTINCT FROM 'activo'
     OR NOT (rol = ANY (permitidos)) THEN
    RAISE EXCEPTION 'Este usuario no puede ejecutar «%» sobre contenido de guiones (personal activo de la agencia con el rol adecuado).', p_capacidad;
  END IF;
END;
$$ LANGUAGE plpgsql STABLE;

-- ─────────────────────────── 2. Entregables ────────────────────────────────────

-- Pieza de contenido de UNA participación (CampaignInfluencer, no Influencer:
-- DEC-044). `platform` es informativa (puede faltar) y NO forma parte de la clave:
-- la clave estable es la etiqueta normalizada dentro de la participación.
CREATE TABLE deliverables (
  id                      uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id         uuid NOT NULL,
  campaign_id             uuid NOT NULL,
  campaign_influencer_id  uuid NOT NULL,
  platform                social_platform,
  label                   text NOT NULL,
  -- Clave humana normalizada (NFKC, recortada, espacios colapsados, minúsculas):
  -- la calcula `normalizarEtiquetaDeEntregable` en el dominio; la base solo vigila
  -- que llegue normalizada.
  label_key               text NOT NULL,
  campaign_product_id     uuid,
  status                  text NOT NULL DEFAULT 'active',
  archived_at             timestamptz,
  -- Contador de versiones (patrón `chat_conversations.last_seq`): lo avanza el
  -- trigger de `script_versions`; invariante `last_version = MAX(version)`.
  last_version            integer NOT NULL DEFAULT 0,
  created_by              uuid NOT NULL,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT deliverables_campaign_fkey
    FOREIGN KEY (campaign_id, organization_id)
    REFERENCES campaigns (id, organization_id) ON DELETE RESTRICT,
  -- La participación es de ESTA campaña (y, por transitividad, de esta organización).
  CONSTRAINT deliverables_participacion_fkey
    FOREIGN KEY (campaign_influencer_id, campaign_id)
    REFERENCES campaign_influencers (id, campaign_id) ON DELETE RESTRICT,
  -- El producto es de ESTA campaña. Sin FK a la asignación (desasociar hace DELETE).
  CONSTRAINT deliverables_producto_fkey
    FOREIGN KEY (campaign_product_id, campaign_id)
    REFERENCES campaign_products (id, campaign_id) ON DELETE RESTRICT,
  CONSTRAINT deliverables_autor_fkey
    FOREIGN KEY (created_by, organization_id)
    REFERENCES users (id, organization_id) ON DELETE RESTRICT,
  CONSTRAINT deliverables_id_scope_key UNIQUE (id, organization_id, campaign_id),
  CONSTRAINT deliverables_estado_valido CHECK (status IN ('active', 'archived')),
  CONSTRAINT deliverables_archivo_coherente CHECK ((status = 'archived') = (archived_at IS NOT NULL)),
  CONSTRAINT deliverables_label_valida
    CHECK (label = btrim(label) AND label <> '' AND char_length(label) <= 120 AND label !~ '[[:cntrl:]]'),
  CONSTRAINT deliverables_label_key_valida
    CHECK (label_key <> '' AND label_key = btrim(label_key) AND label_key = lower(label_key)
           AND char_length(label_key) <= 120),
  CONSTRAINT deliverables_last_version_valida CHECK (last_version >= 0)
);

-- Dos entregables activos de una participación no comparten etiqueta normalizada.
-- Archivar libera la clave; reactivar con un duplicado activo es un conflicto.
CREATE UNIQUE INDEX deliverables_clave_activa_key
  ON deliverables (campaign_influencer_id, label_key) WHERE status = 'active';
CREATE INDEX deliverables_campaign_idx ON deliverables (campaign_id, status);

CREATE OR REPLACE FUNCTION deliverables_integridad() RETURNS trigger AS $$
DECLARE
  c_estado   text;
  ci_estado  text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF inmutabilidad_bypass_activo() THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'deliverables no admite DELETE: se archiva.';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'active' OR NEW.last_version <> 0 OR NEW.archived_at IS NOT NULL THEN
      RAISE EXCEPTION 'Un entregable nace activo y sin versiones.';
    END IF;
    PERFORM contenido_exigir_rol(NEW.created_by, 'manage');
    -- FOR SHARE: retirar a la persona o archivar la campaña espera a que este alta termine.
    SELECT status::text INTO c_estado  FROM campaigns WHERE id = NEW.campaign_id FOR SHARE;
    SELECT status::text INTO ci_estado FROM campaign_influencers WHERE id = NEW.campaign_influencer_id FOR SHARE;
    IF c_estado IS DISTINCT FROM 'activa' OR ci_estado IS DISTINCT FROM 'activo' THEN
      RAISE EXCEPTION 'La campaña debe estar activa y el influencer activo en ella para crear un entregable.';
    END IF;
    IF NEW.campaign_product_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM campaign_influencer_products
       WHERE campaign_influencer_id = NEW.campaign_influencer_id
         AND campaign_product_id    = NEW.campaign_product_id
    ) THEN
      RAISE EXCEPTION 'El producto no está asignado a este influencer en la campaña.';
    END IF;
    RETURN NEW;
  END IF;

  -- UPDATE: la identidad (a quién pertenece y de qué producto trata) no cambia.
  IF NEW.id                     IS DISTINCT FROM OLD.id
     OR NEW.organization_id        IS DISTINCT FROM OLD.organization_id
     OR NEW.campaign_id            IS DISTINCT FROM OLD.campaign_id
     OR NEW.campaign_influencer_id IS DISTINCT FROM OLD.campaign_influencer_id
     OR NEW.campaign_product_id    IS DISTINCT FROM OLD.campaign_product_id
     OR NEW.created_by             IS DISTINCT FROM OLD.created_by
     OR NEW.created_at             IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'La identidad de un entregable (campaña, participación, producto, autor) no se modifica.';
  END IF;
  IF NEW.last_version <> OLD.last_version AND NEW.last_version <> OLD.last_version + 1 THEN
    RAISE EXCEPTION 'last_version solo avanza de uno en uno, al registrar una versión.';
  END IF;
  -- Reactivar exige campaña activa y participación activa (si no, quedaría un entregable
  -- activo bajo una participación retirada).
  IF OLD.status = 'archived' AND NEW.status = 'active' THEN
    SELECT status::text INTO c_estado  FROM campaigns WHERE id = NEW.campaign_id FOR SHARE;
    SELECT status::text INTO ci_estado FROM campaign_influencers WHERE id = NEW.campaign_influencer_id FOR SHARE;
    IF c_estado IS DISTINCT FROM 'activa' OR ci_estado IS DISTINCT FROM 'activo' THEN
      RAISE EXCEPTION 'La campaña debe estar activa y el influencer activo en ella para reactivar un entregable.';
    END IF;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER deliverables_integridad
  BEFORE INSERT OR UPDATE OR DELETE ON deliverables
  FOR EACH ROW EXECUTE FUNCTION deliverables_integridad();

-- ─────────────────────────── 3. Versiones de guion ─────────────────────────────

-- Versión RECIBIDA e inmutable: el contenido ES el archivo (`source_documents`).
-- Solo cambia su estado de revisión. `text + CHECK`, no ENUM (ALTER TYPE ADD VALUE
-- exige migración propia; precedente 013/021).
--
--   received → in_review → approved → superseded
--        └────────┴──→ changes_requested (terminal: reabrir = versión N+1)
--   received | in_review | approved → superseded   (solo al aprobar una versión mayor)
CREATE TABLE script_versions (
  id                               uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id                  uuid NOT NULL,
  campaign_id                      uuid NOT NULL,
  deliverable_id                   uuid NOT NULL,
  -- La asigna el trigger; el llamador no la fija.
  version                          integer NOT NULL,
  status                           text NOT NULL DEFAULT 'received',
  source_document_id               uuid NOT NULL,
  -- Derivados por el trigger de `source_documents` (provenance congelada).
  source_filename                  text NOT NULL,
  source_hash                      text NOT NULL,
  created_by                       uuid NOT NULL,
  created_at                       timestamptz NOT NULL DEFAULT now(),
  updated_at                       timestamptz NOT NULL DEFAULT now(),
  -- Aprobación (se fijan UNA vez, al aprobar; se conservan al pasar a superseded).
  approved_by                      uuid,
  approved_at                      timestamptz,
  approved_via_proposed_action_id  uuid,
  -- La FK hacia `content_analysis_runs` la añade la 024.
  approved_analysis_id             uuid,
  approved_brief_version_id        uuid,
  -- Huella de lo que se aprobó (cifras e ids; nunca texto de documentos).
  approval_snapshot                jsonb,
  -- Reemplazo por una versión posterior aprobada.
  superseded_by_version_id         uuid,
  superseded_at                    timestamptz,

  CONSTRAINT script_versions_entregable_fkey
    FOREIGN KEY (deliverable_id, organization_id, campaign_id)
    REFERENCES deliverables (id, organization_id, campaign_id) ON DELETE RESTRICT,
  -- La fuente es de la misma organización Y de la misma campaña.
  CONSTRAINT script_versions_fuente_org_fkey
    FOREIGN KEY (source_document_id, organization_id)
    REFERENCES source_documents (id, organization_id) ON DELETE RESTRICT,
  CONSTRAINT script_versions_fuente_campaign_fkey
    FOREIGN KEY (source_document_id, campaign_id)
    REFERENCES source_documents (id, campaign_id) ON DELETE RESTRICT,
  CONSTRAINT script_versions_autor_fkey
    FOREIGN KEY (created_by, organization_id)
    REFERENCES users (id, organization_id) ON DELETE RESTRICT,
  CONSTRAINT script_versions_aprobador_fkey
    FOREIGN KEY (approved_by, organization_id)
    REFERENCES users (id, organization_id) ON DELETE RESTRICT,
  CONSTRAINT script_versions_accion_fkey
    FOREIGN KEY (approved_via_proposed_action_id, organization_id, campaign_id)
    REFERENCES proposed_actions (id, organization_id, campaign_id) ON DELETE RESTRICT,
  CONSTRAINT script_versions_brief_fkey
    FOREIGN KEY (approved_brief_version_id)
    REFERENCES brief_versions (id) ON DELETE RESTRICT,
  -- NO ACTION a propósito: con RESTRICT, la limpieza de pruebas fallaría al borrar la
  -- versión reemplazada antes que su sucesora dentro de un mismo statement.
  CONSTRAINT script_versions_sucesora_fkey
    FOREIGN KEY (superseded_by_version_id, deliverable_id)
    REFERENCES script_versions (id, deliverable_id),
  CONSTRAINT script_versions_numero_key UNIQUE (deliverable_id, version),
  CONSTRAINT script_versions_id_entregable_key UNIQUE (id, deliverable_id),
  CONSTRAINT script_versions_id_scope_key UNIQUE (id, organization_id, campaign_id),
  CONSTRAINT script_versions_version_valida CHECK (version >= 1),
  CONSTRAINT script_versions_estado_valido
    CHECK (status IN ('received', 'in_review', 'changes_requested', 'approved', 'superseded')),
  CONSTRAINT script_versions_hash_valido CHECK (source_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT script_versions_nombre_valido CHECK (btrim(source_filename) <> ''),
  CONSTRAINT script_versions_aprobacion_par CHECK ((approved_at IS NULL) = (approved_by IS NULL)),
  -- Las demás marcas de aprobación solo existen si hubo aprobación.
  CONSTRAINT script_versions_aprobacion_completa CHECK (
    approved_at IS NOT NULL
    OR (approved_via_proposed_action_id IS NULL AND approved_analysis_id IS NULL
        AND approved_brief_version_id IS NULL AND approval_snapshot IS NULL)
  ),
  CONSTRAINT script_versions_snapshot_objeto
    CHECK (approval_snapshot IS NULL OR jsonb_typeof(approval_snapshot) = 'object'),
  CONSTRAINT script_versions_aprobada_coherente
    CHECK (status <> 'approved' OR (approved_at IS NOT NULL AND superseded_at IS NULL)),
  -- Solo una versión aprobada o reemplazada (que pudo estar aprobada) lleva marcas de aprobación.
  CONSTRAINT script_versions_nunca_aprobada
    CHECK (status IN ('approved', 'superseded') OR approved_at IS NULL),
  CONSTRAINT script_versions_reemplazo_coherente
    CHECK ((status = 'superseded') = (superseded_at IS NOT NULL AND superseded_by_version_id IS NOT NULL)),
  CONSTRAINT script_versions_reemplazo_par
    CHECK ((superseded_at IS NULL) = (superseded_by_version_id IS NULL))
);

-- Máximo UNA versión aprobada vigente por entregable: la aprobada ES el estado.
CREATE UNIQUE INDEX script_versions_aprobada_vigente_key
  ON script_versions (deliverable_id) WHERE status = 'approved';
CREATE INDEX script_versions_campaign_estado_idx ON script_versions (campaign_id, status);
CREATE INDEX script_versions_fuente_idx ON script_versions (source_document_id);

-- ¿La versión está cerrada (aprobada o reemplazada)? Para los triggers de las tablas
-- hijas (comentarios aquí; hallazgos en la 024).
CREATE OR REPLACE FUNCTION script_version_cerrada(p_version uuid) RETURNS boolean AS $$
  SELECT COALESCE((SELECT status IN ('approved', 'superseded') FROM script_versions WHERE id = p_version), false);
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION script_versions_integridad() RETURNS trigger AS $$
DECLARE
  d          deliverables%ROWTYPE;
  s          source_documents%ROWTYPE;
  pa         proposed_actions%ROWTYPE;
  c_estado   text;
  ci_estado  text;
  ok_trans   boolean;
BEGIN
  -- ── DELETE: la historia se conserva (solo el bypass de bases `_test`). ──
  IF TG_OP = 'DELETE' THEN
    IF inmutabilidad_bypass_activo() THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'script_versions no admite DELETE: se conserva la historia.';
  END IF;

  -- ── INSERT ──
  IF TG_OP = 'INSERT' THEN
    -- Serializa numeración y aprobación del entregable.
    SELECT * INTO d FROM deliverables WHERE id = NEW.deliverable_id FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'El entregable no existe.' USING ERRCODE = 'foreign_key_violation';
    END IF;
    IF NEW.status <> 'received'
       OR NEW.approved_at IS NOT NULL OR NEW.approved_by IS NOT NULL
       OR NEW.approved_via_proposed_action_id IS NOT NULL OR NEW.approved_analysis_id IS NOT NULL
       OR NEW.approved_brief_version_id IS NOT NULL OR NEW.approval_snapshot IS NOT NULL
       OR NEW.superseded_at IS NOT NULL OR NEW.superseded_by_version_id IS NOT NULL THEN
      RAISE EXCEPTION 'Una versión de guion nace recibida (received), sin marcas de aprobación ni de reemplazo.';
    END IF;
    IF d.status <> 'active' THEN
      RAISE EXCEPTION 'El entregable está archivado: no se registran versiones.';
    END IF;
    SELECT status::text INTO c_estado  FROM campaigns WHERE id = d.campaign_id FOR SHARE;
    SELECT status::text INTO ci_estado FROM campaign_influencers WHERE id = d.campaign_influencer_id FOR SHARE;
    IF c_estado IS DISTINCT FROM 'activa' OR ci_estado IS DISTINCT FROM 'activo' THEN
      RAISE EXCEPTION 'Campaña no activa o influencer retirado: no se registran versiones.';
    END IF;
    PERFORM contenido_exigir_rol(NEW.created_by, 'manage');
    -- FOR SHARE: una publicación a TCL de esta fuente espera a que este registro termine.
    SELECT * INTO s FROM source_documents WHERE id = NEW.source_document_id FOR SHARE;
    IF NOT FOUND OR s.origin <> 'file' THEN
      RAISE EXCEPTION 'El guion debe ser un archivo (no un enlace): un enlace mutable rompe «nunca se sobrescribe».';
    END IF;
    IF s.visibility <> 'interna' THEN
      RAISE EXCEPTION 'La fuente es visible para TCL: bájela a interna antes de usarla como guion.';
    END IF;
    IF EXISTS (
      SELECT 1 FROM script_versions
       WHERE deliverable_id = d.id AND version = d.last_version AND source_document_id = NEW.source_document_id
    ) THEN
      RAISE EXCEPTION 'Es el mismo contenido que la última versión de este entregable.';
    END IF;
    NEW.source_filename := s.filename;   -- derivados de la fuente, nunca del llamador
    NEW.source_hash     := s.hash;
    NEW.version         := d.last_version + 1;
    NEW.created_at      := now();
    NEW.updated_at      := now();
    UPDATE deliverables SET last_version = NEW.version WHERE id = d.id;
    RETURN NEW;
  END IF;

  -- ── UPDATE ──
  -- Bypass de pruebas (bases `_test`): permite FIJAR estados para probar el resto.
  IF inmutabilidad_bypass_activo() THEN RETURN NEW; END IF;

  IF (NEW.id, NEW.organization_id, NEW.campaign_id, NEW.deliverable_id, NEW.version, NEW.source_document_id,
      NEW.source_filename, NEW.source_hash, NEW.created_by, NEW.created_at)
     IS DISTINCT FROM
     (OLD.id, OLD.organization_id, OLD.campaign_id, OLD.deliverable_id, OLD.version, OLD.source_document_id,
      OLD.source_filename, OLD.source_hash, OLD.created_by, OLD.created_at) THEN
    RAISE EXCEPTION 'La identidad y el binding de una versión de guion no se modifican.';
  END IF;

  IF OLD.status = 'superseded' THEN
    RAISE EXCEPTION 'Una versión reemplazada es histórica: no admite cambios.';
  END IF;

  IF NEW.status = OLD.status THEN
    IF OLD.status = 'approved' THEN
      RAISE EXCEPTION 'Una versión aprobada no se reescribe.';
    END IF;
    IF (NEW.approved_by, NEW.approved_at, NEW.approved_via_proposed_action_id, NEW.approved_analysis_id,
        NEW.approved_brief_version_id, NEW.approval_snapshot, NEW.superseded_by_version_id, NEW.superseded_at)
       IS DISTINCT FROM
       (OLD.approved_by, OLD.approved_at, OLD.approved_via_proposed_action_id, OLD.approved_analysis_id,
        OLD.approved_brief_version_id, OLD.approval_snapshot, OLD.superseded_by_version_id, OLD.superseded_at) THEN
      RAISE EXCEPTION 'Las marcas de aprobación y de reemplazo solo cambian con una transición.';
    END IF;
    NEW.updated_at := now();
    RETURN NEW;
  END IF;

  -- Cambio de estado: serializa con el resto de operaciones del entregable.
  SELECT * INTO d FROM deliverables WHERE id = OLD.deliverable_id FOR UPDATE;

  ok_trans := (OLD.status, NEW.status) IN (
    ('received', 'in_review'),
    ('received', 'changes_requested'),
    ('in_review', 'changes_requested'),
    ('in_review', 'approved'),
    ('received', 'superseded'),
    ('in_review', 'superseded'),
    ('approved', 'superseded')
  );
  IF NOT ok_trans THEN
    RAISE EXCEPTION 'Transición de versión de guion no válida: % → % (changes_requested y superseded son terminales).',
      OLD.status, NEW.status;
  END IF;

  -- Entregable, participación y campaña activos para toda transición excepto el
  -- reemplazo (efecto interno de aprobar una versión mayor).
  IF NEW.status <> 'superseded' THEN
    SELECT status::text INTO c_estado  FROM campaigns WHERE id = d.campaign_id FOR SHARE;
    SELECT status::text INTO ci_estado FROM campaign_influencers WHERE id = d.campaign_influencer_id FOR SHARE;
    IF d.status <> 'active' OR c_estado IS DISTINCT FROM 'activa' OR ci_estado IS DISTINCT FROM 'activo' THEN
      RAISE EXCEPTION 'Entregable archivado, campaña no activa o influencer retirado: no se cambia el estado de la versión.';
    END IF;
  END IF;

  IF NEW.status = 'approved' THEN
    -- Aprobar: persona con rol, más nueva que toda aprobada alguna vez, fuente intacta.
    PERFORM contenido_exigir_rol(NEW.approved_by, 'approve');
    IF EXISTS (
      SELECT 1 FROM script_versions
       WHERE deliverable_id = OLD.deliverable_id AND approved_at IS NOT NULL AND version > OLD.version
    ) THEN
      RAISE EXCEPTION 'Ya hay una versión más nueva aprobada: no se aprueba hacia atrás.';
    END IF;
    SELECT * INTO s FROM source_documents WHERE id = OLD.source_document_id;
    IF s.hash IS DISTINCT FROM OLD.source_hash THEN
      RAISE EXCEPTION 'El original de la fuente cambió desde que se recibió la versión: no se aprueba.';
    END IF;
    IF NEW.superseded_at IS NOT NULL OR NEW.superseded_by_version_id IS NOT NULL THEN
      RAISE EXCEPTION 'Una versión que se aprueba no puede llevar marcas de reemplazo.';
    END IF;
    -- Si viene de una acción propuesta: la correcta, confirmada por quien aprueba.
    IF NEW.approved_via_proposed_action_id IS NOT NULL THEN
      SELECT * INTO pa FROM proposed_actions WHERE id = NEW.approved_via_proposed_action_id;
      IF NOT FOUND
         OR pa.action_type  <> 'script_version.approve'
         OR pa.resource_id  <> NEW.id
         OR pa.status       <> 'confirmed'
         OR pa.confirmed_by IS DISTINCT FROM NEW.approved_by THEN
        RAISE EXCEPTION 'La acción propuesta citada no es la aprobación confirmada de esta versión por esta persona.';
      END IF;
    END IF;
    NEW.approved_at := now();
  ELSE
    -- Ninguna otra transición toca las marcas de aprobación (ya fijadas o nulas).
    IF (NEW.approved_by, NEW.approved_at, NEW.approved_via_proposed_action_id, NEW.approved_analysis_id,
        NEW.approved_brief_version_id, NEW.approval_snapshot)
       IS DISTINCT FROM
       (OLD.approved_by, OLD.approved_at, OLD.approved_via_proposed_action_id, OLD.approved_analysis_id,
        OLD.approved_brief_version_id, OLD.approval_snapshot) THEN
      RAISE EXCEPTION 'Las marcas de aprobación solo se fijan al aprobar y no se modifican después.';
    END IF;
    IF NEW.status = 'superseded' THEN
      IF NOT EXISTS (
        SELECT 1 FROM script_versions
         WHERE id = NEW.superseded_by_version_id AND deliverable_id = OLD.deliverable_id AND version > OLD.version
      ) THEN
        RAISE EXCEPTION 'La sucesora debe ser una versión posterior del mismo entregable.';
      END IF;
      IF EXISTS (
        SELECT 1 FROM source_documents WHERE id = OLD.source_document_id AND visibility <> 'interna'
      ) THEN
        RAISE EXCEPTION 'Baje a interna la visibilidad de la fuente antes de reemplazar la versión.';
      END IF;
      NEW.superseded_at := now();
    ELSIF NEW.superseded_at IS NOT NULL OR NEW.superseded_by_version_id IS NOT NULL THEN
      RAISE EXCEPTION 'Solo una versión reemplazada lleva marcas de reemplazo.';
    END IF;
  END IF;

  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER script_versions_integridad
  BEFORE INSERT OR UPDATE OR DELETE ON script_versions
  FOR EACH ROW EXECUTE FUNCTION script_versions_integridad();

-- Al CERRAR la transacción: la sucesora de toda versión reemplazada quedó aprobada
-- (o a su vez reemplazada). Así la versión de mayor número nunca está `superseded` y
-- no se puede dejar un entregable sin aprobada vigente por un reemplazo a medias.
CREATE OR REPLACE FUNCTION script_versions_sucesora_aprobada() RETURNS trigger AS $$
BEGIN
  IF inmutabilidad_bypass_activo() THEN RETURN NULL; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM script_versions
     WHERE id = NEW.superseded_by_version_id AND status IN ('approved', 'superseded')
  ) THEN
    RAISE EXCEPTION 'Una versión solo se reemplaza al aprobar su sucesora: la sucesora no quedó aprobada.';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER script_versions_sucesora_aprobada
  AFTER UPDATE OF status ON script_versions
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN (NEW.status = 'superseded')
  EXECUTE FUNCTION script_versions_sucesora_aprobada();

-- ─────────────────────────── 4. Comentarios de revisión (SmartPR) ──────────────

-- Entidad SEPARADA de los hallazgos de la IA y de los comentarios del Brief
-- (`field_comments`, atados a brief_versions). Append-only: sin estado ni
-- resolución. No hay columna de IA ni de sistema: una IA o el sistema no pueden
-- firmar. El texto de un comentario nacido en el chat es una cita EXACTA de un
-- mensaje de la persona (la base lo impone aunque falle el grounding de la tool).
CREATE TABLE script_review_comments (
  id                 uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id    uuid NOT NULL,
  campaign_id        uuid NOT NULL,
  script_version_id  uuid NOT NULL,
  author_id          uuid NOT NULL,
  kind               text NOT NULL,
  body               text NOT NULL,
  locator            jsonb,
  origin             text NOT NULL,
  chat_message_id    uuid,
  correlation        jsonb,
  created_at         timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT script_review_comments_version_fkey
    FOREIGN KEY (script_version_id, organization_id, campaign_id)
    REFERENCES script_versions (id, organization_id, campaign_id) ON DELETE RESTRICT,
  CONSTRAINT script_review_comments_autor_fkey
    FOREIGN KEY (author_id, organization_id)
    REFERENCES users (id, organization_id) ON DELETE RESTRICT,
  CONSTRAINT script_review_comments_mensaje_fkey
    FOREIGN KEY (chat_message_id)
    REFERENCES chat_messages (id) ON DELETE RESTRICT,
  CONSTRAINT script_review_comments_tipo_valido CHECK (kind IN ('editorial', 'change_request')),
  CONSTRAINT script_review_comments_cuerpo_valido
    CHECK (btrim(body) <> '' AND char_length(body) <= 2000),
  CONSTRAINT script_review_comments_origen_valido CHECK (origin IN ('ui', 'chat')),
  CONSTRAINT script_review_comments_mensaje_coherente CHECK ((origin = 'chat') = (chat_message_id IS NOT NULL)),
  CONSTRAINT script_review_comments_locator_valido CHECK (locator IS NULL OR source_locator_valido(locator)),
  CONSTRAINT script_review_comments_correlacion_objeto
    CHECK (correlation IS NULL OR jsonb_typeof(correlation) = 'object')
);

CREATE INDEX script_review_comments_version_idx ON script_review_comments (script_version_id, created_at);

CREATE OR REPLACE FUNCTION script_review_comments_integridad() RETURNS trigger AS $$
DECLARE
  v_estado  text;
  m         chat_messages%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF inmutabilidad_bypass_activo() THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'script_review_comments es append-only: no admite DELETE.';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'script_review_comments es append-only: un comentario no se modifica.';
  END IF;

  -- INSERT. La persona debe poder gestionar el contenido (admin, director, consultor).
  PERFORM contenido_exigir_rol(NEW.author_id, 'manage');

  -- La versión sigue abierta (received | in_review). FOR SHARE: aprobarla, pedir
  -- cambios o reemplazarla espera a que este comentario termine.
  SELECT status INTO v_estado FROM script_versions WHERE id = NEW.script_version_id FOR SHARE;
  IF v_estado IS NULL OR v_estado NOT IN ('received', 'in_review') THEN
    RAISE EXCEPTION 'La versión de guion no admite comentarios: ya está cerrada (estado «%»).', COALESCE(v_estado, 'inexistente');
  END IF;

  IF NEW.origin = 'chat' THEN
    SELECT * INTO m FROM chat_messages WHERE id = NEW.chat_message_id;
    IF NOT FOUND
       OR m.role <> 'user'
       OR m.user_id <> NEW.author_id
       OR m.organization_id <> NEW.organization_id
       OR m.campaign_id <> NEW.campaign_id THEN
      RAISE EXCEPTION 'El comentario nacido en el chat debe citar un mensaje del autor, de esta campaña y escrito por la persona (no por el asistente).';
    END IF;
    IF position(NEW.body IN m.content) = 0 THEN
      RAISE EXCEPTION 'El texto del comentario debe ser una cita exacta del mensaje de la persona.';
    END IF;
  END IF;

  NEW.created_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER script_review_comments_integridad
  BEFORE INSERT OR UPDATE OR DELETE ON script_review_comments
  FOR EACH ROW EXECUTE FUNCTION script_review_comments_integridad();

-- ─────────────────────────── 5. Guarda sobre `source_documents` ────────────────

-- (a) Un guion que no es la aprobada vigente no se expone a TCL: la visibilidad
--     tcl/compartida de su fuente se rechaza (también por SQL directo y por
--     deduplicación por hash).
-- (b) El original de una fuente enlazada a un guion no cambia (el worker solo
--     actualiza status/visibility/current_snapshot_id).
-- Sale pronto si no cambia nada protegido: el worker actualiza `status` por job.
CREATE OR REPLACE FUNCTION source_documents_guion_guarda() RETURNS trigger AS $$
BEGIN
  IF NEW.visibility IS DISTINCT FROM OLD.visibility
     AND NEW.visibility IN ('tcl', 'compartida')
     AND EXISTS (SELECT 1 FROM script_versions WHERE source_document_id = NEW.id AND status <> 'approved') THEN
    RAISE EXCEPTION 'Esta fuente respalda una versión de guion que no es la aprobada vigente: no se expone a TCL.';
  END IF;

  IF (NEW.hash, NEW.filename, NEW.file_id, NEW.mime_type, NEW.size_bytes, NEW.campaign_id, NEW.organization_id, NEW.origin)
     IS DISTINCT FROM
     (OLD.hash, OLD.filename, OLD.file_id, OLD.mime_type, OLD.size_bytes, OLD.campaign_id, OLD.organization_id, OLD.origin)
     AND EXISTS (SELECT 1 FROM script_versions WHERE source_document_id = NEW.id) THEN
    RAISE EXCEPTION 'El original de una fuente enlazada a un guion no cambia.';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER source_documents_guion_guarda
  BEFORE UPDATE ON source_documents
  FOR EACH ROW EXECUTE FUNCTION source_documents_guion_guarda();
