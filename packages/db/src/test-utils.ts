/**
 * Utilidades exclusivas de la suite de pruebas (INC-001A).
 *
 * `eliminarCampanaDePrueba` es la única función de este paquete que activa
 * `tclkolos.permitir_borrado_historico` (migración 009) — nunca ninguna
 * ruta de la aplicación real lo hace. Existe porque la limpieza de una
 * campaña de prueba (`afterAll`) legítimamente necesita borrar en cascada
 * el contenido de versiones `approved`/`superseded`, que las migraciones
 * 009 y 010 protegen a propósito contra `UPDATE`/`INSERT`/`DELETE`
 * directos — la bandera, activada solo dentro de esta transacción vía
 * `SET LOCAL`, es la salida explícita y acotada para ese caso, nunca un
 * debilitamiento general de la protección.
 *
 * Que solo esta función la active es una convención de la aplicación, no
 * la restricción real: la migración 010 (Sprint 5 correctivo, hallazgo 1)
 * hace que `inmutabilidad_bypass_activo()` exija además que el nombre de
 * la base actual termine en `_test` — la misma convención que INC-001A ya
 * exige en `vitest.setup.ts`. En cualquier base que no termine en `_test`
 * (desarrollo, staging, producción), esta bandera no tiene ningún efecto,
 * la active quien la active.
 */

import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Result, type Role, type User, campoDelCatalogo } from '@tcl-kol-os/domain';
import { type AcuerdoVista, crearAcuerdo } from './agreements.ts';
import { asociarInfluencerACampana, asociarProductoAInfluencer } from './campaign-influencers.ts';
import { query, transaction } from './client.ts';
import { crearEntregable } from './deliverables.ts';
import { crearInfluencer } from './influencers.ts';
import { crearVersionHija } from './versioning.ts';

