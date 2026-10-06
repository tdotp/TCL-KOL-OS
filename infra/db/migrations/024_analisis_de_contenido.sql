-- 024 · Análisis de contenido (V2 · Fase 7): revisiones de un guion contra el Brief aprobado vigente.
--
-- Forward-only y aditiva: cuatro tablas nuevas, dos funciones del Brief rector, un UNIQUE aditivo en
-- `brief_fields`, una columna nueva (nullable) en `ai_runs` y la FK de `script_versions.approved_analysis_id`
-- (hasta aquí un uuid sin FK). No cambia ninguna fila ni restricción existente: ningún dato previo puede fallar.
--
--   script_versions ─< content_analysis_runs ─< content_findings ─< content_finding_brief_refs ─► brief_fields
--                              │                       └──────────< content_finding_script_refs
--                              └─< ai_runs (una fila por LLAMADA al modelo, ledger de costo)
--
-- Una REVISIÓN (`content_analysis_runs`) es el hecho «este guion (esta versión, este hash de fuente) se
-- contrastó con ESTE Brief (esta versión aprobada, esta huella de contenido)». Hay dos tipos:
--   · ai_assisted: la ejecutó el análisis asistido. Nace `running`, la cierra el caso de uso; produce
--     hallazgos (todo-o-nada: o se persisten todos con el run `succeeded`, o ninguno con el run `failed`).
--   · human: la registró UNA persona (script:manage) que revisó el guion contra el Brief. Nace `succeeded`,
--     sin hallazgos, sin modelo. La IA nunca es requisito: una revisión humana también habilita aprobar.
--
-- Principios impuestos AQUÍ (no solo en la aplicación):
--   · El Brief gobernante es de la MISMA campaña, versión lógica `es`, con `approved_at` y estado
--     approved|superseded: NUNCA un borrador. `brief_rector_de_campana` es el SQL canónico del rector
--     (paridad probada con `obtenerBriefRector` de TypeScript).
--   · Los insumos de una revisión (versión, Brief, huellas, fuente, autor) son inmutables; el estado solo
--     avanza (queued → running → succeeded | failed) y un estado terminal está congelado.
--   · Los hallazgos y sus referencias son inmutables, solo se insertan mientras el run está `running`, y
--     `finding_count` coincide con las filas al pasar a `succeeded` (un `failed` no tiene ninguna).
--   · Los hallazgos NO tienen estado ni resolución (el triage queda para una fase posterior): informan,
--     no deciden. Nada de esto aprueba nada.
--   · Aislamiento: toda fila lleva organización y campaña y las amarra con claves compuestas.
--   · Sin DELETE salvo el bypass de bases `_test` (limpieza de pruebas).
--
-- CURRENT/STALE no es una columna: se deriva en lectura (run.governing_brief_version_id = rector actual).

-- ─────────────────────────── 1. Soporte aditivo ────────────────────────────────

-- Permite la FK compuesta (brief_field_id, brief_version_id) → brief_fields: una referencia a un campo del
-- Brief SOLO puede apuntar a un campo de la versión gobernante del run.
ALTER TABLE brief_fields
  ADD CONSTRAINT brief_fields_id_version_key UNIQUE (id, brief_version_id);

-- ─────────────────────────── 2. Brief rector ───────────────────────────────────

-- El Brief que rige una campaña: versión lógica `es` aprobada alguna vez (approved_at) y vigente o ya
-- reemplazada por una hija; la de mayor `approved_at` (luego `version`). Una hija en BORRADOR no desplaza
-- al padre. Sin ninguna ⇒ NULL (no hay Brief aprobado). Nunca un borrador.
CREATE OR REPLACE FUNCTION brief_rector_de_campana(p_campana uuid) RETURNS uuid AS $$
  SELECT v.id
    FROM brief_versions v JOIN briefs b ON b.id = v.brief_id
   WHERE b.campaign_id = p_campana
     AND v.language = 'es'
     AND v.approved_at IS NOT NULL
     AND v.status IN ('approved', 'superseded')
   ORDER BY v.approved_at DESC, v.version DESC
   LIMIT 1;
$$ LANGUAGE sql STABLE;

-- ¿Puede esta versión del Brief gobernar una revisión de esta campaña/organización? (el rector actual o
-- uno anterior: lo vigente se deriva en lectura). Un borrador, una cancelada o una traducción no.
CREATE OR REPLACE FUNCTION brief_gobernante_valido(p_version uuid, p_campana uuid, p_organizacion uuid)
RETURNS boolean AS $$
  SELECT EXISTS (
    SELECT 1
      FROM brief_versions v JOIN briefs b ON b.id = v.brief_id
     WHERE v.id = p_version
       AND b.campaign_id = p_campana
       AND v.organization_id = p_organizacion
       AND v.language = 'es'
       AND v.approved_at IS NOT NULL
       AND v.status IN ('approved', 'superseded')
  );
$$ LANGUAGE sql STABLE;

