-- 018 · Fuentes enlazadas, localizador generalizado y representación normalizada
-- (V2 · Fase 4).
--
-- Forward-only y aditiva. No reescribe ningún dato histórico: las fuentes y los
-- fragmentos existentes conservan todas sus columnas; la evidencia existente no
-- se toca (la de versiones aprobadas está congelada, migración 009).
--
-- ── Modelo de fuente ───────────────────────────────────────────────────────────
-- `source_documents` sigue siendo LA entidad de fuente (campaña, organización,
-- visibilidad, confidencialidad, estado, tipo declarado). Gana un discriminador
-- de origen: `file` (archivo subido, como hasta ahora) o `link` (enlace
-- externo). Una restricción CHECK impone qué columnas existen en cada origen, de
-- modo que un archivo sigue exigiendo hash/tamaño/MIME y un enlace no puede
-- llevarlos. Se descartó una entidad superior `sources`: obligaría a migrar las
-- FK de evidencia, trabajos y fragmentos (varias con inmutabilidad) sin ningún
-- beneficio presente, y duplicaría la visibilidad y los permisos.
--
-- ── Localizador ────────────────────────────────────────────────────────────────
-- `locator` (jsonb) es el contrato único de ubicación en la fuente: página,
-- diapositiva, sección, hoja, fila, celda, rango o región. Las columnas legacy
-- (page, slide, section, linea) siguen existiendo y siguen siendo lo que
-- escriben los parsers de PDF/PPTX/DOCX/MD; un trigger deriva `locator` de ellas
-- cuando no se informa. `source_locator_valido()` es la validación de la base;
-- su espejo es `validarLocalizador` en `packages/domain`.

-- ─────────────────────────── Origen de la fuente ───────────────────────────────

CREATE TYPE source_origin AS ENUM ('file', 'link');

ALTER TABLE source_documents
  ADD COLUMN origin             source_origin NOT NULL DEFAULT 'file',
  -- Solo enlaces: proveedor reconocido, identificador estable del recurso en el
  -- proveedor, URL tal como se registró y URL canónica (clave de deduplicación).
  ADD COLUMN external_provider  text,
  ADD COLUMN external_id        text,
  ADD COLUMN external_url       text,
  ADD COLUMN canonical_url      text,
  ADD COLUMN external_metadata  jsonb NOT NULL DEFAULT '{}'::jsonb;

-- Un enlace no tiene archivo local: estas columnas dejan de ser obligatorias
-- para TODA fuente, y la restricción de más abajo las exige para los archivos.
ALTER TABLE source_documents ALTER COLUMN file_id DROP NOT NULL;
ALTER TABLE source_documents ALTER COLUMN mime_type DROP NOT NULL;
ALTER TABLE source_documents ALTER COLUMN size_bytes DROP NOT NULL;
ALTER TABLE source_documents ALTER COLUMN hash DROP NOT NULL;

ALTER TABLE source_documents
  ADD CONSTRAINT source_documents_origen_coherente CHECK (
    (origin = 'file'
       AND file_id IS NOT NULL AND mime_type IS NOT NULL
       AND size_bytes IS NOT NULL AND hash IS NOT NULL
       AND external_provider IS NULL AND external_id IS NULL
       AND external_url IS NULL AND canonical_url IS NULL)
    OR
    (origin = 'link'
       AND external_provider IS NOT NULL AND external_id IS NOT NULL
       AND external_url IS NOT NULL AND canonical_url IS NOT NULL
       AND file_id IS NULL AND mime_type IS NULL
       AND size_bytes IS NULL AND hash IS NULL)
  ),
  ADD CONSTRAINT source_documents_proveedor_conocido CHECK (
    external_provider IS NULL OR external_provider IN
      ('google_sheets', 'google_docs', 'google_slides', 'google_drive_file', 'google_drive_folder')
  ),
  ADD CONSTRAINT source_documents_url_https CHECK (
    (external_url IS NULL OR external_url ~ '^https://')
    AND (canonical_url IS NULL OR canonical_url ~ '^https://')
  ),
  ADD CONSTRAINT source_documents_metadata_objeto CHECK (jsonb_typeof(external_metadata) = 'object'),
  -- `por_resolver` es solo de enlaces; un enlace nunca está `pendiente` (no hay job).
  ADD CONSTRAINT source_documents_estado_por_origen CHECK (
    (origin = 'link' AND status <> 'pendiente') OR (origin = 'file' AND status <> 'por_resolver')
  );

