/**
 * V2 · Fase 1C — auditoría con origen.
 *
 * `audit_events` sigue siendo el único registro y sigue siendo de solo
 * inserción. Se le añade `origin` (ui | chat | system) y una correlación
 * opcional y genérica (sin FK a conversaciones/mensajes que aún no existen).
 * Los eventos históricos no se reescriben: conservan origen NULL.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { User } from '@tcl-kol-os/domain';
import { closePool, getPool, query, transaction } from './client.ts';
import { listAudit, recordAudit, resolveOrigin, sanitizeCorrelation } from './audit.ts';
import { findUserByEmail } from './users.ts';
import { eliminarCampanaDePrueba } from './test-utils.ts';
import { setSourceVisibility } from './sources.ts';

let admin: User;
let campaignId: string;
let fuenteId: string;

async function ultimoEvento(entityId: string, action: string) {
  const [fila] = await query<{ origin: string | null; correlation: unknown; actor_id: string | null }>(
    `SELECT origin, correlation, actor_id FROM audit_events
      WHERE entity_id = $1 AND action = $2 ORDER BY created_at DESC LIMIT 1`,
    [entityId, action],
  );
  return fila!;
}

beforeAll(async () => {
  admin = (await findUserByEmail('gerardo@smartpr.co'))!;
  const [c] = await query<{ id: string }>(
    `INSERT INTO campaigns (organization_id, name, owner_id, created_by)
     VALUES ($1, $2, $3, $3) RETURNING id`,
    [admin.organizationId, `Origen de auditoría · ${Date.now()}`, admin.id],
  );
  campaignId = c!.id;
  const [f] = await query<{ id: string }>(
    `INSERT INTO source_documents
       (campaign_id, organization_id, type, filename, file_id, mime_type, size_bytes, hash, status, created_by)
     VALUES ($1, $2, 'otro', 'a.md', 'test/a.md', 'text/markdown', 10, $3, 'procesado', $4) RETURNING id`,
    [campaignId, admin.organizationId, `hash-origen-${Date.now()}`, admin.id],
  );
  fuenteId = f!.id;
});

afterAll(async () => {
  await eliminarCampanaDePrueba(campaignId);
  await closePool();
});

describe('origen registrado en eventos nuevos', () => {
  it('una acción de persona en la interfaz queda con origen ui', async () => {
    await setSourceVisibility(admin, fuenteId, 'tcl');
    const evento = await ultimoEvento(fuenteId, 'source.set_visibility');
    expect(evento.origin).toBe('ui');
    expect(evento.actor_id).toBe(admin.id);
    expect(evento.correlation).toBeNull();
  });

  it('una acción del sistema queda con origen system y sin actor humano', async () => {
    await transaction(async (client) => {
      await recordAudit(client, {
        actor: 'system',
        organizationId: admin.organizationId,
        action: 'test.sistema',
        entityType: 'source_document',
        entityId: fuenteId,
      });
    });
    const evento = await ultimoEvento(fuenteId, 'test.sistema');
    expect(evento.origin).toBe('system');
    expect(evento.actor_id).toBeNull();
  });

  it('el contrato admite chat y correlación aunque todavía no exista el chat', async () => {
    await transaction(async (client) => {
      await recordAudit(client, {
        actor: admin,
        action: 'test.chat',
        entityType: 'source_document',
        entityId: fuenteId,
        origin: 'chat',
        correlation: { conversationId: 'conv-1', messageId: 'msg-9', agentRunId: 'run-3' },
      });
    });
    const evento = await ultimoEvento(fuenteId, 'test.chat');
    expect(evento.origin).toBe('chat');
    expect(evento.correlation).toEqual({ conversationId: 'conv-1', messageId: 'msg-9', agentRunId: 'run-3' });
  });
});

describe('coherencia entre actor y origen', () => {
  it('una persona no puede quedar registrada como system, ni el sistema como ui/chat', () => {
    expect(() => resolveOrigin(admin, 'system')).toThrow();
    expect(() => resolveOrigin('system', 'ui')).toThrow();
    expect(() => resolveOrigin('system', 'chat')).toThrow();
    expect(resolveOrigin(admin, undefined)).toBe('ui');
    expect(resolveOrigin('system', undefined)).toBe('system');
    expect(resolveOrigin(admin, 'chat')).toBe('chat');
  });

  it('la correlación solo conserva claves conocidas con valor de texto', () => {
    expect(sanitizeCorrelation(undefined)).toBeNull();
    expect(sanitizeCorrelation({})).toBeNull();
    expect(sanitizeCorrelation({ messageId: 'm', extra: 'x', conversationId: 5 } as never)).toEqual({
      messageId: 'm',
    });
  });

  it('la base rechaza un origen inválido', async () => {
    await expect(
      query(
        `INSERT INTO audit_events (organization_id, action, entity_type, origin)
         VALUES ($1, 'test.invalido', 'x', 'telepatia')`,
        [admin.organizationId],
      ),
    ).rejects.toThrow();
  });
});

describe('eventos históricos', () => {
  it('un evento sin origen (anterior a V2) sigue siendo legible, con origen null', async () => {
    const [legado] = await query<{ id: string }>(
      `INSERT INTO audit_events (organization_id, actor_id, action, entity_type, entity_id, metadata)
       VALUES ($1, $2, 'test.legado', 'source_document', $3, '{}'::jsonb) RETURNING id`,
      [admin.organizationId, admin.id, fuenteId],
    );
    const eventos = await listAudit(getPool(), admin.organizationId, 500);
    const leido = eventos.find((e) => e.id === legado!.id);
    expect(leido).toBeDefined();
    expect(leido!.origin).toBeNull();
    expect(leido!.correlation).toBeNull();
    expect(leido!.action).toBe('test.legado');
  });
});

describe('append-only intacto', () => {
  it('no se puede actualizar ni borrar un evento, ni siquiera su origen', async () => {
    const [e] = await query<{ id: string }>(
      `SELECT id FROM audit_events WHERE entity_id = $1 AND action = 'test.chat'`,
      [fuenteId],
    );
    await expect(query(`UPDATE audit_events SET origin = 'ui' WHERE id = $1`, [e!.id])).rejects.toThrow();
    await expect(
      query(`UPDATE audit_events SET correlation = '{}'::jsonb WHERE id = $1`, [e!.id]),
    ).rejects.toThrow();
    await expect(query(`DELETE FROM audit_events WHERE id = $1`, [e!.id])).rejects.toThrow();
  });

  it('la metadata sigue saneándose', async () => {
    await transaction(async (client) => {
      await recordAudit(client, {
        actor: admin,
        action: 'test.sanea',
        entityType: 'source_document',
        entityId: fuenteId,
        metadata: { token: 'abc', ok: 1 },
      });
    });
    const [fila] = await query<{ metadata: Record<string, unknown> }>(
      `SELECT metadata FROM audit_events WHERE entity_id = $1 AND action = 'test.sanea'`,
      [fuenteId],
    );
    expect(fila!.metadata).toEqual({ token: '[redactado]', ok: 1 });
  });
});
