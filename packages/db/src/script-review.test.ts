/**
 * V2 · Fase 7 — revisión humana de guiones (`script-review.ts`), contra PostgreSQL real
 * (migración 023): comentarios SmartPR, cambios solicitados y su lectura.
 *
 * Todo sobre campañas, influencers y fuentes sintéticos y desechables (INC-001A). Los triggers de
 * `script_review_comments` se prueban por SQL directo en `script-comments-triggers.test.ts`;
 * aquí se prueba el caso de uso: autor/origen fijados por el sistema, cita exacta del chat,
 * estado abierto, atomicidad, idempotencia, aislamiento y auditoría sin texto.
 */

import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Result, ScriptVersionStatus, User } from '@tcl-kol-os/domain';
import { archiveCampaign } from './campaigns.ts';
import { retirarInfluencerDeCampana } from './campaign-influencers.ts';
import { closePool, query, transaction } from './client.ts';
import { archivarEntregable, crearEntregable } from './deliverables.ts';
import type { ContextoDeAuditoria } from './audit-context.ts';
import {
  type ComentarioDeRevision,
  MAX_CAMBIOS_POR_SOLICITUD,
  crearComentarioDeRevision,
  listarComentariosDeRevision,
  solicitarCambiosDeScript,
} from './script-review.ts';
import { iniciarRevisionDeVersion, registrarVersionDeGuion } from './script-versions.ts';
import {
  type EscenarioDeContenido,
  crearEscenarioDeContenido,
  crearFuenteDeGuionDePrueba,
  limpiarEscenarioDeContenido,
} from './test-utils.ts';

let e: EscenarioDeContenido;
/** Escenario aparte para lo destructivo (archivar campaña, retirar participación). */
let d: EscenarioDeContenido;

const valor = <T>(r: Result<T>): T => {
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
  return r.value;
};
const codigo = <T>(r: Result<T>): string | undefined => (r.ok ? undefined : r.error.code);
const razon = <T>(r: Result<T>): unknown =>
  r.ok ? undefined : (r.error.details as { reason?: unknown } | undefined)?.reason;

beforeAll(async () => {
  e = await crearEscenarioDeContenido('F7 revisión');
  d = await crearEscenarioDeContenido('F7 revisión destructiva');
});
afterAll(async () => {
  await limpiarEscenarioDeContenido(e);
  await limpiarEscenarioDeContenido(d);
  await closePool();
});

// ─────────────────────────── Ayudantes locales ─────────────────────────────────

let seq = 0;

/** Entregable desechable de Diego con UNA versión recibida. */
async function nuevaVersion(
  esc: EscenarioDeContenido = e,
): Promise<{ deliverableId: string; versionId: string }> {
  const n = ++seq;
  const entregable = valor(
    await crearEntregable(esc.consultor, {
      campaignInfluencerId: esc.participaciones.diego,
      label: `Revisión ${n} ${esc.sufijo}`,
    }),
  );
  return { deliverableId: entregable.id, versionId: await registrarVersion(esc, entregable.id) };
}

async function registrarVersion(esc: EscenarioDeContenido, deliverableId: string): Promise<string> {
  const fuente = await crearFuenteDeGuionDePrueba(esc.campanaId, esc.admin, `rev-${++seq}`);
  const r = valor(
    await registrarVersionDeGuion(esc.consultor, {
      campaignId: esc.campanaId,
      sourceId: fuente,
      participation: { participationId: esc.participaciones.diego },
      deliverable: { id: deliverableId },
    }),
  );
  if (r.kind !== 'registered') throw new Error(`se esperaba registered y fue ${r.kind}`);
  return r.version.id;
}

async function estado(versionId: string): Promise<ScriptVersionStatus> {
  const [f] = await query<{ status: ScriptVersionStatus }>(
    `SELECT status FROM script_versions WHERE id = $1`,
    [versionId],
  );
  return f!.status;
}

async function filasDeComentarios(versionId: string) {
  return query<{
    id: string;
    kind: string;
    body: string;
    origin: string;
    author_id: string;
    chat_message_id: string | null;
    locator: unknown;
    correlation: Record<string, string> | null;
  }>(
    `SELECT id, kind, body, origin, author_id, chat_message_id, locator, correlation
       FROM script_review_comments WHERE script_version_id = $1 ORDER BY created_at, ctid`,
    [versionId],
  );
}

async function auditoria(action: string, entityId: string) {
  return query<{
    actor_id: string | null;
    origin: string;
    metadata: Record<string, unknown>;
    correlation: Record<string, string> | null;
  }>(
    `SELECT actor_id, origin::text AS origin, metadata, correlation
       FROM audit_events WHERE action = $1 AND entity_id = $2 ORDER BY created_at, id`,
    [action, entityId],
  );
}

async function conversacion(dueno: User, campana = e.campanaId): Promise<string> {
  const [c] = await query<{ id: string }>(
    `INSERT INTO chat_conversations (organization_id, campaign_id, created_by) VALUES ($1, $2, $3) RETURNING id`,
    [dueno.organizationId, campana, dueno.id],
  );
  return c!.id;
}

async function mensajeDeUsuario(
  conv: string,
  dueno: User,
  contenido: string,
  campana = e.campanaId,
): Promise<string> {
  const [m] = await query<{ id: string }>(
    `INSERT INTO chat_messages (organization_id, campaign_id, conversation_id, role, user_id, content, client_message_id)
     VALUES ($1, $2, $3, 'user', $4, $5, $6) RETURNING id`,
    [
      dueno.organizationId,
      campana,
      conv,
      dueno.id,
      contenido,
      `cm-${Math.random().toString(36).slice(2)}-${Date.now()}`,
    ],
  );
  return m!.id;
}

/** Un mensaje del ASISTENTE (que también lleva el user_id de la persona). */
async function mensajeDeAsistente(dueno: User, contenido: string): Promise<string> {
  const conv = await conversacion(dueno);
  const usuario = await mensajeDeUsuario(conv, dueno, 'pregunta del usuario');
  const [run] = await query<{ id: string }>(
    `INSERT INTO agent_runs (organization_id, campaign_id, conversation_id, user_message_id, user_id,
                             provider, model, tier, prompt_version, context_version)
     VALUES ($1, $2, $3, $4, $5, 'p', 'm', 'equilibrado', 'v1', 'c1') RETURNING id`,
    [dueno.organizationId, e.campanaId, conv, usuario, dueno.id],
  );
  await query(
    `UPDATE agent_runs SET status = 'running', started_at = now(), heartbeat_at = now(),
            context_hash = $2, context_manifest = '{}'::jsonb WHERE id = $1`,
    [run!.id, 'a'.repeat(64)],
  );
  const [m] = await query<{ id: string }>(
    `INSERT INTO chat_messages (organization_id, campaign_id, conversation_id, role, user_id, content, agent_run_id)
     VALUES ($1, $2, $3, 'assistant', $4, $5, $6) RETURNING id`,
    [dueno.organizationId, e.campanaId, conv, dueno.id, contenido, run!.id],
  );
  return m!.id;
}

