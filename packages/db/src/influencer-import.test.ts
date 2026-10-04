/**
 * V2 · Fase 5 — del Google Sheet al dominio, de punta a punta.
 *
 *   Sheet (simulado) → worker real → snapshot → validación del esquema → plan →
 *   matching determinístico → Influencer / CampaignInfluencer / producto →
 *   resolución HUMANA de lo ambiguo
 *
 * Datos sintéticos, campañas e influencers propios y desechables. Sin entorno de
 * Python del worker, la suite se omite con un aviso explícito (nunca en silencio).
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
import { registerLinkedSource } from './sources.ts';
import { syncGoogleSheetSource } from './source-sync.ts';
import { crearInfluencer, obtenerInfluencer } from './influencers.ts';
import {
  listarInfluencersDeCampana,
  reactivarInfluencerEnCampana,
  retirarInfluencerDeCampana,
} from './campaign-influencers.ts';
import {
  type ImportDecision,
  applyInfluencerImport,
  compareSheetSnapshots,
  getImportPlan,
  getParticipationOrigin,
  listImportPlans,
  prepareInfluencerImport,
  resolveImportRecord,
  validateInfluencerSheetSnapshot,
} from './influencer-import.ts';
import {
  CABECERAS_V1,
  type CeldaDePrueba,
  GoogleSimulado,
  pestanaDeInfluencers,
} from './google-test-utils.ts';
import { hayWorkerLocal, procesarColaConWorker } from './worker-test-utils.ts';

const sufijo = Date.now().toString(36);
const h = (base: string) => `${base}${sufijo}`.toLowerCase();
const ID = (n: number) => `1Imp${sufijo}${String(n).padStart(3, '0')}${'y'.repeat(30)}`.slice(0, 44);

let admin: User;
let director: User;
let consultor: User;
let operativo: User;
let cliente: User;
let ajeno: User;
let google: GoogleSimulado;
let hayWorker = false;
let contador = 1;

interface Campana {
  readonly id: string;
  readonly cp: Record<string, string>;
}
let campanaA: Campana; // P80 + P80 Pro
let campanaB: Campana; // C7L + P80
let campanaAjena: Campana;
const campanas: string[] = [];
const influencers: string[] = [];
let productoDuplicado: string; // un modelo con DOS marcas en la misma campaña

function valor<T>(r: Result<T>): T {
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
  return r.value;
}
type Resultado = { readonly ok: true } | { readonly ok: false; readonly error: { readonly code: string } };
const codigo = (r: Resultado) => (r.ok ? undefined : r.error.code);
const detalle = (r: Result<unknown>) => (r.ok ? undefined : r.error.details);

async function productoId(modelo: string): Promise<string> {
  const [fila] = await query<{ id: string }>(`SELECT id FROM products WHERE model = $1`, [modelo]);
  return fila!.id;
}

async function crearCampana(owner: User, nombre: string, modelos: string[]): Promise<Campana> {
  const [c] = await query<{ id: string }>(
    `INSERT INTO campaigns (organization_id, name, owner_id, created_by) VALUES ($1, $2, $3, $3) RETURNING id`,
    [owner.organizationId, `${nombre} ${sufijo}`, owner.id],
  );
  campanas.push(c!.id);
  const cp: Record<string, string> = {};
  for (const [i, modelo] of modelos.entries()) {
    const [fila] = await query<{ id: string }>(
      `INSERT INTO campaign_products (campaign_id, product_id, rol, prioridad, participacion_presupuesto)
       VALUES ($1, $2, 'secundario', $3, 0.5) RETURNING id`,
      [c!.id, await productoId(modelo), i + 1],
    );
    cp[modelo] = fila!.id;
  }
  return { id: c!.id, cp };
}

type Fila = readonly CeldaDePrueba[];
/** Una fila de datos: [clave, nombre, plataforma, handle, producto]. */
const fila = (clave: string, nombre: string, plataforma: string, handle: string, producto = ''): Fila => [
  clave,
  nombre,
  plataforma,
  handle,
  producto,
];

interface Hoja {
  readonly sourceId: string;
  readonly libroId: string;
  readonly campaignId: string;
}

/** Registra un Google Sheet en la campaña. */
async function nuevaHoja(campana: Campana, owner: User = admin): Promise<Hoja> {
  const n = contador++;
  const r = valor(
    await registerLinkedSource(owner, {
      campaignId: campana.id,
      url: `https://docs.google.com/spreadsheets/d/${ID(n)}/edit#gid=11`,
    }),
  );
  return { sourceId: r.id, libroId: ID(n), campaignId: campana.id };
}

/** Publica el contenido en el Sheet simulado, sincroniza con el worker REAL y devuelve el snapshot vigente. */
async function sincronizar(
  hoja: Hoja,
  filas: readonly Fila[],
  opciones: Parameters<typeof pestanaDeInfluencers>[1] = {},
) {
  await google.publicar(hoja.libroId, [pestanaDeInfluencers(filas, opciones)]);
  valor(await syncGoogleSheetSource(admin, hoja.sourceId));
  await procesarColaConWorker(google.entorno);
  const [fuente] = await query<{ current_snapshot_id: string }>(
    `SELECT current_snapshot_id FROM source_documents WHERE id = $1`,
    [hoja.sourceId],
  );
  return fuente!.current_snapshot_id;
}

async function planear(hoja: Hoja, actor: User = admin) {
  return prepareInfluencerImport(actor, { campaignId: hoja.campaignId, sourceId: hoja.sourceId });
}

/** Sincroniza + planea + devuelve el plan. */
async function plan(
  hoja: Hoja,
  filas: readonly Fila[],
  opciones: Parameters<typeof pestanaDeInfluencers>[1] = {},
) {
  await sincronizar(hoja, filas, opciones);
  return valor(await planear(hoja));
}

const registroDe = (detalle: Awaited<ReturnType<typeof plan>>, clave: string) =>
  detalle.records.find((r) => r.sourceKey === clave)!;

async function contar(tabla: string, donde = 'true', params: unknown[] = []): Promise<number> {
  const [f] = await query<{ n: number }>(`SELECT count(*)::int AS n FROM ${tabla} WHERE ${donde}`, params);
  return f!.n;
}

async function participantes(campaignId: string) {
  return valor(await listarInfluencersDeCampana(admin, campaignId));
}

async function crearPersona(nombre: string, cuentas: { platform: 'instagram' | 'tiktok'; handle: string }[]) {
  const creado = valor(await crearInfluencer(admin, { displayName: nombre, cuentas }));
  influencers.push(creado.influencer.id);
  return creado.influencer.id;
}

async function auditoria(entityId: string) {
  return query<{
    action: string;
    origin: string | null;
    actor_id: string | null;
    metadata: Record<string, unknown>;
  }>(
    `SELECT action, origin, actor_id, metadata FROM audit_events WHERE entity_id = $1 ORDER BY created_at, id`,
    [entityId],
  );
}

/** Influencers de la organización creados por ESTA corrida (por sufijo en el handle). */
async function influencersConHandle(base: string) {
  return query<{ id: string; display_name: string }>(
    `SELECT DISTINCT i.id, i.display_name FROM influencers i
       JOIN influencer_accounts a ON a.influencer_id = i.id
      WHERE a.normalized_handle LIKE $1 AND i.organization_id = $2`,
    [`${base.toLowerCase()}%${sufijo}`, admin.organizationId],
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
  hayWorker = hayWorkerLocal();
  if (!hayWorker) {
    console.warn(
      'No hay entorno de Python del worker (services/ai-worker/.venv); se omiten las pruebas con worker real. ' +
        'Créelo con: cd services/ai-worker && python3 -m venv .venv && .venv/bin/pip install -r requirements.txt',
    );
  }
  google = await GoogleSimulado.crear();

  campanaA = await crearCampana(admin, 'Importación A', ['P80', 'P80 Pro']);
  campanaB = await crearCampana(admin, 'Importación B', ['C7L', 'P80']);
  campanaAjena = await crearCampana(ajeno, 'Importación ajena', ['P80']);

  // Dos productos de LA MISMA campaña con el mismo modelo y marcas distintas: referencia ambigua.
  const [otro] = await query<{ id: string }>(
    `INSERT INTO products (brand, category, model) VALUES ($1, 'audio', 'Soundbar S64') RETURNING id`,
    [`Marca ${sufijo}`],
  );
  const base = await productoId('Soundbar S64');
  for (const id of [base, otro!.id]) {
    const [cp] = await query<{ id: string }>(
      `INSERT INTO campaign_products (campaign_id, product_id, rol, prioridad) VALUES ($1, $2, 'secundario', 9) RETURNING id`,
      [campanaA.id, id],
    );
    if (id === otro!.id) productoDuplicado = cp!.id;
  }
});

