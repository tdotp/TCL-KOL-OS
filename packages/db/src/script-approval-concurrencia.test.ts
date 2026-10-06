/**
 * V2 · Fase 7 — concurrencia y atomicidad de la aprobación de guiones, contra PostgreSQL real.
 *
 * Las carreras se prueban con `Promise.all` y VENTANAS DETERMINISTAS: un trigger de prueba mete un
 * `pg_sleep` en un punto concreto (por ejemplo, tras escribir la aprobación y antes del commit), de modo que
 * la segunda operación llega siempre mientras la primera retiene sus bloqueos. Los fallos a mitad de camino se
 * inyectan igual (trigger que lanza una excepción SOLO para el recurso de la prueba).
 *
 * Orden de bloqueo que se verifica: acción propuesta → campaña → entregable → versión → Brief rector.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Result, User } from '@tcl-kol-os/domain';
import { closePool, query } from './client.ts';
import { confirmarAccion, ejecutarAccion } from './proposed-actions.ts';
import { crearComentarioDeRevision, solicitarCambiosDeScript } from './script-review.ts';
import { aprobarScriptVersion } from './script-approval.ts';
import {
  type EscenarioDeAprobacion,
  type PuntoDeFallo,
  aprobacionesDelEntregable,
  aprobarDirecto,
  codigo,
  confirmarAprobacion,
  conDemora,
  conFalloEn,
  contarAuditoria,
  crearEscenarioDeAprobacion,
  ejecutarAprobacion,
  esperar,
  estadoDeAccion,
  estadoDeVersion,
  fuenteDeGuionNueva,
  huellaDe,
  otraVersionRevisada,
  proponerAprobacion,
  razon,
  registrarFuente,
  revisarComoHumano,
  valor,
  versionRevisada,
} from './script-approval-test-support.ts';
import { crearVersionHija } from './versioning.ts';
import { limpiarEscenarioDeContenido } from './test-utils.ts';

let a: EscenarioDeAprobacion;

beforeAll(async () => {
  a = await crearEscenarioDeAprobacion('F7 concurrencia');
});

afterAll(async () => {
  await limpiarEscenarioDeContenido(a.e);
  await closePool();
});

const VENTANA_S = 1.2;
const LLEGADA_MS = 350;

/** Lanza `primera`, deja que llegue a su bloqueo y lanza `segunda` mientras la primera aún lo retiene. */
async function carrera<A, B>(primera: () => Promise<A>, segunda: () => Promise<B>): Promise<[A, B]> {
  const p1 = primera();
  await esperar(LLEGADA_MS);
  const p2 = segunda();
  return Promise.all([p1, p2]);
}

const aprobadasDe = async (deliverableId: string): Promise<string[]> =>
  (
    await query<{ id: string }>(
      `SELECT id FROM script_versions WHERE deliverable_id = $1 AND status = 'approved'`,
      [deliverableId],
    )
  ).map((r) => r.id);

// ─────────────────────────── Sobre la acción propuesta ─────────────────────────

