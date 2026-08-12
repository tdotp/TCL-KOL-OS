-- Extensiones requeridas por TCL KOL OS.
-- Se ejecuta una sola vez, al crear el volumen de la base de datos.

-- Búsqueda semántica sobre fragmentos de documentos (§8.1, §9.3).
-- Los embeddings heredan organización, campaña, idioma, versión y permiso del
-- documento de origen (§10.3, regla 7); el filtro se aplica en la consulta.
CREATE EXTENSION IF NOT EXISTS vector;

-- Identificadores de recursos.
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Búsqueda textual con tolerancia a errores, complemento del vectorial.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
