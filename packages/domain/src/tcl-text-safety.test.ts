import { describe, expect, it } from 'vitest';
import { categoriasDeTextoInseguroParaTcl, esTextoSeguroParaTcl, textoParaTcl } from './tcl-text-safety';

const INSEGUROS: ReadonlyArray<readonly [string, string]> = [
  // dinero
  ['moneda con símbolo', 'El influencer cobra $ 5.000.000'],
  ['moneda con símbolo pegado', 'Pagan $1500 por reel'],
  ['moneda al final', 'unos 1500€'],
  ['código de moneda', 'COP 4500000 por entregable'],
  ['código de moneda detrás', '2500 USD'],
  ['pesos', 'son 800 mil pesos'],
  ['millones', 'alrededor de 5 millones'],
  ['número agrupado', 'monto 12.500.000'],
  ['número agrupado con coma', 'monto 12,500,000'],
  ['racha larga', 'referencia 98765432'],
  // términos comerciales
  ['fee', 'El fee del creador'],
  ['FEE en mayúsculas', 'EL FEE ES CONFIDENCIAL'],
  ['canje', 'Es un canje de producto'],
  ['barter', 'barter deal'],
  ['tarifa', 'tarifa acordada'],
  ['honorarios', 'honorarios del creador'],
  ['factura', 'enviar la factura al cierre'],
  ['cuenta de cobro', 'adjuntar cuenta de cobro'],
  ['invoice', 'send the invoice'],
  ['compensation', 'compensation package'],
  ['presupuesto', 'presupuesto total de la campaña'],
  ['pago', 'pago a 30 días'],
  ['condiciones comerciales', 'Condiciones comerciales: exclusividad'],
  ['con tildes y ancho completo', 'ｆｅｅ del creador'],
  ['con caracteres invisibles', 'fe\u200Be del creador'],
  ['con acentos', 'Facturación mensual'],
  // contacto
  ['email', 'escribir a ana.rios@correo.com'],
  ['email disfrazado', 'ana (at) correo'],
  ['teléfono internacional', 'llamar al +57 300 123 4567'],
  ['teléfono 3-3-4', 'celular 300 123 4567'],
  ['teléfono compacto', 'celular 3001234567'],
  ['teléfono con paréntesis', 'tel (601) 234-5678'],
  // identidad
  ['cédula', 'cédula 1.020.304.050'],
  ['cc con número', 'C.C. 52123456'],
  ['nit', 'NIT 900123456-7'],
  ['pasaporte', 'pasaporte AB 123456'],
  // dirección
  ['calle', 'vive en la calle 45 con carrera 7'],
  ['carrera', 'Carrera 15 # 88-64'],
  ['numeral', 'oficina # 12-34'],
  ['dirección inglesa', 'at 221 Baker street'],
  ['address', 'shipping address on file'],
  ['domicilio', 'enviar al domicilio'],
];

const SEGUROS: ReadonlyArray<readonly [string, string]> = [
  ['mensaje de campaña', 'El P80 Pro lleva tu fotografía a otro nivel con su cámara de 200 MP.'],
  ['batería', 'Batería de 5000 mAh con carga rápida'],
  ['resolución y tasa', 'Pantalla 4K a 120 Hz'],
  ['tamaño de TV', 'Televisores QD-Mini LED de 55 y 65 pulgadas'],
  ['rango de edad', '25-35 años'],
  ['fecha ISO', 'Lanzamiento el 2026-10-11'],
  ['fecha dd/mm/aaaa', 'Entrega 11/10/2026'],
  ['rango de años', 'temporada 2026-2027'],
  ['hashtag', 'Mencionar el hashtag #P80Pro en la publicación.'],
  ['dirección de arte', 'La dirección de arte es minimalista'],
  ['seguidores', 'más de 50 mil seguidores'],
  ['porcentaje', 'engagement de 4.7%'],
  ['lista de tamaños', '55 65 75 85 pulgadas'],
  ['tono', 'Cercano, aspiracional y directo'],
  ['nombre de persona', 'Valentina Ríos'],
  ['handle', 'valentina.rios'],
];

describe('esTextoSeguroParaTcl · textos inseguros (se omite el campo completo)', () => {
  for (const [nombre, texto] of INSEGUROS) {
    it(`bloquea: ${nombre}`, () => {
      expect(esTextoSeguroParaTcl(texto), texto).toBe(false);
    });
  }
});

describe('esTextoSeguroParaTcl · textos de campaña legítimos', () => {
  for (const [nombre, texto] of SEGUROS) {
    it(`permite: ${nombre}`, () => {
      expect(esTextoSeguroParaTcl(texto), texto).toBe(true);
    });
  }
});

describe('categorías y límites', () => {
  it('informa las categorías sin repetirlas', () => {
    const c = categoriasDeTextoInseguroParaTcl('fee de $ 5.000.000, escribir a a@b.co');
    expect(new Set(c).size).toBe(c.length);
    expect(c).toEqual(expect.arrayContaining(['dinero', 'comercial', 'contacto']));
  });
  it('un texto que no es string o es gigantesco no es seguro', () => {
    expect(esTextoSeguroParaTcl(undefined as unknown as string)).toBe(false);
    expect(esTextoSeguroParaTcl('a'.repeat(10_001))).toBe(false);
  });
  it('textoParaTcl recorta, omite vacíos y respeta el largo máximo', () => {
    expect(textoParaTcl('  Hola  ')).toBe('Hola');
    expect(textoParaTcl('   ')).toBeNull();
    expect(textoParaTcl(42)).toBeNull();
    expect(textoParaTcl('x'.repeat(50), 10)).toBeNull();
    expect(textoParaTcl('fee 100')).toBeNull();
  });
  it('un texto largo y benigno se analiza en tiempo acotado', () => {
    const t = `${'palabra '.repeat(1200)}fin`;
    const inicio = Date.now();
    expect(esTextoSeguroParaTcl(t)).toBe(true);
    expect(Date.now() - inicio).toBeLessThan(1500);
  });
});
