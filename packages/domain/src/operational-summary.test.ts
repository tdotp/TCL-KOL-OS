import { describe, expect, it } from 'vitest';
import { ROLES } from './types';
import type { Role } from './types';
import {
  CAPACIDAD_POR_SECCION,
  SECCIONES_OPERATIVAS,
  calcularProgresoDeProductos,
  componerResumenOperativo,
  contarDocumentos,
  cumpleFiltrosOperativos,
  derivarEstadoDeContenido,
  derivarEstadoLogistico,
  derivarPagoDeParticipacion,
  esLogisticaPendiente,
  esPagoPendiente,
  puedeVerResumenOperativo,
  resumirAcuerdo,
  seccionesPermitidas,
  validarFiltrosOperativos,
} from './operational-summary';

describe('secciones por rol', () => {
  it('cada sección exige su capacidad (y todo el resumen, operations:read)', () => {
    expect(CAPACIDAD_POR_SECCION).toEqual({
      acuerdo: 'agreement:read',
      logistica: 'shipment:read',
      facturacion_pagos: 'finance:read',
      contenido: 'deliverable:read',
      kpi: 'kpi:read',
    });
  });

  it('matriz rol x sección', () => {
    const todas = [...SECCIONES_OPERATIVAS];
    expect(seccionesPermitidas('admin')).toEqual(todas);
    expect(seccionesPermitidas('director')).toEqual(todas);
    expect(seccionesPermitidas('operativo')).toEqual(todas);
    // El consultor ve acuerdo (sin montos), logística, contenido y KPI; NO facturación/pagos.
    expect(seccionesPermitidas('consultor')).toEqual(['acuerdo', 'logistica', 'contenido', 'kpi']);
    for (const r of ['analista', 'legal', 'cliente'] as const) {
      expect(seccionesPermitidas(r)).toEqual([]);
      expect(puedeVerResumenOperativo(r)).toBe(false);
    }
  });

  it('todos los roles definidos están cubiertos por la matriz', () => {
    const roles = ROLES as readonly Role[];
    for (const r of roles) expect(Array.isArray(seccionesPermitidas(r))).toBe(true);
  });
});

describe('estado logístico derivado', () => {
  it('sin envíos', () => {
    expect(derivarEstadoLogistico([])).toEqual({ estado: 'sin_envio', abiertos: 0, ultimoEstado: null });
  });
  it('abiertos: pendiente hasta que alguno sale; luego en tránsito', () => {
    expect(derivarEstadoLogistico(['pending'])).toMatchObject({ estado: 'pendiente', abiertos: 1 });
    expect(derivarEstadoLogistico(['prepared'])).toMatchObject({ estado: 'pendiente', abiertos: 1 });
    expect(derivarEstadoLogistico(['shipped'])).toMatchObject({ estado: 'en_transito', abiertos: 1 });
    expect(derivarEstadoLogistico(['delivered', 'pending'])).toMatchObject({
      estado: 'pendiente',
      abiertos: 1,
      ultimoEstado: 'pending',
    });
  });
  it('sin abiertos: entregado si alguno llegó; si no, el terminal más reciente', () => {
    expect(derivarEstadoLogistico(['delivered'])).toMatchObject({ estado: 'entregado', abiertos: 0 });
    expect(derivarEstadoLogistico(['returned', 'delivered'])).toMatchObject({ estado: 'entregado' });
    expect(derivarEstadoLogistico(['returned'])).toMatchObject({ estado: 'devuelto' });
    expect(derivarEstadoLogistico(['failed'])).toMatchObject({ estado: 'fallido' });
    expect(derivarEstadoLogistico(['cancelled'])).toMatchObject({ estado: 'cancelado' });
    expect(derivarEstadoLogistico(['failed', 'cancelled'])).toMatchObject({
      estado: 'cancelado',
      ultimoEstado: 'cancelled',
    });
  });
  it('«pendiente» depende de abiertos y de si hay compromisos', () => {
    const base = { abiertos: 0, tieneCompromisos: false };
    expect(esLogisticaPendiente({ ...base, estado: 'sin_envio' })).toBe(false);
    expect(esLogisticaPendiente({ ...base, estado: 'sin_envio', tieneCompromisos: true })).toBe(true);
    expect(esLogisticaPendiente({ ...base, estado: 'pendiente', abiertos: 1 })).toBe(true);
    expect(esLogisticaPendiente({ ...base, estado: 'entregado', tieneCompromisos: true })).toBe(false);
    expect(esLogisticaPendiente({ ...base, estado: 'devuelto', tieneCompromisos: true })).toBe(true);
    expect(esLogisticaPendiente({ ...base, estado: 'cancelado' })).toBe(false);
  });
});

