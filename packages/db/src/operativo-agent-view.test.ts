/**
 * V2 · Fase 8 (W2b) — vista operativa PARA EL AGENTE: el DTO no tiene, por construcción, dinero, facturación,
 * pagos, costos de envío, tracking, PII ni notas (ni siquiera para un admin); marca como no confiables los
 * nombres; respeta la matriz de capacidades; consulta por lotes y nunca toca las tablas de finanzas.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Result } from '@tcl-kol-os/domain';
import {
  crearAcuerdoDePrueba,
  crearEscenarioDeOperacion,
  limpiarEscenarioDeOperacion,
} from './test-utils.ts';
import type { EscenarioDeOperacion } from './test-utils.ts';
import { archivoDePrueba, dia, unico } from './ops-test-support.ts';
import { asociarInfluencerACampana, asociarProductoAInfluencer } from './campaign-influencers.ts';
import { crearInfluencer } from './influencers.ts';
import { closePool, getPool, query } from './client.ts';
import { guardarPii } from './pii.ts';
import { crearEnvio, transicionarEnvio } from './shipments.ts';
import { obtenerSeguimientoDePago, registrarDocumentoDeCobro } from './billing-payment.ts';
import {
  type ResumenOperativoParaAgente,
  obtenerEstadoOperativoParaAgente,
  obtenerResumenOperativoParaAgente,
} from './operativo-agent-view.ts';

const FEE = 9876543;
const COSTO_ENVIO = 7654321;
const COBRO = 5432198;
const CEDULA = String(1_000_000_000 + Math.floor(Math.random() * 8_000_000_000));
const TELEFONO = '3001112233';
const DIRECCION = 'Calle 99 # 88-77 Apto SENT';
const GUIA = 'GUIA-SENT-777';
const TRANSPORTADORA = 'TRANSPORTADORA-SENT';
const NOTA = 'NOTA-SENT-INTERNA';
const CONDICIONES = 'CONDICIONES-SENT-del-acuerdo';
const EVIDENCIA = 'EVIDENCIA-SENT-FILE';
const CENTINELAS = [
  String(FEE),
  String(COSTO_ENVIO),
  String(COBRO),
  CEDULA,
  TELEFONO,
  DIRECCION,
  GUIA,
  TRANSPORTADORA,
  NOTA,
  CONDICIONES,
  EVIDENCIA,
];

let op: EscenarioDeOperacion;
let rios: string;
let gomez: string;
let diego: string;

function exito<T>(r: Result<T>): T {
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message} ${JSON.stringify(r.error.details)}`);
  return r.value;
}
function codigo<T>(r: Result<T>): string {
  return r.ok ? 'OK' : r.error.code;
}

async function crearYMover(
  ci: string,
  producto: string,
  cantidad: number,
  hasta: 'pending' | 'delivered',
  extra: Partial<Parameters<typeof crearEnvio>[1]> = {},
): Promise<void> {
  let s = exito(
    await crearEnvio(op.operativo, {
      campaignInfluencerId: ci,
      items: [{ campaignProductId: producto, quantity: cantidad }],
      idempotencyKey: unico('envio'),
      ...extra,
    }),
  ).envio;
  if (hasta === 'pending') return;
  const paso = async (to: Parameters<typeof transicionarEnvio>[1]['to'], x: object = {}) => {
    s = exito(
      await transicionarEnvio(op.operativo, {
        shipmentId: s.id,
        to,
        expectedSeq: s.rowSeq,
        idempotencyKey: unico(to),
        ...x,
      }),
    ).envio;
  };
  await paso('prepared');
  await paso('shipped', { happenedOn: dia(3), carrier: TRANSPORTADORA, trackingRef: GUIA, note: NOTA });
  await paso('delivered', { happenedOn: dia(1) });
}

beforeAll(async () => {
  op = await crearEscenarioDeOperacion('F8 operativo agente');
  rios = op.participaciones.valentinaRios;
  gomez = op.participaciones.valentinaGomez;
  diego = op.participaciones.diego;

  await crearAcuerdoDePrueba(op.admin, {
    campaignInfluencerId: rios,
    mode: 'mixed',
    campaignProductId: op.productos.p80,
    amount: FEE,
    currency: 'COP',
    quantity: 4,
    conditions: CONDICIONES,
  });
  await crearAcuerdoDePrueba(op.admin, {
    campaignInfluencerId: gomez,
    mode: 'barter',
    campaignProductId: op.productos.pro,
    quantity: 2,
  });

  const influencer = (
    await query<{ influencer_id: string }>(`SELECT influencer_id FROM campaign_influencers WHERE id = $1`, [
      rios,
    ])
  )[0]!.influencer_id;
  const pii = exito(
    await guardarPii(op.operativo, {
      influencerId: influencer,
      documentId: CEDULA,
      phone: TELEFONO,
      address: DIRECCION,
    }),
  );
  await crearYMover(rios, op.productos.p80, 2, 'delivered', {
    shippingCost: COSTO_ENVIO,
    shippingCurrency: 'COP',
    piiRecordId: pii.record.recordId,
    note: NOTA,
  });
  await crearYMover(rios, op.productos.p80, 1, 'pending');
  await crearYMover(gomez, op.productos.pro, 2, 'pending');

  const seguimiento = exito(await obtenerSeguimientoDePago(op.operativo, rios))!;
  exito(
    await registrarDocumentoDeCobro(op.operativo, {
      paymentObligationId: seguimiento.obligation.id,
      documentNumber: 'DOC-SENT-001',
      issuedOn: dia(2),
      claimedAmount: COBRO,
      claimedCurrency: 'COP',
      archivo: archivoDePrueba(EVIDENCIA),
      idempotencyKey: unico('doc'),
      note: NOTA,
    }),
  );
}, 60_000);

afterAll(async () => {
  await limpiarEscenarioDeOperacion(op);
  await closePool();
});

afterEach(() => {
  vi.restoreAllMocks();
});

const itemDe = (r: ResumenOperativoParaAgente, ci: string) => {
  const i = r.items.find((x) => x.participacionId === ci);
  if (i === undefined) throw new Error(`falta ${ci}`);
  return i;
};

describe('capacidades', () => {
  it.each(['admin', 'director', 'consultor', 'operativo'] as const)(
    '%s recibe el resumen y el estado',
    async (rol) => {
      const r = exito(await obtenerResumenOperativoParaAgente(op[rol], op.campanaId));
      expect(r.items.length).toBe(3);
      exito(await obtenerEstadoOperativoParaAgente(op[rol], rios));
    },
  );

  it('analista y legal ⇒ FORBIDDEN_ROLE; cliente y ajeno ⇒ RESOURCE_NOT_FOUND', async () => {
    for (const rol of ['analista', 'legal'] as const) {
      expect(codigo(await obtenerResumenOperativoParaAgente(op[rol], op.campanaId))).toBe('FORBIDDEN_ROLE');
      expect(codigo(await obtenerEstadoOperativoParaAgente(op[rol], rios))).toBe('FORBIDDEN_ROLE');
    }
    for (const rol of ['cliente', 'ajeno'] as const) {
      expect(codigo(await obtenerResumenOperativoParaAgente(op[rol], op.campanaId))).toBe(
        'RESOURCE_NOT_FOUND',
      );
      expect(codigo(await obtenerEstadoOperativoParaAgente(op[rol], rios))).toBe('RESOURCE_NOT_FOUND');
    }
  });

  it('otra organización: ni campaña ni participación ajenas; la propia sí', async () => {
    expect(codigo(await obtenerEstadoOperativoParaAgente(op.admin, op.ajena.participacion))).toBe(
      'RESOURCE_NOT_FOUND',
    );
    expect(codigo(await obtenerResumenOperativoParaAgente(op.admin, op.campanaAjenaId))).toBe(
      'RESOURCE_NOT_FOUND',
    );
    const propia = exito(await obtenerResumenOperativoParaAgente(op.ajeno, op.campanaAjenaId));
    expect(propia.items.map((i) => i.participacionId)).toEqual([op.ajena.participacion]);
    expect(JSON.stringify(propia)).not.toContain(String(FEE));
    expect(codigo(await obtenerEstadoOperativoParaAgente(op.admin, 'no-es-uuid'))).toBe('RESOURCE_NOT_FOUND');
  });
});

describe('DTO: contenido útil', () => {
  it('participación, acuerdo, productos comprometidos vs enviados vs entregados, logística y contenido', async () => {
    const r = exito(await obtenerResumenOperativoParaAgente(op.admin, op.campanaId));
    expect(r.secciones).toEqual(['acuerdo', 'logistica', 'contenido', 'kpi']);
    const a = itemDe(r, rios);
    expect(a).toMatchObject({
      participacionId: rios,
      estadoDeParticipacion: 'activo',
      nombre: { valor: 'Valentina Ríos', untrusted: true },
      acuerdo: { estado: 'active', modo: 'mixed', version: 1, inicio: null, fin: null },
      logistica: { estado: 'pendiente', abiertos: 1, ultimoEstado: 'pending' },
      contenido: { estado: 'sin_guion', entregables: 2 },
      kpi: expect.objectContaining({ estado: 'sin_objetivos' }),
    });
    expect(a.logistica?.productos).toEqual([
      {
        campaignProductId: op.productos.p80,
        nombre: { valor: 'TCL P80', untrusted: true },
        comprometido: 4,
        enviado: 2,
        entregado: 2,
      },
    ]);
    const d = itemDe(r, diego);
    expect(d.acuerdo).toMatchObject({ estado: 'sin_acuerdo', modo: null });
    expect(d.logistica).toMatchObject({ estado: 'sin_envio', productos: [] });
    expect(r.conteos).toEqual({ participaciones: 3, sinAcuerdo: 1, logisticaPendiente: 2 });
    expect(r.total).toBe(3);
  });

  it('filtros: logística pendiente y sin acuerdo; pagoPendiente no existe para el agente', async () => {
    const l = exito(
      await obtenerResumenOperativoParaAgente(op.admin, op.campanaId, { logisticaPendiente: true }),
    );
    expect(l.items.map((i) => i.participacionId).sort()).toEqual([rios, gomez].sort());
    const s = exito(await obtenerResumenOperativoParaAgente(op.admin, op.campanaId, { sinAcuerdo: true }));
    expect(s.items.map((i) => i.participacionId)).toEqual([diego]);
    const pago = await obtenerResumenOperativoParaAgente(op.admin, op.campanaId, {
      pagoPendiente: true,
    } as unknown as Parameters<typeof obtenerResumenOperativoParaAgente>[2]);
    expect(codigo(pago)).toBe('FORBIDDEN_ROLE');
  });

  it('el estado de una participación es el mismo DTO + campaña y secciones; barter sin pago de ningún tipo', async () => {
    const e = exito(await obtenerEstadoOperativoParaAgente(op.admin, gomez));
    expect(e.campaignId).toBe(op.campanaId);
    expect(e.secciones).toEqual(['acuerdo', 'logistica', 'contenido', 'kpi']);
    expect(e.acuerdo).toMatchObject({ modo: 'barter' });
    expect(e.logistica?.productos).toEqual([
      {
        campaignProductId: op.productos.pro,
        nombre: { valor: 'TCL P80 Pro', untrusted: true },
        comprometido: 2,
        enviado: 0,
        entregado: 0,
      },
    ]);
    expect(e).not.toHaveProperty('pago');
    expect(e).not.toHaveProperty('facturacion');
  });

  it('el consultor sin finanzas ve lo mismo (el agente nunca tuvo finanzas)', async () => {
    const a = exito(await obtenerEstadoOperativoParaAgente(op.admin, rios));
    const c = exito(await obtenerEstadoOperativoParaAgente(op.consultor, rios));
    expect(c).toEqual(a);
  });

  it('un participante retirado solo sale con incluirRetirados; el estado individual siempre', async () => {
    const creado = exito(
      await crearInfluencer(op.admin, {
        displayName: `Retirada ${unico('r')}`,
        cuentas: [
          { platform: 'instagram', handle: `ret.${unico('h')}`.replace(/[^a-z0-9._]/gi, '').toLowerCase() },
        ],
      }),
    );
    op.influencerIds.push(creado.influencer.id);
    const ci = exito(
      await asociarInfluencerACampana(op.admin, {
        campaignId: op.campanaId,
        influencerId: creado.influencer.id,
      }),
    ).id;
    exito(
      await asociarProductoAInfluencer(op.admin, {
        campaignInfluencerId: ci,
        campaignProductId: op.productos.p80,
      }),
    );
    await query(`UPDATE campaign_influencers SET status = 'retirado', retired_at = now() WHERE id = $1`, [
      ci,
    ]);
    const por = exito(await obtenerResumenOperativoParaAgente(op.admin, op.campanaId));
    expect(por.items.some((i) => i.participacionId === ci)).toBe(false);
    const con = exito(
      await obtenerResumenOperativoParaAgente(op.admin, op.campanaId, { incluirRetirados: true }),
    );
    expect(itemDe(con, ci).estadoDeParticipacion).toBe('retirado');
    expect(exito(await obtenerEstadoOperativoParaAgente(op.admin, ci)).estadoDeParticipacion).toBe(
      'retirado',
    );
  });
});

describe('DTO: lo que NO puede tener (aunque el actor sea admin)', () => {
  it('ningún centinela en la salida serializada, para ningún rol', async () => {
    for (const rol of ['admin', 'director', 'consultor', 'operativo'] as const) {
      const resumen = JSON.stringify(exito(await obtenerResumenOperativoParaAgente(op[rol], op.campanaId)));
      const estados = JSON.stringify(
        await Promise.all(
          [rios, gomez, diego].map(async (ci) => exito(await obtenerEstadoOperativoParaAgente(op[rol], ci))),
        ),
      );
      for (const texto of [resumen, estados]) {
        for (const c of CENTINELAS) expect(texto, `${rol}: «${c}»`).not.toContain(c);
      }
    }
  });

  it('el DTO no tiene ninguna clave de dinero, facturación, pago, costo, tracking, PII, nota o evidencia', async () => {
    const r = exito(await obtenerResumenOperativoParaAgente(op.admin, op.campanaId));
    const e = exito(await obtenerEstadoOperativoParaAgente(op.admin, rios));
    const claves = new Set<string>();
    const recorrer = (v: unknown): void => {
      if (Array.isArray(v)) v.forEach(recorrer);
      else if (typeof v === 'object' && v !== null) {
        for (const [k, x] of Object.entries(v)) {
          claves.add(k);
          recorrer(x);
        }
      }
    };
    recorrer(r);
    recorrer(e);
    const prohibidas =
      /fee|amount|currency|price|cost|invoice|billing|payment|pago|finance|shipping|tracking|carrier|address|phone|document|note|nota|evidence|provenance|pii|cedula|reference|filename|moneda|monto|dinero|factura|condition/i;
    expect([...claves].filter((k) => prohibidas.test(k))).toEqual([]);
    expect([...claves].sort()).toEqual(
      [
        'abiertos',
        'acuerdo',
        'aprobado',
        'aprobado_con_nueva_en_revision',
        'campaignId',
        'campaignProductId',
        'conMedicion',
        'cumplidos',
        'noComparables',
        'objetivos',
        'porDebajo',
        'cambios_solicitados',
        'comprometido',
        'conteos',
        'contenido',
        'desde',
        'en_curso',
        'enviado',
        'entregado',
        'entregables',
        'estado',
        'estadoDeParticipacion',
        'fin',
        'inicio',
        'influencerId',
        'items',
        'kpi',
        'limite',
        'logisticaPendiente',
        'logistica',
        'modo',
        'nombre',
        'participacionId',
        'participaciones',
        'porEstado',
        'productos',
        'secciones',
        'sin_guion',
        'sinAcuerdo',
        'total',
        'ultimoEstado',
        'untrusted',
        'valor',
        'version',
      ].sort(),
    );
  });

  it('los nombres (influencer y producto) vienen marcados untrusted', async () => {
    const r = exito(await obtenerResumenOperativoParaAgente(op.admin, op.campanaId));
    for (const i of r.items) {
      expect(i.nombre.untrusted).toBe(true);
      for (const p of i.logistica?.productos ?? []) expect(p.nombre.untrusted).toBe(true);
    }
  });
});

describe('qué se consulta', () => {
  function sqlDe(espia: ReturnType<typeof vi.spyOn>): string {
    return espia.mock.calls
      .map((c) => (typeof c[0] === 'string' ? c[0] : (c[0] as { text: string }).text))
      .join('\n');
  }

  it('aunque sea admin, no se tocan finanzas, costos, PII, tracking ni notas', async () => {
    const espia = vi.spyOn(getPool(), 'query');
    exito(await obtenerResumenOperativoParaAgente(op.admin, op.campanaId));
    exito(await obtenerEstadoOperativoParaAgente(op.admin, rios));
    const sql = sqlDe(espia);
    expect(sql.length).toBeGreaterThan(0);
    expect(sql).not.toMatch(/billing_documents|payment_obligations|operational_events|operational_evidence/);
    expect(sql.replace(/\(s\.pii_record_id IS NOT NULL\)/g, '')).not.toMatch(
      /pii_record|influencer_pii|document_id_enc|phone_enc|address_enc|tracking_ref|carrier|shipping_cost|shipping_currency|fee_amount|fee_currency|conditions|\bnote\b|external_reference|source_filename|filename/,
    );
    expect(sql).not.toMatch(/select\s+\*/i);
  });

  it('sin N+1: el número de consultas no depende del de participaciones', async () => {
    const espia = vi.spyOn(getPool(), 'query');
    exito(await obtenerResumenOperativoParaAgente(op.admin, op.campanaId));
    const base = espia.mock.calls.length;
    for (let i = 0; i < 20; i += 1) {
      const creado = exito(
        await crearInfluencer(op.admin, {
          displayName: `Lote ${i} ${unico('l')}`,
          cuentas: [
            {
              platform: 'instagram',
              handle: `lote${i}.${unico('h')}`.replace(/[^a-z0-9._]/gi, '').toLowerCase(),
            },
          ],
        }),
      );
      op.influencerIds.push(creado.influencer.id);
      const ci = exito(
        await asociarInfluencerACampana(op.admin, {
          campaignId: op.campanaId,
          influencerId: creado.influencer.id,
        }),
      ).id;
      exito(
        await asociarProductoAInfluencer(op.admin, {
          campaignInfluencerId: ci,
          campaignProductId: op.productos.p80,
        }),
      );
      await crearAcuerdoDePrueba(op.admin, {
        campaignInfluencerId: ci,
        mode: i % 2 === 0 ? 'mixed' : 'barter',
        campaignProductId: op.productos.p80,
        quantity: 1,
      });
      if (i % 3 === 0) await crearYMover(ci, op.productos.p80, 1, 'pending');
    }
    espia.mockClear();
    const r = exito(await obtenerResumenOperativoParaAgente(op.admin, op.campanaId, { limite: 200 }));
    expect(r.total).toBe(23);
    expect(espia.mock.calls.length).toBe(base);
    expect(espia.mock.calls.length).toBeLessThanOrEqual(14);
  }, 120_000);
});

