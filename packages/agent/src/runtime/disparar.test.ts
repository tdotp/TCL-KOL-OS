/**
 * Disparo en segundo plano y barrido/reintento de abandonados (BD real).
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { closePool, iniciarRun, query } from '@tcl-kol-os/db';
import {
  type EscenarioDeChat,
  crearEscenarioDeChat,
  eliminarCampanaDePrueba,
} from '@tcl-kol-os/db/test-utils';
import { ScriptedModel, respuestaFinal } from '../model/scripted-model.ts';
import { barrerYReintentar, dispararRun, iniciarEnSegundoPlano } from './disparar.ts';
import { FakeToolRegistry } from './testing/fake-tool-registry.ts';
import {
  admitir,
  dependencias,
  entornoDePrueba,
  filaDelRun,
  nuevaConversacion,
  valor,
} from './testing/harness.ts';

let e: EscenarioDeChat;

beforeAll(async () => {
  e = await crearEscenarioDeChat('Agente · disparo');
});
afterEach(async () => {
  await query(`UPDATE users SET status = 'activo' WHERE id = $1`, [e.consultor.id]);
});
afterAll(async () => {
  await eliminarCampanaDePrueba(e.campanas);
  await closePool();
});

async function turno() {
  const entorno = entornoDePrueba();
  const conv = await nuevaConversacion(e.consultor, e.campanaId);
  return { ...(await admitir(e.consultor, conv, 'Hola agente', entorno)), entorno };
}

describe('dispararRun / iniciarEnSegundoPlano', () => {
  it('dispararRun ejecuta el run y devuelve el resultado', async () => {
    const t = await turno();
    const r = await dispararRun(
      e.consultor,
      t.run.id,
      dependencias(new ScriptedModel([respuestaFinal('Hola.')]), new FakeToolRegistry([]), t.entorno),
    );
    expect(r).toMatchObject({ salida: 'completed' });
  });

  it('nunca rechaza: un run inexistente o ajeno devuelve undefined', async () => {
    const t = await turno();
    const deps = dependencias(new ScriptedModel([]), new FakeToolRegistry([]), t.entorno);
    expect(await dispararRun(e.consultor, '00000000-0000-4000-8000-000000000000', deps)).toBeUndefined();
    expect(await dispararRun(e.ajeno, t.run.id, deps)).toBeUndefined();
    expect(await dispararRun(e.consultor, 'no-es-uuid', deps)).toBeUndefined();
  });

  it('iniciarEnSegundoPlano solo programa: el modelo no se llama hasta que corre la tarea (como after())', async () => {
    const t = await turno();
    const modelo = new ScriptedModel([respuestaFinal('En segundo plano.')]);
    const cola: (() => Promise<unknown>)[] = [];
    iniciarEnSegundoPlano(
      (tarea) => void cola.push(tarea),
      e.consultor,
      t.run.id,
      dependencias(modelo, new FakeToolRegistry([]), t.entorno),
    );
    expect(cola).toHaveLength(1);
    expect(modelo.llamadas).toBe(0);
    expect((await filaDelRun(e.consultor, t.run.id)).status).toBe('queued');
    await cola[0]!();
    expect((await filaDelRun(e.consultor, t.run.id)).status).toBe('completed');
  });
});

describe('barrerYReintentar', () => {
  async function huerfano() {
    const t = await turno();
    valor(await iniciarRun(e.consultor, t.run.id, { contextHash: 'a'.repeat(64), contextManifest: {} }));
    await query(`UPDATE agent_runs SET heartbeat_at = now() - interval '30 minutes' WHERE id = $1`, [
      t.run.id,
    ]);
    return t;
  }

  it('latido vencido → RUN_ABANDONED y reintento attempt+1 que se puede disparar hasta completarse', async () => {
    const t = await huerfano();
    const b = await barrerYReintentar(e.consultor, { userMessageId: t.mensaje.id }, { env: t.entorno.env });
    expect(b.abandonados).toBeGreaterThanOrEqual(1);
    expect(await filaDelRun(e.consultor, t.run.id)).toMatchObject({
      status: 'failed',
      errorCode: 'RUN_ABANDONED',
    });

    const nuevo = valor(b.reintento!);
    expect(nuevo).toMatchObject({ status: 'queued', attempt: 2, userMessageId: t.mensaje.id });
    expect(nuevo.provider).toBe('fake');

    const r = await dispararRun(
      e.consultor,
      nuevo.id,
      dependencias(new ScriptedModel([respuestaFinal('Ya sí.')]), new FakeToolRegistry([]), t.entorno),
    );
    expect(r).toMatchObject({ salida: 'completed' });
    // Un turno completado ya no se reintenta (tras la respuesta, el mensaje deja de ser el último).
    const otra = await barrerYReintentar(
      e.consultor,
      { userMessageId: t.mensaje.id },
      { env: t.entorno.env },
    );
    const rechazo = otra.reintento!;
    expect(rechazo.ok).toBe(false);
    if (!rechazo.ok) expect(rechazo.error.details?.['reason']).toBe('message_not_latest');
  });

  it('sin userMessageId solo barre y cuenta', async () => {
    const t = await huerfano();
    const b = await barrerYReintentar(e.consultor, {}, { env: t.entorno.env });
    expect(b.abandonados).toBeGreaterThanOrEqual(1);
    expect(b.reintento).toBeUndefined();
  });

  it('el reloj inyectado decide qué está caducado', async () => {
    const t = await turno(); // queued, recién creado
    const futuro = () => new Date(Date.now() + 20 * 60_000);
    const ahora = await barrerYReintentar(e.consultor, {}, { env: t.entorno.env });
    expect(ahora.abandonados).toBe(0);
    const luego = await barrerYReintentar(e.consultor, {}, { env: t.entorno.env, now: futuro });
    expect(luego.abandonados).toBeGreaterThanOrEqual(1);
    expect(await filaDelRun(e.consultor, t.run.id)).toMatchObject({
      status: 'failed',
      errorCode: 'RUN_ABANDONED',
    });
  });

  it('con la IA apagada o la persona inactiva no se reintenta', async () => {
    const t = await huerfano();
    const apagada = entornoDePrueba({ AI_ENABLED: 'false' });
    const a = await barrerYReintentar(e.consultor, { userMessageId: t.mensaje.id }, { env: apagada.env });
    const ra = a.reintento!;
    expect(ra.ok).toBe(false);
    if (!ra.ok) expect(ra.error.code).toBe('AI_DISABLED');

    await query(`UPDATE users SET status = 'inactivo' WHERE id = $1`, [e.consultor.id]);
    const i = await barrerYReintentar(e.consultor, { userMessageId: t.mensaje.id }, { env: t.entorno.env });
    const ri = i.reintento!;
    expect(ri.ok).toBe(false);
    if (!ri.ok) expect(ri.error.code).toBe('FORBIDDEN_ROLE');
  });
});
