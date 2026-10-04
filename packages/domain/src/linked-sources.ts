/**
 * Fuentes enlazadas (V2 · Fase 4).
 *
 * Una fuente no es necesariamente un archivo: puede ser un enlace externo
 * (p. ej. un Google Sheet). Aquí solo se REGISTRA y se identifica; nunca se
 * descarga ni se consulta. No hay `fetch` en este módulo ni debe haberlo: la
 * resolución del contenido será una integración específica por proveedor
 * (Fase 5), no un cliente HTTP genérico — ahí es donde nace el SSRF.
 *
 * Política deliberadamente estrecha:
 *  · solo `https`, sin credenciales en la URL, sin puerto explícito;
 *  · el host debe ser EXACTAMENTE uno de los proveedores conocidos (nada de
 *    sufijos ni subdominios, ni IPs, ni `localhost`);
 *  · se extrae el identificador estable del recurso (p. ej. el ID del archivo
 *    de Google) sin hacer ninguna llamada externa;
 *  · la URL canónica solo descarta lo que no cambia el recurso (`/edit`,
 *    parámetros de seguimiento). NO fusiona recursos distintos: dos pestañas
 *    (`gid`) de un mismo libro son enlaces distintos.
 */

import { type Result, err, ok } from './errors';

export type ExternalProvider =
  'google_sheets' | 'google_docs' | 'google_slides' | 'google_drive_file' | 'google_drive_folder';

export const EXTERNAL_PROVIDERS: readonly ExternalProvider[] = [
  'google_sheets',
  'google_docs',
  'google_slides',
  'google_drive_file',
  'google_drive_folder',
] as const;

export function isExternalProvider(value: unknown): value is ExternalProvider {
  return typeof value === 'string' && (EXTERNAL_PROVIDERS as readonly string[]).includes(value);
}

export interface EnlaceDeFuente {
  readonly provider: ExternalProvider;
  /** Identificador estable del recurso en el proveedor (p. ej. ID del archivo de Google). */
  readonly externalId: string;
  /** URL tal como se registró (recortada). */
  readonly originalUrl: string;
  /** Forma canónica: clave de deduplicación por campaña. */
  readonly canonicalUrl: string;
  /** Datos adicionales del enlace (p. ej. la pestaña `gid` de un Google Sheet). */
  readonly metadata: { readonly gid?: string | undefined };
}

const ETIQUETAS: Readonly<Record<ExternalProvider, string>> = {
  google_sheets: 'Google Sheets',
  google_docs: 'Google Docs',
  google_slides: 'Google Slides',
  google_drive_file: 'Archivo de Google Drive',
  google_drive_folder: 'Carpeta de Google Drive',
};

export function etiquetaDeProveedor(provider: ExternalProvider): string {
  return ETIQUETAS[provider];
}

const MAX_URL = 2048;
const HOSTS_PERMITIDOS = ['docs.google.com', 'drive.google.com'] as const;
/** Los ID de Google son [A-Za-z0-9_-]; los reales miden ~44. */
const ID_GOOGLE = '[A-Za-z0-9_-]{15,128}';
const CARACTERES_PROHIBIDOS = /[\s\p{Cc}\p{Cf}]/u;

function invalida<T>(reason: string, message: string): Result<T> {
  return err({ code: 'INVALID_SOURCE_URL', message, details: { reason } });
}

interface Coincidencia {
  readonly provider: ExternalProvider;
  readonly id: string;
  readonly canonica: string;
}

