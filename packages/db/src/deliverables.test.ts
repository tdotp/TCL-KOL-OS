/**
 * V2 · Fase 7 — entregables (`Deliverable`), contra PostgreSQL real (migración 023).
 *
 * Campañas, influencers y fuentes propios y desechables (INC-001A). Nunca datos reales.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Result } from '@tcl-kol-os/domain';
import { closePool, query } from './client.ts';
import { asociarInfluencerACampana, retirarInfluencerDeCampana } from './campaign-influencers.ts';
import {
  actualizarEntregable,
  archivarEntregable,
  crearEntregable,
  listarEntregablesDeCampana,
  obtenerEntregable,
  reactivarEntregable,
} from './deliverables.ts';
import { crearInfluencer } from './influencers.ts';
import {
  type EscenarioDeContenido,
  crearEscenarioDeContenido,
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

/** Participación nueva (influencer desechable) en una campaña de la agencia. */
async function participacionNueva(campaignId: string, nombre: string): Promise<string> {
  const creado = valor(
    await crearInfluencer(e.admin, {
      displayName: nombre,
      cuentas: [{ platform: 'tiktok', handle: `${nombre.toLowerCase().replace(/\W+/g, '')}.${e.sufijo}` }],
    }),
  );
  e.influencerIds.push(creado.influencer.id);
  return valor(await asociarInfluencerACampana(e.admin, { campaignId, influencerId: creado.influencer.id }))
    .id;
}

const auditoria = (accion: string, entidad: string) =>
  query<{ origin: string; actor_id: string | null; metadata: Record<string, unknown>; correlation: unknown }>(
    `SELECT origin, actor_id, metadata, correlation FROM audit_events
      WHERE action = $1 AND entity_id = $2 ORDER BY created_at`,
    [accion, entidad],
  );

beforeAll(async () => {
  e = await crearEscenarioDeContenido('F7 entregables');
});
afterAll(async () => {
  await limpiarEscenarioDeContenido(e);
  await closePool();
});

