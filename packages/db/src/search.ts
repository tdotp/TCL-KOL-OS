/**
 * Búsqueda de evidencia sobre el índice vectorial (Épica E5-2).
 *
 * La regla que gobierna este archivo es §10.3, regla 7: **el filtro por
 * organización y campaña va dentro de la consulta**, nunca después.
 *
 * La diferencia no es de estilo. Un `ORDER BY distancia LIMIT 10` seguido de un
 * filtro en memoria devuelve los diez fragmentos más parecidos *del universo
 * entero* y luego descarta los ajenos: el resultado son menos de diez —a veces
 * cero— y, mientras tanto, el proceso tuvo en memoria material de otra agencia.
 * Con el filtro dentro, el `LIMIT` se aplica sobre lo que el usuario ya podía
 * ver, y los diez que llegan son diez.
 *
 * El vector de la consulta lo produce el worker (`POST /embeddings/consulta`),
 * porque es el único que habla con el proveedor de IA (D0-09 §3). Esta capa
 * pone la autorización, que es lo que el worker no puede saber.
 */

import { query } from './client.ts';

/** Un fragmento recuperado, con lo necesario para abrirlo en su fuente. */
export interface EvidenceHit {
  readonly fragmentId: string;
  readonly sourceId: string;
  readonly filename: string;
  readonly sourceType: string;
  readonly text: string;
  /** Localizador: el que corresponda al formato (DEC-018). */
  readonly page: number | null;
  readonly slide: number | null;
  readonly section: string | null;
  readonly linea: number | null;
  /** 0 = idéntico, 2 = opuesto. Distancia coseno, tal como la da pgvector. */
  readonly distancia: number;
}

export interface BusquedaOpciones {
  /** Alcance obligatorio. Sin esto no hay búsqueda. */
  readonly organizationId: string;
  readonly campaignId: string;
  readonly vector: readonly number[];
  readonly limite?: number;
  /**
   * Distancia máxima aceptable. Por encima, el fragmento se descarta aunque sea
   * el más parecido: es preferible no ofrecer evidencia a ofrecer una que no
   * viene al caso — §9.4 prefiere `not_found` sobre un respaldo inventado.
   */
  readonly distanciaMaxima?: number;
}

/** Tope duro: ninguna búsqueda devuelve más que esto, pida lo que pida. */
const LIMITE_MAXIMO = 50;
const LIMITE_POR_DEFECTO = 10;
const DISTANCIA_POR_DEFECTO = 0.65;

/** Dimensión del índice; debe coincidir con `source_fragments.embedding`. */
const DIMENSIONES = 1536;

interface Fila {
  fragment_id: string;
  source_id: string;
  filename: string;
  source_type: string;
  text: string;
  page: number | null;
  slide: number | null;
  section: string | null;
  linea: number | null;
  distancia: string;
}

export async function buscarEvidencia(opciones: BusquedaOpciones): Promise<EvidenceHit[]> {
  const { organizationId, campaignId, vector } = opciones;

  if (!organizationId || !campaignId) {
    // No hay búsqueda "sin alcance". Un valor vacío que llegue por descuido no
    // puede convertirse en una consulta que mire toda la base.
    throw new Error('La búsqueda exige organización y campaña.');
  }
  if (vector.length !== DIMENSIONES) {
    throw new Error(
      `El vector de consulta tiene ${vector.length} dimensiones y el índice espera ${DIMENSIONES}.`,
    );
  }

  const limite = Math.min(opciones.limite ?? LIMITE_POR_DEFECTO, LIMITE_MAXIMO);
  const distanciaMaxima = opciones.distanciaMaxima ?? DISTANCIA_POR_DEFECTO;
  const literal = `[${vector.join(',')}]`;

  const filas = await query<Fila>(
    `SELECT f.id            AS fragment_id,
            s.id            AS source_id,
            s.filename,
            s.type::text    AS source_type,
            f.text,
            f.page, f.slide, f.section, f.linea,
            (f.embedding <=> $3::vector) AS distancia
       FROM source_fragments f
       JOIN source_documents s ON s.id = f.source_id
      WHERE s.organization_id = $1
        AND s.campaign_id     = $2
        AND s.status          = 'procesado'
        AND s.confidentiality_level <> 'sensible'
        AND f.embedding IS NOT NULL
        AND (f.embedding <=> $3::vector) <= $4
      ORDER BY f.embedding <=> $3::vector
      LIMIT $5`,
    [organizationId, campaignId, literal, distanciaMaxima, limite],
  );

  return filas.map((f) => ({
    fragmentId: f.fragment_id,
    sourceId: f.source_id,
    filename: f.filename,
    sourceType: f.source_type,
    text: f.text,
    page: f.page,
    slide: f.slide,
    section: f.section,
    linea: f.linea,
    distancia: Number(f.distancia),
  }));
}

/**
 * Cuántos fragmentos de una campaña están indexados y cuántos no.
 *
 * Sirve para que la interfaz pueda decir *"la búsqueda no encuentra nada porque
 * este documento todavía no está indexado"*, que es distinto de *"no hay nada
 * que encontrar"*. Confundir las dos cosas es lo que hace que la gente deje de
 * confiar en un buscador.
 */
export async function estadoDelIndice(
  organizationId: string,
  campaignId: string,
): Promise<{ indexados: number; sinIndexar: number; excluidos: number }> {
  const [fila] = await query<{ indexados: string; sin_indexar: string; excluidos: string }>(
    `SELECT count(*) FILTER (
              WHERE f.embedding IS NOT NULL AND s.confidentiality_level <> 'sensible'
            ) AS indexados,
            count(*) FILTER (
              WHERE f.embedding IS NULL AND s.confidentiality_level <> 'sensible'
            ) AS sin_indexar,
            count(*) FILTER (WHERE s.confidentiality_level = 'sensible') AS excluidos
       FROM source_fragments f
       JOIN source_documents s ON s.id = f.source_id
      WHERE s.organization_id = $1 AND s.campaign_id = $2`,
    [organizationId, campaignId],
  );

  return {
    indexados: Number(fila?.indexados ?? 0),
    sinIndexar: Number(fila?.sin_indexar ?? 0),
    excluidos: Number(fila?.excluidos ?? 0),
  };
}
