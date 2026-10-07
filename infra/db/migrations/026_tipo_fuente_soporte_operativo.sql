-- 026 · Tipo de fuente «soporte_operativo» (V2 · Fase 8, DEC-049).
--
-- La evidencia operativa (guías de envío, cuentas de cobro, comprobantes, cotizaciones) NO es un
-- segundo almacén de documentos: es una fuente más (`source_documents`) con tipo propio. Las reglas
-- que la distinguen (sin job, sin fragmentos, siempre interna y sensible, nunca citable por el agente)
-- las impone la migración 031.
--
-- Forward-only y aditiva. SOLA en su archivo: un valor nuevo de enum no puede usarse dentro de la
-- misma transacción que lo crea (cada migración corre en la suya), y la 031 sí lo usa.
ALTER TYPE source_type ADD VALUE IF NOT EXISTS 'soporte_operativo';
