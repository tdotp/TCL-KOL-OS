/**
 * QA adversarial · vector 4: fronteras de las tools.
 *
 * Ningún argumento del modelo puede fijar campaignId / organizationId / actor / origin /
 * canal / status / assignedTo; nombres de tool inexistentes, prohibidos o «casi iguales»
 * no ejecutan nada; argumentos gigantes no pasan. BD real (base `_test`).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePool, query } from '@tcl-kol-os/db';
import {
  type EscenarioDeChat,
  crearEscenarioDeChat,
  eliminarCampanaDePrueba,
} from '@tcl-kol-os/db/test-utils';
import { CATALOGO_V1 } from '../tools/catalog/index.ts';
import { MAX_ARGS_BYTES, validarArgumentos } from '../tools/schema.ts';
import { abrirTurno, clave, contar, json, llamar, registro } from './testing/harness.ts';

let e: EscenarioDeChat;
const r = registro();

beforeAll(async () => {
  e = await crearEscenarioDeChat('QA fronteras');
});
afterAll(async () => {
  await eliminarCampanaDePrueba(e.campanas);
  await closePool();
});

/** Claves de identidad/ámbito/canal que el modelo NUNCA aporta, con variantes de escritura. */
const CLAVES_HOSTILES = [
  'campaignId',
  'campaign_id',
  'CAMPAIGNID',
  'CampaignId',
  'organizationId',
  'organization_id',
  'orgId',
  'actor',
  'userId',
  'user_id',
  'user',
  'origin',
  'origen',
  'canal',
  'channel',
  'status',
  'assignedTo',
  'assigned_to',
  'role',
  'visibility',
  'confidentialityLevel',
  'proposedBy',
  'confirmedBy',
  'correlation',
  'conversationId',
  'agentRunId',
  'toolInvocationId',
  'messageId',
] as const;

