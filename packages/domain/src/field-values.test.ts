/**
 * Sprint 5, Fase A — validación estructurada, en particular `PrecisedDate`
 * (DEC-026). Movida desde `packages/db/src/local-questions.ts` para que
 * `corregirCampo` (el editor manual) la exija también — antes solo la
 * exigía `responderPregunta` (preguntas locales).
 */

import { describe, expect, it } from 'vitest';
import { validarValorEstructurado } from './field-values';

describe('validarValorEstructurado — fecha (DEC-026)', () => {
  const key = 'practico.fecha_inicio';

  it('acepta una fecha exacta', () => {
    const r = validarValorEstructurado(key, {
      tipo: 'exacta',
      fecha: '2026-09-15',
      textoOriginal: '2026-09-15',
    });
    expect(r.ok).toBe(true);
  });

  it('acepta un mes', () => {
    const r = validarValorEstructurado(key, {
      tipo: 'mes',
      fecha: '2026-09',
      textoOriginal: 'Septiembre 2026',
    });
    expect(r.ok).toBe(true);
  });

  it('acepta un rango', () => {
    const r = validarValorEstructurado(key, {
      tipo: 'rango',
      inicio: '2026-10-01',
      fin: '2026-11-30',
      textoOriginal: 'Octubre-Noviembre 2026',
    });
    expect(r.ok).toBe(true);
  });

  it('acepta aproximada sin fecha exacta', () => {
    const r = validarValorEstructurado(key, { tipo: 'aproximada', textoOriginal: 'Segundo semestre' });
    expect(r.ok).toBe(true);
  });

  it('acepta pendiente_confirmar', () => {
    const r = validarValorEstructurado(key, { tipo: 'pendiente_confirmar', textoOriginal: 'Por definir' });
    expect(r.ok).toBe(true);
  });

  it('rechaza texto plano — el bug real que Demo B/A encontraron en el editor manual', () => {
    const r = validarValorEstructurado(key, '15 de septiembre de 2026');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.mensaje).toContain('DEC-026');
  });

  it('rechaza un tipo de precisión inválido', () => {
    const r = validarValorEstructurado(key, { tipo: 'como_sea', textoOriginal: 'x' });
    expect(r.ok).toBe(false);
  });

  it('rechaza "exacta" sin el campo "fecha"', () => {
    const r = validarValorEstructurado(key, { tipo: 'exacta', textoOriginal: '2026-09-15' });
    expect(r.ok).toBe(false);
  });

  it('rechaza "rango" sin "inicio" o "fin"', () => {
    expect(validarValorEstructurado(key, { tipo: 'rango', inicio: '2026-10-01' }).ok).toBe(false);
    expect(validarValorEstructurado(key, { tipo: 'rango', fin: '2026-11-30' }).ok).toBe(false);
  });

  it('rechaza null y undefined', () => {
    expect(validarValorEstructurado(key, null).ok).toBe(false);
    expect(validarValorEstructurado(key, undefined).ok).toBe(false);
  });

  it('rechaza un objeto sin "tipo"', () => {
    expect(validarValorEstructurado(key, { fecha: '2026-09-15' }).ok).toBe(false);
  });
});

describe('validarValorEstructurado — otros valueType del catálogo', () => {
  it('texto: rechaza vacío', () => {
    expect(validarValorEstructurado('contexto.situacion', '').ok).toBe(false);
    expect(validarValorEstructurado('contexto.situacion', '   ').ok).toBe(false);
  });

  it('texto: acepta contenido real', () => {
    expect(validarValorEstructurado('contexto.situacion', 'El mercado de gama media creció 12%').ok).toBe(
      true,
    );
  });

  it('enum: solo acepta valores declarados en el catálogo', () => {
    expect(validarValorEstructurado('objetivo.tipo', 'awareness').ok).toBe(true);
    expect(validarValorEstructurado('objetivo.tipo', 'inventado').ok).toBe(false);
  });

  it('lista: rechaza vacía o con elementos no-texto', () => {
    expect(validarValorEstructurado('practico.hitos', []).ok).toBe(false);
    expect(validarValorEstructurado('practico.hitos', ['Lanzamiento', 42]).ok).toBe(false);
    expect(validarValorEstructurado('practico.hitos', ['Lanzamiento']).ok).toBe(true);
  });

  it('lista_objetos: exige "descripcion" en cada elemento', () => {
    expect(validarValorEstructurado('mandatorios', [{ categoria: 'mensaje' }]).ok).toBe(false);
    expect(
      validarValorEstructurado('mandatorios', [{ categoria: 'mensaje', descripcion: 'Canal único: Alkosto' }])
        .ok,
    ).toBe(true);
  });

  it('una clave que no existe en el catálogo se rechaza', () => {
    const r = validarValorEstructurado('no.existe', 'cualquier cosa');
    expect(r.ok).toBe(false);
  });
});
