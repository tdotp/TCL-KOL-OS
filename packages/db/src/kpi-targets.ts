/**
 * Objetivos de KPI (V2 · Fase 8, DEC-049): lo PACTADO con la participación.
 *
 *   campaign_influencers ─< kpi_targets   (ámbito: participación | entregable; plataforma opcional)
 *
 * Reglas:
 *  · Escribir exige `kpi:target_manage` (admin, director, consultor). Origen `ui` o `chat`; el chat SOLO por la
 *    herramienta del agente (correlación `toolInvocationId`): `kpi_target_register` es el único write del agente.
 *    Retirar es SIEMPRE por la interfaz.
 *  · Solo en campaña `activa` y con la participación `activo`. Un único objetivo vigente por (participación,
 *    entregable, métrica, etiqueta, unidad, plataforma): para cambiarlo se REEMPLAZA (`supersedesId`), y la base
 *    cierra el anterior; un objetivo tiene a lo sumo un sucesor.
 *  · Idempotente por (participación, `idempotencyKey`): el reintento idéntico devuelve el mismo objetivo
 *    (`repetido`); la misma clave con otra solicitud ⇒ `RESOURCE_CONFLICT` `idempotency_key_reused`.
 *  · `sheetSuggestion`: el texto de `kpi_objetivo` del Sheet es una SUGERENCIA; si viene, su procedencia
 *    (snapshot, celda y hash) se VERIFICA contra el snapshot y se guarda; el valor lo fija la persona.
 *  · Auditoría `kpi_target.registered | superseded | retired` con origen y correlación; metadata solo con ids,
 *    métrica y unidad (jamás etiquetas `other`, valores ni texto del Sheet).
 */

import {
  type KpiComparator,
  type KpiMetric,
  type KpiUnit,
  type Result,
  type SheetRowLocator,
  type User,
  err,
  validarClaveDeKpi,
  validarObjetivoDeKpi,
} from '@tcl-kol-os/domain';
import { recordAudit } from './audit.ts';
import { type ContextoDeAuditoria, auditoriaDe, exigirPersona } from './audit-context.ts';
import {
  type FilaDeObjetivo,
  type ObjetivoDeKpiVista,
  NO_ENCONTRADO,
  SELECT_OBJETIVO,
  aceptar,
  autorizarOAbortar,
  comoObjetivoVista,
  conflicto,
  esUuid,
  exigirEntregableDeParticipacion,
  invalido,
  leerParticipacion,
  transaccionKpi,
} from './kpi-shared.ts';
import { resolverKpiPactado } from './kpi-sheet-pactado.ts';
import { exigirPersonaPorUiOAbortar, huellaDeSolicitud } from './operational-events.ts';
import { Abortar } from './tx-result.ts';

export interface SugerenciaDeSheet {
  /** La lectura (snapshot) de la que salió el texto. */
  readonly snapshotId: string;
  /** La celda `kpi_objetivo` (la que devolvió `obtenerKpiPactadoDelSheet`). */
  readonly locator: SheetRowLocator;
  /** SHA-256 (hex) del texto leído. */
  readonly textHash: string;
}

export interface RegistrarKpiObjetivoInput {
  readonly campaignInfluencerId: string;
  /** Ámbito: un entregable de ESTA participación; sin él, la participación entera. */
  readonly deliverableId?: string | null | undefined;
  readonly metric: KpiMetric;
  /** Obligatoria con `other` (y solo con ella). */
  readonly otherLabel?: string | null | undefined;
  /** Opcional: la fija el catálogo; si viene, debe coincidir. */
  readonly unit?: KpiUnit | undefined;
  readonly targetValue: number;
  /** `gte` (al menos; por omisión) o `lte` (como máximo). */
  readonly comparator?: KpiComparator | undefined;
  readonly platform?: string | null | undefined;
  /** `YYYY-MM-DD`. */
  readonly periodStart?: string | null | undefined;
  readonly periodEnd?: string | null | undefined;
  /** El objetivo vigente que este reemplaza (mismo ámbito, métrica y unidad). */
  readonly supersedesId?: string | null | undefined;
  readonly idempotencyKey: string;
  readonly sheetSuggestion?: SugerenciaDeSheet | undefined;
}

