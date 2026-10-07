import { describe, expect, it } from 'vitest';
import {
  CLAVES_PROHIBIDAS_TCL,
  type EntradaPublicaDeOperacionParaTcl,
  clavesProhibidasEn,
  derivarEstadoDeGuionParaTcl,
  derivarProductoRecibido,
  esClaveProhibidaTcl,
  proyectarOperacionParaTcl,
} from './tcl-projection-operacion';

const ENTRADA: EntradaPublicaDeOperacionParaTcl = {
  participacionId: '00000000-0000-4000-8000-000000000001',
  nombreVisible: 'Valentina Sintética',
  unidadesComprometidas: 4,
  unidadesEntregadas: 4,
  entregablesTotales: 2,
  entregablesConGuionAprobado: 1,
  kpis: [
    { metric: 'views', unit: 'count', target: 100000, actual: 85000, achievement: 85 },
    { metric: 'engagement_rate', unit: 'percent', target: 4.7, actual: null, achievement: null },
  ],
};

function claves(valor: unknown, ruta = ''): string[] {
  if (Array.isArray(valor)) return valor.flatMap((v) => claves(v, ruta));
  if (typeof valor !== 'object' || valor === null) return [];
  return Object.entries(valor).flatMap(([k, v]) => [k, ...claves(v, ruta)]);
}

describe('lista de claves prohibidas', () => {
  it('incluye los términos del freeze', () => {
    for (const t of [
      'fee',
      'amount',
      'currency',
      'invoice',
      'billing',
      'payment',
      'cost',
      'shipping',
      'address',
      'phone',
      'document',
      'note',
      'evidence',
      'provenance',
      'tracking',
      'carrier',
      'pii',
      'finance',
    ]) {
      expect(CLAVES_PROHIBIDAS_TCL).toContain(t);
    }
  });
  it('detecta variantes de escritura y anidación', () => {
    expect(esClaveProhibidaTcl('shipping_cost')).toBe(true);
    expect(esClaveProhibidaTcl('claimedAmount')).toBe(true);
    expect(esClaveProhibidaTcl('Tracking-Ref')).toBe(true);
    expect(esClaveProhibidaTcl('metric')).toBe(false);
    expect(clavesProhibidasEn({ a: { b: [{ feeAmount: 1 }] } })).toEqual(['a.b[0].feeAmount']);
    expect(clavesProhibidasEn({ ok: 1 })).toEqual([]);
  });
});

describe('proyectarOperacionParaTcl', () => {
  it('produce la forma del contrato', () => {
    expect(proyectarOperacionParaTcl(ENTRADA)).toEqual({
      participacionId: ENTRADA.participacionId,
      nombreVisible: 'Valentina Sintética',
      productoRecibido: 'si',
      guion: { estado: 'parcial', aprobados: 1, total: 2 },
      produccion: 'desconocido',
      publicacion: 'desconocido',
      kpis: [
        { metric: 'views', unit: 'count', target: 100000, actual: 85000, achievement: 85 },
        { metric: 'engagement_rate', unit: 'percent', target: 4.7, actual: null, achievement: null },
      ],
    });
  });

  it('ninguna clave anidada del resultado coincide con las prohibidas', () => {
    const r = proyectarOperacionParaTcl(ENTRADA);
    expect(clavesProhibidasEn(r)).toEqual([]);
    for (const k of claves(r)) {
      for (const p of CLAVES_PROHIBIDAS_TCL) {
        expect(k.toLowerCase().includes(p), `la clave «${k}» contiene «${p}»`).toBe(false);
      }
    }
  });

  it('añadir claves prohibidas a la entrada (en cualquier nivel) NO las lleva a la salida', () => {
    const sucia = {
      ...ENTRADA,
      fee: 9876543,
      feeAmount: '9876543.00',
      currency: 'COP',
      invoice: 'F-1',
      billing: { documentNumber: 'X' },
      payment: 'reported_paid',
      shippingCost: 1,
      address: 'Calle 1 # 2-3',
      phone: '3001234567',
      document: '1234567890',
      note: 'nota interna',
      evidence: 'comprobante.pdf',
      provenance: 'sheet',
      trackingRef: 'GUIA-1',
      carrier: 'Servientrega',
      pii: true,
      finance: { x: 1 },
      kpis: [{ ...ENTRADA.kpis[0]!, costPerView: 1, provenance: 'x', note: 'n' }, ENTRADA.kpis[1]!],
    } as unknown as EntradaPublicaDeOperacionParaTcl;
    const r = proyectarOperacionParaTcl(sucia);
    expect(r).toEqual(proyectarOperacionParaTcl(ENTRADA));
    expect(clavesProhibidasEn(r)).toEqual([]);
    const texto = JSON.stringify(r);
    for (const centinela of [
      '9876543',
      'Calle 1',
      '3001234567',
      'GUIA-1',
      'Servientrega',
      'comprobante',
      'nota interna',
    ]) {
      expect(texto).not.toContain(centinela);
    }
    expect(Object.keys(r.kpis[0]!).sort()).toEqual(['achievement', 'actual', 'metric', 'target', 'unit']);
  });

  it('producto recibido: sí / no / parcial', () => {
    expect(derivarProductoRecibido(4, 4)).toBe('si');
    expect(derivarProductoRecibido(4, 5)).toBe('si');
    expect(derivarProductoRecibido(4, 2)).toBe('parcial');
    expect(derivarProductoRecibido(4, 0)).toBe('no');
    expect(derivarProductoRecibido(0, 0)).toBe('no');
    expect(derivarProductoRecibido(0, 1)).toBe('si');
  });

  it('estado de guion y valores inválidos', () => {
    expect(derivarEstadoDeGuionParaTcl(0, 0)).toBe('sin_entregables');
    expect(derivarEstadoDeGuionParaTcl(3, 0)).toBe('pendiente');
    expect(derivarEstadoDeGuionParaTcl(3, 3)).toBe('aprobado');
    expect(derivarEstadoDeGuionParaTcl(3, 9)).toBe('aprobado');
    const r = proyectarOperacionParaTcl({
      ...ENTRADA,
      entregablesTotales: -1,
      unidadesEntregadas: Number.NaN,
      kpis: [
        {
          metric: 'views',
          unit: 'count',
          target: Number.NaN,
          actual: Number.POSITIVE_INFINITY,
          achievement: 1,
        },
      ],
    });
    expect(r.guion).toEqual({ estado: 'sin_entregables', aprobados: 0, total: 0 });
    expect(r.productoRecibido).toBe('no');
    expect(r.kpis[0]).toMatchObject({ target: 0, actual: null, achievement: 1 });
  });

  it('producción y publicación siguen desconocidas', () => {
    const r = proyectarOperacionParaTcl(ENTRADA);
    expect(r.produccion).toBe('desconocido');
    expect(r.publicacion).toBe('desconocido');
  });
});
