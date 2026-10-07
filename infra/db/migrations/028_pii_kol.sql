-- 028 · Datos personales del KOL, cifrados y separados (V2 · Fase 8, DEC-013/DEC-049).
--
-- Forward-only y aditiva: UNA tabla nueva y sus triggers. No cambia ninguna fila ni columna existente.
--
-- Principios impuestos AQUÍ (no solo en la aplicación):
--   · La PII (cédula, teléfono, dirección) vive SOLO aquí, por INFLUENCER (la persona, no la
--     participación), cifrada a nivel de campo por la aplicación (AES-256-GCM, `node:crypto`; sin
--     pgcrypto: la base NUNCA ve la clave ni el texto plano). Nunca en `campaign_influencers`, ni en
--     `shipments` (que solo guarda `pii_record_id`), ni en el índice vectorial, ni en el agente.
--   · El envoltorio del cifrado se verifica con un CHECK (primer byte = versión de formato 0x01 y
--     longitud mínima 29 = 1 + IV 12 + etiqueta GCM 16): un texto plano accidental no cabe.
--   · Append-only por VERSIÓN: guardar nuevos datos = fila nueva (`version` por trigger, bajo bloqueo
--     del influencer). La ÚNICA mutación permitida es el cripto-borrado: `erased_at` (+ `erased_by`) y los
--     bytea y el índice ciego a NULL, una sola vez.
--   · VIGENCIA DERIVADA, sin mutar filas: la versión vigente de un influencer es la de mayor `version`.
--     (Descartado: una columna `is_current` que el trigger de la versión nueva bajara en la anterior; eso
--     sería una segunda mutación sobre una tabla de PII.) Como un índice único parcial no puede mirar
--     «la de mayor versión», la unicidad de la cédula entre influencers vigentes la impone un trigger
--     que serializa con un `pg_advisory_xact_lock` por (organización, índice ciego): ver abajo.
--   · `blind_index` = HMAC-SHA-256 de la cédula normalizada (32 bytes), con una clave distinta de la de
--     cifrado (`PII_INDEX_KEY`). Permite detectar cédula duplicada sin descifrar.
--   · Roles cerrados (`operaciones_exigir_rol`, capacidad `pii`): admin, operativo.
--   · Sin DELETE ni TRUNCATE (solo el bypass de bases `_test`).

CREATE TABLE influencer_pii_records (
  id               uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id  uuid NOT NULL,
  influencer_id    uuid NOT NULL,
  -- La asigna el trigger (por influencer, sin huecos); el valor que mande el llamador se ignora.
  version          integer NOT NULL DEFAULT 0,
  document_id_enc  bytea,
  phone_enc        bytea,
  address_enc      bytea,
  -- Identificador (no secreto) de la clave de cifrado usada: permite rotarla.
  key_id           text NOT NULL,
  blind_index      bytea,
  created_by       uuid NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  erased_at        timestamptz,
  erased_by        uuid,

  CONSTRAINT influencer_pii_records_influencer_fkey
    FOREIGN KEY (influencer_id, organization_id)
    REFERENCES influencers (id, organization_id) ON DELETE RESTRICT,
  CONSTRAINT influencer_pii_records_autor_fkey
    FOREIGN KEY (created_by, organization_id)
    REFERENCES users (id, organization_id) ON DELETE RESTRICT,
  CONSTRAINT influencer_pii_records_borrador_fkey
    FOREIGN KEY (erased_by, organization_id)
    REFERENCES users (id, organization_id) ON DELETE RESTRICT,
  CONSTRAINT influencer_pii_records_version_key UNIQUE (influencer_id, version),
  -- Para que `shipments.pii_record_id` amarre la organización.
  CONSTRAINT influencer_pii_records_id_organization_key UNIQUE (id, organization_id),
  CONSTRAINT influencer_pii_records_id_influencer_key UNIQUE (id, influencer_id),
  CONSTRAINT influencer_pii_records_version_valida CHECK (version >= 1),
  CONSTRAINT influencer_pii_records_key_id_valido CHECK (key_id ~ '^[A-Za-z0-9_.:-]{1,64}$'),
  -- Envoltorio: versión de formato 0x01 + IV(12) + etiqueta(16) = mínimo 29 bytes. Rechaza texto plano.
  CONSTRAINT influencer_pii_records_envoltorio_valido CHECK (
    (document_id_enc IS NULL OR (octet_length(document_id_enc) >= 29 AND get_byte(document_id_enc, 0) = 1))
    AND (phone_enc   IS NULL OR (octet_length(phone_enc)   >= 29 AND get_byte(phone_enc, 0) = 1))
    AND (address_enc IS NULL OR (octet_length(address_enc) >= 29 AND get_byte(address_enc, 0) = 1))
  ),
  CONSTRAINT influencer_pii_records_indice_valido CHECK (blind_index IS NULL OR octet_length(blind_index) = 32),
  -- El índice ciego existe si y solo si hay cédula cifrada.
  CONSTRAINT influencer_pii_records_indice_coherente CHECK ((blind_index IS NULL) = (document_id_enc IS NULL)),
  -- Un registro vigente (no borrado) guarda algo; uno borrado no conserva nada cifrado.
  CONSTRAINT influencer_pii_records_borrado_coherente CHECK (
    (erased_at IS NULL AND erased_by IS NULL
       AND (document_id_enc IS NOT NULL OR phone_enc IS NOT NULL OR address_enc IS NOT NULL))
    OR
    (erased_at IS NOT NULL AND erased_by IS NOT NULL
       AND document_id_enc IS NULL AND phone_enc IS NULL AND address_enc IS NULL AND blind_index IS NULL)
  )
);