/** Contexto de una tool del agente: canal chat con correlación completa. */
function contextoDeChat(conversationId: string, messageId: string): ContextoDeAuditoria {
  return { origin: 'chat', correlation: { conversationId, messageId } };
}

/** Fija estados saltándose los triggers de transición (bypass restringido a bases `_test`). */
async function conBypass(fn: (c: pg.PoolClient) => Promise<void>): Promise<void> {
  await transaction(async (c) => {
    await c.query(`SET LOCAL tclkolos.permitir_borrado_historico = 'on'`);
    await fn(c);
  });
}

const comentar = (
  versionId: string,
  body: string,
  extra: { kind?: 'editorial' | 'change_request'; locator?: unknown } = {},
  actor: User = e.consultor,
) =>
  crearComentarioDeRevision(actor, versionId, {
    kind: extra.kind ?? 'editorial',
    body,
    locator: extra.locator,
  });

// ─────────────────────────── Comentario por una persona (ui) ───────────────────

describe('crearComentarioDeRevision: una persona comenta desde la UI', () => {
  it('guarda el comentario con la persona como autora, origen ui, y arranca la revisión (received → in_review)', async () => {
    const { versionId } = await nuevaVersion();
    expect(await estado(versionId)).toBe('received');

    const r = valor(await comentar(versionId, 'Revisar el tono de la apertura', { kind: 'editorial' }));

    expect(r.deduplicated).toBe(false);
    expect(r.startedReview).toBe(true);
    expect(r.comment).toMatchObject({
      kind: 'editorial',
      body: 'Revisar el tono de la apertura',
      origin: 'ui',
      authorRelation: 'self',
      authorDisplayName: e.consultor.name,
    });
    expect(r.comment.chatMessageId).toBeUndefined();
    expect(await estado(versionId)).toBe('in_review');

    const [fila] = await filasDeComentarios(versionId);
    expect(fila).toMatchObject({ author_id: e.consultor.id, origin: 'ui', chat_message_id: null });
  });

  it('audita script_review_comment.create (origen ui) y el arranque de la revisión; el segundo comentario no vuelve a arrancarla', async () => {
    const { versionId } = await nuevaVersion();
    const primero = valor(await comentar(versionId, 'Primer comentario de la revisión'));
    const segundo = valor(await comentar(versionId, 'Segundo comentario de la revisión'));
    expect(segundo.startedReview).toBe(false);

    for (const c of [primero.comment, segundo.comment]) {
      const [a] = await auditoria('script_review_comment.create', c.id);
      expect(a).toMatchObject({ actor_id: e.consultor.id, origin: 'ui' });
      expect(a!.metadata).toMatchObject({ scriptVersionId: versionId, kind: 'editorial' });
    }
    const transiciones = await auditoria('script_version.transition', versionId);
    expect(transiciones).toHaveLength(1);
    expect(transiciones[0]!.metadata).toMatchObject({ from: 'received', to: 'in_review' });
  });

  it('admin, director y consultor comentan; el comentario de otra persona se ve como «other»', async () => {
    const { versionId } = await nuevaVersion();
    for (const autor of [e.admin, e.director, e.consultor]) {
      const r = valor(await comentar(versionId, `Nota de ${autor.role}`, {}, autor));
      expect(r.comment.authorRelation).toBe('self');
    }
    const vistaDeDirector = valor(await listarComentariosDeRevision(e.director, versionId));
    const relaciones = Object.fromEntries(vistaDeDirector.items.map((c) => [c.body, c.authorRelation]));
    expect(relaciones).toEqual({
      'Nota de admin': 'other',
      'Nota de director': 'self',
      'Nota de consultor': 'other',
    });
  });

  it('acepta un localizador válido y rechaza uno inválido sin dejar rastro', async () => {
    const { versionId } = await nuevaVersion();
    const conLocalizador = valor(
      await comentar(versionId, 'Ajustar este párrafo', { locator: { kind: 'page', page: 2 } }),
    );
    expect(conLocalizador.comment.locator).toEqual({ kind: 'page', page: 2 });

    const malo = await comentar(versionId, 'Otro ajuste', { locator: { kind: 'inventado' } });
    expect(codigo(malo)).toBe('VALIDATION_FAILED');
    expect(razon(malo)).toBe('invalid_locator');
    expect(await filasDeComentarios(versionId)).toHaveLength(1);
  });

  it('valida la forma: vacío, demasiado largo, tipo desconocido, carácter nulo, cuerpo ausente', async () => {
    const { versionId } = await nuevaVersion();
    expect(razon(await comentar(versionId, '   '))).toBe('empty_body');
    expect(razon(await comentar(versionId, 'x'.repeat(2001)))).toBe('body_too_long');
    expect(razon(await comentar(versionId, 'con\u0000nulo'))).toBe('invalid_body');
    expect(
      razon(
        await crearComentarioDeRevision(e.consultor, versionId, { kind: 'otro' as never, body: 'ok ok ok' }),
      ),
    ).toBe('invalid_kind');
    expect(
      codigo(await crearComentarioDeRevision(e.consultor, versionId, { kind: 'editorial' } as never)),
    ).toBe('VALIDATION_FAILED');
    // Exactamente 2000 caracteres: cabe.
    expect(valor(await comentar(versionId, 'y'.repeat(2000))).comment.body).toHaveLength(2000);
    // Nada de lo anterior arrancó la revisión salvo el comentario válido final.
    expect(await filasDeComentarios(versionId)).toHaveLength(1);
  });

  it('recorta espacios de los bordes del texto', async () => {
    const { versionId } = await nuevaVersion();
    expect(valor(await comentar(versionId, '   texto con bordes   ')).comment.body).toBe('texto con bordes');
  });

  it('un cometario con origen ui no puede citar un mensaje del chat', async () => {
    const { versionId } = await nuevaVersion();
    const conv = await conversacion(e.consultor);
    const msg = await mensajeDeUsuario(conv, e.consultor, 'Revisar el tono de la apertura');
    const r = await crearComentarioDeRevision(e.consultor, versionId, {
      kind: 'editorial',
      body: 'Revisar el tono de la apertura',
      chatMessageId: msg,
    });
    expect(codigo(r)).toBe('VALIDATION_FAILED');
    expect(razon(r)).toBe('chat_message_requires_chat_origin');
    expect(await filasDeComentarios(versionId)).toHaveLength(0);
  });

  it('el sistema y un origen system no pueden comentar (por caso de uso y por SQL directo)', async () => {
    const { versionId } = await nuevaVersion();
    expect(
      codigo(
        await crearComentarioDeRevision('system' as never, versionId, {
          kind: 'editorial',
          body: 'Soy el sistema',
        }),
      ),
    ).toBe('FORBIDDEN_ROLE');
    expect(
      codigo(
        await crearComentarioDeRevision(
          e.consultor,
          versionId,
          { kind: 'editorial', body: 'Soy el sistema' },
          { origin: 'system' },
        ),
      ),
    ).toBe('FORBIDDEN_ROLE');
    expect(
      codigo(
        await solicitarCambiosDeScript(
          e.consultor,
          versionId,
          { items: [{ body: 'Soy el sistema' }] },
          { origin: 'system' },
        ),
      ),
    ).toBe('FORBIDDEN_ROLE');

    // SQL directo con origin system: la base lo rechaza (CHECK de origen).
    await expect(
      query(
        `INSERT INTO script_review_comments (organization_id, campaign_id, script_version_id, author_id, kind, body, origin)
         VALUES ($1, $2, $3, $4, 'editorial', 'x', 'system')`,
        [e.admin.organizationId, e.campanaId, versionId, e.consultor.id],
      ),
    ).rejects.toThrow();
    expect(await filasDeComentarios(versionId)).toHaveLength(0);
    expect(await estado(versionId)).toBe('received');
  });
});