describe('la fila de la acción serializa confirmar y ejecutar', () => {
  it('dos confirmaciones simultáneas: una gana, la otra recibe PROPOSAL_INVALID_STATE; una sola auditoría', async () => {
    const { versionId } = await versionRevisada(a.e);
    const propuesta = await proponerAprobacion(a.e, versionId);
    const rs = await Promise.all([
      confirmarAprobacion(a.e.director, propuesta),
      confirmarAprobacion(a.e.admin, propuesta),
    ]);
    expect(rs.filter((r) => r.ok)).toHaveLength(1);
    expect(rs.filter((r) => !r.ok).map((r) => codigo(r))).toEqual(['PROPOSAL_INVALID_STATE']);
    expect(await contarAuditoria(propuesta.id, 'proposed_action.confirm')).toBe(1);
    expect(await estadoDeVersion(versionId)).toBe('in_review');
  });

  it('dos ejecuciones simultáneas: una aprueba, la otra no; UNA aprobación y UNA ejecución auditadas', async () => {
    const { deliverableId, versionId } = await versionRevisada(a.e);
    const propuesta = await proponerAprobacion(a.e, versionId);
    valor(await confirmarAprobacion(a.e.director, propuesta));
    const rs = await Promise.all([
      ejecutarAprobacion(a.e.director, propuesta),
      ejecutarAprobacion(a.e.director, propuesta),
    ]);
    expect(rs.filter((r) => r.ok)).toHaveLength(1);
    expect(rs.filter((r) => !r.ok).map((r) => codigo(r))).toEqual(['PROPOSAL_INVALID_STATE']);
    expect(await contarAuditoria(propuesta.id, 'proposed_action.execute')).toBe(1);
    expect(await contarAuditoria(versionId, 'script_version.approve')).toBe(1);
    expect(await aprobadasDe(deliverableId)).toEqual([versionId]);
  });

  it('ejecutar ‖ aprobación directa: gana la primera; la otra falla sin efecto (ejecutar primero)', async () => {
    const { deliverableId, versionId } = await versionRevisada(a.e);
    const propuesta = await proponerAprobacion(a.e, versionId);
    valor(await confirmarAprobacion(a.e.director, propuesta));
    const huella = await huellaDe(versionId);
    await conDemora('aprobar', versionId, VENTANA_S, async () => {
      const [porPropuesta, directa] = await carrera(
        () => ejecutarAprobacion(a.e.director, propuesta),
        () => aprobarScriptVersion(a.e.admin, versionId, { huellaVista: huella }),
      );
      expect(porPropuesta.ok).toBe(true);
      expect(codigo(directa)).toBe('SCRIPT_INVALID_TRANSITION'); // ya no está en revisión
    });
    expect(await contarAuditoria(versionId, 'script_version.approve')).toBe(1);
    expect(await aprobadasDe(deliverableId)).toEqual([versionId]);
    const [f] = await query<{ approved_via_proposed_action_id: string | null }>(
      `SELECT approved_via_proposed_action_id FROM script_versions WHERE id = $1`,
      [versionId],
    );
    expect(f!.approved_via_proposed_action_id).toBe(propuesta.id);
  });

  it('ejecutar ‖ aprobación directa: la directa primero; la ejecución revalida BAJO bloqueo y no aprueba dos veces', async () => {
    const { deliverableId, versionId } = await versionRevisada(a.e);
    const propuesta = await proponerAprobacion(a.e, versionId);
    valor(await confirmarAprobacion(a.e.director, propuesta));
    const huella = await huellaDe(versionId);
    await conDemora('aprobar', versionId, VENTANA_S, async () => {
      const [directa, porPropuesta] = await carrera(
        () => aprobarScriptVersion(a.e.admin, versionId, { huellaVista: huella }),
        () => ejecutarAprobacion(a.e.director, propuesta),
      );
      expect(directa.ok).toBe(true);
      // La verificación previa (sin bloqueo) aún vio la versión en revisión; la de DENTRO del caso de uso, no.
      expect(codigo(porPropuesta)).toBe('SCRIPT_INVALID_TRANSITION');
    });
    expect(await contarAuditoria(versionId, 'script_version.approve')).toBe(1);
    expect(await aprobacionesDelEntregable(deliverableId)).toBe(1);
    // La acción no se ejecutó: sigue confirmada (y ya obsoleta); no hay marca de propuesta en la versión.
    expect(await estadoDeAccion(propuesta.id)).toBe('confirmed');
    expect(await contarAuditoria(propuesta.id, 'proposed_action.execute')).toBe(0);
  });

  it('doce aprobaciones directas simultáneas de la misma versión: UNA gana y el resto falla por estado', async () => {
    const { deliverableId, versionId } = await versionRevisada(a.e);
    const huella = await huellaDe(versionId);
    const rs = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        aprobarScriptVersion(i % 2 === 0 ? a.e.director : a.e.admin, versionId, { huellaVista: huella }),
      ),
    );
    expect(rs.filter((r) => r.ok)).toHaveLength(1);
    for (const r of rs.filter((x) => !x.ok)) expect(codigo(r)).toBe('SCRIPT_INVALID_TRANSITION');
    expect(await contarAuditoria(versionId, 'script_version.approve')).toBe(1);
    expect(await aprobadasDe(deliverableId)).toEqual([versionId]);
  });
});

// ─────────────────────────── Sobre el mutex del entregable ─────────────────────

