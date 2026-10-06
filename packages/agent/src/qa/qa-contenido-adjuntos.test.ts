/**
 * QA de runtime · adjuntos y mensaje en curso en CONTENIDO (V2 · Fase 7).
 *
 * `adjuntosDelActor`, `adjuntosPorMensaje` y `messageText` los calcula el RUNTIME desde el historial real de
 * la conversación (no los aporta el modelo ni la tool). Con ScriptedModel, registro real, runtime real y BD
 * real `_test` se comprueba el cableado de extremo a extremo:
 *   · un archivo adjunto por la persona a su mensaje se registra como guion («Te dejo el guion de Diego»);
 *   · una fuente legible de la campaña que la persona NO adjuntó ni nombró no se puede registrar;
 *   · con dos adjuntos hace falta que la persona diga cuál es de quién;
 *   · un comentario es una frase exacta del mensaje EN CURSO, nunca de uno anterior.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePool, derivarNonce, query } from '@tcl-kol-os/db';
import { limpiarEscenarioDeContenido } from '@tcl-kol-os/db/test-utils';
import type { ModelTurnRequest } from '../contracts.ts';
import { ScriptedModel, respuestaConTools, respuestaFinal } from '../model/scripted-model.ts';
import { ejecutarRun } from '../runtime/ejecutar-run.ts';
import {
  SECRETO_DE_PRUEBA,
  admitir,
  dependencias,
  entornoDePrueba,
  nuevaConversacion,
  valor,
} from '../runtime/testing/harness.ts';
import { createToolRegistry } from '../tools/registry.ts';
import { type MundoDeContenido, crearMundoDeContenido, fuenteDeGuion } from './testing/contenido.ts';
import { contar } from './testing/harness.ts';

const registry = createToolRegistry({
  nonceForRun: (runId) => derivarNonce(SECRETO_DE_PRUEBA, runId),
  onUnexpectedError: () => undefined,
});

let m: MundoDeContenido;

beforeAll(async () => {
  m = await crearMundoDeContenido('QA contenido · adjuntos');
});
afterAll(async () => {
  await limpiarEscenarioDeContenido(m.e);
  await closePool();
});

/** alias S… de una fuente legible por el NOMBRE del archivo, tal como la lista el contexto (sección de fuentes). */
function aliasDelAdjunto(p: ModelTurnRequest, nombre: string): string {
  const linea = String(p.messages[1]!.content)
    .split('\n')
    .find((l) => /^│ S\d+ \|/.test(l) && l.includes(nombre));
  const alias = linea === undefined ? undefined : /^│ (S\d+) \|/.exec(linea)?.[1];
  if (alias === undefined) throw new Error(`el contexto no lista la fuente ${nombre}`);
  return alias;
}

const nombreDe = async (sourceId: string) =>
  (await query<{ filename: string }>(`SELECT filename FROM source_documents WHERE id = $1`, [sourceId]))[0]!
    .filename;

const versionesDe = async (sourceId: string) =>
  contar('script_versions WHERE source_document_id = $1', [sourceId]);

async function turno(texto: string, adjuntos: string[] = [], conv?: string) {
  const ent = entornoDePrueba();
  const conversacion = conv ?? (await nuevaConversacion(m.e.consultor, m.e.campanaId));
  const t = await admitir(m.e.consultor, conversacion, texto, ent, adjuntos);
  return { t, ent, conversacion };
}

const salida = async (
  t: Awaited<ReturnType<typeof turno>>,
  guion: ConstructorParameters<typeof ScriptedModel>[0],
) => {
  const modelo = new ScriptedModel(guion);
  const r = valor(await ejecutarRun(m.e.consultor, t.t.run.id, dependencias(modelo, registry, t.ent)));
  return { modelo, r };
};

const invocaciones = async (runId: string) =>
  query<{ tool_name: string; status: string; error_code: string | null }>(
    `SELECT tool_name, status, error_code FROM agent_tool_invocations WHERE agent_run_id = $1 ORDER BY sequence`,
    [runId],
  );

