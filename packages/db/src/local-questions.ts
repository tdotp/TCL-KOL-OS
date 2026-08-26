/**
 * Preguntas locales — Épica E6, completa (Sprint 4, cierre §5).
 *
 * Antes de este incremento, `local_questions` era una tabla con dos
 * restricciones probadas en SQL crudo (`brief-rules.test.ts`) y ninguna
 * función de repositorio. Este módulo es esa capa: generar, listar,
 * responder y descartar, todo auditado y con la validación estructurada que
 * exige DEC-015 (el sistema nunca inventa) también para las respuestas
 * manuales.
 */

import { type Result, type User, campoDelCatalogo, err, ok } from '@tcl-kol-os/domain';
import { assertCapability } from './authz.ts';
import { recordAudit } from './audit.ts';
import { getPool, transaction } from './client.ts';
import { cargarVersion } from './brief-version.ts';

// ─────────────────────────── Generación (§5.1, §5.2) ───────────────────────────

interface TextoPregunta {
  readonly question: string;
  readonly reason: string;
}

function precisionEnPalabras(tipo: string): string {
  switch (tipo) {
    case 'mes':
      return 'el mes';
    case 'rango':
      return 'un rango';
    case 'aproximada':
      return 'una fecha aproximada';
    case 'pendiente_confirmar':
      return 'una fecha pendiente de confirmar';
    default:
      return 'una fecha imprecisa';
  }
}

function esFechaImprecisa(value: unknown): value is { tipo: string; textoOriginal?: string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'tipo' in value &&
    (value as { tipo: unknown }).tipo !== 'exacta'
  );
}

/**
 * Decide si un campo necesita una pregunta local, y con qué texto.
 * `null` significa que este campo no la necesita — no todo `not_found`
 * genera una: un informativo vacío no bloquea nada (DEC-021).
 */
function preguntaParaCampo(campo: {
  key: string;
  criticidad: string;
  status: string;
  value: unknown;
}): TextoPregunta | null {
  const etiqueta = campoDelCatalogo(campo.key)?.label ?? campo.key;
  const esCriticoOClaim = campo.criticidad === 'critico' || campo.criticidad === 'claim';

  if (esCriticoOClaim && campo.status === 'not_found') {
    return {
      question: `¿Cuál es el valor de «${etiqueta}»?`,
      reason: 'No se encontró en las fuentes cargadas.',
    };
  }

  if (esCriticoOClaim && campo.status === 'conflict') {
    return {
      question: `Las fuentes se contradicen sobre «${etiqueta}». ¿Cuál es el valor correcto?`,
      reason: 'Dos o más fuentes dan valores distintos para este campo.',
    };
  }

  if (campo.criticidad === 'critico' && campo.status === 'found' && esFechaImprecisa(campo.value)) {
    const texto = campo.value.textoOriginal ? ` (la fuente dice: «${campo.value.textoOriginal}»)` : '';
    return {
      question: `¿Cuál es la fecha exacta de «${etiqueta}»?`,
      reason: `Las fuentes solo precisan ${precisionEnPalabras(campo.value.tipo)}${texto}. Indique el día exacto si lo necesita.`,
    };
  }

  return null;
}

/**
 * Genera las preguntas locales pendientes de una versión. Idempotente: los
 * índices únicos de la migración 005 hacen que ejecutarla dos veces no
 * duplique nada (prueba 2). Si crea al menos una y el estado es
 * `extraction_review`, dispara `extraction_review → local_questions`.
 */
export async function generarPreguntas(
  actor: User,
  versionId: string,
): Promise<Result<{ creadas: number }>> {
  const permitido = assertCapability(actor, 'question:create');
  if (!permitido.ok) return err({ code: permitido.error.code, message: permitido.error.message });

  const datos = await cargarVersion(getPool(), versionId);
  if (!datos || datos.organizationId !== actor.organizationId) {
    return err({ code: 'RESOURCE_NOT_FOUND', message: 'El recurso no existe o no está disponible.' });
  }

  let creadas = 0;

  await transaction(async (client) => {
    for (const campo of datos.version.fields) {
      const texto = preguntaParaCampo(campo);
      if (!texto) continue;

      const resultado = await client.query(
        `INSERT INTO local_questions
                (campaign_id, brief_version_id, key, campaign_product_id, question, reason, criticidad)
         VALUES ($1, $2, $3, $4, $5, $6, $7::criticality)
         ON CONFLICT DO NOTHING
         RETURNING id`,
        [
          datos.campaignId,
          versionId,
          campo.key,
          campo.campaignProductId ?? null,
          texto.question,
          texto.reason,
          campo.criticidad,
        ],
      );
      if (resultado.rowCount) creadas += 1;
    }

    if (creadas > 0) {
      await recordAudit(client, {
        actor,
        action: 'question.generate',
        entityType: 'brief_version',
        entityId: versionId,
        metadata: { creadas },
      });
    }
  });

  if (creadas > 0 && datos.version.status === 'extraction_review') {
    const { transicionarBrief } = await import('./transitions.ts');
    await transicionarBrief(actor, versionId, 'local_questions');
  }

  return ok({ creadas });
}

