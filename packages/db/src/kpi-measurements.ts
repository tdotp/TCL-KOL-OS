/**
 * Mediciones de KPI (V2 · Fase 8, DEC-049): lo OBSERVADO en la participación. Append-only.
 *
 *   campaign_influencers ─< kpi_measurements   (mismo ámbito que el objetivo con el que se compara)
 *
 * Reglas:
 *  · Escribir exige `kpi:measure` (admin, director, operativo; el consultor fija objetivos pero NO mide) y es
 *    SIEMPRE una persona por la interfaz (`ui`): ni el chat ni el sistema registran resultados.
 *  · Campaña `activa` o `archivada` (los resultados llegan cuando la campaña ya cerró); `cancelada` no. Una
 *    participación retirada conserva su historia y admite que se complete.
 *  · Idempotente por (participación, `idempotencyKey`): el doble envío devuelve la misma medición (`repetido`);
 *    la misma clave con otro contenido ⇒ `RESOURCE_CONFLICT` `idempotency_key_reused`.
 *  · Corregir NO edita: inserta una fila nueva con `supersedes_id` y su motivo (obligatorio); la anterior queda
 *    intacta. Una sola corrección por fila: de dos simultáneas gana una y la otra recibe `RESOURCE_CONFLICT`
 *    `already_corrected`. La medición vigente es la última observación no corregida (lo resuelven las lecturas).
 *  · Auditoría `kpi_measurement.recorded | corrected`: ids, métrica y unidad; jamás el valor, la etiqueta `other`
 *    ni el motivo.
 */

import {
  type KpiMetric,
  type KpiUnit,
  type Result,
  type User,
  err,
  validarClaveDeKpi,
  validarMedicionDeKpi,
  validarMotivoDeCorreccionDeKpi,
  validarObservacionDeKpi,
  validarValorDeKpi,
} from '@tcl-kol-os/domain';
import { recordAudit } from './audit.ts';
import { type ContextoDeAuditoria, auditoriaDe } from './audit-context.ts';
import {
  type FilaDeMedicion,
  type MedicionDeKpiVista,
  NO_ENCONTRADO,
  SELECT_MEDICION,
  aceptar,
  autorizarOAbortar,
  comoMedicionVista,
  conflicto,
  esUuid,
  exigirEntregableDeParticipacion,
  leerParticipacion,
  transaccionKpi,
} from './kpi-shared.ts';
import { exigirPersonaPorUiOAbortar, huellaDeSolicitud } from './operational-events.ts';
import { Abortar } from './tx-result.ts';

export interface RegistrarMedicionKpiInput {
  readonly campaignInfluencerId: string;
  /** Ámbito: un entregable de ESTA participación; sin él, la participación entera. */
  readonly deliverableId?: string | null | undefined;
  readonly platform?: string | null | undefined;
  readonly metric: KpiMetric;
  /** Obligatoria con `other` (y solo con ella). */
  readonly otherLabel?: string | null | undefined;
  /** Opcional: la fija el catálogo; si viene, debe coincidir. */
  readonly unit?: KpiUnit | undefined;
  readonly value: number;
  /** Cuándo se observó el resultado (ISO 8601; no en el futuro). */
  readonly observedAt: string | Date;
  /** `YYYY-MM-DD`. */
  readonly periodStart?: string | null | undefined;
  readonly periodEnd?: string | null | undefined;
  readonly idempotencyKey: string;
}

export interface MedicionRegistrada {
  readonly medicion: MedicionDeKpiVista;
  /** `true` si era un reintento idéntico (misma clave y solicitud): no se escribió nada. */
  readonly repetido: boolean;
}

function exigirCampanaAbierta(campana: string): void {
  if (campana !== 'activa' && campana !== 'archivada') {
    throw conflicto(
      'La campaña está cancelada: no admite mediciones de KPI (activa o archivada sí).',
      'campaign_cancelled',
    );
  }
}

/**
 * Registra una medición. `kpi:measure`, siempre por la interfaz. Ajeno/cliente → `RESOURCE_NOT_FOUND`; rol sin
 * `kpi:measure` → `FORBIDDEN_ROLE`; el chat → `HUMAN_CONFIRMATION_REQUIRED`.
 */