describe('crear', () => {
  it('crea un entregable activo y sin versiones, con etiqueta y clave normalizadas', async () => {
    const d = valor(
      await crearEntregable(e.consultor, {
        campaignInfluencerId: e.participaciones.diego,
        label: '  Reel   de   Prueba ',
        platform: 'tiktok',
      }),
    );
    expect(d).toMatchObject({
      campaignInfluencerId: e.participaciones.diego,
      campaignId: e.campanaId,
      organizationId: e.admin.organizationId,
      label: 'Reel de Prueba',
      labelKey: 'reel de prueba',
      platform: 'tiktok',
      status: 'active',
      lastVersion: 0,
      createdBy: e.consultor.id,
    });
  });

  it('la plataforma es informativa: puede faltar', async () => {
    const d = valor(
      await crearEntregable(e.consultor, {
        campaignInfluencerId: e.participaciones.diego,
        label: 'Sin plataforma',
      }),
    );
    expect(d.platform).toBeUndefined();
  });

  it('audita deliverable.create con origen ui; con chat conserva la correlación; sin texto de documentos', async () => {
    const ui = valor(
      await crearEntregable(e.admin, { campaignInfluencerId: e.participaciones.diego, label: 'Auditado ui' }),
    );
    const [ev] = await auditoria('deliverable.create', ui.id);
    expect(ev).toMatchObject({ origin: 'ui', actor_id: e.admin.id });
    expect(ev?.metadata).toEqual({
      campaignId: e.campanaId,
      campaignInfluencerId: e.participaciones.diego,
      platform: null,
      label: 'Auditado ui',
    });

    const msg = '11111111-1111-4111-8111-111111111111';
    const chat = valor(
      await crearEntregable(
        e.consultor,
        { campaignInfluencerId: e.participaciones.diego, label: 'Auditado chat' },
        { origin: 'chat', correlation: { messageId: msg } },
      ),
    );
    const [evChat] = await auditoria('deliverable.create', chat.id);
    expect(evChat?.origin).toBe('chat');
    expect(evChat?.correlation).toEqual({ messageId: msg });
  });

  it('un actor «system» no crea (solo personas)', async () => {
    const r = await crearEntregable('system' as never, {
      campaignInfluencerId: e.participaciones.diego,
      label: 'Del sistema',
    });
    expect(codigo(r)).toBe('FORBIDDEN_ROLE');
  });

  it('valida la etiqueta y la plataforma', async () => {
    for (const label of ['', '   ', 'x'.repeat(121), 'con\u0000control']) {
      expect(
        codigo(await crearEntregable(e.admin, { campaignInfluencerId: e.participaciones.diego, label })),
      ).toBe('VALIDATION_FAILED');
    }
    const r = await crearEntregable(e.admin, {
      campaignInfluencerId: e.participaciones.diego,
      label: 'Plataforma mala',
      platform: 'myspace' as never,
    });
    expect(codigo(r)).toBe('VALIDATION_FAILED');
  });

  it('una participación inexistente o un id mal formado es RESOURCE_NOT_FOUND (no una excepción)', async () => {
    expect(
      codigo(
        await crearEntregable(e.admin, {
          campaignInfluencerId: '22222222-2222-4222-8222-222222222222',
          label: 'Nada',
        }),
      ),
    ).toBe('RESOURCE_NOT_FOUND');
    expect(
      codigo(await crearEntregable(e.admin, { campaignInfluencerId: 'no-es-uuid', label: 'Nada' })),
    ).toBe('RESOURCE_NOT_FOUND');
  });

  it('el producto debe estar asignado a la participación; uno de otra campaña no existe', async () => {
    const asignado = await crearEntregable(e.consultor, {
      campaignInfluencerId: e.participaciones.valentinaRios,
      label: 'Con producto asignado',
      campaignProductId: e.productos.p80,
    });
    expect(valor(asignado).campaignProductId).toBe(e.productos.p80);

    const noAsignado = await crearEntregable(e.consultor, {
      campaignInfluencerId: e.participaciones.diego,
      label: 'Con producto ajeno',
      campaignProductId: e.productos.pro,
    });
    expect(codigo(noAsignado)).toBe('VALIDATION_FAILED');
    expect(razon(noAsignado)).toBe('product_not_assigned');

    const [otro] = await query<{ id: string }>(
      `INSERT INTO campaign_products (campaign_id, product_id, rol, prioridad, participacion_presupuesto)
       SELECT $1, product_id, 'secundario', 1, 0.5 FROM campaign_products WHERE id = $2 RETURNING id`,
      [e.otraCampanaId, e.productos.p80],
    );
    const deOtraCampana = await crearEntregable(e.consultor, {
      campaignInfluencerId: e.participaciones.valentinaRios,
      label: 'Con producto de otra campaña',
      campaignProductId: otro!.id,
    });
    expect(codigo(deOtraCampana)).toBe('RESOURCE_NOT_FOUND');
  });
});

describe('unicidad de la etiqueta normalizada', () => {
  it('«Reel principal» y «  REEL   principal » son el mismo entregable: conflicto con el id existente', async () => {
    const r = await crearEntregable(e.consultor, {
      campaignInfluencerId: e.participaciones.valentinaRios,
      label: '  REEL   principal ',
    });
    expect(codigo(r)).toBe('RESOURCE_CONFLICT');
    expect(razon(r)).toBe('label_already_exists');
    expect((r.ok ? undefined : r.error.details) as { deliverableId?: string }).toMatchObject({
      deliverableId: e.entregables.reelRios,
    });
  });

  it('otra participación sí puede usar la misma etiqueta; la plataforma no entra en la clave', async () => {
    const otraPersona = await crearEntregable(e.consultor, {
      campaignInfluencerId: e.participaciones.diego,
      label: 'Story de lanzamiento',
    });
    expect(otraPersona.ok).toBe(true);
    const otraPlataforma = await crearEntregable(e.consultor, {
      campaignInfluencerId: e.participaciones.valentinaRios,
      label: 'Reel principal',
      platform: 'youtube',
    });
    expect(codigo(otraPlataforma)).toBe('RESOURCE_CONFLICT');
  });

  it('dos creaciones simultáneas con la misma etiqueta: una gana, la otra es conflicto (no un 500)', async () => {
    const rs = await Promise.all(
      [1, 2, 3, 4].map(() =>
        crearEntregable(e.consultor, {
          campaignInfluencerId: e.participaciones.diego,
          label: 'Carrera de etiqueta',
        }),
      ),
    );
    expect(rs.filter((r) => r.ok)).toHaveLength(1);
    for (const r of rs.filter((x) => !x.ok)) expect(codigo(r)).toBe('RESOURCE_CONFLICT');
  });

  it('archivar libera la clave; reactivar con un duplicado activo es conflicto', async () => {
    const ci = e.participaciones.diego;
    const a = valor(await crearEntregable(e.consultor, { campaignInfluencerId: ci, label: 'Ciclo de vida' }));
    valor(await archivarEntregable(e.consultor, a.id));
    const b = valor(await crearEntregable(e.consultor, { campaignInfluencerId: ci, label: 'ciclo de VIDA' }));
    expect(b.id).not.toBe(a.id);
    const r = await reactivarEntregable(e.consultor, a.id);
    expect(codigo(r)).toBe('RESOURCE_CONFLICT');
    expect(razon(r)).toBe('label_already_exists');
    valor(await archivarEntregable(e.consultor, b.id));
    expect(valor(await reactivarEntregable(e.consultor, a.id)).status).toBe('active');
  });
});

