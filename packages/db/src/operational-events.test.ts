/**
 * V2 · Fase 8 (W1b) — el motor de eventos operativos: bloqueo del sujeto, idempotencia, control optimista,
 * solo personas por la UI, aislamiento por organización, auditoría sin montos/notas/referencias y el historial
 * con proyección por capacidad.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { User } from '@tcl-kol-os/domain';
import { closePool, query, transaction } from './client.ts';
import {
  aplicarEventoOperativo,
  listarEventosOperativos,
  transaccionOperativa,
} from './operational-events.ts';
import {
  type EscenarioDeOperacion,
  auditoriaDeSujeto,
  crearAcuerdoPorSql,
  crearEscenarioDeOperacion,
  dia,
  fila,
  insertar,
  limpiarEscenarioDeOperacion,
  nuevaParticipacion,
  unico,
} from './ops-test-support.ts';
import { crearEnvio, transicionarEnvio } from './shipments.ts';
import { Abortar } from './tx-result.ts';

let op: EscenarioDeOperacion;
let e: EscenarioDeOperacion['e'];

beforeAll(async () => {
  op = await crearEscenarioDeOperacion('F8 motor');
  e = op.e;
});

afterAll(async () => {
  await limpiarEscenarioDeOperacion(op);
  await closePool();
});

const NOTA = 'SENTINELA-NOTA-interna-9137';
const REFERENCIA = 'SENTINELA-REF-externa-5521';

/** Un envío `pending` listo para mover (productos asignados y, si hace falta, comprometidos). */
async function envioPendiente(): Promise<{ id: string; ci: string; seq: number }> {
  const { ci } = await nuevaParticipacion(op, 'Motor', [e.productos.p80]);
  const r = await crearEnvio(e.operativo, {
    campaignInfluencerId: ci,
    items: [{ campaignProductId: e.productos.p80, quantity: 1 }],
    idempotencyKey: unico('crear'),
  });
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
  return { id: r.value.envio.id, ci, seq: r.value.envio.rowSeq };
}

async function mover(
  actor: User,
  id: string,
  seq: number,
  extra: Partial<Parameters<typeof aplicarEventoOperativo>[1]> = {},
) {
  return transaccionOperativa((c) =>
    aplicarEventoOperativo(c, {
      actor,
      action: 'shipment:manage',
      sujeto: { tipo: 'shipment', id },
      eventType: 'shipment.prepared',
      toStatus: 'prepared',
      expectedSeq: seq,
      idempotencyKey: unico('mover'),
      ...extra,
    }),
  );
}