-- ─────────────────────────── 3. Revisiones ─────────────────────────────────────

CREATE TABLE content_analysis_runs (
  id                        uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id           uuid NOT NULL,
  campaign_id               uuid NOT NULL,
  kind                      text NOT NULL,
  script_version_id         uuid NOT NULL,
  -- Desnormalizados (los valida el trigger de INSERT contra la versión): leer sin unir.
  deliverable_id            uuid NOT NULL,
  campaign_influencer_id    uuid NOT NULL,
  -- El Brief gobernante. Número y fecha los DERIVA el trigger de la versión del Brief (no el llamador).
  governing_brief_version_id uuid NOT NULL,
  governing_brief_number    integer NOT NULL,
  brief_approved_at         timestamptz NOT NULL,
  -- Huella de la proyección del Brief (campos permitidos, valor original ES) realmente usada.
  brief_fingerprint         text NOT NULL,
  -- La fuente del guion tal como estaba (el trigger exige que coincida con la versión).
  script_source_id          uuid NOT NULL,
  script_source_hash        text NOT NULL,
  -- Solo ai_assisted: lo que se mandó al modelo (sin contenido).
  script_text_hash          text,
  script_chars              integer,
  fragment_count            integer,
  product_scope             text,
  context_manifest          jsonb,
  prompt_version            text,
  output_schema_version     text,
  context_version           text,
  severity_policy_version   text,
  model_tier                text,
  -- Al cerrar (provider/model reales del worker; nunca el entorno de Node).
  provider                  text,
  model                     text,
  status                    text NOT NULL,
  failure_code              text,
  failure_detail            jsonb,
  finding_count             integer NOT NULL DEFAULT 0,
  -- Solo ai_assisted: idempotencia (misma clave ⇒ mismo run).
  idempotency_key           text,
  request_hash              text,
  mode                      text,
  -- Solo human: nota opcional de quien revisó.
  note                      text,
  created_by                uuid NOT NULL,
  created_at                timestamptz NOT NULL DEFAULT now(),
  started_at                timestamptz,
  finished_at               timestamptz,
  lease_expires_at          timestamptz,

  CONSTRAINT content_analysis_runs_campana_fkey
    FOREIGN KEY (campaign_id, organization_id)
    REFERENCES campaigns (id, organization_id) ON DELETE RESTRICT,
  CONSTRAINT content_analysis_runs_version_fkey
    FOREIGN KEY (script_version_id, organization_id, campaign_id)
    REFERENCES script_versions (id, organization_id, campaign_id) ON DELETE RESTRICT,
  CONSTRAINT content_analysis_runs_version_entregable_fkey
    FOREIGN KEY (script_version_id, deliverable_id)
    REFERENCES script_versions (id, deliverable_id) ON DELETE RESTRICT,
  CONSTRAINT content_analysis_runs_participacion_fkey
    FOREIGN KEY (campaign_influencer_id, campaign_id)
    REFERENCES campaign_influencers (id, campaign_id) ON DELETE RESTRICT,
  CONSTRAINT content_analysis_runs_brief_fkey
    FOREIGN KEY (governing_brief_version_id)
    REFERENCES brief_versions (id) ON DELETE RESTRICT,
  CONSTRAINT content_analysis_runs_fuente_fkey
    FOREIGN KEY (script_source_id, organization_id)
    REFERENCES source_documents (id, organization_id) ON DELETE RESTRICT,
  CONSTRAINT content_analysis_runs_autor_fkey
    FOREIGN KEY (created_by, organization_id)
    REFERENCES users (id, organization_id) ON DELETE RESTRICT,
  CONSTRAINT content_analysis_runs_id_org_key UNIQUE (id, organization_id),
  CONSTRAINT content_analysis_runs_id_version_key UNIQUE (id, script_version_id),
  CONSTRAINT content_analysis_runs_clave_key UNIQUE (organization_id, script_version_id, idempotency_key),

  CONSTRAINT content_analysis_runs_tipo_valido CHECK (kind IN ('ai_assisted', 'human')),
  CONSTRAINT content_analysis_runs_estado_valido CHECK (status IN ('queued', 'running', 'succeeded', 'failed')),
  CONSTRAINT content_analysis_runs_modo_valido CHECK (mode IS NULL OR mode IN ('ensure', 'reanalyze')),
  CONSTRAINT content_analysis_runs_alcance_valido
    CHECK (product_scope IS NULL OR product_scope IN ('assigned', 'all_campaign')),
  CONSTRAINT content_analysis_runs_huellas_validas CHECK (
    brief_fingerprint ~ '^[0-9a-f]{64}$'
    AND script_source_hash ~ '^[0-9a-f]{64}$'
    AND (script_text_hash IS NULL OR script_text_hash ~ '^[0-9a-f]{64}$')
    AND (request_hash IS NULL OR request_hash ~ '^[0-9a-f]{64}$')
  ),
  CONSTRAINT content_analysis_runs_cifras_validas CHECK (
    (script_chars IS NULL OR script_chars >= 0) AND (fragment_count IS NULL OR fragment_count >= 0)
    AND finding_count BETWEEN 0 AND 100
    AND governing_brief_number >= 1
  ),
  CONSTRAINT content_analysis_runs_clave_idempotencia_valida
    CHECK (idempotency_key IS NULL OR (btrim(idempotency_key) <> '' AND char_length(idempotency_key) <= 200)),
  CONSTRAINT content_analysis_runs_nota_valida
    CHECK (note IS NULL OR (btrim(note) <> '' AND char_length(note) <= 1000)),
  CONSTRAINT content_analysis_runs_manifiesto_acotado CHECK (
    context_manifest IS NULL
    OR (jsonb_typeof(context_manifest) = 'object' AND octet_length(context_manifest::text) <= 262144)
  ),
  CONSTRAINT content_analysis_runs_detalle_acotado CHECK (
    failure_detail IS NULL
    OR (jsonb_typeof(failure_detail) = 'object' AND octet_length(failure_detail::text) <= 16384)
  ),
  CONSTRAINT content_analysis_runs_codigo_fallo_valido
    CHECK (failure_code IS NULL OR failure_code ~ '^[A-Z][A-Z0-9_]{1,99}$'),
  CONSTRAINT content_analysis_runs_detalle_solo_en_fallo CHECK (failure_detail IS NULL OR status = 'failed'),
  -- Forma de cada tipo (el que no usa un campo lo deja nulo).
  CONSTRAINT content_analysis_runs_forma_ia CHECK (
    kind <> 'ai_assisted' OR (
      idempotency_key IS NOT NULL AND request_hash IS NOT NULL AND mode IS NOT NULL
      AND prompt_version IS NOT NULL AND output_schema_version IS NOT NULL
      AND context_version IS NOT NULL AND severity_policy_version IS NOT NULL AND model_tier IS NOT NULL
      AND product_scope IS NOT NULL AND context_manifest IS NOT NULL
      AND script_text_hash IS NOT NULL AND script_chars IS NOT NULL AND fragment_count IS NOT NULL
      AND started_at IS NOT NULL AND note IS NULL
    )
  ),
  CONSTRAINT content_analysis_runs_forma_humana CHECK (
    kind <> 'human' OR (
      status = 'succeeded' AND finding_count = 0 AND finished_at IS NOT NULL
      AND provider IS NULL AND model IS NULL
      AND idempotency_key IS NULL AND request_hash IS NULL AND mode IS NULL
      AND prompt_version IS NULL AND output_schema_version IS NULL AND context_version IS NULL
      AND severity_policy_version IS NULL AND model_tier IS NULL
      AND product_scope IS NULL AND context_manifest IS NULL
      AND script_text_hash IS NULL AND script_chars IS NULL AND fragment_count IS NULL
      AND failure_code IS NULL AND failure_detail IS NULL AND lease_expires_at IS NULL
    )
  ),
  CONSTRAINT content_analysis_runs_cierre_coherente CHECK (
    (status IN ('queued', 'running')
       AND finished_at IS NULL AND failure_code IS NULL AND finding_count = 0 AND lease_expires_at IS NOT NULL)
    OR (status = 'succeeded'
       AND finished_at IS NOT NULL AND failure_code IS NULL AND lease_expires_at IS NULL
       AND (kind = 'human' OR (provider IS NOT NULL AND model IS NOT NULL)))
    OR (status = 'failed'
       AND finished_at IS NOT NULL AND failure_code IS NOT NULL AND finding_count = 0
       AND lease_expires_at IS NULL)
  )
);