export interface ObjetivoRegistrado {
  readonly objetivo: ObjetivoDeKpiVista;
  /** `true` si era un reintento idéntico (misma clave y solicitud): no se escribió nada. */
  readonly repetido: boolean;
}

/** Persona + canal: `ui` o `chat` (este último solo desde una invocación de herramienta). */
function origenDeObjetivo(
  actor: unknown,
  contexto: ContextoDeAuditoria | undefined,
): { persona: User; canal: 'ui' | 'chat' } {
  const persona = exigirPersona(actor, contexto);
  if (!persona.ok) {
    throw new Abortar({
      code: persona.error.code,
      message: persona.error.message,
      details: persona.error.details,
    });
  }
  const canal = contexto?.origin ?? 'ui';
  if (canal === 'chat') {
    if (
      contexto?.correlation?.toolInvocationId === undefined ||
      contexto.correlation.toolInvocationId === ''
    ) {
      throw new Abortar({
        code: 'FORBIDDEN_ROLE',
        message: 'El chat solo fija objetivos de KPI a través de la herramienta del agente.',
        details: { reason: 'chat_requires_tool_invocation' },
      });
    }
    return { persona: persona.value, canal: 'chat' };
  }
  return { persona: persona.value, canal: 'ui' };
}

function validarSugerencia(s: SugerenciaDeSheet | undefined): SugerenciaDeSheet | undefined {
  if (s === undefined) return undefined;
  const l = s.locator as Partial<SheetRowLocator> | null | undefined;
  if (
    typeof s.snapshotId !== 'string' ||
    !esUuid(s.snapshotId) ||
    typeof s.textHash !== 'string' ||
    !/^[0-9a-f]{64}$/.test(s.textHash) ||
    typeof l !== 'object' ||
    l === null ||
    l.kind !== 'range' ||
    typeof l.sheet !== 'string' ||
    typeof l.range !== 'string' ||
    typeof l.rowStart !== 'number' ||
    typeof l.rowEnd !== 'number' ||
    typeof l.colStart !== 'number' ||
    typeof l.colEnd !== 'number'
  ) {
    throw invalido(
      'La procedencia de la sugerencia del Sheet no es válida.',
      'sheetSuggestion',
      'invalid_provenance',
    );
  }
  return s;
}

/**
 * Fija un objetivo de KPI (o lo reemplaza con `supersedesId`). Ver el encabezado del módulo para las reglas.
 * Ajeno/cliente → `RESOURCE_NOT_FOUND`; rol sin `kpi:target_manage` → `FORBIDDEN_ROLE`.
 */
