/**
 * KPI pactado en el Sheet (V2 · Fase 8, DEC-049): una SUGERENCIA de lectura, jamás un objetivo.
 *
 * `obtenerKpiPactadoDelSheet` resuelve participación → binding (`influencer_source_bindings`) → fuente → snapshot
 * VIGENTE (`current_snapshot_id`, no el de origen del binding) → registro por `source_key` y devuelve SOLO el texto
 * literal de la columna `kpi_objetivo`, con su procedencia (snapshot, celda, hash). Nunca `fee`, `canje` ni las
 * demás columnas «futuras»: el resto de la fila no sale de aquí. No materializa nada: una persona decide si el
 * texto se convierte en un objetivo (`registrarKpiObjetivo` con `sheetSuggestion`).
 *
 * El texto es CONTENIDO NO CONFIABLE (lo escribió un tercero en un Sheet): quien lo muestre al agente debe
 * envolverlo como dato, no como instrucción. Capacidad: `kpi:target_manage`.
 */

import { createHash } from 'node:crypto';
import { type Result, type SheetRowLocator, type User, validateInfluencerSheet } from '@tcl-kol-os/domain';
import { getPool } from './client.ts';
import {
  type Consultor,
  NO_ENCONTRADO,
  autorizarOAbortar,
  leerParticipacion,
  lectura,
} from './kpi-shared.ts';
import { cargarRejillaDeSnapshot } from './source-sync.ts';
import { Abortar } from './tx-result.ts';

export interface KpiPactadoDelSheet {
  readonly campaignInfluencerId: string;
  /** Clave de la persona en el Sheet (`clave_influencer`, normalizada). */
  readonly sourceKey: string;
  /** Texto LITERAL de la celda `kpi_objetivo` (sin interpretar). */
  readonly text: string;
  /** `true` si otra fila de la misma persona trae un `kpi_objetivo` distinto (se devuelve el de la primera fila). */
  readonly ambiguous: boolean;
  readonly provenance: {
    readonly sourceId: string;
    readonly snapshotId: string;
    readonly snapshotSequence: number;
    /** ¿Es la lectura vigente de la fuente? */
    readonly isCurrentSnapshot: boolean;
    /** La CELDA de `kpi_objetivo` dentro del Sheet. */
    readonly locator: SheetRowLocator;
    /** SHA-256 (hex) del texto. */
    readonly textHash: string;
  };
}

export const huellaDeTextoDeKpi = (texto: string): string => createHash('sha256').update(texto).digest('hex');

/**
 * Lee el `kpi_objetivo` de la participación en el snapshot indicado (por omisión, el vigente de su fuente). Solo
 * lectura. `null` si la persona no viene de un Sheet, la fuente no tiene lectura, el Sheet ya no se valida o la
 * columna/celda no existe.
 */
export async function resolverKpiPactado(
  db: Consultor,
  participacion: { readonly id: string; readonly organization_id: string; readonly campaign_id: string },
  opciones: { readonly snapshotId?: string | undefined } = {},
): Promise<KpiPactadoDelSheet | null> {
  const { rows: bindings } = await db.query<{
    source_id: string;
    source_key: string;
    current_snapshot_id: string | null;
    gid: string | null;
  }>(
    `SELECT b.source_id, b.source_key, s.current_snapshot_id, s.external_metadata ->> 'gid' AS gid
       FROM influencer_source_bindings b
       JOIN source_documents s ON s.id = b.source_id
      WHERE b.campaign_influencer_id = $1
        AND s.campaign_id = $2 AND s.organization_id = $3
      ORDER BY b.created_at DESC, b.id`,
    [participacion.id, participacion.campaign_id, participacion.organization_id],
  );
  const binding = bindings.find((b) => b.current_snapshot_id !== null || opciones.snapshotId !== undefined);
  if (binding === undefined) return null;

  const snapshotId = opciones.snapshotId ?? binding.current_snapshot_id;
  if (snapshotId === null) return null;
  const { rows: snapshot } = await db.query<{ sequence: number }>(
    `SELECT sequence FROM source_snapshots WHERE id = $1 AND source_id = $2`,
    [snapshotId, binding.source_id],
  );
  if (snapshot[0] === undefined) return null;

  const grid = await cargarRejillaDeSnapshot(db, snapshotId);
  const validacion = validateInfluencerSheet(grid, {
    gid: binding.gid !== null && /^\d+$/.test(binding.gid) ? Number(binding.gid) : undefined,
  });
  if (validacion.sheet === null) return null;
  const cabecera = validacion.headers.find((h) => h.column === 'kpi_objetivo');
  if (cabecera === undefined) return null;
  const registro = validacion.records.find((r) => r.sourceKey === binding.source_key);
  if (registro === undefined) return null;
  const valores = registro.futureValues
    .filter((v) => v.column === 'kpi_objetivo' && v.text !== '')
    .sort((a, b) => a.row - b.row);
  const primero = valores[0];
  if (primero === undefined) return null;

  return {
    campaignInfluencerId: participacion.id,
    sourceKey: registro.sourceKey,
    text: primero.text,
    ambiguous: valores.some((v) => v.text !== primero.text),
    provenance: {
      sourceId: binding.source_id,
      snapshotId,
      snapshotSequence: snapshot[0].sequence,
      isCurrentSnapshot: snapshotId === binding.current_snapshot_id,
      locator: {
        kind: 'range',
        sheet: validacion.sheet.name,
        range: `${cabecera.letter}${primero.row}`,
        rowStart: primero.row,
        rowEnd: primero.row,
        colStart: cabecera.index,
        colEnd: cabecera.index,
      },
      textHash: huellaDeTextoDeKpi(primero.text),
    },
  };
}

/**
 * El KPI que el Sheet pacta para esta participación (SUGERENCIA; no materializa nada). `kpi:target_manage`
 * (admin, director, consultor). Ajeno/cliente → `RESOURCE_NOT_FOUND`. `null` si no hay binding, lectura o columna.
 */
export async function obtenerKpiPactadoDelSheet(
  actor: User,
  campaignInfluencerId: string,
): Promise<Result<KpiPactadoDelSheet | null>> {
  return lectura(async () => {
    const participacion = await leerParticipacion(getPool(), campaignInfluencerId, false);
    if (participacion === undefined) throw new Abortar(NO_ENCONTRADO);
    autorizarOAbortar(actor, 'kpi:target_manage', participacion.organization_id);
    return resolverKpiPactado(getPool(), participacion);
  });
}