export async function eliminarCampanaDePrueba(idOids: string | readonly string[]): Promise<void> {
  const ids = Array.isArray(idOids) ? idOids : [idOids];
  if (ids.length === 0) return;

  await transaction(async (client) => {
    await client.query(`SET LOCAL tclkolos.permitir_borrado_historico = 'on'`);
    // Orden explícito, no confiado a que Postgres resuelva solo dos árboles
    // de cascada independientes en el orden correcto: `evidence.source_id`
    // es `ON DELETE RESTRICT` (migración 004, sin tocar), y
    // `source_documents` cuelga de `campaigns` por su propio lado (no por
    // `briefs`). Si `campaigns → source_documents` se procesa antes que
    // `campaigns → briefs → brief_versions → brief_fields → evidence`,
    // el `RESTRICT` revienta con `evidence_source_id_fkey` — visto en vivo
    // al escribir las pruebas de esta migración. Borrar `briefs` primero
    // dispara esa segunda cascada de punta a punta (hasta `evidence`
    // incluida) antes de tocar `campaigns`, así que para cuando
    // `source_documents` se borra, ya no hay ninguna `evidence` que lo
    // referencie.
    for (const id of ids) {
      // V2 · Fase 8: la operación cuelga (RESTRICT) de la participación y de la campaña, y sus eventos y
      // sujetos se referencian entre sí con FK DIFERIDAS (se resuelven al cerrar la transacción). Primero:
      // evidencia → eventos → ítems/envíos → documentos de cobro → obligaciones → compromisos/versiones/
      // acuerdos → fuentes `soporte_operativo` (referenciadas por la evidencia y los documentos de cobro).
      // Solo posible con el bypass de bases `_test`; ninguna ruta real borra estas tablas.
      // V2 · Fase 8 (KPIs): mediciones y objetivos cuelgan (RESTRICT) de la participación y del entregable. Cada
      // tabla se vacía en UNA sentencia (las FK `supersedes_id` son NO ACTION: se evalúan al final de la sentencia).
      await client.query(`DELETE FROM kpi_measurements WHERE campaign_id = $1`, [id]);
      await client.query(`DELETE FROM kpi_targets WHERE campaign_id = $1`, [id]);
      await client.query(`DELETE FROM operational_evidence WHERE campaign_id = $1`, [id]);
      await client.query(`DELETE FROM operational_events WHERE campaign_id = $1`, [id]);
      await client.query(`DELETE FROM shipment_items WHERE campaign_id = $1`, [id]);
      await client.query(`DELETE FROM shipments WHERE campaign_id = $1`, [id]);
      await client.query(`DELETE FROM billing_documents WHERE campaign_id = $1`, [id]);
      await client.query(`DELETE FROM payment_obligations WHERE campaign_id = $1`, [id]);
      await client.query(`DELETE FROM agreement_product_commitments WHERE campaign_id = $1`, [id]);
      await client.query(`DELETE FROM agreement_versions WHERE campaign_id = $1`, [id]);
      await client.query(`DELETE FROM agreements WHERE campaign_id = $1`, [id]);
      await client.query(
        `DELETE FROM source_documents WHERE campaign_id = $1 AND type = 'soporte_operativo'`,
        [id],
      );
      // V2 · Fase 7: comentarios de revisión → versiones de guion → entregables. Primero: los
      // comentarios apuntan a los mensajes del chat, y las versiones a las fuentes y a las
      // acciones propuestas (todo RESTRICT); el entregable cuelga de la participación.
      // Análisis de contenido (024): referencias → hallazgos → llamadas del ledger → revisiones. La FK
      // `approved_analysis_id` de las versiones se suelta antes (RESTRICT: aquí SOLO limpieza de pruebas).
      await client.query(
        `DELETE FROM content_finding_script_refs
          WHERE finding_id IN (SELECT id FROM content_findings WHERE campaign_id = $1)`,
        [id],
      );
      await client.query(
        `DELETE FROM content_finding_brief_refs
          WHERE finding_id IN (SELECT id FROM content_findings WHERE campaign_id = $1)`,
        [id],
      );
      await client.query(`DELETE FROM content_findings WHERE campaign_id = $1`, [id]);
      await client.query(`DELETE FROM ai_runs WHERE campaign_id = $1 AND task = 'analizar_guion'`, [id]);
      await client.query(
        `UPDATE script_versions SET approved_analysis_id = NULL WHERE campaign_id = $1 AND approved_analysis_id IS NOT NULL`,
        [id],
      );
      await client.query(`DELETE FROM content_analysis_runs WHERE campaign_id = $1`, [id]);
      await client.query(`DELETE FROM script_review_comments WHERE campaign_id = $1`, [id]);
      await client.query(`DELETE FROM script_versions WHERE campaign_id = $1`, [id]);
      await client.query(`DELETE FROM deliverables WHERE campaign_id = $1`, [id]);
      // V2 · Fase 6: el chat cuelga (RESTRICT) de la campaña, de sus fuentes y de sus
      // acciones propuestas. Orden: citas → adjuntos → invocaciones → mensajes del
      // asistente (apuntan al run) → runs (apuntan al mensaje de usuario) → mensajes →
      // conversaciones. `ai_runs.agent_run_id` es ON DELETE SET NULL.
      await client.query(`DELETE FROM chat_message_references WHERE campaign_id = $1`, [id]);
      await client.query(`DELETE FROM chat_message_attachments WHERE campaign_id = $1`, [id]);
      await client.query(`DELETE FROM agent_tool_invocations WHERE campaign_id = $1`, [id]);
      await client.query(`DELETE FROM chat_messages WHERE campaign_id = $1 AND role = 'assistant'`, [id]);
      await client.query(`DELETE FROM agent_runs WHERE campaign_id = $1`, [id]);
      await client.query(`DELETE FROM chat_messages WHERE campaign_id = $1`, [id]);
      await client.query(`DELETE FROM chat_conversations WHERE campaign_id = $1`, [id]);
      // V2 · Fase 5: la importación de influencers cuelga (RESTRICT) de la
      // participación, la fuente y el snapshot: se limpia primero, hechos
      // históricos incluidos, con el bypass restringido a bases `_test`.
      await client.query(`DELETE FROM influencer_import_effects WHERE campaign_id = $1`, [id]);
      await client.query(`DELETE FROM influencer_source_bindings WHERE campaign_id = $1`, [id]);
      await client.query(`DELETE FROM influencer_import_resolutions WHERE campaign_id = $1`, [id]);
      await client.query(`DELETE FROM influencer_import_plans WHERE campaign_id = $1`, [id]);
      // V2 · Fase 3: la participación de influencers y sus productos asignados
      // son FK RESTRICT hacia la campaña (nada se borra en cascada): se limpian
      // primero y solo aquí, con el bypass restringido a bases `_test`.
      await client.query(`DELETE FROM campaign_influencer_products WHERE campaign_id = $1`, [id]);
      await client.query(`DELETE FROM campaign_influencers WHERE campaign_id = $1`, [id]);
      await client.query(`DELETE FROM briefs WHERE campaign_id = $1`, [id]);
      await client.query(`DELETE FROM campaigns WHERE id = $1`, [id]);
    }
  });
}

/**
 * Limpieza de influencers de prueba (V2 · Fase 3): participaciones, cuentas e
 * identidades, con el mismo bypass acotado a bases `_test`. Las campañas que los
 * usan se eliminan antes (`eliminarCampanaDePrueba` ya vacía sus participaciones).
 */
