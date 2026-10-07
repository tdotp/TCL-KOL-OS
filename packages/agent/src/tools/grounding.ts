/**
 * Grounding de VALORES (D11): fechas, números y respuestas estructuradas que el modelo
 * quiere registrar deben salir de lo que la PERSONA escribió en esta conversación.
 *
 * Todo se contrasta SOLO con los mensajes de la persona (`textosDelActor`), nunca con
 * contenido de fuentes: un valor que viene de un documento (o de la imaginación del
 * modelo) y no aparece en lo que la persona dijo no se registra como dato suyo.
 *
 * Funciones puras, sin I/O. El executor las usa para `grounding.dateFields` y la tool
 * `brief_answer_question` para el valor de su respuesta (criterio por tipo de campo en
 * `verificarValorDeRespuesta`).
 */

import { type CampoDelCatalogo, normalizarParaCita, verificarCitaLiteral } from '@tcl-kol-os/domain';

/** Largo máximo de un valor textual contrastado (el esquema de la tool ya lo acota antes). */
const VALOR_MAX_CHARS = 5_000;

// ─────────────────────────── Meses ─────────────────────────────────────────────

/** Mes (1-12) por nombre sin acentos, en español e inglés (completo y abreviado). */
const MESES: Readonly<Record<string, number>> = {
  enero: 1,
  ene: 1,
  january: 1,
  jan: 1,
  febrero: 2,
  feb: 2,
  february: 2,
  marzo: 3,
  mar: 3,
  march: 3,
  abril: 4,
  abr: 4,
  april: 4,
  apr: 4,
  mayo: 5,
  may: 5,
  junio: 6,
  jun: 6,
  june: 6,
  julio: 7,
  jul: 7,
  july: 7,
  agosto: 8,
  ago: 8,
  august: 8,
  aug: 8,
  septiembre: 9,
  setiembre: 9,
  sept: 9,
  sep: 9,
  set: 9,
  september: 9,
  octubre: 10,
  oct: 10,
  october: 10,
  noviembre: 11,
  nov: 11,
  november: 11,
  diciembre: 12,
  dic: 12,
  december: 12,
  dec: 12,
};

const MES_RE = Object.keys(MESES)
  .sort((a, b) => b.length - a.length)
  .join('|');
const MES_ALT = `(${MES_RE})(?![a-z])`;

/** Texto de un mensaje en minúsculas, sin acentos y con la normalización del grounding. */
function paraFechas(texto: string): string {
  return normalizarParaCita(texto).normalize('NFD').replace(/[̀-ͯ]/g, '');
}

const anio = (s: string | undefined): number | undefined => {
  if (s === undefined) return undefined;
  const n = Number(s);
  return s.length === 2 ? 2000 + n : n;
};

// ─────────────────────────── Fechas ────────────────────────────────────────────

const ISO_COMPLETA = /^(\d{4})-(\d{2})-(\d{2})$/;
const ISO_MES = /^(\d{4})-(\d{2})$/;

/**
 * ¿Aparece la fecha `iso` (`AAAA-MM-DD`, o `AAAA-MM` para un mes) en algún mensaje de
 * la persona, escrita en cualquiera de las formas habituales?
 *   · ISO literal (`2027-03-01`);
 *   · numérica (`01/03/2027`, `1-3-27`, `2027/03/01`; día/mes o mes/día);
 *   · con el mes en letras (`1 de marzo de 2027`, `1 marzo`, `marzo 1, 2027`);
 *   · rango compartiendo el mes (`del 1 al 30 de marzo de 2027`).
 * Un año ausente en el mensaje no contradice a la fecha (la persona dijo «el 1 de
 * marzo»); un año distinto sí. Un valor que no es una fecha ISO se contrasta como cita.
 * Las fechas relativas («mañana», «el próximo lunes») no se pueden fundamentar: la
 * persona debe dar la fecha concreta.
 */