describe('V4 · una clave de identidad/ámbito en los argumentos se rechaza en TODA tool', () => {
  it('ninguna tool del catálogo (25) acepta ninguna de las claves hostiles, ni en la raíz ni anidada', () => {
    let casos = 0;
    for (const t of CATALOGO_V1) {
      for (const k of CLAVES_HOSTILES) {
        const base = { [k]: '00000000-0000-4000-8000-000000000001' };
        const v = validarArgumentos(t.inputSchema, base);
        expect(v.ok, `${t.name} aceptó ${k}`).toBe(false);
        casos += 1;
      }
    }
    expect(casos).toBe(CATALOGO_V1.length * CLAVES_HOSTILES.length);
  });

  it('claves peligrosas de prototipo (JSON.parse las crea como propiedad propia) se rechazan en raíz y anidadas', () => {
    for (const t of CATALOGO_V1) {
      const crudo = '{"__proto__":{"campaignId":"x"},"constructor":{"prototype":{"admin":true}}}';
      const v = validarArgumentos(t.inputSchema, JSON.parse(crudo));
      expect(v.ok, t.name).toBe(false);
    }
    // anidada dentro de `decision` (objeto) y dentro de `answerValue` (JSON acotado)
    const resolucion = CATALOGO_V1.find((t) => t.name === 'sheet_propose_resolution')!;
    const anidada = validarArgumentos(
      resolucion.inputSchema,
      JSON.parse(
        '{"planId":"L1","recordId":"00000000-0000-4000-8000-000000000001","evidenceQuote":"abcd","decision":{"kind":"ignore_record","__proto__":{"x":1}}}',
      ),
    );
    expect(anidada.ok).toBe(false);
    const responder = CATALOGO_V1.find((t) => t.name === 'brief_answer_question')!;
    const enAny = validarArgumentos(
      responder.inputSchema,
      JSON.parse('{"questionId":"Q1","evidenceQuote":"abcd","answerValue":{"a":{"__proto__":{"p":1}}}}'),
    );
    expect(enAny.ok).toBe(false);
  });

  it('claves con homoglifos / unicode / espacios no se cuelan: son `unknown_key` (additionalProperties:false)', () => {
    const t = CATALOGO_V1.find((x) => x.name === 'campaign_update_metadata')!;
    const hostiles = [
      'campaignІd', // I cirílica
      'сampaignId', // c cirílica
      'campaign​Id', // espacio de ancho cero
      'campaign Id',
      ' campaignId',
      'campaignId ',
      'ｃampaignId', // c de ancho completo
      'campaign\u0000Id',
      'campaign\nId',
    ];
    for (const k of hostiles) {
      const v = validarArgumentos(t.inputSchema, { evidenceQuote: 'abcd', [k]: 'x' });
      expect(v.ok, JSON.stringify(k)).toBe(false);
    }
  });

  it('la salida de la validación es una COPIA con solo claves declaradas (no hereda del original)', () => {
    const t = CATALOGO_V1.find((x) => x.name === 'campaign_update_metadata')!;
    const original = Object.create({ campaignId: 'heredada' }) as Record<string, unknown>;
    original['evidenceQuote'] = 'abcd';
    // un objeto con prototipo distinto de Object.prototype no es un objeto plano
    expect(validarArgumentos(t.inputSchema, original).ok).toBe(false);
    const limpio = validarArgumentos(t.inputSchema, { evidenceQuote: 'abcd', name: 'x' });
    expect(limpio.ok && Object.keys(limpio.value).sort()).toEqual(['evidenceQuote', 'name']);
  });

  it('tipos raros en los argumentos: arrays, null, número, NaN, Infinity, BigInt, cíclicos, funciones', () => {
    const t = CATALOGO_V1.find((x) => x.name === 'campaign_update_metadata')!;
    for (const raro of [[], null, 42, 'texto', true, undefined] as unknown[]) {
      expect(validarArgumentos(t.inputSchema, raro).ok).toBe(false);
    }
    const ciclo: Record<string, unknown> = { evidenceQuote: 'abcd' };
    ciclo['self'] = ciclo;
    expect(validarArgumentos(t.inputSchema, ciclo).ok).toBe(false);
    expect(validarArgumentos(t.inputSchema, { evidenceQuote: 'abcd', name: Number.NaN }).ok).toBe(false);
    expect(validarArgumentos(t.inputSchema, { evidenceQuote: 'abcd', name: 10n }).ok).toBe(false);
    const responder = CATALOGO_V1.find((x) => x.name === 'brief_answer_question')!;
    for (const raro of [Number.NaN, Number.POSITIVE_INFINITY, () => 1, Symbol('x')]) {
      expect(
        validarArgumentos(responder.inputSchema, {
          questionId: 'Q1',
          evidenceQuote: 'abcd',
          answerValue: raro,
        }).ok,
      ).toBe(false);
    }
  });

  it('argumentos gigantes: > 16 KB, texto largo, 51 claves, profundidad 7+ y NUL se rechazan antes de tocar nada', () => {
    const responder = CATALOGO_V1.find((x) => x.name === 'brief_answer_question')!;
    const base = { questionId: 'Q1', evidenceQuote: 'abcd' };
    expect(
      validarArgumentos(responder.inputSchema, { ...base, answerValue: 'x'.repeat(MAX_ARGS_BYTES) }).ok,
    ).toBe(false);
    expect(validarArgumentos(responder.inputSchema, { ...base, answerValue: 'x'.repeat(2_100) }).ok).toBe(
      false,
    );
    const ancho = Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`k${i}`, i]));
    expect(validarArgumentos(responder.inputSchema, { ...base, answerValue: ancho }).ok).toBe(false);
    let hondo: unknown = 'x';
    for (let i = 0; i < 12; i++) hondo = { a: hondo };
    expect(validarArgumentos(responder.inputSchema, { ...base, answerValue: hondo }).ok).toBe(false);
    expect(validarArgumentos(responder.inputSchema, { ...base, answerValue: 'a\u0000b' }).ok).toBe(false);
    expect(validarArgumentos(responder.inputSchema, { ...base, answerText: 'x'.repeat(1_001) }).ok).toBe(
      false,
    );
  });

  it('un patrón de regexp en un campo no se puede usar para ReDoS (los esquemas del catálogo no declaran patrones)', () => {
    const conPatron = CATALOGO_V1.filter((t) => JSON.stringify(t.inputSchema).includes('"pattern"'));
    expect(conPatron.map((t) => t.name)).toEqual([]);
  });
});

