/**
 * Lecturas de KPI (V2 · Fase 8, DEC-049): marcador, historial y resumen por campaña. Solo lectura, `kpi:read`
 * (admin, director, consultor, operativo). Ajeno/cliente → `RESOURCE_NOT_FOUND`; analista/legal → `FORBIDDEN_ROLE`.
 *
 * Dos bloques por construcción:
 *  · `public`: lo ÚNICO apto para una futura proyección a TCL o para el agente — métrica, unidad, objetivo,
 *    actual, logro, estado y fecha de observación. NADA de actor, motivo de corrección, origen ni procedencia.
 *  · `internal`: lo mismo MÁS quién, cuándo, por qué canal, el motivo de la corrección y la procedencia del
 *    Sheet. Es de uso interno de la agencia.
 *
 * Comparación: la hace el dominio puro (`compararKpis`): solo métrica+unidad+ámbito compatibles; la medición
 * vigente es la última observación no corregida; nada se suma entre métricas ni entregables. Columnas por lista
 * blanca; el resumen por campaña usa tres consultas por lote (sin N+1).
 */

import {
  KPI_METRICS,
  type ComparacionDeKpi,
  type EstadoDeKpi,
  type KpiComparator,
  type KpiMetric,
  type KpiUnit,
  type ResumenKpi,
  type Result,
  type User,
  RESUMEN_KPI_VACIO,
  authorizeInternalResource,
  compararKpi,
  isKpiMetric,
  medicionVigenteDe,
  resumirKpi,
} from '@tcl-kol-os/domain';
import { getPool } from './client.ts';
import {
  type FilaDeMedicion,
  type FilaDeObjetivo,
  type EstadoDeObjetivo,
  NO_ENCONTRADO,
  SELECT_MEDICION,
  SELECT_MEDICION_CON_AUTOR,
  SELECT_OBJETIVO,
  SELECT_OBJETIVO_CON_AUTOR,
  autorizarOAbortar,
  comoMedicionDeDominio,
  comoObjetivoDeDominio,
  esUuid,
  invalido,
  leerParticipacion,
  lectura,
} from './kpi-shared.ts';
import { Abortar } from './tx-result.ts';

// ─────────────────────────── Marcador de la participación ──────────────────────

/** Lo que un cliente (TCL) podría ver algún día: nada de actor, motivo ni procedencia. */
export interface KpiPublico {
  readonly metric: KpiMetric;
  /** Etiqueta de la métrica `other`; `null` en el resto. */
  readonly otherLabel: string | null;
  readonly unit: KpiUnit;
  readonly comparator: KpiComparator;
  readonly target: number;
  readonly actual: number | null;
  readonly delta: number | null;
  /** actual / objetivo · 100 (2 decimales). */
  readonly achievement: number | null;
  readonly estado: EstadoDeKpi;
  /** Cuándo se observó la medición comparada (ISO). */
  readonly observedAt: string | null;
  /** Ámbito: entregable (id) y plataforma, o `null` = participación entera / sin plataforma. */
  readonly deliverableId: string | null;
  readonly platform: string | null;
}

export interface KpiInterno extends KpiPublico {
  readonly targetId: string;
  readonly measurementId: string | null;
  readonly periodStart: string | null;
  readonly periodEnd: string | null;
  readonly targetOrigin: 'manual' | 'sheet_suggestion';
  readonly targetOriginChannel: 'ui' | 'chat';
  readonly targetCreatedBy: string;
  readonly targetCreatedByName: string | null;
  readonly targetCreatedAt: string;
  /** Procedencia de la sugerencia del Sheet (si el objetivo nació de una). */
  readonly sheetProvenance: {
    readonly snapshotId: string;
    readonly locator: unknown;
    readonly textHash: string;
  } | null;
  readonly measurementRecordedBy: string | null;
  readonly measurementRecordedByName: string | null;
  readonly measurementRecordedAt: string | null;
  readonly measurementOriginChannel: string | null;
  /** ¿La medición comparada es una corrección? */
  readonly measurementIsCorrection: boolean;
  readonly correctionReason: string | null;
}

export interface KpiDeParticipacion {
  readonly campaignInfluencerId: string;
  readonly public: readonly KpiPublico[];
  readonly internal: readonly KpiInterno[];
  readonly resumen: ResumenKpi;
}

interface FilaConNombre {
  readonly actor_name: string | null;
}

