-- 032 · KPIs de la participación (V2 · Fase 8, DEC-049): objetivos pactados y mediciones reales.
--
-- Forward-only y aditiva: dos tablas nuevas, sus funciones/triggers y nada más. No cambia ninguna fila, columna
-- ni restricción existente, y no usa las tablas 026–031 (salvo `operaciones_exigir_rol` de la 027, que YA admite
-- las capacidades `kpi_target` y `kpi_measure`: no se redefine).
--
--   campaign_influencers ─< kpi_targets        (objetivo pactado; reemplazo con supersedes_id)
--                        └─< kpi_measurements  (resultado real; INMUTABLE; corrección = fila nueva)
--
-- Principios impuestos AQUÍ (no solo en la aplicación):
--   · Todo cuelga de `campaign_influencers` con claves compuestas organización/campaña/participación y, si lo
--     hay, el entregable (que debe ser de ESA participación: lo vigila el trigger).
--   · Catálogo CERRADO de métricas y unidad por métrica: views, reach, impressions, likes, comments, shares,
--     saves, link_clicks (count) · engagement_rate (percent, en puntos 0–100) · other (unidad `other`, exige
--     etiqueta y NUNCA se compara). Sin métricas de costo. value ≥ 0; los `count` son enteros.
--   · OBJETIVO: `status active|superseded|retired`. Solo se escribe en campaña `activa` y con la participación
--     `activo` (una participación retirada conserva su historia pero no admite objetivos nuevos). Reemplazar =
--     fila nueva con `supersedes_id` (el trigger cierra la anterior; UN solo sucesor; mismo ámbito y métrica).
--     Un ÚNICO vigente por (participación, entregable|∅, métrica, etiqueta, unidad, plataforma|∅): los índices
--     únicos parciales tratan NULL como un valor. Retirar = marca (`retired_at`), nunca DELETE.
--   · MEDICIÓN: append-only (sin UPDATE; DELETE/TRUNCATE solo con el bypass de bases `_test`). Se registra en
--     campaña `activa` o `archivada` (nunca `cancelada`). Corregir = fila nueva con `supersedes_id` y
--     `correction_reason` obligatorio; UNA sola corrección por fila; la corregida debe ser del mismo ámbito,
--     métrica y unidad. La medición VIGENTE es la última observación no corregida (lo calcula la lectura).
--   · Idempotencia: UNIQUE (participación, clave) en ambas tablas; `request_hash` distingue el reintento
--     idéntico de la misma clave con otro contenido.
--   · Roles cerrados en la base (`operaciones_exigir_rol`: kpi_target = admin, director, consultor;
--     kpi_measure = admin, director, operativo), con paridad contra `roleCan` ya vigilada en la 027.
--   · Procedencia (`source_*`, `locator`, `import_batch_id`, `evidence_ref`) RESERVADA: nula por ahora (la
--     medición solo admite `source_kind = 'manual'`; la sugerencia del Sheet solo viaja en un objetivo cuyo
--     `origin = 'sheet_suggestion'`).
--   · Sin columna de visibilidad ni acceso `cliente` (la proyección a TCL es F9). Sin DELETE ni TRUNCATE.

-- ─────────────────────────── 1. Objetivos ──────────────────────────────────────