// ─────────────────────────── Idempotencia ──────────────────────────────────────

describe('crearComentarioDeRevision: idempotencia de dominio', () => {
  it('el mismo comentario devuelve el existente (deduplicated) sin segunda fila ni segunda auditoría', async () => {
    const { versionId } = await nuevaVersion();
    const a = valor(await comentar(versionId, 'Cambiar el cierre del guion'));
    const b = valor(await comentar(versionId, 'Cambiar el cierre del guion'));
    expect(b.deduplicated).toBe(true);
    expect(b.startedReview).toBe(false);
    expect(b.comment.id).toBe(a.comment.id);
    expect(await filasDeComentarios(versionId)).toHaveLength(1);
    expect(await auditoria('script_review_comment.create', a.comment.id)).toHaveLength(1);
  });

  it('otro texto, otro tipo, otro localizador u otra persona NO es un duplicado', async () => {
    const { versionId } = await nuevaVersion();
    const base = valor(
      await comentar(versionId, 'Texto base del comentario', { locator: { kind: 'page', page: 1 } }),
    );
    const otros = [
      await comentar(versionId, 'Texto base del comentario distinto', { locator: { kind: 'page', page: 1 } }),
      await comentar(versionId, 'Texto base del comentario', {
        kind: 'change_request',
        locator: { kind: 'page', page: 1 },
      }),
      await comentar(versionId, 'Texto base del comentario', { locator: { kind: 'page', page: 2 } }),
      await comentar(
        versionId,
        'Texto base del comentario',
        { locator: { kind: 'page', page: 1 } },
        e.director,
      ),
    ].map(valor);
    for (const o of otros) {
      expect(o.deduplicated).toBe(false);
      expect(o.comment.id).not.toBe(base.comment.id);
    }
    expect(await filasDeComentarios(versionId)).toHaveLength(5);
  });
});

// ─────────────────────────── Origen chat ───────────────────────────────────────