describe('V4 · el registro frente a nombres de tool hostiles (BD real)', () => {
  const NOMBRES = [
    'aprobar_brief',
    'approve_brief',
    'brief_approve',
    'confirmarAccion',
    'ejecutarAccion',
    'CAMPAIGN_GET',
    'Campaign_Get',
    'campaign_get ',
    ' campaign_get',
    'campaign​_get',
    'сampaign_get', // c cirílica
    'campaign-get',
    'campaign_get;DROP TABLE users',
    '__proto__',
    'constructor',
    'toString',
    'hasOwnProperty',
    '',
    'x'.repeat(5_000),
  ];

  it('toda tool inexistente, prohibida o con otra grafía responde AGENT_INVALID_TOOL_CALL, deja traza `unregistered` y no ejecuta nada', async () => {
    const t = await abrirTurno(e.consultor, e.campanaId, 'hola');
    const efectosAntes = await contar('audit_events WHERE organization_id = $1', [e.admin.organizationId]);
    for (const nombre of NOMBRES) {
      const x = await llamar(r, t, nombre, {});
      expect(x.status, JSON.stringify(nombre.slice(0, 40))).toBe('failed');
      expect(x.errorCode).toBe('AGENT_INVALID_TOOL_CALL');
      expect(x.riskClass).toBe('unregistered');
    }
    const trazas = await query<{ risk_class: string; tool_name: string }>(
      `SELECT risk_class, tool_name FROM agent_tool_invocations WHERE agent_run_id = $1`,
      [t.runId],
    );
    expect(trazas).toHaveLength(NOMBRES.length);
    expect(trazas.every((f) => f.risk_class === 'unregistered')).toBe(true);
    expect(trazas.every((f) => f.tool_name.length <= 100)).toBe(true);
    // ni una sola auditoría de dominio: nada se ejecutó
    expect(await contar('audit_events WHERE organization_id = $1', [e.admin.organizationId])).toBe(
      efectosAntes,
    );
  });

  it('el nombre de la tool sale del catálogo: un `name` no-string tampoco ejecuta (nombre tratado como vacío)', async () => {
    const t = await abrirTurno(e.consultor, e.campanaId, 'hola');
    for (const name of [null, 7, {}, [], true] as unknown[]) {
      t.step += 1;
      const x = await r.execute({
        context: {
          actor: t.actor,
          campaignId: t.campaignId,
          conversationId: t.conversationId,
          messageId: t.messageId,
          agentRunId: t.runId,
          stepIndex: t.step,
          referencias: t.referencias,
          textosDelActor: t.textos,
        },
        call: { id: clave(), name: name as string, arguments: {} },
      });
      expect(x.errorCode).toBe('AGENT_INVALID_TOOL_CALL');
    }
  });

  it('una tool de ESCRITURA recibe `campaignId` de otra campaña/org en los argumentos: VALIDATION_FAILED y nada cambia', async () => {
    const t = await abrirTurno(e.consultor, e.campanaId, 'cambia el nombre a "Hackeada"');
    for (const objetivo of [e.otraCampanaId, e.campanaAjenaId]) {
      const x = await llamar(r, t, 'campaign_update_metadata', {
        campaignId: objetivo,
        name: 'Hackeada',
        evidenceQuote: 'cambia el nombre a',
      });
      expect(x.errorCode).toBe('VALIDATION_FAILED');
      expect(json(x)['error']).toMatchObject({ details: { reason: 'forbidden_argument' } });
    }
    for (const id of [e.otraCampanaId, e.campanaAjenaId, e.campanaId]) {
      const [c] = await query<{ name: string }>(`SELECT name FROM campaigns WHERE id = $1`, [id]);
      expect(c!.name).not.toBe('Hackeada');
    }
  });

  it('`assignedTo`, `status`, `origin`, `canal` en una tool de propuesta no llegan a proponerAccion', async () => {
    const t = await abrirTurno(e.consultor, e.campanaId, 'propón la aprobación del brief');
    for (const k of ['assignedTo', 'status', 'origin', 'canal', 'proposedBy']) {
      const x = await llamar(r, t, 'brief_propose_approval', {
        evidenceQuote: 'propón la aprobación',
        [k]: e.admin.id,
      });
      expect(x.errorCode, k).toBe('VALIDATION_FAILED');
    }
    expect(await contar('proposed_actions WHERE campaign_id = $1', [e.campanaId])).toBe(0);
  });

  it('un id de recurso con forma de inyección SQL / UUID inválido / alias raro es RESOURCE_NOT_FOUND, nunca una excepción', async () => {
    const t = await abrirTurno(e.consultor, e.campanaId, 'hola');
    for (const id of [
      "'; DROP TABLE users;--",
      'S999',
      's1',
      'ZZ1',
      '../../etc/passwd',
      'S1 OR 1=1',
      '0'.repeat(36),
    ]) {
      const x = await llamar(r, t, 'source_get', { sourceId: id });
      expect(['RESOURCE_NOT_FOUND', 'VALIDATION_FAILED']).toContain(x.errorCode);
      expect(x.errorCode).not.toBe('AGENT_TOOL_FAILED');
    }
    const q = await query<{ n: string }>(`SELECT count(*)::text AS n FROM users`);
    expect(Number(q[0]!.n)).toBeGreaterThan(0);
  });
});
