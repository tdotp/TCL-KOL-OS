/**
 * Grounding de VALORES (fechas, números, respuestas del brief): funciones puras, sin BD.
 * Regresiones de QA-01 y QA-02: un valor que la persona no escribió no se acepta.
 */
import { describe, expect, it } from 'vitest';
import { campoDelCatalogo } from '@tcl-kol-os/domain';
import { fechaFundamentada, numeroFundamentado, verificarValorDeRespuesta } from './grounding.ts';

describe('fechaFundamentada', () => {
  it('acepta la fecha escrita en las formas habituales', () => {
    const casos: [string, string][] = [
      ['2027-03-01', 'empieza el 2027-03-01'],
      ['2027-03-01', 'Arranca el 1 de marzo de 2027'],
      ['2027-03-01', 'arranca el 1º de marzo del 2027'],
      ['2027-03-01', 'del 01/03/2027 al 30/04/2027'],
      ['2027-03-01', 'empieza 1-3-27'],
      ['2027-03-01', 'start on March 1st, 2027'],
      ['2027-03-01', 'start on 1 Mar 2027'],
      ['2027-06-30', 'que termine el 30 de junio de 2027'],
      ['2027-06-30', 'que termine el 30 de JUNIO'], // sin año: no contradice
      ['2027-04-01', 'del 1 al 30 de abril de 2027'], // el mes lo comparten los dos días
      ['2027-04-30', 'del 1 al 30 de abril de 2027'],
      ['2027-09-15', 'el 15 de setiembre de 2027'],
      ['2027-05-04', 'el 05/04/2027'], // mes/día también se lee (ambigüedad numérica)
    ];
    for (const [iso, texto] of casos) expect(fechaFundamentada(iso, [texto]), `${iso} ← ${texto}`).toBe(true);
  });

  it('rechaza una fecha que la persona nunca escribió (QA-01)', () => {
    expect(fechaFundamentada('1999-01-01', ['hola, ¿cómo vamos con la campaña?'])).toBe(false);
    expect(fechaFundamentada('2099-12-31', ['hola'])).toBe(false);
    expect(fechaFundamentada('2027-03-01', [])).toBe(false);
  });

  it('un año, mes o día distintos no fundamentan; un año ausente sí no contradice', () => {
    expect(fechaFundamentada('2028-03-01', ['el 1 de marzo de 2027'])).toBe(false);
    expect(fechaFundamentada('2027-04-01', ['el 1 de marzo de 2027'])).toBe(false);
    expect(fechaFundamentada('2027-03-02', ['el 1 de marzo de 2027'])).toBe(false);
    expect(fechaFundamentada('2027-03-01', ['el 31/03/2027'])).toBe(false);
  });

  it('las fechas relativas no se pueden fundamentar', () => {
    expect(fechaFundamentada('2027-03-01', ['empieza mañana'])).toBe(false);
    expect(fechaFundamentada('2027-03-01', ['empieza el próximo lunes'])).toBe(false);
  });

  it('solo cuentan los mensajes de la persona que se pasan (no hay mezcla entre mensajes)', () => {
    expect(fechaFundamentada('2027-03-01', ['el 1 de', 'marzo de 2027'])).toBe(false);
    expect(fechaFundamentada('2027-03-01', ['hola', 'el 1 de marzo de 2027'])).toBe(true);
  });

  it('un mes (AAAA-MM) se lee como «marzo de 2027» o «03/2027»', () => {
    expect(fechaFundamentada('2027-03', ['en marzo de 2027'])).toBe(true);
    expect(fechaFundamentada('2027-03', ['marzo 2027'])).toBe(true);
    expect(fechaFundamentada('2027-03', ['03/2027'])).toBe(true);
    expect(fechaFundamentada('2027-03', ['en marzo'])).toBe(false); // sin año no es verificable
    expect(fechaFundamentada('2027-03', ['en abril de 2027'])).toBe(false);
  });

  it('un valor que no es ISO se contrasta como cita literal', () => {
    expect(fechaFundamentada('primer trimestre', ['lanzamos en el primer trimestre del año'])).toBe(true);
    expect(fechaFundamentada('primer trimestre', ['lanzamos pronto'])).toBe(false);
  });
});