describe('crearComentarioDeRevision: origen chat (cita exacta de un mensaje de la persona)', () => {
  it('guarda la cita como comentario origen chat, con el mensaje enlazado y la correlación completa', async () => {
    const { versionId } = await nuevaVersion();
    const conv = await conversacion(e.consultor);
    const msg = await mensajeDeUsuario(
      conv,
      e.consultor,
      'Quiero dejar anotado: el hook de los primeros tres segundos es débil. Gracias.',
    );
    const r = valor(
      await crearComentarioDeRevision(
        e.consultor,
        versionId,
        { kind: 'editorial', body: 'el hook de los primeros tres segundos es débil', chatMessageId: msg },
        contextoDeChat(conv, msg),
      ),
    );
    expect(r.comment).toMatchObject({ origin: 'chat', chatMessageId: msg, authorRelation: 'self' });
    expect(await estado(versionId)).toBe('in_review');

    const [fila] = await filasDeComentarios(versionId);
    expect(fila).toMatchObject({ author_id: e.consultor.id, origin: 'chat', chat_message_id: msg });
    expect(fila!.correlation).toEqual({ conversationId: conv, messageId: msg });

    const [a] = await auditoria('script_review_comment.create', r.comment.id);
    expect(a).toMatchObject({ actor_id: e.consultor.id, origin: 'chat' });
    expect(a!.correlation).toEqual({ conversationId: conv, messageId: msg });
    // El arranque de la revisión también queda con el canal y la correlación del chat.
    const [t] = await auditoria('script_version.transition', versionId);
    expect(t).toMatchObject({ origin: 'chat' });
    expect(t!.correlation).toEqual({ conversationId: conv, messageId: msg });
  });

  it('con origen chat el mensaje citado es obligatorio', async () => {
    const { versionId } = await nuevaVersion();
    const r = await crearComentarioDeRevision(
      e.consultor,
      versionId,
      { kind: 'editorial', body: 'Un comentario sin mensaje de origen' },
      { origin: 'chat' },
    );
    expect(codigo(r)).toBe('VALIDATION_FAILED');
    expect(razon(r)).toBe('chat_message_required');
    expect(await estado(versionId)).toBe('received');
  });

  it('rechaza un mensaje del asistente aunque lleve el user_id de la persona', async () => {
    const { versionId } = await nuevaVersion();
    const del = await mensajeDeAsistente(
      e.consultor,
      'Te sugiero anotar que el cierre no tiene llamado a la acción.',
    );
    const r = await crearComentarioDeRevision(
      e.consultor,
      versionId,
      { kind: 'editorial', body: 'el cierre no tiene llamado a la acción', chatMessageId: del },
      { origin: 'chat' },
    );
    expect(razon(r)).toBe('chat_message_invalid');
    expect(await filasDeComentarios(versionId)).toHaveLength(0);
    expect(await estado(versionId)).toBe('received');
  });

  it('rechaza el mensaje de OTRA persona (aunque sea de la misma agencia y campaña)', async () => {
    const { versionId } = await nuevaVersion();
    const conv = await conversacion(e.director);
    const delDirector = await mensajeDeUsuario(
      conv,
      e.director,
      'Hay que cambiar el cierre del guion por completo.',
    );
    const r = await crearComentarioDeRevision(
      e.consultor,
      versionId,
      { kind: 'change_request', body: 'cambiar el cierre del guion', chatMessageId: delDirector },
      { origin: 'chat' },
    );
    expect(razon(r)).toBe('chat_message_invalid');
    expect(await filasDeComentarios(versionId)).toHaveLength(0);
  });

  it('rechaza un mensaje de OTRA campaña de la misma agencia', async () => {
    const { versionId } = await nuevaVersion();
    const conv = await conversacion(e.consultor, e.otraCampanaId);
    const deOtraCampana = await mensajeDeUsuario(
      conv,
      e.consultor,
      'Anotar que la voz en off va demasiado rápida.',
      e.otraCampanaId,
    );
    const r = await crearComentarioDeRevision(
      e.consultor,
      versionId,
      { kind: 'editorial', body: 'la voz en off va demasiado rápida', chatMessageId: deOtraCampana },
      { origin: 'chat' },
    );
    expect(razon(r)).toBe('chat_message_invalid');
    expect(await filasDeComentarios(versionId)).toHaveLength(0);
  });

  it('rechaza un mensaje inexistente o con un id mal formado', async () => {
    const { versionId } = await nuevaVersion();
    for (const id of ['00000000-0000-4000-8000-000000000000', 'no-es-un-uuid']) {
      const r = await crearComentarioDeRevision(
        e.consultor,
        versionId,
        { kind: 'editorial', body: 'Un comentario sin respaldo', chatMessageId: id },
        { origin: 'chat' },
      );
      expect(razon(r)).toBe('chat_message_invalid');
    }
    expect(await filasDeComentarios(versionId)).toHaveLength(0);
  });

  it('rechaza un texto que no es subcadena EXACTA del mensaje (mayúsculas, normalización Unicode, paráfrasis)', async () => {
    const { versionId } = await nuevaVersion();
    const conv = await conversacion(e.consultor);
    const msg = await mensajeDeUsuario(conv, e.consultor, 'Revisar la sección de café y la música de fondo.');
    for (const body of [
      'revisar la sección de café', // distinta capitalización
      'Revisar la sección de café', // «é» descompuesta (NFD) frente a la compuesta del mensaje
      'Revisar la sección de té y la música', // paráfrasis
      'Revisar la sección de café y la música de fondo. Además, subir el volumen.', // más larga que el mensaje
    ]) {
      const r = await crearComentarioDeRevision(
        e.consultor,
        versionId,
        { kind: 'editorial', body, chatMessageId: msg },
        { origin: 'chat' },
      );
      expect(razon(r), body).toBe('quote_not_in_message');
    }
    expect(await filasDeComentarios(versionId)).toHaveLength(0);
    expect(await estado(versionId)).toBe('received');
  });

  it('la cita con espacios en los bordes se normaliza y sigue siendo subcadena', async () => {
    const { versionId } = await nuevaVersion();
    const conv = await conversacion(e.consultor);
    const msg = await mensajeDeUsuario(conv, e.consultor, 'Nota: subir el contraste del título.');
    const r = valor(
      await crearComentarioDeRevision(
        e.consultor,
        versionId,
        { kind: 'editorial', body: '  subir el contraste del título.  ', chatMessageId: msg },
        { origin: 'chat' },
      ),
    );
    expect(r.comment.body).toBe('subir el contraste del título.');
  });

  it('la misma cita del mismo mensaje no se duplica (deduplicated); otra cita del mismo mensaje sí es otro comentario', async () => {
    const { versionId } = await nuevaVersion();
    const conv = await conversacion(e.consultor);
    const msg = await mensajeDeUsuario(conv, e.consultor, 'El título es largo. El cierre es corto.');
    const ctx = contextoDeChat(conv, msg);
    const nuevo = (body: string) =>
      crearComentarioDeRevision(e.consultor, versionId, { kind: 'editorial', body, chatMessageId: msg }, ctx);
    const a = valor(await nuevo('El título es largo.'));
    const b = valor(await nuevo('El título es largo.'));
    const c = valor(await nuevo('El cierre es corto.'));
    expect(b).toMatchObject({ deduplicated: true });
    expect(b.comment.id).toBe(a.comment.id);
    expect(c.deduplicated).toBe(false);
    expect(await filasDeComentarios(versionId)).toHaveLength(2);
  });

  it('el modelo/tool no aporta autor ni origen: campos extra de la entrada se ignoran', async () => {
    const { versionId } = await nuevaVersion();
    const conv = await conversacion(e.consultor);
    const msg = await mensajeDeUsuario(conv, e.consultor, 'Anotar: la tipografía del subtítulo es pequeña.');
    const r = valor(
      await crearComentarioDeRevision(
        e.consultor,
        versionId,
        {
          kind: 'editorial',
          body: 'la tipografía del subtítulo es pequeña',
          chatMessageId: msg,
          authorId: e.director.id,
          origin: 'ui',
          author: { id: e.admin.id },
        } as never,
        contextoDeChat(conv, msg),
      ),
    );
    expect(r.comment.origin).toBe('chat');
    const [fila] = await filasDeComentarios(versionId);
    expect(fila).toMatchObject({ author_id: e.consultor.id, origin: 'chat' });
  });
});

// ─────────────────────────── Permisos, aislamiento y estados ───────────────────

