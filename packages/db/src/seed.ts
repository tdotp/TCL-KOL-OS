/**
 * Datos de arranque para desarrollo.
 *
 * Crea DOS organizaciones a propósito: sin una segunda organización no se puede
 * demostrar el aislamiento, que es el criterio de aceptación de la Épica E2.
 *
 *   npm run seed --workspace @tcl-kol-os/db
 */

import { closePool, query, transaction } from './client.ts';

interface Id {
  readonly id: string;
}

export async function seed(): Promise<void> {
  await transaction(async (client) => {
    const yaSembrado = await client.query<Id>(`SELECT id FROM organizations LIMIT 1`);
    if (yaSembrado.rows.length > 0) {
      throw new Error('La base ya tiene datos. Vacíela antes de volver a sembrar.');
    }

    // ── Organizaciones ──
    const { rows: orgs } = await client.query<Id & { name: string }>(
      `INSERT INTO organizations (name, type) VALUES
         ('SmartPR', 'agencia'),
         ('TCL Colombia', 'cliente'),
         ('Agencia Ajena', 'agencia')
       RETURNING id, name`,
    );
    const smartpr = orgs.find((o) => o.name === 'SmartPR')!.id;
    const tcl = orgs.find((o) => o.name === 'TCL Colombia')!.id;
    const ajena = orgs.find((o) => o.name === 'Agencia Ajena')!.id;

    // ── Usuarios ──
    // DEC-011: el piloto opera con un solo usuario admin. Los demás existen para
    // poder probar los permisos que la matriz D0-07 define.
    const { rows: users } = await client.query<Id & { email: string }>(
      `INSERT INTO users (email, name, organization_id, role) VALUES
         ('gerardo@smartpr.co',  'Gerardo Calambás',  $1, 'admin'),
         ('director@smartpr.co', 'Director de cuenta', $1, 'director'),
         ('consultor@smartpr.co','Consultora PR',      $1, 'consultor'),
         ('operativo@smartpr.co','Usuario Operativo',  $1, 'operativo'),
         ('marena@tcl.com',      'Marena Herreño',     $2, 'cliente'),
         ('ajeno@otraagencia.co','Usuario Ajeno',      $3, 'admin')
       RETURNING id, email`,
      [smartpr, tcl, ajena],
    );
    const gerardo = users.find((u) => u.email === 'gerardo@smartpr.co')!.id;
    const ajeno = users.find((u) => u.email === 'ajeno@otraagencia.co')!.id;

    // ── Productos ──
    // Tomados del material real: la línea P80 y los televisores C7L y X11L.
    const { rows: prods } = await client.query<Id & { model: string }>(
      `INSERT INTO products (brand, category, model, market) VALUES
         ('TCL', 'Smartphones', 'P80',        'CO'),
         ('TCL', 'Smartphones', 'P80 Pro',    'CO'),
         ('TCL', 'Smartphones', 'P80 Ultra',  'CO'),
         ('TCL', 'Televisores', 'C7L',        'CO'),
         ('TCL', 'Televisores', 'X11L',       'CO'),
         ('TCL', 'Audio',       'Soundbar S64','CO')
       RETURNING id, model`,
    );
    const byModel = (m: string) => prods.find((p) => p.model === m)!.id;

    // ── Campaña multiproducto real: la línea P80 (DEC-016) ──
    const { rows: camps } = await client.query<Id>(
      `INSERT INTO campaigns (organization_id, name, market, category, owner_id, start_date, end_date, created_by)
       VALUES ($1, 'Lanzamiento línea P80', 'CO', 'Smartphones', $2, '2026-09-04', '2026-11-30', $2)
       RETURNING id`,
      [smartpr, gerardo],
    );
    const p80 = camps[0]!.id;

    // Reparto 60/20/10 tal como lo declara el brief: suma 90%, no 100%.
    // Se siembra así a propósito para que el aviso de E3-9 sea visible.
    await client.query(
      `INSERT INTO campaign_products (campaign_id, product_id, rol, prioridad, participacion_presupuesto) VALUES
         ($1, $2, 'flagship',   1, 0.600),
         ($1, $3, 'secundario', 2, 0.200),
         ($1, $4, 'entrada',    3, 0.100)`,
      [p80, byModel('P80 Ultra'), byModel('P80 Pro'), byModel('P80')],
    );

    // ── Campaña de un solo producto ──
    const { rows: camps2 } = await client.query<Id>(
      `INSERT INTO campaigns (organization_id, name, market, category, owner_id, start_date, end_date, created_by)
       VALUES ($1, 'Lanzamiento C7L', 'CO', 'Televisores', $2, '2026-07-01', '2026-09-30', $2)
       RETURNING id`,
      [smartpr, gerardo],
    );
    await client.query(
      `INSERT INTO campaign_products (campaign_id, product_id, rol, prioridad, participacion_presupuesto)
       VALUES ($1, $2, 'unico', 1, 1.000)`,
      [camps2[0]!.id, byModel('C7L')],
    );

    // ── Campaña de OTRA organización ──
    // Existe solo para que las pruebas de aislamiento tengan algo real que
    // intentar alcanzar (caso S-01).
    const { rows: camps3 } = await client.query<Id>(
      `INSERT INTO campaigns (organization_id, name, market, category, owner_id, created_by)
       VALUES ($1, 'Campaña confidencial de otra agencia', 'CO', 'Otro', $2, $2)
       RETURNING id`,
      [ajena, ajeno],
    );

    await client.query(
      `INSERT INTO audit_events (organization_id, actor_id, action, entity_type, entity_id, metadata)
       VALUES ($1, $2, 'seed.run', 'system', NULL, '{"origen":"seed de desarrollo"}'::jsonb)`,
      [smartpr, gerardo],
    );

    console.log(`  organizaciones: 3 (SmartPR, TCL Colombia, Agencia Ajena)`);
    console.log(`  usuarios: 6`);
    console.log(`  productos: 6`);
    console.log(`  campañas: 3 — dos de SmartPR, una de otra organización`);
    console.log(`    · Lanzamiento línea P80 → 3 productos, reparto 60/20/10`);
    console.log(`    · Campaña ajena (id ${camps3[0]!.id}) para probar aislamiento`);
  });
}

const isMain = process.argv[1] !== undefined && process.argv[1].endsWith('seed.ts');
if (isMain) {
  try {
    await seed();
    const filas = await query<{ total: string }>('SELECT count(*)::text AS total FROM campaigns');
    console.log(`Listo. ${filas[0]?.total ?? '0'} campañas en la base.`);
  } catch (error) {
    console.error(`Error: ${(error as Error).message}`);
    process.exitCode = 1;
  } finally {
    await closePool();
  }
}