describe('aplicarEventoOperativo', () => {
  it('mueve el sujeto: evento, estado, row_seq y last_event_id coherentes', async () => {
    const s = await envioPendiente();
    expect(s.seq).toBe(1);
    const r = await mover(e.operativo, s.id, s.seq, { note: NOTA });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.repetido).toBe(false);
    expect(r.value.evento).toMatchObject({
      eventType: 'shipment.prepared',
      fromStatus: 'pending',
      toStatus: 'prepared',
      subjectSeq: 2,
      recordedBy: e.operativo.id,
    });
    expect(r.value.sujeto).toMatchObject({ status: 'prepared', rowSeq: 2 });
    const bd = await fila<{ status: string; row_seq: number; last_event_id: string }>(
      `SELECT status, row_seq, last_event_id FROM shipments WHERE id = $1`,
      [s.id],
    );
    expect(bd).toEqual({ status: 'prepared', row_seq: 2, last_event_id: r.value.evento.id });
  });

  it('un reintento idéntico devuelve el MISMO evento sin duplicar ni auditar de nuevo', async () => {
    const s = await envioPendiente();
    const clave = unico('idem');
    const a = await mover(e.operativo, s.id, s.seq, { idempotencyKey: clave });
    const b = await mover(e.operativo, s.id, s.seq, { idempotencyKey: clave });
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(b.value.repetido).toBe(true);
    expect(b.value.evento.id).toBe(a.value.evento.id);
    const n = await fila<{ n: string }>(
      `SELECT count(*) AS n FROM operational_events WHERE shipment_id = $1 AND event_type = 'shipment.prepared'`,
      [s.id],
    );
    expect(Number(n.n)).toBe(1);
    const auditorias = (await auditoriaDeSujeto(s.id)).filter((x) => x.action === 'shipment.prepared');
    expect(auditorias).toHaveLength(1);
  });

  it('la misma clave con otra solicitud es RESOURCE_CONFLICT idempotency_key_reused', async () => {
    const s = await envioPendiente();
    const clave = unico('idem');
    expect((await mover(e.operativo, s.id, s.seq, { idempotencyKey: clave })).ok).toBe(true);
    const otra = await mover(e.operativo, s.id, s.seq, { idempotencyKey: clave, note: 'otra cosa' });
    expect(otra.ok).toBe(false);
    if (otra.ok) return;
    expect(otra.error.code).toBe('RESOURCE_CONFLICT');
    expect(otra.error.details).toMatchObject({ reason: 'idempotency_key_reused' });
  });

  it('expectedSeq desfasado ⇒ RESOURCE_CONFLICT stale_transition (nada se escribe)', async () => {
    const s = await envioPendiente();
    const r = await mover(e.operativo, s.id, s.seq + 3);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('RESOURCE_CONFLICT');
    expect(r.error.details).toMatchObject({
      reason: 'stale_transition',
      expectedSeq: s.seq + 3,
      currentSeq: s.seq,
    });
    const bd = await fila<{ status: string; row_seq: number }>(
      `SELECT status, row_seq FROM shipments WHERE id = $1`,
      [s.id],
    );
    expect(bd).toEqual({ status: 'pending', row_seq: 1 });
  });

  it('una arista que no existe ⇒ RESOURCE_CONFLICT invalid_transition', async () => {
    const s = await envioPendiente();
    const r = await mover(e.operativo, s.id, s.seq, {
      eventType: 'shipment.delivered',
      toStatus: 'delivered',
      happenedOn: dia(0),
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.details).toMatchObject({ reason: 'invalid_transition' });
  });

  it('crea un sujeto: la obligación nace con row_seq 0 y su evento de creación la lleva a 1', async () => {
    const { ci } = await nuevaParticipacion(op, 'Obligación');
    const creado = await transaccionOperativa(async (c) => {
      const agreementId = await insertar(c, 'agreements', {
        organization_id: e.operativo.organizationId,
        campaign_id: e.campanaId,
        campaign_influencer_id: ci,
        created_by: e.operativo.id,
      });
      await insertar(c, 'agreement_versions', {
        organization_id: e.operativo.organizationId,
        campaign_id: e.campanaId,
        agreement_id: agreementId,
        compensation_type: 'fee',
        fee_amount: 500000,
        fee_currency: 'COP',
        created_by: e.operativo.id,
      });
      const obligationId = await insertar(c, 'payment_obligations', {
        organization_id: e.operativo.organizationId,
        campaign_id: e.campanaId,
        agreement_id: agreementId,
        status: 'pending',
        created_by: e.operativo.id,
      });
      const r = await aplicarEventoOperativo(c, {
        actor: e.operativo,
        action: 'agreement:manage',
        sujeto: { tipo: 'payment_obligation', id: obligationId },
        eventType: 'payment.applicability_set',
        toStatus: 'pending',
        expectedSeq: 0,
        idempotencyKey: `obligacion:${agreementId}`,
        huellaExtra: { agreementId },
      });
      return { obligationId, r };
    });
    expect(creado.ok).toBe(true);
    if (!creado.ok) return;
    expect(creado.value.r.evento).toMatchObject({ fromStatus: null, toStatus: 'pending', subjectSeq: 1 });
    const bd = await fila<{ row_seq: number }>(`SELECT row_seq FROM payment_obligations WHERE id = $1`, [
      creado.value.obligationId,
    ]);
    expect(bd.row_seq).toBe(1);
  });

  it('un precondicion que rechaza deshace todo el evento', async () => {
    const s = await envioPendiente();
    const r = await transaccionOperativa((c) =>
      aplicarEventoOperativo(c, {
        actor: e.operativo,
        action: 'shipment:manage',
        sujeto: { tipo: 'shipment', id: s.id },
        eventType: 'shipment.prepared',
        toStatus: 'prepared',
        expectedSeq: s.seq,
        idempotencyKey: unico('pre'),
        precondicion: async () => {
          throw new Abortar({ code: 'RESOURCE_CONFLICT', message: 'no', details: { reason: 'prueba' } });
        },
      }),
    );
    expect(r.ok).toBe(false);
    const n = await fila<{ n: string }>(
      `SELECT count(*) AS n FROM operational_events WHERE shipment_id = $1`,
      [s.id],
    );
    expect(Number(n.n)).toBe(1); // solo el evento de creación
  });

  it('una columna fuera de la lista blanca del sujeto es un error de programación', async () => {
    const s = await envioPendiente();
    await expect(
      transaction((c) =>
        aplicarEventoOperativo(c, {
          actor: e.operativo,
          action: 'shipment:manage',
          sujeto: { tipo: 'shipment', id: s.id },
          eventType: 'shipment.prepared',
          toStatus: 'prepared',
          expectedSeq: s.seq,
          idempotencyKey: unico('col'),
          cambios: { shipping_cost: '1' },
        }),
      ),
    ).rejects.toThrow(/no es modificable/);
  });
});

