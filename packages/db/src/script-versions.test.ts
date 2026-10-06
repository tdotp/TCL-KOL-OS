/**
 * V2 · Fase 7 — versiones de guion (`ScriptVersion`), contra PostgreSQL real (migración 023).
 *
 * Registro con resolución inequívoca, numeración concurrente, matriz de estados contra la base,
 * una sola aprobada vigente, inmutabilidad, lecturas e inicio de la revisión. Todo sobre campañas,
 * influencers y fuentes sintéticos y desechables (INC-001A).
 */

import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  SCRIPT_VERSION_STATUSES,
  type Result,
  type ScriptVersionStatus,
  type User,
  canTransitionScriptVersion,
} from '@tcl-kol-os/domain';
import { asociarInfluencerACampana, retirarInfluencerDeCampana } from './campaign-influencers.ts';
import { closePool, getPool, query, transaction } from './client.ts';
import { archivarEntregable, crearEntregable } from './deliverables.ts';
import { crearInfluencer } from './influencers.ts';
import {
  type RegistrarVersionDeGuionInput,
  type RegistroDeGuion,
  iniciarRevisionDeVersion,
  iniciarRevisionDeVersionEnTransaccion,
  listarVersionesDeEntregable,
  obtenerUltimaVersion,
  obtenerVersionDeGuion,
  obtenerVersionVigente,
  registrarVersionDeGuion,
} from './script-versions.ts';
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

type Registrada = Extract<RegistroDeGuion, { kind: 'registered' }>;

const registrar = (
  actor: User,
  input: RegistrarVersionDeGuionInput,
  contexto?: Parameters<typeof registrarVersionDeGuion>[2],
) => registrarVersionDeGuion(actor, input, contexto);

/** Registra por ids (camino de la UI) y exige que sea una versión nueva. */
async function registrada(
  actor: User,
  sourceId: string,
  participationId: string,
  deliverableId: string,
): Promise<Registrada> {
  const r = valor(
    await registrar(actor, {
      campaignId: e.campanaId,
      sourceId,
      participation: { participationId },
      deliverable: { id: deliverableId },
    }),
  );
  if (r.kind !== 'registered') throw new Error(`se esperaba registered y fue ${r.kind}`);
  return r;
}

const fuente = (etiqueta: string, estado?: Parameters<typeof crearFuenteDeGuionDePrueba>[3]) =>
  crearFuenteDeGuionDePrueba(e.campanaId, e.admin, etiqueta, estado);

let secuencia = 0;
/** Entregable desechable de Diego con n versiones recibidas. */
async function entregableConVersiones(n: number): Promise<{ deliverableId: string; versiones: string[] }> {
  const d = valor(
    await crearEntregable(e.consultor, {
      campaignInfluencerId: e.participaciones.diego,
      label: `Desechable ${++secuencia}`,
    }),
  );
  const versiones: string[] = [];
  for (let i = 0; i < n; i++) {
    const r = await registrada(
      e.consultor,
      await fuente(`g-${secuencia}-${i}`),
      e.participaciones.diego,
      d.id,
    );
    versiones.push(r.version.id);
  }
  return { deliverableId: d.id, versiones };
}

/** Fija estados saltándose los triggers de transición (bypass restringido a bases `_test`). */
async function conBypass(fn: (c: pg.PoolClient) => Promise<void>): Promise<void> {
  await transaction(async (c) => {
    await c.query(`SET LOCAL tclkolos.permitir_borrado_historico = 'on'`);
    await fn(c);
  });
}

const fijarAprobada = (versionId: string, por: User = e.director) =>
  conBypass(async (c) => {
    await c.query(
      `UPDATE script_versions SET status = 'approved', approved_by = $2, approved_at = now() WHERE id = $1`,
      [versionId, por.id],
    );
  });

async function estado(versionId: string) {
  const [f] = await query<{
    status: ScriptVersionStatus;
    approved_by: string | null;
    approved_at: Date | null;
    superseded_by_version_id: string | null;
    version: number;
  }>(
    `SELECT status, approved_by, approved_at, superseded_by_version_id, version FROM script_versions WHERE id = $1`,
    [versionId],
  );
  return f!;
}

/** Ejecuta SQL y devuelve el mensaje del rechazo de la base ('' si pasó). */
async function rechazo(sql: string, params: unknown[] = []): Promise<string> {
  try {
    await query(sql, params);
    return '';
  } catch (error) {
    return (error as Error).message;
  }
}

const contar = async (tabla: 'script_versions' | 'deliverables', campaignId = e.campanaId): Promise<number> =>
  Number(
    (
      await query<{ n: string }>(`SELECT count(*)::text AS n FROM ${tabla} WHERE campaign_id = $1`, [
        campaignId,
      ])
    )[0]!.n,
  );

const auditoria = (accion: string, entidad: string) =>
  query<{
    origin: string;
    actor_id: string | null;
    metadata: Record<string, unknown>;
    correlation: Record<string, string> | null;
  }>(
    `SELECT origin, actor_id, metadata, correlation FROM audit_events WHERE action = $1 AND entity_id = $2 ORDER BY created_at`,
    [accion, entidad],
  );

beforeAll(async () => {
  e = await crearEscenarioDeContenido('F7 versiones de guion');
});
afterAll(async () => {
  await limpiarEscenarioDeContenido(e);
  await closePool();
});

// ─────────────────────────── Registro ──────────────────────────────────────────

describe('registrar una versión por ids (camino de la UI)', () => {
  it('nace V1 recibida con el nombre y el hash derivados de la fuente, y audita con la procedencia del chat', async () => {
    const f = await fuente('registro-basico');
    const msg = '33333333-3333-4333-8333-333333333333';
    const r = valor(
      await registrar(
        e.consultor,
        {
          campaignId: e.campanaId,
          sourceId: f,
          participation: { participationId: e.participaciones.diego },
          deliverable: { id: e.entregables.reelDiego },
        },
        { origin: 'chat', correlation: { messageId: msg } },
      ),
    );
    expect(r.kind).toBe('registered');
    if (r.kind !== 'registered') return;
    expect(r.version).toMatchObject({
      version: 1,
      status: 'received',
      deliverableId: e.entregables.reelDiego,
      sourceDocumentId: f,
      sourceFilename: 'registro-basico.md',
      createdBy: e.consultor.id,
    });
    const [fila] = await query<{ hash: string }>(`SELECT hash FROM source_documents WHERE id = $1`, [f]);
    expect(r.version.sourceHash).toBe(fila!.hash);
    expect(r.version.sourceHash).toMatch(/^[0-9a-f]{64}$/);
    expect(r.createdDeliverable).toBe(false);
    expect(r.deliverable.lastVersion).toBe(1);
    expect(r.sourceState).toBe('ready');

    const [ev] = await auditoria('script_version.register', r.version.id);
    expect(ev?.origin).toBe('chat');
    expect(ev?.correlation).toEqual({ messageId: msg });
    // metadata: ids, números y nombre de archivo; nunca texto de documentos
    expect(ev?.metadata).toEqual({
      campaignId: e.campanaId,
      deliverableId: e.entregables.reelDiego,
      version: 1,
      sourceId: f,
      filename: 'registro-basico.md',
      createdDeliverable: false,
    });
    expect(JSON.stringify(ev?.metadata)).not.toContain('Texto sintético');
  });

  it('la V2 se numera sola y no toca la V1 (nunca se sobrescribe)', async () => {
    const { deliverableId, versiones } = await entregableConVersiones(2);
    const v = await Promise.all(versiones.map(estado));
    expect(v.map((x) => [x.version, x.status])).toEqual([
      [1, 'received'],
      [2, 'received'],
    ]);
    const [d] = await query<{ last_version: number }>(`SELECT last_version FROM deliverables WHERE id = $1`, [
      deliverableId,
    ]);
    expect(d!.last_version).toBe(2);
  });

  it('el llamador no puede fijar el número: la base lo asigna aunque se pase por SQL directo', async () => {
    const { deliverableId } = await entregableConVersiones(1);
    const f = await fuente('numero-impuesto');
    const [fila] = await query<{ version: number; source_filename: string }>(
      `INSERT INTO script_versions (organization_id, campaign_id, deliverable_id, version, source_document_id,
                                    source_filename, source_hash, created_by)
       VALUES ($1, $2, $3, 99, $4, 'mentira.md', repeat('a', 64), $5) RETURNING version, source_filename`,
      [e.admin.organizationId, e.campanaId, deliverableId, f, e.consultor.id],
    );
    expect(fila).toEqual({ version: 2, source_filename: 'numero-impuesto.md' });
  });
});

