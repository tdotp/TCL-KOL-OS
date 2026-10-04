/**
 * Extracción de campos del brief: del worker a la base (E5-3, E5-4, E5-5, E5-6).
 *
 * El reparto de trabajo sigue ADR-008 y el diagrama de contenedores de D0-09:
 *
 *   esta capa   lee los fragmentos y productos que el usuario **puede** ver,
 *               llama al worker, valida lo que vuelve y lo persiste
 *   el worker   habla con el proveedor de IA y verifica que cada cita exista
 *               de verdad en su fragmento
 *
 * Los fragmentos viajan en la petición en vez de que el worker los busque por
 * `campaignId`. Es más tráfico y vale la pena: así el worker nunca decide si
 * alguien puede ver una campaña —no tiene con qué— y el aislamiento entre
 * organizaciones se resuelve en un solo sitio.
 *
 * Sprint 4, cierre (corrección 1): la extracción ya no crea una versión y la
 * deja en `draft` sin más. Recorre el ciclo real —
 * `draft → processing → extraction_review`, o `processing → processing_failed`
 * si el worker falla— a través de `transicionarBrief`, nunca con un `UPDATE`
 * directo. Los productos que se envían al worker son los `campaign_products`
 * de la campaña (DEC-016/DEC-023, corrección 3.2): el `id` que se les manda
 * es el de esa fila, así lo que el worker devuelve en `productoId` es
 * exactamente el `campaign_product_id` que hay que persistir, sin un mapeo
 * intermedio.
 */

import {
  type Result,
  type User,
  type Visibility,
  canAccessResource,
  err,
  isTclVisible,
  ok,
  roleCan,
} from '@tcl-kol-os/domain';
import { assertCapability } from './authz.ts';
import { query, transaction } from './client.ts';
import { obtenerOCrearVersionDeTrabajo } from './brief-version.ts';
import { transicionarBrief } from './transitions.ts';

export interface EvidenciaExtraida {
  readonly fragmentId: string;
  readonly sourceId: string;
  readonly quote: string;
  readonly relation: 'soporta' | 'contradice' | 'contexto';
}

