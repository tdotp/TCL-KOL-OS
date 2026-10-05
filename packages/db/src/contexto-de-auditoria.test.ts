/**
 * V2 · Fase 6 — `contexto?: ContextoDeAuditoria` en los casos de uso existentes
 * (generarPreguntas, responderPregunta, extraerBrief, reintentarExtraccion).
 *
 * Retrocompatibilidad: sin contexto, el comportamiento es el de siempre (origen
 * `ui`, sin correlación). Con contexto, el canal y la correlación llegan a la
 * auditoría; un origen `system` para una persona se rechaza antes de tocar nada.
 * `audit-context.ts` es el hogar de `ContextoDeAuditoria` / `exigirPersona` /
 * `auditoriaDe` y se reexportan desde `influencers.ts`.
 *
 * Campañas propias y desechables (INC-001A).
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { User } from '@tcl-kol-os/domain';
import { closePool, query } from './client.ts';
import { asegurarUsuarioDePrueba, eliminarCampanaDePrueba } from './test-utils.ts';
import { findUserByEmail } from './users.ts';
import { crearBriefManual } from './manual.ts';
import { auditoriaDe, exigirPersona } from './audit-context.ts';
import * as desdeInfluencers from './influencers.ts';
import { generarPreguntas, listarPreguntas, responderPregunta } from './local-questions.ts';
import { extraerBrief, reintentarExtraccion } from './extraction.ts';

let admin: User;
let operativo: User;
const campanas: string[] = [];

const CORRELACION = {
  conversationId: 'conv-ctx',
  messageId: 'msg-ctx',
  agentRunId: 'run-ctx',
} as const;

async function nuevaCampana(etiqueta: string): Promise<string> {
  const [c] = await query<{ id: string }>(
    `INSERT INTO campaigns (organization_id, name, owner_id, created_by)
     VALUES ($1, $2, $3, $3) RETURNING id`,
    [admin.organizationId, `Contexto · ${etiqueta} · ${Date.now()}`, admin.id],
  );
  campanas.push(c!.id);
  return c!.id;
}

async function conBriefManual(etiqueta: string) {
  const campaignId = await nuevaCampana(etiqueta);
  const creado = await crearBriefManual(admin, campaignId);
  if (!creado.ok) throw new Error(creado.error.message);
  return { campaignId, versionId: creado.value.versionId };
}

async function eventos(entityId: string, action: string) {
  return query<{
    origin: string;
    actor_id: string | null;
    correlation: Record<string, string> | null;
  }>(
    `SELECT origin, actor_id, correlation FROM audit_events
      WHERE entity_id = $1 AND action = $2 ORDER BY created_at, id`,
    [entityId, action],
  );
}

beforeAll(async () => {
  admin = (await findUserByEmail('gerardo@smartpr.co'))!;
  operativo = await asegurarUsuarioDePrueba(
    'operativo@smartpr.co',
    'Usuario Operativo',
    'operativo',
    admin.organizationId,
  );
});

afterAll(async () => {
  await eliminarCampanaDePrueba(campanas);
  await closePool();
});

describe('audit-context.ts', () => {
  it('es el hogar de ContextoDeAuditoria / exigirPersona / auditoriaDe, reexportados desde influencers.ts', () => {
    expect(desdeInfluencers.exigirPersona).toBe(exigirPersona);
    expect(desdeInfluencers.auditoriaDe).toBe(auditoriaDe);
  });

  it('exigirPersona: una persona pasa (ui y chat); system o un no-usuario no; una persona con origen system tampoco', () => {
    expect(exigirPersona(admin, undefined).ok).toBe(true);
    expect(exigirPersona(admin, { origin: 'ui' }).ok).toBe(true);
    expect(exigirPersona(admin, { origin: 'chat', correlation: CORRELACION }).ok).toBe(true);
    for (const r of [exigirPersona('system', undefined), exigirPersona(undefined, undefined)]) {
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('FORBIDDEN_ROLE');
    }
    expect(exigirPersona(admin, { origin: 'system' }).ok).toBe(false);
  });

  it('auditoriaDe copia origen y correlación del contexto', () => {
    const evento = { action: 'x', entityType: 'y', entityId: 'z', metadata: { a: 1 } };
    expect(auditoriaDe(admin, { origin: 'chat', correlation: CORRELACION }, evento)).toMatchObject({
      actor: admin,
      origin: 'chat',
      correlation: CORRELACION,
      ...evento,
    });
    expect(auditoriaDe(admin, undefined, evento)).toMatchObject({ actor: admin, origin: undefined });
  });
});

describe('generarPreguntas y responderPregunta con contexto opcional', () => {
  it('sin contexto: origen ui y sin correlación (el comportamiento de siempre)', async () => {
    const { campaignId, versionId } = await conBriefManual('preg-ui');
    const g = await generarPreguntas(admin, versionId);
    expect(g.ok && g.value.creadas > 0).toBe(true);
    const [ev] = await eventos(versionId, 'question.generate');
    expect(ev).toMatchObject({ origin: 'ui', actor_id: admin.id, correlation: null });

    const preguntas = valorLista(await listarPreguntas(admin, campaignId, { status: 'pendiente' }));
    const respondida = await responderLaPrimeraQueAcepte(preguntas.map((p) => p.id));
    expect(respondida).toBeDefined();
    const [e] = await eventos(respondida!, 'question.answer');
    expect(e).toMatchObject({ origin: 'ui', actor_id: admin.id, correlation: null });
  });

  it('desde el chat: el evento queda con origen chat y la correlación completa', async () => {
    const { campaignId, versionId } = await conBriefManual('preg-chat');
    const g = await generarPreguntas(admin, versionId, { origin: 'chat', correlation: CORRELACION });
    expect(g.ok && g.value.creadas > 0).toBe(true);
    const [ev] = await eventos(versionId, 'question.generate');
    expect(ev).toMatchObject({ origin: 'chat', actor_id: admin.id });
    expect(ev!.correlation).toMatchObject(CORRELACION);

    // Una pregunta cuyo campo admite texto libre se responde y se audita como chat.
    const preguntas = valorLista(await listarPreguntas(admin, campaignId, { status: 'pendiente' }));
    const respondida = await responderLaPrimeraQueAcepte(
      preguntas.map((p) => p.id),
      { origin: 'chat', correlation: CORRELACION },
    );
    expect(respondida).toBeDefined();
    const [e] = await eventos(respondida!, 'question.answer');
    expect(e).toMatchObject({ origin: 'chat', actor_id: admin.id });
    expect(e!.correlation).toMatchObject(CORRELACION);
  });

  it('un origen system para una persona se rechaza antes de tocar nada', async () => {
    const { campaignId, versionId } = await conBriefManual('preg-system');
    const g = await generarPreguntas(admin, versionId, { origin: 'system' });
    expect(g.ok).toBe(false);
    expect(valorLista(await listarPreguntas(admin, campaignId))).toHaveLength(0);
    expect(await eventos(versionId, 'question.generate')).toHaveLength(0);

    await generarPreguntas(admin, versionId);
    const [pregunta] = valorLista(await listarPreguntas(admin, campaignId, { status: 'pendiente' }));
    const r = await responderPregunta(admin, pregunta!.id, { answerValue: 'x' }, { origin: 'system' });
    expect(r.ok).toBe(false);
    expect(await eventos(pregunta!.id, 'question.answer')).toHaveLength(0);
  });

  it('el permiso de la persona se exige igual desde el chat (operativo no genera ni responde)', async () => {
    const { versionId } = await conBriefManual('preg-permiso');
    const ctx = { origin: 'chat', correlation: CORRELACION } as const;
    const r = await generarPreguntas(operativo, versionId, ctx);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('FORBIDDEN_ROLE');
  });
});

describe('extraerBrief y reintentarExtraccion con contexto opcional', () => {
  // Una campaña sin fuentes procesadas no llega a llamar al modelo: recorre
  // `draft → processing → processing_failed` sin costo ni proveedor.
  it('desde el chat: processing sale con origen chat y la correlación; processing_failed (system) hereda solo la correlación', async () => {
    const campaignId = await nuevaCampana('extraer-chat');
    const r = await extraerBrief(admin, campaignId, { origin: 'chat', correlation: CORRELACION });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('AI_EXTRACTION_FAILED');

    const [version] = await query<{ id: string }>(
      `SELECT v.id FROM brief_versions v JOIN briefs b ON b.id = v.brief_id WHERE b.campaign_id = $1`,
      [campaignId],
    );
    const transiciones = await query<{
      origin: string;
      actor_id: string | null;
      correlation: Record<string, string> | null;
      metadata: { to: string };
    }>(
      `SELECT origin, actor_id, correlation, metadata FROM audit_events
        WHERE entity_type = 'brief_version' AND entity_id = $1 AND action = 'brief.transition'
        ORDER BY created_at, id`,
      [version!.id],
    );
    const aProcessing = transiciones.find((t) => t.metadata.to === 'processing')!;
    expect(aProcessing).toMatchObject({ origin: 'chat', actor_id: admin.id });
    expect(aProcessing.correlation).toMatchObject(CORRELACION);
    const aFallida = transiciones.find((t) => t.metadata.to === 'processing_failed')!;
    expect(aFallida).toMatchObject({ origin: 'system', actor_id: null });
    expect(aFallida.correlation).toMatchObject(CORRELACION);

    // Reintentar desde el chat: processing_failed → processing con el mismo contexto.
    const reintento = await reintentarExtraccion(admin, campaignId, version!.id, {
      origin: 'chat',
      correlation: { ...CORRELACION, messageId: 'msg-reintento' },
    });
    expect(reintento.ok).toBe(false);
    const aProcessingDeNuevo = (
      await query<{ origin: string; correlation: Record<string, string> | null }>(
        `SELECT origin, correlation FROM audit_events
          WHERE entity_type = 'brief_version' AND entity_id = $1 AND action = 'brief.transition'
            AND metadata->>'to' = 'processing' ORDER BY created_at, id`,
        [version!.id],
      )
    ).at(-1)!;
    expect(aProcessingDeNuevo).toMatchObject({ origin: 'chat' });
    expect(aProcessingDeNuevo.correlation).toMatchObject({ messageId: 'msg-reintento' });
  });

  it('sin contexto: processing sale como ui sin correlación y el system sin correlación (como siempre)', async () => {
    const campaignId = await nuevaCampana('extraer-ui');
    await extraerBrief(admin, campaignId);
    const [version] = await query<{ id: string }>(
      `SELECT v.id FROM brief_versions v JOIN briefs b ON b.id = v.brief_id WHERE b.campaign_id = $1`,
      [campaignId],
    );
    const transiciones = await query<{
      origin: string;
      correlation: Record<string, string> | null;
      metadata: { to: string };
    }>(
      `SELECT origin, correlation, metadata FROM audit_events
        WHERE entity_type = 'brief_version' AND entity_id = $1 AND action = 'brief.transition'
        ORDER BY created_at, id`,
      [version!.id],
    );
    expect(transiciones.find((t) => t.metadata.to === 'processing')).toMatchObject({
      origin: 'ui',
      correlation: null,
    });
    expect(transiciones.find((t) => t.metadata.to === 'processing_failed')).toMatchObject({
      origin: 'system',
      correlation: null,
    });
  });

  it('un origen system para una persona, o un rol sin brief:edit, no inician ninguna extracción', async () => {
    const campaignId = await nuevaCampana('extraer-rechazos');
    const a = await extraerBrief(admin, campaignId, { origin: 'system' });
    expect(a.ok).toBe(false);
    const b = await extraerBrief(operativo, campaignId, { origin: 'chat', correlation: CORRELACION });
    expect(b.ok).toBe(false);
    if (!b.ok) expect(b.error.code).toBe('FORBIDDEN_ROLE');
    expect(await query(`SELECT 1 FROM briefs WHERE campaign_id = $1`, [campaignId])).toHaveLength(0);
  });
});

function valorLista<T>(r: { ok: true; value: T } | { ok: false; error: { message: string } }): T {
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
}

/** Responde la primera pregunta cuyo campo admite texto libre; devuelve su id. */
async function responderLaPrimeraQueAcepte(
  ids: readonly string[],
  contexto?: Parameters<typeof responderPregunta>[3],
): Promise<string | undefined> {
  for (const id of ids) {
    const r = await responderPregunta(
      admin,
      id,
      { answerValue: respuestaValidaPara(''), answer: 'Dicho en la prueba' },
      contexto,
    );
    if (r.ok) return id;
  }
  return undefined;
}

/** Un valor estructuralmente válido para campos de texto libre del catálogo (si no, la pregunta se salta). */
function respuestaValidaPara(_key: string): unknown {
  return 'Respuesta de prueba';
}
