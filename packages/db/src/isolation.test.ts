/**
 * E2-6 · Aislamiento entre organizaciones, contra PostgreSQL real.
 *
 * Las pruebas del dominio (`packages/domain`) verifican la política sobre
 * objetos en memoria. Estas verifican que la política **se aplica de verdad**
 * cuando hay datos, consultas y una base que podría devolverlos.
 *
 * Casos S-01 a S-04 de D0-12. Un fallo aquí invalida la nota global de la
 * rúbrica de gerencia (§31): no resta puntos, invalida.
 *
 * Requiere la base levantada:  docker compose up -d db
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { User } from '@tcl-kol-os/domain';
import { closePool, query } from './client.ts';
import { archiveCampaign, createCampaign, getCampaign, listCampaigns } from './campaigns.ts';
import { findUserByEmail } from './users.ts';

let admin: User;
let consultor: User;
let cliente: User;
let ajeno: User;
let campanaPropia: string;
let campanaAjena: string;

beforeAll(async () => {
  admin = (await findUserByEmail('gerardo@smartpr.co'))!;
  consultor = (await findUserByEmail('consultor@smartpr.co'))!;
  cliente = (await findUserByEmail('marena@tcl.com'))!;
  ajeno = (await findUserByEmail('ajeno@otraagencia.co'))!;

  const propias = await query<{ id: string }>(
    `SELECT id FROM campaigns WHERE name = 'Lanzamiento línea P80'`,
  );
  campanaPropia = propias[0]!.id;

  const ajenas = await query<{ id: string }>(
    `SELECT id FROM campaigns WHERE name = 'Campaña confidencial de otra agencia'`,
  );
  campanaAjena = ajenas[0]!.id;
});

afterAll(async () => {
  await closePool();
});

describe('el seed dejó datos utilizables', () => {
  it('existen los cinco usuarios y las tres campañas', () => {
    expect(admin.role).toBe('admin');
    expect(consultor.role).toBe('consultor');
    expect(cliente.role).toBe('cliente');
    expect(ajeno.organizationId).not.toBe(admin.organizationId);
    expect(campanaPropia).toBeTruthy();
    expect(campanaAjena).toBeTruthy();
  });
});

// ─────────────────────────── Caso S-01 ────────────────────────────────────────

describe('acceso horizontal entre organizaciones (caso S-01)', () => {
  it('el admin de SmartPR NO puede abrir la campaña de otra agencia, aunque tenga su ID', async () => {
    const resultado = await getCampaign(admin, campanaAjena);
    expect(resultado.ok).toBe(false);
    if (!resultado.ok) expect(resultado.error.code).toBe('RESOURCE_NOT_FOUND');
  });

  it('el usuario ajeno tampoco puede abrir una campaña de SmartPR', async () => {
    const resultado = await getCampaign(ajeno, campanaPropia);
    expect(resultado.ok).toBe(false);
    if (!resultado.ok) expect(resultado.error.code).toBe('RESOURCE_NOT_FOUND');
  });

  it('devuelve NOT_FOUND y no FORBIDDEN: decir "existe pero no puedes" ya es una filtración', async () => {
    const inventado = '00000000-0000-4000-8000-000000000000';
    const inexistente = await getCampaign(admin, inventado);
    const ajena = await getCampaign(admin, campanaAjena);

    expect(inexistente.ok).toBe(false);
    expect(ajena.ok).toBe(false);
    if (!inexistente.ok && !ajena.ok) {
      // Un atacante no debe poder distinguir "no existe" de "no es tuya".
      expect(ajena.error.code).toBe(inexistente.error.code);
      expect(ajena.error.message).toBe(inexistente.error.message);
    }
  });

  it('el listado nunca incluye campañas de otra organización', async () => {
    const resultado = await listCampaigns(admin);
    expect(resultado.ok).toBe(true);
    if (resultado.ok) {
      expect(resultado.value.length).toBeGreaterThan(0);
      for (const c of resultado.value) {
        expect(c.organization_id).toBe(admin.organizationId);
        expect(c.id).not.toBe(campanaAjena);
      }
    }
  });

  it('el mensaje de error no revela nada del recurso ajeno', async () => {
    const resultado = await getCampaign(admin, campanaAjena);
    expect(resultado.ok).toBe(false);
    if (!resultado.ok) {
      expect(resultado.error.message).not.toContain('confidencial');
      expect(resultado.error.message).not.toContain(campanaAjena);
      expect(JSON.stringify(resultado.error.details ?? {})).not.toContain(campanaAjena);
    }
  });
});

// ─────────────────────────── Caso S-03 ────────────────────────────────────────

describe('escalamiento de rol (caso S-03)', () => {
  it('el consultor no puede archivar una campaña', async () => {
    const resultado = await archiveCampaign(consultor, campanaPropia);
    expect(resultado.ok).toBe(false);
    if (!resultado.ok) expect(resultado.error.code).toBe('FORBIDDEN_ROLE');
  });

  it('el cliente TCL no puede crear campañas', async () => {
    const resultado = await createCampaign(cliente, {
      name: 'Intento del cliente',
      ownerId: cliente.id,
      productos: [{ productId: '00000000-0000-4000-8000-000000000000' }],
    });
    expect(resultado.ok).toBe(false);
    if (!resultado.ok) expect(resultado.error.code).toBe('FORBIDDEN_ROLE');
  });

  it('el cliente TCL no ve campañas internas en su listado', async () => {
    const resultado = await listCampaigns(cliente);
    // El cliente pertenece a TCL Colombia y no hay nada compartido con él todavía.
    if (resultado.ok) {
      for (const c of resultado.value) {
        expect(['tcl', 'compartida']).toContain(c.visibility);
      }
    }
  });
});

// ─────────────────────────── Integridad multiproducto (DEC-016) ───────────────

describe('campañas multiproducto (DEC-016)', () => {
  it('la campaña P80 tiene tres productos ordenados por prioridad', async () => {
    const resultado = await getCampaign(admin, campanaPropia);
    expect(resultado.ok).toBe(true);
    if (resultado.ok) {
      expect(resultado.value.productos).toHaveLength(3);
      expect(resultado.value.productos.map((p) => p.model)).toEqual(['P80 Ultra', 'P80 Pro', 'P80']);
      expect(resultado.value.productos[0]!.rol).toBe('flagship');
    }
  });

  it('avisa que el reparto de presupuesto del P80 suma 90%, no 100% (historia E3-9)', async () => {
    const resultado = await getCampaign(admin, campanaPropia);
    expect(resultado.ok).toBe(true);
    if (resultado.ok) {
      expect(resultado.value.avisoPresupuesto).toBeDefined();
      expect(resultado.value.avisoPresupuesto).toContain('90%');
    }
  });

  it('una campaña de un solo producto no genera aviso', async () => {
    const listado = await listCampaigns(admin);
    expect(listado.ok).toBe(true);
    if (!listado.ok) return;
    const c7l = listado.value.find((c) => c.name === 'Lanzamiento C7L')!;
    const detalle = await getCampaign(admin, c7l.id);
    expect(detalle.ok).toBe(true);
    if (detalle.ok) expect(detalle.value.avisoPresupuesto).toBeUndefined();
  });

  it('rechaza crear una campaña sin ningún producto', async () => {
    const resultado = await createCampaign(admin, {
      name: 'Campaña sin producto',
      ownerId: admin.id,
      productos: [],
    });
    expect(resultado.ok).toBe(false);
  });

  it('rechaza repetir el mismo producto en una campaña', async () => {
    const productos = await query<{ id: string }>(`SELECT id FROM products WHERE model = 'C7L'`);
    const id = productos[0]!.id;
    const resultado = await createCampaign(admin, {
      name: 'Campaña con producto duplicado',
      ownerId: admin.id,
      productos: [{ productId: id }, { productId: id }],
    });
    expect(resultado.ok).toBe(false);
  });
});

// ─────────────────────────── Auditoría ────────────────────────────────────────

describe('auditoría (§10.3, regla 4)', () => {
  it('crear una campaña deja rastro con actor y fecha', async () => {
    const productos = await query<{ id: string }>(`SELECT id FROM products WHERE model = 'X11L'`);
    const creada = await createCampaign(admin, {
      name: `Campaña de prueba de auditoría ${Date.now()}`,
      ownerId: admin.id,
      productos: [{ productId: productos[0]!.id }],
    });
    expect(creada.ok).toBe(true);
    if (!creada.ok) return;

    const eventos = await query<{ actor_id: string; action: string; entity_id: string }>(
      `SELECT actor_id, action, entity_id FROM audit_events WHERE entity_id = $1`,
      [creada.value.id],
    );
    expect(eventos).toHaveLength(1);
    expect(eventos[0]!.action).toBe('campaign.create');
    expect(eventos[0]!.actor_id).toBe(admin.id);
  });

  it('la auditoría no admite modificación posterior', async () => {
    await expect(
      query(`UPDATE audit_events SET action = 'manipulado' WHERE action = 'seed.run'`),
    ).rejects.toThrow(/solo inserción/);
  });

  it('la auditoría no admite borrado', async () => {
    await expect(query(`DELETE FROM audit_events WHERE action = 'seed.run'`)).rejects.toThrow(
      /solo inserción/,
    );
  });
});
