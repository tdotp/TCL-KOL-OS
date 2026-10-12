/**
 * QA adversarial F9 (independiente): evasiones de la política de texto seguro para TCL.
 * Cada caso es un texto con dinero / condiciones comerciales / contacto en una forma que la heurística debería
 * rechazar. Un caso que FALLA aquí = el texto SE SERVIRÍA a TCL (falso negativo = fuga).
 */
import { describe, expect, it } from 'vitest';
import { esTextoSeguroParaTcl, textoParaTcl } from './tcl-text-safety';
import { neutralizarFormulaCsv } from './tcl-export';

const DEBE_RECHAZARSE: ReadonlyArray<readonly [string, string]> = [
  // ── formatos de dinero pedidos por el encargo ──
  ['usd coma', 'USD 4,000'],
  ['millones con cifra', '4 millones'],
  ['cop pegado', 'COP$4.000.000'],
  ['dinero en letras', 'cuatro millones de pesos'],
  ['dinero en letras sin pesos', 'cuatro millones'],
  ['cuatro mil dolares', 'cuatro mil dolares'],
  ['cifra k + usd', 'Recibirá 4k USD por pieza'],
  ['cifra k', 'El creador cobra 4k'],
  ['cifra con mil', 'se acordaron 4 mil'],
  ['cifra de 4 digitos sin moneda', 'El acuerdo es de 4000 por reel'],
  ['cifra con un punto de miles', 'El acuerdo es de 400.000 por reel'],
  ['cifra con coma de miles', 'El acuerdo es de 4,000 por reel'],
  ['usd sin cifra pegada', 'dólares: cuatro mil'],
  ['four thousand dollars', 'four thousand dollars'],
  ['ten grand', 'ten grand per post'],
  // ── términos comerciales: variantes ──
  ['tarifa', 'Su tarifa es alta'],
  ['f-e-e', 'El f-e-e del creador'],
  ['f e e', 'El f e e del creador'],
  ['fee con cirilico', 'El fеe del creador'], // 'е' cirílica
  ['fee con zero width', 'El f\u200Bee del creador'],
  ['fee con soft hyphen', 'El f\u00ADee del creador'],
  ['fee con thin space', 'El f\u2009ee del creador'],
  ['fee con ancho completo', 'El ｆｅｅ del creador'],
  ['fee con griego', 'El ƒee del creador'],
  ['canjeado', 'Se canjeó el producto'],
  ['canjeo', 'Es un canjeo con la marca'],
  ['intercambio', 'Se hace un intercambio de producto por contenido'],
  ['a cambio de', 'Publica a cambio de producto'],
  ['paga', 'La marca le paga al creador'],
  ['pagado', 'Contenido pagado'],
  ['pagar', 'Hay que pagar al creador'],
  ['paid', 'This is a paid collaboration'],
  ['costo', 'El costo por pieza'],
  ['precio', 'El precio acordado'],
  ['cost', 'cost per post'],
  ['price', 'the price agreed'],
  ['inversion', 'La inversión en el creador'],
  ['remuneracion', 'La remuneración del creador'],
  ['salary', 'creator salary'],
  ['gratis', 'Contenido a cambio de producto gratis'],
  ['rate card', 'rate card del creador'],
  ['sponsored', 'sponsored deal'],
  ['contrato', 'Cláusula del contrato de exclusividad'],
  ['cuenta de cobro espacios', 'cuenta   de   cobro'],
  ['cuentas de cobro con nbsp', 'cuenta\u00A0de\u00A0cobro'],
  ['honorarios', 'honorarios'],
  ['facturacion', 'facturación mensual'],
  // ── contacto / identidad ──
  ['email', 'escribe a maria@example.com'],
  ['email con espacios', 'maria @ example . com'],
  ['telefono 10 digitos', '3001112233'],
  ['telefono con guiones', '300-111-2233'],
  ['telefono con espacios', '300 111 2233'],
  ['telefono con parentesis', '(300) 111-2233'],
  ['telefono texto', 'tres cero cero uno uno uno'],
  ['cedula', 'CC 1.234.567.890'],
  ['cedula con puntos', 'documento 52.123.456'],
  ['whatsapp', 'whatsapp +57 300 111 2233'],
  ['direccion', 'Calle 99 # 88-77'],
  ['direccion cl', 'Cl. 99 88-77'],
];

describe('QA F9 · textoSeguro: falsos negativos (cada fallo es una fuga potencial)', () => {
  for (const [nombre, texto] of DEBE_RECHAZARSE) {
    it(`rechaza: ${nombre} → «${texto}»`, () => {
      expect(esTextoSeguroParaTcl(texto), `SE SIRVE: «${texto}»`).toBe(false);
      expect(textoParaTcl(texto, 500)).toBeNull();
    });
  }
});

describe('QA F9 · CSV: neutralización de fórmulas', () => {
  const peligrosas = [
    '=1+1',
    '+1',
    '-1',
    '@SUM(A1)',
    '\t=1',
    '\r=1',
    '  =1',
    '\u00A0=1',
    '＝1+1',
    '＋1',
    '＠SUM(1)',
    "=cmd|' /C calc'!A0",
  ];
  for (const p of peligrosas) {
    it(`neutraliza ${JSON.stringify(p)}`, () => {
      const salida = neutralizarFormulaCsv(p);
      expect(salida.startsWith("'"), `queda activa: ${JSON.stringify(salida)}`).toBe(true);
    });
  }
});

describe('QA F9 · textoSeguro: costo acotado (ReDoS) sobre texto de 4000 caracteres adversarial', () => {
  const casos: Array<[string, string]> = [
    ['letras seguidas (regla email/arroba)', 'a'.repeat(4000)],
    ['cifras y puntos', '1.'.repeat(2000)],
    ['espacios y dígitos', '1 '.repeat(2000)],
    ['email incompleto', `${'a.'.repeat(1999)}@`],
    ['cedula repetida', 'cedula '.repeat(570)],
    ['direccion repetida', 'calle 1 '.repeat(500)],
  ];
  for (const [nombre, texto] of casos) {
    it(`${nombre}: < 250 ms`, () => {
      const t0 = performance.now();
      esTextoSeguroParaTcl(texto);
      const ms = performance.now() - t0;
      expect(ms, `${nombre} tardó ${ms.toFixed(0)} ms`).toBeLessThan(250);
    });
  }
  it('10.000 caracteres (límite analizable) < 1 s', () => {
    const t0 = performance.now();
    esTextoSeguroParaTcl('a'.repeat(9999));
    expect(performance.now() - t0).toBeLessThan(1000);
  });
});