describe('solo personas por la UI', () => {
  it('el chat ⇒ HUMAN_CONFIRMATION_REQUIRED y el sistema u otro origen ⇒ FORBIDDEN_ROLE', async () => {
    const s = await envioPendiente();
    const chat = await mover(e.operativo, s.id, s.seq, { contexto: { origin: 'chat' } });
    expect(chat.ok).toBe(false);
    if (!chat.ok) expect(chat.error.code).toBe('HUMAN_CONFIRMATION_REQUIRED');
    const sistema = await mover(e.operativo, s.id, s.seq, { contexto: { origin: 'system' } });
    expect(sistema.ok).toBe(false);
    if (!sistema.ok) expect(sistema.error.code).toBe('FORBIDDEN_ROLE');
    const actorSistema = await mover('system' as unknown as User, s.id, s.seq);
    expect(actorSistema.ok).toBe(false);
    if (!actorSistema.ok) expect(actorSistema.error.code).toBe('FORBIDDEN_ROLE');
    const bd = await fila<{ status: string }>(`SELECT status FROM shipments WHERE id = $1`, [s.id]);
    expect(bd.status).toBe('pending');
  });

  it('otra organización, el cliente y un sujeto inexistente ⇒ RESOURCE_NOT_FOUND; un rol sin la capacidad ⇒ FORBIDDEN_ROLE', async () => {
    const s = await envioPendiente();
    for (const actor of [e.ajeno, e.cliente]) {
      const r = await mover(actor, s.id, s.seq);
      expect(r.ok, actor.role).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('RESOURCE_NOT_FOUND');
    }
    const inexistente = await mover(e.operativo, '00000000-0000-4000-8000-000000000000', 1);
    expect(inexistente.ok).toBe(false);
    if (!inexistente.ok) expect(inexistente.error.code).toBe('RESOURCE_NOT_FOUND');
    const mal = await mover(e.operativo, 'no-es-uuid', 1);
    expect(mal.ok).toBe(false);
    if (!mal.ok) expect(mal.error.code).toBe('RESOURCE_NOT_FOUND');
    for (const actor of [e.consultor, e.analista, e.legal]) {
      const r = await mover(actor, s.id, s.seq);
      expect(r.ok, actor.role).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('FORBIDDEN_ROLE');
    }
  });
});

describe('auditoría', () => {
  it('la metadata lleva solo ids, estados, tipos y conteos: jamás la nota ni la referencia', async () => {
    const { ci } = await nuevaParticipacion(op, 'Auditoría', [e.productos.p80]);
    const creado = await crearEnvio(e.operativo, {
      campaignInfluencerId: ci,
      items: [{ campaignProductId: e.productos.p80, quantity: 1 }],
      carrier: 'SENTINELA-TRANSPORTADORA',
      shippingCost: '777777.00',
      shippingCurrency: 'COP',
      note: NOTA,
      idempotencyKey: unico('aud'),
    });
    expect(creado.ok).toBe(true);
    if (!creado.ok) return;
    const id = creado.value.envio.id;
    const r = await transicionarEnvio(e.operativo, {
      shipmentId: id,
      to: 'prepared',
      expectedSeq: creado.value.envio.rowSeq,
      idempotencyKey: unico('aud2'),
      note: NOTA,
    });
    expect(r.ok).toBe(true);
    const registros = await auditoriaDeSujeto(id);
    expect(registros.map((x) => x.action)).toEqual(['shipment.created', 'shipment.prepared']);
    const texto = JSON.stringify(registros);
    for (const prohibido of [NOTA, REFERENCIA, 'SENTINELA', '777777']) {
      expect(texto).not.toContain(prohibido);
    }
    expect(texto).not.toContain('[redactado]'); // solo claves permitidas: nada se tuvo que redactar
    const prepared = registros[1]!.metadata as Record<string, unknown>;
    expect(prepared).toMatchObject({
      subjectType: 'shipment',
      eventType: 'shipment.prepared',
      fromStatus: 'pending',
      toStatus: 'prepared',
      seq: 2,
      hasEvidence: false,
      evidenceCount: 0,
    });
  });
});

