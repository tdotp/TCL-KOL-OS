import { describe, expect, it } from 'vitest';
import type { ModelTurnRequest } from '../contracts.ts';
import {
  GuionAgotadoError,
  ScriptedModel,
  fallo,
  respuestaConTools,
  respuestaFinal,
} from './scripted-model.ts';

const peticion: ModelTurnRequest = { messages: [{ role: 'user', content: 'hola' }], tools: [] };

describe('ScriptedModel', () => {
  it('consume el guion en orden y graba copias de las peticiones', async () => {
    const modelo = new ScriptedModel([
      respuestaConTools([{ name: 'campaign_get', arguments: { x: 1 } }]),
      respuestaFinal('listo'),
    ]);
    const a = await modelo.turn(peticion);
    expect(a.kind).toBe('tool_calls');
    expect(a.content).toBeNull();
    expect(a.toolCalls[0]).toMatchObject({ name: 'campaign_get', arguments: { x: 1 } });
    const b = await modelo.turn(peticion);
    expect(b).toMatchObject({ kind: 'final', content: 'listo', finishReason: 'stop' });
    expect(modelo.requests).toHaveLength(2);
    expect(modelo.requests[0]).toEqual(peticion);
    expect(modelo.requests[0]).not.toBe(peticion);
    expect(modelo.llamadas).toBe(2);
  });

  it('lanza los fallos como ModelError y admite funciones con efectos laterales', async () => {
    let efecto = 0;
    const modelo = new ScriptedModel([
      fallo('MODEL_TIMEOUT', { retryable: true }),
      () => {
        efecto += 1;
        return respuestaFinal('después del efecto');
      },
    ]);
    await expect(modelo.turn(peticion)).rejects.toMatchObject({ code: 'MODEL_TIMEOUT', retryable: true });
    expect((await modelo.turn(peticion)).content).toBe('después del efecto');
    expect(efecto).toBe(1);
  });

  it('un guion agotado es un error explícito', async () => {
    const modelo = new ScriptedModel([]);
    await expect(modelo.turn(peticion)).rejects.toBeInstanceOf(GuionAgotadoError);
  });
});