export async function registrarMedicionKpi(
  actor: User,
  input: RegistrarMedicionKpiInput,
  contexto?: ContextoDeAuditoria,
): Promise<Result<MedicionRegistrada>> {
  return transaccionKpi(async (client) => {
    const persona = exigirPersonaPorUiOAbortar(actor, contexto);
    const participacion = await leerParticipacion(client, input.campaignInfluencerId, true);
    if (participacion === undefined) throw new Abortar(NO_ENCONTRADO);
    autorizarOAbortar(persona, 'kpi:measure', participacion.organization_id);

    const clave = aceptar(validarClaveDeKpi(input.idempotencyKey));
    const norm = aceptar(validarMedicionDeKpi(input));
    const deliverableId = await exigirEntregableDeParticipacion(
      client,
      input.deliverableId,
      participacion.id,
    );

    const huella = huellaDeSolicitud({
      tipo: 'kpi_measurement',
      campaignInfluencerId: participacion.id,
      deliverableId,
      platform: norm.platform,
      metric: norm.metric,
      otherLabel: norm.otherLabel,
      unit: norm.unit,
      value: norm.value,
      observedAt: norm.observedAt,
      periodStart: norm.periodStart,
      periodEnd: norm.periodEnd,
    });
    const { rows: previos } = await client.query<FilaDeMedicion>(
      `${SELECT_MEDICION} WHERE m.campaign_influencer_id = $1 AND m.idempotency_key = $2`,
      [participacion.id, clave],
    );
    if (previos[0] !== undefined) {
      if (previos[0].request_hash !== huella) {
        throw conflicto('Esa clave de idempotencia ya se usó con otra solicitud.', 'idempotency_key_reused');
      }
      return { medicion: comoMedicionVista(previos[0]), repetido: true };
    }
    exigirCampanaAbierta(participacion.campana);

    const { rows: creado } = await client.query<{ id: string }>(
      `INSERT INTO kpi_measurements
         (organization_id, campaign_id, campaign_influencer_id, deliverable_id, platform, metric, other_label,
          unit, value, observed_at, period_start, period_end, recorded_by, origin_channel, idempotency_key,
          request_hash)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 'ui', $14, $15)
       RETURNING id`,
      [
        participacion.organization_id,
        participacion.campaign_id,
        participacion.id,
        deliverableId,
        norm.platform,
        norm.metric,
        norm.otherLabel,
        norm.unit,
        norm.value,
        norm.observedAt,
        norm.periodStart,
        norm.periodEnd,
        persona.id,
        clave,
        huella,
      ],
    );
    const id = creado[0]!.id;
    await recordAudit(
      client,
      auditoriaDe(persona, contexto, {
        action: 'kpi_measurement.recorded',
        entityType: 'kpi_measurement',
        entityId: id,
        metadata: {
          measurementId: id,
          campaignId: participacion.campaign_id,
          campaignInfluencerId: participacion.id,
          metric: norm.metric,
          unit: norm.unit,
        },
      }),
    );
    const { rows } = await client.query<FilaDeMedicion>(`${SELECT_MEDICION} WHERE m.id = $1`, [id]);
    return { medicion: comoMedicionVista(rows[0]!), repetido: false };
  });
}

export interface CorregirMedicionKpiInput {
  /** El valor correcto. */
  readonly value: number;
  /** Por qué se corrige (obligatorio; texto interno, jamás a auditoría ni al agente). */
  readonly correctionReason: string;
  /** Nueva fecha de observación; por omisión, la de la medición corregida. */
  readonly observedAt?: string | Date | undefined;
  readonly idempotencyKey: string;
}

/**
 * Corrige una medición: inserta una fila NUEVA (la anterior queda intacta) del mismo ámbito, métrica y unidad,
 * con su motivo. Una sola corrección por medición (`already_corrected`). `kpi:measure`, siempre por la interfaz.
 * Idempotente por (participación, clave).
 */
