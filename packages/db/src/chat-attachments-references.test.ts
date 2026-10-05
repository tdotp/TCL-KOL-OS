/**
 * V2 · Fase 6 — adjuntos y citas del chat.
 *
 * Un adjunto es una fuente (`source_documents`) YA registrada, de la misma
 * organización Y campaña que la conversación. Una cita es provenance estructurada:
 * fuente, y opcionalmente fragmento, snapshot, evidencia, localizador y huella. La
 * base deriva snapshot/localizador/huella del fragmento y sobrevive al reprocesado.
 */

import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Result, User } from '@tcl-kol-os/domain';
import { closePool, query, transaction } from './client.ts';
import { crearConversacion } from './chat-conversations.ts';
import { listarMensajes, publicarMensaje } from './chat-messages.ts';
import { completarRun, iniciarRun } from './agent-runs.ts';
import { crearBriefManual } from './manual.ts';
import { registerLinkedSource } from './sources.ts';
import {
  CONFIG_DE_RUN_DE_PRUEBA,
  type EscenarioDeChat,
  crearEscenarioDeChat,
  crearFragmentoDePrueba,
  crearFuenteDePrueba,
  eliminarCampanaDePrueba,
} from './test-utils.ts';

let e: EscenarioDeChat;
let contador = 0;
const HASH = 'e'.repeat(64);

function valor<T>(r: Result<T>): T {
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
  return r.value;
}
type Resultado = { readonly ok: true } | { readonly ok: false; readonly error: { readonly code: string } };
const codigo = (r: Resultado) => (r.ok ? undefined : r.error.code);
const razon = (r: Result<unknown>) => (r.ok ? undefined : r.error.details?.['reason']);
const sha = (t: string) => createHash('sha256').update(t, 'utf8').digest('hex');
const clave = () => `cm-adj-${Date.now().toString(36)}-${++contador}-xxxxxxxx`;

async function conversacion(dueno: User = e.consultor): Promise<string> {
  return valor(await crearConversacion(dueno, { campaignId: e.campanaId })).id;
}

async function publicar(conv: string, sourceIds: string[] = [], dueno: User = e.consultor) {
  return publicarMensaje(dueno, {
    conversationId: conv,
    clientMessageId: clave(),
    content: 'Mira estos documentos',
    sourceIds,
    runConfig: CONFIG_DE_RUN_DE_PRUEBA,
  });
}

/** Turno en ejecución listo para responder con citas. */
async function turno() {
  const conv = await conversacion();
  const p = valor(await publicar(conv));
  valor(await iniciarRun(e.consultor, p.run.id, { contextHash: HASH, contextManifest: {} }));
  return { conv, runId: p.run.id, mensaje: p.message };
}

beforeAll(async () => {
  e = await crearEscenarioDeChat('Adjuntos y citas');
});

afterAll(async () => {
  await eliminarCampanaDePrueba(e.campanas);
  await closePool();
});

