/**
 * QA adversarial · vector 9: cancelación en carrera con el runtime real. Tras `cancel_requested` no se
 * llama otra vez al modelo, no se ejecuta ninguna tool y no se publica respuesta. BD real (base `_test`).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cancelarRun, closePool, derivarNonce, query } from '@tcl-kol-os/db';
import {
  type EscenarioDeChat,
  crearEscenarioDeChat,
  eliminarCampanaDePrueba,
} from '@tcl-kol-os/db/test-utils';
import { ScriptedModel, respuestaConTools, respuestaFinal } from '../model/scripted-model.ts';
import { ejecutarRun } from '../runtime/ejecutar-run.ts';
import {
  SECRETO_DE_PRUEBA,
  admitir,
  dependencias,
  entornoDePrueba,
  filaDelRun,
  mensajesDeLaConversacion,
  nuevaConversacion,
  valor,
} from '../runtime/testing/harness.ts';
import { createToolRegistry } from '../tools/registry.ts';
import { contar, nuevaCampana } from './testing/harness.ts';

let e: EscenarioDeChat;
const registry = createToolRegistry({
  nonceForRun: (runId) => derivarNonce(SECRETO_DE_PRUEBA, runId),
  onUnexpectedError: () => undefined,
});

beforeAll(async () => {
  e = await crearEscenarioDeChat('QA cancelación');
});
afterAll(async () => {
  await eliminarCampanaDePrueba(e.campanas);
  await closePool();
});

describe('V9 · cancelación en carrera con el runtime', () => {
  it('cancelar MIENTRAS el modelo piensa: las tools que devuelve NO se ejecutan, no hay mensaje del asistente y el run queda cancelled', async () => {
    const campana = await nuevaCampana(e.admin.organizationId, e.admin.id, 'Cancel 1', e.campanas);
    const ent = entornoDePrueba();
    const conv = await nuevaConversacion(e.consultor, campana);
    const t = await admitir(e.consultor, conv, 'Ponle de nombre "Nombre Cancelado"', ent);
    const modelo = new ScriptedModel([
      async () => {
        valor(await cancelarRun(e.consultor, t.run.id));
        return respuestaConTools([
          {
            id: 'c1',
            name: 'campaign_update_metadata',
            arguments: { name: 'Nombre Cancelado', evidenceQuote: 'Ponle de nombre' },
          },
        ]);
      },
      respuestaFinal('no debería llegar'),
    ]);
    const r = valor(await ejecutarRun(e.consultor, t.run.id, dependencias(modelo, registry, ent)));
    expect(r.salida).toBe('cancelled');
    expect(modelo.llamadas).toBe(1);
    expect((await filaDelRun(e.consultor, t.run.id)).status).toBe('cancelled');
    const [c] = await query<{ name: string }>(`SELECT name FROM campaigns WHERE id = $1`, [campana]);
    expect(c!.name).not.toBe('Nombre Cancelado');
    expect(await contar('agent_tool_invocations WHERE agent_run_id = $1', [t.run.id])).toBe(0);
    expect((await mensajesDeLaConversacion(conv)).filter((m) => m.role === 'assistant')).toHaveLength(0);
  });

  it('cancelar a mitad de un paso con 3 tools: la primera corre, las demás no; cancelar ANTES de la respuesta final impide publicarla', async () => {
    const campana = await nuevaCampana(e.admin.organizationId, e.admin.id, 'Cancel 2', e.campanas);
    const ent = entornoDePrueba();
    const conv = await nuevaConversacion(e.consultor, campana);
    const t = await admitir(e.consultor, conv, 'Consulta tres cosas', ent);
    let primera = true;
    const espia = {
      catalogHash: registry.catalogHash,
      definitionsFor: registry.definitionsFor.bind(registry),
      execute: async (call: Parameters<typeof registry.execute>[0]) => {
        const x = await registry.execute(call);
        if (primera) {
          primera = false;
          valor(await cancelarRun(e.consultor, t.run.id));
        }
        return x;
      },
    };
    const modelo = new ScriptedModel([
      respuestaConTools([
        { id: 'k1', name: 'campaign_get' },
        { id: 'k2', name: 'source_list' },
        { id: 'k3', name: 'brief_get_workspace' },
      ]),
      respuestaFinal('no debería llegar'),
    ]);
    const r = valor(await ejecutarRun(e.consultor, t.run.id, dependencias(modelo, espia, ent)));
    expect(r.salida).toBe('cancelled');
    expect(await contar('agent_tool_invocations WHERE agent_run_id = $1', [t.run.id])).toBe(1);
    expect((await mensajesDeLaConversacion(conv)).filter((m) => m.role === 'assistant')).toHaveLength(0);

    // respuesta final con la cancelación pedida justo antes de publicar
    const conv2 = await nuevaConversacion(e.consultor, campana);
    const t2 = await admitir(e.consultor, conv2, 'Hola', ent);
    const m2 = new ScriptedModel([
      async () => {
        valor(await cancelarRun(e.consultor, t2.run.id));
        return respuestaFinal('Respuesta que no debe publicarse');
      },
    ]);
    const r2 = valor(await ejecutarRun(e.consultor, t2.run.id, dependencias(m2, registry, ent)));
    expect(r2.salida).toBe('cancelled');
    expect((await mensajesDeLaConversacion(conv2)).filter((m) => m.role === 'assistant')).toHaveLength(0);
  });
});
