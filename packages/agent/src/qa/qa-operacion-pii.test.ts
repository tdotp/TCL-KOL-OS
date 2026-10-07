/**
 * QA F8 · dinero y PII NUNCA llegan al modelo (V2 · Fase 8, DEC-049).
 *
 * Se siembran datos CENTINELA con los casos de uso reales de W1 (acuerdo con fee 9876543, costo de envío, cuenta de
 * cobro, pago reportado con referencia externa, cédula/teléfono/dirección cifrados, guía, transportadora, notas,
 * nombre de archivo de evidencia) y se ejecutan las 5 tools de lectura —y la de registro— como ADMIN (el rol con más
 * acceso), más `ensamblarContexto` y los mensajes iniciales del modelo. Ninguna salida, `stored`, argumento
 * guardado, contexto ni prompt puede contener un centinela.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePool, ensamblarContexto, obtenerEstadoOperativoDeParticipacion, query } from '@tcl-kol-os/db';
import type { User } from '@tcl-kol-os/domain';
import { construirMensajesIniciales } from '../prompts/agente-cuenta.ts';
import { abrirTurno, json, llamar, registro, type Turno } from '../tools/test-support.ts';
import {
  CENTINELAS,
  COBRO,
  COSTO_DE_ENVIO,
  EVIDENCIA,
  FEE,
  GUIA,
  type MundoDeOperacion,
  NOTA,
  REFERENCIA_EXTERNA,
  crearMundoDeOperacion,
  crearSheetConKpi,
  limpiarMundoDeOperacion,
} from './testing/operacion.ts';

const r = registro();
const SECRETO = 'secreto-de-prueba-del-servidor-f8-pii';
let m: MundoDeOperacion;

beforeAll(async () => {
  m = await crearMundoDeOperacion('QA F8 PII');
  await crearSheetConKpi(m.op.admin, m.op.campanaId, m.rios, 'Alcanzar 50.000 vistas');
}, 120_000);

afterAll(async () => {
  await limpiarMundoDeOperacion(m);
  await closePool();
});

const alias = (t: Turno, id: string): string =>
  t.referencias.registrar({ kind: 'campaign_influencer', entityId: id }).alias;

function fugas(texto: string): string[] {
  return CENTINELAS.filter((c) => texto.includes(c));
}

/** Ejecuta las 6 tools como `actor` y devuelve todo lo que vio el modelo y lo que se guardó. */
async function barrido(actor: User): Promise<{ salidas: string[]; runId: string }> {
  const t = await abrirTurno(actor, m.op.campanaId, 'Para Diego fija 100.000 vistas');
  const salidas: string[] = [];
  const guardar = (x: { content: string }): void => {
    salidas.push(x.content);
  };
  guardar(await llamar(r, t, 'operations_summary_list', { limit: 50 }));
  guardar(await llamar(r, t, 'operations_summary_list', { includeRetired: true, pendingLogistics: true }));
  for (const ci of [m.rios, m.gomez, m.diego]) {
    const p = alias(t, ci);
    guardar(await llamar(r, t, 'operations_participation_status', { participationId: p }));
    guardar(await llamar(r, t, 'kpi_scoreboard_get', { participationId: p }));
    guardar(await llamar(r, t, 'kpi_history_get', { participationId: p }));
    guardar(await llamar(r, t, 'sheet_kpi_pactado_get', { participationId: p }));
  }
  guardar(
    await llamar(r, t, 'kpi_target_register', {
      participationId: alias(t, m.diego),
      metric: 'views',
      targetValue: 100_000,
      evidenceQuote: 'fija 100.000 vistas',
    }),
  );
  return { salidas, runId: t.runId };
}

describe('los centinelas existen en la base (el barrido no es un falso negativo)', () => {
  it('fee, costo de envío, cuenta de cobro, guía, notas, referencia externa y archivo de evidencia están guardados', async () => {
    const cuenta = async (sql: string, ...p: unknown[]): Promise<number> =>
      Number((await query<{ n: string }>(sql, p))[0]!.n);
    expect(
      await cuenta(`SELECT count(*) AS n FROM agreement_versions WHERE fee_amount = $1`, FEE),
    ).toBeGreaterThan(0);
    expect(await cuenta(`SELECT count(*) AS n FROM shipments WHERE shipping_cost = $1`, COSTO_DE_ENVIO)).toBe(
      1,
    );
    expect(await cuenta(`SELECT count(*) AS n FROM billing_documents WHERE claimed_amount = $1`, COBRO)).toBe(
      1,
    );
    expect(await cuenta(`SELECT count(*) AS n FROM shipments WHERE tracking_ref = $1`, GUIA)).toBe(1);
    expect(
      await cuenta(`SELECT count(*) AS n FROM operational_events WHERE note = $1`, NOTA),
    ).toBeGreaterThan(0);
    expect(
      await cuenta(
        `SELECT count(*) AS n FROM payment_obligations WHERE external_reference = $1`,
        REFERENCIA_EXTERNA,
      ),
    ).toBe(1);
    expect(
      await cuenta(`SELECT count(*) AS n FROM source_documents WHERE filename LIKE $1`, `${EVIDENCIA}%`),
    ).toBeGreaterThan(0);
    expect(
      await cuenta(`SELECT count(*) AS n FROM influencer_pii_records WHERE erased_at IS NULL`),
    ).toBeGreaterThan(0);
  });

  it('CONTROL: el read model rico de la UI (prohibido para el agente) SÍ trae el dinero de un admin: el barrido detectaría una fuga', async () => {
    const rico = JSON.stringify((await obtenerEstadoOperativoDeParticipacion(m.op.admin, m.rios)) as unknown);
    expect(fugas(rico).length).toBeGreaterThan(0);
    expect(rico).toContain(String(FEE));
  });
});

