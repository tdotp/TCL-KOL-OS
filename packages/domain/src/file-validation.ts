/**
 * Validación de archivos por contenido real (E4-1, caso S-05).
 *
 * Un archivo NO se valida por su extensión ni por el `Content-Type` que declara
 * el navegador: ambos los controla quien sube el archivo. Se valida leyendo los
 * primeros bytes, que son los que determinan qué es de verdad.
 *
 * Los formatos permitidos son una regla de negocio (DEC-010), por eso viven
 * aquí y no en la capa web.
 *
 * El worker Python tiene su propia implementación en `app/validation.py`: no es
 * duplicación de una regla, es una segunda línea de defensa en otro runtime.
 * Ambas derivan de la misma decisión y las pruebas verifican que coinciden.
 */

export const MIME_PPTX = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
export const MIME_DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
export const MIME_XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
export const MIME_PDF = 'application/pdf';
export const MIME_PNG = 'image/png';
export const MIME_JPEG = 'image/jpeg';

/** Formatos aceptados en MVP 1 (DEC-010). */
export const FORMATOS_PERMITIDOS: readonly string[] = [MIME_PDF, MIME_PPTX, MIME_DOCX, MIME_PNG, MIME_JPEG];

/** Formatos cuyo texto se extrae automáticamente. Las imágenes exigen OCR (E4-7). */
export const FORMATOS_CON_EXTRACCION: readonly string[] = [MIME_PDF, MIME_PPTX, MIME_DOCX];

export interface ResultadoValidacion {
  readonly valido: boolean;
  readonly mimeType?: string | undefined;
  readonly motivo?: string | undefined;
}

function empiezaCon(bytes: Uint8Array, firma: readonly number[]): boolean {
  if (bytes.length < firma.length) return false;
  return firma.every((b, i) => bytes[i] === b);
}

/**
 * Distingue los formatos OOXML, que comparten cabecera porque todos son ZIP.
 * El tipo real está en los nombres de las entradas internas.
 */
function tipoOoxml(contenido: Uint8Array): string | undefined {
  // Se busca en texto plano dentro del ZIP: los nombres de entrada no están
  // comprimidos, así que aparecen literalmente en el archivo.
  const muestra = new TextDecoder('latin1').decode(contenido.subarray(0, Math.min(contenido.length, 8192)));
  if (muestra.includes('ppt/')) return MIME_PPTX;
  if (muestra.includes('word/')) return MIME_DOCX;
  if (muestra.includes('xl/')) return MIME_XLSX;
  return undefined;
}

/** Tipo real del archivo según sus primeros bytes. */
export function detectarTipo(contenido: Uint8Array): string | undefined {
  if (empiezaCon(contenido, [0x25, 0x50, 0x44, 0x46, 0x2d])) return MIME_PDF; // %PDF-
  if (empiezaCon(contenido, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return MIME_PNG;
  if (empiezaCon(contenido, [0xff, 0xd8, 0xff])) return MIME_JPEG;
  if (empiezaCon(contenido, [0x50, 0x4b, 0x03, 0x04])) return tipoOoxml(contenido); // PK..
  return undefined;
}

export function validarArchivo(
  contenido: Uint8Array,
  tamanoBytes: number,
  maxBytes: number,
  declarado?: string | undefined,
): ResultadoValidacion {
  if (tamanoBytes <= 0) {
    return { valido: false, motivo: 'El archivo está vacío.' };
  }

  if (tamanoBytes > maxBytes) {
    const mb = Math.round((tamanoBytes / 1024 / 1024) * 10) / 10;
    const limite = Math.round(maxBytes / 1024 / 1024);
    return { valido: false, motivo: `El archivo pesa ${mb} MB y el límite es ${limite} MB.` };
  }

  const real = detectarTipo(contenido);

  if (real === undefined) {
    return {
      valido: false,
      motivo: 'No se reconoce el tipo de archivo. Formatos aceptados: PDF, PPTX, DOCX, PNG y JPG.',
    };
  }

  if (!FORMATOS_PERMITIDOS.includes(real)) {
    if (real === MIME_XLSX) {
      return {
        valido: false,
        mimeType: real,
        motivo:
          'Los archivos de Excel no tienen procesamiento automático en esta fase. Cárguelo como excepción manual si es necesario.',
      };
    }
    return { valido: false, mimeType: real, motivo: `El tipo ${real} no está permitido.` };
  }

  // La discrepancia con lo declarado no bloquea —los navegadores se equivocan a
  // menudo— pero se informa. Lo que sí bloquea es un contenido irreconocible.
  if (declarado !== undefined && declarado !== '' && declarado !== real) {
    return {
      valido: true,
      mimeType: real,
      motivo: `El tipo declarado (${declarado}) no coincide con el real.`,
    };
  }

  return { valido: true, mimeType: real };
}
