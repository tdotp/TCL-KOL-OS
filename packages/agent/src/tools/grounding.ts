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
