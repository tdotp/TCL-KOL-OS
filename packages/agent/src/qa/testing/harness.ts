/**
 * Utilidades de las pruebas de QA ADVERSARIAL de la Fase 6 (BD real, base `_test`).
 *
 * Vive en `qa/testing/` a propósito: el test estático de import-boundary
 * (`tools/manifest.test.ts`) excluye `/testing/` y las pruebas, así que estos
 * ayudantes pueden importar de `@tcl-kol-os/db` sin romperlo.
 */
import { randomUUID } from 'node:crypto';
import { RegistroDeReferencias, type User } from '@tcl-kol-os/domain';
import { query } from '@tcl-kol-os/db';
import type { ToolExecution, ToolRunContext } from '../../contracts.ts';
import {
  abrirTurno,
  clave,
  contextoDe,
  json,
  llamar,
  registro,
  type Turno,
} from '../../tools/test-support.ts';

export { abrirTurno, clave, contextoDe, json, llamar, registro, type Turno };

export const contar = async (sql: string, params: unknown[] = []): Promise<number> =>
  Number((await query<{ n: string }>(`SELECT count(*)::text AS n FROM ${sql}`, params))[0]!.n);

/** Eventos de auditoría de la organización creados después de `desde` (ms epoch). */
export async function auditoriaDesde(organizationId: string, desde: Date) {
  return query<{
    id: string;
    action: string;
    origin: string | null;
    actor_id: string | null;
    entity_type: string;
    entity_id: string | null;
    correlation: Record<string, string> | null;
    metadata: Record<string, unknown>;
  }>(
    `SELECT id, action, origin, actor_id, entity_type, entity_id, correlation, metadata
       FROM audit_events WHERE organization_id = $1 AND created_at >= $2 ORDER BY created_at, id`,
    [organizationId, desde],
  );
}

export async function nuevaCampana(
  organizationId: string,
  ownerId: string,
  nombre: string,
  campanas: string[],
) {
  const [c] = await query<{ id: string }>(
    `INSERT INTO campaigns (organization_id, name, owner_id, created_by) VALUES ($1, $2, $3, $3) RETURNING id`,
    [organizationId, `${nombre} · ${randomUUID().slice(0, 8)}`, ownerId],
  );
  campanas.push(c!.id);
  return c!.id;
}

export function ctxDeRun(t: Turno, extra: Partial<ToolRunContext> = {}): ToolRunContext {
  return { ...contextoDe(t), ...extra };
}

export const codigo = (x: ToolExecution): string | undefined => x.errorCode;

export const refs = (): RegistroDeReferencias => new RegistroDeReferencias();

export type UsuarioDeQa = User;

/** Cambia el rol de un usuario en la BD (y lo devuelve a su valor en `restaurar`). */
export async function cambiarRol(userId: string, rol: string): Promise<() => Promise<void>> {
  const [antes] = await query<{ role: string }>(`SELECT role::text AS role FROM users WHERE id = $1`, [
    userId,
  ]);
  await query(`UPDATE users SET role = $2::user_role WHERE id = $1`, [userId, rol]);
  return async () => {
    await query(`UPDATE users SET role = $2::user_role WHERE id = $1`, [userId, antes!.role]);
  };
}