export function fechaFundamentada(iso: string, textosDelActor: readonly string[]): boolean {
  const completa = ISO_COMPLETA.exec(iso.trim());
  const soloMes = completa === null ? ISO_MES.exec(iso.trim()) : null;
  if (completa === null && soloMes === null) {
    return verificarCitaLiteral(iso, textosDelActor, { minChars: 1, maxChars: VALOR_MAX_CHARS }).ok;
  }
  const y = Number((completa ?? soloMes)![1]);
  const m = Number((completa ?? soloMes)![2]);
  const d = completa === null ? undefined : Number(completa[3]);

  const mismoAnio = (a: number | undefined): boolean => a === undefined || a === y;

  for (const mensaje of textosDelActor) {
    const t = paraFechas(mensaje);
    if (t.includes(iso.trim())) return true;

    if (d !== undefined) {
      // numérica día/mes/año o mes/día/año (el año va al final)
      for (const x of t.matchAll(/(?<!\d)(\d{1,2})[/.-](\d{1,2})[/.-](\d{4}|\d{2})(?!\d)/g)) {
        const a = Number(x[1]);
        const b = Number(x[2]);
        if (((a === d && b === m) || (a === m && b === d)) && anio(x[3]) === y) return true;
      }
      // numérica año/mes/día
      for (const x of t.matchAll(/(?<!\d)(\d{4})[/.-](\d{1,2})[/.-](\d{1,2})(?!\d)/g)) {
        if (Number(x[1]) === y && Number(x[2]) === m && Number(x[3]) === d) return true;
      }
      // «1 de marzo (de) 2027»
      const diaMes = new RegExp(
        `(?<!\\d)(\\d{1,2})(?:o|er|st|nd|rd|th)?\\s*(?:de\\s+|of\\s+)?${MES_ALT}\\.?(?:\\s*(?:de|del|,)?\\s*(\\d{4})(?!\\d))?`,
        'g',
      );
      for (const x of t.matchAll(diaMes)) {
        if (Number(x[1]) === d && MESES[x[2]!] === m && mismoAnio(anio(x[3]))) return true;
      }
      // «marzo 1(, 2027)»
      const mesDia = new RegExp(
        `${MES_ALT}\\.?\\s*(\\d{1,2})(?!\\d)(?:st|nd|rd|th)?(?:\\s*,?\\s*(\\d{4})(?!\\d))?`,
        'g',
      );
      for (const x of t.matchAll(mesDia)) {
        if (Number(x[2]) === d && MESES[x[1]!] === m && mismoAnio(anio(x[3]))) return true;
      }
      // «del 1 al 30 de marzo (de 2027)»: el mes lo comparten los dos días
      const rango = new RegExp(
        `(?<!\\d)(\\d{1,2})\\s*(?:al|a|y|-|hasta el|to|and)\\s*(\\d{1,2})\\s*(?:de\\s+|of\\s+)?${MES_ALT}\\.?(?:\\s*(?:de|del|,)?\\s*(\\d{4})(?!\\d))?`,
        'g',
      );
      for (const x of t.matchAll(rango)) {
        if ((Number(x[1]) === d || Number(x[2]) === d) && MESES[x[3]!] === m && mismoAnio(anio(x[4]))) {
          return true;
        }
      }
    } else {
      // mes: «marzo 2027», «marzo de 2027», «03/2027»
      const mesAnio = new RegExp(`${MES_ALT}\\.?\\s*(?:de|del|,)?\\s*(\\d{4})(?!\\d)`, 'g');
      for (const x of t.matchAll(mesAnio)) {
        if (MESES[x[1]!] === m && anio(x[2]) === y) return true;
      }
      for (const x of t.matchAll(/(?<!\d)(\d{1,2})[/.-](\d{4})(?!\d)/g)) {
        if (Number(x[1]) === m && Number(x[2]) === y) return true;
      }
      for (const x of t.matchAll(/(?<!\d)(\d{4})[/.-](\d{1,2})(?![\d/.-])/g)) {
        if (Number(x[1]) === y && Number(x[2]) === m) return true;
      }
    }
  }
  return false;
}

// ─────────────────────────── Números ───────────────────────────────────────────

/** Valores que puede significar un token numérico escrito por una persona (`1.500`, `1,5`, `50k`…). */
function candidatosNumericos(token: string, resto: string): number[] {
  const valores = new Set<number>();
  const agregar = (n: number): void => {
    if (Number.isFinite(n)) valores.add(n);
  };
  const sinSeparadores = token.replace(/[.,]/g, '');
  const puntos = (token.match(/\./g) ?? []).length;
  const comas = (token.match(/,/g) ?? []).length;
  if (puntos === 0 && comas === 0) {
    agregar(Number(token));
  } else if (puntos > 0 && comas > 0) {
    // el último separador es el decimal
    const ultimo = Math.max(token.lastIndexOf('.'), token.lastIndexOf(','));
    agregar(Number(`${token.slice(0, ultimo).replace(/[.,]/g, '')}.${token.slice(ultimo + 1)}`));
  } else {
    const sep = puntos > 0 ? '.' : ',';
    const cuantos = puntos > 0 ? puntos : comas;
    const ultimo = token.lastIndexOf(sep);
    const decimales = token.length - ultimo - 1;
    if (cuantos > 1) {
      agregar(Number(sinSeparadores)); // 1.500.000
    } else {
      agregar(Number(`${token.slice(0, ultimo)}.${token.slice(ultimo + 1)}`)); // 1,5 · 1.5
      if (decimales === 3) agregar(Number(sinSeparadores)); // 1.500 · 1,500: miles
    }
  }
  // sufijos de magnitud pegados al número: 50k, 50 mil, 2 millones, 2m
  const mult = /^\s*(k|mil|millones|millon|mm|m)(?![a-z])/.exec(resto);
  if (mult !== null) {
    const factor = mult[1] === 'k' || mult[1] === 'mil' ? 1_000 : 1_000_000;
    for (const v of [...valores]) agregar(v * factor);
  }
  return [...valores];
}

