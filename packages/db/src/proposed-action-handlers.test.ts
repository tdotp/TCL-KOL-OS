/**
 * V2 · Fase 6 — HITL extendido a la importación de influencers, sin segundo sistema.
 *
 *   ProposedActionType += influencer_import.apply · influencer_import.resolve_record
 *   mediante un registro de handlers (`HANDLERS[type]`); `brief.approve` conserva su
 *   garantía exacta (su suite es `proposed-actions.test.ts`).
 *
 * Qué verifica este archivo:
 *  · el registro cubre cada tipo del dominio;
 *  · la carrera de `proponerAccion`: N propuestas concurrentes → UNA vigente
 *    (con o sin el índice UNIQUE parcial de la migración 021);
 *  · aplicar un plan / resolver un registro NO se ejecutan desde el chat (ni
 *    directo ni vía `ejecutarAccion`), solo por una acción confirmada por una
 *    persona en la interfaz, con el payloadHash exacto;
 *  · la huella cubre el contenido mostrado (si cambia, la propuesta vence);
 *  · modo `idempotent_external`: una caída a medias deja la acción `confirmed` y
 *    el reintento reconcilia sin duplicar;
 *  · aislamiento (organización y campaña) y auditoría origin=chat + correlación;
 *  · retrocompatibilidad de `cancelarAccion` con contexto opcional.
 *
 * Datos sintéticos, campañas e influencers desechables. Las pruebas de importación
 * necesitan el worker real (parseo del Sheet); sin entorno Python se omiten con
 * un aviso explícito, nunca en silencio.
 */

import type { PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PROPOSED_ACTION_SPECS, type ProposedActionType, type Result, type User } from '@tcl-kol-os/domain';
import { closePool, getPool, query } from './client.ts';
import {
  asegurarUsuarioDePrueba,
  eliminarCampanaDePrueba,
  eliminarInfluencersDePrueba,
} from './test-utils.ts';
import { findUserByEmail } from './users.ts';
import { crearBriefManual } from './manual.ts';
import { corregirCampo } from './brief-fields.ts';
import { crearInfluencer } from './influencers.ts';
import { registerLinkedSource } from './sources.ts';
import { syncGoogleSheetSource } from './source-sync.ts';
import {
  type ImportDecision,
  applyInfluencerImport,
  leerDecisionDeImportacion,
  prepareInfluencerImport,
  resolveImportRecord,
} from './influencer-import.ts';
import {
  cancelarAccion,
  confirmarAccion,
  ejecutarAccion,
  obtenerAccionPropuesta,
  obtenerAccionPropuestaComoActor,
  proponerAccion,
} from './proposed-actions.ts';
import { HANDLERS, handlerDe } from './proposed-action-handlers.ts';
import {
  CABECERAS_V1,
  type CeldaDePrueba,
  GoogleSimulado,
  pestanaDeInfluencers,
} from './google-test-utils.ts';
import { hayWorkerLocal, procesarColaConWorker } from './worker-test-utils.ts';

const sufijo = Date.now().toString(36);
const h = (base: string) => `${base}${sufijo}`.toLowerCase();
const ID = (n: number) => `1Hit${sufijo}${String(n).padStart(3, '0')}${'z'.repeat(30)}`.slice(0, 44);
void CABECERAS_V1;

let admin: User;
let director: User;
let consultor: User;
let operativo: User;
let cliente: User;
let ajeno: User;
let google: GoogleSimulado;
let hayWorker = false;
let contador = 1;
let campana: { id: string; cp: Record<string, string> };
let campanaOtra: { id: string; cp: Record<string, string> };
const campanas: string[] = [];
const influencers: string[] = [];

const CORRELACION = { conversationId: 'conv-w1c', messageId: 'msg-1', agentRunId: 'run-1' } as const;

function valor<T>(r: Result<T>): T {
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
  return r.value;
}
type Resultado = { readonly ok: true } | { readonly ok: false; readonly error: { readonly code: string } };
const codigo = (r: Resultado) => (r.ok ? undefined : r.error.code);

async function contar(tabla: string, donde = 'true', params: unknown[] = []): Promise<number> {
  const [f] = await query<{ n: number }>(`SELECT count(*)::int AS n FROM ${tabla} WHERE ${donde}`, params);
  return f!.n;
}

async function estadoDeAccion(id: string): Promise<string> {
  const [f] = await query<{ status: string }>(`SELECT status FROM proposed_actions WHERE id = $1`, [id]);
  return f!.status;
}

async function abiertasDe(resourceId: string, type: string) {
  return query<{ id: string; status: string }>(
    `SELECT id, status FROM proposed_actions
      WHERE resource_id = $1 AND action_type = $2 AND status IN ('pending', 'confirmed')`,
    [resourceId, type],
  );
}

// ─────────────────────────── Fixtures: brief ───────────────────────────────────

async function nuevaVersionEnRevision(etiqueta: string): Promise<{ campaignId: string; versionId: string }> {
  const [c] = await query<{ id: string }>(
    `INSERT INTO campaigns (organization_id, name, owner_id, created_by)
     VALUES ($1, $2, $3, $3) RETURNING id`,
    [admin.organizationId, `HITL-W1C · ${etiqueta} · ${Date.now()}`, admin.id],
  );
  campanas.push(c!.id);
  const creado = await crearBriefManual(admin, c!.id);
  if (!creado.ok) throw new Error(creado.error.message);
  await query(`UPDATE brief_versions SET status = 'internal_review' WHERE id = $1`, [creado.value.versionId]);
  return { campaignId: c!.id, versionId: creado.value.versionId };
}

// ─────────────────────────── Fixtures: importación ─────────────────────────────

async function productoId(modelo: string): Promise<string> {
  const [fila] = await query<{ id: string }>(`SELECT id FROM products WHERE model = $1`, [modelo]);
  return fila!.id;
}

