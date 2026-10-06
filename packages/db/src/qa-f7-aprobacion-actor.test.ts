/**
 * QA ADVERSARIAL F7 (subagente F) — el aprobador con un objeto `User` OBSOLETO (sesión vieja).
 *
 * Los casos de uso autorizan con el `User` que reciben. Si la persona fue desactivada o degradada DESPUÉS de que
 * la interfaz cargó su sesión, el objeto sigue diciendo «director activo». La defensa independiente es el trigger
 * de la 023 (`contenido_exigir_rol` relee el rol y el estado de la persona en la base al aprobar).
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePool, query } from './client.ts';
import { aprobarScriptVersion } from './script-approval.ts';
import {
  type EscenarioDeAprobacion,
  codigo,
  confirmarAprobacion,
  aprobarDirecto,
  contarAuditoria,
  crearEscenarioDeAprobacion,
  ejecutarAprobacion,
  estadoDeVersion,
  huellaDe,
  proponerAprobacion,
  valor,
  versionRevisada,
} from './script-approval-test-support.ts';
import { limpiarEscenarioDeContenido } from './test-utils.ts';

let a: EscenarioDeAprobacion;

beforeAll(async () => {
  a = await crearEscenarioDeAprobacion('QA-F7 actor obsoleto');
});

afterAll(async () => {
  await limpiarEscenarioDeContenido(a.e);
  await closePool();
});

async function conUsuarioCambiado<T>(userId: string, cambio: string, fn: () => Promise<T>): Promise<T> {
  const [antes] = await query<{ role: string; status: string }>(
    `SELECT role::text AS role, status::text AS status FROM users WHERE id = $1`,
    [userId],
  );
  await query(`UPDATE users SET ${cambio} WHERE id = $1`, [userId]);
  try {
    return await fn();
  } finally {
    await query(`UPDATE users SET role = $2::user_role, status = $3::user_status WHERE id = $1`, [
      userId,
      antes!.role,
      antes!.status,
    ]);
  }
}

describe('QA-F7-06b · un aprobador desactivado o degradado no aprueba aunque su sesión diga lo contrario', () => {
  it('RESISTE (directo): director degradado a consultor o desactivado, con el objeto User viejo ⇒ la aprobación se rechaza', async () => {
    const { versionId } = await versionRevisada(a.e);
    const huellaVista = await huellaDe(versionId);
    for (const cambio of [`role = 'consultor'`, `status = 'inactivo'`, `role = 'operativo'`]) {
      const r = await conUsuarioCambiado(a.e.director.id, cambio, () =>
        aprobarScriptVersion(a.e.director, versionId, { huellaVista }),
      );
      expect(r.ok, cambio).toBe(false);
      expect(await estadoDeVersion(versionId), cambio).toBe('in_review');
    }
    // Control positivo: con el rol restaurado, sí.
    valor(await aprobarScriptVersion(a.e.director, versionId, { huellaVista }));
  });

  it('RESISTE (HITL): confirmada la propuesta, el director es degradado o desactivado antes de ejecutar ⇒ no se aprueba y la acción queda confirmada', async () => {
    const { versionId } = await versionRevisada(a.e);
    const propuesta = await proponerAprobacion(a.e, versionId);
    valor(await confirmarAprobacion(a.e.director, propuesta));
    for (const cambio of [`role = 'consultor'`, `status = 'inactivo'`]) {
      const r = await conUsuarioCambiado(a.e.director.id, cambio, () =>
        ejecutarAprobacion(a.e.director, propuesta),
      );
      expect(r.ok, cambio).toBe(false);
      expect(await estadoDeVersion(versionId), cambio).toBe('in_review');
    }
    expect(codigo(await ejecutarAprobacion(a.e.consultor, propuesta))).toBeDefined();
    valor(await ejecutarAprobacion(a.e.director, propuesta));
    expect(await estadoDeVersion(versionId)).toBe('approved');
  });

  it('RESISTE: quien propone (consultor) desactivado entre la propuesta y la confirmación no impide ni falsea la aprobación del director', async () => {
    const { versionId } = await versionRevisada(a.e);
    const propuesta = await proponerAprobacion(a.e, versionId);
    await conUsuarioCambiado(a.e.consultor.id, `status = 'inactivo'`, async () => {
      valor(await confirmarAprobacion(a.e.director, propuesta));
      valor(await ejecutarAprobacion(a.e.director, propuesta));
    });
    const [f] = await query<{ approved_by: string; approved_via_proposed_action_id: string }>(
      `SELECT approved_by, approved_via_proposed_action_id FROM script_versions WHERE id = $1`,
      [versionId],
    );
    expect(f!.approved_by).toBe(a.e.director.id);
    expect(f!.approved_via_proposed_action_id).toBe(propuesta.id);
  });
});

describe('QA-F7-07b · dos aprobadores a la vez sobre la misma versión', () => {
  it('RESISTE: la directa del director y la del administrador simultáneas ⇒ una sola aprobación, una sola auditoría', async () => {
    const { versionId } = await versionRevisada(a.e);
    const rs = await Promise.all([
      aprobarDirecto(a.e.director, versionId),
      aprobarDirecto(a.e.admin, versionId),
    ]);
    expect(rs.filter((r) => r.ok)).toHaveLength(1);
    expect(await estadoDeVersion(versionId)).toBe('approved');
    expect(await contarAuditoria(versionId, 'script_version.approve')).toBe(1);
  });

  it('RESISTE: la directa y la HITL (confirmada) simultáneas ⇒ una sola aprobación; la otra no deja efectos', async () => {
    const { versionId } = await versionRevisada(a.e);
    const propuesta = await proponerAprobacion(a.e, versionId);
    valor(await confirmarAprobacion(a.e.director, propuesta));
    const rs = await Promise.all([
      ejecutarAprobacion(a.e.director, propuesta),
      aprobarDirecto(a.e.admin, versionId),
    ]);
    expect(rs.filter((r) => r.ok)).toHaveLength(1);
    expect(await contarAuditoria(versionId, 'script_version.approve')).toBe(1);
    const [f] = await query<{ approved_via_proposed_action_id: string | null }>(
      `SELECT approved_via_proposed_action_id FROM script_versions WHERE id = $1`,
      [versionId],
    );
    // La marca de origen es coherente con quien ganó (la propuesta solo consta si ganó la ejecución).
    expect([null, propuesta.id]).toContain(f!.approved_via_proposed_action_id);
  });
});
