import { describe, expect, it } from 'vitest';
import {
  AVISO_NOTAS_SIN_PII,
  campoDeOperacion,
  codigoDeOperacion,
  mensajeDeOperacion,
  permisosDeOperacion,
} from './operacion-comun.ts';

describe('mensajeDeOperacion', () => {
  it('los dos choques de concurrencia dan el mismo mensaje y el código STALE', () => {
    for (const reason of ['stale_transition', 'stale_version']) {
      const e = { code: 'RESOURCE_CONFLICT', message: 'x', details: { reason, currentSeq: 4 } };
      expect(mensajeDeOperacion(e)).toBe(
        'Otra persona cambió este registro; recarga la página e inténtalo de nuevo.',
      );
      expect(codigoDeOperacion(e)).toBe('STALE');
    }
  });

  it('ajeno e inexistente dan el mismo texto', () => {
    expect(mensajeDeOperacion({ code: 'RESOURCE_NOT_FOUND', message: 'a' })).toBe(
      mensajeDeOperacion({ code: 'RESOURCE_NOT_FOUND', message: 'b', details: { x: 1 } }),
    );
  });

  it('un código desconocido nunca expone su mensaje', () => {
    expect(mensajeDeOperacion({ code: 'AGENT_TOOL_FAILED', message: 'stack interno' })).not.toContain(
      'stack',
    );
  });

  it('el chat no registra estado operativo', () => {
    expect(mensajeDeOperacion({ code: 'HUMAN_CONFIRMATION_REQUIRED', message: 'x' })).toContain(
      'ni el chat ni el sistema',
    );
  });

  it('el campo de un error solo se acepta con forma de identificador', () => {
    expect(campoDeOperacion({ code: 'VALIDATION_FAILED', message: '', details: { field: 'amount' } })).toBe(
      'feeAmount',
    );
    expect(
      campoDeOperacion({ code: 'VALIDATION_FAILED', message: '', details: { field: '<script>' } }),
    ).toBeUndefined();
  });
});

describe('permisosDeOperacion', () => {
  it('el cliente no ve nada; el consultor no ve dinero ni PII; solo admin y operativo ven PII', () => {
    expect(permisosDeOperacion('cliente')).not.toMatchObject({ verOperacion: true });
    const consultor = permisosDeOperacion('consultor');
    expect(consultor).toMatchObject({
      verOperacion: true,
      verFinanzas: false,
      verPiiResumen: false,
      gestionarObjetivosKpi: true,
    });
    expect(permisosDeOperacion('director')).toMatchObject({
      verFinanzas: true,
      revelarPii: false,
      reportarPago: false,
    });
    expect(permisosDeOperacion('operativo')).toMatchObject({
      revelarPii: true,
      gestionarPii: true,
      reportarPago: true,
    });
    expect(permisosDeOperacion('admin')).toMatchObject({ revelarPii: true, medirKpi: true });
  });
});

describe('aviso de notas', () => {
  it('pide no escribir datos personales', () => {
    expect(AVISO_NOTAS_SIN_PII.toLowerCase()).toContain('datos personales');
  });
});