-- El mismo enlace (misma URL canónica) no se registra dos veces en la campaña.
-- La canónica solo descarta lo que no cambia el recurso; dos pestañas distintas
-- de un libro (`gid`) siguen siendo enlaces distintos.
CREATE UNIQUE INDEX source_documents_canonical_campaign_key
  ON source_documents (campaign_id, canonical_url)
  WHERE origin = 'link';

-- Nada procesa un enlace todavía: no se «inventa» procesamiento de URLs. La
-- Fase 5 levantará esta guarda cuando exista una integración que lo resuelva.
CREATE OR REPLACE FUNCTION processing_jobs_solo_archivos() RETURNS trigger AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM source_documents WHERE id = NEW.source_id AND origin <> 'file') THEN
    RAISE EXCEPTION 'No hay procesamiento para fuentes enlazadas todavía (se resuelven mediante una integración).';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER processing_jobs_solo_archivos
  BEFORE INSERT ON processing_jobs
  FOR EACH ROW EXECUTE FUNCTION processing_jobs_solo_archivos();

-- ─────────────────────────── Localizador: validación ───────────────────────────

-- Entero positivo (≤ maximo). Acepta el entero tal cual lo serializa JSON.
CREATE OR REPLACE FUNCTION sl_entero(v jsonb, maximo bigint) RETURNS boolean AS $$
  SELECT v IS NOT NULL
     AND jsonb_typeof(v) = 'number'
     AND v::text ~ '^[1-9][0-9]{0,15}$'
     AND (v::text)::bigint <= maximo;
$$ LANGUAGE sql IMMUTABLE;

CREATE OR REPLACE FUNCTION sl_entero_opc(v jsonb, maximo bigint) RETURNS boolean AS $$
  SELECT v IS NULL OR jsonb_typeof(v) = 'null' OR sl_entero(v, maximo);
$$ LANGUAGE sql IMMUTABLE;

