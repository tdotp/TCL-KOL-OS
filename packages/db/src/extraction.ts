/**
 * Extracción de campos del brief: del worker a la base (E5-3, E5-4, E5-5, E5-6).
 *
 * El reparto de trabajo sigue ADR-008 y el diagrama de contenedores de D0-09:
 *
 *   esta capa   lee los fragmentos que el usuario **puede** ver, llama al
 *               worker, valida lo que vuelve y lo persiste
 *   el worker   habla con el proveedor de IA y verifica que cada cita exista
 *               de verdad en su fragmento
 *
 * Los fragmentos viajan en la petición en vez de que el worker los busque por
 * `campaignId`. Es más tráfico y vale la pena: así el worker nunca decide si
 * alguien puede ver una campaña —no tiene con qué— y el aislamiento entre
 * organizaciones se resuelve en un solo sitio.
 *
 * Nada de lo que llega se persiste sin pasar por las mismas reglas que rigen a
 * un campo escrito a mano. La IA no tiene una puerta propia.
 */

import { type Result, type User, err, ok } from '@tcl-kol-os/domain';
import { assertCapability } from './authz.ts';
import { query, transaction } from './client.ts';

export interface EvidenciaExtraida {
  readonly fragmentId: string;
  readonly sourceId: string;
  readonly quote: string;
  readonly relation: 'soporta' | 'contradice' | 'contexto';
}

export interface CampoExtraido {
  readonly key: string;
  readonly value: string | null;
  readonly status: 'found' | 'not_found' | 'conflict';
  readonly criticidad: 'informativo' | 'critico' | 'claim';
  readonly confidence: number | null;
  readonly nota: string | null;
  readonly evidence: readonly EvidenciaExtraida[];
}

export interface ResultadoExtraccion {
  readonly modelo: string;
  readonly nivel: string;
  readonly promptVersion: string;
  /** Huella del insumo (§11.6): permite comparar ejecuciones sin guardar el texto. */
  readonly inputHash: string;
  readonly costoUsd: number;
  readonly latenciaMs: number;
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly generationId: string | null;
  readonly descartes: readonly string[];
  readonly campos: readonly CampoExtraido[];
}

/** URL interna del worker. No se expone al navegador. */
function urlDelWorker(): string {
  return (process.env['AI_WORKER_URL'] ?? 'http://localhost:8000').replace(/\/+$/, '');
}

/**
 * Extrae los campos del brief para una campaña.
 *
 * `organizationId` no es decorativo: acota la lectura de fragmentos, de modo
 * que una campaña de otra agencia no puede alimentar esta extracción ni aunque
 * llegue su id por error.
 */
export async function extraerCampos(
  organizationId: string,
  campaignId: string,
): Promise<ResultadoExtraccion> {
  if (!organizationId || !campaignId) {
    throw new Error('La extracción exige organización y campaña.');
  }

  const fragmentos = await query<{
    id: string;
    source_id: string;
    filename: string;
    texto: string;
    page: number | null;
    slide: number | null;
    section: string | null;
    linea: number | null;
  }>(
    `SELECT f.id, f.source_id, s.filename, f.text AS texto,
            f.page, f.slide, f.section, f.linea
       FROM source_fragments f
       JOIN source_documents s ON s.id = f.source_id
      WHERE s.organization_id = $1
        AND s.campaign_id     = $2
        AND s.status          = 'procesado'
        AND s.confidentiality_level <> 'sensible'
      ORDER BY s.filename, f.ordinal`,
    [organizationId, campaignId],
  );

  if (fragmentos.length === 0) {
    throw new Error(
      'La campaña no tiene fuentes procesadas de las que extraer. Cargue al menos un documento.',
    );
  }

  const respuesta = await fetch(`${urlDelWorker()}/extraccion`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      fragmentos: fragmentos.map((f) => ({
        id: f.id,
        source_id: f.source_id,
        filename: f.filename,
        texto: f.texto,
        page: f.page,
        slide: f.slide,
        section: f.section,
        linea: f.linea,
      })),
    }),
  });

  if (!respuesta.ok) {
    const detalle = await respuesta.text().catch(() => '');
    throw new Error(`La extracción falló (${respuesta.status}): ${detalle.slice(0, 300)}`);
  }

  const cuerpo = (await respuesta.json()) as {
    modelo: string;
    nivel: string;
    prompt_version: string;
    input_hash: string;
    costo_usd: number;
    latencia_ms: number;
    prompt_tokens: number;
    completion_tokens: number;
    generation_id: string | null;
    descartes: string[];
    campos: CampoExtraido[];
  };

  return {
    modelo: cuerpo.modelo,
    nivel: cuerpo.nivel,
    promptVersion: cuerpo.prompt_version,
    inputHash: cuerpo.input_hash,
    costoUsd: cuerpo.costo_usd,
    latenciaMs: cuerpo.latencia_ms,
    promptTokens: cuerpo.prompt_tokens,
    completionTokens: cuerpo.completion_tokens,
    generationId: cuerpo.generation_id,
    descartes: cuerpo.descartes,
    campos: cuerpo.campos,
  };
}