describe('crearComentarioDeRevision: permisos y aislamiento', () => {
  it('permisos de los 7 roles + otra agencia: script:manage (admin, director, consultor)', async () => {
    const { versionId } = await nuevaVersion();
    const esperado: [User, string | undefined][] = [
      [e.admin, undefined],
      [e.director, undefined],
      [e.consultor, undefined],
      [e.operativo, 'FORBIDDEN_ROLE'],
      [e.analista, 'FORBIDDEN_ROLE'],
      [e.legal, 'FORBIDDEN_ROLE'],
      [e.cliente, 'RESOURCE_NOT_FOUND'],
      [e.ajeno, 'RESOURCE_NOT_FOUND'],
    ];
    for (const [actor, c] of esperado) {
      expect(codigo(await comentar(versionId, `Intento de ${actor.role}`, {}, actor)), actor.role).toBe(c);
    }
    // Solo comentaron las tres personas autorizadas.
    const filas = await filasDeComentarios(versionId);
    expect(filas.map((f) => f.author_id).sort()).toEqual([e.admin.id, e.director.id, e.consultor.id].sort());
  });

  it('ids mal formados o inexistentes son «no existe»', async () => {
    for (const id of ['', 'no-es-un-uuid', '00000000-0000-4000-8000-000000000000', undefined as never]) {
      expect(codigo(await comentar(id, 'Comentario sin versión')), String(id)).toBe('RESOURCE_NOT_FOUND');
    }
  });

  it('el cerco de campaña (`alcance`): otra campaña = no existe; la correcta funciona', async () => {
    const { versionId } = await nuevaVersion();
    const nuevo = (alcance: { campaignId: string }) =>
      crearComentarioDeRevision(
        e.consultor,
        versionId,
        { kind: 'editorial', body: 'Con cerco de campaña' },
        undefined,
        alcance,
      );
    expect(codigo(await nuevo({ campaignId: e.otraCampanaId }))).toBe('RESOURCE_NOT_FOUND');
    expect(await filasDeComentarios(versionId)).toHaveLength(0);
    expect(valor(await nuevo({ campaignId: e.campanaId })).comment.body).toBe('Con cerco de campaña');
  });
});

describe('crearComentarioDeRevision: estado de la versión y de la campaña', () => {
  it('una versión cerrada (cambios solicitados, aprobada, reemplazada) no admite comentarios: not_open', async () => {
    // cambios solicitados
    const a = await nuevaVersion();
    valor(
      await solicitarCambiosDeScript(e.consultor, a.versionId, {
        items: [{ body: 'Cambiar el gancho inicial' }],
      }),
    );
    // aprobada (fijada por SQL de prueba)
    const b = await nuevaVersion();
    await conBypass(async (c) => {
      await c.query(`UPDATE script_versions SET status = 'in_review' WHERE id = $1`, [b.versionId]);
      await c.query(
        `UPDATE script_versions SET status = 'approved', approved_by = $2, approved_at = now() WHERE id = $1`,
        [b.versionId, e.director.id],
      );
    });
    // reemplazada: V1 con sucesora V2
    const f = await nuevaVersion();
    const v2 = await registrarVersion(e, f.deliverableId);
    await conBypass(async (c) => {
      await c.query(
        `UPDATE script_versions SET status = 'superseded', superseded_by_version_id = $2, superseded_at = now() WHERE id = $1`,
        [f.versionId, v2],
      );
    });

    for (const [versionId, esperado] of [
      [a.versionId, 'changes_requested'],
      [b.versionId, 'approved'],
      [f.versionId, 'superseded'],
    ] as const) {
      expect(await estado(versionId)).toBe(esperado);
      const r = await comentar(versionId, 'Comentario tardío');
      expect(codigo(r), esperado).toBe('RESOURCE_CONFLICT');
      expect(razon(r), esperado).toBe('not_open');
      const s = await solicitarCambiosDeScript(e.consultor, versionId, {
        items: [{ body: 'Cambio tardío' }],
      });
      expect(razon(s), esperado).toBe('not_open');
    }
    // La única fila es la de la solicitud de cambios original.
    expect(await filasDeComentarios(b.versionId)).toHaveLength(0);
    expect(await filasDeComentarios(f.versionId)).toHaveLength(0);
    expect(await filasDeComentarios(a.versionId)).toHaveLength(1);
  });

  it('una campaña archivada rechaza comentar y pedir cambios, pero sus comentarios siguen legibles', async () => {
    const { versionId } = await nuevaVersion(d);
    valor(
      await crearComentarioDeRevision(d.consultor, versionId, {
        kind: 'editorial',
        body: 'Comentario previo',
      }),
    );
    // otra versión sin comentarios, para probar «pedir cambios» en archivada
    const otra = await nuevaVersion(d);
    valor(await archiveCampaign(d.admin, d.campanaId));

    const c = await crearComentarioDeRevision(d.consultor, versionId, {
      kind: 'editorial',
      body: 'Comentario tardío',
    });
    expect(codigo(c)).toBe('RESOURCE_CONFLICT');
    expect(razon(c)).toBe('campaign_not_active');
    const s = await solicitarCambiosDeScript(d.consultor, otra.versionId, {
      items: [{ body: 'Cambio tardío' }],
    });
    expect(razon(s)).toBe('campaign_not_active');
    expect(await estado(otra.versionId)).toBe('received');
    expect(await filasDeComentarios(otra.versionId)).toHaveLength(0);

    const lectura = valor(await listarComentariosDeRevision(d.consultor, versionId));
    expect(lectura.items.map((x) => x.body)).toEqual(['Comentario previo']);
  });

  it('un entregable archivado rechaza comentar y pedir cambios (deliverable_archived)', async () => {
    const { versionId: vArchivado, deliverableId } = await nuevaVersion();
    valor(await archivarEntregable(e.consultor, deliverableId));
    const rc = await comentar(vArchivado, 'Entregable archivado');
    expect(codigo(rc)).toBe('RESOURCE_CONFLICT');
    expect(razon(rc)).toBe('deliverable_archived');
    expect(
      razon(
        await solicitarCambiosDeScript(e.consultor, vArchivado, {
          items: [{ body: 'Entregable archivado' }],
        }),
      ),
    ).toBe('deliverable_archived');
    expect(await estado(vArchivado)).toBe('received');
  });

  it('un participante retirado rechaza comentar y pedir cambios (campaign_influencer_retired)', async () => {
    const dd = await crearEscenarioDeContenido('F7 revisión retirado');
    try {
      const { versionId } = await nuevaVersion(dd);
      valor(await retirarInfluencerDeCampana(dd.admin, dd.participaciones.diego));
      const r = await crearComentarioDeRevision(dd.consultor, versionId, {
        kind: 'editorial',
        body: 'Participante retirado',
      });
      expect(razon(r)).toBe('campaign_influencer_retired');
      const s = await solicitarCambiosDeScript(dd.consultor, versionId, {
        items: [{ body: 'Participante retirado' }],
      });
      expect(razon(s)).toBe('campaign_influencer_retired');
      expect(await estado(versionId)).toBe('received');
    } finally {
      await limpiarEscenarioDeContenido(dd);
    }
  });
});

// ─────────────────────────── Cambios solicitados ───────────────────────────────

