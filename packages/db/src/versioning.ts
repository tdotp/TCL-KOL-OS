/**
 * Versionado posterior a aprobación (DEC-027, Sprint 5 Fase E).
 *
 * `approved` nunca se modifica (ADR-003). Cuando alguien autorizado necesita
 * cambiar un brief ya aprobado, esto crea una versión hija: copia el
 * contenido como punto de partida, deja la anterior `superseded` (nunca se
 * reescribe, sigue consultable tal cual quedó) y dos solicitudes
 * simultáneas nunca producen dos hijas — el candado es el mismo `UPDATE …
 * WHERE status = 'approved'` atómico que ya usa el resto del código para
 * concurrencia optimista, no un `SELECT` seguido de un `INSERT` separado.
 */

import { type Result, type User, err, ok } from '@tcl-kol-os/domain';
import { assertCapability } from './authz.ts';
import { recordAudit } from './audit.ts';
import { getPool, transaction } from './client.ts';
import { cargarVersion } from './brief-version.ts';

export interface VersionHija {
  readonly versionId: string;
  readonly version: number;
  readonly parentVersionId: string;
}

/**
 * Crea una versión hija de una versión `approved`. La anterior queda
 * `superseded` en la misma transacción — nunca hay una ventana donde ambas
 * parezcan la versión de trabajo vigente.
 *
 * Qué se copia como punto de partida: campos (valor, anclaje de producto,
 * procedencia, criticidad, estado de precisión de fechas — todo vive en
 * `value`/`provenance_type`, se copia tal cual) y su evidencia documental.
 * Qué NO se copia, a propósito: el estado de revisión de cada campo
 * (`review_status` vuelve a `pending` — es un punto de partida para editar,
 * no una aprobación heredada), las preguntas locales de la versión anterior,
 * y los comentarios internos (quedan asociados a la versión histórica, ya
 * `superseded`, nunca como conversación activa de la hija).
 */