/** ¿Escribió la persona este número (con cifras, separadores de miles/decimales o sufijo k/mil/millones)? */
export function numeroFundamentado(valor: number, textosDelActor: readonly string[]): boolean {
  if (!Number.isFinite(valor)) return false;
  for (const mensaje of textosDelActor) {
    const t = paraFechas(mensaje);
    for (const x of t.matchAll(/(?<![\d.,])\d+(?:[.,]\d+)*/g)) {
      const resto = t.slice(x.index + x[0].length, x.index + x[0].length + 12);
      if (
        candidatosNumericos(x[0], resto).some((c) => Math.abs(c - valor) <= 1e-9 * Math.max(1, Math.abs(c)))
      ) {
        return true;
      }
    }
  }
  return false;
}

// ─────────────────────────── Respuesta de una pregunta del brief ───────────────

export type ResultadoDeValor =
  { readonly ok: true } | { readonly ok: false; readonly field: string; readonly motivo: string };

const rechazo = (campo: string, motivo: string): ResultadoDeValor => ({ ok: false, field: campo, motivo });

/** Claves de un objeto de fecha estructurada que llevan una fecha (el resto de textos se contrasta como cita). */
const CLAVES_DE_FECHA: ReadonlySet<string> = new Set(['fecha', 'inicio', 'fin']);
/** Claves cuyo valor es un vocabulario cerrado del dominio, no texto de la persona. */
const CLAVES_DE_VOCABULARIO: ReadonlySet<string> = new Set(['tipo']);

const MAX_PROFUNDIDAD = 4;

function textoFundamentado(valor: string, textos: readonly string[]): boolean {
  if (valor.trim() === '') return true; // vacío: lo rechaza el dominio, no es un dato que fundamentar
  return verificarCitaLiteral(valor, textos, { minChars: 1, maxChars: VALOR_MAX_CHARS }).ok;
}

function recorrer(
  valor: unknown,
  ruta: string,
  clave: string | undefined,
  textos: readonly string[],
  profundidad: number,
): ResultadoDeValor {
  if (profundidad > MAX_PROFUNDIDAD) return rechazo(ruta, 'demasiado_profundo');
  if (typeof valor === 'string') {
    if (clave !== undefined && CLAVES_DE_VOCABULARIO.has(clave)) return { ok: true };
    const ok =
      clave !== undefined && CLAVES_DE_FECHA.has(clave)
        ? fechaFundamentada(valor, textos)
        : textoFundamentado(valor, textos);
    return ok ? { ok: true } : rechazo(ruta, 'no_aparece');
  }
  if (typeof valor === 'number') {
    return numeroFundamentado(valor, textos) ? { ok: true } : rechazo(ruta, 'no_aparece');
  }
  if (Array.isArray(valor)) {
    for (const [i, v] of valor.entries()) {
      const r = recorrer(v, `${ruta}[${i}]`, undefined, textos, profundidad + 1);
      if (!r.ok) return r;
    }
    return { ok: true };
  }
  if (valor !== null && typeof valor === 'object') {
    for (const [k, v] of Object.entries(valor as Record<string, unknown>)) {
      const r = recorrer(v, `${ruta}.${k}`, k, textos, profundidad + 1);
      if (!r.ok) return r;
    }
    return { ok: true };
  }
  return { ok: true }; // booleanos y nulos no transportan texto
}

/**
 * Criterio de grounding del valor de `brief_answer_question`, según el `valueType` del
 * campo del catálogo:
 *   · `texto`, `lista`, `lista_objetos`: cada texto del valor debe aparecer (normalizado)
 *     dentro de UN mensaje de la persona, como en `name`: se copia, no se parafrasea.
 *   · `numero`: la cifra debe estar escrita por la persona (admite miles, decimales, k/mil).
 *   · `fecha`: cada fecha del objeto debe poder leerse en un mensaje (ver `fechaFundamentada`).
 *   · `enum`: el valor es un código de un vocabulario CERRADO que el dominio valida; no puede
 *     transportar texto libre, así que no se exige que aparezca literal (la persona dice
 *     «alta» y el modelo elige `alto`). La cita de respaldo sigue siendo obligatoria.
 * `answerText` (texto libre opcional que se guarda aparte) se contrasta como cita.
 * Un valor que no cumple se rechaza SIN ejecutar el caso de uso.
 */
export function verificarValorDeRespuesta(
  campo: CampoDelCatalogo | undefined,
  answerValue: unknown,
  answerText: string | undefined,
  textosDelActor: readonly string[],
): ResultadoDeValor {
  if (answerText !== undefined && !textoFundamentado(answerText, textosDelActor)) {
    return rechazo('answerText', 'no_aparece');
  }
  if (campo === undefined || campo.valueType === 'enum') return { ok: true };
  return recorrer(answerValue, 'answerValue', undefined, textosDelActor, 0);
}

// ─────────────────────────── Cita exacta del mensaje en curso (F7) ─────────────

export type ResultadoDeCitaDelMensaje =
  | { readonly ok: true; readonly cita: string }
  | { readonly ok: false; readonly motivo: 'vacia' | 'muy_corta' | 'muy_larga' | 'no_aparece' };

const CITA_DEL_MENSAJE_MAX_CHARS = 1_000;

