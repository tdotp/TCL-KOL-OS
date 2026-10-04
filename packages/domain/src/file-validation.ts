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
/** Hoja de cálculo en texto (V2 · Fase 4). */
export const MIME_CSV = 'text/csv';
/** Formato preferido para los briefs de SmartPR (DEC-018). */
export const MIME_MARKDOWN = 'text/markdown';

/** Extensiones que declaran texto. Ver `detectarTipo` para por qué importan. */
const EXTENSIONES_TEXTO = ['.md', '.markdown', '.txt'] as const;
const EXTENSIONES_CSV = ['.csv'] as const;

/**
 * Formatos aceptados: los de MVP 1 (DEC-010) más las hojas de cálculo `.xlsx` y
 * `.csv` (V2 · Fase 4). El `.xls` binario y los libros con macros NO se aceptan.
 */
export const FORMATOS_PERMITIDOS: readonly string[] = [
  MIME_MARKDOWN,
  MIME_PDF,
  MIME_PPTX,
  MIME_DOCX,
  MIME_XLSX,
  MIME_CSV,
  MIME_PNG,
  MIME_JPEG,
];

/**
 * Formatos cuyo contenido se extrae automáticamente. Las imágenes se conservan
 * pero NO tienen extracción (OCR/visión sigue pendiente): no se inventa texto.
 */
export const FORMATOS_CON_EXTRACCION: readonly string[] = [
  MIME_MARKDOWN,
  MIME_PDF,
  MIME_PPTX,
  MIME_DOCX,
  MIME_XLSX,
  MIME_CSV,
];

/** ¿El formato es una hoja de cálculo (su contenido es tabular)? */
export function esHojaDeCalculo(mimeType: string | null | undefined): boolean {
  return mimeType === MIME_XLSX || mimeType === MIME_CSV;
}

/**
 * Límites de un libro XLSX (V2 · Fase 4). Se comprueban al subir (aquí, sobre el
 * directorio central del ZIP, sin descomprimir) y otra vez en el worker
 * (`app/validation.py`, `app/parsers/xlsx_parser.py`) con los mismos valores.
 * El tamaño comprimido lo limita `MAX_UPLOAD_MB`, como cualquier archivo.
 */
export const XLSX_MAX_BYTES_DESCOMPRIMIDOS = 150 * 1024 * 1024;
export const XLSX_MAX_ENTRADAS = 5_000;
/** Un XLSX legítimo comprime ~10–30×; mucho más es sospechoso de ZIP bomb. */
export const XLSX_MAX_RATIO_COMPRESION = 200;

export interface ResultadoValidacion {
  readonly valido: boolean;
  readonly mimeType?: string | undefined;
  readonly motivo?: string | undefined;
  /** Código semántico cuando el rechazo tiene uno propio (V2 · Fase 4). */
  readonly codigo?: 'UNSUPPORTED_SOURCE_FORMAT' | 'INVALID_SPREADSHEET' | undefined;
}

function empiezaCon(bytes: Uint8Array, firma: readonly number[]): boolean {
  if (bytes.length < firma.length) return false;
  return firma.every((b, i) => bytes[i] === b);
}

export interface EntradaZip {
  readonly nombre: string;
  readonly tamanoComprimido: number;
  readonly tamanoDescomprimido: number;
}

/**
 * Lista las entradas de un ZIP leyendo su directorio central (al final del
 * archivo), sin descomprimir nada. `undefined` si no es un ZIP legible o usa
 * ZIP64 (que ningún libro razonable necesita).
 *
 * Es más fiable que buscar nombres en los primeros bytes (como se hacía): en un
 * libro grande los nombres de entrada pueden quedar más allá de ese margen.
 */
