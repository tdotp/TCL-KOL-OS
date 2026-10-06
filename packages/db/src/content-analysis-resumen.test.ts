/**
 * V2 · Fase 7 — `resumenesDeContenidoDeVersiones`: el resumen de revisión por versión que arma la sección
 * `content` del contexto del agente, contra PostgreSQL real (base `_test`).
 *
 * Solo cifras y estados (vigencia, hallazgos por severidad, cambios pedidos, propuesta abierta). Misma regla de
 * vigencia que `obtenerRevisionVigente`; un solo grupo de consultas (sin N+1); aislamiento por organización y
 * por campaña; solo `script:read`.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Result } from '@tcl-kol-os/domain';
import { closePool } from './client.ts';
import {
  ENV_CON_IA,
  type EscenarioDeAnalisis,
  claveNueva,
  clienteQueResponde,
  crearEscenarioDeAnalisis,
  registrarGuionDePrueba,
} from './content-analysis-test-support.ts';
import {
  obtenerRevisionVigente,
  resumenesDeContenidoDeVersiones,
  solicitarAnalisisDeGuion,
} from './content-analysis.ts';
import { solicitarCambiosDeScript } from './script-review.ts';
import { cancelarAccion, proponerAccion } from './proposed-actions.ts';
import { crearBriefHijoDePrueba, limpiarEscenarioDeContenido } from './test-utils.ts';

let a: EscenarioDeAnalisis;

const valor = <T>(r: Result<T>): T => {
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
  return r.value;
};
const codigo = <T>(r: Result<T>): string | undefined => (r.ok ? undefined : r.error.code);

beforeAll(async () => {
  a = await crearEscenarioDeAnalisis('resumen-contenido');
});
afterAll(async () => {
  await limpiarEscenarioDeContenido(a.e);
  await closePool();
});

const versionNueva = async (
  entregable = a.e.entregables.reelGomez,
  participacion = a.e.participaciones.valentinaGomez,
) => (await registrarGuionDePrueba(a.e, entregable, participacion, a.e.consultor)).versionId;

async function analizar(versionId: string, hallazgos: Parameters<typeof clienteQueResponde>[0]) {
  valor(
    await solicitarAnalisisDeGuion(
      a.e.consultor,
      versionId,
      { mode: 'ensure', idempotencyKey: claveNueva('resumen') },
      undefined,
      { cliente: clienteQueResponde(hallazgos), env: ENV_CON_IA },
    ),
  );
}

describe('resumenesDeContenidoDeVersiones', () => {
  it('sin revisión: vigencia «none», 0 hallazgos, 0 cambios pedidos, sin propuesta', async () => {
    const v = await versionNueva(a.e.entregables.reelDiego, a.e.participaciones.diego);
    const m = valor(await resumenesDeContenidoDeVersiones(a.e.consultor, a.e.campanaId, [v]));
    expect(m.get(v)).toEqual({
      versionId: v,
      vigencia: 'none',
      kind: null,
      findingsBySeverity: { alta: 0, media: 0, baja: 0 },
      findingTotal: 0,
      requestedChanges: 0,
      pendingApproval: false,
    });
  });

  it('con revisión CURRENT: vigencia, tipo y hallazgos por severidad coinciden con obtenerRevisionVigente (una sola pasada para varias versiones)', async () => {
    const v1 = await versionNueva();
    await analizar(v1, [
      { category: 'cta_missing', refs: ['accion_kpis.accion_esperada'] },
      { category: 'requirement_not_covered', refs: ['mensaje_principal.mensaje_clave'] },
    ]);
    const v2 = a.versionId; // la versión del escenario (sin analizar)
    const m = valor(await resumenesDeContenidoDeVersiones(a.e.consultor, a.e.campanaId, [v1, v2]));
    expect(m.size).toBe(2);
    const vigente = valor(await obtenerRevisionVigente(a.e.consultor, v1));
    const r1 = m.get(v1)!;
    expect(r1.vigencia).toBe('current');
    expect(r1.kind).toBe('ai_assisted');
    expect(r1.findingTotal).toBe(2);
    expect(r1.findingsBySeverity).toEqual(vigente.findingsBySeverity);
    expect(r1.findingsBySeverity.alta + r1.findingsBySeverity.media + r1.findingsBySeverity.baja).toBe(2);
    expect(m.get(v2)!.vigencia).toBe('none');
  });

  it('cambios pedidos: cuenta los comentarios change_request de la versión', async () => {
    const v = await versionNueva();
    valor(
      await solicitarCambiosDeScript(a.e.consultor, v, {
        items: [{ body: 'Acortar el cierre del video' }, { body: 'Mencionar el hashtag obligatorio' }],
      }),
    );
    const m = valor(await resumenesDeContenidoDeVersiones(a.e.consultor, a.e.campanaId, [v]));
    expect(m.get(v)!.requestedChanges).toBe(2);
  });

  it('propuesta de aprobación abierta (pending/confirmed y sin vencer) ⇒ pendingApproval; una cancelada o vencida, no', async () => {
    const v = await versionNueva();
    await analizar(v, []);
    const abierta = async (id: string) =>
      valor(await resumenesDeContenidoDeVersiones(a.e.consultor, a.e.campanaId, [id])).get(id)!
        .pendingApproval;
    expect(await abierta(v)).toBe(false);
    const p = valor(
      await proponerAccion(a.e.consultor, { type: 'script_version.approve', resourceId: v, origin: 'chat' }),
    );
    expect(await abierta(v)).toBe(true);
    valor(await cancelarAccion(a.e.consultor, p.id));
    expect(await abierta(v)).toBe(false);
    // una vencida (aún `pending` hasta que la barran) no cuenta como abierta
    const w = await versionNueva(a.e.entregables.reelDiego, a.e.participaciones.diego);
    await analizar(w, []);
    valor(
      await proponerAccion(a.e.consultor, {
        type: 'script_version.approve',
        resourceId: w,
        origin: 'chat',
        ttlSegundos: 1,
      }),
    );
    expect(await abierta(w)).toBe(true);
    await new Promise((res) => setTimeout(res, 1_300));
    expect(await abierta(w)).toBe(false);
  });

  it('un Brief rector nuevo vuelve STALE la revisión (sigue legible, con sus cifras)', async () => {
    const v = await versionNueva();
    await analizar(v, [{ category: 'cta_missing', refs: ['accion_kpis.accion_esperada'] }]);
    expect(
      valor(await resumenesDeContenidoDeVersiones(a.e.consultor, a.e.campanaId, [v])).get(v)!.vigencia,
    ).toBe('current');
    await crearBriefHijoDePrueba(a.e.admin, a.brief.versionId, {
      cambios: { 'mensaje_principal.one_line': 'Mensaje principal nuevo del Brief rector.' },
    });
    const r = valor(await resumenesDeContenidoDeVersiones(a.e.consultor, a.e.campanaId, [v])).get(v)!;
    expect(r.vigencia).toBe('stale');
    expect(r.findingTotal).toBe(1);
  });

  it('aislamiento: una versión de otra campaña no aparece; otra organización o el cliente, nada; el operativo no lee (script:read)', async () => {
    const v = await versionNueva();
    // la misma versión pedida con OTRA campaña de la misma organización: se descarta
    const otra = valor(await resumenesDeContenidoDeVersiones(a.e.admin, a.e.otraCampanaId, [v]));
    expect(otra.size).toBe(0);
    expect(codigo(await resumenesDeContenidoDeVersiones(a.e.ajeno, a.e.campanaId, [v]))).toBe(
      'RESOURCE_NOT_FOUND',
    );
    expect(codigo(await resumenesDeContenidoDeVersiones(a.e.cliente, a.e.campanaId, [v]))).toBe(
      'RESOURCE_NOT_FOUND',
    );
    expect(codigo(await resumenesDeContenidoDeVersiones(a.e.operativo, a.e.campanaId, [v]))).toBe(
      'FORBIDDEN_ROLE',
    );
    expect(codigo(await resumenesDeContenidoDeVersiones(a.e.consultor, 'no-es-un-uuid', [v]))).toBe(
      'RESOURCE_NOT_FOUND',
    );
  });

  it('entradas raras: lista vacía, ids mal formados y duplicados no rompen; el tope es de 200 versiones', async () => {
    const v = await versionNueva();
    expect(valor(await resumenesDeContenidoDeVersiones(a.e.consultor, a.e.campanaId, [])).size).toBe(0);
    const m = valor(
      await resumenesDeContenidoDeVersiones(a.e.consultor, a.e.campanaId, ['x', "'; DROP TABLE a;--", v, v]),
    );
    expect([...m.keys()]).toEqual([v]);
    const muchos = Array.from({ length: 250 }, () => '00000000-0000-4000-8000-000000000000');
    expect(valor(await resumenesDeContenidoDeVersiones(a.e.consultor, a.e.campanaId, muchos)).size).toBe(0);
  });
});