async function crearCampana(owner: User, nombre: string, modelos: string[]) {
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

async function nuevaHoja(c: { id: string }): Promise<Hoja> {
  const n = contador++;
  const r = valor(
    await registerLinkedSource(admin, {
      campaignId: c.id,
      url: `https://docs.google.com/spreadsheets/d/${ID(n)}/edit#gid=11`,
    }),
  );
  return { sourceId: r.id, libroId: ID(n), campaignId: c.id };
}

async function sincronizar(hoja: Hoja, filas: readonly Fila[]) {
  await google.publicar(hoja.libroId, [pestanaDeInfluencers(filas, {})]);
  valor(await syncGoogleSheetSource(admin, hoja.sourceId));
  await procesarColaConWorker(google.entorno);
}

async function planear(hoja: Hoja) {
  return valor(
    await prepareInfluencerImport(admin, { campaignId: hoja.campaignId, sourceId: hoja.sourceId }),
  );
}

/** Sincroniza + planea. */
async function planNuevo(filas: readonly Fila[], c: { id: string } = campana) {
  const hoja = await nuevaHoja(c);
  await sincronizar(hoja, filas);
  return { hoja, detalle: await planear(hoja) };
}

async function crearPersona(nombre: string, cuentas: { platform: 'instagram' | 'tiktok'; handle: string }[]) {
  const creado = valor(await crearInfluencer(admin, { displayName: nombre, cuentas }));
  influencers.push(creado.influencer.id);
  return creado.influencer.id;
}

async function influencersConHandle(base: string) {
  return query<{ id: string }>(
    `SELECT DISTINCT i.id FROM influencers i
       JOIN influencer_accounts a ON a.influencer_id = i.id
      WHERE a.normalized_handle LIKE $1 AND i.organization_id = $2`,
    [`${base.toLowerCase()}%${sufijo}`, admin.organizationId],
  );
}

async function auditoriaDe(entityId: string, action?: string) {
  return query<{
    action: string;
    origin: string;
    actor_id: string | null;
    correlation: Record<string, string> | null;
    metadata: Record<string, unknown>;
  }>(
    `SELECT action, origin, actor_id, correlation, metadata FROM audit_events
      WHERE entity_id = $1 AND ($2::text IS NULL OR action = $2) ORDER BY created_at, id`,
    [entityId, action ?? null],
  );
}

/** Propuesta del agente (chat) en nombre del consultor, acotada a la campaña de la conversación. */
async function proponerImport(
  type: 'influencer_import.apply' | 'influencer_import.resolve_record',
  resourceId: string,
  extra: Partial<Parameters<typeof proponerAccion>[1]> = {},
) {
  return proponerAccion(consultor, {
    type,
    resourceId,
    origin: 'chat',
    correlation: CORRELACION,
    campaignId: campana.id,
    ...extra,
  });
}

const proponerDecision = (recordId: string, decision: ImportDecision, extra = {}) =>
  proponerImport('influencer_import.resolve_record', recordId, { parametros: { decision }, ...extra });

/**
 * Inyecta un fallo real de base de datos al marcar `executed` SOLO para la acción
 * indicada (las demás pruebas comparten la base y no se ven afectadas).
 */
async function conFalloAlMarcarExecuted(accionId: string, fn: () => Promise<void>): Promise<void> {
  const pool = getPool();
  await pool.query(`
    CREATE OR REPLACE FUNCTION test_fallo_w1c_hitl() RETURNS trigger AS $$
    BEGIN
      IF NEW.status = 'executed' AND NEW.id::text = TG_ARGV[0] THEN
        RAISE EXCEPTION 'fallo inyectado: marcar executed';
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql`);
  const trigger = `test_fallo_w1c_${accionId.replace(/-/g, '').slice(0, 12)}`;
  await pool.query(
    `CREATE TRIGGER ${trigger} BEFORE UPDATE ON proposed_actions
       FOR EACH ROW EXECUTE FUNCTION test_fallo_w1c_hitl('${accionId}')`,
  );
  try {
    await fn();
  } finally {
    await pool.query(`DROP TRIGGER IF EXISTS ${trigger} ON proposed_actions`);
  }
}

// ¿Existe ya el UNIQUE parcial de la migración 021? Las pruebas que dependen de él se activan solas.
const [indiceUnico] = await query<{ n: number }>(
  `SELECT count(*)::int AS n FROM pg_indexes
    WHERE tablename = 'proposed_actions' AND indexdef ILIKE '%UNIQUE%'
      AND indexdef ILIKE '%action_type, resource_id%' AND indexdef ILIKE '%WHERE%'`,
);
const hayIndiceUnico = (indiceUnico?.n ?? 0) > 0;

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
      'No hay entorno de Python del worker (services/ai-worker/.venv); se omiten las pruebas de importación con worker real.',
    );
  }
  google = await GoogleSimulado.crear();
  campana = await crearCampana(admin, 'HITL import A', ['P80', 'P80 Pro']);
  campanaOtra = await crearCampana(admin, 'HITL import B', ['C7L']);
});

afterAll(async () => {
  const creados = await query<{ id: string }>(
    `SELECT DISTINCT i.id FROM influencers i JOIN influencer_accounts a ON a.influencer_id = i.id
      WHERE a.normalized_handle LIKE $1`,
    [`%${sufijo}%`],
  );
  await eliminarCampanaDePrueba(campanas);
  await eliminarInfluencersDePrueba([...influencers, ...creados.map((f) => f.id)]);
  await google.limpiar();
  await closePool();
});

const si = (nombre: string, fn: () => Promise<void>) =>
  it(nombre, async () => (hayWorker ? fn() : undefined));

// ─────────────────────────── El registro ───────────────────────────────────────

describe('registro de handlers', () => {
  it('hay exactamente un handler por tipo de acción del dominio, y coincide con su spec', () => {
    const tipos = Object.keys(PROPOSED_ACTION_SPECS).sort();
    expect(Object.keys(HANDLERS).sort()).toEqual(tipos);
    for (const tipo of tipos) {
      expect(HANDLERS[tipo as ProposedActionType].type).toBe(tipo);
      expect(handlerDe(tipo)).toBe(HANDLERS[tipo as ProposedActionType]);
    }
  });

  it('la garantía de cada tipo está declarada: brief.approve atómico; la importación idempotente externa', () => {
    expect(HANDLERS['brief.approve'].modo).toBe('atomic');
    expect(HANDLERS['influencer_import.apply'].modo).toBe('idempotent_external');
    expect(HANDLERS['influencer_import.resolve_record'].modo).toBe('idempotent_external');
  });

  it('un tipo inexistente (o heredado del prototipo) no tiene handler ni se propone', async () => {
    for (const tipo of ['nope', 'constructor', '__proto__', 'toString']) {
      expect(handlerDe(tipo)).toBeUndefined();
    }
    const { versionId } = await nuevaVersionEnRevision('tipo-invalido');
    const r = await proponerAccion(consultor, { type: 'constructor' as never, resourceId: versionId });
    expect(r.ok).toBe(false);
  });

  it('un id que no es un uuid no es un recurso (sin llegar al motor)', async () => {
    const r = await proponerAccion(consultor, { type: 'brief.approve', resourceId: 'no-es-uuid' });
    expect(codigo(r)).toBe('RESOURCE_NOT_FOUND');
  });
});

describe('leerDecisionDeImportacion (entrada no confiable del agente)', () => {
  const ID_A = '0F6B2C1E-1111-4222-8333-444455556666';

  it('normaliza: ids en minúscula, referencia recortada, solo las claves del tipo', () => {
    const r = leerDecisionDeImportacion({
      kind: 'use_existing_influencer',
      influencerId: ID_A,
      reason: 'ok',
    });
    expect(r.ok && r.value).toEqual({
      kind: 'use_existing_influencer',
      influencerId: ID_A.toLowerCase(),
      reason: 'ok',
    });
    const p = leerDecisionDeImportacion({
      kind: 'choose_product',
      productRef: '  P80  ',
      campaignProductId: ID_A,
    });
    expect(p.ok && p.value).toEqual({
      kind: 'choose_product',
      productRef: 'P80',
      campaignProductId: ID_A.toLowerCase(),
    });
    expect(leerDecisionDeImportacion({ kind: 'ignore_record' }).ok).toBe(true);
    expect(leerDecisionDeImportacion({ kind: 'create_new_influencer', reason: 'x' }).ok).toBe(true);
  });

  it('rechaza lo que no es exactamente una decisión', () => {
    for (const mala of [
      null,
      undefined,
      'ignore_record',
      [],
      { kind: 'constructor' },
      { kind: '__proto__' },
      { kind: 'ignore_record', influencerId: ID_A },
      { kind: 'use_existing_influencer', influencerId: `${ID_A} ` },
      { kind: 'choose_product', productRef: '', campaignProductId: ID_A },
      { kind: 'choose_product', productRef: 'P80', campaignProductId: 'x' },
      { kind: 'ignore_record', reason: 5 },
      { kind: 'ignore_record', reason: 'r'.repeat(501) },
    ]) {
      const r = leerDecisionDeImportacion(mala);
      expect(r.ok, JSON.stringify(mala)).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('VALIDATION_FAILED');
    }
  });
});