export function listarEntradasZip(contenido: Uint8Array): EntradaZip[] | undefined {
  const n = contenido.length;
  if (n < 22) return undefined;
  const vista = new DataView(contenido.buffer, contenido.byteOffset, contenido.byteLength);

  // Fin del directorio central (EOCD): firma 0x06054b50, a lo sumo 64 KB antes del final.
  let eocd = -1;
  const desde = Math.max(0, n - 22 - 65_535);
  for (let i = n - 22; i >= desde; i -= 1) {
    if (vista.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return undefined;

  const total = vista.getUint16(eocd + 10, true);
  const tamanoDirectorio = vista.getUint32(eocd + 12, true);
  const inicioDirectorio = vista.getUint32(eocd + 16, true);
  if (total === 0xffff || tamanoDirectorio === 0xffffffff || inicioDirectorio === 0xffffffff)
    return undefined;
  if (inicioDirectorio + tamanoDirectorio > n) return undefined;

  const entradas: EntradaZip[] = [];
  let pos = inicioDirectorio;
  const decodificador = new TextDecoder('utf-8');
  for (let i = 0; i < total; i += 1) {
    if (pos + 46 > n || vista.getUint32(pos, true) !== 0x02014b50) return undefined;
    const tamanoComprimido = vista.getUint32(pos + 20, true);
    const tamanoDescomprimido = vista.getUint32(pos + 24, true);
    const largoNombre = vista.getUint16(pos + 28, true);
    const largoExtra = vista.getUint16(pos + 30, true);
    const largoComentario = vista.getUint16(pos + 32, true);
    if (pos + 46 + largoNombre > n) return undefined;
    const nombre = decodificador.decode(contenido.subarray(pos + 46, pos + 46 + largoNombre));
    entradas.push({ nombre, tamanoComprimido, tamanoDescomprimido });
    pos += 46 + largoNombre + largoExtra + largoComentario;
  }
  return entradas;
}

/**
 * Distingue los formatos OOXML, que comparten cabecera porque todos son ZIP.
 * El tipo real está en los nombres de las entradas internas: se leen del
 * directorio central; si no es legible, se cae al barrido de los primeros bytes.
 */
function tipoOoxml(contenido: Uint8Array): string | undefined {
  const entradas = listarEntradasZip(contenido);
  if (entradas !== undefined) {
    const nombres = entradas.map((e) => e.nombre);
    if (nombres.some((nombre) => nombre.startsWith('ppt/'))) return MIME_PPTX;
    if (nombres.some((nombre) => nombre.startsWith('word/'))) return MIME_DOCX;
    if (nombres.some((nombre) => nombre.startsWith('xl/'))) return MIME_XLSX;
    return undefined;
  }
  // Se busca en texto plano dentro del ZIP: los nombres de entrada no están
  // comprimidos, así que aparecen literalmente en el archivo.
  const muestra = new TextDecoder('latin1').decode(contenido.subarray(0, Math.min(contenido.length, 8192)));
  if (muestra.includes('ppt/')) return MIME_PPTX;
  if (muestra.includes('word/')) return MIME_DOCX;
  if (muestra.includes('xl/')) return MIME_XLSX;
  return undefined;
}

/**
 * Comprobaciones de seguridad de un libro XLSX antes de guardarlo: estructura
 * mínima, sin macros, y sin señales de ZIP bomb (tamaño descomprimido, número
 * de entradas, razón de compresión). Devuelve el motivo del rechazo, si lo hay.
 */
export function motivoDeRechazoXlsx(contenido: Uint8Array): string | undefined {
  const entradas = listarEntradasZip(contenido);
  if (entradas === undefined) {
    return 'El libro de Excel está dañado o usa un formato de archivo no compatible.';
  }
  const nombres = new Set(entradas.map((e) => e.nombre));
  if (!nombres.has('[Content_Types].xml') || !nombres.has('xl/workbook.xml')) {
    return 'El archivo no es un libro de Excel (.xlsx) válido.';
  }
  if (
    entradas.some((e) => /(^|\/)vbaProject\.bin$/i.test(e.nombre)) ||
    nombres.has('xl/macrosheets/sheet1.xml')
  ) {
    return 'Los libros con macros no se aceptan: guárdelo como .xlsx sin macros.';
  }
  if (entradas.some((e) => e.nombre.includes('..') || e.nombre.startsWith('/') || e.nombre.includes('\\'))) {
    return 'El libro contiene rutas internas no válidas.';
  }
  if (entradas.length > XLSX_MAX_ENTRADAS) {
    return `El libro tiene demasiadas partes internas (${entradas.length}; el límite es ${XLSX_MAX_ENTRADAS}).`;
  }
  const descomprimido = entradas.reduce((suma, e) => suma + e.tamanoDescomprimido, 0);
  if (descomprimido > XLSX_MAX_BYTES_DESCOMPRIMIDOS) {
    const mb = Math.round(descomprimido / 1024 / 1024);
    return `El libro ocupa ${mb} MB al descomprimirse y el límite es ${Math.round(XLSX_MAX_BYTES_DESCOMPRIMIDOS / 1024 / 1024)} MB.`;
  }
  const comprimido = Math.max(
    entradas.reduce((suma, e) => suma + e.tamanoComprimido, 0),
    1,
  );
  if (descomprimido / comprimido > XLSX_MAX_RATIO_COMPRESION) {
    return 'El libro tiene una razón de compresión sospechosa y se rechaza por seguridad.';
  }
  return undefined;
}

/**
 * ¿Es texto UTF-8? El texto plano no tiene firma: se reconoce por lo que NO
 * contiene. Un binario casi siempre trae bytes nulos; el texto, nunca.
 */
function esTextoUtf8(contenido: Uint8Array): boolean {
  const muestra = contenido.subarray(0, Math.min(contenido.length, 8192));
  if (muestra.includes(0)) return false;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(muestra.subarray(0, muestra.length - 4));
    return true;
  } catch {
    return false;
  }
}

/**
 * Tipo real del archivo según su contenido.
 *
 * Los formatos binarios se reconocen por su firma, y esa firma manda sobre lo
 * que declare quien sube el archivo.
 *
 * El texto plano no tiene firma: por contenido no hay forma de distinguir un
 * Markdown de un script, porque ambos son texto. Ahí el contenido solo puede
 * decir "esto es texto", y hace falta la extensión para desempatar.
 *
 * El principio se mantiene: **el contenido solo puede restringir, nunca
 * ampliar**. Un archivo con firma de PDF es PDF aunque se llame `.md`; y un
 * texto sin firma solo se acepta si además dice llamarse `.md`. Por eso un
 * script renombrado a `.pptx` sigue rechazándose (caso S-05).
 */
export function detectarTipo(contenido: Uint8Array, nombre?: string | undefined): string | undefined {
  if (empiezaCon(contenido, [0x25, 0x50, 0x44, 0x46, 0x2d])) return MIME_PDF; // %PDF-
  if (empiezaCon(contenido, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return MIME_PNG;
  if (empiezaCon(contenido, [0xff, 0xd8, 0xff])) return MIME_JPEG;
  if (empiezaCon(contenido, [0x50, 0x4b, 0x03, 0x04])) return tipoOoxml(contenido); // PK..

  const referencia = (nombre ?? '').toLowerCase();
  const pareceCsv = EXTENSIONES_CSV.some((ext) => referencia.endsWith(ext));
  if (pareceCsv && contenido.length > 0 && esTextoUtf8(contenido)) return MIME_CSV;
  const pareceTexto = EXTENSIONES_TEXTO.some((ext) => referencia.endsWith(ext));
  if (pareceTexto && contenido.length > 0 && esTextoUtf8(contenido)) return MIME_MARKDOWN;

  return undefined;
}

/** Firma de los contenedores OLE antiguos (`.xls`, `.doc`, `.ppt`) y de los OOXML cifrados. */
function esContenedorOle(bytes: Uint8Array): boolean {
  return empiezaCon(bytes, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
}

export function validarArchivo(
  contenido: Uint8Array,
  tamanoBytes: number,
  maxBytes: number,
  declarado?: string | undefined,
  nombre?: string | undefined,
): ResultadoValidacion {
  if (tamanoBytes <= 0) {
    return { valido: false, motivo: 'El archivo está vacío.' };
  }

  if (tamanoBytes > maxBytes) {
    const mb = Math.round((tamanoBytes / 1024 / 1024) * 10) / 10;
    const limite = Math.round(maxBytes / 1024 / 1024);
    return { valido: false, motivo: `El archivo pesa ${mb} MB y el límite es ${limite} MB.` };
  }

  const real = detectarTipo(contenido, nombre);

  if (real === undefined && esContenedorOle(contenido)) {
    return {
      valido: false,
      codigo: 'UNSUPPORTED_SOURCE_FORMAT',
      motivo:
        'Los archivos de Office antiguos (.xls, .doc, .ppt) y los protegidos con contraseña no son compatibles. ' +
        'Guárdelo como .xlsx, .docx o .pptx sin contraseña.',
    };
  }

  if (real === undefined) {
    return {
      valido: false,
      motivo:
        'No se reconoce el tipo de archivo. Formatos aceptados: Markdown, PDF, PPTX, DOCX, XLSX, CSV, PNG y JPG.',
    };
  }

  if (!FORMATOS_PERMITIDOS.includes(real)) {
    return { valido: false, mimeType: real, motivo: `El tipo ${real} no está permitido.` };
  }

  if (real === MIME_XLSX) {
    const rechazo = motivoDeRechazoXlsx(contenido);
    if (rechazo !== undefined) {
      return { valido: false, mimeType: real, codigo: 'INVALID_SPREADSHEET', motivo: rechazo };
    }
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