describe('las 6 tools de operación y KPIs como admin, director y consultor', () => {
  for (const rol of ['admin', 'director', 'consultor'] as const) {
    it(`${rol}: ninguna salida, argumento guardado ni resultado guardado contiene un centinela`, async () => {
      const { salidas, runId } = await barrido(m.op[rol]);
      expect(salidas.length).toBeGreaterThanOrEqual(15);
      for (const s of salidas) expect(fugas(s), s.slice(0, 120)).toEqual([]);
      // lo que quedó guardado de cada invocación (args y result) tampoco
      const filas = await query<{ tool_name: string; args: unknown; result: unknown }>(
        `SELECT tool_name, args, result FROM agent_tool_invocations WHERE agent_run_id = $1`,
        [runId],
      );
      expect(filas.length).toBeGreaterThanOrEqual(15);
      for (const f of filas) {
        expect(fugas(JSON.stringify(f.args)), `args ${f.tool_name}`).toEqual([]);
        expect(fugas(JSON.stringify(f.result)), `result ${f.tool_name}`).toEqual([]);
      }
      // y la auditoría del único efecto (el objetivo de KPI) no lleva valores
      const auditoria = await query<{ metadata: unknown }>(
        `SELECT metadata FROM audit_events WHERE correlation ->> 'agentRunId' = $1`,
        [runId],
      );
      for (const a of auditoria) expect(fugas(JSON.stringify(a.metadata))).toEqual([]);
    });
  }

  it('el vocabulario de dinero no aparece como clave de ninguna salida (fee, amount, currency, invoice, payment, billing…)', async () => {
    const { salidas } = await barrido(m.op.admin);
    const prohibidas = new Set([
      'fee',
      'amount',
      'currency',
      'invoice',
      'payment',
      'billing',
      'address',
      'phone',
      'document',
      'cost',
      'evidence',
      'provenance',
      'trackingref',
      'carrier',
      'shippingcost',
      'feeamount',
      'claimedamount',
      'externalreference',
      'piirecordid',
    ]);
    const claves = (v: unknown, acc: Set<string>): Set<string> => {
      if (Array.isArray(v)) v.forEach((x) => claves(x, acc));
      else if (v !== null && typeof v === 'object') {
        for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
          acc.add(k.toLowerCase());
          claves(x, acc);
        }
      }
      return acc;
    };
    for (const s of salidas) {
      const usadas = [...claves(JSON.parse(s) as unknown, new Set())].filter((k) => prohibidas.has(k));
      expect(usadas, s.slice(0, 120)).toEqual([]);
    }
  });

  it('el agente SÍ dice lo que corresponde: estado por producto y la nota de que el dinero lo gestiona Operativo', async () => {
    const t = await abrirTurno(m.op.admin, m.op.campanaId, 'estado');
    const x = await llamar(r, t, 'operations_participation_status', { participationId: alias(t, m.rios) });
    expect(String(json(x)['note'])).toContain('lo gestiona Operativo');
    expect(String(json(x)['details'])).toContain('entregado 2');
  });
});

describe('contexto y prompt del modelo', () => {
  async function contexto(actor: User) {
    const x = await ensamblarContexto(actor, {
      conversationId: 'conv-f8-pii',
      messageId: 'msg-f8-pii',
      runId: `run-f8-pii-${Date.now().toString(36)}`,
      campaignId: m.op.campanaId,
      nonceSecret: SECRETO,
      mensajeActual: { texto: '¿Ya le llegó el producto a Valentina? ¿Cuánto se le pagó?', adjuntos: [] },
      ventana: [],
      ahora: new Date('2026-10-06T12:00:00.000Z'),
    });
    if (!x.ok) throw new Error(`${x.error.code}: ${x.error.message}`);
    return x.value;
  }

  it('ensamblarContexto como ADMIN: ningún centinela en el contexto, el informe ni los mensajes iniciales; sin sección operativa', async () => {
    const c = await contexto(m.op.admin);
    expect(fugas(JSON.stringify(c))).toEqual([]);
    const mensajes = construirMensajesIniciales(c.texto);
    for (const msg of mensajes) expect(fugas(String(msg.content)), msg.role).toEqual([]);
    const ids = c.secciones.map((s) => s.id as string);
    expect(ids.filter((id) => /oper|kpi|agreement|pago|payment|ship|envio/i.test(id))).toEqual([]);
    expect(
      JSON.stringify(c.informe.sections.map((s: { id: string }) => s.id)).match(/operativ|kpi|payment/i),
    ).toBeNull();
    // ni siquiera mencionan los valores de la operación por otra vía
    expect(JSON.stringify(c)).not.toMatch(/9\.?876\.?543/);
  });
});