describe('el mutex del entregable serializa aprobar con lo demás', () => {
  it('aprobar V1 ‖ registrar V2: se serializan; V2 nace recibida y V1 queda aprobada (la aprobación va primero)', async () => {
    const { deliverableId, versionId } = await versionRevisada(a.e);
    const huellaVista = await huellaDe(versionId);
    const fuente = await fuenteDeGuionNueva(a.e);
    let finAprobar = 0;
    let finRegistrar = 0;
    await conDemora('aprobar', versionId, VENTANA_S, async () => {
      const [aprobada, registrada] = await carrera(
        async () => {
          const r = await aprobarScriptVersion(a.e.director, versionId, { huellaVista });
          finAprobar = Date.now();
          return r;
        },
        async () => {
          const r = await registrarFuente(a.e, deliverableId, fuente);
          finRegistrar = Date.now();
          return r;
        },
      );
      expect(aprobada.ok).toBe(true);
      expect(registrada.ok).toBe(true);
    });
    expect(finRegistrar).toBeGreaterThanOrEqual(finAprobar); // esperó el mutex
    const [v2] = await query<{ id: string; status: string; version: number }>(
      `SELECT id, status, version FROM script_versions WHERE deliverable_id = $1 AND version = 2`,
      [deliverableId],
    );
    expect(v2).toMatchObject({ status: 'received', version: 2 });
    expect(await estadoDeVersion(versionId)).toBe('approved'); // V2 recibida no reemplaza a V1
  });

  it('registrar V2 ‖ aprobar V1: si V2 entra primero, la aprobación con la huella vieja falla (PROPOSAL_STALE)', async () => {
    const { deliverableId, versionId } = await versionRevisada(a.e);
    const huellaVista = await huellaDe(versionId);
    const fuente = await fuenteDeGuionNueva(a.e);
    await conDemora('alta_de_version', deliverableId, VENTANA_S, async () => {
      const [registrada, aprobada] = await carrera(
        () => registrarFuente(a.e, deliverableId, fuente),
        () => aprobarScriptVersion(a.e.director, versionId, { huellaVista }),
      );
      expect(registrada.ok).toBe(true);
      expect(codigo(aprobada)).toBe('PROPOSAL_STALE');
      expect(razon(aprobada)).toBe('view_stale');
    });
    expect(await estadoDeVersion(versionId)).toBe('in_review');
    expect(await contarAuditoria(versionId, 'script_version.approve')).toBe(0);
  });

  it('aprobar V3 ‖ aprobar V4 (V4 primero): gana V4; la de número menor falla porque ya fue reemplazada', async () => {
    const { deliverableId, versionId: v3 } = await versionRevisada(a.e);
    const v4 = (await otraVersionRevisada(a.e, deliverableId)).versionId;
    const h3 = await huellaDe(v3);
    const h4 = await huellaDe(v4);
    await conDemora('aprobar', v4, VENTANA_S, async () => {
      const [r4, r3] = await carrera(
        () => aprobarScriptVersion(a.e.director, v4, { huellaVista: h4 }),
        () => aprobarScriptVersion(a.e.admin, v3, { huellaVista: h3 }),
      );
      expect(r4.ok).toBe(true);
      expect(codigo(r3)).toBe('SCRIPT_INVALID_TRANSITION');
    });
    expect(await aprobadasDe(deliverableId)).toEqual([v4]);
    expect(await estadoDeVersion(v3)).toBe('superseded');
    expect(await contarAuditoria(v3, 'script_version.approve')).toBe(0);
  });

  it('aprobar V3 ‖ aprobar V4 (V3 primero): la de número mayor, con la huella previa a V3, falla (PROPOSAL_STALE); queda V3', async () => {
    const { deliverableId, versionId: v3 } = await versionRevisada(a.e);
    const v4 = (await otraVersionRevisada(a.e, deliverableId)).versionId;
    const h3 = await huellaDe(v3);
    const h4 = await huellaDe(v4);
    await conDemora('aprobar', v3, VENTANA_S, async () => {
      const [r3, r4] = await carrera(
        () => aprobarScriptVersion(a.e.director, v3, { huellaVista: h3 }),
        () => aprobarScriptVersion(a.e.admin, v4, { huellaVista: h4 }),
      );
      expect(r3.ok).toBe(true);
      expect(codigo(r4)).toBe('PROPOSAL_STALE'); // cambió «replaces»: V4 vio otro mundo
      expect(razon(r4)).toBe('view_stale');
    });
    expect(await aprobadasDe(deliverableId)).toEqual([v3]);
    expect(await estadoDeVersion(v4)).toBe('in_review');
  });

  it('aprobar ‖ pedir cambios: si aprueba primero, pedir cambios ve la versión cerrada (not_open)', async () => {
    const { versionId } = await versionRevisada(a.e);
    const huellaVista = await huellaDe(versionId);
    await conDemora('aprobar', versionId, VENTANA_S, async () => {
      const [aprobada, cambios] = await carrera(
        () => aprobarScriptVersion(a.e.director, versionId, { huellaVista }),
        () =>
          solicitarCambiosDeScript(a.e.consultor, versionId, { items: [{ body: 'Reescribir el cierre' }] }),
      );
      expect(aprobada.ok).toBe(true);
      expect(codigo(cambios)).toBe('RESOURCE_CONFLICT');
      expect(razon(cambios)).toBe('not_open');
    });
    expect(await estadoDeVersion(versionId)).toBe('approved');
    const [{ n }] = (await query<{ n: string }>(
      `SELECT count(*)::text AS n FROM script_review_comments WHERE script_version_id = $1`,
      [versionId],
    )) as [{ n: string }];
    expect(n).toBe('0');
  });

  it('pedir cambios ‖ aprobar: si pide cambios primero, la aprobación falla por estado y no aprueba', async () => {
    const { versionId } = await versionRevisada(a.e);
    const huellaVista = await huellaDe(versionId);
    await conDemora('comentario', versionId, VENTANA_S, async () => {
      const [cambios, aprobada] = await carrera(
        () =>
          solicitarCambiosDeScript(a.e.consultor, versionId, { items: [{ body: 'Reescribir el cierre' }] }),
        () => aprobarScriptVersion(a.e.director, versionId, { huellaVista }),
      );
      expect(cambios.ok).toBe(true);
      expect(codigo(aprobada)).toBe('SCRIPT_INVALID_TRANSITION');
    });
    expect(await estadoDeVersion(versionId)).toBe('changes_requested');
    expect(await contarAuditoria(versionId, 'script_version.approve')).toBe(0);
  });

  it('aprobar ‖ comentar: si aprueba primero, el comentario ve la versión cerrada', async () => {
    const { versionId } = await versionRevisada(a.e);
    const huellaVista = await huellaDe(versionId);
    await conDemora('aprobar', versionId, VENTANA_S, async () => {
      const [aprobada, comentario] = await carrera(
        () => aprobarScriptVersion(a.e.director, versionId, { huellaVista }),
        () => crearComentarioDeRevision(a.e.consultor, versionId, { kind: 'editorial', body: 'Tarde' }),
      );
      expect(aprobada.ok).toBe(true);
      expect(codigo(comentario)).toBe('RESOURCE_CONFLICT');
      expect(razon(comentario)).toBe('not_open');
    });
    expect(await estadoDeVersion(versionId)).toBe('approved');
  });

  it('comentar ‖ aprobar: si el comentario entra primero, la huella mostrada ya no vale (view_stale) y no aprueba', async () => {
    const { versionId } = await versionRevisada(a.e);
    const huellaVista = await huellaDe(versionId);
    await conDemora('comentario', versionId, VENTANA_S, async () => {
      const [comentario, aprobada] = await carrera(
        () => crearComentarioDeRevision(a.e.consultor, versionId, { kind: 'editorial', body: 'A tiempo' }),
        () => aprobarScriptVersion(a.e.director, versionId, { huellaVista }),
      );
      expect(comentario.ok).toBe(true);
      expect(codigo(aprobada)).toBe('PROPOSAL_STALE');
      expect(razon(aprobada)).toBe('view_stale');
    });
    expect(await estadoDeVersion(versionId)).toBe('in_review');
    // Con la huella nueva sí se aprueba (la persona vio el comentario).
    expect((await aprobarDirecto(a.e.director, versionId)).ok).toBe(true);
  });
});