describe('solicitarCambiosDeScript', () => {
  it('desde received: crea los change_request (+ nota editorial) y deja la versión en changes_requested', async () => {
    const { versionId } = await nuevaVersion();
    const antes = (await query(`SELECT * FROM script_versions WHERE id = $1`, [versionId]))[0] as Record<
      string,
      unknown
    >;

    const r = valor(
      await solicitarCambiosDeScript(e.consultor, versionId, {
        items: [
          { body: 'Acortar la introducción', locator: { kind: 'page', page: 1 } },
          { body: 'Mencionar el modelo exacto del producto' },
        ],
        nota: 'En general el guion necesita más energía.',
      }),
    );
    expect(r.version).toMatchObject({
      id: versionId,
      status: 'changes_requested',
      previousStatus: 'received',
      version: 1,
    });
    expect(r.changeRequests.map((c) => [c.kind, c.body])).toEqual([
      ['change_request', 'Acortar la introducción'],
      ['change_request', 'Mencionar el modelo exacto del producto'],
    ]);
    expect(r.changeRequests[0]!.locator).toEqual({ kind: 'page', page: 1 });
    expect(r.note).toMatchObject({ kind: 'editorial', body: 'En general el guion necesita más energía.' });

    expect(await estado(versionId)).toBe('changes_requested');
    const filas = await filasDeComentarios(versionId);
    expect(filas.map((f) => f.kind)).toEqual(['change_request', 'change_request', 'editorial']);
    expect(filas.every((f) => f.author_id === e.consultor.id && f.origin === 'ui')).toBe(true);

    // La versión solo cambió de estado (y su marca de actualización).
    const despues = (await query(`SELECT * FROM script_versions WHERE id = $1`, [versionId]))[0] as Record<
      string,
      unknown
    >;
    const { status: s1, updated_at: u1, ...restoAntes } = antes;
    const { status: s2, updated_at: u2, ...restoDespues } = despues;
    expect([s1, s2]).toEqual(['received', 'changes_requested']);
    expect(restoDespues).toEqual(restoAntes);
    void u1;
    void u2;
  });

  it('desde in_review funciona y audita script_version.request_changes sin texto, solo cifras e ids', async () => {
    const { versionId } = await nuevaVersion();
    valor(await iniciarRevisionDeVersion(e.consultor, versionId));
    const r = valor(
      await solicitarCambiosDeScript(e.consultor, versionId, {
        items: [
          { body: 'Sustituir la frase «mejor del mundo»' },
          { body: 'Añadir el aviso legal obligatorio' },
        ],
        nota: 'Prioridad alta antes del viernes.',
      }),
    );
    expect(r.version.previousStatus).toBe('in_review');

    const [a] = await auditoria('script_version.request_changes', versionId);
    expect(a).toMatchObject({ actor_id: e.consultor.id, origin: 'ui' });
    expect(a!.metadata).toMatchObject({
      version: 1,
      from: 'in_review',
      to: 'changes_requested',
      itemCount: 2,
      itemLengths: [
        'Sustituir la frase «mejor del mundo»'.length,
        'Añadir el aviso legal obligatorio'.length,
      ],
      hasNote: true,
      noteLength: 'Prioridad alta antes del viernes.'.length,
      commentIds: r.changeRequests.map((c) => c.id),
    });
    const json = JSON.stringify(a!.metadata);
    for (const texto of ['mejor del mundo', 'aviso legal', 'Prioridad alta'])
      expect(json).not.toContain(texto);
  });

  it('desde in_review no vuelve a auditar transiciones intermedias de más', async () => {
    const { versionId } = await nuevaVersion();
    valor(await solicitarCambiosDeScript(e.consultor, versionId, { items: [{ body: 'Un cambio directo' }] }));
    // received → changes_requested directo: ninguna transición in_review intermedia.
    expect(await auditoria('script_version.transition', versionId)).toHaveLength(0);
    expect(await auditoria('script_version.request_changes', versionId)).toHaveLength(1);
  });

  it('valida el número de cambios (1 a 20) y la forma de cada uno; un cambio inválido no deja NADA', async () => {
    const { versionId } = await nuevaVersion();
    const sin = await solicitarCambiosDeScript(e.consultor, versionId, { items: [] });
    expect(razon(sin)).toBe('invalid_count');
    const demasiados = await solicitarCambiosDeScript(e.consultor, versionId, {
      items: Array.from({ length: MAX_CAMBIOS_POR_SOLICITUD + 1 }, (_, i) => ({
        body: `Cambio número ${i}`,
      })),
    });
    expect(razon(demasiados)).toBe('invalid_count');
    expect(codigo(await solicitarCambiosDeScript(e.consultor, versionId, {} as never))).toBe(
      'VALIDATION_FAILED',
    );
    const mezcla = await solicitarCambiosDeScript(e.consultor, versionId, {
      items: [{ body: 'Un cambio válido' }, { body: '   ' }],
    });
    expect(razon(mezcla)).toBe('empty_body');
    const conNotaLarga = await solicitarCambiosDeScript(e.consultor, versionId, {
      items: [{ body: 'Un cambio válido' }],
      nota: 'n'.repeat(2001),
    });
    expect(razon(conNotaLarga)).toBe('body_too_long');

    expect(await estado(versionId)).toBe('received');
    expect(await filasDeComentarios(versionId)).toHaveLength(0);
    expect(await auditoria('script_version.request_changes', versionId)).toHaveLength(0);

    // Exactamente 20 cambios: cabe.
    const veinte = valor(
      await solicitarCambiosDeScript(e.consultor, versionId, {
        items: Array.from({ length: 20 }, (_, i) => ({ body: `Cambio número ${i + 1}` })),
      }),
    );
    expect(veinte.changeRequests).toHaveLength(20);
    expect(await filasDeComentarios(versionId)).toHaveLength(20);
  });

  it('pedir cambios dos veces: la segunda ve la versión cerrada (not_open) y no añade nada', async () => {
    const { versionId } = await nuevaVersion();
    valor(
      await solicitarCambiosDeScript(e.consultor, versionId, { items: [{ body: 'Primer cambio pedido' }] }),
    );
    const otra = await solicitarCambiosDeScript(e.director, versionId, {
      items: [{ body: 'Segundo cambio pedido' }],
    });
    expect(codigo(otra)).toBe('RESOURCE_CONFLICT');
    expect(razon(otra)).toBe('not_open');
    expect(await filasDeComentarios(versionId)).toHaveLength(1);
    expect(await auditoria('script_version.request_changes', versionId)).toHaveLength(1);
  });

  it('con origen chat: cada cambio es una cita exacta del mensaje de la persona; la nota exige su mensaje', async () => {
    const { versionId } = await nuevaVersion();
    const conv = await conversacion(e.consultor);
    const msg = await mensajeDeUsuario(
      conv,
      e.consultor,
      'Pide a la creadora: acortar la introducción y añadir el precio al final. Y que suene más natural.',
    );
    const ctx = contextoDeChat(conv, msg);

    // Un cambio que NO es cita ⇒ se rechaza TODO.
    const malo = await solicitarCambiosDeScript(
      e.consultor,
      versionId,
      {
        items: [
          { body: 'acortar la introducción', chatMessageId: msg },
          { body: 'este texto no existe en el mensaje', chatMessageId: msg },
        ],
      },
      ctx,
    );
    expect(razon(malo)).toBe('quote_not_in_message');
    // Cambio sin mensaje en origen chat.
    expect(
      razon(
        await solicitarCambiosDeScript(
          e.consultor,
          versionId,
          { items: [{ body: 'acortar la introducción' }] },
          ctx,
        ),
      ),
    ).toBe('chat_message_required');
    // Nota como texto suelto con origen chat.
    expect(
      razon(
        await solicitarCambiosDeScript(
          e.consultor,
          versionId,
          { items: [{ body: 'acortar la introducción', chatMessageId: msg }], nota: 'suene más natural' },
          ctx,
        ),
      ),
    ).toBe('chat_message_required');
    expect(await estado(versionId)).toBe('received');
    expect(await filasDeComentarios(versionId)).toHaveLength(0);

    const r = valor(
      await solicitarCambiosDeScript(
        e.consultor,
        versionId,
        {
          items: [
            { body: 'acortar la introducción', chatMessageId: msg },
            { body: 'añadir el precio al final', chatMessageId: msg },
          ],
          nota: { body: 'que suene más natural', chatMessageId: msg },
        },
        ctx,
      ),
    );
    expect(r.changeRequests.map((c) => c.origin)).toEqual(['chat', 'chat']);
    expect(r.note).toMatchObject({ origin: 'chat', chatMessageId: msg });
    const [a] = await auditoria('script_version.request_changes', versionId);
    expect(a).toMatchObject({ origin: 'chat' });
    expect(a!.correlation).toEqual({ conversationId: conv, messageId: msg });
  });

  it('con origen chat un mensaje del asistente o de otra persona se rechaza y no cambia nada', async () => {
    const { versionId } = await nuevaVersion();
    const delAsistente = await mensajeDeAsistente(
      e.consultor,
      'Propongo pedir: reducir la duración total a 30 segundos.',
    );
    const conv = await conversacion(e.director);
    const delDirector = await mensajeDeUsuario(
      conv,
      e.director,
      'Pedir cambios: reducir la duración total a 30 segundos.',
    );
    for (const msg of [delAsistente, delDirector]) {
      const r = await solicitarCambiosDeScript(
        e.consultor,
        versionId,
        { items: [{ body: 'reducir la duración total a 30 segundos', chatMessageId: msg }] },
        { origin: 'chat' },
      );
      expect(razon(r)).toBe('chat_message_invalid');
    }
    expect(await estado(versionId)).toBe('received');
    expect(await filasDeComentarios(versionId)).toHaveLength(0);
  });

  it('permisos de los 7 roles + otra agencia y aislamiento por alcance', async () => {
    const esperado: [User, string | undefined][] = [
      [e.operativo, 'FORBIDDEN_ROLE'],
      [e.analista, 'FORBIDDEN_ROLE'],
      [e.legal, 'FORBIDDEN_ROLE'],
      [e.cliente, 'RESOURCE_NOT_FOUND'],
      [e.ajeno, 'RESOURCE_NOT_FOUND'],
      [e.admin, undefined],
      [e.director, undefined],
      [e.consultor, undefined],
    ];
    for (const [actor, c] of esperado) {
      const { versionId } = await nuevaVersion();
      const r = await solicitarCambiosDeScript(actor, versionId, {
        items: [{ body: `Cambio de ${actor.role}` }],
      });
      expect(codigo(r), actor.role).toBe(c);
      expect(await estado(versionId), actor.role).toBe(c === undefined ? 'changes_requested' : 'received');
      expect(await filasDeComentarios(versionId), actor.role).toHaveLength(c === undefined ? 1 : 0);
    }
    const { versionId } = await nuevaVersion();
    expect(
      codigo(
        await solicitarCambiosDeScript(
          e.consultor,
          versionId,
          { items: [{ body: 'Con otro cerco' }] },
          undefined,
          { campaignId: e.otraCampanaId },
        ),
      ),
    ).toBe('RESOURCE_NOT_FOUND');
    expect(
      codigo(await solicitarCambiosDeScript(e.consultor, 'no-es-uuid', { items: [{ body: 'x y z' }] })),
    ).toBe('RESOURCE_NOT_FOUND');
    expect(await estado(versionId)).toBe('received');
  });
});