describe('actualizar', () => {
  it('renombra y ajusta la plataforma; audita deliverable.update; sin cambios no escribe', async () => {
    const d = valor(
      await crearEntregable(e.consultor, {
        campaignInfluencerId: e.participaciones.diego,
        label: 'Para renombrar',
      }),
    );
    const nuevo = valor(
      await actualizarEntregable(e.consultor, d.id, { label: 'Renombrado', platform: 'instagram' }),
    );
    expect(nuevo).toMatchObject({ label: 'Renombrado', labelKey: 'renombrado', platform: 'instagram' });
    const [ev] = await auditoria('deliverable.update', d.id);
    expect(ev?.metadata).toMatchObject({
      labelAnterior: 'Para renombrar',
      label: 'Renombrado',
      platformAnterior: null,
      platform: 'instagram',
    });

    // mismo contenido: no hay segunda auditoría
    valor(await actualizarEntregable(e.consultor, d.id, { label: 'Renombrado' }));
    expect(await auditoria('deliverable.update', d.id)).toHaveLength(1);
    // null borra la plataforma informativa
    expect(valor(await actualizarEntregable(e.consultor, d.id, { platform: null })).platform).toBeUndefined();
  });

  it('rechaza una etiqueta que choca con otra activa, un pedido vacío y un entregable archivado', async () => {
    const ci = e.participaciones.diego;
    valor(await crearEntregable(e.consultor, { campaignInfluencerId: ci, label: 'Choque X' }));
    const y = valor(await crearEntregable(e.consultor, { campaignInfluencerId: ci, label: 'Choque Y' }));
    const choque = await actualizarEntregable(e.consultor, y.id, { label: 'CHOQUE x' });
    expect(codigo(choque)).toBe('RESOURCE_CONFLICT');
    expect(razon(choque)).toBe('label_already_exists');
    expect(codigo(await actualizarEntregable(e.consultor, y.id, {}))).toBe('VALIDATION_FAILED');
    valor(await archivarEntregable(e.consultor, y.id));
    const archivado = await actualizarEntregable(e.consultor, y.id, { label: 'Nuevo nombre' });
    expect(razon(archivado)).toBe('deliverable_archived');
  });

  it('la identidad no se modifica (participación, producto, campaña): ni siquiera por SQL directo', async () => {
    const d = valor(
      await crearEntregable(e.consultor, {
        campaignInfluencerId: e.participaciones.diego,
        label: 'Identidad fija',
      }),
    );
    await expect(
      query(`UPDATE deliverables SET campaign_influencer_id = $2 WHERE id = $1`, [
        d.id,
        e.participaciones.valentinaRios,
      ]),
    ).rejects.toThrow(/identidad/);
  });
});