CREATE OR REPLACE FUNCTION sl_texto(v jsonb, maximo integer) RETURNS boolean AS $$
  SELECT v IS NOT NULL
     AND jsonb_typeof(v) = 'string'
     AND btrim(v #>> '{}') <> ''
     AND char_length(v #>> '{}') <= maximo;
$$ LANGUAGE sql IMMUTABLE;

CREATE OR REPLACE FUNCTION sl_texto_opc(v jsonb, maximo integer) RETURNS boolean AS $$
  SELECT v IS NULL OR jsonb_typeof(v) = 'null' OR sl_texto(v, maximo);
$$ LANGUAGE sql IMMUTABLE;

-- Fracción 0..1 (coordenadas normalizadas de una región).
CREATE OR REPLACE FUNCTION sl_fraccion(v jsonb) RETURNS boolean AS $$
  SELECT v IS NOT NULL
     AND jsonb_typeof(v) = 'number'
     AND (v::text)::numeric BETWEEN 0 AND 1;
$$ LANGUAGE sql IMMUTABLE;

-- Columna 1-based → letras (1 → A, 27 → AA).
CREATE OR REPLACE FUNCTION sl_columna_a_letras(col integer) RETURNS text AS $$
DECLARE
  n integer := col;
  letras text := '';
BEGIN
  IF col IS NULL OR col < 1 THEN RETURN NULL; END IF;
  WHILE n > 0 LOOP
    letras := chr(65 + ((n - 1) % 26)) || letras;
    n := (n - 1) / 26;
  END LOOP;
  RETURN letras;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- Contrato único del localizador (espejo de `validarLocalizador`, packages/domain).
CREATE OR REPLACE FUNCTION source_locator_valido(l jsonb) RETURNS boolean AS $$
DECLARE
  kind text;
  permitidas text[];
  clave text;
  max_fila CONSTANT bigint := 1048576;
  max_col  CONSTANT bigint := 16384;
BEGIN
  IF l IS NULL OR jsonb_typeof(l) <> 'object' THEN RETURN false; END IF;
  kind := l->>'kind';
  permitidas := CASE kind
    WHEN 'page'    THEN ARRAY['kind', 'page', 'section', 'line']
    WHEN 'slide'   THEN ARRAY['kind', 'slide', 'section']
    WHEN 'section' THEN ARRAY['kind', 'section', 'line']
    WHEN 'sheet'   THEN ARRAY['kind', 'sheet']
    WHEN 'row'     THEN ARRAY['kind', 'sheet', 'row']
    WHEN 'cell'    THEN ARRAY['kind', 'sheet', 'cell', 'row', 'col']
    WHEN 'range'   THEN ARRAY['kind', 'sheet', 'range', 'rowStart', 'rowEnd', 'colStart', 'colEnd']
    WHEN 'region'  THEN ARRAY['kind', 'page', 'slide', 'x', 'y', 'width', 'height']
    ELSE NULL
  END;
  IF permitidas IS NULL THEN RETURN false; END IF;

  FOR clave IN SELECT jsonb_object_keys(l) LOOP
    IF NOT (clave = ANY (permitidas)) THEN RETURN false; END IF;
  END LOOP;

  CASE kind
    WHEN 'page' THEN
      RETURN sl_entero(l->'page', 9007199254740991) AND sl_texto_opc(l->'section', 4000)
         AND sl_entero_opc(l->'line', 9007199254740991);
    WHEN 'slide' THEN
      RETURN sl_entero(l->'slide', 9007199254740991) AND sl_texto_opc(l->'section', 4000);
    WHEN 'section' THEN
      RETURN sl_texto(l->'section', 4000) AND sl_entero_opc(l->'line', 9007199254740991);
    WHEN 'sheet' THEN
      RETURN sl_texto(l->'sheet', 255);
    WHEN 'row' THEN
      RETURN sl_texto(l->'sheet', 255) AND sl_entero(l->'row', max_fila);
    WHEN 'cell' THEN
      RETURN sl_texto(l->'sheet', 255)
         AND sl_entero(l->'row', max_fila) AND sl_entero(l->'col', max_col)
         AND l->>'cell' = sl_columna_a_letras((l->>'col')::integer) || (l->>'row');
    WHEN 'range' THEN
      RETURN sl_texto(l->'sheet', 255)
         AND sl_entero(l->'rowStart', max_fila) AND sl_entero(l->'rowEnd', max_fila)
         AND sl_entero(l->'colStart', max_col) AND sl_entero(l->'colEnd', max_col)
         AND (l->>'rowEnd')::bigint >= (l->>'rowStart')::bigint
         AND (l->>'colEnd')::bigint >= (l->>'colStart')::bigint
         AND l->>'range' =
             sl_columna_a_letras((l->>'colStart')::integer) || (l->>'rowStart') || ':' ||
             sl_columna_a_letras((l->>'colEnd')::integer) || (l->>'rowEnd');
    WHEN 'region' THEN
      RETURN sl_entero_opc(l->'page', 9007199254740991) AND sl_entero_opc(l->'slide', 9007199254740991)
         AND NOT (l ? 'page' AND jsonb_typeof(l->'page') <> 'null'
                  AND l ? 'slide' AND jsonb_typeof(l->'slide') <> 'null')
         AND sl_fraccion(l->'x') AND sl_fraccion(l->'y')
         AND sl_fraccion(l->'width') AND sl_fraccion(l->'height')
         AND (l->>'width')::numeric > 0 AND (l->>'height')::numeric > 0
         AND (l->>'x')::numeric + (l->>'width')::numeric <= 1
         AND (l->>'y')::numeric + (l->>'height')::numeric <= 1;
  END CASE;
  RETURN false;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- Localizador equivalente a las columnas legacy. Precedencia: diapositiva >
-- página > sección; título/sección y línea se conservan como contexto. NULL si no
-- hay ubicación. Espejo de `localizadorDesdeLegacy` (packages/domain).
CREATE OR REPLACE FUNCTION source_locator_desde_legacy(
  p_page integer, p_slide integer, p_section text, p_linea integer
) RETURNS jsonb AS $$
  SELECT CASE
    WHEN p_slide IS NOT NULL THEN
      jsonb_strip_nulls(jsonb_build_object(
        'kind', 'slide', 'slide', p_slide,
        'section', CASE WHEN btrim(p_section) <> '' THEN p_section END))
    WHEN p_page IS NOT NULL THEN
      jsonb_strip_nulls(jsonb_build_object(
        'kind', 'page', 'page', p_page,
        'section', CASE WHEN btrim(p_section) <> '' THEN p_section END,
        'line', p_linea))
    WHEN btrim(p_section) <> '' THEN
      jsonb_strip_nulls(jsonb_build_object('kind', 'section', 'section', p_section, 'line', p_linea))
  END;
$$ LANGUAGE sql IMMUTABLE;

-- ─────────────────────────── Localizador en fragmentos ─────────────────────────

ALTER TABLE source_fragments ADD COLUMN locator jsonb;

-- Los parsers actuales siguen escribiendo page/slide/section/linea: el
-- localizador se deriva si no se informa (los de hoja lo informan explícitamente).
CREATE OR REPLACE FUNCTION source_fragments_derivar_localizador() RETURNS trigger AS $$
BEGIN
  IF NEW.locator IS NULL THEN
    NEW.locator := source_locator_desde_legacy(NEW.page, NEW.slide, NEW.section, NEW.linea);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER source_fragments_localizador
  BEFORE INSERT ON source_fragments
  FOR EACH ROW EXECUTE FUNCTION source_fragments_derivar_localizador();

-- Los fragmentos existentes NO se reescriben: solo se completa la columna nueva
-- a partir de sus propias columnas legacy (que quedan intactas).
UPDATE source_fragments
   SET locator = source_locator_desde_legacy(page, slide, section, linea)
 WHERE locator IS NULL;

-- Antes: page, slide o section. Ahora: todo fragmento tiene un localizador
-- válido, sea cual sea el formato (la restricción anterior queda subsumida).
ALTER TABLE source_fragments DROP CONSTRAINT source_fragments_localizado;
ALTER TABLE source_fragments
  ADD CONSTRAINT source_fragments_localizado
  CHECK (locator IS NOT NULL AND source_locator_valido(locator));

COMMENT ON COLUMN source_fragments.locator IS
  'Ubicación en la fuente (SourceLocator): page | slide | section | sheet | row | cell | range | region. '
  'Derivado de page/slide/section/linea cuando el parser no lo informa.';

CREATE INDEX source_fragments_hoja_idx
  ON source_fragments (source_id, (locator->>'sheet'))
  WHERE locator->>'sheet' IS NOT NULL;

-- ─────────────────────────── Localizador en evidencia ──────────────────────────

-- Nullable a propósito: la evidencia histórica (sobre todo la de versiones
-- aprobadas, congelada por la 009) no se reescribe. Quien la lea usa
-- `COALESCE(locator, derivado de las columnas legacy)`.
ALTER TABLE evidence ADD COLUMN locator jsonb;

ALTER TABLE evidence
  ADD CONSTRAINT evidence_localizador_valido
  CHECK (locator IS NULL OR source_locator_valido(locator));

-- Una evidencia que cita un fragmento (a) debe ser de la MISMA fuente y (b)
-- lleva SIEMPRE la ubicación de ese fragmento: no puede omitirla ni apuntar a
-- otra. Sin fragmento, se deriva de las columnas legacy si las hay.
CREATE OR REPLACE FUNCTION evidence_localizador_coherente() RETURNS trigger AS $$
DECLARE
  frag_locator jsonb;
  frag_source uuid;
BEGIN
  IF NEW.fragment_id IS NOT NULL THEN
    SELECT f.locator, f.source_id INTO frag_locator, frag_source
      FROM source_fragments f WHERE f.id = NEW.fragment_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'La evidencia cita un fragmento que no existe.';
    END IF;
    IF frag_source <> NEW.source_id THEN
      RAISE EXCEPTION 'La evidencia cita un fragmento de otra fuente.';
    END IF;
    IF NEW.locator IS NULL THEN
      NEW.locator := frag_locator;
    ELSIF NEW.locator IS DISTINCT FROM frag_locator THEN
      RAISE EXCEPTION 'El localizador de la evidencia no coincide con el de su fragmento.';
    END IF;
  ELSIF NEW.locator IS NULL THEN
    NEW.locator := source_locator_desde_legacy(NEW.page, NEW.slide, NEW.section, NEW.linea);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER evidence_localizador
  BEFORE INSERT ON evidence
  FOR EACH ROW EXECUTE FUNCTION evidence_localizador_coherente();

COMMENT ON COLUMN evidence.locator IS
  'Ubicación citada (SourceLocator). NULL solo en evidencia histórica anterior a la Fase 4 o manual sin fragmento ni ubicación.';

-- ─────────────────────────── Representación normalizada ────────────────────────

-- El original se conserva SIEMPRE (`source_documents` + almacenamiento); los
-- fragmentos son la representación procesable por texto; esta tabla guarda la
-- ESTRUCTURA normalizada de lo que no cabe en una lista de fragmentos (hoy: el
-- manifiesto de un libro de cálculo — hojas, tabla/cabeceras, rangos, límites).
-- Nunca reemplaza al original ni a los fragmentos.
CREATE TABLE source_representations (
  id          uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  source_id   uuid NOT NULL REFERENCES source_documents(id) ON DELETE CASCADE,
  kind        text NOT NULL,
  format      text NOT NULL,
  content     jsonb NOT NULL,
  generator   text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT source_representations_kind_valido CHECK (kind IN ('structure')),
  CONSTRAINT source_representations_contenido_objeto CHECK (jsonb_typeof(content) = 'object'),
  -- Reprocesar reemplaza (idempotencia), no acumula.
  CONSTRAINT source_representations_unica UNIQUE (source_id, kind)
);