// ─────────────────────────── Sobre el Brief rector ─────────────────────────────

describe('el Brief rector se bloquea FOR SHARE: aprobar ‖ crear la versión hija del Brief', () => {
  it('aprobar primero: crear la hija ESPERA a que la aprobación termine; ambas proceden y el guion queda aprobado contra el Brief que regía', async () => {
    const { versionId } = await versionRevisada(a.e);
    const rector = (
      await query<{ id: string }>(`SELECT brief_rector_de_campana($1) AS id`, [a.e.campanaId])
    )[0]!.id;
    const huellaVista = await huellaDe(versionId);
    let finAprobar = 0;
    let finHija = 0;
    await conDemora('aprobar', versionId, VENTANA_S, async () => {
      const [aprobada, hija] = await carrera(
        async () => {
          const r = await aprobarScriptVersion(a.e.director, versionId, { huellaVista });
          finAprobar = Date.now();
          return r;
        },
        async () => {
          const r = await crearVersionHija(a.e.admin, rector);
          finHija = Date.now();
          return r;
        },
      );
      expect(aprobada.ok).toBe(true);
      expect(hija.ok).toBe(true);
    });
    expect(finHija).toBeGreaterThanOrEqual(finAprobar); // la hija esperó el FOR SHARE
    const [f] = await query<{ approved_brief_version_id: string }>(
      `SELECT approved_brief_version_id FROM script_versions WHERE id = $1`,
      [versionId],
    );
    expect(f!.approved_brief_version_id).toBe(rector);
  });

  it('la hija primero: la aprobación espera el UPDATE del padre y luego procede (el padre sigue siendo el rector mientras la hija es borrador)', async () => {
    const e = (await crearEscenarioDeAprobacion('F7 concurrencia brief hija')).e;
    try {
      const { versionId } = await versionRevisada(e);
      const rector = (
        await query<{ id: string }>(`SELECT brief_rector_de_campana($1) AS id`, [e.campanaId])
      )[0]!.id;
      const huellaVista = await huellaDe(versionId);
      let finAprobar = 0;
      let finHija = 0;
      await conDemora('brief_hijo', rector, VENTANA_S, async () => {
        const [hija, aprobada] = await carrera(
          async () => {
            const r = await crearVersionHija(e.admin, rector);
            finHija = Date.now();
            return r;
          },
          async () => {
            const r = await aprobarScriptVersion(e.director, versionId, { huellaVista });
            finAprobar = Date.now();
            return r;
          },
        );
        expect(hija.ok).toBe(true);
        expect(aprobada.ok).toBe(true);
      });
      expect(finAprobar).toBeGreaterThanOrEqual(finHija); // la aprobación esperó al UPDATE del padre
      expect(await estadoDeVersion(versionId)).toBe('approved');
    } finally {
      await limpiarEscenarioDeContenido(e);
    }
  });
});