-- Un solo análisis asistido ACTIVO por versión (el segundo se rechaza con un conflicto accionable).
CREATE UNIQUE INDEX content_analysis_runs_activo_key
  ON content_analysis_runs (script_version_id)
  WHERE kind = 'ai_assisted' AND status IN ('queued', 'running');
-- Una revisión humana por (versión, Brief gobernante, persona): doble clic idempotente; dos personas sí.
CREATE UNIQUE INDEX content_analysis_runs_humana_key
  ON content_analysis_runs (script_version_id, governing_brief_version_id, created_by)
  WHERE kind = 'human';
CREATE INDEX content_analysis_runs_version_idx ON content_analysis_runs (script_version_id, created_at DESC);
CREATE INDEX content_analysis_runs_campana_idx ON content_analysis_runs (campaign_id, created_at DESC);
CREATE INDEX content_analysis_runs_brief_idx ON content_analysis_runs (governing_brief_version_id);

CREATE OR REPLACE FUNCTION content_analysis_runs_integridad() RETURNS trigger AS $$
DECLARE
  sv       script_versions%ROWTYPE;
  ci       uuid;
  bv       record;
  hallazgos bigint;
BEGIN
  -- ── DELETE: la historia se conserva (solo el bypass de bases `_test`). ──
  IF TG_OP = 'DELETE' THEN
    IF inmutabilidad_bypass_activo() THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'content_analysis_runs no admite DELETE: se conserva la historia.';
  END IF;

  -- ── INSERT ──
  IF TG_OP = 'INSERT' THEN
    SELECT * INTO sv FROM script_versions WHERE id = NEW.script_version_id FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'La versión de guion no existe.' USING ERRCODE = 'foreign_key_violation';
    END IF;
    IF NEW.organization_id <> sv.organization_id
       OR NEW.campaign_id <> sv.campaign_id
       OR NEW.deliverable_id <> sv.deliverable_id THEN
      RAISE EXCEPTION 'La revisión declara una organización, campaña o entregable distintos de los de la versión.';
    END IF;
    SELECT campaign_influencer_id INTO ci FROM deliverables WHERE id = sv.deliverable_id;
    IF NEW.campaign_influencer_id IS DISTINCT FROM ci THEN
      RAISE EXCEPTION 'La revisión declara una participación distinta de la del entregable de la versión.';
    END IF;
    -- El guion revisado ES la fuente de la versión, con el hash con el que se recibió.
    IF NEW.script_source_id <> sv.source_document_id OR NEW.script_source_hash <> sv.source_hash THEN
      RAISE EXCEPTION 'La fuente y el hash de la revisión deben ser los de la versión de guion.';
    END IF;
    IF sv.status NOT IN ('received', 'in_review', 'approved') THEN
      RAISE EXCEPTION 'La versión de guion está en estado «%»: ya no admite nuevas revisiones.', sv.status;
    END IF;

    -- El Brief gobernante: de esta campaña, versión lógica es, aprobada alguna vez. NUNCA un borrador.
    SELECT v.version, v.approved_at INTO bv
      FROM brief_versions v JOIN briefs b ON b.id = v.brief_id
     WHERE v.id = NEW.governing_brief_version_id
       AND b.campaign_id = NEW.campaign_id
       AND v.organization_id = NEW.organization_id
       AND v.language = 'es'
       AND v.approved_at IS NOT NULL
       AND v.status IN ('approved', 'superseded');
    IF NOT FOUND THEN
      RAISE EXCEPTION 'El Brief gobernante debe ser una versión aprobada (o reemplazada tras aprobarse) de esta campaña: nunca un borrador.';
    END IF;
    NEW.governing_brief_number := bv.version;
    NEW.brief_approved_at      := bv.approved_at;

    -- Quien la pide o la registra: personal de la agencia con script:manage (lista cerrada, paridad con roleCan).
    PERFORM contenido_exigir_rol(NEW.created_by, 'manage');

    NEW.created_at := now();
    IF NEW.kind = 'ai_assisted' THEN
      IF NEW.status NOT IN ('queued', 'running') OR NEW.finding_count <> 0 THEN
        RAISE EXCEPTION 'Un análisis asistido nace en cola o en curso y sin hallazgos.';
      END IF;
      NEW.started_at := COALESCE(NEW.started_at, now());
    ELSE
      NEW.finished_at := COALESCE(NEW.finished_at, now());
    END IF;
    RETURN NEW;
  END IF;

  -- ── UPDATE ──
  -- Bypass de pruebas (bases `_test`): permite FIJAR estados para probar el resto.
  IF inmutabilidad_bypass_activo() THEN RETURN NEW; END IF;

  IF OLD.status IN ('succeeded', 'failed') THEN
    RAISE EXCEPTION 'Una revisión terminada (%) está congelada: no admite cambios.', OLD.status;
  END IF;
  IF (NEW.id, NEW.organization_id, NEW.campaign_id, NEW.kind, NEW.script_version_id, NEW.deliverable_id,
      NEW.campaign_influencer_id, NEW.governing_brief_version_id, NEW.governing_brief_number,
      NEW.brief_approved_at, NEW.brief_fingerprint, NEW.script_source_id, NEW.script_source_hash,
      NEW.script_text_hash, NEW.script_chars, NEW.fragment_count, NEW.product_scope, NEW.context_manifest,
      NEW.prompt_version, NEW.output_schema_version, NEW.context_version, NEW.severity_policy_version,
      NEW.model_tier, NEW.idempotency_key, NEW.request_hash, NEW.mode, NEW.note, NEW.created_by,
      NEW.created_at, NEW.started_at)
     IS DISTINCT FROM
     (OLD.id, OLD.organization_id, OLD.campaign_id, OLD.kind, OLD.script_version_id, OLD.deliverable_id,
      OLD.campaign_influencer_id, OLD.governing_brief_version_id, OLD.governing_brief_number,
      OLD.brief_approved_at, OLD.brief_fingerprint, OLD.script_source_id, OLD.script_source_hash,
      OLD.script_text_hash, OLD.script_chars, OLD.fragment_count, OLD.product_scope, OLD.context_manifest,
      OLD.prompt_version, OLD.output_schema_version, OLD.context_version, OLD.severity_policy_version,
      OLD.model_tier, OLD.idempotency_key, OLD.request_hash, OLD.mode, OLD.note, OLD.created_by,
      OLD.created_at, OLD.started_at) THEN
    RAISE EXCEPTION 'Los insumos de una revisión (versión, Brief, huellas, fuente, autor) no se modifican.';
  END IF;

  IF NEW.status = OLD.status THEN
    -- Seguir en curso: solo se puede renovar el plazo.
    IF (NEW.provider, NEW.model, NEW.failure_code, NEW.failure_detail, NEW.finding_count, NEW.finished_at)
       IS DISTINCT FROM
       (OLD.provider, OLD.model, OLD.failure_code, OLD.failure_detail, OLD.finding_count, OLD.finished_at) THEN
      RAISE EXCEPTION 'Una revisión en curso solo cambia de estado o renueva su plazo.';
    END IF;
    RETURN NEW;
  END IF;

  IF (OLD.status, NEW.status) NOT IN
     (('queued', 'running'), ('queued', 'succeeded'), ('queued', 'failed'),
      ('running', 'succeeded'), ('running', 'failed')) THEN
    RAISE EXCEPTION 'Transición de revisión no válida: % → %.', OLD.status, NEW.status;
  END IF;

  SELECT count(*) INTO hallazgos FROM content_findings WHERE analysis_run_id = OLD.id;
  IF NEW.status = 'succeeded' THEN
    IF hallazgos <> NEW.finding_count THEN
      RAISE EXCEPTION 'finding_count (%) debe coincidir con los hallazgos persistidos (%).', NEW.finding_count, hallazgos;
    END IF;
  ELSIF NEW.status = 'failed' THEN
    -- Todo-o-nada: un análisis fallido no deja ningún hallazgo.
    IF hallazgos <> 0 THEN
      RAISE EXCEPTION 'Un análisis fallido no puede tener hallazgos (todo-o-nada).';
    END IF;
  END IF;
  IF NEW.status IN ('succeeded', 'failed') THEN
    NEW.finished_at := COALESCE(NEW.finished_at, now());
    NEW.lease_expires_at := NULL;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER content_analysis_runs_integridad
  BEFORE INSERT OR UPDATE OR DELETE ON content_analysis_runs
  FOR EACH ROW EXECUTE FUNCTION content_analysis_runs_integridad();