describe('seccionKpi inyectable', () => {
  it('se llama una vez con el actor y los ids de la página; su resultado va a `kpi` (resumen y estado)', async () => {
    const proveedor = vi.fn(
      async ({ participacionIds }: { participacionIds: readonly string[] }) =>
        new Map(participacionIds.map((id) => [id, { agregado: 'ok' }])),
    );
    const r = exito(
      await obtenerResumenOperativoParaAgente(
        op.director,
        op.campanaId,
        { limite: 2 },
        { seccionKpi: proveedor },
      ),
    );
    expect(proveedor).toHaveBeenCalledTimes(1);
    expect(r.items.length).toBe(2);
    expect(r.items.every((i) => (i.kpi as { agregado: string }).agregado === 'ok')).toBe(true);
    const e = exito(await obtenerEstadoOperativoParaAgente(op.director, rios, { seccionKpi: proveedor }));
    expect(proveedor).toHaveBeenCalledTimes(2);
    expect(e.kpi).toEqual({ agregado: 'ok' });
  });

  it('un proveedor que devuelva datos de otra participación no los filtra a las demás', async () => {
    const e = exito(
      await obtenerEstadoOperativoParaAgente(op.admin, rios, {
        seccionKpi: async () => new Map([[gomez, { x: 1 }]]),
      }),
    );
    expect(e.kpi).toBeNull();
  });
});