CREATE TABLE kpi_targets (
  id                      uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id         uuid NOT NULL,
  campaign_id             uuid NOT NULL,
  campaign_influencer_id  uuid NOT NULL,
  -- Ámbito: la participación entera (NULL) o UN entregable suyo.
  deliverable_id          uuid,
  -- Plataforma del ámbito (NULL = sin plataforma). `text + CHECK`, no ENUM: la usan los índices únicos.
  platform                text,
  metric                  text NOT NULL,
  -- Etiqueta de la métrica `other` (y SOLO de ella).
  other_label             text,
  unit                    text NOT NULL,
  target_value            numeric(18,4) NOT NULL,
  comparator              text NOT NULL DEFAULT 'gte',
  period_start            date,
  period_end              date,
  -- active (vigente) · superseded (tiene sucesor) · retired (retirado por una persona).
  status                  text NOT NULL DEFAULT 'active',
  supersedes_id           uuid,
  superseded_at           timestamptz,
  retired_at              timestamptz,
  retired_by              uuid,
  -- manual · sheet_suggestion (el texto del Sheet fue SUGERENCIA; una persona fijó el valor).
  origin                  text NOT NULL DEFAULT 'manual',
  source_snapshot_id      uuid,
  source_locator          jsonb,
  source_text_hash        text,
  origin_channel          text NOT NULL DEFAULT 'ui',
  idempotency_key         text NOT NULL,
  request_hash            text NOT NULL,
  created_by              uuid NOT NULL,
  created_at              timestamptz NOT NULL DEFAULT now(),
  -- Orden estable de las filas (desempate de las lecturas).
  seq                     bigint GENERATED ALWAYS AS IDENTITY,

  CONSTRAINT kpi_targets_campaign_fkey
    FOREIGN KEY (campaign_id, organization_id)
    REFERENCES campaigns (id, organization_id) ON DELETE RESTRICT,
  CONSTRAINT kpi_targets_participacion_fkey
    FOREIGN KEY (campaign_influencer_id, campaign_id)
    REFERENCES campaign_influencers (id, campaign_id) ON DELETE RESTRICT,
  -- El entregable es de ESTA campaña y organización (que además sea de ESTA participación lo vigila el trigger).
  CONSTRAINT kpi_targets_entregable_fkey
    FOREIGN KEY (deliverable_id, organization_id, campaign_id)
    REFERENCES deliverables (id, organization_id, campaign_id) ON DELETE RESTRICT,
  CONSTRAINT kpi_targets_autor_fkey
    FOREIGN KEY (created_by, organization_id)
    REFERENCES users (id, organization_id) ON DELETE RESTRICT,
  CONSTRAINT kpi_targets_retiro_autor_fkey
    FOREIGN KEY (retired_by, organization_id)
    REFERENCES users (id, organization_id) ON DELETE RESTRICT,
  CONSTRAINT kpi_targets_snapshot_fkey
    FOREIGN KEY (source_snapshot_id, organization_id)
    REFERENCES source_snapshots (id, organization_id) ON DELETE RESTRICT,
  CONSTRAINT kpi_targets_id_scope_key UNIQUE (id, organization_id, campaign_id),
  -- Reemplazo: NO ACTION (se evalúa al final de la sentencia), para que limpiar una campaña de prueba
  -- borre la cadena completa en una sola sentencia.
  CONSTRAINT kpi_targets_reemplaza_fkey
    FOREIGN KEY (supersedes_id, organization_id, campaign_id)
    REFERENCES kpi_targets (id, organization_id, campaign_id),
  CONSTRAINT kpi_targets_clave_key UNIQUE (campaign_influencer_id, idempotency_key),

  CONSTRAINT kpi_targets_plataforma_valida
    CHECK (platform IS NULL OR platform IN ('instagram', 'tiktok', 'youtube', 'x', 'facebook', 'twitch')),
  CONSTRAINT kpi_targets_metrica_valida CHECK (
    metric IN ('views', 'reach', 'impressions', 'likes', 'comments', 'shares', 'saves', 'link_clicks',
               'engagement_rate', 'other')
  ),
  -- La unidad la fija la métrica: una unidad distinta no existe (la lectura aun así compara con cautela).
  CONSTRAINT kpi_targets_unidad_por_metrica CHECK (
    (metric IN ('views', 'reach', 'impressions', 'likes', 'comments', 'shares', 'saves', 'link_clicks')
       AND unit = 'count')
    OR (metric = 'engagement_rate' AND unit = 'percent')
    OR (metric = 'other' AND unit = 'other')
  ),
  CONSTRAINT kpi_targets_etiqueta_por_metrica CHECK (
    (metric = 'other') = (other_label IS NOT NULL)
  ),
  CONSTRAINT kpi_targets_etiqueta_valida CHECK (
    other_label IS NULL
    OR (other_label = btrim(other_label) AND other_label <> '' AND char_length(other_label) <= 80
        AND other_label !~ '[[:cntrl:]]')
  ),
  CONSTRAINT kpi_targets_valor_valido CHECK (
    target_value >= 0
    AND (metric <> 'engagement_rate' OR target_value <= 100)
    AND (unit <> 'count' OR target_value = trunc(target_value))
  ),
  CONSTRAINT kpi_targets_comparador_valido CHECK (comparator IN ('gte', 'lte')),
  CONSTRAINT kpi_targets_periodo_valido CHECK (period_start IS NULL OR period_end IS NULL OR period_end >= period_start),
  CONSTRAINT kpi_targets_estado_valido CHECK (status IN ('active', 'superseded', 'retired')),
  CONSTRAINT kpi_targets_cierre_coherente CHECK (
    ((status = 'superseded') = (superseded_at IS NOT NULL))
    AND ((status = 'retired') = (retired_at IS NOT NULL AND retired_by IS NOT NULL))
    AND (status = 'retired' OR (retired_at IS NULL AND retired_by IS NULL))
  ),
  CONSTRAINT kpi_targets_no_se_reemplaza_a_si_mismo CHECK (supersedes_id IS NULL OR supersedes_id <> id),
  CONSTRAINT kpi_targets_origen_valido CHECK (origin IN ('manual', 'sheet_suggestion')),
  -- La procedencia del Sheet va completa o no va; un objetivo manual no la lleva.
  CONSTRAINT kpi_targets_procedencia_coherente CHECK (
    (origin = 'sheet_suggestion'
       AND source_snapshot_id IS NOT NULL AND source_locator IS NOT NULL AND source_text_hash IS NOT NULL
       AND source_text_hash ~ '^[0-9a-f]{64}$')
    OR (origin = 'manual'
       AND source_snapshot_id IS NULL AND source_locator IS NULL AND source_text_hash IS NULL)
  ),
  CONSTRAINT kpi_targets_canal_valido CHECK (origin_channel IN ('ui', 'chat')),
  CONSTRAINT kpi_targets_clave_valida CHECK (
    idempotency_key = btrim(idempotency_key) AND idempotency_key <> '' AND char_length(idempotency_key) <= 200
  ),
  CONSTRAINT kpi_targets_huella_valida CHECK (request_hash ~ '^[0-9a-f]{64}$')
);

