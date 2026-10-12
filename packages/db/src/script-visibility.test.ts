/**
 * V2 · Fase 7 — visibilidad y alcance de las fuentes de los guiones, contra PostgreSQL real.
 *
 * Un guion que no es la aprobada vigente no se expone a TCL ni lo lee el Operativo; el original de
 * una fuente enlazada a un guion no cambia ni se reprocesa; y un guion NUNCA alimenta la extracción
 * ni la evidencia del Brief (el análisis se haría contra un Brief alimentado por el propio guion).
 */

import { obtenerDocumentosParaTcl } from './tcl-projection.ts';
import { CON_REVISION_DE_LA_VERSION, prepararRevisionPorSql } from './aprobacion-sql-test-support.ts';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Result } from '@tcl-kol-os/domain';
import { asociarInfluencerACampana } from './campaign-influencers.ts';
import { closePool, query, transaction } from './client.ts';
import { crearEntregable } from './deliverables.ts';
import { extraerCampos } from './extraction.ts';
import { crearInfluencer } from './influencers.ts';
import { buscarEvidencia, buscarEvidenciaComoActor, buscarTextoEnFuentes } from './search.ts';
import { registrarVersionDeGuion } from './script-versions.ts';
import { getFragments, getSource, listSources, retrySource, setSourceVisibility } from './sources.ts';
import {
  type EscenarioDeContenido,
  crearEscenarioDeContenido,
  crearFuenteDeGuionDePrueba,
  limpiarEscenarioDeContenido,
} from './test-utils.ts';

let e: EscenarioDeContenido;

const valor = <T>(r: Result<T>): T => {
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
  return r.value;
};
const codigo = <T>(r: Result<T>): string | undefined => (r.ok ? undefined : r.error.code);
const razon = <T>(r: Result<T>): unknown =>
  r.ok ? undefined : (r.error.details as { reason?: unknown } | undefined)?.reason;

const VECTOR = [1, ...new Array<number>(1535).fill(0)];

async function conBypass(fn: (c: pg.PoolClient) => Promise<void>): Promise<void> {
  await transaction(async (c) => {
    await c.query(`SET LOCAL tclkolos.permitir_borrado_historico = 'on'`);
    await fn(c);
  });
}

/** Registra un guion NUEVO (entregable desechable de Diego) y devuelve su versión y su fuente. */
let n = 0;
async function guionRegistrado(
  etiqueta: string,
  estado?: Parameters<typeof crearFuenteDeGuionDePrueba>[3],
): Promise<{ versionId: string; sourceId: string }> {
  const sourceId = await crearFuenteDeGuionDePrueba(e.campanaId, e.admin, etiqueta, estado);
  const d = valor(
    await crearEntregable(e.consultor, {
      campaignInfluencerId: e.participaciones.diego,
      label: `Vis ${++n} ${etiqueta}`,
    }),
  );
  const r = valor(
    await registrarVersionDeGuion(e.consultor, {
      campaignId: e.campanaId,
      sourceId,
      participation: { participationId: e.participaciones.diego },
      deliverable: { id: d.id },
    }),
  );
  if (r.kind !== 'registered') throw new Error('se esperaba una versión nueva');
  return { versionId: r.version.id, sourceId };
}

const fijarAprobada = (versionId: string) =>
  conBypass(async (c) => {
    await c.query(
      `UPDATE script_versions SET status = 'approved', approved_by = $2, approved_at = now() WHERE id = $1`,
      [versionId, e.director.id],
    );
  });

const visibilidad = async (sourceId: string): Promise<string> =>
  (
    await query<{ visibility: string }>(
      `SELECT visibility::text AS visibility FROM source_documents WHERE id = $1`,
      [sourceId],
    )
  )[0]!.visibility;

async function rechazo(sql: string, params: unknown[] = []): Promise<string> {
  try {
    await query(sql, params);
    return '';
  } catch (error) {
    return (error as Error).message;
  }
}

beforeAll(async () => {
  e = await crearEscenarioDeContenido('F7 visibilidad');
});
afterAll(async () => {
  await limpiarEscenarioDeContenido(e);
  await closePool();
});