describe('participación inequívoca por mención (nunca elige «la primera»)', () => {
  it('«Valentina» con dos participantes: needs_choice con los candidatos y SIN ningún efecto', async () => {
    const f = await fuente('ambigua');
    const antes = { v: await contar('script_versions'), d: await contar('deliverables') };
    const [eventosAntes] = await query<{ n: string }>(
      `SELECT count(*)::text AS n FROM audit_events WHERE action LIKE 'script_version.%' OR action LIKE 'deliverable.%'`,
    );
    const r = valor(
      await registrar(e.consultor, {
        campaignId: e.campanaId,
        sourceId: f,
        participation: { mention: 'Valentina' },
        deliverable: { label: 'Reel principal' },
      }),
    );
    expect(r.kind).toBe('needs_choice');
    if (r.kind !== 'needs_choice') return;
    expect(r.reason).toBe('participation_ambiguous');
    if (r.reason !== 'participation_ambiguous') return;
    expect(r.candidates.map((c) => c.campaignInfluencerId).sort()).toEqual(
      [e.participaciones.valentinaRios, e.participaciones.valentinaGomez].sort(),
    );
    const rios = r.candidates.find((c) => c.campaignInfluencerId === e.participaciones.valentinaRios)!;
    expect(rios.displayName).toBe('Valentina Ríos');
    expect(rios.accounts[0]?.platform).toBe('instagram');
    expect(rios.products).toEqual(expect.arrayContaining([expect.stringContaining('P80')]));
    expect(rios.deliverables.map((d) => d.label)).toEqual(
      expect.arrayContaining(['Reel principal', 'Story de lanzamiento']),
    );
    // sin efecto
    expect(await contar('script_versions')).toBe(antes.v);
    expect(await contar('deliverables')).toBe(antes.d);
    const [eventosDespues] = await query<{ n: string }>(
      `SELECT count(*)::text AS n FROM audit_events WHERE action LIKE 'script_version.%' OR action LIKE 'deliverable.%'`,
    );
    expect(eventosDespues!.n).toBe(eventosAntes!.n);
  });

  it('una desambiguación inequívoca (apellido, handle o producto) registra en la elegida', async () => {
    const f = await fuente('desambiguada');
    const r = valor(
      await registrar(e.consultor, {
        campaignId: e.campanaId,
        sourceId: f,
        participation: { mention: 'Valentina', disambiguation: 'Gómez' },
        deliverable: { id: e.entregables.reelGomez },
      }),
    );
    expect(r.kind).toBe('registered');
    if (r.kind === 'registered')
      expect(r.deliverable.campaignInfluencerId).toBe(e.participaciones.valentinaGomez);
  });

  it('el participationId solo vale si es EXACTAMENTE el elegido: no es una forma de saltarse la mención', async () => {
    const f = await fuente('id-no-coincide');
    const casos: Array<{ mention: string; disambiguation?: string; participationId: string }> = [
      // la mención + desambiguación eligen a Ríos, el id dice Gómez
      { mention: 'Valentina', disambiguation: 'Ríos', participationId: e.participaciones.valentinaGomez },
      // el id es de alguien que ni coincide con la mención
      { mention: 'Diego', participationId: e.participaciones.valentinaRios },
    ];
    for (const caso of casos) {
      const r = await registrar(e.consultor, {
        campaignId: e.campanaId,
        sourceId: f,
        participation: caso,
        deliverable: { label: 'Reel principal' },
      });
      expect(codigo(r), JSON.stringify(caso)).toBe('VALIDATION_FAILED');
      expect(razon(r)).toBe('participation_mismatch');
    }
    // con el id correcto pero SIN desambiguación sigue siendo ambigua (el id no desempata)
    const sinDesambiguar = valor(
      await registrar(e.consultor, {
        campaignId: e.campanaId,
        sourceId: f,
        participation: { mention: 'Valentina', participationId: e.participaciones.valentinaRios },
        deliverable: { label: 'Reel principal' },
      }),
    );
    expect(sinDesambiguar.kind).toBe('needs_choice');
    expect(await contar('script_versions')).toBeGreaterThan(0);
    expect(
      (
        await query<{ n: string }>(
          `SELECT count(*)::text AS n FROM script_versions WHERE source_document_id = $1`,
          [f],
        )
      )[0]!.n,
    ).toBe('0');
  });

  it('una mención sin coincidencias: needs_choice participation_not_found, sin efecto', async () => {
    const f = await fuente('no-existe');
    const r = valor(
      await registrar(e.consultor, {
        campaignId: e.campanaId,
        sourceId: f,
        participation: { mention: 'Camila' },
      }),
    );
    expect(r).toMatchObject({ kind: 'needs_choice', reason: 'participation_not_found', candidates: [] });
  });

  it('sin mención ni id es un error de validación; un id de otra campaña es inexistente', async () => {
    const f = await fuente('sin-participacion');
    expect(
      codigo(await registrar(e.consultor, { campaignId: e.campanaId, sourceId: f, participation: {} })),
    ).toBe('VALIDATION_FAILED');
    // participación de OTRA campaña de la misma agencia
    const creado = valor(await crearInfluencer(e.admin, { displayName: 'Fernanda Otra Campaña' }));
    e.influencerIds.push(creado.influencer.id);
    const otra = valor(
      await asociarInfluencerACampana(e.admin, {
        campaignId: e.otraCampanaId,
        influencerId: creado.influencer.id,
      }),
    );
    expect(
      codigo(
        await registrar(e.consultor, {
          campaignId: e.campanaId,
          sourceId: f,
          participation: { participationId: otra.id },
          deliverable: { label: 'X' },
        }),
      ),
    ).toBe('RESOURCE_NOT_FOUND');
  });
});