-- UN solo sucesor por objetivo.
CREATE UNIQUE INDEX kpi_targets_sucesor_key ON kpi_targets (supersedes_id) WHERE supersedes_id IS NOT NULL;

-- UN solo vigente por ámbito y métrica. NULL cuenta como un valor (uuid nulo / cadena vacía).
CREATE UNIQUE INDEX kpi_targets_vigente_key ON kpi_targets (
  campaign_influencer_id,
  COALESCE(deliverable_id, '00000000-0000-0000-0000-000000000000'::uuid),
  metric,
  COALESCE(lower(other_label), ''),
  unit,
  COALESCE(platform, '')
) WHERE status = 'active';

CREATE INDEX kpi_targets_participacion_idx ON kpi_targets (campaign_influencer_id, status);
CREATE INDEX kpi_targets_campaign_idx ON kpi_targets (campaign_id, status);

CREATE OR REPLACE FUNCTION kpi_targets_integridad() RETURNS trigger AS $$
DECLARE
  c_estado   text;
  ci_estado  text;
  d_estado   text;
  previo     kpi_targets%ROWTYPE;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'active' OR NEW.superseded_at IS NOT NULL OR NEW.retired_at IS NOT NULL THEN
      RAISE EXCEPTION 'Un objetivo de KPI nace vigente.';
    END IF;
    PERFORM operaciones_exigir_rol(NEW.created_by, 'kpi_target');
    -- FOR SHARE: archivar la campaña o retirar a la persona espera a que este alta termine.
    SELECT status::text INTO c_estado  FROM campaigns WHERE id = NEW.campaign_id FOR SHARE;
    SELECT status::text INTO ci_estado FROM campaign_influencers WHERE id = NEW.campaign_influencer_id FOR SHARE;
    IF c_estado IS DISTINCT FROM 'activa' THEN
      RAISE EXCEPTION 'La campaña debe estar activa para fijar o reemplazar un objetivo de KPI.';
    END IF;
    IF ci_estado IS DISTINCT FROM 'activo' THEN
      RAISE EXCEPTION 'El influencer debe estar activo en la campaña para fijar o reemplazar un objetivo de KPI.';
    END IF;
    IF NEW.deliverable_id IS NOT NULL THEN
      SELECT status INTO d_estado FROM deliverables
       WHERE id = NEW.deliverable_id AND campaign_influencer_id = NEW.campaign_influencer_id FOR SHARE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'El entregable del objetivo no pertenece a esta participación.';
      END IF;
      IF d_estado <> 'active' THEN
        RAISE EXCEPTION 'El entregable del objetivo está archivado.';
      END IF;
    END IF;
    IF NEW.source_snapshot_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM source_snapshots n JOIN source_documents d ON d.id = n.source_id
       WHERE n.id = NEW.source_snapshot_id AND d.campaign_id = NEW.campaign_id
         AND d.organization_id = NEW.organization_id
    ) THEN
      RAISE EXCEPTION 'La lectura (snapshot) de la sugerencia no es de una fuente de esta campaña.';
    END IF;
    IF NEW.supersedes_id IS NOT NULL THEN
      SELECT * INTO previo FROM kpi_targets WHERE id = NEW.supersedes_id FOR UPDATE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'El objetivo que se reemplaza no existe.';
      END IF;
      IF previo.status <> 'active' THEN
        RAISE EXCEPTION 'El objetivo que se reemplaza ya no está vigente (ya fue reemplazado o retirado).';
      END IF;
      IF (previo.campaign_influencer_id, previo.deliverable_id, previo.platform, previo.metric, previo.other_label, previo.unit)
         IS DISTINCT FROM
         (NEW.campaign_influencer_id, NEW.deliverable_id, NEW.platform, NEW.metric, NEW.other_label, NEW.unit) THEN
        RAISE EXCEPTION 'Un reemplazo conserva el ámbito, la métrica y la unidad del objetivo que reemplaza.';
      END IF;
      -- Cierra el anterior ANTES de insertar este (el índice único solo admite un vigente).
      UPDATE kpi_targets SET status = 'superseded' WHERE id = previo.id;
    END IF;
    RETURN NEW;
  END IF;

  -- UPDATE: solo se cierra un objetivo vigente (reemplazado o retirado); nada más cambia.
  IF (NEW.id, NEW.organization_id, NEW.campaign_id, NEW.campaign_influencer_id, NEW.deliverable_id, NEW.platform,
      NEW.metric, NEW.other_label, NEW.unit, NEW.target_value, NEW.comparator, NEW.period_start, NEW.period_end,
      NEW.supersedes_id, NEW.origin, NEW.source_snapshot_id, NEW.source_locator, NEW.source_text_hash,
      NEW.origin_channel, NEW.idempotency_key, NEW.request_hash, NEW.created_by, NEW.created_at, NEW.seq)
     IS DISTINCT FROM
     (OLD.id, OLD.organization_id, OLD.campaign_id, OLD.campaign_influencer_id, OLD.deliverable_id, OLD.platform,
      OLD.metric, OLD.other_label, OLD.unit, OLD.target_value, OLD.comparator, OLD.period_start, OLD.period_end,
      OLD.supersedes_id, OLD.origin, OLD.source_snapshot_id, OLD.source_locator, OLD.source_text_hash,
      OLD.origin_channel, OLD.idempotency_key, OLD.request_hash, OLD.created_by, OLD.created_at, OLD.seq) THEN
    RAISE EXCEPTION 'Un objetivo de KPI no se edita: se reemplaza con uno nuevo (supersedes_id).';
  END IF;
  IF OLD.status <> 'active' THEN
    RAISE EXCEPTION 'Un objetivo reemplazado o retirado es histórico: no admite cambios.';
  END IF;
  IF NEW.status = 'superseded' THEN
    IF NEW.retired_at IS NOT NULL OR NEW.retired_by IS NOT NULL THEN
      RAISE EXCEPTION 'Un objetivo reemplazado no lleva marcas de retiro.';
    END IF;
    NEW.superseded_at := now();
  ELSIF NEW.status = 'retired' THEN
    PERFORM operaciones_exigir_rol(NEW.retired_by, 'kpi_target');
    SELECT status::text INTO c_estado FROM campaigns WHERE id = NEW.campaign_id FOR SHARE;
    IF c_estado IS DISTINCT FROM 'activa' THEN
      RAISE EXCEPTION 'La campaña debe estar activa para retirar un objetivo de KPI.';
    END IF;
    NEW.retired_at := now();
  ELSE
    RAISE EXCEPTION 'Un objetivo vigente solo pasa a reemplazado (con sucesor) o a retirado.';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER kpi_targets_integridad
  BEFORE INSERT OR UPDATE ON kpi_targets
  FOR EACH ROW EXECUTE FUNCTION kpi_targets_integridad();