export async function registrarKpiObjetivo(
  actor: User,
  input: RegistrarKpiObjetivoInput,
  contexto?: ContextoDeAuditoria,
): Promise<Result<ObjetivoRegistrado>> {
  return transaccionKpi(async (client) => {
    const { persona, canal } = origenDeObjetivo(actor, contexto);
    const participacion = await leerParticipacion(client, input.campaignInfluencerId, true);
    if (participacion === undefined) throw new Abortar(NO_ENCONTRADO);
    autorizarOAbortar(persona, 'kpi:target_manage', participacion.organization_id);

    const clave = aceptar(validarClaveDeKpi(input.idempotencyKey));
    const norm = aceptar(validarObjetivoDeKpi(input));
    const deliverableId = await exigirEntregableDeParticipacion(
      client,
      input.deliverableId,
      participacion.id,
    );
    let supersedesId: string | null = null;
    if (input.supersedesId !== undefined && input.supersedesId !== null) {
      if (!esUuid(input.supersedesId)) throw new Abortar(NO_ENCONTRADO);
      supersedesId = input.supersedesId;
    }
    const sugerencia = validarSugerencia(input.sheetSuggestion);

    const huella = huellaDeSolicitud({
      tipo: 'kpi_target',
      campaignInfluencerId: participacion.id,
      deliverableId,
      platform: norm.platform,
      metric: norm.metric,
      otherLabel: norm.otherLabel,
      unit: norm.unit,
      targetValue: norm.targetValue,
      comparator: norm.comparator,
      periodStart: norm.periodStart,
      periodEnd: norm.periodEnd,
      supersedesId,
      sheet:
        sugerencia === undefined
          ? null
          : { snapshotId: sugerencia.snapshotId, textHash: sugerencia.textHash, locator: sugerencia.locator },
    });

    // Idempotencia ANTES de las reglas de estado: un reintento tras archivar la campaña devuelve lo ya hecho.
    const { rows: previos } = await client.query<FilaDeObjetivo>(
      `${SELECT_OBJETIVO} WHERE t.campaign_influencer_id = $1 AND t.idempotency_key = $2`,
      [participacion.id, clave],
    );
    if (previos[0] !== undefined) {
      if (previos[0].request_hash !== huella) {
        throw conflicto('Esa clave de idempotencia ya se usó con otra solicitud.', 'idempotency_key_reused');
      }
      return { objetivo: comoObjetivoVista(previos[0]), repetido: true };
    }

    if (participacion.campana !== 'activa') {
      throw conflicto(
        'La campaña debe estar activa para fijar o reemplazar un objetivo de KPI.',
        'campaign_not_active',
      );
    }
    if (participacion.status !== 'activo') {
      throw conflicto(
        'El influencer está retirado de la campaña: no admite objetivos nuevos (su historia se conserva).',
        'participation_not_active',
      );
    }

    if (supersedesId !== null) {
      const { rows } = await client.query<FilaDeObjetivo>(
        `${SELECT_OBJETIVO} WHERE t.id = $1 AND t.campaign_influencer_id = $2 FOR UPDATE`,
        [supersedesId, participacion.id],
      );
      const anterior = rows[0];
      if (anterior === undefined) throw new Abortar(NO_ENCONTRADO);
      if (anterior.status !== 'active') {
        throw conflicto(
          anterior.status === 'superseded'
            ? 'Ese objetivo ya fue reemplazado: parta del vigente.'
            : 'Ese objetivo fue retirado: fije uno nuevo sin reemplazo.',
          anterior.status === 'superseded' ? 'already_superseded' : 'target_retired',
          { targetId: anterior.id },
        );
      }
      if (
        anterior.deliverable_id !== deliverableId ||
        anterior.platform !== norm.platform ||
        anterior.metric !== norm.metric ||
        anterior.other_label !== norm.otherLabel ||
        anterior.unit !== norm.unit
      ) {
        throw invalido(
          'Un reemplazo conserva el ámbito, la métrica y la unidad del objetivo que reemplaza.',
          'supersedesId',
          'supersedes_scope_mismatch',
        );
      }
    } else {
      const { rows } = await client.query<{ id: string }>(
        `SELECT id FROM kpi_targets
          WHERE campaign_influencer_id = $1 AND status = 'active'
            AND deliverable_id IS NOT DISTINCT FROM $2
            AND metric = $3
            AND COALESCE(lower(other_label), '') = COALESCE(lower($4::text), '')
            AND unit = $5
            AND platform IS NOT DISTINCT FROM $6`,
        [participacion.id, deliverableId, norm.metric, norm.otherLabel, norm.unit, norm.platform],
      );
      if (rows[0] !== undefined) {
        throw conflicto(
          'Ya hay un objetivo vigente para ese ámbito y esa métrica: reemplácelo en lugar de crear otro.',
          'active_target_exists',
          { targetId: rows[0].id },
        );
      }
    }

    let procedencia: { snapshotId: string; locator: SheetRowLocator; textHash: string } | undefined;
    if (sugerencia !== undefined) {
      const leido = await resolverKpiPactado(client, participacion, { snapshotId: sugerencia.snapshotId });
      const l = leido?.provenance.locator;
      if (
        leido === null ||
        l === undefined ||
        leido.provenance.textHash !== sugerencia.textHash ||
        l.sheet !== sugerencia.locator.sheet ||
        l.range !== sugerencia.locator.range ||
        l.rowStart !== sugerencia.locator.rowStart ||
        l.colStart !== sugerencia.locator.colStart
      ) {
        throw invalido(
          'La sugerencia del Sheet no coincide con la lectura indicada (celda u hash distintos).',
          'sheetSuggestion',
          'sheet_suggestion_mismatch',
        );
      }
      procedencia = { snapshotId: sugerencia.snapshotId, locator: l, textHash: leido.provenance.textHash };
    }

    const { rows: creado } = await client.query<{ id: string }>(
      `INSERT INTO kpi_targets
         (organization_id, campaign_id, campaign_influencer_id, deliverable_id, platform, metric, other_label,
          unit, target_value, comparator, period_start, period_end, supersedes_id, origin, source_snapshot_id,
          source_locator, source_text_hash, origin_channel, idempotency_key, request_hash, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21)
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
        norm.targetValue,
        norm.comparator,
        norm.periodStart,
        norm.periodEnd,
        supersedesId,
        procedencia === undefined ? 'manual' : 'sheet_suggestion',
        procedencia?.snapshotId ?? null,
        procedencia === undefined ? null : JSON.stringify(procedencia.locator),
        procedencia?.textHash ?? null,
        canal,
        clave,
        huella,
        persona.id,
      ],
    );
    const id = creado[0]!.id;
    await recordAudit(
      client,
      auditoriaDe(persona, contexto, {
        action: supersedesId === null ? 'kpi_target.registered' : 'kpi_target.superseded',
        entityType: 'kpi_target',
        entityId: id,
        metadata: {
          targetId: id,
          campaignId: participacion.campaign_id,
          campaignInfluencerId: participacion.id,
          metric: norm.metric,
          unit: norm.unit,
          ...(supersedesId === null ? {} : { supersedesId }),
        },
      }),
    );
    const { rows } = await client.query<FilaDeObjetivo>(`${SELECT_OBJETIVO} WHERE t.id = $1`, [id]);
    return { objetivo: comoObjetivoVista(rows[0]!), repetido: false };
  });
}

export interface ObjetivoRetirado {
  readonly objetivo: ObjetivoDeKpiVista;
  /** `true` si ya estaba retirado (nada que hacer). */
  readonly repetido: boolean;
}

/**
 * Retira un objetivo vigente (marca `retired_at`; no se borra). `kpi:target_manage`, SIEMPRE por la interfaz.
 * Idempotente: retirar uno ya retirado devuelve el mismo. Un objetivo reemplazado ya es histórico (conflicto).
 * Exige campaña activa. Una participación retirada puede ver retirados sus objetivos.
 */
export async function retirarKpiObjetivo(
  actor: User,
  targetId: string,
  contexto?: ContextoDeAuditoria,
): Promise<Result<ObjetivoRetirado>> {
  if (!esUuid(targetId)) return err(NO_ENCONTRADO);
  return transaccionKpi(async (client) => {
    const persona = exigirPersonaPorUiOAbortar(actor, contexto);
    const { rows } = await client.query<FilaDeObjetivo>(`${SELECT_OBJETIVO} WHERE t.id = $1 FOR UPDATE`, [
      targetId,
    ]);
    const fila = rows[0];
    if (fila === undefined) throw new Abortar(NO_ENCONTRADO);
    autorizarOAbortar(persona, 'kpi:target_manage', fila.organization_id);
    if (fila.status === 'retired') return { objetivo: comoObjetivoVista(fila), repetido: true };
    if (fila.status === 'superseded') {
      throw conflicto('Ese objetivo ya fue reemplazado: es histórico.', 'already_superseded', {
        targetId: fila.id,
      });
    }
    const participacion = await leerParticipacion(client, fila.campaign_influencer_id, true);
    if (participacion?.campana !== 'activa') {
      throw conflicto('La campaña debe estar activa para retirar un objetivo de KPI.', 'campaign_not_active');
    }
    await client.query(
      `UPDATE kpi_targets SET status = 'retired', retired_by = $2, retired_at = now() WHERE id = $1`,
      [fila.id, persona.id],
    );
    await recordAudit(
      client,
      auditoriaDe(persona, contexto, {
        action: 'kpi_target.retired',
        entityType: 'kpi_target',
        entityId: fila.id,
        metadata: {
          targetId: fila.id,
          campaignId: fila.campaign_id,
          campaignInfluencerId: fila.campaign_influencer_id,
          metric: fila.metric,
          unit: fila.unit,
        },
      }),
    );
    const { rows: despues } = await client.query<FilaDeObjetivo>(`${SELECT_OBJETIVO} WHERE t.id = $1`, [
      fila.id,
    ]);
    return { objetivo: comoObjetivoVista(despues[0]!), repetido: false };
  });
}