describe('entregable inequívoco (nunca inventa estructura)', () => {
  it('un solo entregable activo y sin etiqueta: es ese', async () => {
    const creado = valor(await crearInfluencer(e.admin, { displayName: 'Bruno Único Entregable' }));
    e.influencerIds.push(creado.influencer.id);
    const ci = valor(
      await asociarInfluencerACampana(e.admin, {
        campaignId: e.campanaId,
        influencerId: creado.influencer.id,
      }),
    );
    const d = valor(
      await crearEntregable(e.consultor, { campaignInfluencerId: ci.id, label: 'La única pieza' }),
    );
    const f = await fuente('unico');
    const r = valor(
      await registrar(e.consultor, {
        campaignId: e.campanaId,
        sourceId: f,
        participation: { mention: 'bruno unico' },
      }),
    );
    expect(r.kind).toBe('registered');
    if (r.kind === 'registered') expect(r.deliverable.id).toBe(d.id);
  });

  it('varios entregables y sin etiqueta: needs_choice con la lista, sin efecto', async () => {
    const f = await fuente('varios');
    const antes = await contar('script_versions');
    const r = valor(
      await registrar(e.consultor, {
        campaignId: e.campanaId,
        sourceId: f,
        participation: { participationId: e.participaciones.valentinaRios },
      }),
    );
    expect(r.kind).toBe('needs_choice');
    if (r.kind !== 'needs_choice' || !('participation' in r)) return;
    expect(r.reason).toBe('deliverable_ambiguous');
    expect(r.candidates.map((c) => c.label).sort()).toEqual(['Reel principal', 'Story de lanzamiento']);
    expect(r.participation.displayName).toBe('Valentina Ríos');
    expect(await contar('script_versions')).toBe(antes);
  });

  it('una participación sin entregables y sin etiqueta: deliverable_required (no se inventa «Entregable principal»)', async () => {
    const creado = valor(await crearInfluencer(e.admin, { displayName: 'Gabriela Sin Entregables' }));
    e.influencerIds.push(creado.influencer.id);
    const ci = valor(
      await asociarInfluencerACampana(e.admin, {
        campaignId: e.campanaId,
        influencerId: creado.influencer.id,
      }),
    );
    const f = await fuente('sin-entregables');
    const antes = await contar('deliverables');
    const r = valor(
      await registrar(e.consultor, {
        campaignId: e.campanaId,
        sourceId: f,
        participation: { participationId: ci.id },
      }),
    );
    expect(r).toMatchObject({ kind: 'needs_choice', reason: 'deliverable_required', candidates: [] });
    expect(await contar('deliverables')).toBe(antes);
  });

  it('etiqueta literal que coincide (normalizada): usa el existente', async () => {
    const f = await fuente('etiqueta-igual');
    const r = valor(
      await registrar(e.consultor, {
        campaignId: e.campanaId,
        sourceId: f,
        participation: { participationId: e.participaciones.valentinaRios },
        deliverable: { label: '  REEL   principal ' },
      }),
    );
    expect(r.kind).toBe('registered');
    if (r.kind === 'registered') {
      expect(r.deliverable.id).toBe(e.entregables.reelRios);
      expect(r.createdDeliverable).toBe(false);
    }
  });

  it('etiqueta literal sin nada igual ni parecido: crea el entregable y registra, auditando ambos', async () => {
    const f = await fuente('etiqueta-nueva');
    const msg = '44444444-4444-4444-8444-444444444444';
    const r = valor(
      await registrar(
        e.consultor,
        {
          campaignId: e.campanaId,
          sourceId: f,
          participation: { mention: 'diego' },
          deliverable: { label: 'Unboxing en YouTube' },
        },
        { origin: 'chat', correlation: { messageId: msg } },
      ),
    );
    expect(r.kind).toBe('registered');
    if (r.kind !== 'registered') return;
    expect(r.createdDeliverable).toBe(true);
    expect(r.deliverable).toMatchObject({ label: 'Unboxing en YouTube', lastVersion: 1, status: 'active' });
    expect(r.version.version).toBe(1);
    const creado = await auditoria('deliverable.create', r.deliverable.id);
    expect(creado[0]).toMatchObject({ origin: 'chat', correlation: { messageId: msg } });
    expect(await auditoria('script_version.register', r.version.id)).toHaveLength(1);
  });

  it('una etiqueta PARECIDA a una existente («Reel pricipal»): pregunta, no duplica', async () => {
    const f = await fuente('etiqueta-parecida');
    const antes = await contar('deliverables');
    const r = valor(
      await registrar(e.consultor, {
        campaignId: e.campanaId,
        sourceId: f,
        participation: { participationId: e.participaciones.valentinaRios },
        deliverable: { label: 'Reel pricipal' },
      }),
    );
    expect(r.kind).toBe('needs_choice');
    if (r.kind !== 'needs_choice' || !('participation' in r)) return;
    expect(r.reason).toBe('deliverable_ambiguous');
    expect(r.candidates.map((c) => c.label)).toEqual(['Reel principal']);
    expect(await contar('deliverables')).toBe(antes);
  });

  it('un entregable por id debe ser de ESA participación y estar activo', async () => {
    const f = await fuente('entregable-ajeno');
    const deOtra = await registrar(e.consultor, {
      campaignId: e.campanaId,
      sourceId: f,
      participation: { participationId: e.participaciones.diego },
      deliverable: { id: e.entregables.reelRios },
    });
    expect(codigo(deOtra)).toBe('RESOURCE_NOT_FOUND');

    const archivado = valor(
      await crearEntregable(e.consultor, {
        campaignInfluencerId: e.participaciones.diego,
        label: 'Se archiva',
      }),
    );
    valor(await archivarEntregable(e.consultor, archivado.id));
    const r = await registrar(e.consultor, {
      campaignId: e.campanaId,
      sourceId: f,
      participation: { participationId: e.participaciones.diego },
      deliverable: { id: archivado.id },
    });
    expect(razon(r)).toBe('deliverable_archived');
  });
});

describe('deduplicación por fuente', () => {
  it('reenviar el mismo archivo devuelve la versión existente (deduplicated), nunca la N+1', async () => {
    const { deliverableId, versiones } = await entregableConVersiones(1);
    const [v1] = await query<{ source_document_id: string }>(
      `SELECT source_document_id FROM script_versions WHERE id = $1`,
      [versiones[0]],
    );
    const antes = await contar('script_versions');
    const r = valor(
      await registrar(e.consultor, {
        campaignId: e.campanaId,
        sourceId: v1!.source_document_id,
        participation: { participationId: e.participaciones.diego },
        deliverable: { id: deliverableId },
      }),
    );
    expect(r.kind).toBe('deduplicated');
    if (r.kind !== 'deduplicated') return;
    expect(r.version.id).toBe(versiones[0]);
    expect(r.deliverable.lastVersion).toBe(1);
    expect(await contar('script_versions')).toBe(antes);
    // aunque la persona no diga ya a quién pertenece, no se pregunta de nuevo
    const sinDatos = valor(
      await registrar(e.consultor, {
        campaignId: e.campanaId,
        sourceId: v1!.source_document_id,
        participation: { mention: 'Valentina' },
      }),
    );
    expect(sinDatos.kind).toBe('deduplicated');
  });

  it('cinco registros simultáneos de la MISMA fuente: una versión y el resto deduplicated (sin errores)', async () => {
    const d = valor(
      await crearEntregable(e.consultor, {
        campaignInfluencerId: e.participaciones.diego,
        label: 'Dedupe concurrente',
      }),
    );
    const f = await fuente('dedupe-concurrente');
    const rs = await Promise.all(
      [1, 2, 3, 4, 5].map(() =>
        registrar(e.consultor, {
          campaignId: e.campanaId,
          sourceId: f,
          participation: { participationId: e.participaciones.diego },
          deliverable: { id: d.id },
        }),
      ),
    );
    const kinds = rs.map((r) => valor(r).kind);
    expect(kinds.filter((k) => k === 'registered')).toHaveLength(1);
    expect(kinds.filter((k) => k === 'deduplicated')).toHaveLength(4);
    expect(
      (
        await query<{ n: string }>(
          `SELECT count(*)::text AS n FROM script_versions WHERE deliverable_id = $1`,
          [d.id],
        )
      )[0]!.n,
    ).toBe('1');
  });
});