/**
 * ¿`cita` es una subcadena EXACTA del texto del mensaje en curso? Sin plegar mayúsculas, acentos ni
 * espacios internos (lo que se guarda como comentario es lo que la persona escribió, byte a byte); solo
 * se recortan los espacios de los bordes, igual que el caso de uso (`body.trim()`). Devuelve la cita ya
 * recortada: es exactamente el texto que se guardará.
 */
export function verificarCitaDelMensajeEnCurso(
  cita: unknown,
  mensajeEnCurso: string,
  minChars: number,
): ResultadoDeCitaDelMensaje {
  if (typeof cita !== 'string') return { ok: false, motivo: 'vacia' };
  const limpia = cita.trim();
  if (limpia === '') return { ok: false, motivo: 'vacia' };
  const largo = Array.from(limpia).length;
  if (largo < minChars) return { ok: false, motivo: 'muy_corta' };
  if (largo > CITA_DEL_MENSAJE_MAX_CHARS) return { ok: false, motivo: 'muy_larga' };
  if (!mensajeEnCurso.includes(limpia)) return { ok: false, motivo: 'no_aparece' };
  return { ok: true, cita: limpia };
}

// ─────────────────────────── Asociación guion ↔ persona (F7) ────────────────────

export interface EntradaDeAsociacionDeGuion {
  /** `participantMention`: lo que la persona dijo («Valentina»). */
  readonly mencion: string;
  /** `evidenceQuote`: la frase de la persona que asocia el guion con el influencer. */
  readonly cita: string;
  /** La fuente que se quiere registrar y su nombre de archivo. */
  readonly sourceId: string;
  readonly filename: string;
  /** Mensajes del ACTOR que traen adjuntos (ventana de la conversación). */
  readonly mensajesConAdjuntos: readonly { readonly texto: string; readonly sourceIds: readonly string[] }[];
  /** Nombres de archivo de los OTROS adjuntos en juego (para saber qué fragmento distingue a este). */
  readonly nombresDeOtrosAdjuntos: readonly string[];
}

export type ResultadoDeAsociacionDeGuion =
  | { readonly ok: true; readonly via: 'archivo_nombrado' | 'unico_adjunto' }
  | { readonly ok: false; readonly motivo: 'mencion_ausente' | 'archivo_sin_nombrar' };

/** Forma comparable: la del grounding (NFKC, minúsculas, espacios) más sin acentos. */
const plano = (t: string): string => paraFechas(t);

const sinExtension = (nombre: string): string => nombre.replace(/\.[A-Za-z0-9]{1,6}$/u, '');

const palabrasLargas = (t: string, minimo: number): string[] =>
  plano(t)
    .split(/[^\p{L}\p{N}]+/u)
    .filter((p) => p.length >= minimo);

/** El nombre COMPLETO del archivo (con extensión), literal y sin plegar mayúsculas ni acentos, dentro del texto. */
function nombreCompletoLiteral(filename: string, texto: string): boolean {
  return filename.trim().length >= 4 && sinExtension(filename) !== filename && texto.includes(filename);
}

/**
 * Decide si la frase de la persona asocia INEQUÍVOCAMENTE este archivo con ese influencer (pura, sin E/S).
 *
 *  1. La cita debe contener la mención (sin acentos ni mayúsculas): la persona dijo de quién es.
 *  2. Si la cita nombra el archivo (nombre COMPLETO con extensión, literal) o un fragmento
 *     DISTINTIVO del nombre (palabra ≥6 caracteres que no es de la mención ni aparece en el nombre de
 *     otro adjunto), el mapeo archivo↔persona es explícito.
 *  3. Si no, solo vale cuando el archivo es el ÚNICO adjunto en juego: el de los mensajes que contienen
 *     la cita (si traen adjuntos) o, si ninguno trae, el único adjunto de la persona en la ventana.
 *     «Te dejo dos guiones: el de Valentina y el de Diego» con dos archivos sin mapeo NO se registra.
 *
 * Es política de agente (grounding), no de dominio: el caso de uso decide si la mención es inequívoca.
 */
export function verificarAsociacionDeGuion(e: EntradaDeAsociacionDeGuion): ResultadoDeAsociacionDeGuion {
  const cita = plano(e.cita);
  const mencion = plano(e.mencion).replace(/^@/u, '');
  if (mencion.length < 2 || !cita.includes(mencion)) return { ok: false, motivo: 'mencion_ausente' };

  const deOtros = e.nombresDeOtrosAdjuntos.map((n) => plano(n));
  // El NOMBRE COMPLETO con extensión, literal (sin plegar): la raíz sin extensión («guion» de guion.md) es
  // vocabulario corriente del propio mensaje y no prueba que la persona nombrara ESE archivo (QA-F7-12b).
  const nombraElArchivo = nombreCompletoLiteral(e.filename, e.cita);
  if (nombraElArchivo) return { ok: true, via: 'archivo_nombrado' };

  const palabrasDeLaMencion = new Set(palabrasLargas(e.mencion, 1));
  const distintivo = palabrasLargas(sinExtension(e.filename), 6).some(
    (p) => cita.includes(p) && !palabrasDeLaMencion.has(p) && !deOtros.some((o) => o.includes(p)),
  );
  if (distintivo) return { ok: true, via: 'archivo_nombrado' };

  const conLaCita = e.mensajesConAdjuntos.filter((m) => plano(m.texto).includes(cita));
  const enJuego = new Set(
    (conLaCita.length > 0 ? conLaCita : e.mensajesConAdjuntos).flatMap((m) => m.sourceIds),
  );
  if (enJuego.size === 1 && enJuego.has(e.sourceId)) return { ok: true, via: 'unico_adjunto' };
  return { ok: false, motivo: 'archivo_sin_nombrar' };
}