describe('V1 conserva sus comentarios; V2 no los copia ni los borra', () => {
  it('registrar V2 tras pedir cambios deja los de V1 intactos y V2 limpia; V1 ya no admite comentarios', async () => {
    const { deliverableId, versionId: v1 } = await nuevaVersion();
    const pedido = valor(
      await solicitarCambiosDeScript(e.consultor, v1, {
        items: [{ body: 'Cambiar el título' }, { body: 'Quitar la segunda escena' }],
        nota: 'Revisar antes de reenviar.',
      }),
    );
    const idsV1 = [...pedido.changeRequests.map((c) => c.id), pedido.note!.id];

    const v2 = await registrarVersion(e, deliverableId);
    expect(v2).not.toBe(v1);
    expect(await estado(v2)).toBe('received');

    const enV1 = valor(await listarComentariosDeRevision(e.consultor, v1));
    expect(enV1.items.map((c) => c.id)).toEqual(idsV1);
    expect(enV1.total).toBe(3);
    const enV2 = valor(await listarComentariosDeRevision(e.consultor, v2));
    expect(enV2).toEqual({ items: [], total: 0, nextOffset: null });
    expect((await filasDeComentarios(v2)).length).toBe(0);

    // V1 ya cerrada: rechaza.
    expect(razon(await comentar(v1, 'Comentario sobre la versión cerrada'))).toBe('not_open');
    // V2 sí admite.
    valor(await comentar(v2, 'Primer comentario de la versión 2'));
    expect((await filasDeComentarios(v1)).map((f) => f.id)).toEqual(idsV1);
    expect(await filasDeComentarios(v2)).toHaveLength(1);
  });

  it('los comentarios son append-only también por SQL: ni UPDATE ni DELETE', async () => {
    const { versionId } = await nuevaVersion();
    const r = valor(await comentar(versionId, 'Comentario inmutable'));
    await expect(
      query(`UPDATE script_review_comments SET body = 'otro' WHERE id = $1`, [r.comment.id]),
    ).rejects.toThrow(/append-only/);
    await expect(query(`DELETE FROM script_review_comments WHERE id = $1`, [r.comment.id])).rejects.toThrow(
      /append-only/,
    );
  });
});