export async function eliminarInfluencersDePrueba(idOids: string | readonly string[]): Promise<void> {
  const ids = Array.isArray(idOids) ? idOids : [idOids];
  if (ids.length === 0) return;
  await transaction(async (client) => {
    await client.query(`SET LOCAL tclkolos.permitir_borrado_historico = 'on'`);
    for (const id of ids) {
      // V2 · Fase 8: los datos personales cifrados cuelgan (RESTRICT) del influencer; los envíos que los
      // referencian ya se borraron con su campaña (`eliminarCampanaDePrueba`).
      await client.query(`DELETE FROM influencer_pii_records WHERE influencer_id = $1`, [id]);
      // V2 · Fase 5: bindings y decisiones que apuntan a la persona.
      await client.query(`DELETE FROM influencer_import_effects WHERE entity_id = $1`, [id]);
      await client.query(`DELETE FROM influencer_source_bindings WHERE influencer_id = $1`, [id]);
      await client.query(`DELETE FROM influencer_import_resolutions WHERE influencer_id = $1`, [id]);
      await client.query(
        `DELETE FROM campaign_influencer_products
          WHERE campaign_influencer_id IN (SELECT id FROM campaign_influencers WHERE influencer_id = $1)`,
        [id],
      );
      await client.query(`DELETE FROM campaign_influencers WHERE influencer_id = $1`, [id]);
      await client.query(`DELETE FROM influencer_accounts WHERE influencer_id = $1`, [id]);
      await client.query(`DELETE FROM influencers WHERE id = $1`, [id]);
    }
  });
}

/**
 * Devuelve un usuario de pruebas con ese correo y rol, creándolo si la base
 * (ya sembrada antes de que existiera el rol) no lo tiene. Solo para pruebas.
 */
export async function asegurarUsuarioDePrueba(
  email: string,
  nombre: string,
  rol: Role,
  organizationId: string,
): Promise<User> {
  await query(
    `INSERT INTO users (email, name, organization_id, role)
     SELECT $1, $2, $3, $4::user_role
      WHERE NOT EXISTS (SELECT 1 FROM users WHERE email = $1)`,
    [email, nombre, organizationId, rol],
  );
  const [fila] = await query<{ id: string; organization_id: string; role: Role; name: string }>(
    `SELECT id, organization_id, role, name FROM users WHERE email = $1`,
    [email],
  );
  return {
    id: fila!.id,
    email,
    name: fila!.name,
    organizationId: fila!.organization_id,
    role: fila!.role,
    status: 'activo',
  };
}

// ─────────────────────────── Escenario del chat (V2 · Fase 6) ──────────────────

/** Configuración de run válida para las pruebas del chat. */
export const CONFIG_DE_RUN_DE_PRUEBA = {
  provider: 'prueba',
  model: 'modelo-de-prueba',
  tier: 'equilibrado',
  promptVersion: 'prompt-prueba-1',
  contextVersion: 'contexto-prueba-1',
} as const;

export interface EscenarioDeChat {
  readonly admin: User;
  readonly director: User;
  readonly consultor: User;
  readonly operativo: User;
  readonly analista: User;
  readonly legal: User;
  /** Usuario TCL (otra organización: la del cliente). */
  readonly cliente: User;
  /** Admin de otra agencia (otra organización). */
  readonly ajeno: User;
  /** Campaña de la agencia (activa). */
  readonly campanaId: string;
  /** Segunda campaña de la misma agencia (para probar el alcance por campaña). */
  readonly otraCampanaId: string;
  /** Campaña de la otra agencia. */
  readonly campanaAjenaId: string;
  /** Todas las campañas creadas, para limpiar. */
  readonly campanas: string[];
  readonly sufijo: string;
}

/**
 * Crea (o reutiliza) los usuarios de prueba de cada rol y tres campañas
 * desechables: dos de la agencia y una de otra agencia. Quien lo usa limpia con
 * `eliminarCampanaDePrueba(escenario.campanas)` en su `afterAll`.
 */
export async function crearEscenarioDeChat(nombre: string): Promise<EscenarioDeChat> {
  const sufijo = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const buscar = async (email: string): Promise<User> => {
    const [fila] = await query<{ id: string; organization_id: string; role: Role; name: string }>(
      `SELECT id, organization_id, role, name FROM users WHERE email = $1`,
      [email],
    );
    if (fila === undefined) throw new Error(`Falta el usuario sembrado ${email}: ejecute el seed.`);
    return {
      id: fila.id,
      email,
      name: fila.name,
      organizationId: fila.organization_id,
      role: fila.role,
      status: 'activo',
    };
  };
  const admin = await buscar('gerardo@smartpr.co');
  const director = await buscar('director@smartpr.co');
  const consultor = await buscar('consultor@smartpr.co');
  const cliente = await buscar('marena@tcl.com');
  const ajeno = await buscar('ajeno@otraagencia.co');
  const operativo = await asegurarUsuarioDePrueba(
    'operativo@smartpr.co',
    'Usuario Operativo',
    'operativo',
    admin.organizationId,
  );
  const analista = await asegurarUsuarioDePrueba(
    'analista-f3@smartpr.co',
    'Analista de pruebas',
    'analista',
    admin.organizationId,
  );
  const legal = await asegurarUsuarioDePrueba(
    'legal-f3@smartpr.co',
    'Legal de pruebas',
    'legal',
    admin.organizationId,
  );

  const campanas: string[] = [];
  const nueva = async (dueno: User, etiqueta: string): Promise<string> => {
    const [c] = await query<{ id: string }>(
      `INSERT INTO campaigns (organization_id, name, owner_id, created_by)
       VALUES ($1, $2, $3, $3) RETURNING id`,
      [dueno.organizationId, `${nombre} · ${etiqueta} · ${sufijo}`, dueno.id],
    );
    campanas.push(c!.id);
    return c!.id;
  };
  const campanaId = await nueva(admin, 'A');
  const otraCampanaId = await nueva(admin, 'B');
  const campanaAjenaId = await nueva(ajeno, 'ajena');
  return {
    admin,
    director,
    consultor,
    operativo,
    analista,
    legal,
    cliente,
    ajeno,
    campanaId,
    otraCampanaId,
    campanaAjenaId,
    campanas,
    sufijo,
  };
}