/**
 * ¿Escribió la persona el nombre COMPLETO del archivo (con extensión, literal, sin plegar) en algún mensaje
 * suyo? La raíz sin extensión no basta: «guion» o «brief» son vocabulario del propio mensaje (QA-F7-12b).
 */
export function archivoNombradoPorLaPersona(filename: string, textosDelActor: readonly string[]): boolean {
  return textosDelActor.some((t) => nombreCompletoLiteral(filename, t));
}

// ─────────────────────────── Objetivo de KPI (F8) ──────────────────────────────

/** Cómo nombra una persona cada métrica del catálogo (sin acentos y en minúsculas, como `paraFechas`). */
const TERMINOS_DE_METRICA: Readonly<Record<string, readonly string[]>> = {
  views: [
    'vistas',
    'vista',
    'views',
    'view',
    'visualizaciones',
    'visualizacion',
    'reproducciones',
    'reproduccion',
    'plays',
  ],
  reach: ['alcance', 'alcances', 'reach'],
  impressions: ['impresiones', 'impresion', 'impressions'],
  likes: ['me gusta', 'me gustas', 'likes', 'like'],
  comments: ['comentarios', 'comentario', 'comments', 'comment'],
  shares: ['compartidos', 'compartido', 'compartidas', 'compartir', 'shares', 'share'],
  saves: ['guardados', 'guardado', 'guardadas', 'guardar', 'saves', 'save'],
  link_clicks: ['clics', 'clic', 'clicks', 'click', 'link clicks'],
  engagement_rate: ['engagement', 'interaccion', 'interacciones', 'tasa de interaccion'],
};

const enMinusculasSinAcentos = (t: string): string => paraFechas(t).replace(/\s+/g, ' ');

const escaparRegex = (t: string): string => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function contieneTermino(texto: string, termino: string): boolean {
  const re = new RegExp(`(?<![a-z0-9])${escaparRegex(termino)}(?![a-z0-9])`);
  return re.test(texto);
}

export interface EntradaDeObjetivoDeKpi {
  readonly metric: string;
  readonly otherLabel: string | undefined;
  readonly targetValue: number;
  readonly comparator: string | undefined;
  /** La cita (`evidenceQuote`) YA verificada como literal de un mensaje de la persona. */
  readonly cita: string;
}

// ── Cifras: lectura ESTRICTA de lo que la persona escribió ──────────────────────

/**
 * Lo que un token numérico de la CITA significa, leído UNA sola vez y sin ambigüedad a favor del modelo:
 *   · «50.000», «1,500», «1.500.000»: separadores de MILES (un único separador seguido de exactamente tres
 *     dígitos, con una parte entera de 1 a 3 cifras que no empieza en 0, o varios grupos de tres) ⇒ 50000;
 *   · «4,7», «1.5», «12.25»: decimales ⇒ 4.7;
 *   · con ambos separadores el último es el decimal («1.234,56»);
 *   · un sufijo de magnitud pegado lo MULTIPLICA y reemplaza la lectura sin sufijo: «10 mil» ⇒ 10000 (no 10),
 *     «1,5 millones» ⇒ 1500000, «50k» ⇒ 50000.
 * `numeroFundamentado` (brief) admite varias lecturas a la vez; para un objetivo de KPI eso dejaba pasar 50 por
 * «50.000» y 10 por «10 mil»: aquí una cifra tiene UN valor.
 */
function leerCifraEstricta(token: string): number | undefined {
  const puntos = (token.match(/\./g) ?? []).length;
  const comas = (token.match(/,/g) ?? []).length;
  const soloDigitos = (t: string): boolean => /^\d+$/.test(t);
  const gruposDeMiles = (t: string, sep: string): boolean => {
    const partes = t.split(sep);
    return (
      partes.length >= 2 &&
      /^[1-9]\d{0,2}$/.test(partes[0]!) &&
      partes.slice(1).every((g) => /^\d{3}$/.test(g))
    );
  };
  if (puntos === 0 && comas === 0) return Number(token);
  if (puntos > 0 && comas > 0) {
    const ultimo = Math.max(token.lastIndexOf('.'), token.lastIndexOf(','));
    const entera = token.slice(0, ultimo);
    const decimal = token.slice(ultimo + 1);
    const sepMiles = token[ultimo] === '.' ? ',' : '.';
    if (entera.includes(token[ultimo]!) || !gruposDeMiles(entera, sepMiles) || !soloDigitos(decimal)) {
      return undefined;
    }
    return Number(`${entera.split(sepMiles).join('')}.${decimal}`);
  }
  const sep = puntos > 0 ? '.' : ',';
  if (gruposDeMiles(token, sep)) return Number(token.split(sep).join(''));
  if (puntos + comas > 1) return undefined; // «1.5.3»: no es un número
  const [entera, decimal] = token.split(sep) as [string, string];
  if (!soloDigitos(entera) || !soloDigitos(decimal)) return undefined;
  return Number(`${entera}.${decimal}`);
}

