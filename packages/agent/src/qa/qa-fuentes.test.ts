/**
 * QA adversarial · vector 7 (política de lectura para IA): contenido de fuentes `sensible`,
 * no procesadas, fallidas o de un snapshot NO vigente nunca llega al modelo ni por las tools ni por
 * el contexto. BD real + worker real con Google simulado.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePool, derivarNonce, query } from '@tcl-kol-os/db';
import {
  type EscenarioDeChat,
  crearEscenarioDeChat,
  crearFragmentoDePrueba,
  crearFuenteDePrueba,
  eliminarCampanaDePrueba,
  eliminarInfluencersDePrueba,
} from '@tcl-kol-os/db/test-utils';
import { ScriptedModel, respuestaFinal } from '../model/scripted-model.ts';
import { ejecutarRun } from '../runtime/ejecutar-run.ts';
import {
  SECRETO_DE_PRUEBA,
  admitir,
  dependencias,
  entornoDePrueba,
  loQueVioElModelo,
  nuevaConversacion,
  valor,
} from '../runtime/testing/harness.ts';
import { createToolRegistry } from '../tools/registry.ts';
import { abrirTurno, codigo, json, llamar, nuevaCampana, registro } from './testing/harness.ts';
import {
  GoogleSimulado,
  type GoogleSimuladoLike,
  hayWorkerLocal,
  pestanaDeInfluencers,
  procesarColaConWorker,
} from './testing/sheet.ts';

let e: EscenarioDeChat;
let google: GoogleSimuladoLike;
const r = registro();
const registry = createToolRegistry({
  nonceForRun: (runId) => derivarNonce(SECRETO_DE_PRUEBA, runId),
  onUnexpectedError: () => undefined,
});
const influencers: string[] = [];
const sufijo = Date.now().toString(36);

beforeAll(async () => {
  e = await crearEscenarioDeChat('QA fuentes');
  google = await GoogleSimulado.crear();
});
afterAll(async () => {
  await eliminarInfluencersDePrueba(influencers).catch(() => undefined);
  await eliminarCampanaDePrueba(e.campanas);
  await google.limpiar();
  await closePool();
});

describe('V7 · fuentes que la IA NO puede leer', () => {
  it('sensible, procesando, fallida: ni source_read_content, ni source_search_text, ni source_get, ni el contexto muestran su contenido', async () => {
    const campana = await nuevaCampana(e.admin.organizationId, e.admin.id, 'Fuentes ilegibles', e.campanas);
    const sensible = await crearFuenteDePrueba(campana, e.admin, 'doc-sensible');
    await crearFragmentoDePrueba(sensible, 1, 'SENTINELA-SENSIBLE texto confidencial del cliente');
    await query(`UPDATE source_documents SET confidentiality_level = 'sensible' WHERE id = $1`, [sensible]);
    const procesando = await crearFuenteDePrueba(campana, e.admin, 'doc-procesando');
    await crearFragmentoDePrueba(procesando, 1, 'SENTINELA-PROCESANDO parcial');
    await query(`UPDATE source_documents SET status = 'procesando' WHERE id = $1`, [procesando]);
    const fallida = await crearFuenteDePrueba(campana, e.admin, 'doc-fallida');
    await crearFragmentoDePrueba(fallida, 1, 'SENTINELA-FALLIDA parcial');
    await query(`UPDATE source_documents SET status = 'fallido' WHERE id = $1`, [fallida]);
    const ok = await crearFuenteDePrueba(campana, e.admin, 'doc-legible');
    await crearFragmentoDePrueba(ok, 1, 'SENTINELA-LEGIBLE texto normal');

    const t = await abrirTurno(e.consultor, campana, 'busca SENTINELA y lee todo');
    for (const id of [sensible, procesando, fallida]) {
      const g = await llamar(r, t, 'source_get', { sourceId: id });
      expect(g.content).not.toContain('SENTINELA');
      const c = await llamar(r, t, 'source_read_content', { sourceId: id });
      expect(c.content).not.toContain('SENTINELA');
    }
    // el sensible se trata como inexistente (el modelo ni sabe que existe)
    expect(codigo(await llamar(r, t, 'source_get', { sourceId: sensible }))).toBe('RESOURCE_NOT_FOUND');
    const b = await llamar(r, t, 'source_search_text', { text: 'SENTINELA' });
    expect(b.content).toContain('SENTINELA-LEGIBLE');
    for (const mala of ['SENTINELA-SENSIBLE', 'SENTINELA-PROCESANDO', 'SENTINELA-FALLIDA']) {
      expect(b.content).not.toContain(mala);
    }
    const l = await llamar(r, t, 'source_list', {});
    expect(l.content).not.toContain('doc-sensible');
    expect(json(l)['restricted']).toBe(1);

    // y el contexto del turno (sin adjuntarlas): tampoco
    const ent = entornoDePrueba();
    const conv = await nuevaConversacion(e.consultor, campana);
    const turno = await admitir(e.consultor, conv, 'Qué fuentes hay', ent);
    const modelo = new ScriptedModel([respuestaFinal('ok')]);
    valor(await ejecutarRun(e.consultor, turno.run.id, dependencias(modelo, registry, ent)));
    const visto = loQueVioElModelo(modelo.requests[0]!);
    for (const mala of ['SENTINELA', 'doc-sensible', 'doc-procesando', 'doc-fallida']) {
      expect(visto, mala).not.toContain(mala);
    }
  });

  it('adjuntar una fuente fallida/en proceso/sensible: el contenido no entra y el run termina bien', async () => {
    const campana = await nuevaCampana(e.admin.organizationId, e.admin.id, 'Adjuntos ilegibles', e.campanas);
    const ids: string[] = [];
    for (const [estado, sens] of [
      ['procesando', false],
      ['fallido', false],
      ['procesado', true],
    ] as const) {
      const id = await crearFuenteDePrueba(campana, e.admin, `adj-${estado}-${sens}`);
      await crearFragmentoDePrueba(id, 1, `CONTENIDO-ADJUNTO-${estado}-${sens}`);
      await query(`UPDATE source_documents SET status = $2, confidentiality_level = $3 WHERE id = $1`, [
        id,
        estado,
        sens ? 'sensible' : 'interna',
      ]);
      ids.push(id);
    }
    const ent = entornoDePrueba();
    const conv = await nuevaConversacion(e.consultor, campana);
    const turno = await admitir(e.consultor, conv, 'Mira estos adjuntos', ent, ids);
    const modelo = new ScriptedModel([respuestaFinal('ok')]);
    const res = valor(await ejecutarRun(e.consultor, turno.run.id, dependencias(modelo, registry, ent)));
    expect(res.salida).toBe('completed');
    expect(loQueVioElModelo(modelo.requests[0]!)).not.toContain('CONTENIDO-ADJUNTO-');
  });
});

describe.skipIf(!hayWorkerLocal())('V7 · snapshot NO vigente de un Sheet', () => {
  it('tras un segundo sync con otro contenido, el texto del snapshot viejo no se lee, ni se busca, ni entra al contexto; las citas apuntan al snapshot vigente', async () => {
    const campana = await nuevaCampana(e.admin.organizationId, e.admin.id, 'Snapshots', e.campanas);
    const libro = `1QaSnap${sufijo}${'s'.repeat(40)}`.slice(0, 44);
    const url = `https://docs.google.com/spreadsheets/d/${libro}/edit#gid=77`;
    await google.publicar(libro, [
      pestanaDeInfluencers([['S-1', `VIEJO-SENTINELA ${sufijo}`, 'instagram', `@viejo${sufijo}`, '']], {
        gid: 77,
      }),
    ]);
    const t = await abrirTurno(e.consultor, campana, `Registra ${url} y sincronízalo, luego léelo`);
    const reg = await llamar(r, t, 'source_register_link', { url });
    expect(reg.status).toBe('succeeded');
    const alias = json(reg)['source'] as string;
    const s1 = await llamar(r, t, 'sheet_sync', { sourceId: alias, evidenceQuote: 'sincronízalo' });
    expect(s1.status).toBe('succeeded');
    await procesarColaConWorker(google.entorno);
    const antes = await llamar(r, t, 'source_search_text', { text: 'VIEJO-SENTINELA' });
    expect(antes.content).toContain('VIEJO-SENTINELA');

    // el Sheet cambia y se vuelve a sincronizar: el snapshot 2 pasa a ser el vigente
    await google.publicar(libro, [
      pestanaDeInfluencers([['S-1', `NUEVO-SENTINELA ${sufijo}`, 'instagram', `@nuevo${sufijo}`, '']], {
        gid: 77,
      }),
    ]);
    const t2 = await abrirTurno(e.consultor, campana, 'Sincronízalo otra vez y léelo');
    const aliasT2 = json(await llamar(r, t2, 'source_list', {}))['sources'] as string;
    expect(aliasT2).toContain('S1');
    const s2 = await llamar(r, t2, 'sheet_sync', { sourceId: 'S1', evidenceQuote: 'Sincronízalo otra vez' });
    expect(s2.status).toBe('succeeded');
    await procesarColaConWorker(google.entorno);

    const busqueda = await llamar(r, t2, 'source_search_text', { text: 'VIEJO-SENTINELA' });
    expect(busqueda.content).not.toContain('VIEJO-SENTINELA');
    const nueva = await llamar(r, t2, 'source_search_text', { text: 'NUEVO-SENTINELA' });
    expect(nueva.content).toContain('NUEVO-SENTINELA');
    const lectura = await llamar(r, t2, 'source_read_content', { sourceId: 'S1' });
    expect(lectura.content).not.toContain('VIEJO-SENTINELA');
    expect(lectura.content).toContain('NUEVO-SENTINELA');

    // contexto con el Sheet adjunto
    const [fuente] = await query<{ id: string }>(`SELECT id FROM source_documents WHERE campaign_id = $1`, [
      campana,
    ]);
    const ent = entornoDePrueba();
    const conv = await nuevaConversacion(e.consultor, campana);
    const turno = await admitir(e.consultor, conv, 'Qué dice el Sheet adjunto', ent, [fuente!.id]);
    const modelo = new ScriptedModel([respuestaFinal('Dice algo [S1].')]);
    valor(await ejecutarRun(e.consultor, turno.run.id, dependencias(modelo, registry, ent)));
    const visto = loQueVioElModelo(modelo.requests[0]!);
    expect(visto).not.toContain('VIEJO-SENTINELA');
    expect(visto).toContain('NUEVO-SENTINELA');
    // la huella de la cita apunta a un fragmento del snapshot VIGENTE
    const refs = await query<{ snapshot_id: string | null; vigente: string }>(
      `SELECT r.snapshot_id, d.current_snapshot_id AS vigente FROM chat_message_references r
         JOIN source_documents d ON d.id = r.source_id WHERE r.conversation_id = $1 AND r.fragment_id IS NOT NULL`,
      [conv],
    );
    for (const f of refs) expect(f.snapshot_id).toBe(f.vigente);
  });
});