describe('la fuente del guion', () => {
  it('una fuente en cola o fallida SÍ se registra (el original queda preservado) y informa su estado', async () => {
    const enCola = valor(
      await registrar(e.consultor, {
        campaignId: e.campanaId,
        sourceId: e.fuentes.enCola,
        participation: { participationId: e.participaciones.valentinaRios },
        deliverable: { id: e.entregables.storyRios },
      }),
    );
    expect(enCola).toMatchObject({ kind: 'registered', sourceState: 'queued' });
    const fallida = valor(
      await registrar(e.consultor, {
        campaignId: e.campanaId,
        sourceId: e.fuentes.fallida,
        participation: { participationId: e.participaciones.valentinaRios },
        deliverable: { id: e.entregables.storyRios },
      }),
    );
    expect(fallida).toMatchObject({ kind: 'registered', sourceState: 'failed' });
  });

  it('una fuente sensible (restringida) no existe para esta operación', async () => {
    const r = await registrar(e.consultor, {
      campaignId: e.campanaId,
      sourceId: e.fuentes.sensible,
      participation: { participationId: e.participaciones.diego },
      deliverable: { id: e.entregables.reelDiego },
    });
    expect(codigo(r)).toBe('RESOURCE_NOT_FOUND');
  });

  it('una fuente de otra campaña o de otra organización no existe; un enlace no es un guion', async () => {
    const deOtraCampana = await crearFuenteDeGuionDePrueba(e.otraCampanaId, e.admin, 'fuente-otra-campana');
    const deOtraOrg = await crearFuenteDeGuionDePrueba(e.campanaAjenaId, e.ajeno, 'fuente-otra-org');
    for (const sourceId of [deOtraCampana, deOtraOrg, '55555555-5555-4555-8555-555555555555']) {
      const r = await registrar(e.consultor, {
        campaignId: e.campanaId,
        sourceId,
        participation: { participationId: e.participaciones.diego },
        deliverable: { id: e.entregables.reelDiego },
      });
      expect(codigo(r), sourceId).toBe('RESOURCE_NOT_FOUND');
    }

    const [enlace] = await query<{ id: string }>(
      `INSERT INTO source_documents (campaign_id, organization_id, type, filename, status, created_by, origin,
                                     external_provider, external_id, external_url, canonical_url)
       VALUES ($1, $2, 'otro', 'Guion en Google Docs', 'por_resolver', $3, 'link', 'google_docs', $4,
               'https://docs.google.com/document/d/x', $5) RETURNING id`,
      [
        e.campanaId,
        e.admin.organizationId,
        e.admin.id,
        `doc-${e.sufijo}`,
        `https://docs.google.com/d/${e.sufijo}`,
      ],
    );
    const r = await registrar(e.consultor, {
      campaignId: e.campanaId,
      sourceId: enlace!.id,
      participation: { participationId: e.participaciones.diego },
      deliverable: { id: e.entregables.reelDiego },
    });
    expect(codigo(r)).toBe('VALIDATION_FAILED');
    expect(razon(r)).toBe('source_not_file');
  });

  it('una fuente ya visible para TCL no se usa como guion hasta bajarla a interna', async () => {
    const f = await fuente('visible-tcl');
    await query(`UPDATE source_documents SET visibility = 'tcl' WHERE id = $1`, [f]);
    const r = await registrar(e.consultor, {
      campaignId: e.campanaId,
      sourceId: f,
      participation: { participationId: e.participaciones.diego },
      deliverable: { id: e.entregables.reelDiego },
    });
    expect(codigo(r)).toBe('RESOURCE_CONFLICT');
    expect(razon(r)).toBe('source_visible_to_tcl');
  });
});

describe('participación retirada y campaña no activa', () => {
  it('retirada: no se registran versiones (y por SQL directo tampoco); reactivar reanuda', async () => {
    const creado = valor(await crearInfluencer(e.admin, { displayName: 'Hilda Retirada' }));
    e.influencerIds.push(creado.influencer.id);
    const ci = valor(
      await asociarInfluencerACampana(e.admin, {
        campaignId: e.campanaId,
        influencerId: creado.influencer.id,
      }),
    );
    const d = valor(
      await crearEntregable(e.consultor, { campaignInfluencerId: ci.id, label: 'Pieza de Hilda' }),
    );
    const f1 = await fuente('hilda-1');
    await registrada(e.consultor, f1, ci.id, d.id);
    valor(await retirarInfluencerDeCampana(e.admin, ci.id));

    const f2 = await fuente('hilda-2');
    const r = await registrar(e.consultor, {
      campaignId: e.campanaId,
      sourceId: f2,
      participation: { participationId: ci.id },
      deliverable: { id: d.id },
    });
    expect(razon(r)).toBe('campaign_influencer_retired');
    expect(
      await rechazo(
        `INSERT INTO script_versions (organization_id, campaign_id, deliverable_id, source_document_id, created_by)
         VALUES ($1, $2, $3, $4, $5)`,
        [e.admin.organizationId, e.campanaId, d.id, f2, e.consultor.id],
      ),
    ).toMatch(/influencer retirado/);
    // las lecturas siguen
    expect(valor(await listarVersionesDeEntregable(e.consultor, d.id)).items).toHaveLength(1);
  });

  it('campaña archivada: no se registran versiones (caso de uso y SQL directo); las lecturas siguen', async () => {
    const creado = valor(await crearInfluencer(e.admin, { displayName: 'Irene Campaña B' }));
    e.influencerIds.push(creado.influencer.id);
    const ci = valor(
      await asociarInfluencerACampana(e.admin, {
        campaignId: e.otraCampanaId,
        influencerId: creado.influencer.id,
      }),
    );
    const d = valor(
      await crearEntregable(e.consultor, { campaignInfluencerId: ci.id, label: 'Pieza de Irene' }),
    );
    const f = await crearFuenteDeGuionDePrueba(e.otraCampanaId, e.admin, 'irene-1');
    await query(`UPDATE campaigns SET status = 'archivada' WHERE id = $1`, [e.otraCampanaId]);
    const r = await registrar(e.consultor, {
      campaignId: e.otraCampanaId,
      sourceId: f,
      participation: { participationId: ci.id },
      deliverable: { id: d.id },
    });
    expect(razon(r)).toBe('campaign_not_active');
    expect(
      await rechazo(
        `INSERT INTO script_versions (organization_id, campaign_id, deliverable_id, source_document_id, created_by)
         VALUES ($1, $2, $3, $4, $5)`,
        [e.admin.organizationId, e.otraCampanaId, d.id, f, e.consultor.id],
      ),
    ).toMatch(/Campaña no activa/);
    expect(valor(await listarVersionesDeEntregable(e.consultor, d.id)).items).toHaveLength(0);
    await query(`UPDATE campaigns SET status = 'activa' WHERE id = $1`, [e.otraCampanaId]);
  });
});

// ─────────────────────────── Numeración concurrente ────────────────────────────