const MAGNITUD_PEGADA = /^(?:(k)|(mm|m))(?![a-z0-9])/;
const MAGNITUD_EN_PALABRA = /^\s*(mil millones|millones|millon|mil)(?![a-z0-9])/;

/** Palabras que, tras una cifra, indican que NO es una cantidad de la métrica (tiempo, no un conteo). */
const UNIDADES_DE_TIEMPO = new Set([
  'dia',
  'dias',
  'semana',
  'semanas',
  'mes',
  'meses',
  'ano',
  'anos',
  'hora',
  'horas',
  'min',
  'mins',
  'minuto',
  'minutos',
  'segundo',
  'segundos',
  'day',
  'days',
  'week',
  'weeks',
  'month',
  'months',
  'year',
  'years',
  'hour',
  'hours',
  'minute',
  'minutes',
  'second',
  'seconds',
]);

const MES_DESPUES = new RegExp(`^\\s*(?:de\\s+|del\\s+)?(?:${MES_RE})(?![a-z])`);

interface CifraDeLaCita {
  readonly inicio: number;
  readonly fin: number;
  readonly valor: number;
}

/** Cifras de la cita con su valor ÚNICO; se descartan fechas, duraciones y porcentajes que no son del objetivo. */
function cifrasDeLaCita(t: string, metric: string): CifraDeLaCita[] {
  const salida: CifraDeLaCita[] = [];
  for (const x of t.matchAll(/(?<![\d.,])\d+(?:[.,]\d+)*/g)) {
    const base = leerCifraEstricta(x[0]);
    if (base === undefined || !Number.isFinite(base)) continue;
    let fin = x.index + x[0].length;
    let valor = base;
    const resto = t.slice(fin);
    const pegada = MAGNITUD_PEGADA.exec(resto);
    const enPalabra = pegada === null ? MAGNITUD_EN_PALABRA.exec(resto) : null;
    if (pegada !== null) {
      valor = base * (pegada[1] === 'k' ? 1_000 : 1_000_000);
      fin += pegada[0].length;
    } else if (enPalabra !== null) {
      valor =
        base * (enPalabra[1] === 'mil' ? 1_000 : enPalabra[1] === 'mil millones' ? 1_000_000_000 : 1_000_000);
      fin += enPalabra[0].length;
    }
    const despues = t.slice(fin);
    const siguiente = /^\s*([a-z]+)/.exec(despues)?.[1];
    if (siguiente !== undefined && UNIDADES_DE_TIEMPO.has(siguiente)) continue; // «7 días»
    if (MES_DESPUES.test(despues)) continue; // «15 de marzo»
    if (/^\s*%/.test(despues) && metric !== 'engagement_rate' && metric !== 'other') continue; // no es un conteo
    salida.push({ inicio: x.index, fin, valor });
  }
  return salida;
}

// ── Comparador: lo que la persona DIJO ──────────────────────────────────────────

const CUES_DE_TOPE = [
  'como maximo',
  'maximo',
  'maxima',
  'como mucho',
  'a lo sumo',
  'no mas de',
  'no pasar de',
  'no superar',
  'no exceder',
  'no sobrepasar',
  'sin pasar de',
  'menos de',
  'menor de',
  'menor a',
  'menor que',
  'inferior a',
  'por debajo de',
  'tope',
  'limite',
  'o menos',
  'at most',
  'up to',
  'max',
  'hasta',
];
const CUES_DE_PISO = [
  'como minimo',
  'minimo',
  'minima',
  'al menos',
  'por lo menos',
  'no menos de',
  'no bajar de',
  'no menor',
  'mas de',
  'mayor de',
  'mayor a',
  'mayor que',
  'superior a',
  'por encima de',
  'arriba de',
  'o mas',
  'at least',
  'more than',
  'min',
  'que supere',
  'supere',
  'superar',
  'sobrepasar',
  'exceder',
];
const TOPES = new Set(CUES_DE_TOPE);
const CUES = [...CUES_DE_TOPE, ...CUES_DE_PISO].sort((a, b) => b.length - a.length);
const RE_CUES = new RegExp(`(?<![a-z0-9])(${CUES.map(escaparRegex).join('|')})(?![a-z0-9])`, 'g');
/** «hasta» solo es un tope si va seguido de la cifra («hasta 50.000», «hasta un máximo de»), no de una fecha o día. */
const HASTA_CON_CIFRA = /^\s*(?:(?:un|una|unos|unas|el|los|las)\s+)?$/;
/** Cues que solo valen DESPUÉS de la cifra («100 vistas o menos»). */
const SOLO_DESPUES = new Set(['o menos', 'o mas']);