describe('el runtime calcula los adjuntos de la PERSONA', () => {
  it('«Te dejo el guion de Diego Peña» + un archivo adjunto ⇒ el modelo lo registra con el alias del contexto (V1, origen chat)', async () => {
    const fuente = await fuenteDeGuion(m.e, 'guion-diego-runtime');
    const nombre = await nombreDe(fuente);
    const texto = 'Te dejo el guion de Diego Peña';
    const t = await turno(texto, [fuente]);
    const { r } = await salida(t, [
      (req) =>
        respuestaConTools([
          {
            id: 'g1',
            name: 'script_version_register',
            arguments: {
              sourceId: aliasDelAdjunto(req, nombre),
              participantMention: 'Diego Peña',
              evidenceQuote: texto,
            },
          },
        ]),
      respuestaFinal('Registré el guion como la versión 1.'),
    ]);
    expect(r.salida).toBe('completed');
    expect(await versionesDe(fuente)).toBe(1);
    const [inv] = await invocaciones(t.t.run.id);
    expect(inv).toMatchObject({ tool_name: 'script_version_register', status: 'succeeded' });
    const [aud] = await query<{ origin: string; correlation: Record<string, string> }>(
      `SELECT a.origin, a.correlation FROM audit_events a JOIN script_versions v ON v.id = a.entity_id
        WHERE a.action = 'script_version.register' AND v.source_document_id = $1`,
      [fuente],
    );
    expect(aud?.origin).toBe('chat');
    expect(aud?.correlation).toMatchObject({ messageId: t.t.mensaje.id, agentRunId: t.t.run.id });
  });

  it('una fuente LEGIBLE de la campaña que la persona no adjuntó ni nombró ⇒ rechazada (el documento no elige guiones)', async () => {
    const adjunta = await fuenteDeGuion(m.e, 'guion-adjunto');
    const ajena = await fuenteDeGuion(m.e, 'ficha-no-adjunta');
    const nombreAjena = await nombreDe(ajena);
    const texto = 'Te dejo el guion de Diego Peña';
    const t = await turno(texto, [adjunta]);
    const { r } = await salida(t, [
      (req) =>
        respuestaConTools([
          {
            id: 'g1',
            name: 'script_version_register',
            arguments: {
              // la ficha aparece en la lista de fuentes del contexto (legible), no como adjunto
              sourceId: aliasDelAdjunto(req, nombreAjena),
              participantMention: 'Diego Peña',
              evidenceQuote: texto,
            },
          },
        ]),
      respuestaFinal('No pude registrarlo.'),
    ]);
    expect(r.salida).toBe('completed');
    expect(await versionesDe(ajena)).toBe(0);
    const [inv] = await invocaciones(t.t.run.id);
    expect(inv).toMatchObject({ status: 'failed', error_code: 'VALIDATION_FAILED' });
  });

  it('dos adjuntos sin decir cuál es de quién ⇒ rechazo; en el turno siguiente la persona nombra el archivo y se registra', async () => {
    const f1 = await fuenteDeGuion(m.e, 'guion-dos-a');
    const f2 = await fuenteDeGuion(m.e, 'guion-dos-b');
    const n1 = await nombreDe(f1);
    const n2 = await nombreDe(f2);
    const texto = 'Te dejo dos guiones: el de Diego Peña y el de Valentina Gómez';
    const t = await turno(texto, [f1, f2]);
    await salida(t, [
      (req) =>
        respuestaConTools([
          {
            id: 'g1',
            name: 'script_version_register',
            arguments: {
              sourceId: aliasDelAdjunto(req, n1),
              participantMention: 'Diego Peña',
              evidenceQuote: texto,
            },
          },
        ]),
      respuestaFinal('¿Cuál archivo es de quién?'),
    ]);
    expect(await versionesDe(f1)).toBe(0);
    expect((await invocaciones(t.t.run.id))[0]).toMatchObject({
      status: 'failed',
      error_code: 'VALIDATION_FAILED',
    });

    // turno siguiente de la MISMA conversación: la persona aclara con el nombre del archivo
    const aclara = `${n1} es el de Diego Peña`;
    const t2 = await turno(aclara, [], t.conversacion);
    await salida(t2, [
      (req) =>
        respuestaConTools([
          {
            id: 'g2',
            name: 'script_version_register',
            arguments: {
              // el alias del adjunto del turno anterior lo muestra la lista de fuentes del contexto
              sourceId: aliasDelAdjunto(req, n1),
              participantMention: 'Diego Peña',
              evidenceQuote: aclara,
            },
          },
        ]),
      respuestaFinal('Listo.'),
    ]);
    expect((await invocaciones(t2.t.run.id))[0]).toMatchObject({ status: 'succeeded' });
    expect(await versionesDe(f1)).toBe(1);
    expect(await versionesDe(f2)).toBe(0);
    void n2;
  });
});