CREATE TRIGGER kpi_targets_sin_delete
  BEFORE DELETE ON kpi_targets FOR EACH ROW EXECUTE FUNCTION operaciones_sin_delete();
CREATE TRIGGER kpi_targets_sin_truncate
  BEFORE TRUNCATE ON kpi_targets FOR EACH STATEMENT EXECUTE FUNCTION operaciones_sin_truncate();

-- Invariante DIFERIDO: un objetivo `superseded` tiene su sucesor; uno `active` no lo tiene.
CREATE OR REPLACE FUNCTION kpi_targets_sucesor_coherente() RETURNS trigger AS $$
DECLARE
  tiene_sucesor boolean;
BEGIN
  SELECT EXISTS (SELECT 1 FROM kpi_targets s WHERE s.supersedes_id = NEW.id) INTO tiene_sucesor;
  IF NEW.status = 'superseded' AND NOT tiene_sucesor THEN
    RAISE EXCEPTION 'Un objetivo de KPI solo se marca reemplazado al registrar su sucesor.';
  END IF;
  IF NEW.status <> 'superseded' AND tiene_sucesor THEN
    RAISE EXCEPTION 'Un objetivo con sucesor debe constar como reemplazado.';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER kpi_targets_sucesor_coherente
  AFTER INSERT OR UPDATE ON kpi_targets
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION kpi_targets_sucesor_coherente();