type Direccion = 'tope' | 'piso' | undefined;

/** Cue más cercano a la cifra dentro de su cláusula: primero lo que la PRECEDE, luego lo que la sigue. */
function direccionDeLaCifra(clausulaAntes: string, clausulaDespues: string): Direccion {
  const antes = clausulaAntes.split(/\s+/).filter(Boolean).slice(-5).join(' ');
  let cercano: Direccion;
  for (const m of antes.matchAll(RE_CUES)) {
    const cue = m[1]!;
    if (SOLO_DESPUES.has(cue)) continue;
    const trasElCue = antes.slice(m.index + cue.length);
    if (cue === 'hasta' && !HASTA_CON_CIFRA.test(trasElCue)) continue; // «hasta el viernes … 50.000»
    cercano = TOPES.has(cue) ? 'tope' : 'piso';
  }
  if (cercano !== undefined) return cercano;
  const despues = clausulaDespues.split(/\s+/).filter(Boolean).slice(0, 4).join(' ');
  for (const m of despues.matchAll(RE_CUES)) {
    const cue = m[1]!;
    if (cue === 'hasta') continue; // «50.000 vistas hasta el viernes»: una fecha, no un tope
    return TOPES.has(cue) ? 'tope' : 'piso';
  }
  return undefined;
}

// ── Ligar la cifra a la métrica ─────────────────────────────────────────────────

interface TerminoEnLaCita {
  readonly inicio: number;
  readonly fin: number;
  readonly metrica: string;
}

function terminosEnLaCita(t: string, otherLabel: string | undefined): TerminoEnLaCita[] {
  const candidatos: TerminoEnLaCita[] = [];
  const catalogo: [string, string][] = Object.entries(TERMINOS_DE_METRICA).flatMap(([metrica, ts]) =>
    ts.map((x): [string, string] => [metrica, x]),
  );
  if (otherLabel !== undefined && otherLabel.length >= 3) catalogo.push(['other', otherLabel]);
  for (const [metrica, termino] of catalogo) {
    const re = new RegExp(`(?<![a-z0-9])${escaparRegex(termino)}(?![a-z0-9])`, 'g');
    for (const m of t.matchAll(re))
      candidatos.push({ inicio: m.index, fin: m.index + termino.length, metrica });
  }
  // Solapes (p. ej. «tasa de interaccion» y «interaccion»): se queda el más largo.
  candidatos.sort((a, b) => b.fin - b.inicio - (a.fin - a.inicio) || a.inicio - b.inicio);
  const elegidos: TerminoEnLaCita[] = [];
  for (const c of candidatos) {
    if (!elegidos.some((e) => c.inicio < e.fin && e.inicio < c.fin)) elegidos.push(c);
  }
  return elegidos.sort((a, b) => a.inicio - b.inicio);
}

/** Posiciones de los cortes de cláusula: `, . ; : ! ? \n` salvo entre dos dígitos («4,7», «50.000»). */
function cortesDeClausula(t: string): number[] {
  const cortes: number[] = [];
  for (let i = 0; i < t.length; i++) {
    const c = t[i]!;
    if (!/[,.;:!?\n]/.test(c)) continue;
    if ((c === ',' || c === '.') && /\d/.test(t[i - 1] ?? '') && /\d/.test(t[i + 1] ?? '')) continue;
    cortes.push(i);
  }
  return cortes;
}

const palabrasEntre = (t: string): string[] => t.match(/[a-z]+/g) ?? [];

/** Una negación («NO quiero 100 vistas») deja sin efecto la cifra; «no más de / no menos de» son topes, no negaciones. */
function estaNegada(antesEnLaClausula: string): boolean {
  const sinTopes = antesEnLaClausula.replace(
    /(?<![a-z])no\s+(?:mas|menos)\s+de(?![a-z])|(?<![a-z])no\s+(?:pasar|superar|exceder|sobrepasar|bajar|menor|mayor)(?![a-z])/g,
    ' ',
  );
  const ultimas = palabrasEntre(sinTopes).slice(-4);
  return ultimas.some((p) => p === 'no' || p === 'ni' || p === 'nunca' || p === 'jamas' || p === 'tampoco');
}

export type MotivoDeObjetivoDeKpi =
  'no_aparece' | 'sin_tope_en_la_cita' | 'tope_dicho_con_gte' | 'minimo_dicho_con_lte';

