/**
 * V2 · Fase 7 — comentarios de revisión SmartPR (`script_review_comments`): los triggers de la
 * migración 023, atacados por SQL directo. El caso de uso (`script-review.ts`, W2b) los reutiliza;
 * aquí se prueba que la BASE los impone aunque la aplicación o el grounding de la tool fallen.
 *
 *   · autor: una persona de la agencia con script:manage (nunca IA ni sistema);
 *   · versión abierta (received | in_review);
 *   · origen chat ⇒ el texto es una CITA EXACTA de un mensaje del autor (role='user', misma
 *     campaña y organización);
 *   · append-only.
 */

import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ScriptVersionStatus, User } from '@tcl-kol-os/domain';
import { closePool, query, transaction } from './client.ts';
import {
  type EscenarioDeContenido,
  crearEscenarioDeContenido,
  crearFuenteDeGuionDePrueba,
  limpiarEscenarioDeContenido,
} from './test-utils.ts';

let e: EscenarioDeContenido;
let n = 0;

beforeAll(async () => {
  e = await crearEscenarioDeContenido('F7 comentarios');
});
afterAll(async () => {
  await limpiarEscenarioDeContenido(e);
  await closePool();
});

async function rechazo(sql: string, params: unknown[] = []): Promise<string> {
  try {
    await query(sql, params);
    return '';
  } catch (error) {
    return (error as Error).message;
  }
}

async function conBypass(fn: (c: pg.PoolClient) => Promise<void>): Promise<void> {
  await transaction(async (c) => {
    await c.query(`SET LOCAL tclkolos.permitir_borrado_historico = 'on'`);
    await fn(c);
  });
}

/** Versión nueva (de un entregable desechable de Diego), opcionalmente fijada en otro estado. */
async function version(estado: ScriptVersionStatus = 'received'): Promise<string> {
  const [d] = await query<{ id: string }>(
    `INSERT INTO deliverables (organization_id, campaign_id, campaign_influencer_id, label, label_key, created_by)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [
      e.admin.organizationId,
      e.campanaId,
      e.participaciones.diego,
      `Com ${++n}`,
      `com-${n}-${Date.now()}`,
      e.consultor.id,
    ],
  );
  const f = await crearFuenteDeGuionDePrueba(e.campanaId, e.admin, `com-${n}`);
  const [v] = await query<{ id: string }>(
    `INSERT INTO script_versions (organization_id, campaign_id, deliverable_id, source_document_id, created_by)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [e.admin.organizationId, e.campanaId, d!.id, f, e.consultor.id],
  );
  if (estado !== 'received') {
    await conBypass(async (c) => {
      if (estado === 'approved') {
        await c.query(
          `UPDATE script_versions SET status = 'approved', approved_by = $2, approved_at = now() WHERE id = $1`,
          [v!.id, e.director.id],
        );
      } else if (estado === 'superseded') {
        // la sucesora: una versión posterior del mismo entregable
        const f2 = await crearFuenteDeGuionDePrueba(e.campanaId, e.admin, `com-${n}-suc`);
        const [v2] = await c
          .query<{ id: string }>(
            `INSERT INTO script_versions (organization_id, campaign_id, deliverable_id, source_document_id, created_by)
           VALUES ($1, $2, $3, $4, $5) RETURNING id`,
            [e.admin.organizationId, e.campanaId, d!.id, f2, e.consultor.id],
          )
          .then((r) => r.rows);
        await c.query(
          `UPDATE script_versions SET status = 'superseded', superseded_by_version_id = $2, superseded_at = now() WHERE id = $1`,
          [v!.id, v2!.id],
        );
      } else {
        await c.query(`UPDATE script_versions SET status = $2 WHERE id = $1`, [v!.id, estado]);
      }
    });
  }
  return v!.id;
}

const COMENTAR = `INSERT INTO script_review_comments (organization_id, campaign_id, script_version_id, author_id, kind, body, origin, chat_message_id)
                  VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`;
const comentar = (
  versionId: string,
  over: Partial<{
    org: string;
    campana: string;
    autor: string | null;
    kind: string;
    body: string;
    origin: string;
    mensaje: string | null;
  }> = {},
) =>
  rechazo(COMENTAR, [
    over.org ?? e.admin.organizationId,
    over.campana ?? e.campanaId,
    versionId,
    over.autor === undefined ? e.consultor.id : over.autor,
    over.kind ?? 'editorial',
    over.body ?? 'Revisar el tono de la apertura',
    over.origin ?? 'ui',
    over.mensaje ?? null,
  ]);

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

