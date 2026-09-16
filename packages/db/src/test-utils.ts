/**
 * Utilidades exclusivas de la suite de pruebas (INC-001A).
 *
 * `eliminarCampanaDePrueba` es la única función de este paquete que activa
 * `tclkolos.permitir_borrado_historico` (migración 009) — nunca ninguna
 * ruta de la aplicación real lo hace. Existe porque la limpieza de una
 * campaña de prueba (`afterAll`) legítimamente necesita borrar en cascada
 * el contenido de versiones `approved`/`superseded`, que la migración 009
 * protege a propósito contra `UPDATE`/`INSERT`/`DELETE` directos — la
 * bandera, activada solo dentro de esta transacción vía `SET LOCAL`, es la
 * salida explícita y acotada para ese caso, nunca un debilitamiento general
 * de la protección (ver comentario largo en la propia migración 009).
 */

import { transaction } from './client.ts';

export async function eliminarCampanaDePrueba(idOids: string | readonly string[]): Promise<void> {
  const ids = Array.isArray(idOids) ? idOids : [idOids];
  if (ids.length === 0) return;

  await transaction(async (client) => {
    await client.query(`SET LOCAL tclkolos.permitir_borrado_historico = 'on'`);
    // Orden explícito, no confiado a que Postgres resuelva solo dos árboles
    // de cascada independientes en el orden correcto: `evidence.source_id`
    // es `ON DELETE RESTRICT` (migración 004, sin tocar), y
    // `source_documents` cuelga de `campaigns` por su propio lado (no por
    // `briefs`). Si `campaigns → source_documents` se procesa antes que
    // `campaigns → briefs → brief_versions → brief_fields → evidence`,
    // el `RESTRICT` revienta con `evidence_source_id_fkey` — visto en vivo
    // al escribir las pruebas de esta migración. Borrar `briefs` primero
    // dispara esa segunda cascada de punta a punta (hasta `evidence`
    // incluida) antes de tocar `campaigns`, así que para cuando
    // `source_documents` se borra, ya no hay ninguna `evidence` que lo
    // referencie.
    for (const id of ids) {
      await client.query(`DELETE FROM briefs WHERE campaign_id = $1`, [id]);
      await client.query(`DELETE FROM campaigns WHERE id = $1`, [id]);
    }
  });
}