// ─────────────────────────── Atomicidad con fallos inyectados ──────────────────

interface Estado {
  readonly v1: Record<string, unknown>;
  readonly v2: Record<string, unknown>;
  readonly fuenteDeV1: string;
  readonly accion?: string;
  readonly aprobaciones: number;
  readonly reemplazos: number;
  readonly cambiosDeVigente: number;
  readonly bajadasDeVisibilidad: number;
  readonly ejecuciones: number;
}

interface Montaje {
  readonly deliverableId: string;
  readonly v1: string;
  readonly v2: string;
  readonly fuenteDeV1: string;
}

/** V1 aprobada (con su fuente expuesta a TCL) y V2 revisada: aprobar V2 reemplaza a V1 y baja su fuente. */
async function montarConAnterior(): Promise<Montaje> {
  const { deliverableId, versionId: v1 } = await versionRevisada(a.e);
  valor(await aprobarDirecto(a.e.director, v1));
  const [fuente] = await query<{ source_document_id: string }>(
    `SELECT source_document_id FROM script_versions WHERE id = $1`,
    [v1],
  );
  await query(`UPDATE source_documents SET visibility = 'tcl' WHERE id = $1`, [fuente!.source_document_id]);
  const v2 = (await otraVersionRevisada(a.e, deliverableId)).versionId;
  return { deliverableId, v1, v2, fuenteDeV1: fuente!.source_document_id };
}

