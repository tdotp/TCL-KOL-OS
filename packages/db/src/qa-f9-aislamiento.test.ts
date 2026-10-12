/**
 * QA adversarial F9 (independiente) — aislamiento entre clientes/agencias y canal lateral modo de acuerdo.
 *  (1) Un SEGUNDO cliente (organización cliente distinta, o una agencia ajena) ve las campañas `tcl|compartida` de
 *      SmartPR: el contrato declarado (DEC-050) no liga la campaña a una organización cliente.
 *  (2) Lo que TCL puede inferir del modo de compensación a partir del resumen operativo.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePool, query } from './client.ts';
import { asociarInfluencerACampana } from './campaign-influencers.ts';
import { crearEnvio, transicionarEnvio } from './shipments.ts';
import { dia, unico } from './ops-test-support.ts';
import {
  autorizarCampanaParaTcl,
  exportarCampanaParaTcl,
  listarCampanasParaTcl,
  obtenerBriefParaTcl,
  obtenerInfluencersParaTcl,
  obtenerOperacionParaTcl,
  obtenerProyeccionTclDeCampana,
} from './tcl-projection.ts';
import {
  type EscenarioDeOperacion,
  asegurarUsuarioDePrueba,
  crearAcuerdoDePrueba,
  crearEscenarioDeOperacion,
  limpiarEscenarioDeOperacion,
} from './test-utils.ts';

let op: EscenarioDeOperacion;

beforeAll(async () => {
  op = await crearEscenarioDeOperacion('QA F9 aislamiento', { conAcuerdoAjeno: false });
  await query(`UPDATE campaigns SET visibility = 'tcl' WHERE id = $1`, [op.campanaId]);
}, 120_000);
afterAll(async () => {
  await limpiarEscenarioDeOperacion(op);
  await closePool();
});

describe('QA F9 · (1) aislamiento: solo la organización de TIPO `cliente` entra a la proyección TCL', () => {
  it('un usuario `cliente` dentro de una organización AGENCIA no lista, ve ni exporta la campaña tcl de SmartPR (corregido)', async () => {
    const otroCliente = await asegurarUsuarioDePrueba(
      'cliente-qa-f9@otraagencia.co',
      'Otro cliente QA',
      'cliente',
      op.ajeno.organizationId,
    );
    const lista = await listarCampanasParaTcl(otroCliente);
    expect(lista.ok && lista.value.map((c) => c.id), 'cliente de otra org lista campaña ajena').not.toContain(
      op.campanaId,
    );
    expect((await obtenerProyeccionTclDeCampana(otroCliente, op.campanaId)).ok).toBe(false);
    expect((await exportarCampanaParaTcl(otroCliente, op.campanaId, 'json')).ok).toBe(false);
    expect((await obtenerBriefParaTcl(otroCliente, op.campanaId)).ok).toBe(false);
    expect((await obtenerInfluencersParaTcl(otroCliente, op.campanaId)).ok).toBe(false);
    // la lista no falla: viene VACÍA
    const l = await listarCampanasParaTcl(otroCliente);
    expect(l.ok && l.value).toEqual([]);
  });
  it('ALCANCE RESTANTE (contrato DEC-050): la campaña de OTRA agencia puesta en `tcl` SÍ la ve la organización cliente TCL', async () => {
    // `campaigns` no lleva una organización cliente propia: `tcl|compartida` es la compartición explícita con «el»
    // cliente. Lo que se cierra es que un `cliente` dentro de una organización AGENCIA entre (ver el test anterior);
    // multi-cliente genérico (un cliente por campaña) queda fuera de alcance y declarado en DEC-050.
    await query(`UPDATE campaigns SET visibility = 'tcl' WHERE id = $1`, [op.campanaAjenaId]);
    try {
      const a = await autorizarCampanaParaTcl(op.cliente, op.campanaAjenaId, ['campaign:read_client']);
      expect(a.ok, 'visible por contrato para la organización cliente TCL').toBe(true);
    } finally {
      await query(`UPDATE campaigns SET visibility = 'interna' WHERE id = $1`, [op.campanaAjenaId]);
    }
  });
});

describe('QA F9 · (2) canal lateral: ¿se deduce el modo de compensación del resumen operativo?', () => {
  it('fee / barter / mixto sin avance de producto producen el MISMO resumen visible; con entrega parcial solo `productoRecibido` delata que hay producto comprometido (P3 ACEPTADO)', async () => {
    const { valentinaRios: rios, valentinaGomez: gomez, diego } = op.participaciones;
    await crearAcuerdoDePrueba(op.admin, { campaignInfluencerId: diego, mode: 'fee' });
    await crearAcuerdoDePrueba(op.admin, {
      campaignInfluencerId: gomez,
      mode: 'barter',
      campaignProductId: op.productos.pro,
      quantity: 2,
    });
    await crearAcuerdoDePrueba(op.admin, {
      campaignInfluencerId: rios,
      mode: 'mixed',
      campaignProductId: op.productos.p80,
      quantity: 2,
    });
    const ver = async () => {
      const r = await obtenerOperacionParaTcl(op.cliente, op.campanaId);
      if (!r.ok) throw new Error('op');
      const por = (id: string) => {
        const x = r.value.find((o) => o.participacionId === id)!;
        return { etapa: x.etapa, productoRecibido: x.productoRecibido, guion: x.guion.estado };
      };
      return { fee: por(diego), barter: por(gomez), mixto: por(rios) };
    };
    const inicial = await ver();
    expect(inicial.fee).toEqual(inicial.barter);
    expect(inicial.barter).toEqual(inicial.mixto);

    // Entrega PARCIAL de 1 de 2 unidades al barter: `productoRecibido = parcial` solo existe si HAY compromiso de
    // producto (es decir, el acuerdo no es solo fee).
    const envio = await crearEnvio(op.operativo, {
      campaignInfluencerId: gomez,
      items: [{ campaignProductId: op.productos.pro, quantity: 1 }],
      idempotencyKey: unico('envio'),
    });
    if (!envio.ok) throw new Error(envio.error.message);
    let s = envio.value.envio;
    for (const to of ['prepared', 'shipped', 'delivered'] as const) {
      const t = await transicionarEnvio(op.operativo, {
        shipmentId: s.id,
        to,
        expectedSeq: s.rowSeq,
        idempotencyKey: unico(to),
        ...(to === 'shipped' ? { happenedOn: dia(2) } : {}),
        ...(to === 'delivered' ? { happenedOn: dia(1) } : {}),
      });
      if (!t.ok) throw new Error(`${to}: ${t.error.message}`);
      s = t.value.envio;
    }
    const tras = await ver();
    // P3 ACEPTADO (no se corrige): «parcial» revela que hay producto comprometido > entregado, es decir, que el
    // acuerdo NO es solo fee. Es un canal lateral mínimo e inherente a mostrar «producto recibido sí/no/parcial»
    // (valor de negocio central para TCL: saber cuánto de lo enviado llegó). Colapsar «parcial» en «no» destruiría
    // esa señal sin cerrar el canal (la etapa y el total de unidades seguirían delatando el avance). No sale monto,
    // modo ni cantidad comprometida. Se fija el comportamiento aceptado para que un cambio sea deliberado.
    expect(tras.barter.productoRecibido).toBe('parcial');
    expect(tras.fee.productoRecibido).toBe('no');
  });
});

void asociarInfluencerACampana;
void obtenerBriefParaTcl;
void obtenerInfluencersParaTcl;