describe('adjuntos', () => {
  it('adjunta fuentes de la misma campaña, en orden, y las devuelve con el mensaje', async () => {
    const a = await crearFuenteDePrueba(e.campanaId, e.admin, 'adj-a');
    const b = await crearFuenteDePrueba(e.campanaId, e.admin, 'adj-b');
    const conv = await conversacion();
    const r = valor(await publicar(conv, [b, a]));
    expect(r.message.attachments.map((x) => [x.position, x.sourceId])).toEqual([
      [1, b],
      [2, a],
    ]);
    const leidos = valor(await listarMensajes(e.consultor, conv));
    expect(leidos[0]!.attachments).toHaveLength(2);
  });

  it('una fuente de otra campaña de la misma organización se rechaza', async () => {
    const otra = await crearFuenteDePrueba(e.otraCampanaId, e.admin, 'adj-otra-campana');
    const conv = await conversacion();
    const r = await publicar(conv, [otra]);
    expect(codigo(r)).toBe('RESOURCE_NOT_FOUND');
    expect(razon(r)).toBe('attachment_scope');
    // El rechazo es atómico: no queda ni el mensaje ni el run.
    expect(valor(await listarMensajes(e.consultor, conv))).toHaveLength(0);
    expect(await query(`SELECT 1 FROM agent_runs WHERE conversation_id = $1`, [conv])).toHaveLength(0);
  });

  it('una fuente de otra organización, inexistente o con id inválido responde igual (no revela existencia)', async () => {
    const ajena = await crearFuenteDePrueba(e.campanaAjenaId, e.ajeno, 'adj-ajena');
    const conv = await conversacion();
    const mensajes = new Set<string>();
    for (const id of [ajena, '00000000-0000-4000-8000-000000000000', 'no-es-uuid']) {
      const r = await publicar(conv, [id]);
      expect(codigo(r)).toBe('RESOURCE_NOT_FOUND');
      expect(razon(r)).toBe('attachment_scope');
      if (!r.ok) mensajes.add(r.error.message);
    }
    expect(mensajes.size).toBe(1);
  });

  it('valida duplicados y el máximo por mensaje', async () => {
    const a = await crearFuenteDePrueba(e.campanaId, e.admin, 'adj-dup');
    const conv = await conversacion();
    expect(codigo(await publicar(conv, [a, a]))).toBe('VALIDATION_FAILED');
    const muchas = await Promise.all(
      Array.from({ length: 11 }, (_, i) => crearFuenteDePrueba(e.campanaId, e.admin, `adj-m${i}`)),
    );
    expect(codigo(await publicar(conv, muchas))).toBe('VALIDATION_FAILED');
    expect(valor(await publicar(conv, muchas.slice(0, 10))).message.attachments).toHaveLength(10);
  });

  it('la reutilización de la clave con otros adjuntos es un conflicto; con los mismos, un replay', async () => {
    const a = await crearFuenteDePrueba(e.campanaId, e.admin, 'adj-rep-a');
    const b = await crearFuenteDePrueba(e.campanaId, e.admin, 'adj-rep-b');
    const conv = await conversacion();
    const id = clave();
    const enviar = (ids: string[]) =>
      publicarMensaje(e.consultor, {
        conversationId: conv,
        clientMessageId: id,
        content: 'Con adjuntos',
        sourceIds: ids,
        runConfig: CONFIG_DE_RUN_DE_PRUEBA,
      });
    valor(await enviar([a]));
    expect(valor(await enviar([a])).replayed).toBe(true);
    expect(razon(await enviar([b]))).toBe('client_message_id_reused');
    expect(razon(await enviar([]))).toBe('client_message_id_reused');
  });

  it('la base rechaza, por SQL directo (en la transacción del mensaje), un adjunto de otra campaña u otra organización', async () => {
    const conv = await conversacion();
    const otra = await crearFuenteDePrueba(e.otraCampanaId, e.admin, 'sql-otra-campana');
    const ajena = await crearFuenteDePrueba(e.campanaAjenaId, e.ajeno, 'sql-ajena');
    const propia = await crearFuenteDePrueba(e.campanaId, e.admin, 'sql-propia');
    const insertar = (fuente: string, claveMensaje: string) =>
      transaction(async (client) => {
        const { rows } = await client.query<{ id: string }>(
          `INSERT INTO chat_messages (organization_id, campaign_id, conversation_id, role, user_id, content, client_message_id)
           VALUES ($1, $2, $3, 'user', $4, 'hola', $5) RETURNING id`,
          [e.admin.organizationId, e.campanaId, conv, e.consultor.id, claveMensaje],
        );
        await client.query(
          `INSERT INTO chat_message_attachments (organization_id, campaign_id, conversation_id, message_id, source_id, position)
           VALUES ($1, $2, $3, $4, $5, 1)`,
          [e.admin.organizationId, e.campanaId, conv, rows[0]!.id, fuente],
        );
      });
    await expect(insertar(otra, 'clave-sql-adj-0001')).rejects.toThrow(
      /chat_message_attachments_source_campaign_fkey/,
    );
    await expect(insertar(ajena, 'clave-sql-adj-0002')).rejects.toThrow(
      /chat_message_attachments_source_org_fkey/,
    );
    await insertar(propia, 'clave-sql-adj-0003');
  });

  it('no se agrega un adjunto a un mensaje anterior ni a uno del asistente; los adjuntos son inmutables', async () => {
    const a = await crearFuenteDePrueba(e.campanaId, e.admin, 'adj-tardio');
    const conv = await conversacion();
    const p = valor(await publicar(conv, [a]));
    const insertar = (mensaje: string, fuente: string, posicion: number) =>
      query(
        `INSERT INTO chat_message_attachments (organization_id, campaign_id, conversation_id, message_id, source_id, position)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [e.admin.organizationId, e.campanaId, conv, mensaje, fuente, posicion],
      );
    const otra = await crearFuenteDePrueba(e.campanaId, e.admin, 'adj-tardio-2');
    // Ya pasó la transacción del mensaje: no se agrega.
    await expect(insertar(p.message.id, otra, 2)).rejects.toThrow(/no se agrega a un mensaje anterior/);
    valor(await iniciarRun(e.consultor, p.run.id, { contextHash: HASH, contextManifest: {} }));
    const respuesta = valor(await completarRun(e.consultor, p.run.id, { content: 'Recibido' }));
    await expect(insertar(respuesta.message.id, otra, 1)).rejects.toThrow(
      /Solo un mensaje de usuario lleva adjuntos/,
    );
    await expect(
      query(`UPDATE chat_message_attachments SET position = 5 WHERE message_id = $1`, [p.message.id]),
    ).rejects.toThrow(/histórico y no se modifica/);
    await expect(
      query(`DELETE FROM chat_message_attachments WHERE message_id = $1`, [p.message.id]),
    ).rejects.toThrow(/histórico y no se borra/);
  });
});

describe('citas (referencias) del mensaje del asistente', () => {
  it('guarda fuente, fragmento, localizador y huella derivados del fragmento; la base los deriva, no el llamador', async () => {
    const fuente = await crearFuenteDePrueba(e.campanaId, e.admin, 'cita-archivo');
    const texto = 'El P80 Ultra tiene pantalla de 6,8 pulgadas.';
    const fragmento = await crearFragmentoDePrueba(fuente, 1, texto, 4);
    const { runId } = await turno();
    const r = valor(
      await completarRun(e.consultor, runId, {
        content: 'La pantalla mide 6,8 pulgadas [S1].',
        references: [{ sourceId: fuente, fragmentId: fragmento }],
      }),
    );
    expect(r.message.references).toHaveLength(1);
    expect(r.message.references[0]).toMatchObject({
      ordinal: 1,
      sourceId: fuente,
      fragmentId: fragmento,
      snapshotId: undefined,
      locator: { kind: 'page', page: 4 },
      fragmentTextSha256: sha(texto),
    });
    const leidos = valor(await listarMensajes(e.consultor, r.message.conversationId));
    expect(leidos.at(-1)!.references).toHaveLength(1);
  });

  it('una cita a un snapshot antiguo conserva ESE snapshot aunque exista uno más reciente', async () => {
    const enlace = valor(
      await registerLinkedSource(e.admin, {
        campaignId: e.campanaId,
        url: `https://docs.google.com/spreadsheets/d/1Cita${e.sufijo}${'x'.repeat(30)}/edit`.slice(0, 80),
      }),
    );
    const fuente = enlace.id;
    const snapshots: string[] = [];
    const fragmentos: string[] = [];
    for (const secuencia of [1, 2]) {
      const [s] = await query<{ id: string }>(
        `INSERT INTO source_snapshots (source_id, organization_id, sequence, provider, fetched_at, content_hash,
                                       hash_version, structure, generator)
         VALUES ($1, $2, $3, 'google_sheets', now(), $4, 'v1', '{}'::jsonb, 'prueba') RETURNING id`,
        [fuente, e.admin.organizationId, secuencia, sha(`contenido-${secuencia}-${e.sufijo}`)],
      );
      const [f] = await query<{ id: string }>(
        `INSERT INTO source_fragments (source_id, snapshot_id, ordinal, text, locator)
         VALUES ($1, $2, 1, $3, '{"kind":"sheet","sheet":"Datos"}'::jsonb) RETURNING id`,
        [fuente, s!.id, `Fila de la lectura ${secuencia}`],
      );
      await query(`UPDATE source_documents SET current_snapshot_id = $2 WHERE id = $1`, [fuente, s!.id]);
      snapshots.push(s!.id);
      fragmentos.push(f!.id);
    }
    const { runId } = await turno();
    const r = valor(
      await completarRun(e.consultor, runId, {
        content: 'Según la primera lectura del Sheet [S1].',
        references: [{ sourceId: fuente, fragmentId: fragmentos[0]! }],
      }),
    );
    expect(r.message.references[0]).toMatchObject({
      sourceId: fuente,
      fragmentId: fragmentos[0],
      snapshotId: snapshots[0],
      locator: { kind: 'sheet', sheet: 'Datos' },
    });
    const [vigente] = await query<{ current_snapshot_id: string }>(
      `SELECT current_snapshot_id FROM source_documents WHERE id = $1`,
      [fuente],
    );
    expect(vigente!.current_snapshot_id).toBe(snapshots[1]);
    // El snapshot de la cita no puede borrarse mientras haya citas (RESTRICT) ni cambiarse por SQL.
    await expect(
      query(`UPDATE chat_message_references SET snapshot_id = $2 WHERE id = $1`, [
        r.message.references[0]!.id,
        snapshots[1],
      ]),
    ).rejects.toThrow(/histórica/);
  });

  it('una cita a una fuente de otra campaña u organización, o a un fragmento ajeno, falla sin dejar nada a medias', async () => {
    const propia = await crearFuenteDePrueba(e.campanaId, e.admin, 'cita-propia');
    const otraCampana = await crearFuenteDePrueba(e.otraCampanaId, e.admin, 'cita-otra-campana');
    const ajena = await crearFuenteDePrueba(e.campanaAjenaId, e.ajeno, 'cita-ajena');
    const fragmentoDeOtra = await crearFragmentoDePrueba(otraCampana, 1, 'texto de otra campaña');
    const { runId, conv } = await turno().then((t) => ({ runId: t.runId, conv: t.conv }));
    for (const cita of [
      { sourceId: otraCampana },
      { sourceId: ajena },
      { sourceId: propia, fragmentId: fragmentoDeOtra },
      { sourceId: '00000000-0000-4000-8000-000000000000' },
      { sourceId: 'no-es-uuid' },
    ]) {
      const r = await completarRun(e.consultor, runId, {
        content: 'Respuesta con cita ajena',
        references: [cita],
      });
      expect(codigo(r), JSON.stringify(cita)).toBe('VALIDATION_FAILED');
      expect(razon(r)).toBe('reference_scope');
    }
    // Todo se deshizo: el run sigue en ejecución y no hay mensaje del asistente.
    const [run] = await query<{ status: string }>(`SELECT status FROM agent_runs WHERE id = $1`, [runId]);
    expect(run!.status).toBe('running');
    expect(valor(await listarMensajes(e.consultor, conv)).map((m) => m.role)).toEqual(['user']);
  });

  it('una cita insertada después de la transacción del mensaje se rechaza, aunque sea coherente', async () => {
    const fuente = await crearFuenteDePrueba(e.campanaId, e.admin, 'cita-coherencia');
    const fragmento = await crearFragmentoDePrueba(fuente, 1, 'Texto exacto del fragmento', 2);
    const { conv, runId } = await turno();
    const [asistente] = await query<{ id: string }>(
      `INSERT INTO chat_messages (organization_id, campaign_id, conversation_id, role, user_id, content, agent_run_id)
       VALUES ($1, $2, $3, 'assistant', $4, 'respuesta', $5) RETURNING id`,
      [e.admin.organizationId, e.campanaId, conv, e.consultor.id, runId],
    );
    await expect(
      query(
        `INSERT INTO chat_message_references (organization_id, campaign_id, conversation_id, message_id, ordinal, source_id, fragment_id)
         VALUES ($1, $2, $3, $4, 1, $5, $6)`,
        [e.admin.organizationId, e.campanaId, conv, asistente!.id, fuente, fragmento],
      ),
    ).rejects.toThrow(/no se agrega a un mensaje anterior|solo se registra al crear el mensaje/);
  });

  it('en la misma transacción que el mensaje, locator y huella inconsistentes se rechazan y los válidos se derivan', async () => {
    const fuente = await crearFuenteDePrueba(e.campanaId, e.admin, 'cita-tx');
    const fragmento = await crearFragmentoDePrueba(fuente, 1, 'Texto del fragmento de la transacción', 7);
    const { conv, runId } = await turno();
    const intento = async (extra: string, parametros: unknown[]) => {
      return transaction(async (client) => {
        const { rows } = await client.query<{ id: string }>(
          `INSERT INTO chat_messages (organization_id, campaign_id, conversation_id, role, user_id, content, agent_run_id)
           VALUES ($1, $2, $3, 'assistant', $4, 'respuesta', $5) RETURNING id`,
          [e.admin.organizationId, e.campanaId, conv, e.consultor.id, runId],
        );
        await client.query(
          `INSERT INTO chat_message_references (organization_id, campaign_id, conversation_id, message_id, ordinal, source_id, fragment_id ${extra})
           VALUES ($1, $2, $3, $4, 1, $5, $6 ${parametros.length > 0 ? ', ' + parametros.map((_, i) => `$${i + 7}`).join(', ') : ''})`,
          [e.admin.organizationId, e.campanaId, conv, rows[0]!.id, fuente, fragmento, ...parametros],
        );
        return rows[0]!.id;
      });
    };
    await expect(intento(', locator', ['{"kind":"page","page":99}'])).rejects.toThrow(
      /localizador de la cita no coincide/,
    );
    await expect(intento(', fragment_text_sha256', [HASH])).rejects.toThrow(/huella de la cita no coincide/);
    await expect(intento(', locator', ['{"kind":"cell"}'])).rejects.toThrow();
    const ok = await intento('', []);
    const [ref] = await query<{ locator: unknown; fragment_text_sha256: string }>(
      `SELECT locator, fragment_text_sha256 FROM chat_message_references WHERE message_id = $1`,
      [ok],
    );
    expect(ref).toEqual({
      locator: { kind: 'page', page: 7 },
      fragment_text_sha256: sha('Texto del fragmento de la transacción'),
    });
  });

  it('las citas solo cuelgan de mensajes del asistente', async () => {
    const fuente = await crearFuenteDePrueba(e.campanaId, e.admin, 'cita-usuario');
    const conv = await conversacion();
    await expect(
      transaction(async (client) => {
        const { rows } = await client.query<{ id: string }>(
          `INSERT INTO chat_messages (organization_id, campaign_id, conversation_id, role, user_id, content, client_message_id)
           VALUES ($1, $2, $3, 'user', $4, 'hola', 'clave-cita-user-1') RETURNING id`,
          [e.admin.organizationId, e.campanaId, conv, e.consultor.id],
        );
        await client.query(
          `INSERT INTO chat_message_references (organization_id, campaign_id, conversation_id, message_id, ordinal, source_id)
           VALUES ($1, $2, $3, $4, 1, $5)`,
          [e.admin.organizationId, e.campanaId, conv, rows[0]!.id, fuente],
        );
      }),
    ).rejects.toThrow(/Solo un mensaje del asistente lleva citas/);
  });

  it('reprocesar el archivo (el worker borra y recrea fragmentos) deja la cita con su fuente, localizador y huella', async () => {
    const fuente = await crearFuenteDePrueba(e.campanaId, e.admin, 'cita-reproceso');
    const texto = 'Garantía de 24 meses.';
    const fragmento = await crearFragmentoDePrueba(fuente, 1, texto, 9);
    const { runId } = await turno();
    const r = valor(
      await completarRun(e.consultor, runId, {
        content: 'La garantía es de 24 meses [S1].',
        references: [{ sourceId: fuente, fragmentId: fragmento }],
      }),
    );
    // Reproceso: los fragmentos de un archivo se reemplazan.
    await query(`DELETE FROM source_fragments WHERE source_id = $1`, [fuente]);
    await crearFragmentoDePrueba(fuente, 1, texto, 9);
    const [ref] = await query<{
      fragment_id: string | null;
      source_id: string;
      locator: unknown;
      fragment_text_sha256: string;
    }>(
      `SELECT fragment_id, source_id, locator, fragment_text_sha256 FROM chat_message_references WHERE message_id = $1`,
      [r.message.id],
    );
    expect(ref).toEqual({
      fragment_id: null,
      source_id: fuente,
      locator: { kind: 'page', page: 9 },
      fragment_text_sha256: sha(texto),
    });
    // Sigue leyéndose a través del caso de uso.
    const leidos = valor(await listarMensajes(e.consultor, r.message.conversationId));
    expect(leidos.at(-1)!.references[0]).toMatchObject({
      sourceId: fuente,
      fragmentId: undefined,
      locator: { kind: 'page', page: 9 },
    });
  });

  it('la evidencia reemplazada por una re-extracción deja la cita sin evidencia pero intacta', async () => {
    const fuente = await crearFuenteDePrueba(e.campanaId, e.admin, 'cita-evidencia');
    const fragmento = await crearFragmentoDePrueba(fuente, 1, 'Pantalla AMOLED de 6,8 pulgadas', 3);
    const brief = valor(await crearBriefManual(e.admin, e.campanaId));
    const [campo] = await query<{ id: string }>(
      `SELECT id FROM brief_fields WHERE brief_version_id = $1 AND campaign_product_id IS NULL ORDER BY key LIMIT 1`,
      [brief.versionId],
    );
    const [evidencia] = await query<{ id: string }>(
      `INSERT INTO evidence (brief_field_id, source_id, fragment_id, quote)
       VALUES ($1, $2, $3, 'Pantalla AMOLED de 6,8 pulgadas') RETURNING id`,
      [campo!.id, fuente, fragmento],
    );
    const { runId } = await turno();
    const r = valor(
      await completarRun(e.consultor, runId, {
        content: 'La pantalla es AMOLED [S1].',
        references: [{ sourceId: fuente, fragmentId: fragmento, evidenceId: evidencia!.id }],
      }),
    );
    expect(r.message.references[0]).toMatchObject({ evidenceId: evidencia!.id, fragmentId: fragmento });
    // La re-extracción reemplaza la evidencia: la cita conserva todo lo demás.
    await query(`DELETE FROM evidence WHERE id = $1`, [evidencia!.id]);
    const [ref] = await query<{ evidence_id: string | null; fragment_id: string | null; locator: unknown }>(
      `SELECT evidence_id, fragment_id, locator FROM chat_message_references WHERE message_id = $1`,
      [r.message.id],
    );
    expect(ref).toEqual({ evidence_id: null, fragment_id: fragmento, locator: { kind: 'page', page: 3 } });
  });

  it('una evidencia de otra fuente o de otro fragmento no se cita', async () => {
    const fuenteA = await crearFuenteDePrueba(e.campanaId, e.admin, 'cita-evid-a');
    const fuenteB = await crearFuenteDePrueba(e.campanaId, e.admin, 'cita-evid-b');
    const fragA1 = await crearFragmentoDePrueba(fuenteA, 1, 'A uno', 1);
    const fragA2 = await crearFragmentoDePrueba(fuenteA, 2, 'A dos', 2);
    const brief = valor(await crearBriefManual(e.admin, e.campanaId));
    const [campo] = await query<{ id: string }>(
      `SELECT id FROM brief_fields WHERE brief_version_id = $1 AND campaign_product_id IS NULL ORDER BY key LIMIT 1`,
      [brief.versionId],
    );
    const [evidencia] = await query<{ id: string }>(
      `INSERT INTO evidence (brief_field_id, source_id, fragment_id, quote) VALUES ($1, $2, $3, 'A uno') RETURNING id`,
      [campo!.id, fuenteA, fragA1],
    );
    const { runId } = await turno();
    // La evidencia es de la fuente A: citarla con la fuente B rompe la FK compuesta.
    expect(
      razon(
        await completarRun(e.consultor, runId, {
          content: 'Evidencia cruzada',
          references: [{ sourceId: fuenteB, evidenceId: evidencia!.id }],
        }),
      ),
    ).toBe('reference_scope');
    // La evidencia respalda el fragmento A1: citarla con A2 no es coherente.
    expect(
      razon(
        await completarRun(e.consultor, runId, {
          content: 'Evidencia de otro fragmento',
          references: [{ sourceId: fuenteA, fragmentId: fragA2, evidenceId: evidencia!.id }],
        }),
      ),
    ).toBe('reference_scope');
  });

  it('una cita no se reescribe ni se borra (solo pierde fragmento/evidencia por las FK)', async () => {
    const fuente = await crearFuenteDePrueba(e.campanaId, e.admin, 'cita-inmutable');
    const { runId } = await turno();
    const r = valor(
      await completarRun(e.consultor, runId, {
        content: 'Con cita [S1].',
        references: [{ sourceId: fuente }],
      }),
    );
    const id = r.message.references[0]!.id;
    await expect(query(`UPDATE chat_message_references SET ordinal = 2 WHERE id = $1`, [id])).rejects.toThrow(
      /histórica/,
    );
    await expect(
      query(
        `UPDATE chat_message_references SET locator = '{"kind":"sheet","sheet":"x"}'::jsonb WHERE id = $1`,
        [id],
      ),
    ).rejects.toThrow(/histórica/);
    await expect(query(`DELETE FROM chat_message_references WHERE id = $1`, [id])).rejects.toThrow(
      /histórica y no se borra/,
    );
  });

  it('deduplica citas repetidas y respeta el máximo por respuesta', async () => {
    const fuente = await crearFuenteDePrueba(e.campanaId, e.admin, 'cita-dedup');
    const { runId } = await turno();
    const r = valor(
      await completarRun(e.consultor, runId, {
        content: 'Citas repetidas.',
        references: [{ sourceId: fuente }, { sourceId: fuente }, { sourceId: fuente }],
      }),
    );
    expect(r.message.references).toHaveLength(1);
    const otro = await turno();
    const muchas = await Promise.all(
      Array.from({ length: 51 }, (_, i) => crearFuenteDePrueba(e.campanaId, e.admin, `cita-max-${i}`)),
    );
    expect(
      codigo(
        await completarRun(e.consultor, otro.runId, {
          content: 'Demasiadas citas',
          references: muchas.map((s) => ({ sourceId: s })),
        }),
      ),
    ).toBe('VALIDATION_FAILED');
  });
});