-- ─────────────────────────── 4. Hallazgos ──────────────────────────────────────

-- Observación del análisis asistido. SIN estado ni resolución ni autor humano: es un dato inmutable que
-- informa (la decisión es de una persona). La descripción es texto del MODELO: dato no confiable, nunca
-- una instrucción.
CREATE TABLE content_findings (
  id                 uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id    uuid NOT NULL,
  campaign_id        uuid NOT NULL,
  script_version_id  uuid NOT NULL,
  analysis_run_id    uuid NOT NULL,
  -- 1-based tras ordenar (severidad desc, luego posición del modelo).
  ordinal            integer NOT NULL,
  model_position     integer NOT NULL,
  category           text NOT NULL,
  basis              text NOT NULL,
  -- La deriva el código (política versionada en el run); el modelo no la emite.
  severity           text NOT NULL,
  claim_status       text,
  description        text NOT NULL,
  language           text NOT NULL DEFAULT 'es',
  created_at         timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT content_findings_run_fkey
    FOREIGN KEY (analysis_run_id, script_version_id)
    REFERENCES content_analysis_runs (id, script_version_id) ON DELETE RESTRICT,
  CONSTRAINT content_findings_run_org_fkey
    FOREIGN KEY (analysis_run_id, organization_id)
    REFERENCES content_analysis_runs (id, organization_id) ON DELETE RESTRICT,
  CONSTRAINT content_findings_id_org_key UNIQUE (id, organization_id),
  CONSTRAINT content_findings_ordinal_key UNIQUE (analysis_run_id, ordinal),
  CONSTRAINT content_findings_ordinal_valido CHECK (ordinal >= 1 AND model_position >= 0),
  CONSTRAINT content_findings_categoria_valida CHECK (category IN (
    'cta_missing', 'key_message_incomplete', 'requirement_not_covered', 'claim_unsupported',
    'claim_contradicted', 'restriction_violated', 'brief_contradiction')),
  CONSTRAINT content_findings_base_valida CHECK (basis IN ('absence', 'partial', 'conflict')),
  CONSTRAINT content_findings_severidad_valida CHECK (severity IN ('baja', 'media', 'alta')),
  CONSTRAINT content_findings_claim_valido
    CHECK (claim_status IS NULL OR claim_status IN ('supported', 'unsupported', 'contradicted')),
  -- Matriz categoría ↔ base ↔ estado del claim (espejo de MATRIZ_DE_CATEGORIAS del dominio). Con IS [NOT]
  -- DISTINCT FROM: un claim_status NULL no puede hacer pasar el CHECK por «desconocido».
  CONSTRAINT content_findings_matriz CHECK (
    (category = 'cta_missing'             AND basis = 'absence'  AND claim_status IS NULL)
    OR (category = 'key_message_incomplete'  AND basis = 'partial'  AND claim_status IS NULL)
    OR (category = 'requirement_not_covered' AND basis = 'absence'  AND claim_status IS NULL)
    OR (category = 'claim_unsupported'       AND basis = 'absence'  AND claim_status IS NOT DISTINCT FROM 'unsupported')
    OR (category = 'claim_contradicted'      AND basis = 'conflict' AND claim_status IS NOT DISTINCT FROM 'contradicted')
    OR (category = 'restriction_violated'    AND basis = 'conflict' AND claim_status IS NULL)
    OR (category = 'brief_contradiction'     AND basis = 'conflict' AND claim_status IS NULL)
  ),
  CONSTRAINT content_findings_descripcion_valida
    CHECK (btrim(description) <> '' AND char_length(description) <= 400),
  CONSTRAINT content_findings_idioma_valido CHECK (language = 'es')
);

