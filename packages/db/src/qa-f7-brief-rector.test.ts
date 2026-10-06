/**
 * QA ADVERSARIAL F7 (subagente F) — el Brief RECTOR no se puede mover ni reescribir por SQL directo.
 *
 * La vigencia de una revisión (CURRENT/STALE) depende de `brief_rector_de_campana` (mayor `approved_at`) y de que
 * el CONTENIDO de la versión aprobada no cambie. Si cualquiera de las dos cosas se pudiera alterar sin crear una
 * versión nueva, una revisión podría quedar CURRENT contra un Brief que ya no es el que se revisó.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePool, query } from './client.ts';
import {
  type EscenarioDeAprobacion,
  crearEscenarioDeAprobacion,
  evaluar,
  versionRevisada,
} from './script-approval-test-support.ts';
import { crearBriefHijoDePrueba, limpiarEscenarioDeContenido } from './test-utils.ts';

let a: EscenarioDeAprobacion;

beforeAll(async () => {
  a = await crearEscenarioDeAprobacion('QA-F7 rector');
});

afterAll(async () => {
  await limpiarEscenarioDeContenido(a.e);
  await closePool();
});

async function rechazo(sql: string, params: unknown[] = []): Promise<string | undefined> {
  try {
    await query(sql, params);
    return undefined;
  } catch (error) {
    return (error as Error).message;
  }
}

describe('QA-F7-04c · el Brief aprobado (rector) es inmutable y su orden no se manipula', () => {
  it('RESISTE: el contenido de la versión aprobada (campos) no se reescribe, no se borra ni se amplía', async () => {
    const campo = a.brief.campos['mensaje_principal.one_line']!;
    expect(
      await rechazo(`UPDATE brief_fields SET value = '"reescrito"'::jsonb WHERE id = $1`, [campo]),
      'UPDATE value',
    ).toBeDefined();
    expect(
      await rechazo(`UPDATE brief_fields SET status = 'not_found' WHERE id = $1`, [campo]),
    ).toBeDefined();
    expect(await rechazo(`DELETE FROM brief_fields WHERE id = $1`, [campo])).toBeDefined();
    expect(
      await rechazo(
        `INSERT INTO brief_fields (brief_version_id, key, value, status, provenance_type, criticidad)
         VALUES ($1, 'practico.restricciones', '["No hay restricciones"]'::jsonb, 'found', 'extracted', 'informativo')`,
        [a.brief.versionId],
      ),
      'INSERT en una versión aprobada',
    ).toBeDefined();
  });

  it('RESISTE: `approved_at` de una versión aprobada o reemplazada no se puede adelantar para cambiar el rector', async () => {
    const { versionId } = await versionRevisada(a.e);
    const padre = a.brief.versionId;
    const hija = await crearBriefHijoDePrueba(a.e.admin, padre, {
      cambios: { 'mensaje_principal.one_line': 'Mensaje del Brief hijo, el rector actual.' },
    });
    // El rector es la hija; la revisión del guion (contra el padre) está STALE.
    expect((await evaluar(versionId)).elegible).toBe(false);
    // Intentar volver a hacer rector al padre adelantando su fecha de aprobación.
    const m1 = await rechazo(
      `UPDATE brief_versions SET approved_at = now() + interval '1 day' WHERE id = $1`,
      [padre],
    );
    const m2 = await rechazo(`UPDATE brief_versions SET approved_at = '2001-01-01' WHERE id = $1`, [
      hija.versionId,
    ]);
    expect(m1, 'adelantar approved_at del padre').toBeDefined();
    expect(m2, 'retrasar approved_at de la hija').toBeDefined();
    const [r] = await query<{ rector: string }>(`SELECT brief_rector_de_campana($1)::text AS rector`, [
      a.e.campanaId,
    ]);
    expect(r!.rector).toBe(hija.versionId);
  });

  it('RESISTE: una versión del Brief no vuelve de `superseded`/`approved` a borrador ni se le quita `approved_at`', async () => {
    const [rector] = await query<{ id: string }>(`SELECT brief_rector_de_campana($1)::text AS id`, [
      a.e.campanaId,
    ]);
    for (const sql of [
      `UPDATE brief_versions SET status = 'draft' WHERE id = $1`,
      `UPDATE brief_versions SET approved_at = NULL WHERE id = $1`,
      `DELETE FROM brief_versions WHERE id = $1`,
    ]) {
      expect(await rechazo(sql, [rector!.id]), sql).toBeDefined();
    }
  });
});

describe('QA-F7-04d · cancelar el Brief rector recalcula el rector y la vigencia, nunca deja un cancelado o un borrador como rector', () => {
  it('RESISTE: al cancelar la versión rector (permitido por 009) el rector vuelve a la anterior aprobada y las revisiones se recalculan', async () => {
    const s = await crearEscenarioDeAprobacion('QA-F7 rector cancelado');
    try {
      const { versionId } = await versionRevisada(s.e); // revisión CURRENT contra el Brief V1
      expect((await evaluar(versionId)).elegible).toBe(true);
      const hija = await crearBriefHijoDePrueba(s.e.admin, s.brief.versionId, {
        cambios: { 'mensaje_principal.one_line': 'Brief V2 que luego se cancela, distinto del V1.' },
      });
      expect((await evaluar(versionId)).elegible, 'rector V2: la revisión contra V1 es STALE').toBe(false);
      await query(`UPDATE brief_versions SET status = 'cancelled' WHERE id = $1`, [hija.versionId]);
      const [r] = await query<{ rector: string }>(`SELECT brief_rector_de_campana($1)::text AS rector`, [
        s.e.campanaId,
      ]);
      expect(r!.rector, 'el rector nunca es el cancelado').toBe(s.brief.versionId);
      expect(
        (await evaluar(versionId)).elegible,
        'rector V1 otra vez: la revisión contra V1 vuelve a ser CURRENT',
      ).toBe(true);
    } finally {
      await limpiarEscenarioDeContenido(s.e);
    }
  });
});
