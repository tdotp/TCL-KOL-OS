/**
 * V2 · Fase 3 — CampaignInfluencer y producto asignado, contra PostgreSQL real.
 *
 * Campañas e influencers propios y desechables (INC-001A). Nunca campañas
 * reales.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Result, User } from '@tcl-kol-os/domain';
import { closePool, query } from './client.ts';
import {
  asegurarUsuarioDePrueba,
  eliminarCampanaDePrueba,
  eliminarInfluencersDePrueba,
} from './test-utils.ts';
import { findUserByEmail } from './users.ts';
import { crearInfluencer } from './influencers.ts';
import {
  asociarInfluencerACampana,
  asociarProductoAInfluencer,
  desasociarProducto,
  listarInfluencersDeCampana,
  obtenerCampaignInfluencer,
  reactivarInfluencerEnCampana,
  retirarInfluencerDeCampana,
} from './campaign-influencers.ts';

const sufijo = Date.now().toString(36);
const h = (base: string) => `${base}_${sufijo}`;

let admin: User;
let director: User;
let consultor: User;
let operativo: User;
let cliente: User;
let ajeno: User;

let campanaA: string; // SmartPR · P80 + P80 Pro
let campanaB: string; // SmartPR · C7L + P80
let campanaAjena: string; // otra agencia · P80
let cpA: { p80: string; pro: string };
let cpB: { c7l: string; p80: string };
let cpAjena: string;

const influencersCreados: string[] = [];
const campanasCreadas: string[] = [];

function valor<T>(r: Result<T>): T {
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
  return r.value;
}

type Resultado = { readonly ok: true } | { readonly ok: false; readonly error: { readonly code: string } };

function codigo(r: Resultado): string | undefined {
  return r.ok ? undefined : r.error.code;
}

async function nuevoInfluencer(
  actor: User,
  nombre: string,
  cuentas?: { platform: 'instagram'; handle: string }[],
) {
  const creado = valor(await crearInfluencer(actor, { displayName: `${nombre} ${sufijo}`, cuentas }));
  influencersCreados.push(creado.influencer.id);
  return creado.influencer.id;
}

async function productoId(modelo: string): Promise<string> {
  const [fila] = await query<{ id: string }>(`SELECT id FROM products WHERE model = $1`, [modelo]);
  return fila!.id;
}

async function crearCampana(owner: User, nombre: string, modelos: string[]) {
  const [c] = await query<{ id: string }>(
    `INSERT INTO campaigns (organization_id, name, owner_id, created_by) VALUES ($1, $2, $3, $3) RETURNING id`,
    [owner.organizationId, `${nombre} ${sufijo}`, owner.id],
  );
  campanasCreadas.push(c!.id);
  const campaignProducts: Record<string, string> = {};
  for (const [indice, modelo] of modelos.entries()) {
    const [cp] = await query<{ id: string }>(
      `INSERT INTO campaign_products (campaign_id, product_id, rol, prioridad, participacion_presupuesto)
       VALUES ($1, $2, 'secundario', $3, 0.5) RETURNING id`,
      [c!.id, await productoId(modelo), indice + 1],
    );
    campaignProducts[modelo] = cp!.id;
  }
  return { id: c!.id, campaignProducts };
}

async function auditoriaDe(entityId: string) {
  return query<{
    action: string;
    entity_type: string;
    origin: string | null;
    actor_id: string | null;
    metadata: Record<string, unknown>;
  }>(
    `SELECT action, entity_type, origin, actor_id, metadata FROM audit_events WHERE entity_id = $1 ORDER BY created_at, id`,
    [entityId],
  );
}

beforeAll(async () => {
  admin = (await findUserByEmail('gerardo@smartpr.co'))!;
  director = (await findUserByEmail('director@smartpr.co'))!;
  consultor = (await findUserByEmail('consultor@smartpr.co'))!;
  cliente = (await findUserByEmail('marena@tcl.com'))!;
  ajeno = (await findUserByEmail('ajeno@otraagencia.co'))!;
  operativo = await asegurarUsuarioDePrueba(
    'operativo@smartpr.co',
    'Usuario Operativo',
    'operativo',
    admin.organizationId,
  );

  const a = await crearCampana(admin, 'F3 Campaña A', ['P80', 'P80 Pro']);
  const b = await crearCampana(admin, 'F3 Campaña B', ['C7L', 'P80']);
  const x = await crearCampana(ajeno, 'F3 Campaña ajena', ['P80']);
  campanaA = a.id;
  campanaB = b.id;
  campanaAjena = x.id;
  cpA = { p80: a.campaignProducts['P80']!, pro: a.campaignProducts['P80 Pro']! };
  cpB = { c7l: b.campaignProducts['C7L']!, p80: b.campaignProducts['P80']! };
  cpAjena = x.campaignProducts['P80']!;
});

afterAll(async () => {
  await eliminarCampanaDePrueba(campanasCreadas);
  await eliminarInfluencersDePrueba(influencersCreados);
  await closePool();
});

// ─────────────────────────── Participación ─────────────────────────────────────

describe('asociar un influencer a una campaña', () => {
  it('crea la participación (activa), como entidad separada de la identidad, y audita', async () => {
    const influencerId = await nuevoInfluencer(admin, 'Valentina Rojas', [
      { platform: 'instagram', handle: h('val') },
    ]);
    const ci = valor(await asociarInfluencerACampana(consultor, { campaignId: campanaA, influencerId }));
    expect(ci).toMatchObject({
      campaignId: campanaA,
      influencerId,
      organizationId: admin.organizationId,
      status: 'activo',
      createdBy: consultor.id,
    });
    expect(ci.id).not.toBe(influencerId);

    const eventos = await auditoriaDe(ci.id);
    expect(eventos).toHaveLength(1);
    expect(eventos[0]).toMatchObject({
      action: 'campaign_influencer.associate',
      entity_type: 'campaign_influencer',
      origin: 'ui',
      actor_id: consultor.id,
    });
    expect(eventos[0]!.metadata).toMatchObject({ campaignId: campanaA, influencerId });
  });

  it('la participación no guarda nada de acuerdo, fee, producto en texto, fechas ni KPIs', async () => {
    const columnas = await query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'campaign_influencers'`,
    );
    expect(columnas.map((c) => c.column_name).sort()).toEqual([
      'campaign_id',
      'created_at',
      'created_by',
      'id',
      'influencer_id',
      'organization_id',
      'retired_at',
      'status',
      'updated_at',
    ]);
  });

  it('un influencer no se duplica en la misma campaña, tenga las plataformas que tenga', async () => {
    const influencerId = await nuevoInfluencer(admin, 'Única', [
      { platform: 'instagram', handle: h('unica') },
    ]);
    const primera = valor(await asociarInfluencerACampana(admin, { campaignId: campanaA, influencerId }));
    const segunda = await asociarInfluencerACampana(director, { campaignId: campanaA, influencerId });
    expect(codigo(segunda)).toBe('RESOURCE_CONFLICT');
    if (!segunda.ok) {
      expect(segunda.error.details).toMatchObject({
        reason: 'already_associated',
        campaignInfluencerId: primera.id,
        status: 'activo',
      });
    }
    const filas = await query(
      `SELECT 1 FROM campaign_influencers WHERE campaign_id = $1 AND influencer_id = $2`,
      [campanaA, influencerId],
    );
    expect(filas).toHaveLength(1);
  });

  it('la base impone UNIQUE(campaña, influencer) aunque se salte la aplicación', async () => {
    const influencerId = await nuevoInfluencer(admin, 'Constraint');
    valor(await asociarInfluencerACampana(admin, { campaignId: campanaA, influencerId }));
    await expect(
      query(
        `INSERT INTO campaign_influencers (organization_id, campaign_id, influencer_id, created_by)
         VALUES ($1, $2, $3, $4)`,
        [admin.organizationId, campanaA, influencerId, admin.id],
      ),
    ).rejects.toThrow(/campaign_influencers_unique/);
  });

  it('una colisión concurrente deja una sola participación', async () => {
    const influencerId = await nuevoInfluencer(admin, 'Concurrente');
    const resultados = await Promise.all(
      [1, 2, 3].map(() => asociarInfluencerACampana(admin, { campaignId: campanaA, influencerId })),
    );
    expect(resultados.filter((r) => r.ok)).toHaveLength(1);
    for (const r of resultados.filter((x) => !x.ok)) expect(codigo(r)).toBe('RESOURCE_CONFLICT');
    const filas = await query(
      `SELECT 1 FROM campaign_influencers WHERE campaign_id = $1 AND influencer_id = $2`,
      [campanaA, influencerId],
    );
    expect(filas).toHaveLength(1);
  });

  it('el mismo influencer sí participa en campañas distintas', async () => {
    const influencerId = await nuevoInfluencer(admin, 'Multicampaña');
    const enA = valor(await asociarInfluencerACampana(admin, { campaignId: campanaA, influencerId }));
    const enB = valor(await asociarInfluencerACampana(admin, { campaignId: campanaB, influencerId }));
    expect(enA.id).not.toBe(enB.id);
    expect(enA.influencerId).toBe(enB.influencerId);
  });

  it('rechaza un influencer de otra organización y una campaña de otra organización', async () => {
    const delAjeno = await nuevoInfluencer(ajeno, 'Del ajeno');
    const mio = await nuevoInfluencer(admin, 'Mío');

    // Influencer ajeno en campaña propia.
    expect(
      codigo(await asociarInfluencerACampana(admin, { campaignId: campanaA, influencerId: delAjeno })),
    ).toBe('RESOURCE_NOT_FOUND');
    // Campaña ajena (inaccesible) con influencer propio, y al revés.
    expect(
      codigo(await asociarInfluencerACampana(admin, { campaignId: campanaAjena, influencerId: mio })),
    ).toBe('RESOURCE_NOT_FOUND');
    expect(
      codigo(await asociarInfluencerACampana(ajeno, { campaignId: campanaAjena, influencerId: mio })),
    ).toBe('RESOURCE_NOT_FOUND');
    // Campaña inexistente.
    expect(
      codigo(
        await asociarInfluencerACampana(admin, {
          campaignId: '00000000-0000-4000-8000-000000000000',
          influencerId: mio,
        }),
      ),
    ).toBe('RESOURCE_NOT_FOUND');

    const filas = await query(`SELECT 1 FROM campaign_influencers WHERE influencer_id = ANY($1::uuid[])`, [
      [delAjeno, mio],
    ]);
    expect(filas).toHaveLength(0);
  });

  it('la base impide cruzar organizaciones entre campaña, influencer y participación', async () => {
    const delAjeno = await nuevoInfluencer(ajeno, 'Cruce');
    // Organización de la campaña, influencer de otra.
    await expect(
      query(
        `INSERT INTO campaign_influencers (organization_id, campaign_id, influencer_id, created_by)
         VALUES ($1, $2, $3, $4)`,
        [admin.organizationId, campanaA, delAjeno, admin.id],
      ),
    ).rejects.toThrow(/campaign_influencers_influencer_fkey/);
    // Organización del influencer, campaña de otra.
    await expect(
      query(
        `INSERT INTO campaign_influencers (organization_id, campaign_id, influencer_id, created_by)
         VALUES ($1, $2, $3, $4)`,
        [ajeno.organizationId, campanaA, delAjeno, ajeno.id],
      ),
    ).rejects.toThrow(/campaign_influencers_campaign_fkey/);
  });
});

describe('leer la participación', () => {
  it('obtener y listar devuelven identidad, cuentas y productos asignados', async () => {
    const influencerId = await nuevoInfluencer(admin, 'Listada', [
      { platform: 'instagram', handle: h('lista') },
    ]);
    const ci = valor(await asociarInfluencerACampana(admin, { campaignId: campanaB, influencerId }));
    valor(
      await asociarProductoAInfluencer(admin, { campaignInfluencerId: ci.id, campaignProductId: cpB.c7l }),
    );

    const detalle = valor(await obtenerCampaignInfluencer(operativo, ci.id));
    expect(detalle.campaignInfluencer.id).toBe(ci.id);
    expect(detalle.influencer.id).toBe(influencerId);
    expect(detalle.accounts.map((c) => c.normalizedHandle)).toEqual([h('lista')]);
    expect(detalle.products.map((p) => p.model)).toEqual(['C7L']);

    const lista = valor(await listarInfluencersDeCampana(operativo, campanaB));
    expect(lista.find((d) => d.campaignInfluencer.id === ci.id)?.products).toHaveLength(1);
    // Solo participaciones de ESA campaña.
    expect(lista.every((d) => d.campaignInfluencer.campaignId === campanaB)).toBe(true);
  });

  it('el detalle no expone el reparto de presupuesto de la campaña', async () => {
    const influencerId = await nuevoInfluencer(admin, 'Sin reparto');
    const ci = valor(await asociarInfluencerACampana(admin, { campaignId: campanaA, influencerId }));
    valor(
      await asociarProductoAInfluencer(admin, { campaignInfluencerId: ci.id, campaignProductId: cpA.p80 }),
    );
    const detalle = valor(await obtenerCampaignInfluencer(operativo, ci.id));
    expect(JSON.stringify(detalle)).not.toMatch(/participacion|presupuesto/i);
  });

  it('aislamiento: otra agencia no obtiene ni lista la participación', async () => {
    const influencerId = await nuevoInfluencer(admin, 'Reservada');
    const ci = valor(await asociarInfluencerACampana(admin, { campaignId: campanaA, influencerId }));
    expect(codigo(await obtenerCampaignInfluencer(ajeno, ci.id))).toBe('RESOURCE_NOT_FOUND');
    expect(codigo(await listarInfluencersDeCampana(ajeno, campanaA))).toBe('RESOURCE_NOT_FOUND');
    expect(codigo(await listarInfluencersDeCampana(admin, campanaAjena))).toBe('RESOURCE_NOT_FOUND');
  });
});

// ─────────────────────────── Retiro / historia ─────────────────────────────────

describe('retirar y reactivar (sin borrar la historia)', () => {
  it('retirar conserva la fila y la oculta de la lista por defecto; reactivar la devuelve; todo audita', async () => {
    const influencerId = await nuevoInfluencer(admin, 'Retirable');
    const ci = valor(await asociarInfluencerACampana(admin, { campaignId: campanaA, influencerId }));
    valor(
      await asociarProductoAInfluencer(admin, { campaignInfluencerId: ci.id, campaignProductId: cpA.p80 }),
    );

    const retirada = valor(
      await retirarInfluencerDeCampana(consultor, ci.id, { motivo: '  Cambio de plan  ' }),
    );
    expect(retirada.status).toBe('retirado');
    expect(retirada.retiredAt).toBeDefined();

    const activos = valor(await listarInfluencersDeCampana(admin, campanaA));
    expect(activos.some((d) => d.campaignInfluencer.id === ci.id)).toBe(false);
    const todos = valor(await listarInfluencersDeCampana(admin, campanaA, { incluirRetirados: true }));
    const enHistoria = todos.find((d) => d.campaignInfluencer.id === ci.id);
    expect(enHistoria?.campaignInfluencer.status).toBe('retirado');
    expect(enHistoria?.products.map((p) => p.model)).toEqual(['P80']); // la historia se conserva

    // Asociar de nuevo NO duplica: indica la existente retirada.
    const otraVez = await asociarInfluencerACampana(admin, { campaignId: campanaA, influencerId });
    expect(codigo(otraVez)).toBe('RESOURCE_CONFLICT');
    if (!otraVez.ok)
      expect(otraVez.error.details).toMatchObject({ campaignInfluencerId: ci.id, status: 'retirado' });

    const reactivada = valor(await reactivarInfluencerEnCampana(admin, ci.id));
    expect(reactivada).toMatchObject({ id: ci.id, status: 'activo', retiredAt: undefined });

    const eventos = (await auditoriaDe(ci.id)).map((e) => e.action);
    expect(eventos).toEqual([
      'campaign_influencer.associate',
      'campaign_influencer.product_assign',
      'campaign_influencer.retire',
      'campaign_influencer.reactivate',
    ]);
    const retiro = (await auditoriaDe(ci.id)).find((e) => e.action === 'campaign_influencer.retire')!;
    expect(retiro.metadata).toMatchObject({ estadoAnterior: 'activo', motivo: 'Cambio de plan' });
  });

  it('retirar dos veces o reactivar a un activo se rechaza', async () => {
    const influencerId = await nuevoInfluencer(admin, 'Doble');
    const ci = valor(await asociarInfluencerACampana(admin, { campaignId: campanaA, influencerId }));
    expect(codigo(await reactivarInfluencerEnCampana(admin, ci.id))).toBe('RESOURCE_CONFLICT');
    valor(await retirarInfluencerDeCampana(admin, ci.id));
    expect(codigo(await retirarInfluencerDeCampana(admin, ci.id))).toBe('RESOURCE_CONFLICT');
  });

  it('retirado no admite cambios de producto hasta reactivarlo', async () => {
    const influencerId = await nuevoInfluencer(admin, 'Congelado');
    const ci = valor(await asociarInfluencerACampana(admin, { campaignId: campanaA, influencerId }));
    valor(
      await asociarProductoAInfluencer(admin, { campaignInfluencerId: ci.id, campaignProductId: cpA.p80 }),
    );
    valor(await retirarInfluencerDeCampana(admin, ci.id));
    expect(
      codigo(
        await asociarProductoAInfluencer(admin, { campaignInfluencerId: ci.id, campaignProductId: cpA.pro }),
      ),
    ).toBe('RESOURCE_CONFLICT');
    expect(
      codigo(await desasociarProducto(admin, { campaignInfluencerId: ci.id, campaignProductId: cpA.p80 })),
    ).toBe('RESOURCE_CONFLICT');
  });

  it('un motivo demasiado largo se rechaza', async () => {
    const influencerId = await nuevoInfluencer(admin, 'Motivo');
    const ci = valor(await asociarInfluencerACampana(admin, { campaignId: campanaA, influencerId }));
    expect(codigo(await retirarInfluencerDeCampana(admin, ci.id, { motivo: 'x'.repeat(501) }))).toBe(
      'VALIDATION_FAILED',
    );
  });

  it('la participación no se borra ni se reasigna a otra campaña o persona (base de datos)', async () => {
    const influencerId = await nuevoInfluencer(admin, 'Historia');
    const otro = await nuevoInfluencer(admin, 'Otro');
    const ci = valor(await asociarInfluencerACampana(admin, { campaignId: campanaA, influencerId }));
    await expect(query(`DELETE FROM campaign_influencers WHERE id = $1`, [ci.id])).rejects.toThrow(
      /no admite DELETE/,
    );
    await expect(
      query(`UPDATE campaign_influencers SET campaign_id = $2 WHERE id = $1`, [ci.id, campanaB]),
    ).rejects.toThrow(/no se modifican/);
    await expect(
      query(`UPDATE campaign_influencers SET influencer_id = $2 WHERE id = $1`, [ci.id, otro]),
    ).rejects.toThrow(/no se modifican/);
    // Un influencer con participaciones no se puede borrar de forma que las rompa.
    await expect(query(`DELETE FROM influencers WHERE id = $1`, [influencerId])).rejects.toThrow();
  });
});

// ─────────────────────────── Producto asignado ─────────────────────────────────

describe('producto asignado a la participación', () => {
  it('asigna un producto real de la campaña, y varios; no duplica; audita', async () => {
    const influencerId = await nuevoInfluencer(admin, 'Con productos');
    const ci = valor(await asociarInfluencerACampana(admin, { campaignId: campanaA, influencerId }));

    const uno = valor(
      await asociarProductoAInfluencer(consultor, {
        campaignInfluencerId: ci.id,
        campaignProductId: cpA.p80,
      }),
    );
    expect(uno).toMatchObject({
      campaignProductId: cpA.p80,
      model: 'P80',
      brand: 'TCL',
      category: 'Smartphones',
    });
    expect(uno.productId).toBe(await productoId('P80'));
    valor(
      await asociarProductoAInfluencer(admin, { campaignInfluencerId: ci.id, campaignProductId: cpA.pro }),
    );

    const repetida = await asociarProductoAInfluencer(admin, {
      campaignInfluencerId: ci.id,
      campaignProductId: cpA.p80,
    });
    expect(codigo(repetida)).toBe('RESOURCE_CONFLICT');

    const detalle = valor(await obtenerCampaignInfluencer(admin, ci.id));
    expect(detalle.products.map((p) => p.model).sort()).toEqual(['P80', 'P80 Pro']);

    const asignaciones = (await auditoriaDe(ci.id)).filter(
      (e) => e.action === 'campaign_influencer.product_assign',
    );
    expect(asignaciones).toHaveLength(2);
    expect(asignaciones[0]).toMatchObject({ origin: 'ui', actor_id: consultor.id });
    expect(asignaciones[0]!.metadata).toMatchObject({
      campaignId: campanaA,
      influencerId,
      campaignProductId: cpA.p80,
      model: 'P80',
    });
  });

  it('responde «¿qué producto tiene asignado?» con IDs reales de la campaña', async () => {
    const influencerId = await nuevoInfluencer(admin, 'Consulta');
    const ci = valor(await asociarInfluencerACampana(admin, { campaignId: campanaB, influencerId }));
    valor(
      await asociarProductoAInfluencer(admin, { campaignInfluencerId: ci.id, campaignProductId: cpB.c7l }),
    );
    const filas = await query<{ product_id: string; campaign_id: string }>(
      `SELECT cp.product_id, cp.campaign_id
         FROM campaign_influencer_products cip
         JOIN campaign_products cp ON cp.id = cip.campaign_product_id
        WHERE cip.campaign_influencer_id = $1`,
      [ci.id],
    );
    expect(filas).toEqual([{ product_id: await productoId('C7L'), campaign_id: campanaB }]);
  });

  it('rechaza un producto de OTRA campaña, aun siendo el mismo producto del catálogo', async () => {
    const influencerId = await nuevoInfluencer(admin, 'Campaña equivocada');
    const ci = valor(await asociarInfluencerACampana(admin, { campaignId: campanaA, influencerId }));

    // C7L solo existe en la campaña B.
    expect(
      codigo(
        await asociarProductoAInfluencer(admin, { campaignInfluencerId: ci.id, campaignProductId: cpB.c7l }),
      ),
    ).toBe('RESOURCE_NOT_FOUND');
    // P80 sí está en B, pero ese campaign_product no es el de la campaña A.
    expect(
      codigo(
        await asociarProductoAInfluencer(admin, { campaignInfluencerId: ci.id, campaignProductId: cpB.p80 }),
      ),
    ).toBe('RESOURCE_NOT_FOUND');
    expect(valor(await obtenerCampaignInfluencer(admin, ci.id)).products).toHaveLength(0);
  });

  it('rechaza un producto de otra organización y un producto inexistente', async () => {
    const influencerId = await nuevoInfluencer(admin, 'Org equivocada');
    const ci = valor(await asociarInfluencerACampana(admin, { campaignId: campanaA, influencerId }));
    expect(
      codigo(
        await asociarProductoAInfluencer(admin, { campaignInfluencerId: ci.id, campaignProductId: cpAjena }),
      ),
    ).toBe('RESOURCE_NOT_FOUND');
    expect(
      codigo(
        await asociarProductoAInfluencer(admin, {
          campaignInfluencerId: ci.id,
          campaignProductId: '00000000-0000-4000-8000-000000000000',
        }),
      ),
    ).toBe('RESOURCE_NOT_FOUND');
    // Y la participación de OTRA organización tampoco se toca.
    expect(
      codigo(
        await asociarProductoAInfluencer(ajeno, { campaignInfluencerId: ci.id, campaignProductId: cpAjena }),
      ),
    ).toBe('RESOURCE_NOT_FOUND');
  });

  it('la base hace imposible asignar un producto de otra campaña, aunque se salte la aplicación', async () => {
    const influencerId = await nuevoInfluencer(admin, 'Bypass producto');
    const ci = valor(await asociarInfluencerACampana(admin, { campaignId: campanaA, influencerId }));
    await expect(
      query(
        `INSERT INTO campaign_influencer_products (campaign_id, campaign_influencer_id, campaign_product_id, created_by)
         VALUES ($1, $2, $3, $4)`,
        [campanaA, ci.id, cpB.p80, admin.id],
      ),
    ).rejects.toThrow(/campaign_influencer_products_product_fkey/);
    await expect(
      query(
        `INSERT INTO campaign_influencer_products (campaign_id, campaign_influencer_id, campaign_product_id, created_by)
         VALUES ($1, $2, $3, $4)`,
        [campanaB, ci.id, cpB.p80, admin.id],
      ),
    ).rejects.toThrow(/campaign_influencer_products_influencer_fkey/);
    // La asignación no se edita (no se puede «mover» a otro producto).
    valor(
      await asociarProductoAInfluencer(admin, { campaignInfluencerId: ci.id, campaignProductId: cpA.p80 }),
    );
    await expect(
      query(
        `UPDATE campaign_influencer_products SET campaign_product_id = $2 WHERE campaign_influencer_id = $1`,
        [ci.id, cpA.pro],
      ),
    ).rejects.toThrow(/no admite UPDATE/);
  });

  it('desasociar quita el vínculo y audita, sin borrar el producto ni la participación', async () => {
    const influencerId = await nuevoInfluencer(admin, 'Desasignable');
    const ci = valor(await asociarInfluencerACampana(admin, { campaignId: campanaA, influencerId }));
    valor(
      await asociarProductoAInfluencer(admin, { campaignInfluencerId: ci.id, campaignProductId: cpA.p80 }),
    );
    valor(
      await asociarProductoAInfluencer(admin, { campaignInfluencerId: ci.id, campaignProductId: cpA.pro }),
    );

    valor(await desasociarProducto(director, { campaignInfluencerId: ci.id, campaignProductId: cpA.p80 }));

    const detalle = valor(await obtenerCampaignInfluencer(admin, ci.id));
    expect(detalle.products.map((p) => p.model)).toEqual(['P80 Pro']);
    expect(detalle.campaignInfluencer.status).toBe('activo');
    // El producto sigue en la campaña y en el catálogo.
    expect(await query(`SELECT 1 FROM campaign_products WHERE id = $1`, [cpA.p80])).toHaveLength(1);
    expect(await query(`SELECT 1 FROM products WHERE id = $1`, [await productoId('P80')])).toHaveLength(1);

    const baja = (await auditoriaDe(ci.id)).find((e) => e.action === 'campaign_influencer.product_unassign')!;
    expect(baja).toMatchObject({ origin: 'ui', actor_id: director.id });
    expect(baja.metadata).toMatchObject({ campaignProductId: cpA.p80, model: 'P80' });

    // Quitar uno que no está asignado no hace nada.
    expect(
      codigo(await desasociarProducto(admin, { campaignInfluencerId: ci.id, campaignProductId: cpA.p80 })),
    ).toBe('RESOURCE_NOT_FOUND');
    // Se puede volver a asignar.
    valor(
      await asociarProductoAInfluencer(admin, { campaignInfluencerId: ci.id, campaignProductId: cpA.p80 }),
    );
  });

  it('una campaña con producto asignado no pierde el vínculo: campaign_products está protegido (RESTRICT)', async () => {
    const influencerId = await nuevoInfluencer(admin, 'Protegido');
    const ci = valor(await asociarInfluencerACampana(admin, { campaignId: campanaA, influencerId }));
    valor(
      await asociarProductoAInfluencer(admin, { campaignInfluencerId: ci.id, campaignProductId: cpA.pro }),
    );
    await expect(query(`DELETE FROM campaign_products WHERE id = $1`, [cpA.pro])).rejects.toThrow(
      /campaign_influencer_products_product_fkey/,
    );
  });
});

// ─────────────────────────── Permisos ──────────────────────────────────────────

describe('permisos sobre la participación', () => {
  it('Cuenta (admin, director, consultor) gestiona', async () => {
    for (const actor of [admin, director, consultor]) {
      const influencerId = await nuevoInfluencer(actor, `Gestionada por ${actor.role}`);
      const ci = valor(await asociarInfluencerACampana(actor, { campaignId: campanaA, influencerId }));
      valor(
        await asociarProductoAInfluencer(actor, { campaignInfluencerId: ci.id, campaignProductId: cpA.p80 }),
      );
      valor(await retirarInfluencerDeCampana(actor, ci.id));
    }
  });

  it('Operativo lee, y solo lee: no asocia, no retira, no asigna productos', async () => {
    const influencerId = await nuevoInfluencer(admin, 'Para operativo');
    const ci = valor(await asociarInfluencerACampana(admin, { campaignId: campanaA, influencerId }));
    valor(
      await asociarProductoAInfluencer(admin, { campaignInfluencerId: ci.id, campaignProductId: cpA.p80 }),
    );

    expect(valor(await obtenerCampaignInfluencer(operativo, ci.id)).products).toHaveLength(1);
    expect(valor(await listarInfluencersDeCampana(operativo, campanaA)).length).toBeGreaterThan(0);

    const otro = await nuevoInfluencer(admin, 'Otro para operativo');
    for (const r of [
      await asociarInfluencerACampana(operativo, { campaignId: campanaA, influencerId: otro }),
      await retirarInfluencerDeCampana(operativo, ci.id),
      await reactivarInfluencerEnCampana(operativo, ci.id),
      await asociarProductoAInfluencer(operativo, {
        campaignInfluencerId: ci.id,
        campaignProductId: cpA.pro,
      }),
      await desasociarProducto(operativo, { campaignInfluencerId: ci.id, campaignProductId: cpA.p80 }),
    ]) {
      expect(codigo(r)).toBe('FORBIDDEN_ROLE');
    }
    expect(valor(await obtenerCampaignInfluencer(admin, ci.id)).products).toHaveLength(1);
  });

  it('el cliente TCL no gana acceso, ni siquiera a una campaña visible para TCL', async () => {
    await query(`UPDATE campaigns SET visibility = 'tcl' WHERE id = $1`, [campanaA]);
    try {
      const influencerId = await nuevoInfluencer(admin, 'Oculta a TCL');
      const ci = valor(await asociarInfluencerACampana(admin, { campaignId: campanaA, influencerId }));
      valor(
        await asociarProductoAInfluencer(admin, { campaignInfluencerId: ci.id, campaignProductId: cpA.p80 }),
      );

      expect(codigo(await listarInfluencersDeCampana(cliente, campanaA))).toBe('RESOURCE_NOT_FOUND');
      expect(codigo(await obtenerCampaignInfluencer(cliente, ci.id))).toBe('RESOURCE_NOT_FOUND');
      for (const r of [
        await asociarInfluencerACampana(cliente, { campaignId: campanaA, influencerId }),
        await retirarInfluencerDeCampana(cliente, ci.id),
        await asociarProductoAInfluencer(cliente, {
          campaignInfluencerId: ci.id,
          campaignProductId: cpA.pro,
        }),
        await desasociarProducto(cliente, { campaignInfluencerId: ci.id, campaignProductId: cpA.p80 }),
      ]) {
        expect(r.ok).toBe(false);
      }
      expect(valor(await obtenerCampaignInfluencer(admin, ci.id)).products).toHaveLength(1);
    } finally {
      await query(`UPDATE campaigns SET visibility = 'interna' WHERE id = $1`, [campanaA]);
    }
  });

  it('el actor «system» no obtiene mutaciones sobre la participación', async () => {
    const sistema = 'system' as unknown as User;
    const influencerId = await nuevoInfluencer(admin, 'Sin sistema');
    const ci = valor(await asociarInfluencerACampana(admin, { campaignId: campanaA, influencerId }));
    for (const r of [
      await asociarInfluencerACampana(sistema, { campaignId: campanaB, influencerId }),
      await retirarInfluencerDeCampana(sistema, ci.id),
      await reactivarInfluencerEnCampana(sistema, ci.id),
      await asociarProductoAInfluencer(sistema, { campaignInfluencerId: ci.id, campaignProductId: cpA.p80 }),
      await desasociarProducto(sistema, { campaignInfluencerId: ci.id, campaignProductId: cpA.p80 }),
    ]) {
      expect(codigo(r)).toBe('FORBIDDEN_ROLE');
    }
  });

  it('la correlación futura viaja al evento de la participación', async () => {
    const influencerId = await nuevoInfluencer(admin, 'Correlada');
    const ci = valor(
      await asociarInfluencerACampana(
        admin,
        { campaignId: campanaB, influencerId },
        { correlation: { conversationId: 'conv-9' } },
      ),
    );
    const [evento] = await query<{ correlation: Record<string, string>; origin: string }>(
      `SELECT correlation, origin FROM audit_events WHERE entity_id = $1`,
      [ci.id],
    );
    expect(evento).toMatchObject({ correlation: { conversationId: 'conv-9' }, origin: 'ui' });
  });
});

// ─────────────────────────── Limpieza de pruebas ───────────────────────────────

describe('limpieza de datos de prueba', () => {
  it('eliminar una campaña de prueba con participaciones y productos asignados funciona (solo en _test)', async () => {
    const efimera = await crearCampana(admin, 'F3 Efímera', ['P80']);
    const influencerId = await nuevoInfluencer(admin, 'Efímero');
    const ci = valor(await asociarInfluencerACampana(admin, { campaignId: efimera.id, influencerId }));
    valor(
      await asociarProductoAInfluencer(admin, {
        campaignInfluencerId: ci.id,
        campaignProductId: efimera.campaignProducts['P80']!,
      }),
    );
    await eliminarCampanaDePrueba(efimera.id);
    expect(await query(`SELECT 1 FROM campaigns WHERE id = $1`, [efimera.id])).toHaveLength(0);
    expect(
      await query(`SELECT 1 FROM campaign_influencers WHERE campaign_id = $1`, [efimera.id]),
    ).toHaveLength(0);
    // El influencer (identidad) sigue existiendo.
    expect(await query(`SELECT 1 FROM influencers WHERE id = $1`, [influencerId])).toHaveLength(1);
  });
});