-- ─────────────────────────── 2. Mediciones (append-only) ───────────────────────

CREATE TABLE kpi_measurements (
  id                      uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id         uuid NOT NULL,
  campaign_id             uuid NOT NULL,
  campaign_influencer_id  uuid NOT NULL,
  deliverable_id          uuid,
  platform                text,
  metric                  text NOT NULL,
  other_label             text,
  unit                    text NOT NULL,
  value                   numeric(18,4) NOT NULL,
  -- Cuándo se OBSERVÓ el resultado (la vigente es la última observación no corregida).
  observed_at             timestamptz NOT NULL,
  period_start            date,
  period_end              date,
  -- Reservado: csv_import / sheet_import / api. Por ahora solo `manual` (restricción aparte, fácil de relajar).
  source_kind             text NOT NULL DEFAULT 'manual',
  source_id               uuid,
  locator                 jsonb,
  import_batch_id         uuid,
  evidence_ref            text,
  recorded_by             uuid NOT NULL,
  recorded_at             timestamptz NOT NULL DEFAULT now(),
  -- MVP: solo `ui`. El chat nunca registra resultados.
  origin_channel          text NOT NULL DEFAULT 'ui',
  idempotency_key         text NOT NULL,
  request_hash            text NOT NULL,
  supersedes_id           uuid,
  correction_reason       text,
  seq                     bigint GENERATED ALWAYS AS IDENTITY,

  CONSTRAINT kpi_measurements_campaign_fkey
    FOREIGN KEY (campaign_id, organization_id)
    REFERENCES campaigns (id, organization_id) ON DELETE RESTRICT,
  CONSTRAINT kpi_measurements_participacion_fkey
    FOREIGN KEY (campaign_influencer_id, campaign_id)
    REFERENCES campaign_influencers (id, campaign_id) ON DELETE RESTRICT,
  CONSTRAINT kpi_measurements_entregable_fkey
    FOREIGN KEY (deliverable_id, organization_id, campaign_id)
    REFERENCES deliverables (id, organization_id, campaign_id) ON DELETE RESTRICT,
  CONSTRAINT kpi_measurements_autor_fkey
    FOREIGN KEY (recorded_by, organization_id)
    REFERENCES users (id, organization_id) ON DELETE RESTRICT,
  CONSTRAINT kpi_measurements_fuente_fkey
    FOREIGN KEY (source_id, organization_id)
    REFERENCES source_documents (id, organization_id) ON DELETE RESTRICT,
  CONSTRAINT kpi_measurements_id_scope_key UNIQUE (id, organization_id, campaign_id),
  CONSTRAINT kpi_measurements_corrige_fkey
    FOREIGN KEY (supersedes_id, organization_id, campaign_id)
    REFERENCES kpi_measurements (id, organization_id, campaign_id),
  CONSTRAINT kpi_measurements_clave_key UNIQUE (campaign_influencer_id, idempotency_key),

  CONSTRAINT kpi_measurements_plataforma_valida
    CHECK (platform IS NULL OR platform IN ('instagram', 'tiktok', 'youtube', 'x', 'facebook', 'twitch')),
  CONSTRAINT kpi_measurements_metrica_valida CHECK (
    metric IN ('views', 'reach', 'impressions', 'likes', 'comments', 'shares', 'saves', 'link_clicks',
               'engagement_rate', 'other')
  ),
  CONSTRAINT kpi_measurements_unidad_por_metrica CHECK (
    (metric IN ('views', 'reach', 'impressions', 'likes', 'comments', 'shares', 'saves', 'link_clicks')
       AND unit = 'count')
    OR (metric = 'engagement_rate' AND unit = 'percent')
    OR (metric = 'other' AND unit = 'other')
  ),
  CONSTRAINT kpi_measurements_etiqueta_por_metrica CHECK ((metric = 'other') = (other_label IS NOT NULL)),
  CONSTRAINT kpi_measurements_etiqueta_valida CHECK (
    other_label IS NULL
    OR (other_label = btrim(other_label) AND other_label <> '' AND char_length(other_label) <= 80
        AND other_label !~ '[[:cntrl:]]')
  ),
  CONSTRAINT kpi_measurements_valor_valido CHECK (
    value >= 0
    AND (metric <> 'engagement_rate' OR value <= 100)
    AND (unit <> 'count' OR value = trunc(value))
  ),
  CONSTRAINT kpi_measurements_periodo_valido CHECK (period_start IS NULL OR period_end IS NULL OR period_end >= period_start),
  CONSTRAINT kpi_measurements_tipo_de_fuente_valido CHECK (source_kind IN ('manual', 'csv_import', 'sheet_import', 'api')),
  -- Por ahora solo se registra a mano y SIN procedencia estructurada (F8 difiere la importación).
  CONSTRAINT kpi_measurements_solo_manual CHECK (
    source_kind = 'manual'
    AND source_id IS NULL AND locator IS NULL AND import_batch_id IS NULL AND evidence_ref IS NULL
  ),
  CONSTRAINT kpi_measurements_canal_valido CHECK (origin_channel = 'ui'),
  CONSTRAINT kpi_measurements_clave_valida CHECK (
    idempotency_key = btrim(idempotency_key) AND idempotency_key <> '' AND char_length(idempotency_key) <= 200
  ),
  CONSTRAINT kpi_measurements_huella_valida CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT kpi_measurements_no_se_corrige_a_si_misma CHECK (supersedes_id IS NULL OR supersedes_id <> id),
  -- Corregir = fila nueva con su motivo; una medición original NO lleva motivo.
  CONSTRAINT kpi_measurements_motivo_coherente CHECK (
    (supersedes_id IS NULL AND correction_reason IS NULL)
    OR (supersedes_id IS NOT NULL AND correction_reason IS NOT NULL
        AND correction_reason = btrim(correction_reason) AND correction_reason <> ''
        AND char_length(correction_reason) <= 500)
  )
);