function ordenDeAmbito(a: FilaDeObjetivo, b: FilaDeObjetivo): number {
  const m = KPI_METRICS.indexOf(a.metric) - KPI_METRICS.indexOf(b.metric);
  if (m !== 0) return m;
  const d = (a.deliverable_id ?? '').localeCompare(b.deliverable_id ?? '');
  if (d !== 0) return d;
  const p = (a.platform ?? '').localeCompare(b.platform ?? '');
  if (p !== 0) return p;
  const l = (a.other_label ?? '').localeCompare(b.other_label ?? '');
  if (l !== 0) return l;
  return Number(a.seq) - Number(b.seq);
}

function publico(c: ComparacionDeKpi): KpiPublico {
  return {
    metric: c.metric,
    otherLabel: c.otherLabel,
    unit: c.unit,
    comparator: c.comparator,
    target: c.target,
    actual: c.actual,
    delta: c.delta,
    achievement: c.achievement,
    estado: c.estado,
    observedAt: c.observedAt,
    deliverableId: c.deliverableId,
    platform: c.platform,
  };
}

/**
 * Marcador de KPIs de una participación: por cada objetivo VIGENTE, objetivo · actual · logro · estado. `kpi:read`.
 */
export async function obtenerKpiDeParticipacion(
  actor: User,
  campaignInfluencerId: string,
): Promise<Result<KpiDeParticipacion>> {
  return lectura(async () => {
    const db = getPool();
    const participacion = await leerParticipacion(db, campaignInfluencerId, false);
    if (participacion === undefined) throw new Abortar(NO_ENCONTRADO);
    autorizarOAbortar(actor, 'kpi:read', participacion.organization_id);

    const { rows: objetivos } = await db.query<FilaDeObjetivo & FilaConNombre>(
      `${SELECT_OBJETIVO_CON_AUTOR}
        WHERE t.campaign_influencer_id = $1 AND t.status = 'active'`,
      [participacion.id],
    );
    objetivos.sort(ordenDeAmbito);
    const { rows: mediciones } = await db.query<FilaDeMedicion & FilaConNombre>(
      `${SELECT_MEDICION_CON_AUTOR}
        WHERE m.campaign_influencer_id = $1`,
      [participacion.id],
    );
    const dominio = mediciones.map(comoMedicionDeDominio);
    const filaDe = new Map(mediciones.map((m) => [m.id, m]));

    const comparaciones = objetivos.map((o) =>
      compararKpi(comoObjetivoDeDominio(o), medicionVigenteDe(comoObjetivoDeDominio(o), dominio)),
    );
    const internal: KpiInterno[] = comparaciones.map((c, i) => {
      const o = objetivos[i]!;
      const m = c.measurementId === null ? undefined : filaDe.get(c.measurementId);
      return {
        ...publico(c),
        targetId: o.id,
        measurementId: c.measurementId,
        periodStart: o.period_start,
        periodEnd: o.period_end,
        targetOrigin: o.origin,
        targetOriginChannel: o.origin_channel,
        targetCreatedBy: o.created_by,
        targetCreatedByName: o.actor_name,
        targetCreatedAt: o.created_at.toISOString(),
        sheetProvenance:
          o.source_snapshot_id === null || o.source_text_hash === null
            ? null
            : { snapshotId: o.source_snapshot_id, locator: o.source_locator, textHash: o.source_text_hash },
        measurementRecordedBy: m?.recorded_by ?? null,
        measurementRecordedByName: m?.actor_name ?? null,
        measurementRecordedAt: m === undefined ? null : m.recorded_at.toISOString(),
        measurementOriginChannel: m?.origin_channel ?? null,
        measurementIsCorrection: m?.supersedes_id != null,
        correctionReason: m?.correction_reason ?? null,
      };
    });
    return {
      campaignInfluencerId: participacion.id,
      public: comparaciones.map(publico),
      internal,
      resumen: resumirKpi(comparaciones),
    };
  });
}

// ─────────────────────────── Historial ─────────────────────────────────────────

export interface ObjetivoHistorialPublico {
  readonly id: string;
  readonly deliverableId: string | null;
  readonly platform: string | null;
  readonly metric: KpiMetric;
  readonly otherLabel: string | null;
  readonly unit: KpiUnit;
  readonly targetValue: number;
  readonly comparator: KpiComparator;
  readonly periodStart: string | null;
  readonly periodEnd: string | null;
  readonly status: EstadoDeObjetivo;
  readonly supersedesId: string | null;
  readonly createdAt: string;
  readonly supersededAt: string | null;
  readonly retiredAt: string | null;
}

export interface ObjetivoHistorialInterno extends ObjetivoHistorialPublico {
  readonly origin: 'manual' | 'sheet_suggestion';
  readonly originChannel: 'ui' | 'chat';
  readonly createdBy: string;
  readonly createdByName: string | null;
  readonly retiredBy: string | null;
  readonly sheetProvenance: {
    readonly snapshotId: string;
    readonly locator: unknown;
    readonly textHash: string;
  } | null;
}