describe('una fuente de guion no aprobado no se expone a TCL', () => {
  it('setSourceVisibility a tcl o compartida con una versión recibida enlazada: conflicto, sin cambio', async () => {
    const { sourceId } = await guionRegistrado('visibilidad-borrador');
    for (const destino of ['tcl', 'compartida'] as const) {
      const r = await setSourceVisibility(e.admin, sourceId, destino);
      expect(codigo(r), destino).toBe('RESOURCE_CONFLICT');
      expect(razon(r)).toBe('bound_to_script_version');
    }
    expect(await visibilidad(sourceId)).toBe('interna');
    // bajar o dejar interna siempre se puede
    expect(valor(await setSourceVisibility(e.admin, sourceId, 'interna'))).toEqual({ visibility: 'interna' });
  });

  it('la base lo impone por SQL directo (también para recibida, en revisión, con cambios y reemplazada)', async () => {
    const { versionId, sourceId } = await guionRegistrado('visibilidad-sql');
    for (const estado of ['received', 'in_review', 'changes_requested'] as const) {
      await conBypass(async (c) => {
        await c.query(`UPDATE script_versions SET status = $2 WHERE id = $1`, [versionId, estado]);
      });
      expect(
        await rechazo(`UPDATE source_documents SET visibility = 'tcl' WHERE id = $1`, [sourceId]),
        estado,
      ).toMatch(/no es la aprobada vigente/);
      expect(
        await rechazo(`UPDATE source_documents SET visibility = 'compartida' WHERE id = $1`, [sourceId]),
        estado,
      ).toMatch(/no es la aprobada vigente/);
    }
    expect(await visibilidad(sourceId)).toBe('interna');
  });

  it('la fuente de la aprobada vigente SÍ puede exponerse (decisión humana explícita)', async () => {
    const { versionId, sourceId } = await guionRegistrado('visibilidad-aprobada');
    await fijarAprobada(versionId);
    expect(valor(await setSourceVisibility(e.admin, sourceId, 'tcl'))).toEqual({ visibility: 'tcl' });
    expect(await visibilidad(sourceId)).toBe('tcl');
  });

  it('reemplazar una versión cuya fuente sigue visible lo rechaza la base; la aplicación la baja primero', async () => {
    const d = valor(
      await crearEntregable(e.consultor, {
        campaignInfluencerId: e.participaciones.diego,
        label: `Reemplazo ${++n}`,
      }),
    );
    const registrar = async (etiqueta: string) => {
      const sourceId = await crearFuenteDeGuionDePrueba(e.campanaId, e.admin, etiqueta);
      const r = valor(
        await registrarVersionDeGuion(e.consultor, {
          campaignId: e.campanaId,
          sourceId,
          participation: { participationId: e.participaciones.diego },
          deliverable: { id: d.id },
        }),
      );
      if (r.kind !== 'registered') throw new Error('se esperaba una versión nueva');
      return { versionId: r.version.id, sourceId };
    };
    const v1 = await registrar('reemplazo-1');
    const v2 = await registrar('reemplazo-2');
    await fijarAprobada(v1.versionId);
    await setSourceVisibility(e.admin, v1.sourceId, 'tcl');
    await prepararRevisionPorSql(e, v2.versionId);
    await conBypass(async (c) => {
      await c.query(`UPDATE script_versions SET status = 'in_review' WHERE id = $1`, [v2.versionId]);
    });

    const aReemplazar = `UPDATE script_versions SET status = 'superseded', superseded_by_version_id = $2 WHERE id = $1`;
    // con la fuente visible: la base lo rechaza
    expect(await rechazo(aReemplazar, [v1.versionId, v2.versionId])).toMatch(/Baje a interna/);
    // la aplicación la baja primero (decisión explícita y auditada) y entonces el reemplazo procede
    valor(await setSourceVisibility(e.admin, v1.sourceId, 'interna'));
    await transaction(async (c) => {
      await c.query(aReemplazar, [v1.versionId, v2.versionId]);
      await c.query(
        `UPDATE script_versions SET status = 'approved', approved_by = $2, ${CON_REVISION_DE_LA_VERSION} WHERE id = $1`,
        [v2.versionId, e.director.id],
      );
    });
    // la versión reemplazada ya no es la vigente: su fuente no se vuelve a exponer
    const r = await setSourceVisibility(e.admin, v1.sourceId, 'tcl');
    expect(razon(r)).toBe('bound_to_script_version');
  });

  it('una fuente SIN guion se sigue exponiendo con normalidad (sin regresión)', async () => {
    const f = await crearFuenteDeGuionDePrueba(e.campanaId, e.admin, 'sin-guion-visible');
    expect(valor(await setSourceVisibility(e.admin, f, 'tcl'))).toEqual({ visibility: 'tcl' });
  });
});