-- UNA sola corrección por medición.
CREATE UNIQUE INDEX kpi_measurements_correccion_key ON kpi_measurements (supersedes_id) WHERE supersedes_id IS NOT NULL;
CREATE INDEX kpi_measurements_participacion_idx
  ON kpi_measurements (campaign_influencer_id, metric, observed_at DESC, seq DESC);
CREATE INDEX kpi_measurements_campaign_idx ON kpi_measurements (campaign_id);

CREATE OR REPLACE FUNCTION kpi_measurements_integridad() RETURNS trigger AS $$
DECLARE
  c_estado   text;
  previa     kpi_measurements%ROWTYPE;
BEGIN
  PERFORM operaciones_exigir_rol(NEW.recorded_by, 'kpi_measure');
  -- FOR SHARE: archivar/cancelar la campaña espera a que este alta termine. Archivada admite mediciones.
  SELECT status::text INTO c_estado FROM campaigns WHERE id = NEW.campaign_id FOR SHARE;
  IF c_estado IS NULL OR c_estado NOT IN ('activa', 'archivada') THEN
    RAISE EXCEPTION 'La campaña debe estar activa o archivada para registrar una medición de KPI (no cancelada).';
  END IF;
  -- La participación (retirada o no) conserva su historia: se bloquea para serializar con su retiro.
  PERFORM 1 FROM campaign_influencers WHERE id = NEW.campaign_influencer_id FOR SHARE;
  IF NEW.deliverable_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM deliverables
     WHERE id = NEW.deliverable_id AND campaign_influencer_id = NEW.campaign_influencer_id
  ) THEN
    RAISE EXCEPTION 'El entregable de la medición no pertenece a esta participación.';
  END IF;
  IF NEW.supersedes_id IS NOT NULL THEN
    SELECT * INTO previa FROM kpi_measurements WHERE id = NEW.supersedes_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'La medición que se corrige no existe.';
    END IF;
    IF (previa.campaign_influencer_id, previa.deliverable_id, previa.platform, previa.metric, previa.other_label, previa.unit)
       IS DISTINCT FROM
       (NEW.campaign_influencer_id, NEW.deliverable_id, NEW.platform, NEW.metric, NEW.other_label, NEW.unit) THEN
      RAISE EXCEPTION 'Una corrección conserva el ámbito, la métrica y la unidad de la medición que corrige.';
    END IF;
    IF EXISTS (SELECT 1 FROM kpi_measurements k WHERE k.supersedes_id = NEW.supersedes_id) THEN
      RAISE EXCEPTION 'La medición ya fue corregida (una sola corrección por medición).';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER kpi_measurements_integridad
  BEFORE INSERT ON kpi_measurements
  FOR EACH ROW EXECUTE FUNCTION kpi_measurements_integridad();
-- Append-only: ningún UPDATE (tampoco en pruebas). DELETE/TRUNCATE solo con el bypass de bases `_test`.
CREATE TRIGGER kpi_measurements_sin_update
  BEFORE UPDATE ON kpi_measurements FOR EACH ROW EXECUTE FUNCTION operaciones_sin_update();
CREATE TRIGGER kpi_measurements_sin_delete
  BEFORE DELETE ON kpi_measurements FOR EACH ROW EXECUTE FUNCTION operaciones_sin_delete();
CREATE TRIGGER kpi_measurements_sin_truncate
  BEFORE TRUNCATE ON kpi_measurements FOR EACH STATEMENT EXECUTE FUNCTION operaciones_sin_truncate();