export interface MedicionHistorialPublica {
  readonly id: string;
  readonly deliverableId: string | null;
  readonly platform: string | null;
  readonly metric: KpiMetric;
  readonly otherLabel: string | null;
  readonly unit: KpiUnit;
  readonly value: number;
  readonly observedAt: string;
  readonly periodStart: string | null;
  readonly periodEnd: string | null;
  /** La medición que esta corrige (cadena de supersession). */
  readonly supersedesId: string | null;
  /** ¿Otra medición la corrige? (entonces ya no es la vigente). */
  readonly corrected: boolean;
  /** ¿Es la medición vigente de su ámbito y métrica? (última observación no corregida). */
  readonly current: boolean;
  readonly recordedAt: string;
}

export interface MedicionHistorialInterna extends MedicionHistorialPublica {
  readonly recordedBy: string;
  readonly recordedByName: string | null;
  readonly originChannel: string;
  readonly correctionReason: string | null;
}

export interface HistorialDeKpi {
  readonly campaignInfluencerId: string;
  readonly public: {
    readonly targets: readonly ObjetivoHistorialPublico[];
    readonly measurements: readonly MedicionHistorialPublica[];
  };
  readonly internal: {
    readonly targets: readonly ObjetivoHistorialInterno[];
    readonly measurements: readonly MedicionHistorialInterna[];
  };
}

/**
 * Historial COMPLETO de KPIs de una participación (objetivos vigentes, reemplazados y retirados; mediciones
 * originales y correcciones, en orden de registro), opcionalmente de una métrica. `kpi:read`.
 */
export async function obtenerHistorialDeKpi(
  actor: User,
  input: { readonly campaignInfluencerId: string; readonly metric?: KpiMetric | undefined },
): Promise<Result<HistorialDeKpi>> {
  return lectura(async () => {
    const db = getPool();
    const participacion = await leerParticipacion(db, input.campaignInfluencerId, false);
    if (participacion === undefined) throw new Abortar(NO_ENCONTRADO);
    autorizarOAbortar(actor, 'kpi:read', participacion.organization_id);
    if (input.metric !== undefined && !isKpiMetric(input.metric)) {
      throw invalido('La métrica no está en el catálogo de KPI.', 'metric', 'metric_not_in_catalog');
    }
    const metrica = input.metric ?? null;

    const { rows: objetivos } = await db.query<FilaDeObjetivo & FilaConNombre>(
      `${SELECT_OBJETIVO_CON_AUTOR}
        WHERE t.campaign_influencer_id = $1 AND ($2::text IS NULL OR t.metric = $2)
        ORDER BY t.seq`,
      [participacion.id, metrica],
    );
    const { rows: mediciones } = await db.query<FilaDeMedicion & FilaConNombre>(
      `${SELECT_MEDICION_CON_AUTOR}
        WHERE m.campaign_influencer_id = $1 AND ($2::text IS NULL OR m.metric = $2)
        ORDER BY m.seq`,
      [participacion.id, metrica],
    );

    const corregidas = new Set(
      mediciones.flatMap((m) => (m.supersedes_id === null ? [] : [m.supersedes_id])),
    );
    const dominio = mediciones.map(comoMedicionDeDominio);
    const vigentes = new Set<string>();
    for (const m of mediciones) {
      const v = medicionVigenteDe(
        {
          campaignInfluencerId: m.campaign_influencer_id,
          deliverableId: m.deliverable_id,
          platform: m.platform,
          metric: m.metric,
          otherLabel: m.other_label,
        },
        dominio,
      );
      if (v !== undefined) vigentes.add(v.id);
    }

    const targetsPublicos: ObjetivoHistorialPublico[] = objetivos.map((o) => ({
      id: o.id,
      deliverableId: o.deliverable_id,
      platform: o.platform,
      metric: o.metric,
      otherLabel: o.other_label,
      unit: o.unit,
      targetValue: Number(o.target_value),
      comparator: o.comparator,
      periodStart: o.period_start,
      periodEnd: o.period_end,
      status: o.status,
      supersedesId: o.supersedes_id,
      createdAt: o.created_at.toISOString(),
      supersededAt: o.superseded_at === null ? null : o.superseded_at.toISOString(),
      retiredAt: o.retired_at === null ? null : o.retired_at.toISOString(),
    }));
    const medicionesPublicas: MedicionHistorialPublica[] = mediciones.map((m) => ({
      id: m.id,
      deliverableId: m.deliverable_id,
      platform: m.platform,
      metric: m.metric,
      otherLabel: m.other_label,
      unit: m.unit,
      value: Number(m.value),
      observedAt: m.observed_at.toISOString(),
      periodStart: m.period_start,
      periodEnd: m.period_end,
      supersedesId: m.supersedes_id,
      corrected: corregidas.has(m.id),
      current: vigentes.has(m.id),
      recordedAt: m.recorded_at.toISOString(),
    }));
    return {
      campaignInfluencerId: participacion.id,
      public: { targets: targetsPublicos, measurements: medicionesPublicas },
      internal: {
        targets: targetsPublicos.map((t, i) => {
          const o = objetivos[i]!;
          return {
            ...t,
            origin: o.origin,
            originChannel: o.origin_channel,
            createdBy: o.created_by,
            createdByName: o.actor_name,
            retiredBy: o.retired_by,
            sheetProvenance:
              o.source_snapshot_id === null || o.source_text_hash === null
                ? null
                : {
                    snapshotId: o.source_snapshot_id,
                    locator: o.source_locator,
                    textHash: o.source_text_hash,
                  },
          };
        }),
        measurements: medicionesPublicas.map((p, i) => {
          const m = mediciones[i]!;
          return {
            ...p,
            recordedBy: m.recorded_by,
            recordedByName: m.actor_name,
            originChannel: m.origin_channel,
            correctionReason: m.correction_reason,
          };
        }),
      },
    };
  });
}

