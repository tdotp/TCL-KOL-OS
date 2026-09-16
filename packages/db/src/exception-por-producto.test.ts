/**
 * E7-8 · Interruptor compartido/específico por producto (DEC-016).
 *
 * En un campo `compartido_con_excepcion`, editar la fila compartida
 * (`campaign_product_id IS NULL`) sigue afectando a todos los productos que
 * no tengan su propia excepción. Declarar una excepción crea una fila nueva
 * anclada a UN producto — desengancha solo ese, con motivo obligatorio.
 *
 * Campaña propia y desechable (INC-001A) — nunca P80 ni el seed compartido.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { User } from '@tcl-kol-os/domain';
import { closePool, query } from './client.ts';
import { eliminarCampanaDePrueba } from './test-utils.ts';
import { crearBriefManual } from './manual.ts';
import { declararExcepcionProducto, revertirExcepcionProducto } from './brief-fields.ts';

let orgId: string;
let userId: string;
let actor: User;
let campanaPropia: string;
let productoA: string;
let productoB: string;
let versionId: string;

/** `mensaje_principal.one_line` es `compartido_con_excepcion` (DEC-021/catálogo). */
const CLAVE_COMPARTIDA = 'mensaje_principal.one_line';
/** `marca_producto[].nombre_producto` es de nivel `producto` — nunca admite excepción. */
const CLAVE_DE_PRODUCTO = 'marca_producto[].nombre_producto';

beforeAll(async () => {
  const [admin] = await query<{ id: string; organization_id: string }>(
    `SELECT id, organization_id FROM users WHERE email = 'gerardo@smartpr.co'`,
  );
  userId = admin!.id;
  orgId = admin!.organization_id;
  actor = {
    id: userId,
    email: 'gerardo@smartpr.co',
    name: 'Gerardo',
    organizationId: orgId,
    role: 'admin',
    status: 'activo',
  };

  const campana = await query<{ id: string }>(
    `INSERT INTO campaigns (organization_id, name, owner_id, created_by)
     VALUES ($1, $2, $3, $3) RETURNING id`,
    [orgId, `Excepción por producto · corrida ${Date.now()}`, userId],
  );
  campanaPropia = campana[0]!.id;

  const productos = await query<{ id: string }>(`SELECT id FROM products LIMIT 2`);
  for (const [i, p] of productos.entries()) {
    await query(
      `INSERT INTO campaign_products (campaign_id, product_id, rol, prioridad) VALUES ($1, $2, $3, $4)`,
      [campanaPropia, p.id, i === 0 ? 'flagship' : 'secundario', i + 1],
    );
  }
  const filasProducto = await query<{ id: string }>(
    `SELECT id FROM campaign_products WHERE campaign_id = $1 ORDER BY prioridad`,
    [campanaPropia],
  );
  productoA = filasProducto[0]!.id;
  productoB = filasProducto[1]!.id;

  const creado = await crearBriefManual(actor, campanaPropia);
  if (!creado.ok) throw new Error('No se pudo sembrar el brief manual de prueba.');
  versionId = creado.value.versionId;
});

afterAll(async () => {
  await eliminarCampanaDePrueba(campanaPropia);
  await closePool();
});

