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
import type { Result, Role, User } from '@tcl-kol-os/domain';
import { asociarInfluencerACampana, asociarProductoAInfluencer } from './campaign-influencers.ts';
import { query, transaction } from './client.ts';
import { crearEntregable } from './deliverables.ts';
import { crearInfluencer } from './influencers.ts';

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
      // V2 · Fase 7: comentarios de revisión → versiones de guion → entregables. Primero: los
      // comentarios apuntan a los mensajes del chat, y las versiones a las fuentes y a las
      // acciones propuestas (todo RESTRICT); el entregable cuelga de la participación.
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