/** Ruta → proveedor, ID y forma canónica. `/u/N/` (índice de cuenta) se ignora. */
function reconocerRuta(host: string, ruta: string): Coincidencia | undefined {
  const sinCuenta = ruta.replace(/^\/(spreadsheets|document|presentation|file|drive)\/u\/\d{1,2}\//, '/$1/');
  if (host === 'docs.google.com') {
    const patrones: readonly [RegExp, ExternalProvider, string][] = [
      [new RegExp(`^/spreadsheets/d/(${ID_GOOGLE})(?:/|$)`), 'google_sheets', 'spreadsheets'],
      [new RegExp(`^/document/d/(${ID_GOOGLE})(?:/|$)`), 'google_docs', 'document'],
      [new RegExp(`^/presentation/d/(${ID_GOOGLE})(?:/|$)`), 'google_slides', 'presentation'],
    ];
    for (const [re, provider, segmento] of patrones) {
      const m = re.exec(sinCuenta);
      if (m) return { provider, id: m[1]!, canonica: `https://docs.google.com/${segmento}/d/${m[1]}` };
    }
  }
  if (host === 'drive.google.com') {
    const archivo = new RegExp(`^/file/d/(${ID_GOOGLE})(?:/|$)`).exec(sinCuenta);
    if (archivo) {
      return {
        provider: 'google_drive_file',
        id: archivo[1]!,
        canonica: `https://drive.google.com/file/d/${archivo[1]}`,
      };
    }
    const carpeta = new RegExp(`^/drive/folders/(${ID_GOOGLE})(?:/|$)`).exec(sinCuenta);
    if (carpeta) {
      return {
        provider: 'google_drive_folder',
        id: carpeta[1]!,
        canonica: `https://drive.google.com/drive/folders/${carpeta[1]}`,
      };
    }
  }
  return undefined;
}

/**
 * Analiza y normaliza el enlace de una fuente. NO hace ninguna llamada de red.
 * Devuelve `INVALID_SOURCE_URL` con el motivo si no es un enlace admitido.
 */
export function analizarEnlaceDeFuente(raw: unknown): Result<EnlaceDeFuente> {
  if (typeof raw !== 'string') return invalida('not_text', 'El enlace es obligatorio.');
  const original = raw.trim();
  if (original === '') return invalida('empty', 'El enlace es obligatorio.');
  if (original.length > MAX_URL)
    return invalida('too_long', `El enlace no puede superar ${MAX_URL} caracteres.`);
  if (CARACTERES_PROHIBIDOS.test(original)) {
    return invalida('invalid_characters', 'El enlace contiene espacios o caracteres no válidos.');
  }

  let url: URL;
  try {
    url = new URL(original);
  } catch {
    return invalida('malformed', 'El enlace no es una URL válida.');
  }

  if (url.protocol !== 'https:') return invalida('not_https', 'El enlace debe empezar por https://.');
  if (url.username !== '' || url.password !== '') {
    return invalida('credentials', 'El enlace no puede incluir usuario ni contraseña.');
  }
  if (url.port !== '') return invalida('port', 'El enlace no puede indicar un puerto.');

  const host = url.hostname.toLowerCase();
  if (!(HOSTS_PERMITIDOS as readonly string[]).includes(host)) {
    return invalida(
      'provider_not_allowed',
      'Solo se admiten enlaces de Google Docs, Sheets, Slides y Drive.',
    );
  }

  const coincidencia = reconocerRuta(host, url.pathname);
  if (coincidencia === undefined) {
    return invalida(
      'unrecognized_resource',
      'No se reconoce el recurso del enlace. Use el enlace de compartir del archivo de Google.',
    );
  }

  let gid: string | undefined;
  if (coincidencia.provider === 'google_sheets') {
    const deConsulta = url.searchParams.get('gid');
    const deFragmento = /(?:^|[#&])gid=(\d{1,12})(?:&|$)/.exec(url.hash)?.[1];
    const candidato = deConsulta ?? deFragmento;
    if (candidato !== undefined && candidato !== null && /^\d{1,12}$/.test(candidato)) gid = candidato;
  }

  return ok({
    provider: coincidencia.provider,
    externalId: coincidencia.id,
    originalUrl: original,
    canonicalUrl: gid === undefined ? coincidencia.canonica : `${coincidencia.canonica}#gid=${gid}`,
    metadata: gid === undefined ? {} : { gid },
  });
}