describe('numeración', () => {
  it('20 registros simultáneos: números 1..20 sin huecos ni duplicados y last_version = MAX', async () => {
    const d = valor(
      await crearEntregable(e.consultor, {
        campaignInfluencerId: e.participaciones.diego,
        label: 'Veinte a la vez',
      }),
    );
    const fuentes = await Promise.all(Array.from({ length: 20 }, (_, i) => fuente(`veinte-${i}`)));
    const rs = await Promise.all(
      fuentes.map((sourceId) =>
        registrar(e.consultor, {
          campaignId: e.campanaId,
          sourceId,
          participation: { participationId: e.participaciones.diego },
          deliverable: { id: d.id },
        }),
      ),
    );
    for (const r of rs) expect(valor(r).kind).toBe('registered');
    const filas = await query<{ version: number }>(
      `SELECT version FROM script_versions WHERE deliverable_id = $1 ORDER BY version`,
      [d.id],
    );
    expect(filas.map((f) => f.version)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    const [dd] = await query<{ last_version: number }>(
      `SELECT last_version FROM deliverables WHERE id = $1`,
      [d.id],
    );
    expect(dd!.last_version).toBe(20);
  });

  it('un rollback no consume número: la siguiente versión es la consecutiva', async () => {
    const { deliverableId } = await entregableConVersiones(2);
    const f = await fuente('rollback');
    await expect(
      transaction(async (c) => {
        await c.query(
          `INSERT INTO script_versions (organization_id, campaign_id, deliverable_id, source_document_id, created_by)
           VALUES ($1, $2, $3, $4, $5)`,
          [e.admin.organizationId, e.campanaId, deliverableId, f, e.consultor.id],
        );
        throw new Error('rollback deliberado');
      }),
    ).rejects.toThrow('rollback deliberado');
    const [d] = await query<{ last_version: number }>(`SELECT last_version FROM deliverables WHERE id = $1`, [
      deliverableId,
    ]);
    expect(d!.last_version).toBe(2);
    const r = await registrada(e.consultor, f, e.participaciones.diego, deliverableId);
    expect(r.version.version).toBe(3);
  });

  it('la misma fuente como última versión del mismo entregable la rechaza la base (red de seguridad)', async () => {
    const { deliverableId, versiones } = await entregableConVersiones(1);
    const [v1] = await query<{ source_document_id: string }>(
      `SELECT source_document_id FROM script_versions WHERE id = $1`,
      [versiones[0]],
    );
    expect(
      await rechazo(
        `INSERT INTO script_versions (organization_id, campaign_id, deliverable_id, source_document_id, created_by)
         VALUES ($1, $2, $3, $4, $5)`,
        [e.admin.organizationId, e.campanaId, deliverableId, v1!.source_document_id, e.consultor.id],
      ),
    ).toMatch(/mismo contenido/);
  });
});

// ─────────────────────────── Estados contra la base ────────────────────────────

describe('máquina de estados: matriz 5×5 contra Postgres', () => {
  /** Intenta `desde → hacia` sobre una versión fijada en `desde`; siempre deshace. '' si la base lo acepta. */
  async function intentar(desde: ScriptVersionStatus, hacia: ScriptVersionStatus): Promise<string> {
    const { versiones } = await entregableConVersiones(2);
    const [v1, v2] = versiones as [string, string];
    await conBypass(async (c) => {
      if (desde === 'approved') {
        await c.query(
          `UPDATE script_versions SET status = 'approved', approved_by = $2, approved_at = now() WHERE id = $1`,
          [v1, e.director.id],
        );
      } else if (desde === 'superseded') {
        await c.query(
          `UPDATE script_versions SET status = 'superseded', superseded_by_version_id = $2, superseded_at = now() WHERE id = $1`,
          [v1, v2],
        );
      } else if (desde !== 'received') {
        await c.query(`UPDATE script_versions SET status = $2 WHERE id = $1`, [v1, desde]);
      }
    });
    const c = await getPool().connect();
    try {
      await c.query('BEGIN');
      if (hacia === 'approved') {
        await c.query(`UPDATE script_versions SET status = 'approved', approved_by = $2 WHERE id = $1`, [
          v1,
          e.director.id,
        ]);
      } else if (hacia === 'superseded') {
        await c.query(
          `UPDATE script_versions SET status = 'superseded', superseded_by_version_id = $2 WHERE id = $1`,
          [v1, v2],
        );
      } else {
        await c.query(`UPDATE script_versions SET status = $2 WHERE id = $1`, [v1, hacia]);
      }
      return '';
    } catch (error) {
      return (error as Error).message;
    } finally {
      await c.query('ROLLBACK');
      c.release();
    }
  }

  it('las 20 transiciones entre estados distintos: la base acepta exactamente las de SCRIPT_VERSION_TRANSITIONS', async () => {
    for (const desde of SCRIPT_VERSION_STATUSES) {
      for (const hacia of SCRIPT_VERSION_STATUSES) {
        if (desde === hacia) continue;
        const mensaje = await intentar(desde, hacia);
        expect(mensaje === '', `${desde} → ${hacia}: ${mensaje || 'aceptada'}`).toBe(
          canTransitionScriptVersion(desde, hacia),
        );
      }
    }
  });

  it('la diagonal: un UPDATE sin cambio de estado pasa en los abiertos y se rechaza en aprobada y reemplazada', async () => {
    for (const s of SCRIPT_VERSION_STATUSES) {
      const mensaje = await intentar(s, s);
      const rechazada = s === 'approved' || s === 'superseded';
      expect(mensaje !== '', `${s} → ${s}`).toBe(rechazada);
    }
  });

  it('changes_requested es terminal: ni in_review ni superseded, ni siquiera con sucesora aprobada', async () => {
    expect(await intentar('changes_requested', 'in_review')).toMatch(/no válida/);
    expect(await intentar('changes_requested', 'superseded')).toMatch(/no válida/);
  });
});

describe('una sola versión aprobada vigente', () => {
  it('dos approved por SQL directo violan el índice único parcial', async () => {
    const { versiones } = await entregableConVersiones(2);
    await fijarAprobada(versiones[0]!);
    // la segunda llega a approved por el camino normal (in_review → approved) y choca con el índice
    await conBypass(async (c) => {
      await c.query(`UPDATE script_versions SET status = 'in_review' WHERE id = $1`, [versiones[1]]);
    });
    const mensaje = await rechazo(
      `UPDATE script_versions SET status = 'approved', approved_by = $2 WHERE id = $1`,
      [versiones[1], e.director.id],
    );
    expect(mensaje).toMatch(/script_versions_aprobada_vigente_key|duplicate key/);
  });

  it('aprobar V2 reemplaza a la V1 aprobada: V1 queda superseded con sus marcas de aprobación intactas', async () => {
    const { versiones } = await entregableConVersiones(2);
    await fijarAprobada(versiones[0]!);
    await conBypass(async (c) => {
      await c.query(`UPDATE script_versions SET status = 'in_review' WHERE id = $1`, [versiones[1]]);
    });
    const antes = await estado(versiones[0]!);
    await transaction(async (c) => {
      // orden de la aplicación: primero la anterior pasa a superseded, luego se aprueba la nueva
      await c.query(
        `UPDATE script_versions SET status = 'superseded', superseded_by_version_id = $2 WHERE id = $1`,
        [versiones[0], versiones[1]],
      );
      await c.query(`UPDATE script_versions SET status = 'approved', approved_by = $2 WHERE id = $1`, [
        versiones[1],
        e.director.id,
      ]);
    });
    const v1 = await estado(versiones[0]!);
    const v2 = await estado(versiones[1]!);
    expect(v1.status).toBe('superseded');
    expect(v1.approved_at?.toISOString()).toBe(antes.approved_at?.toISOString());
    expect(v1.approved_by).toBe(antes.approved_by);
    expect(v1.superseded_by_version_id).toBe(versiones[1]);
    expect(v2.status).toBe('approved');
    expect(v2.approved_by).toBe(e.director.id);
    expect(v2.approved_at).not.toBeNull();
  });

  it('no se aprueba hacia atrás: con V3 aprobada, V1 y V2 no se pueden aprobar', async () => {
    const { versiones } = await entregableConVersiones(3);
    await fijarAprobada(versiones[2]!);
    await conBypass(async (c) => {
      await c.query(`UPDATE script_versions SET status = 'in_review' WHERE id = ANY($1::uuid[])`, [
        [versiones[0], versiones[1]],
      ]);
    });
    for (const v of [versiones[0], versiones[1]]) {
      expect(
        await rechazo(`UPDATE script_versions SET status = 'approved', approved_by = $2 WHERE id = $1`, [
          v,
          e.admin.id,
        ]),
      ).toMatch(/hacia atrás/);
    }
    // tampoco después de que V3 pase a superseded por una V4 aprobada (el hecho «V3 fue aprobada» persiste)
  });

  it('con una V3 reemplazada, V2 (anterior) sigue sin poder aprobarse', async () => {
    const { versiones } = await entregableConVersiones(3);
    await conBypass(async (c) => {
      await c.query(`UPDATE script_versions SET status = 'in_review' WHERE id = ANY($1::uuid[])`, [
        [versiones[1], versiones[2]],
      ]);
      await c.query(
        `UPDATE script_versions SET status = 'approved', approved_by = $2, approved_at = now() WHERE id = $1`,
        [versiones[2], e.director.id],
      );
    });
    expect(
      await rechazo(`UPDATE script_versions SET status = 'approved', approved_by = $2 WHERE id = $1`, [
        versiones[1],
        e.admin.id,
      ]),
    ).toMatch(/hacia atrás/);
  });

  it('reemplazar una versión exige que su sucesora quede aprobada al cerrar la transacción', async () => {
    const { versiones } = await entregableConVersiones(2);
    await fijarAprobada(versiones[0]!);
    // V1 → superseded con V2 solo recibida: el COMMIT falla (la versión más nueva nunca queda reemplazada)
    await expect(
      transaction(async (c) => {
        await c.query(
          `UPDATE script_versions SET status = 'superseded', superseded_by_version_id = $2 WHERE id = $1`,
          [versiones[0], versiones[1]],
        );
      }),
    ).rejects.toThrow(/sucesora no quedó aprobada/);
    expect((await estado(versiones[0]!)).status).toBe('approved');
  });

  it('la sucesora debe ser una versión POSTERIOR del mismo entregable', async () => {
    const a = await entregableConVersiones(2);
    const b = await entregableConVersiones(1);
    await fijarAprobada(a.versiones[1]!);
    // hacia una versión anterior
    expect(
      await rechazo(
        `UPDATE script_versions SET status = 'superseded', superseded_by_version_id = $2 WHERE id = $1`,
        [a.versiones[1], a.versiones[0]],
      ),
    ).toMatch(/sucesora debe ser una versión posterior/);
    // hacia una versión de otro entregable (la FK compuesta lo impide)
    expect(
      await rechazo(
        `UPDATE script_versions SET status = 'superseded', superseded_by_version_id = $2 WHERE id = $1`,
        [a.versiones[1], b.versiones[0]],
      ),
    ).not.toBe('');
  });
});

describe('aprobar: quién, con qué fuente y por qué acción propuesta (la base)', () => {
  async function enRevision(): Promise<string> {
    const { versiones } = await entregableConVersiones(1);
    await conBypass(async (c) => {
      await c.query(`UPDATE script_versions SET status = 'in_review' WHERE id = $1`, [versiones[0]]);
    });
    return versiones[0]!;
  }

  it('solo admin y director aprueban: consultor, operativo, analista, legal, cliente y otra agencia, no', async () => {
    const v = await enRevision();
    for (const intruso of [e.consultor, e.operativo, e.analista, e.legal, e.cliente, e.ajeno]) {
      const mensaje = await rechazo(
        `UPDATE script_versions SET status = 'approved', approved_by = $2 WHERE id = $1`,
        [v, intruso.id],
      );
      expect(mensaje, intruso.role).not.toBe('');
    }
    expect((await estado(v)).status).toBe('in_review');
    expect(
      await rechazo(`UPDATE script_versions SET status = 'approved', approved_by = $2 WHERE id = $1`, [
        v,
        e.director.id,
      ]),
    ).toBe('');
  });

  it('aprobar sin aprobador es imposible (CHECK) y un aprobador de otra organización lo rechaza la FK', async () => {
    const v = await enRevision();
    expect(await rechazo(`UPDATE script_versions SET status = 'approved' WHERE id = $1`, [v])).not.toBe('');
    expect(
      await rechazo(`UPDATE script_versions SET status = 'approved', approved_by = $2 WHERE id = $1`, [
        v,
        e.ajeno.id,
      ]),
    ).not.toBe('');
  });

  it('si el original de la fuente cambió (hash), no se aprueba', async () => {
    const v = await enRevision();
    const c = await getPool().connect();
    try {
      await c.query('BEGIN');
      // defensa en profundidad: aunque el trigger de la fuente estuviera apagado, la versión lo detecta
      await c.query(`ALTER TABLE source_documents DISABLE TRIGGER source_documents_guion_guarda`);
      await c.query(
        `UPDATE source_documents SET hash = repeat('b', 64) WHERE id = (SELECT source_document_id FROM script_versions WHERE id = $1)`,
        [v],
      );
      await expect(
        c.query(`UPDATE script_versions SET status = 'approved', approved_by = $2 WHERE id = $1`, [
          v,
          e.director.id,
        ]),
      ).rejects.toThrow(/original de la fuente cambió/);
    } finally {
      await c.query('ROLLBACK');
      c.release();
    }
  });

  it('entregable archivado, participación retirada o campaña no activa: no se transiciona', async () => {
    const v = await enRevision();
    const [{ deliverable_id } = { deliverable_id: '' }] = await query<{ deliverable_id: string }>(
      `SELECT deliverable_id FROM script_versions WHERE id = $1`,
      [v],
    );
    valor(await archivarEntregable(e.consultor, deliverable_id));
    expect(
      await rechazo(`UPDATE script_versions SET status = 'changes_requested' WHERE id = $1`, [v]),
    ).toMatch(/archivado/);
    expect(
      await rechazo(`UPDATE script_versions SET status = 'approved', approved_by = $2 WHERE id = $1`, [
        v,
        e.director.id,
      ]),
    ).toMatch(/archivado/);
    expect((await estado(v)).status).toBe('in_review');
  });

  describe('si se aprueba vía una acción propuesta (HITL)', () => {
    async function accion(
      versionId: string,
      opciones: { tipo?: string; recurso?: string; confirmarPor?: User | null } = {},
    ): Promise<string> {
      const [pa] = await query<{ id: string }>(
        `INSERT INTO proposed_actions (organization_id, campaign_id, action_type, resource_type, resource_id,
                                       payload, payload_hash, proposed_origin, proposed_by, expires_at)
         VALUES ($1, $2, $3, 'script_version', $4, '{}'::jsonb, $5, 'chat', $6, now() + interval '1 hour') RETURNING id`,
        [
          e.admin.organizationId,
          e.campanaId,
          opciones.tipo ?? 'script_version.approve',
          opciones.recurso ?? versionId,
          `hash-${Math.random().toString(36).slice(2)}`,
          e.consultor.id,
        ],
      );
      if (opciones.confirmarPor !== null) {
        await query(
          `UPDATE proposed_actions SET status = 'confirmed', confirmed_by = $2, confirmed_at = now() WHERE id = $1`,
          [pa!.id, (opciones.confirmarPor ?? e.director).id],
        );
      }
      return pa!.id;
    }
    const aprobar = (v: string, pa: string, por: User = e.director) =>
      rechazo(
        `UPDATE script_versions SET status = 'approved', approved_by = $2, approved_via_proposed_action_id = $3 WHERE id = $1`,
        [v, por.id, pa],
      );

    it('la acción debe ser del tipo, del recurso, estar confirmada y por la misma persona', async () => {
      // (una sola propuesta abierta por tipo y recurso: cada caso usa su propia versión)
      const otraVersion = await enRevision();
      const casos: Array<[string, (v: string) => Promise<string>, User?]> = [
        ['sin confirmar', (v) => accion(v, { confirmarPor: null })],
        ['de otro tipo', (v) => accion(v, { tipo: 'brief.approve' })],
        ['de otro recurso', (v) => accion(v, { recurso: otraVersion })],
        ['confirmada por otra persona', (v) => accion(v, { confirmarPor: e.admin }), e.director],
      ];
      for (const [nombre, crear, aprobador] of casos) {
        const v = await enRevision();
        const pa = await crear(v);
        expect(await aprobar(v, pa, aprobador ?? e.director), nombre).toMatch(
          /no es la aprobación confirmada/,
        );
        expect((await estado(v)).status, nombre).toBe('in_review');
      }
      const v = await enRevision();
      expect(await aprobar(v, '66666666-6666-4666-8666-666666666666')).not.toBe('');
      expect((await estado(v)).status).toBe('in_review');
    });

    it('la acción correcta (confirmada por quien aprueba) aprueba y queda enlazada', async () => {
      const v = await enRevision();
      const pa = await accion(v, { confirmarPor: e.director });
      expect(await aprobar(v, pa, e.director)).toBe('');
      const [f] = await query<{ approved_via_proposed_action_id: string; status: string }>(
        `SELECT approved_via_proposed_action_id, status FROM script_versions WHERE id = $1`,
        [v],
      );
      expect(f).toEqual({ approved_via_proposed_action_id: pa, status: 'approved' });
    });

    it('la FK compuesta amarra la acción a la misma campaña y organización', async () => {
      const v = await enRevision();
      const [paOtraCampana] = await query<{ id: string }>(
        `INSERT INTO proposed_actions (organization_id, campaign_id, action_type, resource_type, resource_id,
                                       payload, payload_hash, proposed_origin, proposed_by, expires_at)
         VALUES ($1, $2, 'script_version.approve', 'script_version', $3, '{}'::jsonb, 'h', 'chat', $4, now() + interval '1 hour')
         RETURNING id`,
        [e.admin.organizationId, e.otraCampanaId, v, e.consultor.id],
      );
      await query(
        `UPDATE proposed_actions SET status = 'confirmed', confirmed_by = $2, confirmed_at = now() WHERE id = $1`,
        [paOtraCampana!.id, e.director.id],
      );
      expect(await aprobar(v, paOtraCampana!.id)).toMatch(/script_versions_accion_fkey|foreign key/);
    });
  });
});

describe('inmutabilidad de lo recibido', () => {
  it('la identidad y el binding no cambian: versión, entregable, fuente, hash, nombre, autor, fecha', async () => {
    const { deliverableId, versiones } = await entregableConVersiones(1);
    const otro = await entregableConVersiones(1);
    const otraFuente = await fuente('inmutable-otra');
    const id = versiones[0]!;
    const cambios: Array<[string, unknown[]]> = [
      [`version = 7`, []],
      [`deliverable_id = $2`, [otro.deliverableId]],
      [`source_document_id = $2`, [otraFuente]],
      [`source_hash = repeat('c', 64)`, []],
      [`source_filename = 'otro.md'`, []],
      [`created_by = $2`, [e.admin.id]],
      [`created_at = now() - interval '1 day'`, []],
      [`organization_id = $2`, [e.ajeno.organizationId]],
      [`campaign_id = $2`, [e.otraCampanaId]],
    ];
    for (const [set, params] of cambios) {
      const mensaje = await rechazo(`UPDATE script_versions SET ${set} WHERE id = $1`, [id, ...params]);
      expect(mensaje, set).not.toBe('');
    }
    expect(deliverableId).toBeDefined();
    expect((await estado(id)).version).toBe(1);
  });

  it('las marcas de aprobación no se fijan sin transición ni se reescriben en una aprobada o reemplazada', async () => {
    const { versiones } = await entregableConVersiones(2);
    expect(
      await rechazo(`UPDATE script_versions SET approved_by = $2, approved_at = now() WHERE id = $1`, [
        versiones[0],
        e.director.id,
      ]),
    ).not.toBe('');
    await fijarAprobada(versiones[0]!);
    for (const set of [
      `approved_by = $2`,
      `approved_at = now() - interval '1 day'`,
      `approval_snapshot = '{}'::jsonb`,
    ]) {
      expect(
        await rechazo(`UPDATE script_versions SET ${set} WHERE id = $1`, [versiones[0], e.admin.id]),
        set,
      ).not.toBe('');
    }
    // una aprobada solo admite → superseded (y solo cambia status / superseded_*)
    expect(
      await rechazo(
        `UPDATE script_versions SET status = 'superseded', superseded_by_version_id = $2, approved_at = now() WHERE id = $1`,
        [versiones[0], versiones[1]],
      ),
    ).toMatch(/solo se fijan al aprobar|no se modifican/);
    // reemplazada: histórica
    await conBypass(async (c) => {
      await c.query(
        `UPDATE script_versions SET status = 'superseded', superseded_by_version_id = $2, superseded_at = now() WHERE id = $1`,
        [versiones[0], versiones[1]],
      );
    });
    expect(
      await rechazo(`UPDATE script_versions SET updated_at = now() WHERE id = $1`, [versiones[0]]),
    ).toMatch(/histórica/);
  });

  it('solo se registran versiones recibidas, sin marcas de aprobación ni de reemplazo (INSERT directo)', async () => {
    const { deliverableId } = await entregableConVersiones(1);
    const f = await fuente('nace-recibida');
    for (const set of [`'approved'`, `'in_review'`, `'superseded'`]) {
      const mensaje = await rechazo(
        `INSERT INTO script_versions (organization_id, campaign_id, deliverable_id, source_document_id, created_by, status)
         VALUES ($1, $2, $3, $4, $5, ${set})`,
        [e.admin.organizationId, e.campanaId, deliverableId, f, e.consultor.id],
      );
      expect(mensaje, set).not.toBe('');
    }
  });

  it('no hay DELETE (solo el bypass de bases _test, que usa la limpieza)', async () => {
    const { versiones } = await entregableConVersiones(1);
    expect(await rechazo(`DELETE FROM script_versions WHERE id = $1`, [versiones[0]])).toMatch(
      /no admite DELETE/,
    );
  });
});

// ─────────────────────────── Lecturas ──────────────────────────────────────────

describe('lecturas de versiones', () => {
  it('historial (más nueva primero), detalle, última y vigente', async () => {
    const { deliverableId, versiones } = await entregableConVersiones(3);
    const lista = valor(await listarVersionesDeEntregable(e.consultor, deliverableId));
    expect(lista.items.map((v) => v.version)).toEqual([3, 2, 1]);
    expect(lista.total).toBe(3);
    expect(
      valor(await listarVersionesDeEntregable(e.consultor, deliverableId, { limite: 1, desde: 1 })).items[0]
        ?.version,
    ).toBe(2);

    expect(valor(await obtenerUltimaVersion(e.consultor, deliverableId))?.id).toBe(versiones[2]);
    expect(valor(await obtenerVersionVigente(e.consultor, deliverableId))).toBeNull();
    await fijarAprobada(versiones[1]!);
    const vigente = valor(await obtenerVersionVigente(e.consultor, deliverableId));
    expect(vigente).toMatchObject({ id: versiones[1], status: 'approved', approvedBy: e.director.id });
    expect(valor(await obtenerUltimaVersion(e.consultor, deliverableId))?.version).toBe(3);

    const detalle = valor(await obtenerVersionDeGuion(e.consultor, versiones[1]!));
    expect(detalle.deliverable).toMatchObject({ id: deliverableId, status: 'active' });
    expect(detalle.approvedViaProposedActionId).toBeUndefined();
  });

  it('un entregable sin versiones: última y vigente son null', async () => {
    expect(valor(await obtenerUltimaVersion(e.consultor, e.entregables.storyRios))?.version).toBeDefined();
    const d = valor(
      await crearEntregable(e.consultor, {
        campaignInfluencerId: e.participaciones.diego,
        label: 'Vacío de versiones',
      }),
    );
    expect(valor(await obtenerUltimaVersion(e.consultor, d.id))).toBeNull();
    expect(valor(await obtenerVersionVigente(e.consultor, d.id))).toBeNull();
    expect(valor(await listarVersionesDeEntregable(e.consultor, d.id)).items).toEqual([]);
  });

  it('cerco de campaña, ids mal formados y otras organizaciones: RESOURCE_NOT_FOUND', async () => {
    const { deliverableId, versiones } = await entregableConVersiones(1);
    const alcance = { alcance: { campaignId: e.otraCampanaId } };
    expect(codigo(await obtenerVersionDeGuion(e.consultor, versiones[0]!, alcance))).toBe(
      'RESOURCE_NOT_FOUND',
    );
    expect(codigo(await listarVersionesDeEntregable(e.consultor, deliverableId, alcance))).toBe(
      'RESOURCE_NOT_FOUND',
    );
    expect(codigo(await obtenerVersionVigente(e.consultor, deliverableId, alcance))).toBe(
      'RESOURCE_NOT_FOUND',
    );
    expect(codigo(await obtenerUltimaVersion(e.consultor, deliverableId, alcance))).toBe(
      'RESOURCE_NOT_FOUND',
    );
    expect(codigo(await obtenerVersionDeGuion(e.consultor, 'no-es-uuid'))).toBe('RESOURCE_NOT_FOUND');
    for (const intruso of [e.ajeno, e.cliente]) {
      expect(codigo(await obtenerVersionDeGuion(intruso, versiones[0]!))).toBe('RESOURCE_NOT_FOUND');
      expect(codigo(await listarVersionesDeEntregable(intruso, deliverableId))).toBe('RESOURCE_NOT_FOUND');
    }
  });
});

// ─────────────────────────── Iniciar la revisión ───────────────────────────────

describe('iniciarRevisionDeVersion (received → in_review, idempotente)', () => {
  it('pasa a in_review y audita; repetirlo no escribe ni audita de nuevo', async () => {
    const { versiones } = await entregableConVersiones(1);
    const msg = '77777777-7777-4777-8777-777777777777';
    const r1 = valor(
      await iniciarRevisionDeVersion(e.consultor, versiones[0]!, {
        origin: 'chat',
        correlation: { messageId: msg },
      }),
    );
    expect(r1.changed).toBe(true);
    expect(r1.version.status).toBe('in_review');
    const r2 = valor(await iniciarRevisionDeVersion(e.consultor, versiones[0]!));
    expect(r2.changed).toBe(false);
    const eventos = await auditoria('script_version.transition', versiones[0]!);
    expect(eventos).toHaveLength(1);
    expect(eventos[0]).toMatchObject({ origin: 'chat', correlation: { messageId: msg } });
    expect(eventos[0]?.metadata).toMatchObject({ from: 'received', to: 'in_review', version: 1 });
  });

  it('cinco simultáneas: una cambia, las demás son no-ops', async () => {
    const { versiones } = await entregableConVersiones(1);
    const rs = await Promise.all(
      [1, 2, 3, 4, 5].map(() => iniciarRevisionDeVersion(e.consultor, versiones[0]!)),
    );
    const cambios = rs.map((r) => valor(r).changed);
    expect(cambios.filter(Boolean)).toHaveLength(1);
    expect(await auditoria('script_version.transition', versiones[0]!)).toHaveLength(1);
  });

  it('cualquier otro estado → SCRIPT_INVALID_TRANSITION', async () => {
    for (const destino of ['changes_requested', 'approved', 'superseded'] as const) {
      const { versiones } = await entregableConVersiones(2);
      await conBypass(async (c) => {
        if (destino === 'approved') {
          await c.query(
            `UPDATE script_versions SET status = 'approved', approved_by = $2, approved_at = now() WHERE id = $1`,
            [versiones[0], e.director.id],
          );
        } else if (destino === 'superseded') {
          await c.query(
            `UPDATE script_versions SET status = 'superseded', superseded_by_version_id = $2, superseded_at = now() WHERE id = $1`,
            [versiones[0], versiones[1]],
          );
        } else {
          await c.query(`UPDATE script_versions SET status = $2 WHERE id = $1`, [versiones[0], destino]);
        }
      });
      const r = await iniciarRevisionDeVersion(e.consultor, versiones[0]!);
      expect(codigo(r), destino).toBe('SCRIPT_INVALID_TRANSITION');
      expect((r.ok ? undefined : r.error.details) as { from?: string }).toMatchObject({
        from: destino,
        to: 'in_review',
      });
    }
  });

  it('entregable archivado o participación retirada: conflicto accionable; el cerco de campaña se respeta', async () => {
    const { deliverableId, versiones } = await entregableConVersiones(1);
    expect(
      codigo(
        await iniciarRevisionDeVersion(e.consultor, versiones[0]!, undefined, {
          campaignId: e.otraCampanaId,
        }),
      ),
    ).toBe('RESOURCE_NOT_FOUND');
    valor(await archivarEntregable(e.consultor, deliverableId));
    expect(razon(await iniciarRevisionDeVersion(e.consultor, versiones[0]!))).toBe('deliverable_archived');
    expect((await estado(versiones[0]!)).status).toBe('received');
  });

  it('en una transacción ajena: si el llamador revierte, la transición se revierte', async () => {
    const { versiones } = await entregableConVersiones(1);
    await expect(
      transaction(async (c) => {
        const r = valor(await iniciarRevisionDeVersionEnTransaccion(c, e.consultor, versiones[0]!));
        expect(r.changed).toBe(true);
        throw new Error('revertir');
      }),
    ).rejects.toThrow('revertir');
    expect((await estado(versiones[0]!)).status).toBe('received');
    expect(await auditoria('script_version.transition', versiones[0]!)).toHaveLength(0);
  });
});
