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
 * Normalización (fail-closed): NFKC, sin acentos, sin caracteres invisibles (ancho cero, guion blando…), todo
 * espacio Unicode → espacio simple, minúsculas y homoglifos comunes (cirílico/griego → latín: «е»→e, «ƒ»→f…).
 * Además se evalúa una variante FUSIONADA: las rachas de ≥ 2 fragmentos de ≤ 2 letras separados por cualquier
 * signo (f-e-e, f e e, f ee) se unen y se buscan palabras clave comerciales DENTRO de la fusión (sin límite de
 * palabra: «el f e e» → «elfee»). Las fechas ISO, dd/mm/aaaa y rangos de años se retiran antes de buscar
 * teléfonos y cifras. Dinero SIN dígito: números en palabras (ES/EN) seguidos de mil/millón/pesos/dólares/grand…
 * Un texto de más de 10 000 caracteres no se analiza: se trata como inseguro.
 *
 * Costo acotado: ninguna regla tiene prefijo no acotado; los correos se buscan alrededor de cada «@» (ventana
 * fija) y el espacio se colapsa antes de analizar, de modo que el tiempo es lineal en el largo del texto.
 */

export type CategoriaDeTextoInseguro = 'dinero' | 'comercial' | 'contacto' | 'identidad' | 'direccion';

const LARGO_MAXIMO_ANALIZABLE = 10_000;

const INVISIBLES = new RegExp('[\\u200B-\\u200F\\u202A-\\u202E\\u2060-\\u2064\\u00AD\\u180E\\uFEFF]', 'gu');

/** Homoglifos frecuentes (ya en minúscula y sin marcas) → letra latina. */
const HOMOGLIFOS: Readonly<Record<string, string>> = {
  а: 'a',
  в: 'b',
  с: 'c',
  ԁ: 'd',
  е: 'e',
  ƒ: 'f',
  ɡ: 'g',
  н: 'h',
  і: 'i',
  ј: 'j',
  к: 'k',
  м: 'm',
  о: 'o',
  р: 'p',
  ѕ: 's',
  т: 't',
  у: 'y',
  х: 'x',
  ѵ: 'v',
  α: 'a',
  β: 'b',
  ϲ: 'c',
  ε: 'e',
  ι: 'i',
  κ: 'k',
  ν: 'v',
  ο: 'o',
  ρ: 'p',
  τ: 't',
  υ: 'u',
  χ: 'x',
  ϳ: 'j',
  ѡ: 'w',
  ɑ: 'a',
  ո: 'n',
  ս: 'u',
};
const HOMOGLIFOS_RE = new RegExp(`[${Object.keys(HOMOGLIFOS).join('')}]`, 'gu');