async function estadoDe(m: Montaje, accionId?: string): Promise<Estado> {
  const versionRow = async (id: string): Promise<Record<string, unknown>> =>
    (
      await query<Record<string, unknown>>(
        `SELECT status, approved_by, approved_at, approved_via_proposed_action_id, approved_analysis_id,
                approved_brief_version_id, approval_snapshot, superseded_by_version_id, superseded_at
           FROM script_versions WHERE id = $1`,
        [id],
      )
    )[0]!;
  const visibilidad = (
    await query<{ visibility: string }>(
      `SELECT visibility::text AS visibility FROM source_documents WHERE id = $1`,
      [m.fuenteDeV1],
    )
  )[0]!.visibility;
  const contar = async (sql: string, p: unknown[]): Promise<number> =>
    Number((await query<{ n: string }>(sql, p))[0]!.n);
  return {
    v1: { ...(await versionRow(m.v1)), fuente: visibilidad },
    v2: await versionRow(m.v2),
    fuenteDeV1: visibilidad,
    ...(accionId === undefined ? {} : { accion: await estadoDeAccion(accionId) }),
    aprobaciones: await contar(
      `SELECT count(*)::text AS n FROM audit_events WHERE entity_id = $1 AND action = 'script_version.approve'`,
      [m.v2],
    ),
    reemplazos: await contar(
      `SELECT count(*)::text AS n FROM audit_events WHERE entity_id = $1 AND action = 'script_version.supersede'`,
      [m.v1],
    ),
    cambiosDeVigente: await contar(
      `SELECT count(*)::text AS n FROM audit_events
        WHERE entity_id = $1 AND action = 'deliverable.current_approved_changed'
          AND (metadata->>'to') = $2`,
      [m.deliverableId, m.v2],
    ),
    bajadasDeVisibilidad: await contar(
      `SELECT count(*)::text AS n FROM audit_events
        WHERE entity_id = $1 AND action = 'source.set_visibility' AND metadata->>'reason' = 'script_superseded'`,
      [m.fuenteDeV1],
    ),
    ejecuciones:
      accionId === undefined
        ? 0
        : await contar(
            `SELECT count(*)::text AS n FROM audit_events WHERE entity_id = $1 AND action = 'proposed_action.execute'`,
            [accionId],
          ),
  };
}

const fallo = async <T>(p: Promise<Result<T>>): Promise<boolean> =>
  p.then(
    (r) => !r.ok,
    () => true,
  );

const PUNTOS_HITL: ReadonlyArray<{ punto: PuntoDeFallo; clave: (m: Montaje, accionId: string) => string }> = [
  { punto: 'marcar_executed', clave: (_m, accion) => accion },
  { punto: 'auditoria_execute', clave: (_m, accion) => accion },
  { punto: 'auditoria_aprobar', clave: (m) => m.v2 },
  { punto: 'auditoria_current_changed', clave: (m) => m.deliverableId },
  { punto: 'auditoria_supersede', clave: (m) => m.deliverableId },
  { punto: 'supersede', clave: (m) => m.deliverableId },
  { punto: 'aprobar_update', clave: (m) => m.v2 },
  { punto: 'bajada_visibilidad', clave: (m) => m.fuenteDeV1 },
];

describe('atomicidad por el camino HITL: o se aplica todo o no se aplica nada', () => {
  for (const { punto, clave } of PUNTOS_HITL) {
    it(`si falla «${punto}»: V1 y V2 intactas, su fuente sigue expuesta, la acción sigue confirmed y el reintento completa UNA vez`, async () => {
      const m = await montarConAnterior();
      const propuesta = await proponerAprobacion(a.e, m.v2);
      valor(await confirmarAprobacion(a.e.director, propuesta));
      const antes = await estadoDe(m, propuesta.id);
      expect(antes).toMatchObject({
        accion: 'confirmed',
        aprobaciones: 0,
        reemplazos: 0,
        cambiosDeVigente: 0,
        bajadasDeVisibilidad: 0,
        ejecuciones: 0,
        fuenteDeV1: 'tcl',
      });
      expect(antes.v1['status']).toBe('approved');
      expect(antes.v2['status']).toBe('in_review');

      await conFalloEn(punto, clave(m, propuesta.id), async () => {
        expect(await fallo(ejecutarAprobacion(a.e.director, propuesta)), 'el fallo se propaga').toBe(true);
      });

      // Nada quedó a medias: exactamente el estado de antes.
      expect(await estadoDe(m, propuesta.id)).toEqual(antes);

      // El reintento (sin el fallo) reconcilia: completa UNA sola vez.
      const r = valor(await ejecutarAprobacion(a.e.director, propuesta));
      expect(r.status).toBe('executed');
      const despues = await estadoDe(m, propuesta.id);
      expect(despues).toMatchObject({
        accion: 'executed',
        aprobaciones: 1,
        reemplazos: 1,
        cambiosDeVigente: 1,
        bajadasDeVisibilidad: 1,
        ejecuciones: 1,
        fuenteDeV1: 'interna',
      });
      expect(despues.v1['status']).toBe('superseded');
      expect(despues.v2['status']).toBe('approved');
      expect(await aprobadasDe(m.deliverableId)).toEqual([m.v2]);
    });
  }
});

