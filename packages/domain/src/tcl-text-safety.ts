/**
 * Política de TEXTO SEGURO para TCL (V2 · Fase 9, DEC-050). Función PURA.
 *
 * Todo texto libre que una proyección TCL vaya a servir (nombres, etiquetas, valores del Brief…) pasa por aquí.
 * Si el texto contiene algo que TCL jamás debe recibir, el campo COMPLETO se omite (no se «limpia» ni se recorta
 * la parte mala: una redacción parcial de un texto sobre dinero sigue siendo un texto sobre dinero).
 *
 * Qué se considera inseguro (cada categoría es una heurística conservadora; falsos positivos ⇒ el campo se
 * omite, que es el error barato; falsos negativos son los que importan y por eso la proyección TCL NO depende
 * solo de esto: también usa una lista blanca de claves, excluye campos con evidencia histórica y comprueba las
 * claves de salida):
 *
 *   · `dinero`      cifras con moneda ($, €, COP, USD, «pesos», «millones»…), números agrupados de ≥ 1.000.000 y
 *                   cualquier racha de ≥ 7 dígitos (también cubre cédulas y teléfonos compactos).
 *   · `comercial`   términos de compensación y cobro: fee, canje, barter, tarifa, honorarios, factura,
 *                   cuenta de cobro, invoice, compensation, presupuesto/budget, pago/payment, cobro, monto,
 *                   retainer, comisión y «condiciones comerciales/económicas/del acuerdo/de pago».
 *   · `contacto`    correos electrónicos y teléfonos (con prefijo internacional o en grupos 3-3-4, 3-7).
 *   · `identidad`   cédula/NIT/DNI/pasaporte seguidos de su número.
 *   · `direccion`   direcciones postales (calle/carrera/avenida + número, «# 12-34», `address`, domicilio).
 *
 * Se analiza el texto normalizado (NFKC, sin acentos, sin caracteres invisibles, en minúsculas) para que no se
 * pueda esquivar con mayúsculas, tildes, ancho completo o espacios de ancho cero. Las fechas ISO, dd/mm/aaaa y
 * rangos de años se retiran antes de buscar teléfonos y cifras. Un texto de más de 10 000 caracteres no se
 * analiza: se trata como inseguro (acota el costo y no es un valor de proyección razonable).
 */

export type CategoriaDeTextoInseguro = 'dinero' | 'comercial' | 'contacto' | 'identidad' | 'direccion';

const LARGO_MAXIMO_ANALIZABLE = 10_000;

const INVISIBLES = new RegExp(
  '[\\u200B-\\u200F\\u2028\\u2029\\u202A-\\u202E\\u2060-\\u2064\\u00AD\\uFEFF]',
  'gu',
);

function normalizar(texto: string): string {
  return texto
    .normalize('NFKC')
    .replace(INVISIBLES, '')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase();
}

/** Fechas y rangos de años no son cifras ni teléfonos. */
function sinFechas(texto: string): string {
  return texto
    .replace(/\b\d{4}-\d{2}-\d{2}\b/gu, ' ')
    .replace(/\b\d{1,2}[/.]\d{1,2}[/.]\d{2,4}\b/gu, ' ')
    .replace(/\b(?:19|20)\d{2}\s*[-–/]\s*(?:19|20)\d{2}\b/gu, ' ');
}

const SIN_LETRA = '(?<![a-z0-9])';
const SIN_LETRA_DESPUES = '(?![a-z0-9])';

function palabras(alternativas: string): RegExp {
  return new RegExp(`${SIN_LETRA}(?:${alternativas})${SIN_LETRA_DESPUES}`, 'u');
}

const MONEDA = 'cop|usd|eur|mxn|us\\$|pesos?|dolares?|dollars?|euros?';