// ─────────────────────────── Lectura (UI-09) ───────────────────────────────────

export interface LocalQuestionRow {
  readonly id: string;
  readonly campaignId: string;
  readonly briefVersionId: string | null;
  readonly key: string;
  readonly label: string;
  readonly campaignProductId: string | null;
  readonly question: string;
  readonly reason: string;
  readonly criticidad: string;
  readonly status: 'pendiente' | 'respondida' | 'descartada';
  readonly answer: string | null;
  readonly answerValue: unknown;
  readonly answeredBy: string | null;
  readonly answeredByName: string | null;
  readonly answeredAt: Date | null;
  readonly createdAt: Date;
}

export async function listarPreguntas(
  actor: User,
  campaignId: string,
  filtro?: { status?: 'pendiente' | 'respondida' | 'descartada'; campaignProductId?: string },
): Promise<Result<LocalQuestionRow[]>> {
  const permitido = assertCapability(actor, 'brief:read');
  if (!permitido.ok) return err({ code: permitido.error.code, message: permitido.error.message });

  const propia = await getPool().query<{ id: string }>(
    `SELECT id FROM campaigns WHERE id = $1 AND organization_id = $2`,
    [campaignId, actor.organizationId],
  );
  if (propia.rowCount === 0) {
    return err({ code: 'RESOURCE_NOT_FOUND', message: 'El recurso no existe o no está disponible.' });
  }

  const condiciones = ['lq.campaign_id = $1'];
  const params: unknown[] = [campaignId];
  if (filtro?.status) {
    params.push(filtro.status);
    condiciones.push(`lq.status = $${params.length}::question_status`);
  }
  if (filtro?.campaignProductId) {
    params.push(filtro.campaignProductId);
    condiciones.push(`lq.campaign_product_id = $${params.length}`);
  }

  const filas = await getPool().query<{
    id: string;
    campaign_id: string;
    brief_version_id: string | null;
    key: string;
    campaign_product_id: string | null;
    question: string;
    reason: string;
    criticidad: string;
    status: 'pendiente' | 'respondida' | 'descartada';
    answer: string | null;
    answer_value: unknown;
    answered_by: string | null;
    answered_by_name: string | null;
    answered_at: Date | null;
    created_at: Date;
  }>(
    `SELECT lq.id, lq.campaign_id, lq.brief_version_id, lq.key, lq.campaign_product_id,
            lq.question, lq.reason, lq.criticidad::text, lq.status::text, lq.answer,
            lq.answer_value, lq.answered_by, u.name AS answered_by_name, lq.answered_at,
            lq.created_at
       FROM local_questions lq
       LEFT JOIN users u ON u.id = lq.answered_by
      WHERE ${condiciones.join(' AND ')}
      ORDER BY lq.criticidad = 'critico' DESC, lq.created_at ASC`,
    params,
  );

  return ok(
    filas.rows.map((f) => ({
      id: f.id,
      campaignId: f.campaign_id,
      briefVersionId: f.brief_version_id,
      key: f.key,
      label: campoDelCatalogo(f.key)?.label ?? f.key,
      campaignProductId: f.campaign_product_id,
      question: f.question,
      reason: f.reason,
      criticidad: f.criticidad,
      status: f.status,
      answer: f.answer,
      answerValue: f.answer_value,
      answeredBy: f.answered_by,
      answeredByName: f.answered_by_name,
      answeredAt: f.answered_at,
      createdAt: f.created_at,
    })),
  );
}

// ─────────────────────────── Validación estructurada (corrección 3) ───────────

/**
 * Valida `answerValue` contra la definición canónica del campo antes de
 * aplicarlo. Nunca se guarda `"2026-11"` como texto libre donde el campo
 * espera un objeto de fecha con precisión — se rechaza con un mensaje
 * accionable antes de tocar la base.
 */
function validarValorEstructurado(
  key: string,
  valor: unknown,
): { ok: true } | { ok: false; mensaje: string } {
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
          (v) => typeof v === 'object' && v !== null && 'descripcion' in v && typeof (v as { descripcion: unknown }).descripcion === 'string',
        )
      ) {
        return { ok: false, mensaje: `«${campo.label}» espera una lista de objetos con "descripcion".` };
      }
      return { ok: true };

    case 'fecha': {
      if (typeof valor !== 'object' || valor === null || !('tipo' in valor)) {
        return {
          ok: false,
          mensaje: `«${campo.label}» espera un objeto de fecha con precisión (DEC-026), no texto libre.`,
        };
      }
      const v = valor as { tipo: unknown; fecha?: unknown; inicio?: unknown; fin?: unknown };
      const tiposValidos = ['exacta', 'mes', 'rango', 'aproximada', 'pendiente_confirmar'];
      if (typeof v.tipo !== 'string' || !tiposValidos.includes(v.tipo)) {
        return { ok: false, mensaje: `«${campo.label}»: tipo de precisión de fecha inválido.` };
      }
      if ((v.tipo === 'exacta' || v.tipo === 'mes') && typeof v.fecha !== 'string') {
        return { ok: false, mensaje: `«${campo.label}»: falta "fecha" para el tipo «${v.tipo}».` };
      }
      if (v.tipo === 'rango' && (typeof v.inicio !== 'string' || typeof v.fin !== 'string')) {
        return { ok: false, mensaje: `«${campo.label}»: el rango exige "inicio" y "fin".` };
      }
      return { ok: true };
    }

    default:
      return { ok: true };
  }
}

