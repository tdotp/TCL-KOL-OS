/**
 * Utilidades exclusivas de la suite de pruebas (INC-001A).
 *
 * `eliminarCampanaDePrueba` es la única función de este paquete que activa
 * `tclkolos.permitir_borrado_historico` (migración 009) — nunca ninguna
 * ruta de la aplicación real lo hace. Existe porque la limpieza de una
 * campaña de prueba (`afterAll`) legítimamente necesita borrar en cascada
 * el contenido de versiones `approved`/`superseded`, que las migraciones
 * 009 y 010 protegen a propósito contra `UPDATE`/`INSERT`/`DELETE`
 * directos — la bandera, activada solo dentro de esta transacción vía
 * `SET LOCAL`, es la salida explícita y acotada para ese caso, nunca un
 * debilitamiento general de la protección.
 *
 * Que solo esta función la active es una convención de la aplicación, no
 * la restricción real: la migración 010 (Sprint 5 correctivo, hallazgo 1)
 * hace que `inmutabilidad_bypass_activo()` exija además que el nombre de
 * la base actual termine en `_test` — la misma convención que INC-001A ya
 * exige en `vitest.setup.ts`. En cualquier base que no termine en `_test`
 * (desarrollo, staging, producción), esta bandera no tiene ningún efecto,
 * la active quien la active.
 */

import type { Role, User } from '@tcl-kol-os/domain';
import { query, transaction } from './client.ts';

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
      // V2 · Fase 5: la importación de influencers cuelga (RESTRICT) de la
      // participación, la fuente y el snapshot: se limpia primero, hechos
      // históricos incluidos, con el bypass restringido a bases `_test`.
      await client.query(`DELETE FROM influencer_import_effects WHERE campaign_id = $1`, [id]);
      await client.query(`DELETE FROM influencer_source_bindings WHERE campaign_id = $1`, [id]);
      await client.query(`DELETE FROM influencer_import_resolutions WHERE campaign_id = $1`, [id]);
      await client.query(`DELETE FROM influencer_import_plans WHERE campaign_id = $1`, [id]);
      // V2 · Fase 3: la participación de influencers y sus productos asignados
      // son FK RESTRICT hacia la campaña (nada se borra en cascada): se limpian
      // primero y solo aquí, con el bypass restringido a bases `_test`.
      await client.query(`DELETE FROM campaign_influencer_products WHERE campaign_id = $1`, [id]);
      await client.query(`DELETE FROM campaign_influencers WHERE campaign_id = $1`, [id]);
      await client.query(`DELETE FROM briefs WHERE campaign_id = $1`, [id]);
      await client.query(`DELETE FROM campaigns WHERE id = $1`, [id]);
    }
  });
}

/**
 * Limpieza de influencers de prueba (V2 · Fase 3): participaciones, cuentas e
 * identidades, con el mismo bypass acotado a bases `_test`. Las campañas que los
 * usan se eliminan antes (`eliminarCampanaDePrueba` ya vacía sus participaciones).
 */
export async function eliminarInfluencersDePrueba(idOids: string | readonly string[]): Promise<void> {
  const ids = Array.isArray(idOids) ? idOids : [idOids];
  if (ids.length === 0) return;
  await transaction(async (client) => {
    await client.query(`SET LOCAL tclkolos.permitir_borrado_historico = 'on'`);
    for (const id of ids) {
      // V2 · Fase 5: bindings y decisiones que apuntan a la persona.
      await client.query(`DELETE FROM influencer_import_effects WHERE entity_id = $1`, [id]);
      await client.query(`DELETE FROM influencer_source_bindings WHERE influencer_id = $1`, [id]);
      await client.query(`DELETE FROM influencer_import_resolutions WHERE influencer_id = $1`, [id]);
      await client.query(
        `DELETE FROM campaign_influencer_products
          WHERE campaign_influencer_id IN (SELECT id FROM campaign_influencers WHERE influencer_id = $1)`,
        [id],
      );
      await client.query(`DELETE FROM campaign_influencers WHERE influencer_id = $1`, [id]);
      await client.query(`DELETE FROM influencer_accounts WHERE influencer_id = $1`, [id]);
      await client.query(`DELETE FROM influencers WHERE id = $1`, [id]);
    }
  });
}

/**
 * Devuelve un usuario de pruebas con ese correo y rol, creándolo si la base
 * (ya sembrada antes de que existiera el rol) no lo tiene. Solo para pruebas.
 */
export async function asegurarUsuarioDePrueba(
  email: string,
  nombre: string,
  rol: Role,
  organizationId: string,
): Promise<User> {
  await query(
    `INSERT INTO users (email, name, organization_id, role)
     SELECT $1, $2, $3, $4::user_role
      WHERE NOT EXISTS (SELECT 1 FROM users WHERE email = $1)`,
    [email, nombre, organizationId, rol],
  );
  const [fila] = await query<{ id: string; organization_id: string; role: Role; name: string }>(
    `SELECT id, organization_id, role, name FROM users WHERE email = $1`,
    [email],
  );
  return {
    id: fila!.id,
    email,
    name: fila!.name,
    organizationId: fila!.organization_id,
    role: fila!.role,
    status: 'activo',
  };
}