describe('archivar y reactivar', () => {
  it('conserva la fila (sin DELETE), audita y no repite el mismo estado', async () => {
    const d = valor(
      await crearEntregable(e.consultor, {
        campaignInfluencerId: e.participaciones.diego,
        label: 'A archivar',
      }),
    );
    const archivado = valor(await archivarEntregable(e.consultor, d.id, { motivo: 'duplicado de otro' }));
    expect(archivado.status).toBe('archived');
    expect(archivado.archivedAt).toBeDefined();
    const [ev] = await auditoria('deliverable.archive', d.id);
    expect(ev?.metadata).toMatchObject({ estadoAnterior: 'active', motivo: 'duplicado de otro' });
    expect(razon(await archivarEntregable(e.consultor, d.id))).toBe('already_in_status');

    const reactivado = valor(await reactivarEntregable(e.consultor, d.id));
    expect(reactivado.status).toBe('active');
    expect(reactivado.archivedAt).toBeUndefined();
    expect((await auditoria('deliverable.unarchive', d.id))[0]?.metadata).toMatchObject({
      estadoAnterior: 'archived',
    });
    expect(razon(await reactivarEntregable(e.consultor, d.id))).toBe('already_in_status');

    await expect(query(`DELETE FROM deliverables WHERE id = $1`, [d.id])).rejects.toThrow(/no admite DELETE/);
  });

  it('el motivo no supera 500 caracteres', async () => {
    const d = valor(
      await crearEntregable(e.consultor, {
        campaignInfluencerId: e.participaciones.diego,
        label: 'Motivo largo',
      }),
    );
    expect(codigo(await archivarEntregable(e.consultor, d.id, { motivo: 'm'.repeat(501) }))).toBe(
      'VALIDATION_FAILED',
    );
  });
});

describe('retiro de la participación y campaña no activa: no se crea ni se modifica; las lecturas siguen', () => {
  it('participación retirada: no se crean ni se editan entregables; se lee; reactivar reanuda', async () => {
    const ci = await participacionNueva(e.campanaId, 'Camila Retirada');
    const d = valor(
      await crearEntregable(e.consultor, { campaignInfluencerId: ci, label: 'Antes del retiro' }),
    );
    valor(await retirarInfluencerDeCampana(e.admin, ci));

    const crear = await crearEntregable(e.consultor, {
      campaignInfluencerId: ci,
      label: 'Durante el retiro',
    });
    expect(codigo(crear)).toBe('RESOURCE_CONFLICT');
    expect(razon(crear)).toBe('campaign_influencer_retired');
    expect(razon(await actualizarEntregable(e.consultor, d.id, { label: 'Otro' }))).toBe(
      'campaign_influencer_retired',
    );
    // lecturas
    expect(valor(await obtenerEntregable(e.consultor, d.id))).toMatchObject({ projection: 'cuenta' });
    const lista = valor(await listarEntregablesDeCampana(e.consultor, e.campanaId, { participationId: ci }));
    expect(lista.items).toHaveLength(1);
    // archivar sí se puede (cierre ordenado); reactivar el entregable exige la participación activa
    valor(await archivarEntregable(e.consultor, d.id));
    expect(razon(await reactivarEntregable(e.consultor, d.id))).toBe('campaign_influencer_retired');
  });

  it('la base también lo impone por SQL directo (participación retirada)', async () => {
    const ci = await participacionNueva(e.campanaId, 'Dora Retirada');
    valor(await retirarInfluencerDeCampana(e.admin, ci));
    await expect(
      query(
        `INSERT INTO deliverables (organization_id, campaign_id, campaign_influencer_id, label, label_key, created_by)
         VALUES ($1, $2, $3, 'X', 'x', $4)`,
        [e.admin.organizationId, e.campanaId, ci, e.consultor.id],
      ),
    ).rejects.toThrow(/activa y el influencer activo/);
  });

  it('campaña archivada: no se crean entregables; las lecturas siguen', async () => {
    const ci = await participacionNueva(e.otraCampanaId, 'Elena Campaña B');
    const d = valor(
      await crearEntregable(e.consultor, { campaignInfluencerId: ci, label: 'Antes de archivar' }),
    );
    await query(`UPDATE campaigns SET status = 'archivada' WHERE id = $1`, [e.otraCampanaId]);

    const crear = await crearEntregable(e.consultor, {
      campaignInfluencerId: ci,
      label: 'Con la campaña archivada',
    });
    expect(razon(crear)).toBe('campaign_not_active');
    expect(razon(await actualizarEntregable(e.consultor, d.id, { label: 'Otro' }))).toBe(
      'campaign_not_active',
    );
    expect(valor(await obtenerEntregable(e.consultor, d.id)).projection).toBe('cuenta');
    expect(valor(await listarEntregablesDeCampana(e.consultor, e.otraCampanaId)).items).toHaveLength(1);

    await query(`UPDATE campaigns SET status = 'activa' WHERE id = $1`, [e.otraCampanaId]);
    expect(valor(await actualizarEntregable(e.consultor, d.id, { label: 'Ya activa' })).label).toBe(
      'Ya activa',
    );
  });
});