describe('el original de una fuente enlazada a un guion no cambia', () => {
  it('hash, nombre, archivo, MIME, tamaño, campaña, organización y origen son inmutables', async () => {
    const { sourceId } = await guionRegistrado('original-inmutable');
    const cambios = [
      `hash = repeat('d', 64)`,
      `filename = 'otro.md'`,
      `file_id = 'otra/ruta.md'`,
      `mime_type = 'text/plain'`,
      `size_bytes = 99`,
      `campaign_id = '${e.otraCampanaId}'`,
    ];
    for (const set of cambios) {
      expect(await rechazo(`UPDATE source_documents SET ${set} WHERE id = $1`, [sourceId]), set).not.toBe('');
    }
    // lo que el worker sí actualiza no se bloquea (estado y visibilidad interna)
    expect(await rechazo(`UPDATE source_documents SET status = 'procesando' WHERE id = $1`, [sourceId])).toBe(
      '',
    );
    expect(await rechazo(`UPDATE source_documents SET status = 'procesado' WHERE id = $1`, [sourceId])).toBe(
      '',
    );
  });

  it('una fuente sin guion conserva su comportamiento (se puede actualizar el hash)', async () => {
    const f = await crearFuenteDeGuionDePrueba(e.campanaId, e.admin, 'sin-guion-mutable');
    expect(await rechazo(`UPDATE source_documents SET hash = repeat('e', 64) WHERE id = $1`, [f])).toBe('');
  });

  it('una fuente enlazada a un guion no se puede borrar (FK RESTRICT)', async () => {
    const { sourceId } = await guionRegistrado('no-se-borra');
    expect(await rechazo(`DELETE FROM source_documents WHERE id = $1`, [sourceId])).toMatch(
      /foreign key|violates/,
    );
  });
});

describe('retrySource: no reprocesa un guion registrado', () => {
  it('con la fuente procesada: RESOURCE_CONFLICT bound_to_script_version y sin job nuevo', async () => {
    const { sourceId } = await guionRegistrado('retry-procesada');
    const antes = await query<{ id: string }>(`SELECT id FROM processing_jobs WHERE source_id = $1`, [
      sourceId,
    ]);
    const r = await retrySource(e.admin, sourceId);
    expect(codigo(r)).toBe('RESOURCE_CONFLICT');
    expect(razon(r)).toBe('bound_to_script_version');
    expect(await query(`SELECT id FROM processing_jobs WHERE source_id = $1`, [sourceId])).toHaveLength(
      antes.length,
    );
    expect(
      (
        await query<{ status: string }>(`SELECT status::text AS status FROM source_documents WHERE id = $1`, [
          sourceId,
        ])
      )[0]!.status,
    ).toBe('procesado');
  });

  it('con el procesamiento FALLIDO sí se puede reintentar (no hay contenido legible que proteger)', async () => {
    const { sourceId } = await guionRegistrado('retry-fallida', 'fallida');
    expect(valor(await retrySource(e.admin, sourceId))).toBe(true);
    expect(
      (
        await query<{ status: string }>(`SELECT status::text AS status FROM source_documents WHERE id = $1`, [
          sourceId,
        ])
      )[0]!.status,
    ).toBe('pendiente');
  });

  it('una fuente sin guion se reprocesa como siempre', async () => {
    const f = await crearFuenteDeGuionDePrueba(e.campanaId, e.admin, 'retry-sin-guion');
    expect(valor(await retrySource(e.admin, f))).toBe(true);
  });
});