CREATE INDEX content_findings_version_idx ON content_findings (script_version_id);
CREATE INDEX content_findings_campana_idx ON content_findings (campaign_id);

-- Solo se inserta bajo un run ai_assisted `running` de la misma organización, campaña y versión.
CREATE OR REPLACE FUNCTION content_findings_integridad() RETURNS trigger AS $$
DECLARE
  r content_analysis_runs%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF inmutabilidad_bypass_activo() THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'content_findings es inmutable: no admite DELETE.';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'content_findings es inmutable: un hallazgo no se modifica.';
  END IF;
  SELECT * INTO r FROM content_analysis_runs WHERE id = NEW.analysis_run_id FOR SHARE;
  IF NOT FOUND OR r.kind <> 'ai_assisted' OR r.status <> 'running' THEN
    RAISE EXCEPTION 'Solo se insertan hallazgos bajo un análisis asistido en curso (running).';
  END IF;
  IF NEW.organization_id <> r.organization_id
     OR NEW.campaign_id <> r.campaign_id
     OR NEW.script_version_id <> r.script_version_id THEN
    RAISE EXCEPTION 'El hallazgo declara una organización, campaña o versión distintas de las de su análisis.';
  END IF;
  NEW.created_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER content_findings_integridad
  BEFORE INSERT OR UPDATE OR DELETE ON content_findings
  FOR EACH ROW EXECUTE FUNCTION content_findings_integridad();