describe('progreso por producto: comprometido ≠ enviado ≠ entregado', () => {
  it('distingue las tres cantidades y no cuenta lo devuelto, fallido, cancelado o aún no enviado', () => {
    const r = calcularProgresoDeProductos(
      [{ campaignProductId: 'p1', nombre: 'P80', quantity: 5 }],
      [
        { campaignProductId: 'p1', nombre: 'P80', status: 'delivered', quantity: 2 },
        { campaignProductId: 'p1', nombre: 'P80', status: 'shipped', quantity: 1 },
        { campaignProductId: 'p1', nombre: 'P80', status: 'prepared', quantity: 1 },
        { campaignProductId: 'p1', nombre: 'P80', status: 'returned', quantity: 7 },
        { campaignProductId: 'p1', nombre: 'P80', status: 'failed', quantity: 7 },
        { campaignProductId: 'p1', nombre: 'P80', status: 'cancelled', quantity: 7 },
      ],
    );
    expect(r).toEqual([
      { campaignProductId: 'p1', nombre: 'P80', comprometido: 5, enviado: 3, entregado: 2 },
    ]);
  });
  it('un producto enviado sin compromiso aparece con comprometido 0', () => {
    const r = calcularProgresoDeProductos(
      [],
      [{ campaignProductId: 'p2', nombre: 'Pro', status: 'delivered', quantity: 1 }],
    );
    expect(r).toEqual([
      { campaignProductId: 'p2', nombre: 'Pro', comprometido: 0, enviado: 1, entregado: 1 },
    ]);
  });
});

describe('pago derivado', () => {
  it('barter puro ⇒ not_applicable, jamás pendiente (ni con una obligación mal sembrada)', () => {
    expect(
      derivarPagoDeParticipacion({ modo: 'barter', obligacion: 'not_applicable', documentos: [] }),
    ).toEqual({
      seguimiento: 'not_applicable',
      obligacion: 'not_applicable',
    });
    const defensa = derivarPagoDeParticipacion({
      modo: 'barter',
      obligacion: 'pending',
      documentos: ['registered'],
    });
    expect(defensa.seguimiento).toBe('not_applicable');
    expect(esPagoPendiente(defensa.seguimiento)).toBe(false);
  });
  it('fee/mixed recorren pending_document → document_received → pending_payment → reported_paid', () => {
    const d = (documentos: Parameters<typeof derivarPagoDeParticipacion>[0]['documentos']) =>
      derivarPagoDeParticipacion({ modo: 'mixed', obligacion: 'pending', documentos }).seguimiento;
    expect(d([])).toBe('pending_document');
    expect(d(['rejected', 'voided'])).toBe('pending_document');
    expect(d(['registered'])).toBe('document_received');
    expect(d(['validated'])).toBe('pending_payment');
    expect(
      derivarPagoDeParticipacion({ modo: 'fee', obligacion: 'reported_paid', documentos: ['validated'] })
        .seguimiento,
    ).toBe('reported_paid');
    expect(esPagoPendiente('pending_document')).toBe(true);
    expect(esPagoPendiente('pending_payment')).toBe(true);
    expect(esPagoPendiente('reported_paid')).toBe(false);
    expect(esPagoPendiente('not_applicable')).toBe(false);
    expect(esPagoPendiente(null)).toBe(false);
  });
  it('sin acuerdo no hay seguimiento', () => {
    expect(derivarPagoDeParticipacion({ modo: null, obligacion: null, documentos: [] })).toEqual({
      seguimiento: null,
      obligacion: null,
    });
  });
  it('cuenta documentos por estado', () => {
    expect(contarDocumentos(['registered', 'validated', 'validated', 'voided'])).toEqual({
      registrados: 1,
      validados: 2,
      rechazados: 0,
      anulados: 1,
    });
  });
});

describe('contenido derivado', () => {
  it('estado de la participación a partir de sus entregables', () => {
    expect(derivarEstadoDeContenido([]).estado).toBe('sin_entregables');
    expect(derivarEstadoDeContenido(['aprobado', 'aprobado']).estado).toBe('aprobado');
    expect(derivarEstadoDeContenido(['aprobado', 'cambios_solicitados']).estado).toBe('cambios_solicitados');
    expect(derivarEstadoDeContenido(['aprobado', 'en_curso']).estado).toBe('en_curso');
    expect(derivarEstadoDeContenido(['aprobado_con_nueva_en_revision']).estado).toBe('en_curso');
    expect(derivarEstadoDeContenido(['sin_guion', 'sin_guion']).estado).toBe('sin_guion');
    expect(derivarEstadoDeContenido(['aprobado', 'sin_guion']).estado).toBe('parcial');
    expect(derivarEstadoDeContenido(['aprobado', 'sin_guion', 'en_curso'])).toMatchObject({
      entregables: 3,
      porEstado: { aprobado: 1, sin_guion: 1, en_curso: 1, cambios_solicitados: 0 },
    });
  });
});