describe('el Operativo no lee guiones que no están aprobados', () => {
  let borrador: { versionId: string; sourceId: string };
  let aprobado: { versionId: string; sourceId: string };
  let suelta: string;
  const MARCA = `marca-operativo-${Date.now().toString(36)}`;

  beforeAll(async () => {
    borrador = await guionRegistrado(`${MARCA}-borrador`);
    aprobado = await guionRegistrado(`${MARCA}-aprobado`);
    await fijarAprobada(aprobado.versionId);
    suelta = await crearFuenteDeGuionDePrueba(e.campanaId, e.admin, `${MARCA}-suelta`);
  });

  it('listSources: el Operativo ve la aprobada y la fuente suelta, NO el borrador; Cuenta ve todo', async () => {
    const ids = (r: Result<{ id: string }[]>) => valor(r).map((f) => f.id);
    const operativo = ids(await listSources(e.operativo, e.campanaId));
    expect(operativo).toContain(aprobado.sourceId);
    expect(operativo).toContain(suelta);
    expect(operativo).not.toContain(borrador.sourceId);
    for (const cuenta of [e.admin, e.director, e.consultor]) {
      const todas = ids(await listSources(cuenta, e.campanaId));
      expect(todas, cuenta.role).toEqual(
        expect.arrayContaining([borrador.sourceId, aprobado.sourceId, suelta]),
      );
    }
  });

  it('getSource y getFragments: el borrador es inexistente para el Operativo; la aprobada se lee', async () => {
    expect(codigo(await getSource(e.operativo, borrador.sourceId))).toBe('RESOURCE_NOT_FOUND');
    expect(codigo(await getFragments(e.operativo, borrador.sourceId))).toBe('RESOURCE_NOT_FOUND');
    expect(valor(await getSource(e.operativo, aprobado.sourceId)).id).toBe(aprobado.sourceId);
    expect(valor(await getFragments(e.operativo, aprobado.sourceId))).toHaveLength(1);
    // Cuenta lee el borrador
    expect(valor(await getSource(e.consultor, borrador.sourceId)).id).toBe(borrador.sourceId);
  });

  it('una aprobada que pasa a reemplazada deja de ser legible para el Operativo', async () => {
    const d = valor(
      await crearEntregable(e.consultor, {
        campaignInfluencerId: e.participaciones.diego,
        label: `Reemplazada ${++n}`,
      }),
    );
    const registrar = async (etiqueta: string) => {
      const sourceId = await crearFuenteDeGuionDePrueba(e.campanaId, e.admin, `${MARCA}-${etiqueta}`);
      const r = valor(
        await registrarVersionDeGuion(e.consultor, {
          campaignId: e.campanaId,
          sourceId,
          participation: { participationId: e.participaciones.diego },
          deliverable: { id: d.id },
        }),
      );
      if (r.kind !== 'registered') throw new Error('se esperaba una versión nueva');
      return { versionId: r.version.id, sourceId };
    };
    const v1 = await registrar('v1');
    const v2 = await registrar('v2');
    await fijarAprobada(v1.versionId);
    expect(valor(await getSource(e.operativo, v1.sourceId)).id).toBe(v1.sourceId);
    await prepararRevisionPorSql(e, v2.versionId);
    await conBypass(async (c) => {
      await c.query(`UPDATE script_versions SET status = 'in_review' WHERE id = $1`, [v2.versionId]);
    });
    await transaction(async (c) => {
      await c.query(
        `UPDATE script_versions SET status = 'superseded', superseded_by_version_id = $2 WHERE id = $1`,
        [v1.versionId, v2.versionId],
      );
      await c.query(
        `UPDATE script_versions SET status = 'approved', approved_by = $2, ${CON_REVISION_DE_LA_VERSION} WHERE id = $1`,
        [v2.versionId, e.director.id],
      );
    });
    // la reemplazada ya no es la vigente: el Operativo ya no la lee; la nueva aprobada, sí
    expect(codigo(await getSource(e.operativo, v1.sourceId))).toBe('RESOURCE_NOT_FOUND');
    expect(valor(await getSource(e.operativo, v2.sourceId)).id).toBe(v2.sourceId);
  });

  it('buscarTextoEnFuentes: el Operativo no encuentra el texto del borrador; sí el de la aprobada', async () => {
    const hits = valor(await buscarTextoEnFuentes(e.operativo, { campaignId: e.campanaId, texto: MARCA }));
    const fuentes = new Set(hits.map((h) => h.sourceId));
    expect(fuentes.has(aprobado.sourceId)).toBe(true);
    expect(fuentes.has(suelta)).toBe(true);
    expect(fuentes.has(borrador.sourceId)).toBe(false);
    const cuenta = valor(await buscarTextoEnFuentes(e.consultor, { campaignId: e.campanaId, texto: MARCA }));
    expect(new Set(cuenta.map((h) => h.sourceId)).has(borrador.sourceId)).toBe(true);
  });

  it('TCL solo ve lo marcado visible: la aprobada si se expone, nunca el borrador (que no puede exponerse)', async () => {
    await query(`UPDATE campaigns SET visibility = 'tcl' WHERE id = $1`, [e.campanaId]);
    try {
      valor(await setSourceVisibility(e.admin, aprobado.sourceId, 'tcl'));
      // Fase 9 (ciclo QA): los lectores legados de fuentes están cerrados al cliente; lo ve por la proyección TCL.
      expect(codigo(await listSources(e.cliente, e.campanaId))).toBe('FORBIDDEN_ROLE');
      expect(codigo(await getSource(e.cliente, aprobado.sourceId))).toBe('FORBIDDEN_ROLE');
      const lista = valor(await obtenerDocumentosParaTcl(e.cliente, e.campanaId)).map((d) => d.sourceId);
      expect(lista).toContain(aprobado.sourceId);
      expect(lista).not.toContain(borrador.sourceId);
    } finally {
      await query(`UPDATE campaigns SET visibility = 'interna' WHERE id = $1`, [e.campanaId]);
    }
  });
});