/**
 * Grounding por VALOR de un objetivo de KPI (D11): lo que se guarda como objetivo debe ser lo que la persona
 * DICTÓ en la CITA que escribió, no lo que el modelo infiere:
 *   · la MÉTRICA aparece nombrada (vistas, alcance, «me gusta»…; con `other`, su etiqueta literal);
 *   · el VALOR es UNA cifra de la cita LIGADA a esa métrica (la que la precede o sigue de cerca, en su misma
 *     cláusula, sin otra cifra de por medio), leída con su valor único: «50.000» es 50000 (no 50), «10 mil» es
 *     10000 (no 10), «1,5 millones» es 1500000. Una cifra negada («NO quiero 100 vistas»), una fecha
 *     («15 de marzo») o una duración («7 días») no cuentan;
 *   · el COMPARADOR concuerda con lo dicho: «como máximo / menos de / no más de / hasta 50.000» ⇒ `lte`;
 *     «al menos / más de / mínimo» ⇒ `gte`; «hasta el viernes» (una fecha) no es un tope; sin expresión, solo
 *     `gte` (la persona dijo un objetivo neutro: «objetivo de 50.000 vistas»).
 * Función pura. Un valor que no cumple se rechaza SIN ejecutar el caso de uso.
 */
export function verificarObjetivoDeKpiEnLaCita(e: EntradaDeObjetivoDeKpi): ResultadoDeValor {
  const cita = enMinusculasSinAcentos(e.cita);
  let etiqueta: string | undefined;
  if (e.metric === 'other') {
    etiqueta = enMinusculasSinAcentos(e.otherLabel ?? '');
    if (etiqueta.length < 3 || !cita.includes(etiqueta)) return rechazo('otherLabel', 'no_aparece');
  } else {
    const terminos = TERMINOS_DE_METRICA[e.metric];
    if (terminos === undefined || !terminos.some((t) => contieneTermino(cita, t))) {
      return rechazo('metric', 'no_aparece');
    }
  }
  if (!Number.isFinite(e.targetValue)) return rechazo('targetValue', 'no_aparece');

  const terminos = terminosEnLaCita(cita, etiqueta);
  const cortes = cortesDeClausula(cita);
  const clausulaDe = (pos: number): number => cortes.filter((c) => c < pos).length;
  const limitesDe = (pos: number): { desde: number; hasta: number } => {
    const previos = cortes.filter((c) => c < pos);
    const siguientes = cortes.filter((c) => c >= pos);
    return { desde: (previos.at(-1) ?? -1) + 1, hasta: siguientes[0] ?? cita.length };
  };
  const cifras = cifrasDeLaCita(cita, e.metric);

  // Dueño de cada cifra: el término que la SIGUE (≤ 3 palabras, sin otra cifra) o, si no, el que la PRECEDE
  // (≤ 4 palabras) y aún no tiene cifra propia («100 vistas y 5 comentarios»: el 5 es de los comentarios).
  const reclamados = new Set<TerminoEnLaCita>();
  const dueno = new Map<CifraDeLaCita, TerminoEnLaCita>();
  const sinDigitos = (s: string): boolean => !/\d/.test(s.replace(/%/g, ''));
  for (const c of cifras) {
    const siguiente = terminos.find(
      (t) =>
        t.inicio >= c.fin &&
        clausulaDe(t.inicio) === clausulaDe(c.inicio) &&
        sinDigitos(cita.slice(c.fin, t.inicio)) &&
        palabrasEntre(cita.slice(c.fin, t.inicio)).length <= 3,
    );
    if (siguiente !== undefined) {
      dueno.set(c, siguiente);
      reclamados.add(siguiente);
    }
  }
  for (const c of cifras) {
    if (dueno.has(c)) continue;
    const previo = [...terminos]
      .reverse()
      .find(
        (t) =>
          t.fin <= c.inicio &&
          !reclamados.has(t) &&
          clausulaDe(t.fin) === clausulaDe(c.inicio) &&
          sinDigitos(cita.slice(t.fin, c.inicio)) &&
          palabrasEntre(cita.slice(t.fin, c.inicio)).length <= 4,
      );
    if (previo !== undefined) dueno.set(c, previo);
  }

  const candidatas = cifras.filter((c) => {
    if (dueno.get(c)?.metrica !== e.metric) return false;
    if (Math.abs(c.valor - e.targetValue) > 1e-9 * Math.max(1, Math.abs(c.valor))) return false;
    return !estaNegada(cita.slice(limitesDe(c.inicio).desde, c.inicio));
  });
  if (candidatas.length === 0) return rechazo('targetValue', 'no_aparece');

  // Comparador: basta UNA cifra candidata coherente con lo dicho.
  let motivo: MotivoDeObjetivoDeKpi = 'sin_tope_en_la_cita';
  for (const c of candidatas) {
    const { desde, hasta } = limitesDe(c.inicio);
    const t = dueno.get(c)!;
    const direccion = direccionDeLaCifra(
      cita.slice(desde, c.inicio),
      cita.slice(t.fin > c.fin ? t.fin : c.fin, hasta),
    );
    if (direccion === 'tope') {
      if (e.comparator === 'lte') return { ok: true };
      motivo = 'tope_dicho_con_gte';
    } else if (direccion === 'piso') {
      if (e.comparator !== 'lte') return { ok: true };
      motivo = 'minimo_dicho_con_lte';
    } else if (e.comparator !== 'lte') {
      return { ok: true }; // sin expresión: un objetivo neutro es `gte`
    } else {
      motivo = 'sin_tope_en_la_cita';
    }
  }
  return rechazo('comparator', motivo);
}
