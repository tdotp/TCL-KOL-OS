/**
 * Validación de un valor estructurado contra `valueType` del catálogo único.
 *
 * Nace en `packages/db/src/local-questions.ts` (`responderPregunta`) para que
 * una respuesta manual respete la misma forma que exige el esquema — en
 * particular `PrecisedDate` (DEC-026): "la fecha debe estar respaldada por
 * una cita real, nunca inferida" no se puede comprobar si el valor ni
 * siquiera trae el objeto de precisión. Vive en el dominio (no en
 * `packages/db`) para que la corrección manual de un campo
 * (`corregirCampo`/`resolverConflicto`/`declararExcepcionProducto`) pueda
 * exigir exactamente la misma validación sin duplicarla (Sprint 5, Fase A).
 */

import { type CampoDelCatalogo, campoDelCatalogo } from './brief-catalog';
import type { DatePrecision } from './types';

export type ValidacionValor = { readonly ok: true } | { readonly ok: false; readonly mensaje: string };

const TIPOS_PRECISION_VALIDOS: readonly DatePrecision[] = [
  'exacta',
  'mes',
  'rango',
  'aproximada',
  'pendiente_confirmar',
];

function validarFecha(campo: CampoDelCatalogo, valor: unknown): ValidacionValor {
  if (typeof valor !== 'object' || valor === null || !('tipo' in valor)) {
    return {
      ok: false,
      mensaje: `«${campo.label}» espera un objeto de fecha con precisión (DEC-026), no texto libre.`,
    };
  }
  const v = valor as { tipo: unknown; fecha?: unknown; inicio?: unknown; fin?: unknown };
  if (typeof v.tipo !== 'string' || !TIPOS_PRECISION_VALIDOS.includes(v.tipo as DatePrecision)) {
    return { ok: false, mensaje: `«${campo.label}»: tipo de precisión de fecha inválido.` };
  }
  if ((v.tipo === 'exacta' || v.tipo === 'mes') && (typeof v.fecha !== 'string' || v.fecha.trim() === '')) {
    return { ok: false, mensaje: `«${campo.label}»: falta "fecha" para el tipo «${v.tipo}».` };
  }
  if (
    v.tipo === 'rango' &&
    (typeof v.inicio !== 'string' ||
      v.inicio.trim() === '' ||
      typeof v.fin !== 'string' ||
      v.fin.trim() === '')
  ) {
    return { ok: false, mensaje: `«${campo.label}»: el rango exige "inicio" y "fin".` };
  }
  return { ok: true };
}

/**
 * Valida `valor` contra el `valueType` del campo `key` en el catálogo único.
 * No persiste nada — es una función pura, la misma que ya usaba
 * `responderPregunta` para respuestas de preguntas locales, ahora también
 * exigida a la corrección manual de campos (Sprint 5, DEC-026).
 */
export function validarValorEstructurado(key: string, valor: unknown): ValidacionValor {
  const campo = campoDelCatalogo(key);
  if (!campo) return { ok: false, mensaje: `«${key}» no es un campo del catálogo del brief.` };

  switch (campo.valueType) {
    case 'texto':
      if (typeof valor !== 'string' || valor.trim() === '') {
        return { ok: false, mensaje: `«${campo.label}» espera un texto no vacío.` };
      }
      return { ok: true };

    case 'numero':
      if (typeof valor !== 'number' || Number.isNaN(valor)) {
        return { ok: false, mensaje: `«${campo.label}» espera un número.` };
      }
      return { ok: true };

    case 'enum':
      if (typeof valor !== 'string' || !(campo.valoresPermitidos ?? []).includes(valor)) {
        return {
          ok: false,
          mensaje: `«${campo.label}» debe ser uno de: ${(campo.valoresPermitidos ?? []).join(', ')}.`,
        };
      }
      return { ok: true };

    case 'lista':
      if (!Array.isArray(valor) || valor.length === 0 || !valor.every((v) => typeof v === 'string')) {
        return { ok: false, mensaje: `«${campo.label}» espera una lista de textos.` };
      }
      return { ok: true };

    case 'lista_objetos':
      if (
        !Array.isArray(valor) ||
        valor.length === 0 ||
        !valor.every(
          (v) =>
            typeof v === 'object' &&
            v !== null &&
            'descripcion' in v &&
            typeof (v as { descripcion: unknown }).descripcion === 'string',
        )
      ) {
        return { ok: false, mensaje: `«${campo.label}» espera una lista de objetos con "descripcion".` };
      }
      return { ok: true };

    case 'fecha':
      return validarFecha(campo, valor);

    default:
      return { ok: true };
  }
}