export interface CampoExtraido {
  readonly key: string;
  readonly value: unknown;
  readonly status: 'found' | 'not_found' | 'conflict';
  readonly criticidad: 'informativo' | 'critico' | 'claim';
  readonly confidence: number | null;
  readonly nota: string | null;
  readonly evidence: readonly EvidenciaExtraida[];
  /** `campaign_products.id`, o `null` para un campo de campaña o compartido. */
  readonly productoId: string | null;
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

export interface ProductoDeCampana {
  readonly campaignProductId: string;
  readonly nombreProducto: string;
}

/** URL interna del worker. No se expone al navegador. */
function urlDelWorker(): string {
  return (process.env['AI_WORKER_URL'] ?? 'http://localhost:8000').replace(/\/+$/, '');
}

/** Los productos válidos de la campaña, en la forma que espera el worker. */
export async function productosDeCampana(campaignId: string): Promise<ProductoDeCampana[]> {
  const filas = await query<{ campaign_product_id: string; brand: string; model: string }>(
    `SELECT cp.id AS campaign_product_id, p.brand, p.model
       FROM campaign_products cp
       JOIN products p ON p.id = cp.product_id
      WHERE cp.campaign_id = $1
      ORDER BY cp.prioridad`,
    [campaignId],
  );
  return filas.map((f) => ({
    campaignProductId: f.campaign_product_id,
    nombreProducto: `${f.brand} ${f.model}`,
  }));
}

/**
 * Llama al worker con los fragmentos y productos autorizados.
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

  const productos = await productosDeCampana(campaignId);

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
      productos: productos.map((p) => ({ id: p.campaignProductId, nombre_producto: p.nombreProducto })),
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
    campos: Array<{
      key: string;
      value: unknown;
      status: 'found' | 'not_found' | 'conflict';
      criticidad: 'informativo' | 'critico' | 'claim';
      confidence: number | null;
      nota: string | null;
      productoId: string | null;
      evidence: EvidenciaExtraida[];
    }>;
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
    campos: cuerpo.campos.map((c) => ({ ...c, productoId: c.productoId ?? null })),
  };
}

/**
 * Persiste los campos extraídos dentro de una versión ya existente (creada
 * por `obtenerOCrearVersionDeTrabajo`) — nunca crea la versión ella misma.
 *
 * Rechaza toda la extracción, sin persistir nada, si algún `productoId`
 * devuelto por el worker no pertenece al catálogo de la campaña (pruebas 11,
 * 12): es exactamente la ventana que DEC-023 exige cerrar, redundante a
 * propósito con el trigger de la migración 005.
 */
export async function persistirExtraccion(opciones: {
  organizationId: string;
  campaignId: string;
  versionId: string;
  resultado: ResultadoExtraccion;
}): Promise<{ aiRunId: string; campos: number; evidencias: number }> {
  const { organizationId, campaignId, versionId, resultado } = opciones;
  const campos = resultado.campos;

  const productosValidos = new Set((await productosDeCampana(campaignId)).map((p) => p.campaignProductId));
  for (const campo of campos) {
    if (campo.productoId !== null && !productosValidos.has(campo.productoId)) {
      throw new Error(
        `El worker devolvió un producto (${campo.productoId}) que no pertenece a esta campaña.`,
      );
    }
  }

  return transaction(async (client) => {
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

      // Dos índices únicos parciales cubren `brief_fields` (migración 005):
      // uno para campos de campaña/compartidos, otro para campos de producto.
      // `ON CONFLICT` exige apuntar al índice exacto, así que el destino
      // depende de si este campo trae `campaign_product_id` o no — un
      // reintento tras `processing_failed` reescribe la fila en vez de
      // chocar contra una restricción de duplicado.
      const destinoConflicto =
        campo.productoId === null
          ? `(brief_version_id, key) WHERE campaign_product_id IS NULL`
          : `(brief_version_id, key, campaign_product_id) WHERE campaign_product_id IS NOT NULL`;

      const fila = await client.query<{ id: string }>(
        `INSERT INTO brief_fields
                (brief_version_id, key, campaign_product_id, value, status, confidence,
                 provenance_type, criticidad)
         VALUES ($1, $2, $3, $4::jsonb, $5::field_status, $6, 'extracted', $7::criticality)
         ON CONFLICT ${destinoConflicto}
           DO UPDATE SET value = EXCLUDED.value, status = EXCLUDED.status,
                         confidence = EXCLUDED.confidence, provenance_type = 'extracted',
                         review_status = 'pending'
         RETURNING id`,
        [
          versionId,
          campo.key,
          campo.productoId,
          valor === null ? null : JSON.stringify(valor),
          campo.status,
          campo.confidence,
          campo.criticidad,
        ],
      );

      // Un reintento reescribe la evidencia del campo en vez de acumularla:
      // la extracción anterior que falló a mitad de camino no debe dejar
      // citas huérfanas mezcladas con las de la corrida que sí terminó.
      await client.query(`DELETE FROM evidence WHERE brief_field_id = $1`, [fila.rows[0]!.id]);

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

    return { aiRunId: run.rows[0]!.id, campos: campos.length, evidencias };
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
    campaignProductId: string | null;
    value: unknown;
    status: string;
    criticidad: string;
    confidence: number | null;
    provenanceType: string;
    reviewStatus: string;
    revision: number;
    evidencias: Array<{
      quote: string;
      relation: string;
      filename: string;
      sourceId: string;
      page: number | null;
      slide: number | null;
      section: string | null;
      linea: number | null;
      /** Visibilidad de la fuente citada (V2 · Fase 1A). */
      sourceVisibility: Visibility;
    }>;
  }>
> {
  const filas = await query<{
    id: string;
    key: string;
    campaign_product_id: string | null;
    value: unknown;
    status: string;
    criticidad: string;
    confidence: string | null;
    provenance_type: string;
    review_status: string;
    revision: number;
    evidencias: unknown;
  }>(
    `SELECT bf.id, bf.key, bf.campaign_product_id, bf.value, bf.status::text, bf.criticidad::text,
            bf.confidence, bf.provenance_type::text, bf.review_status, bf.revision,
            COALESCE(
              json_agg(
                json_build_object(
                  'quote', e.quote, 'relation', e.relation::text,
                  'filename', s.filename, 'sourceId', s.id, 'sourceVisibility', s.visibility::text,
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
    campaignProductId: f.campaign_product_id,
    value: f.value,
    status: f.status,
    criticidad: f.criticidad,
    confidence: f.confidence === null ? null : Number(f.confidence),
    provenanceType: f.provenance_type,
    reviewStatus: f.review_status,
    revision: f.revision,
    evidencias: f.evidencias as Array<{
      quote: string;
      relation: string;
      filename: string;
      sourceId: string;
      page: number | null;
      slide: number | null;
      section: string | null;
      linea: number | null;
      sourceVisibility: Visibility;
    }>,
  }));
}

// ═══════════════════ Capa autorizada, la que usa la interfaz ══════════════════

/**
 * Recorre `extraerCampos` + `persistirExtraccion` sobre una versión ya en
 * `processing`. `processing → extraction_review` y `processing →
 * processing_failed` están reservadas al sistema en el dominio (nunca a un
 * humano) — por eso esta función siempre transiciona como `'system'`, sin
 * importar qué actor humano disparó la extracción.
 */
async function ejecutarYPersistir(
  organizationId: string,
  campaignId: string,
  versionId: string,
): Promise<Result<{ versionId: string; campos: number; evidencias: number; costoUsd: number }>> {
  try {
    const resultado = await extraerCampos(organizationId, campaignId);
    const guardado = await persistirExtraccion({ organizationId, campaignId, versionId, resultado });

    const transicion = await transicionarBrief('system', versionId, 'extraction_review');
    if (!transicion.ok) {
      return err({ code: transicion.error.code, message: transicion.error.message });
    }

    return ok({
      versionId,
      campos: guardado.campos,
      evidencias: guardado.evidencias,
      costoUsd: resultado.costoUsd,
    });
  } catch (error) {
    // El detalle técnico va al log, no a la pantalla (§11.6). Lo que llega al
    // consultor es qué pasó y qué puede hacer.
    console.error('[extraccion]', error);
    await transicionarBrief('system', versionId, 'processing_failed');
    return err({
      code: 'AI_EXTRACTION_FAILED',
      message:
        error instanceof Error && error.message.includes('fuentes procesadas')
          ? error.message
          : 'La extracción no pudo completarse. Vuelva a intentarlo o continúe en modo manual.',
    });
  }
}

/**
 * Extrae y persiste en un solo paso, recorriendo el ciclo real de estados:
 * `draft → processing`, luego `processing → extraction_review` si el worker
 * responde bien, o `processing → processing_failed` si no (Sprint 4, cierre,
 * corrección 1). Ninguna de estas transiciones usa `UPDATE` directo — todas
 * pasan por `transicionarBrief`, auditadas ahí.
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

  const version = await transaction((client) =>
    obtenerOCrearVersionDeTrabajo(client, {
      campaignId,
      organizationId: actor.organizationId,
      createdBy: actor.id,
    }),
  );

  const aProcesamiento = await transicionarBrief(actor, version.versionId, 'processing');
  if (!aProcesamiento.ok) {
    return err({ code: aProcesamiento.error.code, message: aProcesamiento.error.message });
  }

  return ejecutarYPersistir(actor.organizationId, campaignId, version.versionId);
}

/**
 * Reintenta una extracción que quedó en `processing_failed` — reusa la
 * transición ya definida en el dominio (`processing_failed → processing`),
 * nunca un camino nuevo.
 */
export async function reintentarExtraccion(
  actor: User,
  campaignId: string,
  versionId: string,
): Promise<Result<{ versionId: string; campos: number; evidencias: number; costoUsd: number }>> {
  const permitido = assertCapability(actor, 'brief:edit');
  if (!permitido.ok) return err({ code: permitido.error.code, message: permitido.error.message });

  const aProcesamiento = await transicionarBrief(actor, versionId, 'processing');
  if (!aProcesamiento.ok) {
    return err({ code: aProcesamiento.error.code, message: aProcesamiento.error.message });
  }

  return ejecutarYPersistir(actor.organizationId, campaignId, versionId);
}

export interface VersionDelBrief {
  readonly id: string;
  readonly version: number;
  readonly status: string;
  readonly language: string;
  readonly createdAt: Date;
  readonly modelo: string | null;
  readonly costoUsd: number | null;
}

/** Versiones del brief de una campaña, con el costo de haberlas producido. */
export async function versionesDelBrief(actor: User, campaignId: string): Promise<Result<VersionDelBrief[]>> {
  const permitido = assertCapability(actor, 'brief:read');
  if (!permitido.ok) return err({ code: permitido.error.code, message: permitido.error.message });

  // Igual que `getCampaign` (`campaigns.ts`): un `cliente` es de OTRA
  // organización por definición (DEC-012), así que la autorización correcta
  // es sobre la VISIBILIDAD de la campaña, no un `organization_id ===
  // organization_id` que lo bloquearía siempre.
  const alcance = await query<{
    organization_id: string;
    confidentiality_level: string;
    visibility: string;
  }>(`SELECT organization_id, confidentiality_level, visibility FROM campaigns WHERE id = $1`, [campaignId]);
  const filaAlcance = alcance[0];
  if (
    !filaAlcance ||
    !canAccessResource(actor, {
      organizationId: filaAlcance.organization_id,
      confidentialityLevel: filaAlcance.confidentiality_level as
        'publica' | 'interna' | 'confidencial' | 'sensible',
      visibility: filaAlcance.visibility as 'interna' | 'tcl' | 'compartida',
      createdBy: '',
    })
  ) {
    return err({ code: 'RESOURCE_NOT_FOUND', message: 'El recurso no existe o no está disponible.' });
  }

  const filas = await query<{
    id: string;
    version: number;
    status: string;
    language: string;
    created_at: Date;
    modelo: string | null;
    costo: string | null;
  }>(
    `SELECT v.id, v.version, v.status::text, v.language::text, v.created_at,
            r.model AS modelo, r.cost_usd::text AS costo
       FROM brief_versions v
       JOIN briefs b ON b.id = v.brief_id
       LEFT JOIN ai_runs r ON r.brief_version_id = v.id AND r.task = 'extraer_campos'
      WHERE b.campaign_id = $1
        -- V2: solo versiones LÓGICAS. Las filas EN históricas son representaciones
        -- (o inconsistencias marcadas en brief_legacy_language_links), no versiones.
        AND v.language = 'es'
      ORDER BY v.version DESC`,
    [campaignId],
  );

  return ok(
    filas.map((f) => ({
      id: f.id,
      version: f.version,
      language: f.language,
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

  const alcance = await query<{
    organization_id: string;
    confidentiality_level: string;
    visibility: string;
  }>(
    `SELECT c.organization_id, c.confidentiality_level, c.visibility
       FROM brief_versions v
       JOIN briefs b ON b.id = v.brief_id
       JOIN campaigns c ON c.id = b.campaign_id
      WHERE v.id = $1`,
    [versionId],
  );
  const filaAlcance = alcance[0];
  if (
    !filaAlcance ||
    !canAccessResource(actor, {
      organizationId: filaAlcance.organization_id,
      confidentialityLevel: filaAlcance.confidentiality_level as
        'publica' | 'interna' | 'confidencial' | 'sensible',
      visibility: filaAlcance.visibility as 'interna' | 'tcl' | 'compartida',
      createdBy: '',
    })
  ) {
    return err({ code: 'RESOURCE_NOT_FOUND', message: 'El recurso no existe o no está disponible.' });
  }

  const campos = await camposDeVersion(versionId);

  // V2 · Fase 1A: quien no puede leer las fuentes internas (el cliente) no
  // recibe la evidencia que las cita — ni su cita textual ni el nombre del
  // archivo — salvo que la fuente esté marcada como visible para TCL. La
  // campaña visible no expone sus fuentes.
  if (!roleCan(actor.role, 'source:read')) {
    return ok(
      campos.map((c) => ({
        ...c,
        evidencias: c.evidencias.filter((e) => isTclVisible(e.sourceVisibility)),
      })),
    );
  }
  return ok(campos);
}