-- ─────────────────────────── 5. Referencias al Brief ───────────────────────────

-- Qué requisito (campo/ítem) de la versión GOBERNANTE motiva el hallazgo. La evidencia y la fuente
-- original del Brief NO se copian: se leen del propio campo (inmutable una vez aprobado).
CREATE TABLE content_finding_brief_refs (
  id                uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id   uuid NOT NULL,
  finding_id        uuid NOT NULL,
  brief_field_id    uuid NOT NULL,
  brief_version_id  uuid NOT NULL,
  item_index        integer,
  field_key         text NOT NULL,
  criticidad        text NOT NULL,
  -- El valor que se le mandó al modelo, en una línea (vacío si el requisito no tenía valor).
  value_snippet     text NOT NULL DEFAULT '',
  created_at        timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT content_finding_brief_refs_finding_fkey
    FOREIGN KEY (finding_id, organization_id)
    REFERENCES content_findings (id, organization_id) ON DELETE RESTRICT,
  -- El campo es de la versión indicada (y el trigger exige que sea la gobernante del run).
  CONSTRAINT content_finding_brief_refs_campo_fkey
    FOREIGN KEY (brief_field_id, brief_version_id)
    REFERENCES brief_fields (id, brief_version_id) ON DELETE RESTRICT,
  CONSTRAINT content_finding_brief_refs_item_valido CHECK (item_index IS NULL OR item_index >= 0),
  CONSTRAINT content_finding_brief_refs_criticidad_valida CHECK (criticidad IN ('informativo', 'critico', 'claim')),
  CONSTRAINT content_finding_brief_refs_snippet_valido CHECK (char_length(value_snippet) <= 300),
  CONSTRAINT content_finding_brief_refs_clave_valida CHECK (btrim(field_key) <> '' AND char_length(field_key) <= 200)
);

CREATE UNIQUE INDEX content_finding_brief_refs_unica_key
  ON content_finding_brief_refs (finding_id, brief_field_id, COALESCE(item_index, -1));
CREATE INDEX content_finding_brief_refs_campo_idx ON content_finding_brief_refs (brief_field_id);