const REGLAS: ReadonlyArray<{ readonly categoria: CategoriaDeTextoInseguro; readonly patron: RegExp }> = [
  // ── dinero ──
  { categoria: 'dinero', patron: /[$€£¥]\s*\d|\d\s*[$€£¥]/u },
  {
    categoria: 'dinero',
    patron: new RegExp(
      `\\d[\\d.,\\s]{0,20}\\s*(?:mil\\s+)?(?:${MONEDA}|millon(?:es)?|mm)${SIN_LETRA_DESPUES}`,
      'u',
    ),
  },
  { categoria: 'dinero', patron: new RegExp(`${SIN_LETRA}(?:${MONEDA})\\s*\\$?\\s*\\d`, 'u') },
  { categoria: 'dinero', patron: /(?<!\d)\d{1,3}(?:[.,']\d{3}){2,}(?!\d)/u },
  { categoria: 'dinero', patron: /(?<!\d)\d{1,3}(?: \d{3}){2,}(?!\d)/u },
  { categoria: 'dinero', patron: /\d{7,}/u },
  // ── términos comerciales ──
  {
    categoria: 'comercial',
    patron: palabras(
      [
        'fees?',
        'canjes?',
        'canjear',
        'barter',
        'tarifas?',
        'honorarios?',
        'facturas?',
        'facturacion',
        'facturar',
        'cuentas?\\s+de\\s+cobro',
        'invoices?',
        'compensation',
        'compensacion(?:es)?',
        'presupuestos?',
        'budgets?',
        'pagos?',
        'payments?',
        'cobros?',
        'cobra(?:n|r)?',
        'montos?',
        'retainer',
        'comision(?:es)?',
        'commissions?',
        'condiciones\\s+(?:comerciales|economicas|del\\s+acuerdo|de\\s+pago|de\\s+canje)',
      ].join('|'),
    ),
  },
  // ── contacto ──
  { categoria: 'contacto', patron: /[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}/u },
  { categoria: 'contacto', patron: /[a-z0-9._%+-]+\s*(?:\(at\)|\[at\]|\sarroba\s)\s*[a-z0-9-]+/u },
  {
    categoria: 'contacto',
    patron: /(?<!\d)\+\d{1,3}[\s.-]?\(?\d{1,4}\)?[\s.-]?\d{3,4}[\s.-]?\d{3,4}(?!\d)/u,
  },
  { categoria: 'contacto', patron: /(?<!\d)\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}(?!\d)/u },
  { categoria: 'contacto', patron: /(?<!\d)\d{3}[\s.-]\d{7}(?!\d)/u },
  // ── identidad ──
  {
    categoria: 'identidad',
    patron: new RegExp(
      `${SIN_LETRA}(?:cedula|c\\.?\\s?c\\.?|nit|dni|pasaporte|passport|documento\\s+de\\s+identidad|identificacion)\\s*(?:n(?:o|um(?:ero)?)?\\.?|#)?\\s*:?\\s*[a-z]{0,3}\\s*\\d[\\d.\\s-]{4,}`,
      'u',
    ),
  },
  // ── dirección ──
  {
    categoria: 'direccion',
    patron: new RegExp(
      `${SIN_LETRA}(?:calle|carrera|cra|kra|kr|avenida|avda|av|transversal|diagonal|diag|autopista)\\.?\\s*\\d+`,
      'u',
    ),
  },
  { categoria: 'direccion', patron: /#\s*\d+[a-z]?\s*[-–]\s*\d+/u },
  {
    categoria: 'direccion',
    patron:
      /(?<!\d)\d{1,5}\s+[a-z]+\s+(?:street|st|avenue|ave|road|rd|boulevard|blvd|lane|ln|drive|dr)(?![a-z0-9])/u,
  },
  { categoria: 'direccion', patron: palabras('address|domicilio|apto|apartamento\\s*\\d+') },
];

/** Categorías por las que el texto NO es seguro para TCL (vacío = seguro). Sin repetidos. */
export function categoriasDeTextoInseguroParaTcl(texto: string): CategoriaDeTextoInseguro[] {
  if (typeof texto !== 'string') return ['comercial'];
  if (texto.length > LARGO_MAXIMO_ANALIZABLE) return ['comercial'];
  const n = sinFechas(normalizar(texto));
  const halladas = new Set<CategoriaDeTextoInseguro>();
  for (const { categoria, patron } of REGLAS) {
    if (!halladas.has(categoria) && patron.test(n)) halladas.add(categoria);
  }
  return [...halladas];
}

/** ¿Se puede servir este texto a TCL? Si no, el campo completo se omite. */
export function esTextoSeguroParaTcl(texto: string): boolean {
  return categoriasDeTextoInseguroParaTcl(texto).length === 0;
}

/** El texto recortado si es seguro y no está vacío; si no, `null` (campo omitido). */
export function textoParaTcl(texto: unknown, largoMaximo = 500): string | null {
  if (typeof texto !== 'string') return null;
  const t = texto.trim();
  if (t === '' || t.length > largoMaximo) return null;
  return esTextoSeguroParaTcl(t) ? t : null;
}