describe('composición: las secciones sin permiso NO existen', () => {
  const partes = {
    acuerdo: resumirAcuerdo({ status: 'active', compensationType: 'mixed', currentVersion: 2 }),
    logistica: {
      estado: 'pendiente' as const,
      abiertos: 1,
      ultimoEstado: 'pending' as const,
      comprometidas: 2,
      enviadas: 0,
      entregadas: 0,
      tienePii: false,
    },
    facturacion: { documentos: { registrados: 0, validados: 0, rechazados: 0, anulados: 0 } },
    pago: { seguimiento: 'pending_document' as const, obligacion: 'pending' as const },
    contenido: derivarEstadoDeContenido(['en_curso']),
    kpi: { cualquier: 'cosa' },
  };

  it('admin, director y operativo ven las cinco secciones', () => {
    for (const r of ['admin', 'director', 'operativo'] as const) {
      expect(Object.keys(componerResumenOperativo(r, partes)).sort()).toEqual(
        ['acuerdo', 'contenido', 'facturacion', 'kpi', 'logistica', 'pago'].sort(),
      );
    }
  });
  it('el consultor no tiene facturación ni pago (claves ausentes, no null)', () => {
    const r = componerResumenOperativo('consultor', partes);
    expect('facturacion' in r).toBe(false);
    expect('pago' in r).toBe(false);
    expect(Object.keys(r).sort()).toEqual(['acuerdo', 'contenido', 'kpi', 'logistica']);
  });
  it('analista, legal y cliente: nada', () => {
    for (const r of ['analista', 'legal', 'cliente'] as const) {
      expect(componerResumenOperativo(r, partes)).toEqual({});
    }
  });
  it('kpi null se conserva como null (la sección existe pero está vacía)', () => {
    expect(componerResumenOperativo('admin', { kpi: null })).toEqual({ kpi: null });
  });
  it('sin acuerdo', () => {
    expect(resumirAcuerdo(null)).toEqual({ estado: 'sin_acuerdo', modo: null, version: null });
  });
});

describe('filtros', () => {
  it('un filtro de una sección que el rol no ve se rechaza (no es una forma de leerla)', () => {
    const r = validarFiltrosOperativos('consultor', { pagoPendiente: true });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('FORBIDDEN_ROLE');
      expect(r.error.details).toMatchObject({ filter: 'pagoPendiente', capability: 'finance:read' });
    }
    expect(validarFiltrosOperativos('consultor', { logisticaPendiente: true, sinAcuerdo: true }).ok).toBe(
      true,
    );
    expect(validarFiltrosOperativos('consultor', { pagoPendiente: false }).ok).toBe(true);
    expect(validarFiltrosOperativos('operativo', { pagoPendiente: true }).ok).toBe(true);
    expect(validarFiltrosOperativos('analista', { sinAcuerdo: true }).ok).toBe(false);
  });
  it('un filtro que no es booleano es inválido', () => {
    const r = validarFiltrosOperativos('admin', { sinAcuerdo: 'si' as unknown as boolean });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('VALIDATION_FAILED');
  });
  it('se combinan con Y y no asumen secciones ausentes', () => {
    const datos = {
      acuerdo: { estado: 'active' as const },
      logistica: { estado: 'pendiente' as const, abiertos: 1 },
      pago: { seguimiento: 'pending_payment' as const },
    };
    expect(cumpleFiltrosOperativos(datos, { logisticaPendiente: true, pagoPendiente: true })).toBe(true);
    expect(cumpleFiltrosOperativos(datos, { sinAcuerdo: true })).toBe(false);
    expect(cumpleFiltrosOperativos({ acuerdo: { estado: 'sin_acuerdo' } }, { sinAcuerdo: true })).toBe(true);
    expect(cumpleFiltrosOperativos({}, { pagoPendiente: true })).toBe(false);
    expect(cumpleFiltrosOperativos({}, { logisticaPendiente: true })).toBe(false);
    expect(cumpleFiltrosOperativos({}, {})).toBe(true);
  });
});