CREATE OR REPLACE FUNCTION content_finding_brief_refs_integridad() RETURNS trigger AS $$
DECLARE
  r     content_analysis_runs%ROWTYPE;
  f     content_findings%ROWTYPE;
  clave text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF inmutabilidad_bypass_activo() THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'content_finding_brief_refs es inmutable: no admite DELETE.';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'content_finding_brief_refs es inmutable: una referencia no se modifica.';
  END IF;
  SELECT * INTO f FROM content_findings WHERE id = NEW.finding_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'El hallazgo no existe.' USING ERRCODE = 'foreign_key_violation';
  END IF;
  SELECT * INTO r FROM content_analysis_runs WHERE id = f.analysis_run_id FOR SHARE;
  IF r.kind <> 'ai_assisted' OR r.status <> 'running' THEN
    RAISE EXCEPTION 'Solo se insertan referencias bajo un análisis asistido en curso (running).';
  END IF;
  IF NEW.organization_id <> f.organization_id THEN
    RAISE EXCEPTION 'La referencia declara una organización distinta de la de su hallazgo.';
  END IF;
  -- La referencia apunta SOLO a campos de la versión del Brief que gobierna el análisis.
  IF NEW.brief_version_id <> r.governing_brief_version_id THEN
    RAISE EXCEPTION 'La referencia debe apuntar a un campo de la versión del Brief gobernante del análisis.';
  END IF;
  SELECT key INTO clave FROM brief_fields WHERE id = NEW.brief_field_id AND brief_version_id = NEW.brief_version_id;
  IF clave IS DISTINCT FROM NEW.field_key THEN
    RAISE EXCEPTION 'La clave de campo declarada no es la del campo del Brief referenciado.';
  END IF;
  NEW.created_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER content_finding_brief_refs_integridad
  BEFORE INSERT OR UPDATE OR DELETE ON content_finding_brief_refs
  FOR EACH ROW EXECUTE FUNCTION content_finding_brief_refs_integridad();

-- ─────────────────────────── 6. Referencias al guion ───────────────────────────