-- Búsqueda de cédula duplicada (sin descifrar).
CREATE INDEX influencer_pii_records_indice_idx
  ON influencer_pii_records (organization_id, blind_index) WHERE blind_index IS NOT NULL;

CREATE OR REPLACE FUNCTION influencer_pii_records_integridad() RETURNS trigger AS $$
DECLARE
  maxima  integer;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.erased_at IS NOT NULL OR NEW.erased_by IS NOT NULL THEN
      RAISE EXCEPTION 'Un registro de datos personales nace sin borrar.';
    END IF;
    PERFORM operaciones_exigir_rol(NEW.created_by, 'pii');
    -- Serializa la numeración por influencer. NO SHARE/UPDATE completo: no bloquea las altas de
    -- participación (que toman FOR KEY SHARE sobre el influencer).
    PERFORM 1 FROM influencers WHERE id = NEW.influencer_id FOR NO KEY UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'El influencer no existe.' USING ERRCODE = 'foreign_key_violation';
    END IF;
    SELECT COALESCE(max(version), 0) INTO maxima FROM influencer_pii_records WHERE influencer_id = NEW.influencer_id;
    NEW.version := maxima + 1;
    NEW.created_at := now();

    -- Cédula duplicada: ningún OTRO influencer de la organización tiene hoy (versión vigente, no borrada)
    -- el mismo índice ciego. El candado de asesoría serializa a quienes guardan la misma cédula a la vez.
    IF NEW.blind_index IS NOT NULL THEN
      PERFORM pg_advisory_xact_lock(hashtextextended(NEW.organization_id::text || ':' || encode(NEW.blind_index, 'hex'), 0));
      IF EXISTS (
        SELECT 1
          FROM influencer_pii_records r
         WHERE r.organization_id = NEW.organization_id
           AND r.blind_index = NEW.blind_index
           AND r.influencer_id <> NEW.influencer_id
           AND r.erased_at IS NULL
           AND r.version = (SELECT max(m.version) FROM influencer_pii_records m WHERE m.influencer_id = r.influencer_id)
      ) THEN
        RAISE EXCEPTION 'Esa cédula ya está registrada para otro influencer de la organización.'
          USING ERRCODE = 'unique_violation', CONSTRAINT = 'influencer_pii_records_cedula_vigente_key';
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  -- UPDATE: única mutación = cripto-borrado, una sola vez, por una persona con rol.
  IF OLD.erased_at IS NOT NULL THEN
    RAISE EXCEPTION 'Un registro de datos personales ya borrado no admite cambios.';
  END IF;
  IF NEW.erased_at IS NULL THEN
    RAISE EXCEPTION 'influencer_pii_records es append-only por versión: solo se admite el cripto-borrado (erased_at).';
  END IF;
  IF (NEW.id, NEW.organization_id, NEW.influencer_id, NEW.version, NEW.key_id, NEW.created_by, NEW.created_at)
     IS DISTINCT FROM
     (OLD.id, OLD.organization_id, OLD.influencer_id, OLD.version, OLD.key_id, OLD.created_by, OLD.created_at) THEN
    RAISE EXCEPTION 'El cripto-borrado solo cambia erased_at, erased_by y deja en NULL los campos cifrados.';
  END IF;
  PERFORM operaciones_exigir_rol(NEW.erased_by, 'pii');
  NEW.erased_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER influencer_pii_records_integridad
  BEFORE INSERT OR UPDATE ON influencer_pii_records
  FOR EACH ROW EXECUTE FUNCTION influencer_pii_records_integridad();
CREATE TRIGGER influencer_pii_records_sin_delete
  BEFORE DELETE ON influencer_pii_records FOR EACH ROW EXECUTE FUNCTION operaciones_sin_delete();
CREATE TRIGGER influencer_pii_records_sin_truncate
  BEFORE TRUNCATE ON influencer_pii_records FOR EACH STATEMENT EXECUTE FUNCTION operaciones_sin_truncate();