// ─────────────────────────── Carrera de proponerAccion (D7) ───────────────────

describe('proponerAccion: N propuestas concurrentes dejan UNA vigente', () => {
  const proponerComoAgente = (versionId: string, extra = {}) =>
    proponerAccion(consultor, {
      type: 'brief.approve',
      resourceId: versionId,
      origin: 'chat',
      correlation: CORRELACION,
      ...extra,
    });

  it('12 propuestas simultáneas del mismo recurso: una sola abierta, la misma para todas', async () => {
    const { versionId } = await nuevaVersionEnRevision('carrera');
    const resultados = await Promise.all(Array.from({ length: 12 }, () => proponerComoAgente(versionId)));
    const ids = new Set(resultados.map((r) => valor(r).id));
    expect(ids.size).toBe(1);
    expect(await abiertasDe(versionId, 'brief.approve')).toHaveLength(1);
    expect(
      await contar('audit_events', `entity_id = $1 AND action = 'proposed_action.propose'`, [[...ids][0]]),
    ).toBe(1);
    expect(await contar('proposed_actions', `resource_id = $1`, [versionId])).toBe(1);
  });

  it('con una abierta de plazo vencido: las simultáneas la vencen y dejan UNA vigente nueva', async () => {
    const { versionId } = await nuevaVersionEnRevision('carrera-vencida');
    const vieja = valor(await proponerComoAgente(versionId, { ttlSegundos: 1 }));
    await new Promise((resolve) => setTimeout(resolve, 1200));
    // Sigue `pending` en la base (nadie barrió), pero caducada.
    expect(await estadoDeAccion(vieja.id)).toBe('pending');

    const resultados = await Promise.all(Array.from({ length: 8 }, () => proponerComoAgente(versionId)));
    const ids = new Set(resultados.map((r) => valor(r).id));
    expect(ids.size).toBe(1);
    expect(ids.has(vieja.id)).toBe(false);
    expect(await estadoDeAccion(vieja.id)).toBe('expired');
    expect(await abiertasDe(versionId, 'brief.approve')).toHaveLength(1);
  });

  it('la huella cubre el contenido: si el brief cambia, la propuesta anterior vence y nace otra', async () => {
    const { versionId } = await nuevaVersionEnRevision('huella-cambia');
    const a = valor(await proponerComoAgente(versionId));
    const [campo] = await query<{ id: string; revision: number }>(
      `SELECT id, revision FROM brief_fields WHERE brief_version_id = $1 LIMIT 1`,
      [versionId],
    );
    const edicion = await corregirCampo(admin, versionId, campo!.id, {
      value: 'Valor distinto',
      revisionEsperada: campo!.revision,
    });
    expect(edicion.ok).toBe(true);
    const b = valor(await proponerComoAgente(versionId));
    expect(b.id).not.toBe(a.id);
    expect(b.payloadHash).not.toBe(a.payloadHash);
    expect(await estadoDeAccion(a.id)).toBe('expired');
    expect(await abiertasDe(versionId, 'brief.approve')).toEqual([{ id: b.id, status: 'pending' }]);
  });

  it('propuestas de recursos distintos no se serializan entre sí ni se confunden', async () => {
    const [v1, v2] = await Promise.all([nuevaVersionEnRevision('par-1'), nuevaVersionEnRevision('par-2')]);
    const resultados = await Promise.all([
      proponerComoAgente(v1.versionId),
      proponerComoAgente(v2.versionId),
      proponerComoAgente(v1.versionId),
      proponerComoAgente(v2.versionId),
    ]);
    const [a, b, c, d] = resultados.map(valor);
    expect(a!.id).toBe(c!.id);
    expect(b!.id).toBe(d!.id);
    expect(a!.id).not.toBe(b!.id);
  });

  describe.runIf(hayIndiceUnico)('con el UNIQUE parcial (migración 021)', () => {
    async function insertarAbiertaIdentica(client: PoolClient, origen: string, hash?: string) {
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO proposed_actions
           (organization_id, campaign_id, action_type, resource_type, resource_id, payload, payload_hash,
            proposed_by, proposed_origin, expires_at)
         SELECT organization_id, campaign_id, action_type, resource_type, resource_id, payload,
                COALESCE($2, payload_hash), proposed_by, proposed_origin, now() + interval '1 day'
           FROM proposed_actions WHERE id = $1
         RETURNING id`,
        [origen, hash ?? null],
      );
      return rows[0]!.id;
    }

    it('el índice rechaza dos abiertas del mismo recurso, aunque se salte la API', async () => {
      const { versionId } = await nuevaVersionEnRevision('indice-directo');
      const a = valor(await proponerComoAgente(versionId));
      await expect(
        query(
          `INSERT INTO proposed_actions
             (organization_id, campaign_id, action_type, resource_type, resource_id, payload, payload_hash,
              proposed_by, proposed_origin, expires_at)
           SELECT organization_id, campaign_id, action_type, resource_type, resource_id, payload, payload_hash,
                  proposed_by, proposed_origin, now() + interval '1 day'
             FROM proposed_actions WHERE id = $1`,
          [a.id],
        ),
      ).rejects.toThrow(/duplicate key|unique/i);
    });

    it('ante 23505 (otra transacción ganó la carrera) relee y devuelve la vigente idéntica', async () => {
      const { versionId } = await nuevaVersionEnRevision('indice-23505');
      const p0 = valor(await proponerComoAgente(versionId));
      expect((await cancelarAccion(consultor, p0.id)).ok).toBe(true);

      // Otra transacción inserta la abierta idéntica y tarda en confirmar; la
      // propuesta concurrente no la ve, intenta insertar y espera al índice.
      const client = await getPool().connect();
      let ganadora: string;
      try {
        await client.query('BEGIN');
        ganadora = await insertarAbiertaIdentica(client, p0.id);
        const enCarrera = proponerComoAgente(versionId);
        await new Promise((resolve) => setTimeout(resolve, 400));
        await client.query('COMMIT');
        const r = valor(await enCarrera);
        expect(r.id).toBe(ganadora);
      } finally {
        client.release();
      }
      expect(await abiertasDe(versionId, 'brief.approve')).toEqual([{ id: ganadora, status: 'pending' }]);
    });

    it('ante 23505 con otra huella: la ganadora vence y queda UNA vigente con el contenido actual', async () => {
      const { versionId } = await nuevaVersionEnRevision('indice-23505-otra-huella');
      const p0 = valor(await proponerComoAgente(versionId));
      expect((await cancelarAccion(consultor, p0.id)).ok).toBe(true);
      const client = await getPool().connect();
      let ganadora: string;
      try {
        await client.query('BEGIN');
        // La «ganadora» se calculó sobre un contenido que ya no es el vigente.
        ganadora = await insertarAbiertaIdentica(client, p0.id, 'f'.repeat(64));
        const enCarrera = proponerComoAgente(versionId);
        await new Promise((resolve) => setTimeout(resolve, 400));
        await client.query('COMMIT');
        const r = valor(await enCarrera);
        expect(r.id).not.toBe(ganadora);
        expect(r.payloadHash).toBe(p0.payloadHash);
      } finally {
        client.release();
      }
      expect(await estadoDeAccion(ganadora)).toBe('expired');
      expect(await abiertasDe(versionId, 'brief.approve')).toHaveLength(1);
    });
  });
});

// ─────────────────────────── Lectura acotada y cancelación ────────────────────

describe('lectura acotada de la acción propuesta', () => {
  it('permiso según el tipo, organización y campaña: lo ajeno es RESOURCE_NOT_FOUND', async () => {
    const { campaignId, versionId } = await nuevaVersionEnRevision('lectura');
    const a = valor(
      await proponerAccion(consultor, { type: 'brief.approve', resourceId: versionId, origin: 'chat' }),
    );
    // Roles con capacidad de proponer o confirmar el tipo.
    for (const actor of [admin, director, consultor]) {
      expect((await obtenerAccionPropuesta(actor, a.id)).ok, actor.role).toBe(true);
    }
    // Sin capacidad para el tipo, o de otra organización: no existe para ellos.
    for (const actor of [operativo, cliente, ajeno]) {
      expect(codigo(await obtenerAccionPropuesta(actor, a.id)), actor.role).toBe('RESOURCE_NOT_FOUND');
    }
    // Alcance de campaña: la de la conversación sí; otra no.
    expect((await obtenerAccionPropuestaComoActor(consultor, a.id, { campaignId })).ok).toBe(true);
    expect(codigo(await obtenerAccionPropuestaComoActor(consultor, a.id, { campaignId: campana.id }))).toBe(
      'RESOURCE_NOT_FOUND',
    );
    // Id mal formado o inexistente.
    expect(codigo(await obtenerAccionPropuesta(consultor, 'no-uuid'))).toBe('RESOURCE_NOT_FOUND');
    expect(codigo(await obtenerAccionPropuesta(consultor, '00000000-0000-4000-8000-000000000000'))).toBe(
      'RESOURCE_NOT_FOUND',
    );
  });

  it('proponer con alcance de campaña: un recurso de otra campaña no se revela', async () => {
    const { campaignId, versionId } = await nuevaVersionEnRevision('alcance');
    const fuera = await proponerAccion(consultor, {
      type: 'brief.approve',
      resourceId: versionId,
      origin: 'chat',
      campaignId: campana.id,
    });
    expect(codigo(fuera)).toBe('RESOURCE_NOT_FOUND');
    expect(await contar('proposed_actions', `resource_id = $1`, [versionId])).toBe(0);
    const dentro = await proponerAccion(consultor, {
      type: 'brief.approve',
      resourceId: versionId,
      origin: 'chat',
      campaignId,
    });
    expect(dentro.ok).toBe(true);
  });
});

describe('cancelarAccion con contexto opcional', () => {
  it('por defecto el origen es ui (como siempre); desde el chat queda origin=chat con su correlación', async () => {
    const { versionId: v1 } = await nuevaVersionEnRevision('cancel-ui');
    const { versionId: v2 } = await nuevaVersionEnRevision('cancel-chat');
    const a = valor(await proponerAccion(consultor, { type: 'brief.approve', resourceId: v1 }));
    const b = valor(await proponerAccion(consultor, { type: 'brief.approve', resourceId: v2 }));

    expect((await cancelarAccion(consultor, a.id)).ok).toBe(true);
    expect((await cancelarAccion(consultor, b.id, { origin: 'chat', correlation: CORRELACION })).ok).toBe(
      true,
    );

    const [ea] = await auditoriaDe(a.id, 'proposed_action.cancel');
    expect(ea).toMatchObject({ origin: 'ui', actor_id: consultor.id });
    expect(ea!.correlation).toEqual({ proposedActionId: a.id });
    const [eb] = await auditoriaDe(b.id, 'proposed_action.cancel');
    expect(eb).toMatchObject({ origin: 'chat', actor_id: consultor.id });
    expect(eb!.correlation).toMatchObject({ ...CORRELACION, proposedActionId: b.id });
  });

  it('un origen system para una persona no cancela; cliente y operativo tampoco', async () => {
    const { versionId } = await nuevaVersionEnRevision('cancel-no');
    const a = valor(await proponerAccion(consultor, { type: 'brief.approve', resourceId: versionId }));
    expect((await cancelarAccion(consultor, a.id, { origin: 'system' })).ok).toBe(false);
    for (const actor of [cliente, operativo, ajeno]) {
      expect((await cancelarAccion(actor, a.id)).ok, actor.role).toBe(false);
    }
    expect(await estadoDeAccion(a.id)).toBe('pending');
  });
});

// ─────────────────────────── influencer_import.apply ──────────────────────────

describe('influencer_import.apply', () => {
  si(
    'el agente propone; el chat no aplica ni confirma; una persona confirma y ejecuta en la UI',
    async () => {
      const { detalle } = await planNuevo([
        fila('INF-001', 'Ana Apply', 'instagram', h('ana_apply')),
        fila('INF-002', 'Beto Apply', 'tiktok', h('beto_apply')),
      ]);
      const planId = detalle.plan.id;

      // Aplicar DIRECTO desde el canal chat se rechaza (la persona tenga o no permiso).
      for (const actor of [consultor, director, admin]) {
        const directo = await applyInfluencerImport(actor, planId, {
          origin: 'chat',
          correlation: CORRELACION,
        });
        expect(codigo(directo), actor.role).toBe('HUMAN_CONFIRMATION_REQUIRED');
      }
      expect(await influencersConHandle('ana_apply')).toHaveLength(0);

      // Proponer.
      const propuesta = valor(await proponerImport('influencer_import.apply', planId));
      expect(propuesta).toMatchObject({
        type: 'influencer_import.apply',
        resourceType: 'influencer_import_plan',
        resourceId: planId,
        campaignId: campana.id,
        status: 'pending',
        proposedOrigin: 'chat',
        proposedBy: consultor.id,
      });
      expect(propuesta.payload).toMatchObject({ planId, snapshotId: detalle.plan.snapshotId });
      expect(Object.keys(propuesta.payload).sort()).toEqual(
        [
          'muestra',
          'planFingerprint',
          'planId',
          'snapshotContentHash',
          'snapshotId',
          'stateFingerprint',
        ].sort(),
      );
      // Proponer no aplica nada.
      expect(await influencersConHandle('ana_apply')).toHaveLength(0);
      expect((await ejecutarAccion(director, propuesta.id, { canal: 'ui' })).ok).toBe(false);

      // system y el canal chat no confirman NI ejecutan, con la huella correcta.
      for (const r of [
        await confirmarAccion('system', propuesta.id, { canal: 'ui', payloadHash: propuesta.payloadHash }),
        await confirmarAccion(director, propuesta.id, { canal: 'chat', payloadHash: propuesta.payloadHash }),
        await confirmarAccion(director, propuesta.id, {
          canal: 'system',
          payloadHash: propuesta.payloadHash,
        }),
        await ejecutarAccion('system', propuesta.id, { canal: 'ui' }),
        await ejecutarAccion(director, propuesta.id, { canal: 'chat' }),
      ]) {
        expect(codigo(r)).toBe('HUMAN_CONFIRMATION_REQUIRED');
      }
      // Sin permiso o de otra organización: tampoco.
      for (const actor of [operativo, cliente, ajeno]) {
        expect(
          (await confirmarAccion(actor, propuesta.id, { canal: 'ui', payloadHash: propuesta.payloadHash }))
            .ok,
          actor.role,
        ).toBe(false);
      }
      // Otra huella: no es lo que se le mostró.
      expect(
        codigo(await confirmarAccion(director, propuesta.id, { canal: 'ui', payloadHash: 'f'.repeat(64) })),
      ).toBe('PROPOSAL_STALE');
      expect(await estadoDeAccion(propuesta.id)).toBe('pending');
      expect(await influencersConHandle('ana_apply')).toHaveLength(0);

      // Confirma el director en la UI. Confirmar no aplica.
      const confirmada = valor(
        await confirmarAccion(director, propuesta.id, { canal: 'ui', payloadHash: propuesta.payloadHash }),
      );
      expect(confirmada).toMatchObject({ status: 'confirmed', confirmedBy: director.id });
      expect(await influencersConHandle('ana_apply')).toHaveLength(0);

      // Solo quien confirmó ejecuta.
      expect(codigo(await ejecutarAccion(admin, propuesta.id, { canal: 'ui' }))).toBe(
        'HUMAN_CONFIRMATION_REQUIRED',
      );
      const ejecutada = valor(await ejecutarAccion(director, propuesta.id, { canal: 'ui' }));
      expect(ejecutada.status).toBe('executed');
      expect(await influencersConHandle('ana_apply')).toHaveLength(1);
      expect(await influencersConHandle('beto_apply')).toHaveLength(1);
      // Lo creó la PERSONA que confirmó (no el agente ni el sistema).
      const [ana] = await influencersConHandle('ana_apply');
      expect(await contar('influencers', 'id = $1 AND created_by = $2', [ana!.id, director.id])).toBe(1);

      // Auditoría: propuesta (chat + correlación), confirmación y ejecución (ui), y el caso de uso (ui + acción).
      const eventos = await auditoriaDe(propuesta.id);
      expect(eventos.map((e) => e.action)).toEqual([
        'proposed_action.propose',
        'proposed_action.confirm',
        'proposed_action.execute',
      ]);
      expect(eventos[0]).toMatchObject({ origin: 'chat', actor_id: consultor.id });
      expect(eventos[0]!.correlation).toMatchObject({ ...CORRELACION, proposedActionId: propuesta.id });
      expect(eventos[1]).toMatchObject({ origin: 'ui', actor_id: director.id });
      expect(eventos[2]).toMatchObject({ origin: 'ui', actor_id: director.id });
      expect(eventos[2]!.metadata).toMatchObject({
        type: 'influencer_import.apply',
        mode: 'idempotent_external',
        applied: 2,
      });
      const aplicacion = (await auditoriaDe(planId, 'influencer_import.apply')).at(-1)!;
      expect(aplicacion).toMatchObject({ origin: 'ui', actor_id: director.id });
      expect(aplicacion.correlation).toEqual({ proposedActionId: propuesta.id });

      // Replay: no se repite ni se reconfirma.
      for (const r of [
        await ejecutarAccion(director, propuesta.id, { canal: 'ui' }),
        await confirmarAccion(director, propuesta.id, { canal: 'ui', payloadHash: propuesta.payloadHash }),
      ]) {
        expect(codigo(r)).toBe('PROPOSAL_INVALID_STATE');
      }
      expect(await influencersConHandle('ana_apply')).toHaveLength(1);
    },
  );

  si(
    'la vía directa de la UI no cambia: una persona sin contexto o con origen ui sigue aplicando',
    async () => {
      const { detalle } = await planNuevo([fila('INF-001', 'Directa Ui', 'instagram', h('directa_ui'))]);
      const r = valor(await applyInfluencerImport(consultor, detalle.plan.id));
      expect(r.records[0]!.status).toBe('applied');
      const [evento] = await auditoriaDe(detalle.plan.id, 'influencer_import.apply');
      expect(evento).toMatchObject({ origin: 'ui', actor_id: consultor.id });
    },
  );

  si('proponer: alcance de campaña, organización, rol y sistema', async () => {
    const { detalle } = await planNuevo([fila('INF-001', 'Alcance', 'instagram', h('alcance_apply'))]);
    const planId = detalle.plan.id;
    // Otra campaña de la conversación: el plan no existe para ella.
    expect(
      codigo(await proponerImport('influencer_import.apply', planId, { campaignId: campanaOtra.id })),
    ).toBe('RESOURCE_NOT_FOUND');
    // Otra organización: no existe.
    expect(
      codigo(
        await proponerAccion(ajeno, { type: 'influencer_import.apply', resourceId: planId, origin: 'chat' }),
      ),
    ).toBe('RESOURCE_NOT_FOUND');
    // Sin la capacidad: cliente y operativo ni proponen.
    for (const actor of [cliente, operativo]) {
      expect(
        codigo(await proponerAccion(actor, { type: 'influencer_import.apply', resourceId: planId })),
        actor.role,
      ).toBe('FORBIDDEN_ROLE');
    }
    // El sistema no propone importaciones: las formaliza una persona (o el agente por ella).
    expect(
      codigo(await proponerAccion('system', { type: 'influencer_import.apply', resourceId: planId })),
    ).toBe('FORBIDDEN_ROLE');
    // Un id que no es un plan (p. ej. una versión de brief) no existe como plan.
    const { versionId } = await nuevaVersionEnRevision('id-equivocado');
    expect(codigo(await proponerImport('influencer_import.apply', versionId))).toBe('RESOURCE_NOT_FOUND');
    expect(await contar('proposed_actions', `resource_id = $1`, [planId])).toBe(0);
    // Y con el alcance correcto sí.
    expect((await proponerImport('influencer_import.apply', planId)).ok).toBe(true);
  });

  si('proponer es idempotente y concurrente: N propuestas del mismo plan dejan UNA vigente', async () => {
    const { detalle } = await planNuevo([fila('INF-001', 'Idem', 'instagram', h('idem_apply'))]);
    const resultados = await Promise.all(
      Array.from({ length: 6 }, () => proponerImport('influencer_import.apply', detalle.plan.id)),
    );
    expect(new Set(resultados.map((r) => valor(r).id)).size).toBe(1);
    expect(await abiertasDe(detalle.plan.id, 'influencer_import.apply')).toHaveLength(1);
  });

  si('un plan reemplazado entre la propuesta y la confirmación NO se confirma (PROPOSAL_STALE)', async () => {
    const hoja = await nuevaHoja(campana);
    await sincronizar(hoja, [fila('INF-001', 'Cambia', 'instagram', h('cambia_plan'))]);
    const p1 = await planear(hoja);
    const propuesta = valor(await proponerImport('influencer_import.apply', p1.plan.id));

    // El Sheet cambia, se sincroniza y se planea de nuevo: el plan 1 queda superseded.
    await sincronizar(hoja, [
      fila('INF-001', 'Cambia', 'instagram', h('cambia_plan')),
      fila('INF-002', 'Nueva Persona', 'tiktok', h('cambia_plan2')),
    ]);
    const p2 = await planear(hoja);
    expect(p2.plan.id).not.toBe(p1.plan.id);

    const r = await confirmarAccion(director, propuesta.id, {
      canal: 'ui',
      payloadHash: propuesta.payloadHash,
    });
    expect(codigo(r)).toBe('PROPOSAL_STALE');
    expect(await estadoDeAccion(propuesta.id)).toBe('pending');
    expect(await influencersConHandle('cambia_plan')).toHaveLength(0);
    // Tampoco se puede proponer sobre el plan reemplazado.
    const otra = await proponerImport('influencer_import.apply', p1.plan.id);
    expect(codigo(otra)).toBe('RESOURCE_CONFLICT');
    // Sobre el vigente sí.
    expect((await proponerImport('influencer_import.apply', p2.plan.id)).ok).toBe(true);
  });

  si(
    'la huella cubre el contenido mostrado: una decisión nueva sobre el plan invalida la propuesta',
    async () => {
      const { detalle } = await planNuevo([
        fila('INF-001', 'Huella Uno', 'instagram', h('huella_uno')),
        fila('INF-002', 'Huella Dos', 'tiktok', h('huella_dos')),
      ]);
      const planId = detalle.plan.id;
      const vieja = valor(await proponerImport('influencer_import.apply', planId));

      // Una persona decide algo sobre un registro (ignorarlo) por la vía de la UI.
      const registro = detalle.records.find((r) => r.sourceKey === 'INF-001')!;
      valor(await resolveImportRecord(consultor, registro.id, { kind: 'ignore_record', reason: 'No va' }));

      // Confirmar la vieja falla: ya no corresponde a lo que se le mostró.
      expect(
        codigo(await confirmarAccion(director, vieja.id, { canal: 'ui', payloadHash: vieja.payloadHash })),
      ).toBe('PROPOSAL_STALE');

      // Proponer de nuevo: otra huella, la anterior vence, y la nueva sí se ejecuta.
      const nueva = valor(await proponerImport('influencer_import.apply', planId));
      expect(nueva.id).not.toBe(vieja.id);
      expect(nueva.payloadHash).not.toBe(vieja.payloadHash);
      expect(await estadoDeAccion(vieja.id)).toBe('expired');
      valor(await confirmarAccion(director, nueva.id, { canal: 'ui', payloadHash: nueva.payloadHash }));
      valor(await ejecutarAccion(director, nueva.id, { canal: 'ui' }));
      expect(await influencersConHandle('huella_uno')).toHaveLength(0); // ignorado: no se crea
      expect(await influencersConHandle('huella_dos')).toHaveLength(1);
    },
  );

  si('si el plan cambia ENTRE confirmar y ejecutar, la ejecución falla y no aplica nada', async () => {
    const { detalle } = await planNuevo([
      fila('INF-001', 'Tarde Uno', 'instagram', h('tarde_uno')),
      fila('INF-002', 'Tarde Dos', 'tiktok', h('tarde_dos')),
    ]);
    const a = valor(await proponerImport('influencer_import.apply', detalle.plan.id));
    valor(await confirmarAccion(director, a.id, { canal: 'ui', payloadHash: a.payloadHash }));
    // Una decisión humana nueva sobre el plan (por la UI) después de confirmar.
    valor(
      await resolveImportRecord(admin, detalle.records[0]!.id, { kind: 'ignore_record', reason: 'Tarde' }),
    );
    expect(codigo(await ejecutarAccion(director, a.id, { canal: 'ui' }))).toBe('PROPOSAL_STALE');
    expect(await estadoDeAccion(a.id)).toBe('confirmed');
    expect(await influencersConHandle('tarde_dos')).toHaveLength(0);
  });

  si('si el plan queda reemplazado entre confirmar y ejecutar, la ejecución falla', async () => {
    const hoja = await nuevaHoja(campana);
    await sincronizar(hoja, [fila('INF-001', 'Reemplazo', 'instagram', h('reemplazo_tarde'))]);
    const p1 = await planear(hoja);
    const a = valor(await proponerImport('influencer_import.apply', p1.plan.id));
    valor(await confirmarAccion(director, a.id, { canal: 'ui', payloadHash: a.payloadHash }));
    await sincronizar(hoja, [
      fila('INF-001', 'Reemplazo', 'instagram', h('reemplazo_tarde')),
      fila('INF-002', 'Otra', 'tiktok', h('reemplazo_tarde2')),
    ]);
    await planear(hoja);
    expect(codigo(await ejecutarAccion(director, a.id, { canal: 'ui' }))).toBe('PROPOSAL_STALE');
    expect(await influencersConHandle('reemplazo_tarde')).toHaveLength(0);
  });

  si(
    'una cancelación evita la ejecución; el consultor que propone también puede confirmar su importación',
    async () => {
      const { detalle } = await planNuevo([fila('INF-001', 'Cancelable', 'instagram', h('cancelable'))]);
      const a = valor(await proponerImport('influencer_import.apply', detalle.plan.id));
      expect((await cancelarAccion(consultor, a.id, { origin: 'chat', correlation: CORRELACION })).ok).toBe(
        true,
      );
      expect(
        codigo(await confirmarAccion(consultor, a.id, { canal: 'ui', payloadHash: a.payloadHash })),
      ).toBe('PROPOSAL_INVALID_STATE');
      expect(await influencersConHandle('cancelable')).toHaveLength(0);

      // Nueva propuesta: el HITL de la importación es la confirmación en la UI de una persona con la capacidad.
      const b = valor(await proponerImport('influencer_import.apply', detalle.plan.id));
      valor(await confirmarAccion(consultor, b.id, { canal: 'ui', payloadHash: b.payloadHash }));
      valor(await ejecutarAccion(consultor, b.id, { canal: 'ui' }));
      expect(await influencersConHandle('cancelable')).toHaveLength(1);
    },
  );

  si(
    'modo idempotent_external: una caída tras aplicar deja la acción confirmed y el reintento NO duplica',
    async () => {
      const { detalle } = await planNuevo([
        fila('INF-001', 'Reintento Uno', 'instagram', h('reintento_uno')),
        fila('INF-002', 'Reintento Dos', 'tiktok', h('reintento_dos')),
      ]);
      const a = valor(await proponerImport('influencer_import.apply', detalle.plan.id));
      valor(await confirmarAccion(director, a.id, { canal: 'ui', payloadHash: a.payloadHash }));

      await conFalloAlMarcarExecuted(a.id, async () => {
        await expect(ejecutarAccion(director, a.id, { canal: 'ui' })).rejects.toThrow(/fallo inyectado/);
      });
      // La garantía es más débil que brief.approve: el dominio SÍ quedó aplicado y la acción sigue confirmed.
      expect(await estadoDeAccion(a.id)).toBe('confirmed');
      expect(await influencersConHandle('reintento_uno')).toHaveLength(1);
      expect(await influencersConHandle('reintento_dos')).toHaveLength(1);
      expect(
        await contar('audit_events', `entity_id = $1 AND action = 'proposed_action.execute'`, [a.id]),
      ).toBe(0);

      // El reintento reconcilia: ejecuta una vez, sin duplicar personas ni participaciones.
      const reintento = await ejecutarAccion(director, a.id, { canal: 'ui' });
      expect(reintento.ok, !reintento.ok ? reintento.error.message : '').toBe(true);
      expect(await estadoDeAccion(a.id)).toBe('executed');
      expect(await influencersConHandle('reintento_uno')).toHaveLength(1);
      expect(await influencersConHandle('reintento_dos')).toHaveLength(1);
      expect(
        await contar('campaign_influencers', `campaign_id = $1 AND created_by = $2`, [
          campana.id,
          director.id,
        ]),
      ).toBeGreaterThanOrEqual(2);
      expect(
        await contar('audit_events', `entity_id = $1 AND action = 'proposed_action.execute'`, [a.id]),
      ).toBe(1);
      expect(codigo(await ejecutarAccion(director, a.id, { canal: 'ui' }))).toBe('PROPOSAL_INVALID_STATE');
    },
  );
});

// ─────────────────────────── influencer_import.resolve_record ─────────────────

describe('influencer_import.resolve_record', () => {
  /** Plan con un registro «create_new» cuya persona ya existe con otra cuenta: hay que decidir. */
  async function escenarioDeResolucion(etiqueta: string) {
    const existente = await crearPersona(`Persona ${etiqueta}`, [
      { platform: 'instagram', handle: h(`${etiqueta}_ig_vieja`) },
    ]);
    const { hoja, detalle } = await planNuevo([
      fila('INF-001', `Persona ${etiqueta}`, 'tiktok', h(`${etiqueta}_tt_nueva`)),
    ]);
    const registro = detalle.records[0]!;
    return { existente, hoja, detalle, registro };
  }

  si(
    'el agente propone la decisión; el chat no resuelve; la persona que confirma queda como quien decidió',
    async () => {
      const { existente, hoja, registro } = await escenarioDeResolucion('res_a');
      const decision: ImportDecision = {
        kind: 'use_existing_influencer',
        influencerId: existente,
        reason: 'Es la misma persona',
      };

      // Resolver DIRECTO desde el chat se rechaza y no deja nada.
      for (const actor of [consultor, director, admin]) {
        const directo = await resolveImportRecord(actor, registro.id, decision, {
          origin: 'chat',
          correlation: CORRELACION,
        });
        expect(codigo(directo), actor.role).toBe('HUMAN_CONFIRMATION_REQUIRED');
      }
      expect(await contar('influencer_import_resolutions', 'record_id = $1', [registro.id])).toBe(0);

      const propuesta = valor(await proponerDecision(registro.id, decision));
      expect(propuesta).toMatchObject({
        type: 'influencer_import.resolve_record',
        resourceType: 'influencer_import_record',
        resourceId: registro.id,
        campaignId: campana.id,
        status: 'pending',
        proposedOrigin: 'chat',
      });
      expect(propuesta.payload).toMatchObject({ recordId: registro.id, decision });
      expect(await contar('influencer_import_resolutions', 'record_id = $1', [registro.id])).toBe(0);

      for (const r of [
        await confirmarAccion('system', propuesta.id, { canal: 'ui', payloadHash: propuesta.payloadHash }),
        await confirmarAccion(consultor, propuesta.id, { canal: 'chat', payloadHash: propuesta.payloadHash }),
        await ejecutarAccion(consultor, propuesta.id, { canal: 'chat' }),
      ]) {
        expect(codigo(r)).toBe('HUMAN_CONFIRMATION_REQUIRED');
      }
      valor(
        await confirmarAccion(consultor, propuesta.id, { canal: 'ui', payloadHash: propuesta.payloadHash }),
      );
      expect(await contar('influencer_import_resolutions', 'record_id = $1', [registro.id])).toBe(0);
      const ejecutada = valor(await ejecutarAccion(consultor, propuesta.id, { canal: 'ui' }));
      expect(ejecutada.status).toBe('executed');

      // La decisión es atribuida a la persona que confirmó (no al agente).
      const [resolucion] = await query<{
        decided_by: string;
        decision: string;
        correlation: Record<string, string>;
      }>(`SELECT decided_by, decision, correlation FROM influencer_import_resolutions WHERE record_id = $1`, [
        registro.id,
      ]);
      expect(resolucion).toMatchObject({ decided_by: consultor.id, decision: 'use_existing_influencer' });
      expect(resolucion!.correlation).toEqual({ proposedActionId: propuesta.id });
      const [binding] = await query<{ bound_via: string; influencer_id: string; bound_by: string }>(
        `SELECT bound_via, influencer_id, bound_by FROM influencer_source_bindings WHERE source_id = $1`,
        [hoja.sourceId],
      );
      expect(binding).toMatchObject({
        bound_via: 'human_existing',
        influencer_id: existente,
        bound_by: consultor.id,
      });

      const eventos = await auditoriaDe(propuesta.id);
      expect(eventos.map((e) => e.action)).toEqual([
        'proposed_action.propose',
        'proposed_action.confirm',
        'proposed_action.execute',
      ]);
      expect(eventos[0]).toMatchObject({ origin: 'chat', actor_id: consultor.id });
      expect(eventos[0]!.correlation).toMatchObject({ ...CORRELACION, proposedActionId: propuesta.id });
      expect(eventos[2]!.metadata).toMatchObject({
        mode: 'idempotent_external',
        decision: 'use_existing_influencer',
      });
      const [evento] = await auditoriaDe(registro.id, 'influencer_import.record_resolve');
      expect(evento).toMatchObject({ origin: 'ui', actor_id: consultor.id });
      expect(evento!.correlation).toEqual({ proposedActionId: propuesta.id });
      expect(codigo(await ejecutarAccion(consultor, propuesta.id, { canal: 'ui' }))).toBe(
        'PROPOSAL_INVALID_STATE',
      );
    },
  );

  si(
    'la decisión que llega del modelo es entrada no confiable: se valida entera antes de proponer',
    async () => {
      const { existente, registro } = await escenarioDeResolucion('res_b');
      const malas: Record<string, unknown>[] = [
        {},
        { decision: { kind: 'otra_cosa' } },
        { decision: { kind: 'use_existing_influencer' } },
        { decision: { kind: 'use_existing_influencer', influencerId: 'no-uuid' } },
        { decision: { kind: 'use_existing_influencer', influencerId: existente, extra: 1 } },
        { decision: { kind: 'ignore_record', reason: 'x'.repeat(501) } },
        { decision: { kind: 'choose_product', productRef: 'P80' } },
        { decision: 'use_existing_influencer' },
        { decision: { kind: 'ignore_record' }, otraClave: true },
      ];
      for (const parametros of malas) {
        const r = await proponerImport('influencer_import.resolve_record', registro.id, { parametros });
        expect(codigo(r), JSON.stringify(parametros)).toBe('VALIDATION_FAILED');
      }
      expect(codigo(await proponerImport('influencer_import.resolve_record', registro.id))).toBe(
        'VALIDATION_FAILED',
      );
      // Un influencer de OTRA organización no se puede elegir (el recurso no existe para esta).
      const [ajenoInf] = await query<{ id: string }>(
        `INSERT INTO influencers (organization_id, display_name, created_by) VALUES ($1, $2, $3) RETURNING id`,
        [ajeno.organizationId, `Ajeno ${sufijo}`, ajeno.id],
      );
      influencers.push(ajenoInf!.id);
      expect(
        codigo(
          await proponerDecision(registro.id, {
            kind: 'use_existing_influencer',
            influencerId: ajenoInf!.id,
          }),
        ),
      ).toBe('RESOURCE_NOT_FOUND');
      // Las reglas de la decisión son las de resolverla: crear nuevo con cuenta existente es un conflicto.
      const conflicto = await proponerDecision(registro.id, {
        kind: 'choose_product',
        productRef: 'no-esta',
        campaignProductId: campana.cp['P80']!,
      });
      expect(codigo(conflicto)).toBe('VALIDATION_FAILED');
      expect(await contar('proposed_actions', `resource_id = $1`, [registro.id])).toBe(0);
    },
  );

  si('alcance y roles: otra campaña, otra organización, sistema, cliente y operativo', async () => {
    const { existente, registro } = await escenarioDeResolucion('res_c');
    const decision: ImportDecision = { kind: 'use_existing_influencer', influencerId: existente };
    expect(codigo(await proponerDecision(registro.id, decision, { campaignId: campanaOtra.id }))).toBe(
      'RESOURCE_NOT_FOUND',
    );
    expect(
      codigo(
        await proponerAccion(ajeno, {
          type: 'influencer_import.resolve_record',
          resourceId: registro.id,
          parametros: { decision },
        }),
      ),
    ).toBe('RESOURCE_NOT_FOUND');
    for (const actor of [cliente, operativo]) {
      expect(
        codigo(
          await proponerAccion(actor, {
            type: 'influencer_import.resolve_record',
            resourceId: registro.id,
            parametros: { decision },
          }),
        ),
        actor.role,
      ).toBe('FORBIDDEN_ROLE');
    }
    expect(
      codigo(
        await proponerAccion('system', {
          type: 'influencer_import.resolve_record',
          resourceId: registro.id,
          parametros: { decision },
        }),
      ),
    ).toBe('FORBIDDEN_ROLE');
    expect(await contar('proposed_actions', `resource_id = $1`, [registro.id])).toBe(0);
  });

  si(
    'la huella ata la decisión al estado del registro: otra resolución entre medias → PROPOSAL_STALE',
    async () => {
      const { existente, registro } = await escenarioDeResolucion('res_d');
      const propuesta = valor(
        await proponerDecision(registro.id, { kind: 'use_existing_influencer', influencerId: existente }),
      );
      // Otra persona ignora el registro por la UI.
      valor(
        await resolveImportRecord(director, registro.id, { kind: 'ignore_record', reason: 'Otro criterio' }),
      );
      expect(
        codigo(
          await confirmarAccion(consultor, propuesta.id, { canal: 'ui', payloadHash: propuesta.payloadHash }),
        ),
      ).toBe('PROPOSAL_STALE');
      expect(await estadoDeAccion(propuesta.id)).toBe('pending');
      expect(await contar('influencer_source_bindings', 'influencer_id = $1', [existente])).toBe(0);
    },
  );

  si('si otra persona decide sobre el registro ENTRE confirmar y ejecutar, la ejecución falla', async () => {
    const { existente, registro } = await escenarioDeResolucion('res_g');
    const propuesta = valor(
      await proponerDecision(registro.id, { kind: 'use_existing_influencer', influencerId: existente }),
    );
    valor(
      await confirmarAccion(consultor, propuesta.id, { canal: 'ui', payloadHash: propuesta.payloadHash }),
    );
    valor(await resolveImportRecord(director, registro.id, { kind: 'ignore_record', reason: 'Antes' }));
    expect(codigo(await ejecutarAccion(consultor, propuesta.id, { canal: 'ui' }))).toBe('PROPOSAL_STALE');
    expect(await estadoDeAccion(propuesta.id)).toBe('confirmed');
    expect(await contar('influencer_source_bindings', 'influencer_id = $1', [existente])).toBe(0);
  });

  si(
    'modo idempotent_external: una caída tras resolver deja confirmed y el reintento NO repite la resolución',
    async () => {
      const { existente, registro } = await escenarioDeResolucion('res_e');
      const propuesta = valor(
        await proponerDecision(registro.id, { kind: 'use_existing_influencer', influencerId: existente }),
      );
      valor(
        await confirmarAccion(consultor, propuesta.id, { canal: 'ui', payloadHash: propuesta.payloadHash }),
      );

      await conFalloAlMarcarExecuted(propuesta.id, async () => {
        await expect(ejecutarAccion(consultor, propuesta.id, { canal: 'ui' })).rejects.toThrow(
          /fallo inyectado/,
        );
      });
      expect(await estadoDeAccion(propuesta.id)).toBe('confirmed');
      expect(await contar('influencer_import_resolutions', 'record_id = $1', [registro.id])).toBe(1);
      expect(await contar('influencer_source_bindings', 'influencer_id = $1', [existente])).toBe(1);

      // El reintento reconcilia: no vuelve a decidir (las reglas de la decisión ya no aplican a un estado que ya la refleja).
      const reintento = await ejecutarAccion(consultor, propuesta.id, { canal: 'ui' });
      expect(reintento.ok, !reintento.ok ? reintento.error.message : '').toBe(true);
      expect(await estadoDeAccion(propuesta.id)).toBe('executed');
      expect(await contar('influencer_import_resolutions', 'record_id = $1', [registro.id])).toBe(1);
      expect(await contar('influencer_source_bindings', 'influencer_id = $1', [existente])).toBe(1);
      expect(
        await contar('audit_events', `entity_id = $1 AND action = 'influencer_import.record_resolve'`, [
          registro.id,
        ]),
      ).toBe(1);
    },
  );

  si(
    'la vía directa de la UI no cambia: resolver dos veces sin acción propuesta sigue registrando cada decisión',
    async () => {
      const { registro } = await escenarioDeResolucion('res_f');
      valor(await resolveImportRecord(consultor, registro.id, { kind: 'ignore_record', reason: 'Una' }));
      valor(await resolveImportRecord(consultor, registro.id, { kind: 'ignore_record', reason: 'Una' }));
      expect(await contar('influencer_import_resolutions', 'record_id = $1', [registro.id])).toBe(2);
    },
  );
});