describe('atomicidad por la vía directa: un fallo a mitad de camino no deja nada aplicado', () => {
  const PUNTOS_DIRECTOS = PUNTOS_HITL.filter(
    (p) => p.punto !== 'marcar_executed' && p.punto !== 'auditoria_execute',
  );
  for (const { punto, clave } of PUNTOS_DIRECTOS) {
    it(`si falla «${punto}», la aprobación se deshace entera y reintentar funciona`, async () => {
      const m = await montarConAnterior();
      const antes = await estadoDe(m);
      await conFalloEn(punto, clave(m, 'sin-accion'), async () => {
        expect(await fallo(aprobarDirecto(a.e.director, m.v2))).toBe(true);
      });
      expect(await estadoDe(m)).toEqual(antes);
      const ok = valor(await aprobarDirecto(a.e.director, m.v2));
      expect(ok.replaced.map((r) => r.version)).toEqual([1]);
      const despues = await estadoDe(m);
      expect(despues).toMatchObject({
        aprobaciones: 1,
        reemplazos: 1,
        cambiosDeVigente: 1,
        bajadasDeVisibilidad: 1,
        fuenteDeV1: 'interna',
      });
    });
  }
});

describe('un rechazo de la base en la escritura se devuelve como error de dominio, sin dejar nada a medias', () => {
  it('si un trigger rechaza el UPDATE de la aprobación, el caso de uso devuelve RESOURCE_CONFLICT{db_rule} (savepoint) y la acción sigue confirmada', async () => {
    const m = await montarConAnterior();
    const propuesta = await proponerAprobacion(a.e, m.v2);
    valor(await confirmarAprobacion(a.e.director, propuesta));
    const antes = await estadoDe(m, propuesta.id);
    // Un trigger de la base rechaza el UPDATE de la aprobación (como lo haría el de 023 ante un rol no permitido).
    let r: Result<unknown> | undefined;
    await conFalloEn('aprobar_update', m.v2, async () => {
      r = await ejecutarAccion(a.e.director, propuesta.id, { canal: 'ui' });
    });
    expect(codigo(r!)).toBe('RESOURCE_CONFLICT');
    expect(razon(r!)).toBe('db_rule');
    expect(await estadoDe(m, propuesta.id)).toEqual(antes);
    // Reintentar sin el fallo aprueba.
    expect(valor(await ejecutarAccion(a.e.director, propuesta.id, { canal: 'ui' })).status).toBe('executed');
  });

  it('la confirmación de otra persona no interfiere: ejecutar con quien no confirmó no toca nada', async () => {
    const { versionId } = await versionRevisada(a.e);
    const propuesta = await proponerAprobacion(a.e, versionId);
    valor(
      await confirmarAccion(a.e.director, propuesta.id, { canal: 'ui', payloadHash: propuesta.payloadHash }),
    );
    const otro: User = a.e.admin;
    expect(codigo(await ejecutarAccion(otro, propuesta.id, { canal: 'ui' }))).toBe(
      'HUMAN_CONFIRMATION_REQUIRED',
    );
    expect(await estadoDeVersion(versionId)).toBe('in_review');
    await revisarComoHumano(versionId, a.e.director); // cambia la huella: la ejecución del director ya no vale
    expect(codigo(await ejecutarAprobacion(a.e.director, propuesta))).toBe('PROPOSAL_STALE');
    expect(await estadoDeVersion(versionId)).toBe('in_review');
  });
});