// ─────────────────────────── Lectura ───────────────────────────────────────────

describe('listarComentariosDeRevision', () => {
  it('ordena por fecha, pagina con nextOffset y filtra por tipo (total refleja el filtro)', async () => {
    const { versionId } = await nuevaVersion();
    for (let i = 1; i <= 5; i++) valor(await comentar(versionId, `Editorial ${i}`));
    valor(await comentar(versionId, 'Cambio uno', { kind: 'change_request' }));
    valor(await comentar(versionId, 'Cambio dos', { kind: 'change_request' }));

    const todos = valor(await listarComentariosDeRevision(e.consultor, versionId));
    expect(todos.total).toBe(7);
    expect(todos.nextOffset).toBeNull();
    expect(todos.items.map((c) => c.body)).toEqual([
      'Editorial 1',
      'Editorial 2',
      'Editorial 3',
      'Editorial 4',
      'Editorial 5',
      'Cambio uno',
      'Cambio dos',
    ]);

    const p1 = valor(await listarComentariosDeRevision(e.consultor, versionId, { limite: 3, desde: 0 }));
    expect(p1.items.map((c) => c.body)).toEqual(['Editorial 1', 'Editorial 2', 'Editorial 3']);
    expect(p1.nextOffset).toBe(3);
    const p2 = valor(
      await listarComentariosDeRevision(e.consultor, versionId, { limite: 3, desde: p1.nextOffset! }),
    );
    expect(p2.items.map((c) => c.body)).toEqual(['Editorial 4', 'Editorial 5', 'Cambio uno']);
    const p3 = valor(
      await listarComentariosDeRevision(e.consultor, versionId, { limite: 3, desde: p2.nextOffset! }),
    );
    expect(p3.items.map((c) => c.body)).toEqual(['Cambio dos']);
    expect(p3.nextOffset).toBeNull();

    const cambios = valor(
      await listarComentariosDeRevision(e.consultor, versionId, { kind: 'change_request' }),
    );
    expect(cambios.total).toBe(2);
    expect(cambios.items.map((c) => c.body)).toEqual(['Cambio uno', 'Cambio dos']);

    expect(codigo(await listarComentariosDeRevision(e.consultor, versionId, { kind: 'otro' as never }))).toBe(
      'VALIDATION_FAILED',
    );
  });

  it('el orden de los cambios de una misma solicitud es el pedido (misma transacción, misma fecha)', async () => {
    const { versionId } = await nuevaVersion();
    const cuerpos = Array.from({ length: 12 }, (_, i) => `Cambio ordenado ${String(i + 1).padStart(2, '0')}`);
    valor(
      await solicitarCambiosDeScript(e.consultor, versionId, {
        items: cuerpos.map((body) => ({ body })),
        nota: 'Nota final',
      }),
    );
    const lista = valor(await listarComentariosDeRevision(e.director, versionId));
    expect(lista.items.map((c) => c.body)).toEqual([...cuerpos, 'Nota final']);
  });

  it('no expone ids de autor: solo la relación (self/other) y el nombre visible', async () => {
    const { versionId } = await nuevaVersion();
    valor(await comentar(versionId, 'De la consultora', {}, e.consultor));
    valor(await comentar(versionId, 'Del director', {}, e.director));
    const lista = valor(await listarComentariosDeRevision(e.consultor, versionId));
    const json = JSON.stringify(lista);
    for (const u of [e.consultor, e.director, e.admin]) expect(json).not.toContain(u.id);
    expect(lista.items.map((c) => [c.authorRelation, c.authorDisplayName])).toEqual([
      ['self', e.consultor.name],
      ['other', e.director.name],
    ]);
    for (const c of lista.items as ComentarioDeRevision[]) {
      expect(Object.keys(c).sort()).toEqual(
        ['authorDisplayName', 'authorRelation', 'body', 'createdAt', 'id', 'kind', 'origin'].sort(),
      );
    }
  });

  it('lee también las versiones cerradas; Operativo, analista, legal, cliente y otra agencia no leen comentarios', async () => {
    const { versionId } = await nuevaVersion();
    valor(
      await solicitarCambiosDeScript(e.consultor, versionId, { items: [{ body: 'Un cambio leído luego' }] }),
    );
    for (const lector of [e.admin, e.director, e.consultor]) {
      expect(valor(await listarComentariosDeRevision(lector, versionId)).total, lector.role).toBe(1);
    }
    const esperado: [User, string][] = [
      [e.operativo, 'FORBIDDEN_ROLE'],
      [e.analista, 'FORBIDDEN_ROLE'],
      [e.legal, 'FORBIDDEN_ROLE'],
      [e.cliente, 'RESOURCE_NOT_FOUND'],
      [e.ajeno, 'RESOURCE_NOT_FOUND'],
    ];
    for (const [lector, c] of esperado) {
      expect(codigo(await listarComentariosDeRevision(lector, versionId)), lector.role).toBe(c);
    }
  });

  it('ids mal formados y cerco de campaña: «no existe»; límites fuera de rango se acotan', async () => {
    const { versionId } = await nuevaVersion();
    valor(await comentar(versionId, 'Un comentario cualquiera'));
    expect(codigo(await listarComentariosDeRevision(e.consultor, 'no-es-uuid'))).toBe('RESOURCE_NOT_FOUND');
    expect(
      codigo(await listarComentariosDeRevision(e.consultor, versionId, {}, { campaignId: e.otraCampanaId })),
    ).toBe('RESOURCE_NOT_FOUND');
    expect(
      valor(await listarComentariosDeRevision(e.consultor, versionId, {}, { campaignId: e.campanaId })).total,
    ).toBe(1);
    const acotado = valor(
      await listarComentariosDeRevision(e.consultor, versionId, { limite: -5, desde: -9 }),
    );
    expect(acotado.items).toHaveLength(1);
    expect(valor(await listarComentariosDeRevision(e.consultor, versionId, { limite: 100000 })).total).toBe(
      1,
    );
  });
});
