-- 003 · La sección es un localizador válido.
--
-- Contexto (DEC-018)
-- ------------------
-- La restricción original exigía `page` o `slide`. Eso funciona para PPTX y PDF,
-- donde la ubicación existe de verdad, pero obligaba a inventar un número de
-- página en documentos de texto que no tienen páginas hasta renderizarse.
--
-- Lo que hace verificable una evidencia no es el número de página: es poder
-- volver al punto exacto del documento. En un texto, ese punto es su SECCIÓN
-- —la ruta de encabezados—, que además es estable: no cambia si alguien
-- modifica la fuente o los márgenes.
--
-- La regla pasa a ser: **todo fragmento debe tener algún localizador**.

ALTER TABLE source_fragments DROP CONSTRAINT source_fragments_localizado;

ALTER TABLE source_fragments
  ADD CONSTRAINT source_fragments_localizado
  CHECK (
    page IS NOT NULL
    OR slide IS NOT NULL
    OR (section IS NOT NULL AND btrim(section) <> '')
  );

COMMENT ON CONSTRAINT source_fragments_localizado ON source_fragments IS
  'Un fragmento sin ubicación no puede citarse como evidencia (§9.4). '
  'Sirve la página, la diapositiva o la sección, según lo que el formato ofrezca de verdad.';

-- El número de línea complementa la sección en formatos de texto: permite
-- señalar el punto exacto sin depender de cómo se renderice el documento.
ALTER TABLE source_fragments ADD COLUMN linea integer;

COMMENT ON COLUMN source_fragments.linea IS
  'Línea donde empieza el fragmento en formatos de texto (Markdown). '
  'Estable frente a cambios de formato, a diferencia del número de página.';