describe('lecturas', () => {
  it('lista con paginación, total real y los archivados solo si se piden', async () => {
    const todos = valor(await listarEntregablesDeCampana(e.consultor, e.campanaId, { limite: 2 }));
    expect(todos.items).toHaveLength(2);
    expect(todos.limite).toBe(2);
    expect(todos.total).toBeGreaterThan(2);
    const pagina2 = valor(
      await listarEntregablesDeCampana(e.consultor, e.campanaId, { limite: 2, desde: 2 }),
    );
    expect(pagina2.items[0]).not.toEqual(todos.items[0]);

    const archivados = (
      await query<{ n: string }>(
        `SELECT count(*)::text AS n FROM deliverables WHERE campaign_id = $1 AND status = 'archived'`,
        [e.campanaId],
      )
    )[0]!.n;
    expect(Number(archivados)).toBeGreaterThan(0);
    const activos = valor(await listarEntregablesDeCampana(e.consultor, e.campanaId, { limite: 200 }));
    const conArchivados = valor(
      await listarEntregablesDeCampana(e.consultor, e.campanaId, { limite: 200, incluirArchivados: true }),
    );
    expect(conArchivados.total - activos.total).toBe(Number(archivados));
  });

  it('el cerco de campaña: un entregable de otra campaña se responde como inexistente', async () => {
    const r = await obtenerEntregable(e.consultor, e.entregables.reelRios, {
      alcance: { campaignId: e.otraCampanaId },
    });
    expect(codigo(r)).toBe('RESOURCE_NOT_FOUND');
    expect(codigo(await obtenerEntregable(e.consultor, 'no-es-uuid'))).toBe('RESOURCE_NOT_FOUND');
  });

  it('un entregable nuevo está «sin_guion»', async () => {
    const d = valor(await obtenerEntregable(e.consultor, e.entregables.reelDiego));
    expect(d).toMatchObject({
      projection: 'cuenta',
      resumen: 'sin_guion',
      versionCount: 0,
      latest: null,
      currentApproved: null,
    });
  });
});

describe('aislamiento entre organizaciones', () => {
  it('otra agencia y el cliente reciben RESOURCE_NOT_FOUND en todo', async () => {
    for (const intruso of [e.ajeno, e.cliente]) {
      expect(codigo(await obtenerEntregable(intruso, e.entregables.reelRios))).toBe('RESOURCE_NOT_FOUND');
      expect(codigo(await listarEntregablesDeCampana(intruso, e.campanaId))).toBe('RESOURCE_NOT_FOUND');
      expect(
        codigo(
          await crearEntregable(intruso, { campaignInfluencerId: e.participaciones.diego, label: 'Intruso' }),
        ),
      ).toBe('RESOURCE_NOT_FOUND');
      expect(codigo(await actualizarEntregable(intruso, e.entregables.reelRios, { label: 'Hackeado' }))).toBe(
        'RESOURCE_NOT_FOUND',
      );
      expect(codigo(await archivarEntregable(intruso, e.entregables.reelRios))).toBe('RESOURCE_NOT_FOUND');
    }
    const [fila] = await query<{ label: string; status: string }>(
      `SELECT label, status FROM deliverables WHERE id = $1`,
      [e.entregables.reelRios],
    );
    expect(fila).toEqual({ label: 'Reel principal', status: 'active' });
  });
});