// ─────────────────────────── Resumen por campaña ───────────────────────────────

/**
 * Resumen de KPIs de TODAS las participaciones de una campaña (mapa campaignInfluencerId → `ResumenKpi`), en
 * tres consultas por lote (sin N+1). Toda participación de la campaña aparece (sin objetivos ⇒
 * `sin_objetivos`). `kpi:read`. Lo usa la lista de operación.
 */
export async function obtenerResumenKpiDeCampana(
  actor: User,
  campaignId: string,
): Promise<Result<ReadonlyMap<string, ResumenKpi>>> {
  return lectura(async () => {
    if (!esUuid(campaignId)) throw new Abortar(NO_ENCONTRADO);
    const db = getPool();
    const { rows: campana } = await db.query<{ organization_id: string }>(
      `SELECT organization_id FROM campaigns WHERE id = $1`,
      [campaignId],
    );
    if (campana[0] === undefined) throw new Abortar(NO_ENCONTRADO);
    const permitido = authorizeInternalResource(actor, 'kpi:read', campana[0].organization_id);
    if (!permitido.ok) {
      throw new Abortar({
        code: permitido.error.code,
        message: permitido.error.message,
        details: permitido.error.details,
      });
    }

    const [{ rows: participaciones }, { rows: objetivos }, { rows: mediciones }] = await Promise.all([
      db.query<{ id: string }>(`SELECT id FROM campaign_influencers WHERE campaign_id = $1`, [campaignId]),
      db.query<FilaDeObjetivo>(`${SELECT_OBJETIVO} WHERE t.campaign_id = $1 AND t.status = 'active'`, [
        campaignId,
      ]),
      db.query<FilaDeMedicion>(
        `${SELECT_MEDICION}
          WHERE m.campaign_id = $1
            AND EXISTS (SELECT 1 FROM kpi_targets t
                         WHERE t.campaign_influencer_id = m.campaign_influencer_id
                           AND t.status = 'active' AND t.metric = m.metric)`,
        [campaignId],
      ),
    ]);

    const objetivosPor = new Map<string, FilaDeObjetivo[]>();
    for (const o of objetivos) {
      const lista = objetivosPor.get(o.campaign_influencer_id) ?? [];
      lista.push(o);
      objetivosPor.set(o.campaign_influencer_id, lista);
    }
    const medicionesPor = new Map<string, ReturnType<typeof comoMedicionDeDominio>[]>();
    for (const m of mediciones) {
      const lista = medicionesPor.get(m.campaign_influencer_id) ?? [];
      lista.push(comoMedicionDeDominio(m));
      medicionesPor.set(m.campaign_influencer_id, lista);
    }
    const resumen = new Map<string, ResumenKpi>();
    for (const p of participaciones) {
      const propios = objetivosPor.get(p.id);
      if (propios === undefined) {
        resumen.set(p.id, RESUMEN_KPI_VACIO);
        continue;
      }
      const suyas = medicionesPor.get(p.id) ?? [];
      resumen.set(
        p.id,
        resumirKpi(
          propios.map((o) => {
            const objetivo = comoObjetivoDeDominio(o);
            return compararKpi(objetivo, medicionVigenteDe(objetivo, suyas));
          }),
        ),
      );
    }
    return resumen;
  });
}