-- Dónde, en el guion, está lo que motiva el hallazgo. Los fragmentos de un archivo son inestables (el
-- worker puede reprocesar), por eso NO hay FK a `source_fragments`: ordinal + cita + hashes (la cita se
-- verificó LITERAL contra el fragmento antes de guardarla).
CREATE TABLE content_finding_script_refs (
  id                 uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id    uuid NOT NULL,
  finding_id         uuid NOT NULL,
  source_id          uuid NOT NULL,
  fragment_ordinal   integer NOT NULL,
  -- Suave: puede dejar de existir si se reprocesa la fuente.
  fragment_id        uuid,
  locator            jsonb,
  quote              text NOT NULL,
  quote_sha256       text NOT NULL,
  fragment_text_hash text NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT content_finding_script_refs_finding_fkey
    FOREIGN KEY (finding_id, organization_id)
    REFERENCES content_findings (id, organization_id) ON DELETE RESTRICT,
  CONSTRAINT content_finding_script_refs_fuente_fkey
    FOREIGN KEY (source_id, organization_id)
    REFERENCES source_documents (id, organization_id) ON DELETE RESTRICT,
  CONSTRAINT content_finding_script_refs_ordinal_valido CHECK (fragment_ordinal >= 0),
  CONSTRAINT content_finding_script_refs_cita_valida CHECK (btrim(quote) <> '' AND char_length(quote) <= 500),
  CONSTRAINT content_finding_script_refs_hashes_validos
    CHECK (quote_sha256 ~ '^[0-9a-f]{64}$' AND fragment_text_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT content_finding_script_refs_localizador_valido
    CHECK (locator IS NULL OR source_locator_valido(locator)),
  CONSTRAINT content_finding_script_refs_unica_key UNIQUE (finding_id, fragment_ordinal, quote_sha256)
);

CREATE INDEX content_finding_script_refs_finding_idx ON content_finding_script_refs (finding_id);

CREATE OR REPLACE FUNCTION content_finding_script_refs_integridad() RETURNS trigger AS $$
DECLARE
  r content_analysis_runs%ROWTYPE;
  f content_findings%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF inmutabilidad_bypass_activo() THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'content_finding_script_refs es inmutable: no admite DELETE.';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'content_finding_script_refs es inmutable: una referencia no se modifica.';
  END IF;
  SELECT * INTO f FROM content_findings WHERE id = NEW.finding_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'El hallazgo no existe.' USING ERRCODE = 'foreign_key_violation';
  END IF;
  SELECT * INTO r FROM content_analysis_runs WHERE id = f.analysis_run_id FOR SHARE;
  IF r.kind <> 'ai_assisted' OR r.status <> 'running' THEN
    RAISE EXCEPTION 'Solo se insertan referencias bajo un análisis asistido en curso (running).';
  END IF;
  IF NEW.organization_id <> f.organization_id THEN
    RAISE EXCEPTION 'La referencia declara una organización distinta de la de su hallazgo.';
  END IF;
  -- La cita es del guion que se analizó (la fuente de la versión), no de otro documento.
  IF NEW.source_id <> r.script_source_id THEN
    RAISE EXCEPTION 'La referencia debe apuntar a la fuente del guion analizado.';
  END IF;
  NEW.created_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER content_finding_script_refs_integridad
  BEFORE INSERT OR UPDATE OR DELETE ON content_finding_script_refs
  FOR EACH ROW EXECUTE FUNCTION content_finding_script_refs_integridad();

-- ─────────────────────────── 7. Ledger de costo (ai_runs) ──────────────────────

-- `ai_runs` sigue siendo el registro posterior de UNA llamada al proveedor (también lo escribe el worker de
-- Python: la columna nueva es nullable y su INSERT no cambia). Un análisis = N llamadas = N filas con el
-- mismo `content_analysis_run_id`; el costo es SUM(cost_usd). Nunca el prompt ni la respuesta ni razonamiento.
-- (Calco de 021 · agent_run_id.)
ALTER TABLE ai_runs ADD COLUMN content_analysis_run_id uuid;

ALTER TABLE ai_runs
  ADD CONSTRAINT ai_runs_content_analysis_run_fkey
    FOREIGN KEY (content_analysis_run_id, organization_id)
    REFERENCES content_analysis_runs (id, organization_id) ON DELETE SET NULL (content_analysis_run_id);

CREATE INDEX ai_runs_content_analysis_run_idx
  ON ai_runs (content_analysis_run_id) WHERE content_analysis_run_id IS NOT NULL;

-- La llamada es de la MISMA campaña que su análisis (cuando ambos la declaran) y de la tarea del análisis.
CREATE OR REPLACE FUNCTION ai_runs_content_analysis_coherente() RETURNS trigger AS $$
DECLARE
  campana uuid;
BEGIN
  IF NEW.content_analysis_run_id IS NULL THEN RETURN NEW; END IF;
  SELECT campaign_id INTO campana FROM content_analysis_runs WHERE id = NEW.content_analysis_run_id;
  IF NEW.campaign_id IS NOT NULL AND campana IS NOT NULL AND NEW.campaign_id <> campana THEN
    RAISE EXCEPTION 'La llamada de IA declara una campaña distinta de la del análisis de contenido.';
  END IF;
  IF NEW.task <> 'analizar_guion' THEN
    RAISE EXCEPTION 'Solo una llamada de la tarea analizar_guion se enlaza a un análisis de contenido.';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER ai_runs_content_analysis
  BEFORE INSERT OR UPDATE OF content_analysis_run_id, campaign_id, task ON ai_runs
  FOR EACH ROW EXECUTE FUNCTION ai_runs_content_analysis_coherente();

-- ─────────────────────────── 8. Aprobación: la revisión que la habilitó ────────

-- `script_versions.approved_analysis_id` (uuid sin FK desde la 023) apunta a la REVISIÓN (ai_assisted o
-- human) que habilitó la aprobación. FK compuesta: la revisión es DE ESA versión. Con MATCH SIMPLE, una
-- versión sin aprobar (NULL) no se comprueba.
ALTER TABLE script_versions
  ADD CONSTRAINT script_versions_analisis_fkey
    FOREIGN KEY (approved_analysis_id, id)
    REFERENCES content_analysis_runs (id, script_version_id) ON DELETE RESTRICT;

-- Defensa en profundidad (no sustituye la regla del caso de uso de aprobación): la revisión citada terminó
-- bien y es contra el MISMO Brief con el que se aprueba. Se evalúa solo cuando se fija la columna.
CREATE OR REPLACE FUNCTION script_versions_analisis_aprobacion() RETURNS trigger AS $$
DECLARE
  r content_analysis_runs%ROWTYPE;
BEGIN
  IF inmutabilidad_bypass_activo() THEN RETURN NEW; END IF;
  IF NEW.approved_analysis_id IS NULL OR NEW.approved_analysis_id IS NOT DISTINCT FROM OLD.approved_analysis_id THEN
    RETURN NEW;
  END IF;
  SELECT * INTO r FROM content_analysis_runs WHERE id = NEW.approved_analysis_id;
  IF NOT FOUND OR r.status <> 'succeeded' THEN
    RAISE EXCEPTION 'La revisión citada para aprobar debe haber terminado bien (succeeded).';
  END IF;
  IF NEW.approved_brief_version_id IS NOT NULL AND r.governing_brief_version_id <> NEW.approved_brief_version_id THEN
    RAISE EXCEPTION 'La revisión citada para aprobar es contra otro Brief que el aprobado.';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER script_versions_analisis_aprobacion
  BEFORE UPDATE OF approved_analysis_id ON script_versions
  FOR EACH ROW EXECUTE FUNCTION script_versions_analisis_aprobacion();

COMMENT ON TABLE content_analysis_runs IS
  'Revisión de un guion contra el Brief aprobado vigente (ai_assisted o human). Nunca el prompt, la respuesta ni razonamiento: solo hashes y metadatos.';
COMMENT ON TABLE content_findings IS
  'Observaciones del análisis asistido: inmutables, sin estado ni resolución. La descripción es texto del modelo (dato no confiable).';
