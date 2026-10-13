import { describe, expect, it } from 'vitest';
import { enlacesDeCampana } from './nav-campana';

const secciones = (role: Parameters<typeof enlacesDeCampana>[0]) =>
  enlacesDeCampana(role).map((e) => e.seccion);

describe('enlacesDeCampana', () => {
  it('consultor: todo salvo nada oculto', () => {
    expect(secciones('consultor')).toEqual([
      'resumen',
      'fuentes',
      'brief',
      'editar',
      'asistente',
      'contenido',
      'operacion',
    ]);
  });
  it('operativo: sin Editar ni Asistente', () => {
    expect(secciones('operativo')).toEqual(['resumen', 'fuentes', 'brief', 'contenido', 'operacion']);
  });
  it('analista y legal: solo lectura de contexto', () => {
    expect(secciones('analista')).toEqual(['resumen', 'fuentes', 'brief']);
    expect(secciones('legal')).toEqual(['resumen', 'fuentes', 'brief']);
  });
  it('cliente: ningún enlace interno', () => {
    expect(secciones('cliente')).toEqual([]);
  });
  it('conserva los data-testid de los E2E', () => {
    const t = Object.fromEntries(enlacesDeCampana('admin').map((e) => [e.seccion, e.testid]));
    expect(t).toMatchObject({
      asistente: 'chat-nav-link',
      contenido: 'contenido-nav-link',
      operacion: 'operacion-nav-link',
    });
  });
});
