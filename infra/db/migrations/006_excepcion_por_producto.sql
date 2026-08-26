-- 006 · E7-8, excepción por producto en un campo compartido (DEC-016).
--
-- La migración 005 ya deja el índice que hace falta: `brief_fields_unica_producto`
-- acepta una fila por `(brief_version_id, key, campaign_product_id)` para
-- CUALQUIER campo, incluidos los de nivel `compartido_con_excepcion` — no
-- hace falta tocar ningún índice ni trigger de `brief_fields` para esto.
--
-- Lo único que faltaba: `brief_field_revisions.accion` no tenía un valor
-- propio para distinguir "declarar una excepción por producto" (crea una fila
-- nueva, anclada a un producto, con motivo obligatorio) de una corrección
-- normal sobre la fila compartida — y tampoco existía el valor para
-- revertirla. Sin esto, el historial de un campo compartido con excepciones
-- sería indistinguible de una corrección cualquiera.

ALTER TABLE brief_field_revisions DROP CONSTRAINT brief_field_revisions_accion_valida;
ALTER TABLE brief_field_revisions
  ADD CONSTRAINT brief_field_revisions_accion_valida
  CHECK (accion IN ('confirm', 'correct', 'resolve_conflict', 'apply_answer',
                     'declare_exception', 'revert_exception'));