describe('declarar una excepción por producto', () => {
  it('exige un motivo', async () => {
    const resultado = await declararExcepcionProducto(actor, versionId, {
      key: CLAVE_COMPARTIDA,
      campaignProductId: productoA,
      value: 'Solo para este producto',
      motivo: '   ',
    });
    expect(resultado.ok).toBe(false);
    if (resultado.ok) return;
    expect(resultado.error.message).toMatch(/motivo/);
  });

  it('rechaza un campo que no es compartido_con_excepcion', async () => {
    const resultado = await declararExcepcionProducto(actor, versionId, {
      key: CLAVE_DE_PRODUCTO,
      campaignProductId: productoA,
      value: 'TCL X',
      motivo: 'Intento inválido',
    });
    expect(resultado.ok).toBe(false);
    if (resultado.ok) return;
    expect(resultado.error.message).toMatch(/no es un campo compartido/);
  });

  it('rechaza un producto que no pertenece a la campaña', async () => {
    const [otraCampana] = await query<{ id: string }>(
      `SELECT cp.id FROM campaign_products cp WHERE cp.campaign_id <> $1 LIMIT 1`,
      [campanaPropia],
    );
    const resultado = await declararExcepcionProducto(actor, versionId, {
      key: CLAVE_COMPARTIDA,
      campaignProductId: otraCampana!.id,
      value: 'x',
      motivo: 'Intento inválido',
    });
    expect(resultado.ok).toBe(false);
    if (resultado.ok) return;
    expect(resultado.error.message).toMatch(/no pertenece a esta campaña/);
  });

  it('crea una fila nueva anclada al producto, sin tocar la fila compartida', async () => {
    const [antes] = await query<{ value: unknown }>(
      `SELECT value FROM brief_fields
        WHERE brief_version_id = $1 AND key = $2 AND campaign_product_id IS NULL`,
      [versionId, CLAVE_COMPARTIDA],
    );
    expect(antes!.value).toBeNull();

    const resultado = await declararExcepcionProducto(actor, versionId, {
      key: CLAVE_COMPARTIDA,
      campaignProductId: productoA,
      value: 'Mensaje exclusivo para el producto A',
      motivo: 'El cliente pidió un mensaje distinto solo para este modelo.',
    });
    expect(resultado.ok).toBe(true);

    const filas = await query<{
      campaign_product_id: string | null;
      value: unknown;
      provenance_type: string;
    }>(
      `SELECT campaign_product_id, value, provenance_type::text
         FROM brief_fields WHERE brief_version_id = $1 AND key = $2`,
      [versionId, CLAVE_COMPARTIDA],
    );
    // La compartida sigue ahí, intacta; y ahora hay una fila más, del producto A.
    expect(filas).toHaveLength(2);
    const compartida = filas.find((f) => f.campaign_product_id === null);
    expect(compartida!.value).toBeNull();
    const excepcion = filas.find((f) => f.campaign_product_id === productoA);
    expect(excepcion!.value).toBe('Mensaje exclusivo para el producto A');
    expect(excepcion!.provenance_type).toBe('manual_local');

    const [revision] = await query<{ accion: string; motivo: string | null }>(
      `SELECT accion, motivo FROM brief_field_revisions
        WHERE brief_field_id = (
          SELECT id FROM brief_fields
           WHERE brief_version_id = $1 AND key = $2 AND campaign_product_id = $3
        )`,
      [versionId, CLAVE_COMPARTIDA, productoA],
    );
    expect(revision!.accion).toBe('declare_exception');
    expect(revision!.motivo).toMatch(/mensaje distinto/);
  });

  it('un segundo producto puede tener su propia excepción, distinta e independiente', async () => {
    const resultado = await declararExcepcionProducto(actor, versionId, {
      key: CLAVE_COMPARTIDA,
      campaignProductId: productoB,
      value: 'Mensaje exclusivo para el producto B',
      motivo: 'Otro mensaje, para el segundo producto de la campaña.',
    });
    expect(resultado.ok).toBe(true);

    const filas = await query<{ campaign_product_id: string | null; value: unknown }>(
      `SELECT campaign_product_id, value FROM brief_fields WHERE brief_version_id = $1 AND key = $2`,
      [versionId, CLAVE_COMPARTIDA],
    );
    // Compartida + excepción A + excepción B: tres filas, tres valores distintos.
    expect(filas).toHaveLength(3);
    const valores = new Set(filas.map((f) => f.value));
    expect(valores.size).toBe(3);
  });

  it('declarar dos veces sobre el mismo producto corrige, no duplica', async () => {
    const primera = await declararExcepcionProducto(actor, versionId, {
      key: CLAVE_COMPARTIDA,
      campaignProductId: productoA,
      value: 'Primer valor de la excepción',
      motivo: 'Primer intento.',
    });
    expect(primera.ok).toBe(true);
    if (!primera.ok) return;

    const segunda = await declararExcepcionProducto(actor, versionId, {
      key: CLAVE_COMPARTIDA,
      campaignProductId: productoA,
      value: 'Valor corregido de la excepción',
      motivo: 'Se corrige el mensaje anterior.',
      revisionEsperada: primera.value.revision,
    });
    expect(segunda.ok).toBe(true);

    const filas = await query<{ campaign_product_id: string | null }>(
      `SELECT campaign_product_id FROM brief_fields
        WHERE brief_version_id = $1 AND key = $2 AND campaign_product_id = $3`,
      [versionId, CLAVE_COMPARTIDA, productoA],
    );
    expect(filas).toHaveLength(1);
  });

  it('rechaza corregir una excepción con una revisión vieja (concurrencia optimista)', async () => {
    const resultado = await declararExcepcionProducto(actor, versionId, {
      key: CLAVE_COMPARTIDA,
      campaignProductId: productoA,
      value: 'Otro intento con revisión desactualizada',
      motivo: 'No debería aplicarse.',
      revisionEsperada: 1,
    });
    expect(resultado.ok).toBe(false);
    if (resultado.ok) return;
    expect(resultado.error.code).toBe('FIELD_REVISION_CONFLICT');
  });
});

describe('revertir una excepción', () => {
  it('borra la fila del producto; el campo vuelve a depender solo de la compartida', async () => {
    const [excepcion] = await query<{ id: string }>(
      `SELECT id FROM brief_fields
        WHERE brief_version_id = $1 AND key = $2 AND campaign_product_id = $3`,
      [versionId, CLAVE_COMPARTIDA, productoB],
    );
    expect(excepcion).toBeDefined();

    const resultado = await revertirExcepcionProducto(actor, versionId, excepcion!.id);
    expect(resultado.ok).toBe(true);

    const filas = await query<{ campaign_product_id: string | null }>(
      `SELECT campaign_product_id FROM brief_fields WHERE brief_version_id = $1 AND key = $2`,
      [versionId, CLAVE_COMPARTIDA],
    );
    // Queda la compartida y la excepción del producto A; la de B desapareció.
    expect(filas.map((f) => f.campaign_product_id).sort()).toEqual([null, productoA].sort());
  });

  it('no admite revertir un campo que no es una excepción de producto', async () => {
    const [compartido] = await query<{ id: string }>(
      `SELECT id FROM brief_fields WHERE brief_version_id = $1 AND key = $2 AND campaign_product_id IS NULL`,
      [versionId, CLAVE_COMPARTIDA],
    );
    const resultado = await revertirExcepcionProducto(actor, versionId, compartido!.id);
    expect(resultado.ok).toBe(false);
  });
});