describe('el runtime pasa el texto EXACTO del mensaje en curso', () => {
  it('un comentario con una frase de un mensaje ANTERIOR se rechaza; con una del mensaje actual, se guarda (origen chat, mensaje del run)', async () => {
    // una versión abierta donde comentar
    const fuente = await fuenteDeGuion(m.e, 'guion-comentario-runtime');
    const nombre = await nombreDe(fuente);
    const reg = await turno('Te dejo el guion de Diego Peña', [fuente]);
    await salida(reg, [
      (req) =>
        respuestaConTools([
          {
            id: 'r1',
            name: 'script_version_register',
            arguments: {
              sourceId: aliasDelAdjunto(req, nombre),
              participantMention: 'Diego Peña',
              evidenceQuote: 'Te dejo el guion de Diego Peña',
            },
          },
        ]),
      respuestaFinal('Registrado.'),
    ]);
    const [v] = await query<{ id: string }>(`SELECT id FROM script_versions WHERE source_document_id = $1`, [
      fuente,
    ]);
    expect(v).toBeDefined();

    // turno 1 (mensaje anterior): una frase que podría ser un comentario
    const anterior = await turno('El logo debe aparecer durante todo el video', [], reg.conversacion);
    await salida(anterior, [respuestaFinal('Entendido.')]);

    // turno 2 (mensaje en curso): la persona pide guardar, pero el modelo intenta citar el mensaje anterior
    const actual = 'Guarda este comentario: el cierre es demasiado largo para el formato';
    const t = await turno(actual, [], reg.conversacion);
    const aliasDeVersion = (req: ModelTurnRequest): string => {
      const linea = String(req.messages[1]!.content)
        .split('\n')
        .find((l) => l.includes('Reel principal') && l.includes('Diego'));
      const alias = linea === undefined ? undefined : /última (V\d+)/.exec(linea)?.[1];
      if (alias === undefined) throw new Error('la versión no aparece en el contexto');
      return alias;
    };
    const { r } = await salida(t, [
      (req) =>
        respuestaConTools([
          {
            id: 'c1',
            name: 'review_comment_add',
            arguments: {
              versionId: aliasDeVersion(req),
              quote: 'El logo debe aparecer durante todo el video',
            },
          },
          {
            id: 'c2',
            name: 'review_comment_add',
            arguments: {
              versionId: aliasDeVersion(req),
              quote: 'el cierre es demasiado largo para el formato',
            },
          },
        ]),
      respuestaFinal('Guardé: «el cierre es demasiado largo para el formato».'),
    ]);
    expect(r.salida).toBe('completed');
    const inv = await invocaciones(t.t.run.id);
    expect(inv[0]).toMatchObject({
      tool_name: 'review_comment_add',
      status: 'failed',
      error_code: 'VALIDATION_FAILED',
    });
    expect(inv[1]).toMatchObject({ tool_name: 'review_comment_add', status: 'succeeded' });
    const cs = await query<{ body: string; chat_message_id: string; origin: string }>(
      `SELECT body, chat_message_id, origin FROM script_review_comments WHERE script_version_id = $1`,
      [v!.id],
    );
    expect(cs).toEqual([
      {
        body: 'el cierre es demasiado largo para el formato',
        chat_message_id: t.t.mensaje.id,
        origin: 'chat',
      },
    ]);
  });
});