describe('un guion NUNCA alimenta la extracción ni la evidencia del Brief', () => {
  it('extraerCampos no envía al worker fragmentos de una fuente ligada a un guion', async () => {
    const MARCA_GUION = `guion-no-extraer-${Date.now().toString(36)}`;
    const MARCA_NORMAL = `fuente-normal-${Date.now().toString(36)}`;
    const guion = await guionRegistrado(MARCA_GUION);
    const normal = await crearFuenteDeGuionDePrueba(e.campanaId, e.admin, MARCA_NORMAL);
    const enviado: string[] = [];
    const original = globalThis.fetch;
    vi.stubGlobal('fetch', async (_url: unknown, init?: { body?: string }) => {
      enviado.push(init?.body ?? '');
      throw new Error('worker simulado: se detiene tras capturar la petición');
    });
    try {
      await expect(extraerCampos(e.admin.organizationId, e.campanaId)).rejects.toThrow(/worker simulado/);
    } finally {
      vi.stubGlobal('fetch', original);
    }
    expect(enviado).toHaveLength(1);
    const cuerpo = JSON.parse(enviado[0]!) as { fragmentos: Array<{ source_id: string; filename: string }> };
    const fuentes = new Set(cuerpo.fragmentos.map((f) => f.source_id));
    expect(fuentes.has(normal)).toBe(true);
    expect(fuentes.has(guion.sourceId)).toBe(false);
    // ni siquiera el guion YA aprobado entra a la extracción
    await fijarAprobada(guion.versionId);
    enviado.length = 0;
    vi.stubGlobal('fetch', async (_url: unknown, init?: { body?: string }) => {
      enviado.push(init?.body ?? '');
      throw new Error('worker simulado: se detiene tras capturar la petición');
    });
    try {
      await expect(extraerCampos(e.admin.organizationId, e.campanaId)).rejects.toThrow(/worker simulado/);
    } finally {
      vi.stubGlobal('fetch', original);
    }
    const cuerpo2 = JSON.parse(enviado[0]!) as { fragmentos: Array<{ source_id: string }> };
    expect(cuerpo2.fragmentos.some((f) => f.source_id === guion.sourceId)).toBe(false);
  });

  it('buscarEvidencia (y su variante por actor) nunca devuelve fragmentos de un guion, aprobado o no', async () => {
    const campana = e.otraCampanaId;
    const guion = await crearFuenteDeGuionDePrueba(campana, e.admin, 'evidencia-guion');
    const normal = await crearFuenteDeGuionDePrueba(campana, e.admin, 'evidencia-normal');
    for (const f of [guion, normal]) {
      await query(`UPDATE source_fragments SET embedding = $2::vector WHERE source_id = $1`, [
        f,
        `[${VECTOR.join(',')}]`,
      ]);
    }
    const creado = valor(await crearInfluencer(e.admin, { displayName: 'Jimena Evidencia' }));
    e.influencerIds.push(creado.influencer.id);
    const ci = valor(
      await asociarInfluencerACampana(e.admin, { campaignId: campana, influencerId: creado.influencer.id }),
    );
    const d = valor(
      await crearEntregable(e.consultor, { campaignInfluencerId: ci.id, label: 'Pieza de evidencia' }),
    );
    const r = valor(
      await registrarVersionDeGuion(e.consultor, {
        campaignId: campana,
        sourceId: guion,
        participation: { participationId: ci.id },
        deliverable: { id: d.id },
      }),
    );
    if (r.kind !== 'registered') throw new Error('se esperaba una versión nueva');

    const buscar = async () => {
      const hits = await buscarEvidencia({
        organizationId: e.admin.organizationId,
        campaignId: campana,
        vector: VECTOR,
      });
      return new Set(hits.map((h) => h.sourceId));
    };
    expect((await buscar()).has(normal)).toBe(true);
    expect((await buscar()).has(guion)).toBe(false);
    await fijarAprobada(r.version.id);
    expect((await buscar()).has(guion)).toBe(false);
    const comoActor = valor(
      await buscarEvidenciaComoActor(e.consultor, { campaignId: campana, vector: VECTOR }),
    );
    expect(comoActor.map((h) => h.sourceId)).not.toContain(guion);
    expect(comoActor.map((h) => h.sourceId)).toContain(normal);
  });
});