/**
 * Guarda los campos extraídos como una nueva versión del brief, en `draft`.
 *
 * Siempre `draft`, nunca más allá: la IA no aprueba (ADR-002) y no salta la
 * revisión. Lo que se persiste aquí es material para que un consultor confirme,
 * no un brief terminado.
 *
 * Los `not_found` también se guardan. Un campo ausente que no aparece en la
 * base es indistinguible de un campo que nadie intentó llenar, y esa diferencia
 * es justamente la que genera preguntas (E6-1).
 */
export async function persistirExtraccion(opciones: {
  organizationId: string;
  campaignId: string;
  createdBy: string;
  /** Resultado completo del worker: aporta los campos y el costo de producirlos. */
  resultado: ResultadoExtraccion;
}): Promise<{
  briefId: string;
  versionId: string;
  aiRunId: string;
  campos: number;
  evidencias: number;
}> {
  const { organizationId, campaignId, createdBy, resultado } = opciones;
  const campos = resultado.campos;

  return transaction(async (client) => {
    const brief = await client.query<{ id: string }>(
      `INSERT INTO briefs (campaign_id) VALUES ($1)
       ON CONFLICT (campaign_id) DO UPDATE SET campaign_id = EXCLUDED.campaign_id
       RETURNING id`,
      [campaignId],
    );
    const briefId = brief.rows[0]!.id;

    const siguiente = await client.query<{ proxima: number }>(
      `SELECT COALESCE(MAX(version), 0) + 1 AS proxima
         FROM brief_versions WHERE brief_id = $1 AND language = 'es'`,
      [briefId],
    );

    const version = await client.query<{ id: string }>(
      `INSERT INTO brief_versions (brief_id, organization_id, version, created_by)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [briefId, organizationId, siguiente.rows[0]!.proxima, createdBy],
    );
    const versionId = version.rows[0]!.id;

    // El AIRun va en la misma transacción que los campos que produjo (E11-7).
    // Si la persistencia falla, tampoco queda registrado un costo por algo que
    // nadie llegó a guardar; y si queda el costo, están los campos.
    const run = await client.query<{ id: string }>(
      `INSERT INTO ai_runs
              (organization_id, campaign_id, brief_version_id, task, tier, provider,
               model, prompt_version, input_hash, output_status, latency_ms,
               prompt_tokens, completion_tokens, cost_usd, generation_id)
       VALUES ($1, $2, $3, 'extraer_campos', $4, 'openrouter', $5, $6, $7, $8, $9,
               $10, $11, $12, $13)
       RETURNING id`,
      [
        organizationId,
        campaignId,
        versionId,
        resultado.nivel,
        resultado.modelo,
        resultado.promptVersion,
        resultado.inputHash,
        resultado.descartes.length === 0 ? 'ok' : 'ok_con_descartes',
        resultado.latenciaMs,
        resultado.promptTokens,
        resultado.completionTokens,
        resultado.costoUsd,
        resultado.generationId,
      ],
    );

    let evidencias = 0;

    for (const campo of campos) {
      // La base ya rechaza un `not_found` con valor; se normaliza aquí también
      // para que el error salga como una regla de negocio y no como un choque
      // de restricción a mitad de una transacción larga.
      const valor = campo.status === 'not_found' || campo.status === 'conflict' ? null : campo.value;

      const fila = await client.query<{ id: string }>(
        `INSERT INTO brief_fields
                (brief_version_id, key, value, status, confidence, provenance_type, criticidad)
         VALUES ($1, $2, $3::jsonb, $4::field_status, $5, 'extracted', $6::criticality)
         RETURNING id`,
        [
          versionId,
          campo.key,
          valor === null ? null : JSON.stringify(valor),
          campo.status,
          campo.confidence,
          campo.criticidad,
        ],
      );

      for (const ev of campo.evidence) {
        await client.query(
          `INSERT INTO evidence (brief_field_id, source_id, fragment_id, quote, relation,
                                 page, slide, section, linea)
           SELECT $1, $2, $3, $4, $5::evidence_relation, f.page, f.slide, f.section, f.linea
             FROM source_fragments f WHERE f.id = $3`,
          [fila.rows[0]!.id, ev.sourceId, ev.fragmentId, ev.quote, ev.relation],
        );
        evidencias += 1;
      }
    }

    return {
      briefId,
      versionId,
      aiRunId: run.rows[0]!.id,
      campos: campos.length,
      evidencias,
    };
  });
}

/**
 * Los campos de una versión con su evidencia, listos para UI-08 y UI-11.
 *
 * La evidencia trae el localizador copiado del fragmento para que un clic
 * pueda abrir la diapositiva o la sección exacta sin una segunda consulta.
 */
export async function camposDeVersion(versionId: string): Promise<
  Array<{
    id: string;
    key: string;
    value: unknown;
    status: string;
    criticidad: string;
    confidence: number | null;
    evidencias: Array<{
      quote: string;
      relation: string;
      filename: string;
      sourceId: string;
      page: number | null;
      slide: number | null;
      section: string | null;
      linea: number | null;
    }>;
  }>
> {
  const filas = await query<{
    id: string;
    key: string;
    value: unknown;
    status: string;
    criticidad: string;
    confidence: string | null;
    evidencias: unknown;
  }>(
    `SELECT bf.id, bf.key, bf.value, bf.status::text, bf.criticidad::text, bf.confidence,
            COALESCE(
              json_agg(
                json_build_object(
                  'quote', e.quote, 'relation', e.relation::text,
                  'filename', s.filename, 'sourceId', s.id,
                  'page', e.page, 'slide', e.slide, 'section', e.section, 'linea', e.linea
                ) ORDER BY e.created_at
              ) FILTER (WHERE e.id IS NOT NULL),
              '[]'::json
            ) AS evidencias
       FROM brief_fields bf
       LEFT JOIN evidence e ON e.brief_field_id = bf.id
       LEFT JOIN source_documents s ON s.id = e.source_id
      WHERE bf.brief_version_id = $1
      GROUP BY bf.id
      ORDER BY bf.key`,
    [versionId],
  );

  return filas.map((f) => ({
    id: f.id,
    key: f.key,
    value: f.value,
    status: f.status,
    criticidad: f.criticidad,
    confidence: f.confidence === null ? null : Number(f.confidence),
    evidencias: f.evidencias as Array<{
      quote: string;
      relation: string;
      filename: string;
      sourceId: string;
      page: number | null;
      slide: number | null;
      section: string | null;
      linea: number | null;
    }>,
  }));
}

// ═══════════════════ Capa autorizada, la que usa la interfaz ══════════════════

/**
 * Extrae y persiste en un solo paso, comprobando permisos primero.
 *
 * Es lo que llama la pantalla. Las funciones de arriba son las piezas, y se
 * dejan expuestas porque las pruebas necesitan separar el "qué devolvió el
 * modelo" del "qué se guardó".
 */
export async function extraerBrief(
  actor: User,
  campaignId: string,
): Promise<Result<{ versionId: string; campos: number; evidencias: number; costoUsd: number }>> {
  const permitido = assertCapability(actor, 'brief:edit');
  if (!permitido.ok) return err({ code: permitido.error.code, message: permitido.error.message });

  const propias = await query<{ id: string }>(
    `SELECT id FROM campaigns WHERE id = $1 AND organization_id = $2`,
    [campaignId, actor.organizationId],
  );
  if (propias.length === 0) {
    return err({ code: 'RESOURCE_NOT_FOUND', message: 'El recurso no existe o no está disponible.' });
  }

  try {
    const resultado = await extraerCampos(actor.organizationId, campaignId);
    const guardado = await persistirExtraccion({
      organizationId: actor.organizationId,
      campaignId,
      createdBy: actor.id,
      resultado,
    });
    return ok({
      versionId: guardado.versionId,
      campos: guardado.campos,
      evidencias: guardado.evidencias,
      costoUsd: resultado.costoUsd,
    });
  } catch (error) {
    // El detalle técnico va al log, no a la pantalla (§11.6). Lo que llega al
    // consultor es qué pasó y qué puede hacer.
    console.error('[extraccion]', error);
    return err({
      code: 'AI_EXTRACTION_FAILED',
      message:
        error instanceof Error && error.message.includes('fuentes procesadas')
          ? error.message
          : 'La extracción no pudo completarse. Vuelva a intentarlo o continúe en modo manual.',
    });
  }
}

export interface VersionDelBrief {
  readonly id: string;
  readonly version: number;
  readonly status: string;
  readonly createdAt: Date;
  readonly modelo: string | null;
  readonly costoUsd: number | null;
}

/** Versiones del brief de una campaña, con el costo de haberlas producido. */
export async function versionesDelBrief(
  actor: User,
  campaignId: string,
): Promise<Result<VersionDelBrief[]>> {
  const permitido = assertCapability(actor, 'brief:read');
  if (!permitido.ok) return err({ code: permitido.error.code, message: permitido.error.message });

  const filas = await query<{
    id: string;
    version: number;
    status: string;
    created_at: Date;
    modelo: string | null;
    costo: string | null;
  }>(
    `SELECT v.id, v.version, v.status::text, v.created_at,
            r.model AS modelo, r.cost_usd::text AS costo
       FROM brief_versions v
       JOIN briefs b ON b.id = v.brief_id
       LEFT JOIN ai_runs r ON r.brief_version_id = v.id AND r.task = 'extraer_campos'
      WHERE b.campaign_id = $1 AND v.organization_id = $2
      ORDER BY v.version DESC`,
    [campaignId, actor.organizationId],
  );

  return ok(
    filas.map((f) => ({
      id: f.id,
      version: f.version,
      status: f.status,
      createdAt: f.created_at,
      modelo: f.modelo,
      costoUsd: f.costo === null ? null : Number(f.costo),
    })),
  );
}

/** Campos de una versión, ya comprobado que la versión es de la organización. */
export async function verCamposDeVersion(
  actor: User,
  versionId: string,
): Promise<Result<Awaited<ReturnType<typeof camposDeVersion>>>> {
  const permitido = assertCapability(actor, 'brief:read');
  if (!permitido.ok) return err({ code: permitido.error.code, message: permitido.error.message });

  const propias = await query<{ id: string }>(
    `SELECT id FROM brief_versions WHERE id = $1 AND organization_id = $2`,
    [versionId, actor.organizationId],
  );
  if (propias.length === 0) {
    return err({ code: 'RESOURCE_NOT_FOUND', message: 'El recurso no existe o no está disponible.' });
  }

  return ok(await camposDeVersion(versionId));
}