/** Un mensaje del ASISTENTE (que también lleva el user_id de la persona) para un run en ejecución. */
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

describe('autor: una persona de la agencia con script:manage', () => {
  it('sin autor (NULL) no hay comentario: IA y sistema no pueden firmar', async () => {
    const v = await version();
    // (el trigger BEFORE responde antes que el NOT NULL; ambos impiden un autor ausente)
    expect(await comentar(v, { autor: null })).toMatch(/null|author_id|no puede ejecutar/i);
  });

  it('admin, director y consultor comentan; operativo, analista, legal, cliente y otra agencia, no', async () => {
    const v = await version();
    for (const autor of [e.admin, e.director, e.consultor]) {
      expect(await comentar(v, { autor: autor.id }), autor.role).toBe('');
    }
    for (const intruso of [e.operativo, e.analista, e.legal, e.cliente, e.ajeno]) {
      expect(await comentar(v, { autor: intruso.id }), intruso.role).not.toBe('');
    }
  });

  it('un autor de otra organización lo rechaza la FK compuesta', async () => {
    const v = await version();
    expect(await comentar(v, { autor: e.ajeno.id })).not.toBe('');
  });
});

describe('forma del comentario', () => {
  it('tipo y origen cerrados: ni «system» ni tipos inventados', async () => {
    const v = await version();
    expect(await comentar(v, { origin: 'system' })).toMatch(/origen_valido|check/);
    expect(await comentar(v, { origin: 'ai' })).toMatch(/origen_valido|check/);
    expect(await comentar(v, { kind: 'resuelto' })).toMatch(/tipo_valido|check/);
    expect(await comentar(v, { kind: 'editorial' })).toBe('');
    expect(await comentar(v, { kind: 'change_request' })).toBe('');
  });

  it('el cuerpo no puede ser vacío ni superar 2000 caracteres', async () => {
    const v = await version();
    expect(await comentar(v, { body: '' })).toMatch(/cuerpo_valido|check/);
    expect(await comentar(v, { body: '   ' })).toMatch(/cuerpo_valido|check/);
    expect(await comentar(v, { body: 'x'.repeat(2001) })).toMatch(/cuerpo_valido|check/);
    expect(await comentar(v, { body: 'x'.repeat(2000) })).toBe('');
  });

  it('el localizador, si viene, cumple el contrato de localizadores (source_locator_valido)', async () => {
    const v = await version();
    const conLocalizador = (loc: string) =>
      rechazo(
        `INSERT INTO script_review_comments (organization_id, campaign_id, script_version_id, author_id, kind, body, origin, locator)
         VALUES ($1, $2, $3, $4, 'editorial', 'con localizador', 'ui', $5::jsonb)`,
        [e.admin.organizationId, e.campanaId, v, e.consultor.id, loc],
      );
    expect(await conLocalizador('{"kind": "inventado"}')).toMatch(/locator_valido|check/);
    expect(await conLocalizador('"texto"')).toMatch(/locator_valido|check/);
  });
});

describe('versión abierta (received | in_review)', () => {
  it('solo se comenta una versión recibida o en revisión', async () => {
    for (const estado of ['received', 'in_review'] as const) {
      expect(await comentar(await version(estado)), estado).toBe('');
    }
    for (const estado of ['changes_requested', 'approved', 'superseded'] as const) {
      expect(await comentar(await version(estado)), estado).toMatch(/no admite comentarios/);
    }
  });

  it('la versión debe ser de la misma campaña y organización (FK compuesta)', async () => {
    const v = await version();
    expect(await comentar(v, { campana: e.otraCampanaId })).not.toBe('');
    expect(await comentar(v, { org: e.ajeno.organizationId })).not.toBe('');
    expect(await comentar('99999999-9999-4999-8999-999999999999')).not.toBe('');
  });
});

