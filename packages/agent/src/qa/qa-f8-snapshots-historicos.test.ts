/**
 * CIERRE F8 · snapshots HISTÓRICOS del Sheet de influencers (texto con `fee`, `canje`, `condiciones` y teléfono en los
 * fragmentos) frente al AGENTE: tools de lectura de fuentes, contexto ensamblado y mensajes iniciales del modelo.
 *
 * Complementa `packages/db/src/qa-f8-snapshots-historicos.test.ts` (lectores de la base) y
 * `qa-f8-sheet-fee.test.ts` (snapshots NUEVOS, ya con lista blanca). Aquí el snapshot antiguo es el VIGENTE de la
 * fuente y su estructura no declara `fragmentTextAllowlist`: ningún camino del agente debe devolver ese texto.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePool, ensamblarContexto, query } from '@tcl-kol-os/db';
import type { User } from '@tcl-kol-os/domain';
import { construirMensajesIniciales } from '../prompts/agente-cuenta.ts';
import { abrirTurno, llamar, registro } from '../tools/test-support.ts';
import {
  type MundoDeOperacion,
  crearMundoDeOperacion,
  crearSheetConKpi,
  limpiarMundoDeOperacion,
} from './testing/operacion.ts';

const r = registro();
const FEE = 'FEE-HIST-AG-7712345';
const CANJE = 'CANJE-HIST-AG-lavadora-4455';
const CONDICIONES = 'COND-HIST-AG-exclusividad-6677';
const TELEFONO = 'TEL-HIST-AG-3001239876';
const SENTINELAS = [FEE, CANJE, CONDICIONES, TELEFONO];
const SECRETO = 'secreto-de-prueba-f8-historico';

const TEXTO_ANTIGUO = [
  'Hoja «Influencers» · filas 1–3',
  'Fila 1',
  'A: TCL_KOL_OS_INFLUENCERS_V1',
  'Fila 3',
  'clave_influencer: INF-001',
  'nombre: Valentina Rios',
  'plataforma: instagram',
  'handle: val.rios',
  'producto: P80',
  `fee: ${FEE}`,
  `canje: ${CANJE}`,
  `condiciones: ${CONDICIONES}`,
  `telefono: ${TELEFONO}`,
  'kpi_objetivo: Alcanzar 50.000 vistas',
].join('\n');

let m: MundoDeOperacion;
let sourceId = '';

function sinFinanzas(texto: string, etiqueta: string): void {
  for (const s of SENTINELAS) expect(texto, `${etiqueta} contiene ${s}`).not.toContain(s);
}

beforeAll(async () => {
  m = await crearMundoDeOperacion('F8 historicos agente');
  const sheet = await crearSheetConKpi(m.op.admin, m.op.campanaId, m.rios, 'Alcanzar 50.000 vistas');
  sourceId = sheet.sourceId;
  const [snap] = await query<{ id: string }>(
    `INSERT INTO source_snapshots (source_id, organization_id, sequence, provider, fetched_at, content_hash,
                                   hash_version, structure, generator)
     VALUES ($1, $2, 7, 'google_sheets', now(), $3, 'grid-sha256/1', $4::jsonb, 'qa-f8-historico') RETURNING id`,
    [
      sourceId,
      m.op.admin.organizationId,
      'e'.repeat(64),
      JSON.stringify({ sheets: [{ name: 'Influencers', state: 'visible' }] }),
    ],
  );
  await query(
    `INSERT INTO source_snapshot_rows (snapshot_id, sheet, sheet_gid, row_number, cells)
     VALUES ($1, 'Influencers', 11, 1, $2::jsonb)`,
    [snap!.id, JSON.stringify([{ col: 1, text: 'TCL_KOL_OS_INFLUENCERS_V1', type: 'texto' }])],
  );
  await query(
    `INSERT INTO source_fragments (source_id, snapshot_id, ordinal, section, text, locator)
     VALUES ($1, $2, 1, 'Influencers', $3,
             '{"kind":"range","sheet":"Influencers","range":"A1:J3","rowStart":1,"rowEnd":3,"colStart":1,"colEnd":10}'::jsonb)`,
    [sourceId, snap!.id, TEXTO_ANTIGUO],
  );
  await query(`UPDATE source_documents SET current_snapshot_id = $2, status = 'procesado' WHERE id = $1`, [
    sourceId,
    snap!.id,
  ]);
}, 120_000);

afterAll(async () => {
  await limpiarMundoDeOperacion(m);
  await closePool();
});

describe('CONTROL: el texto antiguo existe en la base y es el vigente de la fuente', () => {
  it('hay un fragmento vigente con el fee y el teléfono en texto plano', async () => {
    const [f] = await query<{ n: string }>(
      `SELECT count(*) AS n FROM source_fragments f JOIN source_documents s ON s.id = f.source_id
        WHERE f.source_id = $1 AND f.snapshot_id = s.current_snapshot_id AND f.text LIKE $2 AND f.text LIKE $3`,
      [sourceId, `%${FEE}%`, `%${TELEFONO}%`],
    );
    expect(Number(f!.n)).toBe(1);
  });
});

describe('agente · tools de fuentes sobre un snapshot histórico', () => {
  for (const rol of ['consultor', 'admin', 'director'] as const) {
    it(`${rol}: source_read_content y source_search_text no entregan el texto financiero al modelo`, async () => {
      const t = await abrirTurno(m.op[rol], m.op.campanaId, 'Lee el Sheet de influencers');
      const lista = await llamar(r, t, 'source_list', {});
      sinFinanzas(lista.content, 'source_list');
      const leido = await llamar(r, t, 'source_read_content', { sourceId: 'S1' });
      sinFinanzas(leido.content, 'source_read_content');
      for (const text of ['fee', 'canje', 'condiciones', 'telefono', FEE, TELEFONO]) {
        const buscado = await llamar(r, t, 'source_search_text', { text });
        sinFinanzas(buscado.content, `source_search_text(${text})`);
      }
    });
  }
});

describe('agente · contexto ensamblado y mensajes iniciales del modelo', () => {
  async function contexto(actor: User) {
    const x = await ensamblarContexto(actor, {
      conversationId: 'conv-f8-historico',
      messageId: 'msg-f8-historico',
      runId: `run-f8-historico-${Date.now().toString(36)}`,
      campaignId: m.op.campanaId,
      nonceSecret: SECRETO,
      mensajeActual: { texto: '¿Cuánto es el fee de Valentina y cuál es su teléfono?', adjuntos: [] },
      ventana: [],
      ahora: new Date('2026-10-07T12:00:00.000Z'),
    });
    if (!x.ok) throw new Error(`${x.error.code}: ${x.error.message}`);
    return x.value;
  }

  for (const rol of ['consultor', 'admin', 'director'] as const) {
    it(`${rol}: ningún centinela en el contexto, el informe ni los mensajes iniciales`, async () => {
      const c = await contexto(m.op[rol]);
      sinFinanzas(JSON.stringify(c), 'contexto');
      for (const msg of construirMensajesIniciales(c.texto))
        sinFinanzas(String(msg.content), `mensaje ${msg.role}`);
    });
  }
});