/** Fuente-archivo mínima (procesada) en una campaña. Solo para pruebas. */
export async function crearFuenteDePrueba(
  campaignId: string,
  dueno: User,
  etiqueta: string,
): Promise<string> {
  const [f] = await query<{ id: string }>(
    `INSERT INTO source_documents
       (campaign_id, organization_id, type, filename, file_id, mime_type, size_bytes, hash, status, created_by)
     VALUES ($1, $2, 'otro', $3, $4, 'text/markdown', 10, $5, 'procesado', $6) RETURNING id`,
    [
      campaignId,
      dueno.organizationId,
      `${etiqueta}.md`,
      `test/${etiqueta}.md`,
      `hash-${etiqueta}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      dueno.id,
    ],
  );
  return f!.id;
}

/** Fragmento de una fuente-archivo (localizador derivado de la página). Solo para pruebas. */
export async function crearFragmentoDePrueba(
  sourceId: string,
  ordinal: number,
  texto: string,
  pagina = 1,
): Promise<string> {
  const [f] = await query<{ id: string }>(
    `INSERT INTO source_fragments (source_id, ordinal, page, text) VALUES ($1, $2, $3, $4) RETURNING id`,
    [sourceId, ordinal, pagina, texto],
  );
  return f!.id;
}

// ─────────────────────────── Escenario de contenido (V2 · Fase 7) ──────────────

export type EstadoDeFuenteDePrueba = 'procesada' | 'en_cola' | 'sensible' | 'fallida';

/**
 * Fuente-archivo de GUION sintética (hash SHA-256 real, único por llamada):
 *   procesada  procesada con un fragmento de texto (legible para la IA);
 *   en_cola    pendiente, sin fragmentos;
 *   sensible   procesada pero con confidencialidad `sensible` (restringida para la IA);
 *   fallida    el procesamiento falló.
 * Visibilidad `interna`. Solo para pruebas.
 */
export async function crearFuenteDeGuionDePrueba(
  campaignId: string,
  dueno: User,
  etiqueta: string,
  estado: EstadoDeFuenteDePrueba = 'procesada',
): Promise<string> {
  const unico = `${etiqueta}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const hash = createHash('sha256').update(unico).digest('hex');
  const [f] = await query<{ id: string }>(
    `INSERT INTO source_documents
       (campaign_id, organization_id, type, filename, file_id, mime_type, size_bytes, hash, status,
        confidentiality_level, created_by)
     VALUES ($1, $2, 'otro', $3, $4, 'text/markdown', 10, $5, $6::source_status, $7::confidentiality_level, $8)
     RETURNING id`,
    [
      campaignId,
      dueno.organizationId,
      `${etiqueta}.md`,
      `test/${unico}.md`,
      hash,
      estado === 'en_cola' ? 'pendiente' : estado === 'fallida' ? 'fallido' : 'procesado',
      estado === 'sensible' ? 'sensible' : 'interna',
      dueno.id,
    ],
  );
  if (estado === 'procesada' || estado === 'sensible') {
    await crearFragmentoDePrueba(f!.id, 1, `Texto sintético del guion ${etiqueta}.`);
  }
  return f!.id;
}

export interface EscenarioDeContenido extends EscenarioDeChat {
  /** Participaciones (CampaignInfluencer) de la campaña activa. Dos comparten el nombre de pila. */
  readonly participaciones: {
    readonly valentinaRios: string;
    readonly valentinaGomez: string;
    readonly diego: string;
  };
  /** `campaign_products.id` de la campaña: P80 (asignado a Valentina Ríos) y P80 Pro (a Valentina Gómez). */
  readonly productos: { readonly p80: string; readonly pro: string };
  /** Entregables activos ya creados (sin versiones). */
  readonly entregables: {
    readonly reelRios: string;
    readonly storyRios: string;
    readonly reelGomez: string;
    readonly reelDiego: string;
  };
  /** Fuentes de guion sintéticas de la campaña (internas). */
  readonly fuentes: {
    readonly procesada: string;
    readonly procesada2: string;
    readonly procesada3: string;
    readonly enCola: string;
    readonly sensible: string;
    readonly fallida: string;
  };
  /** Identidades creadas (para `limpiarEscenarioDeContenido`). */
  readonly influencerIds: string[];
}

function exito<T>(r: Result<T>): T {
  if (!r.ok) throw new Error(`crearEscenarioDeContenido: ${r.error.code}: ${r.error.message}`);
  return r.value;
}

/**
 * Escenario de contenido sobre `crearEscenarioDeChat`: campaña ACTIVA con dos productos, tres
 * participaciones (dos «Valentina»: Ríos y Gómez; y Diego Peña), productos asignados, cuatro
 * entregables y fuentes de guion sintéticas (procesadas, en cola, sensible, fallida). Sin Brief
 * aprobado ni análisis (los añade quien los necesita). Limpiar con `limpiarEscenarioDeContenido`.
 */
export async function crearEscenarioDeContenido(nombre: string): Promise<EscenarioDeContenido> {
  const base = await crearEscenarioDeChat(nombre);
  const { admin, consultor, sufijo, campanaId } = base;
  const influencerIds: string[] = [];

  const productoDeCatalogo = async (modelo: string): Promise<string> => {
    const [fila] = await query<{ id: string }>(`SELECT id FROM products WHERE model = $1`, [modelo]);
    if (fila === undefined) throw new Error(`Falta el producto sembrado ${modelo}: ejecute el seed.`);
    return fila.id;
  };
  const productoDeCampana = async (modelo: string, prioridad: number): Promise<string> => {
    const [cp] = await query<{ id: string }>(
      `INSERT INTO campaign_products (campaign_id, product_id, rol, prioridad, participacion_presupuesto)
       VALUES ($1, $2, 'secundario', $3, 0.5) RETURNING id`,
      [campanaId, await productoDeCatalogo(modelo), prioridad],
    );
    return cp!.id;
  };
  const p80 = await productoDeCampana('P80', 1);
  const pro = await productoDeCampana('P80 Pro', 2);

  const participante = async (displayName: string, handle: string): Promise<string> => {
    const creado = exito(
      await crearInfluencer(admin, {
        displayName,
        cuentas: [{ platform: 'instagram', handle: `${handle}.${sufijo}` }],
      }),
    );
    influencerIds.push(creado.influencer.id);
    const ci = exito(
      await asociarInfluencerACampana(admin, { campaignId: campanaId, influencerId: creado.influencer.id }),
    );
    return ci.id;
  };
  const valentinaRios = await participante('Valentina Ríos', 'valentina.rios');
  const valentinaGomez = await participante('Valentina Gómez', 'valentina.gomez');
  const diego = await participante('Diego Peña', 'diego.pena');
  exito(
    await asociarProductoAInfluencer(admin, { campaignInfluencerId: valentinaRios, campaignProductId: p80 }),
  );
  exito(
    await asociarProductoAInfluencer(admin, { campaignInfluencerId: valentinaGomez, campaignProductId: pro }),
  );

  const entregable = async (ci: string, label: string, producto?: string): Promise<string> =>
    exito(
      await crearEntregable(consultor, {
        campaignInfluencerId: ci,
        label,
        platform: 'instagram',
        campaignProductId: producto,
      }),
    ).id;
  const entregables = {
    reelRios: await entregable(valentinaRios, 'Reel principal', p80),
    storyRios: await entregable(valentinaRios, 'Story de lanzamiento'),
    reelGomez: await entregable(valentinaGomez, 'Reel principal', pro),
    reelDiego: await entregable(diego, 'Reel principal'),
  };

  const fuentes = {
    procesada: await crearFuenteDeGuionDePrueba(campanaId, admin, 'guion-procesada', 'procesada'),
    procesada2: await crearFuenteDeGuionDePrueba(campanaId, admin, 'guion-procesada-2', 'procesada'),
    procesada3: await crearFuenteDeGuionDePrueba(campanaId, admin, 'guion-procesada-3', 'procesada'),
    enCola: await crearFuenteDeGuionDePrueba(campanaId, admin, 'guion-en-cola', 'en_cola'),
    sensible: await crearFuenteDeGuionDePrueba(campanaId, admin, 'guion-sensible', 'sensible'),
    fallida: await crearFuenteDeGuionDePrueba(campanaId, admin, 'guion-fallida', 'fallida'),
  };

  return {
    ...base,
    participaciones: { valentinaRios, valentinaGomez, diego },
    productos: { p80, pro },
    entregables,
    fuentes,
    influencerIds,
  };
}

/** Limpia un `EscenarioDeContenido`: campañas (con todo lo que cuelga) y luego las identidades. */
export async function limpiarEscenarioDeContenido(e: EscenarioDeContenido): Promise<void> {
  await eliminarCampanaDePrueba(e.campanas);
  await eliminarInfluencersDePrueba(e.influencerIds);
}

// ─────────────────────────── Brief aprobado y guiones con texto (V2 · Fase 7 · análisis) ───

/**
 * Fuente-archivo de GUION procesada con el texto dado: un fragmento por elemento (página = posición).
 * Hash SHA-256 real y único; visibilidad `interna`. Solo para pruebas (sintético, nunca P80 real).
 */
export async function crearFuenteDeGuionConTexto(
  campaignId: string,
  dueno: User,
  etiqueta: string,
  fragmentos: readonly string[],
): Promise<string> {
  const id = await crearFuenteDeGuionDePrueba(campaignId, dueno, etiqueta, 'en_cola');
  await query(`UPDATE source_documents SET status = 'procesado' WHERE id = $1`, [id]);
  for (const [i, texto] of fragmentos.entries()) await crearFragmentoDePrueba(id, i + 1, texto, i + 1);
  return id;
}

export interface BriefDePrueba {
  readonly briefId: string;
  readonly versionId: string;
  readonly version: number;
  /** `fieldId` por clave del catálogo (los de producto, con `@{campaignProductId}`). */
  readonly campos: Readonly<Record<string, string>>;
}

/** Valores sintéticos de un Brief aprobado «suficiente» para analizar guiones (sin datos reales). */
export const VALORES_DE_BRIEF_DE_PRUEBA: Readonly<Record<string, unknown>> = {
  'mensaje_principal.one_line': 'El P80 Pro lleva tu fotografía a otro nivel con su cámara de 200 MP.',
  'mensaje_principal.mensaje_clave': 'Fotografía profesional en la palma de tu mano, de día y de noche.',
  'mensaje_principal.beneficio_diferencial': 'La cámara de 200 MP captura detalle incluso con poca luz.',
  'accion_kpis.accion_esperada':
    'Invitar a la audiencia a visitar la tienda oficial usando el enlace de la biografía.',
  mandatorios: [
    { categoria: 'mensaje', descripcion: 'Mencionar el hashtag #P80Pro en la publicación.' },
    { categoria: 'legal', descripcion: 'Incluir la etiqueta de publicidad al inicio del video.' },
  ],
  'practico.restricciones': ['No comparar el producto con marcas de la competencia.'],
};

const RTBS_DE_PRUEBA = ['Cámara principal de 200 MP', 'Batería de 5000 mAh con carga rápida'];

/**
 * Brief de la campaña en versión `approved` (o `draft` con `estado:'draft'`) con los campos que usa el
 * análisis: mensaje principal, acción esperada (CTA), mandatorios, restricciones y, por producto, nombre y
 * RTBs (claims con evidencia). Los campos críticos/claim llevan evidencia de una fuente sintética del
 * Brief. Se inserta como borrador y se aprueba al final (las restricciones de 004/009 lo exigen).
 */
export async function crearBriefAprobadoDePrueba(
  campaignId: string,
  creador: User,
  opciones: {
    readonly productos?: readonly string[] | undefined;
    readonly estado?: 'approved' | 'draft' | undefined;
    readonly valores?: Readonly<Record<string, unknown>> | undefined;
    /** Claves que quedan `not_found` (sin valor): requisitos NO evaluables. */
    readonly noEncontrados?: readonly string[] | undefined;
  } = {},
): Promise<BriefDePrueba> {
  const noEncontrados = opciones.noEncontrados ?? [];
  const valores = Object.fromEntries(
    Object.entries({ ...VALORES_DE_BRIEF_DE_PRUEBA, ...(opciones.valores ?? {}) }).filter(
      ([k]) => !noEncontrados.includes(k),
    ),
  );
  const fuenteDelBrief = await crearFuenteDePrueba(campaignId, creador, `brief-fuente-${Date.now()}`);
  const [brief] = await query<{ id: string }>(
    `INSERT INTO briefs (campaign_id) VALUES ($1)
     ON CONFLICT (campaign_id) DO UPDATE SET campaign_id = EXCLUDED.campaign_id RETURNING id`,
    [campaignId],
  );
  const [sig] = await query<{ proxima: number }>(
    `SELECT COALESCE(MAX(version), 0) + 1 AS proxima FROM brief_versions WHERE brief_id = $1 AND language = 'es'`,
    [brief!.id],
  );
  const [v] = await query<{ id: string }>(
    `INSERT INTO brief_versions (brief_id, organization_id, version, language, status, created_by)
     VALUES ($1, $2, $3, 'es', 'draft', $4) RETURNING id`,
    [brief!.id, creador.organizationId, sig!.proxima, creador.id],
  );
  const campos: Record<string, string> = {};
  const insertar = async (key: string, valor: unknown, productoId?: string): Promise<void> => {
    const criticidad = campoDelCatalogo(key)?.criticidad ?? 'informativo';
    const conEvidencia = criticidad !== 'informativo';
    const [f] = await query<{ id: string }>(
      `INSERT INTO brief_fields
         (brief_version_id, key, campaign_product_id, value, status, confidence, provenance_type, criticidad)
       VALUES ($1, $2, $3, $4::jsonb, 'found', 0.9, 'extracted', $5::criticality) RETURNING id`,
      [v!.id, key, productoId ?? null, JSON.stringify(valor), criticidad],
    );
    campos[productoId === undefined ? key : `${key}@${productoId}`] = f!.id;
    if (conEvidencia) {
      await query(
        `INSERT INTO evidence (brief_field_id, source_id, quote, relation) VALUES ($1, $2, $3, 'soporta')`,
        [f!.id, fuenteDelBrief, `Cita sintética de respaldo para ${key}.`],
      );
    }
  };
  for (const [key, valor] of Object.entries(valores)) await insertar(key, valor);
  for (const key of noEncontrados) {
    const criticidad = campoDelCatalogo(key)?.criticidad ?? 'informativo';
    const [f] = await query<{ id: string }>(
      `INSERT INTO brief_fields (brief_version_id, key, value, status, provenance_type, criticidad)
       VALUES ($1, $2, NULL, 'not_found', 'extracted', $3::criticality) RETURNING id`,
      [v!.id, key, criticidad],
    );
    campos[key] = f!.id;
  }
  for (const productoId of opciones.productos ?? []) {
    await insertar('marca_producto[].rtbs', RTBS_DE_PRUEBA, productoId);
  }
  if ((opciones.estado ?? 'approved') === 'approved') {
    await query(`UPDATE brief_versions SET status = 'approved', approved_at = now() WHERE id = $1`, [v!.id]);
  }
  return { briefId: brief!.id, versionId: v!.id, version: sig!.proxima, campos };
}

/**
 * Crea una versión hija del Brief (la padre queda `superseded`, como en producción), cambia los valores
 * pedidos (campos de campaña, por clave) y la APRUEBA: el rector pasa a ser la hija. Sin `aprobar:false`.
 * Con `aprobar:false` la deja en borrador (el rector sigue siendo el padre).
 */
export async function crearBriefHijoDePrueba(
  actor: User,
  versionPadreId: string,
  opciones: { readonly cambios?: Readonly<Record<string, unknown>>; readonly aprobar?: boolean } = {},
): Promise<{ readonly versionId: string; readonly version: number }> {
  const r = await crearVersionHija(actor, versionPadreId);
  if (!r.ok) throw new Error(`crearBriefHijoDePrueba: ${r.error.code}: ${r.error.message}`);
  for (const [key, valor] of Object.entries(opciones.cambios ?? {})) {
    await query(
      `UPDATE brief_fields SET value = $3::jsonb WHERE brief_version_id = $1 AND key = $2 AND campaign_product_id IS NULL`,
      [r.value.versionId, key, JSON.stringify(valor)],
    );
  }
  if (opciones.aprobar !== false) {
    await query(`UPDATE brief_versions SET status = 'approved', approved_at = now() WHERE id = $1`, [
      r.value.versionId,
    ]);
  }
  return { versionId: r.value.versionId, version: r.value.version };
}

// ─────────────────────────── Escenario de operación (V2 · Fase 8) ──────────────

export type ModoDeAcuerdoDePrueba = 'fee' | 'barter' | 'mixed';
export type ParticipacionDePrueba = 'valentinaRios' | 'valentinaGomez' | 'diego';

export interface AcuerdoDeEscenario {
  readonly mode: ModoDeAcuerdoDePrueba;
  /** Participación del acuerdo. Por defecto `valentinaRios` (tiene el P80 asignado). */
  readonly participacion?: ParticipacionDePrueba | undefined;
  /** fee/mixed: monto (por defecto 1500000) y moneda (por defecto COP). */
  readonly amount?: number | string | undefined;
  readonly currency?: string | undefined;
  /** barter/mixed: cantidad comprometida del producto asignado (por defecto 2). */
  readonly quantity?: number | undefined;
}

export interface OpcionesDeEscenarioDeOperacion {
  /** Acuerdo inicial creado con `crearAcuerdo`. Sin esto no hay acuerdo (las pruebas lo crean). */
  readonly acuerdo?: ModoDeAcuerdoDePrueba | AcuerdoDeEscenario | undefined;
  /** Crea además un acuerdo fee en la organización AJENA (para pruebas de aislamiento). Por defecto `true`. */
  readonly conAcuerdoAjeno?: boolean | undefined;
}

export interface EscenarioDeOperacion extends EscenarioDeContenido {
  /** Acuerdo inicial (vista del admin, con dinero) si se pidió. */
  readonly acuerdo: AcuerdoVista | undefined;
  /** Participación del acuerdo inicial. */
  readonly acuerdoParticipacion: string | undefined;
  /** Organización AJENA: participación (campaña de `ajeno`) y su acuerdo fee (si `conAcuerdoAjeno`). */
  readonly ajena: { readonly participacion: string; readonly acuerdoId: string | undefined };
  /** Directorio temporal de los originales de evidencia (`STORAGE_LOCAL_PATH` apunta aquí hasta limpiar). */
  readonly directorioDeOriginales: string;
  readonly estadoPrevioDeStorage: string | undefined;
}

let secuenciaDeOperacion = 0;

/** Clave de idempotencia única para pruebas de la operación. */
export function claveDePrueba(prefijo = 'k'): string {
  return `${prefijo}-${++secuenciaDeOperacion}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * Crea un acuerdo con el caso de uso (`crearAcuerdo`) y lanza si falla. barter/mixed comprometen el producto
 * indicado (`campaignProductId`) en la cantidad pedida; fee no compromete producto.
 */
export async function crearAcuerdoDePrueba(
  actor: User,
  o: {
    readonly campaignInfluencerId: string;
    readonly mode: ModoDeAcuerdoDePrueba;
    readonly campaignProductId?: string | undefined;
    readonly amount?: number | string | undefined;
    readonly currency?: string | undefined;
    readonly quantity?: number | undefined;
    readonly conditions?: string | undefined;
  },
): Promise<AcuerdoVista> {
  const r = await crearAcuerdo(actor, {
    campaignInfluencerId: o.campaignInfluencerId,
    compensationType: o.mode,
    ...(o.mode === 'barter' ? {} : { feeAmount: o.amount ?? 1_500_000, feeCurrency: o.currency ?? 'COP' }),
    ...(o.conditions === undefined ? {} : { conditions: o.conditions }),
    commitments:
      o.mode === 'fee' || o.campaignProductId === undefined
        ? []
        : [{ campaignProductId: o.campaignProductId, quantity: o.quantity ?? 2 }],
    idempotencyKey: claveDePrueba('acuerdo'),
  });
  if (!r.ok) throw new Error(`crearAcuerdoDePrueba: ${r.error.code}: ${r.error.message}`);
  return r.value.acuerdo;
}

/**
 * Escenario de operación sobre `crearEscenarioDeContenido` (agencia con admin, director, consultor, operativo,
 * analista, legal; cliente TCL; admin de otra agencia): campaña ACTIVA con dos productos (`productos.p80` asignado
 * a `valentinaRios`, `productos.pro` a `valentinaGomez`; `diego` sin productos), tres participaciones y, a
 * pedido, un acuerdo inicial creado con `crearAcuerdo`. En la organización ajena crea una participación y
 * (por defecto) un acuerdo fee. Los originales de evidencia van a un directorio temporal.
 * Limpiar SIEMPRE con `limpiarEscenarioDeOperacion` (usa `eliminarCampanaDePrueba`, que ya borra las tablas F8).
 */
export async function crearEscenarioDeOperacion(
  nombre: string,
  opciones: OpcionesDeEscenarioDeOperacion = {},
): Promise<EscenarioDeOperacion> {
  const estadoPrevioDeStorage = process.env['STORAGE_LOCAL_PATH'];
  const directorioDeOriginales = mkdtempSync(join(tmpdir(), 'tcl-ops-'));
  process.env['STORAGE_LOCAL_PATH'] = directorioDeOriginales;
  const base = await crearEscenarioDeContenido(nombre);
  const { admin, ajeno, sufijo } = base;

  // Organización ajena: una participación (y su acuerdo fee) en la campaña de la otra agencia.
  const identidadAjena = exito(
    await crearInfluencer(ajeno, {
      displayName: 'Ajena Operación',
      cuentas: [{ platform: 'instagram', handle: `ajena.operacion.${sufijo}` }],
    }),
  );
  base.influencerIds.push(identidadAjena.influencer.id);
  const participacionAjena = exito(
    await asociarInfluencerACampana(ajeno, {
      campaignId: base.campanaAjenaId,
      influencerId: identidadAjena.influencer.id,
    }),
  ).id;
  const acuerdoAjeno =
    opciones.conAcuerdoAjeno === false
      ? undefined
      : await crearAcuerdoDePrueba(ajeno, { campaignInfluencerId: participacionAjena, mode: 'fee' });

  let acuerdo: AcuerdoVista | undefined;
  let acuerdoParticipacion: string | undefined;
  if (opciones.acuerdo !== undefined) {
    const a: AcuerdoDeEscenario =
      typeof opciones.acuerdo === 'string' ? { mode: opciones.acuerdo } : opciones.acuerdo;
    const quien = a.participacion ?? 'valentinaRios';
    acuerdoParticipacion = base.participaciones[quien];
    const producto = quien === 'valentinaGomez' ? base.productos.pro : base.productos.p80;
    acuerdo = await crearAcuerdoDePrueba(admin, {
      campaignInfluencerId: acuerdoParticipacion,
      mode: a.mode,
      campaignProductId: producto,
      amount: a.amount,
      currency: a.currency,
      quantity: a.quantity,
    });
  }
  return {
    ...base,
    acuerdo,
    acuerdoParticipacion,
    ajena: { participacion: participacionAjena, acuerdoId: acuerdoAjeno?.id },
    directorioDeOriginales,
    estadoPrevioDeStorage,
  };
}

/** Limpia un `EscenarioDeOperacion`: campañas con TODO lo F8 (`eliminarCampanaDePrueba`), identidades y el directorio temporal. */
export async function limpiarEscenarioDeOperacion(op: EscenarioDeOperacion): Promise<void> {
  await limpiarEscenarioDeContenido(op);
  if (op.estadoPrevioDeStorage === undefined) delete process.env['STORAGE_LOCAL_PATH'];
  else process.env['STORAGE_LOCAL_PATH'] = op.estadoPrevioDeStorage;
  rmSync(op.directorioDeOriginales, { recursive: true, force: true });
}