export async function crearVersionHija(actor: User, parentVersionId: string): Promise<Result<VersionHija>> {
  const permitido = assertCapability(actor, 'brief:edit');
  if (!permitido.ok) return err({ code: permitido.error.code, message: permitido.error.message });

  const datos = await cargarVersion(getPool(), parentVersionId);
  if (!datos || datos.organizationId !== actor.organizationId) {
    return err({ code: 'RESOURCE_NOT_FOUND', message: 'El recurso no existe o no está disponible.' });
  }
  if (datos.version.language !== 'es') {
    return err({
      code: 'BRIEF_INVALID_TRANSITION',
      message:
        'Esta es una versión en inglés anterior a V2: es una representación de la versión lógica. Cree la versión nueva desde la versión lógica.',
    });
  }
  if (datos.version.status !== 'approved') {
    return err({
      code: 'BRIEF_VERSION_IMMUTABLE',
      message: `Solo se puede crear una versión nueva a partir de una versión aprobada; esta está en estado ${datos.version.status}.`,
    });
  }

  return transaction(async (client) => {
    // Candado atómico: si dos peticiones llegan a la vez, solo una desactiva
    // `approved`. La segunda encuentra 0 filas — ya no está `approved` — y
    // se rechaza en vez de crear una segunda hija.
    const superseded = await client.query<{ id: string }>(
      `UPDATE brief_versions SET status = 'superseded'
        WHERE id = $1 AND status = 'approved'
        RETURNING id`,
      [parentVersionId],
    );
    if (superseded.rowCount === 0) {
      return err({
        code: 'BRIEF_VERSION_IMMUTABLE',
        message: 'Esta versión ya no está aprobada — probablemente otra solicitud ya creó una versión nueva.',
      });
    }

    const siguiente = await client.query<{ proxima: number }>(
      `SELECT COALESCE(MAX(version), 0) + 1 AS proxima
         FROM brief_versions WHERE brief_id = $1 AND language = $2`,
      [datos.version.briefId, datos.version.language],
    );
    const nuevaVersion = siguiente.rows[0]!.proxima;

    const insertada = await client.query<{ id: string }>(
      `INSERT INTO brief_versions
              (brief_id, organization_id, version, language, parent_version_id, status, created_by)
       VALUES ($1, $2, $3, $4, $5, 'draft', $6)
       RETURNING id`,
      [
        datos.version.briefId,
        datos.organizationId,
        nuevaVersion,
        datos.version.language,
        parentVersionId,
        actor.id,
      ],
    );
    const nuevaVersionId = insertada.rows[0]!.id;

    const camposOrigen = await client.query<{
      id: string;
      key: string;
      campaign_product_id: string | null;
      value: unknown;
      status: string;
      confidence: string | null;
      provenance_type: string;
      criticidad: string;
    }>(
      `SELECT id, key, campaign_product_id, value, status, confidence, provenance_type, criticidad
         FROM brief_fields WHERE brief_version_id = $1`,
      [parentVersionId],
    );

    const mapaIdCampo = new Map<string, string>();
    for (const campo of camposOrigen.rows) {
      const nuevoCampo = await client.query<{ id: string }>(
        `INSERT INTO brief_fields
                (brief_version_id, key, campaign_product_id, value, status, confidence,
                 provenance_type, criticidad, review_status)
         VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8, 'pending')
         RETURNING id`,
        [
          nuevaVersionId,
          campo.key,
          campo.campaign_product_id,
          campo.value === null ? null : JSON.stringify(campo.value),
          campo.status,
          campo.confidence,
          campo.provenance_type,
          campo.criticidad,
        ],
      );
      mapaIdCampo.set(campo.id, nuevoCampo.rows[0]!.id);
    }

    if (mapaIdCampo.size > 0) {
      const evidenciaOrigen = await client.query<{
        brief_field_id: string;
        source_id: string;
        fragment_id: string | null;
        page: number | null;
        slide: number | null;
        section: string | null;
        linea: number | null;
        locator: unknown;
        quote: string;
        relation: string;
      }>(
        `SELECT brief_field_id, source_id, fragment_id, page, slide, section, linea, locator, quote, relation
           FROM evidence WHERE brief_field_id = ANY($1::uuid[])`,
        [[...mapaIdCampo.keys()]],
      );
      for (const e of evidenciaOrigen.rows) {
        const nuevoFieldId = mapaIdCampo.get(e.brief_field_id);
        if (!nuevoFieldId) continue;
        await client.query(
          `INSERT INTO evidence
                  (brief_field_id, source_id, fragment_id, page, slide, section, linea, locator, quote, relation)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10::evidence_relation)`,
          [
            nuevoFieldId,
            e.source_id,
            e.fragment_id,
            e.page,
            e.slide,
            e.section,
            e.linea,
            e.locator === null ? null : JSON.stringify(e.locator),
            e.quote,
            e.relation,
          ],
        );
      }
    }

    // V2 · Fase 2 — representaciones. La hija es una versión lógica nueva con SUS
    // representaciones (la original nace por trigger); cada una conserva el
    // linaje hacia la equivalente de la versión padre, y las traducciones se
    // copian con su huella tal cual: si el padre estaba al día la hija también,
    // y si estaba desactualizada o sin verificar, sigue estándolo (no se
    // «blanquea» una traducción al copiarla).
    const representacionesPadre = await client.query<{ id: string; language: string; kind: string }>(
      `SELECT id, language, kind FROM brief_version_representations
        WHERE brief_version_id = $1 ORDER BY (kind = 'original') DESC, language`,
      [parentVersionId],
    );
    const hijaOriginal = await client.query<{ id: string }>(
      `SELECT id FROM brief_version_representations WHERE brief_version_id = $1 AND kind = 'original'`,
      [nuevaVersionId],
    );
    const mapaRepresentaciones = new Map<string, string>();
    for (const rp of representacionesPadre.rows) {
      if (rp.kind === 'original') {
        await client.query(
          `UPDATE brief_version_representations SET copied_from_representation_id = $1 WHERE id = $2`,
          [rp.id, hijaOriginal.rows[0]!.id],
        );
        mapaRepresentaciones.set(rp.id, hijaOriginal.rows[0]!.id);
      } else {
        const copia = await client.query<{ id: string }>(
          `INSERT INTO brief_version_representations
                  (brief_version_id, language, kind, source_representation_id,
                   copied_from_representation_id, created_by)
           VALUES ($1, $2, 'translation', $3, $4, $5) RETURNING id`,
          [nuevaVersionId, rp.language, hijaOriginal.rows[0]!.id, rp.id, actor.id],
        );
        mapaRepresentaciones.set(rp.id, copia.rows[0]!.id);
      }
    }
    let traduccionesCopiadas = 0;
    if (mapaRepresentaciones.size > 0) {
      const traduccionesPadre = await client.query<{
        brief_field_id: string;
        representation_id: string;
        value: unknown;
        provenance_type: string;
        translator: string;
        source_value_hash: string | null;
        translated_by: string | null;
      }>(
        `SELECT brief_field_id, representation_id, value, provenance_type::text AS provenance_type,
                translator, source_value_hash, translated_by
           FROM brief_field_translations WHERE representation_id = ANY($1::uuid[])`,
        [[...mapaRepresentaciones.keys()]],
      );
      for (const t of traduccionesPadre.rows) {
        const campoHijo = mapaIdCampo.get(t.brief_field_id);
        const repHija = mapaRepresentaciones.get(t.representation_id);
        if (campoHijo === undefined || repHija === undefined) continue;
        await client.query(
          `INSERT INTO brief_field_translations
                  (brief_field_id, representation_id, value, provenance_type, translator,
                   source_value_hash, translated_by)
           VALUES ($1, $2, $3::jsonb, $4::provenance_type, $5, $6, $7)`,
          [
            campoHijo,
            repHija,
            JSON.stringify(t.value),
            t.provenance_type,
            t.translator,
            t.source_value_hash,
            t.translated_by,
          ],
        );
        traduccionesCopiadas += 1;
      }
    }

    await recordAudit(client, {
      actor,
      action: 'brief.create_child_version',
      entityType: 'brief_version',
      entityId: nuevaVersionId,
      metadata: {
        parentVersionId,
        version: nuevaVersion,
        camposCopiados: mapaIdCampo.size,
        representacionesCopiadas: mapaRepresentaciones.size,
        traduccionesCopiadas,
      },
    });
    await recordAudit(client, {
      actor,
      action: 'brief.superseded',
      entityType: 'brief_version',
      entityId: parentVersionId,
      metadata: { childVersionId: nuevaVersionId },
    });

    return ok({ versionId: nuevaVersionId, version: nuevaVersion, parentVersionId });
  });
}