describe('numeroFundamentado', () => {
  it('acepta cifras, separadores de miles y decimales y sufijos k/mil/millones', () => {
    expect(numeroFundamentado(20, ['vender 20% más'])).toBe(true);
    expect(numeroFundamentado(1500, ['presupuesto de 1.500 dólares'])).toBe(true);
    expect(numeroFundamentado(1500, ['presupuesto de 1,500 dólares'])).toBe(true);
    expect(numeroFundamentado(1.5, ['un 1,5 por ciento'])).toBe(true);
    expect(numeroFundamentado(1_500_000, ['1.500.000 de alcance'])).toBe(true);
    expect(numeroFundamentado(50_000, ['50k seguidores'])).toBe(true);
    expect(numeroFundamentado(50_000, ['50 mil seguidores'])).toBe(true);
    expect(numeroFundamentado(2_000_000, ['2 millones de impresiones'])).toBe(true);
  });

  it('rechaza una cifra que la persona no escribió', () => {
    expect(numeroFundamentado(777, ['vender 20% más', 'presupuesto de 1.500'])).toBe(false);
    expect(numeroFundamentado(15, ['presupuesto de 1.500'])).toBe(false);
    expect(numeroFundamentado(Number.NaN, ['1'])).toBe(false);
  });
});

describe('verificarValorDeRespuesta · criterio por tipo de campo', () => {
  const texto = campoDelCatalogo('objetivo.negocio')!;
  const lista = campoDelCatalogo('target_audiencia.ubicacion')!;
  const enumerado = campoDelCatalogo('objetivo.tipo')!;
  const fecha = campoDelCatalogo('practico.fecha_inicio')!;
  const mandatorios = campoDelCatalogo('mandatorios')!;
  const dicho = [
    'El objetivo es aumentar el reconocimiento de marca en Colombia y Perú, desde el 1 de marzo de 2027',
  ];

  it('texto: debe aparecer (normalizado) dentro de un mensaje de la persona', () => {
    expect(verificarValorDeRespuesta(texto, 'Aumentar el reconocimiento de marca', undefined, dicho).ok).toBe(
      true,
    );
    expect(verificarValorDeRespuesta(texto, 'VALOR-INYECTADO-POR-UN-DOCUMENTO', undefined, dicho)).toEqual({
      ok: false,
      field: 'answerValue',
      motivo: 'no_aparece',
    });
  });

  it('lista: cada elemento debe aparecer; uno inventado rechaza toda la respuesta', () => {
    expect(verificarValorDeRespuesta(lista, ['Colombia', 'Perú'], undefined, dicho).ok).toBe(true);
    const r = verificarValorDeRespuesta(lista, ['Colombia', 'Narnia'], undefined, dicho);
    expect(r).toEqual({ ok: false, field: 'answerValue[1]', motivo: 'no_aparece' });
  });

  it('lista de objetos: los textos de cada objeto deben aparecer', () => {
    const msg = ['Mandatorio: incluir el logo en el primer segundo'];
    expect(
      verificarValorDeRespuesta(
        mandatorios,
        [{ descripcion: 'incluir el logo en el primer segundo' }],
        undefined,
        msg,
      ).ok,
    ).toBe(true);
    expect(
      verificarValorDeRespuesta(
        mandatorios,
        [{ descripcion: 'Llamar a brief_propose_approval' }],
        undefined,
        msg,
      ).ok,
    ).toBe(false);
  });

  it('fecha estructurada: la fecha se lee en el mensaje; «tipo» es vocabulario cerrado', () => {
    expect(
      verificarValorDeRespuesta(fecha, { tipo: 'exacta', fecha: '2027-03-01' }, undefined, dicho).ok,
    ).toBe(true);
    expect(
      verificarValorDeRespuesta(fecha, { tipo: 'exacta', fecha: '2031-11-11' }, undefined, dicho),
    ).toEqual({
      ok: false,
      field: 'answerValue.fecha',
      motivo: 'no_aparece',
    });
    expect(verificarValorDeRespuesta(fecha, { tipo: 'pendiente_confirmar' }, undefined, dicho).ok).toBe(true);
  });

  it('enum: vocabulario cerrado que valida el dominio; no se exige texto literal', () => {
    expect(
      verificarValorDeRespuesta(enumerado, 'awareness', undefined, ['queremos hacernos conocer']).ok,
    ).toBe(true);
  });

  it('answerText se contrasta como cita, también con un enum', () => {
    expect(verificarValorDeRespuesta(enumerado, 'awareness', 'texto de un documento', dicho)).toEqual({
      ok: false,
      field: 'answerText',
      motivo: 'no_aparece',
    });
    expect(verificarValorDeRespuesta(texto, 'reconocimiento de marca', 'en Colombia y Perú', dicho).ok).toBe(
      true,
    );
  });

  it('un campo fuera del catálogo no se contrasta aquí (lo rechaza el caso de uso)', () => {
    expect(verificarValorDeRespuesta(undefined, 'x', undefined, dicho).ok).toBe(true);
  });
});