describe('listarEventosOperativos', () => {
  it('el historial va en orden; la nota solo la ve quien gestiona; el consultor ve estados sin nota', async () => {
    const s = await envioPendiente();
    const r = await mover(e.operativo, s.id, s.seq, { note: NOTA });
    expect(r.ok).toBe(true);

    const conNota = await listarEventosOperativos(e.operativo, { subjectType: 'shipment', subjectId: s.id });
    expect(conNota.ok).toBe(true);
    if (!conNota.ok) return;
    expect(conNota.value.map((x) => x.eventType)).toEqual(['shipment.created', 'shipment.prepared']);
    expect(conNota.value[1]!.note).toBe(NOTA);

    const consultor = await listarEventosOperativos(e.consultor, {
      subjectType: 'shipment',
      subjectId: s.id,
    });
    expect(consultor.ok).toBe(true);
    if (!consultor.ok) return;
    expect(consultor.value).toHaveLength(2);
    expect(JSON.stringify(consultor.value)).not.toContain(NOTA);
    expect(consultor.value[1]).not.toHaveProperty('note');

    const ajeno = await listarEventosOperativos(e.ajeno, { subjectType: 'shipment', subjectId: s.id });
    expect(ajeno.ok).toBe(false);
    if (!ajeno.ok) expect(ajeno.error.code).toBe('RESOURCE_NOT_FOUND');
    const cliente = await listarEventosOperativos(e.cliente, { subjectType: 'shipment', subjectId: s.id });
    expect(cliente.ok).toBe(false);
    if (!cliente.ok) expect(cliente.error.code).toBe('RESOURCE_NOT_FOUND');
  });

  it('los eventos de pago exigen finance:read: el consultor no los ve', async () => {
    const { ci } = await nuevaParticipacion(op, 'Historial pago');
    const ac = await crearAcuerdoPorSql(op, { ci, mode: 'fee' });
    const operativo = await listarEventosOperativos(e.operativo, {
      subjectType: 'payment_obligation',
      subjectId: ac.obligationId,
    });
    expect(operativo.ok).toBe(true);
    if (operativo.ok) expect(operativo.value.map((x) => x.eventType)).toEqual(['payment.applicability_set']);
    const consultor = await listarEventosOperativos(e.consultor, {
      subjectType: 'payment_obligation',
      subjectId: ac.obligationId,
    });
    expect(consultor.ok).toBe(false);
    if (!consultor.ok) expect(consultor.error.code).toBe('FORBIDDEN_ROLE');
  });
});

describe('integridad al cerrar la transacción', () => {
  it('un evento sin aplicar al sujeto lo rechaza la base y el caso de uso lo devuelve como conflicto', async () => {
    const s = await envioPendiente();
    // Se inserta el evento por SQL sin actualizar el sujeto: la base lo rechaza al COMMIT.
    const r = await transaccionOperativa(async (c) => {
      await insertar(c, 'operational_events', {
        organization_id: e.operativo.organizationId,
        campaign_id: e.campanaId,
        subject_type: 'shipment',
        shipment_id: s.id,
        event_type: 'shipment.prepared',
        from_status: 'pending',
        to_status: 'prepared',
        subject_seq: s.seq + 1,
        recorded_by: e.operativo.id,
        idempotency_key: unico('huerfano'),
        request_hash: 'a'.repeat(64),
      });
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('RESOURCE_CONFLICT');
    const n = await query<{ n: string }>(
      `SELECT count(*) AS n FROM operational_events WHERE shipment_id = $1`,
      [s.id],
    );
    expect(Number(n[0]!.n)).toBe(1);
  });
});
