/**
 * Admisión de un turno (BD real): kill-switch, persona vigente, idempotencia, concurrencia.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { closePool, query } from '@tcl-kol-os/db';
import {
  type EscenarioDeChat,
  crearEscenarioDeChat,
  eliminarCampanaDePrueba,
} from '@tcl-kol-os/db/test-utils';
import { admitirTurno } from './admitir-turno.ts';
import { configuracionDeRun } from './config.ts';
import { PROMPT_VERSION } from '../prompts/agente-cuenta.ts';
import {
  claveDeMensaje,
  entornoDePrueba,
  mensajesDeLaConversacion,
  nuevaConversacion,
  valor,
} from './testing/harness.ts';

let e: EscenarioDeChat;

beforeAll(async () => {
  e = await crearEscenarioDeChat('Agente · admisión');
});

afterEach(async () => {
  await query(`UPDATE users SET status = 'activo' WHERE id = $1`, [e.consultor.id]);
});

afterAll(async () => {
  await eliminarCampanaDePrueba(e.campanas);
  await closePool();
});

const entrada = (conversationId: string, extra: Record<string, unknown> = {}) => ({
  conversationId,
  content: 'Resume el estado del brief',
  clientMessageId: claveDeMensaje(),
  ...extra,
});

describe('admitirTurno', () => {
  it('con la IA encendida crea el mensaje y el run en cola con la configuración verificable', async () => {
    const ent = entornoDePrueba();
    const conv = await nuevaConversacion(e.consultor, e.campanaId);
    const r = valor(await admitirTurno(e.consultor, entrada(conv), { env: ent.env }));
    expect(r.replayed).toBe(false);
    expect(r.message).toMatchObject({
      role: 'user',
      content: 'Resume el estado del brief',
      userId: e.consultor.id,
    });
    expect(r.run).toMatchObject({
      status: 'queued',
      attempt: 1,
      provider: 'fake',
      model: 'modelo-de-prueba/equilibrado',
      tier: 'equilibrado',
      promptVersion: PROMPT_VERSION,
    });
    expect({
      provider: r.run.provider,
      model: r.run.model,
      tier: r.run.tier,
      promptVersion: r.run.promptVersion,
      contextVersion: r.run.contextVersion,
    }).toEqual(configuracionDeRun(ent.env));
  });

  it('con la IA apagada devuelve AI_DISABLED y NO persiste mensaje ni run', async () => {
    const ent = entornoDePrueba({ AI_ENABLED: 'false' });
    const conv = await nuevaConversacion(e.consultor, e.campanaId);
    const r = await admitirTurno(e.consultor, entrada(conv), { env: ent.env });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('AI_DISABLED');
    expect(await mensajesDeLaConversacion(conv)).toHaveLength(0);
    const filas = await query<{ n: string }>(
      `SELECT count(*) AS n FROM agent_runs WHERE conversation_id = $1`,
      [conv],
    );
    expect(filas[0]?.n).toBe('0');
    // Sin variable definida también está apagada.
    const sin = await admitirTurno(e.consultor, entrada(conv), {
      env: entornoDePrueba({ AI_ENABLED: undefined }).env,
    });
    expect(sin.ok).toBe(false);
  });

  it('es idempotente por clientMessageId: el reenvío devuelve el mismo mensaje y run', async () => {
    const ent = entornoDePrueba();
    const conv = await nuevaConversacion(e.consultor, e.campanaId);
    const datos = entrada(conv);
    const a = valor(await admitirTurno(e.consultor, datos, { env: ent.env }));
    const b = valor(await admitirTurno(e.consultor, datos, { env: ent.env }));
    expect(b.replayed).toBe(true);
    expect(b.message.id).toBe(a.message.id);
    expect(b.run.id).toBe(a.run.id);
    expect(await mensajesDeLaConversacion(conv)).toHaveLength(1);
  });

  it('la misma clave con otro contenido es un conflicto, no un reenvío', async () => {
    const ent = entornoDePrueba();
    const conv = await nuevaConversacion(e.consultor, e.campanaId);
    const datos = entrada(conv);
    valor(await admitirTurno(e.consultor, datos, { env: ent.env }));
    const r = await admitirTurno(e.consultor, { ...datos, content: 'Otra cosa distinta' }, { env: ent.env });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.details?.['reason']).toBe('client_message_id_reused');
  });

  it('dos admisiones concurrentes en la misma conversación: una gana, la otra run_in_progress', async () => {
    const ent = entornoDePrueba();
    const conv = await nuevaConversacion(e.consultor, e.campanaId);
    const [a, b] = await Promise.all([
      admitirTurno(e.consultor, entrada(conv, { content: 'Primero' }), { env: ent.env }),
      admitirTurno(e.consultor, entrada(conv, { content: 'Segundo' }), { env: ent.env }),
    ]);
    const ganadoras = [a, b].filter((r) => r.ok);
    const perdedoras = [a, b].filter((r) => !r.ok);
    expect(ganadoras).toHaveLength(1);
    expect(perdedoras).toHaveLength(1);
    const perdedora = perdedoras[0]!;
    if (!perdedora.ok) {
      expect(perdedora.error.code).toBe('RESOURCE_CONFLICT');
      expect(perdedora.error.details?.['reason']).toBe('run_in_progress');
    }
    expect(await mensajesDeLaConversacion(conv)).toHaveLength(1);
  });

  it('un rol sin chat (operativo, cliente) recibe FORBIDDEN_ROLE y no se persiste nada', async () => {
    const ent = entornoDePrueba();
    const conv = await nuevaConversacion(e.consultor, e.campanaId);
    for (const persona of [e.operativo, e.cliente, e.analista, e.legal]) {
      const r = await admitirTurno(persona, entrada(conv), { env: ent.env });
      expect(r.ok, persona.role).toBe(false);
      if (!r.ok) expect(r.error.code, persona.role).toBe('FORBIDDEN_ROLE');
    }
    expect(await mensajesDeLaConversacion(conv)).toHaveLength(0);
  });

  it('la persona se RELEE de la base: una sesión vieja de un usuario ya inactivo no admite', async () => {
    const ent = entornoDePrueba();
    const conv = await nuevaConversacion(e.consultor, e.campanaId);
    await query(`UPDATE users SET status = 'inactivo' WHERE id = $1`, [e.consultor.id]);
    const r = await admitirTurno(e.consultor /* el objeto de sesión aún dice «activo» */, entrada(conv), {
      env: ent.env,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('FORBIDDEN_ROLE');
    expect(await mensajesDeLaConversacion(conv)).toHaveLength(0);
  });

  it('la conversación de otra persona u otra organización no se admite (sin revelar que existe)', async () => {
    const ent = entornoDePrueba();
    const conv = await nuevaConversacion(e.consultor, e.campanaId);
    for (const intruso of [e.admin, e.director, e.ajeno]) {
      const r = await admitirTurno(intruso, entrada(conv), { env: ent.env });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('RESOURCE_NOT_FOUND');
    }
    expect(await mensajesDeLaConversacion(conv)).toHaveLength(0);
  });
});