afterAll(async () => {
  // Los Influencer que creó la importación no están en `influencers[]`: se recogen por el
  // sufijo de la corrida en sus handles (todos los de estas pruebas lo llevan).
  const creados = await query<{ id: string }>(
    `SELECT DISTINCT i.id FROM influencers i JOIN influencer_accounts a ON a.influencer_id = i.id
      WHERE a.normalized_handle LIKE $1`,
    [`%${sufijo}%`],
  );
  await eliminarCampanaDePrueba(campanas);
  await eliminarInfluencersDePrueba([...influencers, ...creados.map((f) => f.id)]);
  await query(`DELETE FROM products WHERE brand = $1`, [`Marca ${sufijo}`]);
  await google.limpiar();
  await closePool();
});

const si = (nombre: string, fn: () => Promise<void>) =>
  it(nombre, async () => (hayWorker ? fn() : undefined));

// ─────────────────────────── Esquema y plan ────────────────────────────────────

describe('plan de importación', () => {
  si('prepara un plan ligado a su snapshot SIN mutar el dominio', async () => {
    const hoja = await nuevaHoja(campanaA);
    const antes = await contar('influencers', 'organization_id = $1', [admin.organizationId]);
    const p = await plan(hoja, [
      fila('INF-001', 'Valentina Rojas', 'instagram', h('valentina'), 'P80'),
      fila('INF-002', 'Juan Pérez', 'tiktok', h('juanp')),
    ]);
    expect(p.plan).toMatchObject({ status: 'ready', campaignId: campanaA.id, sourceId: hoja.sourceId });
    expect(p.plan.validation).toMatchObject({
      status: 'valid',
      schema: { id: 'TCL_KOL_OS_INFLUENCERS', version: 1 },
    });
    expect(p.records.map((r) => [r.sourceKey, r.identity.outcome, r.state])).toEqual([
      ['INF-001', 'create_new', 'actionable'],
      ['INF-002', 'create_new', 'actionable'],
    ]);
    const [snap] = await query<{ current_snapshot_id: string }>(
      `SELECT current_snapshot_id FROM source_documents WHERE id = $1`,
      [hoja.sourceId],
    );
    expect(p.plan.snapshotId).toBe(snap!.current_snapshot_id);
    // Cada registro conserva su ubicación en el snapshot.
    expect(registroDe(p, 'INF-001').locators[0]).toMatchObject({
      kind: 'range',
      sheet: 'Influencers',
      range: 'A3:E3',
    });
    // Planear no crea nada.
    expect(await contar('influencers', 'organization_id = $1', [admin.organizationId])).toBe(antes);
    expect(await contar('influencer_source_bindings', 'source_id = $1', [hoja.sourceId])).toBe(0);
    const acciones = (await auditoria(hoja.sourceId)).map((e) => e.action);
    expect(acciones).toContain('influencer_import.schema_validate');
    expect((await auditoria(p.plan.id)).map((e) => e.action)).toContain('influencer_import.plan_create');
  });

  si('el mismo snapshot da el MISMO plan (no se recalcula)', async () => {
    const hoja = await nuevaHoja(campanaA);
    const primero = await plan(hoja, [fila('INF-001', 'Ana', 'instagram', h('ana1'))]);
    const segundo = valor(await planear(hoja));
    expect(segundo.plan.id).toBe(primero.plan.id);
    expect(await contar('influencer_import_plans', 'source_id = $1', [hoja.sourceId])).toBe(1);
    // Sincronizar sin cambios tampoco crea otro snapshot ni otro plan.
    await sincronizar(hoja, [fila('INF-001', 'Ana', 'instagram', h('ana1'))]);
    expect(valor(await planear(hoja)).plan.id).toBe(primero.plan.id);
  });

  si('un Sheet que no cumple el esquema produce un plan inválido y NO muta nada', async () => {
    const antes = await contar('influencers', 'organization_id = $1', [admin.organizationId]);
    for (const [opciones, error] of [
      [{ marcador: null }, 'MARKER_MISSING'],
      [{ marcador: 'TCL_KOL_OS_INFLUENCERS_V2' }, 'MARKER_UNSUPPORTED_VERSION'],
      [{ cabeceras: ['clave_influencer', 'nombre', 'plataforma'] }, 'HEADER_REQUIRED_MISSING'],
      [{ cabeceras: [...CABECERAS_V1, 'handle'] }, 'HEADER_DUPLICATE'],
    ] as const) {
      const hoja = await nuevaHoja(campanaA);
      const p = await plan(hoja, [fila('INF-001', 'Roto', 'instagram', h('roto'))], opciones);
      expect(p.plan.status).toBe('schema_invalid');
      expect(p.plan.validation.errors.map((e) => e.code)).toContain(error);
      expect(p.records).toEqual([]);
      const r = await applyInfluencerImport(admin, p.plan.id);
      expect(codigo(r)).toBe('VALIDATION_FAILED');
      // El snapshot es válido aunque el esquema no: la integración técnica no está rota.
      const [fuente] = await query<{ status: string }>(
        `SELECT status::text AS status FROM source_documents WHERE id = $1`,
        [hoja.sourceId],
      );
      expect(fuente!.status).toBe('procesado');
    }
    expect(await contar('influencers', 'organization_id = $1', [admin.organizationId])).toBe(antes);
  });

  si('validar sin persistir informa los errores y las advertencias', async () => {
    const hoja = await nuevaHoja(campanaA);
    await sincronizar(hoja, [fila('INF-001', 'Ana', 'instagram', h('ana2'))], {
      cabeceras: [...CABECERAS_V1, 'Notas del equipo'],
    });
    const v = valor(
      await validateInfluencerSheetSnapshot(admin, { campaignId: campanaA.id, sourceId: hoja.sourceId }),
    );
    expect(v.status).toBe('valid');
    expect(v.warnings.map((w) => w.code)).toEqual(['HEADER_UNKNOWN']);
    expect(await contar('influencer_import_plans', 'source_id = $1', [hoja.sourceId])).toBe(0);
  });

  si('las filas inválidas se informan por registro y no impiden las demás', async () => {
    const hoja = await nuevaHoja(campanaA);
    const p = await plan(hoja, [
      fila('INF-001', 'Buena', 'instagram', h('buena')),
      fila('INF-002', 'Rota', 'myspace', h('rota')),
    ]);
    expect(registroDe(p, 'INF-001').state).toBe('actionable');
    expect(registroDe(p, 'INF-002')).toMatchObject({ state: 'invalid', identity: { outcome: 'invalid' } });
    expect(registroDe(p, 'INF-002').problems.map((x) => x.code)).toContain('ROW_PLATFORM_UNSUPPORTED');
    expect(p.plan.status).toBe('needs_resolution');
    const r = valor(await applyInfluencerImport(admin, p.plan.id));
    expect(r.records.find((x) => x.sourceKey === 'INF-001')!.status).toBe('applied');
    expect(r.records.find((x) => x.sourceKey === 'INF-002')!.status).toBe('skipped');
    expect((await influencersConHandle('rota')).length).toBe(0);
  });

  si('las columnas futuras se conservan en el snapshot y no crean nada más', async () => {
    const hoja = await nuevaHoja(campanaA);
    const cabeceras = [...CABECERAS_V1, 'entregables', 'tipo_acuerdo', 'fee', 'fecha_inicio'];
    const p = await plan(
      hoja,
      [
        [
          ...fila('INF-001', 'Con acuerdo', 'instagram', h('acuerdo'), 'P80'),
          '2 reels',
          'mixto',
          1500000,
          '2026-11-01',
        ],
      ],
      { cabeceras },
    );
    expect([...registroDe(p, 'INF-001').futureFields].sort()).toEqual([
      'entregables',
      'fecha_inicio',
      'fee',
      'tipo_acuerdo',
    ]);
    valor(await applyInfluencerImport(admin, p.plan.id));
    // No hay Agreements/Deliverables/KPIs ni columnas de acuerdo en CampaignInfluencer.
    const columnas = await query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'campaign_influencers'`,
    );
    expect(columnas.map((c) => c.column_name).sort()).toEqual(
      [
        'campaign_id',
        'created_at',
        'created_by',
        'id',
        'influencer_id',
        'organization_id',
        'retired_at',
        'status',
        'updated_at',
      ].sort(),
    );
    // El valor sigue en el snapshot, con su ubicación.
    const filas = await query<{ cells: { text: string }[] }>(
      `SELECT r.cells FROM source_snapshot_rows r JOIN source_documents s ON s.current_snapshot_id = r.snapshot_id
        WHERE s.id = $1 AND r.row_number = 3`,
      [hoja.sourceId],
    );
    expect(filas[0]!.cells.map((c) => c.text)).toContain('1500000');
  });
});

// ─────────────────────────── Aplicar ───────────────────────────────────────────

describe('aplicar el plan', () => {
  si(
    'crea Influencer, cuentas, CampaignInfluencer y producto, a nombre de la PERSONA que importa',
    async () => {
      const hoja = await nuevaHoja(campanaA);
      const handle = h('creada');
      const p = await plan(hoja, [fila('INF-001', 'María Creada', 'instagram', handle, 'P80')]);
      const aplicado = valor(
        await applyInfluencerImport(consultor, p.plan.id, { correlation: { conversationId: 'conv-9' } }),
      );
      const [r] = aplicado.records;
      expect(r).toMatchObject({
        status: 'applied',
        created: { influencer: true, accounts: 1, participation: true, products: 1 },
      });
      expect(aplicado.planStatus).toBe('applied');

      const persona = valor(await obtenerInfluencer(admin, r!.influencerId!));
      expect(persona.influencer.displayName).toBe('María Creada');
      expect(persona.accounts.map((a) => [a.platform, a.normalizedHandle])).toEqual([['instagram', handle]]);
      // El dueño de la creación es la persona, no el worker.
      expect(persona.influencer.createdBy).toBe(consultor.id);
      const participacion = (await participantes(campanaA.id)).find(
        (x) => x.campaignInfluencer.id === r!.campaignInfluencerId,
      )!;
      expect(participacion.campaignInfluencer.createdBy).toBe(consultor.id);
      expect(participacion.products.map((x) => x.model)).toEqual(['P80']);

      // Auditoría de los casos de uso de la Fase 3, con origen y correlación.
      const eventos = await auditoria(r!.influencerId!);
      expect(eventos.find((e) => e.action === 'influencer.create')).toMatchObject({
        origin: 'ui',
        actor_id: consultor.id,
      });
      const [conCorrelacion] = await query<{ correlation: Record<string, string> | null }>(
        `SELECT correlation FROM audit_events WHERE entity_id = $1 AND action = 'influencer.create'`,
        [r!.influencerId],
      );
      expect(conCorrelacion!.correlation).toMatchObject({ conversationId: 'conv-9' });
      expect((await auditoria(r!.recordId)).map((e) => e.action)).toContain('influencer_import.record_apply');
      expect((await auditoria(p.plan.id)).map((e) => e.action)).toContain('influencer_import.apply');
    },
  );

  si('aplicar dos veces NO duplica nada y el binding queda estable', async () => {
    const hoja = await nuevaHoja(campanaA);
    const p = await plan(hoja, [fila('INF-001', 'Idem Potente', 'instagram', h('idem'), 'P80')]);
    const primera = valor(await applyInfluencerImport(admin, p.plan.id));
    const antes = {
      influencers: await contar('influencers', 'organization_id = $1', [admin.organizationId]),
      cuentas: await contar('influencer_accounts', 'organization_id = $1', [admin.organizationId]),
      participaciones: await contar('campaign_influencers', 'campaign_id = $1', [campanaA.id]),
      productos: await contar('campaign_influencer_products', 'campaign_id = $1', [campanaA.id]),
      bindings: await contar('influencer_source_bindings', 'source_id = $1', [hoja.sourceId]),
    };
    const segunda = valor(await applyInfluencerImport(admin, p.plan.id));
    expect(segunda.records[0]!.status).toBe('unchanged');
    expect(segunda.records[0]!.influencerId).toBe(primera.records[0]!.influencerId);
    expect({
      influencers: await contar('influencers', 'organization_id = $1', [admin.organizationId]),
      cuentas: await contar('influencer_accounts', 'organization_id = $1', [admin.organizationId]),
      participaciones: await contar('campaign_influencers', 'campaign_id = $1', [campanaA.id]),
      productos: await contar('campaign_influencer_products', 'campaign_id = $1', [campanaA.id]),
      bindings: await contar('influencer_source_bindings', 'source_id = $1', [hoja.sourceId]),
    }).toEqual(antes);
  });

  si('dos aplicaciones SIMULTÁNEAS del mismo plan no duplican', async () => {
    const hoja = await nuevaHoja(campanaA);
    const p = await plan(hoja, [
      fila('INF-001', 'Carrera Uno', 'instagram', h('carrera1'), 'P80'),
      fila('INF-002', 'Carrera Dos', 'tiktok', h('carrera2')),
    ]);
    const [a, b] = await Promise.all([
      applyInfluencerImport(admin, p.plan.id),
      applyInfluencerImport(director, p.plan.id),
    ]);
    expect(a.ok && b.ok).toBe(true);
    expect((await influencersConHandle('carrera')).length).toBe(2);
    expect(await contar('influencer_source_bindings', 'source_id = $1', [hoja.sourceId])).toBe(2);
    expect(
      await contar(
        'campaign_influencers',
        'campaign_id = $1 AND influencer_id IN (SELECT influencer_id FROM influencer_source_bindings WHERE source_id = $2)',
        [campanaA.id, hoja.sourceId],
      ),
    ).toBe(2);
  });

  si('una persona con varias cuentas ocupa varias filas y es UN Influencer', async () => {
    const hoja = await nuevaHoja(campanaA);
    const p = await plan(hoja, [
      fila('INF-001', 'Multi Cuenta', 'instagram', h('multi_ig'), 'P80'),
      fila('INF-001', 'Multi Cuenta', 'tiktok', h('multi_tt'), 'P80 Pro'),
    ]);
    expect(p.records).toHaveLength(1);
    expect(p.records[0]!.locators).toHaveLength(2);
    const r = valor(await applyInfluencerImport(admin, p.plan.id)).records[0]!;
    const persona = valor(await obtenerInfluencer(admin, r.influencerId!));
    expect(persona.accounts.map((a) => a.platform).sort()).toEqual(['instagram', 'tiktok']);
    const mia = (await participantes(campanaA.id)).find(
      (x) => x.campaignInfluencer.id === r.campaignInfluencerId,
    )!;
    expect(mia.products.map((x) => x.model).sort()).toEqual(['P80', 'P80 Pro']);
  });

  si('el nombre NUNCA fusiona: dos personas con el mismo nombre son dos Influencers', async () => {
    const hoja = await nuevaHoja(campanaA);
    const p = await plan(hoja, [
      fila('INF-001', 'María García', 'instagram', h('mg_uno')),
      fila('INF-002', 'María García', 'instagram', h('mg_dos')),
    ]);
    const r = valor(await applyInfluencerImport(admin, p.plan.id)).records;
    expect(new Set(r.map((x) => x.influencerId)).size).toBe(2);
    // Un influencer EXISTENTE con ese mismo nombre pero otras cuentas tampoco se usa.
    const previo = await crearPersona('Laura Homónima', [{ platform: 'instagram', handle: h('laura_real') }]);
    const hoja2 = await nuevaHoja(campanaA);
    const p2 = await plan(hoja2, [fila('INF-001', 'Laura Homónima', 'instagram', h('laura_otra'))]);
    expect(p2.records[0]!.identity.outcome).toBe('create_new');
    const r2 = valor(await applyInfluencerImport(admin, p2.plan.id)).records[0]!;
    expect(r2.influencerId).not.toBe(previo);
  });

  si(
    'coincidencia exacta de cuenta: reutiliza al Influencer existente (también de otra campaña)',
    async () => {
      const handle = h('existente');
      const previo = await crearPersona('Existente Previo', [
        { platform: 'instagram', handle: `@${handle.toUpperCase()}` },
      ]);
      const hojaB = await nuevaHoja(campanaB);
      const pB = await plan(hojaB, [fila('INF-001', 'Existente Previo', 'instagram', handle, 'C7L')]);
      valor(await applyInfluencerImport(admin, pB.plan.id));

      // La MISMA persona en otra campaña: se reutiliza y recibe participación nueva.
      const hoja = await nuevaHoja(campanaA);
      const p = await plan(hoja, [fila('INF-009', 'Existente (otro nombre)', 'instagram', handle, 'P80')]);
      expect(p.records[0]).toMatchObject({
        identity: { outcome: 'matched_existing', influencerId: previo },
        participation: 'associate',
        state: 'actionable',
      });
      const antes = await contar('influencers', 'organization_id = $1', [admin.organizationId]);
      const r = valor(await applyInfluencerImport(admin, p.plan.id)).records[0]!;
      expect(r).toMatchObject({
        influencerId: previo,
        status: 'applied',
        created: { influencer: false, participation: true, products: 1 },
      });
      expect(await contar('influencers', 'organization_id = $1', [admin.organizationId])).toBe(antes);
      // El nombre global NO se pisa por lo que diga el Sheet de una campaña.
      expect(valor(await obtenerInfluencer(admin, previo)).influencer.displayName).toBe('Existente Previo');
      const [binding] = await query<{ bound_via: string }>(
        `SELECT bound_via FROM influencer_source_bindings WHERE source_id = $1`,
        [hoja.sourceId],
      );
      expect(binding!.bound_via).toBe('account_match');
    },
  );

  si('cuentas de un mismo registro que son de personas distintas → AMBIGUO: no muta', async () => {
    const a = await crearPersona('Persona A', [{ platform: 'instagram', handle: h('amb_a') }]);
    const b = await crearPersona('Persona B', [{ platform: 'tiktok', handle: h('amb_b') }]);
    const hoja = await nuevaHoja(campanaA);
    const p = await plan(hoja, [
      fila('INF-001', 'Persona Mixta', 'instagram', h('amb_a')),
      fila('INF-001', 'Persona Mixta', 'tiktok', h('amb_b')),
    ]);
    const r = registroDe(p, 'INF-001');
    expect(r).toMatchObject({ state: 'blocked', identity: { outcome: 'ambiguous' } });
    expect([...r.identity.candidates].sort()).toEqual([a, b].sort());
    expect(p.plan.status).toBe('needs_resolution');
    const antes = await contar('campaign_influencers', 'campaign_id = $1', [campanaA.id]);
    const aplicado = valor(await applyInfluencerImport(admin, p.plan.id));
    expect(aplicado.records[0]).toMatchObject({ status: 'blocked', reason: 'identity_ambiguous' });
    expect(await contar('campaign_influencers', 'campaign_id = $1', [campanaA.id])).toBe(antes);
    expect(await contar('influencer_source_bindings', 'source_id = $1', [hoja.sourceId])).toBe(0);
  });

  si('la misma cuenta bajo dos claves del Sheet invalida ambos registros (no se adivina)', async () => {
    const hoja = await nuevaHoja(campanaA);
    const p = await plan(hoja, [
      fila('INF-001', 'Uno', 'instagram', h('dup_key')),
      fila('INF-002', 'Dos', 'instagram', h('dup_key')),
    ]);
    expect(p.records.map((r) => r.state)).toEqual(['invalid', 'invalid']);
    valor(await applyInfluencerImport(admin, p.plan.id));
    expect((await influencersConHandle('dup_key')).length).toBe(0);
  });

  si('una participación RETIRADA no se reactiva sola', async () => {
    const handle = h('retirada');
    const persona = await crearPersona('Retirada', [{ platform: 'instagram', handle }]);
    const hoja0 = await nuevaHoja(campanaA);
    const p0 = await plan(hoja0, [fila('INF-001', 'Retirada', 'instagram', handle)]);
    const r0 = valor(await applyInfluencerImport(admin, p0.plan.id)).records[0]!;
    valor(await retirarInfluencerDeCampana(admin, r0.campaignInfluencerId!));

    const hoja = await nuevaHoja(campanaA);
    const p = await plan(hoja, [fila('INF-005', 'Retirada', 'instagram', handle)]);
    expect(p.records[0]).toMatchObject({ participation: 'retired', state: 'blocked' });
    const r = valor(await applyInfluencerImport(admin, p.plan.id)).records[0]!;
    expect(r).toMatchObject({ status: 'blocked', reason: 'participation_retired' });
    const mia = valor(await listarInfluencersDeCampana(admin, campanaA.id, { incluirRetirados: true })).find(
      (x) => x.campaignInfluencer.influencerId === persona,
    )!;
    expect(mia.campaignInfluencer.status).toBe('retirado');
    // Reactivarla es explícito (caso de uso de la Fase 3); entonces el plan avanza.
    valor(await reactivarInfluencerEnCampana(admin, mia.campaignInfluencer.id));
    expect(valor(await applyInfluencerImport(admin, p.plan.id)).records[0]!.status).toBe('applied');
  });
});

// ─────────────────────────── Productos ─────────────────────────────────────────

describe('productos', () => {
  si('un producto sin resolver NO bloquea la persona; una decisión humana lo asigna', async () => {
    const hoja = await nuevaHoja(campanaA);
    const p = await plan(hoja, [fila('INF-001', 'Sin Producto', 'instagram', h('sinprod'), 'X999')]);
    expect(registroDe(p, 'INF-001').productOutcomes[0]).toMatchObject({ outcome: 'unresolved' });
    expect(p.plan.status).toBe('needs_resolution');
    const r = valor(await applyInfluencerImport(admin, p.plan.id)).records[0]!;
    expect(r).toMatchObject({ status: 'applied', created: { influencer: true, products: 0 } });
    expect(r.pending).toEqual(['product_unresolved:x999']);
    expect(registroDe(valor(await getImportPlan(admin, p.plan.id)), 'INF-001').state).toBe('blocked');

    const resuelto = valor(
      await resolveImportRecord(admin, r.recordId, {
        kind: 'choose_product',
        productRef: 'X999',
        campaignProductId: campanaA.cp['P80 Pro']!,
        reason: 'Es el P80 Pro',
      }),
    );
    expect(resuelto.result).toMatchObject({ created: { products: 1 } });
    expect(resuelto.planStatus).toBe('applied');
    const mia = (await participantes(campanaA.id)).find(
      (x) => x.campaignInfluencer.id === r.campaignInfluencerId,
    )!;
    expect(mia.products.map((x) => x.model)).toEqual(['P80 Pro']);
  });

  si('un producto ambiguo (mismo modelo, dos marcas) exige elegir', async () => {
    const hoja = await nuevaHoja(campanaA);
    const p = await plan(hoja, [fila('INF-001', 'Ambiguo', 'instagram', h('prodamb'), 'Soundbar S64')]);
    expect(registroDe(p, 'INF-001').productOutcomes[0]).toMatchObject({ outcome: 'ambiguous' });
    const r = valor(await applyInfluencerImport(admin, p.plan.id)).records[0]!;
    expect(r.pending[0]).toContain('product_ambiguous');
    valor(
      await resolveImportRecord(admin, r.recordId, {
        kind: 'choose_product',
        productRef: 'Soundbar S64',
        campaignProductId: productoDuplicado,
      }),
    );
    const mia = (await participantes(campanaA.id)).find(
      (x) => x.campaignInfluencer.id === r.campaignInfluencerId,
    )!;
    expect(mia.products).toHaveLength(1);
  });

  si('un producto de OTRA campaña es inválido (API y base)', async () => {
    const hoja = await nuevaHoja(campanaA);
    const p = await plan(hoja, [fila('INF-001', 'Cruce', 'instagram', h('cruce'), 'C7L')]);
    // C7L solo existe en la campaña B: para A está sin resolver.
    expect(registroDe(p, 'INF-001').productOutcomes[0]).toMatchObject({ outcome: 'unresolved' });
    const r = valor(await applyInfluencerImport(admin, p.plan.id)).records[0]!;
    const deB: ImportDecision = {
      kind: 'choose_product',
      productRef: 'C7L',
      campaignProductId: campanaB.cp['C7L']!,
    };
    expect(codigo(await resolveImportRecord(admin, r.recordId, deB))).toBe('RESOURCE_NOT_FOUND');
    await expect(
      query(
        `INSERT INTO influencer_import_resolutions (organization_id, campaign_id, record_id, dimension, decision,
                                                    campaign_product_id, product_ref, decided_by)
         VALUES ($1, $2, $3, 'product', 'choose_product', $4, 'c7l', $5)`,
        [admin.organizationId, campanaA.id, r.recordId, campanaB.cp['C7L'], admin.id],
      ),
    ).rejects.toThrow(/influencer_import_resolutions_product_fkey/);
    // La referencia debe ser una del registro.
    const otra: ImportDecision = {
      kind: 'choose_product',
      productRef: 'P80',
      campaignProductId: campanaA.cp['P80']!,
    };
    expect(codigo(await resolveImportRecord(admin, r.recordId, otra))).toBe('VALIDATION_FAILED');
  });

  si('un producto ya asignado no se duplica', async () => {
    const hoja = await nuevaHoja(campanaA);
    const p = await plan(hoja, [fila('INF-001', 'Ya Tenía', 'instagram', h('yatenia'), 'P80')]);
    const r = valor(await applyInfluencerImport(admin, p.plan.id)).records[0]!;
    await sincronizar(hoja, [
      fila('INF-001', 'Ya Tenía', 'instagram', h('yatenia'), 'P80'),
      fila('INF-002', 'Otra', 'tiktok', h('otrapers')),
    ]);
    const p2 = valor(await planear(hoja));
    expect(registroDe(p2, 'INF-001')).toMatchObject({
      change: 'unchanged',
      identity: { outcome: 'matched_binding' },
    });
    valor(await applyInfluencerImport(admin, p2.plan.id));
    expect(
      await contar('campaign_influencer_products', 'campaign_influencer_id = $1', [r.campaignInfluencerId]),
    ).toBe(1);
  });

  si('cambiar de producto NO reemplaza: queda como cambio material para una persona', async () => {
    const hoja = await nuevaHoja(campanaA);
    const p1 = await plan(hoja, [fila('INF-001', 'Cambia Producto', 'instagram', h('cambia'), 'P80')]);
    const r1 = valor(await applyInfluencerImport(admin, p1.plan.id)).records[0]!;

    // Snapshot 2: P80 → P80 Pro.
    await sincronizar(hoja, [fila('INF-001', 'Cambia Producto', 'instagram', h('cambia'), 'P80 Pro')]);
    const p2 = valor(await planear(hoja));
    const reg = registroDe(p2, 'INF-001');
    expect(reg).toMatchObject({ change: 'changed', state: 'blocked' });
    expect(reg.changedFields).toEqual(['products']);
    expect(reg.productOutcomes[0]).toMatchObject({ outcome: 'product_change' });
    const r2 = valor(await applyInfluencerImport(admin, p2.plan.id)).records[0]!;
    expect(r2.pending[0]).toContain('product_product_change');
    const mia = async () =>
      (await participantes(campanaA.id))
        .find((x) => x.campaignInfluencer.id === r1.campaignInfluencerId)!
        .products.map((x) => x.model);
    expect(await mia()).toEqual(['P80']); // P80 sigue asignado: nada se quitó ni se reemplazó
    // Una persona decide AÑADIR el nuevo (el sistema nunca desasigna).
    valor(
      await resolveImportRecord(admin, r2.recordId, {
        kind: 'choose_product',
        productRef: 'P80 Pro',
        campaignProductId: campanaA.cp['P80 Pro']!,
      }),
    );
    expect((await mia()).sort()).toEqual(['P80', 'P80 Pro']);
  });
});

// ─────────────────────────── Resolución humana ─────────────────────────────────

describe('resolución humana', () => {
  si('elegir un Influencer EXISTENTE evita crear un duplicado y fija el binding', async () => {
    const x = await crearPersona('Persona Existente', [{ platform: 'instagram', handle: h('res_ig_vieja') }]);
    const hoja = await nuevaHoja(campanaA);
    // El Sheet trae un handle nuevo de la misma persona: por cuenta sería «nuevo».
    const p = await plan(hoja, [fila('INF-001', 'Persona Existente', 'tiktok', h('res_tt_nueva'))]);
    expect(registroDe(p, 'INF-001').identity.outcome).toBe('create_new');
    const antes = await contar('influencers', 'organization_id = $1', [admin.organizationId]);
    const registro = registroDe(p, 'INF-001');

    const r = valor(
      await resolveImportRecord(consultor, registro.id, {
        kind: 'use_existing_influencer',
        influencerId: x,
        reason: 'Es la misma persona',
      }),
    );
    expect(r.result).toMatchObject({
      status: 'applied',
      influencerId: x,
      created: { influencer: false, accounts: 1, participation: true },
    });
    expect(await contar('influencers', 'organization_id = $1', [admin.organizationId])).toBe(antes);
    expect(
      valor(await obtenerInfluencer(admin, x))
        .accounts.map((a) => a.platform)
        .sort(),
    ).toEqual(['instagram', 'tiktok']);
    const [binding] = await query<{ bound_via: string; influencer_id: string; bound_by: string }>(
      `SELECT bound_via, influencer_id, bound_by FROM influencer_source_bindings WHERE source_id = $1`,
      [hoja.sourceId],
    );
    expect(binding).toMatchObject({ bound_via: 'human_existing', influencer_id: x, bound_by: consultor.id });
    // Auditada: quién, qué y por qué.
    const evento = (await auditoria(registro.id)).find(
      (e) => e.action === 'influencer_import.record_resolve',
    )!;
    expect(evento).toMatchObject({ origin: 'ui', actor_id: consultor.id });
    expect(evento.metadata).toMatchObject({
      decision: 'use_existing_influencer',
      influencerId: x,
      reason: 'Es la misma persona',
    });

    // La siguiente sincronización USA el binding: aunque el nombre y la cuenta cambien, no se crea otra persona.
    await sincronizar(hoja, [fila('INF-001', 'Nombre Distinto', 'tiktok', h('res_tt_nueva'))]);
    const p2 = valor(await planear(hoja));
    expect(registroDe(p2, 'INF-001')).toMatchObject({
      identity: { outcome: 'matched_binding', influencerId: x },
    });
    expect(registroDe(p2, 'INF-001').identity.nameDiffers).toEqual({
      sheet: 'Nombre Distinto',
      existing: 'Persona Existente',
    });
    valor(await applyInfluencerImport(admin, p2.plan.id));
    expect(valor(await obtenerInfluencer(admin, x)).influencer.displayName).toBe('Persona Existente');
  });

  si('no se puede elegir una persona si una cuenta del registro es de OTRA', async () => {
    const a = await crearPersona('Dueña A', [{ platform: 'instagram', handle: h('own_a') }]);
    await crearPersona('Dueña B', [{ platform: 'tiktok', handle: h('own_b') }]);
    const hoja = await nuevaHoja(campanaA);
    const p = await plan(hoja, [
      fila('INF-001', 'Mixta', 'instagram', h('own_a')),
      fila('INF-001', 'Mixta', 'tiktok', h('own_b')),
    ]);
    const registro = registroDe(p, 'INF-001');
    const r = await resolveImportRecord(admin, registro.id, {
      kind: 'use_existing_influencer',
      influencerId: a,
    });
    expect(codigo(r)).toBe('RESOURCE_CONFLICT');
    expect(detalle(r)).toMatchObject({ reason: 'account_owned_by_other' });
    // Tampoco puede «crear nuevo»: las cuentas ya existen.
    expect(codigo(await resolveImportRecord(admin, registro.id, { kind: 'create_new_influencer' }))).toBe(
      'RESOURCE_CONFLICT',
    );
    expect(await contar('influencer_import_resolutions', 'record_id = $1', [registro.id])).toBe(0);
    expect(await contar('influencer_source_bindings', 'source_id = $1', [hoja.sourceId])).toBe(0);
  });

  si('crear uno nuevo y vincularlo (create_new_influencer) deja binding human_new', async () => {
    const hoja = await nuevaHoja(campanaA);
    const p = await plan(hoja, [fila('INF-001', 'Nueva Por Decisión', 'instagram', h('decidida'))]);
    const registro = registroDe(p, 'INF-001');
    const r = valor(await resolveImportRecord(admin, registro.id, { kind: 'create_new_influencer' }));
    expect(r.result).toMatchObject({ status: 'applied', created: { influencer: true } });
    const [binding] = await query<{ bound_via: string }>(
      `SELECT bound_via FROM influencer_source_bindings WHERE source_id = $1`,
      [hoja.sourceId],
    );
    expect(binding!.bound_via).toBe('human_new');
  });

  si('ignorar un registro lo deja fuera sin mutar, y el plan puede cerrarse', async () => {
    await crearPersona('Ignorada A', [{ platform: 'instagram', handle: h('ign_a') }]);
    await crearPersona('Ignorada B', [{ platform: 'tiktok', handle: h('ign_b') }]);
    const hoja = await nuevaHoja(campanaA);
    const p = await plan(hoja, [
      fila('INF-001', 'Mixta', 'instagram', h('ign_a')),
      fila('INF-001', 'Mixta', 'tiktok', h('ign_b')),
      fila('INF-002', 'Normal', 'youtube', h('ign_normal')),
    ]);
    const antes = await contar('campaign_influencers', 'campaign_id = $1', [campanaA.id]);
    valor(await applyInfluencerImport(admin, p.plan.id));
    expect(valor(await getImportPlan(admin, p.plan.id)).plan.status).toBe('needs_resolution');
    const ambiguo = registroDe(p, 'INF-001');
    const r = valor(
      await resolveImportRecord(admin, ambiguo.id, {
        kind: 'ignore_record',
        reason: 'No es de esta campaña',
      }),
    );
    expect(r.planStatus).toBe('applied');
    expect(registroDe(valor(await getImportPlan(admin, p.plan.id)), 'INF-001').state).toBe('ignored');
    expect(await contar('campaign_influencers', 'campaign_id = $1', [campanaA.id])).toBe(antes + 1); // solo INF-002
    expect(
      await contar('influencer_source_bindings', 'source_id = $1 AND source_key = $2', [
        hoja.sourceId,
        'INF-001',
      ]),
    ).toBe(0);
  });

  si('el sistema, el Operativo y el cliente NO resuelven', async () => {
    const hoja = await nuevaHoja(campanaA);
    const p = await plan(hoja, [fila('INF-001', 'Para Resolver', 'instagram', h('para_res'))]);
    const registro = registroDe(p, 'INF-001');
    const decision: ImportDecision = { kind: 'create_new_influencer' };
    expect(codigo(await resolveImportRecord('system' as unknown as User, registro.id, decision))).toBe(
      'FORBIDDEN_ROLE',
    );
    expect(codigo(await resolveImportRecord(operativo, registro.id, decision))).toBe('FORBIDDEN_ROLE');
    expect(codigo(await resolveImportRecord(cliente, registro.id, decision))).toBe('RESOURCE_NOT_FOUND');
    expect(codigo(await resolveImportRecord(ajeno, registro.id, decision))).toBe('RESOURCE_NOT_FOUND');
    expect(await contar('influencer_import_resolutions', 'record_id = $1', [registro.id])).toBe(0);
    // Ni siquiera el canal «chat» convierte al sistema en una persona.
    expect(codigo(await resolveImportRecord('system' as unknown as User, registro.id, decision))).toBe(
      'FORBIDDEN_ROLE',
    );
  });
});

// ─────────────────────────── Sincronizaciones posteriores ──────────────────────

describe('sincronizaciones posteriores', () => {
  si('una persona que desaparece del Sheet se marca para revisión; NADA se retira solo', async () => {
    const hoja = await nuevaHoja(campanaA);
    const p1 = await plan(hoja, [
      fila('INF-001', 'Se Queda', 'instagram', h('queda'), 'P80'),
      fila('INF-002', 'Desaparece', 'tiktok', h('desaparece'), 'P80'),
    ]);
    const r1 = valor(await applyInfluencerImport(admin, p1.plan.id)).records;
    const ciDesaparece = r1.find((r) => r.sourceKey === 'INF-002')!.campaignInfluencerId!;

    await sincronizar(hoja, [fila('INF-001', 'Se Queda', 'instagram', h('queda'), 'P80')]);
    const p2 = valor(await planear(hoja));
    expect(registroDe(p2, 'INF-002')).toMatchObject({
      kind: 'missing_from_source',
      change: 'missing_from_source',
      state: 'review',
      identity: { outcome: 'missing_from_source', campaignInfluencerId: ciDesaparece },
    });
    expect(registroDe(p2, 'INF-001').change).toBe('unchanged');
    expect(p2.plan.status).toBe('needs_resolution');
    valor(await applyInfluencerImport(admin, p2.plan.id));

    const sigue = (await participantes(campanaA.id)).find((x) => x.campaignInfluencer.id === ciDesaparece)!;
    expect(sigue.campaignInfluencer.status).toBe('activo');
    expect(sigue.products.map((x) => x.model)).toEqual(['P80']);
    // Un humano lo revisa (y retirar sería una acción explícita aparte).
    const r = valor(
      await resolveImportRecord(admin, registroDe(p2, 'INF-002').id, {
        kind: 'ignore_record',
        reason: 'Se revisó',
      }),
    );
    expect(r.planStatus).toBe('applied');
    expect(
      (await participantes(campanaA.id)).find((x) => x.campaignInfluencer.id === ciDesaparece)!
        .campaignInfluencer.status,
    ).toBe('activo');
    // El plan anterior quedó reemplazado.
    expect(valor(await getImportPlan(admin, p1.plan.id)).plan.status).toBe('applied');
  });

  si('una ausencia sostenida sigue señalada hasta que una persona la revisa', async () => {
    const hoja = await nuevaHoja(campanaA);
    const ambos = [
      fila('INF-001', 'Presente', 'instagram', h('aus_a')),
      fila('INF-002', 'Ausente', 'tiktok', h('aus_b')),
    ];
    valor(await applyInfluencerImport(admin, (await plan(hoja, ambos)).plan.id));

    await sincronizar(hoja, [ambos[0]!]);
    const p2 = valor(await planear(hoja));
    expect(registroDe(p2, 'INF-002').state).toBe('review');
    // Otro cambio del Sheet sin que nadie haya revisado: la ausencia SIGUE señalada.
    await sincronizar(hoja, [fila('INF-001', 'Presente Renombrada', 'instagram', h('aus_a'))]);
    const p3 = valor(await planear(hoja));
    expect(registroDe(p3, 'INF-002').state).toBe('review');
    valor(await resolveImportRecord(admin, registroDe(p3, 'INF-002').id, { kind: 'ignore_record' }));

    // Revisada: no se vuelve a señalar mientras siga ausente…
    await sincronizar(hoja, [fila('INF-001', 'Presente Otra Vez', 'instagram', h('aus_a'))]);
    expect(valor(await planear(hoja)).records.map((r) => r.sourceKey)).toEqual(['INF-001']);
    // …pero si reaparece y vuelve a desaparecer, se señala de nuevo.
    await sincronizar(hoja, ambos);
    const p5 = valor(await planear(hoja));
    expect(registroDe(p5, 'INF-002')).toMatchObject({
      identity: { outcome: 'matched_binding' },
      state: 'applied',
    });
    await sincronizar(hoja, [ambos[0]!]);
    expect(registroDe(valor(await planear(hoja)), 'INF-002').state).toBe('review');
  });

  si('un producto que desaparece del Sheet NO se desasigna', async () => {
    const hoja = await nuevaHoja(campanaA);
    const p1 = await plan(hoja, [fila('INF-001', 'Sin Producto Ahora', 'instagram', h('sinprod2'), 'P80')]);
    const r1 = valor(await applyInfluencerImport(admin, p1.plan.id)).records[0]!;
    await sincronizar(hoja, [fila('INF-001', 'Sin Producto Ahora', 'instagram', h('sinprod2'), '')]);
    const p2 = valor(await planear(hoja));
    expect(registroDe(p2, 'INF-001')).toMatchObject({ change: 'changed', changedFields: ['products'] });
    valor(await applyInfluencerImport(admin, p2.plan.id));
    expect(
      await contar('campaign_influencer_products', 'campaign_influencer_id = $1', [r1.campaignInfluencerId]),
    ).toBe(1);
  });

  si('un cambio de handle con binding NO crea otra persona: espera una decisión', async () => {
    const hoja = await nuevaHoja(campanaA);
    const p1 = await plan(hoja, [fila('INF-001', 'Cambia Handle', 'instagram', h('handle_v1'))]);
    const r1 = valor(await applyInfluencerImport(admin, p1.plan.id)).records[0]!;

    await sincronizar(hoja, [fila('INF-001', 'Cambia Handle', 'instagram', h('handle_v2'))]);
    const p2 = valor(await planear(hoja));
    const reg = registroDe(p2, 'INF-001');
    expect(reg).toMatchObject({
      change: 'changed',
      state: 'blocked',
      identity: { outcome: 'needs_resolution', influencerId: r1.influencerId },
    });
    expect(reg.identity.reasons).toEqual(['account_change']);
    expect(reg.changedFields).toEqual(['accounts']);
    const antes = await contar('influencers', 'organization_id = $1', [admin.organizationId]);
    const a = valor(await applyInfluencerImport(admin, p2.plan.id)).records[0]!;
    expect(a.pending).toContain('account_change');
    expect(await contar('influencers', 'organization_id = $1', [admin.organizationId])).toBe(antes);
    expect(
      valor(await obtenerInfluencer(admin, r1.influencerId!)).accounts.map((c) => c.normalizedHandle),
    ).toEqual([h('handle_v1')]);

    // Una persona confirma que es la misma persona: la cuenta se AÑADE (la anterior no se borra).
    const r = valor(
      await resolveImportRecord(admin, reg.id, {
        kind: 'use_existing_influencer',
        influencerId: r1.influencerId!,
      }),
    );
    expect(r.planStatus).toBe('applied');
    expect(
      valor(await obtenerInfluencer(admin, r1.influencerId!))
        .accounts.map((c) => c.normalizedHandle)
        .sort(),
    ).toEqual([h('handle_v1'), h('handle_v2')].sort());
  });

  si('si el nuevo handle ya es de OTRA persona: conflicto, no se muta', async () => {
    const hoja = await nuevaHoja(campanaA);
    const p1 = await plan(hoja, [fila('INF-001', 'Conflicto', 'instagram', h('conf_v1'))]);
    valor(await applyInfluencerImport(admin, p1.plan.id));
    const otra = await crearPersona('Otra Dueña', [{ platform: 'instagram', handle: h('conf_ajeno') }]);

    await sincronizar(hoja, [fila('INF-001', 'Conflicto', 'instagram', h('conf_ajeno'))]);
    const p2 = valor(await planear(hoja));
    expect(registroDe(p2, 'INF-001')).toMatchObject({ state: 'blocked', identity: { outcome: 'conflict' } });
    const a = valor(await applyInfluencerImport(admin, p2.plan.id)).records[0]!;
    expect(a).toMatchObject({ status: 'blocked', reason: 'identity_conflict' });
    expect(valor(await obtenerInfluencer(admin, otra)).accounts).toHaveLength(1);
  });

  si('un cambio de nombre con binding se informa y no duplica ni pisa', async () => {
    const hoja = await nuevaHoja(campanaA);
    const p1 = await plan(hoja, [fila('INF-001', 'Nombre Viejo', 'instagram', h('renombra'))]);
    const r1 = valor(await applyInfluencerImport(admin, p1.plan.id)).records[0]!;
    await sincronizar(hoja, [fila('INF-001', 'Nombre Nuevo', 'instagram', h('renombra'))]);
    const p2 = valor(await planear(hoja));
    expect(registroDe(p2, 'INF-001')).toMatchObject({
      change: 'changed',
      changedFields: ['name'],
      state: 'applied',
    });
    expect(registroDe(p2, 'INF-001').identity.nameDiffers).toEqual({
      sheet: 'Nombre Nuevo',
      existing: 'Nombre Viejo',
    });
    valor(await applyInfluencerImport(admin, p2.plan.id));
    expect(valor(await obtenerInfluencer(admin, r1.influencerId!)).influencer.displayName).toBe(
      'Nombre Viejo',
    );
    expect((await influencersConHandle('renombra')).length).toBe(1);
  });

  si('una persona nueva en el segundo snapshot se crea sin tocar a las demás', async () => {
    const hoja = await nuevaHoja(campanaA);
    const p1 = await plan(hoja, [fila('INF-001', 'Primera', 'instagram', h('primera'))]);
    valor(await applyInfluencerImport(admin, p1.plan.id));
    await sincronizar(hoja, [
      fila('INF-001', 'Primera', 'instagram', h('primera')),
      fila('INF-002', 'Segunda', 'tiktok', h('segunda')),
    ]);
    const p2 = valor(await planear(hoja));
    expect(p2.records.map((r) => [r.sourceKey, r.change])).toEqual([
      ['INF-001', 'unchanged'],
      ['INF-002', 'new'],
    ]);
    expect(p2.plan.basePlanId).toBe(p1.plan.id);
    const a = valor(await applyInfluencerImport(admin, p2.plan.id));
    expect(a.records.map((r) => r.status)).toEqual(['unchanged', 'applied']);
    expect(valor(await listImportPlans(admin, hoja.sourceId)).map((x) => x.snapshotId)).toHaveLength(2);
  });

  si('comparar dos snapshots informa nuevo / sin cambios / cambiado / desaparecido por clave', async () => {
    const hoja = await nuevaHoja(campanaA);
    const s1 = await sincronizar(hoja, [
      fila('INF-001', 'Uno', 'instagram', h('cmp1')),
      fila('INF-002', 'Dos', 'instagram', h('cmp2')),
      fila('INF-003', 'Tres', 'instagram', h('cmp3')),
    ]);
    // Se reordenan las filas y cambian cosas: la fila NO es la identidad.
    const s2 = await sincronizar(hoja, [
      fila('INF-003', 'Tres', 'instagram', h('cmp3')),
      fila('INF-001', 'Uno Cambiado', 'instagram', h('cmp1')),
      fila('INF-004', 'Cuatro', 'instagram', h('cmp4')),
    ]);
    const diffs = valor(
      await compareSheetSnapshots(admin, {
        campaignId: campanaA.id,
        sourceId: hoja.sourceId,
        fromSnapshotId: s1,
        toSnapshotId: s2,
      }),
    );
    const de = (c: string) => diffs.find((d) => d.sourceKey === c)!;
    expect(de('INF-003').change).toBe('unchanged');
    expect(de('INF-001')).toMatchObject({ change: 'changed', fields: ['name'] });
    expect(de('INF-004').change).toBe('new');
    expect(de('INF-002').change).toBe('missing_from_source');
  });
});

// ─────────────────────────── Procedencia ───────────────────────────────────────

describe('procedencia', () => {
  si('¿por qué existe este CampaignInfluencer? → binding → snapshot → hoja y rango → fuente', async () => {
    const hoja = await nuevaHoja(campanaA);
    const p = await plan(hoja, [
      fila('INF-007', 'Con Origen', 'instagram', h('origen_ig'), 'P80'),
      fila('INF-007', 'Con Origen', 'tiktok', h('origen_tt'), 'P80'),
    ]);
    const r = valor(await applyInfluencerImport(admin, p.plan.id)).records[0]!;
    const origen = valor(await getParticipationOrigin(operativo, r.campaignInfluencerId!))!;
    expect(origen).toMatchObject({
      sourceKey: 'INF-007',
      boundVia: 'created',
      source: { id: hoja.sourceId, provider: 'google_sheets' },
      snapshot: { id: p.plan.snapshotId, sequence: 1 },
      plan: { id: p.plan.id },
      record: { id: r.recordId },
      boundBy: admin.id,
    });
    expect(origen.locators.map((l) => `${l.sheet}!${l.range}`)).toEqual([
      'Influencers!A3:E3',
      'Influencers!A4:E4',
    ]);
    expect(origen.products).toHaveLength(1);
    expect(origen.products[0]).toMatchObject({ action: 'created', recordId: r.recordId });
    // El rango apunta a contenido real del snapshot.
    const [fragmento] = await query<{ text: string }>(
      `SELECT text FROM source_fragments WHERE snapshot_id = $1 AND (locator->>'rowStart')::int <= 3 AND (locator->>'rowEnd')::int >= 3`,
      [origen.snapshot.id],
    );
    expect(fragmento!.text).toContain('Con Origen');
  });

  si('el origen sigue siendo el del snapshot 1 aunque el Sheet cambie después', async () => {
    const hoja = await nuevaHoja(campanaA);
    const p1 = await plan(hoja, [fila('INF-001', 'Origen Estable', 'instagram', h('estable'))]);
    const r = valor(await applyInfluencerImport(admin, p1.plan.id)).records[0]!;
    await sincronizar(hoja, [
      fila('INF-001', 'Origen Estable', 'instagram', h('estable')),
      fila('INF-002', 'Otra', 'tiktok', h('otra_estable')),
    ]);
    valor(await applyInfluencerImport(admin, valor(await planear(hoja)).plan.id));
    const origen = valor(await getParticipationOrigin(admin, r.campaignInfluencerId!))!;
    expect(origen.snapshot).toMatchObject({ id: p1.plan.snapshotId, sequence: 1 });
    expect(origen.plan.id).toBe(p1.plan.id);
  });
});

// ─────────────────────────── Campaña cerrada ───────────────────────────────────

describe('campañas archivadas o canceladas', () => {
  for (const estado of ['archivada', 'cancelada'] as const) {
    si(`${estado}: se puede leer y planear; NO se materializa ni se resuelve`, async () => {
      const campana = await crearCampana(admin, `Cerrada ${estado}`, ['P80']);
      const hoja = await nuevaHoja(campana);
      const p1 = await plan(hoja, [
        fila('INF-001', 'Antes de Cerrar', 'instagram', h(`cerrada_${estado}_1`)),
      ]);
      valor(await applyInfluencerImport(admin, p1.plan.id));
      await sincronizar(hoja, [
        fila('INF-001', 'Antes de Cerrar', 'instagram', h(`cerrada_${estado}_1`)),
        fila('INF-002', 'Despues de Cerrar', 'tiktok', h(`cerrada_${estado}_2`), 'P80'),
      ]);
      await query(`UPDATE campaigns SET status = $2::campaign_status WHERE id = $1`, [campana.id, estado]);

      // Leer, comparar y planear siguen funcionando; el snapshot se conserva.
      const p2 = valor(await planear(hoja));
      expect(registroDe(p2, 'INF-002').change).toBe('new');
      expect(valor(await getImportPlan(admin, p2.plan.id)).records).toHaveLength(2);
      const antes = {
        influencers: await contar('influencers', 'organization_id = $1', [admin.organizationId]),
        participaciones: await contar('campaign_influencers', 'campaign_id = $1', [campana.id]),
        productos: await contar('campaign_influencer_products', 'campaign_id = $1', [campana.id]),
      };
      const aplicar = await applyInfluencerImport(admin, p2.plan.id);
      expect(codigo(aplicar)).toBe('RESOURCE_CONFLICT');
      expect(detalle(aplicar)).toMatchObject({ reason: 'campaign_not_active', campaignStatus: estado });
      const resolver = await resolveImportRecord(admin, registroDe(p2, 'INF-002').id, {
        kind: 'create_new_influencer',
      });
      expect(detalle(resolver)).toMatchObject({ reason: 'campaign_not_active' });
      expect({
        influencers: await contar('influencers', 'organization_id = $1', [admin.organizationId]),
        participaciones: await contar('campaign_influencers', 'campaign_id = $1', [campana.id]),
        productos: await contar('campaign_influencer_products', 'campaign_id = $1', [campana.id]),
      }).toEqual(antes);
      // Sincronizar (leer) tampoco se bloquea.
      expect(valor(await syncGoogleSheetSource(admin, hoja.sourceId)).status).toBe('queued');
    });
  }
});

// ─────────────────────────── Permisos y aislamiento ────────────────────────────

describe('permisos y aislamiento', () => {
  si('quién puede qué', async () => {
    const hoja = await nuevaHoja(campanaA);
    const p = await plan(hoja, [fila('INF-001', 'Permisos', 'instagram', h('permisos'))]);
    // Operativo: lee el plan, no lo prepara ni lo aplica.
    expect(valor(await getImportPlan(operativo, p.plan.id)).records).toHaveLength(1);
    expect(valor(await listImportPlans(operativo, hoja.sourceId))).toHaveLength(1);
    expect(codigo(await planear(hoja, operativo))).toBe('FORBIDDEN_ROLE');
    expect(codigo(await applyInfluencerImport(operativo, p.plan.id))).toBe('FORBIDDEN_ROLE');
    // Cliente: nada (ni la campaña visible le abre el plan).
    expect(codigo(await getImportPlan(cliente, p.plan.id))).toBe('RESOURCE_NOT_FOUND');
    expect(codigo(await planear(hoja, cliente))).toBe('RESOURCE_NOT_FOUND');
    expect(codigo(await applyInfluencerImport(cliente, p.plan.id))).toBe('RESOURCE_NOT_FOUND');
    // Otra agencia: no existe.
    expect(codigo(await getImportPlan(ajeno, p.plan.id))).toBe('RESOURCE_NOT_FOUND');
    expect(codigo(await planear(hoja, ajeno))).toBe('RESOURCE_NOT_FOUND');
    expect(codigo(await applyInfluencerImport(ajeno, p.plan.id))).toBe('RESOURCE_NOT_FOUND');
    // Sistema: nunca importa.
    const sistema = 'system' as unknown as User;
    expect(codigo(await applyInfluencerImport(sistema, p.plan.id))).toBe('FORBIDDEN_ROLE');
    expect(codigo(await planear(hoja, sistema))).toBe('FORBIDDEN_ROLE');
    // Director y consultor sí.
    expect(valor(await applyInfluencerImport(director, p.plan.id)).records[0]!.status).toBe('applied');
    expect(
      await contar('influencers', 'created_by = $1 AND display_name = $2', [director.id, 'Permisos']),
    ).toBe(1);
  });

  si('un Sheet de la organización A no puede crear ni asociar en la organización B', async () => {
    // La fuente ajena vive en la campaña ajena; el admin de SmartPR no la ve.
    const hojaAjena = await nuevaHoja(campanaAjena, ajeno);
    expect(
      codigo(
        await prepareInfluencerImport(admin, { campaignId: campanaAjena.id, sourceId: hojaAjena.sourceId }),
      ),
    ).toBe('RESOURCE_NOT_FOUND');
    // Una fuente de SmartPR no puede usarse contra una campaña de otra organización.
    const hoja = await nuevaHoja(campanaA);
    await sincronizar(hoja, [fila('INF-001', 'Cruce', 'instagram', h('cruce_org'))]);
    expect(
      codigo(await prepareInfluencerImport(ajeno, { campaignId: campanaAjena.id, sourceId: hoja.sourceId })),
    ).toBe('RESOURCE_NOT_FOUND');
    // Y la base lo impide aunque se salte la API: un plan no mezcla organización/campaña/fuente.
    valor(await planear(hoja));
    const snapshot = await sincronizar(hoja, [
      fila('INF-001', 'Cruce', 'instagram', h('cruce_org')),
      fila('INF-002', 'Otra', 'tiktok', h('cruce_org2')),
    ]);
    await expect(
      query(
        `INSERT INTO influencer_import_plans (organization_id, campaign_id, source_id, snapshot_id, schema_id, status, validation, summary, created_by)
         VALUES ($1, $2, $3, $4, 'x', 'ready', '{}'::jsonb, '{}'::jsonb, $5)`,
        [ajeno.organizationId, campanaAjena.id, hoja.sourceId, snapshot, ajeno.id],
      ),
    ).rejects.toThrow(/influencer_import_plans_(source_org|source_campaign)_fkey/);
  });

  si(
    'la base protege el histórico: planes, registros, decisiones, bindings y efectos no se reescriben',
    async () => {
      const hoja = await nuevaHoja(campanaA);
      const p = await plan(hoja, [fila('INF-001', 'Histórico', 'instagram', h('historico'), 'P80')]);
      const r = valor(await applyInfluencerImport(admin, p.plan.id)).records[0]!;
      await expect(
        query(`UPDATE influencer_import_plans SET summary = '{}'::jsonb WHERE id = $1`, [p.plan.id]),
      ).rejects.toThrow(/solo cambia de estado/);
      await expect(
        query(`UPDATE influencer_import_plans SET snapshot_id = snapshot_id WHERE id = $1`, [p.plan.id]),
      ).resolves.toBeDefined();
      await expect(query(`DELETE FROM influencer_import_plans WHERE id = $1`, [p.plan.id])).rejects.toThrow(
        /no se borra/,
      );
      await expect(
        query(`UPDATE influencer_import_records SET source_key = 'X' WHERE id = $1`, [r.recordId]),
      ).rejects.toThrow(/histórico/);
      await expect(
        query(`DELETE FROM influencer_import_records WHERE id = $1`, [r.recordId]),
      ).rejects.toThrow(/histórico/);
      await expect(
        query(`UPDATE influencer_source_bindings SET source_key = 'X' WHERE source_id = $1`, [hoja.sourceId]),
      ).rejects.toThrow(/histórico/);
      await expect(
        query(`DELETE FROM influencer_source_bindings WHERE source_id = $1`, [hoja.sourceId]),
      ).rejects.toThrow(/histórico/);
      await expect(
        query(`UPDATE influencer_import_effects SET action = 'created' WHERE record_id = $1`, [r.recordId]),
      ).rejects.toThrow(/histórico/);
      await expect(
        query(`DELETE FROM influencer_import_effects WHERE record_id = $1`, [r.recordId]),
      ).rejects.toThrow(/histórico/);
    },
  );

  si(
    'el binding no admite mezclar personas, ni una clave con dos personas, ni dos claves con una participación',
    async () => {
      const hoja = await nuevaHoja(campanaA);
      const p = await plan(hoja, [
        fila('INF-001', 'Una', 'instagram', h('bind_uno')),
        fila('INF-002', 'Dos', 'instagram', h('bind_dos')),
      ]);
      const [a, b] = valor(await applyInfluencerImport(admin, p.plan.id)).records;
      const insertar = (clave: string, influencerId: string, participacionId: string) =>
        query(
          `INSERT INTO influencer_source_bindings (organization_id, campaign_id, source_id, source_key, influencer_id, campaign_influencer_id,
                                                 bound_via, origin_snapshot_id, origin_record_id, origin_locators, bound_by)
         VALUES ($1, $2, $3, $4, $5, $6, 'account_match', $7, $8, '[]'::jsonb, $9)`,
          [
            admin.organizationId,
            campanaA.id,
            hoja.sourceId,
            clave,
            influencerId,
            participacionId,
            p.plan.snapshotId,
            a!.recordId,
            admin.id,
          ],
        );
      await expect(insertar('INF-001', a!.influencerId!, a!.campaignInfluencerId!)).rejects.toThrow(
        /influencer_source_bindings_clave_key/,
      );
      await expect(insertar('INF-099', a!.influencerId!, b!.campaignInfluencerId!)).rejects.toThrow(
        /mezcla un influencer/,
      );
      await expect(insertar('INF-098', b!.influencerId!, b!.campaignInfluencerId!)).rejects.toThrow(
        /influencer_source_bindings_participacion_key/,
      );
    },
  );
});
