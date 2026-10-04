-- 017 · Estado «por_resolver» de una fuente (V2 · Fase 4).
--
-- Una fuente enlazada (p. ej. un Google Sheet) se REGISTRA pero su contenido no
-- se resuelve todavía: ningún job la procesa, ninguna integración la lee. Ese
-- estado intermedio no es `pendiente` (que significa «hay un job por correr») y
-- se nombra aparte para no confundirlos.
--
-- Va en su propia migración: un valor nuevo de enum no puede usarse dentro de la
-- misma transacción que lo crea (mismo patrón que la 011). La 018 lo usa.
ALTER TYPE source_status ADD VALUE IF NOT EXISTS 'por_resolver';
