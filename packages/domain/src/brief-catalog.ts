/**
 * Catálogo único de los 41 campos del brief (D0-05, DEC-021, DEC-016).
 *
 * Por qué existe este archivo
 * ----------------------------
 * Antes de este incremento, el catálogo de campos vivía derivado por separado
 * en Python (`services/ai-worker/app/brief_schema.py`) y en ningún lado del
 * lado TypeScript. La corrección 4 del cierre de Sprint 4 exige que exista
 * **una sola fuente canónica**, no un catálogo TS que reinterprete el Python,
 * ni un JSON parcial. Ese archivo es `docs/product/brief-schema/brief-catalog.json`
 * — este módulo solo lo carga y lo tipa; `brief_schema.py` lee el mismo
 * archivo (ver Fase C del cierre de Sprint 4). Un script de verificación
 * (`scripts/verificar-catalogo.mjs`) compara ambos lados en CI.
 *
 * `brief.schema.json` (forma/validación JSON Schema, D0-05) y este catálogo
 * (metadatos de producto: criticidad, nivel, etiqueta) son archivos distintos
 * a propósito — responsabilidades distintas, no hace falta fusionarlos.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Criticality } from './types.ts';

const _RELATIVA = join('docs', 'product', 'brief-schema', 'brief-catalog.json');

/**
 * Dónde está el catálogo. Mismo problema que ya resolvió el worker en Python
 * (`ruta_esquema()`): el árbol es distinto en el monorepo y dentro de un
 * contenedor. Nunca se cuenta un número fijo de directorios hacia arriba
 * (`parents[N]`) — eso se rompió en Docker (HANDOFF §8.4) — se declara por
 * variable de entorno y, si no, se busca hacia arriba verificando existencia
 * en cada nivel.
 */
function rutaCatalogo(): string {
  const declarada = process.env['BRIEF_CATALOG_PATH']?.trim();
  if (declarada) return declarada;

  let base = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 10; i++) {
    const candidata = join(base, _RELATIVA);
    try {
      readFileSync(candidata, 'utf8');
      return candidata;
    } catch {
      const arriba = dirname(base);
      if (arriba === base) break;
      base = arriba;
    }
  }

  throw new Error(`No se encontró brief-catalog.json. Defina BRIEF_CATALOG_PATH o monte ${_RELATIVA}.`);
}

export type CampoNivel = 'campana' | 'producto' | 'compartido_con_excepcion';
export type CampoValueType = 'texto' | 'lista' | 'lista_objetos' | 'fecha' | 'enum' | 'numero';

export interface CampoDelCatalogo {
  readonly key: string;
  readonly label: string;
  /** Bloque canónico de D0-05: contexto, objetivo, target_audiencia, ... */
  readonly section: string;
  readonly description: string;
  readonly criticidad: Criticality;
  readonly nivel: CampoNivel;
  readonly valueType: CampoValueType;
  readonly valoresPermitidos?: readonly string[] | undefined;
  readonly fechaConfig?: { readonly permitePrecision: boolean } | undefined;
  /** Solo aplica de verdad cuando `nivel === 'compartido_con_excepcion'` (DEC-016). */
  readonly admiteExcepcionPorProducto: boolean;
}

interface CampoCrudo {
  key: string;
  label: string;
  section: string;
  description: string;
  criticidad: Criticality;
  nivel: CampoNivel;
  valueType: CampoValueType;
  valoresPermitidos?: string[];
  fechaConfig?: { permitePrecision: boolean };
  admiteExcepcionPorProducto: boolean;
}

let cache: readonly CampoDelCatalogo[] | undefined;

/** Los 41 campos del catálogo (DEC-021), leídos una sola vez por proceso. */
export function catalogoDelBrief(): readonly CampoDelCatalogo[] {
  if (cache) return cache;
  const crudo = JSON.parse(readFileSync(rutaCatalogo(), 'utf8')) as CampoCrudo[];
  cache = crudo.map((c) => ({ ...c }));
  return cache;
}

export function campoDelCatalogo(key: string): CampoDelCatalogo | undefined {
  return catalogoDelBrief().find((c) => c.key === key);
}

export function clavesValidas(): ReadonlySet<string> {
  return new Set(catalogoDelBrief().map((c) => c.key));
}

/** Campos de nivel `producto`: se repiten uno por cada producto de la campaña (DEC-016). */
export function camposDeNivel(nivel: CampoNivel): readonly CampoDelCatalogo[] {
  return catalogoDelBrief().filter((c) => c.nivel === nivel);
}