describe('origen chat: el texto es una cita EXACTA de un mensaje de la persona', () => {
  it('origen chat sin mensaje, o mensaje con origen ui, lo rechaza el CHECK', async () => {
    const v = await version();
    expect(await comentar(v, { origin: 'chat', mensaje: null })).toMatch(
      /mensaje_coherente|check|mensaje del autor/,
    );
    const conv = await conversacion(e.consultor);
    const m = await mensajeDeUsuario(conv, e.consultor, 'Revisar el tono de la apertura, por favor');
    expect(await comentar(v, { origin: 'ui', mensaje: m })).toMatch(/mensaje_coherente|check/);
  });

  it('la subcadena exacta del mensaje del autor pasa; con otra capitalización, otro texto o empalmando dos mensajes, no', async () => {
    const v = await version();
    const conv = await conversacion(e.consultor);
    const m1 = await mensajeDeUsuario(conv, e.consultor, 'Anota esto: el cierre promete demasiado.');
    // el trigger de mensajes admite el siguiente solo sin run activo: no hay runs en esta conversación
    const m2 = await mensajeDeUsuario(conv, e.consultor, 'Y también cambia la mención al precio.');
    expect(await comentar(v, { origin: 'chat', mensaje: m1, body: 'el cierre promete demasiado' })).toBe('');
    expect(await comentar(v, { origin: 'chat', mensaje: m1, body: 'EL CIERRE PROMETE DEMASIADO' })).toMatch(
      /cita exacta/,
    );
    expect(await comentar(v, { origin: 'chat', mensaje: m1, body: 'el cierre exagera' })).toMatch(
      /cita exacta/,
    );
    expect(
      await comentar(v, {
        origin: 'chat',
        mensaje: m1,
        body: 'el cierre promete demasiado. Y también cambia',
      }),
    ).toMatch(/cita exacta/);
    expect(await comentar(v, { origin: 'chat', mensaje: m2, body: 'cambia la mención al precio' })).toBe('');
  });

  it('un mensaje del ASISTENTE (aunque lleve el user_id de la persona) no vale', async () => {
    const v = await version();
    const asistente = await mensajeDeAsistente(
      e.consultor,
      'Sugiero eliminar la frase de garantía de por vida',
    );
    expect(
      await comentar(v, {
        origin: 'chat',
        mensaje: asistente,
        body: 'eliminar la frase de garantía de por vida',
      }),
    ).toMatch(/mensaje del autor|asistente/);
  });

  it('un mensaje de OTRA persona, de otra campaña o inexistente no vale', async () => {
    const v = await version();
    const deOtra = await mensajeDeUsuario(
      await conversacion(e.director),
      e.director,
      'El director dice: recortar el guion',
    );
    expect(await comentar(v, { origin: 'chat', mensaje: deOtra, body: 'recortar el guion' })).toMatch(
      /mensaje del autor/,
    );
    // la misma persona, pero un mensaje de una conversación de OTRA campaña
    const enOtraCampana = await mensajeDeUsuario(
      await conversacion(e.consultor, e.otraCampanaId),
      e.consultor,
      'En la otra campaña: usar tono formal',
      e.otraCampanaId,
    );
    expect(await comentar(v, { origin: 'chat', mensaje: enOtraCampana, body: 'usar tono formal' })).toMatch(
      /mensaje del autor|esta campaña/,
    );
    expect(
      await comentar(v, {
        origin: 'chat',
        mensaje: '99999999-9999-4999-8999-999999999999',
        body: 'lo que sea',
      }),
    ).not.toBe('');
  });
});

describe('append-only', () => {
  it('un comentario no se modifica ni se borra', async () => {
    const v = await version();
    expect(await comentar(v, { body: 'Comentario fijo' })).toBe('');
    expect(
      await rechazo(`UPDATE script_review_comments SET body = 'editado' WHERE script_version_id = $1`, [v]),
    ).toMatch(/append-only/);
    expect(
      await rechazo(
        `UPDATE script_review_comments SET kind = 'change_request' WHERE script_version_id = $1`,
        [v],
      ),
    ).toMatch(/append-only/);
    expect(await rechazo(`DELETE FROM script_review_comments WHERE script_version_id = $1`, [v])).toMatch(
      /append-only/,
    );
    const [fila] = await query<{ body: string }>(
      `SELECT body FROM script_review_comments WHERE script_version_id = $1`,
      [v],
    );
    expect(fila?.body).toBe('Comentario fijo');
  });

  it('una versión con comentarios no se puede borrar (RESTRICT) y la limpieza de pruebas sí los retira primero', async () => {
    const v = await version();
    await comentar(v);
    await expect(
      conBypass(async (c) => {
        await c.query(`DELETE FROM script_versions WHERE id = $1`, [v]);
      }),
    ).rejects.toThrow(/foreign key|violates/);
  });
});