// ─────────────────────────── Responder y descartar (§5.4) ─────────────────────

export async function responderPregunta(
  actor: User,
  questionId: string,
  opciones: { answerValue: unknown; answer?: string | undefined },
): Promise<Result<true>> {
  const permitido = assertCapability(actor, 'question:answer');
  if (!permitido.ok) return err({ code: permitido.error.code, message: permitido.error.message });

  const pregunta = await getPool().query<{
    id: string;
    campaign_id: string;
    brief_version_id: string | null;
    key: string;
    status: string;
  }>(`SELECT lq.id, lq.campaign_id, lq.brief_version_id, lq.key, lq.status::text FROM local_questions lq
        JOIN campaigns c ON c.id = lq.campaign_id
       WHERE lq.id = $1 AND c.organization_id = $2`, [questionId, actor.organizationId]);
  const fila = pregunta.rows[0];
  if (!fila) {
    return err({ code: 'RESOURCE_NOT_FOUND', message: 'El recurso no existe o no está disponible.' });
  }
  if (!fila.brief_version_id) {
    return err({ code: 'BRIEF_FIELD_INVALID', message: 'Esta pregunta no está ligada a una versión del brief.' });
  }

  const validacion = validarValorEstructurado(fila.key, opciones.answerValue);
  if (!validacion.ok) {
    return err({ code: 'BRIEF_FIELD_INVALID', message: validacion.mensaje });
  }

  await transaction(async (client) => {
    await client.query(
      `UPDATE local_questions
          SET answer_value = $1::jsonb, answer = $2, answered_by = $3, answered_at = now(),
              status = 'respondida'
        WHERE id = $4`,
      [JSON.stringify(opciones.answerValue), opciones.answer ?? null, actor.id, questionId],
    );

    const campo = await client.query<{ id: string; value: unknown; revision: number }>(
      `SELECT id, value, revision FROM brief_fields
        WHERE brief_version_id = $1 AND key = $2
          AND campaign_product_id IS NOT DISTINCT FROM (
            SELECT campaign_product_id FROM local_questions WHERE id = $3
          )`,
      [fila.brief_version_id, fila.key, questionId],
    );
    const campoFila = campo.rows[0];
    if (!campoFila) return;

    await client.query(
      `UPDATE brief_fields
          SET value = $1::jsonb, status = 'found', provenance_type = 'manual_local',
              review_status = 'confirmed', reviewed_by = $2, reviewed_at = now()
        WHERE id = $3`,
      [JSON.stringify(opciones.answerValue), actor.id, campoFila.id],
    );

    await client.query(
      `INSERT INTO brief_field_revisions
              (brief_field_id, brief_version_id, accion, valor_anterior, valor_nuevo, actor_id)
       VALUES ($1, $2, 'apply_answer', $3::jsonb, $4::jsonb, $5)`,
      [
        campoFila.id,
        fila.brief_version_id,
        campoFila.value === null ? null : JSON.stringify(campoFila.value),
        JSON.stringify(opciones.answerValue),
        actor.id,
      ],
    );

    await recordAudit(client, {
      actor,
      action: 'question.answer',
      entityType: 'local_question',
      entityId: questionId,
      metadata: { questionId, campo: fila.key },
    });
  });

  return ok(true);
}

export async function descartarPregunta(
  actor: User,
  questionId: string,
  justificacion: string,
): Promise<Result<true>> {
  const permitido = assertCapability(actor, 'question:discard');
  if (!permitido.ok) return err({ code: permitido.error.code, message: permitido.error.message });

  if (justificacion.trim() === '') {
    return err({
      code: 'BRIEF_FIELD_INVALID',
      message: 'Descartar una pregunta exige indicar por qué (E6-4).',
    });
  }

  const pregunta = await getPool().query<{ id: string }>(
    `SELECT lq.id FROM local_questions lq
       JOIN campaigns c ON c.id = lq.campaign_id
      WHERE lq.id = $1 AND c.organization_id = $2`,
    [questionId, actor.organizationId],
  );
  if (pregunta.rowCount === 0) {
    return err({ code: 'RESOURCE_NOT_FOUND', message: 'El recurso no existe o no está disponible.' });
  }

  await transaction(async (client) => {
    await client.query(
      `UPDATE local_questions
          SET answer = $1, answer_value = NULL, answered_by = $2, answered_at = now(),
              status = 'descartada'
        WHERE id = $3`,
      [justificacion, actor.id, questionId],
    );

    await recordAudit(client, {
      actor,
      action: 'question.discard',
      entityType: 'local_question',
      entityId: questionId,
      metadata: { justificacion },
    });
  });

  return ok(true);
}