export async function corregirMedicionKpi(
  actor: User,
  measurementId: string,
  input: CorregirMedicionKpiInput,
  contexto?: ContextoDeAuditoria,
): Promise<Result<MedicionRegistrada>> {
  if (!esUuid(measurementId)) return err(NO_ENCONTRADO);
  return transaccionKpi(async (client) => {
    const persona = exigirPersonaPorUiOAbortar(actor, contexto);
    // Se localiza la medición sin bloquear para conocer su participación; luego se bloquea en el orden
    // participación → medición.
    const { rows: ubicada } = await client.query<{ campaign_influencer_id: string }>(
      `SELECT campaign_influencer_id FROM kpi_measurements WHERE id = $1`,
      [measurementId],
    );
    if (ubicada[0] === undefined) throw new Abortar(NO_ENCONTRADO);
    const participacion = await leerParticipacion(client, ubicada[0].campaign_influencer_id, true);
    if (participacion === undefined) throw new Abortar(NO_ENCONTRADO);
    autorizarOAbortar(persona, 'kpi:measure', participacion.organization_id);

    const clave = aceptar(validarClaveDeKpi(input.idempotencyKey));
    const motivo = aceptar(validarMotivoDeCorreccionDeKpi(input.correctionReason));

    // Serializa las correcciones de la misma fila: la segunda espera y ve a la primera.
    const { rows } = await client.query<FilaDeMedicion>(`${SELECT_MEDICION} WHERE m.id = $1 FOR UPDATE`, [
      measurementId,
    ]);
    const original = rows[0];
    if (original === undefined) throw new Abortar(NO_ENCONTRADO);

    const valor = aceptar(validarValorDeKpi(original.metric, input.value));
    const observadaEn = aceptar(
      validarObservacionDeKpi(input.observedAt ?? original.observed_at, new Date()),
    );
    const huella = huellaDeSolicitud({
      tipo: 'kpi_correction',
      measurementId,
      value: valor,
      observedAt: observadaEn,
      correctionReason: motivo,
    });
    const { rows: previos } = await client.query<FilaDeMedicion>(
      `${SELECT_MEDICION} WHERE m.campaign_influencer_id = $1 AND m.idempotency_key = $2`,
      [participacion.id, clave],
    );
    if (previos[0] !== undefined) {
      if (previos[0].request_hash !== huella) {
        throw conflicto('Esa clave de idempotencia ya se usó con otra solicitud.', 'idempotency_key_reused');
      }
      return { medicion: comoMedicionVista(previos[0]), repetido: true };
    }
    exigirCampanaAbierta(participacion.campana);

    const { rows: corrector } = await client.query<{ id: string }>(
      `SELECT id FROM kpi_measurements WHERE supersedes_id = $1`,
      [measurementId],
    );
    if (corrector[0] !== undefined) {
      throw conflicto(
        'Esa medición ya fue corregida (una sola corrección por medición).',
        'already_corrected',
        {
          correctionId: corrector[0].id,
        },
      );
    }

    const { rows: creado } = await client.query<{ id: string }>(
      `INSERT INTO kpi_measurements
         (organization_id, campaign_id, campaign_influencer_id, deliverable_id, platform, metric, other_label,
          unit, value, observed_at, period_start, period_end, recorded_by, origin_channel, idempotency_key,
          request_hash, supersedes_id, correction_reason)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 'ui', $14, $15, $16, $17)
       RETURNING id`,
      [
        original.organization_id,
        original.campaign_id,
        original.campaign_influencer_id,
        original.deliverable_id,
        original.platform,
        original.metric,
        original.other_label,
        original.unit,
        valor,
        observadaEn,
        original.period_start,
        original.period_end,
        persona.id,
        clave,
        huella,
        original.id,
        motivo,
      ],
    );
    const id = creado[0]!.id;
    await recordAudit(
      client,
      auditoriaDe(persona, contexto, {
        action: 'kpi_measurement.corrected',
        entityType: 'kpi_measurement',
        entityId: id,
        metadata: {
          measurementId: id,
          supersedesId: original.id,
          campaignId: original.campaign_id,
          campaignInfluencerId: original.campaign_influencer_id,
          metric: original.metric,
          unit: original.unit,
        },
      }),
    );
    const { rows: despues } = await client.query<FilaDeMedicion>(`${SELECT_MEDICION} WHERE m.id = $1`, [id]);
    return { medicion: comoMedicionVista(despues[0]!), repetido: false };
  });
}
