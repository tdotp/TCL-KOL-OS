import { describe, expect, it } from 'vitest';
import {
  CLAVES_PROHIBIDAS_TCL,
  type EntradaPublicaDeOperacionParaTcl,
  clavesProhibidasEn,
  derivarEstadoDeGuionParaTcl,
  derivarEtapaParaTcl,
  derivarProductoRecibido,
  esClaveProhibidaTcl,
  proyectarOperacionParaTcl,
} from './tcl-projection-operacion';

const ENTRADA: EntradaPublicaDeOperacionParaTcl = {
  participacionId: '00000000-0000-4000-8000-000000000001',
  nombreVisible: 'Valentina Sintética',
  unidadesComprometidas: 4,
  unidadesEntregadas: 4,
  hayEnvioAbierto: false,
  entregablesTotales: 2,
  entregablesConGuionAprobado: 1,
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
    expect(esClaveProhibidaTcl('shippingcost')).toBe(true);
    expect(esClaveProhibidaTcl('feeAmount')).toBe(true);
    expect(clavesProhibidasEn({ a: { b: [{ feeAmount: 1 }] } })).toEqual(['a.b[0].feeAmount']);
    expect(clavesProhibidasEn({ ok: 1 })).toEqual([]);
  });
});

describe('proyectarOperacionParaTcl', () => {
  it('produce la forma del contrato', () => {
    expect(proyectarOperacionParaTcl(ENTRADA)).toEqual({
      participacionId: ENTRADA.participacionId,
      nombreVisible: 'Valentina Sintética',
      etapa: 'en_curso',
      productoRecibido: 'si',
      guion: { estado: 'parcial', aprobados: 1, total: 2 },
      produccion: 'no_disponible',
      publicacion: 'no_disponible',
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
      kpis: [{ metric: 'views', costPerView: 1, provenance: 'x', note: 'n' }],
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
    expect(Object.keys(r).sort()).toEqual([
      'etapa',
      'guion',
      'nombreVisible',
      'participacionId',
      'produccion',
      'productoRecibido',
      'publicacion',
    ]);
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
    });
    expect(r.guion).toEqual({ estado: 'sin_entregables', aprobados: 0, total: 0 });
    expect(r.productoRecibido).toBe('no');
  });

  it('producción y publicación: «no disponible» (no existe ese dominio; no se simula)', () => {
    const r = proyectarOperacionParaTcl(ENTRADA);
    expect(r.produccion).toBe('no_disponible');
    expect(r.publicacion).toBe('no_disponible');
  });

  it('un nombre con dinero, contacto o cifras largas se omite completo (null)', () => {
    for (const nombre of ['Ana fee 5 millones', 'Ana 3001234567', 'ana@correo.com', '']) {
      expect(proyectarOperacionParaTcl({ ...ENTRADA, nombreVisible: nombre }).nombreVisible).toBeNull();
    }
    expect(proyectarOperacionParaTcl({ ...ENTRADA, nombreVisible: 'Ana María Ríos' }).nombreVisible).toBe(
      'Ana María Ríos',
    );
  });
});

describe('etapa para TCL: tres valores', () => {
  const base = {
    unidadesComprometidas: 2,
    unidadesEntregadas: 0,
    hayEnvioAbierto: false,
    entregablesTotales: 2,
    entregablesConGuionAprobado: 0,
  };
  it('pendiente: nada ha avanzado', () => {
    expect(derivarEtapaParaTcl(base)).toBe('pendiente');
    expect(derivarEtapaParaTcl({ ...base, entregablesTotales: 0 })).toBe('pendiente');
  });
  it('en curso: algún avance (guion aprobado, envío abierto o producto recibido)', () => {
    expect(derivarEtapaParaTcl({ ...base, entregablesConGuionAprobado: 1 })).toBe('en_curso');
    expect(derivarEtapaParaTcl({ ...base, hayEnvioAbierto: true })).toBe('en_curso');
    expect(derivarEtapaParaTcl({ ...base, unidadesEntregadas: 1 })).toBe('en_curso');
  });
  it('listo: todo guion aprobado y producto recibido (o sin producto que enviar)', () => {
    expect(derivarEtapaParaTcl({ ...base, entregablesConGuionAprobado: 2, unidadesEntregadas: 2 })).toBe(
      'listo',
    );
    expect(derivarEtapaParaTcl({ ...base, unidadesComprometidas: 0, entregablesConGuionAprobado: 2 })).toBe(
      'listo',
    );
    expect(derivarEtapaParaTcl({ ...base, entregablesConGuionAprobado: 2, unidadesEntregadas: 1 })).toBe(
      'en_curso',
    );
  });
  it('sin entregables y producto recibido nunca es «listo» (falta el guion)', () => {
    expect(derivarEtapaParaTcl({ ...base, entregablesTotales: 0, unidadesEntregadas: 2 })).toBe('en_curso');
  });
});