function normalizar(texto: string): string {
  return texto
    .normalize('NFKC')
    .replace(INVISIBLES, '')
    .replace(/[\p{Z}\t\r\n]+/gu, ' ')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(HOMOGLIFOS_RE, (c) => HOMOGLIFOS[c] ?? c);
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

/** Números en palabras (ES/EN). */
const NUM =
  '(?:uno|una|un|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|once|doce|trece|catorce|quince|veinte|veinti[a-z]+|treinta|cuarenta|cincuenta|sesenta|setenta|ochenta|noventa|cien|ciento|doscientos|trescientos|cuatrocientos|quinientos|seiscientos|setecientos|ochocientos|novecientos|medio|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred)';
const ENLACE = `(?:${NUM}|mil|y|de|and|hundred)`;
const UNIDAD_DE_DINERO =
  '(?:millon(?:es)?|thousand|million|billion|grand|pesos?|dolares?|dollars?|usd|cop|euros?)';
/** Tras «4 mil» estos sustantivos indican una cantidad de cosas, no dinero. */
const COSAS =
  'seguidores|seguidoras|vistas|views|likes|personas|usuarios|unidades|visitas|impresiones|suscriptores|reproducciones|interacciones|fans|clientes|ventas|pantallas|equipos|dispositivos|tiendas|creadores|publicaciones|piezas|horas|metros|mah|hz|nits|pixeles|lumens|cuentas|followers|users|units|impressions|subscribers|hours';
const PIEZA =
  'reels?|posts?|pieza|piezas|video|videos|publicacion|publicaciones|historia|historias|story|stories|entregables?|mes|month|campana|contenido|tiktok|piece|content';
const DIGITOS_EN_PALABRAS =
  '(?:cero|uno|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|zero|one|two|three|four|five|six|seven|eight|nine)';

const REGLAS: ReadonlyArray<{ readonly categoria: CategoriaDeTextoInseguro; readonly patron: RegExp }> = [
  // ── dinero ──
  { categoria: 'dinero', patron: /[$€£¥]\s*\d|\d\s*[$€£¥]/u },
  {
    categoria: 'dinero',
    patron: new RegExp(
      `\\d[\\d.,\\s]{0,20}\\s*(?:mil\\s+|k\\s*)?(?:${MONEDA}|millon(?:es)?|mm)${SIN_LETRA_DESPUES}`,
      'u',
    ),
  },
  { categoria: 'dinero', patron: new RegExp(`${SIN_LETRA}(?:${MONEDA})\\s*\\$?\\s*\\d`, 'u') },
  { categoria: 'dinero', patron: /(?<!\d)\d{1,3}(?:[.,']\d{3}){2,}(?!\d)/u },
  { categoria: 'dinero', patron: /(?<!\d)\d{1,3}(?: \d{3}){2,}(?!\d)/u },
  { categoria: 'dinero', patron: /\d{7,}/u },
  // «4 mil» (salvo «50 mil seguidores») y «4k»/«4 k» seguido de moneda o de «por pieza»
  {
    categoria: 'dinero',
    patron: new RegExp(`${SIN_LETRA}\\d+(?:[.,]\\d+)?\\s*mil${SIN_LETRA_DESPUES}(?!\\s+(?:${COSAS}))`, 'u'),
  },
  {
    categoria: 'dinero',
    patron: new RegExp(
      `${SIN_LETRA}\\d+(?:[.,]\\d+)?\\s*k${SIN_LETRA_DESPUES}\\s*(?:${MONEDA}|por|per|c/u)`,
      'u',
    ),
  },
  // una cifra de ≥ 3 dígitos (o con separador de miles) «por reel / por post / por video…»
  {
    categoria: 'dinero',
    patron: new RegExp(
      `(?<!\\d)(?:\\d{3,}|\\d{1,3}(?:[.,]\\d{3})+)\\s*(?:por|per|c/u|cada)\\s+(?:${PIEZA})${SIN_LETRA_DESPUES}`,
      'u',
    ),
  },
  // dinero SIN dígito: «cuatro millones de pesos», «cuatro mil dólares», «four thousand dollars», «ten grand»
  {
    categoria: 'dinero',
    patron: new RegExp(
      `${SIN_LETRA}${NUM}(?:\\s+${ENLACE}){0,4}\\s+${UNIDAD_DE_DINERO}${SIN_LETRA_DESPUES}`,
      'u',
    ),
  },
  {
    categoria: 'dinero',
    patron: new RegExp(`${SIN_LETRA}(?:${MONEDA})\\W{0,3}${NUM}${SIN_LETRA_DESPUES}`, 'u'),
  },
  // ── términos comerciales ──
  {
    categoria: 'comercial',
    patron: palabras(
      [
        'fees?',
        'canj[a-z]*',
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
        'pag(?:a|as|an|amos|ar|ado|ada|ados|adas|o|os|ue|are|ara|aran|aba|aron|ando)',
        'pay|pays|paid|paying|payments?|payouts?',
        'cobr(?:o|os|a|an|ar|ado|amos)',
        'montos?',
        'retainer',
        'comision(?:es)?',
        'commissions?',
        'precios?',
        'prices?|pricing',
        'costos?',
        'costs?',
        'inversion(?:es)?',
        'invest(?:ment|ments|ed)',
        'remuneracion(?:es)?|remuneration',
        'salar(?:y|ies|io|ios)',
        'sueldos?',
        'wages?',
        'stipends?',
        'gratis|gratuit[oa]s?',
        'rate\\s+cards?',
        'sponsored|sponsorship',
        'contratos?|contratar|contracts?',
        'a\\s+cambio\\s+de|en\\s+cambio\\s+de|in\\s+exchange|exchange\\s+for',
        'intercambi[a-z]*|trueques?|swap',
        'condiciones\\s+(?:comerciales|economicas|del\\s+acuerdo|de\\s+pago|de\\s+canje)',
      ].join('|'),
    ),
  },
  // ── contacto ──
  { categoria: 'contacto', patron: palabras('whatsapp|wasap|telegram') },
  {
    categoria: 'contacto',
    patron: /(?<!\d)\+\d{1,3}[\s.-]?\(?\d{1,4}\)?[\s.-]?\d{3,4}[\s.-]?\d{3,4}(?!\d)/u,
  },
  { categoria: 'contacto', patron: /(?<!\d)\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}(?!\d)/u },
  { categoria: 'contacto', patron: /(?<!\d)\d{3}[\s.-]\d{7}(?!\d)/u },
  // «tres cero cero uno uno uno»: cinco o más dígitos dichos en palabras seguidos
  {
    categoria: 'contacto',
    patron: new RegExp(
      `${SIN_LETRA}(?:${DIGITOS_EN_PALABRAS}[ ,.-]{1,2}){4,}${DIGITOS_EN_PALABRAS}${SIN_LETRA_DESPUES}`,
      'u',
    ),
  },
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
  // abreviaturas cortas (Cl., Cll., Cr., Dg., Tr.) solo con la nomenclatura completa «99 88-77» / «99 # 88-77»
  {
    categoria: 'direccion',
    patron: new RegExp(
      `${SIN_LETRA}(?:cl|cll|cr|dg|tr|transv|av|ak|ac)\\.?\\s*\\d{1,3}[a-z]?\\s*(?:#|no\\.?|n°)?\\s*\\d{1,3}[a-z]?\\s*[-–]\\s*\\d{1,3}`,
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

/** Palabras clave que se buscan DENTRO de una fusión de fragmentos cortos (f-e-e, f ee), sin límite de palabra. */
const FUSIONADAS =
  /fees?|canj|barter|tarifa|honorario|factura|invoice|pago|paga|cobro|cobra|precio|costo|price|cost|paid|salary|salario|sueldo|monto|budget|presupuesto|remuneracion|compensa|retainer|comision|contrato|gratis|sponsor|intercambi|inversion/u;

/** Rachas de ≥ 2 fragmentos de 1–2 letras («f e e», «f-e-e», «f ee») unidas; ≥ 3 caracteres. */
function fusiones(n: string): string[] {
  const tokens = n.split(/[^a-z0-9]+/u).filter((t) => t !== '');
  const salida: string[] = [];
  let racha: string[] = [];
  const cerrar = (): void => {
    if (racha.length >= 2) {
      const unido = racha.join('');
      if (unido.length >= 3) salida.push(unido);
    }
    racha = [];
  };
  for (const t of tokens) {
    if (/^[a-z]{1,2}$/u.test(t)) racha.push(t);
    else cerrar();
  }
  cerrar();
  return salida;
}

const VENTANA_ANTES = 80;
const VENTANA_DESPUES = 120;
const MAXIMO_DE_ARROBAS = 25;
const CORREO = /[a-z0-9._%+-]{1,64} {0,3}@ {0,3}[a-z0-9-]{1,63}(?: {0,3}\. {0,3}[a-z0-9-]{1,63}){1,5}/u;
const CORREO_DISFRAZADO = /[a-z0-9._%+-]{1,64} {0,3}(?:\(at\)|\[at\]|\{at\}| arroba )\s{0,3}[a-z0-9-]{1,63}/u;

/** Correos: se mira una ventana fija alrededor de cada «@» (tiempo lineal; sin prefijo no acotado). */
function hayCorreo(n: string): boolean {
  let desde = 0;
  for (let i = 0; i < MAXIMO_DE_ARROBAS; i += 1) {
    const at = n.indexOf('@', desde);
    if (at === -1) break;
    if (CORREO.test(n.slice(Math.max(0, at - VENTANA_ANTES), at + VENTANA_DESPUES))) return true;
    desde = at + 1;
  }
  if (n.indexOf('@', desde) !== -1) return true; // demasiadas arrobas: no se confía
  if (/\((?:at)\)|\[at\]|\{at\}| arroba /u.test(n)) {
    const m = /\((?:at)\)|\[at\]|\{at\}| arroba /u.exec(n);
    const at = m?.index ?? 0;
    return CORREO_DISFRAZADO.test(n.slice(Math.max(0, at - VENTANA_ANTES), at + VENTANA_DESPUES));
  }
  return false;
}

/** Categorías por las que el texto NO es seguro para TCL (vacío = seguro). Sin repetidos. */
export function categoriasDeTextoInseguroParaTcl(texto: string): CategoriaDeTextoInseguro[] {
  if (typeof texto !== 'string') return ['comercial'];
  if (texto.length > LARGO_MAXIMO_ANALIZABLE) return ['comercial'];
  const normal = normalizar(texto);
  const n = sinFechas(normal);
  const halladas = new Set<CategoriaDeTextoInseguro>();
  for (const { categoria, patron } of REGLAS) {
    if (!halladas.has(categoria) && patron.test(n)) halladas.add(categoria);
  }
  if (!halladas.has('contacto') && hayCorreo(n)) halladas.add('contacto');
  if (!halladas.has('comercial') && fusiones(normal).some((f) => FUSIONADAS.test(f))) {
    halladas.add('comercial');
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
